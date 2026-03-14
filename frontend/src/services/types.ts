// ── Contacts ─────────────────────────────────────────────────────────────────

export interface Contact {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  primary_channel: string;
  source: string;
  tags: string[];
  message_count: number;
  deal_count: number;
  last_message_at: string | null;
  created_at: string;
  channels?: ContactChannel[];
}

export interface ContactChannel {
  channel: string;
  message_count: number;
  last_activity_at: string;
}

export interface ContactDetail extends Contact {
  messages: Message[];
  deals: Deal[];
  meetings: Meeting[];
}

export interface Message {
  id: string;
  channel: string;
  direction: 'inbound' | 'outbound';
  content: string;
  timestamp: string;
  external_id: string | null;
  metadata: Record<string, unknown>;
}

export interface TimelineEntry extends Message {}

// ── Deals ─────────────────────────────────────────────────────────────────────

export const STAGES = [
  'NEW_LEAD',
  'CONTACTED',
  'INTERESTED',
  'PROPOSAL_SENT',
  'NEGOTIATING',
  'CLOSED_WON',
  'CLOSED_LOST',
  'COLD',
] as const;

export type Stage = (typeof STAGES)[number];

export interface Deal {
  id: string;
  contact_id: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  contact_channel: string;
  contact_tags: string[];
  title: string;
  stage: Stage;
  ai_suggested_stage: Stage | null;
  stage_needs_confirm: boolean;
  summary: string | null;
  pain_points: string[];
  ai_buy_signal: number | null;
  ai_next_action: string | null;
  last_activity: string;
  last_founder_message_at: string | null;
  last_contact_reply_at: string | null;
  created_at: string;
}

export interface DealDetail {
  deal: Deal;
  latestSummary: LeadSummary | null;
  events: DealEvent[];
  messages: Message[];
}

export interface LeadSummary {
  id: string;
  deal_id: string;
  contact_id: string;
  summary: string;
  stage_assessment: Stage | null;
  buy_signal: number | null;
  pain_points: string[];
  next_action: string | null;
  generated_at: string;
}

export interface DealEvent {
  id: string;
  deal_id: string;
  type: string;
  data: Record<string, unknown>;
  created_at: string;
}

// ── Reminders ─────────────────────────────────────────────────────────────────

export interface Reminder {
  id: string;
  deal_id: string;
  contact_id: string;
  contact_name: string | null;
  deal_title: string | null;
  trigger_type: string;
  sequence_number: number;
  scheduled_at: string;
  sent_at: string | null;
  status: 'scheduled' | 'sent' | 'snoozed' | 'dismissed' | 'cancelled';
  message_body: string | null;
  snooze_count: number;
  created_at: string;
}

export interface SnoozePayload {
  duration_hours: 24 | 72 | 168;
}

// ── Meetings ──────────────────────────────────────────────────────────────────

export interface Meeting {
  id: string;
  contact_id: string | null;
  deal_id: string | null;
  title: string;
  start_time: string;
  end_time: string;
  calendar_event_id: string | null;
  brief_24h_sent: boolean;
  brief_1h_sent: boolean;
  created_at: string;
}

// ── Dashboard ────────────────────────────────────────────────────────────────

export interface DashboardSummary {
  pipeline: {
    by_stage: Record<string, number>;
    total_active: number;
  };
  reminders: {
    overdue: number;
    due_today: number;
  };
  contacts: {
    total: number;
    new_this_week: number;
  };
  weekly: {
    deals_created: number;
    deals_closed_won: number;
    deals_going_cold: number;
  };
}
