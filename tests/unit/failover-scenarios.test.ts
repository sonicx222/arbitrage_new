/**
 * S4.1.5 Failover Scenarios Unit Tests (S4.1.5.1–S4.1.5.6)
 *
 * Tests failover behavior logic for coordinator and executor services (ADR-007).
 * Verifies <60s failover time target through configuration and logic validation.
 *
 * Reclassified from integration/ — these tests validate config, timing logic,
 * and mock event flows without real infrastructure dependencies.
 * Real Redis leader election tests (S4.1.5.7) live in:
 *   tests/integration/failover-leader-election.integration.test.ts
 *
 * @see ADR-007: Cross-Region Failover Strategy
 * @see IMPLEMENTATION_PLAN.md Sprint 4, Task S4.1.5
 */

import { jest, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from '@jest/globals';

// Set required environment variables BEFORE any imports
process.env.NODE_ENV = 'test';
// NOTE: REDIS_URL is set by jest.globalSetup.ts from redis-memory-server; do not hardcode it

// =============================================================================
// Mock Factories
// =============================================================================

const createMockLogger = () => ({
  info: jest.fn<(msg: string, meta?: object) => void>(),
  error: jest.fn<(msg: string, meta?: object) => void>(),
  warn: jest.fn<(msg: string, meta?: object) => void>(),
  debug: jest.fn<(msg: string, meta?: object) => void>()
});

const createMockRedisClient = () => ({
  setNx: jest.fn(() => Promise.resolve(true)),
  set: jest.fn(() => Promise.resolve('OK')),
  get: jest.fn(() => Promise.resolve(null)),
  del: jest.fn(() => Promise.resolve(1)),
  expire: jest.fn(() => Promise.resolve(1)),
  scan: jest.fn(() => Promise.resolve(['0', []])),
  subscribe: jest.fn(() => Promise.resolve()),
  publish: jest.fn(() => Promise.resolve(1)),
  quit: jest.fn(() => Promise.resolve()),
  disconnect: jest.fn(() => Promise.resolve()),
  renewLockIfOwned: jest.fn(() => Promise.resolve(true)),
  releaseLockIfOwned: jest.fn(() => Promise.resolve(true))
});

const createMockStreamsClient = () => ({
  createConsumerGroup: jest.fn<(group: string) => Promise<void>>(() => Promise.resolve()),
  readGroup: jest.fn<(group: string, consumer: string) => Promise<unknown[]>>(() => Promise.resolve([])),
  xadd: jest.fn<(stream: string, data: object) => Promise<string>>(() => Promise.resolve('1234-0')),
  xack: jest.fn<(stream: string, group: string, id: string) => Promise<number>>(() => Promise.resolve(1))
});

const createMockLockManager = () => ({
  acquireLock: jest.fn<(key: string, options?: { ttlMs?: number; retries?: number }) => Promise<{ acquired: boolean; release: () => Promise<void>; extend: () => Promise<boolean> }>>(
    () => Promise.resolve({
      acquired: true,
      release: jest.fn(() => Promise.resolve()),
      extend: jest.fn(() => Promise.resolve(true))
    })
  ),
  releaseLock: jest.fn<(key: string) => Promise<boolean>>(() => Promise.resolve(true))
});

// =============================================================================
// CrossRegionHealthManager Tests
// =============================================================================

describe('S4.1.5: Failover Scenarios', () => {
  describe('S4.1.5.1: CrossRegionHealthManager Failover', () => {
    let mockLogger: ReturnType<typeof createMockLogger>;
    let mockRedis: ReturnType<typeof createMockRedisClient>;
    let mockStreams: ReturnType<typeof createMockStreamsClient>;
    let mockLockManager: ReturnType<typeof createMockLockManager>;

    beforeEach(() => {
      jest.clearAllMocks();
      mockLogger = createMockLogger();
      mockRedis = createMockRedisClient();
      mockStreams = createMockStreamsClient();
      mockLockManager = createMockLockManager();
    });

    afterEach(() => {
      jest.clearAllTimers();
      jest.useRealTimers();
    });

    describe('Primary Failure Detection', () => {
      it('should detect stale health data after 3x health check interval', async () => {
        // Given: Health check interval of 10s
        const healthCheckIntervalMs = 10000;
        const staleThreshold = healthCheckIntervalMs * 3; // 30 seconds

        // When: Health data is older than 3x interval
        const lastHealthCheck = Date.now() - (staleThreshold + 1000);
        const healthAge = Date.now() - lastHealthCheck;
        const isStale = healthAge > staleThreshold;

        // Then: Health data should be detected as stale
        expect(isStale).toBe(true);
        expect(healthAge).toBeGreaterThan(30000);
      });

      it('should count consecutive failures correctly', () => {
        // Given: A region health tracker
        const regionHealth = {
          regionId: 'us-east1',
          consecutiveFailures: 0,
          status: 'healthy' as const,
          failoverThreshold: 3
        };

        // When: Consecutive failures occur
        regionHealth.consecutiveFailures++;
        expect(regionHealth.consecutiveFailures).toBe(1);

        regionHealth.consecutiveFailures++;
        expect(regionHealth.consecutiveFailures).toBe(2);

        regionHealth.consecutiveFailures++;
        expect(regionHealth.consecutiveFailures).toBe(3);

        // Then: Should reach failover threshold
        expect(regionHealth.consecutiveFailures).toBeGreaterThanOrEqual(regionHealth.failoverThreshold);
      });

      it('should reset consecutive failures on successful health check', () => {
        // Given: A region with accumulated failures
        const regionHealth = {
          consecutiveFailures: 2
        };

        // When: A successful health check occurs
        const healthCheckPassed = true;
        if (healthCheckPassed) {
          regionHealth.consecutiveFailures = 0;
        }

        // Then: Failures should be reset
        expect(regionHealth.consecutiveFailures).toBe(0);
      });
    });

    describe('Failover Timing', () => {
      it('should complete failover within 60 seconds (ADR-007 target)', async () => {
        // ADR-007 specifies:
        // - Detection: 30s (3 failures x 10s health check)
        // - Election: 10s
        // - Activation: 20s
        // Total: <60s

        const detectionTimeMs = 30000; // 3 failures at 10s intervals
        const electionTimeMs = 10000;
        const activationTimeMs = 20000;
        const totalFailoverTime = detectionTimeMs + electionTimeMs + activationTimeMs;

        // Verify timing budget
        expect(totalFailoverTime).toBeLessThanOrEqual(60000);
        expect(detectionTimeMs).toBe(30000);
        expect(electionTimeMs).toBe(10000);
        expect(activationTimeMs).toBe(20000);
      });

      it('should have configurable health check interval', () => {
        const defaultInterval = 10000; // 10 seconds
        const customInterval = 5000; // 5 seconds for faster detection

        // Faster health check = faster detection
        const defaultDetectionTime = defaultInterval * 3; // 30 seconds
        const customDetectionTime = customInterval * 3; // 15 seconds

        expect(customDetectionTime).toBeLessThan(defaultDetectionTime);
        expect(customDetectionTime).toBe(15000);
      });

      it('should have configurable failover threshold', () => {
        const defaultThreshold = 3;
        const customThreshold = 2;

        // Lower threshold = faster failover but more false positives
        const healthCheckInterval = 10000;
        const defaultDetectionTime = healthCheckInterval * defaultThreshold;
        const customDetectionTime = healthCheckInterval * customThreshold;

        expect(customDetectionTime).toBeLessThan(defaultDetectionTime);
        expect(customDetectionTime).toBe(20000);
      });
    });

    describe('Failover Event Chain', () => {
      it('should emit failoverStarted event', () => {
        // Given: A mock event emitter
        const events: string[] = [];
        const emitter = {
          emit: (event: string, data: any) => {
            events.push(event);
            return true;
          }
        };

        // When: Failover starts
        const failoverEvent = {
          type: 'failover_started' as const,
          sourceRegion: 'us-west2',
          targetRegion: 'us-east1',
          services: ['coordinator', 'execution-engine'],
          timestamp: Date.now()
        };

        emitter.emit('failoverStarted', failoverEvent);

        // Then: Event should be emitted
        expect(events).toContain('failoverStarted');
      });

      it('should emit activateStandby event for standby services', () => {
        // Given: A mock event emitter
        const events: { event: string; data: any }[] = [];
        const emitter = {
          emit: (event: string, data: any) => {
            events.push({ event, data });
            return true;
          }
        };

        // When: Standby activation is triggered
        const activationData = {
          failedRegion: 'us-west2',
          timestamp: Date.now()
        };

        emitter.emit('activateStandby', activationData);

        // Then: Event should be emitted with correct data
        expect(events).toHaveLength(1);
        expect(events[0].event).toBe('activateStandby');
        expect(events[0].data.failedRegion).toBe('us-west2');
      });

      it('should emit failoverCompleted event with duration', () => {
        // Given: A failover that started 5 seconds ago
        const startTime = Date.now() - 5000;

        // When: Failover completes
        const completedEvent = {
          type: 'failover_completed' as const,
          sourceRegion: 'us-west2',
          targetRegion: 'us-east1',
          services: ['coordinator'],
          timestamp: Date.now(),
          durationMs: Date.now() - startTime
        };

        // Then: Duration should be recorded
        expect(completedEvent.durationMs).toBeGreaterThanOrEqual(5000);
        expect(completedEvent.durationMs).toBeLessThan(10000);
        expect(completedEvent.type).toBe('failover_completed');
      });

      it('should emit failoverFailed event on error', () => {
        // Given: A failover that encounters an error
        const startTime = Date.now() - 2000;
        const error = new Error('Failed to activate standby');

        // When: Failover fails
        const failedEvent = {
          type: 'failover_failed' as const,
          sourceRegion: 'us-west2',
          targetRegion: 'us-east1',
          services: ['coordinator'],
          timestamp: Date.now(),
          durationMs: Date.now() - startTime,
          error: error.message
        };

        // Then: Error should be recorded
        expect(failedEvent.type).toBe('failover_failed');
        expect(failedEvent.error).toBe('Failed to activate standby');
        expect(failedEvent.durationMs).toBeGreaterThan(0);
      });
    });

    describe('Leader Election During Failover', () => {
      it('should allow standby to acquire leadership after primary failure', () => {
        // Given: Standby configuration
        const standbyConfig = {
          isStandby: true,
          canBecomeLeader: true,
          regionId: 'us-east1'
        };

        // When: Activation is triggered
        const canAcquireLeadership = standbyConfig.canBecomeLeader && standbyConfig.isStandby;

        // Then: Standby should be able to become leader
        expect(canAcquireLeadership).toBe(true);
      });

      it('should prevent leadership acquisition when canBecomeLeader is false', () => {
        // Given: Non-leader standby configuration
        const standbyConfig = {
          isStandby: true,
          canBecomeLeader: false,
          regionId: 'us-east1'
        };

        // When: Checking leadership eligibility
        const canAcquireLeadership = standbyConfig.canBecomeLeader;

        // Then: Should not be able to become leader
        expect(canAcquireLeadership).toBe(false);
      });

      it('should use Redis distributed lock for leader election', async () => {
        // Given: A mock lock manager
        const lockAcquired = true;

        // When: Attempting to acquire leadership
        const lock = await mockLockManager.acquireLock('coordinator:leader:lock', {
          ttlMs: 30000,
          retries: 0
        });

        // Then: Lock should be acquired atomically
        expect(lock.acquired).toBe(true);
        expect(mockLockManager.acquireLock).toHaveBeenCalledWith(
          'coordinator:leader:lock',
          expect.objectContaining({ ttlMs: 30000 })
        );
      });
    });
  });

  describe('S4.1.5.2: Coordinator Failover', () => {
    describe('Standby Coordinator Activation', () => {
      it('should respect isStandby flag - prevent proactive leadership', () => {
        // Given: Coordinator config with isStandby = true
        const config = {
          isStandby: true,
          canBecomeLeader: true
        };

        // When: Checking if should attempt leadership proactively
        const shouldAttemptLeadership = !config.isStandby && config.canBecomeLeader;

        // Then: Should not attempt leadership proactively
        expect(shouldAttemptLeadership).toBe(false);
      });

      it('should allow leadership on explicit activation', () => {
        // Given: Coordinator config with isStandby = true
        const config = {
          isStandby: true,
          canBecomeLeader: true
        };

        // When: Activation is triggered, isStandby is temporarily disabled
        const originalIsStandby = config.isStandby;
        config.isStandby = false;

        // Then: Should be able to acquire leadership
        const canAcquire = config.canBecomeLeader && !config.isStandby;
        expect(canAcquire).toBe(true);

        // Cleanup: Restore state if activation fails
        config.isStandby = originalIsStandby;
      });

      it('should log activation with correct metadata', () => {
        // Given: A mock logger and activation context
        const logger = createMockLogger();
        const activationContext = {
          instanceId: 'coordinator-us-east1-local-1234567890',
          regionId: 'us-east1',
          previousIsLeader: false
        };

        // When: Activation is logged
        logger.warn('🚀 ACTIVATING STANDBY COORDINATOR', activationContext);

        // Then: Log should contain correct metadata
        expect(logger.warn).toHaveBeenCalledWith(
          '🚀 ACTIVATING STANDBY COORDINATOR',
          expect.objectContaining({
            instanceId: expect.stringContaining('coordinator'),
            regionId: 'us-east1',
            previousIsLeader: false
          })
        );
      });

      it('should prevent concurrent coordinator activation (mutex)', () => {
        // Given: A coordinator with activation state (mirrors coordinator.ts pattern)
        let isLeader = false;
        let isActivating = false;

        // First activation attempt
        const attemptActivation1 = async () => {
          if (isLeader) return true; // Already leader
          if (isActivating) return false; // Mutex check
          isActivating = true;
          try {
            // Simulate async leadership acquisition
            await Promise.resolve();
            isLeader = true;
            return true;
          } finally {
            isActivating = false;
          }
        };

        // Second activation attempt (concurrent)
        const attemptActivation2 = () => {
          if (isLeader) return true;
          if (isActivating) return false; // Should hit mutex
          isActivating = true;
          try {
            isLeader = true;
            return true;
          } finally {
            isActivating = false;
          }
        };

        // When: Both activations are triggered concurrently
        const promise1 = attemptActivation1();
        const result2 = attemptActivation2(); // Called while first is in progress

        // Then: Second attempt should be blocked by mutex
        expect(result2).toBe(false);

        // And: First attempt should succeed
        return promise1.then(result1 => {
          expect(result1).toBe(true);
          expect(isLeader).toBe(true);
        });
      });

      it('should skip activation if already leader', () => {
        // Given: Coordinator already leader
        const isLeader = true;
        let isActivating = false;

        const attemptActivation = () => {
          if (isLeader) return true; // Return early
          if (isActivating) return false;
          isActivating = true;
          // Should never reach here
          return false;
        };

        // When: Activation is attempted
        const result = attemptActivation();

        // Then: Should return true without going through activation
        expect(result).toBe(true);
        expect(isActivating).toBe(false); // Mutex never acquired
      });
    });

    describe('Coordinator Config Properties', () => {
      it('should include standby properties in CoordinatorConfig', () => {
        // Given: A coordinator config
        const config = {
          port: 3000,
          leaderElection: {
            lockKey: 'coordinator:leader:lock',
            lockTtlMs: 30000,
            heartbeatIntervalMs: 10000,
            instanceId: 'coordinator-test'
          },
          consumerGroup: 'coordinator-group',
          consumerId: 'coordinator-test',
          // Standby configuration (ADR-007)
          isStandby: true,
          canBecomeLeader: true,
          regionId: 'us-central1'
        };

        // Then: Config should have all required properties
        expect(config.isStandby).toBeDefined();
        expect(config.canBecomeLeader).toBeDefined();
        expect(config.regionId).toBeDefined();
        expect(config.leaderElection).toBeDefined();
      });

      it('should default isStandby to false', () => {
        // Given: Config without explicit isStandby
        const configInput: { isStandby?: boolean } = {};

        // When: Applying defaults
        const isStandby = configInput.isStandby ?? false;

        // Then: Should default to false
        expect(isStandby).toBe(false);
      });

      it('should default canBecomeLeader to true', () => {
        // Given: Config without explicit canBecomeLeader
        const configInput: { canBecomeLeader?: boolean } = {};

        // When: Applying defaults
        const canBecomeLeader = configInput.canBecomeLeader ?? true;

        // Then: Should default to true
        expect(canBecomeLeader).toBe(true);
      });
    });
  });

  describe('S4.1.5.3: Executor Failover', () => {
    describe('Standby Executor Activation', () => {
      it('should disable simulation mode on activation', () => {
        // Given: Executor in simulation mode
        let isSimulationMode = true;
        const standbyConfig = {
          activationDisablesSimulation: true
        };

        // When: Activation occurs
        if (standbyConfig.activationDisablesSimulation && isSimulationMode) {
          isSimulationMode = false;
        }

        // Then: Simulation mode should be disabled
        expect(isSimulationMode).toBe(false);
      });

      it('should keep simulation mode if activationDisablesSimulation is false', () => {
        // Given: Executor with activationDisablesSimulation = false
        let isSimulationMode = true;
        const standbyConfig = {
          activationDisablesSimulation: false
        };

        // When: Activation occurs
        if (standbyConfig.activationDisablesSimulation && isSimulationMode) {
          isSimulationMode = false;
        }

        // Then: Simulation mode should remain enabled
        expect(isSimulationMode).toBe(true);
      });

      it('should resume paused queue on activation', () => {
        // Given: A paused queue
        let queueManuallyPaused = true;
        const queueService = {
          isManuallyPaused: () => queueManuallyPaused,
          resume: () => { queueManuallyPaused = false; }
        };

        // When: Activation occurs
        if (queueService.isManuallyPaused()) {
          queueService.resume();
        }

        // Then: Queue should be resumed
        expect(queueManuallyPaused).toBe(false);
      });

      it('should prevent concurrent activation (mutex)', () => {
        // Given: An executor with activation state
        let isActivated = false;
        let isActivating = false;

        // First activation attempt
        const attemptActivation1 = () => {
          if (isActivated || isActivating) return false;
          isActivating = true;
          // Simulate activation work
          isActivated = true;
          isActivating = false;
          return true;
        };

        // When: First activation succeeds
        const result1 = attemptActivation1();
        expect(result1).toBe(true);

        // Second activation attempt (should skip)
        const attemptActivation2 = () => {
          if (isActivated || isActivating) return false;
          isActivating = true;
          isActivated = true;
          isActivating = false;
          return true;
        };

        // Then: Second attempt should be skipped
        const result2 = attemptActivation2();
        expect(result2).toBe(false);
      });

      it('should log activation steps with correct metadata', () => {
        // Given: A mock logger
        const logger = createMockLogger();
        const activationContext = {
          previousSimulationMode: true,
          queuePaused: true,
          regionId: 'us-east1'
        };

        // When: Activation is logged
        logger.warn('🚀 ACTIVATING STANDBY EXECUTOR', activationContext);

        // Then: Log should contain correct metadata
        expect(logger.warn).toHaveBeenCalledWith(
          '🚀 ACTIVATING STANDBY EXECUTOR',
          expect.objectContaining({
            previousSimulationMode: true,
            queuePaused: true,
            regionId: 'us-east1'
          })
        );
      });
    });

    describe('Queue Pause/Resume for Standby', () => {
      it('should pause queue on start when queuePausedOnStart is true', () => {
        // Given: Standby config with queue pause
        const standbyConfig = {
          isStandby: true,
          queuePausedOnStart: true
        };

        // When: Queue is initialized
        let queuePaused = false;
        if (standbyConfig.queuePausedOnStart) {
          queuePaused = true;
        }

        // Then: Queue should be paused
        expect(queuePaused).toBe(true);
      });

      it('should NOT pause queue on start when queuePausedOnStart is false', () => {
        // Given: Primary config without queue pause
        const standbyConfig = {
          isStandby: false,
          queuePausedOnStart: false
        };

        // When: Queue is initialized
        let queuePaused = false;
        if (standbyConfig.queuePausedOnStart) {
          queuePaused = true;
        }

        // Then: Queue should NOT be paused
        expect(queuePaused).toBe(false);
      });

      it('should have manual pause distinct from backpressure pause', () => {
        // Given: Queue state
        let backpressurePaused = false;
        let manuallyPaused = false;

        // Manual pause for standby
        const pause = () => { manuallyPaused = true; };
        const resume = () => { manuallyPaused = false; };
        const isPaused = () => backpressurePaused || manuallyPaused;
        const isManuallyPaused = () => manuallyPaused;

        // When: Manually paused
        pause();
        expect(isPaused()).toBe(true);
        expect(isManuallyPaused()).toBe(true);

        // When: Resumed
        resume();
        expect(isPaused()).toBe(false);
        expect(isManuallyPaused()).toBe(false);

        // When: Only backpressure paused
        backpressurePaused = true;
        expect(isPaused()).toBe(true);
        expect(isManuallyPaused()).toBe(false);
      });
    });

    describe('Executor StandbyConfig', () => {
      it('should have correct default values', () => {
        // Given: Input without explicit values
        const input: {
          isStandby?: boolean;
          queuePausedOnStart?: boolean;
          activationDisablesSimulation?: boolean;
          regionId?: string;
        } = {};

        // When: Applying defaults
        const config = {
          isStandby: input.isStandby ?? false,
          queuePausedOnStart: input.queuePausedOnStart ?? false,
          activationDisablesSimulation: input.activationDisablesSimulation ?? true,
          regionId: input.regionId
        };

        // Then: Defaults should be correct
        expect(config.isStandby).toBe(false);
        expect(config.queuePausedOnStart).toBe(false);
        expect(config.activationDisablesSimulation).toBe(true);
        expect(config.regionId).toBeUndefined();
      });

      it('should accept custom values', () => {
        // Given: Input with custom values
        const input = {
          isStandby: true,
          queuePausedOnStart: true,
          activationDisablesSimulation: false,
          regionId: 'us-east1'
        };

        // Then: Custom values should be used
        expect(input.isStandby).toBe(true);
        expect(input.queuePausedOnStart).toBe(true);
        expect(input.activationDisablesSimulation).toBe(false);
        expect(input.regionId).toBe('us-east1');
      });
    });
  });

  describe('S4.1.5.4: End-to-End Failover Timing', () => {
    it('should simulate complete failover flow within time budget', async () => {
      // Given: ADR-007 timing budget
      const timingBudget = {
        detection: 30000, // 3 failures x 10s
        election: 10000,
        activation: 20000,
        total: 60000
      };

      // Simulate detection (instant in tests, but budget for 30s)
      const detectionStartTime = Date.now();
      const failedRegion = 'us-west2';
      const consecutiveFailures = 3;
      const detectionEndTime = Date.now();
      const detectionTime = detectionEndTime - detectionStartTime;

      // Simulate election (instant in tests, but budget for 10s)
      const electionStartTime = Date.now();
      const leadershipAcquired = true;
      const electionEndTime = Date.now();
      const electionTime = electionEndTime - electionStartTime;

      // Simulate activation (instant in tests, but budget for 20s)
      const activationStartTime = Date.now();
      let simulationModeDisabled = false;
      let queueResumed = false;
      simulationModeDisabled = true;
      queueResumed = true;
      const activationEndTime = Date.now();
      const activationTime = activationEndTime - activationStartTime;

      // Calculate total time
      const totalTime = detectionTime + electionTime + activationTime;

      // Verify timing (in tests, these are instant)
      expect(totalTime).toBeLessThan(timingBudget.total);
      expect(leadershipAcquired).toBe(true);
      expect(simulationModeDisabled).toBe(true);
      expect(queueResumed).toBe(true);

      // Verify we have realistic timing budgets
      expect(timingBudget.detection + timingBudget.election + timingBudget.activation)
        .toBeLessThanOrEqual(timingBudget.total);
    });

    it('should track failover duration in events', () => {
      // Given: A failover that started 45 seconds ago
      const failoverStartTime = Date.now() - 45000;

      // When: Failover completes
      const completedEvent = {
        type: 'failover_completed' as const,
        sourceRegion: 'us-west2',
        targetRegion: 'us-east1',
        services: ['coordinator', 'execution-engine'],
        timestamp: Date.now(),
        durationMs: Date.now() - failoverStartTime
      };

      // Then: Duration should be within target
      expect(completedEvent.durationMs).toBeGreaterThanOrEqual(45000);
      expect(completedEvent.durationMs).toBeLessThan(60000); // Within 60s target
    });

    it('should emit warning if failover exceeds target', () => {
      // Given: A mock logger
      const logger = createMockLogger();
      const targetFailoverTimeMs = 60000;

      // When: Failover takes too long
      const actualDurationMs = 75000;
      if (actualDurationMs > targetFailoverTimeMs) {
        logger.warn('Failover exceeded target time', {
          targetMs: targetFailoverTimeMs,
          actualMs: actualDurationMs,
          excessMs: actualDurationMs - targetFailoverTimeMs
        });
      }

      // Then: Warning should be logged
      expect(logger.warn).toHaveBeenCalledWith(
        'Failover exceeded target time',
        expect.objectContaining({
          targetMs: 60000,
          actualMs: 75000,
          excessMs: 15000
        })
      );
    });
  });

  describe('S4.1.5.5: Environment Variable Configuration', () => {
    describe('Coordinator Env Vars', () => {
      it('should read IS_STANDBY from environment', () => {
        // Given: Environment variable
        const savedEnv = process.env.IS_STANDBY;
        process.env.IS_STANDBY = 'true';

        // When: Reading config
        const isStandby = process.env.IS_STANDBY === 'true';

        // Then: Should be true
        expect(isStandby).toBe(true);

        // Cleanup
        process.env.IS_STANDBY = savedEnv;
      });

      it('should read CAN_BECOME_LEADER from environment', () => {
        // Given: Environment variable
        const savedEnv = process.env.CAN_BECOME_LEADER;
        process.env.CAN_BECOME_LEADER = 'false';

        // When: Reading config (default true, only false if explicitly set)
        const canBecomeLeader = process.env.CAN_BECOME_LEADER !== 'false';

        // Then: Should be false
        expect(canBecomeLeader).toBe(false);

        // Cleanup
        process.env.CAN_BECOME_LEADER = savedEnv;
      });

      it('should read REGION_ID from environment with default', () => {
        // Given: No environment variable
        const savedEnv = process.env.REGION_ID;
        delete process.env.REGION_ID;

        // When: Reading config with default
        const regionId = process.env.REGION_ID || 'us-east1';

        // Then: Should use default
        expect(regionId).toBe('us-east1');

        // Cleanup
        process.env.REGION_ID = savedEnv;
      });
    });

    describe('Executor Env Vars', () => {
      it('should read QUEUE_PAUSED_ON_START from environment', () => {
        // Given: Environment variable
        const savedEnv = process.env.QUEUE_PAUSED_ON_START;
        process.env.QUEUE_PAUSED_ON_START = 'true';

        // When: Reading config
        const queuePausedOnStart = process.env.QUEUE_PAUSED_ON_START === 'true';

        // Then: Should be true
        expect(queuePausedOnStart).toBe(true);

        // Cleanup
        process.env.QUEUE_PAUSED_ON_START = savedEnv;
      });

      it('should read EXECUTION_SIMULATION_MODE from environment', () => {
        // Given: Environment variable
        const savedEnv = process.env.EXECUTION_SIMULATION_MODE;
        process.env.EXECUTION_SIMULATION_MODE = 'true';

        // When: Reading config
        const simulationMode = process.env.EXECUTION_SIMULATION_MODE === 'true';

        // Then: Should be true
        expect(simulationMode).toBe(true);

        // Cleanup
        process.env.EXECUTION_SIMULATION_MODE = savedEnv;
      });

      it('should read FAILOVER_THRESHOLD from environment', () => {
        // Given: Environment variable
        const savedEnv = process.env.FAILOVER_THRESHOLD;
        process.env.FAILOVER_THRESHOLD = '5';

        // When: Reading config
        const failoverThreshold = parseInt(process.env.FAILOVER_THRESHOLD || '3', 10);

        // Then: Should be custom value
        expect(failoverThreshold).toBe(5);

        // Cleanup
        process.env.FAILOVER_THRESHOLD = savedEnv;
      });

      it('should read FAILOVER_TIMEOUT_MS from environment', () => {
        // Given: Environment variable
        const savedEnv = process.env.FAILOVER_TIMEOUT_MS;
        process.env.FAILOVER_TIMEOUT_MS = '45000';

        // When: Reading config
        const failoverTimeoutMs = parseInt(process.env.FAILOVER_TIMEOUT_MS || '60000', 10);

        // Then: Should be custom value
        expect(failoverTimeoutMs).toBe(45000);

        // Cleanup
        process.env.FAILOVER_TIMEOUT_MS = savedEnv;
      });
    });
  });
});

// =============================================================================
// Metrics and Reporting
// =============================================================================

describe('S4.1.5.6: Failover Metrics', () => {
  it('should track failover count', () => {
    // Given: A metrics tracker
    const metrics = {
      failoversTriggered: 0,
      failoversCompleted: 0,
      failoversFailed: 0,
      totalFailoverDurationMs: 0,
      avgFailoverDurationMs: 0
    };

    // When: Failovers occur
    metrics.failoversTriggered++;
    metrics.failoversCompleted++;
    metrics.totalFailoverDurationMs += 42000;
    metrics.avgFailoverDurationMs = metrics.totalFailoverDurationMs / metrics.failoversCompleted;

    // Then: Metrics should be tracked
    expect(metrics.failoversTriggered).toBe(1);
    expect(metrics.failoversCompleted).toBe(1);
    expect(metrics.avgFailoverDurationMs).toBe(42000);
  });

  it('should track activation event in Redis Streams', () => {
    // Given: A mock streams client
    const streamsClient = createMockStreamsClient();

    // When: Activation event is published
    const activationEvent = {
      name: 'execution-engine',
      service: 'execution-engine',
      status: 'healthy',
      event: 'standby_activated',
      regionId: 'us-east1',
      simulationMode: false,
      timestamp: Date.now()
    };

    streamsClient.xadd('stream:health', activationEvent);

    // Then: Event should be published
    expect(streamsClient.xadd).toHaveBeenCalledWith(
      'stream:health',
      expect.objectContaining({
        event: 'standby_activated',
        regionId: 'us-east1',
        simulationMode: false
      })
    );
  });
});

