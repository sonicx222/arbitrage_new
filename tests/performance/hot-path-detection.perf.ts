/**
 * Hot Path Detection Performance Tests
 *
 * Tests the critical detection path to ensure it meets the <50ms requirement.
 * This includes:
 * - Price calculation from reserves
 * - Spread calculation
 * - Arbitrage opportunity detection
 * - Full detection cycle
 *
 * @see docs/TEST_ARCHITECTURE.md - Phase 4: Performance Testing
 */

import {
  PERFORMANCE_THRESHOLDS,
  measurePerformance,
  assertPerformance,
  formatPerformanceResult,
} from './thresholds';

// Import real functions from @arbitrage/core for accurate performance testing
import {
  calcPriceFromReserves,
  calculateSpread,
  calculateSpreadSafe,
  calculateNetProfit,
  calculateProfitBetweenSources,
} from '@arbitrage/core';

// Local type definition matching @arbitrage/core/components/price-calculator
interface PriceSource {
  price: number;
  fee: number;
  source: string;
}

// =============================================================================
// Test Data Factories
// =============================================================================

interface TestPairSnapshot {
  address: string;
  dex: string;
  token0: string;
  token1: string;
  reserve0: bigint;
  reserve1: bigint;
  fee: number;
  blockNumber: number;
}

/**
 * Create realistic test pair data
 */
function createTestPair(index: number, priceOffset = 0): TestPairSnapshot {
  // Simulate ETH/USDC pair with realistic reserves
  const baseReserve0 = BigInt('10000000000000000000000'); // 10,000 ETH (18 decimals)
  const baseReserve1 = BigInt('30000000000000'); // 30,000,000 USDC (6 decimals)

  // Apply price offset as percentage
  const adjustedReserve1 = baseReserve1 + BigInt(Math.floor(Number(baseReserve1) * priceOffset / 100));

  return {
    address: `0x${(1000 + index).toString(16).padStart(40, '0')}`,
    dex: index % 2 === 0 ? 'uniswap_v3' : 'sushiswap',
    token0: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    token1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
    reserve0: baseReserve0,
    reserve1: adjustedReserve1,
    fee: 0.003,
    blockNumber: 18000000 + index,
  };
}

/**
 * Create arbitrage opportunity test data
 */
function createArbitrageTestData() {
  return {
    pair1: createTestPair(1, 0),      // Base price
    pair2: createTestPair(2, 0.5),    // 0.5% higher price
    minProfitThreshold: 0.001,         // 0.1% minimum profit
  };
}

// =============================================================================
// Performance Tests
// =============================================================================

describe('Hot Path Performance - Detection (<50ms)', () => {
  describe('Price Calculation', () => {
    it(`should calculate price from reserves in <${PERFORMANCE_THRESHOLDS.PRICE_CALCULATION_MS}ms`, async () => {
      const pair = createTestPair(1);

      const result = await measurePerformance(() => {
        // Test the REAL price calculation function from @arbitrage/core
        const price = calcPriceFromReserves(pair.reserve0.toString(), pair.reserve1.toString());
        return price;
      });

      console.log('Price Calculation Performance:\n' + formatPerformanceResult(result));

      assertPerformance(result, PERFORMANCE_THRESHOLDS.PRICE_CALCULATION_MS, 'Price calculation');
    });

    it(`should calculate spread in <${PERFORMANCE_THRESHOLDS.SPREAD_CALCULATION_MS}ms`, async () => {
      const pair1 = createTestPair(1, 0);
      const pair2 = createTestPair(2, 0.5);

      const price1 = calcPriceFromReserves(pair1.reserve0.toString(), pair1.reserve1.toString());
      const price2 = calcPriceFromReserves(pair2.reserve0.toString(), pair2.reserve1.toString());

      // Skip test if prices are null (invalid reserves)
      if (price1 === null || price2 === null) {
        throw new Error('Invalid test data: prices are null');
      }

      const result = await measurePerformance(() => {
        // Test the REAL spread calculation function from @arbitrage/core
        const spread = calculateSpread(price1, price2);
        return spread;
      });

      console.log('Spread Calculation Performance:\n' + formatPerformanceResult(result));

      assertPerformance(result, PERFORMANCE_THRESHOLDS.SPREAD_CALCULATION_MS, 'Spread calculation');
    });
  });

  describe('Arbitrage Detection', () => {
    it(`should detect arbitrage opportunity in <${PERFORMANCE_THRESHOLDS.ARBITRAGE_DETECTION_MS}ms`, async () => {
      const testData = createArbitrageTestData();

      // Pre-calculate prices for test setup (not measured)
      const price1 = calcPriceFromReserves(
        testData.pair1.reserve0.toString(),
        testData.pair1.reserve1.toString()
      );
      const price2 = calcPriceFromReserves(
        testData.pair2.reserve0.toString(),
        testData.pair2.reserve1.toString()
      );

      // Skip test if prices are null
      if (price1 === null || price2 === null) {
        throw new Error('Invalid test data: prices are null');
      }

      // Create price sources for the real function
      const source1: PriceSource = {
        price: price1,
        fee: testData.pair1.fee,
        source: testData.pair1.dex,
      };
      const source2: PriceSource = {
        price: price2,
        fee: testData.pair2.fee,
        source: testData.pair2.dex,
      };

      const result = await measurePerformance(() => {
        // Test the REAL profit calculation function from @arbitrage/core
        const profitResult = calculateProfitBetweenSources(source1, source2);
        return {
          found: profitResult.netProfit > testData.minProfitThreshold,
          profitPercentage: profitResult.netProfit,
          buyDex: profitResult.buySource,
          sellDex: profitResult.sellSource,
        };
      });

      console.log('Arbitrage Detection Performance:\n' + formatPerformanceResult(result));

      assertPerformance(result, PERFORMANCE_THRESHOLDS.ARBITRAGE_DETECTION_MS, 'Arbitrage detection');
    });

    it(`should handle batch detection for 100 pairs in <${PERFORMANCE_THRESHOLDS.DETECTION_HOT_PATH_MS}ms`, async () => {
      // Create 100 pairs to simulate realistic workload
      const pairs = Array.from({ length: 100 }, (_, i) =>
        createTestPair(i, Math.random() * 2 - 1) // -1% to +1% price variance
      );

      // Pre-calculate prices (in real system this would be cached)
      const pairPrices = pairs.map(pair => {
        const price = calcPriceFromReserves(pair.reserve0.toString(), pair.reserve1.toString());
        return {
          address: pair.address,
          dex: pair.dex,
          token0: pair.token0,
          token1: pair.token1,
          price: price ?? 0, // Default to 0 if null
          fee: pair.fee,
        };
      }).filter(p => p.price > 0); // Filter out invalid prices

      const result = await measurePerformance(() => {
        const opportunities: Array<{ pair1: string; pair2: string; spread: number }> = [];

        // Compare all pairs with each other using REAL spread calculation
        for (let i = 0; i < pairPrices.length; i++) {
          for (let j = i + 1; j < pairPrices.length; j++) {
            if (pairPrices[i].token0 !== pairPrices[j].token0) continue;
            if (pairPrices[i].token1 !== pairPrices[j].token1) continue;

            // Use REAL spread calculation from @arbitrage/core
            const spread = calculateSpreadSafe(pairPrices[i].price, pairPrices[j].price);

            if (spread > 0.006) { // > 0.6% after fees
              opportunities.push({
                pair1: pairPrices[i].address,
                pair2: pairPrices[j].address,
                spread,
              });
            }
          }
        }

        return opportunities;
      });

      console.log('Batch Detection Performance (100 pairs):\n' + formatPerformanceResult(result));

      assertPerformance(result, PERFORMANCE_THRESHOLDS.DETECTION_HOT_PATH_MS, 'Batch detection');
    });
  });

  describe('Full Detection Cycle', () => {
    it(`should complete full detection cycle in <${PERFORMANCE_THRESHOLDS.DETECTION_HOT_PATH_MS}ms`, async () => {
      const testData = createArbitrageTestData();

      // Pre-calculate existing price (simulates cached price from pair2)
      const existingPrice = calcPriceFromReserves(
        testData.pair2.reserve0.toString(),
        testData.pair2.reserve1.toString()
      );

      // Skip test if existing price is null
      if (existingPrice === null) {
        throw new Error('Invalid test data: existing price is null');
      }

      const result = await measurePerformance(() => {
        // Step 1: Parse price update (simulate incoming event)
        const priceUpdate = {
          pair: testData.pair1.address,
          reserve0: testData.pair1.reserve0,
          reserve1: testData.pair1.reserve1,
          timestamp: Date.now(),
        };

        // Step 2: Calculate price using REAL function
        const price = calcPriceFromReserves(
          priceUpdate.reserve0.toString(),
          priceUpdate.reserve1.toString()
        );

        // Handle null price
        if (price === null) {
          return null;
        }

        // Step 3: Calculate spread using REAL function
        const spread = calculateSpread(price, existingPrice);

        // Step 4: Calculate net profit using REAL function
        const netProfit = calculateNetProfit(spread, testData.pair1.fee, testData.pair2.fee);

        // Step 5: Generate opportunity (if profitable)
        if (netProfit > testData.minProfitThreshold) {
          return {
            type: 'arbitrage',
            buyDex: price < existingPrice ? testData.pair1.dex : testData.pair2.dex,
            sellDex: price < existingPrice ? testData.pair2.dex : testData.pair1.dex,
            estimatedProfit: netProfit,
            confidence: 0.95,
          };
        }

        return null;
      });

      console.log('Full Detection Cycle Performance:\n' + formatPerformanceResult(result));

      assertPerformance(result, PERFORMANCE_THRESHOLDS.DETECTION_HOT_PATH_MS, 'Full detection cycle');
    });
  });

  describe('Concurrent Load', () => {
    it('should maintain <50ms under concurrent detection requests', async () => {
      const testData = createArbitrageTestData();
      const concurrencyLevel = 10;

      // Pre-calculate prices (simulates cached state)
      const price1 = calcPriceFromReserves(
        testData.pair1.reserve0.toString(),
        testData.pair1.reserve1.toString()
      );
      const price2 = calcPriceFromReserves(
        testData.pair2.reserve0.toString(),
        testData.pair2.reserve1.toString()
      );

      // Skip test if prices are null
      if (price1 === null || price2 === null) {
        throw new Error('Invalid test data: prices are null');
      }

      // Detection function using REAL spread calculation
      const detectArbitrageReal = () => {
        const spread = calculateSpread(price1, price2);
        const netProfit = calculateNetProfit(spread, testData.pair1.fee, testData.pair2.fee);
        return netProfit > 0;
      };

      // Run concurrent detection
      const startTime = performance.now();

      const results = await Promise.all(
        Array.from({ length: concurrencyLevel }, () =>
          measurePerformance(detectArbitrageReal, 10, 2)
        )
      );

      const totalTime = performance.now() - startTime;

      // Check each concurrent result
      results.forEach((result, i) => {
        console.log(`Concurrent worker ${i + 1}:\n` + formatPerformanceResult(result));
        expect(result.averageMs).toBeLessThan(PERFORMANCE_THRESHOLDS.DETECTION_HOT_PATH_MS);
      });

      // Overall throughput check
      const totalIterations = results.reduce((sum, r) => sum + r.iterations, 0);
      const throughput = totalIterations / (totalTime / 1000);

      console.log(`\nConcurrent throughput: ${throughput.toFixed(0)} detections/second`);
      expect(throughput).toBeGreaterThan(PERFORMANCE_THRESHOLDS.MIN_OPPORTUNITIES_PER_SECOND);
    });
  });

  describe('Memory Efficiency', () => {
    it('should not cause memory leaks during continuous detection', async () => {
      const testData = createArbitrageTestData();
      const iterations = 1000;

      // Force GC if available (Node.js with --expose-gc)
      if (global.gc) {
        global.gc();
      }

      const memBefore = process.memoryUsage().heapUsed;

      for (let i = 0; i < iterations; i++) {
        // Use REAL functions from @arbitrage/core
        const price1 = calcPriceFromReserves(
          testData.pair1.reserve0.toString(),
          testData.pair1.reserve1.toString()
        );
        const price2 = calcPriceFromReserves(
          testData.pair2.reserve0.toString(),
          testData.pair2.reserve1.toString()
        );

        // Skip iteration if prices are null
        if (price1 === null || price2 === null) {
          continue;
        }

        const spread = calculateSpread(price1, price2);
        const netProfit = calculateNetProfit(spread, testData.pair1.fee, testData.pair2.fee);

        // Create result object (should be garbage collected)
        const _result = {
          found: netProfit > 0,
          spread,
          netProfit,
          timestamp: Date.now(),
        };
      }

      if (global.gc) {
        global.gc();
      }

      const memAfter = process.memoryUsage().heapUsed;
      const memDiff = memAfter - memBefore;
      const memDiffMB = memDiff / 1024 / 1024;

      console.log(`Memory usage change: ${memDiffMB.toFixed(2)}MB after ${iterations} iterations`);

      // Allow up to 10MB memory growth (should be much less)
      expect(memDiffMB).toBeLessThan(10);
    });
  });
});
