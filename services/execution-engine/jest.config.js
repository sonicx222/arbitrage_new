module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/__tests__'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/?(*.)+(spec|test).ts'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  // Module resolution for workspace packages
  moduleNameMapper: {
    '^@arbitrage/core$': '<rootDir>/../../shared/core/src',
    '^@arbitrage/core/(.*)$': '<rootDir>/../../shared/core/src/$1',
    '^@arbitrage/config$': '<rootDir>/../../shared/config/src',
    '^@arbitrage/config/(.*)$': '<rootDir>/../../shared/config/src/$1',
    '^@arbitrage/types$': '<rootDir>/../../shared/types',
    '^@arbitrage/types/(.*)$': '<rootDir>/../../shared/types/$1',
    '^@arbitrage/test-utils$': '<rootDir>/../../shared/test-utils/src',
    '^@arbitrage/test-utils/(.*)$': '<rootDir>/../../shared/test-utils/src/$1',
    '^@arbitrage/flash-loan-aggregation$': '<rootDir>/../../shared/flash-loan-aggregation/src',
    '^@arbitrage/flash-loan-aggregation/(.*)$': '<rootDir>/../../shared/flash-loan-aggregation/src/$1',
    '^@arbitrage/metrics$': '<rootDir>/../../shared/metrics/src',
    '^@arbitrage/metrics/(.*)$': '<rootDir>/../../shared/metrics/src/$1',
  },
  setupFilesAfterEnv: ['<rootDir>/src/setupTests.ts'],
  testTimeout: 10000,
};