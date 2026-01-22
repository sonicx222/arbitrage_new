/**
 * Jest Configuration for P1 Asia-Fast Partition Service
 *
 * Tests partition-specific configuration, health endpoints,
 * and service lifecycle.
 */

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/?(*.)+(spec|test).ts'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  // Module resolution for workspace packages
  moduleNameMapper: {
    '^@arbitrage/core$': '<rootDir>/../../shared/core/src/index.ts',
    '^@arbitrage/types$': '<rootDir>/../../shared/types/index.ts',
    '^@arbitrage/config$': '<rootDir>/../../shared/config/src/index.ts',
    '^@arbitrage/unified-detector$': '<rootDir>/../unified-detector/src/index.ts',
  },
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/setupTests.ts'],
  testTimeout: 10000,
  // Clear mocks between tests for isolation
  clearMocks: true,
  resetMocks: true,
  restoreMocks: true,
};
