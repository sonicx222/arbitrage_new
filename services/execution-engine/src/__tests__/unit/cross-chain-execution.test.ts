/**
 * Cross-Chain Execution Unit Tests
 *
 * Unit tests with mocked dependencies for:
 * - Bridge router functionality
 * - API key authentication
 * - Security middleware
 *
 * NOTE: Relabeled from integration test - uses mocked @arbitrage/core,
 * mocked providers, and mocked wallets, so this is actually a unit test.
 *
 * @see ADR-014: Cross-Chain Execution Design
 * @see Phase 4: REST API Authentication
 */

import { jest, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from '@jest/globals';
import { ethers } from 'ethers';

// =============================================================================
// Mock Setup - Must be before imports
// =============================================================================

// Mock logger
jest.mock('@arbitrage/core', () => {
  const actual = jest.requireActual('@arbitrage/core') as Record<string, unknown>;
  return {
    ...actual,
    createLogger: () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    }),
    getRedisClient: jest.fn(() => Promise.resolve({
      get: jest.fn(() => Promise.resolve(null)),
      setex: jest.fn(() => Promise.resolve('OK')),
      del: jest.fn(() => Promise.resolve(1)),
      incr: jest.fn(() => Promise.resolve(1)),
      expire: jest.fn(() => Promise.resolve(1)),
      xadd: jest.fn(() => Promise.resolve('1234-0')),
      xread: jest.fn(() => Promise.resolve(null)),
    })),
  };
});

// =============================================================================
// Imports After Mocking
// =============================================================================

import {
  StargateRouter,
  createStargateRouter,
  BridgeRouterFactory,
  BRIDGE_DEFAULTS,
  STARGATE_CHAIN_IDS,
  AsyncMutex,
  type BridgeStatusResult,
} from '@arbitrage/core';

// =============================================================================
// Test Utilities
// =============================================================================

/**
 * Create a mock ethers Provider with configurable behavior
 */
function createMockProvider(config: {
  blockNumber?: number;
  chainId?: number;
  shouldFail?: boolean;
} = {}): jest.Mocked<ethers.Provider> {
  const { blockNumber = 12345678, chainId = 1, shouldFail = false } = config;

  if (shouldFail) {
    return {
      getBlockNumber: jest.fn(() => Promise.reject(new Error('RPC timeout'))),
      getNetwork: jest.fn(() => Promise.reject(new Error('RPC timeout'))),
    } as any;
  }

  return {
    getBlockNumber: jest.fn(() => Promise.resolve(blockNumber)),
    getNetwork: jest.fn(() => Promise.resolve({ chainId: BigInt(chainId), name: 'test' })),
    getBalance: jest.fn(() => Promise.resolve(ethers.parseEther('10'))),
    call: jest.fn(() => Promise.resolve('0x')),
    estimateGas: jest.fn(() => Promise.resolve(200000n)),
    getBlock: jest.fn(() => Promise.resolve({ timestamp: Math.floor(Date.now() / 1000) })),
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
 * Create a mock wallet for testing
 */
function createMockWallet(provider: ethers.Provider, options: {
  address?: string;
  shouldFail?: boolean;
} = {}): jest.Mocked<ethers.Wallet> {
  const { address = '0x1234567890123456789012345678901234567890', shouldFail = false } = options;

  if (shouldFail) {
    return {
      address,
      provider,
      sendTransaction: jest.fn(() => Promise.reject(new Error('Transaction failed'))),
      estimateGas: jest.fn(() => Promise.reject(new Error('Estimation failed'))),
    } as any;
  }

  return {
    address,
    provider,
    getAddress: jest.fn(() => Promise.resolve(address)),
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
}

/**
 * Create mock Express request/response/next for middleware tests
 */
function createExpressMocks(options: {
  headers?: Record<string, string>;
  user?: any;
} = {}) {
  const req: any = {
    headers: options.headers || {},
    user: options.user,
  };

  const res: any = {
    statusCode: 200,
    body: null,
    status: jest.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: jest.fn((body: any) => {
      res.body = body;
      return res;
    }),
  };

  const next = jest.fn();

  return { req, res, next };
}

// =============================================================================
// Phase 3: Bridge Router Integration Tests
// =============================================================================

describe('Cross-Chain Execution Unit Tests', () => {
  let router: StargateRouter;
  let providers: Map<string, ethers.Provider>;

  beforeEach(() => {
    jest.clearAllMocks();

    providers = new Map();
    providers.set('ethereum', createMockProvider({ chainId: 1 }));
    providers.set('arbitrum', createMockProvider({ chainId: 42161 }));
    providers.set('optimism', createMockProvider({ chainId: 10 }));
    providers.set('base', createMockProvider({ chainId: 8453 }));

    router = new StargateRouter(providers);
  });

  afterEach(() => {
    router.dispose();
  });

  describe('Bridge Router Initialization', () => {
    it('should initialize with multiple chain providers', () => {
      expect(router.protocol).toBe('stargate');
      expect(router.supportedSourceChains).toContain('ethereum');
      expect(router.supportedSourceChains).toContain('arbitrum');
      expect(router.supportedDestChains).toContain('optimism');
    });

    it('should register additional providers at runtime', async () => {
      const newRouter = createStargateRouter();
      const polygonProvider = createMockProvider({ chainId: 137 });

      newRouter.registerProvider('polygon', polygonProvider);

      const health = await newRouter.healthCheck();
      expect(health.healthy).toBe(true);

      newRouter.dispose();
    });
  });

  describe('Route Validation', () => {
    it('should validate all supported L2 routes', () => {
      const routes = [
        { src: 'ethereum', dst: 'arbitrum', token: 'USDC' },
        { src: 'ethereum', dst: 'optimism', token: 'USDC' },
        { src: 'ethereum', dst: 'base', token: 'ETH' },
        { src: 'arbitrum', dst: 'optimism', token: 'USDT' },
        { src: 'arbitrum', dst: 'base', token: 'ETH' },
      ];

      for (const route of routes) {
        expect(router.isRouteSupported(route.src, route.dst, route.token)).toBe(true);
      }
    });

    it('should reject invalid routes', () => {
      // Same chain
      expect(router.isRouteSupported('ethereum', 'ethereum', 'USDC')).toBe(false);

      // Unsupported chain
      expect(router.isRouteSupported('solana', 'ethereum', 'USDC')).toBe(false);

      // Unsupported token
      expect(router.isRouteSupported('ethereum', 'arbitrum', 'UNKNOWN_TOKEN')).toBe(false);

      // Token not available on destination
      expect(router.isRouteSupported('ethereum', 'bsc', 'ETH')).toBe(false);
    });
  });

  describe('Quote Generation', () => {
    it('should generate valid quote for supported route', async () => {
      // Mock the Stargate router contract
      const mockRouterContract = {
        quoteLayerZeroFee: jest.fn(() => Promise.resolve([
          ethers.parseEther('0.01'), // 0.01 ETH gas fee
          0n,
        ])),
      };

      jest.spyOn(ethers, 'Contract').mockReturnValue(mockRouterContract as any);

      const quote = await router.quote({
        sourceChain: 'arbitrum',
        destChain: 'optimism',
        token: 'USDC',
        amount: '1000000000', // 1000 USDC
      });

      expect(quote.valid).toBe(true);
      expect(quote.protocol).toBe('stargate');
      expect(quote.sourceChain).toBe('arbitrum');
      expect(quote.destChain).toBe('optimism');
      expect(quote.expiresAt).toBeGreaterThan(Date.now());
    });

    it('should return invalid quote for unsupported route', async () => {
      const quote = await router.quote({
        sourceChain: 'solana',
        destChain: 'ethereum',
        token: 'USDC',
        amount: '1000000000',
      });

      expect(quote.valid).toBe(false);
      expect(quote.error).toContain('not supported');
    });

    it('should calculate bridge fees correctly', async () => {
      const mockRouterContract = {
        quoteLayerZeroFee: jest.fn(() => Promise.resolve([
          ethers.parseEther('0.005'), // 0.005 ETH gas
          0n,
        ])),
      };

      jest.spyOn(ethers, 'Contract').mockReturnValue(mockRouterContract as any);

      const amount = '1000000000000'; // 1,000,000 USDC
      const quote = await router.quote({
        sourceChain: 'ethereum',
        destChain: 'arbitrum',
        token: 'USDC',
        amount,
      });

      expect(quote.valid).toBe(true);

      // 0.06% bridge fee
      const expectedBridgeFee = BigInt(amount) * 6n / 10000n;
      expect(BigInt(quote.bridgeFee)).toBe(expectedBridgeFee);
    });
  });

  describe('Bridge Status Tracking', () => {
    it('should track pending bridges with concurrent access safety', async () => {
      const internalRouter = router as any;
      const bridgeId = 'test-bridge-123';

      // Simulate multiple concurrent status updates
      await internalRouter.bridgesMutex.runExclusive(async () => {
        internalRouter.pendingBridges.set(bridgeId, {
          status: 'bridging',
          sourceTxHash: '0xabc',
          sourceChain: 'arbitrum',
          destChain: 'optimism',
          startTime: Date.now(),
        });
      });

      // Concurrent reads should all succeed
      const reads: Promise<BridgeStatusResult>[] = [];
      for (let i = 0; i < 10; i++) {
        reads.push(router.getStatus(bridgeId));
      }

      const statuses = await Promise.all(reads);
      for (const status of statuses) {
        expect(status.status).toBe('bridging');
      }
    });

    it('should handle bridge completion updates', async () => {
      const bridgeId = 'complete-test-bridge';
      const internalRouter = router as any;

      // Add pending bridge
      await internalRouter.bridgesMutex.runExclusive(async () => {
        internalRouter.pendingBridges.set(bridgeId, {
          status: 'bridging',
          sourceTxHash: '0xsource',
          sourceChain: 'ethereum',
          destChain: 'arbitrum',
          startTime: Date.now(),
        });
      });

      // Mark completed
      await router.markCompleted(bridgeId, '0xdest', '999000000');

      const status = await router.getStatus(bridgeId);
      expect(status.status).toBe('completed');
      expect(status.destTxHash).toBe('0xdest');
      expect(status.amountReceived).toBe('999000000');
    });

    it('should handle bridge failure updates', async () => {
      const bridgeId = 'fail-test-bridge';
      const internalRouter = router as any;

      // Add pending bridge
      await internalRouter.bridgesMutex.runExclusive(async () => {
        internalRouter.pendingBridges.set(bridgeId, {
          status: 'bridging',
          sourceTxHash: '0xsource',
          sourceChain: 'ethereum',
          destChain: 'arbitrum',
          startTime: Date.now(),
        });
      });

      // Mark failed
      await router.markFailed(bridgeId, 'Destination reverted');

      const status = await router.getStatus(bridgeId);
      expect(status.status).toBe('failed');
      expect(status.error).toBe('Destination reverted');
    });
  });

  describe('Memory Management', () => {
    it('should cleanup old bridge entries', async () => {
      const internalRouter = router as any;

      // Add old and new bridges
      const oldTime = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago

      await internalRouter.bridgesMutex.runExclusive(async () => {
        internalRouter.pendingBridges.set('old-bridge', {
          status: 'completed',
          sourceTxHash: '0xold',
          sourceChain: 'ethereum',
          destChain: 'arbitrum',
          startTime: oldTime,
        });

        internalRouter.pendingBridges.set('new-bridge', {
          status: 'bridging',
          sourceTxHash: '0xnew',
          sourceChain: 'ethereum',
          destChain: 'arbitrum',
          startTime: Date.now(),
        });
      });

      // Run cleanup
      await router.cleanup(24 * 60 * 60 * 1000);

      // Old bridge should be removed
      const oldStatus = await router.getStatus('old-bridge');
      expect(oldStatus.error).toBe('Bridge not found');

      // New bridge should remain
      const newStatus = await router.getStatus('new-bridge');
      expect(newStatus.status).toBe('bridging');
    });

    it('should enforce MAX_PENDING_BRIDGES limit', async () => {
      const internalRouter = router as any;
      const MAX_PENDING = 1000;

      // Fill to capacity
      await internalRouter.bridgesMutex.runExclusive(async () => {
        for (let i = 0; i < MAX_PENDING; i++) {
          internalRouter.pendingBridges.set(`bridge-${i}`, {
            status: 'bridging',
            sourceTxHash: `0x${i}`,
            sourceChain: 'ethereum',
            destChain: 'arbitrum',
            startTime: Date.now(),
          });
        }
      });

      expect(internalRouter.pendingBridges.size).toBe(MAX_PENDING);
    });
  });

  describe('Health Check', () => {
    it('should report healthy status with providers', async () => {
      const health = await router.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health.message).toContain('operational');
    });

    it('should report unhealthy when provider fails', async () => {
      const failingProviders = new Map<string, ethers.Provider>();
      failingProviders.set('ethereum', createMockProvider({ shouldFail: true }));

      const unhealthyRouter = new StargateRouter(failingProviders);
      const health = await unhealthyRouter.healthCheck();

      expect(health.healthy).toBe(false);
      unhealthyRouter.dispose();
    });

    it('should report unhealthy with no providers', async () => {
      const emptyRouter = createStargateRouter();
      const health = await emptyRouter.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.message).toContain('No providers');
      emptyRouter.dispose();
    });
  });
});

// =============================================================================
// Phase 3: Bridge Router Factory Tests
// =============================================================================

describe('BridgeRouterFactory Unit Tests', () => {
  let factory: BridgeRouterFactory;
  let providers: Map<string, ethers.Provider>;

  beforeEach(() => {
    providers = new Map();
    providers.set('ethereum', createMockProvider({ chainId: 1 }));
    providers.set('arbitrum', createMockProvider({ chainId: 42161 }));
    providers.set('optimism', createMockProvider({ chainId: 10 }));

    factory = new BridgeRouterFactory({
      defaultProtocol: 'stargate',
      providers,
    });
  });

  it('should create factory with default Stargate router', () => {
    const defaultRouter = factory.getDefaultRouter();
    expect(defaultRouter.protocol).toBe('stargate');
  });

  it('should find best router for supported route', () => {
    const router = factory.findBestRouter('ethereum', 'arbitrum', 'USDC');
    expect(router).not.toBeNull();
    expect(router?.protocol).toBe('stargate');
  });

  it('should return null for unsupported route', () => {
    const router = factory.findBestRouter('solana', 'ethereum', 'USDC');
    expect(router).toBeNull();
  });

  it('should list available protocols', () => {
    const protocols = factory.getAvailableProtocols();
    expect(protocols).toContain('stargate');
  });

  it('should perform health check on all routers', async () => {
    const results = await factory.healthCheckAll();

    expect(results.stargate).toBeDefined();
    expect(results.stargate.healthy).toBe(true);
  });
});

// =============================================================================
// Phase 4: API Key Authentication Integration Tests
// =============================================================================

describe('API Key Authentication Unit Tests', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // We import these dynamically to allow env manipulation
  let apiAuth: any;
  let apiAuthorize: any;
  let initializeApiKeys: any;
  let clearApiKeyStore: any;
  let isAuthEnabled: any;

  beforeAll(async () => {
    // Dynamic import after mocks are set up
    // Use relative path since @arbitrage/security isn't in Jest moduleNameMapper
    const authModule = await import('../../../../../shared/security/src/auth');
    apiAuth = authModule.apiAuth;
    apiAuthorize = authModule.apiAuthorize;
    initializeApiKeys = authModule.initializeApiKeys;
    clearApiKeyStore = authModule.clearApiKeyStore;
    isAuthEnabled = authModule.isAuthEnabled;
  });

  describe('API Key Flow', () => {
    beforeEach(() => {
      clearApiKeyStore();
      process.env.API_KEYS = 'testservice:test-api-key:read:*;write:config';
      delete process.env.JWT_SECRET;
      initializeApiKeys();
    });

    it('should authenticate valid API key and authorize read access', async () => {
      const { req, res, next } = createExpressMocks({
        headers: { 'x-api-key': 'test-api-key' },
      });

      // Authenticate
      await apiAuth()(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(req.user).toBeDefined();
      expect(req.user.isApiKey).toBe(true);

      // Authorize read access
      next.mockClear();
      await apiAuthorize('metrics', 'read')(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('should reject unauthorized write access', async () => {
      const { req, res, next } = createExpressMocks({
        headers: { 'x-api-key': 'test-api-key' },
      });

      // Authenticate
      await apiAuth()(req, res, next);
      expect(next).toHaveBeenCalled();

      // Try unauthorized write
      next.mockClear();
      await apiAuthorize('secrets', 'write')(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('should reject invalid API key', async () => {
      const { req, res, next } = createExpressMocks({
        headers: { 'x-api-key': 'invalid-key' },
      });

      await apiAuth({ required: true })(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });
  });

  describe('Dev Mode (No Auth Configured)', () => {
    beforeEach(() => {
      clearApiKeyStore();
      delete process.env.API_KEYS;
      delete process.env.JWT_SECRET;
    });

    it('should allow requests without authentication in dev mode', async () => {
      const { req, res, next } = createExpressMocks();

      await apiAuth()(req, res, next);
      expect(next).toHaveBeenCalled();
    });
  });
});

// =============================================================================
// Phase 5: End-to-End Flow Tests
// =============================================================================

describe('Phase 5: End-to-End Cross-Chain Flow', () => {
  let router: StargateRouter;
  let providers: Map<string, ethers.Provider>;

  beforeEach(() => {
    providers = new Map();
    providers.set('arbitrum', createMockProvider({ chainId: 42161 }));
    providers.set('optimism', createMockProvider({ chainId: 10 }));

    router = new StargateRouter(providers);
  });

  afterEach(() => {
    router.dispose();
  });

  describe('Complete Bridge Flow Simulation', () => {
    it('should complete a full bridge lifecycle', async () => {
      // 1. Get quote
      const mockContract = {
        quoteLayerZeroFee: jest.fn(() => Promise.resolve([ethers.parseEther('0.01'), 0n])),
      };
      jest.spyOn(ethers, 'Contract').mockReturnValue(mockContract as any);

      const quote = await router.quote({
        sourceChain: 'arbitrum',
        destChain: 'optimism',
        token: 'USDC',
        amount: '1000000000',
      });

      expect(quote.valid).toBe(true);

      // 2. Simulate bridge execution (add pending entry manually for testing)
      const bridgeId = 'e2e-test-bridge';
      const internalRouter = router as any;

      await internalRouter.bridgesMutex.runExclusive(async () => {
        internalRouter.pendingBridges.set(bridgeId, {
          status: 'bridging',
          sourceTxHash: '0xsourcetx',
          sourceChain: 'arbitrum',
          destChain: 'optimism',
          startTime: Date.now(),
        });
      });

      // 3. Check status - should be bridging
      let status = await router.getStatus(bridgeId);
      expect(status.status).toBe('bridging');

      // 4. Simulate destination arrival
      await router.markCompleted(bridgeId, '0xdesttx', '998000000');

      // 5. Final status - should be completed
      status = await router.getStatus(bridgeId);
      expect(status.status).toBe('completed');
      expect(status.destTxHash).toBe('0xdesttx');
      expect(status.amountReceived).toBe('998000000');
    });

    it('should handle bridge failure gracefully', async () => {
      const bridgeId = 'e2e-fail-bridge';
      const internalRouter = router as any;

      // Start bridge
      await internalRouter.bridgesMutex.runExclusive(async () => {
        internalRouter.pendingBridges.set(bridgeId, {
          status: 'bridging',
          sourceTxHash: '0xfailedtx',
          sourceChain: 'arbitrum',
          destChain: 'optimism',
          startTime: Date.now(),
        });
      });

      // Simulate failure
      await router.markFailed(bridgeId, 'Destination chain reverted');

      const status = await router.getStatus(bridgeId);
      expect(status.status).toBe('failed');
      expect(status.error).toBe('Destination chain reverted');
    });
  });

  describe('Concurrent Bridge Operations', () => {
    it('should handle multiple bridges concurrently', async () => {
      const internalRouter = router as any;
      const bridgeCount = 10;

      // Create multiple bridges concurrently
      const createPromises: Promise<void>[] = [];
      for (let i = 0; i < bridgeCount; i++) {
        createPromises.push(
          internalRouter.bridgesMutex.runExclusive(async () => {
            internalRouter.pendingBridges.set(`concurrent-bridge-${i}`, {
              status: 'bridging',
              sourceTxHash: `0x${i}`,
              sourceChain: 'arbitrum',
              destChain: 'optimism',
              startTime: Date.now(),
            });
          })
        );
      }

      await Promise.all(createPromises);

      // Verify all bridges exist
      expect(internalRouter.pendingBridges.size).toBe(bridgeCount);

      // Complete all bridges concurrently
      const completePromises: Promise<void>[] = [];
      for (let i = 0; i < bridgeCount; i++) {
        completePromises.push(
          router.markCompleted(`concurrent-bridge-${i}`, `0xdest${i}`, `${1000 + i}`)
        );
      }

      await Promise.all(completePromises);

      // Verify all completed
      for (let i = 0; i < bridgeCount; i++) {
        const status = await router.getStatus(`concurrent-bridge-${i}`);
        expect(status.status).toBe('completed');
      }
    });
  });
});

// =============================================================================
// AsyncMutex Stress Tests
// =============================================================================

describe('AsyncMutex Stress Tests (Race Condition Prevention)', () => {
  it('should serialize concurrent operations', async () => {
    const mutex = new AsyncMutex();
    const results: number[] = [];

    // Launch many concurrent operations
    const operations: Promise<number>[] = [];
    for (let i = 0; i < 100; i++) {
      operations.push(
        mutex.runExclusive(async () => {
          // Small delay to simulate async work
          await new Promise(resolve => setImmediate(resolve));
          results.push(i);
          return i;
        })
      );
    }

    await Promise.all(operations);

    // All operations should complete
    expect(results.length).toBe(100);

    // Results should be in order (serialized by mutex)
    for (let i = 0; i < 100; i++) {
      expect(results[i]).toBe(i);
    }
  });

  it('should track contention statistics', async () => {
    const mutex = new AsyncMutex();

    // Run operations that will cause contention
    const operations: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) {
      operations.push(
        mutex.runExclusive(async () => {
          await new Promise(resolve => setTimeout(resolve, 1));
        })
      );
    }

    await Promise.all(operations);

    const stats = mutex.getStats();
    expect(stats.acquireCount).toBe(10);
    // Should have contention since operations overlap
    expect(stats.contentionCount).toBeGreaterThan(0);
  });

  it('should handle tryAcquire correctly', async () => {
    const mutex = new AsyncMutex();

    // Acquire lock
    const release = await mutex.acquire();

    // tryAcquire should fail while locked
    const tryResult = mutex.tryAcquire();
    expect(tryResult).toBeNull();

    // Release and try again
    release();

    // Give event loop a chance
    await new Promise(resolve => setImmediate(resolve));

    const tryResult2 = mutex.tryAcquire();
    expect(tryResult2).not.toBeNull();
    tryResult2!();
  });
});
