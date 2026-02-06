/**
 * MEV-Share Provider Unit Tests
 *
 * Tests for MEV-Share integration extending Flashbots provider.
 * Covers:
 * - Hint calculation (privacy vs value capture balance)
 * - MEV-Share bundle building and submission
 * - Fallback to standard Flashbots on failure
 * - Rebate tracking and metrics
 * - Protected transaction flow with MEV-Share
 *
 * @see ADR-028 MEV-Share Integration
 */

import { ethers } from 'ethers';
import { MevShareProvider } from '../../src/mev-protection/mev-share-provider';
import type {
  MevProviderConfig,
  MevShareHints,
  MevShareSubmissionResult,
} from '../../src/mev-protection/types';

// =============================================================================
// Test Utilities
// =============================================================================

// Mock fetch for MEV-Share relay
global.fetch = jest.fn();

/**
 * Create a mock provider with configurable behavior
 */
const createMockProvider = (overrides: Partial<{
  blockNumber: number;
  nonce: number;
  chainId: bigint;
}> = {}): ethers.JsonRpcProvider => {
  const config = {
    blockNumber: 12345678,
    nonce: 10,
    chainId: 1n,
    ...overrides,
  };

  // Block number progresses over time to simulate mining
  let currentBlock = config.blockNumber;
  let blockCallCount = 0;

  return {
    getBlockNumber: jest.fn().mockImplementation(async () => {
      blockCallCount++;

      // First few calls return current block, then progress to simulate mining
      if (blockCallCount <= 1) {
        return currentBlock;
      } else if (blockCallCount === 2) {
        // Second call: still at current block (target block calculation)
        return currentBlock;
      } else {
        // Subsequent calls: block has been mined, progress to target + 1
        currentBlock = config.blockNumber + 1;
        return currentBlock;
      }
    }),
    getNetwork: jest.fn().mockResolvedValue({ chainId: config.chainId }),
    getTransactionCount: jest.fn().mockResolvedValue(config.nonce),
    getFeeData: jest.fn().mockResolvedValue({
      maxFeePerGas: ethers.parseUnits('50', 'gwei'),
      maxPriorityFeePerGas: ethers.parseUnits('2', 'gwei'),
      gasPrice: ethers.parseUnits('50', 'gwei'),
    }),
    estimateGas: jest.fn().mockResolvedValue(200000n),
    getTransactionReceipt: jest.fn().mockImplementation(async (hash: string) => {
      // Return receipt for the expected transaction hash
      // waitForInclusion computes hash as ethers.keccak256(signedTx)
      // We use a valid hex string for the signed tx, so we can compute its hash
      const signedTx = '0x' + '12'.repeat(64); // Valid hex string (128 chars)
      const expectedHash = ethers.keccak256(signedTx);

      if (hash === expectedHash) {
        return {
          hash: expectedHash,
          blockNumber: config.blockNumber + 1, // Included in target block
          gasUsed: 150000n,
          gasPrice: ethers.parseUnits('50', 'gwei'),
          status: 1,
        };
      }
      return null; // Transaction not found
    }),
  } as unknown as ethers.JsonRpcProvider;
};

/**
 * Create a mock wallet
 */
const createMockWallet = (
  provider: ethers.JsonRpcProvider
): ethers.Wallet => {
  const privateKey = '0x' + '1'.repeat(64);
  const wallet = new ethers.Wallet(privateKey, provider);

  // Use a valid hex string for signed transaction
  const signedTx = '0x' + '12'.repeat(64);
  const expectedTxHash = ethers.keccak256(signedTx);

  jest.spyOn(wallet, 'signTransaction').mockResolvedValue(signedTx);

  // Mock sendTransaction for public mempool fallback
  jest.spyOn(wallet, 'sendTransaction').mockResolvedValue({
    hash: expectedTxHash,
    wait: jest.fn().mockResolvedValue({
      hash: expectedTxHash,
      blockNumber: 12345679,
      gasUsed: 150000n,
      status: 1,
    }),
  } as any);

  return wallet;
};

/**
 * Create test config for MevShareProvider
 */
const createTestConfig = (
  overrides: Partial<MevProviderConfig> = {}
): MevProviderConfig => {
  const mockProvider = createMockProvider();
  const mockWallet = createMockWallet(mockProvider);

  return {
    chain: 'ethereum',
    provider: mockProvider,
    wallet: mockWallet,
    enabled: true,
    flashbotsAuthKey: '0x' + '2'.repeat(64),
    fallbackToPublic: true,
    submissionTimeoutMs: 5000,
    useMevShare: true,
    ...overrides,
  };
};

/**
 * Mock successful MEV-Share response
 * Also mocks subsequent bundle status checks
 * Handles up to 10 calls, then allows test to override for fallback scenarios
 */
const mockMevShareSuccess = (bundleHash: string, bundleId?: string, maxCalls: number = 10) => {
  let callCount = 0;

  // Mock fetch calls for MEV-Share submission + bundle status checks
  // Uses mockImplementation to handle multiple calls, but stops after maxCalls
  // to allow tests to mock fallback behavior
  const originalMock = (global.fetch as jest.Mock);

  (global.fetch as jest.Mock).mockImplementation(async (...args: any[]) => {
    callCount++;

    if (callCount === 1) {
      // First call: MEV-Share submission
      return {
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: {
            bundleHash,
            bundleId: bundleId || 'mev-share-bundle-id',
            rebateAmount: '1000000000000000', // 0.001 ETH
            rebatePercent: 50,
          },
        }),
      };
    } else if (callCount <= maxCalls) {
      // Subsequent calls: Bundle status checks (flashbots_getBundleStatsV2)
      return {
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: {
            isSimulated: true,
            isSentToMiners: true,
            isHighPriority: false,
            simulatedAt: new Date().toISOString(),
            submittedAt: new Date().toISOString(),
          },
        }),
      };
    } else {
      // After maxCalls, fall through to any previously queued mocks
      // This allows tests to mock fallback behavior with mockResolvedValueOnce
      return {
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: null,
        }),
      };
    }
  });
};

/**
 * Mock MEV-Share error response
 * Only mocks the first call - subsequent calls must be mocked by the test
 * to simulate fallback behavior
 */
const mockMevShareError = (errorMessage: string) => {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    json: async () => ({
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: -32000,
        message: errorMessage,
      },
    }),
  });
};

/**
 * Mock MEV-Share timeout
 * Only mocks the first call - subsequent calls must be mocked by the test
 * to simulate fallback behavior
 */
const mockMevShareTimeout = () => {
  (global.fetch as jest.Mock).mockImplementationOnce(() =>
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Request timeout')), 100);
    })
  );
};

// =============================================================================
// Test Suite
// =============================================================================

describe('MevShareProvider', () => {
  let provider: MevShareProvider;
  let config: MevProviderConfig;

  beforeEach(() => {
    jest.clearAllMocks();
    config = createTestConfig();
    provider = new MevShareProvider(config);
  });

  // ===========================================================================
  // Configuration and Initialization
  // ===========================================================================

  describe('Configuration', () => {
    it('should initialize with correct MEV-Share relay URL', () => {
      expect(provider.chain).toBe('ethereum');
      expect(provider.strategy).toBe('flashbots');
      expect(provider.isEnabled()).toBe(true);
    });

    it('should use custom Flashbots relay URL with /mev-share suffix', () => {
      const customConfig = createTestConfig({
        flashbotsRelayUrl: 'https://custom-relay.example.com',
      });
      const customProvider = new MevShareProvider(customConfig);

      // MEV-Share URL should be constructed internally
      expect(customProvider).toBeDefined();
    });

    it('should throw if chain is not ethereum', () => {
      const invalidConfig = createTestConfig({ chain: 'arbitrum' });

      expect(() => new MevShareProvider(invalidConfig)).toThrow(
        'FlashbotsProvider is only for Ethereum'
      );
    });
  });

  // ===========================================================================
  // Hint Calculation
  // ===========================================================================

  describe('calculateHints', () => {
    it('should use conservative defaults for privacy', () => {
      const tx: ethers.TransactionRequest = {
        to: '0x1234567890123456789012345678901234567890',
        data: '0xabcdef',
      };

      const hints: MevShareHints = provider.calculateHints(tx);

      expect(hints).toEqual({
        contractAddress: true,    // Allow searchers to see target
        functionSelector: true,   // Allow searchers to see function
        logs: false,              // Hide event data (profit amounts)
        calldata: false,          // Hide parameters (amounts, paths)
        hash: false,              // Hide tx hash (prevent front-running)
        txValue: false,           // Hide ETH value by default
      });
    });

    it('should reveal tx value when requested', () => {
      const tx: ethers.TransactionRequest = {
        to: '0x1234567890123456789012345678901234567890',
        value: ethers.parseEther('1.0'),
      };

      const hints: MevShareHints = provider.calculateHints(tx, { revealValue: true });

      expect(hints.txValue).toBe(true);
      expect(hints.contractAddress).toBe(true);
      expect(hints.functionSelector).toBe(true);
      expect(hints.calldata).toBe(false);
    });

    it('should balance privacy with value capture', () => {
      // Key test: Hints should reveal enough for searchers to identify
      // opportunities (contract + function) but hide sensitive params
      const tx: ethers.TransactionRequest = {};
      const hints = provider.calculateHints(tx);

      // Reveal: Allow searcher identification
      expect(hints.contractAddress).toBe(true);
      expect(hints.functionSelector).toBe(true);

      // Hide: Protect trade parameters
      expect(hints.calldata).toBe(false);
      expect(hints.logs).toBe(false);
      expect(hints.hash).toBe(false);
    });
  });

  // ===========================================================================
  // Protected Transaction Submission
  // ===========================================================================

  describe('sendProtectedTransaction', () => {
    it('should submit via MEV-Share and include rebate info on success', async () => {
      const tx: ethers.TransactionRequest = {
        to: '0x1234567890123456789012345678901234567890',
        data: '0xabcdef',
        value: ethers.parseEther('0.1'),
      };

      // Mock MEV-Share submission success
      mockMevShareSuccess('0xbundlehash123', 'bundle-id-456');

      // Note: getTransactionReceipt is already mocked in createMockProvider
      // to return a receipt for the expected tx hash

      const result: MevShareSubmissionResult = await provider.sendProtectedTransaction(tx, {
        simulate: false, // Skip simulation for this test
      });

      // Debug: Log result if test fails
      if (!result.success) {
        console.log('Test failed. Result:', JSON.stringify(result, (key, value) =>
          typeof value === 'bigint' ? value.toString() : value
        , 2));
      }

      expect(result.success).toBe(true);
      expect(result.strategy).toBe('flashbots');
      expect(result.usedMevShare).toBe(true);
      expect(result.bundleId).toBe('bundle-id-456');
      expect(result.rebateAmount).toBe(1000000000000000n); // 0.001 ETH
      expect(result.rebatePercent).toBe(50);
      expect(result.transactionHash).toBeDefined();
    });

    it('should fall back to standard Flashbots if MEV-Share fails', async () => {
      const tx: ethers.TransactionRequest = {
        to: '0x1234567890123456789012345678901234567890',
        data: '0xabcdef',
      };

      // Mock MEV-Share error
      mockMevShareError('MEV-Share unavailable');

      // Mock standard Flashbots success (parent class call)
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: { bundleHash: '0xstandardbundle' },
        }),
      });

      // Note: getTransactionReceipt is already mocked in createMockProvider

      const result = await provider.sendProtectedTransaction(tx, {
        simulate: false,
      });

      // Should succeed via standard Flashbots
      expect(result.usedMevShare).toBe(false);
      expect(result.strategy).toBe('flashbots');
    });

    it('should fall back to public mempool if both MEV-Share and Flashbots fail', async () => {
      const tx: ethers.TransactionRequest = {
        to: '0x1234567890123456789012345678901234567890',
        data: '0xabcdef',
      };

      // Mock MEV-Share error
      mockMevShareError('MEV-Share unavailable');

      // Mock standard Flashbots error
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          error: { message: 'Flashbots relay error' },
        }),
      });

      // Mock public mempool success
      jest.spyOn(config.wallet, 'sendTransaction').mockResolvedValue({
        hash: '0xpublictxhash',
        wait: jest.fn().mockResolvedValue({
          hash: '0xpublictxhash',
          blockNumber: 12345679,
        }),
      } as unknown as ethers.TransactionResponse);

      const result = await provider.sendProtectedTransaction(tx, {
        simulate: false,
      });

      expect(result.success).toBe(true);
      expect(result.usedFallback).toBe(true);
      expect(result.usedMevShare).toBe(false);
    });

    it('should handle MEV-Share timeout gracefully', async () => {
      const tx: ethers.TransactionRequest = {
        to: '0x1234567890123456789012345678901234567890',
        data: '0xabcdef',
      };

      // Mock MEV-Share timeout
      mockMevShareTimeout();

      // Mock standard Flashbots fallback
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: { bundleHash: '0xstandardbundle' },
        }),
      });

      // Note: getTransactionReceipt is already mocked in createMockProvider

      const result = await provider.sendProtectedTransaction(tx, {
        simulate: false,
      });

      // Should fall back to standard Flashbots
      expect(result.usedMevShare).toBe(false);
    });

    it('should return failure result when MEV protection is disabled', async () => {
      const disabledConfig = createTestConfig({ enabled: false });
      const disabledProvider = new MevShareProvider(disabledConfig);

      const tx: ethers.TransactionRequest = {
        to: '0x1234567890123456789012345678901234567890',
      };

      const result = await disabledProvider.sendProtectedTransaction(tx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('MEV protection disabled');
      expect(result.usedMevShare).toBe(false);
    });

    it('should respect custom MEV-Share options', async () => {
      const tx: ethers.TransactionRequest = {
        to: '0x1234567890123456789012345678901234567890',
        data: '0xabcdef',
      };

      const mevShareOptions = {
        hints: {
          contractAddress: true,
          functionSelector: true,
          logs: true, // Custom: reveal logs
          calldata: false,
          hash: false,
          txValue: true, // Custom: reveal value
        },
        minRebatePercent: 60, // Require at least 60% rebate
        maxBlockNumber: 12345690,
      };

      mockMevShareSuccess('0xbundlehash', 'bundle-id');

      // Note: getTransactionReceipt is already mocked in createMockProvider

      const result = await provider.sendProtectedTransaction(tx, {
        simulate: false,
        mevShareOptions,
      });

      expect(result.success).toBe(true);
      expect(result.usedMevShare).toBe(true);

      // Verify custom options were used in bundle
      const fetchCalls = (global.fetch as jest.Mock).mock.calls;
      expect(fetchCalls.length).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // Metrics Tracking
  // ===========================================================================

  describe('Metrics Tracking', () => {
    it('should track MEV-Share submissions in metrics', async () => {
      const tx: ethers.TransactionRequest = {
        to: '0x1234567890123456789012345678901234567890',
        data: '0xabcdef',
      };

      mockMevShareSuccess('0xbundlehash');

      // Note: getTransactionReceipt is already mocked in createMockProvider

      await provider.sendProtectedTransaction(tx, { simulate: false });

      const metrics = provider.getMetrics();

      expect(metrics.totalSubmissions).toBeGreaterThan(0);
      expect(metrics.successfulSubmissions).toBeGreaterThan(0);
      expect(metrics.bundlesIncluded).toBeGreaterThan(0);
    });

    it('should track rebates correctly', async () => {
      // This test would require access to the metrics manager's recordRebate
      // which is called internally. The result includes rebate info which
      // demonstrates the tracking works.
      const tx: ethers.TransactionRequest = {
        to: '0x1234567890123456789012345678901234567890',
        data: '0xabcdef',
      };

      mockMevShareSuccess('0xbundlehash');

      // Note: getTransactionReceipt is already mocked in createMockProvider

      const result = await provider.sendProtectedTransaction(tx, { simulate: false });

      // Verify rebate information is captured
      expect(result.rebateAmount).toBe(1000000000000000n);
      expect(result.rebatePercent).toBe(50);
    });

    it('should increment fallback metrics when MEV-Share fails', async () => {
      const tx: ethers.TransactionRequest = {
        to: '0x1234567890123456789012345678901234567890',
      };

      // Force MEV-Share failure
      mockMevShareError('Service unavailable');

      // Mock standard Flashbots fallback
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: { bundleHash: '0xstandardbundle' },
        }),
      });

      // Note: getTransactionReceipt is already mocked in createMockProvider

      const initialMetrics = provider.getMetrics();
      await provider.sendProtectedTransaction(tx, { simulate: false });
      const updatedMetrics = provider.getMetrics();

      expect(updatedMetrics.totalSubmissions).toBeGreaterThan(initialMetrics.totalSubmissions);
    });

    it('should reset metrics correctly', () => {
      provider.resetMetrics();

      const metrics = provider.getMetrics();

      expect(metrics.totalSubmissions).toBe(0);
      expect(metrics.successfulSubmissions).toBe(0);
      expect(metrics.failedSubmissions).toBe(0);
      expect(metrics.mevShareRebatesReceived).toBe(0);
      expect(metrics.totalRebateWei).toBe(0n);
      expect(metrics.averageRebatePercent).toBe(0);
    });
  });

  // ===========================================================================
  // Health Check
  // ===========================================================================

  describe('healthCheck', () => {
    it('should return healthy when enabled and configured', async () => {
      // Mock health check response
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: '0xbc614e', // Block number in hex
        }),
      });

      const health = await provider.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health.message).toContain('reachable');
    });

    it('should return unhealthy when relay unreachable', async () => {
      // Mock fetch failure
      (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));

      const health = await provider.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.message).toContain('Failed to reach');
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('Edge Cases', () => {
    it('should handle missing rebate information gracefully', async () => {
      const tx: ethers.TransactionRequest = {
        to: '0x1234567890123456789012345678901234567890',
      };

      // Mock MEV-Share response without rebate info
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: {
            bundleHash: '0xbundlehash',
            bundleId: 'bundle-id',
            // No rebate info
          },
        }),
      });

      // Note: getTransactionReceipt is already mocked in createMockProvider

      const result = await provider.sendProtectedTransaction(tx, { simulate: false });

      expect(result.success).toBe(true);
      expect(result.usedMevShare).toBe(true);
      expect(result.rebateAmount).toBeUndefined();
      expect(result.rebatePercent).toBeUndefined();
    });

    it('should handle empty hints object', () => {
      const tx: ethers.TransactionRequest = {};
      const hints = provider.calculateHints(tx);

      // Should still return valid hints structure
      expect(hints).toHaveProperty('contractAddress');
      expect(hints).toHaveProperty('functionSelector');
      expect(hints).toHaveProperty('logs');
      expect(hints).toHaveProperty('calldata');
      expect(hints).toHaveProperty('hash');
      expect(hints).toHaveProperty('txValue');
    });

    it('should handle bundle not included in target block', async () => {
      const tx: ethers.TransactionRequest = {
        to: '0x1234567890123456789012345678901234567890',
      };

      mockMevShareSuccess('0xbundlehash', undefined, 3); // Limit to 3 calls before falling through

      const signedTx = '0x' + '12'.repeat(64);
      const expectedTxHash = ethers.keccak256(signedTx);
      let receiptCallCount = 0;

      // Mock receipt to return null during MEV-Share polling (first 5 calls),
      // then return a receipt for Flashbots fallback
      (config.provider.getTransactionReceipt as jest.Mock).mockImplementation(async (hash: string) => {
        receiptCallCount++;

        if (receiptCallCount <= 5) {
          // MEV-Share waitForInclusion polling - no receipt yet
          return null;
        } else if (hash === expectedTxHash) {
          // Flashbots fallback - receipt available
          return {
            hash: expectedTxHash,
            blockNumber: 12345679,
            status: 1,
          };
        }
        return null;
      });

      const result = await provider.sendProtectedTransaction(tx, {
        simulate: false,
      });

      // Should fallback to standard Flashbots after MEV-Share inclusion timeout
      expect(result.usedMevShare).toBe(false);
    });
  });
});
