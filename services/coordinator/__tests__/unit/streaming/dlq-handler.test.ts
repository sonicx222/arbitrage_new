/**
 * L-14: DLQ Handler Tests
 *
 * Tests for the DLQ message handling and error classification in coordinator.ts.
 * Since classifyDlqError is a module-private function, it is tested indirectly
 * through the coordinator's handleDlqMessage method.
 *
 * Uses plain functions (not jest.fn) in mock factories to survive
 * the global resetMocks: true config.
 *
 * @see services/coordinator/src/coordinator.ts (classifyDlqError, handleDlqMessage)
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Set required environment variables BEFORE any config imports
process.env.NODE_ENV = 'test';
process.env.ETHEREUM_RPC_URL = 'https://eth.llamarpc.com';
process.env.ETHEREUM_WS_URL = 'wss://eth.llamarpc.com';
process.env.BSC_RPC_URL = 'https://bsc-dataseed.binance.org';
process.env.BSC_WS_URL = 'wss://bsc-dataseed.binance.org';
process.env.POLYGON_RPC_URL = 'https://polygon-rpc.com';
process.env.POLYGON_WS_URL = 'wss://polygon-rpc.com';
process.env.ARBITRUM_RPC_URL = 'https://arb1.arbitrum.io/rpc';
process.env.ARBITRUM_WS_URL = 'wss://arb1.arbitrum.io/rpc';
process.env.OPTIMISM_RPC_URL = 'https://mainnet.optimism.io';
process.env.OPTIMISM_WS_URL = 'wss://mainnet.optimism.io';
process.env.BASE_RPC_URL = 'https://mainnet.base.org';
process.env.BASE_WS_URL = 'wss://mainnet.base.org';
process.env.REDIS_URL = 'redis://localhost:6379';

// ============================================================================
// Stable mock helpers (plain functions survive resetMocks: true)
// ============================================================================
const noop = () => {};
const noopAsync = async () => {};
const noopMiddleware = (_req: any, _res: any, next: any) => next();

// Stable logger with jest.fn for warn (so we can assert on it)
// jest.fn survives resetMocks for top-level variables — it only gets cleared
// inside mock factory return values. Top-level jest.fn is re-applied each test.
const mockWarn = jest.fn();

const STREAMS_MAP = {
  HEALTH: 'stream:health', OPPORTUNITIES: 'stream:opportunities',
  WHALE_ALERTS: 'stream:whale-alerts', SWAP_EVENTS: 'stream:swap-events',
  VOLUME_AGGREGATES: 'stream:volume-aggregates', PRICE_UPDATES: 'stream:price-updates',
  EXECUTION_REQUESTS: 'stream:execution-requests',
  DEAD_LETTER_QUEUE: 'stream:dead-letter-queue',
  FORWARDING_DLQ: 'stream:forwarding-dlq',
  EXECUTION_RESULTS: 'stream:execution-results',
};

const createMockRedisClient = () => ({
  setex: noop, get: noop, del: noop, set: noop,
  setNx: () => Promise.resolve(true), setnx: () => Promise.resolve(1),
  expire: noop, quit: noop, disconnect: noopAsync,
  getAllServiceHealth: () => Promise.resolve({}),
  renewLockIfOwned: () => Promise.resolve(true),
  releaseLockIfOwned: () => Promise.resolve(true),
});

const createMockStreamsClient = () => ({
  createConsumerGroup: noopAsync, readGroup: () => Promise.resolve([]),
  xreadgroup: () => Promise.resolve([]),
  xack: () => Promise.resolve(1), xadd: () => Promise.resolve('1234-0'),
  ack: noopAsync, disconnect: noopAsync,
  STREAMS: STREAMS_MAP,
});

// Logger that delegates warn to the top-level mockWarn for assertion
const createMockLogger = () => ({ info: noop, error: noop, warn: (...args: any[]) => mockWarn(...args), debug: noop });

function createMockStateManager() {
  const state = { running: false };
  return {
    getState: () => state.running ? 'running' : 'stopped',
    isRunning: () => state.running,
    isStopped: () => !state.running,
    executeStart: async (fn: any) => { await fn(); state.running = true; return { success: true, currentState: 'running' }; },
    executeStop: async (fn: any) => { await fn(); state.running = false; return { success: true, currentState: 'stopped' }; },
    on: noop, removeAllListeners: noop,
  };
}

// ============================================================================
// Mock modules — all use plain functions to survive resetMocks
// ============================================================================

jest.mock('@arbitrage/core', () => ({
  createLogger: () => createMockLogger(),
  getPerformanceLogger: () => ({ startTimer: () => ({ stop: noop }), recordMetric: noop, logEventLatency: noop, logHealthCheck: noop }),
  IntervalManager: function() { return { register: noop, clearAll: noop, getStats: () => ({}) }; },
  getRedisClient: () => Promise.resolve(createMockRedisClient()),
  getRedisStreamsClient: () => Promise.resolve(createMockStreamsClient()),
  RedisStreamsClient: { STREAMS: STREAMS_MAP },
  createServiceState: () => createMockStateManager(),
  ServiceState: { STOPPED: 'stopped', STARTING: 'starting', RUNNING: 'running', STOPPING: 'stopping', ERROR: 'error' },
  StreamConsumer: function() { return { start: noop, stop: noopAsync, getStats: () => ({ messagesProcessed: 0, messagesFailed: 0, isRunning: false, isPaused: false }), pause: noop, resume: noop }; },
  getStreamHealthMonitor: () => ({ setConsumerGroup: noop, start: noop, stop: noop }),
  SimpleCircuitBreaker: function() { return { isCurrentlyOpen: () => false, recordFailure: () => false, recordSuccess: () => false, getFailures: () => 0, getStatus: () => ({ isOpen: false, failures: 0, resetTimeoutMs: 60000, lastFailure: 0, threshold: 5 }), getCooldownRemaining: () => 0 }; },
  findKSmallest: (iter: Iterable<unknown>, k: number) => Array.from(iter).slice(0, k),
  unwrapBatchMessages: (data: Record<string, unknown>) => [data],
  CpuUsageTracker: function() { return { getUsage: () => 0, start: noop, stop: noop }; },
  disconnectWithTimeout: noopAsync,
  getErrorMessage: (e: unknown) => String(e),
}));

jest.mock('@arbitrage/core/tracing', () => ({
  extractContext: () => null,
  createTraceContext: () => ({ traceId: 'test-trace-id', spanId: 'test-span-id', serviceName: 'coordinator' }),
  createFastTraceContext: () => ({ traceId: 'fast-trace-id', spanId: 'fast-span-id', serviceName: 'coordinator' }),
  createChildContext: () => ({ traceId: 'child-trace-id', spanId: 'child-span-id', serviceName: 'coordinator' }),
}));

jest.mock('@arbitrage/core/logging', () => ({
  withLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

jest.mock('@arbitrage/core/circuit-breaker', () => ({
  SimpleCircuitBreaker: function() { return { isCurrentlyOpen: () => false, recordFailure: () => false, recordSuccess: () => false, getFailures: () => 0, getStatus: () => ({ isOpen: false, failures: 0 }), getCooldownRemaining: () => 0 }; },
}));

jest.mock('@arbitrage/core/data-structures', () => ({
  findKSmallest: (iter: Iterable<unknown>, k: number) => Array.from(iter).slice(0, k),
  findKLargest: (iter: Iterable<unknown>, k: number) => Array.from(iter).slice(0, k),
}));

jest.mock('@arbitrage/core/monitoring', () => ({
  getStreamHealthMonitor: () => ({ setConsumerGroup: noop, start: noop, stop: noop }),
  CpuUsageTracker: function() { return { getUsage: () => 0, start: noop, stop: noop }; },
  getRuntimeMonitor: () => null,
  getProviderLatencyTracker: () => null,
  getDiagnosticsCollector: () => null,
}));

jest.mock('@arbitrage/core/redis', () => ({
  getRedisClient: () => Promise.resolve(createMockRedisClient()),
  getRedisStreamsClient: () => Promise.resolve(createMockStreamsClient()),
  createRedisStreamsClient: () => Promise.resolve(createMockStreamsClient()),
  RedisStreamsClient: { STREAMS: STREAMS_MAP },
  StreamConsumer: function() { return { start: noop, stop: noopAsync, getStats: () => ({ messagesProcessed: 0, messagesFailed: 0, isRunning: false, isPaused: false }), pause: noop, resume: noop }; },
  unwrapBatchMessages: (data: Record<string, unknown>) => [data],
}));

jest.mock('@arbitrage/core/resilience', () => ({ getErrorMessage: (e: unknown) => String(e) }));

jest.mock('@arbitrage/core/service-lifecycle', () => ({
  createServiceState: () => createMockStateManager(),
  ServiceState: { STOPPED: 'stopped', STARTING: 'starting', RUNNING: 'running', STOPPING: 'stopping', ERROR: 'error' },
}));

jest.mock('@arbitrage/core/utils', () => ({ disconnectWithTimeout: noopAsync }));
jest.mock('@arbitrage/core/utils/env-utils', () => ({ parseEnvIntSafe: (_key: string, defaultVal: number) => defaultVal }));
jest.mock('@arbitrage/core/async', () => ({ IntervalManager: function() { return { register: noop, clearAll: noop, getStats: () => ({}) }; } }));

jest.mock('@arbitrage/security', () => ({
  isAuthEnabled: () => false,
  createAuthMiddleware: () => noopMiddleware,
  validateHealthRequest: noopMiddleware,
  validateMetricsRequest: noopMiddleware,
  apiAuth: () => noopMiddleware,
  apiAuthorize: () => noopMiddleware,
  sanitizeInput: (s: string) => s,
}));

import { CoordinatorService } from '../../../src/coordinator';

// =============================================================================
// DLQ Handler Tests
// =============================================================================

describe('handleDlqMessage', () => {
  let coordinator: CoordinatorService;

  beforeEach(() => {
    coordinator = new CoordinatorService({
      port: 0,
      consumerGroup: 'test-group',
      consumerId: 'test-consumer',
    });
    mockWarn.mockClear();
  });

  afterEach(async () => {
    try { await coordinator.stop(); } catch { /* ignore */ }
  });

  it('should increment dlqMetrics.total on DLQ message', async () => {
    expect(coordinator.getSystemMetrics().dlqMetrics!.total).toBe(0);
    await (coordinator as any).handleDlqMessage({
      id: 'dlq-1-0',
      data: { _dlq_originalStream: 'stream:opportunities', _dlq_errorCode: 'EXPIRED_TTL', id: 'opp-123' },
    });
    expect(coordinator.getSystemMetrics().dlqMetrics!.total).toBe(1);
  });

  it('should classify EXPIRED error codes as expired', async () => {
    await (coordinator as any).handleDlqMessage({
      id: 'dlq-1-0',
      data: { _dlq_originalStream: 'stream:opportunities', _dlq_errorCode: 'EXPIRED_TTL' },
    });
    const dlq = coordinator.getSystemMetrics().dlqMetrics!;
    expect(dlq.expired).toBe(1);
    expect(dlq.validation).toBe(0);
    expect(dlq.transient).toBe(0);
    expect(dlq.unknown).toBe(0);
  });

  it('should classify TTL error codes as expired', async () => {
    await (coordinator as any).handleDlqMessage({
      id: 'dlq-2-0',
      data: { _dlq_originalStream: 'stream:opportunities', _dlq_errorCode: 'MESSAGE_TTL_EXCEEDED' },
    });
    expect(coordinator.getSystemMetrics().dlqMetrics!.expired).toBe(1);
  });

  it('should classify STALE error codes as expired', async () => {
    await (coordinator as any).handleDlqMessage({
      id: 'dlq-3-0',
      data: { _dlq_originalStream: 'stream:price-updates', _dlq_errorCode: 'STALE_DATA' },
    });
    expect(coordinator.getSystemMetrics().dlqMetrics!.expired).toBe(1);
  });

  it('should classify VALIDATION error codes as validation', async () => {
    await (coordinator as any).handleDlqMessage({
      id: 'dlq-4-0',
      data: { _dlq_originalStream: 'stream:opportunities', _dlq_errorCode: 'VALIDATION_FAILED' },
    });
    expect(coordinator.getSystemMetrics().dlqMetrics!.validation).toBe(1);
  });

  it('should classify [VAL_ prefixed error codes as validation', async () => {
    await (coordinator as any).handleDlqMessage({
      id: 'dlq-5-0',
      data: { _dlq_originalStream: 'stream:opportunities', _dlq_errorCode: '[VAL_MISSING_FIELD] Required field missing' },
    });
    expect(coordinator.getSystemMetrics().dlqMetrics!.validation).toBe(1);
  });

  it('should classify INVALID error codes as validation', async () => {
    await (coordinator as any).handleDlqMessage({
      id: 'dlq-6-0',
      data: { _dlq_originalStream: 'stream:opportunities', _dlq_errorCode: 'INVALID_CHAIN_ID' },
    });
    expect(coordinator.getSystemMetrics().dlqMetrics!.validation).toBe(1);
  });

  it('should classify [ERR_ prefixed error codes as transient', async () => {
    await (coordinator as any).handleDlqMessage({
      id: 'dlq-7-0',
      data: { _dlq_originalStream: 'stream:execution-results', _dlq_errorCode: '[ERR_REDIS_UNAVAILABLE]' },
    });
    expect(coordinator.getSystemMetrics().dlqMetrics!.transient).toBe(1);
  });

  it('should classify TIMEOUT error codes as transient', async () => {
    await (coordinator as any).handleDlqMessage({
      id: 'dlq-8-0',
      data: { _dlq_originalStream: 'stream:execution-results', _dlq_errorCode: 'RPC_TIMEOUT' },
    });
    expect(coordinator.getSystemMetrics().dlqMetrics!.transient).toBe(1);
  });

  it('should classify RETRY error codes as transient', async () => {
    await (coordinator as any).handleDlqMessage({
      id: 'dlq-9-0',
      data: { _dlq_originalStream: 'stream:execution-results', _dlq_errorCode: 'MAX_RETRY_EXCEEDED' },
    });
    expect(coordinator.getSystemMetrics().dlqMetrics!.transient).toBe(1);
  });

  it('should classify unrecognized error codes as unknown', async () => {
    await (coordinator as any).handleDlqMessage({
      id: 'dlq-10-0',
      data: { _dlq_originalStream: 'stream:opportunities', _dlq_errorCode: 'SOMETHING_UNEXPECTED' },
    });
    expect(coordinator.getSystemMetrics().dlqMetrics!.unknown).toBe(1);
  });

  it('should log classification with messageId, originalStream, and errorCode', async () => {
    await (coordinator as any).handleDlqMessage({
      id: 'dlq-log-1-0',
      data: {
        _dlq_originalStream: 'stream:opportunities',
        _dlq_errorCode: 'EXPIRED_TTL',
        id: 'opp-456',
        type: 'multi',
        chain: 'ethereum',
      },
    });

    expect(mockWarn).toHaveBeenCalledWith(
      'DLQ entry classified',
      expect.objectContaining({
        messageId: 'dlq-log-1-0',
        originalStream: 'stream:opportunities',
        errorCode: 'EXPIRED_TTL',
        classification: 'expired',
      })
    );
  });

  it('should accumulate counters across multiple DLQ messages', async () => {
    const messages = [
      { id: 'dlq-1', data: { _dlq_errorCode: 'EXPIRED_TTL', _dlq_originalStream: 's' } },
      { id: 'dlq-2', data: { _dlq_errorCode: 'VALIDATION_FAILED', _dlq_originalStream: 's' } },
      { id: 'dlq-3', data: { _dlq_errorCode: '[ERR_TIMEOUT]', _dlq_originalStream: 's' } },
      { id: 'dlq-4', data: { _dlq_errorCode: 'UNKNOWN_THING', _dlq_originalStream: 's' } },
      { id: 'dlq-5', data: { _dlq_errorCode: 'TTL_EXCEEDED', _dlq_originalStream: 's' } },
    ];
    for (const msg of messages) {
      await (coordinator as any).handleDlqMessage(msg);
    }
    const dlq = coordinator.getSystemMetrics().dlqMetrics!;
    expect(dlq.total).toBe(5);
    expect(dlq.expired).toBe(2);
    expect(dlq.validation).toBe(1);
    expect(dlq.transient).toBe(1);
    expect(dlq.unknown).toBe(1);
  });

  it('should silently skip null data messages', async () => {
    await (coordinator as any).handleDlqMessage({ id: 'dlq-null-0', data: null });
    expect(coordinator.getSystemMetrics().dlqMetrics!.total).toBe(0);
  });
});
