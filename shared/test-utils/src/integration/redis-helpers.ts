/**
 * Redis Test Helpers
 *
 * Utilities for interacting with Redis in integration tests.
 */

import Redis from 'ioredis';
import * as fs from 'fs';
import * as path from 'path';
import { getErrorMessage } from '@arbitrage/core/resilience';

/**
 * Get Redis URL, reading directly from config file if available.
 * This is called at runtime (not module load time) to ensure we get the correct URL.
 */
export function getTestRedisUrl(): string {
  // Try to read from config file (written by jest.globalSetup.ts)
  const configFile = path.resolve(__dirname, '../../../../.redis-test-config.json');

  if (fs.existsSync(configFile)) {
    try {
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (config.url) {
        return config.url;
      }
    } catch {
      // Fall through to env vars
    }
  }

  // Fall back to environment variable or default
  return process.env.REDIS_URL || 'redis://localhost:6379';
}

/**
 * Create a new Redis client for testing.
 * Includes enhanced error messages for easier debugging of connection failures.
 */
export async function createTestRedisClient(): Promise<Redis> {
  const url = getTestRedisUrl();
  const redis = new Redis(url, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });

  try {
    await redis.connect();
  } catch (error) {
    // Add URL context to connection errors for easier debugging
    const originalMessage = getErrorMessage(error);
    throw new Error(`Failed to connect to Redis at ${url}: ${originalMessage}`);
  }

  return redis;
}

/**
 * Flush all data from test Redis
 */
export async function flushTestRedis(redis: Redis): Promise<void> {
  await redis.flushall();
}

/**
 * Wait for a message on a Redis stream with exponential backoff
 *
 * @param redis - Redis client
 * @param stream - Stream name to watch
 * @param timeoutMs - Timeout in milliseconds
 * @returns The message data or null if timeout
 */
export async function waitForStreamMessage(
  redis: Redis,
  stream: string,
  timeoutMs: number = 5000
): Promise<Record<string, string> | null> {
  const startTime = Date.now();
  let pollInterval = 10; // Start with 10ms, exponential backoff

  while (Date.now() - startTime < timeoutMs) {
    const result = await redis.xread('COUNT', 1, 'STREAMS', stream, '0');

    if (result && result.length > 0) {
      const [, messages] = result[0];
      if (messages.length > 0) {
        const [, fields] = messages[0];
        const data: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) {
          data[fields[i]] = fields[i + 1];
        }
        return data;
      }
    }

    // Exponential backoff: 10ms -> 20ms -> 40ms -> 80ms (max 100ms)
    await new Promise(resolve => setTimeout(resolve, pollInterval));
    pollInterval = Math.min(pollInterval * 2, 100);
  }

  return null;
}

/**
 * Publish a message to a Redis stream
 */
export async function publishToStream(
  redis: Redis,
  stream: string,
  data: Record<string, string | number>
): Promise<string> {
  const fields: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    fields.push(key, String(value));
  }
  const result = await redis.xadd(stream, '*', ...fields);
  if (!result) {
    throw new Error(`Failed to publish to stream ${stream}`);
  }
  return result;
}

/**
 * Set up Redis lifecycle hooks for integration tests.
 *
 * Call at the top of a `describe` block. Returns a getter for the Redis client
 * (available after `beforeAll` runs). Registers:
 * - `beforeAll`: create client via {@link createTestRedisClient}
 * - `afterAll`: quit client
 * - `beforeEach`: flushall (guarded by `status === 'ready'`)
 *
 * @example
 * describe('my suite', () => {
 *   const getRedis = setupRedisTestLifecycle();
 *
 *   it('works', async () => {
 *     const redis = getRedis();
 *     await redis.set('k', 'v');
 *   });
 * });
 */
export function setupRedisTestLifecycle(): () => Redis {
  let redis: Redis;

  beforeAll(async () => {
    redis = await createTestRedisClient();
  });

  afterAll(async () => {
    if (redis) {
      await redis.quit();
    }
  });

  beforeEach(async () => {
    if (redis?.status === 'ready') {
      await redis.flushall();
    }
  });

  return () => redis;
}

/**
 * Create a consumer group for a stream (idempotent)
 */
export async function ensureConsumerGroup(
  redis: Redis,
  stream: string,
  group: string
): Promise<void> {
  try {
    await redis.xgroup('CREATE', stream, group, '0', 'MKSTREAM');
  } catch (error: unknown) {
    // Ignore "BUSYGROUP" error (group already exists)
    const errorMessage = getErrorMessage(error);
    if (!errorMessage.includes('BUSYGROUP')) {
      throw error;
    }
  }
  // Explicit return for void function
}
