/**
 * 1inch Aggregator Swap Decoder
 *
 * Decodes 1inch AggregatorV5 swap transactions.
 *
 * Supported methods:
 * - swap (multi-hop aggregated swap)
 * - unoswap (single-hop via specific DEX)
 * - unoswapTo (single-hop with recipient)
 * - uniswapV3Swap (direct V3 swap)
 * - clipperSwap (Clipper DEX swap)
 *
 * @see Task 1.3.2: Pending Transaction Decoder (Implementation Plan v3.0)
 */

import { Interface, AbiCoder } from 'ethers';
import type { Logger } from '@arbitrage/core';
import { BaseDecoder, hexToBigInt, isValidInput } from './base-decoder';
import type { RawPendingTransaction, PendingSwapIntent, SwapRouterType, SelectorInfo } from './base-decoder';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * 1inch AggregatorV5 function selectors.
 */
export const ONEINCH_SELECTORS: Record<string, SelectorInfo> = {
  // AggregatorV5 main functions
  '0x12aa3caf': { method: 'swap', routerTypes: ['1inch'] },
  '0x0502b1c5': { method: 'unoswap', routerTypes: ['1inch'] },
  '0xf78dc253': { method: 'unoswapTo', routerTypes: ['1inch'] },
  '0xe449022e': { method: 'uniswapV3Swap', routerTypes: ['1inch'] },
  '0xbc80f1a8': { method: 'uniswapV3SwapTo', routerTypes: ['1inch'] },
  '0xb0431182': { method: 'clipperSwap', routerTypes: ['1inch'] },
  '0x84bd6d29': { method: 'clipperSwapTo', routerTypes: ['1inch'] },
  // Partial fill variants
  '0x62e238bb': { method: 'fillOrder', routerTypes: ['1inch'] },
  '0x3eca9c0a': { method: 'fillOrderTo', routerTypes: ['1inch'] },
};

/**
 * 1inch AggregatorV5 ABI fragment for swap decoding.
 * Note: 1inch uses complex packed data structures.
 */
const ONEINCH_ABI = [
  // Main swap function with SwapDescription struct
  'function swap(address executor, (address srcToken, address dstToken, address srcReceiver, address dstReceiver, uint256 amount, uint256 minReturnAmount, uint256 flags) desc, bytes permit, bytes data) returns (uint256 returnAmount, uint256 spentAmount)',
  // Unoswap - single-hop swap via specific DEX pool
  'function unoswap(address srcToken, uint256 amount, uint256 minReturn, uint256[] pools) returns (uint256 returnAmount)',
  'function unoswapTo(address recipient, address srcToken, uint256 amount, uint256 minReturn, uint256[] pools) returns (uint256 returnAmount)',
  // Direct V3 swap
  'function uniswapV3Swap(uint256 amount, uint256 minReturn, uint256[] pools) returns (uint256 returnAmount)',
  'function uniswapV3SwapTo(address recipient, uint256 amount, uint256 minReturn, uint256[] pools) returns (uint256 returnAmount)',
  // Clipper DEX
  'function clipperSwap(address clipperExchange, address srcToken, address dstToken, uint256 inputAmount, uint256 outputAmount, uint256 goodUntil, bytes32 r, bytes32 vs) returns (uint256 returnAmount)',
  'function clipperSwapTo(address clipperExchange, address recipient, address srcToken, address dstToken, uint256 inputAmount, uint256 outputAmount, uint256 goodUntil, bytes32 r, bytes32 vs) returns (uint256 returnAmount)',
];

// Pre-create Interface instance for performance
const oneInchInterface = new Interface(ONEINCH_ABI);

// Native ETH placeholder used by 1inch
const ETH_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

// WETH addresses by chain for ETH resolution
const WETH_BY_CHAIN: Record<number, string> = {
  1: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // Ethereum
  56: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // BSC (WBNB)
  137: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', // Polygon (WMATIC)
  42161: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // Arbitrum
  10: '0x4200000000000000000000000000000000000006', // Optimism
  8453: '0x4200000000000000000000000000000000000006', // Base
};

// =============================================================================
// DECODER IMPLEMENTATION
// =============================================================================

/**
 * 1inch Aggregator Swap Decoder
 *
 * Decodes swap transactions for 1inch AggregatorV5 router.
 */
export class OneInchDecoder extends BaseDecoder {
  readonly type: SwapRouterType = '1inch';
  readonly name = '1inch AggregatorV5';
  readonly supportedChains = [1, 56, 137, 42161, 10, 8453, 43114];

  constructor(logger: Logger) {
    super(logger);
  }

  /**
   * Check if this decoder can handle the given transaction.
   */
  canDecode(tx: RawPendingTransaction): boolean {
    const selector = this.getSelector(tx.input);
    if (!selector) return false;
    return selector in ONEINCH_SELECTORS;
  }

  /**
   * Decode 1inch swap transaction.
   */
  decode(tx: RawPendingTransaction): PendingSwapIntent | null {
    if (!isValidInput(tx.input, 10)) {
      return null;
    }

    const selector = this.getSelector(tx.input)!;

    try {
      const decoded = oneInchInterface.parseTransaction({
        data: tx.input,
        value: hexToBigInt(tx.value),
      });

      if (!decoded) {
        // Try manual decoding for complex functions
        return this.manualDecode(tx, selector);
      }

      return this.extractSwapIntent(tx, decoded);
    } catch (error) {
      // Fallback to manual decoding
      return this.manualDecode(tx, selector);
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
    const chainId = tx.chainId ?? 1;

    try {
      let tokenIn: string;
      let tokenOut: string;
      let amountIn: bigint;
      let expectedAmountOut: bigint;

      if (methodName === 'swap') {
        // swap(executor, desc, permit, data)
        const desc = args[1];
        tokenIn = this.resolveToken(desc.srcToken, chainId);
        tokenOut = this.resolveToken(desc.dstToken, chainId);
        amountIn = BigInt(desc.amount.toString());
        expectedAmountOut = BigInt(desc.minReturnAmount.toString());

      } else if (methodName === 'unoswap' || methodName === 'unoswapTo') {
        // unoswap(srcToken, amount, minReturn, pools)
        // unoswapTo(recipient, srcToken, amount, minReturn, pools)
        const offset = methodName === 'unoswapTo' ? 1 : 0;
        tokenIn = this.resolveToken(args[offset], chainId);
        amountIn = BigInt(args[offset + 1].toString());
        expectedAmountOut = BigInt(args[offset + 2].toString());
        // Output token is encoded in pools - extract from first pool
        tokenOut = this.extractOutputTokenFromPools(args[offset + 3], chainId);

      } else if (methodName === 'uniswapV3Swap' || methodName === 'uniswapV3SwapTo') {
        // uniswapV3Swap(amount, minReturn, pools)
        // uniswapV3SwapTo(recipient, amount, minReturn, pools)
        const offset = methodName === 'uniswapV3SwapTo' ? 1 : 0;
        amountIn = BigInt(args[offset].toString());
        expectedAmountOut = BigInt(args[offset + 1].toString());
        // Tokens are encoded in pools
        const poolsData = args[offset + 2];
        const { tokenIn: extractedIn, tokenOut: extractedOut } = this.extractTokensFromV3Pools(poolsData, chainId);
        tokenIn = extractedIn;
        tokenOut = extractedOut;

      } else if (methodName === 'clipperSwap' || methodName === 'clipperSwapTo') {
        // clipperSwap(clipperExchange, srcToken, dstToken, inputAmount, outputAmount, ...)
        // clipperSwapTo(clipperExchange, recipient, srcToken, dstToken, ...)
        const offset = methodName === 'clipperSwapTo' ? 2 : 1;
        tokenIn = this.resolveToken(args[offset], chainId);
        tokenOut = this.resolveToken(args[offset + 1], chainId);
        amountIn = BigInt(args[offset + 2].toString());
        expectedAmountOut = BigInt(args[offset + 3].toString());

      } else {
        this.logger.debug('1inch unknown method', { txHash: tx.hash, methodName });
        return null;
      }

      const baseIntent = this.createBaseIntent(tx);
      const slippageTolerance = this.calculateSlippage(amountIn, expectedAmountOut);

      return {
        ...baseIntent,
        tokenIn,
        tokenOut,
        amountIn,
        expectedAmountOut,
        path: [tokenIn, tokenOut],
        slippageTolerance,
        deadline: Math.floor(Date.now() / 1000) + 3600, // 1inch doesn't expose deadline in most calls
      } as PendingSwapIntent;

    } catch (error) {
      this.logger.debug('1inch extractSwapIntent error', {
        txHash: tx.hash,
        methodName,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Manual decoding for when ABI parsing fails.
   */
  private manualDecode(tx: RawPendingTransaction, selector: string): PendingSwapIntent | null {
    const abiCoder = new AbiCoder();
    const inputData = tx.input.slice(10);
    const chainId = tx.chainId ?? 1;

    try {
      // swap(address executor, SwapDescription desc, bytes permit, bytes data)
      if (selector === '0x12aa3caf') {
        // SwapDescription: (srcToken, dstToken, srcReceiver, dstReceiver, amount, minReturnAmount, flags)
        const decoded = abiCoder.decode(
          ['address', 'tuple(address,address,address,address,uint256,uint256,uint256)', 'bytes', 'bytes'],
          '0x' + inputData
        );

        const desc = decoded[1];
        const tokenIn = this.resolveToken(desc[0], chainId);
        const tokenOut = this.resolveToken(desc[1], chainId);
        const amountIn = BigInt(desc[4].toString());
        const expectedAmountOut = BigInt(desc[5].toString());

        const baseIntent = this.createBaseIntent(tx);

        return {
          ...baseIntent,
          tokenIn,
          tokenOut,
          amountIn,
          expectedAmountOut,
          path: [tokenIn, tokenOut],
          slippageTolerance: this.calculateSlippage(amountIn, expectedAmountOut),
          deadline: Math.floor(Date.now() / 1000) + 3600,
        } as PendingSwapIntent;
      }

      return null;
    } catch (error) {
      this.logger.debug('1inch manual decode error', {
        txHash: tx.hash,
        selector,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Resolve ETH placeholder to WETH address.
   */
  private resolveToken(token: string, chainId: number): string {
    if (token.toLowerCase() === ETH_ADDRESS.toLowerCase()) {
      return WETH_BY_CHAIN[chainId] || token;
    }
    return token;
  }

  /**
   * Extract output token from 1inch unoswap pools array.
   *
   * FIX 4.2: Improved pool decoding based on 1inch contract analysis.
   *
   * 1inch unoswap pool encoding (uint256):
   * - Bits 0-159: Pool address (address of the DEX pool)
   * - Bits 160-175: Pool type/flags (determines DEX type)
   * - Bits 176-255: Additional data including direction
   *
   * The output token is the token received after all hops through the pools.
   * Since pools are chained, we can't directly extract the output token without
   * querying the pool contracts. We extract the last pool address as a hint.
   *
   * @param pools - Array of encoded pool data
   * @param chainId - Chain ID for native token resolution
   * @returns Output token address (may be pool address as hint if unknown)
   */
  private extractOutputTokenFromPools(pools: bigint[], chainId: number): string {
    if (!pools || pools.length === 0) {
      this.logger.debug('1inch: empty pools array for token extraction');
      return WETH_BY_CHAIN[chainId] || '0x' + '0'.repeat(40);
    }

    // Extract the last pool address (lower 160 bits)
    const lastPool = pools[pools.length - 1];
    const poolValue = BigInt(lastPool.toString());

    // Extract address (lower 160 bits = 20 bytes = 40 hex chars)
    const ADDRESS_MASK = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');
    const poolAddress = '0x' + (poolValue & ADDRESS_MASK).toString(16).padStart(40, '0');

    // Check direction flag (bit 255 typically indicates direction)
    const DIRECTION_BIT = BigInt(1) << BigInt(255);
    const isReverse = (poolValue & DIRECTION_BIT) !== BigInt(0);

    // If we can determine the pool is a known DEX, we can infer the output token
    // For now, return the pool address as a hint - downstream can resolve via on-chain query
    // The pool address itself is useful for tracking which pools the swap uses
    this.logger.debug('1inch: extracted pool info', {
      poolAddress,
      isReverse,
      poolCount: pools.length,
    });

    // Return pool address - caller should resolve to actual output token if needed
    // Using pool address as placeholder is better than zero address for debugging
    return this.resolveToken(poolAddress, chainId);
  }

  /**
   * Extract tokens from V3 pools encoding.
   *
   * FIX 4.2: Improved V3 pool decoding to extract token information.
   *
   * 1inch uniswapV3Swap pool encoding (uint256):
   * - Bits 0-159: Pool address
   * - Bit 255: Direction flag (0 = token0->token1, 1 = token1->token0)
   *
   * For multi-hop: tokenIn is derived from first pool, tokenOut from last pool.
   *
   * @param pools - Array of V3 pool data
   * @param chainId - Chain ID for native token resolution
   * @returns Token pair (may include pool addresses as hints)
   */
  private extractTokensFromV3Pools(pools: bigint[], chainId: number): { tokenIn: string; tokenOut: string } {
    if (!pools || pools.length === 0) {
      this.logger.debug('1inch: empty V3 pools array');
      return {
        tokenIn: WETH_BY_CHAIN[chainId] || '0x' + '0'.repeat(40),
        tokenOut: WETH_BY_CHAIN[chainId] || '0x' + '0'.repeat(40),
      };
    }

    const ADDRESS_MASK = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');
    const DIRECTION_BIT = BigInt(1) << BigInt(255);

    // Extract first pool info for tokenIn hint
    const firstPoolValue = BigInt(pools[0].toString());
    const firstPoolAddress = '0x' + (firstPoolValue & ADDRESS_MASK).toString(16).padStart(40, '0');
    const firstPoolReverse = (firstPoolValue & DIRECTION_BIT) !== BigInt(0);

    // Extract last pool info for tokenOut hint
    const lastPoolValue = BigInt(pools[pools.length - 1].toString());
    const lastPoolAddress = '0x' + (lastPoolValue & ADDRESS_MASK).toString(16).padStart(40, '0');
    const lastPoolReverse = (lastPoolValue & DIRECTION_BIT) !== BigInt(0);

    this.logger.debug('1inch V3: extracted pool info', {
      firstPoolAddress,
      firstPoolReverse,
      lastPoolAddress,
      lastPoolReverse,
      poolCount: pools.length,
    });

    // For V3 swaps, we return pool addresses as hints
    // The actual tokens require on-chain pool queries or a pool registry
    // Using pool addresses allows downstream systems to resolve tokens
    return {
      tokenIn: firstPoolAddress,
      tokenOut: lastPoolAddress,
    };
  }

  // Note: calculateSlippage is inherited from BaseDecoder
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Create a new OneInchDecoder instance.
 */
export function createOneInchDecoder(logger: Logger): OneInchDecoder {
  return new OneInchDecoder(logger);
}
