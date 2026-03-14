# NoSheeet — Build Summary

## What It Is
A WhatsApp-first AI CRM for founder-led sales. Automatically captures conversations from Gmail, WhatsApp, and Google Calendar into a deal pipeline. Claude summarises every lead, suggests next actions, and nudges founders before deals go cold.

---

## What Was Built

### Backend (Node.js + Express + TypeScript)

#### Channel Integration (Feature 1)
- **Gmail sync** — OAuth 2.0, pulls last 90 days of threads, BullMQ polling every 5 min
- **WhatsApp webhook** — receives incoming messages via Meta Cloud API, stores to unified inbox
- **Google Calendar sync** — pulls events, links attendees to contacts/deals
- **Contact matcher** (`matcher.ts`) — resolves every inbound message to a contact by email or phone; creates an "untagged lead" if no match; flags duplicate contacts for merge review
- **Merge requests** — when email + phone resolve to different contacts, creates a merge request and notifies founder via WhatsApp
- **Sheets / Notion import** — queued background import jobs with AI-assisted column mapping

#### Deal Engine (Feature 2)
- **Deal factory** — auto-creates a deal card for every new contact; links all messages to the correct deal
- **AI summarisation** (`ai.ts`) — every 5 messages, Claude generates: summary, pain points, stage suggestion, buy signal (0–1 float). Stage change is flagged for founder confirmation (`stage_needs_confirm = true`)
- **Reminder engine** — 5 trigger types evaluated on a schedule:
  - `no_reply_from_lead` — D+3, D+7, D+14, D+30
  - `no_reply_from_founder` — 4h, 24h after contact replies
  - `post_demo_no_followup` — D+1, D+3 after meeting
  - `proposal_no_activity` — D+5, D+10 in PROPOSAL_SENT stage
  - `deal_silent` — D+30 no activity → auto-move to COLD
- **Snooze escalation** — 3-strike system: normal → elevated → final → forced choice (follow up / archive / mark won / mark lost)
- **Vacation mode** — pauses all reminders; Claude generates a catch-up digest on return
- **Meeting briefs** — WhatsApp brief sent 24h and 1h before any calendar meeting

---

## Database (PostgreSQL 15)

| Table | Purpose |
|---|---|
| `users` | Founder accounts |
| `oauth_tokens` | Google / Notion / Sheets OAuth tokens |
| `contacts` | Leads and customers |
| `contact_channels` | Per-channel message counts (denormalised for speed) |
| `channel_messages` | Unified inbox — all Gmail, WhatsApp, Calendar messages |
| `deals` | Deal cards with stage, AI summary, buy signal |
| `deal_events` | Audit log — stage changes, AI updates, reminders |
| `lead_summaries` | Append-only Claude output per deal (latest = current) |
| `merge_requests` | Duplicate contact pairs awaiting founder decision |
| `meetings` | Calendar events linked to contacts/deals |
| `reminders` | Scheduled follow-up nudges |
| `snooze_log` | Escalation history per reminder |
| `notification_log` | All outbound WhatsApp messages |
| `vacation_mode` | Per-user vacation state + catch-up digest |

---

## API (32 endpoints)

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Server health check |
| GET | `/auth/google` | Redirect to Google OAuth |
| GET | `/auth/google/callback` | OAuth callback, issues JWT |
| POST | `/auth/phone` | Request phone OTP (dev: returns `000000`) |
| POST | `/auth/phone/verify` | Exchange OTP for JWT |
| GET | `/contacts` | List contacts |
| POST | `/contacts` | Create contact |
| GET | `/contacts/:id` | Contact + timeline + deals + meetings |
| GET | `/contacts/:id/timeline` | Paginated message history |
| GET | `/contacts/:id/summary` | Latest AI summary |
| PATCH | `/contacts/:id` | Update contact |
| DELETE | `/contacts/:id` | Archive contact |
| GET | `/deals` | All deals (kanban data) |
| POST | `/deals` | Create deal |
| GET | `/deals/:id` | Deal + events + AI summary |
| PATCH | `/deals/:id` | Update stage / confirm AI suggestion |
| GET | `/meetings` | List meetings |
| POST | `/meetings` | Create meeting |
| GET | `/reminders` | List reminders |
| POST | `/reminders/:id/snooze` | Snooze (24h / 72h / 168h) |
| POST | `/reminders/:id/force-choice` | Resolve after 3 snoozes |
| GET | `/merges` | Pending merge requests |
| POST | `/merges/:id/confirm` | Confirm contact merge |
| POST | `/merges/:id/decline` | Decline merge |
| POST | `/vacation` | Toggle vacation mode |
| GET | `/vacation` | Vacation mode status |
| GET | `/channels` | Connected channels |
| POST | `/channels/connect` | Trigger re-sync |
| GET | `/webhooks/whatsapp` | WhatsApp verify challenge |
| POST | `/webhooks/whatsapp` | Receive WhatsApp messages |
| POST | `/import/sheets` | Queue Sheets import |
| POST | `/import/notion` | Queue Notion import |

---

## Infrastructure

| Component | Technology |
|---|---|
| Backend | Node.js 20 + Express + TypeScript |
| Database | PostgreSQL 15 |
| Queue / cache | Redis 7 + BullMQ |
| AI | Anthropic Claude (`claude-sonnet-4-20250514`) |
| Auth | Google OAuth 2.0 + JWT (7-day expiry) |
| WhatsApp | Meta Business Cloud API v19 |
| Deployment | Railway (backend + Postgres + Redis) |
| Frontend | React + Vite + TailwindCSS (Lovable) |
| Local dev | Docker Compose (Postgres + Redis) |

---

## Tests

| Suite | Type | Count |
|---|---|---|
| `snooze-escalation` | Unit (pure logic, no DB) | 16 tests |
| `matcher` | Integration (real Postgres via testcontainers) | 6 tests |
| `merge` | Integration | 5 tests |
| `reminder-triggers` | Integration | 8 tests |

Run with:
```bash
npm run test:unit          # snooze logic only (no Docker needed)
npm run test:integration   # all DB tests (Docker required)
npm test                   # everything
npm run smoke              # end-to-end against live server
```

---

## CORS Policy

| Origin | Allowed |
|---|---|
| `localhost:*` | Always |
| `*.lovable.app` | Always |
| Custom domains | Via `ALLOWED_ORIGINS` env var (comma-separated) |

---

## Not Built (deferred to v2)
- Phone OTP via SMS provider (stub returns `000000` in dev)
- Gmail push via Cloud Pub/Sub (using 5-min polling instead)
- Duplicate merge UI (events stored, review flow in v2)
- WhatsApp outbound message composer
- Notion/Sheets column mapping UI
