/**
 * SwapEventFilter Router Address Filtering Tests
 *
 * Tests for filtering DEX router addresses from whale alerts.
 * DEX router-initiated swaps extract `log.topics[1]` (the swap sender) as the
 * "whale" address. For router contracts, this is a false positive.
 *
 * @see known-router-addresses.ts
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

import {
  SwapEventFilter,
  resetSwapEventFilter,
} from '@arbitrage/core/analytics';

import type { SwapEvent } from '@arbitrage/types';
import type { WhaleAlert } from '@arbitrage/core/analytics';

// Helper to create mock swap events
function createMockSwapEvent(overrides: Partial<SwapEvent> = {}): SwapEvent {
  return {
    pairAddress: '0x1234567890123456789012345678901234567890',
    sender: '0xsender123',
    recipient: '0xrecipient456',
    amount0In: '1000000000000000000', // 1 ETH in wei
    amount1In: '0',
    amount0Out: '0',
    amount1Out: '2000000000', // 2000 USDC (6 decimals)
    to: '0xto789',
    blockNumber: 12345678,
    transactionHash: '0xtxhash' + Math.random().toString(16).slice(2, 10),
    timestamp: Date.now(),
    dex: 'uniswap_v3',
    chain: 'ethereum',
    usdValue: 2000,
    ...overrides,
  };
}

describe('SwapEventFilter - router address filtering', () => {
  let filter: SwapEventFilter;

  beforeEach(() => {
    jest.useFakeTimers();
    resetSwapEventFilter();
  });

  afterEach(() => {
    if (filter) {
      filter.destroy();
    }
    jest.useRealTimers();
  });

  it('should not emit whale alert when sender is a known DEX router', () => {
    const pancakeRouterV2 = '0x10ed43c718714eb63d5aa57b78b54704e256024e';
    filter = new SwapEventFilter({
      whaleThreshold: 50000,
      knownRouterAddresses: new Set([pancakeRouterV2]),
    });

    const alerts: WhaleAlert[] = [];
    filter.onWhaleAlert((alert: WhaleAlert) => {
      alerts.push(alert);
    });

    // Process a whale-sized swap where sender is a known router
    const routerSwap = createMockSwapEvent({
      sender: pancakeRouterV2,
      usdValue: 100000, // Well above whale threshold
      transactionHash: '0xrouter_whale_tx',
    });

    filter.processEvent(routerSwap);

    // Whale handler should NOT be called
    expect(alerts).toHaveLength(0);

    // Stats should track the filtered router swap
    const stats = filter.getStats();
    expect(stats.routerSwapsFiltered).toBe(1);
  });

  it('should emit whale alert when sender is not a known router', () => {
    const pancakeRouterV2 = '0x10ed43c718714eb63d5aa57b78b54704e256024e';
    filter = new SwapEventFilter({
      whaleThreshold: 50000,
      knownRouterAddresses: new Set([pancakeRouterV2]),
    });

    const alerts: WhaleAlert[] = [];
    filter.onWhaleAlert((alert: WhaleAlert) => {
      alerts.push(alert);
    });

    // Process a whale-sized swap from a regular wallet
    const normalWhaleSwap = createMockSwapEvent({
      sender: '0xabcdef1234567890abcdef1234567890abcdef12',
      usdValue: 100000,
      transactionHash: '0xnormal_whale_tx',
    });

    filter.processEvent(normalWhaleSwap);

    // Whale handler SHOULD be called
    expect(alerts).toHaveLength(1);
    expect(alerts[0].usdValue).toBe(100000);

    // routerSwapsFiltered should remain at 0
    const stats = filter.getStats();
    expect(stats.routerSwapsFiltered).toBe(0);
  });

  it('should handle case-insensitive router addresses', () => {
    // Store router in uppercase
    const routerUppercase = '0x13F4EA83D0BD40E75C8222255BC855A974568DD4';
    filter = new SwapEventFilter({
      whaleThreshold: 50000,
      knownRouterAddresses: new Set([routerUppercase.toLowerCase()]),
    });

    const alerts: WhaleAlert[] = [];
    filter.onWhaleAlert((alert: WhaleAlert) => {
      alerts.push(alert);
    });

    // Event sender has mixed case
    const routerSwap = createMockSwapEvent({
      sender: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4',
      usdValue: 75000,
      transactionHash: '0xcase_test_tx',
    });

    filter.processEvent(routerSwap);

    // Should be filtered despite case mismatch
    expect(alerts).toHaveLength(0);

    const stats = filter.getStats();
    expect(stats.routerSwapsFiltered).toBe(1);
  });

  it('should still pass the event through the filter even when router whale is suppressed', () => {
    const routerAddr = '0x10ed43c718714eb63d5aa57b78b54704e256024e';
    filter = new SwapEventFilter({
      whaleThreshold: 50000,
      knownRouterAddresses: new Set([routerAddr]),
    });

    const routerSwap = createMockSwapEvent({
      sender: routerAddr,
      usdValue: 100000,
      transactionHash: '0xrouter_passthrough_tx',
    });

    const result = filter.processEvent(routerSwap);

    // The event should still pass the filter (it is a valid swap)
    expect(result.passed).toBe(true);
    // It should still be flagged as whale-level value
    expect(result.isWhale).toBe(true);
  });

  it('should default to empty router set when not provided', () => {
    filter = new SwapEventFilter({
      whaleThreshold: 50000,
    });

    const alerts: WhaleAlert[] = [];
    filter.onWhaleAlert((alert: WhaleAlert) => {
      alerts.push(alert);
    });

    const whaleSwap = createMockSwapEvent({
      usdValue: 100000,
      transactionHash: '0xdefault_set_tx',
    });

    filter.processEvent(whaleSwap);

    // Should still emit whale alerts normally
    expect(alerts).toHaveLength(1);
  });
});
