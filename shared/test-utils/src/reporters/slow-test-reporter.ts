/**
 * Jest Reporter for Slow Tests
 *
 * Reports tests that exceed performance budgets:
 * - Unit tests: >100ms (warning), >500ms (error)
 * - Integration tests: >5s (warning), >10s (error)
 * - E2E tests: >30s (warning), >60s (error)
 *
 * Usage in jest.config.js:
 * ```javascript
 * reporters: [
 *   'default',
 *   ['<rootDir>/shared/test-utils/src/reporters/slow-test-reporter.js', {
 *     unitThreshold: 100,
 *     integrationThreshold: 5000,
 *     e2eThreshold: 30000
 *   }]
 * ]
 * ```
 */

import type {
  AggregatedResult,
  Test,
  TestResult,
  Reporter,
  ReporterOnStartOptions,
  TestContext
} from '@jest/reporters';
import * as fs from 'fs';
import * as path from 'path';

interface SlowTestConfig {
  unitThreshold?: number; // ms
  integrationThreshold?: number; // ms
  e2eThreshold?: number; // ms
  outputFile?: string; // Path to write slow tests JSON
  failOnSlow?: boolean; // Fail CI if slow tests exceed threshold
}

interface SlowTest {
  testPath: string;
  testName: string;
  duration: number;
  threshold: number;
  project: string;
}

export default class SlowTestReporter implements Reporter {
  private config: Required<SlowTestConfig>;
  private slowTests: SlowTest[] = [];

  constructor(
    _globalConfig: any,
    options: SlowTestConfig = {}
  ) {
    this.config = {
      unitThreshold: options.unitThreshold ?? 100,
      integrationThreshold: options.integrationThreshold ?? 5000,
      e2eThreshold: options.e2eThreshold ?? 30000,
      outputFile: options.outputFile ?? 'slow-tests.json',
      failOnSlow: options.failOnSlow ?? false
    };
  }

  onRunStart(
    _aggregatedResult: AggregatedResult,
    _options: ReporterOnStartOptions
  ): void {
    this.slowTests = [];
  }

  onTestResult(
    _test: Test,
    testResult: TestResult,
    _aggregatedResult: AggregatedResult
  ): void {
    const testPath = testResult.testFilePath;
    const project = this.detectProject(testPath);
    const threshold = this.getThreshold(project);

    // Check each test in the file
    testResult.testResults.forEach(test => {
      const duration = test.duration ?? 0;

      if (duration > threshold) {
        this.slowTests.push({
          testPath: testPath,
          testName: test.fullName,
          duration,
          threshold,
          project
        });
      }
    });
  }

  async onRunComplete(
    _contexts?: Set<TestContext>,
    _aggregatedResult?: AggregatedResult
  ): Promise<void> {
    if (this.slowTests.length === 0) {
      console.log('\n✅ No slow tests detected!\n');
      return;
    }

    // Sort by duration (slowest first)
    this.slowTests.sort((a, b) => b.duration - a.duration);

    // Print to console
    console.log('\n⚠️  Slow Tests Detected:\n');
    console.log('━'.repeat(80));

    this.slowTests.forEach((test, index) => {
      const overageMs = test.duration - test.threshold;
      const overagePercent = ((test.duration / test.threshold - 1) * 100).toFixed(0);

      console.log(
        `${index + 1}. [${test.project}] ${test.duration}ms ` +
        `(${overagePercent}% over ${test.threshold}ms threshold)`
      );
      console.log(`   ${test.testName}`);
      console.log(`   ${test.testPath}`);
      console.log('');
    });

    console.log('━'.repeat(80));
    console.log(`Total slow tests: ${this.slowTests.length}\n`);

    // Write to JSON file
    const outputPath = path.resolve(this.config.outputFile);
    try {
      fs.writeFileSync(
        outputPath,
        JSON.stringify(
          {
            timestamp: new Date().toISOString(),
            slowTests: this.slowTests,
            summary: {
              total: this.slowTests.length,
              byProject: this.groupByProject()
            }
          },
          null,
          2
        )
      );

      console.log(`Slow test report written to: ${outputPath}\n`);
    } catch (error) {
      console.error(`Failed to write slow test report: ${error}\n`);
    }

    // Optionally fail CI
    if (this.config.failOnSlow && this.slowTests.length > 0) {
      throw new Error(
        `${this.slowTests.length} tests exceeded performance thresholds. ` +
        `See ${outputPath} for details.`
      );
    }
  }

  private detectProject(testPath: string): string {
    if (testPath.includes('/__tests__/unit/')) return 'unit';
    if (testPath.includes('/__tests__/integration/')) return 'integration';
    if (testPath.includes('/tests/e2e/')) return 'e2e';
    if (testPath.includes('/tests/integration/')) return 'integration';
    if (testPath.includes('/tests/performance/')) return 'performance';
    if (testPath.includes('/tests/smoke/')) return 'smoke';
    return 'unknown';
  }

  private getThreshold(project: string): number {
    switch (project) {
      case 'unit':
        return this.config.unitThreshold;
      case 'integration':
        return this.config.integrationThreshold;
      case 'e2e':
        return this.config.e2eThreshold;
      case 'performance':
        return Infinity; // Performance tests are expected to be slow
      case 'smoke':
        return this.config.integrationThreshold; // Use integration threshold
      default:
        return this.config.integrationThreshold;
    }
  }

  private groupByProject(): Record<string, number> {
    return this.slowTests.reduce((acc, test) => {
      acc[test.project] = (acc[test.project] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>);
  }
}
