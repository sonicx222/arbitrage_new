#!/usr/bin/env node

// Professional Quality Test Runner
// Executes comprehensive tests to measure and validate AD-PQS (Arbitrage Detection Professional Quality Score)

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { renderTemplate } = require('./lib/template-renderer');

// Task P2-2: Use shared constants
const {
  UNIT_TEST_TIMEOUT_MS,
  INTEGRATION_TEST_TIMEOUT_MS,
  PERFORMANCE_TEST_TIMEOUT_MS
} = require('./lib/constants');

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
    console.log('🚀 Starting Professional Quality Test Suite');
    console.log('=' .repeat(60));

    const startTime = Date.now();

    try {
      // Load baseline if available
      await this.loadBaseline();

      // Run unit tests
      console.log('\n📋 Running Unit Tests...');
      await this.runUnitTests();

      // Run integration tests
      console.log('\n🔗 Running Integration Tests...');
      await this.runIntegrationTests();

      // Run performance tests
      console.log('\n⚡ Running Performance Tests...');
      await this.runPerformanceTests();

      // Calculate final quality score
      console.log('\n📊 Calculating Final Quality Score...');
      await this.calculateFinalQualityScore();

      // Assess feature impact
      await this.assessFeatureImpact();

      // Generate report
      await this.generateReport();

      // Save new baseline if tests passed
      if (this.results.overallResult === 'PASSED') {
        await this.saveBaseline();
      }

    } catch (error) {
      console.error('❌ Test suite failed:', error.message);
      this.results.overallResult = 'FAILED';
    }

    this.results.summary.executionTime = Date.now() - startTime;

    // Print final results
    this.printResults();

    // Exit with appropriate code
    process.exit(this.results.overallResult === 'PASSED' ? 0 : 1);
  }

  async loadBaseline() {
    try {
      if (fs.existsSync(this.baselineFile)) {
        const baselineData = JSON.parse(fs.readFileSync(this.baselineFile, 'utf8'));
        this.results.qualityMetrics.baselineScore = baselineData.score;
        console.log(`📈 Loaded baseline score: ${baselineData.score} (${baselineData.timestamp})`);
      } else {
        console.log('📝 No baseline found - this will be the first run');
      }
    } catch (error) {
      console.warn('⚠️  Failed to load baseline:', error.message);
    }
  }

  async runUnitTests() {
    try {
      const output = execSync('npm test -- --testPathPattern="professional-quality-monitor.test.ts"', {
        encoding: 'utf8',
        timeout: UNIT_TEST_TIMEOUT_MS
      });

      this.parseTestOutput(output, 'unit');
      console.log('✅ Unit tests completed');
    } catch (error) {
      console.error('❌ Unit tests failed:', error.message);
      this.results.testResults.push({
        suite: 'unit',
        result: 'FAILED',
        error: error.message
      });
    }
  }

  async runIntegrationTests() {
    try {
      const output = execSync('npm run test:integration -- --testPathPattern="professional-quality.integration.test.ts"', {
        encoding: 'utf8',
        timeout: INTEGRATION_TEST_TIMEOUT_MS
      });

      this.parseTestOutput(output, 'integration');
      console.log('✅ Integration tests completed');
    } catch (error) {
      console.error('❌ Integration tests failed:', error.message);
      this.results.testResults.push({
        suite: 'integration',
        result: 'FAILED',
        error: error.message
      });
    }
  }

  async runPerformanceTests() {
    try {
      const output = execSync('npm run test:performance -- --testPathPattern="professional-quality.performance.test.ts"', {
        encoding: 'utf8',
        timeout: PERFORMANCE_TEST_TIMEOUT_MS
      });

      this.parseTestOutput(output, 'performance');
      console.log('✅ Performance tests completed');
    } catch (error) {
      console.error('❌ Performance tests failed:', error.message);
      this.results.testResults.push({
        suite: 'performance',
        result: 'FAILED',
        error: error.message
      });
    }
  }

  parseTestOutput(output, suite) {
    // Simple parsing - in production would use a proper test result parser
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

  async calculateFinalQualityScore() {
    // In a real implementation, this would query the actual quality monitor
    // For this script, we'll use a mock calculation
    if (this.results.summary.failedTests === 0) {
      // All tests passed - excellent quality
      this.results.qualityMetrics.finalScore = 95;
    } else if (this.results.summary.failedTests / this.results.summary.totalTests < 0.1) {
      // Less than 10% failure rate - good quality
      this.results.qualityMetrics.finalScore = 85;
    } else if (this.results.summary.failedTests / this.results.summary.totalTests < 0.25) {
      // Less than 25% failure rate - acceptable quality
      this.results.qualityMetrics.finalScore = 75;
    } else {
      // High failure rate - poor quality
      this.results.qualityMetrics.finalScore = 60;
    }
  }

  async assessFeatureImpact() {
    if (this.results.qualityMetrics.baselineScore && this.results.qualityMetrics.finalScore) {
      const change = this.results.qualityMetrics.finalScore - this.results.qualityMetrics.baselineScore;
      this.results.qualityMetrics.scoreChange = change;

      if (change >= 5) {
        this.results.qualityMetrics.impact = 'POSITIVE';
        this.results.qualityMetrics.riskLevel = 'LOW';
      } else if (change >= -2) {
        this.results.qualityMetrics.impact = 'NEUTRAL';
        this.results.qualityMetrics.riskLevel = 'LOW';
      } else if (change >= -10) {
        this.results.qualityMetrics.impact = 'NEGATIVE';
        this.results.qualityMetrics.riskLevel = 'MEDIUM';
      } else {
        this.results.qualityMetrics.impact = 'CRITICAL';
        this.results.qualityMetrics.riskLevel = 'HIGH';
      }
    }

    // Generate recommendations based on results
    this.generateRecommendations();
  }

  generateRecommendations() {
    const recommendations = [];

    if (this.results.summary.failedTests > 0) {
      recommendations.push(`❌ Fix ${this.results.summary.failedTests} failing tests`);
    }

    if (this.results.qualityMetrics.impact === 'CRITICAL') {
      recommendations.push('🚨 CRITICAL: Quality degradation detected - immediate action required');
      recommendations.push('   - Revert recent changes or implement fixes immediately');
      recommendations.push('   - Run performance profiling to identify bottlenecks');
    } else if (this.results.qualityMetrics.impact === 'NEGATIVE') {
      recommendations.push('⚠️ Quality degradation detected - optimization needed');
      recommendations.push('   - Review recent changes for performance impact');
      recommendations.push('   - Consider caching or algorithmic improvements');
    } else if (this.results.qualityMetrics.impact === 'POSITIVE') {
      recommendations.push('✅ Quality improvement detected - excellent work!');
      recommendations.push('   - Consider promoting these changes to production');
    }

    if (this.results.qualityMetrics.finalScore < 80) {
      recommendations.push('📈 Professional quality below standards - improvement needed');
      recommendations.push('   - Focus on latency optimization (< 5ms P95)');
      recommendations.push('   - Improve detection accuracy (> 95% precision)');
      recommendations.push('   - Enhance system reliability (> 99.9% uptime)');
    }

    this.results.recommendations = recommendations;
  }

  async generateReport() {
    const reportPath = path.join(__dirname, '..', 'test-results', 'professional-quality-report.json');
    const htmlReportPath = path.join(__dirname, '..', 'test-results', 'professional-quality-report.html');

    // Ensure test-results directory exists
    const testResultsDir = path.dirname(reportPath);
    if (!fs.existsSync(testResultsDir)) {
      fs.mkdirSync(testResultsDir, { recursive: true });
    }

    // Save JSON report
    fs.writeFileSync(reportPath, JSON.stringify(this.results, null, 2));

    // Generate HTML report
    const htmlReport = this.generateHtmlReport();
    fs.writeFileSync(htmlReportPath, htmlReport);

    console.log(`📄 Reports saved:`);
    console.log(`   JSON: ${reportPath}`);
    console.log(`   HTML: ${htmlReportPath}`);
  }

  generateHtmlReport() {
    const r = this.results;
    const template = fs.readFileSync(
      path.join(__dirname, 'templates', 'quality-report.html'),
      'utf8'
    );

    const data = {
      testSuite: r.testSuite,
      timestamp: r.timestamp,
      overallResult: r.overallResult,
      overallResultClass: r.overallResult === 'PASSED' ? 'passed' : 'failed',
      summary: r.summary,
      passedPercent: r.summary.totalTests > 0 ?
        ((r.summary.passedTests / r.summary.totalTests) * 100).toFixed(1) : '0.0',
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
      impactClass: this.getImpactClass(r.qualityMetrics.impact),
      executionTimeSeconds: (r.summary.executionTime / 1000).toFixed(2),
      testsPerSecond: (r.summary.totalTests / (r.summary.executionTime / 1000)).toFixed(1),
      recommendationsList: r.recommendations.map(rec => `<div class="recommendation">${rec}</div>`).join(''),
      testResultsRows: r.testResults.map(tr => `
            <tr>
                <td>${tr.suite}</td>
                <td class="${tr.result === 'PASSED' ? 'passed' : 'failed'}">${tr.result}</td>
                <td>${tr.passed || 0}</td>
                <td>${tr.failed || 0}</td>
                <td>${tr.skipped || 0}</td>
            </tr>
        `).join('')
    };

    return renderTemplate(template, data);
  }

  getImpactClass(impact) {
    switch (impact) {
      case 'POSITIVE': return 'passed';
      case 'NEUTRAL': return '';
      case 'NEGATIVE': return 'warning';
      case 'CRITICAL': return 'failed';
      default: return '';
    }
  }

  async saveBaseline() {
    const baselineData = {
      score: this.results.qualityMetrics.finalScore,
      timestamp: this.results.timestamp,
      testResults: this.results.summary
    };

    fs.writeFileSync(this.baselineFile, JSON.stringify(baselineData, null, 2));
    console.log(`💾 Baseline saved: ${this.results.qualityMetrics.finalScore} points`);
  }

  printResults() {
    console.log('\n' + '='.repeat(60));
    console.log('🏆 PROFESSIONAL QUALITY TEST RESULTS');
    console.log('='.repeat(60));

    console.log(`\n📊 Overall Result: ${this.results.overallResult}`);
    console.log(`⏱️  Execution Time: ${(this.results.summary.executionTime / 1000).toFixed(2)}s`);
    console.log(`🧪 Tests: ${this.results.summary.passedTests}/${this.results.summary.totalTests} passed`);

    if (this.results.qualityMetrics.baselineScore) {
      console.log(`\n📈 Quality Score:`);
      console.log(`   Baseline: ${this.results.qualityMetrics.baselineScore}`);
      console.log(`   Final:    ${this.results.qualityMetrics.finalScore}`);
      console.log(`   Change:   ${this.results.qualityMetrics.scoreChange > 0 ? '+' : ''}${this.results.qualityMetrics.scoreChange}`);
      console.log(`   Impact:   ${this.results.qualityMetrics.impact}`);
      console.log(`   Risk:     ${this.results.qualityMetrics.riskLevel}`);
    } else {
      console.log(`\n📈 Quality Score: ${this.results.qualityMetrics.finalScore} (new baseline)`);
    }

    if (this.results.recommendations.length > 0) {
      console.log(`\n📋 Recommendations:`);
      this.results.recommendations.forEach(rec => console.log(`   • ${rec}`));
    }

    console.log('\n' + '='.repeat(60));

    if (this.results.overallResult === 'PASSED') {
      console.log('✅ All tests passed! Professional quality maintained.');
    } else {
      console.log('❌ Quality issues detected. See recommendations above.');
      console.log('\n💡 To fix issues:');
      console.log('   1. Review failing tests');
      console.log('   2. Address performance bottlenecks');
      console.log('   3. Implement recommended improvements');
      console.log('   4. Re-run tests to validate fixes');
    }

    console.log('='.repeat(60));
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