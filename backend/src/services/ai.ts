/**
 * ai.ts — Claude API calls.
 *
 * summariseDeal: generates lead summary, pain points, stage suggestion,
 *   buy signal, and recommended next action.
 *
 * generateVacationDigest: produces a prioritised catch-up list for the
 *   founder returning from vacation mode.
 *
 * generateMeetingBrief: produces a pre-meeting context card.
 */

import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-20250514';

// ----------------------------------------------------------------
// Deal summarisation
// ----------------------------------------------------------------

export interface LeadSummaryResult {
  summary: string;           // 2–3 sentence narrative
  pain_points: string[];
  suggested_stage: string;   // deal_stage enum value
  buy_signal: number;        // 0–1 float
  next_action: string;       // recommended next step for the founder
}

export async function summariseDeal(messages: Array<{
  direction: string;
  content: string;
  timestamp: string;
  channel?: string;
}>): Promise<LeadSummaryResult> {
  const transcript = messages
    .map((m) => `[${m.timestamp}][${m.channel ?? 'unknown'}] ${m.direction === 'inbound' ? 'Contact' : 'Founder'}: ${m.content}`)
    .join('\n');

  const prompt = `You are an AI sales analyst for a founder-led B2B startup. Analyse this sales conversation.

CONVERSATION:
${transcript}

Return a JSON object with exactly these fields:
{
  "summary": "2–3 sentence narrative of where this relationship stands and what the contact needs",
  "pain_points": ["specific pain point 1", "specific pain point 2"],
  "suggested_stage": "one of: NEW_LEAD | CONTACTED | INTERESTED | PROPOSAL_SENT | NEGOTIATING | CLOSED_WON | CLOSED_LOST | COLD",
  "buy_signal": 0.0,
  "next_action": "the single most important thing the founder should do next"
}

buy_signal: 0 = no interest / ghost, 0.5 = actively engaged, 1 = ready to sign.
Return ONLY valid JSON. No markdown, no explanation.`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude did not return valid JSON for deal summary');
  return JSON.parse(jsonMatch[0]) as LeadSummaryResult;
}

// ----------------------------------------------------------------
// Vacation catch-up digest
// ----------------------------------------------------------------

export interface DigestItem {
  dealTitle: string;
  contactName: string;
  urgency: 'high' | 'medium' | 'low';
  summary: string;
  suggestedAction: string;
}

export async function generateVacationDigest(deals: Array<{
  title: string;
  contactName: string;
  stage: string;
  lastActivity: string;
  lastSummary: string;
  missedReminders: number;
}>): Promise<DigestItem[]> {
  if (deals.length === 0) return [];

  const dealList = deals
    .map((d, i) =>
      `${i + 1}. "${d.title}" (${d.contactName}), stage: ${d.stage}, ` +
      `last activity: ${d.lastActivity}, missed reminders: ${d.missedReminders}.\n` +
      `   Last summary: ${d.lastSummary || 'none'}`
    )
    .join('\n');

  const prompt = `The founder just returned from vacation. Here are their open deals that had activity during absence:

${dealList}

Return a JSON array, each item:
{
  "dealTitle": "...",
  "contactName": "...",
  "urgency": "high | medium | low",
  "summary": "one sentence on what happened / what's at stake",
  "suggestedAction": "specific next step"
}

Order by urgency (high first). Return ONLY valid JSON array.`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];
  return JSON.parse(jsonMatch[0]) as DigestItem[];
}

// ----------------------------------------------------------------
// Pre-meeting brief
// ----------------------------------------------------------------

export async function generateMeetingBrief(opts: {
  contactName: string;
  dealStage: string;
  dealSummary: string;
  painPoints: string[];
  recentMessages: Array<{ direction: string; content: string; timestamp: string }>;
  meetingTitle: string;
  meetingStart: string;
}): Promise<string> {
  const recentTranscript = opts.recentMessages
    .slice(-10)
    .map((m) => `${m.direction === 'inbound' ? opts.contactName : 'You'}: ${m.content}`)
    .join('\n');

  const prompt = `Generate a concise pre-meeting brief (max 200 words) for this sales meeting.

Meeting: ${opts.meetingTitle} with ${opts.contactName} at ${opts.meetingStart}
Stage: ${opts.dealStage}
Summary so far: ${opts.dealSummary || 'No summary yet'}
Pain points: ${opts.painPoints.join(', ') || 'None identified'}
Recent conversation:
${recentTranscript || '(no messages yet)'}

Write a WhatsApp-friendly brief: 3–4 bullet points covering context, goal for this meeting, and one thing to be ready for. No JSON, just text.`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content[0].type === 'text' ? response.content[0].text : '';
}
