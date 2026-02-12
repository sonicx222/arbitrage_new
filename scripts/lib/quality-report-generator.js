#!/usr/bin/env node
/**
 * Quality Report Generator
 *
 * Generates JSON and HTML reports from quality test results.
 * Handles file I/O for report persistence.
 *
 * FIX M11: Extracted from run-professional-quality-tests.js (was 412-line God class).
 *
 * @see scripts/run-professional-quality-tests.js (orchestrator)
 * @see scripts/templates/quality-report.html (HTML template)
 */

const fs = require('fs');
const path = require('path');
const { renderTemplate } = require('./template-renderer');

// =============================================================================
// Report Generation
// =============================================================================

/**
 * Map quality impact to CSS class name.
 * @param {string} impact - Impact level (POSITIVE, NEUTRAL, NEGATIVE, CRITICAL)
 * @returns {string} CSS class
 */
function getImpactClass(impact) {
  switch (impact) {
    case 'POSITIVE': return 'passed';
    case 'NEUTRAL': return '';
    case 'NEGATIVE': return 'warning';
    case 'CRITICAL': return 'failed';
    default: return '';
  }
}

/**
 * Build template data from test results for HTML rendering.
 *
 * @param {Object} results - Full test results object
 * @returns {Object} Template data for renderTemplate()
 */
function buildTemplateData(results) {
  const r = results;
  return {
    testSuite: r.testSuite,
    timestamp: r.timestamp,
    overallResult: r.overallResult,
    overallResultClass: r.overallResult === 'PASSED' ? 'passed' : 'failed',
    summary: r.summary,
    passedPercent: r.summary.totalTests > 0
      ? ((r.summary.passedTests / r.summary.totalTests) * 100).toFixed(1)
      : '0.0',
    failedTestsClass: r.summary.failedTests > 0 ? 'failed' : '',
    qualityMetrics: {
      baselineScore: r.qualityMetrics.baselineScore || 'N/A',
      finalScore: r.qualityMetrics.finalScore,
      scoreChange: r.qualityMetrics.scoreChange,
      impact: r.qualityMetrics.impact,
      riskLevel: r.qualityMetrics.riskLevel
    },
    scoreChangeClass: r.qualityMetrics.scoreChange >= 0 ? 'passed' : 'failed',
    scoreChangeFormatted: (r.qualityMetrics.scoreChange > 0 ? '+' : '') + r.qualityMetrics.scoreChange,
    impactClass: getImpactClass(r.qualityMetrics.impact),
    executionTimeSeconds: (r.summary.executionTime / 1000).toFixed(2),
    // FIX H6: Guard against division by zero when executionTime is 0
    testsPerSecond: r.summary.executionTime > 0
      ? (r.summary.totalTests / (r.summary.executionTime / 1000)).toFixed(1)
      : '0.0',
    recommendationsList: r.recommendations.map(rec => `<div class="recommendation">${rec}</div>`).join(''),
    testResultsRows: r.testResults.map(tr => `
          <tr>
              <td>${tr.suite}</td>
              <td class="${tr.result === 'PASSED' ? 'passed' : 'failed'}">${tr.result}</td>
              <td>${tr.passed ?? 0}</td>
              <td>${tr.failed ?? 0}</td>
              <td>${tr.skipped ?? 0}</td>
          </tr>
      `).join('')
  };
}

/**
 * Generate and save JSON + HTML reports.
 *
 * @param {Object} results - Full test results object
 * @param {string} scriptsDir - Path to scripts/ directory (for finding templates)
 * @param {string} outputDir - Path to test-results/ directory
 */
function saveReports(results, scriptsDir, outputDir) {
  const jsonPath = path.join(outputDir, 'professional-quality-report.json');
  const htmlPath = path.join(outputDir, 'professional-quality-report.html');

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Save JSON report
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));

  // Generate and save HTML report
  const template = fs.readFileSync(
    path.join(scriptsDir, 'templates', 'quality-report.html'),
    'utf8'
  );
  const data = buildTemplateData(results);
  const html = renderTemplate(template, data);
  fs.writeFileSync(htmlPath, html);

  console.log(`Reports saved:`);
  console.log(`   JSON: ${jsonPath}`);
  console.log(`   HTML: ${htmlPath}`);
}

// =============================================================================
// Console Results Display
// =============================================================================

/**
 * Print test results summary to console.
 *
 * @param {Object} results - Full test results object
 */
function printResults(results) {
  const r = results;
  console.log('\n' + '='.repeat(60));
  console.log('PROFESSIONAL QUALITY TEST RESULTS');
  console.log('='.repeat(60));

  console.log(`\nOverall Result: ${r.overallResult}`);
  console.log(`Execution Time: ${(r.summary.executionTime / 1000).toFixed(2)}s`);
  console.log(`Tests: ${r.summary.passedTests}/${r.summary.totalTests} passed`);

  if (r.qualityMetrics.baselineScore) {
    console.log(`\nQuality Score:`);
    console.log(`   Baseline: ${r.qualityMetrics.baselineScore}`);
    console.log(`   Final:    ${r.qualityMetrics.finalScore}`);
    console.log(`   Change:   ${r.qualityMetrics.scoreChange > 0 ? '+' : ''}${r.qualityMetrics.scoreChange}`);
    console.log(`   Impact:   ${r.qualityMetrics.impact}`);
    console.log(`   Risk:     ${r.qualityMetrics.riskLevel}`);
  } else {
    console.log(`\nQuality Score: ${r.qualityMetrics.finalScore} (new baseline)`);
  }

  if (r.recommendations.length > 0) {
    console.log(`\nRecommendations:`);
    r.recommendations.forEach(rec => console.log(`   ${rec}`));
  }

  console.log('\n' + '='.repeat(60));

  if (r.overallResult === 'PASSED') {
    console.log('All tests passed! Professional quality maintained.');
  } else {
    console.log('Quality issues detected. See recommendations above.');
    console.log('\nTo fix issues:');
    console.log('   1. Review failing tests');
    console.log('   2. Address performance bottlenecks');
    console.log('   3. Implement recommended improvements');
    console.log('   4. Re-run tests to validate fixes');
  }

  console.log('='.repeat(60));
}

module.exports = {
  getImpactClass,
  buildTemplateData,
  saveReports,
  printResults
};
