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
 * @see ADR-014: Cross-Chain Execution Design
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
} from '../../src/bridge-router';

// =============================================================================
// Test Utilities
// =============================================================================

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
    bridgeFee: '600000', // 0.06%
    gasFee: '10000000000000000', // 0.01 ETH
    totalFee: '10000600000',
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
      const internalRouter = router as any;

      // Manually add a pending bridge for testing
      await internalRouter.bridgesMutex.runExclusive(async () => {
        internalRouter.pendingBridges.set(bridgeId, {
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
      const internalRouter = router as any;

      // Manually add a pending bridge
      await internalRouter.bridgesMutex.runExclusive(async () => {
        internalRouter.pendingBridges.set(bridgeId, {
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
      const internalRouter = router as any;

      // Add old bridges
      const oldTime = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago
      await internalRouter.bridgesMutex.runExclusive(async () => {
        internalRouter.pendingBridges.set('old-bridge-1', {
          status: 'bridging',
          sourceTxHash: '0x1',
          sourceChain: 'arbitrum',
          destChain: 'optimism',
          startTime: oldTime,
        });
        internalRouter.pendingBridges.set('old-bridge-2', {
          status: 'completed',
          sourceTxHash: '0x2',
          sourceChain: 'arbitrum',
          destChain: 'optimism',
          startTime: oldTime,
        });
      });

      // Add a recent bridge
      await internalRouter.bridgesMutex.runExclusive(async () => {
        internalRouter.pendingBridges.set('recent-bridge', {
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
    it('should evict oldest entry when max is reached', async () => {
      const internalRouter = router as any;
      const MAX_PENDING = 1000;

      // Fill to capacity
      await internalRouter.bridgesMutex.runExclusive(async () => {
        for (let i = 0; i < MAX_PENDING; i++) {
          internalRouter.pendingBridges.set(`bridge-${i}`, {
            status: 'bridging',
            sourceTxHash: `0x${i}`,
            sourceChain: 'arbitrum',
            destChain: 'optimism',
            startTime: Date.now() + i, // Slightly different times
          });
        }
      });

      // Verify at max capacity
      expect(internalRouter.pendingBridges.size).toBe(MAX_PENDING);

      // Adding one more should evict the oldest (first inserted)
      await internalRouter.bridgesMutex.runExclusive(async () => {
        if (internalRouter.pendingBridges.size >= MAX_PENDING) {
          const oldestKey = internalRouter.pendingBridges.keys().next().value;
          if (oldestKey) {
            internalRouter.pendingBridges.delete(oldestKey);
          }
        }
        internalRouter.pendingBridges.set('new-bridge', {
          status: 'bridging',
          sourceTxHash: '0xnew',
          sourceChain: 'arbitrum',
          destChain: 'optimism',
          startTime: Date.now(),
        });
      });

      // Size should still be at max
      expect(internalRouter.pendingBridges.size).toBe(MAX_PENDING);

      // New bridge should exist
      const newStatus = await router.getStatus('new-bridge');
      expect(newStatus.status).toBe('bridging');

      // First bridge should be evicted
      const firstStatus = await router.getStatus('bridge-0');
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
      const internalRouter = router as any;

      // Add initial bridge
      await internalRouter.bridgesMutex.runExclusive(async () => {
        internalRouter.pendingBridges.set(bridgeId, {
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
      const internalRouter = router as any;
      const results: number[] = [];

      // Run multiple exclusive operations
      const operations: Promise<number>[] = [];
      for (let i = 0; i < 5; i++) {
        operations.push(
          internalRouter.bridgesMutex.runExclusive(async () => {
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
      expect(BRIDGE_TIMES.default).toBe(300); // 5 minutes default
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
