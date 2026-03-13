/**
 * WhatsApp Cloud API sender.
 * All outbound messages (reminders, merge prompts, briefs, digests) go through here.
 */

import axios from 'axios';
import { db } from '../db/client';

const WA_API_BASE = 'https://graph.facebook.com/v19.0';

export interface SendResult {
  messageId: string;
  status: 'sent' | 'failed';
  error?: string;
}

export async function sendWhatsAppText(
  recipientPhone: string,
  message: string
): Promise<SendResult> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!phoneNumberId || !accessToken) {
    console.warn('[WA] Missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN — skipping send');
    return { messageId: `dev-${Date.now()}`, status: 'sent' };
  }

  try {
    const res = await axios.post(
      `${WA_API_BASE}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to: recipientPhone,
        type: 'text',
        text: { body: message },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );
    const messageId = res.data?.messages?.[0]?.id ?? `wa-${Date.now()}`;
    return { messageId, status: 'sent' };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[WA] Send failed:', msg);
    return { messageId: '', status: 'failed', error: msg };
  }
}

export async function logNotification(opts: {
  userId: string;
  reminderId?: string | null;
  dealId?: string | null;
  notificationType: string;
  recipientPhone: string;
  messageBody: string;
  externalMessageId?: string;
}): Promise<void> {
  await db.query(
    `INSERT INTO notification_log
       (user_id, reminder_id, deal_id, notification_type, recipient_phone, message_body,
        external_message_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'sent')`,
    [
      opts.userId,
      opts.reminderId ?? null,
      opts.dealId ?? null,
      opts.notificationType,
      opts.recipientPhone,
      opts.messageBody,
      opts.externalMessageId ?? null,
    ]
  );
}

export async function sendAndLog(opts: {
  userId: string;
  reminderId?: string | null;
  dealId?: string | null;
  notificationType: string;
  recipientPhone: string;
  messageBody: string;
}): Promise<SendResult> {
  const result = await sendWhatsAppText(opts.recipientPhone, opts.messageBody);
  await logNotification({
    ...opts,
    externalMessageId: result.messageId || undefined,
  });
  return result;
}
