/**
 * L2 Redis-Backed Warming Flow Integration Tests
 *
 * Verifies L2 (Redis) cache behavior including set/get round-trips,
 * L2 promotion on L1 miss, L1 eviction to L2, and L2 TTL expiry.
 * Requires a running Redis instance (provided by jest.globalSetup.ts).
 *
 * Extracted from warming-flow.test.ts — the L1-only tests remain as unit tests.
 *
 * @package @arbitrage/core
 * @module warming/container
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from '@jest/globals';
import { createTestWarming } from '../../src/warming/container/warming.container';
import { HierarchicalCache } from '../../src/caching/hierarchical-cache';
import { getTestRedisUrl } from '@arbitrage/test-utils/integration/redis-helpers';
import { resetRedisInstance } from '../../src/redis/client';

describe('L2 Redis-Backed Warming Flow', () => {
  jest.setTimeout(30000);

  // Manual Redis lifecycle instead of setupRedisTestLifecycle() to avoid
  // flushall() which clobbers other workers' data in parallel execution.
  let testRedis: import('ioredis').default;
  const getRedis = () => testRedis;

  /** L2 key prefix used by HierarchicalCache */
  const L2_PREFIX = 'cache:l2:';

  let savedRedisUrl: string | undefined;

  beforeAll(async () => {
    // Ensure REDIS_URL points to the test Redis server so that
    // getRedisClient() (called inside HierarchicalCache) connects
    // to the same instance as our test ioredis client.
    savedRedisUrl = process.env.REDIS_URL;
    process.env.REDIS_URL = getTestRedisUrl();

    const { createTestRedisClient: createClient } = await import(
      '@arbitrage/test-utils'
    );
    testRedis = await createClient();
  });

  afterAll(async () => {
    // Restore original REDIS_URL
    if (savedRedisUrl !== undefined) {
      process.env.REDIS_URL = savedRedisUrl;
    } else {
      delete process.env.REDIS_URL;
    }
    if (testRedis) {
      await testRedis.quit();
    }
  });

  beforeEach(async () => {
    // Clean only cache:l2:* keys (not flushall) to avoid clobbering
    // other workers' data when integration tests run in parallel.
    if (testRedis?.status === 'ready') {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await testRedis.scan(cursor, 'MATCH', `${L2_PREFIX}*`, 'COUNT', 200);
        cursor = nextCursor;
        if (keys.length > 0) {
          await testRedis.del(...keys);
        }
      } while (cursor !== '0');
    }
  });

  afterEach(async () => {
    // Reset the Redis singleton used by HierarchicalCache so each test
    // gets a fresh connection and does not leak state.
    await resetRedisInstance();
  });

  it('should round-trip data through L1 and L2', async () => {
    const cache = new HierarchicalCache({
      l1Size: 1,
      l2Enabled: true,
      l3Enabled: false,
      usePriceMatrix: false,
    });

    try {
      const key = 'price:ethereum:0xABC';
      const value = { price: 1.5, reserve0: '1000', reserve1: '1500' };

      await cache.set(key, value);

      // Verify L1 has the data (via cache.get which hits L1 first)
      const result = await cache.get(key);
      expect(result).toEqual(value);

      // Verify L2 (Redis) has the data by reading directly
      const redis = getRedis();
      const rawL2 = await redis.get(`${L2_PREFIX}${key}`);
      expect(rawL2).not.toBeNull();
      const l2Value = JSON.parse(rawL2!);
      expect(l2Value).toEqual(value);

      // Stats should reflect L1 hit
      const stats = cache.getStats();
      expect(stats.l1.hits).toBeGreaterThanOrEqual(1);
    } finally {
      await cache.clear();
    }
  });

  it('should promote L2 data to L1 on L1 miss', async () => {
    const redis = getRedis();
    const cache = new HierarchicalCache({
      l1Size: 1,
      l2Enabled: true,
      l3Enabled: false,
      usePriceMatrix: false,
    });

    try {
      const key = 'price:ethereum:0xPROMOTE';
      const value = { price: 42.0, reserve0: '500', reserve1: '21000' };

      // Write data directly into L2 (Redis) bypassing the cache,
      // so L1 has no entry for this key.
      const serialized = JSON.stringify(value);
      await redis.setex(`${L2_PREFIX}${key}`, 300, serialized);

      // Confirm L1 is empty for this key (stats show 0 entries initially)
      const statsBefore = cache.getStats();
      expect(statsBefore.l1.entries).toBe(0);

      // cache.get() should miss L1, find in L2, and promote to L1
      const result = await cache.get(key);
      expect(result).toEqual(value);

      // Verify L2 hit was recorded
      const statsAfter = cache.getStats();
      expect(statsAfter.l2.hits).toBeGreaterThanOrEqual(1);
      expect(statsAfter.l1.misses).toBeGreaterThanOrEqual(1);

      // Verify L1 now has the entry (promoted)
      expect(statsAfter.l1.entries).toBe(1);
      expect(statsAfter.promotions).toBe(0); // promotions counter tracks L3->L2 promotions; L2->L1 doesn't increment it

      // A second get should now hit L1
      const result2 = await cache.get(key);
      expect(result2).toEqual(value);
      const statsAfter2 = cache.getStats();
      expect(statsAfter2.l1.hits).toBeGreaterThanOrEqual(1);
    } finally {
      await cache.clear();
    }
  });

  it('should serve evicted L1 keys from L2', async () => {
    const cache = new HierarchicalCache({
      // Very small L1: 0.001 MB = ~1024 bytes, l1MaxEntries = floor(0.001*1024*1024/1024) = 1
      l1Size: 0.001,
      l2Enabled: true,
      l3Enabled: false,
      usePriceMatrix: false,
    });

    try {
      // Set key A - should be in both L1 and L2
      await cache.set('price:ethereum:0xA', { price: 1.0, reserve0: '100', reserve1: '100' });

      // Set key B - with l1MaxEntries=1, key A should be evicted from L1
      await cache.set('price:ethereum:0xB', { price: 2.0, reserve0: '200', reserve1: '400' });

      const stats = cache.getStats();
      // L1 should have had at least one eviction
      expect(stats.l1.evictions).toBeGreaterThanOrEqual(1);

      // Key A was evicted from L1 but should still be in L2
      const resultA = await cache.get('price:ethereum:0xA');
      expect(resultA).toEqual({ price: 1.0, reserve0: '100', reserve1: '100' });

      // Confirm it came from L2 (L2 hits should increase)
      const statsAfterGet = cache.getStats();
      expect(statsAfterGet.l2.hits).toBeGreaterThanOrEqual(1);
    } finally {
      await cache.clear();
    }
  });

  it('should return null when L2 entry has expired', async () => {
    const key = 'price:ethereum:0xEXPIRY';
    const value = { price: 99.9, reserve0: '10', reserve1: '999' };

    // Phase 1: Write data with a short TTL
    const cache = new HierarchicalCache({
      l1Size: 1,
      l2Enabled: true,
      l2Ttl: 1, // 1 second TTL
      l3Enabled: false,
      usePriceMatrix: false,
    });

    await cache.set(key, value);

    // Verify data is accessible immediately
    const immediate = await cache.get(key);
    expect(immediate).toEqual(value);

    // Wait for L2 TTL to expire (1 second + buffer)
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Phase 2: Reset the Redis singleton and create a fresh cache so L1 is empty.
    // The underlying Redis data persists (but the expired key is gone).
    await resetRedisInstance();

    const cache2 = new HierarchicalCache({
      l1Size: 1,
      l2Enabled: true,
      l2Ttl: 1,
      l3Enabled: false,
      usePriceMatrix: false,
    });

    try {
      // L1 is empty in cache2, and L2 entry has expired
      const expired = await cache2.get(key);
      expect(expired).toBeNull();

      // Verify it was an L2 miss (key expired)
      const stats = cache2.getStats();
      expect(stats.l1.misses).toBeGreaterThanOrEqual(1);
      expect(stats.l2.misses).toBeGreaterThanOrEqual(1);
    } finally {
      await cache2.clear();
    }
  });

  it('should work end-to-end with warming and L2 enabled', async () => {
    const cache = new HierarchicalCache({
      l1Size: 1,
      l2Enabled: true,
      l3Enabled: false,
      usePriceMatrix: false,
    });

    try {
      const components = createTestWarming(cache, 'topn');

      // Populate cache (writes to both L1 and L2)
      await cache.set('price:ethereum:0x123', {
        price: 1.5,
        reserve0: '1000',
        reserve1: '1500',
      });
      await cache.set('price:ethereum:0x456', {
        price: 2.0,
        reserve0: '1000',
        reserve1: '2000',
      });

      // Track correlations
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        components.tracker.recordPriceUpdate('0x123', now + i * 100);
        components.tracker.recordPriceUpdate('0x456', now + i * 100 + 10);
      }

      // Trigger warming
      const result = await components.warmer.warmForPair('0x123');

      expect(result.success).toBe(true);
      expect(result.durationMs).toBeLessThan(100);
      expect(result.pairsAttempted).toBeGreaterThanOrEqual(0);

      // Verify both keys are still accessible
      const val1 = await cache.get('price:ethereum:0x123');
      expect(val1).toEqual({ price: 1.5, reserve0: '1000', reserve1: '1500' });
      const val2 = await cache.get('price:ethereum:0x456');
      expect(val2).toEqual({ price: 2.0, reserve0: '1000', reserve1: '2000' });

      // Verify L2 has the data
      const redis = getRedis();
      const raw1 = await redis.get(`${L2_PREFIX}price:ethereum:0x123`);
      expect(raw1).not.toBeNull();
      const raw2 = await redis.get(`${L2_PREFIX}price:ethereum:0x456`);
      expect(raw2).not.toBeNull();
    } finally {
      await cache.clear();
    }
  });
});
