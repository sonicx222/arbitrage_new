/**
 * Cache Test Types
 *
 * Type definitions for cache testing infrastructure.
 */

export interface CacheMetrics {
  l1: {
    size: number;
    hits: number;
    misses: number;
    evictions: number;
    hitRate: number;
  };
  l2: {
    size: number;
    hits: number;
    misses: number;
  };
  memoryUsageMB: number;
}

export interface CacheStats {
  hitRate: number;
  missRate: number;
  evictionRate: number;
  avgReadLatencyUs: number;
  avgWriteLatencyUs: number;
  p95ReadLatencyUs: number;
  p99ReadLatencyUs: number;
  memoryUsageMB: number;
}

export interface CacheTestConfig {
  l1SizeMB?: number;
  l2TtlSec?: number;
  l3Enabled?: boolean;
  usePriceMatrix?: boolean;
  enableTimingMetrics?: boolean;
}

export interface MetricsSnapshot {
  timestamp: number;
  cacheMetrics: CacheMetrics;
  performanceMetrics: PerformanceMetrics;
}

export interface PerformanceMetrics {
  latency: LatencyMetrics;
  throughput: ThroughputMetrics;
  memory: MemoryMetrics;
  gc: GCMetrics;
}

export interface LatencyMetrics {
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  p999: number;
}

export interface ThroughputMetrics {
  eventsPerSec: number;
  avgEventLatencyMs: number;
  totalEvents: number;
}

export interface MemoryMetrics {
  heapUsedMB: number;
  heapTotalMB: number;
  externalMB: number;
  arrayBuffersMB: number;
  peakHeapUsedMB: number;
  growthRateMBPerMin: number;
}

export interface GCMetrics {
  totalPauses: number;
  avgPauseMs: number;
  maxPauseMs: number;
  p99PauseMs: number;
  totalGCTimeMs: number;
}

export interface LoadTestResult {
  scenario: string;
  duration: number;
  events: number;
  metrics: PerformanceMetrics;
  passed: boolean;
  failures: string[];
}

export interface WorkerStats {
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  avgLatencyMs: number;
  p99LatencyMs: number;
  utilization: number; // 0-1
}
