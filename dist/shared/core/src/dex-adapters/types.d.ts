/**
 * DEX Adapter Types
 *
 * Interfaces for vault-model and pool-model DEX adapters.
 * These adapters enable interaction with DEXes that don't follow
 * the standard factory pattern (getPair/getPool).
 *
 * Supported DEX patterns:
 * - Balancer V2 / Beethoven X: Vault model with poolIds
 * - GMX: Single vault with token whitelist
 * - Platypus: Pool model for stablecoins
 *
 * @see ADR-003: Partitioned Detector Strategy
 */
import { ethers } from 'ethers';
/**
 * Adapter type classification
 * - 'vault': Balancer V2, Beethoven X, GMX (shared liquidity vault)
 * - 'pool': Platypus (individual asset pools)
 * - 'factory': Standard AMM (Uniswap V2/V3 style) - handled by PairDiscoveryService
 */
export type AdapterType = 'vault' | 'pool' | 'factory';
/**
 * Pool type classification for different AMM models
 */
export type PoolType = 'weighted' | 'stable' | 'composable_stable' | 'linear' | 'gmx_spot' | 'constant_product' | 'concentrated';
/**
 * Configuration for initializing a DEX adapter
 */
export interface AdapterConfig {
    /** DEX name (e.g., 'balancer_v2', 'gmx', 'platypus') */
    name: string;
    /** Chain identifier */
    chain: string;
    /** Primary contract address (Vault for Balancer/GMX, Pool for Platypus) */
    primaryAddress: string;
    /** Optional secondary contract (Reader for GMX, Router for Platypus) */
    secondaryAddress?: string;
    /** Ethers provider for contract calls */
    provider: ethers.JsonRpcProvider;
    /** Optional subgraph URL for pool discovery */
    subgraphUrl?: string;
}
/**
 * Discovered pool from a vault-model DEX
 */
export interface DiscoveredPool {
    /** Unique pool identifier (bytes32 for Balancer, address for GMX) */
    poolId: string;
    /** Pool contract address */
    address: string;
    /** Token addresses in the pool */
    tokens: string[];
    /** Current token balances (as bigint for precision) */
    balances: bigint[];
    /** Swap fee in basis points (e.g., 30 = 0.30%) */
    swapFee: number;
    /** Pool type classification */
    poolType: PoolType;
    /** DEX name */
    dex: string;
    /** Chain identifier */
    chain: string;
    /** Block number when balances were fetched */
    lastUpdateBlock?: number;
    /** Timestamp of discovery/update */
    discoveredAt: number;
}
/**
 * Pool reserves for arbitrage calculation
 */
export interface PoolReserves {
    /** Pool identifier */
    poolId: string;
    /** Token addresses in order */
    tokens: string[];
    /** Token balances in same order as tokens */
    balances: bigint[];
    /** Block number of this snapshot */
    blockNumber: number;
    /** Timestamp of fetch */
    timestamp: number;
}
/**
 * Swap quote result
 */
export interface SwapQuote {
    /** Expected output amount */
    amountOut: bigint;
    /** Price impact as decimal (0.01 = 1%) */
    priceImpact: number;
    /** Fee amount in tokenIn */
    feeAmount: bigint;
    /** Effective price (amountOut / amountIn) */
    effectivePrice: number;
}
/**
 * Base interface for all DEX adapters
 *
 * Implementations:
 * - BalancerV2Adapter: Balancer V2 Vault and Beethoven X
 * - GmxAdapter: GMX spot trading
 * - PlatypusAdapter: Platypus stablecoin pools
 */
export interface DexAdapter {
    /** DEX name */
    readonly name: string;
    /** Chain identifier */
    readonly chain: string;
    /** Adapter type */
    readonly type: AdapterType;
    /** Primary contract address */
    readonly primaryAddress: string;
    /**
     * Initialize the adapter (connect contracts, load initial data)
     */
    initialize(): Promise<void>;
    /**
     * Discover all pools containing both tokens
     *
     * @param tokenA - First token address
     * @param tokenB - Second token address
     * @returns Array of discovered pools, empty if none found
     */
    discoverPools(tokenA: string, tokenB: string): Promise<DiscoveredPool[]>;
    /**
     * Get current reserves/balances for a pool
     *
     * @param poolId - Pool identifier
     * @returns Pool reserves or null if pool not found
     */
    getPoolReserves(poolId: string): Promise<PoolReserves | null>;
    /**
     * Get swap quote (optional - not all adapters support this)
     *
     * @param poolId - Pool identifier
     * @param tokenIn - Input token address
     * @param tokenOut - Output token address
     * @param amountIn - Input amount
     * @returns Swap quote or null if not supported
     */
    getSwapQuote?(poolId: string, tokenIn: string, tokenOut: string, amountIn: bigint): Promise<SwapQuote | null>;
    /**
     * Check if adapter is healthy (contracts reachable)
     */
    isHealthy(): Promise<boolean>;
    /**
     * Cleanup resources
     */
    destroy(): Promise<void>;
}
/**
 * Key for adapter lookup (dex:chain)
 */
export type AdapterKey = `${string}:${string}`;
/**
 * Factory function type for creating adapters
 */
export type AdapterFactory = (config: AdapterConfig) => DexAdapter;
/**
 * Registry entry for an adapter
 */
export interface AdapterRegistryEntry {
    /** DEX name */
    name: string;
    /** Supported chains */
    chains: string[];
    /** Adapter type */
    type: AdapterType;
    /** Factory function */
    factory: AdapterFactory;
}
/**
 * Balancer V2 Vault addresses by chain
 */
export declare const BALANCER_VAULT_ADDRESSES: Record<string, string>;
/**
 * GMX contract addresses by chain
 */
export declare const GMX_ADDRESSES: Record<string, {
    vault: string;
    reader: string;
}>;
/**
 * Platypus contract addresses by chain
 */
export declare const PLATYPUS_ADDRESSES: Record<string, {
    pool: string;
    router: string;
}>;
/**
 * Subgraph URLs for pool discovery
 */
export declare const SUBGRAPH_URLS: Record<string, string>;
/**
 * Balancer V2 Vault ABI (minimal for our needs)
 */
export declare const BALANCER_VAULT_ABI: string[];
/**
 * GMX Vault ABI (minimal for our needs)
 */
export declare const GMX_VAULT_ABI: string[];
/**
 * GMX Reader ABI
 */
export declare const GMX_READER_ABI: string[];
/**
 * Platypus Pool ABI
 */
export declare const PLATYPUS_POOL_ABI: string[];
/**
 * Result type for adapter operations
 */
export type AdapterResult<T> = {
    success: true;
    data: T;
} | {
    success: false;
    error: string;
};
/**
 * Helper to create success result
 */
export declare function success<T>(data: T): AdapterResult<T>;
/**
 * Helper to create failure result
 */
export declare function failure<T>(error: string): AdapterResult<T>;
//# sourceMappingURL=types.d.ts.map