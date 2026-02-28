/**
 * V3 Swap Adapter
 *
 * Encodes swap calldata for Uniswap V3-style DEX routers using the
 * ISwapRouter.exactInputSingle interface. V3 routers use a fundamentally
 * different interface than V2 routers (swapExactTokensForTokens), requiring
 * separate encoding logic.
 *
 * Supported V3 DEXes:
 * - Uniswap V3 (Ethereum, Arbitrum, Base, Polygon)
 * - PancakeSwap V3 (BSC)
 * - Algebra (various chains)
 * - Trader Joe V2 (Avalanche)
 *
 * @see https://docs.uniswap.org/contracts/v3/reference/periphery/interfaces/ISwapRouter
 */

import { ethers } from 'ethers';

// =============================================================================
// Types
// =============================================================================

/**
 * Parameters for encoding a V3 exactInputSingle swap.
 *
 * Matches the Uniswap V3 ISwapRouter.ExactInputSingleParams struct:
 * ```solidity
 * struct ExactInputSingleParams {
 *     address tokenIn;
 *     address tokenOut;
 *     uint24 fee;
 *     address recipient;
 *     uint256 deadline;
 *     uint256 amountIn;
 *     uint256 amountOutMinimum;
 *     uint160 sqrtPriceLimitX96;
 * }
 * ```
 */
export interface V3SwapParams {
  /** Input token address */
  tokenIn: string;
  /** Output token address */
  tokenOut: string;
  /** V3 fee tier in hundredths of a bip (100, 500, 3000, 10000) */
  fee: number;
  /** Recipient of output tokens */
  recipient: string;
  /** Transaction deadline (block.timestamp must be <= deadline) */
  deadline: bigint;
  /** Amount of tokenIn to swap */
  amountIn: bigint;
  /** Minimum amount of tokenOut to receive (slippage protection) */
  amountOutMinimum: bigint;
  /** Price limit for the swap (0 = no limit) */
  sqrtPriceLimitX96: bigint;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * ABI fragment for Uniswap V3 ISwapRouter.exactInputSingle
 *
 * This is the standard interface used by Uniswap V3 and compatible routers
 * (PancakeSwap V3, Algebra, Trader Joe V2).
 */
export const V3_SWAP_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
] as const;

/**
 * Set of DEX names that use V3-style routing (exactInputSingle).
 * Used for O(1) lookup in isV3Dex().
 *
 * These DEXes require the V3SwapAdapter for calldata encoding instead of
 * the standard V2 swapExactTokensForTokens encoding.
 */
const V3_DEX_NAMES: ReadonlySet<string> = new Set([
  'uniswap_v3',
  'pancakeswap_v3',
  'algebra',
  'trader_joe_v2',
]);

// =============================================================================
// V3 Swap Adapter
// =============================================================================

/**
 * Pre-built ethers Interface for V3 swap encoding.
 * Module-level singleton avoids re-parsing ABI on every call (hot-path optimization).
 */
const V3_SWAP_INTERFACE = new ethers.Interface(V3_SWAP_ROUTER_ABI);

/**
 * V3SwapAdapter - Encodes calldata for V3-style DEX routers.
 *
 * V3 routers use `exactInputSingle` instead of `swapExactTokensForTokens`,
 * requiring fee tier and sqrtPriceLimitX96 parameters.
 *
 * Usage:
 * ```typescript
 * const adapter = new V3SwapAdapter();
 * const calldata = adapter.encodeExactInputSingle({
 *   tokenIn: WETH,
 *   tokenOut: USDC,
 *   fee: 3000,        // 0.3% fee tier
 *   recipient: contract,
 *   deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
 *   amountIn: ethers.parseEther('1'),
 *   amountOutMinimum: ethers.parseUnits('1800', 6),
 *   sqrtPriceLimitX96: 0n,
 * });
 * ```
 */
export class V3SwapAdapter {
  /**
   * Encode calldata for ISwapRouter.exactInputSingle.
   *
   * @param params - V3 swap parameters
   * @returns ABI-encoded calldata string
   * @throws Error if params contain invalid addresses or values
   */
  encodeExactInputSingle(params: V3SwapParams): string {
    // Validate fee tier is a valid V3 fee
    if (![100, 500, 3000, 10000].includes(params.fee)) {
      throw new Error(
        `[V3SwapAdapter] Invalid fee tier: ${params.fee}. ` +
        `Valid tiers are: 100 (0.01%), 500 (0.05%), 3000 (0.3%), 10000 (1%)`
      );
    }

    // Encode as a struct tuple matching ExactInputSingleParams
    return V3_SWAP_INTERFACE.encodeFunctionData('exactInputSingle', [
      {
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        fee: params.fee,
        recipient: params.recipient,
        deadline: params.deadline,
        amountIn: params.amountIn,
        amountOutMinimum: params.amountOutMinimum,
        sqrtPriceLimitX96: params.sqrtPriceLimitX96,
      },
    ]);
  }
}

/**
 * Check if a DEX uses V3-style routing (exactInputSingle).
 *
 * V3 DEXes require different calldata encoding than V2 DEXes.
 * This function performs O(1) Set lookup with case-insensitive matching.
 *
 * @param dexName - DEX name to check (case-insensitive)
 * @returns true if the DEX uses V3 routing
 */
export function isV3Dex(dexName: string): boolean {
  return V3_DEX_NAMES.has(dexName.toLowerCase().trim());
}
