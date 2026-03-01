/**
 * Statistical utility functions for realistic simulation.
 *
 * - gaussianRandom: Box-Muller transform for normally distributed values
 * - poissonRandom: Knuth algorithm (small λ) / Gaussian approximation (large λ)
 * - weightedRandomSelect: Weighted random selection from arrays
 *
 * @module simulation
 * @see docs/plans/2026-03-01-realistic-throughput-simulation-design.md
 */

/**
 * Generate a Gaussian (normally distributed) random number.
 * Uses the Box-Muller transform for exact normal distribution.
 *
 * @param mean - Distribution mean (default: 0)
 * @param stdDev - Standard deviation (default: 1)
 * @returns Normally distributed random number
 */
export function gaussianRandom(mean = 0, stdDev = 1): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u1 || 1e-10)) * Math.cos(2.0 * Math.PI * u2);
  return z * stdDev + mean;
}

/**
 * Generate a Poisson-distributed random integer.
 *
 * For λ ≤ 30: Uses Knuth's exact algorithm.
 * For λ > 30: Uses Gaussian approximation (Central Limit Theorem).
 *
 * @param lambda - Expected value (average rate)
 * @returns Non-negative integer drawn from Poisson(λ)
 */
export function poissonRandom(lambda: number): number {
  if (lambda <= 0) return 0;

  if (lambda > 30) {
    return Math.max(0, Math.round(gaussianRandom(lambda, Math.sqrt(lambda))));
  }

  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= Math.random();
  } while (p > L);
  return k - 1;
}

/**
 * Select an item from an array using weighted random selection.
 *
 * @param items - Array of items to select from
 * @param weights - Corresponding weights (higher = more likely)
 * @returns Selected item
 */
export function weightedRandomSelect<T>(items: T[], weights: number[]): T {
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  let rand = Math.random() * totalWeight;

  for (let i = 0; i < items.length; i++) {
    rand -= weights[i];
    if (rand <= 0) return items[i];
  }

  return items[items.length - 1];
}
