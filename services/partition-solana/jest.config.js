/**
 * Jest Configuration for P4 Solana-Native Partition Service
 *
 * Tests Solana-specific arbitrage detection, pool management,
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
  testTimeout: 10000,
  // Clear mocks between tests for isolation
  clearMocks: true,
  resetMocks: true,
  restoreMocks: true,
};
