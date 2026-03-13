/**
 * ai-summarise.ts — BullMQ worker: generate lead summary via Claude.
 *
 * Writes to:
 * - lead_summaries (new row — full history preserved)
 * - deals (denormalized fields for fast reads)
 *
 * AI suggests, founder confirms: stage goes to ai_suggested_stage and
 * stage_needs_confirm = TRUE. Stage only moves when founder clicks Confirm.
 */

import { Worker } from 'bullmq';
import { connection } from './queue';
import { db } from '../db/client';
import { summariseDeal } from '../services/ai';

export function startAiSummariseWorker(): Worker {
  return new Worker(
    'ai-summarise',
    async (job) => {
      const { dealId } = job.data as { dealId: string };
      console.log(`[AI] Summarising deal ${dealId}`);

      const dealRes = await db.query<{
        contact_id: string;
        user_id: string;
        title: string;
      }>('SELECT contact_id, user_id, title FROM deals WHERE id = $1', [dealId]);
      if (!dealRes.rows[0]) return;

      const { contact_id, user_id, title } = dealRes.rows[0];

      // Fetch last 30 messages for this deal's contact
      const msgRes = await db.query<{
        direction: string;
        content: string;
        timestamp: Date;
        channel: string;
      }>(
        `SELECT direction, content, timestamp, channel
         FROM channel_messages
         WHERE contact_id = $1
         ORDER BY timestamp DESC
         LIMIT 30`,
        [contact_id]
      );

      const messages = msgRes.rows
        .reverse()
        .map((r) => ({
          direction: r.direction,
          content: r.content,
          timestamp: r.timestamp.toISOString(),
          channel: r.channel,
        }));

      if (messages.length === 0) return;

      const result = await summariseDeal(messages);

      // Snapshot contact info at generation time
      const contactRes = await db.query<{
        name: string | null;
        email: string | null;
        phone: string | null;
        primary_channel: string;
      }>('SELECT name, email, phone, primary_channel FROM contacts WHERE id = $1', [contact_id]);
      const contact = contactRes.rows[0];

      // Write to lead_summaries (append)
      await db.query(
        `INSERT INTO lead_summaries
           (user_id, deal_id, contact_id, contact_name, contact_email, contact_phone,
            source_channel, summary, stage_assessment, buy_signal, pain_points, next_action)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          user_id,
          dealId,
          contact_id,
          contact?.name ?? null,
          contact?.email ?? null,
          contact?.phone ?? null,
          contact?.primary_channel ?? null,
          result.summary,
          result.suggested_stage,
          result.buy_signal,
          result.pain_points,
          result.next_action,
        ]
      );

      // Update denormalized fields on deals (AI suggests, founder confirms)
      await db.query(
        `UPDATE deals
         SET summary = $1,
             pain_points = $2,
             ai_buy_signal = $3,
             ai_suggested_stage = $4::deal_stage,
             stage_needs_confirm = TRUE,
             last_activity = NOW()
         WHERE id = $5`,
        [result.summary, result.pain_points, result.buy_signal, result.suggested_stage, dealId]
      );

      // Audit event
      await db.query(
        `INSERT INTO deal_events (deal_id, type, data) VALUES ($1, 'ai_update', $2)`,
        [dealId, JSON.stringify({ suggestedStage: result.suggested_stage, buySignal: result.buy_signal })]
      );

      console.log(`[AI] Done: deal="${title}" stage=${result.suggested_stage} signal=${result.buy_signal}`);
    },
    { connection, concurrency: 3 }
  );
}
