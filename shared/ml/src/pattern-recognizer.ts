/**
 * Pattern Recognizer for Market Analysis
 *
 * Detects trading patterns (whale accumulation, breakout, consolidation, etc.)
 * using sliding window comparison and normalized similarity scoring.
 *
 * Extracted from predictor.ts (P3-1 refactoring) for single-responsibility.
 *
 * @see docs/reports/implementation_plan_v3.md - Phase 4
 */

import {
  calculateReturns,
  calculateVolumeChanges,
  normalizeSequence,
  cosineSimilarityNormalized,
  trendSimilarity,
} from './feature-math';
import type { PriceHistory, PatternResult } from './predictor-types';

// =============================================================================
// Configuration
// =============================================================================

/**
 * Configuration for PatternRecognizer
 */
export interface PatternRecognizerConfig {
  /** Minimum data points required for pattern detection (default: 5) */
  minDataPoints?: number;
  /** Time horizon for pattern predictions in ms (default: 600000 = 10 minutes) */
  patternTimeHorizonMs?: number;
}

const DEFAULT_PATTERN_CONFIG: Required<PatternRecognizerConfig> = {
  minDataPoints: 5,
  patternTimeHorizonMs: 600000 // 10 minutes
};

/**
 * Pattern definition for recognition
 */
interface PatternDefinition {
  /** Expected sequence of returns (length determines comparison window) */
  sequence: number[];
  /** Similarity threshold for pattern match (0-1) */
  threshold: number;
  /** Confidence level when pattern is detected */
  confidence: number;
  /** Expected outcome description */
  outcome: string;
  /** Pattern type for categorization */
  type: 'price' | 'volume' | 'combined';
}

// =============================================================================
// PatternRecognizer Class
// =============================================================================

/**
 * Pattern recognizer using dynamic time warping and sliding window comparison.
 * Fixes Bug 4.4: Pattern sequences now work with variable-length input.
 */
export class PatternRecognizer {
  private patterns: Map<string, PatternDefinition> = new Map();
  private readonly config: Required<PatternRecognizerConfig>;

  constructor(config: PatternRecognizerConfig = {}) {
    this.config = { ...DEFAULT_PATTERN_CONFIG, ...config };
    this.initializePatterns();
  }

  private initializePatterns(): void {
    // Price-based patterns
    this.patterns.set('whale_accumulation', {
      sequence: [0.1, 0.15, 0.2, 0.25],
      threshold: 0.65,
      confidence: 0.85,
      outcome: 'price_increase_2-5%',
      type: 'volume'
    });

    this.patterns.set('profit_taking', {
      sequence: [-0.05, -0.03, -0.08, -0.12],
      threshold: 0.60,
      confidence: 0.80,
      outcome: 'continued_downtrend',
      type: 'price'
    });

    this.patterns.set('breakout', {
      sequence: [0.02, 0.03, 0.05, 0.08],
      threshold: 0.70,
      confidence: 0.90,
      outcome: 'momentum_continuation',
      type: 'price'
    });

    // Additional patterns for completeness
    this.patterns.set('consolidation', {
      sequence: [0.01, -0.01, 0.01, -0.01],
      threshold: 0.65,
      confidence: 0.75,
      outcome: 'range_bound_trading',
      type: 'price'
    });

    this.patterns.set('volume_spike', {
      sequence: [0.5, 1.0, 1.5, 2.0],
      threshold: 0.60,
      confidence: 0.70,
      outcome: 'increased_volatility',
      type: 'volume'
    });

    this.patterns.set('bearish_divergence', {
      sequence: [0.05, 0.03, 0.01, -0.02],
      threshold: 0.65,
      confidence: 0.75,
      outcome: 'potential_reversal_down',
      type: 'combined'
    });

    this.patterns.set('bullish_divergence', {
      sequence: [-0.05, -0.03, -0.01, 0.02],
      threshold: 0.65,
      confidence: 0.75,
      outcome: 'potential_reversal_up',
      type: 'combined'
    });
  }

  /**
   * Detect patterns in price and volume history.
   * Fix for Bug 4.4: Uses sliding window comparison instead of fixed-length matching.
   */
  detectPattern(priceHistory: PriceHistory[], volumeHistory: number[]): PatternResult | null {
    if (priceHistory.length < this.config.minDataPoints || volumeHistory.length < this.config.minDataPoints) {
      return null;
    }

    const recentPrices = priceHistory.slice(-10).map(p => p.price);
    const recentVolumes = volumeHistory.slice(-10);

    if (recentPrices.length < this.config.minDataPoints) {
      return null;
    }

    // P2-5 fix: Use shared math functions from feature-math.ts
    const priceChanges = calculateReturns(recentPrices);
    const volumeChanges = calculateVolumeChanges(recentVolumes);

    let bestMatch: PatternResult | null = null;
    let bestSimilarity = 0;

    for (const [patternName, pattern] of this.patterns) {
      // Select the appropriate sequence based on pattern type
      let inputSequence: number[];
      switch (pattern.type) {
        case 'volume':
          inputSequence = volumeChanges;
          break;
        case 'combined':
          // Use average of price and volume changes
          // P2-10 fix: Use ?? so that legitimate 0 values are preserved
          inputSequence = priceChanges.map((p, i) =>
            (p + (volumeChanges[i] ?? 0)) / 2
          );
          break;
        case 'price':
        default:
          inputSequence = priceChanges;
      }

      // Use sliding window comparison (fix for Bug 4.4)
      const similarity = this.calculateSlidingWindowSimilarity(inputSequence, pattern.sequence);

      if (similarity >= pattern.threshold && similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestMatch = {
          pattern: patternName,
          confidence: pattern.confidence * similarity, // Scale confidence by similarity
          expectedOutcome: pattern.outcome,
          timeHorizon: this.config.patternTimeHorizonMs,
          features: [...priceChanges, ...volumeChanges]
        };
      }
    }

    return bestMatch;
  }

  /**
   * Add a custom pattern for recognition.
   */
  addPattern(name: string, definition: PatternDefinition): void {
    this.patterns.set(name, definition);
  }

  /**
   * Get all registered patterns.
   */
  getPatterns(): Map<string, PatternDefinition> {
    return new Map(this.patterns);
  }

  /**
   * Calculate similarity using sliding window comparison.
   * This fixes Bug 4.4 where sequences of different lengths couldn't be compared.
   */
  private calculateSlidingWindowSimilarity(input: number[], pattern: number[]): number {
    if (input.length === 0 || pattern.length === 0) return 0;

    // If input is shorter than pattern, use normalized comparison
    if (input.length < pattern.length) {
      return this.calculateNormalizedSimilarity(input, pattern.slice(0, input.length));
    }

    // Slide the pattern over the input and find best match
    let bestSimilarity = 0;
    const windowSize = pattern.length;

    for (let i = 0; i <= input.length - windowSize; i++) {
      const window = input.slice(i, i + windowSize);
      const similarity = this.calculateNormalizedSimilarity(window, pattern);
      bestSimilarity = Math.max(bestSimilarity, similarity);
    }

    return bestSimilarity;
  }

  /**
   * Calculate normalized similarity between two sequences of the same length.
   * P2-5 fix: Now delegates to shared feature-math.ts functions.
   */
  private calculateNormalizedSimilarity(seq1: number[], seq2: number[]): number {
    if (seq1.length !== seq2.length || seq1.length === 0) return 0;

    // Normalize both sequences
    const norm1 = normalizeSequence(seq1);
    const norm2 = normalizeSequence(seq2);

    // Calculate cosine similarity (already normalized to [0,1]) + trend similarity
    const cosineSim = cosineSimilarityNormalized(norm1, norm2);
    const trendSim = trendSimilarity(seq1, seq2);

    // Weighted combination
    return 0.6 * cosineSim + 0.4 * trendSim;
  }
}

// =============================================================================
// Singleton Factory
// =============================================================================

let patternRecognizer: PatternRecognizer | null = null;

/**
 * Get the singleton PatternRecognizer instance.
 */
export function getPatternRecognizer(config?: PatternRecognizerConfig): PatternRecognizer {
  if (!patternRecognizer) {
    patternRecognizer = new PatternRecognizer(config);
  }
  return patternRecognizer;
}

/**
 * Reset the PatternRecognizer singleton.
 * Use for testing or when reconfiguration is needed.
 */
export function resetPatternRecognizer(): void {
  patternRecognizer = null;
}
