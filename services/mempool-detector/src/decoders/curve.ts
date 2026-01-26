/**
 * Curve Swap Decoder
 *
 * Decodes Curve Finance swap transactions across different pool types.
 *
 * Supported methods:
 * - exchange (StableSwap pools)
 * - exchange_underlying (Lending pools)
 * - exchange (Crypto pools - uint256 indices)
 * - exchange_multiple (Router-NG)
 *
 * @see Task 1.3.2: Pending Transaction Decoder (Implementation Plan v3.0)
 */

import { Interface, AbiCoder } from 'ethers';
import type { Logger } from '@arbitrage/core';
import { getCurvePoolTokens, CURVE_POOL_TOKENS } from '@arbitrage/config';
import { BaseDecoder, hexToBigInt, isValidInput } from './base-decoder';
import type { RawPendingTransaction, PendingSwapIntent, SwapRouterType, SelectorInfo } from './base-decoder';

// Re-export CURVE_POOL_TOKENS from config for backward compatibility
export { CURVE_POOL_TOKENS };

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Curve function selectors.
 */
export const CURVE_SELECTORS: Record<string, SelectorInfo> = {
  // StableSwap pools - int128 indices
  '0x3df02124': { method: 'exchange', routerTypes: ['curve'] }, // exchange(int128,int128,uint256,uint256)
  '0xa6417ed6': { method: 'exchange_underlying', routerTypes: ['curve'] }, // exchange_underlying(int128,int128,uint256,uint256)
  // CryptoSwap pools - uint256 indices
  '0x5b41b908': { method: 'exchange', routerTypes: ['curve'] }, // exchange(uint256,uint256,uint256,uint256)
  '0xe2ad025a': { method: 'exchange_underlying', routerTypes: ['curve'] }, // exchange_underlying(uint256,uint256,uint256,uint256)
  // With ETH support
  '0x394747c5': { method: 'exchange', routerTypes: ['curve'] }, // exchange(int128,int128,uint256,uint256,bool)
  // Router-NG
  '0x37ed3a7a': { method: 'exchange', routerTypes: ['curve'] }, // Router exchange
  '0x98f9f0fb': { method: 'exchange_multiple', routerTypes: ['curve'] }, // Deprecated router
};

/**
 * Curve StableSwap ABI fragment.
 */
const CURVE_STABLESWAP_ABI = [
  'function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy)',
  'function exchange_underlying(int128 i, int128 j, uint256 dx, uint256 min_dy)',
  'function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy, bool use_eth)',
];

/**
 * Curve CryptoSwap ABI fragment.
 */
const CURVE_CRYPTOSWAP_ABI = [
  'function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy)',
  'function exchange_underlying(uint256 i, uint256 j, uint256 dx, uint256 min_dy)',
  'function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy, bool use_eth)',
];

// Pre-create Interface instances
const curveStableSwapInterface = new Interface(CURVE_STABLESWAP_ABI);
const curveCryptoSwapInterface = new Interface(CURVE_CRYPTOSWAP_ABI);

// AbiCoder for manual decoding
const abiCoder = new AbiCoder();

// =============================================================================
// DECODER IMPLEMENTATION
// =============================================================================

/**
 * Curve Finance Swap Decoder
 *
 * Decodes swap transactions for Curve pools across different pool types.
 */
export class CurveDecoder extends BaseDecoder {
  readonly type: SwapRouterType = 'curve';
  readonly name = 'Curve';
  readonly supportedChains = [1, 42161, 137, 10, 8453];

  constructor(logger: Logger) {
    super(logger);
  }

  /**
   * Check if this decoder can handle the given transaction.
   */
  canDecode(tx: RawPendingTransaction): boolean {
    const selector = this.getSelector(tx.input);
    if (!selector) return false;
    return selector in CURVE_SELECTORS;
  }

  /**
   * Decode Curve swap transaction.
   */
  decode(tx: RawPendingTransaction): PendingSwapIntent | null {
    if (!isValidInput(tx.input, 10)) {
      return null;
    }

    const selector = this.getSelector(tx.input)!;

    try {
      // Try StableSwap ABI first (int128 indices)
      let decoded = this.tryDecode(tx, curveStableSwapInterface);

      // Fallback to CryptoSwap ABI (uint256 indices)
      if (!decoded) {
        decoded = this.tryDecode(tx, curveCryptoSwapInterface);
      }

      // If still no match, try manual decoding
      if (!decoded) {
        return this.manualDecode(tx, selector);
      }

      return this.extractSwapIntent(tx, decoded);
    } catch (error) {
      this.logger.debug('Curve decode error', {
        txHash: tx.hash,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Get pool tokens for a known Curve pool.
   * Uses configuration from @arbitrage/config for pool token mappings.
   *
   * @param poolAddress - Pool contract address
   * @param chainId - Chain ID
   * @returns Array of token addresses or undefined
   */
  getPoolTokens(poolAddress: string, chainId: number): string[] | undefined {
    return getCurvePoolTokens(chainId, poolAddress);
  }

  /**
   * Try to decode with a specific interface.
   */
  private tryDecode(
    tx: RawPendingTransaction,
    iface: Interface
  ): ReturnType<Interface['parseTransaction']> | null {
    try {
      return iface.parseTransaction({
        data: tx.input,
        value: hexToBigInt(tx.value),
      });
    } catch {
      return null;
    }
  }

  /**
   * Manual decoding for non-standard selectors or when ABI fails.
   */
  private manualDecode(tx: RawPendingTransaction, selector: string): PendingSwapIntent | null {
    const inputData = tx.input.slice(10); // Remove selector

    try {
      // Standard exchange(int128 i, int128 j, uint256 dx, uint256 min_dy)
      if (selector === '0x3df02124' || selector === '0xa6417ed6') {
        const decoded = abiCoder.decode(
          ['int128', 'int128', 'uint256', 'uint256'],
          '0x' + inputData
        );

        const i = Number(decoded[0]);
        const j = Number(decoded[1]);
        const dx = BigInt(decoded[2].toString());
        const minDy = BigInt(decoded[3].toString());

        return this.createCurveIntent(tx, i, j, dx, minDy);
      }

      // CryptoSwap exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy)
      if (selector === '0x5b41b908' || selector === '0xe2ad025a') {
        const decoded = abiCoder.decode(
          ['uint256', 'uint256', 'uint256', 'uint256'],
          '0x' + inputData
        );

        const i = Number(decoded[0]);
        const j = Number(decoded[1]);
        const dx = BigInt(decoded[2].toString());
        const minDy = BigInt(decoded[3].toString());

        return this.createCurveIntent(tx, i, j, dx, minDy);
      }

      // exchange with use_eth flag
      if (selector === '0x394747c5') {
        const decoded = abiCoder.decode(
          ['int128', 'int128', 'uint256', 'uint256', 'bool'],
          '0x' + inputData
        );

        const i = Number(decoded[0]);
        const j = Number(decoded[1]);
        const dx = BigInt(decoded[2].toString());
        const minDy = BigInt(decoded[3].toString());

        return this.createCurveIntent(tx, i, j, dx, minDy);
      }

      return null;
    } catch (error) {
      this.logger.debug('Curve manual decode error', {
        txHash: tx.hash,
        selector,
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

    const args = decoded.args;

    try {
      const i = Number(args[0]);
      const j = Number(args[1]);
      const dx = BigInt(args[2].toString());
      const minDy = BigInt(args[3].toString());

      return this.createCurveIntent(tx, i, j, dx, minDy);
    } catch (error) {
      this.logger.debug('Curve extractSwapIntent error', {
        txHash: tx.hash,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Create Curve swap intent from decoded parameters.
   *
   * FIX 4.3: Returns valid addresses or pool address as placeholder
   * instead of invalid format like "poolAddress:index".
   */
  private createCurveIntent(
    tx: RawPendingTransaction,
    i: number,
    j: number,
    dx: bigint,
    minDy: bigint
  ): PendingSwapIntent {
    const chainId = tx.chainId ?? 1;
    const poolAddress = tx.to.toLowerCase();

    // Try to resolve token addresses from pool configuration
    const poolTokens = this.getPoolTokens(poolAddress, chainId);

    let tokenIn: string;
    let tokenOut: string;
    let tokensResolved = false;

    if (poolTokens && poolTokens[i] && poolTokens[j]) {
      tokenIn = poolTokens[i];
      tokenOut = poolTokens[j];
      tokensResolved = true;
    } else {
      // FIX 4.3: Use pool address as placeholder instead of invalid format
      // The pool address is a valid 20-byte address that downstream systems can use
      // to query the actual tokens via on-chain calls (pool.coins(i), pool.coins(j))
      //
      // This approach is better than:
      // 1. Invalid formats like "pool:index" which break address validation
      // 2. Zero addresses which lose all context
      // 3. Random/fake addresses which could cause confusion
      //
      // Using pool address signals "tokens unknown but discoverable from this pool"
      tokenIn = poolAddress;
      tokenOut = poolAddress;

      this.logger.debug('Curve pool tokens not configured', {
        txHash: tx.hash,
        poolAddress,
        tokenInIndex: i,
        tokenOutIndex: j,
        chainId,
        hint: 'Add pool to CURVE_POOL_TOKENS in mempool-config.ts',
      });
    }

    const baseIntent = this.createBaseIntent(tx);
    const slippageTolerance = this.calculateSlippage(dx, minDy);

    // FIX: Properly construct the intent object with all required fields
    const intent: PendingSwapIntent = {
      hash: baseIntent.hash!,
      router: baseIntent.router!,
      type: baseIntent.type!,
      sender: baseIntent.sender!,
      gasPrice: baseIntent.gasPrice!,
      maxFeePerGas: baseIntent.maxFeePerGas,
      maxPriorityFeePerGas: baseIntent.maxPriorityFeePerGas,
      nonce: baseIntent.nonce!,
      chainId: baseIntent.chainId!,
      firstSeen: baseIntent.firstSeen!,
      tokenIn,
      tokenOut,
      amountIn: dx,
      expectedAmountOut: minDy,
      path: [tokenIn, tokenOut],
      slippageTolerance,
      deadline: Math.floor(Date.now() / 1000) + 3600, // Curve doesn't have deadline in call
    };

    // FIX 4.3: Add metadata about token resolution status
    // This allows downstream systems to know if they need to resolve tokens
    if (!tokensResolved) {
      // Add pool info to help downstream systems resolve tokens
      (intent as PendingSwapIntent & { _curvePoolInfo?: unknown })._curvePoolInfo = {
        poolAddress,
        tokenInIndex: i,
        tokenOutIndex: j,
        tokensResolved: false,
      };
    }

    return intent;
  }

  /**
   * Calculate slippage tolerance from amounts for Curve stableswap pools.
   *
   * Override base class implementation to provide Curve-specific calculation.
   * For stablecoin swaps where tokens have equal value, we can estimate
   * slippage from the ratio of minOut to amountIn.
   *
   * @param amountIn - Input amount in wei
   * @param expectedOut - Expected minimum output amount in wei
   * @param _isExactInput - Not used for Curve (always exact input style)
   * @returns Slippage tolerance as decimal
   */
  protected override calculateSlippage(
    amountIn: bigint,
    expectedOut: bigint,
    _isExactInput: boolean = true
  ): number {
    // For stablecoin swaps, we can estimate slippage from the ratio
    // This is approximate since tokens may have different decimals
    if (amountIn === 0n || expectedOut === 0n) {
      return 0.005; // Default 0.5%
    }

    // Calculate ratio - for stablecoins this should be close to 1
    // Slippage = 1 - (minOut / amountIn)
    // Note: This is simplified and doesn't account for different decimals
    const ratio = Number(expectedOut * 10000n / amountIn) / 10000;

    if (ratio >= 1) {
      return 0.005; // Default if ratio is >= 1 (different decimal tokens)
    }

    return Math.max(0, 1 - ratio);
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Create a new CurveDecoder instance.
 */
export function createCurveDecoder(logger: Logger): CurveDecoder {
  return new CurveDecoder(logger);
}
