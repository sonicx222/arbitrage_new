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
// Phase 0 Item 2: LIQUID STAKING TOKEN EXCLUSION SET
// These tokens MUST NOT be aliased during price normalization — their price
// deviation from the underlying IS the arbitrage opportunity ($40B+ TVL market).
// normalizeTokenForCrossChain() still maps them for bridge routing.
// =============================================================================

/**
 * Tokens that are LSTs/LRTs. These have distinct market prices from their
 * underlying asset and should not be collapsed during price comparison.
 *
 * Used by normalizeTokenForPricing() to skip aliasing for these tokens.
 */
export const LIQUID_STAKING_TOKENS: ReadonlySet<string> = new Set([
  // Ethereum LSTs
  'STETH', 'WSTETH', 'RETH', 'CBETH', 'SFRXETH', 'EETH', 'RSETH', 'PUFETH',
  // Solana LSTs
  'MSOL', 'JITOSOL', 'BSOL', 'STSOL', 'LSOL', 'SCNSOL', 'CGTSOL', 'LAINESOL', 'EDGESOL', 'COMPASSSOL',
  // Avalanche LSTs
  'SAVAX',
]);

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

// Phase 0 Item 2: Separate cache for pricing normalization
const PRICING_NORMALIZE_CACHE = new Map<string, string>();

/**
 * Normalize a token symbol to its canonical form for cross-chain comparison.
 * This enables identifying equivalent tokens across different chains.
 *
 * **SECURITY NOTE (Fix #28):** This function normalizes by SYMBOL ONLY and does
 * not verify token contract addresses. An adversarial token with symbol "USDC"
 * deployed on one chain would match the real USDC on another chain, potentially
 * triggering a false cross-chain arbitrage opportunity. Callers performing
 * cross-chain comparisons MUST use {@link verifyTokenAddress} to confirm that the
 * token address matches the known CORE_TOKENS entry for that chain before acting
 * on any cross-chain opportunity.
 * @see docs/reports/PHASE1_DEEP_ANALYSIS_2026-02-22.md Finding #28
 *
 * Performance optimized:
 * - Uses memoization cache to avoid repeated toUpperCase() calls
 * - Pre-computed alias Map for O(1) lookup
 * - FIFO eviction: When cache is full, oldest entries are evicted
 *   (Map iteration order is insertion order in JS)
 * - Thread-safe: No non-atomic read-modify-write sequences
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
  // Fix 13: Use lowercase cache key so 'weth', 'WETH', 'Weth' share one entry
  const cacheKey = symbol.toLowerCase();

  // Check memoization cache first (most common case)
  const cached = NORMALIZE_CACHE.get(cacheKey);
  if (cached !== undefined) {
    // P0-5 FIX: Removed LRU refresh (delete/set) to prevent race condition.
    // The delete/set sequence was not atomic - under high concurrency, another
    // caller could evict our entry between delete and set operations.
    // Since token symbols are finite (~200) and cache is large (1000), eviction
    // is rare and LRU ordering is not critical for correctness. Simple FIFO eviction
    // on insert is sufficient for memory bounds.
    return cached;
  }

  // Compute normalized value
  const upper = symbol.includes(' ') ? symbol.toUpperCase().trim() : symbol.toUpperCase();
  const result = NORMALIZED_ALIASES.get(upper) ?? upper;

  // FIFO eviction: Remove oldest entry (first in iteration order) when at capacity
  // This is safe because Map insertion order is guaranteed in JS
  if (NORMALIZE_CACHE.size >= NORMALIZE_CACHE_MAX_SIZE) {
    const oldestKey = NORMALIZE_CACHE.keys().next().value;
    if (oldestKey !== undefined) {
      NORMALIZE_CACHE.delete(oldestKey);
    }
  }

  // Cache result with normalized key
  NORMALIZE_CACHE.set(cacheKey, result);

  return result;
}

// =============================================================================
// Phase 0 Item 2: PRICING NORMALIZATION (preserves LST identities)
// =============================================================================

/**
 * Normalize a token symbol for PRICING comparison (intra-chain arbitrage).
 *
 * Unlike normalizeTokenForCrossChain(), this function preserves LST/LRT token
 * identities. The price deviation between an LST and its underlying IS the
 * arbitrage opportunity — mapping mSOL→SOL destroys this signal.
 *
 * Bridged token variants are still normalized (WETH.e→WETH, fUSDT→USDT)
 * because those represent the same priced asset on different chains.
 *
 * Examples:
 * - normalizeTokenForPricing('mSOL') → 'MSOL'      (preserved — distinct price)
 * - normalizeTokenForPricing('stETH') → 'STETH'     (preserved — distinct price)
 * - normalizeTokenForPricing('wstETH') → 'WSTETH'   (preserved — distinct price)
 * - normalizeTokenForPricing('sAVAX') → 'SAVAX'     (preserved — distinct price)
 * - normalizeTokenForPricing('WETH.e') → 'WETH'     (aliased — same asset, different chain)
 * - normalizeTokenForPricing('fUSDT') → 'USDT'      (aliased — same asset, different chain)
 * - normalizeTokenForPricing('BTCB') → 'WBTC'       (aliased — same asset, different chain)
 *
 * @param symbol - The token symbol to normalize
 * @returns The canonical token symbol for pricing comparison
 */
export function normalizeTokenForPricing(symbol: string): string {
  // Fix 13: Use lowercase cache key for case-insensitive deduplication
  const cacheKey = symbol.toLowerCase();

  // Check memoization cache first
  const cached = PRICING_NORMALIZE_CACHE.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  // Compute normalized value
  const upper = symbol.includes(' ') ? symbol.toUpperCase().trim() : symbol.toUpperCase();

  // If this is an LST/LRT token, preserve its identity (don't alias to underlying)
  let result: string;
  if (LIQUID_STAKING_TOKENS.has(upper)) {
    result = upper; // Preserve: mSOL stays MSOL, stETH stays STETH
  } else {
    result = NORMALIZED_ALIASES.get(upper) ?? upper;
  }

  // FIFO eviction
  if (PRICING_NORMALIZE_CACHE.size >= NORMALIZE_CACHE_MAX_SIZE) {
    const oldestKey = PRICING_NORMALIZE_CACHE.keys().next().value;
    if (oldestKey !== undefined) {
      PRICING_NORMALIZE_CACHE.delete(oldestKey);
    }
  }

  PRICING_NORMALIZE_CACHE.set(cacheKey, result);
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
  blast: 'USDB',   // Blast native stablecoin
  scroll: 'USDC',
  mantle: 'USDC',
  mode: 'USDC',
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
  // P3-23 FIX: Use ?? for consistency with project convention (|| treats '' as falsy)
  return DEFAULT_QUOTE_TOKENS[chain.toLowerCase()] ?? 'USDC';
}

// =============================================================================
// Fix #28: ADDRESS-BASED TOKEN VERIFICATION
// Mitigates adversarial symbol collision in cross-chain normalization.
// A fake token with symbol "USDC" on one chain would match real USDC on
// another. This function lets callers verify the token address before trusting
// a symbol-based cross-chain match.
// @see docs/reports/PHASE1_DEEP_ANALYSIS_2026-02-22.md Finding #28
// =============================================================================

// Pre-built lookup: chain → symbol (uppercase) → address (lowercase) for O(1) verification.
// Built once at module load from CORE_TOKENS.
const TOKEN_ADDRESS_INDEX = new Map<string, Map<string, string>>();

(function buildTokenAddressIndex() {
  for (const [chain, tokens] of Object.entries(CORE_TOKENS)) {
    const chainMap = new Map<string, string>();
    for (const token of tokens) {
      chainMap.set(token.symbol.toUpperCase(), token.address.toLowerCase());
    }
    TOKEN_ADDRESS_INDEX.set(chain.toLowerCase(), chainMap);
  }
})();

/**
 * Verify that a token's contract address matches the known CORE_TOKENS address
 * for the given symbol on the given chain. Returns false if the token is unknown
 * (not in CORE_TOKENS) or the address doesn't match.
 *
 * Use this AFTER normalizeTokenForCrossChain() to guard against adversarial
 * symbol collisions in cross-chain arbitrage detection.
 *
 * @param chain - Chain identifier (e.g., 'ethereum', 'arbitrum')
 * @param symbol - Token symbol (e.g., 'USDC', 'WETH')
 * @param address - Token contract address to verify
 * @returns true if address matches known CORE_TOKENS entry; false otherwise
 */
export function verifyTokenAddress(chain: string, symbol: string, address: string): boolean {
  const chainMap = TOKEN_ADDRESS_INDEX.get(chain.toLowerCase());
  if (!chainMap) return false;

  const knownAddress = chainMap.get(symbol.toUpperCase());
  if (!knownAddress) return false;

  return knownAddress === address.toLowerCase();
}

/**
 * Check if a token symbol is known (present in CORE_TOKENS) on a given chain.
 * Does NOT verify the address — use {@link verifyTokenAddress} for that.
 *
 * @param chain - Chain identifier
 * @param symbol - Token symbol
 * @returns true if the symbol is in CORE_TOKENS for this chain
 */
export function isKnownToken(chain: string, symbol: string): boolean {
  const chainMap = TOKEN_ADDRESS_INDEX.get(chain.toLowerCase());
  return chainMap?.has(symbol.toUpperCase()) ?? false;
}
