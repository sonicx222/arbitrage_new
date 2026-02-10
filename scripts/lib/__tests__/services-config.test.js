#!/usr/bin/env node
/**
 * Tests for Service Configuration Module
 *
 * Tests for Task 4: Remove module-level side effects
 * Ensures importing services-config doesn't trigger deprecation warnings.
 *
 * @see Task 4: Remove module-level side effects from services-config.js
 */

const { describe, it, expect, beforeEach, afterEach } = require('@jest/globals');

// Store original env vars to restore after tests
const originalEnv = { ...process.env };

describe('ServicesConfig', () => {
  let consoleSpy;

  beforeEach(() => {
    // Reset modules to get fresh import
    jest.resetModules();
    // Reset env vars
    process.env = { ...originalEnv };
    // Spy on console.warn to detect deprecation warnings
    consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    // Restore original env vars
    process.env = { ...originalEnv };
    // Restore console.warn
    if (consoleSpy) {
      consoleSpy.mockRestore();
    }
  });

  describe('Module Import (Task 4)', () => {
    it('should not trigger console warnings on import', () => {
      // Import the module
      require('../services-config');

      // Verify no console.warn was called during import
      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it('should not trigger warnings even with deprecated env vars set', () => {
      // Set a deprecated env var
      process.env.USE_PUBSUB = 'true';

      // Import the module
      require('../services-config');

      // Should not trigger warnings (they should only happen when checkAndPrintDeprecations is called)
      expect(consoleSpy).not.toHaveBeenCalled();
    });
  });

  describe('checkAndPrintDeprecations function', () => {
    it('should be exported', () => {
      const config = require('../services-config');
      expect(config.checkAndPrintDeprecations).toBeDefined();
      expect(typeof config.checkAndPrintDeprecations).toBe('function');
    });

    it('should return false when no deprecated env vars are set', () => {
      const config = require('../services-config');

      // Ensure no deprecated vars are set
      delete process.env.USE_PUBSUB;
      delete process.env.USE_REDIS_STREAMS;
      delete process.env.PUBSUB_ENABLED;
      delete process.env.ENABLE_PUBSUB;

      const hasDeprecations = config.checkAndPrintDeprecations();

      expect(hasDeprecations).toBe(false);
      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it('should return true and print warnings when deprecated env vars are set', () => {
      const config = require('../services-config');

      // Set a deprecated env var
      process.env.USE_PUBSUB = 'true';

      const hasDeprecations = config.checkAndPrintDeprecations();

      expect(hasDeprecations).toBe(true);
      expect(consoleSpy).toHaveBeenCalled();
      const output = consoleSpy.mock.calls.flat().join(' ');
      expect(output).toContain('USE_PUBSUB');
    });

    it('should detect multiple deprecated env vars', () => {
      const config = require('../services-config');

      // Set multiple deprecated env vars
      process.env.USE_PUBSUB = 'true';
      process.env.USE_REDIS_STREAMS = 'true';

      const hasDeprecations = config.checkAndPrintDeprecations();

      expect(hasDeprecations).toBe(true);
      expect(consoleSpy).toHaveBeenCalled();
      const output = consoleSpy.mock.calls.flat().join(' ');
      expect(output).toContain('USE_PUBSUB');
      expect(output).toContain('USE_REDIS_STREAMS');
    });
  });

  describe('Module Exports', () => {
    it('should export all required constants', () => {
      const config = require('../services-config');

      expect(config.ROOT_DIR).toBeDefined();
      expect(config.PORTS).toBeDefined();
      expect(config.CORE_SERVICES).toBeDefined();
      expect(config.OPTIONAL_SERVICES).toBeDefined();
      expect(config.INFRASTRUCTURE_SERVICES).toBeDefined();
      expect(config.ALL_SERVICES).toBeDefined();
      expect(config.LOCAL_DEV_SERVICES).toBeDefined();
      expect(config.ALL_PORTS).toBeDefined();
    });

    it('should export all required helper functions', () => {
      const config = require('../services-config');

      expect(typeof config.getServiceByName).toBe('function');
      expect(typeof config.getServiceByPort).toBe('function');
      expect(typeof config.getStatusServices).toBe('function');
      expect(typeof config.getStartupServices).toBe('function');
      expect(typeof config.getCleanupPorts).toBe('function');
      expect(typeof config.checkAndPrintDeprecations).toBe('function');
    });
  });

  describe('Service Configuration', () => {
    it('should load services from constants file', () => {
      const config = require('../services-config');

      expect(config.CORE_SERVICES.length).toBeGreaterThan(0);
      expect(config.PORTS.COORDINATOR).toBeDefined();
      expect(config.PORTS.P1_ASIA_FAST).toBeDefined();
    });

    it('should support environment variable overrides', () => {
      // Set custom port
      process.env.COORDINATOR_PORT = '9999';

      const config = require('../services-config');

      expect(config.PORTS.COORDINATOR).toBe(9999);
    });
  });
});
