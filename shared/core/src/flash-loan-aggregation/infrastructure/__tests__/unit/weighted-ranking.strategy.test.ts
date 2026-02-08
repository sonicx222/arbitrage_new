/**
 * Weighted Ranking Strategy Tests
 *
 * Tests for the default provider ranking implementation.
 * Verifies weighted scoring, component calculations, and ranking order.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { WeightedRankingStrategy } from '../../weighted-ranking.strategy';
import { AggregatorConfig } from '../../../domain/models';
import type { IProviderInfo, IRankingContext } from '../../../domain';

describe('WeightedRankingStrategy', () => {
  let strategy: WeightedRankingStrategy;
  let config: AggregatorConfig;
  let context: IRankingContext;

  beforeEach(() => {
    config = AggregatorConfig.default();
    strategy = new WeightedRankingStrategy(config);

    context = {
      chain: 'ethereum',
      reliabilityScores: new Map([
        ['aave_v3', 0.95],
        ['pancakeswap_v3', 0.85],
      ]),
      latencyHistory: new Map(),
      liquidityEstimates: new Map(),
    };
  });

  describe('rankProviders', () => {
    it('should rank providers by total score', async () => {
      const providers: IProviderInfo[] = [
        {
          protocol: 'pancakeswap_v3',
          chain: 'ethereum',
          feeBps: 25, // 0.25%, higher fee
          isAvailable: true,
          poolAddress: '0x123',
        },
        {
          protocol: 'aave_v3',
          chain: 'ethereum',
          feeBps: 9, // 0.09%, lower fee
          isAvailable: true,
          poolAddress: '0x456',
        },
      ];

      const ranked = await strategy.rankProviders(providers, 1000000n, context);

      expect(ranked).toHaveLength(2);
      // Aave V3 should rank higher (lower fees, higher reliability)
      expect(ranked[0].provider.protocol).toBe('aave_v3');
      expect(ranked[1].provider.protocol).toBe('pancakeswap_v3');
      expect(ranked[0].score.totalScore).toBeGreaterThan(ranked[1].score.totalScore);
    });

    it('should skip unavailable providers', async () => {
      const providers: IProviderInfo[] = [
        {
          protocol: 'aave_v3',
          chain: 'ethereum',
          feeBps: 9,
          isAvailable: false, // Not available
          poolAddress: '0x123',
        },
        {
          protocol: 'pancakeswap_v3',
          chain: 'ethereum',
          feeBps: 25,
          isAvailable: true,
          poolAddress: '0x456',
        },
      ];

      const ranked = await strategy.rankProviders(providers, 1000000n, context);

      expect(ranked).toHaveLength(1);
      expect(ranked[0].provider.protocol).toBe('pancakeswap_v3');
    });

    it('should limit results to maxProvidersToRank', async () => {
      const smallConfig = AggregatorConfig.create({ maxProvidersToRank: 2 });
      const smallStrategy = new WeightedRankingStrategy(smallConfig);

      const providers: IProviderInfo[] = [
        { protocol: 'aave_v3', chain: 'ethereum', feeBps: 9, isAvailable: true, poolAddress: '0x1' },
        { protocol: 'pancakeswap_v3', chain: 'ethereum', feeBps: 25, isAvailable: true, poolAddress: '0x2' },
        { protocol: 'spookyswap', chain: 'ethereum', feeBps: 30, isAvailable: true, poolAddress: '0x3' },
        { protocol: 'syncswap', chain: 'ethereum', feeBps: 35, isAvailable: true, poolAddress: '0x4' },
      ];

      const ranked = await smallStrategy.rankProviders(providers, 1000000n, context);

      expect(ranked).toHaveLength(2); // Limited to 2
    });

    it('should handle empty providers list', async () => {
      const ranked = await strategy.rankProviders([], 1000000n, context);

      expect(ranked).toHaveLength(0);
    });

    it('should handle provider scoring failure gracefully', async () => {
      const providers: IProviderInfo[] = [
        {
          protocol: 'aave_v3',
          chain: 'ethereum',
          feeBps: 9,
          isAvailable: true,
          poolAddress: '0x123',
        },
        {
          protocol: 'invalid_protocol' as any,
          chain: 'ethereum',
          feeBps: 9,
          isAvailable: true,
          poolAddress: '0x456',
        },
      ];

      // Should not throw, but may skip invalid provider
      const ranked = await strategy.rankProviders(providers, 1000000n, context);

      expect(ranked.length).toBeGreaterThanOrEqual(1);
      expect(ranked[0].provider.protocol).toBe('aave_v3');
    });
  });

  describe('calculateFeeScore', () => {
    it('should give perfect score for 0 bps fee', async () => {
      const providers: IProviderInfo[] = [
        {
          protocol: 'aave_v3',
          chain: 'ethereum',
          feeBps: 0,
          isAvailable: true,
          poolAddress: '0x123',
        },
      ];

      const ranked = await strategy.rankProviders(providers, 1000000n, context);

      expect(ranked[0].score.feeScore).toBe(1.0);
    });

    it('should score 9 bps as 0.91', async () => {
      const providers: IProviderInfo[] = [
        {
          protocol: 'aave_v3',
          chain: 'ethereum',
          feeBps: 9,
          isAvailable: true,
          poolAddress: '0x123',
        },
      ];

      const ranked = await strategy.rankProviders(providers, 1000000n, context);

      expect(ranked[0].score.feeScore).toBeCloseTo(0.91, 2);
    });

    it('should score 25 bps as 0.75', async () => {
      const providers: IProviderInfo[] = [
        {
          protocol: 'pancakeswap_v3',
          chain: 'ethereum',
          feeBps: 25,
          isAvailable: true,
          poolAddress: '0x123',
        },
      ];

      const ranked = await strategy.rankProviders(providers, 1000000n, context);

      expect(ranked[0].score.feeScore).toBe(0.75);
    });

    it('should cap fee score at 0 for 100+ bps', async () => {
      const providers: IProviderInfo[] = [
        {
          protocol: 'high_fee' as any,
          chain: 'ethereum',
          feeBps: 150,
          isAvailable: true,
          poolAddress: '0x123',
        },
      ];

      const ranked = await strategy.rankProviders(providers, 1000000n, context);

      expect(ranked[0].score.feeScore).toBe(0);
    });
  });

  describe('calculateLiquidityScore', () => {
    it('should return 1.0 with no liquidity estimate', async () => {
      const providers: IProviderInfo[] = [
        {
          protocol: 'aave_v3',
          chain: 'ethereum',
          feeBps: 9,
          isAvailable: true,
          poolAddress: '0x123',
        },
      ];

      const ranked = await strategy.rankProviders(providers, 1000000n, context);

      expect(ranked[0].score.liquidityScore).toBe(1.0);
    });

    it('should return 1.0 for 2x+ liquidity', async () => {
      const contextWithLiquidity: IRankingContext = {
        ...context,
        liquidityEstimates: new Map([['aave_v3', 2200000n]]), // 2.2x required (with 10% margin)
      };

      const providers: IProviderInfo[] = [
        {
          protocol: 'aave_v3',
          chain: 'ethereum',
          feeBps: 9,
          isAvailable: true,
          poolAddress: '0x123',
        },
      ];

      const ranked = await strategy.rankProviders(providers, 1000000n, contextWithLiquidity);

      expect(ranked[0].score.liquidityScore).toBe(1.0);
    });

    it('should return 0.9 for adequate liquidity (>= 1.1x)', async () => {
      const contextWithLiquidity: IRankingContext = {
        ...context,
        liquidityEstimates: new Map([['aave_v3', 1100001n]]), // Just above 1.1x
      };

      const providers: IProviderInfo[] = [
        {
          protocol: 'aave_v3',
          chain: 'ethereum',
          feeBps: 9,
          isAvailable: true,
          poolAddress: '0x123',
        },
      ];

      const ranked = await strategy.rankProviders(providers, 1000000n, contextWithLiquidity);

      expect(ranked[0].score.liquidityScore).toBe(0.9);
    });

    it('should return 0.7 for just enough liquidity', async () => {
      const contextWithLiquidity: IRankingContext = {
        ...context,
        liquidityEstimates: new Map([['aave_v3', 1050000n]]), // Between 1x and 1.1x
      };

      const providers: IProviderInfo[] = [
        {
          protocol: 'aave_v3',
          chain: 'ethereum',
          feeBps: 9,
          isAvailable: true,
          poolAddress: '0x123',
        },
      ];

      const ranked = await strategy.rankProviders(providers, 1000000n, contextWithLiquidity);

      expect(ranked[0].score.liquidityScore).toBe(0.7);
    });

    it('should return 0.3 for insufficient liquidity', async () => {
      const contextWithLiquidity: IRankingContext = {
        ...context,
        liquidityEstimates: new Map([['aave_v3', 900000n]]), // Less than required
      };

      const providers: IProviderInfo[] = [
        {
          protocol: 'aave_v3',
          chain: 'ethereum',
          feeBps: 9,
          isAvailable: true,
          poolAddress: '0x123',
        },
      ];

      const ranked = await strategy.rankProviders(providers, 1000000n, contextWithLiquidity);

      expect(ranked[0].score.liquidityScore).toBe(0.3);
    });
  });

  describe('calculateReliabilityScore', () => {
    it('should use reliability score from context', async () => {
      const providers: IProviderInfo[] = [
        {
          protocol: 'aave_v3',
          chain: 'ethereum',
          feeBps: 9,
          isAvailable: true,
          poolAddress: '0x123',
        },
      ];

      const ranked = await strategy.rankProviders(providers, 1000000n, context);

      expect(ranked[0].score.reliabilityScore).toBe(0.95);
    });

    it('should default to 1.0 if no data available', async () => {
      const emptyContext: IRankingContext = {
        chain: 'ethereum',
        reliabilityScores: new Map(),
        latencyHistory: new Map(),
        liquidityEstimates: new Map(),
      };

      const providers: IProviderInfo[] = [
        {
          protocol: 'aave_v3',
          chain: 'ethereum',
          feeBps: 9,
          isAvailable: true,
          poolAddress: '0x123',
        },
      ];

      const ranked = await strategy.rankProviders(providers, 1000000n, emptyContext);

      expect(ranked[0].score.reliabilityScore).toBe(1.0);
    });
  });

  describe('calculateLatencyScore', () => {
    it('should use historical latency data if available', async () => {
      const contextWithLatency: IRankingContext = {
        ...context,
        latencyHistory: new Map([['aave_v3', [50, 60, 70, 80, 90]]]),
      };

      const providers: IProviderInfo[] = [
        {
          protocol: 'aave_v3',
          chain: 'ethereum',
          feeBps: 9,
          isAvailable: true,
          poolAddress: '0x123',
        },
      ];

      const ranked = await strategy.rankProviders(providers, 1000000n, contextWithLatency);

      // P95 of [50, 60, 70, 80, 90] should be 90ms, score should be 1.0 (<100ms)
      expect(ranked[0].score.latencyScore).toBe(1.0);
    });

    it('should use protocol defaults for aave_v3', async () => {
      const providers: IProviderInfo[] = [
        {
          protocol: 'aave_v3',
          chain: 'ethereum',
          feeBps: 9,
          isAvailable: true,
          poolAddress: '0x123',
        },
      ];

      const ranked = await strategy.rankProviders(providers, 1000000n, context);

      expect(ranked[0].score.latencyScore).toBe(0.95);
    });

    it('should use protocol defaults for pancakeswap_v3', async () => {
      const providers: IProviderInfo[] = [
        {
          protocol: 'pancakeswap_v3',
          chain: 'ethereum',
          feeBps: 25,
          isAvailable: true,
          poolAddress: '0x123',
        },
      ];

      const ranked = await strategy.rankProviders(providers, 1000000n, context);

      expect(ranked[0].score.latencyScore).toBe(0.85);
    });

    it('should use conservative default for unknown protocols', async () => {
      const providers: IProviderInfo[] = [
        {
          protocol: 'unknown_protocol' as any,
          chain: 'ethereum',
          feeBps: 30,
          isAvailable: true,
          poolAddress: '0x123',
        },
      ];

      const ranked = await strategy.rankProviders(providers, 1000000n, context);

      expect(ranked[0].score.latencyScore).toBe(0.75);
    });
  });

  describe('getStrategyName', () => {
    it('should return "weighted"', () => {
      expect(strategy.getStrategyName()).toBe('weighted');
    });
  });

  describe('getWeights', () => {
    it('should return config weights', () => {
      const weights = strategy.getWeights();

      expect(weights.fees).toBe(0.5);
      expect(weights.liquidity).toBe(0.3);
      expect(weights.reliability).toBe(0.15);
      expect(weights.latency).toBe(0.05);
    });

    it('should return immutable weights', () => {
      const weights = strategy.getWeights();

      expect(() => {
        (weights as any).fees = 0.6;
      }).not.toThrow(); // Returns copy, not original

      // Original should still be 0.5
      expect(strategy.getWeights().fees).toBe(0.5);
    });
  });

  describe('weighted scoring', () => {
    it('should apply correct weights to total score', async () => {
      const providers: IProviderInfo[] = [
        {
          protocol: 'aave_v3',
          chain: 'ethereum',
          feeBps: 9,
          isAvailable: true,
          poolAddress: '0x123',
        },
      ];

      const ranked = await strategy.rankProviders(providers, 1000000n, context);

      const score = ranked[0].score;
      const expectedTotal =
        score.feeScore * 0.5 +
        score.liquidityScore * 0.3 +
        score.reliabilityScore * 0.15 +
        score.latencyScore * 0.05;

      expect(score.totalScore).toBeCloseTo(expectedTotal, 5);
    });

    it('should rank by total score with custom weights', async () => {
      // Fee-optimized strategy
      const feeOptimizedConfig = AggregatorConfig.create({
        weights: { fees: 0.8, liquidity: 0.1, reliability: 0.05, latency: 0.05 },
      });
      const feeOptimizedStrategy = new WeightedRankingStrategy(feeOptimizedConfig);

      const providers: IProviderInfo[] = [
        {
          protocol: 'pancakeswap_v3',
          chain: 'ethereum',
          feeBps: 25,
          isAvailable: true,
          poolAddress: '0x123',
        },
        {
          protocol: 'aave_v3',
          chain: 'ethereum',
          feeBps: 9,
          isAvailable: true,
          poolAddress: '0x456',
        },
      ];

      const ranked = await feeOptimizedStrategy.rankProviders(providers, 1000000n, context);

      // With fee-optimized weights, Aave should still be first (lower fees)
      expect(ranked[0].provider.protocol).toBe('aave_v3');
      // But the score difference should be larger
      expect(ranked[0].score.totalScore - ranked[1].score.totalScore).toBeGreaterThan(0.1);
    });
  });
});
