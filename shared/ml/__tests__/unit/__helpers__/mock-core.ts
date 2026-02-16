/**
 * P3-4: Shared @arbitrage/core mock for ML test files.
 *
 * Provides a reusable logger mock that matches the real createLogger API.
 * Use in jest.mock() factory functions to reduce duplication across test files.
 */

import { jest } from '@jest/globals';

/**
 * Create a mock logger matching the @arbitrage/core createLogger interface.
 */
export function createMockLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

/**
 * Mock factory for @arbitrage/core.
 * Use: jest.mock('@arbitrage/core', () => createCoreMock())
 */
export function createCoreMock() {
  return {
    createLogger: jest.fn(() => createMockLogger()),
  };
}
