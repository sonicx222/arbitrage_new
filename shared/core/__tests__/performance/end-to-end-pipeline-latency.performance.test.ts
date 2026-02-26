/**
 * End-to-End Pipeline Latency Performance Test
 *
 * Measures the FULL detection pipeline latency against the <50ms P95 target.
 * Unlike pipeline-latency.performance.test.ts (which only measures JSON serialization),
 * this test exercises real core modules with real computation.
 *
 * Pipeline stages measured:
 *   WebSocket receive -> Price update parse -> Cache write (L1 PriceMatrix)
 *   -> Opportunity detection (spread + profit calculation) -> Opportunity serialization
 *
 * Benchmarks:
 * 1. PriceMatrix operations (P95 < 5ms)
 * 2. Full detection cycle (P95 < 50ms)
 * 3. Batch detection throughput (>1000 updates/sec)
 *
 * @see ADR-005: L1 Cache
 * @see ADR-022: Hot-path latency target <50ms
 * @see shared/core/__tests__/performance/hot-path.performance.test.ts - component-level benchmarks
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';

import { PriceMatrix, resetPriceMatrix } from '@arbitrage/core/caching/price-matrix';
import {
  calculateSpread,
  calculateNetProfit,
  meetsThreshold
} from '@arbitrage/core/components/price-calculator';
import type { PriceUpdate } from '@arbitrage/types';

// =============================================================================
// Configuration
// =============================================================================

const WARMUP_ITERATIONS = 100;
const MEASUREMENT_ITERATIONS = 1000;

const THRESHOLDS = {
  /** PriceMatrix operations P95 (ms) */
  priceMatrixP95Ms: 5,
  /** Full detection cycle P95 (ms) */
  fullCycleP95Ms: 50,
  /** Batch throughput floor (updates/sec) */
  minThroughputPerSec: 1000,
};

// =============================================================================
// Helpers
// =============================================================================

/**
 * Calculate percentile from a sorted array of numbers.
 */
function percentile(sorted: number[], p: number): number {
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

/**
 * Collect statistics from a sorted array of latency measurements (ms).
 */
function computeStats(latencies: number[]): {
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
} {
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: sorted.reduce((sum, v) => sum + v, 0) / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

/**
 * Generate realistic pair keys for a given chain and DEX.
 */
function generatePairKeys(count: number): string[] {
  const chains = ['bsc', 'ethereum', 'arbitrum', 'polygon', 'base'];
  const dexes = ['pancakeswap-v2', 'uniswap-v3', 'sushiswap', 'quickswap', 'aerodrome'];
  const keys: string[] = [];
  for (let i = 0; i < count; i++) {
    const chain = chains[i % chains.length];
    const dex = dexes[i % dexes.length];
    // Use hex-like token addresses to mimic production pair keys
    const token0 = `0x${(i * 2).toString(16).padStart(40, 'a')}`;
    const token1 = `0x${(i * 2 + 1).toString(16).padStart(40, 'b')}`;
    keys.push(`${chain}:${dex}:${token0}:${token1}`);
  }
  return keys;
}

/**
 * Build a realistic PriceUpdate payload (simulates WebSocket parse output).
 */
function buildPriceUpdate(pairKey: string, price: number): PriceUpdate {
  return {
    chain: 'bsc',
    dex: 'pancakeswap-v2',
    pairKey,
    pairAddress: '0x0000000000000000000000000000000000000001',
    token0: '0xToken0Address000000000000000000000000000',
    token1: '0xToken1Address000000000000000000000000000',
    price,
    reserve0: '1000000000000000000000',
    reserve1: '1002300000000000000000',
    timestamp: Date.now(),
    blockNumber: 12345678,
    latency: 0,
    feeDecimal: 0.003,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('End-to-End Pipeline Latency Benchmark', () => {
  let priceMatrix: PriceMatrix;
  const PAIR_COUNT = 200;
  const pairKeys = generatePairKeys(PAIR_COUNT);

  beforeAll(() => {
    resetPriceMatrix();
    priceMatrix = new PriceMatrix({
      maxPairs: PAIR_COUNT + 100,
      reserveSlots: 50,
      enableAtomics: false, // No worker threads in test
    });

    // Pre-populate the PriceMatrix with baseline prices
    const now = Date.now();
    for (let i = 0; i < PAIR_COUNT; i++) {
      priceMatrix.setPrice(pairKeys[i], 1.0 + i * 0.0001, now);
    }
  });

  afterAll(() => {
    priceMatrix.destroy();
    resetPriceMatrix();
  });

  // ---------------------------------------------------------------------------
  // Benchmark 1: PriceMatrix operations (P95 < 5ms)
  // ---------------------------------------------------------------------------
  describe('PriceMatrix Operations', () => {
    it('should complete setPairPrice within P95 < 5ms', () => {
      // Warmup
      for (let w = 0; w < WARMUP_ITERATIONS; w++) {
        priceMatrix.setPrice(pairKeys[w % PAIR_COUNT], 1.5 + Math.random() * 0.01, Date.now());
      }

      const latencies: number[] = [];
      for (let i = 0; i < MEASUREMENT_ITERATIONS; i++) {
        const key = pairKeys[i % PAIR_COUNT];
        const price = 1.0 + Math.random() * 0.1;
        const ts = Date.now();

        const start = performance.now();
        priceMatrix.setPrice(key, price, ts);
        const elapsed = performance.now() - start;

        latencies.push(elapsed);
      }

      const stats = computeStats(latencies);

      console.log('PriceMatrix setPrice Latency (ms):');
      console.log(`  Iterations: ${MEASUREMENT_ITERATIONS}`);
      console.log(`  Min:  ${stats.min.toFixed(4)}`);
      console.log(`  Avg:  ${stats.avg.toFixed(4)}`);
      console.log(`  P50:  ${stats.p50.toFixed(4)}`);
      console.log(`  P95:  ${stats.p95.toFixed(4)}`);
      console.log(`  P99:  ${stats.p99.toFixed(4)}`);
      console.log(`  Max:  ${stats.max.toFixed(4)}`);

      expect(stats.p95).toBeLessThan(THRESHOLDS.priceMatrixP95Ms);
    });

    it('should complete getPairPrice within P95 < 5ms', () => {
      // Warmup
      for (let w = 0; w < WARMUP_ITERATIONS; w++) {
        priceMatrix.getPrice(pairKeys[w % PAIR_COUNT]);
      }

      const latencies: number[] = [];
      for (let i = 0; i < MEASUREMENT_ITERATIONS; i++) {
        const key = pairKeys[i % PAIR_COUNT];

        const start = performance.now();
        priceMatrix.getPrice(key);
        const elapsed = performance.now() - start;

        latencies.push(elapsed);
      }

      const stats = computeStats(latencies);

      console.log('PriceMatrix getPrice Latency (ms):');
      console.log(`  Iterations: ${MEASUREMENT_ITERATIONS}`);
      console.log(`  Min:  ${stats.min.toFixed(4)}`);
      console.log(`  Avg:  ${stats.avg.toFixed(4)}`);
      console.log(`  P50:  ${stats.p50.toFixed(4)}`);
      console.log(`  P95:  ${stats.p95.toFixed(4)}`);
      console.log(`  P99:  ${stats.p99.toFixed(4)}`);
      console.log(`  Max:  ${stats.max.toFixed(4)}`);

      expect(stats.p95).toBeLessThan(THRESHOLDS.priceMatrixP95Ms);
    });

    it('should complete pair price comparison within P95 < 5ms', () => {
      // Warmup
      for (let w = 0; w < WARMUP_ITERATIONS; w++) {
        const p1 = priceMatrix.getPriceOnly(pairKeys[w % PAIR_COUNT]);
        const p2 = priceMatrix.getPriceOnly(pairKeys[(w + 1) % PAIR_COUNT]);
        if (p1 !== null && p2 !== null && p1 > 0 && p2 > 0) {
          calculateSpread(p1, p2);
        }
      }

      const latencies: number[] = [];
      for (let i = 0; i < MEASUREMENT_ITERATIONS; i++) {
        const idx1 = i % PAIR_COUNT;
        const idx2 = (i + 1) % PAIR_COUNT;

        const start = performance.now();
        const p1 = priceMatrix.getPriceOnly(pairKeys[idx1]);
        const p2 = priceMatrix.getPriceOnly(pairKeys[idx2]);
        if (p1 !== null && p2 !== null && p1 > 0 && p2 > 0) {
          const spread = calculateSpread(p1, p2);
          calculateNetProfit(spread, 0.003, 0.003);
        }
        const elapsed = performance.now() - start;

        latencies.push(elapsed);
      }

      const stats = computeStats(latencies);

      console.log('Pair Comparison Latency (ms):');
      console.log(`  Iterations: ${MEASUREMENT_ITERATIONS}`);
      console.log(`  Min:  ${stats.min.toFixed(4)}`);
      console.log(`  Avg:  ${stats.avg.toFixed(4)}`);
      console.log(`  P50:  ${stats.p50.toFixed(4)}`);
      console.log(`  P95:  ${stats.p95.toFixed(4)}`);
      console.log(`  P99:  ${stats.p99.toFixed(4)}`);
      console.log(`  Max:  ${stats.max.toFixed(4)}`);

      expect(stats.p95).toBeLessThan(THRESHOLDS.priceMatrixP95Ms);
    });
  });

  // ---------------------------------------------------------------------------
  // Benchmark 2: Full detection cycle (P95 < 50ms)
  // ---------------------------------------------------------------------------
  describe('Full Detection Cycle', () => {
    it('should complete end-to-end pipeline within P95 < 50ms', () => {
      // Build a pool of raw WebSocket payloads to parse during the benchmark
      const rawPayloads: string[] = [];
      for (let i = 0; i < 50; i++) {
        const update = buildPriceUpdate(
          pairKeys[i % PAIR_COUNT],
          1.0 + Math.random() * 0.05
        );
        rawPayloads.push(JSON.stringify(update));
      }

      // Number of pairs to compare per cycle (realistic: nearby pairs for same token)
      const COMPARE_WINDOW = 10;
      const FEE = 0.003; // 0.3% per swap
      const PROFIT_THRESHOLD = 0.002; // 0.2% minimum

      // Warmup
      for (let w = 0; w < WARMUP_ITERATIONS; w++) {
        const raw = rawPayloads[w % rawPayloads.length];
        const parsed = JSON.parse(raw) as PriceUpdate;
        priceMatrix.setPrice(parsed.pairKey, parsed.price, parsed.timestamp);
        for (let j = 0; j < COMPARE_WINDOW; j++) {
          const p1 = priceMatrix.getPriceOnly(pairKeys[j]);
          const p2 = priceMatrix.getPriceOnly(pairKeys[j + 1]);
          if (p1 !== null && p2 !== null && p1 > 0 && p2 > 0) {
            const spread = calculateSpread(p1, p2);
            const net = calculateNetProfit(spread, FEE, FEE);
            meetsThreshold(net, PROFIT_THRESHOLD);
          }
        }
      }

      const latencies: number[] = [];

      for (let i = 0; i < MEASUREMENT_ITERATIONS; i++) {
        const start = performance.now();

        // Stage 1: Parse incoming price update (simulates WebSocket receive + JSON.parse)
        const raw = rawPayloads[i % rawPayloads.length];
        const parsed = JSON.parse(raw) as PriceUpdate;

        // Stage 2: Write to PriceMatrix (L1 cache write)
        priceMatrix.setPrice(parsed.pairKey, parsed.price, parsed.timestamp);

        // Stage 3: Read multiple pair prices for detection
        const prices: Array<{ key: string; price: number }> = [];
        const baseIdx = i % (PAIR_COUNT - COMPARE_WINDOW);
        for (let j = 0; j < COMPARE_WINDOW; j++) {
          const key = pairKeys[baseIdx + j];
          const price = priceMatrix.getPriceOnly(key);
          if (price !== null) {
            prices.push({ key, price });
          }
        }

        // Stage 4: Opportunity detection (compare pairs, calculate spread)
        let bestOpportunity: {
          buyKey: string;
          sellKey: string;
          spread: number;
          netProfit: number;
        } | null = null;

        for (let a = 0; a < prices.length; a++) {
          for (let b = a + 1; b < prices.length; b++) {
            const spread = calculateSpread(prices[a].price, prices[b].price);
            const net = calculateNetProfit(spread, FEE, FEE);
            if (meetsThreshold(net, PROFIT_THRESHOLD)) {
              if (bestOpportunity === null || net > bestOpportunity.netProfit) {
                bestOpportunity = {
                  buyKey: prices[a].price < prices[b].price ? prices[a].key : prices[b].key,
                  sellKey: prices[a].price >= prices[b].price ? prices[a].key : prices[b].key,
                  spread,
                  netProfit: net,
                };
              }
            }
          }
        }

        // Stage 5: Serialize opportunity result (simulates emitting to Redis/execution)
        if (bestOpportunity !== null) {
          JSON.stringify({
            id: `opp-${i}`,
            type: 'simple',
            ...bestOpportunity,
            timestamp: Date.now(),
          });
        } else {
          // Even when no opportunity, serialize a "no-op" result
          JSON.stringify({ id: `noop-${i}`, type: 'none', timestamp: Date.now() });
        }

        const elapsed = performance.now() - start;
        latencies.push(elapsed);
      }

      const stats = computeStats(latencies);

      console.log('Full Detection Cycle Latency (ms):');
      console.log(`  Iterations: ${MEASUREMENT_ITERATIONS}`);
      console.log(`  Min:  ${stats.min.toFixed(4)}`);
      console.log(`  Avg:  ${stats.avg.toFixed(4)}`);
      console.log(`  P50:  ${stats.p50.toFixed(4)}`);
      console.log(`  P95:  ${stats.p95.toFixed(4)}`);
      console.log(`  P99:  ${stats.p99.toFixed(4)}`);
      console.log(`  Max:  ${stats.max.toFixed(4)}`);

      // Assert the <50ms P95 target
      expect(stats.p95).toBeLessThan(THRESHOLDS.fullCycleP95Ms);
    });
  });

  // ---------------------------------------------------------------------------
  // Benchmark 3: Batch detection throughput (>1000 updates/sec)
  // ---------------------------------------------------------------------------
  describe('Batch Detection Throughput', () => {
    it('should process >1000 price updates per second', () => {
      const BATCH_SIZE = 2000;
      const FEE = 0.003;
      const PROFIT_THRESHOLD = 0.002;

      // Prepare batch of raw payloads
      const rawPayloads: string[] = [];
      for (let i = 0; i < BATCH_SIZE; i++) {
        const update = buildPriceUpdate(
          pairKeys[i % PAIR_COUNT],
          1.0 + Math.random() * 0.05
        );
        rawPayloads.push(JSON.stringify(update));
      }

      // Warmup: process 200 updates
      for (let w = 0; w < 200; w++) {
        const parsed = JSON.parse(rawPayloads[w]) as PriceUpdate;
        priceMatrix.setPrice(parsed.pairKey, parsed.price, parsed.timestamp);
        const p1 = priceMatrix.getPriceOnly(pairKeys[w % PAIR_COUNT]);
        const p2 = priceMatrix.getPriceOnly(pairKeys[(w + 1) % PAIR_COUNT]);
        if (p1 !== null && p2 !== null && p1 > 0 && p2 > 0) {
          const spread = calculateSpread(p1, p2);
          calculateNetProfit(spread, FEE, FEE);
        }
      }

      // Measure: process all updates and count how long it takes
      let opportunitiesFound = 0;
      const start = performance.now();

      for (let i = 0; i < BATCH_SIZE; i++) {
        // Parse
        const parsed = JSON.parse(rawPayloads[i]) as PriceUpdate;

        // Write
        priceMatrix.setPrice(parsed.pairKey, parsed.price, parsed.timestamp);

        // Detect: compare with a few neighbors
        const baseIdx = i % (PAIR_COUNT - 3);
        for (let j = 0; j < 3; j++) {
          const p1 = priceMatrix.getPriceOnly(pairKeys[baseIdx + j]);
          const p2 = priceMatrix.getPriceOnly(pairKeys[baseIdx + j + 1]);
          if (p1 !== null && p2 !== null && p1 > 0 && p2 > 0) {
            const spread = calculateSpread(p1, p2);
            const net = calculateNetProfit(spread, FEE, FEE);
            if (meetsThreshold(net, PROFIT_THRESHOLD)) {
              opportunitiesFound++;
              // Serialize opportunity
              JSON.stringify({
                id: `batch-opp-${i}-${j}`,
                spread,
                netProfit: net,
                timestamp: Date.now(),
              });
            }
          }
        }
      }

      const totalMs = performance.now() - start;
      const throughput = (BATCH_SIZE / totalMs) * 1000; // updates per second

      console.log('Batch Detection Throughput:');
      console.log(`  Updates processed: ${BATCH_SIZE}`);
      console.log(`  Total time: ${totalMs.toFixed(2)}ms`);
      console.log(`  Throughput: ${throughput.toFixed(0)} updates/sec`);
      console.log(`  Opportunities found: ${opportunitiesFound}`);
      console.log(`  Avg per update: ${(totalMs / BATCH_SIZE).toFixed(4)}ms`);

      // Assert >1000 updates/sec
      expect(throughput).toBeGreaterThan(THRESHOLDS.minThroughputPerSec);
    });
  });
});
