/**
 * Swap Transaction Decoder (Backward Compatible Wrapper)
 *
 * This module provides backward compatibility with the original SwapDecoderRegistry
 * interface while using the new modular decoder system under the hood.
 *
 * For new code, prefer importing from './decoders' directly.
 *
 * FIX 7.3: Updated imports to use centralized config for chain ID utilities.
 *
 * @see Task 1.3.2: Pending Transaction Decoder (Implementation Plan v3.0)
 */

import type { Logger } from '@arbitrage/core';
import {
  // FIX 6.3: Import chain utilities from centralized config
  CHAIN_NAME_TO_ID,
  CHAIN_ID_TO_NAME,
} from '@arbitrage/config';
import {
  DecoderRegistry,
  createDecoderRegistry,
  SWAP_FUNCTION_SELECTORS,
} from './decoders';
import type {
  RawPendingTransaction,
  PendingSwapIntent,
  SwapRouterType,
  SwapDecoder,
} from './types';

// =============================================================================
// BACKWARD COMPATIBILITY EXPORTS
// =============================================================================

/**
 * Known function selectors for swap functions.
 * Pre-computed 4-byte selectors for O(1) matching.
 *
 * @deprecated Use SWAP_FUNCTION_SELECTORS from './decoders' instead.
 * This export is maintained for backward compatibility only.
 * FIX 7.3: Marked as deprecated with clear migration path.
 */
export const SWAP_SELECTORS = SWAP_FUNCTION_SELECTORS;

/**
 * Re-export chain mappings from centralized config.
 * FIX 6.3, 9.2: Chain ID utilities now come from @arbitrage/config
 */
export { CHAIN_NAME_TO_ID, CHAIN_ID_TO_NAME };

// =============================================================================
// SWAP DECODER REGISTRY (Backward Compatible Wrapper)
// =============================================================================

/**
 * Swap Decoder Registry
 *
 * Manages multiple swap decoders and routes transactions to appropriate decoders.
 * This is a backward-compatible wrapper around the new DecoderRegistry.
 *
 * @example
 * ```typescript
 * const registry = createSwapDecoderRegistry(logger);
 * const intent = registry.decode(tx, 'ethereum');
 * ```
 */
export class SwapDecoderRegistry {
  private registry: DecoderRegistry;
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
    this.registry = createDecoderRegistry(logger);
  }

  /**
   * Decode a pending transaction to extract swap intent.
   *
   * @param tx - Raw pending transaction
   * @param chainId - Chain ID or name
   * @returns Decoded swap intent or null if not decodable
   */
  decode(tx: RawPendingTransaction, chainId: string | number): PendingSwapIntent | null {
    return this.registry.decode(tx, chainId);
  }

  /**
   * Get decoder for a specific function selector.
   *
   * @param selector - 4-byte function selector (with 0x prefix)
   * @returns Decoder or undefined if not found
   */
  getDecoderForSelector(selector: string): SwapDecoder | undefined {
    return this.registry.getDecoderForSelector(selector);
  }

  /**
   * Get router type for a known router address (chain-agnostic).
   *
   * @param address - Router contract address
   * @returns Router type or undefined if not known
   */
  getRouterType(address: string): SwapRouterType | undefined {
    return this.registry.getRouterType(address);
  }

  /**
   * Get router type for a known router address on a specific chain.
   *
   * @param address - Router contract address
   * @param chainId - Chain ID (numeric or string name)
   * @returns Router type or undefined if not known for this chain
   */
  getRouterTypeForChain(address: string, chainId: string | number): SwapRouterType | undefined {
    return this.registry.getRouterTypeForChain(address, chainId);
  }

  /**
   * Get all supported function selectors.
   *
   * @returns Array of supported selectors
   */
  getSupportedSelectors(): string[] {
    return this.registry.getSupportedSelectors();
  }

  /**
   * Get decoder statistics.
   */
  getStats(): { decoderCount: number; routerCount: number } {
    const stats = this.registry.getStats();
    return {
      decoderCount: stats.decoderCount,
      routerCount: stats.routerCount,
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
