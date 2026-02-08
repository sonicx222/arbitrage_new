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

  // Root directories to scan for tests
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
    '/coverage/'
  ],

  // Global setup/teardown for Redis test server
  globalSetup: '<rootDir>/jest.globalSetup.ts',
  globalTeardown: '<rootDir>/jest.globalTeardown.ts',

  // Per-file setup - uses the new setup file with proper singleton resets
  setupFilesAfterEnv: ['<rootDir>/shared/test-utils/src/setup/jest-setup.ts'],

  // P2-3.1: Removed global maxWorkers - now configured per-project for optimal performance
  // Different test types have different parallelization needs:
  // - Unit tests: High parallelism (CPU-bound, no shared resources)
  // - Integration tests: Moderate (I/O-bound, shared Redis)
  // - Performance tests: Serial only (measuring performance)
  // maxWorkers: process.env.CI ? 2 : '50%',  // REMOVED - now per-project

  // Worker memory limit - increased for memory-intensive tests (ML, performance)
  // Default is 0.5 (50%), but TensorFlow.js and long-running tests need more
  // Workers exceeding this limit are killed with SIGTERM (exitCode=143)
  workerIdleMemoryLimit: 0.8, // 80% of system memory

  // Test timeout - default for non-project runs (projects override this)
  // Matches unit test timeout for consistency
  testTimeout: 10000,

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
      '<rootDir>/shared/test-utils/src/reporters/slow-test-reporter.js',
      {
        unitThreshold: 100, // Unit tests should be <100ms
        integrationThreshold: 5000, // Integration tests should be <5s
        e2eThreshold: 30000, // E2E tests should be <30s
        outputFile: 'slow-tests.json',
        failOnSlow: false // Don't fail CI yet - just report (set to true later if desired)
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
      // Longer timeout for performance tests (some run 10+ minutes)
      testTimeout: 700000, // ~11 minutes (handles 650000ms tests + buffer)
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
      // Longer timeout for TensorFlow.js initialization and training
      testTimeout: 120000, // 2 minutes
      ...projectConfig
    }
  ]
};
