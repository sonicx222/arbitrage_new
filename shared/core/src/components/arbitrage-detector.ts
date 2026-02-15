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
  getBlockTimeMs,
  calculatePriceDifferencePercent,
  type PriceSource,
  type ProfitCalculationResult,
} from './price-calculator';

import { resolveFeeValue as resolveFee } from '../utils/fee-utils';

import type { PairSnapshot } from './pair-repository';

/**
 * Module-level counter for generating unique opportunity IDs.
 * Combined with pair addresses + timestamp, collisions are impossible.
 * JS numbers are precise up to 2^53, so this wraps safely.
 */
let _opCounter = 0;

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
  const blockTimeMs = getBlockTimeMs(chain);

  // FIX 4.2: Calculate confidence with data freshness, guarding against invalid values
  // If blockNumber is in the future (data corruption/clock skew), use 0 age (fresh data)
  // The Math.max ensures we never pass negative ages which could produce NaN
  const calculateAge = (blockNumber: number | undefined): number => {
    if (!blockNumber || blockNumber <= 0) return 0;
    const estimatedTimestamp = blockNumber * blockTimeMs;
    // Guard against future blocks (corruption) - treat as fresh data
    if (estimatedTimestamp > timestamp) return 0;
    return timestamp - estimatedTimestamp;
  };

  const dataAge = Math.max(0, Math.max(
    calculateAge(pair1.blockNumber),
    calculateAge(pair2.blockNumber)
  ));

  // Guard against NaN/Infinity in confidence calculation
  const rawConfidence = calculateConfidence(grossSpread, dataAge, chainConfig.expiryMs);
  const confidence = Number.isFinite(rawConfidence) ? rawConfidence : 0.5; // Default to 50% if invalid

  // Build opportunity
  const opportunity: ArbitrageOpportunityData = {
    id: `${pair1.address}-${pair2.address}-${timestamp}-${++_opCounter}`,
    type: pair1.dex === pair2.dex ? 'intra-dex' : 'cross-dex',
    chain,
    buyDex: buyFromPair1 ? pair1.dex : pair2.dex,
    sellDex: buyFromPair1 ? pair2.dex : pair1.dex,
    buyPair: buyFromPair1 ? pair1.address : pair2.address,
    sellPair: buyFromPair1 ? pair2.address : pair1.address,
    token0: pair1.token0,
    token1: pair1.token1,
    buyPrice: Math.min(price1, price2),
    sellPrice: Math.max(price1, price2),
    profitPercentage: netProfit * 100,
    expectedProfit: netProfit,
    confidence: Math.min(confidence, chainConfig.confidence),
    timestamp,
    expiresAt: timestamp + chainConfig.expiryMs,
    gasEstimate: chainConfig.gasEstimate,
  };

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
  return opportunities.sort((a, b) => b.expectedProfit - a.expectedProfit);
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
    'ethereum', 'polygon', 'arbitrum', 'optimism', 'base', 'bsc', 'avalanche', 'solana'
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
  minProfitPct: number = MIN_CROSS_CHAIN_PROFIT
): CrossChainOpportunityResult | null {
  if (chainPrices.length < 2) {
    return null;
  }

  // Sort by price to find best buy/sell
  const sortedPrices = [...chainPrices].sort((a, b) => a.price - b.price);

  const lowestPrice = sortedPrices[0];
  const highestPrice = sortedPrices[sortedPrices.length - 1];

  const priceDiff = highestPrice.price - lowestPrice.price;
  const percentageDiff = calculatePriceDifferencePercent(lowestPrice.price, highestPrice.price) * 100;

  // Calculate net profit after bridge cost
  const netProfit = priceDiff - bridgeCost;

  // Check if profitable
  if (netProfit <= minProfitPct * lowestPrice.price) {
    return null;
  }

  // Calculate confidence based on price difference and data freshness
  const confidence = calculateCrossChainConfidence(lowestPrice, highestPrice);

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
  highPrice: ChainPriceData
): number {
  // Base confidence on price difference
  let confidence = Math.min(highPrice.price / lowPrice.price - 1, 0.5) * 2;

  // Apply freshness penalty (maxAgeMs = 10 seconds)
  const maxAgeMs = 10000;
  const ageMs = Date.now() - lowPrice.timestamp;
  const freshnessScore = Math.max(0.5, 1.0 - ageMs / maxAgeMs);
  confidence *= freshnessScore;

  // Cap at 95%
  return Math.min(confidence, 0.95);
}
