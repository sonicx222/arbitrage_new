/**
 * Provider & RPC Latency Tracker
 *
 * Phase 2 Enhanced Monitoring: Tracks provider/RPC quality metrics:
 * - C1: RPC call duration per chain/method (ring buffer, Prometheus histogram)
 * - C3: WebSocket reconnection duration per chain (ring buffer)
 * - C4: RPC error counts per chain/error_type (counters)
 *
 * Uses Float64Array ring buffers (ADR-022 pattern) for zero-allocation
 * hot-path recording. Exposes data as structured metrics and Prometheus
 * text exposition format.
 *
 * @custom:version 1.0.0
 * @see ADR-022 Hot-path memory optimization
 * @see shared/core/src/monitoring/latency-tracker.ts — ring buffer pattern
 */

// =============================================================================
// Types
// =============================================================================

/** Percentile stats for a metric distribution. */
export interface ProviderPercentileStats {
  p50: number;
  p95: number;
  p99: number;
  count: number;
  avg: number;
  totalRecorded: number;
}

/** RPC call metrics grouped by chain. */
export interface RpcCallMetrics {
  /** Per-chain call duration stats */
  byChain: Record<string, ProviderPercentileStats>;
  /** Per-method call duration stats */
  byMethod: Record<string, ProviderPercentileStats>;
}

/** WebSocket reconnection metrics grouped by chain. */
export interface ReconnectionMetrics {
  byChain: Record<string, ProviderPercentileStats>;
}

/** RPC error counts grouped by chain and error type. */
export interface RpcErrorMetrics {
  byChainAndType: Record<string, number>;
  byChain: Record<string, number>;
  byType: Record<string, number>;
  total: number;
}

/** Complete provider latency metrics. */
export interface ProviderLatencyMetrics {
  rpcCalls: RpcCallMetrics;
  reconnections: ReconnectionMetrics;
  errors: RpcErrorMetrics;
}

/** Configuration for the provider latency tracker. */
export interface ProviderLatencyTrackerConfig {
  /** Ring buffer capacity (default: 500) */
  bufferCapacity?: number;
}

// =============================================================================
// Ring Buffer (internal — lightweight copy from latency-tracker.ts)
// =============================================================================

class RingBuffer {
  private readonly buffer: Float64Array;
  private readonly capacity: number;
  private index = 0;
  private count = 0;
  private sum = 0;
  totalRecorded = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buffer = new Float64Array(capacity);
  }

  record(value: number): void {
    if (Number.isNaN(value)) return;
    this.totalRecorded++;
    if (this.count === this.capacity) {
      this.sum -= this.buffer[this.index];
    } else {
      this.count++;
    }
    this.buffer[this.index] = value;
    this.sum += value;
    this.index = (this.index + 1) % this.capacity;
  }

  getCount(): number {
    return this.count;
  }

  getAverage(): number {
    if (this.count === 0) return 0;
    return this.sum / this.count;
  }

  getSortedSamples(): Float64Array {
    if (this.count === 0) return new Float64Array(0);
    const samples = new Float64Array(this.count);
    if (this.count < this.capacity) {
      samples.set(this.buffer.subarray(0, this.count));
    } else {
      const tail = this.buffer.subarray(this.index);
      const head = this.buffer.subarray(0, this.index);
      samples.set(tail, 0);
      samples.set(head, tail.length);
    }
    samples.sort();
    return samples;
  }

  clear(): void {
    this.buffer.fill(0);
    this.index = 0;
    this.count = 0;
    this.sum = 0;
    this.totalRecorded = 0;
  }
}

// =============================================================================
// ProviderLatencyTracker
// =============================================================================

/**
 * Provider & RPC latency tracker.
 *
 * Records RPC call durations, reconnection times, and error counts.
 * Uses Float64Array ring buffers for zero-allocation hot-path recording.
 *
 * @example
 * ```typescript
 * const tracker = getProviderLatencyTracker();
 *
 * // Record RPC call timing (hot path — O(1))
 * const start = Date.now();
 * const result = await provider.call(tx);
 * tracker.recordRpcCall('bsc', 'eth_call', Date.now() - start);
 *
 * // Record an RPC error
 * tracker.recordRpcError('bsc', 'timeout');
 *
 * // Record reconnection duration
 * tracker.recordReconnection('ethereum', 3200);
 *
 * // Read metrics (infrequent)
 * const metrics = tracker.getMetrics();
 * const promText = tracker.getPrometheusMetrics();
 * ```
 */
export class ProviderLatencyTracker {
  private readonly bufferCapacity: number;

  /** Per-chain RPC call duration ring buffers */
  private readonly chainBuffers = new Map<string, RingBuffer>();
  /** Per-method RPC call duration ring buffers */
  private readonly methodBuffers = new Map<string, RingBuffer>();
  /** Per-chain reconnection duration ring buffers */
  private readonly reconnectionBuffers = new Map<string, RingBuffer>();

  /** Error counters: key = "chain:errorType" */
  private readonly errorCounters = new Map<string, number>();

  /** WebSocket message rate counters: key = "chain:eventType" */
  private readonly messageCounters = new Map<string, number>();

  constructor(config?: ProviderLatencyTrackerConfig) {
    this.bufferCapacity = config?.bufferCapacity ?? 500;
  }

  // ===========================================================================
  // Hot-path recording methods (O(1), zero allocation)
  // ===========================================================================

  /**
   * Record an RPC call duration.
   * Hot path: O(1), no allocation (after first call per chain/method).
   *
   * @param chain - Chain identifier (e.g., 'bsc', 'ethereum')
   * @param method - RPC method (e.g., 'eth_call', 'eth_getBalance')
   * @param durationMs - Call duration in milliseconds
   */
  recordRpcCall(chain: string, method: string, durationMs: number): void {
    this.getOrCreateBuffer(this.chainBuffers, chain).record(durationMs);
    this.getOrCreateBuffer(this.methodBuffers, method).record(durationMs);
  }

  /**
   * Record an RPC error.
   * Hot path: O(1).
   *
   * @param chain - Chain identifier
   * @param errorType - Error category (e.g., 'timeout', 'rate_limit', 'internal')
   */
  recordRpcError(chain: string, errorType: string): void {
    const chainKey = `chain:${chain}`;
    const typeKey = `type:${errorType}`;
    const combinedKey = `${chain}:${errorType}`;

    this.errorCounters.set(combinedKey, (this.errorCounters.get(combinedKey) ?? 0) + 1);
    this.errorCounters.set(chainKey, (this.errorCounters.get(chainKey) ?? 0) + 1);
    this.errorCounters.set(typeKey, (this.errorCounters.get(typeKey) ?? 0) + 1);
    this.errorCounters.set('total', (this.errorCounters.get('total') ?? 0) + 1);
  }

  /**
   * Record a WebSocket reconnection duration.
   * Cold path: called infrequently (only on reconnect events).
   *
   * @param chain - Chain identifier
   * @param durationMs - Time from disconnect to successful reconnect in ms
   */
  recordReconnection(chain: string, durationMs: number): void {
    this.getOrCreateBuffer(this.reconnectionBuffers, chain).record(durationMs);
  }

  /**
   * Record a WebSocket message by type.
   * Hot path: O(1).
   *
   * @param chain - Chain identifier
   * @param eventType - Event type (e.g., 'sync', 'swap_v2', 'swap_v3', 'newHeads')
   */
  recordWsMessage(chain: string, eventType: string): void {
    const key = `${chain}:${eventType}`;
    this.messageCounters.set(key, (this.messageCounters.get(key) ?? 0) + 1);
  }

  // ===========================================================================
  // Metrics read methods (infrequent, O(n log n) for percentiles)
  // ===========================================================================

  /** Get current provider latency metrics. */
  getMetrics(): ProviderLatencyMetrics {
    return {
      rpcCalls: {
        byChain: this.computeBufferStats(this.chainBuffers),
        byMethod: this.computeBufferStats(this.methodBuffers),
      },
      reconnections: {
        byChain: this.computeBufferStats(this.reconnectionBuffers),
      },
      errors: this.computeErrorMetrics(),
    };
  }

  /** Get WebSocket message counts. */
  getMessageCounts(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [key, count] of this.messageCounters) {
      result[key] = count;
    }
    return result;
  }

  /**
   * Get metrics in Prometheus text exposition format.
   */
  getPrometheusMetrics(): string {
    const lines: string[] = [];

    // RPC call duration by chain
    lines.push('# HELP provider_rpc_call_duration_ms RPC call duration in milliseconds');
    lines.push('# TYPE provider_rpc_call_duration_ms gauge');
    for (const [chain, buffer] of this.chainBuffers) {
      const stats = this.computePercentiles(buffer);
      lines.push(`provider_rpc_call_duration_ms{chain="${chain}",quantile="0.5"} ${stats.p50}`);
      lines.push(`provider_rpc_call_duration_ms{chain="${chain}",quantile="0.95"} ${stats.p95}`);
      lines.push(`provider_rpc_call_duration_ms{chain="${chain}",quantile="0.99"} ${stats.p99}`);
    }

    // RPC call duration by method
    lines.push('# HELP provider_rpc_method_duration_ms RPC call duration by method in milliseconds');
    lines.push('# TYPE provider_rpc_method_duration_ms gauge');
    for (const [method, buffer] of this.methodBuffers) {
      const stats = this.computePercentiles(buffer);
      lines.push(`provider_rpc_method_duration_ms{method="${method}",quantile="0.5"} ${stats.p50}`);
      lines.push(`provider_rpc_method_duration_ms{method="${method}",quantile="0.95"} ${stats.p95}`);
    }

    // Reconnection duration by chain
    lines.push('# HELP provider_ws_reconnection_duration_ms WebSocket reconnection duration in ms');
    lines.push('# TYPE provider_ws_reconnection_duration_ms gauge');
    for (const [chain, buffer] of this.reconnectionBuffers) {
      const stats = this.computePercentiles(buffer);
      lines.push(`provider_ws_reconnection_duration_ms{chain="${chain}",quantile="0.5"} ${stats.p50}`);
      lines.push(`provider_ws_reconnection_duration_ms{chain="${chain}",quantile="0.95"} ${stats.p95}`);
    }

    // RPC errors by chain and type
    lines.push('# HELP provider_rpc_errors_total RPC errors by chain and type');
    lines.push('# TYPE provider_rpc_errors_total counter');
    for (const [key, count] of this.errorCounters) {
      // Only output combined keys (chain:errorType), not aggregated ones
      if (!key.startsWith('chain:') && !key.startsWith('type:') && key !== 'total') {
        const [chain, errorType] = key.split(':');
        lines.push(`provider_rpc_errors_total{chain="${chain}",error_type="${errorType}"} ${count}`);
      }
    }

    // WebSocket message rate by chain and event type
    lines.push('# HELP provider_ws_messages_total WebSocket messages received');
    lines.push('# TYPE provider_ws_messages_total counter');
    for (const [key, count] of this.messageCounters) {
      const [chain, eventType] = key.split(':');
      lines.push(`provider_ws_messages_total{chain="${chain}",event_type="${eventType}"} ${count}`);
    }

    return lines.join('\n') + '\n';
  }

  /** Reset all metrics. */
  reset(): void {
    for (const buffer of this.chainBuffers.values()) buffer.clear();
    for (const buffer of this.methodBuffers.values()) buffer.clear();
    for (const buffer of this.reconnectionBuffers.values()) buffer.clear();
    this.chainBuffers.clear();
    this.methodBuffers.clear();
    this.reconnectionBuffers.clear();
    this.errorCounters.clear();
    this.messageCounters.clear();
  }

  // ===========================================================================
  // Internal helpers
  // ===========================================================================

  private getOrCreateBuffer(map: Map<string, RingBuffer>, key: string): RingBuffer {
    let buffer = map.get(key);
    if (!buffer) {
      buffer = new RingBuffer(this.bufferCapacity);
      map.set(key, buffer);
    }
    return buffer;
  }

  private computePercentiles(buffer: RingBuffer): ProviderPercentileStats {
    const count = buffer.getCount();
    if (count === 0) {
      return { p50: 0, p95: 0, p99: 0, count: 0, avg: 0, totalRecorded: buffer.totalRecorded };
    }
    const sorted = buffer.getSortedSamples();
    return {
      p50: this.percentileFromSorted(sorted, 0.50),
      p95: this.percentileFromSorted(sorted, 0.95),
      p99: this.percentileFromSorted(sorted, 0.99),
      count,
      avg: buffer.getAverage(),
      totalRecorded: buffer.totalRecorded,
    };
  }

  private percentileFromSorted(sorted: Float64Array, percentile: number): number {
    const index = Math.ceil(percentile * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  private computeBufferStats(map: Map<string, RingBuffer>): Record<string, ProviderPercentileStats> {
    const result: Record<string, ProviderPercentileStats> = {};
    for (const [key, buffer] of map) {
      result[key] = this.computePercentiles(buffer);
    }
    return result;
  }

  private computeErrorMetrics(): RpcErrorMetrics {
    const byChainAndType: Record<string, number> = {};
    const byChain: Record<string, number> = {};
    const byType: Record<string, number> = {};

    for (const [key, count] of this.errorCounters) {
      if (key.startsWith('chain:')) {
        byChain[key.substring(6)] = count;
      } else if (key.startsWith('type:')) {
        byType[key.substring(5)] = count;
      } else if (key !== 'total') {
        byChainAndType[key] = count;
      }
    }

    return {
      byChainAndType,
      byChain,
      byType,
      total: this.errorCounters.get('total') ?? 0,
    };
  }
}

// =============================================================================
// Singleton
// =============================================================================

let globalProviderLatencyTracker: ProviderLatencyTracker | null = null;

/**
 * Get or create the global ProviderLatencyTracker singleton.
 */
export function getProviderLatencyTracker(config?: ProviderLatencyTrackerConfig): ProviderLatencyTracker {
  if (!globalProviderLatencyTracker) {
    globalProviderLatencyTracker = new ProviderLatencyTracker(config);
  }
  return globalProviderLatencyTracker;
}

/**
 * Reset the global ProviderLatencyTracker singleton (for testing).
 */
export function resetProviderLatencyTracker(): void {
  if (globalProviderLatencyTracker) {
    globalProviderLatencyTracker.reset();
    globalProviderLatencyTracker = null;
  }
}
