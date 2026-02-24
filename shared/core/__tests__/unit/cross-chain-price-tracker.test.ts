/**
 * CrossChainPriceTracker Unit Tests
 *
 * Tests cross-chain price tracking, LRU-bounded storage,
 * discrepancy detection, and token pair normalization.
 *
 * @see shared/core/src/cross-chain-price-tracker.ts
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

import {
  CrossChainPriceTracker,
  createCrossChainPriceTracker,
} from '../../src/path-finding/cross-chain-price-tracker';
import type {
  PriceTrackerLogger,
  TokenNormalizeFn,
  CrossChainDiscrepancy,
} from '../../src/path-finding/cross-chain-price-tracker';

// =============================================================================
// Helpers
// =============================================================================

function createMockPriceLogger(): PriceTrackerLogger {
  return {
    debug: jest.fn(),
    warn: jest.fn(),
  };
}

/** Simple normalizer that strips .e suffix and maps ETH -> WETH */
const defaultNormalizer: TokenNormalizeFn = (symbol: string) => {
  let normalized = symbol.replace(/\.e$/i, '');
  if (normalized === 'ETH') normalized = 'WETH';
  return normalized;
};

// =============================================================================
// CrossChainPriceTracker
// =============================================================================

describe('CrossChainPriceTracker', () => {
  let tracker: CrossChainPriceTracker;
  let mockLogger: PriceTrackerLogger;

  beforeEach(() => {
    mockLogger = createMockPriceLogger();
    tracker = new CrossChainPriceTracker({}, mockLogger, defaultNormalizer);
  });

  // ===========================================================================
  // Chain Management
  // ===========================================================================

  describe('initializeChain', () => {
    it('should initialize a new chain', () => {
      tracker.initializeChain('ethereum');

      const stats = tracker.getStats();
      expect(stats.chainCount).toBe(1);
      expect(stats.perChainStats.get('ethereum')).toBe(0);
    });

    it('should not reinitialize an already-initialized chain', () => {
      tracker.initializeChain('bsc');
      tracker.updatePrice('bsc', 'WETH_USDT', 2000);

      // Re-initialize should not clear existing data
      tracker.initializeChain('bsc');

      const price = tracker.getPrice('bsc', 'WETH_USDT');
      expect(price).toBeDefined();
      expect(price!.price).toBe(2000);
    });

    it('should log on initialization', () => {
      tracker.initializeChain('polygon');
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Initialized price tracking for chain',
        { chainId: 'polygon' }
      );
    });
  });

  describe('removeChain', () => {
    it('should remove a chain and its data', () => {
      tracker.initializeChain('ethereum');
      tracker.updatePrice('ethereum', 'WETH_USDT', 2000);

      tracker.removeChain('ethereum');

      const stats = tracker.getStats();
      expect(stats.chainCount).toBe(0);
      expect(tracker.getPrice('ethereum', 'WETH_USDT')).toBeUndefined();
    });

    it('should be safe to remove a non-existent chain', () => {
      expect(() => tracker.removeChain('nonexistent')).not.toThrow();
    });
  });

  describe('clear', () => {
    it('should clear all chain data', () => {
      tracker.initializeChain('ethereum');
      tracker.initializeChain('bsc');
      tracker.updatePrice('ethereum', 'WETH_USDT', 2000);
      tracker.updatePrice('bsc', 'WETH_USDT', 2001);

      tracker.clear();

      const stats = tracker.getStats();
      expect(stats.chainCount).toBe(0);
      expect(stats.totalPrices).toBe(0);
    });
  });

  // ===========================================================================
  // Price Updates
  // ===========================================================================

  describe('updatePrice', () => {
    it('should store a price for an initialized chain', () => {
      tracker.initializeChain('ethereum');
      tracker.updatePrice('ethereum', 'WETH_USDT', 2000);

      const price = tracker.getPrice('ethereum', 'WETH_USDT');
      expect(price).toBeDefined();
      expect(price!.price).toBe(2000);
      expect(price!.timestamp).toBeGreaterThan(0);
    });

    it('should warn when updating price for uninitialized chain', () => {
      tracker.updatePrice('unknown', 'WETH_USDT', 2000);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Cannot update price: chain not initialized',
        { chainId: 'unknown' }
      );
    });

    it('should overwrite existing price for same pair', () => {
      tracker.initializeChain('ethereum');
      tracker.updatePrice('ethereum', 'WETH_USDT', 2000);
      tracker.updatePrice('ethereum', 'WETH_USDT', 2100);

      const price = tracker.getPrice('ethereum', 'WETH_USDT');
      expect(price!.price).toBe(2100);
    });

    it('should track multiple pairs per chain', () => {
      tracker.initializeChain('ethereum');
      tracker.updatePrice('ethereum', 'WETH_USDT', 2000);
      tracker.updatePrice('ethereum', 'WBTC_USDT', 50000);

      const stats = tracker.getStats();
      expect(stats.perChainStats.get('ethereum')).toBe(2);
    });
  });

  // ===========================================================================
  // Price Queries
  // ===========================================================================

  describe('getPrice', () => {
    it('should return undefined for non-existent chain', () => {
      expect(tracker.getPrice('ethereum', 'WETH_USDT')).toBeUndefined();
    });

    it('should return undefined for non-existent pair', () => {
      tracker.initializeChain('ethereum');
      expect(tracker.getPrice('ethereum', 'NONEXIST_PAIR')).toBeUndefined();
    });

    it('should return price point with timestamp', () => {
      tracker.initializeChain('ethereum');
      const before = Date.now();
      tracker.updatePrice('ethereum', 'WETH_USDT', 2000);
      const after = Date.now();

      const price = tracker.getPrice('ethereum', 'WETH_USDT');
      expect(price!.price).toBe(2000);
      expect(price!.timestamp).toBeGreaterThanOrEqual(before);
      expect(price!.timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('getCrossChainPrices', () => {
    it('should return prices for a pair across all chains', () => {
      tracker.initializeChain('ethereum');
      tracker.initializeChain('bsc');
      tracker.initializeChain('polygon');

      tracker.updatePrice('ethereum', 'WETH_USDT', 2000);
      tracker.updatePrice('bsc', 'WETH_USDT', 2005);
      // polygon has no WETH_USDT

      const prices = tracker.getCrossChainPrices('WETH_USDT');
      expect(prices.size).toBe(2);
      expect(prices.get('ethereum')!.price).toBe(2000);
      expect(prices.get('bsc')!.price).toBe(2005);
      expect(prices.has('polygon')).toBe(false);
    });

    it('should return empty map when no chains have the pair', () => {
      tracker.initializeChain('ethereum');
      const prices = tracker.getCrossChainPrices('NONEXIST_PAIR');
      expect(prices.size).toBe(0);
    });
  });

  // ===========================================================================
  // Cross-Chain Discrepancy Detection
  // ===========================================================================

  describe('findCrossChainDiscrepancies', () => {
    it('should detect discrepancy above threshold', () => {
      tracker.initializeChain('ethereum');
      tracker.initializeChain('bsc');

      // 5% difference: (2100 - 2000) / 2000 = 0.05
      tracker.updatePrice('ethereum', 'WETH_USDT', 2000);
      tracker.updatePrice('bsc', 'WETH_USDT', 2100);

      const discrepancies = tracker.findCrossChainDiscrepancies(0.03);

      expect(discrepancies.length).toBe(1);
      expect(discrepancies[0].pairKey).toBe('WETH_USDT');
      expect(discrepancies[0].maxDifference).toBeCloseTo(0.05);
      expect(discrepancies[0].chains).toContain('ethereum');
      expect(discrepancies[0].chains).toContain('bsc');
      expect(discrepancies[0].prices.get('ethereum')).toBe(2000);
      expect(discrepancies[0].prices.get('bsc')).toBe(2100);
    });

    it('should not detect discrepancy below threshold', () => {
      tracker.initializeChain('ethereum');
      tracker.initializeChain('bsc');

      // 0.5% difference
      tracker.updatePrice('ethereum', 'WETH_USDT', 2000);
      tracker.updatePrice('bsc', 'WETH_USDT', 2010);

      const discrepancies = tracker.findCrossChainDiscrepancies(0.02);
      expect(discrepancies.length).toBe(0);
    });

    it('should require at least 2 chains for a discrepancy', () => {
      tracker.initializeChain('ethereum');
      tracker.updatePrice('ethereum', 'WETH_USDT', 2000);

      const discrepancies = tracker.findCrossChainDiscrepancies(0);
      expect(discrepancies.length).toBe(0);
    });

    it('should normalize token pairs for cross-chain matching', () => {
      tracker.initializeChain('ethereum');
      tracker.initializeChain('avalanche');

      // Ethereum uses WETH_USDT, Avalanche uses WETH.e_USDT
      // After normalization both become WETH_USDT
      tracker.updatePrice('ethereum', 'WETH_USDT', 2000);
      tracker.updatePrice('avalanche', 'WETH.e_USDT', 2100);

      const discrepancies = tracker.findCrossChainDiscrepancies(0.03);

      expect(discrepancies.length).toBe(1);
      expect(discrepancies[0].pairKey).toBe('WETH_USDT');
    });

    it('should handle ETH -> WETH normalization', () => {
      tracker.initializeChain('ethereum');
      tracker.initializeChain('bsc');

      tracker.updatePrice('ethereum', 'WETH_USDT', 2000);
      tracker.updatePrice('bsc', 'ETH_USDT', 2200);

      const discrepancies = tracker.findCrossChainDiscrepancies(0.05);

      expect(discrepancies.length).toBe(1);
      expect(discrepancies[0].pairKey).toBe('WETH_USDT');
    });

    it('should skip pairs where min price is 0', () => {
      tracker.initializeChain('ethereum');
      tracker.initializeChain('bsc');

      tracker.updatePrice('ethereum', 'WETH_USDT', 0);
      tracker.updatePrice('bsc', 'WETH_USDT', 2000);

      const discrepancies = tracker.findCrossChainDiscrepancies(0);
      expect(discrepancies.length).toBe(0);
    });

    it('should detect multiple discrepancies across different pairs', () => {
      tracker.initializeChain('ethereum');
      tracker.initializeChain('bsc');

      tracker.updatePrice('ethereum', 'WETH_USDT', 2000);
      tracker.updatePrice('bsc', 'WETH_USDT', 2200);

      tracker.updatePrice('ethereum', 'WBTC_USDT', 50000);
      tracker.updatePrice('bsc', 'WBTC_USDT', 55000);

      const discrepancies = tracker.findCrossChainDiscrepancies(0.05);

      expect(discrepancies.length).toBe(2);
      const pairKeys = discrepancies.map(d => d.pairKey);
      expect(pairKeys).toContain('WETH_USDT');
      expect(pairKeys).toContain('WBTC_USDT');
    });

    it('should include timestamp on discrepancies', () => {
      tracker.initializeChain('ethereum');
      tracker.initializeChain('bsc');

      tracker.updatePrice('ethereum', 'WETH_USDT', 2000);
      tracker.updatePrice('bsc', 'WETH_USDT', 2200);

      const before = Date.now();
      const discrepancies = tracker.findCrossChainDiscrepancies(0.05);
      const after = Date.now();

      expect(discrepancies[0].timestamp).toBeGreaterThanOrEqual(before);
      expect(discrepancies[0].timestamp).toBeLessThanOrEqual(after);
    });

    it('should handle three or more chains', () => {
      tracker.initializeChain('ethereum');
      tracker.initializeChain('bsc');
      tracker.initializeChain('polygon');

      tracker.updatePrice('ethereum', 'WETH_USDT', 2000);
      tracker.updatePrice('bsc', 'WETH_USDT', 2200);
      tracker.updatePrice('polygon', 'WETH_USDT', 2050);

      const discrepancies = tracker.findCrossChainDiscrepancies(0.05);

      expect(discrepancies.length).toBe(1);
      // Max difference is (2200 - 2000) / 2000 = 0.1
      expect(discrepancies[0].maxDifference).toBeCloseTo(0.1);
      expect(discrepancies[0].chains.length).toBe(3);
    });
  });

  // ===========================================================================
  // Token Pair Normalization
  // ===========================================================================

  describe('normalizeTokenPair', () => {
    it('should normalize simple TOKEN0_TOKEN1 format', () => {
      expect(tracker.normalizeTokenPair('WETH_USDT')).toBe('WETH_USDT');
    });

    it('should normalize DEX_TOKEN0_TOKEN1 format (strips DEX prefix)', () => {
      expect(tracker.normalizeTokenPair('UNISWAP_WETH_USDT')).toBe('WETH_USDT');
    });

    it('should apply normalizeToken function to each token', () => {
      // ETH -> WETH via the normalizer
      expect(tracker.normalizeTokenPair('ETH_USDT')).toBe('WETH_USDT');
    });

    it('should handle Avalanche .e suffix', () => {
      expect(tracker.normalizeTokenPair('WETH.e_USDT')).toBe('WETH_USDT');
    });

    it('should return input as-is if no separator', () => {
      expect(tracker.normalizeTokenPair('WETH')).toBe('WETH');
    });

    it('should cache normalized pairs', () => {
      // Call twice - second call should hit cache
      const first = tracker.normalizeTokenPair('WETH_USDT');
      const second = tracker.normalizeTokenPair('WETH_USDT');
      expect(first).toBe(second);
    });

    it('should evict cache entries when cache is full', () => {
      // Use a small cache
      const smallTracker = new CrossChainPriceTracker(
        { maxNormalizedPairCacheSize: 4 },
        mockLogger,
        defaultNormalizer,
      );

      // Fill the cache
      smallTracker.normalizeTokenPair('A_B');
      smallTracker.normalizeTokenPair('C_D');
      smallTracker.normalizeTokenPair('E_F');
      smallTracker.normalizeTokenPair('G_H');

      // This should trigger eviction of half (2 entries)
      smallTracker.normalizeTokenPair('I_J');

      // Should still work correctly after eviction
      expect(smallTracker.normalizeTokenPair('I_J')).toBe('I_J');
      expect(smallTracker.normalizeTokenPair('A_B')).toBe('A_B');
    });
  });

  // ===========================================================================
  // Statistics
  // ===========================================================================

  describe('getStats', () => {
    it('should return zero stats when empty', () => {
      const stats = tracker.getStats();
      expect(stats.chainCount).toBe(0);
      expect(stats.totalPrices).toBe(0);
      expect(stats.perChainStats.size).toBe(0);
    });

    it('should return correct stats after adding data', () => {
      tracker.initializeChain('ethereum');
      tracker.initializeChain('bsc');

      tracker.updatePrice('ethereum', 'WETH_USDT', 2000);
      tracker.updatePrice('ethereum', 'WBTC_USDT', 50000);
      tracker.updatePrice('bsc', 'WETH_USDT', 2001);

      const stats = tracker.getStats();
      expect(stats.chainCount).toBe(2);
      expect(stats.totalPrices).toBe(3);
      expect(stats.perChainStats.get('ethereum')).toBe(2);
      expect(stats.perChainStats.get('bsc')).toBe(1);
    });

    it('should reflect chain removal', () => {
      tracker.initializeChain('ethereum');
      tracker.updatePrice('ethereum', 'WETH_USDT', 2000);

      tracker.removeChain('ethereum');

      const stats = tracker.getStats();
      expect(stats.chainCount).toBe(0);
      expect(stats.totalPrices).toBe(0);
    });
  });

  // ===========================================================================
  // LRU Bounded Memory
  // ===========================================================================

  describe('bounded memory via LRU', () => {
    it('should respect maxPricesPerChain limit', () => {
      const boundedTracker = new CrossChainPriceTracker(
        { maxPricesPerChain: 3 },
        mockLogger,
        defaultNormalizer,
      );

      boundedTracker.initializeChain('ethereum');

      // Add 5 prices to a chain with max 3
      boundedTracker.updatePrice('ethereum', 'A_B', 100);
      boundedTracker.updatePrice('ethereum', 'C_D', 200);
      boundedTracker.updatePrice('ethereum', 'E_F', 300);
      boundedTracker.updatePrice('ethereum', 'G_H', 400);
      boundedTracker.updatePrice('ethereum', 'I_J', 500);

      const stats = boundedTracker.getStats();
      // LRU cache should have evicted oldest entries
      expect(stats.perChainStats.get('ethereum')).toBe(3);

      // Oldest entries (A_B, C_D) should be evicted
      expect(boundedTracker.getPrice('ethereum', 'A_B')).toBeUndefined();
      expect(boundedTracker.getPrice('ethereum', 'C_D')).toBeUndefined();

      // Newest entries should still exist
      expect(boundedTracker.getPrice('ethereum', 'E_F')).toBeDefined();
      expect(boundedTracker.getPrice('ethereum', 'G_H')).toBeDefined();
      expect(boundedTracker.getPrice('ethereum', 'I_J')).toBeDefined();
    });
  });
});

// =============================================================================
// createCrossChainPriceTracker() factory function
// =============================================================================

describe('createCrossChainPriceTracker', () => {
  it('should create a functional tracker instance', () => {
    const logger = createMockPriceLogger();
    const tracker = createCrossChainPriceTracker({}, logger, defaultNormalizer);

    expect(tracker).toBeInstanceOf(CrossChainPriceTracker);

    tracker.initializeChain('ethereum');
    tracker.updatePrice('ethereum', 'WETH_USDT', 2000);
    expect(tracker.getPrice('ethereum', 'WETH_USDT')!.price).toBe(2000);
  });

  it('should accept custom config', () => {
    const logger = createMockPriceLogger();
    const tracker = createCrossChainPriceTracker(
      { maxPricesPerChain: 10 },
      logger,
      defaultNormalizer,
    );

    expect(tracker).toBeInstanceOf(CrossChainPriceTracker);
  });
});
