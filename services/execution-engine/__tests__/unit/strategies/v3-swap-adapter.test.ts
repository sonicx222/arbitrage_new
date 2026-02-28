/**
 * V3SwapAdapter Unit Tests
 *
 * Tests V3 swap encoding (exactInputSingle), DEX type detection,
 * and round-trip encode/decode validation.
 *
 * @see services/execution-engine/src/strategies/v3-swap-adapter.ts
 */

import { describe, it, expect } from '@jest/globals';
import { ethers } from 'ethers';
import {
  V3SwapAdapter,
  isV3Dex,
  V3_SWAP_ROUTER_ABI,
  type V3SwapParams,
} from '../../../src/strategies/v3-swap-adapter';

describe('V3SwapAdapter', () => {
  let adapter: V3SwapAdapter;

  beforeEach(() => {
    adapter = new V3SwapAdapter();
  });

  // =========================================================================
  // encodeExactInputSingle
  // =========================================================================

  describe('encodeExactInputSingle', () => {
    const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
    const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    const RECIPIENT = '0x1234567890123456789012345678901234567890';

    const defaultParams: V3SwapParams = {
      tokenIn: WETH,
      tokenOut: USDC,
      fee: 3000,
      recipient: RECIPIENT,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
      amountIn: ethers.parseEther('1'),
      amountOutMinimum: ethers.parseUnits('1800', 6),
      sqrtPriceLimitX96: 0n,
    };

    it('should produce valid ABI-encoded calldata', () => {
      const calldata = adapter.encodeExactInputSingle(defaultParams);

      // Calldata should be a hex string starting with 0x
      expect(calldata).toMatch(/^0x[0-9a-fA-F]+$/);

      // exactInputSingle selector is the first 4 bytes (10 hex chars including 0x)
      // Verify it starts with a valid selector
      expect(calldata.length).toBeGreaterThan(10);
    });

    it('should encode all fee tiers correctly', () => {
      const validFeeTiers = [100, 500, 3000, 10000];

      for (const fee of validFeeTiers) {
        const params: V3SwapParams = { ...defaultParams, fee };
        const calldata = adapter.encodeExactInputSingle(params);
        expect(calldata).toMatch(/^0x[0-9a-fA-F]+$/);
      }
    });

    it('should throw for invalid fee tier', () => {
      const invalidParams: V3SwapParams = { ...defaultParams, fee: 999 };

      expect(() => adapter.encodeExactInputSingle(invalidParams)).toThrow(
        '[V3SwapAdapter] Invalid fee tier: 999'
      );
    });

    it('should throw for zero fee tier', () => {
      const invalidParams: V3SwapParams = { ...defaultParams, fee: 0 };

      expect(() => adapter.encodeExactInputSingle(invalidParams)).toThrow(
        '[V3SwapAdapter] Invalid fee tier: 0'
      );
    });

    it('should encode zero amountOutMinimum (no slippage protection)', () => {
      const params: V3SwapParams = { ...defaultParams, amountOutMinimum: 0n };
      const calldata = adapter.encodeExactInputSingle(params);
      expect(calldata).toMatch(/^0x[0-9a-fA-F]+$/);
    });

    it('should encode zero sqrtPriceLimitX96 (no price limit)', () => {
      const params: V3SwapParams = { ...defaultParams, sqrtPriceLimitX96: 0n };
      const calldata = adapter.encodeExactInputSingle(params);
      expect(calldata).toMatch(/^0x[0-9a-fA-F]+$/);
    });

    it('should encode non-zero sqrtPriceLimitX96', () => {
      const params: V3SwapParams = {
        ...defaultParams,
        sqrtPriceLimitX96: 79228162514264337593543950336n, // sqrt(1) * 2^96
      };
      const calldata = adapter.encodeExactInputSingle(params);
      expect(calldata).toMatch(/^0x[0-9a-fA-F]+$/);
    });

    it('should produce different calldata for different parameters', () => {
      const calldata1 = adapter.encodeExactInputSingle(defaultParams);
      const calldata2 = adapter.encodeExactInputSingle({
        ...defaultParams,
        fee: 500,
      });

      expect(calldata1).not.toBe(calldata2);
    });

    it('should produce different calldata for different amounts', () => {
      const calldata1 = adapter.encodeExactInputSingle(defaultParams);
      const calldata2 = adapter.encodeExactInputSingle({
        ...defaultParams,
        amountIn: ethers.parseEther('2'),
      });

      expect(calldata1).not.toBe(calldata2);
    });
  });

  // =========================================================================
  // Decode round-trip (encode then decode)
  // =========================================================================

  describe('encode/decode round-trip', () => {
    const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
    const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    const RECIPIENT = '0x1234567890123456789012345678901234567890';

    it('should decode back to original parameters', () => {
      const params: V3SwapParams = {
        tokenIn: WETH,
        tokenOut: USDC,
        fee: 3000,
        recipient: RECIPIENT,
        deadline: 1700000000n,
        amountIn: ethers.parseEther('10'),
        amountOutMinimum: ethers.parseUnits('18000', 6),
        sqrtPriceLimitX96: 0n,
      };

      const calldata = adapter.encodeExactInputSingle(params);

      // Decode using ethers Interface
      const iface = new ethers.Interface(V3_SWAP_ROUTER_ABI);
      const decoded = iface.decodeFunctionData('exactInputSingle', calldata);

      // The decoded result is a tuple struct
      const decodedParams = decoded[0];

      expect(decodedParams.tokenIn).toBe(WETH);
      expect(decodedParams.tokenOut).toBe(USDC);
      expect(decodedParams.fee).toBe(BigInt(3000));
      expect(decodedParams.recipient).toBe(RECIPIENT);
      expect(decodedParams.deadline).toBe(1700000000n);
      expect(decodedParams.amountIn).toBe(ethers.parseEther('10'));
      expect(decodedParams.amountOutMinimum).toBe(ethers.parseUnits('18000', 6));
      expect(decodedParams.sqrtPriceLimitX96).toBe(0n);
    });

    it('should round-trip with all fee tiers', () => {
      const iface = new ethers.Interface(V3_SWAP_ROUTER_ABI);

      for (const fee of [100, 500, 3000, 10000]) {
        const params: V3SwapParams = {
          tokenIn: WETH,
          tokenOut: USDC,
          fee,
          recipient: RECIPIENT,
          deadline: 1700000000n,
          amountIn: ethers.parseEther('1'),
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        };

        const calldata = adapter.encodeExactInputSingle(params);
        const decoded = iface.decodeFunctionData('exactInputSingle', calldata);
        const decodedParams = decoded[0];

        expect(decodedParams.fee).toBe(BigInt(fee));
      }
    });

    it('should round-trip with large amounts', () => {
      const iface = new ethers.Interface(V3_SWAP_ROUTER_ABI);
      const largeAmount = ethers.parseEther('1000000'); // 1M ETH

      const params: V3SwapParams = {
        tokenIn: WETH,
        tokenOut: USDC,
        fee: 3000,
        recipient: RECIPIENT,
        deadline: 1700000000n,
        amountIn: largeAmount,
        amountOutMinimum: ethers.parseUnits('1800000000', 6), // 1.8B USDC
        sqrtPriceLimitX96: 0n,
      };

      const calldata = adapter.encodeExactInputSingle(params);
      const decoded = iface.decodeFunctionData('exactInputSingle', calldata);
      const decodedParams = decoded[0];

      expect(decodedParams.amountIn).toBe(largeAmount);
      expect(decodedParams.amountOutMinimum).toBe(ethers.parseUnits('1800000000', 6));
    });
  });
});

// ===========================================================================
// isV3Dex
// ===========================================================================

describe('isV3Dex', () => {
  describe('V3 DEXes', () => {
    it('should return true for uniswap_v3', () => {
      expect(isV3Dex('uniswap_v3')).toBe(true);
    });

    it('should return true for pancakeswap_v3', () => {
      expect(isV3Dex('pancakeswap_v3')).toBe(true);
    });

    it('should return true for algebra', () => {
      expect(isV3Dex('algebra')).toBe(true);
    });

    it('should return true for trader_joe_v2', () => {
      expect(isV3Dex('trader_joe_v2')).toBe(true);
    });
  });

  describe('case insensitive matching', () => {
    it('should match UNISWAP_V3 (uppercase)', () => {
      expect(isV3Dex('UNISWAP_V3')).toBe(true);
    });

    it('should match Uniswap_V3 (mixed case)', () => {
      expect(isV3Dex('Uniswap_V3')).toBe(true);
    });

    it('should match PancakeSwap_V3 (mixed case)', () => {
      expect(isV3Dex('PancakeSwap_V3')).toBe(true);
    });

    it('should handle leading/trailing whitespace', () => {
      expect(isV3Dex('  uniswap_v3  ')).toBe(true);
    });
  });

  describe('V2 DEXes (should return false)', () => {
    it('should return false for uniswap_v2', () => {
      expect(isV3Dex('uniswap_v2')).toBe(false);
    });

    it('should return false for pancakeswap_v2', () => {
      expect(isV3Dex('pancakeswap_v2')).toBe(false);
    });

    it('should return false for sushiswap', () => {
      expect(isV3Dex('sushiswap')).toBe(false);
    });

    it('should return false for quickswap', () => {
      expect(isV3Dex('quickswap')).toBe(false);
    });

    it('should return false for camelot', () => {
      expect(isV3Dex('camelot')).toBe(false);
    });

    it('should return false for aerodrome', () => {
      expect(isV3Dex('aerodrome')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isV3Dex('')).toBe(false);
    });
  });
});
