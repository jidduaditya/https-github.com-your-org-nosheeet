/**
 * notion.ts — One-time Notion database import.
 *
 * Flow:
 * 1. Fetch all pages from a Notion database.
 * 2. Ask Claude to map Notion property names → CRM fields.
 * 3. Import rows as contacts.
 *
 * Requires NOTION_API_KEY in env and the database ID to be passed by the caller.
 * One-time only — guarded the same way as the Sheets importer.
 */

import axios from 'axios';
import Anthropic from '@anthropic-ai/sdk';
import { db } from '../../db/client';
import { matchOrCreateContact } from '../matcher';

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const NOTION_VERSION = '2022-06-28';

interface NotionPage {
  id: string;
  properties: Record<string, unknown>;
}

interface ColumnMapping {
  name?: string;
  email?: string;
  phone?: string;
  company?: string;
}

export async function importFromNotion(
  userId: string,
  databaseId: string
): Promise<{ imported: number; skipped: number }> {
  const notionToken = process.env.NOTION_API_KEY;
  if (!notionToken) throw new Error('NOTION_API_KEY not configured');

  // Guard: one-time only
  const done = await db.query(
    `SELECT id FROM notification_log
     WHERE user_id = $1 AND notification_type = 'import_complete'
       AND message_body::jsonb->>'source' = 'notion'
     LIMIT 1`,
    [userId]
  );
  if (done.rows.length > 0) throw new Error('Notion import already completed');

  // Fetch all pages from the database
  const pages: NotionPage[] = [];
  let cursor: string | undefined;

  do {
    const res = await axios.post<{ results: NotionPage[]; next_cursor?: string; has_more: boolean }>(
      `https://api.notion.com/v1/databases/${databaseId}/query`,
      cursor ? { start_cursor: cursor } : {},
      {
        headers: {
          Authorization: `Bearer ${notionToken}`,
          'Notion-Version': NOTION_VERSION,
          'Content-Type': 'application/json',
        },
      }
    );
    pages.push(...res.data.results);
    cursor = res.data.has_more ? res.data.next_cursor : undefined;
  } while (cursor);

  if (pages.length === 0) return { imported: 0, skipped: 0 };

  // Get property names from first page
  const propertyNames = Object.keys(pages[0].properties);
  const sampleValues = Object.entries(pages[0].properties)
    .slice(0, 6)
    .reduce<Record<string, unknown>>((acc, [k, v]) => { acc[k] = v; return acc; }, {});

  const mapping = await inferNotionMapping(propertyNames, sampleValues);

  let imported = 0;
  let skipped = 0;

  for (const page of pages) {
    const extract = (propName?: string): string | undefined => {
      if (!propName) return undefined;
      const prop = page.properties[propName] as Record<string, unknown> | undefined;
      if (!prop) return undefined;
      const type = prop.type as string;
      if (type === 'title') return ((prop.title as Array<{ plain_text: string }>) ?? []).map(t => t.plain_text).join('');
      if (type === 'rich_text') return ((prop.rich_text as Array<{ plain_text: string }>) ?? []).map(t => t.plain_text).join('');
      if (type === 'email') return prop.email as string;
      if (type === 'phone_number') return prop.phone_number as string;
      return String(prop[type] ?? '');
    };

    const email = extract(mapping.email)?.toLowerCase() || undefined;
    const phone = extract(mapping.phone) || undefined;
    const name  = extract(mapping.name) || undefined;

    if (!email && !phone) { skipped++; continue; }

    await matchOrCreateContact({
      email,
      phone,
      name,
      channel: 'manual',
      userId,
      source: 'import_notion',
    });
    imported++;
  }

  await db.query(
    `INSERT INTO notification_log
       (user_id, notification_type, recipient_phone, message_body, channel, status)
     VALUES ($1, 'import_complete', 'system', $2, 'system', 'sent')`,
    [userId, JSON.stringify({ source: 'notion', imported, skipped })]
  );

  return { imported, skipped };
}

async function inferNotionMapping(
  propertyNames: string[],
  sample: Record<string, unknown>
): Promise<ColumnMapping> {
  const prompt =
    `You are mapping Notion database properties to CRM fields.\n` +
    `Property names: ${JSON.stringify(propertyNames)}\n` +
    `Sample values: ${JSON.stringify(sample)}\n\n` +
    `Return a JSON object mapping CRM field names to exact Notion property names. ` +
    `CRM fields: name, email, phone, company. ` +
    `Only include confident mappings. Return ONLY valid JSON, no markdown.`;

  const res = await claude.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 256,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = res.content[0].type === 'text' ? res.content[0].text : '{}';
  const match = text.match(/\{[\s\S]*\}/);
  return match ? (JSON.parse(match[0]) as ColumnMapping) : {};
}
