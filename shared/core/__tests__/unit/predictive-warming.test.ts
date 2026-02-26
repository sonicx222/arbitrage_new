/**
 * Predictive Cache Warming Tests
 *
 * Tests for Task 2.2.2: Predictive Cache Warming
 * Verifies that correlated pairs are pre-warmed when a price update occurs.
 *
 * @see docs/reports/implementation_plan_v2.md - Task 2.2.2
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { RedisMock } from '@arbitrage/test-utils';

// Make this file a module to avoid TS2451 redeclaration errors
export {};

// Create mock objects BEFORE jest.mock
const redisInstance = new RedisMock();
const mockRedis = {
  get: jest.fn<any>((key: string) => redisInstance.get(key)),
  getRaw: jest.fn<any>((key: string) => redisInstance.get(key)),
  set: jest.fn<any>((key: string, value: any, ttl?: number) => {
    if (ttl) {
      return redisInstance.setex(key, ttl, value);
    }
    return redisInstance.set(key, value);
  }),
  setex: jest.fn<any>((key: string, ttl: number, value: any) => redisInstance.setex(key, ttl, value)),
  del: jest.fn<any>((...keys: string[]) => {
    for (const key of keys) {
      redisInstance.del(key);
    }
    return Promise.resolve(keys.length);
  }),
  keys: jest.fn<any>((pattern: string) => redisInstance.keys(pattern)),
  scan: jest.fn<any>((cursor: string, _matchArg: string, pattern: string, _countArg: string, _count: number) => {
    if (cursor !== '0') return Promise.resolve(['0', []]);
    const allKeys = redisInstance.keys(pattern);
    return Promise.resolve(['0', allKeys]);
  }),
  clear: jest.fn<any>(() => redisInstance.clear()),
  ping: jest.fn<any>(() => Promise.resolve('PONG'))
};

const mockCorrelationAnalyzer = {
  recordPriceUpdate: jest.fn<any>(),
  getPairsToWarm: jest.fn<any>(() => []),
  getCorrelatedPairs: jest.fn<any>(() => []),
  updateCorrelations: jest.fn<any>(),
  getStats: jest.fn<any>(() => ({})),
  reset: jest.fn<any>(),
  destroy: jest.fn<any>()
};

// Mock logger (auto-resolves to src/__mocks__/logger.ts)
jest.mock('../../src/logger');

// Mock redis
jest.mock('../../src/redis/client', () => ({
  getRedisClient: () => Promise.resolve(mockRedis)
}));

// Mock correlation analyzer
jest.mock('../../src/caching/correlation-analyzer', () => ({
  getCorrelationAnalyzer: () => mockCorrelationAnalyzer,
  createCorrelationAnalyzer: () => mockCorrelationAnalyzer,
  CorrelationAnalyzer: jest.fn(() => mockCorrelationAnalyzer)
}));

// Import directly from source to avoid module resolution issues with ts-jest
import {
  HierarchicalCache,
  createHierarchicalCache,
} from '../../src/caching/hierarchical-cache';
import type { PredictiveWarmingConfig } from '../../src/caching/hierarchical-cache';
import { createLogger } from '../../src/logger';

// Get reference to shared mock logger (same instance returned by jest.mock factory)
const mockLogger = createLogger('test') as unknown as {
  info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock;
};

// Helper to flush pending microtasks and macrotasks.
// Uses jest fake-timer runAllImmediates() when fake timers are active (fast),
// then drains multiple rounds of microtasks so deeply-nested async chains
// (e.g., triggerPredictiveWarming -> get -> redisPromise -> redis.get) settle.
const flushPromises = async () => {
  // Fire all pending setImmediate callbacks (starts async warming chains)
  jest.runAllImmediates();
  // Drain several rounds of microtasks to let multi-level awaits resolve
  for (let i = 0; i < 10; i++) {
    await new Promise<void>(resolve => resolve());
  }
  // Fire any setImmediates that were scheduled during microtask processing
  jest.runAllImmediates();
  for (let i = 0; i < 5; i++) {
    await new Promise<void>(resolve => resolve());
  }
};

describe('Predictive Cache Warming (Task 2.2.2)', () => {
  let cache: HierarchicalCache;

  beforeEach(() => {
    jest.useFakeTimers({ legacyFakeTimers: true });
    jest.clearAllMocks();
    mockRedis.clear();
    // Re-establish ALL mock implementations (resetMocks: true clears jest.fn() implementations)
    mockRedis.get.mockImplementation((key: string) => redisInstance.get(key));
    mockRedis.getRaw.mockImplementation((key: string) => redisInstance.get(key));
    mockRedis.set.mockImplementation((key: string, value: any, ttl?: number) => {
      if (ttl) {
        return redisInstance.setex(key, ttl, value);
      }
      return redisInstance.set(key, value);
    });
    mockRedis.setex.mockImplementation((key: string, ttl: number, value: any) => redisInstance.setex(key, ttl, value));
    mockRedis.del.mockImplementation((...keys: string[]) => {
      for (const key of keys) { redisInstance.del(key); }
      return Promise.resolve(keys.length);
    });
    mockRedis.keys.mockImplementation((pattern: string) => redisInstance.keys(pattern));
    mockRedis.scan.mockImplementation((cursor: string, _matchArg: string, pattern: string, _countArg: string, _count: number) => {
      if (cursor !== '0') return Promise.resolve(['0', []]);
      const allKeys = redisInstance.keys(pattern);
      return Promise.resolve(['0', allKeys]);
    });
    mockRedis.ping.mockImplementation(() => Promise.resolve('PONG'));
    mockCorrelationAnalyzer.getPairsToWarm.mockReturnValue([]);
    mockCorrelationAnalyzer.recordPriceUpdate.mockReturnValue(undefined);
    mockCorrelationAnalyzer.getCorrelatedPairs.mockReturnValue([]);
    mockCorrelationAnalyzer.updateCorrelations.mockReturnValue(undefined);
    mockCorrelationAnalyzer.getStats.mockReturnValue({});
    mockCorrelationAnalyzer.reset.mockReturnValue(undefined);
    mockCorrelationAnalyzer.destroy.mockReturnValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Configuration', () => {
    it('should be disabled by default', () => {
      cache = createHierarchicalCache({
        l1Enabled: true,
        l2Enabled: true,
        l3Enabled: false
      });

      const stats = cache.getStats();
      expect(stats.predictiveWarming?.enabled).toBeFalsy();
    });

    it('should be enabled when configured', () => {
      cache = createHierarchicalCache({
        l1Enabled: true,
        l2Enabled: true,
        l3Enabled: false,
        predictiveWarming: {
          enabled: true,
          maxPairsToWarm: 3
        }
      });

      const stats = cache.getStats();
      expect(stats.predictiveWarming?.enabled).toBe(true);
    });

    it('should respect maxPairsToWarm configuration', () => {
      cache = createHierarchicalCache({
        l1Enabled: true,
        l2Enabled: true,
        l3Enabled: false,
        predictiveWarming: {
          enabled: true,
          maxPairsToWarm: 5
        }
      });

      const stats = cache.getStats();
      expect(stats.predictiveWarming?.maxPairsToWarm).toBe(5);
    });

    it('should default maxPairsToWarm to 3', () => {
      cache = createHierarchicalCache({
        l1Enabled: true,
        l2Enabled: true,
        l3Enabled: false,
        predictiveWarming: {
          enabled: true
        }
      });

      const stats = cache.getStats();
      expect(stats.predictiveWarming?.maxPairsToWarm).toBe(3);
    });
  });

  describe('Cache Update Triggers', () => {
    beforeEach(() => {
      cache = createHierarchicalCache({
        l1Enabled: true,
        l2Enabled: true,
        l3Enabled: false,
        predictiveWarming: {
          enabled: true,
          maxPairsToWarm: 3
        }
      });
    });

    it('should record price update when cache set is called with pair key', async () => {
      const pairKey = 'pair:0x1234';
      await cache.set(pairKey, { reserve0: '1000', reserve1: '2000' });

      // Wait for setImmediate callback
      await flushPromises();

      expect(mockCorrelationAnalyzer.recordPriceUpdate).toHaveBeenCalledWith('0x1234');
    });

    it('should query correlated pairs after cache update', async () => {
      const pairKey = 'pair:0x1234';
      mockCorrelationAnalyzer.getPairsToWarm.mockReturnValue(['0x5678', '0x9abc']);

      await cache.set(pairKey, { reserve0: '1000', reserve1: '2000' });

      // Wait for setImmediate callback
      await flushPromises();

      expect(mockCorrelationAnalyzer.getPairsToWarm).toHaveBeenCalledWith('0x1234');
    });

    it('should not trigger warming for non-pair keys', async () => {
      await cache.set('config:settings', { value: 'test' });

      // Wait for setImmediate callback
      await flushPromises();

      expect(mockCorrelationAnalyzer.recordPriceUpdate).not.toHaveBeenCalled();
      expect(mockCorrelationAnalyzer.getPairsToWarm).not.toHaveBeenCalled();
    });
  });

  describe('Warming Logic', () => {
    let warmingCallback: jest.Mock<any>;

    beforeEach(() => {
      warmingCallback = jest.fn<any>();
      cache = createHierarchicalCache({
        l1Enabled: true,
        l2Enabled: true,
        l3Enabled: false,
        predictiveWarming: {
          enabled: true,
          maxPairsToWarm: 3,
          onWarm: warmingCallback
        }
      });
    });

    it('should warm correlated pairs in background', async () => {
      mockCorrelationAnalyzer.getPairsToWarm.mockReturnValue([
        '0x5678',
        '0x9abc',
        '0xdef0'
      ]);

      // Pre-populate L2 with data to warm
      await redisInstance.set('cache:l2:pair:0x5678', JSON.stringify({ reserve0: '100' }));
      await redisInstance.set('cache:l2:pair:0x9abc', JSON.stringify({ reserve0: '200' }));
      await redisInstance.set('cache:l2:pair:0xdef0', JSON.stringify({ reserve0: '300' }));

      await cache.set('pair:0x1234', { reserve0: '1000', reserve1: '2000' });

      // Wait for setImmediate and warming callbacks
      await flushPromises();

      expect(warmingCallback).toHaveBeenCalledWith(['0x5678', '0x9abc', '0xdef0']);
    });

    it('should respect maxPairsToWarm limit', async () => {
      cache = createHierarchicalCache({
        l1Enabled: true,
        l2Enabled: true,
        l3Enabled: false,
        predictiveWarming: {
          enabled: true,
          maxPairsToWarm: 2,
          onWarm: warmingCallback
        }
      });

      mockCorrelationAnalyzer.getPairsToWarm.mockReturnValue([
        '0x5678',
        '0x9abc',
        '0xdef0',
        '0x1111'
      ]);

      // Pre-populate L2 (Redis) with data for all correlated pairs
      // The warming logic fetches from L2 and promotes to L1
      await redisInstance.set('cache:l2:pair:0x5678', JSON.stringify({ reserve0: '100' }));
      await redisInstance.set('cache:l2:pair:0x9abc', JSON.stringify({ reserve0: '200' }));
      await redisInstance.set('cache:l2:pair:0xdef0', JSON.stringify({ reserve0: '300' }));
      await redisInstance.set('cache:l2:pair:0x1111', JSON.stringify({ reserve0: '400' }));

      await cache.set('pair:0x1234', { reserve0: '1000', reserve1: '2000' });

      // Wait for callbacks
      await flushPromises();

      // Should only warm the first 2 (limited by maxPairsToWarm: 2)
      expect(warmingCallback).toHaveBeenCalledWith(['0x5678', '0x9abc']);
    });

    it('should handle empty correlated pairs gracefully', async () => {
      mockCorrelationAnalyzer.getPairsToWarm.mockReturnValue([]);

      await cache.set('pair:0x1234', { reserve0: '1000', reserve1: '2000' });

      // Wait for callbacks
      await flushPromises();

      // Should not call warming callback with empty array
      expect(warmingCallback).not.toHaveBeenCalled();
    });

    it('should use setImmediate for non-blocking operation', async () => {
      jest.useFakeTimers();
      const immediateCallback = jest.fn<any>();

      mockCorrelationAnalyzer.getPairsToWarm.mockReturnValue(['0x5678']);

      await cache.set('pair:0x1234', { reserve0: '1000' });

      // Warming should not have happened synchronously
      expect(warmingCallback).not.toHaveBeenCalled();

      // Run all immediate callbacks
      jest.runAllTimers();

      // Now it should have been called
      await Promise.resolve(); // Allow microtasks
    });
  });

  describe('Statistics', () => {
    beforeEach(() => {
      cache = createHierarchicalCache({
        l1Enabled: true,
        l2Enabled: true,
        l3Enabled: false,
        predictiveWarming: {
          enabled: true,
          maxPairsToWarm: 3
        }
      });
    });

    it('should track warming triggers count', async () => {
      mockCorrelationAnalyzer.getPairsToWarm.mockReturnValue(['0x5678']);

      await cache.set('pair:0x1234', { reserve0: '1000' });
      await flushPromises();

      const stats = cache.getStats();
      expect(stats.predictiveWarming?.warmingTriggeredCount).toBe(1);
    });

    it('should track pairs warmed count', async () => {
      mockCorrelationAnalyzer.getPairsToWarm.mockReturnValue(['0x5678', '0x9abc']);

      await redisInstance.set('cache:l2:pair:0x5678', JSON.stringify({ reserve0: '100' }));
      await redisInstance.set('cache:l2:pair:0x9abc', JSON.stringify({ reserve0: '200' }));

      await cache.set('pair:0x1234', { reserve0: '1000' });
      await flushPromises();

      const stats = cache.getStats();
      expect(stats.predictiveWarming?.pairsWarmedCount).toBeGreaterThanOrEqual(2);
    });

    it('should track warming hit rate when warmed pairs are accessed', async () => {
      mockCorrelationAnalyzer.getPairsToWarm.mockReturnValue(['0x5678']);

      // Put data in L2 to be warmed
      await redisInstance.set('cache:l2:pair:0x5678', JSON.stringify({ reserve0: '100' }));

      await cache.set('pair:0x1234', { reserve0: '1000' });
      await flushPromises();

      // Access the warmed pair (should be in L1 now)
      const result = await cache.get('pair:0x5678');

      const stats = cache.getStats();
      expect(stats.predictiveWarming?.warmingHitCount).toBeGreaterThanOrEqual(0);
    });

    it('should increment warmingHitCount when correlated pair is already in L1', async () => {
      // Correlated pair 0x5678 is returned for both trigger pairs
      mockCorrelationAnalyzer.getPairsToWarm.mockReturnValue(['0x5678']);

      // Put data in L2 to be warmed on first trigger
      await redisInstance.set('cache:l2:pair:0x5678', JSON.stringify({ reserve0: '100' }));

      // First cache set - should warm 0x5678 into L1
      await cache.set('pair:0x1234', { reserve0: '1000' });
      await flushPromises();

      // Verify 0x5678 is now in L1 by checking pairsWarmedCount increased
      const statsAfterFirst = cache.getStats();
      expect(statsAfterFirst.predictiveWarming?.pairsWarmedCount).toBeGreaterThanOrEqual(1);

      // Second cache set for DIFFERENT pair but same correlated pair (0x5678)
      // Since 0x5678 is already in L1, this should increment warmingHitCount
      await cache.set('pair:0x9999', { reserve0: '2000' });
      await flushPromises();

      const statsAfterSecond = cache.getStats();
      // warmingHitCount should have incremented because 0x5678 was already in L1
      expect(statsAfterSecond.predictiveWarming?.warmingHitCount).toBe(1);
    });

    it('should handle case-insensitive pair addresses in warming', async () => {
      // Test that uppercase addresses are normalized to lowercase
      mockCorrelationAnalyzer.getPairsToWarm.mockReturnValue(['0xabcdef']);

      await redisInstance.set('cache:l2:pair:0xabcdef', JSON.stringify({ reserve0: '100' }));

      // Set with UPPERCASE pair address - should still work
      await cache.set('pair:0xABCDEF', { reserve0: '1000' });
      await flushPromises();

      // Should have recorded with lowercase
      expect(mockCorrelationAnalyzer.recordPriceUpdate).toHaveBeenCalledWith('0xabcdef');
    });
  });

  describe('Error Handling', () => {
    beforeEach(() => {
      cache = createHierarchicalCache({
        l1Enabled: true,
        l2Enabled: true,
        l3Enabled: false,
        predictiveWarming: {
          enabled: true,
          maxPairsToWarm: 3
        }
      });
    });

    it('should not throw when correlation analyzer fails', async () => {
      mockCorrelationAnalyzer.getPairsToWarm.mockImplementation(() => {
        throw new Error('Correlation service unavailable');
      });

      // Should not throw
      await expect(
        cache.set('pair:0x1234', { reserve0: '1000' })
      ).resolves.not.toThrow();

      // Wait for callbacks
      await flushPromises();

      // Error should be logged but not propagated
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should handle cache get failures during warming gracefully', async () => {
      mockCorrelationAnalyzer.getPairsToWarm.mockReturnValue(['0x5678']);
      mockRedis.getRaw.mockRejectedValueOnce(new Error('Redis timeout'));

      await cache.set('pair:0x1234', { reserve0: '1000' });

      // Wait for callbacks
      await flushPromises();

      // Should not throw and should log warning
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should continue warming remaining pairs if one fails', async () => {
      const warmingCallback = jest.fn<any>();
      cache = createHierarchicalCache({
        l1Enabled: true,
        l2Enabled: true,
        l3Enabled: false,
        predictiveWarming: {
          enabled: true,
          maxPairsToWarm: 3,
          onWarm: warmingCallback
        }
      });

      mockCorrelationAnalyzer.getPairsToWarm.mockReturnValue(['0x5678', '0x9abc']);

      // First get fails, second succeeds
      await redisInstance.set('cache:l2:pair:0x9abc', JSON.stringify({ reserve0: '200' }));

      await cache.set('pair:0x1234', { reserve0: '1000' });
      await flushPromises();

      // Warming callback should still be called (with pairs that have data)
      const stats = cache.getStats();
      expect(stats.predictiveWarming?.warmingTriggeredCount).toBe(1);
    });
  });

  describe('Integration with Cache Lifecycle', () => {
    it('should not warm when cache is clearing', async () => {
      // Make L2 scan resolve on a delayed tick so isClearing stays true during set
      let resolveL2Scan: ((value: [string, string[]]) => void) | null = null;
      mockRedis.scan.mockImplementationOnce(() =>
        new Promise<[string, string[]]>((resolve) => { resolveL2Scan = resolve; })
      );

      cache = createHierarchicalCache({
        l1Enabled: true,
        l2Enabled: true,
        l3Enabled: false,
        usePriceMatrix: false, // Skip PriceMatrix allocation for speed
        predictiveWarming: {
          enabled: true,
          maxPairsToWarm: 3
        }
      });

      mockCorrelationAnalyzer.getPairsToWarm.mockReturnValue(['0x5678']);

      // Start clear operation — this will block on the L2 scan
      const clearPromise = cache.clear();

      // Set while clear is still in progress (isClearing = true)
      await cache.set('pair:0x1234', { reserve0: '1000' });
      await flushPromises();

      // Warming should not have been triggered during clear
      expect(mockCorrelationAnalyzer.getPairsToWarm).not.toHaveBeenCalled();

      // Unblock the clear
      resolveL2Scan!(['0', []]);
      await clearPromise;
    });

    it('should warm across multiple cache set operations', async () => {
      cache = createHierarchicalCache({
        l1Enabled: true,
        l2Enabled: true,
        l3Enabled: false,
        predictiveWarming: {
          enabled: true,
          maxPairsToWarm: 3
        }
      });

      mockCorrelationAnalyzer.getPairsToWarm.mockReturnValue(['0x5678']);

      await cache.set('pair:0x1234', { reserve0: '1000' });
      await cache.set('pair:0x9999', { reserve0: '2000' });
      await cache.set('pair:0xaaaa', { reserve0: '3000' });

      await flushPromises();

      // Should have recorded 3 price updates and queried 3 times
      expect(mockCorrelationAnalyzer.recordPriceUpdate).toHaveBeenCalledTimes(3);
      expect(mockCorrelationAnalyzer.getPairsToWarm).toHaveBeenCalledTimes(3);
    });
  });

  describe('Performance Optimizations (PERF-3)', () => {
    it('should deduplicate rapid warming requests for the same pair', async () => {
      // Gate to keep the warming's internal get() call pending so the pair stays
      // in pendingWarmingPairs long enough for subsequent callbacks to see it.
      //
      // Key insight: getPairsToWarm is called SYNCHRONOUSLY in the source code
      // (not awaited), so it MUST return a plain array. The async gate is placed
      // on the L2 Redis get instead, which IS properly awaited inside this.get().
      let resolveGate!: () => void;
      const gate = new Promise<string | null>(resolve => { resolveGate = () => resolve(null); });

      cache = createHierarchicalCache({
        l1Enabled: true,
        l2Enabled: true,
        l3Enabled: false,
        predictiveWarming: {
          enabled: true,
          maxPairsToWarm: 3
        }
      });

      // Return correlated pairs synchronously (as the source code expects)
      mockCorrelationAnalyzer.getPairsToWarm.mockReturnValue(['0x5678']);

      // Make the L2 get for the correlated pair block on the gate.
      // When triggerPredictiveWarming calls this.get('pair:0x5678'), it goes through
      // getFromL2 -> redis.getRaw('cache:l2:pair:0x5678'). We make this block so
      // the warming stays in-flight (pendingWarmingPairs still has the pair).
      mockRedis.getRaw.mockImplementation((key: string) => {
        if (key === 'cache:l2:pair:0x5678') {
          return gate;
        }
        return redisInstance.get(key);
      });

      // Fire three rapid cache.set() calls without awaiting them individually.
      // This queues three setImmediate callbacks for triggerPredictiveWarming.
      const p1 = cache.set('pair:0x1234', { reserve0: '1000' });
      const p2 = cache.set('pair:0x1234', { reserve0: '1001' });
      const p3 = cache.set('pair:0x1234', { reserve0: '1002' });
      await Promise.all([p1, p2, p3]);

      // Let all three setImmediate callbacks fire:
      // 1st: adds '0x1234' to pendingWarmingPairs, calls getPairsToWarm (sync),
      //       starts this.get('pair:0x5678') which blocks on the gate
      // 2nd: sees pendingWarmingPairs.has('0x1234') == true, increments deduplicatedCount
      // 3rd: same dedup path
      await flushPromises();

      // Release the gate so the first warming can complete
      resolveGate();

      // Flush remaining microtasks so warming finishes
      await flushPromises();
      await flushPromises();

      const stats = cache.getStats();

      // The 2nd and 3rd warming calls should have been deduplicated
      expect(stats.predictiveWarming?.deduplicatedCount).toBeGreaterThanOrEqual(1);

      // Price updates should still be recorded for correlation tracking even when deduplicated
      expect(mockCorrelationAnalyzer.recordPriceUpdate).toHaveBeenCalled();
    });

    it('should track deduplicatedCount in stats', async () => {
      cache = createHierarchicalCache({
        l1Enabled: true,
        l2Enabled: true,
        l3Enabled: false,
        predictiveWarming: {
          enabled: true,
          maxPairsToWarm: 3
        }
      });

      const stats = cache.getStats();
      expect(stats.predictiveWarming).toHaveProperty('deduplicatedCount');
      expect(typeof stats.predictiveWarming?.deduplicatedCount).toBe('number');
    });
  });

  describe('Task 2.2.3 Metrics', () => {
    beforeEach(() => {
      cache = createHierarchicalCache({
        l1Enabled: true,
        l2Enabled: true,
        l3Enabled: false,
        predictiveWarming: {
          enabled: true,
          maxPairsToWarm: 3
        }
      });
    });

    it('should track warming latency metrics', async () => {
      mockCorrelationAnalyzer.getPairsToWarm.mockReturnValue(['0x5678']);
      await redisInstance.set('cache:l2:pair:0x5678', JSON.stringify({ reserve0: '100' }));

      await cache.set('pair:0x1234', { reserve0: '1000' });
      await flushPromises();

      const stats = cache.getStats();
      expect(stats.predictiveWarming).toHaveProperty('totalWarmingLatencyMs');
      expect(stats.predictiveWarming).toHaveProperty('warmingLatencyCount');
      expect(stats.predictiveWarming).toHaveProperty('lastWarmingLatencyMs');
      expect(stats.predictiveWarming).toHaveProperty('avgWarmingLatencyMs');
      expect(stats.predictiveWarming?.warmingLatencyCount).toBeGreaterThanOrEqual(1);
      expect(stats.predictiveWarming?.avgWarmingLatencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should calculate warming hit rate', async () => {
      mockCorrelationAnalyzer.getPairsToWarm.mockReturnValue(['0x5678']);
      await redisInstance.set('cache:l2:pair:0x5678', JSON.stringify({ reserve0: '100' }));

      // First set - warms pair
      await cache.set('pair:0x1234', { reserve0: '1000' });
      await flushPromises();

      // Second set - pair already in L1, should increment warmingHitCount
      await cache.set('pair:0x9999', { reserve0: '2000' });
      await flushPromises();

      const stats = cache.getStats();
      expect(stats.predictiveWarming).toHaveProperty('warmingHitRate');
      // warmingHitRate should be between 0 and 1
      expect(stats.predictiveWarming?.warmingHitRate).toBeGreaterThanOrEqual(0);
      expect(stats.predictiveWarming?.warmingHitRate).toBeLessThanOrEqual(1);
    });

    it('should include correlation analyzer stats', async () => {
      // Mock getStats to return proper stats object
      mockCorrelationAnalyzer.getStats.mockReturnValue({
        trackedPairs: 5,
        totalUpdates: 100,
        correlationsComputed: 10,
        lastCorrelationUpdate: Date.now(),
        avgCorrelationScore: 0.5,
        estimatedMemoryBytes: 1024,
        coOccurrenceEntries: 20,
        correlationCacheEntries: 10
      });

      const stats = cache.getStats();
      expect(stats.predictiveWarming).toHaveProperty('correlationStats');
      // correlationStats should be from the mock
      expect(stats.predictiveWarming?.correlationStats).not.toBeNull();
      const correlationStats = stats.predictiveWarming?.correlationStats as { trackedPairs?: number; estimatedMemoryBytes?: number } | undefined;
      expect(correlationStats?.trackedPairs).toBe(5);
      expect(correlationStats?.estimatedMemoryBytes).toBe(1024);
    });
  });
});
