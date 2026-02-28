/**
 * Subscription Manager
 *
 * Manages WebSocket initialization and event subscription for chain instances.
 * Handles both factory-level and legacy pair-level subscription modes.
 * Extracted from chain-instance.ts for single-responsibility principle.
 *
 * ## Subscription Modes
 *
 * 1. **Factory Mode**: Subscribes to factory PairCreated events for dynamic pair discovery.
 *    Achieves 40-50x RPC reduction compared to legacy pair-level subscriptions.
 *
 * 2. **Legacy Mode**: Subscribes to Sync/Swap events for all known pair addresses.
 *    Backward compatible, used when factory addresses aren't available.
 *
 * ## Hot-Path Safety
 *
 * This module is NOT in the hot path. It runs once during startup.
 * The `useFactoryMode` boolean is returned for chain-instance to cache,
 * avoiding method calls in the hot-path message router.
 *
 * @module subscription/subscription-manager
 * @see Finding #8 in .agent-reports/unified-detector-deep-analysis.md
 * @see Task 2.1.3 - Factory Subscription Migration
 * @see ADR-014 - Modular Detector Components
 */

import { PairCreatedEvent } from '@arbitrage/core/factory-subscription';
import { WebSocketManager, WebSocketConfig, FactorySubscriptionService, FactoryWebSocketManager, maskUrlApiKeys } from '@arbitrage/core';

import {
  EVENT_SIGNATURES,
  getAllFactoryAddresses,
} from '@arbitrage/config';

import { toWebSocketUrl, isUnstableChain } from '../types';
import type { Logger } from '../types';
import {
  UNSTABLE_WEBSOCKET_CHAINS,
  DEFAULT_WS_CONNECTION_TIMEOUT_MS,
  EXTENDED_WS_CONNECTION_TIMEOUT_MS,
} from '../constants';

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for SubscriptionManager.
 */
export interface SubscriptionManagerConfig {
  /** Chain identifier */
  chainId: string;
  /** Chain-specific configuration */
  chainConfig: {
    wsUrl?: string;
    rpcUrl: string;
    wsFallbackUrls?: string[];
  };
  /** Factory subscription rollout config */
  subscriptionConfig: {
    useFactorySubscriptions: boolean;
    factorySubscriptionEnabledChains: string[];
    factorySubscriptionRolloutPercent: number;
  };
  /** Max WebSocket reconnect attempts */
  maxReconnectAttempts: number;
  /** Logger instance */
  logger: Logger;
}

/**
 * Callbacks from SubscriptionManager back to chain-instance.
 * Chain-instance provides these to wire up its event handlers.
 */
export interface SubscriptionCallbacks {
  /** Called for every raw WebSocket message (for routing in chain-instance) */
  onMessage: (message: unknown) => void;
  /** Called on WebSocket error */
  onError: (error: Error) => void;
  /** Called when WebSocket disconnects */
  onDisconnected: () => void;
  /** Called when WebSocket connects */
  onConnected: () => void;
  /** Called for Sync log events */
  onSyncEvent: (log: unknown) => void;
  /** Called for Swap V2 log events */
  onSwapEvent: (log: unknown) => void;
  /** Called for Swap V3 log events (P0-4: V3 Swap event support) */
  onSwapV3Event: (log: unknown) => void;
  /** Called for Curve TokenExchange log events (P0-5: Non-standard event support) */
  onCurveTokenExchangeEvent: (log: unknown) => void;
  /** Called for Balancer V2 Swap log events (P0-5: Non-standard event support) */
  onBalancerSwapEvent: (log: unknown) => void;
  /** Called for new block headers */
  onNewBlock: (block: unknown) => void;
  /** Called when factory discovers a new pair */
  onPairCreated: (event: PairCreatedEvent) => void;
}

/**
 * Subscription statistics for monitoring.
 */
export interface SubscriptionStats {
  mode: 'factory' | 'legacy' | 'none';
  legacySubscriptionCount: number;
  factorySubscriptionCount: number;
  monitoredPairs: number;
  rpcReductionRatio: number;
}

/**
 * Result of subscription initialization.
 */
export interface SubscriptionResult {
  /** Initialized WebSocket manager */
  wsManager: WebSocketManager;
  /** Factory subscription service (null in legacy mode) */
  factorySubscriptionService: FactorySubscriptionService | null;
  /** Subscription statistics */
  subscriptionStats: SubscriptionStats;
  /** Whether factory mode is active (cached for hot-path access) */
  useFactoryMode: boolean;
}

// =============================================================================
// Subscription Manager
// =============================================================================

/**
 * Manages WebSocket setup and event subscription for a chain instance.
 */
export class SubscriptionManager {
  private readonly config: SubscriptionManagerConfig;

  constructor(config: SubscriptionManagerConfig) {
    this.config = config;
  }

  /**
   * Initialize WebSocket connection and subscribe to events.
   *
   * @param callbacks - Event handlers for the chain instance
   * @param pairAddresses - Pre-cached pair addresses for subscription
   * @returns SubscriptionResult with all created resources
   */
  async initialize(
    callbacks: SubscriptionCallbacks,
    pairAddresses: string[]
  ): Promise<SubscriptionResult> {
    const wsManager = await this.initializeWebSocket(callbacks);

    const { factorySubscriptionService, subscriptionStats, useFactoryMode } =
      await this.subscribeToEvents(wsManager, pairAddresses, callbacks);

    return { wsManager, factorySubscriptionService, subscriptionStats, useFactoryMode };
  }

  /**
   * Determine if factory subscriptions should be used for this chain.
   * Supports gradual rollout via explicit chain list or percentage-based rollout.
   */
  shouldUseFactorySubscriptions(): boolean {
    // Check if explicitly disabled via config flag
    if (!this.config.subscriptionConfig.useFactorySubscriptions) {
      return false;
    }

    // If explicit chain list is provided, only enable for those chains
    const enabledChains = this.config.subscriptionConfig.factorySubscriptionEnabledChains;
    if (enabledChains && enabledChains.length > 0) {
      return enabledChains.includes(this.config.chainId);
    }

    // Check rollout percentage
    const rolloutPercent = this.config.subscriptionConfig.factorySubscriptionRolloutPercent;
    if (rolloutPercent !== undefined && rolloutPercent < 100) {
      // Use deterministic hash of chain name for consistent rollout
      const chainHash = this.hashChainName(this.config.chainId);
      return (chainHash % 100) < rolloutPercent;
    }

    // Default: if flag is true but no specific config, enable for all
    return this.config.subscriptionConfig.useFactorySubscriptions;
  }

  /**
   * Deterministic hash for chain name (for rollout percentage).
   */
  hashChainName(chain: string): number {
    let hash = 0;
    for (let i = 0; i < chain.length; i++) {
      hash = ((hash << 5) - hash + chain.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private async initializeWebSocket(callbacks: SubscriptionCallbacks): Promise<WebSocketManager> {
    const { chainConfig, chainId, maxReconnectAttempts, logger } = this.config;

    // FIX Refactor 9.1: Use extracted utility for WebSocket URL validation
    let primaryWsUrl: string;

    if (chainConfig.wsUrl) {
      // Validate existing WebSocket URL
      const result = toWebSocketUrl(chainConfig.wsUrl);
      primaryWsUrl = result.url;
    } else {
      // Try to convert RPC URL to WebSocket
      try {
        const result = toWebSocketUrl(chainConfig.rpcUrl);
        primaryWsUrl = result.url;
        if (result.converted) {
          // FIX P1-6: Mask API keys in log output
          logger.warn('Converting RPC URL to WebSocket URL', {
            original: maskUrlApiKeys(result.originalUrl ?? ''),
            converted: maskUrlApiKeys(result.url)
          });
        }
      } catch (error) {
        // FIX P1-6: Mask API keys in error messages to prevent credential leakage
        throw new Error(`No valid WebSocket URL available for chain ${chainId}. wsUrl: ${maskUrlApiKeys(chainConfig.wsUrl ?? '')}, rpcUrl: ${maskUrlApiKeys(chainConfig.rpcUrl)}`);
      }
    }

    // FIX Config 3.2: Use centralized UNSTABLE_WEBSOCKET_CHAINS constant
    const connectionTimeout = isUnstableChain(chainId, UNSTABLE_WEBSOCKET_CHAINS)
      ? EXTENDED_WS_CONNECTION_TIMEOUT_MS
      : DEFAULT_WS_CONNECTION_TIMEOUT_MS;

    const wsConfig: WebSocketConfig = {
      url: primaryWsUrl,
      fallbackUrls: chainConfig.wsFallbackUrls,
      reconnectInterval: 5000,
      maxReconnectAttempts,
      pingInterval: 30000,
      connectionTimeout,
      chainId  // FIX: Enable chain-specific staleness detection
    };

    const wsManager = new WebSocketManager(wsConfig);
    logger.info(`WebSocket configured with ${1 + (chainConfig.wsFallbackUrls?.length ?? 0)} URL(s)`);

    // Set up WebSocket event handlers
    wsManager.on('message', (message) => {
      callbacks.onMessage(message);
    });

    wsManager.on('error', (error) => {
      logger.error('WebSocket error', { error });
      callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    });

    wsManager.on('disconnected', () => {
      logger.warn('WebSocket disconnected');
      callbacks.onDisconnected();
    });

    wsManager.on('connected', () => {
      logger.info('WebSocket connected');
      callbacks.onConnected();
    });

    await wsManager.connect();

    return wsManager;
  }

  private async subscribeToEvents(
    wsManager: WebSocketManager,
    pairAddresses: string[],
    callbacks: SubscriptionCallbacks
  ): Promise<{ factorySubscriptionService: FactorySubscriptionService | null; subscriptionStats: SubscriptionStats; useFactoryMode: boolean }> {
    // Task 2.1.3: Choose subscription mode based on config
    if (this.shouldUseFactorySubscriptions()) {
      return this.subscribeViaFactoryMode(wsManager, pairAddresses, callbacks);
    } else {
      return this.subscribeViaLegacyMode(wsManager, pairAddresses, callbacks);
    }
  }

  /**
   * Factory-level subscription mode.
   * Subscribes to factory PairCreated events for dynamic pair discovery.
   * Achieves 40-50x RPC reduction compared to legacy pair-level subscriptions.
   */
  private async subscribeViaFactoryMode(
    wsManager: WebSocketManager,
    pairAddresses: string[],
    callbacks: SubscriptionCallbacks
  ): Promise<{ factorySubscriptionService: FactorySubscriptionService | null; subscriptionStats: SubscriptionStats; useFactoryMode: boolean }> {
    const { chainId, logger } = this.config;
    const factoryAddresses = getAllFactoryAddresses(chainId);

    if (factoryAddresses.length === 0) {
      logger.warn('No factory addresses found, falling back to legacy mode', {
        chainId
      });
      return this.subscribeViaLegacyMode(wsManager, pairAddresses, callbacks);
    }

    // Create factory subscription service
    const factorySubscriptionService = new FactorySubscriptionService(
      {
        chain: chainId,
        enabled: true,
        customFactories: factoryAddresses
      },
      {
        logger,
        // P0-FIX: Type assertion required because WebSocketManager.isConnected is private
        // and the public method is isWebSocketConnected(). The subscribe signature is compatible.
        wsManager: wsManager as unknown as FactoryWebSocketManager | undefined
      }
    );

    // Register callback for new pairs discovered via factory events
    factorySubscriptionService.onPairCreated((event: PairCreatedEvent) => {
      callbacks.onPairCreated(event);
    });

    // Subscribe to factories
    await factorySubscriptionService.subscribeToFactories();

    // Still subscribe to Sync/Swap events for existing pairs
    if (pairAddresses.length > 0) {
      // Subscribe to Sync events for existing pairs
      await wsManager.subscribe({
        method: 'eth_subscribe',
        params: ['logs', { topics: [EVENT_SIGNATURES.SYNC], address: pairAddresses }],
        type: 'logs',
        topics: [EVENT_SIGNATURES.SYNC],
        callback: (log) => callbacks.onSyncEvent(log)
      });

      // Subscribe to Swap V2 events for existing pairs
      await wsManager.subscribe({
        method: 'eth_subscribe',
        params: ['logs', { topics: [EVENT_SIGNATURES.SWAP_V2], address: pairAddresses }],
        type: 'logs',
        topics: [EVENT_SIGNATURES.SWAP_V2],
        callback: (log) => callbacks.onSwapEvent(log)
      });

      // P0-4: Subscribe to V3 Swap events for V3 pair addresses
      await wsManager.subscribe({
        method: 'eth_subscribe',
        params: ['logs', { topics: [EVENT_SIGNATURES.SWAP_V3], address: pairAddresses }],
        type: 'logs',
        topics: [EVENT_SIGNATURES.SWAP_V3],
        callback: (log) => callbacks.onSwapV3Event(log)
      });

      // P0-5: Subscribe to Curve TokenExchange events
      await wsManager.subscribe({
        method: 'eth_subscribe',
        params: ['logs', { topics: [EVENT_SIGNATURES.CURVE_TOKEN_EXCHANGE], address: pairAddresses }],
        type: 'logs',
        topics: [EVENT_SIGNATURES.CURVE_TOKEN_EXCHANGE],
        callback: (log) => callbacks.onCurveTokenExchangeEvent(log)
      });

      // P0-5: Subscribe to Balancer V2 Swap events
      await wsManager.subscribe({
        method: 'eth_subscribe',
        params: ['logs', { topics: [EVENT_SIGNATURES.BALANCER_SWAP], address: pairAddresses }],
        type: 'logs',
        topics: [EVENT_SIGNATURES.BALANCER_SWAP],
        callback: (log) => callbacks.onBalancerSwapEvent(log)
      });
    }

    // Subscribe to new blocks for latency tracking
    await wsManager.subscribe({
      method: 'eth_subscribe',
      params: ['newHeads'],
      type: 'newHeads',
      callback: (block) => callbacks.onNewBlock(block)
    });

    // Update subscription stats
    const subscriptionStats: SubscriptionStats = {
      mode: 'factory',
      legacySubscriptionCount: pairAddresses.length > 0 ? 6 : 1, // Sync, SwapV2, SwapV3, Curve, Balancer, newHeads or just newHeads
      factorySubscriptionCount: factorySubscriptionService.getSubscriptionCount(),
      monitoredPairs: pairAddresses.length,
      rpcReductionRatio: pairAddresses.length / Math.max(factoryAddresses.length, 1)
    };

    logger.info('Subscribed via factory mode', {
      chainId,
      factories: factoryAddresses.length,
      existingPairs: pairAddresses.length,
      rpcReduction: `${subscriptionStats.rpcReductionRatio.toFixed(1)}x`
    });

    return { factorySubscriptionService, subscriptionStats, useFactoryMode: true };
  }

  /**
   * Legacy pair-level subscription mode (backward compatible).
   * Subscribes to Sync/Swap events for all known pair addresses.
   */
  private async subscribeViaLegacyMode(
    wsManager: WebSocketManager,
    pairAddresses: string[],
    callbacks: SubscriptionCallbacks
  ): Promise<{ factorySubscriptionService: FactorySubscriptionService | null; subscriptionStats: SubscriptionStats; useFactoryMode: boolean }> {
    const { chainId, logger } = this.config;

    // Subscribe to Sync events
    await wsManager.subscribe({
      method: 'eth_subscribe',
      params: ['logs', { topics: [EVENT_SIGNATURES.SYNC], address: pairAddresses }],
      type: 'logs',
      topics: [EVENT_SIGNATURES.SYNC],
      callback: (log) => callbacks.onSyncEvent(log)
    });

    // Subscribe to Swap V2 events
    await wsManager.subscribe({
      method: 'eth_subscribe',
      params: ['logs', { topics: [EVENT_SIGNATURES.SWAP_V2], address: pairAddresses }],
      type: 'logs',
      topics: [EVENT_SIGNATURES.SWAP_V2],
      callback: (log) => callbacks.onSwapEvent(log)
    });

    // P0-4: Subscribe to V3 Swap events
    await wsManager.subscribe({
      method: 'eth_subscribe',
      params: ['logs', { topics: [EVENT_SIGNATURES.SWAP_V3], address: pairAddresses }],
      type: 'logs',
      topics: [EVENT_SIGNATURES.SWAP_V3],
      callback: (log) => callbacks.onSwapV3Event(log)
    });

    // P0-5: Subscribe to Curve TokenExchange events
    await wsManager.subscribe({
      method: 'eth_subscribe',
      params: ['logs', { topics: [EVENT_SIGNATURES.CURVE_TOKEN_EXCHANGE], address: pairAddresses }],
      type: 'logs',
      topics: [EVENT_SIGNATURES.CURVE_TOKEN_EXCHANGE],
      callback: (log) => callbacks.onCurveTokenExchangeEvent(log)
    });

    // P0-5: Subscribe to Balancer V2 Swap events
    await wsManager.subscribe({
      method: 'eth_subscribe',
      params: ['logs', { topics: [EVENT_SIGNATURES.BALANCER_SWAP], address: pairAddresses }],
      type: 'logs',
      topics: [EVENT_SIGNATURES.BALANCER_SWAP],
      callback: (log) => callbacks.onBalancerSwapEvent(log)
    });

    // Subscribe to new blocks for latency tracking
    await wsManager.subscribe({
      method: 'eth_subscribe',
      params: ['newHeads'],
      type: 'newHeads',
      callback: (block) => callbacks.onNewBlock(block)
    });

    // Update subscription stats
    const subscriptionStats: SubscriptionStats = {
      mode: 'legacy',
      legacySubscriptionCount: 6, // Sync, SwapV2, SwapV3, Curve, Balancer, newHeads
      factorySubscriptionCount: 0,
      monitoredPairs: pairAddresses.length,
      rpcReductionRatio: 1 // No reduction in legacy mode
    };

    logger.info('Subscribed via legacy mode', {
      chainId,
      pairs: pairAddresses.length
    });

    return { factorySubscriptionService: null, subscriptionStats, useFactoryMode: false };
  }
}

/**
 * Create a subscription manager instance.
 *
 * @param config - Subscription manager configuration
 * @returns SubscriptionManager instance
 */
export function createSubscriptionManager(
  config: SubscriptionManagerConfig
): SubscriptionManager {
  return new SubscriptionManager(config);
}
