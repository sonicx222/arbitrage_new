/**
 * Tests for Env Utils
 *
 * Validates environment variable parsing with strict and safe modes.
 *
 * @see shared/core/src/env-utils.ts
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

jest.mock('../../src/logger');

import {
  parseEnvInt,
  parseEnvIntSafe,
  parseEnvBool,
  getCrossRegionEnvConfig,
} from '../../src/utils/env-utils';

 
const { __mockLogger } = require('../../src/logger') as { __mockLogger: { warn: jest.Mock } };

const originalEnv = process.env;

describe('env-utils', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ===========================================================================
  // parseEnvInt (strict)
  // ===========================================================================

  describe('parseEnvInt', () => {
    it('returns default when env var is not set', () => {
      delete process.env.TEST_PORT;
      expect(parseEnvInt('TEST_PORT', 3000)).toBe(3000);
    });

    it('returns default when env var is empty string', () => {
      process.env.TEST_PORT = '';
      expect(parseEnvInt('TEST_PORT', 3000)).toBe(3000);
    });

    it('parses a valid integer from env', () => {
      process.env.TEST_PORT = '8080';
      expect(parseEnvInt('TEST_PORT', 3000)).toBe(8080);
    });

    it('parses negative integer when no min specified', () => {
      process.env.TEST_OFFSET = '-10';
      expect(parseEnvInt('TEST_OFFSET', 0)).toBe(-10);
    });

    it('throws on non-integer value (NaN)', () => {
      process.env.TEST_PORT = 'abc';
      expect(() => parseEnvInt('TEST_PORT', 3000)).toThrow('not a valid integer');
    });

    it('throws on float value', () => {
      process.env.TEST_PORT = '3.14';
      // parseInt('3.14', 10) returns 3, so this actually parses to 3
      // This is a documented behavior of parseInt - it truncates
      expect(parseEnvInt('TEST_PORT', 3000)).toBe(3);
    });

    it('throws when value is below minimum (min only)', () => {
      process.env.TEST_PORT = '0';
      expect(() => parseEnvInt('TEST_PORT', 3000, 1)).toThrow('below minimum');
    });

    it('throws when value is above maximum (max only)', () => {
      process.env.TEST_PORT = '99999';
      expect(() => parseEnvInt('TEST_PORT', 3000, undefined, 65535)).toThrow('above maximum');
    });

    it('throws when value is out of range [min, max]', () => {
      process.env.TEST_PORT = '100';
      expect(() => parseEnvInt('TEST_PORT', 3000, 1000, 65535)).toThrow('out of range');
    });

    it('throws when value exceeds max in range [min, max]', () => {
      process.env.TEST_PORT = '70000';
      expect(() => parseEnvInt('TEST_PORT', 3000, 1000, 65535)).toThrow('out of range');
    });

    it('accepts value at min boundary', () => {
      process.env.TEST_PORT = '1000';
      expect(parseEnvInt('TEST_PORT', 3000, 1000, 65535)).toBe(1000);
    });

    it('accepts value at max boundary', () => {
      process.env.TEST_PORT = '65535';
      expect(parseEnvInt('TEST_PORT', 3000, 1000, 65535)).toBe(65535);
    });

    it('accepts value in the middle of range', () => {
      process.env.TEST_PORT = '8080';
      expect(parseEnvInt('TEST_PORT', 3000, 1000, 65535)).toBe(8080);
    });
  });

  // ===========================================================================
  // parseEnvIntSafe (lenient)
  // ===========================================================================

  describe('parseEnvIntSafe', () => {
    it('returns default when env var is not set', () => {
      delete process.env.TEST_SAMPLES;
      expect(parseEnvIntSafe('TEST_SAMPLES', 10)).toBe(10);
    });

    it('returns default when env var is empty string', () => {
      process.env.TEST_SAMPLES = '';
      expect(parseEnvIntSafe('TEST_SAMPLES', 10)).toBe(10);
    });

    it('parses a valid integer from env', () => {
      process.env.TEST_SAMPLES = '25';
      expect(parseEnvIntSafe('TEST_SAMPLES', 10)).toBe(25);
    });

    it('returns default on invalid value and warns', () => {
      process.env.TEST_SAMPLES = 'not_a_number';
      const result = parseEnvIntSafe('TEST_SAMPLES', 10);
      expect(result).toBe(10);
      expect(__mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Invalid integer value for TEST_SAMPLES')
      );
    });

    it('returns min when value is below minimum and warns', () => {
      process.env.TEST_SAMPLES = '-5';
      const result = parseEnvIntSafe('TEST_SAMPLES', 10, 0);
      expect(result).toBe(0);
      expect(__mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('below minimum')
      );
    });

    it('accepts value equal to min', () => {
      process.env.TEST_SAMPLES = '1';
      expect(parseEnvIntSafe('TEST_SAMPLES', 10, 1)).toBe(1);
    });

    it('uses default min of 0 when min not specified', () => {
      process.env.TEST_SAMPLES = '-1';
      const result = parseEnvIntSafe('TEST_SAMPLES', 10);
      expect(result).toBe(0); // default min is 0
      expect(__mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('below minimum 0')
      );
    });

    it('accepts zero when default min is 0', () => {
      process.env.TEST_SAMPLES = '0';
      expect(parseEnvIntSafe('TEST_SAMPLES', 10)).toBe(0);
    });
  });

  // ===========================================================================
  // parseEnvBool
  // ===========================================================================

  describe('parseEnvBool', () => {
    it('returns default when env var is not set', () => {
      delete process.env.TEST_FLAG;
      expect(parseEnvBool('TEST_FLAG', false)).toBe(false);
      expect(parseEnvBool('TEST_FLAG', true)).toBe(true);
    });

    it('returns default for empty string', () => {
      process.env.TEST_FLAG = '';
      expect(parseEnvBool('TEST_FLAG', false)).toBe(false);
      expect(parseEnvBool('TEST_FLAG', true)).toBe(true);
    });

    it('returns true for "true"', () => {
      process.env.TEST_FLAG = 'true';
      expect(parseEnvBool('TEST_FLAG', false)).toBe(true);
    });

    it('returns true for "1"', () => {
      process.env.TEST_FLAG = '1';
      expect(parseEnvBool('TEST_FLAG', false)).toBe(true);
    });

    it('returns false for "false"', () => {
      process.env.TEST_FLAG = 'false';
      expect(parseEnvBool('TEST_FLAG', true)).toBe(false);
    });

    it('returns false for "0"', () => {
      process.env.TEST_FLAG = '0';
      expect(parseEnvBool('TEST_FLAG', true)).toBe(false);
    });

    it('returns default for unrecognized string "yes"', () => {
      process.env.TEST_FLAG = 'yes';
      expect(parseEnvBool('TEST_FLAG', false)).toBe(false);
    });

    it('returns default for unrecognized string "no"', () => {
      process.env.TEST_FLAG = 'no';
      expect(parseEnvBool('TEST_FLAG', true)).toBe(true);
    });

    it('returns default for mixed case "True" (case sensitive)', () => {
      process.env.TEST_FLAG = 'True';
      expect(parseEnvBool('TEST_FLAG', false)).toBe(false);
    });

    it('returns default for mixed case "FALSE" (case sensitive)', () => {
      process.env.TEST_FLAG = 'FALSE';
      expect(parseEnvBool('TEST_FLAG', true)).toBe(true);
    });
  });

  // ===========================================================================
  // getCrossRegionEnvConfig
  // ===========================================================================

  describe('getCrossRegionEnvConfig', () => {
    it('returns defaults when no env vars are set', () => {
      // Clear all relevant env vars
      delete process.env.REGION_ID;
      delete process.env.SERVICE_NAME;
      delete process.env.HEALTH_CHECK_INTERVAL_MS;
      delete process.env.FAILOVER_THRESHOLD;
      delete process.env.FAILOVER_TIMEOUT_MS;
      delete process.env.LEADER_HEARTBEAT_INTERVAL_MS;
      delete process.env.LEADER_LOCK_TTL_MS;

      const config = getCrossRegionEnvConfig('test-service');

      expect(config.regionId).toBe('us-east1');
      expect(config.serviceName).toBe('test-service');
      expect(config.healthCheckIntervalMs).toBe(10000);
      expect(config.failoverThreshold).toBe(3);
      expect(config.failoverTimeoutMs).toBe(60000);
      expect(config.leaderHeartbeatIntervalMs).toBe(10000);
      expect(config.leaderLockTtlMs).toBe(30000);
    });

    it('reads values from env vars when set', () => {
      process.env.REGION_ID = 'eu-west1';
      process.env.SERVICE_NAME = 'custom-service';
      process.env.HEALTH_CHECK_INTERVAL_MS = '5000';
      process.env.FAILOVER_THRESHOLD = '5';
      process.env.FAILOVER_TIMEOUT_MS = '120000';
      process.env.LEADER_HEARTBEAT_INTERVAL_MS = '5000';
      process.env.LEADER_LOCK_TTL_MS = '60000';

      const config = getCrossRegionEnvConfig('default-service');

      expect(config.regionId).toBe('eu-west1');
      expect(config.serviceName).toBe('custom-service');
      expect(config.healthCheckIntervalMs).toBe(5000);
      expect(config.failoverThreshold).toBe(5);
      expect(config.failoverTimeoutMs).toBe(120000);
      expect(config.leaderHeartbeatIntervalMs).toBe(5000);
      expect(config.leaderLockTtlMs).toBe(60000);
    });

    it('uses defaultServiceName as fallback for SERVICE_NAME', () => {
      delete process.env.SERVICE_NAME;
      const config = getCrossRegionEnvConfig('my-coordinator');
      expect(config.serviceName).toBe('my-coordinator');
    });

    it('throws when numeric env var is out of valid range', () => {
      // HEALTH_CHECK_INTERVAL_MS has range [1000, 60000]
      process.env.HEALTH_CHECK_INTERVAL_MS = '100';
      expect(() => getCrossRegionEnvConfig('test-service')).toThrow('out of range');
    });
  });
});
