/**
 * H-05: Batch Handler Tests
 *
 * Tests the batch handlers in coordinator.ts:
 * - handlePriceUpdateBatch
 * - handleExecutionResultBatch
 *
 * Uses plain functions (not jest.fn) in mock factories to survive
 * the global resetMocks: true config.
 *
 * @see services/coordinator/src/coordinator.ts
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

const createMockLogger = () => ({ info: noop, error: noop, warn: noop, debug: noop });

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

import { CoordinatorService } from '../../src/coordinator';

// =============================================================================
// handlePriceUpdateBatch Tests
// =============================================================================

describe('handlePriceUpdateBatch', () => {
  let coordinator: CoordinatorService;

  beforeEach(() => {
    coordinator = new CoordinatorService({
      port: 0,
      consumerGroup: 'test-group',
      consumerId: 'test-consumer',
    });
  });

  afterEach(async () => {
    try { await coordinator.stop(); } catch { /* ignore */ }
  });

  it('should return empty array for empty messages', async () => {
    const result = await (coordinator as any).handlePriceUpdateBatch([]);
    expect(result).toEqual([]);
  });

  it('should increment priceUpdatesReceived for valid pairKey', async () => {
    const messages = [
      { id: '1000-0', data: { pairKey: 'WETH/USDC', chain: 'ethereum', dex: 'uniswap-v3' } },
      { id: '1001-0', data: { pairKey: 'WBNB/USDT', chain: 'bsc', dex: 'pancakeswap' } },
    ];

    const priceUpdatesBefore = coordinator.getSystemMetrics().priceUpdatesReceived;
    await (coordinator as any).handlePriceUpdateBatch(messages);
    expect(coordinator.getSystemMetrics().priceUpdatesReceived).toBe(priceUpdatesBefore + 2);
  });

  it('should skip messages with empty pairKey but still add to processedIds', async () => {
    const messages = [{ id: '1000-0', data: { chain: 'ethereum', dex: 'uniswap-v3' } }];
    const priceUpdatesBefore = coordinator.getSystemMetrics().priceUpdatesReceived;

    const result = await (coordinator as any).handlePriceUpdateBatch(messages);
    expect(result).toContain('1000-0');
    expect(coordinator.getSystemMetrics().priceUpdatesReceived).toBe(priceUpdatesBefore);
  });

  it('should add null data messages to processedIds', async () => {
    const result = await (coordinator as any).handlePriceUpdateBatch([{ id: '1000-0', data: null }]);
    expect(result).toContain('1000-0');
  });

  it('should return all message IDs as processedIds', async () => {
    const messages = [
      { id: '1000-0', data: { pairKey: 'WETH/USDC', chain: 'ethereum', dex: 'uniswap' } },
      { id: '1001-0', data: null },
      { id: '1002-0', data: { chain: 'bsc' } },
    ];
    const result = await (coordinator as any).handlePriceUpdateBatch(messages);
    expect(result).toContain('1000-0');
    expect(result).toContain('1001-0');
    expect(result).toContain('1002-0');
  });
});

// =============================================================================
// handleExecutionResultBatch Tests
// =============================================================================

describe('handleExecutionResultBatch', () => {
  let coordinator: CoordinatorService;

  beforeEach(() => {
    coordinator = new CoordinatorService({
      port: 0,
      consumerGroup: 'test-group',
      consumerId: 'test-consumer',
    });
  });

  afterEach(async () => {
    try { await coordinator.stop(); } catch { /* ignore */ }
  });

  it('should return empty array for empty messages', async () => {
    const result = await (coordinator as any).handleExecutionResultBatch([]);
    expect(result).toEqual([]);
  });

  it('should increment successfulExecutions for successful results', async () => {
    const messages = [
      { id: '2000-0', data: { success: true, opportunityId: 'opp-1', chain: 'ethereum', actualProfit: 0.05, gasUsed: 200000 } },
    ];
    expect(coordinator.getSystemMetrics().successfulExecutions).toBe(0);
    await (coordinator as any).handleExecutionResultBatch(messages);
    expect(coordinator.getSystemMetrics().successfulExecutions).toBe(1);
  });

  it('should accumulate totalProfit for profitable executions', async () => {
    const messages = [
      { id: '2000-0', data: { success: true, opportunityId: 'opp-1', chain: 'ethereum', actualProfit: 0.05 } },
      { id: '2001-0', data: { success: true, opportunityId: 'opp-2', chain: 'bsc', actualProfit: 0.10 } },
    ];
    await (coordinator as any).handleExecutionResultBatch(messages);
    const metrics = coordinator.getSystemMetrics();
    expect(metrics.totalProfit).toBeCloseTo(0.15, 10);
    expect(metrics.successfulExecutions).toBe(2);
  });

  it('should not increment successfulExecutions for failed results', async () => {
    const messages = [
      { id: '2000-0', data: { success: false, opportunityId: 'opp-1', chain: 'ethereum', error: 'Slippage too high' } },
    ];
    await (coordinator as any).handleExecutionResultBatch(messages);
    expect(coordinator.getSystemMetrics().successfulExecutions).toBe(0);
  });

  it('should handle mixed batch with correct success/failure counts', async () => {
    const messages = [
      { id: '2000-0', data: { success: true, opportunityId: 'opp-1', chain: 'ethereum', actualProfit: 0.05 } },
      { id: '2001-0', data: { success: false, opportunityId: 'opp-2', chain: 'bsc', error: 'Gas too high' } },
      { id: '2002-0', data: { success: true, opportunityId: 'opp-3', chain: 'polygon', actualProfit: 0.02 } },
      { id: '2003-0', data: { success: false, opportunityId: 'opp-4', chain: 'arbitrum', error: 'Timeout' } },
    ];
    await (coordinator as any).handleExecutionResultBatch(messages);
    const metrics = coordinator.getSystemMetrics();
    expect(metrics.successfulExecutions).toBe(2);
    expect(metrics.totalProfit).toBeCloseTo(0.07, 10);
  });

  it('should skip messages with missing opportunityId but add to processedIds', async () => {
    const result = await (coordinator as any).handleExecutionResultBatch([
      { id: '2000-0', data: { success: true, chain: 'ethereum' } },
    ]);
    expect(result).toContain('2000-0');
    expect(coordinator.getSystemMetrics().successfulExecutions).toBe(0);
  });

  it('should add null data messages to processedIds', async () => {
    const result = await (coordinator as any).handleExecutionResultBatch([{ id: '2000-0', data: null }]);
    expect(result).toContain('2000-0');
  });

  it('should handle string-encoded success field ("true")', async () => {
    await (coordinator as any).handleExecutionResultBatch([
      { id: '2000-0', data: { success: 'true', opportunityId: 'opp-1', chain: 'ethereum', actualProfit: 0.01 } },
    ]);
    expect(coordinator.getSystemMetrics().successfulExecutions).toBe(1);
  });

  it('should return all message IDs as processedIds regardless of result', async () => {
    const messages = [
      { id: '2000-0', data: { success: true, opportunityId: 'opp-1', chain: 'ethereum', actualProfit: 0.01 } },
      { id: '2001-0', data: null },
      { id: '2002-0', data: { success: false, chain: 'bsc' } },
    ];
    const result = await (coordinator as any).handleExecutionResultBatch(messages);
    expect(result).toHaveLength(3);
    expect(result).toContain('2000-0');
    expect(result).toContain('2001-0');
    expect(result).toContain('2002-0');
  });

  it('should not add profit for zero or negative actualProfit', async () => {
    await (coordinator as any).handleExecutionResultBatch([
      { id: '2000-0', data: { success: true, opportunityId: 'opp-1', chain: 'ethereum', actualProfit: 0 } },
      { id: '2001-0', data: { success: true, opportunityId: 'opp-2', chain: 'bsc', actualProfit: -0.01 } },
    ]);
    const metrics = coordinator.getSystemMetrics();
    expect(metrics.successfulExecutions).toBe(2);
    expect(metrics.totalProfit).toBe(0);
  });
});
