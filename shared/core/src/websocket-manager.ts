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
import { getProviderHealthScorer, ProviderHealthScorer, METHOD_CU_COSTS } from './monitoring/provider-health-scorer';
import { EventProcessingWorkerPool, getWorkerPool } from './async/worker-pool';

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
}

/**
 * T1.5: Chain-specific staleness thresholds based on block times.
 * Fast chains need aggressive staleness detection to avoid missing opportunities.
 */
const CHAIN_STALENESS_THRESHOLDS: Record<string, number> = {
  // Fast chains (sub-1s block times) - 5 seconds
  arbitrum: 5000,
  solana: 5000,

  // Medium chains (1-3s block times) - 10 seconds
  polygon: 10000,
  bsc: 10000,
  optimism: 10000,
  base: 10000,
  avalanche: 10000,
  fantom: 10000,

  // Slow chains (10+ second block times) - 15 seconds
  ethereum: 15000,
  zksync: 15000,
  linea: 15000,

  // Default for unknown chains
  default: 15000
};

/**
 * T1.5: Get staleness threshold for a specific chain.
 */
function getChainStalenessThreshold(chainId: string): number {
  const normalizedChain = chainId.toLowerCase();
  return CHAIN_STALENESS_THRESHOLDS[normalizedChain] ?? CHAIN_STALENESS_THRESHOLDS.default;
}

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
  private ws: WebSocket | null = null;
  private config: WebSocketConfig;
  private logger = createLogger('websocket-manager');

  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private connectionTimeoutTimer: NodeJS.Timeout | null = null;
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

  /** All available URLs (primary + fallbacks) */
  private allUrls: string[] = [];
  /** Current URL index being used */
  private currentUrlIndex = 0;

  /** Chain ID for health tracking */
  private chainId: string;

  /**
   * S3.3: Rate limit exclusion tracking
   * Maps URL to exclusion info { until: timestamp, count: consecutive rate limits }
   */
  private excludedProviders: Map<string, { until: number; count: number }> = new Map();

  /**
   * S3.3: Connection quality metrics for proactive health monitoring
   */
  private qualityMetrics = {
    /** Timestamp of last received message */
    lastMessageTime: 0,
    /** Time since last message in ms (updated periodically) */
    messageGapMs: 0,
    /** Last block number seen (for block-based subscriptions) */
    lastBlockNumber: 0,
    /** Total reconnection count during this session */
    reconnectCount: 0,
    /** Connection start time for uptime calculation */
    connectionStartTime: 0,
    /** Total messages received */
    messagesReceived: 0,
    /** Total errors encountered */
    errorsEncountered: 0
  };

  /** Proactive health check interval timer */
  private healthCheckTimer: NodeJS.Timeout | null = null;
  /**
   * T1.5: Staleness threshold in ms - now chain-specific.
   * Previous: Fixed 30 seconds for all chains.
   * New: 5s (fast chains) / 10s (medium) / 15s (slow) based on block times.
   */
  private stalenessThresholdMs: number;

  /** S3.3: Provider health scorer for intelligent fallback selection */
  private healthScorer: ProviderHealthScorer;

  /** S3.3: Whether to use intelligent fallback selection (default true) */
  private useIntelligentFallback = true;

  /** Whether to use budget-aware provider selection (6-Provider Shield) */
  private useBudgetAwareSelection = true;

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

  constructor(config: WebSocketConfig) {
    this.config = {
      reconnectInterval: 1000,  // Base delay for exponential backoff
      maxReconnectAttempts: 10,
      heartbeatInterval: config.pingInterval || 30000,
      connectionTimeout: 10000,
      backoffMultiplier: 2.0,
      maxReconnectDelay: 60000,
      jitterPercent: 0.25,
      ...config
    };
    this.chainId = config.chainId || 'unknown';

    // T1.5: Set staleness threshold based on chain type or explicit config
    // Fast chains (arbitrum, solana): 5s
    // Medium chains (polygon, bsc, optimism, base): 10s
    // Slow chains (ethereum): 15s
    this.stalenessThresholdMs = config.stalenessThresholdMs ??
      getChainStalenessThreshold(this.chainId);

    this.logger.debug('Staleness threshold configured', {
      chainId: this.chainId,
      stalenessThresholdMs: this.stalenessThresholdMs
    });

    // S3.3: Initialize health scorer for intelligent fallback selection
    this.healthScorer = getProviderHealthScorer();

    // Build list of all URLs (primary + fallbacks)
    this.allUrls = [config.url];
    if (config.fallbackUrls && config.fallbackUrls.length > 0) {
      this.allUrls.push(...config.fallbackUrls);
    }
    this.currentUrlIndex = 0;

    // Phase 2: Initialize worker thread JSON parsing
    // P1-PHASE1: Enable by default for production (NODE_ENV=production or detected production environment)
    // Worker parsing reduces main thread blocking by 20-30% for large payloads
    const isProduction = process.env.NODE_ENV === 'production' ||
      process.env.FLY_APP_NAME !== undefined ||
      process.env.RAILWAY_ENVIRONMENT !== undefined;
    const workerParsingDefault = isProduction;

    this.useWorkerParsing = config.useWorkerParsing ?? workerParsingDefault;
    this.workerParsingThresholdBytes = config.workerParsingThresholdBytes ?? 2048;

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
   * Get the current active WebSocket URL
   */
  getCurrentUrl(): string {
    return this.allUrls[this.currentUrlIndex] || this.config.url;
  }

  /**
   * Extract provider name from URL for budget tracking.
   * Maps common provider URL patterns to their names.
   */
  private extractProviderFromUrl(url: string): string {
    const lowerUrl = url.toLowerCase();

    // Check for API-key providers (more specific patterns first)
    if (lowerUrl.includes('drpc.org') || lowerUrl.includes('lb.drpc.org')) return 'drpc';
    if (lowerUrl.includes('ankr.com') || lowerUrl.includes('rpc.ankr.com')) return 'ankr';
    if (lowerUrl.includes('publicnode.com')) return 'publicnode';
    if (lowerUrl.includes('infura.io')) return 'infura';
    if (lowerUrl.includes('alchemy.com') || lowerUrl.includes('alchemyapi.io')) return 'alchemy';
    if (lowerUrl.includes('quicknode') || lowerUrl.includes('quiknode')) return 'quicknode';
    if (lowerUrl.includes('blastapi.io')) return 'blastapi';

    // Chain-specific RPCs
    if (lowerUrl.includes('1rpc.io')) return '1rpc';
    if (lowerUrl.includes('llamarpc.com')) return 'llamarpc';
    if (lowerUrl.includes('binance.org')) return 'binance';
    if (lowerUrl.includes('arbitrum.io')) return 'arbitrum-official';
    if (lowerUrl.includes('optimism.io')) return 'optimism-official';
    if (lowerUrl.includes('base.org')) return 'base-official';
    if (lowerUrl.includes('polygon-rpc.com')) return 'polygon-official';

    // Solana-specific
    if (lowerUrl.includes('helius')) return 'helius';
    if (lowerUrl.includes('triton')) return 'triton';
    if (lowerUrl.includes('solana.com') || lowerUrl.includes('mainnet-beta.solana')) return 'solana-official';

    return 'unknown';
  }

  /**
   * S3.3: Select the best available fallback URL using health scoring.
   * Updated with budget-aware selection from 6-Provider Shield.
   * Falls back to round-robin if all candidates have similar scores.
   *
   * @returns The best available URL or null if all are excluded
   */
  private selectBestFallbackUrl(): string | null {
    const currentUrl = this.getCurrentUrl();

    // Get available (non-excluded) candidates excluding current
    const candidates = this.allUrls.filter(url =>
      url !== currentUrl && !this.isProviderExcluded(url)
    );

    if (candidates.length === 0) {
      this.logger.warn('No available fallback URLs', { chainId: this.chainId });
      return null;
    }

    if (!this.useIntelligentFallback || candidates.length === 1) {
      return candidates[0];
    }

    // Use budget-aware selection if enabled (6-Provider Shield)
    if (this.useBudgetAwareSelection) {
      const selectedUrl = this.healthScorer.selectBestProviderWithBudget(
        this.chainId,
        candidates,
        (url) => this.extractProviderFromUrl(url)
      );

      this.logger.info('Selected best fallback URL via budget-aware scoring', {
        chainId: this.chainId,
        selectedUrl,
        provider: this.extractProviderFromUrl(selectedUrl),
        candidateCount: candidates.length,
        score: this.healthScorer.getHealthScore(selectedUrl, this.chainId)
      });

      return selectedUrl;
    }

    // Use health scorer for intelligent selection
    const selectedUrl = this.healthScorer.selectBestProvider(this.chainId, candidates);

    this.logger.info('Selected best fallback URL via health scoring', {
      chainId: this.chainId,
      selectedUrl,
      candidateCount: candidates.length,
      score: this.healthScorer.getHealthScore(selectedUrl, this.chainId)
    });

    return selectedUrl;
  }

  /**
   * Switch to the next fallback URL, using intelligent selection (S3.3).
   * Returns true if there's another URL to try, false if we've exhausted all options.
   */
  private switchToNextUrl(): boolean {
    const startIndex = this.currentUrlIndex;

    // Try intelligent selection first
    const bestUrl = this.selectBestFallbackUrl();
    if (bestUrl) {
      const newIndex = this.allUrls.indexOf(bestUrl);
      if (newIndex !== -1 && newIndex !== startIndex) {
        this.currentUrlIndex = newIndex;
        this.logger.info(`Switching to fallback URL ${this.currentUrlIndex}: ${this.getCurrentUrl()}`);
        return true;
      }
    }

    // Fallback to sequential search if intelligent selection fails
    for (let i = 1; i <= this.allUrls.length; i++) {
      const nextIndex = (startIndex + i) % this.allUrls.length;
      const nextUrl = this.allUrls[nextIndex];

      // Skip excluded providers
      if (this.isProviderExcluded(nextUrl)) {
        this.logger.debug(`Skipping excluded provider ${nextIndex}: ${nextUrl}`);
        continue;
      }

      // Found a valid URL
      if (nextIndex !== startIndex) {
        this.currentUrlIndex = nextIndex;
        this.logger.info(`Switching to fallback URL ${this.currentUrlIndex}: ${this.getCurrentUrl()}`);
        return true;
      }
    }

    // All URLs are either exhausted or excluded
    // Reset to primary URL for next reconnection cycle (it may become available)
    this.currentUrlIndex = 0;
    return false;
  }

  /**
   * S3.3: Enable or disable intelligent fallback selection.
   *
   * @param enabled - Whether to use health scoring for fallback selection
   */
  setIntelligentFallback(enabled: boolean): void {
    this.useIntelligentFallback = enabled;
  }

  /**
   * Enable or disable budget-aware provider selection (6-Provider Shield).
   *
   * @param enabled - Whether to consider provider budgets in selection
   */
  setBudgetAwareSelection(enabled: boolean): void {
    this.useBudgetAwareSelection = enabled;
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
    this.logger.debug('Worker parsing threshold changed', {
      chainId: this.chainId,
      thresholdBytes: this.workerParsingThresholdBytes
    });
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
   * Call this for subscription messages to track provider usage.
   *
   * @param method - RPC method called (default: 'eth_subscribe')
   */
  recordRequestForBudget(method = 'eth_subscribe'): void {
    const currentUrl = this.getCurrentUrl();
    const providerName = this.extractProviderFromUrl(currentUrl);
    this.healthScorer.recordRequest(providerName, method);
  }

  /**
   * Get the current provider name for the active connection.
   */
  getCurrentProvider(): string {
    return this.extractProviderFromUrl(this.getCurrentUrl());
  }

  /**
   * Get provider priority order based on time of day and budget status.
   * Useful for deciding which provider URL to try first.
   */
  getTimeBasedProviderPriority(): string[] {
    return this.healthScorer.getTimeBasedProviderPriority();
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
        this.logger.info(`Connecting to WebSocket: ${currentUrl}${this.currentUrlIndex > 0 ? ' (fallback)' : ''}`);

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

          // S3.3: Track connection metrics
          this.qualityMetrics.connectionStartTime = Date.now();
          this.qualityMetrics.lastMessageTime = Date.now();

          // S3.3: Report successful connection to health scorer
          this.healthScorer.recordSuccess(currentUrl, this.chainId, connectionTime);

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

          // S3.3: Check for rate limit errors and exclude provider
          if (this.isRateLimitError(error)) {
            this.handleRateLimit(currentUrl);
            this.healthScorer.recordRateLimit(currentUrl, this.chainId);
          } else {
            // S3.3: Report connection failure to health scorer
            this.healthScorer.recordFailure(currentUrl, this.chainId, 'connection_error');
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

          // S3.3: Check if close reason indicates rate limiting
          if (code === 1008 || code === 1013 ||
              reasonStr.toLowerCase().includes('rate') ||
              reasonStr.toLowerCase().includes('limit')) {
            this.handleRateLimit(currentUrl);
            this.healthScorer.recordRateLimit(currentUrl, this.chainId);
          } else if (code !== 1000) {
            // S3.3: Report connection drop to health scorer (not manual close)
            this.healthScorer.recordConnectionDrop(currentUrl, this.chainId);
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
    this.stopProactiveHealthCheck(); // S3.3: Clean up health monitoring

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

    this.logger.debug(`Added subscription`, { id, method: subscription.method });
    return id;
  }

  unsubscribe(subscriptionId: number): void {
    const subscription = this.subscriptions.get(subscriptionId);
    if (subscription) {
      this.subscriptions.delete(subscriptionId);
      this.logger.debug(`Removed subscription`, { id: subscriptionId });
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
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onConnectionChange(handler: ConnectionStateHandler): () => void {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }

  /**
   * Event emitter-style API for subscribing to WebSocket events.
   * Supports: 'message', 'error', 'connected', 'disconnected'
   */
  on(event: string, handler: GenericEventHandler): () => void {
    if (event === 'message') {
      this.messageHandlers.add(handler as WebSocketEventHandler);
      return () => this.messageHandlers.delete(handler as WebSocketEventHandler);
    }
    if (event === 'error') {
      this.errorHandlers.add(handler as ErrorEventHandler);
      return () => this.errorHandlers.delete(handler as ErrorEventHandler);
    }
    if (event === 'connected' || event === 'disconnected') {
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
    this.eventHandlers.get(event)!.add(handler);
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
      currentUrlIndex: this.currentUrlIndex,
      totalUrls: this.allUrls.length
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

  private handleMessage(data: Buffer): void {
    const dataString = data.toString();
    const dataSize = data.length;

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
      this.qualityMetrics.errorsEncountered++;
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
          error: error instanceof Error ? error.message : String(error),
          dataPreview: dataString.slice(0, 200)
        });
        this.qualityMetrics.errorsEncountered++;
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
    this.logger.debug('Starting worker pool for JSON parsing', { chainId: this.chainId });

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
          error: error instanceof Error ? error.message : String(error)
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
    // S3.3: Update quality metrics
    this.qualityMetrics.lastMessageTime = Date.now();
    this.qualityMetrics.messagesReceived++;

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

    // S3.3: Check for rate limit errors in JSON-RPC responses
    if (message.error && this.isRateLimitError(message.error)) {
      this.handleRateLimit(this.getCurrentUrl());
      this.qualityMetrics.errorsEncountered++;
      // Still notify handlers so they can handle the error
    }

    // S3.3: Track block numbers from newHeads subscriptions
    if (message.params?.result?.number) {
      const blockNumber = parseInt(message.params.result.number, 16);
      if (!isNaN(blockNumber)) {
        // Check for data gaps before updating last known block
        this.checkForDataGap(blockNumber);
        this.qualityMetrics.lastBlockNumber = blockNumber;
        // Report to health scorer for freshness tracking
        this.healthScorer.recordBlock(this.getCurrentUrl(), this.chainId, blockNumber);
      }
    }

    // Notify all message handlers
    this.messageHandlers.forEach(handler => {
      try {
        handler(message);
      } catch (error) {
        this.logger.error('Error in WebSocket message handler', { error });
        this.qualityMetrics.errorsEncountered++;
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
      if (this.useBudgetAwareSelection) {
        this.recordRequestForBudget(subscription.method);
      }

      this.logger.debug(`Sent subscription`, { id: subscription.id, method: subscription.method });
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
   * @experimental This method is a placeholder for future RPC integration.
   * Currently, gap detection relies on the passive `checkForDataGap()` method
   * which triggers when new block messages arrive.
   *
   * @returns Information about any detected gap, or null if no gap (always null currently)
   */
  async detectDataGaps(): Promise<{
    fromBlock: number;
    toBlock: number;
    missedBlocks: number;
  } | null> {
    const lastKnownBlock = this.qualityMetrics.lastBlockNumber;

    // Can't detect gaps without a known block
    if (lastKnownBlock === 0) {
      return null;
    }

    /**
     * TODO: Implement proactive staleness detection via eth_blockNumber RPC call.
     *
     * Implementation requires:
     * 1. Add pendingRequests Map<number, { resolve, reject, timeout }> for request tracking
     * 2. Add response handler in onMessage to match JSON-RPC responses by id
     * 3. Implement sendRequest(method, params): Promise<result> with timeout
     * 4. Call eth_blockNumber and compare with lastKnownBlock
     *
     * Priority: P3 (Enhancement) - Current passive approach via checkForDataGap()
     * works correctly, this would add proactive detection without waiting for next block.
     *
     * @see https://ethereum.org/en/developers/docs/apis/json-rpc/#eth_blocknumber
     */
    // For now, rely on checkForDataGap() which triggers on incoming block messages
    // This passive approach detects gaps when the next block arrives
    return null;
  }

  /**
   * S3.3: Check for data gaps by comparing received block to last known block.
   * Called internally when processing block notifications.
   *
   * @param newBlockNumber - The new block number received
   */
  private checkForDataGap(newBlockNumber: number): void {
    const lastKnownBlock = this.qualityMetrics.lastBlockNumber;

    if (lastKnownBlock === 0) {
      return; // First block, no gap possible
    }

    const missedBlocks = newBlockNumber - lastKnownBlock - 1;

    if (missedBlocks > 0) {
      this.logger.warn('Data gap detected', {
        chainId: this.chainId,
        lastKnownBlock,
        newBlockNumber,
        missedBlocks
      });

      this.emit('dataGap', {
        chainId: this.chainId,
        fromBlock: lastKnownBlock + 1,
        toBlock: newBlockNumber - 1,
        missedBlocks,
        url: this.getCurrentUrl()
      });
    }
  }

  /**
   * Calculate reconnection delay using exponential backoff with jitter.
   * Formula: min(baseDelay * (multiplier ^ attempt), maxDelay) + random jitter
   *
   * This prevents thundering herd problems where all clients reconnect simultaneously.
   *
   * @param attempt - Current reconnection attempt number (0-based)
   * @returns Delay in milliseconds before next reconnection attempt
   */
  calculateReconnectDelay(attempt: number): number {
    const baseDelay = this.config.reconnectInterval ?? 1000;
    const multiplier = this.config.backoffMultiplier ?? 2.0;
    const maxDelay = this.config.maxReconnectDelay ?? 60000;
    const jitterPercent = this.config.jitterPercent ?? 0.25;

    // Exponential backoff: baseDelay * (multiplier ^ attempt)
    let delay = baseDelay * Math.pow(multiplier, attempt);

    // Cap at maximum delay
    delay = Math.min(delay, maxDelay);

    // Add jitter to prevent thundering herd (0 to jitterPercent of delay)
    const jitter = delay * jitterPercent * Math.random();

    return Math.floor(delay + jitter);
  }

  /**
   * S3.3: Check if an error indicates rate limiting by the RPC provider.
   * Detects common rate limit patterns from various providers.
   *
   * @param error - The error to check
   * @returns true if the error indicates rate limiting
   */
  isRateLimitError(error: any): boolean {
    if (!error) return false;

    const message = (error?.message || '').toLowerCase();
    const code = error?.code;

    // JSON-RPC rate limit error codes
    // -32005: Limit exceeded (Infura, Alchemy)
    // -32016: Rate limit exceeded (some providers)
    // -32000: Server error (sometimes used for rate limits)
    if (code === -32005 || code === -32016) return true;

    // WebSocket close codes
    // 1008: Policy violation (can indicate rate limiting)
    // 1013: Try again later
    if (code === 1008 || code === 1013) return true;

    // HTTP status code equivalents (sometimes included in WebSocket errors)
    if (code === 429) return true;

    // Message pattern matching for various providers
    const rateLimitPatterns = [
      'rate limit',
      'rate-limit',
      'ratelimit',
      'too many requests',
      'request limit exceeded',
      'quota exceeded',
      'throttled',
      'exceeded the limit',
      'limit exceeded',
      'capacity exceeded',
      'try again later',
      'too many concurrent',
      'request per second',
      'requests per second'
    ];

    return rateLimitPatterns.some(pattern => message.includes(pattern));
  }

  /**
   * S3.3: Check if a provider URL is currently excluded due to rate limiting.
   *
   * @param url - The provider URL to check
   * @returns true if the provider is excluded and should not be used
   */
  isProviderExcluded(url: string): boolean {
    const exclusion = this.excludedProviders.get(url);
    if (!exclusion) return false;

    // Check if exclusion has expired
    if (Date.now() > exclusion.until) {
      this.excludedProviders.delete(url);
      this.logger.debug('Provider exclusion expired', { url, chainId: this.chainId });
      return false;
    }

    return true;
  }

  /**
   * S3.3: Handle rate limit detection by excluding the provider temporarily.
   * Uses exponential backoff for exclusion duration (30s, 60s, 120s, 240s, max 5min).
   *
   * @param url - The provider URL that rate limited us
   */
  handleRateLimit(url: string): void {
    const existing = this.excludedProviders.get(url);
    const count = (existing?.count || 0) + 1;

    // Exponential exclusion: 30s * 2^(count-1), max 5 minutes
    const baseExcludeMs = 30000;
    const excludeMs = Math.min(baseExcludeMs * Math.pow(2, count - 1), 300000);

    this.excludedProviders.set(url, {
      until: Date.now() + excludeMs,
      count
    });

    this.logger.warn('Rate limit detected, excluding provider', {
      url,
      chainId: this.chainId,
      excludeMs,
      consecutiveRateLimits: count
    });

    // Emit event for monitoring
    this.emit('rateLimit', { url, chainId: this.chainId, excludeMs, count });
  }

  /**
   * S3.3: Get the count of currently available (non-excluded) providers.
   *
   * @returns Number of providers available for connection
   */
  getAvailableProviderCount(): number {
    return this.allUrls.filter(url => !this.isProviderExcluded(url)).length;
  }

  /**
   * S3.3: Get all excluded providers for diagnostics.
   *
   * @returns Map of excluded URLs with their exclusion info
   */
  getExcludedProviders(): Map<string, { until: number; count: number }> {
    // Clean up expired exclusions first
    for (const [url, exclusion] of this.excludedProviders) {
      if (Date.now() > exclusion.until) {
        this.excludedProviders.delete(url);
      }
    }
    return new Map(this.excludedProviders);
  }

  /**
   * S3.3: Clear all provider exclusions (useful for recovery/reset).
   */
  clearProviderExclusions(): void {
    this.excludedProviders.clear();
    this.logger.info('Cleared all provider exclusions', { chainId: this.chainId });
  }

  /**
   * S3.3: Get connection quality metrics for health monitoring.
   *
   * @returns Current quality metrics snapshot
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
    const now = Date.now();
    const messageGapMs = this.qualityMetrics.lastMessageTime > 0
      ? now - this.qualityMetrics.lastMessageTime
      : 0;
    const uptime = this.qualityMetrics.connectionStartTime > 0
      ? now - this.qualityMetrics.connectionStartTime
      : 0;

    return {
      lastMessageTime: this.qualityMetrics.lastMessageTime,
      messageGapMs,
      lastBlockNumber: this.qualityMetrics.lastBlockNumber,
      reconnectCount: this.qualityMetrics.reconnectCount,
      uptime,
      messagesReceived: this.qualityMetrics.messagesReceived,
      errorsEncountered: this.qualityMetrics.errorsEncountered,
      isStale: this.isConnectionStale()
    };
  }

  /**
   * S3.3: Check if the connection appears stale (no messages for too long).
   *
   * @returns true if connection is stale and should be rotated
   */
  isConnectionStale(): boolean {
    // Don't consider stale if we have no subscriptions
    if (this.subscriptions.size === 0) return false;

    // Don't consider stale if we never received a message
    if (this.qualityMetrics.lastMessageTime === 0) return false;

    const messageGapMs = Date.now() - this.qualityMetrics.lastMessageTime;
    return messageGapMs > this.stalenessThresholdMs;
  }

  /**
   * S3.3: Set the staleness threshold for proactive rotation.
   *
   * @param thresholdMs - Time in ms with no messages before considering stale
   */
  setStalenessThreshold(thresholdMs: number): void {
    this.stalenessThresholdMs = thresholdMs;
  }

  /**
   * S3.3: Start proactive health monitoring.
   * Periodically checks connection quality and triggers rotation if stale.
   *
   * @param intervalMs - Check interval in ms (default 10000)
   */
  startProactiveHealthCheck(intervalMs = 10000): void {
    this.stopProactiveHealthCheck();

    this.healthCheckTimer = setInterval(() => {
      if (!this.isConnected) return;

      // Update message gap metric
      this.qualityMetrics.messageGapMs = this.qualityMetrics.lastMessageTime > 0
        ? Date.now() - this.qualityMetrics.lastMessageTime
        : 0;

      // Check for staleness
      if (this.isConnectionStale()) {
        this.logger.warn('Proactive rotation: connection appears stale', {
          chainId: this.chainId,
          messageGapMs: this.qualityMetrics.messageGapMs,
          lastBlockNumber: this.qualityMetrics.lastBlockNumber,
          url: this.getCurrentUrl()
        });

        // Emit event for monitoring
        this.emit('staleConnection', {
          chainId: this.chainId,
          url: this.getCurrentUrl(),
          messageGapMs: this.qualityMetrics.messageGapMs
        });

        // Trigger reconnection to a different provider
        this.handleRateLimit(this.getCurrentUrl()); // Temporarily exclude current
        this.scheduleReconnection();
      }
    }, intervalMs);
  }

  /**
   * S3.3: Stop proactive health monitoring.
   */
  stopProactiveHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * S3.3: Record a block number (can be called externally for more accurate tracking).
   *
   * @param blockNumber - The block number received
   */
  recordBlockNumber(blockNumber: number): void {
    this.qualityMetrics.lastBlockNumber = blockNumber;
    this.qualityMetrics.lastMessageTime = Date.now();
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

    // S3.3: Track reconnection attempts
    this.qualityMetrics.reconnectCount++;

    if (this.reconnectAttempts >= (this.config.maxReconnectAttempts || 10)) {
      this.logger.error('Max reconnection attempts reached across all URLs');
      // Emit error for handlers
      this.errorHandlers.forEach(handler => {
        try {
          handler(new Error('Max reconnection attempts reached'));
        } catch (e) {
          this.logger.error('Error in error handler', { error: e });
        }
      });
      return;
    }

    // Try fallback URL if available, otherwise increment attempts
    const hasNextUrl = this.switchToNextUrl();
    if (!hasNextUrl) {
      // We've tried all URLs, increment the cycle counter
      this.reconnectAttempts++;
    }

    // Use exponential backoff with jitter for reconnection delay
    const delay = this.calculateReconnectDelay(this.reconnectAttempts);

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
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearConnectionTimeout(): void {
    if (this.connectionTimeoutTimer) {
      clearTimeout(this.connectionTimeoutTimer);
      this.connectionTimeoutTimer = null;
    }
  }

  private clearReconnectionTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}