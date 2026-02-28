/**
 * FlashbotsProvider Unit Tests
 *
 * Tests the Flashbots MEV protection provider for Ethereum mainnet.
 * Covers constructor validation, transaction submission, simulation,
 * fallback behavior, signature caching, and disposal.
 *
 * @see FlashbotsProvider (shared/core/src/mev-protection/flashbots-provider.ts)
 */

// @ts-nocheck
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ethers } from 'ethers';
import { FlashbotsProvider, createFlashbotsProvider } from '../../../src/mev-protection/flashbots-provider';
import { MevProviderConfig } from '../../../src/mev-protection/types';

// =============================================================================
// Mock Factories
// =============================================================================

/**
 * Valid hex bytes for the mock signed transaction.
 * Must be valid hex for ethers.keccak256 used in waitForInclusion.
 */
const MOCK_SIGNED_TX_HEX = '0xaabbccdd';
const MOCK_EXPECTED_TX_HASH = ethers.keccak256(MOCK_SIGNED_TX_HEX);

interface MockEthersProvider {
  getBlockNumber: jest.Mock;
  getTransactionCount: jest.Mock;
  getFeeData: jest.Mock;
  estimateGas: jest.Mock;
  getTransactionReceipt: jest.Mock;
  getNetwork: jest.Mock;
}

interface MockWallet {
  address: string;
  signTransaction: jest.Mock;
  sendTransaction: jest.Mock;
}

function createMockEthersProvider(overrides?: Partial<MockEthersProvider>): MockEthersProvider {
  return {
    getBlockNumber: jest.fn().mockResolvedValue(18500000),
    getTransactionCount: jest.fn().mockResolvedValue(42),
    getFeeData: jest.fn().mockResolvedValue({
      maxFeePerGas: ethers.parseUnits('30', 'gwei'),
      maxPriorityFeePerGas: ethers.parseUnits('2', 'gwei'),
      gasPrice: ethers.parseUnits('30', 'gwei'),
    }),
    estimateGas: jest.fn().mockResolvedValue(150000n),
    getTransactionReceipt: jest.fn().mockResolvedValue(null),
    getNetwork: jest.fn().mockResolvedValue({ chainId: 1n }),
    ...overrides,
  };
}

function createMockWallet(address?: string): MockWallet {
  return {
    address: address ?? '0x1234567890123456789012345678901234567890',
    signTransaction: jest.fn().mockResolvedValue(MOCK_SIGNED_TX_HEX),
    sendTransaction: jest.fn().mockResolvedValue({
      hash: '0xpublictxhash',
      wait: jest.fn().mockResolvedValue({
        hash: '0xpublictxhash',
        blockNumber: 18500001,
        status: 1,
      }),
    }),
  };
}

function createSampleTransaction(overrides?: Partial<ethers.TransactionRequest>): ethers.TransactionRequest {
  return {
    to: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    data: '0x12345678',
    value: ethers.parseEther('0.1'),
    ...overrides,
  };
}

function createValidConfig(overrides: Partial<MevProviderConfig> = {}): MevProviderConfig {
  const mockProvider = createMockEthersProvider();
  const mockWallet = createMockWallet();

  return {
    chain: 'ethereum',
    provider: mockProvider as unknown as ethers.JsonRpcProvider,
    wallet: mockWallet as unknown as ethers.Wallet,
    enabled: true,
    flashbotsAuthKey: '0x' + 'a'.repeat(64),
    fallbackToPublic: true,
    chainId: 1,
    ...overrides,
  };
}

// =============================================================================
// Mock Fetch Helpers
// =============================================================================

/**
 * Create a mock fetch that returns a successful Flashbots bundle submission response.
 * On the first call returns eth_callBundle simulation success,
 * on the second call returns eth_sendBundle success,
 * and subsequent calls return flashbots_getBundleStatsV2 / block number etc.
 */
function createMockFetchForBundleSuccess(): jest.Mock {
  return jest.fn()
    .mockResolvedValueOnce({
      // eth_callBundle (simulation)
      ok: true,
      json: jest.fn().mockResolvedValue({
        result: {
          coinbaseDiff: '1000000000000000',
          totalGasUsed: '150000',
          results: [
            { txHash: '0xtxhash1', gasUsed: '150000' },
          ],
        },
      }),
    })
    .mockResolvedValueOnce({
      // eth_sendBundle
      ok: true,
      json: jest.fn().mockResolvedValue({
        result: {
          bundleHash: '0xbundlehash123',
        },
      }),
    })
    .mockResolvedValue({
      // flashbots_getBundleStatsV2 / any subsequent calls
      ok: true,
      json: jest.fn().mockResolvedValue({
        result: {
          isSimulated: true,
          consideredByBuildersAt: [18500001],
        },
      }),
    });
}

/**
 * Create a mock fetch that returns a failed simulation (reverted tx).
 */
function createMockFetchForSimulationFailure(): jest.Mock {
  return jest.fn().mockResolvedValue({
    ok: true,
    json: jest.fn().mockResolvedValue({
      result: {
        results: [
          { txHash: '0xtxhash1', gasUsed: '21000', revert: 'Execution reverted' },
        ],
      },
    }),
  });
}

/**
 * Create a mock fetch that returns a relay error.
 */
function createMockFetchForRelayError(): jest.Mock {
  return jest.fn().mockResolvedValue({
    ok: true,
    json: jest.fn().mockResolvedValue({
      error: {
        message: 'Bundle already submitted',
        code: -32000,
      },
    }),
  });
}

/**
 * Create a mock fetch for submission that succeeds (skip simulation mode).
 * Returns eth_sendBundle success, then inclusion check.
 */
function createMockFetchForSubmissionOnly(): jest.Mock {
  return jest.fn()
    .mockResolvedValueOnce({
      // eth_sendBundle
      ok: true,
      json: jest.fn().mockResolvedValue({
        result: {
          bundleHash: '0xbundlehash456',
        },
      }),
    })
    .mockResolvedValue({
      // Subsequent calls (bundle stats, etc.)
      ok: true,
      json: jest.fn().mockResolvedValue({
        result: {
          isSimulated: true,
          consideredByBuildersAt: [18500001],
        },
      }),
    });
}

// =============================================================================
// Tests
// =============================================================================

describe('FlashbotsProvider', () => {
  let provider: FlashbotsProvider;
  let mockProvider: MockEthersProvider;
  let mockWallet: MockWallet;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    mockProvider = createMockEthersProvider();
    mockWallet = createMockWallet();

    provider = new FlashbotsProvider({
      chain: 'ethereum',
      provider: mockProvider as unknown as ethers.JsonRpcProvider,
      wallet: mockWallet as unknown as ethers.Wallet,
      enabled: true,
      flashbotsAuthKey: '0x' + 'a'.repeat(64),
      fallbackToPublic: true,
      chainId: 1,
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    provider.dispose();
  });

  // ===========================================================================
  // Constructor
  // ===========================================================================

  describe('constructor', () => {
    it('should throw if chain is not ethereum', () => {
      expect(() => {
        new FlashbotsProvider({
          chain: 'bsc',
          provider: mockProvider as unknown as ethers.JsonRpcProvider,
          wallet: mockWallet as unknown as ethers.Wallet,
          enabled: true,
        });
      }).toThrow('FlashbotsProvider is only for Ethereum');
    });

    it('should accept ethereum as chain', () => {
      const p = new FlashbotsProvider({
        chain: 'ethereum',
        provider: mockProvider as unknown as ethers.JsonRpcProvider,
        wallet: mockWallet as unknown as ethers.Wallet,
        enabled: true,
      });
      expect(p.chain).toBe('ethereum');
      expect(p.strategy).toBe('flashbots');
      p.dispose();
    });

    it('should use provided flashbotsAuthKey for auth signer', () => {
      // When a flashbotsAuthKey is provided, it creates a Wallet from it.
      // We verify indirectly: the provider was constructed without throwing,
      // meaning the key was valid and used.
      const p = new FlashbotsProvider({
        chain: 'ethereum',
        provider: mockProvider as unknown as ethers.JsonRpcProvider,
        wallet: mockWallet as unknown as ethers.Wallet,
        enabled: true,
        flashbotsAuthKey: '0x' + 'b'.repeat(64),
      });
      expect(p).toBeDefined();
      p.dispose();
    });

    it('should generate random wallet when no authKey provided', () => {
      // Should not throw when flashbotsAuthKey is not provided
      const p = new FlashbotsProvider({
        chain: 'ethereum',
        provider: mockProvider as unknown as ethers.JsonRpcProvider,
        wallet: mockWallet as unknown as ethers.Wallet,
        enabled: true,
        // No flashbotsAuthKey
      });
      expect(p).toBeDefined();
      p.dispose();
    });

    it('should use default relay URL when not specified', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ result: '0x1' }),
      });

      const p = new FlashbotsProvider({
        chain: 'ethereum',
        provider: mockProvider as unknown as ethers.JsonRpcProvider,
        wallet: mockWallet as unknown as ethers.Wallet,
        enabled: true,
        flashbotsAuthKey: '0x' + 'a'.repeat(64),
      });

      // Trigger a relay call via healthCheck and verify default URL
      await p.healthCheck();

      expect(global.fetch).toHaveBeenCalledWith(
        'https://relay.flashbots.net',
        expect.any(Object),
      );
      p.dispose();
    });

    it('should use custom relay URL when specified', async () => {
      const customUrl = 'https://custom-relay.example.com';
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ result: '0x1' }),
      });

      const p = new FlashbotsProvider({
        chain: 'ethereum',
        provider: mockProvider as unknown as ethers.JsonRpcProvider,
        wallet: mockWallet as unknown as ethers.Wallet,
        enabled: true,
        flashbotsAuthKey: '0x' + 'a'.repeat(64),
        flashbotsRelayUrl: customUrl,
      });

      await p.healthCheck();

      expect(global.fetch).toHaveBeenCalledWith(
        customUrl,
        expect.any(Object),
      );
      p.dispose();
    });

    it('should cache chainId from config when provided', async () => {
      const p = new FlashbotsProvider({
        chain: 'ethereum',
        provider: mockProvider as unknown as ethers.JsonRpcProvider,
        wallet: mockWallet as unknown as ethers.Wallet,
        enabled: true,
        flashbotsAuthKey: '0x' + 'a'.repeat(64),
        chainId: 11155111, // Sepolia
      });

      // Prepare a transaction - should use cached chainId without calling getNetwork
      global.fetch = createMockFetchForBundleSuccess();
      mockProvider.getTransactionReceipt.mockResolvedValue({
        hash: '0xtxhash1',
        blockNumber: 18500001,
        status: 1,
      });

      await p.sendProtectedTransaction(createSampleTransaction(), { simulate: false });

      // getNetwork should NOT be called since chainId was provided via config
      expect(mockProvider.getNetwork).not.toHaveBeenCalled();
      p.dispose();
    });
  });

  // ===========================================================================
  // isEnabled
  // ===========================================================================

  describe('isEnabled', () => {
    it('should return true when config.enabled is true', () => {
      expect(provider.isEnabled()).toBe(true);
    });

    it('should return false when config.enabled is false', () => {
      const disabledProvider = new FlashbotsProvider({
        chain: 'ethereum',
        provider: mockProvider as unknown as ethers.JsonRpcProvider,
        wallet: mockWallet as unknown as ethers.Wallet,
        enabled: false,
        flashbotsAuthKey: '0x' + 'a'.repeat(64),
      });
      expect(disabledProvider.isEnabled()).toBe(false);
      disabledProvider.dispose();
    });
  });

  // ===========================================================================
  // sendProtectedTransaction
  // ===========================================================================

  describe('sendProtectedTransaction', () => {
    it('should return failure when disabled without incrementing totalSubmissions', async () => {
      const disabledProvider = new FlashbotsProvider({
        chain: 'ethereum',
        provider: mockProvider as unknown as ethers.JsonRpcProvider,
        wallet: mockWallet as unknown as ethers.Wallet,
        enabled: false,
        flashbotsAuthKey: '0x' + 'a'.repeat(64),
      });

      const result = await disabledProvider.sendProtectedTransaction(createSampleTransaction());

      expect(result.success).toBe(false);
      expect(result.error).toContain('disabled');
      expect(result.strategy).toBe('flashbots');
      expect(result.usedFallback).toBe(false);

      // totalSubmissions should remain 0 when disabled
      const metrics = disabledProvider.getMetrics();
      expect(metrics.totalSubmissions).toBe(0);

      disabledProvider.dispose();
    });

    it('should simulate before submission by default', async () => {
      global.fetch = createMockFetchForBundleSuccess();
      // Set up receipt to return after inclusion check
      mockProvider.getTransactionReceipt.mockResolvedValue({
        hash: '0xtxhash1',
        blockNumber: 18500001,
        status: 1,
      });

      const tx = createSampleTransaction();
      await provider.sendProtectedTransaction(tx);

      // First fetch call should be eth_callBundle (simulation)
      const firstCall = (global.fetch as jest.Mock).mock.calls[0];
      const firstBody = JSON.parse(firstCall[1].body);
      expect(firstBody.method).toBe('eth_callBundle');
    });

    it('should skip simulation when options.simulate is false', async () => {
      global.fetch = createMockFetchForSubmissionOnly();
      mockProvider.getTransactionReceipt.mockResolvedValue({
        hash: '0xtxhash1',
        blockNumber: 18500001,
        status: 1,
      });

      const tx = createSampleTransaction();
      await provider.sendProtectedTransaction(tx, { simulate: false });

      // First fetch call should be eth_sendBundle (skipped simulation)
      const firstCall = (global.fetch as jest.Mock).mock.calls[0];
      const firstBody = JSON.parse(firstCall[1].body);
      expect(firstBody.method).toBe('eth_sendBundle');
    });

    it('should submit bundle to relay and return success on inclusion', async () => {
      global.fetch = createMockFetchForBundleSuccess();
      mockProvider.getTransactionReceipt.mockResolvedValue({
        hash: '0xtxhash1',
        blockNumber: 18500001,
        status: 1,
      });

      const tx = createSampleTransaction();
      const result = await provider.sendProtectedTransaction(tx);

      expect(result.success).toBe(true);
      expect(result.strategy).toBe('flashbots');
      expect(result.bundleHash).toBe('0xbundlehash123');
      expect(result.usedFallback).toBe(false);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should fallback to public mempool when simulation fails', async () => {
      global.fetch = createMockFetchForSimulationFailure();

      const tx = createSampleTransaction();
      const result = await provider.sendProtectedTransaction(tx);

      // Should fallback via wallet.sendTransaction
      expect(mockWallet.sendTransaction).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.usedFallback).toBe(true);
    });

    it('should fallback when bundle submission fails (relay error on all retries)', async () => {
      // Simulation succeeds, but submission always returns relay error
      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          // eth_callBundle (simulation) succeeds
          ok: true,
          json: jest.fn().mockResolvedValue({
            result: {
              coinbaseDiff: '1000000000000000',
              totalGasUsed: '150000',
              results: [{ txHash: '0xtxhash1', gasUsed: '150000' }],
            },
          }),
        })
        .mockResolvedValue({
          // All eth_sendBundle calls fail with relay error
          ok: true,
          json: jest.fn().mockResolvedValue({
            error: { message: 'Bundle rejected', code: -32000 },
          }),
        });

      const tx = createSampleTransaction();
      const result = await provider.sendProtectedTransaction(tx);

      // Should fallback since bundle submission failed
      expect(mockWallet.sendTransaction).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.usedFallback).toBe(true);
    });

    it('should handle fetch network errors and fallback', async () => {
      // Simulation fetch throws network error
      global.fetch = jest.fn().mockRejectedValue(new Error('Network unreachable'));

      const tx = createSampleTransaction();
      const result = await provider.sendProtectedTransaction(tx);

      // Should fallback via wallet.sendTransaction
      expect(mockWallet.sendTransaction).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.usedFallback).toBe(true);
    });

    it('should return failure when fallback is disabled and submission fails', async () => {
      const noFallbackProvider = new FlashbotsProvider({
        chain: 'ethereum',
        provider: mockProvider as unknown as ethers.JsonRpcProvider,
        wallet: mockWallet as unknown as ethers.Wallet,
        enabled: true,
        flashbotsAuthKey: '0x' + 'a'.repeat(64),
        fallbackToPublic: false,
        chainId: 1,
      });

      global.fetch = jest.fn().mockRejectedValue(new Error('Relay down'));

      const tx = createSampleTransaction();
      const result = await noFallbackProvider.sendProtectedTransaction(tx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Fallback disabled');
      expect(result.usedFallback).toBe(false);
      expect(mockWallet.sendTransaction).not.toHaveBeenCalled();

      noFallbackProvider.dispose();
    });

    it('should increment totalSubmissions when enabled', async () => {
      global.fetch = createMockFetchForBundleSuccess();
      mockProvider.getTransactionReceipt.mockResolvedValue({
        hash: '0xtxhash1',
        blockNumber: 18500001,
        status: 1,
      });

      await provider.sendProtectedTransaction(createSampleTransaction());

      const metrics = provider.getMetrics();
      expect(metrics.totalSubmissions).toBe(1);
    });

    it('should increment successfulSubmissions on bundle inclusion', async () => {
      global.fetch = createMockFetchForBundleSuccess();
      mockProvider.getTransactionReceipt.mockResolvedValue({
        hash: '0xtxhash1',
        blockNumber: 18500001,
        status: 1,
      });

      await provider.sendProtectedTransaction(createSampleTransaction());

      const metrics = provider.getMetrics();
      expect(metrics.successfulSubmissions).toBe(1);
      expect(metrics.bundlesIncluded).toBe(1);
    });

    it('should increment bundlesReverted when simulation fails', async () => {
      global.fetch = createMockFetchForSimulationFailure();

      await provider.sendProtectedTransaction(createSampleTransaction());

      const metrics = provider.getMetrics();
      expect(metrics.bundlesReverted).toBe(1);
    });

    it('should use targetBlock from options when provided', async () => {
      global.fetch = createMockFetchForSubmissionOnly();
      mockProvider.getTransactionReceipt.mockResolvedValue({
        hash: '0xtxhash1',
        blockNumber: 19000000,
        status: 1,
      });

      await provider.sendProtectedTransaction(createSampleTransaction(), {
        simulate: false,
        targetBlock: 19000000,
      });

      // Verify eth_sendBundle used the specified targetBlock
      const sendBundleCall = (global.fetch as jest.Mock).mock.calls[0];
      const sendBundleBody = JSON.parse(sendBundleCall[1].body);
      expect(sendBundleBody.params[0].blockNumber).toBe(
        `0x${(19000000).toString(16)}`
      );
    });

    it('should return failure with correct latency when fallback also fails', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Relay down'));
      mockWallet.sendTransaction.mockRejectedValue(new Error('Nonce too low'));

      const tx = createSampleTransaction();
      const result = await provider.sendProtectedTransaction(tx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Protected and fallback both failed');
      expect(result.error).toContain('Relay down');
      expect(result.error).toContain('Nonce too low');
      expect(result.usedFallback).toBe(true);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  // ===========================================================================
  // simulateTransaction
  // ===========================================================================

  describe('simulateTransaction', () => {
    it('should simulate and return success result', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          result: {
            coinbaseDiff: '5000000000000000',
            totalGasUsed: '200000',
            gasFees: '6000000000000',
            results: [
              { txHash: '0xtxhash1', gasUsed: '200000' },
            ],
          },
        }),
      });

      const tx = createSampleTransaction();
      const result = await provider.simulateTransaction(tx);

      expect(result.success).toBe(true);
      expect(result.profit).toBe(5000000000000000n);
      expect(result.gasUsed).toBe(200000n);
      expect(result.coinbaseDiff).toBe(5000000000000000n);
      expect(result.results).toHaveLength(1);
      expect(result.results![0].success).toBe(true);
    });

    it('should return error result on relay failure', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          error: { message: 'Simulation timed out', code: -32000 },
        }),
      });

      const tx = createSampleTransaction();
      const result = await provider.simulateTransaction(tx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Simulation timed out');
    });

    it('should return error result when fetch throws', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Connection reset'));

      const tx = createSampleTransaction();
      const result = await provider.simulateTransaction(tx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection reset');
    });

    it('should return error when simulation response has reverted tx', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          result: {
            results: [
              { txHash: '0xtxhash1', gasUsed: '21000', revert: 'InsufficientProfit()' },
            ],
          },
        }),
      });

      const tx = createSampleTransaction();
      const result = await provider.simulateTransaction(tx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('InsufficientProfit');
    });
  });

  // ===========================================================================
  // healthCheck
  // ===========================================================================

  describe('healthCheck', () => {
    it('should return healthy when relay responds with result', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          result: '0x11A8EA0',
        }),
      });

      const health = await provider.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health.message).toContain('reachable');
    });

    it('should return healthy when relay responds with error (means relay is reachable)', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          error: { message: 'Method not found', code: -32601 },
        }),
      });

      const health = await provider.healthCheck();

      // Even an error response means the relay is reachable
      expect(health.healthy).toBe(true);
    });

    it('should return unhealthy when relay is unreachable', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      const health = await provider.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.message).toContain('Failed to reach');
      expect(health.message).toContain('ECONNREFUSED');
    });

    it('should return unhealthy when relay returns empty response', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({}),
      });

      const health = await provider.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.message).toContain('unexpected response');
    });
  });

  // ===========================================================================
  // dispose
  // ===========================================================================

  describe('dispose', () => {
    it('should clear signature cache', async () => {
      // Make a relay call to populate the signature cache
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ result: '0x1' }),
      });

      await provider.healthCheck();

      // Dispose should clear the cache
      provider.dispose();

      // After dispose, metrics should be reset (verifying super.dispose() was called)
      const metrics = provider.getMetrics();
      expect(metrics.totalSubmissions).toBe(0);
    });

    it('should reset metrics via super.dispose()', async () => {
      // Increment some metrics first
      global.fetch = createMockFetchForSimulationFailure();
      await provider.sendProtectedTransaction(createSampleTransaction());

      const metricsBefore = provider.getMetrics();
      expect(metricsBefore.totalSubmissions).toBeGreaterThan(0);

      provider.dispose();

      const metricsAfter = provider.getMetrics();
      expect(metricsAfter.totalSubmissions).toBe(0);
      expect(metricsAfter.successfulSubmissions).toBe(0);
      expect(metricsAfter.bundlesReverted).toBe(0);
    });
  });

  // ===========================================================================
  // getChainId (tested indirectly)
  // ===========================================================================

  describe('getChainId (indirect)', () => {
    it('should use cached chainId from config and not call getNetwork', async () => {
      // Provider created with chainId: 1 in beforeEach
      global.fetch = createMockFetchForSubmissionOnly();
      mockProvider.getTransactionReceipt.mockResolvedValue({
        hash: '0xtxhash1',
        blockNumber: 18500001,
        status: 1,
      });

      await provider.sendProtectedTransaction(createSampleTransaction(), { simulate: false });

      expect(mockProvider.getNetwork).not.toHaveBeenCalled();
    });

    it('should fetch chainId from provider when not in config', async () => {
      const noChainIdProvider = new FlashbotsProvider({
        chain: 'ethereum',
        provider: mockProvider as unknown as ethers.JsonRpcProvider,
        wallet: mockWallet as unknown as ethers.Wallet,
        enabled: true,
        flashbotsAuthKey: '0x' + 'a'.repeat(64),
        // No chainId
      });

      global.fetch = createMockFetchForSubmissionOnly();
      mockProvider.getTransactionReceipt.mockResolvedValue({
        hash: '0xtxhash1',
        blockNumber: 18500001,
        status: 1,
      });

      await noChainIdProvider.sendProtectedTransaction(
        createSampleTransaction(),
        { simulate: false },
      );

      expect(mockProvider.getNetwork).toHaveBeenCalled();
      noChainIdProvider.dispose();
    });

    it('should cache the fetched chainId for subsequent calls', async () => {
      const noChainIdProvider = new FlashbotsProvider({
        chain: 'ethereum',
        provider: mockProvider as unknown as ethers.JsonRpcProvider,
        wallet: mockWallet as unknown as ethers.Wallet,
        enabled: true,
        flashbotsAuthKey: '0x' + 'a'.repeat(64),
        fallbackToPublic: true,
        // No chainId
      });

      global.fetch = createMockFetchForSubmissionOnly();
      mockProvider.getTransactionReceipt.mockResolvedValue({
        hash: '0xtxhash1',
        blockNumber: 18500001,
        status: 1,
      });

      // First call: should fetch chainId
      await noChainIdProvider.sendProtectedTransaction(
        createSampleTransaction(),
        { simulate: false },
      );

      const getNetworkCallCount = mockProvider.getNetwork.mock.calls.length;
      expect(getNetworkCallCount).toBe(1);

      // Reset fetch for second call
      global.fetch = createMockFetchForSubmissionOnly();

      // Second call: should use cached chainId
      await noChainIdProvider.sendProtectedTransaction(
        createSampleTransaction(),
        { simulate: false },
      );

      // getNetwork should NOT be called again (still 1 call total)
      expect(mockProvider.getNetwork).toHaveBeenCalledTimes(1);

      noChainIdProvider.dispose();
    });
  });

  // ===========================================================================
  // Signature cache
  // ===========================================================================

  describe('signature cache', () => {
    it('should cache auth signatures for the same body', async () => {
      // Use two calls with the same body (e.g., healthCheck twice)
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ result: '0x1' }),
      });
      global.fetch = mockFetch;

      await provider.healthCheck();
      await provider.healthCheck();

      // Both calls should use the relay, but the auth signer's signMessage
      // should only be called once if caching works.
      // We verify indirectly: both calls were made (fetch called twice)
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Both should have the same X-Flashbots-Signature header
      const firstHeaders = mockFetch.mock.calls[0][1].headers;
      const secondHeaders = mockFetch.mock.calls[1][1].headers;

      expect(firstHeaders['X-Flashbots-Signature']).toBeDefined();
      expect(secondHeaders['X-Flashbots-Signature']).toBeDefined();
      expect(firstHeaders['X-Flashbots-Signature']).toBe(
        secondHeaders['X-Flashbots-Signature']
      );
    });

    it('should be cleared on dispose', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ result: '0x1' }),
      });

      // Populate cache
      await provider.healthCheck();

      // Dispose clears the cache
      provider.dispose();

      // After dispose, a new call should require a fresh signature
      // (we just verify no errors occur after dispose + new call)
      await provider.healthCheck();

      expect((global.fetch as jest.Mock)).toHaveBeenCalledTimes(2);
    });
  });

  // ===========================================================================
  // Metrics
  // ===========================================================================

  describe('metrics', () => {
    it('should start with all metrics at zero', () => {
      const metrics = provider.getMetrics();
      expect(metrics.totalSubmissions).toBe(0);
      expect(metrics.successfulSubmissions).toBe(0);
      expect(metrics.failedSubmissions).toBe(0);
      expect(metrics.fallbackSubmissions).toBe(0);
      expect(metrics.bundlesIncluded).toBe(0);
      expect(metrics.bundlesReverted).toBe(0);
    });

    it('should reset metrics correctly', async () => {
      global.fetch = createMockFetchForSimulationFailure();
      await provider.sendProtectedTransaction(createSampleTransaction());

      provider.resetMetrics();

      const metrics = provider.getMetrics();
      expect(metrics.totalSubmissions).toBe(0);
      expect(metrics.failedSubmissions).toBe(0);
    });

    it('should track fallback submissions when fallback succeeds', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Relay down'));

      await provider.sendProtectedTransaction(createSampleTransaction());

      const metrics = provider.getMetrics();
      expect(metrics.totalSubmissions).toBe(1);
      expect(metrics.fallbackSubmissions).toBe(1);
      expect(metrics.successfulSubmissions).toBe(1);
    });

    it('should track failed submissions when both protected and fallback fail', async () => {
      const noFallbackProvider = new FlashbotsProvider({
        chain: 'ethereum',
        provider: mockProvider as unknown as ethers.JsonRpcProvider,
        wallet: mockWallet as unknown as ethers.Wallet,
        enabled: true,
        flashbotsAuthKey: '0x' + 'a'.repeat(64),
        fallbackToPublic: false,
        chainId: 1,
      });

      global.fetch = jest.fn().mockRejectedValue(new Error('Relay down'));

      await noFallbackProvider.sendProtectedTransaction(createSampleTransaction());

      const metrics = noFallbackProvider.getMetrics();
      expect(metrics.totalSubmissions).toBe(1);
      expect(metrics.failedSubmissions).toBe(1);
      expect(metrics.successfulSubmissions).toBe(0);

      noFallbackProvider.dispose();
    });
  });

  // ===========================================================================
  // createFlashbotsProvider factory
  // ===========================================================================

  describe('createFlashbotsProvider', () => {
    it('should create a FlashbotsProvider instance', () => {
      const config = createValidConfig();
      const p = createFlashbotsProvider(config);

      expect(p).toBeInstanceOf(FlashbotsProvider);
      expect(p.chain).toBe('ethereum');
      expect(p.strategy).toBe('flashbots');
      p.dispose();
    });
  });
});
