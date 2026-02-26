/**
 * Jest Base Configuration
 *
 * Shared configuration for all Jest projects in the workspace.
 * Extend this in individual jest.config.js files.
 *
 * @see docs/TEST_ARCHITECTURE.md
 */

/**
 * Project-level configuration options
 * These options are valid inside project configurations
 *
 * Note: SWC transformer was considered for 10-20x faster compilation but
 * is incompatible with ts-jest's TypeScript-aware mocking features
 * (jest.mocked, mockImplementation on typed mocks). Keeping ts-jest.
 */
const projectConfig = {
  preset: 'ts-jest',
  testEnvironment: 'node',

  // Cache directory for transformed files — deterministic path for CI caching
  cacheDirectory: '<rootDir>/node_modules/.cache/jest',

  // Transform configuration — uses tsconfig.test.json for faster compilation
  // (no declarations/sourcemaps) and isolatedModules for transpile-only mode
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: 'tsconfig.test.json',
      diagnostics: {
        ignoreCodes: [151001]
      }
    }]
  },

  // Module resolution - maps package aliases to source directories
  moduleNameMapper: {
    '^@arbitrage/flash-loan-aggregation$': '<rootDir>/shared/flash-loan-aggregation/src',
    '^@arbitrage/flash-loan-aggregation/(.*)$': '<rootDir>/shared/flash-loan-aggregation/src/$1',
    '^@arbitrage/metrics$': '<rootDir>/shared/metrics/src',
    '^@arbitrage/metrics/(.*)$': '<rootDir>/shared/metrics/src/$1',
    '^@arbitrage/core$': '<rootDir>/shared/core/src',
    '^@arbitrage/core/(.*)$': '<rootDir>/shared/core/src/$1',
    '^@arbitrage/config$': '<rootDir>/shared/config/src',
    '^@arbitrage/config/(.*)$': '<rootDir>/shared/config/src/$1',
    '^@arbitrage/types$': '<rootDir>/shared/types',
    '^@arbitrage/types/(.*)$': '<rootDir>/shared/types/$1',
    '^@arbitrage/test-utils$': '<rootDir>/shared/test-utils/src',
    '^@arbitrage/test-utils/(.*)$': '<rootDir>/shared/test-utils/src/$1',
    '^@arbitrage/unified-detector$': '<rootDir>/services/unified-detector/src',
    '^@arbitrage/unified-detector/(.*)$': '<rootDir>/services/unified-detector/src/$1',
    '^@arbitrage/ml$': '<rootDir>/shared/ml/src',
    '^@arbitrage/ml/(.*)$': '<rootDir>/shared/ml/src/$1',
    '^@arbitrage/security$': '<rootDir>/shared/security/src',
    '^@arbitrage/security/(.*)$': '<rootDir>/shared/security/src/$1'
  },

  // Module file extensions
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],

  // Clear mocks between tests for isolation
  clearMocks: true,
  resetMocks: true,
  restoreMocks: true,

  // Error on deprecated features
  errorOnDeprecated: true,

  // Coverage configuration (valid in projects)
  collectCoverageFrom: [
    '**/*.ts',
    '!**/*.d.ts',
    '!**/node_modules/**',
    '!**/dist/**',
    '!**/__tests__/**',
    '!**/test-utils/**',
    '!**/*.test.ts',
    '!**/*.spec.ts'
  ]
};

/**
 * Root-level configuration options
 * These options are only valid at the root level, not inside project configurations
 */
const rootOnlyConfig = {
  // Default test timeout (30 seconds)
  testTimeout: 30000,

  coverageDirectory: '<rootDir>/coverage',
  coverageReporters: ['text', 'lcov', 'html', 'json-summary'],
  coverageThreshold: {
    global: {
      branches: 60,
      functions: 60,
      lines: 60,
      statements: 60
    }
  },

  // Verbose output for CI
  verbose: true,

  // Fail fast in CI
  bail: process.env.CI ? 1 : 0,

  // Reporter configuration
  reporters: [
    'default',
    ...(process.env.CI ? [['jest-junit', {
      outputDirectory: './coverage',
      outputName: 'junit.xml',
      suiteName: 'Arbitrage System Tests'
    }]] : [])
  ]
};

// Full config for standalone use (backward compatibility)
/** @type {import('jest').Config} */
const fullConfig = {
  ...projectConfig,
  ...rootOnlyConfig
};

// Attach projectConfig for use by jest.config.js projects
fullConfig.projectConfig = projectConfig;

module.exports = fullConfig;
