/**
 * Testnet Execution Resolver
 *
 * When TESTNET_EXECUTION_MODE=true, maps mainnet identifiers used by the
 * price simulator to testnet equivalents used by the execution engine:
 * - Token addresses (mainnet WETH -> testnet WETH)
 * - Router addresses (mainnet Uniswap -> testnet Uniswap)
 * - Contract addresses (mainnet deployment -> testnet deployment)
 * - Chain name metadata (testnet chain names added as _testnet* fields)
 *
 * ## Dual-Name Architecture (C-01 Fix)
 *
 * Chain names in the opportunity (`buyChain`, `sellChain`, `chain`) are preserved
 * as mainnet names so all downstream infrastructure lookups work (providers, wallets,
 * CHAINS config, DEX config). Testnet chain names are added as metadata fields
 * (`_testnetBuyChain`, `_testnetSellChain`, `_testnetChain`) for strategies that
 * need the actual testnet network name (e.g., contract lookups, logging).
 *
 * All mappings are derived from contracts/deployments/addresses.ts (single
 * source of truth for deployed addresses).
 *
 * @see docs/reports/TESTNET_EXECUTION_ANALYSIS_2026-03-08.md
 */

import type { ArbitrageOpportunity } from '@arbitrage/types';

// =============================================================================
// Chain Name Resolution (Step 4)
// =============================================================================

/**
 * Mainnet chain name -> testnet chain name mapping.
 *
 * Only chains with testnet contract deployments or RPC endpoints are included.
 * Chains without testnet infrastructure (bsc, polygon, avalanche, fantom, etc.)
 * are intentionally omitted — opportunities for those chains will be skipped.
 */
const MAINNET_TO_TESTNET_CHAIN: Readonly<Record<string, string>> = {
  ethereum: 'sepolia',
  arbitrum: 'arbitrumSepolia',
  base: 'baseSepolia',
  zksync: 'zksync-testnet',
};

/** Reverse mapping: testnet -> mainnet (for diagnostics) */
const TESTNET_TO_MAINNET_CHAIN: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(MAINNET_TO_TESTNET_CHAIN).map(([k, v]) => [v, k])
);

/** Set of supported testnet chains for fast membership check */
const SUPPORTED_TESTNET_CHAINS = new Set(Object.values(MAINNET_TO_TESTNET_CHAIN));

/**
 * Resolve a mainnet chain name to its testnet equivalent.
 * Returns the original chain name if not in testnet mode or no mapping exists.
 */
export function resolveTestnetChain(chain: string): string {
  return MAINNET_TO_TESTNET_CHAIN[chain] ?? chain;
}

/**
 * Check if a mainnet chain has testnet support.
 */
export function hasTestnetSupport(mainnetChain: string): boolean {
  return mainnetChain in MAINNET_TO_TESTNET_CHAIN;
}

/**
 * Check if a chain name is a known testnet.
 */
export function isKnownTestnet(chain: string): boolean {
  return SUPPORTED_TESTNET_CHAINS.has(chain);
}

/**
 * Get the mainnet equivalent for a testnet chain (for logging/diagnostics).
 */
export function getMainnetEquivalent(testnetChain: string): string | undefined {
  return TESTNET_TO_MAINNET_CHAIN[testnetChain];
}

// =============================================================================
// Token Address Resolution (Step 5)
// =============================================================================

/**
 * Mainnet token address -> testnet token address mapping, keyed by mainnet chain.
 *
 * Addresses sourced from contracts/deployments/addresses.ts TOKEN_ADDRESSES.
 * Keys are lowercase for case-insensitive lookup.
 */
const TOKEN_ADDRESS_MAP: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  ethereum: {
    // WETH
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
    // USDC
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': '0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8',
    // USDT
    '0xdac17f958d2ee523a2206206994597c13d831ec7': '0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8', // Map to USDC (no testnet USDT)
    // DAI
    '0x6b175474e89094c44da98b954eedeac495271d0f': '0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357',
  },
  arbitrum: {
    // WETH
    '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73',
    // USDC
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831': '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    // USDT
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', // Map to USDC
  },
  base: {
    // WETH (same canonical predeploy on testnet)
    '0x4200000000000000000000000000000000000006': '0x4200000000000000000000000000000000000006',
    // USDC
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  },
  zksync: {
    // WETH
    '0x5aea5775959fbc2557cc8789bc1bf90a239d9a91': '0x701f3B10b5Cc30CA731fb97459175f45E0ac1247',
    // USDC
    '0x3355df6d4c9c3035724fd0e3914de96a5a83aaf4': '0xAe045DE5638162fa134807Cb558E15A3F5A7F853',
  },
};

/**
 * Resolve a mainnet token address to its testnet equivalent.
 *
 * @param mainnetChain - The mainnet chain name (e.g. 'ethereum')
 * @param tokenAddress - The mainnet token address
 * @returns Testnet token address, or the original if no mapping exists
 */
export function resolveTestnetTokenAddress(mainnetChain: string, tokenAddress: string): string {
  const chainMap = TOKEN_ADDRESS_MAP[mainnetChain];
  if (!chainMap) return tokenAddress;
  return chainMap[tokenAddress.toLowerCase()] ?? tokenAddress;
}

// =============================================================================
// Router Address Resolution (Step 6)
// =============================================================================

/**
 * Testnet router addresses keyed by testnet chain name.
 * First entry is the default/primary router for each chain.
 *
 * Sourced from APPROVED_ROUTERS in contracts/deployments/addresses.ts.
 */
const TESTNET_ROUTERS: Readonly<Record<string, readonly string[]>> = {
  sepolia: [
    '0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008', // Uniswap V2 Router
  ],
  arbitrumSepolia: [
    '0x101F443B4d1b059569D643917553c771E1b9663E', // Uniswap V2 Router
    '0x1A9838ce19Ae905B4e5941a17891ba180F30F630', // Uniswap V3 Adapter
  ],
  baseSepolia: [
    '0x1689E7B1F10000AE47eBfE339a4f69dECd19F602', // Uniswap V2 Router02
  ],
  'zksync-testnet': [
    '0x3f39129e54d2331926c1E4bf034e111cf471AA97', // SyncSwap Router
  ],
};

/**
 * Get the primary testnet router address for a testnet chain.
 */
export function getTestnetRouter(testnetChain: string): string | undefined {
  return TESTNET_ROUTERS[testnetChain]?.[0];
}

/**
 * Get all testnet router addresses for a testnet chain.
 */
export function getTestnetRouters(testnetChain: string): readonly string[] {
  return TESTNET_ROUTERS[testnetChain] ?? [];
}

// =============================================================================
// Contract Address Resolution (Step 6)
// =============================================================================

/**
 * Testnet flash loan contract addresses keyed by testnet chain name.
 * Sourced from FLASH_LOAN_CONTRACT_ADDRESSES in contracts/deployments/addresses.ts.
 */
const TESTNET_FLASH_LOAN_CONTRACTS: Readonly<Record<string, string>> = {
  sepolia: '0x2f091cc77601C5aE2439A763C4916d9d32e035B6',
  arbitrumSepolia: '0xE5b26749430ed50917b75689B654a4C5808b23FB',
  baseSepolia: '0x2f091cc77601C5aE2439A763C4916d9d32e035B6',
};

/**
 * Get the flash loan contract address for a testnet chain.
 */
export function getTestnetFlashLoanContract(testnetChain: string): string | undefined {
  return TESTNET_FLASH_LOAN_CONTRACTS[testnetChain];
}

// =============================================================================
// Opportunity Transformation
// =============================================================================

/**
 * Transform a simulated opportunity (mainnet addresses) into a testnet opportunity
 * with correct testnet token addresses and testnet chain metadata.
 *
 * This is the main entry point for testnet resolution. Called by the execution
 * pipeline when TESTNET_EXECUTION_MODE=true.
 *
 * ## C-01 FIX: Dual-Name Approach
 *
 * Chain names (`buyChain`, `sellChain`, `chain`) are **preserved as mainnet names**
 * so that all downstream infrastructure lookups (providers, wallets, CHAINS config,
 * DEX config, flash loan providers) continue to work. Testnet chain names are added
 * as metadata fields (`_testnetBuyChain`, `_testnetSellChain`, `_testnetChain`) for
 * use at the transaction submission boundary.
 *
 * Token addresses are mapped to testnet equivalents since they appear directly in
 * transaction calldata.
 *
 * ## H-02 FIX: Cross-Chain Token Resolution
 *
 * For cross-chain opportunities, `tokenOut` is resolved using the sell chain's
 * token map (not the buy chain's), since the output token may live on a different chain.
 *
 * Fields transformed:
 * - tokenIn / token0 / token1 -> testnet token addresses (via buyChain map)
 * - tokenOut -> testnet token address (via sellChain map for cross-chain)
 *
 * Fields added:
 * - _testnetBuyChain / _testnetSellChain / _testnetChain -> testnet chain names
 *
 * Returns null if the opportunity's chain has no testnet support (should be skipped).
 */
export function transformOpportunityForTestnet(
  opportunity: ArbitrageOpportunity
): ArbitrageOpportunity | null {
  const mainnetChain = opportunity.buyChain ?? opportunity.chain;
  if (!mainnetChain) return null;

  // Check if this chain has testnet support
  if (!hasTestnetSupport(mainnetChain)) {
    return null; // Skip — no testnet for this chain
  }

  const testnetChain = resolveTestnetChain(mainnetChain);
  const mainnetSellChain = opportunity.sellChain;
  const testnetSellChain = mainnetSellChain
    ? resolveTestnetChain(mainnetSellChain)
    : undefined;

  // For cross-chain: if sell chain has no testnet support, skip
  if (mainnetSellChain && !hasTestnetSupport(mainnetSellChain)) {
    return null;
  }

  // H-02 FIX: Use sell chain for tokenOut resolution in cross-chain opportunities.
  // tokenIn/token0/token1 are on the buy chain; tokenOut may be on the sell chain.
  const sellTokenChain = mainnetSellChain ?? mainnetChain;

  return {
    ...opportunity,
    // C-01 FIX: Preserve mainnet chain names for infrastructure lookups (providers,
    // wallets, CHAINS config, DEX config). Add testnet names as metadata.
    _testnetBuyChain: testnetChain,
    _testnetSellChain: testnetSellChain,
    _testnetChain: testnetChain,
    // Token address resolution
    tokenIn: opportunity.tokenIn
      ? resolveTestnetTokenAddress(mainnetChain, opportunity.tokenIn)
      : opportunity.tokenIn,
    // H-02 FIX: tokenOut uses sell chain map for cross-chain resolution
    tokenOut: opportunity.tokenOut
      ? resolveTestnetTokenAddress(sellTokenChain, opportunity.tokenOut)
      : opportunity.tokenOut,
    token0: opportunity.token0
      ? resolveTestnetTokenAddress(mainnetChain, opportunity.token0)
      : opportunity.token0,
    token1: opportunity.token1
      ? resolveTestnetTokenAddress(mainnetChain, opportunity.token1)
      : opportunity.token1,
  } as ArbitrageOpportunity;
}
