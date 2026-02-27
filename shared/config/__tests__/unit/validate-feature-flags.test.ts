/**
 * validateFeatureFlags() Tests
 *
 * Comprehensive test coverage for validateFeatureFlags() (Finding #14).
 * Tests all 5 feature flag validation paths, once-guard, logger injection,
 * production vs dev behavior, and Redis validation.
 *
 * Uses jest.resetModules() + dynamic import to get a fresh module for each
 * test, ensuring module-level state (_featureFlagValidationRun, FEATURE_FLAGS,
 * isProduction) is re-evaluated from current process.env.
 *
 * @see .agent-reports/shared-config-deep-analysis.md Finding #14
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

// Save original env to restore after each test
const originalEnv = { ...process.env };

/**
 * Helper: dynamically import service-config with specific env vars.
 * Returns validateFeatureFlags and MULTI_PATH_QUOTER_ADDRESSES from a fresh module.
 * Always sets DISABLE_CONFIG_VALIDATION=true to prevent auto-run setTimeout.
 */
async function importWithFlags(envOverrides: Record<string, string | undefined>): Promise<{
  validateFeatureFlags: (logger?: {
    warn: (msg: string, meta?: unknown) => void;
    info: (msg: string, meta?: unknown) => void;
    error?: (msg: string, meta?: unknown) => void;
  }) => void;
  MULTI_PATH_QUOTER_ADDRESSES: Record<string, string>;
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
  // Always prevent auto-validation in tests
  process.env.DISABLE_CONFIG_VALIDATION = 'true';

  // Reset module cache so import() re-evaluates module-level code
  // (_featureFlagValidationRun, FEATURE_FLAGS, isProduction, COMMIT_REVEAL_CONTRACTS)
  jest.resetModules();

  // Dynamic import gives us fresh module with current env
  const featureFlagsMod = await import('../../src/feature-flags');
  const serviceConfigMod = await import('../../src/service-config');
  return {
    validateFeatureFlags: featureFlagsMod.validateFeatureFlags,
    MULTI_PATH_QUOTER_ADDRESSES: serviceConfigMod.MULTI_PATH_QUOTER_ADDRESSES,
  };
}

describe('validateFeatureFlags', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // ===========================================================================
  // DEFAULT STATE (no feature flags enabled explicitly)
  // ===========================================================================

  describe('default state', () => {
    it('should run without error with default env vars', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

      const { validateFeatureFlags } = await importWithFlags({});
      expect(() => validateFeatureFlags()).not.toThrow();

      warnSpy.mockRestore();
      infoSpy.mockRestore();
    });
  });

  // ===========================================================================
  // ONCE-GUARD: Only runs once per module scope
  // ===========================================================================

  describe('once-guard', () => {
    it('should only execute validation logic once per module load', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

      const { validateFeatureFlags } = await importWithFlags({});

      // First call: should run validation and produce output
      validateFeatureFlags();
      const callCountAfterFirst = warnSpy.mock.calls.length + infoSpy.mock.calls.length;

      // Verify first call actually did something (non-vacuous check)
      expect(callCountAfterFirst).toBeGreaterThan(0);

      // Second call: should be a no-op (guard prevents re-execution)
      validateFeatureFlags();
      const callCountAfterSecond = warnSpy.mock.calls.length + infoSpy.mock.calls.length;

      expect(callCountAfterSecond).toBe(callCountAfterFirst);

      warnSpy.mockRestore();
      infoSpy.mockRestore();
    });
  });

  // ===========================================================================
  // BATCHED QUOTER FLAG
  // ===========================================================================

  describe('useBatchedQuoter flag', () => {
    it('should warn when useBatchedQuoter is true but no quoter contracts deployed', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

      const { validateFeatureFlags } = await importWithFlags({
        FEATURE_BATCHED_QUOTER: 'true',
        // No MULTI_PATH_QUOTER_* entries → no deployed contracts
      });

      validateFeatureFlags();

      const warnCalls = warnSpy.mock.calls.flat().join(' ');
      expect(warnCalls).toContain('FEATURE_BATCHED_QUOTER');
      expect(warnCalls).toContain('fall back');

      warnSpy.mockRestore();
      infoSpy.mockRestore();
    });

    it('should log success when useBatchedQuoter is true and contracts are deployed', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

      const { validateFeatureFlags, MULTI_PATH_QUOTER_ADDRESSES } = await importWithFlags({
        FEATURE_BATCHED_QUOTER: 'true',
      });

      // Inject a deployed contract address (mutable Record, isolated by jest.resetModules)
      MULTI_PATH_QUOTER_ADDRESSES['ethereum'] = '0x1234567890123456789012345678901234567890';

      validateFeatureFlags();

      const infoCalls = infoSpy.mock.calls.flat().join(' ');
      expect(infoCalls).toContain('Batched quoting enabled');

      warnSpy.mockRestore();
      infoSpy.mockRestore();
    });

    it('should not validate batched quoter when flag is false', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

      const { validateFeatureFlags } = await importWithFlags({
        FEATURE_BATCHED_QUOTER: undefined, // defaults to false
      });

      validateFeatureFlags();

      const allOutput = [...warnSpy.mock.calls, ...infoSpy.mock.calls].flat().join(' ');
      expect(allOutput).not.toContain('FEATURE_BATCHED_QUOTER');
      expect(allOutput).not.toContain('Batched quoting enabled');

      warnSpy.mockRestore();
      infoSpy.mockRestore();
    });
  });

  // ===========================================================================
  // FLASH LOAN AGGREGATOR FLAG
  // ===========================================================================

  describe('useFlashLoanAggregator flag', () => {
    it('should log info when flash loan aggregator is explicitly enabled', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

      const { validateFeatureFlags } = await importWithFlags({
        FEATURE_FLASH_LOAN_AGGREGATOR: 'true',
      });

      validateFeatureFlags();

      const infoCalls = infoSpy.mock.calls.flat().join(' ');
      expect(infoCalls).toContain('Flash Loan Protocol Aggregator enabled');

      warnSpy.mockRestore();
      infoSpy.mockRestore();
    });

    it('should warn when flash loan aggregator is disabled (default)', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

      const { validateFeatureFlags } = await importWithFlags({
        // FEATURE_FLASH_LOAN_AGGREGATOR defaults to disabled (=== 'true' pattern)
      });

      validateFeatureFlags();

      const warnCalls = warnSpy.mock.calls.flat().join(' ');
      expect(warnCalls).toContain('Flash Loan Protocol Aggregator DISABLED');

      warnSpy.mockRestore();
      infoSpy.mockRestore();
    });
  });

  // ===========================================================================
  // COMMIT-REVEAL FLAG
  // ===========================================================================

  describe('useCommitReveal flag', () => {
    it('should warn when commit-reveal is enabled but no contracts deployed', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

      const { validateFeatureFlags } = await importWithFlags({
        FEATURE_COMMIT_REVEAL: 'true',
        // No COMMIT_REVEAL_CONTRACT_* env vars → no deployed contracts
      });

      validateFeatureFlags();

      const warnCalls = warnSpy.mock.calls.flat().join(' ');
      expect(warnCalls).toContain('FEATURE_COMMIT_REVEAL');
      expect(warnCalls).toContain('no CommitRevealArbitrage contracts');

      warnSpy.mockRestore();
      infoSpy.mockRestore();
    });

    it('should log success when commit-reveal contracts are deployed', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

      const { validateFeatureFlags } = await importWithFlags({
        FEATURE_COMMIT_REVEAL: 'true',
        COMMIT_REVEAL_CONTRACT_ETHEREUM: '0x1234567890123456789012345678901234567890',
      });

      validateFeatureFlags();

      const infoCalls = infoSpy.mock.calls.flat().join(' ');
      expect(infoCalls).toContain('Commit-reveal MEV protection enabled');
      expect(infoCalls).toContain('ethereum');

      warnSpy.mockRestore();
      infoSpy.mockRestore();
    });

    it('should indicate storage mode in success message', async () => {
      const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const { validateFeatureFlags } = await importWithFlags({
        FEATURE_COMMIT_REVEAL: 'true',
        COMMIT_REVEAL_CONTRACT_ETHEREUM: '0x1234567890123456789012345678901234567890',
        FEATURE_COMMIT_REVEAL_REDIS: 'true',
        REDIS_URL: 'redis://prod.example.com:6379',
      });

      validateFeatureFlags();

      const infoCalls = infoSpy.mock.calls.flat().join(' ');
      expect(infoCalls).toContain('Redis (persistent)');

      infoSpy.mockRestore();
      warnSpy.mockRestore();
    });

    // H3 FIX: commit-reveal disabled warning is now gated to execution-engine only
    it('should NOT warn when commit-reveal is disabled on non-execution services', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

      const { validateFeatureFlags } = await importWithFlags({
        // FEATURE_COMMIT_REVEAL defaults to disabled (=== 'true' pattern)
        // No SERVICE_ROLE or SERVICE_NAME set — not execution-engine
      });

      validateFeatureFlags();

      const warnCalls = warnSpy.mock.calls.flat().join(' ');
      expect(warnCalls).not.toContain('Commit-Reveal MEV Protection DISABLED');

      warnSpy.mockRestore();
      infoSpy.mockRestore();
    });

    it('should warn when commit-reveal is disabled on execution-engine', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

      const { validateFeatureFlags } = await importWithFlags({
        SERVICE_ROLE: 'execution-engine',
      });

      validateFeatureFlags();

      const warnCalls = warnSpy.mock.calls.flat().join(' ');
      expect(warnCalls).toContain('Commit-Reveal MEV Protection DISABLED');

      warnSpy.mockRestore();
      infoSpy.mockRestore();
    });

    it('should warn when commit-reveal is disabled with SERVICE_NAME=execution-engine', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

      const { validateFeatureFlags } = await importWithFlags({
        SERVICE_NAME: 'execution-engine',
      });

      validateFeatureFlags();

      const warnCalls = warnSpy.mock.calls.flat().join(' ');
      expect(warnCalls).toContain('Commit-Reveal MEV Protection DISABLED');

      warnSpy.mockRestore();
      infoSpy.mockRestore();
    });
  });

  // ===========================================================================
  // COMMIT-REVEAL REDIS VALIDATION
  // ===========================================================================

  describe('commit-reveal Redis validation', () => {
    it('should throw in production when Redis storage enabled but REDIS_URL missing', async () => {
      const { validateFeatureFlags } = await importWithFlags({
        NODE_ENV: 'production',
        FEATURE_COMMIT_REVEAL: 'true',
        FEATURE_COMMIT_REVEAL_REDIS: 'true',
        COMMIT_REVEAL_CONTRACT_ETHEREUM: '0x1234567890123456789012345678901234567890',
        REDIS_URL: undefined,
      });

      expect(() => validateFeatureFlags()).toThrow('REDIS_URL');
    });

    it('should warn (not throw) in dev when Redis storage enabled but REDIS_URL missing', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

      const { validateFeatureFlags } = await importWithFlags({
        NODE_ENV: 'development',
        FEATURE_COMMIT_REVEAL: 'true',
        FEATURE_COMMIT_REVEAL_REDIS: 'true',
        COMMIT_REVEAL_CONTRACT_ETHEREUM: '0x1234567890123456789012345678901234567890',
        REDIS_URL: undefined,
      });

      expect(() => validateFeatureFlags()).not.toThrow();

      const warnCalls = warnSpy.mock.calls.flat().join(' ');
      expect(warnCalls).toContain('REDIS_URL');
      expect(warnCalls).toContain('fall back to in-memory');

      warnSpy.mockRestore();
      infoSpy.mockRestore();
    });

    it('should not warn about Redis when REDIS_URL is set', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

      const { validateFeatureFlags } = await importWithFlags({
        FEATURE_COMMIT_REVEAL: 'true',
        FEATURE_COMMIT_REVEAL_REDIS: 'true',
        COMMIT_REVEAL_CONTRACT_ETHEREUM: '0x1234567890123456789012345678901234567890',
        REDIS_URL: 'redis://prod.example.com:6379',
      });

      validateFeatureFlags();

      const warnCalls = warnSpy.mock.calls.flat().join(' ');
      expect(warnCalls).not.toContain('REDIS_URL is not set');

      warnSpy.mockRestore();
      infoSpy.mockRestore();
    });

    it('should not check Redis when commit-reveal Redis is disabled', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

      const { validateFeatureFlags } = await importWithFlags({
        FEATURE_COMMIT_REVEAL: 'true',
        FEATURE_COMMIT_REVEAL_REDIS: undefined, // defaults to false
        COMMIT_REVEAL_CONTRACT_ETHEREUM: '0x1234567890123456789012345678901234567890',
        REDIS_URL: undefined,
      });

      // Should not throw or warn about REDIS_URL
      expect(() => validateFeatureFlags()).not.toThrow();

      const warnCalls = warnSpy.mock.calls.flat().join(' ');
      expect(warnCalls).not.toContain('REDIS_URL is not set');

      warnSpy.mockRestore();
      infoSpy.mockRestore();
    });
  });

  // ===========================================================================
  // DESTINATION CHAIN FLASH LOAN FLAG (FE-001)
  // ===========================================================================

  describe('useDestChainFlashLoan flag', () => {
    it('should warn when flag is enabled but no flash loan contracts configured', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

      const { validateFeatureFlags } = await importWithFlags({
        FEATURE_DEST_CHAIN_FLASH_LOAN: 'true',
        // No FLASH_LOAN_CONTRACT_* entries
      });

      validateFeatureFlags();

      const warnCalls = warnSpy.mock.calls.flat().join(' ');
      expect(warnCalls).toContain('FEATURE_DEST_CHAIN_FLASH_LOAN');
      expect(warnCalls).toContain('no flash loan contract addresses are configured');

      warnSpy.mockRestore();
      infoSpy.mockRestore();
    });

    it('should log success when flag is enabled and contracts are configured', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

      const { validateFeatureFlags } = await importWithFlags({
        FEATURE_DEST_CHAIN_FLASH_LOAN: 'true',
        FLASH_LOAN_CONTRACT_ETHEREUM: '0x1234567890123456789012345678901234567890',
      });

      validateFeatureFlags();

      const infoCalls = infoSpy.mock.calls.flat().join(' ');
      expect(infoCalls).toContain('Destination chain flash loans enabled');
      expect(infoCalls).toContain('ethereum');

      warnSpy.mockRestore();
      infoSpy.mockRestore();
    });

    it('should list all configured chains when multiple contracts deployed', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

      const { validateFeatureFlags } = await importWithFlags({
        FEATURE_DEST_CHAIN_FLASH_LOAN: 'true',
        FLASH_LOAN_CONTRACT_ETHEREUM: '0x1234567890123456789012345678901234567890',
        FLASH_LOAN_CONTRACT_ARBITRUM: '0x2234567890123456789012345678901234567890',
      });

      validateFeatureFlags();

      const infoCalls = infoSpy.mock.calls.flat().join(' ');
      expect(infoCalls).toContain('ethereum');
      expect(infoCalls).toContain('arbitrum');

      warnSpy.mockRestore();
      infoSpy.mockRestore();
    });

    it('should not validate dest chain flash loans when flag is false', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

      const { validateFeatureFlags } = await importWithFlags({
        FEATURE_DEST_CHAIN_FLASH_LOAN: undefined, // defaults to false
      });

      validateFeatureFlags();

      const allOutput = [...warnSpy.mock.calls, ...infoSpy.mock.calls].flat().join(' ');
      expect(allOutput).not.toContain('FEATURE_DEST_CHAIN_FLASH_LOAN');
      expect(allOutput).not.toContain('Destination chain flash loans enabled');

      warnSpy.mockRestore();
      infoSpy.mockRestore();
    });

    it('should use provided logger for dest chain flash loan validation', async () => {
      const mockLogger = {
        info: jest.fn(),
        warn: jest.fn(),
      };

      const { validateFeatureFlags } = await importWithFlags({
        FEATURE_DEST_CHAIN_FLASH_LOAN: 'true',
        FLASH_LOAN_CONTRACT_ARBITRUM: '0x1234567890123456789012345678901234567890',
      });

      validateFeatureFlags(mockLogger);

      const infoCall = mockLogger.info.mock.calls.find(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes('Destination chain flash loans enabled'),
      );
      expect(infoCall).toBeDefined();
      if (infoCall && infoCall[1]) {
        expect(infoCall[1]).toHaveProperty('chains');
        expect((infoCall[1] as { chains: string[] }).chains).toContain('arbitrum');
      }
    });

    it('should use logger.warn when flag enabled but no contracts configured', async () => {
      const mockLogger = {
        info: jest.fn(),
        warn: jest.fn(),
      };

      const { validateFeatureFlags } = await importWithFlags({
        FEATURE_DEST_CHAIN_FLASH_LOAN: 'true',
      });

      validateFeatureFlags(mockLogger);

      const warnCall = mockLogger.warn.mock.calls.find(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes('FEATURE_DEST_CHAIN_FLASH_LOAN'),
      );
      expect(warnCall).toBeDefined();
      if (warnCall && warnCall[1]) {
        expect(warnCall[1]).toHaveProperty('envVarsNeeded');
      }
    });
  });

  // ===========================================================================
  // LOGGER INJECTION
  // ===========================================================================

  describe('logger injection', () => {
    it('should use provided logger instead of console', async () => {
      const mockLogger = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      };
      const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const { validateFeatureFlags } = await importWithFlags({
        FEATURE_FLASH_LOAN_AGGREGATOR: 'true', // Explicitly enable to trigger info log
      });

      validateFeatureFlags(mockLogger);

      // Logger should have been called
      expect(mockLogger.info.mock.calls.length + mockLogger.warn.mock.calls.length).toBeGreaterThan(0);

      consoleSpy.mockRestore();
      consoleWarnSpy.mockRestore();
    });

    it('should pass metadata to logger.info for flash loan aggregator', async () => {
      const mockLogger = {
        info: jest.fn(),
        warn: jest.fn(),
      };

      const { validateFeatureFlags } = await importWithFlags({
        FEATURE_FLASH_LOAN_AGGREGATOR: 'true', // Explicitly enable
      });

      validateFeatureFlags(mockLogger);

      // Logger.info should have been called with weights metadata
      const infoCalls = mockLogger.info.mock.calls;
      const aggregatorCall = infoCalls.find(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes('Flash Loan Protocol Aggregator')
      );
      expect(aggregatorCall).toBeDefined();
      if (aggregatorCall && aggregatorCall[1]) {
        expect(aggregatorCall[1]).toHaveProperty('weights');
      }
    });

    it('should call logger.error for critical Redis error in production', async () => {
      const mockLogger = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      };

      const { validateFeatureFlags } = await importWithFlags({
        NODE_ENV: 'production',
        FEATURE_COMMIT_REVEAL: 'true',
        FEATURE_COMMIT_REVEAL_REDIS: 'true',
        COMMIT_REVEAL_CONTRACT_ETHEREUM: '0x1234567890123456789012345678901234567890',
        REDIS_URL: undefined,
      });

      expect(() => validateFeatureFlags(mockLogger)).toThrow();
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should use console fallback when no logger provided', async () => {
      const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const { validateFeatureFlags } = await importWithFlags({});

      validateFeatureFlags(); // No logger

      // Console should have been called
      expect(infoSpy.mock.calls.length + warnSpy.mock.calls.length).toBeGreaterThan(0);

      infoSpy.mockRestore();
      warnSpy.mockRestore();
    });
  });
});
