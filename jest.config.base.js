/**
 * Jest Base Configuration
 *
 * Shared configuration for all Jest projects in the workspace.
 * Extend this in individual jest.config.js files.
 *
 * @see docs/TEST_ARCHITECTURE.md
 */

/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',

  // Transform configuration
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: 'tsconfig.json',
      diagnostics: {
        ignoreCodes: [151001]
      }
    }]
  },

  // Module resolution - maps package aliases to source directories
  moduleNameMapper: {
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
    '^@shared/security$': '<rootDir>/shared/security/src',
    '^@shared/security/(.*)$': '<rootDir>/shared/security/src/$1'
  },

  // Module file extensions
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],

  // Default test timeout (30 seconds)
  testTimeout: 30000,

  // Clear mocks between tests for isolation
  clearMocks: true,
  resetMocks: true,
  restoreMocks: true,

  // Error on deprecated features
  errorOnDeprecated: true,

  // Coverage configuration
  collectCoverageFrom: [
    '**/*.ts',
    '!**/*.d.ts',
    '!**/node_modules/**',
    '!**/dist/**',
    '!**/__tests__/**',
    '!**/test-utils/**',
    '!**/*.test.ts',
    '!**/*.spec.ts'
  ],
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

  // Test isolation - run each test in separate process for full isolation
  // Note: Disabled by default for performance, enable for debugging
  // isolatedModules: true,

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
