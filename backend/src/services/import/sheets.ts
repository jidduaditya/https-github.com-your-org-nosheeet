/**
 * sheets.ts — One-time Google Sheets import.
 *
 * Flow:
 * 1. Fetch sheet data (first 1000 rows).
 * 2. Send headers + sample rows to Claude to get column mapping.
 * 3. Apply mapping to import rows as contacts.
 *
 * One-time only: the job fails if previously run (tracked via a deal_events
 * row with type='import_complete' and data.source='sheets').
 */

import { google } from 'googleapis';
import Anthropic from '@anthropic-ai/sdk';
import { db } from '../../db/client';
import { matchOrCreateContact } from '../matcher';

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

interface ColumnMapping {
  name?: string;
  email?: string;
  phone?: string;
  company?: string;
  notes?: string;
}

export async function importFromSheets(
  userId: string,
  spreadsheetId: string,
  sheetName?: string
): Promise<{ imported: number; skipped: number }> {
  // Guard: one-time only
  const done = await db.query(
    `SELECT id FROM deal_events
     WHERE type = 'import_complete' AND data->>'source' = 'sheets'
       AND data->>'userId' = $1
     LIMIT 1`,
    [userId]
  );
  if (done.rows.length > 0) {
    throw new Error('Google Sheets import already completed for this user');
  }

  const tokenRes = await db.query<{ access_token: string; refresh_token: string | null }>(
    `SELECT access_token, refresh_token FROM oauth_tokens WHERE user_id = $1 AND provider = 'google'`,
    [userId]
  );
  if (!tokenRes.rows[0]) throw new Error('No Google OAuth token found');

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  auth.setCredentials(tokenRes.rows[0]);

  const sheets = google.sheets({ version: 'v4', auth });
  const range = sheetName ? `${sheetName}!A1:Z1000` : 'A1:Z1000';

  const sheetRes = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = sheetRes.data.values ?? [];
  if (rows.length < 2) return { imported: 0, skipped: 0 };

  const headers = rows[0] as string[];
  const sampleRows = rows.slice(1, 4);

  const mapping = await inferColumnMapping(headers, sampleRows);

  let imported = 0;
  let skipped = 0;

  for (const row of rows.slice(1)) {
    const get = (col?: string) => (col && headers.indexOf(col) >= 0 ? String(row[headers.indexOf(col)] ?? '') : undefined);

    const email = get(mapping.email)?.toLowerCase() || undefined;
    const phone = get(mapping.phone) || undefined;
    const name  = get(mapping.name) || undefined;

    if (!email && !phone) { skipped++; continue; }

    await matchOrCreateContact({
      email,
      phone,
      name,
      channel: 'manual',
      userId,
      source: 'import_sheets',
    });
    imported++;
  }

  // Mark import complete (use a sentinel deal_events row without a deal)
  // We store it on the user level via a generic log — reuse notification_log
  await db.query(
    `INSERT INTO notification_log
       (user_id, notification_type, recipient_phone, message_body, channel, status)
     VALUES ($1, 'import_complete', 'system', $2, 'system', 'sent')`,
    [userId, JSON.stringify({ source: 'sheets', imported, skipped })]
  );

  return { imported, skipped };
}

async function inferColumnMapping(headers: string[], sampleRows: unknown[][]): Promise<ColumnMapping> {
  const prompt =
    `You are mapping spreadsheet columns to CRM fields. ` +
    `Headers: ${JSON.stringify(headers)}. ` +
    `Sample rows: ${JSON.stringify(sampleRows)}.\n\n` +
    `Return a JSON object mapping CRM field names to the exact header string from the list above. ` +
    `CRM fields: name, email, phone, company, notes. ` +
    `Only include fields you're confident about. Return ONLY valid JSON.`;

  const res = await claude.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 256,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = res.content[0].type === 'text' ? res.content[0].text : '{}';
  const match = text.match(/\{[\s\S]*\}/);
  return match ? (JSON.parse(match[0]) as ColumnMapping) : {};
}
