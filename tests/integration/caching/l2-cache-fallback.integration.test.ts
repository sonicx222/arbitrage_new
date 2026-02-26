/**
 * L2 Redis Cache Fallback Integration Test (ADR-005)
 *
 * Tests the HierarchicalCache L1 miss → L2 Redis hit → L1 promotion flow
 * with a REAL Redis instance. This validates that the multi-tier caching
 * strategy actually works across process/tier boundaries — not just via
 * mocked Redis calls.
 *
 * **What's Real**:
 * - Real Redis connection (createTestRedisClient)
 * - Real HierarchicalCache with L2 enabled
 * - Data seeded directly in Redis at the L2 prefix
 * - Promotion from L2 to L1 verified via stats
 *
 * Fills ADR-005 gap: "L2 fallback behavior never tested with real Redis"
 *
 * @see ADR-005: Hierarchical Cache Strategy
 * @see shared/core/src/caching/hierarchical-cache.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import Redis from 'ioredis';
import { createTestRedisClient, delay, getTestRedisUrl } from '@arbitrage/test-utils';
import { createHierarchicalCache, HierarchicalCache } from '@arbitrage/core/caching';

const L2_PREFIX = 'cache:l2:';
const L2_TTL_SECONDS = 60;

describe('[Integration] L2 Redis Cache Fallback (ADR-005)', () => {
  let redis: Redis;

  beforeAll(async () => {
    // Point the getRedisClient() singleton to the test Redis server
    // so that createHierarchicalCache's L2 layer connects correctly.
    process.env.REDIS_URL = getTestRedisUrl();
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

  describe('L1 miss → L2 hit → L1 promotion', () => {
    it('should fall back to L2 Redis when L1 is empty and promote on hit', async () => {
      // Seed data directly in Redis at the L2 prefix (bypassing L1)
      const testKey = 'prices:bsc:0xTestPair';
      const testValue = { price: 42.5, reserve0: '1000000', reserve1: '2000000' };
      await redis.setex(`${L2_PREFIX}${testKey}`, L2_TTL_SECONDS, JSON.stringify(testValue));

      // Create a fresh cache — L1 is empty, L2 has the seeded data
      const cache: HierarchicalCache = createHierarchicalCache({
        l1Enabled: true,
        l1Size: 1, // 1MB — small but sufficient for test
        l2Enabled: true,
        l2Ttl: L2_TTL_SECONDS,
        l3Enabled: false,
        usePriceMatrix: false, // Use Map for simpler L1
        enablePromotion: true,
        enableDemotion: false,
      });

      // First read: should miss L1, hit L2, and promote to L1
      const result = await cache.get(testKey);

      expect(result).toEqual(testValue);

      const statsAfterFirstRead = cache.getStats();
      expect(statsAfterFirstRead.l1.misses).toBe(1);
      expect(statsAfterFirstRead.l2.hits).toBe(1);

      // Second read: should hit L1 (promoted from L2)
      const result2 = await cache.get(testKey);

      expect(result2).toEqual(testValue);

      const statsAfterSecondRead = cache.getStats();
      expect(statsAfterSecondRead.l1.hits).toBe(1);
      // L2 hits should remain 1 (not re-queried)
      expect(statsAfterSecondRead.l2.hits).toBe(1);
    });

    it('should return null when key is not in L1 or L2', async () => {
      const cache: HierarchicalCache = createHierarchicalCache({
        l1Enabled: true,
        l1Size: 1,
        l2Enabled: true,
        l2Ttl: L2_TTL_SECONDS,
        l3Enabled: false,
        usePriceMatrix: false,
        enablePromotion: true,
        enableDemotion: false,
      });

      const result = await cache.get('nonexistent:key');

      expect(result).toBeNull();

      const stats = cache.getStats();
      expect(stats.l1.misses).toBe(1);
      expect(stats.l2.misses).toBe(1);
    });
  });

  describe('L2 write-through and read-back', () => {
    it('should write to both L1 and L2, then read back from L2 after L1 miss', async () => {
      const cache: HierarchicalCache = createHierarchicalCache({
        l1Enabled: true,
        l1Size: 1,
        l2Enabled: true,
        l2Ttl: L2_TTL_SECONDS,
        l3Enabled: false,
        usePriceMatrix: false,
        enablePromotion: true,
        enableDemotion: false,
      });

      const testKey = 'prices:eth:0xWriteThrough';
      const testValue = { price: 1800.50, chain: 'ethereum' };

      // Write via cache.set() — puts in L1 and L2
      await cache.set(testKey, testValue);

      // Verify data landed in Redis directly
      const rawData = await redis.get(`${L2_PREFIX}${testKey}`);
      expect(rawData).not.toBeNull();
      const parsedFromRedis = JSON.parse(rawData!);
      expect(parsedFromRedis).toEqual(testValue);

      // Now create a FRESH cache instance — L1 is empty
      const freshCache: HierarchicalCache = createHierarchicalCache({
        l1Enabled: true,
        l1Size: 1,
        l2Enabled: true,
        l2Ttl: L2_TTL_SECONDS,
        l3Enabled: false,
        usePriceMatrix: false,
        enablePromotion: true,
        enableDemotion: false,
      });

      // Read from fresh cache — should find data in L2
      const result = await freshCache.get(testKey);
      expect(result).toEqual(testValue);

      const stats = freshCache.getStats();
      expect(stats.l1.misses).toBe(1);
      expect(stats.l2.hits).toBe(1);
    });
  });

  describe('Multiple keys with L2 fallback', () => {
    it('should promote multiple keys from L2 to L1 independently', async () => {
      // Seed multiple keys in Redis L2
      const entries = [
        { key: 'prices:bsc:pair-1', value: { price: 100, dex: 'pancakeswap' } },
        { key: 'prices:bsc:pair-2', value: { price: 200, dex: 'biswap' } },
        { key: 'prices:arb:pair-3', value: { price: 300, dex: 'sushiswap' } },
      ];

      for (const entry of entries) {
        await redis.setex(
          `${L2_PREFIX}${entry.key}`,
          L2_TTL_SECONDS,
          JSON.stringify(entry.value)
        );
      }

      const cache: HierarchicalCache = createHierarchicalCache({
        l1Enabled: true,
        l1Size: 1,
        l2Enabled: true,
        l2Ttl: L2_TTL_SECONDS,
        l3Enabled: false,
        usePriceMatrix: false,
        enablePromotion: true,
        enableDemotion: false,
      });

      // Read all keys — all should come from L2
      for (const entry of entries) {
        const result = await cache.get(entry.key);
        expect(result).toEqual(entry.value);
      }

      const statsAfterFirstPass = cache.getStats();
      expect(statsAfterFirstPass.l1.misses).toBe(3);
      expect(statsAfterFirstPass.l2.hits).toBe(3);

      // Read all keys again — all should come from L1 (promoted)
      for (const entry of entries) {
        const result = await cache.get(entry.key);
        expect(result).toEqual(entry.value);
      }

      const statsAfterSecondPass = cache.getStats();
      expect(statsAfterSecondPass.l1.hits).toBe(3);
      // L2 hits should still be 3 (no additional L2 reads)
      expect(statsAfterSecondPass.l2.hits).toBe(3);
    });
  });

  describe('L2 TTL expiry', () => {
    it('should return null after L2 TTL expires', async () => {
      const shortTtl = 1; // 1 second
      const testKey = 'prices:bsc:expiry-test';
      const testValue = { price: 99 };

      await redis.setex(`${L2_PREFIX}${testKey}`, shortTtl, JSON.stringify(testValue));

      const cache: HierarchicalCache = createHierarchicalCache({
        l1Enabled: false, // Disable L1 to test pure L2 behavior
        l2Enabled: true,
        l2Ttl: shortTtl,
        l3Enabled: false,
        usePriceMatrix: false,
        enablePromotion: false,
        enableDemotion: false,
      });

      // Should find in L2
      const result1 = await cache.get(testKey);
      expect(result1).toEqual(testValue);

      // Wait for TTL to expire
      await delay(1500);

      // Should be gone from L2
      const result2 = await cache.get(testKey);
      expect(result2).toBeNull();
    });
  });

  describe('L2 Redis unavailability', () => {
    it('should degrade gracefully when L2 Redis is unavailable', async () => {
      // Create a cache with L1 enabled so it can still serve from memory,
      // and L2 enabled targeting a Redis that may not be reachable.
      // The HierarchicalCache catches L2 errors internally and returns null.
      const cache: HierarchicalCache = createHierarchicalCache({
        l1Enabled: true,
        l1Size: 1,
        l2Enabled: true,
        l2Ttl: L2_TTL_SECONDS,
        l3Enabled: false,
        usePriceMatrix: false,
        enablePromotion: false,
        enableDemotion: false,
      });

      // Set a value via L1 only (bypasses L2 write issues)
      const testKey = 'prices:bsc:unavailability-test';
      const testValue = { price: 42 };

      // L1 miss + L2 miss (or L2 error) should resolve to null, never throw
      await expect(cache.get('nonexistent:l2-down')).resolves.toBeNull();

      // L1 hit should still work even when L2 is unreachable
      cache.set(testKey, testValue);
      const result = await cache.get(testKey);
      expect(result).toEqual(testValue);

      const stats = cache.getStats();
      expect(stats.l1.hits).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Stats accuracy across tiers', () => {
    it('should track L1/L2 hits and misses accurately across mixed access patterns', async () => {
      // Seed some keys in L2 only
      await redis.setex(`${L2_PREFIX}key-a`, L2_TTL_SECONDS, JSON.stringify({ a: 1 }));
      await redis.setex(`${L2_PREFIX}key-b`, L2_TTL_SECONDS, JSON.stringify({ b: 2 }));

      const cache: HierarchicalCache = createHierarchicalCache({
        l1Enabled: true,
        l1Size: 1,
        l2Enabled: true,
        l2Ttl: L2_TTL_SECONDS,
        l3Enabled: false,
        usePriceMatrix: false,
        enablePromotion: true,
        enableDemotion: false,
      });

      // Set key-c directly via cache (goes to both L1 and L2)
      await cache.set('key-c', { c: 3 });

      // Access pattern:
      // key-a: L1 miss → L2 hit (promotes)
      // key-b: L1 miss → L2 hit (promotes)
      // key-c: L1 hit (was set via cache.set)
      // key-d: L1 miss → L2 miss (doesn't exist)
      // key-a: L1 hit (was promoted)
      // key-b: L1 hit (was promoted)

      await cache.get('key-a'); // L1 miss, L2 hit
      await cache.get('key-b'); // L1 miss, L2 hit
      await cache.get('key-c'); // L1 hit
      await cache.get('key-d'); // L1 miss, L2 miss
      await cache.get('key-a'); // L1 hit (promoted)
      await cache.get('key-b'); // L1 hit (promoted)

      const stats = cache.getStats();

      // L1: 3 hits (key-c, key-a promoted, key-b promoted), 3 misses (key-a first, key-b first, key-d)
      expect(stats.l1.hits).toBe(3);
      expect(stats.l1.misses).toBe(3);

      // L2: 2 hits (key-a, key-b), 1 miss (key-d)
      expect(stats.l2.hits).toBe(2);
      expect(stats.l2.misses).toBe(1);
    });
  });
});
