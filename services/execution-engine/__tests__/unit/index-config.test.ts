/**
 * Index Entry Point Configuration Parsing Tests
 *
 * Unit tests for the pure config parsing functions exported from index.ts.
 * These functions parse environment variables into typed configuration objects.
 *
 * Tests are isolated from the main() startup flow -- no Redis, no server, no engine.
 *
 * @see index.ts - getSimulationConfigFromEnv, getCircuitBreakerConfigFromEnv, getStandbyConfigFromEnv
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Mock @arbitrage/core before importing index.ts functions
jest.mock('@arbitrage/core', () => {
  const actual = jest.requireActual('@arbitrage/core') as Record<string, unknown>;
  return {
    ...actual,
    createLogger: () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    }),
    getCrossRegionHealthManager: jest.fn(),
    resetCrossRegionHealthManager: jest.fn(),
    setupServiceShutdown: jest.fn(),
    closeHealthServer: jest.fn(),
    runServiceMain: jest.fn(),
  };
});

jest.mock('@arbitrage/core/utils', () => {
  const actual = jest.requireActual('@arbitrage/core/utils') as Record<string, unknown>;
  return {
    ...actual,
    getCrossRegionEnvConfig: jest.fn(),
    parseEnvInt: jest.fn(),
  };
});

// Must import after mocks
import {
  getSimulationConfigFromEnv,
  getCircuitBreakerConfigFromEnv,
  getStandbyConfigFromEnv,
} from '../../src/index';
import { getCrossRegionEnvConfig, parseEnvInt } from '@arbitrage/core/utils';

describe('Index Config Parsing', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset env to clean state before each test
    // Only clear the specific env vars we test, to avoid breaking mock setup
    delete process.env.EXECUTION_SIMULATION_MODE;
    delete process.env.EXECUTION_SIMULATION_SUCCESS_RATE;
    delete process.env.EXECUTION_SIMULATION_LATENCY_MS;
    delete process.env.EXECUTION_SIMULATION_GAS_USED;
    delete process.env.EXECUTION_SIMULATION_GAS_COST_MULTIPLIER;
    delete process.env.EXECUTION_SIMULATION_PROFIT_VARIANCE;
    delete process.env.EXECUTION_SIMULATION_LOG;
    delete process.env.CIRCUIT_BREAKER_ENABLED;
    delete process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD;
    delete process.env.CIRCUIT_BREAKER_COOLDOWN_MS;
    delete process.env.CIRCUIT_BREAKER_HALF_OPEN_ATTEMPTS;
    delete process.env.IS_STANDBY;
    delete process.env.QUEUE_PAUSED_ON_START;
    delete process.env.REGION_ID;

    // Restore mock implementation after jest.resetAllMocks() in global afterEach (setupTests.ts)
    (getCrossRegionEnvConfig as jest.Mock).mockImplementation(
      (serviceName: any) => ({
        regionId: process.env.REGION_ID || 'us-east1',
        serviceName,
        healthCheckIntervalMs: 30000,
        failoverThreshold: 3,
        failoverTimeoutMs: 60000,
        leaderHeartbeatIntervalMs: 10000,
        leaderLockTtlMs: 30000,
      })
    );

    (parseEnvInt as jest.Mock).mockImplementation((envVar: any, defaultVal: any) => {
      const raw = process.env[envVar as string];
      if (raw === undefined) return defaultVal;
      const parsed = parseInt(raw, 10);
      return Number.isNaN(parsed) ? defaultVal : parsed;
    });
  });

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv };
  });

  // ===========================================================================
  // getSimulationConfigFromEnv
  // ===========================================================================
  describe('getSimulationConfigFromEnv', () => {
    it('should return undefined when simulation mode is not enabled', () => {
      const config = getSimulationConfigFromEnv();
      expect(config).toBeUndefined();
    });

    it('should return undefined when EXECUTION_SIMULATION_MODE is "false"', () => {
      process.env.EXECUTION_SIMULATION_MODE = 'false';
      const config = getSimulationConfigFromEnv();
      expect(config).toBeUndefined();
    });

    it('should return enabled config with defaults when EXECUTION_SIMULATION_MODE is "true"', () => {
      process.env.EXECUTION_SIMULATION_MODE = 'true';
      const config = getSimulationConfigFromEnv();

      expect(config).toBeDefined();
      expect(config!.enabled).toBe(true);
      expect(config!.successRate).toBe(0.85);
      expect(config!.executionLatencyMs).toBe(500);
      expect(config!.gasUsed).toBe(200000);
      expect(config!.gasCostMultiplier).toBe(0.1);
      expect(config!.profitVariance).toBe(0.2);
      expect(config!.logSimulatedExecutions).toBe(true);
    });

    it('should parse custom simulation env values', () => {
      process.env.EXECUTION_SIMULATION_MODE = 'true';
      process.env.EXECUTION_SIMULATION_SUCCESS_RATE = '0.5';
      process.env.EXECUTION_SIMULATION_LATENCY_MS = '100';
      process.env.EXECUTION_SIMULATION_GAS_USED = '150000';
      process.env.EXECUTION_SIMULATION_GAS_COST_MULTIPLIER = '0.05';
      process.env.EXECUTION_SIMULATION_PROFIT_VARIANCE = '0.1';
      process.env.EXECUTION_SIMULATION_LOG = 'false';

      const config = getSimulationConfigFromEnv();

      expect(config).toBeDefined();
      expect(config!.successRate).toBe(0.5);
      expect(config!.executionLatencyMs).toBe(100);
      expect(config!.gasUsed).toBe(150000);
      expect(config!.gasCostMultiplier).toBe(0.05);
      expect(config!.profitVariance).toBe(0.1);
      expect(config!.logSimulatedExecutions).toBe(false);
    });

    it('should set logSimulatedExecutions to true when env is not "false"', () => {
      process.env.EXECUTION_SIMULATION_MODE = 'true';
      process.env.EXECUTION_SIMULATION_LOG = 'true';

      const config = getSimulationConfigFromEnv();
      expect(config!.logSimulatedExecutions).toBe(true);
    });
  });

  // ===========================================================================
  // getCircuitBreakerConfigFromEnv
  // ===========================================================================
  describe('getCircuitBreakerConfigFromEnv', () => {
    it('should return defaults when no env vars are set', () => {
      const config = getCircuitBreakerConfigFromEnv();

      expect(config.enabled).toBe(true);
      expect(config.failureThreshold).toBe(5);
      expect(config.cooldownPeriodMs).toBe(300000);
      expect(config.halfOpenMaxAttempts).toBe(1);
    });

    it('should disable circuit breaker when CIRCUIT_BREAKER_ENABLED is "false"', () => {
      process.env.CIRCUIT_BREAKER_ENABLED = 'false';

      const config = getCircuitBreakerConfigFromEnv();
      expect(config.enabled).toBe(false);
    });

    it('should parse custom circuit breaker values', () => {
      process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD = '10';
      process.env.CIRCUIT_BREAKER_COOLDOWN_MS = '600000';
      process.env.CIRCUIT_BREAKER_HALF_OPEN_ATTEMPTS = '3';

      const config = getCircuitBreakerConfigFromEnv();

      expect(config.failureThreshold).toBe(10);
      expect(config.cooldownPeriodMs).toBe(600000);
      expect(config.halfOpenMaxAttempts).toBe(3);
    });

    it('should keep circuit breaker enabled when env var is not "false"', () => {
      process.env.CIRCUIT_BREAKER_ENABLED = 'true';
      expect(getCircuitBreakerConfigFromEnv().enabled).toBe(true);

      process.env.CIRCUIT_BREAKER_ENABLED = 'yes';
      expect(getCircuitBreakerConfigFromEnv().enabled).toBe(true);

      // Only exact "false" disables
      delete process.env.CIRCUIT_BREAKER_ENABLED;
      expect(getCircuitBreakerConfigFromEnv().enabled).toBe(true);
    });
  });

  // ===========================================================================
  // getStandbyConfigFromEnv
  // ===========================================================================
  describe('getStandbyConfigFromEnv', () => {
    it('should return default non-standby config', () => {
      const config = getStandbyConfigFromEnv();

      expect(config.isStandby).toBe(false);
      expect(config.queuePausedOnStart).toBe(false);
      expect(config.regionId).toBeDefined();
      expect(config.serviceName).toBe('execution-engine');
    });

    it('should enable standby mode when IS_STANDBY is "true"', () => {
      process.env.IS_STANDBY = 'true';

      const config = getStandbyConfigFromEnv();
      expect(config.isStandby).toBe(true);
    });

    it('should pause queue when QUEUE_PAUSED_ON_START is "true"', () => {
      process.env.QUEUE_PAUSED_ON_START = 'true';

      const config = getStandbyConfigFromEnv();
      expect(config.queuePausedOnStart).toBe(true);
    });

    it('should not enable standby for non-"true" values', () => {
      process.env.IS_STANDBY = 'false';
      expect(getStandbyConfigFromEnv().isStandby).toBe(false);

      process.env.IS_STANDBY = 'yes';
      expect(getStandbyConfigFromEnv().isStandby).toBe(false);

      process.env.IS_STANDBY = '1';
      expect(getStandbyConfigFromEnv().isStandby).toBe(false);
    });

    it('should include cross-region health settings', () => {
      const config = getStandbyConfigFromEnv();

      expect(config.healthCheckIntervalMs).toBeGreaterThan(0);
      expect(config.failoverThreshold).toBeGreaterThan(0);
      expect(config.failoverTimeoutMs).toBeGreaterThan(0);
      expect(config.leaderHeartbeatIntervalMs).toBeGreaterThan(0);
      expect(config.leaderLockTtlMs).toBeGreaterThan(0);
    });
  });
});
