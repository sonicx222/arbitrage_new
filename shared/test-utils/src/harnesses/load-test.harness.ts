/**
 * Load Test Harness
 *
 * Orchestrates high-volume load testing scenarios.
 * Generates events, monitors system health, collects performance metrics.
 *
 * @example
 * const harness = new LoadTestHarness();
 * const result = await harness.runLoad({
 *   eventsPerSec: 500,
 *   durationSec: 300
 * });
 *
 * harness.assertSustainedThroughput(500);
 * harness.assertMemoryStable(50);
 */

import { performance } from 'perf_hooks';
import { clearIntervalSafe } from '@arbitrage/core/async';
import { LoadTestResult, MemoryMetrics, GCMetrics, LatencyMetrics } from '../types/cache-types';

export interface LoadTestConfig {
  eventsPerSec: number;
  durationSec: number;
  description?: string;
}

export interface EventHandler {
  (event: any): Promise<void> | void;
}

export interface LoadTestMetrics {
  latency: LatencyMetrics;
  throughput: {
    eventsPerSec: number;
    avgEventLatencyMs: number;
    totalEvents: number;
  };
  memory: MemoryMetrics;
  gc: GCMetrics;
}

export class LoadTestHarness {
  private latencySamples: number[] = [];
  private memorySamples: MemoryMetrics[] = [];
  private gcPauses: number[] = [];
  private eventCount: number = 0;
  private startTime: number = 0;
  private memoryMonitorInterval: NodeJS.Timeout | null = null;

  /**
   * Run load test with specified configuration
   */
  async runLoad(config: LoadTestConfig, handler: EventHandler): Promise<LoadTestResult> {
    this.reset();

    const { eventsPerSec, durationSec, description } = config;
    const totalEvents = eventsPerSec * durationSec;
    const intervalMs = 1000 / eventsPerSec;

    this.startTime = Date.now();

    // Start monitoring
    this.startMemoryMonitoring();
    if (global.gc) {
      this.startGCMonitoring();
    }

    // Generate and process events
    for (let i = 0; i < totalEvents; i++) {
      const event = this.generateEvent(i);
      const eventStartTime = performance.now();

      try {
        await handler(event);
        const latencyMs = performance.now() - eventStartTime;
        this.latencySamples.push(latencyMs);
        this.eventCount++;
      } catch (error) {
        // Record error but continue
        console.error('Event processing error:', error);
      }

      // Maintain event rate
      const nextEventTime = this.startTime + (i + 1) * intervalMs;
      const waitTime = nextEventTime - Date.now();
      if (waitTime > 0) {
        await this.sleep(waitTime);
      }
    }

    // Stop monitoring
    this.stopMemoryMonitoring();

    // Collect final metrics
    const metrics = this.collectMetrics();

    return {
      scenario: description || `${eventsPerSec} eps for ${durationSec}s`,
      duration: Date.now() - this.startTime,
      events: this.eventCount,
      metrics,
      passed: this.evaluateResults(metrics),
      failures: this.getFailures(metrics),
    };
  }

  /**
   * Generate sustained load (async iterator pattern)
   */
  async *generateSustainedLoad(eventsPerSec: number, durationSec: number): AsyncIterableIterator<any> {
    const totalEvents = eventsPerSec * durationSec;
    const intervalMs = 1000 / eventsPerSec;
    const startTime = Date.now();

    for (let i = 0; i < totalEvents; i++) {
      yield this.generateEvent(i);

      // Maintain event rate
      const nextEventTime = startTime + (i + 1) * intervalMs;
      const waitTime = nextEventTime - Date.now();
      if (waitTime > 0) {
        await this.sleep(waitTime);
      }
    }
  }

  /**
   * Generate burst load
   */
  async *generateBurstLoad(burstSize: number, intervalMs: number, burstCount: number): AsyncIterableIterator<any[]> {
    for (let burst = 0; burst < burstCount; burst++) {
      const events = [];
      for (let i = 0; i < burstSize; i++) {
        events.push(this.generateEvent(burst * burstSize + i));
      }

      yield events;

      await this.sleep(intervalMs);
    }
  }

  /**
   * Track memory growth over time
   */
  trackMemoryGrowth(): MemoryMetrics[] {
    return [...this.memorySamples];
  }

  /**
   * Track GC pauses
   */
  trackGCPauses(): number[] {
    return [...this.gcPauses];
  }

  /**
   * Track event latency
   */
  trackEventLatency(): LatencyMetrics {
    return this.calculateLatencyMetrics(this.latencySamples);
  }

  /**
   * Assert sustained throughput meets target
   */
  assertSustainedThroughput(minEventsPerSec: number): void {
    const actualThroughput = this.eventCount / ((Date.now() - this.startTime) / 1000);

    if (actualThroughput < minEventsPerSec) {
      throw new Error(
        `Throughput ${actualThroughput.toFixed(2)} eps below target ${minEventsPerSec} eps`
      );
    }
  }

  /**
   * Assert memory is stable (no leaks)
   */
  assertMemoryStable(maxGrowthMB: number): void {
    if (this.memorySamples.length < 2) {
      throw new Error('Not enough memory samples to assess stability');
    }

    const initial = this.memorySamples[0];
    const final = this.memorySamples[this.memorySamples.length - 1];
    const growthMB = final.heapUsedMB - initial.heapUsedMB;

    if (growthMB > maxGrowthMB) {
      throw new Error(
        `Memory growth ${growthMB.toFixed(2)}MB exceeds threshold ${maxGrowthMB}MB`
      );
    }
  }

  /**
   * Assert GC pauses are acceptable
   */
  assertGCPausesAcceptable(maxPauseMs: number): void {
    if (this.gcPauses.length === 0) {
      return; // No GC monitoring available
    }

    const maxPause = Math.max(...this.gcPauses);

    if (maxPause > maxPauseMs) {
      throw new Error(
        `Max GC pause ${maxPause.toFixed(2)}ms exceeds threshold ${maxPauseMs}ms`
      );
    }
  }

  /**
   * Assert latency is under target
   */
  assertLatencyUnder(maxMs: number, percentile: number): void {
    const metrics = this.calculateLatencyMetrics(this.latencySamples);
    let actual: number;

    if (percentile === 50) actual = metrics.p50;
    else if (percentile === 95) actual = metrics.p95;
    else if (percentile === 99) actual = metrics.p99;
    else if (percentile === 99.9) actual = metrics.p999;
    else throw new Error(`Unsupported percentile: ${percentile}`);

    if (actual > maxMs) {
      throw new Error(
        `p${percentile} latency ${actual.toFixed(2)}ms exceeds threshold ${maxMs}ms`
      );
    }
  }

  /**
   * Generate test event
   */
  private generateEvent(index: number): any {
    return {
      id: index,
      pairAddress: `0x${index.toString(16).padStart(40, '0')}`,
      reserve0: (BigInt(1000000) * BigInt(index + 1)).toString(),
      reserve1: (BigInt(2000000) * BigInt(index + 1)).toString(),
      timestamp: Date.now(),
      blockNumber: 1000000 + index,
    };
  }

  /**
   * Collect metrics from samples
   */
  private collectMetrics(): LoadTestMetrics {
    const duration = (Date.now() - this.startTime) / 1000;

    return {
      latency: this.calculateLatencyMetrics(this.latencySamples),
      throughput: {
        eventsPerSec: this.eventCount / duration,
        avgEventLatencyMs: this.latencySamples.reduce((a, b) => a + b, 0) / this.latencySamples.length,
        totalEvents: this.eventCount,
      },
      memory: this.calculateMemoryMetrics(),
      gc: this.calculateGCMetrics(),
    };
  }

  /**
   * Calculate latency metrics (percentiles)
   */
  private calculateLatencyMetrics(samples: number[]): LatencyMetrics {
    if (samples.length === 0) {
      return { min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0, p999: 0 };
    }

    const sorted = [...samples].sort((a, b) => a - b);

    return {
      min: sorted[0],
      max: sorted[sorted.length - 1],
      avg: sorted.reduce((a, b) => a + b, 0) / sorted.length,
      p50: sorted[Math.floor(sorted.length * 0.50)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
      p999: sorted[Math.floor(sorted.length * 0.999)],
    };
  }

  /**
   * Calculate memory metrics
   */
  private calculateMemoryMetrics(): MemoryMetrics {
    if (this.memorySamples.length === 0) {
      const current = process.memoryUsage();
      return {
        heapUsedMB: current.heapUsed / 1024 / 1024,
        heapTotalMB: current.heapTotal / 1024 / 1024,
        externalMB: current.external / 1024 / 1024,
        arrayBuffersMB: (current as any).arrayBuffers ? (current as any).arrayBuffers / 1024 / 1024 : 0,
        peakHeapUsedMB: current.heapUsed / 1024 / 1024,
        growthRateMBPerMin: 0,
      };
    }

    const heaps = this.memorySamples.map(s => s.heapUsedMB);
    const peakHeapUsedMB = Math.max(...heaps);

    const initial = this.memorySamples[0];
    const final = this.memorySamples[this.memorySamples.length - 1];
    const durationMin = (Date.now() - this.startTime) / 1000 / 60;
    const growthRateMBPerMin = (final.heapUsedMB - initial.heapUsedMB) / durationMin;

    return {
      ...final,
      peakHeapUsedMB,
      growthRateMBPerMin,
    };
  }

  /**
   * Calculate GC metrics
   */
  private calculateGCMetrics(): GCMetrics {
    if (this.gcPauses.length === 0) {
      return {
        totalPauses: 0,
        avgPauseMs: 0,
        maxPauseMs: 0,
        p99PauseMs: 0,
        totalGCTimeMs: 0,
      };
    }

    const sorted = [...this.gcPauses].sort((a, b) => a - b);

    return {
      totalPauses: this.gcPauses.length,
      avgPauseMs: this.gcPauses.reduce((a, b) => a + b, 0) / this.gcPauses.length,
      maxPauseMs: Math.max(...this.gcPauses),
      p99PauseMs: sorted[Math.floor(sorted.length * 0.99)] || sorted[sorted.length - 1],
      totalGCTimeMs: this.gcPauses.reduce((a, b) => a + b, 0),
    };
  }

  /**
   * Start memory monitoring
   */
  private startMemoryMonitoring(): void {
    this.memoryMonitorInterval = setInterval(() => {
      const mem = process.memoryUsage();
      this.memorySamples.push({
        heapUsedMB: mem.heapUsed / 1024 / 1024,
        heapTotalMB: mem.heapTotal / 1024 / 1024,
        externalMB: mem.external / 1024 / 1024,
        arrayBuffersMB: (mem as any).arrayBuffers ? (mem as any).arrayBuffers / 1024 / 1024 : 0,
        peakHeapUsedMB: 0, // Will be calculated later
        growthRateMBPerMin: 0, // Will be calculated later
      });
    }, 1000); // Sample every second
  }

  /**
   * Stop memory monitoring
   */
  private stopMemoryMonitoring(): void {
    this.memoryMonitorInterval = clearIntervalSafe(this.memoryMonitorInterval);
  }

  /**
   * Start GC monitoring (requires --expose-gc flag)
   */
  private startGCMonitoring(): void {
    // Hook into GC events if available
    // Note: This is a simplified version - real implementation would use perf_hooks
  }

  /**
   * Evaluate test results
   */
  private evaluateResults(metrics: LoadTestMetrics): boolean {
    // Define pass criteria
    const criteria = [
      metrics.throughput.eventsPerSec >= 500,
      metrics.latency.p99 < 50,
      metrics.memory.growthRateMBPerMin < 5,
      metrics.gc.p99PauseMs < 100,
    ];

    return criteria.every(c => c);
  }

  /**
   * Get list of failures
   */
  private getFailures(metrics: LoadTestMetrics): string[] {
    const failures: string[] = [];

    if (metrics.throughput.eventsPerSec < 500) {
      failures.push(`Throughput ${metrics.throughput.eventsPerSec.toFixed(2)} eps < 500 eps`);
    }

    if (metrics.latency.p99 > 50) {
      failures.push(`p99 latency ${metrics.latency.p99.toFixed(2)}ms > 50ms`);
    }

    if (metrics.memory.growthRateMBPerMin > 5) {
      failures.push(`Memory growth ${metrics.memory.growthRateMBPerMin.toFixed(2)}MB/min > 5MB/min`);
    }

    if (metrics.gc.p99PauseMs > 100) {
      failures.push(`p99 GC pause ${metrics.gc.p99PauseMs.toFixed(2)}ms > 100ms`);
    }

    return failures;
  }

  /**
   * Reset internal state
   */
  private reset(): void {
    this.latencySamples = [];
    this.memorySamples = [];
    this.gcPauses = [];
    this.eventCount = 0;
    this.startTime = 0;
  }

  /**
   * Helper: Sleep for ms
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
