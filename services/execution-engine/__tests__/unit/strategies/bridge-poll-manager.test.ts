/**
 * P1-3 FIX: BridgePollManager Unit Tests
 *
 * Tests for the bridge polling manager that handles polling bridge routers
 * for completion status with backoff scheduling.
 *
 * @see services/execution-engine/src/strategies/bridge-poll-manager.ts
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { pollBridgeCompletion } from '../../../src/strategies/bridge-poll-manager';
import type { Logger, StrategyContext } from '../../../src/types';
import { ExecutionErrorCode } from '../../../src/types';

// Mock BRIDGE_DEFAULTS with short times for testing
jest.mock('@arbitrage/core/bridge-router', () => ({
  BRIDGE_DEFAULTS: {
    maxBridgeWaitMs: 60000, // 60s to avoid hitting timeout too early
    statusPollIntervalMs: 1000,
  },
}));

jest.mock('@arbitrage/core/resilience', () => ({
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

// =============================================================================
// Test Helpers
// =============================================================================

function createMockLogger(): Logger {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as Logger;
}

function createMockBridgeRouter() {
  return {
    getStatus: jest.fn<(bridgeId: string) => Promise<{ status: string; amountReceived?: string; destTxHash?: string; error?: string }>>(
    ).mockResolvedValue({ status: 'pending' }),
  };
}

function createMockCtx(isRunning = true): StrategyContext {
  return {
    isShuttingDown: false,
    wallets: new Map(),
    providers: new Map(),
    bridgeRouterFactory: null,
    stateManager: {
      isRunning: jest.fn().mockReturnValue(isRunning),
    },
  } as unknown as StrategyContext;
}

/**
 * Helper to advance fake timers and flush microtasks repeatedly.
 * Each iteration advances by `stepMs` and flushes promises.
 */
async function advanceTimersRepeatedly(steps: number, stepMs: number): Promise<void> {
  for (let i = 0; i < steps; i++) {
    await jest.advanceTimersByTimeAsync(stepMs);
  }
}

// =============================================================================
// Tests
// =============================================================================

describe('pollBridgeCompletion', () => {
  let logger: Logger;
  let bridgeRouter: ReturnType<typeof createMockBridgeRouter>;
  let ctx: StrategyContext;

  beforeEach(() => {
    jest.useFakeTimers();
    logger = createMockLogger();
    bridgeRouter = createMockBridgeRouter();
    ctx = createMockCtx();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should return completed when bridge completes', async () => {
    bridgeRouter.getStatus
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'bridging' })
      .mockResolvedValueOnce({ status: 'completed', amountReceived: '1000000', destTxHash: '0xdef' });

    const promise = pollBridgeCompletion(
      bridgeRouter as any,
      'bridge-1',
      'opp-1',
      'ethereum',
      '0xabc',
      ctx,
      logger,
    );

    // The backoff schedule polls every 5s for the first 30s.
    // Advance in 5s steps to allow each poll cycle to complete.
    await advanceTimersRepeatedly(10, 5000);

    const result = await promise;

    expect(result.completed).toBe(true);
    expect(result.amountReceived).toBe('1000000');
    expect(result.destTxHash).toBe('0xdef');
  });

  it('should return error when bridge fails', async () => {
    bridgeRouter.getStatus.mockResolvedValue({
      status: 'failed',
      error: 'Insufficient liquidity',
    });

    const promise = pollBridgeCompletion(
      bridgeRouter as any,
      'bridge-1',
      'opp-1',
      'ethereum',
      '0xabc',
      ctx,
      logger,
    );

    await advanceTimersRepeatedly(5, 5000);

    const result = await promise;

    expect(result.completed).toBe(false);
    expect(result.error?.code).toBe(ExecutionErrorCode.BRIDGE_FAILED);
    expect(result.error?.message).toBe('Insufficient liquidity');
  });

  it('should return error on refunded status', async () => {
    bridgeRouter.getStatus.mockResolvedValue({ status: 'refunded' });

    const promise = pollBridgeCompletion(
      bridgeRouter as any,
      'bridge-1',
      'opp-1',
      'ethereum',
      '0xabc',
      ctx,
      logger,
    );

    await advanceTimersRepeatedly(5, 5000);

    const result = await promise;

    expect(result.completed).toBe(false);
    expect(result.error?.code).toBe(ExecutionErrorCode.BRIDGE_FAILED);
  });

  it('should timeout after max wait time', async () => {
    bridgeRouter.getStatus.mockResolvedValue({ status: 'pending' });

    const promise = pollBridgeCompletion(
      bridgeRouter as any,
      'bridge-1',
      'opp-1',
      'ethereum',
      '0xabc',
      ctx,
      logger,
    );

    // Advance well past the 60s max wait time
    await advanceTimersRepeatedly(30, 5000);

    const result = await promise;

    expect(result.completed).toBe(false);
    expect(result.error?.code).toBe(ExecutionErrorCode.BRIDGE_TIMEOUT);
  });

  it('should stop polling when shutdown is detected', async () => {
    bridgeRouter.getStatus.mockResolvedValue({ status: 'pending' });

    const mutableCtx = createMockCtx();
    const isRunningMock = mutableCtx.stateManager!.isRunning as jest.Mock;

    const promise = pollBridgeCompletion(
      bridgeRouter as any,
      'bridge-1',
      'opp-1',
      'ethereum',
      '0xabc',
      mutableCtx,
      logger,
    );

    // Let one poll cycle complete
    await advanceTimersRepeatedly(2, 5000);

    // Signal shutdown before the next poll
    isRunningMock.mockReturnValue(false);

    // Advance to trigger the shutdown check
    await advanceTimersRepeatedly(5, 5000);

    const result = await promise;

    expect(result.completed).toBe(false);
    expect(result.error?.code).toBe(ExecutionErrorCode.SHUTDOWN);
  });

  it('should handle getStatus errors gracefully and continue polling', async () => {
    bridgeRouter.getStatus
      .mockRejectedValueOnce(new Error('Network timeout'))
      .mockResolvedValueOnce({ status: 'completed', amountReceived: '500000', destTxHash: '0x456' });

    const promise = pollBridgeCompletion(
      bridgeRouter as any,
      'bridge-1',
      'opp-1',
      'ethereum',
      '0xabc',
      ctx,
      logger,
    );

    // First poll fails (error handler waits up to pollInterval before retry)
    // Second poll succeeds
    await advanceTimersRepeatedly(10, 5000);

    const result = await promise;

    expect(result.completed).toBe(true);
    expect(result.amountReceived).toBe('500000');
    expect(logger.warn).toHaveBeenCalled(); // Should log the transient error
  });
});
