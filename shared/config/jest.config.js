/**
 * Jest Configuration for @arbitrage/config
 *
 * Extends the base configuration for shared/config package tests.
 */

const baseConfig = require('../../jest.config.base');

/** @type {import('jest').Config} */
module.exports = {
  ...baseConfig,

  // Root is this directory
  rootDir: '.',

  // Test files are co-located in src/
  testMatch: ['<rootDir>/src/**/*.test.ts'],

  // Transform configuration with test-specific tsconfig
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: '<rootDir>/tsconfig.test.json',
      diagnostics: {
        ignoreCodes: [151001]
      }
    }]
  },

  // Module name mapper for package aliases
  moduleNameMapper: {
    '^@arbitrage/types$': '<rootDir>/../types',
    '^@arbitrage/types/(.*)$': '<rootDir>/../types/$1'
  },

  // Shorter timeout for unit tests
  testTimeout: 10000
};
