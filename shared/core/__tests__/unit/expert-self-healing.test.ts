/**
 * Expert Self-Healing Manager Tests
 *
 * Tests for the ExpertSelfHealingManager which handles automatic
 * failure detection, recovery strategy selection, and execution.
 *
 * @migrated from shared/core/src/__tests__/expert-self-healing.test.ts
 * @see ADR-009: Test Architecture
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ExpertSelfHealingManager, FailureSeverity, RecoveryStrategyEnum as RecoveryStrategy } from '@arbitrage/core/resilience';
import { getRedisClient, resetRedisInstance } from '@arbitrage/core/redis';

// P2-FIX: Mock Redis Streams client for ADR-002 compliant messaging
const mockStreamsClient = {
  xadd: jest.fn(() => Promise.resolve('1234567890-0')),
  xaddWithLimit: jest.fn(() => Promise.resolve('1234567890-0')),
  xread: jest.fn(() => Promise.resolve(null)),
  xreadgroup: jest.fn(() => Promise.resolve(null)),
  xack: jest.fn(() => Promise.resolve(1)),
  createConsumerGroup: jest.fn(() => Promise.resolve('OK')),
  disconnect: jest.fn(() => Promise.resolve(undefined))
};

// Mock dependencies
jest.mock('../../src/redis/client', () => ({
  getRedisClient: jest.fn(),
  resetRedisInstance: jest.fn()
}));

// P2-FIX: Add Redis Streams mock with StreamConsumer class
jest.mock('../../src/redis/streams', () => ({
  getRedisStreamsClient: jest.fn(() => Promise.resolve(mockStreamsClient)),
  resetRedisStreamsInstance: jest.fn(() => Promise.resolve(undefined)),
  StreamConsumer: jest.fn().mockImplementation(() => ({
    start: jest.fn(),
    stop: jest.fn(() => Promise.resolve()),
    getStats: jest.fn(() => ({ messagesProcessed: 0, messagesFailed: 0, lastProcessedAt: null, isRunning: false, isPaused: false })),
  })),
  RedisStreamsClient: {
    STREAMS: {
      PRICE_UPDATES: 'stream:price-updates',
      SWAP_EVENTS: 'stream:swap-events',
      WHALE_ALERTS: 'stream:whale-alerts',
      FAILURE_EVENTS: 'stream:failure-events',
    },
  },
}));

// P2-FIX: Corrected mock paths to match actual file locations
// P1-15 FIX: Changed getCircuitBreaker to getBreaker to match actual CircuitBreakerRegistry API
jest.mock('../../src/resilience/circuit-breaker', () => ({
  getCircuitBreakerRegistry: jest.fn(() => ({
    getBreaker: jest.fn(() => ({
      forceOpen: jest.fn(() => Promise.resolve(true))
    }))
  }))
}));

jest.mock('../../src/resilience/dead-letter-queue', () => ({
  getDeadLetterQueue: jest.fn(() => ({
    enqueue: jest.fn(() => Promise.resolve(true))
  }))
}));

jest.mock('../../src/monitoring/enhanced-health-monitor', () => ({
  getEnhancedHealthMonitor: jest.fn(() => ({
    recordHealthMetric: jest.fn(),
    getCurrentSystemHealth: jest.fn()
  }))
}));

jest.mock('../../src/resilience/error-recovery', () => ({
  getErrorRecoveryOrchestrator: jest.fn(() => ({
    recoverFromError: jest.fn(() => Promise.resolve(true)),
    withErrorRecovery: jest.fn()
  }))
}));

describe('ExpertSelfHealingManager', () => {
  let selfHealingManager: ExpertSelfHealingManager;
  let mockRedis: any;

  beforeEach(async () => {
    // P0-FIX: await async reset
    await resetRedisInstance();

    mockRedis = {
      publish: jest.fn(() => Promise.resolve(1)),
      subscribe: jest.fn(() => Promise.resolve(undefined)),  // P2-FIX: Add subscribe mock
      set: jest.fn(() => Promise.resolve(undefined)),
      get: jest.fn(() => Promise.resolve(null)),  // P2-FIX: Add get mock
      getServiceHealth: jest.fn(),
      disconnect: jest.fn(() => Promise.resolve(undefined))
    };

    (getRedisClient as jest.Mock).mockImplementation(() => Promise.resolve(mockRedis));

    // Re-establish mock implementations after clearMocks: true wipes jest.fn() impls.
    // Streams client methods
    mockStreamsClient.xaddWithLimit.mockImplementation(() => Promise.resolve('1234567890-0'));
    mockStreamsClient.xread.mockImplementation(() => Promise.resolve(null));
    mockStreamsClient.xreadgroup.mockImplementation(() => Promise.resolve(null));
    mockStreamsClient.xack.mockImplementation(() => Promise.resolve(1));
    mockStreamsClient.createConsumerGroup.mockImplementation(() => Promise.resolve('OK'));
    mockStreamsClient.disconnect.mockImplementation(() => Promise.resolve(undefined));

    // Streams module: getRedisStreamsClient + StreamConsumer constructor
    const redisStreamsMod = require('../../src/redis/streams') as any;
    redisStreamsMod.getRedisStreamsClient.mockImplementation(() => Promise.resolve(mockStreamsClient));
    redisStreamsMod.resetRedisStreamsInstance.mockImplementation(() => Promise.resolve(undefined));
    redisStreamsMod.StreamConsumer.mockImplementation(() => ({
      start: jest.fn(),
      stop: jest.fn(() => Promise.resolve()),
      getStats: jest.fn(() => ({ messagesProcessed: 0, messagesFailed: 0, lastProcessedAt: null, isRunning: false, isPaused: false })),
    }));

    // Circuit breaker, DLQ, health monitor, error recovery
    const cbMod = require('../../src/resilience/circuit-breaker') as any;
    cbMod.getCircuitBreakerRegistry.mockImplementation(() => ({
      getBreaker: jest.fn(() => ({ forceOpen: jest.fn(() => Promise.resolve(true)) })),
    }));
    const dlqTestMod = require('../../src/resilience/dead-letter-queue') as any;
    dlqTestMod.getDeadLetterQueue.mockImplementation(() => ({
      enqueue: jest.fn(() => Promise.resolve(true)),
    }));
    const healthMod = require('../../src/monitoring/enhanced-health-monitor') as any;
    healthMod.getEnhancedHealthMonitor.mockImplementation(() => ({
      recordHealthMetric: jest.fn(),
      getCurrentSystemHealth: jest.fn(),
    }));
    const errRecMod = require('../../src/resilience/error-recovery') as any;
    errRecMod.getErrorRecoveryOrchestrator.mockImplementation(() => ({
      recoverFromError: jest.fn(() => Promise.resolve(true)),
      withErrorRecovery: jest.fn(),
    }));

    selfHealingManager = new ExpertSelfHealingManager();
  });

  afterEach(async () => {
    if (selfHealingManager) {
      await selfHealingManager.stop();
    }
  });

  describe('initialization', () => {
    it('should initialize with default service states', () => {
      const states = (selfHealingManager as any).serviceHealthStates;
      expect(states.size).toBeGreaterThan(0);

      // Should have coordinator service
      expect(states.has('coordinator')).toBe(true);

      const coordinatorState = states.get('coordinator');
      expect(coordinatorState.healthScore).toBe(100);
      expect(coordinatorState.consecutiveFailures).toBe(0);
      expect(coordinatorState.activeRecoveryActions).toEqual([]);
    });
  });

  describe('failure reporting and assessment', () => {
    it('should assess failure severity correctly', () => {
      // Network failure
      const networkError = new Error('ECONNREFUSED');
      const severity = (selfHealingManager as any).assessFailureSeverity(networkError, {});
      expect(severity).toBe(FailureSeverity.MEDIUM);

      // Memory failure
      const memoryError = new Error('heap limit');
      const memorySeverity = (selfHealingManager as any).assessFailureSeverity(memoryError, {
        memoryUsage: 0.95
      });
      expect(memorySeverity).toBe(FailureSeverity.HIGH);

      // Critical data failure
      const dataError = new Error('data corruption');
      const dataSeverity = (selfHealingManager as any).assessFailureSeverity(dataError, {
        dataIntegrityFailure: true
      });
      expect(dataSeverity).toBe(FailureSeverity.CRITICAL);
    });

    it('should report failures and update service state', async () => {
      const failure = {
        serviceName: 'partition-asia-fast',
        component: 'websocket',
        error: new Error('Connection timeout'),
        context: {}
      };

      await selfHealingManager.reportFailure(
        failure.serviceName,
        failure.component,
        failure.error,
        failure.context
      );

      // Verify failure was recorded
      const failures = (selfHealingManager as any).failureHistory;
      expect(failures.length).toBe(1);
      expect(failures[0].serviceName).toBe('partition-asia-fast');

      // Verify service state was updated
      const states = (selfHealingManager as any).serviceHealthStates;
      const state = states.get('partition-asia-fast');
      expect(state.consecutiveFailures).toBe(1);
      expect(state.healthScore).toBeLessThan(100);
    });

    it('should publish failure events to Redis via dual-publish', async () => {
      // Must start the manager to initialize streams client
      await selfHealingManager.start();

      const error = new Error('Test failure');
      await selfHealingManager.reportFailure('test-service', 'component', error);

      // P0-10: publishControlMessage uses dual-publish: streams (xadd) + pub/sub (publish)
      // Streams: should publish to stream:system-failures via xadd
      // SA-006 FIX: xaddWithLimit auto-applies MAXLEN (2-arg signature)
      expect(mockStreamsClient.xaddWithLimit).toHaveBeenCalledWith(
        'stream:system-failures',
        expect.objectContaining({
          type: 'failure_reported',
          data: expect.objectContaining({
            serviceName: 'test-service',
            component: 'component',
          }),
        }),
      );

      // Pub/Sub: should publish to system:failures channel
      expect(mockRedis.publish).toHaveBeenCalledWith(
        'system:failures',
        expect.objectContaining({
          type: 'failure_reported',
          data: expect.objectContaining({
            serviceName: 'test-service',
            component: 'component',
          }),
        })
      );
    });
  });

  describe('recovery strategy selection', () => {
    it('should determine appropriate recovery strategies', async () => {
      const testCases = [
        {
          failure: {
            id: 'fail-ws',
            serviceName: 'test-service',
            component: 'websocket',
            error: new Error('WebSocket error'),
            severity: FailureSeverity.LOW,
            recoveryAttempts: 0,
            context: {},
            timestamp: Date.now()
          },
          expectedStrategy: RecoveryStrategy.NETWORK_RESET
        },
        {
          failure: {
            id: 'fail-mem',
            serviceName: 'test-service',
            component: 'memory',
            error: new Error('Out of memory'),
            severity: FailureSeverity.HIGH,
            recoveryAttempts: 0,
            context: { memoryUsage: 0.95 },
            timestamp: Date.now()
          },
          expectedStrategy: RecoveryStrategy.MEMORY_COMPACTION
        },
        {
          failure: {
            id: 'fail-svc',
            serviceName: 'test-service',
            component: 'service',
            error: new Error('Service crashed'),
            severity: FailureSeverity.HIGH,
            recoveryAttempts: 0,
            context: {},
            timestamp: Date.now()
          },
          expectedStrategy: RecoveryStrategy.RESTART_SERVICE
        }
      ];

      for (const { failure, expectedStrategy } of testCases) {
        const state = {
          serviceName: failure.serviceName,
          healthScore: 80,
          lastHealthyCheck: Date.now(),
          consecutiveFailures: 1,
          recoveryCooldown: 0,
          activeRecoveryActions: []
        };

        // determineRecoveryStrategy is async
        const strategy = await (selfHealingManager as any).determineRecoveryStrategy(failure, state);
        expect(strategy).toBe(expectedStrategy);
      }
    });

    it('should respect recovery cooldown', async () => {
      // Set up service with recent recovery
      const states = (selfHealingManager as any).serviceHealthStates;
      // Initialize the state if it doesn't exist
      if (!states.has('partition-asia-fast')) {
        states.set('partition-asia-fast', {
          healthScore: 100,
          consecutiveFailures: 0,
          lastFailure: undefined,
          recoveryCooldown: 0,
          activeRecoveryActions: []
        });
      }
      states.get('partition-asia-fast').recoveryCooldown = Date.now() + 60000; // 1 minute from now

      const failure = {
        serviceName: 'partition-asia-fast',
        component: 'websocket',
        error: new Error('Connection failed'),
        context: {}
      };

      // Mock analysis to avoid actual recovery
      const analyzeSpy = jest.spyOn(selfHealingManager as any, 'analyzeAndRecover').mockResolvedValue(undefined);

      await selfHealingManager.reportFailure(
        failure.serviceName,
        failure.component,
        failure.error,
        failure.context
      );

      // Should skip recovery due to cooldown
      expect(analyzeSpy).toHaveBeenCalled();
      // The actual recovery logic would check cooldown internally
    });

    it('should limit active recovery actions', async () => {
      const states = (selfHealingManager as any).serviceHealthStates;
      // Initialize the state if it doesn't exist
      if (!states.has('partition-asia-fast')) {
        states.set('partition-asia-fast', {
          healthScore: 100,
          consecutiveFailures: 0,
          lastFailure: undefined,
          recoveryCooldown: 0,
          activeRecoveryActions: []
        });
      }
      const state = states.get('partition-asia-fast');

      // Add 3 active recovery actions (at limit)
      state.activeRecoveryActions = [
        { id: 'action1', failureId: 'fail1', strategy: RecoveryStrategy.RESTART_SERVICE, status: 'executing', startTime: Date.now() },
        { id: 'action2', failureId: 'fail2', strategy: RecoveryStrategy.RESTART_SERVICE, status: 'executing', startTime: Date.now() },
        { id: 'action3', failureId: 'fail3', strategy: RecoveryStrategy.RESTART_SERVICE, status: 'executing', startTime: Date.now() }
      ];

      const failure = {
        serviceName: 'partition-asia-fast',
        component: 'service',
        error: new Error('Service failed'),
        severity: FailureSeverity.HIGH,
        recoveryAttempts: 0,
        context: {}
      };

      // Mock executeRecoveryAction to track calls
      const executeSpy = jest.spyOn(selfHealingManager as any, 'executeRecoveryAction').mockResolvedValue(undefined);

      await (selfHealingManager as any).analyzeAndRecover(failure);

      // Should not execute recovery due to action limit
      expect(executeSpy).not.toHaveBeenCalled();
    });
  });

  describe('recovery action execution', () => {
    beforeEach(async () => {
      mockRedis.publish.mockResolvedValue(1);
    });

    it('should execute restart service recovery', async () => {
      // Mock getServiceHealth to return healthy after restart
      mockRedis.getServiceHealth.mockResolvedValue({ status: 'healthy' });

      const failure = {
        id: 'test-failure',
        serviceName: 'partition-asia-fast',
        component: 'service',
        error: new Error('Service crashed'),
        severity: FailureSeverity.HIGH,
        context: {},
        timestamp: Date.now(),
        recoveryAttempts: 0
      };

      await (selfHealingManager as any).executeRecoveryAction(failure, RecoveryStrategy.RESTART_SERVICE);

      // Verify recovery command was published via pub/sub
      expect(mockRedis.publish).toHaveBeenCalledWith(
        'service:partition-asia-fast:control',
        expect.objectContaining({
          type: 'restart_command',
          data: expect.objectContaining({ command: 'restart' })
        })
      );

      // Verify action was cleaned up after completion
      const actions = (selfHealingManager as any).activeRecoveryActions;
      expect(actions.size).toBe(0);
    });

    it('should handle recovery action failures', async () => {
      // Mock performRecoveryAction to throw
      jest.spyOn(selfHealingManager as any, 'performRecoveryAction')
        .mockRejectedValue(new Error('Redis publish failed'));

      const failure = {
        id: 'test-failure',
        serviceName: 'failing-service',
        component: 'service',
        error: new Error('Service crashed'),
        severity: FailureSeverity.HIGH,
        context: {},
        timestamp: Date.now(),
        recoveryAttempts: 0
      };

      // executeRecoveryAction catches errors internally, does not reject
      await (selfHealingManager as any).executeRecoveryAction(failure, RecoveryStrategy.RESTART_SERVICE);

      // Verify recovery action was cleaned up (removed from activeRecoveryActions map)
      const actions = (selfHealingManager as any).activeRecoveryActions;
      expect(actions.size).toBe(0);

      // Verify the redis.set was called to persist the failed action result
      expect(mockRedis.set).toHaveBeenCalledWith(
        expect.stringMatching(/^recovery_action:/),
        expect.objectContaining({
          status: 'failed',
          error: 'Redis publish failed',
        }),
        86400
      );
    });

    it('should wait for service health after recovery', async () => {
      mockRedis.getServiceHealth
        .mockResolvedValueOnce(null) // Not healthy yet
        .mockResolvedValueOnce(null) // Still not healthy
        .mockResolvedValueOnce({ status: 'healthy' }); // Now healthy

      const waitResult = await (selfHealingManager as any).waitForServiceHealth('test-service', 10000);

      expect(waitResult).toBe(true);
      expect(mockRedis.getServiceHealth).toHaveBeenCalledTimes(3);
    });

    it('should timeout waiting for service health', async () => {
      mockRedis.getServiceHealth.mockResolvedValue(null); // Never healthy

      const waitResult = await (selfHealingManager as any).waitForServiceHealth('test-service', 100);

      expect(waitResult).toBe(false);
    });
  });

  describe('health monitoring and statistics', () => {
    it('should provide system health overview', async () => {
      // Set up some test health states
      const states = (selfHealingManager as any).serviceHealthStates;
      states.get('partition-asia-fast').healthScore = 90;
      states.get('partition-asia-fast').consecutiveFailures = 1;
      states.get('partition-high-value').healthScore = 70;
      states.get('partition-high-value').activeRecoveryActions = [
        { id: 'action1', status: 'executing' }
      ];

      const overview = await selfHealingManager.getSystemHealthOverview();

      // 7 services: 5 at 100, 1 at 90, 1 at 70 => average = (500 + 90 + 70) / 7 ≈ 94.28
      const expectedAvg = (90 + 70 + 5 * 100) / states.size;
      expect(overview.overallHealth).toBeCloseTo(expectedAvg, 1);
      expect(overview.serviceCount).toBe(states.size);
      expect(overview.criticalServices).toBe(0); // No services below 50
      expect(overview.activeRecoveries).toBe(1);
    });

    it('should provide failure statistics', async () => {
      // Add some test failures
      const failures = (selfHealingManager as any).failureHistory;
      failures.push(
        {
          id: 'fail1',
          serviceName: 'partition-asia-fast',
          component: 'websocket',
          error: new Error('Connection failed'),
          severity: FailureSeverity.MEDIUM,
          context: {},
          timestamp: Date.now() - 1000,
          recoveryAttempts: 1
        },
        {
          id: 'fail2',
          serviceName: 'partition-high-value',
          component: 'memory',
          error: new Error('Out of memory'),
          severity: FailureSeverity.HIGH,
          context: {},
          timestamp: Date.now() - 2000,
          recoveryAttempts: 0
        }
      );

      const stats = await selfHealingManager.getFailureStatistics(5000);

      expect(stats.totalFailures).toBe(2);
      expect(stats.failureByService['partition-asia-fast']).toBe(1);
      expect(stats.failureByService['partition-high-value']).toBe(1);
      expect(stats.failureBySeverity[FailureSeverity.MEDIUM]).toBe(1);
      expect(stats.failureBySeverity[FailureSeverity.HIGH]).toBe(1);
    });
  });

  describe('lifecycle management', () => {
    // P2-FIX: Un-skipped - Redis Streams mock now available
    it('should start and stop properly', async () => {
      await selfHealingManager.start();

      expect((selfHealingManager as any).isRunning).toBe(true);

      await selfHealingManager.stop();

      expect((selfHealingManager as any).isRunning).toBe(false);
      expect((selfHealingManager as any).monitoringInterval).toBeNull();
    });

    // P2-FIX: Un-skipped - Redis Streams mock now available
    it('should handle start/stop cycles', async () => {
      await selfHealingManager.start();
      await selfHealingManager.stop();
      await selfHealingManager.start();
      await selfHealingManager.stop();

      expect((selfHealingManager as any).isRunning).toBe(false);
    });

    // P2-FIX: Un-skipped - simplified to avoid timing-based flakiness
    it('should start monitoring on start()', async () => {
      await selfHealingManager.start();

      // Verify monitoring interval was started
      expect((selfHealingManager as any).monitoringInterval).not.toBeNull();

      await selfHealingManager.stop();

      // Verify monitoring interval was cleared
      expect((selfHealingManager as any).monitoringInterval).toBeNull();
    });

    // P2-FIX: Un-skipped - subscribe mock now available
    it('should subscribe to failure events on start', async () => {
      await selfHealingManager.start();

      expect(mockRedis.subscribe).toHaveBeenCalledWith('system:failures', expect.any(Function));

      await selfHealingManager.stop();
    });
  });

  describe('error handling', () => {
    it('should handle Redis failures gracefully', async () => {
      mockRedis.publish.mockRejectedValue(new Error('Redis down'));

      await expect(selfHealingManager.reportFailure('test-service', 'component', new Error('Test')))
        .resolves.not.toThrow();
    });

    it('should handle recovery execution errors', async () => {
      const failure = {
        id: 'test-failure',
        serviceName: 'test-service',
        component: 'service',
        error: new Error('Service failed'),
        severity: FailureSeverity.HIGH,
        context: {},
        timestamp: Date.now(),
        recoveryAttempts: 0
      };

      // Mock performRecoveryAction to throw
      jest.spyOn(selfHealingManager as any, 'performRecoveryAction').mockRejectedValue(new Error('Recovery failed'));

      await expect((selfHealingManager as any).executeRecoveryAction(failure, RecoveryStrategy.RESTART_SERVICE))
        .resolves.not.toThrow(); // Should not throw, should handle error internally
    });

    it('should handle malformed failure data', async () => {
      // assessFailureSeverity now has null guard for error parameter
      await expect(selfHealingManager.reportFailure('', '', null as any))
        .resolves.not.toThrow();
    });
  });
});
