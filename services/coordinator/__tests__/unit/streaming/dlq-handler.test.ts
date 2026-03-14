/**
 * DLQ Handler Tests
 *
 * Tests for the extracted handleDlqMessage stream handler and classifyDlqError.
 * Now tests the standalone function directly (no coordinator instantiation needed).
 *
 * @see services/coordinator/src/streaming/stream-handlers.ts
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  handleDlqMessage,
  classifyDlqError,
} from '../../../src/streaming/stream-handlers';
import type {
  StreamHandlerDeps,
  StreamMessage,
} from '../../../src/streaming/stream-handlers';
import type { SystemMetrics } from '../../../src/api/types';

// =============================================================================
// Test Helpers
// =============================================================================

function createTestMetrics(): SystemMetrics {
  return {
    totalOpportunities: 0,
    totalExecutions: 0,
    successfulExecutions: 0,
    totalProfit: 0,
    averageLatency: 0,
    averageMemory: 0,
    systemHealth: 100,
    activeServices: 0,
    lastUpdate: 0,
    whaleAlerts: 0,
    pendingOpportunities: 0,
    totalSwapEvents: 0,
    totalVolumeUsd: 0,
    volumeAggregatesProcessed: 0,
    activePairsTracked: 0,
    priceUpdatesReceived: 0,
    opportunitiesDropped: 0,
    dlqMetrics: { total: 0, expired: 0, validation: 0, transient: 0, unknown: 0 },
  };
}

const mockWarn = jest.fn();

function createTestDeps(metrics?: SystemMetrics): StreamHandlerDeps {
  return {
    logger: { info: jest.fn(), error: jest.fn(), warn: mockWarn, debug: jest.fn() },
    systemMetrics: metrics ?? createTestMetrics(),
    sendAlert: jest.fn(),
    trackActivePair: jest.fn(),
  };
}

const traceUtils = {
  extractContext: () => null,
  createTraceContext: () => ({ traceId: 'test-trace-id', spanId: 'test-span-id', serviceName: 'coordinator', timestamp: Date.now() }),
  createChildContext: () => ({ traceId: 'child-trace-id', spanId: 'child-span-id', serviceName: 'coordinator', timestamp: Date.now() }),
  withLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
};

// =============================================================================
// Tests
// =============================================================================

describe('handleDlqMessage', () => {
  let deps: StreamHandlerDeps;

  beforeEach(() => {
    deps = createTestDeps();
    mockWarn.mockClear();
  });

  it('should increment dlqMetrics.total on DLQ message', async () => {
    expect(deps.systemMetrics.dlqMetrics!.total).toBe(0);
    await handleDlqMessage(
      { id: 'dlq-1-0', data: { _dlq_originalStream: 'stream:opportunities', _dlq_errorCode: 'EXPIRED_TTL', id: 'opp-123' } },
      deps,
      traceUtils,
    );
    expect(deps.systemMetrics.dlqMetrics!.total).toBe(1);
  });

  it('should classify EXPIRED error codes as expired', async () => {
    await handleDlqMessage(
      { id: 'dlq-1-0', data: { _dlq_originalStream: 'stream:opportunities', _dlq_errorCode: 'EXPIRED_TTL' } },
      deps, traceUtils,
    );
    const dlq = deps.systemMetrics.dlqMetrics!;
    expect(dlq.expired).toBe(1);
    expect(dlq.validation).toBe(0);
    expect(dlq.transient).toBe(0);
    expect(dlq.unknown).toBe(0);
  });

  it('should classify TTL error codes as expired', async () => {
    await handleDlqMessage(
      { id: 'dlq-2-0', data: { _dlq_originalStream: 'stream:opportunities', _dlq_errorCode: 'MESSAGE_TTL_EXCEEDED' } },
      deps, traceUtils,
    );
    expect(deps.systemMetrics.dlqMetrics!.expired).toBe(1);
  });

  it('should classify STALE error codes as expired', async () => {
    await handleDlqMessage(
      { id: 'dlq-3-0', data: { _dlq_originalStream: 'stream:price-updates', _dlq_errorCode: 'STALE_DATA' } },
      deps, traceUtils,
    );
    expect(deps.systemMetrics.dlqMetrics!.expired).toBe(1);
  });

  it('should classify VALIDATION error codes as validation', async () => {
    await handleDlqMessage(
      { id: 'dlq-4-0', data: { _dlq_originalStream: 'stream:opportunities', _dlq_errorCode: 'VALIDATION_FAILED' } },
      deps, traceUtils,
    );
    expect(deps.systemMetrics.dlqMetrics!.validation).toBe(1);
  });

  it('should classify [VAL_ prefixed error codes as validation', async () => {
    await handleDlqMessage(
      { id: 'dlq-5-0', data: { _dlq_originalStream: 'stream:opportunities', _dlq_errorCode: '[VAL_MISSING_FIELD] Required field missing' } },
      deps, traceUtils,
    );
    expect(deps.systemMetrics.dlqMetrics!.validation).toBe(1);
  });

  it('should classify INVALID error codes as validation', async () => {
    await handleDlqMessage(
      { id: 'dlq-6-0', data: { _dlq_originalStream: 'stream:opportunities', _dlq_errorCode: 'INVALID_CHAIN_ID' } },
      deps, traceUtils,
    );
    expect(deps.systemMetrics.dlqMetrics!.validation).toBe(1);
  });

  it('should classify [ERR_ prefixed error codes as transient', async () => {
    await handleDlqMessage(
      { id: 'dlq-7-0', data: { _dlq_originalStream: 'stream:execution-results', _dlq_errorCode: '[ERR_REDIS_UNAVAILABLE]' } },
      deps, traceUtils,
    );
    expect(deps.systemMetrics.dlqMetrics!.transient).toBe(1);
  });

  it('should classify TIMEOUT error codes as transient', async () => {
    await handleDlqMessage(
      { id: 'dlq-8-0', data: { _dlq_originalStream: 'stream:execution-results', _dlq_errorCode: 'RPC_TIMEOUT' } },
      deps, traceUtils,
    );
    expect(deps.systemMetrics.dlqMetrics!.transient).toBe(1);
  });

  it('should classify RETRY error codes as transient', async () => {
    await handleDlqMessage(
      { id: 'dlq-9-0', data: { _dlq_originalStream: 'stream:execution-results', _dlq_errorCode: 'MAX_RETRY_EXCEEDED' } },
      deps, traceUtils,
    );
    expect(deps.systemMetrics.dlqMetrics!.transient).toBe(1);
  });

  it('should classify unrecognized error codes as unknown', async () => {
    await handleDlqMessage(
      { id: 'dlq-10-0', data: { _dlq_originalStream: 'stream:opportunities', _dlq_errorCode: 'SOMETHING_UNEXPECTED' } },
      deps, traceUtils,
    );
    expect(deps.systemMetrics.dlqMetrics!.unknown).toBe(1);
  });

  it('should log classification with messageId, originalStream, and errorCode', async () => {
    await handleDlqMessage(
      {
        id: 'dlq-log-1-0',
        data: {
          _dlq_originalStream: 'stream:opportunities',
          _dlq_errorCode: 'EXPIRED_TTL',
          id: 'opp-456',
          type: 'multi',
          chain: 'ethereum',
        },
      },
      deps, traceUtils,
    );

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
    const messages: StreamMessage[] = [
      { id: 'dlq-1', data: { _dlq_errorCode: 'EXPIRED_TTL', _dlq_originalStream: 's' } },
      { id: 'dlq-2', data: { _dlq_errorCode: 'VALIDATION_FAILED', _dlq_originalStream: 's' } },
      { id: 'dlq-3', data: { _dlq_errorCode: '[ERR_TIMEOUT]', _dlq_originalStream: 's' } },
      { id: 'dlq-4', data: { _dlq_errorCode: 'UNKNOWN_THING', _dlq_originalStream: 's' } },
      { id: 'dlq-5', data: { _dlq_errorCode: 'TTL_EXCEEDED', _dlq_originalStream: 's' } },
    ];
    for (const msg of messages) {
      await handleDlqMessage(msg, deps, traceUtils);
    }
    const dlq = deps.systemMetrics.dlqMetrics!;
    expect(dlq.total).toBe(5);
    expect(dlq.expired).toBe(2);
    expect(dlq.validation).toBe(1);
    expect(dlq.transient).toBe(1);
    expect(dlq.unknown).toBe(1);
  });

  it('should silently skip null data messages', async () => {
    await handleDlqMessage({ id: 'dlq-null-0', data: null }, deps, traceUtils);
    expect(deps.systemMetrics.dlqMetrics!.total).toBe(0);
  });
});
