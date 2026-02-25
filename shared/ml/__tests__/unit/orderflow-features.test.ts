/**
 * Orderflow Feature Engineering Tests (T4.3.1)
 *
 * Tests for orderflow feature extraction used by the Orderflow Predictor.
 * Features include whale behavior, time patterns, pool dynamics, and liquidation signals.
 *
 * @see docs/reports/implementation_plan_v3.md - Phase 4, Task 4.3.1
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// P3-3/P3-4: Use shared mock helpers to reduce duplication
import { type MockWhaleActivitySummary, createMockWhaleActivitySummary, createDefaultInput } from './__helpers__/mock-orderflow';

// =============================================================================
// Test Setup - Mock whale activity tracker
// =============================================================================

// Create mock whale tracker
const mockWhaleTracker = {
  getActivitySummary: jest.fn<(pairKey: string, chain: string, windowMs?: number) => MockWhaleActivitySummary>()
};

// Mock the @arbitrage/core module with default implementations for module-level code
jest.mock('@arbitrage/core', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  })),
  getWhaleActivityTracker: jest.fn()
}));

// Import after mocking
import {
  OrderflowFeatureExtractor,
  getOrderflowFeatureExtractor,
  resetOrderflowFeatureExtractor
} from '../../src/orderflow-features';

// Get the mocked module and set up whale tracker implementation
import { getWhaleActivityTracker } from '@arbitrage/core/analytics';
const mockedGetWhaleActivityTracker = jest.mocked(getWhaleActivityTracker);
mockedGetWhaleActivityTracker.mockReturnValue(mockWhaleTracker as any);
import type {
  OrderflowFeatureInput,
  OrderflowExtractorConfig
} from '../../src/orderflow-features';

// P3-3: Helpers now imported from __helpers__/mock-orderflow.ts

// =============================================================================
// OrderflowFeatureExtractor Tests
// =============================================================================

describe('OrderflowFeatureExtractor', () => {
  let extractor: OrderflowFeatureExtractor;

  beforeEach(() => {
    jest.clearAllMocks();
    // Re-setup whale tracker mock after clearAllMocks
    mockedGetWhaleActivityTracker.mockReturnValue(mockWhaleTracker as any);
    resetOrderflowFeatureExtractor();
    extractor = new OrderflowFeatureExtractor();
  });

  afterEach(() => {
    resetOrderflowFeatureExtractor();
  });

  describe('Whale Behavior Features', () => {
    it('should extract whale swap count from activity summary', () => {
      const summary = createMockWhaleActivitySummary({ whaleCount: 25 });
      mockWhaleTracker.getActivitySummary.mockReturnValue(summary);

      const input = createDefaultInput();
      const features = extractor.extractFeatures(input);

      expect(features.whaleSwapCount1h).toBe(25);
    });

    it('should determine accumulating direction when buy volume dominates', () => {
      const summary = createMockWhaleActivitySummary({
        buyVolumeUsd: 1000000,
        sellVolumeUsd: 200000,
        dominantDirection: 'bullish'
      });
      mockWhaleTracker.getActivitySummary.mockReturnValue(summary);

      const input = createDefaultInput();
      const features = extractor.extractFeatures(input);

      expect(features.whaleNetDirection).toBe('accumulating');
    });

    it('should determine distributing direction when sell volume dominates', () => {
      const summary = createMockWhaleActivitySummary({
        buyVolumeUsd: 200000,
        sellVolumeUsd: 1000000,
        dominantDirection: 'bearish'
      });
      mockWhaleTracker.getActivitySummary.mockReturnValue(summary);

      const input = createDefaultInput();
      const features = extractor.extractFeatures(input);

      expect(features.whaleNetDirection).toBe('distributing');
    });

    it('should determine neutral direction when volumes are balanced', () => {
      const summary = createMockWhaleActivitySummary({
        buyVolumeUsd: 500000,
        sellVolumeUsd: 500000,
        dominantDirection: 'neutral'
      });
      mockWhaleTracker.getActivitySummary.mockReturnValue(summary);

      const input = createDefaultInput();
      const features = extractor.extractFeatures(input);

      expect(features.whaleNetDirection).toBe('neutral');
    });

    it('should return zero whale count when no whale activity', () => {
      const summary = createMockWhaleActivitySummary({
        whaleCount: 0,
        buyVolumeUsd: 0,
        sellVolumeUsd: 0
      });
      mockWhaleTracker.getActivitySummary.mockReturnValue(summary);

      const input = createDefaultInput();
      const features = extractor.extractFeatures(input);

      expect(features.whaleSwapCount1h).toBe(0);
      expect(features.whaleNetDirection).toBe('neutral');
    });

    it('should handle whale tracker errors gracefully', () => {
      mockWhaleTracker.getActivitySummary.mockImplementation(() => {
        throw new Error('Whale tracker unavailable');
      });

      const input = createDefaultInput();
      const features = extractor.extractFeatures(input);

      // Should return safe defaults instead of throwing
      expect(features.whaleSwapCount1h).toBe(0);
      expect(features.whaleNetDirection).toBe('neutral');
    });
  });

  describe('Time Pattern Features', () => {
    it('should extract hour of day correctly', () => {
      mockWhaleTracker.getActivitySummary.mockReturnValue(createMockWhaleActivitySummary());

      // Create timestamp at 14:30 UTC
      const timestamp = new Date('2026-01-27T14:30:00Z').getTime();
      const input = createDefaultInput({ currentTimestamp: timestamp });

      const features = extractor.extractFeatures(input);

      expect(features.hourOfDay).toBe(14);
    });

    it('should extract day of week correctly (Monday = 1)', () => {
      mockWhaleTracker.getActivitySummary.mockReturnValue(createMockWhaleActivitySummary());

      // 2026-01-27 is a Tuesday (day 2)
      const timestamp = new Date('2026-01-27T10:00:00Z').getTime();
      const input = createDefaultInput({ currentTimestamp: timestamp });

      const features = extractor.extractFeatures(input);

      expect(features.dayOfWeek).toBe(2); // Tuesday
    });

    it('should correctly identify US market open hours (9:30-16:00 ET)', () => {
      mockWhaleTracker.getActivitySummary.mockReturnValue(createMockWhaleActivitySummary());

      // 15:00 UTC = 10:00 ET (market open)
      const marketOpenTimestamp = new Date('2026-01-27T15:00:00Z').getTime();
      const inputOpen = createDefaultInput({ currentTimestamp: marketOpenTimestamp });
      const featuresOpen = extractor.extractFeatures(inputOpen);

      expect(featuresOpen.isUsMarketOpen).toBe(true);

      // 01:00 UTC = 20:00 ET (market closed)
      const marketClosedTimestamp = new Date('2026-01-27T01:00:00Z').getTime();
      const inputClosed = createDefaultInput({ currentTimestamp: marketClosedTimestamp });
      const featuresClosed = extractor.extractFeatures(inputClosed);

      expect(featuresClosed.isUsMarketOpen).toBe(false);
    });

    it('should correctly identify Asia market open hours (9:00-15:00 JST)', () => {
      mockWhaleTracker.getActivitySummary.mockReturnValue(createMockWhaleActivitySummary());

      // 02:00 UTC = 11:00 JST (market open)
      const asiaOpenTimestamp = new Date('2026-01-27T02:00:00Z').getTime();
      const inputOpen = createDefaultInput({ currentTimestamp: asiaOpenTimestamp });
      const featuresOpen = extractor.extractFeatures(inputOpen);

      expect(featuresOpen.isAsiaMarketOpen).toBe(true);

      // 10:00 UTC = 19:00 JST (market closed)
      const asiaClosedTimestamp = new Date('2026-01-27T10:00:00Z').getTime();
      const inputClosed = createDefaultInput({ currentTimestamp: asiaClosedTimestamp });
      const featuresClosed = extractor.extractFeatures(inputClosed);

      expect(featuresClosed.isAsiaMarketOpen).toBe(false);
    });

    it('should handle weekend days correctly (both markets closed)', () => {
      mockWhaleTracker.getActivitySummary.mockReturnValue(createMockWhaleActivitySummary());

      // Saturday (during normal trading hours)
      const saturdayTimestamp = new Date('2026-01-31T15:00:00Z').getTime(); // Saturday
      const input = createDefaultInput({ currentTimestamp: saturdayTimestamp });
      const features = extractor.extractFeatures(input);

      // Weekend - markets closed even during normal hours
      expect(features.dayOfWeek).toBe(6); // Saturday
      expect(features.isUsMarketOpen).toBe(false);
      expect(features.isAsiaMarketOpen).toBe(false);
    });

    it('should handle Sunday correctly (both markets closed)', () => {
      mockWhaleTracker.getActivitySummary.mockReturnValue(createMockWhaleActivitySummary());

      // Sunday during Asia market hours
      const sundayTimestamp = new Date('2026-02-01T02:00:00Z').getTime(); // Sunday
      const input = createDefaultInput({ currentTimestamp: sundayTimestamp });
      const features = extractor.extractFeatures(input);

      expect(features.dayOfWeek).toBe(0); // Sunday
      expect(features.isUsMarketOpen).toBe(false);
      expect(features.isAsiaMarketOpen).toBe(false);
    });
  });

  describe('Pool Dynamics Features', () => {
    it('should calculate reserve imbalance ratio correctly', () => {
      mockWhaleTracker.getActivitySummary.mockReturnValue(createMockWhaleActivitySummary());

      const input = createDefaultInput({
        poolReserves: {
          reserve0: 2000000n,
          reserve1: 1000000n
        }
      });

      const features = extractor.extractFeatures(input);

      // Imbalance ratio = (reserve0 - reserve1) / (reserve0 + reserve1)
      // = (2000000 - 1000000) / 3000000 = 0.333...
      expect(features.reserveImbalanceRatio).toBeCloseTo(0.333, 2);
    });

    it('should return zero imbalance for balanced reserves', () => {
      mockWhaleTracker.getActivitySummary.mockReturnValue(createMockWhaleActivitySummary());

      const input = createDefaultInput({
        poolReserves: {
          reserve0: 1000000n,
          reserve1: 1000000n
        }
      });

      const features = extractor.extractFeatures(input);

      expect(features.reserveImbalanceRatio).toBe(0);
    });

    it('should calculate recent swap momentum from signed swap amounts', () => {
      mockWhaleTracker.getActivitySummary.mockReturnValue(createMockWhaleActivitySummary());

      const input = createDefaultInput({
        recentSwaps: [
          { direction: 'buy', amountUsd: 50000, timestamp: Date.now() - 1000 },
          { direction: 'sell', amountUsd: 30000, timestamp: Date.now() - 2000 },
          { direction: 'buy', amountUsd: 20000, timestamp: Date.now() - 3000 }
        ]
      });

      const features = extractor.extractFeatures(input);

      // Net momentum = +50000 - 30000 + 20000 = +40000
      expect(features.recentSwapMomentum).toBe(40000);
    });

    it('should return zero momentum when no recent swaps', () => {
      mockWhaleTracker.getActivitySummary.mockReturnValue(createMockWhaleActivitySummary());

      const input = createDefaultInput({ recentSwaps: [] });
      const features = extractor.extractFeatures(input);

      expect(features.recentSwapMomentum).toBe(0);
    });

    it('should handle negative momentum (net selling pressure)', () => {
      mockWhaleTracker.getActivitySummary.mockReturnValue(createMockWhaleActivitySummary());

      const input = createDefaultInput({
        recentSwaps: [
          { direction: 'sell', amountUsd: 100000, timestamp: Date.now() - 1000 },
          { direction: 'buy', amountUsd: 30000, timestamp: Date.now() - 2000 }
        ]
      });

      const features = extractor.extractFeatures(input);

      // Net momentum = -100000 + 30000 = -70000
      expect(features.recentSwapMomentum).toBe(-70000);
    });
  });

  describe('Liquidation Signal Features', () => {
    it('should pass through nearest liquidation level', () => {
      mockWhaleTracker.getActivitySummary.mockReturnValue(createMockWhaleActivitySummary());

      const input = createDefaultInput({
        liquidationData: {
          nearestLiquidationLevel: 0.85, // 85% of current price
          openInterestChange24h: 5.0
        }
      });

      const features = extractor.extractFeatures(input);

      expect(features.nearestLiquidationLevel).toBe(0.85);
    });

    it('should pass through open interest change', () => {
      mockWhaleTracker.getActivitySummary.mockReturnValue(createMockWhaleActivitySummary());

      const input = createDefaultInput({
        liquidationData: {
          nearestLiquidationLevel: 0.90,
          openInterestChange24h: -15.5 // 15.5% decrease
        }
      });

      const features = extractor.extractFeatures(input);

      expect(features.openInterestChange24h).toBe(-15.5);
    });

    it('should default to zero when no liquidation data provided', () => {
      mockWhaleTracker.getActivitySummary.mockReturnValue(createMockWhaleActivitySummary());

      const input = createDefaultInput({
        liquidationData: undefined
      });

      const features = extractor.extractFeatures(input);

      expect(features.nearestLiquidationLevel).toBe(0);
      expect(features.openInterestChange24h).toBe(0);
    });
  });

  describe('Feature Vector Conversion', () => {
    it('should convert features to numeric array for ML input', () => {
      mockWhaleTracker.getActivitySummary.mockReturnValue(createMockWhaleActivitySummary({
        whaleCount: 10,
        dominantDirection: 'bullish'
      }));

      const timestamp = new Date('2026-01-27T15:00:00Z').getTime();
      const input = createDefaultInput({
        currentTimestamp: timestamp,
        poolReserves: { reserve0: 1500000n, reserve1: 1000000n },
        recentSwaps: [
          { direction: 'buy', amountUsd: 10000, timestamp: Date.now() }
        ],
        liquidationData: {
          nearestLiquidationLevel: 0.9,
          openInterestChange24h: 2.5
        }
      });

      const features = extractor.extractFeatures(input);
      const vector = extractor.toFeatureVector(features);

      // toFeatureVector now returns Float64Array for performance
      expect(vector instanceof Float64Array).toBe(true);
      expect(vector.length).toBe(10); // 10 features as defined in interface

      // Verify values are numeric and finite
      for (const value of vector) {
        expect(typeof value).toBe('number');
        expect(Number.isFinite(value)).toBe(true);
      }

      // Also test the compatibility method that returns plain array
      const arrayVector = extractor.toFeatureArray(features);
      expect(Array.isArray(arrayVector)).toBe(true);
      expect(arrayVector.length).toBe(10);
    });

    it('should normalize feature values to expected ranges', () => {
      mockWhaleTracker.getActivitySummary.mockReturnValue(createMockWhaleActivitySummary());

      const input = createDefaultInput();
      const features = extractor.extractFeatures(input);
      const normalized = extractor.normalizeFeatures(features);

      // Hour should be normalized to 0-1 range
      expect(normalized.hourOfDay).toBeGreaterThanOrEqual(0);
      expect(normalized.hourOfDay).toBeLessThanOrEqual(1);

      // Day of week should be normalized to 0-1 range
      expect(normalized.dayOfWeek).toBeGreaterThanOrEqual(0);
      expect(normalized.dayOfWeek).toBeLessThanOrEqual(1);

      // Boolean features should be 0 or 1
      expect([0, 1]).toContain(normalized.isUsMarketOpen);
      expect([0, 1]).toContain(normalized.isAsiaMarketOpen);
    });
  });

  describe('Configuration', () => {
    it('should use custom whale activity window when configured', () => {
      const customConfig: OrderflowExtractorConfig = {
        whaleActivityWindowMs: 7200000 // 2 hours
      };

      const customExtractor = new OrderflowFeatureExtractor(customConfig);
      mockWhaleTracker.getActivitySummary.mockReturnValue(createMockWhaleActivitySummary());

      const input = createDefaultInput();
      customExtractor.extractFeatures(input);

      // Verify whale tracker was called with custom window
      expect(mockWhaleTracker.getActivitySummary).toHaveBeenCalledWith(
        'WETH-USDC',
        'ethereum',
        7200000
      );
    });

    it('should use default 1-hour window when not configured', () => {
      mockWhaleTracker.getActivitySummary.mockReturnValue(createMockWhaleActivitySummary());

      const input = createDefaultInput();
      extractor.extractFeatures(input);

      expect(mockWhaleTracker.getActivitySummary).toHaveBeenCalledWith(
        'WETH-USDC',
        'ethereum',
        3600000 // 1 hour default
      );
    });
  });

  describe('Edge Cases', () => {
    it('should handle zero reserves without division by zero', () => {
      mockWhaleTracker.getActivitySummary.mockReturnValue(createMockWhaleActivitySummary());

      const input = createDefaultInput({
        poolReserves: {
          reserve0: 0n,
          reserve1: 0n
        }
      });

      const features = extractor.extractFeatures(input);

      expect(features.reserveImbalanceRatio).toBe(0);
    });

    it('should handle missing whale activity gracefully', () => {
      mockWhaleTracker.getActivitySummary.mockReturnValue(createMockWhaleActivitySummary({
        whaleCount: 0,
        buyVolumeUsd: 0,
        sellVolumeUsd: 0,
        netFlowUsd: 0,
        dominantDirection: 'neutral'
      }));

      const input = createDefaultInput();
      const features = extractor.extractFeatures(input);

      expect(features.whaleSwapCount1h).toBe(0);
      expect(features.whaleNetDirection).toBe('neutral');
    });

    it('should handle very large swap amounts', () => {
      mockWhaleTracker.getActivitySummary.mockReturnValue(createMockWhaleActivitySummary());

      const input = createDefaultInput({
        recentSwaps: [
          { direction: 'buy', amountUsd: 1e12, timestamp: Date.now() }, // $1 trillion
          { direction: 'sell', amountUsd: 5e11, timestamp: Date.now() }
        ]
      });

      const features = extractor.extractFeatures(input);

      expect(Number.isFinite(features.recentSwapMomentum)).toBe(true);
      expect(features.recentSwapMomentum).toBe(5e11);
    });
  });
});

// =============================================================================
// Singleton Factory Tests
// =============================================================================

describe('Singleton Factory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetOrderflowFeatureExtractor();
  });

  afterEach(() => {
    resetOrderflowFeatureExtractor();
  });

  it('should return the same instance on subsequent calls', () => {
    const instance1 = getOrderflowFeatureExtractor();
    const instance2 = getOrderflowFeatureExtractor();

    expect(instance1).toBe(instance2);
  });

  it('should apply config only on first call', () => {
    const config1: OrderflowExtractorConfig = { whaleActivityWindowMs: 3600000 };
    const config2: OrderflowExtractorConfig = { whaleActivityWindowMs: 7200000 };

    const instance1 = getOrderflowFeatureExtractor(config1);
    const instance2 = getOrderflowFeatureExtractor(config2);

    // Both should be the same instance with first config
    expect(instance1).toBe(instance2);
  });

  it('should create new instance after reset', () => {
    const instance1 = getOrderflowFeatureExtractor();
    resetOrderflowFeatureExtractor();
    const instance2 = getOrderflowFeatureExtractor();

    expect(instance1).not.toBe(instance2);
  });
});

// =============================================================================
// Integration with Existing ML Components
// =============================================================================

describe('Integration with ML Infrastructure', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetOrderflowFeatureExtractor();
    mockWhaleTracker.getActivitySummary.mockReturnValue(createMockWhaleActivitySummary());
  });

  afterEach(() => {
    resetOrderflowFeatureExtractor();
  });

  it('should produce features compatible with LSTMPredictor input format', () => {
    const extractor = new OrderflowFeatureExtractor();
    const input = createDefaultInput();

    const features = extractor.extractFeatures(input);
    const vector = extractor.toFeatureVector(features);

    // LSTM expects numeric arrays
    expect(vector.every(v => typeof v === 'number')).toBe(true);
    expect(vector.every(v => !Number.isNaN(v))).toBe(true);
  });

  it('should provide consistent feature ordering', () => {
    const extractor = new OrderflowFeatureExtractor();

    // Extract features twice with same input
    const input = createDefaultInput({ currentTimestamp: Date.now() });
    const features1 = extractor.extractFeatures(input);
    const features2 = extractor.extractFeatures(input);

    const vector1 = extractor.toFeatureVector(features1);
    const vector2 = extractor.toFeatureVector(features2);

    // Same input should produce same output
    expect(vector1).toEqual(vector2);
  });
});
