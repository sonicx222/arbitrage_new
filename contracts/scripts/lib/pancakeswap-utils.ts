/**
 * PancakeSwap V3 Shared Utilities
 *
 * Shared constants, types, and functions used by both:
 * - deploy-pancakeswap.ts (deployment with optional pool whitelisting)
 * - discover-pancakeswap-pools.ts (standalone pool discovery)
 *
 * Eliminates duplication of FEE_TIERS, token pair definitions, and pool
 * discovery logic between the two scripts.
 *
 * @see contracts/scripts/deploy-pancakeswap.ts
 * @see contracts/scripts/discover-pancakeswap-pools.ts
 */

import { ethers } from 'hardhat';
import { CORE_TOKENS } from '@arbitrage/config';

// =============================================================================
// Types
// =============================================================================

/**
 * Token pair for pool discovery
 *
 * Uses `symbol` as the human-readable label (e.g., 'WETH/USDC').
 */
export interface TokenPair {
  tokenA: string;
  tokenB: string;
  symbol: string;
}

/**
 * PancakeSwap V3 fee tier with human-readable percentage
 */
export interface FeeTier {
  /** Fee tier value in hundredths of a bip (e.g., 2500 = 0.25%) */
  value: number;
  /** Human-readable percentage string (e.g., '0.25%') */
  percent: string;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * PancakeSwap V3 fee tiers (in hundredths of a bip)
 *
 * 100 = 0.01%, 500 = 0.05%, 2500 = 0.25%, 10000 = 1%
 *
 * Used by both deploy-pancakeswap.ts (pool whitelisting) and
 * discover-pancakeswap-pools.ts (pool discovery).
 */
export const FEE_TIERS: readonly FeeTier[] = [
  { value: 100, percent: '0.01%' },
  { value: 500, percent: '0.05%' },
  { value: 2500, percent: '0.25%' },
  { value: 10000, percent: '1%' },
] as const;

// =============================================================================
// Token Pair Generation
// =============================================================================

/**
 * Build common token pairs dynamically from CORE_TOKENS config
 *
 * Eliminates hardcoded token addresses in favor of importing from @arbitrage/config.
 * Maintains single source of truth for token addresses across the entire codebase.
 *
 * Strategy: Generate pairs for high-volume anchor tokens (native + stables)
 * - Native token (WETH, WBNB, etc.) paired with all stables
 * - Stable triangle: USDT/USDC, USDC/DAI, USDT/DAI
 * - Native token paired with major crypto assets (WBTC, etc.)
 *
 * @param networkName - Network name (e.g., 'bsc', 'ethereum', 'arbitrum')
 * @returns Array of token pairs for discovery
 */
export function getCommonTokenPairs(networkName: string): TokenPair[] {
  const tokens = CORE_TOKENS[networkName];
  if (!tokens || tokens.length === 0) {
    return [];
  }

  // Build lookup map for easy access
  const tokenMap = new Map(tokens.map(t => [t.symbol, t.address]));

  const pairs: TokenPair[] = [];

  // Helper to add pair if both tokens exist
  const addPair = (symbolA: string, symbolB: string) => {
    const addrA = tokenMap.get(symbolA);
    const addrB = tokenMap.get(symbolB);
    if (addrA && addrB) {
      pairs.push({
        tokenA: addrA,
        tokenB: addrB,
        symbol: `${symbolA}/${symbolB}`,
      });
    }
  };

  // Identify native token symbol by network
  const nativeSymbol = networkName === 'bsc' ? 'WBNB' :
                       networkName === 'polygon' ? 'WMATIC' :
                       'WETH'; // Ethereum, Arbitrum, Base, Optimism all use WETH

  // Native token paired with major stables
  addPair(nativeSymbol, 'USDT');
  addPair(nativeSymbol, 'USDC');
  addPair(nativeSymbol, 'DAI');

  // Stable triangle (high-volume arbitrage pairs)
  addPair('USDT', 'USDC');
  addPair('USDC', 'DAI');
  addPair('USDT', 'DAI');

  // Native token paired with major crypto assets
  addPair(nativeSymbol, 'WBTC');
  if (networkName === 'bsc') {
    addPair('WBNB', 'ETH');   // BSC has bridged ETH
    addPair('WBNB', 'BTCB');  // BSC uses BTCB instead of WBTC
  }

  return pairs;
}

// =============================================================================
// Pool Discovery
// =============================================================================

/**
 * Discovered pool result from factory query
 *
 * Basic result returned by discoverPools(). Callers that need additional
 * pool metadata (liquidity info, token0/token1) should query it separately.
 */
export interface DiscoveredPool {
  pool: string;
  pair: string;
  feeTier: number;
  feePercent: string;
}

/**
 * Options for pool discovery
 */
export interface DiscoverPoolsOptions {
  /** Whether to check pool liquidity (requires additional RPC calls). Default: false */
  checkLiquidity?: boolean;
  /** Custom logging prefix. Default: '' */
  logPrefix?: string;
}

/**
 * Discover PancakeSwap V3 pools from factory for given token pairs
 *
 * Uses parallel RPC calls (Promise.all) for 2-3x speedup over sequential
 * discovery. Actual speedup depends on RPC provider rate limits.
 *
 * @param factoryAddress - PancakeSwap V3 Factory contract address
 * @param tokenPairs - Array of token pairs to search
 * @param options - Discovery options (liquidity checking, logging)
 * @returns Array of discovered pools with addresses and fee tiers
 */
export async function discoverPools(
  factoryAddress: string,
  tokenPairs: TokenPair[],
  options: DiscoverPoolsOptions = {}
): Promise<DiscoveredPool[]> {
  const { logPrefix = '' } = options;

  const factoryAbi = [
    'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
  ];
  const factory = await ethers.getContractAt(factoryAbi, factoryAddress);

  console.log(`${logPrefix}\nDiscovering PancakeSwap V3 pools (${tokenPairs.length} pairs x ${FEE_TIERS.length} fee tiers)...`);

  // Create all discovery promises upfront for parallel execution
  const discoveryPromises = tokenPairs.flatMap((pair) =>
    FEE_TIERS.map(async (tier): Promise<DiscoveredPool | null> => {
      try {
        const poolAddress = await factory.getPool(pair.tokenA, pair.tokenB, tier.value);
        if (poolAddress && poolAddress !== ethers.ZeroAddress) {
          return {
            pool: poolAddress,
            pair: pair.symbol,
            feeTier: tier.value,
            feePercent: tier.percent,
          };
        }
      } catch {
        // Pool doesn't exist for this fee tier -- expected
      }
      return null;
    })
  );

  const startTime = Date.now();
  const results = await Promise.all(discoveryPromises);
  const elapsedMs = Date.now() - startTime;

  const discoveredPools = results.filter(
    (pool): pool is DiscoveredPool => pool !== null
  );

  // Log discovered pools grouped by pair
  for (const pair of tokenPairs) {
    const pools = discoveredPools.filter(p => p.pair === pair.symbol);
    if (pools.length > 0) {
      for (const pool of pools) {
        console.log(`  ${pool.pair}: ${pool.pool} (fee: ${pool.feePercent})`);
      }
    }
  }

  console.log(`\nDiscovered ${discoveredPools.length} pools in ${elapsedMs}ms (parallel RPC)`);
  return discoveredPools;
}
