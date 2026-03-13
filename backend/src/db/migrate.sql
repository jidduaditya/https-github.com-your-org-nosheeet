-- =============================================================
-- NoSheeet — Incremental migration
-- Run this against an existing DB that has the v1 schema.
-- For a fresh DB, schema.sql handles everything.
-- =============================================================

-- Add new channel enum values (safe if already exists — Postgres will error,
-- so wrap in DO blocks to swallow duplicate-object errors)

DO $$ BEGIN
  ALTER TYPE channel_type ADD VALUE IF NOT EXISTS 'notion';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE channel_type ADD VALUE IF NOT EXISTS 'sheets';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- New enums
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
    'scheduled', 'sent', 'snoozed', 'dismissed', 'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE merge_request_status AS ENUM (
    'pending', 'confirmed', 'declined'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Contacts: add source column
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';

-- Deals: add trigger-evaluation columns
ALTER TABLE deals ADD COLUMN IF NOT EXISTS last_founder_message_at TIMESTAMPTZ;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS last_contact_reply_at   TIMESTAMPTZ;

-- Meetings: idempotency guards for pre-meeting briefs
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS brief_24h_sent BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS brief_1h_sent  BOOLEAN NOT NULL DEFAULT FALSE;

-- New tables (defined in schema.sql; safe to run again via IF NOT EXISTS)

CREATE TABLE IF NOT EXISTS contact_channels (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id       UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel          channel_type NOT NULL,
  message_count    INT NOT NULL DEFAULT 0,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(contact_id, channel)
);

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

-- New indexes
CREATE INDEX IF NOT EXISTS idx_contact_channels_contact  ON contact_channels(contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_channels_activity ON contact_channels(contact_id, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_direction        ON channel_messages(contact_id, direction, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_deals_stage               ON deals(user_id, stage);
CREATE INDEX IF NOT EXISTS idx_deals_last_activity       ON deals(user_id, last_activity DESC);
CREATE INDEX IF NOT EXISTS idx_deal_events_type          ON deal_events(deal_id, type);
CREATE INDEX IF NOT EXISTS idx_lead_summaries_deal       ON lead_summaries(deal_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_merge_requests_user       ON merge_requests(user_id, status);
CREATE INDEX IF NOT EXISTS idx_merge_requests_pair       ON merge_requests(contact_a_id, contact_b_id);
CREATE INDEX IF NOT EXISTS idx_meetings_start            ON meetings(user_id, start_time);
CREATE INDEX IF NOT EXISTS idx_meetings_contact          ON meetings(contact_id);
CREATE INDEX IF NOT EXISTS idx_reminders_scheduled       ON reminders(user_id, status, scheduled_at)
  WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_reminders_deal            ON reminders(deal_id);
CREATE INDEX IF NOT EXISTS idx_snooze_log_reminder       ON snooze_log(reminder_id);
CREATE INDEX IF NOT EXISTS idx_notification_log_user     ON notification_log(user_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_log_ext      ON notification_log(external_message_id)
  WHERE external_message_id IS NOT NULL;
