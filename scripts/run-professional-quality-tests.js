#!/usr/bin/env node

/**
 * Professional Quality Test Runner
 *
 * Executes comprehensive tests to measure and validate AD-PQS
 * (Arbitrage Detection Professional Quality Score).
 *
 * FIX M11: Split from 412-line God class into focused modules:
 *   - quality-scorer.js — Score calculation, impact assessment, recommendations
 *   - quality-report-generator.js — JSON + HTML report generation, console output
 *   - run-professional-quality-tests.js (this file) — Slim orchestrator
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Task P2-2: Use shared constants
const {
  UNIT_TEST_TIMEOUT_MS,
  INTEGRATION_TEST_TIMEOUT_MS,
  PERFORMANCE_TEST_TIMEOUT_MS
} = require('./lib/constants');

// FIX M11: Use extracted modules
const { calculateQualityScore, assessImpact, generateRecommendations } = require('./lib/quality-scorer');
const { saveReports, printResults } = require('./lib/quality-report-generator');

class ProfessionalQualityTestRunner {
  constructor() {
    this.results = {
      timestamp: new Date().toISOString(),
      testSuite: 'Professional Quality Test Suite',
      overallResult: 'UNKNOWN',
      summary: {
        totalTests: 0,
        passedTests: 0,
        failedTests: 0,
        skippedTests: 0,
        executionTime: 0
      },
      qualityMetrics: {
        baselineScore: null,
        finalScore: null,
        scoreChange: 0,
        impact: 'UNKNOWN',
        riskLevel: 'UNKNOWN'
      },
      testResults: [],
      recommendations: []
    };

    this.baselineFile = path.join(__dirname, '..', '.quality-baseline.json');
  }

  async run() {
    console.log('Starting Professional Quality Test Suite');
    console.log('=' .repeat(60));

    const startTime = Date.now();

    try {
      await this.loadBaseline();

      console.log('\nRunning Unit Tests...');
      await this.runTestSuite('unit', 'npm test -- --testPathPattern="professional-quality-monitor.test.ts"', UNIT_TEST_TIMEOUT_MS);

      console.log('\nRunning Integration Tests...');
      await this.runTestSuite('integration', 'npm run test:integration -- --testPathPattern="professional-quality.integration.test.ts"', INTEGRATION_TEST_TIMEOUT_MS);

      console.log('\nRunning Performance Tests...');
      await this.runTestSuite('performance', 'npm run test:performance -- --testPathPattern="professional-quality.performance.test.ts"', PERFORMANCE_TEST_TIMEOUT_MS);

      // Calculate scores using extracted module
      console.log('\nCalculating Final Quality Score...');
      this.results.qualityMetrics.finalScore = calculateQualityScore(this.results.summary);

      // Assess impact
      const impact = assessImpact(
        this.results.qualityMetrics.finalScore,
        this.results.qualityMetrics.baselineScore
      );
      Object.assign(this.results.qualityMetrics, impact);

      // Generate recommendations
      this.results.recommendations = generateRecommendations(
        this.results.summary,
        this.results.qualityMetrics
      );

      // Generate report
      saveReports(this.results, __dirname, path.join(__dirname, '..', 'test-results'));

      // FIX C4: Set overallResult based on test results (was never set to PASSED)
      if (this.results.summary.failedTests === 0 && this.results.testResults.length > 0) {
        this.results.overallResult = 'PASSED';
      } else {
        this.results.overallResult = 'FAILED';
      }

      // Save new baseline if tests passed
      if (this.results.overallResult === 'PASSED') {
        await this.saveBaseline();
      }

    } catch (error) {
      console.error('Test suite failed:', error.message);
      this.results.overallResult = 'FAILED';
    }

    this.results.summary.executionTime = Date.now() - startTime;

    // Print final results using extracted module
    printResults(this.results);

    // Exit with appropriate code
    process.exit(this.results.overallResult === 'PASSED' ? 0 : 1);
  }

  async loadBaseline() {
    try {
      if (fs.existsSync(this.baselineFile)) {
        const baselineData = JSON.parse(fs.readFileSync(this.baselineFile, 'utf8'));
        this.results.qualityMetrics.baselineScore = baselineData.score;
        console.log(`Loaded baseline score: ${baselineData.score} (${baselineData.timestamp})`);
      } else {
        console.log('No baseline found - this will be the first run');
      }
    } catch (error) {
      console.warn('Failed to load baseline:', error.message);
    }
  }

  /**
   * Run a test suite and accumulate results.
   * Replaces duplicated runUnitTests/runIntegrationTests/runPerformanceTests.
   *
   * @param {string} suite - Suite name (unit, integration, performance)
   * @param {string} command - Shell command to execute
   * @param {number} timeout - Timeout in milliseconds
   */
  async runTestSuite(suite, command, timeout) {
    try {
      const output = execSync(command, { encoding: 'utf8', timeout });
      this.parseTestOutput(output, suite);
      console.log(`${suite} tests completed`);
    } catch (error) {
      console.error(`${suite} tests failed:`, error.message);
      this.results.testResults.push({
        suite,
        result: 'FAILED',
        error: error.message
      });
    }
  }

  parseTestOutput(output, suite) {
    const passed = (output.match(/✓/g) || []).length;
    const failed = (output.match(/✗|✕/g) || []).length;
    const skipped = (output.match(/skip|Skip/g) || []).length;

    this.results.summary.totalTests += passed + failed + skipped;
    this.results.summary.passedTests += passed;
    this.results.summary.failedTests += failed;
    this.results.summary.skippedTests += skipped;

    this.results.testResults.push({
      suite,
      result: failed === 0 ? 'PASSED' : 'FAILED',
      passed,
      failed,
      skipped
    });

    // Extract quality scores from output if available
    const scoreMatch = output.match(/qualityScore["\s:]+(\d+)/i);
    if (scoreMatch) {
      this.results.qualityMetrics.finalScore = parseInt(scoreMatch[1]);
    }
  }

  async saveBaseline() {
    const baselineData = {
      score: this.results.qualityMetrics.finalScore,
      timestamp: this.results.timestamp,
      testResults: this.results.summary
    };

    fs.writeFileSync(this.baselineFile, JSON.stringify(baselineData, null, 2));
    console.log(`Baseline saved: ${this.results.qualityMetrics.finalScore} points`);
  }
}

// Run the test suite
if (require.main === module) {
  const runner = new ProfessionalQualityTestRunner();
  runner.run().catch(error => {
    console.error('Test runner failed:', error);
    process.exit(1);
  });
}

module.exports = ProfessionalQualityTestRunner;
