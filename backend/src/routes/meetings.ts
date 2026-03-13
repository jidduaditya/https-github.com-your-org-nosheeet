import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { db } from '../db/client';

const router = Router();

// GET /meetings?contact_id=&deal_id=&upcoming=true
router.get('/', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { contact_id, deal_id, upcoming } = req.query;

  let query = `
    SELECT m.*, c.name AS contact_name, c.email AS contact_email, d.title AS deal_title
    FROM meetings m
    LEFT JOIN contacts c ON c.id = m.contact_id
    LEFT JOIN deals d ON d.id = m.deal_id
    WHERE m.user_id = $1
  `;
  const params: unknown[] = [req.userId];
  let i = 2;

  if (contact_id) { query += ` AND m.contact_id = $${i++}`; params.push(contact_id); }
  if (deal_id)    { query += ` AND m.deal_id = $${i++}`;    params.push(deal_id); }
  if (upcoming === 'true') { query += ` AND m.start_time > NOW()`; }

  query += ' ORDER BY m.start_time ASC LIMIT 50';

  const result = await db.query(query, params);
  res.json(result.rows);
});

// POST /meetings
router.post('/', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { contact_id, deal_id, title, start_time, end_time, calendar_event_id } = req.body as {
    contact_id?: string;
    deal_id?: string;
    title: string;
    start_time: string;
    end_time: string;
    calendar_event_id?: string;
  };

  if (!title || !start_time || !end_time) {
    res.status(400).json({ error: 'title, start_time, and end_time are required' });
    return;
  }

  const result = await db.query(
    `INSERT INTO meetings (user_id, contact_id, deal_id, title, start_time, end_time, calendar_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [req.userId, contact_id ?? null, deal_id ?? null, title, start_time, end_time, calendar_event_id ?? null]
  );

  res.status(201).json(result.rows[0]);
});

export default router;
