/**
 * Base Decoder Interface and Types
 *
 * Common interfaces, types, and utilities for swap transaction decoders.
 *
 * @see Task 1.3.2: Pending Transaction Decoder (Implementation Plan v3.0)
 */

import type { Logger } from '@arbitrage/core';
import type {
  RawPendingTransaction,
  PendingSwapIntent,
  SwapRouterType,
  SwapDecoder,
} from '../types';

// =============================================================================
// BASE DECODER CLASS
// =============================================================================

/**
 * Abstract base class for swap decoders.
 * Provides common functionality for decoding swap transactions.
 */
export abstract class BaseDecoder implements SwapDecoder {
  abstract readonly type: SwapRouterType;
  abstract readonly name: string;
  abstract readonly supportedChains: number[];

  protected logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Check if this decoder can handle the given transaction.
   * @param tx - Raw pending transaction
   * @returns True if this decoder should attempt to decode the transaction
   */
  abstract canDecode(tx: RawPendingTransaction): boolean;

  /**
   * Decode transaction input data to extract swap intent.
   * @param tx - Raw pending transaction
   * @returns Decoded swap intent or null if not decodable
   */
  abstract decode(tx: RawPendingTransaction): PendingSwapIntent | null;

  /**
   * Extract function selector from input data.
   * @param input - Transaction input data (hex string)
   * @returns 4-byte function selector or null if invalid
   */
  protected getSelector(input: string): string | null {
    if (!input || input.length < 10) {
      return null;
    }
    return input.slice(0, 10).toLowerCase();
  }

  /**
   * Parse gas price from transaction.
   * @param tx - Raw pending transaction
   * @returns Gas price as bigint
   */
  protected parseGasPrice(tx: RawPendingTransaction): bigint {
    if (tx.gasPrice) {
      return BigInt(tx.gasPrice);
    }
    if (tx.maxFeePerGas) {
      return BigInt(tx.maxFeePerGas);
    }
    return 0n;
  }

  /**
   * Parse EIP-1559 gas parameters.
   * @param tx - Raw pending transaction
   * @returns Object with maxFeePerGas and maxPriorityFeePerGas
   */
  protected parseEIP1559Gas(tx: RawPendingTransaction): {
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
  } {
    return {
      maxFeePerGas: tx.maxFeePerGas ? BigInt(tx.maxFeePerGas) : undefined,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas ? BigInt(tx.maxPriorityFeePerGas) : undefined,
    };
  }

  /**
   * Parse nonce from transaction.
   * @param tx - Raw pending transaction
   * @returns Nonce as number
   */
  protected parseNonce(tx: RawPendingTransaction): number {
    if (!tx.nonce) return 0;
    return parseInt(tx.nonce, 16);
  }

  /**
   * Create a base swap intent with common fields.
   * @param tx - Raw pending transaction
   * @returns Partial swap intent with common fields
   */
  protected createBaseIntent(tx: RawPendingTransaction): Partial<PendingSwapIntent> {
    const eip1559 = this.parseEIP1559Gas(tx);
    return {
      hash: tx.hash,
      router: tx.to,
      type: this.type,
      sender: tx.from,
      gasPrice: this.parseGasPrice(tx),
      maxFeePerGas: eip1559.maxFeePerGas,
      maxPriorityFeePerGas: eip1559.maxPriorityFeePerGas,
      nonce: this.parseNonce(tx),
      chainId: tx.chainId ?? 1,
      firstSeen: Date.now(),
    };
  }

  /**
   * Calculate slippage tolerance from swap amounts.
   *
   * Default implementation returns a standard 0.5% slippage.
   * Subclasses can override for more accurate calculations based on
   * pool type (e.g., Curve stablecoin pools can calculate from ratio).
   *
   * @param _amountIn - Input amount in wei
   * @param _expectedOut - Expected output amount in wei
   * @param _isExactInput - Whether this is an exact input swap
   * @returns Slippage tolerance as decimal (e.g., 0.005 = 0.5%)
   */
  protected calculateSlippage(
    _amountIn: bigint,
    _expectedOut: bigint,
    _isExactInput: boolean = true
  ): number {
    // Default slippage tolerance - most users set between 0.1% and 1%
    // We use 0.5% as a reasonable default since we can't determine the actual
    // slippage without knowing the current market price
    return 0.005;
  }
}

// =============================================================================
// SELECTOR INFO TYPE
// =============================================================================

/**
 * Information about a function selector.
 */
export interface SelectorInfo {
  /** Function method name */
  method: string;
  /** Router types that use this selector */
  routerTypes: SwapRouterType[];
}

// =============================================================================
// CHAIN ID MAPPING (FIX 6.3, 9.2: Import from centralized config)
// =============================================================================

// Re-export from centralized config for backward compatibility
export {
  CHAIN_NAME_TO_ID,
  CHAIN_ID_TO_NAME,
  resolveChainId,
} from '@arbitrage/config';

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Convert hex string to bigint.
 * @param hex - Hex string (with or without 0x prefix)
 * @returns BigInt value
 */
export function hexToBigInt(hex: string): bigint {
  if (!hex || hex === '0x' || hex === '0x0') {
    return 0n;
  }
  return BigInt(hex);
}

/**
 * Validate that input data has minimum length.
 * @param input - Transaction input data
 * @param minLength - Minimum required length (including 0x prefix)
 * @returns True if input is valid
 */
export function isValidInput(input: string, minLength: number = 10): boolean {
  return typeof input === 'string' && input.length >= minLength && input.startsWith('0x');
}

/**
 * Extract address from ABI-encoded data.
 * @param data - 32-byte hex string
 * @returns Address with checksum
 */
export function extractAddress(data: string): string {
  // Remove leading zeros and add 0x prefix
  const cleaned = data.replace(/^0+/, '');
  return '0x' + cleaned.padStart(40, '0');
}

// =============================================================================
// RE-EXPORT TYPES
// =============================================================================

export type { SwapDecoder, RawPendingTransaction, PendingSwapIntent, SwapRouterType };
