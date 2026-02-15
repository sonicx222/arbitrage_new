/**
 * Stargate V2 Bridge Router Unit Tests - Phase 3
 *
 * Tests for StargateV2Router cross-chain bridge implementation:
 * - Route validation (V2 chain support including Linea, zkSync)
 * - Quote generation via quoteSend() with V2 OFT model
 * - Execution flow via send() with SendParam struct
 * - Bus vs Taxi mode selection
 * - V2 LZ endpoint IDs (30xxx series)
 * - Status tracking with mutex protection
 * - Memory management (MAX_PENDING_BRIDGES)
 * - Auto-cleanup
 * - ERC20 approval flow
 * - Factory integration with 3 protocols (V1, Across, V2)
 *
 * @see shared/core/src/bridge-router/stargate-v2-router.ts for implementation
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
  StargateV2Router,
  createStargateV2Router,
  STARGATE_V2_POOL_ADDRESSES,
  STARGATE_V2_ENDPOINT_IDS,
  STARGATE_V2_BRIDGE_TIMES,
} from '../../src/bridge-router/stargate-v2-router';
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
 * Create a typed mock function that accepts any resolved/rejected value.
 * Avoids @jest/globals strict typing where jest.fn() defaults to (...args: never[]) => never.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const typedMock = () => jest.fn() as jest.Mock<(...args: any[]) => any>;

/**
 * Type-safe accessor for StargateV2Router internals in tests.
 */
function getRouterInternals(router: StargateV2Router) {
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
 * Create a valid Stargate V2 test quote
 */
function createTestQuote(overrides: Partial<BridgeQuote> = {}): BridgeQuote {
  return {
    protocol: 'stargate-v2',
    sourceChain: 'arbitrum',
    destChain: 'optimism',
    token: 'USDC',
    amountIn: '1000000000', // 1000 USDC (6 decimals)
    amountOut: '996100000', // After ~4bps fee and slippage
    bridgeFee: '400000', // ~4 bps of 1000 USDC (protocol fee from OFT)
    gasFee: '10000000000000000', // LZ V2 messaging fee (~0.01 ETH)
    totalFee: '10000000000000000', // Same as gasFee
    estimatedTimeSeconds: 60,
    expiresAt: Date.now() + BRIDGE_DEFAULTS.quoteValidityMs,
    valid: true,
    ...overrides,
  };
}

// =============================================================================
// Test Suites
// =============================================================================

describe('StargateV2Router', () => {
  let router: StargateV2Router;
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
    providers.set('bsc', mockProvider);
    providers.set('avalanche', mockProvider);

    router = new StargateV2Router(providers);
  });

  afterEach(() => {
    router.dispose();
    jest.useRealTimers();
  });

  // ===========================================================================
  // Protocol Identity Tests
  // ===========================================================================

  describe('protocol identity', () => {
    it('should have protocol set to "stargate-v2"', () => {
      expect(router.protocol).toBe('stargate-v2');
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
    it('should return true for supported V2 routes', () => {
      expect(router.isRouteSupported('ethereum', 'arbitrum', 'USDC')).toBe(true);
      expect(router.isRouteSupported('arbitrum', 'optimism', 'USDC')).toBe(true);
      expect(router.isRouteSupported('ethereum', 'base', 'ETH')).toBe(true);
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
    });

    it('should return false for tokens not on a specific chain', () => {
      // ETH pools are only on select chains
      expect(router.isRouteSupported('ethereum', 'bsc', 'ETH')).toBe(false);
    });

    it('should use V2 pool addresses for route validation (not V1 pool IDs)', () => {
      // V2 uses per-token pool contracts, not the V1 pool ID model
      const pools = STARGATE_V2_POOL_ADDRESSES;
      expect(pools.USDC).toBeDefined();
      expect(pools.USDT).toBeDefined();
      expect(pools.ETH).toBeDefined();
    });
  });

  // ===========================================================================
  // V2 Endpoint ID Tests
  // ===========================================================================

  describe('V2 endpoint IDs', () => {
    it('should use V2 LZ endpoint IDs (30xxx series)', () => {
      expect(STARGATE_V2_ENDPOINT_IDS.ethereum).toBe(30101);
      expect(STARGATE_V2_ENDPOINT_IDS.arbitrum).toBe(30110);
      expect(STARGATE_V2_ENDPOINT_IDS.optimism).toBe(30111);
      expect(STARGATE_V2_ENDPOINT_IDS.base).toBe(30184);
    });

    it('should have endpoint IDs for all supported chains', () => {
      for (const chain of router.supportedSourceChains) {
        expect(STARGATE_V2_ENDPOINT_IDS[chain]).toBeDefined();
        expect(STARGATE_V2_ENDPOINT_IDS[chain]).toBeGreaterThan(30000);
      }
    });
  });

  // ===========================================================================
  // Estimated Time Tests
  // ===========================================================================

  describe('getEstimatedTime', () => {
    it('should return configured time for known routes', () => {
      expect(router.getEstimatedTime('ethereum', 'arbitrum')).toBe(STARGATE_V2_BRIDGE_TIMES['ethereum-arbitrum']);
      expect(router.getEstimatedTime('arbitrum', 'optimism')).toBe(STARGATE_V2_BRIDGE_TIMES['arbitrum-optimism']);
    });

    it('should be faster than V1 bridge times', () => {
      // V2 uses optimized LZ V2 messaging
      expect(router.getEstimatedTime('ethereum', 'arbitrum')).toBeLessThanOrEqual(120);
    });

    it('should return default time for unknown routes', () => {
      expect(router.getEstimatedTime('fantom', 'linea')).toBe(STARGATE_V2_BRIDGE_TIMES.default);
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
      const emptyProviderRouter = new StargateV2Router();

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

    it('should call quoteSend on V2 pool contract and return valid quote', async () => {
      // Mock the V2 pool contract's quoteSend response
      const mockQuoteSend = typedMock().mockResolvedValue([
        { nativeFee: 10000000000000000n, lzTokenFee: 0n },       // MessagingFee
        { amountSentLD: 1000000000n, amountReceivedLD: 996000000n }, // OFTReceipt
      ]);

      jest.spyOn(ethers, 'Contract').mockReturnValue({
        quoteSend: mockQuoteSend,
      } as any);

      const quote = await router.quote({
        sourceChain: 'ethereum',
        destChain: 'arbitrum',
        token: 'USDC',
        amount: '1000000000', // 1000 USDC
      });

      expect(quote.valid).toBe(true);
      expect(quote.protocol).toBe('stargate-v2');
      expect(quote.sourceChain).toBe('ethereum');
      expect(quote.destChain).toBe('arbitrum');
      expect(quote.token).toBe('USDC');
      // bridgeFee from OFT: amountSentLD - amountReceivedLD
      expect(BigInt(quote.bridgeFee)).toBe(4000000n); // 1000000000 - 996000000
      // gasFee = LZ messaging fee
      expect(BigInt(quote.gasFee)).toBe(10000000000000000n);
      expect(mockQuoteSend).toHaveBeenCalled();
    });

    it('should default to taxi mode in quoteSend call', async () => {
      const mockQuoteSend = typedMock().mockResolvedValue([
        { nativeFee: 10000000000000000n, lzTokenFee: 0n },
        { amountSentLD: 1000000000n, amountReceivedLD: 996000000n },
      ]);

      jest.spyOn(ethers, 'Contract').mockReturnValue({
        quoteSend: mockQuoteSend,
      } as any);

      await router.quote({
        sourceChain: 'ethereum',
        destChain: 'arbitrum',
        token: 'USDC',
        amount: '1000000000',
      });

      // Verify the sendParam passed to quoteSend has taxi mode oftCmd
      const sendParam = mockQuoteSend.mock.calls[0]?.[0];
      expect(sendParam).toBeDefined();
      // Taxi mode: oftCmd should not be empty
      expect(sendParam.oftCmd).not.toBe('0x');
    });

    it('should use bus mode when transferMode is "bus"', async () => {
      const mockQuoteSend = typedMock().mockResolvedValue([
        { nativeFee: 5000000000000000n, lzTokenFee: 0n },  // Lower fee for bus
        { amountSentLD: 1000000000n, amountReceivedLD: 997000000n },
      ]);

      jest.spyOn(ethers, 'Contract').mockReturnValue({
        quoteSend: mockQuoteSend,
      } as any);

      await router.quote({
        sourceChain: 'ethereum',
        destChain: 'arbitrum',
        token: 'USDC',
        amount: '1000000000',
        transferMode: 'bus',
      });

      const sendParam = mockQuoteSend.mock.calls[0]?.[0];
      expect(sendParam).toBeDefined();
      // Bus mode: oftCmd should be empty bytes
      expect(sendParam.oftCmd).toBe('0x');
    });

    it('should include recipient in quote when specified', async () => {
      const mockQuoteSend = typedMock().mockResolvedValue([
        { nativeFee: 10000000000000000n, lzTokenFee: 0n },
        { amountSentLD: 1000000000n, amountReceivedLD: 996000000n },
      ]);

      jest.spyOn(ethers, 'Contract').mockReturnValue({
        quoteSend: mockQuoteSend,
      } as any);

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
      const mockQuoteSend = typedMock().mockResolvedValue([
        { nativeFee: 10000000000000000n, lzTokenFee: 0n },
        { amountSentLD: 1000000000000n, amountReceivedLD: 996000000000n },
      ]);

      jest.spyOn(ethers, 'Contract').mockReturnValue({
        quoteSend: mockQuoteSend,
      } as any);

      const quote = await router.quote({
        sourceChain: 'ethereum',
        destChain: 'arbitrum',
        token: 'USDC',
        amount: '1000000000000',
        slippage: 0.01, // 1%
      });

      expect(quote.valid).toBe(true);
      // Output should be amountReceivedLD * (1 - slippage)
      expect(BigInt(quote.amountOut)).toBeLessThan(996000000000n);
    });

    it('should handle quoteSend failure gracefully', async () => {
      jest.spyOn(ethers, 'Contract').mockReturnValue({
        quoteSend: typedMock().mockRejectedValue(new Error('Contract call reverted')),
      } as any);

      const quote = await router.quote({
        sourceChain: 'ethereum',
        destChain: 'arbitrum',
        token: 'USDC',
        amount: '1000000000',
      });

      expect(quote.valid).toBe(false);
      expect(quote.error).toContain('Quote failed');
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

    it('should execute ERC20 bridge successfully via send()', async () => {
      const mockQuoteSend = typedMock().mockResolvedValue([
        { nativeFee: 10000000000000000n, lzTokenFee: 0n },
        { amountSentLD: 1000000000n, amountReceivedLD: 996000000n },
      ]);
      const mockSend = jest.fn();
      const mockEncodeFunctionData = jest.fn(() => '0xencodeddata');
      const mockAllowance = jest.fn(() => Promise.resolve(ethers.MaxUint256));

      jest.spyOn(ethers, 'Contract').mockReturnValue({
        quoteSend: mockQuoteSend,
        send: mockSend,
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
      expect(result.bridgeId).toContain('stargate-v2-');

      // Verify pending bridge was tracked
      const status = await router.getStatus(result.bridgeId!);
      expect(status.status).toBe('bridging');
    });

    it('should execute ETH bridge with msg.value', async () => {
      const mockEncodeFunctionData = jest.fn(() => '0xencodeddata');

      jest.spyOn(ethers, 'Contract').mockReturnValue({
        interface: { encodeFunctionData: mockEncodeFunctionData },
      } as any);

      const mockWallet = createMockWallet(mockProvider);
      (mockProvider.getBalance as jest.Mock<() => Promise<bigint>>).mockResolvedValue(
        BigInt('2000000000000000000') // 2 ETH
      );
      const ethQuote = createTestQuote({
        token: 'ETH',
        sourceChain: 'ethereum',
        destChain: 'arbitrum',
        amountIn: '1000000000000000000', // 1 ETH
        gasFee: '10000000000000000', // 0.01 ETH LZ fee
        totalFee: '10000000000000000',
      });

      const result = await router.execute({
        quote: ethQuote,
        wallet: mockWallet,
        provider: mockProvider,
      });

      expect(result.success).toBe(true);

      // Verify tx.value = amountIn + LZ fee for native ETH
      const sendTxCall = mockWallet.sendTransaction.mock.calls[0]?.[0] as any;
      expect(sendTxCall).toBeDefined();
      expect(sendTxCall.value).toBe(BigInt('1000000000000000000') + BigInt('10000000000000000'));
    });

    it('should skip approval for ETH bridge', async () => {
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
      const ethQuote = createTestQuote({
        token: 'ETH',
        sourceChain: 'ethereum',
        destChain: 'arbitrum',
        amountIn: '1000000000000000000',
      });

      await router.execute({
        quote: ethQuote,
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
      const bridgeId = 'stargate-v2-0xtest123';
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
      const bridgeId = 'stargate-v2-0xtest456';
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

      await router.markFailed(bridgeId, 'LZ V2 message delivery failed');

      const status = await router.getStatus(bridgeId);
      expect(status.status).toBe('failed');
      expect(status.error).toBe('LZ V2 message delivery failed');
    });
  });

  // ===========================================================================
  // State Transition Tests
  // ===========================================================================

  describe('state transitions', () => {
    it('should no-op when marking already-completed bridge as completed', async () => {
      const bridgeId = 'stargate-v2-0xcompleted';
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
      const bridgeId = 'stargate-v2-0xtimeout';
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
      const bridgeId = 'stargate-v2-0xcompletedfail';
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
          internals.pendingBridges.set(`stargate-v2-0xbridge${i}`, {
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
      const firstStatus = await router.getStatus('stargate-v2-0xbridge0');
      expect(firstStatus.error).toBe('Bridge not found');
    });
  });

  // ===========================================================================
  // Health Check Tests
  // ===========================================================================

  describe('healthCheck', () => {
    it('should return unhealthy when no providers registered', async () => {
      const emptyRouter = new StargateV2Router();
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

  describe('createStargateV2Router', () => {
    it('should create router without providers', () => {
      const factoryRouter = createStargateV2Router();
      expect(factoryRouter).toBeInstanceOf(StargateV2Router);
      expect(factoryRouter.protocol).toBe('stargate-v2');
      factoryRouter.dispose();
    });

    it('should create router with providers', () => {
      const providers = new Map<string, ethers.Provider>();
      providers.set('ethereum', createMockProvider());
      const factoryRouter = createStargateV2Router(providers);
      expect(factoryRouter).toBeInstanceOf(StargateV2Router);
      factoryRouter.dispose();
    });
  });

  describe('registerProvider', () => {
    it('should allow registering new providers', async () => {
      const newRouter = createStargateV2Router();
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

describe('Stargate V2 Router Constants', () => {
  describe('STARGATE_V2_POOL_ADDRESSES', () => {
    it('should have pool addresses for USDC, USDT, and ETH', () => {
      expect(STARGATE_V2_POOL_ADDRESSES.USDC).toBeDefined();
      expect(STARGATE_V2_POOL_ADDRESSES.USDT).toBeDefined();
      expect(STARGATE_V2_POOL_ADDRESSES.ETH).toBeDefined();
    });

    it('should have valid Ethereum addresses', () => {
      const addressRegex = /^0x[a-fA-F0-9]{40}$/;
      for (const [, chains] of Object.entries(STARGATE_V2_POOL_ADDRESSES)) {
        for (const address of Object.values(chains)) {
          expect(address).toMatch(addressRegex);
        }
      }
    });

    it('should have per-token per-chain addresses (V2 model, not V1 single router)', () => {
      // Each token has its own pool contract per chain
      expect(STARGATE_V2_POOL_ADDRESSES.USDC.ethereum).not.toBe(STARGATE_V2_POOL_ADDRESSES.USDT.ethereum);
    });
  });

  describe('STARGATE_V2_ENDPOINT_IDS', () => {
    it('should have V2 LZ endpoint IDs (30xxx series)', () => {
      for (const [, id] of Object.entries(STARGATE_V2_ENDPOINT_IDS)) {
        expect(id).toBeGreaterThanOrEqual(30000);
        expect(id).toBeLessThan(40000);
      }
    });
  });

  describe('STARGATE_V2_BRIDGE_TIMES', () => {
    it('should have reasonable bridge times', () => {
      expect(STARGATE_V2_BRIDGE_TIMES['ethereum-arbitrum']).toBeGreaterThan(0);
      expect(STARGATE_V2_BRIDGE_TIMES['ethereum-arbitrum']).toBeLessThanOrEqual(3600);
    });

    it('should have default time', () => {
      expect(STARGATE_V2_BRIDGE_TIMES.default).toBeDefined();
      expect(STARGATE_V2_BRIDGE_TIMES.default).toBeGreaterThan(0);
    });
  });
});

// =============================================================================
// Factory Integration Tests
// =============================================================================

describe('BridgeRouterFactory with StargateV2Router', () => {
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
    providers.set('base', mockProvider);
    providers.set('polygon', mockProvider);

    factory = new BridgeRouterFactory({
      defaultProtocol: 'stargate',
      providers,
    });
  });

  afterEach(async () => {
    await factory.dispose();
  });

  it('should have stargate, across, and stargate-v2 as available protocols', () => {
    const protocols = factory.getAvailableProtocols();
    expect(protocols).toContain('stargate');
    expect(protocols).toContain('across');
    expect(protocols).toContain('stargate-v2');
  });

  it('should return stargate-v2 router by protocol', () => {
    const v2Router = factory.getRouter('stargate-v2');
    expect(v2Router.protocol).toBe('stargate-v2');
  });

  it('should use scoring when multiple routers (V1, Across, V2) support a route', () => {
    // ethereum->arbitrum USDC is supported by all three
    mockSelectOptimalBridge.mockReturnValue({
      config: { bridge: 'stargate-v2' },
      score: 0.98,
    });

    const result = factory.findSupportedRouter(
      'ethereum', 'arbitrum', 'USDC', 10000, 'high'
    );

    expect(mockSelectOptimalBridge).toHaveBeenCalledWith(
      'ethereum', 'arbitrum', 10000, 'high'
    );
    expect(result).not.toBeNull();
    expect(result!.protocol).toBe('stargate-v2');
  });

  it('should dispose all three routers when factory is disposed', async () => {
    const stargateRouter = factory.getRouter('stargate');
    const acrossRouter = factory.getRouter('across');
    const v2Router = factory.getRouter('stargate-v2');
    const stargateSpy = jest.spyOn(stargateRouter, 'dispose');
    const acrossSpy = jest.spyOn(acrossRouter, 'dispose');
    const v2Spy = jest.spyOn(v2Router, 'dispose');

    await factory.dispose();

    expect(stargateSpy).toHaveBeenCalledTimes(1);
    expect(acrossSpy).toHaveBeenCalledTimes(1);
    expect(v2Spy).toHaveBeenCalledTimes(1);
  });

  it('should health check all three routers', async () => {
    const results = await factory.healthCheckAll();

    expect(results.stargate).toBeDefined();
    expect(results.across).toBeDefined();
    expect(results['stargate-v2']).toBeDefined();
    expect(results.stargate.healthy).toBe(true);
    expect(results.across.healthy).toBe(true);
    expect(results['stargate-v2'].healthy).toBe(true);
  });

  it('should track health metrics for all three routers', async () => {
    await factory.healthCheckAll();

    const metrics = factory.getHealthMetrics();
    expect(metrics.get('stargate')).toBeDefined();
    expect(metrics.get('across')).toBeDefined();
    expect(metrics.get('stargate-v2')).toBeDefined();
    expect(metrics.get('stargate-v2')!.totalChecks).toBe(1);
    expect(metrics.get('stargate-v2')!.lastHealthy).toBe(true);
  });
});
