/**
 * SelectProviderUseCase Tests
 *
 * Tests for the application layer orchestrator that coordinates
 * provider selection via domain services.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { SelectProviderUseCase } from '../../../src/application/select-provider.usecase';
import { ProviderScore, ProviderSelection, LiquidityCheck } from '../../../src/domain/models';
import type { IFlashLoanAggregator, IAggregatorMetrics } from '../../../src/domain';
import type { SelectProviderRequest } from '../../../src/application/dtos';

describe('SelectProviderUseCase', () => {
  let useCase: SelectProviderUseCase;
  let mockAggregator: jest.Mocked<IFlashLoanAggregator>;
  let mockMetrics: jest.Mocked<IAggregatorMetrics>;

  const defaultRequest: SelectProviderRequest = {
    chain: 'ethereum',
    asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    amount: BigInt(100000e6), // 100K USDC
    estimatedValueUsd: 100000,
  };

  beforeEach(() => {
    const score = new ProviderScore(0.91, 0.7, 0.95, 0.95, 0.856);
    const successSelection = ProviderSelection.success(
      'aave_v3',
      score,
      null,
      'Best ranked provider',
      5,
      [{ protocol: 'pancakeswap_v3', score: new ProviderScore(0.75, 0.7, 0.85, 0.85, 0.762) }]
    );

    mockAggregator = {
      selectProvider: jest.fn<IFlashLoanAggregator['selectProvider']>().mockResolvedValue(successSelection),
      decideFallback: jest.fn<IFlashLoanAggregator['decideFallback']>(),
      getConfig: jest.fn<IFlashLoanAggregator['getConfig']>(),
      clearCaches: jest.fn<IFlashLoanAggregator['clearCaches']>(),
    };

    mockMetrics = {
      recordSelection: jest.fn<IAggregatorMetrics['recordSelection']>(),
      recordOutcome: jest.fn<IAggregatorMetrics['recordOutcome']>(),
      getReliabilityScore: jest.fn<IAggregatorMetrics['getReliabilityScore']>(),
      getProviderHealth: jest.fn<IAggregatorMetrics['getProviderHealth']>(),
      getAggregatedMetrics: jest.fn<IAggregatorMetrics['getAggregatedMetrics']>(),
      getMetricsSummary: jest.fn<IAggregatorMetrics['getMetricsSummary']>(),
      resetMetrics: jest.fn<IAggregatorMetrics['resetMetrics']>(),
    };

    useCase = new SelectProviderUseCase({
      aggregator: mockAggregator,
      metrics: mockMetrics,
    });
  });

  describe('execute', () => {
    it('should select provider successfully with valid request', async () => {
      const response = await useCase.execute(defaultRequest);

      expect(response.success).toBe(true);
      expect(response.protocol).toBe('aave_v3');
      expect(response.score).not.toBeNull();
      expect(response.score!.total).toBeCloseTo(0.856, 2);
      expect(response.reason).toBe('Best ranked provider');
      expect(response.latencyMs).toBe(5);
      expect(response.alternatives).toHaveLength(1);
      expect(response.alternatives[0].protocol).toBe('pancakeswap_v3');
    });

    it('should delegate to aggregator with opportunity and context', async () => {
      await useCase.execute(defaultRequest);

      expect(mockAggregator.selectProvider).toHaveBeenCalledTimes(1);

      const [opportunity, context] = mockAggregator.selectProvider.mock.calls[0];

      // Verify opportunity object shape
      expect(opportunity.chain).toBe('ethereum');
      expect(opportunity.tokenIn).toBe('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
      expect(opportunity.amountIn).toBe(BigInt(100000e6).toString());
      expect(opportunity.expectedProfit).toBe(100000);

      // Verify context shape
      expect(context.chain).toBe('ethereum');
      expect(context.estimatedValueUsd).toBe(100000);
    });

    it('should build context with rpcProvider when provided', async () => {
      const mockRpcProvider = { call: jest.fn() };
      const requestWithRpc: SelectProviderRequest = {
        ...defaultRequest,
        rpcProvider: mockRpcProvider,
      };

      await useCase.execute(requestWithRpc);

      const [, context] = mockAggregator.selectProvider.mock.calls[0];
      expect(context.rpcProviders).toBeDefined();
      expect(context.rpcProviders!.get('ethereum')).toBe(mockRpcProvider);
    });

    it('should build context without rpcProviders when not provided', async () => {
      await useCase.execute(defaultRequest);

      const [, context] = mockAggregator.selectProvider.mock.calls[0];
      expect(context.rpcProviders).toBeUndefined();
    });

    it('should convert failed selection to response', async () => {
      const failureSelection = ProviderSelection.failure(
        'No providers available for chain',
        3
      );
      mockAggregator.selectProvider.mockResolvedValue(failureSelection);

      const response = await useCase.execute(defaultRequest);

      expect(response.success).toBe(false);
      expect(response.protocol).toBeNull();
      expect(response.score).toBeNull();
      expect(response.reason).toBe('No providers available for chain');
      expect(response.latencyMs).toBe(3);
      expect(response.alternatives).toHaveLength(0);
    });

    it('should convert selection with liquidity check to response', async () => {
      const score = new ProviderScore(0.91, 0.9, 0.95, 0.95, 0.909);
      const liquidityCheck = LiquidityCheck.success(
        BigInt(200000e6),
        BigInt(110000e6),
        8
      );
      const selectionWithLiquidity = ProviderSelection.success(
        'aave_v3',
        score,
        liquidityCheck,
        'Best ranked with liquidity',
        10
      );
      mockAggregator.selectProvider.mockResolvedValue(selectionWithLiquidity);

      const response = await useCase.execute(defaultRequest);

      expect(response.success).toBe(true);
      expect(response.liquidityCheck).not.toBeNull();
      expect(response.liquidityCheck!.performed).toBe(true);
      expect(response.liquidityCheck!.sufficient).toBe(true);
      expect(response.liquidityCheck!.available).toBe(BigInt(200000e6).toString());
      expect(response.liquidityCheck!.required).toBe(BigInt(110000e6).toString());
      expect(response.liquidityCheck!.latencyMs).toBe(8);
    });

    it('should work without metrics (optional dependency)', async () => {
      const useCaseNoMetrics = new SelectProviderUseCase({
        aggregator: mockAggregator,
      });

      const response = await useCaseNoMetrics.execute(defaultRequest);

      expect(response.success).toBe(true);
      expect(response.protocol).toBe('aave_v3');
    });
  });

  describe('validateRequest', () => {
    it('should throw when chain is missing', async () => {
      const request: SelectProviderRequest = {
        ...defaultRequest,
        chain: '',
      };

      await expect(useCase.execute(request)).rejects.toThrow(
        'SelectProviderRequest: chain is required'
      );
    });

    it('should throw when asset is missing', async () => {
      const request: SelectProviderRequest = {
        ...defaultRequest,
        asset: '',
      };

      await expect(useCase.execute(request)).rejects.toThrow(
        'SelectProviderRequest: asset address is required'
      );
    });

    it('should throw when asset does not start with 0x (EVM chain)', async () => {
      const request: SelectProviderRequest = {
        ...defaultRequest,
        asset: 'A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      };

      await expect(useCase.execute(request)).rejects.toThrow(
        'SelectProviderRequest: invalid EVM address'
      );
    });

    it('should throw when Solana address is invalid', async () => {
      const request: SelectProviderRequest = {
        ...defaultRequest,
        chain: 'solana',
        asset: '0xNotASolanaAddress',
      };

      await expect(useCase.execute(request)).rejects.toThrow(
        'SelectProviderRequest: invalid Solana address'
      );
    });

    it('should accept valid Solana base58 address', async () => {
      const request: SelectProviderRequest = {
        ...defaultRequest,
        chain: 'solana',
        asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC on Solana
      };

      const response = await useCase.execute(request);
      expect(response.success).toBe(true);
    });

    it('should throw when amount is zero', async () => {
      const request: SelectProviderRequest = {
        ...defaultRequest,
        amount: 0n,
      };

      await expect(useCase.execute(request)).rejects.toThrow(
        'SelectProviderRequest: amount must be positive'
      );
    });

    it('should throw when amount is negative', async () => {
      const request: SelectProviderRequest = {
        ...defaultRequest,
        amount: -1n,
      };

      await expect(useCase.execute(request)).rejects.toThrow(
        'SelectProviderRequest: amount must be positive'
      );
    });

    it('should throw when estimatedValueUsd is negative', async () => {
      const request: SelectProviderRequest = {
        ...defaultRequest,
        estimatedValueUsd: -1,
      };

      await expect(useCase.execute(request)).rejects.toThrow(
        'SelectProviderRequest: estimatedValueUsd must be a finite non-negative number'
      );
    });

    it('should throw when estimatedValueUsd is NaN', async () => {
      const request: SelectProviderRequest = {
        ...defaultRequest,
        estimatedValueUsd: NaN,
      };

      await expect(useCase.execute(request)).rejects.toThrow(
        'SelectProviderRequest: estimatedValueUsd must be a finite non-negative number'
      );
    });

    it('should throw when estimatedValueUsd is Infinity', async () => {
      const request: SelectProviderRequest = {
        ...defaultRequest,
        estimatedValueUsd: Infinity,
      };

      await expect(useCase.execute(request)).rejects.toThrow(
        'SelectProviderRequest: estimatedValueUsd must be a finite non-negative number'
      );
    });

    it('should accept zero estimatedValueUsd', async () => {
      const request: SelectProviderRequest = {
        ...defaultRequest,
        estimatedValueUsd: 0,
      };

      const response = await useCase.execute(request);
      expect(response.success).toBe(true);
    });

    it('should not call aggregator when validation fails', async () => {
      const request: SelectProviderRequest = {
        ...defaultRequest,
        chain: '',
      };

      await expect(useCase.execute(request)).rejects.toThrow();
      expect(mockAggregator.selectProvider).not.toHaveBeenCalled();
    });
  });

  describe('toSelectProviderResponse', () => {
    it('should map all score fields correctly', async () => {
      const response = await useCase.execute(defaultRequest);

      expect(response.score).toEqual({
        total: expect.any(Number),
        fees: expect.any(Number),
        liquidity: expect.any(Number),
        reliability: expect.any(Number),
        latency: expect.any(Number),
      });
    });

    it('should return null liquidityCheck when not performed', async () => {
      const response = await useCase.execute(defaultRequest);

      expect(response.liquidityCheck).toBeNull();
    });
  });
});
