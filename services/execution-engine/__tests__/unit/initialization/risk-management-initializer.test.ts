/**
 * Risk Management Initializer Unit Tests
 *
 * Tests initializeRiskManagement — partial initialization scenarios
 * where individual components fail while others succeed.
 *
 * @see risk-management-initializer.ts
 * @see ADR-021: Capital Risk Management
 */

import { jest, describe, test, expect, beforeEach } from '@jest/globals';

// =============================================================================
// Mock Dependencies
// =============================================================================

// Track which factory functions throw (flags instead of jest.fn to avoid DataCloneError)
let probabilityTrackerShouldThrow = false;
let evCalculatorShouldThrow = false;
let positionSizerShouldThrow = false;
let drawdownBreakerShouldThrow = false;
let validateRiskConfigShouldThrow = false;

const mockProbabilityTracker = { recordOutcome: () => {}, getWinProbability: () => 0.5 };
const mockEvCalculator = { calculateEV: () => 0.01 };
const mockPositionSizer = { calculatePosition: () => 0.1 };
const mockDrawdownBreaker = { checkDrawdown: () => 'NORMAL' };

jest.mock('@arbitrage/core/risk', () => ({
  getExecutionProbabilityTracker: (..._args: unknown[]) => {
    if (probabilityTrackerShouldThrow) throw new Error('probability tracker init failed');
    return mockProbabilityTracker;
  },
  getEVCalculator: (..._args: unknown[]) => {
    if (evCalculatorShouldThrow) throw new Error('ev calculator init failed');
    return mockEvCalculator;
  },
  getKellyPositionSizer: (..._args: unknown[]) => {
    if (positionSizerShouldThrow) throw new Error('position sizer init failed');
    return mockPositionSizer;
  },
  getDrawdownCircuitBreaker: (..._args: unknown[]) => {
    if (drawdownBreakerShouldThrow) throw new Error('drawdown breaker init failed');
    return mockDrawdownBreaker;
  },
}));

jest.mock('@arbitrage/core/resilience', () => ({
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

jest.mock('@arbitrage/config', () => ({
  RISK_CONFIG: {
    enabled: true,
    probability: {
      minSamples: 10,
      defaultWinProbability: 0.5,
      maxOutcomesPerKey: 100,
      cleanupIntervalMs: 60000,
      outcomeRelevanceWindowMs: 3600000,
      persistToRedis: false,
      redisKeyPrefix: 'risk:prob:',
    },
    ev: {
      minEVThreshold: 0.01,
      minWinProbability: 0.4,
      maxLossPerTrade: 0.05,
      useHistoricalGasCost: false,
      defaultGasCost: 0.001,
      defaultProfitEstimate: 0.01,
      chainMinEVThresholds: {},
    },
    positionSizing: {
      kellyMultiplier: 0.25,
      maxSingleTradeFraction: 0.1,
      minTradeFraction: 0.001,
      enabled: true,
      useGasBudgetMode: false,
      maxGasPerTrade: 0.01,
      dailyGasBudget: 0.1,
    },
    drawdown: {
      maxDailyLoss: 0.05,
      cautionThreshold: 0.03,
      maxConsecutiveLosses: 5,
      recoveryMultiplier: 0.5,
      recoveryWinsRequired: 3,
      haltCooldownMs: 300000,
      enabled: true,
      cautionMultiplier: 0.5,
      useRollingWindow: false,
    },
    totalCapital: 1.0,
  },
  validateRiskConfig: () => {
    if (validateRiskConfigShouldThrow) throw new Error('invalid risk config');
  },
}));

// =============================================================================
// Import after mocks
// =============================================================================

import { initializeRiskManagement } from '../../../src/initialization/risk-management-initializer';
import type { InitializationLogger } from '../../../src/initialization/types';

// =============================================================================
// Test Helpers
// =============================================================================

function createMockLogger(): InitializationLogger {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as InitializationLogger;
}

// =============================================================================
// Tests
// =============================================================================

describe('initializeRiskManagement', () => {
  let logger: InitializationLogger;

  beforeEach(() => {
    logger = createMockLogger();
    probabilityTrackerShouldThrow = false;
    evCalculatorShouldThrow = false;
    positionSizerShouldThrow = false;
    drawdownBreakerShouldThrow = false;
    validateRiskConfigShouldThrow = false;
  });

  test('should initialize all 4 components successfully', () => {
    const result = initializeRiskManagement(logger, { skipValidation: true });

    expect(result.enabled).toBe(true);
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.probabilityTracker).toBe(mockProbabilityTracker);
    expect(result.evCalculator).toBe(mockEvCalculator);
    expect(result.positionSizer).toBe(mockPositionSizer);
    expect(result.drawdownBreaker).toBe(mockDrawdownBreaker);
    expect(result.componentStatus).toEqual({
      probabilityTracker: true,
      evCalculator: true,
      positionSizer: true,
      drawdownBreaker: true,
    });
  });

  test('should return disabled result when RISK_CONFIG.enabled is false', () => {
    const { RISK_CONFIG } = jest.requireMock('@arbitrage/config') as { RISK_CONFIG: { enabled: boolean } };
    RISK_CONFIG.enabled = false;

    const result = initializeRiskManagement(logger);

    expect(result.enabled).toBe(false);
    expect(result.success).toBe(true); // Disabled is not a failure
    expect(result.probabilityTracker).toBeNull();
    expect(result.evCalculator).toBeNull();
    expect(result.positionSizer).toBeNull();
    expect(result.drawdownBreaker).toBeNull();

    RISK_CONFIG.enabled = true;
  });

  test('should force-enable when forceRiskManagement is true even if config disabled', () => {
    const { RISK_CONFIG } = jest.requireMock('@arbitrage/config') as { RISK_CONFIG: { enabled: boolean } };
    RISK_CONFIG.enabled = false;

    const result = initializeRiskManagement(logger, {
      skipValidation: true,
      forceRiskManagement: true,
    });

    expect(result.enabled).toBe(true);
    expect(result.success).toBe(true);
    expect(result.probabilityTracker).toBe(mockProbabilityTracker);

    RISK_CONFIG.enabled = true;
  });

  // =========================================================================
  // Partial initialization — one component fails, others succeed
  // =========================================================================

  test('should partially initialize when probabilityTracker fails (evCalculator also skipped)', () => {
    probabilityTrackerShouldThrow = true;

    const result = initializeRiskManagement(logger, { skipValidation: true });

    expect(result.enabled).toBe(true); // positionSizer + drawdownBreaker still work
    expect(result.success).toBe(true);
    expect(result.probabilityTracker).toBeNull();
    expect(result.evCalculator).toBeNull(); // Skipped — depends on probabilityTracker
    expect(result.positionSizer).toBe(mockPositionSizer);
    expect(result.drawdownBreaker).toBe(mockDrawdownBreaker);
    expect(result.componentStatus).toEqual({
      probabilityTracker: false,
      evCalculator: false,
      positionSizer: true,
      drawdownBreaker: true,
    });
    expect(result.error).toContain('probability_tracker');
    expect(result.error).toContain('skipped_missing_probability_tracker');
  });

  test('should partially initialize when evCalculator fails independently', () => {
    evCalculatorShouldThrow = true;

    const result = initializeRiskManagement(logger, { skipValidation: true });

    expect(result.enabled).toBe(true);
    expect(result.probabilityTracker).toBe(mockProbabilityTracker);
    expect(result.evCalculator).toBeNull();
    expect(result.positionSizer).toBe(mockPositionSizer);
    expect(result.drawdownBreaker).toBe(mockDrawdownBreaker);
    expect(result.componentStatus.evCalculator).toBe(false);
    expect(result.componentStatus.probabilityTracker).toBe(true);
    expect(result.error).toContain('ev_calculator');
  });

  test('should partially initialize when positionSizer fails', () => {
    positionSizerShouldThrow = true;

    const result = initializeRiskManagement(logger, { skipValidation: true });

    expect(result.enabled).toBe(true);
    expect(result.positionSizer).toBeNull();
    expect(result.probabilityTracker).toBe(mockProbabilityTracker);
    expect(result.evCalculator).toBe(mockEvCalculator);
    expect(result.drawdownBreaker).toBe(mockDrawdownBreaker);
    expect(result.componentStatus.positionSizer).toBe(false);
  });

  test('should partially initialize when drawdownBreaker fails', () => {
    drawdownBreakerShouldThrow = true;

    const result = initializeRiskManagement(logger, { skipValidation: true });

    expect(result.enabled).toBe(true);
    expect(result.drawdownBreaker).toBeNull();
    expect(result.probabilityTracker).toBe(mockProbabilityTracker);
    expect(result.evCalculator).toBe(mockEvCalculator);
    expect(result.positionSizer).toBe(mockPositionSizer);
    expect(result.componentStatus.drawdownBreaker).toBe(false);
  });

  test('should report complete failure when all components throw', () => {
    probabilityTrackerShouldThrow = true;
    evCalculatorShouldThrow = true;
    positionSizerShouldThrow = true;
    drawdownBreakerShouldThrow = true;

    const result = initializeRiskManagement(logger, { skipValidation: true });

    expect(result.enabled).toBe(false);
    expect(result.success).toBe(false);
    expect(result.probabilityTracker).toBeNull();
    expect(result.evCalculator).toBeNull();
    expect(result.positionSizer).toBeNull();
    expect(result.drawdownBreaker).toBeNull();
    expect(result.componentStatus).toEqual({
      probabilityTracker: false,
      evCalculator: false,
      positionSizer: false,
      drawdownBreaker: false,
    });
    expect(result.error).toBeDefined();
  });

  // =========================================================================
  // Config validation
  // =========================================================================

  test('should fail fast in production when config validation throws', () => {
    const origNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    validateRiskConfigShouldThrow = true;

    const result = initializeRiskManagement(logger);

    expect(result.success).toBe(false);
    expect(result.enabled).toBe(false);
    expect(result.error).toContain('config_validation_failed');

    process.env.NODE_ENV = origNodeEnv;
  });

  test('should continue in non-production when config validation throws', () => {
    const origNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    validateRiskConfigShouldThrow = true;

    const result = initializeRiskManagement(logger);

    expect(result.success).toBe(true);
    expect(result.enabled).toBe(true);
    expect((logger.warn as jest.Mock)).toHaveBeenCalledWith(
      expect.stringContaining('Continuing with potentially invalid'),
    );

    process.env.NODE_ENV = origNodeEnv;
  });
});
