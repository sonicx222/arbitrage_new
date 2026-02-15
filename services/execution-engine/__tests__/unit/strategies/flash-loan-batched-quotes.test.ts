/**
 * Unit Tests for Flash Loan Strategy - Batched Quoting Integration
 *
 * Tests the integration of BatchQuoterService into FlashLoanStrategy
 * for Task 1.2: Batched Quoter Contract deployment.
 *
 * @see ADR-029: Batched Quote Fetching
 * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Task 1.2
 */

import { FlashLoanStrategy } from '../../../src/strategies/flash-loan.strategy';
import type { Logger } from '../../../src/types';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import type { StrategyContext } from '../../../src/types';
import { ethers } from 'ethers';

// Mock configuration
jest.mock('@arbitrage/config', () => ({
  ...jest.requireActual('@arbitrage/config'),
  FEATURE_FLAGS: {
    useBatchedQuoter: false, // Will override per test
  },
  hasMultiPathQuoter: jest.fn(() => false), // Will override per test
}));

// Mock BatchQuoterService
jest.mock('../../../src/services/simulation/batch-quoter.service', () => ({
  createBatchQuoterForChain: jest.fn(),
}));

describe('FlashLoanStrategy - Batched Quoting Integration', () => {
  let strategy: FlashLoanStrategy;
  let mockLogger: Logger;
  let mockContext: StrategyContext;
  let mockOpportunity: ArbitrageOpportunity;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Setup mock logger
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    } as unknown as Logger;

    // Setup mock context
    const mockProvider = {
      getBlockNumber: jest.fn().mockResolvedValue(12345),
      estimateGas: jest.fn().mockResolvedValue(500000n),
      call: jest.fn(),
    } as unknown as ethers.JsonRpcProvider;

    mockContext = {
      providers: new Map([['ethereum', mockProvider]]),
      wallets: new Map(),
    } as StrategyContext;

    // Setup mock opportunity - use uniswap_v3 (available on ethereum per DEXES config)
    // tokenOut is USDC (intermediate token for 2-hop buy side)
    mockOpportunity = {
      id: 'test-opportunity-1',
      buyChain: 'ethereum',
      buyDex: 'uniswap_v3',
      sellDex: 'sushiswap',
      tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
      tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
      amountIn: '1000000000000000000', // 1 ETH
      buyPrice: 1.0,
      sellPrice: 1.01,
      expectedProfit: 0.01,
      gasEstimate: '500000',
      timestamp: Date.now(),
      confidence: 0.9,
      path: ['0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'],
    } as ArbitrageOpportunity;

    // Create strategy instance - use router addresses matching DEXES config
    strategy = new FlashLoanStrategy(mockLogger, {
      contractAddresses: {
        ethereum: '0x1234567890123456789012345678901234567890',
      },
      approvedRouters: {
        ethereum: [
          '0xE592427A0AEce92De3Edee1F18E0157C05861564', // Uniswap V3
          '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F', // SushiSwap
        ],
      },
    });
  });

  describe('calculateExpectedProfitWithBatching', () => {
    it('should use sequential quoting when feature flag is disabled', async () => {
      // Setup: Feature flag OFF
      const { FEATURE_FLAGS } = require('@arbitrage/config');
      FEATURE_FLAGS.useBatchedQuoter = false;

      // Spy on calculateExpectedProfitOnChain
      const calculateOnChainSpy = jest.spyOn(
        strategy as any,
        'calculateExpectedProfitOnChain'
      ).mockResolvedValue({
        expectedProfit: ethers.parseEther('0.01'),
        flashLoanFee: ethers.parseEther('0.0009'),
      });

      // Execute
      const result = await (strategy as any).calculateExpectedProfitWithBatching(
        mockOpportunity,
        'ethereum',
        mockContext
      );

      // Assertions
      expect(calculateOnChainSpy).toHaveBeenCalledWith(
        mockOpportunity,
        'ethereum',
        mockContext
      );
      expect(result).toEqual({
        expectedProfit: ethers.parseEther('0.01'),
        flashLoanFee: ethers.parseEther('0.0009'),
      });
    });

    it('should use sequential quoting when contract not deployed', async () => {
      // Setup: Feature flag ON but contract not deployed
      const { FEATURE_FLAGS, hasMultiPathQuoter } = require('@arbitrage/config');
      FEATURE_FLAGS.useBatchedQuoter = true;
      (hasMultiPathQuoter as jest.Mock).mockReturnValue(false);

      // Spy on methods
      const calculateOnChainSpy = jest.spyOn(
        strategy as any,
        'calculateExpectedProfitOnChain'
      ).mockResolvedValue({
        expectedProfit: ethers.parseEther('0.01'),
        flashLoanFee: ethers.parseEther('0.0009'),
      });

      const getBatchQuoterSpy = jest.spyOn(
        strategy as any,
        'getBatchQuoterService'
      );

      // Execute
      const result = await (strategy as any).calculateExpectedProfitWithBatching(
        mockOpportunity,
        'ethereum',
        mockContext
      );

      // Assertions
      expect(getBatchQuoterSpy).toHaveBeenCalled();
      expect(calculateOnChainSpy).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('should use batched quoting when feature enabled and contract deployed', async () => {
      // Setup: Feature flag ON and contract deployed
      const { FEATURE_FLAGS, hasMultiPathQuoter } = require('@arbitrage/config');
      const { createBatchQuoterForChain } = require('../../../src/services/simulation/batch-quoter.service');

      FEATURE_FLAGS.useBatchedQuoter = true;
      (hasMultiPathQuoter as jest.Mock).mockReturnValue(true);

      // Mock BatchQuoterService
      const mockBatchQuoter = {
        isBatchingEnabled: jest.fn().mockReturnValue(true),
        simulateArbitragePath: jest.fn().mockResolvedValue({
          expectedProfit: ethers.parseEther('0.01'),
          finalAmount: ethers.parseEther('1.01'),
          allSuccess: true,
          latencyMs: 45,
        }),
      };
      (createBatchQuoterForChain as jest.Mock).mockReturnValue(mockBatchQuoter);

      // Execute
      const result = await (strategy as any).calculateExpectedProfitWithBatching(
        mockOpportunity,
        'ethereum',
        mockContext
      );

      // Assertions
      expect(mockBatchQuoter.simulateArbitragePath).toHaveBeenCalled();
      expect(result).toBeDefined();
      expect(result.expectedProfit).toEqual(ethers.parseEther('0.01'));
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Batched quote simulation succeeded',
        expect.objectContaining({
          opportunityId: 'test-opportunity-1',
          chain: 'ethereum',
          latencyMs: 45,
        })
      );
    });

    it('should fallback to sequential when batched simulation fails', async () => {
      // Setup: Feature flag ON, contract deployed, but simulation fails
      const { FEATURE_FLAGS, hasMultiPathQuoter } = require('@arbitrage/config');
      const { createBatchQuoterForChain } = require('../../../src/services/simulation/batch-quoter.service');

      FEATURE_FLAGS.useBatchedQuoter = true;
      (hasMultiPathQuoter as jest.Mock).mockReturnValue(true);

      // Mock BatchQuoterService with failed simulation
      const mockBatchQuoter = {
        isBatchingEnabled: jest.fn().mockReturnValue(true),
        simulateArbitragePath: jest.fn().mockResolvedValue({
          expectedProfit: 0n,
          finalAmount: 0n,
          allSuccess: false, // Simulation failed
          latencyMs: 50,
        }),
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

      // Execute
      const result = await (strategy as any).calculateExpectedProfitWithBatching(
        mockOpportunity,
        'ethereum',
        mockContext
      );

      // Assertions
      expect(mockBatchQuoter.simulateArbitragePath).toHaveBeenCalled();
      expect(calculateOnChainSpy).toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Batched simulation failed, using fallback',
        expect.any(Object)
      );
      expect(result).toBeDefined();
    });

    it('should fallback to sequential when BatchQuoterService throws error', async () => {
      // Setup: Feature flag ON, contract deployed, but service throws
      const { FEATURE_FLAGS, hasMultiPathQuoter } = require('@arbitrage/config');
      const { createBatchQuoterForChain } = require('../../../src/services/simulation/batch-quoter.service');

      FEATURE_FLAGS.useBatchedQuoter = true;
      (hasMultiPathQuoter as jest.Mock).mockReturnValue(true);

      // Mock BatchQuoterService that throws
      const mockBatchQuoter = {
        isBatchingEnabled: jest.fn().mockReturnValue(true),
        simulateArbitragePath: jest.fn().mockRejectedValue(new Error('RPC timeout')),
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

      // Execute
      const result = await (strategy as any).calculateExpectedProfitWithBatching(
        mockOpportunity,
        'ethereum',
        mockContext
      );

      // Assertions
      expect(mockBatchQuoter.simulateArbitragePath).toHaveBeenCalled();
      expect(calculateOnChainSpy).toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'BatchQuoter error, using fallback',
        expect.objectContaining({
          error: 'RPC timeout',
        })
      );
      expect(result).toBeDefined();
    });
  });

  describe('getBatchQuoterService', () => {
    it('should return undefined when provider not available', () => {
      const result = (strategy as any).getBatchQuoterService(
        'nonexistent-chain',
        mockContext
      );

      expect(result).toBeUndefined();
    });

    it('should return undefined when contract not deployed', () => {
      const { hasMultiPathQuoter } = require('@arbitrage/config');
      (hasMultiPathQuoter as jest.Mock).mockReturnValue(false);

      const result = (strategy as any).getBatchQuoterService(
        'ethereum',
        mockContext
      );

      expect(result).toBeUndefined();
    });

    it('should create and cache BatchQuoterService', () => {
      const { hasMultiPathQuoter } = require('@arbitrage/config');
      const { createBatchQuoterForChain } = require('../../../src/services/simulation/batch-quoter.service');

      (hasMultiPathQuoter as jest.Mock).mockReturnValue(true);

      const mockBatchQuoter = {
        isBatchingEnabled: jest.fn().mockReturnValue(true),
      };
      (createBatchQuoterForChain as jest.Mock).mockReturnValue(mockBatchQuoter);

      // First call
      const result1 = (strategy as any).getBatchQuoterService(
        'ethereum',
        mockContext
      );

      // Second call (should use cache)
      const result2 = (strategy as any).getBatchQuoterService(
        'ethereum',
        mockContext
      );

      expect(result1).toBe(result2); // Same instance
      expect(createBatchQuoterForChain).toHaveBeenCalledTimes(1); // Only called once
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Batched quoting enabled for chain',
        { chain: 'ethereum' }
      );
    });
  });

  describe('buildQuoteRequestsFromOpportunity', () => {
    it('should build 2-hop quote requests', () => {
      const requests = (strategy as any).buildQuoteRequestsFromOpportunity(
        mockOpportunity,
        'ethereum'
      );

      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({
        router: expect.any(String),
        tokenIn: mockOpportunity.tokenIn,
        tokenOut: mockOpportunity.path![1],
        amountIn: BigInt(mockOpportunity.amountIn!),
      });
      expect(requests[1]).toMatchObject({
        router: expect.any(String),
        tokenIn: mockOpportunity.path![1],
        tokenOut: mockOpportunity.tokenIn,
        amountIn: 0n, // Chained from previous
      });
    });

    it('should throw when router not found', () => {
      const invalidOpportunity = {
        ...mockOpportunity,
        buyDex: 'nonexistent-dex',
      };

      expect(() => {
        (strategy as any).buildQuoteRequestsFromOpportunity(
          invalidOpportunity,
          'ethereum'
        );
      }).toThrow(/No router found for buyDex/);
    });
  });
});
