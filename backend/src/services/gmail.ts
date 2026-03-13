/**
 * gmail.ts — Gmail ingestion worker.
 *
 * On each message processed:
 * - Tracks direction (inbound vs outbound) to maintain last_founder_message_at
 *   and last_contact_reply_at on the deal — required by the reminder engine.
 * - Uses ON CONFLICT (channel, external_id) DO NOTHING for idempotency.
 */

import { google } from 'googleapis';
import { db } from '../db/client';
import { matchOrCreateContact } from './matcher';
import { processNewMessage } from './deal-factory';

function buildOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

export async function syncGmailForUser(userId: string): Promise<void> {
  const tokenRes = await db.query<{ access_token: string; refresh_token: string | null }>(
    `SELECT access_token, refresh_token FROM oauth_tokens WHERE user_id = $1 AND provider = 'google'`,
    [userId]
  );
  if (!tokenRes.rows[0]) return;

  const { access_token, refresh_token } = tokenRes.rows[0];
  const auth = buildOAuthClient();
  auth.setCredentials({ access_token, refresh_token });

  auth.on('tokens', async (tokens) => {
    await db.query(
      `UPDATE oauth_tokens SET access_token = $1, expires_at = $2, updated_at = NOW()
       WHERE user_id = $3 AND provider = 'google'`,
      [tokens.access_token, tokens.expiry_date ? new Date(tokens.expiry_date) : null, userId]
    );
  });

  const gmail = google.gmail({ version: 'v1', auth });
  const userRes = await db.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [userId]);
  const userEmail = userRes.rows[0]?.email;

  // Pull last 90 days
  const after = Math.floor((Date.now() - 90 * 24 * 60 * 60 * 1000) / 1000);

  let pageToken: string | undefined;
  do {
    const listRes = await gmail.users.threads.list({
      userId: 'me',
      q: `after:${after}`,
      maxResults: 100,
      pageToken,
    });

    const threads = listRes.data.threads ?? [];
    for (const thread of threads) {
      if (thread.id) {
        await processGmailThread(userId, userEmail, thread.id, gmail);
      }
    }

    pageToken = listRes.data.nextPageToken ?? undefined;
  } while (pageToken);
}

async function processGmailThread(
  userId: string,
  userEmail: string,
  threadId: string,
  gmail: ReturnType<typeof google.gmail>
): Promise<void> {
  // Idempotency: skip already-ingested threads
  const existing = await db.query(
    `SELECT id FROM channel_messages WHERE channel = 'gmail' AND external_id = $1`,
    [threadId]
  );
  if (existing.rows.length > 0) return;

  const threadRes = await gmail.users.threads.get({
    userId: 'me',
    id: threadId,
    format: 'metadata',
    metadataHeaders: ['From', 'To', 'Subject', 'Date'],
  });

  const messages = threadRes.data.messages ?? [];
  if (messages.length === 0) return;

  const firstMsg = messages[0];
  const headers = firstMsg.payload?.headers ?? [];
  const getHeader = (name: string) =>
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';

  const fromHeader = getHeader('From');
  const subject    = getHeader('Subject');
  const dateStr    = getHeader('Date');

  // Parse From: "Name <email>" or "email"
  const emailMatch = fromHeader.match(/<([^>]+)>/);
  const nameMatch  = fromHeader.match(/^([^<]+)</);
  const fromEmail  = emailMatch ? emailMatch[1].trim() : fromHeader.trim();
  const fromName   = nameMatch ? nameMatch[1].trim() : undefined;

  // Determine direction: outbound if sent from user's email
  const direction = fromEmail === userEmail ? 'outbound' : 'inbound';
  // If outbound: the contact is in the To: header
  let contactEmail = fromEmail;
  let contactName  = fromName;
  if (direction === 'outbound') {
    const toHeader = getHeader('To');
    const toMatch  = toHeader.match(/<([^>]+)>/);
    contactEmail   = toMatch ? toMatch[1].trim() : toHeader.split(',')[0].trim();
    const toName   = toHeader.match(/^([^<]+)</);
    contactName    = toName ? toName[1].trim() : undefined;
  }

  // Skip if the contact is the user themselves
  if (contactEmail === userEmail) return;

  const { contactId } = await matchOrCreateContact({
    email: contactEmail,
    name: contactName,
    channel: 'gmail',
    userId,
  });

  const insertRes = await db.query<{ id: string }>(
    `INSERT INTO channel_messages
       (user_id, contact_id, channel, external_id, direction, content, metadata, timestamp)
     VALUES ($1, $2, 'gmail', $3, $4, $5, $6, $7)
     ON CONFLICT (channel, external_id) DO NOTHING
     RETURNING id`,
    [
      userId,
      contactId,
      threadId,
      direction,
      subject || '(no subject)',
      JSON.stringify({ from: fromHeader, messageCount: messages.length }),
      dateStr ? new Date(dateStr) : new Date(),
    ]
  );

  if (insertRes.rows[0]) {
    await processNewMessage(insertRes.rows[0].id, direction);
  }
}
