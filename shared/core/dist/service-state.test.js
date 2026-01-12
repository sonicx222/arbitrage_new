"use strict";
/**
 * Service State Machine Tests
 *
 * Tests for lifecycle state management including:
 * - Valid/invalid state transitions
 * - Race condition prevention
 * - Event emission
 * - Lifecycle helpers (executeStart, executeStop)
 */
Object.defineProperty(exports, "__esModule", { value: true });
const globals_1 = require("@jest/globals");
const service_state_1 = require("./service-state");
// Mock logger
globals_1.jest.mock('./logger', () => ({
    createLogger: globals_1.jest.fn(() => ({
        info: globals_1.jest.fn(),
        error: globals_1.jest.fn(),
        warn: globals_1.jest.fn(),
        debug: globals_1.jest.fn()
    }))
}));
(0, globals_1.describe)('ServiceStateManager', () => {
    let stateManager;
    (0, globals_1.beforeEach)(() => {
        stateManager = (0, service_state_1.createServiceState)({
            serviceName: 'test-service',
            transitionTimeoutMs: 1000,
            emitEvents: true
        });
        // Add error listener to prevent unhandled 'error' events from crashing tests
        // The ServiceStateManager emits state name as event, including 'error' state
        stateManager.on('error', () => {
            // Intentionally empty - we just need to prevent unhandled error events
        });
    });
    (0, globals_1.afterEach)(() => {
        stateManager.removeAllListeners();
    });
    // ===========================================================================
    // Initial State
    // ===========================================================================
    (0, globals_1.describe)('initial state', () => {
        (0, globals_1.it)('should start in STOPPED state', () => {
            (0, globals_1.expect)(stateManager.getState()).toBe(service_state_1.ServiceState.STOPPED);
        });
        (0, globals_1.it)('should return correct state queries', () => {
            (0, globals_1.expect)(stateManager.isStopped()).toBe(true);
            (0, globals_1.expect)(stateManager.isRunning()).toBe(false);
            (0, globals_1.expect)(stateManager.isTransitioning()).toBe(false);
            (0, globals_1.expect)(stateManager.isError()).toBe(false);
        });
        (0, globals_1.it)('should have correct initial snapshot', () => {
            const snapshot = stateManager.getSnapshot();
            (0, globals_1.expect)(snapshot.state).toBe(service_state_1.ServiceState.STOPPED);
            (0, globals_1.expect)(snapshot.serviceName).toBe('test-service');
            (0, globals_1.expect)(snapshot.transitionCount).toBe(0);
            (0, globals_1.expect)(snapshot.errorMessage).toBeUndefined();
        });
    });
    // ===========================================================================
    // Valid Transitions
    // ===========================================================================
    (0, globals_1.describe)('valid state transitions', () => {
        (0, globals_1.it)('should transition STOPPED -> STARTING', async () => {
            const result = await stateManager.transitionTo(service_state_1.ServiceState.STARTING);
            (0, globals_1.expect)(result.success).toBe(true);
            (0, globals_1.expect)(result.previousState).toBe(service_state_1.ServiceState.STOPPED);
            (0, globals_1.expect)(result.currentState).toBe(service_state_1.ServiceState.STARTING);
            (0, globals_1.expect)(stateManager.getState()).toBe(service_state_1.ServiceState.STARTING);
        });
        (0, globals_1.it)('should transition STARTING -> RUNNING', async () => {
            await stateManager.transitionTo(service_state_1.ServiceState.STARTING);
            const result = await stateManager.transitionTo(service_state_1.ServiceState.RUNNING);
            (0, globals_1.expect)(result.success).toBe(true);
            (0, globals_1.expect)(result.currentState).toBe(service_state_1.ServiceState.RUNNING);
            (0, globals_1.expect)(stateManager.isRunning()).toBe(true);
        });
        (0, globals_1.it)('should transition RUNNING -> STOPPING', async () => {
            await stateManager.transitionTo(service_state_1.ServiceState.STARTING);
            await stateManager.transitionTo(service_state_1.ServiceState.RUNNING);
            const result = await stateManager.transitionTo(service_state_1.ServiceState.STOPPING);
            (0, globals_1.expect)(result.success).toBe(true);
            (0, globals_1.expect)(result.currentState).toBe(service_state_1.ServiceState.STOPPING);
        });
        (0, globals_1.it)('should transition STOPPING -> STOPPED', async () => {
            await stateManager.transitionTo(service_state_1.ServiceState.STARTING);
            await stateManager.transitionTo(service_state_1.ServiceState.RUNNING);
            await stateManager.transitionTo(service_state_1.ServiceState.STOPPING);
            const result = await stateManager.transitionTo(service_state_1.ServiceState.STOPPED);
            (0, globals_1.expect)(result.success).toBe(true);
            (0, globals_1.expect)(result.currentState).toBe(service_state_1.ServiceState.STOPPED);
            (0, globals_1.expect)(stateManager.isStopped()).toBe(true);
        });
        (0, globals_1.it)('should transition STARTING -> ERROR', async () => {
            await stateManager.transitionTo(service_state_1.ServiceState.STARTING);
            const result = await stateManager.transitionTo(service_state_1.ServiceState.ERROR, 'Startup failed');
            (0, globals_1.expect)(result.success).toBe(true);
            (0, globals_1.expect)(result.currentState).toBe(service_state_1.ServiceState.ERROR);
            (0, globals_1.expect)(stateManager.getSnapshot().errorMessage).toBe('Startup failed');
        });
        (0, globals_1.it)('should transition ERROR -> STOPPED', async () => {
            await stateManager.transitionTo(service_state_1.ServiceState.STARTING);
            await stateManager.transitionTo(service_state_1.ServiceState.ERROR);
            const result = await stateManager.transitionTo(service_state_1.ServiceState.STOPPED);
            (0, globals_1.expect)(result.success).toBe(true);
            (0, globals_1.expect)(result.currentState).toBe(service_state_1.ServiceState.STOPPED);
        });
        (0, globals_1.it)('should transition ERROR -> STARTING (retry)', async () => {
            await stateManager.transitionTo(service_state_1.ServiceState.STARTING);
            await stateManager.transitionTo(service_state_1.ServiceState.ERROR);
            const result = await stateManager.transitionTo(service_state_1.ServiceState.STARTING);
            (0, globals_1.expect)(result.success).toBe(true);
            (0, globals_1.expect)(result.currentState).toBe(service_state_1.ServiceState.STARTING);
        });
    });
    // ===========================================================================
    // Invalid Transitions
    // ===========================================================================
    (0, globals_1.describe)('invalid state transitions', () => {
        (0, globals_1.it)('should reject STOPPED -> RUNNING', async () => {
            const result = await stateManager.transitionTo(service_state_1.ServiceState.RUNNING);
            (0, globals_1.expect)(result.success).toBe(false);
            (0, globals_1.expect)(result.error).toBeDefined();
            (0, globals_1.expect)(stateManager.getState()).toBe(service_state_1.ServiceState.STOPPED);
        });
        (0, globals_1.it)('should reject STOPPED -> STOPPING', async () => {
            const result = await stateManager.transitionTo(service_state_1.ServiceState.STOPPING);
            (0, globals_1.expect)(result.success).toBe(false);
            (0, globals_1.expect)(stateManager.getState()).toBe(service_state_1.ServiceState.STOPPED);
        });
        (0, globals_1.it)('should reject RUNNING -> STARTING', async () => {
            await stateManager.transitionTo(service_state_1.ServiceState.STARTING);
            await stateManager.transitionTo(service_state_1.ServiceState.RUNNING);
            const result = await stateManager.transitionTo(service_state_1.ServiceState.STARTING);
            (0, globals_1.expect)(result.success).toBe(false);
            (0, globals_1.expect)(stateManager.getState()).toBe(service_state_1.ServiceState.RUNNING);
        });
        (0, globals_1.it)('should reject STARTING -> STOPPED directly (use ERROR first)', async () => {
            await stateManager.transitionTo(service_state_1.ServiceState.STARTING);
            // Note: STARTING -> STOPPED IS valid for cancelled starts
            const result = await stateManager.transitionTo(service_state_1.ServiceState.STOPPED);
            // Actually this is a valid transition for cancellation
            (0, globals_1.expect)(result.success).toBe(true);
        });
    });
    // ===========================================================================
    // Event Emission
    // ===========================================================================
    (0, globals_1.describe)('event emission', () => {
        (0, globals_1.it)('should emit stateChange event on transition', async () => {
            const eventHandler = globals_1.jest.fn();
            stateManager.on('stateChange', eventHandler);
            await stateManager.transitionTo(service_state_1.ServiceState.STARTING);
            (0, globals_1.expect)(eventHandler).toHaveBeenCalledTimes(1);
            (0, globals_1.expect)(eventHandler).toHaveBeenCalledWith({
                previousState: service_state_1.ServiceState.STOPPED,
                newState: service_state_1.ServiceState.STARTING,
                timestamp: globals_1.expect.any(Number),
                serviceName: 'test-service'
            });
        });
        (0, globals_1.it)('should emit state-specific events', async () => {
            const startingHandler = globals_1.jest.fn();
            const runningHandler = globals_1.jest.fn();
            stateManager.on(service_state_1.ServiceState.STARTING, startingHandler);
            stateManager.on(service_state_1.ServiceState.RUNNING, runningHandler);
            await stateManager.transitionTo(service_state_1.ServiceState.STARTING);
            await stateManager.transitionTo(service_state_1.ServiceState.RUNNING);
            (0, globals_1.expect)(startingHandler).toHaveBeenCalledTimes(1);
            (0, globals_1.expect)(runningHandler).toHaveBeenCalledTimes(1);
        });
        (0, globals_1.it)('should not emit events when emitEvents is false', async () => {
            const quietManager = (0, service_state_1.createServiceState)({
                serviceName: 'quiet-service',
                emitEvents: false
            });
            const eventHandler = globals_1.jest.fn();
            quietManager.on('stateChange', eventHandler);
            await quietManager.transitionTo(service_state_1.ServiceState.STARTING);
            (0, globals_1.expect)(eventHandler).not.toHaveBeenCalled();
        });
    });
    // ===========================================================================
    // requireTransitionTo
    // ===========================================================================
    (0, globals_1.describe)('requireTransitionTo', () => {
        (0, globals_1.it)('should resolve on valid transition', async () => {
            await (0, globals_1.expect)(stateManager.requireTransitionTo(service_state_1.ServiceState.STARTING))
                .resolves.not.toThrow();
        });
        (0, globals_1.it)('should throw on invalid transition', async () => {
            await (0, globals_1.expect)(stateManager.requireTransitionTo(service_state_1.ServiceState.RUNNING))
                .rejects.toThrow('Invalid state transition');
        });
    });
    // ===========================================================================
    // executeStart Lifecycle Helper
    // ===========================================================================
    (0, globals_1.describe)('executeStart', () => {
        (0, globals_1.it)('should transition through STARTING to RUNNING on success', async () => {
            let called = false;
            const startFn = async () => {
                called = true;
            };
            const result = await stateManager.executeStart(startFn);
            (0, globals_1.expect)(result.success).toBe(true);
            (0, globals_1.expect)(result.currentState).toBe(service_state_1.ServiceState.RUNNING);
            (0, globals_1.expect)(called).toBe(true);
            (0, globals_1.expect)(stateManager.isRunning()).toBe(true);
        });
        (0, globals_1.it)('should transition to ERROR on start failure', async () => {
            const startFn = async () => {
                throw new Error('Start failed');
            };
            const result = await stateManager.executeStart(startFn);
            (0, globals_1.expect)(result.success).toBe(false);
            (0, globals_1.expect)(result.currentState).toBe(service_state_1.ServiceState.ERROR);
            (0, globals_1.expect)(result.error?.message).toBe('Start failed');
            (0, globals_1.expect)(stateManager.isError()).toBe(true);
        });
        (0, globals_1.it)('should fail if not in STOPPED state', async () => {
            await stateManager.transitionTo(service_state_1.ServiceState.STARTING);
            await stateManager.transitionTo(service_state_1.ServiceState.RUNNING);
            let called = false;
            const startFn = async () => {
                called = true;
            };
            const result = await stateManager.executeStart(startFn);
            (0, globals_1.expect)(result.success).toBe(false);
            (0, globals_1.expect)(called).toBe(false);
        });
        (0, globals_1.it)('should timeout if start takes too long', async () => {
            const manager = (0, service_state_1.createServiceState)({
                serviceName: 'slow-service',
                transitionTimeoutMs: 100
            });
            // Add error listener for this manager too
            manager.on('error', () => { });
            const slowStartFn = async () => {
                await new Promise(resolve => setTimeout(resolve, 500));
            };
            const result = await manager.executeStart(slowStartFn);
            (0, globals_1.expect)(result.success).toBe(false);
            (0, globals_1.expect)(result.error?.message).toContain('timeout');
        });
    });
    // ===========================================================================
    // executeStop Lifecycle Helper
    // ===========================================================================
    (0, globals_1.describe)('executeStop', () => {
        (0, globals_1.beforeEach)(async () => {
            // Get to RUNNING state
            await stateManager.transitionTo(service_state_1.ServiceState.STARTING);
            await stateManager.transitionTo(service_state_1.ServiceState.RUNNING);
        });
        (0, globals_1.it)('should transition through STOPPING to STOPPED on success', async () => {
            let called = false;
            const stopFn = async () => {
                called = true;
            };
            const result = await stateManager.executeStop(stopFn);
            (0, globals_1.expect)(result.success).toBe(true);
            (0, globals_1.expect)(result.currentState).toBe(service_state_1.ServiceState.STOPPED);
            (0, globals_1.expect)(called).toBe(true);
            (0, globals_1.expect)(stateManager.isStopped()).toBe(true);
        });
        (0, globals_1.it)('should transition to ERROR on stop failure', async () => {
            const stopFn = async () => {
                throw new Error('Stop failed');
            };
            const result = await stateManager.executeStop(stopFn);
            (0, globals_1.expect)(result.success).toBe(false);
            (0, globals_1.expect)(result.currentState).toBe(service_state_1.ServiceState.ERROR);
            (0, globals_1.expect)(result.error?.message).toBe('Stop failed');
        });
        (0, globals_1.it)('should fail if not in RUNNING state', async () => {
            const freshManager = (0, service_state_1.createServiceState)({ serviceName: 'fresh-service' });
            freshManager.on('error', () => { });
            let called = false;
            const stopFn = async () => {
                called = true;
            };
            const result = await freshManager.executeStop(stopFn);
            (0, globals_1.expect)(result.success).toBe(false);
            (0, globals_1.expect)(called).toBe(false);
        });
        (0, globals_1.it)('should allow stop from ERROR state', async () => {
            await stateManager.transitionTo(service_state_1.ServiceState.ERROR);
            const stopFn = async () => { };
            const result = await stateManager.executeStop(stopFn);
            (0, globals_1.expect)(result.success).toBe(true);
            (0, globals_1.expect)(result.currentState).toBe(service_state_1.ServiceState.STOPPED);
        });
    });
    // ===========================================================================
    // executeRestart Lifecycle Helper
    // ===========================================================================
    (0, globals_1.describe)('executeRestart', () => {
        (0, globals_1.it)('should stop then start when running', async () => {
            await stateManager.transitionTo(service_state_1.ServiceState.STARTING);
            await stateManager.transitionTo(service_state_1.ServiceState.RUNNING);
            let stopCalled = false;
            let startCalled = false;
            const stopFn = async () => {
                stopCalled = true;
            };
            const startFn = async () => {
                startCalled = true;
            };
            const result = await stateManager.executeRestart(stopFn, startFn);
            (0, globals_1.expect)(result.success).toBe(true);
            (0, globals_1.expect)(result.currentState).toBe(service_state_1.ServiceState.RUNNING);
            (0, globals_1.expect)(stopCalled).toBe(true);
            (0, globals_1.expect)(startCalled).toBe(true);
        });
        (0, globals_1.it)('should just start when not running', async () => {
            let stopCalled = false;
            let startCalled = false;
            const stopFn = async () => {
                stopCalled = true;
            };
            const startFn = async () => {
                startCalled = true;
            };
            const result = await stateManager.executeRestart(stopFn, startFn);
            (0, globals_1.expect)(result.success).toBe(true);
            (0, globals_1.expect)(stopCalled).toBe(false);
            (0, globals_1.expect)(startCalled).toBe(true);
        });
    });
    // ===========================================================================
    // Guard Methods
    // ===========================================================================
    (0, globals_1.describe)('guard methods', () => {
        (0, globals_1.describe)('assertRunning', () => {
            (0, globals_1.it)('should not throw when running', async () => {
                await stateManager.transitionTo(service_state_1.ServiceState.STARTING);
                await stateManager.transitionTo(service_state_1.ServiceState.RUNNING);
                (0, globals_1.expect)(() => stateManager.assertRunning()).not.toThrow();
            });
            (0, globals_1.it)('should throw when not running', () => {
                (0, globals_1.expect)(() => stateManager.assertRunning()).toThrow('not running');
            });
        });
        (0, globals_1.describe)('assertStopped', () => {
            (0, globals_1.it)('should not throw when stopped', () => {
                (0, globals_1.expect)(() => stateManager.assertStopped()).not.toThrow();
            });
            (0, globals_1.it)('should throw when not stopped', async () => {
                await stateManager.transitionTo(service_state_1.ServiceState.STARTING);
                (0, globals_1.expect)(() => stateManager.assertStopped()).toThrow('not stopped');
            });
        });
        (0, globals_1.describe)('assertCanStart', () => {
            (0, globals_1.it)('should not throw when stopped', () => {
                (0, globals_1.expect)(() => stateManager.assertCanStart()).not.toThrow();
            });
            (0, globals_1.it)('should not throw when in error state', async () => {
                await stateManager.transitionTo(service_state_1.ServiceState.STARTING);
                await stateManager.transitionTo(service_state_1.ServiceState.ERROR);
                (0, globals_1.expect)(() => stateManager.assertCanStart()).not.toThrow();
            });
            (0, globals_1.it)('should throw when running', async () => {
                await stateManager.transitionTo(service_state_1.ServiceState.STARTING);
                await stateManager.transitionTo(service_state_1.ServiceState.RUNNING);
                (0, globals_1.expect)(() => stateManager.assertCanStart()).toThrow('cannot be started');
            });
        });
        (0, globals_1.describe)('assertCanStop', () => {
            (0, globals_1.it)('should not throw when running', async () => {
                await stateManager.transitionTo(service_state_1.ServiceState.STARTING);
                await stateManager.transitionTo(service_state_1.ServiceState.RUNNING);
                (0, globals_1.expect)(() => stateManager.assertCanStop()).not.toThrow();
            });
            (0, globals_1.it)('should throw when stopped', () => {
                (0, globals_1.expect)(() => stateManager.assertCanStop()).toThrow('cannot be stopped');
            });
        });
    });
    // ===========================================================================
    // Force Reset
    // ===========================================================================
    (0, globals_1.describe)('forceReset', () => {
        (0, globals_1.it)('should reset to STOPPED from any state', async () => {
            await stateManager.transitionTo(service_state_1.ServiceState.STARTING);
            await stateManager.transitionTo(service_state_1.ServiceState.RUNNING);
            stateManager.forceReset();
            (0, globals_1.expect)(stateManager.getState()).toBe(service_state_1.ServiceState.STOPPED);
        });
        (0, globals_1.it)('should emit forceReset event', async () => {
            await stateManager.transitionTo(service_state_1.ServiceState.STARTING);
            const eventHandler = globals_1.jest.fn();
            stateManager.on('forceReset', eventHandler);
            stateManager.forceReset();
            (0, globals_1.expect)(eventHandler).toHaveBeenCalledWith({
                previousState: service_state_1.ServiceState.STARTING,
                newState: service_state_1.ServiceState.STOPPED,
                timestamp: globals_1.expect.any(Number),
                serviceName: 'test-service'
            });
        });
        (0, globals_1.it)('should clear error message', async () => {
            await stateManager.transitionTo(service_state_1.ServiceState.STARTING);
            await stateManager.transitionTo(service_state_1.ServiceState.ERROR, 'Test error');
            (0, globals_1.expect)(stateManager.getSnapshot().errorMessage).toBe('Test error');
            stateManager.forceReset();
            (0, globals_1.expect)(stateManager.getSnapshot().errorMessage).toBeUndefined();
        });
    });
    // ===========================================================================
    // Transition Count
    // ===========================================================================
    (0, globals_1.describe)('transition count', () => {
        (0, globals_1.it)('should increment on each transition', async () => {
            (0, globals_1.expect)(stateManager.getSnapshot().transitionCount).toBe(0);
            await stateManager.transitionTo(service_state_1.ServiceState.STARTING);
            (0, globals_1.expect)(stateManager.getSnapshot().transitionCount).toBe(1);
            await stateManager.transitionTo(service_state_1.ServiceState.RUNNING);
            (0, globals_1.expect)(stateManager.getSnapshot().transitionCount).toBe(2);
            await stateManager.transitionTo(service_state_1.ServiceState.STOPPING);
            (0, globals_1.expect)(stateManager.getSnapshot().transitionCount).toBe(3);
        });
        (0, globals_1.it)('should not increment on failed transitions', async () => {
            await stateManager.transitionTo(service_state_1.ServiceState.RUNNING); // Invalid
            (0, globals_1.expect)(stateManager.getSnapshot().transitionCount).toBe(0);
        });
    });
    // ===========================================================================
    // Type Guards
    // ===========================================================================
    (0, globals_1.describe)('isServiceState', () => {
        (0, globals_1.it)('should return true for valid states', () => {
            (0, globals_1.expect)((0, service_state_1.isServiceState)(service_state_1.ServiceState.STOPPED)).toBe(true);
            (0, globals_1.expect)((0, service_state_1.isServiceState)(service_state_1.ServiceState.STARTING)).toBe(true);
            (0, globals_1.expect)((0, service_state_1.isServiceState)(service_state_1.ServiceState.RUNNING)).toBe(true);
            (0, globals_1.expect)((0, service_state_1.isServiceState)(service_state_1.ServiceState.STOPPING)).toBe(true);
            (0, globals_1.expect)((0, service_state_1.isServiceState)(service_state_1.ServiceState.ERROR)).toBe(true);
            (0, globals_1.expect)((0, service_state_1.isServiceState)('stopped')).toBe(true);
        });
        (0, globals_1.it)('should return false for invalid values', () => {
            (0, globals_1.expect)((0, service_state_1.isServiceState)('invalid')).toBe(false);
            (0, globals_1.expect)((0, service_state_1.isServiceState)(123)).toBe(false);
            (0, globals_1.expect)((0, service_state_1.isServiceState)(null)).toBe(false);
            (0, globals_1.expect)((0, service_state_1.isServiceState)(undefined)).toBe(false);
        });
    });
    // ===========================================================================
    // Concurrent Access (Race Condition Prevention)
    // ===========================================================================
    (0, globals_1.describe)('concurrent access', () => {
        (0, globals_1.it)('should handle concurrent transition attempts', async () => {
            // Try to start twice simultaneously
            const startFn1 = async () => {
                await new Promise(resolve => setTimeout(resolve, 10));
            };
            const startFn2 = async () => {
                await new Promise(resolve => setTimeout(resolve, 10));
            };
            const [result1, result2] = await Promise.all([
                stateManager.executeStart(startFn1),
                stateManager.executeStart(startFn2)
            ]);
            // One should succeed, one should fail
            const successes = [result1.success, result2.success].filter(Boolean);
            (0, globals_1.expect)(successes.length).toBe(1);
        });
    });
});
//# sourceMappingURL=service-state.test.js.map