/**
 * smoke-test.ts — End-to-end verification that the running server and DB work.
 *
 * Usage: npm run smoke
 * Requires the server to be running: npm run dev (in another terminal)
 *
 * Steps:
 *  1. GET  /health                   — server up + DB connected
 *  2. POST /auth/phone               — phone stub returns OTP
 *  3. POST /auth/phone/verify        — exchange OTP for JWT
 *  4. POST /contacts                 — create a contact
 *  5. GET  /contacts/:id             — verify contact + timeline structure
 *  6. POST /meetings                 — create a meeting linked to the contact
 *  7. GET  /meetings?upcoming=true   — verify the meeting is returned
 */

import 'dotenv/config';

const BASE = `http://localhost:${process.env.PORT ?? 3001}`;

let passed = 0;
let failed = 0;

async function step(label: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓  ${label}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${label}`);
    console.error(`     ${(err as Error).message}`);
    failed++;
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

async function req(
  method: string,
  path: string,
  options: { body?: unknown; token?: string } = {}
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.token) headers['Authorization'] = `Bearer ${options.token}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function run() {
  console.log(`\nNoSheeet smoke test → ${BASE}\n`);

  let token = '';
  let contactId = '';
  let meetingId = '';
  const phone = '+15550000001';

  // ── Step 1: health ──────────────────────────────────────────────────────────
  await step('GET /health → 200 + DB ok', async () => {
    const { status, body } = await req('GET', '/health');
    assert(status === 200, `Expected 200, got ${status}`);
    assert((body as { status: string }).status === 'ok', 'Expected status=ok');
  });

  // ── Step 2: phone auth stub ─────────────────────────────────────────────────
  await step('POST /auth/phone → returns OTP', async () => {
    const { status, body } = await req('POST', '/auth/phone', { body: { phone } });
    assert(status === 200, `Expected 200, got ${status}`);
    assert((body as { otp: string }).otp === '000000', 'Expected stub OTP 000000');
  });

  // ── Step 3: verify OTP → JWT ────────────────────────────────────────────────
  await step('POST /auth/phone/verify → JWT issued', async () => {
    const { status, body } = await req('POST', '/auth/phone/verify', { body: { phone, otp: '000000' } });
    assert(status === 200, `Expected 200, got ${status}`);
    token = (body as { token: string }).token;
    assert(typeof token === 'string' && token.length > 20, 'Expected a non-empty JWT');
  });

  // ── Step 4: create contact ──────────────────────────────────────────────────
  await step('POST /contacts → 201 + id returned', async () => {
    const { status, body } = await req('POST', '/contacts', {
      token,
      body: { name: 'Smoke Test Lead', email: 'smoke@example.com' },
    });
    assert(status === 201, `Expected 201, got ${status}`);
    contactId = (body as { id: string }).id;
    assert(typeof contactId === 'string' && contactId.length > 0, 'Expected contact id');
  });

  // ── Step 5: contact timeline ────────────────────────────────────────────────
  await step('GET /contacts/:id → contact with timeline keys', async () => {
    const { status, body } = await req('GET', `/contacts/${contactId}`, { token });
    assert(status === 200, `Expected 200, got ${status}`);
    const b = body as Record<string, unknown>;
    assert('contact' in b, 'Expected contact key');
    assert('messages' in b, 'Expected messages key');
    assert('deals' in b, 'Expected deals key');
  });

  // ── Step 6: create meeting ──────────────────────────────────────────────────
  await step('POST /meetings → 201 + id returned', async () => {
    const start = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const end   = new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString();
    const { status, body } = await req('POST', '/meetings', {
      token,
      body: { contact_id: contactId, title: 'Smoke Test Demo', start_time: start, end_time: end },
    });
    assert(status === 201, `Expected 201, got ${status}`);
    meetingId = (body as { id: string }).id;
    assert(typeof meetingId === 'string' && meetingId.length > 0, 'Expected meeting id');
  });

  // ── Step 7: upcoming meetings list ─────────────────────────────────────────
  await step('GET /meetings?upcoming=true → includes our meeting', async () => {
    const { status, body } = await req('GET', '/meetings?upcoming=true', { token });
    assert(status === 200, `Expected 200, got ${status}`);
    const rows = body as Array<{ id: string }>;
    assert(Array.isArray(rows), 'Expected array');
    assert(rows.some(r => r.id === meetingId), `Meeting ${meetingId} not found in upcoming list`);
  });

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
