/**
 * Test Helpers
 *
 * Provides utilities for common testing patterns including:
 * - Timer management (fake/real timers)
 * - Async utilities
 * - Test isolation helpers
 *
 * @see P2-TEST from refactoring-roadmap.md
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
