module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // P1-001 FIX: Include both src and root __tests__ directories
  roots: ['<rootDir>/src', '<rootDir>/__tests__'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/?(*.)+(spec|test).ts'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  // FIX: Add moduleNameMapper for workspace packages
  moduleNameMapper: {
    '^@arbitrage/core$': '<rootDir>/../../shared/core/src/index.ts',
    '^@arbitrage/types$': '<rootDir>/../../shared/types/index.ts',
    '^@arbitrage/config$': '<rootDir>/../../shared/config/index.ts',
    '^@shared/security$': '<rootDir>/../../shared/security/src/index.ts',
    '^@shared/security/(.*)$': '<rootDir>/../../shared/security/src/$1',
  },
  setupFilesAfterEnv: ['<rootDir>/src/setupTests.ts'],
  testTimeout: 10000,
};