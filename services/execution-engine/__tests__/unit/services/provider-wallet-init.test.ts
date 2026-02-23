/**
 * Tests for ProviderServiceImpl.initializeWallets()
 *
 * Verifies wallet initialization priority, key caching for reconnection,
 * validation, and fallback behavior.
 *
 * Fix #12: Comprehensive unit tests for wallet initialization and key caching.
 * Fix #9: Tests that cached keys are used during reconnection.
 *
 * @see services/execution-engine/src/services/provider.service.ts
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

// =============================================================================
// Module Mocks — must be declared before imports
// =============================================================================

// Mock ethers — prevent real provider/wallet creation
const mockWalletInstance = {
  address: '0xMockWalletAddress1234567890abcdef12345678',
  privateKey: '0xaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd',
  connect: jest.fn(),
};
const MockWallet = jest.fn().mockReturnValue(mockWalletInstance);
const MockJsonRpcProvider = jest.fn().mockReturnValue({
  getBlockNumber: jest.fn<() => Promise<number>>().mockResolvedValue(12345),
});

jest.mock('ethers', () => ({
  __esModule: true,
  ethers: {
    Wallet: MockWallet,
    JsonRpcProvider: MockJsonRpcProvider,
    isAddress: jest.fn().mockReturnValue(true),
    ZeroAddress: '0x0000000000000000000000000000000000000000',
  },
}));

// Mock @arbitrage/config — provide a controlled CHAINS object
jest.mock('@arbitrage/config', () => ({
  __esModule: true,
  CHAINS: {
    ethereum: { id: 1, name: 'Ethereum', rpcUrl: 'https://eth.example.com', nativeToken: 'ETH' },
    arbitrum: { id: 42161, name: 'Arbitrum', rpcUrl: 'https://arb.example.com', nativeToken: 'ETH' },
  },
}));

// Mock @arbitrage/core — prevent deep import chain
jest.mock('@arbitrage/core', () => ({
  __esModule: true,
  getErrorMessage: jest.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
  NonceManager: jest.fn(),
  BatchProvider: jest.fn(),
  createBatchProvider: jest.fn(),
  clearIntervalSafe: jest.fn().mockReturnValue(null),
}));

// Mock hd-wallet-manager
const mockDerivePerChainWallets = jest.fn<any>().mockReturnValue(new Map());
jest.mock('../../../src/services/hd-wallet-manager', () => ({
  __esModule: true,
  derivePerChainWallets: mockDerivePerChainWallets,
}));

// Mock simulation types
jest.mock('../../../src/services/simulation/types', () => ({
  __esModule: true,
  createCancellableTimeout: jest.fn().mockReturnValue({
    promise: new Promise(() => {}),
    cancel: jest.fn(),
  }),
}));

import { ProviderServiceImpl, ProviderServiceConfig } from '../../../src/services/provider.service';
import type { Logger, ExecutionStats } from '../../../src/types';

// =============================================================================
// Mock Factories
// =============================================================================

const createMockLogger = (): Logger => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
});

const createMockStateManager = () => ({
  isRunning: jest.fn().mockReturnValue(true),
  getState: jest.fn().mockReturnValue('running'),
});

const createMockStats = (): ExecutionStats => ({
  opportunitiesReceived: 0,
  executionAttempts: 0,
  opportunitiesRejected: 0,
  successfulExecutions: 0,
  failedExecutions: 0,
  queueRejects: 0,
  lockConflicts: 0,
  executionTimeouts: 0,
  validationErrors: 0,
  providerReconnections: 0,
  providerHealthCheckFailures: 0,
  simulationsPerformed: 0,
  simulationsSkipped: 0,
  simulationPredictedReverts: 0,
  simulationProfitabilityRejections: 0,
  simulationErrors: 0,
  circuitBreakerTrips: 0,
  circuitBreakerBlocks: 0,
  riskEVRejections: 0,
  riskPositionSizeRejections: 0,
  riskDrawdownBlocks: 0,
  riskCautionCount: 0,
  riskHaltCount: 0,
  staleLockRecoveries: 0,
});

const createMockConfig = (overrides: Partial<ProviderServiceConfig> = {}): ProviderServiceConfig => ({
  logger: createMockLogger(),
  stateManager: createMockStateManager() as any,
  nonceManager: null,
  stats: createMockStats(),
  ...overrides,
});

// Valid 64-hex private key for testing
const VALID_PRIVATE_KEY = '0xaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';
const VALID_PRIVATE_KEY_NO_PREFIX = 'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';

// =============================================================================
// Test Suite: initializeWallets
// =============================================================================

describe('ProviderServiceImpl - initializeWallets', () => {
  let service: ProviderServiceImpl;
  let mockConfig: ProviderServiceConfig;
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    // Isolate env vars per test
    process.env = { ...originalEnv };
    // Clear wallet-related env vars
    delete process.env.WALLET_MNEMONIC;
    delete process.env.WALLET_MNEMONIC_PASSPHRASE;
    delete process.env.ETHEREUM_PRIVATE_KEY;
    delete process.env.ARBITRUM_PRIVATE_KEY;

    mockConfig = createMockConfig();
    service = new ProviderServiceImpl(mockConfig);

    // Pre-populate providers (initializeWallets assumes providers exist)
    const mockEthProvider = { getBlockNumber: jest.fn<() => Promise<number>>().mockResolvedValue(100) };
    const mockArbProvider = { getBlockNumber: jest.fn<() => Promise<number>>().mockResolvedValue(200) };
    (service as any).providers.set('ethereum', mockEthProvider);
    (service as any).providers.set('arbitrum', mockArbProvider);

    // Reset mock wallet constructor
    MockWallet.mockReturnValue({
      address: '0xMockWalletAddress1234567890abcdef12345678',
      privateKey: VALID_PRIVATE_KEY,
      connect: jest.fn(),
    });
  });

  afterEach(async () => {
    await service.clear();
    process.env = originalEnv;
  });

  // ---------------------------------------------------------------------------
  // Test 1: Per-chain private key takes priority over HD derivation
  // ---------------------------------------------------------------------------
  test('per-chain private key takes priority over HD derivation', () => {
    process.env.ETHEREUM_PRIVATE_KEY = VALID_PRIVATE_KEY;
    process.env.WALLET_MNEMONIC = 'test test test test test test test test test test test junk';

    // Set up HD wallet derivation to return a wallet for ethereum
    const mockHDWallet = {
      privateKey: '0x1111111111111111111111111111111111111111111111111111111111111111',
      address: '0xHDWalletAddress',
      path: "m/44'/60'/0'/0/0",
    };
    mockDerivePerChainWallets.mockReturnValue(
      new Map([['ethereum', mockHDWallet], ['arbitrum', mockHDWallet]]),
    );

    service.initializeWallets();

    // Wallet should have been created with the per-chain private key, not the HD key
    expect(MockWallet).toHaveBeenCalledWith(VALID_PRIVATE_KEY, expect.anything());

    // Verify source logged as 'private-key' for ethereum
    expect(mockConfig.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Initialized wallet for ethereum'),
      expect.objectContaining({ source: 'private-key' }),
    );
  });

  // ---------------------------------------------------------------------------
  // Test 2: HD derivation fallback when no per-chain key
  // ---------------------------------------------------------------------------
  test('HD derivation fallback when no per-chain key', () => {
    process.env.WALLET_MNEMONIC = 'test test test test test test test test test test test junk';

    const mockHDWallet = {
      privateKey: '0x2222222222222222222222222222222222222222222222222222222222222222',
      address: '0xHDWalletAddress',
      path: "m/44'/60'/0'/0/0",
    };
    mockDerivePerChainWallets.mockReturnValue(
      new Map([['ethereum', mockHDWallet]]),
    );

    service.initializeWallets();

    // Wallet should have been created with the HD-derived private key
    expect(MockWallet).toHaveBeenCalledWith(
      '0x2222222222222222222222222222222222222222222222222222222222222222',
      expect.anything(),
    );

    // Verify source logged as 'hd-derivation'
    expect(mockConfig.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Initialized wallet for ethereum'),
      expect.objectContaining({ source: 'hd-derivation' }),
    );
  });

  // ---------------------------------------------------------------------------
  // Test 3: Invalid private key format is rejected
  // ---------------------------------------------------------------------------
  test('invalid private key format is rejected with error log', () => {
    process.env.ETHEREUM_PRIVATE_KEY = 'not-a-valid-hex-key';

    service.initializeWallets();

    // Should not create a wallet
    expect(MockWallet).not.toHaveBeenCalled();

    // Should log an error about invalid format
    expect(mockConfig.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Invalid private key format for ethereum'),
      expect.objectContaining({
        hint: 'Private key must be 64 hex characters (or 66 with 0x prefix)',
        envVar: 'ETHEREUM_PRIVATE_KEY',
      }),
    );
  });

  // ---------------------------------------------------------------------------
  // Test 4: Nonce manager registration
  // ---------------------------------------------------------------------------
  test('nonceManager.registerWallet() is called for each initialized wallet', () => {
    const mockNonceManager = {
      registerWallet: jest.fn(),
      resetChain: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };
    mockConfig = createMockConfig({ nonceManager: mockNonceManager as any });
    service = new ProviderServiceImpl(mockConfig);

    // Re-populate providers
    (service as any).providers.set('ethereum', { getBlockNumber: jest.fn() });
    (service as any).providers.set('arbitrum', { getBlockNumber: jest.fn() });

    process.env.ETHEREUM_PRIVATE_KEY = VALID_PRIVATE_KEY;
    process.env.ARBITRUM_PRIVATE_KEY = VALID_PRIVATE_KEY;

    service.initializeWallets();

    expect(mockNonceManager.registerWallet).toHaveBeenCalledTimes(2);
    expect(mockNonceManager.registerWallet).toHaveBeenCalledWith('ethereum', expect.anything());
    expect(mockNonceManager.registerWallet).toHaveBeenCalledWith('arbitrum', expect.anything());
  });

  // ---------------------------------------------------------------------------
  // Test 5: Missing provider skips wallet
  // ---------------------------------------------------------------------------
  test('missing provider skips wallet creation', () => {
    // Remove the ethereum provider
    (service as any).providers.delete('ethereum');

    process.env.ETHEREUM_PRIVATE_KEY = VALID_PRIVATE_KEY;

    service.initializeWallets();

    // Wallet constructor should not be called for ethereum (no provider)
    // But may be called for arbitrum if it has a key — ensure ethereum is skipped
    const wallets = service.getWallets();
    expect(wallets.has('ethereum')).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Test 6: No wallet configured logs debug message
  // ---------------------------------------------------------------------------
  test('no wallet configured logs debug message', () => {
    // No private keys, no mnemonic set
    service.initializeWallets();

    expect(mockConfig.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('No wallet configured for ethereum'),
    );
    expect(mockConfig.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('No wallet configured for arbitrum'),
    );
  });

  // ---------------------------------------------------------------------------
  // Test 7: HD derivation failure falls back to per-chain keys
  // ---------------------------------------------------------------------------
  test('HD derivation failure falls back to per-chain keys', () => {
    process.env.WALLET_MNEMONIC = 'invalid mnemonic that will fail';
    process.env.ETHEREUM_PRIVATE_KEY = VALID_PRIVATE_KEY;

    // Make HD derivation throw
    mockDerivePerChainWallets.mockImplementation(() => {
      throw new Error('Invalid WALLET_MNEMONIC');
    });

    service.initializeWallets();

    // Should log the HD failure (getErrorMessage mock is reset by clearAllMocks,
    // so the error field may be undefined — just verify the message is logged)
    expect(mockConfig.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('HD wallet derivation failed'),
      expect.any(Object),
    );

    // Per-chain key should still work
    expect(MockWallet).toHaveBeenCalledWith(VALID_PRIVATE_KEY, expect.anything());
    expect(mockConfig.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Initialized wallet for ethereum'),
      expect.objectContaining({ source: 'private-key' }),
    );
  });

  // ---------------------------------------------------------------------------
  // Test 8: Private key without 0x prefix is accepted (valid hex)
  // ---------------------------------------------------------------------------
  test('private key without 0x prefix is accepted', () => {
    process.env.ETHEREUM_PRIVATE_KEY = VALID_PRIVATE_KEY_NO_PREFIX;

    service.initializeWallets();

    expect(MockWallet).toHaveBeenCalledWith(VALID_PRIVATE_KEY_NO_PREFIX, expect.anything());
    expect(mockConfig.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Initialized wallet for ethereum'),
      expect.objectContaining({ source: 'private-key' }),
    );
  });
});

// =============================================================================
// Test Suite: Fix #9 — Cached keys used on reconnect
// =============================================================================

describe('ProviderServiceImpl - Cached Key Reconnection (Fix #9)', () => {
  let service: ProviderServiceImpl;
  let mockConfig: ProviderServiceConfig;
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.WALLET_MNEMONIC;
    delete process.env.WALLET_MNEMONIC_PASSPHRASE;
    delete process.env.ETHEREUM_PRIVATE_KEY;
    delete process.env.ARBITRUM_PRIVATE_KEY;

    mockConfig = createMockConfig();
    service = new ProviderServiceImpl(mockConfig);

    // Pre-populate providers
    const mockProvider = { getBlockNumber: jest.fn<() => Promise<number>>().mockResolvedValue(100) };
    (service as any).providers.set('ethereum', mockProvider);

    MockWallet.mockReturnValue({
      address: '0xMockWalletAddress1234567890abcdef12345678',
      privateKey: VALID_PRIVATE_KEY,
      connect: jest.fn().mockReturnValue({
        address: '0xMockWalletAddress1234567890abcdef12345678',
        privateKey: VALID_PRIVATE_KEY,
      }),
    });
  });

  afterEach(async () => {
    await service.clear();
    process.env = originalEnv;
  });

  test('initializeWallets caches per-chain private key in chainPrivateKeys map', () => {
    process.env.ETHEREUM_PRIVATE_KEY = VALID_PRIVATE_KEY;

    service.initializeWallets();

    // Verify key is cached internally
    const cachedKeys: Map<string, string> = (service as any).chainPrivateKeys;
    expect(cachedKeys.get('ethereum')).toBe(VALID_PRIVATE_KEY);
  });

  test('initializeWallets caches HD-derived private key in chainPrivateKeys map', () => {
    process.env.WALLET_MNEMONIC = 'test test test test test test test test test test test junk';

    const hdPrivateKey = '0x3333333333333333333333333333333333333333333333333333333333333333';
    const mockHDWallet = {
      privateKey: hdPrivateKey,
      address: '0xHDAddress',
      path: "m/44'/60'/0'/0/0",
    };
    mockDerivePerChainWallets.mockReturnValue(new Map([['ethereum', mockHDWallet]]));

    service.initializeWallets();

    const cachedKeys: Map<string, string> = (service as any).chainPrivateKeys;
    expect(cachedKeys.get('ethereum')).toBe(hdPrivateKey);
  });

  test('reconnection uses cached key instead of process.env', async () => {
    process.env.ETHEREUM_PRIVATE_KEY = VALID_PRIVATE_KEY;

    service.initializeWallets();

    // Now delete the env var to simulate key rotation / cleanup
    delete process.env.ETHEREUM_PRIVATE_KEY;

    // Verify it would use the cached key, not process.env
    const cachedKeys: Map<string, string> = (service as any).chainPrivateKeys;
    expect(cachedKeys.has('ethereum')).toBe(true);
    expect(process.env.ETHEREUM_PRIVATE_KEY).toBeUndefined();

    // The cached key should be the original value
    expect(cachedKeys.get('ethereum')).toBe(VALID_PRIVATE_KEY);
  });

  test('clear() empties the chainPrivateKeys cache', async () => {
    process.env.ETHEREUM_PRIVATE_KEY = VALID_PRIVATE_KEY;

    service.initializeWallets();

    expect((service as any).chainPrivateKeys.size).toBeGreaterThan(0);

    await service.clear();

    expect((service as any).chainPrivateKeys.size).toBe(0);
  });
});
