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
    '^@arbitrage/ml$': '<rootDir>/src',
    '^@arbitrage/ml/(.*)$': '<rootDir>/src/$1',
    '^@arbitrage/core$': '<rootDir>/../core/src',
    '^@arbitrage/core/(.*)$': '<rootDir>/../core/src/$1',
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
  clearMocks: true
};
