#!/usr/bin/env node
/**
 * Quality Score Calculator
 *
 * Calculates quality scores and generates recommendations based on test results.
 * Pure functions — no side effects, no I/O.
 *
 * FIX M11: Extracted from run-professional-quality-tests.js (was 412-line God class).
 *
 * @see scripts/run-professional-quality-tests.js (orchestrator)
 */

// =============================================================================
// Quality Score Calculation
// =============================================================================

/**
 * Calculate final quality score from test summary.
 *
 * @param {{totalTests: number, failedTests: number}} summary - Test summary
 * @returns {number} Score 0-100
 */
function calculateQualityScore(summary) {
  if (summary.totalTests === 0) return 0;

  const failureRate = summary.failedTests / summary.totalTests;

  if (failureRate === 0) return 95;      // All passed — excellent
  if (failureRate < 0.1) return 85;      // <10% failures — good
  if (failureRate < 0.25) return 75;     // <25% failures — acceptable
  return 60;                              // High failure rate — poor
}

// =============================================================================
// Impact Assessment
// =============================================================================

/**
 * Assess quality impact relative to a baseline score.
 *
 * @param {number} finalScore - Current quality score
 * @param {number|null} baselineScore - Previous baseline score (null if first run)
 * @returns {{scoreChange: number, impact: string, riskLevel: string}}
 */
function assessImpact(finalScore, baselineScore) {
  if (baselineScore == null) {
    return { scoreChange: 0, impact: 'UNKNOWN', riskLevel: 'UNKNOWN' };
  }

  const change = finalScore - baselineScore;

  if (change >= 5) return { scoreChange: change, impact: 'POSITIVE', riskLevel: 'LOW' };
  if (change >= -2) return { scoreChange: change, impact: 'NEUTRAL', riskLevel: 'LOW' };
  if (change >= -10) return { scoreChange: change, impact: 'NEGATIVE', riskLevel: 'MEDIUM' };
  return { scoreChange: change, impact: 'CRITICAL', riskLevel: 'HIGH' };
}

// =============================================================================
// Recommendations
// =============================================================================

/**
 * Generate actionable recommendations from test results and quality metrics.
 *
 * @param {{failedTests: number}} summary - Test summary
 * @param {{impact: string, finalScore: number}} metrics - Quality metrics
 * @returns {string[]} Array of recommendation strings
 */
function generateRecommendations(summary, metrics) {
  const recommendations = [];

  if (summary.failedTests > 0) {
    recommendations.push(`Fix ${summary.failedTests} failing tests`);
  }

  if (metrics.impact === 'CRITICAL') {
    recommendations.push('CRITICAL: Quality degradation detected - immediate action required');
    recommendations.push('   - Revert recent changes or implement fixes immediately');
    recommendations.push('   - Run performance profiling to identify bottlenecks');
  } else if (metrics.impact === 'NEGATIVE') {
    recommendations.push('Quality degradation detected - optimization needed');
    recommendations.push('   - Review recent changes for performance impact');
    recommendations.push('   - Consider caching or algorithmic improvements');
  } else if (metrics.impact === 'POSITIVE') {
    recommendations.push('Quality improvement detected - excellent work!');
    recommendations.push('   - Consider promoting these changes to production');
  }

  if (metrics.finalScore < 80) {
    recommendations.push('Professional quality below standards - improvement needed');
    recommendations.push('   - Focus on latency optimization (< 5ms P95)');
    recommendations.push('   - Improve detection accuracy (> 95% precision)');
    recommendations.push('   - Enhance system reliability (> 99.9% uptime)');
  }

  return recommendations;
}

module.exports = {
  calculateQualityScore,
  assessImpact,
  generateRecommendations
};
