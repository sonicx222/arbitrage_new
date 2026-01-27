/**
 * Shared Utilities
 *
 * This module provides common utility functions used across the codebase.
 */

export {
  // Scale factors
  DEFAULT_SCALE,
  HIGH_PRECISION_SCALE,

  // Fraction conversions
  fractionToBigInt,
  bigIntToFraction,

  // Arithmetic
  applyFraction,
  calculateFraction,

  // Safe conversions
  bigIntToNumber,
  numberToBigInt,

  // Comparison
  bigIntMin,
  bigIntMax,
  bigIntClamp,
  bigIntAbs,

  // Formatting
  formatWeiAsEth,
} from './bigint-utils';
