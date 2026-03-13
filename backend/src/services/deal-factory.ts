/**
 * deal-factory.ts — Triggered on every channel_messages insert.
 *
 * Responsibilities:
 * 1. Find or create an open deal for the contact.
 * 2. Update last_activity, last_founder_message_at / last_contact_reply_at.
 * 3. Queue AI summarisation every 5 messages.
 * 4. Cancel any superseded reminders when a contact replies.
 */

import { db } from '../db/client';
import { aiSummariseQueue } from '../jobs/queue';

export async function processNewMessage(
  messageId: string,
  direction: 'inbound' | 'outbound' = 'inbound'
): Promise<void> {
  const msgRes = await db.query<{
    user_id: string;
    contact_id: string;
    contact_name: string | null;
    channel: string;
  }>(
    `SELECT cm.user_id, cm.contact_id, c.name AS contact_name, cm.channel
     FROM channel_messages cm
     JOIN contacts c ON c.id = cm.contact_id
     WHERE cm.id = $1`,
    [messageId]
  );
  const msg = msgRes.rows[0];
  if (!msg) return;

  const { user_id, contact_id, contact_name, channel } = msg;

  // Find open deal
  const dealRes = await db.query<{ id: string }>(
    `SELECT id FROM deals
     WHERE user_id = $1 AND contact_id = $2
       AND stage NOT IN ('CLOSED_WON', 'CLOSED_LOST')
     ORDER BY created_at DESC LIMIT 1`,
    [user_id, contact_id]
  );

  let dealId: string;

  if (dealRes.rows.length === 0) {
    const title = `${contact_name ?? 'Unknown'} via ${channel}`;
    const newDeal = await db.query<{ id: string }>(
      `INSERT INTO deals (user_id, contact_id, title, stage, last_activity)
       VALUES ($1, $2, $3, 'NEW_LEAD', NOW())
       RETURNING id`,
      [user_id, contact_id, title]
    );
    dealId = newDeal.rows[0].id;
  } else {
    dealId = dealRes.rows[0].id;
  }

  // Update activity timestamps
  const activityUpdate =
    direction === 'outbound'
      ? `last_founder_message_at = NOW(), last_activity = NOW()`
      : `last_contact_reply_at = NOW(), last_activity = NOW()`;

  await db.query(`UPDATE deals SET ${activityUpdate} WHERE id = $1`, [dealId]);

  // If contact replied, cancel pending 'no_reply_from_lead' reminders for this deal
  if (direction === 'inbound') {
    await db.query(
      `UPDATE reminders
       SET status = 'cancelled'
       WHERE deal_id = $1 AND trigger_type = 'no_reply_from_lead' AND status = 'scheduled'`,
      [dealId]
    );
    // Cancel 'no_reply_from_founder' reminders if founder replies
  }
  if (direction === 'outbound') {
    await db.query(
      `UPDATE reminders
       SET status = 'cancelled'
       WHERE deal_id = $1 AND trigger_type = 'no_reply_from_founder' AND status = 'scheduled'`,
      [dealId]
    );
  }

  // Log deal event
  await db.query(
    `INSERT INTO deal_events (deal_id, type, data) VALUES ($1, 'message', $2)`,
    [dealId, JSON.stringify({ messageId, channel, direction })]
  );

  // Trigger AI summarisation every 5 messages
  const countRes = await db.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM deal_events WHERE deal_id = $1 AND type = 'message'`,
    [dealId]
  );
  const count = parseInt(countRes.rows[0].cnt, 10);
  if (count > 0 && count % 5 === 0) {
    await aiSummariseQueue.add(
      'summarise',
      { dealId },
      { attempts: 3, backoff: { type: 'exponential', delay: 2000 } }
    );
  }
}
