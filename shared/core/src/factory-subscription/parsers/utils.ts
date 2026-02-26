/**
 * Shared Parsing Utilities for Factory Event Parsers
 *
 * Contains constants and utility functions for parsing Ethereum event logs.
 * These utilities handle hex string manipulation, address extraction, and
 * number parsing from ABI-encoded event data.
 *
 * @module factory-subscription/parsers/utils
 */

// =============================================================================
// Constants for Hex Parsing
// =============================================================================

/** Offset for '0x' prefix in hex strings */
export const HEX_PREFIX_LENGTH = 2;

/** Size of a 32-byte word in hex characters (64) */
export const WORD_SIZE_HEX = 64;

/** Offset to extract address from 32-byte padded value (12 bytes padding = 24 hex chars) */
export const ADDRESS_PADDING_OFFSET = 24;

/** Full offset including '0x' prefix for first address in data */
export const FIRST_ADDRESS_START = HEX_PREFIX_LENGTH + ADDRESS_PADDING_OFFSET; // 26

/** Full offset including '0x' prefix for second value in data */
export const SECOND_VALUE_START = HEX_PREFIX_LENGTH + WORD_SIZE_HEX + ADDRESS_PADDING_OFFSET; // 90

/** Zero address constant for comparison */
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// =============================================================================
// Hex Parsing Utilities
// =============================================================================

/**
 * Extract an address from a 32-byte padded hex topic.
 * Topics are always 32 bytes (64 hex chars) with address in last 20 bytes.
 *
 * @param paddedHex - 32-byte hex string (with or without 0x prefix)
 * @returns Lowercase address with 0x prefix
 */
export function extractAddressFromTopic(paddedHex: string): string {
  // Handle both 0x-prefixed and non-prefixed topics
  const offset = paddedHex.startsWith('0x') ? HEX_PREFIX_LENGTH + ADDRESS_PADDING_OFFSET : ADDRESS_PADDING_OFFSET;
  return ('0x' + paddedHex.slice(offset)).toLowerCase();
}

/**
 * Extract an address from a 32-byte padded hex data word at a specific offset.
 *
 * @param data - The hex data string (with 0x prefix)
 * @param wordIndex - The word index (0-based, each word is 32 bytes)
 * @returns Lowercase address with 0x prefix
 */
export function extractAddressFromDataWord(data: string, wordIndex: number): string {
  const startOffset = HEX_PREFIX_LENGTH + (wordIndex * WORD_SIZE_HEX) + ADDRESS_PADDING_OFFSET;
  return ('0x' + data.slice(startOffset, startOffset + 40)).toLowerCase();
}

/**
 * Extract a uint256 value from data at a specific word index as bigint.
 * Use this when you need full precision for large values (pool IDs, reserves, etc.).
 *
 * @param data - The hex data string (with 0x prefix)
 * @param wordIndex - The word index (0-based, each word is 32 bytes)
 * @returns The uint256 as a bigint (full precision)
 */
export function extractBigIntFromDataWord(data: string, wordIndex: number): bigint {
  const startOffset = HEX_PREFIX_LENGTH + (wordIndex * WORD_SIZE_HEX);
  const hexValue = data.slice(startOffset, startOffset + WORD_SIZE_HEX);
  return BigInt('0x' + hexValue);
}

/**
 * Extract a uint256 value from data at a specific word index as number.
 *
 * Returns -1 as sentinel value when overflow occurs, allowing callers
 * to detect and handle the overflow case. Use extractBigIntFromDataWord() when
 * full precision is required.
 *
 * @param data - The hex data string (with 0x prefix)
 * @param wordIndex - The word index (0-based, each word is 32 bytes)
 * @returns The uint256 as a number, or -1 if the value exceeds Number.MAX_SAFE_INTEGER
 */
export function extractUint256FromDataWord(data: string, wordIndex: number): number {
  const bigValue = extractBigIntFromDataWord(data, wordIndex);
  if (bigValue > BigInt(Number.MAX_SAFE_INTEGER)) {
    // Return -1 sentinel instead of silently truncating to MAX_SAFE_INTEGER
    // This allows callers to detect overflow and use bigint version if needed
    return -1;
  }
  return Number(bigValue);
}

/**
 * Parse a signed int24 from a hex string using two's complement.
 * int24 range: -8388608 to 8388607
 *
 * @param hexValue - Hex string representing the int24
 * @returns Signed integer value
 */
export function parseSignedInt24(hexValue: string): number {
  const value = parseInt(hexValue, 16);
  // int24 is 24 bits, sign bit is at position 23 (counting from 0)
  const INT24_MAX = 0x7FFFFF; // 8388607
  const INT24_SIGN_BIT = 0x800000; // 8388608

  if (value > INT24_MAX) {
    // Negative number - convert from two's complement
    return value - (INT24_SIGN_BIT * 2); // Subtract 2^24
  }
  return value;
}

// =============================================================================
// Log Validation Utilities
// =============================================================================

/**
 * Validate that a log has the minimum required structure.
 *
 * @param log - The raw log object to validate
 * @param minTopics - Minimum number of topics required
 * @param minDataWords - Minimum number of 32-byte words in data
 * @returns True if log is valid, false otherwise
 */
export function validateLogStructure(
  log: unknown,
  minTopics: number,
  minDataWords: number
): boolean {
  const logObj = log as { topics?: string[]; data?: string };
  if (!logObj || !logObj.topics || !logObj.data) {
    return false;
  }
  if (logObj.topics.length < minTopics) {
    return false;
  }
  const minDataLength = HEX_PREFIX_LENGTH + (minDataWords * WORD_SIZE_HEX);
  if (logObj.data.length < minDataLength) {
    return false;
  }
  return true;
}
