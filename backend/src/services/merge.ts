/**
 * merge.ts — Duplicate contact detection and resolution.
 *
 * Design:
 * - merge_requests uses canonical pair ordering (smaller UUID < larger UUID)
 *   enforced by a DB CHECK constraint. We normalise before insert.
 * - Declined pairs are permanently blocked: UNIQUE(user_id, a, b, status) means
 *   a new 'pending' row can be inserted if status is 'declined', but we check
 *   first and skip if any 'declined' row exists for this pair.
 * - Merge (confirm): we move all data from the secondary contact onto the
 *   primary, then delete the secondary. Timelines are unified chronologically
 *   (no data change needed — they share a user, and we just update contact_id).
 */

import { db } from '../db/client';
import { sendAndLog } from '../lib/whatsapp-client';

export interface MergeRequestInput {
  userId: string;
  contactAId: string;
  contactBId: string;
  reason: string;
}

export async function createMergeRequest(input: MergeRequestInput): Promise<void> {
  const { userId, contactAId, contactBId, reason } = input;

  // Canonical ordering
  const [aId, bId] = contactAId < contactBId
    ? [contactAId, contactBId]
    : [contactBId, contactAId];

  // Never re-prompt if this pair was already declined
  const declined = await db.query(
    `SELECT id FROM merge_requests
     WHERE user_id = $1 AND contact_a_id = $2 AND contact_b_id = $3 AND status = 'declined'`,
    [userId, aId, bId]
  );
  if (declined.rows.length > 0) return;

  // Avoid duplicate pending requests
  const existing = await db.query(
    `SELECT id FROM merge_requests
     WHERE user_id = $1 AND contact_a_id = $2 AND contact_b_id = $3 AND status = 'pending'`,
    [userId, aId, bId]
  );
  if (existing.rows.length > 0) return;

  // Create request
  const insertRes = await db.query<{ id: string }>(
    `INSERT INTO merge_requests (user_id, contact_a_id, contact_b_id, match_reason)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [userId, aId, bId, reason]
  );
  const requestId = insertRes.rows[0].id;

  // Notify founder via WhatsApp if they have a phone on record
  const userRes = await db.query<{ phone: string | null; name: string | null }>(
    'SELECT phone, name FROM users WHERE id = $1',
    [userId]
  );
  const user = userRes.rows[0];

  const [contactA, contactB] = await Promise.all([
    db.query<{ name: string | null; email: string | null; phone: string | null }>(
      'SELECT name, email, phone FROM contacts WHERE id = $1', [aId]
    ).then(r => r.rows[0]),
    db.query<{ name: string | null; email: string | null; phone: string | null }>(
      'SELECT name, email, phone FROM contacts WHERE id = $1', [bId]
    ).then(r => r.rows[0]),
  ]);

  if (user?.phone) {
    const aLabel = contactA?.name ?? contactA?.email ?? aId;
    const bLabel = contactB?.name ?? contactB?.phone ?? bId;
    const message =
      `NoSheeet: Possible duplicate contacts detected.\n\n` +
      `• ${aLabel} (email: ${contactA?.email ?? '–'})\n` +
      `• ${bLabel} (phone: ${contactB?.phone ?? '–'})\n\n` +
      `Confirm merge at: ${process.env.FRONTEND_URL}/merges/${requestId}\n` +
      `Or reply DECLINE to keep them separate.`;

    await sendAndLog({
      userId,
      reminderId: null,
      dealId: null,
      notificationType: 'merge_prompt',
      recipientPhone: user.phone,
      messageBody: message,
    });

    await db.query(
      'UPDATE merge_requests SET notified_at = NOW() WHERE id = $1',
      [requestId]
    );
  }
}

export async function confirmMerge(
  mergeRequestId: string,
  userId: string,
  primaryContactId: string
): Promise<{ survivingId: string }> {
  const reqRes = await db.query<{
    contact_a_id: string;
    contact_b_id: string;
    status: string;
  }>(
    'SELECT contact_a_id, contact_b_id, status FROM merge_requests WHERE id = $1 AND user_id = $2',
    [mergeRequestId, userId]
  );
  const req = reqRes.rows[0];
  if (!req) throw new Error('Merge request not found');
  if (req.status !== 'pending') throw new Error(`Merge request is already ${req.status}`);

  const secondaryContactId =
    req.contact_a_id === primaryContactId ? req.contact_b_id : req.contact_a_id;

  // Re-parent all messages to primary
  await db.query(
    'UPDATE channel_messages SET contact_id = $1 WHERE contact_id = $2',
    [primaryContactId, secondaryContactId]
  );

  // Re-parent all deals
  await db.query(
    'UPDATE deals SET contact_id = $1 WHERE contact_id = $2',
    [primaryContactId, secondaryContactId]
  );

  // Re-parent meetings
  await db.query(
    'UPDATE meetings SET contact_id = $1 WHERE contact_id = $2',
    [primaryContactId, secondaryContactId]
  );

  // Merge contact_channels (sum message counts, keep latest activity)
  await db.query(
    `INSERT INTO contact_channels (contact_id, channel, message_count, last_activity_at)
     SELECT $1, channel, message_count, last_activity_at
     FROM contact_channels WHERE contact_id = $2
     ON CONFLICT (contact_id, channel) DO UPDATE
       SET message_count = contact_channels.message_count + EXCLUDED.message_count,
           last_activity_at = GREATEST(contact_channels.last_activity_at, EXCLUDED.last_activity_at)`,
    [primaryContactId, secondaryContactId]
  );

  // Carry over any non-null fields from secondary to primary if primary is missing them
  await db.query(
    `UPDATE contacts SET
       name  = COALESCE(name,  (SELECT name  FROM contacts WHERE id = $2)),
       email = COALESCE(email, (SELECT email FROM contacts WHERE id = $2)),
       phone = COALESCE(phone, (SELECT phone FROM contacts WHERE id = $2))
     WHERE id = $1`,
    [primaryContactId, secondaryContactId]
  );

  // Delete secondary (FK cascades handle lead_summaries, deal_events via deals)
  await db.query('DELETE FROM contacts WHERE id = $1', [secondaryContactId]);

  // Resolve merge request
  await db.query(
    `UPDATE merge_requests
     SET status = 'confirmed', resolved_at = NOW(), resolved_by = 'founder',
         primary_contact_id = $1
     WHERE id = $2`,
    [primaryContactId, mergeRequestId]
  );

  return { survivingId: primaryContactId };
}

export async function declineMerge(mergeRequestId: string, userId: string): Promise<void> {
  await db.query(
    `UPDATE merge_requests
     SET status = 'declined', resolved_at = NOW(), resolved_by = 'founder'
     WHERE id = $1 AND user_id = $2 AND status = 'pending'`,
    [mergeRequestId, userId]
  );
}
