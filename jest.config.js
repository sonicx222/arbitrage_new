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

  // Parallelization
  maxWorkers: process.env.CI ? 2 : '50%',

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

  // Projects configuration for categorized test runs
  // Run with: npm run test:unit, npm run test:integration, npm run test:e2e, npm run test:performance
  // Note: Using projectConfig (not baseConfig) to avoid including root-only options like verbose, bail, reporters
  projects: [
    {
      displayName: 'unit',
      testMatch: ['**/__tests__/unit/**/*.test.ts', '**/__tests__/unit/**/*.spec.ts'],
      testTimeout: 10000,
      ...projectConfig
    },
    {
      displayName: 'integration',
      testMatch: [
        '**/__tests__/integration/**/*.test.ts',
        '**/tests/integration/**/*.test.ts'
      ],
      testTimeout: 60000,
      ...projectConfig
    },
    {
      displayName: 'e2e',
      testMatch: ['**/tests/e2e/**/*.test.ts'],
      testTimeout: 120000,
      ...projectConfig
    },
    {
      displayName: 'performance',
      testMatch: ['**/tests/performance/**/*.test.ts', '**/tests/performance/**/*.perf.ts'],
      testTimeout: 300000,
      ...projectConfig
    },
    {
      displayName: 'smoke',
      testMatch: ['**/tests/smoke/**/*.test.ts', '**/tests/smoke/**/*.smoke.ts'],
      testTimeout: 30000,
      ...projectConfig
    }
  ]
};
