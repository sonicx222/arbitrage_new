/**
 * Stryker Mutation Testing Configuration
 *
 * Phase 4 Testing Excellence: P3-2 Mutation Testing
 *
 * Run with: npx stryker run
 *
 * Target mutation score: >70% for critical modules
 * @see docs/reports/TEST_OPTIMIZATION_RESEARCH_REPORT.md
 */

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
module.exports = {
  packageManager: 'npm',
  reporters: ['html', 'progress', 'dashboard'],
  testRunner: 'jest',
  coverageAnalysis: 'perTest',

  // Target critical financial calculation modules
  mutate: [
    'shared/core/src/components/price-calculator.ts',
    'shared/core/src/components/arbitrage-detector.ts',
    'shared/security/src/rate-limiter.ts',
    'shared/security/src/validation.ts',
    // Exclude types and test files
    '!**/*.test.ts',
    '!**/*.spec.ts',
    '!**/__tests__/**',
    '!**/dist/**',
  ],

  // Jest configuration
  jest: {
    configFile: 'jest.config.js',
    projectType: 'custom',
    config: {
      testMatch: [
        '**/__tests__/unit/**/*.test.ts',
      ],
    },
  },

  // TypeScript support
  checkers: ['typescript'],
  tsconfigFile: 'tsconfig.json',

  // Mutation operators to use
  mutator: {
    excludedMutations: [
      // Skip string mutations (log messages, error messages)
      'StringLiteral',
      // Skip object literal mutations (configuration objects)
      'ObjectLiteral',
    ],
  },

  // Thresholds for mutation testing
  thresholds: {
    high: 80,    // Green: mutation score >= 80%
    low: 60,     // Yellow: mutation score >= 60%
    break: 50,   // Fail build if mutation score < 50%
  },

  // Performance settings
  concurrency: 4,
  timeoutMS: 60000,
  timeoutFactor: 2.5,

  // Incremental testing (faster re-runs)
  incremental: true,
  incrementalFile: '.stryker-incremental.json',

  // Logging
  logLevel: 'info',

  // HTML report location
  htmlReporter: {
    baseDir: 'reports/mutation',
  },

  // Dashboard integration (optional - for CI)
  dashboard: {
    project: 'arbitrage-system',
    version: 'main',
    module: 'core',
    reportType: 'full',
  },
};
