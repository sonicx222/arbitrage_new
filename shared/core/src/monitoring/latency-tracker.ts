/**
 * E2E Pipeline Latency Tracker
 *
 * Tracks latency across pipeline stages: WebSocket -> Batcher -> Detector -> Publish.
 * Uses Float64Array ring buffers for zero-allocation hot-path recording.
 * Exposes p50/p95/p99 percentile metrics.
 *
 * Design:
 * - Each pipeline stage has its own Float64Array ring buffer (ADR-022 pattern)
 * - Recording is O(1) with no GC pressure on the hot path
 * - Percentile calculation is O(n log n) via sort-on-read (called infrequently)
 * - Constructor DI pattern for testability
 *
 * @custom:version 1.0.0
 * @see ADR-022 Hot-path memory optimization
 * @see PipelineTimestamps in @arbitrage/types for stage timestamp fields
 */

import type { PipelineTimestamps } from '@arbitrage/types';
import type { ILogger } from '../logging/types';

// =============================================================================
// Types
// =============================================================================

/**
 * Percentile statistics for a latency distribution.
 */
export interface PercentileStats {
  /** 50th percentile (median) in milliseconds */
  p50: number;
  /** 95th percentile in milliseconds */
  p95: number;
  /** 99th percentile in milliseconds */
  p99: number;
  /** Total number of recorded samples */
  count: number;
  /** Average latency in milliseconds */
  avg: number;
}

/**
 * Complete latency metrics for the pipeline.
 */
export interface LatencyMetrics {
  /** Full pipeline latency (wsReceivedAt -> executionReceivedAt or last available) */
  e2e: PercentileStats;
  /** WebSocket receive to detector latency */
  wsToDetector: PercentileStats;
  /** Detector to publish latency */
  detectorToPublish: PercentileStats;
  /** Per-stage breakdown keyed by stage name */
  stageBreakdown: Record<string, PercentileStats>;
}

/**
 * Configuration for the latency tracker.
 */
export interface LatencyTrackerConfig {
  /** Ring buffer capacity per stage (default: 1000) */
  bufferCapacity?: number;
  /** Logger instance for diagnostic output */
  logger?: ILogger;
}

/**
 * Default pipeline stage names.
 */
export const PIPELINE_STAGES = [
  'ws_receive',
  'batcher_flush',
  'detector_process',
  'opportunity_publish',
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

// =============================================================================
// Ring Buffer (internal)
// =============================================================================

/**
 * Lightweight Float64Array ring buffer for a single latency series.
 * Following ADR-022 pattern: pre-allocated, zero-allocation hot path.
 */
class LatencyRingBuffer {
  private readonly buffer: Float64Array;
  private readonly capacity: number;
  private index = 0;
  private count = 0;
  private sum = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buffer = new Float64Array(capacity);
  }

  /**
   * Record a latency sample. O(1), no allocation.
   */
  record(latencyMs: number): void {
    // Guard against NaN poisoning the running sum
    if (Number.isNaN(latencyMs)) return;

    if (this.count === this.capacity) {
      this.sum -= this.buffer[this.index];
    } else {
      this.count++;
    }

    this.buffer[this.index] = latencyMs;
    this.sum += latencyMs;
    this.index = (this.index + 1) % this.capacity;
  }

  /**
   * Get current sample count.
   */
  getCount(): number {
    return this.count;
  }

  /**
   * Get average latency. O(1).
   */
  getAverage(): number {
    if (this.count === 0) return 0;
    return this.sum / this.count;
  }

  /**
   * Get a sorted copy of the active samples for percentile calculation.
   * O(n log n) -- only called on metrics read, not on hot path.
   */
  getSortedSamples(): Float64Array {
    if (this.count === 0) return new Float64Array(0);

    // Copy active samples into a new array
    const samples = new Float64Array(this.count);
    if (this.count < this.capacity) {
      // Buffer not yet full: samples are at indices [0, count)
      samples.set(this.buffer.subarray(0, this.count));
    } else {
      // Buffer full: oldest is at this.index, wraps around
      const tail = this.buffer.subarray(this.index);
      const head = this.buffer.subarray(0, this.index);
      samples.set(tail, 0);
      samples.set(head, tail.length);
    }

    samples.sort();
    return samples;
  }

  /**
   * Reset the buffer.
   */
  clear(): void {
    this.buffer.fill(0);
    this.index = 0;
    this.count = 0;
    this.sum = 0;
  }
}

// =============================================================================
// Latency Tracker
// =============================================================================

/**
 * E2E pipeline latency tracker.
 *
 * Tracks latency across pipeline stages using Float64Array ring buffers
 * for zero-allocation hot-path recording. Exposes p50/p95/p99 metrics.
 *
 * @example
 * ```typescript
 * const tracker = new LatencyTracker({ bufferCapacity: 1000 });
 *
 * // Hot-path recording (O(1), no allocation)
 * tracker.recordStageLatency('ws_receive', 2.5);
 * tracker.recordStageLatency('detector_process', 12.3);
 * tracker.recordE2ELatency(45.2);
 *
 * // From pipeline timestamps
 * tracker.recordFromTimestamps({
 *   wsReceivedAt: 1000,
 *   detectedAt: 1035,
 *   coordinatorAt: 1042,
 * });
 *
 * // Read metrics (infrequent, O(n log n))
 * const metrics = tracker.getMetrics();
 * console.log(metrics.e2e.p95); // 95th percentile E2E latency
 * ```
 */
export class LatencyTracker {
  private readonly bufferCapacity: number;
  private readonly logger: ILogger | undefined;

  /** Ring buffer for full E2E latency */
  private readonly e2eBuffer: LatencyRingBuffer;
  /** Ring buffer for WS -> Detector latency */
  private readonly wsToDetectorBuffer: LatencyRingBuffer;
  /** Ring buffer for Detector -> Publish latency */
  private readonly detectorToPublishBuffer: LatencyRingBuffer;

  /** Per-stage ring buffers keyed by stage name */
  private readonly stageBuffers: Map<string, LatencyRingBuffer> = new Map();

  constructor(config?: LatencyTrackerConfig) {
    this.bufferCapacity = config?.bufferCapacity ?? 1000;
    this.logger = config?.logger;

    this.e2eBuffer = new LatencyRingBuffer(this.bufferCapacity);
    this.wsToDetectorBuffer = new LatencyRingBuffer(this.bufferCapacity);
    this.detectorToPublishBuffer = new LatencyRingBuffer(this.bufferCapacity);

    // Pre-allocate buffers for default pipeline stages
    for (const stage of PIPELINE_STAGES) {
      this.stageBuffers.set(stage, new LatencyRingBuffer(this.bufferCapacity));
    }

    this.logger?.debug('LatencyTracker initialized', {
      bufferCapacity: this.bufferCapacity,
      stages: PIPELINE_STAGES.length,
    });
  }

  // ===========================================================================
  // Hot-path recording methods (O(1), zero allocation)
  // ===========================================================================

  /**
   * Record a latency sample for a specific pipeline stage.
   * Hot path: O(1), no allocation.
   *
   * @param stage - Stage name (e.g., 'ws_receive', 'detector_process')
   * @param latencyMs - Latency in milliseconds
   */
  recordStageLatency(stage: string, latencyMs: number): void {
    let buffer = this.stageBuffers.get(stage);
    if (!buffer) {
      // Lazily create buffer for custom stages
      buffer = new LatencyRingBuffer(this.bufferCapacity);
      this.stageBuffers.set(stage, buffer);
    }
    buffer.record(latencyMs);
  }

  /**
   * Record a full end-to-end pipeline latency.
   * Hot path: O(1), no allocation.
   *
   * @param latencyMs - E2E latency in milliseconds
   */
  recordE2ELatency(latencyMs: number): void {
    this.e2eBuffer.record(latencyMs);
  }

  /**
   * Calculate and record latencies from pipeline timestamps.
   *
   * Derives latencies from the PipelineTimestamps interface fields:
   * - E2E: wsReceivedAt -> last available timestamp
   * - WS to Detector: wsReceivedAt -> detectedAt
   * - Detector to Publish: detectedAt -> coordinatorAt
   * - Individual stage latencies from sequential timestamps
   *
   * @param timestamps - Pipeline timestamps from a price update or opportunity
   */
  recordFromTimestamps(timestamps: PipelineTimestamps): void {
    const {
      wsReceivedAt,
      publishedAt,
      consumedAt,
      detectedAt,
      coordinatorAt,
      executionReceivedAt,
    } = timestamps;

    // E2E latency: from WS receive to the last available timestamp
    if (wsReceivedAt !== undefined) {
      const endTimestamp =
        executionReceivedAt ?? coordinatorAt ?? detectedAt ?? publishedAt;
      if (endTimestamp !== undefined) {
        this.e2eBuffer.record(endTimestamp - wsReceivedAt);
      }
    }

    // WS to Detector
    if (wsReceivedAt !== undefined && detectedAt !== undefined) {
      this.wsToDetectorBuffer.record(detectedAt - wsReceivedAt);
    }

    // Detector to Publish (coordinator)
    if (detectedAt !== undefined && coordinatorAt !== undefined) {
      this.detectorToPublishBuffer.record(coordinatorAt - detectedAt);
    }

    // Individual stage latencies from sequential timestamps
    if (wsReceivedAt !== undefined && publishedAt !== undefined) {
      this.recordStageLatency('ws_receive', publishedAt - wsReceivedAt);
    }
    if (publishedAt !== undefined && consumedAt !== undefined) {
      this.recordStageLatency('batcher_flush', consumedAt - publishedAt);
    }
    if (consumedAt !== undefined && detectedAt !== undefined) {
      this.recordStageLatency('detector_process', detectedAt - consumedAt);
    }
    if (detectedAt !== undefined && coordinatorAt !== undefined) {
      this.recordStageLatency('opportunity_publish', coordinatorAt - detectedAt);
    }
  }

  // ===========================================================================
  // Metrics read methods (infrequent, O(n log n) for percentiles)
  // ===========================================================================

  /**
   * Get current latency metrics with percentile breakdowns.
   *
   * @returns Complete latency metrics for all tracked stages
   */
  getMetrics(): LatencyMetrics {
    const stageBreakdown: Record<string, PercentileStats> = {};
    for (const [stage, buffer] of this.stageBuffers) {
      stageBreakdown[stage] = this.computePercentiles(buffer);
    }

    return {
      e2e: this.computePercentiles(this.e2eBuffer),
      wsToDetector: this.computePercentiles(this.wsToDetectorBuffer),
      detectorToPublish: this.computePercentiles(this.detectorToPublishBuffer),
      stageBreakdown,
    };
  }

  /**
   * Get health-endpoint-friendly data.
   * Returns a plain object suitable for JSON serialization in health responses.
   */
  getHealthData(): {
    e2e: PercentileStats;
    wsToDetector: PercentileStats;
    detectorToPublish: PercentileStats;
    stageBreakdown: Record<string, PercentileStats>;
    bufferCapacity: number;
  } {
    const metrics = this.getMetrics();
    return {
      ...metrics,
      bufferCapacity: this.bufferCapacity,
    };
  }

  /**
   * Reset all latency buffers.
   */
  reset(): void {
    this.e2eBuffer.clear();
    this.wsToDetectorBuffer.clear();
    this.detectorToPublishBuffer.clear();
    for (const buffer of this.stageBuffers.values()) {
      buffer.clear();
    }
    this.logger?.debug('LatencyTracker reset');
  }

  // ===========================================================================
  // Internal helpers
  // ===========================================================================

  /**
   * Compute p50/p95/p99 percentiles from a ring buffer.
   * O(n log n) due to sort. Only called on metrics read.
   */
  private computePercentiles(buffer: LatencyRingBuffer): PercentileStats {
    const count = buffer.getCount();

    if (count === 0) {
      return { p50: 0, p95: 0, p99: 0, count: 0, avg: 0 };
    }

    const sorted = buffer.getSortedSamples();

    return {
      p50: this.percentileFromSorted(sorted, 0.50),
      p95: this.percentileFromSorted(sorted, 0.95),
      p99: this.percentileFromSorted(sorted, 0.99),
      count,
      avg: buffer.getAverage(),
    };
  }

  /**
   * Get the value at a given percentile from a sorted array.
   * Uses nearest-rank method.
   *
   * @param sorted - Sorted Float64Array of samples
   * @param percentile - Percentile as fraction (0.0 - 1.0)
   * @returns Value at the given percentile
   */
  private percentileFromSorted(sorted: Float64Array, percentile: number): number {
    const index = Math.ceil(percentile * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }
}

// =============================================================================
// Singleton / Factory
// =============================================================================

let globalLatencyTracker: LatencyTracker | null = null;

/**
 * Get or create the global LatencyTracker singleton.
 *
 * @param config - Optional configuration (only used on first call)
 * @returns The global LatencyTracker instance
 */
export function getLatencyTracker(config?: LatencyTrackerConfig): LatencyTracker {
  if (!globalLatencyTracker) {
    globalLatencyTracker = new LatencyTracker(config);
  }
  return globalLatencyTracker;
}

/**
 * Reset the global LatencyTracker singleton (for testing).
 */
export function resetLatencyTracker(): void {
  if (globalLatencyTracker) {
    globalLatencyTracker.reset();
    globalLatencyTracker = null;
  }
}
