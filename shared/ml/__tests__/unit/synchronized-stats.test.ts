/**
 * Unit tests for SynchronizedStats
 *
 * Tests the thread-safe statistics tracking utility used by ML models.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { SynchronizedStats, createSynchronizedStats } from '../../src/synchronized-stats';

describe('SynchronizedStats', () => {
  let stats: SynchronizedStats;

  beforeEach(() => {
    stats = new SynchronizedStats();
  });

  // ===========================================================================
  // Constructor
  // ===========================================================================

  describe('constructor', () => {
    it('should create with default config', () => {
      const s = new SynchronizedStats();
      expect(s.getVersion()).toBe(0);
      expect(s.getCounter('anything')).toBe(0);
      expect(s.getAccumulator('anything')).toBe(0);
    });

    it('should create with initial counters', () => {
      const s = new SynchronizedStats({
        initialCounters: { predictions: 5, errors: 2 },
      });
      expect(s.getCounter('predictions')).toBe(5);
      expect(s.getCounter('errors')).toBe(2);
    });

    it('should create with initial accumulators', () => {
      const s = new SynchronizedStats({
        initialAccumulators: { totalLatency: 150.5, totalProfit: 0.03 },
      });
      expect(s.getAccumulator('totalLatency')).toBe(150.5);
      expect(s.getAccumulator('totalProfit')).toBe(0.03);
    });

    it('should create with custom maxHistorySize', () => {
      const s = new SynchronizedStats({ maxHistorySize: 5 });
      // Add more values than maxHistorySize
      for (let i = 0; i < 10; i++) {
        s.recordValue('key', i);
      }
      // Should only keep last 5
      expect(s.getHistorySize('key')).toBe(5);
      const history = s.getHistory('key');
      expect(history).toEqual([5, 6, 7, 8, 9]);
    });
  });

  // ===========================================================================
  // Counter Operations
  // ===========================================================================

  describe('counter operations', () => {
    it('should increment: creates counter at 1 if new', () => {
      const result = stats.increment('newCounter');
      expect(result).toBe(1);
      expect(stats.getCounter('newCounter')).toBe(1);
    });

    it('should increment: increments existing counter', () => {
      stats.increment('counter');
      stats.increment('counter');
      stats.increment('counter');
      expect(stats.getCounter('counter')).toBe(3);
    });

    it('should incrementBy: adds specified amount', () => {
      stats.incrementBy('counter', 5);
      expect(stats.getCounter('counter')).toBe(5);
      stats.incrementBy('counter', 3);
      expect(stats.getCounter('counter')).toBe(8);
    });

    it('should getCounter: returns 0 for non-existent', () => {
      expect(stats.getCounter('nonExistent')).toBe(0);
    });

    it('should setCounter: sets specific value', () => {
      stats.setCounter('counter', 42);
      expect(stats.getCounter('counter')).toBe(42);
    });

    it('should resetCounter: sets to 0', () => {
      stats.increment('counter');
      stats.increment('counter');
      stats.resetCounter('counter');
      expect(stats.getCounter('counter')).toBe(0);
    });
  });

  // ===========================================================================
  // Accumulator Operations
  // ===========================================================================

  describe('accumulator operations', () => {
    it('should accumulate: adds value and returns new total', () => {
      const result1 = stats.accumulate('total', 10.5);
      expect(result1).toBe(10.5);
      const result2 = stats.accumulate('total', 5.3);
      expect(result2).toBeCloseTo(15.8, 10);
    });

    it('should accumulate: ignores NaN', () => {
      stats.accumulate('total', 10);
      const result = stats.accumulate('total', NaN);
      expect(result).toBe(10);
      expect(stats.getAccumulator('total')).toBe(10);
    });

    it('should accumulate: ignores Infinity', () => {
      stats.accumulate('total', 10);
      const result = stats.accumulate('total', Infinity);
      expect(result).toBe(10);
      expect(stats.getAccumulator('total')).toBe(10);
    });

    it('should accumulate with trackHistory=true: tracks in history', () => {
      stats.accumulate('total', 10, true);
      stats.accumulate('total', 20, true);
      stats.accumulate('total', 30, true);
      expect(stats.getHistorySize('total')).toBe(3);
      expect(stats.getHistory('total')).toEqual([10, 20, 30]);
    });

    it('should getAccumulator: returns 0 for non-existent', () => {
      expect(stats.getAccumulator('nonExistent')).toBe(0);
    });

    it('should setAccumulator: sets specific value', () => {
      stats.setAccumulator('total', 99.9);
      expect(stats.getAccumulator('total')).toBe(99.9);
    });

    it('should resetAccumulator: sets to 0', () => {
      stats.accumulate('total', 100);
      stats.resetAccumulator('total');
      expect(stats.getAccumulator('total')).toBe(0);
    });
  });

  // ===========================================================================
  // Average Calculations
  // ===========================================================================

  describe('average calculations', () => {
    it('should getAverage: correct accumulator/counter ratio', () => {
      stats.accumulate('totalLatency', 100);
      stats.accumulate('totalLatency', 200);
      stats.setCounter('requests', 2);
      expect(stats.getAverage('totalLatency', 'requests')).toBe(150);
    });

    it('should getAverage: returns 0 when counter is 0', () => {
      stats.accumulate('totalLatency', 100);
      expect(stats.getAverage('totalLatency', 'requests')).toBe(0);
    });

    it('should getRollingAverage: correct average from history', () => {
      stats.accumulate('latency', 10, true);
      stats.accumulate('latency', 20, true);
      stats.accumulate('latency', 30, true);
      expect(stats.getRollingAverage('latency')).toBe(20);
    });

    it('should getRollingAverage: windowSize limits values', () => {
      stats.accumulate('latency', 10, true);
      stats.accumulate('latency', 20, true);
      stats.accumulate('latency', 30, true);
      stats.accumulate('latency', 40, true);
      // Window of 2: average of last 2 values (30, 40) = 35
      expect(stats.getRollingAverage('latency', 2)).toBe(35);
    });

    it('should getRollingAverage: returns 0 for no history', () => {
      expect(stats.getRollingAverage('nonExistent')).toBe(0);
    });

    it('should getRecentAccuracy: counts matching values', () => {
      // Record 10 values: 5 pass the predicate
      for (let i = 0; i < 10; i++) {
        stats.recordValue('accuracy', i);
      }
      // Predicate: value >= 5 -> 5 out of 10 = 0.5
      const accuracy = stats.getRecentAccuracy('accuracy', (v) => v >= 5);
      expect(accuracy).toBe(0.5);
    });
  });

  // ===========================================================================
  // Snapshot
  // ===========================================================================

  describe('snapshot', () => {
    it('should getSnapshot: includes all counters and accumulators', () => {
      stats.increment('requests');
      stats.increment('requests');
      stats.accumulate('totalLatency', 150);
      const snapshot = stats.getSnapshot();
      expect(snapshot.counters.requests).toBe(2);
      expect(snapshot.accumulators.totalLatency).toBe(150);
      expect(snapshot.timestamp).toBeGreaterThan(0);
    });

    it('should getSnapshot: calculates *_total/*_count averages automatically', () => {
      stats.accumulate('latency_total', 300);
      stats.setCounter('latency_count', 3);
      const snapshot = stats.getSnapshot();
      expect(snapshot.averages.latency).toBe(100);
    });
  });

  // ===========================================================================
  // Batch Operations
  // ===========================================================================

  describe('batch operations', () => {
    it('should batchUpdate: updates multiple counters and accumulators atomically', () => {
      stats.setCounter('requests', 10);
      stats.setAccumulator('latency', 100);

      stats.batchUpdate({
        counters: { requests: 5, errors: 2 },
        accumulators: { latency: 50, profit: 0.1 },
      });

      expect(stats.getCounter('requests')).toBe(15);
      expect(stats.getCounter('errors')).toBe(2);
      expect(stats.getAccumulator('latency')).toBe(150);
      expect(stats.getAccumulator('profit')).toBeCloseTo(0.1, 10);
    });
  });

  // ===========================================================================
  // History
  // ===========================================================================

  describe('history', () => {
    it('should recordValue: adds to history without accumulating', () => {
      stats.recordValue('latency', 10);
      stats.recordValue('latency', 20);
      expect(stats.getHistory('latency')).toEqual([10, 20]);
      // Should not affect accumulators
      expect(stats.getAccumulator('latency')).toBe(0);
    });

    it('should recordValue: ignores NaN', () => {
      stats.recordValue('latency', 10);
      stats.recordValue('latency', NaN);
      expect(stats.getHistorySize('latency')).toBe(1);
    });

    it('should recordValue: ignores Infinity', () => {
      stats.recordValue('latency', 10);
      stats.recordValue('latency', Infinity);
      stats.recordValue('latency', -Infinity);
      expect(stats.getHistorySize('latency')).toBe(1);
    });

    it('should enforce bounded history: evicts oldest when maxHistorySize reached', () => {
      const s = new SynchronizedStats({ maxHistorySize: 3 });
      s.recordValue('key', 1);
      s.recordValue('key', 2);
      s.recordValue('key', 3);
      s.recordValue('key', 4);
      expect(s.getHistorySize('key')).toBe(3);
      expect(s.getHistory('key')).toEqual([2, 3, 4]);
    });

    it('should getHistory: returns copy (mutation-safe)', () => {
      stats.recordValue('key', 1);
      stats.recordValue('key', 2);
      const history = stats.getHistory('key');
      history.push(999);
      // Original should not be affected
      expect(stats.getHistory('key')).toEqual([1, 2]);
    });

    it('should getHistorySize: correct size', () => {
      expect(stats.getHistorySize('key')).toBe(0);
      stats.recordValue('key', 1);
      stats.recordValue('key', 2);
      expect(stats.getHistorySize('key')).toBe(2);
    });

    it('should clearHistory: clears specific key', () => {
      stats.recordValue('a', 1);
      stats.recordValue('b', 2);
      stats.clearHistory('a');
      expect(stats.getHistorySize('a')).toBe(0);
      expect(stats.getHistorySize('b')).toBe(1);
    });

    it('should clearAllHistory: clears all', () => {
      stats.recordValue('a', 1);
      stats.recordValue('b', 2);
      stats.clearAllHistory();
      expect(stats.getHistorySize('a')).toBe(0);
      expect(stats.getHistorySize('b')).toBe(0);
    });
  });

  // ===========================================================================
  // Version Tracking
  // ===========================================================================

  describe('version tracking', () => {
    it('should getVersion: increments on mutations', () => {
      expect(stats.getVersion()).toBe(0);
      stats.increment('counter');
      expect(stats.getVersion()).toBe(1);
      stats.accumulate('acc', 5);
      expect(stats.getVersion()).toBe(2);
      stats.setCounter('counter', 10);
      expect(stats.getVersion()).toBe(3);
      stats.setAccumulator('acc', 10);
      expect(stats.getVersion()).toBe(4);
    });

    it('should reset: clears everything and resets version to 0', () => {
      stats.increment('counter');
      stats.accumulate('acc', 5, true);
      stats.recordValue('hist', 1);
      expect(stats.getVersion()).toBeGreaterThan(0);

      stats.reset();
      expect(stats.getVersion()).toBe(0);
      expect(stats.getCounter('counter')).toBe(0);
      expect(stats.getAccumulator('acc')).toBe(0);
      expect(stats.getHistorySize('hist')).toBe(0);
    });
  });

  // ===========================================================================
  // Factory
  // ===========================================================================

  describe('factory', () => {
    it('should createSynchronizedStats: creates correctly', () => {
      const s = createSynchronizedStats({
        initialCounters: { x: 1 },
        initialAccumulators: { y: 2.5 },
      });
      expect(s).toBeInstanceOf(SynchronizedStats);
      expect(s.getCounter('x')).toBe(1);
      expect(s.getAccumulator('y')).toBe(2.5);
    });
  });
});
