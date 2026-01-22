/**
 * Cross-Chain Token Normalization
 *
 * Token aliases for identifying equivalent tokens across chains.
 * Enables cross-chain arbitrage detection.
 *
 * @see S3.2.4: Cross-chain token normalization
 * @see services/cross-chain-detector/src/detector.ts
 */

import { CORE_TOKENS } from './tokens';

// =============================================================================
// CROSS-CHAIN TOKEN NORMALIZATION (S3.2.4)
// =============================================================================

/**
 * Cross-chain token aliases for identifying equivalent tokens across chains.
 * Maps chain-specific token symbols to their canonical form.
 *
 * Purpose: Enable cross-chain arbitrage detection by recognizing that
 * WETH.e (Avalanche), ETH (BSC), and WETH (most chains) are all the same asset.
 *
 * Note: This is DIFFERENT from price-oracle's TOKEN_ALIASES which maps
 * wrapped tokens to native for pricing (WETH→ETH). Here we use WETH as
 * canonical because it's the actual tradeable asset on DEXes.
 *
 * @see services/cross-chain-detector/src/detector.ts
 * @see shared/core/src/price-oracle.ts (different purpose)
 */
export const CROSS_CHAIN_TOKEN_ALIASES: Readonly<Record<string, string>> = {
  // Fantom-specific (keys are UPPERCASE for case-insensitive matching)
  'FUSDT': 'USDT',
  'WFTM': 'FTM',

  // Avalanche-specific (bridged tokens use .e suffix)
  'WAVAX': 'AVAX',
  'WETH.E': 'WETH', // Note: .E is uppercase for matching
  'WBTC.E': 'WBTC',
  'USDT.E': 'USDT',
  'USDC.E': 'USDC',
  'DAI.E': 'DAI',
  'SAVAX': 'AVAX', // Staked AVAX (Benqi) → canonical AVAX

  // BSC-specific
  'WBNB': 'BNB',
  'BTCB': 'WBTC', // Binance wrapped BTC → canonical WBTC
  'ETH': 'WETH',  // BSC bridged ETH → canonical WETH

  // Polygon-specific
  'WMATIC': 'MATIC',

  // Solana-specific (Liquid Staking Tokens)
  'MSOL': 'SOL',     // Marinade staked SOL → canonical SOL
  'JITOSOL': 'SOL',  // Jito staked SOL → canonical SOL
  'BSOL': 'SOL',     // BlazeStake staked SOL → canonical SOL

  // FIX: Removed identity mappings (WETH→WETH, WBTC→WBTC, SOL→SOL)
  // The normalizeTokenForCrossChain() function already returns input when not found
} as const;

// =============================================================================
// PERFORMANCE OPTIMIZATION: Pre-computed alias Map for O(1) lookup
// Avoids repeated toUpperCase() calls in hot-path
// =============================================================================
const NORMALIZED_ALIASES = new Map<string, string>(
  Object.entries(CROSS_CHAIN_TOKEN_ALIASES).map(([key, value]) => [key, value])
);

// FIX: Memoization cache for normalizeTokenForCrossChain hot-path optimization
// Token symbols are finite and repeated frequently in arbitrage detection
const NORMALIZE_CACHE = new Map<string, string>();
const NORMALIZE_CACHE_MAX_SIZE = 1000; // Prevent unbounded growth

/**
 * Normalize a token symbol to its canonical form for cross-chain comparison.
 * This enables identifying equivalent tokens across different chains.
 *
 * Performance optimized:
 * - Uses memoization cache to avoid repeated toUpperCase() calls
 * - Pre-computed alias Map for O(1) lookup
 * - Cache bounded to prevent memory leaks
 *
 * Examples:
 * - normalizeTokenForCrossChain('WETH.e') → 'WETH'  (Avalanche bridged ETH)
 * - normalizeTokenForCrossChain('ETH') → 'WETH'     (BSC bridged ETH)
 * - normalizeTokenForCrossChain('fUSDT') → 'USDT'   (Fantom USDT)
 * - normalizeTokenForCrossChain('BTCB') → 'WBTC'    (BSC wrapped BTC)
 * - normalizeTokenForCrossChain('USDC') → 'USDC'    (passthrough)
 *
 * @param symbol - The token symbol to normalize
 * @returns The canonical token symbol for cross-chain comparison
 */
export function normalizeTokenForCrossChain(symbol: string): string {
  // Check memoization cache first (most common case)
  let cached = NORMALIZE_CACHE.get(symbol);
  if (cached !== undefined) return cached;

  // Compute normalized value
  const upper = symbol.includes(' ') ? symbol.toUpperCase().trim() : symbol.toUpperCase();
  const result = NORMALIZED_ALIASES.get(upper) ?? upper;

  // Cache result (with size limit to prevent memory leaks)
  if (NORMALIZE_CACHE.size < NORMALIZE_CACHE_MAX_SIZE) {
    NORMALIZE_CACHE.set(symbol, result);
  }

  return result;
}

// =============================================================================
// PERFORMANCE OPTIMIZATION: Pre-computed common tokens cache
// Chain pairs rarely change, so we cache the results
// =============================================================================
const COMMON_TOKENS_CACHE = new Map<string, string[]>();

/**
 * Find common tokens between two chains using normalized comparison.
 * Returns canonical token symbols that exist on both chains.
 *
 * Performance optimized: Results are cached since chain token lists are static.
 *
 * @param chainA - First chain ID
 * @param chainB - Second chain ID
 * @returns Array of canonical token symbols common to both chains
 */
export function findCommonTokensBetweenChains(chainA: string, chainB: string): string[] {
  // Normalize chain IDs and create canonical cache key (sorted for consistency)
  const a = chainA.toLowerCase();
  const b = chainB.toLowerCase();
  const cacheKey = a < b ? `${a}:${b}` : `${b}:${a}`;

  // Check cache first
  const cached = COMMON_TOKENS_CACHE.get(cacheKey);
  if (cached) return cached;

  // Compute common tokens
  const tokensA = CORE_TOKENS[a] || [];
  const tokensB = CORE_TOKENS[b] || [];

  const normalizedA = new Set(tokensA.map(t => normalizeTokenForCrossChain(t.symbol)));
  const normalizedB = new Set(tokensB.map(t => normalizeTokenForCrossChain(t.symbol)));

  const result = Array.from(normalizedA).filter(token => normalizedB.has(token));

  // Cache for future calls
  COMMON_TOKENS_CACHE.set(cacheKey, result);

  return result;
}

/**
 * Pre-warm the common tokens cache for all chain pairs.
 * Call this at application startup to avoid first-call latency.
 */
export function preWarmCommonTokensCache(): void {
  const chains = Object.keys(CORE_TOKENS);
  for (let i = 0; i < chains.length; i++) {
    for (let j = i + 1; j < chains.length; j++) {
      findCommonTokensBetweenChains(chains[i], chains[j]);
    }
  }
}

/**
 * Get the chain-specific token symbol for a canonical symbol.
 * Useful for building pair keys when you know the canonical token.
 *
 * FIX: Optimized to single pass instead of two passes (exact + normalized).
 * Performance improvement for hot-path usage in arbitrage detection.
 *
 * @param chainId - The chain ID
 * @param canonicalSymbol - The canonical token symbol (e.g., 'WETH')
 * @returns The chain-specific symbol (e.g., 'WETH.e' on Avalanche) or undefined
 */
export function getChainSpecificTokenSymbol(chainId: string, canonicalSymbol: string): string | undefined {
  const tokens = CORE_TOKENS[chainId.toLowerCase()] || [];
  const normalizedCanonical = canonicalSymbol.toUpperCase();

  // FIX: Single pass - check exact match first, track first normalized match
  let normalizedMatch: string | undefined;

  for (const token of tokens) {
    const upperSymbol = token.symbol.toUpperCase();

    // Exact match takes priority - return immediately
    if (upperSymbol === normalizedCanonical) {
      return token.symbol;
    }

    // Track first normalized match (handles aliases like WETH.e → WETH)
    if (normalizedMatch === undefined &&
        normalizeTokenForCrossChain(token.symbol) === normalizedCanonical) {
      normalizedMatch = token.symbol;
    }
  }

  return normalizedMatch;
}

// =============================================================================
// CHAIN-SPECIFIC DEFAULT QUOTE TOKENS (Refactored from detector.ts)
// =============================================================================

/**
 * Chain-specific default quote tokens for whale transaction parsing.
 * Different chains have different primary stablecoins used as quote currency.
 *
 * Used when a whale transaction contains a single token (e.g., "WETH")
 * and we need to infer the quote token for the trading pair.
 *
 * @see services/cross-chain-detector/src/detector.ts - analyzeWhaleImpact()
 */
export const DEFAULT_QUOTE_TOKENS: Readonly<Record<string, string>> = {
  ethereum: 'USDC',
  arbitrum: 'USDC',
  optimism: 'USDC',
  polygon: 'USDC',
  base: 'USDC',
  bsc: 'USDT',         // FIX: BUSD was deprecated by Binance in late 2023, using USDT
  avalanche: 'USDC.e', // Avalanche uses bridged USDC
  fantom: 'USDC',
  zksync: 'USDC',
  linea: 'USDC',
  solana: 'USDC',
} as const;

/**
 * Get the default quote token for a given chain.
 * Falls back to 'USDC' if the chain is not configured.
 *
 * @param chain - The chain identifier (lowercase)
 * @returns The default quote token symbol for that chain
 */
export function getDefaultQuoteToken(chain: string): string {
  return DEFAULT_QUOTE_TOKENS[chain.toLowerCase()] || 'USDC';
}
