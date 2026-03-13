import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { db } from '../db/client';

const router = Router();

// GET /deals
router.get('/', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { stage, contact_id } = req.query;
  const params: unknown[] = [req.userId];
  let i = 2;
  let where = '';

  if (stage)      { where += ` AND d.stage = $${i++}`;       params.push(stage); }
  if (contact_id) { where += ` AND d.contact_id = $${i++}`;  params.push(contact_id); }

  const result = await db.query(
    `SELECT d.*,
            c.name            AS contact_name,
            c.email           AS contact_email,
            c.phone           AS contact_phone,
            c.primary_channel AS contact_channel,
            c.tags            AS contact_tags,
            c.source          AS contact_source,
            ls.next_action    AS ai_next_action
     FROM deals d
     JOIN contacts c ON c.id = d.contact_id
     LEFT JOIN LATERAL (
       SELECT next_action FROM lead_summaries
       WHERE deal_id = d.id ORDER BY generated_at DESC LIMIT 1
     ) ls ON TRUE
     WHERE d.user_id = $1 ${where}
     ORDER BY d.last_activity DESC`,
    params
  );
  res.json(result.rows);
});

// GET /deals/:id
router.get('/:id', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { id } = req.params;

  const [dealRes, eventsRes, messagesRes, summaryRes] = await Promise.all([
    db.query(
      `SELECT d.*, c.name AS contact_name, c.email AS contact_email, c.phone AS contact_phone
       FROM deals d JOIN contacts c ON c.id = d.contact_id
       WHERE d.id = $1 AND d.user_id = $2`,
      [id, req.userId]
    ),
    db.query('SELECT * FROM deal_events WHERE deal_id = $1 ORDER BY created_at DESC LIMIT 50', [id]),
    db.query(
      `SELECT cm.* FROM channel_messages cm
       JOIN deals d ON d.contact_id = cm.contact_id
       WHERE d.id = $1 ORDER BY cm.timestamp DESC LIMIT 30`,
      [id]
    ),
    db.query(
      'SELECT * FROM lead_summaries WHERE deal_id = $1 ORDER BY generated_at DESC LIMIT 1',
      [id]
    ),
  ]);

  if (!dealRes.rows[0]) { res.status(404).json({ error: 'Deal not found' }); return; }

  res.json({
    deal: dealRes.rows[0],
    latestSummary: summaryRes.rows[0] ?? null,
    events: eventsRes.rows,
    messages: messagesRes.rows,
  });
});

// GET /deals/:id/summaries — full AI summary history
router.get('/:id/summaries', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const result = await db.query(
    `SELECT ls.* FROM lead_summaries ls
     JOIN deals d ON d.id = ls.deal_id
     WHERE ls.deal_id = $1 AND d.user_id = $2
     ORDER BY ls.generated_at DESC`,
    [req.params.id, req.userId]
  );
  res.json(result.rows);
});

// POST /deals
router.post('/', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { contact_id, title, stage } = req.body as {
    contact_id: string; title: string; stage?: string;
  };
  if (!contact_id || !title) {
    res.status(400).json({ error: 'contact_id and title are required' });
    return;
  }
  const result = await db.query(
    `INSERT INTO deals (user_id, contact_id, title, stage)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [req.userId, contact_id, title, stage ?? 'NEW_LEAD']
  );
  res.status(201).json(result.rows[0]);
});

// PATCH /deals/:id
router.patch('/:id', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { id } = req.params;
  const { stage, summary, pain_points, stage_needs_confirm } = req.body as {
    stage?: string; summary?: string; pain_points?: string[]; stage_needs_confirm?: boolean;
  };

  const currentRes = await db.query<{ stage: string }>(
    'SELECT stage FROM deals WHERE id = $1 AND user_id = $2',
    [id, req.userId]
  );
  if (!currentRes.rows[0]) { res.status(404).json({ error: 'Deal not found' }); return; }

  const result = await db.query(
    `UPDATE deals
     SET stage               = COALESCE($1::deal_stage, stage),
         summary             = COALESCE($2, summary),
         pain_points         = COALESCE($3, pain_points),
         stage_needs_confirm = COALESCE($4, stage_needs_confirm),
         last_activity       = NOW()
     WHERE id = $5 AND user_id = $6
     RETURNING *`,
    [stage, summary, pain_points, stage_needs_confirm, id, req.userId]
  );

  if (stage && stage !== currentRes.rows[0].stage) {
    await db.query(
      `INSERT INTO deal_events (deal_id, type, data) VALUES ($1, 'stage_change', $2)`,
      [id, JSON.stringify({ from: currentRes.rows[0].stage, to: stage, confirmed_by: 'founder' })]
    );
    // Cancel reminders that are no longer relevant after stage change
    if (stage === 'CLOSED_WON' || stage === 'CLOSED_LOST' || stage === 'COLD') {
      await db.query(
        `UPDATE reminders SET status = 'cancelled' WHERE deal_id = $1 AND status = 'scheduled'`,
        [id]
      );
    }
  }

  res.json(result.rows[0]);
});

export default router;
