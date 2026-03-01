/**
 * Standby Manager Tests
 *
 * Tests for standby-to-active lifecycle transitions including:
 * - Activation idempotency and mutex pattern
 * - Simulation mode toggling during activation
 * - Queue resumption during activation
 * - Provider initialization when needed
 * - Health event publishing to Redis Streams
 * - Error handling and state management
 * - Factory function
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import {
  StandbyManager,
  createStandbyManager,
  type StandbyManagerDeps,
} from '../../../src/services/standby-manager';
import type { Logger, StandbyConfig } from '../../../src/types';
import type { ProviderServiceImpl } from '../../../src/services/provider.service';
import type { QueueServiceImpl } from '../../../src/services/queue.service';
import type { ExecutionStrategyFactory } from '../../../src/strategies/strategy-factory';
import type { BridgeRouterFactory } from '@arbitrage/core/bridge-router';
import type { MevProviderFactory } from '@arbitrage/core/mev-protection';
import type { RedisStreamsClient } from '@arbitrage/core/redis';
import type { ServiceStateManager } from '@arbitrage/core/service-lifecycle';
import type { NonceManager } from '@arbitrage/core';

// =============================================================================
// Mock initialization module
// =============================================================================

jest.mock('../../../src/initialization');

import {
  initializeMevProviders,
  initializeBridgeRouter,
} from '../../../src/initialization';

const mockInitializeMevProviders = initializeMevProviders as jest.MockedFunction<
  typeof initializeMevProviders
>;
const mockInitializeBridgeRouter = initializeBridgeRouter as jest.MockedFunction<
  typeof initializeBridgeRouter
>;

// =============================================================================
// Mock Implementations
// =============================================================================

const createMockLogger = (): Logger => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
});

const createMockStateManager = (isRunning = true): ServiceStateManager =>
  ({
    isRunning: jest.fn().mockReturnValue(isRunning),
    isStopping: jest.fn().mockReturnValue(false),
    isStarting: jest.fn().mockReturnValue(false),
    getState: jest.fn().mockReturnValue(isRunning ? 'running' : 'stopped'),
    // Add other methods as stubs (not used in StandbyManager)
    transitionTo: jest.fn(),
    onTransition: jest.fn(),
  }) as unknown as ServiceStateManager;

const createMockProviderService = (healthyCount = 0): ProviderServiceImpl => {
  const mock: any = {
    getHealthyCount: jest.fn(() => healthyCount),
    initialize: jest.fn(async () => {}),
    initializeWallets: jest.fn(() => {}),
    validateConnectivity: jest.fn(async () => {}),
    startHealthChecks: jest.fn(() => {}),
    // Add other required methods as stubs
    getProvider: jest.fn(() => null),
    getAllProviders: jest.fn(() => []),
    stop: jest.fn(async () => {}),
  };
  return mock;
};

const createMockQueueService = (isManuallyPaused = true): QueueServiceImpl => {
  let paused = isManuallyPaused;
  const mock: any = {
    isPaused: jest.fn(() => paused),
    isManuallyPaused: jest.fn(() => paused),
    resume: jest.fn(() => {
      paused = false;
    }),
    pause: jest.fn(() => {
      paused = true;
    }),
    // Add other required methods as stubs
    enqueue: jest.fn(),
    dequeue: jest.fn(),
    size: jest.fn(() => 0),
    clear: jest.fn(),
  };
  return mock;
};

const createMockStrategyFactory = (): ExecutionStrategyFactory => ({
  setSimulationMode: jest.fn(),
  // Add other required methods as stubs
  createStrategy: jest.fn(),
} as unknown as ExecutionStrategyFactory);

const createMockStreamsClient = (): RedisStreamsClient => {
  const mock: any = {
    xadd: jest.fn(async () => '1234567890-0'),
    xaddWithLimit: jest.fn(async () => '1234567890-0'),
    // Add other required methods as stubs
    xread: jest.fn(async () => []),
    xack: jest.fn(async () => 1),
    disconnect: jest.fn(async () => {}),
  };
  return mock;
};

const createMockNonceManager = (): NonceManager => ({
  start: jest.fn(),
  stop: jest.fn(),
  // Add other required methods as stubs
  getNonce: jest.fn(),
  releaseNonce: jest.fn(),
  getCurrentNonce: jest.fn(),
} as unknown as NonceManager);

const createMockMevProviderFactory = (): MevProviderFactory => ({
  createProviderAsync: jest.fn(),
  getProvider: jest.fn(),
  getProviders: jest.fn(),
  clearProviders: jest.fn(),
} as unknown as MevProviderFactory);

const createMockBridgeRouterFactory = (): BridgeRouterFactory => ({
  getAvailableProtocols: jest.fn(),
  getDefaultRouter: jest.fn(),
  getRouter: jest.fn(),
} as unknown as BridgeRouterFactory);

// =============================================================================
// Test Suite: Basic State and Getters
// =============================================================================

describe('StandbyManager - Basic State and Getters', () => {
  let mockLogger: Logger;
  let mockStateManager: ServiceStateManager;
  let standbyConfig: StandbyConfig;
  let deps: StandbyManagerDeps;

  beforeEach(() => {
    jest.clearAllMocks();

    mockLogger = createMockLogger();
    mockStateManager = createMockStateManager(true);

    standbyConfig = {
      isStandby: true,
      queuePausedOnStart: false,
      regionId: 'us-west-1',
      activationDisablesSimulation: true,
    };

    deps = {
      logger: mockLogger,
      stateManager: mockStateManager,
      standbyConfig,
      initialSimulationMode: true,
      getProviderService: jest.fn<() => ProviderServiceImpl | null>().mockReturnValue(null),
      getQueueService: jest.fn<() => QueueServiceImpl | null>().mockReturnValue(null),
      getStrategyFactory: jest.fn<() => ExecutionStrategyFactory | null>().mockReturnValue(null),
      getStreamsClient: jest.fn<() => RedisStreamsClient | null>().mockReturnValue(null),
      getNonceManager: jest.fn<() => NonceManager | null>().mockReturnValue(null),
      onMevProviderFactoryUpdated: jest.fn(),
      onBridgeRouterFactoryUpdated: jest.fn(),
      onSimulationModeChanged: jest.fn(),
    };
  });

  test('should initialize with correct state', () => {
    const manager = new StandbyManager(deps);

    expect(manager.getIsStandby()).toBe(true);
    expect(manager.getIsActivated()).toBe(false);
    expect(manager.getStandbyConfig()).toEqual(standbyConfig);
  });

  test('should return readonly standby config', () => {
    const manager = new StandbyManager(deps);
    const config = manager.getStandbyConfig();

    // Config should be readonly (TypeScript type check)
    expect(config).toEqual(standbyConfig);
  });

  test('should track activation state', () => {
    const manager = new StandbyManager(deps);

    expect(manager.getIsActivated()).toBe(false);
    // Activation tested in subsequent test suites
  });
});

// =============================================================================
// Test Suite: Activation - Happy Path
// =============================================================================

describe('StandbyManager - Activation Happy Path', () => {
  let mockLogger: Logger;
  let mockStateManager: ServiceStateManager;
  let mockProviderService: ProviderServiceImpl;
  let mockQueueService: QueueServiceImpl;
  let mockStrategyFactory: ExecutionStrategyFactory;
  let mockStreamsClient: RedisStreamsClient;
  let mockNonceManager: NonceManager;
  let standbyConfig: StandbyConfig;
  let deps: StandbyManagerDeps;
  let mockMevFactory: MevProviderFactory;
  let mockBridgeFactory: BridgeRouterFactory;

  beforeEach(() => {
    jest.clearAllMocks();

    mockLogger = createMockLogger();
    mockStateManager = createMockStateManager(true);
    mockProviderService = createMockProviderService(0); // No healthy providers initially
    mockQueueService = createMockQueueService(true); // Manually paused
    mockStrategyFactory = createMockStrategyFactory();
    mockStreamsClient = createMockStreamsClient();
    mockNonceManager = createMockNonceManager();
    mockMevFactory = createMockMevProviderFactory();
    mockBridgeFactory = createMockBridgeRouterFactory();

    standbyConfig = {
      isStandby: true,
      queuePausedOnStart: false,
      regionId: 'us-west-1',
      activationDisablesSimulation: true,
    };

    // Setup initialization mocks
    mockInitializeMevProviders.mockImplementation(async () => ({
      factory: mockMevFactory,
      providersInitialized: 2,
      success: true,
    }));

    mockInitializeBridgeRouter.mockImplementation(() => ({
      factory: mockBridgeFactory,
      protocols: ['stargate', 'across'],
      chains: ['ethereum', 'polygon'],
      success: true,
    }));

    deps = {
      logger: mockLogger,
      stateManager: mockStateManager,
      standbyConfig,
      initialSimulationMode: true,
      getProviderService: jest.fn<() => ProviderServiceImpl | null>().mockReturnValue(mockProviderService),
      getQueueService: jest.fn<() => QueueServiceImpl | null>().mockReturnValue(mockQueueService),
      getStrategyFactory: jest.fn<() => ExecutionStrategyFactory | null>().mockReturnValue(mockStrategyFactory),
      getStreamsClient: jest.fn<() => RedisStreamsClient | null>().mockReturnValue(mockStreamsClient),
      getNonceManager: jest.fn<() => NonceManager | null>().mockReturnValue(mockNonceManager),
      onMevProviderFactoryUpdated: jest.fn(),
      onBridgeRouterFactoryUpdated: jest.fn(),
      onSimulationModeChanged: jest.fn(),
    };
  });

  test('should successfully activate from standby', async () => {
    const manager = new StandbyManager(deps);
    const result = await manager.activate();

    expect(result).toBe(true);
    expect(manager.getIsActivated()).toBe(true);
  });

  test('should disable simulation mode when activationDisablesSimulation is true', async () => {
    const manager = new StandbyManager(deps);
    await manager.activate();

    expect(deps.onSimulationModeChanged).toHaveBeenCalledWith(false);
    expect(mockStrategyFactory.setSimulationMode).toHaveBeenCalledWith(false);
  });

  test('should NOT disable simulation mode when activationDisablesSimulation is false', async () => {
    deps.standbyConfig.activationDisablesSimulation = false;
    const manager = new StandbyManager(deps);
    await manager.activate();

    expect(deps.onSimulationModeChanged).not.toHaveBeenCalled();
    expect(mockStrategyFactory.setSimulationMode).not.toHaveBeenCalled();
  });

  test('should initialize providers when getHealthyCount returns 0', async () => {
    const manager = new StandbyManager(deps);
    await manager.activate();

    expect(mockProviderService.initialize).toHaveBeenCalled();
    expect(mockProviderService.initializeWallets).toHaveBeenCalled();
    expect(mockProviderService.validateConnectivity).toHaveBeenCalled();
    expect(mockProviderService.startHealthChecks).toHaveBeenCalled();
  });

  test('should NOT initialize providers when getHealthyCount returns > 0', async () => {
    // Mock provider service with healthy providers
    const mockProviderWithHealthy = createMockProviderService(3);
    (deps.getProviderService as jest.Mock).mockReturnValue(mockProviderWithHealthy);

    const manager = new StandbyManager(deps);
    await manager.activate();

    expect(mockProviderWithHealthy.initialize).not.toHaveBeenCalled();
  });

  test('should initialize MEV providers during provider initialization', async () => {
    const manager = new StandbyManager(deps);
    await manager.activate();

    expect(mockInitializeMevProviders).toHaveBeenCalledWith(mockProviderService, mockLogger);
    expect(deps.onMevProviderFactoryUpdated).toHaveBeenCalledWith(mockMevFactory);
  });

  test('should initialize bridge router during provider initialization', async () => {
    const manager = new StandbyManager(deps);
    await manager.activate();

    expect(mockInitializeBridgeRouter).toHaveBeenCalledWith(mockProviderService, mockLogger);
    expect(deps.onBridgeRouterFactoryUpdated).toHaveBeenCalledWith(mockBridgeFactory);
  });

  test('should start nonce manager during provider initialization', async () => {
    const manager = new StandbyManager(deps);
    await manager.activate();

    expect(mockNonceManager.start).toHaveBeenCalled();
  });

  test('should resume manually paused queue during activation', async () => {
    const manager = new StandbyManager(deps);
    await manager.activate();

    expect(mockQueueService.resume).toHaveBeenCalled();
  });

  test('should NOT resume queue if not manually paused', async () => {
    const mockQueueNotPaused = createMockQueueService(false);
    (deps.getQueueService as jest.Mock).mockReturnValue(mockQueueNotPaused);

    const manager = new StandbyManager(deps);
    await manager.activate();

    expect(mockQueueNotPaused.resume).not.toHaveBeenCalled();
  });

  test('should publish health event to Redis Streams after activation', async () => {
    const manager = new StandbyManager(deps);
    await manager.activate();

    expect(mockStreamsClient.xaddWithLimit).toHaveBeenCalledWith(
      'stream:health',
      expect.objectContaining({
        name: 'execution-engine',
        service: 'execution-engine',
        status: 'healthy',
        event: 'standby_activated',
        regionId: 'us-west-1',
        simulationMode: false,
        timestamp: expect.any(Number),
      })
    );
  });

  test('should NOT fail if streams client is null', async () => {
    (deps.getStreamsClient as jest.Mock).mockReturnValue(null);

    const manager = new StandbyManager(deps);
    const result = await manager.activate();

    expect(result).toBe(true);
    expect(manager.getIsActivated()).toBe(true);
  });

  test('should log activation progress', async () => {
    const manager = new StandbyManager(deps);
    await manager.activate();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      'ACTIVATING STANDBY EXECUTOR',
      expect.objectContaining({
        previousSimulationMode: true,
        queuePaused: true,
        regionId: 'us-west-1',
      })
    );

    expect(mockLogger.warn).toHaveBeenCalledWith(
      'STANDBY EXECUTOR ACTIVATED SUCCESSFULLY',
      expect.objectContaining({
        simulationMode: false,
        queuePaused: false,
        healthyProviders: 0,
      })
    );
  });
});

// =============================================================================
// Test Suite: Activation - Idempotency
// =============================================================================

describe('StandbyManager - Activation Idempotency', () => {
  let mockLogger: Logger;
  let mockStateManager: ServiceStateManager;
  let standbyConfig: StandbyConfig;
  let deps: StandbyManagerDeps;

  beforeEach(() => {
    jest.clearAllMocks();

    mockLogger = createMockLogger();
    mockStateManager = createMockStateManager(true);

    standbyConfig = {
      isStandby: true,
      queuePausedOnStart: false,
      regionId: 'us-west-1',
      activationDisablesSimulation: true,
    };

    deps = {
      logger: mockLogger,
      stateManager: mockStateManager,
      standbyConfig,
      initialSimulationMode: true,
      getProviderService: jest.fn<() => ProviderServiceImpl | null>().mockReturnValue(createMockProviderService(3)), // Healthy providers
      getQueueService: jest.fn<() => QueueServiceImpl | null>().mockReturnValue(createMockQueueService(false)),
      getStrategyFactory: jest.fn<() => ExecutionStrategyFactory | null>().mockReturnValue(createMockStrategyFactory()),
      getStreamsClient: jest.fn<() => RedisStreamsClient | null>().mockReturnValue(createMockStreamsClient()),
      getNonceManager: jest.fn<() => NonceManager | null>().mockReturnValue(createMockNonceManager()),
      onMevProviderFactoryUpdated: jest.fn(),
      onBridgeRouterFactoryUpdated: jest.fn(),
      onSimulationModeChanged: jest.fn(),
    };
  });

  test('should return true immediately when already activated', async () => {
    const manager = new StandbyManager(deps);

    // First activation
    const result1 = await manager.activate();
    expect(result1).toBe(true);

    // Second activation (should be idempotent)
    const result2 = await manager.activate();
    expect(result2).toBe(true);

    expect(mockLogger.warn).toHaveBeenCalledWith('Executor already activated, skipping');
  });

  test('should NOT perform activation logic twice', async () => {
    const manager = new StandbyManager(deps);

    await manager.activate();
    jest.clearAllMocks(); // Clear mock calls from first activation

    await manager.activate();

    // Should not call any activation logic
    expect(deps.onSimulationModeChanged).not.toHaveBeenCalled();
    expect(deps.onMevProviderFactoryUpdated).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Test Suite: Activation - Concurrency and Mutex
// =============================================================================

describe('StandbyManager - Activation Concurrency', () => {
  let mockLogger: Logger;
  let mockStateManager: ServiceStateManager;
  let mockProviderService: ProviderServiceImpl;
  let standbyConfig: StandbyConfig;
  let deps: StandbyManagerDeps;

  beforeEach(() => {
    jest.clearAllMocks();

    mockLogger = createMockLogger();
    mockStateManager = createMockStateManager(true);
    mockProviderService = createMockProviderService(0);

    standbyConfig = {
      isStandby: true,
      queuePausedOnStart: false,
      regionId: 'us-west-1',
      activationDisablesSimulation: true,
    };

    // Setup initialization mocks
    mockInitializeMevProviders.mockImplementation(async () => ({
      factory: createMockMevProviderFactory(),
      providersInitialized: 2,
      success: true,
    }));

    mockInitializeBridgeRouter.mockImplementation(() => ({
      factory: createMockBridgeRouterFactory(),
      protocols: ['stargate'],
      chains: ['ethereum'],
      success: true,
    }));

    deps = {
      logger: mockLogger,
      stateManager: mockStateManager,
      standbyConfig,
      initialSimulationMode: true,
      getProviderService: jest.fn<() => ProviderServiceImpl | null>().mockReturnValue(mockProviderService),
      getQueueService: jest.fn<() => QueueServiceImpl | null>().mockReturnValue(createMockQueueService(true)),
      getStrategyFactory: jest.fn<() => ExecutionStrategyFactory | null>().mockReturnValue(createMockStrategyFactory()),
      getStreamsClient: jest.fn<() => RedisStreamsClient | null>().mockReturnValue(createMockStreamsClient()),
      getNonceManager: jest.fn<() => NonceManager | null>().mockReturnValue(createMockNonceManager()),
      onMevProviderFactoryUpdated: jest.fn(),
      onBridgeRouterFactoryUpdated: jest.fn(),
      onSimulationModeChanged: jest.fn(),
    };
  });

  test('should handle concurrent activation calls with mutex', async () => {
    const manager = new StandbyManager(deps);

    // Start multiple concurrent activations
    const promise1 = manager.activate();
    const promise2 = manager.activate();
    const promise3 = manager.activate();

    const [result1, result2, result3] = await Promise.all([promise1, promise2, promise3]);

    // All should succeed
    expect(result1).toBe(true);
    expect(result2).toBe(true);
    expect(result3).toBe(true);

    // Provider initialization should be called exactly once
    expect(mockProviderService.initialize).toHaveBeenCalledTimes(1);
  });

  test('should wait for in-progress activation to complete', async () => {
    const manager = new StandbyManager(deps);

    // Mock slow provider initialization
    let resolveInit: (() => void) | undefined;
    const initPromise = new Promise<void>((resolve) => {
      resolveInit = resolve;
    });
    (mockProviderService.initialize as jest.Mock).mockReturnValue(initPromise);

    // Start first activation (will block on provider init)
    const promise1 = manager.activate();

    // Small delay to ensure first activation starts
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Start second activation (should wait for first)
    const promise2 = manager.activate();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Activation already in progress, waiting for completion'
    );

    // Resolve the initialization
    resolveInit!();

    const [result1, result2] = await Promise.all([promise1, promise2]);

    expect(result1).toBe(true);
    expect(result2).toBe(true);
  });

  test('should handle concurrent provider initialization calls', async () => {
    const manager = new StandbyManager(deps);

    // Mock slow provider initialization
    let resolveInit: (() => void) | undefined;
    const initPromise = new Promise<void>((resolve) => {
      resolveInit = resolve;
    });
    (mockProviderService.initialize as jest.Mock).mockReturnValue(initPromise);

    // Start first activation
    const promise1 = manager.activate();

    // Small delay to ensure provider init starts
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Start second activation (provider init already in progress)
    const promise2 = manager.activate();

    // Resolve the initialization
    resolveInit!();

    const [result1, result2] = await Promise.all([promise1, promise2]);

    expect(result1).toBe(true);
    expect(result2).toBe(true);

    // Provider initialization should be called exactly once
    expect(mockProviderService.initialize).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// Test Suite: Activation - Error Handling
// =============================================================================

describe('StandbyManager - Activation Error Handling', () => {
  let mockLogger: Logger;
  let mockStateManager: ServiceStateManager;
  let mockProviderService: ProviderServiceImpl;
  let standbyConfig: StandbyConfig;
  let deps: StandbyManagerDeps;

  beforeEach(() => {
    jest.clearAllMocks();

    mockLogger = createMockLogger();
    mockStateManager = createMockStateManager(true);
    mockProviderService = createMockProviderService(0);

    standbyConfig = {
      isStandby: true,
      queuePausedOnStart: false,
      regionId: 'us-west-1',
      activationDisablesSimulation: true,
    };

    // Setup default successful initialization mocks
    mockInitializeMevProviders.mockImplementation(async () => ({
      factory: createMockMevProviderFactory(),
      providersInitialized: 2,
      success: true,
    }));

    mockInitializeBridgeRouter.mockImplementation(() => ({
      factory: createMockBridgeRouterFactory(),
      protocols: ['stargate'],
      chains: ['ethereum'],
      success: true,
    }));

    deps = {
      logger: mockLogger,
      stateManager: mockStateManager,
      standbyConfig,
      initialSimulationMode: true,
      getProviderService: jest.fn<() => ProviderServiceImpl | null>().mockReturnValue(mockProviderService),
      getQueueService: jest.fn<() => QueueServiceImpl | null>().mockReturnValue(createMockQueueService(true)),
      getStrategyFactory: jest.fn<() => ExecutionStrategyFactory | null>().mockReturnValue(createMockStrategyFactory()),
      getStreamsClient: jest.fn<() => RedisStreamsClient | null>().mockReturnValue(createMockStreamsClient()),
      getNonceManager: jest.fn<() => NonceManager | null>().mockReturnValue(createMockNonceManager()),
      onMevProviderFactoryUpdated: jest.fn(),
      onBridgeRouterFactoryUpdated: jest.fn(),
      onSimulationModeChanged: jest.fn(),
    };
  });

  test('should return false when state manager is not running', async () => {
    mockStateManager = createMockStateManager(false);
    deps.stateManager = mockStateManager;

    const manager = new StandbyManager(deps);
    const result = await manager.activate();

    expect(result).toBe(false);
    expect(mockLogger.error).toHaveBeenCalledWith('Cannot activate - executor not running');
  });

  test('should succeed when provider service is null and no initialization needed', async () => {
    // Provider service is null, but activation doesn't need it (simulation mode already disabled)
    (deps.getProviderService as jest.Mock).mockReturnValue(null);
    deps.standbyConfig.activationDisablesSimulation = false; // Don't try to disable simulation
    deps.initialSimulationMode = false; // Simulation already disabled

    const manager = new StandbyManager(deps);
    const result = await manager.activate();

    // Should succeed because provider initialization is not triggered
    expect(result).toBe(true);
  });

  test('should return false on provider initialization error', async () => {
    (mockProviderService.initialize as jest.Mock).mockImplementationOnce(async () => {
      throw new Error('RPC connection failed');
    });

    const manager = new StandbyManager(deps);
    const result = await manager.activate();

    expect(result).toBe(false);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Failed to activate standby executor',
      expect.objectContaining({
        error: 'RPC connection failed',
      })
    );
  });

  test('should NOT throw on MEV initialization failure (non-critical)', async () => {
    // Reset the provider service to have 0 healthy providers so initialization is triggered
    const mockProviderWithNoHealth = createMockProviderService(0);
    (deps.getProviderService as jest.Mock).mockReturnValue(mockProviderWithNoHealth);

    // Override the MEV initialization to return error
    mockInitializeMevProviders.mockImplementationOnce(async () => ({
      factory: null,
      providersInitialized: 0,
      success: false,
      error: 'MEV provider configuration error',
    }));

    const manager = new StandbyManager(deps);
    const result = await manager.activate();

    // Activation should still succeed
    expect(result).toBe(true);
    expect(deps.onMevProviderFactoryUpdated).toHaveBeenCalledWith(null);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'MEV initialization had issues',
      expect.objectContaining({
        error: 'MEV provider configuration error',
      })
    );
  });

  test('should NOT throw on bridge router initialization failure (non-critical)', async () => {
    // Reset the provider service to have 0 healthy providers so initialization is triggered
    const mockProviderWithNoHealth = createMockProviderService(0);
    (deps.getProviderService as jest.Mock).mockReturnValue(mockProviderWithNoHealth);

    // Override the bridge router initialization to return error
    mockInitializeBridgeRouter.mockImplementationOnce(() => ({
      factory: null,
      protocols: [],
      chains: [],
      success: false,
      error: 'Bridge router initialization failed',
    }));

    const manager = new StandbyManager(deps);
    const result = await manager.activate();

    // Activation should still succeed
    expect(result).toBe(true);
    expect(deps.onBridgeRouterFactoryUpdated).toHaveBeenCalledWith(null);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Bridge router initialization had issues',
      expect.objectContaining({
        error: 'Bridge router initialization failed',
      })
    );
  });

  test('should handle unexpected errors gracefully', async () => {
    // Simulate unexpected error in activation logic
    (mockProviderService.initialize as jest.Mock).mockImplementation(() => {
      throw new Error('Unexpected error');
    });

    const manager = new StandbyManager(deps);
    const result = await manager.activate();

    expect(result).toBe(false);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Failed to activate standby executor',
      expect.objectContaining({
        error: 'Unexpected error',
      })
    );
  });

  test('should handle non-Error exceptions', async () => {
    // Simulate non-Error exception
    (mockProviderService.initialize as jest.Mock).mockImplementation(() => {
      throw 'String error';
    });

    const manager = new StandbyManager(deps);
    const result = await manager.activate();

    expect(result).toBe(false);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Failed to activate standby executor',
      expect.objectContaining({
        error: 'String error',
      })
    );
  });

  test('should succeed even if nonce manager is null (graceful degradation)', async () => {
    // Reset the provider service to have 0 healthy providers so initialization is triggered
    const mockProviderWithNoHealth = createMockProviderService(0);
    (deps.getProviderService as jest.Mock).mockReturnValue(mockProviderWithNoHealth);
    (deps.getNonceManager as jest.Mock).mockReturnValue(null);

    const manager = new StandbyManager(deps);
    const result = await manager.activate();

    // Should still succeed (nonce manager is optional)
    expect(result).toBe(true);
  });
});

// =============================================================================
// Test Suite: Activation - Simulation Mode Behavior
// =============================================================================

describe('StandbyManager - Simulation Mode Behavior', () => {
  let mockLogger: Logger;
  let mockStateManager: ServiceStateManager;
  let mockStrategyFactory: ExecutionStrategyFactory;
  let standbyConfig: StandbyConfig;
  let deps: StandbyManagerDeps;

  beforeEach(() => {
    jest.clearAllMocks();

    mockLogger = createMockLogger();
    mockStateManager = createMockStateManager(true);
    mockStrategyFactory = createMockStrategyFactory();

    standbyConfig = {
      isStandby: true,
      queuePausedOnStart: false,
      regionId: 'us-west-1',
      activationDisablesSimulation: true,
    };

    deps = {
      logger: mockLogger,
      stateManager: mockStateManager,
      standbyConfig,
      initialSimulationMode: true,
      getProviderService: jest.fn<() => ProviderServiceImpl | null>().mockReturnValue(createMockProviderService(3)), // Healthy providers exist
      getQueueService: jest.fn<() => QueueServiceImpl | null>().mockReturnValue(createMockQueueService(false)),
      getStrategyFactory: jest.fn<() => ExecutionStrategyFactory | null>().mockReturnValue(mockStrategyFactory),
      getStreamsClient: jest.fn<() => RedisStreamsClient | null>().mockReturnValue(createMockStreamsClient()),
      getNonceManager: jest.fn<() => NonceManager | null>().mockReturnValue(createMockNonceManager()),
      onMevProviderFactoryUpdated: jest.fn(),
      onBridgeRouterFactoryUpdated: jest.fn(),
      onSimulationModeChanged: jest.fn(),
    };
  });

  test('should disable simulation mode when initially enabled', async () => {
    deps.initialSimulationMode = true;

    const manager = new StandbyManager(deps);
    await manager.activate();

    expect(deps.onSimulationModeChanged).toHaveBeenCalledWith(false);
    expect(mockStrategyFactory.setSimulationMode).toHaveBeenCalledWith(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'SIMULATION MODE DISABLED - Real transactions will now execute'
    );
  });

  test('should NOT change simulation mode when initially disabled', async () => {
    deps.initialSimulationMode = false;
    deps.standbyConfig.activationDisablesSimulation = true;

    const manager = new StandbyManager(deps);
    await manager.activate();

    // Should not call callbacks since already disabled
    expect(deps.onSimulationModeChanged).not.toHaveBeenCalled();
    expect(mockStrategyFactory.setSimulationMode).not.toHaveBeenCalled();
  });

  test('should keep simulation mode when activationDisablesSimulation is false', async () => {
    deps.initialSimulationMode = true;
    deps.standbyConfig.activationDisablesSimulation = false;

    const manager = new StandbyManager(deps);
    await manager.activate();

    expect(deps.onSimulationModeChanged).not.toHaveBeenCalled();
    expect(mockStrategyFactory.setSimulationMode).not.toHaveBeenCalled();
  });

  test('should handle null strategy factory gracefully', async () => {
    (deps.getStrategyFactory as jest.Mock).mockReturnValue(null);

    const manager = new StandbyManager(deps);
    const result = await manager.activate();

    // Should still succeed (strategy factory setSimulationMode is optional)
    expect(result).toBe(true);
    expect(deps.onSimulationModeChanged).toHaveBeenCalledWith(false);
  });
});

// =============================================================================
// Test Suite: Factory Function
// =============================================================================

describe('StandbyManager - Factory Function', () => {
  let mockLogger: Logger;
  let mockStateManager: ServiceStateManager;
  let standbyConfig: StandbyConfig;
  let deps: StandbyManagerDeps;

  beforeEach(() => {
    jest.clearAllMocks();

    mockLogger = createMockLogger();
    mockStateManager = createMockStateManager(true);

    standbyConfig = {
      isStandby: true,
      queuePausedOnStart: false,
      regionId: 'us-west-1',
      activationDisablesSimulation: true,
    };

    deps = {
      logger: mockLogger,
      stateManager: mockStateManager,
      standbyConfig,
      initialSimulationMode: true,
      getProviderService: jest.fn<() => ProviderServiceImpl | null>().mockReturnValue(null),
      getQueueService: jest.fn<() => QueueServiceImpl | null>().mockReturnValue(null),
      getStrategyFactory: jest.fn<() => ExecutionStrategyFactory | null>().mockReturnValue(null),
      getStreamsClient: jest.fn<() => RedisStreamsClient | null>().mockReturnValue(null),
      getNonceManager: jest.fn<() => NonceManager | null>().mockReturnValue(null),
      onMevProviderFactoryUpdated: jest.fn(),
      onBridgeRouterFactoryUpdated: jest.fn(),
      onSimulationModeChanged: jest.fn(),
    };
  });

  test('should create StandbyManager instance via factory function', () => {
    const manager = createStandbyManager(deps);

    expect(manager).toBeInstanceOf(StandbyManager);
    expect(manager.getIsStandby()).toBe(true);
    expect(manager.getIsActivated()).toBe(false);
  });

  test('should pass all dependencies correctly', () => {
    const manager = createStandbyManager(deps);

    expect(manager.getStandbyConfig()).toEqual(standbyConfig);
  });
});
