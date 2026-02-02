/**
 * Flaky Test Reporter for Jest
 *
 * Phase 4 Testing Excellence: Flaky Test Detection
 *
 * Tracks test results across multiple runs to identify flaky tests.
 * A test is considered flaky if it both passes and fails in the same batch.
 *
 * Usage:
 *   Add to jest.config.js reporters:
 *   reporters: ['default', '<rootDir>/jest-flaky-reporter.js']
 *
 * @see docs/reports/TEST_OPTIMIZATION_RESEARCH_REPORT.md
 */

const fs = require('fs');
const path = require('path');

/** @type {Map<string, { passed: number; failed: number; durations: number[] }>} */
const testResults = new Map();

const RESULTS_FILE = path.join(__dirname, '.flaky-test-results.json');

class FlakyTestReporter {
  constructor(globalConfig, options = {}) {
    this.globalConfig = globalConfig;
    this.options = options;
    this.startTime = Date.now();

    // Load existing results if incremental
    if (options.incremental !== false) {
      this.loadResults();
    }
  }

  loadResults() {
    try {
      if (fs.existsSync(RESULTS_FILE)) {
        const data = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
        for (const [key, value] of Object.entries(data.results || {})) {
          testResults.set(key, value);
        }
      }
    } catch {
      // Ignore errors, start fresh
    }
  }

  saveResults() {
    const data = {
      lastRun: new Date().toISOString(),
      totalRuns: (this.options.runCount || 0) + 1,
      results: Object.fromEntries(testResults),
    };
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(data, null, 2));
  }

  onTestResult(test, testResult) {
    for (const result of testResult.testResults) {
      const key = `${test.path}::${result.fullName}`;
      const current = testResults.get(key) || {
        passed: 0,
        failed: 0,
        durations: [],
      };

      if (result.status === 'passed') {
        current.passed++;
      } else if (result.status === 'failed') {
        current.failed++;
      }

      if (result.duration) {
        current.durations.push(result.duration);
        // Keep only last 10 durations to track trends
        if (current.durations.length > 10) {
          current.durations.shift();
        }
      }

      testResults.set(key, current);
    }
  }

  onRunComplete(contexts, results) {
    this.saveResults();

    const flakyTests = [];
    const slowTests = [];

    for (const [name, stats] of testResults.entries()) {
      // Detect flaky tests (both passed and failed)
      if (stats.passed > 0 && stats.failed > 0) {
        const flakyRate = stats.failed / (stats.passed + stats.failed);
        flakyTests.push({
          name,
          flakyRate,
          passed: stats.passed,
          failed: stats.failed,
        });
      }

      // Detect slow tests (average > 1 second)
      if (stats.durations.length > 0) {
        const avgDuration =
          stats.durations.reduce((a, b) => a + b, 0) / stats.durations.length;
        if (avgDuration > 1000) {
          slowTests.push({
            name,
            avgDuration,
            maxDuration: Math.max(...stats.durations),
          });
        }
      }
    }

    // Report flaky tests
    if (flakyTests.length > 0) {
      console.log('\n\n');
      console.log('╔════════════════════════════════════════════════════════════════╗');
      console.log('║                   FLAKY TESTS DETECTED                         ║');
      console.log('╠════════════════════════════════════════════════════════════════╣');

      // Sort by flaky rate (most flaky first)
      flakyTests.sort((a, b) => b.flakyRate - a.flakyRate);

      for (const test of flakyTests.slice(0, 10)) {
        const rate = (test.flakyRate * 100).toFixed(1);
        const shortName = test.name.length > 60
          ? '...' + test.name.slice(-57)
          : test.name;
        console.log(`║ ${rate.padStart(5)}% | ${shortName.padEnd(54)} ║`);
      }

      if (flakyTests.length > 10) {
        console.log(`║ ... and ${flakyTests.length - 10} more flaky tests                              ║`);
      }

      console.log('╚════════════════════════════════════════════════════════════════╝');
      console.log(`\nTotal flaky tests: ${flakyTests.length}`);
      console.log(`Results saved to: ${RESULTS_FILE}`);
    }

    // Report slow tests
    if (slowTests.length > 0 && this.options.reportSlow !== false) {
      console.log('\n');
      console.log('╔════════════════════════════════════════════════════════════════╗');
      console.log('║                   SLOW TESTS DETECTED                          ║');
      console.log('╠════════════════════════════════════════════════════════════════╣');

      // Sort by average duration (slowest first)
      slowTests.sort((a, b) => b.avgDuration - a.avgDuration);

      for (const test of slowTests.slice(0, 10)) {
        const avg = (test.avgDuration / 1000).toFixed(2);
        const max = (test.maxDuration / 1000).toFixed(2);
        const shortName = test.name.length > 40
          ? '...' + test.name.slice(-37)
          : test.name;
        console.log(`║ avg: ${avg.padStart(5)}s max: ${max.padStart(5)}s | ${shortName.padEnd(34)} ║`);
      }

      if (slowTests.length > 10) {
        console.log(`║ ... and ${slowTests.length - 10} more slow tests                               ║`);
      }

      console.log('╚════════════════════════════════════════════════════════════════╝');
    }

    // Return summary for CI integration
    return {
      flakyTests: flakyTests.length,
      slowTests: slowTests.length,
      totalTracked: testResults.size,
    };
  }
}

module.exports = FlakyTestReporter;
