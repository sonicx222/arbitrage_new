"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
class SlowTestReporter {
    config;
    slowTests = [];
    constructor(_globalConfig, options = {}) {
        this.config = {
            unitThreshold: options.unitThreshold ?? 100,
            integrationThreshold: options.integrationThreshold ?? 5000,
            e2eThreshold: options.e2eThreshold ?? 30000,
            outputFile: options.outputFile ?? 'slow-tests.json',
            failOnSlow: options.failOnSlow ?? false
        };
    }
    onRunStart(_aggregatedResult, _options) {
        this.slowTests = [];
    }
    onTestResult(_test, testResult, _aggregatedResult) {
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
    async onRunComplete(_contexts, _aggregatedResult) {
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
            console.log(`${index + 1}. [${test.project}] ${test.duration}ms ` +
                `(${overagePercent}% over ${test.threshold}ms threshold)`);
            console.log(`   ${test.testName}`);
            console.log(`   ${test.testPath}`);
            console.log('');
        });
        console.log('━'.repeat(80));
        console.log(`Total slow tests: ${this.slowTests.length}\n`);
        // Write to JSON file
        const outputPath = path.resolve(this.config.outputFile);
        try {
            fs.writeFileSync(outputPath, JSON.stringify({
                timestamp: new Date().toISOString(),
                slowTests: this.slowTests,
                summary: {
                    total: this.slowTests.length,
                    byProject: this.groupByProject()
                }
            }, null, 2));
            console.log(`Slow test report written to: ${outputPath}\n`);
        }
        catch (error) {
            console.error(`Failed to write slow test report: ${error}\n`);
        }
        // Optionally fail CI
        if (this.config.failOnSlow && this.slowTests.length > 0) {
            throw new Error(`${this.slowTests.length} tests exceeded performance thresholds. ` +
                `See ${outputPath} for details.`);
        }
    }
    detectProject(testPath) {
        // Normalize to forward slashes for cross-platform compatibility (Windows uses backslashes)
        const normalized = testPath.replace(/\\/g, '/');
        if (normalized.includes('/__tests__/unit/'))
            return 'unit';
        if (normalized.includes('/__tests__/integration/'))
            return 'integration';
        if (normalized.includes('/__tests__/performance/'))
            return 'performance';
        if (normalized.includes('/tests/e2e/'))
            return 'e2e';
        if (normalized.includes('/tests/integration/'))
            return 'integration';
        if (normalized.includes('/tests/performance/'))
            return 'performance';
        if (normalized.includes('/tests/smoke/'))
            return 'smoke';
        return 'unknown';
    }
    getThreshold(project) {
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
    groupByProject() {
        return this.slowTests.reduce((acc, test) => {
            acc[test.project] = (acc[test.project] ?? 0) + 1;
            return acc;
        }, {});
    }
}
exports.default = SlowTestReporter;
