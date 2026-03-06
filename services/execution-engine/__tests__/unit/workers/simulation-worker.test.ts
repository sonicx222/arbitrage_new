/**
 * SimulationWorker Unit Tests (Phase 3 — Async Pipeline Split)
 *
 * Verifies SimulationWorker behavior:
 * - Publishes opportunities to stream:pre-simulated with preSimulatedAt stamped
 * - Drops opportunities when BatchQuoter reports unprofitable
 * - Passes through opportunities when no BatchQuoter (pass-through mode)
 * - Handles errors without crashing
 * - Computes a preSimulationScore
 *
 * @see services/execution-engine/src/workers/simulation-worker.ts
 * @see docs/reports/EXECUTION_BOTTLENECK_RESEARCH_2026-03-06.md — Phase 3
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { RedisStreams } from '@arbitrage/types';

// Capture the handler passed to StreamConsumer so tests can drive it directly
let capturedHandler: ((msg: Record<string, unknown>) => Promise<void>) | null = null;
const mockStreamConsumerStart = jest.fn();
const mockStreamConsumerStop = jest.fn().mockResolvedValue(undefined);

jest.mock('@arbitrage/core/redis', () => ({
  StreamConsumer: jest.fn().mockImplementation((_client: unknown, { handler }: { handler: (msg: Record<string, unknown>) => Promise<void> }) => {
    capturedHandler = handler;
    return { start: mockStreamConsumerStart, stop: mockStreamConsumerStop };
  }),
}));

// eslint-disable-next-line import/first
import {
  SimulationWorker,
  type SimulationWorkerConfig,
  type SimulationWorkerBatchQuoter,
} from '../../../src/workers/simulation-worker';

// =============================================================================
// Re-apply StreamConsumer mock after resetMocks: true (jest.config.base.js)
// clears mockImplementation between tests. This module-level beforeEach runs
// before all describe-level beforeEach hooks, restoring the mock for every test.
// =============================================================================
beforeEach(() => {
  const redisMock = jest.requireMock('@arbitrage/core/redis') as {
    StreamConsumer: jest.Mock;
  };
  redisMock.StreamConsumer.mockImplementation(
    (_client: unknown, { handler }: { handler: (msg: Record<string, unknown>) => Promise<void> }) => {
      capturedHandler = handler;
      return { start: mockStreamConsumerStart, stop: mockStreamConsumerStop };
    },
  );
  mockStreamConsumerStop.mockResolvedValue(undefined);
});

// =============================================================================
// Mock factories
// =============================================================================

function createMockLogger() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

function createMockStreamsClient() {
  return {
    xaddWithLimit: jest.fn().mockResolvedValue('1-0'),
    xack: jest.fn().mockResolvedValue(1),
    createConsumerGroup: jest.fn().mockResolvedValue(undefined),
  };
}

function createMockBatchQuoter(profitWei = 50000n): jest.Mocked<SimulationWorkerBatchQuoter> {
  return {
    simulateArbitragePath: jest.fn().mockResolvedValue({
      expectedProfit: profitWei,
      finalAmount: profitWei + 1000000000000000000n,
      allSuccess: true,
      latencyMs: 12,
    }),
  };
}

function buildStreamMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'test-opp-1',
    type: 'intra-chain',
    chain: 'bsc',
    buyDex: 'pancakeswap',
    sellDex: 'biswap',
    tokenIn: '0xWETH',
    tokenOut: '0xUSDC',
    amountIn: '1000000000000000000',
    expectedProfit: 0.05,
    confidence: '0.9',
    timestamp: String(Date.now()),
    ...overrides,
  };
}

const BASE_CONFIG: SimulationWorkerConfig = {
  sourceStream: 'stream:exec-requests-fast',
  targetStream: RedisStreams.PRE_SIMULATED,
  consumerGroupName: 'simulation-worker-group',
  consumerName: 'sim-worker-1',
};

// =============================================================================
// Tests — pass-through mode (no batchQuoter)
// =============================================================================

describe('SimulationWorker — pass-through mode (no BatchQuoter)', () => {
  let worker: SimulationWorker;
  let mockStreamsClient: ReturnType<typeof createMockStreamsClient>;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    jest.clearAllMocks();
    capturedHandler = null;
    mockLogger = createMockLogger();
    mockStreamsClient = createMockStreamsClient();

    worker = new SimulationWorker(mockLogger, mockStreamsClient as any, null, BASE_CONFIG);
  });

  it('should publish opportunity to pre-simulated stream with preSimulatedAt stamped', async () => {
    await worker.start();
    expect(capturedHandler).not.toBeNull();

    const before = Date.now();
    await capturedHandler!(buildStreamMessage());
    const after = Date.now();

    expect(mockStreamsClient.xaddWithLimit).toHaveBeenCalledTimes(1);
    const [targetStream, publishedMessage] = (mockStreamsClient.xaddWithLimit as jest.Mock).mock.calls[0] as [string, Record<string, unknown>];

    expect(targetStream).toBe(RedisStreams.PRE_SIMULATED);
    const preSimAt = Number(publishedMessage['preSimulatedAt']);
    expect(preSimAt).toBeGreaterThanOrEqual(before);
    expect(preSimAt).toBeLessThanOrEqual(after);
  });

  it('should preserve all original opportunity fields in published message', async () => {
    await worker.start();
    const msg = buildStreamMessage({ id: 'preserve-test', type: 'cross-chain', expectedProfit: 0.12 });
    await capturedHandler!(msg);

    const [, published] = (mockStreamsClient.xaddWithLimit as jest.Mock).mock.calls[0] as [string, Record<string, unknown>];
    expect(published['id']).toBe('preserve-test');
    expect(published['type']).toBe('cross-chain');
    expect(published['expectedProfit']).toBe(0.12);
  });

  it('should stamp a numeric preSimulationScore in published message', async () => {
    await worker.start();
    await capturedHandler!(buildStreamMessage({ expectedProfit: 0.08, confidence: '0.95' }));

    const [, published] = (mockStreamsClient.xaddWithLimit as jest.Mock).mock.calls[0] as [string, Record<string, unknown>];
    const score = Number(published['preSimulationScore']);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('should forward message even when tokenIn/tokenOut are absent (no simulation possible)', async () => {
    await worker.start();
    const msg = buildStreamMessage();
    delete (msg as Record<string, unknown>)['tokenIn'];
    delete (msg as Record<string, unknown>)['tokenOut'];
    await capturedHandler!(msg);

    expect(mockStreamsClient.xaddWithLimit).toHaveBeenCalledTimes(1);
  });

  it('should update stats after processing', async () => {
    await worker.start();
    await capturedHandler!(buildStreamMessage());
    await capturedHandler!(buildStreamMessage({ id: 'test-opp-2' }));

    const stats = worker.getStats();
    expect(stats.processed).toBe(2);
    expect(stats.forwarded).toBe(2);
    expect(stats.dropped).toBe(0);
  });

  it('should not crash when message parsing throws, and count it as an error', async () => {
    mockStreamsClient.xaddWithLimit.mockRejectedValueOnce(new Error('Redis write failed'));
    await worker.start();
    await capturedHandler!(buildStreamMessage());

    const stats = worker.getStats();
    expect(stats.errors).toBe(1);
  });
});

// =============================================================================
// Tests — simulation mode (with BatchQuoter)
// =============================================================================

describe('SimulationWorker — simulation mode (with BatchQuoter)', () => {
  let worker: SimulationWorker;
  let mockStreamsClient: ReturnType<typeof createMockStreamsClient>;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockBatchQuoter: jest.Mocked<SimulationWorkerBatchQuoter>;

  beforeEach(() => {
    jest.clearAllMocks();
    capturedHandler = null;
    mockLogger = createMockLogger();
    mockStreamsClient = createMockStreamsClient();
    mockBatchQuoter = createMockBatchQuoter(50000n); // profitable

    worker = new SimulationWorker(mockLogger, mockStreamsClient as any, mockBatchQuoter, BASE_CONFIG);
  });

  it('should forward opportunity when BatchQuoter reports profitable (expectedProfit > 0)', async () => {
    await worker.start();
    await capturedHandler!(buildStreamMessage());

    expect(mockStreamsClient.xaddWithLimit).toHaveBeenCalledTimes(1);
    const stats = worker.getStats();
    expect(stats.forwarded).toBe(1);
    expect(stats.dropped).toBe(0);
  });

  it('should drop opportunity when BatchQuoter reports zero profit', async () => {
    mockBatchQuoter.simulateArbitragePath.mockResolvedValueOnce({
      expectedProfit: 0n,
      finalAmount: 1000000000000000000n,
      allSuccess: true,
      latencyMs: 10,
    });
    await worker.start();
    await capturedHandler!(buildStreamMessage());

    expect(mockStreamsClient.xaddWithLimit).not.toHaveBeenCalled();
    const stats = worker.getStats();
    expect(stats.dropped).toBe(1);
    expect(stats.forwarded).toBe(0);
  });

  it('should drop opportunity when BatchQuoter reports negative profit (would revert)', async () => {
    // Negative BigInt: the final amount is less than flash loan amount
    mockBatchQuoter.simulateArbitragePath.mockResolvedValueOnce({
      expectedProfit: -100n,
      finalAmount: 999999900000000000n,
      allSuccess: false,
      latencyMs: 8,
    });
    await worker.start();
    await capturedHandler!(buildStreamMessage());

    expect(mockStreamsClient.xaddWithLimit).not.toHaveBeenCalled();
    const stats = worker.getStats();
    expect(stats.dropped).toBe(1);
  });

  it('should pass through (forward) when BatchQuoter throws an error (fail open)', async () => {
    mockBatchQuoter.simulateArbitragePath.mockRejectedValueOnce(new Error('RPC timeout'));
    await worker.start();
    await capturedHandler!(buildStreamMessage());

    // On quoter error, forward with a neutral score rather than drop
    // (fail open to avoid losing opportunities due to RPC issues)
    expect(mockStreamsClient.xaddWithLimit).toHaveBeenCalledTimes(1);
    const stats = worker.getStats();
    expect(stats.forwarded).toBe(1);
  });

  it('should skip BatchQuoter call when opp is missing tokenIn or tokenOut', async () => {
    const msg = buildStreamMessage();
    delete (msg as Record<string, unknown>)['tokenIn'];

    await worker.start();
    await capturedHandler!(msg);

    // Should forward without calling quoter
    expect(mockBatchQuoter.simulateArbitragePath).not.toHaveBeenCalled();
    expect(mockStreamsClient.xaddWithLimit).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// Tests — lifecycle
// =============================================================================

describe('SimulationWorker — lifecycle', () => {
  let worker: SimulationWorker;

  beforeEach(() => {
    jest.clearAllMocks();
    capturedHandler = null;
    worker = new SimulationWorker(
      createMockLogger(),
      createMockStreamsClient() as any,
      null,
      BASE_CONFIG,
    );
  });

  it('should start the StreamConsumer on start()', async () => {
    await worker.start();
    expect(mockStreamConsumerStart).toHaveBeenCalledTimes(1);
  });

  it('should stop the StreamConsumer on stop()', async () => {
    await worker.start();
    await worker.stop();
    expect(mockStreamConsumerStop).toHaveBeenCalledTimes(1);
  });

  it('should return zero stats before processing any messages', () => {
    const stats = worker.getStats();
    expect(stats).toEqual({ processed: 0, forwarded: 0, dropped: 0, errors: 0 });
  });
});
