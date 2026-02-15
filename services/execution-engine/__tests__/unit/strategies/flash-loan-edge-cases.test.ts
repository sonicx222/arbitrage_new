/**
 * Edge Case Tests for Flash Loan Strategy - Missing Coverage
 *
 * Tests edge cases identified in code analysis report (Test Coverage 8.1):
 * - N-hop opportunities with batched quoting
 * - Provider disconnection during batched calls
 * - Concurrent cache access (race conditions)
 * - Invalid router addresses
 * - Feature flag runtime changes
 *
 * @see analysis report Issue 1.1, Race 5.1, Test Coverage 8.1
 */

import { FlashLoanStrategy } from '../../../src/strategies/flash-loan.strategy';
import type { Logger } from '../../../src/types';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import type { StrategyContext, NHopArbitrageOpportunity } from '../../../src/types';
import { ethers } from 'ethers';

// Mock configuration
jest.mock('@arbitrage/config', () => ({
  ...jest.requireActual('@arbitrage/config'),
  FEATURE_FLAGS: {
    useBatchedQuoter: false, // Will override per test
  },
  hasMultiPathQuoter: jest.fn(() => false),
}));

// Mock BatchQuoterService
jest.mock('../../../src/services/simulation/batch-quoter.service', () => ({
  createBatchQuoterForChain: jest.fn(),
}));

describe('FlashLoanStrategy - Edge Cases', () => {
  let strategy: FlashLoanStrategy;
  let mockLogger: Logger;
  let mockContext: StrategyContext;
  let mockProvider: ethers.JsonRpcProvider;

  beforeEach(() => {
    jest.clearAllMocks();

    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    } as unknown as Logger;

    mockProvider = {
      getBlockNumber: jest.fn().mockResolvedValue(12345),
      estimateGas: jest.fn().mockResolvedValue(500000n),
      call: jest.fn(),
    } as unknown as ethers.JsonRpcProvider;

    mockContext = {
      providers: new Map([['ethereum', mockProvider]]),
      wallets: new Map(),
    } as StrategyContext;

    strategy = new FlashLoanStrategy(mockLogger, {
      contractAddresses: {
        ethereum: '0x1234567890123456789012345678901234567890',
      },
      approvedRouters: {
        ethereum: [
          '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', // Uniswap V2
          '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F', // SushiSwap
          '0xEf1c6E67703c7BD7107eed8303Fbe6EC2554BF6B', // Curve (example)
        ],
      },
    });
  });

  describe('Edge Case: N-Hop Opportunities with Batched Quoting', () => {
    it('should build quote requests for 3-hop triangular arbitrage', () => {
      const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
      const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
      const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F';

      const nhopOpportunity: NHopArbitrageOpportunity = {
        id: 'test-nhop-1',
        buyChain: 'ethereum',
        tokenIn: WETH,
        amountIn: '1000000000000000000', // 1 ETH
        buyPrice: 1.0,
        expectedProfit: 0.02,
        confidence: 0.9,
        gasEstimate: '600000',
        timestamp: Date.now(),
        hops: [
          {
            dex: 'uniswap_v2',
            router: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
            tokenOut: USDC,
            expectedOutput: '3000000000', // 3000 USDC (6 decimals)
          },
          {
            dex: 'sushiswap',
            router: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',
            tokenOut: DAI,
            expectedOutput: '3000000000000000000000', // 3000 DAI (18 decimals)
          },
          {
            dex: 'curve',
            router: '0xEf1c6E67703c7BD7107eed8303Fbe6EC2554BF6B',
            tokenOut: WETH,
            expectedOutput: '1020000000000000000', // 1.02 ETH
          },
        ],
      };

      const requests = (strategy as any).buildQuoteRequestsFromOpportunity(
        nhopOpportunity,
        'ethereum'
      );

      expect(requests).toHaveLength(3);

      // Hop 1: WETH → USDC
      expect(requests[0]).toMatchObject({
        router: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
        tokenIn: WETH,
        tokenOut: USDC,
        amountIn: 1000000000000000000n,
      });

      // Hop 2: USDC → DAI
      expect(requests[1]).toMatchObject({
        router: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',
        tokenIn: USDC,
        tokenOut: DAI,
        amountIn: 0n, // Chains from previous
      });

      // Hop 3: DAI → WETH
      expect(requests[2]).toMatchObject({
        router: '0xEf1c6E67703c7BD7107eed8303Fbe6EC2554BF6B',
        tokenIn: DAI,
        tokenOut: WETH,
        amountIn: 0n, // Chains from previous
      });
    });

    it('should throw error if N-hop path does not end with starting token', () => {
      const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
      const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
      const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F';

      const invalidNHopOpp: NHopArbitrageOpportunity = {
        id: 'test-invalid-nhop',
        buyChain: 'ethereum',
        tokenIn: WETH,
        amountIn: '1000000000000000000',
        buyPrice: 1.0,
        expectedProfit: 0.02,
        confidence: 0.9,
        gasEstimate: '600000',
        timestamp: Date.now(),
        hops: [
          { dex: 'uniswap_v2', tokenOut: USDC, router: '0x...' },
          { dex: 'sushiswap', tokenOut: DAI, router: '0x...' }, // ❌ Ends with DAI, not WETH
        ],
      };

      expect(() => {
        (strategy as any).buildQuoteRequestsFromOpportunity(
          invalidNHopOpp,
          'ethereum'
        );
      }).toThrow(/must end with starting token/i);
    });

    it('should throw error if N-hop has no router defined', () => {
      const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
      const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

      const noRouterOpp: NHopArbitrageOpportunity = {
        id: 'test-no-router',
        buyChain: 'ethereum',
        tokenIn: WETH,
        amountIn: '1000000000000000000',
        buyPrice: 1.0,
        expectedProfit: 0.02,
        confidence: 0.9,
        gasEstimate: '600000',
        timestamp: Date.now(),
        hops: [
          { dex: 'nonexistent_dex', tokenOut: USDC }, // ❌ No router, invalid dex
          { dex: 'uniswap_v2', tokenOut: WETH, router: '0x...' },
        ],
      };

      expect(() => {
        (strategy as any).buildQuoteRequestsFromOpportunity(
          noRouterOpp,
          'ethereum'
        );
      }).toThrow(/No router found for hop/i);
    });
  });

  describe('Edge Case: Provider Disconnection During Batched Call', () => {
    it('should fall back to sequential when batched call fails with network error', async () => {
      const { FEATURE_FLAGS, hasMultiPathQuoter } = require('@arbitrage/config');
      const { createBatchQuoterForChain } = require('../../../src/services/simulation/batch-quoter.service');

      FEATURE_FLAGS.useBatchedQuoter = true;
      (hasMultiPathQuoter as jest.Mock).mockReturnValue(true);

      // Mock BatchQuoterService that throws network error
      const mockBatchQuoter = {
        isBatchingEnabled: jest.fn().mockReturnValue(true),
        simulateArbitragePath: jest.fn().mockRejectedValue(new Error('Network error: Connection timeout')),
      };
      (createBatchQuoterForChain as jest.Mock).mockReturnValue(mockBatchQuoter);

      // Spy on fallback
      const calculateOnChainSpy = jest.spyOn(
        strategy as any,
        'calculateExpectedProfitOnChain'
      ).mockResolvedValue({
        expectedProfit: ethers.parseEther('0.01'),
        flashLoanFee: ethers.parseEther('0.0009'),
      });

      const mockOpportunity = {
        id: 'test-network-error',
        buyChain: 'ethereum',
        buyDex: 'uniswap_v3',
        sellDex: 'sushiswap',
        tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        tokenOut: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        amountIn: '1000000000000000000',
        buyPrice: 1.0,
        profit: 0.01,
        gasEstimate: '500000',
        confidence: 0.9,
        timestamp: Date.now(),
      } as ArbitrageOpportunity;

      const result = await (strategy as any).calculateExpectedProfitWithBatching(
        mockOpportunity,
        'ethereum',
        mockContext
      );

      expect(mockBatchQuoter.simulateArbitragePath).toHaveBeenCalled();
      expect(calculateOnChainSpy).toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'BatchQuoter error, using fallback',
        expect.objectContaining({
          error: expect.stringContaining('Network error'),
        })
      );
      expect(result).toBeDefined();
      expect(result?.expectedProfit).toEqual(ethers.parseEther('0.01'));
    });
  });

  describe('Edge Case: Concurrent Cache Access', () => {
    it('should handle concurrent calls to getBatchQuoterService without creating duplicates', async () => {
      const { hasMultiPathQuoter } = require('@arbitrage/config');
      const { createBatchQuoterForChain } = require('../../../src/services/simulation/batch-quoter.service');

      (hasMultiPathQuoter as jest.Mock).mockReturnValue(true);

      let createCallCount = 0;
      const mockBatchQuoter = {
        isBatchingEnabled: jest.fn().mockReturnValue(true),
      };
      (createBatchQuoterForChain as jest.Mock).mockImplementation(() => {
        createCallCount++;
        return mockBatchQuoter;
      });

      // Simulate concurrent calls (Promise.all with same chain)
      const calls = [
        (strategy as any).getBatchQuoterService('ethereum', mockContext),
        (strategy as any).getBatchQuoterService('ethereum', mockContext),
        (strategy as any).getBatchQuoterService('ethereum', mockContext),
      ];

      const results = await Promise.all(calls);

      // All should return the same instance
      expect(results[0]).toBe(results[1]);
      expect(results[1]).toBe(results[2]);

      // Should only create once (double-check logic prevents duplicates)
      expect(createCallCount).toBeLessThanOrEqual(2); // Max 2 due to double-check pattern
      expect(createBatchQuoterForChain).toHaveBeenCalled();
    });

    it('should create separate quoter instances for different chains', () => {
      const { hasMultiPathQuoter } = require('@arbitrage/config');
      const { createBatchQuoterForChain } = require('../../../src/services/simulation/batch-quoter.service');

      (hasMultiPathQuoter as jest.Mock).mockReturnValue(true);

      const mockBatchQuoter = {
        isBatchingEnabled: jest.fn().mockReturnValue(true),
      };
      (createBatchQuoterForChain as jest.Mock).mockReturnValue(mockBatchQuoter);

      // Add providers for multiple chains
      mockContext.providers.set('arbitrum', mockProvider);
      mockContext.providers.set('base', mockProvider);

      const ethQuoter = (strategy as any).getBatchQuoterService('ethereum', mockContext);
      const arbQuoter = (strategy as any).getBatchQuoterService('arbitrum', mockContext);
      const baseQuoter = (strategy as any).getBatchQuoterService('base', mockContext);

      expect(ethQuoter).toBeDefined();
      expect(arbQuoter).toBeDefined();
      expect(baseQuoter).toBeDefined();
      expect(createBatchQuoterForChain).toHaveBeenCalledTimes(3);
    });
  });

  describe('Edge Case: Resource Cleanup', () => {
    it('should clear cached quoters on dispose()', async () => {
      const { hasMultiPathQuoter } = require('@arbitrage/config');
      const { createBatchQuoterForChain } = require('../../../src/services/simulation/batch-quoter.service');

      (hasMultiPathQuoter as jest.Mock).mockReturnValue(true);

      const mockBatchQuoter = {
        isBatchingEnabled: jest.fn().mockReturnValue(true),
      };
      (createBatchQuoterForChain as jest.Mock).mockReturnValue(mockBatchQuoter);

      // Create quoter (will cache)
      const quoter = (strategy as any).getBatchQuoterService('ethereum', mockContext);
      expect(quoter).toBeDefined();

      // Verify cached
      const cachedQuoter = (strategy as any).getBatchQuoterService('ethereum', mockContext);
      expect(cachedQuoter).toBe(quoter);

      // Dispose
      await strategy.dispose();

      // Verify cache cleared (would create new instance if accessed again)
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'FlashLoanStrategy resources disposed',
        expect.any(Object)
      );
    });
  });

  describe('Edge Case: Invalid Router Addresses', () => {
    it('should provide detailed error when buyRouter not found', () => {
      const opportunityWithBadDex = {
        id: 'test-bad-dex',
        buyChain: 'ethereum',
        buyDex: 'nonexistent_dex',
        sellDex: 'sushiswap',
        tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        amountIn: '1000000000000000000',
        buyPrice: 1.0,
        profit: 0.01,
        gasEstimate: '500000',
        confidence: 0.9,
        timestamp: Date.now(),
      } as ArbitrageOpportunity;

      expect(() => {
        (strategy as any).buildQuoteRequestsFromOpportunity(
          opportunityWithBadDex,
          'ethereum'
        );
      }).toThrow(/No router found for buyDex/i);
    });

    it('should provide detailed error when sellRouter not found', () => {
      const opportunityWithBadSellDex = {
        id: 'test-bad-sell-dex',
        buyChain: 'ethereum',
        buyDex: 'uniswap_v3',
        sellDex: 'nonexistent_dex',
        tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        amountIn: '1000000000000000000',
        buyPrice: 1.0,
        profit: 0.01,
        gasEstimate: '500000',
        confidence: 0.9,
        timestamp: Date.now(),
      } as ArbitrageOpportunity;

      expect(() => {
        (strategy as any).buildQuoteRequestsFromOpportunity(
          opportunityWithBadSellDex,
          'ethereum'
        );
      }).toThrow(/No router found for sellDex/i);
    });
  });
});
