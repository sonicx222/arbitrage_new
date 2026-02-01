/**
 * Detection Module
 *
 * Exports all arbitrage detection functions and utilities.
 *
 * @see R1 - Solana Arbitrage Detection Modules extraction
 */

// Base utilities
export {
  MIN_VALID_PRICE,
  DEFAULT_SOL_PRICE_USD,
  COMPUTE_UNITS,
  URGENCY_MULTIPLIERS,
  MAX_COMPARISONS_PER_PAIR,
  MAX_PATHS_PER_LEVEL,
  MAX_MEMO_CACHE_SIZE,
  CROSS_CHAIN_EXPIRY_MULTIPLIER,
  CIRCUIT_BREAKER_CONFIG,
  DEFAULT_DETECTION_CONFIG,
  isValidPrice,
  isValidFee,
  isValidDecimalFee,
  isPriceStale,
  calculatePriorityFee,
  estimateGasCost,
  basisPointsToDecimal,
  meetsThreshold,
  getDefaultPrice,
} from './base';

// Intra-Solana detection
export {
  detectIntraSolanaArbitrage,
} from './intra-solana-detector';
export type {
  IntraSolanaDetectorConfig,
  IntraSolanaDetectionResult,
} from './intra-solana-detector';

// Triangular detection
export {
  buildAdjacencyGraph,
  findTriangularPaths,
  detectTriangularArbitrage,
} from './triangular-detector';
export type {
  TriangularDetectorConfig,
  GraphEdge,
  AdjacencyGraph,
  TriangularDetectionResult,
} from './triangular-detector';

// Cross-chain detection
export {
  compareCrossChainPrices,
  estimateCrossChainGasCostPercent,
  detectCrossChainArbitrage,
  getDefaultCrossChainCosts,
} from './cross-chain-detector';
export type {
  CrossChainDetectorConfig,
  CrossChainDetectionResult,
  TokenNormalizer,
} from './cross-chain-detector';
