/**
 * Swap Transaction Decoder
 *
 * Decodes pending transactions to extract swap intents from DEX routers.
 * Supports multiple DEX types (Uniswap V2/V3, SushiSwap, PancakeSwap, etc.)
 *
 * Features:
 * - Function selector matching for O(1) router identification
 * - ABI decoding for swap parameters
 * - Multi-hop path extraction
 * - Slippage tolerance calculation
 *
 * @see Phase 1: Mempool Detection Service (Implementation Plan v3.0)
 */

import { Interface, AbiCoder } from 'ethers';
import type { Logger } from '@arbitrage/core';
import { KNOWN_ROUTERS } from '@arbitrage/config';
import type {
  RawPendingTransaction,
  PendingSwapIntent,
  SwapRouterType,
  SwapDecoder,
} from './types';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Known function selectors for swap functions.
 * Pre-computed 4-byte selectors for O(1) matching.
 */
export const SWAP_SELECTORS: Record<string, { method: string; routerTypes: SwapRouterType[] }> = {
  // Uniswap V2 / SushiSwap / PancakeSwap
  '0x38ed1739': { method: 'swapExactTokensForTokens', routerTypes: ['uniswapV2', 'sushiswap', 'pancakeswap'] },
  '0x8803dbee': { method: 'swapTokensForExactTokens', routerTypes: ['uniswapV2', 'sushiswap', 'pancakeswap'] },
  '0x7ff36ab5': { method: 'swapExactETHForTokens', routerTypes: ['uniswapV2', 'sushiswap', 'pancakeswap'] },
  '0xfb3bdb41': { method: 'swapETHForExactTokens', routerTypes: ['uniswapV2', 'sushiswap', 'pancakeswap'] },
  '0x18cbafe5': { method: 'swapExactTokensForETH', routerTypes: ['uniswapV2', 'sushiswap', 'pancakeswap'] },
  '0x4a25d94a': { method: 'swapTokensForExactETH', routerTypes: ['uniswapV2', 'sushiswap', 'pancakeswap'] },
  '0x5c11d795': { method: 'swapExactTokensForTokensSupportingFeeOnTransferTokens', routerTypes: ['uniswapV2', 'sushiswap', 'pancakeswap'] },
  '0xb6f9de95': { method: 'swapExactETHForTokensSupportingFeeOnTransferTokens', routerTypes: ['uniswapV2', 'sushiswap', 'pancakeswap'] },
  '0x791ac947': { method: 'swapExactTokensForETHSupportingFeeOnTransferTokens', routerTypes: ['uniswapV2', 'sushiswap', 'pancakeswap'] },

  // Uniswap V3
  '0x414bf389': { method: 'exactInputSingle', routerTypes: ['uniswapV3'] },
  '0xc04b8d59': { method: 'exactInput', routerTypes: ['uniswapV3'] },
  '0xdb3e2198': { method: 'exactOutputSingle', routerTypes: ['uniswapV3'] },
  '0xf28c0498': { method: 'exactOutput', routerTypes: ['uniswapV3'] },

  // Uniswap V3 SwapRouter02
  '0x04e45aaf': { method: 'exactInputSingle', routerTypes: ['uniswapV3'] },
  '0x5023b4df': { method: 'exactOutputSingle', routerTypes: ['uniswapV3'] },
  '0xb858183f': { method: 'exactInput', routerTypes: ['uniswapV3'] },
  '0x09b81346': { method: 'exactOutput', routerTypes: ['uniswapV3'] },
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

/**
 * Uniswap V3 Router ABI fragment for swap decoding.
 */
const UNISWAP_V3_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut)',
  'function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum)) returns (uint256 amountOut)',
  'function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96)) returns (uint256 amountIn)',
  'function exactOutput((bytes path, address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum)) returns (uint256 amountIn)',
];

/**
 * Uniswap V3 SwapRouter02 ABI fragment.
 */
const UNISWAP_V3_ROUTER02_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut)',
  'function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96)) returns (uint256 amountIn)',
  'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum)) returns (uint256 amountOut)',
  'function exactOutput((bytes path, address recipient, uint256 amountOut, uint256 amountInMaximum)) returns (uint256 amountIn)',
];

// Pre-create Interface instances for performance
const uniswapV2Interface = new Interface(UNISWAP_V2_ABI);
const uniswapV3Interface = new Interface(UNISWAP_V3_ABI);
const uniswapV3Router02Interface = new Interface(UNISWAP_V3_ROUTER02_ABI);

// =============================================================================
// CHAIN ID MAPPING
// =============================================================================

/**
 * Map chain names to chain IDs for consistent handling.
 */
export const CHAIN_NAME_TO_ID: Record<string, number> = {
  ethereum: 1,
  bsc: 56,
  polygon: 137,
  arbitrum: 42161,
  optimism: 10,
  base: 8453,
  avalanche: 43114,
  fantom: 250,
};

/**
 * Map chain IDs to chain names.
 */
export const CHAIN_ID_TO_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(CHAIN_NAME_TO_ID).map(([name, id]) => [id, name])
);

// =============================================================================
// DECODER IMPLEMENTATION
// =============================================================================

/**
 * Swap Decoder Registry
 *
 * Manages multiple swap decoders and routes transactions to appropriate decoders.
 */
export class SwapDecoderRegistry {
  private decoders: Map<SwapRouterType, SwapDecoder> = new Map();
  private routerAddressToType: Map<string, SwapRouterType> = new Map();
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
    this.initializeDecoders();
    this.initializeRouterRegistry();
  }

  /**
   * Initialize all swap decoders.
   */
  private initializeDecoders(): void {
    // Uniswap V2 decoder (also handles SushiSwap, PancakeSwap)
    const uniswapV2Decoder: SwapDecoder = {
      type: 'uniswapV2',
      name: 'Uniswap V2',
      supportedChains: [1, 56, 137, 42161, 43114],
      canDecode: (tx) => this.canDecodeV2(tx),
      decode: (tx) => this.decodeV2Swap(tx),
    };

    // Uniswap V3 decoder (also handles PancakeSwap V3)
    const uniswapV3Decoder: SwapDecoder = {
      type: 'uniswapV3',
      name: 'Uniswap V3',
      supportedChains: [1, 56, 137, 42161, 10, 8453],
      canDecode: (tx) => this.canDecodeV3(tx),
      decode: (tx) => this.decodeV3Swap(tx),
    };

    this.decoders.set('uniswapV2', uniswapV2Decoder);
    this.decoders.set('sushiswap', uniswapV2Decoder); // Same interface
    this.decoders.set('pancakeswap', uniswapV2Decoder); // Same interface
    this.decoders.set('uniswapV3', uniswapV3Decoder);
  }

  /**
   * Initialize router address lookup map from config.
   */
  private initializeRouterRegistry(): void {
    for (const [chainId, routers] of Object.entries(KNOWN_ROUTERS)) {
      for (const [address, info] of Object.entries(routers)) {
        this.routerAddressToType.set(address.toLowerCase(), info.type as SwapRouterType);
      }
    }
  }

  /**
   * Decode a pending transaction to extract swap intent.
   *
   * @param tx - Raw pending transaction
   * @param chainId - Chain ID or name
   * @returns Decoded swap intent or null if not decodable
   */
  decode(tx: RawPendingTransaction, chainId: string | number): PendingSwapIntent | null {
    if (!tx.input || tx.input.length < 10) {
      return null;
    }

    const selector = tx.input.slice(0, 10).toLowerCase();
    const selectorInfo = SWAP_SELECTORS[selector];

    if (!selectorInfo) {
      return null; // Not a known swap function
    }

    // Determine router type from address
    const toAddress = tx.to?.toLowerCase();
    let routerType = toAddress ? this.routerAddressToType.get(toAddress) : undefined;

    // Fallback to selector-based type detection
    if (!routerType && selectorInfo.routerTypes.length > 0) {
      routerType = selectorInfo.routerTypes[0];
    }

    if (!routerType) {
      return null;
    }

    const decoder = this.decoders.get(routerType);
    if (!decoder) {
      return null;
    }

    try {
      return decoder.decode(tx);
    } catch (error) {
      this.logger.debug('Failed to decode swap', {
        txHash: tx.hash,
        selector,
        routerType,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Check if transaction can be decoded as V2 swap.
   */
  private canDecodeV2(tx: RawPendingTransaction): boolean {
    if (!tx.input || tx.input.length < 10) return false;
    const selector = tx.input.slice(0, 10).toLowerCase();
    const info = SWAP_SELECTORS[selector];
    return info?.routerTypes.some(t => ['uniswapV2', 'sushiswap', 'pancakeswap'].includes(t)) ?? false;
  }

  /**
   * Check if transaction can be decoded as V3 swap.
   */
  private canDecodeV3(tx: RawPendingTransaction): boolean {
    if (!tx.input || tx.input.length < 10) return false;
    const selector = tx.input.slice(0, 10).toLowerCase();
    const info = SWAP_SELECTORS[selector];
    return info?.routerTypes.includes('uniswapV3') ?? false;
  }

  /**
   * Decode Uniswap V2 style swap.
   */
  private decodeV2Swap(tx: RawPendingTransaction): PendingSwapIntent | null {
    try {
      const decoded = uniswapV2Interface.parseTransaction({ data: tx.input, value: BigInt(tx.value || '0') });
      if (!decoded) return null;

      const methodName = decoded.name;
      const args = decoded.args;

      // Extract common parameters
      let amountIn: bigint;
      let expectedAmountOut: bigint;
      let path: string[];
      let deadline: number;

      // Determine parameter positions based on method name
      const isExactInput = methodName.includes('ExactTokens') || methodName.includes('ExactETH');
      const isETHInput = methodName.includes('ETHFor');

      if (isExactInput) {
        if (isETHInput) {
          // swapExactETHForTokens(amountOutMin, path, to, deadline)
          amountIn = BigInt(tx.value || '0');
          expectedAmountOut = BigInt(args[0].toString());
          path = args[1] as string[];
          deadline = Number(args[3]);
        } else {
          // swapExactTokensForTokens/ETH(amountIn, amountOutMin, path, to, deadline)
          amountIn = BigInt(args[0].toString());
          expectedAmountOut = BigInt(args[1].toString());
          path = args[2] as string[];
          deadline = Number(args[4]);
        }
      } else {
        if (isETHInput) {
          // swapETHForExactTokens(amountOut, path, to, deadline)
          expectedAmountOut = BigInt(args[0].toString());
          amountIn = BigInt(tx.value || '0'); // Max input is the ETH sent
          path = args[1] as string[];
          deadline = Number(args[3]);
        } else {
          // swapTokensForExactTokens/ETH(amountOut, amountInMax, path, to, deadline)
          expectedAmountOut = BigInt(args[0].toString());
          amountIn = BigInt(args[1].toString()); // Max input
          path = args[2] as string[];
          deadline = Number(args[4]);
        }
      }

      // Calculate slippage tolerance (approximation)
      const slippageTolerance = this.calculateSlippage(amountIn, expectedAmountOut, isExactInput);

      // Parse gas price
      const gasPrice = tx.gasPrice ? BigInt(tx.gasPrice) : 0n;
      const maxFeePerGas = tx.maxFeePerGas ? BigInt(tx.maxFeePerGas) : undefined;
      const maxPriorityFeePerGas = tx.maxPriorityFeePerGas ? BigInt(tx.maxPriorityFeePerGas) : undefined;

      return {
        hash: tx.hash,
        router: tx.to,
        type: 'uniswapV2',
        tokenIn: path[0],
        tokenOut: path[path.length - 1],
        amountIn,
        expectedAmountOut,
        path,
        slippageTolerance,
        deadline,
        sender: tx.from,
        gasPrice,
        maxFeePerGas,
        maxPriorityFeePerGas,
        nonce: parseInt(tx.nonce, 16),
        chainId: tx.chainId ?? 1,
        firstSeen: Date.now(),
      };
    } catch (error) {
      this.logger.debug('V2 decode error', { error: (error as Error).message });
      return null;
    }
  }

  /**
   * Decode Uniswap V3 style swap.
   */
  private decodeV3Swap(tx: RawPendingTransaction): PendingSwapIntent | null {
    try {
      // Try Router02 ABI first (more common)
      let decoded = uniswapV3Router02Interface.parseTransaction({ data: tx.input, value: BigInt(tx.value || '0') });

      // Fallback to original V3 router ABI
      if (!decoded) {
        decoded = uniswapV3Interface.parseTransaction({ data: tx.input, value: BigInt(tx.value || '0') });
      }

      if (!decoded) return null;

      const methodName = decoded.name;
      const args = decoded.args;

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
          deadline = params.deadline ? Number(params.deadline) : Math.floor(Date.now() / 1000) + 3600;
        } else {
          expectedAmountOut = BigInt(params.amountOut.toString());
          amountIn = BigInt(params.amountInMaximum.toString());
          deadline = params.deadline ? Number(params.deadline) : Math.floor(Date.now() / 1000) + 3600;
        }
      } else if (methodName === 'exactInput' || methodName === 'exactOutput') {
        // Multi-hop swap with encoded path
        const params = args[0];
        const encodedPath = params.path;

        // Decode V3 path (tokenIn + fee + tokenOut + fee + ...)
        path = this.decodeV3Path(encodedPath);

        if (path.length < 2) return null;

        tokenIn = path[0];
        tokenOut = path[path.length - 1];

        if (methodName === 'exactInput') {
          amountIn = BigInt(params.amountIn.toString());
          expectedAmountOut = BigInt(params.amountOutMinimum.toString());
        } else {
          expectedAmountOut = BigInt(params.amountOut.toString());
          amountIn = BigInt(params.amountInMaximum.toString());
        }

        deadline = params.deadline ? Number(params.deadline) : Math.floor(Date.now() / 1000) + 3600;
      } else {
        return null;
      }

      const slippageTolerance = this.calculateSlippage(
        amountIn,
        expectedAmountOut,
        methodName.includes('Input')
      );

      const gasPrice = tx.gasPrice ? BigInt(tx.gasPrice) : 0n;
      const maxFeePerGas = tx.maxFeePerGas ? BigInt(tx.maxFeePerGas) : undefined;
      const maxPriorityFeePerGas = tx.maxPriorityFeePerGas ? BigInt(tx.maxPriorityFeePerGas) : undefined;

      return {
        hash: tx.hash,
        router: tx.to,
        type: 'uniswapV3',
        tokenIn,
        tokenOut,
        amountIn,
        expectedAmountOut,
        path,
        slippageTolerance,
        deadline,
        sender: tx.from,
        gasPrice,
        maxFeePerGas,
        maxPriorityFeePerGas,
        nonce: parseInt(tx.nonce, 16),
        chainId: tx.chainId ?? 1,
        firstSeen: Date.now(),
      };
    } catch (error) {
      this.logger.debug('V3 decode error', { error: (error as Error).message });
      return null;
    }
  }

  /**
   * Decode V3 encoded path to array of token addresses.
   */
  private decodeV3Path(encodedPath: string): string[] {
    const path: string[] = [];

    // V3 path format: token0 (20 bytes) + fee (3 bytes) + token1 (20 bytes) + ...
    // Total = 23 bytes per hop
    const pathData = encodedPath.startsWith('0x') ? encodedPath.slice(2) : encodedPath;

    if (pathData.length < 40) return []; // Minimum 1 token (20 bytes = 40 hex chars)

    // First token
    path.push('0x' + pathData.slice(0, 40));

    // Subsequent tokens (after fee)
    let offset = 46; // 40 (token) + 6 (fee)
    while (offset + 40 <= pathData.length) {
      path.push('0x' + pathData.slice(offset, offset + 40));
      offset += 46;
    }

    return path;
  }

  /**
   * Calculate approximate slippage tolerance.
   */
  private calculateSlippage(amountIn: bigint, expectedOut: bigint, isExactInput: boolean): number {
    // For exact input, slippage is applied to output (minimum output)
    // For exact output, slippage is applied to input (maximum input)
    // Without knowing the spot price, we can only estimate based on typical values
    // Most users set 0.5% to 1% slippage, we'll estimate conservatively
    return 0.005; // Default 0.5% estimate
  }

  /**
   * Get decoder statistics.
   */
  getStats(): { decoderCount: number; routerCount: number } {
    return {
      decoderCount: this.decoders.size,
      routerCount: this.routerAddressToType.size,
    };
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Create a new SwapDecoderRegistry instance.
 *
 * @param logger - Logger instance
 * @returns Configured SwapDecoderRegistry
 */
export function createSwapDecoderRegistry(logger: Logger): SwapDecoderRegistry {
  return new SwapDecoderRegistry(logger);
}
