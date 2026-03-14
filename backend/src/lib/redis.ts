/**
 * Redis configuration module.
 *
 * Exports two things:
 *
 *   redis          — standalone IORedis client for general use
 *   redisConnection — plain options object for BullMQ (BullMQ bundles its own
 *                     ioredis internally, so we cannot pass an external Redis
 *                     instance without a type conflict)
 *
 * Both read REDIS_URL from env (Railway sets this automatically when a Redis
 * plugin is attached). Local dev falls back to redis://localhost:6379.
 */

import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

// ── Parse URL into a BullMQ-compatible options object ────────────────────────

function parseRedisUrl(rawUrl: string): {
  host: string;
  port: number;
  password?: string;
  username?: string;
  tls?: object;
} {
  const url = new URL(rawUrl);
  return {
    host:     url.hostname,
    port:     parseInt(url.port || '6379', 10),
    password: url.password ? decodeURIComponent(url.password) : undefined,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    // rediss:// scheme → TLS required (Railway private network uses plain redis://)
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

/** Plain options object — pass this to BullMQ Queue / Worker as `connection`. */
export const redisConnection = parseRedisUrl(REDIS_URL);

// ── Standalone IORedis client ─────────────────────────────────────────────────

function createRedis(): Redis {
  const client = new Redis(REDIS_URL, {
    lazyConnect:         true,   // don't crash before app.listen() if Redis is down
    maxRetriesPerRequest: null,  // BullMQ requirement if this client is ever reused there
    enableReadyCheck:    false,
    retryStrategy(attempt: number) {
      if (attempt > 20) {
        console.error(`Redis: gave up after ${attempt} retries`);
        return null;
      }
      const delay = Math.min(100 * 2 ** attempt, 10_000);
      console.warn(`Redis: retry attempt ${attempt}, waiting ${delay}ms`);
      return delay;
    },
  });

  const safeUrl = REDIS_URL.replace(/:\/\/[^@]+@/, '://<redacted>@');
  client.on('connect',     () => console.log(`Redis connected successfully (${safeUrl})`));
  client.on('error',  (err: Error) => console.error('Redis error:', err.message));
  client.on('reconnecting', () => console.warn('Redis: reconnecting…'));

  return client;
}

const redis = createRedis();
export default redis;
