/**
 * Performance Test Fixtures
 *
 * Provides load test scenarios, benchmark configurations, and performance baselines.
 * Supports various load patterns: baseline, target, stress, burst, spike.
 */

export interface LoadTestScenario {
  eventsPerSec: number;
  durationSec: number;
  description?: string;
}

export interface BurstPattern {
  burstSize: number;
  intervalMs: number;
  burstCount?: number;
}

export interface SpikeConfig {
  at: number; // Time in seconds
  magnitude: number; // Multiplier (e.g., 5 = 5x traffic)
  durationSec?: number;
}

export interface PerformanceBaseline {
  l1HitRate: number;
  l1ReadLatencyUs: number;
  l1WriteLatencyUs: number;
  workerReadLatencyUs: number;
  hotPathLatencyMs: number;
  memoryUsageMB: number;
  gcPauseMs: number;
  evictionRate: number;
}

/**
 * Load Test Performance Targets (ADR-005)
 *
 * Targets for load test metrics (different from cache baseline metrics).
 * Used to validate LoadTestResult.metrics against ADR-005 requirements.
 */
export interface LoadTestTargets {
  latency: {
    p99: number; // ms
  };
  memory: {
    growthRateMBPerMin: number; // MB/min
  };
  throughput: {
    minEventsPerSec: number; // events/sec
  };
}

/**
 * Performance Fixtures
 */
export const PerformanceFixtures = {
  /**
   * Load Test Scenarios
   */
  loadScenarios: {
    /**
     * Baseline load - low traffic for baseline metrics
     */
    baseline: (): LoadTestScenario => ({
      eventsPerSec: 100,
      durationSec: 60,
      description: 'Baseline load for establishing metrics',
    }),

    /**
     * Target load - production target (500 eps)
     */
    target: (): LoadTestScenario => ({
      eventsPerSec: 500,
      durationSec: 300, // 5 minutes
      description: 'Target production load (500 events/sec)',
    }),

    /**
     * Sustained load - long-running for stability testing
     */
    sustained: (): LoadTestScenario => ({
      eventsPerSec: 500,
      durationSec: 1800, // 30 minutes
      description: 'Sustained load for memory stability testing',
    }),

    /**
     * Stress load - above target for stress testing
     */
    stress: (): LoadTestScenario => ({
      eventsPerSec: 1000,
      durationSec: 120, // 2 minutes
      description: 'Stress test at 2x target load',
    }),

    /**
     * Peak load - maximum expected traffic
     */
    peak: (): LoadTestScenario => ({
      eventsPerSec: 2000,
      durationSec: 60,
      description: 'Peak load test',
    }),

    /**
     * Custom load scenario
     */
    custom: (eventsPerSec: number, durationSec: number): LoadTestScenario => ({
      eventsPerSec,
      durationSec,
      description: `Custom load: ${eventsPerSec} eps for ${durationSec}s`,
    }),
  },

  /**
   * Burst Patterns
   */
  burstPatterns: {
    /**
     * Regular bursts - periodic spikes
     */
    regular: (): BurstPattern => ({
      burstSize: 100,
      intervalMs: 1000,
      burstCount: 60,
    }),

    /**
     * Irregular bursts - random intervals
     */
    irregular: (): BurstPattern => ({
      burstSize: 200,
      intervalMs: 500 + Math.floor(Math.random() * 2000),
      burstCount: 30,
    }),

    /**
     * Large bursts - big spikes
     */
    large: (): BurstPattern => ({
      burstSize: 500,
      intervalMs: 5000,
      burstCount: 12,
    }),
  },

  /**
   * Spike Configurations
   */
  spikeConfigs: {
    /**
     * Single spike - one major event
     */
    single: (): SpikeConfig[] => [
      { at: 30, magnitude: 10, durationSec: 5 },
    ],

    /**
     * Multiple spikes - several events
     */
    multiple: (): SpikeConfig[] => [
      { at: 10, magnitude: 5, durationSec: 3 },
      { at: 60, magnitude: 10, durationSec: 5 },
      { at: 120, magnitude: 15, durationSec: 2 },
    ],

    /**
     * Gradual increase - ramp-up pattern
     */
    gradualIncrease: (): SpikeConfig[] => [
      { at: 10, magnitude: 2, durationSec: 10 },
      { at: 30, magnitude: 4, durationSec: 10 },
      { at: 50, magnitude: 6, durationSec: 10 },
      { at: 70, magnitude: 8, durationSec: 10 },
    ],
  },

  /**
   * Performance Baselines (from ADR-005 targets)
   */
  baselines: {
    /**
     * Target performance baseline (ADR-005)
     */
    target: (): PerformanceBaseline => ({
      l1HitRate: 95, // >95%
      l1ReadLatencyUs: 1, // <1μs
      l1WriteLatencyUs: 1, // <1μs
      workerReadLatencyUs: 5, // <5μs
      hotPathLatencyMs: 50, // <50ms
      memoryUsageMB: 64, // <64MB
      gcPauseMs: 10, // <10ms
      evictionRate: 1, // <1%
    }),

    /**
     * Actual baseline (to be measured)
     */
    actual: (measured: Partial<PerformanceBaseline>): PerformanceBaseline => ({
      l1HitRate: measured.l1HitRate ?? 0,
      l1ReadLatencyUs: measured.l1ReadLatencyUs ?? 0,
      l1WriteLatencyUs: measured.l1WriteLatencyUs ?? 0,
      workerReadLatencyUs: measured.workerReadLatencyUs ?? 0,
      hotPathLatencyMs: measured.hotPathLatencyMs ?? 0,
      memoryUsageMB: measured.memoryUsageMB ?? 0,
      gcPauseMs: measured.gcPauseMs ?? 0,
      evictionRate: measured.evictionRate ?? 0,
    }),

    /**
     * Regression tolerance (acceptable degradation)
     */
    tolerance: (): PerformanceBaseline => ({
      l1HitRate: 5, // Can drop up to 5% (90% minimum)
      l1ReadLatencyUs: 1, // Can increase 1μs (2μs max)
      l1WriteLatencyUs: 1, // Can increase 1μs (2μs max)
      workerReadLatencyUs: 2, // Can increase 2μs (7μs max)
      hotPathLatencyMs: 10, // Can increase 10ms (60ms max)
      memoryUsageMB: 16, // Can increase 16MB (80MB max)
      gcPauseMs: 5, // Can increase 5ms (15ms max)
      evictionRate: 2, // Can increase 2% (3% max)
    }),
  },

  /**
   * Load Test Performance Targets (ADR-005)
   *
   * Expected performance targets for load testing (different from cache baselines).
   * Based on ADR-005 hot-path latency and system requirements.
   */
  loadTestTargets: {
    /**
     * ADR-005 target performance for load tests
     */
    target: (): LoadTestTargets => ({
      latency: {
        p99: 50, // <50ms per event (ADR-005 hot-path requirement)
      },
      memory: {
        growthRateMBPerMin: 5, // <5MB/min (acceptable growth rate)
      },
      throughput: {
        minEventsPerSec: 500, // >500 eps (production target)
      },
    }),

    /**
     * Stress test targets (degraded performance acceptable)
     */
    stress: (): LoadTestTargets => ({
      latency: {
        p99: 100, // <100ms per event (2x normal)
      },
      memory: {
        growthRateMBPerMin: 10, // <10MB/min (higher growth acceptable)
      },
      throughput: {
        minEventsPerSec: 1000, // >1000 eps (stress load)
      },
    }),

    /**
     * Custom targets
     */
    custom: (latencyP99: number, memoryGrowthMBPerMin: number, minEventsPerSec: number): LoadTestTargets => ({
      latency: { p99: latencyP99 },
      memory: { growthRateMBPerMin: memoryGrowthMBPerMin },
      throughput: { minEventsPerSec: minEventsPerSec },
    }),
  },

  /**
   * Benchmark Configurations
   */
  benchmarkConfigs: {
    /**
     * Quick benchmark - fast validation
     */
    quick: () => ({
      warmupIterations: 100,
      measurementIterations: 1000,
      description: 'Quick benchmark (< 1 minute)',
    }),

    /**
     * Standard benchmark - typical testing
     */
    standard: () => ({
      warmupIterations: 500,
      measurementIterations: 10000,
      description: 'Standard benchmark (1-5 minutes)',
    }),

    /**
     * Thorough benchmark - comprehensive testing
     */
    thorough: () => ({
      warmupIterations: 1000,
      measurementIterations: 100000,
      description: 'Thorough benchmark (5-15 minutes)',
    }),
  },

  /**
   * Memory Patterns
   */
  memoryPatterns: {
    /**
     * Stable memory - no growth
     */
    stable: () => ({
      initialMB: 50,
      growthMBPerMin: 0,
      peakMB: 50,
    }),

    /**
     * Slow growth - acceptable leak
     */
    slowGrowth: () => ({
      initialMB: 50,
      growthMBPerMin: 2,
      peakMB: 80,
    }),

    /**
     * Memory leak - unacceptable growth
     */
    leak: () => ({
      initialMB: 50,
      growthMBPerMin: 10,
      peakMB: 200,
    }),
  },
};

/**
 * Helper: Generate realistic event stream
 */
export function generateEventStream(scenario: LoadTestScenario): Array<{ timestamp: number; data: any }> {
  const events: Array<{ timestamp: number; data: any }> = [];
  const intervalMs = 1000 / scenario.eventsPerSec;
  const totalEvents = scenario.eventsPerSec * scenario.durationSec;

  for (let i = 0; i < totalEvents; i++) {
    events.push({
      timestamp: i * intervalMs,
      data: {
        pairAddress: `0x${i.toString(16).padStart(40, '0')}`,
        reserve0: (BigInt(1000000) * BigInt(i + 1)).toString(),
        reserve1: (BigInt(2000000) * BigInt(i + 1)).toString(),
        blockNumber: 1000000 + i,
      },
    });
  }

  return events;
}

/**
 * Helper: Apply spike pattern to event stream
 */
export function applySpikePattern(
  baseEventsPerSec: number,
  durationSec: number,
  spikes: SpikeConfig[]
): LoadTestScenario[] {
  const scenarios: LoadTestScenario[] = [];
  let currentTime = 0;

  // Sort spikes by time
  const sortedSpikes = [...spikes].sort((a, b) => a.at - b.at);

  for (let i = 0; i < sortedSpikes.length; i++) {
    const spike = sortedSpikes[i];
    const nextSpike = sortedSpikes[i + 1];

    // Baseline period before spike
    if (spike.at > currentTime) {
      scenarios.push({
        eventsPerSec: baseEventsPerSec,
        durationSec: spike.at - currentTime,
        description: `Baseline before spike ${i + 1}`,
      });
    }

    // Spike period
    scenarios.push({
      eventsPerSec: baseEventsPerSec * spike.magnitude,
      durationSec: spike.durationSec || 5,
      description: `Spike ${i + 1}: ${spike.magnitude}x traffic`,
    });

    currentTime = spike.at + (spike.durationSec || 5);

    // Recovery period after spike
    if (!nextSpike || nextSpike.at > currentTime) {
      const recoveryDuration = nextSpike ? nextSpike.at - currentTime : durationSec - currentTime;
      scenarios.push({
        eventsPerSec: baseEventsPerSec,
        durationSec: recoveryDuration,
        description: `Recovery after spike ${i + 1}`,
      });
    }
  }

  return scenarios;
}
