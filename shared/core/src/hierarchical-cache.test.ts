// Hierarchical Cache Tests
import { HierarchicalCache, createHierarchicalCache } from './hierarchical-cache';
import { RedisMock } from '../../test-utils/src';

// Mock dependencies
jest.mock('./index');
import { getRedisClient } from './index';

const redisInstance = new RedisMock();
const mockRedis = {
  get: jest.fn().mockImplementation(redisInstance.get.bind(redisInstance)),
  set: jest.fn().mockImplementation(redisInstance.set.bind(redisInstance)),
  setex: jest.fn().mockImplementation(redisInstance.setex.bind(redisInstance)),
  del: jest.fn().mockImplementation(redisInstance.del.bind(redisInstance)),
  keys: jest.fn().mockImplementation(redisInstance.keys.bind(redisInstance)),
  clear: jest.fn().mockImplementation(redisInstance.clear.bind(redisInstance))
};

(getRedisClient as jest.Mock).mockReturnValue(Promise.resolve(mockRedis));

// Mock logger
jest.mock('./logger');
import { createLogger } from './logger';

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
};

(createLogger as jest.Mock).mockReturnValue(mockLogger);

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
      const result = await cache.get('nonexistent:key');
      expect(result).toBeNull();
    });

    it('should handle TTL correctly', async () => {
      const testKey = 'test:ttl';
      const testValue = { data: 'expires' };

      await cache.set(testKey, testValue, 1); // 1 second TTL

      // Immediately should exist
      let result = await cache.get(testKey);
      expect(result).toEqual(testValue);

      // Wait for expiration (mock)
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Should be expired
      result = await cache.get(testKey);
      expect(result).toBeNull();
    });

    it('should delete values', async () => {
      const testKey = 'test:delete';
      const testValue = 'to be deleted';

      await cache.set(testKey, testValue);
      expect(await cache.get(testKey)).toEqual(testValue);

      await cache.set(testKey, null); // Delete by setting to null
      expect(await cache.get(testKey)).toBeNull();
    });
  });

  describe('L1 cache (SharedArrayBuffer)', () => {
    it('should use L1 cache for fast access', async () => {
      const testKey = 'l1:test';
      const testValue = 'fast access';

      await cache.set(testKey, testValue);

      // First access should hit L1
      const result1 = await cache.get(testKey);
      expect(result1).toEqual(testValue);

      // Should not have accessed Redis for L1 hit
      expect(mockRedis.get).not.toHaveBeenCalled();
    });

    it('should promote L2 hits to L1', async () => {
      const testKey = 'promote:test';
      const testValue = 'from l2';

      // Manually set in Redis (simulating L2)
      await mockRedis.set(`cache:l2:${testKey}`, JSON.stringify(testValue));

      // First access should get from L2 and promote to L1
      const result = await cache.get(testKey);
      expect(result).toEqual(testValue);

      // Should have accessed Redis
      expect(mockRedis.get).toHaveBeenCalledWith(`cache:l2:${testKey}`);
    });
  });

  describe('L2 cache (Redis)', () => {
    beforeEach(() => {
      // Disable L1 for testing L2 isolation
      cache = createHierarchicalCache({
        l1Enabled: false,
        l2Enabled: true,
        l3Enabled: false
      });
    });

    it('should store values in Redis with TTL', async () => {
      const testKey = 'redis:test';
      const testValue = { stored: 'in redis' };

      await cache.set(testKey, testValue, 600); // 10 minutes

      const stored = await mockRedis.get(`cache:l2:${testKey}`);
      expect(JSON.parse(stored)).toEqual(testValue);
    });

    it('should retrieve values from Redis', async () => {
      const testKey = 'redis:get';
      const testValue = 'from redis';

      await mockRedis.set(`cache:l2:${testKey}`, JSON.stringify(testValue));

      const result = await cache.get(testKey);
      expect(result).toEqual(testValue);
    });
  });

  describe('L3 cache (persistent)', () => {
    beforeEach(() => {
      // Disable L1 and L2 for testing L3 isolation
      cache = createHierarchicalCache({
        l1Enabled: false,
        l2Enabled: false,
        l3Enabled: true
      });
    });

    it('should store values persistently', async () => {
      const testKey = 'persistent:test';
      const testValue = { persistent: true };

      await cache.set(testKey, testValue);

      // L3 is in-memory for this implementation, but would be persistent in production
      const result = await cache.get(testKey);
      expect(result).toEqual(testValue);
    });
  });

  describe('cache hierarchy', () => {
    it('should follow L1 -> L2 -> L3 hierarchy', async () => {
      const testKey = 'hierarchy:test';
      const l3Value = 'from l3';
      const l2Value = 'from l2';
      const l1Value = 'from l1';

      // Set in L3 (persistent)
      await cache.set(testKey, l3Value);

      // Override in L2
      await mockRedis.set(`cache:l2:${testKey}`, JSON.stringify(l2Value));

      // Override in L1
      // Note: L1 is SharedArrayBuffer, so we can't directly set it in this test
      // In real usage, L1 gets populated by promotion

      // Should get from highest level available
      const result = await cache.get(testKey);
      expect(result).toEqual(l3Value); // Falls back to L3
    });

    it('should promote data through hierarchy', async () => {
      const testKey = 'promote:test';
      const testValue = 'promoted value';

      // Set in L3
      await cache.set(testKey, testValue);

      // First access should promote to L1 (if enabled)
      await cache.get(testKey);

      // Second access should hit L1
      const result = await cache.get(testKey);
      expect(result).toEqual(testValue);
    });
  });

  describe('performance', () => {
    it('should handle concurrent operations', async () => {
      const operations = [];

      for (let i = 0; i < 10; i++) {
        operations.push(
          cache.set(`concurrent:${i}`, `value${i}`),
          cache.get(`concurrent:${i}`)
        );
      }

      const results = await Promise.all(operations);

      // Should handle all operations without errors
      expect(results.length).toBe(20); // 10 sets + 10 gets
    });

    it('should maintain performance under load', async () => {
      const startTime = Date.now();
      const operations = [];

      // Simulate high load
      for (let i = 0; i < 100; i++) {
        operations.push(cache.set(`load:${i}`, `value${i}`));
      }

      await Promise.all(operations);
      const endTime = Date.now();

      const duration = endTime - startTime;

      // Should complete within reasonable time (adjust threshold as needed)
      expect(duration).toBeLessThan(5000); // 5 seconds max
    });
  });

  describe('error handling', () => {
    it('should handle Redis connection errors gracefully', async () => {
      // Mock Redis failure
      mockRedis.get.mockRejectedValue(new Error('Redis connection failed'));

      cache = createHierarchicalCache({
        l1Enabled: false,
        l2Enabled: true,
        l3Enabled: false
      });

      const result = await cache.get('error:test');

      // Should fail gracefully and return null
      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should handle invalid JSON in cache', async () => {
      const testKey = 'invalid:json';

      // Set invalid JSON in Redis
      await mockRedis.set(`cache:l2:${testKey}`, 'invalid json');

      cache = createHierarchicalCache({
        l1Enabled: false,
        l2Enabled: true,
        l3Enabled: false
      });

      const result = await cache.get(testKey);

      // Should handle error gracefully
      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should validate input parameters', async () => {
      // Invalid key
      expect(await cache.get('')).toBeNull();

      // Null key
      expect(await cache.get(null as any)).toBeNull();

      // Valid operations should still work
      await cache.set('valid:key', 'valid value');
      const result = await cache.get('valid:key');
      expect(result).toEqual('valid value');
    });
  });

  describe('cleanup and maintenance', () => {
    it('should clean up expired entries', async () => {
      const expiredKey = 'expired:key';
      const validKey = 'valid:key';

      // Set expired entry (TTL = -1 to simulate expiration)
      await cache.set(expiredKey, 'expired', -1);
      await cache.set(validKey, 'valid', 3600); // 1 hour

      // Trigger cleanup (in real implementation this would be periodic)
      // For testing, we manually call internal cleanup
      await (cache as any).cleanup();

      // Expired entry should be removed
      const expiredResult = await cache.get(expiredKey);
      expect(expiredResult).toBeNull();

      // Valid entry should remain
      const validResult = await cache.get(validKey);
      expect(validResult).toEqual('valid');
    });

    it('should provide statistics', () => {
      const stats = (cache as any).getStats();

      expect(stats).toHaveProperty('l1');
      expect(stats).toHaveProperty('l2');
      expect(stats).toHaveProperty('l3');
      expect(stats).toHaveProperty('promotions');
      expect(stats).toHaveProperty('demotions');

      expect(typeof stats.l1.hits).toBe('number');
      expect(typeof stats.l2.misses).toBe('number');
    });
  });
});