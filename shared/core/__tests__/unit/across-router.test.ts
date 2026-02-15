/**
 * Across Bridge Router Unit Tests - Phase 2
 *
 * Tests for AcrossRouter cross-chain bridge implementation:
 * - Route validation (including zkSync, Linea support)
 * - Quote generation with route-specific fees
 * - Execution flow via SpokePool depositV3
 * - Status tracking with mutex protection
 * - Memory management (MAX_PENDING_BRIDGES)
 * - Auto-cleanup
 * - ERC20 approval flow
 * - Factory integration with scoring
 *
 * @see shared/core/src/bridge-router/across-router.ts for implementation
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ethers } from 'ethers';

// =============================================================================
// Mock Setup
// =============================================================================

// Mock logger
jest.mock('../../src/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

// Mock bridge-config selectOptimalBridge
const mockSelectOptimalBridge = jest.fn();
jest.mock('@arbitrage/config', () => ({
  selectOptimalBridge: (...args: unknown[]) => mockSelectOptimalBridge(...args),
}));

// Import after mocking
import {
  AcrossRouter,
  createAcrossRouter,
  ACROSS_SPOKEPOOL_ADDRESSES,
  ACROSS_CHAIN_IDS,
  ACROSS_BRIDGE_TIMES,
} from '../../src/bridge-router/across-router';
import {
  BridgeRouterFactory,
  BridgeRouterFactoryConfig,
  BRIDGE_DEFAULTS,
} from '../../src/bridge-router';
import type { BridgeQuote, IBridgeRouter } from '../../src/bridge-router/types';

// =============================================================================
// Test Utilities
// =============================================================================

/**
 * Type-safe accessor for AcrossRouter internals in tests.
 */
function getRouterInternals(router: AcrossRouter) {
  return router as unknown as {
    pendingBridges: Map<string, {
      status: string;
      sourceTxHash: string;
      sourceChain: string;
      destChain: string;
      startTime: number;
      destTxHash?: string;
      amountReceived?: string;
      error?: string;
      failReason?: 'timeout' | 'execution_error' | 'unknown';
    }>;
    bridgesMutex: { runExclusive: <T>(fn: () => Promise<T>) => Promise<T> };
    approvalMutexes: Map<string, unknown>;
  };
}

/**
 * Create a mock ethers Provider
 */
function createMockProvider(): jest.Mocked<ethers.Provider> {
  return {
    getBlockNumber: jest.fn(() => Promise.resolve(12345678)),
    getNetwork: jest.fn(() => Promise.resolve({ chainId: 1n, name: 'mainnet' })),
    getBalance: jest.fn(() => Promise.resolve(1000000000000000000n)),
    call: jest.fn(() => Promise.resolve('0x')),
    estimateGas: jest.fn(() => Promise.resolve(200000n)),
    getBlock: jest.fn(() => Promise.resolve(null)),
    getTransaction: jest.fn(() => Promise.resolve(null)),
    getTransactionReceipt: jest.fn(() => Promise.resolve(null)),
    getLogs: jest.fn(() => Promise.resolve([])),
    on: jest.fn(),
    off: jest.fn(),
    once: jest.fn(),
    emit: jest.fn(() => false),
    listenerCount: jest.fn(() => 0),
    listeners: jest.fn(() => []),
    removeAllListeners: jest.fn(),
  } as unknown as jest.Mocked<ethers.Provider>;
}

/**
 * Create a mock ethers Wallet
 */
function createMockWallet(provider: ethers.Provider): jest.Mocked<ethers.Wallet> {
  const mockWallet = {
    address: '0x1234567890123456789012345678901234567890',
    provider,
    getAddress: jest.fn(() => Promise.resolve('0x1234567890123456789012345678901234567890')),
    signMessage: jest.fn(() => Promise.resolve('0xsignature')),
    signTransaction: jest.fn(() => Promise.resolve('0xsignedtx')),
    sendTransaction: jest.fn(() => Promise.resolve({
      hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      wait: jest.fn(() => Promise.resolve({
        hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        status: 1,
        gasUsed: 150000n,
      })),
    })),
    estimateGas: jest.fn(() => Promise.resolve(200000n)),
    connect: jest.fn(),
  } as unknown as jest.Mocked<ethers.Wallet>;
  return mockWallet;
}

/**
 * Create a valid Across test quote
 */
function createTestQuote(overrides: Partial<BridgeQuote> = {}): BridgeQuote {
  return {
    protocol: 'across',
    sourceChain: 'arbitrum',
    destChain: 'optimism',
    token: 'USDC',
    amountIn: '1000000000', // 1000 USDC (6 decimals)
    amountOut: '996500000', // After 3bps fee (L2-L2) and slippage
    bridgeFee: '300000', // 3 bps of 1000 USDC
    gasFee: '0', // Across has no separate protocol gas fee
    totalFee: '0', // Same as gasFee
    estimatedTimeSeconds: 60,
    expiresAt: Date.now() + BRIDGE_DEFAULTS.quoteValidityMs,
    valid: true,
    ...overrides,
  };
}

// =============================================================================
// Test Suites
// =============================================================================

describe('AcrossRouter', () => {
  let router: AcrossRouter;
  let mockProvider: jest.Mocked<ethers.Provider>;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockProvider = createMockProvider();
    const providers = new Map<string, ethers.Provider>();
    providers.set('ethereum', mockProvider);
    providers.set('arbitrum', mockProvider);
    providers.set('optimism', mockProvider);
    providers.set('base', mockProvider);
    providers.set('polygon', mockProvider);
    providers.set('zksync', mockProvider);
    providers.set('linea', mockProvider);

    router = new AcrossRouter(providers);
  });

  afterEach(() => {
    router.dispose();
    jest.useRealTimers();
  });

  // ===========================================================================
  // Protocol Identity Tests
  // ===========================================================================

  describe('protocol identity', () => {
    it('should have protocol set to "across"', () => {
      expect(router.protocol).toBe('across');
    });

    it('should implement IBridgeRouter interface', () => {
      const bridgeRouter: IBridgeRouter = router;
      expect(typeof bridgeRouter.quote).toBe('function');
      expect(typeof bridgeRouter.execute).toBe('function');
      expect(typeof bridgeRouter.getStatus).toBe('function');
      expect(typeof bridgeRouter.isRouteSupported).toBe('function');
      expect(typeof bridgeRouter.getEstimatedTime).toBe('function');
      expect(typeof bridgeRouter.healthCheck).toBe('function');
      expect(typeof bridgeRouter.dispose).toBe('function');
    });
  });

  // ===========================================================================
  // Route Validation Tests
  // ===========================================================================

  describe('isRouteSupported', () => {
    it('should return true for supported Across routes', () => {
      expect(router.isRouteSupported('ethereum', 'arbitrum', 'USDC')).toBe(true);
      expect(router.isRouteSupported('arbitrum', 'optimism', 'USDC')).toBe(true);
      expect(router.isRouteSupported('ethereum', 'base', 'WETH')).toBe(true);
    });

    it('should support zkSync and Linea routes (unlike Stargate)', () => {
      expect(router.isRouteSupported('ethereum', 'zksync', 'USDC')).toBe(true);
      expect(router.isRouteSupported('ethereum', 'linea', 'USDC')).toBe(true);
      expect(router.isRouteSupported('zksync', 'ethereum', 'USDC')).toBe(true);
      expect(router.isRouteSupported('linea', 'ethereum', 'USDC')).toBe(true);
    });

    it('should return false for same chain', () => {
      expect(router.isRouteSupported('ethereum', 'ethereum', 'USDC')).toBe(false);
    });

    it('should return false for unsupported chains', () => {
      expect(router.isRouteSupported('solana', 'ethereum', 'USDC')).toBe(false);
      expect(router.isRouteSupported('ethereum', 'solana', 'USDC')).toBe(false);
    });

    it('should return false for unsupported tokens', () => {
      expect(router.isRouteSupported('ethereum', 'arbitrum', 'DOGE')).toBe(false);
      expect(router.isRouteSupported('ethereum', 'arbitrum', 'SHIB')).toBe(false);
    });

    it('should return false for tokens not supported on a specific chain', () => {
      // USDT is not configured for all chains in Across
      expect(router.isRouteSupported('ethereum', 'zksync', 'USDT')).toBe(false);
    });
  });

  // ===========================================================================
  // Estimated Time Tests
  // ===========================================================================

  describe('getEstimatedTime', () => {
    it('should return configured time for known routes', () => {
      expect(router.getEstimatedTime('ethereum', 'arbitrum')).toBe(ACROSS_BRIDGE_TIMES['ethereum-arbitrum']);
      expect(router.getEstimatedTime('arbitrum', 'optimism')).toBe(ACROSS_BRIDGE_TIMES['arbitrum-optimism']);
    });

    it('should return faster L2-to-L2 times', () => {
      const l2l2Time = router.getEstimatedTime('arbitrum', 'optimism');
      const l1l2Time = router.getEstimatedTime('ethereum', 'arbitrum');
      expect(l2l2Time).toBeLessThan(l1l2Time);
    });

    it('should return default time for unknown routes', () => {
      expect(router.getEstimatedTime('fantom', 'bsc')).toBe(ACROSS_BRIDGE_TIMES.default);
    });
  });

  // ===========================================================================
  // Quote Tests
  // ===========================================================================

  describe('quote', () => {
    it('should return invalid quote for unsupported route', async () => {
      const quote = await router.quote({
        sourceChain: 'solana',
        destChain: 'ethereum',
        token: 'USDC',
        amount: '1000000000',
      });

      expect(quote.valid).toBe(false);
      expect(quote.error).toContain('Route not supported');
    });

    it('should return invalid quote for unregistered provider', async () => {
      // Create a router with no providers to test provider check
      const emptyProviderRouter = new AcrossRouter();

      const quote = await emptyProviderRouter.quote({
        sourceChain: 'ethereum',
        destChain: 'arbitrum',
        token: 'USDC',
        amount: '1000000000',
      });

      expect(quote.valid).toBe(false);
      expect(quote.error).toContain('No provider registered');

      emptyProviderRouter.dispose();
    });

    it('should return valid quote with route-specific fee calculation', async () => {
      const quote = await router.quote({
        sourceChain: 'arbitrum',
        destChain: 'optimism',
        token: 'USDC',
        amount: '1000000000000', // 1,000,000 USDC
      });

      expect(quote.valid).toBe(true);
      expect(quote.protocol).toBe('across');
      expect(quote.sourceChain).toBe('arbitrum');
      expect(quote.destChain).toBe('optimism');
      expect(quote.token).toBe('USDC');
      // L2-L2 route should use 3 bps fee
      expect(BigInt(quote.bridgeFee)).toBe(300000000n); // 3 bps of 1M USDC
      expect(BigInt(quote.gasFee)).toBe(0n); // No extra protocol gas fee
      expect(BigInt(quote.totalFee)).toBe(0n);
    });

    it('should calculate different fees for L1-L2 vs L2-L2 routes', async () => {
      const l1l2Quote = await router.quote({
        sourceChain: 'ethereum',
        destChain: 'arbitrum',
        token: 'USDC',
        amount: '1000000000000', // 1M USDC
      });

      const l2l2Quote = await router.quote({
        sourceChain: 'arbitrum',
        destChain: 'optimism',
        token: 'USDC',
        amount: '1000000000000', // 1M USDC
      });

      // L1-L2 should have higher fee (4 bps) than L2-L2 (3 bps)
      expect(BigInt(l1l2Quote.bridgeFee)).toBeGreaterThan(BigInt(l2l2Quote.bridgeFee));
    });

    it('should include recipient in quote when specified', async () => {
      const recipient = '0x9876543210987654321098765432109876543210';
      const quote = await router.quote({
        sourceChain: 'ethereum',
        destChain: 'arbitrum',
        token: 'USDC',
        amount: '1000000000',
        recipient,
      });

      expect(quote.valid).toBe(true);
      expect(quote.recipient).toBe(recipient);
    });

    it('should apply slippage to output amount', async () => {
      const amount = '1000000000000'; // 1M USDC
      const quote = await router.quote({
        sourceChain: 'ethereum',
        destChain: 'arbitrum',
        token: 'USDC',
        amount,
        slippage: 0.01, // 1% slippage
      });

      expect(quote.valid).toBe(true);
      const amountBigInt = BigInt(amount);
      const feeBps = 4n; // ethereum->arbitrum
      const bridgeFee = amountBigInt * feeBps / 10000n;
      const afterFee = amountBigInt - bridgeFee;
      // With 1% slippage, output should be afterFee * 0.99
      expect(BigInt(quote.amountOut)).toBeLessThan(afterFee);
    });
  });

  // ===========================================================================
  // Execution Tests
  // ===========================================================================

  describe('execute', () => {
    it('should reject invalid quotes', async () => {
      const invalidQuote = createTestQuote({ valid: false });
      const mockWallet = createMockWallet(mockProvider);

      const result = await router.execute({
        quote: invalidQuote,
        wallet: mockWallet,
        provider: mockProvider,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid quote');
    });

    it('should reject expired quotes', async () => {
      const expiredQuote = createTestQuote({
        expiresAt: Date.now() - 1000,
      });
      const mockWallet = createMockWallet(mockProvider);

      const result = await router.execute({
        quote: expiredQuote,
        wallet: mockWallet,
        provider: mockProvider,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Quote expired');
    });

    it('should reject quotes for chains without SpokePool address', async () => {
      const quote = createTestQuote({
        sourceChain: 'unknown-chain',
      });
      const mockWallet = createMockWallet(mockProvider);

      const result = await router.execute({
        quote,
        wallet: mockWallet,
        provider: mockProvider,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No SpokePool address');
    });

    it('should execute ERC20 bridge successfully via depositV3', async () => {
      const mockEncodeFunctionData = jest.fn(() => '0xencodeddata');
      const mockAllowance = jest.fn(() => Promise.resolve(ethers.MaxUint256));

      jest.spyOn(ethers, 'Contract').mockReturnValue({
        interface: { encodeFunctionData: mockEncodeFunctionData },
        allowance: mockAllowance,
        balanceOf: jest.fn(() => Promise.resolve(BigInt('2000000000'))),
      } as any);

      const mockWallet = createMockWallet(mockProvider);
      const quote = createTestQuote();

      const result = await router.execute({
        quote,
        wallet: mockWallet,
        provider: mockProvider,
      });

      expect(result.success).toBe(true);
      expect(result.sourceTxHash).toBeDefined();
      expect(result.bridgeId).toBeDefined();
      expect(result.bridgeId).toContain('across-');

      // Verify pending bridge was tracked
      const status = await router.getStatus(result.bridgeId!);
      expect(status.status).toBe('bridging');
    });

    it('should execute WETH bridge with msg.value for native ETH', async () => {
      const mockEncodeFunctionData = jest.fn(() => '0xencodeddata');

      jest.spyOn(ethers, 'Contract').mockReturnValue({
        interface: { encodeFunctionData: mockEncodeFunctionData },
      } as any);

      const mockWallet = createMockWallet(mockProvider);
      (mockProvider.getBalance as jest.Mock<() => Promise<bigint>>).mockResolvedValue(
        BigInt('2000000000000000000') // 2 ETH
      );
      const wethQuote = createTestQuote({
        token: 'WETH',
        sourceChain: 'ethereum',
        destChain: 'arbitrum',
        amountIn: '1000000000000000000', // 1 ETH
        gasFee: '0',
        totalFee: '0',
      });

      const result = await router.execute({
        quote: wethQuote,
        wallet: mockWallet,
        provider: mockProvider,
      });

      expect(result.success).toBe(true);

      // Verify tx.value = amountIn for WETH (native ETH deposit)
      const sendTxCall = mockWallet.sendTransaction.mock.calls[0]?.[0] as any;
      expect(sendTxCall).toBeDefined();
      expect(sendTxCall.value).toBe(BigInt('1000000000000000000'));
    });

    it('should skip approval for WETH bridge', async () => {
      const mockEncodeFunctionData = jest.fn(() => '0xencodeddata');
      const mockApprove = jest.fn();

      jest.spyOn(ethers, 'Contract').mockReturnValue({
        interface: { encodeFunctionData: mockEncodeFunctionData },
        approve: mockApprove,
      } as any);

      const mockWallet = createMockWallet(mockProvider);
      (mockProvider.getBalance as jest.Mock<() => Promise<bigint>>).mockResolvedValue(
        BigInt('2000000000000000000')
      );
      const wethQuote = createTestQuote({
        token: 'WETH',
        sourceChain: 'ethereum',
        destChain: 'arbitrum',
        amountIn: '1000000000000000000',
      });

      await router.execute({
        quote: wethQuote,
        wallet: mockWallet,
        provider: mockProvider,
      });

      expect(mockApprove).not.toHaveBeenCalled();
    });

    it('should return failure when approval fails', async () => {
      const mockEncodeFunctionData = jest.fn(() => '0xencodeddata');
      const mockAllowance = jest.fn(() => Promise.resolve(0n));
      const mockApprove = jest.fn(() => Promise.reject(new Error('Approval reverted')));

      jest.spyOn(ethers, 'Contract').mockReturnValue({
        interface: { encodeFunctionData: mockEncodeFunctionData },
        allowance: mockAllowance,
        approve: mockApprove,
        balanceOf: jest.fn(() => Promise.resolve(BigInt('2000000000'))),
      } as any);

      const mockWallet = createMockWallet(mockProvider);
      const quote = createTestQuote();

      const result = await router.execute({
        quote,
        wallet: mockWallet,
        provider: mockProvider,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to approve');
    });

    it('should set nonce when provided', async () => {
      const mockEncodeFunctionData = jest.fn(() => '0xencodeddata');
      const mockAllowance = jest.fn(() => Promise.resolve(ethers.MaxUint256));

      jest.spyOn(ethers, 'Contract').mockReturnValue({
        interface: { encodeFunctionData: mockEncodeFunctionData },
        allowance: mockAllowance,
        balanceOf: jest.fn(() => Promise.resolve(BigInt('2000000000'))),
      } as any);

      const mockWallet = createMockWallet(mockProvider);
      const quote = createTestQuote();

      await router.execute({
        quote,
        wallet: mockWallet,
        provider: mockProvider,
        nonce: 42,
      });

      const sendTxCall = mockWallet.sendTransaction.mock.calls[0]?.[0] as any;
      expect(sendTxCall.nonce).toBe(42);
    });
  });

  // ===========================================================================
  // Status Tracking Tests
  // ===========================================================================

  describe('getStatus', () => {
    it('should return failed status for unknown bridge', async () => {
      const status = await router.getStatus('unknown-bridge-id');

      expect(status.status).toBe('failed');
      expect(status.error).toBe('Bridge not found');
    });
  });

  describe('markCompleted', () => {
    it('should mark bridge as completed with dest transaction', async () => {
      const bridgeId = 'across-0xtest123';
      const internals = getRouterInternals(router);

      await internals.bridgesMutex.runExclusive(async () => {
        internals.pendingBridges.set(bridgeId, {
          status: 'bridging',
          sourceTxHash: '0xsourcehash',
          sourceChain: 'arbitrum',
          destChain: 'optimism',
          startTime: Date.now(),
        });
      });

      await router.markCompleted(bridgeId, '0xdesthash', '1000000000');

      const status = await router.getStatus(bridgeId);
      expect(status.status).toBe('completed');
      expect(status.destTxHash).toBe('0xdesthash');
      expect(status.amountReceived).toBe('1000000000');
    });
  });

  describe('markFailed', () => {
    it('should mark bridge as failed with error message', async () => {
      const bridgeId = 'across-0xtest456';
      const internals = getRouterInternals(router);

      await internals.bridgesMutex.runExclusive(async () => {
        internals.pendingBridges.set(bridgeId, {
          status: 'bridging',
          sourceTxHash: '0xsourcehash',
          sourceChain: 'arbitrum',
          destChain: 'optimism',
          startTime: Date.now(),
        });
      });

      await router.markFailed(bridgeId, 'Relayer fill timeout');

      const status = await router.getStatus(bridgeId);
      expect(status.status).toBe('failed');
      expect(status.error).toBe('Relayer fill timeout');
    });
  });

  // ===========================================================================
  // State Transition Tests
  // ===========================================================================

  describe('state transitions', () => {
    it('should no-op when marking already-completed bridge as completed', async () => {
      const bridgeId = 'across-0xcompleted';
      const internals = getRouterInternals(router);

      await internals.bridgesMutex.runExclusive(async () => {
        internals.pendingBridges.set(bridgeId, {
          status: 'bridging',
          sourceTxHash: '0xsrc',
          sourceChain: 'arbitrum',
          destChain: 'optimism',
          startTime: Date.now(),
        });
      });

      await router.markCompleted(bridgeId, '0xdest1', '1000');
      const status1 = await router.getStatus(bridgeId);
      expect(status1.status).toBe('completed');
      expect(status1.destTxHash).toBe('0xdest1');

      // Second complete attempt - should be no-op
      await router.markCompleted(bridgeId, '0xdest2', '2000');
      const status2 = await router.getStatus(bridgeId);
      expect(status2.destTxHash).toBe('0xdest1'); // Unchanged
    });

    it('should allow markCompleted on timeout-failed bridge (recovery)', async () => {
      const bridgeId = 'across-0xtimeout';
      const internals = getRouterInternals(router);

      const oldStartTime = Date.now() - (BRIDGE_DEFAULTS.maxBridgeWaitMs + 1000);
      await internals.bridgesMutex.runExclusive(async () => {
        internals.pendingBridges.set(bridgeId, {
          status: 'bridging',
          sourceTxHash: '0xsrc',
          sourceChain: 'arbitrum',
          destChain: 'optimism',
          startTime: oldStartTime,
        });
      });

      // getStatus triggers timeout
      const statusAfterTimeout = await router.getStatus(bridgeId);
      expect(statusAfterTimeout.status).toBe('failed');
      expect(statusAfterTimeout.error).toContain('timeout');

      // markCompleted should succeed (timeout recovery)
      await router.markCompleted(bridgeId, '0xdest_late', '999000');
      const statusAfterRecovery = await router.getStatus(bridgeId);
      expect(statusAfterRecovery.status).toBe('completed');
      expect(statusAfterRecovery.destTxHash).toBe('0xdest_late');
    });

    it('should reject markFailed on completed bridge', async () => {
      const bridgeId = 'across-0xcompletedfail';
      const internals = getRouterInternals(router);

      await internals.bridgesMutex.runExclusive(async () => {
        internals.pendingBridges.set(bridgeId, {
          status: 'bridging',
          sourceTxHash: '0xsrc',
          sourceChain: 'arbitrum',
          destChain: 'optimism',
          startTime: Date.now(),
        });
      });

      await router.markCompleted(bridgeId, '0xdest', '1000');
      await router.markFailed(bridgeId, 'Late failure');
      const status = await router.getStatus(bridgeId);
      expect(status.status).toBe('completed'); // Still completed
    });
  });

  // ===========================================================================
  // Memory Management Tests
  // ===========================================================================

  describe('cleanup', () => {
    it('should remove old pending bridges', async () => {
      const internals = getRouterInternals(router);

      const oldTime = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago
      await internals.bridgesMutex.runExclusive(async () => {
        internals.pendingBridges.set('old-bridge-1', {
          status: 'bridging',
          sourceTxHash: '0x1',
          sourceChain: 'arbitrum',
          destChain: 'optimism',
          startTime: oldTime,
        });
        internals.pendingBridges.set('recent-bridge', {
          status: 'bridging',
          sourceTxHash: '0x2',
          sourceChain: 'arbitrum',
          destChain: 'optimism',
          startTime: Date.now(),
        });
      });

      await router.cleanup(24 * 60 * 60 * 1000);

      const oldStatus = await router.getStatus('old-bridge-1');
      const recentStatus = await router.getStatus('recent-bridge');

      expect(oldStatus.error).toBe('Bridge not found');
      expect(recentStatus.status).toBe('bridging');
    });
  });

  describe('MAX_PENDING_BRIDGES enforcement', () => {
    it('should evict oldest entry when max is reached', async () => {
      const internals = getRouterInternals(router);
      const MAX_PENDING = 1000;

      await internals.bridgesMutex.runExclusive(async () => {
        for (let i = 0; i < MAX_PENDING; i++) {
          internals.pendingBridges.set(`across-0xbridge${i}`, {
            status: 'bridging',
            sourceTxHash: `0xbridge${i}`,
            sourceChain: 'arbitrum',
            destChain: 'optimism',
            startTime: Date.now() + i,
          });
        }
      });

      expect(internals.pendingBridges.size).toBe(MAX_PENDING);

      // Execute one more bridge
      const mockEncodeFunctionData = jest.fn(() => '0xencodeddata');
      const mockAllowance = jest.fn(() => Promise.resolve(ethers.MaxUint256));
      jest.spyOn(ethers, 'Contract').mockReturnValue({
        interface: { encodeFunctionData: mockEncodeFunctionData },
        allowance: mockAllowance,
        balanceOf: jest.fn(() => Promise.resolve(BigInt('2000000000'))),
      } as any);

      const mockWallet = createMockWallet(mockProvider);
      (mockProvider.getBalance as jest.Mock<() => Promise<bigint>>).mockResolvedValue(
        BigInt('1000000000000000000')
      );
      const quote = createTestQuote();

      const result = await router.execute({
        quote,
        wallet: mockWallet,
        provider: mockProvider,
      });

      expect(result.success).toBe(true);
      expect(internals.pendingBridges.size).toBe(MAX_PENDING);

      // First bridge should be evicted
      const firstStatus = await router.getStatus('across-0xbridge0');
      expect(firstStatus.error).toBe('Bridge not found');
    });
  });

  // ===========================================================================
  // Health Check Tests
  // ===========================================================================

  describe('healthCheck', () => {
    it('should return unhealthy when no providers registered', async () => {
      const emptyRouter = new AcrossRouter();
      const health = await emptyRouter.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.message).toContain('No providers');

      emptyRouter.dispose();
    });

    it('should return healthy when providers are available', async () => {
      const health = await router.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health.message).toContain('operational');
    });

    it('should return unhealthy when provider fails', async () => {
      mockProvider.getBlockNumber.mockRejectedValueOnce(new Error('RPC timeout'));

      const health = await router.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.message).toContain('Health check failed');
    });
  });

  // ===========================================================================
  // Dispose and Factory Function Tests
  // ===========================================================================

  describe('dispose', () => {
    it('should have dispose as a method', () => {
      expect(typeof router.dispose).toBe('function');
    });

    it('should handle dispose called twice without errors', () => {
      router.dispose();
      router.dispose(); // Should not throw
    });
  });

  describe('createAcrossRouter', () => {
    it('should create router without providers', () => {
      const factoryRouter = createAcrossRouter();
      expect(factoryRouter).toBeInstanceOf(AcrossRouter);
      expect(factoryRouter.protocol).toBe('across');
      factoryRouter.dispose();
    });

    it('should create router with providers', () => {
      const providers = new Map<string, ethers.Provider>();
      providers.set('ethereum', createMockProvider());
      const factoryRouter = createAcrossRouter(providers);
      expect(factoryRouter).toBeInstanceOf(AcrossRouter);
      factoryRouter.dispose();
    });
  });

  describe('registerProvider', () => {
    it('should allow registering new providers', async () => {
      const newRouter = createAcrossRouter();
      const ethProvider = createMockProvider();

      newRouter.registerProvider('ethereum', ethProvider);

      const health = await newRouter.healthCheck();
      expect(health.healthy).toBe(true);

      newRouter.dispose();
    });
  });
});

// =============================================================================
// Constants Export Tests
// =============================================================================

describe('Across Router Constants', () => {
  describe('ACROSS_SPOKEPOOL_ADDRESSES', () => {
    it('should have addresses for all supported chains', () => {
      expect(ACROSS_SPOKEPOOL_ADDRESSES.ethereum).toBeDefined();
      expect(ACROSS_SPOKEPOOL_ADDRESSES.arbitrum).toBeDefined();
      expect(ACROSS_SPOKEPOOL_ADDRESSES.optimism).toBeDefined();
      expect(ACROSS_SPOKEPOOL_ADDRESSES.base).toBeDefined();
      expect(ACROSS_SPOKEPOOL_ADDRESSES.polygon).toBeDefined();
      expect(ACROSS_SPOKEPOOL_ADDRESSES.zksync).toBeDefined();
      expect(ACROSS_SPOKEPOOL_ADDRESSES.linea).toBeDefined();
    });

    it('should have valid Ethereum addresses', () => {
      const addressRegex = /^0x[a-fA-F0-9]{40}$/;
      for (const address of Object.values(ACROSS_SPOKEPOOL_ADDRESSES)) {
        expect(address).toMatch(addressRegex);
      }
    });
  });

  describe('ACROSS_CHAIN_IDS', () => {
    it('should have standard EVM chain IDs', () => {
      expect(ACROSS_CHAIN_IDS.ethereum).toBe(1);
      expect(ACROSS_CHAIN_IDS.arbitrum).toBe(42161);
      expect(ACROSS_CHAIN_IDS.optimism).toBe(10);
      expect(ACROSS_CHAIN_IDS.base).toBe(8453);
      expect(ACROSS_CHAIN_IDS.polygon).toBe(137);
      expect(ACROSS_CHAIN_IDS.zksync).toBe(324);
      expect(ACROSS_CHAIN_IDS.linea).toBe(59144);
    });
  });

  describe('ACROSS_BRIDGE_TIMES', () => {
    it('should have reasonable bridge times', () => {
      expect(ACROSS_BRIDGE_TIMES['ethereum-arbitrum']).toBeGreaterThan(0);
      expect(ACROSS_BRIDGE_TIMES['ethereum-arbitrum']).toBeLessThanOrEqual(3600);
    });

    it('should have default time', () => {
      expect(ACROSS_BRIDGE_TIMES.default).toBeDefined();
      expect(ACROSS_BRIDGE_TIMES.default).toBeGreaterThan(0);
    });
  });
});

// =============================================================================
// Factory Integration Tests
// =============================================================================

describe('BridgeRouterFactory with AcrossRouter', () => {
  let factory: BridgeRouterFactory;
  let mockProvider: jest.Mocked<ethers.Provider>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSelectOptimalBridge.mockReset();

    mockProvider = createMockProvider();
    const providers = new Map<string, ethers.Provider>();
    providers.set('ethereum', mockProvider);
    providers.set('arbitrum', mockProvider);
    providers.set('optimism', mockProvider);
    providers.set('zksync', mockProvider);
    providers.set('linea', mockProvider);

    factory = new BridgeRouterFactory({
      defaultProtocol: 'stargate',
      providers,
    });
  });

  afterEach(async () => {
    await factory.dispose();
  });

  it('should have both stargate and across as available protocols', () => {
    const protocols = factory.getAvailableProtocols();
    expect(protocols).toContain('stargate');
    expect(protocols).toContain('across');
  });

  it('should return across router by protocol', () => {
    const acrossRouter = factory.getRouter('across');
    expect(acrossRouter.protocol).toBe('across');
  });

  it('should find Across router for zkSync routes (not supported by Stargate)', () => {
    const result = factory.findSupportedRouter('ethereum', 'zksync', 'USDC');
    expect(result).not.toBeNull();
    expect(result!.protocol).toBe('across');
  });

  it('should find Across router for Linea routes (not supported by Stargate)', () => {
    const result = factory.findSupportedRouter('ethereum', 'linea', 'USDC');
    expect(result).not.toBeNull();
    expect(result!.protocol).toBe('across');
  });

  it('should use scoring when both routers support a route', () => {
    // Both Stargate and Across support ethereum->arbitrum USDC
    mockSelectOptimalBridge.mockReturnValue({
      config: { bridge: 'across' },
      score: 0.95,
    });

    const result = factory.findSupportedRouter(
      'ethereum', 'arbitrum', 'USDC', 10000, 'high'
    );

    expect(mockSelectOptimalBridge).toHaveBeenCalledWith(
      'ethereum', 'arbitrum', 10000, 'high'
    );
    expect(result).not.toBeNull();
    expect(result!.protocol).toBe('across');
  });

  it('should dispose both routers when factory is disposed', async () => {
    const stargateRouter = factory.getRouter('stargate');
    const acrossRouter = factory.getRouter('across');
    const stargateSpy = jest.spyOn(stargateRouter, 'dispose');
    const acrossSpy = jest.spyOn(acrossRouter, 'dispose');

    await factory.dispose();

    expect(stargateSpy).toHaveBeenCalledTimes(1);
    expect(acrossSpy).toHaveBeenCalledTimes(1);
  });

  it('should health check both routers', async () => {
    const results = await factory.healthCheckAll();

    expect(results.stargate).toBeDefined();
    expect(results.across).toBeDefined();
    expect(results.stargate.healthy).toBe(true);
    expect(results.across.healthy).toBe(true);
  });

  it('should track health metrics for both routers', async () => {
    await factory.healthCheckAll();

    const metrics = factory.getHealthMetrics();
    expect(metrics.get('stargate')).toBeDefined();
    expect(metrics.get('across')).toBeDefined();
    expect(metrics.get('across')!.totalChecks).toBe(1);
    expect(metrics.get('across')!.lastHealthy).toBe(true);
  });
});
