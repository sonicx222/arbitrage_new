/**
 * Uniswap V3 Swap Decoder
 *
 * Decodes Uniswap V3 style swap transactions (also works for PancakeSwap V3).
 *
 * Supported methods:
 * - exactInputSingle (original SwapRouter)
 * - exactInput (original SwapRouter)
 * - exactOutputSingle (original SwapRouter)
 * - exactOutput (original SwapRouter)
 * - exactInputSingle (SwapRouter02 - no deadline in struct)
 * - exactInput (SwapRouter02)
 * - exactOutputSingle (SwapRouter02)
 * - exactOutput (SwapRouter02)
 *
 * @see Task 1.3.2: Pending Transaction Decoder (Implementation Plan v3.0)
 */

import { Interface } from 'ethers';
import type { Logger } from '@arbitrage/core';
import { BaseDecoder, hexToBigInt, isValidInput } from './base-decoder';
import type { RawPendingTransaction, PendingSwapIntent, SwapRouterType, SelectorInfo } from './base-decoder';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Uniswap V3 function selectors.
 */
export const UNISWAP_V3_SELECTORS: Record<string, SelectorInfo> = {
  // Original SwapRouter
  '0x414bf389': { method: 'exactInputSingle', routerTypes: ['uniswapV3'] },
  '0xc04b8d59': { method: 'exactInput', routerTypes: ['uniswapV3'] },
  '0xdb3e2198': { method: 'exactOutputSingle', routerTypes: ['uniswapV3'] },
  '0xf28c0498': { method: 'exactOutput', routerTypes: ['uniswapV3'] },
  // SwapRouter02 (no deadline in struct)
  '0x04e45aaf': { method: 'exactInputSingle', routerTypes: ['uniswapV3'] },
  '0x5023b4df': { method: 'exactOutputSingle', routerTypes: ['uniswapV3'] },
  '0xb858183f': { method: 'exactInput', routerTypes: ['uniswapV3'] },
  '0x09b81346': { method: 'exactOutput', routerTypes: ['uniswapV3'] },
};

/**
 * Selectors for original SwapRouter (has deadline in struct).
 */
const ORIGINAL_ROUTER_SELECTORS = new Set([
  '0x414bf389',
  '0xc04b8d59',
  '0xdb3e2198',
  '0xf28c0498',
]);

/**
 * Uniswap V3 SwapRouter ABI fragment.
 */
const UNISWAP_V3_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut)',
  'function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum)) returns (uint256 amountOut)',
  'function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96)) returns (uint256 amountIn)',
  'function exactOutput((bytes path, address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum)) returns (uint256 amountIn)',
];

/**
 * Uniswap V3 SwapRouter02 ABI fragment (no deadline in struct).
 */
const UNISWAP_V3_ROUTER02_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut)',
  'function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96)) returns (uint256 amountIn)',
  'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum)) returns (uint256 amountOut)',
  'function exactOutput((bytes path, address recipient, uint256 amountOut, uint256 amountInMaximum)) returns (uint256 amountIn)',
];

// Pre-create Interface instances for performance
const uniswapV3Interface = new Interface(UNISWAP_V3_ABI);
const uniswapV3Router02Interface = new Interface(UNISWAP_V3_ROUTER02_ABI);

// =============================================================================
// DECODER IMPLEMENTATION
// =============================================================================

/**
 * Uniswap V3 Style Swap Decoder
 *
 * Decodes swap transactions for Uniswap V3, PancakeSwap V3, and other
 * V3-compatible routers.
 */
export class UniswapV3Decoder extends BaseDecoder {
  readonly type: SwapRouterType = 'uniswapV3';
  readonly name = 'Uniswap V3';
  readonly supportedChains = [1, 56, 137, 42161, 10, 8453];

  constructor(logger: Logger) {
    super(logger);
  }

  /**
   * Check if this decoder can handle the given transaction.
   */
  canDecode(tx: RawPendingTransaction): boolean {
    const selector = this.getSelector(tx.input);
    if (!selector) return false;
    return selector in UNISWAP_V3_SELECTORS;
  }

  /**
   * Decode Uniswap V3 style swap transaction.
   */
  decode(tx: RawPendingTransaction): PendingSwapIntent | null {
    if (!isValidInput(tx.input, 10)) {
      return null;
    }

    const selector = this.getSelector(tx.input)!;
    const isOriginalRouter = ORIGINAL_ROUTER_SELECTORS.has(selector);

    try {
      // Try the appropriate ABI based on selector
      const iface = isOriginalRouter ? uniswapV3Interface : uniswapV3Router02Interface;
      let decoded = iface.parseTransaction({
        data: tx.input,
        value: hexToBigInt(tx.value),
      });

      // Fallback: try the other ABI if parsing failed
      if (!decoded && !isOriginalRouter) {
        decoded = uniswapV3Interface.parseTransaction({
          data: tx.input,
          value: hexToBigInt(tx.value),
        });
      } else if (!decoded && isOriginalRouter) {
        decoded = uniswapV3Router02Interface.parseTransaction({
          data: tx.input,
          value: hexToBigInt(tx.value),
        });
      }

      if (!decoded) {
        this.logger.debug('V3 decode failed: parseTransaction returned null', { txHash: tx.hash });
        return null;
      }

      return this.extractSwapIntent(tx, decoded, isOriginalRouter);
    } catch (error) {
      this.logger.debug('V3 decode error', {
        txHash: tx.hash,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Decode V3 encoded path to array of token addresses.
   *
   * V3 path format: tokenIn (20 bytes) + fee (3 bytes) + tokenOut (20 bytes) + ...
   *
   * FIX 4.4: Improved path validation to handle edge cases properly.
   * The path must follow a strict structure:
   * - Single hop: tokenIn(20) + fee(3) + tokenOut(20) = 43 bytes = 86 hex chars
   * - Multi-hop: Add 23 bytes (token + fee) per additional hop
   *
   * @param encodedPath - Hex-encoded path bytes
   * @returns Array of token addresses, or empty array if invalid
   */
  decodeV3Path(encodedPath: string): string[] {
    const path: string[] = [];

    const pathData = encodedPath.startsWith('0x') ? encodedPath.slice(2) : encodedPath;

    // Constants for path parsing
    const TOKEN_BYTES = 20;
    const FEE_BYTES = 3;
    const TOKEN_HEX_CHARS = TOKEN_BYTES * 2; // 40
    const FEE_HEX_CHARS = FEE_BYTES * 2; // 6

    // Minimum valid path: tokenIn + fee + tokenOut = 43 bytes = 86 hex chars
    const MIN_PATH_LENGTH = TOKEN_HEX_CHARS + FEE_HEX_CHARS + TOKEN_HEX_CHARS;

    // FIX 4.4: Validate minimum path length
    if (pathData.length < MIN_PATH_LENGTH) {
      // Path is too short to be valid
      this.logger.debug('V3 path too short', {
        length: pathData.length,
        minRequired: MIN_PATH_LENGTH,
      });
      return [];
    }

    // FIX 4.4: Validate path structure
    // Valid path length: 43 + 23*n where n >= 0
    // In hex chars: 86 + 46*n
    const pathLengthAfterFirst = pathData.length - TOKEN_HEX_CHARS;
    const hopSize = TOKEN_HEX_CHARS + FEE_HEX_CHARS; // 46 hex chars per hop

    // Each hop should be exactly: fee(6) + token(40) = 46 chars
    // After removing first token, remaining should be multiple of hop_size
    if (pathLengthAfterFirst % hopSize !== 0) {
      // Path structure is invalid - not aligned properly
      // This could indicate malformed or corrupted path data
      this.logger.debug('V3 path structure invalid', {
        pathLength: pathData.length,
        remainder: pathLengthAfterFirst % hopSize,
      });
      // Still try to extract what we can for debugging
    }

    // First token (20 bytes = 40 hex chars)
    const firstToken = pathData.slice(0, TOKEN_HEX_CHARS);
    if (!this.isValidHexToken(firstToken)) {
      this.logger.debug('V3 path: invalid first token', { firstToken });
      return [];
    }
    path.push('0x' + firstToken.toLowerCase());

    // Extract subsequent tokens
    // Each hop: skip fee (6 chars), extract token (40 chars)
    let offset = TOKEN_HEX_CHARS + FEE_HEX_CHARS; // Start after first token + fee

    while (offset + TOKEN_HEX_CHARS <= pathData.length) {
      const token = pathData.slice(offset, offset + TOKEN_HEX_CHARS);

      // FIX 4.4: Validate each extracted token
      if (!this.isValidHexToken(token)) {
        this.logger.debug('V3 path: invalid token at offset', { offset, token });
        break;
      }

      path.push('0x' + token.toLowerCase());
      offset += hopSize; // Move to next hop (token + fee)
    }

    // FIX 4.4: Validate we got at least 2 tokens (minimum for a swap)
    if (path.length < 2) {
      this.logger.debug('V3 path: insufficient tokens', { tokenCount: path.length });
      return [];
    }

    return path;
  }

  /**
   * Validate that a hex string looks like a valid token address.
   * FIX 4.4: Added validation helper.
   */
  private isValidHexToken(hexString: string): boolean {
    // Must be exactly 40 hex chars (20 bytes)
    if (hexString.length !== 40) {
      return false;
    }

    // Must be valid hex
    if (!/^[0-9a-fA-F]+$/.test(hexString)) {
      return false;
    }

    // Zero address is technically valid but unusual for a swap
    // We allow it but could flag it for debugging
    return true;
  }

  /**
   * Extract swap intent from decoded transaction.
   */
  private extractSwapIntent(
    tx: RawPendingTransaction,
    decoded: ReturnType<Interface['parseTransaction']>,
    isOriginalRouter: boolean
  ): PendingSwapIntent | null {
    if (!decoded) return null;

    const methodName = decoded.name;
    const args = decoded.args;

    try {
      let tokenIn: string;
      let tokenOut: string;
      let amountIn: bigint;
      let expectedAmountOut: bigint;
      let path: string[];
      let deadline: number;

      if (methodName === 'exactInputSingle' || methodName === 'exactOutputSingle') {
        // Single-hop swap with struct parameter
        const params = args[0];

        tokenIn = params.tokenIn;
        tokenOut = params.tokenOut;
        path = [tokenIn, tokenOut];

        if (methodName === 'exactInputSingle') {
          amountIn = BigInt(params.amountIn.toString());
          expectedAmountOut = BigInt(params.amountOutMinimum.toString());
        } else {
          expectedAmountOut = BigInt(params.amountOut.toString());
          amountIn = BigInt(params.amountInMaximum.toString());
        }

        // Deadline handling: original router has it in struct, Router02 doesn't
        if (isOriginalRouter && params.deadline !== undefined) {
          deadline = Number(params.deadline);
        } else {
          // Use a default deadline for Router02 (1 hour from now)
          deadline = Math.floor(Date.now() / 1000) + 3600;
        }

      } else if (methodName === 'exactInput' || methodName === 'exactOutput') {
        // Multi-hop swap with encoded path
        const params = args[0];
        const encodedPath = params.path;

        path = this.decodeV3Path(encodedPath);

        if (path.length < 2) {
          this.logger.debug('V3 decode: path too short', { txHash: tx.hash, pathLength: path.length });
          return null;
        }

        tokenIn = path[0];
        tokenOut = path[path.length - 1];

        if (methodName === 'exactInput') {
          amountIn = BigInt(params.amountIn.toString());
          expectedAmountOut = BigInt(params.amountOutMinimum.toString());
        } else {
          expectedAmountOut = BigInt(params.amountOut.toString());
          amountIn = BigInt(params.amountInMaximum.toString());
        }

        if (isOriginalRouter && params.deadline !== undefined) {
          deadline = Number(params.deadline);
        } else {
          deadline = Math.floor(Date.now() / 1000) + 3600;
        }
      } else {
        this.logger.debug('V3 unknown method', { txHash: tx.hash, methodName });
        return null;
      }

      const slippageTolerance = this.calculateSlippage(
        amountIn,
        expectedAmountOut,
        methodName.includes('Input')
      );

      const baseIntent = this.createBaseIntent(tx);

      return {
        ...baseIntent,
        tokenIn,
        tokenOut,
        amountIn,
        expectedAmountOut,
        path,
        slippageTolerance,
        deadline,
      } as PendingSwapIntent;

    } catch (error) {
      this.logger.debug('V3 extractSwapIntent error', {
        txHash: tx.hash,
        methodName,
        error: (error as Error).message,
      });
      return null;
    }
  }

  // Note: calculateSlippage is inherited from BaseDecoder
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Create a new UniswapV3Decoder instance.
 */
export function createUniswapV3Decoder(logger: Logger): UniswapV3Decoder {
  return new UniswapV3Decoder(logger);
}
