/**
 * Shared @arbitrage/core Mock Factory
 *
 * Provides a consistent, comprehensive mock shape for `jest.mock('@arbitrage/core')`.
 * Prevents silent `undefined` when a service starts using a new export from @arbitrage/core
 * that wasn't included in the test's mock factory.
 *
 * Usage:
 * ```ts
 * import { createCoreMockModule } from '@arbitrage/test-utils';
 *
 * jest.mock('@arbitrage/core', () => createCoreMockModule());
 *
 * // Or with overrides:
 * jest.mock('@arbitrage/core', () => createCoreMockModule({
 *   getRedisClient: jest.fn(() => Promise.resolve(myCustomRedis)),
 * }));
 * ```
 *
 * @see E16 finding from SERVICES_EXTENDED_ANALYSIS_2026-02-28
 */

import { jest } from '@jest/globals';
import { createMockRedisClient } from './mock-factories';

/**
 * Stream name constants matching @arbitrage/types RedisStreams.
 * Kept in sync with shared/types/src/events.ts.
 */
const MOCK_REDIS_STREAMS = {
  PRICE_UPDATES: 'stream:price-updates',
  SWAP_EVENTS: 'stream:swap-events',
  OPPORTUNITIES: 'stream:opportunities',
  WHALE_ALERTS: 'stream:whale-alerts',
  SERVICE_HEALTH: 'stream:service-health',
  SERVICE_EVENTS: 'stream:service-events',
  COORDINATOR_EVENTS: 'stream:coordinator-events',
  HEALTH: 'stream:health',
  HEALTH_ALERTS: 'stream:health-alerts',
  EXECUTION_REQUESTS: 'stream:execution-requests',
  EXECUTION_RESULTS: 'stream:execution-results',
  PENDING_OPPORTUNITIES: 'stream:pending-opportunities',
  VOLUME_AGGREGATES: 'stream:volume-aggregates',
  CIRCUIT_BREAKER: 'stream:circuit-breaker',
  SYSTEM_FAILOVER: 'stream:system-failover',
  SYSTEM_COMMANDS: 'stream:system-commands',
  SYSTEM_FAILURES: 'stream:system-failures',
  SYSTEM_CONTROL: 'stream:system-control',
  SYSTEM_SCALING: 'stream:system-scaling',
  FAST_LANE: 'stream:fast-lane',
  DEAD_LETTER_QUEUE: 'stream:dead-letter-queue',
  DLQ_ALERTS: 'stream:dlq-alerts',
  FORWARDING_DLQ: 'stream:forwarding-dlq',
} as const;

/**
 * Creates a mock logger matching the Logger interface.
 * Each method is a jest.fn() for assertion and call tracking.
 */
function createMockLoggerInstance() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

/**
 * Creates a mock PerformanceLogger matching the PerformanceLogger interface.
 */
function createMockPerfLoggerInstance() {
  return {
    startTimer: jest.fn(() => ({ stop: jest.fn() })),
    recordMetric: jest.fn(),
    logEventLatency: jest.fn(),
    logExecutionResult: jest.fn(),
    logHealthCheck: jest.fn(),
    logOpportunityDetection: jest.fn(),
  };
}

/**
 * Creates a mock RedisStreamsClient instance.
 */
function createMockStreamsClientInstance() {
  return {
    connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    disconnect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    xadd: jest.fn<() => Promise<string>>().mockResolvedValue('1-0'),
    xread: jest.fn<() => Promise<null>>().mockResolvedValue(null),
    xreadgroup: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
    xack: jest.fn<() => Promise<number>>().mockResolvedValue(1),
    createConsumerGroup: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    createBatcher: jest.fn().mockReturnValue({
      add: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      flush: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      getStats: jest.fn().mockReturnValue({ queued: 0, flushed: 0, errors: 0 }),
      destroy: jest.fn(),
    }),
    checkStreamLag: jest.fn<() => Promise<{ length: number; maxLen: number; lagRatio: number; critical: boolean; pendingCount: number; pendingRatio: number }>>()
      .mockResolvedValue({ length: 0, maxLen: 5000, lagRatio: 0, critical: false, pendingCount: 0, pendingRatio: 0 }),
    getXaddCircuitBreakerStatus: jest.fn().mockReturnValue({ failures: 0, isOpen: false, lastFailure: 0, threshold: 5, resetTimeoutMs: 30000 }),
    getClient: jest.fn().mockReturnValue(createMockRedisClient()),
  };
}

/**
 * Creates a comprehensive mock module for `@arbitrage/core`.
 *
 * Covers the union of all exports commonly imported across services:
 * - Logging: createLogger, getPerformanceLogger, Logger
 * - Redis: getRedisClient, resetRedisInstance, RedisStreamsClient, getRedisStreamsClient
 * - WebSocket: WebSocketManager
 * - Utilities: IntervalManager, getErrorMessage, TradeLogger, getNonceManager
 * - Singleton management: notifySingletonAccess, isSingletonDirty, clearSingletonDirty
 *
 * Override any export by passing it in the overrides parameter.
 *
 * @param overrides - Partial record of exports to override
 * @returns Mock module object suitable for jest.mock('@arbitrage/core', () => ...)
 */
export function createCoreMockModule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const mockLogger = createMockLoggerInstance();
  const mockPerfLogger = createMockPerfLoggerInstance();
  const mockRedisClient = createMockRedisClient();
  const mockStreamsClient = createMockStreamsClientInstance();

  return {
    // =========================================================================
    // Logging
    // =========================================================================
    createLogger: jest.fn(() => mockLogger),
    getPerformanceLogger: jest.fn(() => mockPerfLogger),
    Logger: jest.fn(),
    createPinoLogger: jest.fn(() => mockLogger),
    getLogger: jest.fn(() => mockLogger),
    getPinoPerformanceLogger: jest.fn(() => mockPerfLogger),
    PerformanceLogger: jest.fn(() => mockPerfLogger),
    resetLoggerCache: jest.fn(),
    resetPerformanceLoggerCache: jest.fn(),

    // =========================================================================
    // Redis Core
    // =========================================================================
    getRedisClient: jest.fn<() => Promise<unknown>>().mockResolvedValue(mockRedisClient),
    resetRedisInstance: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    RedisClient: jest.fn(),
    RedisOperationError: class MockRedisOperationError extends Error {},

    // =========================================================================
    // Redis Streams
    // =========================================================================
    RedisStreamsClient: Object.assign(
      jest.fn(() => mockStreamsClient),
      { STREAMS: MOCK_REDIS_STREAMS },
    ),
    getRedisStreamsClient: jest.fn<() => Promise<unknown>>().mockResolvedValue(mockStreamsClient),
    resetRedisStreamsInstance: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    StreamBatcher: jest.fn(),
    StreamConsumer: jest.fn(),
    unwrapBatchMessages: jest.fn((msgs: unknown[]) => msgs),

    // =========================================================================
    // WebSocket
    // =========================================================================
    WebSocketManager: jest.fn().mockImplementation(() => ({
      connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      disconnect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      subscribe: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      on: jest.fn(),
      off: jest.fn(),
      removeAllListeners: jest.fn(),
      isConnected: jest.fn().mockReturnValue(false),
    })),

    // =========================================================================
    // Utilities
    // =========================================================================
    IntervalManager: jest.fn().mockImplementation(() => ({
      register: jest.fn(),
      clearAll: jest.fn(),
      getStats: jest.fn().mockReturnValue({}),
    })),
    getErrorMessage: jest.fn((err: unknown) =>
      err instanceof Error ? err.message : String(err ?? 'Unknown error'),
    ),
    TradeLogger: jest.fn().mockImplementation(() => ({
      logTrade: jest.fn(),
      close: jest.fn(),
    })),
    getNonceManager: jest.fn(() => ({
      acquireNonce: jest.fn<() => Promise<number>>().mockResolvedValue(0),
      releaseNonce: jest.fn(),
      resetNonce: jest.fn(),
    })),

    // =========================================================================
    // Singleton Management
    // =========================================================================
    notifySingletonAccess: jest.fn(),
    isSingletonDirty: jest.fn().mockReturnValue(false),
    clearSingletonDirty: jest.fn(),

    // =========================================================================
    // OTEL Tracing (no-op by default)
    // =========================================================================
    getOtelTransport: jest.fn().mockReturnValue(null),
    shutdownOtelTransport: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),

    // Apply overrides last (wins over defaults)
    ...overrides,
  };
}
