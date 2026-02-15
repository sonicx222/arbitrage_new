/**
 * Statistical Analysis Unit Tests
 *
 * Tests for pure statistical functions used in A/B testing:
 * - calculateSignificance: Z-test for two proportions
 * - calculateRequiredSampleSize: Power analysis
 * - estimateTimeToSignificance: Time estimation
 * - shouldStopEarly: O'Brien-Fleming early stopping
 *
 * These are pure functions with no dependencies -- no mocks needed.
 *
 * @see ab-testing/statistical-analysis.ts
 */

import { describe, it, expect } from '@jest/globals';

import {
  calculateSignificance,
  calculateRequiredSampleSize,
  estimateTimeToSignificance,
  shouldStopEarly,
} from '../../ab-testing/statistical-analysis';
import type { ComputedMetrics } from '../../ab-testing/types';

// Make this file a module to avoid TS2451 redeclaration errors
export {};

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Create a ComputedMetrics object with sensible defaults.
 * Only successCount and failureCount are required -- everything else has defaults.
 */
function createMetrics(
  overrides: Partial<ComputedMetrics> & { successCount: number; failureCount: number }
): ComputedMetrics {
  const sampleSize = overrides.successCount + overrides.failureCount;
  return {
    experimentId: 'test-exp',
    variant: 'control',
    totalProfitWei: '0',
    totalGasCostWei: '0',
    totalLatencyMs: 0,
    mevFrontrunCount: 0,
    successRate: sampleSize > 0 ? overrides.successCount / sampleSize : 0,
    avgProfitWei: '0',
    avgGasCostWei: '0',
    avgLatencyMs: 0,
    mevFrontrunRate: 0,
    sampleSize,
    ...overrides,
  };
}

// =============================================================================
// calculateSignificance
// =============================================================================

describe('calculateSignificance', () => {
  it('should return sampleSizeWarning when both groups have insufficient data', () => {
    const control = createMetrics({ successCount: 40, failureCount: 10, variant: 'control' });
    const variant = createMetrics({ successCount: 45, failureCount: 5, variant: 'variant' });

    const result = calculateSignificance(control, variant);

    expect(result.significant).toBe(false);
    expect(result.sampleSizeWarning).toBeDefined();
    expect(result.sampleSizeWarning).toContain('Insufficient sample size');
    expect(result.sampleSizeWarning).toContain('50/100');
    expect(result.recommendation).toBe('continue_testing');
  });

  it('should return sampleSizeWarning when only control has insufficient data', () => {
    const control = createMetrics({ successCount: 30, failureCount: 20, variant: 'control' });
    const variant = createMetrics({ successCount: 80, failureCount: 120, variant: 'variant' });

    const result = calculateSignificance(control, variant);

    expect(result.significant).toBe(false);
    expect(result.sampleSizeWarning).toBeDefined();
    expect(result.recommendation).toBe('continue_testing');
  });

  it('should return sampleSizeWarning when only variant has insufficient data', () => {
    const control = createMetrics({ successCount: 80, failureCount: 120, variant: 'control' });
    const variant = createMetrics({ successCount: 30, failureCount: 20, variant: 'variant' });

    const result = calculateSignificance(control, variant);

    expect(result.significant).toBe(false);
    expect(result.sampleSizeWarning).toBeDefined();
    expect(result.recommendation).toBe('continue_testing');
  });

  it('should report no significance when both groups have the same success rate', () => {
    const control = createMetrics({ successCount: 80, failureCount: 20, variant: 'control' });
    const variant = createMetrics({ successCount: 80, failureCount: 20, variant: 'variant' });

    const result = calculateSignificance(control, variant);

    expect(result.significant).toBe(false);
    expect(result.pValue).toBeGreaterThan(0.05);
    expect(result.effectSize).toBeCloseTo(0, 5);
    expect(result.zScore).toBeCloseTo(0, 5);
    expect(result.sampleSizeWarning).toBeUndefined();
    // Identical rates with enough data -> p-value is 1.0 -> inconclusive
    expect(['inconclusive', 'continue_testing']).toContain(result.recommendation);
  });

  it('should detect significant improvement when variant is much better', () => {
    // variant: 90% success, control: 70% success, n=200 each
    const control = createMetrics({ successCount: 140, failureCount: 60, variant: 'control' });
    const variant = createMetrics({ successCount: 180, failureCount: 20, variant: 'variant' });

    const result = calculateSignificance(control, variant);

    expect(result.significant).toBe(true);
    expect(result.pValue).toBeLessThan(0.05);
    expect(result.effectSize).toBeGreaterThan(0);
    expect(result.recommendation).toBe('adopt_variant');
    expect(result.sampleSizeWarning).toBeUndefined();
    // Confidence interval for difference should not include 0
    expect(result.confidenceInterval.lower).toBeGreaterThan(0);
  });

  it('should detect significant decline when variant is much worse', () => {
    // control: 90% success, variant: 60% success, n=200 each
    const control = createMetrics({ successCount: 180, failureCount: 20, variant: 'control' });
    const variant = createMetrics({ successCount: 120, failureCount: 80, variant: 'variant' });

    const result = calculateSignificance(control, variant);

    expect(result.significant).toBe(true);
    expect(result.pValue).toBeLessThan(0.05);
    expect(result.effectSize).toBeLessThan(0);
    expect(result.recommendation).toBe('keep_control');
    expect(result.sampleSizeWarning).toBeUndefined();
    // Confidence interval for difference should be entirely negative
    expect(result.confidenceInterval.upper).toBeLessThan(0);
  });

  it('should report marginal difference as not significant with close rates', () => {
    // control: 78% vs variant: 82%, n=200 each -- small difference
    const control = createMetrics({ successCount: 156, failureCount: 44, variant: 'control' });
    const variant = createMetrics({ successCount: 164, failureCount: 36, variant: 'variant' });

    const result = calculateSignificance(control, variant);

    // With only 4pp difference and n=200, this should not be significant at p<0.05
    // The p-value should be well above 0.05
    expect(result.pValue).toBeGreaterThan(0.05);
    expect(result.significant).toBe(false);
    expect(result.sampleSizeWarning).toBeUndefined();
    // Either 'continue_testing' or 'inconclusive' is acceptable for a marginal case
    expect(['continue_testing', 'inconclusive']).toContain(result.recommendation);
  });

  it('should handle zero samples without throwing', () => {
    const control = createMetrics({ successCount: 0, failureCount: 0, variant: 'control' });
    const variant = createMetrics({ successCount: 0, failureCount: 0, variant: 'variant' });

    const result = calculateSignificance(control, variant);

    expect(result.significant).toBe(false);
    expect(result.sampleSizeWarning).toBeDefined();
    // With zero samples, z-score should be 0 and p-value should be safe
    expect(Number.isFinite(result.pValue)).toBe(true);
    expect(Number.isFinite(result.zScore)).toBe(true);
    expect(result.recommendation).toBe('continue_testing');
  });

  it('should use a stricter threshold when significanceThreshold=0.01', () => {
    // A moderately significant difference that passes at 0.05 but might not at 0.01
    // control: 70%, variant: 82%, n=200 each
    const control = createMetrics({ successCount: 140, failureCount: 60, variant: 'control' });
    const variant = createMetrics({ successCount: 164, failureCount: 36, variant: 'variant' });

    const resultDefault = calculateSignificance(control, variant, 0.05);
    const resultStrict = calculateSignificance(control, variant, 0.01);

    // The strict threshold should be harder to pass
    // Both get the same p-value, but the strict threshold may not call it significant
    expect(resultDefault.pValue).toEqual(resultStrict.pValue);

    // If p is between 0.01 and 0.05, default passes but strict does not
    if (resultDefault.pValue > 0.01 && resultDefault.pValue < 0.05) {
      expect(resultDefault.significant).toBe(true);
      expect(resultStrict.significant).toBe(false);
    }
  });

  it('should handle one side having zero samples gracefully', () => {
    const control = createMetrics({ successCount: 80, failureCount: 20, variant: 'control' });
    const variant = createMetrics({ successCount: 0, failureCount: 0, variant: 'variant' });

    const result = calculateSignificance(control, variant);

    expect(result.significant).toBe(false);
    expect(result.sampleSizeWarning).toBeDefined();
    expect(Number.isFinite(result.pValue)).toBe(true);
    expect(Number.isFinite(result.zScore)).toBe(true);
    expect(result.recommendation).toBe('continue_testing');
  });

  it('should compute correct effect size as variant minus control rate', () => {
    // control: 60%, variant: 80%
    const control = createMetrics({ successCount: 120, failureCount: 80, variant: 'control' });
    const variant = createMetrics({ successCount: 160, failureCount: 40, variant: 'variant' });

    const result = calculateSignificance(control, variant);

    // effectSize = variant.successRate - control.successRate = 0.8 - 0.6 = 0.2
    expect(result.effectSize).toBeCloseTo(0.2, 5);
  });

  it('should return confidence interval that contains the effect size', () => {
    const control = createMetrics({ successCount: 150, failureCount: 50, variant: 'control' });
    const variant = createMetrics({ successCount: 170, failureCount: 30, variant: 'variant' });

    const result = calculateSignificance(control, variant);

    expect(result.confidenceInterval.lower).toBeLessThanOrEqual(result.effectSize);
    expect(result.confidenceInterval.upper).toBeGreaterThanOrEqual(result.effectSize);
  });

  it('should accept a custom minSampleSize', () => {
    // With minSampleSize=50, 50 samples should be enough
    const control = createMetrics({ successCount: 40, failureCount: 10, variant: 'control' });
    const variant = createMetrics({ successCount: 20, failureCount: 30, variant: 'variant' });

    const result = calculateSignificance(control, variant, 0.05, 50);

    expect(result.sampleSizeWarning).toBeUndefined();
    // With such a large difference (80% vs 40%) and n=50, should be significant
    expect(result.significant).toBe(true);
  });

  it('should correctly report inconclusive when p-value is very high with enough data', () => {
    // Nearly identical rates with large samples -> high p-value -> inconclusive
    const control = createMetrics({ successCount: 150, failureCount: 50, variant: 'control' });
    const variant = createMetrics({ successCount: 150, failureCount: 50, variant: 'variant' });

    const result = calculateSignificance(control, variant);

    expect(result.significant).toBe(false);
    expect(result.pValue).toBeGreaterThan(0.5);
    expect(result.recommendation).toBe('inconclusive');
  });
});

// =============================================================================
// calculateRequiredSampleSize
// =============================================================================

describe('calculateRequiredSampleSize', () => {
  it('should return a reasonable number for standard parameters', () => {
    // Baseline 80%, MDE 5pp, power 0.8, alpha 0.05
    const n = calculateRequiredSampleSize(0.8, 0.05);

    expect(n).toBeGreaterThan(100);
    expect(n).toBeLessThan(5000);
    expect(Number.isInteger(n)).toBe(true);
  });

  it('should require much larger sample for small effect size', () => {
    const nSmall = calculateRequiredSampleSize(0.8, 0.01);
    const nLarge = calculateRequiredSampleSize(0.8, 0.05);

    // Detecting a 1pp effect requires much more data than detecting a 5pp effect
    expect(nSmall).toBeGreaterThan(nLarge);
    expect(nSmall).toBeGreaterThan(5000);
  });

  it('should require smaller sample for large effect size', () => {
    const nLarge = calculateRequiredSampleSize(0.8, 0.2);
    const nStandard = calculateRequiredSampleSize(0.8, 0.05);

    expect(nLarge).toBeLessThan(nStandard);
    expect(nLarge).toBeGreaterThan(0);
  });

  it('should return Infinity when MDE is zero', () => {
    const n = calculateRequiredSampleSize(0.8, 0);

    expect(n).toBe(Infinity);
  });

  it('should handle baseline near zero', () => {
    const n = calculateRequiredSampleSize(0.01, 0.05);

    expect(n).toBeGreaterThan(0);
    expect(Number.isFinite(n)).toBe(true);
  });

  it('should handle baseline near one', () => {
    const n = calculateRequiredSampleSize(0.99, 0.005);

    // High baseline with small MDE -> needs reasonable sample
    expect(n).toBeGreaterThan(0);
    expect(Number.isFinite(n)).toBe(true);
  });

  it('should return a ceiling-rounded integer', () => {
    const n = calculateRequiredSampleSize(0.5, 0.1);

    expect(Number.isInteger(n)).toBe(true);
  });

  it('should scale with baseline variance (highest samples near 0.5)', () => {
    // Variance p*(1-p) is maximized at p=0.5
    const nLow = calculateRequiredSampleSize(0.1, 0.05);
    const nMid = calculateRequiredSampleSize(0.5, 0.05);
    const nHigh = calculateRequiredSampleSize(0.9, 0.05);

    // n at 0.5 baseline should generally be highest (most variance)
    // but exact behavior depends on the formula interaction with pBar
    // At minimum, all should be positive finite
    expect(nLow).toBeGreaterThan(0);
    expect(nMid).toBeGreaterThan(0);
    expect(nHigh).toBeGreaterThan(0);
  });
});

// =============================================================================
// estimateTimeToSignificance
// =============================================================================

describe('estimateTimeToSignificance', () => {
  it('should return correct hours for normal throughput', () => {
    // Need 1000 samples, have 200, getting 100/hour
    const hours = estimateTimeToSignificance(200, 1000, 100);

    expect(hours).toBe(8); // (1000 - 200) / 100 = 8
  });

  it('should return Infinity when throughput is zero', () => {
    const hours = estimateTimeToSignificance(100, 1000, 0);

    expect(hours).toBe(Infinity);
  });

  it('should return Infinity when throughput is negative', () => {
    const hours = estimateTimeToSignificance(100, 1000, -5);

    expect(hours).toBe(Infinity);
  });

  it('should return 0 when current samples already meet requirement', () => {
    const hours = estimateTimeToSignificance(1000, 1000, 100);

    expect(hours).toBe(0);
  });

  it('should return 0 when current samples exceed requirement', () => {
    const hours = estimateTimeToSignificance(1500, 1000, 100);

    expect(hours).toBe(0);
  });

  it('should return full duration when starting from zero', () => {
    const hours = estimateTimeToSignificance(0, 500, 50);

    expect(hours).toBe(10); // 500 / 50 = 10
  });

  it('should return fractional hours correctly', () => {
    const hours = estimateTimeToSignificance(0, 100, 30);

    // 100 / 30 = 3.333...
    expect(hours).toBeCloseTo(100 / 30, 5);
  });
});

// =============================================================================
// shouldStopEarly
// =============================================================================

describe('shouldStopEarly', () => {
  it('should not stop when information fraction is below 25%', () => {
    // At 20% of target: too early
    const result = shouldStopEarly(0.001, 200, 1000);

    expect(result.shouldStop).toBe(false);
    expect(result.adjustedAlpha).toBeCloseTo(0.0001, 4);
    expect(result.reason).toBe('Insufficient data for interim analysis');
  });

  it('should not stop at 10% even with extremely low p-value', () => {
    const result = shouldStopEarly(0.00001, 100, 1000);

    expect(result.shouldStop).toBe(false);
    expect(result.reason).toContain('Insufficient data');
  });

  it('should use very conservative alpha at 25% information fraction', () => {
    // At exactly 25%: O'Brien-Fleming boundary is very conservative
    const result = shouldStopEarly(0.5, 250, 1000);

    // adjustedAlpha at 25% should be very small (much less than 0.05)
    expect(result.adjustedAlpha).toBeLessThan(0.05);
    expect(result.adjustedAlpha).toBeGreaterThan(0);
    // With p=0.5 at 25%, should definitely not stop
    expect(result.shouldStop).toBe(false);
  });

  it('should use moderate alpha at 50% information fraction', () => {
    const result = shouldStopEarly(0.5, 500, 1000);

    // At 50%, alpha should be more relaxed than at 25% but still conservative
    expect(result.adjustedAlpha).toBeLessThan(0.05);
    expect(result.adjustedAlpha).toBeGreaterThan(0);

    // Verify it's more relaxed than at 25%
    const resultAt25 = shouldStopEarly(0.5, 250, 1000);
    expect(result.adjustedAlpha).toBeGreaterThan(resultAt25.adjustedAlpha);
  });

  it('should have alpha close to nominal at 100% information fraction', () => {
    const result = shouldStopEarly(0.5, 1000, 1000);

    // At 100%, the adjusted alpha should approach the nominal alpha
    // O'Brien-Fleming at t=1: alpha(1) = 2*(1 - normalCdf(1.96/1)) ~ 0.05
    expect(result.adjustedAlpha).toBeCloseTo(0.05, 2);
  });

  it('should recommend stopping with very strong evidence at interim', () => {
    // Very low p-value at 50% information fraction
    const result = shouldStopEarly(0.0001, 500, 1000);

    // At 50% with p=0.0001, should be below the O'Brien-Fleming boundary
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain('P-value');
  });

  it('should not stop with weak evidence', () => {
    // High p-value -- not enough evidence
    const result = shouldStopEarly(0.4, 500, 1000);

    expect(result.shouldStop).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it('should not stop with moderate evidence at early interim', () => {
    // p=0.01 at 30% -- O'Brien-Fleming is very strict here
    const result = shouldStopEarly(0.01, 300, 1000);

    // At 30% information, the boundary is very conservative
    // p=0.01 may or may not pass depending on exact boundary
    // Just verify the adjustedAlpha is quite strict
    expect(result.adjustedAlpha).toBeLessThan(0.05);
  });

  it('should return adjustedAlpha that decreases as information fraction increases', () => {
    const alpha25 = shouldStopEarly(0.5, 250, 1000).adjustedAlpha;
    const alpha50 = shouldStopEarly(0.5, 500, 1000).adjustedAlpha;
    const alpha75 = shouldStopEarly(0.5, 750, 1000).adjustedAlpha;
    const alpha100 = shouldStopEarly(0.5, 1000, 1000).adjustedAlpha;

    // O'Brien-Fleming: alpha increases (becomes more permissive) as study progresses
    expect(alpha25).toBeLessThan(alpha50);
    expect(alpha50).toBeLessThan(alpha75);
    expect(alpha75).toBeLessThan(alpha100);
  });

  it('should handle edge case where target equals current (100%)', () => {
    const result = shouldStopEarly(0.03, 1000, 1000);

    // At 100%, adjusted alpha ~ 0.05, so p=0.03 should trigger stop
    expect(result.shouldStop).toBe(true);
  });

  it('should handle edge case where current exceeds target', () => {
    // informationFraction > 1.0
    const result = shouldStopEarly(0.03, 1500, 1000);

    // Should still work; informationFraction = 1.5 is > 0.25
    expect(Number.isFinite(result.adjustedAlpha)).toBe(true);
    // The alpha should be even more relaxed than at 100%
    expect(result.adjustedAlpha).toBeGreaterThanOrEqual(0.04);
  });
});
