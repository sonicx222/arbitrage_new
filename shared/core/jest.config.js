/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/__tests__'],
  testMatch: [
    '**/*.test.ts',
    '**/*.spec.ts'
  ],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: false,
        tsconfig: 'tsconfig.test.json',
        diagnostics: {
          ignoreCodes: [151001]
        }
      }
    ]
  },
  // Module path mappings for workspace packages
  moduleNameMapper: {
    '^@arbitrage/core$': '<rootDir>/src',
    '^@arbitrage/core/(.*)$': '<rootDir>/src/$1',
    '^@arbitrage/test-utils$': '<rootDir>/../test-utils/src',
    '^@arbitrage/test-utils/(.*)$': '<rootDir>/../test-utils/src/$1',
    '^@arbitrage/config$': '<rootDir>/../config/src',
    '^@arbitrage/config/(.*)$': '<rootDir>/../config/src/$1',
    '^@arbitrage/types$': '<rootDir>/../types/src',
    '^@arbitrage/types/(.*)$': '<rootDir>/../types/src/$1',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!**/node_modules/**'
  ],
  coverageDirectory: 'coverage',
  testTimeout: 30000,
  maxWorkers: 2,
  moduleFileExtensions: ['ts', 'js', 'json'],
  clearMocks: true,
  setupFilesAfterEnv: ['<rootDir>/src/setup-tests.ts']
};
