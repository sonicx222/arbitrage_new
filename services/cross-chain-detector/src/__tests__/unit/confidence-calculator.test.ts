/**
 * Unit Tests for ConfidenceCalculator
 *
 * Tests the confidence calculation module extracted from detector.ts (P2-2).
 * Covers: base confidence, age penalty, ML adjustments, whale adjustments,
 * price validation, max confidence cap, config defaults/overrides, and factory.
 *
 * FIX #5: Zero dedicated test coverage addressed.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import {
  ConfidenceCalculator,
  createConfidenceCalculator,
  DEFAULT_CONFIDENCE_CONFIG,
  type ConfidenceCalculatorConfig,
  type ConfidenceCalculatorLogger,
  type WhaleActivitySummary,
  type MLPredictionPair,
  type PriceData,
} from '../../confidence-calculator';
import type { PriceUpdate } from '@arbitrage/types';

// =============================================================================
// Helpers
// =============================================================================

/** Create a minimal valid PriceUpdate for testing */
function makePriceUpdate(overrides: Partial<PriceUpdate> = {}): PriceUpdate {
  return {
    chain: 'ethereum',
    dex: 'uniswap',
    pairKey: 'WETH_USDC',
    price: 2500,
    timestamp: Date.now(),
    token0: 'WETH',
    token1: 'USDC',
    reserve0: '1000000000000000000000',
    reserve1: '2500000000000',
    blockNumber: 12345,
    latency: 50,
    ...overrides,
  };
}

/** Create a minimal PriceData for testing */
function makeLowPrice(price: number, timestampOverride?: number): PriceData {
  return {
    update: makePriceUpdate({
      price,
      timestamp: timestampOverride ?? Date.now(),
    }),
    price,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('ConfidenceCalculator', () => {
  let logger: ConfidenceCalculatorLogger;
  let calculator: ConfidenceCalculator;

  beforeEach(() => {
    logger = {
      warn: jest.fn(),
      debug: jest.fn(),
    };

    calculator = new ConfidenceCalculator({}, logger);
  });

  // ===========================================================================
  // calculate() — basic confidence from price differential
  // ===========================================================================

  describe('calculate() — base confidence from price differential', () => {
    it('should return confidence proportional to price difference', () => {
      // 10% price difference: (highPrice/lowPrice - 1) = 0.1
      // rawConfidence = min(0.1, 0.5) * 2 = 0.2
      const confidence = calculator.calculate(
        makeLowPrice(2500),
        { price: 2750 },
      );

      expect(confidence).toBeCloseTo(0.2, 1);
      expect(confidence).toBeGreaterThan(0);
    });

    it('should return higher confidence for larger price differential', () => {
      const smallDiff = calculator.calculate(
        makeLowPrice(2500),
        { price: 2550 }, // 2% difference
      );

      const largeDiff = calculator.calculate(
        makeLowPrice(2500),
        { price: 3000 }, // 20% difference
      );

      expect(largeDiff).toBeGreaterThan(smallDiff);
    });

    it('should cap base confidence at 1.0 for 50%+ difference', () => {
      // 50% price difference: rawConfidence = min(0.5, 0.5) * 2 = 1.0
      // But max confidence cap (0.95 default) limits it
      const confidence = calculator.calculate(
        makeLowPrice(2000),
        { price: 3000 }, // 50% higher
      );

      expect(confidence).toBeLessThanOrEqual(0.95);
    });

    it('should return near-zero for tiny price differential', () => {
      // 0.01% difference
      const confidence = calculator.calculate(
        makeLowPrice(2500),
        { price: 2500.25 },
      );

      expect(confidence).toBeCloseTo(0.0002, 3);
    });

    it('should return 0 when prices are equal', () => {
      const confidence = calculator.calculate(
        makeLowPrice(2500),
        { price: 2500 },
      );

      expect(confidence).toBe(0);
    });
  });

  // ===========================================================================
  // calculate() — age penalty for stale data
  // ===========================================================================

  describe('calculate() — age penalty for stale data', () => {
    it('should not penalize fresh data', () => {
      // Timestamp = now, no age penalty
      const freshConfidence = calculator.calculate(
        makeLowPrice(2500, Date.now()),
        { price: 2750 },
      );

      expect(freshConfidence).toBeGreaterThan(0);
    });

    it('should reduce confidence for stale data', () => {
      const freshConfidence = calculator.calculate(
        makeLowPrice(2500, Date.now()),
        { price: 2750 },
      );

      // Data that is 3 minutes old: ageFactor = max(0.1, 1 - 3 * 0.1) = 0.7
      const staleConfidence = calculator.calculate(
        makeLowPrice(2500, Date.now() - 3 * 60 * 1000),
        { price: 2750 },
      );

      expect(staleConfidence).toBeLessThan(freshConfidence);
    });

    it('should apply minimum age factor floor of 0.1', () => {
      // Data that is 30 minutes old: ageFactor = max(0.1, 1 - 30 * 0.1) = max(0.1, -2) = 0.1
      const veryStaleConfidence = calculator.calculate(
        makeLowPrice(2500, Date.now() - 30 * 60 * 1000),
        { price: 2750 },
      );

      // Should still be > 0 (due to 0.1 floor on age factor)
      expect(veryStaleConfidence).toBeGreaterThan(0);

      // But very small
      const freshConfidence = calculator.calculate(
        makeLowPrice(2500, Date.now()),
        { price: 2750 },
      );
      expect(veryStaleConfidence).toBeLessThan(freshConfidence * 0.15);
    });
  });

  // ===========================================================================
  // calculate() — ML prediction adjustments
  // ===========================================================================

  describe('calculate() — ML prediction adjustments', () => {
    let mlCalculator: ConfidenceCalculator;

    beforeEach(() => {
      // Enable ML predictions for these tests
      mlCalculator = new ConfidenceCalculator(
        {
          ml: {
            enabled: true,
            minConfidence: 0.6,
            alignedBoost: 1.15,
            opposedPenalty: 0.85,
          },
        },
        logger,
      );
    });

    it('should boost confidence when source prediction is aligned (up)', () => {
      const withoutML = mlCalculator.calculate(
        makeLowPrice(2500),
        { price: 2750 },
      );

      const withAlignedML = mlCalculator.calculate(
        makeLowPrice(2500),
        { price: 2750 },
        undefined, // no whale data
        {
          source: { direction: 'up', confidence: 0.8, predictedPrice: 2600, timeHorizon: 3600, features: [] },
        },
      );

      expect(withAlignedML).toBeGreaterThan(withoutML);
    });

    it('should penalize confidence when source prediction opposes (down)', () => {
      const withoutML = mlCalculator.calculate(
        makeLowPrice(2500),
        { price: 2750 },
      );

      const withOpposedML = mlCalculator.calculate(
        makeLowPrice(2500),
        { price: 2750 },
        undefined,
        {
          source: { direction: 'down', confidence: 0.8, predictedPrice: 2400, timeHorizon: 3600, features: [] },
        },
      );

      expect(withOpposedML).toBeLessThan(withoutML);
    });

    it('should ignore ML predictions below minConfidence threshold', () => {
      const withoutML = mlCalculator.calculate(
        makeLowPrice(2500),
        { price: 2750 },
      );

      // Prediction confidence 0.3 < minConfidence 0.6, should be ignored
      const withLowConfML = mlCalculator.calculate(
        makeLowPrice(2500),
        { price: 2750 },
        undefined,
        {
          source: { direction: 'up', confidence: 0.3, predictedPrice: 2600, timeHorizon: 3600, features: [] },
        },
      );

      expect(withLowConfML).toBeCloseTo(withoutML, 10);
    });

    it('should not apply ML adjustments when ML is disabled', () => {
      const disabledCalculator = new ConfidenceCalculator(
        { ml: { enabled: false, minConfidence: 0.6, alignedBoost: 1.15, opposedPenalty: 0.85 } },
        logger,
      );

      const withoutML = disabledCalculator.calculate(
        makeLowPrice(2500),
        { price: 2750 },
      );

      const withML = disabledCalculator.calculate(
        makeLowPrice(2500),
        { price: 2750 },
        undefined,
        {
          source: { direction: 'up', confidence: 0.9, predictedPrice: 2600, timeHorizon: 3600, features: [] },
        },
      );

      expect(withML).toBeCloseTo(withoutML, 10);
    });

    it('should boost for target sideways/up prediction', () => {
      const withoutML = mlCalculator.calculate(
        makeLowPrice(2500),
        { price: 2750 },
      );

      const withTargetSideways = mlCalculator.calculate(
        makeLowPrice(2500),
        { price: 2750 },
        undefined,
        {
          target: { direction: 'sideways', confidence: 0.8, predictedPrice: 2750, timeHorizon: 3600, features: [] },
        },
      );

      expect(withTargetSideways).toBeGreaterThan(withoutML);
    });

    it('should penalize for target down prediction', () => {
      const withoutML = mlCalculator.calculate(
        makeLowPrice(2500),
        { price: 2750 },
      );

      const withTargetDown = mlCalculator.calculate(
        makeLowPrice(2500),
        { price: 2750 },
        undefined,
        {
          target: { direction: 'down', confidence: 0.8, predictedPrice: 2600, timeHorizon: 3600, features: [] },
        },
      );

      expect(withTargetDown).toBeLessThan(withoutML);
    });
  });

  // ===========================================================================
  // calculate() — whale activity adjustments
  // ===========================================================================

  describe('calculate() — whale activity adjustments', () => {
    it('should boost confidence for bullish whale activity', () => {
      const withoutWhale = calculator.calculate(
        makeLowPrice(2500),
        { price: 2750 },
      );

      const whaleData: WhaleActivitySummary = {
        dominantDirection: 'bullish',
        netFlowUsd: 50000,
        superWhaleCount: 0,
      };

      const withWhale = calculator.calculate(
        makeLowPrice(2500),
        { price: 2750 },
        whaleData,
      );

      expect(withWhale).toBeGreaterThan(withoutWhale);
    });

    it('should penalize confidence for bearish whale activity', () => {
      const withoutWhale = calculator.calculate(
        makeLowPrice(2500),
        { price: 2750 },
      );

      const whaleData: WhaleActivitySummary = {
        dominantDirection: 'bearish',
        netFlowUsd: -50000,
        superWhaleCount: 0,
      };

      const withWhale = calculator.calculate(
        makeLowPrice(2500),
        { price: 2750 },
        whaleData,
      );

      expect(withWhale).toBeLessThan(withoutWhale);
    });

    it('should boost for super whale presence', () => {
      const noSuperWhale = calculator.calculate(
        makeLowPrice(2500),
        { price: 2750 },
        { dominantDirection: 'neutral', netFlowUsd: 0, superWhaleCount: 0 },
      );

      const withSuperWhale = calculator.calculate(
        makeLowPrice(2500),
        { price: 2750 },
        { dominantDirection: 'neutral', netFlowUsd: 0, superWhaleCount: 2 },
      );

      expect(withSuperWhale).toBeGreaterThan(noSuperWhale);
    });

    it('should not modify confidence for neutral whale activity without super whales', () => {
      const withoutWhale = calculator.calculate(
        makeLowPrice(2500),
        { price: 2750 },
      );

      const neutralWhale = calculator.calculate(
        makeLowPrice(2500),
        { price: 2750 },
        { dominantDirection: 'neutral', netFlowUsd: 10000, superWhaleCount: 0 },
      );

      // Neutral direction with no super whales and below significant flow threshold
      expect(neutralWhale).toBeCloseTo(withoutWhale, 10);
    });

    it('should apply significant flow boost for large net flow', () => {
      const smallFlow = calculator.calculate(
        makeLowPrice(2500),
        { price: 2750 },
        { dominantDirection: 'neutral', netFlowUsd: 1000, superWhaleCount: 0 },
      );

      // significantFlowThresholdUsd default = 500000
      const largeFlow = calculator.calculate(
        makeLowPrice(2500),
        { price: 2750 },
        { dominantDirection: 'neutral', netFlowUsd: 600000, superWhaleCount: 0 },
      );

      expect(largeFlow).toBeGreaterThan(smallFlow);
    });
  });

  // ===========================================================================
  // calculate() — max confidence cap
  // ===========================================================================

  describe('calculate() — max confidence cap', () => {
    it('should cap confidence at default maxConfidence (0.95)', () => {
      // Very large price diff + bullish whale + super whale = high raw confidence
      const confidence = calculator.calculate(
        makeLowPrice(1000),
        { price: 2000 }, // 100% difference
        { dominantDirection: 'bullish', netFlowUsd: 1000000, superWhaleCount: 5 },
      );

      expect(confidence).toBeLessThanOrEqual(0.95);
    });

    it('should respect custom maxConfidence', () => {
      const customCalc = new ConfidenceCalculator(
        { maxConfidence: 0.8 },
        logger,
      );

      const confidence = customCalc.calculate(
        makeLowPrice(1000),
        { price: 2000 },
        { dominantDirection: 'bullish', netFlowUsd: 1000000, superWhaleCount: 5 },
      );

      expect(confidence).toBeLessThanOrEqual(0.8);
    });
  });

  // ===========================================================================
  // validatePrices() — invalid/zero/negative/Infinity prices
  // ===========================================================================

  describe('validatePrices — edge cases', () => {
    it('should return 0 for zero low price', () => {
      const confidence = calculator.calculate(
        makeLowPrice(0),
        { price: 2500 },
      );

      expect(confidence).toBe(0);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('should return 0 for zero high price', () => {
      const confidence = calculator.calculate(
        makeLowPrice(2500),
        { price: 0 },
      );

      expect(confidence).toBe(0);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('should return 0 for negative low price', () => {
      const confidence = calculator.calculate(
        makeLowPrice(-100),
        { price: 2500 },
      );

      expect(confidence).toBe(0);
    });

    it('should return 0 for negative high price', () => {
      const confidence = calculator.calculate(
        makeLowPrice(2500),
        { price: -100 },
      );

      expect(confidence).toBe(0);
    });

    it('should return 0 for Infinity low price', () => {
      const confidence = calculator.calculate(
        makeLowPrice(Infinity),
        { price: 2500 },
      );

      expect(confidence).toBe(0);
    });

    it('should return 0 for Infinity high price', () => {
      const confidence = calculator.calculate(
        makeLowPrice(2500),
        { price: Infinity },
      );

      expect(confidence).toBe(0);
    });

    it('should return 0 for NaN low price', () => {
      const confidence = calculator.calculate(
        makeLowPrice(NaN),
        { price: 2500 },
      );

      expect(confidence).toBe(0);
    });

    it('should return 0 for NaN high price', () => {
      const confidence = calculator.calculate(
        makeLowPrice(2500),
        { price: NaN },
      );

      expect(confidence).toBe(0);
    });
  });

  // ===========================================================================
  // createConfidenceCalculator() factory function
  // ===========================================================================

  describe('createConfidenceCalculator factory', () => {
    it('should create a ConfidenceCalculator instance', () => {
      const calc = createConfidenceCalculator({}, logger);

      expect(calc).toBeInstanceOf(ConfidenceCalculator);
    });

    it('should pass config through to the instance', () => {
      const customConfig: Partial<ConfidenceCalculatorConfig> = {
        maxConfidence: 0.8,
        ml: {
          enabled: true,
          minConfidence: 0.5,
          alignedBoost: 1.2,
          opposedPenalty: 0.8,
        },
      };

      const calc = createConfidenceCalculator(customConfig, logger);
      const resolvedConfig = calc.getConfig();

      expect(resolvedConfig.maxConfidence).toBe(0.8);
      expect(resolvedConfig.ml.enabled).toBe(true);
      expect(resolvedConfig.ml.minConfidence).toBe(0.5);
      expect(resolvedConfig.ml.alignedBoost).toBe(1.2);
      expect(resolvedConfig.ml.opposedPenalty).toBe(0.8);
    });

    it('should produce identical results to direct construction', () => {
      const direct = new ConfidenceCalculator({}, logger);
      const factory = createConfidenceCalculator({}, logger);

      const directResult = direct.calculate(makeLowPrice(2500), { price: 2750 });
      const factoryResult = factory.calculate(makeLowPrice(2500), { price: 2750 });

      expect(factoryResult).toBeCloseTo(directResult, 10);
    });
  });

  // ===========================================================================
  // Config defaults and overrides
  // ===========================================================================

  describe('config defaults and overrides', () => {
    it('should use default config when no overrides provided', () => {
      const calc = new ConfidenceCalculator({}, logger);
      const config = calc.getConfig();

      expect(config.maxConfidence).toBe(DEFAULT_CONFIDENCE_CONFIG.maxConfidence);
      expect(config.ml.enabled).toBe(DEFAULT_CONFIDENCE_CONFIG.ml.enabled);
      expect(config.ml.minConfidence).toBe(DEFAULT_CONFIDENCE_CONFIG.ml.minConfidence);
      expect(config.whale.whaleBullishBoost).toBe(DEFAULT_CONFIDENCE_CONFIG.whale.whaleBullishBoost);
      expect(config.whale.whaleBearishPenalty).toBe(DEFAULT_CONFIDENCE_CONFIG.whale.whaleBearishPenalty);
    });

    it('should merge partial ML config with defaults', () => {
      const calc = new ConfidenceCalculator(
        { ml: { enabled: true, minConfidence: 0.5, alignedBoost: 1.3, opposedPenalty: 0.7 } },
        logger,
      );
      const config = calc.getConfig();

      // Overridden
      expect(config.ml.enabled).toBe(true);
      expect(config.ml.minConfidence).toBe(0.5);
      expect(config.ml.alignedBoost).toBe(1.3);
      expect(config.ml.opposedPenalty).toBe(0.7);

      // Whale config should still be defaults
      expect(config.whale.whaleBullishBoost).toBe(DEFAULT_CONFIDENCE_CONFIG.whale.whaleBullishBoost);
    });

    it('should merge partial whale config with defaults', () => {
      const calc = new ConfidenceCalculator(
        { whale: { whaleBullishBoost: 1.3, whaleBearishPenalty: 0.7, superWhaleBoost: 1.5, significantFlowThresholdUsd: 1000000 } },
        logger,
      );
      const config = calc.getConfig();

      // Overridden
      expect(config.whale.whaleBullishBoost).toBe(1.3);
      expect(config.whale.whaleBearishPenalty).toBe(0.7);
      expect(config.whale.superWhaleBoost).toBe(1.5);

      // ML config should still be defaults
      expect(config.ml.enabled).toBe(DEFAULT_CONFIDENCE_CONFIG.ml.enabled);
    });

    it('should override maxConfidence independently', () => {
      const calc = new ConfidenceCalculator({ maxConfidence: 0.99 }, logger);
      const config = calc.getConfig();

      expect(config.maxConfidence).toBe(0.99);
      // Other configs should be defaults
      expect(config.ml.enabled).toBe(DEFAULT_CONFIDENCE_CONFIG.ml.enabled);
      expect(config.whale.whaleBullishBoost).toBe(DEFAULT_CONFIDENCE_CONFIG.whale.whaleBullishBoost);
    });
  });
});
