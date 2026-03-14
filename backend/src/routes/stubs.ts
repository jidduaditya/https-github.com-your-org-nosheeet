/**
 * stubs.ts — Placeholder routes expected by the Lovable frontend.
 * These return success responses so the UI doesn't error out.
 * Replace with real implementations as each feature is built.
 */

import { Router, Request, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { db } from '../db/client';

const router = Router();

// ── Permissions ─────────────────────────────────────────────────────────────
// POST /permissions/update
router.post('/permissions/update', requireAuth, (_req: Request, res: Response) => {
  res.json({ message: 'Permissions updated' });
});

// ── Integrations ─────────────────────────────────────────────────────────────
// GET /integrations — list connected services (maps to oauth_tokens)
router.get('/integrations', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const result = await db.query(
    `SELECT provider, expires_at, updated_at FROM oauth_tokens WHERE user_id = $1`,
    [req.userId]
  );
  const connected = result.rows.map((r: { provider: string; expires_at: string; updated_at: string }) => ({
    provider: r.provider,
    status: 'connected',
    expires_at: r.expires_at,
    updated_at: r.updated_at,
  }));
  res.json(connected);
});

// POST /integrations/:provider/connect — trigger re-sync (mirrors /channels/connect)
router.post('/integrations/:provider/connect', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { provider } = req.params;
  if (provider === 'google') {
    const { triggerInitialSync } = require('../jobs/gmail-sync');
    triggerInitialSync(req.userId!).catch(console.error);
    res.json({ message: 'Sync triggered' });
    return;
  }
  res.json({ message: `${provider} connection noted — configure via the respective OAuth flow` });
});

// DELETE /integrations/:provider — disconnect (maps to oauth_tokens delete)
router.delete('/integrations/:provider', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  await db.query('DELETE FROM oauth_tokens WHERE user_id = $1 AND provider = $2', [req.userId, req.params.provider]);
  res.json({ message: `Disconnected ${req.params.provider}` });
});

// GET /integrations/whatsapp/qr — stub (WA Business API doesn't use QR in Cloud API)
router.get('/integrations/whatsapp/qr', (_req: Request, res: Response) => {
  res.json({ message: 'WhatsApp uses webhook-based integration. Configure via the Meta Developer portal.' });
});

// ── AI scan ───────────────────────────────────────────────────────────────────
// POST /ai/start-scan — trigger a Gmail + Calendar sync for the current user
router.post('/ai/start-scan', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { triggerInitialSync } = require('../jobs/gmail-sync');
    triggerInitialSync(req.userId!).catch(console.error);
  } catch {
    // Workers may be unavailable without Redis — not fatal
  }
  res.json({ status: 'scanning', message: 'Scan started' });
});

// GET /ai/scan-status — returns complete immediately (sync is async via BullMQ)
router.get('/ai/scan-status', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const count = await db.query(
    'SELECT COUNT(*) AS cnt FROM channel_messages WHERE user_id = $1',
    [req.userId]
  );
  const messageCount = parseInt(count.rows[0].cnt, 10);
  res.json({
    status: 'complete',
    progress: 100,
    message_count: messageCount,
  });
});

export default router;
