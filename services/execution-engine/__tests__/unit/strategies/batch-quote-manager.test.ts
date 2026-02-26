/**
 * Unit Tests for BatchQuoteManager
 *
 * Tests the BatchQuoteManager class from batch-quote-manager.ts.
 * Validates batched quoting with feature flag control, fallback behavior,
 * and quote request building for 2-hop and N-hop paths.
 *
 * @see batch-quote-manager.ts (source module)
 * @see flash-loan.strategy.ts (only caller)
 * @see ADR-029 for batched quoting architecture
 */

import type { ArbitrageOpportunity } from '@arbitrage/types';
import type { Logger, StrategyContext, NHopArbitrageOpportunity } from '../../../src/types';
import {
  BatchQuoteManager,
  type BatchQuoteManagerDeps,
  type DexLookup,
} from '../../../src/strategies/batch-quote-manager';
import type {
  BatchQuoterService,
  QuoteRequest,
  ArbitrageSimulationResult,
} from '../../../src/services/simulation/batch-quoter.service';

// Mock @arbitrage/config module
jest.mock('@arbitrage/config', () => ({
  FEATURE_FLAGS: {
    useBatchedQuoter: false, // Will override per test
  },
  hasMultiPathQuoter: jest.fn(() => false),
  getAaveV3FeeBpsBigInt: jest.fn(() => 9n),
  CHAINS: { ethereum: { id: 1 }, bsc: { id: 56 }, arbitrum: { id: 42161 } },
}));

// Mock @arbitrage/core/resilience for getErrorMessage
jest.mock('@arbitrage/core/resilience', () => ({
  getErrorMessage: jest.fn((e: unknown) =>
    e instanceof Error ? e.message : String(e)
  ),
}));

// Mock batch-quoter.service
jest.mock('../../../src/services/simulation/batch-quoter.service', () => ({
  createBatchQuoterForChain: jest.fn(),
}));

import { FEATURE_FLAGS, hasMultiPathQuoter } from '@arbitrage/config';
import { getErrorMessage } from '@arbitrage/core/resilience';
import { createBatchQuoterForChain } from '../../../src/services/simulation/batch-quoter.service';

describe('BatchQuoteManager', () => {
  let manager: BatchQuoteManager;
  let mockLogger: Logger;
  let mockDexLookup: DexLookup;
  let mockCalculateFlashLoanFee: jest.Mock;
  let mockCalculateExpectedProfitOnChain: jest.Mock;
  let mockBatchedQuoters: Map<string, BatchQuoterService>;
  let mockContext: StrategyContext;
  let mockOpportunity: ArbitrageOpportunity;

  const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
  const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
  const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F';
  const UNI_ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
  const SUSHI_ROUTER = '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F';

  beforeEach(() => {
    jest.clearAllMocks();

    // Re-establish mock implementations after resetMocks wipes them
    (getErrorMessage as jest.Mock).mockImplementation((e: unknown) =>
      e instanceof Error ? e.message : String(e)
    );
    (hasMultiPathQuoter as jest.Mock).mockReturnValue(false);

    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    } as unknown as Logger;

    mockDexLookup = {
      getRouterAddress: jest.fn((chain: string, dex: string) => {
        const routers: Record<string, string> = {
          uniswap_v3: UNI_ROUTER,
          sushiswap: SUSHI_ROUTER,
        };
        return routers[dex];
      }),
    };

    mockCalculateFlashLoanFee = jest.fn(() => 900000000000000n); // 0.0009 ETH
    mockCalculateExpectedProfitOnChain = jest.fn().mockResolvedValue({
      expectedProfit: 50000000000000000n, // 0.05 ETH
      flashLoanFee: 900000000000000n,
    });

    mockBatchedQuoters = new Map();

    const mockProvider = {
      getBlockNumber: jest.fn().mockResolvedValue(12345),
    };

    mockContext = {
      providers: new Map([['ethereum', mockProvider]]),
      wallets: new Map(),
    } as unknown as StrategyContext;

    mockOpportunity = {
      id: 'test-opp-1',
      buyChain: 'ethereum',
      buyDex: 'uniswap_v3',
      sellDex: 'sushiswap',
      tokenIn: WETH,
      tokenOut: USDC,
      amountIn: '1000000000000000000', // 1 ETH
      buyPrice: 1.0,
      sellPrice: 1.01,
      expectedProfit: 0.01,
      gasEstimate: '500000',
      timestamp: Date.now(),
      confidence: 0.9,
      path: [WETH, USDC, WETH],
    } as ArbitrageOpportunity;

    // Default: feature flag disabled
    (FEATURE_FLAGS as { useBatchedQuoter: boolean }).useBatchedQuoter = false;

    const deps: BatchQuoteManagerDeps = {
      logger: mockLogger,
      dexLookup: mockDexLookup,
      calculateFlashLoanFee: mockCalculateFlashLoanFee,
      calculateExpectedProfitOnChain: mockCalculateExpectedProfitOnChain,
    };

    manager = new BatchQuoteManager(deps, mockBatchedQuoters);
  });

  describe('calculateExpectedProfitWithBatching', () => {
    it('should fall back to sequential when feature flag is disabled', async () => {
      (FEATURE_FLAGS as { useBatchedQuoter: boolean }).useBatchedQuoter = false;

      const result = await manager.calculateExpectedProfitWithBatching(
        mockOpportunity,
        'ethereum',
        mockContext
      );

      expect(mockCalculateExpectedProfitOnChain).toHaveBeenCalledWith(
        mockOpportunity,
        'ethereum',
        mockContext
      );
      expect(result).toEqual({
        expectedProfit: 50000000000000000n,
        flashLoanFee: 900000000000000n,
      });
    });

    it('should fall back when no batch quoter is available for the chain', async () => {
      (FEATURE_FLAGS as { useBatchedQuoter: boolean }).useBatchedQuoter = true;
      // No provider for chain, so getBatchQuoterService returns undefined
      mockContext.providers = new Map();

      const result = await manager.calculateExpectedProfitWithBatching(
        mockOpportunity,
        'ethereum',
        mockContext
      );

      expect(mockCalculateExpectedProfitOnChain).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('should use batched quoter when available and return batched result', async () => {
      (FEATURE_FLAGS as { useBatchedQuoter: boolean }).useBatchedQuoter = true;

      const mockBatchQuoter: BatchQuoterService = {
        simulateArbitragePath: jest.fn().mockResolvedValue({
          expectedProfit: 100000000000000000n, // 0.1 ETH
          finalAmount: 1100000000000000000n,
          allSuccess: true,
          latencyMs: 35,
        } as ArbitrageSimulationResult),
        isBatchingEnabled: jest.fn(() => true),
        getBatchedQuotes: jest.fn(),
        getMetrics: jest.fn(),
      } as unknown as BatchQuoterService;

      mockBatchedQuoters.set('ethereum', mockBatchQuoter);

      const result = await manager.calculateExpectedProfitWithBatching(
        mockOpportunity,
        'ethereum',
        mockContext
      );

      expect(mockBatchQuoter.simulateArbitragePath).toHaveBeenCalled();
      expect(mockCalculateExpectedProfitOnChain).not.toHaveBeenCalled();
      expect(result).toEqual({
        expectedProfit: 100000000000000000n,
        flashLoanFee: 900000000000000n,
      });
    });

    it('should fall back gracefully when batcher fails', async () => {
      (FEATURE_FLAGS as { useBatchedQuoter: boolean }).useBatchedQuoter = true;

      const mockBatchQuoter: BatchQuoterService = {
        simulateArbitragePath: jest.fn().mockRejectedValue(new Error('RPC timeout')),
        isBatchingEnabled: jest.fn(() => true),
        getBatchedQuotes: jest.fn(),
        getMetrics: jest.fn(),
      } as unknown as BatchQuoterService;

      mockBatchedQuoters.set('ethereum', mockBatchQuoter);

      const result = await manager.calculateExpectedProfitWithBatching(
        mockOpportunity,
        'ethereum',
        mockContext
      );

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'BatchQuoter error, using fallback',
        expect.objectContaining({ opportunityId: 'test-opp-1' })
      );
      expect(mockCalculateExpectedProfitOnChain).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('should fall back when batched simulation returns allSuccess=false', async () => {
      (FEATURE_FLAGS as { useBatchedQuoter: boolean }).useBatchedQuoter = true;

      const mockBatchQuoter: BatchQuoterService = {
        simulateArbitragePath: jest.fn().mockResolvedValue({
          expectedProfit: 0n,
          finalAmount: 0n,
          allSuccess: false,
          latencyMs: 20,
        } as ArbitrageSimulationResult),
        isBatchingEnabled: jest.fn(() => true),
        getBatchedQuotes: jest.fn(),
        getMetrics: jest.fn(),
      } as unknown as BatchQuoterService;

      mockBatchedQuoters.set('ethereum', mockBatchQuoter);

      const result = await manager.calculateExpectedProfitWithBatching(
        mockOpportunity,
        'ethereum',
        mockContext
      );

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Batched simulation failed, using fallback',
        expect.objectContaining({ opportunityId: 'test-opp-1' })
      );
      expect(mockCalculateExpectedProfitOnChain).toHaveBeenCalled();
      expect(result).toBeDefined();
    });
  });

  describe('buildQuoteRequestsFromOpportunity (via calculateExpectedProfitWithBatching)', () => {
    let mockBatchQuoter: BatchQuoterService;

    beforeEach(() => {
      (FEATURE_FLAGS as { useBatchedQuoter: boolean }).useBatchedQuoter = true;

      mockBatchQuoter = {
        simulateArbitragePath: jest.fn().mockResolvedValue({
          expectedProfit: 50000000000000000n,
          finalAmount: 1050000000000000000n,
          allSuccess: true,
          latencyMs: 30,
        } as ArbitrageSimulationResult),
        isBatchingEnabled: jest.fn(() => true),
        getBatchedQuotes: jest.fn(),
        getMetrics: jest.fn(),
      } as unknown as BatchQuoterService;

      mockBatchedQuoters.set('ethereum', mockBatchQuoter);
    });

    it('should build 2-hop quote requests for standard opportunity', async () => {
      await manager.calculateExpectedProfitWithBatching(
        mockOpportunity,
        'ethereum',
        mockContext
      );

      expect(mockBatchQuoter.simulateArbitragePath).toHaveBeenCalledWith(
        [
          {
            router: UNI_ROUTER,
            tokenIn: WETH,
            tokenOut: USDC,
            amountIn: 1000000000000000000n,
          },
          {
            router: SUSHI_ROUTER,
            tokenIn: USDC,
            tokenOut: WETH,
            amountIn: 0n,
          },
        ],
        1000000000000000000n,
        expect.any(Number)
      );
    });

    it('should build N-hop quote requests for multi-hop opportunity', async () => {
      const nHopOpportunity = {
        ...mockOpportunity,
        tokenIn: WETH,
        hops: [
          { tokenOut: USDC, dex: 'uniswap_v3' },
          { tokenOut: DAI, dex: 'sushiswap' },
          { tokenOut: WETH, router: UNI_ROUTER },
        ],
      } as unknown as NHopArbitrageOpportunity;

      await manager.calculateExpectedProfitWithBatching(
        nHopOpportunity,
        'ethereum',
        mockContext
      );

      expect(mockBatchQuoter.simulateArbitragePath).toHaveBeenCalledWith(
        [
          {
            router: UNI_ROUTER,
            tokenIn: WETH,
            tokenOut: USDC,
            amountIn: 1000000000000000000n,
          },
          {
            router: SUSHI_ROUTER,
            tokenIn: USDC,
            tokenOut: DAI,
            amountIn: 0n,
          },
          {
            router: UNI_ROUTER,
            tokenIn: DAI,
            tokenOut: WETH,
            amountIn: 0n,
          },
        ],
        1000000000000000000n,
        expect.any(Number)
      );
    });

    it('should throw when router is missing for a 2-hop buy DEX', async () => {
      // Use a DEX that our mock dexLookup does not know
      const badOpportunity = {
        ...mockOpportunity,
        buyDex: 'unknown_dex',
      } as ArbitrageOpportunity;

      // The error gets caught by the try/catch and falls back
      await manager.calculateExpectedProfitWithBatching(
        badOpportunity,
        'ethereum',
        mockContext
      );

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'BatchQuoter error, using fallback',
        expect.objectContaining({
          error: expect.stringContaining('No router found'),
        })
      );
      expect(mockCalculateExpectedProfitOnChain).toHaveBeenCalled();
    });

    it('should throw when router is missing for N-hop path', async () => {
      const nHopOpportunity = {
        ...mockOpportunity,
        tokenIn: WETH,
        hops: [
          { tokenOut: USDC, dex: 'nonexistent_dex' }, // No router
        ],
      } as unknown as NHopArbitrageOpportunity;

      // buildQuoteRequestsFromOpportunity throws, caught by try/catch
      await manager.calculateExpectedProfitWithBatching(
        nHopOpportunity,
        'ethereum',
        mockContext
      );

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'BatchQuoter error, using fallback',
        expect.objectContaining({
          error: expect.stringContaining('No router found for hop'),
        })
      );
    });
  });
});
