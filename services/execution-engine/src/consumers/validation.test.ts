/**
 * Unit Tests for Validation Module
 *
 * Tests the validation functions extracted from opportunity.consumer.ts:
 * - validateMessageStructure: Validates incoming message format
 * - validateCrossChainFields: Validates cross-chain specific fields
 * - validateBusinessRules: Validates business logic rules
 *
 * @see validation.ts
 */

import {
  validateMessageStructure,
  validateCrossChainFields,
  validateBusinessRules,
  VALID_OPPORTUNITY_TYPES,
  NUMERIC_PATTERN,
  ALL_ZEROS_PATTERN,
  type ValidationResult,
  type BusinessRuleResult,
  type BusinessRuleConfig,
} from './validation';
import { ValidationErrorCode } from '../types';

// =============================================================================
// Test Utilities
// =============================================================================

/**
 * Create a valid message structure for testing
 */
function createValidMessage(overrides: Record<string, unknown> = {}): { id: string; data: unknown } {
  return {
    id: 'msg-1',
    data: {
      id: 'opp-123',
      type: 'simple',
      tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
      tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
      amountIn: '1000000000000000000', // 1 ETH
      confidence: 0.85,
      expectedProfit: 0.02,
      buyChain: 'ethereum',
      sellChain: 'ethereum',
      buyDex: 'uniswap_v2',
      sellDex: 'uniswap_v3',
      ...overrides,
    },
  };
}

/**
 * Create a valid cross-chain message for testing
 */
function createValidCrossChainMessage(overrides: Record<string, unknown> = {}): { id: string; data: unknown } {
  return createValidMessage({
    type: 'cross-chain',
    buyChain: 'ethereum',
    sellChain: 'arbitrum',
    ...overrides,
  });
}

// =============================================================================
// validateMessageStructure Tests
// =============================================================================

describe('validateMessageStructure', () => {
  describe('empty/null message handling', () => {
    it('should reject empty message data', () => {
      const result = validateMessageStructure({ id: 'msg-1', data: null });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe(ValidationErrorCode.EMPTY_MESSAGE);
      }
    });

    it('should reject undefined message data', () => {
      const result = validateMessageStructure({ id: 'msg-1', data: undefined });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe(ValidationErrorCode.EMPTY_MESSAGE);
      }
    });

    it('should reject non-object data', () => {
      const result = validateMessageStructure({ id: 'msg-1', data: 'string' });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe(ValidationErrorCode.NOT_OBJECT);
      }
    });

    it('should reject array data', () => {
      const result = validateMessageStructure({ id: 'msg-1', data: [] });
      expect(result.valid).toBe(false);
    });
  });

  describe('system message handling', () => {
    it('should identify stream-init messages', () => {
      const result = validateMessageStructure({
        id: 'msg-1',
        data: { type: 'stream-init' },
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe(ValidationErrorCode.STREAM_INIT);
        expect(result.isSystemMessage).toBe(true);
      }
    });
  });

  describe('required field validation', () => {
    it('should reject missing id field', () => {
      const msg = createValidMessage();
      delete (msg.data as Record<string, unknown>).id;
      const result = validateMessageStructure(msg);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe(ValidationErrorCode.MISSING_ID);
      }
    });

    it('should reject non-string id', () => {
      const result = validateMessageStructure(createValidMessage({ id: 123 }));
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe(ValidationErrorCode.MISSING_ID);
      }
    });

    it('should reject missing type field', () => {
      const msg = createValidMessage();
      delete (msg.data as Record<string, unknown>).type;
      const result = validateMessageStructure(msg);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe(ValidationErrorCode.MISSING_TYPE);
      }
    });

    it('should reject missing tokenIn', () => {
      const msg = createValidMessage();
      delete (msg.data as Record<string, unknown>).tokenIn;
      const result = validateMessageStructure(msg);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe(ValidationErrorCode.MISSING_TOKEN_IN);
      }
    });

    it('should reject missing tokenOut', () => {
      const msg = createValidMessage();
      delete (msg.data as Record<string, unknown>).tokenOut;
      const result = validateMessageStructure(msg);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe(ValidationErrorCode.MISSING_TOKEN_OUT);
      }
    });

    it('should reject missing amountIn', () => {
      const msg = createValidMessage();
      delete (msg.data as Record<string, unknown>).amountIn;
      const result = validateMessageStructure(msg);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe(ValidationErrorCode.MISSING_AMOUNT);
      }
    });
  });

  describe('opportunity type validation', () => {
    it('should accept all valid opportunity types', () => {
      const validTypes = Array.from(VALID_OPPORTUNITY_TYPES);
      for (const type of validTypes) {
        // Skip cross-chain which needs extra fields
        if (type === 'cross-chain') continue;

        const result = validateMessageStructure(createValidMessage({ type }));
        expect(result.valid).toBe(true);
      }
    });

    it('should reject unknown opportunity type', () => {
      const result = validateMessageStructure(createValidMessage({ type: 'unknown-type' }));
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe(ValidationErrorCode.INVALID_TYPE);
        expect(result.details).toContain('unknown-type');
      }
    });
  });

  describe('amountIn validation', () => {
    it('should accept valid numeric string', () => {
      const result = validateMessageStructure(createValidMessage({ amountIn: '1234567890' }));
      expect(result.valid).toBe(true);
    });

    it('should accept number converted to string', () => {
      const result = validateMessageStructure(createValidMessage({ amountIn: 1234567890 }));
      expect(result.valid).toBe(true);
    });

    it('should reject non-numeric amount', () => {
      const result = validateMessageStructure(createValidMessage({ amountIn: '12.34' }));
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe(ValidationErrorCode.INVALID_AMOUNT);
      }
    });

    it('should reject negative amount', () => {
      const result = validateMessageStructure(createValidMessage({ amountIn: '-1234' }));
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe(ValidationErrorCode.INVALID_AMOUNT);
      }
    });

    it('should reject zero amount', () => {
      const result = validateMessageStructure(createValidMessage({ amountIn: '0' }));
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe(ValidationErrorCode.ZERO_AMOUNT);
      }
    });

    it('should reject all-zeros amount', () => {
      const result = validateMessageStructure(createValidMessage({ amountIn: '000000' }));
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe(ValidationErrorCode.ZERO_AMOUNT);
      }
    });

    it('should reject hex amount', () => {
      const result = validateMessageStructure(createValidMessage({ amountIn: '0x1234' }));
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe(ValidationErrorCode.INVALID_AMOUNT);
      }
    });
  });

  describe('expiration validation', () => {
    it('should accept valid future timestamp (number)', () => {
      const result = validateMessageStructure(createValidMessage({
        expiresAt: Date.now() + 60000,
      }));
      expect(result.valid).toBe(true);
    });

    it('should accept valid future timestamp (string)', () => {
      const result = validateMessageStructure(createValidMessage({
        expiresAt: String(Date.now() + 60000),
      }));
      expect(result.valid).toBe(true);
    });

    it('should reject expired timestamp', () => {
      const result = validateMessageStructure(createValidMessage({
        expiresAt: Date.now() - 1000,
      }));
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe(ValidationErrorCode.EXPIRED);
      }
    });

    it('should reject non-numeric expiration string', () => {
      const result = validateMessageStructure(createValidMessage({
        expiresAt: 'not-a-number',
      }));
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe(ValidationErrorCode.INVALID_EXPIRES_AT);
      }
    });

    it('should accept missing expiresAt (optional)', () => {
      const msg = createValidMessage();
      delete (msg.data as Record<string, unknown>).expiresAt;
      const result = validateMessageStructure(msg);
      expect(result.valid).toBe(true);
    });
  });

  describe('cross-chain validation integration', () => {
    it('should validate cross-chain fields for cross-chain type', () => {
      const result = validateMessageStructure(createValidCrossChainMessage());
      expect(result.valid).toBe(true);
    });

    it('should reject cross-chain with missing buyChain', () => {
      const msg = createValidCrossChainMessage();
      delete (msg.data as Record<string, unknown>).buyChain;
      const result = validateMessageStructure(msg);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe(ValidationErrorCode.MISSING_BUY_CHAIN);
      }
    });

    it('should reject cross-chain with missing sellChain', () => {
      const msg = createValidCrossChainMessage();
      delete (msg.data as Record<string, unknown>).sellChain;
      const result = validateMessageStructure(msg);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe(ValidationErrorCode.MISSING_SELL_CHAIN);
      }
    });
  });

  describe('successful validation', () => {
    it('should return parsed opportunity on success', () => {
      const result = validateMessageStructure(createValidMessage());
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.opportunity).toBeDefined();
        expect(result.opportunity.id).toBe('opp-123');
        expect(result.opportunity.type).toBe('simple');
      }
    });
  });
});

// =============================================================================
// validateCrossChainFields Tests
// =============================================================================

describe('validateCrossChainFields', () => {
  it('should accept valid cross-chain fields', () => {
    const result = validateCrossChainFields({
      buyChain: 'ethereum',
      sellChain: 'arbitrum',
    });
    expect(result.valid).toBe(true);
  });

  it('should reject missing buyChain', () => {
    const result = validateCrossChainFields({
      sellChain: 'arbitrum',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe(ValidationErrorCode.MISSING_BUY_CHAIN);
    }
  });

  it('should reject missing sellChain', () => {
    const result = validateCrossChainFields({
      buyChain: 'ethereum',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe(ValidationErrorCode.MISSING_SELL_CHAIN);
    }
  });

  it('should reject same chain for buy and sell', () => {
    const result = validateCrossChainFields({
      buyChain: 'ethereum',
      sellChain: 'ethereum',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe(ValidationErrorCode.SAME_CHAIN);
    }
  });

  it('should reject unsupported buy chain', () => {
    const result = validateCrossChainFields({
      buyChain: 'unsupported-chain',
      sellChain: 'arbitrum',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe(ValidationErrorCode.UNSUPPORTED_BUY_CHAIN);
      expect(result.details).toBe('unsupported-chain');
    }
  });

  it('should reject unsupported sell chain', () => {
    const result = validateCrossChainFields({
      buyChain: 'ethereum',
      sellChain: 'unsupported-chain',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe(ValidationErrorCode.UNSUPPORTED_SELL_CHAIN);
      expect(result.details).toBe('unsupported-chain');
    }
  });

  it('should reject non-string buyChain', () => {
    const result = validateCrossChainFields({
      buyChain: 123,
      sellChain: 'arbitrum',
    } as Record<string, unknown>);
    expect(result.valid).toBe(false);
  });

  it('should reject non-string sellChain', () => {
    const result = validateCrossChainFields({
      buyChain: 'ethereum',
      sellChain: null,
    } as Record<string, unknown>);
    expect(result.valid).toBe(false);
  });
});

// =============================================================================
// validateBusinessRules Tests
// =============================================================================

describe('validateBusinessRules', () => {
  const defaultConfig: BusinessRuleConfig = {
    confidenceThreshold: 0.7,
    minProfitPercentage: 0.01,
  };

  const createOpportunity = (overrides: Partial<Record<string, unknown>> = {}) => ({
    id: 'opp-123',
    type: 'simple' as const,
    tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    amountIn: '1000000000000000000',
    confidence: 0.85,
    expectedProfit: 0.02,
    buyChain: 'ethereum',
    sellChain: 'ethereum',
    buyDex: 'uniswap_v2',
    sellDex: 'uniswap_v3',
    ...overrides,
  });

  describe('confidence validation', () => {
    it('should accept confidence above threshold', () => {
      const result = validateBusinessRules(
        createOpportunity({ confidence: 0.8 }) as any,
        defaultConfig
      );
      expect(result.valid).toBe(true);
    });

    it('should accept confidence at threshold', () => {
      const result = validateBusinessRules(
        createOpportunity({ confidence: 0.7 }) as any,
        defaultConfig
      );
      expect(result.valid).toBe(true);
    });

    it('should reject confidence below threshold', () => {
      const result = validateBusinessRules(
        createOpportunity({ confidence: 0.5 }) as any,
        defaultConfig
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe(ValidationErrorCode.LOW_CONFIDENCE);
        expect(result.details).toContain('0.5');
        expect(result.details).toContain('0.7');
      }
    });
  });

  describe('profit validation', () => {
    it('should accept profit above threshold', () => {
      const result = validateBusinessRules(
        createOpportunity({ expectedProfit: 0.02 }) as any,
        defaultConfig
      );
      expect(result.valid).toBe(true);
    });

    it('should accept profit at threshold', () => {
      const result = validateBusinessRules(
        createOpportunity({ expectedProfit: 0.01 }) as any,
        defaultConfig
      );
      expect(result.valid).toBe(true);
    });

    it('should reject profit below threshold', () => {
      const result = validateBusinessRules(
        createOpportunity({ expectedProfit: 0.005 }) as any,
        defaultConfig
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe(ValidationErrorCode.LOW_PROFIT);
      }
    });

    it('should handle missing expectedProfit (defaults to 0)', () => {
      const result = validateBusinessRules(
        createOpportunity({ expectedProfit: undefined }) as any,
        defaultConfig
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe(ValidationErrorCode.LOW_PROFIT);
      }
    });

    it('should accept zero profit with zero threshold', () => {
      const result = validateBusinessRules(
        createOpportunity({ expectedProfit: 0 }) as any,
        { confidenceThreshold: 0.7, minProfitPercentage: 0 }
      );
      expect(result.valid).toBe(true);
    });
  });

  describe('combined validation', () => {
    it('should pass when both conditions met', () => {
      const result = validateBusinessRules(
        createOpportunity({ confidence: 0.9, expectedProfit: 0.05 }) as any,
        defaultConfig
      );
      expect(result.valid).toBe(true);
    });

    it('should fail on low confidence first (before profit check)', () => {
      const result = validateBusinessRules(
        createOpportunity({ confidence: 0.5, expectedProfit: 0.001 }) as any,
        defaultConfig
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        // Confidence check happens first
        expect(result.code).toBe(ValidationErrorCode.LOW_CONFIDENCE);
      }
    });
  });
});

// =============================================================================
// Pattern Constants Tests
// =============================================================================

describe('Pattern Constants', () => {
  describe('NUMERIC_PATTERN', () => {
    it('should match all-digit strings', () => {
      expect(NUMERIC_PATTERN.test('12345')).toBe(true);
      expect(NUMERIC_PATTERN.test('0')).toBe(true);
      expect(NUMERIC_PATTERN.test('9999999999999')).toBe(true);
    });

    it('should not match non-digit strings', () => {
      expect(NUMERIC_PATTERN.test('12.34')).toBe(false);
      expect(NUMERIC_PATTERN.test('-123')).toBe(false);
      expect(NUMERIC_PATTERN.test('0x123')).toBe(false);
      expect(NUMERIC_PATTERN.test('abc')).toBe(false);
      expect(NUMERIC_PATTERN.test('')).toBe(false);
    });
  });

  describe('ALL_ZEROS_PATTERN', () => {
    it('should match all-zero strings', () => {
      expect(ALL_ZEROS_PATTERN.test('0')).toBe(true);
      expect(ALL_ZEROS_PATTERN.test('00')).toBe(true);
      expect(ALL_ZEROS_PATTERN.test('000000')).toBe(true);
    });

    it('should not match non-zero strings', () => {
      expect(ALL_ZEROS_PATTERN.test('01')).toBe(false);
      expect(ALL_ZEROS_PATTERN.test('10')).toBe(false);
      expect(ALL_ZEROS_PATTERN.test('')).toBe(false);
    });
  });
});

// =============================================================================
// Edge Cases and Boundary Tests
// =============================================================================

describe('Edge Cases', () => {
  it('should handle very large amountIn', () => {
    const largeAmount = '99999999999999999999999999999999999999';
    const result = validateMessageStructure(createValidMessage({ amountIn: largeAmount }));
    expect(result.valid).toBe(true);
  });

  it('should handle unicode in string fields', () => {
    const result = validateMessageStructure(createValidMessage({
      id: 'opp-\u0000-test',
    }));
    // Should still be valid since id is a string
    expect(result.valid).toBe(true);
  });

  it('should handle empty string tokenIn', () => {
    const result = validateMessageStructure(createValidMessage({ tokenIn: '' }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe(ValidationErrorCode.MISSING_TOKEN_IN);
    }
  });

  it('should handle whitespace-only tokenIn', () => {
    const result = validateMessageStructure(createValidMessage({ tokenIn: '   ' }));
    // Whitespace is technically a string, so this would pass basic validation
    // The actual token validation happens at execution time
    expect(result.valid).toBe(true);
  });
});
