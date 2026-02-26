module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // P1-001 FIX: Include both src and root __tests__ directories
  roots: ['<rootDir>/src', '<rootDir>/__tests__'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/?(*.)+(spec|test).ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../../tsconfig.test.json' }],
  },
  // FIX: Add moduleNameMapper for workspace packages
  moduleNameMapper: {
    '^@arbitrage/core$': '<rootDir>/../../shared/core/src/index.ts',
    '^@arbitrage/core/(.*)$': '<rootDir>/../../shared/core/src/$1',
    '^@arbitrage/types$': '<rootDir>/../../shared/types/index.ts',
    '^@arbitrage/config$': '<rootDir>/../../shared/config/index.ts',
    '^@arbitrage/security$': '<rootDir>/../../shared/security/src/index.ts',
    '^@arbitrage/security/(.*)$': '<rootDir>/../../shared/security/src/$1',
    '^@arbitrage/test-utils$': '<rootDir>/../../shared/test-utils/src',
    '^@arbitrage/test-utils/(.*)$': '<rootDir>/../../shared/test-utils/src/$1',
  },
  setupFilesAfterEnv: ['<rootDir>/src/setupTests.ts'],
  testTimeout: 10000,
};