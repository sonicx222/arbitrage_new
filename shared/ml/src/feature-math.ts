/**
 * T4.3 Refactor 9.2: Consolidated Feature Extraction Math
 *
 * Shared mathematical utilities for feature extraction across ML models.
 * Eliminates duplicate implementations in LSTMPredictor and OrderflowFeatureExtractor.
 *
 * Performance optimizations:
 * - Pre-allocated buffers for hot-path operations
 * - Minimized allocations in calculation loops
 * - NaN/Infinity protection throughout
 *
 * @see docs/reports/implementation_plan_v3.md - Phase 4
 */

// =============================================================================
// Statistical Functions
// =============================================================================

/**
 * Calculate simple moving average.
 * Returns 0 for empty arrays.
 */
export function calculateSMA(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
  }
  return sum / values.length;
}

/**
 * Alias for calculateSMA for semantic clarity.
 */
export const calculateMean = calculateSMA;

/**
 * Calculate variance of values.
 * Returns 0 for arrays with < 2 elements.
 */
export function calculateVariance(values: number[]): number {
  if (values.length < 2) return 0;

  const mean = calculateMean(values);
  let sumSquaredDiff = 0;

  for (let i = 0; i < values.length; i++) {
    const diff = values[i] - mean;
    sumSquaredDiff += diff * diff;
  }

  return sumSquaredDiff / values.length;
}

/**
 * Calculate standard deviation.
 * Returns 0 for arrays with < 2 elements.
 */
export function calculateStdDev(values: number[]): number {
  return Math.sqrt(calculateVariance(values));
}

/**
 * Calculate volatility from price series using log returns.
 * Returns the standard deviation of log returns (non-annualized).
 *
 * P2-12 fix: Corrected JSDoc — this returns raw std dev of log returns,
 * not annualized volatility. To annualize, multiply by sqrt(periodsPerYear).
 *
 * @param prices - Array of prices (at least 2 required)
 * @returns Standard deviation of log returns (0 if insufficient data)
 */
export function calculateVolatility(prices: number[]): number {
  if (prices.length < 2) return 0;

  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0 && prices[i] > 0) {
      returns.push(Math.log(prices[i] / prices[i - 1]));
    }
  }

  if (returns.length === 0) return 0;

  return calculateStdDev(returns);
}

/**
 * Calculate price momentum (difference between last and first price).
 */
export function calculateMomentum(prices: number[]): number {
  if (prices.length < 2) return 0;
  return prices[prices.length - 1] - prices[0];
}

/**
 * Calculate percentage momentum.
 * Returns 0 if first price is zero.
 */
export function calculateMomentumPercent(prices: number[]): number {
  if (prices.length < 2) return 0;
  if (prices[0] === 0) return 0;
  return (prices[prices.length - 1] - prices[0]) / prices[0];
}

// =============================================================================
// Trend Analysis
// =============================================================================

/**
 * Calculate linear trend (slope) using linear regression.
 * Returns 0 for arrays with < 2 elements or if calculation is degenerate.
 *
 * @param values - Y values (X values are assumed to be 0, 1, 2, ...)
 * @returns Slope of the linear regression line
 */
export function calculateTrend(values: number[]): number {
  if (values.length < 2) return 0;

  const n = values.length;

  // Calculate sums for linear regression
  // Using numerically stable formulas
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;

  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumXX += i * i;
  }

  const denominator = n * sumXX - sumX * sumX;

  // Protect against division by zero
  if (denominator === 0 || !Number.isFinite(denominator)) {
    return 0;
  }

  const slope = (n * sumXY - sumX * sumY) / denominator;

  // Protect against NaN/Infinity
  return Number.isFinite(slope) ? slope : 0;
}

/**
 * Calculate R-squared (coefficient of determination) for trend.
 * Returns 0 for arrays with < 2 elements.
 *
 * @param values - Y values
 * @returns R-squared value (0-1), where 1 = perfect linear fit
 */
export function calculateTrendStrength(values: number[]): number {
  if (values.length < 2) return 0;

  const n = values.length;
  const slope = calculateTrend(values);
  const mean = calculateMean(values);

  // Calculate intercept
  const sumX = (n * (n - 1)) / 2; // Sum of 0 to n-1
  const intercept = (mean * n - slope * sumX) / n;

  // Calculate total sum of squares and residual sum of squares
  let ssTotal = 0;
  let ssResidual = 0;

  for (let i = 0; i < n; i++) {
    const predicted = slope * i + intercept;
    const diffFromMean = values[i] - mean;
    const residual = values[i] - predicted;

    ssTotal += diffFromMean * diffFromMean;
    ssResidual += residual * residual;
  }

  if (ssTotal === 0) return 0;

  const rSquared = 1 - ssResidual / ssTotal;

  // Clamp to valid range (numerical errors can cause slight out-of-bounds)
  return Math.max(0, Math.min(1, rSquared));
}

// =============================================================================
// Return Calculations
// =============================================================================

/**
 * Calculate simple returns from price series.
 * Returns array of (p[i] - p[i-1]) / p[i-1]
 *
 * @param prices - Price series
 * @returns Array of returns (length = prices.length - 1)
 */
export function calculateReturns(prices: number[]): number[] {
  const returns: number[] = [];

  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] !== 0) {
      returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
    } else {
      returns.push(0);
    }
  }

  return returns;
}

/**
 * Calculate log returns from price series.
 * Returns array of log(p[i] / p[i-1])
 *
 * @param prices - Price series
 * @returns Array of log returns (length = prices.length - 1)
 */
export function calculateLogReturns(prices: number[]): number[] {
  const returns: number[] = [];

  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0 && prices[i] > 0) {
      returns.push(Math.log(prices[i] / prices[i - 1]));
    } else {
      returns.push(0);
    }
  }

  return returns;
}

// =============================================================================
// Volume Analysis
// =============================================================================

/**
 * Calculate volume ratio (current vs average).
 * Bug 4.3 fix: Division-by-zero protection included.
 *
 * @param volumes - Volume series
 * @returns [mean, ratio] where ratio = last / mean
 */
export function calculateVolumeFeatures(volumes: number[]): [mean: number, ratio: number] {
  if (volumes.length === 0) return [0, 1];

  const mean = calculateMean(volumes);

  // Bug 4.3 fix: Prevent division by zero
  if (mean === 0 || !Number.isFinite(mean)) {
    return [0, 1]; // Default ratio of 1 (no change)
  }

  const lastVolume = volumes[volumes.length - 1];
  const ratio = lastVolume / mean;

  // Protect against NaN/Infinity
  return [mean, Number.isFinite(ratio) ? ratio : 1];
}

/**
 * Calculate volume changes (percentage change between consecutive values).
 *
 * @param volumes - Volume series
 * @returns Array of volume changes (length = volumes.length - 1)
 */
export function calculateVolumeChanges(volumes: number[]): number[] {
  const changes: number[] = [];

  for (let i = 1; i < volumes.length; i++) {
    if (volumes[i - 1] !== 0) {
      changes.push((volumes[i] - volumes[i - 1]) / volumes[i - 1]);
    } else {
      changes.push(0);
    }
  }

  return changes;
}

// =============================================================================
// Normalization Functions
// =============================================================================

/**
 * Normalize a value to 0-1 range given min and max bounds.
 * Clamps to [0, 1] if value is outside bounds.
 *
 * @param value - Value to normalize
 * @param min - Minimum value (maps to 0)
 * @param max - Maximum value (maps to 1)
 * @returns Normalized value in [0, 1]
 */
export function normalize(value: number, min: number, max: number): number {
  if (max === min) return 0.5; // Avoid division by zero
  const normalized = (value - min) / (max - min);
  return Math.max(0, Math.min(1, normalized));
}

/**
 * Normalize a value from [-range, +range] to [0, 1].
 * Commonly used for directional values.
 *
 * @param value - Value to normalize (expected to be in [-range, +range])
 * @param range - Absolute range (default: 1)
 * @returns Normalized value in [0, 1]
 */
export function normalizeSymmetric(value: number, range = 1): number {
  const clamped = Math.max(-range, Math.min(range, value));
  return (clamped + range) / (2 * range);
}

/**
 * Normalize a sequence to [0, 1] range.
 * Used for pattern matching and similarity calculations.
 *
 * @param sequence - Sequence to normalize
 * @returns Normalized sequence
 */
export function normalizeSequence(sequence: number[]): number[] {
  if (sequence.length === 0) return [];

  // P1-8 fix: Use loop-based min/max to avoid stack overflow on large arrays.
  // Math.min(...arr) throws RangeError when arr.length > ~100k elements.
  let min = sequence[0];
  let max = sequence[0];
  for (let i = 1; i < sequence.length; i++) {
    if (sequence[i] < min) min = sequence[i];
    if (sequence[i] > max) max = sequence[i];
  }
  const range = max - min;

  if (range === 0) {
    return sequence.map(() => 0.5);
  }

  return sequence.map(v => (v - min) / range);
}

// =============================================================================
// Similarity Functions
// =============================================================================

/**
 * Calculate cosine similarity between two sequences.
 * Returns value in [-1, 1], where 1 = identical direction.
 *
 * @param a - First sequence
 * @param b - Second sequence (must be same length as a)
 * @returns Cosine similarity, or 0 if sequences are invalid
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

/**
 * Calculate cosine similarity normalized to [0, 1] range.
 *
 * @param a - First sequence
 * @param b - Second sequence
 * @returns Similarity in [0, 1]
 */
export function cosineSimilarityNormalized(a: number[], b: number[]): number {
  return (cosineSimilarity(a, b) + 1) / 2;
}

/**
 * Calculate trend similarity (how many values have matching sign/direction).
 *
 * @param seq1 - First sequence
 * @param seq2 - Second sequence
 * @returns Similarity in [0, 1]
 */
export function trendSimilarity(seq1: number[], seq2: number[]): number {
  if (seq1.length !== seq2.length || seq1.length === 0) return 0;

  let matches = 0;
  for (let i = 0; i < seq1.length; i++) {
    if (Math.sign(seq1[i]) === Math.sign(seq2[i])) {
      matches++;
    }
  }

  return matches / seq1.length;
}

// =============================================================================
// Safe Math Operations
// =============================================================================

/**
 * Safe division that returns a default value on division by zero.
 *
 * @param numerator - Numerator
 * @param denominator - Denominator
 * @param defaultValue - Value to return if division is invalid (default: 0)
 * @returns Result of division or default value
 */
export function safeDivide(numerator: number, denominator: number, defaultValue = 0): number {
  if (denominator === 0 || !Number.isFinite(denominator)) {
    return defaultValue;
  }
  const result = numerator / denominator;
  return Number.isFinite(result) ? result : defaultValue;
}

/**
 * Clamp a value to a range.
 *
 * @param value - Value to clamp
 * @param min - Minimum value
 * @param max - Maximum value
 * @returns Clamped value
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Check if a value is finite (not NaN, not Infinity).
 * More readable than Number.isFinite.
 */
export function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

/**
 * Return the value if finite, otherwise return a default.
 *
 * @param value - Value to check
 * @param defaultValue - Default to use if value is not finite
 * @returns Value if finite, defaultValue otherwise
 */
export function finiteOrDefault(value: number, defaultValue: number): number {
  return Number.isFinite(value) ? value : defaultValue;
}
