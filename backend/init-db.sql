-- =============================================================
-- NoSheeet — init-db.sql
-- Safe to run against a fresh OR existing Railway Postgres DB.
-- All statements use IF NOT EXISTS / DO blocks for idempotency.
-- Run with:
--   psql $DATABASE_URL -f backend/init-db.sql
-- =============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ---------------------------------------------------------------
-- Enums (wrapped in DO blocks — CREATE TYPE has no IF NOT EXISTS)
-- ---------------------------------------------------------------

DO $$ BEGIN
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
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE channel_type AS ENUM (
    'gmail',
    'whatsapp',
    'calendar',
    'manual',
    'notion',
    'sheets'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE reminder_trigger AS ENUM (
    'no_reply_from_lead',
    'no_reply_from_founder',
    'demo_upcoming',
    'post_demo_no_followup',
    'proposal_no_activity',
    'deal_silent'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE reminder_status AS ENUM (
    'scheduled',
    'sent',
    'snoozed',
    'dismissed',
    'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE merge_request_status AS ENUM (
    'pending',
    'confirmed',
    'declined'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Add enum values that may be missing on older installs
DO $$ BEGIN
  ALTER TYPE channel_type ADD VALUE IF NOT EXISTS 'notion';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE channel_type ADD VALUE IF NOT EXISTS 'sheets';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email        TEXT UNIQUE NOT NULL,
  phone        TEXT UNIQUE,
  name         TEXT,
  company_name TEXT,
  role         TEXT NOT NULL DEFAULT 'founder',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------
-- OAuth tokens
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
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
  primary_channel channel_type NOT NULL DEFAULT 'manual',
  source          TEXT NOT NULL DEFAULT 'manual',
  tags            TEXT[] NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, email),
  UNIQUE(user_id, phone)
);

-- ---------------------------------------------------------------
-- Contact channels
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS contact_channels (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id       UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel          channel_type NOT NULL,
  message_count    INT NOT NULL DEFAULT 0,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(contact_id, channel)
);

-- ---------------------------------------------------------------
-- Channel messages  (unified inbox — also surfaced as "messages")
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS channel_messages (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id  UUID REFERENCES contacts(id) ON DELETE SET NULL,
  channel     channel_type NOT NULL,
  external_id TEXT,
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
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id              UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  title                   TEXT NOT NULL,
  stage                   deal_stage NOT NULL DEFAULT 'NEW_LEAD',
  ai_suggested_stage      deal_stage,
  stage_needs_confirm     BOOLEAN NOT NULL DEFAULT FALSE,
  summary                 TEXT,
  pain_points             TEXT[] NOT NULL DEFAULT '{}',
  ai_buy_signal           FLOAT CHECK (ai_buy_signal >= 0 AND ai_buy_signal <= 1),
  last_founder_message_at TIMESTAMPTZ,
  last_contact_reply_at   TIMESTAMPTZ,
  last_activity           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------
-- Deal events (audit log)
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS deal_events (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  deal_id    UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  data       JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------
-- Lead summaries (append-only Claude output)
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lead_summaries (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deal_id          UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  contact_id       UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  contact_name     TEXT,
  contact_email    TEXT,
  contact_phone    TEXT,
  source_channel   channel_type,
  summary          TEXT NOT NULL,
  stage_assessment deal_stage,
  buy_signal       FLOAT CHECK (buy_signal >= 0 AND buy_signal <= 1),
  pain_points      TEXT[] NOT NULL DEFAULT '{}',
  next_action      TEXT,
  model_used       TEXT NOT NULL DEFAULT 'claude-sonnet-4-20250514',
  generated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------
-- Merge requests (duplicate contact detection)
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS merge_requests (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_a_id       UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  contact_b_id       UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  match_reason       TEXT NOT NULL,
  status             merge_request_status NOT NULL DEFAULT 'pending',
  notified_at        TIMESTAMPTZ,
  resolved_at        TIMESTAMPTZ,
  resolved_by        TEXT,
  primary_contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT canonical_pair CHECK (contact_a_id < contact_b_id),
  UNIQUE(user_id, contact_a_id, contact_b_id, status)
);

-- ---------------------------------------------------------------
-- Meetings (Google Calendar)
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
  brief_24h_sent    BOOLEAN NOT NULL DEFAULT FALSE,
  brief_1h_sent     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------
-- Reminders (scheduler)
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS reminders (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deal_id         UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  contact_id      UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  trigger_type    reminder_trigger NOT NULL,
  sequence_number INT NOT NULL DEFAULT 1,
  scheduled_at    TIMESTAMPTZ NOT NULL,
  sent_at         TIMESTAMPTZ,
  status          reminder_status NOT NULL DEFAULT 'scheduled',
  message_body    TEXT,
  snooze_count    INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------
-- Snooze log (escalation history)
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS snooze_log (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reminder_id      UUID NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  snooze_number    INT NOT NULL,
  duration_hours   INT NOT NULL,
  new_scheduled_at TIMESTAMPTZ NOT NULL,
  escalation_tone  TEXT NOT NULL,
  snoozed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------
-- Notification log (all outbound WhatsApp messages)
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS notification_log (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reminder_id         UUID REFERENCES reminders(id) ON DELETE SET NULL,
  deal_id             UUID REFERENCES deals(id) ON DELETE SET NULL,
  notification_type   TEXT NOT NULL,
  channel             TEXT NOT NULL DEFAULT 'whatsapp',
  recipient_phone     TEXT NOT NULL,
  message_body        TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'sent'
                        CHECK (status IN ('sent', 'delivered', 'read', 'failed')),
  external_message_id TEXT UNIQUE,
  sent_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at        TIMESTAMPTZ,
  read_at             TIMESTAMPTZ
);

-- ---------------------------------------------------------------
-- Vacation mode (one row per user, upserted)
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS vacation_mode (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id                 UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  is_active               BOOLEAN NOT NULL DEFAULT FALSE,
  activated_at            TIMESTAMPTZ,
  deactivated_at          TIMESTAMPTZ,
  catch_up_digest         TEXT,
  catch_up_digest_sent_at TIMESTAMPTZ,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------

-- Users
CREATE INDEX IF NOT EXISTS idx_users_email              ON users(email);

-- Contacts
CREATE INDEX IF NOT EXISTS idx_contacts_user            ON contacts(user_id);
CREATE INDEX IF NOT EXISTS idx_contacts_email           ON contacts(email);
CREATE INDEX IF NOT EXISTS idx_contacts_phone           ON contacts(phone);

-- Contact channels
CREATE INDEX IF NOT EXISTS idx_contact_channels_contact  ON contact_channels(contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_channels_activity ON contact_channels(contact_id, last_activity_at DESC);

-- Messages
CREATE INDEX IF NOT EXISTS idx_messages_contact         ON channel_messages(contact_id);
CREATE INDEX IF NOT EXISTS idx_messages_user            ON channel_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp       ON channel_messages(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_messages_direction       ON channel_messages(contact_id, direction, timestamp DESC);

-- Deals
CREATE INDEX IF NOT EXISTS idx_deals_user               ON deals(user_id);
CREATE INDEX IF NOT EXISTS idx_deals_contact            ON deals(contact_id);
CREATE INDEX IF NOT EXISTS idx_deals_stage              ON deals(user_id, stage);
CREATE INDEX IF NOT EXISTS idx_deals_last_activity      ON deals(user_id, last_activity DESC);

-- Deal events
CREATE INDEX IF NOT EXISTS idx_deal_events_deal         ON deal_events(deal_id);
CREATE INDEX IF NOT EXISTS idx_deal_events_type         ON deal_events(deal_id, type);

-- Lead summaries
CREATE INDEX IF NOT EXISTS idx_lead_summaries_deal      ON lead_summaries(deal_id, generated_at DESC);

-- Merge requests
CREATE INDEX IF NOT EXISTS idx_merge_requests_user      ON merge_requests(user_id, status);
CREATE INDEX IF NOT EXISTS idx_merge_requests_pair      ON merge_requests(contact_a_id, contact_b_id);

-- Meetings
CREATE INDEX IF NOT EXISTS idx_meetings_user            ON meetings(user_id);
CREATE INDEX IF NOT EXISTS idx_meetings_start           ON meetings(user_id, start_time);
CREATE INDEX IF NOT EXISTS idx_meetings_contact         ON meetings(contact_id);

-- Reminders
CREATE INDEX IF NOT EXISTS idx_reminders_scheduled      ON reminders(user_id, status, scheduled_at)
  WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_reminders_deal           ON reminders(deal_id);

-- Snooze log
CREATE INDEX IF NOT EXISTS idx_snooze_log_reminder      ON snooze_log(reminder_id);

-- Notification log
CREATE INDEX IF NOT EXISTS idx_notification_log_user    ON notification_log(user_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_log_ext     ON notification_log(external_message_id)
  WHERE external_message_id IS NOT NULL;
