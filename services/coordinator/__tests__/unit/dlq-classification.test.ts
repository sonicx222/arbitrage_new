/**
 * Unit Tests for DLQ Error Classification
 *
 * L-14 FIX: Tests the classifyDlqError function that categorizes dead-letter
 * queue entries into structured error types for metrics tracking.
 *
 * @see coordinator.ts classifyDlqError()
 */

import { classifyDlqError } from '../../src/coordinator';

describe('classifyDlqError', () => {
  describe('expired classification', () => {
    it('should classify EXPIRED error codes', () => {
      expect(classifyDlqError('EXPIRED')).toBe('expired');
      expect(classifyDlqError('OPP_EXPIRED')).toBe('expired');
      expect(classifyDlqError('[VAL_EXPIRED_TTL]')).toBe('expired');
    });

    it('should classify TTL error codes', () => {
      expect(classifyDlqError('TTL_EXCEEDED')).toBe('expired');
      expect(classifyDlqError('[ERR_TTL]')).toBe('expired');
    });

    it('should classify STALE error codes', () => {
      expect(classifyDlqError('STALE_PRICE')).toBe('expired');
      expect(classifyDlqError('DATA_STALE')).toBe('expired');
    });
  });

  describe('validation classification', () => {
    it('should classify [VAL_ prefixed error codes', () => {
      expect(classifyDlqError('[VAL_MISSING_FIELD]')).toBe('validation');
      expect(classifyDlqError('[VAL_BAD_FORMAT]')).toBe('validation');
    });

    it('should classify VALIDATION error codes', () => {
      expect(classifyDlqError('VALIDATION_FAILED')).toBe('validation');
      expect(classifyDlqError('SCHEMA_VALIDATION_ERROR')).toBe('validation');
    });

    it('should classify INVALID error codes', () => {
      expect(classifyDlqError('INVALID_CHAIN')).toBe('validation');
      expect(classifyDlqError('INVALID_OPPORTUNITY')).toBe('validation');
    });
  });

  describe('transient classification', () => {
    it('should classify [ERR_ prefixed error codes', () => {
      expect(classifyDlqError('[ERR_REDIS_UNAVAILABLE]')).toBe('transient');
      expect(classifyDlqError('[ERR_CONNECTION_RESET]')).toBe('transient');
    });

    it('should classify TIMEOUT error codes', () => {
      expect(classifyDlqError('TIMEOUT')).toBe('transient');
      expect(classifyDlqError('RPC_TIMEOUT')).toBe('transient');
    });

    it('should classify RETRY error codes', () => {
      expect(classifyDlqError('RETRY_EXHAUSTED')).toBe('transient');
      expect(classifyDlqError('MAX_RETRY_EXCEEDED')).toBe('transient');
    });
  });

  describe('unknown classification', () => {
    it('should classify unrecognized error codes as unknown', () => {
      expect(classifyDlqError('unknown')).toBe('unknown');
      expect(classifyDlqError('')).toBe('unknown');
      expect(classifyDlqError('SOME_OTHER_ERROR')).toBe('unknown');
    });
  });

  describe('priority (expired > validation > transient)', () => {
    it('should classify EXPIRED even with VAL_ prefix (expired takes priority)', () => {
      // EXPIRED keyword checked first, so [VAL_EXPIRED_TTL] → expired, not validation
      expect(classifyDlqError('[VAL_EXPIRED_TTL]')).toBe('expired');
    });
  });
});
