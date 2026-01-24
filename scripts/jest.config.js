/**
 * Jest Configuration for Scripts
 *
 * Configuration for testing JavaScript utility scripts in the scripts/ directory.
 *
 * @see Task 1.1: Deprecation Warning System
 */

/** @type {import('jest').Config} */
module.exports = {
  displayName: 'scripts',
  testEnvironment: 'node',

  // Test file patterns
  testMatch: [
    '**/scripts/**/__tests__/**/*.test.js',
    '**/scripts/**/__tests__/**/*.spec.js'
  ],

  // Module directories
  moduleDirectories: ['node_modules', 'scripts/lib'],

  // Ignore patterns
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/'
  ],

  // Test timeout
  testTimeout: 10000,

  // Coverage
  collectCoverageFrom: [
    'scripts/lib/**/*.js',
    '!scripts/lib/__tests__/**'
  ],

  // Verbose output
  verbose: true,

  // Clear mocks between tests
  clearMocks: true,

  // Restore mocks after each test
  restoreMocks: true
};
