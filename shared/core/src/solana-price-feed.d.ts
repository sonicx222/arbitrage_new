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
import { Connection, Commitment } from '@solana/web3.js';
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
/**
 * Raydium AMM V4 account data layout offsets.
 */
export declare const RAYDIUM_AMM_LAYOUT: {
    readonly STATUS: 0;
    readonly NONCE: 1;
    readonly ORDER_NUM: 2;
    readonly DEPTH: 4;
    readonly BASE_DECIMALS: 6;
    readonly QUOTE_DECIMALS: 7;
    readonly STATE: 8;
    readonly RESET_FLAG: 9;
    readonly MIN_SIZE: 10;
    readonly VOL_MAX_CUT_RATIO: 18;
    readonly AMM_OPEN_ORDERS: 26;
    readonly LP_MINT: 58;
    readonly COIN_MINT: 90;
    readonly PC_MINT: 122;
    readonly COIN_VAULT: 154;
    readonly PC_VAULT: 186;
    readonly NEED_TAKE_COIN: 218;
    readonly NEED_TAKE_PC: 226;
    readonly TOTAL_COIN: 234;
    readonly TOTAL_PC: 242;
    readonly POOL_OPEN_TIME: 250;
    readonly PUNISH_PC_AMOUNT: 258;
    readonly PUNISH_COIN_AMOUNT: 266;
    readonly ORDERBOOK_TO_INIT_TIME: 274;
    readonly SWAP_COIN_IN_AMOUNT: 282;
    readonly SWAP_PC_OUT_AMOUNT: 290;
    readonly SWAP_COIN_2_PC_FEE: 298;
    readonly SWAP_PC_IN_AMOUNT: 306;
    readonly SWAP_COIN_OUT_AMOUNT: 314;
    readonly SWAP_PC_2_COIN_FEE: 322;
    readonly MARKET_ID: 330;
    readonly ACCOUNT_SIZE: 752;
};
/**
 * Raydium CLMM pool account data layout offsets.
 */
export declare const RAYDIUM_CLMM_LAYOUT: {
    readonly BUMP: 8;
    readonly AMM_CONFIG: 9;
    readonly POOL_CREATOR: 41;
    readonly TOKEN_0_MINT: 73;
    readonly TOKEN_1_MINT: 105;
    readonly TOKEN_0_VAULT: 137;
    readonly TOKEN_1_VAULT: 169;
    readonly OBSERVATION_KEY: 201;
    readonly MINT_DECIMALS_0: 233;
    readonly MINT_DECIMALS_1: 234;
    readonly TICK_SPACING: 235;
    readonly LIQUIDITY: 237;
    readonly SQRT_PRICE_X64: 253;
    readonly TICK_CURRENT: 269;
    readonly OBSERVATION_INDEX: 273;
    readonly OBSERVATION_UPDATE_DURATION: 275;
    readonly FEE_GROWTH_GLOBAL_0_X64: 277;
    readonly FEE_GROWTH_GLOBAL_1_X64: 293;
    readonly PROTOCOL_FEES_TOKEN_0: 309;
    readonly PROTOCOL_FEES_TOKEN_1: 317;
    readonly FEE_RATE: 325;
    readonly STATUS: 329;
    readonly ACCOUNT_SIZE: 1544;
};
/**
 * Orca Whirlpool account data layout offsets.
 * Based on Whirlpool program account structure.
 */
export declare const ORCA_WHIRLPOOL_LAYOUT: {
    readonly DISCRIMINATOR: 0;
    readonly WHIRLPOOLS_CONFIG: 8;
    readonly WHIRLPOOL_BUMP: 40;
    readonly TICK_SPACING: 41;
    readonly TICK_SPACING_SEED: 43;
    readonly FEE_RATE: 45;
    readonly PROTOCOL_FEE_RATE: 47;
    readonly LIQUIDITY: 49;
    readonly SQRT_PRICE: 65;
    readonly TICK_CURRENT_INDEX: 81;
    readonly PROTOCOL_FEE_OWED_A: 85;
    readonly PROTOCOL_FEE_OWED_B: 93;
    readonly TOKEN_MINT_A: 101;
    readonly TOKEN_MINT_B: 133;
    readonly TOKEN_VAULT_A: 165;
    readonly TOKEN_VAULT_B: 197;
    readonly FEE_GROWTH_GLOBAL_A: 229;
    readonly FEE_GROWTH_GLOBAL_B: 245;
    readonly REWARD_LAST_UPDATED_TIMESTAMP: 261;
    readonly REWARD_INFOS: 269;
    readonly ACCOUNT_SIZE: 653;
};
/**
 * Program IDs for supported DEXes.
 */
export declare const SOLANA_DEX_PROGRAMS: {
    readonly RAYDIUM_AMM: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
    readonly RAYDIUM_CLMM: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
    readonly ORCA_WHIRLPOOL: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
};
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
export declare class SolanaPriceFeed extends EventEmitter {
    private config;
    private logger;
    private connection;
    private subscriptions;
    private running;
    private stopping;
    private stalenessCheckInterval;
    private startPromise;
    private stopPromise;
    constructor(config: SolanaPriceFeedConfig, deps?: SolanaPriceFeedDeps);
    /**
     * Start the price feed.
     */
    start(): Promise<void>;
    private performStart;
    /**
     * Stop the price feed.
     */
    stop(): Promise<void>;
    private performStop;
    /**
     * Check if the price feed is running.
     */
    isRunning(): boolean;
    /**
     * Subscribe to price updates from a pool.
     * @param poolAddress Pool account address
     * @param dex DEX type (raydium-amm, raydium-clmm, orca-whirlpool)
     * @param token0Decimals Optional decimals for token 0 (fetched if not provided)
     * @param token1Decimals Optional decimals for token 1 (fetched if not provided)
     */
    subscribeToPool(poolAddress: string, dex: SupportedDex, token0Decimals?: number, token1Decimals?: number): Promise<void>;
    /**
     * Unsubscribe from a pool.
     * @param poolAddress Pool account address
     */
    unsubscribeFromPool(poolAddress: string): Promise<void>;
    /**
     * Get the number of active subscriptions.
     */
    getSubscriptionCount(): number;
    /**
     * Get list of subscribed pool addresses.
     */
    getSubscribedPools(): string[];
    private handleAccountUpdate;
    /**
     * Parse Raydium AMM pool state from account data.
     */
    parseRaydiumAmmState(data: Buffer): RaydiumAmmPoolState | null;
    private parseRaydiumAmmUpdate;
    /**
     * Calculate price from AMM reserves.
     * Price = (quoteReserve / baseReserve) * 10^(baseDecimals - quoteDecimals)
     */
    calculateAmmPrice(state: RaydiumAmmPoolState): number;
    /**
     * Parse Raydium CLMM pool state from account data.
     */
    parseRaydiumClmmState(data: Buffer): RaydiumClmmPoolState | null;
    private parseRaydiumClmmUpdate;
    /**
     * Calculate price from CLMM sqrtPriceX64.
     * Price = (sqrtPriceX64 / 2^64)^2 * 10^(token0Decimals - token1Decimals)
     */
    calculateClmmPrice(sqrtPriceX64: bigint, token0Decimals: number, token1Decimals: number): number;
    /**
     * Parse Orca Whirlpool state from account data.
     */
    parseOrcaWhirlpoolState(data: Buffer): OrcaWhirlpoolState | null;
    private parseOrcaWhirlpoolUpdate;
    /**
     * Calculate price from Whirlpool sqrtPrice.
     * Same formula as CLMM.
     */
    calculateWhirlpoolPrice(sqrtPrice: bigint, token0Decimals: number, token1Decimals: number): number;
    /**
     * Convert tick to price.
     * Price = 1.0001^tick * 10^(token0Decimals - token1Decimals)
     */
    tickToPrice(tick: number, token0Decimals: number, token1Decimals: number): number;
    /**
     * Convert price to tick.
     * Tick = log(price / 10^(token0Decimals - token1Decimals)) / log(1.0001)
     */
    priceToTick(price: number, token0Decimals: number, token1Decimals: number): number;
    private startStalenessMonitoring;
    private deriveWsUrl;
    private isValidSolanaAddress;
    /**
     * Read a u128 (16-byte unsigned integer) from buffer.
     * Uses little-endian byte order.
     */
    private readU128LE;
    /**
     * Safely calculate inverse price to prevent Infinity.
     * Returns null if the result would be Infinity or exceed safe bounds.
     *
     * BUG FIX: Prevents Infinity when price is extremely small (e.g., 1e-300)
     */
    private safeInversePrice;
}
export default SolanaPriceFeed;
//# sourceMappingURL=solana-price-feed.d.ts.map