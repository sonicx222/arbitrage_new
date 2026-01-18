/**
 * Unit Tests for StreamConsumer
 *
 * Tests the stream consumption module extracted from CrossChainDetectorService.
 */

import { EventEmitter } from 'events';
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createStreamConsumer,
  StreamConsumer,
} from '../../stream-consumer';
import { PriceUpdate, WhaleTransaction } from '@arbitrage/types';

// =============================================================================
// Tests
// =============================================================================

describe('StreamConsumer', () => {
  let mockLogger: {
    info: jest.Mock;
    error: jest.Mock;
    warn: jest.Mock;
    debug: jest.Mock;
  };
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

    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    };

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

  // ===========================================================================
  // Creation
  // ===========================================================================

  describe('createStreamConsumer', () => {
    it('should create consumer with required config', () => {
      const consumer = createStreamConsumer({
        instanceId: 'test-instance',
        streamsClient: mockStreamsClient as any,
        stateManager: mockStateManager as any,
        logger: mockLogger,
        consumerGroups,
      });

      expect(consumer).toBeDefined();
      expect(typeof consumer.createConsumerGroups).toBe('function');
      expect(typeof consumer.start).toBe('function');
      expect(typeof consumer.stop).toBe('function');
    });

    it('should be an EventEmitter', () => {
      const consumer = createStreamConsumer({
        instanceId: 'test-instance',
        streamsClient: mockStreamsClient as any,
        stateManager: mockStateManager as any,
        logger: mockLogger,
        consumerGroups,
      });

      expect(consumer).toBeInstanceOf(EventEmitter);
    });
  });

  // ===========================================================================
  // Consumer Groups
  // ===========================================================================

  describe('createConsumerGroups', () => {
    it('should create all configured consumer groups', async () => {
      const consumer = createStreamConsumer({
        instanceId: 'test-instance',
        streamsClient: mockStreamsClient as any,
        stateManager: mockStateManager as any,
        logger: mockLogger,
        consumerGroups,
      });

      await consumer.createConsumerGroups();

      expect(mockStreamsClient.createConsumerGroup).toHaveBeenCalledTimes(2);
    });

    it('should handle errors gracefully', async () => {
      mockStreamsClient.createConsumerGroup.mockRejectedValue(new Error('Redis error'));

      const consumer = createStreamConsumer({
        instanceId: 'test-instance',
        streamsClient: mockStreamsClient as any,
        stateManager: mockStateManager as any,
        logger: mockLogger,
        consumerGroups,
      });

      await consumer.createConsumerGroups();

      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // start / stop
  // ===========================================================================

  describe('start', () => {
    it('should start polling interval', () => {
      const consumer = createStreamConsumer({
        instanceId: 'test-instance',
        streamsClient: mockStreamsClient as any,
        stateManager: mockStateManager as any,
        logger: mockLogger,
        consumerGroups,
        pollIntervalMs: 100,
      });

      consumer.start();

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Starting'),
        expect.any(Object)
      );
    });

    it('should poll streams at configured interval', async () => {
      const consumer = createStreamConsumer({
        instanceId: 'test-instance',
        streamsClient: mockStreamsClient as any,
        stateManager: mockStateManager as any,
        logger: mockLogger,
        consumerGroups,
        pollIntervalMs: 100,
      });

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
      const consumer = createStreamConsumer({
        instanceId: 'test-instance',
        streamsClient: mockStreamsClient as any,
        stateManager: mockStateManager as any,
        logger: mockLogger,
        consumerGroups,
        pollIntervalMs: 100,
      });

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

      const consumer = createStreamConsumer({
        instanceId: 'test-instance',
        streamsClient: mockStreamsClient as any,
        stateManager: mockStateManager as any,
        logger: mockLogger,
        consumerGroups,
        pollIntervalMs: 100,
      });

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

      const consumer = createStreamConsumer({
        instanceId: 'test-instance',
        streamsClient: mockStreamsClient as any,
        stateManager: mockStateManager as any,
        logger: mockLogger,
        consumerGroups,
        pollIntervalMs: 100,
      });

      const priceUpdateHandler = jest.fn();
      consumer.on('priceUpdate', priceUpdateHandler);

      consumer.start();

      // Trigger poll
      jest.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(priceUpdateHandler).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('invalid'),
        expect.any(Object)
      );
      // Should still ack invalid messages to prevent replay
      expect(mockStreamsClient.xack).toHaveBeenCalled();
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

      const consumer = createStreamConsumer({
        instanceId: 'test-instance',
        streamsClient: mockStreamsClient as any,
        stateManager: mockStateManager as any,
        logger: mockLogger,
        consumerGroups,
        pollIntervalMs: 100,
      });

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

      const consumer = createStreamConsumer({
        instanceId: 'test-instance',
        streamsClient: mockStreamsClient as any,
        stateManager: mockStateManager as any,
        logger: mockLogger,
        consumerGroups,
        pollIntervalMs: 100,
      });

      const whaleTxHandler = jest.fn();
      consumer.on('whaleTransaction', whaleTxHandler);

      consumer.start();

      // Trigger poll
      jest.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(whaleTxHandler).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalled();
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

      const consumer = createStreamConsumer({
        instanceId: 'test-instance',
        streamsClient: mockStreamsClient as any,
        stateManager: mockStateManager as any,
        logger: mockLogger,
        consumerGroups,
        pollIntervalMs: 50,
      });

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

      const consumer = createStreamConsumer({
        instanceId: 'test-instance',
        streamsClient: mockStreamsClient as any,
        stateManager: mockStateManager as any,
        logger: mockLogger,
        consumerGroups,
        pollIntervalMs: 100,
      });

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

      const consumer = createStreamConsumer({
        instanceId: 'test-instance',
        streamsClient: mockStreamsClient as any,
        stateManager: mockStateManager as any,
        logger: mockLogger,
        consumerGroups,
        pollIntervalMs: 100,
      });

      consumer.start();

      // Trigger poll
      jest.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Errors are logged in the individual consume methods
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should not log timeout errors (they are expected)', async () => {
      mockStreamsClient.xreadgroup.mockRejectedValue(new Error('timeout'));

      const consumer = createStreamConsumer({
        instanceId: 'test-instance',
        streamsClient: mockStreamsClient as any,
        stateManager: mockStateManager as any,
        logger: mockLogger,
        consumerGroups,
        pollIntervalMs: 100,
      });

      consumer.start();

      // Trigger poll
      jest.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Timeout errors should be silently ignored (not logged as errors)
      expect(mockLogger.error).not.toHaveBeenCalledWith(
        expect.stringContaining('consuming'),
        expect.any(Object)
      );
    });
  });
});
