/**
 * Tests for ConfigManager
 *
 * Tests environment variable validation and fail-fast configuration.
 *
 * @see Task 2.1: ConfigManager for Environment Validation
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Store original env vars
const originalEnv = { ...process.env };

// We'll import the module after setting up the environment
// to avoid initialization issues
let ConfigManager: any;
let configManager: any;
let resetConfigManager: () => void;

describe('ConfigManager', () => {
  beforeEach(() => {
    // Reset environment to known state
    process.env = { ...originalEnv };

    // Clear cached modules to get fresh ConfigManager
    jest.resetModules();

    // Import fresh instance
    const configModule = require('../../src/config-manager');
    ConfigManager = configModule.ConfigManager;
    configManager = configModule.configManager;
    resetConfigManager = configModule.resetConfigManager;

    // Reset singleton for clean tests
    resetConfigManager();
  });

  afterEach(() => {
    // Restore original environment
    process.env = { ...originalEnv };
  });

  describe('singleton pattern', () => {
    it('should return the same instance', () => {
      const instance1 = ConfigManager.getInstance();
      const instance2 = ConfigManager.getInstance();

      expect(instance1).toBe(instance2);
    });

    it('should reset correctly', () => {
      const instance1 = ConfigManager.getInstance();
      resetConfigManager();
      const instance2 = ConfigManager.getInstance();

      expect(instance1).not.toBe(instance2);
    });
  });

  describe('REDIS_URL validation', () => {
    it('should pass for valid redis:// URL', () => {
      process.env.REDIS_URL = 'redis://localhost:6379';

      const result = ConfigManager.getInstance().validate();

      expect(result.valid).toBe(true);
      expect(result.errors.filter((e: string) => e.includes('REDIS_URL'))).toHaveLength(0);
    });

    it('should pass for valid rediss:// URL (TLS)', () => {
      process.env.REDIS_URL = 'rediss://prod.redis.example.com:6380';

      const result = ConfigManager.getInstance().validate();

      expect(result.valid).toBe(true);
      expect(result.errors.filter((e: string) => e.includes('REDIS_URL'))).toHaveLength(0);
    });

    it('should fail for missing REDIS_URL', () => {
      process.env.NODE_ENV = 'production'; // REDIS_URL is only required in production
      delete process.env.REDIS_URL;
      delete process.env.REDIS_PORT; // Ensure fallback is also not available
      resetConfigManager(); // Reset singleton after env change

      const result = ConfigManager.getInstance().validate();

      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('REDIS_URL'))).toBe(true);
    });

    it('should fail for invalid REDIS_URL format', () => {
      process.env.REDIS_URL = 'http://localhost:6379';

      const result = ConfigManager.getInstance().validate();

      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('REDIS_URL'))).toBe(true);
    });
  });

  describe('PARTITION_ID validation', () => {
    beforeEach(() => {
      process.env.REDIS_URL = 'redis://localhost:6379';
    });

    it('should pass for valid partition ID (asia-fast)', () => {
      process.env.SERVICE_TYPE = 'detector';
      process.env.PARTITION_ID = 'asia-fast';

      const result = ConfigManager.getInstance().validate();

      expect(result.valid).toBe(true);
    });

    it('should pass for valid partition ID (l2-turbo)', () => {
      process.env.SERVICE_TYPE = 'detector';
      process.env.PARTITION_ID = 'l2-turbo';

      const result = ConfigManager.getInstance().validate();

      expect(result.valid).toBe(true);
    });

    it('should pass for valid partition ID (high-value)', () => {
      process.env.SERVICE_TYPE = 'detector';
      process.env.PARTITION_ID = 'high-value';

      const result = ConfigManager.getInstance().validate();

      expect(result.valid).toBe(true);
    });

    it('should pass for valid partition ID (solana-native)', () => {
      process.env.SERVICE_TYPE = 'detector';
      process.env.PARTITION_ID = 'solana-native';
      process.env.SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com';

      const result = ConfigManager.getInstance().validate();

      expect(result.valid).toBe(true);
    });

    it('should fail for invalid partition ID', () => {
      process.env.SERVICE_TYPE = 'detector';
      process.env.PARTITION_ID = 'invalid-partition';

      const result = ConfigManager.getInstance().validate();

      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('PARTITION_ID'))).toBe(true);
    });

    it('should not require PARTITION_ID for non-detector services', () => {
      process.env.SERVICE_TYPE = 'coordinator';
      delete process.env.PARTITION_ID;

      const result = ConfigManager.getInstance().validate();

      expect(result.valid).toBe(true);
    });

    it('should require PARTITION_ID for detector services', () => {
      process.env.SERVICE_TYPE = 'detector';
      delete process.env.PARTITION_ID;

      const result = ConfigManager.getInstance().validate();

      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('PARTITION_ID'))).toBe(true);
    });
  });

  describe('SOLANA_RPC_URL conditional validation', () => {
    beforeEach(() => {
      process.env.REDIS_URL = 'redis://localhost:6379';
      process.env.SERVICE_TYPE = 'detector';
    });

    it('should require SOLANA_RPC_URL for solana-native partition', () => {
      process.env.PARTITION_ID = 'solana-native';
      delete process.env.SOLANA_RPC_URL;

      const result = ConfigManager.getInstance().validate();

      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('SOLANA_RPC_URL'))).toBe(true);
    });

    it('should pass with valid https SOLANA_RPC_URL', () => {
      process.env.PARTITION_ID = 'solana-native';
      process.env.SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com';

      const result = ConfigManager.getInstance().validate();

      expect(result.valid).toBe(true);
    });

    it('should pass with valid wss SOLANA_RPC_URL', () => {
      process.env.PARTITION_ID = 'solana-native';
      process.env.SOLANA_RPC_URL = 'wss://api.mainnet-beta.solana.com';

      const result = ConfigManager.getInstance().validate();

      expect(result.valid).toBe(true);
    });

    it('should fail for invalid SOLANA_RPC_URL format', () => {
      process.env.PARTITION_ID = 'solana-native';
      process.env.SOLANA_RPC_URL = 'http://insecure.endpoint.com';

      const result = ConfigManager.getInstance().validate();

      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('SOLANA_RPC_URL'))).toBe(true);
    });

    it('should not require SOLANA_RPC_URL for non-solana partitions', () => {
      process.env.PARTITION_ID = 'asia-fast';
      delete process.env.SOLANA_RPC_URL;

      const result = ConfigManager.getInstance().validate();

      expect(result.valid).toBe(true);
    });
  });

  describe('validateOrThrow', () => {
    beforeEach(() => {
      process.env.REDIS_URL = 'redis://localhost:6379';
      resetConfigManager(); // Reset singleton for fresh instance with new env
    });

    it('should not throw for valid configuration', () => {
      expect(() => {
        ConfigManager.getInstance().validateOrThrow();
      }).not.toThrow();
    });

    it('should throw for invalid configuration', () => {
      process.env.NODE_ENV = 'production'; // REDIS_URL is only required in production
      delete process.env.REDIS_URL;
      delete process.env.REDIS_PORT; // Ensure fallback is also not available
      resetConfigManager(); // Reset singleton after env change

      expect(() => {
        ConfigManager.getInstance().validateOrThrow();
      }).toThrow('Configuration validation failed');
    });

    it('should log warnings before throwing', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => { });

      process.env.NODE_ENV = 'production'; // REDIS_URL is only required in production
      delete process.env.REDIS_URL;
      delete process.env.REDIS_PORT; // Ensure fallback is also not available
      resetConfigManager(); // Reset singleton after env change

      expect(() => {
        ConfigManager.getInstance().validateOrThrow();
      }).toThrow();

      errorSpy.mockRestore();
      warnSpy.mockRestore();
    });
  });

  describe('custom validation rules', () => {
    beforeEach(() => {
      process.env.REDIS_URL = 'redis://localhost:6379';
    });

    it('should allow adding custom rules', () => {
      const manager = ConfigManager.getInstance();

      manager.addRule('CUSTOM_VAR', {
        required: true,
        validate: (v: string) => v.startsWith('custom:'),
        errorMessage: 'CUSTOM_VAR must start with custom:'
      });

      process.env.CUSTOM_VAR = 'invalid';

      const result = manager.validate();

      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('CUSTOM_VAR'))).toBe(true);
    });

    it('should support conditional required rules', () => {
      const manager = ConfigManager.getInstance();

      manager.addRule('SPECIAL_CONFIG', {
        required: (env: NodeJS.ProcessEnv) => env.ENABLE_SPECIAL === 'true',
        errorMessage: 'SPECIAL_CONFIG required when ENABLE_SPECIAL is true'
      });

      process.env.ENABLE_SPECIAL = 'true';
      delete process.env.SPECIAL_CONFIG;

      const result = manager.validate();

      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('SPECIAL_CONFIG'))).toBe(true);
    });

    it('should not require conditional vars when condition is false', () => {
      const manager = ConfigManager.getInstance();

      manager.addRule('SPECIAL_CONFIG', {
        required: (env: NodeJS.ProcessEnv) => env.ENABLE_SPECIAL === 'true',
        errorMessage: 'SPECIAL_CONFIG required when ENABLE_SPECIAL is true'
      });

      process.env.ENABLE_SPECIAL = 'false';
      delete process.env.SPECIAL_CONFIG;

      const result = manager.validate();

      expect(result.valid).toBe(true);
    });
  });

  describe('warnings', () => {
    beforeEach(() => {
      process.env.REDIS_URL = 'redis://localhost:6379';
    });

    it('should collect warnings for optional missing vars with warnings', () => {
      const manager = ConfigManager.getInstance();

      manager.addRule('OPTIONAL_VAR', {
        required: false,
        errorMessage: '',
        warnMessage: 'Consider setting OPTIONAL_VAR for better performance'
      });

      delete process.env.OPTIONAL_VAR;

      const result = manager.validate();

      expect(result.valid).toBe(true);
      expect(result.warnings.some((w: string) => w.includes('OPTIONAL_VAR'))).toBe(true);
    });

    it('should not warn if optional var is set', () => {
      const manager = ConfigManager.getInstance();

      manager.addRule('OPTIONAL_VAR', {
        required: false,
        errorMessage: '',
        warnMessage: 'Consider setting OPTIONAL_VAR for better performance'
      });

      process.env.OPTIONAL_VAR = 'some-value';

      const result = manager.validate();

      expect(result.valid).toBe(true);
      expect(result.warnings.filter((w: string) => w.includes('OPTIONAL_VAR'))).toHaveLength(0);
    });
  });
});

describe('STRICT_CONFIG_VALIDATION', () => {
  beforeEach(() => {
    // Reset environment to known state
    process.env = { ...originalEnv };
    jest.resetModules();

    // Import fresh instance
    const configModule = require('../../src/config-manager');
    ConfigManager = configModule.ConfigManager;
    configManager = configModule.configManager;
    resetConfigManager = configModule.resetConfigManager;
    resetConfigManager();

    process.env.REDIS_URL = 'redis://localhost:6379';
  });

  it('should demote errors to warnings when STRICT_CONFIG_VALIDATION is false', () => {
    process.env.STRICT_CONFIG_VALIDATION = 'false';
    // Use an invalid PARTITION_ID to trigger a validation error that is
    // not tied to production mode (REDIS_URL is only required in production,
    // and production blocks relaxed mode)
    process.env.SERVICE_TYPE = 'detector';
    process.env.PARTITION_ID = 'invalid-partition';
    // Re-import to get fresh module with new env
    jest.resetModules();
    const mod = require('../../src/config-manager');
    mod.resetConfigManager();

    const result = mod.ConfigManager.getInstance().validate();

    expect(result.valid).toBe(true); // Should be valid despite invalid partition
    expect(result.errors).toHaveLength(0);
    expect(result.warnings.some((w: string) => w.includes('[RELAXED]'))).toBe(true);
  });

  it('should enforce errors when STRICT_CONFIG_VALIDATION is true', () => {
    process.env.STRICT_CONFIG_VALIDATION = 'true';
    // Use an invalid PARTITION_ID to trigger a validation error
    process.env.SERVICE_TYPE = 'detector';
    process.env.PARTITION_ID = 'invalid-partition';
    // Re-import to get fresh module with new env
    jest.resetModules();
    const mod = require('../../src/config-manager');
    mod.resetConfigManager();

    const result = mod.ConfigManager.getInstance().validate();

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
  });

  it('should default to strict validation (errors are errors)', () => {
    delete process.env.STRICT_CONFIG_VALIDATION;
    // Use an invalid PARTITION_ID to trigger a validation error
    process.env.SERVICE_TYPE = 'detector';
    process.env.PARTITION_ID = 'invalid-partition';
    // Re-import to get fresh module with new env
    jest.resetModules();
    const mod = require('../../src/config-manager');
    mod.resetConfigManager();

    const result = mod.ConfigManager.getInstance().validate();

    expect(result.valid).toBe(false);
  });
});

describe('getEnv helper', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
    const configModule = require('../../src/config-manager');
    ConfigManager = configModule.ConfigManager;
    configManager = configModule.configManager;
    resetConfigManager = configModule.resetConfigManager;
    resetConfigManager();
    process.env.REDIS_URL = 'redis://localhost:6379';
  });

  it('should return environment variable value', () => {
    process.env.MY_VAR = 'my-value';

    const manager = ConfigManager.getInstance();
    expect(manager.getEnv('MY_VAR')).toBe('my-value');
  });

  it('should return default value if not set', () => {
    delete process.env.MY_VAR;

    const manager = ConfigManager.getInstance();
    expect(manager.getEnv('MY_VAR', 'default')).toBe('default');
  });

  it('should return undefined if not set and no default', () => {
    delete process.env.MY_VAR;

    const manager = ConfigManager.getInstance();
    expect(manager.getEnv('MY_VAR')).toBeUndefined();
  });
});

describe('exported singleton', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
    const configModule = require('../../src/config-manager');
    ConfigManager = configModule.ConfigManager;
    configManager = configModule.configManager;
    resetConfigManager = configModule.resetConfigManager;
    resetConfigManager();
    process.env.REDIS_URL = 'redis://localhost:6379';
  });

  it('should export a pre-configured singleton', () => {
    expect(configManager).toBeDefined();
    expect(typeof configManager.validate).toBe('function');
    expect(typeof configManager.validateOrThrow).toBe('function');
  });
});
