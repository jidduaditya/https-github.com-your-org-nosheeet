import { createTestDb, TestPool } from '../helpers/test-db';

let pool: TestPool;

jest.mock('../../db/client', () => ({
  get db() { return pool; },
}));
jest.mock('../../jobs/queue', () => ({
  reminderQueue: { add: jest.fn().mockResolvedValue(undefined) },
  aiSummariseQueue: { add: jest.fn().mockResolvedValue(undefined) },
}));

beforeAll(async () => { pool = await createTestDb(); });
afterAll(() => pool.end());

async function seed(): Promise<{ userId: string; contactId: string }> {
  const userRes = await pool.query(
    `INSERT INTO users (email, phone) VALUES ('founder@triggers.com', '+19990000001') RETURNING id`
  );
  const userId = userRes.rows[0].id as string;

  const contactRes = await pool.query(
    `INSERT INTO contacts (user_id, email, primary_channel, source, tags)
     VALUES ($1, 'lead@test.com', 'gmail', 'gmail', ARRAY['untagged_lead']) RETURNING id`,
    [userId]
  );
  const contactId = contactRes.rows[0].id as string;
  return { userId, contactId };
}

async function seedDeal(userId: string, contactId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const defaults = { user_id: userId, contact_id: contactId, title: 'Test Deal', stage: 'CONTACTED' };
  const all = { ...defaults, ...overrides };
  const cols = Object.keys(all);
  const vals = Object.values(all);
  const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
  const res = await pool.query(
    `INSERT INTO deals (${cols.join(', ')}) VALUES (${placeholders}) RETURNING id`,
    vals
  );
  return res.rows[0].id as string;
}

describe('no_reply_from_lead trigger', () => {
  let evaluateAllDeals: typeof import('../../services/reminder-engine').evaluateAllDeals;

  beforeAll(async () => {
    const engine = await import('../../services/reminder-engine');
    evaluateAllDeals = engine.evaluateAllDeals;
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM reminders');
    await pool.query('DELETE FROM deals');
    await pool.query('DELETE FROM contacts');
    await pool.query('DELETE FROM users');
    await pool.query('DELETE FROM vacation_mode');
  });

  test('creates seq=1 reminder when founder sent 4+ days ago, no reply', async () => {
    const { userId, contactId } = await seed();
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
    await seedDeal(userId, contactId, { last_founder_message_at: fourDaysAgo, last_contact_reply_at: null });

    await evaluateAllDeals();

    const rows = await pool.query(`SELECT * FROM reminders WHERE trigger_type = 'no_reply_from_lead'`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].sequence_number).toBe(1);
  });

  test('does NOT create reminder when contact replied after founder', async () => {
    const { userId, contactId } = await seed();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await seedDeal(userId, contactId, {
      last_founder_message_at: yesterday,
      last_contact_reply_at: twoHoursAgo,
    });

    await evaluateAllDeals();

    const rows = await pool.query(`SELECT * FROM reminders WHERE trigger_type = 'no_reply_from_lead'`);
    expect(rows.rows).toHaveLength(0);
  });

  test('does NOT create reminder if 3-day threshold not yet reached', async () => {
    const { userId, contactId } = await seed();
    await seedDeal(userId, contactId, {
      last_founder_message_at: new Date(Date.now() - 60 * 60 * 1000), // 1 hour ago
      last_contact_reply_at: null,
    });

    await evaluateAllDeals();

    const rows = await pool.query(`SELECT * FROM reminders WHERE trigger_type = 'no_reply_from_lead'`);
    expect(rows.rows).toHaveLength(0);
  });

  test('only creates one new seq per evaluation cycle', async () => {
    const { userId, contactId } = await seed();
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const dealId = await seedDeal(userId, contactId, {
      last_founder_message_at: tenDaysAgo,
      last_contact_reply_at: null,
    });

    // Pre-insert seq=1 as already scheduled
    await pool.query(
      `INSERT INTO reminders (user_id, deal_id, contact_id, trigger_type, sequence_number, scheduled_at, status)
       VALUES ($1, $2, $3, 'no_reply_from_lead', 1, $4, 'scheduled')`,
      [userId, dealId, contactId, new Date(tenDaysAgo.getTime() + 3 * 24 * 60 * 60 * 1000)]
    );

    await evaluateAllDeals();

    const seqs = (await pool.query(
      `SELECT sequence_number FROM reminders WHERE trigger_type = 'no_reply_from_lead' ORDER BY sequence_number`
    )).rows.map((r: { sequence_number: number }) => r.sequence_number);

    expect(seqs).toContain(2);
    // Must not skip ahead more than one step per cycle
    expect(seqs.filter((s: number) => s === 2)).toHaveLength(1);
    expect(seqs).not.toContain(3);
  });
});

describe('no_reply_from_founder trigger', () => {
  let evaluateAllDeals: typeof import('../../services/reminder-engine').evaluateAllDeals;

  beforeAll(async () => {
    const engine = await import('../../services/reminder-engine');
    evaluateAllDeals = engine.evaluateAllDeals;
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM reminders');
    await pool.query('DELETE FROM deals');
    await pool.query('DELETE FROM contacts');
    await pool.query('DELETE FROM users');
    await pool.query('DELETE FROM vacation_mode');
  });

  test('creates reminder when contact replied 5h ago, founder has not responded since', async () => {
    const { userId, contactId } = await seed();
    await seedDeal(userId, contactId, {
      last_contact_reply_at: new Date(Date.now() - 5 * 60 * 60 * 1000),
      last_founder_message_at: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });

    await evaluateAllDeals();

    const rows = await pool.query(`SELECT * FROM reminders WHERE trigger_type = 'no_reply_from_founder'`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].sequence_number).toBe(1);
  });

  test('skips users in vacation mode', async () => {
    const { userId, contactId } = await seed();
    await seedDeal(userId, contactId, {
      last_contact_reply_at: new Date(Date.now() - 5 * 60 * 60 * 1000),
      last_founder_message_at: null,
    });

    await pool.query(
      `INSERT INTO vacation_mode (user_id, is_active, activated_at, updated_at) VALUES ($1, TRUE, NOW(), NOW())`,
      [userId]
    );

    await evaluateAllDeals();

    const rows = await pool.query(`SELECT * FROM reminders`);
    expect(rows.rows).toHaveLength(0);
  });
});

describe('proposal_no_activity trigger', () => {
  let evaluateAllDeals: typeof import('../../services/reminder-engine').evaluateAllDeals;

  beforeAll(async () => {
    const engine = await import('../../services/reminder-engine');
    evaluateAllDeals = engine.evaluateAllDeals;
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM reminders');
    await pool.query('DELETE FROM deals');
    await pool.query('DELETE FROM contacts');
    await pool.query('DELETE FROM users');
    await pool.query('DELETE FROM vacation_mode');
  });

  test('creates reminder for PROPOSAL_SENT deals silent 6+ days', async () => {
    const { userId, contactId } = await seed();
    await seedDeal(userId, contactId, {
      stage: 'PROPOSAL_SENT',
      last_activity: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
    });

    await evaluateAllDeals();

    const rows = await pool.query(`SELECT * FROM reminders WHERE trigger_type = 'proposal_no_activity'`);
    expect(rows.rows).toHaveLength(1);
  });

  test('does NOT create for non-PROPOSAL_SENT stages', async () => {
    const { userId, contactId } = await seed();
    await seedDeal(userId, contactId, {
      stage: 'INTERESTED',
      last_activity: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
    });

    await evaluateAllDeals();

    const rows = await pool.query(`SELECT * FROM reminders WHERE trigger_type = 'proposal_no_activity'`);
    expect(rows.rows).toHaveLength(0);
  });
});
