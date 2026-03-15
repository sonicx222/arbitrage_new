/**
 * Stream Handlers Tests
 *
 * Unit tests for the 6 exported stream handlers in stream-handlers.ts:
 * - handleWhaleAlertMessage
 * - handleSwapEventMessage
 * - handleVolumeAggregateMessage
 * - handlePriceUpdateMessage
 * - processPriceUpdateItems
 * - handleServiceDegradationMessage
 *
 * P1-3 FIX: These handlers previously had zero unit tests.
 *
 * @see services/coordinator/src/streaming/stream-handlers.ts
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import {
  handleWhaleAlertMessage,
  handleSwapEventMessage,
  handleVolumeAggregateMessage,
  handlePriceUpdateMessage,
  processPriceUpdateItems,
  handleServiceDegradationMessage,
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

function createTestDeps(metrics?: SystemMetrics): StreamHandlerDeps {
  return {
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    },
    systemMetrics: metrics ?? createTestMetrics(),
    sendAlert: jest.fn(),
    trackActivePair: jest.fn(),
  };
}

// =============================================================================
// handleWhaleAlertMessage
// =============================================================================

describe('handleWhaleAlertMessage', () => {
  let deps: StreamHandlerDeps;

  beforeEach(() => {
    deps = createTestDeps();
  });

  it('should return early on null data', async () => {
    await handleWhaleAlertMessage({ id: 'w-1', data: null }, deps);
    expect(deps.systemMetrics.whaleAlerts).toBe(0);
    expect(deps.sendAlert).not.toHaveBeenCalled();
  });

  it('should increment whaleAlerts metric', async () => {
    const msg: StreamMessage = {
      id: 'w-2',
      data: { usdValue: 50000, direction: 'buy', chain: 'ethereum' },
    };
    await handleWhaleAlertMessage(msg, deps);
    expect(deps.systemMetrics.whaleAlerts).toBe(1);
  });

  it('should send alert with critical severity for usdValue > $100K', async () => {
    const msg: StreamMessage = {
      id: 'w-3',
      data: { usdValue: 150000, direction: 'sell', chain: 'bsc' },
    };
    await handleWhaleAlertMessage(msg, deps);
    expect(deps.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'WHALE_TRANSACTION',
        severity: 'critical',
      }),
    );
  });

  it('should send alert with high severity for usdValue <= $100K', async () => {
    const msg: StreamMessage = {
      id: 'w-4',
      data: { usdValue: 100000, direction: 'buy', chain: 'arbitrum' },
    };
    await handleWhaleAlertMessage(msg, deps);
    expect(deps.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'WHALE_TRANSACTION',
        severity: 'high',
      }),
    );
  });

  it('should include direction and chain in alert message', async () => {
    const msg: StreamMessage = {
      id: 'w-5',
      data: { usdValue: 200000, direction: 'sell', chain: 'polygon' },
    };
    await handleWhaleAlertMessage(msg, deps);
    const alert = (deps.sendAlert as jest.Mock).mock.calls[0][0];
    expect(alert.message).toContain('sell');
    expect(alert.message).toContain('polygon');
  });

  it('should log whale alert details via logger.warn', async () => {
    const msg: StreamMessage = {
      id: 'w-6',
      data: { usdValue: 75000, direction: 'buy', chain: 'base', address: '0xabc', dex: 'uniswap' },
    };
    await handleWhaleAlertMessage(msg, deps);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      'Whale alert received',
      expect.objectContaining({
        usdValue: 75000,
        direction: 'buy',
        chain: 'base',
        address: '0xabc',
        dex: 'uniswap',
      }),
    );
  });

  it('should handle wrapped message envelope', async () => {
    const msg: StreamMessage = {
      id: 'w-7',
      data: {
        type: 'whale_alert',
        data: { usdValue: 500000, direction: 'buy', chain: 'ethereum' },
      },
    };
    await handleWhaleAlertMessage(msg, deps);
    expect(deps.systemMetrics.whaleAlerts).toBe(1);
    expect(deps.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'critical' }),
    );
  });

  it('should default missing fields gracefully', async () => {
    const msg: StreamMessage = { id: 'w-8', data: {} };
    await handleWhaleAlertMessage(msg, deps);
    expect(deps.systemMetrics.whaleAlerts).toBe(1);
    // usdValue defaults to 0, direction defaults to 'unknown'
    const alert = (deps.sendAlert as jest.Mock).mock.calls[0][0];
    expect(alert.severity).toBe('high'); // 0 <= 100000
    expect(alert.message).toContain('unknown');
  });
});

// =============================================================================
// handleSwapEventMessage
// =============================================================================

describe('handleSwapEventMessage', () => {
  let deps: StreamHandlerDeps;

  beforeEach(() => {
    deps = createTestDeps();
  });

  it('should return early on null data', async () => {
    await handleSwapEventMessage({ id: 's-1', data: null }, deps);
    expect(deps.systemMetrics.totalSwapEvents).toBe(0);
  });

  it('should skip when pairAddress is missing', async () => {
    const msg: StreamMessage = { id: 's-2', data: { chain: 'bsc', dex: 'pancakeswap' } };
    await handleSwapEventMessage(msg, deps);
    expect(deps.systemMetrics.totalSwapEvents).toBe(0);
    expect(deps.logger.debug).toHaveBeenCalledWith(
      'Skipping swap event - missing pairAddress',
      expect.objectContaining({ messageId: 's-2' }),
    );
  });

  it('should increment totalSwapEvents for valid message', async () => {
    const msg: StreamMessage = {
      id: 's-3',
      data: { pairAddress: '0xPAIR', chain: 'ethereum', dex: 'uniswap', usdValue: 5000 },
    };
    await handleSwapEventMessage(msg, deps);
    expect(deps.systemMetrics.totalSwapEvents).toBe(1);
  });

  it('should accumulate totalVolumeUsd', async () => {
    const msg: StreamMessage = {
      id: 's-4',
      data: { pairAddress: '0xPAIR', chain: 'bsc', dex: 'pancakeswap', usdValue: 2500 },
    };
    await handleSwapEventMessage(msg, deps);
    expect(deps.systemMetrics.totalVolumeUsd).toBe(2500);
  });

  it('should guard against precision loss near MAX_SAFE_INTEGER', async () => {
    deps.systemMetrics.totalVolumeUsd = Number.MAX_SAFE_INTEGER - 100;
    const msg: StreamMessage = {
      id: 's-5',
      data: { pairAddress: '0xPAIR', chain: 'bsc', dex: 'pancakeswap', usdValue: 200 },
    };
    await handleSwapEventMessage(msg, deps);
    // Should NOT add because MAX_SAFE_INTEGER - 100 + 200 would overflow
    expect(deps.systemMetrics.totalVolumeUsd).toBe(Number.MAX_SAFE_INTEGER - 100);
  });

  it('should call trackActivePair with correct args', async () => {
    const msg: StreamMessage = {
      id: 's-6',
      data: { pairAddress: '0xABC', chain: 'arbitrum', dex: 'sushiswap', usdValue: 1000 },
    };
    await handleSwapEventMessage(msg, deps);
    expect(deps.trackActivePair).toHaveBeenCalledWith('0xABC', 'arbitrum', 'sushiswap');
  });

  it('should log large swaps (>= $10K) at debug level', async () => {
    const msg: StreamMessage = {
      id: 's-7',
      data: { pairAddress: '0xPAIR', chain: 'ethereum', dex: 'uniswap', usdValue: 15000 },
    };
    await handleSwapEventMessage(msg, deps);
    expect(deps.logger.debug).toHaveBeenCalledWith(
      'Large swap event received',
      expect.objectContaining({ pairAddress: '0xPAIR', usdValue: 15000 }),
    );
  });

  it('should not log swaps < $10K', async () => {
    const msg: StreamMessage = {
      id: 's-8',
      data: { pairAddress: '0xPAIR', chain: 'bsc', dex: 'pancakeswap', usdValue: 5000 },
    };
    await handleSwapEventMessage(msg, deps);
    expect(deps.logger.debug).not.toHaveBeenCalledWith(
      'Large swap event received',
      expect.anything(),
    );
  });

  it('should handle wrapped message envelope', async () => {
    const msg: StreamMessage = {
      id: 's-9',
      data: {
        type: 'swap_event',
        data: { pairAddress: '0xWRAP', chain: 'base', dex: 'aerodrome', usdValue: 300 },
      },
    };
    await handleSwapEventMessage(msg, deps);
    expect(deps.systemMetrics.totalSwapEvents).toBe(1);
    expect(deps.trackActivePair).toHaveBeenCalledWith('0xWRAP', 'base', 'aerodrome');
  });
});

// =============================================================================
// handleVolumeAggregateMessage
// =============================================================================

describe('handleVolumeAggregateMessage', () => {
  let deps: StreamHandlerDeps;

  beforeEach(() => {
    deps = createTestDeps();
  });

  it('should return early on null data', async () => {
    await handleVolumeAggregateMessage({ id: 'v-1', data: null }, deps);
    expect(deps.systemMetrics.volumeAggregatesProcessed).toBe(0);
  });

  it('should skip when pairAddress is missing', async () => {
    const msg: StreamMessage = { id: 'v-2', data: { chain: 'bsc', swapCount: 5 } };
    await handleVolumeAggregateMessage(msg, deps);
    expect(deps.systemMetrics.volumeAggregatesProcessed).toBe(0);
    expect(deps.logger.debug).toHaveBeenCalledWith(
      'Skipping volume aggregate - missing pairAddress',
      expect.objectContaining({ messageId: 'v-2' }),
    );
  });

  it('should increment volumeAggregatesProcessed', async () => {
    const msg: StreamMessage = {
      id: 'v-3',
      data: { pairAddress: '0xPAIR', chain: 'ethereum', dex: 'uniswap', swapCount: 3, totalUsdVolume: 10000 },
    };
    await handleVolumeAggregateMessage(msg, deps);
    expect(deps.systemMetrics.volumeAggregatesProcessed).toBe(1);
  });

  it('should call trackActivePair', async () => {
    const msg: StreamMessage = {
      id: 'v-4',
      data: { pairAddress: '0xPAIR', chain: 'polygon', dex: 'quickswap', swapCount: 1, totalUsdVolume: 500 },
    };
    await handleVolumeAggregateMessage(msg, deps);
    expect(deps.trackActivePair).toHaveBeenCalledWith('0xPAIR', 'polygon', 'quickswap');
  });

  it('should return early after tracking when swapCount is 0', async () => {
    const msg: StreamMessage = {
      id: 'v-5',
      data: { pairAddress: '0xPAIR', chain: 'bsc', dex: 'pancakeswap', swapCount: 0, totalUsdVolume: 0 },
    };
    await handleVolumeAggregateMessage(msg, deps);
    expect(deps.systemMetrics.volumeAggregatesProcessed).toBe(1);
    // Should not log high volume info
    expect(deps.logger.info).not.toHaveBeenCalled();
  });

  it('should log high volume aggregates (>= $50K)', async () => {
    const msg: StreamMessage = {
      id: 'v-6',
      data: { pairAddress: '0xPAIR', chain: 'ethereum', dex: 'uniswap', swapCount: 10, totalUsdVolume: 75000 },
    };
    await handleVolumeAggregateMessage(msg, deps);
    expect(deps.logger.info).toHaveBeenCalledWith(
      'High volume aggregate detected',
      expect.objectContaining({ pairAddress: '0xPAIR', totalUsdVolume: 75000, swapCount: 10 }),
    );
  });

  it('should not log when totalUsdVolume < $50K', async () => {
    const msg: StreamMessage = {
      id: 'v-7',
      data: { pairAddress: '0xPAIR', chain: 'bsc', dex: 'pancakeswap', swapCount: 2, totalUsdVolume: 30000 },
    };
    await handleVolumeAggregateMessage(msg, deps);
    expect(deps.logger.info).not.toHaveBeenCalled();
  });

  it('should handle wrapped message envelope', async () => {
    const msg: StreamMessage = {
      id: 'v-8',
      data: {
        type: 'volume_aggregate',
        data: { pairAddress: '0xWRAP', chain: 'base', dex: 'aerodrome', swapCount: 5, totalUsdVolume: 100000 },
      },
    };
    await handleVolumeAggregateMessage(msg, deps);
    expect(deps.systemMetrics.volumeAggregatesProcessed).toBe(1);
    expect(deps.logger.info).toHaveBeenCalledWith(
      'High volume aggregate detected',
      expect.objectContaining({ pairAddress: '0xWRAP' }),
    );
  });
});

// =============================================================================
// handlePriceUpdateMessage
// =============================================================================

describe('handlePriceUpdateMessage', () => {
  let deps: StreamHandlerDeps;
  const unwrapBatch = (data: Record<string, unknown>): Record<string, unknown>[] => {
    // Simple batch unwrapper: if data has items array, return them; otherwise single item
    if (Array.isArray(data.items)) return data.items as Record<string, unknown>[];
    return [data];
  };

  beforeEach(() => {
    deps = createTestDeps();
  });

  it('should return early on null data', async () => {
    await handlePriceUpdateMessage({ id: 'p-1', data: null }, deps, unwrapBatch);
    expect(deps.systemMetrics.priceUpdatesReceived).toBe(0);
  });

  it('should increment priceUpdatesReceived for valid items', async () => {
    const msg: StreamMessage = {
      id: 'p-2',
      data: { pairKey: 'ETH/USDC', chain: 'ethereum', dex: 'uniswap' },
    };
    await handlePriceUpdateMessage(msg, deps, unwrapBatch);
    expect(deps.systemMetrics.priceUpdatesReceived).toBe(1);
  });

  it('should skip items with missing pairKey', async () => {
    const msg: StreamMessage = {
      id: 'p-3',
      data: { chain: 'bsc', dex: 'pancakeswap' },
    };
    await handlePriceUpdateMessage(msg, deps, unwrapBatch);
    expect(deps.systemMetrics.priceUpdatesReceived).toBe(0);
    expect(deps.logger.debug).toHaveBeenCalledWith(
      'Skipping price update - missing pairKey',
      expect.objectContaining({ messageId: 'p-3' }),
    );
  });

  it('should process batch of items', async () => {
    const msg: StreamMessage = {
      id: 'p-4',
      data: {
        items: [
          { pairKey: 'ETH/USDC', chain: 'ethereum', dex: 'uniswap' },
          { pairKey: 'BTC/USDT', chain: 'bsc', dex: 'pancakeswap' },
          { chain: 'polygon', dex: 'quickswap' }, // missing pairKey
        ],
      },
    };
    await handlePriceUpdateMessage(msg, deps, unwrapBatch);
    expect(deps.systemMetrics.priceUpdatesReceived).toBe(2);
    expect(deps.trackActivePair).toHaveBeenCalledTimes(2);
  });

  it('should call trackActivePair for each valid item', async () => {
    const msg: StreamMessage = {
      id: 'p-5',
      data: { pairKey: 'WETH/DAI', chain: 'arbitrum', dex: 'camelot' },
    };
    await handlePriceUpdateMessage(msg, deps, unwrapBatch);
    expect(deps.trackActivePair).toHaveBeenCalledWith('WETH/DAI', 'arbitrum', 'camelot');
  });

  it('should log when all items in batch are filtered out', async () => {
    const msg: StreamMessage = {
      id: 'p-6',
      data: {
        items: [
          { chain: 'ethereum', dex: 'uniswap' }, // no pairKey
          { chain: 'bsc', dex: 'pancakeswap' },   // no pairKey
        ],
      },
    };
    await handlePriceUpdateMessage(msg, deps, unwrapBatch);
    expect(deps.logger.debug).toHaveBeenCalledWith(
      'All items in batch filtered out (missing pairKey)',
      expect.objectContaining({ messageId: 'p-6', batchSize: 2 }),
    );
  });
});

// =============================================================================
// processPriceUpdateItems
// =============================================================================

describe('processPriceUpdateItems', () => {
  let deps: StreamHandlerDeps;

  beforeEach(() => {
    deps = createTestDeps();
  });

  it('should return count of valid items', () => {
    const items = [
      { pairKey: 'ETH/USDC', chain: 'ethereum', dex: 'uniswap' },
      { pairKey: 'BTC/USDT', chain: 'bsc', dex: 'pancakeswap' },
    ];
    const count = processPriceUpdateItems(items, deps);
    expect(count).toBe(2);
  });

  it('should skip items without pairKey', () => {
    const items = [
      { pairKey: 'ETH/USDC', chain: 'ethereum', dex: 'uniswap' },
      { chain: 'bsc', dex: 'pancakeswap' }, // missing pairKey
      { pairKey: '', chain: 'polygon', dex: 'quickswap' }, // empty pairKey
    ];
    const count = processPriceUpdateItems(items, deps);
    expect(count).toBe(1);
  });

  it('should increment priceUpdatesReceived per valid item', () => {
    const items = [
      { pairKey: 'A/B', chain: 'c1', dex: 'd1' },
      { pairKey: 'C/D', chain: 'c2', dex: 'd2' },
      { pairKey: 'E/F', chain: 'c3', dex: 'd3' },
    ];
    processPriceUpdateItems(items, deps);
    expect(deps.systemMetrics.priceUpdatesReceived).toBe(3);
  });

  it('should call trackActivePair for each valid item', () => {
    const items = [
      { pairKey: 'ETH/DAI', chain: 'ethereum', dex: 'uniswap' },
      { pairKey: 'SOL/USDC', chain: 'solana', dex: 'raydium' },
    ];
    processPriceUpdateItems(items, deps);
    expect(deps.trackActivePair).toHaveBeenCalledWith('ETH/DAI', 'ethereum', 'uniswap');
    expect(deps.trackActivePair).toHaveBeenCalledWith('SOL/USDC', 'solana', 'raydium');
  });

  it('should return 0 for empty array', () => {
    const count = processPriceUpdateItems([], deps);
    expect(count).toBe(0);
    expect(deps.systemMetrics.priceUpdatesReceived).toBe(0);
  });

  it('should unwrap wrapped message items', () => {
    const items = [
      { type: 'price_update', data: { pairKey: 'ETH/USDC', chain: 'ethereum', dex: 'uniswap' } },
    ];
    const count = processPriceUpdateItems(items, deps);
    expect(count).toBe(1);
    expect(deps.trackActivePair).toHaveBeenCalledWith('ETH/USDC', 'ethereum', 'uniswap');
  });
});

// =============================================================================
// handleServiceDegradationMessage
// =============================================================================

describe('handleServiceDegradationMessage', () => {
  let deps: StreamHandlerDeps;

  beforeEach(() => {
    deps = createTestDeps();
  });

  it('should return early on null data', async () => {
    await handleServiceDegradationMessage({ id: 'd-1', data: null }, deps);
    expect(deps.sendAlert).not.toHaveBeenCalled();
    expect(deps.logger.warn).not.toHaveBeenCalled();
  });

  it('should send high-severity alert for degraded event', async () => {
    const msg: StreamMessage = {
      id: 'd-2',
      data: { service: 'execution-engine', event: 'degraded', reason: 'high latency' },
    };
    await handleServiceDegradationMessage(msg, deps);
    expect(deps.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'SERVICE_DEGRADED',
        severity: 'high',
        service: 'execution-engine',
      }),
    );
  });

  it('should include reason in degraded alert message', async () => {
    const msg: StreamMessage = {
      id: 'd-3',
      data: { service: 'partition-1', event: 'degraded', reason: 'memory pressure' },
    };
    await handleServiceDegradationMessage(msg, deps);
    const alert = (deps.sendAlert as jest.Mock).mock.calls[0][0];
    expect(alert.message).toContain('partition-1');
    expect(alert.message).toContain('memory pressure');
  });

  it('should log degraded event via logger.warn', async () => {
    const msg: StreamMessage = {
      id: 'd-4',
      data: { service: 'cross-chain', event: 'degraded', reason: 'bridge timeout' },
    };
    await handleServiceDegradationMessage(msg, deps);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      'Service degradation reported',
      expect.objectContaining({ service: 'cross-chain', reason: 'bridge timeout' }),
    );
  });

  it('should send low-severity alert for recovered event', async () => {
    const msg: StreamMessage = {
      id: 'd-5',
      data: { service: 'execution-engine', event: 'recovered' },
    };
    await handleServiceDegradationMessage(msg, deps);
    expect(deps.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'SERVICE_RECOVERED',
        severity: 'low',
        service: 'execution-engine',
      }),
    );
  });

  it('should log recovered event via logger.info', async () => {
    const msg: StreamMessage = {
      id: 'd-6',
      data: { service: 'partition-3', event: 'recovered' },
    };
    await handleServiceDegradationMessage(msg, deps);
    expect(deps.logger.info).toHaveBeenCalledWith(
      'Service recovery reported',
      expect.objectContaining({ service: 'partition-3' }),
    );
  });

  it('should log unknown events at debug level without alert', async () => {
    const msg: StreamMessage = {
      id: 'd-7',
      data: { service: 'detector', event: 'throttled' },
    };
    await handleServiceDegradationMessage(msg, deps);
    expect(deps.sendAlert).not.toHaveBeenCalled();
    expect(deps.logger.debug).toHaveBeenCalledWith(
      'Service degradation event',
      expect.objectContaining({ service: 'detector', event: 'throttled' }),
    );
  });

  it('should default missing service and event fields', async () => {
    const msg: StreamMessage = { id: 'd-8', data: {} };
    await handleServiceDegradationMessage(msg, deps);
    // event defaults to 'unknown', which falls through to debug log
    expect(deps.logger.debug).toHaveBeenCalledWith(
      'Service degradation event',
      expect.objectContaining({ service: 'unknown', event: 'unknown' }),
    );
  });

  it('should handle wrapped message envelope', async () => {
    const msg: StreamMessage = {
      id: 'd-9',
      data: {
        type: 'degradation',
        data: { service: 'mempool', event: 'degraded', reason: 'ws disconnect' },
      },
    };
    await handleServiceDegradationMessage(msg, deps);
    expect(deps.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'SERVICE_DEGRADED',
        service: 'mempool',
      }),
    );
  });
});
