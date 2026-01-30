/**
 * BloXroute BDN Feed
 *
 * WebSocket client for connecting to bloXroute's Block Delivery Network (BDN)
 * to receive pending transactions before they are included in blocks.
 *
 * Features:
 * - Resilient WebSocket connection with exponential backoff
 * - Pending transaction subscription and filtering
 * - Health metrics and monitoring
 * - Multi-chain support
 *
 * @see Phase 1: Mempool Detection Service (Implementation Plan v3.0)
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { CircularBuffer, type Logger } from '@arbitrage/core';
import { CHAIN_NAME_TO_ID } from '@arbitrage/config';
import type {
  BloXrouteFeedConfig,
  BloXrouteMessage,
  BloXroutePendingTx,
  RawPendingTransaction,
  PendingTxHandler,
  FeedConnectionState,
  FeedHealthMetrics,
} from './types';

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_RECONNECT_INTERVAL = 1000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;
const DEFAULT_BACKOFF_MULTIPLIER = 2.0;
const DEFAULT_MAX_RECONNECT_DELAY = 60000;
const DEFAULT_CONNECTION_TIMEOUT = 10000;
const DEFAULT_HEARTBEAT_INTERVAL = 30000;

// =============================================================================
// TYPES
// =============================================================================

/**
 * Events emitted by the BloXrouteFeed.
 */
export interface BloXrouteFeedEvents {
  /** Emitted when connection is established */
  connected: [];
  /** Emitted when connection is closed */
  disconnected: [];
  /** Emitted on connection or protocol error */
  error: [Error];
  /** Emitted for each pending transaction received */
  pendingTx: [RawPendingTransaction];
  /** Emitted when subscription is confirmed */
  subscribed: [string]; // subscription ID
  /** Emitted on reconnection attempt */
  reconnecting: [{ attempt: number; delay: number }];
}

/**
 * Options for creating a BloXrouteFeed.
 */
export interface BloXrouteFeedOptions {
  /** Feed configuration */
  config: BloXrouteFeedConfig;
  /** Logger instance */
  logger: Logger;
}

// =============================================================================
// BLOXROUTE FEED CLASS
// =============================================================================

/**
 * BloXroute BDN WebSocket feed for pending transaction detection.
 *
 * @example
 * ```typescript
 * const feed = createBloXrouteFeed({
 *   config: {
 *     authHeader: process.env.BLOXROUTE_AUTH_HEADER,
 *     endpoint: 'wss://eth.blxrbdn.com/ws',
 *     chains: ['ethereum'],
 *   },
 *   logger: createLogger('bloxroute-feed'),
 * });
 *
 * feed.on('pendingTx', (tx) => {
 *   console.log('Pending transaction:', tx.hash);
 * });
 *
 * await feed.connect();
 * feed.subscribePendingTxs();
 * ```
 */
export class BloXrouteFeed extends EventEmitter {
  private config: BloXrouteFeedConfig;
  private logger: Logger;
  private ws: WebSocket | null = null;

  // Connection state
  private connectionState: FeedConnectionState = 'disconnected';
  private isDisconnecting = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private connectionTimeoutTimer: NodeJS.Timeout | null = null;
  // Pending connection promise to prevent race conditions (Fix 5.1)
  private pendingConnection: Promise<void> | null = null;

  // Subscription management
  private subscriptionId: string | null = null;
  private pendingTxHandlers: Set<PendingTxHandler> = new Set();
  private nextRequestId = 1;

  // Pre-computed filter sets for O(1) hot path lookup (performance optimization)
  private routerFilterSet: Set<string> | null = null;
  private traderFilterSet: Set<string> | null = null;

  // FIX 9.3: Use CircularBuffer from @arbitrage/core for O(1) latency tracking
  private static readonly LATENCY_BUFFER_SIZE = 100;
  private latencyBuffer: CircularBuffer<number>;

  // Health metrics
  private metrics: {
    connectionStartTime: number;
    lastMessageTime: number;
    messagesReceived: number;
    transactionsProcessed: number;
    decodeSuccesses: number;
    decodeFailures: number;
    reconnectCount: number;
  } = {
    connectionStartTime: 0,
    lastMessageTime: 0,
    messagesReceived: 0,
    transactionsProcessed: 0,
    decodeSuccesses: 0,
    decodeFailures: 0,
    reconnectCount: 0,
  };

  constructor(options: BloXrouteFeedOptions) {
    super();

    // FIX 4.3: Set maxListeners to prevent memory leak warnings
    this.setMaxListeners(15);

    this.config = options.config;
    this.logger = options.logger;

    // FIX 9.3: Initialize CircularBuffer from @arbitrage/core
    this.latencyBuffer = new CircularBuffer<number>(BloXrouteFeed.LATENCY_BUFFER_SIZE);

    // Pre-compute lowercase filter sets for O(1) hot path lookup
    if (this.config.includeRouters && this.config.includeRouters.length > 0) {
      this.routerFilterSet = new Set(
        this.config.includeRouters.map((addr) => addr.toLowerCase())
      );
    }
    if (this.config.includeTraders && this.config.includeTraders.length > 0) {
      this.traderFilterSet = new Set(
        this.config.includeTraders.map((addr) => addr.toLowerCase())
      );
    }
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Connect to the bloXroute BDN WebSocket.
   * Race-condition safe: returns existing connection promise if one is pending.
   */
  async connect(): Promise<void> {
    if (this.connectionState === 'connected') {
      this.logger.debug('Already connected to bloXroute');
      return;
    }

    // Fix 5.1: Return existing pending connection to prevent race conditions
    if (this.pendingConnection) {
      this.logger.debug('Connection already in progress, returning existing promise');
      return this.pendingConnection;
    }

    this.isDisconnecting = false;
    this.connectionState = 'connecting';

    this.pendingConnection = new Promise<void>((resolve, reject) => {
      try {
        const url = this.config.endpoint;
        this.logger.info('Connecting to bloXroute BDN', { url });

        // Create WebSocket with auth header
        const headers: Record<string, string> = {};
        if (this.config.authHeader) {
          headers['Authorization'] = this.config.authHeader;
        }

        this.ws = new WebSocket(url, { headers });

        // Set connection timeout
        // FIX: Add .unref() to prevent timer from keeping process alive during tests/shutdown
        const timeout = this.config.connectionTimeout ?? DEFAULT_CONNECTION_TIMEOUT;
        this.connectionTimeoutTimer = setTimeout(() => {
          if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
            this.logger.error('Connection timeout', { timeout });
            this.ws.terminate();
            this.pendingConnection = null;
            reject(new Error(`Connection timeout after ${timeout}ms`));
          }
        }, timeout);
        this.connectionTimeoutTimer.unref();

        this.ws.on('open', () => {
          this.clearConnectionTimeout();
          this.connectionState = 'connected';
          this.reconnectAttempts = 0;
          this.metrics.connectionStartTime = Date.now();
          this.metrics.lastMessageTime = Date.now();
          this.pendingConnection = null;

          this.logger.info('Connected to bloXroute BDN', {
            endpoint: this.config.endpoint,
            chains: this.config.chains,
          });

          this.startHeartbeat();
          this.emit('connected');
          resolve();
        });

        this.ws.on('message', (data: Buffer) => {
          this.handleMessage(data.toString());
        });

        this.ws.on('error', (error) => {
          this.clearConnectionTimeout();
          this.logger.error('WebSocket error', { error: error.message });
          this.emit('error', error);

          if (this.connectionState === 'connecting') {
            this.pendingConnection = null;
            reject(error);
          }
        });

        this.ws.on('close', (code, reason) => {
          this.clearConnectionTimeout();
          const reasonStr = reason.toString();
          this.logger.warn('WebSocket closed', { code, reason: reasonStr });

          this.connectionState = 'disconnected';
          this.pendingConnection = null;
          this.stopHeartbeat();
          this.emit('disconnected');

          // Attempt reconnection if not intentionally disconnected
          if (!this.isDisconnecting && code !== 1000) {
            this.scheduleReconnection();
          }
        });

      } catch (error) {
        this.connectionState = 'error';
        this.pendingConnection = null;
        this.logger.error('Failed to create WebSocket', { error });
        reject(error);
      }
    });

    return this.pendingConnection;
  }

  /**
   * Disconnect from the bloXroute BDN WebSocket.
   */
  disconnect(): void {
    this.logger.info('Disconnecting from bloXroute BDN');
    this.isDisconnecting = true;

    // Clear all timers
    this.clearConnectionTimeout();
    this.clearReconnectionTimer();
    this.stopHeartbeat();

    // Close WebSocket
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close(1000, 'Client disconnect');
      }
      this.ws = null;
    }

    // Clear handlers
    this.pendingTxHandlers.clear();
    this.subscriptionId = null;

    this.connectionState = 'disconnected';
    this.emit('disconnected');
  }

  /**
   * Subscribe to pending transactions.
   *
   * @param handler - Optional callback for pending transactions
   */
  subscribePendingTxs(handler?: PendingTxHandler): void {
    if (handler) {
      this.pendingTxHandlers.add(handler);
    }

    if (this.connectionState !== 'connected' || !this.ws) {
      this.logger.warn('Cannot subscribe - not connected');
      return;
    }

    const requestId = this.nextRequestId++;
    const subscribeMessage = {
      jsonrpc: '2.0',
      id: requestId,
      method: 'subscribe',
      params: ['pendingTxs', {
        include: this.config.includeRouters || [],
        filters: this.buildFilters(),
      }],
    };

    this.logger.info('Subscribing to pending transactions', {
      requestId,
      chains: this.config.chains,
    });

    this.ws.send(JSON.stringify(subscribeMessage));
  }

  /**
   * Handle incoming WebSocket message.
   * Exposed for testing.
   */
  handleMessage(data: string): void {
    this.metrics.messagesReceived++;
    this.metrics.lastMessageTime = Date.now();

    let message: BloXrouteMessage;
    try {
      message = JSON.parse(data);
    } catch (error) {
      this.logger.error('Failed to parse message', { error, data: data.substring(0, 100) });
      return;
    }

    // Handle error responses
    if (message.error) {
      const errorMsg = message.error.message || 'Unknown error';
      if (this.isRateLimitError(message.error)) {
        this.logger.warn('Rate limit detected', { error: errorMsg });
      } else {
        this.logger.error('bloXroute error', {
          code: message.error.code,
          message: errorMsg,
        });
      }
      return;
    }

    // Handle subscription confirmation
    if (message.id !== undefined && message.result && typeof message.result === 'string') {
      this.subscriptionId = message.result;
      this.logger.info('Subscription confirmed', { subscriptionId: this.subscriptionId });
      this.emit('subscribed', this.subscriptionId);
      return;
    }

    // Handle pending transaction notification
    if (message.method === 'subscribe' && message.params?.result) {
      this.processPendingTx(message.params.result as BloXroutePendingTx);
    }
  }

  /**
   * Get current health metrics.
   */
  getHealth(): FeedHealthMetrics {
    const now = Date.now();
    const uptime = this.metrics.connectionStartTime > 0
      ? now - this.metrics.connectionStartTime
      : 0;

    return {
      connectionState: this.connectionState,
      lastMessageTime: this.metrics.lastMessageTime,
      messagesReceived: this.metrics.messagesReceived,
      transactionsProcessed: this.metrics.transactionsProcessed,
      decodeSuccesses: this.metrics.decodeSuccesses,
      decodeFailures: this.metrics.decodeFailures,
      reconnectCount: this.metrics.reconnectCount,
      uptime,
      avgLatencyMs: this.getAverageLatency(),
    };
  }

  /**
   * Get feed configuration.
   */
  getConfig(): BloXrouteFeedConfig {
    return { ...this.config };
  }

  /**
   * Simulate connection loss for testing.
   */
  simulateConnectionLoss(): void {
    if (this.ws) {
      this.ws.emit('close', 1006, Buffer.from('Connection lost'));
    }
  }

  /**
   * Simulate error for testing.
   */
  simulateError(error: Error): void {
    this.logger.error('Simulated error', { error: error.message });
    this.emit('error', error);
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Process a pending transaction from bloXroute.
   */
  private processPendingTx(pendingTx: BloXroutePendingTx): void {
    const txContents = pendingTx.txContents;
    if (!txContents) {
      this.logger.debug('Received pending tx without contents');
      return;
    }

    // Apply router filter if configured (O(1) Set lookup, pre-lowercased)
    if (this.routerFilterSet) {
      const toAddress = txContents.to?.toLowerCase();
      if (!toAddress || !this.routerFilterSet.has(toAddress)) {
        return; // Skip transactions not targeting monitored routers
      }
    }

    // Apply trader filter if configured (O(1) Set lookup, pre-lowercased)
    if (this.traderFilterSet) {
      const fromAddress = txContents.from?.toLowerCase();
      if (!fromAddress || !this.traderFilterSet.has(fromAddress)) {
        return; // Skip transactions not from monitored traders
      }
    }

    // FIX 3.3/4.1: Improved chainId parsing with explicit null/undefined handling
    // Parse chainId from hex string, handling edge cases
    let parsedChainId: number | undefined = undefined;
    if (txContents.chainId !== undefined && txContents.chainId !== null) {
      const chainIdStr = txContents.chainId.toString();
      // Handle both hex (0x...) and decimal string formats
      if (chainIdStr.startsWith('0x')) {
        parsedChainId = parseInt(chainIdStr, 16);
      } else {
        parsedChainId = parseInt(chainIdStr, 10);
      }
      // Validate parsed value - chainId 0 is valid (e.g., legacy transactions)
      if (isNaN(parsedChainId)) {
        this.logger.debug('Invalid chainId format', { chainId: txContents.chainId });
        parsedChainId = undefined;
      }
    }

    // Determine default chainId based on endpoint if not present in transaction
    // FIX 3.3: Don't assume Ethereum - use config or leave undefined for downstream handling
    const defaultChainId = this.getDefaultChainId();

    // Convert to RawPendingTransaction format
    const rawTx: RawPendingTransaction = {
      hash: pendingTx.txHash,
      from: txContents.from,
      to: txContents.to,
      value: txContents.value,
      input: txContents.input,
      gas: txContents.gas,
      gasPrice: txContents.gasPrice,
      maxFeePerGas: txContents.maxFeePerGas,
      maxPriorityFeePerGas: txContents.maxPriorityFeePerGas,
      nonce: txContents.nonce,
      chainId: parsedChainId ?? defaultChainId,
      accessList: txContents.accessList,
    };

    this.metrics.transactionsProcessed++;

    // Record latency if timestamp available
    if (pendingTx.time) {
      const txTime = new Date(pendingTx.time).getTime();
      const latency = Date.now() - txTime;
      this.recordLatency(latency);
    }

    // Notify handlers (copy Set to prevent mutation during iteration - Fix 5.3)
    const handlers = [...this.pendingTxHandlers];
    for (const handler of handlers) {
      try {
        handler(rawTx);
      } catch (error) {
        this.logger.error('Error in pending tx handler', { error });
      }
    }

    // Emit event
    this.emit('pendingTx', rawTx);
  }

  /**
   * FIX 3.2/3.3/9.1: Get default chainId based on configured chains.
   * Uses shared CHAIN_NAME_TO_ID from @arbitrage/config for consistency.
   * Returns undefined if no default can be determined (safer than assuming Ethereum).
   */
  private getDefaultChainId(): number | undefined {
    if (!this.config.chains || this.config.chains.length === 0) {
      return undefined;
    }

    const firstChain = this.config.chains[0].toLowerCase();
    return CHAIN_NAME_TO_ID[firstChain];
  }

  /**
   * Build subscription filters from config.
   */
  private buildFilters(): Record<string, unknown> {
    const filters: Record<string, unknown> = {};

    if (this.config.includeRouters && this.config.includeRouters.length > 0) {
      filters.to = this.config.includeRouters;
    }

    if (this.config.includeTraders && this.config.includeTraders.length > 0) {
      filters.from = this.config.includeTraders;
    }

    return filters;
  }

  /**
   * Check if error indicates rate limiting.
   */
  private isRateLimitError(error: { code?: number; message?: string }): boolean {
    if (error.code === -32005 || error.code === -32016) {
      return true;
    }

    const message = (error.message || '').toLowerCase();
    return message.includes('rate') && message.includes('limit');
  }

  /**
   * FIX 9.3: Record latency sample using CircularBuffer from @arbitrage/core.
   * Uses O(1) pushOverwrite for rolling window behavior.
   */
  private recordLatency(latencyMs: number): void {
    this.latencyBuffer.pushOverwrite(latencyMs);
  }

  /**
   * FIX 9.3: Get average latency from CircularBuffer.
   */
  private getAverageLatency(): number {
    if (this.latencyBuffer.isEmpty) {
      return 0;
    }
    const samples = this.latencyBuffer.toArray();
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i];
    }
    return sum / samples.length;
  }

  /**
   * Schedule reconnection with exponential backoff.
   */
  private scheduleReconnection(): void {
    if (this.isDisconnecting) {
      return;
    }

    const config = this.config.reconnect || {};
    const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;

    if (this.reconnectAttempts >= maxAttempts) {
      this.logger.error('Max reconnection attempts reached', { maxAttempts });
      this.emit('error', new Error('Max reconnection attempts reached'));
      return;
    }

    this.reconnectAttempts++;
    this.metrics.reconnectCount++;
    this.connectionState = 'reconnecting';

    const delay = this.calculateReconnectDelay(this.reconnectAttempts);

    this.logger.info('Scheduling reconnection', {
      attempt: this.reconnectAttempts,
      maxAttempts,
      delay,
    });

    this.emit('reconnecting', { attempt: this.reconnectAttempts, delay });

    // FIX 5.4: Use proper async error handling in setTimeout callback
    // Wrap async function to prevent unhandled rejection
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;

      // Fix 5.2: Re-check isDisconnecting before attempting reconnection
      if (this.isDisconnecting) {
        this.logger.debug('Reconnection cancelled - disconnect in progress');
        return;
      }

      // FIX 5.4: Handle async reconnection with proper error handling
      this.performReconnection().catch((error) => {
        this.logger.error('Unhandled error in reconnection', {
          error: (error as Error).message,
          attempt: this.reconnectAttempts,
        });
        // Schedule next attempt - don't throw
        if (!this.isDisconnecting) {
          this.scheduleReconnection();
        }
      });
    }, delay);
    // FIX: Add .unref() to prevent timer from keeping process alive during tests/shutdown
    this.reconnectTimer.unref();
  }

  /**
   * FIX 5.4: Separated async reconnection logic for proper error handling.
   */
  private async performReconnection(): Promise<void> {
    try {
      await this.connect();
      // Re-subscribe after reconnection
      if (this.pendingTxHandlers.size > 0) {
        this.subscribePendingTxs();
      }
    } catch (error) {
      this.logger.error('Reconnection failed', { error: (error as Error).message });
      this.scheduleReconnection();
    }
  }

  /**
   * Calculate reconnection delay using exponential backoff.
   */
  private calculateReconnectDelay(attempt: number): number {
    const config = this.config.reconnect || {};
    const baseDelay = config.interval ?? DEFAULT_RECONNECT_INTERVAL;
    const multiplier = config.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER;
    const maxDelay = config.maxDelay ?? DEFAULT_MAX_RECONNECT_DELAY;

    // Exponential backoff: baseDelay * (multiplier ^ (attempt - 1))
    let delay = baseDelay * Math.pow(multiplier, attempt - 1);

    // Cap at maximum delay
    delay = Math.min(delay, maxDelay);

    // Add jitter (0-25% of delay)
    const jitter = delay * 0.25 * Math.random();
    delay += jitter;

    return Math.floor(delay);
  }

  /**
   * Start heartbeat timer to keep connection alive.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();

    const interval = this.config.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL;

    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.ping();
        } catch (error) {
          this.logger.error('Failed to send heartbeat', { error });
        }
      }
    }, interval);
    // FIX: Add .unref() to prevent timer from keeping process alive during tests/shutdown
    this.heartbeatTimer.unref();
  }

  /**
   * Stop heartbeat timer.
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Clear connection timeout timer.
   */
  private clearConnectionTimeout(): void {
    if (this.connectionTimeoutTimer) {
      clearTimeout(this.connectionTimeoutTimer);
      this.connectionTimeoutTimer = null;
    }
  }

  /**
   * Clear reconnection timer.
   */
  private clearReconnectionTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Create a new BloXrouteFeed instance.
 *
 * @param options - Feed configuration and dependencies
 * @returns Configured BloXrouteFeed instance
 */
export function createBloXrouteFeed(options: BloXrouteFeedOptions): BloXrouteFeed {
  return new BloXrouteFeed(options);
}
