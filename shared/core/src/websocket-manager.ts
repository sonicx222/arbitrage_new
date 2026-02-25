// WebSocket Manager
// Handles WebSocket connections with reconnection logic, event subscription, and message handling
//
// Updated with 6-Provider Shield Architecture:
// - Time-based provider priority rotation
// - Budget-aware provider selection
// - Proactive throttling before rate limits hit
//
// @see docs/reports/RPC_DEEP_DIVE_ANALYSIS.md

import WebSocket from 'ws';
import { createLogger } from './logger';
import { clearIntervalSafe, clearTimeoutSafe } from './async/lifecycle-utils';
// CQ8-ALT: ProviderHealthScorer now accessed via ProviderRotationStrategy
import { EventProcessingWorkerPool, getWorkerPool } from './async/worker-pool';
// CQ8-ALT: Extracted cold-path classes
import { ProviderRotationStrategy } from './rpc/provider-rotation-strategy';
import { ProviderHealthTracker } from './monitoring/provider-health-tracker';
import { getErrorMessage } from './resilience/error-handling';
export interface WebSocketConfig {
  url: string;
  /** Fallback URLs to try if primary URL fails */
  fallbackUrls?: string[];
  /** Base reconnect interval in ms (default: 1000) */
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  heartbeatInterval?: number;
  connectionTimeout?: number;
  /** Alias for heartbeatInterval for compatibility */
  pingInterval?: number;
  /** Chain ID for health tracking (optional) */
  chainId?: string;
  // Exponential backoff configuration
  /** Multiplier for exponential backoff (default: 2.0) */
  backoffMultiplier?: number;
  /** Maximum reconnect delay in ms (default: 60000) */
  maxReconnectDelay?: number;
  /** Jitter percentage to add randomness (default: 0.25 = 25%) */
  jitterPercent?: number;
  /**
   * T1.5: Staleness threshold in ms before rotating to fallback provider.
   * If not specified, uses chain-based defaults:
   * - Fast chains (arbitrum, solana): 5000ms
   * - Medium chains (polygon, bsc, optimism, base, avalanche, fantom): 10000ms
   * - Slow chains (ethereum, zksync, linea): 15000ms
   */
  stalenessThresholdMs?: number;

  // ==========================================================================
  // Phase 2: Worker Thread JSON Parsing Configuration
  // @see RPC_DATA_OPTIMIZATION_RESEARCH.md
  // ==========================================================================

  /**
   * Enable worker thread JSON parsing to offload JSON.parse from main thread.
   * Best for high-throughput scenarios (>500 events/sec) or large payloads.
   *
   * Trade-offs:
   * - Adds ~0.5-2ms message-passing overhead per parse
   * - Prevents main thread blocking during large JSON parsing
   * - Most effective for payloads >1KB
   *
   * @default false (disabled - use main thread parsing)
   */
  useWorkerParsing?: boolean;

  /**
   * Minimum payload size in bytes to use worker thread parsing.
   * Payloads smaller than this threshold are parsed on main thread
   * since overhead would exceed benefits.
   *
   * @default 1024 (1KB) - only worker-parse messages >1KB
   */
  workerParsingThresholdBytes?: number;

  /**
   * Maximum allowed message size in bytes.
   * Messages exceeding this limit will close the connection with code 1008.
   *
   * @default 10485760 (10MB)
   */
  maxMessageSize?: number;
}

// T1.5: Chain staleness thresholds and provider rotation logic
// now in provider-health-tracker.ts and provider-rotation-strategy.ts (CQ8-ALT)

export interface WebSocketSubscription {
  id: number;
  method: string;
  params: any[];
  type?: string; // Optional subscription type (e.g., 'logs', 'newHeads', 'sync')
  topics?: string[]; // Optional topics for log subscriptions
  callback?: (data: any) => void; // Optional callback for subscription results
}

export interface WebSocketMessage {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
}

export type WebSocketEventHandler = (data: WebSocketMessage) => void;
export type ConnectionStateHandler = (connected: boolean) => void;
export type ErrorEventHandler = (error: Error) => void;
export type GenericEventHandler = (...args: any[]) => void;

export class WebSocketManager {
  /** PERF-001: Maximum handlers per handler set to prevent unbounded listener accumulation */
  private static readonly MAX_HANDLERS_PER_SET = 50;

  private ws: WebSocket | null = null;
  private config: WebSocketConfig;
  private logger = createLogger('websocket-manager');

  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private connectionTimeoutTimer: NodeJS.Timeout | null = null;
  /** Slow recovery timer after max reconnect attempts exhausted */
  private recoveryTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private isConnecting = false;
  private isConnected = false;
  // P2-FIX: Track if reconnection is actively in progress to prevent overlapping attempts
  private isReconnecting = false;
  // P2-FIX: Track if manager has been explicitly disconnected
  private isDisconnected = false;
  // P1-FIX: Connection mutex to prevent TOCTOU race condition
  private connectMutex: Promise<void> | null = null;

  private subscriptions = new Map<number, WebSocketSubscription>();
  private messageHandlers = new Set<WebSocketEventHandler>();
  private connectionHandlers = new Set<ConnectionStateHandler>();
  private errorHandlers = new Set<ErrorEventHandler>();
  private eventHandlers = new Map<string, Set<GenericEventHandler>>();

  private nextSubscriptionId = 1;

  /** Chain ID for health tracking */
  private chainId: string;

  // CQ8-ALT: Cold-path provider rotation and health tracking extracted
  /** Provider rotation strategy (fallback selection, exclusion, reconnect delay) */
  private readonly rotationStrategy: ProviderRotationStrategy;
  /** Provider health tracker (quality metrics, staleness detection) */
  private readonly healthTracker: ProviderHealthTracker;

  // ==========================================================================
  // Phase 2: Worker Thread JSON Parsing
  // P1-PHASE1: Enabled by default for production to reduce main thread blocking
  // @see docs/reports/ENHANCEMENT_OPTIMIZATION_RESEARCH.md Section 5.2
  // ==========================================================================

  /**
   * Whether to use worker thread for JSON parsing.
   * P1-PHASE1: Now enabled by default for production environments.
   * Worker parsing offloads large payload parsing (>2KB) to worker threads,
   * reducing main thread blocking by 20-30% during high-volume WebSocket traffic.
   */
  private useWorkerParsing = false;

  /**
   * Minimum payload size to use worker parsing.
   * P1-PHASE1: Changed from 1KB to 2KB per research recommendations.
   * Below 2KB, main thread parsing overhead is less than worker message-passing overhead.
   */
  private workerParsingThresholdBytes = 2048;

  /** Maximum allowed message size in bytes. Messages exceeding this close the connection. */
  private maxMessageSize: number;

  /** Worker pool reference (lazy-initialized when worker parsing enabled) */
  private workerPool: EventProcessingWorkerPool | null = null;

  /** Track worker parsing statistics */
  private workerParsingStats = {
    mainThreadParses: 0,
    workerThreadParses: 0,
    parseErrors: 0,
    poolStartupFallbacks: 0
  };

  /** Whether worker pool has been started */
  private workerPoolStarted = false;

  /** Whether pool startup is in progress */
  private workerPoolStarting = false;

  // ==========================================================================
  // Finding 2.2 Fix: Proactive Staleness Detection via RPC Requests
  // Enables detectDataGaps() to query eth_blockNumber without waiting for
  // the next block event (passive detection).
  // ==========================================================================

  /** Counter for unique JSON-RPC request IDs (separate from subscription IDs) */
  private nextRequestId = 1_000_000; // Start at 1M to avoid collision with subscription IDs

  /**
   * Pending RPC requests awaiting response.
   * Maps request ID to { resolve, reject, timeout } for Promise-based request handling.
   */
  private pendingRequests: Map<number, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();

  /** Default timeout for RPC requests in ms */
  private readonly rpcRequestTimeoutMs = 5000;

  constructor(config: WebSocketConfig) {
    this.config = {
      reconnectInterval: 1000,  // Base delay for exponential backoff
      maxReconnectAttempts: 10,
      heartbeatInterval: config.pingInterval ?? 30000,
      connectionTimeout: 10000,
      backoffMultiplier: 2.0,
      maxReconnectDelay: 60000,
      jitterPercent: 0.25,
      ...config
    };
    this.chainId = config.chainId || 'unknown';

    // CQ8-ALT: Initialize extracted cold-path classes
    this.rotationStrategy = new ProviderRotationStrategy({
      url: config.url,
      fallbackUrls: config.fallbackUrls,
      chainId: this.chainId,
      reconnectInterval: this.config.reconnectInterval,
      backoffMultiplier: this.config.backoffMultiplier,
      maxReconnectDelay: this.config.maxReconnectDelay,
      jitterPercent: this.config.jitterPercent,
    });

    this.healthTracker = new ProviderHealthTracker({
      chainId: this.chainId,
      stalenessThresholdMs: config.stalenessThresholdMs,
    });

    if (this.logger.isLevelEnabled?.('debug') ?? false) {
      this.logger.debug('WebSocket manager initialized', {
        chainId: this.chainId,
      });
    }

    // Phase 2: Initialize worker thread JSON parsing
    // P1-PHASE1: Enable by default for production (NODE_ENV=production or detected production environment)
    // Worker parsing reduces main thread blocking by 20-30% for large payloads
    // WS_WORKER_PARSING env var allows explicit override regardless of environment
    const envOverride = process.env.WS_WORKER_PARSING;
    const isProduction = process.env.NODE_ENV === 'production' ||
      process.env.FLY_APP_NAME !== undefined ||
      process.env.RAILWAY_ENVIRONMENT !== undefined;
    const workerParsingDefault = envOverride !== undefined
      ? envOverride === 'true'
      : isProduction;

    this.useWorkerParsing = config.useWorkerParsing ?? workerParsingDefault;
    this.workerParsingThresholdBytes = config.workerParsingThresholdBytes ?? 2048;
    this.maxMessageSize = config.maxMessageSize ?? 10 * 1024 * 1024; // 10MB

    if (this.useWorkerParsing) {
      // Lazy init - worker pool will be started when first needed
      this.workerPool = getWorkerPool();
      this.logger.info('Worker thread JSON parsing enabled', {
        chainId: this.chainId,
        thresholdBytes: this.workerParsingThresholdBytes,
        autoEnabled: config.useWorkerParsing === undefined && workerParsingDefault
      });
    }
  }

  /**
   * Get the current active WebSocket URL.
   * CQ8-ALT: Delegates to ProviderRotationStrategy.
   */
  getCurrentUrl(): string {
    return this.rotationStrategy.getCurrentUrl();
  }

  /**
   * S3.3: Enable or disable intelligent fallback selection.
   * CQ8-ALT: Delegates to ProviderRotationStrategy.
   */
  setIntelligentFallback(enabled: boolean): void {
    this.rotationStrategy.setIntelligentFallback(enabled);
  }

  /**
   * Enable or disable budget-aware provider selection (6-Provider Shield).
   * CQ8-ALT: Delegates to ProviderRotationStrategy.
   */
  setBudgetAwareSelection(enabled: boolean): void {
    this.rotationStrategy.setBudgetAwareSelection(enabled);
  }

  // ==========================================================================
  // Phase 2: Worker Thread JSON Parsing Control Methods
  // ==========================================================================

  /**
   * Enable or disable worker thread JSON parsing at runtime.
   * When enabled, large payloads (>threshold) are parsed in worker threads.
   *
   * @param enabled - Whether to use worker threads for large JSON parsing
   */
  setWorkerParsing(enabled: boolean): void {
    if (enabled && !this.workerPool) {
      this.workerPool = getWorkerPool();
    }
    this.useWorkerParsing = enabled;
    this.logger.info('Worker parsing setting changed', {
      chainId: this.chainId,
      enabled,
      thresholdBytes: this.workerParsingThresholdBytes
    });
  }

  /**
   * Set the minimum payload size threshold for worker parsing.
   * Payloads smaller than this are parsed on main thread.
   *
   * @param bytes - Minimum size in bytes (default: 1024)
   */
  setWorkerParsingThreshold(bytes: number): void {
    this.workerParsingThresholdBytes = Math.max(0, bytes);
    if (this.logger.isLevelEnabled?.('debug') ?? false) {
      this.logger.debug('Worker parsing threshold changed', {
        chainId: this.chainId,
        thresholdBytes: this.workerParsingThresholdBytes
      });
    }
  }

  /**
   * Get worker parsing statistics for monitoring.
   * Useful for tuning the threshold and understanding usage patterns.
   *
   * @returns Statistics about main thread vs worker thread parsing
   */
  getWorkerParsingStats(): {
    enabled: boolean;
    poolReady: boolean;
    thresholdBytes: number;
    mainThreadParses: number;
    workerThreadParses: number;
    parseErrors: number;
    poolStartupFallbacks: number;
    workerUsagePercent: number;
  } {
    const total = this.workerParsingStats.mainThreadParses +
                  this.workerParsingStats.workerThreadParses;
    const workerUsagePercent = total > 0
      ? (this.workerParsingStats.workerThreadParses / total) * 100
      : 0;

    return {
      enabled: this.useWorkerParsing,
      poolReady: this.workerPoolStarted,
      thresholdBytes: this.workerParsingThresholdBytes,
      ...this.workerParsingStats,
      workerUsagePercent
    };
  }

  /**
   * Reset worker parsing statistics.
   * Useful for benchmarking or after configuration changes.
   */
  resetWorkerParsingStats(): void {
    this.workerParsingStats = {
      mainThreadParses: 0,
      workerThreadParses: 0,
      parseErrors: 0,
      poolStartupFallbacks: 0
    };
  }

  /**
   * Record a request for budget tracking.
   * CQ8-ALT: Delegates to ProviderRotationStrategy.
   */
  recordRequestForBudget(method = 'eth_subscribe'): void {
    this.rotationStrategy.recordRequestForBudget(method);
  }

  /**
   * Get the current provider name for the active connection.
   * CQ8-ALT: Delegates to ProviderRotationStrategy.
   */
  getCurrentProvider(): string {
    return this.rotationStrategy.getCurrentProvider();
  }

  /**
   * Get provider priority order based on time of day and budget status.
   * CQ8-ALT: Delegates to ProviderRotationStrategy.
   */
  getTimeBasedProviderPriority(): string[] {
    return this.rotationStrategy.getTimeBasedProviderPriority();
  }

  async connect(): Promise<void> {
    // P1-FIX: Use mutex to prevent TOCTOU race condition
    // If a connection is already in progress, wait for it instead of starting a new one
    if (this.connectMutex) {
      return this.connectMutex;
    }

    if (this.isConnected) {
      return;
    }

    // Create mutex promise before any async operations
    let resolveMutex: () => void;
    this.connectMutex = new Promise<void>((resolve) => {
      resolveMutex = resolve;
    });

    this.isConnecting = true;
    // P2-FIX: Clear disconnected flag when explicitly connecting
    this.isDisconnected = false;

    const connectionPromise = new Promise<void>((resolve, reject) => {
      try {
        const currentUrl = this.getCurrentUrl();
        const connectionStartTime = Date.now(); // S3.3: Track connection time for health scoring
        // FIX 2.1: Mask API keys in log string interpolation.
        // Pino redaction only handles structured fields ({ url: ... }), not template literals.
        // Use same regex pattern as ProviderHealthScorer.maskUrl() for consistency.
        const maskedUrl = currentUrl.replace(/\/([a-zA-Z0-9_-]{12,})/g, (_, key) => '/' + key.slice(0, 5) + '...');
        this.logger.info(`Connecting to WebSocket: ${maskedUrl}${this.rotationStrategy.getCurrentUrlIndex() > 0 ? ' (fallback)' : ''}`);

        this.ws = new WebSocket(currentUrl);

        this.connectionTimeoutTimer = setTimeout(() => {
          if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
            this.ws.close();
            reject(new Error('WebSocket connection timeout'));
          }
        }, this.config.connectionTimeout);

        this.ws.on('open', () => {
          this.clearConnectionTimeout();
          const connectionTime = Date.now() - connectionStartTime;
          this.logger.info('WebSocket connected', { url: currentUrl, chainId: this.chainId, connectionTime });
          this.isConnecting = false;
          this.isConnected = true;
          this.reconnectAttempts = 0;

          // CQ8-ALT: Track connection metrics via health tracker
          this.healthTracker.onConnected();

          // S3.3: Report successful connection to health scorer
          this.rotationStrategy.getHealthScorer().recordSuccess(currentUrl, this.chainId, connectionTime);

          // Start heartbeat
          this.startHeartbeat();

          // Re-subscribe to existing subscriptions
          this.resubscribe();

          // Notify connection handlers
          this.connectionHandlers.forEach(handler => handler(true));

          resolve();
        });

        this.ws.on('message', (data: Buffer) => {
          this.handleMessage(data);
        });

        this.ws.on('error', (error) => {
          this.clearConnectionTimeout();
          this.logger.error('WebSocket error', { error });
          this.isConnecting = false;

          // CQ8-ALT: Rate limit and health scoring via rotation strategy
          if (this.rotationStrategy.isRateLimitError(error)) {
            this.rotationStrategy.handleRateLimit(currentUrl);
            this.rotationStrategy.getHealthScorer().recordRateLimit(currentUrl, this.chainId);
          } else {
            this.rotationStrategy.getHealthScorer().recordFailure(currentUrl, this.chainId, 'connection_error');
          }

          // Notify error handlers
          this.errorHandlers.forEach(handler => {
            try {
              handler(error as Error);
            } catch (handlerError) {
              this.logger.error('Error in error handler', { handlerError });
            }
          });
          reject(error);
        });

        this.ws.on('close', (code: number, reason: Buffer) => {
          this.clearConnectionTimeout();
          const reasonStr = reason.toString();
          this.logger.warn('WebSocket closed', { code, reason: reasonStr, url: currentUrl });
          this.isConnecting = false;
          this.isConnected = false;

          // Stop heartbeat
          this.stopHeartbeat();

          // CQ8-ALT: Rate limit and health scoring via rotation strategy
          if (code === 1008 || code === 1013 ||
              reasonStr.toLowerCase().includes('rate') ||
              reasonStr.toLowerCase().includes('limit')) {
            this.rotationStrategy.handleRateLimit(currentUrl);
            this.rotationStrategy.getHealthScorer().recordRateLimit(currentUrl, this.chainId);
          } else if (code !== 1000) {
            this.rotationStrategy.getHealthScorer().recordConnectionDrop(currentUrl, this.chainId);
          }

          // Notify connection handlers
          this.connectionHandlers.forEach(handler => handler(false));

          // Attempt reconnection if not manually closed
          if (code !== 1000) {
            this.scheduleReconnection();
          }
        });

      } catch (error) {
        this.isConnecting = false;
        this.logger.error('Failed to create WebSocket connection', { error });
        reject(error);
      }
    });

    // P1-FIX: Wrap promise to clear mutex when done (success or failure)
    try {
      await connectionPromise;
    } finally {
      this.connectMutex = null;
      resolveMutex!();
    }
  }

  disconnect(): void {
    this.logger.info('Disconnecting WebSocket');

    // P2-FIX: Set disconnected flag to prevent reconnection attempts
    this.isDisconnected = true;
    // P1-FIX: Clear connection mutex on disconnect
    this.connectMutex = null;
    // P0-2 FIX: Clear resubscribe mutex
    this.resubscribeMutex = null;

    // Clear timers
    this.clearReconnectionTimer();
    this.clearConnectionTimeout();
    this.stopHeartbeat();
    this.healthTracker.stopProactiveHealthCheck(); // CQ8-ALT: Clean up health monitoring

    // Close connection
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }

    // P1-1 FIX (2026-01-16): Clean up pending confirmations to prevent memory leak
    // If confirmations are mid-flight when disconnect() is called, reject them
    // and clear the map to prevent orphaned resolve/reject functions
    if (this.pendingConfirmations) {
      for (const [id, handlers] of this.pendingConfirmations) {
        try {
          handlers.reject(new Error('WebSocket disconnected'));
        } catch {
          // Ignore errors during cleanup
        }
      }
      this.pendingConfirmations.clear();
      this.pendingConfirmations = null;
    }

    // Finding 2.2 Fix: Clean up pending RPC requests to prevent memory leak
    // Similar to pendingConfirmations cleanup above
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      try {
        pending.reject(new Error('WebSocket disconnected'));
      } catch {
        // Ignore errors during cleanup
      }
    }
    this.pendingRequests.clear();

    // P0-2 fix: Clear handler sets to prevent memory leaks
    // P1-2 FIX: Also clear errorHandlers and eventHandlers which were previously missed
    this.messageHandlers.clear();
    this.connectionHandlers.clear();
    this.errorHandlers.clear();
    this.eventHandlers.clear();
    this.subscriptions.clear();

    this.isConnected = false;
    this.isConnecting = false;
    // P2-FIX: Reset reconnection state
    this.isReconnecting = false;

    // BUG-4 FIX: Reset worker pool state on disconnect
    // This prevents stale state if the same instance is reconnected.
    // Note: We DON'T stop the worker pool here because it may be shared.
    // We only reset the connection-specific flags.
    this.workerPoolStarted = false;
    this.workerPoolStarting = false;
    // Reset worker parsing stats to avoid carrying over stale data
    this.workerParsingStats = {
      mainThreadParses: 0,
      workerThreadParses: 0,
      parseErrors: 0,
      poolStartupFallbacks: 0
    };
  }

  subscribe(subscription: Omit<WebSocketSubscription, 'id'>): number {
    const id = this.nextSubscriptionId++;
    const fullSubscription = { ...subscription, id };

    this.subscriptions.set(id, fullSubscription);

    // Send subscription if connected
    if (this.isConnected && this.ws) {
      this.sendSubscription(fullSubscription);
    }

    if (this.logger.isLevelEnabled?.('debug') ?? false) {
      this.logger.debug(`Added subscription`, { id, method: subscription.method });
    }
    return id;
  }

  unsubscribe(subscriptionId: number): void {
    const subscription = this.subscriptions.get(subscriptionId);
    if (subscription) {
      this.subscriptions.delete(subscriptionId);
      if (this.logger.isLevelEnabled?.('debug') ?? false) {
        this.logger.debug(`Removed subscription`, { id: subscriptionId });
      }
    }
  }

  send(message: WebSocketMessage): void {
    if (!this.isConnected || !this.ws) {
      throw new Error('WebSocket not connected');
    }

    try {
      const data = JSON.stringify(message);
      this.ws.send(data);
    } catch (error) {
      this.logger.error('Failed to send WebSocket message', { error });
      throw error;
    }
  }

  onMessage(handler: WebSocketEventHandler): () => void {
    if (this.messageHandlers.size >= WebSocketManager.MAX_HANDLERS_PER_SET) {
      this.logger.warn('Maximum message handlers reached, ignoring new handler', {
        current: this.messageHandlers.size,
        max: WebSocketManager.MAX_HANDLERS_PER_SET
      });
      return () => {}; // Return no-op unsubscribe
    }
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onConnectionChange(handler: ConnectionStateHandler): () => void {
    if (this.connectionHandlers.size >= WebSocketManager.MAX_HANDLERS_PER_SET) {
      this.logger.warn('Maximum connection handlers reached, ignoring new handler', {
        current: this.connectionHandlers.size,
        max: WebSocketManager.MAX_HANDLERS_PER_SET
      });
      return () => {};
    }
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }

  /**
   * Event emitter-style API for subscribing to WebSocket events.
   * Supports: 'message', 'error', 'connected', 'disconnected'
   */
  on(event: string, handler: GenericEventHandler): () => void {
    if (event === 'message') {
      if (this.messageHandlers.size >= WebSocketManager.MAX_HANDLERS_PER_SET) {
        this.logger.warn('Maximum message handlers reached, ignoring new handler', {
          current: this.messageHandlers.size,
          max: WebSocketManager.MAX_HANDLERS_PER_SET
        });
        return () => {};
      }
      this.messageHandlers.add(handler as WebSocketEventHandler);
      return () => this.messageHandlers.delete(handler as WebSocketEventHandler);
    }
    if (event === 'error') {
      if (this.errorHandlers.size >= WebSocketManager.MAX_HANDLERS_PER_SET) {
        this.logger.warn('Maximum error handlers reached, ignoring new handler', {
          current: this.errorHandlers.size,
          max: WebSocketManager.MAX_HANDLERS_PER_SET
        });
        return () => {};
      }
      this.errorHandlers.add(handler as ErrorEventHandler);
      return () => this.errorHandlers.delete(handler as ErrorEventHandler);
    }
    if (event === 'connected' || event === 'disconnected') {
      if (this.connectionHandlers.size >= WebSocketManager.MAX_HANDLERS_PER_SET) {
        this.logger.warn('Maximum connection handlers reached, ignoring new handler', {
          current: this.connectionHandlers.size,
          max: WebSocketManager.MAX_HANDLERS_PER_SET
        });
        return () => {};
      }
      const wrappedHandler: ConnectionStateHandler = (connected: boolean) => {
        if ((event === 'connected' && connected) || (event === 'disconnected' && !connected)) {
          handler();
        }
      };
      this.connectionHandlers.add(wrappedHandler);
      return () => this.connectionHandlers.delete(wrappedHandler);
    }
    // Generic event handler
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    const eventSet = this.eventHandlers.get(event)!;
    if (eventSet.size >= WebSocketManager.MAX_HANDLERS_PER_SET) {
      this.logger.warn('Maximum event handlers reached, ignoring new handler', {
        event,
        current: eventSet.size,
        max: WebSocketManager.MAX_HANDLERS_PER_SET
      });
      return () => {};
    }
    eventSet.add(handler);
    return () => this.eventHandlers.get(event)?.delete(handler);
  }

  /**
   * Emit an event to all registered handlers.
   */
  private emit(event: string, ...args: any[]): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.forEach(handler => {
        try {
          handler(...args);
        } catch (error) {
          this.logger.error(`Error in event handler for ${event}`, { error });
        }
      });
    }
  }

  isWebSocketConnected(): boolean {
    return this.isConnected && this.ws?.readyState === WebSocket.OPEN;
  }

  getConnectionStats(): any {
    return {
      connected: this.isConnected,
      connecting: this.isConnecting,
      reconnectAttempts: this.reconnectAttempts,
      subscriptions: this.subscriptions.size,
      readyState: this.ws?.readyState,
      currentUrl: this.getCurrentUrl(),
      currentUrlIndex: this.rotationStrategy.getCurrentUrlIndex(),
      totalUrls: this.rotationStrategy.getTotalUrls()
    };
  }

  /**
   * P0-2 fix: Public method to clear all handlers.
   * Call this before stopping to prevent memory leaks from stale handlers.
   */
  removeAllListeners(): void {
    this.messageHandlers.clear();
    this.connectionHandlers.clear();
    this.errorHandlers.clear();
    this.eventHandlers.clear();
  }

  /**
   * PERF-001: Get current listener counts for monitoring handler accumulation.
   */
  getListenerStats(): { messageHandlers: number; connectionHandlers: number; errorHandlers: number; eventHandlers: number } {
    let eventHandlerCount = 0;
    for (const handlers of this.eventHandlers.values()) {
      eventHandlerCount += handlers.size;
    }
    return {
      messageHandlers: this.messageHandlers.size,
      connectionHandlers: this.connectionHandlers.size,
      errorHandlers: this.errorHandlers.size,
      eventHandlers: eventHandlerCount,
    };
  }

  private handleMessage(data: Buffer): void {
    const dataString = data.toString();
    const dataSize = data.length;

    // Reject oversized messages
    if (dataSize > this.maxMessageSize) {
      this.logger.warn('Oversized WebSocket message received, closing connection', {
        chainId: this.chainId,
        messageSize: dataSize,
        maxMessageSize: this.maxMessageSize,
      });
      if (this.ws) {
        this.ws.close(1008, `Message size ${dataSize} exceeds limit ${this.maxMessageSize}`);
      }
      return;
    }

    // Phase 2: Worker Thread JSON Parsing
    // Use worker pool for large payloads to avoid blocking main thread
    // Small payloads use main thread (overhead not worth it)
    const shouldUseWorker = this.useWorkerParsing &&
                            this.workerPool &&
                            dataSize >= this.workerParsingThresholdBytes;

    if (shouldUseWorker) {
      // Async path: Parse in worker thread (non-blocking for large payloads)
      this.workerParsingStats.workerThreadParses++;
      this.parseMessageInWorker(dataString);
    } else {
      // Sync path: Parse on main thread (fast for small payloads)
      this.workerParsingStats.mainThreadParses++;
      this.parseMessageSync(dataString);
    }
  }

  /**
   * Phase 2: Parse message synchronously on main thread.
   * Used for small payloads where worker overhead exceeds benefits.
   */
  private parseMessageSync(dataString: string): void {
    try {
      const message: WebSocketMessage = JSON.parse(dataString);
      this.processMessage(message);
    } catch (error) {
      this.logger.error('Failed to parse WebSocket message', { error, data: dataString.slice(0, 200) });
      this.healthTracker.qualityMetrics.errorsEncountered++;
      this.workerParsingStats.parseErrors++;
    }
  }

  /**
   * Phase 2: Parse message asynchronously in worker thread.
   * Used for large payloads to avoid blocking main event loop.
   * Fire-and-forget: errors are logged but don't propagate.
   *
   * If worker pool isn't ready, falls back to synchronous parsing (fail-safe).
   */
  private parseMessageInWorker(dataString: string): void {
    // Ensure worker pool is started (lazy initialization)
    if (!this.workerPoolStarted && !this.workerPoolStarting) {
      this.startWorkerPoolAsync();
    }

    // If pool isn't ready yet, fall back to sync parsing (fail-safe)
    // This prevents message loss during pool startup
    if (!this.workerPoolStarted) {
      this.workerParsingStats.poolStartupFallbacks++;
      this.parseMessageSync(dataString);
      return;
    }

    // Fire-and-forget async parsing - errors are caught and logged
    this.workerPool!.parseJson<WebSocketMessage>(dataString)
      .then(message => {
        this.processMessage(message);
      })
      .catch(error => {
        this.logger.error('Worker thread JSON parse failed', {
          error: getErrorMessage(error),
          dataPreview: dataString.slice(0, 200)
        });
        this.healthTracker.qualityMetrics.errorsEncountered++;
        this.workerParsingStats.parseErrors++;
      });
  }

  /**
   * Phase 2: Start worker pool asynchronously (non-blocking).
   * Called lazily when worker parsing is first needed.
   *
   * RACE-1 FIX: Set workerPoolStarting flag synchronously at the START of this method
   * to prevent multiple concurrent calls from reaching the async start() call.
   * The previous code had a window where multiple messages could trigger multiple calls
   * before the flag was set.
   */
  private startWorkerPoolAsync(): void {
    // RACE-1 FIX: Early exit if already starting or started (atomic check)
    if (this.workerPoolStarting || this.workerPoolStarted) return;

    // RACE-1 FIX: Set flag IMMEDIATELY (synchronously) before any async operations
    // This closes the race window where multiple calls could pass the check above
    this.workerPoolStarting = true;
    if (this.logger.isLevelEnabled?.('debug') ?? false) {
      this.logger.debug('Starting worker pool for JSON parsing', { chainId: this.chainId });
    }

    // Non-blocking pool startup
    this.workerPool!.start()
      .then(() => {
        this.workerPoolStarted = true;
        this.workerPoolStarting = false;
        this.logger.info('Worker pool ready for JSON parsing', { chainId: this.chainId });
      })
      .catch(error => {
        this.workerPoolStarting = false;
        this.logger.error('Failed to start worker pool, disabling worker parsing', {
          chainId: this.chainId,
          error: getErrorMessage(error)
        });
        // Disable worker parsing on failure
        this.useWorkerParsing = false;
      });
  }

  /**
   * Process a parsed WebSocket message.
   * Shared logic for both sync and async parsing paths.
   */
  private processMessage(message: WebSocketMessage): void {
    // S3.3: Update quality metrics (direct property access for hot-path performance)
    this.healthTracker.qualityMetrics.lastMessageTime = Date.now();
    this.healthTracker.qualityMetrics.messagesReceived++;

    // NOTE: Budget tracking is NOT done for inbound messages.
    // Budget is only tracked for outbound requests (subscriptions, RPC calls).
    // Inbound messages (subscription data) don't consume CU quota.

    // S3.3: Handle pending subscription confirmations
    if (message.id !== undefined && this.pendingConfirmations?.has(message.id)) {
      const confirmation = this.pendingConfirmations.get(message.id);
      if (confirmation) {
        if (message.error) {
          confirmation.reject(new Error(message.error.message || 'Subscription error'));
        } else {
          confirmation.resolve();
        }
      }
    }

    // Finding 2.2 Fix: Handle pending RPC request responses
    // This enables proactive staleness detection via sendRequest()
    if (message.id !== undefined && this.pendingRequests.has(message.id)) {
      const pending = this.pendingRequests.get(message.id)!;
      this.pendingRequests.delete(message.id);
      clearTimeout(pending.timeout);

      if (message.error) {
        pending.reject(new Error(message.error.message || `RPC error: ${JSON.stringify(message.error)}`));
      } else {
        pending.resolve(message.result);
      }
      // Don't return - still notify message handlers for logging/debugging
    }

    // S3.3: Check for rate limit errors in JSON-RPC responses
    if (message.error && this.rotationStrategy.isRateLimitError(message.error)) {
      this.rotationStrategy.handleRateLimit(this.getCurrentUrl());
      this.healthTracker.qualityMetrics.errorsEncountered++;
      // Still notify handlers so they can handle the error
    }

    // S3.3: Track block numbers from newHeads subscriptions
    if (message.params?.result?.number) {
      const blockNumber = parseInt(message.params.result.number, 16);
      if (!isNaN(blockNumber)) {
        // CQ8-ALT: Check for data gaps via health tracker
        const gap = this.healthTracker.checkForDataGap(blockNumber);
        if (gap) {
          this.emit('dataGap', {
            chainId: this.chainId,
            ...gap,
            url: this.getCurrentUrl()
          });
        }
        this.healthTracker.qualityMetrics.lastBlockNumber = blockNumber;
        // Report to health scorer for freshness tracking
        this.rotationStrategy.getHealthScorer().recordBlock(this.getCurrentUrl(), this.chainId, blockNumber);
      }
    }

    // Notify all message handlers
    this.messageHandlers.forEach(handler => {
      try {
        handler(message);
      } catch (error) {
        this.logger.error('Error in WebSocket message handler', { error });
        this.healthTracker.qualityMetrics.errorsEncountered++;
      }
    });
  }

  private sendSubscription(subscription: WebSocketSubscription): void {
    if (!this.isConnected || !this.ws) return;

    try {
      const message = {
        jsonrpc: '2.0',
        id: subscription.id,
        method: subscription.method,
        params: subscription.params
      };

      this.ws.send(JSON.stringify(message));

      // 6-Provider Shield: Track outbound requests for budget management
      this.rotationStrategy.recordRequestForBudget(subscription.method);

      if (this.logger.isLevelEnabled?.('debug') ?? false) {
        this.logger.debug(`Sent subscription`, { id: subscription.id, method: subscription.method });
      }
    } catch (error) {
      this.logger.error('Failed to send subscription', { error, subscription });
    }
  }

  private resubscribe(): void {
    // Re-send all active subscriptions
    for (const subscription of this.subscriptions.values()) {
      this.sendSubscription(subscription);
    }
  }

  // ===========================================================================
  // Finding 2.2 Fix: JSON-RPC Request Method for Proactive Staleness Detection
  // ===========================================================================

  /**
   * Send a JSON-RPC request and wait for the response.
   *
   * Finding 2.2 Fix: Enables proactive staleness detection by allowing
   * eth_blockNumber queries without waiting for the next block event.
   *
   * @param method - JSON-RPC method name (e.g., 'eth_blockNumber')
   * @param params - Method parameters (default: [])
   * @param timeoutMs - Request timeout in ms (default: 5000)
   * @returns Promise resolving to the result or rejecting on error/timeout
   *
   * @example
   * const blockNumber = await wsManager.sendRequest('eth_blockNumber');
   * // Returns hex string like '0x1234567'
   */
  async sendRequest<T = unknown>(
    method: string,
    params: unknown[] = [],
    timeoutMs: number = this.rpcRequestTimeoutMs
  ): Promise<T> {
    if (!this.isConnected || !this.ws) {
      throw new Error('WebSocket not connected');
    }

    const id = this.nextRequestId++;

    return new Promise<T>((resolve, reject) => {
      // Set up timeout for the request
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`RPC request timeout: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);

      // Store the pending request
      this.pendingRequests.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timeout
      });

      // Send the request
      try {
        const message = {
          jsonrpc: '2.0',
          id,
          method,
          params
        };

        this.ws!.send(JSON.stringify(message));

        // Track for budget
        this.rotationStrategy.recordRequestForBudget(method);

        if (this.logger.isLevelEnabled?.('debug') ?? false) {
          this.logger.debug('Sent RPC request', { id, method });
        }
      } catch (error) {
        // Clean up on send failure
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * S3.3: Resubscribe with validation - confirms each subscription was accepted.
   * Emits 'subscriptionRecoveryPartial' event if some subscriptions fail.
   *
   * @param timeoutMs - Timeout for each subscription confirmation (default 5000ms)
   * P0-2 FIX (2026-01-16): Added mutex protection to prevent concurrent resubscriptions.
   * Without mutex, concurrent calls could cause duplicate subscriptions and ID collisions
   * in the pendingConfirmations map, leading to orphaned timeout handlers.
   */
  async resubscribeWithValidation(timeoutMs = 5000): Promise<{ success: number; failed: number }> {
    // P0-2 FIX: If resubscription is already in progress, return its result
    // This prevents duplicate subscriptions and ID collisions
    if (this.resubscribeMutex) {
      this.logger.debug('Resubscription already in progress, waiting for existing operation');
      return this.resubscribeMutex;
    }

    const results = { success: 0, failed: 0 };

    if (this.subscriptions.size === 0) {
      return results;
    }

    // P0-2 FIX: Create mutex promise BEFORE starting work
    let resolveMutex: (value: { success: number; failed: number }) => void;
    this.resubscribeMutex = new Promise(resolve => { resolveMutex = resolve; });

    this.logger.info('Starting subscription recovery with validation', {
      chainId: this.chainId,
      subscriptionCount: this.subscriptions.size
    });

    try {
      for (const subscription of this.subscriptions.values()) {
        try {
          await this.sendSubscriptionWithTimeout(subscription, timeoutMs);
          results.success++;
        } catch (error) {
          results.failed++;
          this.logger.error('Subscription recovery failed', {
            id: subscription.id,
            method: subscription.method,
            error
          });
        }
      }

      this.logger.info('Subscription recovery completed', {
        chainId: this.chainId,
        ...results
      });

      if (results.failed > 0) {
        this.emit('subscriptionRecoveryPartial', results);
      }

      return results;
    } finally {
      // P0-2 FIX: Always clear mutex and resolve waiters
      this.resubscribeMutex = null;
      resolveMutex!(results);
    }
  }

  /**
   * S3.3: Send a subscription and wait for confirmation with timeout.
   *
   * @param subscription - The subscription to send
   * @param timeoutMs - Timeout in milliseconds
   */
  private sendSubscriptionWithTimeout(
    subscription: WebSocketSubscription,
    timeoutMs: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.isConnected || !this.ws) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      const messageId = subscription.id;
      let timeoutHandle: NodeJS.Timeout;

      // Set up timeout
      timeoutHandle = setTimeout(() => {
        this.pendingConfirmations?.delete(messageId);
        reject(new Error(`Subscription confirmation timeout: ${messageId}`));
      }, timeoutMs);

      // Store confirmation handler
      if (!this.pendingConfirmations) {
        this.pendingConfirmations = new Map();
      }

      this.pendingConfirmations.set(messageId, {
        resolve: () => {
          clearTimeout(timeoutHandle);
          this.pendingConfirmations?.delete(messageId);
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(timeoutHandle);
          this.pendingConfirmations?.delete(messageId);
          reject(error);
        }
      });

      // Send the subscription
      this.sendSubscription(subscription);
    });
  }

  /** S3.3: Pending subscription confirmations */
  private pendingConfirmations: Map<number, {
    resolve: () => void;
    reject: (error: Error) => void;
  }> | null = null;

  /**
   * P0-2 FIX: Mutex for resubscribeWithValidation to prevent concurrent executions.
   * Multiple concurrent calls could cause duplicate subscriptions and ID collisions.
   */
  private resubscribeMutex: Promise<{ success: number; failed: number }> | null = null;

  /**
   * S3.3: Detect data gaps after reconnection.
   * Compares last known block to current block and emits 'dataGap' event if blocks were missed.
   *
   * Finding 2.2 Fix: Now implements proactive staleness detection via eth_blockNumber RPC call.
   * Previously this was a placeholder that always returned null, relying on passive detection.
   *
   * @returns Information about any detected gap, or null if no gap/error
   *
   * @example
   * const gap = await wsManager.detectDataGaps();
   * if (gap) {
   *   console.log(`Missed ${gap.missedBlocks} blocks (${gap.fromBlock} to ${gap.toBlock})`);
   * }
   */
  async detectDataGaps(): Promise<{
    fromBlock: number;
    toBlock: number;
    missedBlocks: number;
  } | null> {
    const lastKnownBlock = this.healthTracker.qualityMetrics.lastBlockNumber;

    // Can't detect gaps without a known block
    if (lastKnownBlock === 0) {
      return null;
    }

    // Can't query if not connected
    if (!this.isConnected || !this.ws) {
      return null;
    }

    try {
      // Finding 2.2 Fix: Proactive staleness detection via eth_blockNumber RPC
      // This allows gap detection without waiting for the next block event
      const result = await this.sendRequest<string>('eth_blockNumber', [], 3000);

      // Parse hex block number (e.g., '0x1234567' -> 19088743)
      const currentBlock = parseInt(result, 16);

      if (isNaN(currentBlock)) {
        this.logger.warn('Failed to parse eth_blockNumber result', { result });
        return null;
      }

      const missedBlocks = currentBlock - lastKnownBlock - 1;

      if (missedBlocks > 0) {
        const gapInfo = {
          fromBlock: lastKnownBlock + 1,
          toBlock: currentBlock - 1,
          missedBlocks
        };

        this.logger.warn('Proactive gap detection found missing blocks', {
          chainId: this.chainId,
          lastKnownBlock,
          currentBlock,
          missedBlocks
        });

        // Emit the same event as passive detection for consistency
        this.emit('dataGap', {
          chainId: this.chainId,
          ...gapInfo,
          url: this.getCurrentUrl()
        });

        return gapInfo;
      }

      // No gap - we're up to date
      // Update last known block if current is newer
      if (currentBlock > lastKnownBlock) {
        this.healthTracker.qualityMetrics.lastBlockNumber = currentBlock;
        this.rotationStrategy.getHealthScorer().recordBlock(this.getCurrentUrl(), this.chainId, currentBlock);
      }

      return null;
    } catch (error) {
      // Log but don't throw - proactive detection is best-effort
      if (this.logger.isLevelEnabled?.('debug') ?? false) {
        this.logger.debug('Proactive gap detection failed (falling back to passive)', {
          chainId: this.chainId,
          error: getErrorMessage(error)
        });
      }
      return null;
    }
  }

  // CQ8-ALT: checkForDataGap() moved to ProviderHealthTracker

  /**
   * Calculate reconnection delay using exponential backoff with jitter.
   * CQ8-ALT: Delegates to ProviderRotationStrategy.
   */
  calculateReconnectDelay(attempt: number): number {
    return this.rotationStrategy.calculateReconnectDelay(attempt);
  }

  /**
   * S3.3: Check if an error indicates rate limiting.
   * CQ8-ALT: Delegates to ProviderRotationStrategy.
   */
  isRateLimitError(error: any): boolean {
    return this.rotationStrategy.isRateLimitError(error);
  }

  /**
   * S3.3: Check if a provider URL is currently excluded.
   * CQ8-ALT: Delegates to ProviderRotationStrategy.
   */
  isProviderExcluded(url: string): boolean {
    return this.rotationStrategy.isProviderExcluded(url);
  }

  /**
   * S3.3: Handle rate limit detection by excluding the provider.
   * CQ8-ALT: Delegates to ProviderRotationStrategy.
   */
  handleRateLimit(url: string): void {
    this.rotationStrategy.handleRateLimit(url);
    this.emit('rateLimit', { url, chainId: this.chainId });
  }

  /**
   * S3.3: Get available (non-excluded) provider count.
   * CQ8-ALT: Delegates to ProviderRotationStrategy.
   */
  getAvailableProviderCount(): number {
    return this.rotationStrategy.getAvailableProviderCount();
  }

  /**
   * S3.3: Get all excluded providers for diagnostics.
   * CQ8-ALT: Delegates to ProviderRotationStrategy.
   */
  getExcludedProviders(): Map<string, { until: number; count: number }> {
    return this.rotationStrategy.getExcludedProviders();
  }

  /**
   * S3.3: Clear all provider exclusions.
   * CQ8-ALT: Delegates to ProviderRotationStrategy.
   */
  clearProviderExclusions(): void {
    this.rotationStrategy.clearProviderExclusions();
  }

  /**
   * S3.3: Get connection quality metrics.
   * CQ8-ALT: Delegates to ProviderHealthTracker.
   */
  getQualityMetrics(): {
    lastMessageTime: number;
    messageGapMs: number;
    lastBlockNumber: number;
    reconnectCount: number;
    uptime: number;
    messagesReceived: number;
    errorsEncountered: number;
    isStale: boolean;
  } {
    return this.healthTracker.getQualityMetrics(this.subscriptions.size);
  }

  /**
   * S3.3: Check if the connection appears stale.
   * CQ8-ALT: Delegates to ProviderHealthTracker.
   */
  isConnectionStale(): boolean {
    return this.healthTracker.isConnectionStale(this.subscriptions.size);
  }

  /**
   * S3.3: Set the staleness threshold for proactive rotation.
   * CQ8-ALT: Delegates to ProviderHealthTracker.
   */
  setStalenessThreshold(thresholdMs: number): void {
    this.healthTracker.setStalenessThreshold(thresholdMs);
  }

  /**
   * S3.3: Start proactive health monitoring.
   * CQ8-ALT: Delegates to ProviderHealthTracker with callback for stale detection.
   */
  startProactiveHealthCheck(intervalMs = 10000): void {
    this.healthTracker.startProactiveHealthCheck(
      intervalMs,
      () => {
        // Stale connection callback
        this.emit('staleConnection', {
          chainId: this.chainId,
          url: this.getCurrentUrl(),
          messageGapMs: this.healthTracker.qualityMetrics.messageGapMs
        });

        // Trigger reconnection to a different provider
        this.rotationStrategy.handleRateLimit(this.getCurrentUrl());
        this.scheduleReconnection();
      },
      () => this.isConnected,
      () => this.subscriptions.size,
    );
  }

  /**
   * S3.3: Stop proactive health monitoring.
   * CQ8-ALT: Delegates to ProviderHealthTracker.
   */
  stopProactiveHealthCheck(): void {
    this.healthTracker.stopProactiveHealthCheck();
  }

  /**
   * S3.3: Record a block number (can be called externally).
   * CQ8-ALT: Delegates to ProviderHealthTracker.
   */
  recordBlockNumber(blockNumber: number): void {
    this.healthTracker.recordBlockNumber(blockNumber);
  }

  private scheduleReconnection(): void {
    // P2-FIX: Don't reconnect if explicitly disconnected
    if (this.isDisconnected) {
      this.logger.debug('Skipping reconnection - manager was explicitly disconnected');
      return;
    }

    // P2-FIX: Don't schedule if already reconnecting or timer exists
    if (this.reconnectTimer || this.isReconnecting) {
      return;
    }

    // CQ8-ALT: Track reconnection attempts via health tracker
    this.healthTracker.onReconnecting();

    if (this.reconnectAttempts >= (this.config.maxReconnectAttempts ?? 10)) {
      this.logger.error('Max reconnection attempts reached across all URLs — scheduling slow recovery');
      // Emit error for handlers
      this.errorHandlers.forEach(handler => {
        try {
          handler(new Error('Max reconnection attempts reached'));
        } catch (e) {
          this.logger.error('Error in error handler', { error: e });
        }
      });

      // Schedule a slow recovery attempt (60s) to avoid permanent WS death
      // without causing reconnect storms. Resets attempts and tries again.
      if (!this.recoveryTimer && !this.isDisconnected) {
        const recoveryDelayMs = 60_000;
        this.logger.info(`Scheduling slow recovery attempt in ${recoveryDelayMs}ms`);
        this.recoveryTimer = setTimeout(() => {
          this.recoveryTimer = null;
          if (this.isDisconnected) return;
          this.logger.info('Slow recovery: resetting reconnect attempts and retrying');
          this.reconnectAttempts = 0;
          this.rotationStrategy.switchToNextUrl(); // Try a different URL
          this.scheduleReconnection();
        }, recoveryDelayMs);
      }
      return;
    }

    // CQ8-ALT: Try fallback URL via rotation strategy
    const hasNextUrl = this.rotationStrategy.switchToNextUrl();
    if (!hasNextUrl) {
      // We've tried all URLs, increment the cycle counter
      this.reconnectAttempts++;
    }

    // Use exponential backoff with jitter for reconnection delay
    const delay = this.rotationStrategy.calculateReconnectDelay(this.reconnectAttempts);

    this.logger.info(`Scheduling reconnection attempt ${this.reconnectAttempts}/${this.config.maxReconnectAttempts} to ${this.getCurrentUrl()} in ${delay}ms (exponential backoff)`);

    this.reconnectTimer = setTimeout(async () => {
      // P2-FIX: Clear timer reference immediately and set reconnecting flag
      this.reconnectTimer = null;

      // P2-FIX: Check if we were disconnected while waiting
      if (this.isDisconnected) {
        this.logger.debug('Aborting reconnection - manager was disconnected during wait');
        return;
      }

      this.isReconnecting = true;

      try {
        await this.connect();
        this.isReconnecting = false;
      } catch (error) {
        this.isReconnecting = false;
        this.logger.error(`Reconnection to ${this.getCurrentUrl()} failed`, { error });

        // P2-FIX: Only schedule next attempt if not disconnected
        if (!this.isDisconnected) {
          this.scheduleReconnection();
        }
      }
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat(); // Clear any existing heartbeat

    this.heartbeatTimer = setInterval(() => {
      if (this.isConnected && this.ws) {
        // Send a ping or simple request to keep connection alive
        try {
          this.ws.ping();
        } catch (error) {
          this.logger.error('Failed to send heartbeat ping', { error });
        }
      }
    }, this.config.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    this.heartbeatTimer = clearIntervalSafe(this.heartbeatTimer);
  }

  private clearConnectionTimeout(): void {
    this.connectionTimeoutTimer = clearTimeoutSafe(this.connectionTimeoutTimer);
  }

  private clearReconnectionTimer(): void {
    this.reconnectTimer = clearTimeoutSafe(this.reconnectTimer);
    this.recoveryTimer = clearTimeoutSafe(this.recoveryTimer);
  }
}