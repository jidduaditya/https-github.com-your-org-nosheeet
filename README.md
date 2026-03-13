# NoSheeet — WhatsApp-first AI CRM

> Auto-captures Gmail, WhatsApp, and Calendar conversations into a deal pipeline. AI summarises every lead, suggests next actions, and nudges you before deals go cold.

---

## Local Setup

```bash
# 1. Start Postgres 15 + Redis 7 (schema auto-applied on first run)
docker-compose up -d

# 2. Backend
cd backend
cp .env.example .env   # fill in credentials (see table below)
npm install --cache /tmp/npm-cache
npm run dev            # http://localhost:3001

# 3. Frontend (separate terminal)
cd frontend
npm install --cache /tmp/npm-cache
npm run dev            # http://localhost:5173
```

---

## Credentials

| Variable | How to get it |
|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials → OAuth 2.0 |
| `GOOGLE_REDIRECT_URI` | Set to `http://localhost:3001/auth/google/callback` (must match Cloud Console exactly) |
| `WHATSAPP_VERIFY_TOKEN` | Any string you choose; set the same value in Meta Developer portal → Webhooks |
| `WHATSAPP_ACCESS_TOKEN` | Meta for Developers → WhatsApp → API Setup → Temporary or Permanent token |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta for Developers → WhatsApp → Phone Numbers |
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) → API Keys |
| `JWT_SECRET` | Any long random string (e.g. `openssl rand -hex 32`) |

The `DATABASE_URL` and `REDIS_URL` in `.env` are pre-filled for the docker-compose defaults and require no changes.

---

## Running Tests

```bash
cd backend

# Fast unit tests (pure logic, no Docker needed)
npm run test:unit

# Integration tests (start real Postgres via testcontainers — Docker required)
npm run test:integration

# All tests
npm test

# End-to-end smoke test (server must be running: npm run dev)
npm run smoke
```

**Requirements for integration tests:**
- Docker must be running (testcontainers pulls `postgres:15-alpine` automatically)
- No manual DB setup needed — each test file starts its own isolated container

---

## Webhook Setup (WhatsApp)

WhatsApp Cloud API requires a publicly reachable HTTPS URL. For local dev, use ngrok:

```bash
# Expose local port 3001
ngrok http 3001
```

Copy the `https://....ngrok-free.app` URL, then in the Meta Developer portal:

1. Go to **WhatsApp → Configuration → Webhooks**
2. Set **Callback URL** to `https://<ngrok-url>/webhooks/whatsapp`
3. Set **Verify Token** to the value of `WHATSAPP_VERIFY_TOKEN` in your `.env`
4. Subscribe to the **messages** field

Each time ngrok restarts, update the Callback URL in the portal.

---

## Architecture

```
Gmail / WhatsApp / Calendar
         │
         ▼
   matcher.ts        ← exact match by email or phone
         │              diverging pair → merge_request
         ▼
  channel_messages   ← unified inbox
         │
         ▼
  deal-factory.ts    ← auto deal creation / linking
         │
         ▼ every 5 messages
  BullMQ → ai-summarise job
         │
         ▼
    ai.ts (Claude)   ← summary, pain points, stage suggestion, buy signal
         │
         ▼
    deals table      ← stage_needs_confirm=true until founder approves
         │
         ▼
  reminder-engine    ← 5 trigger types, 3-strike snooze escalation
         │
         ▼
  WhatsApp notifier  ← nudges sent to founder's phone
```

## API Reference

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | — | Server + DB health check |
| GET | `/auth/google` | — | Redirect to Google OAuth consent |
| GET | `/auth/google/callback` | — | OAuth callback, issues JWT |
| POST | `/auth/phone` | — | Request phone OTP (dev: always returns `000000`) |
| POST | `/auth/phone/verify` | — | Exchange OTP for JWT |
| GET | `/contacts` | ✓ | List contacts (filterable by tag, source, search) |
| POST | `/contacts` | ✓ | Create contact manually |
| GET | `/contacts/:id` | ✓ | Contact + full timeline + deals + meetings |
| PATCH | `/contacts/:id` | ✓ | Update contact fields |
| GET | `/deals` | ✓ | All deals (kanban data) |
| POST | `/deals` | ✓ | Create deal manually |
| GET | `/deals/:id` | ✓ | Deal + events + latest AI summary |
| PATCH | `/deals/:id` | ✓ | Update stage / confirm AI suggestion |
| GET | `/meetings` | ✓ | List meetings (`?upcoming=true` for future only) |
| POST | `/meetings` | ✓ | Create meeting |
| GET | `/reminders` | ✓ | List scheduled reminders |
| POST | `/reminders/:id/snooze` | ✓ | Snooze reminder (24h / 72h / 168h) |
| POST | `/reminders/:id/force-choice` | ✓ | Resolve after 3 snoozes |
| GET | `/merges` | ✓ | Pending duplicate merge requests |
| POST | `/merges/:id/confirm` | ✓ | Confirm merge |
| POST | `/merges/:id/decline` | ✓ | Decline merge |
| POST | `/vacation` | ✓ | Toggle vacation mode |
| GET | `/webhooks/whatsapp` | — | WhatsApp webhook verification |
| POST | `/webhooks/whatsapp` | — | Receive WhatsApp messages |
| POST | `/import/sheets` | ✓ | Queue a Google Sheets import |
| POST | `/import/notion` | ✓ | Queue a Notion database import |

## Deferred (v2)
- Gmail Cloud Pub/Sub push (polling every 5 min instead)
- Duplicate merge UI (events stored, surfaced in v2)
- Notion/Sheets column mapping UI
