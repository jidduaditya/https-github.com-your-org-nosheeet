/**
 * whatsapp.ts — WhatsApp Cloud API webhook processor.
 *
 * Handles:
 * - Inbound text messages → match contact → store → deal-factory
 * - Delivery status updates → update notification_log
 */

import { db } from '../db/client';
import { matchOrCreateContact } from './matcher';
import { processNewMessage } from './deal-factory';

// ----------------------------------------------------------------
// Types matching the Meta Cloud API v19 webhook payload
// ----------------------------------------------------------------

interface WATextMessage {
  id: string;
  from: string;
  timestamp: string;
  type: 'text';
  text: { body: string };
}

interface WAStatusUpdate {
  id: string;           // message id
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: string;
  recipient_id: string;
}

interface WAContact {
  wa_id: string;
  profile?: { name?: string };
}

interface WAChangeValue {
  messaging_product: 'whatsapp';
  messages?: Array<WATextMessage | { type: string; id: string; from: string; timestamp: string }>;
  statuses?: WAStatusUpdate[];
  contacts?: WAContact[];
}

export interface WhatsAppWebhookBody {
  object: 'whatsapp_business_account';
  entry: Array<{
    id: string;
    changes: Array<{ value: WAChangeValue; field: string }>;
  }>;
}

// In MVP: all messages go to the first user in the DB.
// Production: map WABA phone_number_id → user via a mapping table.
async function resolveUserId(): Promise<string | null> {
  const res = await db.query<{ id: string }>('SELECT id FROM users LIMIT 1');
  return res.rows[0]?.id ?? null;
}

export async function processWhatsAppWebhook(body: WhatsAppWebhookBody): Promise<void> {
  if (body.object !== 'whatsapp_business_account') return;

  for (const entry of body.entry) {
    for (const change of entry.changes) {
      if (change.field !== 'messages') continue;
      const { messages, statuses, contacts } = change.value;

      // Handle delivery status updates
      if (statuses?.length) {
        await processStatusUpdates(statuses);
      }

      if (!messages?.length) continue;

      const userId = await resolveUserId();
      if (!userId) continue;

      // Build phone → display name map
      const nameMap: Record<string, string> = {};
      for (const c of contacts ?? []) {
        nameMap[c.wa_id] = c.profile?.name ?? '';
      }

      for (const msg of messages) {
        if (msg.type !== 'text') continue;
        const textMsg = msg as WATextMessage;

        const { contactId } = await matchOrCreateContact({
          phone: textMsg.from,
          name: nameMap[textMsg.from] || undefined,
          channel: 'whatsapp',
          userId,
          source: 'whatsapp',
        });

        const insertRes = await db.query<{ id: string }>(
          `INSERT INTO channel_messages
             (user_id, contact_id, channel, external_id, direction, content, metadata, timestamp)
           VALUES ($1, $2, 'whatsapp', $3, 'inbound', $4, $5, to_timestamp($6))
           ON CONFLICT (channel, external_id) DO NOTHING
           RETURNING id`,
          [
            userId,
            contactId,
            textMsg.id,
            textMsg.text.body,
            JSON.stringify({ from: textMsg.from, type: textMsg.type }),
            parseInt(textMsg.timestamp, 10),
          ]
        );

        if (insertRes.rows[0]) {
          await processNewMessage(insertRes.rows[0].id, 'inbound');
        }
      }
    }
  }
}

async function processStatusUpdates(statuses: WAStatusUpdate[]): Promise<void> {
  for (const s of statuses) {
    const now = new Date();
    if (s.status === 'delivered') {
      await db.query(
        `UPDATE notification_log SET status = 'delivered', delivered_at = $1
         WHERE external_message_id = $2`,
        [now, s.id]
      );
    } else if (s.status === 'read') {
      await db.query(
        `UPDATE notification_log SET status = 'read', read_at = $1
         WHERE external_message_id = $2`,
        [now, s.id]
      );
    } else if (s.status === 'failed') {
      await db.query(
        `UPDATE notification_log SET status = 'failed' WHERE external_message_id = $1`,
        [s.id]
      );
    }
  }
}
