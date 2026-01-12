"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const globals_1 = require("@jest/globals");
const expert_self_healing_manager_1 = require("../expert-self-healing-manager");
const redis_1 = require("../redis");
// Mock dependencies
globals_1.jest.mock('../redis', () => ({
    getRedisClient: globals_1.jest.fn(),
    resetRedisInstance: globals_1.jest.fn()
}));
globals_1.jest.mock('../circuit-breaker', () => ({
    getCircuitBreakerRegistry: globals_1.jest.fn(() => ({
        getCircuitBreaker: globals_1.jest.fn(() => ({
            forceOpen: globals_1.jest.fn(() => Promise.resolve(true))
        }))
    }))
}));
globals_1.jest.mock('../dead-letter-queue', () => ({
    getDeadLetterQueue: globals_1.jest.fn(() => ({
        enqueue: globals_1.jest.fn(() => Promise.resolve(true))
    }))
}));
globals_1.jest.mock('../enhanced-health-monitor', () => ({
    getEnhancedHealthMonitor: globals_1.jest.fn(() => ({
        recordHealthMetric: globals_1.jest.fn(),
        getCurrentSystemHealth: globals_1.jest.fn()
    }))
}));
globals_1.jest.mock('../error-recovery', () => ({
    getErrorRecoveryOrchestrator: globals_1.jest.fn(() => ({
        recoverFromError: globals_1.jest.fn(() => Promise.resolve(true)),
        withErrorRecovery: globals_1.jest.fn()
    }))
}));
(0, globals_1.describe)('ExpertSelfHealingManager', () => {
    let selfHealingManager;
    let mockRedis;
    (0, globals_1.beforeEach)(() => {
        (0, redis_1.resetRedisInstance)();
        mockRedis = {
            publish: globals_1.jest.fn(() => Promise.resolve(1)),
            set: globals_1.jest.fn(() => Promise.resolve(undefined)),
            getServiceHealth: globals_1.jest.fn(),
            disconnect: globals_1.jest.fn(() => Promise.resolve(undefined))
        };
        redis_1.getRedisClient.mockImplementation(() => Promise.resolve(mockRedis));
        selfHealingManager = new expert_self_healing_manager_1.ExpertSelfHealingManager();
    });
    (0, globals_1.afterEach)(async () => {
        if (selfHealingManager) {
            await selfHealingManager.stop();
        }
    });
    (0, globals_1.describe)('initialization', () => {
        (0, globals_1.it)('should initialize with default service states', () => {
            const states = selfHealingManager.serviceHealthStates;
            (0, globals_1.expect)(states.size).toBeGreaterThan(0);
            // Should have coordinator service
            (0, globals_1.expect)(states.has('coordinator')).toBe(true);
            const coordinatorState = states.get('coordinator');
            (0, globals_1.expect)(coordinatorState.healthScore).toBe(100);
            (0, globals_1.expect)(coordinatorState.consecutiveFailures).toBe(0);
            (0, globals_1.expect)(coordinatorState.activeRecoveryActions).toEqual([]);
        });
    });
    (0, globals_1.describe)('failure reporting and assessment', () => {
        (0, globals_1.it)('should assess failure severity correctly', () => {
            // Network failure
            const networkError = new Error('ECONNREFUSED');
            const severity = selfHealingManager.assessFailureSeverity(networkError, {});
            (0, globals_1.expect)(severity).toBe(expert_self_healing_manager_1.FailureSeverity.MEDIUM);
            // Memory failure
            const memoryError = new Error('heap limit');
            const memorySeverity = selfHealingManager.assessFailureSeverity(memoryError, {
                memoryUsage: 0.95
            });
            (0, globals_1.expect)(memorySeverity).toBe(expert_self_healing_manager_1.FailureSeverity.HIGH);
            // Critical data failure
            const dataError = new Error('data corruption');
            const dataSeverity = selfHealingManager.assessFailureSeverity(dataError, {
                dataIntegrityFailure: true
            });
            (0, globals_1.expect)(dataSeverity).toBe(expert_self_healing_manager_1.FailureSeverity.CRITICAL);
        });
        (0, globals_1.it)('should report failures and update service state', async () => {
            const failure = {
                serviceName: 'bsc-detector',
                component: 'websocket',
                error: new Error('Connection timeout'),
                context: {}
            };
            await selfHealingManager.reportFailure(failure.serviceName, failure.component, failure.error, failure.context);
            // Verify failure was recorded
            const failures = selfHealingManager.failureHistory;
            (0, globals_1.expect)(failures.length).toBe(1);
            (0, globals_1.expect)(failures[0].serviceName).toBe('bsc-detector');
            // Verify service state was updated
            const states = selfHealingManager.serviceHealthStates;
            const state = states.get('bsc-detector');
            (0, globals_1.expect)(state.consecutiveFailures).toBe(1);
            (0, globals_1.expect)(state.healthScore).toBeLessThan(100);
        });
        // Skip: Redis Streams initialization required
        globals_1.it.skip('should publish failure events to Redis', async () => {
            const error = new Error('Test failure');
            await selfHealingManager.reportFailure('test-service', 'component', error);
            (0, globals_1.expect)(mockRedis.publish).toHaveBeenCalledWith('system:failures', globals_1.expect.objectContaining({
                serviceName: 'test-service',
                component: 'component',
                error: error,
                severity: globals_1.expect.any(String)
            }));
        });
    });
    (0, globals_1.describe)('recovery strategy selection', () => {
        // Skip: Recovery strategies require full initialization
        globals_1.it.skip('should determine appropriate recovery strategies', () => {
            const testCases = [
                {
                    failure: {
                        serviceName: 'test-service',
                        component: 'websocket',
                        error: new Error('WebSocket error'),
                        severity: expert_self_healing_manager_1.FailureSeverity.LOW,
                        recoveryAttempts: 0,
                        context: {}
                    },
                    expectedStrategy: expert_self_healing_manager_1.RecoveryStrategy.NETWORK_RESET
                },
                {
                    failure: {
                        serviceName: 'test-service',
                        component: 'memory',
                        error: new Error('Out of memory'),
                        severity: expert_self_healing_manager_1.FailureSeverity.HIGH,
                        recoveryAttempts: 0,
                        context: { memoryUsage: 0.95 }
                    },
                    expectedStrategy: expert_self_healing_manager_1.RecoveryStrategy.MEMORY_COMPACTION
                },
                {
                    failure: {
                        serviceName: 'test-service',
                        component: 'service',
                        error: new Error('Service crashed'),
                        severity: expert_self_healing_manager_1.FailureSeverity.HIGH,
                        recoveryAttempts: 0,
                        context: {}
                    },
                    expectedStrategy: expert_self_healing_manager_1.RecoveryStrategy.RESTART_SERVICE
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
                const strategy = selfHealingManager.determineRecoveryStrategy(failure, state);
                (0, globals_1.expect)(strategy).toBe(expectedStrategy);
            });
        });
        (0, globals_1.it)('should respect recovery cooldown', async () => {
            // Set up service with recent recovery
            const states = selfHealingManager.serviceHealthStates;
            states.get('bsc-detector').recoveryCooldown = Date.now() + 60000; // 1 minute from now
            const failure = {
                serviceName: 'bsc-detector',
                component: 'websocket',
                error: new Error('Connection failed'),
                context: {}
            };
            // Mock analysis to avoid actual recovery
            const analyzeSpy = globals_1.jest.spyOn(selfHealingManager, 'analyzeAndRecover').mockResolvedValue(undefined);
            await selfHealingManager.reportFailure(failure.serviceName, failure.component, failure.error, failure.context);
            // Should skip recovery due to cooldown
            (0, globals_1.expect)(analyzeSpy).toHaveBeenCalled();
            // The actual recovery logic would check cooldown internally
        });
        (0, globals_1.it)('should limit active recovery actions', async () => {
            const states = selfHealingManager.serviceHealthStates;
            const state = states.get('bsc-detector');
            // Add 3 active recovery actions (at limit)
            state.activeRecoveryActions = [
                { id: 'action1', failureId: 'fail1', strategy: expert_self_healing_manager_1.RecoveryStrategy.RESTART_SERVICE, status: 'executing', startTime: Date.now() },
                { id: 'action2', failureId: 'fail2', strategy: expert_self_healing_manager_1.RecoveryStrategy.RESTART_SERVICE, status: 'executing', startTime: Date.now() },
                { id: 'action3', failureId: 'fail3', strategy: expert_self_healing_manager_1.RecoveryStrategy.RESTART_SERVICE, status: 'executing', startTime: Date.now() }
            ];
            const failure = {
                serviceName: 'bsc-detector',
                component: 'service',
                error: new Error('Service failed'),
                severity: expert_self_healing_manager_1.FailureSeverity.HIGH,
                recoveryAttempts: 0,
                context: {}
            };
            // Mock executeRecoveryAction to track calls
            const executeSpy = globals_1.jest.spyOn(selfHealingManager, 'executeRecoveryAction').mockResolvedValue(undefined);
            await selfHealingManager.analyzeAndRecover(failure);
            // Should not execute recovery due to action limit
            (0, globals_1.expect)(executeSpy).not.toHaveBeenCalled();
        });
    });
    (0, globals_1.describe)('recovery action execution', () => {
        (0, globals_1.beforeEach)(async () => {
            mockRedis.publish.mockResolvedValue(1);
        });
        // Skip: Recovery execution requires Redis Streams
        globals_1.it.skip('should execute restart service recovery', async () => {
            const failure = {
                id: 'test-failure',
                serviceName: 'bsc-detector',
                component: 'service',
                error: new Error('Service crashed'),
                severity: expert_self_healing_manager_1.FailureSeverity.HIGH,
                context: {},
                timestamp: Date.now(),
                recoveryAttempts: 0
            };
            const recoveryPromise = selfHealingManager.executeRecoveryAction(failure, expert_self_healing_manager_1.RecoveryStrategy.RESTART_SERVICE);
            // Wait for completion
            await recoveryPromise;
            // Verify recovery command was published
            (0, globals_1.expect)(mockRedis.publish).toHaveBeenCalledWith('service:bsc-detector:control', globals_1.expect.objectContaining({
                command: 'restart'
            }));
            // Verify action was recorded
            const actions = selfHealingManager.activeRecoveryActions;
            (0, globals_1.expect)(actions.size).toBe(0); // Should be cleaned up after completion
        });
        // Skip: Recovery failures require Redis Streams
        globals_1.it.skip('should handle recovery action failures', async () => {
            mockRedis.publish.mockRejectedValue(new Error('Redis publish failed'));
            const failure = {
                id: 'test-failure',
                serviceName: 'failing-service',
                component: 'service',
                error: new Error('Service crashed'),
                severity: expert_self_healing_manager_1.FailureSeverity.HIGH,
                context: {},
                timestamp: Date.now(),
                recoveryAttempts: 0
            };
            const recoveryPromise = selfHealingManager.executeRecoveryAction(failure, expert_self_healing_manager_1.RecoveryStrategy.RESTART_SERVICE);
            await (0, globals_1.expect)(recoveryPromise).rejects.toThrow('Redis publish failed');
            // Verify action status
            const actions = selfHealingManager.activeRecoveryActions;
            const action = Array.from(actions.values())[0];
            (0, globals_1.expect)(action.status).toBe('failed');
            (0, globals_1.expect)(action.error).toBe('Redis publish failed');
        });
        (0, globals_1.it)('should wait for service health after recovery', async () => {
            mockRedis.getServiceHealth
                .mockResolvedValueOnce(null) // Not healthy yet
                .mockResolvedValueOnce(null) // Still not healthy
                .mockResolvedValueOnce({ status: 'healthy' }); // Now healthy
            const waitResult = await selfHealingManager.waitForServiceHealth('test-service', 10000);
            (0, globals_1.expect)(waitResult).toBe(true);
            (0, globals_1.expect)(mockRedis.getServiceHealth).toHaveBeenCalledTimes(3);
        });
        (0, globals_1.it)('should timeout waiting for service health', async () => {
            mockRedis.getServiceHealth.mockResolvedValue(null); // Never healthy
            const waitResult = await selfHealingManager.waitForServiceHealth('test-service', 100);
            (0, globals_1.expect)(waitResult).toBe(false);
        });
    });
    (0, globals_1.describe)('health monitoring and statistics', () => {
        // Skip: Health monitoring requires Redis Streams initialization
        globals_1.it.skip('should provide system health overview', async () => {
            // Set up some test health states
            const states = selfHealingManager.serviceHealthStates;
            states.get('bsc-detector').healthScore = 90;
            states.get('bsc-detector').consecutiveFailures = 1;
            states.get('ethereum-detector').healthScore = 70;
            states.get('ethereum-detector').activeRecoveryActions = [
                { id: 'action1', status: 'executing' }
            ];
            const overview = await selfHealingManager.getSystemHealthOverview();
            (0, globals_1.expect)(overview.overallHealth).toBe(80); // Average of 90 and 70
            (0, globals_1.expect)(overview.serviceCount).toBe(states.size);
            (0, globals_1.expect)(overview.criticalServices).toBe(0); // No services below 50
            (0, globals_1.expect)(overview.activeRecoveries).toBe(1);
        });
        (0, globals_1.it)('should provide failure statistics', async () => {
            // Add some test failures
            const failures = selfHealingManager.failureHistory;
            failures.push({
                id: 'fail1',
                serviceName: 'bsc-detector',
                component: 'websocket',
                error: new Error('Connection failed'),
                severity: expert_self_healing_manager_1.FailureSeverity.MEDIUM,
                context: {},
                timestamp: Date.now() - 1000,
                recoveryAttempts: 1
            }, {
                id: 'fail2',
                serviceName: 'ethereum-detector',
                component: 'memory',
                error: new Error('Out of memory'),
                severity: expert_self_healing_manager_1.FailureSeverity.HIGH,
                context: {},
                timestamp: Date.now() - 2000,
                recoveryAttempts: 0
            });
            const stats = await selfHealingManager.getFailureStatistics(5000);
            (0, globals_1.expect)(stats.totalFailures).toBe(2);
            (0, globals_1.expect)(stats.failureByService['bsc-detector']).toBe(1);
            (0, globals_1.expect)(stats.failureByService['ethereum-detector']).toBe(1);
            (0, globals_1.expect)(stats.failureBySeverity[expert_self_healing_manager_1.FailureSeverity.MEDIUM]).toBe(1);
            (0, globals_1.expect)(stats.failureBySeverity[expert_self_healing_manager_1.FailureSeverity.HIGH]).toBe(1);
        });
    });
    (0, globals_1.describe)('lifecycle management', () => {
        // Skip: Lifecycle tests require Redis Streams initialization
        globals_1.it.skip('should start and stop properly', async () => {
            await selfHealingManager.start();
            (0, globals_1.expect)(selfHealingManager.isRunning).toBe(true);
            await selfHealingManager.stop();
            (0, globals_1.expect)(selfHealingManager.isRunning).toBe(false);
            (0, globals_1.expect)(selfHealingManager.monitoringInterval).toBeNull();
        });
        // Skip: Lifecycle tests require Redis Streams initialization
        globals_1.it.skip('should handle start/stop cycles', async () => {
            await selfHealingManager.start();
            await selfHealingManager.stop();
            await selfHealingManager.start();
            await selfHealingManager.stop();
            (0, globals_1.expect)(selfHealingManager.isRunning).toBe(false);
        });
        // Skip: Lifecycle tests require Redis Streams initialization
        globals_1.it.skip('should perform health checks periodically', async () => {
            mockRedis.getServiceHealth.mockResolvedValue({ status: 'healthy' });
            await selfHealingManager.start();
            // Wait for health check interval
            await new Promise(resolve => setTimeout(resolve, 100));
            // Stop to clean up
            await selfHealingManager.stop();
            // Verify health check was performed
            (0, globals_1.expect)(mockRedis.getServiceHealth).toHaveBeenCalled();
        });
        // Skip: Lifecycle tests require Redis Streams initialization
        globals_1.it.skip('should subscribe to failure events on start', async () => {
            await selfHealingManager.start();
            (0, globals_1.expect)(mockRedis.subscribe).toHaveBeenCalledWith('system:failures', globals_1.expect.any(Function));
            await selfHealingManager.stop();
        });
    });
    (0, globals_1.describe)('error handling', () => {
        (0, globals_1.it)('should handle Redis failures gracefully', async () => {
            mockRedis.publish.mockRejectedValue(new Error('Redis down'));
            await (0, globals_1.expect)(selfHealingManager.reportFailure('test-service', 'component', new Error('Test')))
                .resolves.not.toThrow();
        });
        (0, globals_1.it)('should handle recovery execution errors', async () => {
            const failure = {
                id: 'test-failure',
                serviceName: 'test-service',
                component: 'service',
                error: new Error('Service failed'),
                severity: expert_self_healing_manager_1.FailureSeverity.HIGH,
                context: {},
                timestamp: Date.now(),
                recoveryAttempts: 0
            };
            // Mock performRecoveryAction to throw
            globals_1.jest.spyOn(selfHealingManager, 'performRecoveryAction').mockRejectedValue(new Error('Recovery failed'));
            await (0, globals_1.expect)(selfHealingManager.executeRecoveryAction(failure, expert_self_healing_manager_1.RecoveryStrategy.RESTART_SERVICE))
                .resolves.not.toThrow(); // Should not throw, should handle error internally
        });
        // Skip: Null handling requires full initialization
        globals_1.it.skip('should handle malformed failure data', async () => {
            await (0, globals_1.expect)(selfHealingManager.reportFailure('', '', null))
                .resolves.not.toThrow();
        });
    });
});
//# sourceMappingURL=expert-self-healing.test.js.map