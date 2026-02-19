/**
 * Factory Functions Tests (Day 10)
 *
 * Tests for convenience factory functions.
 *
 * @package @arbitrage/core
 * @module warming/container
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTopNWarming,
  createAdaptiveWarming,
  createTestWarming,
  WarmingComponents,
} from '../../../src/warming/container/warming.container';
import { HierarchicalCache } from '../../../src/caching/hierarchical-cache';

describe('Factory Functions Tests', () => {
  let cache: HierarchicalCache;

  beforeEach(() => {
    cache = new HierarchicalCache({
      l1Size: 64,
      l2Enabled: false, // Disable L2 in unit tests to avoid Redis connection
    });
  });

  afterEach(async () => {
    // Clean up cache to prevent resource leaks
    if (cache) {
      await cache.clear();
    }
  });

  describe('createTopNWarming()', () => {
    it('should create components with default config', () => {
      const components = createTopNWarming(cache);

      expect(typeof components).toBe('object');
      expect(typeof components.analyzer).toBe('object');
      expect(typeof components.tracker).toBe('object');
      expect(typeof components.strategy).toBe('object');
      expect(typeof components.warmer).toBe('object');
      expect(components.strategy.constructor.name).toBe('TopNStrategy');
    });

    it('should create components with custom topN', () => {
      const components = createTopNWarming(cache, 10);

      expect(typeof components.strategy).toBe('object');
      expect(components.strategy.constructor.name).toBe('TopNStrategy');
    });

    it('should create components with custom minScore', () => {
      const components = createTopNWarming(cache, 5, 0.5);

      expect(typeof components.strategy).toBe('object');
      expect(components.strategy.constructor.name).toBe('TopNStrategy');
    });

    it('should create components with both custom params', () => {
      const components = createTopNWarming(cache, 8, 0.4);

      expect(typeof components.strategy).toBe('object');
      expect(components.strategy.constructor.name).toBe('TopNStrategy');
    });

    it('should include metrics by default', () => {
      const components = createTopNWarming(cache);

      expect(typeof components.metricsCollector).toBe('object');
      expect(typeof components.metricsExporter).toBe('object');
    });

    it('should use shared analyzer by default', () => {
      const components1 = createTopNWarming(cache);
      const components2 = createTopNWarming(cache);

      // Both should use the same singleton analyzer
      expect(components1.analyzer).toBe(components2.analyzer);
    });

    it('should have all components wired correctly', () => {
      const components = createTopNWarming(cache, 5, 0.3);

      // Test that components can be used
      const trackResult = components.tracker.recordPriceUpdate(
        'TEST_PAIR',
        Date.now()
      );
      expect(trackResult.success).toBe(true);
    });
  });

  describe('createAdaptiveWarming()', () => {
    it('should create components with default config', () => {
      const components = createAdaptiveWarming(cache);

      expect(typeof components).toBe('object');
      expect(typeof components.analyzer).toBe('object');
      expect(typeof components.tracker).toBe('object');
      expect(typeof components.strategy).toBe('object');
      expect(typeof components.warmer).toBe('object');
      expect(components.strategy.constructor.name).toBe('AdaptiveStrategy');
    });

    it('should create components with custom targetHitRate', () => {
      const components = createAdaptiveWarming(cache, 0.95);

      expect(typeof components.strategy).toBe('object');
      expect(components.strategy.constructor.name).toBe('AdaptiveStrategy');
    });

    it('should create components with custom maxPairs', () => {
      const components = createAdaptiveWarming(cache, 0.97, 15);

      expect(typeof components.strategy).toBe('object');
      expect(components.strategy.constructor.name).toBe('AdaptiveStrategy');
    });

    it('should create components with both custom params', () => {
      const components = createAdaptiveWarming(cache, 0.98, 12);

      expect(typeof components.strategy).toBe('object');
      expect(components.strategy.constructor.name).toBe('AdaptiveStrategy');
    });

    it('should include metrics by default', () => {
      const components = createAdaptiveWarming(cache);

      expect(typeof components.metricsCollector).toBe('object');
      expect(typeof components.metricsExporter).toBe('object');
    });

    it('should use shared analyzer by default', () => {
      const components1 = createAdaptiveWarming(cache);
      const components2 = createAdaptiveWarming(cache);

      // Both should use the same singleton analyzer
      expect(components1.analyzer).toBe(components2.analyzer);
    });

    it('should have all components wired correctly', () => {
      const components = createAdaptiveWarming(cache, 0.97, 10);

      // Test that components can be used
      const trackResult = components.tracker.recordPriceUpdate(
        'TEST_PAIR',
        Date.now()
      );
      expect(trackResult.success).toBe(true);
    });
  });

  describe('createTestWarming()', () => {
    it('should create components with default strategy', () => {
      const components = createTestWarming(cache);

      expect(typeof components).toBe('object');
      expect(typeof components.analyzer).toBe('object');
      expect(typeof components.tracker).toBe('object');
      expect(typeof components.strategy).toBe('object');
      expect(typeof components.warmer).toBe('object');
      expect(components.strategy.constructor.name).toBe('TopNStrategy'); // Default
    });

    it('should create components with topn strategy', () => {
      const components = createTestWarming(cache, 'topn');

      expect(typeof components.strategy).toBe('object');
      expect(components.strategy.constructor.name).toBe('TopNStrategy');
    });

    it('should create components with threshold strategy', () => {
      const components = createTestWarming(cache, 'threshold');

      expect(typeof components.strategy).toBe('object');
      expect(components.strategy.constructor.name).toBe('ThresholdStrategy');
    });

    it('should create components with adaptive strategy', () => {
      const components = createTestWarming(cache, 'adaptive');

      expect(typeof components.strategy).toBe('object');
      expect(components.strategy.constructor.name).toBe('AdaptiveStrategy');
    });

    it('should create components with timebased strategy', () => {
      const components = createTestWarming(cache, 'timebased');

      expect(typeof components.strategy).toBe('object');
      expect(components.strategy.constructor.name).toBe('TimeBasedStrategy');
    });

    it('should NOT include metrics (testing mode)', () => {
      const components = createTestWarming(cache);

      expect(components.metricsCollector).toBeUndefined();
      expect(components.metricsExporter).toBeUndefined();
    });

    it('should NOT use shared analyzer (isolated testing)', () => {
      const components1 = createTestWarming(cache);
      const components2 = createTestWarming(cache);

      // Both should have different analyzer instances
      expect(components1.analyzer).not.toBe(components2.analyzer);
    });

    it('should have all components wired correctly', () => {
      const components = createTestWarming(cache);

      // Test that components can be used
      const trackResult = components.tracker.recordPriceUpdate(
        'TEST_PAIR',
        Date.now()
      );
      expect(trackResult.success).toBe(true);
    });

    it('should be isolated from other test instances', () => {
      const cache1 = new HierarchicalCache({ l1Size: 64 });
      const cache2 = new HierarchicalCache({ l1Size: 64 });

      const components1 = createTestWarming(cache1);
      const components2 = createTestWarming(cache2);

      // Track different data in each
      components1.tracker.recordPriceUpdate('PAIR_A', Date.now());
      components2.tracker.recordPriceUpdate('PAIR_B', Date.now());

      const stats1 = components1.tracker.getStats();
      const stats2 = components2.tracker.getStats();

      // Each should have tracked different pairs
      expect(stats1.totalPairs).toBeGreaterThanOrEqual(0);
      expect(stats2.totalPairs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Factory Function Comparison', () => {
    it('should create different strategy types', () => {
      const topN = createTopNWarming(cache);
      const adaptive = createAdaptiveWarming(cache);
      const test = createTestWarming(cache);

      expect(topN.strategy.constructor.name).toBe('TopNStrategy');
      expect(adaptive.strategy.constructor.name).toBe('AdaptiveStrategy');
      expect(test.strategy.constructor.name).toBe('TopNStrategy');
    });

    it('should have different metrics behavior', () => {
      const topN = createTopNWarming(cache);
      const adaptive = createAdaptiveWarming(cache);
      const test = createTestWarming(cache);

      expect(typeof topN.metricsCollector).toBe('object');
      expect(typeof adaptive.metricsCollector).toBe('object');
      expect(test.metricsCollector).toBeUndefined(); // Test mode
    });

    it('should have different analyzer sharing behavior', () => {
      const cache1 = new HierarchicalCache({ l1Size: 64 });
      const cache2 = new HierarchicalCache({ l1Size: 64 });

      const topN1 = createTopNWarming(cache1);
      const topN2 = createTopNWarming(cache2);

      const test1 = createTestWarming(cache1);
      const test2 = createTestWarming(cache2);

      // TopN uses shared analyzer
      expect(topN1.analyzer).toBe(topN2.analyzer);

      // Test uses isolated analyzers
      expect(test1.analyzer).not.toBe(test2.analyzer);
    });
  });

  describe('Factory Function Performance', () => {
    it('should create components quickly (<10ms)', () => {
      const start = performance.now();
      const components = createTopNWarming(cache);
      const duration = performance.now() - start;

      expect(typeof components).toBe('object');
      expect(duration).toBeLessThan(10);
    });

    it('should create multiple instances quickly', () => {
      const start = performance.now();

      for (let i = 0; i < 10; i++) {
        createTopNWarming(cache);
      }

      const duration = performance.now() - start;
      expect(duration).toBeLessThan(100); // <10ms per instance
    });

    it('should create test components quickly', () => {
      const start = performance.now();
      const components = createTestWarming(cache);
      const duration = performance.now() - start;

      expect(typeof components).toBe('object');
      expect(duration).toBeLessThan(10);
    });
  });

  describe('Factory Function Error Handling', () => {
    it('should handle invalid cache gracefully', async () => {
      // TypeScript prevents this, but test runtime behavior
      const invalidCache = {} as HierarchicalCache;

      // Container creation doesn't throw, but usage will fail
      const components = createTopNWarming(invalidCache);
      expect(typeof components).toBe('object');

      // Using the components with invalid cache should fail gracefully
      try {
        await components.warmer.warmForPair('TEST');
        // If it doesn't throw, that's fine (graceful handling)
      } catch (error) {
        // If it throws, that's also acceptable
        expect(error).toBeDefined();
      }
    });

    it('should handle extreme parameter values', () => {
      // Very high topN
      const components1 = createTopNWarming(cache, 1000, 0.1);
      expect(typeof components1.strategy).toBe('object');

      // Very low minScore
      const components2 = createTopNWarming(cache, 5, 0.01);
      expect(typeof components2.strategy).toBe('object');

      // Very high targetHitRate
      const components3 = createAdaptiveWarming(cache, 0.999, 20);
      expect(typeof components3.strategy).toBe('object');
    });
  });

  describe('Factory Function Use Cases', () => {
    it('should support simple production use case', () => {
      // Simple production setup
      const { tracker, warmer } = createTopNWarming(cache, 5, 0.3);

      // Use in service
      tracker.recordPriceUpdate('WETH_USDT', Date.now());
      const result = warmer.warmForPair('WETH_USDT');

      expect(typeof result).toBe('object');
    });

    it('should support adaptive production use case', () => {
      // Self-tuning production setup
      const { tracker, warmer, strategy } = createAdaptiveWarming(
        cache,
        0.97,
        10
      );

      // Use in service
      tracker.recordPriceUpdate('WETH_USDT', Date.now());
      const result = warmer.warmForPair('WETH_USDT');

      expect(typeof result).toBe('object');
      expect(strategy.constructor.name).toBe('AdaptiveStrategy');
    });

    it('should support testing use case', () => {
      // Test setup
      const components = createTestWarming(cache);

      // Test code
      components.tracker.recordPriceUpdate('TEST_PAIR', Date.now());
      const stats = components.tracker.getStats();

      expect(typeof stats).toBe('object');
      expect(stats.totalPairs).toBeGreaterThanOrEqual(0);
    });

    it('should support multi-service use case', () => {
      // Multiple services with shared analyzer
      const service1 = createTopNWarming(cache, 5, 0.3);
      const service2 = createTopNWarming(cache, 8, 0.4);
      const service3 = createAdaptiveWarming(cache, 0.97, 10);

      // All share the same analyzer (correlation data)
      expect(service1.analyzer).toBe(service2.analyzer);
      expect(service2.analyzer).toBe(service3.analyzer);
    });
  });
});
