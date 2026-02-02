/**
 * Tests for Timer Helpers
 *
 * @see P2-TEST from refactoring-roadmap.md
 */

import {
  withFakeTimers,
  withRealTimers,
  advanceTimersAndFlush,
  runPendingTimersAndFlush,
  TimerScope,
  TimerPresets,
  waitForCondition,
  areFakeTimersActive,
} from '../../../src/helpers/timer-helpers';

describe('TimerHelpers', () => {
  // Always restore real timers after each test
  afterEach(() => {
    jest.useRealTimers();
  });

  describe('withFakeTimers', () => {
    it('should execute callback with fake timers', async () => {
      let wasFake = false;

      await withFakeTimers(() => {
        wasFake = areFakeTimersActive();
      });

      expect(wasFake).toBe(true);
    });

    it('should restore real timers after execution', async () => {
      await withFakeTimers(() => {
        // Do something with fake timers
      });

      // Real timers should be restored
      expect(areFakeTimersActive()).toBe(false);
    });

    it('should restore real timers even on error', async () => {
      await expect(
        withFakeTimers(() => {
          throw new Error('Test error');
        })
      ).rejects.toThrow('Test error');

      // Real timers should still be restored
      expect(areFakeTimersActive()).toBe(false);
    });

    it('should allow timer advancement within callback', async () => {
      const callback = jest.fn();

      await withFakeTimers(() => {
        setTimeout(callback, 1000);
        expect(callback).not.toHaveBeenCalled();

        jest.advanceTimersByTime(1000);
        expect(callback).toHaveBeenCalledTimes(1);
      });
    });

    it('should support async callbacks', async () => {
      const results: string[] = [];

      await withFakeTimers(async () => {
        setTimeout(() => results.push('timer'), 100);
        results.push('before');

        jest.advanceTimersByTime(100);
        await Promise.resolve();

        results.push('after');
      });

      expect(results).toEqual(['before', 'timer', 'after']);
    });
  });

  describe('withRealTimers', () => {
    it('should execute callback with real timers', async () => {
      await withFakeTimers(async () => {
        expect(areFakeTimersActive()).toBe(true);

        await withRealTimers(() => {
          expect(areFakeTimersActive()).toBe(false);
        });
      });
    });

    it('should restore fake timers after if they were active', async () => {
      await withFakeTimers(async () => {
        const wasFakeBefore = areFakeTimersActive();

        await withRealTimers(() => {
          // Do something with real timers
        });

        // Should restore fake timers
        expect(wasFakeBefore).toBe(true);
        expect(areFakeTimersActive()).toBe(true);
      });
    });

    it('should work with setImmediate', async () => {
      let executed = false;

      await withFakeTimers(async () => {
        await withRealTimers(async () => {
          await new Promise<void>(resolve => {
            setImmediate(() => {
              executed = true;
              resolve();
            });
          });
        });
      });

      expect(executed).toBe(true);
    });
  });

  describe('advanceTimersAndFlush', () => {
    it('should advance timers and flush promises', async () => {
      await withFakeTimers(async () => {
        const results: string[] = [];

        setTimeout(() => {
          results.push('timeout');
          Promise.resolve().then(() => results.push('promise-after-timeout'));
        }, 100);

        await advanceTimersAndFlush(100);

        expect(results).toContain('timeout');
        expect(results).toContain('promise-after-timeout');
      });
    });
  });

  describe('runPendingTimersAndFlush', () => {
    it('should run only pending timers', async () => {
      await withFakeTimers(async () => {
        const callback1 = jest.fn();
        const callback2 = jest.fn();

        setTimeout(callback1, 100);
        setTimeout(callback2, 200);

        await runPendingTimersAndFlush();

        expect(callback1).toHaveBeenCalled();
        expect(callback2).toHaveBeenCalled();
      });
    });
  });

  describe('TimerScope', () => {
    it('should setup fake timers on setup()', () => {
      const scope = new TimerScope('fake');

      scope.setup();
      expect(scope.isFake()).toBe(true);

      scope.teardown();
    });

    it('should setup real timers when mode is real', () => {
      const scope = new TimerScope('real');
      scope.setup();

      expect(scope.isFake()).toBe(false);

      scope.teardown();
    });

    it('should restore real timers on teardown()', () => {
      const scope = new TimerScope('fake');

      scope.setup();
      scope.teardown();

      expect(scope.isFake()).toBe(false);
    });

    it('should allow mode changes', () => {
      const scope = new TimerScope('fake');
      scope.setup();

      expect(scope.isFake()).toBe(true);

      scope.setMode('real');
      expect(scope.isFake()).toBe(false);

      scope.teardown();
    });

    it('should clear all timers on teardown', async () => {
      await withFakeTimers(async () => {
        const scope = new TimerScope('fake');
        scope.setup();

        const callback = jest.fn();
        setTimeout(callback, 1000);

        scope.teardown();

        // Timer should be cleared, not run
        jest.useFakeTimers();
        jest.advanceTimersByTime(2000);
        expect(callback).not.toHaveBeenCalled();
      });
    });
  });

  describe('TimerPresets', () => {
    it('should create unit timer scope with fake timers', () => {
      const scope = TimerPresets.unit();
      scope.setup();

      expect(scope.isFake()).toBe(true);

      scope.teardown();
    });

    it('should create integration timer scope with real timers', () => {
      const scope = TimerPresets.integration();
      scope.setup();

      expect(scope.isFake()).toBe(false);

      scope.teardown();
    });
  });

  describe('waitForCondition', () => {
    it('should resolve when condition becomes true', async () => {
      await withFakeTimers(async () => {
        let counter = 0;
        const condition = () => {
          counter++;
          return counter >= 3;
        };

        const promise = waitForCondition(condition, {
          timeout: 5000,
          interval: 100,
        });

        // Advance timer to trigger checks
        jest.advanceTimersByTime(300);
        await promise;

        expect(counter).toBeGreaterThanOrEqual(3);
      });
    });

    it('should throw on timeout', async () => {
      await withFakeTimers(async () => {
        const condition = () => false;

        const promise = waitForCondition(condition, {
          timeout: 100,
          interval: 10,
        });

        // Advance past timeout
        jest.advanceTimersByTime(200);

        await expect(promise).rejects.toThrow('Condition not met within 100ms');
      });
    });

    it('should support async conditions', async () => {
      await withFakeTimers(async () => {
        let ready = false;
        setTimeout(() => { ready = true; }, 500);

        const condition = async () => ready;

        const promise = waitForCondition(condition, {
          timeout: 1000,
          interval: 100,
        });

        // Advance timer
        jest.advanceTimersByTime(600);
        await promise;

        expect(ready).toBe(true);
      });
    });
  });
});
