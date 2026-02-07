/**
 * Metrics Collector Interface (Enhancement #3 - Grafana Dashboards)
 *
 * Defines the contract for collecting performance and operational metrics.
 * Enables monitoring, alerting, and performance analysis via Prometheus/Grafana.
 *
 * @see infrastructure/grafana/dashboards/simulation-metrics.json - Existing dashboard
 * @see docs/PRICEMATRIX_DEPLOYMENT.md - Performance monitoring section
 *
 * Design Principles:
 * - Observer Pattern: Metrics collection decoupled from business logic
 * - Single Responsibility: Only collects metrics, doesn't export or visualize
 * - Interface Segregation: Separate collection from export concerns
 *
 * Performance Targets:
 * - Metric recording: <10μs (hot path)
 * - Zero allocations in hot path
 * - Memory overhead: <5MB
 *
 * @package @arbitrage/core
 * @module metrics/domain
 */

/**
 * Metric types supported
 */
export enum MetricType {
  /**
   * Counter: Monotonically increasing value (e.g., total requests)
   */
  COUNTER = 'counter',

  /**
   * Gauge: Value that can go up or down (e.g., cache size)
   */
  GAUGE = 'gauge',

  /**
   * Histogram: Distribution of values (e.g., latency)
   */
  HISTOGRAM = 'histogram',

  /**
   * Summary: Similar to histogram but with quantiles (e.g., p50, p95, p99)
   */
  SUMMARY = 'summary',
}

/**
 * Metric definition
 */
export interface MetricDefinition {
  /**
   * Metric name (e.g., "cache_hit_rate")
   *
   * Naming convention: lowercase_with_underscores
   */
  readonly name: string;

  /**
   * Metric type
   */
  readonly type: MetricType;

  /**
   * Human-readable description
   */
  readonly description: string;

  /**
   * Metric unit (e.g., "bytes", "seconds", "percent")
   */
  readonly unit?: string;

  /**
   * Label names for this metric (e.g., ["cache_level", "operation"])
   */
  readonly labels?: string[];
}

/**
 * Metric labels for dimensional data
 */
export interface MetricLabels {
  /**
   * Cache level: "l1", "l2", "l3"
   */
  cache_level?: string;

  /**
   * Operation type: "read", "write", "eviction", "warming"
   */
  operation?: string;

  /**
   * Chain identifier: "bsc", "polygon", "avalanche", etc.
   */
  chain?: string;

  /**
   * Service name: "unified-detector", "partition-asia", etc.
   */
  service?: string;

  /**
   * Custom labels (extensible)
   */
  [key: string]: string | undefined;
}

/**
 * Snapshot of metric values
 */
export interface MetricSnapshot {
  /**
   * Metric name
   */
  readonly name: string;

  /**
   * Metric type
   */
  readonly type: MetricType;

  /**
   * Current value (for counter/gauge)
   */
  readonly value?: number;

  /**
   * Histogram/summary data
   */
  readonly distribution?: {
    readonly count: number;
    readonly sum: number;
    readonly min: number;
    readonly max: number;
    readonly p50: number;
    readonly p95: number;
    readonly p99: number;
  };

  /**
   * Labels associated with this snapshot
   */
  readonly labels: MetricLabels;

  /**
   * Timestamp when snapshot was taken (Unix ms)
   */
  readonly timestamp: number;
}

/**
 * Metrics collector for performance monitoring
 *
 * Responsibilities:
 * - Record metric values from application code
 * - Maintain in-memory metric state
 * - Provide snapshots for export
 * - Support dimensional data via labels
 *
 * Integration Points:
 * - HierarchicalCache: L1/L2 hit rates, latencies
 * - PriceMatrix: SharedArrayBuffer operations
 * - CacheWarmer: Warming effectiveness
 * - SharedKeyRegistry: CAS iterations, contention
 *
 * @example
 * ```typescript
 * const collector = new PrometheusMetricsCollector();
 *
 * // Record cache hit (counter)
 * collector.incrementCounter('cache_hits_total', { cache_level: 'l1' });
 *
 * // Update cache size (gauge)
 * collector.setGauge('cache_size_bytes', 67108864, { cache_level: 'l1' });
 *
 * // Record latency (histogram)
 * collector.recordHistogram('cache_latency_ms', 2.5, { operation: 'read' });
 *
 * // Get all metrics for export
 * const snapshot = collector.getSnapshot();
 * ```
 */
export interface IMetricsCollector {
  /**
   * Define a new metric
   *
   * Must be called before recording values for a metric.
   * Idempotent: calling multiple times with same name is safe.
   *
   * @param definition - Metric definition
   */
  defineMetric(definition: MetricDefinition): void;

  /**
   * Increment a counter metric
   *
   * HOT PATH operation - must be <10μs.
   * Counters are monotonically increasing.
   *
   * @param name - Metric name
   * @param labels - Optional labels for dimensional data
   * @param delta - Amount to increment (default: 1)
   */
  incrementCounter(name: string, labels?: MetricLabels, delta?: number): void;

  /**
   * Set a gauge metric value
   *
   * HOT PATH operation - must be <10μs.
   * Gauges can go up or down.
   *
   * @param name - Metric name
   * @param value - New gauge value
   * @param labels - Optional labels for dimensional data
   */
  setGauge(name: string, value: number, labels?: MetricLabels): void;

  /**
   * Record a histogram observation
   *
   * HOT PATH operation - must be <10μs.
   * Histograms track distribution of values.
   *
   * @param name - Metric name
   * @param value - Observed value
   * @param labels - Optional labels for dimensional data
   */
  recordHistogram(name: string, value: number, labels?: MetricLabels): void;

  /**
   * Record a summary observation
   *
   * Similar to histogram but computes quantiles (p50, p95, p99).
   *
   * @param name - Metric name
   * @param value - Observed value
   * @param labels - Optional labels for dimensional data
   */
  recordSummary(name: string, value: number, labels?: MetricLabels): void;

  /**
   * Get current metric snapshot
   *
   * Returns all metrics and their current values.
   * Used by exporters to send metrics to monitoring systems.
   *
   * Performance: <1ms (background operation)
   *
   * @returns Array of metric snapshots
   */
  getSnapshot(): MetricSnapshot[];

  /**
   * Get snapshot for specific metric
   *
   * @param name - Metric name
   * @returns Metric snapshot or undefined if not found
   */
  getMetricSnapshot(name: string): MetricSnapshot | undefined;

  /**
   * Reset all metrics
   *
   * Used for testing and debugging.
   * NOT recommended for production use.
   */
  reset(): void;

  /**
   * Get collector statistics
   *
   * @returns Collector stats for monitoring
   */
  getStats(): CollectorStats;
}

/**
 * Metrics collector statistics
 */
export interface CollectorStats {
  /**
   * Total metrics defined
   */
  readonly metricsCount: number;

  /**
   * Total metric observations recorded
   */
  readonly totalObservations: number;

  /**
   * Memory usage estimate (bytes)
   */
  readonly memoryUsageBytes: number;

  /**
   * Breakdown by metric type
   */
  readonly byType: {
    readonly counters: number;
    readonly gauges: number;
    readonly histograms: number;
    readonly summaries: number;
  };
}
