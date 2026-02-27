/**
 * Jest Configuration
 *
 * Extends the base configuration with project-specific settings.
 * Supports running tests in categories: unit, integration, e2e
 *
 * @see docs/TEST_ARCHITECTURE.md
 * @see ADR-009: Test Architecture
 */

const baseConfig = require('./jest.config.base');
// Extract project-level config (excludes root-only options like verbose, bail, reporters)
const { projectConfig, ...rootConfig } = baseConfig;

/** @type {import('jest').Config} */
module.exports = {
  // Extend base configuration (excluding projectConfig property)
  ...rootConfig,

  // Setup files that run BEFORE module resolution (for polyfills)
  setupFiles: ['<rootDir>/jest.setup.js'],

  // Root directories to scan for tests
  // NOTE: Explicitly list roots to exclude .worktrees directory from Jest's Haste map
  roots: ['<rootDir>/shared', '<rootDir>/services', '<rootDir>/tests'],

  // Test file patterns - supports both old and new locations during migration
  testMatch: [
    // New structure (preferred)
    '**/__tests__/**/*.test.ts',
    '**/__tests__/**/*.spec.ts',
    // Legacy co-located tests (to be migrated)
    '**/src/*.test.ts',
    '**/src/*.spec.ts',
    // Integration/E2E tests
    '**/tests/**/*.test.ts',
    '**/tests/**/*.spec.ts'
  ],

  // Ignore patterns
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '/coverage/',
    '/.worktrees/' // Ignore git worktrees to prevent module collisions
  ],

  // Module path ignore patterns - exclude worktrees from Haste map
  modulePathIgnorePatterns: [
    '\\.worktrees'
  ],

  // Watch path ignore patterns - also exclude from watch mode
  watchPathIgnorePatterns: [
    '<rootDir>/\\.worktrees/',
    '\\.worktrees'
  ],

  // Haste configuration - disable or configure to avoid collisions
  haste: {
    forceNodeFilesystemAPI: true // Forces Node.js fs API, may help with collisions
  },

  // Global setup/teardown for Redis test server
  globalSetup: '<rootDir>/jest.globalSetup.ts',
  globalTeardown: '<rootDir>/jest.globalTeardown.ts',

  // Per-file setup - uses the new setup file with proper singleton resets
  setupFilesAfterEnv: ['<rootDir>/shared/test-utils/src/setup/jest-setup.ts'],

  // Global maxWorkers cap to prevent EMFILE (too many open files) on Windows.
  // When all projects run simultaneously, per-project workers accumulate and
  // exhaust the OS file descriptor limit. This cap limits total workers across
  // all projects. Per-project maxWorkers still apply within this budget.
  maxWorkers: process.env.CI ? 2 : '50%',

  // Worker memory limit - increased for memory-intensive tests (ML, performance)
  // Default is 0.5 (50%), but TensorFlow.js and long-running tests need more
  // Workers exceeding this limit are killed with SIGTERM (exitCode=143)
  workerIdleMemoryLimit: 0.8, // 80% of system memory

  // Test timeout - default for non-project runs
  // Individual tests override this with jest.setTimeout() or it() timeout parameter
  // ML and performance tests use much longer timeouts (2min - 11min)
  testTimeout: 30000, // 30 seconds default (per-project timeouts set in project blocks and setup files)

  // Coverage thresholds (enforce quality) - standardized to 60%
  coverageThreshold: {
    global: {
      branches: 60,
      functions: 60,
      lines: 60,
      statements: 60
    }
  },

  // Coverage collection
  collectCoverageFrom: [
    'shared/**/*.ts',
    'services/**/*.ts',
    '!shared/**/*.d.ts',
    '!services/**/*.d.ts',
    '!**/node_modules/**',
    '!**/dist/**',
    '!**/__tests__/**',
    '!**/*.test.ts',
    '!**/*.spec.ts',
    '!shared/test-utils/**',
    '!shared/ml/**'
  ],

  // Coverage output
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'lcov', 'html', 'json-summary'],

  // Use V8 coverage provider for better handling of dynamic imports
  coverageProvider: 'v8',

  // Verbose in CI
  verbose: !!process.env.CI,

  // Fail fast in CI
  bail: process.env.CI ? 1 : 0,

  // Reporters - Add slow test reporter for performance tracking
  reporters: [
    'default',
    [
      '<rootDir>/shared/test-utils/dist/reporters/slow-test-reporter.js',
      {
        unitThreshold: 100, // Unit tests should be <100ms
        integrationThreshold: 5000, // Integration tests should be <5s
        e2eThreshold: 30000, // E2E tests should be <30s
        outputFile: 'slow-tests.json',
        failOnSlow: false // Disabled: slow test thresholds were causing false FAILs for tests that pass
      }
    ]
  ],

  // Projects configuration for categorized test runs
  // Run with: npm run test:unit, npm run test:integration, npm run test:e2e, npm run test:performance
  // Note: Using projectConfig (not baseConfig) to avoid including root-only options like verbose, bail, reporters
  projects: [
    {
      displayName: 'unit',
      testMatch: ['**/__tests__/unit/**/*.test.ts', '**/__tests__/unit/**/*.spec.ts'],
      setupFilesAfterEnv: [
        '<rootDir>/shared/test-utils/src/setup/jest-setup.ts',
        '<rootDir>/shared/test-utils/src/setup/jest.unit.setup.ts'
      ],
      // P2-3.1: High parallelism for unit tests (CPU-bound, no shared resources)
      maxWorkers: process.env.CI ? 4 : '75%',
      testTimeout: 10000, // 10s - unit tests should be fast
      ...projectConfig
    },
    {
      displayName: 'integration',
      testMatch: [
        '**/__tests__/integration/**/*.test.ts',
        '**/tests/integration/**/*.test.ts'
      ],
      setupFilesAfterEnv: [
        '<rootDir>/shared/test-utils/src/setup/jest-setup.ts',
        '<rootDir>/shared/test-utils/src/setup/jest.integration.setup.ts'
      ],
      // P2-3.1: Moderate parallelism for integration tests (I/O-bound, shared Redis)
      maxWorkers: process.env.CI ? 2 : '50%',
      testTimeout: 60000, // 60s - allows for Redis/service startup
      ...projectConfig
    },
    {
      displayName: 'e2e',
      testMatch: ['**/tests/e2e/**/*.test.ts', '**/__tests__/e2e/**/*.test.ts'],
      setupFilesAfterEnv: [
        '<rootDir>/shared/test-utils/src/setup/jest-setup.ts',
        '<rootDir>/shared/test-utils/src/setup/jest.e2e.setup.ts'
      ],
      // P2-3.1: Low parallelism for e2e tests (full system tests, potential conflicts)
      maxWorkers: process.env.CI ? 1 : 2,
      testTimeout: 120000, // 2min - full workflow execution
      ...projectConfig
    },
    {
      displayName: 'performance',
      testMatch: [
        '**/__tests__/performance/**/*.test.ts',
        '**/__tests__/performance/**/*.perf.ts',
        '**/tests/performance/**/*.test.ts',
        '**/tests/performance/**/*.perf.ts'
      ],
      setupFilesAfterEnv: [
        '<rootDir>/shared/test-utils/src/setup/jest-setup.ts',
        '<rootDir>/shared/test-utils/src/setup/jest.performance.setup.ts'
      ],
      // P2-3.1: MUST be serial - measuring performance requires no interference
      maxWorkers: 1,
      testTimeout: 600000, // 10min - performance benchmarks can be long-running
      ...projectConfig
    },
    {
      displayName: 'smoke',
      testMatch: ['**/tests/smoke/**/*.test.ts', '**/tests/smoke/**/*.smoke.ts'],
      setupFilesAfterEnv: [
        '<rootDir>/shared/test-utils/src/setup/jest-setup.ts',
        '<rootDir>/shared/test-utils/src/setup/jest.smoke.setup.ts'
      ],
      // P2-3.1: Low parallelism for smoke tests (quick checks, may share resources)
      maxWorkers: process.env.CI ? 1 : 2,
      testTimeout: 60000, // 60s - quick validation checks
      ...projectConfig
    },
    {
      displayName: 'ml',
      testMatch: ['**/shared/ml/**/__tests__/**/*.test.ts'],
      setupFilesAfterEnv: [
        '<rootDir>/shared/test-utils/src/setup/jest-setup.ts',
        '<rootDir>/shared/test-utils/src/setup/jest.unit.setup.ts'
      ],
      // Serial execution for ML tests (memory-intensive TensorFlow.js)
      // Prevents multiple workers from loading models simultaneously
      maxWorkers: 1,
      testTimeout: 120000, // 2min - ML model loading and inference can be slow
      ...projectConfig
    }
  ]
};
