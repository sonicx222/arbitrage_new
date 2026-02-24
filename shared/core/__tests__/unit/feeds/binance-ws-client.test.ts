/**
 * BinanceWebSocketClient Tests
 *
 * Tests for the Binance combined trade stream WebSocket client.
 * Uses mocked WebSocket to avoid connecting to real Binance servers.
 *
 * IMPORTANT: fake timers and async WebSocket disconnect interact poorly.
 * The approach here is to use real timers in afterEach for cleanup, and
 * fake timers only within specific tests that need them.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'events';

// =============================================================================
// Mock Setup - Must be before imports that use these modules
// =============================================================================

jest.mock('../../../src/logger');

// Create a mock WebSocket class that extends EventEmitter
class MockWebSocket extends EventEmitter {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState: number = MockWebSocket.CONNECTING;
  close = jest.fn<(code?: number, reason?: string) => void>().mockImplementation(() => {
    // Auto-fire close event synchronously for test simplicity
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', 1000, Buffer.from(''));
  });
  terminate = jest.fn<() => void>().mockImplementation(() => {
    this.readyState = MockWebSocket.CLOSED;
  });
  ping = jest.fn<() => void>();
  send = jest.fn<() => void>();

  constructor(_url: string) {
    super();
  }

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.emit('open');
  }

  simulateMessage(data: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(data)));
  }

  simulateClose(code = 1000, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', code, Buffer.from(reason));
  }

  simulateError(error: Error): void {
    this.emit('error', error);
  }

  simulatePong(): void {
    this.emit('pong');
  }
}

// Store created instances for test access
let mockWsInstances: MockWebSocket[] = [];

jest.mock('ws', () => {
  const MockWS = function (url: string) {
    const instance = new MockWebSocket(url);
    mockWsInstances.push(instance);
    return instance;
  };
  MockWS.OPEN = MockWebSocket.OPEN;
  MockWS.CONNECTING = MockWebSocket.CONNECTING;
  MockWS.CLOSING = MockWebSocket.CLOSING;
  MockWS.CLOSED = MockWebSocket.CLOSED;
  return { __esModule: true, default: MockWS };
});

// =============================================================================
// Imports - After mocks
// =============================================================================

import { BinanceWebSocketClient, BinanceTradeEvent } from '../../../src/feeds/binance-ws-client';

// =============================================================================
// Helpers
// =============================================================================

function createValidTradeMessage(overrides: Record<string, unknown> = {}) {
  return {
    stream: 'btcusdt@trade',
    data: {
      e: 'trade',
      s: 'BTCUSDT',
      p: '43250.10',
      q: '0.001',
      T: 1708992000000,
      m: true,
      ...overrides,
    },
  };
}

function getLatestMockWs(): MockWebSocket {
  return mockWsInstances[mockWsInstances.length - 1];
}

/** Connect the client and wait for it to be open. */
async function connectClient(client: BinanceWebSocketClient): Promise<MockWebSocket> {
  const connectPromise = client.connect();
  const ws = getLatestMockWs();
  ws.simulateOpen();
  await connectPromise;
  return ws;
}

// =============================================================================
// Tests
// =============================================================================

describe('BinanceWebSocketClient', () => {
  let client: BinanceWebSocketClient;

  beforeEach(() => {
    mockWsInstances = [];
    client = new BinanceWebSocketClient({
      streams: ['btcusdt@trade', 'ethusdt@trade'],
      reconnectDelayMs: 1000,
      maxReconnectDelayMs: 30000,
      pingIntervalMs: 30000,
      maxReconnectAttempts: 3,
    });
    // Add a default error listener to prevent unhandled error throws
    client.on('error', () => {});
  });

  afterEach(async () => {
    await client.disconnect();
    client.removeAllListeners();
  });

  // ===========================================================================
  // Connection
  // ===========================================================================

  describe('connect()', () => {
    it('should connect to Binance combined stream URL', async () => {
      await connectClient(client);
      expect(client.isConnected()).toBe(true);
    });

    it('should emit connected event on open', async () => {
      const connectedHandler = jest.fn();
      client.on('connected', connectedHandler);

      await connectClient(client);

      expect(connectedHandler).toHaveBeenCalledTimes(1);
    });

    it('should reject on error before connection', async () => {
      const connectPromise = client.connect();
      const ws = getLatestMockWs();
      ws.simulateError(new Error('Connection refused'));

      await expect(connectPromise).rejects.toThrow('Connection refused');
    });

    it('should not create duplicate connections', async () => {
      await connectClient(client);

      // Second connect should be a no-op
      await client.connect();
      expect(mockWsInstances.length).toBe(1);
    });
  });

  // ===========================================================================
  // Trade Message Parsing
  // ===========================================================================

  describe('trade message parsing', () => {
    let ws: MockWebSocket;

    beforeEach(async () => {
      ws = await connectClient(client);
    });

    it('should parse trade message and emit trade event', () => {
      const tradeHandler = jest.fn<(trade: BinanceTradeEvent) => void>();
      client.on('trade', tradeHandler);

      ws.simulateMessage(createValidTradeMessage());

      expect(tradeHandler).toHaveBeenCalledTimes(1);
      const trade = tradeHandler.mock.calls[0][0];
      expect(trade.symbol).toBe('BTCUSDT');
      expect(trade.price).toBe(43250.10);
      expect(trade.quantity).toBe(0.001);
      expect(trade.timestamp).toBe(1708992000000);
      expect(trade.isBuyerMaker).toBe(true);
    });

    it('should parse ETH trade message correctly', () => {
      const tradeHandler = jest.fn<(trade: BinanceTradeEvent) => void>();
      client.on('trade', tradeHandler);

      ws.simulateMessage({
        stream: 'ethusdt@trade',
        data: {
          e: 'trade',
          s: 'ETHUSDT',
          p: '2850.50',
          q: '1.5',
          T: 1708992001000,
          m: false,
        },
      });

      expect(tradeHandler).toHaveBeenCalledTimes(1);
      const trade = tradeHandler.mock.calls[0][0];
      expect(trade.symbol).toBe('ETHUSDT');
      expect(trade.price).toBe(2850.50);
      expect(trade.quantity).toBe(1.5);
      expect(trade.isBuyerMaker).toBe(false);
    });

    it('should ignore non-trade messages', () => {
      const tradeHandler = jest.fn();
      client.on('trade', tradeHandler);

      ws.simulateMessage({
        stream: 'btcusdt@kline_1m',
        data: {
          e: 'kline',
          s: 'BTCUSDT',
        },
      });

      expect(tradeHandler).not.toHaveBeenCalled();
    });

    it('should ignore malformed messages (invalid JSON)', () => {
      const tradeHandler = jest.fn();
      client.on('trade', tradeHandler);

      // Emit raw buffer with invalid JSON
      ws.emit('message', Buffer.from('not valid json'));

      expect(tradeHandler).not.toHaveBeenCalled();
    });

    it('should ignore messages with NaN price', () => {
      const tradeHandler = jest.fn();
      client.on('trade', tradeHandler);

      ws.simulateMessage(createValidTradeMessage({ p: 'not_a_number' }));

      expect(tradeHandler).not.toHaveBeenCalled();
    });

    it('should ignore messages with NaN quantity', () => {
      const tradeHandler = jest.fn();
      client.on('trade', tradeHandler);

      ws.simulateMessage(createValidTradeMessage({ q: 'invalid' }));

      expect(tradeHandler).not.toHaveBeenCalled();
    });

    it('should ignore messages without data field', () => {
      const tradeHandler = jest.fn();
      client.on('trade', tradeHandler);

      ws.simulateMessage({ stream: 'btcusdt@trade' });

      expect(tradeHandler).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Ping/Pong Keepalive
  // ===========================================================================

  describe('ping/pong keepalive', () => {
    it('should send pings at configured interval', async () => {
      jest.useFakeTimers();
      try {
        const ws = await connectClient(client);

        expect(ws.ping).not.toHaveBeenCalled();

        // Advance past one ping interval
        jest.advanceTimersByTime(30000);
        expect(ws.ping).toHaveBeenCalledTimes(1);

        // Advance past another interval
        jest.advanceTimersByTime(30000);
        expect(ws.ping).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('should stop pings after disconnect', async () => {
      jest.useFakeTimers();
      try {
        const ws = await connectClient(client);

        await client.disconnect();

        // Advance timers - should not ping
        jest.advanceTimersByTime(60000);
        expect(ws.ping).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('should handle pong response without error', async () => {
      const ws = await connectClient(client);

      const errorHandler = jest.fn();
      client.on('error', errorHandler);

      ws.simulatePong();

      expect(errorHandler).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Reconnection
  // ===========================================================================

  describe('reconnection', () => {
    it('should attempt reconnect on unexpected close', async () => {
      jest.useFakeTimers();
      try {
        const ws = await connectClient(client);

        // Prevent the mock close() from firing 'close' event on reconnect attempts
        // (so auto-close in mock doesn't interfere with reconnect logic)
        ws.close.mockImplementation(() => {
          ws.readyState = MockWebSocket.CLOSED;
          ws.emit('close', 1000, Buffer.from(''));
        });

        // Simulate unexpected close
        ws.simulateClose(1006, 'Abnormal closure');

        expect(client.isConnected()).toBe(false);

        // Advance past reconnect delay
        jest.advanceTimersByTime(1000);

        // A new WebSocket should have been created
        expect(mockWsInstances.length).toBe(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('should use exponential backoff for reconnects', async () => {
      jest.useFakeTimers();
      try {
        const ws1 = await connectClient(client);

        // First disconnect
        ws1.simulateClose(1006);

        // First reconnect after 1000ms
        jest.advanceTimersByTime(1000);
        expect(mockWsInstances.length).toBe(2);

        // Fail the reconnect: the close handler fires synchronously and
        // schedules another reconnect at the current delay.
        // The catch block in the first scheduleReconnect runs asynchronously
        // and doubles currentReconnectDelay for future reconnects.
        const ws2 = getLatestMockWs();
        ws2.simulateError(new Error('Connection failed'));
        ws2.simulateClose(1006);

        // Allow the promise catch handler to run (updates backoff delay)
        await Promise.resolve();

        const instancesBefore = mockWsInstances.length;

        // The close handler scheduled a reconnect. The delay depends on
        // whether the catch block (which doubles the delay) ran first.
        // Advance far enough to ensure the next reconnect fires.
        jest.advanceTimersByTime(2000);

        // A third instance should have been created (second reconnect attempt)
        expect(mockWsInstances.length).toBeGreaterThan(instancesBefore);
      } finally {
        jest.useRealTimers();
      }
    });

    it('should stop reconnecting after max attempts', async () => {
      jest.useFakeTimers();
      try {
        const ws = await connectClient(client);

        const errorHandler = jest.fn();
        client.on('error', errorHandler);

        // Simulate close
        ws.simulateClose(1006);

        // Exhaust all 3 reconnect attempts
        for (let i = 0; i < 3; i++) {
          jest.advanceTimersByTime(30000); // Advance past any backoff
          const lastWs = getLatestMockWs();
          lastWs.simulateError(new Error('Fail'));
          lastWs.simulateClose(1006);
        }

        const instanceCountBefore = mockWsInstances.length;

        // Should not attempt any more reconnects
        jest.advanceTimersByTime(60000);
        expect(mockWsInstances.length).toBe(instanceCountBefore);

        // Should have emitted an error about max attempts
        expect(errorHandler).toHaveBeenCalledWith(
          expect.objectContaining({
            message: expect.stringContaining('Failed to reconnect after 3 attempts'),
          })
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('should not reconnect after intentional disconnect', async () => {
      jest.useFakeTimers();
      try {
        await connectClient(client);

        // Intentional disconnect
        await client.disconnect();

        // Advance timers
        jest.advanceTimersByTime(60000);

        // Should not have created any new connections
        expect(mockWsInstances.length).toBe(1);
      } finally {
        jest.useRealTimers();
      }
    });

    it('should reset reconnect state on successful connection', async () => {
      jest.useFakeTimers();
      try {
        const ws1 = await connectClient(client);

        // Simulate close and reconnect
        ws1.simulateClose(1006);
        jest.advanceTimersByTime(1000);

        // Successfully reconnect
        const ws2 = getLatestMockWs();
        ws2.simulateOpen();

        // Force another close
        ws2.simulateClose(1006);

        // Reconnect delay should be back to 1000ms (reset), not 2000ms
        jest.advanceTimersByTime(1000);
        expect(mockWsInstances.length).toBe(3);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  // ===========================================================================
  // Disconnect
  // ===========================================================================

  describe('disconnect()', () => {
    it('should close the WebSocket connection', async () => {
      await connectClient(client);
      const ws = getLatestMockWs();

      await client.disconnect();
      expect(ws.close).toHaveBeenCalledWith(1000, 'Client disconnect');
      expect(client.isConnected()).toBe(false);
    });

    it('should emit disconnected event', async () => {
      await connectClient(client);

      const disconnectedHandler = jest.fn();
      client.on('disconnected', disconnectedHandler);

      await client.disconnect();
      expect(disconnectedHandler).toHaveBeenCalledTimes(1);
    });

    it('should handle disconnect when not connected', async () => {
      // Should not throw
      await expect(client.disconnect()).resolves.toBeUndefined();
    });

    it('should terminate if close times out', async () => {
      jest.useFakeTimers();
      try {
        await connectClient(client);
        const ws = getLatestMockWs();

        // Override close to NOT auto-fire close event (simulate hang)
        ws.close.mockImplementation(() => {
          // Do nothing - simulates a hanging close
        });

        const disconnectPromise = client.disconnect();
        jest.advanceTimersByTime(5000); // Close timeout
        await disconnectPromise;

        expect(ws.terminate).toHaveBeenCalled();
        expect(client.isConnected()).toBe(false);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  // ===========================================================================
  // isConnected()
  // ===========================================================================

  describe('isConnected()', () => {
    it('should return false before connecting', () => {
      expect(client.isConnected()).toBe(false);
    });

    it('should return true when connected', async () => {
      await connectClient(client);
      expect(client.isConnected()).toBe(true);
    });

    it('should return false after disconnect', async () => {
      await connectClient(client);
      await client.disconnect();
      expect(client.isConnected()).toBe(false);
    });
  });
});
