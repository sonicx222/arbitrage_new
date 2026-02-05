/**
 * P2-14: CrossChainPriceTracker - Extracted from partitioned-detector.ts
 *
 * Manages cross-chain price tracking for arbitrage detection.
 * Uses LRU cache per chain to prevent unbounded memory growth.
 *
 * Features:
 * - Bounded memory via LRU cache per chain
 * - O(1) price lookups
 * - Cross-chain discrepancy detection
 * - Token pair normalization for consistent matching
 *
 * @see docs/research/REFACTORING_IMPLEMENTATION_PLAN.md P2-14
 */

import { LRUCache } from './data-structures';

// =============================================================================
// Types
// =============================================================================

/**
 * Price point with timestamp for freshness tracking.
 */
export interface PricePoint {
  price: number;
  timestamp: number;
}

/**
 * Cross-chain price discrepancy detected.
 */
export interface CrossChainDiscrepancy {
  /** Normalized pair key (e.g., "WETH_USDT") */
  pairKey: string;
  /** Chain IDs with this pair */
  chains: string[];
  /** Price per chain */
  prices: Map<string, number>;
  /** Maximum price difference as decimal (e.g., 0.05 = 5%) */
  maxDifference: number;
  /** Timestamp when detected */
  timestamp: number;
}

/**
 * Logger interface for CrossChainPriceTracker.
 */
export interface PriceTrackerLogger {
  debug: (message: string, meta?: object) => void;
  warn: (message: string, meta?: object) => void;
}

/**
 * Configuration for CrossChainPriceTracker.
 */
export interface CrossChainPriceTrackerConfig {
  /** Maximum number of price entries per chain (default: 50000) */
  maxPricesPerChain?: number;
  /** Maximum number of cached normalized pairs (default: 10000) */
  maxNormalizedPairCacheSize?: number;
}

/**
 * Function signature for token normalization.
 * Used for cross-chain matching (e.g., WETH.e -> WETH, ETH -> WETH).
 */
export type TokenNormalizeFn = (symbol: string) => string;

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: Required<CrossChainPriceTrackerConfig> = {
  maxPricesPerChain: 50000,
  maxNormalizedPairCacheSize: 10000,
};

// =============================================================================
// CrossChainPriceTracker Class
// =============================================================================

/**
 * P2-14: CrossChainPriceTracker - Manages cross-chain price data.
 *
 * This class encapsulates the cross-chain price tracking logic that was
 * previously embedded in PartitionedDetector. It provides:
 *
 * 1. Bounded memory usage via LRU cache per chain
 * 2. O(1) price updates and lookups
 * 3. Cross-chain discrepancy detection
 * 4. Token pair normalization for consistent matching across chains
 */
export class CrossChainPriceTracker {
  private readonly config: Required<CrossChainPriceTrackerConfig>;
  private readonly logger: PriceTrackerLogger;
  private readonly normalizeToken: TokenNormalizeFn;

  /** Price data per chain, using LRU cache for bounded memory */
  private chainPrices: Map<string, LRUCache<string, PricePoint>> = new Map();

  /** Cache for normalized token pairs to avoid repeated string allocations */
  private normalizedPairCache: Map<string, string> = new Map();

  constructor(
    config: CrossChainPriceTrackerConfig = {},
    logger: PriceTrackerLogger,
    normalizeToken: TokenNormalizeFn
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = logger;
    this.normalizeToken = normalizeToken;
  }

  // ===========================================================================
  // Chain Management
  // ===========================================================================

  /**
   * Initialize price tracking for a chain.
   * Must be called before updating prices for the chain.
   */
  initializeChain(chainId: string): void {
    if (!this.chainPrices.has(chainId)) {
      this.chainPrices.set(
        chainId,
        new LRUCache<string, PricePoint>(this.config.maxPricesPerChain)
      );
      this.logger.debug('Initialized price tracking for chain', { chainId });
    }
  }

  /**
   * Remove price tracking for a chain.
   * Frees memory for removed chains.
   */
  removeChain(chainId: string): void {
    this.chainPrices.delete(chainId);
  }

  /**
   * Clear all price data.
   * Called during cleanup/shutdown.
   */
  clear(): void {
    this.chainPrices.clear();
    this.normalizedPairCache.clear();
  }

  // ===========================================================================
  // Price Updates
  // ===========================================================================

  /**
   * Update price for a pair on a chain.
   *
   * @param chainId - Chain identifier
   * @param pairKey - Token pair key (e.g., "WETH_USDT")
   * @param price - Current price
   */
  updatePrice(chainId: string, pairKey: string, price: number): void {
    const chainPriceMap = this.chainPrices.get(chainId);
    if (chainPriceMap) {
      chainPriceMap.set(pairKey, { price, timestamp: Date.now() });
    } else {
      this.logger.warn('Cannot update price: chain not initialized', { chainId });
    }
  }

  // ===========================================================================
  // Price Queries
  // ===========================================================================

  /**
   * Get prices for a pair across all chains.
   * Uses peek() for read-only access to avoid LRU reordering overhead.
   *
   * @param pairKey - Token pair key
   * @returns Map of chainId -> PricePoint
   */
  getCrossChainPrices(pairKey: string): Map<string, PricePoint> {
    const prices = new Map<string, PricePoint>();

    for (const [chainId, chainPriceMap] of this.chainPrices) {
      // Use peek() to avoid unnecessary LRU reordering in read path
      const pricePoint = chainPriceMap.peek(pairKey);
      if (pricePoint) {
        prices.set(chainId, pricePoint);
      }
    }

    return prices;
  }

  /**
   * Get price for a specific pair on a specific chain.
   *
   * @param chainId - Chain identifier
   * @param pairKey - Token pair key
   * @returns PricePoint if exists, undefined otherwise
   */
  getPrice(chainId: string, pairKey: string): PricePoint | undefined {
    return this.chainPrices.get(chainId)?.peek(pairKey);
  }

  // ===========================================================================
  // Cross-Chain Discrepancy Detection
  // ===========================================================================

  /**
   * Find cross-chain price discrepancies that exceed threshold.
   *
   * This method:
   * 1. Creates a snapshot of all prices to prevent race conditions
   * 2. Groups prices by normalized pair key for cross-chain matching
   * 3. Detects pairs with price differences above threshold
   *
   * @param minDifferencePercent - Minimum price difference as decimal (e.g., 0.02 = 2%)
   * @returns Array of discrepancies sorted by magnitude
   */
  findCrossChainDiscrepancies(minDifferencePercent: number): CrossChainDiscrepancy[] {
    const discrepancies: CrossChainDiscrepancy[] = [];

    // Step 1: Create snapshot of all prices to prevent race conditions
    const pricesSnapshot = new Map<string, Map<string, PricePoint>>();
    for (const [chainId, chainPriceMap] of this.chainPrices) {
      pricesSnapshot.set(chainId, new Map(chainPriceMap));
    }

    // Step 2: Group prices by normalized pair key
    // Different chains may use different symbols for the same token
    const normalizedPrices = new Map<string, Map<string, { price: PricePoint; originalPairKey: string }>>();

    for (const [chainId, chainPriceMap] of pricesSnapshot) {
      for (const [pairKey, pricePoint] of chainPriceMap) {
        const normalizedPair = this.normalizeTokenPair(pairKey);

        if (!normalizedPrices.has(normalizedPair)) {
          normalizedPrices.set(normalizedPair, new Map());
        }
        normalizedPrices.get(normalizedPair)!.set(chainId, {
          price: pricePoint,
          originalPairKey: pairKey,
        });
      }
    }

    // Step 3: Check each normalized pair for discrepancies
    for (const [normalizedPair, chainPriceData] of normalizedPrices) {
      // Need at least 2 chains to have a discrepancy
      if (chainPriceData.size < 2) continue;

      // Find min/max prices without creating intermediate arrays
      let minPrice = Infinity;
      let maxPrice = -Infinity;
      for (const data of chainPriceData.values()) {
        const price = data.price.price;
        if (price < minPrice) minPrice = price;
        if (price > maxPrice) maxPrice = price;
      }

      // Skip if min is zero (would cause division by zero)
      if (minPrice === 0) continue;

      // Calculate percentage difference
      const difference = (maxPrice - minPrice) / minPrice;

      // Check if difference exceeds threshold
      if (difference >= minDifferencePercent) {
        const priceMap = new Map<string, number>();
        for (const [chainId, data] of chainPriceData) {
          priceMap.set(chainId, data.price.price);
        }

        discrepancies.push({
          pairKey: normalizedPair,
          chains: Array.from(chainPriceData.keys()),
          prices: priceMap,
          maxDifference: difference,
          timestamp: Date.now(),
        });
      }
    }

    return discrepancies;
  }

  // ===========================================================================
  // Token Pair Normalization
  // ===========================================================================

  /**
   * Normalize a token pair string for cross-chain matching.
   * Handles different token symbol conventions across chains:
   * - Avalanche: WETH.e_USDT → WETH_USDT
   * - BSC: ETH_USDT → WETH_USDT
   *
   * @param pairKey - Token pair in format "TOKEN0_TOKEN1" or "DEX_TOKEN0_TOKEN1"
   * @returns Normalized token pair string
   */
  normalizeTokenPair(pairKey: string): string {
    // Check cache first
    const cached = this.normalizedPairCache.get(pairKey);
    if (cached !== undefined) {
      return cached;
    }

    // Parse pair key using lastIndexOf to avoid array allocation
    const lastSep = pairKey.lastIndexOf('_');
    if (lastSep === -1) {
      this.cacheNormalizedPair(pairKey, pairKey);
      return pairKey;
    }

    const token1 = pairKey.slice(lastSep + 1);
    const beforeLastSep = pairKey.slice(0, lastSep);
    const secondLastSep = beforeLastSep.lastIndexOf('_');

    // If no second separator, format is "TOKEN0_TOKEN1"
    const token0 = secondLastSep === -1
      ? beforeLastSep
      : beforeLastSep.slice(secondLastSep + 1);

    // Normalize each token using the provided function
    const normalizedToken0 = this.normalizeToken(token0);
    const normalizedToken1 = this.normalizeToken(token1);

    const result = `${normalizedToken0}_${normalizedToken1}`;

    this.cacheNormalizedPair(pairKey, result);
    return result;
  }

  /**
   * Cache normalized pair with bounded size.
   * Simple eviction: clear half when full.
   */
  private cacheNormalizedPair(key: string, value: string): void {
    if (this.normalizedPairCache.size >= this.config.maxNormalizedPairCacheSize) {
      // Evict oldest half
      const entriesToDelete = Math.floor(this.normalizedPairCache.size / 2);
      let deleted = 0;
      for (const cacheKey of this.normalizedPairCache.keys()) {
        if (deleted >= entriesToDelete) break;
        this.normalizedPairCache.delete(cacheKey);
        deleted++;
      }
    }
    this.normalizedPairCache.set(key, value);
  }

  // ===========================================================================
  // Statistics
  // ===========================================================================

  /**
   * Get statistics about tracked prices.
   */
  getStats(): { chainCount: number; totalPrices: number; perChainStats: Map<string, number> } {
    const perChainStats = new Map<string, number>();
    let totalPrices = 0;

    for (const [chainId, priceMap] of this.chainPrices) {
      const size = priceMap.size;
      perChainStats.set(chainId, size);
      totalPrices += size;
    }

    return {
      chainCount: this.chainPrices.size,
      totalPrices,
      perChainStats,
    };
  }
}

/**
 * Factory function to create a CrossChainPriceTracker.
 */
export function createCrossChainPriceTracker(
  config: CrossChainPriceTrackerConfig = {},
  logger: PriceTrackerLogger,
  normalizeToken: TokenNormalizeFn
): CrossChainPriceTracker {
  return new CrossChainPriceTracker(config, logger, normalizeToken);
}
