/**
 * Components Module
 *
 * ARCH-REFACTOR: Foundation components for the detection and price calculation
 * refactoring. These components extract and encapsulate core logic from
 * base-detector.ts and arbitrage-calculator.ts.
 *
 * Components:
 * - PriceCalculator: Pure functions for price/profit calculations
 * - PairRepository: In-memory pair storage with O(1) lookups
 * - ArbitrageDetector: Pure detection logic for arbitrage opportunities
 * - TokenUtils: Address normalization and token handling utilities
 *
 * @see .claude/plans/detection-refactoring-plan.md
 * @see .claude/plans/component-architecture-proposal.md
 */

// Price Calculator - Pure functions for calculations
export {
  // Core price calculations
  calculatePriceFromReserves,
  calculatePriceFromBigIntReserves,
  safeBigIntDivision,
  safeBigIntDivisionOrNull, // P0-FIX 4.4: Safe version that returns null instead of throwing
  invertPrice,
  calculatePriceDifferencePercent,

  // Spread and profit calculations
  calculateSpread,
  calculateSpreadSafe,
  calculateNetProfit,
  calculateProfitBetweenSources,

  // Threshold utilities
  meetsThreshold,
  calculateConfidence,
  getMinProfitThreshold,

  // Validation utilities
  isValidPrice,
  areValidReserves,
  isValidFee,

  // Error class
  PriceCalculationError,
} from './price-calculator';

export type {
  ReserveInput,
  SpreadResult,
  PriceSource,
  ProfitCalculationResult,
} from './price-calculator';

// Pair Repository - In-memory storage with O(1) lookups
export {
  PairRepository,
  createPairRepository,
} from './pair-repository';

export type {
  PairSnapshot,
  ExtendedPair,
  SnapshotOptions,
  RepositoryStats,
  PairChangeCallback,
} from './pair-repository';

// Arbitrage Detector - Pure detection logic
export {
  // Core detection functions
  detectArbitrage,
  detectArbitrageForTokenPair,
  calculateArbitrageProfit,
  calculateCrossChainArbitrage,

  // Token order utilities
  isReverseTokenOrder,
  normalizeTokenOrder,
  adjustPriceForTokenOrder,

  // Validation utilities
  isValidPairSnapshot,
  validateDetectionInput,
} from './arbitrage-detector';

export type {
  ArbitrageDetectionInput,
  ArbitrageDetectionResult,
  ArbitrageOpportunityData,
  BatchDetectionOptions,
  ChainPriceData,
  CrossChainOpportunityResult,
} from './arbitrage-detector';

// Token Utils - Address normalization and token handling
export {
  // Address normalization
  normalizeAddress,
  addressEquals,
  isValidAddress,
  isSolanaAddress,
  getAddressChainType,

  // Token pair keys (consolidated here - single source of truth)
  getTokenPairKey,
  getTokenPairKeyCached,  // HOT-PATH: Use this in performance-critical code
  getTokenPairKeyCacheStats,
  clearTokenPairKeyCache,
  parseTokenPairKey,
  isSameTokenPair,

  // HOT-PATH: Pre-normalized token pair utilities (ADR-022)
  isSameTokenPairPreNormalized,
  isReverseOrderPreNormalized,

  // Token order utilities
  isReverseOrder,
  sortTokens,
  getTokenIndex,

  // Common tokens
  COMMON_TOKENS,
  NATIVE_TOKENS,
  WRAPPED_NATIVE_TOKENS,

  // Token identification
  isStablecoin,
  isWrappedNative,
  getChainFromToken,

  // Checksum utilities
  toChecksumAddress,

  // Address set operations
  createAddressSet,
  addressInSet,
  intersectAddresses,
} from './token-utils';

// Fee utilities - re-exported from canonical source (fee-utils.ts)
export {
  getDefaultFeeForDex as getDefaultFee,
  resolveFeeValue as resolveFee,
  bpsToDecimal,
  decimalToBps,
} from '../utils/fee-utils';
