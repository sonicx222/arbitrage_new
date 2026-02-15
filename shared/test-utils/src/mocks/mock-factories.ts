/**
 * Shared Mock Factories
 *
 * Generic mock factories used across multiple test suites.
 * For partition-specific mocks (createMockLogger, createMockStateManager),
 * see partition-service.mock.ts.
 * For the full stateful RedisMock (with in-memory data stores),
 * see redis.mock.ts.
 *
 * @see shared/test-utils/src/mocks/partition-service.mock.ts
 * @see shared/test-utils/src/mocks/redis.mock.ts
 */

import { jest } from '@jest/globals';

/**
 * Lightweight MockRedisClient type for unit tests.
 *
 * Use this when you just need jest.fn() stubs for Redis methods (most unit tests).
 * For integration tests needing stateful Redis behavior, use createRedisMock() from redis.mock.ts.
 */
export interface MockRedisClient {
  get: jest.Mock;
  set: jest.Mock;
  setex: jest.Mock;
  del: jest.Mock;
  exists: jest.Mock;
  expire: jest.Mock;
  keys: jest.Mock;
  ping: jest.Mock;
  disconnect: jest.Mock;
  quit: jest.Mock;
  setNx: jest.Mock;
  eval: jest.Mock;
  hset: jest.Mock;
  hget: jest.Mock;
  hgetall: jest.Mock;
  xadd: jest.Mock;
  xread: jest.Mock;
  xreadgroup: jest.Mock;
  xack: jest.Mock;
  publish: jest.Mock;
  subscribe: jest.Mock;
  unsubscribe: jest.Mock;
  on: jest.Mock;
  removeListener: jest.Mock;
  removeAllListeners: jest.Mock;
  scan: jest.Mock;
  sadd: jest.Mock;
  smembers: jest.Mock;
}

/**
 * Creates a lightweight mock Redis client with jest.fn() stubs.
 *
 * Covers the union of all methods used across inline MockRedisClient definitions
 * in the codebase. Each method returns a jest.fn() that resolves to a sensible default.
 *
 * Override individual methods in your test's beforeEach() or in specific test cases:
 * ```ts
 * const redis = createMockRedisClient();
 * (redis.get as jest.Mock).mockResolvedValue('cached-value');
 * ```
 *
 * For tests needing stateful behavior (e.g., set then get returns the value),
 * use createRedisMock() from redis.mock.ts instead.
 *
 * @see ADR-009: Centralized test mocks
 */
export function createMockRedisClient(): MockRedisClient {
  return {
    get: jest.fn<() => Promise<string | null>>().mockResolvedValue(null),
    set: jest.fn<() => Promise<string>>().mockResolvedValue('OK'),
    setex: jest.fn<() => Promise<string>>().mockResolvedValue('OK'),
    del: jest.fn<() => Promise<number>>().mockResolvedValue(1),
    exists: jest.fn<() => Promise<number>>().mockResolvedValue(0),
    expire: jest.fn<() => Promise<number>>().mockResolvedValue(1),
    keys: jest.fn<() => Promise<string[]>>().mockResolvedValue([]),
    ping: jest.fn<() => Promise<string>>().mockResolvedValue('PONG'),
    disconnect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    quit: jest.fn<() => Promise<string>>().mockResolvedValue('OK'),
    setNx: jest.fn<() => Promise<number>>().mockResolvedValue(1),
    eval: jest.fn<() => Promise<unknown>>().mockResolvedValue(null),
    hset: jest.fn<() => Promise<number>>().mockResolvedValue(1),
    hget: jest.fn<() => Promise<string | null>>().mockResolvedValue(null),
    hgetall: jest.fn<() => Promise<Record<string, string>>>().mockResolvedValue({}),
    xadd: jest.fn<() => Promise<string>>().mockResolvedValue('1-0'),
    xread: jest.fn<() => Promise<unknown>>().mockResolvedValue(null),
    xreadgroup: jest.fn<() => Promise<unknown>>().mockResolvedValue(null),
    xack: jest.fn<() => Promise<number>>().mockResolvedValue(1),
    publish: jest.fn<() => Promise<number>>().mockResolvedValue(0),
    subscribe: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    unsubscribe: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    on: jest.fn().mockReturnThis(),
    removeListener: jest.fn().mockReturnThis(),
    removeAllListeners: jest.fn().mockReturnThis(),
    scan: jest.fn<() => Promise<[string, string[]]>>().mockResolvedValue(['0', []]),
    sadd: jest.fn<() => Promise<number>>().mockResolvedValue(1),
    smembers: jest.fn<() => Promise<string[]>>().mockResolvedValue([]),
  };
}

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
