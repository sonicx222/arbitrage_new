/**
 * LRU Queue Unit Tests
 *
 * Tests for O(1) doubly-linked list + Map LRU queue used by hierarchical cache
 * for L1 eviction (ADR-005).
 *
 * @see shared/core/src/caching/lru-queue.ts
 */

import { LRUQueue } from '../../../src/caching/lru-queue';

describe('LRUQueue', () => {
  let queue: LRUQueue;

  beforeEach(() => {
    queue = new LRUQueue();
  });

  describe('initialization', () => {
    it('should start empty', () => {
      expect(queue.size).toBe(0);
      expect(queue.keys()).toEqual([]);
    });

    it('should return null when evicting from empty queue', () => {
      expect(queue.evictOldest()).toBeNull();
    });
  });

  describe('add', () => {
    it('should add a key and increase size', () => {
      queue.add('a');
      expect(queue.size).toBe(1);
      expect(queue.has('a')).toBe(true);
    });

    it('should maintain insertion order (oldest first)', () => {
      queue.add('a');
      queue.add('b');
      queue.add('c');
      expect(queue.keys()).toEqual(['a', 'b', 'c']);
      expect(queue.size).toBe(3);
    });

    it('should move existing key to end instead of duplicating', () => {
      queue.add('a');
      queue.add('b');
      queue.add('c');
      queue.add('a'); // re-add existing key
      expect(queue.keys()).toEqual(['b', 'c', 'a']);
      expect(queue.size).toBe(3); // no duplicate
    });
  });

  describe('touch', () => {
    it('should move key to end (most recently used)', () => {
      queue.add('a');
      queue.add('b');
      queue.add('c');
      queue.touch('a');
      expect(queue.keys()).toEqual(['b', 'c', 'a']);
    });

    it('should be a no-op for non-existent key', () => {
      queue.add('a');
      queue.touch('nonexistent');
      expect(queue.keys()).toEqual(['a']);
      expect(queue.size).toBe(1);
    });

    it('should handle touching the only element', () => {
      queue.add('a');
      queue.touch('a');
      expect(queue.keys()).toEqual(['a']);
      expect(queue.size).toBe(1);
    });

    it('should handle touching the last element (already newest)', () => {
      queue.add('a');
      queue.add('b');
      queue.touch('b');
      expect(queue.keys()).toEqual(['a', 'b']);
    });

    it('should handle touching a middle element', () => {
      queue.add('a');
      queue.add('b');
      queue.add('c');
      queue.add('d');
      queue.touch('b');
      expect(queue.keys()).toEqual(['a', 'c', 'd', 'b']);
    });
  });

  describe('evictOldest', () => {
    it('should remove and return the oldest key', () => {
      queue.add('a');
      queue.add('b');
      queue.add('c');
      expect(queue.evictOldest()).toBe('a');
      expect(queue.size).toBe(2);
      expect(queue.has('a')).toBe(false);
      expect(queue.keys()).toEqual(['b', 'c']);
    });

    it('should evict in insertion order', () => {
      queue.add('a');
      queue.add('b');
      queue.add('c');
      expect(queue.evictOldest()).toBe('a');
      expect(queue.evictOldest()).toBe('b');
      expect(queue.evictOldest()).toBe('c');
      expect(queue.evictOldest()).toBeNull();
      expect(queue.size).toBe(0);
    });

    it('should respect touch order when evicting', () => {
      queue.add('a');
      queue.add('b');
      queue.add('c');
      queue.touch('a'); // 'a' is now newest
      expect(queue.evictOldest()).toBe('b');
      expect(queue.evictOldest()).toBe('c');
      expect(queue.evictOldest()).toBe('a');
    });

    it('should handle evicting single element', () => {
      queue.add('only');
      expect(queue.evictOldest()).toBe('only');
      expect(queue.size).toBe(0);
      expect(queue.evictOldest()).toBeNull();
    });
  });

  describe('remove', () => {
    it('should remove a specific key and return true', () => {
      queue.add('a');
      queue.add('b');
      queue.add('c');
      expect(queue.remove('b')).toBe(true);
      expect(queue.keys()).toEqual(['a', 'c']);
      expect(queue.size).toBe(2);
      expect(queue.has('b')).toBe(false);
    });

    it('should return false for non-existent key', () => {
      queue.add('a');
      expect(queue.remove('nonexistent')).toBe(false);
      expect(queue.size).toBe(1);
    });

    it('should handle removing the head (oldest)', () => {
      queue.add('a');
      queue.add('b');
      expect(queue.remove('a')).toBe(true);
      expect(queue.keys()).toEqual(['b']);
    });

    it('should handle removing the tail (newest)', () => {
      queue.add('a');
      queue.add('b');
      expect(queue.remove('b')).toBe(true);
      expect(queue.keys()).toEqual(['a']);
    });

    it('should handle removing the only element', () => {
      queue.add('a');
      expect(queue.remove('a')).toBe(true);
      expect(queue.size).toBe(0);
      expect(queue.keys()).toEqual([]);
    });
  });

  describe('has', () => {
    it('should return true for existing keys', () => {
      queue.add('x');
      expect(queue.has('x')).toBe(true);
    });

    it('should return false for non-existing keys', () => {
      expect(queue.has('x')).toBe(false);
    });

    it('should return false after key is removed', () => {
      queue.add('x');
      queue.remove('x');
      expect(queue.has('x')).toBe(false);
    });

    it('should return false after key is evicted', () => {
      queue.add('x');
      queue.evictOldest();
      expect(queue.has('x')).toBe(false);
    });
  });

  describe('clear', () => {
    it('should remove all entries', () => {
      queue.add('a');
      queue.add('b');
      queue.add('c');
      queue.clear();
      expect(queue.size).toBe(0);
      expect(queue.keys()).toEqual([]);
      expect(queue.has('a')).toBe(false);
    });

    it('should allow new entries after clearing', () => {
      queue.add('a');
      queue.clear();
      queue.add('b');
      expect(queue.size).toBe(1);
      expect(queue.keys()).toEqual(['b']);
    });

    it('should return null on evict after clearing', () => {
      queue.add('a');
      queue.clear();
      expect(queue.evictOldest()).toBeNull();
    });
  });

  describe('mixed operations', () => {
    it('should maintain consistency through add/touch/evict/remove sequence', () => {
      queue.add('a');
      queue.add('b');
      queue.add('c');
      queue.add('d');
      queue.add('e');

      queue.touch('b');    // order: a, c, d, e, b
      queue.evictOldest(); // evicts 'a', order: c, d, e, b
      queue.remove('d');   // order: c, e, b
      queue.add('f');      // order: c, e, b, f

      expect(queue.keys()).toEqual(['c', 'e', 'b', 'f']);
      expect(queue.size).toBe(4);
    });

    it('should handle rapid add-remove cycles without leaking nodes', () => {
      for (let i = 0; i < 100; i++) {
        queue.add(`key-${i}`);
      }
      expect(queue.size).toBe(100);

      for (let i = 0; i < 100; i++) {
        queue.remove(`key-${i}`);
      }
      expect(queue.size).toBe(0);
      expect(queue.keys()).toEqual([]);
      expect(queue.evictOldest()).toBeNull();
    });

    it('should handle rapid add-evict cycles', () => {
      for (let i = 0; i < 50; i++) {
        queue.add(`key-${i}`);
      }
      for (let i = 0; i < 50; i++) {
        expect(queue.evictOldest()).toBe(`key-${i}`);
      }
      expect(queue.size).toBe(0);
    });

    it('should handle interleaved add and evict as a fixed-size cache', () => {
      const maxSize = 3;
      const evicted: string[] = [];

      for (let i = 0; i < 10; i++) {
        queue.add(`key-${i}`);
        if (queue.size > maxSize) {
          const key = queue.evictOldest();
          if (key) evicted.push(key);
        }
      }

      expect(queue.size).toBe(maxSize);
      expect(queue.keys()).toEqual(['key-7', 'key-8', 'key-9']);
      expect(evicted).toEqual(['key-0', 'key-1', 'key-2', 'key-3', 'key-4', 'key-5', 'key-6']);
    });
  });
});
