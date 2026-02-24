/**
 * CEX Price Normalizer
 *
 * Maps Binance trading symbols to internal token identifiers used throughout
 * the arbitrage system. Converts raw CEX trade events into normalized
 * price records with chain mapping.
 *
 * @module feeds
 */

import { createLogger } from '../logger';
import type { BinanceTradeEvent } from './binance-ws-client';

const logger = createLogger('cex-price-normalizer');

// =============================================================================
// Types
// =============================================================================

/**
 * Normalized CEX price record mapped to internal token identifiers.
 */
export interface NormalizedCexPrice {
  /** Internal token ID, e.g., 'WBTC', 'WETH' */
  tokenId: string;
  /** USD-normalized price */
  price: number;
  /** Chains where this token exists */
  chains: string[];
  /** Price source exchange */
  source: 'binance';
  /** Timestamp of the original trade (ms since epoch) */
  timestamp: number;
}

/**
 * Token mapping entry: internal token ID + supported chains.
 */
export interface TokenMapping {
  tokenId: string;
  chains: string[];
}

/**
 * Configuration for the CEX price normalizer.
 */
export interface CexNormalizerConfig {
  /** Custom symbol-to-token mappings. Overrides defaults for matching keys. */
  symbolMappings?: Record<string, TokenMapping>;
}

// =============================================================================
// Default Mappings
// =============================================================================

/**
 * Default Binance symbol to internal token/chain mappings.
 * Covers the native/wrapped tokens of all supported chains.
 */
const DEFAULT_BINANCE_MAPPINGS: Record<string, TokenMapping> = {
  BTCUSDT: {
    tokenId: 'WBTC',
    chains: ['ethereum', 'arbitrum', 'base', 'polygon'],
  },
  ETHUSDT: {
    tokenId: 'WETH',
    chains: [
      'ethereum', 'arbitrum', 'base', 'optimism',
      'linea', 'zksync',
    ],
  },
  BNBUSDT: {
    tokenId: 'WBNB',
    chains: ['bsc'],
  },
  SOLUSDT: {
    tokenId: 'SOL',
    chains: ['solana'],
  },
  AVAXUSDT: {
    tokenId: 'WAVAX',
    chains: ['avalanche'],
  },
  MATICUSDT: {
    tokenId: 'WMATIC',
    chains: ['polygon'],
  },
  ARBUSDT: {
    tokenId: 'ARB',
    chains: ['arbitrum'],
  },
  OPUSDT: {
    tokenId: 'OP',
    chains: ['optimism'],
  },
  FTMUSDT: {
    tokenId: 'WFTM',
    chains: ['fantom'],
  },
};

// =============================================================================
// CexPriceNormalizer
// =============================================================================

/**
 * Normalizes Binance trade events to internal token format.
 *
 * Maps CEX trading symbols (e.g., 'BTCUSDT') to internal token identifiers
 * (e.g., 'WBTC') and resolves which chains each token is available on.
 */
export class CexPriceNormalizer {
  private mappings: Map<string, TokenMapping>;

  constructor(config?: CexNormalizerConfig) {
    // Start with defaults, then overlay custom mappings
    const baseMappings = { ...DEFAULT_BINANCE_MAPPINGS };
    if (config?.symbolMappings) {
      Object.assign(baseMappings, config.symbolMappings);
    }

    this.mappings = new Map(Object.entries(baseMappings));

    logger.info('CexPriceNormalizer initialized', {
      symbolCount: this.mappings.size,
      symbols: Array.from(this.mappings.keys()),
    });
  }

  /**
   * Normalize a Binance trade event to internal format.
   *
   * @param trade - Raw Binance trade event
   * @returns Normalized price record, or undefined if the symbol is not mapped
   */
  normalize(trade: BinanceTradeEvent): NormalizedCexPrice | undefined {
    const mapping = this.mappings.get(trade.symbol);
    if (!mapping) {
      return undefined;
    }

    return {
      tokenId: mapping.tokenId,
      price: trade.price,
      chains: mapping.chains,
      source: 'binance',
      timestamp: trade.timestamp,
    };
  }

  /**
   * Get all supported Binance symbols.
   *
   * @returns Array of Binance symbol strings (e.g., ['BTCUSDT', 'ETHUSDT', ...])
   */
  getSupportedSymbols(): string[] {
    return Array.from(this.mappings.keys());
  }

  /**
   * Check if a Binance symbol is mapped.
   *
   * @param symbol - Binance trading symbol (e.g., 'BTCUSDT')
   * @returns true if the symbol has a mapping
   */
  isSupported(symbol: string): boolean {
    return this.mappings.has(symbol);
  }
}
