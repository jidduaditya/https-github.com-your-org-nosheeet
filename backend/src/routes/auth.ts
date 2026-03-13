import { Router, Request, Response } from 'express';
import { google } from 'googleapis';
import { db } from '../db/client';
import { issueJwt } from '../middleware/auth';
import { triggerInitialSync } from '../jobs/gmail-sync';

const router = Router();

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

// GET /auth/google — redirect to Google OAuth consent
router.get('/google', (_req: Request, res: Response) => {
  const auth = getOAuthClient();
  const url = auth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'openid',
      'email',
      'profile',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.readonly',
    ],
  });
  res.redirect(url);
});

// GET /auth/google/callback — exchange code, upsert user, issue JWT
router.get('/google/callback', async (req: Request, res: Response): Promise<void> => {
  const { code, error } = req.query;

  if (error || !code) {
    res.status(400).json({ error: 'OAuth denied or missing code' });
    return;
  }

  const auth = getOAuthClient();
  const { tokens } = await auth.getToken(code as string);
  auth.setCredentials(tokens);

  // Get user profile
  const oauth2 = google.oauth2({ version: 'v2', auth });
  const profile = await oauth2.userinfo.get();
  const { email, name, id: googleId } = profile.data;

  if (!email) {
    res.status(400).json({ error: 'No email in Google profile' });
    return;
  }

  // Upsert user
  const userRes = await db.query(
    `INSERT INTO users (email, name)
     VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [email, name ?? null]
  );
  const userId = userRes.rows[0].id as string;

  // Store OAuth tokens
  await db.query(
    `INSERT INTO oauth_tokens (user_id, provider, access_token, refresh_token, expires_at, scope)
     VALUES ($1, 'google', $2, $3, $4, $5)
     ON CONFLICT (user_id, provider) DO UPDATE
       SET access_token = EXCLUDED.access_token,
           refresh_token = COALESCE(EXCLUDED.refresh_token, oauth_tokens.refresh_token),
           expires_at = EXCLUDED.expires_at,
           updated_at = NOW()`,
    [
      userId,
      tokens.access_token,
      tokens.refresh_token ?? null,
      tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      tokens.scope ?? null,
    ]
  );

  // Kick off initial sync in background
  triggerInitialSync(userId).catch(console.error);

  const jwt = issueJwt(userId, email);

  // Redirect frontend with token
  const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:5173';
  res.redirect(`${frontendUrl}/auth/callback?token=${jwt}`);
});

// POST /auth/phone — stub (dev only, returns mock OTP)
router.post('/phone', (_req: Request, res: Response) => {
  res.json({ message: 'OTP sent (dev mode)', otp: '000000' });
});

// POST /auth/phone/verify — stub
router.post('/phone/verify', (req: Request, res: Response): void => {
  const { phone, otp } = req.body;
  if (otp !== '000000') {
    res.status(401).json({ error: 'Invalid OTP' });
    return;
  }
  // Find or create user by phone
  db.query(
    `INSERT INTO users (email, phone) VALUES ($1, $2) ON CONFLICT (phone) DO UPDATE SET phone = EXCLUDED.phone RETURNING id, email`,
    [`${phone}@phone.nosheeet`, phone]
  ).then((result) => {
    const { id, email } = result.rows[0];
    res.json({ token: issueJwt(id, email) });
  }).catch((err) => {
    res.status(500).json({ error: err.message });
  });
});

export default router;
