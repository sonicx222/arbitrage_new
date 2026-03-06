/**
 * Opportunity Scoring
 *
 * Pure scoring function for opportunity admission control.
 * Score = expectedProfit × confidence × (1 / max(ttlRemainingMs, 100))
 *
 * Higher scores indicate more valuable opportunities to execute:
 * - Higher expected profit increases score linearly
 * - Higher confidence increases score linearly
 * - Shorter remaining TTL increases score (urgency factor)
 *
 * The 100ms floor on TTL prevents score explosion for nearly-expired opportunities.
 *
 * @see ADR-037: Coordinator Pipeline Optimization
 * @see docs/reports/EXECUTION_BOTTLENECK_RESEARCH_2026-03-06.md — Phase 1
 */

/**
 * Minimal interface for scoring. Accepts raw parsed fields that may be
 * undefined (Redis Streams type erasure).
 */
export interface ScorableOpportunity {
  expectedProfit?: number;
  confidence?: number;
  expiresAt?: number;
  timestamp?: number;
}

/** Default TTL when expiresAt is not available (60 seconds) */
const DEFAULT_TTL_MS = 60000;

/** Minimum TTL floor to prevent division explosion (100ms) */
const MIN_TTL_FLOOR_MS = 100;

/**
 * Score an opportunity for admission control prioritization.
 *
 * @param opp - Opportunity with optional numeric fields
 * @param now - Current timestamp (ms since epoch)
 * @returns Non-negative score. Higher = more valuable. 0 = should not execute.
 */
export function scoreOpportunity(opp: ScorableOpportunity, now: number): number {
  const profit = opp.expectedProfit;

  // Guard: no profit, negative profit, NaN, or Infinity → score 0
  if (profit === undefined || profit === null || profit <= 0 || !Number.isFinite(profit)) {
    return 0;
  }

  // Confidence: default to 0.5 if missing or invalid
  let confidence = opp.confidence;
  if (confidence === undefined || confidence === null || !Number.isFinite(confidence)) {
    confidence = 0.5;
  }
  // Zero confidence = zero score
  if (confidence <= 0) return 0;

  // TTL remaining: compute from expiresAt, floor at MIN_TTL_FLOOR_MS
  let ttlRemainingMs: number;
  if (opp.expiresAt !== undefined && opp.expiresAt !== null && Number.isFinite(opp.expiresAt)) {
    ttlRemainingMs = opp.expiresAt - now;
  } else {
    ttlRemainingMs = DEFAULT_TTL_MS;
  }
  // Clamp to floor (prevents near-zero division and handles expired opps)
  if (ttlRemainingMs < MIN_TTL_FLOOR_MS) {
    ttlRemainingMs = MIN_TTL_FLOOR_MS;
  }

  return profit * confidence * (1 / ttlRemainingMs);
}
