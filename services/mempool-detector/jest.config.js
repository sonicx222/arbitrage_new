module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/?(*.)+(spec|test).ts'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  // Module resolution - maps package aliases to source directories
  moduleNameMapper: {
    '^@arbitrage/core$': '<rootDir>/../../shared/core/src',
    '^@arbitrage/core/(.*)$': '<rootDir>/../../shared/core/src/$1',
    '^@arbitrage/config$': '<rootDir>/../../shared/config/src',
    '^@arbitrage/config/(.*)$': '<rootDir>/../../shared/config/src/$1',
    '^@arbitrage/types$': '<rootDir>/../../shared/types',
    '^@arbitrage/types/(.*)$': '<rootDir>/../../shared/types/$1',
  },
  setupFilesAfterEnv: ['<rootDir>/src/setupTests.ts'],
  testTimeout: 10000,
};
