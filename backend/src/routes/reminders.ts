import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { db } from '../db/client';

const router = Router();

const SNOOZE_TONES = ['normal', 'elevated', 'final', 'forced_choice'] as const;

// GET /reminders
router.get('/', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { status = 'scheduled', deal_id } = req.query;
  const params: unknown[] = [req.userId, status];
  let extra = '';
  if (deal_id) { extra = ' AND r.deal_id = $3'; params.push(deal_id); }

  const result = await db.query(
    `SELECT r.*, c.name AS contact_name, d.title AS deal_title
     FROM reminders r
     JOIN contacts c ON c.id = r.contact_id
     JOIN deals d    ON d.id = r.deal_id
     WHERE r.user_id = $1 AND r.status = $2 ${extra}
     ORDER BY r.scheduled_at ASC`,
    params
  );
  res.json(result.rows);
});

// POST /reminders/:id/done — mark reminder as dismissed
router.post('/:id/done', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const result = await db.query(
    `UPDATE reminders SET status = 'dismissed', sent_at = NOW()
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [req.params.id, req.userId]
  );
  if (!result.rows[0]) { res.status(404).json({ error: 'Reminder not found' }); return; }
  res.json(result.rows[0]);
});

// POST /reminders/:id/snooze
router.post('/:id/snooze', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { duration_hours } = req.body as { duration_hours?: number };
  if (![24, 72, 168].includes(duration_hours ?? 0)) {
    res.status(400).json({ error: 'duration_hours must be 24, 72, or 168' });
    return;
  }

  const reminderRes = await db.query<{
    id: string; status: string; snooze_count: number; deal_id: string;
  }>(
    'SELECT id, status, snooze_count, deal_id FROM reminders WHERE id = $1 AND user_id = $2',
    [req.params.id, req.userId]
  );
  const reminder = reminderRes.rows[0];
  if (!reminder) { res.status(404).json({ error: 'Reminder not found' }); return; }
  if (reminder.status !== 'scheduled' && reminder.status !== 'sent') {
    res.status(400).json({ error: `Cannot snooze a reminder with status '${reminder.status}'` });
    return;
  }

  const newSnoozeCount = reminder.snooze_count + 1;

  // Snooze 4+: forced choice — no more snoozes
  if (newSnoozeCount > 3) {
    res.status(400).json({
      error: 'Maximum snoozes reached',
      code: 'FORCED_CHOICE',
      message: 'You must choose: follow_up_date / archive / mark_won / mark_lost',
    });
    return;
  }

  const escalationTone = SNOOZE_TONES[Math.min(newSnoozeCount - 1, 3)];
  const newScheduledAt = new Date(Date.now() + duration_hours! * 60 * 60 * 1000);

  await db.query(
    `UPDATE reminders SET status = 'snoozed', scheduled_at = $1, snooze_count = $2 WHERE id = $3`,
    [newScheduledAt, newSnoozeCount, reminder.id]
  );

  await db.query(
    `INSERT INTO snooze_log (reminder_id, user_id, snooze_number, duration_hours, new_scheduled_at, escalation_tone)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [reminder.id, req.userId, newSnoozeCount, duration_hours, newScheduledAt, escalationTone]
  );

  // If this is snooze 3, update the pending message body to signal "last chance"
  if (newSnoozeCount === 3) {
    await db.query(
      `UPDATE reminders SET message_body = message_body || ' (Final reminder — this has been snoozed twice before.)'
       WHERE id = $1`,
      [reminder.id]
    );
  }

  res.json({
    message: 'Snoozed',
    newScheduledAt,
    snoozeCount: newSnoozeCount,
    escalationTone,
    ...(newSnoozeCount === 3 && {
      warning: 'Next snooze will require a forced choice. No further snoozes after that.',
    }),
  });
});

// POST /reminders/:id/dismiss
router.post('/:id/dismiss', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  await db.query(
    `UPDATE reminders SET status = 'dismissed' WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.userId]
  );
  res.json({ message: 'Reminder dismissed' });
});

// POST /reminders/:id/force-choice
router.post('/:id/force-choice', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { action, date } = req.body as {
    action: 'follow_up_date' | 'archive' | 'mark_won' | 'mark_lost';
    date?: string;
  };

  const reminderRes = await db.query<{ deal_id: string }>(
    'SELECT deal_id FROM reminders WHERE id = $1 AND user_id = $2',
    [req.params.id, req.userId]
  );
  if (!reminderRes.rows[0]) { res.status(404).json({ error: 'Reminder not found' }); return; }
  const { deal_id } = reminderRes.rows[0];

  await db.query(`UPDATE reminders SET status = 'dismissed' WHERE id = $1`, [req.params.id]);

  if (action === 'follow_up_date') {
    if (!date) { res.status(400).json({ error: 'date required for follow_up_date action' }); return; }
    // Create a new manual reminder for the chosen date
    const deal = await db.query<{ contact_id: string }>(
      'SELECT contact_id FROM deals WHERE id = $1', [deal_id]
    );
    await db.query(
      `INSERT INTO reminders (user_id, deal_id, contact_id, trigger_type, sequence_number, scheduled_at, message_body)
       VALUES ($1, $2, $3, 'no_reply_from_lead', 99, $4, 'Manually scheduled follow-up')`,
      [req.userId, deal_id, deal.rows[0].contact_id, new Date(date)]
    );
    res.json({ message: 'Follow-up scheduled', date });
  } else if (action === 'archive') {
    await db.query(`UPDATE deals SET stage = 'COLD' WHERE id = $1 AND user_id = $2`, [deal_id, req.userId]);
    await db.query(`UPDATE reminders SET status = 'cancelled' WHERE deal_id = $1 AND status = 'scheduled'`, [deal_id]);
    res.json({ message: 'Deal moved to Cold and reminders cancelled' });
  } else if (action === 'mark_won') {
    await db.query(`UPDATE deals SET stage = 'CLOSED_WON' WHERE id = $1 AND user_id = $2`, [deal_id, req.userId]);
    await db.query(`UPDATE reminders SET status = 'cancelled' WHERE deal_id = $1 AND status = 'scheduled'`, [deal_id]);
    res.json({ message: 'Deal marked Closed Won' });
  } else if (action === 'mark_lost') {
    await db.query(`UPDATE deals SET stage = 'CLOSED_LOST' WHERE id = $1 AND user_id = $2`, [deal_id, req.userId]);
    await db.query(`UPDATE reminders SET status = 'cancelled' WHERE deal_id = $1 AND status = 'scheduled'`, [deal_id]);
    res.json({ message: 'Deal marked Closed Lost' });
  } else {
    res.status(400).json({ error: 'Invalid action' });
  }
});

export default router;
