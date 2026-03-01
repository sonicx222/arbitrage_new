/**
 * Health Monitoring Manager Tests
 *
 * Tests for the HealthMonitoringManager which handles:
 * - Health check publishing (30s interval)
 * - Gas baseline cleanup (memory management)
 * - Stale pending message cleanup
 * - Lock conflict tracker cleanup
 *
 * @see services/execution-engine/src/services/health-monitoring-manager.ts
 */

// =============================================================================
// Mocks — prevent deep import chain through types.ts → @arbitrage/config → service-config.ts
// The chain: health-monitoring-manager → ../types → @arbitrage/config → PANCAKESWAP_V3_FACTORIES
// =============================================================================

jest.mock('ethers', () => ({
  __esModule: true,
  ethers: {
    isAddress: jest.fn().mockReturnValue(true),
    ZeroAddress: '0x0000000000000000000000000000000000000000',
  },
}));

jest.mock('@arbitrage/config', () => ({
  __esModule: true,
  CHAINS: {},
}));

jest.mock('@arbitrage/types', () => ({
  __esModule: true,
  TimeoutError: class TimeoutError extends Error {
    constructor(msg: string) { super(msg); this.name = 'TimeoutError'; }
  },
  ExecutionResult: {},
  createErrorResult: jest.fn(),
  createSuccessResult: jest.fn(),
  createSkippedResult: jest.fn(),
  extractErrorCode: jest.fn(),
  BaseHealth: {},
  RedisStreams: {
    PRICE_UPDATES: 'stream:price-updates',
    SWAP_EVENTS: 'stream:swap-events',
    OPPORTUNITIES: 'stream:opportunities',
    WHALE_ALERTS: 'stream:whale-alerts',
    SERVICE_HEALTH: 'stream:service-health',
    SERVICE_EVENTS: 'stream:service-events',
    COORDINATOR_EVENTS: 'stream:coordinator-events',
    HEALTH: 'stream:health',
    HEALTH_ALERTS: 'stream:health-alerts',
    EXECUTION_REQUESTS: 'stream:execution-requests',
    EXECUTION_RESULTS: 'stream:execution-results',
    PENDING_OPPORTUNITIES: 'stream:pending-opportunities',
    VOLUME_AGGREGATES: 'stream:volume-aggregates',
    CIRCUIT_BREAKER: 'stream:circuit-breaker',
    SYSTEM_FAILOVER: 'stream:system-failover',
    SYSTEM_COMMANDS: 'stream:system-commands',
    DEAD_LETTER_QUEUE: 'stream:dead-letter-queue',
    DLQ_ALERTS: 'stream:dlq-alerts',
    FORWARDING_DLQ: 'stream:forwarding-dlq',
  },
}));

jest.mock('@arbitrage/core', () => ({
  __esModule: true,
  RedisStreamsClient: class MockRedisStreamsClient {
    static STREAMS: Record<string, string> = { HEALTH: 'stream:health' };
  },
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  clearIntervalSafe: (interval: NodeJS.Timeout | null): null => {
    if (interval) clearInterval(interval);
    return null;
  },
  createPinoLogger: jest.fn(),
}));

import {
  HealthMonitoringManager,
  createHealthMonitoringManager,
  type HealthMonitoringDependencies,
  type GasBaselineEntry,
} from '../../../src/services/health-monitoring-manager';

// =============================================================================
// Mock Factories
// =============================================================================

function createMockLogger() {
  return {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  };
}

function createMockPerfLogger() {
  return {
    logHealthCheck: jest.fn(),
    logExecution: jest.fn(),
    logMetric: jest.fn(),
  };
}

function createMockStateManager(isRunning = true) {
  return {
    isRunning: jest.fn().mockReturnValue(isRunning),
    getState: jest.fn().mockReturnValue('running'),
    setState: jest.fn(),
    isShuttingDown: jest.fn().mockReturnValue(false),
    setShuttingDown: jest.fn(),
  };
}

function createMockLockConflictTracker() {
  return {
    cleanup: jest.fn(),
    trackConflict: jest.fn(),
    getConflicts: jest.fn().mockReturnValue([]),
    reset: jest.fn(),
  };
}

function createMockStreamsClient() {
  return {
    xadd: jest.fn().mockResolvedValue('1-0'),
    xaddWithLimit: jest.fn().mockResolvedValue('1-0'),
  };
}

function createMockRedisClient() {
  return {
    updateServiceHealth: jest.fn().mockResolvedValue(undefined),
  };
}

function createMockQueueService() {
  return {
    size: jest.fn().mockReturnValue(5),
    isPaused: jest.fn().mockReturnValue(false),
  };
}

function createMockOpportunityConsumer() {
  return {
    getActiveCount: jest.fn().mockReturnValue(2),
    getPendingCount: jest.fn().mockReturnValue(3),
    cleanupStalePendingMessages: jest.fn().mockResolvedValue(0),
  };
}

function createMockDeps(overrides?: Partial<HealthMonitoringDependencies>): HealthMonitoringDependencies {
  const mockStreamsClient = createMockStreamsClient();
  const mockRedisClient = createMockRedisClient();
  const mockQueueService = createMockQueueService();
  const mockConsumer = createMockOpportunityConsumer();

  return {
    logger: createMockLogger(),
    perfLogger: createMockPerfLogger() as any,
    stateManager: createMockStateManager() as any,
    stats: {
      opportunitiesReceived: 0,
      executionAttempts: 0,
      opportunitiesRejected: 0,
      successfulExecutions: 0,
      failedExecutions: 0,
      queueRejects: 0,
      lockConflicts: 0,
      staleLockRecoveries: 0,
      executionTimeouts: 0,
      validationErrors: 0,
      providerReconnections: 0,
      providerHealthCheckFailures: 0,
      simulationsPerformed: 0,
      simulationsSkipped: 0,
      simulationPredictedReverts: 0,
      simulationProfitabilityRejections: 0,
      simulationErrors: 0,
      circuitBreakerTrips: 0,
      circuitBreakerBlocks: 0,
      riskEVRejections: 0,
      riskPositionSizeRejections: 0,
      riskDrawdownBlocks: 0,
      riskCautionCount: 0,
      riskHaltCount: 0,
    },
    gasBaselines: new Map(),
    lockConflictTracker: createMockLockConflictTracker() as any,
    consumerConfig: undefined,
    getStreamsClient: jest.fn().mockReturnValue(mockStreamsClient),
    getRedis: jest.fn().mockReturnValue(mockRedisClient),
    getQueueService: jest.fn().mockReturnValue(mockQueueService),
    getOpportunityConsumer: jest.fn().mockReturnValue(mockConsumer),
    getSimulationMetricsSnapshot: jest.fn().mockReturnValue(null),
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('HealthMonitoringManager', () => {
  let manager: HealthMonitoringManager;
  let deps: HealthMonitoringDependencies;

  beforeEach(() => {
    jest.useFakeTimers();
    deps = createMockDeps();
  });

  afterEach(() => {
    manager?.stop();
    jest.useRealTimers();
  });

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('should create an instance with dependencies', () => {
      manager = new HealthMonitoringManager(deps);
      expect(manager).toBeDefined();
    });
  });

  // =========================================================================
  // start
  // =========================================================================

  describe('start', () => {
    it('should set up health monitoring interval', () => {
      manager = new HealthMonitoringManager(deps);
      manager.start();

      expect(deps.logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('started'),
      );
    });

    it('should publish health data on interval tick', async () => {
      const mockStreamsClient = createMockStreamsClient();
      deps = createMockDeps({
        getStreamsClient: jest.fn().mockReturnValue(mockStreamsClient),
      });
      manager = new HealthMonitoringManager(deps);
      manager.start();

      // Advance past one health check interval (30s)
      jest.advanceTimersByTime(30001);

      // Allow async operations to complete
      await Promise.resolve();
      await Promise.resolve();

      expect(mockStreamsClient.xaddWithLimit).toHaveBeenCalled();
    });

    it('should clean up gas baselines on interval tick', () => {
      // Add some gas baselines
      const gasBaselines = new Map<string, GasBaselineEntry[]>();
      gasBaselines.set('ethereum', [
        { price: 100n, timestamp: Date.now() - 10 * 60 * 1000 }, // 10 min old - expired
        { price: 200n, timestamp: Date.now() },                    // fresh
      ]);

      deps = createMockDeps({ gasBaselines });
      manager = new HealthMonitoringManager(deps);
      manager.start();

      // Advance past one health check interval
      jest.advanceTimersByTime(30001);

      // The old entry should be cleaned up
      const ethBaselines = gasBaselines.get('ethereum')!;
      expect(ethBaselines.length).toBe(1);
      expect(ethBaselines[0].price).toBe(200n);
    });

    it('should invoke lock conflict tracker cleanup on interval', () => {
      manager = new HealthMonitoringManager(deps);
      manager.start();

      jest.advanceTimersByTime(30001);

      expect(deps.lockConflictTracker.cleanup).toHaveBeenCalled();
    });

    it('should log health check via performance logger on interval', async () => {
      manager = new HealthMonitoringManager(deps);
      manager.start();

      jest.advanceTimersByTime(30001);
      await Promise.resolve();
      await Promise.resolve();

      expect(deps.perfLogger.logHealthCheck).toHaveBeenCalledWith(
        'execution-engine',
        expect.objectContaining({ name: 'execution-engine' }),
      );
    });
  });

  // =========================================================================
  // stop
  // =========================================================================

  describe('stop', () => {
    it('should clear intervals and log stop message', () => {
      manager = new HealthMonitoringManager(deps);
      manager.start();
      manager.stop();

      expect(deps.logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('stopped'),
      );
    });

    it('should prevent further interval ticks after stop', () => {
      const mockStreamsClient = createMockStreamsClient();
      deps = createMockDeps({
        getStreamsClient: jest.fn().mockReturnValue(mockStreamsClient),
      });
      manager = new HealthMonitoringManager(deps);
      manager.start();
      manager.stop();

      // Clear previous calls
      mockStreamsClient.xaddWithLimit.mockClear();

      // Advance well past several intervals
      jest.advanceTimersByTime(120000);

      expect(mockStreamsClient.xaddWithLimit).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Gas baseline cleanup
  // =========================================================================

  describe('gas baseline cleanup', () => {
    it('should remove entries older than 5 minutes', () => {
      const now = Date.now();
      const gasBaselines = new Map<string, GasBaselineEntry[]>();
      gasBaselines.set('bsc', [
        { price: 50n, timestamp: now - 6 * 60 * 1000 },  // 6 min old - expired
        { price: 60n, timestamp: now - 4 * 60 * 1000 },  // 4 min old - valid
        { price: 70n, timestamp: now },                    // fresh
      ]);

      deps = createMockDeps({ gasBaselines });
      manager = new HealthMonitoringManager(deps);
      manager.start();

      jest.advanceTimersByTime(30001);

      const bscBaselines = gasBaselines.get('bsc')!;
      expect(bscBaselines.length).toBe(2);
    });

    it('should limit entries to 100 per chain', () => {
      const now = Date.now();
      const gasBaselines = new Map<string, GasBaselineEntry[]>();
      const manyEntries: GasBaselineEntry[] = [];
      for (let i = 0; i < 150; i++) {
        manyEntries.push({ price: BigInt(i), timestamp: now });
      }
      gasBaselines.set('polygon', manyEntries);

      deps = createMockDeps({ gasBaselines });
      manager = new HealthMonitoringManager(deps);
      manager.start();

      jest.advanceTimersByTime(30001);

      expect(gasBaselines.get('polygon')!.length).toBe(100);
    });

    it('should skip empty histories', () => {
      const gasBaselines = new Map<string, GasBaselineEntry[]>();
      gasBaselines.set('arbitrum', []);

      deps = createMockDeps({ gasBaselines });
      manager = new HealthMonitoringManager(deps);
      manager.start();

      // Should not throw
      jest.advanceTimersByTime(30001);

      expect(gasBaselines.get('arbitrum')!.length).toBe(0);
    });
  });

  // =========================================================================
  // Health check error handling
  // =========================================================================

  describe('error handling during health check', () => {
    it('should log error if health monitoring fails', async () => {
      const mockStreamsClient = createMockStreamsClient();
      mockStreamsClient.xaddWithLimit.mockRejectedValue(new Error('Redis connection lost'));
      deps = createMockDeps({
        getStreamsClient: jest.fn().mockReturnValue(mockStreamsClient),
      });
      manager = new HealthMonitoringManager(deps);
      manager.start();

      jest.advanceTimersByTime(30001);
      await Promise.resolve();
      await Promise.resolve();

      expect(deps.logger.error).toHaveBeenCalledWith(
        expect.stringContaining('health monitoring failed'),
        expect.any(Object),
      );
    });

    it('should handle null streams client gracefully', async () => {
      deps = createMockDeps({
        getStreamsClient: jest.fn().mockReturnValue(null),
      });
      manager = new HealthMonitoringManager(deps);
      manager.start();

      jest.advanceTimersByTime(30001);
      await Promise.resolve();

      // Should not throw - streams publish is skipped
      expect(deps.logger.error).not.toHaveBeenCalled();
    });

    it('should handle null redis client gracefully', async () => {
      deps = createMockDeps({
        getRedis: jest.fn().mockReturnValue(null),
      });
      manager = new HealthMonitoringManager(deps);
      manager.start();

      jest.advanceTimersByTime(30001);
      await Promise.resolve();

      // Should not throw - redis health update is skipped
      expect(deps.logger.error).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Stale pending cleanup
  // =========================================================================

  describe('stale pending cleanup interval', () => {
    it('should be disabled when cleanup interval is 0', () => {
      deps = createMockDeps({
        consumerConfig: { stalePendingCleanupIntervalMs: 0 } as any,
      });
      manager = new HealthMonitoringManager(deps);
      manager.start();

      expect(deps.logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('cleanup disabled'),
      );
    });
  });

  // =========================================================================
  // M2 FIX: Simulation sub-status in health report
  // =========================================================================

  describe('simulation status consolidation (M2)', () => {
    it('should include simulationStatus=not_configured when no metrics snapshot', async () => {
      const mockStreamsClient = createMockStreamsClient();
      deps = createMockDeps({
        getStreamsClient: jest.fn().mockReturnValue(mockStreamsClient),
        getSimulationMetricsSnapshot: jest.fn().mockReturnValue(null),
      });
      manager = new HealthMonitoringManager(deps);
      manager.start();

      jest.advanceTimersByTime(30001);
      await Promise.resolve();
      await Promise.resolve();

      expect(mockStreamsClient.xaddWithLimit).toHaveBeenCalledWith(
        'stream:health',
        expect.objectContaining({ simulationStatus: 'not_configured' }),
      );
    });

    it('should include simulationStatus=healthy when providers are healthy', async () => {
      const mockStreamsClient = createMockStreamsClient();
      deps = createMockDeps({
        getStreamsClient: jest.fn().mockReturnValue(mockStreamsClient),
        getSimulationMetricsSnapshot: jest.fn().mockReturnValue({
          simulationsPerformed: 10,
          simulationSuccessRate: 0.9,
          providerHealth: {
            tenderly: { healthy: true, successRate: 0.9, averageLatencyMs: 200 },
          },
          timestamp: Date.now(),
        }),
      });
      manager = new HealthMonitoringManager(deps);
      manager.start();

      jest.advanceTimersByTime(30001);
      await Promise.resolve();
      await Promise.resolve();

      expect(mockStreamsClient.xaddWithLimit).toHaveBeenCalledWith(
        'stream:health',
        expect.objectContaining({ simulationStatus: 'healthy' }),
      );
    });

    it('should include simulationStatus=degraded when all providers unhealthy', async () => {
      const mockStreamsClient = createMockStreamsClient();
      deps = createMockDeps({
        getStreamsClient: jest.fn().mockReturnValue(mockStreamsClient),
        getSimulationMetricsSnapshot: jest.fn().mockReturnValue({
          simulationsPerformed: 5,
          simulationSuccessRate: 0,
          providerHealth: {
            tenderly: { healthy: false, successRate: 0, averageLatencyMs: 0 },
          },
          timestamp: Date.now(),
        }),
      });
      manager = new HealthMonitoringManager(deps);
      manager.start();

      jest.advanceTimersByTime(30001);
      await Promise.resolve();
      await Promise.resolve();

      expect(mockStreamsClient.xaddWithLimit).toHaveBeenCalledWith(
        'stream:health',
        expect.objectContaining({ simulationStatus: 'degraded' }),
      );
    });
  });

  // =========================================================================
  // createHealthMonitoringManager factory
  // =========================================================================

  describe('createHealthMonitoringManager', () => {
    it('should create a HealthMonitoringManager instance', () => {
      const instance = createHealthMonitoringManager(deps);
      expect(instance).toBeInstanceOf(HealthMonitoringManager);
    });
  });
});
