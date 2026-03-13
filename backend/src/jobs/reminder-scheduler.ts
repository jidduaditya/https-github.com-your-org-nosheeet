/**
 * reminder-scheduler.ts — Two workers:
 *
 * 1. evaluator: runs every 5 min, calls reminder-engine to create due reminders.
 * 2. sender: consumes 'reminders' queue, sends WhatsApp messages.
 *
 * After the evaluator creates a reminder row, the sender job is queued
 * immediately (delay = 0 since the row is already "due").
 */

import { Worker } from 'bullmq';
import { connection, reminderQueue } from './queue';
import { db } from '../db/client';
import { evaluateAllDeals } from '../services/reminder-engine';
import { generateMeetingBrief } from '../services/ai';
import { sendAndLog } from '../lib/whatsapp-client';

/** Kick off the periodic evaluator (repeating job, registered externally) */
export async function scheduleReminderEvaluator(): Promise<void> {
  await reminderQueue.add(
    'evaluate',
    {},
    { repeat: { every: 5 * 60 * 1000 }, jobId: 'reminder-evaluator' }
  );
}

export function startReminderWorker(): Worker {
  return new Worker(
    'reminders',
    async (job) => {
      // ── Evaluation job ───────────────────────────────────────────
      if (job.name === 'evaluate') {
        await evaluateAllDeals();

        // Queue a send job for each scheduled-but-unsent reminder
        const due = await db.query<{
          id: string;
          user_id: string;
          deal_id: string;
          contact_id: string;
          trigger_type: string;
          message_body: string | null;
        }>(
          `SELECT id, user_id, deal_id, contact_id, trigger_type, message_body
           FROM reminders WHERE status = 'scheduled' AND sent_at IS NULL`
        );

        for (const r of due.rows) {
          await reminderQueue.add('send', r, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } });
        }
        return;
      }

      // ── Send job ─────────────────────────────────────────────────
      if (job.name === 'send') {
        const { id: reminderId, user_id, deal_id, contact_id, trigger_type, message_body } = job.data as {
          id: string; user_id: string; deal_id: string; contact_id: string;
          trigger_type: string; message_body: string | null;
        };

        // Get founder's WhatsApp number
        const userRes = await db.query<{ phone: string | null }>(
          'SELECT phone FROM users WHERE id = $1', [user_id]
        );
        const founderPhone = userRes.rows[0]?.phone;
        if (!founderPhone) {
          console.warn(`[Reminder] User ${user_id} has no WhatsApp phone — skipping send`);
          await db.query(`UPDATE reminders SET status = 'sent', sent_at = NOW() WHERE id = $1`, [reminderId]);
          return;
        }

        let body = message_body ?? '(reminder)';

        // For meeting briefs, generate a full AI brief
        if (trigger_type === 'demo_upcoming') {
          body = await buildMeetingBriefMessage(deal_id, contact_id, body);
        }

        const result = await sendAndLog({
          userId: user_id,
          reminderId,
          dealId: deal_id,
          notificationType: 'reminder',
          recipientPhone: founderPhone,
          messageBody: body,
        });

        const newStatus = result.status === 'sent' ? 'sent' : 'sent'; // failed sends still mark sent (logged)
        await db.query(
          `UPDATE reminders SET status = $1, sent_at = NOW() WHERE id = $2`,
          [newStatus, reminderId]
        );

        await db.query(
          `INSERT INTO deal_events (deal_id, type, data) VALUES ($1, 'reminder_sent', $2)`,
          [deal_id, JSON.stringify({ reminderId, trigger_type })]
        );
        return;
      }

      // ── Meeting brief (scheduled by calendar.ts) ─────────────────
      if (job.name === 'meeting-brief') {
        const { userId, dealId, contactId, label } = job.data as {
          userId: string; dealId: string; contactId: string; label: string;
        };

        const userRes = await db.query<{ phone: string | null }>('SELECT phone FROM users WHERE id = $1', [userId]);
        const founderPhone = userRes.rows[0]?.phone;
        if (!founderPhone) return;

        const briefBody = await buildMeetingBriefMessage(dealId, contactId, label);

        await sendAndLog({
          userId,
          dealId,
          notificationType: 'brief',
          recipientPhone: founderPhone,
          messageBody: briefBody,
        });
      }
    },
    { connection, concurrency: 5 }
  );
}

async function buildMeetingBriefMessage(dealId: string, contactId: string, fallback: string): Promise<string> {
  try {
    const [dealRes, msgRes] = await Promise.all([
      db.query<{ title: string; stage: string; summary: string | null; pain_points: string[] }>(
        'SELECT title, stage, summary, pain_points FROM deals WHERE id = $1', [dealId]
      ),
      db.query<{ direction: string; content: string; timestamp: Date }>(
        `SELECT direction, content, timestamp FROM channel_messages
         WHERE contact_id = $1 ORDER BY timestamp DESC LIMIT 10`,
        [contactId]
      ),
    ]);

    const deal = dealRes.rows[0];
    const contactRes = await db.query<{ name: string | null }>(
      'SELECT name FROM contacts WHERE id = $1', [contactId]
    );

    if (!deal) return fallback;

    return await generateMeetingBrief({
      contactName: contactRes.rows[0]?.name ?? 'Contact',
      dealStage: deal.stage,
      dealSummary: deal.summary ?? '',
      painPoints: deal.pain_points,
      recentMessages: msgRes.rows.reverse().map((m) => ({
        direction: m.direction,
        content: m.content,
        timestamp: m.timestamp.toISOString(),
      })),
      meetingTitle: deal.title,
      meetingStart: fallback,
    });
  } catch (err) {
    console.error('[Brief] Generation failed:', err);
    return fallback;
  }
}
