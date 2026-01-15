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

// =============================================================================
// Core Types
// =============================================================================

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
export type PoolType =
  | 'weighted'           // Balancer weighted pools
  | 'stable'             // Balancer stable pools, Platypus
  | 'composable_stable'  // Balancer composable stable pools
  | 'linear'             // Balancer linear pools
  | 'gmx_spot'           // GMX spot trading
  | 'constant_product'   // Uniswap V2 style
  | 'concentrated';      // Uniswap V3 style

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

// =============================================================================
// Discovery Types
// =============================================================================

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

// =============================================================================
// Adapter Interface
// =============================================================================

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
  getSwapQuote?(
    poolId: string,
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint
  ): Promise<SwapQuote | null>;

  /**
   * Check if adapter is healthy (contracts reachable)
   */
  isHealthy(): Promise<boolean>;

  /**
   * Cleanup resources
   */
  destroy(): Promise<void>;
}

// =============================================================================
// Adapter Registry Types
// =============================================================================

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

// =============================================================================
// Constants
// =============================================================================

/**
 * Balancer V2 Vault addresses by chain
 */
export const BALANCER_VAULT_ADDRESSES: Record<string, string> = {
  arbitrum: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  ethereum: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  polygon: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  optimism: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  base: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  // Beethoven X on Fantom uses same interface
  fantom: '0x20dd72Ed959b6147912C2e529F0a0C651c33c9ce',
};

/**
 * GMX contract addresses by chain
 */
export const GMX_ADDRESSES: Record<string, { vault: string; reader: string }> = {
  avalanche: {
    vault: '0x9ab2De34A33fB459b538c43f251eB825645e8595',
    reader: '0x67b789D48c926006F5132BFCe4e976F0A7A63d5D',
  },
  arbitrum: {
    vault: '0x489ee077994B6658eAfA855C308275EAd8097C4A',
    reader: '0x22199a49A999c351eF7927602CFB187ec3cae489',
  },
};

/**
 * Platypus contract addresses by chain
 */
export const PLATYPUS_ADDRESSES: Record<string, { pool: string; router: string }> = {
  avalanche: {
    pool: '0x66357dCaCe80431aee0A7507e2E361B7e2402370',
    router: '0x73256EC7575D999C360c1EeC118ECbEFd8DA7D12',
  },
};

/**
 * Subgraph URLs for pool discovery
 */
export const SUBGRAPH_URLS: Record<string, string> = {
  'balancer_v2:arbitrum': 'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-arbitrum-v2',
  'balancer_v2:ethereum': 'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-v2',
  'balancer_v2:polygon': 'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-polygon-v2',
  'beethoven_x:fantom': 'https://api.thegraph.com/subgraphs/name/beethovenxfi/beethovenx',
};

// =============================================================================
// ABIs
// =============================================================================

/**
 * Balancer V2 Vault ABI (minimal for our needs)
 */
export const BALANCER_VAULT_ABI = [
  'function getPoolTokens(bytes32 poolId) external view returns (address[] memory tokens, uint256[] memory balances, uint256 lastChangeBlock)',
  'function getPool(bytes32 poolId) external view returns (address, uint8)',
];

/**
 * GMX Vault ABI (minimal for our needs)
 */
export const GMX_VAULT_ABI = [
  'function whitelistedTokens(uint256 index) external view returns (address)',
  'function whitelistedTokenCount() external view returns (uint256)',
  'function getMinPrice(address token) external view returns (uint256)',
  'function getMaxPrice(address token) external view returns (uint256)',
  'function poolAmounts(address token) external view returns (uint256)',
  'function usdgAmounts(address token) external view returns (uint256)',
  'function getRedemptionAmount(address token, uint256 usdgAmount) external view returns (uint256)',
];

/**
 * GMX Reader ABI
 */
export const GMX_READER_ABI = [
  'function getAmountOut(address vault, address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256, uint256)',
];

/**
 * Platypus Pool ABI
 */
export const PLATYPUS_POOL_ABI = [
  'function getAssetOf(address token) external view returns (address)',
  'function getTokenAddresses() external view returns (address[] memory)',
  'function getCash(address token) external view returns (uint256)',
  'function getLiability(address token) external view returns (uint256)',
  'function quotePotentialSwap(address fromToken, address toToken, uint256 fromAmount) external view returns (uint256 potentialOutcome, uint256 haircut)',
];

// =============================================================================
// Utility Types
// =============================================================================

/**
 * Result type for adapter operations
 */
export type AdapterResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

/**
 * Helper to create success result
 */
export function success<T>(data: T): AdapterResult<T> {
  return { success: true, data };
}

/**
 * Helper to create failure result
 */
export function failure<T>(error: string): AdapterResult<T> {
  return { success: false, error };
}
