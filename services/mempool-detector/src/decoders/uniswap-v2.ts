/**
 * Uniswap V2 Swap Decoder
 *
 * Decodes Uniswap V2 style swap transactions (also works for SushiSwap, PancakeSwap).
 *
 * Supported methods:
 * - swapExactTokensForTokens
 * - swapTokensForExactTokens
 * - swapExactETHForTokens
 * - swapETHForExactTokens
 * - swapExactTokensForETH
 * - swapTokensForExactETH
 * - Fee-on-transfer token variants
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
 * Uniswap V2 function selectors.
 */
export const UNISWAP_V2_SELECTORS: Record<string, SelectorInfo> = {
  '0x38ed1739': { method: 'swapExactTokensForTokens', routerTypes: ['uniswapV2', 'sushiswap', 'pancakeswap'] },
  '0x8803dbee': { method: 'swapTokensForExactTokens', routerTypes: ['uniswapV2', 'sushiswap', 'pancakeswap'] },
  '0x7ff36ab5': { method: 'swapExactETHForTokens', routerTypes: ['uniswapV2', 'sushiswap', 'pancakeswap'] },
  '0xfb3bdb41': { method: 'swapETHForExactTokens', routerTypes: ['uniswapV2', 'sushiswap', 'pancakeswap'] },
  '0x18cbafe5': { method: 'swapExactTokensForETH', routerTypes: ['uniswapV2', 'sushiswap', 'pancakeswap'] },
  '0x4a25d94a': { method: 'swapTokensForExactETH', routerTypes: ['uniswapV2', 'sushiswap', 'pancakeswap'] },
  '0x5c11d795': { method: 'swapExactTokensForTokensSupportingFeeOnTransferTokens', routerTypes: ['uniswapV2', 'sushiswap', 'pancakeswap'] },
  '0xb6f9de95': { method: 'swapExactETHForTokensSupportingFeeOnTransferTokens', routerTypes: ['uniswapV2', 'sushiswap', 'pancakeswap'] },
  '0x791ac947': { method: 'swapExactTokensForETHSupportingFeeOnTransferTokens', routerTypes: ['uniswapV2', 'sushiswap', 'pancakeswap'] },
};

/**
 * Uniswap V2 Router ABI fragment for swap decoding.
 */
const UNISWAP_V2_ABI = [
  'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)',
  'function swapTokensForExactTokens(uint amountOut, uint amountInMax, address[] path, address to, uint deadline) returns (uint[] amounts)',
  'function swapExactETHForTokens(uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)',
  'function swapETHForExactTokens(uint amountOut, address[] path, address to, uint deadline) returns (uint[] amounts)',
  'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)',
  'function swapTokensForExactETH(uint amountOut, uint amountInMax, address[] path, address to, uint deadline) returns (uint[] amounts)',
  'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline)',
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin, address[] path, address to, uint deadline)',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline)',
];

// Pre-create Interface instance for performance
const uniswapV2Interface = new Interface(UNISWAP_V2_ABI);

// =============================================================================
// DECODER IMPLEMENTATION
// =============================================================================

/**
 * Uniswap V2 Style Swap Decoder
 *
 * Decodes swap transactions for Uniswap V2, SushiSwap, PancakeSwap, and other
 * V2-compatible routers.
 */
export class UniswapV2Decoder extends BaseDecoder {
  readonly type: SwapRouterType = 'uniswapV2';
  readonly name = 'Uniswap V2';
  readonly supportedChains = [1, 56, 137, 42161, 43114];

  constructor(logger: Logger) {
    super(logger);
  }

  /**
   * Check if this decoder can handle the given transaction.
   */
  canDecode(tx: RawPendingTransaction): boolean {
    const selector = this.getSelector(tx.input);
    if (!selector) return false;
    return selector in UNISWAP_V2_SELECTORS;
  }

  /**
   * Decode Uniswap V2 style swap transaction.
   */
  decode(tx: RawPendingTransaction): PendingSwapIntent | null {
    if (!isValidInput(tx.input, 10)) {
      return null;
    }

    try {
      const decoded = uniswapV2Interface.parseTransaction({
        data: tx.input,
        value: hexToBigInt(tx.value),
      });

      if (!decoded) {
        this.logger.debug('V2 decode failed: parseTransaction returned null', { txHash: tx.hash });
        return null;
      }

      return this.extractSwapIntent(tx, decoded);
    } catch (error) {
      this.logger.debug('V2 decode error', {
        txHash: tx.hash,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Extract swap intent from decoded transaction.
   */
  private extractSwapIntent(
    tx: RawPendingTransaction,
    decoded: ReturnType<Interface['parseTransaction']>
  ): PendingSwapIntent | null {
    if (!decoded) return null;

    const methodName = decoded.name;
    const args = decoded.args;

    let amountIn: bigint;
    let expectedAmountOut: bigint;
    let path: string[];
    let deadline: number;

    try {
      // Determine parameter positions based on method name
      const isExactInput = this.isExactInputMethod(methodName);
      const isETHInput = methodName.includes('ETHFor');
      const isETHOutput = methodName.includes('ForETH');

      if (isExactInput) {
        if (isETHInput) {
          // swapExactETHForTokens(amountOutMin, path, to, deadline)
          // ETH amount comes from transaction value
          amountIn = hexToBigInt(tx.value);
          expectedAmountOut = BigInt(args[0].toString());
          path = [...args[1]] as string[];
          deadline = Number(args[3]);
        } else if (isETHOutput) {
          // swapExactTokensForETH(amountIn, amountOutMin, path, to, deadline)
          amountIn = BigInt(args[0].toString());
          expectedAmountOut = BigInt(args[1].toString());
          path = [...args[2]] as string[];
          deadline = Number(args[4]);
        } else {
          // swapExactTokensForTokens(amountIn, amountOutMin, path, to, deadline)
          amountIn = BigInt(args[0].toString());
          expectedAmountOut = BigInt(args[1].toString());
          path = [...args[2]] as string[];
          deadline = Number(args[4]);
        }
      } else {
        // Exact output methods
        if (isETHInput) {
          // swapETHForExactTokens(amountOut, path, to, deadline)
          expectedAmountOut = BigInt(args[0].toString());
          amountIn = hexToBigInt(tx.value); // Max input is the ETH sent
          path = [...args[1]] as string[];
          deadline = Number(args[3]);
        } else if (isETHOutput) {
          // swapTokensForExactETH(amountOut, amountInMax, path, to, deadline)
          expectedAmountOut = BigInt(args[0].toString());
          amountIn = BigInt(args[1].toString()); // Max input
          path = [...args[2]] as string[];
          deadline = Number(args[4]);
        } else {
          // swapTokensForExactTokens(amountOut, amountInMax, path, to, deadline)
          expectedAmountOut = BigInt(args[0].toString());
          amountIn = BigInt(args[1].toString()); // Max input
          path = [...args[2]] as string[];
          deadline = Number(args[4]);
        }
      }

      if (path.length < 2) {
        this.logger.debug('V2 decode: path too short', { txHash: tx.hash, pathLength: path.length });
        return null;
      }

      // Calculate slippage tolerance (approximate)
      const slippageTolerance = this.calculateSlippage(amountIn, expectedAmountOut, isExactInput);

      const baseIntent = this.createBaseIntent(tx);

      return {
        ...baseIntent,
        tokenIn: path[0],
        tokenOut: path[path.length - 1],
        amountIn,
        expectedAmountOut,
        path,
        slippageTolerance,
        deadline,
      } as PendingSwapIntent;

    } catch (error) {
      this.logger.debug('V2 extractSwapIntent error', {
        txHash: tx.hash,
        methodName,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Check if method is an exact input swap.
   */
  private isExactInputMethod(methodName: string): boolean {
    return methodName.includes('ExactTokensFor') || methodName.includes('ExactETHFor');
  }

  // Note: calculateSlippage is inherited from BaseDecoder
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Create a new UniswapV2Decoder instance.
 */
export function createUniswapV2Decoder(logger: Logger): UniswapV2Decoder {
  return new UniswapV2Decoder(logger);
}
