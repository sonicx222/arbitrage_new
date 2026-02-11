/**
 * PancakeSwap V3 Pool Discovery Script
 *
 * Task 2.1 (C4): Helper script to discover common pools from PancakeSwap V3 factories.
 * Useful for:
 * - Finding pool addresses to whitelist
 * - Checking pool liquidity before deployment
 * - Discovering new pools for existing deployments
 *
 * Usage:
 *   npx hardhat run scripts/discover-pancakeswap-pools.ts --network bsc
 *   npx hardhat run scripts/discover-pancakeswap-pools.ts --network arbitrum
 *
 * Output:
 *   - Prints discovered pools to console
 *   - Optionally saves to JSON file for batch whitelisting
 *
 * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Phase 2 Task 2.1
 */

import { ethers, network } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';
import { PANCAKESWAP_V3_FACTORIES, CORE_TOKENS } from '@arbitrage/config';  // P2-002 FIX: Import token addresses
import { normalizeNetworkName, getSafeChainId } from './lib/deployment-utils';  // P1-007 FIX: Import safe chain ID getter

// =============================================================================
// Configuration
// =============================================================================

/**
 * PancakeSwap V3 Factory addresses by chain
 * Imported from @arbitrage/config (single source of truth)
 */
const PANCAKESWAP_V3_FACTORY_ADDRESSES = PANCAKESWAP_V3_FACTORIES;

/**
 * P2-002 FIX: Build common token pairs dynamically from CORE_TOKENS
 *
 * This eliminates hardcoded token addresses in favor of importing from @arbitrage/config.
 * Maintains single source of truth for token addresses across the entire codebase.
 *
 * Strategy: Generate pairs for high-volume anchor tokens (native + stables)
 * - Native token (WETH, WBNB, etc.) paired with all stables
 * - Stable triangle: USDT/USDC, USDC/DAI
 *
 * @param networkName - Network name (e.g., 'bsc', 'ethereum', 'arbitrum')
 * @returns Array of token pairs for discovery
 */
function getCommonTokenPairs(
  networkName: string
): Array<{ tokenA: string; tokenB: string; symbol: string }> {
  const tokens = CORE_TOKENS[networkName];
  if (!tokens || tokens.length === 0) {
    return [];
  }

  // Build lookup map for easy access
  const tokenMap = new Map(tokens.map(t => [t.symbol, t.address]));

  const pairs: Array<{ tokenA: string; tokenB: string; symbol: string }> = [];

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

/**
 * PancakeSwap V3 fee tiers (in hundredths of a bip)
 */
const FEE_TIERS = [
  { value: 100, percent: '0.01%' },
  { value: 500, percent: '0.05%' },
  { value: 2500, percent: '0.25%' },
  { value: 10000, percent: '1%' },
] as const;

// =============================================================================
// Types
// =============================================================================

interface DiscoveredPool {
  pool: string;
  tokenA: string;
  tokenB: string;
  pair: string;
  feeTier: number;
  feePercent: string;
  token0?: string;
  token1?: string;
}

interface PoolDiscoveryResult {
  network: string;
  chainId: number;
  factoryAddress: string;
  timestamp: string;
  pools: DiscoveredPool[];
  totalPools: number;
  pairCount: number;
}

// =============================================================================
// Discovery Functions
// =============================================================================

/**
 * Get pool liquidity (token0 and token1 reserves)
 */
async function getPoolLiquidity(poolAddress: string): Promise<{
  token0: string;
  token1: string;
  hasLiquidity: boolean;
} | null> {
  try {
    const poolAbi = [
      'function token0() external view returns (address)',
      'function token1() external view returns (address)',
      'function liquidity() external view returns (uint128)',
    ];
    const pool = await ethers.getContractAt(poolAbi, poolAddress);

    const [token0, token1, liquidity] = await Promise.all([
      pool.token0(),
      pool.token1(),
      pool.liquidity(),
    ]);

    return {
      token0,
      token1,
      hasLiquidity: liquidity > 0n,
    };
  } catch (error) {
    // Distinguish between expected errors (pool doesn't exist) and RPC failures
    const errorMsg = error instanceof Error ? error.message : String(error);

    // Log RPC errors for debugging (helps identify rate limits or connectivity issues)
    if (errorMsg.toLowerCase().includes('rate limit') ||
        errorMsg.toLowerCase().includes('timeout') ||
        errorMsg.toLowerCase().includes('network') ||
        errorMsg.toLowerCase().includes('econnrefused')) {
      console.warn(`⚠️  RPC error for pool ${poolAddress}: ${errorMsg.slice(0, 100)}`);
    }

    // Return null for all errors (both "pool doesn't exist" and RPC failures)
    // This allows discovery to continue even if some pools fail
    return null;
  }
}

/**
 * Discover all pools for token pairs
 *
 * Phase 3 Optimization: Parallelized pool discovery using Promise.all()
 *
 * P1-005 FIX: Updated performance claims to be realistic
 * Performance: Concurrent RPC calls provide 2-3x speedup over serial discovery
 * (actual speedup depends on RPC provider rate limits and connection pooling)
 *
 * Note: Earlier claims of 10x speedup were overly optimistic. Most public RPCs
 * (Infura, Alchemy, QuickNode) rate-limit to 10-30 req/sec, and ethers.js uses
 * connection pooling (4-6 concurrent requests). Real-world speedup is 2-3x, not 10x.
 */
async function discoverPools(
  factoryAddress: string,
  tokenPairs: Array<{ tokenA: string; tokenB: string; symbol: string }>
): Promise<DiscoveredPool[]> {
  const factoryAbi = [
    'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
  ];
  const factory = await ethers.getContractAt(factoryAbi, factoryAddress);

  console.log('\n🔍 Discovering PancakeSwap V3 pools...\n');
  console.log(`   Searching ${tokenPairs.length} pairs × ${FEE_TIERS.length} fee tiers = ${tokenPairs.length * FEE_TIERS.length} combinations\n`);

  // Phase 3 Optimization: Create all discovery promises upfront for parallel execution
  const discoveryPromises = tokenPairs.flatMap((pair) =>
    FEE_TIERS.map(async (tier): Promise<DiscoveredPool | null> => {
      try {
        // Query pool address from factory
        const poolAddress = await factory.getPool(pair.tokenA, pair.tokenB, tier.value);

        if (poolAddress && poolAddress !== ethers.ZeroAddress) {
          // Get pool liquidity info
          const poolInfo = await getPoolLiquidity(poolAddress);

          if (poolInfo) {
            return {
              pool: poolAddress,
              tokenA: pair.tokenA,
              tokenB: pair.tokenB,
              pair: pair.symbol,
              feeTier: tier.value,
              feePercent: tier.percent,
              token0: poolInfo.token0,
              token1: poolInfo.token1,
            };
          }
        }
      } catch {
        // Pool doesn't exist for this fee tier - this is normal
        return null;
      }
      return null;
    })
  );

  // Execute all queries in parallel
  const startTime = Date.now();
  const results = await Promise.all(discoveryPromises);
  const elapsedMs = Date.now() - startTime;

  // Filter out null results and group by pair for display
  // Type guard: filter removes null, resulting array contains only DiscoveredPool
  const discoveredPools: DiscoveredPool[] = results.filter((pool): pool is DiscoveredPool => pool !== null);

  console.log(`⚡ Discovery completed in ${elapsedMs}ms (parallel RPC calls)\n`);

  // Print results grouped by pair for readability
  const poolsByPair = new Map<string, DiscoveredPool[]>();
  for (const pool of discoveredPools) {
    const existing = poolsByPair.get(pool.pair) || [];
    existing.push(pool);
    poolsByPair.set(pool.pair, existing);
  }

  for (const pair of tokenPairs) {
    const pools = poolsByPair.get(pair.symbol);
    console.log(`  ${pair.symbol}:`);

    if (pools && pools.length > 0) {
      for (const pool of pools) {
        console.log(`    ${pool.feePercent}: ${pool.pool} ✅`);
      }
    } else {
      console.log(`    ❌ No pools found`);
    }
  }

  return discoveredPools;
}

/**
 * Save discovery results to file
 */
function saveDiscoveryResult(result: PoolDiscoveryResult): void {
  const outputDir = path.join(__dirname, '..', 'deployments', 'pool-discovery');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const outputFile = path.join(outputDir, `${result.network}-pools.json`);
  fs.writeFileSync(outputFile, JSON.stringify(result, null, 2));
  console.log(`\n📝 Pool discovery saved to: ${outputFile}`);

  // Create a simple pool addresses file for easy batch whitelisting
  const addressesFile = path.join(outputDir, `${result.network}-pool-addresses.json`);
  const addresses = result.pools.map((p) => p.pool);
  fs.writeFileSync(addressesFile, JSON.stringify(addresses, null, 2));
  console.log(`📝 Pool addresses saved to: ${addressesFile}`);
}

/**
 * Print discovery summary
 */
function printDiscoverySummary(result: PoolDiscoveryResult): void {
  console.log('\n========================================');
  console.log('Pool Discovery Summary');
  console.log('========================================');
  console.log(`Network:       ${result.network} (${result.chainId})`);
  console.log(`Factory:       ${result.factoryAddress}`);
  console.log(`Timestamp:     ${result.timestamp}`);
  console.log(`Total Pools:   ${result.totalPools}`);
  console.log(`Token Pairs:   ${result.pairCount}`);
  console.log('========================================');

  // Group by pair for readability
  const poolsByPair = new Map<string, DiscoveredPool[]>();
  for (const pool of result.pools) {
    const existing = poolsByPair.get(pool.pair) || [];
    existing.push(pool);
    poolsByPair.set(pool.pair, existing);
  }

  console.log('\nPools by Pair:');
  for (const [pair, pools] of poolsByPair.entries()) {
    console.log(`\n  ${pair} (${pools.length} pools):`);
    for (const pool of pools) {
      console.log(`    - ${pool.feePercent}: ${pool.pool}`);
    }
  }

  console.log('\n========================================\n');
}

// =============================================================================
// Main Entry Point
// =============================================================================

async function main(): Promise<void> {
  // Normalize network name for consistent handling (zksync-mainnet → zksync, etc.)
  const networkName = normalizeNetworkName(network.name);
  // P1-007 FIX: Use safe chain ID getter with validation
  const chainId = await getSafeChainId();

  // Get Factory address for the network
  const factoryAddress = PANCAKESWAP_V3_FACTORY_ADDRESSES[networkName];
  if (!factoryAddress) {
    throw new Error(
      `PancakeSwap V3 Factory address not configured for network: ${networkName}\n` +
        `Supported networks: ${Object.keys(PANCAKESWAP_V3_FACTORY_ADDRESSES).join(', ')}`
    );
  }

  // P2-002 FIX: Get token pairs dynamically from CORE_TOKENS config
  const tokenPairs = getCommonTokenPairs(networkName);
  if (tokenPairs.length === 0) {
    throw new Error(
      `No token pairs configured for network: ${networkName}\n` +
        `This means CORE_TOKENS is not configured for this network in @arbitrage/config.\n` +
        `Supported networks: ${Object.keys(CORE_TOKENS).join(', ')}`
    );
  }

  console.log('========================================');
  console.log('PancakeSwap V3 Pool Discovery');
  console.log('========================================');
  console.log(`Network:  ${networkName} (chainId: ${chainId})`);
  console.log(`Factory:  ${factoryAddress}`);
  console.log(`Pairs:    ${tokenPairs.length}`);

  // Discover pools
  const discoveredPools = await discoverPools(factoryAddress, tokenPairs);

  // Build result
  const result: PoolDiscoveryResult = {
    network: networkName,
    chainId,
    factoryAddress,
    timestamp: new Date().toISOString(),
    pools: discoveredPools,
    totalPools: discoveredPools.length,
    pairCount: new Set(discoveredPools.map((p) => p.pair)).size,
  };

  // Save and print summary
  saveDiscoveryResult(result);
  printDiscoverySummary(result);

  console.log('🎉 Pool discovery complete!');
  console.log('\n💡 Next steps:');
  console.log('   1. Review discovered pools');
  console.log('   2. Use pool addresses file for batch whitelisting');
  console.log('   3. Or deploy with --whitelist-pools flag to auto-whitelist\n');
}

// Run the discovery
main().catch((error) => {
  console.error('Pool discovery failed:', error);
  process.exit(1);
});
