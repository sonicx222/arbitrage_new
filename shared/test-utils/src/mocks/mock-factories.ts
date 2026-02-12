/**
 * Shared Mock Factories
 *
 * Generic mock factories used across multiple test suites.
 * For partition-specific mocks (createMockLogger, createMockStateManager),
 * see partition-service.mock.ts.
 *
 * @see shared/test-utils/src/mocks/partition-service.mock.ts
 */

import { jest } from '@jest/globals';

/**
 * Creates a mock PerformanceLogger for services that track metrics.
 *
 * Used by execution-engine, cross-chain-detector, coordinator, unified-detector,
 * and solana-detector test suites.
 */
export function createMockPerfLogger() {
  return {
    logEventLatency: jest.fn(),
    logExecutionResult: jest.fn(),
    logHealthCheck: jest.fn(),
    logOpportunityDetection: jest.fn(),
  };
}

/**
 * Creates a mock StateManager for execution-engine services.
 *
 * This is a richer interface than the partition StateManager (which only has
 * executeStart, executeStop, isRunning, getState). The execution-engine
 * variant adds transition, isTransitioning, waitForIdle, on, off, canTransition.
 *
 * @see createMockStateManager in partition-service.mock.ts for the simpler variant
 */
export function createMockExecutionStateManager() {
  return {
    getState: jest.fn(() => 'idle'),
    executeStart: jest.fn((fn: () => Promise<void>) => fn()),
    executeStop: jest.fn((fn: () => Promise<void>) => fn()),
    transition: jest.fn(() => Promise.resolve({ success: true })),
    isTransitioning: jest.fn(() => false),
    isRunning: jest.fn(() => false),
    waitForIdle: jest.fn(() => Promise.resolve()),
    on: jest.fn(),
    off: jest.fn(),
    canTransition: jest.fn(() => true),
  };
}
