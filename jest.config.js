module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/shared', '<rootDir>/services', '<rootDir>/tests'],
  testMatch: [
    '**/__tests__/**/*.test.ts',
    '**/__tests__/**/*.spec.ts',
    '**/*.test.ts',
    '**/*.spec.ts'
  ],
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: 'tsconfig.json'
    }],
  },
  moduleNameMapper: {
    '^@arbitrage/core$': '<rootDir>/shared/core/src',
    '^@arbitrage/core/(.*)$': '<rootDir>/shared/core/src/$1',
    '^@arbitrage/config$': '<rootDir>/shared/config/src',
    '^@arbitrage/config/(.*)$': '<rootDir>/shared/config/src/$1',
    '^@arbitrage/types$': '<rootDir>/shared/types',
    '^@arbitrage/types/(.*)$': '<rootDir>/shared/types/$1',
    '^@arbitrage/unified-detector$': '<rootDir>/services/unified-detector/src',
    '^@arbitrage/unified-detector/(.*)$': '<rootDir>/services/unified-detector/src/$1'
  },
  collectCoverageFrom: [
    'shared/**/*.ts',
    'services/**/*.ts',
    '!shared/**/*.d.ts',
    '!services/**/*.d.ts',
    '!**/node_modules/**',
    '!**/dist/**'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  globalSetup: '<rootDir>/jest.globalSetup.ts',
  globalTeardown: '<rootDir>/jest.globalTeardown.ts',
  setupFilesAfterEnv: ['<rootDir>/shared/test-utils/src/index.ts'],
  testTimeout: 30000,
  maxWorkers: 4
};