/**
 * Error Handling Unit Tests
 *
 * Tests for the shared error handling utilities (REF-3/ARCH-2).
 *
 * @migrated from shared/core/src/error-handling.test.ts
 * @see ADR-009: Test Architecture
 */

import { describe, it, expect, beforeEach } from '@jest/globals';

// Import from package alias (new pattern per ADR-009)
import {
  BaseArbitrageError as ArbitrageError,
  ConnectionError,
  SharedValidationError as ValidationError,
  LifecycleError,
  ExecutionError,
  ErrorCode,
  ErrorSeverity,
  success,
  failure,
  tryCatch,
  tryCatchSync,
  isRetryableErrorCheck as isRetryableError,
  isCriticalError,
  getErrorSeverity,
  formatErrorForLog,
  formatErrorForResponse,
  ErrorAggregator,
} from '@arbitrage/core/resilience';

// =============================================================================
// Custom Error Classes Tests
// =============================================================================

describe('ArbitrageError', () => {
  it('should create error with default values', () => {
    const error = new ArbitrageError('Test error');

    expect(error.message).toBe('Test error');
    expect(error.name).toBe('ArbitrageError');
    expect(error.code).toBe(ErrorCode.UNKNOWN_ERROR);
    expect(error.severity).toBe(ErrorSeverity.ERROR);
    expect(error.timestamp).toBeGreaterThan(0);
  });

  it('should create error with custom code', () => {
    const error = new ArbitrageError('Test error', ErrorCode.CONNECTION_TIMEOUT);

    expect(error.code).toBe(ErrorCode.CONNECTION_TIMEOUT);
  });

  it('should create error with options', () => {
    const cause = new Error('Original');
    const error = new ArbitrageError('Test error', ErrorCode.VALIDATION_FAILED, {
      severity: ErrorSeverity.WARNING,
      context: { field: 'test' },
      cause
    });

    expect(error.severity).toBe(ErrorSeverity.WARNING);
    expect(error.context).toEqual({ field: 'test' });
    expect(error.cause).toBe(cause);
  });

  it('should serialize to JSON', () => {
    const error = new ArbitrageError('Test error', ErrorCode.INVALID_ARGUMENT, {
      context: { key: 'value' }
    });

    const json = error.toJSON();

    expect(json.name).toBe('ArbitrageError');
    expect(json.message).toBe('Test error');
    expect(json.code).toBe(ErrorCode.INVALID_ARGUMENT);
    expect(json.context).toEqual({ key: 'value' });
    expect(json.timestamp).toBeGreaterThan(0);
  });
});

describe('ConnectionError', () => {
  it('should create connection error', () => {
    const error = new ConnectionError('Connection failed');

    expect(error.name).toBe('ConnectionError');
    expect(error.code).toBe(ErrorCode.CONNECTION_FAILED);
    expect(error.severity).toBe(ErrorSeverity.WARNING);
    expect(error.retryable).toBe(true);
  });

  it('should include endpoint', () => {
    const error = new ConnectionError('Connection failed', {
      endpoint: 'wss://example.com'
    });

    expect(error.endpoint).toBe('wss://example.com');
  });

  it('should set retryable flag', () => {
    const error = new ConnectionError('Connection failed', {
      retryable: false
    });

    expect(error.retryable).toBe(false);
  });
});

describe('ValidationError', () => {
  it('should create validation error', () => {
    const error = new ValidationError('Invalid input');

    expect(error.name).toBe('ValidationError');
    expect(error.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(error.severity).toBe(ErrorSeverity.WARNING);
  });

  it('should include field info', () => {
    const error = new ValidationError('Invalid field', {
      field: 'email',
      expectedType: 'string',
      receivedValue: 123
    });

    expect(error.field).toBe('email');
    expect(error.expectedType).toBe('string');
    expect(error.receivedValue).toBe(123);
  });
});

describe('LifecycleError', () => {
  it('should create lifecycle error', () => {
    const error = new LifecycleError('Service not running', 'detector');

    expect(error.name).toBe('LifecycleError');
    expect(error.serviceName).toBe('detector');
    expect(error.code).toBe(ErrorCode.INVALID_STATE);
  });

  it('should include current state', () => {
    const error = new LifecycleError('Already running', 'detector', {
      currentState: 'running'
    });

    expect(error.currentState).toBe('running');
  });
});

describe('ExecutionError', () => {
  it('should create execution error', () => {
    const error = new ExecutionError('Trade failed');

    expect(error.name).toBe('ExecutionError');
    expect(error.code).toBe(ErrorCode.EXECUTION_FAILED);
  });

  it('should include execution details', () => {
    const error = new ExecutionError('Trade failed', {
      opportunityId: 'opp-123',
      chain: 'ethereum',
      transactionHash: '0xabc'
    });

    expect(error.opportunityId).toBe('opp-123');
    expect(error.chain).toBe('ethereum');
    expect(error.transactionHash).toBe('0xabc');
  });
});

// =============================================================================
// Result Type Utilities Tests
// =============================================================================

describe('Result Utilities', () => {
  describe('success()', () => {
    it('should create success result', () => {
      const result = success('data');

      expect(result.success).toBe(true);
      expect((result as any).data).toBe('data');
    });
  });

  describe('failure()', () => {
    it('should create failure result', () => {
      const error = new ArbitrageError('Test');
      const result = failure(error);

      expect(result.success).toBe(false);
      expect((result as any).error).toBe(error);
    });
  });

  describe('tryCatch()', () => {
    it('should return success on resolved promise', async () => {
      const result = await tryCatch(async () => 'value');

      expect(result.success).toBe(true);
      expect((result as any).data).toBe('value');
    });

    it('should return failure on rejection', async () => {
      const result = await tryCatch(async () => {
        throw new Error('Test error');
      });

      expect(result.success).toBe(false);
      expect((result as any).error.message).toBe('Test error');
    });

    it('should wrap non-ArbitrageError', async () => {
      const result = await tryCatch(async () => {
        throw new Error('Plain error');
      }, ErrorCode.RPC_ERROR);

      expect(result.success).toBe(false);
      expect((result as any).error.code).toBe(ErrorCode.RPC_ERROR);
    });

    it('should preserve ArbitrageError', async () => {
      const original = new ArbitrageError('Original', ErrorCode.VALIDATION_FAILED);
      const result = await tryCatch(async () => {
        throw original;
      });

      expect(result.success).toBe(false);
      expect((result as any).error).toBe(original);
    });
  });

  describe('tryCatchSync()', () => {
    it('should return success on no error', () => {
      const result = tryCatchSync(() => 'value');

      expect(result.success).toBe(true);
      expect((result as any).data).toBe('value');
    });

    it('should return failure on throw', () => {
      const result = tryCatchSync(() => {
        throw new Error('Test error');
      });

      expect(result.success).toBe(false);
      expect((result as any).error.message).toBe('Test error');
    });
  });
});

// =============================================================================
// Error Classification Tests
// =============================================================================

describe('Error Classification', () => {
  describe('isRetryableError()', () => {
    it('should return true for ConnectionError with retryable=true', () => {
      const error = new ConnectionError('Test', { retryable: true });
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return false for ConnectionError with retryable=false', () => {
      const error = new ConnectionError('Test', { retryable: false });
      expect(isRetryableError(error)).toBe(false);
    });

    it('should return true for timeout errors', () => {
      const error = new ArbitrageError('Test', ErrorCode.CONNECTION_TIMEOUT);
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return true for rate limit errors', () => {
      const error = new ArbitrageError('Test', ErrorCode.RPC_RATE_LIMITED);
      expect(isRetryableError(error)).toBe(true);
    });

    it('should detect retryable patterns in message', () => {
      const error = new Error('Connection timeout occurred');
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return false for non-retryable errors', () => {
      const error = new ArbitrageError('Test', ErrorCode.VALIDATION_FAILED);
      expect(isRetryableError(error)).toBe(false);
    });
  });

  describe('isCriticalError()', () => {
    it('should return true for critical severity', () => {
      const error = new ArbitrageError('Test', ErrorCode.UNKNOWN_ERROR, {
        severity: ErrorSeverity.CRITICAL
      });
      expect(isCriticalError(error)).toBe(true);
    });

    it('should detect fatal patterns', () => {
      const error = new Error('Fatal error occurred');
      expect(isCriticalError(error)).toBe(true);
    });

    it('should return false for non-critical errors', () => {
      const error = new ArbitrageError('Test');
      expect(isCriticalError(error)).toBe(false);
    });
  });

  describe('getErrorSeverity()', () => {
    it('should return severity from ArbitrageError', () => {
      const error = new ArbitrageError('Test', ErrorCode.UNKNOWN_ERROR, {
        severity: ErrorSeverity.WARNING
      });
      expect(getErrorSeverity(error)).toBe(ErrorSeverity.WARNING);
    });

    it('should return CRITICAL for critical errors', () => {
      const error = new Error('Fatal error');
      expect(getErrorSeverity(error)).toBe(ErrorSeverity.CRITICAL);
    });

    it('should return WARNING for retryable errors', () => {
      const error = new Error('Connection timeout');
      expect(getErrorSeverity(error)).toBe(ErrorSeverity.WARNING);
    });

    it('should return ERROR by default', () => {
      const error = new Error('Some error');
      expect(getErrorSeverity(error)).toBe(ErrorSeverity.ERROR);
    });
  });
});

// =============================================================================
// Error Formatting Tests
// =============================================================================

describe('Error Formatting', () => {
  describe('formatErrorForLog()', () => {
    it('should format ArbitrageError', () => {
      const error = new ArbitrageError('Test', ErrorCode.VALIDATION_FAILED, {
        context: { key: 'value' }
      });

      const formatted = formatErrorForLog(error);

      expect(formatted.name).toBe('ArbitrageError');
      expect(formatted.message).toBe('Test');
      expect(formatted.code).toBe(ErrorCode.VALIDATION_FAILED);
      expect(formatted.context).toEqual({ key: 'value' });
    });

    it('should format plain Error', () => {
      const error = new Error('Plain error');

      const formatted = formatErrorForLog(error);

      expect(formatted.name).toBe('Error');
      expect(formatted.message).toBe('Plain error');
      expect(formatted.stack).toBeDefined();
    });
  });

  describe('formatErrorForResponse()', () => {
    it('should format ArbitrageError for API', () => {
      const error = new ArbitrageError('Validation failed', ErrorCode.VALIDATION_FAILED, {
        context: { field: 'email' }
      });

      const formatted = formatErrorForResponse(error);

      expect(formatted.code).toBe(ErrorCode.VALIDATION_FAILED);
      expect(formatted.message).toBe('Validation failed');
      expect(formatted.details).toEqual({ field: 'email' });
    });

    it('should format plain Error for API', () => {
      const error = new Error('Plain error');

      const formatted = formatErrorForResponse(error);

      expect(formatted.code).toBe(ErrorCode.UNKNOWN_ERROR);
      expect(formatted.message).toBe('Plain error');
    });
  });
});

// =============================================================================
// Error Aggregator Tests
// =============================================================================

describe('ErrorAggregator', () => {
  let aggregator: ErrorAggregator;

  beforeEach(() => {
    aggregator = new ErrorAggregator();
  });

  it('should add errors', () => {
    aggregator.add(new Error('Error 1'));
    aggregator.add(new Error('Error 2'));

    expect(aggregator.count()).toBe(2);
  });

  it('should convert plain Error to ArbitrageError', () => {
    aggregator.add(new Error('Plain error'));

    const errors = aggregator.getAll();
    expect(errors[0]).toBeInstanceOf(ArbitrageError);
  });

  it('should respect max errors limit', () => {
    const aggregator = new ErrorAggregator(3);

    aggregator.add(new Error('Error 1'));
    aggregator.add(new Error('Error 2'));
    aggregator.add(new Error('Error 3'));
    aggregator.add(new Error('Error 4'));

    expect(aggregator.count()).toBe(3);
  });

  it('should filter by severity', () => {
    aggregator.add(new ArbitrageError('Warning', ErrorCode.UNKNOWN_ERROR, {
      severity: ErrorSeverity.WARNING
    }));
    aggregator.add(new ArbitrageError('Error', ErrorCode.UNKNOWN_ERROR, {
      severity: ErrorSeverity.ERROR
    }));

    expect(aggregator.getBySeverity(ErrorSeverity.WARNING)).toHaveLength(1);
    expect(aggregator.getBySeverity(ErrorSeverity.ERROR)).toHaveLength(1);
  });

  it('should filter by code', () => {
    aggregator.add(new ArbitrageError('Test', ErrorCode.VALIDATION_FAILED));
    aggregator.add(new ArbitrageError('Test', ErrorCode.CONNECTION_FAILED));
    aggregator.add(new ArbitrageError('Test', ErrorCode.VALIDATION_FAILED));

    expect(aggregator.getByCode(ErrorCode.VALIDATION_FAILED)).toHaveLength(2);
    expect(aggregator.getByCode(ErrorCode.CONNECTION_FAILED)).toHaveLength(1);
  });

  it('should count by severity', () => {
    aggregator.add(new ArbitrageError('Warning', ErrorCode.UNKNOWN_ERROR, {
      severity: ErrorSeverity.WARNING
    }));
    aggregator.add(new ArbitrageError('Error', ErrorCode.UNKNOWN_ERROR, {
      severity: ErrorSeverity.ERROR
    }));
    aggregator.add(new ArbitrageError('Error2', ErrorCode.UNKNOWN_ERROR, {
      severity: ErrorSeverity.ERROR
    }));

    const counts = aggregator.countBySeverity();

    expect(counts[ErrorSeverity.WARNING]).toBe(1);
    expect(counts[ErrorSeverity.ERROR]).toBe(2);
    expect(counts[ErrorSeverity.CRITICAL]).toBe(0);
  });

  it('should clear all errors', () => {
    aggregator.add(new Error('Error 1'));
    aggregator.add(new Error('Error 2'));

    aggregator.clear();

    expect(aggregator.count()).toBe(0);
  });

  it('should detect critical errors', () => {
    aggregator.add(new ArbitrageError('Warning', ErrorCode.UNKNOWN_ERROR, {
      severity: ErrorSeverity.WARNING
    }));

    expect(aggregator.hasCriticalErrors()).toBe(false);

    aggregator.add(new ArbitrageError('Critical', ErrorCode.UNKNOWN_ERROR, {
      severity: ErrorSeverity.CRITICAL
    }));

    expect(aggregator.hasCriticalErrors()).toBe(true);
  });
});
