/**
 * CircularBuffer Tests
 *
 * Tests for the circular buffer implementation including:
 * - Constructor validation
 * - FIFO queue operations (push, shift, peek)
 * - Rolling window operations (toArray, countWhere, filter, find)
 * - Predicate operations (some, every, forEach, reduce)
 * - Buffer management (clear, getStats, iterator)
 * - Factory functions (createFifoBuffer, createRollingWindow)
 * - Edge cases (single-item buffer, wrap-around)
 */

import {
  CircularBuffer,
  createFifoBuffer,
  createRollingWindow,
} from '../../../src/data-structures/circular-buffer';

describe('CircularBuffer', () => {
  // ==========================================================================
  // Constructor
  // ==========================================================================

  describe('constructor', () => {
    it('should create buffer with numeric capacity', () => {
      const buf = new CircularBuffer<number>(5);
      expect(buf.capacity).toBe(5);
      expect(buf.length).toBe(0);
      expect(buf.size).toBe(0);
      expect(buf.isEmpty).toBe(true);
      expect(buf.isFull).toBe(false);
    });

    it('should create buffer with config object', () => {
      const buf = new CircularBuffer<number>({ capacity: 10, clearOnRemove: false });
      expect(buf.capacity).toBe(10);
      expect(buf.isEmpty).toBe(true);
    });

    it('should throw for zero capacity', () => {
      expect(() => new CircularBuffer<number>(0)).toThrow('CircularBuffer capacity must be a positive integer');
    });

    it('should throw for negative capacity', () => {
      expect(() => new CircularBuffer<number>(-5)).toThrow('CircularBuffer capacity must be a positive integer');
    });
  });

  // ==========================================================================
  // push (FIFO mode)
  // ==========================================================================

  describe('push', () => {
    it('should add items and return true', () => {
      const buf = new CircularBuffer<number>(3);
      expect(buf.push(1)).toBe(true);
      expect(buf.push(2)).toBe(true);
      expect(buf.length).toBe(2);
    });

    it('should return false when buffer is full', () => {
      const buf = new CircularBuffer<number>(2);
      buf.push(1);
      buf.push(2);
      expect(buf.push(3)).toBe(false);
      expect(buf.length).toBe(2);
    });

    it('should not exceed capacity', () => {
      const buf = new CircularBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      buf.push(4); // rejected
      expect(buf.length).toBe(3);
      expect(buf.isFull).toBe(true);
    });
  });

  // ==========================================================================
  // pushOverwrite (Rolling window mode)
  // ==========================================================================

  describe('pushOverwrite', () => {
    it('should add items when not full', () => {
      const buf = new CircularBuffer<number>(3);
      buf.pushOverwrite(10);
      buf.pushOverwrite(20);
      expect(buf.length).toBe(2);
      expect(buf.toArray()).toEqual([10, 20]);
    });

    it('should overwrite oldest when full', () => {
      const buf = new CircularBuffer<number>(3);
      buf.pushOverwrite(1);
      buf.pushOverwrite(2);
      buf.pushOverwrite(3);
      buf.pushOverwrite(4); // overwrites 1
      expect(buf.length).toBe(3);
      expect(buf.toArray()).toEqual([2, 3, 4]);
    });

    it('should keep count at capacity when overwriting', () => {
      const buf = new CircularBuffer<number>(2);
      buf.pushOverwrite(1);
      buf.pushOverwrite(2);
      buf.pushOverwrite(3);
      buf.pushOverwrite(4);
      buf.pushOverwrite(5);
      expect(buf.length).toBe(2);
      expect(buf.toArray()).toEqual([4, 5]);
    });
  });

  // ==========================================================================
  // shift
  // ==========================================================================

  describe('shift', () => {
    it('should remove and return the oldest item', () => {
      const buf = new CircularBuffer<string>(3);
      buf.push('a');
      buf.push('b');
      buf.push('c');

      expect(buf.shift()).toBe('a');
      expect(buf.shift()).toBe('b');
      expect(buf.length).toBe(1);
    });

    it('should return undefined when empty', () => {
      const buf = new CircularBuffer<number>(3);
      expect(buf.shift()).toBeUndefined();
    });
  });

  // ==========================================================================
  // peek / peekLast
  // ==========================================================================

  describe('peek', () => {
    it('should return the oldest item without removing it', () => {
      const buf = new CircularBuffer<number>(3);
      buf.push(10);
      buf.push(20);
      expect(buf.peek()).toBe(10);
      expect(buf.length).toBe(2); // not removed
    });

    it('should return undefined when empty', () => {
      const buf = new CircularBuffer<number>(3);
      expect(buf.peek()).toBeUndefined();
    });
  });

  describe('peekLast', () => {
    it('should return the newest item without removing it', () => {
      const buf = new CircularBuffer<number>(3);
      buf.push(10);
      buf.push(20);
      buf.push(30);
      expect(buf.peekLast()).toBe(30);
      expect(buf.length).toBe(3); // not removed
    });

    it('should return undefined when empty', () => {
      const buf = new CircularBuffer<number>(3);
      expect(buf.peekLast()).toBeUndefined();
    });
  });

  // ==========================================================================
  // toArray
  // ==========================================================================

  describe('toArray', () => {
    it('should return items in oldest-to-newest order', () => {
      const buf = new CircularBuffer<number>(5);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      expect(buf.toArray()).toEqual([1, 2, 3]);
    });

    it('should return empty array when buffer is empty', () => {
      const buf = new CircularBuffer<number>(3);
      expect(buf.toArray()).toEqual([]);
    });

    it('should return correct order after wrap-around', () => {
      const buf = new CircularBuffer<number>(3);
      buf.pushOverwrite(1);
      buf.pushOverwrite(2);
      buf.pushOverwrite(3);
      buf.pushOverwrite(4); // overwrites 1
      buf.pushOverwrite(5); // overwrites 2
      expect(buf.toArray()).toEqual([3, 4, 5]);
    });
  });

  // ==========================================================================
  // countWhere / filter / find
  // ==========================================================================

  describe('countWhere', () => {
    it('should count items matching predicate', () => {
      const buf = new CircularBuffer<number>(5);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      buf.push(4);
      buf.push(5);
      expect(buf.countWhere(x => x > 3)).toBe(2);
    });

    it('should return 0 when no items match', () => {
      const buf = new CircularBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      expect(buf.countWhere(x => x > 10)).toBe(0);
    });
  });

  describe('filter', () => {
    it('should return items matching predicate', () => {
      const buf = new CircularBuffer<number>(5);
      buf.push(10);
      buf.push(20);
      buf.push(30);
      buf.push(40);
      expect(buf.filter(x => x >= 20 && x <= 30)).toEqual([20, 30]);
    });

    it('should return empty array when nothing matches', () => {
      const buf = new CircularBuffer<number>(3);
      buf.push(1);
      expect(buf.filter(x => x > 100)).toEqual([]);
    });
  });

  describe('find', () => {
    it('should return first matching item', () => {
      const buf = new CircularBuffer<number>(5);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      expect(buf.find(x => x > 1)).toBe(2);
    });

    it('should return undefined when no match', () => {
      const buf = new CircularBuffer<number>(3);
      buf.push(1);
      expect(buf.find(x => x > 10)).toBeUndefined();
    });
  });

  // ==========================================================================
  // some / every
  // ==========================================================================

  describe('some', () => {
    it('should return true when at least one item matches', () => {
      const buf = new CircularBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      expect(buf.some(x => x === 2)).toBe(true);
    });

    it('should return false when no items match', () => {
      const buf = new CircularBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      expect(buf.some(x => x === 99)).toBe(false);
    });
  });

  describe('every', () => {
    it('should return true when all items match', () => {
      const buf = new CircularBuffer<number>(3);
      buf.push(2);
      buf.push(4);
      buf.push(6);
      expect(buf.every(x => x % 2 === 0)).toBe(true);
    });

    it('should return false when not all items match', () => {
      const buf = new CircularBuffer<number>(3);
      buf.push(2);
      buf.push(3);
      buf.push(4);
      expect(buf.every(x => x % 2 === 0)).toBe(false);
    });

    it('should return true for empty buffer', () => {
      const buf = new CircularBuffer<number>(3);
      expect(buf.every(x => x > 0)).toBe(true);
    });
  });

  // ==========================================================================
  // forEach / reduce
  // ==========================================================================

  describe('forEach', () => {
    it('should iterate over all items with correct indices', () => {
      const buf = new CircularBuffer<string>(3);
      buf.push('a');
      buf.push('b');
      buf.push('c');

      const items: string[] = [];
      const indices: number[] = [];
      buf.forEach((item, index) => {
        items.push(item);
        indices.push(index);
      });

      expect(items).toEqual(['a', 'b', 'c']);
      expect(indices).toEqual([0, 1, 2]);
    });
  });

  describe('reduce', () => {
    it('should reduce items to a single value', () => {
      const buf = new CircularBuffer<number>(5);
      buf.push(1);
      buf.push(2);
      buf.push(3);

      const sum = buf.reduce((acc, item) => acc + item, 0);
      expect(sum).toBe(6);
    });

    it('should return initial value for empty buffer', () => {
      const buf = new CircularBuffer<number>(3);
      const result = buf.reduce((acc, item) => acc + item, 42);
      expect(result).toBe(42);
    });
  });

  // ==========================================================================
  // clear
  // ==========================================================================

  describe('clear', () => {
    it('should reset everything', () => {
      const buf = new CircularBuffer<number>(5);
      buf.push(1);
      buf.push(2);
      buf.push(3);

      buf.clear();

      expect(buf.length).toBe(0);
      expect(buf.isEmpty).toBe(true);
      expect(buf.toArray()).toEqual([]);
      expect(buf.peek()).toBeUndefined();
    });

    it('should allow reuse after clearing', () => {
      const buf = new CircularBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      buf.clear();

      buf.push(10);
      buf.push(20);
      expect(buf.toArray()).toEqual([10, 20]);
    });

    it('should work with clearOnRemove disabled', () => {
      const buf = new CircularBuffer<number>({ capacity: 3, clearOnRemove: false });
      buf.push(1);
      buf.push(2);
      buf.clear();

      expect(buf.length).toBe(0);
      expect(buf.isEmpty).toBe(true);
    });
  });

  // ==========================================================================
  // getStats
  // ==========================================================================

  describe('getStats', () => {
    it('should return correct stats for partially filled buffer', () => {
      const buf = new CircularBuffer<number>(4);
      buf.push(1);
      buf.push(2);

      const stats = buf.getStats();
      expect(stats.size).toBe(2);
      expect(stats.capacity).toBe(4);
      expect(stats.fillRatio).toBe(0.5);
      expect(stats.isFull).toBe(false);
      expect(stats.isEmpty).toBe(false);
    });

    it('should return correct stats for full buffer', () => {
      const buf = new CircularBuffer<number>(2);
      buf.push(1);
      buf.push(2);

      const stats = buf.getStats();
      expect(stats.fillRatio).toBe(1);
      expect(stats.isFull).toBe(true);
      expect(stats.isEmpty).toBe(false);
    });

    it('should return correct stats for empty buffer', () => {
      const buf = new CircularBuffer<number>(5);
      const stats = buf.getStats();
      expect(stats.fillRatio).toBe(0);
      expect(stats.isFull).toBe(false);
      expect(stats.isEmpty).toBe(true);
    });
  });

  // ==========================================================================
  // Symbol.iterator
  // ==========================================================================

  describe('Symbol.iterator', () => {
    it('should work with for...of', () => {
      const buf = new CircularBuffer<number>(5);
      buf.push(10);
      buf.push(20);
      buf.push(30);

      const items: number[] = [];
      for (const item of buf) {
        items.push(item);
      }
      expect(items).toEqual([10, 20, 30]);
    });

    it('should work with spread operator', () => {
      const buf = new CircularBuffer<string>(3);
      buf.push('x');
      buf.push('y');
      expect([...buf]).toEqual(['x', 'y']);
    });

    it('should yield nothing for empty buffer', () => {
      const buf = new CircularBuffer<number>(3);
      expect([...buf]).toEqual([]);
    });
  });

  // ==========================================================================
  // Factory Functions
  // ==========================================================================

  describe('createFifoBuffer', () => {
    it('should create a buffer with clearOnRemove enabled', () => {
      const buf = createFifoBuffer<number>(5);
      expect(buf.capacity).toBe(5);
      expect(buf.isEmpty).toBe(true);

      // Verify FIFO behavior
      buf.push(1);
      buf.push(2);
      expect(buf.shift()).toBe(1);
    });
  });

  describe('createRollingWindow', () => {
    it('should create a buffer with clearOnRemove disabled', () => {
      const buf = createRollingWindow<number>(5);
      expect(buf.capacity).toBe(5);
      expect(buf.isEmpty).toBe(true);

      // Verify rolling window behavior
      buf.pushOverwrite(1);
      buf.pushOverwrite(2);
      expect(buf.toArray()).toEqual([1, 2]);
    });
  });

  // ==========================================================================
  // pushOverwrite + countWhere combined (Fix #11 regression test)
  // ==========================================================================

  describe('pushOverwrite + countWhere combined (production pattern)', () => {
    it('should calculate rolling success rate correctly', () => {
      // This is the pattern used by BaseSimulationProvider:
      // pushOverwrite(true/false) + countWhere((r) => r) for success rate
      const buf = new CircularBuffer<boolean>(5);

      // First 5 results: 3 successes, 2 failures
      buf.pushOverwrite(true);
      buf.pushOverwrite(false);
      buf.pushOverwrite(true);
      buf.pushOverwrite(true);
      buf.pushOverwrite(false);

      expect(buf.countWhere(r => r)).toBe(3);
      expect(buf.size).toBe(5);

      // Add 2 more successes — should overwrite the 2 oldest (true, false)
      buf.pushOverwrite(true);
      buf.pushOverwrite(true);

      // Window is now: [true, true, false, true, true] = 4 successes
      expect(buf.countWhere(r => r)).toBe(4);
      expect(buf.size).toBe(5);
    });
  });

  // ==========================================================================
  // Edge Cases
  // ==========================================================================

  describe('edge cases', () => {
    it('should handle single-item buffer', () => {
      const buf = new CircularBuffer<number>(1);
      buf.push(42);
      expect(buf.isFull).toBe(true);
      expect(buf.peek()).toBe(42);
      expect(buf.peekLast()).toBe(42);
      expect(buf.shift()).toBe(42);
      expect(buf.isEmpty).toBe(true);
    });

    it('should handle wrap-around after multiple push/shift cycles', () => {
      const buf = new CircularBuffer<number>(3);

      // Fill and drain multiple times to exercise wrap-around
      for (let cycle = 0; cycle < 5; cycle++) {
        buf.push(cycle * 10 + 1);
        buf.push(cycle * 10 + 2);
        buf.push(cycle * 10 + 3);

        expect(buf.shift()).toBe(cycle * 10 + 1);
        expect(buf.shift()).toBe(cycle * 10 + 2);
        expect(buf.shift()).toBe(cycle * 10 + 3);
        expect(buf.isEmpty).toBe(true);
      }
    });

    it('should maintain correct order with interleaved push/shift', () => {
      const buf = new CircularBuffer<number>(3);

      buf.push(1);
      buf.push(2);
      expect(buf.shift()).toBe(1); // [2]

      buf.push(3);
      buf.push(4);
      expect(buf.shift()).toBe(2); // [3, 4]
      expect(buf.shift()).toBe(3); // [4]

      buf.push(5);
      expect(buf.toArray()).toEqual([4, 5]);
    });
  });
});
