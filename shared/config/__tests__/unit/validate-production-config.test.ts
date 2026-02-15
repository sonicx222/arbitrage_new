/**
 * validateProductionConfig() Tests
 *
 * Comprehensive test coverage for validateProductionConfig() (Finding #15).
 * Tests all validation branches: production detection, Redis URL,
 * wallet credentials, RPC URLs, provider keys, Solana partition, and warnings.
 *
 * Uses jest.resetModules() + dynamic import to get a fresh module for each
 * test, ensuring isProduction (module-level const from NODE_ENV) is
 * re-evaluated from current process.env.
 *
 * @see .agent-reports/shared-config-deep-analysis.md Finding #15
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

// Save original env to restore after each test
const originalEnv = { ...process.env };

/**
 * Env var overrides that clear all chain RPC URLs and provider API keys.
 * Used by tests that need to verify "no RPC configuration" error paths.
 */
const NO_RPC_ENV: Record<string, undefined> = {
  ARBITRUM_RPC_URL: undefined,
  BSC_RPC_URL: undefined,
  BASE_RPC_URL: undefined,
  POLYGON_RPC_URL: undefined,
  OPTIMISM_RPC_URL: undefined,
  ETHEREUM_RPC_URL: undefined,
  AVALANCHE_RPC_URL: undefined,
  FANTOM_RPC_URL: undefined,
  ZKSYNC_RPC_URL: undefined,
  LINEA_RPC_URL: undefined,
  SOLANA_RPC_URL: undefined,
  DRPC_API_KEY: undefined,
  ANKR_API_KEY: undefined,
  INFURA_API_KEY: undefined,
  ALCHEMY_API_KEY: undefined,
};

/**
 * Helper: dynamically import service-config with specific env vars.
 * Resets module cache so isProduction and all module-level state
 * are re-evaluated from current process.env.
 */
async function importWithEnv(envOverrides: Record<string, string | undefined>): Promise<{
  validateProductionConfig: () => void;
}> {
  // Reset env to clean state
  process.env = { ...originalEnv };

  // Apply overrides
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  // Always disable auto-validation in tests
  process.env.DISABLE_CONFIG_VALIDATION = 'true';

  // Reset module cache so import() re-evaluates module-level code (isProduction, etc.)
  jest.resetModules();

  // Dynamic import gets a fresh module with current env
  const mod = await import('../../src/service-config');
  return { validateProductionConfig: mod.validateProductionConfig };
}

describe('validateProductionConfig', () => {
  beforeEach(() => {
    // Reset env to original before each test
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  afterEach(() => {
    // Ensure env is always cleaned up
    process.env = { ...originalEnv };
  });

  // ===========================================================================
  // NON-PRODUCTION: Early return
  // ===========================================================================

  describe('non-production environment', () => {
    it('should return without error when NODE_ENV is not production', async () => {
      const { validateProductionConfig } = await importWithEnv({});
      expect(() => validateProductionConfig()).not.toThrow();
    });

    it('should return without error when NODE_ENV is development', async () => {
      const { validateProductionConfig } = await importWithEnv({
        NODE_ENV: 'development',
        FLY_APP_NAME: undefined,
        RAILWAY_ENVIRONMENT: undefined,
        RENDER_SERVICE_NAME: undefined,
        KOYEB_SERVICE_NAME: undefined,
      });
      expect(() => validateProductionConfig()).not.toThrow();
    });
  });

  // ===========================================================================
  // PRODUCTION: Redis URL validation
  // ===========================================================================

  describe('production - Redis URL validation', () => {
    it('should throw when REDIS_URL is missing in production', async () => {
      const { validateProductionConfig } = await importWithEnv({
        NODE_ENV: 'production',
        REDIS_URL: undefined,
        WALLET_PRIVATE_KEY: '0xdeadbeef',
        ARBITRUM_RPC_URL: 'https://arb.example.com',
      });

      expect(() => validateProductionConfig()).toThrow('Production configuration validation failed');
      expect(() => validateProductionConfig()).toThrow('REDIS_URL');
    });

    it('should throw when REDIS_URL points to localhost', async () => {
      const { validateProductionConfig } = await importWithEnv({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://localhost:6379',
        WALLET_PRIVATE_KEY: '0xdeadbeef',
        ARBITRUM_RPC_URL: 'https://arb.example.com',
      });

      expect(() => validateProductionConfig()).toThrow('REDIS_URL');
    });

    it('should throw when REDIS_URL points to 127.0.0.1', async () => {
      const { validateProductionConfig } = await importWithEnv({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://127.0.0.1:6379',
        WALLET_PRIVATE_KEY: '0xdeadbeef',
        ARBITRUM_RPC_URL: 'https://arb.example.com',
      });

      expect(() => validateProductionConfig()).toThrow('REDIS_URL');
    });

    it('should not throw when REDIS_URL points to a production host', async () => {
      const { validateProductionConfig } = await importWithEnv({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://my-redis.prod.example.com:6379',
        WALLET_PRIVATE_KEY: '0xdeadbeef',
        ARBITRUM_RPC_URL: 'https://arb.example.com',
      });

      expect(() => validateProductionConfig()).not.toThrow();
    });
  });

  // ===========================================================================
  // PRODUCTION: Wallet credentials validation
  // ===========================================================================

  describe('production - wallet credentials', () => {
    it('should throw when both WALLET_PRIVATE_KEY and WALLET_MNEMONIC are missing', async () => {
      const { validateProductionConfig } = await importWithEnv({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://prod-redis.example.com:6379',
        WALLET_PRIVATE_KEY: undefined,
        WALLET_MNEMONIC: undefined,
        ARBITRUM_RPC_URL: 'https://arb.example.com',
      });

      expect(() => validateProductionConfig()).toThrow('WALLET_PRIVATE_KEY or WALLET_MNEMONIC');
    });

    it('should not throw when WALLET_PRIVATE_KEY is set', async () => {
      const { validateProductionConfig } = await importWithEnv({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://prod-redis.example.com:6379',
        WALLET_PRIVATE_KEY: '0xdeadbeef1234567890',
        WALLET_MNEMONIC: undefined,
        ARBITRUM_RPC_URL: 'https://arb.example.com',
      });

      expect(() => validateProductionConfig()).not.toThrow();
    });

    it('should not throw when WALLET_MNEMONIC is set instead', async () => {
      const { validateProductionConfig } = await importWithEnv({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://prod-redis.example.com:6379',
        WALLET_PRIVATE_KEY: undefined,
        WALLET_MNEMONIC: 'test test test test test test test test test test test junk',
        ARBITRUM_RPC_URL: 'https://arb.example.com',
      });

      expect(() => validateProductionConfig()).not.toThrow();
    });
  });

  // ===========================================================================
  // PRODUCTION: RPC URL / provider key validation
  // ===========================================================================

  describe('production - RPC URL and provider key validation', () => {
    it('should throw when no chain RPC URLs and no provider keys are set', async () => {
      const { validateProductionConfig } = await importWithEnv({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://prod-redis.example.com:6379',
        WALLET_PRIVATE_KEY: '0xdeadbeef',
        ...NO_RPC_ENV,
      });

      expect(() => validateProductionConfig()).toThrow('RPC Configuration');
    });

    it('should not throw when at least one chain RPC URL is configured', async () => {
      const { validateProductionConfig } = await importWithEnv({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://prod-redis.example.com:6379',
        WALLET_PRIVATE_KEY: '0xdeadbeef',
        ARBITRUM_RPC_URL: 'https://arb-mainnet.g.alchemy.com/v2/key',
      });

      expect(() => validateProductionConfig()).not.toThrow();
    });

    it('should not throw when a provider API key is set as fallback', async () => {
      const { validateProductionConfig } = await importWithEnv({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://prod-redis.example.com:6379',
        WALLET_PRIVATE_KEY: '0xdeadbeef',
        ...NO_RPC_ENV,
        DRPC_API_KEY: 'my-drpc-key',
      });

      expect(() => validateProductionConfig()).not.toThrow();
    });

    it('should accept ANKR_API_KEY as provider fallback', async () => {
      const { validateProductionConfig } = await importWithEnv({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://prod-redis.example.com:6379',
        WALLET_PRIVATE_KEY: '0xdeadbeef',
        ...NO_RPC_ENV,
        ANKR_API_KEY: 'my-ankr-key',
      });

      expect(() => validateProductionConfig()).not.toThrow();
    });

    it('should reject localhost RPC URLs', async () => {
      const { validateProductionConfig } = await importWithEnv({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://prod-redis.example.com:6379',
        WALLET_PRIVATE_KEY: '0xdeadbeef',
        ...NO_RPC_ENV,
        ARBITRUM_RPC_URL: 'http://localhost:8545',
      });

      expect(() => validateProductionConfig()).toThrow('RPC Configuration');
    });
  });

  // ===========================================================================
  // PRODUCTION: Warnings (non-throwing)
  // ===========================================================================

  describe('production - warnings', () => {
    it('should warn about missing FLASHBOTS_AUTH_KEY (but not throw)', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const { validateProductionConfig } = await importWithEnv({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://prod-redis.example.com:6379',
        WALLET_PRIVATE_KEY: '0xdeadbeef',
        ARBITRUM_RPC_URL: 'https://arb.example.com',
        FLASHBOTS_AUTH_KEY: undefined,
      });

      expect(() => validateProductionConfig()).not.toThrow();
      expect(warnSpy).toHaveBeenCalled();
      const warnCalls = warnSpy.mock.calls.flat().join(' ');
      expect(warnCalls).toContain('FLASHBOTS_AUTH_KEY');

      warnSpy.mockRestore();
    });

    it('should not warn about FLASHBOTS when it is set', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const { validateProductionConfig } = await importWithEnv({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://prod-redis.example.com:6379',
        WALLET_PRIVATE_KEY: '0xdeadbeef',
        ARBITRUM_RPC_URL: 'https://arb.example.com',
        FLASHBOTS_AUTH_KEY: 'my-flashbots-key',
      });

      validateProductionConfig();
      const warnCalls = warnSpy.mock.calls.flat().join(' ');
      expect(warnCalls).not.toContain('FLASHBOTS_AUTH_KEY');

      warnSpy.mockRestore();
    });
  });

  // ===========================================================================
  // PRODUCTION: Solana partition validation
  // ===========================================================================

  describe('production - Solana partition', () => {
    it('should throw when PARTITION_ID=solana-native but SOLANA_RPC_URL missing', async () => {
      const { validateProductionConfig } = await importWithEnv({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://prod-redis.example.com:6379',
        WALLET_PRIVATE_KEY: '0xdeadbeef',
        ARBITRUM_RPC_URL: 'https://arb.example.com',
        PARTITION_ID: 'solana-native',
        SOLANA_RPC_URL: undefined,
      });

      expect(() => validateProductionConfig()).toThrow('SOLANA_RPC_URL');
    });

    it('should throw when SOLANA_RPC_URL is localhost for solana-native partition', async () => {
      const { validateProductionConfig } = await importWithEnv({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://prod-redis.example.com:6379',
        WALLET_PRIVATE_KEY: '0xdeadbeef',
        ARBITRUM_RPC_URL: 'https://arb.example.com',
        PARTITION_ID: 'solana-native',
        SOLANA_RPC_URL: 'http://localhost:8899',
      });

      expect(() => validateProductionConfig()).toThrow('SOLANA_RPC_URL');
    });

    it('should warn about missing Helius/Triton keys for Solana partition', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const { validateProductionConfig } = await importWithEnv({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://prod-redis.example.com:6379',
        WALLET_PRIVATE_KEY: '0xdeadbeef',
        ARBITRUM_RPC_URL: 'https://arb.example.com',
        PARTITION_ID: 'solana-native',
        SOLANA_RPC_URL: 'https://solana-mainnet.rpc.example.com',
        HELIUS_API_KEY: undefined,
        TRITON_API_KEY: undefined,
      });

      expect(() => validateProductionConfig()).not.toThrow();
      const warnCalls = warnSpy.mock.calls.flat().join(' ');
      expect(warnCalls).toContain('HELIUS_API_KEY');

      warnSpy.mockRestore();
    });

    it('should not warn when HELIUS_API_KEY is set', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const { validateProductionConfig } = await importWithEnv({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://prod-redis.example.com:6379',
        WALLET_PRIVATE_KEY: '0xdeadbeef',
        ARBITRUM_RPC_URL: 'https://arb.example.com',
        PARTITION_ID: 'solana-native',
        SOLANA_RPC_URL: 'https://solana-mainnet.rpc.example.com',
        HELIUS_API_KEY: 'my-helius-key',
      });

      validateProductionConfig();
      const warnCalls = warnSpy.mock.calls.flat().join(' ');
      expect(warnCalls).not.toContain('HELIUS_API_KEY');

      warnSpy.mockRestore();
    });

    it('should not check Solana when PARTITION_ID is not solana-native', async () => {
      const { validateProductionConfig } = await importWithEnv({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://prod-redis.example.com:6379',
        WALLET_PRIVATE_KEY: '0xdeadbeef',
        ARBITRUM_RPC_URL: 'https://arb.example.com',
        PARTITION_ID: 'asia-fast',
        SOLANA_RPC_URL: undefined,
      });

      // Should not throw about SOLANA_RPC_URL
      expect(() => validateProductionConfig()).not.toThrow();
    });
  });

  // ===========================================================================
  // PRODUCTION: Error message format
  // ===========================================================================

  describe('production - error message format', () => {
    it('should include all missing configs in a single error', async () => {
      const { validateProductionConfig } = await importWithEnv({
        NODE_ENV: 'production',
        REDIS_URL: undefined,
        WALLET_PRIVATE_KEY: undefined,
        WALLET_MNEMONIC: undefined,
        ...NO_RPC_ENV,
      });

      try {
        validateProductionConfig();
        // Should not reach here
        expect(true).toBe(false);
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain('REDIS_URL');
        expect(message).toContain('WALLET_PRIVATE_KEY');
        expect(message).toContain('RPC Configuration');
        expect(message).toContain('set NODE_ENV=development');
      }
    });
  });

  // ===========================================================================
  // PRODUCTION: Platform detection (Fly.io, Railway, etc.)
  // ===========================================================================

  describe('production - platform detection', () => {
    it('should detect Fly.io as production', async () => {
      const { validateProductionConfig } = await importWithEnv({
        NODE_ENV: undefined,
        FLY_APP_NAME: 'my-app',
        REDIS_URL: 'redis://prod-redis.example.com:6379',
        WALLET_PRIVATE_KEY: '0xdeadbeef',
        ARBITRUM_RPC_URL: 'https://arb.example.com',
      });

      // Should run validation (not skip) because FLY_APP_NAME triggers production detection
      // If all required configs are present, it should not throw
      expect(() => validateProductionConfig()).not.toThrow();
    });
  });
});
