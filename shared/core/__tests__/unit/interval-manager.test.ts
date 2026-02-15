/**
 * Interval Manager Tests
 *
 * Moved from src/__tests__/unit/ to __tests__/unit/ per ADR-009 convention.
 */

import { IntervalManager, createIntervalManager } from '../../src/interval-manager';

describe('IntervalManager', () => {
  let manager: IntervalManager;

  beforeEach(() => {
    jest.useFakeTimers();
    manager = new IntervalManager();
  });

  afterEach(() => {
    manager.clearAll();
    jest.useRealTimers();
  });

  describe('set', () => {
    it('should create a named interval', () => {
      const callback = jest.fn();
      manager.set('test', callback, 1000);

      expect(manager.has('test')).toBe(true);
      expect(manager.size()).toBe(1);
    });

    it('should invoke callback at specified interval', () => {
      const callback = jest.fn();
      manager.set('test', callback, 1000);

      expect(callback).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1000);
      expect(callback).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(1000);
      expect(callback).toHaveBeenCalledTimes(2);

      jest.advanceTimersByTime(3000);
      expect(callback).toHaveBeenCalledTimes(5);
    });

    it('should run immediately when runImmediately is true', () => {
      const callback = jest.fn();
      manager.set('test', callback, 1000, true);

      expect(callback).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(1000);
      expect(callback).toHaveBeenCalledTimes(2);
    });

    it('should replace existing interval with same name', () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();

      manager.set('test', callback1, 1000);
      manager.set('test', callback2, 1000);

      expect(manager.size()).toBe(1);

      jest.advanceTimersByTime(1000);

      // Original callback should not be called
      expect(callback1).not.toHaveBeenCalled();
      // New callback should be called
      expect(callback2).toHaveBeenCalledTimes(1);
    });

    it('should handle async callbacks', async () => {
      const asyncCallback = jest.fn().mockResolvedValue(undefined);
      manager.set('test', asyncCallback, 1000);

      jest.advanceTimersByTime(1000);

      // Should have been called
      expect(asyncCallback).toHaveBeenCalledTimes(1);
    });

    it('should not crash on callback errors', () => {
      const errorCallback = jest.fn().mockImplementation(() => {
        throw new Error('Test error');
      });

      manager.set('test', errorCallback, 1000);

      // Should not throw
      expect(() => {
        jest.advanceTimersByTime(1000);
      }).not.toThrow();

      expect(errorCallback).toHaveBeenCalledTimes(1);
    });

    it('should not crash on async callback rejections', () => {
      const asyncErrorCallback = jest.fn().mockRejectedValue(new Error('Test error'));

      manager.set('test', asyncErrorCallback, 1000);

      // Should not throw
      expect(() => {
        jest.advanceTimersByTime(1000);
      }).not.toThrow();
    });
  });

  describe('clear', () => {
    it('should clear a specific interval', () => {
      const callback = jest.fn();
      manager.set('test', callback, 1000);

      expect(manager.clear('test')).toBe(true);
      expect(manager.has('test')).toBe(false);

      jest.advanceTimersByTime(5000);
      expect(callback).not.toHaveBeenCalled();
    });

    it('should return false for non-existent interval', () => {
      expect(manager.clear('nonexistent')).toBe(false);
    });

    it('should only clear the specified interval', () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();

      manager.set('test1', callback1, 1000);
      manager.set('test2', callback2, 1000);

      manager.clear('test1');

      jest.advanceTimersByTime(1000);

      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).toHaveBeenCalledTimes(1);
    });
  });

  describe('clearAll', () => {
    it('should clear all intervals', () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();
      const callback3 = jest.fn();

      manager.set('test1', callback1, 1000);
      manager.set('test2', callback2, 1000);
      manager.set('test3', callback3, 1000);

      expect(manager.size()).toBe(3);

      manager.clearAll();

      expect(manager.size()).toBe(0);

      jest.advanceTimersByTime(5000);

      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).not.toHaveBeenCalled();
      expect(callback3).not.toHaveBeenCalled();
    });
  });

  describe('has', () => {
    it('should return true for existing interval', () => {
      manager.set('test', jest.fn(), 1000);
      expect(manager.has('test')).toBe(true);
    });

    it('should return false for non-existent interval', () => {
      expect(manager.has('nonexistent')).toBe(false);
    });
  });

  describe('size', () => {
    it('should return number of active intervals', () => {
      expect(manager.size()).toBe(0);

      manager.set('test1', jest.fn(), 1000);
      expect(manager.size()).toBe(1);

      manager.set('test2', jest.fn(), 1000);
      expect(manager.size()).toBe(2);

      manager.clear('test1');
      expect(manager.size()).toBe(1);
    });
  });

  describe('getNames', () => {
    it('should return names of all active intervals', () => {
      manager.set('health', jest.fn(), 1000);
      manager.set('metrics', jest.fn(), 1000);
      manager.set('cleanup', jest.fn(), 1000);

      const names = manager.getNames();

      expect(names).toHaveLength(3);
      expect(names).toContain('health');
      expect(names).toContain('metrics');
      expect(names).toContain('cleanup');
    });

    it('should return empty array when no intervals', () => {
      expect(manager.getNames()).toEqual([]);
    });
  });

  describe('getStats', () => {
    it('should return detailed stats', () => {
      manager.set('health', jest.fn(), 5000);
      manager.set('metrics', jest.fn(), 30000);

      const stats = manager.getStats();

      expect(stats.activeCount).toBe(2);
      expect(stats.activeNames).toContain('health');
      expect(stats.activeNames).toContain('metrics');
      expect(stats.intervals).toHaveLength(2);
    });

    it('should track invocation count', () => {
      manager.set('test', jest.fn(), 1000);

      jest.advanceTimersByTime(3000);

      const stats = manager.getStats();
      const testInterval = stats.intervals.find(i => i.name === 'test');

      expect(testInterval).toBeDefined();
      expect(testInterval!.invocationCount).toBe(3);
    });

    it('should include interval metadata', () => {
      const before = Date.now();
      manager.set('test', jest.fn(), 5000);

      const stats = manager.getStats();
      const testInterval = stats.intervals.find(i => i.name === 'test');

      expect(testInterval!.name).toBe('test');
      expect(testInterval!.intervalMs).toBe(5000);
      expect(testInterval!.createdAt).toBeGreaterThanOrEqual(before);
    });
  });

  describe('stop', () => {
    it('should be an alias for clearAll', () => {
      manager.set('test1', jest.fn(), 1000);
      manager.set('test2', jest.fn(), 1000);

      manager.stop();

      expect(manager.size()).toBe(0);
    });
  });

  describe('createIntervalManager factory', () => {
    it('should create a new IntervalManager instance', () => {
      const newManager = createIntervalManager();

      expect(newManager).toBeInstanceOf(IntervalManager);
      expect(newManager.size()).toBe(0);
    });
  });

  describe('real-world usage patterns', () => {
    it('should support service lifecycle pattern', () => {
      // Simulate service start
      const healthCheck = jest.fn();
      const metricsUpdate = jest.fn();
      const cleanup = jest.fn();

      manager.set('healthCheck', healthCheck, 5000);
      manager.set('metricsUpdate', metricsUpdate, 30000);
      manager.set('cleanup', cleanup, 60000);

      expect(manager.size()).toBe(3);

      // Simulate running for a while
      jest.advanceTimersByTime(60000);

      expect(healthCheck).toHaveBeenCalledTimes(12); // 60000 / 5000 = 12
      expect(metricsUpdate).toHaveBeenCalledTimes(2); // 60000 / 30000 = 2
      expect(cleanup).toHaveBeenCalledTimes(1); // 60000 / 60000 = 1

      // Simulate service stop
      manager.stop();

      expect(manager.size()).toBe(0);

      // No more invocations after stop
      jest.advanceTimersByTime(60000);

      expect(healthCheck).toHaveBeenCalledTimes(12);
      expect(metricsUpdate).toHaveBeenCalledTimes(2);
      expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('should support reconfiguration pattern', () => {
      const slowCheck = jest.fn();
      const fastCheck = jest.fn();

      // Start with slow check
      manager.set('healthCheck', slowCheck, 10000);

      jest.advanceTimersByTime(10000);
      expect(slowCheck).toHaveBeenCalledTimes(1);

      // Reconfigure to fast check
      manager.set('healthCheck', fastCheck, 1000);

      jest.advanceTimersByTime(5000);

      // Slow check should not run anymore
      expect(slowCheck).toHaveBeenCalledTimes(1);
      // Fast check should have run 5 times
      expect(fastCheck).toHaveBeenCalledTimes(5);
    });
  });
});
