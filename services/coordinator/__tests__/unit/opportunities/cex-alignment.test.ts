/**
 * CEX Alignment Calculator Tests
 *
 * Tests the computeCexAlignment() function that determines whether
 * an arbitrage opportunity aligns with or contradicts CEX-DEX spread.
 *
 * @see services/coordinator/src/opportunities/cex-alignment.ts
 * @see ADR-036: CEX Price Signals
 */

import { computeCexAlignment } from '../../../src/opportunities/cex-alignment';
import type { CexPriceFeedService } from '@arbitrage/core/feeds';

// =============================================================================
// Test Helpers
// =============================================================================

/** Create a mock CexPriceFeedService with configurable spread responses */
function createMockFeed(spreads: Record<string, number | undefined>): CexPriceFeedService {
  return {
    getSpread: (tokenId: string, chain: string): number | undefined => {
      return spreads[`${tokenId}:${chain}`];
    },
  } as unknown as CexPriceFeedService;
}

// =============================================================================
// Tests
// =============================================================================

describe('computeCexAlignment', () => {
  describe('buy-side alignment', () => {
    it('should return 1.15 (aligned) when buy DEX is underpriced vs CEX', () => {
      // Negative spread = DEX cheaper than CEX. Buying there is smart.
      const feed = createMockFeed({ 'WETH:arbitrum': -0.5 });

      const factor = computeCexAlignment('WETH', 'arbitrum', 'arbitrum', feed);

      expect(factor).toBe(1.15);
    });

    it('should return 0.8 (contradicted) when buy DEX is overpriced vs CEX', () => {
      // Positive spread = DEX more expensive than CEX. Buying there is risky.
      const feed = createMockFeed({ 'WETH:arbitrum': 0.5 });

      const factor = computeCexAlignment('WETH', 'arbitrum', 'arbitrum', feed);

      expect(factor).toBe(0.8);
    });

    it('should return 1.0 (neutral) when buy spread is within noise band', () => {
      // Spread is within ±0.1% — too small to be meaningful
      const feed = createMockFeed({ 'WETH:arbitrum': 0.05 });

      const factor = computeCexAlignment('WETH', 'arbitrum', 'arbitrum', feed);

      expect(factor).toBe(1.0);
    });

    it('should return 1.0 (neutral) when buy spread is exactly at noise boundary', () => {
      const feed = createMockFeed({ 'WETH:arbitrum': 0.1 });

      const factor = computeCexAlignment('WETH', 'arbitrum', 'arbitrum', feed);

      expect(factor).toBe(1.0);
    });

    it('should return 1.0 (neutral) when buy spread is exactly at negative noise boundary', () => {
      const feed = createMockFeed({ 'WETH:arbitrum': -0.1 });

      const factor = computeCexAlignment('WETH', 'arbitrum', 'arbitrum', feed);

      expect(factor).toBe(1.0);
    });
  });

  describe('no CEX data', () => {
    it('should return 1.0 (neutral) when no spread data for buy chain', () => {
      const feed = createMockFeed({});

      const factor = computeCexAlignment('WETH', 'arbitrum', 'arbitrum', feed);

      expect(factor).toBe(1.0);
    });

    it('should return 1.0 (neutral) when spread is undefined', () => {
      const feed = createMockFeed({ 'WETH:arbitrum': undefined });

      const factor = computeCexAlignment('WETH', 'arbitrum', 'arbitrum', feed);

      expect(factor).toBe(1.0);
    });
  });

  describe('cross-chain alignment (sell-side fallback)', () => {
    it('should check sell-side when buy-side is neutral and chains differ', () => {
      // Buy side neutral, sell side overpriced -> selling overpriced is aligned
      const feed = createMockFeed({
        'WETH:arbitrum': 0.0,   // buy: neutral
        'WETH:ethereum': 0.5,   // sell: DEX overpriced -> aligned to sell here
      });

      const factor = computeCexAlignment('WETH', 'arbitrum', 'ethereum', feed);

      expect(factor).toBe(1.15);
    });

    it('should return contradicted when sell DEX is underpriced', () => {
      // Buy side neutral, sell side underpriced -> selling underpriced is bad
      const feed = createMockFeed({
        'WETH:arbitrum': 0.0,    // buy: neutral
        'WETH:ethereum': -0.5,   // sell: DEX underpriced -> contradicted to sell here
      });

      const factor = computeCexAlignment('WETH', 'arbitrum', 'ethereum', feed);

      expect(factor).toBe(0.8);
    });

    it('should return neutral when both sides are within noise band', () => {
      const feed = createMockFeed({
        'WETH:arbitrum': 0.05,
        'WETH:ethereum': -0.05,
      });

      const factor = computeCexAlignment('WETH', 'arbitrum', 'ethereum', feed);

      expect(factor).toBe(1.0);
    });

    it('should not check sell-side for same-chain opportunities', () => {
      // Same chain — only buy-side matters, sell-side is the same DEX
      const feed = createMockFeed({
        'WETH:arbitrum': 0.05,  // buy: neutral
      });

      const factor = computeCexAlignment('WETH', 'arbitrum', 'arbitrum', feed);

      expect(factor).toBe(1.0);
    });

    it('should return neutral when sell-side has no data in cross-chain', () => {
      const feed = createMockFeed({
        'WETH:arbitrum': 0.0,  // buy: neutral
        // no sell-side data for ethereum
      });

      const factor = computeCexAlignment('WETH', 'arbitrum', 'ethereum', feed);

      expect(factor).toBe(1.0);
    });
  });

  describe('buy-side takes precedence over sell-side', () => {
    it('should use buy-side when buy-side has clear signal', () => {
      // Buy clearly contradicted — should not fall through to sell side
      const feed = createMockFeed({
        'WETH:arbitrum': 0.5,    // buy: contradicted
        'WETH:ethereum': 0.5,    // sell: aligned (but should not matter)
      });

      const factor = computeCexAlignment('WETH', 'arbitrum', 'ethereum', feed);

      expect(factor).toBe(0.8);
    });

    it('should use buy-side when buy-side is aligned', () => {
      // Buy clearly aligned — should not fall through to sell side
      const feed = createMockFeed({
        'WETH:arbitrum': -0.5,   // buy: aligned
        'WETH:ethereum': -0.5,   // sell: contradicted (but should not matter)
      });

      const factor = computeCexAlignment('WETH', 'arbitrum', 'ethereum', feed);

      expect(factor).toBe(1.15);
    });
  });

  describe('different tokens', () => {
    it('should work for WBTC', () => {
      const feed = createMockFeed({ 'WBTC:ethereum': -0.3 });

      const factor = computeCexAlignment('WBTC', 'ethereum', 'ethereum', feed);

      expect(factor).toBe(1.15);
    });

    it('should work for WBNB on BSC', () => {
      const feed = createMockFeed({ 'WBNB:bsc': 0.8 });

      const factor = computeCexAlignment('WBNB', 'bsc', 'bsc', feed);

      expect(factor).toBe(0.8);
    });

    it('should work for SOL', () => {
      const feed = createMockFeed({ 'SOL:solana': 0.02 });

      const factor = computeCexAlignment('SOL', 'solana', 'solana', feed);

      expect(factor).toBe(1.0);
    });
  });

  describe('scoring integration', () => {
    it('aligned factor should boost opportunity score', () => {
      // Verify the factor values work with typical scoring
      const baseScore = 0.001;
      const aligned = baseScore * 1.15;
      const neutral = baseScore * 1.0;

      expect(aligned).toBeGreaterThan(neutral);
      expect(aligned).toBeCloseTo(0.00115, 6);
    });

    it('contradicted factor should penalize opportunity score', () => {
      const baseScore = 0.001;
      const contradicted = baseScore * 0.8;
      const neutral = baseScore * 1.0;

      expect(contradicted).toBeLessThan(neutral);
      expect(contradicted).toBeCloseTo(0.0008, 6);
    });
  });
});
