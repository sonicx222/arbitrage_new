/**
 * Whale Activity Tracker Unit Tests
 *
 * Tests for whale transaction recording, wallet pattern detection,
 * signal generation, activity summaries, and LRU eviction.
 *
 * @see shared/core/src/analytics/whale-activity-tracker.ts
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  WhaleActivityTracker,
  getWhaleActivityTracker,
  resetWhaleActivityTracker
} from '../../src/analytics/whale-activity-tracker';
import type {
  TrackedWhaleTransaction,
  WhaleSignal,
  WhaleTrackerConfig
} from '../../src/analytics/whale-activity-tracker';

// =============================================================================
// Test Helpers
// =============================================================================

function createTransaction(overrides: Partial<TrackedWhaleTransaction> = {}): TrackedWhaleTransaction {
  return {
    transactionHash: `0xhash_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    walletAddress: '0xwhale_wallet_1',
    chain: 'ethereum',
    dex: 'uniswap',
    pairAddress: '0xpair_eth_usdt',
    tokenIn: 'USDT',
    tokenOut: 'WETH',
    amountIn: 100000,
    amountOut: 50,
    usdValue: 100000,
    direction: 'buy' as const,
    timestamp: Date.now(),
    priceImpact: 0.5,
    ...overrides
  };
}

const TEST_CONFIG: Partial<WhaleTrackerConfig> = {
  whaleThresholdUsd: 50000,
  activityWindowMs: 60000, // 1 minute for faster tests
  minTradesForPattern: 3,
  maxTrackedWallets: 50,
  maxTransactionsPerWallet: 20,
  superWhaleMultiplier: 10
};

describe('WhaleActivityTracker', () => {
  let tracker: WhaleActivityTracker;

  beforeEach(() => {
    resetWhaleActivityTracker();
    tracker = new WhaleActivityTracker(TEST_CONFIG);
  });

  afterEach(() => {
    tracker.reset();
  });

  // ===========================================================================
  // recordTransaction
  // ===========================================================================

  describe('recordTransaction', () => {
    it('should record a qualifying whale transaction', () => {
      const tx = createTransaction({ usdValue: 60000 });
      tracker.recordTransaction(tx);

      const profile = tracker.getWalletProfile(tx.walletAddress);
      expect(profile).not.toBeUndefined();
      expect(profile!.totalTransactions).toBe(1);
      expect(profile!.totalVolumeUsd).toBe(60000);
    });

    it('should reject transactions below whale threshold', () => {
      const tx = createTransaction({ usdValue: 10000 }); // Below $50K threshold
      tracker.recordTransaction(tx);

      expect(tracker.getWalletProfile(tx.walletAddress)).toBeUndefined();
    });

    it('should accumulate transactions for the same wallet', () => {
      const wallet = '0xrepeat_whale';
      tracker.recordTransaction(createTransaction({ walletAddress: wallet, usdValue: 60000 }));
      tracker.recordTransaction(createTransaction({ walletAddress: wallet, usdValue: 80000 }));

      const profile = tracker.getWalletProfile(wallet);
      expect(profile!.totalTransactions).toBe(2);
      expect(profile!.totalVolumeUsd).toBe(140000);
    });

    it('should track active chains', () => {
      const wallet = '0xmulti_chain_whale';
      tracker.recordTransaction(createTransaction({ walletAddress: wallet, chain: 'ethereum', usdValue: 60000 }));
      tracker.recordTransaction(createTransaction({ walletAddress: wallet, chain: 'bsc', usdValue: 60000 }));

      const profile = tracker.getWalletProfile(wallet);
      expect(profile!.activeChains.has('ethereum')).toBe(true);
      expect(profile!.activeChains.has('bsc')).toBe(true);
    });

    it('should track frequent tokens', () => {
      const wallet = '0xtoken_whale';
      tracker.recordTransaction(createTransaction({
        walletAddress: wallet,
        tokenIn: 'USDT',
        tokenOut: 'WETH',
        usdValue: 60000
      }));

      const profile = tracker.getWalletProfile(wallet);
      expect(profile!.frequentTokens.get('USDT')).toBe(1);
      expect(profile!.frequentTokens.get('WETH')).toBe(1);
    });

    it('should limit recent transactions to maxTransactionsPerWallet', () => {
      const wallet = '0xlots_of_trades';
      // Record 45 transactions (limit is 20, amortized trim at 2x = 40)
      // After exceeding 40, array trims back to 20
      for (let i = 0; i < 45; i++) {
        tracker.recordTransaction(createTransaction({
          walletAddress: wallet,
          usdValue: 60000,
          timestamp: Date.now() + i * 100
        }));
      }

      const profile = tracker.getWalletProfile(wallet);
      // Amortized trim: array grows up to 2x limit then slices back to limit
      expect(profile!.recentTransactions.length).toBeLessThanOrEqual(20 * 2);
      expect(profile!.totalTransactions).toBe(45);
    });

    it('should update stats counter', () => {
      tracker.recordTransaction(createTransaction({ usdValue: 60000 }));
      const stats = tracker.getStats();
      expect(stats.totalTransactionsTracked).toBe(1);
    });
  });

  // ===========================================================================
  // Pattern Detection
  // ===========================================================================

  describe('pattern detection', () => {
    it('should return unknown pattern with fewer than minTradesForPattern', () => {
      const wallet = '0xfew_trades';
      tracker.recordTransaction(createTransaction({
        walletAddress: wallet,
        direction: 'buy',
        usdValue: 60000
      }));

      expect(tracker.getWalletProfile(wallet)!.pattern).toBe('unknown');
    });

    it('should detect accumulator pattern (mostly buys)', () => {
      const wallet = '0xaccumulator';
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        tracker.recordTransaction(createTransaction({
          walletAddress: wallet,
          direction: 'buy',
          usdValue: 60000,
          timestamp: now + i * 1000
        }));
      }

      expect(tracker.getWalletProfile(wallet)!.pattern).toBe('accumulator');
    });

    it('should detect distributor pattern (mostly sells)', () => {
      const wallet = '0xdistributor';
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        tracker.recordTransaction(createTransaction({
          walletAddress: wallet,
          direction: 'sell',
          usdValue: 60000,
          timestamp: now + i * 1000
        }));
      }

      expect(tracker.getWalletProfile(wallet)!.pattern).toBe('distributor');
    });

    it('should detect swing trader pattern (mixed buys and sells)', () => {
      const wallet = '0xswing';
      const now = Date.now();
      const directions: Array<'buy' | 'sell'> = ['buy', 'sell', 'buy', 'sell', 'buy'];
      for (let i = 0; i < 5; i++) {
        tracker.recordTransaction(createTransaction({
          walletAddress: wallet,
          direction: directions[i],
          usdValue: 60000,
          // Space trades > 1min apart to avoid arbitrageur detection
          timestamp: now + i * 120000
        }));
      }

      expect(tracker.getWalletProfile(wallet)!.pattern).toBe('swing_trader');
    });

    it('should detect arbitrageur pattern (rapid buy/sell cycles)', () => {
      const wallet = '0xarb';
      const now = Date.now();
      const directions: Array<'buy' | 'sell'> = ['buy', 'sell', 'buy', 'sell', 'buy', 'sell'];
      for (let i = 0; i < 6; i++) {
        tracker.recordTransaction(createTransaction({
          walletAddress: wallet,
          direction: directions[i],
          usdValue: 60000,
          // Very fast trades (<1 min avg)
          timestamp: now + i * 10000
        }));
      }

      expect(tracker.getWalletProfile(wallet)!.pattern).toBe('arbitrageur');
    });
  });

  // ===========================================================================
  // Signal Generation
  // ===========================================================================

  describe('signal generation', () => {
    it('should not generate signals for unknown pattern wallets', () => {
      const signals: WhaleSignal[] = [];
      tracker.onSignal(s => signals.push(s));

      // Only 1 transaction — pattern stays 'unknown'
      tracker.recordTransaction(createTransaction({ usdValue: 60000 }));

      expect(signals.length).toBe(0);
    });

    it('should generate follow signal for accumulator buying', () => {
      const signals: WhaleSignal[] = [];
      tracker.onSignal(s => signals.push(s));

      const wallet = '0xacc_signal';
      const now = Date.now();
      // Build up accumulator pattern
      for (let i = 0; i < 4; i++) {
        tracker.recordTransaction(createTransaction({
          walletAddress: wallet,
          direction: 'buy',
          usdValue: 60000,
          timestamp: now + i * 1000
        }));
      }

      // The signal should be generated once the pattern is established
      const followSignals = signals.filter(s => s.type === 'follow');
      expect(followSignals.length).toBeGreaterThan(0);
    });

    it('should boost confidence for super whale transactions', () => {
      const signals: WhaleSignal[] = [];
      tracker.onSignal(s => signals.push(s));

      const wallet = '0xsuper_whale';
      const now = Date.now();
      // Build pattern first
      for (let i = 0; i < 3; i++) {
        tracker.recordTransaction(createTransaction({
          walletAddress: wallet,
          direction: 'buy',
          usdValue: 60000,
          timestamp: now + i * 1000
        }));
      }
      // Super whale transaction (10x threshold = $500K)
      tracker.recordTransaction(createTransaction({
        walletAddress: wallet,
        direction: 'buy',
        usdValue: 600000,
        timestamp: now + 5000
      }));

      const superSignals = signals.filter(s => s.reasoning.includes('SUPER WHALE'));
      expect(superSignals.length).toBeGreaterThan(0);
      if (superSignals.length > 0) {
        expect(superSignals[0].confidence).toBeGreaterThan(0.7);
      }
    });

    it('should allow unsubscribing from signals', () => {
      const signals: WhaleSignal[] = [];
      const unsubscribe = tracker.onSignal(s => signals.push(s));

      unsubscribe();

      const wallet = '0xno_signal';
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        tracker.recordTransaction(createTransaction({
          walletAddress: wallet,
          direction: 'buy',
          usdValue: 60000,
          timestamp: now + i * 1000
        }));
      }

      expect(signals.length).toBe(0);
    });

    it('should handle signal handler errors gracefully', () => {
      tracker.onSignal(() => { throw new Error('Handler error'); });

      const wallet = '0xerror_handler';
      const now = Date.now();
      // Should not throw even if handler throws
      expect(() => {
        for (let i = 0; i < 5; i++) {
          tracker.recordTransaction(createTransaction({
            walletAddress: wallet,
            direction: 'buy',
            usdValue: 60000,
            timestamp: now + i * 1000
          }));
        }
      }).not.toThrow();
    });
  });

  // ===========================================================================
  // getActivitySummary
  // ===========================================================================

  describe('getActivitySummary', () => {
    it('should return zero values for unknown pair', () => {
      const summary = tracker.getActivitySummary('0xunknown', 'ethereum');

      expect(summary.buyVolumeUsd).toBe(0);
      expect(summary.sellVolumeUsd).toBe(0);
      expect(summary.whaleCount).toBe(0);
      expect(summary.dominantDirection).toBe('neutral');
    });

    it('should aggregate buy and sell volumes for a pair', () => {
      const now = Date.now();
      // Buy transaction
      tracker.recordTransaction(createTransaction({
        walletAddress: '0xbuyer',
        pairAddress: '0xpair_target',
        direction: 'buy',
        usdValue: 100000,
        chain: 'ethereum',
        timestamp: now
      }));
      // Sell transaction
      tracker.recordTransaction(createTransaction({
        walletAddress: '0xseller',
        pairAddress: '0xpair_target',
        direction: 'sell',
        usdValue: 60000,
        chain: 'ethereum',
        timestamp: now + 100
      }));

      const summary = tracker.getActivitySummary('0xpair_target', 'ethereum');
      expect(summary.buyVolumeUsd).toBe(100000);
      expect(summary.sellVolumeUsd).toBe(60000);
      expect(summary.netFlowUsd).toBe(40000);
      expect(summary.whaleCount).toBe(2);
    });

    it('should detect bullish dominant direction', () => {
      const now = Date.now();
      // Overwhelmingly buy
      for (let i = 0; i < 5; i++) {
        tracker.recordTransaction(createTransaction({
          walletAddress: `0xbuyer_${i}`,
          pairAddress: '0xbullish_pair',
          direction: 'buy',
          usdValue: 60000,
          chain: 'ethereum',
          timestamp: now + i * 100
        }));
      }

      const summary = tracker.getActivitySummary('0xbullish_pair', 'ethereum');
      expect(summary.dominantDirection).toBe('bullish');
    });

    it('should detect bearish dominant direction', () => {
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        tracker.recordTransaction(createTransaction({
          walletAddress: `0xseller_${i}`,
          pairAddress: '0xbearish_pair',
          direction: 'sell',
          usdValue: 60000,
          chain: 'ethereum',
          timestamp: now + i * 100
        }));
      }

      const summary = tracker.getActivitySummary('0xbearish_pair', 'ethereum');
      expect(summary.dominantDirection).toBe('bearish');
    });

    it('should count super whale transactions', () => {
      const now = Date.now();
      tracker.recordTransaction(createTransaction({
        walletAddress: '0xsuper',
        pairAddress: '0xpair_super',
        direction: 'buy',
        usdValue: 600000, // >= $500K = super whale
        chain: 'ethereum',
        timestamp: now
      }));

      const summary = tracker.getActivitySummary('0xpair_super', 'ethereum');
      expect(summary.superWhaleCount).toBe(1);
    });

    it('should filter by time window', () => {
      const now = Date.now();
      // Old transaction (outside default window)
      tracker.recordTransaction(createTransaction({
        walletAddress: '0xold_whale',
        pairAddress: '0xpair_time',
        direction: 'buy',
        usdValue: 60000,
        chain: 'ethereum',
        timestamp: now - 120000 // 2 min ago, outside 1 min window
      }));
      // Recent transaction
      tracker.recordTransaction(createTransaction({
        walletAddress: '0xnew_whale',
        pairAddress: '0xpair_time',
        direction: 'buy',
        usdValue: 80000,
        chain: 'ethereum',
        timestamp: now
      }));

      const summary = tracker.getActivitySummary('0xpair_time', 'ethereum');
      expect(summary.buyVolumeUsd).toBe(80000); // Only the recent one
    });

    it('should use secondary index for efficient lookup', () => {
      const now = Date.now();
      // Add transactions for different pairs
      tracker.recordTransaction(createTransaction({
        walletAddress: '0xwallet1',
        pairAddress: '0xtarget_pair',
        chain: 'ethereum',
        usdValue: 60000,
        timestamp: now
      }));
      tracker.recordTransaction(createTransaction({
        walletAddress: '0xwallet2',
        pairAddress: '0xother_pair',
        chain: 'ethereum',
        usdValue: 60000,
        timestamp: now
      }));

      const summary = tracker.getActivitySummary('0xtarget_pair', 'ethereum');
      // Should only include transactions for target pair
      expect(summary.whaleCount).toBe(1);
    });
  });

  // ===========================================================================
  // getTopWhales / getWalletsByPattern
  // ===========================================================================

  describe('getTopWhales', () => {
    it('should return top whales sorted by volume', () => {
      const now = Date.now();
      tracker.recordTransaction(createTransaction({
        walletAddress: '0xsmall', usdValue: 60000, timestamp: now
      }));
      tracker.recordTransaction(createTransaction({
        walletAddress: '0xlarge', usdValue: 200000, timestamp: now + 100
      }));
      tracker.recordTransaction(createTransaction({
        walletAddress: '0xmedium', usdValue: 100000, timestamp: now + 200
      }));

      const top = tracker.getTopWhales(2);
      expect(top.length).toBe(2);
      expect(top[0].address).toBe('0xlarge');
      expect(top[1].address).toBe('0xmedium');
    });
  });

  describe('getWalletsByPattern', () => {
    it('should filter wallets by pattern', () => {
      const now = Date.now();
      // Create accumulator
      for (let i = 0; i < 5; i++) {
        tracker.recordTransaction(createTransaction({
          walletAddress: '0xacc',
          direction: 'buy',
          usdValue: 60000,
          timestamp: now + i * 1000
        }));
      }

      const accumulators = tracker.getWalletsByPattern('accumulator');
      expect(accumulators.length).toBeGreaterThan(0);
      expect(accumulators[0].address).toBe('0xacc');
    });
  });

  // ===========================================================================
  // LRU Eviction
  // ===========================================================================

  describe('LRU eviction', () => {
    it('should evict oldest wallets when maxTrackedWallets exceeded', () => {
      const smallTracker = new WhaleActivityTracker({
        ...TEST_CONFIG,
        maxTrackedWallets: 5
      });

      const now = Date.now();
      for (let i = 0; i < 6; i++) {
        smallTracker.recordTransaction(createTransaction({
          walletAddress: `0xwallet_${i}`,
          usdValue: 60000,
          timestamp: now + i * 1000
        }));
      }

      const stats = smallTracker.getStats();
      expect(stats.totalWalletsTracked).toBeLessThanOrEqual(5);
      expect(stats.walletEvictions).toBeGreaterThan(0);

      smallTracker.reset();
    });
  });

  // ===========================================================================
  // Regression: Fix #15 - Amortized O(1) trim instead of O(N) shift
  // ===========================================================================

  describe('amortized trim regression (Fix #15)', () => {
    it('should bound recentTransactions at most 2x maxTransactionsPerWallet', () => {
      const wallet = '0xamortized_trim';
      // maxTransactionsPerWallet is 20 in TEST_CONFIG
      // Array grows until 2x (40), then slices back to 20
      for (let i = 0; i < 50; i++) {
        tracker.recordTransaction(createTransaction({
          walletAddress: wallet,
          usdValue: 60000,
          timestamp: Date.now() + i * 100
        }));
      }

      const profile = tracker.getWalletProfile(wallet);
      // After 50 inserts with limit 20: array should be <= 2 * 20 = 40
      expect(profile!.recentTransactions.length).toBeLessThanOrEqual(40);
      // totalTransactions tracks all, not just recent
      expect(profile!.totalTransactions).toBe(50);
    });

    it('should keep the most recent transactions after trim', () => {
      const wallet = '0xtrim_order';
      const timestamps: number[] = [];
      for (let i = 0; i < 50; i++) {
        const ts = 1000000 + i * 100;
        timestamps.push(ts);
        tracker.recordTransaction(createTransaction({
          walletAddress: wallet,
          usdValue: 60000,
          timestamp: ts
        }));
      }

      const profile = tracker.getWalletProfile(wallet);
      // All remaining transactions should be from the later part
      const remaining = profile!.recentTransactions;
      const minTs = Math.min(...remaining.map(tx => tx.timestamp));
      // The oldest remaining should be newer than the oldest inserted
      expect(minTs).toBeGreaterThan(timestamps[0]);
    });
  });

  // ===========================================================================
  // Regression: Fix #2 - Pair index for O(W_pair * T) instead of O(W * T)
  // ===========================================================================

  describe('pair index regression (Fix #2)', () => {
    it('should correctly match by pairAddress via secondary index', () => {
      const now = Date.now();
      tracker.recordTransaction(createTransaction({
        walletAddress: '0xwA',
        pairAddress: '0xpair_AAA',
        tokenIn: 'USDT',
        tokenOut: 'WETH',
        direction: 'buy',
        usdValue: 100000,
        chain: 'ethereum',
        timestamp: now
      }));
      tracker.recordTransaction(createTransaction({
        walletAddress: '0xwB',
        pairAddress: '0xpair_BBB',
        tokenIn: 'DAI',
        tokenOut: 'WBTC',
        direction: 'sell',
        usdValue: 80000,
        chain: 'ethereum',
        timestamp: now + 100
      }));

      const summaryA = tracker.getActivitySummary('0xpair_AAA', 'ethereum');
      expect(summaryA.buyVolumeUsd).toBe(100000);
      expect(summaryA.sellVolumeUsd).toBe(0);

      const summaryB = tracker.getActivitySummary('0xpair_BBB', 'ethereum');
      expect(summaryB.sellVolumeUsd).toBe(80000);
      expect(summaryB.buyVolumeUsd).toBe(0);
    });

    it('should correctly match by tokenIn/tokenOut via secondary index', () => {
      const now = Date.now();
      tracker.recordTransaction(createTransaction({
        walletAddress: '0xwC',
        pairAddress: '0xpair_CCC',
        tokenIn: 'USDC',
        tokenOut: 'WETH',
        direction: 'buy',
        usdValue: 75000,
        chain: 'bsc',
        timestamp: now
      }));

      // Query by tokenIn
      const summaryUSDC = tracker.getActivitySummary('USDC', 'bsc');
      expect(summaryUSDC.buyVolumeUsd).toBe(75000);

      // Query by tokenOut
      const summaryWETH = tracker.getActivitySummary('WETH', 'bsc');
      expect(summaryWETH.buyVolumeUsd).toBe(75000);
    });

    it('should handle evicted wallet gracefully in pair index (stale index)', () => {
      // Use small tracker that will evict wallets
      const smallTracker = new WhaleActivityTracker({
        ...TEST_CONFIG,
        maxTrackedWallets: 3
      });

      const now = Date.now();
      // Add 3 wallets for same pair
      for (let i = 0; i < 3; i++) {
        smallTracker.recordTransaction(createTransaction({
          walletAddress: `0xevict_${i}`,
          pairAddress: '0xshared_pair',
          chain: 'ethereum',
          usdValue: 60000,
          timestamp: now + i * 1000
        }));
      }

      // Add 4th wallet (triggers eviction of wallet 0)
      smallTracker.recordTransaction(createTransaction({
        walletAddress: '0xevict_3',
        pairAddress: '0xshared_pair',
        chain: 'ethereum',
        usdValue: 70000,
        timestamp: now + 5000
      }));

      // Pair index still references evicted wallet, but getActivitySummary
      // should handle it via `if (!profile) continue`
      const summary = smallTracker.getActivitySummary('0xshared_pair', 'ethereum');
      // Should not crash and should only include non-evicted wallets
      expect(summary.whaleCount).toBeGreaterThan(0);
      // The evicted wallet's volume should NOT be included
      expect(summary.buyVolumeUsd).toBeLessThan(60000 * 4);

      smallTracker.reset();
    });
  });

  // ===========================================================================
  // Reset / Stats
  // ===========================================================================

  describe('reset', () => {
    it('should clear all data', () => {
      tracker.recordTransaction(createTransaction({ usdValue: 60000 }));
      tracker.reset();

      expect(tracker.getStats().totalWalletsTracked).toBe(0);
      expect(tracker.getStats().totalTransactionsTracked).toBe(0);
    });
  });

  describe('stats', () => {
    it('should track signal generation count and average confidence', () => {
      const now = Date.now();
      // Build a pattern that generates signals
      for (let i = 0; i < 5; i++) {
        tracker.recordTransaction(createTransaction({
          walletAddress: '0xstats_whale',
          direction: 'buy',
          usdValue: 60000,
          timestamp: now + i * 1000
        }));
      }

      const stats = tracker.getStats();
      expect(stats.totalTransactionsTracked).toBe(5);
      expect(stats.totalWalletsTracked).toBe(1);
      // Signals should have been generated after pattern was established
      if (stats.totalSignalsGenerated > 0) {
        expect(stats.avgSignalConfidence).toBeGreaterThan(0);
        expect(stats.avgSignalConfidence).toBeLessThanOrEqual(1);
      }
    });
  });

  // ===========================================================================
  // Singleton factory
  // ===========================================================================

  describe('singleton', () => {
    it('should return the same instance on multiple calls', () => {
      const a = getWhaleActivityTracker();
      const b = getWhaleActivityTracker();
      expect(a).toBe(b);
      resetWhaleActivityTracker();
    });

    it('should return a new instance after reset', () => {
      const a = getWhaleActivityTracker();
      resetWhaleActivityTracker();
      const b = getWhaleActivityTracker();
      expect(a).not.toBe(b);
      resetWhaleActivityTracker();
    });
  });
});
