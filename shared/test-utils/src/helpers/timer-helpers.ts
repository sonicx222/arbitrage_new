/**
 * Timer Helpers for Test Consistency
 *
 * Provides standardized utilities for managing Jest fake timers in tests.
 * These helpers ensure consistent timer behavior and proper cleanup.
 *
 * ## Usage
 *
 * ```typescript
 * import { withFakeTimers, withRealTimers, TimerScope } from '@arbitrage/test-utils';
 *
 * // Using scoped helpers (recommended)
 * it('should handle timeouts', async () => {
 *   await withFakeTimers(async () => {
 *     const callback = jest.fn();
 *     setTimeout(callback, 1000);
 *     jest.advanceTimersByTime(1000);
 *     expect(callback).toHaveBeenCalled();
 *   });
 * });
 *
 * // Using TimerScope class for describe blocks
 * describe('TimedFeature', () => {
 *   const timerScope = new TimerScope('fake');
 *
 *   beforeEach(() => timerScope.setup());
 *   afterEach(() => timerScope.teardown());
 *
 *   it('uses fake timers', () => {
 *     // ...
 *   });
 * });
 * ```
 *
 * @see P2-TEST from refactoring-roadmap.md
 */

type TimerMode = 'fake' | 'real' | 'modern' | 'legacy';

/**
 * Track whether fake timers are currently active.
 * This is more reliable than checking jest.isMockFunction(setTimeout).
 */
let _fakeTimersActive = false;

/**
 * Check if fake timers are currently active.
 */
export function areFakeTimersActive(): boolean {
  return _fakeTimersActive;
}

/**
 * Configuration for fake timer setup
 */
export interface FakeTimerConfig {
  /**
   * Timer implementation to use
   * - 'modern': Uses modern fake timers (recommended, default)
   * - 'legacy': Uses legacy fake timers (for compatibility)
   */
  implementation?: 'modern' | 'legacy';

  /**
   * Whether to advance timers automatically on each tick
   * Default: false
   */
  advanceTimers?: boolean | number;

  /**
   * APIs to fake. Default is all timer APIs.
   */
  doNotFake?: Array<
    'Date' | 'hrtime' | 'nextTick' | 'performance' |
    'queueMicrotask' | 'requestAnimationFrame' |
    'cancelAnimationFrame' | 'requestIdleCallback' |
    'cancelIdleCallback' | 'setImmediate' | 'clearImmediate' |
    'setInterval' | 'clearInterval' | 'setTimeout' | 'clearTimeout'
  >;

  /**
   * Initial "now" time for Date.now() and new Date()
   */
  now?: number | Date;

  /**
   * Maximum number of recursive timers to run
   */
  timerLimit?: number;
}

/**
 * Execute a function with fake timers, ensuring proper cleanup.
 *
 * This is the recommended approach for individual tests that need fake timers.
 * The timers are automatically restored after the function completes, even if
 * it throws an error.
 *
 * @param fn - Async function to execute with fake timers
 * @param config - Optional fake timer configuration
 *
 * @example
 * ```typescript
 * it('should debounce calls', async () => {
 *   await withFakeTimers(async () => {
 *     const debounced = debounce(callback, 100);
 *     debounced();
 *     debounced();
 *     debounced();
 *
 *     jest.advanceTimersByTime(100);
 *     expect(callback).toHaveBeenCalledTimes(1);
 *   });
 * });
 * ```
 */
export async function withFakeTimers(
  fn: () => Promise<void> | void,
  config?: FakeTimerConfig
): Promise<void> {
  const wasUsingFakeTimers = _fakeTimersActive;

  try {
    if (config) {
      jest.useFakeTimers(config);
    } else {
      jest.useFakeTimers();
    }
    _fakeTimersActive = true;

    await fn();
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
    _fakeTimersActive = false;

    // Restore previous timer state if needed
    if (wasUsingFakeTimers) {
      jest.useFakeTimers(config);
      _fakeTimersActive = true;
    }
  }
}

/**
 * Execute a function with real timers, useful when tests in a fake timer
 * context need to use real async operations.
 *
 * Note: This should be used sparingly. If you find yourself needing this
 * frequently, consider restructuring your tests.
 *
 * @param fn - Async function to execute with real timers
 *
 * @example
 * ```typescript
 * it('should work with setImmediate', async () => {
 *   // setImmediate doesn't work well with fake timers
 *   await withRealTimers(async () => {
 *     await new Promise(resolve => setImmediate(resolve));
 *     expect(something).toBe(true);
 *   });
 * });
 * ```
 */
export async function withRealTimers(fn: () => Promise<void> | void): Promise<void> {
  const wasUsingFakeTimers = _fakeTimersActive;

  try {
    if (wasUsingFakeTimers) {
      // Store current timer state before switching
      jest.clearAllTimers();
    }
    jest.useRealTimers();
    _fakeTimersActive = false;

    await fn();
  } finally {
    // Restore fake timers if they were active
    if (wasUsingFakeTimers) {
      jest.useFakeTimers();
      _fakeTimersActive = true;
    }
  }
}

/**
 * Advance timers and flush all pending microtasks/promises.
 *
 * This is useful when testing code that mixes timers with promises,
 * ensuring all async operations settle before assertions.
 *
 * @param ms - Milliseconds to advance timers by
 *
 * @example
 * ```typescript
 * it('should process after delay', async () => {
 *   startAsyncProcess(); // Uses setTimeout + promises
 *
 *   await advanceTimersAndFlush(1000);
 *
 *   expect(processComplete).toBe(true);
 * });
 * ```
 */
export async function advanceTimersAndFlush(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms);
  // Flush microtask queue using multiple await ticks
  // This works because Promise.resolve() schedules on the microtask queue
  // which is processed between each await
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * Run all pending timers and flush promises.
 *
 * Be careful with this - it will run ALL pending timers, which could
 * lead to infinite loops with repeating intervals.
 *
 * @example
 * ```typescript
 * it('should complete all scheduled work', async () => {
 *   scheduleMultipleTimeouts();
 *
 *   await runAllTimersAndFlush();
 *
 *   expect(allWorkComplete).toBe(true);
 * });
 * ```
 */
export async function runAllTimersAndFlush(): Promise<void> {
  jest.runAllTimers();
  // Flush microtask queue
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * Run only the currently pending timers (not timers scheduled by callbacks).
 *
 * This is safer than runAllTimers when dealing with intervals.
 *
 * @example
 * ```typescript
 * it('should process pending timeouts', async () => {
 *   setTimeout(callback1, 100);
 *   setTimeout(callback2, 200);
 *
 *   await runPendingTimersAndFlush();
 *
 *   expect(callback1).toHaveBeenCalled();
 *   expect(callback2).toHaveBeenCalled();
 * });
 * ```
 */
export async function runPendingTimersAndFlush(): Promise<void> {
  jest.runOnlyPendingTimers();
  // Flush microtask queue
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * Timer scope manager for describe blocks.
 *
 * Use this class when you need consistent timer behavior across
 * multiple tests in a describe block.
 *
 * @example
 * ```typescript
 * describe('ScheduledTask', () => {
 *   const timerScope = new TimerScope('fake');
 *
 *   beforeEach(() => timerScope.setup());
 *   afterEach(() => timerScope.teardown());
 *
 *   it('should schedule correctly', () => {
 *     // fake timers are active here
 *   });
 *
 *   describe('real-time operations', () => {
 *     beforeEach(() => timerScope.setMode('real'));
 *     afterEach(() => timerScope.setMode('fake'));
 *
 *     it('uses real timers', async () => {
 *       await new Promise(r => setTimeout(r, 10));
 *     });
 *   });
 * });
 * ```
 */
export class TimerScope {
  private mode: TimerMode;
  private config?: FakeTimerConfig;
  private isSetup = false;

  constructor(mode: TimerMode = 'fake', config?: FakeTimerConfig) {
    this.mode = mode;
    this.config = config;
  }

  /**
   * Setup timers according to the current mode.
   * Call this in beforeEach().
   */
  setup(): void {
    if (this.isSetup) {
      this.teardown();
    }

    if (this.mode === 'fake' || this.mode === 'modern' || this.mode === 'legacy') {
      const config: FakeTimerConfig = {
        ...this.config,
        ...(this.mode === 'legacy' ? { implementation: 'legacy' } : {}),
      };
      jest.useFakeTimers(config);
    } else {
      jest.useRealTimers();
    }

    this.isSetup = true;
  }

  /**
   * Teardown timers and restore real timers.
   * Call this in afterEach().
   */
  teardown(): void {
    if (this.isSetup) {
      jest.clearAllTimers();
      jest.useRealTimers();
      this.isSetup = false;
    }
  }

  /**
   * Change the timer mode mid-test.
   * Useful for nested describe blocks.
   */
  setMode(mode: TimerMode): void {
    this.mode = mode;
    if (this.isSetup) {
      this.teardown();
      this.setup();
    }
  }

  /**
   * Get the current timer mode.
   */
  getMode(): TimerMode {
    return this.mode;
  }

  /**
   * Check if currently using fake timers.
   */
  isFake(): boolean {
    return this.mode !== 'real' && this.isSetup;
  }
}

/**
 * Create a TimerScope preset for common use cases.
 */
export const TimerPresets = {
  /**
   * Standard fake timers for unit tests
   */
  unit: () => new TimerScope('fake'),

  /**
   * Fake timers that don't fake Date (useful for timestamp-sensitive code)
   */
  unitWithRealDate: () => new TimerScope('fake', { doNotFake: ['Date'] }),

  /**
   * Real timers for integration tests
   */
  integration: () => new TimerScope('real'),

  /**
   * Legacy fake timers for compatibility
   */
  legacy: () => new TimerScope('legacy'),
} as const;

/**
 * Wait for a condition to be true, with fake timer support.
 *
 * This is useful for testing async code that depends on timers.
 *
 * @param condition - Function that returns true when condition is met
 * @param options - Configuration options
 *
 * @example
 * ```typescript
 * it('should eventually complete', async () => {
 *   startProcess();
 *
 *   await waitForCondition(() => isComplete, {
 *     timeout: 5000,
 *     interval: 100,
 *   });
 *
 *   expect(isComplete).toBe(true);
 * });
 * ```
 */
export async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  options: {
    timeout?: number;
    interval?: number;
    advanceTimers?: boolean;
  } = {}
): Promise<void> {
  const { timeout = 5000, interval = 100, advanceTimers = true } = options;
  const startTime = Date.now();

  while (true) {
    const result = await condition();
    if (result) return;

    if (Date.now() - startTime > timeout) {
      throw new Error(`Condition not met within ${timeout}ms`);
    }

    if (advanceTimers && _fakeTimersActive) {
      jest.advanceTimersByTime(interval);
    }

    await Promise.resolve();
  }
}
