/**
 * Provider Mock Factory
 *
 * Centralized ethers.js provider mocking for tests across the codebase.
 * Reduces duplication across test files and provides consistent behavior.
 *
 * Usage:
 * ```typescript
 * import { createMockProvider, createMockWallet } from '@arbitrage/test-utils';
 *
 * const provider = createMockProvider();
 * const wallet = createMockWallet(provider);
 * ```
 *
 * @see ADR-009: Test Architecture
 */

import { ethers } from 'ethers';

// =============================================================================
// Provider Mock Types
// =============================================================================

export interface MockProviderOptions {
  /** Current block number (default: 12345678) */
  blockNumber?: number;
  /** Current nonce for getTransactionCount (default: 10) */
  nonce?: number;
  /** Throw error on getTransactionCount call */
  throwOnNonce?: boolean;
  /** Block timestamp in seconds (default: current time) */
  blockTimestamp?: number;
  /** Max fee per gas in gwei (default: 50) */
  maxFeePerGasGwei?: number;
  /** Max priority fee per gas in gwei (default: 2) */
  maxPriorityFeePerGasGwei?: number;
  /** Gas price in gwei (default: 50) */
  gasPriceGwei?: number;
  /** Estimated gas for transactions (default: 200000) */
  estimatedGas?: bigint;
  /** Chain ID (default: 1) */
  chainId?: number;
  /** Network name (default: 'mainnet') */
  networkName?: string;
}

export interface MockWalletOptions {
  /** Delay before transaction confirmation in ms (default: 10) */
  waitDelayMs?: number;
  /** Make transaction wait reject with error */
  waitShouldReject?: boolean;
  /** Make transaction wait never resolve (timeout simulation) */
  waitShouldTimeout?: boolean;
  /** Custom transaction hash (default: '0xtxhash') */
  transactionHash?: string;
  /** Gas used in receipt (default: 150000) */
  gasUsed?: bigint;
}

export interface MockProvider extends Partial<ethers.JsonRpcProvider> {
  getBlockNumber: jest.Mock;
  getBlock: jest.Mock;
  getTransactionCount: jest.Mock;
  getFeeData: jest.Mock;
  estimateGas: jest.Mock;
  getTransactionReceipt: jest.Mock;
  getNetwork: jest.Mock;
  getBalance: jest.Mock;
  call: jest.Mock;
  _reset: () => void;
}

// =============================================================================
// Provider Mock Factory
// =============================================================================

/**
 * Creates a mock ethers.js JsonRpcProvider with configurable behavior.
 *
 * @param options - Configuration options
 * @returns Mock provider instance
 *
 * @example
 * ```typescript
 * // Basic usage
 * const provider = createMockProvider();
 *
 * // With custom configuration
 * const provider = createMockProvider({
 *   blockNumber: 15000000,
 *   nonce: 5,
 *   chainId: 56, // BSC
 * });
 *
 * // Simulate network error on nonce fetch
 * const provider = createMockProvider({ throwOnNonce: true });
 * ```
 */
export function createMockProvider(options: MockProviderOptions = {}): MockProvider {
  const config = {
    blockNumber: 12345678,
    nonce: 10,
    throwOnNonce: false,
    blockTimestamp: Math.floor(Date.now() / 1000),
    maxFeePerGasGwei: 50,
    maxPriorityFeePerGasGwei: 2,
    gasPriceGwei: 50,
    estimatedGas: 200000n,
    chainId: 1,
    networkName: 'mainnet',
    ...options,
  };

  const getTransactionCountMock = config.throwOnNonce
    ? jest.fn().mockRejectedValue(new Error('Network error'))
    : jest.fn().mockResolvedValue(config.nonce);

  const provider: MockProvider = {
    getBlockNumber: jest.fn().mockResolvedValue(config.blockNumber),
    getBlock: jest.fn().mockResolvedValue({
      number: config.blockNumber,
      timestamp: config.blockTimestamp,
      transactions: [],
      hash: '0x' + 'a'.repeat(64),
      parentHash: '0x' + 'b'.repeat(64),
    }),
    getTransactionCount: getTransactionCountMock,
    getFeeData: jest.fn().mockResolvedValue({
      maxFeePerGas: ethers.parseUnits(config.maxFeePerGasGwei.toString(), 'gwei'),
      maxPriorityFeePerGas: ethers.parseUnits(config.maxPriorityFeePerGasGwei.toString(), 'gwei'),
      gasPrice: ethers.parseUnits(config.gasPriceGwei.toString(), 'gwei'),
    }),
    estimateGas: jest.fn().mockResolvedValue(config.estimatedGas),
    getTransactionReceipt: jest.fn().mockResolvedValue({
      hash: '0x' + '1'.repeat(64),
      blockNumber: config.blockNumber + 1,
      gasUsed: 150000n,
      gasPrice: ethers.parseUnits(config.gasPriceGwei.toString(), 'gwei'),
      status: 1,
    }),
    getNetwork: jest.fn().mockResolvedValue({
      chainId: BigInt(config.chainId),
      name: config.networkName,
    }),
    getBalance: jest.fn().mockResolvedValue(ethers.parseEther('10')),
    call: jest.fn().mockResolvedValue('0x'),
    _reset: () => {
      provider.getBlockNumber.mockClear();
      provider.getBlock.mockClear();
      provider.getTransactionCount.mockClear();
      provider.getFeeData.mockClear();
      provider.estimateGas.mockClear();
      provider.getTransactionReceipt.mockClear();
      provider.getNetwork.mockClear();
      provider.getBalance.mockClear();
      provider.call.mockClear();
    },
  };

  return provider;
}

// =============================================================================
// Wallet Mock Factory
// =============================================================================

/**
 * Creates a mock ethers.js Wallet with configurable transaction behavior.
 *
 * @param provider - Mock provider to connect wallet to
 * @param options - Configuration options
 * @returns Mock wallet instance
 *
 * @example
 * ```typescript
 * // Basic usage
 * const provider = createMockProvider();
 * const wallet = createMockWallet(provider);
 *
 * // Simulate transaction rejection
 * const wallet = createMockWallet(provider, { waitShouldReject: true });
 *
 * // Simulate transaction timeout
 * const wallet = createMockWallet(provider, { waitShouldTimeout: true });
 * ```
 */
export function createMockWallet(
  provider: MockProvider | ethers.JsonRpcProvider,
  options: MockWalletOptions = {}
): ethers.Wallet {
  const config = {
    waitDelayMs: 10,
    waitShouldReject: false,
    waitShouldTimeout: false,
    transactionHash: '0xtxhash',
    gasUsed: 150000n,
    ...options,
  };

  // Use a deterministic test private key
  const privateKey = '0x' + '1'.repeat(64);
  const wallet = new ethers.Wallet(privateKey, provider as ethers.JsonRpcProvider);

  jest.spyOn(wallet, 'signTransaction').mockResolvedValue('0xsignedtx123');

  // Configure wait function behavior based on options
  const waitFn = config.waitShouldTimeout
    ? jest.fn(() => new Promise(() => { /* never resolves - simulates timeout */ }))
    : config.waitShouldReject
      ? jest.fn().mockRejectedValue(new Error('Transaction reverted'))
      : jest.fn(() =>
          new Promise((resolve) =>
            setTimeout(() => resolve({
              hash: config.transactionHash,
              blockNumber: 12345679,
              gasUsed: config.gasUsed,
              gasPrice: ethers.parseUnits('50', 'gwei'),
              status: 1,
            }), config.waitDelayMs)
          )
        );

  jest.spyOn(wallet, 'sendTransaction').mockResolvedValue({
    hash: config.transactionHash,
    wait: waitFn,
  } as unknown as ethers.TransactionResponse);

  return wallet;
}

// =============================================================================
// Chain-Specific Provider Factories
// =============================================================================

/**
 * Creates a mock provider configured for Ethereum mainnet.
 */
export function createEthereumProvider(overrides: Partial<MockProviderOptions> = {}): MockProvider {
  return createMockProvider({
    chainId: 1,
    networkName: 'mainnet',
    maxFeePerGasGwei: 50,
    ...overrides,
  });
}

/**
 * Creates a mock provider configured for BSC.
 */
export function createBscProvider(overrides: Partial<MockProviderOptions> = {}): MockProvider {
  return createMockProvider({
    chainId: 56,
    networkName: 'bsc',
    maxFeePerGasGwei: 5,
    gasPriceGwei: 5,
    ...overrides,
  });
}

/**
 * Creates a mock provider configured for Arbitrum.
 */
export function createArbitrumProvider(overrides: Partial<MockProviderOptions> = {}): MockProvider {
  return createMockProvider({
    chainId: 42161,
    networkName: 'arbitrum',
    maxFeePerGasGwei: 1,
    gasPriceGwei: 1,
    ...overrides,
  });
}

/**
 * Creates a mock provider configured for Polygon.
 */
export function createPolygonProvider(overrides: Partial<MockProviderOptions> = {}): MockProvider {
  return createMockProvider({
    chainId: 137,
    networkName: 'polygon',
    maxFeePerGasGwei: 100,
    gasPriceGwei: 100,
    ...overrides,
  });
}

// =============================================================================
// Test Utilities
// =============================================================================

/**
 * Creates a mock contract call response for testing.
 *
 * @param response - The response data to return
 * @returns Encoded response suitable for provider.call()
 */
export function createMockContractCallResponse(response: string): string {
  return response.startsWith('0x') ? response : `0x${response}`;
}

/**
 * Resets all mock function call counts on a provider.
 *
 * @param provider - The mock provider to reset
 */
export function resetMockProvider(provider: MockProvider): void {
  provider._reset();
}
