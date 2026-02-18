/**
 * FlashLoanAggregatorImpl Tests
 *
 * Tests for the main orchestrator that coordinates provider ranking,
 * liquidity validation, caching, and fallback decisions.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { FlashLoanAggregatorImpl } from '../../../../src/flash-loan-aggregation/infrastructure/flashloan-aggregator.impl';
import {
  AggregatorConfig,
  ProviderScore,
  LiquidityCheck,
  ProviderSelection,
} from '../../../../src/flash-loan-aggregation/domain/models';
import type {
  IProviderRanker,
  ILiquidityValidator,
  IAggregatorMetrics,
  IProviderInfo,
  IRankedProvider,
  IRankingContext,
  ILiquidityContext,
} from '../../../../src/flash-loan-aggregation/domain';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import { createProvider, AAVE_PROVIDER, PANCAKESWAP_PROVIDER, BALANCER_PROVIDER, SYNCSWAP_PROVIDER, SPOOKYSWAP_PROVIDER } from './helpers/test-providers';

describe('FlashLoanAggregatorImpl', () => {
  let aggregator: FlashLoanAggregatorImpl;
  let config: AggregatorConfig;
  let mockRanker: jest.Mocked<IProviderRanker>;
  let mockLiquidityValidator: jest.Mocked<ILiquidityValidator>;
  let mockMetrics: jest.Mocked<IAggregatorMetrics>;

  // R5: Use shared test provider factory
  const aaveProvider: IProviderInfo = createProvider({ ...AAVE_PROVIDER, poolAddress: '0xAavePool' });
  const pancakeProvider: IProviderInfo = createProvider({
    ...PANCAKESWAP_PROVIDER,
    chain: 'ethereum',
    poolAddress: '0xPancakePool',
  });
  const unavailableProvider: IProviderInfo = createProvider({ ...aaveProvider, isAvailable: false });

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
        const unavailableAave = { ...aaveProvider, isAvailable: false };
        const unavailableRanked: IRankedProvider = {
          provider: unavailableAave,
          score: aaveScore,
        };
        const availableRanked: IRankedProvider = {
          provider: pancakeProvider,
          score: pancakeScore,
        };
        mockRanker.rankProviders.mockResolvedValue([unavailableRanked, availableRanked]);

        // F6: availableProviders map must also reflect unavailability
        const providers = new Map([['ethereum', [unavailableAave, pancakeProvider]]]);
        const testAggregator = createAggregator(providers, mockLiquidityValidator, mockMetrics);

        const result = await testAggregator.selectProvider(defaultOpportunity, defaultContext);

        expect(result.isSuccess).toBe(true);
        expect(result.protocol).toBe('pancakeswap_v3');
      });

      it('should return failure when all ranked providers are unavailable', async () => {
        const unavailableAave = { ...aaveProvider, isAvailable: false };
        const unavailablePancake = { ...pancakeProvider, isAvailable: false };
        const unavailable1: IRankedProvider = {
          provider: unavailableAave,
          score: aaveScore,
        };
        const unavailable2: IRankedProvider = {
          provider: unavailablePancake,
          score: pancakeScore,
        };
        mockRanker.rankProviders.mockResolvedValue([unavailable1, unavailable2]);

        // F6: availableProviders map must also reflect unavailability
        const providers = new Map([['ethereum', [unavailableAave, unavailablePancake]]]);
        const testAggregator = createAggregator(providers, mockLiquidityValidator, mockMetrics);

        const result = await testAggregator.selectProvider(defaultOpportunity, defaultContext);

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

      it('should coalesce concurrent ranking requests for same chain', async () => {
        // Use short TTL so cache doesn't interfere
        const shortTtlConfig = AggregatorConfig.create({ rankingCacheTtlMs: 1 });
        const providers = new Map([['ethereum', [aaveProvider, pancakeProvider]]]);

        // Create a deferred promise to control when ranking completes
        let resolveRanking!: (value: ReadonlyArray<IRankedProvider>) => void;
        const deferredRanking = new Promise<ReadonlyArray<IRankedProvider>>((resolve) => {
          resolveRanking = resolve;
        });

        const rankedAave: IRankedProvider = { provider: aaveProvider, score: aaveScore };
        const rankedPancake: IRankedProvider = { provider: pancakeProvider, score: pancakeScore };

        mockRanker.rankProviders.mockReturnValue(deferredRanking);

        const coalescingAggregator = new FlashLoanAggregatorImpl(
          shortTtlConfig,
          mockRanker,
          null,
          mockMetrics,
          providers
        );

        // Fire two concurrent selectProvider calls (no await between them)
        const promise1 = coalescingAggregator.selectProvider(defaultOpportunity, defaultContext);
        const promise2 = coalescingAggregator.selectProvider(defaultOpportunity, defaultContext);

        // Resolve the deferred ranking
        resolveRanking([rankedAave, rankedPancake]);

        const [result1, result2] = await Promise.all([promise1, promise2]);

        // rankProviders should have been called only once (coalesced)
        expect(mockRanker.rankProviders).toHaveBeenCalledTimes(1);

        // Both results should be successful with the same provider
        expect(result1.isSuccess).toBe(true);
        expect(result2.isSuccess).toBe(true);
        expect(result1.protocol).toBe(result2.protocol);
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

  describe('F1: liquidityEstimates population', () => {
    it('should call estimateLiquidityScore for each provider during ranking', async () => {
      await aggregator.selectProvider(defaultOpportunity, defaultContext);

      // estimateLiquidityScore should be called once per provider (aave + pancake)
      expect(mockLiquidityValidator.estimateLiquidityScore).toHaveBeenCalledTimes(2);
      expect(mockLiquidityValidator.estimateLiquidityScore).toHaveBeenCalledWith(
        aaveProvider,
        defaultOpportunity.tokenIn,
        BigInt(defaultOpportunity.amountIn!)
      );
      expect(mockLiquidityValidator.estimateLiquidityScore).toHaveBeenCalledWith(
        pancakeProvider,
        defaultOpportunity.tokenIn,
        BigInt(defaultOpportunity.amountIn!)
      );
    });

    it('should pass liquidityEstimates to ranker via ranking context', async () => {
      mockLiquidityValidator.estimateLiquidityScore
        .mockResolvedValueOnce(0.9)
        .mockResolvedValueOnce(0.3);

      await aggregator.selectProvider(defaultOpportunity, defaultContext);

      // Verify ranker received non-empty liquidityEstimates
      const rankingContext = mockRanker.rankProviders.mock.calls[0][2] as IRankingContext;
      expect(rankingContext.liquidityEstimates.size).toBe(2);
      // 0.9 score → 1.5x amount (synthetic bigint for tier 0.9)
      expect(rankingContext.liquidityEstimates.get('aave_v3')).toBe(
        (BigInt(defaultOpportunity.amountIn!) * 3n) / 2n
      );
      // 0.3 score → amount / 2 (synthetic bigint for insufficient tier)
      expect(rankingContext.liquidityEstimates.get('pancakeswap_v3')).toBe(
        BigInt(defaultOpportunity.amountIn!) / 2n
      );
    });

    it('should skip liquidityEstimates when liquidityValidator is null', async () => {
      const noValidatorAggregator = createAggregator(
        new Map([['ethereum', [aaveProvider, pancakeProvider]]]),
        null,
        mockMetrics
      );

      await noValidatorAggregator.selectProvider(defaultOpportunity, defaultContext);

      // Verify ranker received empty liquidityEstimates
      const rankingContext = mockRanker.rankProviders.mock.calls[0][2] as IRankingContext;
      expect(rankingContext.liquidityEstimates.size).toBe(0);
    });

    it('should skip liquidityEstimates when tokenIn is missing', async () => {
      const noTokenOpp: ArbitrageOpportunity = {
        ...defaultOpportunity,
        tokenIn: undefined as unknown as string,
      };

      await aggregator.selectProvider(noTokenOpp, defaultContext);

      expect(mockLiquidityValidator.estimateLiquidityScore).not.toHaveBeenCalled();
    });

    it('should skip liquidityEstimates when amount is zero', async () => {
      const zeroAmountOpp: ArbitrageOpportunity = {
        ...defaultOpportunity,
        amountIn: '0',
      };

      await aggregator.selectProvider(zeroAmountOpp, defaultContext);

      expect(mockLiquidityValidator.estimateLiquidityScore).not.toHaveBeenCalled();
    });
  });

  describe('F3: amount-aware ranking cache key', () => {
    it('should cache separately for different amount buckets', async () => {
      // First call with 1 ETH (small bucket: < 1e18)
      const smallOpp: ArbitrageOpportunity = {
        ...defaultOpportunity,
        amountIn: '500000000000000000', // 0.5 ETH
      };

      // Second call with 100 ETH (medium bucket: < 1e20)
      const largeOpp: ArbitrageOpportunity = {
        ...defaultOpportunity,
        amountIn: '100000000000000000000', // 100 ETH
      };

      await aggregator.selectProvider(smallOpp, defaultContext);
      await aggregator.selectProvider(largeOpp, defaultContext);

      // Ranker should be called twice (different amount buckets = different cache keys)
      expect(mockRanker.rankProviders).toHaveBeenCalledTimes(2);
    });

    it('should use cache for same amount bucket', async () => {
      // Two amounts in the same bucket (small: < 1e18)
      const opp1: ArbitrageOpportunity = {
        ...defaultOpportunity,
        amountIn: '500000000000000000', // 0.5 ETH
      };
      const opp2: ArbitrageOpportunity = {
        ...defaultOpportunity,
        amountIn: '800000000000000000', // 0.8 ETH
      };

      await aggregator.selectProvider(opp1, defaultContext);
      await aggregator.selectProvider(opp2, defaultContext);

      // Ranker should be called only once (same bucket = cache hit)
      expect(mockRanker.rankProviders).toHaveBeenCalledTimes(1);
    });
  });

  describe('F25: ranking cache eviction', () => {
    it('should evict oldest entries when cache exceeds MAX_RANKING_CACHE_SIZE', async () => {
      // MAX_RANKING_CACHE_SIZE is 50 (private static)
      // We need >50 unique cache keys: chain + amount bucket combinations
      // 11 chains × 5 buckets = 55 unique cache keys (exceeds 50)
      const chains = [
        'ethereum', 'polygon', 'arbitrum', 'base', 'optimism',
        'bsc', 'avalanche', 'fantom', 'zksync', 'linea', 'solana',
      ];
      const amountBuckets = [
        '1000000000000',                  // dust (< 1e15)
        '500000000000000000',             // small (< 1e18)
        '50000000000000000000',           // medium (< 1e20)
        '5000000000000000000000',         // large (< 1e22)
        '50000000000000000000000',        // whale (>= 1e22)
      ];

      // Build provider map with two providers per chain to bypass single-provider fast path
      const providerMap = new Map<string, IProviderInfo[]>();
      for (const chain of chains) {
        providerMap.set(chain, [
          createProvider({ chain, protocol: 'aave_v3', feeBps: 9, poolAddress: `0x${chain}AavePool` }),
          createProvider({ chain, protocol: 'pancakeswap_v3', feeBps: 25, poolAddress: `0x${chain}PancakePool` }),
        ]);
      }

      const rankedProviders: IRankedProvider[] = [];
      mockRanker.rankProviders.mockImplementation(async (providers) => {
        const ranked = providers
          .filter(p => p.isAvailable)
          .map(p => ({ provider: p, score: aaveScore }));
        return ranked;
      });

      const shortTtlConfig = AggregatorConfig.create({ rankingCacheTtlMs: 60000 });
      const evictionAggregator = new FlashLoanAggregatorImpl(
        shortTtlConfig,
        mockRanker,
        null,
        mockMetrics,
        providerMap
      );

      // Populate cache: 11 chains × 5 amount buckets = 55 entries
      let rankCallCount = 0;
      for (const chain of chains) {
        for (const amount of amountBuckets) {
          const opp: ArbitrageOpportunity = {
            ...defaultOpportunity,
            chain,
            amountIn: amount,
          };
          await evictionAggregator.selectProvider(opp, {
            chain,
            estimatedValueUsd: 100,
          });
          rankCallCount++;
        }
      }

      // Verify the ranker was called for each unique key
      expect(mockRanker.rankProviders).toHaveBeenCalledTimes(rankCallCount);

      // Now verify eviction happened by requesting the oldest keys again
      // If eviction worked, the oldest entries should have been removed
      // and requesting them again should trigger new ranking calls
      mockRanker.rankProviders.mockClear();

      // Request the first chain's dust bucket (oldest entry, should have been evicted)
      const oldestOpp: ArbitrageOpportunity = {
        ...defaultOpportunity,
        chain: chains[0],
        amountIn: amountBuckets[0],
      };
      await evictionAggregator.selectProvider(oldestOpp, {
        chain: chains[0],
        estimatedValueUsd: 100,
      });

      // If eviction worked, the oldest entries were removed, so a new ranking call should be made
      expect(mockRanker.rankProviders).toHaveBeenCalledTimes(1);
    });
  });

  describe('F4: amount-aware request coalescing', () => {
    it('should not coalesce requests with different amount buckets', async () => {
      const shortTtlConfig = AggregatorConfig.create({ rankingCacheTtlMs: 1 });
      const providers = new Map([['ethereum', [aaveProvider, pancakeProvider]]]);

      const rankedAave: IRankedProvider = { provider: aaveProvider, score: aaveScore };
      const rankedPancake: IRankedProvider = { provider: pancakeProvider, score: pancakeScore };

      // Use deferred promises to control timing
      let resolveSmall!: (value: ReadonlyArray<IRankedProvider>) => void;
      let resolveLarge!: (value: ReadonlyArray<IRankedProvider>) => void;
      const deferredSmall = new Promise<ReadonlyArray<IRankedProvider>>((resolve) => {
        resolveSmall = resolve;
      });
      const deferredLarge = new Promise<ReadonlyArray<IRankedProvider>>((resolve) => {
        resolveLarge = resolve;
      });

      mockRanker.rankProviders
        .mockReturnValueOnce(deferredSmall)
        .mockReturnValueOnce(deferredLarge);

      const coalescingAggregator = new FlashLoanAggregatorImpl(
        shortTtlConfig,
        mockRanker,
        null,
        mockMetrics,
        providers
      );

      // Small amount (small bucket)
      const smallOpp: ArbitrageOpportunity = {
        ...defaultOpportunity,
        amountIn: '500000000000000000', // 0.5 ETH
      };
      // Large amount (medium bucket)
      const largeOpp: ArbitrageOpportunity = {
        ...defaultOpportunity,
        amountIn: '50000000000000000000', // 50 ETH
      };

      const promise1 = coalescingAggregator.selectProvider(smallOpp, defaultContext);
      const promise2 = coalescingAggregator.selectProvider(largeOpp, defaultContext);

      resolveSmall([rankedAave, rankedPancake]);
      resolveLarge([rankedAave, rankedPancake]);

      await Promise.all([promise1, promise2]);

      // Different amount buckets → different coalescing keys → two ranking calls
      expect(mockRanker.rankProviders).toHaveBeenCalledTimes(2);
    });

    it('should coalesce requests within the same amount bucket', async () => {
      const shortTtlConfig = AggregatorConfig.create({ rankingCacheTtlMs: 1 });
      const providers = new Map([['ethereum', [aaveProvider, pancakeProvider]]]);

      const rankedAave: IRankedProvider = { provider: aaveProvider, score: aaveScore };
      const rankedPancake: IRankedProvider = { provider: pancakeProvider, score: pancakeScore };

      let resolveRanking!: (value: ReadonlyArray<IRankedProvider>) => void;
      const deferredRanking = new Promise<ReadonlyArray<IRankedProvider>>((resolve) => {
        resolveRanking = resolve;
      });

      mockRanker.rankProviders.mockReturnValue(deferredRanking);

      const coalescingAggregator = new FlashLoanAggregatorImpl(
        shortTtlConfig,
        mockRanker,
        null,
        mockMetrics,
        providers
      );

      // Two amounts in same bucket (small: < 1e18)
      const opp1: ArbitrageOpportunity = {
        ...defaultOpportunity,
        amountIn: '500000000000000000', // 0.5 ETH
      };
      const opp2: ArbitrageOpportunity = {
        ...defaultOpportunity,
        amountIn: '700000000000000000', // 0.7 ETH
      };

      const promise1 = coalescingAggregator.selectProvider(opp1, defaultContext);
      const promise2 = coalescingAggregator.selectProvider(opp2, defaultContext);

      resolveRanking([rankedAave, rankedPancake]);

      const [result1, result2] = await Promise.all([promise1, promise2]);

      // Same bucket → coalesced → one ranking call
      expect(mockRanker.rankProviders).toHaveBeenCalledTimes(1);
      expect(result1.isSuccess).toBe(true);
      expect(result2.isSuccess).toBe(true);
    });
  });

  describe('F28: multi-protocol provider selection', () => {
    it('should select balancer_v2 (0-fee) provider when ranked first', async () => {
      const balancerProvider = createProvider({ ...BALANCER_PROVIDER, chain: 'ethereum' });
      const balancerScore = new ProviderScore(1.0, 0.7, 0.90, 0.80, 0.900);

      const rankedBalancer: IRankedProvider = { provider: balancerProvider, score: balancerScore };
      const rankedAave: IRankedProvider = { provider: aaveProvider, score: aaveScore };

      mockRanker.rankProviders.mockResolvedValue([rankedBalancer, rankedAave]);

      const providers = new Map([['ethereum', [balancerProvider, aaveProvider]]]);
      const multiAggregator = createAggregator(providers, mockLiquidityValidator, mockMetrics);

      const result = await multiAggregator.selectProvider(defaultOpportunity, defaultContext);

      expect(result.isSuccess).toBe(true);
      expect(result.protocol).toBe('balancer_v2');
    });

    it('should select syncswap provider when available on zksync', async () => {
      const syncswapProvider = createProvider({ ...SYNCSWAP_PROVIDER });
      const syncswapScore = new ProviderScore(0.70, 0.7, 0.85, 0.80, 0.73);

      const rankedSyncswap: IRankedProvider = { provider: syncswapProvider, score: syncswapScore };
      mockRanker.rankProviders.mockResolvedValue([rankedSyncswap]);

      const providers = new Map([['zksync', [syncswapProvider]]]);
      const zkAggregator = createAggregator(providers, null, mockMetrics);

      const zkOpp: ArbitrageOpportunity = {
        ...defaultOpportunity,
        chain: 'zksync',
      };

      const result = await zkAggregator.selectProvider(zkOpp, {
        chain: 'zksync',
        estimatedValueUsd: 100,
      });

      expect(result.isSuccess).toBe(true);
      expect(result.protocol).toBe('syncswap');
    });

    it('should select spookyswap provider when available on fantom', async () => {
      const spookyProvider = createProvider({ ...SPOOKYSWAP_PROVIDER });
      const spookyScore = new ProviderScore(0.80, 0.7, 0.80, 0.80, 0.76);

      const rankedSpooky: IRankedProvider = { provider: spookyProvider, score: spookyScore };
      mockRanker.rankProviders.mockResolvedValue([rankedSpooky]);

      const providers = new Map([['fantom', [spookyProvider]]]);
      const fantomAggregator = createAggregator(providers, null, mockMetrics);

      const fantomOpp: ArbitrageOpportunity = {
        ...defaultOpportunity,
        chain: 'fantom',
      };

      const result = await fantomAggregator.selectProvider(fantomOpp, {
        chain: 'fantom',
        estimatedValueUsd: 100,
      });

      expect(result.isSuccess).toBe(true);
      expect(result.protocol).toBe('spookyswap');
    });

    it('should fallback from spookyswap to balancer_v2 on error', async () => {
      const result = await aggregator.decideFallback(
        'spookyswap',
        new Error('insufficient liquidity in pool'),
        [{ protocol: 'balancer_v2', score: 0.9 }]
      );

      expect(result.shouldRetry).toBe(true);
      expect(result.nextProtocol).toBe('balancer_v2');
      expect(result.errorType).toBe('insufficient_liquidity');
    });
  });
});
