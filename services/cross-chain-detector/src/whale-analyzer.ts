/**
 * Whale Analyzer
 *
 * Extracted from detector.ts as part of Finding #7 refactoring to reduce file size.
 * Handles whale transaction analysis and whale-induced opportunity detection:
 * - Token parsing from whale transactions (multiple formats)
 * - Recording whale activity to WhaleActivityTracker
 * - Triggering immediate cross-chain detection for super whales
 * - Rate limiting whale-triggered detection via OperationGuard
 *
 * Performance Note (Constraint Compliance):
 * - NOT on hot path — triggered by whale events (infrequent, async)
 * - Dependencies injected via constructor (one-time cost)
 * - Uses callbacks for parent methods (findArbitrageInPrices, publishArbitrageOpportunity)
 *
 * @see detector.ts (consumer)
 * @see Finding #7 in services-deep-analysis.md
 */

import {
  type OperationGuard,
  type WhaleActivityTracker,
  type WhaleActivitySummary,
  type TrackedWhaleTransaction,
} from '@arbitrage/core';
import {
  ARBITRAGE_CONFIG,
  normalizeTokenForCrossChain,
  getDefaultQuoteToken,
} from '@arbitrage/config';
import type { WhaleTransaction, ILogger } from '@arbitrage/types';
import type { PriceDataManager, PricePoint } from './price-data-manager';
import type {
  CrossChainOpportunity,
  WhaleAnalysisConfig,
} from './types';
import { TOKEN_PAIR_INTERNAL_SEPARATOR } from './types';

// =============================================================================
// Types
// =============================================================================


/**
 * Dependencies for WhaleAnalyzer.
 *
 * Design: Uses constructor injection with getters for nullable services.
 * - Direct references for immutable/long-lived objects (logger, config)
 * - Getter functions for services that may be null during lifecycle
 * - Callbacks for parent detector methods that the analyzer needs to invoke
 */
export interface WhaleAnalyzerDeps {
  /** Logger instance */
  logger: ILogger;
  /** Whale analysis config (thresholds, boosts) */
  whaleConfig: WhaleAnalysisConfig;
  /** Whale detection rate limiter */
  whaleGuard: OperationGuard;

  // Getter functions for nullable services
  /** Get whale activity tracker (may be null before initialization) */
  getWhaleTracker: () => WhaleActivityTracker | null;
  /** Get price data manager (may be null before initialization) */
  getPriceDataManager: () => PriceDataManager | null;

  // Callbacks for parent detector methods
  /**
   * Find arbitrage opportunities in price points.
   * Delegates to detector's core detection algorithm.
   */
  findArbitrageInPrices: (
    chainPrices: PricePoint[],
    whaleData?: WhaleActivitySummary,
    whaleTx?: WhaleTransaction,
  ) => CrossChainOpportunity[];
  /**
   * Publish a detected arbitrage opportunity.
   * Delegates to detector's publishing pipeline.
   */
  publishArbitrageOpportunity: (opportunity: CrossChainOpportunity) => Promise<void>;
}

// =============================================================================
// WhaleAnalyzer
// =============================================================================

/**
 * Analyzes whale transactions for cross-chain arbitrage opportunities.
 *
 * Responsibilities:
 * 1. Parse whale transaction tokens (handles multiple formats)
 * 2. Record transactions in WhaleActivityTracker
 * 3. Detect super whale events and trigger immediate opportunity scans
 * 4. Rate-limit whale-triggered detection to prevent DoS
 *
 * Hot-path note:
 * - analyzeWhaleImpact is NOT on hot path (triggered by whale events)
 * - detectWhaleInducedOpportunities is NOT on hot path (rate-limited, async)
 */
export class WhaleAnalyzer {
  private readonly logger: ILogger;
  private readonly whaleConfig: WhaleAnalysisConfig;
  private readonly whaleGuard: OperationGuard;
  private readonly getWhaleTracker: () => WhaleActivityTracker | null;
  private readonly getPriceDataManager: () => PriceDataManager | null;
  private readonly findArbitrageInPrices: WhaleAnalyzerDeps['findArbitrageInPrices'];
  private readonly publishArbitrageOpportunity: WhaleAnalyzerDeps['publishArbitrageOpportunity'];

  constructor(deps: WhaleAnalyzerDeps) {
    this.logger = deps.logger;
    this.whaleConfig = deps.whaleConfig;
    this.whaleGuard = deps.whaleGuard;
    this.getWhaleTracker = deps.getWhaleTracker;
    this.getPriceDataManager = deps.getPriceDataManager;
    this.findArbitrageInPrices = deps.findArbitrageInPrices;
    this.publishArbitrageOpportunity = deps.publishArbitrageOpportunity;
  }

  /**
   * Phase 3: Analyze whale transaction impact on cross-chain opportunities.
   * Records whale activity to tracker and triggers immediate detection for super whales.
   */
  async analyzeWhaleImpact(whaleTx: WhaleTransaction): Promise<void> {
    const whaleTracker = this.getWhaleTracker();
    if (!whaleTracker) {
      this.logger.debug('Whale tracker not initialized, skipping impact analysis');
      return;
    }

    try {
      // Convert WhaleTransaction to TrackedWhaleTransaction format
      // FIX 4.3: Improved token parsing - handle multiple formats:
      // - "WETH/USDC" (standard pair format)
      // - "WETH_USDC" (underscore separator)
      // - "WETH" (single token - use chain-specific quote token)

      let baseToken: string;
      let quoteToken: string;

      // BUG-FIX: More robust token parsing with validation for edge cases
      // Handle multiple formats: "TOKEN0/TOKEN1", "TOKEN0_TOKEN1", "DEX_TOKEN0_TOKEN1", "TOKEN"
      const tokenString = whaleTx.token.trim();

      if (tokenString.includes('/')) {
        // Format: "TOKEN0/TOKEN1"
        const tokenParts = tokenString.split('/').filter((p: string) => p.trim().length > 0);
        baseToken = tokenParts[0]?.trim() || tokenString;
        quoteToken = tokenParts[1]?.trim() || getDefaultQuoteToken(whaleTx.chain);
      } else if (tokenString.includes('_')) {
        // Format: "TOKEN0_TOKEN1" or "DEX_TOKEN0_TOKEN1"
        const tokenParts = tokenString.split('_').filter((p: string) => p.trim().length > 0);
        if (tokenParts.length >= 2) {
          // Take last two parts as tokens (handles DEX_TOKEN0_TOKEN1 format)
          baseToken = tokenParts[tokenParts.length - 2].trim();
          quoteToken = tokenParts[tokenParts.length - 1].trim();
        } else if (tokenParts.length === 1) {
          // Single part after filtering - treat as single token
          baseToken = tokenParts[0].trim();
          quoteToken = getDefaultQuoteToken(whaleTx.chain);
        } else {
          // Empty after filtering - use original
          baseToken = tokenString;
          quoteToken = getDefaultQuoteToken(whaleTx.chain);
        }
      } else {
        // Single token - common case is trading against stablecoins
        baseToken = tokenString;
        quoteToken = getDefaultQuoteToken(whaleTx.chain);
      }

      // Validate extracted tokens are non-empty
      if (!baseToken || baseToken.length === 0) {
        this.logger.warn('Invalid base token extracted from whale transaction', {
          originalToken: whaleTx.token,
          txHash: whaleTx.transactionHash,
        });
        baseToken = whaleTx.token;
      }
      if (!quoteToken || quoteToken.length === 0) {
        quoteToken = getDefaultQuoteToken(whaleTx.chain);
      }

      // Normalize tokens for consistency
      try {
        baseToken = normalizeTokenForCrossChain(baseToken) || baseToken;
        quoteToken = normalizeTokenForCrossChain(quoteToken) || quoteToken;
      } catch {
        // Keep original tokens if normalization fails
      }

      const trackedTx: TrackedWhaleTransaction = {
        transactionHash: whaleTx.transactionHash,
        walletAddress: whaleTx.address,
        chain: whaleTx.chain,
        dex: whaleTx.dex,
        pairAddress: whaleTx.token, // Token being traded (used as pair identifier)
        // FIX: Use actual token pair info instead of hardcoded USDC assumption
        tokenIn: whaleTx.direction === 'buy' ? quoteToken : baseToken,
        tokenOut: whaleTx.direction === 'buy' ? baseToken : quoteToken,
        amountIn: whaleTx.direction === 'buy' ? whaleTx.usdValue : whaleTx.amount,
        amountOut: whaleTx.direction === 'buy' ? whaleTx.amount : whaleTx.usdValue,
        usdValue: whaleTx.usdValue,
        direction: whaleTx.direction,
        priceImpact: whaleTx.impact,
        timestamp: whaleTx.timestamp,
      };

      // Record transaction in whale tracker
      whaleTracker.recordTransaction(trackedTx);

      // Get whale activity summary for this chain/token
      const summary = whaleTracker.getActivitySummary(whaleTx.token, whaleTx.chain);

      this.logger.debug('Whale transaction analyzed', {
        chain: whaleTx.chain,
        usdValue: whaleTx.usdValue,
        direction: whaleTx.direction,
        dominantDirection: summary.dominantDirection,
        netFlowUsd: summary.netFlowUsd,
        superWhaleCount: summary.superWhaleCount
      });

      // Phase 3: Trigger immediate detection for super whale or significant activity
      if (whaleTx.usdValue >= this.whaleConfig.superWhaleThresholdUsd ||
          Math.abs(summary.netFlowUsd) > this.whaleConfig.significantFlowThresholdUsd) {

        // P1-5 FIX: Use OperationGuard for rate limiting (prevents DoS via whale spam)
        const releaseWhaleGuard = this.whaleGuard.tryAcquire();
        if (!releaseWhaleGuard) {
          this.logger.debug('Whale detection rate limited, skipping', {
            remainingCooldownMs: this.whaleGuard.getRemainingCooldownMs(),
          });
          return;
        }

        try {
          this.logger.info('Super whale detected, triggering immediate opportunity scan', {
            token: whaleTx.token,
            chain: whaleTx.chain,
            usdValue: whaleTx.usdValue,
            isSuperWhale: whaleTx.usdValue >= this.whaleConfig.superWhaleThresholdUsd
          });

          // Trigger immediate cross-chain detection for this token
          await this.detectWhaleInducedOpportunities(whaleTx, summary);
        } finally {
          releaseWhaleGuard();
        }
      }
    } catch (error) {
      this.logger.error('Failed to analyze whale impact', {
        error: (error as Error).message,
        txHash: whaleTx.transactionHash
      });
    }
  }

  /**
   * Phase 3: Detect opportunities specifically triggered by whale activity.
   * Scans for cross-chain opportunities for the affected token with whale-boosted confidence.
   * DUPLICATION-I1: Now uses shared findArbitrageInPrices method.
   */
  private async detectWhaleInducedOpportunities(
    whaleTx: WhaleTransaction,
    summary: WhaleActivitySummary
  ): Promise<void> {
    const priceDataManager = this.getPriceDataManager();
    if (!priceDataManager || !ARBITRAGE_CONFIG.crossChainEnabled) return;

    // FIX 4.2: Validate whale token before processing
    if (!whaleTx.token || typeof whaleTx.token !== 'string' || whaleTx.token.trim().length === 0) {
      this.logger.debug('Skipping whale opportunity detection: invalid token', {
        txHash: whaleTx.transactionHash,
      });
      return;
    }

    try {
      // PERF-P1: Use indexed snapshot for O(1) lookups
      const indexedSnapshot = priceDataManager.createIndexedSnapshot();

      // FIX 4.2: WhaleTransaction.token is a single token (e.g., "WETH"), not a pair.
      // We need to find ALL pairs that contain this token and check for arbitrage.
      const normalizedWhaleToken = normalizeTokenForCrossChain(whaleTx.token);

      // FIX #13: Use exact token part matching instead of substring includes()
      // to prevent "ETH" from matching "WETH_USDC" via substring
      const matchingPairs: string[] = [];
      for (const tokenPair of indexedSnapshot.tokenPairs) {
        const tokenParts = tokenPair.split(TOKEN_PAIR_INTERNAL_SEPARATOR);
        if (tokenParts.some(part => part === normalizedWhaleToken)) {
          matchingPairs.push(tokenPair);
        }
      }

      if (matchingPairs.length === 0) {
        this.logger.debug('No pairs found for whale token', {
          token: whaleTx.token,
          normalized: normalizedWhaleToken,
        });
        return;
      }

      // Check each matching pair for cross-chain arbitrage
      for (const tokenPair of matchingPairs) {
        const chainPrices = indexedSnapshot.byToken.get(tokenPair);

        if (chainPrices && chainPrices.length >= 2) {
          // DUPLICATION-I1: Use shared method with whale data
          const opportunities = this.findArbitrageInPrices(chainPrices, summary, whaleTx);

          for (const opportunity of opportunities) {
            if (opportunity.confidence > ARBITRAGE_CONFIG.confidenceThreshold) {
              await this.publishArbitrageOpportunity(opportunity);
            }
          }
        }
      }
    } catch (error) {
      this.logger.error('Failed to detect whale-induced opportunities', {
        error: (error as Error).message,
        token: whaleTx.token,
      });
    }
  }
}
