/**
 * TokenUtils - Token Address Utilities
 *
 * ARCH-REFACTOR: Extracted from various files to provide consistent
 * token address handling across all components.
 *
 * Design Principles:
 * - Pure functions with no side effects
 * - Case-insensitive address handling
 * - Consistent normalization patterns
 *
 * @see .claude/plans/modularization-enhancement-plan.md
 */

import { getAddress } from 'ethers';

// =============================================================================
// Address Normalization
// =============================================================================

/**
 * Normalize an Ethereum/EVM address to lowercase.
 * Returns empty string for invalid addresses.
 *
 * @param address - Address to normalize
 * @returns Normalized lowercase address or empty string
 */
export function normalizeAddress(address: string | null | undefined): string {
  if (!address || typeof address !== 'string') {
    return '';
  }
  return address.toLowerCase().trim();
}

/**
 * Compare two addresses for equality (case-insensitive).
 *
 * @param address1 - First address
 * @param address2 - Second address
 * @returns True if addresses are equal
 */
export function addressEquals(
  address1: string | null | undefined,
  address2: string | null | undefined
): boolean {
  return normalizeAddress(address1) === normalizeAddress(address2);
}

/**
 * Check if an address is valid (non-empty, correct format).
 *
 * @param address - Address to validate
 * @returns True if valid EVM address format
 */
export function isValidAddress(address: string | null | undefined): boolean {
  if (!address || typeof address !== 'string') {
    return false;
  }
  // EVM addresses: 0x followed by 40 hex characters
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**
 * Check if an address is a Solana address (base58 format).
 *
 * @param address - Address to validate
 * @returns True if valid Solana address format
 */
export function isSolanaAddress(address: string | null | undefined): boolean {
  if (!address || typeof address !== 'string') {
    return false;
  }
  // Solana addresses: 32-44 base58 characters (no 0, O, I, l)
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

/**
 * Determine the chain type from address format.
 *
 * @param address - Address to check
 * @returns 'evm' | 'solana' | 'unknown'
 */
export function getAddressChainType(address: string): 'evm' | 'solana' | 'unknown' {
  if (isValidAddress(address)) return 'evm';
  if (isSolanaAddress(address)) return 'solana';
  return 'unknown';
}

// =============================================================================
// Token Pair Keys
// =============================================================================

/**
 * Generate a normalized token pair key.
 * Tokens are sorted alphabetically for consistent key generation.
 *
 * @param token0 - First token address
 * @param token1 - Second token address
 * @returns Canonical token pair key
 */
export function getTokenPairKey(token0: string, token1: string): string {
  const t0 = normalizeAddress(token0);
  const t1 = normalizeAddress(token1);
  // Sort alphabetically for consistent key
  return t0 < t1 ? `${t0}_${t1}` : `${t1}_${t0}`;
}

// =============================================================================
// HOT-PATH OPTIMIZATION: Token Pair Key Cache
// FIX: Avoid repeated toLowerCase() and string concatenation in tight loops
// =============================================================================

/**
 * LRU-style cache for token pair keys.
 * Caches normalized keys to avoid repeated string operations.
 *
 * Performance impact:
 * - First access: O(n) for normalization + concatenation
 * - Subsequent access: O(1) Map lookup, no string allocation
 *
 * Memory: ~200 bytes per entry * 10000 entries = ~2MB max
 */
const TOKEN_PAIR_KEY_CACHE = new Map<string, string>();
const TOKEN_PAIR_KEY_CACHE_MAX_SIZE = 10000;

/**
 * HOT-PATH: Get token pair key with caching.
 * Use this version in performance-critical code paths like:
 * - Reserve update handlers
 * - Arbitrage detection loops
 * - Price comparison iterations
 *
 * @param token0 - First token address (any case)
 * @param token1 - Second token address (any case)
 * @returns Cached canonical token pair key
 */
export function getTokenPairKeyCached(token0: string, token1: string): string {
  // Create lookup key from raw addresses (fast concat, no normalization yet)
  // Use | separator since addresses don't contain |
  const lookupKey = `${token0}|${token1}`;

  // Fast path: return cached result
  let cached = TOKEN_PAIR_KEY_CACHE.get(lookupKey);
  if (cached !== undefined) {
    return cached;
  }

  // Also check reverse order (same logical pair)
  const reverseLookupKey = `${token1}|${token0}`;
  cached = TOKEN_PAIR_KEY_CACHE.get(reverseLookupKey);
  if (cached !== undefined) {
    // Cache under this order too for future lookups
    if (TOKEN_PAIR_KEY_CACHE.size < TOKEN_PAIR_KEY_CACHE_MAX_SIZE) {
      TOKEN_PAIR_KEY_CACHE.set(lookupKey, cached);
    }
    return cached;
  }

  // Slow path: compute and cache
  const result = getTokenPairKey(token0, token1);

  // Evict oldest entries if at capacity (simple FIFO eviction)
  if (TOKEN_PAIR_KEY_CACHE.size >= TOKEN_PAIR_KEY_CACHE_MAX_SIZE) {
    // Delete first 1000 entries (10% batch eviction for efficiency)
    // Iterator-based deletion avoids Array.from() + slice() allocations
    let deleted = 0;
    for (const key of TOKEN_PAIR_KEY_CACHE.keys()) {
      if (deleted >= 1000) break;
      TOKEN_PAIR_KEY_CACHE.delete(key);
      deleted++;
    }
  }

  TOKEN_PAIR_KEY_CACHE.set(lookupKey, result);
  return result;
}

/**
 * Get token pair key cache statistics (for monitoring).
 */
export function getTokenPairKeyCacheStats(): { size: number; maxSize: number } {
  return {
    size: TOKEN_PAIR_KEY_CACHE.size,
    maxSize: TOKEN_PAIR_KEY_CACHE_MAX_SIZE,
  };
}

/**
 * Clear the token pair key cache (for testing).
 */
export function clearTokenPairKeyCache(): void {
  TOKEN_PAIR_KEY_CACHE.clear();
}

/**
 * Parse a token pair key back into token addresses.
 *
 * @param key - Token pair key
 * @returns Tuple of [token0, token1] or null if invalid
 */
export function parseTokenPairKey(key: string): [string, string] | null {
  if (!key || typeof key !== 'string') {
    return null;
  }
  const parts = key.split('_');
  if (parts.length !== 2) {
    return null;
  }
  const [token0, token1] = parts;
  if (!token0 || !token1) {
    return null;
  }
  return [token0, token1];
}

/**
 * Check if two token pairs represent the same trading pair.
 * Handles cases where token order might be different.
 *
 * @param pair1Token0 - First pair's token0
 * @param pair1Token1 - First pair's token1
 * @param pair2Token0 - Second pair's token0
 * @param pair2Token1 - Second pair's token1
 * @returns True if same trading pair
 */
export function isSameTokenPair(
  pair1Token0: string,
  pair1Token1: string,
  pair2Token0: string,
  pair2Token1: string
): boolean {
  const key1 = getTokenPairKey(pair1Token0, pair1Token1);
  const key2 = getTokenPairKey(pair2Token0, pair2Token1);
  return key1 === key2;
}

// =============================================================================
// HOT-PATH: Pre-Normalized Token Pair Utilities
// These variants skip all normalization (toLowerCase/trim) for maximum performance.
// Inputs MUST be already lowercase. Use in hot paths where tokens are pre-normalized.
// @see ADR-022 for hot-path optimization rationale
// =============================================================================

/**
 * Check if two token pairs represent the same pair (pre-normalized addresses).
 * HOT-PATH: No normalization, direct comparison. Inputs MUST be already lowercase.
 * @see ADR-022 for hot-path optimization rationale
 */
export function isSameTokenPairPreNormalized(
  pair1Token0: string, pair1Token1: string,
  pair2Token0: string, pair2Token1: string
): boolean {
  return (pair1Token0 === pair2Token0 && pair1Token1 === pair2Token1) ||
         (pair1Token0 === pair2Token1 && pair1Token1 === pair2Token0);
}

/**
 * Check if token order is reversed between two pairs (pre-normalized addresses).
 * HOT-PATH: No normalization, direct comparison. Inputs MUST be already lowercase.
 * @see ADR-022 for hot-path optimization rationale
 */
export function isReverseOrderPreNormalized(
  pair1Token0: string, pair2Token0: string
): boolean {
  return pair1Token0 !== pair2Token0;
}

// =============================================================================
// Token Order Utilities
// =============================================================================

/**
 * Check if token order is reversed between two pairs.
 *
 * @param pair1Token0 - Token0 from first pair
 * @param pair2Token0 - Token0 from second pair
 * @returns True if token order is reversed
 */
export function isReverseOrder(pair1Token0: string, pair2Token0: string): boolean {
  return !addressEquals(pair1Token0, pair2Token0);
}

/**
 * Sort tokens into canonical order (alphabetically by lowercase address).
 *
 * NOTE: Sorts by lowercase comparison but returns original-case addresses.
 * This is intentional — callers who need lowercase output should use
 * `normalizeTokenOrder()` from arbitrage-detector.ts or apply
 * `normalizeAddress()` to the results. The `getTokenPairKey()` function
 * in this module always returns lowercase keys regardless.
 *
 * @param tokenA - First token
 * @param tokenB - Second token
 * @returns Tuple of [lowerToken, higherToken] in original case
 */
export function sortTokens(tokenA: string, tokenB: string): [string, string] {
  const a = normalizeAddress(tokenA);
  const b = normalizeAddress(tokenB);
  return a < b ? [tokenA, tokenB] : [tokenB, tokenA];
}

/**
 * Get the token order index for a given token in a pair.
 *
 * @param pairToken0 - Pair's token0
 * @param pairToken1 - Pair's token1
 * @param tokenToFind - Token to find
 * @returns 0, 1, or -1 if not found
 */
export function getTokenIndex(
  pairToken0: string,
  pairToken1: string,
  tokenToFind: string
): 0 | 1 | -1 {
  if (addressEquals(pairToken0, tokenToFind)) return 0;
  if (addressEquals(pairToken1, tokenToFind)) return 1;
  return -1;
}

// =============================================================================
// Common Token Addresses
// =============================================================================

/**
 * Well-known token addresses for common chains.
 * These are commonly used in arbitrage detection.
 */
export const COMMON_TOKENS = {
  // Ethereum Mainnet
  ethereum: {
    WETH: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    USDC: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    USDT: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    DAI: '0x6b175474e89094c44da98b954eedeac495271d0f',
    WBTC: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
  },
  // Polygon
  polygon: {
    WMATIC: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270',
    WETH: '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619',
    USDC: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
    USDT: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
  },
  // BSC
  bsc: {
    WBNB: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
    BUSD: '0xe9e7cea3dedca5984780bafc599bd69add087d56',
    USDT: '0x55d398326f99059ff775485246999027b3197955',
    ETH: '0x2170ed0880ac9a755fd29b2688956bd959f933f8',
  },
  // Arbitrum
  arbitrum: {
    WETH: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
    USDC: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    USDT: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
    ARB: '0x912ce59144191c1204e64559fe8253a0e49e6548',
  },
  // Optimism
  optimism: {
    WETH: '0x4200000000000000000000000000000000000006',
    USDC: '0x7f5c764cbc14f9669b88837ca1490cca17c31607',
    OP: '0x4200000000000000000000000000000000000042',
  },
  // Base
  base: {
    WETH: '0x4200000000000000000000000000000000000006',
    USDC: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  },
} as const;

/**
 * Native token symbols for each chain.
 */
export const NATIVE_TOKENS: Record<string, string> = {
  ethereum: 'ETH',
  polygon: 'MATIC',
  bsc: 'BNB',
  arbitrum: 'ETH',
  optimism: 'ETH',
  base: 'ETH',
  avalanche: 'AVAX',
  solana: 'SOL',
};

/**
 * Wrapped native token addresses for each chain.
 */
export const WRAPPED_NATIVE_TOKENS: Record<string, string> = {
  ethereum: COMMON_TOKENS.ethereum.WETH,
  polygon: COMMON_TOKENS.polygon.WMATIC,
  bsc: COMMON_TOKENS.bsc.WBNB,
  arbitrum: COMMON_TOKENS.arbitrum.WETH,
  optimism: COMMON_TOKENS.optimism.WETH,
  base: COMMON_TOKENS.base.WETH,
};

// =============================================================================
// Token Identification
// =============================================================================

/**
 * Check if a token address is a stablecoin.
 *
 * @param address - Token address
 * @param chain - Chain name (optional, improves accuracy)
 * @returns True if token is a known stablecoin
 */
export function isStablecoin(address: string, chain?: string): boolean {
  const normalized = normalizeAddress(address);

  // Check all chains if no chain specified
  const chainsToCheck = chain ? [chain] : Object.keys(COMMON_TOKENS);

  for (const chainKey of chainsToCheck) {
    const tokens = COMMON_TOKENS[chainKey as keyof typeof COMMON_TOKENS];
    if (!tokens) continue;

    // Check common stablecoin addresses
    const stablecoins = ['USDC', 'USDT', 'DAI', 'BUSD'];
    const tokenRecord = tokens as Record<string, string>;
    for (const symbol of stablecoins) {
      if (symbol in tokenRecord && addressEquals(normalized, tokenRecord[symbol])) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if a token address is a wrapped native token.
 *
 * @param address - Token address
 * @param chain - Chain name (optional)
 * @returns True if token is wrapped native
 */
export function isWrappedNative(address: string, chain?: string): boolean {
  const normalized = normalizeAddress(address);

  if (chain && WRAPPED_NATIVE_TOKENS[chain]) {
    return addressEquals(normalized, WRAPPED_NATIVE_TOKENS[chain]);
  }

  // Check all chains
  return Object.values(WRAPPED_NATIVE_TOKENS).some(
    wrappedAddr => addressEquals(normalized, wrappedAddr)
  );
}

/**
 * Get chain name from a known token address.
 *
 * @param address - Token address
 * @returns Chain name or null if not found
 */
export function getChainFromToken(address: string): string | null {
  const normalized = normalizeAddress(address);

  for (const [chain, tokens] of Object.entries(COMMON_TOKENS)) {
    for (const tokenAddr of Object.values(tokens)) {
      if (addressEquals(normalized, tokenAddr)) {
        return chain;
      }
    }
  }

  return null;
}

// =============================================================================
// Checksum Utilities
// =============================================================================

/**
 * Convert address to EIP-55 checksummed format.
 * Uses ethers.getAddress() for proper EIP-55 compliance.
 *
 * @param address - Address to checksum
 * @returns Checksummed address or original if invalid
 */
export function toChecksumAddress(address: string): string {
  if (!isValidAddress(address)) {
    return address;
  }

  try {
    // Use ethers.getAddress() for proper EIP-55 checksumming
    return getAddress(address);
  } catch {
    // Return original if conversion fails
    return address;
  }
}

// =============================================================================
// Address Set Operations
// =============================================================================

/**
 * Create a normalized Set of addresses for fast lookups.
 *
 * @param addresses - Array of addresses
 * @returns Set with normalized addresses
 */
export function createAddressSet(addresses: string[]): Set<string> {
  return new Set(addresses.map(normalizeAddress).filter(Boolean));
}

/**
 * Check if an address is in a normalized set.
 *
 * @param set - Normalized address set
 * @param address - Address to check
 * @returns True if address is in set
 */
export function addressInSet(set: Set<string>, address: string): boolean {
  return set.has(normalizeAddress(address));
}

/**
 * Find intersection of two address arrays.
 *
 * @param addresses1 - First array of addresses
 * @param addresses2 - Second array of addresses
 * @returns Array of common addresses
 */
export function intersectAddresses(addresses1: string[], addresses2: string[]): string[] {
  const set = createAddressSet(addresses1);
  return addresses2.filter(addr => addressInSet(set, addr));
}
