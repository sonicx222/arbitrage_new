/**
 * Hot-Path Performance Tests
 *
 * P1-2 FIX: Guards against performance regressions in latency-critical code paths.
 *
 * Target: <50ms for complete price-update → detection → opportunity pipeline
 *
 * Individual component budgets:
 * - Price calculation: <0.1ms (100μs)
 * - PriceMatrix read/write: <0.01ms (10μs)
 * - Arbitrage detection (per pair): <1ms
 * - Full detection cycle: <50ms
 *
 * @see ADR-005: L1 Cache
 * @see hot-path documentation in base-detector.ts
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';

// Import hot-path modules directly to test in isolation
import {
  calculatePriceFromReserves,
  calculateSpread,
  calculateNetProfit,
  meetsThreshold,
  safeBigIntDivision
} from '../../src/components/price-calculator';
import {
  PriceMatrix,
  resetPriceMatrix
} from '../../src/caching/price-matrix';

// =============================================================================
// Performance Test Configuration
// =============================================================================

const HOT_PATH_THRESHOLDS = {
  // Price calculation from reserves (should be <100μs)
  priceCalculationMaxUs: 100,

  // PriceMatrix single read (should be <10μs)
  priceMatrixReadMaxUs: 10,

  // PriceMatrix single write (should be <10μs)
  priceMatrixWriteMaxUs: 10,

  // Spread calculation (should be <10μs)
  spreadCalculationMaxUs: 10,

  // Full detection cycle per pair (should be <1ms)
  detectionPerPairMaxMs: 1,

  // Batch of 100 price updates + detection (should be <50ms)
  fullCycleMaxMs: 50,

  // Iterations for statistical significance
  iterations: 1000,

  // Warm-up iterations (discarded)
  warmupIterations: 100
};

// =============================================================================
// Test Utilities
// =============================================================================

/**
 * High-resolution timing using performance.now()
 * Returns time in microseconds
 */
function timeUs(fn: () => void): number {
  const start = performance.now();
  fn();
  return (performance.now() - start) * 1000; // Convert ms to μs
}

/**
 * Run a function multiple times and return statistics
 */
function benchmark(
  fn: () => void,
  iterations: number,
  warmupIterations: number = 100
): {
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
} {
  // Warm up (discard results)
  for (let i = 0; i < warmupIterations; i++) {
    fn();
  }

  // Actual measurements
  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    times.push(timeUs(fn));
  }

  times.sort((a, b) => a - b);

  return {
    min: times[0],
    max: times[times.length - 1],
    avg: times.reduce((a, b) => a + b, 0) / times.length,
    p50: times[Math.floor(times.length * 0.5)],
    p95: times[Math.floor(times.length * 0.95)],
    p99: times[Math.floor(times.length * 0.99)]
  };
}

// =============================================================================
// Test Data
// =============================================================================

// Realistic reserve values (similar to actual DEX pairs)
const SAMPLE_RESERVES = [
  { reserve0: '1000000000000000000000', reserve1: '2000000000000000000' },     // 1000 ETH / 2 WBTC
  { reserve0: '50000000000', reserve1: '50000000000000000000000' },            // 50k USDC / 50k DAI
  { reserve0: '123456789012345678901234', reserve1: '987654321098765432109' }, // Large reserves
];

// Sample price matrix keys
const generatePriceKeys = (count: number): string[] => {
  const keys: string[] = [];
  const chains = ['arbitrum', 'bsc', 'ethereum', 'polygon'];
  const dexes = ['uniswap', 'sushiswap', 'pancakeswap'];
  const tokens = ['WETH', 'USDC', 'USDT', 'WBTC', 'DAI'];

  for (let i = 0; i < count; i++) {
    const chain = chains[i % chains.length];
    const dex = dexes[i % dexes.length];
    const t0 = tokens[i % tokens.length];
    const t1 = tokens[(i + 1) % tokens.length];
    keys.push(`${chain}:${dex}:${t0}_${t1}`);
  }
  return keys;
};

// =============================================================================
// Tests
// =============================================================================

describe('Hot-Path Performance Guards', () => {
  describe('Price Calculation Performance', () => {
    it('should calculate price from reserves within budget', () => {
      const { reserve0, reserve1 } = SAMPLE_RESERVES[0];

      const stats = benchmark(
        () => {
          calculatePriceFromReserves(reserve0, reserve1);
        },
        HOT_PATH_THRESHOLDS.iterations,
        HOT_PATH_THRESHOLDS.warmupIterations
      );

      console.log('Price calculation stats (μs):', stats);

      expect(stats.p95).toBeLessThan(HOT_PATH_THRESHOLDS.priceCalculationMaxUs);
      expect(stats.p99).toBeLessThan(HOT_PATH_THRESHOLDS.priceCalculationMaxUs * 2);
    });

    it('should handle BigInt division efficiently', () => {
      const numerator = BigInt('123456789012345678901234');
      const denominator = BigInt('987654321098765432');

      const stats = benchmark(
        () => {
          safeBigIntDivision(numerator, denominator);
        },
        HOT_PATH_THRESHOLDS.iterations,
        HOT_PATH_THRESHOLDS.warmupIterations
      );

      console.log('BigInt division stats (μs):', stats);

      // BigInt division is slower - allow 500μs
      expect(stats.p95).toBeLessThan(500);
    });

    it('should calculate spread within budget', () => {
      const price1 = 1.0234;
      const price2 = 1.0456;

      const stats = benchmark(
        () => {
          calculateSpread(price1, price2);
        },
        HOT_PATH_THRESHOLDS.iterations,
        HOT_PATH_THRESHOLDS.warmupIterations
      );

      console.log('Spread calculation stats (μs):', stats);

      expect(stats.p95).toBeLessThan(HOT_PATH_THRESHOLDS.spreadCalculationMaxUs);
    });

    it('should calculate net profit within budget', () => {
      const grossSpread = 0.015;
      const fee1 = 0.003;
      const fee2 = 0.003;

      const stats = benchmark(
        () => {
          calculateNetProfit(grossSpread, fee1, fee2);
        },
        HOT_PATH_THRESHOLDS.iterations,
        HOT_PATH_THRESHOLDS.warmupIterations
      );

      console.log('Net profit calculation stats (μs):', stats);

      expect(stats.p95).toBeLessThan(HOT_PATH_THRESHOLDS.spreadCalculationMaxUs);
    });
  });

  describe('PriceMatrix Performance', () => {
    let priceMatrix: PriceMatrix;
    const testKeys = generatePriceKeys(100);

    beforeAll(() => {
      // Create matrix with enough capacity
      priceMatrix = new PriceMatrix({
        maxPairs: 1000,
        reserveSlots: 100,
        enableAtomics: true
      });

      // Pre-populate with test data
      const now = Date.now();
      testKeys.forEach((key, i) => {
        priceMatrix.setPrice(key, 1.0 + i * 0.001, now);
      });
    });

    afterAll(() => {
      resetPriceMatrix();
    });

    it('should write prices within budget', () => {
      const timestamp = Date.now();
      let keyIndex = 0;

      const stats = benchmark(
        () => {
          priceMatrix.setPrice(testKeys[keyIndex % testKeys.length], 1.5, timestamp);
          keyIndex++;
        },
        HOT_PATH_THRESHOLDS.iterations,
        HOT_PATH_THRESHOLDS.warmupIterations
      );

      console.log('PriceMatrix write stats (μs):', stats);

      expect(stats.p95).toBeLessThan(HOT_PATH_THRESHOLDS.priceMatrixWriteMaxUs);
    });

    it('should read prices within budget', () => {
      let keyIndex = 0;

      const stats = benchmark(
        () => {
          priceMatrix.getPrice(testKeys[keyIndex % testKeys.length]);
          keyIndex++;
        },
        HOT_PATH_THRESHOLDS.iterations,
        HOT_PATH_THRESHOLDS.warmupIterations
      );

      console.log('PriceMatrix read stats (μs):', stats);

      expect(stats.p95).toBeLessThan(HOT_PATH_THRESHOLDS.priceMatrixReadMaxUs);
    });

    it('should read price-only within budget (hot-path optimized)', () => {
      let keyIndex = 0;

      const stats = benchmark(
        () => {
          priceMatrix.getPriceOnly(testKeys[keyIndex % testKeys.length]);
          keyIndex++;
        },
        HOT_PATH_THRESHOLDS.iterations,
        HOT_PATH_THRESHOLDS.warmupIterations
      );

      console.log('PriceMatrix getPriceOnly stats (μs):', stats);

      // getPriceOnly should be faster than getPrice
      expect(stats.p95).toBeLessThan(HOT_PATH_THRESHOLDS.priceMatrixReadMaxUs);
    });
  });

  describe('Full Detection Cycle Performance', () => {
    it('should complete 100-pair detection cycle within 50ms budget', () => {
      const pairCount = 100;
      const priceMatrix = new PriceMatrix({ maxPairs: 200 });
      const keys = generatePriceKeys(pairCount);
      const now = Date.now();

      // Pre-populate matrix
      keys.forEach((key, i) => {
        priceMatrix.setPrice(key, 1.0 + i * 0.001, now);
      });

      // Simulate full detection cycle
      const cycleStats = benchmark(
        () => {
          // Phase 1: Price updates (simulate 10 updates)
          for (let i = 0; i < 10; i++) {
            const keyIdx = Math.floor(Math.random() * pairCount);
            priceMatrix.setPrice(keys[keyIdx], 1.0 + Math.random() * 0.1, Date.now());
          }

          // Phase 2: Read prices for comparison
          const prices: number[] = [];
          for (let i = 0; i < pairCount; i++) {
            const entry = priceMatrix.getPriceOnly(keys[i]);
            if (entry !== null) {
              prices.push(entry);
            }
          }

          // Phase 3: Arbitrage detection (pairwise comparison)
          let opportunities = 0;
          for (let i = 0; i < prices.length; i++) {
            for (let j = i + 1; j < Math.min(i + 5, prices.length); j++) {
              // Compare only nearby pairs (realistic scenario)
              const spread = calculateSpread(prices[i], prices[j]);
              const netProfit = calculateNetProfit(spread, 0.003, 0.003);
              if (meetsThreshold(netProfit, 0.003)) {
                opportunities++;
              }
            }
          }
        },
        100, // Fewer iterations for full cycle
        10   // Fewer warmup
      );

      console.log('Full detection cycle stats (μs):', cycleStats);
      console.log('Full detection cycle P95 (ms):', cycleStats.p95 / 1000);

      // P95 should be under 50ms
      expect(cycleStats.p95 / 1000).toBeLessThan(HOT_PATH_THRESHOLDS.fullCycleMaxMs);

      priceMatrix.destroy();
    });
  });

  describe('Regression Guards', () => {
    it('should not regress price calculation beyond 2x baseline', () => {
      // Baseline: 50μs for price calculation
      const baseline = 50;
      const { reserve0, reserve1 } = SAMPLE_RESERVES[0];

      const stats = benchmark(
        () => calculatePriceFromReserves(reserve0, reserve1),
        1000,
        100
      );

      // Fail if we regress more than 2x from baseline
      expect(stats.p95).toBeLessThan(baseline * 2);
    });

    it('should not regress spread calculation beyond 2x baseline', () => {
      // Baseline: 5μs for spread calculation
      const baseline = 5;

      const stats = benchmark(
        () => calculateSpread(1.0234, 1.0456),
        1000,
        100
      );

      expect(stats.p95).toBeLessThan(baseline * 2);
    });
  });
});
