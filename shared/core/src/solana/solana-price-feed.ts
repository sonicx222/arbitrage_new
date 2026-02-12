/**
 * S3.3.5 Solana Price Feed Integration
 *
 * Provides real-time price updates from Solana DEX pools:
 * - Raydium AMM pool state parsing
 * - Raydium CLMM pool state parsing (concentrated liquidity)
 * - Orca Whirlpool pool state parsing (concentrated liquidity)
 *
 * Uses accountSubscribe for real-time updates without polling.
 *
 * Pool parsing logic has been extracted to pricing/pool-parsers/ for modularity.
 * This file re-exports types and constants for backward compatibility.
 *
 * @see IMPLEMENTATION_PLAN.md S3.3.5: Create Solana price feed integration
 * @see ADR-003: Partitioned Chain Detectors
 */

import { EventEmitter } from 'events';
import { Connection, PublicKey, Commitment, AccountInfo, Context } from '@solana/web3.js';
import { createLogger } from '../logger';
import { clearIntervalSafe } from '../lifecycle-utils';

// Import from extracted pool-parsers module
import {
  // Raydium AMM
  RAYDIUM_AMM_LAYOUT,
  parseRaydiumAmmState as parseRaydiumAmmStateImpl,
  calculateAmmPrice as calculateAmmPriceImpl,
  parseRaydiumAmmPriceUpdate,
  // Raydium CLMM
  RAYDIUM_CLMM_LAYOUT,
  parseRaydiumClmmState as parseRaydiumClmmStateImpl,
  parseRaydiumClmmPriceUpdate,
  // Orca Whirlpool
  ORCA_WHIRLPOOL_LAYOUT,
  parseOrcaWhirlpoolState as parseOrcaWhirlpoolStateImpl,
  parseOrcaWhirlpoolPriceUpdate,
  // Utilities
  safeInversePrice,
  tickToPrice as tickToPriceUtil,
  priceToTick as priceToTickUtil,
  calculateClmmPriceFromSqrt
} from './pricing/pool-parsers';

import type {
  RaydiumAmmPoolState,
  RaydiumClmmPoolState,
  OrcaWhirlpoolState,
  ParsedPriceData
} from './pricing/pool-parsers';

// =============================================================================
// Re-exports for backward compatibility
// =============================================================================

export {
  RAYDIUM_AMM_LAYOUT,
  RAYDIUM_CLMM_LAYOUT,
  ORCA_WHIRLPOOL_LAYOUT
};

export type {
  RaydiumAmmPoolState,
  RaydiumClmmPoolState,
  OrcaWhirlpoolState
};

// =============================================================================
// Type Definitions
// =============================================================================

/**
 * Logger interface for SolanaPriceFeed.
 */
export interface SolanaPriceFeedLogger {
  info: (message: string, meta?: object) => void;
  warn: (message: string, meta?: object) => void;
  error: (message: string, meta?: object) => void;
  debug: (message: string, meta?: object) => void;
}

/**
 * Configuration for SolanaPriceFeed.
 */
export interface SolanaPriceFeedConfig {
  /** Solana RPC endpoint URL */
  rpcUrl: string;
  /** WebSocket endpoint (derived from rpcUrl if not provided) */
  wsUrl?: string;
  /** Commitment level (default: 'confirmed') */
  commitment?: Commitment;
  /** Maximum number of pools to subscribe to (default: 100) */
  maxPoolSubscriptions?: number;
  /** Price staleness threshold in ms (default: 10000) */
  priceStaleThresholdMs?: number;
  /** Emit price updates even if price unchanged (default: false) */
  emitUnchangedPrices?: boolean;
  /** Minimum price change threshold to trigger update (default: 0.000001) */
  minPriceChangeThreshold?: number;
}

/**
 * Dependencies for SolanaPriceFeed (DI pattern).
 */
export interface SolanaPriceFeedDeps {
  logger?: SolanaPriceFeedLogger;
  /** Optional connection for testing */
  connection?: Connection;
}

/**
 * Parsed price update from pool state.
 */
export interface SolanaPriceUpdate {
  /** Pool address */
  poolAddress: string;
  /** DEX name */
  dex: 'raydium-amm' | 'raydium-clmm' | 'orca-whirlpool';
  /** Token 0 mint address */
  token0: string;
  /** Token 1 mint address */
  token1: string;
  /** Price (token1 per token0) */
  price: number;
  /** Inverse price (token0 per token1) */
  inversePrice: number;
  /** Token 0 reserves (normalized) */
  reserve0: string;
  /** Token 1 reserves (normalized) */
  reserve1: string;
  /** Solana slot number */
  slot: number;
  /** Timestamp of update */
  timestamp: number;
  /** For CLMM: sqrt price as string */
  sqrtPriceX64?: string;
  /** For CLMM: current liquidity */
  liquidity?: string;
  /** For CLMM: current tick index */
  tickCurrentIndex?: number;
}

/**
 * Pool subscription tracking.
 */
export interface PoolSubscription {
  poolAddress: string;
  dex: 'raydium-amm' | 'raydium-clmm' | 'orca-whirlpool';
  subscriptionId: number;
  lastUpdate: number;
  lastPrice: number;
  token0Decimals: number;
  token1Decimals: number;
}

/**
 * Supported DEX types for subscription.
 */
export type SupportedDex = 'raydium-amm' | 'raydium-clmm' | 'orca-whirlpool';

// =============================================================================
// Constants
// =============================================================================

/**
 * Program IDs for supported DEXes.
 */
export const SOLANA_DEX_PROGRAMS = {
  RAYDIUM_AMM: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  RAYDIUM_CLMM: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  ORCA_WHIRLPOOL: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'
} as const;

// =============================================================================
// SolanaPriceFeed Class
// =============================================================================

/**
 * Real-time price feed from Solana DEX pools.
 * Subscribes to pool account updates and emits price changes.
 *
 * Events:
 * - 'priceUpdate': Emitted when pool price changes
 * - 'stalePrice': Emitted when a price becomes stale
 * - 'error': Emitted on errors
 * - 'connected': Emitted when connection established
 * - 'disconnected': Emitted when connection lost
 */
export class SolanaPriceFeed extends EventEmitter {
  private config: Required<SolanaPriceFeedConfig>;
  private logger: SolanaPriceFeedLogger;
  private connection: Connection | null = null;
  private subscriptions: Map<string, PoolSubscription> = new Map();
  private running = false;
  private stopping = false;
  private stalenessCheckInterval: NodeJS.Timeout | null = null;

  // Lifecycle protection (consistent with SolanaDetector pattern)
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(config: SolanaPriceFeedConfig, deps?: SolanaPriceFeedDeps) {
    super();

    // Validate required config
    if (!config.rpcUrl || config.rpcUrl.trim() === '') {
      throw new Error('RPC URL is required for SolanaPriceFeed');
    }

    // Set defaults
    this.config = {
      rpcUrl: config.rpcUrl,
      wsUrl: config.wsUrl || this.deriveWsUrl(config.rpcUrl),
      commitment: config.commitment || 'confirmed',
      maxPoolSubscriptions: config.maxPoolSubscriptions || 100,
      priceStaleThresholdMs: config.priceStaleThresholdMs || 10000,
      emitUnchangedPrices: config.emitUnchangedPrices || false,
      minPriceChangeThreshold: config.minPriceChangeThreshold ?? 0.000001
    };

    // Set up logging
    this.logger = deps?.logger || createLogger('solana-price-feed');

    // Use injected connection if provided (for testing)
    if (deps?.connection) {
      this.connection = deps.connection;
    }

    this.logger.info('SolanaPriceFeed initialized', {
      rpcUrl: this.config.rpcUrl,
      commitment: this.config.commitment,
      maxPoolSubscriptions: this.config.maxPoolSubscriptions
    });
  }

  // ===========================================================================
  // Lifecycle Methods
  // ===========================================================================

  /**
   * Start the price feed.
   */
  async start(): Promise<void> {
    // Return existing promise if start in progress (prevents race conditions)
    if (this.startPromise) {
      return this.startPromise;
    }

    // Wait for pending stop
    if (this.stopPromise) {
      await this.stopPromise;
    }

    // Guard against starting while stopping
    if (this.stopping) {
      this.logger.warn('Cannot start: SolanaPriceFeed is stopping');
      return;
    }

    // Guard against double start
    if (this.running) {
      this.logger.warn('SolanaPriceFeed already running');
      return;
    }

    this.startPromise = this.performStart();

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async performStart(): Promise<void> {
    this.logger.info('Starting SolanaPriceFeed');

    // Track if we created the connection (vs injected)
    let connectionCreatedHere = false;

    try {
      // Create connection if not injected
      if (!this.connection) {
        this.connection = new Connection(this.config.rpcUrl, {
          commitment: this.config.commitment,
          wsEndpoint: this.config.wsUrl
        });
        connectionCreatedHere = true;
      }

      // Test connection
      await this.connection.getSlot();

      // Start staleness monitoring
      this.startStalenessMonitoring();

      this.running = true;
      this.emit('connected');

      this.logger.info('SolanaPriceFeed started successfully');
    } catch (error) {
      // BUG FIX: Clean up connection if we created it and startup failed
      if (connectionCreatedHere && this.connection) {
        this.logger.debug('Cleaning up connection after start failure');
        this.connection = null;
      }
      this.logger.error('Failed to start SolanaPriceFeed', { error });
      throw error;
    }
  }

  /**
   * Stop the price feed.
   */
  async stop(): Promise<void> {
    // Return existing promise if stop in progress
    if (this.stopPromise) {
      return this.stopPromise;
    }

    // Guard against stop when not running
    if (!this.running && !this.stopping) {
      this.logger.debug('SolanaPriceFeed not running');
      return;
    }

    this.stopPromise = this.performStop();

    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  private async performStop(): Promise<void> {
    this.logger.info('Stopping SolanaPriceFeed');
    this.stopping = true;
    this.running = false;

    // Stop staleness monitoring
    this.stalenessCheckInterval = clearIntervalSafe(this.stalenessCheckInterval);

    // Unsubscribe from all pools
    const poolAddresses = Array.from(this.subscriptions.keys());
    for (const address of poolAddresses) {
      try {
        await this.unsubscribeFromPool(address);
      } catch (error) {
        this.logger.warn(`Error unsubscribing from pool ${address}`, { error });
      }
    }

    this.emit('disconnected');
    this.stopping = false;

    this.logger.info('SolanaPriceFeed stopped');
  }

  /**
   * Check if the price feed is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  // ===========================================================================
  // Pool Subscription Methods
  // ===========================================================================

  /**
   * Subscribe to price updates from a pool.
   * @param poolAddress Pool account address
   * @param dex DEX type (raydium-amm, raydium-clmm, orca-whirlpool)
   * @param token0Decimals Optional decimals for token 0 (fetched if not provided)
   * @param token1Decimals Optional decimals for token 1 (fetched if not provided)
   */
  async subscribeToPool(
    poolAddress: string,
    dex: SupportedDex,
    token0Decimals = 9,
    token1Decimals = 6
  ): Promise<void> {
    // Guard: don't allow subscriptions during shutdown
    if (this.stopping) {
      this.logger.warn('Cannot subscribe: SolanaPriceFeed is stopping', { poolAddress });
      return;
    }

    // Guard: must be running
    if (!this.running) {
      throw new Error('SolanaPriceFeed not running');
    }

    // Validate pool address
    if (!this.isValidSolanaAddress(poolAddress)) {
      const error = new Error(`Invalid pool address: ${poolAddress}`);
      this.emit('error', error);
      throw error;
    }

    // Check if already subscribed
    if (this.subscriptions.has(poolAddress)) {
      this.logger.debug('Already subscribed to pool', { poolAddress });
      return;
    }

    // Check subscription limit
    if (this.subscriptions.size >= this.config.maxPoolSubscriptions) {
      const error = new Error(`Maximum pool subscriptions reached: ${this.config.maxPoolSubscriptions}`);
      this.emit('error', error);
      throw error;
    }

    if (!this.connection) {
      throw new Error('SolanaPriceFeed not started');
    }

    const pubkey = new PublicKey(poolAddress);

    // Subscribe to account changes
    const subscriptionId = this.connection.onAccountChange(
      pubkey,
      (accountInfo: AccountInfo<Buffer>, context: Context) => {
        this.handleAccountUpdate(poolAddress, dex, accountInfo, context, token0Decimals, token1Decimals);
      },
      this.config.commitment
    );

    // Track subscription
    this.subscriptions.set(poolAddress, {
      poolAddress,
      dex,
      subscriptionId,
      lastUpdate: Date.now(),
      lastPrice: 0,
      token0Decimals,
      token1Decimals
    });

    this.logger.info('Subscribed to pool', { poolAddress, dex, subscriptionId });

    // Fetch initial state
    try {
      // Get both account info and slot in parallel for efficiency
      const [accountInfo, slot] = await Promise.all([
        this.connection.getAccountInfo(pubkey),
        this.connection.getSlot()
      ]);

      if (accountInfo) {
        // Check if still subscribed (could have been unsubscribed during await)
        if (!this.subscriptions.has(poolAddress)) {
          this.logger.debug('Subscription removed during initial fetch', { poolAddress });
          return;
        }

        this.handleAccountUpdate(
          poolAddress,
          dex,
          accountInfo,
          { slot },
          token0Decimals,
          token1Decimals
        );
      }
    } catch (error) {
      this.logger.warn('Failed to fetch initial pool state', { poolAddress, error });
    }
  }

  /**
   * Unsubscribe from a pool.
   * @param poolAddress Pool account address
   */
  async unsubscribeFromPool(poolAddress: string): Promise<void> {
    const subscription = this.subscriptions.get(poolAddress);
    if (!subscription) {
      this.logger.debug('Not subscribed to pool', { poolAddress });
      return;
    }

    if (this.connection) {
      try {
        await this.connection.removeAccountChangeListener(subscription.subscriptionId);
      } catch (error) {
        this.logger.warn('Error removing account listener', { poolAddress, error });
      }
    }

    this.subscriptions.delete(poolAddress);
    this.logger.info('Unsubscribed from pool', { poolAddress });
  }

  /**
   * Get the number of active subscriptions.
   */
  getSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  /**
   * Get list of subscribed pool addresses.
   */
  getSubscribedPools(): string[] {
    return Array.from(this.subscriptions.keys());
  }

  // ===========================================================================
  // Account Update Handling
  // ===========================================================================

  private handleAccountUpdate(
    poolAddress: string,
    dex: SupportedDex,
    accountInfo: AccountInfo<Buffer>,
    context: Context,
    token0Decimals: number,
    token1Decimals: number
  ): void {
    // Guard: don't process updates during shutdown
    if (this.stopping || !this.running) return;

    try {
      let priceUpdate: SolanaPriceUpdate | null = null;

      switch (dex) {
        case 'raydium-amm':
          priceUpdate = this.parseRaydiumAmmUpdate(poolAddress, accountInfo.data, context.slot);
          break;
        case 'raydium-clmm':
          priceUpdate = this.parseRaydiumClmmUpdate(poolAddress, accountInfo.data, context.slot, token0Decimals, token1Decimals);
          break;
        case 'orca-whirlpool':
          priceUpdate = this.parseOrcaWhirlpoolUpdate(poolAddress, accountInfo.data, context.slot, token0Decimals, token1Decimals);
          break;
      }

      if (priceUpdate) {
        const subscription = this.subscriptions.get(poolAddress);
        if (subscription) {
          // Check if price changed (use configurable threshold)
          const priceChanged = Math.abs(priceUpdate.price - subscription.lastPrice) > this.config.minPriceChangeThreshold;

          if (priceChanged || this.config.emitUnchangedPrices) {
            subscription.lastUpdate = Date.now();
            subscription.lastPrice = priceUpdate.price;

            this.emit('priceUpdate', priceUpdate);

            this.logger.debug('Price update emitted', {
              poolAddress,
              dex,
              price: priceUpdate.price,
              slot: priceUpdate.slot
            });
          }
        }
      }
    } catch (error) {
      this.logger.error('Error handling account update', { poolAddress, dex, error });
      this.emit('error', error);
    }
  }

  // ===========================================================================
  // Parser Delegations (delegate to extracted modules)
  // ===========================================================================

  /**
   * Parse Raydium AMM pool state from account data.
   * @deprecated Use parseRaydiumAmmState from pricing/pool-parsers directly
   */
  parseRaydiumAmmState(data: Buffer): RaydiumAmmPoolState | null {
    return parseRaydiumAmmStateImpl(data, this.logger);
  }

  /**
   * Calculate price from AMM reserves.
   * @deprecated Use calculateAmmPrice from pricing/pool-parsers directly
   */
  calculateAmmPrice(state: RaydiumAmmPoolState): number {
    return calculateAmmPriceImpl(state);
  }

  private parseRaydiumAmmUpdate(
    poolAddress: string,
    data: Buffer,
    slot: number
  ): SolanaPriceUpdate | null {
    const result = parseRaydiumAmmPriceUpdate(poolAddress, data, slot, this.logger);
    return result ? this.toPriceUpdate(result) : null;
  }

  /**
   * Parse Raydium CLMM pool state from account data.
   * @deprecated Use parseRaydiumClmmState from pricing/pool-parsers directly
   */
  parseRaydiumClmmState(data: Buffer): RaydiumClmmPoolState | null {
    return parseRaydiumClmmStateImpl(data, this.logger);
  }

  private parseRaydiumClmmUpdate(
    poolAddress: string,
    data: Buffer,
    slot: number,
    token0Decimals: number,
    token1Decimals: number
  ): SolanaPriceUpdate | null {
    const result = parseRaydiumClmmPriceUpdate(poolAddress, data, slot, token0Decimals, token1Decimals, this.logger);
    return result ? this.toPriceUpdate(result) : null;
  }

  /**
   * Calculate price from CLMM sqrtPriceX64.
   * @deprecated Use calculateClmmPriceFromSqrt from pricing/pool-parsers directly
   */
  calculateClmmPrice(sqrtPriceX64: bigint, token0Decimals: number, token1Decimals: number): number {
    return calculateClmmPriceFromSqrt(sqrtPriceX64, token0Decimals, token1Decimals);
  }

  /**
   * Parse Orca Whirlpool state from account data.
   * @deprecated Use parseOrcaWhirlpoolState from pricing/pool-parsers directly
   */
  parseOrcaWhirlpoolState(data: Buffer): OrcaWhirlpoolState | null {
    return parseOrcaWhirlpoolStateImpl(data, this.logger);
  }

  private parseOrcaWhirlpoolUpdate(
    poolAddress: string,
    data: Buffer,
    slot: number,
    token0Decimals: number,
    token1Decimals: number
  ): SolanaPriceUpdate | null {
    const result = parseOrcaWhirlpoolPriceUpdate(poolAddress, data, slot, token0Decimals, token1Decimals, this.logger);
    return result ? this.toPriceUpdate(result) : null;
  }

  /**
   * Calculate price from Whirlpool sqrtPrice.
   * @deprecated Use calculateClmmPriceFromSqrt from pricing/pool-parsers directly
   */
  calculateWhirlpoolPrice(sqrtPrice: bigint, token0Decimals: number, token1Decimals: number): number {
    return calculateClmmPriceFromSqrt(sqrtPrice, token0Decimals, token1Decimals);
  }

  // ===========================================================================
  // Tick Conversion Utilities
  // ===========================================================================

  /**
   * Convert tick to price.
   * @deprecated Use tickToPrice from pricing/pool-parsers directly
   */
  tickToPrice(tick: number, token0Decimals: number, token1Decimals: number): number {
    return tickToPriceUtil(tick, token0Decimals, token1Decimals);
  }

  /**
   * Convert price to tick.
   * @deprecated Use priceToTick from pricing/pool-parsers directly
   */
  priceToTick(price: number, token0Decimals: number, token1Decimals: number): number {
    return priceToTickUtil(price, token0Decimals, token1Decimals);
  }

  // ===========================================================================
  // Staleness Monitoring
  // ===========================================================================

  private startStalenessMonitoring(): void {
    // Run staleness check at the threshold interval (not faster)
    this.stalenessCheckInterval = setInterval(() => {
      // Guard: don't run checks during shutdown or when not running
      if (!this.running || this.stopping) {
        return;
      }

      const now = Date.now();
      const threshold = this.config.priceStaleThresholdMs;

      for (const [poolAddress, subscription] of this.subscriptions) {
        const age = now - subscription.lastUpdate;
        if (age > threshold) {
          this.emit('stalePrice', {
            poolAddress,
            dex: subscription.dex,
            lastUpdate: subscription.lastUpdate,
            staleMs: age
          });
        }
      }
    }, this.config.priceStaleThresholdMs);
  }

  // ===========================================================================
  // Utility Methods
  // ===========================================================================

  private deriveWsUrl(rpcUrl: string): string {
    return rpcUrl.replace(/^http/, 'ws');
  }

  private isValidSolanaAddress(address: string): boolean {
    try {
      new PublicKey(address);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Convert ParsedPriceData to SolanaPriceUpdate (for backward compatibility).
   */
  private toPriceUpdate(parsed: ParsedPriceData): SolanaPriceUpdate {
    return {
      poolAddress: parsed.poolAddress,
      dex: parsed.dex as SolanaPriceUpdate['dex'],
      token0: parsed.token0,
      token1: parsed.token1,
      price: parsed.price,
      inversePrice: parsed.inversePrice,
      reserve0: parsed.reserve0,
      reserve1: parsed.reserve1,
      slot: parsed.slot,
      timestamp: parsed.timestamp,
      sqrtPriceX64: parsed.sqrtPriceX64,
      liquidity: parsed.liquidity,
      tickCurrentIndex: parsed.tickCurrentIndex
    };
  }
}

export default SolanaPriceFeed;
