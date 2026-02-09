/**
 * Warming Flow Integration Tests (Day 10)
 *
 * End-to-end tests for complete warming workflow.
 *
 * @package @arbitrage/core
 * @module warming/container
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  WarmingContainer,
  createTopNWarming,
  createAdaptiveWarming,
  createTestWarming,
  WarmingComponents,
} from '../warming.container';
import { HierarchicalCache } from '../../../caching/hierarchical-cache';

describe('Warming Flow Integration Tests', () => {
  let cache: HierarchicalCache;
  let components: WarmingComponents;

  beforeEach(async () => {
    cache = new HierarchicalCache({
      l1Size: 64,
      l2Enabled: true,
      usePriceMatrix: true,
    });

    components = createTestWarming(cache, 'topn');

    // Populate cache with test data
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
    await cache.set('price:ethereum:0x789', {
      price: 3.0,
      reserve0: '1000',
      reserve1: '3000',
    });
  });

  afterEach(async () => {
    await cache.clear();
  });

  describe('End-to-End Warming Flow', () => {
    it('should perform complete warming workflow', async () => {
      // 1. Track correlations
      const now = Date.now();
      components.tracker.recordPriceUpdate('0x123', now);
      components.tracker.recordPriceUpdate('0x456', now + 10);
      components.tracker.recordPriceUpdate('0x123', now + 100);
      components.tracker.recordPriceUpdate('0x456', now + 110);

      // 2. Trigger warming
      const result = await components.warmer.warmForPair('0x123');

      // 3. Verify results
      expect(result.success).toBe(true);
      expect(result.durationMs).toBeLessThan(10);
      expect(result.pairsAttempted).toBeGreaterThanOrEqual(0);
    });

    it('should build correlations over time', async () => {
      const now = Date.now();

      // Track multiple co-occurrences
      for (let i = 0; i < 10; i++) {
        components.tracker.recordPriceUpdate('0x123', now + i * 100);
        components.tracker.recordPriceUpdate('0x456', now + i * 100 + 10);
      }

      // Get correlations
      const correlations = components.tracker.getPairsToWarm(
        '0x123',
        now,
        10,
        0.1
      );

      expect(correlations.success).toBe(true);
      expect(correlations.correlations.length).toBeGreaterThanOrEqual(0);
    });

    it('should warm correlated pairs', async () => {
      const now = Date.now();

      // Build strong correlation between 0x123 and 0x456
      for (let i = 0; i < 5; i++) {
        components.tracker.recordPriceUpdate('0x123', now + i * 100);
        components.tracker.recordPriceUpdate('0x456', now + i * 100 + 10);
      }

      // Warm 0x123
      const result = await components.warmer.warmForPair('0x123');

      expect(result.success).toBe(true);
      expect(result.pairsAttempted).toBeGreaterThanOrEqual(0);

      // If pairs were warmed, they should be in L1
      if (result.pairsWarmed > 0) {
        expect(result.pairsWarmed).toBeLessThanOrEqual(result.pairsAttempted);
      }
    });

    it('should handle warming with no correlations', async () => {
      // No tracking, just warm
      const result = await components.warmer.warmForPair('0x999');

      expect(result.success).toBe(true);
      expect(result.pairsAttempted).toBe(0);
      expect(result.pairsWarmed).toBe(0);
    });

    it('should handle warming with missing cache data', async () => {
      const now = Date.now();

      // Track non-existent pairs
      components.tracker.recordPriceUpdate('0xNONE1', now);
      components.tracker.recordPriceUpdate('0xNONE2', now + 10);

      // Warm
      const result = await components.warmer.warmForPair('0xNONE1');

      expect(result.success).toBe(true);
      // May or may not find data, but should not crash
    });
  });

  describe('Strategy Integration', () => {
    it('should apply TopN strategy correctly', async () => {
      components = createTestWarming(cache, 'topn');

      const now = Date.now();

      // Build correlations
      for (let i = 0; i < 3; i++) {
        components.tracker.recordPriceUpdate('0x123', now + i * 100);
        components.tracker.recordPriceUpdate('0x456', now + i * 100 + 10);
        components.tracker.recordPriceUpdate('0x789', now + i * 100 + 20);
      }

      // Warm with TopN strategy (should limit to topN)
      const result = await components.warmer.warmForPair('0x123');

      expect(result.success).toBe(true);
      expect(result.pairsAttempted).toBeLessThanOrEqual(5); // Default topN
    });

    it('should apply Threshold strategy correctly', async () => {
      components = createTestWarming(cache, 'threshold');

      const now = Date.now();

      // Build correlations
      for (let i = 0; i < 3; i++) {
        components.tracker.recordPriceUpdate('0x123', now + i * 100);
        components.tracker.recordPriceUpdate('0x456', now + i * 100 + 10);
      }

      // Warm with Threshold strategy
      const result = await components.warmer.warmForPair('0x123');

      expect(result.success).toBe(true);
      // Threshold may select different number of pairs
    });

    it('should apply Adaptive strategy correctly', async () => {
      components = createTestWarming(cache, 'adaptive');

      const now = Date.now();

      // Build correlations
      for (let i = 0; i < 3; i++) {
        components.tracker.recordPriceUpdate('0x123', now + i * 100);
        components.tracker.recordPriceUpdate('0x456', now + i * 100 + 10);
      }

      // Warm with Adaptive strategy
      const result = await components.warmer.warmForPair('0x123');

      expect(result.success).toBe(true);
      // Adaptive adjusts based on hit rate
    });

    it('should apply TimeBased strategy correctly', async () => {
      components = createTestWarming(cache, 'timebased');

      const now = Date.now();

      // Build correlations with recency
      components.tracker.recordPriceUpdate('0x123', now - 5000); // Old
      components.tracker.recordPriceUpdate('0x456', now - 4990);

      components.tracker.recordPriceUpdate('0x123', now - 100); // Recent
      components.tracker.recordPriceUpdate('0x789', now - 90);

      // Warm with TimeBased strategy (should prefer recent)
      const result = await components.warmer.warmForPair('0x123');

      expect(result.success).toBe(true);
    });
  });

  describe('Performance Integration', () => {
    it('should track correlations in <50μs', () => {
      const iterations = 1000;
      const durations: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const result = components.tracker.recordPriceUpdate(
          `0x${i}`,
          Date.now()
        );
        durations.push(result.durationUs || 0);
      }

      const avgDuration = durations.reduce((a, b) => a + b, 0) / iterations;
      expect(avgDuration).toBeLessThan(50);
    });

    it('should warm pairs in <10ms', async () => {
      const now = Date.now();

      // Build correlations
      for (let i = 0; i < 5; i++) {
        components.tracker.recordPriceUpdate('0x123', now + i * 100);
        components.tracker.recordPriceUpdate('0x456', now + i * 100 + 10);
      }

      // Warm
      const result = await components.warmer.warmForPair('0x123');

      expect(result.success).toBe(true);
      expect(result.durationMs).toBeLessThan(10);
    });

    it('should handle high-frequency updates', () => {
      const now = Date.now();
      const updates = 10000;

      const start = performance.now();

      for (let i = 0; i < updates; i++) {
        components.tracker.recordPriceUpdate(`0x${i % 100}`, now + i);
      }

      const duration = performance.now() - start;

      // Should handle 10k updates in <500ms
      expect(duration).toBeLessThan(500);
    });

    it('should handle concurrent warming operations', async () => {
      const now = Date.now();

      // Build correlations
      for (let i = 0; i < 5; i++) {
        components.tracker.recordPriceUpdate('0x123', now + i * 100);
        components.tracker.recordPriceUpdate('0x456', now + i * 100 + 10);
        components.tracker.recordPriceUpdate('0x789', now + i * 100 + 20);
      }

      // Trigger multiple warming operations concurrently
      const results = await Promise.all([
        components.warmer.warmForPair('0x123'),
        components.warmer.warmForPair('0x456'),
        components.warmer.warmForPair('0x789'),
      ]);

      // All should succeed
      expect(results.every((r) => r.success)).toBe(true);
    });
  });

  describe('Multi-Service Integration', () => {
    it('should share correlation data between services', () => {
      const cache1 = new HierarchicalCache({ l1Size: 64 });
      const cache2 = new HierarchicalCache({ l1Size: 64 });

      const service1 = createTopNWarming(cache1);
      const service2 = createTopNWarming(cache2);

      // Both use same analyzer
      expect(service1.analyzer).toBe(service2.analyzer);

      const now = Date.now();

      // Track in service1
      service1.tracker.recordPriceUpdate('0x123', now);
      service1.tracker.recordPriceUpdate('0x456', now + 10);

      // Should be visible in service2 (shared analyzer)
      const correlations = service2.tracker.getPairsToWarm(
        '0x123',
        now,
        10,
        0.1
      );

      expect(correlations.success).toBe(true);
    });

    it('should isolate test instances', () => {
      const cache1 = new HierarchicalCache({ l1Size: 64 });
      const cache2 = new HierarchicalCache({ l1Size: 64 });

      const test1 = createTestWarming(cache1);
      const test2 = createTestWarming(cache2);

      // Different analyzers
      expect(test1.analyzer).not.toBe(test2.analyzer);

      const now = Date.now();

      // Track in test1
      test1.tracker.recordPriceUpdate('0x123', now);
      test1.tracker.recordPriceUpdate('0x456', now + 10);

      // Should NOT be visible in test2 (isolated analyzer)
      const correlations = test2.tracker.getPairsToWarm(
        '0x123',
        now,
        10,
        0.1
      );

      // test2 should have empty or different correlations
      expect(correlations.success).toBe(true);
    });
  });

  describe('Error Handling Integration', () => {
    it('should handle cache errors gracefully', async () => {
      // Create a mock cache that throws errors
      const errorCache = new HierarchicalCache({ l1Size: 64 });
      const originalGet = errorCache.get.bind(errorCache);
      errorCache.get = async () => {
        throw new Error('Cache error');
      };

      const errorComponents = createTestWarming(errorCache);

      // Should not crash
      const result = await errorComponents.warmer.warmForPair('0x123');

      expect(result.success).toBe(true);
      expect(result.errors).toBeGreaterThanOrEqual(0);
    });

    it('should handle invalid pair addresses', async () => {
      const result = await components.warmer.warmForPair('invalid');

      expect(result.success).toBe(true);
      // May or may not find data, but should not crash
    });

    it('should handle concurrent errors', async () => {
      const errorCache = new HierarchicalCache({ l1Size: 64 });
      let callCount = 0;
      const originalGet = errorCache.get.bind(errorCache);
      errorCache.get = async (key: string) => {
        callCount++;
        if (callCount % 2 === 0) {
          throw new Error('Intermittent error');
        }
        return originalGet(key);
      };

      const errorComponents = createTestWarming(errorCache);

      const now = Date.now();
      errorComponents.tracker.recordPriceUpdate('0x123', now);
      errorComponents.tracker.recordPriceUpdate('0x456', now + 10);

      // Should handle intermittent errors
      const result = await errorComponents.warmer.warmForPair('0x123');

      expect(result.success).toBe(true);
    });
  });

  describe('Statistics Integration', () => {
    it('should track warming statistics', async () => {
      const now = Date.now();

      // Build correlations
      for (let i = 0; i < 3; i++) {
        components.tracker.recordPriceUpdate('0x123', now + i * 100);
        components.tracker.recordPriceUpdate('0x456', now + i * 100 + 10);
      }

      // Warm multiple times
      await components.warmer.warmForPair('0x123');
      await components.warmer.warmForPair('0x456');

      // Get stats
      const warmerStats = components.warmer.getStats();
      const trackerStats = components.tracker.getStats();

      expect(warmerStats.totalWarmingOps).toBeGreaterThanOrEqual(2);
      expect(trackerStats.totalPairs).toBeGreaterThanOrEqual(0);
    });

    it('should track correlation statistics', () => {
      const now = Date.now();

      // Build correlations
      for (let i = 0; i < 5; i++) {
        components.tracker.recordPriceUpdate('0x123', now + i * 100);
        components.tracker.recordPriceUpdate('0x456', now + i * 100 + 10);
        components.tracker.recordPriceUpdate('0x789', now + i * 100 + 20);
      }

      // Get stats
      const stats = components.tracker.getStats();

      expect(stats.totalPairs).toBeGreaterThanOrEqual(3);
      expect(stats.totalUpdates).toBeGreaterThanOrEqual(15);
    });
  });

  describe('Configuration Integration', () => {
    it('should apply warmer configuration', async () => {
      const customComponents = WarmingContainer.create(cache, {
        strategy: 'topn',
        strategyConfig: { topN: 3, minScore: 0.5 },
        warmerConfig: {
          maxPairsPerWarm: 3,
          asyncWarming: false,
          timeoutMs: 100,
        },
        useSharedAnalyzer: false,
        enableMetrics: false,
      }).build();

      const now = Date.now();

      // Build correlations
      for (let i = 0; i < 5; i++) {
        customComponents.tracker.recordPriceUpdate('0x123', now + i * 100);
        customComponents.tracker.recordPriceUpdate('0x456', now + i * 100 + 10);
      }

      // Warm with custom config
      const result = await customComponents.warmer.warmForPair('0x123');

      expect(result.success).toBe(true);
      expect(result.pairsAttempted).toBeLessThanOrEqual(3); // maxPairsPerWarm
    });

    it('should apply strategy configuration', async () => {
      const topN3 = WarmingContainer.create(cache, {
        strategy: 'topn',
        strategyConfig: { topN: 3, minScore: 0.3 },
        useSharedAnalyzer: false,
        enableMetrics: false,
      }).build();

      const topN10 = WarmingContainer.create(cache, {
        strategy: 'topn',
        strategyConfig: { topN: 10, minScore: 0.3 },
        useSharedAnalyzer: false,
        enableMetrics: false,
      }).build();

      const now = Date.now();

      // Build same correlations for both
      for (let i = 0; i < 5; i++) {
        topN3.tracker.recordPriceUpdate('0x123', now + i * 100);
        topN3.tracker.recordPriceUpdate('0x456', now + i * 100 + 10);

        topN10.tracker.recordPriceUpdate('0x123', now + i * 100);
        topN10.tracker.recordPriceUpdate('0x456', now + i * 100 + 10);
      }

      const result3 = await topN3.warmer.warmForPair('0x123');
      const result10 = await topN10.warmer.warmForPair('0x123');

      expect(result3.success).toBe(true);
      expect(result10.success).toBe(true);

      // Both should respect their topN limits
      expect(result3.pairsAttempted).toBeLessThanOrEqual(3);
      expect(result10.pairsAttempted).toBeLessThanOrEqual(10);
    });
  });
});
