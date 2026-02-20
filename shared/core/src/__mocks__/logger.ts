/**
 * Jest auto-mock for shared/core/src/logger.ts
 *
 * When tests call `jest.mock('../../src/logger')` (without a factory function),
 * Jest automatically uses this file. Tests with explicit factory functions in
 * their jest.mock() call are NOT affected — the explicit factory takes precedence.
 *
 * IMPORTANT: createLogger and getPerformanceLogger are regular functions (not
 * jest.fn()) so that `resetMocks: true` in jest.config.base.js does NOT clear
 * their return values between tests. If you need to spy on calls, use
 * jest.spyOn() in your test.
 *
 * @see shared/core/src/logger.ts — Real implementation
 * @see Phase 2 Item 12 in .agent-reports/TEST_AUDIT_REPORT.md
 */

import { jest } from '@jest/globals';

const mockLogger = {
  fatal: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  child: jest.fn(),
};
mockLogger.child.mockReturnValue(mockLogger);

const mockPerformanceLogger = {
  logEventLatency: jest.fn(),
  logArbitrageOpportunity: jest.fn(),
  logHealthCheck: jest.fn(),
  logOpportunityDetection: jest.fn(),
  logExecutionResult: jest.fn(),
  logError: jest.fn(),
  logMetrics: jest.fn(),
  startTimer: jest.fn(() => jest.fn()),
  endTimer: jest.fn(() => 0),
};

/**
 * Use regular functions so resetMocks: true doesn't clear the return value.
 * The mockLogger/mockPerformanceLogger objects survive because their individual
 * methods (jest.fn()) get reset but the objects themselves remain valid.
 */
export function createLogger(_serviceName?: string) {
  // Re-establish child mock if cleared by resetMocks
  if (!mockLogger.child.getMockImplementation()) {
    mockLogger.child.mockImplementation(() => mockLogger);
  }
  return mockLogger;
}

export function getPerformanceLogger(..._args: unknown[]) {
  return mockPerformanceLogger;
}

/**
 * Access the mock logger instance for assertions in tests.
 * @example
 * import { __mockLogger } from '../../src/logger';
 * expect(__mockLogger.error).toHaveBeenCalledWith('something');
 */
export const __mockLogger = mockLogger;
export const __mockPerformanceLogger = mockPerformanceLogger;
