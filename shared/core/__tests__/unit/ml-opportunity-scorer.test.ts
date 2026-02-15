/**
 * ML Opportunity Scorer Unit Tests
 *
 * Tests for ML-enhanced opportunity scoring, momentum integration,
 * orderflow integration, batch processing, and weight normalization.
 *
 * @see shared/core/src/analytics/ml-opportunity-scorer.ts
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  MLOpportunityScorer,
  getMLOpportunityScorer,
  resetMLOpportunityScorer,
  stopDeferredLogFlush,
  toOrderflowSignal
} from '../../src/analytics/ml-opportunity-scorer';
import type {
  MLPrediction,
  OrderflowSignal,
  OpportunityScoreInput,
  OpportunityWithMomentum,
  OpportunityWithAllSignals,
  MLScorerConfig
} from '../../src/analytics/ml-opportunity-scorer';
import type { MomentumSignal } from '../../src/analytics/price-momentum';

// =============================================================================
// Test Helpers
// =============================================================================

function createMLPrediction(overrides: Partial<MLPrediction> = {}): MLPrediction {
  return {
    predictedPrice: 2100,
    confidence: 0.8,
    direction: 'up' as const,
    timeHorizon: 60000,
    features: [1, 2, 3],
    ...overrides
  };
}

function createOrderflowSignal(overrides: Partial<OrderflowSignal> = {}): OrderflowSignal {
  return {
    direction: 'bullish' as const,
    confidence: 0.7,
    orderflowPressure: 0.5,
    expectedVolatility: 0.2,
    whaleImpact: 0.3,
    timestamp: Date.now(),
    ...overrides
  };
}

function createMomentumSignal(overrides: Partial<MomentumSignal> = {}): MomentumSignal {
  return {
    pair: 'ETH/USDT',
    currentPrice: 2000,
    velocity: 0.02,
    acceleration: 0.001,
    zScore: 1.5,
    meanReversionSignal: false,
    volumeSpike: false,
    volumeRatio: 1.2,
    trend: 'bullish' as const,
    confidence: 0.7,
    emaShort: 2010,
    emaMedium: 1990,
    emaLong: 1950,
    timestamp: Date.now(),
    ...overrides
  };
}

function createBaseInput(overrides: Partial<OpportunityScoreInput> = {}): OpportunityScoreInput {
  return {
    baseConfidence: 0.6,
    mlPrediction: createMLPrediction(),
    opportunityDirection: 'buy' as const,
    currentPrice: 2000,
    id: 'test-opp-1',
    ...overrides
  };
}

describe('MLOpportunityScorer', () => {
  let scorer: MLOpportunityScorer;

  beforeEach(() => {
    resetMLOpportunityScorer();
    scorer = new MLOpportunityScorer();
  });

  afterEach(() => {
    scorer.resetStats();
    stopDeferredLogFlush();
  });

  // ===========================================================================
  // enhanceOpportunityScore — basic ML enhancement
  // ===========================================================================

  describe('enhanceOpportunityScore', () => {
    it('should return base confidence when no ML prediction', async () => {
      const result = await scorer.enhanceOpportunityScore(
        createBaseInput({ mlPrediction: null })
      );

      expect(result.enhancedConfidence).toBe(0.6);
      expect(result.mlApplied).toBe(false);
      expect(result.mlContribution).toBe(0);
    });

    it('should enhance confidence with valid ML prediction', async () => {
      const result = await scorer.enhanceOpportunityScore(createBaseInput());

      expect(result.mlApplied).toBe(true);
      expect(result.mlContribution).toBeGreaterThan(0);
      expect(result.enhancedConfidence).toBeGreaterThan(0);
    });

    it('should skip ML when confidence below threshold', async () => {
      const result = await scorer.enhanceOpportunityScore(
        createBaseInput({
          mlPrediction: createMLPrediction({ confidence: 0.3 }) // Below 0.5 default
        })
      );

      expect(result.mlApplied).toBe(false);
    });

    it('should apply direction bonus when ML direction aligns with opportunity', async () => {
      // ML predicts "up", opportunity is "buy" — aligned
      const aligned = await scorer.enhanceOpportunityScore(
        createBaseInput({
          mlPrediction: createMLPrediction({ direction: 'up' }),
          opportunityDirection: 'buy'
        })
      );

      // ML predicts "down", opportunity is "buy" — misaligned
      const misaligned = await scorer.enhanceOpportunityScore(
        createBaseInput({
          mlPrediction: createMLPrediction({ direction: 'down' }),
          opportunityDirection: 'buy'
        })
      );

      expect(aligned.enhancedConfidence).toBeGreaterThan(misaligned.enhancedConfidence);
      expect(aligned.directionAligned).toBe(true);
      expect(misaligned.directionAligned).toBe(false);
    });

    it('should treat sideways ML direction as neutral alignment', async () => {
      const result = await scorer.enhanceOpportunityScore(
        createBaseInput({
          mlPrediction: createMLPrediction({ direction: 'sideways' })
        })
      );

      expect(result.directionAligned).toBe(true);
      // No bonus/penalty for sideways
    });

    it('should calculate price impact score based on predicted move', async () => {
      // 10% predicted move should give high impact score
      const result = await scorer.enhanceOpportunityScore(
        createBaseInput({
          currentPrice: 2000,
          mlPrediction: createMLPrediction({ predictedPrice: 2200 }) // 10% up
        })
      );

      expect(result.priceImpactScore).toBeGreaterThan(0);
    });

    it('should clamp enhanced confidence to [0, 1]', async () => {
      // Very high base + high ML should not exceed 1
      const result = await scorer.enhanceOpportunityScore(
        createBaseInput({
          baseConfidence: 0.95,
          mlPrediction: createMLPrediction({ confidence: 0.99, predictedPrice: 3000 })
        })
      );

      expect(result.enhancedConfidence).toBeLessThanOrEqual(1);
      expect(result.enhancedConfidence).toBeGreaterThanOrEqual(0);
    });

    it('should handle zero current price gracefully', async () => {
      const result = await scorer.enhanceOpportunityScore(
        createBaseInput({ currentPrice: 0 })
      );

      expect(result.priceImpactScore).toBe(0);
    });

    it('should reject invalid ML prediction (NaN predicted price)', async () => {
      const result = await scorer.enhanceOpportunityScore(
        createBaseInput({
          mlPrediction: createMLPrediction({ predictedPrice: NaN })
        })
      );

      expect(result.mlApplied).toBe(false);
    });

    it('should reject negative ML confidence', async () => {
      const result = await scorer.enhanceOpportunityScore(
        createBaseInput({
          mlPrediction: createMLPrediction({ confidence: -0.5 })
        })
      );

      expect(result.mlApplied).toBe(false);
    });

    it('should reject invalid ML direction', async () => {
      const result = await scorer.enhanceOpportunityScore(
        createBaseInput({
          mlPrediction: {
            ...createMLPrediction(),
            direction: 'invalid' as any
          }
        })
      );

      expect(result.mlApplied).toBe(false);
    });

    it('should preserve opportunity ID in result', async () => {
      const result = await scorer.enhanceOpportunityScore(
        createBaseInput({ id: 'my-opp-42' })
      );

      expect(result.id).toBe('my-opp-42');
    });
  });

  // ===========================================================================
  // Weight normalization
  // ===========================================================================

  describe('weight normalization', () => {
    it('should auto-normalize weights that do not sum to 1', async () => {
      const customScorer = new MLOpportunityScorer({
        mlWeight: 0.5,
        baseWeight: 0.8 // Sum = 1.3
      });

      const result = await customScorer.enhanceOpportunityScore(createBaseInput());
      // Should still produce valid results
      expect(result.enhancedConfidence).toBeGreaterThanOrEqual(0);
      expect(result.enhancedConfidence).toBeLessThanOrEqual(1);

      customScorer.resetStats();
      stopDeferredLogFlush();
    });
  });

  // ===========================================================================
  // enhanceWithMomentum
  // ===========================================================================

  describe('enhanceWithMomentum', () => {
    it('should return ML result when no momentum signal', async () => {
      const input: OpportunityWithMomentum = {
        ...createBaseInput(),
        momentumSignal: null
      };

      const result = await scorer.enhanceWithMomentum(input);
      expect(result.momentumContribution).toBeUndefined();
    });

    it('should incorporate momentum signal into score', async () => {
      const input: OpportunityWithMomentum = {
        ...createBaseInput(),
        momentumSignal: createMomentumSignal({ trend: 'bullish', confidence: 0.8 })
      };

      const result = await scorer.enhanceWithMomentum(input);
      expect(result.momentumContribution).toBeGreaterThan(0);
    });

    it('should boost score when momentum aligns with direction', async () => {
      const aligned: OpportunityWithMomentum = {
        ...createBaseInput({ opportunityDirection: 'buy' }),
        momentumSignal: createMomentumSignal({ trend: 'bullish' })
      };
      const misaligned: OpportunityWithMomentum = {
        ...createBaseInput({ opportunityDirection: 'buy' }),
        momentumSignal: createMomentumSignal({ trend: 'bearish' })
      };

      const resultAligned = await scorer.enhanceWithMomentum(aligned);
      const resultMisaligned = await scorer.enhanceWithMomentum(misaligned);

      expect(resultAligned.enhancedConfidence).toBeGreaterThan(resultMisaligned.enhancedConfidence);
    });

    it('should add volume spike bonus when aligned', async () => {
      const withSpike: OpportunityWithMomentum = {
        ...createBaseInput({ opportunityDirection: 'buy' }),
        momentumSignal: createMomentumSignal({ trend: 'bullish', volumeSpike: true })
      };
      const withoutSpike: OpportunityWithMomentum = {
        ...createBaseInput({ opportunityDirection: 'buy' }),
        momentumSignal: createMomentumSignal({ trend: 'bullish', volumeSpike: false })
      };

      const resultSpike = await scorer.enhanceWithMomentum(withSpike);
      const resultNoSpike = await scorer.enhanceWithMomentum(withoutSpike);

      expect(resultSpike.momentumContribution!).toBeGreaterThan(resultNoSpike.momentumContribution!);
    });
  });

  // ===========================================================================
  // enhanceWithOrderflow
  // ===========================================================================

  describe('enhanceWithOrderflow', () => {
    it('should return ML result when no orderflow signal', async () => {
      const result = await scorer.enhanceWithOrderflow({
        ...createBaseInput(),
        orderflowSignal: null
      });

      expect(result.orderflowApplied).toBe(false);
      expect(result.orderflowContribution).toBe(0);
    });

    it('should apply orderflow signal when valid and above threshold', async () => {
      const result = await scorer.enhanceWithOrderflow({
        ...createBaseInput(),
        orderflowSignal: createOrderflowSignal({ confidence: 0.7 })
      });

      expect(result.orderflowApplied).toBe(true);
      expect(result.orderflowContribution).not.toBe(0);
    });

    it('should skip orderflow below minimum confidence', async () => {
      const result = await scorer.enhanceWithOrderflow({
        ...createBaseInput(),
        orderflowSignal: createOrderflowSignal({ confidence: 0.1 }) // Below 0.4 default
      });

      expect(result.orderflowApplied).toBe(false);
    });

    it('should boost for aligned orderflow direction', async () => {
      const aligned = await scorer.enhanceWithOrderflow({
        ...createBaseInput({ opportunityDirection: 'buy' }),
        orderflowSignal: createOrderflowSignal({ direction: 'bullish' })
      });
      const misaligned = await scorer.enhanceWithOrderflow({
        ...createBaseInput({ opportunityDirection: 'buy' }),
        orderflowSignal: createOrderflowSignal({ direction: 'bearish' })
      });

      expect(aligned.orderflowDirectionAligned).toBe(true);
      expect(misaligned.orderflowDirectionAligned).toBe(false);
      expect(aligned.enhancedConfidence).toBeGreaterThan(misaligned.enhancedConfidence);
    });

    it('should apply volatility penalty', async () => {
      const lowVol = await scorer.enhanceWithOrderflow({
        ...createBaseInput(),
        orderflowSignal: createOrderflowSignal({ expectedVolatility: 0.1 })
      });
      const highVol = await scorer.enhanceWithOrderflow({
        ...createBaseInput(),
        orderflowSignal: createOrderflowSignal({ expectedVolatility: 0.9 })
      });

      expect(lowVol.enhancedConfidence).toBeGreaterThan(highVol.enhancedConfidence);
    });

    it('should handle NaN values in orderflow signal gracefully', async () => {
      const result = await scorer.enhanceWithOrderflow({
        ...createBaseInput(),
        orderflowSignal: createOrderflowSignal({
          confidence: NaN
        })
      });

      // Invalid signal should be rejected
      expect(result.orderflowApplied).toBe(false);
    });

    it('should reject orderflow with invalid direction', async () => {
      const result = await scorer.enhanceWithOrderflow({
        ...createBaseInput(),
        orderflowSignal: {
          direction: 'invalid' as any,
          confidence: 0.7,
          orderflowPressure: 0.5,
          expectedVolatility: 0.2,
          whaleImpact: 0.3,
          timestamp: Date.now()
        }
      });

      expect(result.orderflowApplied).toBe(false);
    });
  });

  // ===========================================================================
  // enhanceWithAllSignals
  // ===========================================================================

  describe('enhanceWithAllSignals', () => {
    it('should return ML result when no signals provided', async () => {
      const input: OpportunityWithAllSignals = {
        ...createBaseInput(),
        momentumSignal: null,
        orderflowSignal: null
      };

      const result = await scorer.enhanceWithAllSignals(input);
      expect(result.orderflowApplied).toBe(false);
    });

    it('should combine momentum and orderflow signals', async () => {
      const input: OpportunityWithAllSignals = {
        ...createBaseInput({ opportunityDirection: 'buy' }),
        momentumSignal: createMomentumSignal({ trend: 'bullish', confidence: 0.8 }),
        orderflowSignal: createOrderflowSignal({ direction: 'bullish', confidence: 0.7 })
      };

      const result = await scorer.enhanceWithAllSignals(input);
      expect(result.orderflowApplied).toBe(true);
      expect(result.momentumContribution).toBeGreaterThan(0);
      expect(result.orderflowContribution).toBeGreaterThan(0);
    });

    it('should handle momentum-only (no orderflow)', async () => {
      const input: OpportunityWithAllSignals = {
        ...createBaseInput(),
        momentumSignal: createMomentumSignal(),
        orderflowSignal: null
      };

      const result = await scorer.enhanceWithAllSignals(input);
      expect(result.momentumContribution).toBeGreaterThan(0);
      expect(result.orderflowApplied).toBe(false);
    });

    it('should handle orderflow-only (no momentum)', async () => {
      const input: OpportunityWithAllSignals = {
        ...createBaseInput(),
        momentumSignal: null,
        orderflowSignal: createOrderflowSignal({ confidence: 0.7 })
      };

      const result = await scorer.enhanceWithAllSignals(input);
      expect(result.orderflowApplied).toBe(true);
    });

    it('should clamp final confidence to [0, 1]', async () => {
      const input: OpportunityWithAllSignals = {
        ...createBaseInput({ baseConfidence: 0.99 }),
        momentumSignal: createMomentumSignal({ confidence: 0.99, trend: 'bullish', volumeSpike: true }),
        orderflowSignal: createOrderflowSignal({ confidence: 0.99, direction: 'bullish', orderflowPressure: 0.99 })
      };

      const result = await scorer.enhanceWithAllSignals(input);
      expect(result.enhancedConfidence).toBeLessThanOrEqual(1);
      expect(result.enhancedConfidence).toBeGreaterThanOrEqual(0);
    });
  });

  // ===========================================================================
  // Batch processing
  // ===========================================================================

  describe('enhanceBatch', () => {
    it('should return empty array for empty input', async () => {
      const results = await scorer.enhanceBatch([]);
      expect(results).toEqual([]);
    });

    it('should process multiple opportunities', async () => {
      const inputs = [
        createBaseInput({ id: 'a' }),
        createBaseInput({ id: 'b', baseConfidence: 0.8 }),
        createBaseInput({ id: 'c', mlPrediction: null })
      ];

      const results = await scorer.enhanceBatch(inputs);
      expect(results.length).toBe(3);
      expect(results[0].id).toBe('a');
      expect(results[2].mlApplied).toBe(false); // No ML for input c
    });
  });

  describe('enhanceBatchWithAllSignals', () => {
    it('should return empty array for empty input', async () => {
      const results = await scorer.enhanceBatchWithAllSignals([]);
      expect(results).toEqual([]);
    });

    it('should process multiple inputs with all signals', async () => {
      const inputs: OpportunityWithAllSignals[] = [
        {
          ...createBaseInput({ id: 'x' }),
          momentumSignal: createMomentumSignal(),
          orderflowSignal: createOrderflowSignal()
        },
        {
          ...createBaseInput({ id: 'y' }),
          momentumSignal: null,
          orderflowSignal: null
        }
      ];

      const results = await scorer.enhanceBatchWithAllSignals(inputs);
      expect(results.length).toBe(2);
    });
  });

  // ===========================================================================
  // rankOpportunities
  // ===========================================================================

  describe('rankOpportunities', () => {
    it('should rank opportunities by enhanced confidence descending', async () => {
      const inputs = [
        { ...createBaseInput({ id: 'low', baseConfidence: 0.3, mlPrediction: null }), id: 'low' },
        { ...createBaseInput({ id: 'high', baseConfidence: 0.9, mlPrediction: null }), id: 'high' },
        { ...createBaseInput({ id: 'mid', baseConfidence: 0.6, mlPrediction: null }), id: 'mid' }
      ];

      const ranked = await scorer.rankOpportunities(inputs);
      expect(ranked[0].id).toBe('high');
      expect(ranked[1].id).toBe('mid');
      expect(ranked[2].id).toBe('low');
    });
  });

  // ===========================================================================
  // Stats
  // ===========================================================================

  describe('stats', () => {
    it('should track scored opportunities count', async () => {
      await scorer.enhanceOpportunityScore(createBaseInput());
      await scorer.enhanceOpportunityScore(createBaseInput({ mlPrediction: null }));

      const stats = scorer.getStats();
      expect(stats.scoredOpportunities).toBe(2);
      expect(stats.mlEnhancedCount).toBe(1);
    });

    it('should track orderflow enhanced count', async () => {
      await scorer.enhanceWithOrderflow({
        ...createBaseInput(),
        orderflowSignal: createOrderflowSignal({ confidence: 0.7 })
      });

      const stats = scorer.getStats();
      expect(stats.orderflowEnhancedCount).toBe(1);
    });

    it('should reset stats', () => {
      scorer.resetStats();
      const stats = scorer.getStats();
      expect(stats.scoredOpportunities).toBe(0);
    });
  });

  // ===========================================================================
  // toOrderflowSignal helper
  // ===========================================================================

  describe('toOrderflowSignal', () => {
    it('should convert OrderflowPredictionInput to OrderflowSignal', () => {
      const prediction = {
        direction: 'bullish' as const,
        confidence: 0.8,
        orderflowPressure: 0.6,
        expectedVolatility: 0.3,
        whaleImpact: 0.4,
        timestamp: 123456789
      };

      const signal = toOrderflowSignal(prediction);

      expect(signal.direction).toBe('bullish');
      expect(signal.confidence).toBe(0.8);
      expect(signal.orderflowPressure).toBe(0.6);
      expect(signal.expectedVolatility).toBe(0.3);
      expect(signal.whaleImpact).toBe(0.4);
      expect(signal.timestamp).toBe(123456789);
    });

    it('should ignore optional fields from prediction input', () => {
      const prediction = {
        direction: 'neutral' as const,
        confidence: 0.5,
        orderflowPressure: 0.0,
        expectedVolatility: 0.1,
        whaleImpact: 0.0,
        timestamp: 100,
        timeHorizonMs: 60000, // Optional — should not appear in signal
        features: [1, 2, 3]  // Optional — should not appear in signal
      };

      const signal = toOrderflowSignal(prediction);
      expect((signal as any).timeHorizonMs).toBeUndefined();
      expect((signal as any).features).toBeUndefined();
    });
  });

  // ===========================================================================
  // Singleton factory
  // ===========================================================================

  describe('singleton', () => {
    it('should return the same instance on multiple calls', () => {
      const a = getMLOpportunityScorer();
      const b = getMLOpportunityScorer();
      expect(a).toBe(b);
      resetMLOpportunityScorer();
    });

    it('should return a new instance after reset', () => {
      const a = getMLOpportunityScorer();
      resetMLOpportunityScorer();
      const b = getMLOpportunityScorer();
      expect(a).not.toBe(b);
      resetMLOpportunityScorer();
    });
  });

  // ===========================================================================
  // Deferred logging cleanup
  // ===========================================================================

  describe('stopDeferredLogFlush', () => {
    it('should not throw when called multiple times', () => {
      expect(() => {
        stopDeferredLogFlush();
        stopDeferredLogFlush();
      }).not.toThrow();
    });
  });
});
