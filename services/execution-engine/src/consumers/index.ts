/**
 * Consumers Module
 *
 * Re-exports all stream consumers and validation utilities.
 *
 * @see engine.ts (parent service)
 * @see validation.ts (REFACTOR 9.1: Extracted validation module)
 */

export { OpportunityConsumer } from './opportunity.consumer';
export type { OpportunityConsumerConfig, PendingMessageInfo } from './opportunity.consumer';

// Re-export validation error code from types for testing
export { ValidationErrorCode } from '../types';

// REFACTOR 9.1: Re-export validation module for external use
export {
  validateMessageStructure,
  validateCrossChainFields,
  validateBusinessRules,
  VALID_OPPORTUNITY_TYPES,
  NUMERIC_PATTERN,
  ALL_ZEROS_PATTERN,
} from './validation';
export type {
  ValidationResult,
  ValidationSuccess,
  ValidationFailure,
  BusinessRuleResult,
  BusinessRuleSuccess,
  BusinessRuleFailure,
  SubValidationResult,
  BusinessRuleConfig,
} from './validation';
