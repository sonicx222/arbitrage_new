/**
 * Factory Parser Test Harness
 *
 * Provides shared validation tests for all factory event parsers.
 * Each parser shares identical behavior for null/undefined logs,
 * missing topics, missing data, and factory address lowercasing.
 *
 * @see factory-subscription/parsers/
 */

import { describe, it, expect } from '@jest/globals';
import type { RawEventLog, PairCreatedEvent } from '../../../../src/factory-subscription/parsers/types';

// =============================================================================
// Shared Test Constants
// =============================================================================

export const PARSER_TEST_CONSTANTS = {
  TOKEN0: '0x1111111111111111111111111111111111111111',
  TOKEN1: '0x2222222222222222222222222222222222222222',
  PAIR_ADDRESS: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
  FACTORY_ADDRESS: '0xFaCt0Ry000000000000000000000000000000001',
} as const;

// =============================================================================
// Shared Test Helpers
// =============================================================================

/** Pad an address to a 32-byte hex topic (with 0x prefix) */
export function toTopic(address: string): string {
  const raw = address.replace('0x', '').toLowerCase();
  return '0x' + raw.padStart(64, '0');
}

/** Convert a number to a 32-byte hex topic (with 0x prefix) */
export function numberToTopic(value: number): string {
  return '0x' + value.toString(16).padStart(64, '0');
}

// =============================================================================
// Parser Test Harness Config
// =============================================================================

export interface ParserTestConfig {
  /** Name of the parser function (used in describe block) */
  parserName: string;
  /** The parser function to test */
  parseFunction: (log: RawEventLog) => PairCreatedEvent | null;
  /** Factory function that creates a valid log for this parser */
  createValidLog: () => Record<string, any>;
  /** Minimum required topics count (e.g., 3 for V2, 4 for V3) */
  minTopics: number;
  /** Minimum required data words (32-byte chunks, e.g., 1 for V2, 2 for V3) */
  minDataWords: number;
}

// =============================================================================
// Shared Validation Test Suite
// =============================================================================

/**
 * Runs shared validation tests that are identical across all factory parsers:
 * - Null/undefined log handling (3 tests)
 * - Missing/insufficient topics (3 tests)
 * - Missing/insufficient data (3 tests)
 * - Factory address lowercasing (1 test)
 *
 * Total: 10 tests per parser
 */
export function testParserValidation(config: ParserTestConfig): void {
  const { parserName, parseFunction, createValidLog, minTopics, minDataWords } = config;

  describe(`${parserName} — shared validation`, () => {
    describe('Null/undefined log', () => {
      it('should return null for null log', () => {
        expect(parseFunction(null as unknown as RawEventLog)).toBeNull();
      });

      it('should return null for undefined log', () => {
        expect(parseFunction(undefined as unknown as RawEventLog)).toBeNull();
      });

      it('should return null for empty object', () => {
        expect(parseFunction({} as RawEventLog)).toBeNull();
      });
    });

    describe('Missing/insufficient topics', () => {
      it('should return null when topics is missing', () => {
        const log = createValidLog();
        delete log.topics;
        expect(parseFunction(log as RawEventLog)).toBeNull();
      });

      it(`should return null when topics has fewer than ${minTopics} entries`, () => {
        const log = createValidLog();
        log.topics = log.topics.slice(0, minTopics - 1);
        expect(parseFunction(log as RawEventLog)).toBeNull();
      });

      it('should return null when topics is empty', () => {
        const log = createValidLog();
        log.topics = [];
        expect(parseFunction(log as RawEventLog)).toBeNull();
      });
    });

    describe('Missing/insufficient data', () => {
      it('should return null when data is missing', () => {
        const log = createValidLog();
        delete log.data;
        expect(parseFunction(log as RawEventLog)).toBeNull();
      });

      it(`should return null when data has fewer than ${minDataWords} word(s)`, () => {
        const log = createValidLog();
        // Provide one fewer word than required (each word = 64 hex chars)
        const insufficientChars = Math.max(0, (minDataWords - 1)) * 64;
        log.data = insufficientChars > 0 ? '0x' + '0'.repeat(insufficientChars) : '0x' + '0'.repeat(32);
        expect(parseFunction(log as RawEventLog)).toBeNull();
      });

      it('should return null when data is just the prefix', () => {
        const log = createValidLog();
        log.data = '0x';
        expect(parseFunction(log as RawEventLog)).toBeNull();
      });
    });

    describe('Factory address lowercasing', () => {
      it('should lowercase factory address from log', () => {
        const log = createValidLog();
        log.address = '0xABCDEF1234567890ABCDEF1234567890ABCDEF12';
        const result = parseFunction(log as RawEventLog);
        expect(result).not.toBeNull();
        expect(result!.factoryAddress).toBe('0xabcdef1234567890abcdef1234567890abcdef12');
      });
    });
  });
}
