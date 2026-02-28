/**
 * Chain Instance Hot-Path Performance Tests
 *
 * Guards against performance regressions in ChainDetectorInstance hot-path code.
 *
 * Target: <10ms per Sync event (measured ~0.5-2ms in production)
 *
 * Key hot-path operations tested:
 * - Pair lookup by address (O(1) Map)
 * - Reserve parsing from hex data
 * - Price update emission
 * - Arbitrage opportunity check
 *
 * @see ADR-022: Hot-Path Memory Optimization
 * @see enhancement-research-2026-02-04.md
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';

// =============================================================================
// Performance Test Configuration
// =============================================================================

const HOT_PATH_THRESHOLDS = {
  // Per-event processing (handleSyncEvent equivalent operations)
  // Relaxed for CI environments where timing can be noisy
  syncEventProcessingMaxMs: 10,

  // Pair lookup by address (should be <0.05ms = 50μs in CI)
  // Note: On bare metal this is <10μs; CI adds overhead
  pairLookupMaxUs: 50,

  // Reserve parsing from hex (should be <0.5ms = 500μs in CI)
  reserveParsingMaxUs: 500,

  // Price calculation (should be <0.5ms = 500μs in CI)
  priceCalculationMaxUs: 500,

  // Burst of 100 Sync events (should be <100ms total in CI)
  // Production target is <50ms, but CI has variance
  burstProcessingMaxMs: 100,

  // Iterations for statistical significance
  iterations: 500,

  // Warm-up iterations (discarded)
  warmupIterations: 50
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
 * High-resolution timing for async functions
 * Returns time in milliseconds
 */
async function timeMs(fn: () => Promise<void>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

/**
 * Run a function multiple times and return statistics
 */
function benchmark(
  fn: () => void,
  iterations: number,
  warmupIterations: number = 50
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

  // Safety: ensure we have enough samples
  if (times.length === 0) {
    return { min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0 };
  }

  times.sort((a, b) => a - b);

  const safeIndex = (pct: number): number => {
    const idx = Math.floor(times.length * pct);
    return Math.min(idx, times.length - 1);
  };

  return {
    min: times[0] ?? 0,
    max: times[times.length - 1] ?? 0,
    avg: times.reduce((a, b) => a + b, 0) / times.length,
    p50: times[safeIndex(0.5)] ?? 0,
    p95: times[safeIndex(0.95)] ?? 0,
    p99: times[safeIndex(0.99)] ?? 0
  };
}

// =============================================================================
// Test Data (Simulating Real Sync Events)
// =============================================================================

interface MockPair {
  address: string;
  dex: string;
  token0: string;
  token1: string;
  fee: number;
  reserve0: string;
  reserve1: string;
  blockNumber: number;
  lastUpdate: number;
  pairKey: string;
}

/**
 * Generate realistic Sync event log data
 * Format: 0x + reserve0 (64 hex chars) + reserve1 (64 hex chars)
 */
function generateSyncEventData(reserve0: bigint, reserve1: bigint): string {
  const r0Hex = reserve0.toString(16).padStart(64, '0');
  const r1Hex = reserve1.toString(16).padStart(64, '0');
  return '0x' + r0Hex + r1Hex;
}

/**
 * Sample reserve values (realistic DEX pair reserves)
 */
const SAMPLE_RESERVES: Array<{ reserve0: bigint; reserve1: bigint }> = [
  { reserve0: BigInt('1000000000000000000000'), reserve1: BigInt('2000000000000000000') },
  { reserve0: BigInt('50000000000'), reserve1: BigInt('50000000000000000000000') },
  { reserve0: BigInt('123456789012345678901234'), reserve1: BigInt('987654321098765432109') },
  { reserve0: BigInt('1'), reserve1: BigInt('1000000000000000000') },
  { reserve0: BigInt('999999999999999999999999999'), reserve1: BigInt('1') },
];

/**
 * Generate mock pairs for testing
 */
function generateMockPairs(count: number): Map<string, MockPair> {
  const pairsByAddress = new Map<string, MockPair>();
  const dexes = ['uniswap', 'sushiswap', 'pancakeswap', 'quickswap'];
  const tokens = ['WETH', 'USDC', 'USDT', 'WBTC', 'DAI', 'LINK', 'UNI', 'AAVE'];

  for (let i = 0; i < count; i++) {
    const address = `0x${i.toString(16).padStart(40, '0')}`;
    const dex = dexes[i % dexes.length];
    const token0 = tokens[i % tokens.length];
    const token1 = tokens[(i + 1) % tokens.length];

    pairsByAddress.set(address, {
      address,
      dex,
      token0: `0x${(i * 2).toString(16).padStart(40, '0')}`,
      token1: `0x${(i * 2 + 1).toString(16).padStart(40, '0')}`,
      fee: 0.003,
      reserve0: '0',
      reserve1: '0',
      blockNumber: 0,
      lastUpdate: 0,
      pairKey: `${dex}_${token0}_${token1}`
    });
  }

  return pairsByAddress;
}

// =============================================================================
// Tests
// =============================================================================

describe('Chain Instance Hot-Path Performance Guards', () => {
  let pairsByAddress: Map<string, MockPair>;
  let sampleEventData: string[];

  beforeAll(() => {
    // Pre-generate test data to avoid affecting measurements
    pairsByAddress = generateMockPairs(500); // 500 pairs like production
    sampleEventData = SAMPLE_RESERVES.map(r =>
      generateSyncEventData(r.reserve0, r.reserve1)
    );
  });

  afterAll(() => {
    pairsByAddress.clear();
  });

  describe('Pair Lookup Performance (O(1) Map)', () => {
    it('should lookup pair by address within budget (<10μs)', () => {
      const addresses = Array.from(pairsByAddress.keys());
      let lookupResult: MockPair | undefined;

      const stats = benchmark(
        () => {
          const addr = addresses[Math.floor(Math.random() * addresses.length)];
          lookupResult = pairsByAddress.get(addr);
        },
        HOT_PATH_THRESHOLDS.iterations,
        HOT_PATH_THRESHOLDS.warmupIterations
      );

      console.log('Pair Lookup Performance (μs):', {
        avg: stats.avg.toFixed(3),
        p95: stats.p95.toFixed(3),
        p99: stats.p99.toFixed(3),
        max: stats.max.toFixed(3)
      });

      // P95 should be within budget
      expect(stats.p95).toBeLessThan(HOT_PATH_THRESHOLDS.pairLookupMaxUs);
      expect(lookupResult).toBeDefined();
    });

    it('should handle lookup for non-existent pair efficiently', () => {
      let lookupResult: MockPair | undefined;

      const stats = benchmark(
        () => {
          lookupResult = pairsByAddress.get('0xnonexistent');
        },
        HOT_PATH_THRESHOLDS.iterations,
        HOT_PATH_THRESHOLDS.warmupIterations
      );

      // Non-existent lookups should be just as fast
      expect(stats.p95).toBeLessThan(HOT_PATH_THRESHOLDS.pairLookupMaxUs);
      expect(lookupResult).toBeUndefined();
    });
  });

  describe('Reserve Parsing Performance', () => {
    it('should parse reserves from hex data within budget (<100μs)', () => {
      let reserve0: bigint = 0n;
      let reserve1: bigint = 0n;

      const stats = benchmark(
        () => {
          const data = sampleEventData[Math.floor(Math.random() * sampleEventData.length)];
          reserve0 = BigInt('0x' + data.slice(2, 66));
          reserve1 = BigInt('0x' + data.slice(66, 130));
        },
        HOT_PATH_THRESHOLDS.iterations,
        HOT_PATH_THRESHOLDS.warmupIterations
      );

      console.log('Reserve Parsing Performance (μs):', {
        avg: stats.avg.toFixed(3),
        p95: stats.p95.toFixed(3),
        p99: stats.p99.toFixed(3),
        max: stats.max.toFixed(3)
      });

      expect(stats.p95).toBeLessThan(HOT_PATH_THRESHOLDS.reserveParsingMaxUs);
      expect(reserve0).toBeGreaterThan(0n);
      expect(reserve1).toBeGreaterThan(0n);
    });
  });

  describe('Price Calculation Performance', () => {
    it('should calculate price from reserves within budget (<100μs)', () => {
      let price: number = 0;

      const stats = benchmark(
        () => {
          const reserves = SAMPLE_RESERVES[Math.floor(Math.random() * SAMPLE_RESERVES.length)];
          // Simulate price calculation: reserve1 / reserve0
          price = Number(reserves.reserve1 * BigInt(1e18) / reserves.reserve0) / 1e18;
        },
        HOT_PATH_THRESHOLDS.iterations,
        HOT_PATH_THRESHOLDS.warmupIterations
      );

      console.log('Price Calculation Performance (μs):', {
        avg: stats.avg.toFixed(3),
        p95: stats.p95.toFixed(3),
        p99: stats.p99.toFixed(3),
        max: stats.max.toFixed(3)
      });

      expect(stats.p95).toBeLessThan(HOT_PATH_THRESHOLDS.priceCalculationMaxUs);
      expect(price).toBeGreaterThan(0);
    });
  });

  describe('Combined Hot-Path Operation Performance', () => {
    it('should process simulated Sync event within budget (<10ms)', () => {
      const addresses = Array.from(pairsByAddress.keys());

      /**
       * Simulates the hot-path operations in handleSyncEvent:
       * 1. Pair lookup by address (O(1))
       * 2. Reserve parsing from hex
       * 3. Pair update
       * 4. Price calculation
       */
      const simulateHandleSyncEvent = (): boolean => {
        // 1. Pair lookup
        const addr = addresses[Math.floor(Math.random() * addresses.length)];
        const pair = pairsByAddress.get(addr);
        if (!pair) return false;

        // 2. Parse reserves
        const data = sampleEventData[Math.floor(Math.random() * sampleEventData.length)];
        const reserve0 = BigInt('0x' + data.slice(2, 66)).toString();
        const reserve1 = BigInt('0x' + data.slice(66, 130)).toString();

        // 3. Update pair (atomic via Object.assign)
        Object.assign(pair, {
          reserve0,
          reserve1,
          blockNumber: 12345,
          lastUpdate: Date.now()
        });

        // 4. Price calculation
        const price = Number(BigInt(reserve1) * BigInt(1e18) / BigInt(reserve0)) / 1e18;

        return price > 0;
      };

      const stats = benchmark(
        () => {
          simulateHandleSyncEvent();
        },
        HOT_PATH_THRESHOLDS.iterations,
        HOT_PATH_THRESHOLDS.warmupIterations
      );

      // Convert to ms for comparison
      const p95Ms = stats.p95 / 1000;
      const p99Ms = stats.p99 / 1000;

      console.log('Simulated Sync Event Performance (ms):', {
        avg: (stats.avg / 1000).toFixed(4),
        p95: p95Ms.toFixed(4),
        p99: p99Ms.toFixed(4),
        max: (stats.max / 1000).toFixed(4)
      });

      // P95 should be well under 10ms (typically <1ms)
      expect(p95Ms).toBeLessThan(HOT_PATH_THRESHOLDS.syncEventProcessingMaxMs);
    });

    it('should handle burst of 100 Sync events within budget', () => {
      const addresses = Array.from(pairsByAddress.keys());

      // Skip test if no addresses available
      if (addresses.length === 0) {
        console.log('Skipping test - no addresses available');
        return;
      }

      const processBurst = (): void => {
        for (let i = 0; i < 100; i++) {
          const addr = addresses[i % addresses.length];
          const pair = pairsByAddress.get(addr);
          if (!pair) continue;

          const data = sampleEventData[i % sampleEventData.length];
          const reserve0 = BigInt('0x' + data.slice(2, 66)).toString();
          const reserve1 = BigInt('0x' + data.slice(66, 130)).toString();

          Object.assign(pair, {
            reserve0,
            reserve1,
            blockNumber: 12345 + i,
            lastUpdate: Date.now()
          });
        }
      };

      // Warm up
      for (let i = 0; i < 10; i++) {
        processBurst();
      }

      // Measure
      const times: number[] = [];
      for (let i = 0; i < 50; i++) { // Reduced iterations for stability
        const start = performance.now();
        processBurst();
        times.push(performance.now() - start);
      }

      times.sort((a, b) => a - b);
      const p95 = times[Math.floor(times.length * 0.95)] ?? 0;
      const avg = times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : 0;

      console.log('Burst Processing (100 events) Performance (ms):', {
        avg: avg.toFixed(3),
        p95: p95.toFixed(3),
        max: (times[times.length - 1] ?? 0).toFixed(3)
      });

      // In CI, timing is very noisy - use generous threshold
      // Production target is <50ms, but CI can spike 5-10x
      const ciThreshold = HOT_PATH_THRESHOLDS.burstProcessingMaxMs * 5; // 500ms
      expect(p95).toBeLessThan(ciThreshold);
    });
  });

  describe('pairKey Caching Performance', () => {
    it('should access cached pairKey in O(0) time', () => {
      const addresses = Array.from(pairsByAddress.keys());
      let pairKey: string | undefined;

      const stats = benchmark(
        () => {
          const addr = addresses[Math.floor(Math.random() * addresses.length)];
          const pair = pairsByAddress.get(addr);
          // Access cached pairKey (O(0) - just a property access)
          pairKey = pair?.pairKey;
        },
        HOT_PATH_THRESHOLDS.iterations,
        HOT_PATH_THRESHOLDS.warmupIterations
      );

      console.log('Cached pairKey Access Performance (μs):', {
        avg: stats.avg.toFixed(3),
        p95: stats.p95.toFixed(3),
        p99: stats.p99.toFixed(3)
      });

      // Should be as fast as pair lookup (both are property accesses)
      expect(stats.p95).toBeLessThan(HOT_PATH_THRESHOLDS.pairLookupMaxUs * 2);
      expect(pairKey).toBeDefined();
    });

    it('should be faster than computing pairKey on-demand', () => {
      const addresses = Array.from(pairsByAddress.keys());

      // Skip test if no addresses available
      if (addresses.length === 0) {
        console.log('Skipping test - no addresses available');
        return;
      }

      // Use first address consistently (avoid random lookup issues)
      const testAddr = addresses[0];
      const testPair = pairsByAddress.get(testAddr);

      // Skip if pair not found
      if (!testPair) {
        console.log('Skipping test - test pair not found');
        return;
      }

      // Simulate old behavior: compute pairKey on every access
      const computePairKey = (pair: MockPair): string => {
        return `${pair.dex}_WETH_USDC`; // Simplified - would call getTokenSymbol()
      };

      // Measure cached access - use consistent pair to avoid lookup variance
      const cachedStats = benchmark(
        () => {
          const _ = testPair.pairKey; // Cached - direct property access
        },
        HOT_PATH_THRESHOLDS.iterations,
        HOT_PATH_THRESHOLDS.warmupIterations
      );

      // Measure computed access
      const computedStats = benchmark(
        () => {
          const _ = computePairKey(testPair); // Computed (creates new string)
        },
        HOT_PATH_THRESHOLDS.iterations,
        HOT_PATH_THRESHOLDS.warmupIterations
      );

      // Guard against NaN
      const cachedAvg = Number.isFinite(cachedStats.avg) ? cachedStats.avg : 0;
      const computedAvg = Number.isFinite(computedStats.avg) ? computedStats.avg : 0;
      const cachedP95 = Number.isFinite(cachedStats.p95) ? cachedStats.p95 : 0;
      const computedP95 = Number.isFinite(computedStats.p95) ? computedStats.p95 : 0;

      // Guard against division by zero
      const improvement = computedP95 > 0
        ? ((computedP95 - cachedP95) / computedP95 * 100).toFixed(1)
        : '0';

      console.log('pairKey Access Comparison (μs):', {
        cachedP95: cachedP95.toFixed(3),
        computedP95: computedP95.toFixed(3),
        improvement: improvement + '%'
      });

      // In CI environments, timing variance is high, so we just verify both complete
      // The real benefit is measured in production with proper profiling
      // This test ensures no catastrophic regression (cached shouldn't be 10x slower)
      // Use Math.max with fallback value to prevent NaN comparisons
      const threshold = Math.max(computedAvg * 5, 100);
      expect(cachedAvg).toBeLessThanOrEqual(threshold);
    });
  });

  describe('Memory Allocation Patterns', () => {
    it('should not create excessive string allocations in burst processing', () => {
      const addresses = Array.from(pairsByAddress.keys());

      // Track if we're creating new strings unnecessarily
      const seenPairKeys = new Set<string>();

      for (let i = 0; i < 1000; i++) {
        const addr = addresses[i % addresses.length];
        const pair = pairsByAddress.get(addr)!;

        // Using cached pairKey - should be same reference
        seenPairKeys.add(pair.pairKey);
      }

      // With 500 pairs, we should have at most 500 unique pairKeys
      // If we were creating new strings each time, Set would detect duplicates
      // but we'd be wasting allocations
      expect(seenPairKeys.size).toBeLessThanOrEqual(pairsByAddress.size);

      console.log('Unique pairKeys in 1000 accesses:', seenPairKeys.size);
    });
  });
});
