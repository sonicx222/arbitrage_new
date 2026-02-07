/**
 * Warming Integration for ChainInstance (Enhancement #2 & #3)
 *
 * Integrates predictive cache warming and metrics collection into the unified-detector.
 *
 * Integration Points:
 * 1. Correlation tracking on every price update
 * 2. Predictive warming based on correlation patterns
 * 3. Metrics collection for monitoring
 *
 * Performance:
 * - Correlation tracking: <50μs (hot-path)
 * - Cache warming: Async/non-blocking
 * - Metrics collection: <10μs (hot-path)
 *
 * @package services/unified-detector
 */

import {
  // Correlation tracking
  CorrelationAnalyzer,
  getCorrelationAnalyzer,
  CorrelationTrackerImpl,
  // Cache warming
  HierarchicalCache,
  HierarchicalCacheWarmer,
  // Warming strategies
  TopNStrategy,
  AdaptiveStrategy,
  // Metrics
  PrometheusMetricsCollector,
  PrometheusExporter,
  MetricType,
  ExportFormat,
} from '@arbitrage/core';

/**
 * Configuration for warming integration
 */
export interface WarmingIntegrationConfig {
  /**
   * Enable predictive warming (default: false)
   */
  enableWarming: boolean;

  /**
   * Enable metrics collection (default: true)
   */
  enableMetrics: boolean;

  /**
   * Warming strategy: 'topn' or 'adaptive'
   */
  warmingStrategy: 'topn' | 'adaptive';

  /**
   * Maximum pairs to warm per trigger (default: 5)
   */
  maxPairsToWarm: number;

  /**
   * Minimum correlation score (default: 0.3)
   */
  minCorrelationScore: number;

  /**
   * Target hit rate for adaptive strategy (default: 0.97)
   */
  targetHitRate: number;
}

/**
 * Default warming configuration
 */
const DEFAULT_CONFIG: WarmingIntegrationConfig = {
  enableWarming: false, // Disabled by default for safe rollout
  enableMetrics: true,
  warmingStrategy: 'topn',
  maxPairsToWarm: 5,
  minCorrelationScore: 0.3,
  targetHitRate: 0.97,
};

/**
 * Warming integration manager
 *
 * Manages correlation tracking, cache warming, and metrics collection
 * for the unified-detector service.
 *
 * Lifecycle:
 * 1. initialize() - Set up infrastructure
 * 2. onPriceUpdate() - Called on every price update (hot-path)
 * 3. getStats() - Get warming and metrics stats
 * 4. shutdown() - Clean shutdown
 *
 * @example
 * ```typescript
 * const integration = new WarmingIntegration(cache, {
 *   enableWarming: true,
 *   warmingStrategy: 'topn'
 * });
 *
 * await integration.initialize();
 *
 * // On every price update (hot-path)
 * integration.onPriceUpdate(pairAddress, timestamp);
 *
 * // Get stats for monitoring
 * const stats = integration.getStats();
 * ```
 */
export class WarmingIntegration {
  private config: WarmingIntegrationConfig;
  private correlationAnalyzer: CorrelationAnalyzer | null = null;
  private correlationTracker: CorrelationTrackerImpl | null = null;
  private cacheWarmer: HierarchicalCacheWarmer | null = null;
  private metricsCollector: PrometheusMetricsCollector | null = null;
  private metricsExporter: PrometheusExporter | null = null;
  private initialized: boolean = false;

  constructor(
    private readonly cache: HierarchicalCache | null,
    config: Partial<WarmingIntegrationConfig> = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize warming infrastructure
   *
   * Sets up:
   * - CorrelationAnalyzer and tracker
   * - Cache warmer with strategy
   * - Metrics collector and exporter
   *
   * @throws Error if cache warming enabled but no cache provided
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Initialize metrics (always enabled for monitoring)
    if (this.config.enableMetrics) {
      this.initializeMetrics();
    }

    // Initialize warming (only if enabled AND cache available)
    if (this.config.enableWarming) {
      if (!this.cache) {
        throw new Error(
          'Warming enabled but no cache provided. Set usePriceCache=true in ChainInstance config.'
        );
      }

      this.initializeWarming();
    }

    this.initialized = true;
  }

  /**
   * Initialize metrics infrastructure
   */
  private initializeMetrics(): void {
    // Create metrics collector
    this.metricsCollector = new PrometheusMetricsCollector();

    // Define cache metrics
    this.metricsCollector.defineMetric({
      name: 'cache_hits_total',
      type: MetricType.COUNTER,
      description: 'Total cache hits',
      labels: ['cache_level', 'chain'],
    });

    this.metricsCollector.defineMetric({
      name: 'cache_misses_total',
      type: MetricType.COUNTER,
      description: 'Total cache misses',
      labels: ['cache_level', 'chain'],
    });

    this.metricsCollector.defineMetric({
      name: 'cache_size_bytes',
      type: MetricType.GAUGE,
      description: 'Current cache size in bytes',
      labels: ['cache_level', 'chain'],
    });

    this.metricsCollector.defineMetric({
      name: 'cache_latency_ms',
      type: MetricType.HISTOGRAM,
      description: 'Cache operation latency in milliseconds',
      labels: ['operation', 'cache_level', 'chain'],
    });

    // Define warming metrics
    this.metricsCollector.defineMetric({
      name: 'warming_operations_total',
      type: MetricType.COUNTER,
      description: 'Total warming operations triggered',
      labels: ['chain'],
    });

    this.metricsCollector.defineMetric({
      name: 'warming_pairs_warmed_total',
      type: MetricType.COUNTER,
      description: 'Total pairs warmed',
      labels: ['chain'],
    });

    this.metricsCollector.defineMetric({
      name: 'warming_duration_ms',
      type: MetricType.HISTOGRAM,
      description: 'Warming operation duration in milliseconds',
      labels: ['chain'],
    });

    // Define correlation metrics
    this.metricsCollector.defineMetric({
      name: 'correlation_tracking_duration_us',
      type: MetricType.HISTOGRAM,
      description: 'Correlation tracking duration in microseconds',
      labels: ['chain'],
    });

    this.metricsCollector.defineMetric({
      name: 'correlation_pairs_tracked',
      type: MetricType.GAUGE,
      description: 'Number of pairs tracked for correlation',
      labels: ['chain'],
    });

    // Create exporter
    this.metricsExporter = new PrometheusExporter(this.metricsCollector, {
      format: ExportFormat.PROMETHEUS,
      metricPrefix: 'arbitrage_',
      includeTimestamps: false,
      includeMetadata: true,
    });
  }

  /**
   * Initialize warming infrastructure
   */
  private initializeWarming(): void {
    // Create correlation analyzer
    this.correlationAnalyzer = getCorrelationAnalyzer();

    // Create correlation tracker
    this.correlationTracker = new CorrelationTrackerImpl(
      this.correlationAnalyzer
    );

    // Create warming strategy
    const strategy =
      this.config.warmingStrategy === 'adaptive'
        ? new AdaptiveStrategy({
            targetHitRate: this.config.targetHitRate,
            minPairs: 3,
            maxPairs: this.config.maxPairsToWarm,
            minScore: this.config.minCorrelationScore,
            adjustmentFactor: 0.1,
          })
        : new TopNStrategy({
            topN: this.config.maxPairsToWarm,
            minScore: this.config.minCorrelationScore,
          });

    // Create cache warmer
    this.cacheWarmer = new HierarchicalCacheWarmer(
      this.cache!,
      this.correlationTracker,
      strategy,
      {
        maxPairsPerWarm: this.config.maxPairsToWarm,
        minCorrelationScore: this.config.minCorrelationScore,
        asyncWarming: true,
        timeoutMs: 50,
        enabled: true,
      }
    );
  }

  /**
   * Handle price update (HOT PATH)
   *
   * Called on every price update event.
   * Must be <50μs for correlation tracking.
   *
   * Flow:
   * 1. Track correlation (hot-path, <50μs)
   * 2. Trigger warming (async, non-blocking)
   * 3. Record metrics (hot-path, <10μs)
   *
   * @param pairAddress - Pair address that was updated
   * @param timestamp - Update timestamp
   * @param chainId - Chain identifier for metrics
   */
  onPriceUpdate(pairAddress: string, timestamp: number, chainId: string): void {
    if (!this.initialized) {
      return;
    }

    // 1. Track correlation (hot-path)
    if (this.correlationTracker) {
      const result = this.correlationTracker.recordPriceUpdate(
        pairAddress,
        timestamp
      );

      // Record correlation tracking metrics
      if (this.metricsCollector && result.success) {
        this.metricsCollector.recordHistogram(
          'correlation_tracking_duration_us',
          result.durationUs,
          { chain: chainId }
        );
      }
    }

    // 2. Trigger warming (async, non-blocking)
    if (this.cacheWarmer) {
      // Fire-and-forget warming to avoid blocking hot path
      this.cacheWarmer
        .warmForPair(pairAddress)
        .then(result => {
          // Record warming metrics
          if (this.metricsCollector && result.success) {
            this.metricsCollector.incrementCounter(
              'warming_operations_total',
              { chain: chainId }
            );

            this.metricsCollector.incrementCounter(
              'warming_pairs_warmed_total',
              { chain: chainId },
              result.pairsWarmed
            );

            this.metricsCollector.recordHistogram(
              'warming_duration_ms',
              result.durationMs,
              { chain: chainId }
            );
          }
        })
        .catch(error => {
          // Warming errors are non-fatal (best-effort optimization)
          // Log but don't throw
        });
    }
  }

  /**
   * Record cache metrics
   *
   * Called periodically to update cache statistics.
   *
   * @param chainId - Chain identifier
   */
  recordCacheMetrics(chainId: string): void {
    if (!this.metricsCollector || !this.cache) {
      return;
    }

    const stats = this.cache.getStats();

    // L1 metrics
    this.metricsCollector.incrementCounter(
      'cache_hits_total',
      { cache_level: 'l1', chain: chainId },
      stats.l1.hits
    );

    this.metricsCollector.incrementCounter(
      'cache_misses_total',
      { cache_level: 'l1', chain: chainId },
      stats.l1.misses
    );

    this.metricsCollector.setGauge(
      'cache_size_bytes',
      stats.l1.size,
      { cache_level: 'l1', chain: chainId }
    );

    // L2 metrics
    this.metricsCollector.incrementCounter(
      'cache_hits_total',
      { cache_level: 'l2', chain: chainId },
      stats.l2.hits
    );

    this.metricsCollector.incrementCounter(
      'cache_misses_total',
      { cache_level: 'l2', chain: chainId },
      stats.l2.misses
    );

    // Correlation metrics
    if (this.correlationTracker) {
      const correlationStats = this.correlationTracker.getStats();
      this.metricsCollector.setGauge(
        'correlation_pairs_tracked',
        correlationStats.totalPairs,
        { chain: chainId }
      );
    }
  }

  /**
   * Get warming and metrics statistics
   *
   * @returns Combined statistics object
   */
  getStats(): WarmingIntegrationStats {
    const stats: WarmingIntegrationStats = {
      initialized: this.initialized,
      warmingEnabled: this.config.enableWarming,
      metricsEnabled: this.config.enableMetrics,
    };

    if (this.cacheWarmer) {
      stats.warming = this.cacheWarmer.getStats();
    }

    if (this.correlationTracker) {
      stats.correlation = this.correlationTracker.getStats();
    }

    if (this.metricsCollector) {
      stats.metrics = this.metricsCollector.getStats();
    }

    return stats;
  }

  /**
   * Export metrics in Prometheus format
   *
   * @returns Prometheus text format
   */
  async exportMetrics(): Promise<string> {
    if (!this.metricsExporter) {
      return '';
    }

    const result = await this.metricsExporter.export();
    return result.data as string;
  }

  /**
   * Update warming configuration at runtime
   *
   * @param config - New configuration (partial)
   */
  updateConfig(config: Partial<WarmingIntegrationConfig>): void {
    this.config = { ...this.config, ...config };

    // Update warmer config if exists
    if (this.cacheWarmer) {
      this.cacheWarmer.updateConfig({
        maxPairsPerWarm: config.maxPairsToWarm,
        minCorrelationScore: config.minCorrelationScore,
        enabled: config.enableWarming,
      });
    }
  }

  /**
   * Shutdown warming integration
   *
   * Cleans up resources.
   */
  async shutdown(): Promise<void> {
    // No specific cleanup needed currently
    // Correlation analyzer and cache are managed externally
    this.initialized = false;
  }
}

/**
 * Warming integration statistics
 */
export interface WarmingIntegrationStats {
  initialized: boolean;
  warmingEnabled: boolean;
  metricsEnabled: boolean;
  warming?: {
    totalWarmingOps: number;
    successfulOps: number;
    failedOps: number;
    successRate: number;
    totalPairsWarmed: number;
    avgPairsPerOp: number;
    avgDurationMs: number;
  };
  correlation?: {
    totalPairs: number;
    totalCoOccurrences: number;
    avgCorrelationScore: number;
    memoryUsageBytes: number;
  };
  metrics?: {
    metricsCount: number;
    totalObservations: number;
    memoryUsageBytes: number;
  };
}
