/**
 * Execution Engine Mock Factories
 *
 * Centralized mock factories for execution-engine strategy tests.
 * Reduces duplication across strategy test files (intra-chain, cross-chain,
 * flash-loan, simulation) while allowing per-test overrides.
 *
 * @see services/execution-engine/__tests__/unit/strategies/
 */

import { ethers } from 'ethers';
import type { ArbitrageOpportunity } from '@arbitrage/types';

// =============================================================================
// Logger Mock (lightweight strategy-test version)
// =============================================================================

export interface StrategyMockLogger {
  debug: jest.Mock;
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
}

export function createMockStrategyLogger(): StrategyMockLogger {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

// =============================================================================
// Provider Mock (lightweight strategy-test version)
// =============================================================================

/**
 * Creates a lightweight mock provider suitable for strategy tests.
 * This is intentionally simpler than the full MockProvider from provider.mock.ts,
 * which is designed for more comprehensive provider-level testing.
 */
export function createMockStrategyProvider(): ethers.JsonRpcProvider {
  return {
    getBlockNumber: jest.fn().mockResolvedValue(12345678),
    getFeeData: jest.fn().mockResolvedValue({
      gasPrice: BigInt('30000000000'), // 30 gwei
      maxFeePerGas: BigInt('35000000000'),
      maxPriorityFeePerGas: BigInt('2000000000'),
    }),
    getTransactionReceipt: jest.fn().mockResolvedValue({
      hash: '0x123abc',
      gasUsed: BigInt(150000),
      gasPrice: BigInt('30000000000'),
      status: 1,
    }),
    getNetwork: jest.fn().mockResolvedValue({ chainId: 1n }),
    estimateGas: jest.fn().mockResolvedValue(300000n),
    call: jest.fn().mockResolvedValue('0x'),
  } as unknown as ethers.JsonRpcProvider;
}

// =============================================================================
// Wallet Mock (lightweight strategy-test version)
// =============================================================================

/**
 * Creates a lightweight mock wallet suitable for strategy tests.
 */
export function createMockStrategyWallet(): ethers.Wallet {
  return {
    address: '0x1234567890123456789012345678901234567890',
    getAddress: jest.fn().mockResolvedValue('0x1234567890123456789012345678901234567890'),
    sendTransaction: jest.fn().mockResolvedValue({
      hash: '0x123abc',
      wait: jest.fn().mockResolvedValue({
        hash: '0x123abc',
        gasUsed: BigInt(150000),
        gasPrice: BigInt('30000000000'),
        status: 1,
      }),
    }),
  } as unknown as ethers.Wallet;
}

// =============================================================================
// Opportunity Mock
// =============================================================================

/**
 * Creates a mock ArbitrageOpportunity with sensible defaults.
 * Supports all opportunity types (simple, cross-dex, cross-chain).
 */
export function createMockStrategyOpportunity(
  overrides: Partial<ArbitrageOpportunity> = {}
): ArbitrageOpportunity {
  return {
    id: 'test-opp-123',
    type: 'simple',
    buyChain: 'ethereum',
    sellChain: 'ethereum',
    buyDex: 'uniswap',
    sellDex: 'sushiswap',
    tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
    amountIn: '1000000000000000000', // 1 ETH
    expectedProfit: 100, // $100
    confidence: 0.95,
    timestamp: Date.now() - 500,
    ...overrides,
  };
}
