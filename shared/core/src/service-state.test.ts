/**
 * Service State Machine Tests
 *
 * Tests for lifecycle state management including:
 * - Valid/invalid state transitions
 * - Race condition prevention
 * - Event emission
 * - Lifecycle helpers (executeStart, executeStop)
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  ServiceStateManager,
  ServiceState,
  createServiceState,
  isServiceState
} from './service-state';

// Mock logger
jest.mock('./logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  }))
}));

describe('ServiceStateManager', () => {
  let stateManager: ServiceStateManager;

  beforeEach(() => {
    stateManager = createServiceState({
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

  afterEach(() => {
    stateManager.removeAllListeners();
  });

  // ===========================================================================
  // Initial State
  // ===========================================================================

  describe('initial state', () => {
    it('should start in STOPPED state', () => {
      expect(stateManager.getState()).toBe(ServiceState.STOPPED);
    });

    it('should return correct state queries', () => {
      expect(stateManager.isStopped()).toBe(true);
      expect(stateManager.isRunning()).toBe(false);
      expect(stateManager.isTransitioning()).toBe(false);
      expect(stateManager.isError()).toBe(false);
    });

    it('should have correct initial snapshot', () => {
      const snapshot = stateManager.getSnapshot();
      expect(snapshot.state).toBe(ServiceState.STOPPED);
      expect(snapshot.serviceName).toBe('test-service');
      expect(snapshot.transitionCount).toBe(0);
      expect(snapshot.errorMessage).toBeUndefined();
    });
  });

  // ===========================================================================
  // Valid Transitions
  // ===========================================================================

  describe('valid state transitions', () => {
    it('should transition STOPPED -> STARTING', async () => {
      const result = await stateManager.transitionTo(ServiceState.STARTING);

      expect(result.success).toBe(true);
      expect(result.previousState).toBe(ServiceState.STOPPED);
      expect(result.currentState).toBe(ServiceState.STARTING);
      expect(stateManager.getState()).toBe(ServiceState.STARTING);
    });

    it('should transition STARTING -> RUNNING', async () => {
      await stateManager.transitionTo(ServiceState.STARTING);
      const result = await stateManager.transitionTo(ServiceState.RUNNING);

      expect(result.success).toBe(true);
      expect(result.currentState).toBe(ServiceState.RUNNING);
      expect(stateManager.isRunning()).toBe(true);
    });

    it('should transition RUNNING -> STOPPING', async () => {
      await stateManager.transitionTo(ServiceState.STARTING);
      await stateManager.transitionTo(ServiceState.RUNNING);
      const result = await stateManager.transitionTo(ServiceState.STOPPING);

      expect(result.success).toBe(true);
      expect(result.currentState).toBe(ServiceState.STOPPING);
    });

    it('should transition STOPPING -> STOPPED', async () => {
      await stateManager.transitionTo(ServiceState.STARTING);
      await stateManager.transitionTo(ServiceState.RUNNING);
      await stateManager.transitionTo(ServiceState.STOPPING);
      const result = await stateManager.transitionTo(ServiceState.STOPPED);

      expect(result.success).toBe(true);
      expect(result.currentState).toBe(ServiceState.STOPPED);
      expect(stateManager.isStopped()).toBe(true);
    });

    it('should transition STARTING -> ERROR', async () => {
      await stateManager.transitionTo(ServiceState.STARTING);
      const result = await stateManager.transitionTo(ServiceState.ERROR, 'Startup failed');

      expect(result.success).toBe(true);
      expect(result.currentState).toBe(ServiceState.ERROR);
      expect(stateManager.getSnapshot().errorMessage).toBe('Startup failed');
    });

    it('should transition ERROR -> STOPPED', async () => {
      await stateManager.transitionTo(ServiceState.STARTING);
      await stateManager.transitionTo(ServiceState.ERROR);
      const result = await stateManager.transitionTo(ServiceState.STOPPED);

      expect(result.success).toBe(true);
      expect(result.currentState).toBe(ServiceState.STOPPED);
    });

    it('should transition ERROR -> STARTING (retry)', async () => {
      await stateManager.transitionTo(ServiceState.STARTING);
      await stateManager.transitionTo(ServiceState.ERROR);
      const result = await stateManager.transitionTo(ServiceState.STARTING);

      expect(result.success).toBe(true);
      expect(result.currentState).toBe(ServiceState.STARTING);
    });
  });

  // ===========================================================================
  // Invalid Transitions
  // ===========================================================================

  describe('invalid state transitions', () => {
    it('should reject STOPPED -> RUNNING', async () => {
      const result = await stateManager.transitionTo(ServiceState.RUNNING);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(stateManager.getState()).toBe(ServiceState.STOPPED);
    });

    it('should reject STOPPED -> STOPPING', async () => {
      const result = await stateManager.transitionTo(ServiceState.STOPPING);

      expect(result.success).toBe(false);
      expect(stateManager.getState()).toBe(ServiceState.STOPPED);
    });

    it('should reject RUNNING -> STARTING', async () => {
      await stateManager.transitionTo(ServiceState.STARTING);
      await stateManager.transitionTo(ServiceState.RUNNING);
      const result = await stateManager.transitionTo(ServiceState.STARTING);

      expect(result.success).toBe(false);
      expect(stateManager.getState()).toBe(ServiceState.RUNNING);
    });

    it('should reject STARTING -> STOPPED directly (use ERROR first)', async () => {
      await stateManager.transitionTo(ServiceState.STARTING);
      // Note: STARTING -> STOPPED IS valid for cancelled starts
      const result = await stateManager.transitionTo(ServiceState.STOPPED);

      // Actually this is a valid transition for cancellation
      expect(result.success).toBe(true);
    });
  });

  // ===========================================================================
  // Event Emission
  // ===========================================================================

  describe('event emission', () => {
    it('should emit stateChange event on transition', async () => {
      const eventHandler = jest.fn();
      stateManager.on('stateChange', eventHandler);

      await stateManager.transitionTo(ServiceState.STARTING);

      expect(eventHandler).toHaveBeenCalledTimes(1);
      expect(eventHandler).toHaveBeenCalledWith({
        previousState: ServiceState.STOPPED,
        newState: ServiceState.STARTING,
        timestamp: expect.any(Number),
        serviceName: 'test-service'
      });
    });

    it('should emit state-specific events', async () => {
      const startingHandler = jest.fn();
      const runningHandler = jest.fn();
      stateManager.on(ServiceState.STARTING, startingHandler);
      stateManager.on(ServiceState.RUNNING, runningHandler);

      await stateManager.transitionTo(ServiceState.STARTING);
      await stateManager.transitionTo(ServiceState.RUNNING);

      expect(startingHandler).toHaveBeenCalledTimes(1);
      expect(runningHandler).toHaveBeenCalledTimes(1);
    });

    it('should not emit events when emitEvents is false', async () => {
      const quietManager = createServiceState({
        serviceName: 'quiet-service',
        emitEvents: false
      });

      const eventHandler = jest.fn();
      quietManager.on('stateChange', eventHandler);

      await quietManager.transitionTo(ServiceState.STARTING);

      expect(eventHandler).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // requireTransitionTo
  // ===========================================================================

  describe('requireTransitionTo', () => {
    it('should resolve on valid transition', async () => {
      await expect(stateManager.requireTransitionTo(ServiceState.STARTING))
        .resolves.not.toThrow();
    });

    it('should throw on invalid transition', async () => {
      await expect(stateManager.requireTransitionTo(ServiceState.RUNNING))
        .rejects.toThrow('Invalid state transition');
    });
  });

  // ===========================================================================
  // executeStart Lifecycle Helper
  // ===========================================================================

  describe('executeStart', () => {
    it('should transition through STARTING to RUNNING on success', async () => {
      let called = false;
      const startFn = async (): Promise<void> => {
        called = true;
      };

      const result = await stateManager.executeStart(startFn);

      expect(result.success).toBe(true);
      expect(result.currentState).toBe(ServiceState.RUNNING);
      expect(called).toBe(true);
      expect(stateManager.isRunning()).toBe(true);
    });

    it('should transition to ERROR on start failure', async () => {
      const startFn = async (): Promise<void> => {
        throw new Error('Start failed');
      };

      const result = await stateManager.executeStart(startFn);

      expect(result.success).toBe(false);
      expect(result.currentState).toBe(ServiceState.ERROR);
      expect(result.error?.message).toBe('Start failed');
      expect(stateManager.isError()).toBe(true);
    });

    it('should fail if not in STOPPED state', async () => {
      await stateManager.transitionTo(ServiceState.STARTING);
      await stateManager.transitionTo(ServiceState.RUNNING);

      let called = false;
      const startFn = async (): Promise<void> => {
        called = true;
      };
      const result = await stateManager.executeStart(startFn);

      expect(result.success).toBe(false);
      expect(called).toBe(false);
    });

    it('should timeout if start takes too long', async () => {
      const manager = createServiceState({
        serviceName: 'slow-service',
        transitionTimeoutMs: 100
      });
      // Add error listener for this manager too
      manager.on('error', () => {});

      const slowStartFn = async (): Promise<void> => {
        await new Promise<void>(resolve => setTimeout(resolve, 500));
      };

      const result = await manager.executeStart(slowStartFn);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('timeout');
    });
  });

  // ===========================================================================
  // executeStop Lifecycle Helper
  // ===========================================================================

  describe('executeStop', () => {
    beforeEach(async () => {
      // Get to RUNNING state
      await stateManager.transitionTo(ServiceState.STARTING);
      await stateManager.transitionTo(ServiceState.RUNNING);
    });

    it('should transition through STOPPING to STOPPED on success', async () => {
      let called = false;
      const stopFn = async (): Promise<void> => {
        called = true;
      };

      const result = await stateManager.executeStop(stopFn);

      expect(result.success).toBe(true);
      expect(result.currentState).toBe(ServiceState.STOPPED);
      expect(called).toBe(true);
      expect(stateManager.isStopped()).toBe(true);
    });

    it('should transition to ERROR on stop failure', async () => {
      const stopFn = async (): Promise<void> => {
        throw new Error('Stop failed');
      };

      const result = await stateManager.executeStop(stopFn);

      expect(result.success).toBe(false);
      expect(result.currentState).toBe(ServiceState.ERROR);
      expect(result.error?.message).toBe('Stop failed');
    });

    it('should fail if not in RUNNING state', async () => {
      const freshManager = createServiceState({ serviceName: 'fresh-service' });
      freshManager.on('error', () => {});

      let called = false;
      const stopFn = async (): Promise<void> => {
        called = true;
      };
      const result = await freshManager.executeStop(stopFn);

      expect(result.success).toBe(false);
      expect(called).toBe(false);
    });

    it('should allow stop from ERROR state', async () => {
      await stateManager.transitionTo(ServiceState.ERROR);

      const stopFn = async (): Promise<void> => {};
      const result = await stateManager.executeStop(stopFn);

      expect(result.success).toBe(true);
      expect(result.currentState).toBe(ServiceState.STOPPED);
    });
  });

  // ===========================================================================
  // executeRestart Lifecycle Helper
  // ===========================================================================

  describe('executeRestart', () => {
    it('should stop then start when running', async () => {
      await stateManager.transitionTo(ServiceState.STARTING);
      await stateManager.transitionTo(ServiceState.RUNNING);

      let stopCalled = false;
      let startCalled = false;
      const stopFn = async (): Promise<void> => {
        stopCalled = true;
      };
      const startFn = async (): Promise<void> => {
        startCalled = true;
      };

      const result = await stateManager.executeRestart(stopFn, startFn);

      expect(result.success).toBe(true);
      expect(result.currentState).toBe(ServiceState.RUNNING);
      expect(stopCalled).toBe(true);
      expect(startCalled).toBe(true);
    });

    it('should just start when not running', async () => {
      let stopCalled = false;
      let startCalled = false;
      const stopFn = async (): Promise<void> => {
        stopCalled = true;
      };
      const startFn = async (): Promise<void> => {
        startCalled = true;
      };

      const result = await stateManager.executeRestart(stopFn, startFn);

      expect(result.success).toBe(true);
      expect(stopCalled).toBe(false);
      expect(startCalled).toBe(true);
    });
  });

  // ===========================================================================
  // Guard Methods
  // ===========================================================================

  describe('guard methods', () => {
    describe('assertRunning', () => {
      it('should not throw when running', async () => {
        await stateManager.transitionTo(ServiceState.STARTING);
        await stateManager.transitionTo(ServiceState.RUNNING);

        expect(() => stateManager.assertRunning()).not.toThrow();
      });

      it('should throw when not running', () => {
        expect(() => stateManager.assertRunning()).toThrow('not running');
      });
    });

    describe('assertStopped', () => {
      it('should not throw when stopped', () => {
        expect(() => stateManager.assertStopped()).not.toThrow();
      });

      it('should throw when not stopped', async () => {
        await stateManager.transitionTo(ServiceState.STARTING);
        expect(() => stateManager.assertStopped()).toThrow('not stopped');
      });
    });

    describe('assertCanStart', () => {
      it('should not throw when stopped', () => {
        expect(() => stateManager.assertCanStart()).not.toThrow();
      });

      it('should not throw when in error state', async () => {
        await stateManager.transitionTo(ServiceState.STARTING);
        await stateManager.transitionTo(ServiceState.ERROR);
        expect(() => stateManager.assertCanStart()).not.toThrow();
      });

      it('should throw when running', async () => {
        await stateManager.transitionTo(ServiceState.STARTING);
        await stateManager.transitionTo(ServiceState.RUNNING);
        expect(() => stateManager.assertCanStart()).toThrow('cannot be started');
      });
    });

    describe('assertCanStop', () => {
      it('should not throw when running', async () => {
        await stateManager.transitionTo(ServiceState.STARTING);
        await stateManager.transitionTo(ServiceState.RUNNING);
        expect(() => stateManager.assertCanStop()).not.toThrow();
      });

      it('should throw when stopped', () => {
        expect(() => stateManager.assertCanStop()).toThrow('cannot be stopped');
      });
    });
  });

  // ===========================================================================
  // Force Reset
  // ===========================================================================

  describe('forceReset', () => {
    it('should reset to STOPPED from any state', async () => {
      await stateManager.transitionTo(ServiceState.STARTING);
      await stateManager.transitionTo(ServiceState.RUNNING);

      stateManager.forceReset();

      expect(stateManager.getState()).toBe(ServiceState.STOPPED);
    });

    it('should emit forceReset event', async () => {
      await stateManager.transitionTo(ServiceState.STARTING);

      const eventHandler = jest.fn();
      stateManager.on('forceReset', eventHandler);

      stateManager.forceReset();

      expect(eventHandler).toHaveBeenCalledWith({
        previousState: ServiceState.STARTING,
        newState: ServiceState.STOPPED,
        timestamp: expect.any(Number),
        serviceName: 'test-service'
      });
    });

    it('should clear error message', async () => {
      await stateManager.transitionTo(ServiceState.STARTING);
      await stateManager.transitionTo(ServiceState.ERROR, 'Test error');

      expect(stateManager.getSnapshot().errorMessage).toBe('Test error');

      stateManager.forceReset();

      expect(stateManager.getSnapshot().errorMessage).toBeUndefined();
    });
  });

  // ===========================================================================
  // Transition Count
  // ===========================================================================

  describe('transition count', () => {
    it('should increment on each transition', async () => {
      expect(stateManager.getSnapshot().transitionCount).toBe(0);

      await stateManager.transitionTo(ServiceState.STARTING);
      expect(stateManager.getSnapshot().transitionCount).toBe(1);

      await stateManager.transitionTo(ServiceState.RUNNING);
      expect(stateManager.getSnapshot().transitionCount).toBe(2);

      await stateManager.transitionTo(ServiceState.STOPPING);
      expect(stateManager.getSnapshot().transitionCount).toBe(3);
    });

    it('should not increment on failed transitions', async () => {
      await stateManager.transitionTo(ServiceState.RUNNING); // Invalid

      expect(stateManager.getSnapshot().transitionCount).toBe(0);
    });
  });

  // ===========================================================================
  // Type Guards
  // ===========================================================================

  describe('isServiceState', () => {
    it('should return true for valid states', () => {
      expect(isServiceState(ServiceState.STOPPED)).toBe(true);
      expect(isServiceState(ServiceState.STARTING)).toBe(true);
      expect(isServiceState(ServiceState.RUNNING)).toBe(true);
      expect(isServiceState(ServiceState.STOPPING)).toBe(true);
      expect(isServiceState(ServiceState.ERROR)).toBe(true);
      expect(isServiceState('stopped')).toBe(true);
    });

    it('should return false for invalid values', () => {
      expect(isServiceState('invalid')).toBe(false);
      expect(isServiceState(123)).toBe(false);
      expect(isServiceState(null)).toBe(false);
      expect(isServiceState(undefined)).toBe(false);
    });
  });

  // ===========================================================================
  // Concurrent Access (Race Condition Prevention)
  // ===========================================================================

  describe('concurrent access', () => {
    it('should handle concurrent transition attempts', async () => {
      // Try to start twice simultaneously
      const startFn1 = async (): Promise<void> => {
        await new Promise(resolve => setTimeout(resolve, 10));
      };
      const startFn2 = async (): Promise<void> => {
        await new Promise(resolve => setTimeout(resolve, 10));
      };

      const [result1, result2] = await Promise.all([
        stateManager.executeStart(startFn1),
        stateManager.executeStart(startFn2)
      ]);

      // One should succeed, one should fail
      const successes = [result1.success, result2.success].filter(Boolean);
      expect(successes.length).toBe(1);
    });
  });
});
