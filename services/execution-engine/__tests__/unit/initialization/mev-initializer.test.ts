/**
 * MEV Initializer Unit Tests
 *
 * Tests for initializeMevProviders — the MEV protection provider setup
 * during execution engine startup.
 *
 * These tests exercise the REAL initialization logic in mev-initializer.ts,
 * mocking only external dependencies (MevProviderFactory, config, provider service).
 *
 * Covers:
 * - Disabled MEV config (production default)
 * - Successful provider initialization for configured chains
 * - Chain skip paths: no provider/wallet, unconfigured, disabled, jito
 * - Provider initialization timeout behavior
 * - Provider creation failure (partial failures)
 * - Factory cache verification (ADR-017 compliance)
 * - All-providers-failed result
 * - Result structure: success, failedChains, skippedChains
 *
 * @see mev-initializer.ts
 * @see ADR-017: MEV Protection Enhancement
 */

import { jest, describe, test, expect, beforeEach } from '@jest/globals';

// =============================================================================
// Mock Dependencies — must be declared before imports
// =============================================================================

// Track mock state for MevProviderFactory
let mockProviderCache: Map<string, unknown>;
let mockCreateProviderAsync: jest.Mock;
let mockGetProvider: jest.Mock;

/**
 * Re-apply MevProviderFactory mock implementation.
 * Must be called in beforeEach because resetAllMocks clears mockImplementation.
 */
function applyMevProviderFactoryMock(): void {
  mockProviderCache = new Map();
  mockCreateProviderAsync = jest.fn().mockImplementation(async (opts: { chain: string }) => {
    const provider = {
      strategy: 'flashbots',
      isEnabled: () => true,
      submitBundle: jest.fn(),
      simulateBundle: jest.fn(),
    };
    mockProviderCache.set(opts.chain, provider);
    return provider;
  });
  mockGetProvider = jest.fn().mockImplementation((chain: string) => mockProviderCache.get(chain));

  const { MevProviderFactory } = jest.requireMock('@arbitrage/core/mev-protection') as {
    MevProviderFactory: jest.Mock;
  };
  MevProviderFactory.mockImplementation(() => ({
    createProviderAsync: mockCreateProviderAsync,
    getProvider: mockGetProvider,
    getProviders: jest.fn().mockImplementation(() => mockProviderCache),
    clearProviders: jest.fn().mockImplementation(() => mockProviderCache.clear()),
  }));
}

jest.mock('@arbitrage/core/mev-protection', () => ({
  MevProviderFactory: jest.fn(),
  MevGlobalConfig: {},
}));

jest.mock('@arbitrage/core/resilience', () => ({
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

// Mock the cancellable timeout — use real setTimeout logic but controllable
jest.mock('../../../src/services/simulation/types', () => ({
  createCancellableTimeout: jest.fn(),
}));

/**
 * Re-apply createCancellableTimeout mock implementation.
 * Must be called in beforeEach because resetAllMocks clears mockImplementation.
 */
function applyCancellableTimeoutMock(): void {
  const { createCancellableTimeout } = jest.requireMock(
    '../../../src/services/simulation/types',
  ) as { createCancellableTimeout: jest.Mock };

  createCancellableTimeout.mockImplementation((ms: number, message: string) => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const promise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(message)), ms);
    });
    const cancel = () => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
    };
    return { promise, cancel };
  });
}

// MEV_CONFIG is mutable so tests can toggle enabled/chainSettings
const mockMevConfig = {
  enabled: false,
  flashbotsAuthKey: 'test-flashbots-key',
  bloxrouteAuthHeader: 'test-bloxroute-header',
  flashbotsRelayUrl: 'https://relay.test.net',
  submissionTimeoutMs: 30000,
  maxRetries: 3,
  fallbackToPublic: true,
  useMevShare: false,
  chainSettings: {
    ethereum: { enabled: true, strategy: 'flashbots' },
    polygon: { enabled: true, strategy: 'fastlane' },
    arbitrum: { enabled: true, strategy: 'bloxroute' },
    bsc: { enabled: false, strategy: 'bloxroute' },
    solana: { enabled: true, strategy: 'jito' },
  } as Record<string, { enabled: boolean; strategy: string }>,
};

jest.mock('@arbitrage/config', () => ({
  MEV_CONFIG: mockMevConfig,
}));

// =============================================================================
// Import SUT after mocks
// =============================================================================
import { initializeMevProviders } from '../../../src/initialization/mev-initializer';
import type { InitializationLogger } from '../../../src/initialization/types';

// =============================================================================
// Test Helpers
// =============================================================================

function createMockLogger(): InitializationLogger {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

function createMockProviderService(chains: string[]) {
  const wallets = new Map<string, { address: string }>();
  const providers = new Map<string, { getBlockNumber: () => Promise<number> }>();

  for (const chain of chains) {
    wallets.set(chain, { address: `0x${chain}-wallet` });
    providers.set(chain, { getBlockNumber: () => Promise.resolve(12345) });
  }

  return {
    getWallets: jest.fn().mockReturnValue(wallets),
    getProvider: jest.fn().mockImplementation((chain: string) => providers.get(chain)),
    getWallet: jest.fn().mockImplementation((chain: string) => wallets.get(chain)),
    getProviders: jest.fn().mockReturnValue(providers),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('initializeMevProviders', () => {
  let mockLogger: InitializationLogger;

  beforeEach(() => {
    mockLogger = createMockLogger();
    // Reset config to default (disabled)
    mockMevConfig.enabled = false;
    mockMevConfig.chainSettings = {
      ethereum: { enabled: true, strategy: 'flashbots' },
      polygon: { enabled: true, strategy: 'fastlane' },
      arbitrum: { enabled: true, strategy: 'bloxroute' },
      bsc: { enabled: false, strategy: 'bloxroute' },
      solana: { enabled: true, strategy: 'jito' },
    };
    // Re-apply mock implementations (cleared by resetAllMocks)
    applyMevProviderFactoryMock();
    applyCancellableTimeoutMock();
  });

  // ===========================================================================
  // Disabled MEV Config
  // ===========================================================================

  describe('when MEV is disabled', () => {
    test('should return disabled result with null factory', async () => {
      const providerService = createMockProviderService(['ethereum']);
      const result = await initializeMevProviders(providerService as any, mockLogger);

      expect(result.success).toBe(true);
      expect(result.factory).toBeNull();
      expect(result.providersInitialized).toBe(0);
    });

    test('should log that MEV is disabled', async () => {
      const providerService = createMockProviderService(['ethereum']);
      await initializeMevProviders(providerService as any, mockLogger);

      expect(mockLogger.info).toHaveBeenCalledWith('MEV protection disabled by configuration');
    });

    test('should not attempt provider creation', async () => {
      const providerService = createMockProviderService(['ethereum']);
      await initializeMevProviders(providerService as any, mockLogger);

      expect(mockCreateProviderAsync).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Enabled MEV — Successful Initialization
  // ===========================================================================

  describe('when MEV is enabled with valid chains', () => {
    beforeEach(() => {
      mockMevConfig.enabled = true;
    });

    test('should initialize providers for configured EVM chains', async () => {
      const providerService = createMockProviderService(['ethereum', 'polygon']);
      const result = await initializeMevProviders(providerService as any, mockLogger);

      expect(result.success).toBe(true);
      expect(result.factory).not.toBeNull();
      expect(result.providersInitialized).toBe(2);
    });

    test('should pass correct chain, provider, and wallet to factory', async () => {
      const providerService = createMockProviderService(['ethereum']);
      await initializeMevProviders(providerService as any, mockLogger);

      expect(mockCreateProviderAsync).toHaveBeenCalledWith({
        chain: 'ethereum',
        provider: expect.objectContaining({ getBlockNumber: expect.any(Function) }),
        wallet: expect.objectContaining({ address: '0xethereum-wallet' }),
      });
    });

    test('should verify provider is cached after creation (ADR-017)', async () => {
      const providerService = createMockProviderService(['ethereum']);
      await initializeMevProviders(providerService as any, mockLogger);

      // getProvider should be called to verify caching
      expect(mockGetProvider).toHaveBeenCalledWith('ethereum');
    });

    test('should log provider details on success', async () => {
      const providerService = createMockProviderService(['ethereum']);
      await initializeMevProviders(providerService as any, mockLogger);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'MEV provider initialized for ethereum',
        expect.objectContaining({
          strategy: 'flashbots',
          enabled: true,
        }),
      );
    });

    test('should include timing information in completion log', async () => {
      const providerService = createMockProviderService(['ethereum']);
      await initializeMevProviders(providerService as any, mockLogger);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'MEV protection initialization complete',
        expect.objectContaining({
          providersInitialized: 1,
          globalEnabled: true,
          durationMs: expect.any(Number),
        }),
      );
    });

    test('should not include skippedChains/failedChains when all succeed', async () => {
      const providerService = createMockProviderService(['ethereum']);
      const result = await initializeMevProviders(providerService as any, mockLogger);

      expect(result.skippedChains).toBeUndefined();
      expect(result.failedChains).toBeUndefined();
    });
  });

  // ===========================================================================
  // Chain Skip Paths
  // ===========================================================================

  describe('chain skip paths', () => {
    beforeEach(() => {
      mockMevConfig.enabled = true;
    });

    test('should skip chain with no provider available', async () => {
      const providerService = createMockProviderService([]);
      // Return wallets for ethereum but no provider
      providerService.getWallets.mockReturnValue(new Map([
        ['ethereum', { address: '0xeth-wallet' }],
      ]));
      providerService.getProvider.mockReturnValue(undefined);
      providerService.getWallet.mockReturnValue({ address: '0xeth-wallet' });

      const result = await initializeMevProviders(providerService as any, mockLogger);

      expect(result.success).toBe(true);
      expect(result.providersInitialized).toBe(0);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Skipping MEV provider for ethereum: no provider or wallet'),
      );
    });

    test('should skip chain with no wallet available', async () => {
      const providerService = createMockProviderService([]);
      providerService.getWallets.mockReturnValue(new Map([
        ['ethereum', { address: '0xeth-wallet' }],
      ]));
      providerService.getProvider.mockReturnValue({ getBlockNumber: () => Promise.resolve(1) });
      providerService.getWallet.mockReturnValue(undefined);

      const result = await initializeMevProviders(providerService as any, mockLogger);

      expect(result.success).toBe(true);
      expect(result.skippedChains).toContain('ethereum');
    });

    test('should skip unconfigured chains (not in MEV_CONFIG.chainSettings)', async () => {
      const providerService = createMockProviderService(['unknown-chain']);

      const result = await initializeMevProviders(providerService as any, mockLogger);

      expect(result.success).toBe(true);
      expect(result.skippedChains).toContain('unknown-chain');
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Skipping MEV provider for unknown-chain: chain not in MEV_CONFIG.chainSettings'),
      );
    });

    test('should skip chains explicitly disabled in config', async () => {
      // bsc is disabled in our mock config
      const providerService = createMockProviderService(['bsc']);

      const result = await initializeMevProviders(providerService as any, mockLogger);

      expect(result.success).toBe(true);
      expect(result.skippedChains).toContain('bsc');
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Skipping MEV provider for bsc: disabled in config'),
      );
    });

    test('should skip Solana (jito strategy is not EVM compatible)', async () => {
      const providerService = createMockProviderService(['solana']);

      const result = await initializeMevProviders(providerService as any, mockLogger);

      expect(result.success).toBe(true);
      expect(result.skippedChains).toContain('solana');
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Skipping MEV provider for solana: requires JitoProvider'),
      );
    });

    test('should include all skipped chains in result', async () => {
      // All chains will be skipped for various reasons
      const providerService = createMockProviderService(['bsc', 'solana', 'unknown-chain']);

      const result = await initializeMevProviders(providerService as any, mockLogger);

      expect(result.success).toBe(true);
      expect(result.providersInitialized).toBe(0);
      expect(result.skippedChains).toEqual(
        expect.arrayContaining(['bsc', 'solana', 'unknown-chain']),
      );
    });
  });

  // ===========================================================================
  // Provider Creation Failure / Partial Failures
  // ===========================================================================

  describe('provider creation failures', () => {
    beforeEach(() => {
      mockMevConfig.enabled = true;
    });

    test('should handle provider creation error gracefully', async () => {
      mockCreateProviderAsync.mockRejectedValue(new Error('Auth key invalid'));

      const providerService = createMockProviderService(['ethereum']);
      const result = await initializeMevProviders(providerService as any, mockLogger);

      expect(result.success).toBe(false);
      expect(result.providersInitialized).toBe(0);
      expect(result.failedChains).toContain('ethereum');
    });

    test('should use standardized error format in failure log', async () => {
      mockCreateProviderAsync.mockRejectedValue(new Error('Connection refused'));

      const providerService = createMockProviderService(['ethereum']);
      await initializeMevProviders(providerService as any, mockLogger);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to initialize MEV provider for ethereum',
        expect.objectContaining({
          error: expect.stringContaining('mev:ethereum:Connection refused'),
        }),
      );
    });

    test('should continue initializing other chains when one fails', async () => {
      // ethereum fails, polygon succeeds
      mockCreateProviderAsync.mockImplementation(async (opts: { chain: string }) => {
        if (opts.chain === 'ethereum') {
          throw new Error('Flashbots auth failed');
        }
        const provider = { strategy: 'fastlane', isEnabled: () => true };
        mockProviderCache.set(opts.chain, provider);
        return provider;
      });

      const providerService = createMockProviderService(['ethereum', 'polygon']);
      const result = await initializeMevProviders(providerService as any, mockLogger);

      expect(result.success).toBe(true);
      expect(result.providersInitialized).toBe(1);
      expect(result.failedChains).toContain('ethereum');
    });

    test('should report all-providers-failed when every attempt fails', async () => {
      mockCreateProviderAsync.mockRejectedValue(new Error('Network error'));

      const providerService = createMockProviderService(['ethereum', 'polygon']);
      const result = await initializeMevProviders(providerService as any, mockLogger);

      expect(result.success).toBe(false);
      expect(result.providersInitialized).toBe(0);
      expect(result.error).toContain('mev:all_providers_failed');
      expect(result.error).toContain('2_attempted');
    });

    test('should log warning when all providers fail', async () => {
      mockCreateProviderAsync.mockRejectedValue(new Error('Timeout'));

      const providerService = createMockProviderService(['ethereum']);
      await initializeMevProviders(providerService as any, mockLogger);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'MEV protection enabled but no providers initialized successfully',
        expect.objectContaining({
          attemptedChains: 1,
          failedChains: ['ethereum'],
        }),
      );
    });
  });

  // ===========================================================================
  // Factory Cache Verification (ADR-017)
  // ===========================================================================

  describe('factory cache verification', () => {
    beforeEach(() => {
      mockMevConfig.enabled = true;
    });

    test('should detect uncached provider and report failure', async () => {
      // Provider created successfully but NOT in cache
      mockCreateProviderAsync.mockResolvedValue({
        strategy: 'flashbots',
        isEnabled: () => true,
      });
      mockGetProvider.mockReturnValue(undefined); // Not in cache

      const providerService = createMockProviderService(['ethereum']);
      const result = await initializeMevProviders(providerService as any, mockLogger);

      // Should fail because provider isn't cached
      expect(result.success).toBe(false);
      expect(result.providersInitialized).toBe(0);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'MEV provider created but not cached for ethereum',
        expect.objectContaining({
          error: 'mev:ethereum:provider_not_cached',
        }),
      );
    });
  });

  // ===========================================================================
  // Timeout Behavior
  // ===========================================================================

  describe('timeout behavior', () => {
    beforeEach(() => {
      mockMevConfig.enabled = true;
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    test('should timeout if provider initialization hangs', async () => {
      // Use the real createCancellableTimeout for this test (mock uses real setTimeout)
      // Make createProviderAsync never resolve
      mockCreateProviderAsync.mockImplementation(
        () => new Promise(() => {/* never resolves */}),
      );

      const providerService = createMockProviderService(['ethereum']);
      const initPromise = initializeMevProviders(providerService as any, mockLogger);

      // Advance past timeout
      jest.advanceTimersByTime(30_001);

      const result = await initPromise;

      expect(result.success).toBe(false);
      expect(result.providersInitialized).toBe(0);
      expect(result.failedChains).toContain('ethereum');
    });

    test('should cancel timeout when provider resolves before timeout', async () => {
      const { createCancellableTimeout } = jest.requireMock(
        '../../../src/services/simulation/types',
      ) as { createCancellableTimeout: jest.Mock };

      let cancelWasCalled = false;
      createCancellableTimeout.mockImplementation((_ms: number, _msg: string) => {
        return {
          promise: new Promise<never>(() => {/* never resolves */}),
          cancel: () => { cancelWasCalled = true; },
        };
      });

      const providerService = createMockProviderService(['ethereum']);
      await initializeMevProviders(providerService as any, mockLogger);

      expect(cancelWasCalled).toBe(true);
    });
  });

  // ===========================================================================
  // MevGlobalConfig Construction
  // ===========================================================================

  describe('MevGlobalConfig construction', () => {
    beforeEach(() => {
      mockMevConfig.enabled = true;
    });

    test('should pass all config fields to MevProviderFactory', async () => {
      const { MevProviderFactory } = jest.requireMock('@arbitrage/core/mev-protection') as {
        MevProviderFactory: jest.Mock;
      };

      const providerService = createMockProviderService(['ethereum']);
      await initializeMevProviders(providerService as any, mockLogger);

      expect(MevProviderFactory).toHaveBeenCalledWith({
        enabled: true,
        flashbotsAuthKey: 'test-flashbots-key',
        bloxrouteAuthHeader: 'test-bloxroute-header',
        flashbotsRelayUrl: 'https://relay.test.net',
        submissionTimeoutMs: 30000,
        maxRetries: 3,
        fallbackToPublic: true,
        useMevShare: false,
      });
    });
  });

  // ===========================================================================
  // Mixed Chain Results (Success + Skip + Fail)
  // ===========================================================================

  describe('mixed chain results', () => {
    beforeEach(() => {
      mockMevConfig.enabled = true;
    });

    test('should track success, skipped, and failed chains separately', async () => {
      // ethereum: succeeds, polygon: succeeds, bsc: disabled (skip), solana: jito (skip), arbitrum: fails
      mockCreateProviderAsync.mockImplementation(async (opts: { chain: string }) => {
        if (opts.chain === 'arbitrum') {
          throw new Error('Provider unavailable');
        }
        const provider = { strategy: 'flashbots', isEnabled: () => true };
        mockProviderCache.set(opts.chain, provider);
        return provider;
      });

      const providerService = createMockProviderService(['ethereum', 'polygon', 'bsc', 'solana', 'arbitrum']);
      const result = await initializeMevProviders(providerService as any, mockLogger);

      expect(result.success).toBe(true);
      expect(result.providersInitialized).toBe(2); // ethereum + polygon
      expect(result.failedChains).toContain('arbitrum');
      expect(result.skippedChains).toEqual(expect.arrayContaining(['bsc', 'solana']));
    });
  });

  // ===========================================================================
  // Empty Chain List
  // ===========================================================================

  describe('empty chain list', () => {
    test('should handle no chains gracefully', async () => {
      mockMevConfig.enabled = true;
      const providerService = createMockProviderService([]);

      const result = await initializeMevProviders(providerService as any, mockLogger);

      expect(result.success).toBe(true);
      expect(result.providersInitialized).toBe(0);
      expect(result.factory).not.toBeNull();
    });
  });
});
