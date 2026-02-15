/**
 * Bridge Router Unit Tests - Phase 3
 *
 * Tests for StargateRouter cross-chain bridge implementation:
 * - Route validation
 * - Quote generation
 * - Execution flow
 * - Status tracking with mutex protection
 * - Memory management (MAX_PENDING_BRIDGES)
 * - Auto-cleanup
 * - ERC20 approval flow
 *
 * @see shared/core/src/bridge-router/ for implementation
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

// Mock bridge-config selectOptimalBridge for findSupportedRouter scoring tests
const mockSelectOptimalBridge = jest.fn();
jest.mock('@arbitrage/config', () => ({
  selectOptimalBridge: (...args: unknown[]) => mockSelectOptimalBridge(...args),
}));

// Import after mocking
import {
  StargateRouter,
  createStargateRouter,
  STARGATE_CHAIN_IDS,
  STARGATE_POOL_IDS,
  STARGATE_ROUTER_ADDRESSES,
  BRIDGE_TIMES,
  BRIDGE_DEFAULTS,
  BridgeQuote,
  BridgeRouterFactory,
  PoolLiquidityAlert,
  BridgeHealthMetrics,
} from '../../src/bridge-router';

// =============================================================================
// Test Utilities
// =============================================================================

/**
 * Type-safe accessor for StargateRouter internals in tests.
 * Reduces fragile (router as any) casts throughout the test file.
 */
function getRouterInternals(router: StargateRouter) {
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
 * Create a valid test quote
 */
function createTestQuote(overrides: Partial<BridgeQuote> = {}): BridgeQuote {
  return {
    protocol: 'stargate',
    sourceChain: 'arbitrum',
    destChain: 'optimism',
    token: 'USDC',
    amountIn: '1000000000', // 1000 USDC (6 decimals)
    amountOut: '997000000', // After 0.06% fee and slippage
    bridgeFee: '600000', // 0.06% (token-denominated, already deducted from amountOut)
    gasFee: '10000000000000000', // 0.01 ETH (native wei)
    totalFee: '10000000000000000', // Same as gasFee (native wei only)
    estimatedTimeSeconds: 120,
    expiresAt: Date.now() + BRIDGE_DEFAULTS.quoteValidityMs,
    valid: true,
    ...overrides,
  };
}

// =============================================================================
// Test Suites
// =============================================================================

describe('StargateRouter', () => {
  let router: StargateRouter;
  let mockProvider: jest.Mocked<ethers.Provider>;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockProvider = createMockProvider();
    const providers = new Map<string, ethers.Provider>();
    providers.set('arbitrum', mockProvider);
    providers.set('optimism', mockProvider);
    providers.set('ethereum', mockProvider);

    router = new StargateRouter(providers);
  });

  afterEach(() => {
    router.dispose();
    jest.useRealTimers();
  });

  // ===========================================================================
  // Route Validation Tests
  // ===========================================================================

  describe('isRouteSupported', () => {
    it('should return true for supported routes', () => {
      expect(router.isRouteSupported('ethereum', 'arbitrum', 'USDC')).toBe(true);
      expect(router.isRouteSupported('arbitrum', 'optimism', 'USDT')).toBe(true);
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
      expect(router.isRouteSupported('ethereum', 'arbitrum', 'SHIB')).toBe(false);
    });

    it('should return false for tokens not supported on destination', () => {
      // ETH is supported on ethereum but not on BSC in Stargate
      expect(router.isRouteSupported('ethereum', 'bsc', 'ETH')).toBe(false);
    });
  });

  // ===========================================================================
  // Estimated Time Tests
  // ===========================================================================

  describe('getEstimatedTime', () => {
    it('should return configured time for known routes', () => {
      expect(router.getEstimatedTime('ethereum', 'arbitrum')).toBe(BRIDGE_TIMES['ethereum-arbitrum']);
      expect(router.getEstimatedTime('arbitrum', 'optimism')).toBe(BRIDGE_TIMES['arbitrum-optimism']);
    });

    it('should return default time for unknown routes', () => {
      expect(router.getEstimatedTime('avalanche', 'fantom')).toBe(BRIDGE_TIMES.default);
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
      const quote = await router.quote({
        sourceChain: 'bsc', // Provider not registered
        destChain: 'polygon',
        token: 'USDC',
        amount: '1000000000',
      });

      expect(quote.valid).toBe(false);
      expect(quote.error).toContain('No provider registered');
    });

    it('should return quote with correct fee calculation', async () => {
      // Mock the router contract call
      const mockRouterContract = {
        quoteLayerZeroFee: jest.fn(() => Promise.resolve([10000000000000000n, 0n])), // 0.01 ETH
      };

      jest.spyOn(ethers, 'Contract').mockReturnValue(mockRouterContract as any);

      const quote = await router.quote({
        sourceChain: 'arbitrum',
        destChain: 'optimism',
        token: 'USDC',
        amount: '1000000000000', // 1,000,000 USDC
      });

      expect(quote.valid).toBe(true);
      expect(quote.protocol).toBe('stargate');
      expect(quote.sourceChain).toBe('arbitrum');
      expect(quote.destChain).toBe('optimism');
      expect(quote.token).toBe('USDC');
      expect(BigInt(quote.bridgeFee)).toBe(600000000n); // 0.06% of 1,000,000 USDC
      expect(BigInt(quote.gasFee)).toBe(10000000000000000n);
    });

    it('should handle quote errors gracefully', async () => {
      jest.spyOn(ethers, 'Contract').mockReturnValue({
        quoteLayerZeroFee: jest.fn(() => Promise.reject(new Error('RPC error'))),
      } as any);

      const quote = await router.quote({
        sourceChain: 'arbitrum',
        destChain: 'optimism',
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
        expiresAt: Date.now() - 1000, // Expired 1 second ago
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

    it('should reject quotes for chains without router address', async () => {
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
      expect(result.error).toContain('No router address');
    });
  });

  // ===========================================================================
  // Status Tracking Tests (with Mutex Protection)
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
      // First we need to create a pending bridge entry
      // We'll use the internal access for testing
      const bridgeId = 'stargate-0xtest123';
      const internals = getRouterInternals(router);

      // Manually add a pending bridge for testing
      await internals.bridgesMutex.runExclusive(async () => {
        internals.pendingBridges.set(bridgeId, {
          status: 'bridging',
          sourceTxHash: '0xsourcehash',
          sourceChain: 'arbitrum',
          destChain: 'optimism',
          startTime: Date.now(),
        });
      });

      // Mark as completed
      await router.markCompleted(bridgeId, '0xdesthash', '1000000000');

      // Verify status
      const status = await router.getStatus(bridgeId);
      expect(status.status).toBe('completed');
      expect(status.destTxHash).toBe('0xdesthash');
      expect(status.amountReceived).toBe('1000000000');
    });
  });

  describe('markFailed', () => {
    it('should mark bridge as failed with error message', async () => {
      const bridgeId = 'stargate-0xtest456';
      const internals = getRouterInternals(router);

      // Manually add a pending bridge
      await internals.bridgesMutex.runExclusive(async () => {
        internals.pendingBridges.set(bridgeId, {
          status: 'bridging',
          sourceTxHash: '0xsourcehash',
          sourceChain: 'arbitrum',
          destChain: 'optimism',
          startTime: Date.now(),
        });
      });

      // Mark as failed
      await router.markFailed(bridgeId, 'Destination chain reverted');

      // Verify status
      const status = await router.getStatus(bridgeId);
      expect(status.status).toBe('failed');
      expect(status.error).toBe('Destination chain reverted');
    });
  });

  // ===========================================================================
  // Memory Management Tests
  // ===========================================================================

  describe('cleanup', () => {
    it('should remove old pending bridges', async () => {
      const internals = getRouterInternals(router);

      // Add old bridges
      const oldTime = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago
      await internals.bridgesMutex.runExclusive(async () => {
        internals.pendingBridges.set('old-bridge-1', {
          status: 'bridging',
          sourceTxHash: '0x1',
          sourceChain: 'arbitrum',
          destChain: 'optimism',
          startTime: oldTime,
        });
        internals.pendingBridges.set('old-bridge-2', {
          status: 'completed',
          sourceTxHash: '0x2',
          sourceChain: 'arbitrum',
          destChain: 'optimism',
          startTime: oldTime,
        });
      });

      // Add a recent bridge
      await internals.bridgesMutex.runExclusive(async () => {
        internals.pendingBridges.set('recent-bridge', {
          status: 'bridging',
          sourceTxHash: '0x3',
          sourceChain: 'arbitrum',
          destChain: 'optimism',
          startTime: Date.now(),
        });
      });

      // Run cleanup (24 hour cutoff)
      await router.cleanup(24 * 60 * 60 * 1000);

      // Verify old bridges removed, recent bridge kept
      const oldStatus1 = await router.getStatus('old-bridge-1');
      const oldStatus2 = await router.getStatus('old-bridge-2');
      const recentStatus = await router.getStatus('recent-bridge');

      expect(oldStatus1.error).toBe('Bridge not found');
      expect(oldStatus2.error).toBe('Bridge not found');
      expect(recentStatus.status).toBe('bridging');
    });
  });

  describe('MAX_PENDING_BRIDGES enforcement', () => {
    it('should evict oldest entry when max is reached via execute()', async () => {
      const internals = getRouterInternals(router);
      const MAX_PENDING = 1000;

      // Fill to capacity by adding entries directly (simulating previous executions)
      await internals.bridgesMutex.runExclusive(async () => {
        for (let i = 0; i < MAX_PENDING; i++) {
          internals.pendingBridges.set(`stargate-0xbridge${i}`, {
            status: 'bridging',
            sourceTxHash: `0xbridge${i}`,
            sourceChain: 'arbitrum',
            destChain: 'optimism',
            startTime: Date.now() + i,
          });
        }
      });

      expect(internals.pendingBridges.size).toBe(MAX_PENDING);

      // Execute one more bridge through the public execute() path
      const mockEncodeFunctionData = jest.fn(() => '0xencodeddata');
      const mockAllowance = jest.fn(() => Promise.resolve(ethers.MaxUint256));
      jest.spyOn(ethers, 'Contract').mockReturnValue({
        interface: { encodeFunctionData: mockEncodeFunctionData },
        allowance: mockAllowance,
        balanceOf: jest.fn(() => Promise.resolve(BigInt('2000000000'))),
      } as any);

      const mockWallet = createMockWallet(mockProvider);
      // Mock getBalance for pre-flight check
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

      // Size should still be at max (oldest evicted, new one added)
      expect(internals.pendingBridges.size).toBe(MAX_PENDING);

      // New bridge should exist
      const newStatus = await router.getStatus(result.bridgeId!);
      expect(newStatus.status).toBe('bridging');

      // First bridge should be evicted
      const firstStatus = await router.getStatus('stargate-0xbridge0');
      expect(firstStatus.error).toBe('Bridge not found');
    });
  });

  // ===========================================================================
  // Concurrency Tests (Mutex)
  // Note: These tests use real timers because setImmediate doesn't work with fake timers
  // ===========================================================================

  describe('concurrent access (mutex protection)', () => {
    beforeEach(() => {
      // Use real timers for mutex tests as setImmediate doesn't work with fake timers
      jest.useRealTimers();
    });

    afterEach(() => {
      // Restore fake timers for other tests
      jest.useFakeTimers();
    });

    it('should handle concurrent status updates without race conditions', async () => {
      const bridgeId = 'concurrent-test-bridge';
      const internals = getRouterInternals(router);

      // Add initial bridge
      await internals.bridgesMutex.runExclusive(async () => {
        internals.pendingBridges.set(bridgeId, {
          status: 'bridging',
          sourceTxHash: '0xconcurrent',
          sourceChain: 'arbitrum',
          destChain: 'optimism',
          startTime: Date.now(),
        });
      });

      // Simulate concurrent operations
      const operations = [
        router.getStatus(bridgeId),
        router.getStatus(bridgeId),
        router.markCompleted(bridgeId, '0xdest1', '1000'),
        router.getStatus(bridgeId),
      ];

      // All operations should complete without errors
      const results = await Promise.all(operations);

      // Final status should be completed
      const finalStatus = await router.getStatus(bridgeId);
      expect(finalStatus.status).toBe('completed');
    });

    it('should serialize mutex operations correctly', async () => {
      const internals = getRouterInternals(router);
      const results: number[] = [];

      // Run multiple exclusive operations
      const operations: Promise<number>[] = [];
      for (let i = 0; i < 5; i++) {
        operations.push(
          internals.bridgesMutex.runExclusive(async () => {
            // Simulate some async work
            await new Promise(resolve => setImmediate(resolve));
            results.push(i);
            return i;
          })
        );
      }

      await Promise.all(operations);

      // Results should be in order (mutex ensures serial execution)
      expect(results).toEqual([0, 1, 2, 3, 4]);
    });
  });

  // ===========================================================================
  // Health Check Tests
  // ===========================================================================

  describe('healthCheck', () => {
    it('should return unhealthy when no providers registered', async () => {
      const emptyRouter = new StargateRouter();

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
  // Factory Function Tests
  // ===========================================================================

  describe('createStargateRouter', () => {
    it('should create router without providers', () => {
      const factoryRouter = createStargateRouter();
      expect(factoryRouter).toBeInstanceOf(StargateRouter);
      expect(factoryRouter.protocol).toBe('stargate');
      factoryRouter.dispose();
    });

    it('should create router with providers', () => {
      const providers = new Map<string, ethers.Provider>();
      providers.set('ethereum', createMockProvider());

      const factoryRouter = createStargateRouter(providers);
      expect(factoryRouter).toBeInstanceOf(StargateRouter);
      factoryRouter.dispose();
    });
  });

  // ===========================================================================
  // Provider Registration Tests
  // ===========================================================================

  describe('registerProvider', () => {
    it('should allow registering new providers', async () => {
      const newRouter = createStargateRouter();
      const bscProvider = createMockProvider();

      newRouter.registerProvider('bsc', bscProvider);

      // Now BSC quotes should work (if we mock the contract)
      const health = await newRouter.healthCheck();
      expect(health.healthy).toBe(true);

      newRouter.dispose();
    });
  });
});

// =============================================================================
// Execute Success Path, Approval, and State Transition Tests (Fix #5)
// =============================================================================

describe('StargateRouter - execute success and approval', () => {
  let router: StargateRouter;
  let mockProvider: jest.Mocked<ethers.Provider>;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockProvider = createMockProvider();
    const providers = new Map<string, ethers.Provider>();
    providers.set('arbitrum', mockProvider);
    providers.set('optimism', mockProvider);
    providers.set('ethereum', mockProvider);

    router = new StargateRouter(providers);
  });

  afterEach(() => {
    router.dispose();
    jest.useRealTimers();
  });

  // 5a: execute() success path for ERC20 (USDC)
  it('should execute ERC20 bridge successfully and track pending bridge', async () => {
    const mockEncodeFunctionData = jest.fn(() => '0xencodeddata');
    const mockAllowance = jest.fn(() => Promise.resolve(ethers.MaxUint256));
    const mockApprove = jest.fn(() => Promise.resolve({
      wait: jest.fn(() => Promise.resolve({ status: 1, hash: '0xapprove' })),
    }));

    jest.spyOn(ethers, 'Contract').mockReturnValue({
      interface: { encodeFunctionData: mockEncodeFunctionData },
      allowance: mockAllowance,
      approve: mockApprove,
      balanceOf: jest.fn(() => Promise.resolve(BigInt('2000000000'))), // Sufficient balance
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
    expect(result.bridgeId).toContain('stargate-');

    // Verify pending bridge was tracked
    const status = await router.getStatus(result.bridgeId!);
    expect(status.status).toBe('bridging');
    expect(status.sourceTxHash).toBe(result.sourceTxHash);
  });

  // 5b: execute() success path for ETH
  it('should execute ETH bridge with amountIn + gasFee in tx.value', async () => {
    const mockEncodeFunctionData = jest.fn(() => '0xencodeddata');

    jest.spyOn(ethers, 'Contract').mockReturnValue({
      interface: { encodeFunctionData: mockEncodeFunctionData },
    } as any);

    const mockWallet = createMockWallet(mockProvider);
    // Balance must cover amountIn (1 ETH) + gasFee (0.01 ETH) for pre-flight check
    (mockProvider.getBalance as jest.Mock<() => Promise<bigint>>).mockResolvedValue(
      BigInt('2000000000000000000') // 2 ETH
    );
    const ethQuote = createTestQuote({
      token: 'ETH',
      sourceChain: 'ethereum',
      destChain: 'arbitrum',
      amountIn: '1000000000000000000', // 1 ETH
      gasFee: '10000000000000000', // 0.01 ETH
      totalFee: '10000000000000000',
    });

    const result = await router.execute({
      quote: ethQuote,
      wallet: mockWallet,
      provider: mockProvider,
    });

    expect(result.success).toBe(true);

    // Verify tx.value includes amountIn + gasFee for ETH (Fix #1)
    const sendTxCall = mockWallet.sendTransaction.mock.calls[0]?.[0] as any;
    expect(sendTxCall).toBeDefined();
    // value = amountIn + gasFee = 1 ETH + 0.01 ETH = 1.01 ETH
    expect(sendTxCall.value).toBe(
      BigInt('1000000000000000000') + BigInt('10000000000000000')
    );

    // Verify NO approval was called (ETH doesn't need ERC20 approval)
    // ethers.Contract is mocked but approve should not be called for ETH
  });

  // 5c: ERC20 approval when allowance is sufficient
  it('should skip approval when allowance is sufficient', async () => {
    const mockEncodeFunctionData = jest.fn(() => '0xencodeddata');
    const mockAllowance = jest.fn(() => Promise.resolve(ethers.MaxUint256)); // Already approved
    const mockApprove = jest.fn();

    jest.spyOn(ethers, 'Contract').mockReturnValue({
      interface: { encodeFunctionData: mockEncodeFunctionData },
      allowance: mockAllowance,
      approve: mockApprove,
      balanceOf: jest.fn(() => Promise.resolve(BigInt('2000000000'))), // Sufficient balance
    } as any);

    const mockWallet = createMockWallet(mockProvider);
    const quote = createTestQuote();

    const result = await router.execute({
      quote,
      wallet: mockWallet,
      provider: mockProvider,
    });

    expect(result.success).toBe(true);
    // approve should NOT be called since allowance >= amount
    expect(mockApprove).not.toHaveBeenCalled();
  });

  // 5d: ERC20 approval when allowance is insufficient (forceApprove pattern)
  it('should use forceApprove pattern when allowance is non-zero but insufficient', async () => {
    const mockEncodeFunctionData = jest.fn(() => '0xencodeddata');
    // Current allowance is non-zero but less than needed
    const mockAllowance = jest.fn(() => Promise.resolve(500n));
    const approveCalls: bigint[] = [];
    const mockApprove = jest.fn((spender: string, amount: bigint) => {
      approveCalls.push(amount);
      return Promise.resolve({
        wait: jest.fn(() => Promise.resolve({ status: 1, hash: '0xapprove' })),
      });
    });

    jest.spyOn(ethers, 'Contract').mockReturnValue({
      interface: { encodeFunctionData: mockEncodeFunctionData },
      allowance: mockAllowance,
      approve: mockApprove,
      balanceOf: jest.fn(() => Promise.resolve(BigInt('2000000000'))), // Sufficient balance
    } as any);

    const mockWallet = createMockWallet(mockProvider);
    const quote = createTestQuote();

    const result = await router.execute({
      quote,
      wallet: mockWallet,
      provider: mockProvider,
    });

    expect(result.success).toBe(true);
    // forceApprove pattern: first approve(0), then approve(exactAmount)
    expect(approveCalls.length).toBe(2);
    expect(approveCalls[0]).toBe(0n); // Reset to 0 first
    expect(approveCalls[1]).toBe(BigInt(quote.amountIn)); // Then exact amount
  });

  // 5e: Approval failure handling
  it('should return failure when approval fails', async () => {
    const mockEncodeFunctionData = jest.fn(() => '0xencodeddata');
    const mockAllowance = jest.fn(() => Promise.resolve(0n)); // No existing allowance
    const mockApprove = jest.fn(() => Promise.reject(new Error('Approval reverted')));

    jest.spyOn(ethers, 'Contract').mockReturnValue({
      interface: { encodeFunctionData: mockEncodeFunctionData },
      allowance: mockAllowance,
      approve: mockApprove,
      balanceOf: jest.fn(() => Promise.resolve(BigInt('2000000000'))), // Sufficient balance
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

  // 5h: execute() pool ID not found
  it('should return failure when pool ID not found for token', async () => {
    jest.spyOn(ethers, 'Contract').mockReturnValue({
      interface: { encodeFunctionData: jest.fn(() => '0x') },
    } as any);

    const mockWallet = createMockWallet(mockProvider);
    // Use a token that has no pool IDs for the given chains
    const quote = createTestQuote({
      token: 'USDT',
      sourceChain: 'base', // USDT has no pool on base in STARGATE_POOL_IDS
    });

    const result = await router.execute({
      quote,
      wallet: mockWallet,
      provider: mockProvider,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Pool ID not found');
  });
});

// =============================================================================
// State Transition and Timeout Recovery Tests (Fix #4, Fix #5f/5g)
// =============================================================================

describe('StargateRouter - state transitions', () => {
  let router: StargateRouter;
  let mockProvider: jest.Mocked<ethers.Provider>;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockProvider = createMockProvider();
    const providers = new Map<string, ethers.Provider>();
    providers.set('arbitrum', mockProvider);
    providers.set('optimism', mockProvider);

    router = new StargateRouter(providers);
  });

  afterEach(() => {
    router.dispose();
    jest.useRealTimers();
  });

  // 5f: State transition guards
  it('should no-op when marking already-completed bridge as completed', async () => {
    const bridgeId = 'stargate-0xcompleted';
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

    // First complete
    await router.markCompleted(bridgeId, '0xdest1', '1000');
    const status1 = await router.getStatus(bridgeId);
    expect(status1.status).toBe('completed');
    expect(status1.destTxHash).toBe('0xdest1');

    // Second complete attempt - should be no-op (completed bridge can't be re-completed)
    await router.markCompleted(bridgeId, '0xdest2', '2000');
    const status2 = await router.getStatus(bridgeId);
    expect(status2.status).toBe('completed');
    expect(status2.destTxHash).toBe('0xdest1'); // Unchanged
  });

  it('should reject markCompleted on failed bridge with execution_error reason', async () => {
    const bridgeId = 'stargate-0xexecfail';
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

    // Mark as failed with execution_error
    await router.markFailed(bridgeId, 'Destination reverted');

    const statusAfterFail = await router.getStatus(bridgeId);
    expect(statusAfterFail.status).toBe('failed');

    // Try to mark completed - should be rejected (non-timeout failure)
    await router.markCompleted(bridgeId, '0xdest', '1000');
    const statusAfterAttempt = await router.getStatus(bridgeId);
    expect(statusAfterAttempt.status).toBe('failed'); // Still failed
  });

  it('should allow markCompleted on timeout-failed bridge (Fix #4 recovery)', async () => {
    const bridgeId = 'stargate-0xtimeout';
    const internals = getRouterInternals(router);

    // Create bridge with old startTime that triggers timeout
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

    // getStatus() should trigger timeout -> status = 'failed' with failReason = 'timeout'
    const statusAfterTimeout = await router.getStatus(bridgeId);
    expect(statusAfterTimeout.status).toBe('failed');
    expect(statusAfterTimeout.error).toContain('timeout');

    // Now markCompleted should succeed (timeout recovery)
    await router.markCompleted(bridgeId, '0xdest_late', '999000');
    const statusAfterRecovery = await router.getStatus(bridgeId);
    expect(statusAfterRecovery.status).toBe('completed');
    expect(statusAfterRecovery.destTxHash).toBe('0xdest_late');
    expect(statusAfterRecovery.amountReceived).toBe('999000');
  });

  it('should no-op when marking already-failed bridge as failed', async () => {
    const bridgeId = 'stargate-0xdoublefail';
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

    await router.markFailed(bridgeId, 'First failure');
    const status1 = await router.getStatus(bridgeId);
    expect(status1.status).toBe('failed');
    expect(status1.error).toBe('First failure');

    // Second markFailed should be rejected (already failed)
    await router.markFailed(bridgeId, 'Second failure');
    const status2 = await router.getStatus(bridgeId);
    expect(status2.error).toBe('First failure'); // Unchanged
  });

  it('should reject markFailed on completed bridge', async () => {
    const bridgeId = 'stargate-0xcompletedfail';
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
    const status1 = await router.getStatus(bridgeId);
    expect(status1.status).toBe('completed');

    // markFailed on completed bridge should be rejected
    await router.markFailed(bridgeId, 'Late failure');
    const status2 = await router.getStatus(bridgeId);
    expect(status2.status).toBe('completed'); // Still completed
  });

  // 5g: getStatus() timeout + recovery
  it('should timeout bridge and then allow recovery via markCompleted', async () => {
    const bridgeId = 'stargate-0xtimeoutrecovery';
    const internals = getRouterInternals(router);

    // Create bridge that will timeout
    const oldStartTime = Date.now() - (BRIDGE_DEFAULTS.maxBridgeWaitMs + 5000);
    await internals.bridgesMutex.runExclusive(async () => {
      internals.pendingBridges.set(bridgeId, {
        status: 'bridging',
        sourceTxHash: '0xsrc',
        sourceChain: 'arbitrum',
        destChain: 'optimism',
        startTime: oldStartTime,
      });
    });

    // First call triggers timeout
    const timeoutStatus = await router.getStatus(bridgeId);
    expect(timeoutStatus.status).toBe('failed');
    expect(timeoutStatus.error).toContain('timeout');

    // Subsequent getStatus calls should return failed (cached)
    const cachedStatus = await router.getStatus(bridgeId);
    expect(cachedStatus.status).toBe('failed');

    // markCompleted should succeed (Fix #4 recovery from timeout)
    await router.markCompleted(bridgeId, '0xlate_dest', '950000');
    const recoveredStatus = await router.getStatus(bridgeId);
    expect(recoveredStatus.status).toBe('completed');
    expect(recoveredStatus.destTxHash).toBe('0xlate_dest');
    expect(recoveredStatus.amountReceived).toBe('950000');
  });
});

// =============================================================================
// Constants Export Tests
// =============================================================================

describe('Bridge Router Constants', () => {
  describe('STARGATE_CHAIN_IDS', () => {
    it('should have all supported chains', () => {
      expect(STARGATE_CHAIN_IDS.ethereum).toBe(101);
      expect(STARGATE_CHAIN_IDS.arbitrum).toBe(110);
      expect(STARGATE_CHAIN_IDS.optimism).toBe(111);
      expect(STARGATE_CHAIN_IDS.base).toBe(184);
    });
  });

  describe('STARGATE_POOL_IDS', () => {
    it('should have pool IDs for USDC', () => {
      expect(STARGATE_POOL_IDS.USDC.ethereum).toBe(1);
      expect(STARGATE_POOL_IDS.USDC.arbitrum).toBe(1);
    });

    it('should have pool IDs for ETH', () => {
      expect(STARGATE_POOL_IDS.ETH.ethereum).toBe(13);
      expect(STARGATE_POOL_IDS.ETH.arbitrum).toBe(13);
    });
  });

  describe('STARGATE_ROUTER_ADDRESSES', () => {
    it('should have router addresses for all chains', () => {
      expect(STARGATE_ROUTER_ADDRESSES.ethereum).toBeDefined();
      expect(STARGATE_ROUTER_ADDRESSES.arbitrum).toBeDefined();
      expect(STARGATE_ROUTER_ADDRESSES.optimism).toBeDefined();
    });

    it('should have valid Ethereum addresses', () => {
      const addressRegex = /^0x[a-fA-F0-9]{40}$/;
      for (const address of Object.values(STARGATE_ROUTER_ADDRESSES)) {
        expect(address).toMatch(addressRegex);
      }
    });
  });

  describe('BRIDGE_TIMES', () => {
    it('should have reasonable bridge times', () => {
      expect(BRIDGE_TIMES['ethereum-arbitrum']).toBeGreaterThan(0);
      expect(BRIDGE_TIMES['ethereum-arbitrum']).toBeLessThanOrEqual(3600); // Max 1 hour
      expect(BRIDGE_TIMES.default).toBe(180); // 3 minutes default (synced with bridge-config.ts)
    });
  });

  describe('BRIDGE_DEFAULTS', () => {
    it('should have sensible default values', () => {
      expect(BRIDGE_DEFAULTS.slippage).toBe(0.005); // 0.5%
      expect(BRIDGE_DEFAULTS.quoteValidityMs).toBe(5 * 60 * 1000); // 5 minutes
      expect(BRIDGE_DEFAULTS.maxBridgeWaitMs).toBe(15 * 60 * 1000); // 15 minutes
    });
  });
});

// =============================================================================
// Phase 4: Execution Metrics Tests
// =============================================================================

describe('BridgeRouterFactory - Execution Metrics', () => {
  let factory: BridgeRouterFactory;
  const mockProviders = new Map<string, any>([
    ['ethereum', createMockProvider()],
    ['arbitrum', createMockProvider()],
  ]);

  beforeEach(() => {
    factory = new BridgeRouterFactory({
      defaultProtocol: 'stargate',
      providers: mockProviders,
    });
  });

  afterEach(() => {
    factory.dispose();
  });

  it('should start with empty execution metrics', () => {
    const metrics = factory.getExecutionMetrics();
    expect(metrics.size).toBe(0);
  });

  it('should record quote success', () => {
    factory.recordExecution('stargate', 'quote', true, 50);

    const metrics = factory.getExecutionMetrics().get('stargate');
    expect(metrics).toBeDefined();
    expect(metrics!.quoteAttempts).toBe(1);
    expect(metrics!.quoteSuccesses).toBe(1);
    expect(metrics!.quoteFailures).toBe(0);
  });

  it('should record quote failure', () => {
    factory.recordExecution('stargate', 'quote', false, 10);

    const metrics = factory.getExecutionMetrics().get('stargate');
    expect(metrics!.quoteAttempts).toBe(1);
    expect(metrics!.quoteSuccesses).toBe(0);
    expect(metrics!.quoteFailures).toBe(1);
  });

  it('should record execution success with latency', () => {
    factory.recordExecution('across', 'execute', true, 150);

    const metrics = factory.getExecutionMetrics().get('across');
    expect(metrics).toBeDefined();
    expect(metrics!.executeAttempts).toBe(1);
    expect(metrics!.executeSuccesses).toBe(1);
    expect(metrics!.executeFailures).toBe(0);
    expect(metrics!.totalLatencyMs).toBe(150);
  });

  it('should record execution failure', () => {
    factory.recordExecution('across', 'execute', false, 200);

    const metrics = factory.getExecutionMetrics().get('across');
    expect(metrics!.executeAttempts).toBe(1);
    expect(metrics!.executeSuccesses).toBe(0);
    expect(metrics!.executeFailures).toBe(1);
    expect(metrics!.totalLatencyMs).toBe(200);
  });

  it('should track metrics per protocol independently', () => {
    factory.recordExecution('stargate', 'quote', true, 30);
    factory.recordExecution('across', 'quote', false, 20);
    factory.recordExecution('stargate', 'execute', true, 100);

    const stargateMetrics = factory.getExecutionMetrics().get('stargate');
    const acrossMetrics = factory.getExecutionMetrics().get('across');

    expect(stargateMetrics!.quoteSuccesses).toBe(1);
    expect(stargateMetrics!.executeSuccesses).toBe(1);
    expect(stargateMetrics!.totalLatencyMs).toBe(130);

    expect(acrossMetrics!.quoteFailures).toBe(1);
    expect(acrossMetrics!.executeAttempts).toBe(0);
    expect(acrossMetrics!.totalLatencyMs).toBe(20);
  });

  it('should accumulate multiple operations', () => {
    factory.recordExecution('stargate', 'quote', true, 10);
    factory.recordExecution('stargate', 'quote', true, 20);
    factory.recordExecution('stargate', 'quote', false, 5);
    factory.recordExecution('stargate', 'execute', true, 100);
    factory.recordExecution('stargate', 'execute', false, 200);

    const metrics = factory.getExecutionMetrics().get('stargate')!;
    expect(metrics.quoteAttempts).toBe(3);
    expect(metrics.quoteSuccesses).toBe(2);
    expect(metrics.quoteFailures).toBe(1);
    expect(metrics.executeAttempts).toBe(2);
    expect(metrics.executeSuccesses).toBe(1);
    expect(metrics.executeFailures).toBe(1);
    expect(metrics.totalLatencyMs).toBe(335);
    expect(metrics.lastExecutionTime).toBeGreaterThan(0);
  });

  it('should set lastExecutionTime on each record', () => {
    const before = Date.now();
    factory.recordExecution('stargate', 'quote', true);
    const after = Date.now();

    const metrics = factory.getExecutionMetrics().get('stargate')!;
    expect(metrics.lastExecutionTime).toBeGreaterThanOrEqual(before);
    expect(metrics.lastExecutionTime).toBeLessThanOrEqual(after);
  });
});

// =============================================================================
// Phase 4: Protocol Disabling Tests
// =============================================================================

describe('BridgeRouterFactory - Protocol Disabling', () => {
  const mockProviders = new Map<string, any>([
    ['ethereum', createMockProvider()],
    ['arbitrum', createMockProvider()],
  ]);

  it('should skip disabled protocols during construction', () => {
    const factory = new BridgeRouterFactory({
      defaultProtocol: 'stargate',
      providers: mockProviders,
      disabledProtocols: ['across'],
    });

    const protocols = factory.getAvailableProtocols();
    expect(protocols).toContain('stargate');
    expect(protocols).toContain('stargate-v2');
    expect(protocols).not.toContain('across');

    factory.dispose();
  });

  it('should not include disabled protocols in getAvailableProtocols()', () => {
    const factory = new BridgeRouterFactory({
      defaultProtocol: 'stargate',
      providers: mockProviders,
      disabledProtocols: ['stargate', 'across'],
    });

    const protocols = factory.getAvailableProtocols();
    expect(protocols).toEqual(['stargate-v2']);

    factory.dispose();
  });

  it('should report protocol as disabled via isProtocolDisabled()', () => {
    const factory = new BridgeRouterFactory({
      defaultProtocol: 'stargate',
      providers: mockProviders,
      disabledProtocols: ['across'],
    });

    expect(factory.isProtocolDisabled('across')).toBe(true);
    expect(factory.isProtocolDisabled('stargate')).toBe(false);

    factory.dispose();
  });

  it('should throw when getting disabled protocol by name', () => {
    const factory = new BridgeRouterFactory({
      defaultProtocol: 'stargate',
      providers: mockProviders,
      disabledProtocols: ['across'],
    });

    expect(() => factory.getRouter('across')).toThrow(
      'Bridge router not available for protocol: across'
    );

    factory.dispose();
  });

  it('should work normally when disabledProtocols is empty array', () => {
    const factory = new BridgeRouterFactory({
      defaultProtocol: 'stargate',
      providers: mockProviders,
      disabledProtocols: [],
    });

    const protocols = factory.getAvailableProtocols();
    expect(protocols).toContain('stargate');
    expect(protocols).toContain('across');
    expect(protocols).toContain('stargate-v2');

    factory.dispose();
  });

  it('should work normally when disabledProtocols is undefined', () => {
    const factory = new BridgeRouterFactory({
      defaultProtocol: 'stargate',
      providers: mockProviders,
    });

    const protocols = factory.getAvailableProtocols();
    expect(protocols.length).toBeGreaterThanOrEqual(3);

    factory.dispose();
  });

  it('should disable all protocols if all are in the list', () => {
    const factory = new BridgeRouterFactory({
      defaultProtocol: 'stargate',
      providers: mockProviders,
      disabledProtocols: ['stargate', 'across', 'stargate-v2'],
    });

    expect(factory.getAvailableProtocols()).toEqual([]);

    factory.dispose();
  });
});

// =============================================================================
// Phase 4: Pool Liquidity Alert Tests
// =============================================================================

describe('StargateRouter - Pool Liquidity Alerting', () => {
  function mockBalanceOf(balanceUsdc: bigint): void {
    jest.spyOn(ethers, 'Contract').mockReturnValue({
      balanceOf: jest.fn(() => Promise.resolve(balanceUsdc)),
    } as any);
  }

  it('should invoke onPoolAlert callback when balance is below warning threshold', async () => {
    const alerts: PoolLiquidityAlert[] = [];
    const mockProvider = createMockProvider();

    // Mock balanceOf to return $5,000 USDC (5000 * 1e6)
    mockBalanceOf(5000n * 1000000n);

    const router = new StargateRouter(
      new Map([['ethereum', mockProvider]]),
      { onPoolAlert: (alert) => alerts.push(alert) }
    );

    await router.healthCheck();

    expect(alerts.length).toBe(1);
    expect(alerts[0].severity).toBe('warning');
    expect(alerts[0].protocol).toBe('stargate');
    expect(alerts[0].chain).toBe('ethereum');
    expect(alerts[0].token).toBe('USDC');
    expect(alerts[0].threshold).toBe(10_000);
    expect(alerts[0].timestamp).toBeGreaterThan(0);

    router.dispose();
  });

  it('should invoke onPoolAlert with critical severity when balance is very low', async () => {
    const alerts: PoolLiquidityAlert[] = [];
    const mockProvider = createMockProvider();

    // Mock balanceOf to return $500 USDC
    mockBalanceOf(500n * 1000000n);

    const router = new StargateRouter(
      new Map([['ethereum', mockProvider]]),
      { onPoolAlert: (alert) => alerts.push(alert) }
    );

    await router.healthCheck();

    expect(alerts.length).toBe(1);
    expect(alerts[0].severity).toBe('critical');
    expect(alerts[0].threshold).toBe(1_000);

    router.dispose();
  });

  it('should not invoke callback when balance is healthy', async () => {
    const onPoolAlert = jest.fn();
    const mockProvider = createMockProvider();

    // Mock balanceOf to return $100,000 USDC
    mockBalanceOf(100000n * 1000000n);

    const router = new StargateRouter(
      new Map([['ethereum', mockProvider]]),
      { onPoolAlert: onPoolAlert }
    );

    await router.healthCheck();

    expect(onPoolAlert).not.toHaveBeenCalled();

    router.dispose();
  });

  it('should handle callback errors gracefully without breaking health check', async () => {
    const mockProvider = createMockProvider();

    // Mock balanceOf to return $500 USDC (below critical)
    mockBalanceOf(500n * 1000000n);

    const router = new StargateRouter(
      new Map([['ethereum', mockProvider]]),
      { onPoolAlert: () => { throw new Error('callback error'); } }
    );

    // Should not throw — callback errors are caught
    const result = await router.healthCheck();
    expect(result.healthy).toBe(true);

    router.dispose();
  });

  it('should work without callback configured', async () => {
    const mockProvider = createMockProvider();

    // Mock balanceOf to return low balance
    mockBalanceOf(500n * 1000000n);

    const router = new StargateRouter(
      new Map([['ethereum', mockProvider]])
    );

    // Should work normally without callback
    const result = await router.healthCheck();
    expect(result.healthy).toBe(true);
    expect(result.message).toContain('CRITICAL');

    router.dispose();
  });

  it('should pass onPoolAlert from factory config to StargateRouter', async () => {
    const alerts: PoolLiquidityAlert[] = [];
    const mockProvider = createMockProvider();

    // Mock balanceOf to return low balance ($5,000 USDC)
    mockBalanceOf(5000n * 1000000n);

    const factory = new BridgeRouterFactory({
      defaultProtocol: 'stargate',
      providers: new Map([['ethereum', mockProvider]]),
      onPoolAlert: (alert) => alerts.push(alert),
    });

    await factory.healthCheckAll();

    // Alert should have been triggered through factory → router → callback
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts[0].protocol).toBe('stargate');

    factory.dispose();
  });
});

// =============================================================================
// Regression Tests: Fix #1 — healthCheckAll timeout/error isolation
// =============================================================================

describe('BridgeRouterFactory - healthCheckAll timeout and error isolation', () => {
  let factory: BridgeRouterFactory;
  const mockProviders = new Map<string, any>([
    ['ethereum', createMockProvider()],
    ['arbitrum', createMockProvider()],
  ]);

  beforeEach(() => {
    jest.clearAllMocks();
    factory = new BridgeRouterFactory({
      defaultProtocol: 'stargate',
      providers: mockProviders,
    });
  });

  afterEach(() => {
    factory.dispose();
  });

  it('should handle router healthCheck throwing without blocking other routers', async () => {
    // Make stargate's healthCheck throw
    const stargateRouter = factory.getRouter('stargate');
    jest.spyOn(stargateRouter, 'healthCheck').mockRejectedValue(new Error('RPC connection lost'));

    const results = await factory.healthCheckAll();

    // Stargate should be unhealthy with error message
    expect(results.stargate.healthy).toBe(false);
    expect(results.stargate.message).toContain('RPC connection lost');

    // Across and stargate-v2 should still be checked (not blocked by stargate failure)
    expect(results.across).toBeDefined();
    expect(results['stargate-v2']).toBeDefined();
  });

  it('should timeout hanging healthCheck after 10 seconds', async () => {
    // Make stargate's healthCheck hang forever
    const stargateRouter = factory.getRouter('stargate');
    jest.spyOn(stargateRouter, 'healthCheck').mockImplementation(
      () => new Promise(() => {}) // Never resolves
    );

    // Use real timers for this test since we need actual timeout behavior
    jest.useRealTimers();

    // Override the timeout for faster test (mock the static constant)
    // Since HEALTH_CHECK_TIMEOUT_MS is private static readonly, we access via prototype
    const originalTimeout = (BridgeRouterFactory as any).HEALTH_CHECK_TIMEOUT_MS;
    (BridgeRouterFactory as any).HEALTH_CHECK_TIMEOUT_MS = 100; // 100ms for test speed

    try {
      const results = await factory.healthCheckAll();

      // Stargate should be unhealthy with timeout message
      expect(results.stargate.healthy).toBe(false);
      expect(results.stargate.message).toContain('timed out');

      // Other routers should still be checked
      expect(results.across).toBeDefined();
      expect(results['stargate-v2']).toBeDefined();
    } finally {
      (BridgeRouterFactory as any).HEALTH_CHECK_TIMEOUT_MS = originalTimeout;
      jest.useFakeTimers();
    }
  });

  it('should accumulate health metrics across multiple healthCheckAll calls', async () => {
    // First call — all healthy
    await factory.healthCheckAll();

    let metrics = factory.getHealthMetrics();
    const stargateMetrics = metrics.get('stargate');
    expect(stargateMetrics).toBeDefined();
    expect(stargateMetrics!.totalChecks).toBe(1);
    expect(stargateMetrics!.successfulChecks).toBe(1);
    expect(stargateMetrics!.failedChecks).toBe(0);

    // Second call — make stargate fail
    const stargateRouter = factory.getRouter('stargate');
    jest.spyOn(stargateRouter, 'healthCheck').mockRejectedValue(new Error('fail'));

    await factory.healthCheckAll();

    metrics = factory.getHealthMetrics();
    const updatedMetrics = metrics.get('stargate');
    expect(updatedMetrics!.totalChecks).toBe(2);
    expect(updatedMetrics!.successfulChecks).toBe(1);
    expect(updatedMetrics!.failedChecks).toBe(1);
    expect(updatedMetrics!.lastHealthy).toBe(false);
  });
});

// =============================================================================
// Regression Tests: Fix #2 — getHealthMetrics defensive copy
// =============================================================================

describe('BridgeRouterFactory - getHealthMetrics defensive copy', () => {
  let factory: BridgeRouterFactory;
  const mockProviders = new Map<string, any>([
    ['ethereum', createMockProvider()],
    ['arbitrum', createMockProvider()],
  ]);

  beforeEach(async () => {
    jest.clearAllMocks();
    factory = new BridgeRouterFactory({
      defaultProtocol: 'stargate',
      providers: mockProviders,
    });
    // Populate health metrics
    await factory.healthCheckAll();
  });

  afterEach(() => {
    factory.dispose();
  });

  it('should return a new Map that does not affect internal state when modified', async () => {
    const metrics1 = factory.getHealthMetrics();
    const originalSize = metrics1.size;

    // Delete all entries from the returned map
    metrics1.clear();
    expect(metrics1.size).toBe(0);

    // Internal state should be unchanged
    const metrics2 = factory.getHealthMetrics();
    expect(metrics2.size).toBe(originalSize);
  });

  it('should return value copies that do not affect internal state when mutated', async () => {
    const metrics1 = factory.getHealthMetrics();
    const stargateMetrics = metrics1.get('stargate');
    expect(stargateMetrics).toBeDefined();

    const originalTotalChecks = stargateMetrics!.totalChecks;

    // Mutate the returned value
    stargateMetrics!.totalChecks = 99999;

    // Internal state should be unchanged
    const metrics2 = factory.getHealthMetrics();
    expect(metrics2.get('stargate')!.totalChecks).toBe(originalTotalChecks);
  });
});

// =============================================================================
// Regression Tests: Fix #3 — findSupportedRouter scoring fallbacks
// =============================================================================

describe('BridgeRouterFactory - findSupportedRouter scoring', () => {
  let factory: BridgeRouterFactory;
  const mockProviders = new Map<string, any>([
    ['ethereum', createMockProvider()],
    ['arbitrum', createMockProvider()],
  ]);

  beforeEach(() => {
    jest.clearAllMocks();
    mockSelectOptimalBridge.mockReset();
    factory = new BridgeRouterFactory({
      defaultProtocol: 'stargate',
      providers: mockProviders,
    });
  });

  afterEach(() => {
    factory.dispose();
  });

  it('should fall back to first match when selectOptimalBridge returns undefined', () => {
    mockSelectOptimalBridge.mockReturnValue(undefined);

    // ethereum->arbitrum is supported by multiple routers (stargate, across, stargate-v2)
    const result = factory.findSupportedRouter('ethereum', 'arbitrum', 'USDC');

    expect(result).not.toBeNull();
    // Should return first match (stargate, since it's added to the Map first)
    expect(result!.protocol).toBe('stargate');
  });

  it('should fall back to first match when scoring returns unknown bridge', () => {
    mockSelectOptimalBridge.mockReturnValue({
      config: { bridge: 'wormhole' }, // Not in the matching set
      score: 0.9,
    });

    const result = factory.findSupportedRouter('ethereum', 'arbitrum', 'USDC');

    expect(result).not.toBeNull();
    // Falls back to first match since wormhole isn't in the matching routers
    expect(result!.protocol).toBe('stargate');
  });

  it('should use selectOptimalBridge result when bridge matches a router', () => {
    mockSelectOptimalBridge.mockReturnValue({
      config: { bridge: 'across' },
      score: 0.95,
    });

    const result = factory.findSupportedRouter('ethereum', 'arbitrum', 'USDC');

    expect(result).not.toBeNull();
    expect(result!.protocol).toBe('across');
  });

  it('should be backward compatible with 3-arg calls', () => {
    // 3-arg call (no tradeSizeUsd or urgency)
    const result = factory.findSupportedRouter('ethereum', 'arbitrum', 'USDC');

    expect(result).not.toBeNull();
    // Should still work — defaults applied internally by selectOptimalBridge
  });

  it('should return null for unsupported routes', () => {
    const result = factory.findSupportedRouter('solana', 'ethereum', 'USDC');
    expect(result).toBeNull();
    // selectOptimalBridge should not be called when no routers match
    expect(mockSelectOptimalBridge).not.toHaveBeenCalled();
  });

  it('should not call selectOptimalBridge when only one router matches', () => {
    // Use a route only supported by Across (zksync)
    const result = factory.findSupportedRouter('ethereum', 'zksync', 'USDC');

    // Only Across supports zksync
    expect(result).not.toBeNull();
    expect(result!.protocol).toBe('across');
    // Should not invoke scoring for single match
    expect(mockSelectOptimalBridge).not.toHaveBeenCalled();
  });
});
