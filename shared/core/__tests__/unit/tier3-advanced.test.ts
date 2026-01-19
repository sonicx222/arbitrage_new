/**
 * Tier 3 Advanced Optimization Tests
 *
 * Tests for T3.12 and T3.15 from DETECTOR_OPTIMIZATION_ANALYSIS.md:
 * - T3.12: Enhanced Whale Activity Detection
 * - T3.15: Liquidity Depth Analysis
 */

import {
  WhaleActivityTracker,
  TrackedWhaleTransaction,
  WalletPattern,
  WhaleSignal,
  getWhaleActivityTracker,
  resetWhaleActivityTracker
} from '../../src/analytics/whale-activity-tracker';
import {
  LiquidityDepthAnalyzer,
  PoolLiquidity,
  getLiquidityDepthAnalyzer,
  resetLiquidityDepthAnalyzer
} from '../../src/analytics/liquidity-depth-analyzer';

// ===========================================================================
// Test Data Factories
// ===========================================================================

function createWhaleTransaction(overrides: Partial<TrackedWhaleTransaction> = {}): TrackedWhaleTransaction {
  return {
    transactionHash: `0x${Math.random().toString(16).substring(2)}`,
    walletAddress: `0x${Math.random().toString(16).substring(2, 42)}`,
    chain: 'ethereum',
    dex: 'uniswap',
    pairAddress: '0xPAIR123',
    tokenIn: 'USDT',
    tokenOut: 'WETH',
    amountIn: 100000,
    amountOut: 40,
    usdValue: 100000,
    direction: 'buy',
    timestamp: Date.now(),
    priceImpact: 0.5,
    ...overrides
  };
}

function createPoolLiquidity(overrides: Partial<PoolLiquidity> = {}): PoolLiquidity {
  return {
    poolAddress: `0xPOOL${Math.random().toString(16).substring(2, 10)}`,
    chain: 'ethereum',
    dex: 'uniswap',
    token0: 'USDT',
    token1: 'WETH',
    reserve0: BigInt('10000000000000000000000000'), // 10M USDT (6 decimals scaled to 18)
    reserve1: BigInt('4000000000000000000000'),     // 4000 WETH
    feeBps: 30, // 0.3%
    liquidityUsd: 20000000, // $20M
    price: 2500, // 1 WETH = 2500 USDT
    timestamp: Date.now(),
    ...overrides
  };
}

// ===========================================================================
// T3.12: Whale Activity Detection Tests
// ===========================================================================

describe('T3.12: Whale Activity Detection', () => {
  let tracker: WhaleActivityTracker;

  beforeEach(() => {
    resetWhaleActivityTracker();
    tracker = new WhaleActivityTracker({
      whaleThresholdUsd: 50000,
      minTradesForPattern: 3,
      maxTrackedWallets: 100
    });
  });

  describe('Transaction Recording', () => {
    it('should record transactions above whale threshold', () => {
      const tx = createWhaleTransaction({ usdValue: 100000 });
      tracker.recordTransaction(tx);

      const stats = tracker.getStats();
      expect(stats.totalTransactionsTracked).toBe(1);
      expect(stats.totalWalletsTracked).toBe(1);
    });

    it('should ignore transactions below whale threshold', () => {
      const tx = createWhaleTransaction({ usdValue: 10000 }); // Below $50K threshold
      tracker.recordTransaction(tx);

      const stats = tracker.getStats();
      expect(stats.totalTransactionsTracked).toBe(0);
    });

    it('should track wallet profiles', () => {
      const walletAddress = '0xWHALE123';
      const tx = createWhaleTransaction({ walletAddress, usdValue: 100000 });
      tracker.recordTransaction(tx);

      const profile = tracker.getWalletProfile(walletAddress);
      expect(profile).toBeDefined();
      expect(profile!.totalTransactions).toBe(1);
      expect(profile!.totalVolumeUsd).toBe(100000);
    });

    it('should accumulate wallet statistics', () => {
      const walletAddress = '0xWHALE123';

      for (let i = 0; i < 5; i++) {
        tracker.recordTransaction(createWhaleTransaction({
          walletAddress,
          usdValue: 50000 + i * 10000
        }));
      }

      const profile = tracker.getWalletProfile(walletAddress);
      expect(profile!.totalTransactions).toBe(5);
      expect(profile!.totalVolumeUsd).toBeGreaterThan(250000);
    });
  });

  describe('Pattern Detection', () => {
    it('should detect accumulator pattern', () => {
      const walletAddress = '0xACCUM123';

      // Multiple buy transactions
      for (let i = 0; i < 5; i++) {
        tracker.recordTransaction(createWhaleTransaction({
          walletAddress,
          direction: 'buy',
          usdValue: 100000
        }));
      }

      const profile = tracker.getWalletProfile(walletAddress);
      expect(profile!.pattern).toBe('accumulator');
    });

    it('should detect distributor pattern', () => {
      const walletAddress = '0xDIST123';

      // Multiple sell transactions
      for (let i = 0; i < 5; i++) {
        tracker.recordTransaction(createWhaleTransaction({
          walletAddress,
          direction: 'sell',
          usdValue: 100000
        }));
      }

      const profile = tracker.getWalletProfile(walletAddress);
      expect(profile!.pattern).toBe('distributor');
    });

    it('should detect swing_trader pattern for mixed activity', () => {
      const walletAddress = '0xSWING123';

      // Mixed buy/sell transactions
      for (let i = 0; i < 6; i++) {
        tracker.recordTransaction(createWhaleTransaction({
          walletAddress,
          direction: i % 2 === 0 ? 'buy' : 'sell',
          usdValue: 100000,
          timestamp: Date.now() + i * 60000 // Spread over time
        }));
      }

      const profile = tracker.getWalletProfile(walletAddress);
      expect(profile!.pattern).toBe('swing_trader');
    });

    it('should return unknown pattern for insufficient data', () => {
      const walletAddress = '0xNEW123';

      // Only 2 transactions (below minTradesForPattern of 3)
      for (let i = 0; i < 2; i++) {
        tracker.recordTransaction(createWhaleTransaction({
          walletAddress,
          direction: 'buy',
          usdValue: 100000
        }));
      }

      const profile = tracker.getWalletProfile(walletAddress);
      expect(profile!.pattern).toBe('unknown');
    });

    it('should detect arbitrageur pattern for quick buy/sell cycles', () => {
      const walletAddress = '0xARB123';
      const now = Date.now();

      // Quick alternating buy/sell within 60 seconds (arbitrage pattern)
      for (let i = 0; i < 6; i++) {
        tracker.recordTransaction(createWhaleTransaction({
          walletAddress,
          direction: i % 2 === 0 ? 'buy' : 'sell',
          usdValue: 100000,
          timestamp: now + i * 10000 // 10 seconds apart (< 60s threshold)
        }));
      }

      const profile = tracker.getWalletProfile(walletAddress);
      expect(profile!.pattern).toBe('arbitrageur');
    });

    it('should handle out-of-order transaction timestamps correctly', () => {
      const walletAddress = '0xOOO123';
      const now = Date.now();

      // Record transactions out of order - pattern should still be detected correctly
      tracker.recordTransaction(createWhaleTransaction({
        walletAddress,
        direction: 'buy',
        usdValue: 100000,
        timestamp: now + 30000 // Third chronologically
      }));
      tracker.recordTransaction(createWhaleTransaction({
        walletAddress,
        direction: 'buy',
        usdValue: 100000,
        timestamp: now // First chronologically
      }));
      tracker.recordTransaction(createWhaleTransaction({
        walletAddress,
        direction: 'buy',
        usdValue: 100000,
        timestamp: now + 15000 // Second chronologically
      }));

      const profile = tracker.getWalletProfile(walletAddress);
      // Even though recorded out of order, pattern detection should work
      expect(profile!.pattern).toBe('accumulator');
      // lastSeen should be the latest timestamp, not the last recorded
      expect(profile!.lastSeen).toBe(now + 30000);
    });
  });

  describe('Signal Generation', () => {
    it('should generate signals for known patterns', () => {
      const walletAddress = '0xACCUM123';
      const signals: WhaleSignal[] = [];

      tracker.onSignal((signal) => signals.push(signal));

      // Build pattern first
      for (let i = 0; i < 4; i++) {
        tracker.recordTransaction(createWhaleTransaction({
          walletAddress,
          direction: 'buy',
          usdValue: 100000
        }));
      }

      // Check if signal was generated
      expect(signals.length).toBeGreaterThan(0);
      expect(signals[signals.length - 1].type).toBe('follow');
    });

    it('should include confidence score in signals', () => {
      const walletAddress = '0xACCUM123';
      const signals: WhaleSignal[] = [];

      tracker.onSignal((signal) => signals.push(signal));

      for (let i = 0; i < 5; i++) {
        tracker.recordTransaction(createWhaleTransaction({
          walletAddress,
          direction: 'buy',
          usdValue: 100000
        }));
      }

      const lastSignal = signals[signals.length - 1];
      expect(lastSignal.confidence).toBeGreaterThanOrEqual(0.5);
      expect(lastSignal.confidence).toBeLessThanOrEqual(1.0);
    });

    it('should boost confidence for super whales', () => {
      const walletAddress = '0xSUPER123';
      const signals: WhaleSignal[] = [];

      tracker.onSignal((signal) => signals.push(signal));

      // Build pattern with normal trades
      for (let i = 0; i < 3; i++) {
        tracker.recordTransaction(createWhaleTransaction({
          walletAddress,
          direction: 'buy',
          usdValue: 100000
        }));
      }

      const normalConfidence = signals[signals.length - 1]?.confidence || 0;

      // Add super whale trade ($500K+)
      tracker.recordTransaction(createWhaleTransaction({
        walletAddress,
        direction: 'buy',
        usdValue: 600000 // 10x threshold
      }));

      const superWhaleConfidence = signals[signals.length - 1].confidence;
      expect(superWhaleConfidence).toBeGreaterThan(normalConfidence);
    });

    it('should support unsubscribe from signals', () => {
      const walletAddress = '0xUNSUB123';
      const signals: WhaleSignal[] = [];

      // Subscribe and get unsubscribe function
      const unsubscribe = tracker.onSignal((signal) => signals.push(signal));

      // Build pattern
      for (let i = 0; i < 3; i++) {
        tracker.recordTransaction(createWhaleTransaction({
          walletAddress,
          direction: 'buy',
          usdValue: 100000
        }));
      }

      const signalsBeforeUnsub = signals.length;
      expect(signalsBeforeUnsub).toBeGreaterThan(0);

      // Unsubscribe
      unsubscribe();

      // Add more transactions
      tracker.recordTransaction(createWhaleTransaction({
        walletAddress,
        direction: 'buy',
        usdValue: 100000
      }));

      // Signal count should not increase after unsubscribe
      expect(signals.length).toBe(signalsBeforeUnsub);
    });

    it('should handle handler errors gracefully', () => {
      const walletAddress = '0xERROR123';
      const goodSignals: WhaleSignal[] = [];

      // Add a handler that throws
      tracker.onSignal(() => {
        throw new Error('Handler error');
      });

      // Add a handler that works
      tracker.onSignal((signal) => goodSignals.push(signal));

      // Build pattern - should not throw despite bad handler
      expect(() => {
        for (let i = 0; i < 4; i++) {
          tracker.recordTransaction(createWhaleTransaction({
            walletAddress,
            direction: 'buy',
            usdValue: 100000
          }));
        }
      }).not.toThrow();

      // Good handler should still receive signals
      expect(goodSignals.length).toBeGreaterThan(0);
    });
  });

  describe('Activity Summary', () => {
    it('should calculate activity summary for a pair', () => {
      const pairAddress = '0xPAIR123';

      // Add multiple transactions
      tracker.recordTransaction(createWhaleTransaction({
        pairAddress,
        direction: 'buy',
        usdValue: 100000
      }));
      tracker.recordTransaction(createWhaleTransaction({
        pairAddress,
        direction: 'sell',
        usdValue: 50000
      }));

      const summary = tracker.getActivitySummary(pairAddress, 'ethereum');

      expect(summary.buyVolumeUsd).toBe(100000);
      expect(summary.sellVolumeUsd).toBe(50000);
      expect(summary.netFlowUsd).toBe(50000);
      expect(summary.dominantDirection).toBe('bullish');
    });

    it('should use exact matching for pairKey (regression test)', () => {
      // This tests that "USDT" should NOT match "USDT2" (includes() bug fix)
      tracker.recordTransaction(createWhaleTransaction({
        pairAddress: '0xPAIR_USDT2',
        tokenIn: 'USDT2',
        tokenOut: 'WETH',
        direction: 'buy',
        usdValue: 100000
      }));

      // Query for 'USDT' should NOT match 'USDT2'
      const summaryUSDT = tracker.getActivitySummary('USDT', 'ethereum');
      expect(summaryUSDT.buyVolumeUsd).toBe(0);
      expect(summaryUSDT.whaleCount).toBe(0);

      // Query for 'USDT2' should match
      const summaryUSDT2 = tracker.getActivitySummary('USDT2', 'ethereum');
      expect(summaryUSDT2.buyVolumeUsd).toBe(100000);
      expect(summaryUSDT2.whaleCount).toBe(1);
    });
  });

  describe('Wallet Queries', () => {
    it('should return top whales by volume', () => {
      // Create whales with different volumes
      tracker.recordTransaction(createWhaleTransaction({
        walletAddress: '0xSMALL',
        usdValue: 50000
      }));
      tracker.recordTransaction(createWhaleTransaction({
        walletAddress: '0xMEDIUM',
        usdValue: 100000
      }));
      tracker.recordTransaction(createWhaleTransaction({
        walletAddress: '0xLARGE',
        usdValue: 500000
      }));

      const topWhales = tracker.getTopWhales(2);

      expect(topWhales.length).toBe(2);
      expect(topWhales[0].address).toBe('0xLARGE');
      expect(topWhales[1].address).toBe('0xMEDIUM');
    });

    it('should return wallets by pattern', () => {
      // Create accumulators
      for (let i = 0; i < 2; i++) {
        const walletAddress = `0xACCUM${i}`;
        for (let j = 0; j < 4; j++) {
          tracker.recordTransaction(createWhaleTransaction({
            walletAddress,
            direction: 'buy',
            usdValue: 100000
          }));
        }
      }

      // Create a distributor
      const distWallet = '0xDIST';
      for (let j = 0; j < 4; j++) {
        tracker.recordTransaction(createWhaleTransaction({
          walletAddress: distWallet,
          direction: 'sell',
          usdValue: 100000
        }));
      }

      const accumulators = tracker.getWalletsByPattern('accumulator');
      expect(accumulators.length).toBe(2);

      const distributors = tracker.getWalletsByPattern('distributor');
      expect(distributors.length).toBe(1);
      expect(distributors[0].address).toBe(distWallet);
    });
  });

  describe('LRU Eviction', () => {
    it('should evict oldest wallets when limit reached', () => {
      const smallTracker = new WhaleActivityTracker({
        whaleThresholdUsd: 50000,
        maxTrackedWallets: 10
      });

      // Add 15 wallets
      for (let i = 0; i < 15; i++) {
        smallTracker.recordTransaction(createWhaleTransaction({
          walletAddress: `0xWALLET${i}`,
          usdValue: 100000,
          timestamp: Date.now() + i * 1000 // Different timestamps
        }));
      }

      const stats = smallTracker.getStats();
      expect(stats.totalWalletsTracked).toBeLessThanOrEqual(10);
      expect(stats.walletEvictions).toBeGreaterThan(0);
    });
  });

  describe('Singleton Factory', () => {
    it('should return same instance', () => {
      const instance1 = getWhaleActivityTracker();
      const instance2 = getWhaleActivityTracker();
      expect(instance1).toBe(instance2);
    });

    it('should reset properly', () => {
      const instance1 = getWhaleActivityTracker();
      instance1.recordTransaction(createWhaleTransaction({ usdValue: 100000 }));

      resetWhaleActivityTracker();

      const instance2 = getWhaleActivityTracker();
      expect(instance2).not.toBe(instance1);
      expect(instance2.getStats().totalTransactionsTracked).toBe(0);
    });
  });
});

// ===========================================================================
// T3.15: Liquidity Depth Analysis Tests
// ===========================================================================

describe('T3.15: Liquidity Depth Analysis', () => {
  let analyzer: LiquidityDepthAnalyzer;

  beforeEach(() => {
    resetLiquidityDepthAnalyzer();
    analyzer = new LiquidityDepthAnalyzer({
      depthLevels: 10,
      tradeSizeStepUsd: 1000,
      maxTradeSizeUsd: 100000,
      maxTrackedPools: 100,
      cacheTtlMs: 30000
    });
  });

  describe('Pool Tracking', () => {
    it('should update pool liquidity', () => {
      const pool = createPoolLiquidity();
      analyzer.updatePoolLiquidity(pool);

      const retrieved = analyzer.getPoolLiquidity(pool.poolAddress);
      expect(retrieved).toBeDefined();
      expect(retrieved!.liquidityUsd).toBe(pool.liquidityUsd);
    });

    it('should track multiple pools', () => {
      for (let i = 0; i < 5; i++) {
        analyzer.updatePoolLiquidity(createPoolLiquidity({
          poolAddress: `0xPOOL${i}`
        }));
      }

      const tracked = analyzer.getTrackedPools();
      expect(tracked.length).toBe(5);
    });
  });

  describe('Depth Analysis', () => {
    it('should analyze pool depth', () => {
      const pool = createPoolLiquidity();
      analyzer.updatePoolLiquidity(pool);

      const analysis = analyzer.analyzeDepth(pool.poolAddress);

      expect(analysis).not.toBeNull();
      expect(analysis!.buyLevels.length).toBeGreaterThan(0);
      expect(analysis!.sellLevels.length).toBeGreaterThan(0);
    });

    it('should calculate liquidity levels', () => {
      const pool = createPoolLiquidity();
      analyzer.updatePoolLiquidity(pool);

      const analysis = analyzer.analyzeDepth(pool.poolAddress);

      for (const level of analysis!.buyLevels) {
        expect(level.tradeSize).toBeGreaterThan(0);
        expect(level.tradeSizeUsd).toBeGreaterThan(0);
        expect(level.priceImpactPercent).toBeGreaterThanOrEqual(0);
        expect(level.slippagePercent).toBeGreaterThan(0);
        expect(level.outputAmount).toBeGreaterThan(0);
      }
    });

    it('should increase slippage with larger trades', () => {
      const pool = createPoolLiquidity();
      analyzer.updatePoolLiquidity(pool);

      const analysis = analyzer.analyzeDepth(pool.poolAddress);
      const levels = analysis!.buyLevels;

      // Slippage should generally increase with trade size
      for (let i = 1; i < levels.length; i++) {
        expect(levels[i].slippagePercent).toBeGreaterThanOrEqual(levels[i - 1].slippagePercent - 0.01);
      }
    });

    it('should calculate optimal trade size', () => {
      const pool = createPoolLiquidity();
      analyzer.updatePoolLiquidity(pool);

      const analysis = analyzer.analyzeDepth(pool.poolAddress);

      expect(analysis!.optimalTradeSizeUsd).toBeGreaterThan(0);
      expect(analysis!.maxTradeSizeFor1PercentSlippage).toBeGreaterThan(0);
    });

    it('should calculate liquidity score', () => {
      const pool = createPoolLiquidity();
      analyzer.updatePoolLiquidity(pool);

      const analysis = analyzer.analyzeDepth(pool.poolAddress);

      expect(analysis!.liquidityScore).toBeGreaterThanOrEqual(0);
      expect(analysis!.liquidityScore).toBeLessThanOrEqual(1);
    });
  });

  describe('Slippage Estimation', () => {
    it('should estimate slippage for buy trades', () => {
      const pool = createPoolLiquidity();
      analyzer.updatePoolLiquidity(pool);

      const estimate = analyzer.estimateSlippage(pool.poolAddress, 10000, 'buy');

      expect(estimate).not.toBeNull();
      expect(estimate!.inputAmountUsd).toBe(10000);
      expect(estimate!.priceImpactPercent).toBeGreaterThanOrEqual(0);
      expect(estimate!.slippagePercent).toBeGreaterThan(0);
      expect(estimate!.outputAmount).toBeGreaterThan(0);
    });

    it('should estimate slippage for sell trades', () => {
      const pool = createPoolLiquidity();
      analyzer.updatePoolLiquidity(pool);

      const estimate = analyzer.estimateSlippage(pool.poolAddress, 10000, 'sell');

      expect(estimate).not.toBeNull();
      expect(estimate!.tradeDirection).toBe('sell');
      expect(estimate!.slippagePercent).toBeGreaterThan(0);
    });

    it('should increase slippage with larger trades', () => {
      const pool = createPoolLiquidity();
      analyzer.updatePoolLiquidity(pool);

      const small = analyzer.estimateSlippage(pool.poolAddress, 1000, 'buy');
      const large = analyzer.estimateSlippage(pool.poolAddress, 100000, 'buy');

      expect(large!.slippagePercent).toBeGreaterThan(small!.slippagePercent);
    });

    it('should return confidence score', () => {
      const pool = createPoolLiquidity();
      analyzer.updatePoolLiquidity(pool);

      const estimate = analyzer.estimateSlippage(pool.poolAddress, 10000, 'buy');

      expect(estimate!.confidence).toBeGreaterThanOrEqual(0);
      expect(estimate!.confidence).toBeLessThanOrEqual(1);
    });
  });

  describe('Best Pool Finding', () => {
    it('should find best pool for token pair', () => {
      // Add multiple pools with different liquidity
      // Reserves must be proportional to liquidityUsd for realistic slippage
      analyzer.updatePoolLiquidity(createPoolLiquidity({
        poolAddress: '0xLOW',
        token0: 'USDT',
        token1: 'WETH',
        liquidityUsd: 100000, // Low liquidity
        // Low reserves: $50K USDT + 20 WETH
        reserve0: BigInt('50000000000000000000000'),   // 50K USDT
        reserve1: BigInt('20000000000000000000')       // 20 WETH
      }));
      analyzer.updatePoolLiquidity(createPoolLiquidity({
        poolAddress: '0xHIGH',
        token0: 'USDT',
        token1: 'WETH',
        liquidityUsd: 50000000, // High liquidity
        // High reserves: $25M USDT + 10K WETH
        reserve0: BigInt('25000000000000000000000000'), // 25M USDT
        reserve1: BigInt('10000000000000000000000')     // 10K WETH
      }));

      const best = analyzer.findBestPool('USDT', 'WETH', 10000, 'buy');

      expect(best).not.toBeNull();
      expect(best!.poolAddress).toBe('0xHIGH'); // Higher liquidity = lower slippage
    });

    it('should return null for unknown token pair', () => {
      analyzer.updatePoolLiquidity(createPoolLiquidity());

      const result = analyzer.findBestPool('UNKNOWN1', 'UNKNOWN2', 10000, 'buy');
      expect(result).toBeNull();
    });
  });

  describe('Caching', () => {
    it('should cache depth analysis', () => {
      const pool = createPoolLiquidity();
      analyzer.updatePoolLiquidity(pool);

      // First call
      analyzer.analyzeDepth(pool.poolAddress);
      const stats1 = analyzer.getStats();
      expect(stats1.cacheMisses).toBe(1);

      // Second call (should hit cache)
      analyzer.analyzeDepth(pool.poolAddress);
      const stats2 = analyzer.getStats();
      expect(stats2.cacheHits).toBe(1);
    });

    it('should invalidate cache on pool update', () => {
      const pool = createPoolLiquidity();
      analyzer.updatePoolLiquidity(pool);

      analyzer.analyzeDepth(pool.poolAddress);

      // Update pool
      analyzer.updatePoolLiquidity({ ...pool, liquidityUsd: pool.liquidityUsd * 2 });

      // Should miss cache after update
      analyzer.analyzeDepth(pool.poolAddress);
      const stats = analyzer.getStats();
      expect(stats.cacheMisses).toBe(2);
    });
  });

  describe('LRU Eviction', () => {
    it('should evict oldest pools when limit reached', () => {
      const smallAnalyzer = new LiquidityDepthAnalyzer({
        maxTrackedPools: 10
      });

      // Add 15 pools
      for (let i = 0; i < 15; i++) {
        smallAnalyzer.updatePoolLiquidity(createPoolLiquidity({
          poolAddress: `0xPOOL${i}`,
          timestamp: Date.now() + i * 1000
        }));
      }

      const stats = smallAnalyzer.getStats();
      expect(stats.poolsTracked).toBeLessThanOrEqual(10);
      expect(stats.poolEvictions).toBeGreaterThan(0);
    });
  });

  describe('Statistics', () => {
    it('should track analysis statistics', () => {
      const pool = createPoolLiquidity();
      analyzer.updatePoolLiquidity(pool);

      analyzer.analyzeDepth(pool.poolAddress);
      analyzer.estimateSlippage(pool.poolAddress, 10000, 'buy');

      const stats = analyzer.getStats();
      expect(stats.analysisCount).toBe(1);
      expect(stats.avgAnalysisTimeMs).toBeGreaterThan(0);
    });

    it('should reset properly', () => {
      const pool = createPoolLiquidity();
      analyzer.updatePoolLiquidity(pool);
      analyzer.analyzeDepth(pool.poolAddress);

      analyzer.reset();

      const stats = analyzer.getStats();
      expect(stats.poolsTracked).toBe(0);
      expect(stats.analysisCount).toBe(0);
    });
  });

  describe('Singleton Factory', () => {
    it('should return same instance', () => {
      const instance1 = getLiquidityDepthAnalyzer();
      const instance2 = getLiquidityDepthAnalyzer();
      expect(instance1).toBe(instance2);
    });

    it('should reset properly', () => {
      const instance1 = getLiquidityDepthAnalyzer();
      instance1.updatePoolLiquidity(createPoolLiquidity());

      resetLiquidityDepthAnalyzer();

      const instance2 = getLiquidityDepthAnalyzer();
      expect(instance2).not.toBe(instance1);
      expect(instance2.getStats().poolsTracked).toBe(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle pool with zero reserves gracefully', () => {
      const pool = createPoolLiquidity({
        reserve0: 0n,
        reserve1: 0n
      });
      analyzer.updatePoolLiquidity(pool);

      const analysis = analyzer.analyzeDepth(pool.poolAddress);
      expect(analysis).not.toBeNull();
      // Should return empty or safe default levels
    });

    it('should return null for unknown pool', () => {
      const analysis = analyzer.analyzeDepth('0xUNKNOWN');
      expect(analysis).toBeNull();
    });

    it('should handle very large trade sizes', () => {
      // Create a pool with $1M liquidity and proportional reserves
      // $500K USDT + 200 WETH (at $2500/WETH)
      const pool = createPoolLiquidity({
        liquidityUsd: 1000000, // $1M liquidity
        reserve0: BigInt('500000000000000000000000'),  // 500K USDT
        reserve1: BigInt('200000000000000000000')      // 200 WETH
      });
      analyzer.updatePoolLiquidity(pool);

      // Try to estimate slippage for $500K trade (50% of liquidity)
      const estimate = analyzer.estimateSlippage(pool.poolAddress, 500000, 'buy');

      // Should return high slippage but not crash
      expect(estimate).not.toBeNull();
      expect(estimate!.slippagePercent).toBeGreaterThan(5); // Expect significant slippage
    });
  });

  describe('Input Validation (regression tests)', () => {
    it('should skip pool update with missing poolAddress', () => {
      const pool = createPoolLiquidity({
        poolAddress: '' // Empty address
      });

      analyzer.updatePoolLiquidity(pool);

      // Pool should not be tracked
      expect(analyzer.getTrackedPools().length).toBe(0);
    });

    it('should skip pool update with negative reserves', () => {
      const pool = createPoolLiquidity({
        reserve0: -1n as unknown as bigint, // Negative reserve
        reserve1: BigInt('1000000000000000000')
      });

      analyzer.updatePoolLiquidity(pool);

      // Pool should not be tracked
      expect(analyzer.getPoolLiquidity(pool.poolAddress)).toBeUndefined();
    });

    it('should skip pool update with zero price', () => {
      const pool = createPoolLiquidity({
        price: 0 // Zero price
      });

      analyzer.updatePoolLiquidity(pool);

      // Pool should not be tracked
      expect(analyzer.getPoolLiquidity(pool.poolAddress)).toBeUndefined();
    });

    it('should skip pool update with negative price', () => {
      const pool = createPoolLiquidity({
        price: -100 // Negative price
      });

      analyzer.updatePoolLiquidity(pool);

      // Pool should not be tracked
      expect(analyzer.getPoolLiquidity(pool.poolAddress)).toBeUndefined();
    });

    it('should skip pool update with NaN price', () => {
      const pool = createPoolLiquidity({
        price: NaN // Invalid price
      });

      analyzer.updatePoolLiquidity(pool);

      // Pool should not be tracked
      expect(analyzer.getPoolLiquidity(pool.poolAddress)).toBeUndefined();
    });

    it('should skip pool update with Infinity price', () => {
      const pool = createPoolLiquidity({
        price: Infinity // Invalid price
      });

      analyzer.updatePoolLiquidity(pool);

      // Pool should not be tracked
      expect(analyzer.getPoolLiquidity(pool.poolAddress)).toBeUndefined();
    });

    it('should skip pool update with negative liquidityUsd', () => {
      const pool = createPoolLiquidity({
        liquidityUsd: -1000 // Negative liquidity
      });

      analyzer.updatePoolLiquidity(pool);

      // Pool should not be tracked
      expect(analyzer.getPoolLiquidity(pool.poolAddress)).toBeUndefined();
    });

    it('should skip pool update with NaN liquidityUsd', () => {
      const pool = createPoolLiquidity({
        liquidityUsd: NaN // Invalid liquidity
      });

      analyzer.updatePoolLiquidity(pool);

      // Pool should not be tracked
      expect(analyzer.getPoolLiquidity(pool.poolAddress)).toBeUndefined();
    });

    it('should accept valid pool data', () => {
      const pool = createPoolLiquidity(); // Valid defaults

      analyzer.updatePoolLiquidity(pool);

      // Pool should be tracked
      const retrieved = analyzer.getPoolLiquidity(pool.poolAddress);
      expect(retrieved).toBeDefined();
      expect(retrieved!.poolAddress).toBe(pool.poolAddress);
    });
  });
});
