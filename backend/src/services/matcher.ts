/**
 * matcher.ts — Contact resolution for all ingestion paths.
 *
 * Rules:
 * 1. Lookup by email OR phone (exact).
 * 2. If both match but to *different* contacts → create a merge_request.
 * 3. If no match → create contact tagged 'untagged_lead'.
 * 4. After resolving, update contact_channels summary.
 * 5. If contact now has 3+ distinct channels → recompute primary_channel
 *    to whichever has the most recent activity.
 */

import { db } from '../db/client';
import { createMergeRequest } from './merge';

export type ChannelType = 'gmail' | 'whatsapp' | 'calendar' | 'manual' | 'notion' | 'sheets';

export interface MatchInput {
  email?: string;
  phone?: string;
  name?: string;
  channel: ChannelType;
  userId: string;
  /** Source label stored on contact at creation time */
  source?: string;
}

export interface MatchResult {
  contactId: string;
  created: boolean;
}

export async function matchOrCreateContact(input: MatchInput): Promise<MatchResult> {
  const { email, phone, name, channel, userId, source } = input;

  const [emailContact, phoneContact] = await Promise.all([
    email
      ? db
          .query<{ id: string }>('SELECT id FROM contacts WHERE user_id = $1 AND email = $2', [userId, email])
          .then((r) => r.rows[0] ?? null)
      : Promise.resolve(null),
    phone
      ? db
          .query<{ id: string }>('SELECT id FROM contacts WHERE user_id = $1 AND phone = $2', [userId, phone])
          .then((r) => r.rows[0] ?? null)
      : Promise.resolve(null),
  ]);

  // Case: both match but diverge → merge request
  if (emailContact && phoneContact && emailContact.id !== phoneContact.id) {
    await createMergeRequest({
      userId,
      contactAId: emailContact.id,
      contactBId: phoneContact.id,
      reason: `Email ${email} matched contact ${emailContact.id}; phone ${phone} matched separate contact ${phoneContact.id}`,
    });
    // Use email contact as canonical until merged
    await upsertContactChannel(emailContact.id, channel);
    return { contactId: emailContact.id, created: false };
  }

  // Case: found by one or both identifiers
  const found = emailContact ?? phoneContact;
  if (found) {
    await upsertContactChannel(found.id, channel);
    return { contactId: found.id, created: false };
  }

  // Case: not found → create untagged lead
  // Use try/catch instead of ON CONFLICT DO NOTHING without explicit target,
  // which some DB environments don't support with multiple unique constraints.
  let contactId: string;
  let created = false;
  try {
    const insertRes = await db.query<{ id: string }>(
      `INSERT INTO contacts (user_id, name, email, phone, primary_channel, source, tags)
       VALUES ($1, $2, $3, $4, $5, $6, ARRAY['untagged_lead'])
       RETURNING id`,
      [userId, name ?? null, email ?? null, phone ?? null, channel, source ?? channel]
    );
    contactId = insertRes.rows[0].id;
    created = true;
  } catch {
    // Unique constraint violation — fetch the existing contact
    const retry = await db.query<{ id: string }>(
      `SELECT id FROM contacts WHERE user_id = $1 AND (email = $2 OR phone = $3) LIMIT 1`,
      [userId, email ?? null, phone ?? null]
    );
    contactId = retry.rows[0].id;
  }

  await upsertContactChannel(contactId, channel);
  return { contactId, created };
}

/**
 * Update contact_channels summary and recompute primary_channel.
 * Called after every resolved message insert.
 */
async function upsertContactChannel(contactId: string, channel: ChannelType): Promise<void> {
  // Upsert channel activity — two-statement approach avoids self-referencing
  // DO UPDATE which some in-memory Postgres implementations don't support.
  await db.query(
    `INSERT INTO contact_channels (contact_id, channel, message_count, last_activity_at)
     VALUES ($1, $2, 1, NOW())
     ON CONFLICT (contact_id, channel) DO NOTHING`,
    [contactId, channel]
  );
  await db.query(
    `UPDATE contact_channels
     SET message_count = message_count + 1, last_activity_at = NOW()
     WHERE contact_id = $1 AND channel = $2`,
    [contactId, channel]
  );

  // Recompute primary channel:
  // Rule: if 3+ distinct channels, use the one with most recent activity.
  // If < 3 channels, keep whichever was set at creation (no change).
  const channelCount = await db.query<{ cnt: string }>(
    'SELECT COUNT(*) as cnt FROM contact_channels WHERE contact_id = $1',
    [contactId]
  );

  if (parseInt(channelCount.rows[0].cnt, 10) >= 3) {
    await db.query(
      `UPDATE contacts
       SET primary_channel = (
         SELECT channel FROM contact_channels
         WHERE contact_id = $1
         ORDER BY last_activity_at DESC
         LIMIT 1
       )
       WHERE id = $1`,
      [contactId]
    );
  }
}
