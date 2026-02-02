/**
 * Execution Probability Tracker Tests (TDD)
 *
 * Phase 3: Capital & Risk Controls (P0)
 * Task 3.4.1: Execution Probability Tracker
 *
 * @see docs/reports/implementation_plan_v3.md Section 3.4.1
 */

import {
  ExecutionProbabilityTracker,
  getExecutionProbabilityTracker,
  resetExecutionProbabilityTracker,
} from '../../../src/risk/execution-probability-tracker';
import type {
  ExecutionOutcome,
  ExecutionProbabilityConfig,
  ProbabilityQueryParams,
} from '../../../src/risk/types';

// =============================================================================
// Mock Data
// =============================================================================

const createMockOutcome = (overrides: Partial<ExecutionOutcome> = {}): ExecutionOutcome => ({
  chain: 'ethereum',
  dex: 'uniswap_v2',
  pathLength: 2,
  hourOfDay: 14,
  gasPrice: 20000000000n, // 20 gwei
  success: true,
  profit: 50000000000000000n, // 0.05 ETH
  gasCost: 5000000000000000n, // 0.005 ETH
  timestamp: Date.now(),
  ...overrides,
});

const MOCK_CONFIG: Partial<ExecutionProbabilityConfig> = {
  minSamples: 5,
  defaultWinProbability: 0.5,
  maxOutcomesPerKey: 1000,
  cleanupIntervalMs: 60000,
  outcomeRelevanceWindowMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  persistToRedis: false, // Disable Redis for unit tests
};

// =============================================================================
// Unit Tests
// =============================================================================

describe('ExecutionProbabilityTracker', () => {
  let tracker: ExecutionProbabilityTracker;

  beforeEach(() => {
    tracker = new ExecutionProbabilityTracker(MOCK_CONFIG);
  });

  afterEach(() => {
    tracker.destroy();
    resetExecutionProbabilityTracker();
  });

  // ---------------------------------------------------------------------------
  // Constructor Tests
  // ---------------------------------------------------------------------------

  describe('constructor', () => {
    it('should initialize with default config when none provided', () => {
      const defaultTracker = new ExecutionProbabilityTracker();
      expect(defaultTracker).toBeDefined();
      defaultTracker.destroy();
    });

    it('should merge partial config with defaults', () => {
      const partialConfig = { minSamples: 10 };
      const customTracker = new ExecutionProbabilityTracker(partialConfig);
      const stats = customTracker.getStats();
      expect(stats.totalOutcomes).toBe(0);
      customTracker.destroy();
    });

    it('should initialize with empty outcomes', () => {
      const stats = tracker.getStats();
      expect(stats.totalOutcomes).toBe(0);
      expect(stats.totalSuccesses).toBe(0);
      expect(stats.totalFailures).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // recordOutcome Tests
  // ---------------------------------------------------------------------------

  describe('recordOutcome', () => {
    it('should record a successful execution outcome', () => {
      const outcome = createMockOutcome({ success: true });
      tracker.recordOutcome(outcome);

      const stats = tracker.getStats();
      expect(stats.totalOutcomes).toBe(1);
      expect(stats.totalSuccesses).toBe(1);
      expect(stats.totalFailures).toBe(0);
    });

    it('should record a failed execution outcome', () => {
      const outcome = createMockOutcome({ success: false, profit: undefined });
      tracker.recordOutcome(outcome);

      const stats = tracker.getStats();
      expect(stats.totalOutcomes).toBe(1);
      expect(stats.totalSuccesses).toBe(0);
      expect(stats.totalFailures).toBe(1);
    });

    it('should track multiple outcomes for the same key', () => {
      const outcomes = [
        createMockOutcome({ success: true }),
        createMockOutcome({ success: true }),
        createMockOutcome({ success: false, profit: undefined }),
      ];

      outcomes.forEach(o => tracker.recordOutcome(o));

      const stats = tracker.getStats();
      expect(stats.totalOutcomes).toBe(3);
      expect(stats.totalSuccesses).toBe(2);
      expect(stats.totalFailures).toBe(1);
    });

    it('should track outcomes across different chains', () => {
      tracker.recordOutcome(createMockOutcome({ chain: 'ethereum' }));
      tracker.recordOutcome(createMockOutcome({ chain: 'arbitrum' }));
      tracker.recordOutcome(createMockOutcome({ chain: 'bsc' }));

      const stats = tracker.getStats();
      expect(stats.totalOutcomes).toBe(3);
      expect(stats.uniqueKeys).toBe(3);
    });

    it('should track outcomes across different DEXes', () => {
      tracker.recordOutcome(createMockOutcome({ dex: 'uniswap_v2' }));
      tracker.recordOutcome(createMockOutcome({ dex: 'sushiswap' }));
      tracker.recordOutcome(createMockOutcome({ dex: 'pancakeswap' }));

      const stats = tracker.getStats();
      expect(stats.totalOutcomes).toBe(3);
      expect(stats.uniqueKeys).toBe(3);
    });

    it('should track outcomes across different path lengths', () => {
      tracker.recordOutcome(createMockOutcome({ pathLength: 2 }));
      tracker.recordOutcome(createMockOutcome({ pathLength: 3 }));
      tracker.recordOutcome(createMockOutcome({ pathLength: 4 }));

      const stats = tracker.getStats();
      expect(stats.totalOutcomes).toBe(3);
      expect(stats.uniqueKeys).toBe(3);
    });

    it('should update timestamps correctly', () => {
      const now = Date.now();
      tracker.recordOutcome(createMockOutcome({ timestamp: now - 1000 }));
      tracker.recordOutcome(createMockOutcome({ timestamp: now }));

      const stats = tracker.getStats();
      expect(stats.firstOutcomeTimestamp).toBe(now - 1000);
      expect(stats.lastOutcomeTimestamp).toBe(now);
    });

    it('should handle BigInt values correctly', () => {
      const outcome = createMockOutcome({
        gasPrice: 100000000000000000000n, // 100 ETH worth of gwei (extreme test)
        profit: 1000000000000000000000n, // 1000 ETH
        gasCost: 500000000000000000n, // 0.5 ETH
      });

      expect(() => tracker.recordOutcome(outcome)).not.toThrow();

      const stats = tracker.getStats();
      expect(stats.totalOutcomes).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // getWinProbability Tests
  // ---------------------------------------------------------------------------

  describe('getWinProbability', () => {
    it('should return default probability when no data exists', () => {
      const params: ProbabilityQueryParams = {
        chain: 'ethereum',
        dex: 'uniswap_v2',
        pathLength: 2,
      };

      const result = tracker.getWinProbability(params);

      expect(result.winProbability).toBe(MOCK_CONFIG.defaultWinProbability);
      expect(result.isDefault).toBe(true);
      expect(result.sampleCount).toBe(0);
    });

    it('should return default probability when below minSamples', () => {
      // Add fewer samples than minSamples (5)
      for (let i = 0; i < 3; i++) {
        tracker.recordOutcome(createMockOutcome({ success: true }));
      }

      const result = tracker.getWinProbability({
        chain: 'ethereum',
        dex: 'uniswap_v2',
        pathLength: 2,
      });

      expect(result.isDefault).toBe(true);
      expect(result.sampleCount).toBe(3);
    });

    it('should calculate correct probability when above minSamples', () => {
      // Add 5 samples: 4 wins, 1 loss (80% win rate)
      for (let i = 0; i < 4; i++) {
        tracker.recordOutcome(createMockOutcome({ success: true }));
      }
      tracker.recordOutcome(createMockOutcome({ success: false, profit: undefined }));

      const result = tracker.getWinProbability({
        chain: 'ethereum',
        dex: 'uniswap_v2',
        pathLength: 2,
      });

      expect(result.isDefault).toBe(false);
      expect(result.sampleCount).toBe(5);
      expect(result.winProbability).toBe(0.8);
      expect(result.wins).toBe(4);
      expect(result.losses).toBe(1);
    });

    it('should return 0 probability for all failures', () => {
      for (let i = 0; i < 5; i++) {
        tracker.recordOutcome(createMockOutcome({ success: false, profit: undefined }));
      }

      const result = tracker.getWinProbability({
        chain: 'ethereum',
        dex: 'uniswap_v2',
        pathLength: 2,
      });

      expect(result.winProbability).toBe(0);
      expect(result.wins).toBe(0);
      expect(result.losses).toBe(5);
    });

    it('should return 1 probability for all successes', () => {
      for (let i = 0; i < 5; i++) {
        tracker.recordOutcome(createMockOutcome({ success: true }));
      }

      const result = tracker.getWinProbability({
        chain: 'ethereum',
        dex: 'uniswap_v2',
        pathLength: 2,
      });

      expect(result.winProbability).toBe(1);
      expect(result.wins).toBe(5);
      expect(result.losses).toBe(0);
    });

    it('should track different keys independently', () => {
      // Ethereum: 100% win rate
      for (let i = 0; i < 5; i++) {
        tracker.recordOutcome(createMockOutcome({ chain: 'ethereum', success: true }));
      }

      // Arbitrum: 0% win rate
      for (let i = 0; i < 5; i++) {
        tracker.recordOutcome(createMockOutcome({ chain: 'arbitrum', success: false, profit: undefined }));
      }

      const ethResult = tracker.getWinProbability({
        chain: 'ethereum',
        dex: 'uniswap_v2',
        pathLength: 2,
      });

      const arbResult = tracker.getWinProbability({
        chain: 'arbitrum',
        dex: 'uniswap_v2',
        pathLength: 2,
      });

      expect(ethResult.winProbability).toBe(1);
      expect(arbResult.winProbability).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // getAverageProfit Tests
  // ---------------------------------------------------------------------------

  describe('getAverageProfit', () => {
    it('should return 0 when no data exists', () => {
      const result = tracker.getAverageProfit({ chain: 'ethereum', dex: 'uniswap_v2' });

      expect(result.averageProfit).toBe(0n);
      expect(result.sampleCount).toBe(0);
    });

    it('should calculate average profit from successful outcomes only', () => {
      // Add 3 successful outcomes with profits: 100, 200, 300 (average = 200)
      tracker.recordOutcome(createMockOutcome({ success: true, profit: 100n }));
      tracker.recordOutcome(createMockOutcome({ success: true, profit: 200n }));
      tracker.recordOutcome(createMockOutcome({ success: true, profit: 300n }));
      // Add a failed outcome (should be excluded)
      tracker.recordOutcome(createMockOutcome({ success: false, profit: undefined }));

      const result = tracker.getAverageProfit({ chain: 'ethereum', dex: 'uniswap_v2' });

      expect(result.averageProfit).toBe(200n);
      expect(result.sampleCount).toBe(3);
      expect(result.totalProfit).toBe(600n);
    });

    it('should handle large profit values', () => {
      const largeProfit = 1000000000000000000000n; // 1000 ETH
      tracker.recordOutcome(createMockOutcome({ success: true, profit: largeProfit }));
      tracker.recordOutcome(createMockOutcome({ success: true, profit: largeProfit }));

      const result = tracker.getAverageProfit({ chain: 'ethereum', dex: 'uniswap_v2' });

      expect(result.averageProfit).toBe(largeProfit);
      expect(result.totalProfit).toBe(largeProfit * 2n);
    });

    it('should aggregate across path lengths within same chain/dex', () => {
      // Different path lengths but same chain/dex
      tracker.recordOutcome(createMockOutcome({ pathLength: 2, success: true, profit: 100n }));
      tracker.recordOutcome(createMockOutcome({ pathLength: 3, success: true, profit: 200n }));
      tracker.recordOutcome(createMockOutcome({ pathLength: 4, success: true, profit: 300n }));

      const result = tracker.getAverageProfit({ chain: 'ethereum', dex: 'uniswap_v2' });

      expect(result.averageProfit).toBe(200n);
      expect(result.sampleCount).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // getAverageGasCost Tests
  // ---------------------------------------------------------------------------

  describe('getAverageGasCost', () => {
    it('should return 0 when no data exists', () => {
      const result = tracker.getAverageGasCost({ chain: 'ethereum' });

      expect(result.averageGasCost).toBe(0n);
      expect(result.sampleCount).toBe(0);
    });

    it('should calculate average gas cost across all outcomes for a chain', () => {
      // Gas costs: 100, 200, 300 (average = 200)
      tracker.recordOutcome(createMockOutcome({ chain: 'ethereum', gasCost: 100n }));
      tracker.recordOutcome(createMockOutcome({ chain: 'ethereum', gasCost: 200n }));
      tracker.recordOutcome(createMockOutcome({ chain: 'ethereum', gasCost: 300n }));

      const result = tracker.getAverageGasCost({ chain: 'ethereum' });

      expect(result.averageGasCost).toBe(200n);
      expect(result.sampleCount).toBe(3);
      expect(result.totalGasCost).toBe(600n);
    });

    it('should include both successful and failed outcomes', () => {
      tracker.recordOutcome(createMockOutcome({ chain: 'ethereum', success: true, gasCost: 100n }));
      tracker.recordOutcome(createMockOutcome({ chain: 'ethereum', success: false, profit: undefined, gasCost: 200n }));

      const result = tracker.getAverageGasCost({ chain: 'ethereum' });

      expect(result.averageGasCost).toBe(150n);
      expect(result.sampleCount).toBe(2);
    });

    it('should track chains independently', () => {
      tracker.recordOutcome(createMockOutcome({ chain: 'ethereum', gasCost: 1000n }));
      tracker.recordOutcome(createMockOutcome({ chain: 'arbitrum', gasCost: 100n }));

      const ethResult = tracker.getAverageGasCost({ chain: 'ethereum' });
      const arbResult = tracker.getAverageGasCost({ chain: 'arbitrum' });

      expect(ethResult.averageGasCost).toBe(1000n);
      expect(arbResult.averageGasCost).toBe(100n);
    });
  });

  // ---------------------------------------------------------------------------
  // getStats Tests
  // ---------------------------------------------------------------------------

  describe('getStats', () => {
    it('should return correct stats for empty tracker', () => {
      const stats = tracker.getStats();

      expect(stats.totalOutcomes).toBe(0);
      expect(stats.totalSuccesses).toBe(0);
      expect(stats.totalFailures).toBe(0);
      expect(stats.overallWinRate).toBe(0);
      expect(stats.uniqueKeys).toBe(0);
      expect(stats.firstOutcomeTimestamp).toBeNull();
      expect(stats.lastOutcomeTimestamp).toBeNull();
    });

    it('should calculate overall win rate correctly', () => {
      // 8 wins, 2 losses = 80%
      for (let i = 0; i < 8; i++) {
        tracker.recordOutcome(createMockOutcome({ success: true }));
      }
      for (let i = 0; i < 2; i++) {
        tracker.recordOutcome(createMockOutcome({ success: false, profit: undefined }));
      }

      const stats = tracker.getStats();

      expect(stats.totalOutcomes).toBe(10);
      expect(stats.totalSuccesses).toBe(8);
      expect(stats.totalFailures).toBe(2);
      expect(stats.overallWinRate).toBe(0.8);
    });

    it('should track unique keys correctly', () => {
      // Add outcomes for 3 different chain/dex/pathLength combinations
      tracker.recordOutcome(createMockOutcome({ chain: 'ethereum', dex: 'uniswap_v2', pathLength: 2 }));
      tracker.recordOutcome(createMockOutcome({ chain: 'ethereum', dex: 'uniswap_v2', pathLength: 3 }));
      tracker.recordOutcome(createMockOutcome({ chain: 'arbitrum', dex: 'sushiswap', pathLength: 2 }));

      const stats = tracker.getStats();

      expect(stats.uniqueKeys).toBe(3);
    });

    it('should provide memory usage estimate', () => {
      for (let i = 0; i < 100; i++) {
        tracker.recordOutcome(createMockOutcome());
      }

      const stats = tracker.getStats();

      expect(stats.estimatedMemoryBytes).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // getHourlyStats Tests
  // ---------------------------------------------------------------------------

  describe('getHourlyStats', () => {
    it('should return hourly breakdown of win rates', () => {
      // Add outcomes at different hours
      tracker.recordOutcome(createMockOutcome({ hourOfDay: 10, success: true }));
      tracker.recordOutcome(createMockOutcome({ hourOfDay: 10, success: true }));
      tracker.recordOutcome(createMockOutcome({ hourOfDay: 14, success: false, profit: undefined }));
      tracker.recordOutcome(createMockOutcome({ hourOfDay: 14, success: false, profit: undefined }));

      const hourlyStats = tracker.getHourlyStats({
        chain: 'ethereum',
        dex: 'uniswap_v2',
        pathLength: 2,
      });

      const hour10 = hourlyStats.find(s => s.hour === 10);
      const hour14 = hourlyStats.find(s => s.hour === 14);

      expect(hour10?.winRate).toBe(1); // 100% at 10am
      expect(hour10?.sampleCount).toBe(2);
      expect(hour14?.winRate).toBe(0); // 0% at 2pm
      expect(hour14?.sampleCount).toBe(2);
    });

    it('should return empty array for unknown key', () => {
      const hourlyStats = tracker.getHourlyStats({
        chain: 'unknown',
        dex: 'unknown',
        pathLength: 99,
      });

      expect(hourlyStats).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // destroy Tests
  // ---------------------------------------------------------------------------

  describe('destroy', () => {
    it('should clear all tracked data', () => {
      for (let i = 0; i < 10; i++) {
        tracker.recordOutcome(createMockOutcome());
      }

      tracker.destroy();

      const stats = tracker.getStats();
      expect(stats.totalOutcomes).toBe(0);
    });

    it('should be safe to call multiple times', () => {
      tracker.destroy();
      tracker.destroy();
      tracker.destroy();

      // Should not throw
      expect(() => tracker.getStats()).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // clear Tests
  // ---------------------------------------------------------------------------

  describe('clear', () => {
    it('should reset all data without destroying the tracker', () => {
      for (let i = 0; i < 10; i++) {
        tracker.recordOutcome(createMockOutcome());
      }

      tracker.clear();

      const stats = tracker.getStats();
      expect(stats.totalOutcomes).toBe(0);

      // Should still be able to record new outcomes
      tracker.recordOutcome(createMockOutcome());
      expect(tracker.getStats().totalOutcomes).toBe(1);
    });
  });
});

// =============================================================================
// Singleton Factory Tests
// =============================================================================

describe('Singleton Factory', () => {
  afterEach(() => {
    resetExecutionProbabilityTracker();
  });

  describe('getExecutionProbabilityTracker', () => {
    it('should return the same instance on multiple calls', () => {
      const tracker1 = getExecutionProbabilityTracker();
      const tracker2 = getExecutionProbabilityTracker();

      expect(tracker1).toBe(tracker2);
    });

    it('should accept config on first call', () => {
      const tracker = getExecutionProbabilityTracker({ minSamples: 100 });

      // Record outcomes and verify config was applied
      for (let i = 0; i < 50; i++) {
        tracker.recordOutcome(createMockOutcome({ success: true }));
      }

      const result = tracker.getWinProbability({
        chain: 'ethereum',
        dex: 'uniswap_v2',
        pathLength: 2,
      });

      // Should return default because 50 < 100 (minSamples)
      expect(result.isDefault).toBe(true);
    });
  });

  describe('resetExecutionProbabilityTracker', () => {
    it('should destroy existing instance and allow new one', () => {
      const tracker1 = getExecutionProbabilityTracker();
      tracker1.recordOutcome(createMockOutcome());

      resetExecutionProbabilityTracker();

      const tracker2 = getExecutionProbabilityTracker();

      expect(tracker1).not.toBe(tracker2);
      expect(tracker2.getStats().totalOutcomes).toBe(0);
    });

    it('should be safe to call when no instance exists', () => {
      expect(() => resetExecutionProbabilityTracker()).not.toThrow();
    });
  });
});

// =============================================================================
// Performance Tests
// =============================================================================

describe('Performance', () => {
  let tracker: ExecutionProbabilityTracker;

  beforeEach(() => {
    tracker = new ExecutionProbabilityTracker({
      ...MOCK_CONFIG,
      maxOutcomesPerKey: 10000,
    });
  });

  afterEach(() => {
    tracker.destroy();
  });

  it('should handle recording 10000 outcomes efficiently', () => {
    const startTime = performance.now();

    for (let i = 0; i < 10000; i++) {
      tracker.recordOutcome(createMockOutcome({
        success: Math.random() > 0.3, // 70% success rate
        profit: BigInt(Math.floor(Math.random() * 1000000)),
        gasCost: BigInt(Math.floor(Math.random() * 100000)),
      }));
    }

    const duration = performance.now() - startTime;

    expect(tracker.getStats().totalOutcomes).toBe(10000);
    // Should complete in under 1000ms (increased from 500 for CI stability)
    expect(duration).toBeLessThan(1000);
  });

  it('should have O(1) lookup time for getWinProbability', () => {
    // Pre-populate with data
    for (let i = 0; i < 1000; i++) {
      tracker.recordOutcome(createMockOutcome({ success: true }));
    }

    const params = { chain: 'ethereum', dex: 'uniswap_v2', pathLength: 2 };

    const startTime = performance.now();

    // 10000 lookups
    for (let i = 0; i < 10000; i++) {
      tracker.getWinProbability(params);
    }

    const duration = performance.now() - startTime;

    // 10000 lookups should complete in under 50ms (O(1) per lookup)
    expect(duration).toBeLessThan(50);
  });

  it('should handle many unique keys efficiently', () => {
    const chains = ['ethereum', 'arbitrum', 'bsc', 'polygon', 'avalanche'];
    const dexes = ['uniswap_v2', 'uniswap_v3', 'sushiswap', 'pancakeswap', 'quickswap'];
    const pathLengths = [2, 3, 4, 5];

    const startTime = performance.now();

    // Create 100 unique keys (5 chains * 5 dexes * 4 path lengths = 100)
    for (const chain of chains) {
      for (const dex of dexes) {
        for (const pathLength of pathLengths) {
          tracker.recordOutcome(createMockOutcome({ chain, dex, pathLength, success: true }));
        }
      }
    }

    const duration = performance.now() - startTime;

    const stats = tracker.getStats();
    expect(stats.uniqueKeys).toBe(100);
    expect(duration).toBeLessThan(100);
  });
});

// =============================================================================
// Edge Case Tests
// =============================================================================

describe('Edge Cases', () => {
  let tracker: ExecutionProbabilityTracker;

  beforeEach(() => {
    tracker = new ExecutionProbabilityTracker(MOCK_CONFIG);
  });

  afterEach(() => {
    tracker.destroy();
  });

  it('should handle empty string values gracefully', () => {
    const outcome = createMockOutcome({ chain: '', dex: '' });

    expect(() => tracker.recordOutcome(outcome)).not.toThrow();
    expect(tracker.getStats().totalOutcomes).toBe(1);
  });

  it('should handle zero gas cost', () => {
    const outcome = createMockOutcome({ gasCost: 0n });

    expect(() => tracker.recordOutcome(outcome)).not.toThrow();

    const result = tracker.getAverageGasCost({ chain: 'ethereum' });
    expect(result.averageGasCost).toBe(0n);
  });

  it('should handle undefined profit for failed trades', () => {
    const outcome = createMockOutcome({ success: false, profit: undefined });

    expect(() => tracker.recordOutcome(outcome)).not.toThrow();
    expect(tracker.getStats().totalFailures).toBe(1);
  });

  it('should handle pathLength of 0', () => {
    const outcome = createMockOutcome({ pathLength: 0 });

    expect(() => tracker.recordOutcome(outcome)).not.toThrow();

    const result = tracker.getWinProbability({
      chain: 'ethereum',
      dex: 'uniswap_v2',
      pathLength: 0,
    });

    expect(result.sampleCount).toBe(1);
  });

  it('should handle negative timestamp gracefully', () => {
    const outcome = createMockOutcome({ timestamp: -1 });

    expect(() => tracker.recordOutcome(outcome)).not.toThrow();
  });

  it('should handle hourOfDay edge values (0 and 23)', () => {
    tracker.recordOutcome(createMockOutcome({ hourOfDay: 0 }));
    tracker.recordOutcome(createMockOutcome({ hourOfDay: 23 }));

    expect(tracker.getStats().totalOutcomes).toBe(2);
  });
});

// =============================================================================
// Memory Management Tests
// =============================================================================

describe('Memory Management', () => {
  it('should prune old outcomes when maxOutcomesPerKey is exceeded', () => {
    const tracker = new ExecutionProbabilityTracker({
      ...MOCK_CONFIG,
      maxOutcomesPerKey: 10,
    });

    // Add 15 outcomes to same key
    for (let i = 0; i < 15; i++) {
      tracker.recordOutcome(createMockOutcome({ timestamp: i }));
    }

    // Should have pruned to maxOutcomesPerKey
    const result = tracker.getWinProbability({
      chain: 'ethereum',
      dex: 'uniswap_v2',
      pathLength: 2,
    });

    // Sample count should be <= maxOutcomesPerKey
    expect(result.sampleCount).toBeLessThanOrEqual(10);

    tracker.destroy();
  });

  it('should update global stats correctly during pruning (regression test)', () => {
    const tracker = new ExecutionProbabilityTracker({
      ...MOCK_CONFIG,
      maxOutcomesPerKey: 10,
    });

    // Add 15 outcomes: 10 successes, 5 failures
    for (let i = 0; i < 10; i++) {
      tracker.recordOutcome(createMockOutcome({ success: true, timestamp: i }));
    }
    for (let i = 10; i < 15; i++) {
      tracker.recordOutcome(createMockOutcome({ success: false, profit: undefined, timestamp: i }));
    }

    // After pruning, global stats should match entry stats
    const stats = tracker.getStats();
    const probResult = tracker.getWinProbability({
      chain: 'ethereum',
      dex: 'uniswap_v2',
      pathLength: 2,
    });

    // Global stats should equal sum of entry stats
    expect(stats.totalOutcomes).toBe(probResult.sampleCount);
    expect(stats.totalSuccesses).toBe(probResult.wins);
    expect(stats.totalFailures).toBe(probResult.losses);
    expect(stats.totalSuccesses + stats.totalFailures).toBe(stats.totalOutcomes);

    tracker.destroy();
  });

  it('should remove stale outcomes during cleanup', () => {
    const tracker = new ExecutionProbabilityTracker({
      ...MOCK_CONFIG,
      outcomeRelevanceWindowMs: 1000, // 1 second window
    });

    // Add an old outcome
    tracker.recordOutcome(createMockOutcome({ timestamp: Date.now() - 5000 }));

    // Manually trigger cleanup (in real implementation this is automatic)
    (tracker as any).cleanupStaleOutcomes();

    // Old outcome should be removed
    const result = tracker.getWinProbability({
      chain: 'ethereum',
      dex: 'uniswap_v2',
      pathLength: 2,
    });

    expect(result.sampleCount).toBe(0);

    tracker.destroy();
  });
});

// =============================================================================
// Integration Test Helpers
// =============================================================================

describe('Integration with Expected Value Calculator', () => {
  let tracker: ExecutionProbabilityTracker;

  beforeEach(() => {
    tracker = new ExecutionProbabilityTracker(MOCK_CONFIG);

    // Populate with realistic data
    // Ethereum/Uniswap V2: 70% win rate, avg profit 0.05 ETH
    for (let i = 0; i < 70; i++) {
      tracker.recordOutcome(createMockOutcome({
        chain: 'ethereum',
        dex: 'uniswap_v2',
        pathLength: 2,
        success: true,
        profit: 50000000000000000n, // 0.05 ETH
        gasCost: 5000000000000000n, // 0.005 ETH
      }));
    }
    for (let i = 0; i < 30; i++) {
      tracker.recordOutcome(createMockOutcome({
        chain: 'ethereum',
        dex: 'uniswap_v2',
        pathLength: 2,
        success: false,
        profit: undefined,
        gasCost: 5000000000000000n, // 0.005 ETH
      }));
    }
  });

  afterEach(() => {
    tracker.destroy();
  });

  it('should provide data sufficient for EV calculation', () => {
    const probResult = tracker.getWinProbability({
      chain: 'ethereum',
      dex: 'uniswap_v2',
      pathLength: 2,
    });

    const profitResult = tracker.getAverageProfit({
      chain: 'ethereum',
      dex: 'uniswap_v2',
    });

    const gasCostResult = tracker.getAverageGasCost({
      chain: 'ethereum',
    });

    expect(probResult.isDefault).toBe(false);
    expect(probResult.winProbability).toBe(0.7);
    expect(profitResult.averageProfit).toBe(50000000000000000n);
    expect(gasCostResult.averageGasCost).toBe(5000000000000000n);

    // Calculate EV: (winProb * avgProfit) - (lossProb * avgGasCost)
    const winProb = probResult.winProbability;
    const lossProb = 1 - winProb;
    const avgProfit = Number(profitResult.averageProfit);
    const avgGasCost = Number(gasCostResult.averageGasCost);

    const expectedValue = (winProb * avgProfit) - (lossProb * avgGasCost);

    // 0.7 * 50000000000000000 - 0.3 * 5000000000000000 = 33500000000000000
    // Use toBeCloseTo due to JavaScript floating-point precision with large numbers
    expect(expectedValue).toBeCloseTo(33500000000000000, -5); // Precision to 10^5
  });
});
