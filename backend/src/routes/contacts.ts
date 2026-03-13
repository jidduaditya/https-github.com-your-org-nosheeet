import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { db } from '../db/client';

const router = Router();

// GET /contacts
router.get('/', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { search, tag, source } = req.query;

  let query = `
    SELECT c.*,
           COUNT(DISTINCT cm.id)::int  AS message_count,
           COUNT(DISTINCT d.id)::int   AS deal_count,
           MAX(cm.timestamp)           AS last_message_at,
           json_agg(DISTINCT jsonb_build_object('channel', cc.channel, 'message_count', cc.message_count,
             'last_activity_at', cc.last_activity_at)) FILTER (WHERE cc.id IS NOT NULL) AS channels
    FROM contacts c
    LEFT JOIN channel_messages cm ON cm.contact_id = c.id
    LEFT JOIN deals d             ON d.contact_id = c.id
    LEFT JOIN contact_channels cc ON cc.contact_id = c.id
    WHERE c.user_id = $1
  `;
  const params: unknown[] = [req.userId];
  let i = 2;

  if (search) { query += ` AND (c.name ILIKE $${i} OR c.email ILIKE $${i} OR c.phone ILIKE $${i})`; params.push(`%${search}%`); i++; }
  if (tag)    { query += ` AND $${i} = ANY(c.tags)`;  params.push(tag); i++; }
  if (source) { query += ` AND c.source = $${i}`;     params.push(source); i++; }

  query += ' GROUP BY c.id ORDER BY last_message_at DESC NULLS LAST';

  const result = await db.query(query, params);
  res.json(result.rows);
});

// POST /contacts
router.post('/', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { name, email, phone, tags } = req.body as {
    name?: string; email?: string; phone?: string; tags?: string[];
  };
  if (!email && !phone) {
    res.status(400).json({ error: 'At least one of email or phone is required' });
    return;
  }
  const result = await db.query(
    `INSERT INTO contacts (user_id, name, email, phone, primary_channel, source, tags)
     VALUES ($1, $2, $3, $4, 'manual', 'manual', $5)
     RETURNING *`,
    [req.userId, name ?? null, email ?? null, phone ?? null, tags ?? []]
  );
  res.status(201).json(result.rows[0]);
});

// GET /contacts/:id
router.get('/:id', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { id } = req.params;

  const [contactRes, messagesRes, dealsRes, meetingsRes, channelsRes] = await Promise.all([
    db.query('SELECT * FROM contacts WHERE id = $1 AND user_id = $2', [id, req.userId]),
    db.query(`SELECT * FROM channel_messages WHERE contact_id = $1 ORDER BY timestamp DESC LIMIT 50`, [id]),
    db.query('SELECT * FROM deals WHERE contact_id = $1 ORDER BY created_at DESC', [id]),
    db.query('SELECT * FROM meetings WHERE contact_id = $1 ORDER BY start_time DESC', [id]),
    db.query('SELECT * FROM contact_channels WHERE contact_id = $1 ORDER BY last_activity_at DESC', [id]),
  ]);

  if (!contactRes.rows[0]) { res.status(404).json({ error: 'Contact not found' }); return; }

  res.json({
    contact: contactRes.rows[0],
    messages: messagesRes.rows,
    deals: dealsRes.rows,
    meetings: meetingsRes.rows,
    channels: channelsRes.rows,
  });
});

// GET /contacts/:id/timeline
router.get('/:id/timeline', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { before, limit = '50' } = req.query;
  const params: unknown[] = [req.params.id, parseInt(limit as string, 10)];
  let whereClause = '';
  if (before) { whereClause = ` AND cm.timestamp < $3`; params.push(before); }

  const result = await db.query(
    `SELECT cm.*, c.name AS contact_name
     FROM channel_messages cm
     JOIN contacts c ON c.id = cm.contact_id
     WHERE cm.contact_id = $1 ${whereClause}
     ORDER BY cm.timestamp DESC
     LIMIT $2`,
    params
  );
  res.json(result.rows);
});

// GET /contacts/:id/summary
router.get('/:id/summary', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const result = await db.query(
    `SELECT ls.* FROM lead_summaries ls
     JOIN deals d ON d.id = ls.deal_id
     WHERE ls.contact_id = $1 AND d.user_id = $2
     ORDER BY ls.generated_at DESC LIMIT 1`,
    [req.params.id, req.userId]
  );
  if (!result.rows[0]) { res.status(404).json({ error: 'No summary yet' }); return; }
  res.json(result.rows[0]);
});

// PATCH /contacts/:id
router.patch('/:id', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { name, email, phone, tags, primary_channel } = req.body as {
    name?: string; email?: string; phone?: string; tags?: string[]; primary_channel?: string;
  };
  const result = await db.query(
    `UPDATE contacts
     SET name            = COALESCE($1, name),
         email           = COALESCE($2, email),
         phone           = COALESCE($3, phone),
         tags            = COALESCE($4, tags),
         primary_channel = COALESCE($5::channel_type, primary_channel)
     WHERE id = $6 AND user_id = $7
     RETURNING *`,
    [name, email, phone, tags, primary_channel, req.params.id, req.userId]
  );
  if (!result.rows[0]) { res.status(404).json({ error: 'Contact not found' }); return; }
  res.json(result.rows[0]);
});

// DELETE /contacts/:id (soft delete via tag)
router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  await db.query(
    `UPDATE contacts SET tags = array_append(array_remove(tags, 'archived'), 'archived')
     WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.userId]
  );
  res.json({ message: 'Contact archived' });
});

export default router;
