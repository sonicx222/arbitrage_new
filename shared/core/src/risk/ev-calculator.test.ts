/**
 * EV Calculator Tests (TDD)
 *
 * Phase 3: Capital & Risk Controls (P0)
 * Task 3.4.2: Expected Value Calculator
 *
 * @see docs/reports/implementation_plan_v3.md Section 3.4.2
 */

import {
  EVCalculator,
  getEVCalculator,
  resetEVCalculator,
} from './ev-calculator';
import {
  ExecutionProbabilityTracker,
  resetExecutionProbabilityTracker,
} from './execution-probability-tracker';
import type {
  EVConfig,
  EVInput,
  ExecutionOutcome,
  ExecutionProbabilityConfig,
} from './types';

// =============================================================================
// Test Helpers
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

const createMockEVInput = (overrides: Partial<EVInput> = {}): EVInput => ({
  chain: 'ethereum',
  dex: 'uniswap_v2',
  pathLength: 2,
  estimatedProfit: 100000000000000000n, // 0.1 ETH
  estimatedGas: 10000000000000000n, // 0.01 ETH
  ...overrides,
});

const MOCK_TRACKER_CONFIG: Partial<ExecutionProbabilityConfig> = {
  minSamples: 5,
  defaultWinProbability: 0.5,
  persistToRedis: false,
};

const MOCK_EV_CONFIG: EVConfig = {
  minEVThreshold: 5000000000000000n, // 0.005 ETH (~$10 at $2000/ETH)
  minWinProbability: 0.3,
  maxLossPerTrade: 100000000000000000n, // 0.1 ETH
  useHistoricalGasCost: true,
  defaultGasCost: 10000000000000000n, // 0.01 ETH
  defaultProfitEstimate: 50000000000000000n, // 0.05 ETH
};

// =============================================================================
// Unit Tests
// =============================================================================

describe('EVCalculator', () => {
  let tracker: ExecutionProbabilityTracker;
  let calculator: EVCalculator;

  beforeEach(() => {
    tracker = new ExecutionProbabilityTracker(MOCK_TRACKER_CONFIG);
    calculator = new EVCalculator(tracker, MOCK_EV_CONFIG);
  });

  afterEach(() => {
    calculator.destroy();
    tracker.destroy();
    resetExecutionProbabilityTracker();
    resetEVCalculator();
  });

  // ---------------------------------------------------------------------------
  // Constructor Tests
  // ---------------------------------------------------------------------------

  describe('constructor', () => {
    it('should initialize with provided config', () => {
      expect(calculator).toBeDefined();
      const stats = calculator.getStats();
      expect(stats.totalCalculations).toBe(0);
    });

    it('should use default config when partial config provided', () => {
      const partialConfig: Partial<EVConfig> = {
        minEVThreshold: 1000n,
      };
      const calc = new EVCalculator(tracker, partialConfig as EVConfig);
      expect(calc).toBeDefined();
      calc.destroy();
    });
  });

  // ---------------------------------------------------------------------------
  // calculate Tests - Basic EV Formula
  // ---------------------------------------------------------------------------

  describe('calculate', () => {
    describe('basic EV formula', () => {
      it('should calculate EV using formula: (winProb × profit) - (lossProb × gasCost)', () => {
        // Populate tracker with known data: 70% win rate
        for (let i = 0; i < 7; i++) {
          tracker.recordOutcome(createMockOutcome({ success: true }));
        }
        for (let i = 0; i < 3; i++) {
          tracker.recordOutcome(createMockOutcome({ success: false, profit: undefined }));
        }

        const input: EVInput = {
          chain: 'ethereum',
          dex: 'uniswap_v2',
          pathLength: 2,
          estimatedProfit: 100000000000000000n, // 0.1 ETH
          estimatedGas: 10000000000000000n, // 0.01 ETH
        };

        const result = calculator.calculate(input);

        // EV = 0.7 * 0.1 ETH - 0.3 * 0.01 ETH = 0.07 - 0.003 = 0.067 ETH
        expect(result.winProbability).toBe(0.7);
        expect(result.expectedProfit).toBe(70000000000000000n); // 0.07 ETH
        expect(result.expectedGasCost).toBe(3000000000000000n); // 0.003 ETH
        expect(result.expectedValue).toBe(67000000000000000n); // 0.067 ETH
      });

      it('should return positive EV when profitable', () => {
        // High win rate (90%)
        for (let i = 0; i < 9; i++) {
          tracker.recordOutcome(createMockOutcome({ success: true }));
        }
        tracker.recordOutcome(createMockOutcome({ success: false, profit: undefined }));

        const result = calculator.calculate(createMockEVInput());

        expect(result.expectedValue).toBeGreaterThan(0n);
        expect(result.shouldExecute).toBe(true);
      });

      it('should return negative EV when unprofitable', () => {
        // Low win rate (10%)
        tracker.recordOutcome(createMockOutcome({ success: true }));
        for (let i = 0; i < 9; i++) {
          tracker.recordOutcome(createMockOutcome({ success: false, profit: undefined }));
        }

        const input = createMockEVInput({
          estimatedProfit: 10000000000000000n, // 0.01 ETH (small profit)
          estimatedGas: 50000000000000000n, // 0.05 ETH (high gas)
        });

        const result = calculator.calculate(input);

        // EV = 0.1 * 0.01 - 0.9 * 0.05 = 0.001 - 0.045 = -0.044 ETH
        expect(result.expectedValue).toBeLessThan(0n);
        expect(result.shouldExecute).toBe(false);
      });

      it('should handle zero win probability', () => {
        // 0% win rate
        for (let i = 0; i < 5; i++) {
          tracker.recordOutcome(createMockOutcome({ success: false, profit: undefined }));
        }

        const result = calculator.calculate(createMockEVInput());

        expect(result.winProbability).toBe(0);
        // EV = 0 * profit - 1 * gasCost = -gasCost
        expect(result.expectedValue).toBe(-10000000000000000n);
        expect(result.shouldExecute).toBe(false);
      });

      it('should handle 100% win probability', () => {
        // 100% win rate
        for (let i = 0; i < 5; i++) {
          tracker.recordOutcome(createMockOutcome({ success: true }));
        }

        const result = calculator.calculate(createMockEVInput());

        expect(result.winProbability).toBe(1);
        // EV = 1 * profit - 0 * gasCost = profit
        expect(result.expectedValue).toBe(100000000000000000n);
        expect(result.shouldExecute).toBe(true);
      });
    });

    // ---------------------------------------------------------------------------
    // calculate Tests - Default Probability
    // ---------------------------------------------------------------------------

    describe('default probability handling', () => {
      it('should use default probability when no historical data exists', () => {
        const result = calculator.calculate(createMockEVInput());

        expect(result.probabilitySource).toBe('default');
        expect(result.winProbability).toBe(0.5); // Default from tracker config
        expect(result.sampleCount).toBe(0);
      });

      it('should use default probability when below minSamples', () => {
        // Add 3 samples (below minSamples of 5)
        for (let i = 0; i < 3; i++) {
          tracker.recordOutcome(createMockOutcome({ success: true }));
        }

        const result = calculator.calculate(createMockEVInput());

        expect(result.probabilitySource).toBe('default');
        expect(result.sampleCount).toBe(3);
      });

      it('should use historical probability when sufficient data exists', () => {
        // Add 10 samples (above minSamples)
        for (let i = 0; i < 8; i++) {
          tracker.recordOutcome(createMockOutcome({ success: true }));
        }
        for (let i = 0; i < 2; i++) {
          tracker.recordOutcome(createMockOutcome({ success: false, profit: undefined }));
        }

        const result = calculator.calculate(createMockEVInput());

        expect(result.probabilitySource).toBe('historical');
        expect(result.winProbability).toBe(0.8);
        expect(result.sampleCount).toBe(10);
      });
    });

    // ---------------------------------------------------------------------------
    // calculate Tests - shouldExecute Logic
    // ---------------------------------------------------------------------------

    describe('shouldExecute logic', () => {
      beforeEach(() => {
        // Set up 60% win rate
        for (let i = 0; i < 6; i++) {
          tracker.recordOutcome(createMockOutcome({ success: true }));
        }
        for (let i = 0; i < 4; i++) {
          tracker.recordOutcome(createMockOutcome({ success: false, profit: undefined }));
        }
      });

      it('should approve when EV exceeds threshold', () => {
        const input = createMockEVInput({
          estimatedProfit: 100000000000000000n, // 0.1 ETH
          estimatedGas: 5000000000000000n, // 0.005 ETH
        });

        const result = calculator.calculate(input);

        // EV = 0.6 * 0.1 - 0.4 * 0.005 = 0.06 - 0.002 = 0.058 ETH
        expect(result.expectedValue).toBeGreaterThan(MOCK_EV_CONFIG.minEVThreshold);
        expect(result.shouldExecute).toBe(true);
        expect(result.reason).toBeUndefined();
      });

      it('should reject when EV is below threshold', () => {
        const input = createMockEVInput({
          estimatedProfit: 10000000000000000n, // 0.01 ETH (small)
          estimatedGas: 5000000000000000n, // 0.005 ETH
        });

        const result = calculator.calculate(input);

        // EV = 0.6 * 0.01 - 0.4 * 0.005 = 0.006 - 0.002 = 0.004 ETH
        // Threshold is 0.005 ETH
        expect(result.expectedValue).toBeLessThan(MOCK_EV_CONFIG.minEVThreshold);
        expect(result.shouldExecute).toBe(false);
        expect(result.reason).toContain('below threshold');
      });

      it('should reject when win probability is below minimum', () => {
        // Reset and add low win rate data
        tracker.clear();
        for (let i = 0; i < 2; i++) {
          tracker.recordOutcome(createMockOutcome({ success: true }));
        }
        for (let i = 0; i < 8; i++) {
          tracker.recordOutcome(createMockOutcome({ success: false, profit: undefined }));
        }

        const input = createMockEVInput({
          estimatedProfit: 1000000000000000000n, // 1 ETH (high profit)
          estimatedGas: 1000000000000000n, // 0.001 ETH (low gas)
        });

        const result = calculator.calculate(input);

        expect(result.winProbability).toBe(0.2); // Below 0.3 threshold
        expect(result.shouldExecute).toBe(false);
        expect(result.reason).toContain('probability');
      });

      it('should reject when both EV and probability are low', () => {
        tracker.clear();
        for (let i = 0; i < 1; i++) {
          tracker.recordOutcome(createMockOutcome({ success: true }));
        }
        for (let i = 0; i < 9; i++) {
          tracker.recordOutcome(createMockOutcome({ success: false, profit: undefined }));
        }

        const input = createMockEVInput({
          estimatedProfit: 5000000000000000n, // 0.005 ETH
          estimatedGas: 10000000000000000n, // 0.01 ETH
        });

        const result = calculator.calculate(input);

        expect(result.shouldExecute).toBe(false);
        // Should mention low probability (the primary blocker)
        expect(result.reason).toContain('probability');
      });

      it('should reject when potential loss exceeds maxLossPerTrade', () => {
        // Create calculator with low maxLossPerTrade
        const lowMaxLossCalc = new EVCalculator(tracker, {
          ...MOCK_EV_CONFIG,
          maxLossPerTrade: 5000000000000000n, // 0.005 ETH max loss
        });

        const input = createMockEVInput({
          estimatedProfit: 1000000000000000000n, // 1 ETH (high profit)
          estimatedGas: 10000000000000000n, // 0.01 ETH (exceeds max loss)
        });

        const result = lowMaxLossCalc.calculate(input);

        expect(result.shouldExecute).toBe(false);
        expect(result.reason).toContain('Potential loss');
        expect(result.reason).toContain('exceeds max loss');

        lowMaxLossCalc.destroy();
      });

      it('should approve when potential loss is within maxLossPerTrade', () => {
        const input = createMockEVInput({
          estimatedProfit: 1000000000000000000n, // 1 ETH
          estimatedGas: 50000000000000000n, // 0.05 ETH (within 0.1 ETH max)
        });

        const result = calculator.calculate(input);

        // Should pass the max loss check (0.05 ETH < 0.1 ETH max)
        // Win probability check should also pass (60% > 30%)
        expect(result.shouldExecute).toBe(true);
      });

      it('should track rejectedMaxLoss in statistics', () => {
        const lowMaxLossCalc = new EVCalculator(tracker, {
          ...MOCK_EV_CONFIG,
          maxLossPerTrade: 1000000000000000n, // 0.001 ETH max loss (very low)
        });

        // This should be rejected due to max loss
        lowMaxLossCalc.calculate(createMockEVInput({
          estimatedProfit: 1000000000000000000n,
          estimatedGas: 10000000000000000n, // 0.01 ETH > 0.001 max
        }));

        const stats = lowMaxLossCalc.getStats();

        expect(stats.rejectedMaxLoss).toBe(1);
        expect(stats.totalCalculations).toBe(1);
        expect(stats.approvedCount).toBe(0);

        lowMaxLossCalc.destroy();
      });
    });

    // ---------------------------------------------------------------------------
    // calculate Tests - Input Flexibility
    // ---------------------------------------------------------------------------

    describe('input flexibility', () => {
      beforeEach(() => {
        // Set up 50% win rate
        for (let i = 0; i < 5; i++) {
          tracker.recordOutcome(createMockOutcome({ success: true }));
        }
        for (let i = 0; i < 5; i++) {
          tracker.recordOutcome(createMockOutcome({ success: false, profit: undefined }));
        }
      });

      it('should accept expectedProfit as alternative to estimatedProfit', () => {
        const input: EVInput = {
          chain: 'ethereum',
          dex: 'uniswap_v2',
          expectedProfit: 100000000000000000n,
          estimatedGas: 10000000000000000n,
        };

        const result = calculator.calculate(input);

        expect(result.rawProfitEstimate).toBe(100000000000000000n);
      });

      it('should accept gasEstimate as alternative to estimatedGas', () => {
        const input: EVInput = {
          chain: 'ethereum',
          dex: 'uniswap_v2',
          estimatedProfit: 100000000000000000n,
          gasEstimate: 20000000000000000n,
        };

        const result = calculator.calculate(input);

        expect(result.rawGasCost).toBe(20000000000000000n);
      });

      it('should infer pathLength from path array', () => {
        const input: EVInput = {
          chain: 'ethereum',
          dex: 'uniswap_v2',
          path: ['WETH', 'USDC', 'DAI', 'WETH'], // 3 hops
          estimatedProfit: 100000000000000000n,
          estimatedGas: 10000000000000000n,
        };

        // This will query with pathLength 3
        const result = calculator.calculate(input);

        // Just verify it doesn't crash and uses the path
        expect(result).toBeDefined();
      });

      it('should default pathLength to 2 when not provided', () => {
        const input: EVInput = {
          chain: 'ethereum',
          dex: 'uniswap_v2',
          estimatedProfit: 100000000000000000n,
          estimatedGas: 10000000000000000n,
        };

        const result = calculator.calculate(input);

        // Should use the probability for pathLength 2
        expect(result.sampleCount).toBe(10); // Our mock data has 10 samples
      });

      it('should use historical gas cost when estimatedGas not provided', () => {
        // Add outcomes with known gas costs
        tracker.clear();
        for (let i = 0; i < 10; i++) {
          tracker.recordOutcome(createMockOutcome({
            success: i < 5,
            profit: i < 5 ? 50000000000000000n : undefined,
            gasCost: 15000000000000000n, // 0.015 ETH
          }));
        }

        const input: EVInput = {
          chain: 'ethereum',
          dex: 'uniswap_v2',
          estimatedProfit: 100000000000000000n,
          // No estimatedGas - should use historical
        };

        const result = calculator.calculate(input);

        // Should use historical gas cost
        expect(result.rawGasCost).toBe(15000000000000000n);
      });

      it('should use default gas cost when no data and no estimate', () => {
        // Create calculator that doesn't use historical
        const noHistoryCalc = new EVCalculator(tracker, {
          ...MOCK_EV_CONFIG,
          useHistoricalGasCost: false,
        });

        const input: EVInput = {
          chain: 'ethereum',
          dex: 'uniswap_v2',
          estimatedProfit: 100000000000000000n,
          // No estimatedGas
        };

        const result = noHistoryCalc.calculate(input);

        expect(result.rawGasCost).toBe(MOCK_EV_CONFIG.defaultGasCost);

        noHistoryCalc.destroy();
      });
    });

    // ---------------------------------------------------------------------------
    // calculate Tests - BigInt Handling
    // ---------------------------------------------------------------------------

    describe('BigInt handling', () => {
      beforeEach(() => {
        for (let i = 0; i < 5; i++) {
          tracker.recordOutcome(createMockOutcome({ success: true }));
        }
        for (let i = 0; i < 5; i++) {
          tracker.recordOutcome(createMockOutcome({ success: false, profit: undefined }));
        }
      });

      it('should handle very large profit values', () => {
        const input = createMockEVInput({
          estimatedProfit: 1000000000000000000000n, // 1000 ETH
          estimatedGas: 100000000000000000n, // 0.1 ETH
        });

        const result = calculator.calculate(input);

        expect(result.expectedValue).toBeGreaterThan(0n);
        expect(result.rawProfitEstimate).toBe(1000000000000000000000n);
      });

      it('should handle very small values', () => {
        const input = createMockEVInput({
          estimatedProfit: 1000n, // 1000 wei
          estimatedGas: 100n, // 100 wei
        });

        const result = calculator.calculate(input);

        // Just verify it calculates without overflow/underflow
        expect(typeof result.expectedValue).toBe('bigint');
      });

      it('should handle zero profit estimate', () => {
        const input = createMockEVInput({
          estimatedProfit: 0n,
          estimatedGas: 10000000000000000n,
        });

        const result = calculator.calculate(input);

        // EV = 0.5 * 0 - 0.5 * gas = -0.5 * gas
        expect(result.expectedValue).toBe(-5000000000000000n);
        expect(result.shouldExecute).toBe(false);
      });

      it('should handle zero gas estimate', () => {
        const input = createMockEVInput({
          estimatedProfit: 100000000000000000n,
          estimatedGas: 0n,
        });

        const result = calculator.calculate(input);

        // EV = 0.5 * profit - 0.5 * 0 = 0.5 * profit
        expect(result.expectedValue).toBe(50000000000000000n);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // getStats Tests
  // ---------------------------------------------------------------------------

  describe('getStats', () => {
    it('should track total calculations', () => {
      for (let i = 0; i < 5; i++) {
        tracker.recordOutcome(createMockOutcome({ success: true }));
      }

      calculator.calculate(createMockEVInput());
      calculator.calculate(createMockEVInput());
      calculator.calculate(createMockEVInput());

      const stats = calculator.getStats();

      expect(stats.totalCalculations).toBe(3);
    });

    it('should track approved count', () => {
      // High win rate for approvals
      for (let i = 0; i < 9; i++) {
        tracker.recordOutcome(createMockOutcome({ success: true }));
      }
      tracker.recordOutcome(createMockOutcome({ success: false, profit: undefined }));

      const highProfitInput = createMockEVInput({
        estimatedProfit: 1000000000000000000n, // 1 ETH
        estimatedGas: 10000000000000000n, // 0.01 ETH
      });

      calculator.calculate(highProfitInput);
      calculator.calculate(highProfitInput);

      const stats = calculator.getStats();

      expect(stats.approvedCount).toBe(2);
    });

    it('should track rejection reasons', () => {
      // Low win rate
      for (let i = 0; i < 2; i++) {
        tracker.recordOutcome(createMockOutcome({ success: true }));
      }
      for (let i = 0; i < 8; i++) {
        tracker.recordOutcome(createMockOutcome({ success: false, profit: undefined }));
      }

      // Low probability rejection
      calculator.calculate(createMockEVInput({
        estimatedProfit: 1000000000000000000n, // 1 ETH
      }));

      // Reset and set up for low EV rejection
      tracker.clear();
      for (let i = 0; i < 5; i++) {
        tracker.recordOutcome(createMockOutcome({ success: true }));
      }
      for (let i = 0; i < 5; i++) {
        tracker.recordOutcome(createMockOutcome({ success: false, profit: undefined }));
      }

      // Low EV rejection
      calculator.calculate(createMockEVInput({
        estimatedProfit: 1000000000000000n, // 0.001 ETH (very low)
        estimatedGas: 5000000000000000n, // 0.005 ETH
      }));

      const stats = calculator.getStats();

      expect(stats.rejectedLowProbability).toBe(1);
      expect(stats.rejectedLowEV).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // clear Tests
  // ---------------------------------------------------------------------------

  describe('clear', () => {
    it('should reset all stats', () => {
      for (let i = 0; i < 5; i++) {
        tracker.recordOutcome(createMockOutcome({ success: true }));
      }

      calculator.calculate(createMockEVInput());
      calculator.calculate(createMockEVInput());

      calculator.clear();

      const stats = calculator.getStats();

      expect(stats.totalCalculations).toBe(0);
      expect(stats.approvedCount).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // destroy Tests
  // ---------------------------------------------------------------------------

  describe('destroy', () => {
    it('should clear stats on destroy', () => {
      for (let i = 0; i < 5; i++) {
        tracker.recordOutcome(createMockOutcome({ success: true }));
      }

      calculator.calculate(createMockEVInput());
      calculator.destroy();

      const stats = calculator.getStats();

      expect(stats.totalCalculations).toBe(0);
    });

    it('should be safe to call multiple times', () => {
      calculator.destroy();
      calculator.destroy();
      calculator.destroy();

      // Should not throw
      expect(() => calculator.getStats()).not.toThrow();
    });
  });
});

// =============================================================================
// Singleton Factory Tests
// =============================================================================

describe('Singleton Factory', () => {
  let tracker: ExecutionProbabilityTracker;

  beforeEach(() => {
    tracker = new ExecutionProbabilityTracker(MOCK_TRACKER_CONFIG);
  });

  afterEach(() => {
    tracker.destroy();
    resetEVCalculator();
    resetExecutionProbabilityTracker();
  });

  describe('getEVCalculator', () => {
    it('should return the same instance on multiple calls', () => {
      const calc1 = getEVCalculator(tracker, MOCK_EV_CONFIG);
      const calc2 = getEVCalculator(tracker, MOCK_EV_CONFIG);

      expect(calc1).toBe(calc2);
    });

    it('should accept config on first call', () => {
      const customConfig: EVConfig = {
        ...MOCK_EV_CONFIG,
        minEVThreshold: 999999999999999999n,
      };

      const calc = getEVCalculator(tracker, customConfig);

      // Add data and verify config was applied
      for (let i = 0; i < 10; i++) {
        tracker.recordOutcome(createMockOutcome({ success: true }));
      }

      const result = calc.calculate(createMockEVInput());

      // Should be rejected because EV threshold is extremely high
      expect(result.shouldExecute).toBe(false);
    });
  });

  describe('resetEVCalculator', () => {
    it('should destroy existing instance and allow new one', () => {
      const calc1 = getEVCalculator(tracker, MOCK_EV_CONFIG);

      for (let i = 0; i < 5; i++) {
        tracker.recordOutcome(createMockOutcome({ success: true }));
      }
      calc1.calculate(createMockEVInput());

      resetEVCalculator();

      const calc2 = getEVCalculator(tracker, MOCK_EV_CONFIG);

      expect(calc1).not.toBe(calc2);
      expect(calc2.getStats().totalCalculations).toBe(0);
    });

    it('should be safe to call when no instance exists', () => {
      expect(() => resetEVCalculator()).not.toThrow();
    });
  });
});

// =============================================================================
// Performance Tests
// =============================================================================

describe('Performance', () => {
  let tracker: ExecutionProbabilityTracker;
  let calculator: EVCalculator;

  beforeEach(() => {
    tracker = new ExecutionProbabilityTracker(MOCK_TRACKER_CONFIG);
    calculator = new EVCalculator(tracker, MOCK_EV_CONFIG);

    // Pre-populate with data
    for (let i = 0; i < 100; i++) {
      tracker.recordOutcome(createMockOutcome({
        success: Math.random() > 0.3,
      }));
    }
  });

  afterEach(() => {
    calculator.destroy();
    tracker.destroy();
  });

  it('should calculate EV in under 1ms per call', () => {
    const input = createMockEVInput();
    const iterations = 10000;

    const startTime = performance.now();

    for (let i = 0; i < iterations; i++) {
      calculator.calculate(input);
    }

    const duration = performance.now() - startTime;
    const avgTimeMs = duration / iterations;

    // Per the implementation plan: "EV calculation adds <1ms latency per opportunity"
    expect(avgTimeMs).toBeLessThan(1);
  });

  it('should handle high volume calculations efficiently', () => {
    const startTime = performance.now();

    for (let i = 0; i < 10000; i++) {
      calculator.calculate(createMockEVInput({
        estimatedProfit: BigInt(Math.floor(Math.random() * 1000000000000000000)),
        estimatedGas: BigInt(Math.floor(Math.random() * 100000000000000000)),
      }));
    }

    const duration = performance.now() - startTime;

    // 10000 calculations should complete in under 500ms
    expect(duration).toBeLessThan(500);

    const stats = calculator.getStats();
    expect(stats.totalCalculations).toBe(10000);
  });
});

// =============================================================================
// Integration Tests
// =============================================================================

describe('Integration with ExecutionProbabilityTracker', () => {
  let tracker: ExecutionProbabilityTracker;
  let calculator: EVCalculator;

  beforeEach(() => {
    tracker = new ExecutionProbabilityTracker(MOCK_TRACKER_CONFIG);
    calculator = new EVCalculator(tracker, MOCK_EV_CONFIG);
  });

  afterEach(() => {
    calculator.destroy();
    tracker.destroy();
  });

  it('should use tracker data for probability calculations', () => {
    // Build up history with 80% success rate
    for (let i = 0; i < 80; i++) {
      tracker.recordOutcome(createMockOutcome({
        success: true,
        profit: 100000000000000000n, // 0.1 ETH
        gasCost: 5000000000000000n, // 0.005 ETH
      }));
    }
    for (let i = 0; i < 20; i++) {
      tracker.recordOutcome(createMockOutcome({
        success: false,
        profit: undefined,
        gasCost: 5000000000000000n,
      }));
    }

    const input = createMockEVInput({
      estimatedProfit: 100000000000000000n, // 0.1 ETH
      estimatedGas: 5000000000000000n, // 0.005 ETH
    });

    const result = calculator.calculate(input);

    expect(result.winProbability).toBe(0.8);
    expect(result.probabilitySource).toBe('historical');
    expect(result.sampleCount).toBe(100);

    // EV = 0.8 * 0.1 - 0.2 * 0.005 = 0.08 - 0.001 = 0.079 ETH
    // Note: Using a tolerance range due to BigInt integer division rounding
    // The theoretical value is 79000000000000000n, allow 0.01% tolerance
    const expectedEV = 79000000000000000n;
    const tolerance = expectedEV / 10000n; // 0.01%
    expect(result.expectedValue).toBeGreaterThanOrEqual(expectedEV - tolerance);
    expect(result.expectedValue).toBeLessThanOrEqual(expectedEV + tolerance);
    expect(result.shouldExecute).toBe(true);
  });

  it('should handle different chain/dex combinations independently', () => {
    // Ethereum/Uniswap: 90% win rate
    for (let i = 0; i < 9; i++) {
      tracker.recordOutcome(createMockOutcome({
        chain: 'ethereum',
        dex: 'uniswap_v2',
        success: true,
      }));
    }
    tracker.recordOutcome(createMockOutcome({
      chain: 'ethereum',
      dex: 'uniswap_v2',
      success: false,
      profit: undefined,
    }));

    // Arbitrum/Sushiswap: 40% win rate
    for (let i = 0; i < 4; i++) {
      tracker.recordOutcome(createMockOutcome({
        chain: 'arbitrum',
        dex: 'sushiswap',
        success: true,
      }));
    }
    for (let i = 0; i < 6; i++) {
      tracker.recordOutcome(createMockOutcome({
        chain: 'arbitrum',
        dex: 'sushiswap',
        success: false,
        profit: undefined,
      }));
    }

    const ethResult = calculator.calculate(createMockEVInput({
      chain: 'ethereum',
      dex: 'uniswap_v2',
    }));

    const arbResult = calculator.calculate(createMockEVInput({
      chain: 'arbitrum',
      dex: 'sushiswap',
    }));

    expect(ethResult.winProbability).toBe(0.9);
    expect(arbResult.winProbability).toBe(0.4);
    expect(ethResult.expectedValue).toBeGreaterThan(arbResult.expectedValue);
  });
});

// =============================================================================
// Edge Cases
// =============================================================================

describe('Edge Cases', () => {
  let tracker: ExecutionProbabilityTracker;
  let calculator: EVCalculator;

  beforeEach(() => {
    tracker = new ExecutionProbabilityTracker(MOCK_TRACKER_CONFIG);
    calculator = new EVCalculator(tracker, MOCK_EV_CONFIG);

    for (let i = 0; i < 5; i++) {
      tracker.recordOutcome(createMockOutcome({ success: true }));
    }
    for (let i = 0; i < 5; i++) {
      tracker.recordOutcome(createMockOutcome({ success: false, profit: undefined }));
    }
  });

  afterEach(() => {
    calculator.destroy();
    tracker.destroy();
  });

  it('should handle empty chain string', () => {
    const input = createMockEVInput({ chain: '' });

    // Should not throw
    expect(() => calculator.calculate(input)).not.toThrow();
  });

  it('should handle empty dex string', () => {
    const input = createMockEVInput({ dex: '' });

    expect(() => calculator.calculate(input)).not.toThrow();
  });

  it('should handle pathLength 0', () => {
    const input = createMockEVInput({ pathLength: 0 });

    const result = calculator.calculate(input);

    expect(result).toBeDefined();
  });

  it('should handle empty path array', () => {
    const input: EVInput = {
      chain: 'ethereum',
      dex: 'uniswap_v2',
      path: [],
      estimatedProfit: 100000000000000000n,
      estimatedGas: 10000000000000000n,
    };

    const result = calculator.calculate(input);

    expect(result).toBeDefined();
  });

  it('should handle undefined optional fields', () => {
    const input: EVInput = {
      chain: 'ethereum',
      dex: 'uniswap_v2',
      // All optional fields undefined
    };

    const result = calculator.calculate(input);

    expect(result).toBeDefined();
    // Should use defaults
    expect(result.rawProfitEstimate).toBe(MOCK_EV_CONFIG.defaultProfitEstimate);
  });
});
