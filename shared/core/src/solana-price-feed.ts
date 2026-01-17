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
 * @see IMPLEMENTATION_PLAN.md S3.3.5: Create Solana price feed integration
 * @see ADR-003: Partitioned Chain Detectors
 */

import { EventEmitter } from 'events';
import { Connection, PublicKey, Commitment, AccountInfo, Context } from '@solana/web3.js';
import { createLogger } from './logger';

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
 * Raydium AMM pool state structure (V4).
 * Account data layout for Raydium liquidity pools.
 */
export interface RaydiumAmmPoolState {
  /** Pool status (0 = uninitialized, 1 = active, etc.) */
  status: number;
  /** Nonce for PDA derivation */
  nonce: number;
  /** Base token mint address */
  baseMint: string;
  /** Quote token mint address */
  quoteMint: string;
  /** Base token vault address */
  baseVault: string;
  /** Quote token vault address */
  quoteVault: string;
  /** Base token reserves (raw amount) */
  baseReserve: bigint;
  /** Quote token reserves (raw amount) */
  quoteReserve: bigint;
  /** Base token decimals */
  baseDecimals: number;
  /** Quote token decimals */
  quoteDecimals: number;
  /** LP token mint address */
  lpMint: string;
  /** Open orders account */
  openOrders: string;
  /** Market ID (Serum/OpenBook) */
  marketId: string;
  /** Fee rate numerator */
  feeNumerator: number;
  /** Fee rate denominator */
  feeDenominator: number;
}

/**
 * Raydium CLMM pool state structure.
 * Concentrated liquidity pool with tick-based pricing.
 */
export interface RaydiumClmmPoolState {
  /** Pool bump seed */
  bump: number;
  /** AMM config address */
  ammConfig: string;
  /** Pool creator address */
  poolCreator: string;
  /** Token 0 mint address */
  token0Mint: string;
  /** Token 1 mint address */
  token1Mint: string;
  /** Token 0 vault address */
  token0Vault: string;
  /** Token 1 vault address */
  token1Vault: string;
  /** Observation key */
  observationKey: string;
  /** Mint decimals for token 0 */
  mintDecimals0: number;
  /** Mint decimals for token 1 */
  mintDecimals1: number;
  /** Tick spacing for this pool */
  tickSpacing: number;
  /** Total liquidity in active tick range */
  liquidity: bigint;
  /** Current sqrt price as Q64.64 fixed point */
  sqrtPriceX64: bigint;
  /** Current tick index */
  tickCurrent: number;
  /** Fee growth for token 0 */
  feeGrowthGlobal0X64: bigint;
  /** Fee growth for token 1 */
  feeGrowthGlobal1X64: bigint;
  /** Protocol fees for token 0 */
  protocolFeesToken0: bigint;
  /** Protocol fees for token 1 */
  protocolFeesToken1: bigint;
  /** Fee rate in hundredths of basis points */
  feeRate: number;
  /** Pool status */
  status: number;
}

/**
 * Orca Whirlpool state structure.
 * Concentrated liquidity pool similar to Uniswap V3.
 */
export interface OrcaWhirlpoolState {
  /** Whirlpool config address */
  whirlpoolsConfig: string;
  /** Whirlpool bump seeds */
  whirlpoolBump: number[];
  /** Tick spacing bump */
  tickSpacingBump: number;
  /** Fee rate in hundredths of a basis point (e.g., 3000 = 0.30%) */
  feeRate: number;
  /** Protocol fee rate (percentage of fee) */
  protocolFeeRate: number;
  /** Total liquidity in active tick range */
  liquidity: bigint;
  /** Current sqrt price as Q64.64 fixed point */
  sqrtPrice: bigint;
  /** Current tick index */
  tickCurrentIndex: number;
  /** Protocol fees owed for token A */
  protocolFeeOwedA: bigint;
  /** Protocol fees owed for token B */
  protocolFeeOwedB: bigint;
  /** Token mint A address */
  tokenMintA: string;
  /** Token mint B address */
  tokenMintB: string;
  /** Token vault A address */
  tokenVaultA: string;
  /** Token vault B address */
  tokenVaultB: string;
  /** Fee growth for token A */
  feeGrowthGlobalA: bigint;
  /** Fee growth for token B */
  feeGrowthGlobalB: bigint;
  /** Reward infos */
  rewardLastUpdatedTimestamp: bigint;
  /** Tick spacing for this pool */
  tickSpacing: number;
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
 * Raydium AMM V4 account data layout offsets.
 */
export const RAYDIUM_AMM_LAYOUT = {
  STATUS: 0,
  NONCE: 1,
  ORDER_NUM: 2,
  DEPTH: 4,
  BASE_DECIMALS: 6,
  QUOTE_DECIMALS: 7,
  STATE: 8,
  RESET_FLAG: 9,
  MIN_SIZE: 10,
  VOL_MAX_CUT_RATIO: 18,
  AMM_OPEN_ORDERS: 26,
  LP_MINT: 58,
  COIN_MINT: 90,     // Base mint
  PC_MINT: 122,      // Quote mint
  COIN_VAULT: 154,   // Base vault
  PC_VAULT: 186,     // Quote vault
  NEED_TAKE_COIN: 218,
  NEED_TAKE_PC: 226,
  TOTAL_COIN: 234,   // Base reserve (u64)
  TOTAL_PC: 242,     // Quote reserve (u64)
  POOL_OPEN_TIME: 250,
  PUNISH_PC_AMOUNT: 258,
  PUNISH_COIN_AMOUNT: 266,
  ORDERBOOK_TO_INIT_TIME: 274,
  SWAP_COIN_IN_AMOUNT: 282,
  SWAP_PC_OUT_AMOUNT: 290,
  SWAP_COIN_2_PC_FEE: 298,
  SWAP_PC_IN_AMOUNT: 306,
  SWAP_COIN_OUT_AMOUNT: 314,
  SWAP_PC_2_COIN_FEE: 322,
  MARKET_ID: 330,
  ACCOUNT_SIZE: 752
} as const;

/**
 * Raydium CLMM pool account data layout offsets.
 */
export const RAYDIUM_CLMM_LAYOUT = {
  BUMP: 8,
  AMM_CONFIG: 9,
  POOL_CREATOR: 41,
  TOKEN_0_MINT: 73,
  TOKEN_1_MINT: 105,
  TOKEN_0_VAULT: 137,
  TOKEN_1_VAULT: 169,
  OBSERVATION_KEY: 201,
  MINT_DECIMALS_0: 233,
  MINT_DECIMALS_1: 234,
  TICK_SPACING: 235,
  LIQUIDITY: 237,       // u128 (16 bytes)
  SQRT_PRICE_X64: 253,  // u128 (16 bytes)
  TICK_CURRENT: 269,    // i32
  OBSERVATION_INDEX: 273,
  OBSERVATION_UPDATE_DURATION: 275,
  FEE_GROWTH_GLOBAL_0_X64: 277, // u128
  FEE_GROWTH_GLOBAL_1_X64: 293, // u128
  PROTOCOL_FEES_TOKEN_0: 309,   // u64
  PROTOCOL_FEES_TOKEN_1: 317,   // u64
  FEE_RATE: 325,        // u32
  STATUS: 329,
  ACCOUNT_SIZE: 1544
} as const;

/**
 * Orca Whirlpool account data layout offsets.
 * Based on Whirlpool program account structure.
 */
export const ORCA_WHIRLPOOL_LAYOUT = {
  DISCRIMINATOR: 0,           // 8 bytes
  WHIRLPOOLS_CONFIG: 8,       // Pubkey (32 bytes)
  WHIRLPOOL_BUMP: 40,         // [u8; 1]
  TICK_SPACING: 41,           // u16
  TICK_SPACING_SEED: 43,      // [u8; 2]
  FEE_RATE: 45,               // u16
  PROTOCOL_FEE_RATE: 47,      // u16
  LIQUIDITY: 49,              // u128 (16 bytes)
  SQRT_PRICE: 65,             // u128 (16 bytes)
  TICK_CURRENT_INDEX: 81,     // i32
  PROTOCOL_FEE_OWED_A: 85,    // u64
  PROTOCOL_FEE_OWED_B: 93,    // u64
  TOKEN_MINT_A: 101,          // Pubkey (32 bytes)
  TOKEN_MINT_B: 133,          // Pubkey (32 bytes)
  TOKEN_VAULT_A: 165,         // Pubkey (32 bytes)
  TOKEN_VAULT_B: 197,         // Pubkey (32 bytes)
  FEE_GROWTH_GLOBAL_A: 229,   // u128 (16 bytes)
  FEE_GROWTH_GLOBAL_B: 245,   // u128 (16 bytes)
  REWARD_LAST_UPDATED_TIMESTAMP: 261, // u64
  REWARD_INFOS: 269,          // 3 * RewardInfo
  ACCOUNT_SIZE: 653
} as const;

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
    if (this.stalenessCheckInterval) {
      clearInterval(this.stalenessCheckInterval);
      this.stalenessCheckInterval = null;
    }

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
    // BUG FIX: Fetch slot first to avoid race condition where subscription callback
    // fires while we're awaiting getSlot() inside handleAccountUpdate call
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
  // Raydium AMM Parsing
  // ===========================================================================

  /**
   * Parse Raydium AMM pool state from account data.
   */
  parseRaydiumAmmState(data: Buffer): RaydiumAmmPoolState | null {
    if (data.length < RAYDIUM_AMM_LAYOUT.ACCOUNT_SIZE) {
      this.logger.warn('Invalid Raydium AMM account size', {
        expected: RAYDIUM_AMM_LAYOUT.ACCOUNT_SIZE,
        actual: data.length
      });
      return null;
    }

    try {
      const status = data.readUInt8(RAYDIUM_AMM_LAYOUT.STATUS);
      const nonce = data.readUInt8(RAYDIUM_AMM_LAYOUT.NONCE);
      const baseDecimals = data.readUInt8(RAYDIUM_AMM_LAYOUT.BASE_DECIMALS);
      const quoteDecimals = data.readUInt8(RAYDIUM_AMM_LAYOUT.QUOTE_DECIMALS);

      // Read reserves (u64)
      const baseReserve = data.readBigUInt64LE(RAYDIUM_AMM_LAYOUT.TOTAL_COIN);
      const quoteReserve = data.readBigUInt64LE(RAYDIUM_AMM_LAYOUT.TOTAL_PC);

      // Read pubkeys (32 bytes each)
      const baseMint = new PublicKey(data.subarray(
        RAYDIUM_AMM_LAYOUT.COIN_MINT,
        RAYDIUM_AMM_LAYOUT.COIN_MINT + 32
      )).toBase58();

      const quoteMint = new PublicKey(data.subarray(
        RAYDIUM_AMM_LAYOUT.PC_MINT,
        RAYDIUM_AMM_LAYOUT.PC_MINT + 32
      )).toBase58();

      const baseVault = new PublicKey(data.subarray(
        RAYDIUM_AMM_LAYOUT.COIN_VAULT,
        RAYDIUM_AMM_LAYOUT.COIN_VAULT + 32
      )).toBase58();

      const quoteVault = new PublicKey(data.subarray(
        RAYDIUM_AMM_LAYOUT.PC_VAULT,
        RAYDIUM_AMM_LAYOUT.PC_VAULT + 32
      )).toBase58();

      const lpMint = new PublicKey(data.subarray(
        RAYDIUM_AMM_LAYOUT.LP_MINT,
        RAYDIUM_AMM_LAYOUT.LP_MINT + 32
      )).toBase58();

      const openOrders = new PublicKey(data.subarray(
        RAYDIUM_AMM_LAYOUT.AMM_OPEN_ORDERS,
        RAYDIUM_AMM_LAYOUT.AMM_OPEN_ORDERS + 32
      )).toBase58();

      const marketId = new PublicKey(data.subarray(
        RAYDIUM_AMM_LAYOUT.MARKET_ID,
        RAYDIUM_AMM_LAYOUT.MARKET_ID + 32
      )).toBase58();

      return {
        status,
        nonce,
        baseMint,
        quoteMint,
        baseVault,
        quoteVault,
        baseReserve,
        quoteReserve,
        baseDecimals,
        quoteDecimals,
        lpMint,
        openOrders,
        marketId,
        feeNumerator: 25, // Default Raydium fee: 0.25%
        feeDenominator: 10000
      };
    } catch (error) {
      this.logger.error('Error parsing Raydium AMM state', { error });
      return null;
    }
  }

  private parseRaydiumAmmUpdate(
    poolAddress: string,
    data: Buffer,
    slot: number
  ): SolanaPriceUpdate | null {
    const state = this.parseRaydiumAmmState(data);
    if (!state) return null;

    // Check if pool is active
    if (state.status !== 1) {
      this.logger.debug('Raydium AMM pool not active', { poolAddress, status: state.status });
      return null;
    }

    // Calculate price
    const price = this.calculateAmmPrice(state);
    if (price === 0 || !Number.isFinite(price)) return null;

    // BUG FIX: Safely calculate inverse price to prevent Infinity
    const inversePrice = this.safeInversePrice(price);
    if (inversePrice === null) return null;

    return {
      poolAddress,
      dex: 'raydium-amm',
      token0: state.baseMint,
      token1: state.quoteMint,
      price,
      inversePrice,
      reserve0: state.baseReserve.toString(),
      reserve1: state.quoteReserve.toString(),
      slot,
      timestamp: Date.now()
    };
  }

  /**
   * Calculate price from AMM reserves.
   * Price = (quoteReserve / baseReserve) * 10^(baseDecimals - quoteDecimals)
   */
  calculateAmmPrice(state: RaydiumAmmPoolState): number {
    if (state.baseReserve === BigInt(0)) return 0;

    const rawPrice = Number(state.quoteReserve) / Number(state.baseReserve);
    const decimalAdjustment = Math.pow(10, state.baseDecimals - state.quoteDecimals);

    return rawPrice * decimalAdjustment;
  }

  // ===========================================================================
  // Raydium CLMM Parsing
  // ===========================================================================

  /**
   * Parse Raydium CLMM pool state from account data.
   */
  parseRaydiumClmmState(data: Buffer): RaydiumClmmPoolState | null {
    if (data.length < RAYDIUM_CLMM_LAYOUT.ACCOUNT_SIZE) {
      this.logger.warn('Invalid Raydium CLMM account size', {
        expected: RAYDIUM_CLMM_LAYOUT.ACCOUNT_SIZE,
        actual: data.length
      });
      return null;
    }

    try {
      const bump = data.readUInt8(RAYDIUM_CLMM_LAYOUT.BUMP);
      const mintDecimals0 = data.readUInt8(RAYDIUM_CLMM_LAYOUT.MINT_DECIMALS_0);
      const mintDecimals1 = data.readUInt8(RAYDIUM_CLMM_LAYOUT.MINT_DECIMALS_1);
      const tickSpacing = data.readUInt16LE(RAYDIUM_CLMM_LAYOUT.TICK_SPACING);

      // Read u128 values (16 bytes each)
      const liquidity = this.readU128LE(data, RAYDIUM_CLMM_LAYOUT.LIQUIDITY);
      const sqrtPriceX64 = this.readU128LE(data, RAYDIUM_CLMM_LAYOUT.SQRT_PRICE_X64);

      const tickCurrent = data.readInt32LE(RAYDIUM_CLMM_LAYOUT.TICK_CURRENT);

      const feeGrowthGlobal0X64 = this.readU128LE(data, RAYDIUM_CLMM_LAYOUT.FEE_GROWTH_GLOBAL_0_X64);
      const feeGrowthGlobal1X64 = this.readU128LE(data, RAYDIUM_CLMM_LAYOUT.FEE_GROWTH_GLOBAL_1_X64);

      const protocolFeesToken0 = data.readBigUInt64LE(RAYDIUM_CLMM_LAYOUT.PROTOCOL_FEES_TOKEN_0);
      const protocolFeesToken1 = data.readBigUInt64LE(RAYDIUM_CLMM_LAYOUT.PROTOCOL_FEES_TOKEN_1);

      const feeRate = data.readUInt32LE(RAYDIUM_CLMM_LAYOUT.FEE_RATE);
      const status = data.readUInt8(RAYDIUM_CLMM_LAYOUT.STATUS);

      // Read pubkeys
      const ammConfig = new PublicKey(data.subarray(
        RAYDIUM_CLMM_LAYOUT.AMM_CONFIG,
        RAYDIUM_CLMM_LAYOUT.AMM_CONFIG + 32
      )).toBase58();

      const poolCreator = new PublicKey(data.subarray(
        RAYDIUM_CLMM_LAYOUT.POOL_CREATOR,
        RAYDIUM_CLMM_LAYOUT.POOL_CREATOR + 32
      )).toBase58();

      const token0Mint = new PublicKey(data.subarray(
        RAYDIUM_CLMM_LAYOUT.TOKEN_0_MINT,
        RAYDIUM_CLMM_LAYOUT.TOKEN_0_MINT + 32
      )).toBase58();

      const token1Mint = new PublicKey(data.subarray(
        RAYDIUM_CLMM_LAYOUT.TOKEN_1_MINT,
        RAYDIUM_CLMM_LAYOUT.TOKEN_1_MINT + 32
      )).toBase58();

      const token0Vault = new PublicKey(data.subarray(
        RAYDIUM_CLMM_LAYOUT.TOKEN_0_VAULT,
        RAYDIUM_CLMM_LAYOUT.TOKEN_0_VAULT + 32
      )).toBase58();

      const token1Vault = new PublicKey(data.subarray(
        RAYDIUM_CLMM_LAYOUT.TOKEN_1_VAULT,
        RAYDIUM_CLMM_LAYOUT.TOKEN_1_VAULT + 32
      )).toBase58();

      const observationKey = new PublicKey(data.subarray(
        RAYDIUM_CLMM_LAYOUT.OBSERVATION_KEY,
        RAYDIUM_CLMM_LAYOUT.OBSERVATION_KEY + 32
      )).toBase58();

      return {
        bump,
        ammConfig,
        poolCreator,
        token0Mint,
        token1Mint,
        token0Vault,
        token1Vault,
        observationKey,
        mintDecimals0,
        mintDecimals1,
        tickSpacing,
        liquidity,
        sqrtPriceX64,
        tickCurrent,
        feeGrowthGlobal0X64,
        feeGrowthGlobal1X64,
        protocolFeesToken0,
        protocolFeesToken1,
        feeRate,
        status
      };
    } catch (error) {
      this.logger.error('Error parsing Raydium CLMM state', { error });
      return null;
    }
  }

  private parseRaydiumClmmUpdate(
    poolAddress: string,
    data: Buffer,
    slot: number,
    token0Decimals: number,
    token1Decimals: number
  ): SolanaPriceUpdate | null {
    const state = this.parseRaydiumClmmState(data);
    if (!state) return null;

    // BUG FIX: Check if pool is active (consistent with AMM status check)
    // Status 0 = uninitialized, 1 = active, other values = paused/disabled
    if (state.status !== 1) {
      this.logger.debug('Raydium CLMM pool not active', { poolAddress, status: state.status });
      return null;
    }

    // Use state decimals if available
    const decimals0 = state.mintDecimals0 || token0Decimals;
    const decimals1 = state.mintDecimals1 || token1Decimals;

    // Calculate price from sqrtPriceX64
    const price = this.calculateClmmPrice(state.sqrtPriceX64, decimals0, decimals1);
    if (price === 0 || !Number.isFinite(price)) return null;

    // BUG FIX: Safely calculate inverse price to prevent Infinity
    const inversePrice = this.safeInversePrice(price);
    if (inversePrice === null) return null;

    return {
      poolAddress,
      dex: 'raydium-clmm',
      token0: state.token0Mint,
      token1: state.token1Mint,
      price,
      inversePrice,
      reserve0: '0', // CLMM doesn't have traditional reserves
      reserve1: '0',
      slot,
      timestamp: Date.now(),
      sqrtPriceX64: state.sqrtPriceX64.toString(),
      liquidity: state.liquidity.toString(),
      tickCurrentIndex: state.tickCurrent
    };
  }

  /**
   * Calculate price from CLMM sqrtPriceX64.
   * Price = (sqrtPriceX64 / 2^64)^2 * 10^(token0Decimals - token1Decimals)
   */
  calculateClmmPrice(sqrtPriceX64: bigint, token0Decimals: number, token1Decimals: number): number {
    if (sqrtPriceX64 === BigInt(0)) return 0;

    // Convert to number and calculate
    // sqrtPrice = sqrtPriceX64 / 2^64
    const sqrtPrice = Number(sqrtPriceX64) / Math.pow(2, 64);

    // price = sqrtPrice^2
    const rawPrice = sqrtPrice * sqrtPrice;

    // Adjust for decimals
    const decimalAdjustment = Math.pow(10, token0Decimals - token1Decimals);

    return rawPrice * decimalAdjustment;
  }

  // ===========================================================================
  // Orca Whirlpool Parsing
  // ===========================================================================

  /**
   * Parse Orca Whirlpool state from account data.
   */
  parseOrcaWhirlpoolState(data: Buffer): OrcaWhirlpoolState | null {
    if (data.length < ORCA_WHIRLPOOL_LAYOUT.ACCOUNT_SIZE) {
      this.logger.warn('Invalid Orca Whirlpool account size', {
        expected: ORCA_WHIRLPOOL_LAYOUT.ACCOUNT_SIZE,
        actual: data.length
      });
      return null;
    }

    try {
      // Read and validate discriminator (first 8 bytes identify account type in Anchor programs)
      // Orca Whirlpool discriminator: hash of "account:Whirlpool" prefix
      const discriminator = data.subarray(0, 8);
      // Log discriminator for debugging (actual validation would require known expected value)
      this.logger.debug('Orca Whirlpool discriminator', {
        discriminator: discriminator.toString('hex')
      });

      const whirlpoolsConfig = new PublicKey(data.subarray(
        ORCA_WHIRLPOOL_LAYOUT.WHIRLPOOLS_CONFIG,
        ORCA_WHIRLPOOL_LAYOUT.WHIRLPOOLS_CONFIG + 32
      )).toBase58();

      const whirlpoolBump = [data.readUInt8(ORCA_WHIRLPOOL_LAYOUT.WHIRLPOOL_BUMP)];
      const tickSpacing = data.readUInt16LE(ORCA_WHIRLPOOL_LAYOUT.TICK_SPACING);
      const tickSpacingBump = data.readUInt8(ORCA_WHIRLPOOL_LAYOUT.TICK_SPACING_SEED);
      const feeRate = data.readUInt16LE(ORCA_WHIRLPOOL_LAYOUT.FEE_RATE);
      const protocolFeeRate = data.readUInt16LE(ORCA_WHIRLPOOL_LAYOUT.PROTOCOL_FEE_RATE);

      // Read u128 values
      const liquidity = this.readU128LE(data, ORCA_WHIRLPOOL_LAYOUT.LIQUIDITY);
      const sqrtPrice = this.readU128LE(data, ORCA_WHIRLPOOL_LAYOUT.SQRT_PRICE);

      const tickCurrentIndex = data.readInt32LE(ORCA_WHIRLPOOL_LAYOUT.TICK_CURRENT_INDEX);

      const protocolFeeOwedA = data.readBigUInt64LE(ORCA_WHIRLPOOL_LAYOUT.PROTOCOL_FEE_OWED_A);
      const protocolFeeOwedB = data.readBigUInt64LE(ORCA_WHIRLPOOL_LAYOUT.PROTOCOL_FEE_OWED_B);

      const tokenMintA = new PublicKey(data.subarray(
        ORCA_WHIRLPOOL_LAYOUT.TOKEN_MINT_A,
        ORCA_WHIRLPOOL_LAYOUT.TOKEN_MINT_A + 32
      )).toBase58();

      const tokenMintB = new PublicKey(data.subarray(
        ORCA_WHIRLPOOL_LAYOUT.TOKEN_MINT_B,
        ORCA_WHIRLPOOL_LAYOUT.TOKEN_MINT_B + 32
      )).toBase58();

      const tokenVaultA = new PublicKey(data.subarray(
        ORCA_WHIRLPOOL_LAYOUT.TOKEN_VAULT_A,
        ORCA_WHIRLPOOL_LAYOUT.TOKEN_VAULT_A + 32
      )).toBase58();

      const tokenVaultB = new PublicKey(data.subarray(
        ORCA_WHIRLPOOL_LAYOUT.TOKEN_VAULT_B,
        ORCA_WHIRLPOOL_LAYOUT.TOKEN_VAULT_B + 32
      )).toBase58();

      const feeGrowthGlobalA = this.readU128LE(data, ORCA_WHIRLPOOL_LAYOUT.FEE_GROWTH_GLOBAL_A);
      const feeGrowthGlobalB = this.readU128LE(data, ORCA_WHIRLPOOL_LAYOUT.FEE_GROWTH_GLOBAL_B);

      const rewardLastUpdatedTimestamp = data.readBigUInt64LE(
        ORCA_WHIRLPOOL_LAYOUT.REWARD_LAST_UPDATED_TIMESTAMP
      );

      return {
        whirlpoolsConfig,
        whirlpoolBump,
        tickSpacingBump,
        feeRate,
        protocolFeeRate,
        liquidity,
        sqrtPrice,
        tickCurrentIndex,
        protocolFeeOwedA,
        protocolFeeOwedB,
        tokenMintA,
        tokenMintB,
        tokenVaultA,
        tokenVaultB,
        feeGrowthGlobalA,
        feeGrowthGlobalB,
        rewardLastUpdatedTimestamp,
        tickSpacing
      };
    } catch (error) {
      this.logger.error('Error parsing Orca Whirlpool state', { error });
      return null;
    }
  }

  private parseOrcaWhirlpoolUpdate(
    poolAddress: string,
    data: Buffer,
    slot: number,
    token0Decimals: number,
    token1Decimals: number
  ): SolanaPriceUpdate | null {
    const state = this.parseOrcaWhirlpoolState(data);
    if (!state) return null;

    // Calculate price from sqrtPrice
    const price = this.calculateWhirlpoolPrice(state.sqrtPrice, token0Decimals, token1Decimals);
    if (price === 0 || !Number.isFinite(price)) return null;

    // BUG FIX: Safely calculate inverse price to prevent Infinity
    const inversePrice = this.safeInversePrice(price);
    if (inversePrice === null) return null;

    return {
      poolAddress,
      dex: 'orca-whirlpool',
      token0: state.tokenMintA,
      token1: state.tokenMintB,
      price,
      inversePrice,
      reserve0: '0', // Whirlpool doesn't have traditional reserves
      reserve1: '0',
      slot,
      timestamp: Date.now(),
      sqrtPriceX64: state.sqrtPrice.toString(),
      liquidity: state.liquidity.toString(),
      tickCurrentIndex: state.tickCurrentIndex
    };
  }

  /**
   * Calculate price from Whirlpool sqrtPrice.
   * Same formula as CLMM.
   */
  calculateWhirlpoolPrice(sqrtPrice: bigint, token0Decimals: number, token1Decimals: number): number {
    return this.calculateClmmPrice(sqrtPrice, token0Decimals, token1Decimals);
  }

  // ===========================================================================
  // Tick Conversion Utilities
  // ===========================================================================

  /**
   * Convert tick to price.
   * Price = 1.0001^tick * 10^(token0Decimals - token1Decimals)
   */
  tickToPrice(tick: number, token0Decimals: number, token1Decimals: number): number {
    const rawPrice = Math.pow(1.0001, tick);
    const decimalAdjustment = Math.pow(10, token0Decimals - token1Decimals);
    return rawPrice * decimalAdjustment;
  }

  /**
   * Convert price to tick.
   * Tick = log(price / 10^(token0Decimals - token1Decimals)) / log(1.0001)
   */
  priceToTick(price: number, token0Decimals: number, token1Decimals: number): number {
    const decimalAdjustment = Math.pow(10, token0Decimals - token1Decimals);
    const rawPrice = price / decimalAdjustment;
    return Math.round(Math.log(rawPrice) / Math.log(1.0001));
  }

  // ===========================================================================
  // Staleness Monitoring
  // ===========================================================================

  private startStalenessMonitoring(): void {
    // Run staleness check at the threshold interval (not faster)
    // This prevents redundant checks while still detecting stale prices promptly
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
   * Read a u128 (16-byte unsigned integer) from buffer.
   * Uses little-endian byte order.
   */
  private readU128LE(buffer: Buffer, offset: number): bigint {
    const low = buffer.readBigUInt64LE(offset);
    const high = buffer.readBigUInt64LE(offset + 8);
    return low + (high << BigInt(64));
  }

  /**
   * Safely calculate inverse price to prevent Infinity.
   * Returns null if the result would be Infinity or exceed safe bounds.
   *
   * BUG FIX: Prevents Infinity when price is extremely small (e.g., 1e-300)
   */
  private safeInversePrice(price: number): number | null {
    // Minimum price threshold to avoid Infinity in inverse
    // Number.MIN_VALUE is ~5e-324, so we use a reasonable floor
    const MIN_PRICE_THRESHOLD = 1e-15;

    if (price < MIN_PRICE_THRESHOLD) {
      this.logger.debug('Price too small for safe inverse calculation', { price });
      return null;
    }

    const inverse = 1 / price;

    // Double check the result is finite
    if (!Number.isFinite(inverse)) {
      this.logger.debug('Inverse price calculation resulted in non-finite value', { price, inverse });
      return null;
    }

    return inverse;
  }
}

export default SolanaPriceFeed;
