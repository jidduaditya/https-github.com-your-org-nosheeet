import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { db } from '../db/client';

const router = Router();

// GET /dashboard/summary
// Returns everything the dashboard needs in a single round-trip.
router.get('/summary', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.userId!;

  const [stagesRes, remindersRes, contactsRes, weeklyRes] = await Promise.all([
    // Deal counts per stage
    db.query<{ stage: string; count: string }>(
      `SELECT stage, COUNT(*)::int AS count
       FROM deals WHERE user_id = $1
       GROUP BY stage`,
      [userId]
    ),
    // Overdue + due-today reminder counts
    db.query<{ overdue: string; due_today: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE scheduled_at < NOW())                          AS overdue,
         COUNT(*) FILTER (WHERE scheduled_at::date = CURRENT_DATE)            AS due_today
       FROM reminders
       WHERE user_id = $1 AND status = 'scheduled'`,
      [userId]
    ),
    // Total contacts + new this week
    db.query<{ total: string; new_this_week: string }>(
      `SELECT
         COUNT(*)                                                               AS total,
         COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')      AS new_this_week
       FROM contacts WHERE user_id = $1`,
      [userId]
    ),
    // Deals created + closed this week
    db.query<{ created_this_week: string; closed_won_this_week: string; going_cold: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')                              AS created_this_week,
         COUNT(*) FILTER (WHERE stage = 'CLOSED_WON' AND last_activity >= NOW() - INTERVAL '7 days') AS closed_won_this_week,
         COUNT(*) FILTER (WHERE stage NOT IN ('CLOSED_WON','CLOSED_LOST','COLD')
                            AND last_activity < NOW() - INTERVAL '14 days')                           AS going_cold
       FROM deals WHERE user_id = $1`,
      [userId]
    ),
  ]);

  const stageCounts = Object.fromEntries(
    stagesRes.rows.map(r => [r.stage, r.count])
  );

  res.json({
    pipeline: {
      by_stage: stageCounts,
      total_active: stagesRes.rows
        .filter(r => !['CLOSED_WON', 'CLOSED_LOST', 'COLD'].includes(r.stage))
        .reduce((sum, r) => sum + parseInt(r.count, 10), 0),
    },
    reminders: {
      overdue:   parseInt(remindersRes.rows[0]?.overdue ?? '0', 10),
      due_today: parseInt(remindersRes.rows[0]?.due_today ?? '0', 10),
    },
    contacts: {
      total:         parseInt(contactsRes.rows[0]?.total ?? '0', 10),
      new_this_week: parseInt(contactsRes.rows[0]?.new_this_week ?? '0', 10),
    },
    weekly: {
      deals_created:       parseInt(weeklyRes.rows[0]?.created_this_week ?? '0', 10),
      deals_closed_won:    parseInt(weeklyRes.rows[0]?.closed_won_this_week ?? '0', 10),
      deals_going_cold:    parseInt(weeklyRes.rows[0]?.going_cold ?? '0', 10),
    },
  });
});

export default router;
