import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { db } from '../db/client';
import { triggerInitialSync } from '../jobs/gmail-sync';

const router = Router();

// GET /channels — get connected channels for user
router.get('/', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const result = await db.query(
    `SELECT provider, expires_at, created_at, updated_at FROM oauth_tokens WHERE user_id = $1`,
    [req.userId]
  );
  res.json(result.rows);
});

// POST /channels/connect — trigger re-sync for an already-connected channel
router.post('/connect', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { provider } = req.body as { provider: string };

  if (provider === 'google') {
    await triggerInitialSync(req.userId!);
    res.json({ message: 'Sync triggered for Google (Gmail + Calendar)' });
    return;
  }

  res.status(400).json({ error: 'Unknown provider. Google OAuth is handled via /auth/google.' });
});

// DELETE /channels/:provider — disconnect a channel
router.delete('/:provider', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { provider } = req.params;

  await db.query(
    'DELETE FROM oauth_tokens WHERE user_id = $1 AND provider = $2',
    [req.userId, provider]
  );

  res.json({ message: `Disconnected ${provider}` });
});

export default router;
