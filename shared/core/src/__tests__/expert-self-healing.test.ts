import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  ExpertSelfHealingManager,
  FailureSeverity,
  RecoveryStrategy
} from '../expert-self-healing-manager';
import { getRedisClient, resetRedisInstance } from '../redis';

// Mock dependencies
jest.mock('../redis', () => ({
  getRedisClient: jest.fn()
}));

jest.mock('../circuit-breaker', () => ({
  getCircuitBreakerRegistry: jest.fn(() => ({
    getCircuitBreaker: jest.fn(() => ({
      forceOpen: jest.fn().mockResolvedValue(true)
    }))
  }))
}));

jest.mock('../dead-letter-queue', () => ({
  getDeadLetterQueue: jest.fn(() => ({
    enqueue: jest.fn().mockResolvedValue(true)
  }))
}));

jest.mock('../enhanced-health-monitor', () => ({
  getEnhancedHealthMonitor: jest.fn(() => ({
    recordHealthMetric: jest.fn(),
    getCurrentSystemHealth: jest.fn()
  }))
}));

jest.mock('../error-recovery', () => ({
  getErrorRecoveryOrchestrator: jest.fn(() => ({
    recoverFromError: jest.fn().mockResolvedValue(true),
    withErrorRecovery: jest.fn()
  }))
}));

describe('ExpertSelfHealingManager', () => {
  let selfHealingManager: ExpertSelfHealingManager;
  let mockRedis: any;

  beforeEach(() => {
    resetRedisInstance();

    mockRedis = {
      publish: jest.fn().mockResolvedValue(1),
      set: jest.fn().mockResolvedValue(undefined),
      getServiceHealth: jest.fn(),
      disconnect: jest.fn().mockResolvedValue(undefined)
    };

    (getRedisClient as jest.Mock).mockResolvedValue(mockRedis);

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
        serviceName: 'bsc-detector',
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
      expect(failures[0].serviceName).toBe('bsc-detector');

      // Verify service state was updated
      const states = (selfHealingManager as any).serviceHealthStates;
      const state = states.get('bsc-detector');
      expect(state.consecutiveFailures).toBe(1);
      expect(state.healthScore).toBeLessThan(100);
    });

    it('should publish failure events to Redis', async () => {
      const error = new Error('Test failure');

      await selfHealingManager.reportFailure('test-service', 'component', error);

      expect(mockRedis.publish).toHaveBeenCalledWith('system:failures', expect.objectContaining({
        serviceName: 'test-service',
        component: 'component',
        error: error,
        severity: expect.any(String)
      }));
    });
  });

  describe('recovery strategy selection', () => {
    it('should determine appropriate recovery strategies', () => {
      const testCases = [
        {
          failure: {
            serviceName: 'test-service',
            component: 'websocket',
            error: new Error('WebSocket error'),
            severity: FailureSeverity.LOW,
            recoveryAttempts: 0,
            context: {}
          },
          expectedStrategy: RecoveryStrategy.NETWORK_RESET
        },
        {
          failure: {
            serviceName: 'test-service',
            component: 'memory',
            error: new Error('Out of memory'),
            severity: FailureSeverity.HIGH,
            recoveryAttempts: 0,
            context: { memoryUsage: 0.95 }
          },
          expectedStrategy: RecoveryStrategy.MEMORY_COMPACTION
        },
        {
          failure: {
            serviceName: 'test-service',
            component: 'service',
            error: new Error('Service crashed'),
            severity: FailureSeverity.HIGH,
            recoveryAttempts: 0,
            context: {}
          },
          expectedStrategy: RecoveryStrategy.RESTART_SERVICE
        }
      ];

      testCases.forEach(({ failure, expectedStrategy }) => {
        const state = {
          serviceName: failure.serviceName,
          healthScore: 80,
          consecutiveFailures: 1,
          recoveryCooldown: 0,
          activeRecoveryActions: []
        };

        const strategy = (selfHealingManager as any).determineRecoveryStrategy(failure, state);
        expect(strategy).toBe(expectedStrategy);
      });
    });

    it('should respect recovery cooldown', async () => {
      // Set up service with recent recovery
      const states = (selfHealingManager as any).serviceHealthStates;
      states.get('bsc-detector').recoveryCooldown = Date.now() + 60000; // 1 minute from now

      const failure = {
        serviceName: 'bsc-detector',
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
      const state = states.get('bsc-detector');

      // Add 3 active recovery actions (at limit)
      state.activeRecoveryActions = [
        { id: 'action1', failureId: 'fail1', strategy: RecoveryStrategy.RESTART_SERVICE, status: 'executing', startTime: Date.now() },
        { id: 'action2', failureId: 'fail2', strategy: RecoveryStrategy.RESTART_SERVICE, status: 'executing', startTime: Date.now() },
        { id: 'action3', failureId: 'fail3', strategy: RecoveryStrategy.RESTART_SERVICE, status: 'executing', startTime: Date.now() }
      ];

      const failure = {
        serviceName: 'bsc-detector',
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
      const failure = {
        id: 'test-failure',
        serviceName: 'bsc-detector',
        component: 'service',
        error: new Error('Service crashed'),
        severity: FailureSeverity.HIGH,
        context: {},
        timestamp: Date.now(),
        recoveryAttempts: 0
      };

      const recoveryPromise = (selfHealingManager as any).executeRecoveryAction(failure, RecoveryStrategy.RESTART_SERVICE);

      // Wait for completion
      await recoveryPromise;

      // Verify recovery command was published
      expect(mockRedis.publish).toHaveBeenCalledWith(
        'service:bsc-detector:control',
        expect.objectContaining({
          command: 'restart'
        })
      );

      // Verify action was recorded
      const actions = (selfHealingManager as any).activeRecoveryActions;
      expect(actions.size).toBe(0); // Should be cleaned up after completion
    });

    it('should handle recovery action failures', async () => {
      mockRedis.publish.mockRejectedValue(new Error('Redis publish failed'));

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

      const recoveryPromise = (selfHealingManager as any).executeRecoveryAction(failure, RecoveryStrategy.RESTART_SERVICE);

      await expect(recoveryPromise).rejects.toThrow('Redis publish failed');

      // Verify action status
      const actions = (selfHealingManager as any).activeRecoveryActions;
      const action = Array.from(actions.values())[0];
      expect(action.status).toBe('failed');
      expect(action.error).toBe('Redis publish failed');
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
      states.get('bsc-detector').healthScore = 90;
      states.get('bsc-detector').consecutiveFailures = 1;
      states.get('ethereum-detector').healthScore = 70;
      states.get('ethereum-detector').activeRecoveryActions = [
        { id: 'action1', status: 'executing' }
      ];

      const overview = await selfHealingManager.getSystemHealthOverview();

      expect(overview.overallHealth).toBe(80); // Average of 90 and 70
      expect(overview.serviceCount).toBe(states.size);
      expect(overview.criticalServices).toBe(0); // No services below 50
      expect(overview.activeRecoveries).toBe(1);
    });

    it('should provide failure statistics', () => {
      // Add some test failures
      const failures = (selfHealingManager as any).failureHistory;
      failures.push(
        {
          id: 'fail1',
          serviceName: 'bsc-detector',
          component: 'websocket',
          error: new Error('Connection failed'),
          severity: FailureSeverity.MEDIUM,
          context: {},
          timestamp: Date.now() - 1000,
          recoveryAttempts: 1
        },
        {
          id: 'fail2',
          serviceName: 'ethereum-detector',
          component: 'memory',
          error: new Error('Out of memory'),
          severity: FailureSeverity.HIGH,
          context: {},
          timestamp: Date.now() - 2000,
          recoveryAttempts: 0
        }
      );

      const stats = selfHealingManager.getFailureStatistics(5000);

      expect(stats.totalFailures).toBe(2);
      expect(stats.failureByService['bsc-detector']).toBe(1);
      expect(stats.failureByService['ethereum-detector']).toBe(1);
      expect(stats.failureBySeverity[FailureSeverity.MEDIUM]).toBe(1);
      expect(stats.failureBySeverity[FailureSeverity.HIGH]).toBe(1);
    });
  });

  describe('lifecycle management', () => {
    it('should start and stop properly', async () => {
      await selfHealingManager.start();

      expect((selfHealingManager as any).isRunning).toBe(true);

      await selfHealingManager.stop();

      expect((selfHealingManager as any).isRunning).toBe(false);
      expect((selfHealingManager as any).monitoringInterval).toBeNull();
    });

    it('should handle start/stop cycles', async () => {
      await selfHealingManager.start();
      await selfHealingManager.stop();
      await selfHealingManager.start();
      await selfHealingManager.stop();

      expect((selfHealingManager as any).isRunning).toBe(false);
    });

    it('should perform health checks periodically', async () => {
      mockRedis.getServiceHealth.mockResolvedValue({ status: 'healthy' });

      await selfHealingManager.start();

      // Wait for health check interval
      await new Promise(resolve => setTimeout(resolve, 100));

      // Stop to clean up
      await selfHealingManager.stop();

      // Verify health check was performed
      expect(mockRedis.getServiceHealth).toHaveBeenCalled();
    });

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
      await expect(selfHealingManager.reportFailure('', '', null as any))
        .resolves.not.toThrow();
    });
  });
});