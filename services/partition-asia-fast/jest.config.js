/**
 * Jest Configuration for P1 Asia-Fast Partition Service
 *
 * Tests partition-specific configuration, health endpoints,
 * and service lifecycle.
 */

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/__tests__'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/?(*.)+(spec|test).ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../../tsconfig.test.json' }],
  },
  // Module resolution for workspace packages
  moduleNameMapper: {
    '^@arbitrage/core$': '<rootDir>/../../shared/core/src/index.ts',
    '^@arbitrage/core/(.*)$': '<rootDir>/../../shared/core/src/$1',
    '^@arbitrage/types$': '<rootDir>/../../shared/types/index.ts',
    '^@arbitrage/config$': '<rootDir>/../../shared/config/src/index.ts',
    '^@arbitrage/unified-detector$': '<rootDir>/../unified-detector/src/index.ts',
    '^@arbitrage/test-utils/(.*)$': '<rootDir>/../../shared/test-utils/src/$1',
  },
  setupFilesAfterEnv: ['<rootDir>/__tests__/setupTests.ts'],
  testTimeout: 10000,
  // Clear mocks between tests for isolation
  clearMocks: true,
  resetMocks: true,
  restoreMocks: true,
};
