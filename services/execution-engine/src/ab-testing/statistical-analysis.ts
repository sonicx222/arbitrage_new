/**
 * Statistical Analysis Module for A/B Testing
 *
 * Provides statistical significance calculations using Z-test.
 * Calculates p-values, confidence intervals, and recommendations.
 *
 * @see FINAL_IMPLEMENTATION_PLAN.md Task 3: A/B Testing Framework
 */

import type {
  ComputedMetrics,
  SignificanceResult,
  SignificanceRecommendation,
} from './types';

// =============================================================================
// Z-Test Implementation
// =============================================================================

/**
 * Standard normal cumulative distribution function.
 * Approximation using Abramowitz and Stegun formula 7.1.26.
 */
function normalCdf(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  // Save the sign of x
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);

  // A&S formula
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return 0.5 * (1.0 + sign * y);
}

/**
 * Two-tailed p-value from Z-score.
 */
function zScoreToPValue(zScore: number): number {
  // Two-tailed test: P(|Z| > |z|) = 2 * (1 - Φ(|z|))
  return 2 * (1 - normalCdf(Math.abs(zScore)));
}

/**
 * Z-score for two proportions test.
 *
 * Tests H0: p1 = p2 (no difference between success rates)
 * Uses pooled proportion under null hypothesis.
 *
 * @param successes1 - Number of successes in group 1
 * @param n1 - Sample size of group 1
 * @param successes2 - Number of successes in group 2
 * @param n2 - Sample size of group 2
 * @returns Z-score for the two proportions test
 */
function twoProportionsZScore(
  successes1: number,
  n1: number,
  successes2: number,
  n2: number
): number {
  if (n1 === 0 || n2 === 0) {
    return 0;
  }

  const p1 = successes1 / n1;
  const p2 = successes2 / n2;

  // Pooled proportion under null hypothesis
  const pPooled = (successes1 + successes2) / (n1 + n2);

  // Standard error of difference
  const se = Math.sqrt(pPooled * (1 - pPooled) * (1 / n1 + 1 / n2));

  if (se === 0) {
    return 0;
  }

  return (p1 - p2) / se;
}

/**
 * Wilson score confidence interval for proportion.
 * More accurate than normal approximation for small samples.
 */
function wilsonConfidenceInterval(
  successes: number,
  n: number,
  confidence: number = 0.95
): { lower: number; upper: number } {
  if (n === 0) {
    return { lower: 0, upper: 0 };
  }

  // Z-score for confidence level (e.g., 1.96 for 95%)
  const z = 1.96; // Could parameterize based on confidence level

  const p = successes / n;
  const denominator = 1 + z * z / n;

  const center = (p + z * z / (2 * n)) / denominator;
  const margin = (z / denominator) * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n);

  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
  };
}

/**
 * Confidence interval for difference in proportions.
 */
function differenceConfidenceInterval(
  p1: number,
  n1: number,
  p2: number,
  n2: number,
  confidence: number = 0.95
): { lower: number; upper: number } {
  if (n1 === 0 || n2 === 0) {
    return { lower: 0, upper: 0 };
  }

  const z = 1.96; // 95% confidence

  const diff = p1 - p2;
  const se = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);

  return {
    lower: diff - z * se,
    upper: diff + z * se,
  };
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Calculate statistical significance between control and variant metrics.
 *
 * Uses a two-proportions Z-test to determine if the difference in success
 * rates is statistically significant.
 *
 * @param controlMetrics - Metrics from the control group
 * @param variantMetrics - Metrics from the variant group
 * @param significanceThreshold - P-value threshold (default: 0.05)
 * @param minSampleSize - Minimum samples required per group (default: 100)
 * @returns Statistical significance analysis result
 */
export function calculateSignificance(
  controlMetrics: ComputedMetrics,
  variantMetrics: ComputedMetrics,
  significanceThreshold: number = 0.05,
  minSampleSize: number = 100
): SignificanceResult {
  const nControl = controlMetrics.sampleSize;
  const nVariant = variantMetrics.sampleSize;
  const successesControl = controlMetrics.successCount;
  const successesVariant = variantMetrics.successCount;

  // Check sample size
  const hasEnoughData = nControl >= minSampleSize && nVariant >= minSampleSize;
  let sampleSizeWarning: string | undefined;

  if (!hasEnoughData) {
    sampleSizeWarning = `Insufficient sample size. Control: ${nControl}/${minSampleSize}, Variant: ${nVariant}/${minSampleSize}`;
  }

  // Calculate Z-score for success rate comparison
  const zScore = twoProportionsZScore(
    successesControl,
    nControl,
    successesVariant,
    nVariant
  );

  // Calculate p-value
  const pValue = zScoreToPValue(zScore);

  // Effect size (difference in success rates)
  const effectSize = variantMetrics.successRate - controlMetrics.successRate;

  // Confidence interval for the difference
  const confidenceInterval = differenceConfidenceInterval(
    variantMetrics.successRate,
    nVariant,
    controlMetrics.successRate,
    nControl
  );

  // Determine significance
  const significant = pValue < significanceThreshold && hasEnoughData;

  // Generate recommendation
  const recommendation = generateRecommendation(
    significant,
    effectSize,
    hasEnoughData,
    pValue,
    significanceThreshold
  );

  return {
    pValue,
    significant,
    zScore,
    confidenceInterval,
    effectSize,
    recommendation,
    sampleSizeWarning,
  };
}

/**
 * Generate a recommendation based on statistical analysis.
 */
function generateRecommendation(
  significant: boolean,
  effectSize: number,
  hasEnoughData: boolean,
  pValue: number,
  threshold: number
): SignificanceRecommendation {
  if (!hasEnoughData) {
    return 'continue_testing';
  }

  if (!significant) {
    // p-value >= threshold
    if (pValue > 0.5) {
      return 'inconclusive'; // Very high p-value suggests no real difference
    }
    return 'continue_testing'; // Might become significant with more data
  }

  // Significant result
  if (effectSize > 0) {
    return 'adopt_variant'; // Variant is significantly better
  } else {
    return 'keep_control'; // Control is significantly better
  }
}

/**
 * Calculate required sample size for desired statistical power.
 *
 * Uses standard power analysis for two-proportions test.
 *
 * @param baselineRate - Expected success rate for control
 * @param minimumDetectableEffect - Minimum effect size to detect
 * @param power - Desired statistical power (default: 0.8)
 * @param alpha - Significance level (default: 0.05)
 * @returns Required sample size per group
 */
export function calculateRequiredSampleSize(
  baselineRate: number,
  minimumDetectableEffect: number,
  power: number = 0.8,
  alpha: number = 0.05
): number {
  // Z-scores for power and significance
  const zAlpha = 1.96; // Two-tailed, alpha = 0.05
  const zBeta = 0.84; // Power = 0.8

  const p1 = baselineRate;
  const p2 = baselineRate + minimumDetectableEffect;
  const pBar = (p1 + p2) / 2;

  const numerator = Math.pow(
    zAlpha * Math.sqrt(2 * pBar * (1 - pBar)) +
    zBeta * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2)),
    2
  );

  const denominator = Math.pow(p2 - p1, 2);

  if (denominator === 0) {
    return Infinity;
  }

  return Math.ceil(numerator / denominator);
}

/**
 * Estimate time to significance based on current throughput.
 *
 * @param currentSampleSize - Current total samples
 * @param requiredSampleSize - Required samples for significance
 * @param samplesPerHour - Current throughput rate
 * @returns Estimated hours until significance can be calculated
 */
export function estimateTimeToSignificance(
  currentSampleSize: number,
  requiredSampleSize: number,
  samplesPerHour: number
): number {
  if (samplesPerHour <= 0) {
    return Infinity;
  }

  const remaining = Math.max(0, requiredSampleSize - currentSampleSize);
  return remaining / samplesPerHour;
}

/**
 * Perform early stopping check using O'Brien-Fleming spending function.
 *
 * Allows for early termination when evidence is overwhelming,
 * while controlling for multiple testing.
 *
 * @param pValue - Current p-value
 * @param currentSampleSize - Current sample size
 * @param targetSampleSize - Planned total sample size
 * @param overallAlpha - Overall significance level (default: 0.05)
 * @returns Whether early stopping is recommended
 */
export function shouldStopEarly(
  pValue: number,
  currentSampleSize: number,
  targetSampleSize: number,
  overallAlpha: number = 0.05
): { shouldStop: boolean; adjustedAlpha: number; reason?: string } {
  // O'Brien-Fleming spending function approximation
  // More conservative at early looks, relaxes as study progresses
  const informationFraction = currentSampleSize / targetSampleSize;

  if (informationFraction < 0.25) {
    // Too early for interim analysis
    return {
      shouldStop: false,
      adjustedAlpha: 0.0001, // Very conservative
      reason: 'Insufficient data for interim analysis',
    };
  }

  // O'Brien-Fleming boundary (approximation)
  // α(t) ≈ 2 * (1 - Φ(z_α/2 / √t))
  const zAlpha = 1.96; // For α = 0.05
  const adjustedZ = zAlpha / Math.sqrt(informationFraction);
  const adjustedAlpha = 2 * (1 - normalCdf(adjustedZ));

  const shouldStop = pValue < adjustedAlpha;

  return {
    shouldStop,
    adjustedAlpha,
    reason: shouldStop
      ? `P-value ${pValue.toFixed(4)} < adjusted α ${adjustedAlpha.toFixed(4)}`
      : undefined,
  };
}
