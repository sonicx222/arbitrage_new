/**
 * MinHeap Tests
 *
 * Tests for the min-heap implementation including:
 * - Constructor with comparator
 * - Core operations (push, pop, peek, extractAll, clear)
 * - Heap property maintenance
 * - Edge cases (empty heap, single element, duplicates, negatives)
 * - Utility functions (findKSmallest, findKLargest)
 * - Large dataset correctness
 */

import { MinHeap, findKSmallest, findKLargest } from '../../../src/data-structures/min-heap';

describe('MinHeap', () => {
  const numericCompare = (a: number, b: number) => a - b;

  // ==========================================================================
  // Constructor
  // ==========================================================================

  describe('constructor', () => {
    it('should create an empty heap with a comparator', () => {
      const heap = new MinHeap<number>(numericCompare);
      expect(heap.size).toBe(0);
      expect(heap.isEmpty).toBe(true);
    });
  });

  // ==========================================================================
  // push / pop
  // ==========================================================================

  describe('push and pop', () => {
    it('should maintain heap property (min at top)', () => {
      const heap = new MinHeap<number>(numericCompare);
      heap.push(5);
      heap.push(3);
      heap.push(7);
      heap.push(1);

      expect(heap.pop()).toBe(1);
      expect(heap.pop()).toBe(3);
      expect(heap.pop()).toBe(5);
      expect(heap.pop()).toBe(7);
    });

    it('should handle items pushed in ascending order', () => {
      const heap = new MinHeap<number>(numericCompare);
      heap.push(1);
      heap.push(2);
      heap.push(3);

      expect(heap.pop()).toBe(1);
      expect(heap.pop()).toBe(2);
      expect(heap.pop()).toBe(3);
    });

    it('should handle items pushed in descending order', () => {
      const heap = new MinHeap<number>(numericCompare);
      heap.push(3);
      heap.push(2);
      heap.push(1);

      expect(heap.pop()).toBe(1);
      expect(heap.pop()).toBe(2);
      expect(heap.pop()).toBe(3);
    });

    it('should update size correctly', () => {
      const heap = new MinHeap<number>(numericCompare);
      heap.push(10);
      heap.push(20);
      expect(heap.size).toBe(2);

      heap.pop();
      expect(heap.size).toBe(1);
      expect(heap.isEmpty).toBe(false);

      heap.pop();
      expect(heap.size).toBe(0);
      expect(heap.isEmpty).toBe(true);
    });
  });

  // ==========================================================================
  // peek
  // ==========================================================================

  describe('peek', () => {
    it('should return the minimum element without removing it', () => {
      const heap = new MinHeap<number>(numericCompare);
      heap.push(5);
      heap.push(2);
      heap.push(8);

      expect(heap.peek()).toBe(2);
      expect(heap.size).toBe(3); // not removed
    });

    it('should return undefined for empty heap', () => {
      const heap = new MinHeap<number>(numericCompare);
      expect(heap.peek()).toBeUndefined();
    });
  });

  // ==========================================================================
  // extractAll
  // ==========================================================================

  describe('extractAll', () => {
    it('should return all elements in sorted order', () => {
      const heap = new MinHeap<number>(numericCompare);
      heap.push(30);
      heap.push(10);
      heap.push(50);
      heap.push(20);
      heap.push(40);

      expect(heap.extractAll()).toEqual([10, 20, 30, 40, 50]);
    });

    it('should empty the heap', () => {
      const heap = new MinHeap<number>(numericCompare);
      heap.push(1);
      heap.push(2);

      heap.extractAll();
      expect(heap.isEmpty).toBe(true);
      expect(heap.size).toBe(0);
    });

    it('should return empty array for empty heap', () => {
      const heap = new MinHeap<number>(numericCompare);
      expect(heap.extractAll()).toEqual([]);
    });
  });

  // ==========================================================================
  // clear
  // ==========================================================================

  describe('clear', () => {
    it('should empty the heap', () => {
      const heap = new MinHeap<number>(numericCompare);
      heap.push(1);
      heap.push(2);
      heap.push(3);

      heap.clear();
      expect(heap.isEmpty).toBe(true);
      expect(heap.size).toBe(0);
      expect(heap.peek()).toBeUndefined();
    });
  });

  // ==========================================================================
  // Edge Cases
  // ==========================================================================

  describe('edge cases', () => {
    it('should return undefined when popping from empty heap', () => {
      const heap = new MinHeap<number>(numericCompare);
      expect(heap.pop()).toBeUndefined();
    });

    it('should handle single element', () => {
      const heap = new MinHeap<number>(numericCompare);
      heap.push(42);
      expect(heap.peek()).toBe(42);
      expect(heap.pop()).toBe(42);
      expect(heap.isEmpty).toBe(true);
    });

    it('should handle duplicate values', () => {
      const heap = new MinHeap<number>(numericCompare);
      heap.push(5);
      heap.push(5);
      heap.push(5);

      expect(heap.size).toBe(3);
      expect(heap.pop()).toBe(5);
      expect(heap.pop()).toBe(5);
      expect(heap.pop()).toBe(5);
    });

    it('should handle negative numbers', () => {
      const heap = new MinHeap<number>(numericCompare);
      heap.push(-10);
      heap.push(5);
      heap.push(-3);
      heap.push(0);

      expect(heap.pop()).toBe(-10);
      expect(heap.pop()).toBe(-3);
      expect(heap.pop()).toBe(0);
      expect(heap.pop()).toBe(5);
    });

    it('should work with custom object comparator', () => {
      interface Task { priority: number; name: string }
      const heap = new MinHeap<Task>((a, b) => a.priority - b.priority);
      heap.push({ priority: 3, name: 'low' });
      heap.push({ priority: 1, name: 'high' });
      heap.push({ priority: 2, name: 'med' });

      expect(heap.pop()!.name).toBe('high');
      expect(heap.pop()!.name).toBe('med');
      expect(heap.pop()!.name).toBe('low');
    });
  });

  // ==========================================================================
  // Large Dataset
  // ==========================================================================

  describe('large dataset', () => {
    it('should correctly sort 200 elements', () => {
      const heap = new MinHeap<number>(numericCompare);
      const values: number[] = [];

      // Generate random values
      for (let i = 0; i < 200; i++) {
        const val = Math.floor(Math.random() * 10000);
        values.push(val);
        heap.push(val);
      }

      const sorted = heap.extractAll();
      const expected = [...values].sort((a, b) => a - b);

      expect(sorted).toEqual(expected);
      expect(heap.isEmpty).toBe(true);
    });
  });
});

// ===========================================================================
// findKSmallest
// ===========================================================================

describe('findKSmallest', () => {
  const numericCompare = (a: number, b: number) => a - b;

  it('should return k smallest elements in ascending order', () => {
    const items = [50, 30, 10, 40, 20];
    const result = findKSmallest(items, 3, numericCompare);
    expect(result).toEqual([10, 20, 30]);
  });

  it('should return empty array when k is 0', () => {
    const items = [1, 2, 3];
    expect(findKSmallest(items, 0, numericCompare)).toEqual([]);
  });

  it('should return all items sorted when k exceeds length', () => {
    const items = [3, 1, 2];
    const result = findKSmallest(items, 10, numericCompare);
    expect(result).toEqual([1, 2, 3]);
  });

  it('should work with empty iterable', () => {
    expect(findKSmallest([], 5, numericCompare)).toEqual([]);
  });

  it('should work with iterable (Set)', () => {
    const items = new Set([50, 10, 30, 20, 40]);
    const result = findKSmallest(items, 2, numericCompare);
    expect(result).toEqual([10, 20]);
  });

  it('should work with Map.entries() and tuple comparator (production pattern)', () => {
    // This is the universal production pattern used by coordinator, opportunity-router,
    // active-pairs-tracker, and lock-conflict-tracker
    const map = new Map<string, { timestamp: number; value: string }>();
    map.set('pair-A', { timestamp: 1000, value: 'oldest' });
    map.set('pair-B', { timestamp: 3000, value: 'newest' });
    map.set('pair-C', { timestamp: 2000, value: 'middle' });
    map.set('pair-D', { timestamp: 1500, value: 'second' });

    const oldest2 = findKSmallest(
      map.entries(),
      2,
      ([, a], [, b]) => a.timestamp - b.timestamp
    );

    expect(oldest2).toHaveLength(2);
    expect(oldest2[0][0]).toBe('pair-A');
    expect(oldest2[0][1].value).toBe('oldest');
    expect(oldest2[1][0]).toBe('pair-D');
    expect(oldest2[1][1].value).toBe('second');
  });
});

// ===========================================================================
// findKLargest
// ===========================================================================

describe('findKLargest', () => {
  const numericCompare = (a: number, b: number) => a - b;

  it('should return k largest elements in descending order', () => {
    const items = [50, 30, 10, 40, 20];
    const result = findKLargest(items, 3, numericCompare);
    expect(result).toEqual([50, 40, 30]);
  });

  it('should return empty array when k is 0', () => {
    const items = [1, 2, 3];
    expect(findKLargest(items, 0, numericCompare)).toEqual([]);
  });

  it('should return all items sorted descending when k exceeds length', () => {
    const items = [3, 1, 2];
    const result = findKLargest(items, 10, numericCompare);
    expect(result).toEqual([3, 2, 1]);
  });

  it('should work with empty iterable', () => {
    expect(findKLargest([], 5, numericCompare)).toEqual([]);
  });
});
