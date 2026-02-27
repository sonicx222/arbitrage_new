/**
 * Tests for CpuUsageTracker
 *
 * @see H2 — CPU metric hardcoded to 0 in 4 services (Terminal Analysis Consolidated Plan)
 * @see shared/core/src/monitoring/cpu-usage-tracker.ts
 */

import { CpuUsageTracker } from '../../../src/monitoring/cpu-usage-tracker';

describe('CpuUsageTracker', () => {
  let tracker: CpuUsageTracker;

  beforeEach(() => {
    tracker = new CpuUsageTracker();
  });

  describe('getUsagePercent()', () => {
    it('should return 0 on the first call (no baseline)', () => {
      const result = tracker.getUsagePercent();
      expect(result).toBe(0);
    });

    it('should return a number between 0 and 1 on subsequent calls', () => {
      // First call sets baseline
      tracker.getUsagePercent();

      // Do some work to consume CPU
      let sum = 0;
      for (let i = 0; i < 100_000; i++) {
        sum += Math.sqrt(i);
      }
      // Prevent dead-code elimination
      void sum;

      const result = tracker.getUsagePercent();
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(1);
    });

    it('should use delta-based calculation (not cumulative)', () => {
      // First call: baseline
      tracker.getUsagePercent();

      // Second call: some delta
      const first = tracker.getUsagePercent();

      // Third call: another delta (independent of first)
      const second = tracker.getUsagePercent();

      // Both should be valid percentages
      expect(first).toBeGreaterThanOrEqual(0);
      expect(first).toBeLessThanOrEqual(1);
      expect(second).toBeGreaterThanOrEqual(0);
      expect(second).toBeLessThanOrEqual(1);
    });

    it('should clamp result to [0, 1] range', () => {
      // Mock process.cpuUsage to return extreme values
      const originalCpuUsage = process.cpuUsage;
      let callCount = 0;

      process.cpuUsage = (() => {
        callCount++;
        if (callCount === 1) {
          return { user: 0, system: 0 };
        }
        // Return huge delta to test clamping
        return { user: 999_999_999, system: 999_999_999 };
      }) as typeof process.cpuUsage;

      const originalDateNow = Date.now;
      let timeCallCount = 0;
      Date.now = () => {
        timeCallCount++;
        // First call: 0, second call: 1ms later (very short interval → high %)
        return timeCallCount === 1 ? 1000 : 1001;
      };

      try {
        tracker.getUsagePercent(); // baseline
        const result = tracker.getUsagePercent();
        expect(result).toBeLessThanOrEqual(1);
      } finally {
        process.cpuUsage = originalCpuUsage;
        Date.now = originalDateNow;
      }
    });
  });

  describe('reset()', () => {
    it('should clear tracking state so next call returns 0', () => {
      // Establish baseline
      tracker.getUsagePercent();
      tracker.getUsagePercent(); // non-zero delta

      // Reset
      tracker.reset();

      // After reset, should return 0 (no baseline)
      const result = tracker.getUsagePercent();
      expect(result).toBe(0);
    });
  });

  describe('integration with process.cpuUsage()', () => {
    it('should produce consistent results with known deltas', () => {
      const originalCpuUsage = process.cpuUsage;
      const originalDateNow = Date.now;

      // Mock: 500ms wall time, 250ms user + 100ms system = 350ms CPU = 70%
      let callCount = 0;
      process.cpuUsage = (() => {
        callCount++;
        if (callCount === 1) return { user: 1_000_000, system: 500_000 }; // 1s user, 0.5s system (cumulative)
        return { user: 1_250_000, system: 600_000 }; // +250ms user, +100ms system
      }) as typeof process.cpuUsage;

      let timeCallCount = 0;
      Date.now = () => {
        timeCallCount++;
        return timeCallCount === 1 ? 10_000 : 10_500; // 500ms wall time
      };

      try {
        tracker.getUsagePercent(); // baseline
        const result = tracker.getUsagePercent();
        // (250000 + 100000) / (500 * 1000) = 350000 / 500000 = 0.7
        expect(result).toBeCloseTo(0.7, 5);
      } finally {
        process.cpuUsage = originalCpuUsage;
        Date.now = originalDateNow;
      }
    });

    it('should return 0 when wall time delta is 0', () => {
      const originalCpuUsage = process.cpuUsage;
      const originalDateNow = Date.now;

      process.cpuUsage = (() => ({ user: 100_000, system: 50_000 })) as typeof process.cpuUsage;

      // Same time for both calls
      Date.now = () => 10_000;

      try {
        tracker.getUsagePercent();
        const result = tracker.getUsagePercent();
        expect(result).toBe(0);
      } finally {
        process.cpuUsage = originalCpuUsage;
        Date.now = originalDateNow;
      }
    });
  });
});
