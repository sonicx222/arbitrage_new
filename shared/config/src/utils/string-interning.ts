/**
 * String Interning Utilities
 *
 * Provides string interning (deduplication) for frequently used strings
 * like chain names. This reduces memory usage and allows fast identity
 * comparisons (===) instead of deep string comparisons.
 *
 * Performance impact:
 * - First access: O(1) hash lookup + string allocation
 * - Subsequent access: O(1) hash lookup, no allocation
 * - Identity comparison: O(1) instead of O(n) for string comparison
 *
 * @see ADR-015: Performance optimization patterns
 */

// =============================================================================
// String Pool
// =============================================================================

/**
 * Create an interned string pool with optional max size.
 * When max size is reached, oldest entries are evicted (FIFO).
 */
export function createStringPool(maxSize: number = 1000) {
  const pool = new Map<string, string>();
  const insertionOrder: string[] = [];

  return {
    /**
     * Get the interned version of a string.
     * Returns the same object reference for equal strings.
     */
    intern(str: string): string {
      const existing = pool.get(str);
      if (existing !== undefined) {
        return existing;
      }

      // Evict oldest if at capacity
      if (pool.size >= maxSize) {
        const oldest = insertionOrder.shift();
        if (oldest) {
          pool.delete(oldest);
        }
      }

      pool.set(str, str);
      insertionOrder.push(str);
      return str;
    },

    /**
     * Get the interned version of a lowercase string.
     * Common operation for case-insensitive lookups.
     */
    internLower(str: string): string {
      return this.intern(str.toLowerCase());
    },

    /**
     * Check if a string is already interned.
     */
    has(str: string): boolean {
      return pool.has(str);
    },

    /**
     * Get pool statistics.
     */
    stats() {
      return {
        size: pool.size,
        maxSize,
        hitRate: 0, // Would need tracking to implement
      };
    },

    /**
     * Clear the pool (for testing).
     */
    clear() {
      pool.clear();
      insertionOrder.length = 0;
    },
  };
}

// =============================================================================
// Global Chain Name Pool
// =============================================================================

/**
 * Global interned string pool for chain names.
 * Pre-populated with known chain names to avoid allocation on hot paths.
 */
const CHAIN_NAME_POOL = createStringPool(100);

// Pre-intern known chain names
const KNOWN_CHAINS = [
  'ethereum', 'polygon', 'arbitrum', 'base', 'optimism',
  'bsc', 'avalanche', 'fantom', 'zksync', 'linea', 'solana',
  // Emerging L2s
  'blast', 'scroll', 'mantle', 'mode',
  // Uppercase variants commonly seen
  'ETHEREUM', 'POLYGON', 'ARBITRUM', 'BASE', 'OPTIMISM',
  'BSC', 'AVALANCHE', 'FANTOM', 'ZKSYNC', 'LINEA', 'SOLANA',
  'BLAST', 'SCROLL', 'MANTLE', 'MODE',
  // Testnets
  'sepolia', 'goerli', 'mumbai', 'arbitrum-sepolia', 'base-sepolia',
];

for (const chain of KNOWN_CHAINS) {
  CHAIN_NAME_POOL.intern(chain);
  CHAIN_NAME_POOL.internLower(chain);
}

/**
 * Get an interned chain name.
 * Use this in hot paths to avoid string allocation.
 *
 * @example
 * ```typescript
 * // Instead of:
 * const chain = chainName.toLowerCase();
 *
 * // Use:
 * const chain = internChainName(chainName);
 * ```
 */
export function internChainName(chainName: string): string {
  return CHAIN_NAME_POOL.intern(chainName);
}

/**
 * Get an interned lowercase chain name.
 * Common operation for case-insensitive lookups.
 */
export function internChainNameLower(chainName: string): string {
  return CHAIN_NAME_POOL.internLower(chainName);
}

/**
 * Get statistics about the chain name pool.
 */
export function getChainPoolStats() {
  return CHAIN_NAME_POOL.stats();
}

/**
 * Reset the chain name pool (for testing).
 */
export function resetChainPool() {
  CHAIN_NAME_POOL.clear();
  // Re-intern known chains
  for (const chain of KNOWN_CHAINS) {
    CHAIN_NAME_POOL.intern(chain);
    CHAIN_NAME_POOL.internLower(chain);
  }
}

// =============================================================================
// Token Symbol Pool
// =============================================================================

const TOKEN_SYMBOL_POOL = createStringPool(500);

// Pre-intern common token symbols
const COMMON_TOKENS = [
  'ETH', 'WETH', 'BTC', 'WBTC', 'USDC', 'USDT', 'DAI', 'BUSD',
  'BNB', 'WBNB', 'MATIC', 'WMATIC', 'SOL', 'WSOL', 'AVAX', 'WAVAX',
  'FTM', 'WFTM', 'OP', 'ARB', 'UNI', 'AAVE', 'LINK', 'CRV',
  'eth', 'weth', 'btc', 'wbtc', 'usdc', 'usdt', 'dai', 'busd',
];

for (const token of COMMON_TOKENS) {
  TOKEN_SYMBOL_POOL.intern(token);
}

/**
 * Get an interned token symbol.
 */
export function internTokenSymbol(symbol: string): string {
  return TOKEN_SYMBOL_POOL.intern(symbol);
}

/**
 * Get an interned uppercase token symbol.
 */
export function internTokenSymbolUpper(symbol: string): string {
  return TOKEN_SYMBOL_POOL.intern(symbol.toUpperCase());
}

// =============================================================================
// DEX Name Pool
// =============================================================================

const DEX_NAME_POOL = createStringPool(100);

// Pre-intern common DEX names
const COMMON_DEXES = [
  'uniswap_v2', 'uniswap_v3', 'sushiswap', 'pancakeswap_v2', 'pancakeswap_v3',
  'quickswap', 'quickswap_v3', 'camelot', 'camelot_v3', 'velodrome', 'aerodrome',
  'trader_joe', 'trader_joe_v2', 'balancer_v2', 'curve', 'gmx',
  'raydium', 'orca', 'jupiter',
];

for (const dex of COMMON_DEXES) {
  DEX_NAME_POOL.intern(dex);
}

/**
 * Get an interned DEX name.
 */
export function internDexName(dexName: string): string {
  return DEX_NAME_POOL.intern(dexName);
}
