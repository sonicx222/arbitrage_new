/**
 * Engine-Level Risk Management API Tests
 *
 * Tests the ExecutionEngineService risk management public API surface:
 * - isRiskManagementEnabled()
 * - getDrawdownState() / getDrawdownStats()
 * - isTradingAllowed()
 * - getEVCalculatorStats() / getPositionSizerStats() / getProbabilityTrackerStats()
 * - forceResetDrawdownBreaker() / manualResetDrawdownBreaker()
 * - updateRiskCapital()
 *
 * These are engine-level integration tests that verify the API
 * returns correct data when risk management is/isn't initialized.
 *
 * @see engine.ts lines 1702-1805
 * @see risk-management-orchestrator.test.ts for orchestrator unit tests
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { ExecutionEngineService, type ExecutionEngineConfig } from '../../src/engine';
import { createMockLogger, createMockPerfLogger, createMockExecutionStateManager } from '@arbitrage/test-utils';

describe('ExecutionEngineService Risk Management API', () => {
  let engine: ExecutionEngineService;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockPerfLogger: ReturnType<typeof createMockPerfLogger>;
  let mockStateManager: ReturnType<typeof createMockExecutionStateManager>;

  const createTestConfig = (overrides: Partial<ExecutionEngineConfig> = {}): ExecutionEngineConfig => ({
    logger: mockLogger,
    perfLogger: mockPerfLogger as any,
    stateManager: mockStateManager as any,
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockPerfLogger = createMockPerfLogger();
    mockStateManager = createMockExecutionStateManager();
    engine = new ExecutionEngineService(createTestConfig());
  });

  // ===========================================================================
  // isRiskManagementEnabled()
  // ===========================================================================

  describe('isRiskManagementEnabled()', () => {
    it('should return false before initialization', () => {
      expect(engine.isRiskManagementEnabled()).toBe(false);
    });
  });

  // ===========================================================================
  // Drawdown State API
  // ===========================================================================

  describe('getDrawdownState()', () => {
    it('should return null when risk management is not initialized', () => {
      expect(engine.getDrawdownState()).toBeNull();
    });
  });

  describe('getDrawdownStats()', () => {
    it('should return null when risk management is not initialized', () => {
      expect(engine.getDrawdownStats()).toBeNull();
    });
  });

  describe('isTradingAllowed()', () => {
    it('should return null when risk management is not initialized', () => {
      expect(engine.isTradingAllowed()).toBeNull();
    });
  });

  // ===========================================================================
  // Calculator/Tracker Stats API
  // ===========================================================================

  describe('getEVCalculatorStats()', () => {
    it('should return null when risk management is not initialized', () => {
      expect(engine.getEVCalculatorStats()).toBeNull();
    });
  });

  describe('getPositionSizerStats()', () => {
    it('should return null when risk management is not initialized', () => {
      expect(engine.getPositionSizerStats()).toBeNull();
    });
  });

  describe('getProbabilityTrackerStats()', () => {
    it('should return null when risk management is not initialized', () => {
      expect(engine.getProbabilityTrackerStats()).toBeNull();
    });
  });

  // ===========================================================================
  // Manual Reset API
  // ===========================================================================

  describe('forceResetDrawdownBreaker()', () => {
    it('should not throw when drawdown breaker is null', () => {
      expect(() => engine.forceResetDrawdownBreaker()).not.toThrow();
    });

    it('should not log warning when drawdown breaker is null', () => {
      engine.forceResetDrawdownBreaker();
      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('force-resetting'),
      );
    });
  });

  describe('manualResetDrawdownBreaker()', () => {
    it('should return false when drawdown breaker is null', () => {
      expect(engine.manualResetDrawdownBreaker()).toBe(false);
    });
  });

  // ===========================================================================
  // Capital Update API
  // ===========================================================================

  describe('updateRiskCapital()', () => {
    it('should not throw when risk components are null', () => {
      expect(() => engine.updateRiskCapital(1000000000000000000n)).not.toThrow();
    });

    it('should log the capital update', () => {
      const newCapital = 5000000000000000000n; // 5 ETH
      engine.updateRiskCapital(newCapital);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Risk management capital updated',
        expect.objectContaining({
          newCapital: newCapital.toString(),
        }),
      );
    });

    it('should handle zero capital', () => {
      expect(() => engine.updateRiskCapital(0n)).not.toThrow();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Risk management capital updated',
        expect.objectContaining({ newCapital: '0' }),
      );
    });
  });

  // ===========================================================================
  // Stats Integration
  // ===========================================================================

  describe('getStats() risk fields', () => {
    it('should include risk-related counters in stats', () => {
      const stats = engine.getStats();
      expect(stats).toHaveProperty('riskDrawdownBlocks');
      expect(stats).toHaveProperty('riskEVRejections');
      expect(stats).toHaveProperty('riskPositionSizeRejections');
      expect(stats).toHaveProperty('riskCautionCount');
    });

    it('should initialize risk counters to zero', () => {
      const stats = engine.getStats();
      expect(stats.riskDrawdownBlocks).toBe(0);
      expect(stats.riskEVRejections).toBe(0);
      expect(stats.riskPositionSizeRejections).toBe(0);
      expect(stats.riskCautionCount).toBe(0);
    });
  });
});
