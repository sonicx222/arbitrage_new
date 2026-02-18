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
    // Skip service validation during tests to avoid script existence checks
    process.env.SKIP_SERVICE_VALIDATION = 'true';
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

  describe('Helper Function Behavior', () => {
    let config;

    beforeEach(() => {
      config = require('../services-config');
    });

    describe('getServiceByName', () => {
      it('should return correct service for known name', () => {
        const service = config.getServiceByName('Coordinator');
        expect(service).toBeDefined();
        expect(service.name).toBe('Coordinator');
        expect(service.port).toBe(config.PORTS.COORDINATOR);
      });

      it('should return undefined for non-existent name', () => {
        const service = config.getServiceByName('NonExistentService');
        expect(service).toBeUndefined();
      });
    });

    describe('getServiceByPort', () => {
      it('should return correct service for coordinator port', () => {
        const service = config.getServiceByPort(config.PORTS.COORDINATOR);
        expect(service).toBeDefined();
        expect(service.name).toBe('Coordinator');
        expect(service.port).toBe(config.PORTS.COORDINATOR);
      });

      it('should return undefined for non-existent port', () => {
        const service = config.getServiceByPort(99999);
        expect(service).toBeUndefined();
      });
    });

    describe('getStartupServices', () => {
      it('should return only enabled core services by default', () => {
        const services = config.getStartupServices();
        expect(services.length).toBeGreaterThan(0);

        // All returned services should be enabled
        for (const service of services) {
          expect(service.enabled).toBe(true);
        }

        // Should not include optional services
        const optionalNames = config.OPTIONAL_SERVICES.map(s => s.name);
        for (const service of services) {
          expect(optionalNames).not.toContain(service.name);
        }
      });

      it('should include optional services when flag is true', () => {
        const services = config.getStartupServices(true);

        // Should include at least one optional service
        const optionalNames = config.OPTIONAL_SERVICES.map(s => s.name);
        const includedOptional = services.filter(s => optionalNames.includes(s.name));
        expect(includedOptional.length).toBe(config.OPTIONAL_SERVICES.length);

        // Total should be core + optional
        expect(services.length).toBe(
          config.CORE_SERVICES.length + config.OPTIONAL_SERVICES.length
        );
      });
    });
  });

  describe('Port Configuration Validation (P1 Fix)', () => {
    it('should throw error on invalid port environment variable', () => {
      // Set invalid port
      process.env.REDIS_PORT = 'not-a-number';

      // Should throw when module loads and tries to parse port
      expect(() => {
        jest.resetModules();
        require('../services-config');
      }).toThrow(/Invalid port configuration for REDIS_PORT/);
    });

    it('should throw error on out-of-range port', () => {
      process.env.COORDINATOR_PORT = '99999'; // > 65535

      expect(() => {
        jest.resetModules();
        require('../services-config');
      }).toThrow(/Invalid port 99999 for COORDINATOR_PORT/);
    });

    it('should throw error on negative port', () => {
      process.env.P1_ASIA_FAST_PORT = '-1';

      expect(() => {
        jest.resetModules();
        require('../services-config');
      }).toThrow(/Invalid port -1 for P1_ASIA_FAST_PORT/);
    });

    it('should accept valid port from environment', () => {
      process.env.EXECUTION_ENGINE_PORT = '3999';

      expect(() => {
        jest.resetModules();
        const config = require('../services-config');
        expect(config.PORTS.EXECUTION_ENGINE).toBe(3999);
      }).not.toThrow();
    });

    it('should use default port when env var not set', () => {
      delete process.env.COORDINATOR_PORT;

      jest.resetModules();
      const config = require('../services-config');

      // Should have a valid port number from config
      expect(typeof config.PORTS.COORDINATOR).toBe('number');
      expect(config.PORTS.COORDINATOR).toBeGreaterThan(0);
      expect(config.PORTS.COORDINATOR).toBeLessThanOrEqual(65535);
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

  describe('ServiceConfig Validation (Task P2-1)', () => {
    let ServiceConfig;

    beforeEach(() => {
      // Import ServiceConfig class
      const config = require('../services-config');
      ServiceConfig = config.ServiceConfig;
    });

    describe('Name validation', () => {
      it('should throw error for missing name', () => {
        expect(() => new ServiceConfig({
          type: 'node',
          port: 3000,
          script: 'test.js'
        })).toThrow('Invalid Service name: expected string, got undefined');
      });

      it('should throw error for non-string name', () => {
        expect(() => new ServiceConfig({
          name: 123,
          type: 'node',
          port: 3000,
          script: 'test.js'
        })).toThrow('Invalid Service name: expected string, got number');
      });
    });

    describe('Type validation', () => {
      it('should throw error for missing type', () => {
        expect(() => new ServiceConfig({
          name: 'Test Service',
          port: 3000,
          script: 'test.js'
        })).toThrow('Invalid Service "Test Service" type: "undefined"');
      });

      it('should throw error for invalid type', () => {
        expect(() => new ServiceConfig({
          name: 'Test Service',
          type: 'invalid',
          port: 3000,
          script: 'test.js'
        })).toThrow('Invalid Service "Test Service" type: "invalid"');
      });

      it('should accept valid node type', () => {
        expect(() => new ServiceConfig({
          name: 'Test Service',
          type: 'node',
          port: 3000,
          script: 'services/coordinator/src/index.ts' // Known to exist
        })).not.toThrow();
      });

      it('should accept valid docker type', () => {
        expect(() => new ServiceConfig({
          name: 'Test Service',
          type: 'docker',
          port: 3000,
          script: '' // Docker services don't need script
        })).not.toThrow();
      });

      it('should accept valid redis type', () => {
        expect(() => new ServiceConfig({
          name: 'Test Service',
          type: 'redis',
          port: 6379,
          script: '' // Redis services don't need script
        })).not.toThrow();
      });
    });

    describe('Port validation', () => {
      it('should throw error for missing port', () => {
        expect(() => new ServiceConfig({
          name: 'Test Service',
          type: 'node',
          script: 'test.js'
        })).toThrow('Invalid port for Service "Test Service": expected number, got undefined');
      });

      it('should throw error for non-number port', () => {
        expect(() => new ServiceConfig({
          name: 'Test Service',
          type: 'node',
          port: '3000',
          script: 'test.js'
        })).toThrow('Invalid port for Service "Test Service": expected number, got string');
      });

      it('should throw error for port below valid range', () => {
        expect(() => new ServiceConfig({
          name: 'Test Service',
          type: 'node',
          port: 0,
          script: 'test.js'
        })).toThrow('Invalid port for Service "Test Service": 0');
      });

      it('should throw error for port above valid range', () => {
        expect(() => new ServiceConfig({
          name: 'Test Service',
          type: 'node',
          port: 70000,
          script: 'test.js'
        })).toThrow('Invalid port for Service "Test Service": 70000');
      });

      it('should accept valid port in range', () => {
        expect(() => new ServiceConfig({
          name: 'Test Service',
          type: 'node',
          port: 3000,
          script: 'services/coordinator/src/index.ts'
        })).not.toThrow();
      });
    });

    describe('Script validation (node type)', () => {
      it('should throw error for missing script on node type', () => {
        expect(() => new ServiceConfig({
          name: 'Test Service',
          type: 'node',
          port: 3000
        })).toThrow('Invalid Service "Test Service" script: expected string, got undefined');
      });

      it('should throw error for non-string script', () => {
        expect(() => new ServiceConfig({
          name: 'Test Service',
          type: 'node',
          port: 3000,
          script: 123
        })).toThrow('Invalid Service "Test Service" script: expected string, got number');
      });

      it('should throw error for non-existent script file', () => {
        expect(() => new ServiceConfig({
          name: 'Test Service',
          type: 'node',
          port: 3000,
          script: 'services/nonexistent/index.ts'
        })).toThrow('Script not found');
      });

      it('should accept existing script file', () => {
        // Use a known existing script
        expect(() => new ServiceConfig({
          name: 'Test Service',
          type: 'node',
          port: 3000,
          script: 'services/coordinator/src/index.ts'
        })).not.toThrow();
      });

      it('should not require script for docker type', () => {
        expect(() => new ServiceConfig({
          name: 'Test Service',
          type: 'docker',
          port: 3000,
          script: ''
        })).not.toThrow();
      });

      it('should not require script for redis type', () => {
        expect(() => new ServiceConfig({
          name: 'Test Service',
          type: 'redis',
          port: 6379,
          script: ''
        })).not.toThrow();
      });
    });

    describe('Health endpoint validation', () => {
      it('should throw error for healthEndpoint not starting with /', () => {
        expect(() => new ServiceConfig({
          name: 'Test Service',
          type: 'node',
          port: 3000,
          script: 'services/coordinator/src/index.ts',
          healthEndpoint: 'health'
        })).toThrow('Must start with "/"');
      });

      it('should throw error for non-string healthEndpoint', () => {
        expect(() => new ServiceConfig({
          name: 'Test Service',
          type: 'node',
          port: 3000,
          script: 'services/coordinator/src/index.ts',
          healthEndpoint: 123
        })).toThrow('expected string, got number');
      });

      it('should accept valid healthEndpoint starting with /', () => {
        expect(() => new ServiceConfig({
          name: 'Test Service',
          type: 'node',
          port: 3000,
          script: 'services/coordinator/src/index.ts',
          healthEndpoint: '/health'
        })).not.toThrow();
      });

      it('should accept valid healthEndpoint with nested path', () => {
        expect(() => new ServiceConfig({
          name: 'Test Service',
          type: 'node',
          port: 3000,
          script: 'services/coordinator/src/index.ts',
          healthEndpoint: '/api/health'
        })).not.toThrow();
      });

      it('should allow undefined healthEndpoint', () => {
        expect(() => new ServiceConfig({
          name: 'Test Service',
          type: 'node',
          port: 3000,
          script: 'services/coordinator/src/index.ts'
        })).not.toThrow();
      });
    });

    describe('Complete valid configuration', () => {
      it('should accept fully valid node service configuration', () => {
        const config = new ServiceConfig({
          name: 'Test Service',
          type: 'node',
          port: 3000,
          script: 'services/coordinator/src/index.ts',
          healthEndpoint: '/health',
          delay: 1000,
          env: { TEST: 'value' },
          enabled: true
        });

        expect(config.name).toBe('Test Service');
        expect(config.type).toBe('node');
        expect(config.port).toBe(3000);
      });

      it('should accept fully valid docker service configuration', () => {
        const config = new ServiceConfig({
          name: 'Docker Service',
          type: 'docker',
          port: 8080,
          script: '',
          container: 'test-container',
          enabled: true
        });

        expect(config.name).toBe('Docker Service');
        expect(config.type).toBe('docker');
        expect(config.container).toBe('test-container');
      });

      it('should accept fully valid redis service configuration', () => {
        const config = new ServiceConfig({
          name: 'Redis Service',
          type: 'redis',
          port: 6379,
          script: '',
          enabled: true
        });

        expect(config.name).toBe('Redis Service');
        expect(config.type).toBe('redis');
        expect(config.port).toBe(6379);
      });
    });

    describe('toObject method', () => {
      it('should return plain object with original config', () => {
        const originalConfig = {
          name: 'Test Service',
          type: 'node',
          port: 3000,
          script: 'services/coordinator/src/index.ts',
          healthEndpoint: '/health'
        };

        const serviceConfig = new ServiceConfig(originalConfig);
        const obj = serviceConfig.toObject();

        expect(obj).toEqual(originalConfig);
      });
    });
  });
});
