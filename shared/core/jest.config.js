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
        diagnostics: {
          ignoreCodes: [151001]
        }
      }
    ]
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
