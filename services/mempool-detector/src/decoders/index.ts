/**
 * Swap Transaction Decoders
 *
 * Modular decoder system for extracting swap intents from pending transactions.
 * Supports Uniswap V2/V3, SushiSwap, PancakeSwap, Curve, and other DEXes.
 *
 * @see Task 1.3.2: Pending Transaction Decoder (Implementation Plan v3.0)
 */

import type { Logger } from '@arbitrage/core';
import { KNOWN_ROUTERS } from '@arbitrage/config';
import {
  BaseDecoder,
  resolveChainId,
  CHAIN_NAME_TO_ID,
  CHAIN_ID_TO_NAME,
} from './base-decoder';
import type {
  SwapDecoder,
  RawPendingTransaction,
  PendingSwapIntent,
  SwapRouterType,
  SelectorInfo,
} from './base-decoder';
import { UniswapV2Decoder, UNISWAP_V2_SELECTORS, createUniswapV2Decoder } from './uniswap-v2';
import { UniswapV3Decoder, UNISWAP_V3_SELECTORS, createUniswapV3Decoder } from './uniswap-v3';
import { CurveDecoder, CURVE_SELECTORS, createCurveDecoder } from './curve';
import { OneInchDecoder, ONEINCH_SELECTORS, createOneInchDecoder } from './oneinch';

// =============================================================================
// COMBINED SELECTOR MAP
// =============================================================================

/**
 * Combined map of all supported swap function selectors.
 */
export const SWAP_FUNCTION_SELECTORS: Record<string, SelectorInfo> = {
  ...UNISWAP_V2_SELECTORS,
  ...UNISWAP_V3_SELECTORS,
  ...CURVE_SELECTORS,
  ...ONEINCH_SELECTORS,
};

// =============================================================================
// DECODER REGISTRY
// =============================================================================

/**
 * Decoder Registry
 *
 * Central registry for all swap decoders. Routes transactions to the appropriate
 * decoder based on function selector and router address.
 *
 * FIX 10.1: Hot path optimizations:
 * - Pre-normalized selector keys (lowercase) - avoids toLowerCase() on every lookup
 * - Minimized object creation in decode path
 * - Chain ID pre-computed numeric maps
 */
export class DecoderRegistry {
  private decoders: Map<SwapRouterType, SwapDecoder> = new Map();
  /** FIX 10.1: Selectors stored lowercase - no normalization needed on lookup */
  private selectorToDecoder: Map<string, SwapDecoder> = new Map();
  /** Chain-aware router registry: chainId -> address -> routerType */
  private chainRouterRegistry: Map<number, Map<string, SwapRouterType>> = new Map();
  /** FIX 10.1: Pre-normalized (lowercase) flat router registry */
  private routerAddressToType: Map<string, SwapRouterType> = new Map();
  private logger: Logger;

  /**
   * FIX 10.2.2: Track if we've ever seen uppercase hex selectors.
   * Most feeds (bloXroute, etc.) send lowercase hex, so we skip the
   * regex check entirely if we've never seen uppercase.
   */
  private hasSeenUppercaseSelector = false;

  constructor(logger: Logger) {
    this.logger = logger;
    this.initializeDecoders();
    this.initializeSelectorMap();
    this.initializeRouterRegistry();
  }

  /**
   * Initialize all swap decoders.
   */
  private initializeDecoders(): void {
    // Uniswap V2 decoder (also handles SushiSwap, PancakeSwap V2)
    const v2Decoder = createUniswapV2Decoder(this.logger);
    this.decoders.set('uniswapV2', v2Decoder);
    this.decoders.set('sushiswap', v2Decoder);
    this.decoders.set('pancakeswap', v2Decoder);

    // Uniswap V3 decoder (also handles PancakeSwap V3)
    const v3Decoder = createUniswapV3Decoder(this.logger);
    this.decoders.set('uniswapV3', v3Decoder);

    // Curve decoder
    const curveDecoder = createCurveDecoder(this.logger);
    this.decoders.set('curve', curveDecoder);

    // 1inch decoder
    const oneInchDecoder = createOneInchDecoder(this.logger);
    this.decoders.set('1inch', oneInchDecoder);
  }

  /**
   * Initialize selector to decoder mapping.
   */
  private initializeSelectorMap(): void {
    // V2 selectors
    for (const selector of Object.keys(UNISWAP_V2_SELECTORS)) {
      this.selectorToDecoder.set(selector, this.decoders.get('uniswapV2')!);
    }

    // V3 selectors
    for (const selector of Object.keys(UNISWAP_V3_SELECTORS)) {
      this.selectorToDecoder.set(selector, this.decoders.get('uniswapV3')!);
    }

    // Curve selectors
    for (const selector of Object.keys(CURVE_SELECTORS)) {
      this.selectorToDecoder.set(selector, this.decoders.get('curve')!);
    }

    // 1inch selectors
    for (const selector of Object.keys(ONEINCH_SELECTORS)) {
      this.selectorToDecoder.set(selector, this.decoders.get('1inch')!);
    }
  }

  /**
   * Initialize router address lookup maps from config.
   * Populates both chain-aware and flat registries.
   */
  private initializeRouterRegistry(): void {
    for (const [chainName, routers] of Object.entries(KNOWN_ROUTERS)) {
      const chainId = CHAIN_NAME_TO_ID[chainName.toLowerCase()];
      if (chainId === undefined) {
        this.logger.debug('Unknown chain in KNOWN_ROUTERS', { chainName });
        continue;
      }

      // Initialize chain-specific map if not exists
      if (!this.chainRouterRegistry.has(chainId)) {
        this.chainRouterRegistry.set(chainId, new Map());
      }
      const chainMap = this.chainRouterRegistry.get(chainId)!;

      for (const [address, info] of Object.entries(routers)) {
        const normalizedAddress = address.toLowerCase();
        const routerType = info.type as SwapRouterType;

        // Add to chain-aware registry
        chainMap.set(normalizedAddress, routerType);

        // Add to flat registry (for backward compatibility)
        // Note: If same address exists on multiple chains, last one wins
        this.routerAddressToType.set(normalizedAddress, routerType);
      }
    }
  }

  /**
   * Decode a pending transaction to extract swap intent.
   *
   * FIX 10.1: Hot path optimizations:
   * - Minimal string operations (selector already lowercase in most feeds)
   * - Avoid object spread when possible
   * - Early exit for non-swap transactions
   *
   * @param tx - Raw pending transaction
   * @param chainId - Chain ID or name
   * @returns Decoded swap intent or null if not decodable
   */
  decode(tx: RawPendingTransaction, chainId: string | number): PendingSwapIntent | null {
    // FIX 10.1: Early exit for invalid input - most transactions won't be swaps
    const input = tx.input;
    if (!input || input.length < 10) {
      return null;
    }

    // FIX 10.1/10.2.2: Optimize selector extraction
    // Most feeds send lowercase hex, so try direct lookup first before lowercasing
    let selector = input.slice(0, 10);
    let decoder = this.selectorToDecoder.get(selector);

    // FIX 10.2.2: Only check for uppercase if we've seen it before OR if lookup failed
    // This avoids regex on every transaction when the feed consistently sends lowercase
    if (!decoder) {
      // Check if this selector has uppercase that needs normalization
      const hasUppercase = /[A-F]/.test(selector);
      if (hasUppercase) {
        // Track that we've seen uppercase (affects future lookups)
        this.hasSeenUppercaseSelector = true;
        selector = selector.toLowerCase();
        decoder = this.selectorToDecoder.get(selector);
      }
    }

    if (!decoder) {
      return null; // Not a known swap function - fast exit for ~90% of transactions
    }

    try {
      // FIX 10.1: Resolve chain ID once
      const numericChainId = typeof chainId === 'number' ? chainId : resolveChainId(chainId);

      // FIX 10.1: Only create new object if chainId needs to be set
      // This avoids object spread overhead for the common case where chainId is already set
      let txToProcess: RawPendingTransaction;
      if (tx.chainId === undefined || tx.chainId === null) {
        txToProcess = { ...tx, chainId: numericChainId };
      } else {
        txToProcess = tx;
      }

      const result = decoder.decode(txToProcess);

      if (result) {
        // Ensure chain ID is set correctly
        result.chainId = numericChainId;
      }

      return result;
    } catch (error) {
      this.logger.debug('Decode error', {
        txHash: tx.hash,
        selector,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Get decoder for a specific function selector.
   *
   * @param selector - 4-byte function selector (with 0x prefix)
   * @returns Decoder or undefined if not found
   */
  getDecoderForSelector(selector: string): SwapDecoder | undefined {
    return this.selectorToDecoder.get(selector.toLowerCase());
  }

  /**
   * Register a custom decoder for a selector.
   *
   * @param selector - 4-byte function selector
   * @param decoder - Decoder instance
   */
  registerDecoder(selector: string, decoder: SwapDecoder): void {
    this.selectorToDecoder.set(selector.toLowerCase(), decoder);
    if (!this.decoders.has(decoder.type)) {
      this.decoders.set(decoder.type, decoder);
    }
  }

  /**
   * Get router type for a known router address (chain-agnostic).
   * Note: If the same address exists on multiple chains with different types,
   * this returns an arbitrary match. Use getRouterTypeForChain for precise lookups.
   *
   * @param address - Router contract address
   * @returns Router type or undefined if not known
   */
  getRouterType(address: string): SwapRouterType | undefined {
    return this.routerAddressToType.get(address.toLowerCase());
  }

  /**
   * Get router type for a known router address on a specific chain.
   * Preferred over getRouterType when chain context is available.
   *
   * @param address - Router contract address
   * @param chainId - Chain ID (numeric or string name)
   * @returns Router type or undefined if not known for this chain
   */
  getRouterTypeForChain(address: string, chainId: string | number): SwapRouterType | undefined {
    const numericChainId = resolveChainId(chainId);
    const chainMap = this.chainRouterRegistry.get(numericChainId);
    if (!chainMap) {
      return undefined;
    }
    return chainMap.get(address.toLowerCase());
  }

  /**
   * Get all supported function selectors.
   *
   * @returns Array of supported selectors
   */
  getSupportedSelectors(): string[] {
    return Array.from(this.selectorToDecoder.keys());
  }

  /**
   * Get decoder statistics.
   */
  getStats(): { decoderCount: number; routerCount: number; selectorCount: number; chainCount: number } {
    return {
      decoderCount: this.decoders.size,
      routerCount: this.routerAddressToType.size,
      selectorCount: this.selectorToDecoder.size,
      chainCount: this.chainRouterRegistry.size,
    };
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Create a new DecoderRegistry instance with all decoders initialized.
 *
 * @param logger - Logger instance
 * @returns Configured DecoderRegistry
 */
export function createDecoderRegistry(logger: Logger): DecoderRegistry {
  return new DecoderRegistry(logger);
}

// =============================================================================
// RE-EXPORTS
// =============================================================================

// Base types and utilities
export {
  BaseDecoder,
  resolveChainId,
  CHAIN_NAME_TO_ID,
  CHAIN_ID_TO_NAME,
} from './base-decoder';
export type { SwapDecoder, RawPendingTransaction, PendingSwapIntent, SwapRouterType, SelectorInfo };

// Individual decoders
export { UniswapV2Decoder, UNISWAP_V2_SELECTORS, createUniswapV2Decoder } from './uniswap-v2';
export { UniswapV3Decoder, UNISWAP_V3_SELECTORS, createUniswapV3Decoder } from './uniswap-v3';
export { CurveDecoder, CURVE_SELECTORS, CURVE_POOL_TOKENS, createCurveDecoder } from './curve';
export { OneInchDecoder, ONEINCH_SELECTORS, createOneInchDecoder } from './oneinch';
