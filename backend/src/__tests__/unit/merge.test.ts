import { createTestDb, TestPool } from '../helpers/test-db';

let pool: TestPool;

jest.mock('../../db/client', () => ({
  get db() { return pool; },
}));
jest.mock('../../lib/whatsapp-client', () => ({
  sendAndLog: jest.fn().mockResolvedValue({ messageId: 'test-id', status: 'sent' }),
  logNotification: jest.fn().mockResolvedValue(undefined),
}));

beforeAll(async () => { pool = await createTestDb(); });
afterAll(() => pool.end());

async function seedUser(): Promise<string> {
  const res = await pool.query(
    `INSERT INTO users (email, phone) VALUES ('f@test.com', '+10000000000') RETURNING id`
  );
  return res.rows[0].id as string;
}

async function seedContact(userId: string, email?: string, phone?: string): Promise<string> {
  const res = await pool.query(
    `INSERT INTO contacts (user_id, email, phone, primary_channel, source, tags)
     VALUES ($1, $2, $3, 'manual', 'manual', '{}') RETURNING id`,
    [userId, email ?? null, phone ?? null]
  );
  return res.rows[0].id as string;
}

describe('createMergeRequest', () => {
  let createMergeRequest: typeof import('../../services/merge').createMergeRequest;

  beforeAll(async () => {
    const m = await import('../../services/merge');
    createMergeRequest = m.createMergeRequest;
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM notification_log');
    await pool.query('DELETE FROM merge_requests');
    await pool.query('DELETE FROM contacts');
    await pool.query('DELETE FROM users');
  });

  test('creates a merge request for a new pair', async () => {
    const userId = await seedUser();
    const aId = await seedContact(userId, 'x@example.com');
    const bId = await seedContact(userId, undefined, '+1222');

    await createMergeRequest({ userId, contactAId: aId, contactBId: bId, reason: 'test' });

    const result = await pool.query('SELECT * FROM merge_requests WHERE user_id = $1', [userId]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].status).toBe('pending');
  });

  test('does NOT create duplicate pending for same pair', async () => {
    const userId = await seedUser();
    const aId = await seedContact(userId, 'y@example.com');
    const bId = await seedContact(userId, undefined, '+1333');

    await createMergeRequest({ userId, contactAId: aId, contactBId: bId, reason: 'test' });
    await createMergeRequest({ userId, contactAId: aId, contactBId: bId, reason: 'test' });

    const result = await pool.query('SELECT * FROM merge_requests WHERE user_id = $1', [userId]);
    expect(result.rows).toHaveLength(1);
  });

  test('does NOT re-prompt a declined pair', async () => {
    const userId = await seedUser();
    const aId = await seedContact(userId, 'z@example.com');
    const bId = await seedContact(userId, undefined, '+1444');

    await createMergeRequest({ userId, contactAId: aId, contactBId: bId, reason: 'first' });
    await pool.query(`UPDATE merge_requests SET status = 'declined' WHERE user_id = $1`, [userId]);

    await createMergeRequest({ userId, contactAId: aId, contactBId: bId, reason: 'second' });

    const result = await pool.query('SELECT COUNT(*) as cnt FROM merge_requests WHERE user_id = $1', [userId]);
    expect(parseInt(result.rows[0].cnt, 10)).toBe(1);
  });

  test('canonical ordering: (B,A) input produces same pair as (A,B)', async () => {
    const userId = await seedUser();
    const aId = await seedContact(userId, 'ca@test.com');
    const bId = await seedContact(userId, undefined, '+1555');

    const [expectedA, expectedB] = aId < bId ? [aId, bId] : [bId, aId];

    // Call with reversed order
    await createMergeRequest({ userId, contactAId: bId, contactBId: aId, reason: 'reversed' });

    const result = await pool.query('SELECT contact_a_id, contact_b_id FROM merge_requests WHERE user_id = $1', [userId]);
    expect(result.rows[0].contact_a_id).toBe(expectedA);
    expect(result.rows[0].contact_b_id).toBe(expectedB);
  });
});

describe('declineMerge', () => {
  let declineMerge: typeof import('../../services/merge').declineMerge;

  beforeAll(async () => {
    const m = await import('../../services/merge');
    declineMerge = m.declineMerge;
  });

  test('sets status to declined', async () => {
    const userId = await seedUser();
    const aId = await seedContact(userId, 'dec@example.com');
    const bId = await seedContact(userId, undefined, '+1666');
    const [normA, normB] = aId < bId ? [aId, bId] : [bId, aId];

    const mr = await pool.query(
      `INSERT INTO merge_requests (user_id, contact_a_id, contact_b_id, match_reason)
       VALUES ($1, $2, $3, 'test') RETURNING id`,
      [userId, normA, normB]
    );

    await declineMerge(mr.rows[0].id as string, userId);

    const result = await pool.query('SELECT status FROM merge_requests WHERE id = $1', [mr.rows[0].id]);
    expect(result.rows[0].status).toBe('declined');
  });
});
