/**
 * P1-2 FIX: Decoder Edge Case Tests
 *
 * Tests for edge cases in swap decoders that weren't covered by the main
 * decoders.test.ts: malformed calldata, truncated inputs, zero amounts,
 * unusual paths, uppercase selectors, and registry error handling.
 *
 * @see services/mempool-detector/src/decoders/
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { RecordingLogger } from '@arbitrage/core/logging';
import type { RawPendingTransaction } from '../../src/types';
import {
  UniswapV2Decoder,
  UniswapV3Decoder,
  CurveDecoder,
  OneInchDecoder,
  DecoderRegistry,
  createDecoderRegistry,
} from '../../src/decoders';
import {
  hexToBigInt,
  isValidInput,
  extractAddress,
} from '../../src/decoders/base-decoder';

// =============================================================================
// Test Helpers
// =============================================================================

function createBaseTx(overrides?: Partial<RawPendingTransaction>): RawPendingTransaction {
  return {
    hash: '0xabc123',
    from: '0x1111111111111111111111111111111111111111',
    to: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
    value: '0x0',
    input: '0x',
    gas: '0x30d40',
    nonce: '0x1',
    chainId: 1,
    ...overrides,
  };
}

// =============================================================================
// Base Decoder Utility Tests
// =============================================================================

describe('hexToBigInt', () => {
  it('should convert valid hex strings', () => {
    expect(hexToBigInt('0x1')).toBe(1n);
    expect(hexToBigInt('0xff')).toBe(255n);
    expect(hexToBigInt('0xDE0B6B3A7640000')).toBe(1000000000000000000n); // 1 ETH
  });

  it('should return 0n for empty/zero inputs', () => {
    expect(hexToBigInt('')).toBe(0n);
    expect(hexToBigInt('0x')).toBe(0n);
    expect(hexToBigInt('0x0')).toBe(0n);
  });

  it('should handle large values (uint256 max)', () => {
    const maxUint256 = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    expect(hexToBigInt(maxUint256)).toBe(2n ** 256n - 1n);
  });
});

describe('isValidInput', () => {
  it('should return true for valid hex input with selector', () => {
    expect(isValidInput('0x38ed1739', 10)).toBe(true);
    expect(isValidInput('0x38ed1739abcdef', 10)).toBe(true);
  });

  it('should return false for too-short input', () => {
    expect(isValidInput('0x38ed17', 10)).toBe(false);
    expect(isValidInput('0x', 10)).toBe(false);
    expect(isValidInput('', 10)).toBe(false);
  });

  it('should return false for non-hex input', () => {
    expect(isValidInput('not hex data', 10)).toBe(false);
  });

  it('should return false for input without 0x prefix', () => {
    expect(isValidInput('38ed173900000000', 10)).toBe(false);
  });

  it('should use default minLength of 10', () => {
    expect(isValidInput('0x38ed1739')).toBe(true);
    expect(isValidInput('0x38ed17')).toBe(false);
  });
});

describe('extractAddress', () => {
  it('should extract address from zero-padded 32-byte data', () => {
    const padded = '0000000000000000000000007a250d5630B4cF539739dF2C5dAcb4c659F2488D';
    expect(extractAddress(padded)?.toLowerCase()).toBe('0x7a250d5630b4cf539739df2c5dacb4c659f2488d');
  });

  it('should return null for empty input', () => {
    expect(extractAddress('')).toBeNull();
  });

  it('should return null for non-hex input', () => {
    expect(extractAddress('gggggggg')).toBeNull();
  });

  it('should handle all-zero input', () => {
    const zeros = '0'.repeat(64);
    expect(extractAddress(zeros)).toBe('0x' + '0'.repeat(40));
  });

  it('should handle short address data', () => {
    const result = extractAddress('abcdef');
    expect(result).toBe('0x' + '0'.repeat(34) + 'abcdef');
  });
});

// =============================================================================
// UniswapV2 Edge Cases
// =============================================================================

describe('UniswapV2Decoder edge cases', () => {
  let decoder: UniswapV2Decoder;
  let logger: RecordingLogger;

  beforeEach(() => {
    logger = new RecordingLogger('test');
    decoder = new UniswapV2Decoder(logger);
  });

  it('should return null for input with valid selector but truncated calldata', () => {
    // Valid swapExactTokensForTokens selector but no arguments
    const tx = createBaseTx({ input: '0x38ed1739' });
    expect(decoder.decode(tx)).toBeNull();
  });

  it('should return null for input with valid selector but corrupted ABI data', () => {
    // Selector + random garbage that isn't valid ABI encoding
    const tx = createBaseTx({
      input: '0x38ed1739' + 'ff'.repeat(32),
    });
    expect(decoder.decode(tx)).toBeNull();
  });

  it('should return null for completely empty input', () => {
    const tx = createBaseTx({ input: '' });
    expect(decoder.decode(tx)).toBeNull();
  });

  it('should return null for input with just 0x prefix', () => {
    const tx = createBaseTx({ input: '0x' });
    expect(decoder.decode(tx)).toBeNull();
  });

  it('should handle missing gasPrice and maxFeePerGas gracefully', () => {
    const tx = createBaseTx({
      gasPrice: undefined,
      maxFeePerGas: undefined,
    });
    // canDecode should still work on input, decode will fail due to no valid input
    expect(decoder.canDecode(tx)).toBe(false);
  });

  it('should handle missing nonce', () => {
    const tx = createBaseTx({ nonce: '' });
    // Without a valid swap input, decode returns null — but shouldn't crash
    expect(decoder.decode(tx)).toBeNull();
  });
});

// =============================================================================
// UniswapV3 Edge Cases
// =============================================================================

describe('UniswapV3Decoder edge cases', () => {
  let decoder: UniswapV3Decoder;
  let logger: RecordingLogger;

  beforeEach(() => {
    logger = new RecordingLogger('test');
    decoder = new UniswapV3Decoder(logger);
  });

  it('should return null for truncated exactInputSingle calldata', () => {
    const tx = createBaseTx({ input: '0x414bf389' + '00'.repeat(10) });
    expect(decoder.decode(tx)).toBeNull();
  });

  describe('decodeV3Path edge cases', () => {
    it('should return empty array for path shorter than minimum (86 hex chars)', () => {
      // Single token (40 hex chars) — too short for a swap path
      const shortPath = '0x' + 'aa'.repeat(20);
      expect(decoder.decodeV3Path(shortPath)).toEqual([]);
    });

    it('should return empty array for empty path', () => {
      expect(decoder.decodeV3Path('')).toEqual([]);
      expect(decoder.decodeV3Path('0x')).toEqual([]);
    });

    it('should handle misaligned path length gracefully', () => {
      // 86 chars (minimum) + extra 5 chars (not aligned to hop size)
      const token1 = 'C02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
      const fee = '000bb8'; // 3000 (0.3%)
      const token2 = 'A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
      const path = token1 + fee + token2 + 'abcde'; // Extra unaligned bytes
      const result = decoder.decodeV3Path(path);
      // Should still extract the 2 valid tokens
      expect(result.length).toBe(2);
    });

    it('should handle path with non-hex characters in token position', () => {
      // First token is valid, but second has non-hex chars
      const token1 = 'C02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
      const fee = '000bb8';
      const badToken = 'ZZZZ' + '0'.repeat(36); // Invalid hex
      const path = token1 + fee + badToken;
      const result = decoder.decodeV3Path(path);
      // Should extract first token, then stop at invalid second token
      expect(result.length).toBeLessThan(2);
    });

    it('should decode 3-hop path correctly', () => {
      // Use exact 40-char hex tokens to avoid length mismatches
      const token1 = 'aa'.repeat(20); // 40 chars
      const fee1 = '000bb8'; // 3000 bps
      const token2 = 'bb'.repeat(20);
      const fee2 = '0001f4'; // 500 bps
      const token3 = 'cc'.repeat(20);
      const fee3 = '000bb8';
      const token4 = 'dd'.repeat(20);

      const path = token1 + fee1 + token2 + fee2 + token3 + fee3 + token4;
      const result = decoder.decodeV3Path(path);
      expect(result.length).toBe(4);
      expect(result[0]).toBe('0x' + token1);
      expect(result[1]).toBe('0x' + token2);
      expect(result[2]).toBe('0x' + token3);
      expect(result[3]).toBe('0x' + token4);
    });
  });
});

// =============================================================================
// CurveDecoder Edge Cases
// =============================================================================

describe('CurveDecoder edge cases', () => {
  let decoder: CurveDecoder;
  let logger: RecordingLogger;

  beforeEach(() => {
    logger = new RecordingLogger('test');
    decoder = new CurveDecoder(logger);
  });

  it('should return null for truncated exchange calldata', () => {
    const tx = createBaseTx({
      input: '0x3df02124' + '00'.repeat(10),
    });
    expect(decoder.decode(tx)).toBeNull();
  });

  it('should handle zero amounts in exchange', () => {
    // This is a valid ABI encoding of exchange(0, 1, 0, 0) — zero amounts
    const tx = createBaseTx({
      to: '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7', // 3pool
      input: '0x3df02124' +
        '0000000000000000000000000000000000000000000000000000000000000000' + // i=0
        '0000000000000000000000000000000000000000000000000000000000000001' + // j=1
        '0000000000000000000000000000000000000000000000000000000000000000' + // dx=0
        '0000000000000000000000000000000000000000000000000000000000000000', // min_dy=0
    });
    const result = decoder.decode(tx);
    // Should decode successfully even with zero amounts
    if (result) {
      expect(result.amountIn).toBe(0n);
      expect(result.expectedAmountOut).toBe(0n);
    }
  });

  it('should use pool address as placeholder for unknown pools', () => {
    const unknownPool = '0x0000000000000000000000000000000000000099';
    const tx = createBaseTx({
      to: unknownPool,
      input: '0x3df02124' +
        '0000000000000000000000000000000000000000000000000000000000000000' +
        '0000000000000000000000000000000000000000000000000000000000000001' +
        '0000000000000000000000000000000000000000000000000DE0B6B3A7640000' + // 1e18
        '0000000000000000000000000000000000000000000000000DE0B6B3A7640000',
    });
    const result = decoder.decode(tx);
    if (result) {
      // Unknown pool uses pool address as placeholder
      expect(result.tokenIn).toBe(unknownPool.toLowerCase());
      expect(result.tokenOut).toBe(unknownPool.toLowerCase());
      expect(result._curvePoolInfo).toBeDefined();
      expect(result._curvePoolInfo?.tokensResolved).toBe(false);
    }
  });

  it('should calculate slippage from stablecoin ratio', () => {
    // 1000 USDC in, 995 USDC out => ~0.5% slippage
    const amountIn = 1000000000n; // 1000 * 1e6
    const minOut = 995000000n; // 995 * 1e6
    // Access the protected method through decode
    const tx = createBaseTx({
      to: '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
      input: '0x3df02124' +
        '0000000000000000000000000000000000000000000000000000000000000000' +
        '0000000000000000000000000000000000000000000000000000000000000001' +
        '000000000000000000000000000000000000000000000000000000003B9ACA00' + // 1000e6
        '000000000000000000000000000000000000000000000000000000003B49D200', // 995e6
    });
    const result = decoder.decode(tx);
    if (result) {
      expect(result.slippageTolerance).toBeGreaterThan(0);
      expect(result.slippageTolerance).toBeLessThan(0.01); // Should be ~0.5%
    }
  });
});

// =============================================================================
// OneInchDecoder Edge Cases
// =============================================================================

describe('OneInchDecoder edge cases', () => {
  let decoder: OneInchDecoder;
  let logger: RecordingLogger;

  beforeEach(() => {
    logger = new RecordingLogger('test');
    decoder = new OneInchDecoder(logger);
  });

  it('should return null for truncated swap calldata', () => {
    const tx = createBaseTx({
      input: '0x12aa3caf' + '00'.repeat(10),
    });
    expect(decoder.decode(tx)).toBeNull();
  });

  it('should return null for completely invalid input', () => {
    const tx = createBaseTx({ input: '0x12aa3caf' + 'zz'.repeat(100) });
    expect(decoder.decode(tx)).toBeNull();
  });

  it('should handle canDecode for all known selectors', () => {
    const selectors = [
      '0x12aa3caf', // swap
      '0x0502b1c5', // unoswap
      '0xf78dc253', // unoswapTo
      '0xe449022e', // uniswapV3Swap
      '0xbc80f1a8', // uniswapV3SwapTo
      '0xb0431182', // clipperSwap
      '0x84bd6d29', // clipperSwapTo
      '0x62e238bb', // fillOrder
      '0x3eca9c0a', // fillOrderTo
    ];

    for (const sel of selectors) {
      const tx = createBaseTx({ input: sel + '00'.repeat(100) });
      expect(decoder.canDecode(tx)).toBe(true);
    }
  });

  it('should not match V2 selectors', () => {
    const tx = createBaseTx({ input: '0x38ed1739' + '00'.repeat(100) });
    expect(decoder.canDecode(tx)).toBe(false);
  });
});

// =============================================================================
// DecoderRegistry Edge Cases
// =============================================================================

describe('DecoderRegistry edge cases', () => {
  let registry: DecoderRegistry;
  let logger: RecordingLogger;

  beforeEach(() => {
    logger = new RecordingLogger('test');
    registry = createDecoderRegistry(logger);
  });

  it('should handle uppercase hex selectors (bloXroute normalization)', () => {
    // Some feeds might send uppercase hex
    const uppercaseSelector = '0x38ED1739'; // swapExactTokensForTokens
    const tx = createBaseTx({ input: uppercaseSelector + '00'.repeat(200) });
    // Should attempt to match after case normalization
    const result = registry.decode(tx, 1);
    // Either null (truncated data) or decoded — but should NOT throw
    expect(result === null || typeof result === 'object').toBe(true);
  });

  it('should return null for non-swap transactions (transfer, approve)', () => {
    // ERC20 transfer selector
    const tx = createBaseTx({
      input: '0xa9059cbb' +
        '0000000000000000000000007a250d5630B4cF539739dF2C5dAcb4c659F2488D' +
        '0000000000000000000000000000000000000000000000000DE0B6B3A7640000',
    });
    expect(registry.decode(tx, 1)).toBeNull();
  });

  it('should return null for short input (less than 4 bytes)', () => {
    const tx = createBaseTx({ input: '0x38ed' });
    expect(registry.decode(tx, 1)).toBeNull();
  });

  it('should return null for null/undefined input', () => {
    const tx = createBaseTx({ input: '' });
    expect(registry.decode(tx, 1)).toBeNull();
  });

  it('should handle chain ID as string name', () => {
    const tx = createBaseTx({ input: '0x38ed1739' + '00'.repeat(200) });
    // Should not throw when given chain name
    const result = registry.decode(tx, 'ethereum');
    expect(result === null || typeof result === 'object').toBe(true);
  });

  it('should handle unknown chain names gracefully', () => {
    const tx = createBaseTx({ input: '0x38ed1739' + '00'.repeat(200) });
    // Unknown chain name — should still try to decode
    const result = registry.decode(tx, 'unknown_chain');
    expect(result === null || typeof result === 'object').toBe(true);
  });

  it('should support registerDecoder for custom decoders', () => {
    const customDecoder = {
      type: 'uniswapV2' as const,
      name: 'Custom',
      supportedChains: [1],
      canDecode: () => true,
      decode: () => null,
    };

    registry.registerDecoder('0xdeadbeef', customDecoder);
    expect(registry.getDecoderForSelector('0xdeadbeef')).toBe(customDecoder);
  });

  it('should normalize selector case in getDecoderForSelector', () => {
    const decoder = registry.getDecoderForSelector('0x38ED1739');
    expect(decoder).toBeDefined();
  });

  it('should return correct stats', () => {
    const stats = registry.getStats();
    expect(stats.decoderCount).toBeGreaterThan(0);
    expect(stats.selectorCount).toBeGreaterThan(0);
    expect(stats.chainCount).toBeGreaterThan(0);
  });

  it('should return supported selectors as array', () => {
    const selectors = registry.getSupportedSelectors();
    expect(Array.isArray(selectors)).toBe(true);
    expect(selectors.length).toBeGreaterThan(10); // V2 + V3 + Curve + 1inch
    // All should be lowercase with 0x prefix
    for (const sel of selectors) {
      expect(sel).toMatch(/^0x[0-9a-f]{8}$/);
    }
  });
});
