/**
 * SpreadTracker Tests
 *
 * Tests Bollinger Band signal generation from log-spread tracking.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.mock('../../../src/logger');

import { SpreadTracker } from '../../../src/analytics/spread-tracker';

describe('SpreadTracker', () => {
  let tracker: SpreadTracker;

  beforeEach(() => {
    tracker = new SpreadTracker({
      bollingerPeriod: 10,
      bollingerStdDev: 2.0,
      maxPairs: 50,
    });
  });

  // ===========================================================================
  // Stable Spread => 'none'
  // ===========================================================================

  describe('stable spread', () => {
    it('should return none signal when spread is within bands', () => {
      const pairId = 'STABLE';
      // Add stable prices where spread is roughly constant
      for (let i = 0; i < 10; i++) {
        tracker.addSpread(pairId, 100, 50); // log(100/50) = log(2) ~ 0.693
      }

      const signal = tracker.getSignal(pairId);
      expect(signal).toBe('none');
    });
  });

  // ===========================================================================
  // Entry Long: Spread Below Lower Band
  // ===========================================================================

  describe('spread below lower band', () => {
    it('should return entry_long when spread drops below lower band', () => {
      const pairId = 'LONG_ENTRY';

      // Build stable history first
      for (let i = 0; i < 9; i++) {
        tracker.addSpread(pairId, 100, 50); // spread = log(2) ~ 0.693
      }

      // Add a large downward deviation (A much cheaper relative to B)
      // log(30/50) = log(0.6) ~ -0.511, which is way below the mean of ~0.693
      tracker.addSpread(pairId, 30, 50);

      const signal = tracker.getSignal(pairId);
      expect(signal).toBe('entry_long');
    });
  });

  // ===========================================================================
  // Entry Short: Spread Above Upper Band
  // ===========================================================================

  describe('spread above upper band', () => {
    it('should return entry_short when spread rises above upper band', () => {
      const pairId = 'SHORT_ENTRY';

      // Build stable history first
      for (let i = 0; i < 9; i++) {
        tracker.addSpread(pairId, 100, 50); // spread = log(2) ~ 0.693
      }

      // Add a large upward deviation (A much more expensive relative to B)
      // log(300/50) = log(6) ~ 1.791, way above mean
      tracker.addSpread(pairId, 300, 50);

      const signal = tracker.getSignal(pairId);
      expect(signal).toBe('entry_short');
    });
  });

  // ===========================================================================
  // Exit: Spread Returns to Mean
  // ===========================================================================

  describe('spread returns to mean', () => {
    it('should return exit when spread crosses back through middle', () => {
      const pairId = 'EXIT_TEST';

      // First, fill with values where spread gradually rises then falls back
      // The key is the previous spread must be on one side and current on other
      const basePriceB = 50;

      // Build some history with moderate spread variation
      // Then have a clear cross through the middle band
      for (let i = 0; i < 8; i++) {
        tracker.addSpread(pairId, 100, basePriceB); // stable baseline
      }

      // Push spread above middle
      tracker.addSpread(pairId, 120, basePriceB); // slightly above mean

      // Then jump back below middle
      tracker.addSpread(pairId, 90, basePriceB); // below mean

      const signal = tracker.getSignal(pairId);
      expect(signal).toBe('exit');
    });
  });

  // ===========================================================================
  // Bollinger Bands Calculation
  // ===========================================================================

  describe('Bollinger bands calculation', () => {
    it('should compute bands correctly', () => {
      const pairId = 'BANDS';
      // Use known spread values for manual verification
      const prices = [100, 102, 98, 101, 99, 103, 97, 100, 104, 96];
      const baseB = 50;

      for (const p of prices) {
        tracker.addSpread(pairId, p, baseB);
      }

      const bands = tracker.getBollingerBands(pairId);
      expect(bands).toBeDefined();
      expect(bands!.upper).toBeGreaterThan(bands!.middle);
      expect(bands!.lower).toBeLessThan(bands!.middle);
      expect(bands!.upper - bands!.middle).toBeCloseTo(bands!.middle - bands!.lower, 10);

      // Verify middle is the SMA
      const spreads = prices.map(p => Math.log(p / baseB));
      const expectedMiddle = spreads.reduce((sum, s) => sum + s, 0) / spreads.length;
      expect(bands!.middle).toBeCloseTo(expectedMiddle, 8);

      // Verify band width matches 2 * std dev
      const variance = spreads.reduce((sum, s) => sum + (s - expectedMiddle) ** 2, 0) / spreads.length;
      const expectedStdDev = Math.sqrt(variance);
      expect(bands!.upper).toBeCloseTo(expectedMiddle + 2.0 * expectedStdDev, 8);
      expect(bands!.lower).toBeCloseTo(expectedMiddle - 2.0 * expectedStdDev, 8);
    });

    it('should return undefined with insufficient data', () => {
      tracker.addSpread('FEW', 100, 50);
      tracker.addSpread('FEW', 110, 50);
      expect(tracker.getBollingerBands('FEW')).toBeUndefined();
    });
  });

  // ===========================================================================
  // Insufficient Data Returns 'none'
  // ===========================================================================

  describe('insufficient data', () => {
    it('should return none for unknown pair', () => {
      expect(tracker.getSignal('UNKNOWN')).toBe('none');
    });

    it('should return none when not enough samples to fill period', () => {
      for (let i = 0; i < 5; i++) {
        tracker.addSpread('PARTIAL', 100, 50);
      }
      expect(tracker.getSignal('PARTIAL')).toBe('none');
    });
  });

  // ===========================================================================
  // Spread History
  // ===========================================================================

  describe('getSpreadHistory', () => {
    it('should return empty array for unknown pair', () => {
      expect(tracker.getSpreadHistory('NOPE')).toEqual([]);
    });

    it('should return spreads in chronological order', () => {
      const pairId = 'HISTORY';
      const prices = [100, 110, 120, 130, 140];
      const baseB = 50;

      for (const p of prices) {
        tracker.addSpread(pairId, p, baseB);
      }

      const history = tracker.getSpreadHistory(pairId);
      expect(history).toHaveLength(5);

      // Verify order: each spread should be log(price/50)
      for (let i = 0; i < prices.length; i++) {
        expect(history[i]).toBeCloseTo(Math.log(prices[i] / baseB), 10);
      }
    });
  });

  // ===========================================================================
  // Reset
  // ===========================================================================

  describe('reset', () => {
    it('should clear all tracked pairs', () => {
      for (let i = 0; i < 10; i++) {
        tracker.addSpread('A', 100, 50);
        tracker.addSpread('B', 200, 100);
      }

      tracker.reset();

      expect(tracker.getSignal('A')).toBe('none');
      expect(tracker.getSignal('B')).toBe('none');
      expect(tracker.getSpreadHistory('A')).toEqual([]);
      expect(tracker.getSpreadHistory('B')).toEqual([]);
    });
  });

  // ===========================================================================
  // Invalid Prices
  // ===========================================================================

  describe('invalid prices', () => {
    it('should reject zero/negative prices', () => {
      tracker.addSpread('INVALID', 0, 50);
      tracker.addSpread('INVALID', 100, 0);
      tracker.addSpread('INVALID', -10, 50);

      expect(tracker.getSpreadHistory('INVALID')).toEqual([]);
    });
  });
});
