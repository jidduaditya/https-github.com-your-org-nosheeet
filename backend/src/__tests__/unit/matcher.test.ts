/**
 * Tests for matcher.ts — auto-tagging, primary channel recomputation,
 * and merge request creation on diverging email/phone matches.
 */

import { createTestDb, TestPool } from '../helpers/test-db';

// Use a module-level variable so the getter closure captures it
let pool: TestPool;

// jest.mock is hoisted; use a getter so pool is read lazily
jest.mock('../../db/client', () => ({
  get db() { return pool; },
}));

jest.mock('../../services/merge', () => ({
  createMergeRequest: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../jobs/queue', () => ({
  aiSummariseQueue: { add: jest.fn().mockResolvedValue(undefined) },
}));

beforeAll(async () => {
  pool = await createTestDb();
});

afterAll(() => pool.end());

async function seedUser(): Promise<string> {
  const res = await pool.query(
    `INSERT INTO users (email) VALUES ('founder@test.com') RETURNING id`
  );
  return res.rows[0].id as string;
}

describe('matchOrCreateContact', () => {
  let matchOrCreateContact: typeof import('../../services/matcher').matchOrCreateContact;
  let createMergeRequest: jest.Mock;

  beforeAll(async () => {
    const matcher = await import('../../services/matcher');
    matchOrCreateContact = matcher.matchOrCreateContact;
    const merge = await import('../../services/merge');
    createMergeRequest = merge.createMergeRequest as jest.Mock;
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM contact_channels');
    await pool.query('DELETE FROM contacts');
    await pool.query('DELETE FROM users');
    createMergeRequest.mockClear();
  });

  test('creates a new contact with untagged_lead tag when no match', async () => {
    const userId = await seedUser();
    const result = await matchOrCreateContact({
      email: 'alice@example.com',
      name: 'Alice',
      channel: 'gmail',
      userId,
    });

    expect(result.created).toBe(true);
    expect(result.contactId).toBeTruthy();

    const contact = await pool.query('SELECT * FROM contacts WHERE id = $1', [result.contactId]);
    expect(contact.rows[0].tags).toContain('untagged_lead');
    expect(contact.rows[0].email).toBe('alice@example.com');
  });

  test('returns existing contact when email matches', async () => {
    const userId = await seedUser();
    const first = await matchOrCreateContact({ email: 'bob@example.com', channel: 'gmail', userId });
    const second = await matchOrCreateContact({ email: 'bob@example.com', channel: 'whatsapp', userId });

    expect(second.created).toBe(false);
    expect(second.contactId).toBe(first.contactId);
  });

  test('returns existing contact when phone matches', async () => {
    const userId = await seedUser();
    const first = await matchOrCreateContact({ phone: '+14155550001', channel: 'whatsapp', userId });
    const second = await matchOrCreateContact({ phone: '+14155550001', channel: 'whatsapp', userId });

    expect(second.created).toBe(false);
    expect(second.contactId).toBe(first.contactId);
  });

  test('creates merge request when email and phone resolve to different contacts', async () => {
    const userId = await seedUser();

    // Pre-create two separate contacts
    await pool.query(
      `INSERT INTO contacts (user_id, email, primary_channel, source, tags)
       VALUES ($1, 'charlie@example.com', 'gmail', 'gmail', ARRAY['untagged_lead'])`,
      [userId]
    );
    await pool.query(
      `INSERT INTO contacts (user_id, phone, primary_channel, source, tags)
       VALUES ($1, '+14155550002', 'whatsapp', 'whatsapp', ARRAY['untagged_lead'])`,
      [userId]
    );

    await matchOrCreateContact({
      email: 'charlie@example.com',
      phone: '+14155550002',
      channel: 'whatsapp',
      userId,
    });

    expect(createMergeRequest).toHaveBeenCalledTimes(1);
    expect(createMergeRequest).toHaveBeenCalledWith(
      expect.objectContaining({ userId, reason: expect.stringContaining('charlie@example.com') })
    );
  });

  test('updates contact_channels on each match', async () => {
    const userId = await seedUser();
    const { contactId } = await matchOrCreateContact({ email: 'dana@example.com', channel: 'gmail', userId });
    await matchOrCreateContact({ email: 'dana@example.com', channel: 'whatsapp', userId });

    const channels = await pool.query(
      'SELECT channel FROM contact_channels WHERE contact_id = $1 ORDER BY channel',
      [contactId]
    );
    expect(channels.rows.map((r: { channel: string }) => r.channel)).toEqual(['gmail', 'whatsapp']);
  });

  test('recomputes primary_channel to most recent when 3+ channels are present', async () => {
    const userId = await seedUser();
    const { contactId } = await matchOrCreateContact({ email: 'evan@example.com', channel: 'gmail', userId });
    await matchOrCreateContact({ email: 'evan@example.com', channel: 'whatsapp', userId });
    await matchOrCreateContact({ email: 'evan@example.com', channel: 'calendar', userId });

    const contact = await pool.query('SELECT primary_channel FROM contacts WHERE id = $1', [contactId]);
    expect(contact.rows[0].primary_channel).toBe('calendar');
  });
});
