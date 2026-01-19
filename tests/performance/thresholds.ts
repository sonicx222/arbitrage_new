/**
 * Performance Thresholds
 *
 * Defines acceptable performance limits for critical paths in the arbitrage system.
 * These values are used by performance tests to verify the system meets requirements.
 *
 * @see docs/TEST_ARCHITECTURE.md - Phase 4: Performance Testing
 */

export const PERFORMANCE_THRESHOLDS = {
  // =========================================================================
  // Detection Hot Path - Target: <50ms
  // =========================================================================

  /** Maximum time for complete arbitrage detection cycle */
  DETECTION_HOT_PATH_MS: 50,

  /** Maximum time for price calculation (pure function) */
  PRICE_CALCULATION_MS: 1,

  /** Maximum time for arbitrage opportunity detection */
  ARBITRAGE_DETECTION_MS: 10,

  /** Maximum time for spread calculation */
  SPREAD_CALCULATION_MS: 0.5,

  // =========================================================================
  // Execution Hot Path - Target: <500ms
  // =========================================================================

  /** Maximum time for complete execution cycle */
  EXECUTION_HOT_PATH_MS: 500,

  /** Maximum time for distributed lock acquisition */
  LOCK_ACQUISITION_MS: 50,

  /** Maximum time for nonce management */
  NONCE_MANAGEMENT_MS: 20,

  // =========================================================================
  // Data Infrastructure
  // =========================================================================

  /** Maximum time to add message to Redis stream */
  REDIS_STREAM_ADD_MS: 5,

  /** Maximum time to read from Redis stream */
  REDIS_STREAM_READ_MS: 10,

  /** Maximum time for price matrix lookup (microseconds) */
  PRICE_MATRIX_LOOKUP_US: 1,

  /** Maximum time for hierarchical cache lookup */
  CACHE_LOOKUP_MS: 1,

  // =========================================================================
  // Network & External
  // =========================================================================

  /** Maximum WebSocket message latency */
  WEBSOCKET_LATENCY_MS: 100,

  /** Maximum RPC call latency */
  RPC_CALL_MS: 200,

  // =========================================================================
  // Throughput Requirements
  // =========================================================================

  /** Minimum events processed per second */
  MIN_EVENTS_PER_SECOND: 1000,

  /** Minimum opportunities evaluated per second */
  MIN_OPPORTUNITIES_PER_SECOND: 500,

  // =========================================================================
  // Tolerance Settings
  // =========================================================================

  /** P99 multiplier for max latency (e.g., 2x means P99 can be 2x the target) */
  P99_MULTIPLIER: 2,

  /** Number of warmup iterations before measuring */
  WARMUP_ITERATIONS: 10,

  /** Number of measurement iterations for stable results */
  MEASUREMENT_ITERATIONS: 100,
};

/**
 * Performance measurement result
 */
export interface PerformanceResult {
  /** Average time in milliseconds */
  averageMs: number;
  /** Minimum time in milliseconds */
  minMs: number;
  /** Maximum time in milliseconds */
  maxMs: number;
  /** P50 (median) time in milliseconds */
  p50Ms: number;
  /** P95 time in milliseconds */
  p95Ms: number;
  /** P99 time in milliseconds */
  p99Ms: number;
  /** Standard deviation in milliseconds */
  stdDevMs: number;
  /** Number of iterations */
  iterations: number;
  /** Total time in milliseconds */
  totalMs: number;
}

/**
 * Measure performance of an operation
 *
 * @param operation - Function to measure
 * @param iterations - Number of iterations (default from thresholds)
 * @param warmupIterations - Number of warmup iterations (default from thresholds)
 * @returns Performance measurement result
 */
export async function measurePerformance<T>(
  operation: () => T | Promise<T>,
  iterations: number = PERFORMANCE_THRESHOLDS.MEASUREMENT_ITERATIONS,
  warmupIterations: number = PERFORMANCE_THRESHOLDS.WARMUP_ITERATIONS
): Promise<PerformanceResult> {
  // Warmup phase
  for (let i = 0; i < warmupIterations; i++) {
    await operation();
  }

  // Measurement phase
  const times: number[] = [];
  const startTotal = performance.now();

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await operation();
    const end = performance.now();
    times.push(end - start);
  }

  const endTotal = performance.now();

  // Calculate statistics
  times.sort((a, b) => a - b);

  const sum = times.reduce((a, b) => a + b, 0);
  const average = sum / times.length;
  const variance = times.reduce((acc, t) => acc + Math.pow(t - average, 2), 0) / times.length;

  return {
    averageMs: average,
    minMs: times[0],
    maxMs: times[times.length - 1],
    p50Ms: times[Math.floor(times.length * 0.5)],
    p95Ms: times[Math.floor(times.length * 0.95)],
    p99Ms: times[Math.floor(times.length * 0.99)],
    stdDevMs: Math.sqrt(variance),
    iterations,
    totalMs: endTotal - startTotal,
  };
}

/**
 * Assert that a performance result meets a threshold
 */
export function assertPerformance(
  result: PerformanceResult,
  thresholdMs: number,
  label: string
): void {
  const p99Threshold = thresholdMs * PERFORMANCE_THRESHOLDS.P99_MULTIPLIER;

  if (result.averageMs > thresholdMs) {
    throw new Error(
      `${label}: Average ${result.averageMs.toFixed(2)}ms exceeds threshold ${thresholdMs}ms`
    );
  }

  if (result.p99Ms > p99Threshold) {
    throw new Error(
      `${label}: P99 ${result.p99Ms.toFixed(2)}ms exceeds threshold ${p99Threshold}ms (${PERFORMANCE_THRESHOLDS.P99_MULTIPLIER}x target)`
    );
  }
}

/**
 * Format performance result for display
 */
export function formatPerformanceResult(result: PerformanceResult): string {
  return [
    `  avg: ${result.averageMs.toFixed(3)}ms`,
    `  min: ${result.minMs.toFixed(3)}ms`,
    `  max: ${result.maxMs.toFixed(3)}ms`,
    `  p50: ${result.p50Ms.toFixed(3)}ms`,
    `  p95: ${result.p95Ms.toFixed(3)}ms`,
    `  p99: ${result.p99Ms.toFixed(3)}ms`,
    `  stddev: ${result.stdDevMs.toFixed(3)}ms`,
    `  iterations: ${result.iterations}`,
  ].join('\n');
}
