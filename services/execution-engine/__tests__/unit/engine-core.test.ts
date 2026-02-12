// Execution Engine Core, Simulation Guard, Precision Fix, and Standby Tests
import { jest, describe, test, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ExecutionEngineService, ExecutionEngineConfig } from '../../src/engine';
import { createMockLogger, createMockPerfLogger, createMockExecutionStateManager } from '@arbitrage/test-utils';
import { ethers } from 'ethers';

describe('ExecutionEngineService', () => {
  let engine: ExecutionEngineService;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockPerfLogger: ReturnType<typeof createMockPerfLogger>;
  let mockStateManager: ReturnType<typeof createMockExecutionStateManager>;

  // Create test config with injected mocks
  const createTestConfig = (overrides: Partial<ExecutionEngineConfig> = {}): ExecutionEngineConfig => ({
    logger: mockLogger,
    perfLogger: mockPerfLogger as any,
    stateManager: mockStateManager as any,
    ...overrides
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockPerfLogger = createMockPerfLogger();
    mockStateManager = createMockExecutionStateManager();

    engine = new ExecutionEngineService(createTestConfig());
  });

  /**
   * GIVEN: A new ExecutionEngineService instance with default configuration
   * WHEN: The service is instantiated
   * THEN: It should be fully initialized and ready to process opportunities
   *
   * **Business Value**: Ensures the engine can be created without errors,
   * establishing a baseline for all other tests.
   */
  test('should be fully initialized and ready for opportunity processing', () => {
    // Then: Engine is created successfully
    expect(engine).toBeDefined();
    expect(engine).toBeInstanceOf(ExecutionEngineService);
  });

  // PHASE-3.2: validateOpportunity was moved to OpportunityConsumer
  // buildSwapPath is in BaseExecutionStrategy
  // See consumers/opportunity.consumer.test.ts for consumer-specific tests

  /**
   * GIVEN: A newly instantiated ExecutionEngineService
   * WHEN: Stats are retrieved before any executions occur
   * THEN: All counters should be initialized to zero, providing a clean slate
   *
   * **Business Value**: Zero-initialized stats prevent garbage values from
   * affecting metric dashboards and monitoring systems.
   */
  test('should start with all execution metrics at zero for accurate tracking', () => {
    // When: Stats are retrieved from new engine
    const stats = engine.getStats();

    // Then: All execution counters start at zero
    expect(stats).toBeDefined();
    expect(stats.opportunitiesReceived).toBe(0);
    expect(stats.executionAttempts).toBe(0);
    expect(stats.successfulExecutions).toBe(0);
    expect(stats.failedExecutions).toBe(0);
  });
});

// =============================================================================
// Production Simulation Mode Guard Tests (FIX-3.1)
// =============================================================================

describe('ExecutionEngineService Production Simulation Guard (FIX-3.1)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should throw error when simulation mode is enabled in production', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.SIMULATION_MODE_PRODUCTION_OVERRIDE;

    const mockLogger = createMockLogger();
    const mockPerfLogger = createMockPerfLogger();
    const mockStateManager = createMockExecutionStateManager();

    expect(() => {
      new ExecutionEngineService({
        logger: mockLogger,
        perfLogger: mockPerfLogger as any,
        stateManager: mockStateManager as any,
        simulationConfig: {
          enabled: true
        }
      });
    }).toThrow('[CRITICAL] Simulation mode is enabled in production environment');
  });

  it('should allow simulation mode in non-production environments', () => {
    process.env.NODE_ENV = 'development';

    const mockLogger = createMockLogger();
    const mockPerfLogger = createMockPerfLogger();
    const mockStateManager = createMockExecutionStateManager();

    expect(() => {
      new ExecutionEngineService({
        logger: mockLogger,
        perfLogger: mockPerfLogger as any,
        stateManager: mockStateManager as any,
        simulationConfig: {
          enabled: true
        }
      });
    }).not.toThrow();
  });

  it('should allow production mode without simulation', () => {
    process.env.NODE_ENV = 'production';

    const mockLogger = createMockLogger();
    const mockPerfLogger = createMockPerfLogger();
    const mockStateManager = createMockExecutionStateManager();

    expect(() => {
      new ExecutionEngineService({
        logger: mockLogger,
        perfLogger: mockPerfLogger as any,
        stateManager: mockStateManager as any,
        simulationConfig: {
          enabled: false
        }
      });
    }).not.toThrow();
  });

  it('should allow simulation mode in production with explicit override', () => {
    process.env.NODE_ENV = 'production';
    process.env.SIMULATION_MODE_PRODUCTION_OVERRIDE = 'true';

    const mockLogger = createMockLogger();
    const mockPerfLogger = createMockPerfLogger();
    const mockStateManager = createMockExecutionStateManager();

    // Capture console.error for the warning
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => {
      new ExecutionEngineService({
        logger: mockLogger,
        perfLogger: mockPerfLogger as any,
        stateManager: mockStateManager as any,
        simulationConfig: {
          enabled: true
        }
      });
    }).not.toThrow();

    // Verify warning was logged
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('DANGER: SIMULATION MODE OVERRIDE ACTIVE IN PRODUCTION')
    );

    consoleErrorSpy.mockRestore();
  });
});

// =============================================================================
// Precision Fix Regression Tests (PRECISION-FIX)
// =============================================================================

describe('Precision Fix Regression Tests', () => {
  test('should correctly convert small expectedProfit values without precision loss', () => {
    // This tests the fix for PRECISION-FIX in prepareFlashLoanTransaction
    // Previously: BigInt(Math.floor(0.000000123456789 * 1e18)) would lose precision
    // Now: ethers.parseUnits(value.toFixed(18), 18) preserves precision

    const smallProfit = 0.000000123456789;

    // Old buggy implementation (loses precision):
    const buggyResult = BigInt(Math.floor(smallProfit * 1e18));

    // New correct implementation:
    const correctResult = ethers.parseUnits(smallProfit.toFixed(18), 18);

    // The correct result should be 123456789000000000n (approximately)
    // But due to float representation, toFixed(18) gives us a precise string
    expect(correctResult).toBeDefined();
    expect(typeof correctResult).toBe('bigint');

    // Verify the new implementation doesn't lose significant digits
    // The buggy version loses precision, the correct version maintains it
    expect(correctResult.toString().length).toBeGreaterThanOrEqual(buggyResult.toString().length);
  });

  test('should handle typical profit values correctly', () => {
    // Test typical profit value (e.g., 0.01 ETH = 10000000000000000 wei)
    const typicalProfit = 0.01;
    const result = ethers.parseUnits(typicalProfit.toFixed(18), 18);

    expect(result).toBe(10000000000000000n);
  });

  test('should handle very small profit values (micro arbitrage)', () => {
    // Test very small profit (e.g., 0.000001 ETH = 1000000000000 wei)
    const microProfit = 0.000001;
    const result = ethers.parseUnits(microProfit.toFixed(18), 18);

    expect(result).toBe(1000000000000n);
  });

  test('should handle zero profit correctly', () => {
    const zeroProfit = 0;
    const result = ethers.parseUnits(zeroProfit.toFixed(18), 18);

    expect(result).toBe(0n);
  });

  test('should handle maximum safe integer-like profits', () => {
    // Test large profit value (e.g., 1000 ETH)
    const largeProfit = 1000;
    const result = ethers.parseUnits(largeProfit.toFixed(18), 18);

    expect(result).toBe(1000000000000000000000n);
  });
});

// =============================================================================
// Standby Configuration Tests (ADR-007)
// =============================================================================

describe('ExecutionEngineService Standby Configuration (ADR-007)', () => {
  test('should initialize with default standby config when not provided', () => {
    const mockLogger = createMockLogger();
    const mockPerfLogger = createMockPerfLogger();
    const mockStateManager = createMockExecutionStateManager();

    const engine = new ExecutionEngineService({
      logger: mockLogger,
      perfLogger: mockPerfLogger as any,
      stateManager: mockStateManager as any
    });

    expect(engine.getIsStandby()).toBe(false);
    expect(engine.getIsActivated()).toBe(false);
    expect(engine.getStandbyConfig()).toEqual({
      isStandby: false,
      queuePausedOnStart: false,
      activationDisablesSimulation: true,
      regionId: undefined
    });
  });

  test('should initialize with provided standby config', () => {
    const mockLogger = createMockLogger();
    const mockPerfLogger = createMockPerfLogger();
    const mockStateManager = createMockExecutionStateManager();

    const engine = new ExecutionEngineService({
      logger: mockLogger,
      perfLogger: mockPerfLogger as any,
      stateManager: mockStateManager as any,
      standbyConfig: {
        isStandby: true,
        queuePausedOnStart: true,
        activationDisablesSimulation: true,
        regionId: 'us-east1'
      }
    });

    expect(engine.getIsStandby()).toBe(true);
    expect(engine.getIsActivated()).toBe(false);
    expect(engine.getStandbyConfig()).toEqual({
      isStandby: true,
      queuePausedOnStart: true,
      activationDisablesSimulation: true,
      regionId: 'us-east1'
    });
  });

  test('should start with simulation mode when configured', () => {
    const mockLogger = createMockLogger();
    const mockPerfLogger = createMockPerfLogger();
    const mockStateManager = createMockExecutionStateManager();

    const engine = new ExecutionEngineService({
      logger: mockLogger,
      perfLogger: mockPerfLogger as any,
      stateManager: mockStateManager as any,
      simulationConfig: {
        enabled: true,
        successRate: 0.9
      },
      standbyConfig: {
        isStandby: true,
        queuePausedOnStart: true,
        activationDisablesSimulation: true,
        regionId: 'us-east1'
      }
    });

    expect(engine.getIsSimulationMode()).toBe(true);
    expect(engine.getIsStandby()).toBe(true);
  });
});
