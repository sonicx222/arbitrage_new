/**
 * CollectMetrics Use Case (Enhancement #3)
 *
 * Collects performance and operational metrics for monitoring.
 * Follows Use Case Pattern from Clean Architecture.
 *
 * @see docs/PRICEMATRIX_DEPLOYMENT.md - Performance monitoring section
 * @see metrics/domain/metrics-collector.interface.ts - IMetricsCollector contract
 *
 * @package @arbitrage/metrics
 * @module metrics/application/use-cases
 */

import { IMetricsCollector, MetricType } from '../../domain';
import { RecordMetricRequest, RecordMetricResponse } from '../dtos/collect-metrics.dto';
import { getErrorMessage } from '@arbitrage/core';

/**
 * Use Case: Collect performance metrics
 *
 * Responsibilities:
 * - Validate metric recording request
 * - Record metric in collector
 * - Return recording result with duration
 *
 * Dependencies (injected):
 * - IMetricsCollector - collects and stores metrics
 *
 * Performance:
 * - HOT PATH operation - must complete in <10μs
 * - Zero allocations in hot path
 * - Called frequently (100-1000/sec)
 *
 * Metric Types:
 * - Counter: Monotonically increasing (e.g., cache hits)
 * - Gauge: Value that can go up/down (e.g., cache size)
 * - Histogram: Distribution of values (e.g., latency)
 * - Summary: Similar to histogram with quantiles (p50, p95, p99)
 *
 * @example
 * ```typescript
 * const useCase = new CollectMetricsUseCase(metricsCollector);
 *
 * // Record cache hit (counter)
 * const request = RecordMetricRequest.counter('cache_hits_total', { cache_level: 'l1' });
 * const response = useCase.execute(request);
 * console.log(response.isWithinTarget()); // true (<10μs)
 *
 * // Record cache size (gauge)
 * const sizeRequest = RecordMetricRequest.gauge('cache_size_bytes', 67108864, { cache_level: 'l1' });
 * useCase.execute(sizeRequest);
 *
 * // Record latency (histogram)
 * const latencyRequest = RecordMetricRequest.histogram('cache_latency_ms', 2.5, { operation: 'read' });
 * useCase.execute(latencyRequest);
 * ```
 */
export class CollectMetricsUseCase {
  constructor(private readonly metricsCollector: IMetricsCollector) {}

  /**
   * Execute metric recording (HOT PATH)
   *
   * This is called FREQUENTLY, so must be extremely fast.
   *
   * Algorithm:
   * 1. Validate request (handled by DTO)
   * 2. Record metric based on type
   * 3. Return recording result with duration
   *
   * Performance:
   * - Target: <10μs
   * - Uses high-resolution timer (performance.now())
   * - Minimal error handling to avoid overhead
   *
   * @param request - Validated metric recording request
   * @returns Recording response with metrics
   */
  execute(request: RecordMetricRequest): RecordMetricResponse {
    const startTime = performance.now();

    try {
      // Record metric based on type (hot path)
      switch (request.type) {
        case MetricType.COUNTER:
          this.metricsCollector.incrementCounter(
            request.name,
            request.labels,
            request.value
          );
          break;

        case MetricType.GAUGE:
          this.metricsCollector.setGauge(
            request.name,
            request.value,
            request.labels
          );
          break;

        case MetricType.HISTOGRAM:
          this.metricsCollector.recordHistogram(
            request.name,
            request.value,
            request.labels
          );
          break;

        case MetricType.SUMMARY:
          this.metricsCollector.recordSummary(
            request.name,
            request.value,
            request.labels
          );
          break;

        default:
          throw new Error(`Unsupported metric type: ${request.type}`);
      }

      // Calculate duration in microseconds
      const durationMs = performance.now() - startTime;
      const durationUs = durationMs * 1000;

      return RecordMetricResponse.success(request.name, durationUs);
    } catch (error) {
      // Minimal error handling for hot path
      const durationMs = performance.now() - startTime;
      const durationUs = durationMs * 1000;
      const errorMessage = getErrorMessage(error);
      return RecordMetricResponse.failure(request.name, errorMessage, durationUs);
    }
  }

  /**
   * Record counter increment (convenience method)
   *
   * @param name - Counter name
   * @param labels - Optional labels
   * @param delta - Increment amount (default: 1)
   * @returns Recording response
   */
  recordCounter(
    name: string,
    labels?: Record<string, string>,
    delta: number = 1
  ): RecordMetricResponse {
    const request = RecordMetricRequest.counter(name, labels, delta);
    return this.execute(request);
  }

  /**
   * Record gauge value (convenience method)
   *
   * @param name - Gauge name
   * @param value - Gauge value
   * @param labels - Optional labels
   * @returns Recording response
   */
  recordGauge(
    name: string,
    value: number,
    labels?: Record<string, string>
  ): RecordMetricResponse {
    const request = RecordMetricRequest.gauge(name, value, labels);
    return this.execute(request);
  }

  /**
   * Record histogram observation (convenience method)
   *
   * @param name - Histogram name
   * @param value - Observed value
   * @param labels - Optional labels
   * @returns Recording response
   */
  recordHistogram(
    name: string,
    value: number,
    labels?: Record<string, string>
  ): RecordMetricResponse {
    const request = RecordMetricRequest.histogram(name, value, labels);
    return this.execute(request);
  }

  /**
   * Batch record metrics
   *
   * Useful for recording multiple metrics at once.
   *
   * @param requests - Array of metric recording requests
   * @returns Array of recording responses
   */
  executeBatch(requests: RecordMetricRequest[]): RecordMetricResponse[] {
    return requests.map(req => this.execute(req));
  }

  /**
   * Get current metric snapshot
   *
   * Returns all metrics and their current values.
   * Used for debugging and monitoring.
   *
   * @returns Array of metric snapshots
   */
  getSnapshot() {
    return this.metricsCollector.getSnapshot();
  }

  /**
   * Get specific metric snapshot
   *
   * @param name - Metric name
   * @returns Metric snapshot or undefined
   */
  getMetricSnapshot(name: string) {
    return this.metricsCollector.getMetricSnapshot(name);
  }

  /**
   * Get collector statistics
   *
   * @returns Collector stats for monitoring
   */
  getStats() {
    return this.metricsCollector.getStats();
  }

  /**
   * Reset all metrics
   *
   * Used for testing and debugging.
   * NOT recommended for production use.
   */
  reset(): void {
    this.metricsCollector.reset();
  }
}
