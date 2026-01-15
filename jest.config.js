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

/** @type {import('jest').Config} */
module.exports = {
  // Extend base configuration
  ...baseConfig,

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

  // Per-file setup - note: using new setup file when ready
  // During migration, keep using the legacy setup for backward compatibility
  setupFilesAfterEnv: ['<rootDir>/shared/test-utils/src/index.ts'],
  // After migration complete, switch to:
  // setupFilesAfterEnv: ['<rootDir>/shared/test-utils/src/setup/jest-setup.ts'],

  // Parallelization
  maxWorkers: process.env.CI ? 2 : '50%',

  // Test timeout
  testTimeout: 30000,

  // Coverage thresholds (enforce quality)
  coverageThreshold: {
    global: {
      branches: 50,
      functions: 50,
      lines: 50,
      statements: 50
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

  // Verbose in CI
  verbose: !!process.env.CI,

  // Fail fast in CI
  bail: process.env.CI ? 1 : 0,

  // Projects configuration for categorized test runs
  // Enable these for targeted test runs: npm run test:unit, npm run test:integration
  // Note: Uncomment when migration is complete
  /*
  projects: [
    {
      displayName: 'unit',
      testMatch: ['**\/__tests__\/unit\/**\/*.test.ts'],
      testTimeout: 10000,
      ...baseConfig
    },
    {
      displayName: 'integration',
      testMatch: [
        '**\/__tests__\/integration\/**\/*.test.ts',
        '*\/tests\/integration\/**\/*.test.ts'
      ],
      testTimeout: 60000,
      ...baseConfig
    },
    {
      displayName: 'e2e',
      testMatch: ['*\/tests\/e2e\/**\/*.test.ts'],
      testTimeout: 120000,
      ...baseConfig
    }
  ]
  */
};
