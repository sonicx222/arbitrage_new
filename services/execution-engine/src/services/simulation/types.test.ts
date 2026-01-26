/**
 * Simulation Types Utility Tests
 *
 * Tests for utility functions in the simulation types module.
 *
 * @see Fix 6.1: getSimulationErrorMessage
 * @see Fix 6.3: WETH address utilities
 * @see Fix 9.1-9.2: Timeout and metrics utilities
 */

import { describe, test, expect } from '@jest/globals';
import {
  getWethAddress,
  isWethAddress,
  getSimulationErrorMessage,
  createCancellableTimeout,
  updateRollingAverage,
  WETH_ADDRESSES,
  CHAIN_IDS,
} from './types';

// =============================================================================
// WETH Address Utilities (Fix 6.3)
// =============================================================================

describe('WETH Address Utilities (Fix 6.3)', () => {
  test('getWethAddress should return lowercase WETH address for known chains', () => {
    // Ethereum mainnet
    const ethWeth = getWethAddress(1);
    expect(ethWeth).toBe('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');

    // Arbitrum
    const arbWeth = getWethAddress(42161);
    expect(arbWeth).toBe('0x82af49447d8a07e3bd95bd0d56f35241523fbab1');

    // Optimism
    const opWeth = getWethAddress(10);
    expect(opWeth).toBe('0x4200000000000000000000000000000000000006');

    // Base
    const baseWeth = getWethAddress(8453);
    expect(baseWeth).toBe('0x4200000000000000000000000000000000000006');
  });

  test('getWethAddress should return undefined for unknown chains', () => {
    expect(getWethAddress(99999)).toBeUndefined();
    expect(getWethAddress(0)).toBeUndefined();
  });

  test('isWethAddress should return true for WETH addresses', () => {
    // Ethereum mainnet (case insensitive)
    expect(isWethAddress('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', 1)).toBe(true);
    expect(isWethAddress('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 1)).toBe(true);

    // Arbitrum
    expect(isWethAddress('0x82af49447d8a07e3bd95bd0d56f35241523fbab1', 42161)).toBe(true);
  });

  test('isWethAddress should return false for non-WETH addresses', () => {
    expect(isWethAddress('0x0000000000000000000000000000000000000000', 1)).toBe(false);
    expect(isWethAddress('0xdAC17F958D2ee523a2206206994597C13D831ec7', 1)).toBe(false);
  });

  test('isWethAddress should return false for unknown chains', () => {
    expect(isWethAddress('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', 99999)).toBe(false);
  });

  test('WETH_ADDRESSES should have all major chains', () => {
    expect(WETH_ADDRESSES[1]).toBeDefined(); // Ethereum
    expect(WETH_ADDRESSES[42161]).toBeDefined(); // Arbitrum
    expect(WETH_ADDRESSES[10]).toBeDefined(); // Optimism
    expect(WETH_ADDRESSES[137]).toBeDefined(); // Polygon
    expect(WETH_ADDRESSES[8453]).toBeDefined(); // Base
    expect(WETH_ADDRESSES[56]).toBeDefined(); // BSC
  });
});

// =============================================================================
// Error Message Utility (Fix 6.1)
// =============================================================================

describe('getSimulationErrorMessage (Fix 6.1)', () => {
  test('should extract message from Error instance', () => {
    const error = new Error('Test error message');
    expect(getSimulationErrorMessage(error)).toBe('Test error message');
  });

  test('should return string as-is', () => {
    expect(getSimulationErrorMessage('String error')).toBe('String error');
  });

  test('should convert other types to string', () => {
    expect(getSimulationErrorMessage(123)).toBe('123');
    expect(getSimulationErrorMessage(null)).toBe('null');
    expect(getSimulationErrorMessage(undefined)).toBe('undefined');
  });

  test('should handle objects', () => {
    const obj = { code: 'ERR_TEST' };
    expect(getSimulationErrorMessage(obj)).toBe('[object Object]');
  });
});

// =============================================================================
// Cancellable Timeout (Fix 9.1)
// =============================================================================

describe('createCancellableTimeout (Fix 9.1)', () => {
  test('should reject with error message after timeout', async () => {
    const { promise, cancel } = createCancellableTimeout(50, 'Test timeout');

    await expect(promise).rejects.toThrow('Test timeout');
  });

  test('should be cancellable before timeout', async () => {
    const { promise, cancel } = createCancellableTimeout(5000, 'Should not appear');

    // Cancel immediately
    cancel();

    // Promise should never resolve or reject
    // We verify by racing with a short timeout
    const result = await Promise.race([
      promise.catch(() => 'timed_out'),
      new Promise((resolve) => setTimeout(() => resolve('cancelled'), 100)),
    ]);

    expect(result).toBe('cancelled');
  });

  test('should allow multiple cancel calls', () => {
    const { cancel } = createCancellableTimeout(1000, 'Test');

    // Should not throw
    cancel();
    cancel();
    cancel();
  });
});

// =============================================================================
// Rolling Average (Fix 9.2)
// =============================================================================

describe('updateRollingAverage (Fix 9.2)', () => {
  test('should return new value when count is 1', () => {
    expect(updateRollingAverage(0, 100, 1)).toBe(100);
  });

  test('should return new value when count is 0 or negative', () => {
    expect(updateRollingAverage(50, 100, 0)).toBe(100);
    expect(updateRollingAverage(50, 100, -1)).toBe(100);
  });

  test('should calculate correct rolling average', () => {
    // After 2 samples: avg of 100 and 200 = 150
    expect(updateRollingAverage(100, 200, 2)).toBe(150);

    // After 3 samples: (100 * 2 + 300) / 3 = 166.67
    expect(updateRollingAverage(100, 300, 3)).toBeCloseTo(166.67, 1);

    // After 4 samples: (150 * 3 + 50) / 4 = 125
    expect(updateRollingAverage(150, 50, 4)).toBe(125);
  });

  test('should handle large sample counts', () => {
    // With 1000 samples, new value should have minimal impact
    const newAvg = updateRollingAverage(100, 200, 1000);
    expect(newAvg).toBeCloseTo(100.1, 1);
  });
});

// =============================================================================
// Chain IDs
// =============================================================================

describe('CHAIN_IDS', () => {
  test('should have correct chain IDs', () => {
    expect(CHAIN_IDS.ethereum).toBe(1);
    expect(CHAIN_IDS.arbitrum).toBe(42161);
    expect(CHAIN_IDS.optimism).toBe(10);
    expect(CHAIN_IDS.polygon).toBe(137);
    expect(CHAIN_IDS.base).toBe(8453);
    expect(CHAIN_IDS.bsc).toBe(56);
  });

  test('goerli should be marked deprecated (Fix 7.2)', () => {
    // Goerli is deprecated but still present for backward compatibility
    expect(CHAIN_IDS.goerli).toBe(5);
    // Sepolia should be used instead
    expect(CHAIN_IDS.sepolia).toBe(11155111);
  });
});
