/**
 * Jest auto-mock for shared/core/src/logger.ts
 *
 * When tests call `jest.mock('../../src/logger')` (without a factory function),
 * Jest automatically uses this file. Tests with explicit factory functions in
 * their jest.mock() call are NOT affected — the explicit factory takes precedence.
 *
 * This eliminates ~15-20 lines of boilerplate per test file that previously
 * inlined the same mock factory.
 *
 * @example
 * // Before (15+ lines per file):
 * jest.mock('../../src/logger', () => ({
 *   createLogger: jest.fn(() => ({ info: jest.fn(), ... })),
 *   getPerformanceLogger: jest.fn(() => ({ ... })),
 * }));
 *
 * // After (1 line):
 * jest.mock('../../src/logger');
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
};

export const createLogger = jest.fn(() => mockLogger);
export const getPerformanceLogger = jest.fn(() => mockPerformanceLogger);

/**
 * Access the mock logger instance for assertions in tests.
 * @example
 * import { __mockLogger } from '../../src/logger';
 * expect(__mockLogger.error).toHaveBeenCalledWith('something');
 */
export const __mockLogger = mockLogger;
export const __mockPerformanceLogger = mockPerformanceLogger;
