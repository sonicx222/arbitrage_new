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
  // Logging
  createLogger,
  getErrorMessage,
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
  private logger = createLogger('warming-integration');
  private metricsExporter: PrometheusExporter | null = null;
  private initialized: boolean = false;

  /**
   * Track pending warming operations to prevent concurrent duplicates (P1-7 fix)
   *
   * Key: pair address
   * Value: timestamp when warming started (for timeout cleanup)
   */
  private pendingWarmings: Map<string, number> = new Map();

  /** FIX #20: Auto-cleanup interval for stale pendingWarmings entries */
  private pendingWarmingsCleanupInterval: NodeJS.Timeout | null = null;
  private static readonly PENDING_WARMINGS_CLEANUP_INTERVAL_MS = 30_000;

  /**
   * Previous cache stats for delta computation in recordCacheMetrics().
   * Without delta tracking, incrementCounter receives cumulative values,
   * causing quadratic metric growth (sum of 1..N after N calls).
   */
  private previousL1Hits: number = 0;
  private previousL1Misses: number = 0;
  private previousL2Hits: number = 0;
  private previousL2Misses: number = 0;

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

      // FIX #20: Start auto-cleanup for stale pendingWarmings entries
      this.pendingWarmingsCleanupInterval = setInterval(() => {
        this.cleanupStalePendingWarmings();
      }, WarmingIntegration.PENDING_WARMINGS_CLEANUP_INTERVAL_MS);
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

    // Define concurrent warming metric (P1-7 fix)
    this.metricsCollector.defineMetric({
      name: 'warming_pending_operations',
      type: MetricType.GAUGE,
      description: 'Number of warming operations currently in progress',
      labels: ['chain'],
    });

    this.metricsCollector.defineMetric({
      name: 'warming_debounced_total',
      type: MetricType.COUNTER,
      description: 'Total warming operations skipped due to debouncing',
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

    // 2. Trigger warming (async, non-blocking) with debouncing (P1-7 fix)
    if (this.cacheWarmer) {
      // Debounce: Skip if warming already pending for this pair
      if (this.pendingWarmings.has(pairAddress)) {
        // Another warming operation is already in progress for this pair
        // Skip to avoid duplicate work and metrics overcounting

        // Track debouncing metric (P1-7 fix monitoring)
        if (this.metricsCollector) {
          this.metricsCollector.incrementCounter(
            'warming_debounced_total',
            { chain: chainId }
          );
        }

        return;
      }

      // Mark warming as pending
      this.pendingWarmings.set(pairAddress, timestamp);

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
          // Log error with context for debugging and monitoring
          this.logger.warn('Cache warming failed (non-fatal)', {
            pair: pairAddress,
            chain: chainId,
            error: getErrorMessage(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString(),
          });

          // Increment error metric for monitoring
          if (this.metricsCollector) {
            this.metricsCollector.incrementCounter(
              'warming_errors_total',
              {
                chain: chainId,
                error_type: error instanceof Error ? error.name : 'Unknown',
              }
            );
          }
        })
        .finally(() => {
          // Always remove from pending set when done (success or error)
          this.pendingWarmings.delete(pairAddress);
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

    // P1-FIX: Compute deltas from cumulative stats to avoid quadratic counter growth.
    // cache.getStats() returns cumulative values; incrementCounter expects deltas.
    const l1HitsDelta = stats.l1.hits - this.previousL1Hits;
    const l1MissesDelta = stats.l1.misses - this.previousL1Misses;
    const l2HitsDelta = stats.l2.hits - this.previousL2Hits;
    const l2MissesDelta = stats.l2.misses - this.previousL2Misses;

    this.previousL1Hits = stats.l1.hits;
    this.previousL1Misses = stats.l1.misses;
    this.previousL2Hits = stats.l2.hits;
    this.previousL2Misses = stats.l2.misses;

    // L1 metrics
    if (l1HitsDelta > 0) {
      this.metricsCollector.incrementCounter(
        'cache_hits_total',
        { cache_level: 'l1', chain: chainId },
        l1HitsDelta
      );
    }

    if (l1MissesDelta > 0) {
      this.metricsCollector.incrementCounter(
        'cache_misses_total',
        { cache_level: 'l1', chain: chainId },
        l1MissesDelta
      );
    }

    this.metricsCollector.setGauge(
      'cache_size_bytes',
      stats.l1.size,
      { cache_level: 'l1', chain: chainId }
    );

    // L2 metrics
    if (l2HitsDelta > 0) {
      this.metricsCollector.incrementCounter(
        'cache_hits_total',
        { cache_level: 'l2', chain: chainId },
        l2HitsDelta
      );
    }

    if (l2MissesDelta > 0) {
      this.metricsCollector.incrementCounter(
        'cache_misses_total',
        { cache_level: 'l2', chain: chainId },
        l2MissesDelta
      );
    }

    // Correlation metrics
    if (this.correlationTracker) {
      const correlationStats = this.correlationTracker.getStats();
      this.metricsCollector.setGauge(
        'correlation_pairs_tracked',
        correlationStats.totalPairs,
        { chain: chainId }
      );
    }

    // Warming concurrency metric (P1-7 fix monitoring)
    this.metricsCollector.setGauge(
      'warming_pending_operations',
      this.pendingWarmings.size,
      { chain: chainId }
    );
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
   * Clean up stale pending warming entries (P1-7 fix)
   *
   * Removes warming operations that have been pending for too long.
   * This prevents memory leak if warming operations hang or timeout.
   *
   * @param maxAgeMs - Maximum age for pending operations (default: 30s)
   */
  cleanupStalePendingWarmings(maxAgeMs: number = 30000): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [pair, startTime] of this.pendingWarmings.entries()) {
      const age = now - startTime;
      if (age > maxAgeMs) {
        this.pendingWarmings.delete(pair);
        cleanedCount++;

        // Log cleanup for monitoring
        this.logger.warn('Cleaned up stale pending warming', {
          pair,
          ageMs: age,
          maxAgeMs,
        });
      }
    }

    if (cleanedCount > 0) {
      this.logger.info('Pending warming cleanup complete', {
        cleaned: cleanedCount,
        remaining: this.pendingWarmings.size,
      });
    }
  }

  /**
   * Get pending warming count (for monitoring)
   *
   * @returns Number of warming operations currently in progress
   */
  getPendingWarmingCount(): number {
    return this.pendingWarmings.size;
  }

  /**
   * Shutdown warming integration
   *
   * Cleans up resources and pending operations.
   */
  async shutdown(): Promise<void> {
    // FIX #20: Clear auto-cleanup interval
    if (this.pendingWarmingsCleanupInterval) {
      clearInterval(this.pendingWarmingsCleanupInterval);
      this.pendingWarmingsCleanupInterval = null;
    }

    // Clear pending warmings
    this.pendingWarmings.clear();

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
