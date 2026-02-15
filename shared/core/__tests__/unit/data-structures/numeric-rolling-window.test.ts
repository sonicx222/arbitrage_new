/**
 * NumericRollingWindow Tests
 *
 * Tests for the numeric rolling window implementation including:
 * - Constructor validation
 * - Push and overwrite behavior
 * - O(1) average computation
 * - Running sum correctness
 * - Min/max operations
 * - toArray ordering
 * - getStats
 * - Clear and reset
 * - Edge cases (single-element, overwrite accuracy, NaN)
 * - Factory function
 */

import {
  NumericRollingWindow,
  createNumericRollingWindow,
} from '../../../src/data-structures/numeric-rolling-window';

describe('NumericRollingWindow', () => {
  // ==========================================================================
  // Constructor
  // ==========================================================================

  describe('constructor', () => {
    it('should create window with valid maxSize', () => {
      const win = new NumericRollingWindow(10);
      expect(win.capacity).toBe(10);
      expect(win.size).toBe(0);
      expect(win.isEmpty).toBe(true);
      expect(win.isFull).toBe(false);
    });

    it('should throw for zero maxSize', () => {
      expect(() => new NumericRollingWindow(0)).toThrow('NumericRollingWindow maxSize must be a positive integer');
    });

    it('should throw for negative maxSize', () => {
      expect(() => new NumericRollingWindow(-3)).toThrow('NumericRollingWindow maxSize must be a positive integer');
    });
  });

  // ==========================================================================
  // push
  // ==========================================================================

  describe('push', () => {
    it('should add values and increase size', () => {
      const win = new NumericRollingWindow(5);
      win.push(10);
      win.push(20);
      expect(win.size).toBe(2);
      expect(win.isEmpty).toBe(false);
    });

    it('should overwrite oldest when full', () => {
      const win = new NumericRollingWindow(3);
      win.push(1);
      win.push(2);
      win.push(3);
      win.push(4); // overwrites 1

      expect(win.size).toBe(3);
      expect(win.isFull).toBe(true);
      expect(win.toArray()).toEqual([2, 3, 4]);
    });

    it('should adjust sum correctly when overwriting', () => {
      const win = new NumericRollingWindow(3);
      win.push(10);
      win.push(20);
      win.push(30);
      // sum = 60
      expect(win.getSum()).toBe(60);

      win.push(40); // overwrites 10, sum should be 20+30+40 = 90
      expect(win.getSum()).toBe(90);
    });
  });

  // ==========================================================================
  // average
  // ==========================================================================

  describe('average', () => {
    it('should compute correct O(1) average', () => {
      const win = new NumericRollingWindow(10);
      win.push(10);
      win.push(20);
      win.push(30);
      expect(win.average()).toBe(20);
    });

    it('should return 0 when empty', () => {
      const win = new NumericRollingWindow(5);
      expect(win.average()).toBe(0);
    });

    it('should update average after overwrite', () => {
      const win = new NumericRollingWindow(2);
      win.push(10);
      win.push(20);
      expect(win.average()).toBe(15); // (10+20)/2

      win.push(30); // overwrites 10
      expect(win.average()).toBe(25); // (20+30)/2
    });
  });

  // ==========================================================================
  // getSum
  // ==========================================================================

  describe('getSum', () => {
    it('should return running sum', () => {
      const win = new NumericRollingWindow(10);
      win.push(5);
      win.push(10);
      win.push(15);
      expect(win.getSum()).toBe(30);
    });

    it('should return 0 for empty window', () => {
      const win = new NumericRollingWindow(5);
      expect(win.getSum()).toBe(0);
    });

    it('should adjust sum on overwrite', () => {
      const win = new NumericRollingWindow(2);
      win.push(100);
      win.push(200);
      expect(win.getSum()).toBe(300);

      win.push(50); // overwrites 100
      expect(win.getSum()).toBe(250);
    });
  });

  // ==========================================================================
  // min / max
  // ==========================================================================

  describe('min', () => {
    it('should return minimum value', () => {
      const win = new NumericRollingWindow(5);
      win.push(30);
      win.push(10);
      win.push(20);
      expect(win.min()).toBe(10);
    });

    it('should return Infinity when empty', () => {
      const win = new NumericRollingWindow(5);
      expect(win.min()).toBe(Infinity);
    });
  });

  describe('max', () => {
    it('should return maximum value', () => {
      const win = new NumericRollingWindow(5);
      win.push(10);
      win.push(50);
      win.push(30);
      expect(win.max()).toBe(50);
    });

    it('should return -Infinity when empty', () => {
      const win = new NumericRollingWindow(5);
      expect(win.max()).toBe(-Infinity);
    });
  });

  // ==========================================================================
  // toArray
  // ==========================================================================

  describe('toArray', () => {
    it('should return values in oldest-to-newest order', () => {
      const win = new NumericRollingWindow(5);
      win.push(1);
      win.push(2);
      win.push(3);
      expect(win.toArray()).toEqual([1, 2, 3]);
    });

    it('should return empty array when empty', () => {
      const win = new NumericRollingWindow(5);
      expect(win.toArray()).toEqual([]);
    });

    it('should return correct order after wrap-around', () => {
      const win = new NumericRollingWindow(3);
      win.push(1);
      win.push(2);
      win.push(3);
      win.push(4); // overwrites 1
      win.push(5); // overwrites 2
      expect(win.toArray()).toEqual([3, 4, 5]);
    });
  });

  // ==========================================================================
  // getStats
  // ==========================================================================

  describe('getStats', () => {
    it('should return all correct fields', () => {
      const win = new NumericRollingWindow(4);
      win.push(10);
      win.push(20);

      const stats = win.getStats();
      expect(stats.count).toBe(2);
      expect(stats.capacity).toBe(4);
      expect(stats.sum).toBe(30);
      expect(stats.average).toBe(15);
      expect(stats.fillRatio).toBe(0.5);
    });

    it('should return correct stats for full window', () => {
      const win = new NumericRollingWindow(2);
      win.push(6);
      win.push(4);

      const stats = win.getStats();
      expect(stats.count).toBe(2);
      expect(stats.fillRatio).toBe(1);
      expect(stats.sum).toBe(10);
      expect(stats.average).toBe(5);
    });
  });

  // ==========================================================================
  // clear
  // ==========================================================================

  describe('clear', () => {
    it('should reset everything', () => {
      const win = new NumericRollingWindow(5);
      win.push(10);
      win.push(20);
      win.push(30);

      win.clear();

      expect(win.size).toBe(0);
      expect(win.isEmpty).toBe(true);
      expect(win.getSum()).toBe(0);
      expect(win.average()).toBe(0);
      expect(win.toArray()).toEqual([]);
    });

    it('should allow reuse after clearing', () => {
      const win = new NumericRollingWindow(3);
      win.push(100);
      win.push(200);
      win.clear();

      win.push(5);
      win.push(15);
      expect(win.average()).toBe(10);
      expect(win.getSum()).toBe(20);
    });
  });

  // ==========================================================================
  // Edge Cases
  // ==========================================================================

  describe('edge cases', () => {
    it('should handle single-element window', () => {
      const win = new NumericRollingWindow(1);
      win.push(42);
      expect(win.isFull).toBe(true);
      expect(win.average()).toBe(42);
      expect(win.min()).toBe(42);
      expect(win.max()).toBe(42);

      win.push(99); // overwrites 42
      expect(win.average()).toBe(99);
      expect(win.size).toBe(1);
    });

    it('should maintain accuracy after many overwrites', () => {
      const win = new NumericRollingWindow(10);

      // Push 1000 values into a size-10 window
      for (let i = 1; i <= 1000; i++) {
        win.push(i);
      }

      // Window should contain [991, 992, ..., 1000]
      expect(win.size).toBe(10);
      const expectedSum = (991 + 1000) * 10 / 2; // sum of 991..1000
      expect(win.getSum()).toBeCloseTo(expectedSum, 5);
      expect(win.average()).toBeCloseTo(995.5, 5);
      expect(win.toArray()).toEqual([991, 992, 993, 994, 995, 996, 997, 998, 999, 1000]);
    });

    it('should silently discard NaN values to prevent sum poisoning', () => {
      const win = new NumericRollingWindow(3);
      win.push(10);
      win.push(NaN);
      win.push(20);

      // NaN is silently dropped — sum and average remain valid
      expect(win.size).toBe(2);
      expect(win.getSum()).toBe(30);
      expect(win.average()).toBe(15);
    });

    it('should recover from NaN after full buffer wrap-around', () => {
      const win = new NumericRollingWindow(3);
      win.push(10);
      win.push(20);
      win.push(30); // Buffer full: [10, 20, 30]
      win.push(NaN); // Silently dropped — buffer stays [10, 20, 30]
      win.push(40); // Overwrites 10: [40, 20, 30]

      expect(win.size).toBe(3);
      expect(win.toArray()).toEqual([20, 30, 40]);
      expect(win.getSum()).toBe(90);
      expect(win.average()).toBe(30);
    });

    it('should handle very large values', () => {
      const win = new NumericRollingWindow(3);
      win.push(Number.MAX_SAFE_INTEGER);
      win.push(1);
      expect(win.size).toBe(2);
      expect(win.max()).toBe(Number.MAX_SAFE_INTEGER);
    });
  });

  // ==========================================================================
  // Factory Function
  // ==========================================================================

  describe('createNumericRollingWindow', () => {
    it('should create a NumericRollingWindow instance', () => {
      const win = createNumericRollingWindow(50);
      expect(win.capacity).toBe(50);
      expect(win.isEmpty).toBe(true);

      win.push(7);
      expect(win.average()).toBe(7);
    });
  });
});
