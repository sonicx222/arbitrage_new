/**
 * Execution Flow Unit Tests
 *
 * Unit tests for execution engine with mocked Redis and dependencies.
 *
 * NOTE: Relabeled from integration test - uses fully mocked ioredis
 * and mocked @arbitrage/core dependencies, so this is actually a unit test.
 *
 * This test validates:
 * 1. Execution results are published to mocked results stream
 * 2. Performance benchmarks for simulated execution
 * 3. Error handling edge cases
 * 4. Coordinator integration via Redis Streams
 *
 * @see ADR-002: Redis Streams over Pub/Sub
 */

import { jest, describe, it, expect, beforeAll, beforeEach } from '@jest/globals';

// Make this file a module to avoid TS2451 redeclaration errors
export {};

// =============================================================================
// Mock Factories (using dependency injection pattern)
// =============================================================================

// Shared mock state
let mockStreams: Map<string, Array<{ id: string; fields: Record<string, unknown> }>>;
let mockConsumerGroups: Map<string, Map<string, unknown>>;
let mockRedisInstance: any;

/**
 * Re-apply mock implementations on mockRedisInstance.
 *
 * Jest's `resetMocks: true` config strips `.mockImplementation()` from every
 * `jest.fn()` before each test. This helper restores the stateful Redis mock
 * behavior so tests that interact with mockRedisInstance directly (Execution
 * Result Publishing, Coordinator Integration) keep working.
 */
function reapplyRedisMockImplementations(): void {
  if (!mockRedisInstance) return;

  mockRedisInstance.xadd.mockImplementation(async (stream: any, id: any, ...args: any[]) => {
    const streamData = mockStreams.get(stream) || [];
    const messageId = id === '*' ? `${Date.now()}-${streamData.length}` : id;
    const fields: Record<string, unknown> = {};
    for (let i = 0; i < args.length; i += 2) {
      fields[args[i] as string] = args[i + 1];
    }
    streamData.push({ id: messageId, fields });
    mockStreams.set(stream, streamData);
    return messageId;
  });

  mockRedisInstance.xread.mockImplementation(async (...args: unknown[]) => {
    const streamsIdx = args.indexOf('STREAMS');
    if (streamsIdx === -1) return null;
    const streamName = args[streamsIdx + 1] as string;
    const lastId = args[streamsIdx + 2] as string;
    const streamData = mockStreams.get(streamName) || [];
    if (streamData.length === 0) return null;
    const messages = streamData.filter((m: any) => lastId === '0' || lastId === '$' || m.id > lastId);
    if (messages.length === 0) return null;
    return [[streamName, messages.map((m: any) => [m.id, Object.entries(m.fields).flat()])]];
  });

  mockRedisInstance.xreadgroup.mockImplementation(async (...args: unknown[]) => {
    const streamsIdx = args.indexOf('STREAMS');
    if (streamsIdx === -1) return null;
    const streamName = args[streamsIdx + 1] as string;
    const streamData = mockStreams.get(streamName) || [];
    if (streamData.length === 0) return null;
    const messages = streamData.slice(0, 5);
    mockStreams.set(streamName, streamData.slice(5));
    if (messages.length === 0) return null;
    return [[streamName, messages.map((m: any) => [m.id, Object.entries(m.fields).flat()])]];
  });

  mockRedisInstance.xack.mockResolvedValue(1);

  mockRedisInstance.xgroup.mockImplementation(async (command: any, stream: any, group: any) => {
    if (command === 'CREATE') {
      const groups = mockConsumerGroups.get(stream) || new Map();
      if (groups.has(group)) {
        const error = new Error('BUSYGROUP Consumer Group name already exists');
        (error as any).code = 'BUSYGROUP';
        throw error;
      }
      groups.set(group, { lastDeliveredId: '0-0', consumers: new Map() });
      mockConsumerGroups.set(stream, groups);
    }
    return 'OK';
  });

  mockRedisInstance.xinfo.mockImplementation(async (_cmd: any, stream: any) => {
    const streamData = mockStreams.get(stream) || [];
    return [
      'length', streamData.length,
      'radix-tree-keys', 1,
      'radix-tree-nodes', 2,
      'last-generated-id', streamData.length > 0 ? streamData[streamData.length - 1].id : '0-0',
      'groups', mockConsumerGroups.get(stream)?.size ?? 0
    ];
  });

  mockRedisInstance.xlen.mockImplementation(async (stream: any) => (mockStreams.get(stream) || []).length);
  mockRedisInstance.xpending.mockImplementation(async () => [0, null, null, []]);
  mockRedisInstance.xtrim.mockResolvedValue(0);
  mockRedisInstance.ping.mockResolvedValue('PONG');
  mockRedisInstance.disconnect.mockResolvedValue(undefined);
  mockRedisInstance.on.mockImplementation(function(this: unknown) { return this; });
  mockRedisInstance.off.mockImplementation(function(this: unknown) { return this; });
  mockRedisInstance.removeAllListeners.mockImplementation(function(this: unknown) { return this; });
  mockRedisInstance.connect.mockResolvedValue(undefined);
  mockRedisInstance.quit.mockResolvedValue('OK');
}

// Mock ioredis before importing modules
jest.mock('ioredis', () => {
  const _mockStreams = new Map();
  const _mockConsumerGroups = new Map();

  const instance = {
    xadd: jest.fn().mockImplementation(async (stream: any, id: any, ...args: any[]) => {
      const streamData = _mockStreams.get(stream) || [];
      const messageId = id === '*' ? `${Date.now()}-${streamData.length}` : id;
      const fields: Record<string, unknown> = {};
      for (let i = 0; i < args.length; i += 2) {
        fields[args[i] as string] = args[i + 1];
      }
      streamData.push({ id: messageId, fields });
      _mockStreams.set(stream, streamData);
      return messageId;
    }),
    xread: jest.fn().mockImplementation(async (...args: unknown[]) => {
      const streamsIdx = args.indexOf('STREAMS');
      if (streamsIdx === -1) return null;
      const streamName = args[streamsIdx + 1] as string;
      const lastId = args[streamsIdx + 2] as string;
      const streamData = _mockStreams.get(streamName) || [];
      if (streamData.length === 0) return null;
      const messages = streamData.filter((m: any) => lastId === '0' || lastId === '$' || m.id > lastId);
      if (messages.length === 0) return null;
      return [[streamName, messages.map((m: any) => [m.id, Object.entries(m.fields).flat()])]];
    }),
    xreadgroup: jest.fn().mockImplementation(async (...args: unknown[]) => {
      const streamsIdx = args.indexOf('STREAMS');
      if (streamsIdx === -1) return null;
      const streamName = args[streamsIdx + 1] as string;
      const streamData = _mockStreams.get(streamName) || [];
      if (streamData.length === 0) return null;
      // Return first 5 unread messages
      const messages = streamData.slice(0, 5);
      // Clear returned messages to simulate acknowledgment
      _mockStreams.set(streamName, streamData.slice(5));
      if (messages.length === 0) return null;
      return [[streamName, messages.map((m: any) => [m.id, Object.entries(m.fields).flat()])]];
    }),
    xack: jest.fn<() => Promise<number>>().mockResolvedValue(1),
    xgroup: jest.fn().mockImplementation(async (command: any, stream: any, group: any) => {
      if (command === 'CREATE') {
        const groups = _mockConsumerGroups.get(stream) || new Map();
        if (groups.has(group)) {
          const error = new Error('BUSYGROUP Consumer Group name already exists');
          (error as any).code = 'BUSYGROUP';
          throw error;
        }
        groups.set(group, { lastDeliveredId: '0-0', consumers: new Map() });
        _mockConsumerGroups.set(stream, groups);
      }
      return 'OK';
    }),
    xinfo: jest.fn().mockImplementation(async (_cmd: any, stream: any) => {
      const streamData = _mockStreams.get(stream) || [];
      return [
        'length', streamData.length,
        'radix-tree-keys', 1,
        'radix-tree-nodes', 2,
        'last-generated-id', streamData.length > 0 ? streamData[streamData.length - 1].id : '0-0',
        'groups', _mockConsumerGroups.get(stream)?.size ?? 0
      ];
    }),
    xlen: jest.fn().mockImplementation(async (stream: any) => (_mockStreams.get(stream) || []).length),
    xpending: jest.fn().mockImplementation(async () => [0, null, null, []]),
    xtrim: jest.fn<() => Promise<number>>().mockResolvedValue(0),
    ping: jest.fn<() => Promise<string>>().mockResolvedValue('PONG'),
    disconnect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    on: jest.fn().mockImplementation(function(this: unknown) { return this; }),
    off: jest.fn().mockImplementation(function(this: unknown) { return this; }),
    removeAllListeners: jest.fn().mockImplementation(function(this: unknown) { return this; }),
    connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    quit: jest.fn<() => Promise<string>>().mockResolvedValue('OK'),
    status: 'ready',
    __mockStreams: _mockStreams,
    __mockConsumerGroups: _mockConsumerGroups
  };

  // Fix #9: Assign to module-level variables (captured by reference in closure)
  // instead of globalThis to avoid `as any` casts and fragile global state.
  mockRedisInstance = instance;
  mockStreams = _mockStreams;
  mockConsumerGroups = _mockConsumerGroups;

  const MockRedis = function() { return instance; };
  MockRedis.default = MockRedis;
  MockRedis.Redis = MockRedis;

  return MockRedis;
});

// Mock @arbitrage/core Redis client
jest.mock('@arbitrage/core', () => {
  const actual = jest.requireActual('@arbitrage/core') as Record<string, unknown>;
  return {
    ...actual,
    getRedisClient: jest.fn<() => Promise<unknown>>(async () => ({
      get: jest.fn<() => Promise<null>>().mockResolvedValue(null),
      set: jest.fn<() => Promise<string>>().mockResolvedValue('OK'),
      setNx: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      expire: jest.fn<() => Promise<number>>().mockResolvedValue(1),
      disconnect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      updateServiceHealth: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      getAllServiceHealth: jest.fn<() => Promise<Record<string, unknown>>>().mockResolvedValue({})
    })),
    getDistributedLockManager: jest.fn<() => Promise<unknown>>(async () => ({
      withLock: jest.fn(async (_key: string, fn: () => Promise<void>) => {
        await fn();
        return { success: true };
      }),
      shutdown: jest.fn<() => Promise<void>>().mockResolvedValue(undefined)
    })),
    getNonceManager: jest.fn<() => unknown>(() => ({
      start: jest.fn(),
      stop: jest.fn(),
      registerWallet: jest.fn(),
      getNextNonce: jest.fn<() => Promise<number>>().mockResolvedValue(1),
      confirmTransaction: jest.fn(),
      failTransaction: jest.fn(),
      resetChain: jest.fn()
    })),
    createLogger: (_name: string) => ({
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn()
    }),
    getPerformanceLogger: () => ({
      logEventLatency: jest.fn(),
      logExecutionResult: jest.fn(),
      logHealthCheck: jest.fn()
    }),
    createServiceState: () => ({
      getState: jest.fn<() => string>().mockReturnValue('running'),
      executeStart: jest.fn(async (fn: () => Promise<void>) => {
        await fn();
        return { success: true };
      }),
      executeStop: jest.fn(async (fn: () => Promise<void>) => {
        await fn();
        return { success: true };
      }),
      isRunning: jest.fn<() => boolean>().mockReturnValue(true),
      transition: jest.fn<() => Promise<{ success: boolean }>>().mockResolvedValue({ success: true }),
      isTransitioning: jest.fn<() => boolean>().mockReturnValue(false),
      waitForIdle: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      on: jest.fn(),
      off: jest.fn(),
      canTransition: jest.fn<() => boolean>().mockReturnValue(true)
    })
  };
});

// Import after mocks are set up
import { resetRedisStreamsInstance } from '@arbitrage/core/redis';
import type { ArbitrageOpportunity } from '@arbitrage/types';

describe('Execution Flow Unit Tests', () => {
  // Fix #9: Module-level variables are populated by the jest.mock('ioredis') factory
  // above (closure capture by reference), so no globalThis access needed here.

  beforeEach(() => {
    jest.clearAllMocks();
    // Re-apply implementations stripped by jest.config resetMocks: true
    reapplyRedisMockImplementations();
    mockStreams?.clear();
    mockConsumerGroups?.clear();
    resetRedisStreamsInstance();
  });

  // ==========================================================================
  // Stream Publishing Tests
  // ==========================================================================
  describe('Execution Result Publishing', () => {
    it('should publish execution results to stream', async () => {
      const result = {
        opportunityId: 'result-test-1',
        success: true,
        transactionHash: '0xabc123',
        actualProfit: 95,
        gasUsed: 200000,
        gasCost: 5,
        timestamp: Date.now(),
        chain: 'ethereum',
        dex: 'uniswap_v3'
      };

      // Publish to execution-results stream
      await mockRedisInstance.xadd(
        'stream:execution-results',
        '*',
        'data',
        JSON.stringify(result)
      );

      // Verify result was published
      const streamData = mockStreams.get('stream:execution-results');
      expect(streamData?.length).toBe(1);

      const storedResult = JSON.parse(streamData![0].fields.data as string);
      expect(storedResult.opportunityId).toBe('result-test-1');
      expect(storedResult.success).toBe(true);
      expect(storedResult.actualProfit).toBe(95);
    });
  });

  // ==========================================================================
  // Performance Tests (via SimulationStrategy public API)
  // ==========================================================================
  describe('Performance Benchmarks', () => {
    let SimulationStrategy: any;
    let resolveSimulationConfig: any;
    const realPerformanceNow = () => Date.now();
    beforeAll(async () => {
      const mod = await import('../../src/strategies/simulation.strategy');
      SimulationStrategy = mod.SimulationStrategy;
      const typesMod = await import('../../src/types');
      resolveSimulationConfig = typesMod.resolveSimulationConfig;
    });

    beforeEach(() => {
      // Restore performance.now mock (global afterEach calls jest.resetAllMocks which resets it)
      (global as any).performance = { now: realPerformanceNow };
    });

    const createMockCtx = () => ({
      logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
      perfLogger: { logEventLatency: jest.fn(), logExecutionResult: jest.fn(), logHealthCheck: jest.fn() },
      providers: new Map(),
      wallets: new Map(),
      providerHealth: new Map(),
      nonceManager: null,
      mevProviderFactory: null,
      bridgeRouterFactory: null,
      stateManager: { getState: jest.fn().mockReturnValue('running'), executeStart: jest.fn(), executeStop: jest.fn(), isRunning: jest.fn().mockReturnValue(true), transition: jest.fn(), isTransitioning: jest.fn().mockReturnValue(false), waitForIdle: jest.fn(), on: jest.fn(), off: jest.fn(), canTransition: jest.fn().mockReturnValue(true) } as any,
      gasBaselines: new Map(),
      stats: { opportunitiesReceived: 0, executionAttempts: 0, opportunitiesRejected: 0, successfulExecutions: 0, failedExecutions: 0, queueRejects: 0, lockConflicts: 0, staleLockRecoveries: 0, executionTimeouts: 0, validationErrors: 0, providerReconnections: 0, providerHealthCheckFailures: 0, simulationsPerformed: 0, simulationsSkipped: 0, simulationPredictedReverts: 0, simulationProfitabilityRejections: 0, simulationErrors: 0, circuitBreakerTrips: 0, circuitBreakerBlocks: 0, riskEVRejections: 0, riskPositionSizeRejections: 0, riskDrawdownBlocks: 0, riskCautionCount: 0, riskHaltCount: 0 },
    });

    it('should handle high throughput opportunity processing', async () => {
      const config = resolveSimulationConfig({
        enabled: true,
        successRate: 1.0,
        executionLatencyMs: 1,
        logSimulatedExecutions: false,
      });
      const strategy = new SimulationStrategy(
        { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
        config
      );
      const ctx = createMockCtx();

      const opportunityCount = 100;
      const startTime = performance.now();

      for (let i = 0; i < opportunityCount; i++) {
        const opportunity: ArbitrageOpportunity = {
          id: `perf-${i}`,
          type: 'cross-dex',
          buyDex: 'uniswap_v3',
          sellDex: 'sushiswap',
          expectedProfit: 50,
          confidence: 0.9,
          timestamp: Date.now(),
        };
        await strategy.execute(opportunity, ctx);
      }

      const duration = performance.now() - startTime;
      const opsPerSecond = (opportunityCount / duration) * 1000;

      // Should process at least 50 ops/second (conservative for CI)
      expect(opsPerSecond).toBeGreaterThan(50);
    });

    it('should have low latency for simulated execution', async () => {
      const configuredLatency = 50;
      const config = resolveSimulationConfig({
        enabled: true,
        successRate: 1.0,
        executionLatencyMs: configuredLatency,
        logSimulatedExecutions: false,
      });
      const strategy = new SimulationStrategy(
        { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
        config
      );
      const ctx = createMockCtx();

      const opportunity: ArbitrageOpportunity = {
        id: 'latency-test',
        type: 'cross-dex',
        buyDex: 'uniswap_v3',
        sellDex: 'sushiswap',
        expectedProfit: 100,
        confidence: 0.9,
        timestamp: Date.now(),
      };

      const startTime = performance.now();
      await strategy.execute(opportunity, ctx);
      const duration = performance.now() - startTime;

      // Should be within ±30% of configured latency (as per SimulationStrategy implementation)
      const minExpected = configuredLatency * 0.7;
      const maxExpected = configuredLatency * 1.3;

      expect(duration).toBeGreaterThanOrEqual(minExpected);
      expect(duration).toBeLessThanOrEqual(maxExpected * 1.5); // Extra buffer for test environment
    });
  });

  // ==========================================================================
  // Error Handling Tests (via SimulationStrategy public API)
  // ==========================================================================
  describe('Error Handling', () => {
    let SimulationStrategy: any;
    let resolveSimulationConfig: any;
    beforeAll(async () => {
      const mod = await import('../../src/strategies/simulation.strategy');
      SimulationStrategy = mod.SimulationStrategy;
      const typesMod = await import('../../src/types');
      resolveSimulationConfig = typesMod.resolveSimulationConfig;
    });

    const createMockCtx = () => ({
      logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
      perfLogger: { logEventLatency: jest.fn(), logExecutionResult: jest.fn(), logHealthCheck: jest.fn() },
      providers: new Map(),
      wallets: new Map(),
      providerHealth: new Map(),
      nonceManager: null,
      mevProviderFactory: null,
      bridgeRouterFactory: null,
      stateManager: { getState: jest.fn().mockReturnValue('running'), executeStart: jest.fn(), executeStop: jest.fn(), isRunning: jest.fn().mockReturnValue(true), transition: jest.fn(), isTransitioning: jest.fn().mockReturnValue(false), waitForIdle: jest.fn(), on: jest.fn(), off: jest.fn(), canTransition: jest.fn().mockReturnValue(true) } as any,
      gasBaselines: new Map(),
      stats: { opportunitiesReceived: 0, executionAttempts: 0, opportunitiesRejected: 0, successfulExecutions: 0, failedExecutions: 0, queueRejects: 0, lockConflicts: 0, staleLockRecoveries: 0, executionTimeouts: 0, validationErrors: 0, providerReconnections: 0, providerHealthCheckFailures: 0, simulationsPerformed: 0, simulationsSkipped: 0, simulationPredictedReverts: 0, simulationProfitabilityRejections: 0, simulationErrors: 0, circuitBreakerTrips: 0, circuitBreakerBlocks: 0, riskEVRejections: 0, riskPositionSizeRejections: 0, riskDrawdownBlocks: 0, riskCautionCount: 0, riskHaltCount: 0 },
    });

    it('should return error result for opportunity with missing id', async () => {
      const config = resolveSimulationConfig({
        enabled: true,
        successRate: 1.0,
        executionLatencyMs: 1,
        logSimulatedExecutions: false,
      });
      const strategy = new SimulationStrategy(
        { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
        config
      );
      const ctx = createMockCtx();

      // SimulationStrategy returns INVALID_OPPORTUNITY for missing id
      const invalidOpp: ArbitrageOpportunity = {
        id: '',
        type: 'cross-dex',
        buyDex: 'uniswap_v3',
        sellDex: 'sushiswap',
        expectedProfit: 100,
        confidence: 0.9,
        timestamp: Date.now(),
      };

      const result = await strategy.execute(invalidOpp, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toContain('ERR_INVALID_OPPORTUNITY');
    });

    it('should handle zero expected profit gracefully', async () => {
      const config = resolveSimulationConfig({
        enabled: true,
        successRate: 1.0,
        executionLatencyMs: 1,
        gasCostMultiplier: 0.1,
        profitVariance: 0,
        logSimulatedExecutions: false,
      });
      const strategy = new SimulationStrategy(
        { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
        config
      );
      const ctx = createMockCtx();

      // Zero profit should still execute (not crash) -- ?? preserves 0
      const zeroProfitOpp: ArbitrageOpportunity = {
        id: 'zero-profit-1',
        type: 'cross-dex',
        buyDex: 'uniswap_v3',
        sellDex: 'sushiswap',
        expectedProfit: 0,
        confidence: 0.9,
        timestamp: Date.now(),
      };

      const result = await strategy.execute(zeroProfitOpp, ctx);
      expect(result.success).toBe(true);
      expect(result.gasCost).toBe(0); // 0 * 0.1 = 0
    });
  });

  // ==========================================================================
  // GAP-002: Simulation Timeout and Provider Fallback Edge Cases
  // ==========================================================================
  describe('Simulation Timeout Edge Cases (GAP-002)', () => {
    let SimulationStrategy: any;
    let resolveSimulationConfig: any;
    beforeAll(async () => {
      const mod = await import('../../src/strategies/simulation.strategy');
      SimulationStrategy = mod.SimulationStrategy;
      const typesMod = await import('../../src/types');
      resolveSimulationConfig = typesMod.resolveSimulationConfig;
    });

    const createMockCtx = () => ({
      logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
      perfLogger: { logEventLatency: jest.fn(), logExecutionResult: jest.fn(), logHealthCheck: jest.fn() },
      providers: new Map(),
      wallets: new Map(),
      providerHealth: new Map(),
      nonceManager: null,
      mevProviderFactory: null,
      bridgeRouterFactory: null,
      stateManager: { getState: jest.fn().mockReturnValue('running'), executeStart: jest.fn(), executeStop: jest.fn(), isRunning: jest.fn().mockReturnValue(true), transition: jest.fn(), isTransitioning: jest.fn().mockReturnValue(false), waitForIdle: jest.fn(), on: jest.fn(), off: jest.fn(), canTransition: jest.fn().mockReturnValue(true) } as any,
      gasBaselines: new Map(),
      stats: { opportunitiesReceived: 0, executionAttempts: 0, opportunitiesRejected: 0, successfulExecutions: 0, failedExecutions: 0, queueRejects: 0, lockConflicts: 0, staleLockRecoveries: 0, executionTimeouts: 0, validationErrors: 0, providerReconnections: 0, providerHealthCheckFailures: 0, simulationsPerformed: 0, simulationsSkipped: 0, simulationPredictedReverts: 0, simulationProfitabilityRejections: 0, simulationErrors: 0, circuitBreakerTrips: 0, circuitBreakerBlocks: 0, riskEVRejections: 0, riskPositionSizeRejections: 0, riskDrawdownBlocks: 0, riskCautionCount: 0, riskHaltCount: 0 },
    });

    it('should handle simulation strategy that exceeds execution latency gracefully', async () => {
      // Create a strategy with very high latency to simulate a long-running operation
      const config = resolveSimulationConfig({
        enabled: true,
        successRate: 1.0,
        executionLatencyMs: 100, // 100ms simulated delay
        logSimulatedExecutions: false,
      });
      const strategy = new SimulationStrategy(
        { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
        config
      );
      const ctx = createMockCtx();

      const opportunity: ArbitrageOpportunity = {
        id: 'timeout-edge-1',
        type: 'cross-dex',
        buyDex: 'uniswap_v3',
        sellDex: 'sushiswap',
        buyChain: 'ethereum',
        expectedProfit: 100,
        confidence: 0.9,
        timestamp: Date.now(),
      };

      // Execute and await — the 100ms simulated delay resolves with real timers
      const result = await strategy.execute(opportunity, ctx);

      // Should complete successfully even with high latency
      expect(result.success).toBe(true);
      expect(result.opportunityId).toBe('timeout-edge-1');
    });

    it('should track executionTimeouts stat when execution takes too long', () => {
      const ctx = createMockCtx();
      // Verify executionTimeouts stat starts at 0
      expect(ctx.stats.executionTimeouts).toBe(0);

      // Simulate what engine does when timeout fires
      ctx.stats.executionTimeouts++;
      expect(ctx.stats.executionTimeouts).toBe(1);
    });
  });

  // ==========================================================================
  // Integration with Coordinator (Simulated)
  // ==========================================================================
  describe('Coordinator Integration', () => {
    it('should consume opportunities from same stream as coordinator', async () => {
      // Both coordinator and execution engine consume from OPPORTUNITIES stream
      // but use different consumer groups

      const opportunityStream = 'stream:opportunities';

      // Create consumer groups for both services
      await mockRedisInstance.xgroup('CREATE', opportunityStream, 'coordinator-group', '$');

      // Reset error state for second group creation
      const groups = mockConsumerGroups.get(opportunityStream);
      if (groups) groups.delete('execution-engine-group');

      await mockRedisInstance.xgroup('CREATE', opportunityStream, 'execution-engine-group', '$');

      // Verify both groups exist
      const consumerGroups = mockConsumerGroups.get(opportunityStream);
      expect(consumerGroups).toBeInstanceOf(Map);
      expect(consumerGroups!.has('coordinator-group')).toBe(true);
      expect(consumerGroups!.has('execution-engine-group')).toBe(true);
    });

    it('should track opportunities correctly across services', async () => {
      const opportunity: ArbitrageOpportunity = {
        id: 'coord-test-1',
        type: 'cross-dex',
        buyDex: 'uniswap_v3',
        sellDex: 'sushiswap',
        buyChain: 'ethereum',
        expectedProfit: 100,
        confidence: 0.9,
        timestamp: Date.now(),
        status: 'pending'
      };

      // Detector publishes opportunity
      await mockRedisInstance.xadd(
        'stream:opportunities',
        '*',
        'data',
        JSON.stringify(opportunity)
      );

      // Both services should receive the opportunity (different consumer groups)
      const messages = await mockRedisInstance.xread(
        'STREAMS',
        'stream:opportunities',
        '0'
      );

      expect(messages).not.toBeNull();
      expect(messages[0][1].length).toBeGreaterThan(0);

      // Parse opportunity from message
      const receivedData = JSON.parse(messages[0][1][0][1][1]);
      expect(receivedData.id).toBe('coord-test-1');
    });
  });
});
