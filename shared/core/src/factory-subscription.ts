/**
 * Factory Subscription Service
 *
 * Task 2.1.2: Implement Factory Subscription
 * Enables factory-level event subscriptions for 40-50x RPC reduction.
 *
 * Instead of subscribing to each individual pair address, this service
 * subscribes to factory contracts to receive PairCreated events and
 * dynamically discover new pairs.
 *
 * @see implementation_plan_v2.md Phase 2.1.2
 * @see ARCHITECTURE_V2.md Section 3.2 (Factory Subscriptions)
 *
 * ARCHITECTURAL NOTES:
 * - Maverick (Base): Classified as uniswap_v3 but uses unique "boosted positions"
 * - GMX (Avalanche): Classified as balancer_v2 but uses Vault/GLP model
 * - Platypus (Avalanche): Classified as curve but uses "coverage ratio" model
 * These use standard event patterns but may need custom handling for pair initialization.
 *
 * R10 REFACTORING (2026-02-01):
 * Event parsers have been extracted to factory-subscription/parsers/ for better modularity.
 * All exports remain backward compatible through re-exports below.
 */

import {
  getFactoriesWithEventSupport,
  FactoryType,
  FactoryConfig,
} from '@arbitrage/config';
import { ServiceLogger } from './logging';
import { AsyncMutex } from './async/async-mutex';

// =============================================================================
// Re-exports from extracted parser modules (backward compatibility)
// =============================================================================

// Re-export types
export { PairCreatedEvent, type RawEventLog } from './factory-subscription/parsers/types';

// Re-export all parsers for backward compatibility
export {
  parseV2PairCreatedEvent,
  parseV3PoolCreatedEvent,
  parseSolidlyPairCreatedEvent,
  parseAlgebraPoolCreatedEvent,
  parseTraderJoePairCreatedEvent,
  parseCurvePlainPoolDeployedEvent,
  parseCurveMetaPoolDeployedEvent,
  parseCurvePoolCreatedEvent,
  parseBalancerPoolRegisteredEvent,
  parseBalancerTokensRegisteredEvent,
  CURVE_PLAIN_POOL_SIGNATURE,
  CURVE_META_POOL_SIGNATURE,
  BALANCER_TOKENS_REGISTERED_SIGNATURE,
} from './factory-subscription/parsers';

// Import parsers for internal use
import {
  PairCreatedEvent,
  type RawEventLog,
  parseV2PairCreatedEvent,
  parseV3PoolCreatedEvent,
  parseSolidlyPairCreatedEvent,
  parseAlgebraPoolCreatedEvent,
  parseTraderJoePairCreatedEvent,
  parseCurvePoolCreatedEvent,
  parseBalancerPoolRegisteredEvent,
  parseBalancerTokensRegisteredEvent,
  BALANCER_TOKENS_REGISTERED_SIGNATURE,
} from './factory-subscription/parsers';

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for factory subscription service.
 */
export interface FactorySubscriptionConfig {
  /** Chain identifier (e.g., 'arbitrum', 'bsc') */
  chain: string;
  /** Whether factory subscriptions are enabled */
  enabled: boolean;
  /** Optional: Custom factory addresses to monitor (overrides registry) */
  customFactories?: string[];
}

/**
 * Statistics for factory subscription service.
 */
export interface FactorySubscriptionStats {
  /** Chain being monitored */
  chain: string;
  /** Number of factories subscribed to */
  factoriesSubscribed: number;
  /** Total pairs created since service started */
  pairsCreated: number;
  /** Events by factory type */
  eventsByType: Partial<Record<FactoryType, number>>;
  /** Whether service is currently subscribed */
  isSubscribed: boolean;
  /** Service start time */
  startedAt: number | null;
}

/**
 * Logger interface for DI.
 * P0-FIX: Now uses the consolidated ServiceLogger type from logging module.
 * @deprecated Use ServiceLogger from './logging' directly instead.
 */
export type FactorySubscriptionLogger = ServiceLogger;

/**
 * WebSocket manager interface for DI.
 * P0-FIX: Extended to match WebSocketManager subscribe signature.
 * The subscribe method accepts additional optional properties for
 * event type categorization and callback registration.
 *
 * NOTE: This interface is intentionally flexible to support both
 * the actual WebSocketManager class and mock implementations in tests.
 */
export interface FactoryWebSocketManager {
  subscribe: (params: {
    method: string;
    params: unknown[];
    type?: string;      // Optional: subscription type for categorization
    topics?: string[];  // Optional: event topics for filtering
    callback?: (data: unknown) => void;  // Optional: per-subscription callback
  }) => number | void;
  unsubscribe?: (subscriptionId: string) => void;  // Only string for compatibility
  isConnected(): boolean;  // Method signature (not private access)
}

/**
 * Dependencies for factory subscription service.
 */
export interface FactorySubscriptionDeps {
  logger?: ServiceLogger;
  wsManager?: FactoryWebSocketManager;
}

/**
 * Callback type for pair created events.
 */
export type PairCreatedCallback = (event: PairCreatedEvent) => void;

// =============================================================================
// Event Signatures
// =============================================================================

/**
 * Pre-computed event signatures for factory events.
 * These are keccak256 hashes of the event signatures.
 *
 * PERFORMANCE: Pre-computed at build time instead of runtime ethers.id() calls.
 * Saves ~10ms per import and avoids crypto computation on module load.
 */
export const FactoryEventSignatures: Record<FactoryType, string> = {
  // PairCreated(address indexed token0, address indexed token1, address pair, uint)
  uniswap_v2: '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9',

  // PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)
  uniswap_v3: '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118',

  // PairCreated(address indexed token0, address indexed token1, bool stable, address pair, uint)
  solidly: '0xc4805696c66d7cf352fc1d6bb633ad5ee82f6cb577c453024b6e0eb8306c6fc9',

  // Curve uses PlainPoolDeployed (primary) and MetaPoolDeployed (secondary)
  // PlainPoolDeployed(address[4] coins, uint256 A, uint256 fee, address deployer, address pool)
  curve: '0xb8f6972d6e56d21c47621efd7f02fe68f07a17c999c42245b3abd300f34d61eb',

  // PoolRegistered(bytes32 indexed poolId, address indexed poolAddress, uint8 specialization)
  balancer_v2: '0x3c13bc30b8e878c53fd2a36b679409c073afd75950be43d8858768e956fbc20e',

  // Pool(address indexed token0, address indexed token1, address pool)
  algebra: '0x91ccaa7a278130b65168c3a0c8d3bcae84cf5e43704342bd3ec0b59e59c036db',

  // LBPairCreated(address indexed tokenX, address indexed tokenY, uint256 indexed binStep, address LBPair, uint256 pid)
  trader_joe: '0x2c8d104b27c6b7f4492017a6f5cf3803043688934ebcaa6a03540beeaf976aff',
};

/**
 * Additional event signatures for DEXes that emit multiple event types.
 * Used when a single factory type can emit different pool creation events.
 */
export const AdditionalEventSignatures = {
  // MetaPoolDeployed(address coin, address base_pool, uint256 A, uint256 fee, address deployer, address pool)
  curve_metapool: '0x01f31cd2abdec67d966a3f6d992026644a5765d127b8b35ae4dd240b2baa0b9f',

  // TokensRegistered(bytes32 indexed poolId, address[] tokens, address[] assetManagers)
  // Used to get token addresses for Balancer V2 pools after PoolRegistered
  balancer_tokens_registered: '0xf5847d3f2197b16cdcd2098ec95d0905cd1abdaf415f07571c3b5a3e0be8d461',
} as const;

/**
 * Get the event signature for a factory type.
 *
 * @param factoryType - The factory type
 * @returns The keccak256 event signature hash
 * @throws Error if factory type is not supported
 */
export function getFactoryEventSignature(factoryType: FactoryType): string {
  const signature = FactoryEventSignatures[factoryType];
  if (!signature) {
    throw new Error(`Unsupported factory type: ${factoryType}`);
  }
  return signature;
}

// =============================================================================
// Factory Subscription Service
// =============================================================================

/**
 * Factory Subscription Service
 *
 * Manages factory-level event subscriptions for dynamic pair discovery.
 * Reduces RPC subscriptions by 40-50x compared to individual pair subscriptions.
 */
export class FactorySubscriptionService {
  private config: FactorySubscriptionConfig;
  private logger: ServiceLogger;
  private wsManager: FactoryWebSocketManager | null;

  // Factory lookup maps (pre-computed for O(1) lookup)
  private factoryByAddress: Map<string, FactoryConfig> = new Map();
  private factoriesByType: Map<FactoryType, FactoryConfig[]> = new Map();

  // Subscription state
  private subscribed = false;
  // P0-9 FIX: Use AsyncMutex for truly atomic subscription guard
  // Replaces boolean flag which has TOCTOU race condition window
  private subscribeMutex = new AsyncMutex();
  private subscriptionIds: string[] = [];

  // Event callbacks
  private pairCreatedCallbacks: PairCreatedCallback[] = [];

  // P1-1 FIX: Pending Balancer pools awaiting token data from TokensRegistered events
  // Key: poolId (bytes32 as hex string), Value: partial PairCreatedEvent
  private pendingBalancerPools: Map<string, PairCreatedEvent> = new Map();

  // P1-1 FIX: TTL for pending pools (30 seconds) - cleanup stale entries
  private readonly PENDING_POOL_TTL_MS = 30000;

  // Stats
  private stats: FactorySubscriptionStats;

  constructor(config: FactorySubscriptionConfig, deps?: FactorySubscriptionDeps) {
    this.config = config;
    this.logger = deps?.logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };
    this.wsManager = deps?.wsManager ?? null;

    // Initialize stats
    this.stats = {
      chain: config.chain,
      factoriesSubscribed: 0,
      pairsCreated: 0,
      eventsByType: {},
      isSubscribed: false,
      startedAt: null,
    };

    // Build factory lookup maps
    this.buildFactoryMaps();
  }

  /**
   * Build factory lookup maps for O(1) access.
   * Uses customFactories from config if provided, otherwise uses registry.
   *
   * ARCHITECTURAL NOTE: Uses getFactoriesWithEventSupport() to filter out DEXes that:
   * - Use adapter-based pool discovery (GMX, Platypus)
   * - Have non-standard event signatures (Maverick)
   *
   * Curve and Balancer V2 are now fully supported with native event parsing.
   */
  private buildFactoryMaps(): void {
    // Get only factories that support standard factory events
    let factories = getFactoriesWithEventSupport(this.config.chain);

    // If customFactories is provided, filter to only those addresses
    if (this.config.customFactories && this.config.customFactories.length > 0) {
      const customSet = new Set(this.config.customFactories.map(addr => addr.toLowerCase()));
      factories = factories.filter(f => customSet.has(f.address.toLowerCase()));

      this.logger.debug('Using custom factory filter', {
        requested: this.config.customFactories.length,
        matched: factories.length,
      });
    }

    for (const factory of factories) {
      // Index by address (lowercase for case-insensitive lookup)
      this.factoryByAddress.set(factory.address.toLowerCase(), factory);

      // Index by type
      const typeFactories = this.factoriesByType.get(factory.type) || [];
      typeFactories.push(factory);
      this.factoriesByType.set(factory.type, typeFactories);
    }

    this.logger.debug(`Built factory maps for ${this.config.chain}`, {
      factoryCount: factories.length,
      types: Array.from(this.factoriesByType.keys()),
    });
  }

  /**
   * Get the chain being monitored.
   */
  getChain(): string {
    return this.config.chain;
  }

  /**
   * Get all factory addresses for the chain (lowercase).
   * Returns customFactories if configured, otherwise all factories from registry.
   */
  getFactoryAddresses(): string[] {
    // Return addresses from the built map (respects customFactories filter)
    return Array.from(this.factoryByAddress.keys());
  }

  /**
   * Get factory configuration by address.
   */
  getFactoryConfig(address: string): FactoryConfig | undefined {
    return this.factoryByAddress.get(address.toLowerCase());
  }

  /**
   * Check if service is subscribed to factories.
   */
  isSubscribed(): boolean {
    return this.subscribed;
  }

  /**
   * Get current subscription count.
   */
  getSubscriptionCount(): number {
    return this.subscriptionIds.length;
  }

  /**
   * Get service statistics.
   */
  getStats(): FactorySubscriptionStats {
    return {
      ...this.stats,
      isSubscribed: this.subscribed,
    };
  }

  /**
   * Register a callback for PairCreated events.
   */
  onPairCreated(callback: PairCreatedCallback): void {
    this.pairCreatedCallbacks.push(callback);
  }

  /**
   * Subscribe to all factories for the chain.
   *
   * Groups factories by event signature type to minimize subscriptions.
   * Each factory type (V2, V3, Solidly, etc.) uses a different event signature.
   *
   * P0-9 FIX: Use AsyncMutex for truly atomic subscription guard.
   * The previous boolean flag had a TOCTOU race condition window where
   * multiple concurrent callers could pass the check before any sets the flag.
   */
  async subscribeToFactories(): Promise<void> {
    // P0-9 FIX: Use tryAcquire for non-blocking atomic check
    // If mutex is already held, another caller is subscribing
    const release = this.subscribeMutex.tryAcquire();
    if (!release) {
      this.logger.debug('Subscription already in progress');
      return;
    }

    try {
      // Check if already subscribed (while holding mutex)
      if (this.subscribed) {
        this.logger.debug('Already subscribed');
        return;
      }

      if (!this.config.enabled) {
        this.logger.info('Factory subscriptions disabled');
        return;
      }

      // BUG FIX: Use factoryByAddress map which respects customFactories filter
      // Previously used getFactoriesForChain() which ignored the customFactories config
      const factories = Array.from(this.factoryByAddress.values());
      if (factories.length === 0) {
        this.logger.warn(`No factories found for chain ${this.config.chain}`);
        return;
      }

      // Group factories by type for efficient subscriptions
      const subscriptionGroups = new Map<string, { addresses: string[]; type: FactoryType }>();

      for (const factory of factories) {
        const signature = getFactoryEventSignature(factory.type);
        const existing = subscriptionGroups.get(signature);

        if (existing) {
          existing.addresses.push(factory.address.toLowerCase());
        } else {
          subscriptionGroups.set(signature, {
            addresses: [factory.address.toLowerCase()],
            type: factory.type,
          });
        }
      }

      // Subscribe to each group
      let subscriptionCount = 0;
      for (const [signature, group] of subscriptionGroups) {
        try {
          if (this.wsManager) {
            this.wsManager.subscribe({
              method: 'eth_subscribe',
              params: [
                'logs',
                {
                  topics: [signature],
                  address: group.addresses,
                },
              ],
            });

            this.subscriptionIds.push(`${group.type}_${subscriptionCount}`);
            subscriptionCount++;

            this.logger.info(`Subscribed to ${group.type} factory events`, {
              signature: signature.slice(0, 10) + '...',
              factoryCount: group.addresses.length,
            });
          }
        } catch (error) {
          this.logger.error(`Failed to subscribe to ${group.type} factories`, { error });
        }
      }

      this.subscribed = true;
      this.stats.factoriesSubscribed = factories.length;
      this.stats.startedAt = Date.now();

      this.logger.info(`Factory subscriptions active for ${this.config.chain}`, {
        factories: factories.length,
        subscriptionGroups: subscriptionGroups.size,
      });
    } finally {
      // Always release mutex, even on error or early return
      release();
    }
  }

  /**
   * Handle a factory event log.
   *
   * Routes the event to the appropriate parser based on factory address,
   * then emits the parsed PairCreated event to callbacks.
   *
   * P1-1 FIX: Added support for Balancer V2 two-step pool registration:
   * 1. PoolRegistered event → stored in pending map (no tokens)
   * 2. TokensRegistered event → merged with pending pool → emit complete event
   */
  handleFactoryEvent(log: RawEventLog): void {
    if (!this.subscribed) {
      return;
    }

    try {
      const factoryAddress = log.address?.toLowerCase();
      if (!factoryAddress) {
        return;
      }

      // P1-1 FIX: Check for Balancer TokensRegistered event first
      // TokensRegistered is emitted by Vault (same address as factory for Balancer)
      const eventTopic = log.topics?.[0]?.toLowerCase();
      if (eventTopic === BALANCER_TOKENS_REGISTERED_SIGNATURE.toLowerCase()) {
        this.handleBalancerTokensRegistered(log);
        return;
      }

      // O(1) factory lookup
      const factory = this.factoryByAddress.get(factoryAddress);
      if (!factory) {
        this.logger.debug('Received event from unknown factory', { address: factoryAddress });
        return;
      }

      // Parse event based on factory type
      const event = this.parseFactoryEvent(log, factory);
      if (!event) {
        this.logger.debug('Failed to parse factory event', {
          factory: factory.dexName,
          type: factory.type,
        });
        return;
      }

      // Enrich event with DEX name
      event.dexName = factory.dexName;

      // P1-1 FIX: Handle Balancer V2 pools that need token lookup
      if (event.requiresTokenLookup && event.poolId) {
        this.storePendingBalancerPool(event);
        return; // Don't emit yet, wait for TokensRegistered
      }

      // Update stats
      this.stats.pairsCreated++;
      this.stats.eventsByType[factory.type] = (this.stats.eventsByType[factory.type] ?? 0) + 1;

      // Emit to callbacks
      this.emitPairCreatedEvent(event);
    } catch (error) {
      this.logger.error('Failed to handle factory event', { error });
    }
  }

  /**
   * P1-1 FIX: Store a pending Balancer pool awaiting token data.
   * Sets a TTL cleanup timeout to prevent memory leaks.
   */
  private storePendingBalancerPool(event: PairCreatedEvent): void {
    const poolId = event.poolId!;

    this.pendingBalancerPools.set(poolId, event);

    this.logger.debug('Stored pending Balancer pool', {
      poolId: poolId.slice(0, 18) + '...',
      pool: event.pairAddress,
      dex: event.dexName,
    });

    // Set TTL cleanup to prevent memory leaks
    setTimeout(() => {
      if (this.pendingBalancerPools.has(poolId)) {
        this.logger.warn('Pending Balancer pool expired without token data', {
          poolId: poolId.slice(0, 18) + '...',
          pool: event.pairAddress,
        });
        this.pendingBalancerPools.delete(poolId);
      }
    }, this.PENDING_POOL_TTL_MS);
  }

  /**
   * P1-1 FIX: Handle Balancer TokensRegistered event.
   * Merges token addresses with pending pool and emits complete event.
   */
  private handleBalancerTokensRegistered(log: RawEventLog): void {
    const tokenData = parseBalancerTokensRegisteredEvent(log);
    if (!tokenData || tokenData.tokens.length < 2) {
      this.logger.debug('Invalid TokensRegistered event', { log: log?.address });
      return;
    }

    const pendingPool = this.pendingBalancerPools.get(tokenData.poolId);
    if (!pendingPool) {
      this.logger.debug('TokensRegistered for unknown pool', {
        poolId: tokenData.poolId.slice(0, 18) + '...',
      });
      return;
    }

    // Remove from pending
    this.pendingBalancerPools.delete(tokenData.poolId);

    // Merge token data into the event
    const completeEvent: PairCreatedEvent = {
      ...pendingPool,
      token0: tokenData.tokens[0],
      token1: tokenData.tokens[1],
      coins: tokenData.tokens.length > 2 ? tokenData.tokens : undefined,
      requiresTokenLookup: false, // Mark as complete
    };

    // Update stats
    this.stats.pairsCreated++;
    this.stats.eventsByType['balancer_v2'] = (this.stats.eventsByType['balancer_v2'] ?? 0) + 1;

    // Emit complete event
    this.emitPairCreatedEvent(completeEvent);

    this.logger.debug('Completed Balancer pool registration', {
      poolId: tokenData.poolId.slice(0, 18) + '...',
      pool: completeEvent.pairAddress,
      tokens: tokenData.tokens.length,
    });
  }

  /**
   * P1-1 FIX: Emit a PairCreated event to all registered callbacks.
   */
  private emitPairCreatedEvent(event: PairCreatedEvent): void {
    for (const callback of this.pairCreatedCallbacks) {
      try {
        callback(event);
      } catch (error) {
        this.logger.error('Error in PairCreated callback', { error });
      }
    }

    this.logger.debug('Processed factory event', {
      dex: event.dexName,
      pair: event.pairAddress,
      tokens: `${event.token0.slice(0, 10)}.../${event.token1.slice(0, 10)}...`,
    });
  }

  /**
   * Parse a factory event based on factory type.
   * Uses exhaustive switch to ensure all factory types are handled.
   */
  private parseFactoryEvent(log: RawEventLog, factory: FactoryConfig): PairCreatedEvent | null {
    const factoryType: FactoryType = factory.type;

    switch (factoryType) {
      case 'uniswap_v2':
        return parseV2PairCreatedEvent(log);
      case 'uniswap_v3':
        return parseV3PoolCreatedEvent(log);
      case 'solidly':
        return parseSolidlyPairCreatedEvent(log);
      case 'algebra':
        return parseAlgebraPoolCreatedEvent(log);
      case 'trader_joe':
        return parseTraderJoePairCreatedEvent(log);
      case 'curve':
        // Curve uses PlainPoolDeployed/MetaPoolDeployed events
        // Supports multi-coin pools (2-4 tokens)
        return parseCurvePoolCreatedEvent(log);
      case 'balancer_v2':
        // Balancer uses PoolRegistered event with poolId
        // Note: Tokens need to be fetched separately via Vault.getPoolTokens(poolId)
        // or by listening for TokensRegistered event
        return parseBalancerPoolRegisteredEvent(log);
      default: {
        // Exhaustive check - TypeScript will error if a FactoryType case is missing
        const _exhaustiveCheck: never = factoryType;
        this.logger.error(`Unknown factory type: ${_exhaustiveCheck}`);
        return null;
      }
    }
  }

  /**
   * Stop the service and unsubscribe from all factories.
   * P1-1 FIX: Also clears pending Balancer pools to prevent memory leaks.
   */
  stop(): void {
    this.subscribed = false;
    this.subscriptionIds = [];
    this.pairCreatedCallbacks = [];

    // P1-1 FIX: Clear pending Balancer pools
    this.pendingBalancerPools.clear();

    this.logger.info(`Factory subscription service stopped for ${this.config.chain}`);
  }
}

/**
 * Create a factory subscription service instance.
 */
export function createFactorySubscriptionService(
  config: FactorySubscriptionConfig,
  deps?: FactorySubscriptionDeps
): FactorySubscriptionService {
  return new FactorySubscriptionService(config, deps);
}
