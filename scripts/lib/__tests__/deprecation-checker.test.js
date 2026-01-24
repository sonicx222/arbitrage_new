#!/usr/bin/env node
/**
 * Tests for Deprecation Checker
 *
 * @see Task 1.1: Deprecation Warning System
 * @see ADR-003: Partitioned Chain Detectors (deprecated service names)
 * @see ADR-002: Redis Streams (deprecated env vars)
 */

const { describe, it, expect, beforeEach, afterEach } = require('@jest/globals');

// We'll import the module under test after it's created
let deprecationChecker;

// Store original env vars to restore after tests
const originalEnv = { ...process.env };

describe('DeprecationChecker', () => {
  beforeEach(() => {
    // Reset modules to get fresh import
    jest.resetModules();
    // Reset env vars
    process.env = { ...originalEnv };
    // Import fresh copy
    deprecationChecker = require('../deprecation-checker');
  });

  afterEach(() => {
    // Restore original env vars
    process.env = { ...originalEnv };
  });

  describe('DEPRECATED_PATTERNS', () => {
    it('should define deprecated services', () => {
      const { DEPRECATED_PATTERNS } = deprecationChecker;

      expect(DEPRECATED_PATTERNS.services).toBeDefined();
      expect(DEPRECATED_PATTERNS.services['ethereum-detector']).toBeDefined();
      expect(DEPRECATED_PATTERNS.services['ethereum-detector'].replacement).toBe('partition-high-value');
    });

    it('should define deprecated env vars', () => {
      const { DEPRECATED_PATTERNS } = deprecationChecker;

      expect(DEPRECATED_PATTERNS.envVars).toBeDefined();
      expect(DEPRECATED_PATTERNS.envVars['USE_REDIS_STREAMS']).toBeDefined();
      expect(DEPRECATED_PATTERNS.envVars['USE_PUBSUB']).toBeDefined();
    });

    it('should include since dates for all deprecated items', () => {
      const { DEPRECATED_PATTERNS } = deprecationChecker;

      for (const [name, info] of Object.entries(DEPRECATED_PATTERNS.services)) {
        expect(info.since).toBeDefined();
        expect(typeof info.since).toBe('string');
        expect(info.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }

      for (const [name, info] of Object.entries(DEPRECATED_PATTERNS.envVars)) {
        expect(info.since).toBeDefined();
        expect(typeof info.since).toBe('string');
      }
    });
  });

  describe('checkForDeprecatedServices', () => {
    it('should return empty array for non-deprecated services', () => {
      const { checkForDeprecatedServices } = deprecationChecker;

      const warnings = checkForDeprecatedServices([
        'partition-high-value',
        'partition-l2-turbo',
        'partition-asia-fast',
        'coordinator'
      ]);

      expect(warnings).toEqual([]);
    });

    it('should detect deprecated ethereum-detector', () => {
      const { checkForDeprecatedServices } = deprecationChecker;

      const warnings = checkForDeprecatedServices(['ethereum-detector']);

      expect(warnings).toHaveLength(1);
      expect(warnings[0].type).toBe('deprecated_service');
      expect(warnings[0].name).toBe('ethereum-detector');
      expect(warnings[0].replacement).toBe('partition-high-value');
    });

    it('should detect multiple deprecated services', () => {
      const { checkForDeprecatedServices } = deprecationChecker;

      const warnings = checkForDeprecatedServices([
        'arbitrum-detector',
        'optimism-detector',
        'base-detector'
      ]);

      expect(warnings).toHaveLength(3);
      expect(warnings.every(w => w.type === 'deprecated_service')).toBe(true);
      expect(warnings.every(w => w.replacement === 'partition-l2-turbo')).toBe(true);
    });

    it('should detect polygon-detector and bsc-detector', () => {
      const { checkForDeprecatedServices } = deprecationChecker;

      const warnings = checkForDeprecatedServices(['polygon-detector', 'bsc-detector']);

      expect(warnings).toHaveLength(2);
      expect(warnings[0].replacement).toBe('partition-asia-fast');
      expect(warnings[1].replacement).toBe('partition-asia-fast');
    });

    it('should detect avalanche-detector and fantom-detector', () => {
      const { checkForDeprecatedServices } = deprecationChecker;

      const warnings = checkForDeprecatedServices(['avalanche-detector', 'fantom-detector']);

      expect(warnings).toHaveLength(2);
      expect(warnings.every(w => w.replacement === 'partition-asia-fast')).toBe(true);
    });

    it('should detect zksync-detector and linea-detector', () => {
      const { checkForDeprecatedServices } = deprecationChecker;

      const warnings = checkForDeprecatedServices(['zksync-detector', 'linea-detector']);

      expect(warnings).toHaveLength(2);
      expect(warnings.every(w => w.replacement === 'partition-high-value')).toBe(true);
    });

    it('should handle mixed deprecated and valid services', () => {
      const { checkForDeprecatedServices } = deprecationChecker;

      const warnings = checkForDeprecatedServices([
        'partition-high-value',
        'ethereum-detector',
        'coordinator'
      ]);

      expect(warnings).toHaveLength(1);
      expect(warnings[0].name).toBe('ethereum-detector');
    });

    it('should handle empty array', () => {
      const { checkForDeprecatedServices } = deprecationChecker;

      const warnings = checkForDeprecatedServices([]);

      expect(warnings).toEqual([]);
    });
  });

  describe('checkForDeprecatedEnvVars', () => {
    it('should return empty array when no deprecated env vars are set', () => {
      const { checkForDeprecatedEnvVars } = deprecationChecker;

      // Ensure deprecated vars are not set
      delete process.env.USE_REDIS_STREAMS;
      delete process.env.USE_PUBSUB;

      const warnings = checkForDeprecatedEnvVars();

      expect(warnings).toEqual([]);
    });

    it('should detect USE_REDIS_STREAMS', () => {
      const { checkForDeprecatedEnvVars } = deprecationChecker;

      process.env.USE_REDIS_STREAMS = 'true';

      const warnings = checkForDeprecatedEnvVars();

      expect(warnings).toHaveLength(1);
      expect(warnings[0].type).toBe('deprecated_env');
      expect(warnings[0].name).toBe('USE_REDIS_STREAMS');
      expect(warnings[0].replacement).toContain('ADR-002');
    });

    it('should detect USE_PUBSUB', () => {
      const { checkForDeprecatedEnvVars } = deprecationChecker;

      process.env.USE_PUBSUB = 'true';

      const warnings = checkForDeprecatedEnvVars();

      expect(warnings).toHaveLength(1);
      expect(warnings[0].type).toBe('deprecated_env');
      expect(warnings[0].name).toBe('USE_PUBSUB');
    });

    it('should detect multiple deprecated env vars', () => {
      const { checkForDeprecatedEnvVars } = deprecationChecker;

      process.env.USE_REDIS_STREAMS = 'true';
      process.env.USE_PUBSUB = 'false';

      const warnings = checkForDeprecatedEnvVars();

      expect(warnings).toHaveLength(2);
    });

    it('should detect env vars with any value', () => {
      const { checkForDeprecatedEnvVars } = deprecationChecker;

      process.env.USE_REDIS_STREAMS = '';  // Empty string is still defined

      const warnings = checkForDeprecatedEnvVars();

      expect(warnings).toHaveLength(1);
    });

    it('should detect PUBSUB_ENABLED', () => {
      const { checkForDeprecatedEnvVars } = deprecationChecker;

      process.env.PUBSUB_ENABLED = 'true';

      const warnings = checkForDeprecatedEnvVars();

      expect(warnings).toHaveLength(1);
      expect(warnings[0].name).toBe('PUBSUB_ENABLED');
      expect(warnings[0].replacement).toContain('ADR-002');
    });

    it('should detect ENABLE_PUBSUB', () => {
      const { checkForDeprecatedEnvVars } = deprecationChecker;

      process.env.ENABLE_PUBSUB = 'true';

      const warnings = checkForDeprecatedEnvVars();

      expect(warnings).toHaveLength(1);
      expect(warnings[0].name).toBe('ENABLE_PUBSUB');
      expect(warnings[0].replacement).toContain('ADR-002');
    });

    it('should detect all four deprecated pub/sub env vars', () => {
      const { checkForDeprecatedEnvVars } = deprecationChecker;

      process.env.USE_REDIS_STREAMS = 'true';
      process.env.USE_PUBSUB = 'true';
      process.env.PUBSUB_ENABLED = 'true';
      process.env.ENABLE_PUBSUB = 'true';

      const warnings = checkForDeprecatedEnvVars();

      expect(warnings).toHaveLength(4);
    });
  });

  describe('printWarnings', () => {
    let consoleSpy;

    beforeEach(() => {
      consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleSpy.mockRestore();
    });

    it('should not print anything for empty warnings', () => {
      const { printWarnings } = deprecationChecker;

      printWarnings([]);

      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it('should print warnings with service name and replacement', () => {
      const { printWarnings } = deprecationChecker;

      printWarnings([{
        type: 'deprecated_service',
        name: 'ethereum-detector',
        replacement: 'partition-high-value',
        since: '2025-01-11'
      }]);

      expect(consoleSpy).toHaveBeenCalled();
      const output = consoleSpy.mock.calls.flat().join(' ');
      expect(output).toContain('ethereum-detector');
      expect(output).toContain('partition-high-value');
      expect(output).toContain('2025-01-11');
    });

    it('should print multiple warnings', () => {
      const { printWarnings } = deprecationChecker;

      printWarnings([
        {
          type: 'deprecated_service',
          name: 'arbitrum-detector',
          replacement: 'partition-l2-turbo',
          since: '2025-01-11'
        },
        {
          type: 'deprecated_env',
          name: 'USE_PUBSUB',
          replacement: 'Removed per ADR-002',
          since: '2025-01-10'
        }
      ]);

      expect(consoleSpy).toHaveBeenCalled();
      const output = consoleSpy.mock.calls.flat().join(' ');
      expect(output).toContain('arbitrum-detector');
      expect(output).toContain('USE_PUBSUB');
    });
  });

  describe('checkAllDeprecations', () => {
    it('should check both services and env vars', () => {
      const { checkAllDeprecations } = deprecationChecker;

      process.env.USE_PUBSUB = 'true';

      const warnings = checkAllDeprecations(['ethereum-detector']);

      expect(warnings).toHaveLength(2);
      expect(warnings.some(w => w.type === 'deprecated_service')).toBe(true);
      expect(warnings.some(w => w.type === 'deprecated_env')).toBe(true);
    });

    it('should return empty array when nothing deprecated', () => {
      const { checkAllDeprecations } = deprecationChecker;

      delete process.env.USE_PUBSUB;
      delete process.env.USE_REDIS_STREAMS;

      const warnings = checkAllDeprecations(['partition-high-value']);

      expect(warnings).toEqual([]);
    });
  });
});
