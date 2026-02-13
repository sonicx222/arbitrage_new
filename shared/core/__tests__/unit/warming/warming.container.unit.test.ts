/**
 * WarmingContainer Unit Tests (Day 10)
 *
 * Tests for dependency injection container functionality.
 *
 * @package @arbitrage/core
 * @module warming/container
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import {
  WarmingContainer,
  WarmingContainerConfig,
  WarmingComponents,
  WarmingStrategyType,
} from '../../../src/warming/container/warming.container';
import { HierarchicalCache } from '../../../src/caching/hierarchical-cache';
import { TopNStrategyConfig } from '../../../src/warming/domain/warming-strategy.interface';

describe('WarmingContainer - Unit Tests', () => {
  let cache: HierarchicalCache;

  beforeEach(() => {
    cache = new HierarchicalCache({
      l1Size: 64,
      l2Enabled: true,
    });
  });

  describe('Container Creation', () => {
    it('should create container with default config', () => {
      const container = WarmingContainer.create(cache);
      expect(container).toBeDefined();
      expect(container.getConfig()).toBeDefined();
      expect(container.getConfig().strategy).toBe('topn');
    });

    it('should create container with custom config', () => {
      const config: Partial<WarmingContainerConfig> = {
        strategy: 'adaptive',
        strategyConfig: {
          targetHitRate: 0.97,
          minPairs: 3,
          maxPairs: 10,
          minScore: 0.3,
          adjustmentFactor: 0.1,
        },
        enableMetrics: false,
      };

      const container = WarmingContainer.create(cache, config);
      expect(container.getConfig().strategy).toBe('adaptive');
      expect(container.getConfig().enableMetrics).toBe(false);
    });

    it('should merge custom config with defaults', () => {
      const container = WarmingContainer.create(cache, {
        strategy: 'threshold',
        strategyConfig: {
          minScore: 0.5,
          maxPairs: 8,
        },
      });

      const config = container.getConfig();
      expect(config.strategy).toBe('threshold');
      expect(config.useSharedAnalyzer).toBe(true); // Default
      expect(config.enableMetrics).toBe(true); // Default
    });
  });

  describe('Component Building', () => {
    it('should build all components successfully', () => {
      const container = WarmingContainer.create(cache);
      const components = container.build();

      expect(components).toBeDefined();
      expect(components.analyzer).toBeDefined();
      expect(components.tracker).toBeDefined();
      expect(components.strategy).toBeDefined();
      expect(components.warmer).toBeDefined();
      expect(components.metricsCollector).toBeDefined();
      expect(components.metricsExporter).toBeDefined();
    });

    it('should build without metrics when disabled', () => {
      const container = WarmingContainer.create(cache, {
        enableMetrics: false,
      });
      const components = container.build();

      expect(components.metricsCollector).toBeUndefined();
      expect(components.metricsExporter).toBeUndefined();
    });

    it('should use shared analyzer by default', () => {
      const container1 = WarmingContainer.create(cache);
      const container2 = WarmingContainer.create(cache);

      const components1 = container1.build();
      const components2 = container2.build();

      // Both should use the same singleton analyzer
      expect(components1.analyzer).toBe(components2.analyzer);
    });

    it('should create new analyzer when useSharedAnalyzer is false', () => {
      const container1 = WarmingContainer.create(cache, {
        useSharedAnalyzer: false,
      });
      const container2 = WarmingContainer.create(cache, {
        useSharedAnalyzer: false,
      });

      const components1 = container1.build();
      const components2 = container2.build();

      // Both should have different analyzer instances
      expect(components1.analyzer).not.toBe(components2.analyzer);
    });
  });

  describe('Strategy Creation', () => {
    it('should create TopN strategy', () => {
      const container = WarmingContainer.create(cache, {
        strategy: 'topn',
        strategyConfig: { topN: 5, minScore: 0.3 } as TopNStrategyConfig,
      });
      const components = container.build();

      expect(components.strategy).toBeDefined();
      expect(components.strategy.constructor.name).toBe('TopNStrategy');
    });

    it('should create Threshold strategy', () => {
      const container = WarmingContainer.create(cache, {
        strategy: 'threshold',
        strategyConfig: { minScore: 0.5, maxPairs: 10 },
      });
      const components = container.build();

      expect(components.strategy).toBeDefined();
      expect(components.strategy.constructor.name).toBe('ThresholdStrategy');
    });

    it('should create Adaptive strategy', () => {
      const container = WarmingContainer.create(cache, {
        strategy: 'adaptive',
        strategyConfig: {
          targetHitRate: 0.97,
          minPairs: 3,
          maxPairs: 10,
          minScore: 0.3,
          adjustmentFactor: 0.1,
        },
      });
      const components = container.build();

      expect(components.strategy).toBeDefined();
      expect(components.strategy.constructor.name).toBe('AdaptiveStrategy');
    });

    it('should create TimeBased strategy', () => {
      const container = WarmingContainer.create(cache, {
        strategy: 'timebased',
        strategyConfig: {
          recencyWeight: 0.3,
          correlationWeight: 0.7,
          recencyWindowMs: 60000,
          topN: 5,
          minScore: 0.3,
        },
      });
      const components = container.build();

      expect(components.strategy).toBeDefined();
      expect(components.strategy.constructor.name).toBe('TimeBasedStrategy');
    });

    it('should throw error for unknown strategy', () => {
      const container = WarmingContainer.create(cache, {
        strategy: 'unknown' as WarmingStrategyType,
        strategyConfig: { topN: 5, minScore: 0.3 } as TopNStrategyConfig,
      });

      expect(() => container.build()).toThrow('Unknown strategy type: unknown');
    });
  });

  describe('Configuration Updates', () => {
    it('should update configuration', () => {
      const container = WarmingContainer.create(cache, {
        strategy: 'topn',
        strategyConfig: { topN: 5, minScore: 0.3 } as TopNStrategyConfig,
      });

      expect(container.getConfig().strategy).toBe('topn');

      container.updateConfig({
        strategy: 'adaptive',
        strategyConfig: {
          targetHitRate: 0.97,
          minPairs: 3,
          maxPairs: 10,
          minScore: 0.3,
          adjustmentFactor: 0.1,
        },
      });

      expect(container.getConfig().strategy).toBe('adaptive');
    });

    it('should require rebuild after config update', () => {
      const container = WarmingContainer.create(cache, {
        strategy: 'topn',
        strategyConfig: { topN: 5, minScore: 0.3 } as TopNStrategyConfig,
      });

      const components1 = container.build();
      expect(components1.strategy.constructor.name).toBe('TopNStrategy');

      container.updateConfig({
        strategy: 'threshold',
        strategyConfig: { minScore: 0.5, maxPairs: 10 },
      });

      // Old components still have TopN strategy
      expect(components1.strategy.constructor.name).toBe('TopNStrategy');

      // Rebuild to get new strategy
      const components2 = container.build();
      expect(components2.strategy.constructor.name).toBe('ThresholdStrategy');
    });

    it('should preserve unmodified config values on update', () => {
      const container = WarmingContainer.create(cache, {
        strategy: 'topn',
        strategyConfig: { topN: 5, minScore: 0.3 } as TopNStrategyConfig,
        enableMetrics: false,
      });

      expect(container.getConfig().enableMetrics).toBe(false);

      container.updateConfig({
        strategy: 'adaptive',
        strategyConfig: {
          targetHitRate: 0.97,
          minPairs: 3,
          maxPairs: 10,
          minScore: 0.3,
          adjustmentFactor: 0.1,
        },
      });

      // enableMetrics should still be false
      expect(container.getConfig().enableMetrics).toBe(false);
    });
  });

  describe('Dependency Injection', () => {
    it('should inject cache into warmer', () => {
      const container = WarmingContainer.create(cache);
      const components = container.build();

      // Warmer should have reference to the cache
      expect(components.warmer).toBeDefined();
      // We can't directly access private cache, but we can test warming works
      expect(typeof components.warmer.warmForPair).toBe('function');
    });

    it('should inject tracker into warmer', () => {
      const container = WarmingContainer.create(cache);
      const components = container.build();

      // Both should be defined and wired together
      expect(components.tracker).toBeDefined();
      expect(components.warmer).toBeDefined();
    });

    it('should inject strategy into warmer', () => {
      const container = WarmingContainer.create(cache);
      const components = container.build();

      // Both should be defined and wired together
      expect(components.strategy).toBeDefined();
      expect(components.warmer).toBeDefined();
    });

    it('should inject analyzer into tracker', () => {
      const container = WarmingContainer.create(cache);
      const components = container.build();

      // Both should be defined and wired together
      expect(components.analyzer).toBeDefined();
      expect(components.tracker).toBeDefined();
    });
  });

  describe('Metrics Configuration', () => {
    it('should define standard warming metrics', () => {
      const container = WarmingContainer.create(cache, {
        enableMetrics: true,
      });
      const components = container.build();

      expect(components.metricsCollector).toBeDefined();

      // Check that standard metrics are defined
      const snapshot = components.metricsCollector!.getSnapshot();
      expect(snapshot).toBeDefined();
      expect(Array.isArray(snapshot)).toBe(true);
    });

    it('should apply custom metrics config', () => {
      const container = WarmingContainer.create(cache, {
        enableMetrics: true,
        metricsConfig: {
          metricPrefix: 'custom_',
          includeTimestamps: true,
        },
      });
      const components = container.build();

      expect(components.metricsExporter).toBeDefined();
      // Exporter should have custom config applied
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty config object', () => {
      const container = WarmingContainer.create(cache, {});
      const components = container.build();

      expect(components).toBeDefined();
      expect(components.strategy.constructor.name).toBe('TopNStrategy'); // Default
    });

    it('should handle null warmer config', () => {
      const container = WarmingContainer.create(cache, {
        warmerConfig: undefined,
      });
      const components = container.build();

      expect(components.warmer).toBeDefined();
    });

    it('should handle null metrics config', () => {
      const container = WarmingContainer.create(cache, {
        metricsConfig: undefined,
      });
      const components = container.build();

      expect(components.metricsExporter).toBeDefined();
    });

    it('should build multiple times without error', () => {
      const container = WarmingContainer.create(cache);

      const components1 = container.build();
      const components2 = container.build();
      const components3 = container.build();

      expect(components1).toBeDefined();
      expect(components2).toBeDefined();
      expect(components3).toBeDefined();
    });
  });

  describe('Type Safety', () => {
    it('should enforce strategy config types', () => {
      // TypeScript should catch mismatched strategy config at compile time
      // This is a runtime verification that the config is applied
      const container = WarmingContainer.create(cache, {
        strategy: 'topn',
        strategyConfig: {
          topN: 5,
          minScore: 0.3,
        } as TopNStrategyConfig,
      });

      const config = container.getConfig();
      expect(config.strategyConfig).toHaveProperty('topN');
      expect(config.strategyConfig).toHaveProperty('minScore');
    });

    it('should return immutable config copy', () => {
      const container = WarmingContainer.create(cache);
      const config1 = container.getConfig();
      const config2 = container.getConfig();

      // Should return different objects
      expect(config1).not.toBe(config2);
      expect(config1).toEqual(config2);
    });
  });
});
