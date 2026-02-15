/**
 * FlashLoanAggregatorImpl Tests
 *
 * Tests for the main orchestrator that coordinates provider ranking,
 * liquidity validation, caching, and fallback decisions.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { FlashLoanAggregatorImpl } from '../../flashloan-aggregator.impl';
import {
  AggregatorConfig,
  ProviderScore,
  LiquidityCheck,
  ProviderSelection,
} from '../../../domain/models';
import type {
  IProviderRanker,
  ILiquidityValidator,
  IAggregatorMetrics,
  IProviderInfo,
  IRankedProvider,
  IRankingContext,
  ILiquidityContext,
} from '../../../domain';
import type { ArbitrageOpportunity } from '@arbitrage/types';

describe('FlashLoanAggregatorImpl', () => {
  let aggregator: FlashLoanAggregatorImpl;
  let config: AggregatorConfig;
  let mockRanker: jest.Mocked<IProviderRanker>;
  let mockLiquidityValidator: jest.Mocked<ILiquidityValidator>;
  let mockMetrics: jest.Mocked<IAggregatorMetrics>;

  const aaveProvider: IProviderInfo = {
    protocol: 'aave_v3',
    chain: 'ethereum',
    feeBps: 9,
    isAvailable: true,
    poolAddress: '0xAavePool',
  };

  const pancakeProvider: IProviderInfo = {
    protocol: 'pancakeswap_v3',
    chain: 'ethereum',
    feeBps: 25,
    isAvailable: true,
    poolAddress: '0xPancakePool',
  };

  const unavailableProvider: IProviderInfo = {
    ...aaveProvider,
    isAvailable: false,
  };

  const aaveScore = new ProviderScore(0.91, 0.7, 0.95, 0.95, 0.856);
  const pancakeScore = new ProviderScore(0.75, 0.7, 0.85, 0.85, 0.762);

  const defaultOpportunity: ArbitrageOpportunity = {
    id: 'test-opp-1',
    chain: 'ethereum',
    tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    amountIn: '1000000000000000000', // 1 ETH
    expectedProfit: 500,
    buyPrice: 0,
    sellPrice: 0,
    confidence: 0.9,
    timestamp: Date.now(),
  };

  const defaultContext = {
    chain: 'ethereum',
    estimatedValueUsd: 500,
  };

  const highValueContext = {
    chain: 'ethereum',
    estimatedValueUsd: 200000, // Above $100K threshold
    rpcProviders: new Map([['ethereum', { call: jest.fn() }]]),
  };

  function createAggregator(
    providers: ReadonlyMap<string, IProviderInfo[]>,
    liquidityValidator: ILiquidityValidator | null = null,
    metrics: IAggregatorMetrics | null = null,
    customConfig?: AggregatorConfig
  ): FlashLoanAggregatorImpl {
    return new FlashLoanAggregatorImpl(
      customConfig ?? config,
      mockRanker,
      liquidityValidator,
      metrics,
      providers
    );
  }

  beforeEach(() => {
    config = AggregatorConfig.default();

    const rankedAave: IRankedProvider = { provider: aaveProvider, score: aaveScore };
    const rankedPancake: IRankedProvider = { provider: pancakeProvider, score: pancakeScore };

    mockRanker = {
      rankProviders: jest.fn<IProviderRanker['rankProviders']>()
        .mockResolvedValue([rankedAave, rankedPancake]),
      getStrategyName: jest.fn<IProviderRanker['getStrategyName']>().mockReturnValue('weighted'),
      getWeights: jest.fn<IProviderRanker['getWeights']>().mockReturnValue(config.weights),
    };

    mockLiquidityValidator = {
      checkLiquidity: jest.fn<ILiquidityValidator['checkLiquidity']>()
        .mockResolvedValue(LiquidityCheck.success(BigInt(2e18), BigInt(1.1e18), 5)),
      estimateLiquidityScore: jest.fn<ILiquidityValidator['estimateLiquidityScore']>()
        .mockResolvedValue(0.9),
      clearCache: jest.fn<ILiquidityValidator['clearCache']>(),
    };

    mockMetrics = {
      recordSelection: jest.fn<IAggregatorMetrics['recordSelection']>(),
      recordOutcome: jest.fn<IAggregatorMetrics['recordOutcome']>(),
      getReliabilityScore: jest.fn<IAggregatorMetrics['getReliabilityScore']>()
        .mockResolvedValue(1.0),
      getProviderHealth: jest.fn<IAggregatorMetrics['getProviderHealth']>().mockReturnValue(null),
      getAggregatedMetrics: jest.fn<IAggregatorMetrics['getAggregatedMetrics']>(),
      getMetricsSummary: jest.fn<IAggregatorMetrics['getMetricsSummary']>(),
      resetMetrics: jest.fn<IAggregatorMetrics['resetMetrics']>(),
    };

    const providers = new Map([['ethereum', [aaveProvider, pancakeProvider]]]);
    aggregator = createAggregator(providers, mockLiquidityValidator, mockMetrics);
  });

  describe('selectProvider', () => {
    describe('no providers', () => {
      it('should return failure when no providers exist for chain', async () => {
        const emptyAggregator = createAggregator(new Map());

        const result = await emptyAggregator.selectProvider(defaultOpportunity, defaultContext);

        expect(result.isSuccess).toBe(false);
        expect(result.selectionReason).toBe('No providers available for chain');
      });

      it('should return failure when providers list is empty for chain', async () => {
        const emptyAggregator = createAggregator(new Map([['ethereum', []]]));

        const result = await emptyAggregator.selectProvider(defaultOpportunity, defaultContext);

        expect(result.isSuccess).toBe(false);
      });

      it('should return failure for unknown chain', async () => {
        const result = await aggregator.selectProvider(defaultOpportunity, {
          chain: 'unknown_chain',
          estimatedValueUsd: 100,
        });

        expect(result.isSuccess).toBe(false);
        expect(result.selectionReason).toBe('No providers available for chain');
      });
    });

    describe('single provider', () => {
      it('should select single available provider without ranking', async () => {
        const singleAggregator = createAggregator(
          new Map([['ethereum', [aaveProvider]]])
        );

        const result = await singleAggregator.selectProvider(defaultOpportunity, defaultContext);

        expect(result.isSuccess).toBe(true);
        expect(result.protocol).toBe('aave_v3');
        expect(result.selectionReason).toBe('Only provider available');
        // Should NOT call ranker for single provider
        expect(mockRanker.rankProviders).not.toHaveBeenCalled();
      });

      it('should create proper ProviderScore for single provider (P0 fix)', async () => {
        const singleAggregator = createAggregator(
          new Map([['ethereum', [aaveProvider]]])
        );

        const result = await singleAggregator.selectProvider(defaultOpportunity, defaultContext);

        // P0 fix: score must be a real ProviderScore instance, not plain object
        expect(result.score).toBeInstanceOf(ProviderScore);
        expect(result.score!.totalScore).toBe(1.0);
        // Verify explain() works (would crash with plain object)
        expect(() => result.score!.explain()).not.toThrow();
      });

      it('should return failure when single provider is unavailable', async () => {
        const singleAggregator = createAggregator(
          new Map([['ethereum', [unavailableProvider]]])
        );

        const result = await singleAggregator.selectProvider(defaultOpportunity, defaultContext);

        expect(result.isSuccess).toBe(false);
        expect(result.selectionReason).toBe('Only provider is unavailable');
      });
    });

    describe('multiple providers', () => {
      it('should select highest ranked provider', async () => {
        const result = await aggregator.selectProvider(defaultOpportunity, defaultContext);

        expect(result.isSuccess).toBe(true);
        expect(result.protocol).toBe('aave_v3');
        expect(result.score!.totalScore).toBe(aaveScore.totalScore);
      });

      it('should include alternatives in selection', async () => {
        const result = await aggregator.selectProvider(defaultOpportunity, defaultContext);

        expect(result.rankedAlternatives.length).toBeGreaterThanOrEqual(1);
      });

      it('should return failure when all providers fail ranking', async () => {
        mockRanker.rankProviders.mockResolvedValue([]);

        const result = await aggregator.selectProvider(defaultOpportunity, defaultContext);

        expect(result.isSuccess).toBe(false);
        expect(result.selectionReason).toBe('All providers failed ranking');
      });

      it('should skip unavailable providers in ranking results', async () => {
        const unavailableRanked: IRankedProvider = {
          provider: { ...aaveProvider, isAvailable: false },
          score: aaveScore,
        };
        const availableRanked: IRankedProvider = {
          provider: pancakeProvider,
          score: pancakeScore,
        };
        mockRanker.rankProviders.mockResolvedValue([unavailableRanked, availableRanked]);

        const result = await aggregator.selectProvider(defaultOpportunity, defaultContext);

        expect(result.isSuccess).toBe(true);
        expect(result.protocol).toBe('pancakeswap_v3');
      });

      it('should return failure when all ranked providers are unavailable', async () => {
        const unavailable1: IRankedProvider = {
          provider: { ...aaveProvider, isAvailable: false },
          score: aaveScore,
        };
        const unavailable2: IRankedProvider = {
          provider: { ...pancakeProvider, isAvailable: false },
          score: pancakeScore,
        };
        mockRanker.rankProviders.mockResolvedValue([unavailable1, unavailable2]);

        const result = await aggregator.selectProvider(defaultOpportunity, defaultContext);

        expect(result.isSuccess).toBe(false);
        expect(result.selectionReason).toBe('All providers failed validation');
      });
    });

    describe('with liquidity checks', () => {
      it('should check liquidity when value exceeds threshold', async () => {
        const result = await aggregator.selectProvider(defaultOpportunity, highValueContext);

        expect(mockLiquidityValidator.checkLiquidity).toHaveBeenCalled();
        expect(result.isSuccess).toBe(true);
        expect(result.liquidityCheck).not.toBeNull();
      });

      it('should skip liquidity check when value below threshold', async () => {
        const result = await aggregator.selectProvider(defaultOpportunity, defaultContext);

        expect(mockLiquidityValidator.checkLiquidity).not.toHaveBeenCalled();
        expect(result.liquidityCheck).toBeNull();
      });

      it('should skip provider when liquidity check fails', async () => {
        mockLiquidityValidator.checkLiquidity.mockResolvedValueOnce(
          LiquidityCheck.failure('RPC timeout', 5000)
        );
        // Second call succeeds (for pancakeswap)
        mockLiquidityValidator.checkLiquidity.mockResolvedValueOnce(
          LiquidityCheck.success(BigInt(2e18), BigInt(1.1e18), 5)
        );

        const result = await aggregator.selectProvider(defaultOpportunity, highValueContext);

        expect(result.isSuccess).toBe(true);
        expect(result.protocol).toBe('pancakeswap_v3');
      });

      it('should skip provider when liquidity is insufficient', async () => {
        mockLiquidityValidator.checkLiquidity.mockResolvedValueOnce(
          LiquidityCheck.success(BigInt(0.5e18), BigInt(1.1e18), 5) // insufficient
        );
        mockLiquidityValidator.checkLiquidity.mockResolvedValueOnce(
          LiquidityCheck.success(BigInt(2e18), BigInt(1.1e18), 5) // sufficient
        );

        const result = await aggregator.selectProvider(defaultOpportunity, highValueContext);

        expect(result.isSuccess).toBe(true);
        expect(result.protocol).toBe('pancakeswap_v3');
      });

      it('should not check liquidity when no validator configured', async () => {
        const noValidatorAggregator = createAggregator(
          new Map([['ethereum', [aaveProvider, pancakeProvider]]]),
          null,
          mockMetrics
        );

        const result = await noValidatorAggregator.selectProvider(
          defaultOpportunity,
          highValueContext
        );

        expect(result.isSuccess).toBe(true);
        expect(result.liquidityCheck).toBeNull();
      });
    });

    describe('metrics recording', () => {
      it('should record selection on success', async () => {
        await aggregator.selectProvider(defaultOpportunity, defaultContext);

        expect(mockMetrics.recordSelection).toHaveBeenCalledWith(
          expect.objectContaining({ protocol: 'aave_v3' }),
          expect.any(String),
          expect.any(Number)
        );
      });

      it('should record selection on failure', async () => {
        const emptyAggregator = createAggregator(new Map(), null, mockMetrics);

        await emptyAggregator.selectProvider(defaultOpportunity, defaultContext);

        expect(mockMetrics.recordSelection).toHaveBeenCalledWith(
          null,
          expect.any(String),
          expect.any(Number)
        );
      });

      it('should work without metrics (null)', async () => {
        const noMetricsAggregator = createAggregator(
          new Map([['ethereum', [aaveProvider, pancakeProvider]]]),
          null,
          null
        );

        const result = await noMetricsAggregator.selectProvider(
          defaultOpportunity,
          defaultContext
        );

        expect(result.isSuccess).toBe(true);
      });
    });

    describe('ranking cache', () => {
      it('should cache ranking results', async () => {
        await aggregator.selectProvider(defaultOpportunity, defaultContext);
        await aggregator.selectProvider(defaultOpportunity, defaultContext);

        // Ranker should only be called once (second call uses cache)
        expect(mockRanker.rankProviders).toHaveBeenCalledTimes(1);
      });

      it('should refresh cache after TTL expires', async () => {
        // Use short TTL config
        const shortTtlConfig = AggregatorConfig.create({ rankingCacheTtlMs: 1 });
        const providers = new Map([['ethereum', [aaveProvider, pancakeProvider]]]);
        const shortTtlAggregator = new FlashLoanAggregatorImpl(
          shortTtlConfig,
          mockRanker,
          null,
          mockMetrics,
          providers
        );

        await shortTtlAggregator.selectProvider(defaultOpportunity, defaultContext);

        // Wait for cache to expire
        await new Promise(resolve => setTimeout(resolve, 10));

        await shortTtlAggregator.selectProvider(defaultOpportunity, defaultContext);

        // Ranker should be called twice (cache expired)
        expect(mockRanker.rankProviders).toHaveBeenCalledTimes(2);
      });
    });

    describe('amountIn handling', () => {
      it('should handle string amountIn correctly', async () => {
        const opp: ArbitrageOpportunity = {
          ...defaultOpportunity,
          amountIn: '500000000000000000',
        };

        await aggregator.selectProvider(opp, defaultContext);

        expect(mockRanker.rankProviders).toHaveBeenCalledWith(
          expect.any(Array),
          500000000000000000n,
          expect.any(Object)
        );
      });

      it('should handle missing amountIn with nullish coalescing (P1 fix)', async () => {
        const opp: ArbitrageOpportunity = {
          ...defaultOpportunity,
          amountIn: undefined,
        };

        await aggregator.selectProvider(opp, defaultContext);

        expect(mockRanker.rankProviders).toHaveBeenCalledWith(
          expect.any(Array),
          0n,
          expect.any(Object)
        );
      });
    });
  });

  describe('decideFallback', () => {
    it('should retry with next provider for insufficient liquidity', async () => {
      const result = await aggregator.decideFallback(
        'aave_v3',
        new Error('insufficient liquidity in pool'),
        [{ protocol: 'pancakeswap_v3', score: 0.7 }]
      );

      expect(result.shouldRetry).toBe(true);
      expect(result.nextProtocol).toBe('pancakeswap_v3');
      expect(result.errorType).toBe('insufficient_liquidity');
    });

    it('should retry with next provider for high fees', async () => {
      const result = await aggregator.decideFallback(
        'aave_v3',
        new Error('slippage exceeded maximum'),
        [{ protocol: 'pancakeswap_v3', score: 0.7 }]
      );

      expect(result.shouldRetry).toBe(true);
      expect(result.errorType).toBe('high_fees');
    });

    it('should classify transient errors correctly', async () => {
      const transientErrors = [
        'timeout waiting for response',
        'network error occurred',
        'ECONNREFUSED',
        '503 Service Unavailable',
        '429 rate limit exceeded',
        'nonce too low',
      ];

      for (const msg of transientErrors) {
        const result = await aggregator.decideFallback(
          'aave_v3',
          new Error(msg),
          [{ protocol: 'pancakeswap_v3', score: 0.7 }]
        );
        expect(result.errorType).toBe('transient');
        expect(result.shouldRetry).toBe(true);
      }
    });

    it('should abort for permanent errors', async () => {
      const result = await aggregator.decideFallback(
        'aave_v3',
        new Error('invalid swap path configuration'),
        [{ protocol: 'pancakeswap_v3', score: 0.7 }]
      );

      expect(result.shouldRetry).toBe(false);
      expect(result.nextProtocol).toBeNull();
      expect(result.errorType).toBe('permanent');
    });

    it('should classify permanent errors correctly', async () => {
      const permanentErrors = [
        'invalid token address',
        'contract paused',
        'router not approved',
        'pool not whitelisted',
        'path validation failed',
      ];

      for (const msg of permanentErrors) {
        const result = await aggregator.decideFallback(
          'aave_v3',
          new Error(msg),
          [{ protocol: 'pancakeswap_v3', score: 0.7 }]
        );
        expect(result.errorType).toBe('permanent');
        expect(result.shouldRetry).toBe(false);
      }
    });

    it('should classify unknown errors and retry', async () => {
      const result = await aggregator.decideFallback(
        'aave_v3',
        new Error('something completely unexpected'),
        [{ protocol: 'pancakeswap_v3', score: 0.7 }]
      );

      expect(result.errorType).toBe('unknown');
      expect(result.shouldRetry).toBe(true);
    });

    it('should not retry when no remaining providers', async () => {
      const result = await aggregator.decideFallback(
        'aave_v3',
        new Error('insufficient liquidity'),
        []
      );

      expect(result.shouldRetry).toBe(false);
      expect(result.nextProtocol).toBeNull();
      expect(result.reason).toBe('No remaining providers');
    });
  });

  describe('getConfig', () => {
    it('should return the config', () => {
      expect(aggregator.getConfig()).toBe(config);
    });
  });

  describe('clearCaches', () => {
    it('should clear ranking cache and liquidity validator cache', async () => {
      // Warm the cache
      await aggregator.selectProvider(defaultOpportunity, defaultContext);
      expect(mockRanker.rankProviders).toHaveBeenCalledTimes(1);

      aggregator.clearCaches();

      // After clearing, ranker should be called again
      await aggregator.selectProvider(defaultOpportunity, defaultContext);
      expect(mockRanker.rankProviders).toHaveBeenCalledTimes(2);
    });

    it('should clear liquidity validator cache', () => {
      aggregator.clearCaches();

      expect(mockLiquidityValidator.clearCache).toHaveBeenCalled();
    });

    it('should not throw when no liquidity validator', () => {
      const noValidator = createAggregator(
        new Map([['ethereum', [aaveProvider]]]),
        null
      );

      expect(() => noValidator.clearCaches()).not.toThrow();
    });
  });
});
