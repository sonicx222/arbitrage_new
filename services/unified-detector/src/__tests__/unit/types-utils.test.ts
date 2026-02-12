/**
 * Unit Tests for types.ts Utility Functions
 *
 * Tests environment variable parsing, WebSocket URL conversion,
 * and unstable chain detection utilities.
 */

import {
  parseIntEnvVar,
  parseFloatEnvVar,
  toWebSocketUrl,
  isUnstableChain,
} from '../../types';

// =============================================================================
// parseIntEnvVar Tests
// =============================================================================

describe('parseIntEnvVar', () => {
  const defaultValue = 1000;
  const min = 100;
  const max = 10000;

  it('should return default value when env var is undefined', () => {
    expect(parseIntEnvVar(undefined, defaultValue, min, max)).toBe(defaultValue);
  });

  it('should return default value when env var is empty string', () => {
    expect(parseIntEnvVar('', defaultValue, min, max)).toBe(defaultValue);
  });

  it('should return default value when env var is not a number', () => {
    expect(parseIntEnvVar('not-a-number', defaultValue, min, max)).toBe(defaultValue);
  });

  it('should parse valid integer within bounds', () => {
    expect(parseIntEnvVar('500', defaultValue, min, max)).toBe(500);
  });

  it('should clamp value to minimum when below min', () => {
    expect(parseIntEnvVar('50', defaultValue, min, max)).toBe(min);
  });

  it('should clamp value to maximum when above max', () => {
    expect(parseIntEnvVar('20000', defaultValue, min, max)).toBe(max);
  });

  it('should return exact min value when env var equals min', () => {
    expect(parseIntEnvVar('100', defaultValue, min, max)).toBe(100);
  });

  it('should return exact max value when env var equals max', () => {
    expect(parseIntEnvVar('10000', defaultValue, min, max)).toBe(10000);
  });

  it('should handle negative numbers', () => {
    expect(parseIntEnvVar('-500', defaultValue, -1000, max)).toBe(-500);
  });

  it('should truncate floating point values to integer', () => {
    expect(parseIntEnvVar('500.9', defaultValue, min, max)).toBe(500);
  });
});

// =============================================================================
// parseFloatEnvVar Tests
// =============================================================================

describe('parseFloatEnvVar', () => {
  const defaultValue = 0.02;
  const min = 0;
  const max = 1.0;

  it('should return default value when env var is undefined', () => {
    expect(parseFloatEnvVar(undefined, defaultValue, min, max)).toBe(defaultValue);
  });

  it('should return default value when env var is empty string', () => {
    expect(parseFloatEnvVar('', defaultValue, min, max)).toBe(defaultValue);
  });

  it('should return default value when env var is not a number', () => {
    expect(parseFloatEnvVar('not-a-number', defaultValue, min, max)).toBe(defaultValue);
  });

  it('should return default value when env var is NaN', () => {
    expect(parseFloatEnvVar('NaN', defaultValue, min, max)).toBe(defaultValue);
  });

  it('should return default value when env var is Infinity', () => {
    expect(parseFloatEnvVar('Infinity', defaultValue, min, max)).toBe(defaultValue);
  });

  it('should parse valid float within bounds', () => {
    expect(parseFloatEnvVar('0.5', defaultValue, min, max)).toBe(0.5);
  });

  it('should clamp value to minimum when below min', () => {
    expect(parseFloatEnvVar('-0.5', defaultValue, min, max)).toBe(min);
  });

  it('should clamp value to maximum when above max', () => {
    expect(parseFloatEnvVar('2.0', defaultValue, min, max)).toBe(max);
  });

  it('should return exact min value when env var equals min', () => {
    expect(parseFloatEnvVar('0', defaultValue, min, max)).toBe(0);
  });

  it('should return exact max value when env var equals max', () => {
    expect(parseFloatEnvVar('1.0', defaultValue, min, max)).toBe(1.0);
  });

  it('should handle scientific notation', () => {
    expect(parseFloatEnvVar('1e-2', defaultValue, min, max)).toBe(0.01);
  });
});

// =============================================================================
// toWebSocketUrl Tests
// =============================================================================

describe('toWebSocketUrl', () => {
  it('should return ws:// URL unchanged', () => {
    const result = toWebSocketUrl('ws://localhost:8546');
    expect(result.url).toBe('ws://localhost:8546');
    expect(result.converted).toBe(false);
    expect(result.originalUrl).toBeUndefined();
  });

  it('should return wss:// URL unchanged', () => {
    const result = toWebSocketUrl('wss://mainnet.infura.io/ws/v3/abc123');
    expect(result.url).toBe('wss://mainnet.infura.io/ws/v3/abc123');
    expect(result.converted).toBe(false);
  });

  it('should convert http:// to ws://', () => {
    const result = toWebSocketUrl('http://localhost:8545');
    expect(result.url).toBe('ws://localhost:8545');
    expect(result.converted).toBe(true);
    expect(result.originalUrl).toBe('http://localhost:8545');
  });

  it('should convert https:// to wss://', () => {
    const result = toWebSocketUrl('https://mainnet.infura.io/v3/abc123');
    expect(result.url).toBe('wss://mainnet.infura.io/v3/abc123');
    expect(result.converted).toBe(true);
    expect(result.originalUrl).toBe('https://mainnet.infura.io/v3/abc123');
  });

  it('should throw error for empty URL', () => {
    expect(() => toWebSocketUrl('')).toThrow('URL is required for WebSocket conversion');
  });

  it('should throw error for invalid protocol', () => {
    expect(() => toWebSocketUrl('ftp://localhost:8545')).toThrow('Cannot convert URL to WebSocket');
  });

  it('should throw error for URL without protocol', () => {
    expect(() => toWebSocketUrl('localhost:8545')).toThrow('Cannot convert URL to WebSocket');
  });
});

// =============================================================================
// isUnstableChain Tests
// =============================================================================

describe('isUnstableChain', () => {
  const unstableChains = ['bsc', 'fantom'] as const;

  it('should return true for unstable chain (lowercase)', () => {
    expect(isUnstableChain('bsc', unstableChains)).toBe(true);
    expect(isUnstableChain('fantom', unstableChains)).toBe(true);
  });

  it('should return true for unstable chain (uppercase)', () => {
    expect(isUnstableChain('BSC', unstableChains)).toBe(true);
    expect(isUnstableChain('FANTOM', unstableChains)).toBe(true);
  });

  it('should return true for unstable chain (mixed case)', () => {
    expect(isUnstableChain('BsC', unstableChains)).toBe(true);
    expect(isUnstableChain('FanTom', unstableChains)).toBe(true);
  });

  it('should return false for stable chain', () => {
    expect(isUnstableChain('ethereum', unstableChains)).toBe(false);
    expect(isUnstableChain('polygon', unstableChains)).toBe(false);
    expect(isUnstableChain('arbitrum', unstableChains)).toBe(false);
  });

  it('should return false for empty string', () => {
    expect(isUnstableChain('', unstableChains)).toBe(false);
  });

  it('should work with empty unstable chains list', () => {
    expect(isUnstableChain('bsc', [])).toBe(false);
  });
});

// Fee conversion tests removed — bpsToDecimal/decimalToBps are tested
// in their canonical location: shared/core (via @arbitrage/core)
