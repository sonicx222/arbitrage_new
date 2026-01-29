/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: [
    '**/*.test.ts',
    '**/*.spec.ts'
  ],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: false,
        tsconfig: '<rootDir>/tsconfig.json',
        diagnostics: {
          ignoreCodes: [151001]
        }
      }
    ]
  },
  moduleNameMapper: {
    '^@arbitrage/test-utils$': '<rootDir>/src',
    '^@arbitrage/test-utils/(.*)$': '<rootDir>/src/$1',
    '^@arbitrage/config$': '<rootDir>/../config/src',
    '^@arbitrage/config/(.*)$': '<rootDir>/../config/src/$1',
    '^@arbitrage/types$': '<rootDir>/../types',
    '^@arbitrage/types/(.*)$': '<rootDir>/../types/$1',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/*.test.ts',
    '!**/node_modules/**'
  ],
  coverageDirectory: 'coverage',
  testTimeout: 10000,
  maxWorkers: 2,
  moduleFileExtensions: ['ts', 'js', 'json'],
  clearMocks: true,
};
