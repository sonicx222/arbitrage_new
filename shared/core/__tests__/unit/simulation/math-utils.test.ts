/**
 * Statistical utility function tests for realistic simulation.
 *
 * Tests verify distribution properties over many samples rather than
 * exact values, since these functions are stochastic.
 */

import { describe, it, expect } from '@jest/globals';
import {
  gaussianRandom,
  poissonRandom,
  weightedRandomSelect,
} from '../../../src/simulation/math-utils';

describe('gaussianRandom', () => {
  it('should return numbers with approximately correct mean over many samples', () => {
    const samples = Array.from({ length: 10000 }, () => gaussianRandom(100, 10));
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(mean).toBeGreaterThan(99);
    expect(mean).toBeLessThan(101);
  });

  it('should return numbers with approximately correct std dev over many samples', () => {
    const targetStdDev = 10;
    const samples = Array.from({ length: 10000 }, () => gaussianRandom(0, targetStdDev));
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const variance = samples.reduce((sum, x) => sum + (x - mean) ** 2, 0) / samples.length;
    const stdDev = Math.sqrt(variance);
    expect(stdDev).toBeGreaterThan(targetStdDev * 0.9);
    expect(stdDev).toBeLessThan(targetStdDev * 1.1);
  });

  it('should default to mean=0, stdDev=1', () => {
    const samples = Array.from({ length: 5000 }, () => gaussianRandom());
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(mean).toBeGreaterThan(-0.1);
    expect(mean).toBeLessThan(0.1);
  });
});

describe('poissonRandom', () => {
  it('should return non-negative integers', () => {
    for (let i = 0; i < 100; i++) {
      const value = poissonRandom(5);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  it('should have approximately correct mean for small lambda', () => {
    const lambda = 5;
    const samples = Array.from({ length: 10000 }, () => poissonRandom(lambda));
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(mean).toBeGreaterThan(lambda * 0.95);
    expect(mean).toBeLessThan(lambda * 1.05);
  });

  it('should have approximately correct mean for large lambda (Gaussian approx)', () => {
    const lambda = 120;
    const samples = Array.from({ length: 10000 }, () => poissonRandom(lambda));
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(mean).toBeGreaterThan(lambda * 0.97);
    expect(mean).toBeLessThan(lambda * 1.03);
  });

  it('should return 0 for lambda <= 0', () => {
    expect(poissonRandom(0)).toBe(0);
    expect(poissonRandom(-5)).toBe(0);
  });
});

describe('weightedRandomSelect', () => {
  it('should select items proportional to their weights', () => {
    const items = ['a', 'b', 'c'];
    const weights = [0.7, 0.2, 0.1];
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };

    for (let i = 0; i < 10000; i++) {
      const selected = weightedRandomSelect(items, weights);
      counts[selected]++;
    }

    expect(counts['a'] / 10000).toBeGreaterThan(0.65);
    expect(counts['a'] / 10000).toBeLessThan(0.75);
    expect(counts['c'] / 10000).toBeGreaterThan(0.07);
    expect(counts['c'] / 10000).toBeLessThan(0.13);
  });

  it('should return the only item when array has one element', () => {
    expect(weightedRandomSelect(['only'], [1.0])).toBe('only');
  });

  it('should handle items with zero weight (never selected)', () => {
    const items = ['yes', 'no'];
    const weights = [1.0, 0];
    for (let i = 0; i < 100; i++) {
      expect(weightedRandomSelect(items, weights)).toBe('yes');
    }
  });
});
