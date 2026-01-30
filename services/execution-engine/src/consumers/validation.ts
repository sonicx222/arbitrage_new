/**
 * Validation Module for Opportunity Consumer
 *
 * REFACTOR 9.1: Extracted from opportunity.consumer.ts for:
 * - Better testability in isolation
 * - Reusability across consumers
 * - Cleaner separation of concerns
 *
 * This module contains pure validation functions with no side effects.
 * All functions are synchronous and return typed validation results.
 *
 * @see opportunity.consumer.ts (main consumer)
 * @see ../types.ts (ValidationErrorCode)
 */

import type { ArbitrageOpportunity } from '@arbitrage/types';
import { ValidationErrorCode, isSupportedChain } from '../types';

// =============================================================================
// Validation Result Types
// =============================================================================

/**
 * Successful structural validation.
 * Contains the validated opportunity for processing.
 */
export interface ValidationSuccess {
  valid: true;
  opportunity: ArbitrageOpportunity;
}

/**
 * Failed structural validation.
 * Contains error code and optional details for logging.
 */
export interface ValidationFailure {
  valid: false;
  code: ValidationErrorCode;
  details?: string;
  /** Whether this is a system message that should be ACKed silently */
  isSystemMessage?: boolean;
}

/**
 * Result type for structural message validation.
 * Includes parsed opportunity on success.
 */
export type ValidationResult = ValidationSuccess | ValidationFailure;

// =============================================================================
// Business Rule Validation Types
// =============================================================================

/**
 * Business rule validation success.
 * Does NOT include opportunity since caller already has it.
 */
export interface BusinessRuleSuccess {
  valid: true;
}

/**
 * Business rule validation failure.
 * Includes error code and details for logging/metrics.
 */
export interface BusinessRuleFailure {
  valid: false;
  code: ValidationErrorCode;
  details?: string;
}

/**
 * Result type for business rule validation.
 * Separate from ValidationResult since opportunity is already validated.
 */
export type BusinessRuleResult = BusinessRuleSuccess | BusinessRuleFailure;

// =============================================================================
// Sub-Validation Types (BUG FIX 4.3)
// =============================================================================

/**
 * Sub-validation success.
 * Does NOT include opportunity - parent constructs final result.
 */
export interface SubValidationSuccess {
  valid: true;
}

/**
 * Sub-validation failure.
 * Compatible with ValidationFailure for easy returns.
 */
export interface SubValidationFailure {
  valid: false;
  code: ValidationErrorCode;
  details?: string;
}

/**
 * Result type for intermediate validations (e.g., cross-chain fields).
 * BUG FIX 4.3: Avoids redundant opportunity construction on success path.
 */
export type SubValidationResult = SubValidationSuccess | SubValidationFailure;

// =============================================================================
// Business Rule Configuration Interface
// =============================================================================

/**
 * Configuration for business rule validation.
 * Allows caller to inject config without module coupling.
 */
export interface BusinessRuleConfig {
  confidenceThreshold: number;
  minProfitPercentage: number;
}

// =============================================================================
// Constants (Pre-compiled for Performance)
// =============================================================================

/**
 * Valid opportunity types.
 * Using Set for O(1) lookup.
 */
export const VALID_OPPORTUNITY_TYPES = new Set([
  'simple',
  'cross-dex',
  'triangular',
  'quadrilateral',
  'multi-leg',
  'cross-chain',
  'predictive',
  'intra-dex',
  'flash-loan',
]);

/**
 * Pattern for validating numeric amount strings (all digits).
 * Pre-compiled for hot-path performance.
 */
export const NUMERIC_PATTERN = /^\d+$/;

/**
 * Pattern for detecting all-zero strings.
 * Pre-compiled for hot-path performance.
 */
export const ALL_ZEROS_PATTERN = /^0+$/;

// =============================================================================
// Validation Functions
// =============================================================================

/**
 * Validate incoming message structure and content.
 *
 * Performance: Uses fast string checks instead of BigInt conversion.
 * The actual BigInt conversion happens in execution strategies.
 *
 * @param message - Message containing id and data
 * @returns ValidationResult with parsed opportunity or error code
 */
export function validateMessageStructure(
  message: { id: string; data: unknown }
): ValidationResult {
  // Check for empty message
  if (!message.data) {
    return { valid: false, code: ValidationErrorCode.EMPTY_MESSAGE };
  }

  const data = message.data as Record<string, unknown>;

  // Check if data is an object
  if (typeof data !== 'object' || data === null) {
    return { valid: false, code: ValidationErrorCode.NOT_OBJECT };
  }

  // Handle stream-init messages (system messages)
  if (data.type === 'stream-init') {
    return {
      valid: false,
      code: ValidationErrorCode.STREAM_INIT,
      isSystemMessage: true,
    };
  }

  // Validate required fields
  if (!data.id || typeof data.id !== 'string') {
    return { valid: false, code: ValidationErrorCode.MISSING_ID };
  }

  if (!data.type || typeof data.type !== 'string') {
    return { valid: false, code: ValidationErrorCode.MISSING_TYPE };
  }

  // Validate opportunity type
  if (!VALID_OPPORTUNITY_TYPES.has(data.type)) {
    return {
      valid: false,
      code: ValidationErrorCode.INVALID_TYPE,
      details: `Unknown type: ${data.type}`,
    };
  }

  // Validate token fields
  if (!data.tokenIn || typeof data.tokenIn !== 'string') {
    return { valid: false, code: ValidationErrorCode.MISSING_TOKEN_IN };
  }

  if (!data.tokenOut || typeof data.tokenOut !== 'string') {
    return { valid: false, code: ValidationErrorCode.MISSING_TOKEN_OUT };
  }

  // Validate amountIn
  if (!data.amountIn) {
    return { valid: false, code: ValidationErrorCode.MISSING_AMOUNT };
  }

  const amountInStr = String(data.amountIn);

  // Fast format check: must be all digits
  if (!NUMERIC_PATTERN.test(amountInStr)) {
    return {
      valid: false,
      code: ValidationErrorCode.INVALID_AMOUNT,
      details: `Value: ${amountInStr}`,
    };
  }

  // Check for zero
  if (amountInStr === '0' || ALL_ZEROS_PATTERN.test(amountInStr)) {
    return { valid: false, code: ValidationErrorCode.ZERO_AMOUNT };
  }

  // Validate cross-chain specific fields
  if (data.type === 'cross-chain') {
    const crossChainValidation = validateCrossChainFields(data);
    if (!crossChainValidation.valid) {
      return crossChainValidation;
    }
  }

  // Validate expiration (if provided)
  // FIX: Handle both number and string timestamps robustly
  if (data.expiresAt !== undefined && data.expiresAt !== null) {
    let expiresAtMs: number;

    if (typeof data.expiresAt === 'number') {
      expiresAtMs = data.expiresAt;
    } else if (typeof data.expiresAt === 'string') {
      // Only accept numeric strings (e.g., "1706626800000")
      if (!NUMERIC_PATTERN.test(data.expiresAt)) {
        return {
          valid: false,
          code: ValidationErrorCode.INVALID_EXPIRES_AT,
          details: `Invalid format: ${data.expiresAt}`,
        };
      }
      expiresAtMs = Number(data.expiresAt);
      // Check for NaN or invalid conversion
      if (!Number.isFinite(expiresAtMs)) {
        return {
          valid: false,
          code: ValidationErrorCode.INVALID_EXPIRES_AT,
          details: `Cannot parse: ${data.expiresAt}`,
        };
      }
    } else {
      // Reject non-number, non-string types
      return {
        valid: false,
        code: ValidationErrorCode.INVALID_EXPIRES_AT,
        details: `Expected number or numeric string, got ${typeof data.expiresAt}`,
      };
    }

    // Check if already expired
    if (expiresAtMs < Date.now()) {
      return {
        valid: false,
        code: ValidationErrorCode.EXPIRED,
        details: `Expired ${Date.now() - expiresAtMs}ms ago`,
      };
    }
  }

  // All validations passed
  return {
    valid: true,
    opportunity: data as unknown as ArbitrageOpportunity,
  };
}

/**
 * Validate cross-chain specific fields.
 *
 * BUG FIX 4.3: Returns SubValidationResult to avoid redundant
 * opportunity construction on success path.
 *
 * @param data - Message data object
 * @returns SubValidationResult indicating success or failure
 */
export function validateCrossChainFields(
  data: Record<string, unknown>
): SubValidationResult {
  if (!data.buyChain || typeof data.buyChain !== 'string') {
    return { valid: false, code: ValidationErrorCode.MISSING_BUY_CHAIN };
  }

  if (!data.sellChain || typeof data.sellChain !== 'string') {
    return { valid: false, code: ValidationErrorCode.MISSING_SELL_CHAIN };
  }

  if (data.buyChain === data.sellChain) {
    return { valid: false, code: ValidationErrorCode.SAME_CHAIN };
  }

  // Validate chain support
  if (!isSupportedChain(data.buyChain)) {
    return {
      valid: false,
      code: ValidationErrorCode.UNSUPPORTED_BUY_CHAIN,
      details: data.buyChain,
    };
  }

  if (!isSupportedChain(data.sellChain)) {
    return {
      valid: false,
      code: ValidationErrorCode.UNSUPPORTED_SELL_CHAIN,
      details: data.sellChain,
    };
  }

  return { valid: true };
}

/**
 * Validate business rules for an opportunity.
 *
 * @param opportunity - Validated opportunity to check
 * @param config - Business rule thresholds
 * @returns BusinessRuleResult indicating pass or fail
 */
export function validateBusinessRules(
  opportunity: ArbitrageOpportunity,
  config: BusinessRuleConfig
): BusinessRuleResult {
  // Check confidence threshold
  if (opportunity.confidence < config.confidenceThreshold) {
    return {
      valid: false,
      code: ValidationErrorCode.LOW_CONFIDENCE,
      details: `${opportunity.confidence} < ${config.confidenceThreshold}`,
    };
  }

  // Check profit threshold
  if ((opportunity.expectedProfit ?? 0) < config.minProfitPercentage) {
    return {
      valid: false,
      code: ValidationErrorCode.LOW_PROFIT,
      details: `${opportunity.expectedProfit} < ${config.minProfitPercentage}`,
    };
  }

  return { valid: true };
}
