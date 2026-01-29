/**
 * SimulationMetricsCollector Unit Tests
 *
 * TDD tests for Phase 1.1.3: Add Metrics and Dashboards
 *
 * @see implementation_plan_v2.md Task 1.1.3
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createSimulationMetricsCollector,
  SimulationMetricsCollector,
  SimulationMetricsCollectorConfig,
  SimulationMetricsSnapshot,
} from './simulation-metrics-collector';
import type { ISimulationService, SimulationMetrics, SimulationProviderHealth, SimulationProviderType } from './types';
import type { ExecutionStats } from '../../types';

// =============================================================================
// Test Helpers
// =============================================================================

/** Create a mock logger */
const createMockLogger = () => ({
  info: jest.fn<(msg: string, meta?: object) => void>(),
  error: jest.fn<(msg: string, meta?: object) => void>(),
  warn: jest.fn<(msg: string, meta?: object) => void>(),
  debug: jest.fn<(msg: string, meta?: object) => void>(),
});

/** Create a mock performance logger */
const createMockPerfLogger = () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  child: jest.fn(),
  startTimer: jest.fn(),
  endTimer: jest.fn(),
  logEventLatency: jest.fn<(operation: string, latency: number, meta?: object) => void>(),
  logArbitrageOpportunity: jest.fn(),
  logExecutionResult: jest.fn(),
  logHealthCheck: jest.fn<(service: string, status: object) => void>(),
  logMetrics: jest.fn<(metrics: object) => void>(),
});

/**
 * Create mock execution stats.
 *
 * Fix 8.1: Complete mock stats with all ExecutionStats fields.
 * Missing risk management fields would cause TypeScript errors.
 *
 * @see ExecutionStats in types.ts
 * @see createInitialStats() for canonical initialization
 */
const createMockStats = (overrides: Partial<ExecutionStats> = {}): ExecutionStats => ({
  opportunitiesReceived: 100,
  executionAttempts: 80,
  opportunitiesRejected: 10,
  successfulExecutions: 70,
  failedExecutions: 10,
  queueRejects: 5,
  lockConflicts: 2,
  executionTimeouts: 3,
  validationErrors: 1,
  providerReconnections: 2,
  providerHealthCheckFailures: 1,
  simulationsPerformed: 60,
  simulationsSkipped: 20,
  simulationPredictedReverts: 8,
  simulationErrors: 2,
  circuitBreakerTrips: 0,
  circuitBreakerBlocks: 0,
  // Fix 8.1: Add missing risk management fields (Phase 3: Task 3.4.5)
  riskEVRejections: 0,
  riskPositionSizeRejections: 0,
  riskDrawdownBlocks: 0,
  riskCautionCount: 0,
  riskHaltCount: 0,
  ...overrides,
});

/** Create mock simulation service metrics */
const createMockSimulationMetrics = (overrides: Partial<SimulationMetrics> = {}): SimulationMetrics => ({
  totalSimulations: 60,
  successfulSimulations: 55,
  failedSimulations: 5,
  predictedReverts: 8,
  averageLatencyMs: 150,
  fallbackUsed: 3,
  cacheHits: 10,
  lastUpdated: Date.now(),
  ...overrides,
});

/** Create mock provider health */
const createMockProviderHealth = (
  overrides: Partial<SimulationProviderHealth> = {}
): SimulationProviderHealth => ({
  healthy: true,
  lastCheck: Date.now(),
  consecutiveFailures: 0,
  averageLatencyMs: 120,
  successRate: 0.95,
  ...overrides,
});

/** Create a mock simulation service */
const createMockSimulationService = (
  metrics?: SimulationMetrics,
  providerHealth?: Map<SimulationProviderType, SimulationProviderHealth>
): ISimulationService => ({
  initialize: jest.fn(() => Promise.resolve()),
  simulate: jest.fn(() => Promise.resolve({
    success: true,
    wouldRevert: false,
    provider: 'tenderly' as const,
    latencyMs: 100,
  })),
  shouldSimulate: jest.fn(() => true),
  getAggregatedMetrics: jest.fn(() => metrics ?? createMockSimulationMetrics()),
  getProvidersHealth: jest.fn(() => providerHealth ?? new Map<SimulationProviderType, SimulationProviderHealth>([
    ['tenderly', createMockProviderHealth()],
  ])),
  stop: jest.fn(),
});

// =============================================================================
// Tests
// =============================================================================

describe('SimulationMetricsCollector', () => {
  let collector: SimulationMetricsCollector;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockPerfLogger: ReturnType<typeof createMockPerfLogger>;
  let mockStats: ExecutionStats;
  let mockSimulationService: ISimulationService;
  let mockStateManager: { isRunning: jest.Mock };

  beforeEach(() => {
    jest.useFakeTimers();
    mockLogger = createMockLogger();
    mockPerfLogger = createMockPerfLogger();
    mockStats = createMockStats();
    mockSimulationService = createMockSimulationService();
    mockStateManager = { isRunning: jest.fn(() => true) };
  });

  afterEach(() => {
    if (collector) {
      collector.stop();
    }
    jest.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // Initialization Tests
  // ---------------------------------------------------------------------------

  describe('initialization', () => {
    test('should create collector with default interval', () => {
      const config: SimulationMetricsCollectorConfig = {
        logger: mockLogger,
        perfLogger: mockPerfLogger as any,
        getStats: () => mockStats,
        simulationService: mockSimulationService,
        stateManager: mockStateManager as any,
      };

      collector = createSimulationMetricsCollector(config);
      expect(collector).toBeDefined();
      expect(collector.start).toBeDefined();
      expect(collector.stop).toBeDefined();
      expect(collector.getSnapshot).toBeDefined();
    });

    test('should create collector with custom interval', () => {
      const config: SimulationMetricsCollectorConfig = {
        logger: mockLogger,
        perfLogger: mockPerfLogger as any,
        getStats: () => mockStats,
        simulationService: mockSimulationService,
        stateManager: mockStateManager as any,
        collectionIntervalMs: 5000,
      };

      collector = createSimulationMetricsCollector(config);
      expect(collector).toBeDefined();
    });

    test('should log on start', () => {
      const config: SimulationMetricsCollectorConfig = {
        logger: mockLogger,
        perfLogger: mockPerfLogger as any,
        getStats: () => mockStats,
        simulationService: mockSimulationService,
        stateManager: mockStateManager as any,
      };

      collector = createSimulationMetricsCollector(config);
      collector.start();

      expect(mockLogger.info).toHaveBeenCalledWith(
        'SimulationMetricsCollector started',
        expect.objectContaining({ intervalMs: expect.any(Number) })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Metrics Collection Tests
  // ---------------------------------------------------------------------------

  describe('metrics collection', () => {
    test('should collect metrics at specified interval', () => {
      const config: SimulationMetricsCollectorConfig = {
        logger: mockLogger,
        perfLogger: mockPerfLogger as any,
        getStats: () => mockStats,
        simulationService: mockSimulationService,
        stateManager: mockStateManager as any,
        collectionIntervalMs: 1000,
      };

      collector = createSimulationMetricsCollector(config);
      collector.start();

      // Advance timer by one interval
      jest.advanceTimersByTime(1000);

      expect(mockPerfLogger.logMetrics).toHaveBeenCalled();
    });

    test('should skip collection when service is not running', () => {
      mockStateManager.isRunning.mockReturnValue(false);

      const config: SimulationMetricsCollectorConfig = {
        logger: mockLogger,
        perfLogger: mockPerfLogger as any,
        getStats: () => mockStats,
        simulationService: mockSimulationService,
        stateManager: mockStateManager as any,
        collectionIntervalMs: 1000,
      };

      collector = createSimulationMetricsCollector(config);
      collector.start();

      // Advance timer
      jest.advanceTimersByTime(1000);

      expect(mockPerfLogger.logMetrics).not.toHaveBeenCalled();
    });

    test('should collect metrics when simulationService is null', () => {
      const config: SimulationMetricsCollectorConfig = {
        logger: mockLogger,
        perfLogger: mockPerfLogger as any,
        getStats: () => mockStats,
        simulationService: null,
        stateManager: mockStateManager as any,
        collectionIntervalMs: 1000,
      };

      collector = createSimulationMetricsCollector(config);
      collector.start();

      // Advance timer
      jest.advanceTimersByTime(1000);

      // Should still collect execution stats metrics
      expect(mockPerfLogger.logMetrics).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'simulation_metrics',
          simulationsPerformed: 60,
          simulationsSkipped: 20,
          simulationPredictedReverts: 8,
          simulationErrors: 2,
        })
      );
    });

    test('should handle errors during collection gracefully', () => {
      mockSimulationService.getAggregatedMetrics = jest.fn(() => {
        throw new Error('Test error');
      });

      const config: SimulationMetricsCollectorConfig = {
        logger: mockLogger,
        perfLogger: mockPerfLogger as any,
        getStats: () => mockStats,
        simulationService: mockSimulationService,
        stateManager: mockStateManager as any,
        collectionIntervalMs: 1000,
      };

      collector = createSimulationMetricsCollector(config);
      collector.start();

      // Advance timer - should not throw
      jest.advanceTimersByTime(1000);

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Simulation metrics collection error',
        expect.objectContaining({ error: 'Test error' })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Success Rate Calculation Tests
  // ---------------------------------------------------------------------------

  describe('success rate calculation', () => {
    test('should calculate simulation success rate correctly', () => {
      // 55 successful out of 60 total = 0.9167
      const simulationMetrics = createMockSimulationMetrics({
        totalSimulations: 60,
        successfulSimulations: 55,
      });

      mockSimulationService = createMockSimulationService(simulationMetrics);

      const config: SimulationMetricsCollectorConfig = {
        logger: mockLogger,
        perfLogger: mockPerfLogger as any,
        getStats: () => mockStats,
        simulationService: mockSimulationService,
        stateManager: mockStateManager as any,
        collectionIntervalMs: 1000,
      };

      collector = createSimulationMetricsCollector(config);
      collector.start();
      jest.advanceTimersByTime(1000);

      expect(mockPerfLogger.logMetrics).toHaveBeenCalledWith(
        expect.objectContaining({
          simulationSuccessRate: expect.closeTo(0.9167, 2),
        })
      );
    });

    test('should return 0 success rate when no simulations performed', () => {
      const simulationMetrics = createMockSimulationMetrics({
        totalSimulations: 0,
        successfulSimulations: 0,
      });

      mockSimulationService = createMockSimulationService(simulationMetrics);

      const config: SimulationMetricsCollectorConfig = {
        logger: mockLogger,
        perfLogger: mockPerfLogger as any,
        getStats: () => createMockStats({
          simulationsPerformed: 0,
        }),
        simulationService: mockSimulationService,
        stateManager: mockStateManager as any,
        collectionIntervalMs: 1000,
      };

      collector = createSimulationMetricsCollector(config);
      collector.start();
      jest.advanceTimersByTime(1000);

      expect(mockPerfLogger.logMetrics).toHaveBeenCalledWith(
        expect.objectContaining({
          simulationSuccessRate: 0,
        })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Latency Tracking Tests
  // ---------------------------------------------------------------------------

  describe('latency tracking', () => {
    test('should track average simulation latency', () => {
      const simulationMetrics = createMockSimulationMetrics({
        averageLatencyMs: 175,
      });

      mockSimulationService = createMockSimulationService(simulationMetrics);

      const config: SimulationMetricsCollectorConfig = {
        logger: mockLogger,
        perfLogger: mockPerfLogger as any,
        getStats: () => mockStats,
        simulationService: mockSimulationService,
        stateManager: mockStateManager as any,
        collectionIntervalMs: 1000,
      };

      collector = createSimulationMetricsCollector(config);
      collector.start();
      jest.advanceTimersByTime(1000);

      expect(mockPerfLogger.logMetrics).toHaveBeenCalledWith(
        expect.objectContaining({
          simulationAverageLatencyMs: 175,
        })
      );
    });

    test('should log latency to event latency logger', () => {
      const simulationMetrics = createMockSimulationMetrics({
        averageLatencyMs: 200,
      });

      mockSimulationService = createMockSimulationService(simulationMetrics);

      const config: SimulationMetricsCollectorConfig = {
        logger: mockLogger,
        perfLogger: mockPerfLogger as any,
        getStats: () => mockStats,
        simulationService: mockSimulationService,
        stateManager: mockStateManager as any,
        collectionIntervalMs: 1000,
      };

      collector = createSimulationMetricsCollector(config);
      collector.start();
      jest.advanceTimersByTime(1000);

      expect(mockPerfLogger.logEventLatency).toHaveBeenCalledWith(
        'simulation_average',
        200,
        expect.any(Object)
      );
    });

    test('should not log event latency when average latency is zero', () => {
      const simulationMetrics = createMockSimulationMetrics({
        averageLatencyMs: 0,
      });

      mockSimulationService = createMockSimulationService(simulationMetrics);

      const config: SimulationMetricsCollectorConfig = {
        logger: mockLogger,
        perfLogger: mockPerfLogger as any,
        getStats: () => mockStats,
        simulationService: mockSimulationService,
        stateManager: mockStateManager as any,
        collectionIntervalMs: 1000,
      };

      collector = createSimulationMetricsCollector(config);
      collector.start();
      jest.advanceTimersByTime(1000);

      // logEventLatency should not be called for zero latency
      expect(mockPerfLogger.logEventLatency).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Skipped Transactions Tracking Tests
  // ---------------------------------------------------------------------------

  describe('skipped transactions tracking', () => {
    test('should track transactions skipped due to simulation failure', () => {
      const stats = createMockStats({
        simulationPredictedReverts: 12,
      });

      const config: SimulationMetricsCollectorConfig = {
        logger: mockLogger,
        perfLogger: mockPerfLogger as any,
        getStats: () => stats,
        simulationService: mockSimulationService,
        stateManager: mockStateManager as any,
        collectionIntervalMs: 1000,
      };

      collector = createSimulationMetricsCollector(config);
      collector.start();
      jest.advanceTimersByTime(1000);

      expect(mockPerfLogger.logMetrics).toHaveBeenCalledWith(
        expect.objectContaining({
          simulationPredictedReverts: 12,
          transactionsSkippedBySimulation: 12,
        })
      );
    });

    test('should track simulations skipped (below threshold, time-critical)', () => {
      const stats = createMockStats({
        simulationsSkipped: 25,
      });

      const config: SimulationMetricsCollectorConfig = {
        logger: mockLogger,
        perfLogger: mockPerfLogger as any,
        getStats: () => stats,
        simulationService: mockSimulationService,
        stateManager: mockStateManager as any,
        collectionIntervalMs: 1000,
      };

      collector = createSimulationMetricsCollector(config);
      collector.start();
      jest.advanceTimersByTime(1000);

      expect(mockPerfLogger.logMetrics).toHaveBeenCalledWith(
        expect.objectContaining({
          simulationsSkipped: 25,
        })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Provider Health Tests
  // ---------------------------------------------------------------------------

  describe('provider health tracking', () => {
    test('should track provider health status', () => {
      const providerHealth = new Map<SimulationProviderType, SimulationProviderHealth>([
        ['tenderly', createMockProviderHealth({ healthy: true, successRate: 0.98 })],
        ['alchemy', createMockProviderHealth({ healthy: false, successRate: 0.75 })],
      ]);

      mockSimulationService = createMockSimulationService(undefined, providerHealth);

      const config: SimulationMetricsCollectorConfig = {
        logger: mockLogger,
        perfLogger: mockPerfLogger as any,
        getStats: () => mockStats,
        simulationService: mockSimulationService,
        stateManager: mockStateManager as any,
        collectionIntervalMs: 1000,
      };

      collector = createSimulationMetricsCollector(config);
      collector.start();
      jest.advanceTimersByTime(1000);

      expect(mockPerfLogger.logMetrics).toHaveBeenCalledWith(
        expect.objectContaining({
          providerHealthy: expect.objectContaining({
            tenderly: true,
            alchemy: false,
          }),
          providerSuccessRates: expect.objectContaining({
            tenderly: 0.98,
            alchemy: 0.75,
          }),
        })
      );
    });

    test('should log health check for simulation service', () => {
      const config: SimulationMetricsCollectorConfig = {
        logger: mockLogger,
        perfLogger: mockPerfLogger as any,
        getStats: () => mockStats,
        simulationService: mockSimulationService,
        stateManager: mockStateManager as any,
        collectionIntervalMs: 1000,
      };

      collector = createSimulationMetricsCollector(config);
      collector.start();
      jest.advanceTimersByTime(1000);

      expect(mockPerfLogger.logHealthCheck).toHaveBeenCalledWith(
        'simulation-service',
        expect.objectContaining({
          status: 'healthy',
        })
      );
    });

    test('should report not_configured status when no simulation service', () => {
      const config: SimulationMetricsCollectorConfig = {
        logger: mockLogger,
        perfLogger: mockPerfLogger as any,
        getStats: () => mockStats,
        simulationService: null,
        stateManager: mockStateManager as any,
        collectionIntervalMs: 1000,
      };

      collector = createSimulationMetricsCollector(config);
      collector.start();
      jest.advanceTimersByTime(1000);

      expect(mockPerfLogger.logHealthCheck).toHaveBeenCalledWith(
        'simulation-service',
        expect.objectContaining({
          status: 'not_configured',
        })
      );
    });

    test('should report degraded status when all providers unhealthy', () => {
      const providerHealth = new Map<SimulationProviderType, SimulationProviderHealth>([
        ['tenderly', createMockProviderHealth({ healthy: false, successRate: 0.3 })],
        ['alchemy', createMockProviderHealth({ healthy: false, successRate: 0.2 })],
      ]);

      mockSimulationService = createMockSimulationService(undefined, providerHealth);

      const config: SimulationMetricsCollectorConfig = {
        logger: mockLogger,
        perfLogger: mockPerfLogger as any,
        getStats: () => mockStats,
        simulationService: mockSimulationService,
        stateManager: mockStateManager as any,
        collectionIntervalMs: 1000,
      };

      collector = createSimulationMetricsCollector(config);
      collector.start();
      jest.advanceTimersByTime(1000);

      expect(mockPerfLogger.logHealthCheck).toHaveBeenCalledWith(
        'simulation-service',
        expect.objectContaining({
          status: 'degraded',
        })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Snapshot Tests
  // ---------------------------------------------------------------------------

  describe('getSnapshot', () => {
    test('should return current metrics snapshot', () => {
      const simulationMetrics = createMockSimulationMetrics({
        totalSimulations: 100,
        successfulSimulations: 90,
        averageLatencyMs: 150,
      });

      mockSimulationService = createMockSimulationService(simulationMetrics);

      const stats = createMockStats({
        simulationsPerformed: 100,
        simulationsSkipped: 15,
        simulationPredictedReverts: 10,
        simulationErrors: 5,
      });

      const config: SimulationMetricsCollectorConfig = {
        logger: mockLogger,
        perfLogger: mockPerfLogger as any,
        getStats: () => stats,
        simulationService: mockSimulationService,
        stateManager: mockStateManager as any,
      };

      collector = createSimulationMetricsCollector(config);

      const snapshot = collector.getSnapshot();

      expect(snapshot).toEqual(expect.objectContaining({
        simulationsPerformed: 100,
        simulationsSkipped: 15,
        simulationPredictedReverts: 10,
        simulationErrors: 5,
        simulationSuccessRate: 0.9,
        simulationAverageLatencyMs: 150,
        fallbackUsed: expect.any(Number),
        cacheHits: expect.any(Number),
      }));
    });

    test('should return snapshot without simulation service', () => {
      const stats = createMockStats({
        simulationsPerformed: 0,
        simulationsSkipped: 50,
        simulationPredictedReverts: 0,
        simulationErrors: 0,
      });

      const config: SimulationMetricsCollectorConfig = {
        logger: mockLogger,
        perfLogger: mockPerfLogger as any,
        getStats: () => stats,
        simulationService: null,
        stateManager: mockStateManager as any,
      };

      collector = createSimulationMetricsCollector(config);

      const snapshot = collector.getSnapshot();

      expect(snapshot).toEqual(expect.objectContaining({
        simulationsPerformed: 0,
        simulationsSkipped: 50,
        simulationSuccessRate: 0,
        simulationAverageLatencyMs: 0,
      }));
    });
  });

  // ---------------------------------------------------------------------------
  // Start/Restart Tests
  // ---------------------------------------------------------------------------

  describe('start', () => {
    test('should be idempotent - multiple starts should not create multiple intervals', () => {
      const config: SimulationMetricsCollectorConfig = {
        logger: mockLogger,
        perfLogger: mockPerfLogger as any,
        getStats: () => mockStats,
        simulationService: mockSimulationService,
        stateManager: mockStateManager as any,
        collectionIntervalMs: 1000,
      };

      collector = createSimulationMetricsCollector(config);

      // Start multiple times
      collector.start();
      collector.start();
      collector.start();

      // Advance timer
      jest.advanceTimersByTime(1000);

      // Should only have one collection (not 3)
      expect((mockPerfLogger.logMetrics as jest.Mock).mock.calls.length).toBe(1);

      // Only one start log
      const startCalls = (mockLogger.info as jest.Mock).mock.calls.filter(
        (call) => call[0] === 'SimulationMetricsCollector started'
      );
      expect(startCalls.length).toBe(1);
    });

    test('should allow restart after stop', () => {
      const config: SimulationMetricsCollectorConfig = {
        logger: mockLogger,
        perfLogger: mockPerfLogger as any,
        getStats: () => mockStats,
        simulationService: mockSimulationService,
        stateManager: mockStateManager as any,
        collectionIntervalMs: 1000,
      };

      collector = createSimulationMetricsCollector(config);

      // First start
      collector.start();
      jest.advanceTimersByTime(1000);
      const firstCollectionCount = (mockPerfLogger.logMetrics as jest.Mock).mock.calls.length;
      expect(firstCollectionCount).toBe(1);

      // Stop
      collector.stop();
      jest.advanceTimersByTime(2000);
      expect((mockPerfLogger.logMetrics as jest.Mock).mock.calls.length).toBe(firstCollectionCount);

      // Restart
      collector.start();
      jest.advanceTimersByTime(1000);

      // Should have collected again
      expect((mockPerfLogger.logMetrics as jest.Mock).mock.calls.length).toBe(firstCollectionCount + 1);
    });
  });

  // ---------------------------------------------------------------------------
  // Stop Tests
  // ---------------------------------------------------------------------------

  describe('stop', () => {
    test('should stop collecting metrics', () => {
      const config: SimulationMetricsCollectorConfig = {
        logger: mockLogger,
        perfLogger: mockPerfLogger as any,
        getStats: () => mockStats,
        simulationService: mockSimulationService,
        stateManager: mockStateManager as any,
        collectionIntervalMs: 1000,
      };

      collector = createSimulationMetricsCollector(config);
      collector.start();

      // First interval
      jest.advanceTimersByTime(1000);
      const callCount = (mockPerfLogger.logMetrics as jest.Mock).mock.calls.length;

      collector.stop();

      // Advance more time - should not collect more
      jest.advanceTimersByTime(3000);

      expect((mockPerfLogger.logMetrics as jest.Mock).mock.calls.length).toBe(callCount);
      expect(mockLogger.info).toHaveBeenCalledWith('SimulationMetricsCollector stopped');
    });

    test('should be idempotent', () => {
      const config: SimulationMetricsCollectorConfig = {
        logger: mockLogger,
        perfLogger: mockPerfLogger as any,
        getStats: () => mockStats,
        simulationService: mockSimulationService,
        stateManager: mockStateManager as any,
      };

      collector = createSimulationMetricsCollector(config);
      collector.start();

      // Stop multiple times should not throw
      collector.stop();
      collector.stop();
      collector.stop();

      // Only one stop log
      const stopCalls = (mockLogger.info as jest.Mock).mock.calls.filter(
        (call) => call[0] === 'SimulationMetricsCollector stopped'
      );
      expect(stopCalls.length).toBe(1);
    });
  });
});
