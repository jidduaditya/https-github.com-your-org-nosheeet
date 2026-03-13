-- =============================================================
-- NoSheeet — Full PostgreSQL Schema
-- Feature 1: Channel Integration Hub
-- Feature 2: Reminder & Follow-Up Engine
-- =============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ---------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------

CREATE TYPE deal_stage AS ENUM (
  'NEW_LEAD',
  'CONTACTED',
  'INTERESTED',
  'PROPOSAL_SENT',
  'NEGOTIATING',
  'CLOSED_WON',
  'CLOSED_LOST',
  'COLD'
);

CREATE TYPE channel_type AS ENUM (
  'gmail',
  'whatsapp',
  'calendar',
  'manual',
  'notion',
  'sheets'
);

-- Trigger types map 1:1 to the schedule rows in the product brief.
-- sequence_number on the reminders table encodes position (D3=1, D7=2, …).
CREATE TYPE reminder_trigger AS ENUM (
  'no_reply_from_lead',      -- Founder sent, contact hasn't replied
  'no_reply_from_founder',   -- Contact replied, founder hasn't responded
  'demo_upcoming',           -- Calendar event within 24h / 1h
  'post_demo_no_followup',   -- Demo passed, no follow-up sent
  'proposal_no_activity',    -- Proposal stage, 5 / 10 days silence
  'deal_silent'              -- 30+ days no activity → Cold
);

CREATE TYPE reminder_status AS ENUM (
  'scheduled',   -- waiting to fire
  'sent',        -- WhatsApp message delivered
  'snoozed',     -- rescheduled by founder
  'dismissed',   -- founder explicitly dismissed
  'cancelled'    -- superseded (e.g. contact replied, deal closed)
);

CREATE TYPE merge_request_status AS ENUM (
  'pending',    -- awaiting founder decision
  'confirmed',  -- founder approved merge
  'declined'    -- founder declined; never re-prompt this pair
);

-- ---------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email           TEXT UNIQUE NOT NULL,
  phone           TEXT UNIQUE,                 -- founder's WhatsApp number for notifications
  name            TEXT,
  company_name    TEXT,
  role            TEXT NOT NULL DEFAULT 'founder',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------
-- OAuth tokens
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,  -- 'google' | 'notion' | 'sheets'
  access_token  TEXT NOT NULL,
  refresh_token TEXT,
  expires_at    TIMESTAMPTZ,
  scope         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, provider)
);

-- ---------------------------------------------------------------
-- Contacts
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS contacts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT,
  email           TEXT,
  phone           TEXT,
  -- primary_channel: the channel with most recent activity (auto-updated)
  primary_channel channel_type NOT NULL DEFAULT 'manual',
  -- source: how this contact first entered the system
  source          TEXT NOT NULL DEFAULT 'manual',
  -- source values: 'gmail' | 'whatsapp' | 'calendar' | 'import_sheets'
  --                | 'import_notion' | 'manual'
  tags            TEXT[] NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, email),
  UNIQUE(user_id, phone)
);

-- ---------------------------------------------------------------
-- Contact channels
-- Denormalized summary: one row per (contact, channel).
-- Updated on every channel_messages insert. Enables O(1) primary-channel
-- recomputation and efficient "3+ channels" checks.
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS contact_channels (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id      UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel         channel_type NOT NULL,
  message_count   INT NOT NULL DEFAULT 0,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(contact_id, channel)
);

-- ---------------------------------------------------------------
-- Channel messages (unified inbox)
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS channel_messages (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id  UUID REFERENCES contacts(id) ON DELETE SET NULL,
  channel     channel_type NOT NULL,
  external_id TEXT,            -- gmail thread id, wa message id, calendar event id, etc.
  direction   TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  content     TEXT NOT NULL,
  metadata    JSONB NOT NULL DEFAULT '{}',
  timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(channel, external_id)
);

-- ---------------------------------------------------------------
-- Deals
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS deals (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id            UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  title                 TEXT NOT NULL,
  stage                 deal_stage NOT NULL DEFAULT 'NEW_LEAD',
  ai_suggested_stage    deal_stage,
  stage_needs_confirm   BOOLEAN NOT NULL DEFAULT FALSE,
  summary               TEXT,
  pain_points           TEXT[] NOT NULL DEFAULT '{}',
  ai_buy_signal         FLOAT CHECK (ai_buy_signal >= 0 AND ai_buy_signal <= 1),
  -- Denormalized for fast trigger evaluation (avoids scanning channel_messages)
  last_founder_message_at TIMESTAMPTZ,
  last_contact_reply_at   TIMESTAMPTZ,
  last_activity           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------
-- Deal events (audit log)
-- type values: 'message' | 'stage_change' | 'ai_update' | 'meeting'
--              | 'reminder_sent' | 'merge_prompt'
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS deal_events (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  deal_id    UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  data       JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------
-- Lead summaries  (Feature 1 LLM pipeline)
-- Append-only — each Claude run creates a new row.
-- Latest row per deal_id = current summary.
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lead_summaries (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deal_id         UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  contact_id      UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  -- Snapshot of contact info at generation time
  contact_name    TEXT,
  contact_email   TEXT,
  contact_phone   TEXT,
  source_channel  channel_type,
  -- Claude output
  summary         TEXT NOT NULL,          -- 2–3 sentence narrative
  stage_assessment deal_stage,            -- Claude's read on current stage
  buy_signal      FLOAT CHECK (buy_signal >= 0 AND buy_signal <= 1),
  pain_points     TEXT[] NOT NULL DEFAULT '{}',
  next_action     TEXT,                   -- recommended next step
  model_used      TEXT NOT NULL DEFAULT 'claude-sonnet-4-20250514',
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------
-- Merge requests  (Feature 1 duplicate detection)
-- contact_a_id < contact_b_id enforced by CHECK — canonical ordering
-- prevents (A,B) and (B,A) from both being inserted.
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS merge_requests (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Canonical order: a < b (UUID text comparison)
  contact_a_id    UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  contact_b_id    UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  match_reason    TEXT NOT NULL,  -- e.g. "gmail email + whatsapp phone resolve to same person"
  status          merge_request_status NOT NULL DEFAULT 'pending',
  -- When the WhatsApp notification was sent to the founder
  notified_at     TIMESTAMPTZ,
  resolved_at     TIMESTAMPTZ,
  resolved_by     TEXT,           -- 'founder' | 'system'
  -- If confirmed: which contact survived, which was deleted/merged
  primary_contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One pending/confirmed request per pair; declined pairs are allowed to
  -- accumulate if user re-triggers (but we CHECK before inserting).
  CONSTRAINT canonical_pair CHECK (contact_a_id < contact_b_id),
  UNIQUE(user_id, contact_a_id, contact_b_id, status)
  -- Note: UNIQUE includes status so a declined pair can never get a new
  -- 'pending' row — the app layer must enforce "no re-prompt if declined".
);

-- ---------------------------------------------------------------
-- Meetings  (Google Calendar)
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS meetings (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id        UUID REFERENCES contacts(id) ON DELETE SET NULL,
  deal_id           UUID REFERENCES deals(id) ON DELETE SET NULL,
  title             TEXT NOT NULL,
  start_time        TIMESTAMPTZ NOT NULL,
  end_time          TIMESTAMPTZ NOT NULL,
  calendar_event_id TEXT UNIQUE,
  -- Idempotency guards for pre-meeting brief reminders
  brief_24h_sent    BOOLEAN NOT NULL DEFAULT FALSE,
  brief_1h_sent     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------
-- Reminders  (Feature 2 scheduler)
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS reminders (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deal_id         UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  contact_id      UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  -- Which trigger fired this reminder
  trigger_type    reminder_trigger NOT NULL,
  -- Position in the trigger sequence (D3=1, D7=2, D14=3, D30=4 for no_reply_from_lead)
  sequence_number INT NOT NULL DEFAULT 1,
  scheduled_at    TIMESTAMPTZ NOT NULL,
  sent_at         TIMESTAMPTZ,
  status          reminder_status NOT NULL DEFAULT 'scheduled',
  -- Rendered WhatsApp message text (stored so re-sends are idempotent)
  message_body    TEXT,
  -- Running count of snoozes (mirrors snooze_log COUNT but denormalized for fast reads)
  snooze_count    INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------
-- Snooze log  (Feature 2 — append-only escalation history)
-- snooze_number 1: normal tone
-- snooze_number 2: elevated tone
-- snooze_number 3: final snooze prompt
-- snooze_number 4+: no more snoozes — forced choice
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS snooze_log (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reminder_id         UUID NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  snooze_number       INT NOT NULL,          -- 1-indexed count for this reminder
  duration_hours      INT NOT NULL,          -- 24 | 72 | 168
  new_scheduled_at    TIMESTAMPTZ NOT NULL,
  escalation_tone     TEXT NOT NULL,         -- 'normal' | 'elevated' | 'final' | 'forced_choice'
  snoozed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------
-- Notification log  (Feature 2 — all outbound WhatsApp messages)
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS notification_log (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- nullable: some notifications are not tied to a reminder (e.g. merge prompt, catch-up digest)
  reminder_id         UUID REFERENCES reminders(id) ON DELETE SET NULL,
  deal_id             UUID REFERENCES deals(id) ON DELETE SET NULL,
  notification_type   TEXT NOT NULL,        -- 'reminder' | 'merge_prompt' | 'catch_up_digest' | 'brief'
  channel             TEXT NOT NULL DEFAULT 'whatsapp',
  recipient_phone     TEXT NOT NULL,
  message_body        TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'sent'
                        CHECK (status IN ('sent', 'delivered', 'read', 'failed')),
  -- WhatsApp message ID returned by Cloud API (for delivery status webhook)
  external_message_id TEXT UNIQUE,
  sent_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at        TIMESTAMPTZ,
  read_at             TIMESTAMPTZ
);

-- ---------------------------------------------------------------
-- Vacation mode  (Feature 2 — one row per user, upserted)
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS vacation_mode (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id                 UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  is_active               BOOLEAN NOT NULL DEFAULT FALSE,
  activated_at            TIMESTAMPTZ,
  deactivated_at          TIMESTAMPTZ,
  -- Claude-generated catch-up digest produced on return
  catch_up_digest         TEXT,
  catch_up_digest_sent_at TIMESTAMPTZ,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------

-- Contacts
CREATE INDEX IF NOT EXISTS idx_contacts_user         ON contacts(user_id);
CREATE INDEX IF NOT EXISTS idx_contacts_email        ON contacts(email);
CREATE INDEX IF NOT EXISTS idx_contacts_phone        ON contacts(phone);

-- Contact channels (primary-channel recomputation)
CREATE INDEX IF NOT EXISTS idx_contact_channels_contact ON contact_channels(contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_channels_activity ON contact_channels(contact_id, last_activity_at DESC);

-- Messages
CREATE INDEX IF NOT EXISTS idx_messages_contact      ON channel_messages(contact_id);
CREATE INDEX IF NOT EXISTS idx_messages_user         ON channel_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp    ON channel_messages(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_messages_direction    ON channel_messages(contact_id, direction, timestamp DESC);

-- Deals
CREATE INDEX IF NOT EXISTS idx_deals_user            ON deals(user_id);
CREATE INDEX IF NOT EXISTS idx_deals_contact         ON deals(contact_id);
CREATE INDEX IF NOT EXISTS idx_deals_stage           ON deals(user_id, stage);
CREATE INDEX IF NOT EXISTS idx_deals_last_activity   ON deals(user_id, last_activity DESC);

-- Deal events
CREATE INDEX IF NOT EXISTS idx_deal_events_deal      ON deal_events(deal_id);
CREATE INDEX IF NOT EXISTS idx_deal_events_type      ON deal_events(deal_id, type);

-- Lead summaries (latest per deal)
CREATE INDEX IF NOT EXISTS idx_lead_summaries_deal   ON lead_summaries(deal_id, generated_at DESC);

-- Merge requests
CREATE INDEX IF NOT EXISTS idx_merge_requests_user   ON merge_requests(user_id, status);
CREATE INDEX IF NOT EXISTS idx_merge_requests_pair   ON merge_requests(contact_a_id, contact_b_id);

-- Meetings
CREATE INDEX IF NOT EXISTS idx_meetings_user         ON meetings(user_id);
CREATE INDEX IF NOT EXISTS idx_meetings_start        ON meetings(user_id, start_time);
CREATE INDEX IF NOT EXISTS idx_meetings_contact      ON meetings(contact_id);

-- Reminders (scheduler hot path: find all scheduled reminders due now)
CREATE INDEX IF NOT EXISTS idx_reminders_scheduled   ON reminders(user_id, status, scheduled_at)
  WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_reminders_deal        ON reminders(deal_id);

-- Snooze log
CREATE INDEX IF NOT EXISTS idx_snooze_log_reminder   ON snooze_log(reminder_id);

-- Notification log
CREATE INDEX IF NOT EXISTS idx_notification_log_user ON notification_log(user_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_log_ext  ON notification_log(external_message_id)
  WHERE external_message_id IS NOT NULL;
