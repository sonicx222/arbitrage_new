module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/__tests__'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/?(*.)+(spec|test).ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../../tsconfig.test.json' }],
  },
  // Module resolution - maps package aliases to source directories (from base config)
  moduleNameMapper: {
    '^@arbitrage/core$': '<rootDir>/../../shared/core/src',
    '^@arbitrage/core/(.*)$': '<rootDir>/../../shared/core/src/$1',
    '^@arbitrage/config$': '<rootDir>/../../shared/config/src',
    '^@arbitrage/config/(.*)$': '<rootDir>/../../shared/config/src/$1',
    '^@arbitrage/types$': '<rootDir>/../../shared/types',
    '^@arbitrage/types/(.*)$': '<rootDir>/../../shared/types/$1',
    '^@arbitrage/ml$': '<rootDir>/../../shared/ml/src',
    '^@arbitrage/ml/(.*)$': '<rootDir>/../../shared/ml/src/$1',
    '^@arbitrage/test-utils$': '<rootDir>/../../shared/test-utils/src',
    '^@arbitrage/test-utils/(.*)$': '<rootDir>/../../shared/test-utils/src/$1',
  },
  setupFilesAfterEnv: ['<rootDir>/src/setupTests.ts'],
  testTimeout: 10000,
};