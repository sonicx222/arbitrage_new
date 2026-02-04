/**
 * Shared Types for Cross-Chain Detector Service
 *
 * Consolidates duplicate type definitions across modules to ensure consistency
 * and reduce maintenance burden.
 *
 * @see ADR-014: Modular Detector Components
 *
 * ## Phase 3 Type Consolidation Notes:
 *
 * The logger interface is now consolidated in @arbitrage/types (ILogger).
 * ModuleLogger is kept as a type alias for backward compatibility.
 *
 * @see shared/types/common.ts - ILogger definition
 */

import { PriceUpdate, ILogger } from '@arbitrage/types';
// P0-2 FIX: Import token normalization for consolidated normalizeTokenPair function
import { normalizeTokenForCrossChain } from '@arbitrage/config';

// =============================================================================
// Token Pair Format Constants and Utilities
// =============================================================================

/**
 * Token Pair Format Conventions:
 *
 * This codebase uses two token pair formats for different purposes:
 *
 * 1. **Internal/Storage Format** (underscore separator):
 *    - Used for: pairKey, IndexedSnapshot.tokenPairs, cache keys
 *    - Format: `TOKEN0_TOKEN1` (e.g., `WETH_USDC`)
 *    - Why: Compatible with file names, URL-safe, consistent with DEX naming
 *
 * 2. **Display/External Format** (slash separator):
 *    - Used for: CrossChainOpportunity.token, user-facing output
 *    - Format: `TOKEN0/TOKEN1` (e.g., `WETH/USDC`)
 *    - Why: Industry standard notation for trading pairs
 *
 * Use the utility functions below to convert between formats.
 */

/** Separator used for internal token pair storage keys */
export const TOKEN_PAIR_INTERNAL_SEPARATOR = '_';

/** Separator used for display/external token pair format */
export const TOKEN_PAIR_DISPLAY_SEPARATOR = '/';

/**
 * Convert internal token pair format to display format.
 * @param internalPair - Token pair in internal format (e.g., "WETH_USDC")
 * @returns Token pair in display format (e.g., "WETH/USDC")
 */
export function toDisplayTokenPair(internalPair: string): string {
  if (!internalPair || typeof internalPair !== 'string') {
    return internalPair;
  }
  // Split by internal separator, take last two parts (handles DEX_TOKEN0_TOKEN1)
  const parts = internalPair.split(TOKEN_PAIR_INTERNAL_SEPARATOR);
  if (parts.length >= 2) {
    const token0 = parts[parts.length - 2];
    const token1 = parts[parts.length - 1];
    return `${token0}${TOKEN_PAIR_DISPLAY_SEPARATOR}${token1}`;
  }
  return internalPair;
}

/**
 * Convert display token pair format to internal format.
 * @param displayPair - Token pair in display format (e.g., "WETH/USDC")
 * @returns Token pair in internal format (e.g., "WETH_USDC")
 */
export function toInternalTokenPair(displayPair: string): string {
  if (!displayPair || typeof displayPair !== 'string') {
    return displayPair;
  }
  return displayPair.replace(TOKEN_PAIR_DISPLAY_SEPARATOR, TOKEN_PAIR_INTERNAL_SEPARATOR);
}

/**
 * Normalize a token pair to internal format, handling both formats.
 * @param tokenPair - Token pair in either format
 * @returns Token pair in internal format (e.g., "WETH_USDC")
 */
export function normalizeToInternalFormat(tokenPair: string): string {
  if (!tokenPair || typeof tokenPair !== 'string') {
    return tokenPair;
  }
  // If it contains slash, convert to underscore
  if (tokenPair.includes(TOKEN_PAIR_DISPLAY_SEPARATOR)) {
    return toInternalTokenPair(tokenPair);
  }
  // Already in internal format or needs extraction from pairKey
  const parts = tokenPair.split(TOKEN_PAIR_INTERNAL_SEPARATOR);
  if (parts.length >= 2) {
    return `${parts[parts.length - 2]}${TOKEN_PAIR_INTERNAL_SEPARATOR}${parts[parts.length - 1]}`;
  }
  return tokenPair;
}

/**
 * Normalize a token pair for cross-chain matching.
 *
 * P0-2 FIX: Consolidated from detector.ts and price-data-manager.ts to eliminate duplication.
 *
 * Handles different token symbol conventions across chains:
 * - WETH.e (Avalanche) → WETH
 * - ETH (BSC) → WETH
 * - fUSDT (Fantom) → USDT
 * - BTCB (BSC) → WBTC
 *
 * P1-FIX 2.5: Handles DEX prefixes correctly by only normalizing the last 2 parts.
 * Format: "TOKEN0_TOKEN1" or "DEX_TOKEN0_TOKEN1"
 *
 * @param tokenPair - Token pair string in format "TOKEN0_TOKEN1" or "DEX_TOKEN0_TOKEN1"
 * @returns Normalized token pair string (always "TOKEN0_TOKEN1" format), or null if invalid
 */
export function normalizeTokenPair(tokenPair: string): string | null {
  if (!tokenPair || typeof tokenPair !== 'string') {
    return null;
  }

  const parts = tokenPair.split(TOKEN_PAIR_INTERNAL_SEPARATOR);
  if (parts.length < 2) {
    return null;
  }

  // P1-FIX 2.5: Handle DEX prefix by taking only the last 2 parts (token0 and token1)
  // Format can be "TOKEN0_TOKEN1" or "DEX_TOKEN0_TOKEN1" or "DEX_EXTRA_TOKEN0_TOKEN1"
  const token0 = parts[parts.length - 2];
  const token1 = parts[parts.length - 1];

  // FIX 4.4: Validate token symbols are non-empty strings
  if (!token0 || !token1 || token0.length === 0 || token1.length === 0) {
    return null;
  }

  // Normalize only the token symbols, not any prefix
  const normalizedToken0 = normalizeTokenForCrossChain(token0);
  const normalizedToken1 = normalizeTokenForCrossChain(token1);

  // FIX: Ensure normalized tokens are valid
  if (!normalizedToken0 || !normalizedToken1) {
    return null;
  }

  return `${normalizedToken0}${TOKEN_PAIR_INTERNAL_SEPARATOR}${normalizedToken1}`;
}

// =============================================================================
// Logger Interface (used by all modular components)
// =============================================================================

/**
 * Minimal logger interface for dependency injection.
 * Compatible with Winston logger and testing mocks.
 *
 * Phase 3: Now aliases ILogger from @arbitrage/types for consistency.
 */
export type ModuleLogger = ILogger;

// =============================================================================
// Price Data Structures
// =============================================================================

/**
 * Hierarchical price data storage structure.
 * Organized as: chain -> dex -> pairKey -> PriceUpdate
 */
export interface PriceData {
  [chain: string]: {
    [dex: string]: {
      [pairKey: string]: PriceUpdate;
    };
  };
}

// =============================================================================
// Cross-Chain Opportunity Types
// =============================================================================

/**
 * Represents a cross-chain arbitrage opportunity.
 * Used for internal tracking and deduplication before publishing.
 */
export interface CrossChainOpportunity {
  /** Normalized token pair string (e.g., "WETH/USDC") */
  token: string;

  /** Source chain where price is lower (buy side) */
  sourceChain: string;

  /** DEX on source chain */
  sourceDex: string;

  /** Price on source chain */
  sourcePrice: number;

  /** Target chain where price is higher (sell side) */
  targetChain: string;

  /** DEX on target chain */
  targetDex: string;

  /** Price on target chain */
  targetPrice: number;

  /** Absolute price difference */
  priceDiff: number;

  /** Percentage price difference */
  percentageDiff: number;

  /** Estimated gross profit (before bridge costs) */
  estimatedProfit: number;

  /** Estimated bridge cost in token units (FIX: Required field, default 0 if unknown) */
  bridgeCost: number;

  /** Net profit after bridge costs */
  netProfit: number;

  /** Confidence score (0-1) */
  confidence: number;

  /** Timestamp when opportunity was detected */
  createdAt: number;

  // ===========================================================================
  // Whale-Related Fields (Phase 3 Enhancement)
  // ===========================================================================

  /** Whether this opportunity was triggered by whale activity */
  whaleTriggered?: boolean;

  /** Transaction hash of the whale trade that triggered this opportunity */
  whaleTxHash?: string;

  /** Whale activity direction on source chain (bullish/bearish/neutral) */
  whaleDirection?: 'bullish' | 'bearish' | 'neutral';

  /** USD value of whale activity in the detection window */
  whaleVolumeUsd?: number;

  // ===========================================================================
  // ML Prediction Fields (Phase 3 Enhancement)
  // ===========================================================================

  /** ML model confidence boost (multiplicative factor) */
  mlConfidenceBoost?: number;

  /** ML predicted price direction for source chain */
  mlSourceDirection?: 'up' | 'down' | 'sideways';

  /** ML predicted price direction for target chain */
  mlTargetDirection?: 'up' | 'down' | 'sideways';

  /** Whether ML predictions support this opportunity (favorable alignment) */
  mlSupported?: boolean;

  // ===========================================================================
  // FIX 7.1: Pending Opportunity Fields (Mempool Integration)
  // ===========================================================================

  /** Trade size in USD for profit calculations */
  tradeSizeUsd?: number;

  /** Timestamp when opportunity was detected (alternative to createdAt) */
  timestamp?: number;

  /** Transaction hash of the pending swap that triggered this opportunity */
  pendingTxHash?: string;

  /** Deadline timestamp of the pending swap */
  pendingDeadline?: number;

  /** Slippage tolerance of the pending swap (decimal, e.g., 0.005 = 0.5%) */
  pendingSlippage?: number;
}

// =============================================================================
// Performance Optimization Types (P1: Token Pair Index)
// =============================================================================

/**
 * Price point for indexed lookup by normalized token pair.
 * Used for O(1) token pair lookups instead of O(n²) iteration.
 */
export interface PricePoint {
  chain: string;
  dex: string;
  pairKey: string;
  price: number;
  update: PriceUpdate;
}

/**
 * Indexed snapshot with O(1) token pair lookups.
 * Replaces raw PriceData iteration with pre-built index.
 */
export interface IndexedSnapshot {
  /** Token pair index for O(1) lookups: normalizedTokenPair -> PricePoint[] */
  byToken: Map<string, PricePoint[]>;
  /** Raw price data for backwards compatibility */
  raw: PriceData;
  /** All unique normalized token pairs */
  tokenPairs: string[];
  /** Snapshot creation timestamp */
  timestamp: number;
}

// =============================================================================
// Configuration Types (Config C1: Configurable Values)
// =============================================================================

/**
 * Configuration for CrossChainDetectorService.
 * Makes hardcoded values configurable for different environments.
 */
export interface DetectorConfig {
  /** Detection interval in ms (default: 100) */
  detectionIntervalMs?: number;
  /** Health check interval in ms (default: 30000) */
  healthCheckIntervalMs?: number;
  /** Bridge cleanup frequency (every N updates, default: 100) */
  bridgeCleanupFrequency?: number;
  /** Default trade size for cost estimation in USD (default: 1000) */
  defaultTradeSizeUsd?: number;
  /** P1-FIX 2.3: Estimated gas for swap operations (default: 200000) */
  estimatedSwapGas?: number;
  /** Whale analysis configuration */
  whaleConfig?: WhaleAnalysisConfig;
  /** ML prediction configuration */
  mlConfig?: MLPredictionConfig;
  /** Phase 3: Pre-validation configuration for sample-based opportunity validation */
  preValidationConfig?: PreValidationConfig;
  /**
   * Phase 3: Simulation callback for pre-validation.
   * Injected by orchestrator to avoid direct SimulationService dependency.
   * @see ADR-023: Detector Pre-validation
   */
  simulationCallback?: PreValidationSimulationCallback;
}

/**
 * Phase 3: Pre-validation configuration for sample-based opportunity validation.
 *
 * Pre-validation simulates a sample of opportunities before publishing to filter
 * out opportunities that would fail execution. This reduces wasted execution
 * engine resources and improves opportunity quality.
 *
 * Budget considerations:
 * - Tenderly: 25K simulations/month (preserve for execution)
 * - Alchemy: 300M CU/month (can use for pre-validation)
 * - Pre-validation uses ~10% of budget, leaving 90% for execution
 *
 * @see ADR-023: Detector Pre-validation
 */
export interface PreValidationConfig {
  /** Enable pre-validation (default: false) */
  enabled: boolean;
  /**
   * Sample rate for pre-validation (0-1).
   * Only this fraction of opportunities are pre-validated.
   * Example: 0.1 means 10% of opportunities are validated.
   * Default: 0.1
   */
  sampleRate: number;
  /**
   * Minimum profit threshold for pre-validation in USD.
   * Opportunities below this threshold skip pre-validation.
   * Default: 50
   */
  minProfitForValidation: number;
  /**
   * Maximum latency for pre-validation in ms.
   * Skip pre-validation if it takes longer.
   * Default: 100
   */
  maxLatencyMs: number;
  /**
   * Monthly simulation budget for pre-validation.
   * Pre-validation stops when budget is exhausted.
   * Default: 2500 (10% of Tenderly's 25K/month)
   */
  monthlyBudget: number;
  /**
   * Preferred simulation provider for pre-validation.
   * Use 'alchemy' to preserve Tenderly budget for execution.
   * Default: 'alchemy'
   */
  preferredProvider: 'tenderly' | 'alchemy' | 'local';
}

/**
 * Whale analysis configuration.
 */
export interface WhaleAnalysisConfig {
  /** Super whale threshold - triggers immediate detection (default: $500K) */
  superWhaleThresholdUsd: number;
  /** Significant flow threshold for immediate detection trigger */
  significantFlowThresholdUsd: number;
  /** Confidence boost when whale direction aligns (default: 1.15 = +15%) */
  whaleBullishBoost: number;
  /** Confidence penalty when whale direction opposes (default: 0.85 = -15%) */
  whaleBearishPenalty: number;
  /** Super whale confidence boost (default: 1.25 = +25%) */
  superWhaleBoost: number;
  /** Time window for whale activity summary in ms (default: 5 min) */
  activityWindowMs: number;
}

/**
 * ML prediction configuration.
 */
export interface MLPredictionConfig {
  /** Enable ML predictions (default: true) */
  enabled: boolean;
  /** Minimum confidence for ML predictions to be used (default: 0.6) */
  minConfidence: number;
  /** ML confidence boost multiplier when predictions align (default: 1.15) */
  alignedBoost: number;
  /** ML confidence penalty when predictions oppose (default: 0.9) */
  opposedPenalty: number;
  /** Maximum latency for ML prediction in ms before skipping (default: 50, FIX PERF-1) */
  maxLatencyMs: number;
  /** Cache prediction results for this duration in ms (default: 1000) */
  cacheTtlMs: number;
}

// =============================================================================
// Pre-validation Simulation Interface
// =============================================================================

/**
 * Simulation request for pre-validation.
 * Simplified interface for detector pre-validation (doesn't need full transaction).
 */
export interface PreValidationSimulationRequest {
  /** Chain for simulation */
  chain: string;
  /** Token pair being traded */
  tokenPair: string;
  /** DEX to simulate on */
  dex: string;
  /** Estimated trade size in USD */
  tradeSizeUsd: number;
  /** Expected price */
  expectedPrice: number;
}

/**
 * Result of pre-validation simulation.
 */
export interface PreValidationSimulationResult {
  /** Whether simulation succeeded */
  success: boolean;
  /** Whether the transaction would revert */
  wouldRevert: boolean;
  /** Latency of simulation in ms */
  latencyMs: number;
  /** Error message if failed */
  error?: string;
}

/**
 * Callback interface for pre-validation simulation.
 *
 * This allows the detector to simulate opportunities without direct dependency
 * on SimulationService. The orchestrator wires the callback to SimulationService.
 *
 * @see ADR-023: Detector Pre-validation
 */
export type PreValidationSimulationCallback = (
  request: PreValidationSimulationRequest
) => Promise<PreValidationSimulationResult>;

// =============================================================================
// Re-exports for convenience
// =============================================================================

// Re-export Logger as alias for backwards compatibility with existing modules
export type Logger = ModuleLogger;
