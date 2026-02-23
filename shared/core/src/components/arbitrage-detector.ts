/**
 * ArbitrageDetector - Pure Functions for Arbitrage Detection
 *
 * ARCH-REFACTOR: Extracted from base-detector.ts and solana-detector.ts
 * to provide a single source of truth for arbitrage detection logic.
 *
 * Design Principles:
 * - Pure functions with no side effects
 * - 100% unit testable without mocks
 * - Uses PriceCalculator for all calculations
 * - Handles token order normalization
 *
 * @see .claude/plans/modularization-enhancement-plan.md
 */

import {
  calculatePriceFromReserves,
  calculateSpreadSafe,
  calculateNetProfit,
  calculateProfitBetweenSources,
  meetsThreshold,
  calculateConfidence,
  invertPrice,
  isValidPrice,
  calculatePriceDifferencePercent,
  type PriceSource,
  type ProfitCalculationResult,
} from './price-calculator';

import { resolveFeeValue as resolveFee } from '../utils/fee-utils';
import { ObjectPool } from '../utils/object-pool';
import { getOpportunityTimeoutMs } from '@arbitrage/config';
import { createLogger } from '../logger';
import type { LiquidityDepthAnalyzer } from '../analytics/liquidity-depth-analyzer';

// P2-16: Logger for enrichment adjustments (debug level, no hot-path overhead)
const detectorLogger = createLogger('arbitrage-detector');

import type { PairSnapshot } from './pair-repository';

// =============================================================================
// Fix #17: Slippage estimation cache to avoid redundant Newton's method
// computations for StableSwap pools (up to 256 iterations each).
// Cache key = pairAddress:tradeSizeUsd:side, TTL = 5s (prices change fast).
// @see docs/reports/PHASE1_DEEP_ANALYSIS_2026-02-22.md Finding #17
// =============================================================================
interface SlippageCacheEntry {
  slippagePercent: number;
  timestamp: number;
}

const SLIPPAGE_CACHE = new Map<string, SlippageCacheEntry>();
const SLIPPAGE_CACHE_MAX_SIZE = 500;
const SLIPPAGE_CACHE_TTL_MS = 5000;

/** Default time budget (ms) for liquidity enrichment in a single batch. */
const ENRICHMENT_TIME_BUDGET_MS = 20;

function getCachedSlippage(pair: string, tradeSizeUsd: number, side: string): number | undefined {
  const key = `${pair}:${tradeSizeUsd}:${side}`;
  const entry = SLIPPAGE_CACHE.get(key);
  if (entry && Date.now() - entry.timestamp < SLIPPAGE_CACHE_TTL_MS) {
    return entry.slippagePercent;
  }
  return undefined;
}

function setCachedSlippage(pair: string, tradeSizeUsd: number, side: string, slippagePercent: number): void {
  const key = `${pair}:${tradeSizeUsd}:${side}`;
  if (SLIPPAGE_CACHE.size >= SLIPPAGE_CACHE_MAX_SIZE) {
    const oldest = SLIPPAGE_CACHE.keys().next().value;
    if (oldest !== undefined) SLIPPAGE_CACHE.delete(oldest);
  }
  SLIPPAGE_CACHE.set(key, { slippagePercent, timestamp: Date.now() });
}

/**
 * Module-level counter for generating unique opportunity IDs.
 * Combined with pair addresses + timestamp, collisions are impossible.
 * JS numbers are precise up to 2^53, so this wraps safely.
 */
let _opCounter = 0;

/**
 * Object pool for ArbitrageOpportunityData to reduce GC pressure on the hot path.
 * At 1000+ price updates/sec, transient object allocations cause P99 latency spikes.
 */
const opportunityPool = new ObjectPool<ArbitrageOpportunityData>(
  () => ({
    id: '',
    type: 'cross-dex',
    chain: '',
    buyDex: '',
    sellDex: '',
    buyPair: '',
    sellPair: '',
    token0: '',
    token1: '',
    buyPrice: 0,
    sellPrice: 0,
    profitPercentage: 0,
    expectedProfit: 0,
    confidence: 0,
    timestamp: 0,
    expiresAt: 0,
    gasEstimate: '',
  }),
  (obj) => {
    obj.id = '';
    obj.type = 'cross-dex';
    obj.chain = '';
    obj.buyDex = '';
    obj.sellDex = '';
    obj.buyPair = '';
    obj.sellPair = '';
    obj.token0 = '';
    obj.token1 = '';
    obj.buyPrice = 0;
    obj.sellPrice = 0;
    obj.profitPercentage = 0;
    obj.expectedProfit = 0;
    obj.confidence = 0;
    obj.timestamp = 0;
    obj.expiresAt = 0;
    obj.gasEstimate = '';
    obj.optimalTradeSizeUsd = undefined;
    obj.estimatedSlippagePercent = undefined;
  },
  200 // pool capacity
);

/**
 * Release an ArbitrageOpportunityData back to the pool when no longer needed.
 * Callers that consume opportunities should call this after processing.
 */
export function releaseOpportunity(opp: ArbitrageOpportunityData): void {
  opportunityPool.release(opp);
}

/**
 * Get object pool stats for monitoring.
 */
export function getOpportunityPoolStats(): ReturnType<ObjectPool<ArbitrageOpportunityData>['getStats']> {
  return opportunityPool.getStats();
}

// =============================================================================
// Types
// =============================================================================

/**
 * Input for arbitrage detection between two pairs.
 */
export interface ArbitrageDetectionInput {
  /** First pair snapshot */
  pair1: PairSnapshot;
  /** Second pair snapshot */
  pair2: PairSnapshot;
  /** Minimum profit threshold (decimal, e.g., 0.003 = 0.3%) */
  minProfitThreshold: number;
  /** Chain configuration */
  chainConfig: {
    /** Gas estimate for execution */
    gasEstimate: string;
    /** Base confidence level */
    confidence: number;
    /** Opportunity expiry time in ms */
    expiryMs: number;
  };
  /** Current timestamp (optional, for testing) */
  timestamp?: number;
}

/**
 * Result of arbitrage detection.
 */
export interface ArbitrageDetectionResult {
  /** Whether an arbitrage opportunity was found */
  found: boolean;
  /** The opportunity if found */
  opportunity?: ArbitrageOpportunityData;
  /** Reason if no opportunity was found */
  reason?: string;
  /**
   * Intermediate calculation results for debugging only.
   * WARNING: Contains pricing internals. Opportunity publishers should strip
   * this field before external exposure (e.g., logging, API responses).
   */
  calculations?: {
    price1: number;
    price2: number;
    price2Adjusted: number;
    grossSpread: number;
    totalFees: number;
    netProfit: number;
    threshold: number;
  };
}

/**
 * Arbitrage opportunity data (pure data, no status management).
 */
export interface ArbitrageOpportunityData {
  /** Unique opportunity ID */
  id: string;
  /** Opportunity type */
  type: 'simple' | 'cross-dex' | 'intra-dex';
  /** Chain where opportunity exists */
  chain: string;
  /** DEX to buy from */
  buyDex: string;
  /** DEX to sell on */
  sellDex: string;
  /** Pair address to buy from */
  buyPair: string;
  /** Pair address to sell on */
  sellPair: string;
  /** First token address */
  token0: string;
  /** Second token address */
  token1: string;
  /** Price to buy at */
  buyPrice: number;
  /** Price to sell at */
  sellPrice: number;
  /** Net profit percentage (e.g., 0.5 = 0.5%) */
  profitPercentage: number;
  /** Net profit as decimal (e.g., 0.005 = 0.5%) */
  expectedProfit: number;
  /** Confidence score (0-1) */
  confidence: number;
  /** Detection timestamp */
  timestamp: number;
  /** Expiration timestamp */
  expiresAt: number;
  /** Estimated gas for execution */
  gasEstimate: string;
  /** Phase 0 Item 5: Optimal trade size in USD from LiquidityDepthAnalyzer */
  optimalTradeSizeUsd?: number;
  /** Phase 0 Item 5: Estimated slippage percent from LiquidityDepthAnalyzer */
  estimatedSlippagePercent?: number;
}

/**
 * Options for batch detection.
 */
export interface BatchDetectionOptions {
  /** Minimum profit threshold (decimal) */
  minProfitThreshold: number;
  /** Chain configuration */
  chainConfig: {
    gasEstimate: string;
    confidence: number;
    expiryMs: number;
  };
  /** Chain name */
  chain: string;
  /** Maximum opportunities to return */
  maxOpportunities?: number;
  /** Current timestamp (optional, for testing) */
  timestamp?: number;
  /** Phase 0 Item 5: Optional LiquidityDepthAnalyzer for trade sizing */
  liquidityAnalyzer?: LiquidityDepthAnalyzer | null;
  /** Phase 0 Item 5: Default trade value in USD for slippage estimation */
  defaultTradeSizeUsd?: number;
}

// =============================================================================
// Core Detection Functions
// =============================================================================

/**
 * Detect arbitrage opportunity between two pairs.
 * Pure function that returns opportunity data if found.
 *
 * @param input - Detection input parameters
 * @returns Detection result with opportunity if found
 */
export function detectArbitrage(input: ArbitrageDetectionInput): ArbitrageDetectionResult {
  const { pair1, pair2, minProfitThreshold, chainConfig } = input;
  const timestamp = input.timestamp ?? Date.now();

  // Calculate prices from reserves
  const price1 = calculatePriceFromReserves(pair1.reserve0, pair1.reserve1);
  const price2Raw = calculatePriceFromReserves(pair2.reserve0, pair2.reserve1);

  // Validate prices
  if (price1 === null || !isValidPrice(price1)) {
    return { found: false, reason: 'Invalid price for pair1' };
  }
  if (price2Raw === null || !isValidPrice(price2Raw)) {
    return { found: false, reason: 'Invalid price for pair2' };
  }

  // Adjust price for token order
  const isReversed = isReverseTokenOrder(pair1.token0, pair2.token0);
  const price2 = isReversed && price2Raw !== 0 ? invertPrice(price2Raw) : price2Raw;

  if (!isValidPrice(price2)) {
    return { found: false, reason: 'Invalid adjusted price for pair2' };
  }

  // Calculate spread and fees
  const grossSpread = calculateSpreadSafe(price1, price2);
  const fee1 = resolveFee(pair1.fee, pair1.dex);
  const fee2 = resolveFee(pair2.fee, pair2.dex);
  const netProfit = calculateNetProfit(grossSpread, fee1, fee2);

  // Store calculations for debugging
  const calculations = {
    price1,
    price2: price2Raw,
    price2Adjusted: price2,
    grossSpread,
    totalFees: fee1 + fee2,
    netProfit,
    threshold: minProfitThreshold,
  };

  // Check threshold
  if (!meetsThreshold(netProfit, minProfitThreshold)) {
    return {
      found: false,
      reason: `Net profit ${(netProfit * 100).toFixed(4)}% below threshold ${(minProfitThreshold * 100).toFixed(4)}%`,
      calculations,
    };
  }

  // Determine buy/sell direction
  const buyFromPair1 = price1 < price2;

  // Determine chain for chain-specific calculations
  const chain = extractChainFromDex(pair1.dex) || 'ethereum';

  // FIX #2: Use lastUpdated timestamp for data freshness instead of blockNumber * blockTimeMs.
  // The previous calculation was nonsensical: blockNumber is an absolute counter (e.g., 19M for
  // Ethereum), so multiplying by blockTimeMs produces absurd values (~228B ms). Instead, use the
  // pair's lastUpdated epoch timestamp which directly represents when data was last refreshed.
  const calculateAge = (pair: typeof pair1): number => {
    if (pair.lastUpdated && pair.lastUpdated > 0 && pair.lastUpdated <= timestamp) {
      return timestamp - pair.lastUpdated;
    }
    // No valid timestamp available - treat as fresh data (age=0)
    return 0;
  };

  const dataAge = Math.max(0, Math.max(
    calculateAge(pair1),
    calculateAge(pair2)
  ));

  // Guard against NaN/Infinity in confidence calculation
  const rawConfidence = calculateConfidence(grossSpread, dataAge, chainConfig.expiryMs);
  const confidence = Number.isFinite(rawConfidence) ? rawConfidence : 0.5; // Default to 50% if invalid

  // Build opportunity (from pool to reduce GC pressure)
  const opportunity = opportunityPool.acquire();
  opportunity.id = `${pair1.address}-${pair2.address}-${timestamp}-${++_opCounter}`;
  opportunity.type = pair1.dex === pair2.dex ? 'intra-dex' : 'cross-dex';
  opportunity.chain = chain;
  opportunity.buyDex = buyFromPair1 ? pair1.dex : pair2.dex;
  opportunity.sellDex = buyFromPair1 ? pair2.dex : pair1.dex;
  opportunity.buyPair = buyFromPair1 ? pair1.address : pair2.address;
  opportunity.sellPair = buyFromPair1 ? pair2.address : pair1.address;
  opportunity.token0 = pair1.token0;
  opportunity.token1 = pair1.token1;
  opportunity.buyPrice = Math.min(price1, price2);
  opportunity.sellPrice = Math.max(price1, price2);
  opportunity.profitPercentage = netProfit * 100;
  opportunity.expectedProfit = netProfit;
  opportunity.confidence = Math.min(confidence, chainConfig.confidence);
  opportunity.timestamp = timestamp;
  // P1-11: Use chain-aware opportunity timeout for expiry.
  // chainConfig.expiryMs is caller-provided (usually from DETECTOR_CONFIG), but
  // getOpportunityTimeoutMs() is the canonical per-chain timeout (e.g., Arbitrum 2s,
  // Solana 1s, Ethereum 30s). Use the tighter bound to prevent stale opportunities
  // on fast chains.
  // @see docs/reports/EXTENDED_DEEP_ANALYSIS_2026-02-23.md P1-11
  const chainAwareExpiryMs = getOpportunityTimeoutMs(chain);
  opportunity.expiresAt = timestamp + Math.min(chainConfig.expiryMs, chainAwareExpiryMs);
  opportunity.gasEstimate = chainConfig.gasEstimate;

  return {
    found: true,
    opportunity,
    calculations,
  };
}

/**
 * Detect arbitrage opportunities across multiple pairs for the same token combination.
 * Compares all pairs against each other to find opportunities.
 *
 * @param pairs - Array of pair snapshots for the same token combination
 * @param options - Detection options
 * @returns Array of detected opportunities
 */
export function detectArbitrageForTokenPair(
  pairs: PairSnapshot[],
  options: BatchDetectionOptions
): ArbitrageOpportunityData[] {
  const opportunities: ArbitrageOpportunityData[] = [];
  const maxOpportunities = options.maxOpportunities ?? 100;

  // Need at least 2 pairs for arbitrage
  if (pairs.length < 2) {
    return opportunities;
  }

  // Compare each pair against all others
  for (let i = 0; i < pairs.length && opportunities.length < maxOpportunities; i++) {
    for (let j = i + 1; j < pairs.length && opportunities.length < maxOpportunities; j++) {
      const result = detectArbitrage({
        pair1: pairs[i],
        pair2: pairs[j],
        minProfitThreshold: options.minProfitThreshold,
        chainConfig: options.chainConfig,
        timestamp: options.timestamp,
      });

      if (result.found && result.opportunity) {
        // Override chain from options
        result.opportunity.chain = options.chain;
        opportunities.push(result.opportunity);
      }
    }
  }

  // Sort by profit (highest first)
  opportunities.sort((a, b) => b.expectedProfit - a.expectedProfit);

  // Phase 0 Item 5: Enrich top candidates with liquidity depth analysis.
  // Done AFTER sorting to avoid paying the enrichment cost (0.5-5ms per opportunity)
  // inside the O(n^2) pair comparison loop. Only the top candidates need enrichment.
  // Fix #17: Time budget guard — skip remaining enrichment if budget exceeded.
  // StableSwap pools trigger 256-iteration Newton's method; a batch of 10 cache-miss
  // pools could push past 50ms without this guard.
  // @see docs/reports/PHASE1_DEEP_ANALYSIS_2026-02-22.md Finding #17
  if (options.liquidityAnalyzer) {
    const topK = Math.min(opportunities.length, maxOpportunities);
    const enrichStart = Date.now();
    for (let k = 0; k < topK; k++) {
      if (Date.now() - enrichStart > ENRICHMENT_TIME_BUDGET_MS) {
        break; // Time budget exceeded — remaining opportunities skip enrichment
      }
      enrichWithLiquidityData(
        opportunities[k],
        options.liquidityAnalyzer,
        options.defaultTradeSizeUsd ?? 1000,
      );
    }
  }

  return opportunities;
}

/**
 * Calculate profit between two price sources (convenience wrapper).
 *
 * @param source1 - First price source
 * @param source2 - Second price source
 * @returns Profit calculation result
 */
export function calculateArbitrageProfit(
  source1: PriceSource,
  source2: PriceSource
): ProfitCalculationResult {
  return calculateProfitBetweenSources(source1, source2);
}

// =============================================================================
// Phase 0 Item 5: Liquidity-Aware Trade Sizing
// =============================================================================

/**
 * Enrich a detected opportunity with liquidity depth analysis.
 *
 * Queries the LiquidityDepthAnalyzer for:
 * 1. Optimal trade size at the buy pair
 * 2. Estimated slippage for the given trade size at both buy and sell pairs
 *
 * Uses the WORSE of the two slippage estimates (buy and sell) to be conservative.
 * This prevents oversized trades that would erase profit through slippage and
 * prevents undersized trades that leave money on the table.
 *
 * @param opportunity - The detected opportunity to enrich (mutated in place)
 * @param analyzer - LiquidityDepthAnalyzer instance with pool data
 * @param defaultTradeSizeUsd - Default trade size for slippage estimation
 */
function enrichWithLiquidityData(
  opportunity: ArbitrageOpportunityData,
  analyzer: LiquidityDepthAnalyzer,
  defaultTradeSizeUsd: number,
): void {
  // Get depth analysis for the buy pair (this gives optimal trade size)
  const buyAnalysis = analyzer.analyzeDepth(opportunity.buyPair);
  if (buyAnalysis) {
    opportunity.optimalTradeSizeUsd = buyAnalysis.optimalTradeSizeUsd;
  }

  // Use optimal trade size if available, else default
  const tradeSizeUsd = opportunity.optimalTradeSizeUsd ?? defaultTradeSizeUsd;

  // Fix #17: Check slippage cache before calling analyzer.estimateSlippage().
  // StableSwap pools trigger 256-iteration Newton's method per call; caching
  // avoids redundant computation for the same pair+size within the TTL window.
  // @see docs/reports/PHASE1_DEEP_ANALYSIS_2026-02-22.md Finding #17
  let buySlippagePct = getCachedSlippage(opportunity.buyPair, tradeSizeUsd, 'buy');
  if (buySlippagePct === undefined) {
    const buySlippage = analyzer.estimateSlippage(opportunity.buyPair, tradeSizeUsd, 'buy');
    buySlippagePct = buySlippage?.slippagePercent ?? 0;
    setCachedSlippage(opportunity.buyPair, tradeSizeUsd, 'buy', buySlippagePct);
  }

  let sellSlippagePct = getCachedSlippage(opportunity.sellPair, tradeSizeUsd, 'sell');
  if (sellSlippagePct === undefined) {
    const sellSlippage = analyzer.estimateSlippage(opportunity.sellPair, tradeSizeUsd, 'sell');
    sellSlippagePct = sellSlippage?.slippagePercent ?? 0;
    setCachedSlippage(opportunity.sellPair, tradeSizeUsd, 'sell', sellSlippagePct);
  }
  const totalSlippage = buySlippagePct + sellSlippagePct;

  if (totalSlippage > 0) {
    opportunity.estimatedSlippagePercent = totalSlippage;

    // P2-16: Capture pre-adjustment values for logging
    const preProfitPct = opportunity.profitPercentage;
    const preConfidence = opportunity.confidence;

    // Adjust expected profit: subtract slippage (as decimal, not percent)
    const slippageDecimal = totalSlippage / 100;
    opportunity.expectedProfit = opportunity.expectedProfit - slippageDecimal;
    opportunity.profitPercentage = opportunity.expectedProfit * 100;

    // Reduce confidence if slippage eats most of the profit
    if (opportunity.expectedProfit <= 0) {
      opportunity.confidence *= 0.1; // Very low confidence if unprofitable after slippage
    } else if (slippageDecimal > opportunity.expectedProfit * 0.5) {
      opportunity.confidence *= 0.7; // Reduced confidence if slippage is >50% of profit
    }

    // P2-16: Log significant enrichment adjustments for debugging.
    // Only logs at debug level to avoid hot-path overhead.
    const profitReduction = preProfitPct - opportunity.profitPercentage;
    const confidenceReduction = preConfidence - opportunity.confidence;
    if (profitReduction > 0.1 || confidenceReduction > 0.1) {
      detectorLogger.debug('Enrichment adjusted opportunity', {
        id: opportunity.id,
        buyPair: opportunity.buyPair,
        sellPair: opportunity.sellPair,
        totalSlippage,
        profitBefore: preProfitPct.toFixed(4),
        profitAfter: opportunity.profitPercentage.toFixed(4),
        confidenceBefore: preConfidence.toFixed(3),
        confidenceAfter: opportunity.confidence.toFixed(3),
        optimalTradeSizeUsd: opportunity.optimalTradeSizeUsd,
      });
    }
  }
}

// =============================================================================
// Token Order Utilities
// =============================================================================

/**
 * Check if token order is reversed between two pairs.
 * Uses case-insensitive comparison.
 *
 * @param pair1Token0 - Token0 address from first pair
 * @param pair2Token0 - Token0 address from second pair
 * @returns True if token order is reversed
 */
export function isReverseTokenOrder(pair1Token0: string, pair2Token0: string): boolean {
  return pair1Token0.toLowerCase() !== pair2Token0.toLowerCase();
}

/**
 * Normalize token addresses to a canonical order.
 * Returns addresses sorted alphabetically (lowercase).
 *
 * @param tokenA - First token address
 * @param tokenB - Second token address
 * @returns Tuple of [lowerToken, higherToken]
 */
export function normalizeTokenOrder(tokenA: string, tokenB: string): [string, string] {
  const a = tokenA.toLowerCase();
  const b = tokenB.toLowerCase();
  return a < b ? [a, b] : [b, a];
}

// NOTE: getTokenPairKey has been consolidated into token-utils.ts
// Import from there or from the components index for canonical token pair key generation.

/**
 * Adjust price based on token order between pairs.
 * If token order is reversed, inverts the price.
 *
 * @param price - Original price
 * @param pair1Token0 - Token0 from reference pair
 * @param pair2Token0 - Token0 from comparison pair
 * @returns Adjusted price
 */
export function adjustPriceForTokenOrder(
  price: number,
  pair1Token0: string,
  pair2Token0: string
): number {
  if (isReverseTokenOrder(pair1Token0, pair2Token0) && price !== 0) {
    return invertPrice(price);
  }
  return price;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Extract chain name from DEX identifier.
 * DEX format is typically "chainname_dexname" or just "dexname".
 *
 * @param dex - DEX identifier
 * @returns Chain name or null
 */
function extractChainFromDex(dex: string): string | null {
  // Common DEX prefixes
  const chainPrefixes = [
    'ethereum', 'polygon', 'arbitrum', 'optimism', 'base', 'bsc', 'avalanche', 'fantom', 'zksync', 'linea', 'solana'
  ];

  const dexLower = dex.toLowerCase();

  for (const chain of chainPrefixes) {
    if (dexLower.startsWith(chain)) {
      return chain;
    }
  }

  // Map common DEX names to chains
  const dexToChain: Record<string, string> = {
    uniswap: 'ethereum',
    uniswapv2: 'ethereum',
    uniswapv3: 'ethereum',
    sushiswap: 'ethereum',
    curve: 'ethereum',
    balancer: 'ethereum',
    pancakeswap: 'bsc',
    quickswap: 'polygon',
    traderjoe: 'avalanche',
    raydium: 'solana',
    orca: 'solana',
    spookyswap: 'fantom',
    spiritswap: 'fantom',
    syncswap: 'zksync',
    mute: 'zksync',
    velocore: 'linea',
    horizondex: 'linea',
  };

  return dexToChain[dexLower] || null;
}

// =============================================================================
// Validation Functions
// =============================================================================

/**
 * Validate that a pair snapshot has all required data for detection.
 *
 * @param snapshot - Pair snapshot to validate
 * @returns True if valid
 */
export function isValidPairSnapshot(snapshot: PairSnapshot | null | undefined): snapshot is PairSnapshot {
  if (!snapshot) return false;
  if (!snapshot.address || !snapshot.dex) return false;
  if (!snapshot.token0 || !snapshot.token1) return false;
  if (!snapshot.reserve0 || !snapshot.reserve1) return false;
  if (snapshot.reserve0 === '0' || snapshot.reserve1 === '0') return false;
  return true;
}

/**
 * Validate detection input parameters.
 *
 * @param input - Detection input to validate
 * @returns Validation result with errors if any
 */
export function validateDetectionInput(input: ArbitrageDetectionInput): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!isValidPairSnapshot(input.pair1)) {
    errors.push('Invalid pair1 snapshot');
  }
  if (!isValidPairSnapshot(input.pair2)) {
    errors.push('Invalid pair2 snapshot');
  }
  if (typeof input.minProfitThreshold !== 'number' || input.minProfitThreshold < 0) {
    errors.push('Invalid minProfitThreshold');
  }
  if (!input.chainConfig) {
    errors.push('Missing chainConfig');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// =============================================================================
// Cross-Chain Arbitrage (migrated from arbitrage-calculator.ts)
// =============================================================================

/**
 * Price data for cross-chain arbitrage.
 */
export interface ChainPriceData {
  chain: string;
  dex: string;
  price: number;
  fee?: number;
  timestamp: number;
  pairKey?: string;
}

/**
 * Result of cross-chain arbitrage calculation.
 */
export interface CrossChainOpportunityResult {
  token: string;
  sourceChain: string;
  sourceDex: string;
  sourcePrice: number;
  targetChain: string;
  targetDex: string;
  targetPrice: number;
  priceDiff: number;
  percentageDiff: number;
  estimatedProfit: number;
  bridgeCost: number;
  netProfit: number;
  confidence: number;
}

/**
 * Default minimum profit percentage for cross-chain arbitrage.
 */
const MIN_CROSS_CHAIN_PROFIT = 0.003; // 0.3%

/**
 * Calculate cross-chain arbitrage opportunity.
 * Used by cross-chain-detector service.
 *
 * @param chainPrices - Array of price data from different chains
 * @param bridgeCost - Estimated bridge cost in USD
 * @param minProfitPct - Minimum profit percentage (default: 0.3%)
 * @returns CrossChainOpportunityResult or null if not profitable
 */
export function calculateCrossChainArbitrage(
  chainPrices: ChainPriceData[],
  bridgeCost: number,
  minProfitPct: number = MIN_CROSS_CHAIN_PROFIT,
  maxAgeMs?: number
): CrossChainOpportunityResult | null {
  if (chainPrices.length < 2) {
    return null;
  }

  // P2-19: O(n) min/max scan instead of O(n log n) spread+sort.
  // Only the lowest and highest prices are needed for cross-chain arbitrage.
  let lowestPrice = chainPrices[0];
  let highestPrice = chainPrices[0];
  for (let i = 1; i < chainPrices.length; i++) {
    if (chainPrices[i].price < lowestPrice.price) lowestPrice = chainPrices[i];
    if (chainPrices[i].price > highestPrice.price) highestPrice = chainPrices[i];
  }

  const priceDiff = highestPrice.price - lowestPrice.price;
  const percentageDiff = calculatePriceDifferencePercent(lowestPrice.price, highestPrice.price) * 100;

  // Account for DEX trading fees on both buy and sell sides
  // fee field is in decimal form (e.g. 0.003 = 0.3%), default to standard AMM 30bps
  const buyFee = lowestPrice.fee ?? 0.003;
  const sellFee = highestPrice.fee ?? 0.003;
  const tradingFeeCost = buyFee * lowestPrice.price + sellFee * highestPrice.price;

  // Calculate net profit after bridge cost and trading fees
  const netProfit = priceDiff - bridgeCost - tradingFeeCost;

  // Check if profitable
  if (netProfit <= minProfitPct * lowestPrice.price) {
    return null;
  }

  // Calculate confidence based on price difference and data freshness.
  // Use the minimum timeout of the two chains for staleness detection —
  // if either chain's data is stale, the cross-chain opportunity is unreliable.
  const effectiveMaxAgeMs = maxAgeMs ?? Math.min(
    getOpportunityTimeoutMs(lowestPrice.chain),
    getOpportunityTimeoutMs(highestPrice.chain)
  );
  const confidence = calculateCrossChainConfidence(lowestPrice, highestPrice, effectiveMaxAgeMs);

  return {
    token: lowestPrice.pairKey || 'UNKNOWN',
    sourceChain: lowestPrice.chain,
    sourceDex: lowestPrice.dex,
    sourcePrice: lowestPrice.price,
    targetChain: highestPrice.chain,
    targetDex: highestPrice.dex,
    targetPrice: highestPrice.price,
    priceDiff,
    percentageDiff,
    estimatedProfit: priceDiff,
    bridgeCost,
    netProfit,
    confidence,
  };
}

/**
 * Calculate confidence for cross-chain opportunity.
 * Based on price spread and data freshness.
 *
 * @param lowPrice - Lower price data point
 * @param highPrice - Higher price data point
 * @returns Confidence score 0-1
 */
function calculateCrossChainConfidence(
  lowPrice: ChainPriceData,
  highPrice: ChainPriceData,
  maxAgeMs = 10000
): number {
  // Base confidence on price difference
  let confidence = Math.min(highPrice.price / lowPrice.price - 1, 0.5) * 2;

  // Apply freshness penalty
  const ageMs = Date.now() - lowPrice.timestamp;
  const freshnessScore = Math.max(0.5, 1.0 - ageMs / maxAgeMs);
  confidence *= freshnessScore;

  // Cap at 95%
  return Math.min(confidence, 0.95);
}
