/**
 * PriorityQueue Unit Tests
 *
 * Fix #6: Comprehensive tests for the binary max-heap PriorityQueue.
 * This class is used for hot-path task scheduling in the worker pool.
 *
 * @see shared/core/src/async/worker-pool.ts:135-236
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { PriorityQueue } from '../../../src/async/worker-pool';

describe('PriorityQueue', () => {
  let queue: PriorityQueue<string>;

  beforeEach(() => {
    queue = new PriorityQueue<string>();
  });

  describe('enqueue and dequeue', () => {
    it('dequeues items in priority order (highest first)', () => {
      queue.enqueue('low', 1);
      queue.enqueue('high', 10);
      queue.enqueue('mid', 5);

      expect(queue.dequeue()).toBe('high');
      expect(queue.dequeue()).toBe('mid');
      expect(queue.dequeue()).toBe('low');
    });

    it('returns undefined when dequeuing empty queue', () => {
      expect(queue.dequeue()).toBeUndefined();
    });

    it('handles single element', () => {
      queue.enqueue('only', 1);
      expect(queue.dequeue()).toBe('only');
      expect(queue.dequeue()).toBeUndefined();
    });

    it('handles two elements in correct order', () => {
      queue.enqueue('second', 1);
      queue.enqueue('first', 2);

      expect(queue.dequeue()).toBe('first');
      expect(queue.dequeue()).toBe('second');
    });

    it('handles items with equal priority (stable dequeue)', () => {
      queue.enqueue('a', 5);
      queue.enqueue('b', 5);
      queue.enqueue('c', 5);

      // All should be dequeued (order among equal priorities is not guaranteed by heap)
      const results = [queue.dequeue(), queue.dequeue(), queue.dequeue()];
      expect(results).toHaveLength(3);
      expect(results.sort()).toEqual(['a', 'b', 'c']);
      expect(queue.isEmpty()).toBe(true);
    });

    it('handles negative priorities', () => {
      queue.enqueue('neg', -10);
      queue.enqueue('pos', 10);
      queue.enqueue('zero', 0);

      expect(queue.dequeue()).toBe('pos');
      expect(queue.dequeue()).toBe('zero');
      expect(queue.dequeue()).toBe('neg');
    });

    it('handles large number of items', () => {
      const count = 100;
      for (let i = 0; i < count; i++) {
        queue.enqueue(`item-${i}`, i);
      }

      expect(queue.size()).toBe(count);

      // Should dequeue in descending priority order
      let lastPriority = Infinity;
      for (let i = 0; i < count; i++) {
        const item = queue.dequeue()!;
        const priority = parseInt(item.split('-')[1]);
        expect(priority).toBeLessThanOrEqual(lastPriority);
        lastPriority = priority;
      }

      expect(queue.isEmpty()).toBe(true);
    });

    it('interleaves enqueue and dequeue correctly', () => {
      queue.enqueue('a', 1);
      queue.enqueue('b', 3);
      expect(queue.dequeue()).toBe('b'); // highest: 3

      queue.enqueue('c', 2);
      expect(queue.dequeue()).toBe('c'); // highest: 2
      expect(queue.dequeue()).toBe('a'); // highest: 1
      expect(queue.isEmpty()).toBe(true);
    });
  });

  describe('peek', () => {
    it('returns highest priority item without removing', () => {
      queue.enqueue('low', 1);
      queue.enqueue('high', 10);

      expect(queue.peek()).toBe('high');
      expect(queue.size()).toBe(2); // not removed
    });

    it('returns undefined on empty queue', () => {
      expect(queue.peek()).toBeUndefined();
    });

    it('returns same item on repeated calls', () => {
      queue.enqueue('only', 5);

      expect(queue.peek()).toBe('only');
      expect(queue.peek()).toBe('only');
      expect(queue.size()).toBe(1);
    });
  });

  describe('size', () => {
    it('returns 0 for new queue', () => {
      expect(queue.size()).toBe(0);
    });

    it('increases on enqueue', () => {
      queue.enqueue('a', 1);
      expect(queue.size()).toBe(1);
      queue.enqueue('b', 2);
      expect(queue.size()).toBe(2);
    });

    it('decreases on dequeue', () => {
      queue.enqueue('a', 1);
      queue.enqueue('b', 2);
      queue.dequeue();
      expect(queue.size()).toBe(1);
    });
  });

  describe('isEmpty', () => {
    it('returns true for new queue', () => {
      expect(queue.isEmpty()).toBe(true);
    });

    it('returns false after enqueue', () => {
      queue.enqueue('a', 1);
      expect(queue.isEmpty()).toBe(false);
    });

    it('returns true after all items dequeued', () => {
      queue.enqueue('a', 1);
      queue.dequeue();
      expect(queue.isEmpty()).toBe(true);
    });
  });

  describe('clear', () => {
    it('empties the queue', () => {
      queue.enqueue('a', 1);
      queue.enqueue('b', 2);
      queue.enqueue('c', 3);

      queue.clear();

      expect(queue.isEmpty()).toBe(true);
      expect(queue.size()).toBe(0);
      expect(queue.dequeue()).toBeUndefined();
    });

    it('is safe on empty queue', () => {
      queue.clear();
      expect(queue.isEmpty()).toBe(true);
    });

    it('allows reuse after clear', () => {
      queue.enqueue('old', 1);
      queue.clear();

      queue.enqueue('new', 5);
      expect(queue.dequeue()).toBe('new');
    });
  });

  describe('heap property invariant', () => {
    it('maintains max-heap after mixed operations', () => {
      // Insert in various orders and verify dequeue always returns max
      queue.enqueue('e', 5);
      queue.enqueue('a', 1);
      queue.enqueue('c', 3);
      expect(queue.dequeue()).toBe('e'); // 5

      queue.enqueue('d', 4);
      queue.enqueue('b', 2);
      expect(queue.dequeue()).toBe('d'); // 4

      expect(queue.dequeue()).toBe('c'); // 3
      expect(queue.dequeue()).toBe('b'); // 2
      expect(queue.dequeue()).toBe('a'); // 1
    });

    it('works with duplicate priorities and different items', () => {
      queue.enqueue('x', 1);
      queue.enqueue('y', 1);
      queue.enqueue('z', 2);

      expect(queue.dequeue()).toBe('z'); // priority 2 first
      // remaining two have priority 1
      const rest = [queue.dequeue(), queue.dequeue()];
      expect(rest.sort()).toEqual(['x', 'y']);
    });
  });

  describe('typed queue', () => {
    it('works with number items', () => {
      const numQueue = new PriorityQueue<number>();
      numQueue.enqueue(100, 1);
      numQueue.enqueue(200, 3);
      numQueue.enqueue(300, 2);

      expect(numQueue.dequeue()).toBe(200);
      expect(numQueue.dequeue()).toBe(300);
      expect(numQueue.dequeue()).toBe(100);
    });

    it('works with object items', () => {
      const objQueue = new PriorityQueue<{ id: string }>();
      const a = { id: 'a' };
      const b = { id: 'b' };

      objQueue.enqueue(a, 1);
      objQueue.enqueue(b, 2);

      expect(objQueue.dequeue()).toBe(b);
      expect(objQueue.dequeue()).toBe(a);
    });
  });
});
