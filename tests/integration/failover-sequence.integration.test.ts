/**
 * Failover Sequence Integration Tests
 *
 * Tests the COMPLETE failover sequence with real Redis:
 *   Leader acquires lock -> heartbeats -> fails -> standby detects -> standby promotes
 *
 * This fills the ADR-007 gap: the existing failover-leader-election tests cover
 * individual Redis ops (SET NX EX, Lua release), but no test exercises the actual
 * multi-coordinator failover SEQUENCE end-to-end.
 *
 * Uses short TTLs (1-2s) so tests run fast while still exercising real expiry.
 *
 * @see ADR-007: Cross-Region Failover Strategy
 * @see tests/integration/failover-leader-election.integration.test.ts (atomic ops)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import Redis from 'ioredis';
import { DistributedLockManager } from '@arbitrage/core/redis';
import { createTestRedisClient, delay } from '@arbitrage/test-utils';

// Set required environment variables BEFORE any dynamic imports
process.env.NODE_ENV = 'test';

// =============================================================================
// Helpers
// =============================================================================

const LEADER_RESOURCE = 'coordinator:leader';
const SHORT_TTL_MS = 500; // 500ms -- fast CI while still exercising real expiry
const HEALTH_KEY = 'coordinator:health';
const HEALTH_INTERVAL_MS = 500;

/** Create a DistributedLockManager wired to a real Redis client. */
function createLockManager(redis: Redis, name: string): DistributedLockManager {
  const manager = new DistributedLockManager({
    keyPrefix: 'failover-test:',
    defaultTtlMs: SHORT_TTL_MS,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  });

  // Synchronous part: patch instanceId for assertions
  (manager as any).instanceId = name;

  return manager;
}

/** Initialize a lock manager with a real Redis adapter. */
async function initManager(manager: DistributedLockManager, redis: Redis): Promise<void> {
  await manager.initialize({
    setNx: async (key: string, value: string, ttlSeconds: number) => {
      const result = await redis.set(key, value, 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    },
    get: (key: string) => redis.get(key),
    del: (key: string) => redis.del(key),
    exists: async (key: string) => (await redis.exists(key)) === 1,
    eval: async <T>(script: string, keys: string[], args: string[]) => {
      return redis.eval(script, keys.length, ...keys, ...args) as T;
    },
  } as any);
}

// =============================================================================
// Test Suite
// =============================================================================

describe('Failover Sequence Integration (ADR-007)', () => {
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
    await redis.flushall();
  });

  // ---------------------------------------------------------------------------
  // 1. Leader acquisition + standby blocked
  // ---------------------------------------------------------------------------

  it('should allow primary to acquire leader lock while standby is blocked', async () => {
    const primary = createLockManager(redis, 'primary');
    const standby = createLockManager(redis, 'standby');
    await initManager(primary, redis);
    await initManager(standby, redis);

    try {
      // Primary acquires leadership
      const primaryLock = await primary.acquireLock(LEADER_RESOURCE, { ttlMs: SHORT_TTL_MS });
      expect(primaryLock.acquired).toBe(true);

      // Standby cannot acquire while primary holds the lock
      const standbyLock = await standby.acquireLock(LEADER_RESOURCE, { ttlMs: SHORT_TTL_MS });
      expect(standbyLock.acquired).toBe(false);

      await primaryLock.release();
    } finally {
      await primary.shutdown();
      await standby.shutdown();
    }
  });

  // ---------------------------------------------------------------------------
  // 2. Leader heartbeat extends TTL
  // ---------------------------------------------------------------------------

  it('should extend leader TTL via heartbeat (lock renewal)', async () => {
    const primary = createLockManager(redis, 'primary');
    await initManager(primary, redis);

    try {
      const lock = await primary.acquireLock(LEADER_RESOURCE, { ttlMs: SHORT_TTL_MS });
      expect(lock.acquired).toBe(true);

      // Wait half the TTL, then extend
      await delay(SHORT_TTL_MS / 2);
      const extended = await lock.extend(SHORT_TTL_MS);
      expect(extended).toBe(true);

      // Verify TTL was refreshed (should be close to full TTL again)
      const ttl = await redis.pttl(`failover-test:${LEADER_RESOURCE}`);
      expect(ttl).toBeGreaterThan(SHORT_TTL_MS / 2);

      await lock.release();
    } finally {
      await primary.shutdown();
    }
  });

  // ---------------------------------------------------------------------------
  // 3. Full failover sequence: leader fails -> standby promotes
  // ---------------------------------------------------------------------------

  it('should promote standby after leader lock expires (full failover)', async () => {
    const primary = createLockManager(redis, 'primary');
    const standby = createLockManager(redis, 'standby');
    await initManager(primary, redis);
    await initManager(standby, redis);

    try {
      // Phase 1: Primary acquires leadership
      const primaryLock = await primary.acquireLock(LEADER_RESOURCE, { ttlMs: SHORT_TTL_MS });
      expect(primaryLock.acquired).toBe(true);

      // Phase 2: Simulate primary failure -- do NOT extend or release the lock.
      // Just wait for TTL to expire.
      await delay(SHORT_TTL_MS + 500);

      // Phase 3: Standby detects lock is free and promotes itself
      const standbyLock = await standby.acquireLock(LEADER_RESOURCE, { ttlMs: SHORT_TTL_MS });
      expect(standbyLock.acquired).toBe(true);

      // Verify the lock value belongs to the standby instance
      const lockValue = await redis.get(`failover-test:${LEADER_RESOURCE}`);
      expect(lockValue).toContain('standby');

      await standbyLock.release();
    } finally {
      await primary.shutdown();
      await standby.shutdown();
    }
  });

  // ---------------------------------------------------------------------------
  // 4. Standby polling with retry detects expired lock
  // ---------------------------------------------------------------------------

  it('should detect expired lock via retry polling', async () => {
    const primary = createLockManager(redis, 'primary');
    const standby = createLockManager(redis, 'standby');
    await initManager(primary, redis);
    await initManager(standby, redis);

    try {
      // Primary acquires with short TTL
      const primaryLock = await primary.acquireLock(LEADER_RESOURCE, { ttlMs: 1000 });
      expect(primaryLock.acquired).toBe(true);

      // Standby starts polling with retries -- should eventually succeed after TTL expires
      const standbyLock = await standby.acquireLock(LEADER_RESOURCE, {
        ttlMs: SHORT_TTL_MS,
        retries: 8,
        retryDelayMs: 300,
      });

      expect(standbyLock.acquired).toBe(true);

      await standbyLock.release();
    } finally {
      await primary.shutdown();
      await standby.shutdown();
    }
  });

  // ---------------------------------------------------------------------------
  // 5. Contention: two standbys compete -- only one wins
  // ---------------------------------------------------------------------------

  it('should allow only one of two competing standbys to acquire leadership', async () => {
    const primary = createLockManager(redis, 'primary');
    const standbyA = createLockManager(redis, 'standby-a');
    const standbyB = createLockManager(redis, 'standby-b');
    await initManager(primary, redis);
    await initManager(standbyA, redis);
    await initManager(standbyB, redis);

    try {
      // Primary acquires, then lock expires
      await primary.acquireLock(LEADER_RESOURCE, { ttlMs: 1000 });
      await delay(1200);

      // Both standbys race to acquire
      const [lockA, lockB] = await Promise.all([
        standbyA.acquireLock(LEADER_RESOURCE, { ttlMs: SHORT_TTL_MS }),
        standbyB.acquireLock(LEADER_RESOURCE, { ttlMs: SHORT_TTL_MS }),
      ]);

      // Exactly one should win
      const winners = [lockA.acquired, lockB.acquired].filter(Boolean);
      expect(winners).toHaveLength(1);

      // The winner's identity should be in Redis
      const lockValue = await redis.get(`failover-test:${LEADER_RESOURCE}`);
      if (lockA.acquired) {
        expect(lockValue).toContain('standby-a');
      } else {
        expect(lockValue).toContain('standby-b');
      }

      // Cleanup
      if (lockA.acquired) await lockA.release();
      if (lockB.acquired) await lockB.release();
    } finally {
      await primary.shutdown();
      await standbyA.shutdown();
      await standbyB.shutdown();
    }
  });

  // ---------------------------------------------------------------------------
  // 6. Health data staleness detection
  // ---------------------------------------------------------------------------

  it('should detect stale health data after 3x heartbeat interval', async () => {
    // Write health data with current timestamp
    const healthData = {
      instanceId: 'primary',
      state: 'running',
      timestamp: Date.now().toString(),
    };
    await redis.hset(HEALTH_KEY, healthData);

    // Verify fresh: within 3x interval
    const freshTs = parseInt((await redis.hget(HEALTH_KEY, 'timestamp')) ?? '0', 10);
    const freshAge = Date.now() - freshTs;
    expect(freshAge).toBeLessThan(HEALTH_INTERVAL_MS * 3);

    // Simulate no heartbeat updates -- wait for 3x interval
    await delay(HEALTH_INTERVAL_MS * 3 + 100);

    // Now the data is stale
    const staleTs = parseInt((await redis.hget(HEALTH_KEY, 'timestamp')) ?? '0', 10);
    const staleAge = Date.now() - staleTs;
    expect(staleAge).toBeGreaterThanOrEqual(HEALTH_INTERVAL_MS * 3);
  });

  // ---------------------------------------------------------------------------
  // 7. New leader operates after promotion
  // ---------------------------------------------------------------------------

  it('should allow new leader to perform locked operations after promotion', async () => {
    const primary = createLockManager(redis, 'primary');
    const standby = createLockManager(redis, 'standby');
    await initManager(primary, redis);
    await initManager(standby, redis);

    try {
      // Primary acquires, then "crashes" (lock expires)
      await primary.acquireLock(LEADER_RESOURCE, { ttlMs: 1000 });
      await delay(1200);

      // Standby promotes
      const lock = await standby.acquireLock(LEADER_RESOURCE, { ttlMs: SHORT_TTL_MS });
      expect(lock.acquired).toBe(true);

      // New leader performs a guarded operation using withLock on a sub-resource
      const result = await standby.withLock('execution:trade-123', async () => {
        await redis.set('trade:123:status', 'executed');
        return 'success';
      }, { ttlMs: SHORT_TTL_MS });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toBe('success');
      }

      const tradeStatus = await redis.get('trade:123:status');
      expect(tradeStatus).toBe('executed');

      await lock.release();
    } finally {
      await primary.shutdown();
      await standby.shutdown();
    }
  });
});
