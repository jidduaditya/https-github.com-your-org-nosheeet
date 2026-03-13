/**
 * Real Postgres test helper using @testcontainers/postgresql.
 *
 * createTestDb() starts a fresh postgres:15-alpine container, loads the
 * production schema, and returns a Pool whose end() also stops the container.
 * Call once per test file in beforeAll / afterAll.
 */

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';

// Pool type extended so callers can simply call pool.end() and the container
// stops alongside the pool — no second variable needed.
export type TestPool = Pool;

export async function createTestDb(): Promise<TestPool> {
  const container = await new PostgreSqlContainer('postgres:15-alpine')
    .withDatabase('nosheeet_test')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();

  const pool = new Pool({ connectionString: container.getConnectionUri() });

  // Load the production schema so tests run against the real table/type definitions.
  const schema = readFileSync(
    join(__dirname, '../../db/schema.sql'),
    'utf8'
  );
  await pool.query(schema);

  // Override end() so a single afterAll(() => pool.end()) cleans up everything.
  const originalEnd = pool.end.bind(pool);
  (pool as Pool).end = async () => {
    await originalEnd();
    await container.stop();
  };

  return pool;
}
