/**
 * Diagnostics Collector
 *
 * Aggregates data from all existing monitoring singletons into a single
 * DiagnosticsSnapshot for SSE push to the dashboard. Enables deep runtime
 * analysis during live monitoring sessions without requiring individual
 * curl calls to each service's /metrics endpoint.
 *
 * Data sources:
 * - LatencyTracker: Pipeline stage latency percentiles
 * - RuntimeMonitor: Event loop delay, GC pauses, memory breakdown
 * - ProviderLatencyTracker: Per-chain RPC quality, WS message counts
 * - StreamHealthMonitor: Redis Streams health (async, cached)
 *
 * Design:
 * - collect() is called every 10s by the coordinator SSE route (cold path)
 * - All reads are from existing singletons — no additional polling/timers
 * - StreamHealthMonitor data uses its internal 5s cache (no extra Redis calls)
 * - Singleton via getDiagnosticsCollector() / resetDiagnosticsCollector()
 *
 * @custom:version 1.0.0
 * @see shared/core/src/monitoring/latency-tracker.ts
 * @see shared/core/src/monitoring/runtime-monitor.ts
 * @see shared/core/src/monitoring/provider-latency-tracker.ts
 * @see shared/core/src/monitoring/stream-health-monitor.ts
 */

import { getLatencyTracker } from './latency-tracker';
import { getRuntimeMonitor } from './runtime-monitor';
import { getProviderLatencyTracker } from './provider-latency-tracker';
import { getStreamHealthMonitor } from './stream-health-monitor';
import type { PercentileStats, LatencyMetrics } from './latency-tracker';
import type { RuntimeMetrics } from './runtime-monitor';
import type { ProviderLatencyMetrics } from './provider-latency-tracker';

// =============================================================================
// Types
// =============================================================================

/** Compact percentile stats for SSE transport (omits totalRecorded/avg to save bandwidth). */
export interface CompactPercentiles {
  p50: number;
  p95: number;
  p99: number;
  count: number;
}

/** Pipeline latency diagnostics. */
export interface PipelineDiagnostics {
  e2e: CompactPercentiles;
  wsToDetector: CompactPercentiles;
  detectorToPublish: CompactPercentiles;
  stages: Record<string, CompactPercentiles>;
}

/** Runtime health diagnostics. */
export interface RuntimeDiagnostics {
  eventLoop: {
    min: number;
    max: number;
    mean: number;
    p99: number;
  };
  memory: {
    heapUsedMB: number;
    heapTotalMB: number;
    rssMB: number;
    externalMB: number;
  };
  gc: {
    totalPauseMs: number;
    count: number;
    majorCount: number;
  };
  uptimeSeconds: number;
}

/** Per-chain RPC provider diagnostics. */
export interface ProviderDiagnostics {
  rpcByChain: Record<string, { p50: number; p95: number; errors: number; totalCalls: number }>;
  rpcByMethod: Record<string, { p50: number; p95: number; totalCalls: number }>;
  reconnections: Record<string, { count: number; p50: number }>;
  wsMessages: Record<string, number>;
  totalRpcErrors: number;
}

/** Stream health diagnostics (mirrors StreamHealthMonitor cached data). */
export interface StreamDiagnostics {
  overall: string;
  streams: Record<string, {
    length: number;
    pending: number;
    consumerGroups: number;
    status: string;
  }>;
}

/** Complete diagnostics snapshot pushed via SSE. */
export interface DiagnosticsSnapshot {
  pipeline: PipelineDiagnostics;
  runtime: RuntimeDiagnostics;
  providers: ProviderDiagnostics;
  streams: StreamDiagnostics | null;
  timestamp: number;
}

// =============================================================================
// DiagnosticsCollector
// =============================================================================

/**
 * Aggregates monitoring data from all singletons into a single snapshot.
 *
 * @example
 * ```typescript
 * const collector = getDiagnosticsCollector();
 * const snapshot = await collector.collect();
 * sseConnection.send('diagnostics', snapshot);
 * ```
 */
export class DiagnosticsCollector {

  /**
   * Collect a diagnostics snapshot from all monitoring singletons.
   * Cold path: called every ~10s by the SSE route.
   */
  async collect(): Promise<DiagnosticsSnapshot> {
    const pipeline = this.collectPipeline();
    const runtime = this.collectRuntime();
    const providers = this.collectProviders();
    const streams = await this.collectStreams();

    return {
      pipeline,
      runtime,
      providers,
      streams,
      timestamp: Date.now(),
    };
  }

  // ===========================================================================
  // Pipeline latency
  // ===========================================================================

  private collectPipeline(): PipelineDiagnostics {
    const tracker = getLatencyTracker();
    const metrics: LatencyMetrics = tracker.getMetrics();

    const stages: Record<string, CompactPercentiles> = {};
    for (const [name, stats] of Object.entries(metrics.stageBreakdown)) {
      stages[name] = toCompact(stats);
    }

    return {
      e2e: toCompact(metrics.e2e),
      wsToDetector: toCompact(metrics.wsToDetector),
      detectorToPublish: toCompact(metrics.detectorToPublish),
      stages,
    };
  }

  // ===========================================================================
  // Runtime health
  // ===========================================================================

  private collectRuntime(): RuntimeDiagnostics {
    const monitor = getRuntimeMonitor();
    const metrics: RuntimeMetrics = monitor.getMetrics();

    return {
      eventLoop: {
        min: metrics.eventLoop.min,
        max: metrics.eventLoop.max,
        mean: metrics.eventLoop.mean,
        p99: metrics.eventLoop.p99,
      },
      memory: {
        heapUsedMB: metrics.memory.heapUsed,
        heapTotalMB: metrics.memory.heapTotal,
        rssMB: metrics.memory.rss,
        externalMB: metrics.memory.external,
      },
      gc: {
        totalPauseMs: metrics.gc.totalPauseMs,
        count: metrics.gc.count,
        majorCount: metrics.gc.majorCount,
      },
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  // ===========================================================================
  // Provider / RPC quality
  // ===========================================================================

  private collectProviders(): ProviderDiagnostics {
    const tracker = getProviderLatencyTracker();
    const metrics: ProviderLatencyMetrics = tracker.getMetrics();
    const wsMessages = tracker.getMessageCounts();

    const rpcByChain: ProviderDiagnostics['rpcByChain'] = {};
    for (const [chain, stats] of Object.entries(metrics.rpcCalls.byChain)) {
      rpcByChain[chain] = {
        p50: stats.p50,
        p95: stats.p95,
        errors: metrics.errors.byChain[chain] ?? 0,
        totalCalls: stats.totalRecorded,
      };
    }

    const rpcByMethod: ProviderDiagnostics['rpcByMethod'] = {};
    for (const [method, stats] of Object.entries(metrics.rpcCalls.byMethod)) {
      rpcByMethod[method] = {
        p50: stats.p50,
        p95: stats.p95,
        totalCalls: stats.totalRecorded,
      };
    }

    const reconnections: ProviderDiagnostics['reconnections'] = {};
    for (const [chain, stats] of Object.entries(metrics.reconnections.byChain)) {
      reconnections[chain] = {
        count: stats.totalRecorded,
        p50: stats.p50,
      };
    }

    return {
      rpcByChain,
      rpcByMethod,
      reconnections,
      wsMessages,
      totalRpcErrors: metrics.errors.total,
    };
  }

  // ===========================================================================
  // Stream health
  // ===========================================================================

  private async collectStreams(): Promise<StreamDiagnostics | null> {
    try {
      const monitor = getStreamHealthMonitor();
      // checkStreamHealth() uses its internal 5s cache — no extra Redis calls
      const health = await monitor.checkStreamHealth();

      const streams: StreamDiagnostics['streams'] = {};
      for (const [name, info] of Object.entries(health.streams)) {
        streams[name] = {
          length: info.length,
          pending: info.pendingCount,
          consumerGroups: info.consumerGroups,
          status: info.status,
        };
      }

      return {
        overall: health.overall,
        streams,
      };
    } catch {
      // StreamHealthMonitor may not be initialized yet (no Redis)
      return null;
    }
  }
}

// =============================================================================
// Helpers
// =============================================================================

function toCompact(stats: PercentileStats): CompactPercentiles {
  return {
    p50: stats.p50,
    p95: stats.p95,
    p99: stats.p99,
    count: stats.count,
  };
}

// =============================================================================
// Singleton
// =============================================================================

let globalDiagnosticsCollector: DiagnosticsCollector | null = null;

/**
 * Get or create the global DiagnosticsCollector singleton.
 */
export function getDiagnosticsCollector(): DiagnosticsCollector {
  if (!globalDiagnosticsCollector) {
    globalDiagnosticsCollector = new DiagnosticsCollector();
  }
  return globalDiagnosticsCollector;
}

/**
 * Reset the global DiagnosticsCollector singleton (for testing).
 */
export function resetDiagnosticsCollector(): void {
  globalDiagnosticsCollector = null;
}
