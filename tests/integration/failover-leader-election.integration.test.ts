/**
 * S4.1.5.7: Real Redis Leader Election Integration Tests
 *
 * Tests leader election using real Redis SET NX EX and Lua scripts.
 * Extracted from s4.1.5-failover-scenarios for proper integration classification.
 *
 * Covers atomic operations: SET NX EX, dual-lock prevention, Lua-based release.
 * For the full multi-step failover SEQUENCE (acquire → heartbeat → expire → promote),
 * see the companion test file.
 *
 * @see ADR-007: Cross-Region Failover Strategy
 * @see tests/integration/failover-sequence.integration.test.ts (full sequence tests)
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from '@jest/globals';
import Redis from 'ioredis';
import { createTestRedisClient } from '@arbitrage/test-utils';

// Set required environment variables BEFORE any imports
process.env.NODE_ENV = 'test';

describe('S4.1.5.7: Real Redis Leader Election', () => {
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

  it('should acquire a leader lock with SET NX EX', async () => {
    const lockKey = 'coordinator:leader:lock';
    const instanceId = 'coordinator-us-east1-test-1';
    const ttlSeconds = 30;

    // Acquire the lock
    const result = await redis.set(lockKey, instanceId, 'EX', ttlSeconds, 'NX');

    expect(result).toBe('OK');

    // Verify the lock is held
    const value = await redis.get(lockKey);
    expect(value).toBe(instanceId);

    // Verify TTL is set
    const ttl = await redis.ttl(lockKey);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(ttlSeconds);
  });

  it('should prevent two coordinators from both holding the lock', async () => {
    const lockKey = 'coordinator:leader:lock';
    const instance1 = 'coordinator-us-east1-primary';
    const instance2 = 'coordinator-us-west2-standby';
    const ttlSeconds = 30;

    // First coordinator acquires the lock
    const result1 = await redis.set(lockKey, instance1, 'EX', ttlSeconds, 'NX');
    expect(result1).toBe('OK');

    // Second coordinator attempts to acquire - should fail
    const result2 = await redis.set(lockKey, instance2, 'EX', ttlSeconds, 'NX');
    expect(result2).toBeNull();

    // Lock should still be held by first coordinator
    const holder = await redis.get(lockKey);
    expect(holder).toBe(instance1);
  });

  it('should release a lock atomically using Lua (only if owner matches)', async () => {
    const lockKey = 'coordinator:leader:lock';
    const owner = 'coordinator-us-east1-primary';
    const ttlSeconds = 30;

    // Acquire the lock
    await redis.set(lockKey, owner, 'EX', ttlSeconds, 'NX');

    // Release using atomic Lua script (same pattern as RedisClient.releaseLockIfOwned)
    const releaseScript = `
      local key = KEYS[1]
      local expected_owner = ARGV[1]
      local current_owner = redis.call('GET', key)
      if current_owner == expected_owner then
        return redis.call('DEL', key)
      end
      return 0
    `;

    // Owner releases successfully
    const released = await redis.eval(releaseScript, 1, lockKey, owner) as number;
    expect(released).toBe(1);

    // Lock should be gone
    const value = await redis.get(lockKey);
    expect(value).toBeNull();

    // Non-owner cannot release
    await redis.set(lockKey, 'new-owner', 'EX', ttlSeconds, 'NX');
    const failedRelease = await redis.eval(releaseScript, 1, lockKey, 'wrong-owner') as number;
    expect(failedRelease).toBe(0);

    // Lock should still be held by new-owner
    const holder = await redis.get(lockKey);
    expect(holder).toBe('new-owner');
  });
});
