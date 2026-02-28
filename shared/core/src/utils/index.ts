/**
 * Shared Utilities
 *
 * This module provides common utility functions used across the codebase.
 */

export {
  // Scale factors
  DEFAULT_SCALE,
  HIGH_PRECISION_SCALE,
  MAX_SAFE_BIGINT,

  // Price bounds (single source of truth for arbitrage price validation)
  MIN_SAFE_PRICE,
  MAX_SAFE_PRICE,

  // Fraction conversions
  fractionToBigInt,
  bigIntToFraction,

  // Arithmetic
  applyFraction,
  calculateFraction,

  // Safe conversions
  bigIntToNumber,
  numberToBigInt,

  // P0 FIX: Safe token amount conversions (prevents precision loss for large values)
  safeBigIntToDecimal,
  safeBigIntBatchToDecimal,

  // Comparison
  bigIntMin,
  bigIntMax,
  bigIntClamp,
  bigIntAbs,

  // Formatting
  formatWeiAsEth,
} from './bigint-utils';

// =============================================================================
// Fee Utilities - Single Source of Truth
// =============================================================================

export {
  // Branded Types
  type FeeBasisPoints,
  type FeeDecimal,
  type UniswapV3FeeTier,

  // Constants
  BPS_DENOMINATOR,
  V3_FEE_DENOMINATOR,
  PERCENT_DENOMINATOR,
  FEE_CONSTANTS,
  VALID_V3_FEE_TIERS,
  LOW_FEE_DEXES,

  // Conversion Functions
  bpsToDecimal,
  decimalToBps,
  v3TierToDecimal,
  decimalToV3Tier,
  percentToDecimal,
  decimalToPercent,

  // Validation
  isValidV3FeeTier,
  isValidFeeDecimal,
  isValidFeeBps,
  validateFee,
  getDefaultFeeForDex,
  resolveFeeValue,

  // Type Helpers
  asBps,
  asDecimal,
} from './fee-utils';

// =============================================================================
// Common Validators - Lightweight Hot-Path Validation
// =============================================================================

export {
  // Type Guards
  isDefined,
  isNonEmptyString,
  isPositiveNumber,
  isNonNegativeNumber,
  isFiniteNumber,
  isValidPrice,
  isInteger,
  isPositiveInteger,
  isNonEmptyArray,
  isPlainObject,
  hasKey,

  // Validation (throw on failure)
  validateNonEmptyString,
  validatePositiveNumber,
  validateNonNegativeNumber,
  validatePositiveInteger,
  validateInRange,

  // Safe Parsing
  parseNumberSafe,
  parseIntegerSafe,
  parseBooleanSafe,

  // Address Validators
  looksLikeEthereumAddress,
  looksLikeSolanaAddress,

  // Assertions
  assert,
  assertDefined,
} from './common-validators';

// =============================================================================
// Object Pool - GC Pressure Reduction for Hot Paths
// =============================================================================

export { ObjectPool } from './object-pool';

// =============================================================================
// Environment Utilities
// =============================================================================

export * from './env-utils';

// =============================================================================
// HMAC Utilities
// =============================================================================

export * from './hmac-utils';

// =============================================================================
// Disconnect Utilities
// =============================================================================

export * from './disconnect-utils';

// =============================================================================
// AMM Math Utilities
// =============================================================================

export * from './amm-math';

// =============================================================================
// URL Utilities - API Key Masking
// =============================================================================

export { maskUrlApiKeys } from './url-utils';

// =============================================================================
// V3 Price Utilities - sqrtPriceX96 Conversions
// =============================================================================

export {
  calculatePriceFromSqrtPriceX96,
  calculateVirtualReservesFromSqrtPriceX96,
} from './v3-price-utils';
