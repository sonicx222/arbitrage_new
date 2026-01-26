/**
 * OpportunityPublisher - Cross-Chain Opportunity Publishing
 *
 * ARCH-REFACTOR: Extracted from CrossChainDetectorService to provide a single
 * responsibility module for opportunity publishing with deduplication.
 *
 * Responsibilities:
 * - Publishing opportunities to Redis Streams
 * - Deduplication within configurable time window
 * - Cache management with TTL and size limits
 * - Converting cross-chain opportunities to ArbitrageOpportunity format
 *
 * Design Principles:
 * - Factory function for dependency injection
 * - Deterministic deduplication keys
 * - Bounded cache to prevent memory bloat
 *
 * @see ADR-002: Redis Streams over Pub/Sub
 * @see ADR-014: Modular Detector Components
 */

import {
  RedisStreamsClient,
  PerformanceLogger,
} from '@arbitrage/core';
import { ArbitrageOpportunity } from '@arbitrage/types';
// TYPE-CONSOLIDATION: Import shared types instead of duplicating
import { Logger, CrossChainOpportunity } from './types';

// =============================================================================
// Types
// =============================================================================

// Logger and CrossChainOpportunity are now imported from ./types for consistency
export type { Logger, CrossChainOpportunity };

/** Configuration for OpportunityPublisher */
export interface OpportunityPublisherConfig {
  /** Redis Streams client */
  streamsClient: RedisStreamsClient;

  /** Performance logger */
  perfLogger: PerformanceLogger;

  /** Logger for output */
  logger: Logger;

  /** Deduplication window in ms (default: 5000) */
  dedupeWindowMs?: number;

  /** Minimum profit improvement to republish (default: 0.1 = 10%) */
  minProfitImprovement?: number;

  /** Maximum cache size (default: 1000) */
  maxCacheSize?: number;

  /** Cache TTL in ms (default: 10 minutes) */
  cacheTtlMs?: number;

  /**
   * FIX #3: Default trade size in USD for profit calculation (default: 1000)
   * Used to calculate actual token amounts instead of hardcoded 1 token.
   */
  defaultTradeSizeUsd?: number;
}

/** Public interface for OpportunityPublisher */
export interface OpportunityPublisher {
  /** Publish a cross-chain opportunity */
  publish(opportunity: CrossChainOpportunity): Promise<boolean>;

  /** Get cache size */
  getCacheSize(): number;

  /** Force cache cleanup */
  cleanup(): void;

  /** Clear all cached opportunities */
  clear(): void;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_DEDUPE_WINDOW_MS = 5000;
const DEFAULT_MIN_PROFIT_IMPROVEMENT = 0.1;
const DEFAULT_MAX_CACHE_SIZE = 1000;
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_TRADE_SIZE_USD = 1000; // FIX #3: Default trade size for profit calculation

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create an OpportunityPublisher instance.
 *
 * @param config - Publisher configuration
 * @returns OpportunityPublisher instance
 */
export function createOpportunityPublisher(config: OpportunityPublisherConfig): OpportunityPublisher {
  const {
    streamsClient,
    perfLogger,
    logger,
    dedupeWindowMs = DEFAULT_DEDUPE_WINDOW_MS,
    minProfitImprovement = DEFAULT_MIN_PROFIT_IMPROVEMENT,
    maxCacheSize = DEFAULT_MAX_CACHE_SIZE,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    defaultTradeSizeUsd = DEFAULT_TRADE_SIZE_USD, // FIX #3
  } = config;

  const opportunitiesCache = new Map<string, CrossChainOpportunity>();

  // ===========================================================================
  // Deduplication
  // ===========================================================================

  /**
   * Generate deterministic deduplication key for an opportunity.
   * FIX 6.2: Document key format - uses '-' as separator consistently.
   * Format: "sourceChain-targetChain-token" e.g., "ethereum-arbitrum-WETH/USDC"
   */
  function generateDedupeKey(opportunity: CrossChainOpportunity): string {
    return `${opportunity.sourceChain}-${opportunity.targetChain}-${opportunity.token}`;
  }

  /**
   * Check if opportunity should be published (not a duplicate or improved).
   */
  function shouldPublish(opportunity: CrossChainOpportunity, dedupeKey: string): boolean {
    const existingOpp = opportunitiesCache.get(dedupeKey);

    if (!existingOpp) {
      return true;
    }

    // Check if within deduplication window
    const age = Date.now() - existingOpp.createdAt;
    if (age >= dedupeWindowMs) {
      return true;
    }

    // Only republish if profit improved significantly
    // FIX 4.1: Comprehensive edge case handling for profit improvement calculation
    let profitImprovement = 0;

    if (existingOpp.netProfit > 0 && opportunity.netProfit > 0) {
      // Both positive: calculate relative improvement
      profitImprovement = (opportunity.netProfit - existingOpp.netProfit) / existingOpp.netProfit;
    } else if (existingOpp.netProfit <= 0 && opportunity.netProfit > 0) {
      // New is profitable, old wasn't: always republish (significant improvement)
      profitImprovement = 1.0;
    } else if (existingOpp.netProfit > 0 && opportunity.netProfit <= 0) {
      // New is worse (unprofitable): don't republish
      profitImprovement = -1.0;
    } else {
      // Both non-positive: don't republish unprofitable opportunities
      profitImprovement = 0;
    }

    if (profitImprovement >= minProfitImprovement) {
      return true;
    }

    logger.debug('Skipping duplicate opportunity', {
      dedupeKey,
      ageMs: age,
      profitImprovement: `${(profitImprovement * 100).toFixed(1)}%`,
    });

    return false;
  }

  // ===========================================================================
  // Publishing
  // ===========================================================================

  /**
   * Convert cross-chain opportunity to ArbitrageOpportunity format.
   *
   * FIX #3: Calculate actual token amounts based on trade size and source price
   * instead of hardcoding 1 token. This ensures the execution engine receives
   * accurate profit estimates.
   */
  function toArbitrageOpportunity(opportunity: CrossChainOpportunity): ArbitrageOpportunity {
    // FIX #3: Calculate actual token amount based on trade size and price
    // If sourcePrice is 0 or invalid, fall back to 1 token to avoid division by zero
    const sourcePrice = opportunity.sourcePrice > 0 ? opportunity.sourcePrice : 1;
    const amountInTokens = defaultTradeSizeUsd / sourcePrice;

    // Convert to wei (18 decimals) - use BigInt for precision
    // Guard against unreasonably large amounts that could overflow
    const MAX_AMOUNT_IN_TOKENS = 1e12;
    const safeAmountInTokens = Math.min(amountInTokens, MAX_AMOUNT_IN_TOKENS);
    const amountInWei = BigInt(Math.floor(safeAmountInTokens * 1e18)).toString();

    // Calculate expected profit in token units
    const expectedProfitInTokens = (opportunity.percentageDiff / 100) * safeAmountInTokens;

    // Extract tokens from token string (format: "TOKEN0/TOKEN1")
    const tokenParts = opportunity.token.split('/');
    const tokenIn = tokenParts[0] || opportunity.token;
    const tokenOut = tokenParts[1] || opportunity.token;

    return {
      id: `cross-chain-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
      type: 'cross-chain',
      buyDex: opportunity.sourceDex,
      sellDex: opportunity.targetDex,
      buyChain: opportunity.sourceChain,
      sellChain: opportunity.targetChain,
      tokenIn,
      tokenOut,
      amountIn: amountInWei,
      expectedProfit: expectedProfitInTokens,
      profitPercentage: opportunity.percentageDiff / 100,
      gasEstimate: '0', // Cross-chain, gas estimated separately
      confidence: opportunity.confidence,
      timestamp: Date.now(),
      blockNumber: 0, // Cross-chain
      bridgeRequired: true,
      bridgeCost: opportunity.bridgeCost,
    };
  }

  /**
   * Publish a cross-chain opportunity.
   *
   * @returns true if published, false if deduplicated
   */
  async function publish(opportunity: CrossChainOpportunity): Promise<boolean> {
    const dedupeKey = generateDedupeKey(opportunity);

    if (!shouldPublish(opportunity, dedupeKey)) {
      return false;
    }

    const arbitrageOpp = toArbitrageOpportunity(opportunity);

    try {
      // FIX 2.2: Use xaddWithLimit to prevent unbounded stream growth
      // STREAM_MAX_LENGTHS[OPPORTUNITIES] = 10000 per redis-streams.ts
      await streamsClient.xaddWithLimit(
        RedisStreamsClient.STREAMS.OPPORTUNITIES,
        arbitrageOpp
      );

      perfLogger.logArbitrageOpportunity(arbitrageOpp);

      // Cache with timestamp for deduplication
      opportunitiesCache.set(dedupeKey, {
        ...opportunity,
        createdAt: Date.now(),
      });

      // Cleanup if cache is getting large
      if (opportunitiesCache.size > maxCacheSize) {
        cleanup();
      }

      return true;
    } catch (error) {
      logger.error('Failed to publish arbitrage opportunity', { error: (error as Error).message });
      return false;
    }
  }

  // ===========================================================================
  // Cache Management
  // ===========================================================================

  /**
   * Get current cache size.
   */
  function getCacheSize(): number {
    return opportunitiesCache.size;
  }

  /**
   * Clean old entries from opportunity cache.
   */
  function cleanup(): void {
    const now = Date.now();

    // First pass: remove old entries by TTL
    for (const [id, opp] of opportunitiesCache) {
      if (opp.createdAt && (now - opp.createdAt) > cacheTtlMs) {
        opportunitiesCache.delete(id);
      }
    }

    // Second pass: if still over limit, remove oldest entries
    if (opportunitiesCache.size > maxCacheSize) {
      const entries = Array.from(opportunitiesCache.entries());
      entries.sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));

      const toRemove = entries.slice(0, entries.length - maxCacheSize);
      for (const [id] of toRemove) {
        opportunitiesCache.delete(id);
      }

      logger.debug('Trimmed opportunity cache', {
        removed: toRemove.length,
        remaining: opportunitiesCache.size,
      });
    }
  }

  /**
   * Clear all cached opportunities.
   */
  function clear(): void {
    opportunitiesCache.clear();
    logger.info('OpportunityPublisher cache cleared');
  }

  return {
    publish,
    getCacheSize,
    cleanup,
    clear,
  };
}
