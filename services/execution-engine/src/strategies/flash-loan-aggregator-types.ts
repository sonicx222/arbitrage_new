/**
 * Flash Loan Aggregator Types
 *
 * Type definitions and interfaces for the flash loan protocol aggregator.
 *
 * The aggregator selects the optimal flash loan provider based on:
 * 1. Fees (50% weight) - Lower fees preferred
 * 2. Liquidity (30% weight) - Sufficient liquidity required
 * 3. Reliability (15% weight) - Historical success rate
 * 4. Latency (5% weight) - Faster execution preferred
 *
 * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Phase 2 Task 2.3
 */

import type { IFlashLoanProvider, FlashLoanProtocol, FlashLoanFeeInfo } from './flash-loan-providers/types';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import type { StrategyContext } from '../types';

// =============================================================================
// Provider Ranking Types
// =============================================================================

/**
 * Ranked provider with score and metadata
 */
export interface RankedProvider {
  /** The flash loan provider */
  provider: IFlashLoanProvider;

  /** Overall score (0-1, higher is better) */
  score: number;

  /** Fee information for this provider */
  fees: FlashLoanFeeInfo;

  /** Estimated available liquidity (if checked) */
  estimatedLiquidity?: bigint;

  /** Score breakdown for debugging */
  breakdown: {
    feeScore: number;
    liquidityScore: number;
    reliabilityScore: number;
    latencyScore: number;
  };
}

/**
 * Provider selection result
 */
export interface ProviderSelectionResult {
  /** Selected provider (null if none suitable) */
  provider: IFlashLoanProvider | null;

  /** All ranked providers considered */
  rankedProviders: RankedProvider[];

  /** Reason for selection/rejection */
  selectionReason: string;

  /** Whether on-chain liquidity check was performed */
  liquidityCheckPerformed: boolean;

  /** Selection latency in milliseconds */
  selectionLatencyMs: number;
}

/**
 * Cached ranking entry
 */
export interface CachedRanking {
  /** Ranked providers */
  rankings: RankedProvider[];

  /** Timestamp when ranking was created */
  timestamp: number;

  /** Chain for this ranking */
  chain: string;
}

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * Flash Loan Aggregator configuration
 */
export interface FlashLoanAggregatorConfig {
  /**
   * Threshold (in USD) above which to perform on-chain liquidity checks
   * Default: 100000 ($100K)
   */
  liquidityCheckThresholdUsd?: number;

  /**
   * TTL for cached rankings in milliseconds
   * Default: 30000 (30 seconds)
   */
  rankingCacheTtlMs?: number;

  /**
   * TTL for cached liquidity in milliseconds
   * Default: 300000 (5 minutes)
   */
  liquidityCacheTtlMs?: number;

  /**
   * Scoring weights for provider selection
   * Must sum to 1.0
   */
  weights?: {
    fees: number;        // Default: 0.5 (50%)
    liquidity: number;   // Default: 0.3 (30%)
    reliability: number; // Default: 0.15 (15%)
    latency: number;     // Default: 0.05 (5%)
  };

  /**
   * Maximum providers to consider per chain
   * Default: 5
   */
  maxProvidersToRank?: number;
}

/**
 * Aggregator configuration with defaults applied
 */
export interface ResolvedAggregatorConfig {
  liquidityCheckThresholdUsd: number;
  rankingCacheTtlMs: number;
  liquidityCacheTtlMs: number;
  weights: {
    fees: number;
    liquidity: number;
    reliability: number;
    latency: number;
  };
  maxProvidersToRank: number;
}

// =============================================================================
// Fallback Types
// =============================================================================

/**
 * Error classification for fallback decisions
 */
export enum FlashLoanErrorType {
  /** Insufficient liquidity in pool */
  INSUFFICIENT_LIQUIDITY = 'insufficient_liquidity',

  /** Fees too high or slippage exceeded */
  HIGH_FEES = 'high_fees',

  /** Transient error (network, timeout) */
  TRANSIENT = 'transient',

  /** Permanent error (validation, invalid path) */
  PERMANENT = 'permanent',

  /** Unknown error */
  UNKNOWN = 'unknown',
}

/**
 * Fallback context for retry decisions
 */
export interface FallbackContext {
  /** Current attempt number (1-indexed) */
  attemptNumber: number;

  /** Error from last attempt */
  lastError: Error;

  /** Provider that failed */
  failedProvider: IFlashLoanProvider;

  /** Remaining providers to try */
  remainingProviders: RankedProvider[];

  /** Original opportunity */
  opportunity: ArbitrageOpportunity;
}

/**
 * Fallback decision
 */
export interface FallbackDecision {
  /** Should retry with another provider */
  shouldRetry: boolean;

  /** Next provider to try (if retrying) */
  nextProvider: IFlashLoanProvider | null;

  /** Reason for decision */
  reason: string;

  /** Error type classification */
  errorType: FlashLoanErrorType;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Default configuration values
 */
export const DEFAULT_AGGREGATOR_CONFIG: ResolvedAggregatorConfig = {
  liquidityCheckThresholdUsd: 100000, // $100K
  rankingCacheTtlMs: 30000, // 30 seconds
  liquidityCacheTtlMs: 300000, // 5 minutes
  weights: {
    fees: 0.5,
    liquidity: 0.3,
    reliability: 0.15,
    latency: 0.05,
  },
  maxProvidersToRank: 5,
};

/**
 * Resolve configuration with defaults
 */
export function resolveAggregatorConfig(
  config?: FlashLoanAggregatorConfig
): ResolvedAggregatorConfig {
  return {
    liquidityCheckThresholdUsd: config?.liquidityCheckThresholdUsd ?? DEFAULT_AGGREGATOR_CONFIG.liquidityCheckThresholdUsd,
    rankingCacheTtlMs: config?.rankingCacheTtlMs ?? DEFAULT_AGGREGATOR_CONFIG.rankingCacheTtlMs,
    liquidityCacheTtlMs: config?.liquidityCacheTtlMs ?? DEFAULT_AGGREGATOR_CONFIG.liquidityCacheTtlMs,
    weights: config?.weights ?? DEFAULT_AGGREGATOR_CONFIG.weights,
    maxProvidersToRank: config?.maxProvidersToRank ?? DEFAULT_AGGREGATOR_CONFIG.maxProvidersToRank,
  };
}

/**
 * Validate scoring weights sum to 1.0
 */
export function validateWeights(weights: ResolvedAggregatorConfig['weights']): void {
  const sum = weights.fees + weights.liquidity + weights.reliability + weights.latency;
  const tolerance = 0.01; // Allow 1% tolerance for floating point

  if (Math.abs(sum - 1.0) > tolerance) {
    throw new Error(
      `Scoring weights must sum to 1.0 (got ${sum}). ` +
      `Fees: ${weights.fees}, Liquidity: ${weights.liquidity}, ` +
      `Reliability: ${weights.reliability}, Latency: ${weights.latency}`
    );
  }
}

/**
 * Type guard to check if error message indicates insufficient liquidity
 */
export function isInsufficientLiquidityError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes('insufficient liquidity') ||
    message.includes('exceeds pool capacity') ||
    message.includes('reserve too low') ||
    message.includes('not enough liquidity')
  );
}

/**
 * Type guard to check if error message indicates high fees/slippage
 */
export function isHighFeesError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes('fee too high') ||
    message.includes('slippage exceeded') ||
    message.includes('price impact too high')
  );
}

/**
 * Type guard to check if error is transient (retryable)
 */
export function isTransientError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes('timeout') ||
    message.includes('network error') ||
    message.includes('connection refused') ||
    message.includes('502') ||
    message.includes('503') ||
    message.includes('rate limit')
  );
}

/**
 * Type guard to check if error is permanent (not retryable)
 */
export function isPermanentError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes('invalid swap path') ||
    message.includes('token not supported') ||
    message.includes('router not approved') ||
    message.includes('contract reverted') ||
    message.includes('validation failed')
  );
}

/**
 * Classify error type for fallback decisions
 */
export function classifyError(error: Error): FlashLoanErrorType {
  if (isInsufficientLiquidityError(error)) {
    return FlashLoanErrorType.INSUFFICIENT_LIQUIDITY;
  }

  if (isHighFeesError(error)) {
    return FlashLoanErrorType.HIGH_FEES;
  }

  if (isPermanentError(error)) {
    return FlashLoanErrorType.PERMANENT;
  }

  if (isTransientError(error)) {
    return FlashLoanErrorType.TRANSIENT;
  }

  return FlashLoanErrorType.UNKNOWN;
}
