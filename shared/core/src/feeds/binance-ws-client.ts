/**
 * Binance WebSocket Client
 *
 * Read-only WebSocket client for Binance combined trade streams.
 * Provides real-time CEX price data for CEX-DEX spread analysis.
 *
 * Features:
 * - Auto-reconnect with exponential backoff
 * - Ping/pong keepalive (Binance requires pong within 10 minutes)
 * - Typed trade event emission
 * - Graceful disconnect with cleanup
 *
 * @see https://binance-docs.github.io/apidocs/spot/en/#trade-streams
 * @module feeds
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { createLogger } from '../logger';
import { getErrorMessage } from '../resilience/error-handling';
const logger = createLogger('binance-ws');

// =============================================================================
// Types
// =============================================================================

/**
 * Normalized trade event emitted by the client.
 */
export interface BinanceTradeEvent {
  /** Trading symbol, e.g., 'BTCUSDT' */
  symbol: string;
  /** Trade price in quote currency */
  price: number;
  /** Trade quantity in base currency */
  quantity: number;
  /** Trade timestamp (ms since epoch) */
  timestamp: number;
  /** Whether the buyer is the maker (true = sell-side aggressor) */
  isBuyerMaker: boolean;
}

/**
 * Configuration for the Binance WebSocket client.
 */
export interface BinanceWsConfig {
  /** Stream names, e.g., ['btcusdt@trade', 'ethusdt@trade'] */
  streams: string[];
  /** Initial reconnect delay in ms (default: 1000) */
  reconnectDelayMs: number;
  /** Maximum reconnect delay in ms (default: 30000) */
  maxReconnectDelayMs: number;
  /** Ping interval in ms (default: 30000) */
  pingIntervalMs: number;
  /** Maximum reconnect attempts before giving up (default: 10) */
  maxReconnectAttempts: number;
}

/**
 * Raw Binance combined stream message envelope.
 */
interface BinanceStreamMessage {
  stream: string;
  data: {
    e: string;   // Event type
    s: string;   // Symbol
    p: string;   // Price (string)
    q: string;   // Quantity (string)
    T: number;   // Trade time (ms)
    m: boolean;  // Is buyer maker
  };
}

// =============================================================================
// Constants
// =============================================================================

const BINANCE_COMBINED_STREAM_BASE = 'wss://stream.binance.com:9443/stream';

const DEFAULT_CONFIG: BinanceWsConfig = {
  streams: [],
  reconnectDelayMs: 1000,
  maxReconnectDelayMs: 30000,
  pingIntervalMs: 30000,
  maxReconnectAttempts: 10,
};

// =============================================================================
// BinanceWebSocketClient
// =============================================================================

/**
 * WebSocket client for Binance combined trade streams.
 *
 * Emits:
 * - 'trade' (BinanceTradeEvent) - Parsed trade event
 * - 'connected' () - WebSocket connected
 * - 'disconnected' () - WebSocket disconnected
 * - 'error' (Error) - Connection or parse error
 */
export class BinanceWebSocketClient extends EventEmitter {
  private config: BinanceWsConfig;
  private ws: WebSocket | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Periodic "last resort" reconnect timer after max attempts exhausted */
  private lastResortTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private currentReconnectDelay: number;
  private connected = false;
  private intentionalDisconnect = false;
  /** H3: Timestamp when WS became disconnected after max reconnect attempts (for health checks) */
  private disconnectedSince: number | null = null;

  constructor(config: Partial<BinanceWsConfig> & { streams: string[] }) {
    super();
    this.setMaxListeners(20);
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.currentReconnectDelay = this.config.reconnectDelayMs;

    if (this.config.streams.length === 0) {
      logger.warn('BinanceWebSocketClient created with no streams');
    }

    logger.info('BinanceWebSocketClient initialized', {
      streams: this.config.streams,
      reconnectDelayMs: this.config.reconnectDelayMs,
      maxReconnectAttempts: this.config.maxReconnectAttempts,
    });
  }

  /**
   * Connect to Binance combined stream.
   * Resolves when WebSocket connection is established.
   */
  async connect(): Promise<void> {
    if (this.connected) {
      logger.warn('Already connected, ignoring connect() call');
      return;
    }

    this.intentionalDisconnect = false;

    return new Promise<void>((resolve, reject) => {
      try {
        const url = this.buildStreamUrl();
        logger.info('Connecting to Binance WebSocket', { url });

        // Clean up old WebSocket to prevent listener leaks on reconnect
        if (this.ws) {
          this.ws.removeAllListeners();
          if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
            this.ws.terminate();
          }
          this.ws = null;
        }

        this.ws = new WebSocket(url);

        this.ws.on('open', () => {
          this.connected = true;
          this.disconnectedSince = null;
          this.reconnectAttempts = 0;
          this.currentReconnectDelay = this.config.reconnectDelayMs;
          this.startPingInterval();
          this.emit('connected');
          logger.info('Connected to Binance WebSocket');
          resolve();
        });

        this.ws.on('message', (data: WebSocket.RawData) => {
          this.handleMessage(data);
        });

        this.ws.on('close', (code: number, reason: Buffer) => {
          const wasConnected = this.connected;
          this.connected = false;
          this.stopPingInterval();
          this.emit('disconnected');

          logger.info('Binance WebSocket closed', {
            code,
            reason: reason.toString(),
            wasConnected,
          });

          if (!this.intentionalDisconnect) {
            this.scheduleReconnect();
          }
        });

        this.ws.on('error', (error: Error) => {
          logger.error('Binance WebSocket error', { error: error.message });
          this.emit('error', error);

          // If we haven't connected yet, reject the promise
          if (!this.connected) {
            reject(error);
          }
        });

        this.ws.on('pong', () => {
          logger.debug('Received pong from Binance');
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Gracefully disconnect from Binance WebSocket.
   * Stops reconnect attempts and cleans up resources.
   */
  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    this.stopPingInterval();
    this.cancelReconnect();
    this.cancelLastResortReconnect();

    if (this.ws) {
      return new Promise<void>((resolve) => {
        const ws = this.ws;
        if (!ws) {
          resolve();
          return;
        }

        // Set a timeout for close in case it hangs
        const closeTimeout = setTimeout(() => {
          logger.warn('WebSocket close timed out, terminating');
          ws.terminate();
          this.ws = null;
          this.connected = false;
          resolve();
        }, 5000);

        ws.once('close', () => {
          clearTimeout(closeTimeout);
          this.ws = null;
          this.connected = false;
          resolve();
        });

        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(1000, 'Client disconnect');
        } else {
          clearTimeout(closeTimeout);
          this.ws = null;
          this.connected = false;
          resolve();
        }
      });
    }

    this.connected = false;
  }

  /**
   * Check if the WebSocket is currently connected.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * H3: Get the timestamp when the WS became disconnected after exhausting
   * all reconnect attempts. Returns null if connected or still reconnecting.
   * Use for health check indicators.
   */
  getDisconnectedSince(): number | null {
    return this.disconnectedSince;
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  /**
   * Build the combined stream URL from configured streams.
   */
  private buildStreamUrl(): string {
    const streamPath = this.config.streams.join('/');
    return `${BINANCE_COMBINED_STREAM_BASE}?streams=${streamPath}`;
  }

  /**
   * Parse and handle an incoming WebSocket message.
   */
  private handleMessage(data: WebSocket.RawData): void {
    try {
      const raw = data.toString();
      const message: BinanceStreamMessage = JSON.parse(raw);

      // Validate the message structure
      if (!message.data || message.data.e !== 'trade') {
        logger.debug('Ignoring non-trade message', { stream: message.stream });
        return;
      }

      const trade: BinanceTradeEvent = {
        symbol: message.data.s,
        price: parseFloat(message.data.p),
        quantity: parseFloat(message.data.q),
        timestamp: message.data.T,
        isBuyerMaker: message.data.m,
      };

      // Validate parsed values
      if (isNaN(trade.price) || isNaN(trade.quantity)) {
        logger.warn('Invalid trade data (NaN price/quantity)', {
          symbol: message.data.s,
          rawPrice: message.data.p,
          rawQuantity: message.data.q,
        });
        return;
      }

      this.emit('trade', trade);
    } catch (error) {
      logger.warn('Failed to parse Binance message', {
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * Start periodic ping to keep the connection alive.
   * Binance requires a pong response within 10 minutes.
   */
  private startPingInterval(): void {
    this.stopPingInterval();
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
        logger.debug('Sent ping to Binance');
      }
    }, this.config.pingIntervalMs);
  }

  /**
   * Stop the ping interval timer.
   */
  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   */
  private scheduleReconnect(): void {
    if (this.intentionalDisconnect) {
      return;
    }

    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      // H3: Track disconnection time for health check visibility
      this.disconnectedSince = this.disconnectedSince ?? Date.now();
      logger.error('Max reconnect attempts reached, starting periodic last-resort reconnect', {
        attempts: this.reconnectAttempts,
        maxAttempts: this.config.maxReconnectAttempts,
        disconnectedSince: this.disconnectedSince,
      });
      this.emit('error', new Error(
        `Failed to reconnect after ${this.config.maxReconnectAttempts} attempts`
      ));
      // Start periodic last-resort reconnect (every 5 minutes)
      this.startLastResortReconnect();
      return;
    }

    this.reconnectAttempts++;

    logger.info('Scheduling reconnect', {
      attempt: this.reconnectAttempts,
      delayMs: this.currentReconnectDelay,
    });

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((error) => {
        logger.error('Reconnect attempt failed', {
          attempt: this.reconnectAttempts,
          error: getErrorMessage(error),
        });
        // Exponential backoff: double the delay, cap at max
        this.currentReconnectDelay = Math.min(
          this.currentReconnectDelay * 2,
          this.config.maxReconnectDelayMs
        );
        // scheduleReconnect will be called again from the 'close' handler
      });
    }, this.currentReconnectDelay);
  }

  /**
   * Start a periodic last-resort reconnect attempt (every 5 minutes).
   * Used after all normal reconnect attempts are exhausted.
   */
  private startLastResortReconnect(): void {
    this.cancelLastResortReconnect();
    const intervalMs = 5 * 60 * 1000; // 5 minutes

    this.lastResortTimer = setInterval(() => {
      if (this.connected || this.intentionalDisconnect) {
        this.cancelLastResortReconnect();
        return;
      }

      logger.info('Attempting last-resort reconnect');
      this.reconnectAttempts = 0;
      this.currentReconnectDelay = this.config.reconnectDelayMs;
      this.connect().catch((error) => {
        logger.error('Last-resort reconnect failed', {
          error: getErrorMessage(error),
        });
      });
    }, intervalMs);
  }

  /**
   * Cancel the last-resort reconnect timer.
   */
  private cancelLastResortReconnect(): void {
    if (this.lastResortTimer) {
      clearInterval(this.lastResortTimer);
      this.lastResortTimer = null;
    }
  }

  /**
   * Cancel any pending reconnect timer.
   */
  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    this.currentReconnectDelay = this.config.reconnectDelayMs;
  }
}
