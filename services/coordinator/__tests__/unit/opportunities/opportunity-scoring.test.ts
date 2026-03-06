/**
 * Unit tests for opportunity scoring function.
 *
 * Tests the pure scoring formula:
 *   score = expectedProfit × confidence × (1 / max(ttlRemainingMs, 100))
 *
 * The score prioritizes opportunities by:
 * - Higher expected profit
 * - Higher confidence
 * - Shorter remaining TTL (more urgent)
 *
 * @see services/coordinator/src/opportunities/opportunity-scoring.ts
 */

import { scoreOpportunity, type ScorableOpportunity } from '../../../src/opportunities/opportunity-scoring';

// =============================================================================
// Test Helpers
// =============================================================================

function createScorableOpp(overrides: Partial<ScorableOpportunity> = {}): ScorableOpportunity {
  const now = Date.now();
  return {
    expectedProfit: 0.5,
    confidence: 0.85,
    expiresAt: now + 10000,  // 10s remaining
    timestamp: now - 1000,
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('scoreOpportunity', () => {
  const NOW = 1700000000000;

  describe('basic scoring', () => {
    it('should compute score = expectedProfit × confidence × (1 / ttlRemainingMs)', () => {
      const opp = createScorableOpp({
        expectedProfit: 1.0,
        confidence: 0.8,
        expiresAt: NOW + 5000,  // 5s remaining
      });

      const score = scoreOpportunity(opp, NOW);

      // 1.0 × 0.8 × (1 / 5000) = 0.00016
      expect(score).toBeCloseTo(0.00016, 8);
    });

    it('should return higher scores for higher profit', () => {
      const lowProfit = createScorableOpp({ expectedProfit: 0.1, confidence: 0.8, expiresAt: NOW + 5000 });
      const highProfit = createScorableOpp({ expectedProfit: 1.0, confidence: 0.8, expiresAt: NOW + 5000 });

      expect(scoreOpportunity(highProfit, NOW)).toBeGreaterThan(scoreOpportunity(lowProfit, NOW));
    });

    it('should return higher scores for higher confidence', () => {
      const lowConf = createScorableOpp({ expectedProfit: 0.5, confidence: 0.3, expiresAt: NOW + 5000 });
      const highConf = createScorableOpp({ expectedProfit: 0.5, confidence: 0.9, expiresAt: NOW + 5000 });

      expect(scoreOpportunity(highConf, NOW)).toBeGreaterThan(scoreOpportunity(lowConf, NOW));
    });

    it('should return higher scores for shorter remaining TTL (more urgent)', () => {
      const longTtl = createScorableOpp({ expectedProfit: 0.5, confidence: 0.8, expiresAt: NOW + 30000 });
      const shortTtl = createScorableOpp({ expectedProfit: 0.5, confidence: 0.8, expiresAt: NOW + 2000 });

      expect(scoreOpportunity(shortTtl, NOW)).toBeGreaterThan(scoreOpportunity(longTtl, NOW));
    });
  });

  describe('missing fields', () => {
    it('should return 0 when expectedProfit is undefined', () => {
      const opp = createScorableOpp({ expectedProfit: undefined });
      expect(scoreOpportunity(opp, NOW)).toBe(0);
    });

    it('should return 0 when expectedProfit is 0', () => {
      const opp = createScorableOpp({ expectedProfit: 0 });
      expect(scoreOpportunity(opp, NOW)).toBe(0);
    });

    it('should return 0 when expectedProfit is negative', () => {
      const opp = createScorableOpp({ expectedProfit: -0.5 });
      expect(scoreOpportunity(opp, NOW)).toBe(0);
    });

    it('should use default confidence 0.5 when confidence is undefined', () => {
      const opp = createScorableOpp({
        expectedProfit: 1.0,
        confidence: undefined,
        expiresAt: NOW + 5000,
      });

      // 1.0 × 0.5 × (1 / 5000) = 0.0001
      expect(scoreOpportunity(opp, NOW)).toBeCloseTo(0.0001, 8);
    });

    it('should use default TTL when expiresAt is undefined', () => {
      const opp = createScorableOpp({
        expectedProfit: 1.0,
        confidence: 0.8,
        expiresAt: undefined,
      });

      // Uses default TTL of 60000ms
      // 1.0 × 0.8 × (1 / 60000) ≈ 0.00001333
      const score = scoreOpportunity(opp, NOW);
      expect(score).toBeGreaterThan(0);
      expect(score).toBeCloseTo(1.0 * 0.8 * (1 / 60000), 8);
    });
  });

  describe('edge cases', () => {
    it('should clamp TTL to minimum 100ms to prevent division explosion', () => {
      // Already expired (TTL remaining = negative)
      const opp = createScorableOpp({
        expectedProfit: 1.0,
        confidence: 0.8,
        expiresAt: NOW - 1000,  // expired 1s ago
      });

      // Clamped to 100ms: 1.0 × 0.8 × (1 / 100) = 0.008
      expect(scoreOpportunity(opp, NOW)).toBeCloseTo(0.008, 6);
    });

    it('should clamp TTL to minimum 100ms when TTL is very small positive', () => {
      const opp = createScorableOpp({
        expectedProfit: 1.0,
        confidence: 0.8,
        expiresAt: NOW + 10,  // 10ms remaining
      });

      // Clamped to 100ms: 1.0 × 0.8 × (1 / 100) = 0.008
      expect(scoreOpportunity(opp, NOW)).toBeCloseTo(0.008, 6);
    });

    it('should handle confidence of 0 (returns 0 score)', () => {
      const opp = createScorableOpp({ confidence: 0 });
      expect(scoreOpportunity(opp, NOW)).toBe(0);
    });

    it('should handle confidence > 1 (pass through, not clamped)', () => {
      const opp = createScorableOpp({
        expectedProfit: 1.0,
        confidence: 1.5,
        expiresAt: NOW + 5000,
      });

      // 1.0 × 1.5 × (1 / 5000) = 0.0003
      expect(scoreOpportunity(opp, NOW)).toBeCloseTo(0.0003, 8);
    });

    it('should handle NaN expectedProfit gracefully', () => {
      const opp = createScorableOpp({ expectedProfit: NaN });
      expect(scoreOpportunity(opp, NOW)).toBe(0);
    });

    it('should handle NaN confidence gracefully', () => {
      const opp = createScorableOpp({
        expectedProfit: 1.0,
        confidence: NaN,
        expiresAt: NOW + 5000,
      });
      // Falls back to default confidence 0.5
      expect(scoreOpportunity(opp, NOW)).toBeCloseTo(1.0 * 0.5 * (1 / 5000), 8);
    });

    it('should handle Infinity expectedProfit gracefully', () => {
      const opp = createScorableOpp({ expectedProfit: Infinity });
      expect(scoreOpportunity(opp, NOW)).toBe(0);
    });
  });

  describe('scoring order for sorting', () => {
    it('should rank high-profit urgent opportunity above low-profit non-urgent', () => {
      const highProfitUrgent = createScorableOpp({
        expectedProfit: 2.0, confidence: 0.9, expiresAt: NOW + 3000,
      });
      const lowProfitSlow = createScorableOpp({
        expectedProfit: 0.1, confidence: 0.5, expiresAt: NOW + 30000,
      });

      const scoreA = scoreOpportunity(highProfitUrgent, NOW);
      const scoreB = scoreOpportunity(lowProfitSlow, NOW);
      expect(scoreA).toBeGreaterThan(scoreB);
    });

    it('should allow sorting an array of opportunities by score descending', () => {
      const opps = [
        createScorableOpp({ expectedProfit: 0.1, confidence: 0.5, expiresAt: NOW + 30000 }),
        createScorableOpp({ expectedProfit: 2.0, confidence: 0.9, expiresAt: NOW + 3000 }),
        createScorableOpp({ expectedProfit: 0.5, confidence: 0.8, expiresAt: NOW + 10000 }),
      ];

      const scored = opps.map(opp => ({
        opp,
        score: scoreOpportunity(opp, NOW),
      }));
      scored.sort((a, b) => b.score - a.score);

      // Highest profit + most urgent should be first
      expect(scored[0].opp.expectedProfit).toBe(2.0);
      // Lowest profit + least urgent should be last
      expect(scored[scored.length - 1].opp.expectedProfit).toBe(0.1);
    });
  });
});
