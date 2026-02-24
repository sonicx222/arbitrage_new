/**
 * Engine FE-001 Flash Loan Wiring Tests
 *
 * Tests the 4 branches of initializeStrategies() FE-001 wiring in engine.ts:
 * 1. Feature flag ON + flash loan contracts configured → CrossChainStrategy with deps
 * 2. Feature flag ON + no contracts → CrossChainStrategy without deps + warning
 * 3. Feature flag OFF → CrossChainStrategy without deps (no flash loan warning)
 * 4. Feature flag ON + FlashLoanStrategy init error → CrossChainStrategy without deps
 *
 * Uses jest.mock() for heavy dependencies (Redis, providers) so start() can
 * reach initializeStrategies() without actual infrastructure.
 *
 * Note: jest.config.base.js has resetMocks: true, which resets mock implementations
 * before each test. Therefore, all mockImplementation() calls must be in beforeEach(),
 * not in jest.mock() factories.
 *
 * @see services/execution-engine/src/engine.ts initializeStrategies()
 * @see docs/research/FUTURE_ENHANCEMENTS.md#FE-001
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createMockLogger, createMockPerfLogger, createMockExecutionStateManager } from '@arbitrage/test-utils';

// =============================================================================
// Mock module declarations (factories create bare jest.fn() stubs)
// Implementations are set in beforeEach to survive resetMocks: true
// =============================================================================

jest.mock('@arbitrage/core', () => {
  const actual = jest.requireActual<Record<string, unknown>>('@arbitrage/core');
  return {
    ...actual,
    getRedisClient: jest.fn(),
    getRedisStreamsClient: jest.fn(),
    getDistributedLockManager: jest.fn(),
    getNonceManager: jest.fn(),
  };
});

jest.mock('../../src/initialization', () => ({
  initializeMevProviders: jest.fn(),
  initializeBridgeRouter: jest.fn(),
  initializeRiskManagement: jest.fn(),
  resetInitializationState: jest.fn(),
}));

jest.mock('../../src/strategies/cross-chain.strategy', () => ({
  CrossChainStrategy: jest.fn(),
}));

jest.mock('../../src/strategies/flash-loan.strategy', () => ({
  FlashLoanStrategy: jest.fn(),
}));

jest.mock('../../src/strategies/flash-loan-providers/provider-factory', () => ({
  createFlashLoanProviderFactory: jest.fn(),
}));

jest.mock('../../src/strategies/simulation.strategy', () => ({
  SimulationStrategy: jest.fn(),
}));

jest.mock('../../src/strategies/intra-chain.strategy', () => ({
  IntraChainStrategy: jest.fn(),
}));

jest.mock('../../src/strategies/strategy-factory', () => ({
  createStrategyFactory: jest.fn(),
  ExecutionStrategyFactory: jest.fn(),
}));

jest.mock('../../src/services/provider.service', () => ({
  ProviderServiceImpl: jest.fn(),
}));

jest.mock('../../src/services/queue.service', () => ({
  QueueServiceImpl: jest.fn(),
}));

jest.mock('../../src/services/health-monitoring-manager', () => ({
  createHealthMonitoringManager: jest.fn(),
  HealthMonitoringManager: jest.fn(),
}));

jest.mock('../../src/services/circuit-breaker-manager', () => ({
  createCircuitBreakerManager: jest.fn(),
  CircuitBreakerManager: jest.fn(),
}));

jest.mock('../../src/services/pending-state-manager', () => ({
  createPendingStateManager: jest.fn(),
  PendingStateManager: jest.fn(),
}));

jest.mock('../../src/services/tx-simulation-initializer', () => ({
  initializeTxSimulationService: jest.fn(),
}));

jest.mock('../../src/consumers/opportunity.consumer', () => ({
  OpportunityConsumer: jest.fn(),
}));

jest.mock('../../src/risk', () => ({
  createRiskOrchestrator: jest.fn(),
  RiskManagementOrchestrator: jest.fn(),
}));

jest.mock('../../src/ab-testing', () => ({
  createABTestingFramework: jest.fn(),
  ABTestingFramework: jest.fn(),
}));

jest.mock('../../src/services/simulation/simulation-metrics-collector', () => ({
  createSimulationMetricsCollector: jest.fn(),
  SimulationMetricsCollector: jest.fn(),
}));

jest.mock('../../src/services/lock-conflict-tracker', () => ({
  LockConflictTracker: jest.fn(),
}));

// =============================================================================
// Imports (after mocks)
// =============================================================================

import { ExecutionEngineService } from '../../src/engine';
import { CrossChainStrategy } from '../../src/strategies/cross-chain.strategy';
import { FlashLoanStrategy } from '../../src/strategies/flash-loan.strategy';
import { createFlashLoanProviderFactory } from '../../src/strategies/flash-loan-providers/provider-factory';
import { FEATURE_FLAGS } from '@arbitrage/config';

import { getRedisClient, getRedisStreamsClient, getDistributedLockManager, getNonceManager } from '@arbitrage/core';
import { initializeMevProviders, initializeBridgeRouter, initializeRiskManagement } from '../../src/initialization';
import { SimulationStrategy } from '../../src/strategies/simulation.strategy';
import { IntraChainStrategy } from '../../src/strategies/intra-chain.strategy';
import { createStrategyFactory } from '../../src/strategies/strategy-factory';
import { ProviderServiceImpl } from '../../src/services/provider.service';
import { QueueServiceImpl } from '../../src/services/queue.service';
import { createHealthMonitoringManager } from '../../src/services/health-monitoring-manager';
import { createCircuitBreakerManager } from '../../src/services/circuit-breaker-manager';
import { createPendingStateManager } from '../../src/services/pending-state-manager';
import { initializeTxSimulationService } from '../../src/services/tx-simulation-initializer';
import { OpportunityConsumer } from '../../src/consumers/opportunity.consumer';
import { createRiskOrchestrator } from '../../src/risk';
import { createABTestingFramework } from '../../src/ab-testing';
import { createSimulationMetricsCollector } from '../../src/services/simulation/simulation-metrics-collector';
import { LockConflictTracker } from '../../src/services/lock-conflict-tracker';

// =============================================================================
// Shared mock instances (referenced in assertions)
// =============================================================================

const mockCrossChainConstructor = jest.fn();
const mockFlashLoanStrategyInstance = { execute: jest.fn() };
const mockProviderFactoryInstance = { getProvider: jest.fn() };

const originalEnv = { ...process.env };

describe('ExecutionEngineService FE-001 Flash Loan Wiring', () => {
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockPerfLogger: ReturnType<typeof createMockPerfLogger>;
  let mockStateManager: ReturnType<typeof createMockExecutionStateManager>;
  let savedUseDestChainFlashLoan: boolean;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.DISABLE_CONFIG_VALIDATION = 'true';

    // Save and reset the feature flag (mutated directly since FEATURE_FLAGS is not frozen)
    savedUseDestChainFlashLoan = FEATURE_FLAGS.useDestChainFlashLoan;
    FEATURE_FLAGS.useDestChainFlashLoan = false;

    // Clear any flash loan contract env vars
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('FLASH_LOAN_CONTRACT_')) {
        delete process.env[key];
      }
    }

    mockLogger = createMockLogger();
    mockPerfLogger = createMockPerfLogger();
    mockStateManager = createMockExecutionStateManager();

    mockCrossChainConstructor.mockReset();

    // =========================================================================
    // Re-establish mock implementations (resetMocks: true clears these each test)
    // =========================================================================

    // Helper to bypass strict jest.Mock<UnknownFunction> type inference
     
    const mock = (fn: unknown) => fn as jest.Mock<any>;

    // Override executeStart to return { success: true } after running the callback.
    // The default mock from createMockExecutionStateManager calls fn() but returns
    // Promise<void> (undefined). engine.ts:612 checks result.success.
    mock(mockStateManager.executeStart).mockImplementation(
      async (fn: () => Promise<void>) => { await fn(); return { success: true }; }
    );

    // Infrastructure mocks
    const mockRedis = { get: jest.fn(), set: jest.fn(), del: jest.fn(), disconnect: jest.fn() };
    const mockStreams = { xadd: jest.fn(), xread: jest.fn(), disconnect: jest.fn() };
    const mockLockMgr = { acquireLock: jest.fn(), releaseLock: jest.fn(), disconnect: jest.fn() };
    const mockNonceMgr = { start: jest.fn(), stop: jest.fn(), getNonce: jest.fn() };

    mock(getRedisClient).mockResolvedValue(mockRedis);
    mock(getRedisStreamsClient).mockResolvedValue(mockStreams);
    mock(getDistributedLockManager).mockResolvedValue(mockLockMgr);
    mock(getNonceManager).mockReturnValue(mockNonceMgr);

    // Initialization mocks
    mock(initializeMevProviders).mockResolvedValue({ factory: null, success: true });
    mock(initializeBridgeRouter).mockReturnValue({ factory: null, success: true });
    mock(initializeRiskManagement).mockReturnValue({
      drawdownBreaker: null,
      evCalculator: null,
      positionSizer: null,
      probabilityTracker: null,
      enabled: false,
      success: true,
      componentStatus: {},
    });

    // Strategy mocks
    mock(CrossChainStrategy).mockImplementation((...args: unknown[]) => {
      mockCrossChainConstructor(...args);
      return {
        execute: jest.fn(),
        executeSellOnDestination: jest.fn(),
        isDestinationFlashLoanSupported: jest.fn().mockReturnValue(false),
      };
    });

    mock(FlashLoanStrategy).mockImplementation(() => mockFlashLoanStrategyInstance);
    mock(createFlashLoanProviderFactory).mockReturnValue(mockProviderFactoryInstance);

    mock(SimulationStrategy).mockImplementation(() => ({
      execute: jest.fn(),
    }));

    mock(IntraChainStrategy).mockImplementation(() => ({
      execute: jest.fn(),
    }));

    mock(createStrategyFactory).mockReturnValue({
      registerStrategies: jest.fn(),
      registerFlashLoanStrategy: jest.fn(),
      getRegisteredTypes: jest.fn().mockReturnValue(['simulation', 'intraChain', 'crossChain']),
      getStrategy: jest.fn(),
    });

    // Service mocks
    mock(ProviderServiceImpl).mockImplementation(() => ({
      initialize: jest.fn(async () => {}),
      initializeWallets: jest.fn(),
      validateConnectivity: jest.fn(async () => {}),
      startHealthChecks: jest.fn(),
      onProviderReconnect: jest.fn(),
      stop: jest.fn(async () => {}),
      getProviderHealth: jest.fn(() => ({})),
    }));

    mock(QueueServiceImpl).mockImplementation(() => ({
      pause: jest.fn(),
      resume: jest.fn(),
      enqueue: jest.fn(),
      size: jest.fn().mockReturnValue(0),
      stop: jest.fn(),
      onItemAvailable: jest.fn(),
    }));

    mock(createHealthMonitoringManager).mockReturnValue({
      start: jest.fn(),
      stop: jest.fn(),
    });

    mock(createCircuitBreakerManager).mockReturnValue({
      initialize: jest.fn(),
      getStatus: jest.fn().mockReturnValue({ state: 'CLOSED' }),
      recordSuccess: jest.fn(),
      recordFailure: jest.fn(),
      forceOpen: jest.fn(),
      forceClose: jest.fn(),
    });

    mock(createPendingStateManager).mockReturnValue(null);
    mock(initializeTxSimulationService).mockReturnValue(null);

    mock(OpportunityConsumer).mockImplementation(() => ({
      createConsumerGroup: jest.fn(async () => {}),
      start: jest.fn(async () => {}),
      stop: jest.fn(async () => {}),
    }));

    mock(createRiskOrchestrator).mockReturnValue(null);
    mock(createABTestingFramework).mockReturnValue(null);
    mock(createSimulationMetricsCollector).mockReturnValue({
      start: jest.fn(),
      stop: jest.fn(),
      getSnapshot: jest.fn().mockReturnValue(null),
    });

    mock(LockConflictTracker).mockImplementation(() => ({
      recordConflict: jest.fn(),
      getConflictCount: jest.fn().mockReturnValue(0),
      reset: jest.fn(),
    }));
  });

  afterEach(() => {
    FEATURE_FLAGS.useDestChainFlashLoan = savedUseDestChainFlashLoan;
    process.env = { ...originalEnv };
  });

  function getLogMessages(level: 'info' | 'warn' | 'debug' | 'error'): string[] {
    return (mockLogger[level] as jest.Mock).mock.calls
      .map((call: unknown[]) => (typeof call[0] === 'string' ? call[0] : ''));
  }

  async function startEngine() {
    const engine = new ExecutionEngineService({
      logger: mockLogger,
      perfLogger: mockPerfLogger as any,
      stateManager: mockStateManager as any,
      simulationConfig: { enabled: true },
    });
    await engine.start();
    return engine;
  }

  // =========================================================================
  // Branch 1: Feature flag ON + contracts configured → with flash loan deps
  // =========================================================================

  it('should wire flash loan deps into CrossChainStrategy when flag ON and contracts configured', async () => {
    FEATURE_FLAGS.useDestChainFlashLoan = true;
    process.env.FLASH_LOAN_CONTRACT_ETHEREUM = '0x1234567890123456789012345678901234567890';

    await startEngine();

    const infoMessages = getLogMessages('info');

    // FlashLoanStrategy constructor should have been called (contract address found)
    expect(FlashLoanStrategy).toHaveBeenCalled();

    // Provider factory should have been created
    expect(createFlashLoanProviderFactory).toHaveBeenCalled();

    // CrossChainStrategy should receive 3 args: logger, providerFactory, flashLoanStrategy
    expect(mockCrossChainConstructor).toHaveBeenCalled();
    const args = mockCrossChainConstructor.mock.calls[0];
    expect(args).toHaveLength(3);
    expect(args[0]).toBe(mockLogger);
    expect(args[1]).toBe(mockProviderFactoryInstance);
    expect(args[2]).toBe(mockFlashLoanStrategyInstance);

    // Verify log messages
    expect(infoMessages).toContainEqual(
      expect.stringContaining('FlashLoanStrategy initialized'),
    );
    expect(infoMessages).toContainEqual(
      expect.stringContaining('CrossChainStrategy initialized with destination flash loan support'),
    );
  });

  // =========================================================================
  // Branch 2: Feature flag ON + no contracts → warning
  // =========================================================================

  it('should warn when flag ON but no contracts configured', async () => {
    FEATURE_FLAGS.useDestChainFlashLoan = true;
    // No FLASH_LOAN_CONTRACT_* env vars set (cleared in beforeEach)

    await startEngine();

    const debugMessages = getLogMessages('debug');
    const warnMessages = getLogMessages('warn');

    // Should log that no contracts configured
    expect(debugMessages).toContainEqual(
      expect.stringContaining('FlashLoanStrategy not registered - no contract addresses configured'),
    );

    // Should warn about flag enabled but no contracts
    expect(warnMessages).toContainEqual(
      expect.stringContaining('Destination flash loan feature enabled but no flash loan contracts configured'),
    );

    // CrossChainStrategy should receive only 1 arg (logger)
    expect(mockCrossChainConstructor).toHaveBeenCalled();
    const args = mockCrossChainConstructor.mock.calls[0];
    expect(args).toHaveLength(1);
    expect(args[0]).toBe(mockLogger);

    // FlashLoanStrategy should NOT have been created
    expect(FlashLoanStrategy).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Branch 3: Feature flag OFF → no flash loan warning
  // =========================================================================

  it('should not warn about flash loans when feature flag is OFF', async () => {
    FEATURE_FLAGS.useDestChainFlashLoan = false;

    await startEngine();

    const warnMessages = getLogMessages('warn');

    // Should NOT produce any destination flash loan warning
    const hasFlashLoanWarning = warnMessages.some(
      m => m.includes('Destination flash loan feature enabled'),
    );
    expect(hasFlashLoanWarning).toBe(false);

    // CrossChainStrategy should receive only 1 arg (logger)
    expect(mockCrossChainConstructor).toHaveBeenCalled();
    const args = mockCrossChainConstructor.mock.calls[0];
    expect(args).toHaveLength(1);
  });

  // =========================================================================
  // Branch 4: FlashLoanStrategy init error → fallback without deps
  // =========================================================================

  it('should fallback to CrossChainStrategy without deps when FlashLoanStrategy throws', async () => {
    FEATURE_FLAGS.useDestChainFlashLoan = true;
    process.env.FLASH_LOAN_CONTRACT_ETHEREUM = '0x1234567890123456789012345678901234567890';

    // Make FlashLoanStrategy constructor throw
    (FlashLoanStrategy as jest.Mock<any>).mockImplementation(() => {
      throw new Error('Flash loan init failed');
    });

    await startEngine();

    const warnMessages = getLogMessages('warn');

    // Should log the init failure warning
    expect(warnMessages).toContainEqual(
      expect.stringContaining('Failed to initialize FlashLoanStrategy'),
    );

    // CrossChainStrategy should receive only 1 arg (logger) since flash loan init failed
    expect(mockCrossChainConstructor).toHaveBeenCalled();
    const args = mockCrossChainConstructor.mock.calls[0];
    expect(args).toHaveLength(1);
    expect(args[0]).toBe(mockLogger);
  });

});
