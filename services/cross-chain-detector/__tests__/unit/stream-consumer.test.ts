/**
 * Unit Tests for StreamConsumer
 *
 * Tests the stream consumption module extracted from CrossChainDetectorService.
 */

import { EventEmitter } from 'events';
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createStreamConsumer,
  getPriceUpdateRejectionReason,
  StreamConsumer,
  Logger,
} from '../../src/stream-consumer';
import { PriceUpdate, WhaleTransaction, PendingOpportunity } from '@arbitrage/types';
import { RecordingLogger } from '@arbitrage/core/logging';

// =============================================================================
// Tests
// =============================================================================

describe('StreamConsumer', () => {
  let logger: RecordingLogger;
  let mockStreamsClient: {
    xreadgroup: jest.Mock<() => Promise<any[]>>;
    xack: jest.Mock<() => Promise<number>>;
    createConsumerGroup: jest.Mock<() => Promise<void>>;
  };
  let mockStateManager: { isRunning: jest.Mock };

  const consumerGroups = [
    {
      streamName: 'stream:price-updates',
      groupName: 'cross-chain-detector-group',
      consumerName: 'test-consumer',
    },
    {
      streamName: 'stream:whale-alerts',
      groupName: 'cross-chain-detector-group',
      consumerName: 'test-consumer',
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    logger = new RecordingLogger();
    logger.clear();

    mockStreamsClient = {
      xreadgroup: jest.fn<() => Promise<any[]>>().mockResolvedValue([]),
      xack: jest.fn<() => Promise<number>>().mockResolvedValue(1),
      createConsumerGroup: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };

    mockStateManager = {
      isRunning: jest.fn().mockReturnValue(true),
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // FIX #16: Helper to create consumer with typed mocks, reducing `as any` casts
  const createTestConsumer = (overrides?: Partial<Parameters<typeof createStreamConsumer>[0]>) =>
    createStreamConsumer({
      instanceId: 'test-instance',
      streamsClient: mockStreamsClient as unknown as Parameters<typeof createStreamConsumer>[0]['streamsClient'],
      stateManager: mockStateManager as unknown as Parameters<typeof createStreamConsumer>[0]['stateManager'],
      logger: logger as unknown as Logger,
      consumerGroups,
      ...overrides,
    });

  // ===========================================================================
  // Creation
  // ===========================================================================

  describe('createStreamConsumer', () => {
    it('should create consumer with required config', () => {
      const consumer = createTestConsumer();

      expect(consumer).toBeDefined();
      expect(typeof consumer.createConsumerGroups).toBe('function');
      expect(typeof consumer.start).toBe('function');
      expect(typeof consumer.stop).toBe('function');
    });

    it('should be an EventEmitter', () => {
      const consumer = createTestConsumer();

      expect(consumer).toBeInstanceOf(EventEmitter);
    });
  });

  // ===========================================================================
  // Consumer Groups
  // ===========================================================================

  describe('createConsumerGroups', () => {
    it('should create all configured consumer groups', async () => {
      const consumer = createTestConsumer();

      await consumer.createConsumerGroups();

      expect(mockStreamsClient.createConsumerGroup).toHaveBeenCalledTimes(2);
    });

    it('should handle errors gracefully', async () => {
      mockStreamsClient.createConsumerGroup.mockRejectedValue(new Error('Redis error'));

      const consumer = createTestConsumer();

      await consumer.createConsumerGroups();

      expect(logger.getLogs('error').length).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // start / stop
  // ===========================================================================

  describe('start', () => {
    it('should start polling interval', () => {
      const consumer = createTestConsumer({ pollIntervalMs: 100 });

      consumer.start();

      expect(logger.hasLogMatching('info', /Starting/)).toBe(true);
    });

    it('should poll streams at configured interval', async () => {
      const consumer = createTestConsumer({ pollIntervalMs: 100 });

      consumer.start();

      // Advance timer to trigger poll
      jest.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();

      expect(mockStreamsClient.xreadgroup).toHaveBeenCalled();
    });
  });

  describe('stop', () => {
    it('should clear polling interval', () => {
      const consumer = createTestConsumer({ pollIntervalMs: 100 });

      consumer.start();
      consumer.stop();

      // Clear mock calls
      mockStreamsClient.xreadgroup.mockClear();

      // Advance timer - should not poll after stop
      jest.advanceTimersByTime(200);

      expect(mockStreamsClient.xreadgroup).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Price Updates
  // ===========================================================================

  describe('price update consumption', () => {
    it('should emit priceUpdate for valid messages', async () => {
      const validUpdate: PriceUpdate = {
        chain: 'ethereum',
        dex: 'uniswap',
        pairKey: 'WETH-USDC',
        price: 2500,
        timestamp: Date.now(),
        token0: 'WETH',
        token1: 'USDC',
        reserve0: '1000000000000000000',
        reserve1: '2500000000',
        blockNumber: 12345,
        latency: 50,
      };

      mockStreamsClient.xreadgroup.mockResolvedValueOnce([
        { id: '123-0', data: validUpdate },
      ]);

      const consumer = createTestConsumer({ pollIntervalMs: 100 });

      const priceUpdateHandler = jest.fn();
      consumer.on('priceUpdate', priceUpdateHandler);

      consumer.start();

      // Trigger poll
      jest.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(priceUpdateHandler).toHaveBeenCalledWith(validUpdate);
      expect(mockStreamsClient.xack).toHaveBeenCalled();
    });

    it('should skip invalid price updates', async () => {
      const invalidUpdate = {
        chain: 'ethereum',
        // Missing required fields
      };

      mockStreamsClient.xreadgroup.mockResolvedValueOnce([
        { id: '123-0', data: invalidUpdate },
      ]);

      const consumer = createTestConsumer({ pollIntervalMs: 100 });

      const priceUpdateHandler = jest.fn();
      consumer.on('priceUpdate', priceUpdateHandler);

      consumer.start();

      // Trigger poll
      jest.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(priceUpdateHandler).not.toHaveBeenCalled();
      expect(logger.hasLogMatching('warn', /invalid/i)).toBe(true);
      // Should still ack invalid messages to prevent replay
      expect(mockStreamsClient.xack).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Price Update Rejection Reason (Task 6)
  // ===========================================================================

  describe('getPriceUpdateRejectionReason', () => {
    it('should return null for a valid price update', () => {
      const valid: PriceUpdate = {
        chain: 'ethereum',
        dex: 'uniswap',
        pairKey: 'WETH-USDC',
        price: 2500,
        timestamp: Date.now(),
        token0: 'WETH',
        token1: 'USDC',
        reserve0: '1000000000000000000',
        reserve1: '2500000000',
        blockNumber: 12345,
        latency: 50,
      };
      expect(getPriceUpdateRejectionReason(valid)).toBeNull();
    });

    it('should return missing_or_invalid_chain when chain is missing', () => {
      const update = { dex: 'uniswap', pairKey: 'WETH-USDC', price: 2500, timestamp: Date.now() };
      expect(getPriceUpdateRejectionReason(update)).toBe('missing_or_invalid_chain');
    });

    it('should return missing_or_invalid_dex when dex is missing', () => {
      const update = { chain: 'ethereum', pairKey: 'WETH-USDC', price: 2500, timestamp: Date.now() };
      expect(getPriceUpdateRejectionReason(update)).toBe('missing_or_invalid_dex');
    });

    it('should return missing_or_invalid_pairKey when pairKey is missing', () => {
      const update = { chain: 'ethereum', dex: 'uniswap', price: 2500, timestamp: Date.now() };
      expect(getPriceUpdateRejectionReason(update)).toBe('missing_or_invalid_pairKey');
    });

    it('should return invalid_price when price is NaN', () => {
      const update = { chain: 'ethereum', dex: 'uniswap', pairKey: 'WETH-USDC', price: NaN, timestamp: Date.now() };
      expect(getPriceUpdateRejectionReason(update)).toBe('invalid_price');
    });

    it('should return invalid_price when price is zero', () => {
      const update = { chain: 'ethereum', dex: 'uniswap', pairKey: 'WETH-USDC', price: 0, timestamp: Date.now() };
      expect(getPriceUpdateRejectionReason(update)).toBe('invalid_price');
    });

    it('should return invalid_price when price is negative', () => {
      const update = { chain: 'ethereum', dex: 'uniswap', pairKey: 'WETH-USDC', price: -5, timestamp: Date.now() };
      expect(getPriceUpdateRejectionReason(update)).toBe('invalid_price');
    });

    it('should return price_out_of_bounds when price exceeds max', () => {
      const update = { chain: 'ethereum', dex: 'uniswap', pairKey: 'WETH-USDC', price: 1e13, timestamp: Date.now() };
      expect(getPriceUpdateRejectionReason(update)).toBe('price_out_of_bounds');
    });

    it('should return price_out_of_bounds when price is below min', () => {
      const update = { chain: 'ethereum', dex: 'uniswap', pairKey: 'WETH-USDC', price: 1e-13, timestamp: Date.now() };
      expect(getPriceUpdateRejectionReason(update)).toBe('price_out_of_bounds');
    });

    it('should return invalid_timestamp when timestamp is missing', () => {
      const update = { chain: 'ethereum', dex: 'uniswap', pairKey: 'WETH-USDC', price: 2500 };
      expect(getPriceUpdateRejectionReason(update)).toBe('invalid_timestamp');
    });

    it('should return invalid_timestamp when timestamp is zero', () => {
      const update = { chain: 'ethereum', dex: 'uniswap', pairKey: 'WETH-USDC', price: 2500, timestamp: 0 };
      expect(getPriceUpdateRejectionReason(update)).toBe('invalid_timestamp');
    });

    it('should return missing_or_invalid_chain for null input', () => {
      expect(getPriceUpdateRejectionReason(null)).toBe('missing_or_invalid_chain');
    });

    it('should return missing_or_invalid_chain for non-object input', () => {
      expect(getPriceUpdateRejectionReason('not-an-object')).toBe('missing_or_invalid_chain');
    });
  });

  describe('price update rejection reason in warn log', () => {
    it('should include reason field in warn log when price update is missing dex', async () => {
      const invalidUpdate = {
        chain: 'ethereum',
        // dex is missing
        pairKey: 'WETH-USDC',
        price: 2500,
        timestamp: Date.now(),
      };

      mockStreamsClient.xreadgroup.mockResolvedValueOnce([
        { id: '123-0', data: invalidUpdate },
      ]);

      const consumer = createTestConsumer({ pollIntervalMs: 100 });

      consumer.start();

      // Trigger poll
      jest.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Verify the warn log includes the specific reason field
      expect(logger.hasLogWithMeta('warn', { reason: 'missing_or_invalid_dex' })).toBe(true);
    });

    it('should include reason field in warn log when price is out of bounds', async () => {
      const invalidUpdate = {
        chain: 'ethereum',
        dex: 'uniswap',
        pairKey: 'WETH-USDC',
        price: 1e15, // exceeds max
        timestamp: Date.now(),
      };

      mockStreamsClient.xreadgroup.mockResolvedValueOnce([
        { id: '124-0', data: invalidUpdate },
      ]);

      const consumer = createTestConsumer({ pollIntervalMs: 100 });

      consumer.start();

      // Trigger poll
      jest.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(logger.hasLogWithMeta('warn', { reason: 'price_out_of_bounds' })).toBe(true);
    });

    it('should include reason field in warn log when timestamp is invalid', async () => {
      const invalidUpdate = {
        chain: 'ethereum',
        dex: 'uniswap',
        pairKey: 'WETH-USDC',
        price: 2500,
        timestamp: -1,
      };

      mockStreamsClient.xreadgroup.mockResolvedValueOnce([
        { id: '125-0', data: invalidUpdate },
      ]);

      const consumer = createTestConsumer({ pollIntervalMs: 100 });

      consumer.start();

      // Trigger poll
      jest.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(logger.hasLogWithMeta('warn', { reason: 'invalid_timestamp' })).toBe(true);
    });
  });

  // ===========================================================================
  // Whale Alerts
  // ===========================================================================

  describe('whale alert consumption', () => {
    it('should emit whaleTransaction for valid messages', async () => {
      const validTx: WhaleTransaction = {
        chain: 'ethereum',
        usdValue: 1000000,
        direction: 'buy',
        transactionHash: '0x123',
        timestamp: Date.now(),
        token: 'WETH',
        amount: 400,
        address: '0xabc123',
        dex: 'uniswap',
        impact: 0.5,
      };

      // First call returns empty (price updates), second returns whale tx
      mockStreamsClient.xreadgroup
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: '456-0', data: validTx }]);

      const consumer = createTestConsumer({ pollIntervalMs: 100 });

      const whaleTxHandler = jest.fn();
      consumer.on('whaleTransaction', whaleTxHandler);

      consumer.start();

      // Trigger poll
      jest.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(whaleTxHandler).toHaveBeenCalledWith(validTx);
    });

    it('should skip invalid whale transactions', async () => {
      const invalidTx = {
        chain: 'ethereum',
        direction: 'invalid', // Invalid direction
      };

      mockStreamsClient.xreadgroup
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: '456-0', data: invalidTx }]);

      const consumer = createTestConsumer({ pollIntervalMs: 100 });

      const whaleTxHandler = jest.fn();
      consumer.on('whaleTransaction', whaleTxHandler);

      consumer.start();

      // Trigger poll
      jest.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(whaleTxHandler).not.toHaveBeenCalled();
      expect(logger.getLogs('warn').length).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // Pending Opportunities (FIX #15)
  // ===========================================================================

  describe('pending opportunity consumption', () => {
    // Consumer groups including pending opportunities stream
    const consumerGroupsWithPending = [
      ...consumerGroups,
      {
        streamName: 'stream:pending-opportunities',
        groupName: 'cross-chain-detector-group',
        consumerName: 'test-consumer',
      },
    ];

    it('should emit pendingOpportunity for valid messages', async () => {
      const validOpp: PendingOpportunity = {
        type: 'pending',
        intent: {
          hash: '0xabc123',
          router: '0xrouter',
          tokenIn: '0xtoken0',
          tokenOut: '0xtoken1',
          sender: '0xsender',
          chainId: 1,
          deadline: Math.floor(Date.now() / 1000) + 300,
          nonce: 42,
          slippageTolerance: 0.005,
          gasPrice: '50000000000',
          amountIn: '1000000000000000000',
          expectedAmountOut: '2500000000',
          path: ['0xtoken0', '0xtoken1'],
          type: 'uniswapV2',
          firstSeen: Date.now(),
        },
        publishedAt: Date.now(),
      };

      // First call (price updates) returns empty, second (whale) returns empty,
      // third (pending) returns the valid opportunity
      mockStreamsClient.xreadgroup
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: '789-0', data: validOpp }]);

      const consumer = createTestConsumer({ consumerGroups: consumerGroupsWithPending, pollIntervalMs: 100 });

      const pendingOppHandler = jest.fn();
      consumer.on('pendingOpportunity', pendingOppHandler);

      consumer.start();

      // Trigger poll
      jest.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(pendingOppHandler).toHaveBeenCalledWith(validOpp);
      expect(mockStreamsClient.xack).toHaveBeenCalled();
    });

    it('should skip invalid pending opportunity (missing fields) and ack message', async () => {
      const invalidOpp = {
        type: 'pending',
        intent: {
          hash: '0xabc123',
          // Missing required fields: router, tokenIn, tokenOut, etc.
        },
      };

      mockStreamsClient.xreadgroup
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: '789-0', data: invalidOpp }]);

      const consumer = createTestConsumer({ consumerGroups: consumerGroupsWithPending, pollIntervalMs: 100 });

      const pendingOppHandler = jest.fn();
      consumer.on('pendingOpportunity', pendingOppHandler);

      consumer.start();

      // Trigger poll
      jest.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(pendingOppHandler).not.toHaveBeenCalled();
      expect(logger.hasLogMatching('warn', /invalid/i)).toBe(true);
      // Should still ack invalid messages to prevent replay
      expect(mockStreamsClient.xack).toHaveBeenCalled();
    });

    it('should reject pending opportunity with missing gasPrice (Phase 2 Fix #6)', async () => {
      const oppMissingGasPrice: Record<string, unknown> = {
        type: 'pending',
        intent: {
          hash: '0xabc123',
          router: '0xrouter',
          tokenIn: '0xtoken0',
          tokenOut: '0xtoken1',
          sender: '0xsender',
          chainId: 1,
          deadline: Math.floor(Date.now() / 1000) + 300,
          nonce: 42,
          slippageTolerance: 0.005,
          // gasPrice is MISSING - should be rejected by validator
          amountIn: '1000000000000000000',
          expectedAmountOut: '2500000000',
          path: ['0xtoken0', '0xtoken1'],
          type: 'uniswapV2',
        },
      };

      mockStreamsClient.xreadgroup
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: '789-0', data: oppMissingGasPrice }]);

      const consumer = createTestConsumer({ consumerGroups: consumerGroupsWithPending, pollIntervalMs: 100 });

      const pendingOppHandler = jest.fn();
      consumer.on('pendingOpportunity', pendingOppHandler);

      consumer.start();

      // Trigger poll
      jest.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Should NOT emit because gasPrice validation fails
      expect(pendingOppHandler).not.toHaveBeenCalled();
    });

    it('should reject pending opportunity with slippageTolerance > 0.5 (Fix #12)', async () => {
      const oppHighSlippage: Record<string, unknown> = {
        type: 'pending',
        intent: {
          hash: '0xabc123',
          router: '0xrouter',
          tokenIn: '0xtoken0',
          tokenOut: '0xtoken1',
          sender: '0xsender',
          chainId: 1,
          deadline: Math.floor(Date.now() / 1000) + 300,
          nonce: 42,
          slippageTolerance: 0.6, // Exceeds 0.5 upper bound
          gasPrice: '50000000000',
          amountIn: '1000000000000000000',
          expectedAmountOut: '2500000000',
          path: ['0xtoken0', '0xtoken1'],
          type: 'uniswapV2',
        },
      };

      mockStreamsClient.xreadgroup
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: '789-0', data: oppHighSlippage }]);

      const consumer = createTestConsumer({ consumerGroups: consumerGroupsWithPending, pollIntervalMs: 100 });

      const pendingOppHandler = jest.fn();
      consumer.on('pendingOpportunity', pendingOppHandler);

      consumer.start();

      // Trigger poll
      jest.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Should NOT emit because slippageTolerance > 0.5
      expect(pendingOppHandler).not.toHaveBeenCalled();
    });

    it('should reject pending opportunity with missing intent.type (bug-hunt fix)', async () => {
      const oppMissingType: Record<string, unknown> = {
        type: 'pending',
        intent: {
          hash: '0xabc123',
          router: '0xrouter',
          // type is MISSING — would crash detector.ts intent.type.toLowerCase()
          tokenIn: '0xtoken0',
          tokenOut: '0xtoken1',
          sender: '0xsender',
          chainId: 1,
          deadline: Math.floor(Date.now() / 1000) + 300,
          nonce: 42,
          slippageTolerance: 0.005,
          gasPrice: '50000000000',
          amountIn: '1000000000000000000',
          expectedAmountOut: '2500000000',
          path: ['0xtoken0', '0xtoken1'],
          firstSeen: Date.now(),
        },
      };

      mockStreamsClient.xreadgroup
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: '789-0', data: oppMissingType }]);

      const consumer = createTestConsumer({ consumerGroups: consumerGroupsWithPending, pollIntervalMs: 100 });

      const pendingOppHandler = jest.fn();
      consumer.on('pendingOpportunity', pendingOppHandler);

      consumer.start();

      // Trigger poll
      jest.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Should NOT emit because intent.type is missing
      expect(pendingOppHandler).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Concurrency Guard
  // ===========================================================================

  describe('concurrency guard', () => {
    it('should skip poll when already consuming', async () => {
      let resolveSlowPoll: () => void;
      const slowPoll = new Promise<any[]>((resolve) => {
        resolveSlowPoll = () => resolve([]);
      });

      // All xreadgroup calls will be slow (never resolve immediately)
      mockStreamsClient.xreadgroup.mockReturnValue(slowPoll);

      const consumer = createTestConsumer({ pollIntervalMs: 50 });

      consumer.start();

      // First poll starts - calls xreadgroup twice (price + whale in parallel)
      jest.advanceTimersByTime(50);
      await Promise.resolve();

      // Both price updates and whale alerts called their xreadgroup
      expect(mockStreamsClient.xreadgroup).toHaveBeenCalledTimes(2);

      // Second interval tick - should be SKIPPED because first poll is still pending
      jest.advanceTimersByTime(50);
      await Promise.resolve();

      // Still only 2 calls - second poll was skipped due to concurrency guard
      expect(mockStreamsClient.xreadgroup).toHaveBeenCalledTimes(2);

      // Third interval tick - still skipped
      jest.advanceTimersByTime(50);
      await Promise.resolve();

      // Still only 2 calls
      expect(mockStreamsClient.xreadgroup).toHaveBeenCalledTimes(2);

      // This proves the concurrency guard is working - multiple intervals
      // didn't spawn multiple concurrent poll operations
    });

    it('should skip poll when service is not running', async () => {
      mockStateManager.isRunning.mockReturnValue(false);

      const consumer = createTestConsumer({ pollIntervalMs: 100 });

      consumer.start();

      // Trigger poll
      jest.advanceTimersByTime(100);
      await Promise.resolve();

      expect(mockStreamsClient.xreadgroup).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Error Handling
  // ===========================================================================

  describe('error handling', () => {
    it('should log errors from stream consumption but not crash', async () => {
      // Errors in consumePriceUpdates/consumeWhaleAlerts are caught internally
      // and logged, but not emitted as error events (for resilience)
      mockStreamsClient.xreadgroup.mockRejectedValue(new Error('Connection lost'));

      const consumer = createTestConsumer({ pollIntervalMs: 100 });

      consumer.start();

      // Trigger poll
      jest.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Errors are logged in the individual consume methods
      expect(logger.getLogs('error').length).toBeGreaterThan(0);
    });

    it('should not log timeout errors (they are expected)', async () => {
      mockStreamsClient.xreadgroup.mockRejectedValue(new Error('timeout'));

      const consumer = createTestConsumer({ pollIntervalMs: 100 });

      consumer.start();

      // Trigger poll
      jest.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Timeout errors should be silently ignored (not logged as errors)
      expect(logger.hasLogMatching('error', /consuming/)).toBe(false);
    });
  });
});
