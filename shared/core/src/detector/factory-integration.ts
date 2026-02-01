/**
 * Factory Integration Service
 *
 * Manages factory subscription for dynamic pair discovery:
 * - Factory event subscription via WebSocket
 * - New pair registration
 * - Event subscription for discovered pairs
 *
 * Task 2.1.2: Factory Subscription Service for dynamic pair discovery
 * Enables 40-50x RPC subscription reduction.
 *
 * @see R5 - Base Detector Completion
 * @see MIGRATION_PLAN.md
 */

import type { ServiceLogger } from '../logging';
import type { WebSocketManager } from '../websocket-manager';
import type {
  FactorySubscriptionService,
  PairCreatedEvent,
} from '../factory-subscription';
import { createFactorySubscriptionService } from '../factory-subscription';
import {
  getAllFactoryAddresses,
  validateFactoryRegistry,
  dexFeeToPercentage,
  EVENT_CONFIG,
  EVENT_SIGNATURES,
} from '../../../../shared/config/src';
import type { Dex, Pair } from '../../../../shared/types/src';

/**
 * Configuration for factory integration
 */
export interface FactoryIntegrationConfig {
  /** Chain identifier */
  chain: string;
  /** Whether factory subscription is enabled */
  enabled?: boolean;
}

/**
 * Callback handlers for factory integration events
 */
export interface FactoryIntegrationHandlers {
  /** Called when a new pair is discovered from factory */
  onPairRegistered?: (pair: Pair, event: PairCreatedEvent) => void;
  /** Called when pair subscription is set up */
  onPairSubscribed?: (pair: Pair) => void;
}

/**
 * Dependencies for factory integration
 */
export interface FactoryIntegrationDeps {
  logger: ServiceLogger;
  wsManager: WebSocketManager | null;
  /** DEXes by name for O(1) fee lookup */
  dexesByName: Map<string, Dex>;
  /** Existing pairs by address for duplicate detection */
  pairsByAddress: Map<string, Pair>;
  /** Callback to add pair to all indices */
  addPairToIndices: (pairKey: string, pair: Pair) => void;
  /** Callback to check if detector is running */
  isRunning: () => boolean;
  /** Callback to check if detector is stopping */
  isStopping: () => boolean;
}

/**
 * Result of factory integration initialization
 */
export interface FactoryIntegrationResult {
  /** Factory subscription service instance */
  service: FactorySubscriptionService | null;
  /** Set of factory addresses for O(1) event routing */
  factoryAddresses: Set<string>;
}

/**
 * Factory Integration Service
 *
 * Manages dynamic pair discovery via factory events.
 */
export class FactoryIntegrationService {
  private readonly config: Required<FactoryIntegrationConfig>;
  private readonly deps: FactoryIntegrationDeps;
  private readonly handlers: FactoryIntegrationHandlers;

  private factorySubscriptionService: FactorySubscriptionService | null = null;
  private factoryAddresses: Set<string> = new Set();

  constructor(
    config: FactoryIntegrationConfig,
    deps: FactoryIntegrationDeps,
    handlers?: FactoryIntegrationHandlers
  ) {
    this.config = {
      chain: config.chain,
      enabled: config.enabled ?? true,
    };
    this.deps = deps;
    this.handlers = handlers ?? {};
  }

  /**
   * Initialize factory subscription service for dynamic pair discovery.
   * Subscribes to PairCreated events from factory contracts.
   *
   * @returns Factory integration result with service and addresses
   */
  async initialize(): Promise<FactoryIntegrationResult> {
    try {
      // Validate factory registry at startup to catch configuration errors early
      const validationErrors = validateFactoryRegistry();
      if (validationErrors.length > 0) {
        this.deps.logger.warn('Factory registry validation warnings', {
          chain: this.config.chain,
          errors: validationErrors,
          count: validationErrors.length,
        });
        // Continue despite warnings - these may be expected for certain DEXes
      }

      // Build factory address set for O(1) event routing lookup
      const factoryAddrs = getAllFactoryAddresses(this.config.chain);
      this.factoryAddresses = new Set(factoryAddrs.map((addr) => addr.toLowerCase()));

      if (this.factoryAddresses.size === 0) {
        this.deps.logger.info('No factories configured for chain, skipping factory subscription', {
          chain: this.config.chain,
        });
        return { service: null, factoryAddresses: this.factoryAddresses };
      }

      // Create factory subscription service with WebSocket adapter
      this.factorySubscriptionService = createFactorySubscriptionService(
        {
          chain: this.config.chain,
          enabled: this.config.enabled,
        },
        {
          logger: this.deps.logger,
          wsManager: this.createWebSocketAdapter(),
        }
      );

      // Register callback for new pair discovery
      this.factorySubscriptionService.onPairCreated((event: PairCreatedEvent) => {
        this.registerPairFromFactory(event);
      });

      // Subscribe to factory events
      await this.factorySubscriptionService.subscribeToFactories();

      this.deps.logger.info('Factory subscription service initialized', {
        chain: this.config.chain,
        factories: this.factoryAddresses.size,
        stats: this.factorySubscriptionService.getStats(),
      });

      return {
        service: this.factorySubscriptionService,
        factoryAddresses: this.factoryAddresses,
      };
    } catch (error) {
      this.deps.logger.error('Failed to initialize factory subscription service', { error });
      // Non-fatal: existing pairs will still work, just no dynamic discovery
      this.deps.logger.warn('Dynamic pair discovery disabled');
      return { service: null, factoryAddresses: this.factoryAddresses };
    }
  }

  /**
   * Create WebSocket adapter for factory subscription service.
   * Uses isStopping() guard to prevent operations during shutdown.
   *
   * Note: We capture wsManager reference at creation time. The isStopping()
   * check guards against operations during shutdown when the wsManager may
   * be in an inconsistent state.
   */
  private createWebSocketAdapter() {
    if (!this.deps.wsManager) {
      return undefined;
    }

    const wsManager = this.deps.wsManager;
    const logger = this.deps.logger;
    // Capture isStopping callback for shutdown guard
    const isStopping = () => this.deps.isStopping();

    return {
      subscribe: (params: any) => {
        // Guard against subscribe during shutdown
        if (isStopping()) {
          logger.debug('Skipping subscribe during shutdown');
          return 0; // Return dummy subscription ID
        }
        return wsManager.subscribe(params);
      },
      unsubscribe: (subscriptionId: string) => {
        // Guard against unsubscribe during shutdown (wsManager may be disconnecting)
        if (isStopping()) {
          logger.debug('Skipping unsubscribe during shutdown');
          return;
        }
        // Convert string ID to number for WebSocketManager
        const numId = parseInt(subscriptionId, 10);
        if (!isNaN(numId)) {
          wsManager.unsubscribe(numId);
        }
      },
      isConnected: () => {
        // Return false during shutdown
        if (isStopping()) {
          return false;
        }
        return wsManager.isWebSocketConnected();
      },
    };
  }

  /**
   * Register a new pair from a PairCreated factory event.
   * Called when a factory emits a PairCreated event.
   *
   * Includes shutdown guard to prevent race condition where late-arriving
   * factory events modify shared state during cleanup.
   */
  private registerPairFromFactory(event: PairCreatedEvent): void {
    // Guard against registration during shutdown
    if (this.deps.isStopping() || !this.deps.isRunning()) {
      this.deps.logger.debug('Ignoring factory event during shutdown', {
        pair: event.pairAddress,
        dex: event.dexName,
      });
      return;
    }

    try {
      const pairAddressLower = event.pairAddress.toLowerCase();

      // Skip if pair already registered
      if (this.deps.pairsByAddress.has(pairAddressLower)) {
        this.deps.logger.debug('Pair already registered, skipping', {
          pair: event.pairAddress,
          dex: event.dexName,
        });
        return;
      }

      // Look up DEX configuration to get fee (O(1) lookup via dexesByName map)
      const dexConfig = this.deps.dexesByName.get(event.dexName.toLowerCase());
      const fee = dexConfig ? dexFeeToPercentage(dexConfig.fee ?? 30) : 0.003;

      // Create pair object
      const pair: Pair = {
        name: `${event.token0.slice(0, 6)}.../${event.token1.slice(0, 6)}...`,
        address: event.pairAddress,
        token0: event.token0,
        token1: event.token1,
        dex: event.dexName,
        fee,
      };

      // Register in all indices via callback
      const pairKey = `${event.dexName}_${pair.name}`;
      this.deps.addPairToIndices(pairKey, pair);

      // Subscribe to Sync/Swap events for new pair
      this.subscribeToNewPair(pair);

      this.deps.logger.info('Registered new pair from factory', {
        pair: event.pairAddress,
        dex: event.dexName,
        token0: event.token0.slice(0, 10) + '...',
        token1: event.token1.slice(0, 10) + '...',
        blockNumber: event.blockNumber,
      });

      // Notify handler
      this.handlers.onPairRegistered?.(pair, event);
    } catch (error) {
      this.deps.logger.error('Failed to register pair from factory', {
        error,
        pairAddress: event.pairAddress,
        dex: event.dexName,
      });
    }
  }

  /**
   * Subscribe to Sync/Swap events for a newly discovered pair.
   */
  private subscribeToNewPair(pair: Pair): void {
    const wsManager = this.deps.wsManager;
    if (!wsManager) {
      this.deps.logger.warn('WebSocket manager not available for new pair subscription');
      return;
    }

    const pairAddress = pair.address.toLowerCase();

    // Subscribe to Sync events (reserve changes)
    if (EVENT_CONFIG.syncEvents.enabled) {
      wsManager.subscribe({
        method: 'eth_subscribe',
        params: [
          'logs',
          {
            topics: [EVENT_SIGNATURES.SYNC],
            address: [pairAddress],
          },
        ],
      });
    }

    // Subscribe to Swap events (trading activity)
    if (EVENT_CONFIG.swapEvents.enabled) {
      wsManager.subscribe({
        method: 'eth_subscribe',
        params: [
          'logs',
          {
            topics: [EVENT_SIGNATURES.SWAP_V2],
            address: [pairAddress],
          },
        ],
      });
    }

    this.deps.logger.debug('Subscribed to events for new pair', {
      pair: pair.address,
      dex: pair.dex,
    });

    // Notify handler
    this.handlers.onPairSubscribed?.(pair);
  }

  /**
   * Handle a factory event from WebSocket message routing.
   * Called when an event from a factory address is detected.
   */
  handleFactoryEvent(result: any): void {
    if (this.factorySubscriptionService) {
      this.factorySubscriptionService.handleFactoryEvent(result);
    }
  }

  /**
   * Check if an address is a factory address.
   */
  isFactoryAddress(address: string): boolean {
    return this.factoryAddresses.has(address.toLowerCase());
  }

  /**
   * Get factory subscription service (for stats/monitoring).
   */
  getService(): FactorySubscriptionService | null {
    return this.factorySubscriptionService;
  }

  /**
   * Get factory addresses set.
   */
  getFactoryAddresses(): Set<string> {
    return this.factoryAddresses;
  }

  /**
   * Get stats from factory subscription service.
   */
  getStats(): any {
    return this.factorySubscriptionService?.getStats() || null;
  }

  /**
   * Stop factory subscription service.
   */
  stop(): void {
    if (this.factorySubscriptionService) {
      try {
        this.factorySubscriptionService.stop();
      } catch (error) {
        this.deps.logger.warn('Error stopping factory subscription service', { error });
      }
      this.factorySubscriptionService = null;
    }
    this.factoryAddresses.clear();
  }
}

/**
 * Create a factory integration service instance.
 *
 * @param config - Factory integration configuration
 * @param deps - Dependencies for factory integration
 * @param handlers - Event handlers
 * @returns FactoryIntegrationService instance
 */
export function createFactoryIntegrationService(
  config: FactoryIntegrationConfig,
  deps: FactoryIntegrationDeps,
  handlers?: FactoryIntegrationHandlers
): FactoryIntegrationService {
  return new FactoryIntegrationService(config, deps, handlers);
}
