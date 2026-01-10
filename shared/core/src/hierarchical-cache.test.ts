// Hierarchical Cache Tests
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { RedisMock } from '../../test-utils/src';

// Mock logger first
jest.mock('./logger', () => ({
  createLogger: jest.fn().mockReturnValue({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }),
  getPerformanceLogger: jest.fn().mockReturnValue({
    startTimer: jest.fn(),
    endTimer: jest.fn(),
    logEventLatency: jest.fn(),
    logArbitrageOpportunity: jest.fn(),
    logExecutionResult: jest.fn(),
    logError: jest.fn(),
    logHealthCheck: jest.fn(),
    logMetrics: jest.fn()
  })
}));

// Mock index for getRedisClient
jest.mock('./index', () => ({
  getRedisClient: jest.fn()
}));

import { getRedisClient } from './index';
import { createLogger } from './logger';
import { HierarchicalCache, createHierarchicalCache } from './hierarchical-cache';

const redisInstance = new RedisMock();
const mockRedis = {
  get: jest.fn().mockImplementation(redisInstance.get.bind(redisInstance)),
  set: jest.fn().mockImplementation(redisInstance.set.bind(redisInstance)),
  setex: jest.fn().mockImplementation(redisInstance.setex.bind(redisInstance)),
  del: jest.fn().mockImplementation(redisInstance.del.bind(redisInstance)),
  keys: jest.fn().mockImplementation(redisInstance.keys.bind(redisInstance)),
  clear: jest.fn().mockImplementation(redisInstance.clear.bind(redisInstance)),
  ping: jest.fn().mockResolvedValue('PONG')
};

(getRedisClient as jest.Mock).mockReturnValue(Promise.resolve(mockRedis));

const mockLogger = (createLogger as jest.Mock)();

describe('HierarchicalCache', () => {
  let cache: HierarchicalCache;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedis.clear();
    mockRedis.get.mockImplementation(redisInstance.get.bind(redisInstance));
    cache = createHierarchicalCache({
      l1Enabled: true,
      l1Size: 64,
      l2Enabled: true,
      l2Ttl: 300,
      l3Enabled: true,
      enablePromotion: true,
      enableDemotion: false
    });
  });

  describe('basic operations', () => {
    it('should set and get values', async () => {
      const testKey = 'test:key';
      const testValue = { data: 'test', number: 42 };

      await cache.set(testKey, testValue);
      const result = await cache.get(testKey);

      expect(result).toEqual(testValue);
    });

    it('should return null for non-existent keys', async () => {
      const result = await cache.get('non-existent');
      expect(result).toBeNull();
    });

    it('should delete values', async () => {
      const testKey = 'test:delete';
      const testValue = 'delete-me';

      await cache.set(testKey, testValue);
      await cache.delete(testKey);
      const result = await cache.get(testKey);

      expect(result).toBeNull();
    });
  });

  describe('L1 Cache (Memory)', () => {
    it('should use L1 cache when enabled', async () => {
      const testKey = 'l1:test';
      const testValue = 'l1-value';

      await cache.set(testKey, testValue);

      // Get again - should be from L1
      const result = await cache.get(testKey);
      expect(result).toEqual(testValue);

      const stats = cache.getStats();
      expect(stats.l1.hits).toBeGreaterThan(0);
    });

    it('should evict entries when L1 is full', async () => {
      // Create a cache with very small L1
      const smallCache = createHierarchicalCache({
        l1Size: 0.01, // Very small size to trigger eviction quickly
        l2Enabled: false,
        l3Enabled: false
      });

      // Fill L1 beyond capacity
      for (let i = 0; i < 100; i++) {
        await smallCache.set(`key:${i}`, { data: 'some data to take up space' + i });
      }

      const stats = smallCache.getStats();
      expect(stats.l1.evictions).toBeGreaterThan(0);
    });
  });

  describe('L2 Cache (Redis)', () => {
    it('should use L2 cache when enabled and L1 misses', async () => {
      const testKey = 'l2:test';
      const testValue = 'l2-value';

      // Set directly in Redis (mock)
      await redisInstance.set(`cache:l2:${testKey}`, JSON.stringify({
        key: testKey,
        value: testValue,
        timestamp: Date.now(),
        accessCount: 1,
        lastAccess: Date.now(),
        size: 0
      }));

      const result = await cache.get(testKey);
      expect(result).toEqual(testValue);

      const stats = cache.getStats();
      expect(stats.l1.misses).toBeGreaterThan(0);
      expect(stats.l2.hits).toBeGreaterThan(0);
    });

    it('should write through to L2', async () => {
      const testKey = 'l2:write';
      const testValue = 'write-through';

      await cache.set(testKey, testValue);

      expect(mockRedis.set).toHaveBeenCalled();
    });
  });

  describe('L3 Cache (Persistent)', () => {
    it('should use L3 cache when L1 and L2 miss', async () => {
      const testKey = 'l3:test';
      const testValue = 'l3-value';

      // Create cache with just L3
      const l3OnlyCache = createHierarchicalCache({
        l1Enabled: false,
        l2Enabled: false,
        l3Enabled: true
      });

      await l3OnlyCache.set(testKey, testValue);

      // Clear any internal state if necessary, here we just get it
      const result = await l3OnlyCache.get(testKey);
      expect(result).toEqual(testValue);

      const stats = l3OnlyCache.getStats();
      expect(stats.l3.hits).toBeGreaterThan(0);
    });
  });

  describe('Promotion and Demotion', () => {
    it('should promote data from L2 to L1 on access', async () => {
      const testKey = 'promote:test';
      const testValue = 'promote-me';

      // Set in L2 ONLY
      await redisInstance.set(`cache:l2:${testKey}`, JSON.stringify({
        key: testKey,
        value: testValue,
        timestamp: Date.now(),
        accessCount: 1,
        lastAccess: Date.now(),
        size: 0
      }));

      // Access it - should promote to L1
      await cache.get(testKey);

      const stats = cache.getStats();
      expect(stats.l2.hits).toBe(1);

      // Access again - should hit L1
      const result = await cache.get(testKey);
      expect(result).toEqual(testValue);
      expect(cache.getStats().l1.hits).toBe(1);
    });
  });

  describe('Advanced Features', () => {
    it('should respect TTL', async () => {
      const testKey = 'ttl:test';
      const testValue = 'ttl-value';

      await cache.set(testKey, testValue, 0.001); // 0.001s = 1ms TTL

      // Wait for TTL
      await new Promise(resolve => setTimeout(resolve, 10)); // Wait 10ms

      const result = await cache.get(testKey);
      expect(result).toBeNull();
    });

    it('should handle clearing the cache', async () => {
      await cache.set('k1', 'v1');
      await cache.set('k2', 'v2');

      await cache.clear();

      expect(await cache.get('k1')).toBeNull();
      expect(await cache.get('k2')).toBeNull();
    });
  });
});