/**
 * Test Helpers
 *
 * Provides utilities for common testing patterns including:
 * - Timer management (fake/real timers)
 * - Async utilities
 * - Test isolation helpers
 * - Test state management (beforeAll/beforeEach patterns)
 *
 * @see ADR-009: Test Architecture
 */

export {
  // Timer scope management
  withFakeTimers,
  withRealTimers,
  TimerScope,
  TimerPresets,
  areFakeTimersActive,

  // Timer advancement utilities
  advanceTimersAndFlush,
  runAllTimersAndFlush,
  runPendingTimersAndFlush,

  // Async helpers
  waitForCondition,

  // Types
  FakeTimerConfig,
} from './timer-helpers';

export {
  // Test state management
  Resettable,
  verifyResettable,
  createResetHook,
  resetStateHelper,
  ResettableClass,
} from './test-state-management';

export {
  // Chaos testing
  createChaosController,
  withChaos,
  createChaosRedisClient,
  createChaosRpcProvider,
  NetworkPartitionSimulator,
  withChaosTest,
  waitForCondition as waitForChaosCondition,
  type ChaosConfig,
} from './chaos-testing';
