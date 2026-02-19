/**
 * Execution Engine Initializer Unit Tests
 *
 * Comprehensive tests for the initialization facade:
 * - Happy path: all 3 sub-initializers succeed
 * - Already-initialized guard (throws on re-init)
 * - Individual initializer failures (MEV, Risk, Bridge)
 * - State management (reset, isComplete, partialResults)
 * - Mutex protection against concurrent initialization
 *
 * @see services/execution-engine/src/initialization/execution-engine-initializer.ts
 * @see ADR-017: MEV Protection Enhancement
 * @see ADR-021: Capital Risk Management
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Make this file a module to avoid TS2451 redeclaration errors
export {};

// =============================================================================
// Mock Setup - Must be before imports
// =============================================================================

// Mock the three sub-initializers
const mockInitializeMevProviders = jest.fn<() => Promise<any>>();
const mockInitializeRiskManagement = jest.fn<() => any>();
const mockInitializeBridgeRouter = jest.fn<() => any>();

jest.mock('../../src/initialization/mev-initializer', () => ({
  initializeMevProviders: mockInitializeMevProviders,
}));

jest.mock('../../src/initialization/risk-management-initializer', () => ({
  initializeRiskManagement: mockInitializeRiskManagement,
}));

jest.mock('../../src/initialization/bridge-router-initializer', () => ({
  initializeBridgeRouter: mockInitializeBridgeRouter,
}));

// Track the mutex instance created at module load so we can restore its
// runExclusive implementation after jest.resetAllMocks() clears it.
let mockMutexRunExclusive: jest.Mock;
const mockMutexInstances: Array<{ runExclusive: jest.Mock }> = [];

jest.mock('@arbitrage/core', () => ({
  AsyncMutex: jest.fn().mockImplementation(() => {
    const instance = {
      runExclusive: jest.fn().mockImplementation((fn: any) => fn()),
    };
    mockMutexInstances.push(instance);
    mockMutexRunExclusive = instance.runExclusive;
    return instance;
  }),
  getErrorMessage: jest.fn().mockImplementation((e: unknown) =>
    e instanceof Error ? e.message : String(e)
  ),
}));

// =============================================================================
// Imports After Mocking
// =============================================================================

import {
  initializeExecutionEngine,
  resetInitializationState,
  isInitializationComplete,
  getLastPartialResults,
} from '../../src/initialization/execution-engine-initializer';

import type { ProviderServiceImpl } from '../../src/services/provider.service';
import type {
  MevInitializationResult,
  RiskManagementComponents,
  BridgeRouterInitializationResult,
} from '../../src/initialization/types';

// =============================================================================
// Test Data Factories
// =============================================================================

function createMockLogger(): any {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

function createMockProviderService(): ProviderServiceImpl {
  return {} as ProviderServiceImpl;
}

function createMockMevResult(overrides?: Partial<MevInitializationResult>): MevInitializationResult {
  return {
    factory: { getProvider: jest.fn() } as any,
    providersInitialized: 5,
    success: true,
    failedChains: [],
    ...overrides,
  };
}

function createMockRiskResult(overrides?: Partial<RiskManagementComponents>): RiskManagementComponents {
  return {
    drawdownBreaker: { check: jest.fn() } as any,
    evCalculator: { calculate: jest.fn() } as any,
    positionSizer: { size: jest.fn() } as any,
    probabilityTracker: { track: jest.fn() } as any,
    enabled: true,
    success: true,
    componentStatus: {
      probabilityTracker: true,
      evCalculator: true,
      positionSizer: true,
      drawdownBreaker: true,
    },
    ...overrides,
  };
}

function createMockBridgeResult(
  overrides?: Partial<BridgeRouterInitializationResult>
): BridgeRouterInitializationResult {
  return {
    factory: { createRouter: jest.fn() } as any,
    protocols: ['stargate', 'across'],
    chains: ['ethereum', 'arbitrum', 'base'],
    success: true,
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('Execution Engine Initializer', () => {
  let mockLogger: any;
  let mockProviderService: ProviderServiceImpl;

  beforeEach(() => {
    // CRITICAL: Reset module-level state between tests
    resetInitializationState();

    mockLogger = createMockLogger();
    mockProviderService = createMockProviderService();

    // Restore the mutex's runExclusive implementation after jest.resetAllMocks()
    // clears it. The mutex instance was created at module load time and persists
    // across tests, but resetAllMocks clears its mock implementation.
    if (mockMutexRunExclusive) {
      mockMutexRunExclusive.mockImplementation((fn: any) => fn());
    }

    // Restore getErrorMessage implementation (also cleared by resetAllMocks)
    const { getErrorMessage } = require('@arbitrage/core');
    (getErrorMessage as jest.Mock).mockImplementation((e: unknown) =>
      e instanceof Error ? e.message : String(e)
    );

    // Set up default successful mock returns
    mockInitializeMevProviders.mockResolvedValue(createMockMevResult());
    mockInitializeRiskManagement.mockReturnValue(createMockRiskResult());
    mockInitializeBridgeRouter.mockReturnValue(createMockBridgeResult());
  });

  afterEach(() => {
    resetInitializationState();
  });

  // ===========================================================================
  // Happy Path
  // ===========================================================================

  describe('Happy path - all initializers succeed', () => {
    it('should return success result with all components', async () => {
      const result = await initializeExecutionEngine(mockProviderService, mockLogger);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.mev.success).toBe(true);
        expect(result.mev.providersInitialized).toBe(5);

        expect(result.risk.success).toBe(true);
        expect(result.risk.enabled).toBe(true);

        expect(result.bridgeRouter.success).toBe(true);
        expect(result.bridgeRouter.protocols).toEqual(['stargate', 'across']);
      }
    });

    it('should call all three sub-initializers in order', async () => {
      const callOrder: string[] = [];

      mockInitializeMevProviders.mockImplementation(async () => {
        callOrder.push('mev');
        return createMockMevResult();
      });
      mockInitializeRiskManagement.mockImplementation(() => {
        callOrder.push('risk');
        return createMockRiskResult();
      });
      mockInitializeBridgeRouter.mockImplementation(() => {
        callOrder.push('bridge');
        return createMockBridgeResult();
      });

      await initializeExecutionEngine(mockProviderService, mockLogger);

      expect(callOrder).toEqual(['mev', 'risk', 'bridge']);
    });

    it('should pass providerService and logger to MEV initializer', async () => {
      await initializeExecutionEngine(mockProviderService, mockLogger);

      expect(mockInitializeMevProviders).toHaveBeenCalledWith(
        mockProviderService,
        mockLogger
      );
    });

    it('should pass logger and config to risk management initializer', async () => {
      const config = { forceRiskManagement: true };

      await initializeExecutionEngine(mockProviderService, mockLogger, config);

      expect(mockInitializeRiskManagement).toHaveBeenCalledWith(mockLogger, config);
    });

    it('should pass providerService and logger to bridge router initializer', async () => {
      await initializeExecutionEngine(mockProviderService, mockLogger);

      expect(mockInitializeBridgeRouter).toHaveBeenCalledWith(
        mockProviderService,
        mockLogger
      );
    });

    it('should log start and completion messages', async () => {
      await initializeExecutionEngine(mockProviderService, mockLogger);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Starting execution engine initialization'
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Execution engine initialization complete',
        expect.objectContaining({
          durationMs: expect.any(Number),
          mev: expect.any(Object),
          risk: expect.any(Object),
          bridgeRouter: expect.any(Object),
        })
      );
    });

    it('should mark initialization as complete', async () => {
      expect(isInitializationComplete()).toBe(false);

      await initializeExecutionEngine(mockProviderService, mockLogger);

      expect(isInitializationComplete()).toBe(true);
    });
  });

  // ===========================================================================
  // Already Initialized
  // ===========================================================================

  describe('Already initialized guard', () => {
    it('should throw on second initialization call', async () => {
      await initializeExecutionEngine(mockProviderService, mockLogger);

      // The "already initialized" throw is outside the inner try/catch,
      // so it propagates as a rejected promise from runExclusive
      await expect(
        initializeExecutionEngine(mockProviderService, mockLogger)
      ).rejects.toThrow('Execution engine already initialized');
    });

    it('should log warning on re-initialization attempt', async () => {
      await initializeExecutionEngine(mockProviderService, mockLogger);

      await expect(
        initializeExecutionEngine(mockProviderService, mockLogger)
      ).rejects.toThrow();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Execution engine already initialized - skipping re-initialization'
      );
    });

    it('should not call sub-initializers on re-initialization attempt', async () => {
      await initializeExecutionEngine(mockProviderService, mockLogger);

      // Clear mock call history (but NOT implementations - they're still set)
      mockInitializeMevProviders.mockClear();
      mockInitializeRiskManagement.mockClear();
      mockInitializeBridgeRouter.mockClear();

      await expect(
        initializeExecutionEngine(mockProviderService, mockLogger)
      ).rejects.toThrow();

      expect(mockInitializeMevProviders).not.toHaveBeenCalled();
      expect(mockInitializeRiskManagement).not.toHaveBeenCalled();
      expect(mockInitializeBridgeRouter).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // MEV Failure
  // ===========================================================================

  describe('MEV provider initialization failure', () => {
    it('should return failure result when MEV throws', async () => {
      mockInitializeMevProviders.mockRejectedValue(new Error('MEV provider timeout'));

      const result = await initializeExecutionEngine(mockProviderService, mockLogger);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toBe('MEV provider timeout');
        expect(typeof result.partial).toBe('object');
        // MEV failed, so mev should not be in partial results
        // (it threw before storing)
        expect(result.partial?.risk).toBeUndefined();
        expect(result.partial?.bridgeRouter).toBeUndefined();
      }
    });

    it('should not call risk or bridge initializers after MEV failure', async () => {
      mockInitializeMevProviders.mockRejectedValue(new Error('MEV failure'));

      await initializeExecutionEngine(mockProviderService, mockLogger);

      expect(mockInitializeRiskManagement).not.toHaveBeenCalled();
      expect(mockInitializeBridgeRouter).not.toHaveBeenCalled();
    });

    it('should log error with duration on MEV failure', async () => {
      mockInitializeMevProviders.mockRejectedValue(new Error('MEV failure'));

      await initializeExecutionEngine(mockProviderService, mockLogger);

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Execution engine initialization failed',
        expect.objectContaining({
          error: 'MEV failure',
          durationMs: expect.any(Number),
        })
      );
    });

    it('should not mark as initialized after MEV failure', async () => {
      mockInitializeMevProviders.mockRejectedValue(new Error('MEV failure'));

      await initializeExecutionEngine(mockProviderService, mockLogger);

      expect(isInitializationComplete()).toBe(false);
    });

    it('should handle non-Error thrown values', async () => {
      mockInitializeMevProviders.mockRejectedValue('string error');

      const result = await initializeExecutionEngine(mockProviderService, mockLogger);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error.message).toBe('string error');
      }
    });
  });

  // ===========================================================================
  // Risk Management Failure
  // ===========================================================================

  describe('Risk management initialization failure', () => {
    it('should return failure result with MEV in partial results', async () => {
      const mevResult = createMockMevResult();
      mockInitializeMevProviders.mockResolvedValue(mevResult);
      mockInitializeRiskManagement.mockImplementation(() => {
        throw new Error('Risk config invalid');
      });

      const result = await initializeExecutionEngine(mockProviderService, mockLogger);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toBe('Risk config invalid');
        expect(typeof result.partial).toBe('object');
        expect(result.partial?.mev?.success).toBe(true);
        expect(result.partial?.risk).toBeUndefined();
        expect(result.partial?.bridgeRouter).toBeUndefined();
      }
    });

    it('should not call bridge initializer after risk failure', async () => {
      mockInitializeRiskManagement.mockImplementation(() => {
        throw new Error('Risk failure');
      });

      await initializeExecutionEngine(mockProviderService, mockLogger);

      expect(mockInitializeBridgeRouter).not.toHaveBeenCalled();
    });

    it('should not mark as initialized after risk failure', async () => {
      mockInitializeRiskManagement.mockImplementation(() => {
        throw new Error('Risk failure');
      });

      await initializeExecutionEngine(mockProviderService, mockLogger);

      expect(isInitializationComplete()).toBe(false);
    });
  });

  // ===========================================================================
  // Bridge Router Failure
  // ===========================================================================

  describe('Bridge router initialization failure', () => {
    it('should return failure result with MEV and risk in partial results', async () => {
      const mevResult = createMockMevResult();
      const riskResult = createMockRiskResult();
      mockInitializeMevProviders.mockResolvedValue(mevResult);
      mockInitializeRiskManagement.mockReturnValue(riskResult);
      mockInitializeBridgeRouter.mockImplementation(() => {
        throw new Error('Bridge router unavailable');
      });

      const result = await initializeExecutionEngine(mockProviderService, mockLogger);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toBe('Bridge router unavailable');
        expect(typeof result.partial).toBe('object');
        expect(result.partial?.mev?.success).toBe(true);
        expect(result.partial?.risk?.success).toBe(true);
        expect(result.partial?.bridgeRouter).toBeUndefined();
      }
    });

    it('should not mark as initialized after bridge failure', async () => {
      mockInitializeBridgeRouter.mockImplementation(() => {
        throw new Error('Bridge failure');
      });

      await initializeExecutionEngine(mockProviderService, mockLogger);

      expect(isInitializationComplete()).toBe(false);
    });
  });

  // ===========================================================================
  // resetInitializationState()
  // ===========================================================================

  describe('resetInitializationState()', () => {
    it('should allow re-initialization after reset', async () => {
      // First initialization
      await initializeExecutionEngine(mockProviderService, mockLogger);
      expect(isInitializationComplete()).toBe(true);

      // Reset
      resetInitializationState();
      expect(isInitializationComplete()).toBe(false);

      // Second initialization should succeed
      const result = await initializeExecutionEngine(mockProviderService, mockLogger);
      expect(result.success).toBe(true);
    });

    it('should clear partial results', async () => {
      // Cause a failure to populate partial results
      mockInitializeRiskManagement.mockImplementation(() => {
        throw new Error('Risk failure');
      });
      await initializeExecutionEngine(mockProviderService, mockLogger);

      expect(getLastPartialResults()).not.toBeNull();

      resetInitializationState();

      expect(getLastPartialResults()).toBeNull();
    });

    it('should set isInitializationComplete to false', async () => {
      await initializeExecutionEngine(mockProviderService, mockLogger);
      expect(isInitializationComplete()).toBe(true);

      resetInitializationState();

      expect(isInitializationComplete()).toBe(false);
    });
  });

  // ===========================================================================
  // isInitializationComplete()
  // ===========================================================================

  describe('isInitializationComplete()', () => {
    it('should return false before initialization', () => {
      expect(isInitializationComplete()).toBe(false);
    });

    it('should return true after successful initialization', async () => {
      await initializeExecutionEngine(mockProviderService, mockLogger);

      expect(isInitializationComplete()).toBe(true);
    });

    it('should return false after failed initialization', async () => {
      mockInitializeMevProviders.mockRejectedValue(new Error('fail'));

      await initializeExecutionEngine(mockProviderService, mockLogger);

      expect(isInitializationComplete()).toBe(false);
    });

    it('should return false after reset', async () => {
      await initializeExecutionEngine(mockProviderService, mockLogger);
      expect(isInitializationComplete()).toBe(true);

      resetInitializationState();

      expect(isInitializationComplete()).toBe(false);
    });
  });

  // ===========================================================================
  // getLastPartialResults()
  // ===========================================================================

  describe('getLastPartialResults()', () => {
    it('should return null before any initialization attempt', () => {
      expect(getLastPartialResults()).toBeNull();
    });

    it('should have all components after successful initialization', async () => {
      await initializeExecutionEngine(mockProviderService, mockLogger);

      const partial = getLastPartialResults();
      expect(partial).not.toBeNull();
      expect(typeof partial?.mev).toBe('object');
      expect(typeof partial?.risk).toBe('object');
      expect(typeof partial?.bridgeRouter).toBe('object');
    });

    it('should have only MEV after risk failure', async () => {
      mockInitializeRiskManagement.mockImplementation(() => {
        throw new Error('Risk failure');
      });

      await initializeExecutionEngine(mockProviderService, mockLogger);

      const partial = getLastPartialResults();
      expect(partial).not.toBeNull();
      expect(typeof partial?.mev).toBe('object');
      expect(partial?.risk).toBeUndefined();
      expect(partial?.bridgeRouter).toBeUndefined();
    });

    it('should have MEV and risk after bridge failure', async () => {
      mockInitializeBridgeRouter.mockImplementation(() => {
        throw new Error('Bridge failure');
      });

      await initializeExecutionEngine(mockProviderService, mockLogger);

      const partial = getLastPartialResults();
      expect(partial).not.toBeNull();
      expect(typeof partial?.mev).toBe('object');
      expect(typeof partial?.risk).toBe('object');
      expect(partial?.bridgeRouter).toBeUndefined();
    });

    it('should be null after reset', async () => {
      await initializeExecutionEngine(mockProviderService, mockLogger);
      expect(getLastPartialResults()).not.toBeNull();

      resetInitializationState();

      expect(getLastPartialResults()).toBeNull();
    });

    it('should be empty object (no components) after immediate MEV failure', async () => {
      mockInitializeMevProviders.mockRejectedValue(new Error('MEV failure'));

      await initializeExecutionEngine(mockProviderService, mockLogger);

      const partial = getLastPartialResults();
      expect(partial).not.toBeNull();
      // lastPartialResults was set to {} before MEV call, and MEV threw
      // before its result was stored
      expect(partial?.mev).toBeUndefined();
    });
  });

  // ===========================================================================
  // Concurrent Calls (Mutex)
  // ===========================================================================

  describe('Concurrent initialization (mutex protection)', () => {
    it('should wrap initialization in mutex runExclusive', async () => {
      // Verify the mutex's runExclusive is called when we initialize.
      // The mutex instance was created at module load; we tracked it.
      const mutexInstance = mockMutexInstances[0];
      expect(typeof mutexInstance).toBe('object');

      await initializeExecutionEngine(mockProviderService, mockLogger);

      expect(mutexInstance.runExclusive).toHaveBeenCalledTimes(1);
      expect(mutexInstance.runExclusive).toHaveBeenCalledWith(expect.any(Function));
    });

    it('should prevent re-initialization even within same call', async () => {
      // First call succeeds
      const result1 = await initializeExecutionEngine(mockProviderService, mockLogger);
      expect(result1.success).toBe(true);

      // Second call should throw "already initialized"
      await expect(
        initializeExecutionEngine(mockProviderService, mockLogger)
      ).rejects.toThrow('already initialized');
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('Edge cases', () => {
    it('should handle config being undefined', async () => {
      const result = await initializeExecutionEngine(
        mockProviderService,
        mockLogger,
        undefined
      );

      expect(result.success).toBe(true);
      expect(mockInitializeRiskManagement).toHaveBeenCalledWith(
        mockLogger,
        undefined
      );
    });

    it('should allow re-initialization after failed attempt and reset', async () => {
      // First: fail
      mockInitializeMevProviders.mockRejectedValue(new Error('network down'));
      const result1 = await initializeExecutionEngine(mockProviderService, mockLogger);
      expect(result1.success).toBe(false);

      // Reset
      resetInitializationState();

      // Second: succeed
      mockInitializeMevProviders.mockResolvedValue(createMockMevResult());
      const result2 = await initializeExecutionEngine(mockProviderService, mockLogger);
      expect(result2.success).toBe(true);
    });

    it('should not set isInitialized when initialization fails partway', async () => {
      mockInitializeBridgeRouter.mockImplementation(() => {
        throw new Error('bridge fail');
      });

      await initializeExecutionEngine(mockProviderService, mockLogger);

      // isInitialized should remain false since not all components succeeded
      expect(isInitializationComplete()).toBe(false);

      // After reset, can re-initialize
      resetInitializationState();
      mockInitializeBridgeRouter.mockReturnValue(createMockBridgeResult());

      const result = await initializeExecutionEngine(mockProviderService, mockLogger);
      expect(result.success).toBe(true);
      expect(isInitializationComplete()).toBe(true);
    });
  });
});
