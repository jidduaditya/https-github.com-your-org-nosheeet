/**
 * vacation.ts — Vacation mode pause / resume.
 *
 * Activate: pauses all reminder evaluation for this user (handled in
 *   reminder-engine.ts via the vacation_mode check).
 *
 * Deactivate: generates a Claude catch-up digest of what was missed,
 *   sends it via WhatsApp, stores the text in vacation_mode.catch_up_digest.
 */

import { db } from '../db/client';
import { generateVacationDigest } from './ai';
import { sendAndLog } from '../lib/whatsapp-client';

export async function activateVacationMode(userId: string): Promise<void> {
  await db.query(
    `INSERT INTO vacation_mode (user_id, is_active, activated_at, updated_at)
     VALUES ($1, TRUE, NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE
       SET is_active = TRUE, activated_at = NOW(), updated_at = NOW()`,
    [userId]
  );
}

export async function deactivateVacationMode(userId: string): Promise<string> {
  // Fetch vacation state
  const vmRes = await db.query<{ activated_at: Date | null }>(
    'SELECT activated_at FROM vacation_mode WHERE user_id = $1 AND is_active = TRUE',
    [userId]
  );
  if (!vmRes.rows[0]) throw new Error('Vacation mode is not active');
  const activatedAt = vmRes.rows[0].activated_at;

  // Collect deals that had activity during absence
  const dealsRes = await db.query<{
    id: string;
    title: string;
    stage: string;
    last_activity: Date;
    contact_name: string | null;
    summary: string | null;
  }>(
    `SELECT d.id, d.title, d.stage, d.last_activity, c.name AS contact_name, d.summary
     FROM deals d
     JOIN contacts c ON c.id = d.contact_id
     WHERE d.user_id = $1
       AND d.stage NOT IN ('CLOSED_WON', 'CLOSED_LOST')
       AND d.last_activity >= $2
     ORDER BY d.last_activity DESC`,
    [userId, activatedAt ?? new Date(0)]
  );

  // Count missed reminders per deal
  const missedMap = new Map<string, number>();
  if (dealsRes.rows.length > 0) {
    const missed = await db.query<{ deal_id: string; cnt: string }>(
      `SELECT deal_id, COUNT(*) AS cnt FROM reminders
       WHERE user_id = $1 AND status = 'scheduled' AND scheduled_at >= $2
       GROUP BY deal_id`,
      [userId, activatedAt ?? new Date(0)]
    );
    for (const r of missed.rows) missedMap.set(r.deal_id, parseInt(r.cnt, 10));
  }

  const dealInputs = dealsRes.rows.map((d) => ({
    title: d.title,
    contactName: d.contact_name ?? 'Unknown',
    stage: d.stage,
    lastActivity: d.last_activity.toISOString(),
    lastSummary: d.summary ?? '',
    missedReminders: missedMap.get(d.id) ?? 0,
  }));

  const digestItems = await generateVacationDigest(dealInputs);

  // Format digest as WhatsApp message
  const digestText = digestItems.length === 0
    ? 'Welcome back! No urgent updates while you were away.'
    : `Welcome back! Here's what happened:\n\n` +
      digestItems.map((item, i) =>
        `${i + 1}. *${item.contactName}* (${item.urgency.toUpperCase()})\n` +
        `   ${item.summary}\n` +
        `   → ${item.suggestedAction}`
      ).join('\n\n');

  // Store digest + deactivate
  await db.query(
    `UPDATE vacation_mode
     SET is_active = FALSE,
         deactivated_at = NOW(),
         catch_up_digest = $1,
         catch_up_digest_sent_at = NOW(),
         updated_at = NOW()
     WHERE user_id = $2`,
    [digestText, userId]
  );

  // Send via WhatsApp
  const userRes = await db.query<{ phone: string | null }>(
    'SELECT phone FROM users WHERE id = $1', [userId]
  );
  if (userRes.rows[0]?.phone) {
    await sendAndLog({
      userId,
      notificationType: 'catch_up_digest',
      recipientPhone: userRes.rows[0].phone,
      messageBody: digestText,
    });
  }

  return digestText;
}
