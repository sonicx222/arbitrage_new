/**
 * Warming Container - Dependency Injection (Day 9)
 *
 * Provides a clean API for creating and wiring warming infrastructure components.
 * Handles dependency injection, configuration, and lifecycle management.
 *
 * Design Pattern: Service Locator + Factory + Builder
 *
 * Benefits:
 * - Single place to configure all warming components
 * - Proper dependency injection (constructor injection)
 * - Easy to swap implementations for testing
 * - Configuration-driven setup
 * - Reduces boilerplate in service code
 *
 * @package @arbitrage/core
 * @module warming/container
 */

import {
  // Infrastructure implementations
  CorrelationAnalyzer,
  getCorrelationAnalyzer,
  CorrelationTrackerImpl,
  HierarchicalCache,
  HierarchicalCacheWarmer,
  // Strategies
  TopNStrategy,
  ThresholdStrategy,
  AdaptiveStrategy,
  TimeBasedStrategy,
  IWarmingStrategy,
  // Metrics
  PrometheusMetricsCollector,
  PrometheusExporter,
  IMetricsCollector,
  IMetricsExporter,
  // Domain interfaces
  ICorrelationTracker,
  ICacheWarmer,
  // Configuration types
  TopNStrategyConfig,
  ThresholdStrategyConfig,
  AdaptiveStrategyConfig,
  TimeBasedStrategyConfig,
  WarmingConfig,
  ExportConfig,
} from '../../';

// Import ExportFormat directly to avoid circular dependency
// (index.ts → warming/container → warming.container.ts → index.ts)
import { ExportFormat } from '../../metrics/domain';

/**
 * Warming strategy type
 */
export type WarmingStrategyType = 'topn' | 'threshold' | 'adaptive' | 'timebased';

/**
 * Container configuration
 */
export interface WarmingContainerConfig {
  /**
   * Warming strategy type
   */
  strategy: WarmingStrategyType;

  /**
   * Strategy-specific configuration
   */
  strategyConfig: TopNStrategyConfig | ThresholdStrategyConfig | AdaptiveStrategyConfig | TimeBasedStrategyConfig;

  /**
   * Cache warmer configuration
   */
  warmerConfig?: Partial<WarmingConfig>;

  /**
   * Metrics export configuration
   */
  metricsConfig?: Partial<ExportConfig>;

  /**
   * Use existing correlation analyzer (singleton)
   * If true, uses getCorrelationAnalyzer()
   * If false, creates new instance
   */
  useSharedAnalyzer?: boolean;

  /**
   * Enable metrics collection
   */
  enableMetrics?: boolean;
}

/**
 * Default container configuration
 */
const DEFAULT_CONFIG: WarmingContainerConfig = {
  strategy: 'topn',
  strategyConfig: {
    topN: 5,
    minScore: 0.3,
  } as TopNStrategyConfig,
  warmerConfig: {
    maxPairsPerWarm: 5,
    minCorrelationScore: 0.3,
    asyncWarming: true,
    timeoutMs: 50,
    enabled: true,
  },
  metricsConfig: {
    format: ExportFormat.PROMETHEUS,
    includeTimestamps: false,
    includeMetadata: true,
    metricPrefix: 'arbitrage_',
  },
  useSharedAnalyzer: true,
  enableMetrics: true,
};

/**
 * Warming container components
 */
export interface WarmingComponents {
  /**
   * Correlation analyzer (tracks co-occurrences)
   */
  analyzer: CorrelationAnalyzer;

  /**
   * Correlation tracker (domain interface)
   */
  tracker: ICorrelationTracker;

  /**
   * Warming strategy (selects pairs to warm)
   */
  strategy: IWarmingStrategy;

  /**
   * Cache warmer (promotes L2 → L1)
   */
  warmer: ICacheWarmer;

  /**
   * Metrics collector (optional)
   */
  metricsCollector?: IMetricsCollector;

  /**
   * Metrics exporter (optional)
   */
  metricsExporter?: IMetricsExporter;
}

/**
 * Warming container for dependency injection
 *
 * Provides factory methods for creating fully-wired warming infrastructure.
 *
 * Usage Patterns:
 *
 * 1. Simple (defaults):
 * ```typescript
 * const container = WarmingContainer.create(cache);
 * const components = container.build();
 * ```
 *
 * 2. Custom strategy:
 * ```typescript
 * const container = WarmingContainer.create(cache, {
 *   strategy: 'adaptive',
 *   strategyConfig: {
 *     targetHitRate: 0.97,
 *     minPairs: 3,
 *     maxPairs: 10
 *   }
 * });
 * const components = container.build();
 * ```
 *
 * 3. Testing (without metrics):
 * ```typescript
 * const container = WarmingContainer.create(cache, {
 *   strategy: 'topn',
 *   enableMetrics: false
 * });
 * const components = container.build();
 * ```
 *
 * 4. Pre-built components:
 * ```typescript
 * const { tracker, warmer, strategy } = WarmingContainer.create(cache).build();
 *
 * // Use in your service
 * tracker.recordPriceUpdate('WETH_USDT', Date.now());
 * await warmer.warmForPair('WETH_USDT');
 * ```
 */
export class WarmingContainer {
  private config: WarmingContainerConfig;

  private constructor(
    private readonly cache: HierarchicalCache,
    config: Partial<WarmingContainerConfig> = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Create a new warming container
   *
   * Factory method for container instantiation.
   *
   * @param cache - HierarchicalCache instance
   * @param config - Container configuration
   * @returns Container instance
   */
  static create(
    cache: HierarchicalCache,
    config: Partial<WarmingContainerConfig> = {}
  ): WarmingContainer {
    return new WarmingContainer(cache, config);
  }

  /**
   * Build all warming components
   *
   * Creates and wires all dependencies according to configuration.
   *
   * Dependency Graph:
   * ```
   * CorrelationAnalyzer (singleton or new)
   *         ↓
   * CorrelationTrackerImpl (wraps analyzer)
   *         ↓
   * WarmingStrategy (TopN/Threshold/Adaptive/TimeBased)
   *         ↓
   * HierarchicalCacheWarmer (uses tracker + strategy + cache)
   *         ↓
   * PrometheusMetricsCollector (optional)
   *         ↓
   * PrometheusExporter (optional)
   * ```
   *
   * @returns Fully-wired components
   */
  build(): WarmingComponents {
    // 1. Create or get correlation analyzer
    const analyzer = this.createAnalyzer();

    // 2. Create correlation tracker (wraps analyzer)
    const tracker = this.createTracker(analyzer);

    // 3. Create warming strategy
    const strategy = this.createStrategy();

    // 4. Create cache warmer (uses tracker + strategy + cache)
    const warmer = this.createWarmer(tracker, strategy);

    // 5. Create metrics (optional)
    const metrics = this.config.enableMetrics
      ? this.createMetrics()
      : undefined;

    return {
      analyzer,
      tracker,
      strategy,
      warmer,
      metricsCollector: metrics?.collector,
      metricsExporter: metrics?.exporter,
    };
  }

  /**
   * Create correlation analyzer
   *
   * Uses singleton if useSharedAnalyzer=true (default),
   * otherwise creates new instance.
   *
   * @returns CorrelationAnalyzer instance
   */
  private createAnalyzer(): CorrelationAnalyzer {
    if (this.config.useSharedAnalyzer) {
      // Use shared singleton
      return getCorrelationAnalyzer();
    } else {
      // Create new instance (for testing)
      return new CorrelationAnalyzer({
        coOccurrenceWindowMs: 1000,
        topCorrelatedLimit: 10,
      });
    }
  }

  /**
   * Create correlation tracker
   *
   * Wraps CorrelationAnalyzer with domain interface.
   *
   * @param analyzer - CorrelationAnalyzer instance
   * @returns ICorrelationTracker implementation
   */
  private createTracker(analyzer: CorrelationAnalyzer): ICorrelationTracker {
    return new CorrelationTrackerImpl(analyzer);
  }

  /**
   * Create warming strategy
   *
   * Factory method for strategy creation based on config.
   *
   * @returns IWarmingStrategy implementation
   */
  private createStrategy(): IWarmingStrategy {
    switch (this.config.strategy) {
      case 'topn':
        return new TopNStrategy(this.config.strategyConfig as TopNStrategyConfig);

      case 'threshold':
        return new ThresholdStrategy(this.config.strategyConfig as ThresholdStrategyConfig);

      case 'adaptive':
        return new AdaptiveStrategy(this.config.strategyConfig as AdaptiveStrategyConfig);

      case 'timebased':
        return new TimeBasedStrategy(this.config.strategyConfig as TimeBasedStrategyConfig);

      default:
        throw new Error(`Unknown strategy type: ${this.config.strategy}`);
    }
  }

  /**
   * Create cache warmer
   *
   * Wires tracker, strategy, and cache together.
   *
   * @param tracker - Correlation tracker
   * @param strategy - Warming strategy
   * @returns ICacheWarmer implementation
   */
  private createWarmer(
    tracker: ICorrelationTracker,
    strategy: IWarmingStrategy
  ): ICacheWarmer {
    return new HierarchicalCacheWarmer(
      this.cache,
      tracker,
      strategy,
      this.config.warmerConfig
    );
  }

  /**
   * Create metrics infrastructure
   *
   * Creates collector and exporter.
   *
   * @returns Metrics components
   */
  private createMetrics(): {
    collector: IMetricsCollector;
    exporter: IMetricsExporter;
  } {
    const collector = new PrometheusMetricsCollector();

    // Define standard warming metrics
    this.defineWarmingMetrics(collector);

    const exporter = new PrometheusExporter(
      collector,
      this.config.metricsConfig
    );

    return { collector, exporter };
  }

  /**
   * Define standard warming metrics
   *
   * Pre-defines common metrics for cache and warming.
   *
   * @param collector - Metrics collector
   */
  private defineWarmingMetrics(collector: IMetricsCollector): void {
    // Import MetricType here to avoid circular dependency
    const { MetricType } = require('../../metrics/domain/metrics-collector.interface');

    // Cache metrics
    collector.defineMetric({
      name: 'cache_hits_total',
      type: MetricType.COUNTER,
      description: 'Total cache hits',
      labels: ['cache_level', 'chain'],
    });

    collector.defineMetric({
      name: 'cache_misses_total',
      type: MetricType.COUNTER,
      description: 'Total cache misses',
      labels: ['cache_level', 'chain'],
    });

    collector.defineMetric({
      name: 'cache_size_bytes',
      type: MetricType.GAUGE,
      description: 'Current cache size in bytes',
      labels: ['cache_level', 'chain'],
    });

    collector.defineMetric({
      name: 'cache_latency_ms',
      type: MetricType.HISTOGRAM,
      description: 'Cache operation latency',
      labels: ['operation', 'cache_level', 'chain'],
    });

    // Warming metrics
    collector.defineMetric({
      name: 'warming_operations_total',
      type: MetricType.COUNTER,
      description: 'Total warming operations',
      labels: ['chain'],
    });

    collector.defineMetric({
      name: 'warming_pairs_warmed_total',
      type: MetricType.COUNTER,
      description: 'Total pairs warmed',
      labels: ['chain'],
    });

    collector.defineMetric({
      name: 'warming_duration_ms',
      type: MetricType.HISTOGRAM,
      description: 'Warming operation duration',
      labels: ['chain'],
    });

    // Correlation metrics
    collector.defineMetric({
      name: 'correlation_tracking_duration_us',
      type: MetricType.HISTOGRAM,
      description: 'Correlation tracking duration',
      labels: ['chain'],
    });

    collector.defineMetric({
      name: 'correlation_pairs_tracked',
      type: MetricType.GAUGE,
      description: 'Pairs tracked for correlation',
      labels: ['chain'],
    });
  }

  /**
   * Update configuration
   *
   * Allows runtime configuration updates.
   * Note: Requires rebuild() to apply changes.
   *
   * @param config - New configuration (partial)
   */
  updateConfig(config: Partial<WarmingContainerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   *
   * @returns Current configuration
   */
  getConfig(): WarmingContainerConfig {
    return { ...this.config };
  }
}

/**
 * Convenience factory functions
 */

/**
 * Create warming components with TopN strategy
 *
 * Simple factory for the most common use case.
 *
 * @param cache - HierarchicalCache instance
 * @param topN - Number of pairs to warm (default: 5)
 * @param minScore - Minimum correlation score (default: 0.3)
 * @returns Fully-wired components
 */
export function createTopNWarming(
  cache: HierarchicalCache,
  topN: number = 5,
  minScore: number = 0.3
): WarmingComponents {
  return WarmingContainer.create(cache, {
    strategy: 'topn',
    strategyConfig: { topN, minScore } as TopNStrategyConfig,
  }).build();
}

/**
 * Create warming components with Adaptive strategy
 *
 * For self-tuning based on hit rate feedback.
 *
 * @param cache - HierarchicalCache instance
 * @param targetHitRate - Target hit rate (default: 0.97)
 * @param maxPairs - Maximum pairs to warm (default: 10)
 * @returns Fully-wired components
 */
export function createAdaptiveWarming(
  cache: HierarchicalCache,
  targetHitRate: number = 0.97,
  maxPairs: number = 10
): WarmingComponents {
  return WarmingContainer.create(cache, {
    strategy: 'adaptive',
    strategyConfig: {
      targetHitRate,
      minPairs: 3,
      maxPairs,
      minScore: 0.3,
      adjustmentFactor: 0.1,
    } as AdaptiveStrategyConfig,
  }).build();
}

/**
 * Create warming components for testing
 *
 * Uses new correlation analyzer instance (not singleton)
 * and disables metrics for faster tests.
 *
 * @param cache - HierarchicalCache instance
 * @param strategy - Strategy type (default: 'topn')
 * @returns Fully-wired components
 */
export function createTestWarming(
  cache: HierarchicalCache,
  strategy: WarmingStrategyType = 'topn'
): WarmingComponents {
  return WarmingContainer.create(cache, {
    strategy,
    strategyConfig: { topN: 5, minScore: 0.3 } as TopNStrategyConfig,
    useSharedAnalyzer: false, // Create new instance
    enableMetrics: false, // Disable metrics
  }).build();
}
