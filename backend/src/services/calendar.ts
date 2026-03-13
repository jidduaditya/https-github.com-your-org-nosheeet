/**
 * calendar.ts — Google Calendar sync.
 *
 * For each event with an external attendee:
 * - Match attendee email → contact (creates if missing, source='calendar')
 * - Link to open deal
 * - Schedule pre-meeting briefs (T-24h and T-1h) via the reminders table.
 *   Uses brief_24h_sent / brief_1h_sent flags for idempotency.
 */

import { google } from 'googleapis';
import { db } from '../db/client';
import { matchOrCreateContact } from './matcher';
import { reminderQueue } from '../jobs/queue';

export async function syncCalendarForUser(userId: string): Promise<void> {
  const tokenRes = await db.query<{ access_token: string; refresh_token: string | null }>(
    `SELECT access_token, refresh_token FROM oauth_tokens WHERE user_id = $1 AND provider = 'google'`,
    [userId]
  );
  if (!tokenRes.rows[0]) return;

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  auth.setCredentials(tokenRes.rows[0]);

  auth.on('tokens', async (tokens) => {
    if (tokens.access_token) {
      await db.query(
        `UPDATE oauth_tokens SET access_token = $1, updated_at = NOW() WHERE user_id = $2 AND provider = 'google'`,
        [tokens.access_token, userId]
      );
    }
  });

  const calendar = google.calendar({ version: 'v3', auth });
  const userRes = await db.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [userId]);
  const userEmail = userRes.rows[0]?.email;

  // Sync window: last 30 days + all future
  const timeMin = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  let pageToken: string | undefined;
  do {
    const eventsRes = await calendar.events.list({
      calendarId: 'primary',
      timeMin,
      maxResults: 250,
      singleEvents: true,
      orderBy: 'startTime',
      pageToken,
    });

    for (const event of eventsRes.data.items ?? []) {
      await processCalendarEvent(event, userId, userEmail);
    }

    pageToken = eventsRes.data.nextPageToken ?? undefined;
  } while (pageToken);
}

async function processCalendarEvent(
  event: { id?: string | null; summary?: string | null; start?: { dateTime?: string | null; date?: string | null } | null; end?: { dateTime?: string | null; date?: string | null } | null; attendees?: Array<{ email?: string | null; displayName?: string | null; self?: boolean | null }> | null },
  userId: string,
  userEmail: string
): Promise<void> {
  if (!event.id || !event.summary) return;

  const externalAttendees = (event.attendees ?? []).filter(
    (a) => a.email && a.email !== userEmail && !a.self
  );
  if (externalAttendees.length === 0) return;

  for (const attendee of externalAttendees) {
    if (!attendee.email) continue;

    const { contactId, created } = await matchOrCreateContact({
      email: attendee.email,
      name: attendee.displayName ?? undefined,
      channel: 'calendar',
      userId,
      source: 'calendar',
    });

    // If brand new contact, alert the founder
    if (created) {
      console.log(`[Calendar] New contact from attendee: ${attendee.email}`);
      // In production, send a WhatsApp notification here.
      // Deferred: UI surfaces new contacts with source='calendar'.
    }

    // Link to open deal
    const dealRes = await db.query<{ id: string }>(
      `SELECT id FROM deals WHERE contact_id = $1 AND stage NOT IN ('CLOSED_WON','CLOSED_LOST')
       ORDER BY created_at DESC LIMIT 1`,
      [contactId]
    );
    const dealId = dealRes.rows[0]?.id ?? null;

    const startTime = event.start?.dateTime ?? event.start?.date;
    const endTime   = event.end?.dateTime   ?? event.end?.date;
    if (!startTime || !endTime) continue;

    // Upsert meeting
    const meetingRes = await db.query<{ id: string; brief_24h_sent: boolean; brief_1h_sent: boolean }>(
      `INSERT INTO meetings (user_id, contact_id, deal_id, title, start_time, end_time, calendar_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (calendar_event_id) DO UPDATE
         SET deal_id    = EXCLUDED.deal_id,
             start_time = EXCLUDED.start_time,
             end_time   = EXCLUDED.end_time
       RETURNING id, brief_24h_sent, brief_1h_sent`,
      [userId, contactId, dealId, event.summary, startTime, endTime, event.id]
    );
    const meeting = meetingRes.rows[0];
    if (!meeting) continue;

    // Log on deal
    if (dealId) {
      await db.query(
        `INSERT INTO deal_events (deal_id, type, data) VALUES ($1, 'meeting', $2)`,
        [dealId, JSON.stringify({ eventId: event.id, title: event.summary, start: startTime })]
      );
    }

    // Schedule pre-meeting brief reminders if not already done
    const startDate = new Date(startTime);
    const now = Date.now();

    if (!meeting.brief_24h_sent) {
      const t24h = new Date(startDate.getTime() - 24 * 60 * 60 * 1000);
      if (t24h.getTime() > now && dealId) {
        await scheduleMeetingBrief(userId, dealId, contactId, meeting.id, 'T-24h', t24h);
        await db.query('UPDATE meetings SET brief_24h_sent = TRUE WHERE id = $1', [meeting.id]);
      }
    }

    if (!meeting.brief_1h_sent) {
      const t1h = new Date(startDate.getTime() - 60 * 60 * 1000);
      if (t1h.getTime() > now && dealId) {
        await scheduleMeetingBrief(userId, dealId, contactId, meeting.id, 'T-1h', t1h);
        await db.query('UPDATE meetings SET brief_1h_sent = TRUE WHERE id = $1', [meeting.id]);
      }
    }
  }
}

async function scheduleMeetingBrief(
  userId: string,
  dealId: string,
  contactId: string,
  meetingId: string,
  label: string,
  scheduledAt: Date
): Promise<void> {
  await db.query(
    `INSERT INTO reminders
       (user_id, deal_id, contact_id, trigger_type, sequence_number, scheduled_at, message_body)
     VALUES ($1, $2, $3, 'demo_upcoming', $4, $5, $6)`,
    [
      userId,
      dealId,
      contactId,
      label === 'T-24h' ? 1 : 2,
      scheduledAt,
      `[${label}] Meeting brief for deal — check dashboard for full context.`,
    ]
  );

  // Queue a BullMQ job delayed until the reminder fires
  const delayMs = scheduledAt.getTime() - Date.now();
  if (delayMs > 0) {
    await reminderQueue.add(
      'meeting-brief',
      { userId, dealId, contactId, meetingId, label },
      { delay: delayMs, attempts: 2 }
    );
  }
}
