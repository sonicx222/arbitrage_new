/**
 * Node.js Runtime Health Monitor
 *
 * Tracks event loop delay, GC pauses, and memory breakdown for
 * runtime health observability. Exposes data as structured metrics
 * and Prometheus text format.
 *
 * Design:
 * - Event loop delay via perf_hooks.monitorEventLoopDelay() (nanosecond precision)
 * - GC pauses via PerformanceObserver on 'gc' entries
 * - Memory breakdown from process.memoryUsage() (on-demand, not polled)
 * - Singleton via getRuntimeMonitor() + resetRuntimeMonitor() (matches LatencyTracker pattern)
 *
 * @custom:version 1.0.0
 * @see ADR-022 Hot-path memory optimization
 * @see shared/core/src/monitoring/latency-tracker.ts — singleton pattern reference
 */

import { monitorEventLoopDelay, PerformanceObserver } from 'perf_hooks';
import type { IntervalHistogram } from 'perf_hooks';

// =============================================================================
// Types
// =============================================================================

/** Event loop delay metrics in milliseconds. */
export interface EventLoopMetrics {
  min: number;
  max: number;
  mean: number;
  p50: number;
  p99: number;
}

/** Process memory breakdown in megabytes. */
export interface MemoryMetrics {
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
  arrayBuffers: number;
}

/** GC pause aggregates. */
export interface GcMetrics {
  /** Cumulative GC pause time in ms */
  totalPauseMs: number;
  /** Total GC events observed */
  count: number;
  /** Major (mark-sweep-compact) GC events */
  majorCount: number;
}

/** Complete runtime metrics snapshot. */
export interface RuntimeMetrics {
  eventLoop: EventLoopMetrics;
  memory: MemoryMetrics;
  gc: GcMetrics;
}

// =============================================================================
// Constants
// =============================================================================

const NS_TO_MS = 1e-6;
const BYTES_TO_MB = 1 / (1024 * 1024);

/**
 * GC flags from Node.js performance API.
 * @see https://nodejs.org/api/perf_hooks.html#performancenodetiming
 */
const GC_FLAG_MAJOR = 4; // kGCTypeMarkSweepCompact

// =============================================================================
// RuntimeMonitor
// =============================================================================

/**
 * Node.js runtime health monitor.
 *
 * Tracks event loop delay, GC pauses, and memory breakdown.
 * Start/stop controls the event loop delay histogram and GC observer.
 * Memory is always available (read from process.memoryUsage on demand).
 *
 * @example
 * ```typescript
 * const monitor = getRuntimeMonitor();
 * monitor.start();
 *
 * // Read metrics (e.g., on /metrics endpoint)
 * const metrics = monitor.getMetrics();
 * const promText = monitor.getPrometheusMetrics();
 *
 * // Cleanup
 * monitor.stop();
 * ```
 */
export class RuntimeMonitor {
  private histogram: IntervalHistogram | null = null;
  private gcObserver: PerformanceObserver | null = null;
  private running = false;

  // GC accumulators
  private gcTotalPauseMs = 0;
  private gcCount = 0;
  private gcMajorCount = 0;

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /** Start monitoring event loop delay and GC pauses. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Event loop delay histogram (11ms resolution, standard default)
    this.histogram = monitorEventLoopDelay({ resolution: 11 });
    this.histogram.enable();

    // GC observer
    try {
      this.gcObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.gcCount++;
          this.gcTotalPauseMs += entry.duration;
          // Node.js GC entries have a `detail` with `kind` field
          const detail = (entry as unknown as { detail?: { kind?: number } }).detail;
          if (detail?.kind === GC_FLAG_MAJOR) {
            this.gcMajorCount++;
          }
        }
      });
      this.gcObserver.observe({ type: 'gc', buffered: true });
    } catch {
      // GC observation may not be available in all environments (e.g., some test runners)
      this.gcObserver = null;
    }
  }

  /** Stop monitoring. Idempotent. */
  stop(): void {
    if (this.histogram) {
      this.histogram.disable();
      this.histogram = null;
    }
    if (this.gcObserver) {
      this.gcObserver.disconnect();
      this.gcObserver = null;
    }
    this.running = false;
  }

  /** Whether monitoring is active. */
  isRunning(): boolean {
    return this.running;
  }

  // ===========================================================================
  // Metrics
  // ===========================================================================

  /** Get current runtime metrics snapshot. */
  getMetrics(): RuntimeMetrics {
    return {
      eventLoop: this.getEventLoopMetrics(),
      memory: this.getMemoryMetrics(),
      gc: this.getGcMetrics(),
    };
  }

  /**
   * Get runtime metrics in Prometheus text exposition format.
   * Appended to the service's /metrics endpoint output.
   */
  getPrometheusMetrics(): string {
    const m = this.getMetrics();
    const lines: string[] = [];

    // Event loop delay
    lines.push('# HELP runtime_eventloop_delay_min_ms Event loop delay minimum in ms');
    lines.push('# TYPE runtime_eventloop_delay_min_ms gauge');
    lines.push(`runtime_eventloop_delay_min_ms ${m.eventLoop.min}`);
    lines.push('# HELP runtime_eventloop_delay_max_ms Event loop delay maximum in ms');
    lines.push('# TYPE runtime_eventloop_delay_max_ms gauge');
    lines.push(`runtime_eventloop_delay_max_ms ${m.eventLoop.max}`);
    lines.push('# HELP runtime_eventloop_delay_mean_ms Event loop delay mean in ms');
    lines.push('# TYPE runtime_eventloop_delay_mean_ms gauge');
    lines.push(`runtime_eventloop_delay_mean_ms ${m.eventLoop.mean}`);
    lines.push('# HELP runtime_eventloop_delay_p50_ms Event loop delay 50th percentile in ms');
    lines.push('# TYPE runtime_eventloop_delay_p50_ms gauge');
    lines.push(`runtime_eventloop_delay_p50_ms ${m.eventLoop.p50}`);
    lines.push('# HELP runtime_eventloop_delay_p99_ms Event loop delay 99th percentile in ms');
    lines.push('# TYPE runtime_eventloop_delay_p99_ms gauge');
    lines.push(`runtime_eventloop_delay_p99_ms ${m.eventLoop.p99}`);

    // Memory
    lines.push('# HELP runtime_memory_heap_used_mb Heap used in megabytes');
    lines.push('# TYPE runtime_memory_heap_used_mb gauge');
    lines.push(`runtime_memory_heap_used_mb ${m.memory.heapUsed}`);
    lines.push('# HELP runtime_memory_heap_total_mb Heap total in megabytes');
    lines.push('# TYPE runtime_memory_heap_total_mb gauge');
    lines.push(`runtime_memory_heap_total_mb ${m.memory.heapTotal}`);
    lines.push('# HELP runtime_memory_rss_mb Resident set size in megabytes');
    lines.push('# TYPE runtime_memory_rss_mb gauge');
    lines.push(`runtime_memory_rss_mb ${m.memory.rss}`);
    lines.push('# HELP runtime_memory_external_mb External memory in megabytes');
    lines.push('# TYPE runtime_memory_external_mb gauge');
    lines.push(`runtime_memory_external_mb ${m.memory.external}`);
    lines.push('# HELP runtime_memory_array_buffers_mb ArrayBuffer memory in megabytes');
    lines.push('# TYPE runtime_memory_array_buffers_mb gauge');
    lines.push(`runtime_memory_array_buffers_mb ${m.memory.arrayBuffers}`);

    // GC
    lines.push('# HELP runtime_gc_pause_total_ms Cumulative GC pause time in ms');
    lines.push('# TYPE runtime_gc_pause_total_ms counter');
    lines.push(`runtime_gc_pause_total_ms ${m.gc.totalPauseMs}`);
    lines.push('# HELP runtime_gc_count_total Total GC events');
    lines.push('# TYPE runtime_gc_count_total counter');
    lines.push(`runtime_gc_count_total ${m.gc.count}`);
    lines.push('# HELP runtime_gc_major_count_total Major GC events');
    lines.push('# TYPE runtime_gc_major_count_total counter');
    lines.push(`runtime_gc_major_count_total ${m.gc.majorCount}`);

    return lines.join('\n') + '\n';
  }

  // ===========================================================================
  // Internal
  // ===========================================================================

  private getEventLoopMetrics(): EventLoopMetrics {
    if (!this.histogram) {
      return { min: 0, max: 0, mean: 0, p50: 0, p99: 0 };
    }

    return {
      min: round(this.histogram.min * NS_TO_MS),
      max: round(this.histogram.max * NS_TO_MS),
      mean: round(this.histogram.mean * NS_TO_MS),
      p50: round(this.histogram.percentile(50) * NS_TO_MS),
      p99: round(this.histogram.percentile(99) * NS_TO_MS),
    };
  }

  private getMemoryMetrics(): MemoryMetrics {
    const mem = process.memoryUsage();
    return {
      heapUsed: round(mem.heapUsed * BYTES_TO_MB),
      heapTotal: round(mem.heapTotal * BYTES_TO_MB),
      rss: round(mem.rss * BYTES_TO_MB),
      external: round(mem.external * BYTES_TO_MB),
      arrayBuffers: round(mem.arrayBuffers * BYTES_TO_MB),
    };
  }

  private getGcMetrics(): GcMetrics {
    return {
      totalPauseMs: round(this.gcTotalPauseMs),
      count: this.gcCount,
      majorCount: this.gcMajorCount,
    };
  }
}

// =============================================================================
// Helpers
// =============================================================================

/** Round to 3 decimal places. */
function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

// =============================================================================
// Singleton
// =============================================================================

let globalRuntimeMonitor: RuntimeMonitor | null = null;

/**
 * Get or create the global RuntimeMonitor singleton.
 * Call start() after first retrieval to begin monitoring.
 */
export function getRuntimeMonitor(): RuntimeMonitor {
  if (!globalRuntimeMonitor) {
    globalRuntimeMonitor = new RuntimeMonitor();
  }
  return globalRuntimeMonitor;
}

/**
 * Reset the global RuntimeMonitor singleton (for testing).
 * Stops the current instance before releasing it.
 */
export function resetRuntimeMonitor(): void {
  if (globalRuntimeMonitor) {
    globalRuntimeMonitor.stop();
    globalRuntimeMonitor = null;
  }
}
