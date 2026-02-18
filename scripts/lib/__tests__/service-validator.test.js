/**
 * Unit tests for service-validator.js
 *
 * Tests ServiceConfig class and validateAllServices() function.
 * @see scripts/lib/service-validator.js
 */

const { describe, it, expect, beforeEach, afterEach } = require('@jest/globals');
const { ServiceConfig, validateAllServices } = require('../service-validator');

describe('service-validator', () => {
  describe('validateAllServices', () => {
    let consoleErrorSpy;
    let processExitSpy;

    beforeEach(() => {
      consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });
    });

    afterEach(() => {
      consoleErrorSpy.mockRestore();
      processExitSpy.mockRestore();
    });

    it('should not throw or exit for valid service configurations', () => {
      const serviceLists = {
        CORE_SERVICES: [
          {
            name: 'Test Core Service',
            type: 'redis',
            port: 6379,
            script: '',
            enabled: true
          }
        ],
        OPTIONAL_SERVICES: [
          {
            name: 'Test Optional Service',
            type: 'docker',
            port: 8080,
            script: '',
            container: 'test-container',
            optional: true,
            enabled: false
          }
        ],
        INFRASTRUCTURE_SERVICES: [
          {
            name: 'Test Infra Service',
            type: 'docker',
            port: 9090,
            script: '',
            container: 'infra-container',
            enabled: true
          }
        ]
      };

      expect(() => validateAllServices(serviceLists)).not.toThrow();
      expect(processExitSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('should call process.exit(1) when a service config is invalid', () => {
      const serviceLists = {
        CORE_SERVICES: [
          {
            // Missing 'name' field — triggers validation error
            type: 'node',
            port: 3000,
            script: 'test.js'
          }
        ],
        OPTIONAL_SERVICES: [],
        INFRASTRUCTURE_SERVICES: []
      };

      expect(() => validateAllServices(serviceLists)).toThrow('process.exit called');
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('should log error message to console.error on validation failure', () => {
      const serviceLists = {
        CORE_SERVICES: [
          {
            // Missing 'name' triggers validation error
            type: 'node',
            port: 3000,
            script: 'test.js'
          }
        ],
        OPTIONAL_SERVICES: [],
        INFRASTRUCTURE_SERVICES: []
      };

      expect(() => validateAllServices(serviceLists)).toThrow('process.exit called');

      expect(consoleErrorSpy).toHaveBeenCalled();
      const allOutput = consoleErrorSpy.mock.calls.flat().join(' ');
      expect(allOutput).toContain('SERVICE CONFIGURATION ERROR');
    });
  });
});
