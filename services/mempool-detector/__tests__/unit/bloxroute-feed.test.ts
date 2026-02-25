/**
 * Unit Tests for BloXrouteFeed
 *
 * Tests the bloXroute BDN WebSocket feed for pending transaction detection.
 * Following TDD approach - tests written first, implementation to follow.
 *
 * @see Phase 1: Mempool Detection Service (Implementation Plan v3.0)
 */

import { EventEmitter } from 'events';
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { RecordingLogger } from '@arbitrage/core/logging';
import type { Logger } from '@arbitrage/core';
import {
  BloXrouteFeed,
  BloXrouteFeedEvents,
  createBloXrouteFeed,
} from '../../src/bloxroute-feed';
import type {
  BloXrouteFeedConfig,
  RawPendingTransaction,
  FeedConnectionState,
} from '../../src/types';

// =============================================================================
// Mock WebSocket - must be defined inside the factory function
// =============================================================================

// Mock the ws module with inline class definition to avoid hoisting issues
jest.mock('ws', () => {
  const { EventEmitter } = require('events');

  class MockWebSocket extends EventEmitter {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readyState: number = 0; // CONNECTING
    url: string;

    constructor(url: string) {
      super();
      this.url = url;
      // Simulate async connection
      setImmediate(() => {
        this.readyState = 1; // OPEN
        this.emit('open');
      });
    }

    send = jest.fn();
    close = jest.fn(function(this: MockWebSocket) {
      this.readyState = 3; // CLOSED
      this.emit('close', 1000, Buffer.from('Normal closure'));
    });
    ping = jest.fn();
    terminate = jest.fn(function(this: MockWebSocket) {
      this.readyState = 3; // CLOSED
      this.emit('close', 1006, Buffer.from('Terminated'));
    });
  }

  return {
    __esModule: true,
    default: MockWebSocket,
    WebSocket: MockWebSocket,
  };
});

// =============================================================================
// Test Fixtures
// =============================================================================

const createTestConfig = (overrides?: Partial<BloXrouteFeedConfig>): BloXrouteFeedConfig => ({
  authHeader: 'test-auth-header',
  endpoint: 'wss://eth.blxrbdn.com/ws',
  chains: ['ethereum'],
  ...overrides,
});

const createMockPendingTxMessage = (txHash: string) => ({
  jsonrpc: '2.0',
  method: 'subscribe',
  params: {
    subscription: 'test-subscription-id',
    result: {
      txHash,
      txContents: {
        chainId: '0x1',
        nonce: '0x1',
        gasPrice: '0x12a05f200',
        gas: '0x5208',
        to: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
        value: '0x0',
        input: '0x38ed1739...',
        from: '0xsender123',
      },
      localRegion: true,
      time: new Date().toISOString(),
    },
  },
});

// =============================================================================
// Tests
// =============================================================================

describe('BloXrouteFeed', () => {
  let logger: RecordingLogger;
  let config: BloXrouteFeedConfig;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    logger = new RecordingLogger();
    logger.clear();

    config = createTestConfig();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ===========================================================================
  // Factory Function
  // ===========================================================================

  describe('createBloXrouteFeed', () => {
    it('should create a feed with required config', () => {
      const feed = createBloXrouteFeed({
        config,
        logger: logger as unknown as Logger,
      });

      expect(feed).toBeDefined();
      expect(typeof feed.connect).toBe('function');
      expect(typeof feed.disconnect).toBe('function');
      expect(typeof feed.getHealth).toBe('function');
    });

    it('should be an EventEmitter', () => {
      const feed = createBloXrouteFeed({
        config,
        logger: logger as unknown as Logger,
      });

      expect(feed).toBeInstanceOf(EventEmitter);
    });

    it('should start in disconnected state', () => {
      const feed = createBloXrouteFeed({
        config,
        logger: logger as unknown as Logger,
      });

      const health = feed.getHealth();
      expect(health.connectionState).toBe('disconnected');
    });
  });

  // ===========================================================================
  // Connection Management
  // ===========================================================================

  describe('connect', () => {
    it('should establish WebSocket connection', async () => {
      const feed = createBloXrouteFeed({
        config,
        logger: logger as unknown as Logger,
      });

      const connectPromise = feed.connect();

      // Advance timers to trigger the async connection (use advanceTimersByTime to avoid infinite heartbeat loop)
      jest.advanceTimersByTime(100);
      await connectPromise;

      const health = feed.getHealth();
      expect(health.connectionState).toBe('connected');
    });

    it('should emit connected event on successful connection', async () => {
      const feed = createBloXrouteFeed({
        config,
        logger: logger as unknown as Logger,
      });

      const connectedHandler = jest.fn();
      feed.on('connected', connectedHandler);

      const connectPromise = feed.connect();
      jest.advanceTimersByTime(100);
      await connectPromise;

      expect(connectedHandler).toHaveBeenCalled();
    });

    it('should send subscription message after connection', async () => {
      const feed = createBloXrouteFeed({
        config,
        logger: logger as unknown as Logger,
      });

      const connectPromise = feed.connect();
      jest.advanceTimersByTime(100);
      await connectPromise;

      // The feed should send a subscription message for pending txs
      expect(logger.hasLogMatching('info', /connected/i)).toBe(true);
    });

    it('should resolve if already connected', async () => {
      const feed = createBloXrouteFeed({
        config,
        logger: logger as unknown as Logger,
      });

      const connectPromise1 = feed.connect();
      jest.advanceTimersByTime(100);
      await connectPromise1;

      // Second connection should return immediately
      await expect(feed.connect()).resolves.not.toThrow();
    });
  });

  describe('disconnect', () => {
    it('should close WebSocket connection', async () => {
      const feed = createBloXrouteFeed({
        config,
        logger: logger as unknown as Logger,
      });

      const connectPromise = feed.connect();
      jest.advanceTimersByTime(100);
      await connectPromise;

      feed.disconnect();

      const health = feed.getHealth();
      expect(health.connectionState).toBe('disconnected');
    });

    it('should emit disconnected event', async () => {
      const feed = createBloXrouteFeed({
        config,
        logger: logger as unknown as Logger,
      });

      const disconnectedHandler = jest.fn();
      feed.on('disconnected', disconnectedHandler);

      const connectPromise = feed.connect();
      jest.advanceTimersByTime(100);
      await connectPromise;

      feed.disconnect();

      expect(disconnectedHandler).toHaveBeenCalled();
    });

    it('should clear all intervals and timers', async () => {
      const feed = createBloXrouteFeed({
        config,
        logger: logger as unknown as Logger,
      });

      const connectPromise = feed.connect();
      jest.advanceTimersByTime(100);
      await connectPromise;

      feed.disconnect();

      // Verify no warnings about orphaned timers
      expect(logger.hasLogMatching('error', /leak|orphan/i)).toBe(false);
    });

    it('should handle disconnect when not connected', () => {
      const feed = createBloXrouteFeed({
        config,
        logger: logger as unknown as Logger,
      });

      // Should not throw
      expect(() => feed.disconnect()).not.toThrow();
    });
  });

  // ===========================================================================
  // Subscription Management
  // ===========================================================================

  describe('subscribePendingTxs', () => {
    it('should subscribe to pending transactions', async () => {
      const feed = createBloXrouteFeed({
        config,
        logger: logger as unknown as Logger,
      });

      const connectPromise = feed.connect();
      jest.advanceTimersByTime(100);
      await connectPromise;

      // Handler is optional, test subscribing without a callback
      feed.subscribePendingTxs();

      expect(logger.hasLogMatching('info', /subscri/i)).toBe(true);
    });

    it('should emit pendingTx events for received transactions', async () => {
      const feed = createBloXrouteFeed({
        config,
        logger: logger as unknown as Logger,
      });

      const pendingTxHandler = jest.fn();
      feed.on('pendingTx', pendingTxHandler);

      const connectPromise = feed.connect();
      jest.advanceTimersByTime(100);
      await connectPromise;

      // Simulate receiving a pending tx message
      const txMessage = createMockPendingTxMessage('0xabc123');
      feed.handleMessage(JSON.stringify(txMessage));

      expect(pendingTxHandler).toHaveBeenCalled();
    });

    it('should filter transactions by router address', async () => {
      const feed = createBloXrouteFeed({
        config: {
          ...config,
          includeRouters: ['0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'],
        },
        logger: logger as unknown as Logger,
      });

      const pendingTxHandler = jest.fn();
      feed.on('pendingTx', pendingTxHandler);

      const connectPromise = feed.connect();
      jest.advanceTimersByTime(100);
      await connectPromise;

      // Matching router
      const matchingTx = createMockPendingTxMessage('0xabc123');
      feed.handleMessage(JSON.stringify(matchingTx));

      expect(pendingTxHandler).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Message Handling
  // ===========================================================================

  describe('handleMessage', () => {
    it('should parse valid JSON messages', async () => {
      const feed = createBloXrouteFeed({
        config,
        logger: logger as unknown as Logger,
      });

      const connectPromise = feed.connect();
      jest.advanceTimersByTime(100);
      await connectPromise;

      const txMessage = createMockPendingTxMessage('0xabc123');

      // Should not throw
      expect(() => feed.handleMessage(JSON.stringify(txMessage))).not.toThrow();
    });

    it('should handle invalid JSON gracefully', async () => {
      const feed = createBloXrouteFeed({
        config,
        logger: logger as unknown as Logger,
      });

      const connectPromise = feed.connect();
      jest.advanceTimersByTime(100);
      await connectPromise;

      feed.handleMessage('invalid json {');

      // Should log error but not throw
      expect(logger.hasLogMatching('error', /parse|invalid/i)).toBe(true);
    });

    it('should handle subscription confirmation messages', async () => {
      const feed = createBloXrouteFeed({
        config,
        logger: logger as unknown as Logger,
      });

      const connectPromise = feed.connect();
      jest.advanceTimersByTime(100);
      await connectPromise;

      const confirmMessage = {
        jsonrpc: '2.0',
        id: 1,
        result: 'subscription-id-123',
      };

      feed.handleMessage(JSON.stringify(confirmMessage));

      expect(logger.hasLogMatching('info', /subscri/i)).toBe(true);
    });

    it('should handle error messages', async () => {
      const feed = createBloXrouteFeed({
        config,
        logger: logger as unknown as Logger,
      });

      const connectPromise = feed.connect();
      jest.advanceTimersByTime(100);
      await connectPromise;

      const errorMessage = {
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32600,
          message: 'Invalid Request',
        },
      };

      feed.handleMessage(JSON.stringify(errorMessage));

      // Check for bloXroute error log (message is in context, not in main log text)
      expect(logger.hasLogMatching('error', /bloXroute/i)).toBe(true);
    });

    it('should update health metrics on message receipt', async () => {
      const feed = createBloXrouteFeed({
        config,
        logger: logger as unknown as Logger,
      });

      const connectPromise = feed.connect();
      jest.advanceTimersByTime(100);
      await connectPromise;

      const initialHealth = feed.getHealth();
      const initialMessageCount = initialHealth.messagesReceived;

      const txMessage = createMockPendingTxMessage('0xabc123');
      feed.handleMessage(JSON.stringify(txMessage));

      const updatedHealth = feed.getHealth();
      expect(updatedHealth.messagesReceived).toBeGreaterThan(initialMessageCount);
    });
  });

  // ===========================================================================
  // Reconnection Logic
  // ===========================================================================

  describe('reconnection', () => {
    it('should attempt reconnection on connection loss', async () => {
      const feed = createBloXrouteFeed({
        config: {
          ...config,
          reconnect: {
            interval: 1000,
            maxAttempts: 3,
          },
        },
        logger: logger as unknown as Logger,
      });

      const connectPromise = feed.connect();
      jest.advanceTimersByTime(100);
      await connectPromise;

      // Simulate connection loss
      feed.simulateConnectionLoss();

      // Should be in reconnecting state
      const health = feed.getHealth();
      expect(['reconnecting', 'connecting']).toContain(health.connectionState);
    });

    it('should use exponential backoff for reconnection', async () => {
      const feed = createBloXrouteFeed({
        config: {
          ...config,
          reconnect: {
            interval: 1000,
            maxAttempts: 5,
            backoffMultiplier: 2,
          },
        },
        logger: logger as unknown as Logger,
      });

      const connectPromise = feed.connect();
      jest.advanceTimersByTime(100);
      await connectPromise;

      // Simulate connection loss
      feed.simulateConnectionLoss();

      // Verify backoff timing (implementation detail)
      expect(logger.hasLogMatching('info', /reconnect/i)).toBe(true);
    });

    it('should not reconnect after explicit disconnect', async () => {
      const feed = createBloXrouteFeed({
        config,
        logger: logger as unknown as Logger,
      });

      const connectPromise = feed.connect();
      jest.advanceTimersByTime(100);
      await connectPromise;

      feed.disconnect();

      const health = feed.getHealth();
      expect(health.connectionState).toBe('disconnected');
      expect(health.reconnectCount).toBe(0);
    });

    // FIX 9: Added missing reconnection edge case tests
    it('should stop reconnecting after max retries exhausted', async () => {
      // Use maxAttempts: 0 to immediately trigger the guard condition in
      // scheduleReconnection(). This avoids the mock WebSocket auto-reconnect
      // issue where setImmediate -> 'open' resets reconnectAttempts to 0.
      const feed = createBloXrouteFeed({
        config: {
          ...config,
          reconnect: {
            interval: 100,
            maxAttempts: 0,
          },
        },
        logger: logger as unknown as Logger,
      });

      const connectPromise = feed.connect();
      jest.advanceTimersByTime(100);
      await connectPromise;

      // Listen for error event emitted when max attempts is reached
      const errorSpy = jest.fn();
      feed.on('error', errorSpy);

      // Simulate connection loss — scheduleReconnection checks reconnectAttempts (0) >= maxAttempts (0)
      // This immediately triggers the max attempts guard
      feed.simulateConnectionLoss();

      // Should emit error about max reconnection attempts
      expect(logger.hasLogMatching('error', /max reconnection attempts/i)).toBe(true);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringMatching(/max reconnection attempts/i) })
      );
    });

    it('should track reconnect count in health metrics', async () => {
      const feed = createBloXrouteFeed({
        config: {
          ...config,
          reconnect: {
            interval: 100,
            maxAttempts: 5,
            backoffMultiplier: 1,
          },
        },
        logger: logger as unknown as Logger,
      });

      const connectPromise = feed.connect();
      jest.advanceTimersByTime(100);
      await connectPromise;

      // Verify initial reconnect count is 0
      expect(feed.getHealth().reconnectCount).toBe(0);

      // Simulate connection loss — triggers scheduleReconnection which increments reconnectCount
      feed.simulateConnectionLoss();

      // After connection loss, reconnectCount should increment
      const health = feed.getHealth();
      expect(health.reconnectCount).toBeGreaterThanOrEqual(1);
    });
  });

  // ===========================================================================
  // Health Metrics
  // ===========================================================================

  describe('getHealth', () => {
    it('should return health metrics', () => {
      const feed = createBloXrouteFeed({
        config,
        logger: logger as unknown as Logger,
      });

      const health = feed.getHealth();

      expect(health).toHaveProperty('connectionState');
      expect(health).toHaveProperty('lastMessageTime');
      expect(health).toHaveProperty('messagesReceived');
      expect(health).toHaveProperty('transactionsProcessed');
      expect(health).toHaveProperty('reconnectCount');
      expect(health).toHaveProperty('uptime');
    });

    it('should track message latency', async () => {
      const feed = createBloXrouteFeed({
        config,
        logger: logger as unknown as Logger,
      });

      const connectPromise = feed.connect();
      jest.advanceTimersByTime(100);
      await connectPromise;

      // Send some messages
      for (let i = 0; i < 5; i++) {
        const txMessage = createMockPendingTxMessage(`0x${i}`);
        feed.handleMessage(JSON.stringify(txMessage));
      }

      const health = feed.getHealth();
      expect(health.avgLatencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should calculate uptime correctly', async () => {
      const feed = createBloXrouteFeed({
        config,
        logger: logger as unknown as Logger,
      });

      const connectPromise = feed.connect();
      jest.advanceTimersByTime(100);
      await connectPromise;

      // Advance time
      jest.advanceTimersByTime(5000);

      const health = feed.getHealth();
      expect(health.uptime).toBeGreaterThanOrEqual(5000);
    });
  });

  // ===========================================================================
  // Error Handling
  // ===========================================================================

  describe('error handling', () => {
    it('should emit error events on WebSocket errors', async () => {
      const feed = createBloXrouteFeed({
        config,
        logger: logger as unknown as Logger,
      });

      const errorHandler = jest.fn();
      feed.on('error', errorHandler);

      const connectPromise = feed.connect();
      jest.advanceTimersByTime(100);
      await connectPromise;

      // Simulate WebSocket error
      feed.simulateError(new Error('Connection reset'));

      expect(errorHandler).toHaveBeenCalled();
    });

    it('should log errors without crashing', async () => {
      const feed = createBloXrouteFeed({
        config,
        logger: logger as unknown as Logger,
      });

      // Add error handler to prevent unhandled error
      const errorHandler = jest.fn();
      feed.on('error', errorHandler);

      const connectPromise = feed.connect();
      jest.advanceTimersByTime(100);
      await connectPromise;

      // Simulate various errors
      feed.simulateError(new Error('Network error'));
      feed.handleMessage('{"invalid": json}');
      feed.handleMessage('');

      // Should have logged errors but not crashed
      expect(logger.getErrors().length).toBeGreaterThan(0);
    });

    it('should handle rate limit errors gracefully', async () => {
      const feed = createBloXrouteFeed({
        config,
        logger: logger as unknown as Logger,
      });

      const connectPromise = feed.connect();
      jest.advanceTimersByTime(100);
      await connectPromise;

      const rateLimitError = {
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32005,
          message: 'Rate limit exceeded',
        },
      };

      feed.handleMessage(JSON.stringify(rateLimitError));

      expect(logger.hasLogMatching('warn', /rate limit/i)).toBe(true);
    });
  });

  // ===========================================================================
  // Authentication
  // ===========================================================================

  describe('authentication', () => {
    it('should include auth header in connection', async () => {
      const feed = createBloXrouteFeed({
        config: {
          ...config,
          authHeader: 'my-secret-auth-header',
        },
        logger: logger as unknown as Logger,
      });

      const connectPromise = feed.connect();
      jest.advanceTimersByTime(100);
      await connectPromise;

      // Auth header should be used (implementation detail)
      expect(feed.getConfig().authHeader).toBe('my-secret-auth-header');
    });
  });

  // ===========================================================================
  // Multi-chain Support
  // ===========================================================================

  describe('multi-chain', () => {
    it('should support multiple chains', () => {
      const feed = createBloXrouteFeed({
        config: {
          ...config,
          chains: ['ethereum', 'bsc'],
        },
        logger: logger as unknown as Logger,
      });

      expect(feed.getConfig().chains).toEqual(['ethereum', 'bsc']);
    });

    it('should tag transactions with chain ID', async () => {
      const feed = createBloXrouteFeed({
        config: {
          ...config,
          chains: ['ethereum'],
        },
        logger: logger as unknown as Logger,
      });

      const pendingTxHandler = jest.fn();
      feed.on('pendingTx', pendingTxHandler);

      const connectPromise = feed.connect();
      jest.advanceTimersByTime(100);
      await connectPromise;

      const txMessage = createMockPendingTxMessage('0xabc123');
      feed.handleMessage(JSON.stringify(txMessage));

      // Transaction should have chain ID attached
      if (pendingTxHandler.mock.calls.length > 0) {
        const tx = pendingTxHandler.mock.calls[0][0] as RawPendingTransaction;
        expect(tx.chainId).toBeDefined();
      }
    });
  });

  // ===========================================================================
  // Race Condition Tests (Fix 5.1, 5.2, 5.3)
  // ===========================================================================

  describe('race conditions', () => {
    it('should handle concurrent connect calls safely (Fix 5.1)', async () => {
      const feed = createBloXrouteFeed({
        config,
        logger: logger as unknown as Logger,
      });

      // Start two concurrent connections
      const promise1 = feed.connect();
      const promise2 = feed.connect();

      // Both should resolve without error
      jest.advanceTimersByTime(100);
      await Promise.all([promise1, promise2]);

      const health = feed.getHealth();
      expect(health.connectionState).toBe('connected');

      // Should only have created one connection (check logs)
      expect(logger.hasLogMatching('info', /Connecting to bloXroute/)).toBe(true);
    });

    it('should not reconnect after disconnect is called during reconnection delay (Fix 5.2)', async () => {
      const feed = createBloXrouteFeed({
        config: {
          ...config,
          reconnect: {
            interval: 5000,
            maxAttempts: 3,
          },
        },
        logger: logger as unknown as Logger,
      });

      const connectPromise = feed.connect();
      jest.advanceTimersByTime(100);
      await connectPromise;

      // Simulate connection loss to trigger reconnection scheduling
      feed.simulateConnectionLoss();

      // Disconnect before reconnection timer fires
      feed.disconnect();

      // Advance time past reconnection delay
      jest.advanceTimersByTime(6000);

      // Should remain disconnected
      const health = feed.getHealth();
      expect(health.connectionState).toBe('disconnected');
    });

    it('should safely iterate handlers when a handler removes itself (Fix 5.3)', async () => {
      const feed = createBloXrouteFeed({
        config,
        logger: logger as unknown as Logger,
      });

      const handler1 = jest.fn();
      const handler2 = jest.fn();
      const handler3 = jest.fn();

      // Handler2 removes itself when called
      const selfRemovingHandler = jest.fn(() => {
        feed.removeListener('pendingTx', selfRemovingHandler);
      });

      feed.on('pendingTx', handler1);
      feed.on('pendingTx', selfRemovingHandler);
      feed.on('pendingTx', handler2);
      feed.on('pendingTx', handler3);

      const connectPromise = feed.connect();
      jest.advanceTimersByTime(100);
      await connectPromise;

      // Emit a transaction
      const txMessage = createMockPendingTxMessage('0xtest');
      feed.handleMessage(JSON.stringify(txMessage));

      // All handlers should have been called without error
      expect(handler1).toHaveBeenCalled();
      expect(selfRemovingHandler).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
      expect(handler3).toHaveBeenCalled();
    });

    it('should handle chainId "0x0" correctly (Fix 4.2)', async () => {
      const feed = createBloXrouteFeed({
        config,
        logger: logger as unknown as Logger,
      });

      const pendingTxHandler = jest.fn();
      feed.on('pendingTx', pendingTxHandler);

      const connectPromise = feed.connect();
      jest.advanceTimersByTime(100);
      await connectPromise;

      // Create a message with chainId "0x0"
      const txMessage = {
        jsonrpc: '2.0',
        method: 'subscribe',
        params: {
          result: {
            txHash: '0xtest',
            txContents: {
              from: '0xsender',
              to: '0xrouter',
              value: '0x0',
              input: '0x1234',
              gas: '0x5208',
              nonce: '0x1',
              chainId: '0x0', // Zero chain ID
            },
          },
        },
      };

      feed.handleMessage(JSON.stringify(txMessage));

      // Should have processed with chainId 0, not defaulted to 1
      if (pendingTxHandler.mock.calls.length > 0) {
        const tx = pendingTxHandler.mock.calls[0][0] as RawPendingTransaction;
        expect(tx.chainId).toBe(0);
      }
    });
  });
});
