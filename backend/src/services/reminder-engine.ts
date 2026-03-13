/**
 * reminder-engine.ts — Evaluates all open deals against trigger conditions
 * and inserts reminders rows as needed.
 *
 * Called by the reminder-scheduler BullMQ job every 5 minutes.
 *
 * Trigger schedule (from product brief):
 *
 * no_reply_from_lead (founder sent, contact hasn't replied):
 *   seq 1 = D+3, seq 2 = D+7, seq 3 = D+14, seq 4 = D+30 → auto-Cold
 *
 * no_reply_from_founder (contact replied, founder hasn't responded):
 *   seq 1 = +4h, seq 2 = +24h
 *
 * post_demo_no_followup:
 *   seq 1 = D+1, seq 2 = D+3
 *
 * proposal_no_activity:
 *   seq 1 = D+5, seq 2 = D+10
 *
 * deal_silent:
 *   seq 1 = D+30 → auto-move to Cold
 */

import { db } from '../db/client';

interface TriggerSchedule {
  trigger_type: string;
  sequence: Array<{ seq: number; offsetMs: number; message: (ctx: ReminderContext) => string }>;
}

interface ReminderContext {
  contactName: string;
  dealTitle: string;
  stage: string;
  seq: number;
}

const HOUR = 60 * 60 * 1000;
const DAY  = 24 * HOUR;

// Escalating snooze tone logic lives in the snooze handler.
// These message templates are the first-send versions.
const TRIGGERS: TriggerSchedule[] = [
  {
    trigger_type: 'no_reply_from_lead',
    sequence: [
      { seq: 1, offsetMs: 3 * DAY,  message: ({ contactName }) => `👋 No reply from ${contactName} yet. Worth a follow-up?` },
      { seq: 2, offsetMs: 7 * DAY,  message: ({ contactName }) => `⏳ Still no reply from ${contactName} (7 days). Try a different angle?` },
      { seq: 3, offsetMs: 14 * DAY, message: ({ contactName }) => `📭 14 days of silence from ${contactName}. Last nudge before moving to Cold?` },
      { seq: 4, offsetMs: 30 * DAY, message: ({ contactName, dealTitle }) => `🥶 ${contactName} (${dealTitle}) has been silent 30 days. Moving to Cold — reply to keep open.` },
    ],
  },
  {
    trigger_type: 'no_reply_from_founder',
    sequence: [
      { seq: 1, offsetMs: 4 * HOUR, message: ({ contactName }) => `💬 ${contactName} replied 4 hours ago — you haven't responded yet.` },
      { seq: 2, offsetMs: 24 * HOUR, message: ({ contactName }) => `⚠️ You're leaving ${contactName} hanging — they replied yesterday.` },
    ],
  },
  {
    trigger_type: 'post_demo_no_followup',
    sequence: [
      { seq: 1, offsetMs: 1 * DAY,  message: ({ contactName }) => `📋 Send a follow-up to ${contactName} after yesterday's demo?` },
      { seq: 2, offsetMs: 3 * DAY,  message: ({ contactName }) => `🚨 3 days post-demo, no follow-up sent to ${contactName}. Don't lose the momentum.` },
    ],
  },
  {
    trigger_type: 'proposal_no_activity',
    sequence: [
      { seq: 1, offsetMs: 5 * DAY,  message: ({ contactName }) => `📄 No activity on ${contactName}'s proposal for 5 days. Check in?` },
      { seq: 2, offsetMs: 10 * DAY, message: ({ contactName }) => `❄️ Deal with ${contactName} may be going cold — 10 days since proposal, no response.` },
    ],
  },
  {
    trigger_type: 'deal_silent',
    sequence: [
      { seq: 1, offsetMs: 30 * DAY, message: ({ contactName, dealTitle }) => `💤 ${dealTitle} (${contactName}) has been silent 30+ days. Archive or try one more?` },
    ],
  },
];

export async function evaluateAllDeals(): Promise<void> {
  // Skip entirely for users in vacation mode
  const vacationUsers = await db.query<{ user_id: string }>(
    `SELECT user_id FROM vacation_mode WHERE is_active = TRUE`
  );
  const vacationUserIds = new Set(vacationUsers.rows.map((r) => r.user_id));

  const dealsRes = await db.query<{
    id: string;
    user_id: string;
    contact_id: string;
    title: string;
    stage: string;
    last_founder_message_at: Date | null;
    last_contact_reply_at: Date | null;
    last_activity: Date;
    contact_name: string | null;
  }>(
    `SELECT d.id, d.user_id, d.contact_id, d.title, d.stage,
            d.last_founder_message_at, d.last_contact_reply_at, d.last_activity,
            c.name AS contact_name
     FROM deals d
     JOIN contacts c ON c.id = d.contact_id
     WHERE d.stage NOT IN ('CLOSED_WON', 'CLOSED_LOST', 'COLD')`
  );

  for (const deal of dealsRes.rows) {
    if (vacationUserIds.has(deal.user_id)) continue;
    await evaluateDeal(deal);
  }
}

async function evaluateDeal(deal: {
  id: string;
  user_id: string;
  contact_id: string;
  title: string;
  stage: string;
  last_founder_message_at: Date | null;
  last_contact_reply_at: Date | null;
  last_activity: Date;
  contact_name: string | null;
}): Promise<void> {
  const now = Date.now();
  const ctx: ReminderContext = {
    contactName: deal.contact_name ?? 'your contact',
    dealTitle: deal.title,
    stage: deal.stage,
    seq: 0,
  };

  for (const trigger of TRIGGERS) {
    const { trigger_type, sequence } = trigger;

    // Determine the reference timestamp for this trigger
    let referenceTime: Date | null = null;

    if (trigger_type === 'no_reply_from_lead') {
      // Founder sent last, contact hasn't replied since
      if (!deal.last_founder_message_at) continue;
      if (deal.last_contact_reply_at && deal.last_contact_reply_at > deal.last_founder_message_at) continue;
      referenceTime = deal.last_founder_message_at;
    } else if (trigger_type === 'no_reply_from_founder') {
      // Contact replied, founder hasn't replied since
      if (!deal.last_contact_reply_at) continue;
      if (deal.last_founder_message_at && deal.last_founder_message_at > deal.last_contact_reply_at) continue;
      referenceTime = deal.last_contact_reply_at;
    } else if (trigger_type === 'post_demo_no_followup') {
      // A meeting has passed; founder hasn't sent an outbound since
      const meetingRes = await db.query<{ end_time: Date }>(
        `SELECT end_time FROM meetings
         WHERE deal_id = $1 AND end_time < NOW()
         ORDER BY end_time DESC LIMIT 1`,
        [deal.id]
      );
      if (!meetingRes.rows[0]) continue;
      const meetingEnd = meetingRes.rows[0].end_time;
      if (deal.last_founder_message_at && deal.last_founder_message_at > meetingEnd) continue;
      referenceTime = meetingEnd;
    } else if (trigger_type === 'proposal_no_activity') {
      if (deal.stage !== 'PROPOSAL_SENT') continue;
      referenceTime = deal.last_activity;
    } else if (trigger_type === 'deal_silent') {
      referenceTime = deal.last_activity;
    }

    if (!referenceTime) continue;

    // Get the highest sequence number already scheduled or sent for this deal + trigger
    const sentRes = await db.query<{ max_seq: number | null }>(
      `SELECT MAX(sequence_number) AS max_seq
       FROM reminders
       WHERE deal_id = $1 AND trigger_type = $2
         AND status IN ('scheduled', 'sent', 'snoozed')`,
      [deal.id, trigger_type]
    );
    const maxSentSeq = sentRes.rows[0].max_seq ?? 0;

    // Find the next sequence step that is now due
    for (const step of sequence) {
      if (step.seq <= maxSentSeq) continue;
      const fireAt = new Date(referenceTime.getTime() + step.offsetMs);
      if (fireAt.getTime() > now) break; // Not due yet

      const messageBody = step.message({ ...ctx, seq: step.seq });

      await db.query(
        `INSERT INTO reminders
           (user_id, deal_id, contact_id, trigger_type, sequence_number, scheduled_at, message_body)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [deal.user_id, deal.id, deal.contact_id, trigger_type, step.seq, fireAt, messageBody]
      );

      // Auto-move to Cold on D+30 no_reply_from_lead seq 4
      if (trigger_type === 'no_reply_from_lead' && step.seq === 4) {
        await db.query(
          `UPDATE deals SET stage = 'COLD' WHERE id = $1`,
          [deal.id]
        );
      }

      break; // Only one new reminder per trigger type per evaluation cycle
    }
  }
}
