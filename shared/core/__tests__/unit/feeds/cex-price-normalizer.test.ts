/**
 * CexPriceNormalizer Tests
 *
 * Tests for Binance symbol to internal token ID normalization.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// =============================================================================
// Mock Setup
// =============================================================================

jest.mock('../../../src/logger');

// =============================================================================
// Imports
// =============================================================================

import { CexPriceNormalizer } from '../../../src/feeds/cex-price-normalizer';
import type { BinanceTradeEvent } from '../../../src/feeds/binance-ws-client';

// =============================================================================
// Helpers
// =============================================================================

function createTradeEvent(overrides: Partial<BinanceTradeEvent> = {}): BinanceTradeEvent {
  return {
    symbol: 'BTCUSDT',
    price: 43250.10,
    quantity: 0.001,
    timestamp: 1708992000000,
    isBuyerMaker: true,
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('CexPriceNormalizer', () => {
  let normalizer: CexPriceNormalizer;

  beforeEach(() => {
    normalizer = new CexPriceNormalizer();
  });

  // ===========================================================================
  // normalize()
  // ===========================================================================

  describe('normalize()', () => {
    it('should map BTCUSDT to WBTC with correct chains', () => {
      const trade = createTradeEvent({ symbol: 'BTCUSDT', price: 43250.10 });
      const result = normalizer.normalize(trade);

      expect(result).toBeDefined();
      expect(result!.tokenId).toBe('WBTC');
      expect(result!.chains).toEqual(['ethereum', 'arbitrum', 'base', 'polygon']);
      expect(result!.source).toBe('binance');
    });

    it('should map ETHUSDT to WETH with all EVM + L2 chains', () => {
      const trade = createTradeEvent({ symbol: 'ETHUSDT', price: 2850.50 });
      const result = normalizer.normalize(trade);

      expect(result).toBeDefined();
      expect(result!.tokenId).toBe('WETH');
      expect(result!.chains).toContain('ethereum');
      expect(result!.chains).toContain('arbitrum');
      expect(result!.chains).toContain('base');
      expect(result!.chains).toContain('optimism');
      expect(result!.chains).toContain('linea');
      expect(result!.chains).toContain('zksync');
    });

    it('should map BNBUSDT to WBNB on BSC', () => {
      const trade = createTradeEvent({ symbol: 'BNBUSDT', price: 310.00 });
      const result = normalizer.normalize(trade);

      expect(result).toBeDefined();
      expect(result!.tokenId).toBe('WBNB');
      expect(result!.chains).toEqual(['bsc']);
    });

    it('should map SOLUSDT to SOL on Solana', () => {
      const trade = createTradeEvent({ symbol: 'SOLUSDT', price: 100.00 });
      const result = normalizer.normalize(trade);

      expect(result).toBeDefined();
      expect(result!.tokenId).toBe('SOL');
      expect(result!.chains).toEqual(['solana']);
    });

    it('should map AVAXUSDT to WAVAX on Avalanche', () => {
      const trade = createTradeEvent({ symbol: 'AVAXUSDT', price: 35.00 });
      const result = normalizer.normalize(trade);

      expect(result).toBeDefined();
      expect(result!.tokenId).toBe('WAVAX');
      expect(result!.chains).toEqual(['avalanche']);
    });

    it('should map MATICUSDT to WMATIC on Polygon', () => {
      const trade = createTradeEvent({ symbol: 'MATICUSDT', price: 0.85 });
      const result = normalizer.normalize(trade);

      expect(result).toBeDefined();
      expect(result!.tokenId).toBe('WMATIC');
      expect(result!.chains).toEqual(['polygon']);
    });

    it('should map ARBUSDT to ARB on Arbitrum', () => {
      const trade = createTradeEvent({ symbol: 'ARBUSDT', price: 1.25 });
      const result = normalizer.normalize(trade);

      expect(result).toBeDefined();
      expect(result!.tokenId).toBe('ARB');
      expect(result!.chains).toEqual(['arbitrum']);
    });

    it('should map OPUSDT to OP on Optimism', () => {
      const trade = createTradeEvent({ symbol: 'OPUSDT', price: 3.50 });
      const result = normalizer.normalize(trade);

      expect(result).toBeDefined();
      expect(result!.tokenId).toBe('OP');
      expect(result!.chains).toEqual(['optimism']);
    });

    it('should return undefined for unknown symbols', () => {
      const trade = createTradeEvent({ symbol: 'DOGEUSDT', price: 0.08 });
      const result = normalizer.normalize(trade);

      expect(result).toBeUndefined();
    });

    it('should return undefined for empty symbol', () => {
      const trade = createTradeEvent({ symbol: '' });
      const result = normalizer.normalize(trade);

      expect(result).toBeUndefined();
    });

    it('should preserve price from source', () => {
      const trade = createTradeEvent({ symbol: 'BTCUSDT', price: 99999.99 });
      const result = normalizer.normalize(trade);

      expect(result!.price).toBe(99999.99);
    });

    it('should preserve timestamp from source', () => {
      const trade = createTradeEvent({ symbol: 'BTCUSDT', timestamp: 1234567890123 });
      const result = normalizer.normalize(trade);

      expect(result!.timestamp).toBe(1234567890123);
    });
  });

  // ===========================================================================
  // Custom Mappings
  // ===========================================================================

  describe('custom mappings', () => {
    it('should override defaults with custom mappings', () => {
      const customNormalizer = new CexPriceNormalizer({
        symbolMappings: {
          BTCUSDT: { tokenId: 'BTC_CUSTOM', chains: ['ethereum'] },
        },
      });

      const trade = createTradeEvent({ symbol: 'BTCUSDT' });
      const result = customNormalizer.normalize(trade);

      expect(result!.tokenId).toBe('BTC_CUSTOM');
      expect(result!.chains).toEqual(['ethereum']);
    });

    it('should add new symbols via custom mappings', () => {
      const customNormalizer = new CexPriceNormalizer({
        symbolMappings: {
          LINKUSDT: { tokenId: 'LINK', chains: ['ethereum', 'arbitrum'] },
        },
      });

      const trade = createTradeEvent({ symbol: 'LINKUSDT', price: 15.00 });
      const result = customNormalizer.normalize(trade);

      expect(result).toBeDefined();
      expect(result!.tokenId).toBe('LINK');
      expect(result!.chains).toEqual(['ethereum', 'arbitrum']);
    });

    it('should still support default symbols when adding custom ones', () => {
      const customNormalizer = new CexPriceNormalizer({
        symbolMappings: {
          LINKUSDT: { tokenId: 'LINK', chains: ['ethereum'] },
        },
      });

      // Default mapping should still work
      const ethTrade = createTradeEvent({ symbol: 'ETHUSDT' });
      const ethResult = customNormalizer.normalize(ethTrade);
      expect(ethResult!.tokenId).toBe('WETH');
    });
  });

  // ===========================================================================
  // getSupportedSymbols()
  // ===========================================================================

  describe('getSupportedSymbols()', () => {
    it('should return all 9 default symbols', () => {
      const symbols = normalizer.getSupportedSymbols();

      expect(symbols.length).toBe(9);
      expect(symbols).toContain('BTCUSDT');
      expect(symbols).toContain('ETHUSDT');
      expect(symbols).toContain('BNBUSDT');
      expect(symbols).toContain('SOLUSDT');
      expect(symbols).toContain('AVAXUSDT');
      expect(symbols).toContain('MATICUSDT');
      expect(symbols).toContain('ARBUSDT');
      expect(symbols).toContain('OPUSDT');
      expect(symbols).toContain('FTMUSDT');
    });

    it('should include custom symbols', () => {
      const customNormalizer = new CexPriceNormalizer({
        symbolMappings: {
          LINKUSDT: { tokenId: 'LINK', chains: ['ethereum'] },
        },
      });

      const symbols = customNormalizer.getSupportedSymbols();
      expect(symbols).toContain('LINKUSDT');
      expect(symbols.length).toBe(10); // 9 defaults + 1 custom
    });
  });

  // ===========================================================================
  // isSupported()
  // ===========================================================================

  describe('isSupported()', () => {
    it('should return true for supported symbols', () => {
      expect(normalizer.isSupported('BTCUSDT')).toBe(true);
      expect(normalizer.isSupported('ETHUSDT')).toBe(true);
      expect(normalizer.isSupported('SOLUSDT')).toBe(true);
    });

    it('should return false for unsupported symbols', () => {
      expect(normalizer.isSupported('DOGEUSDT')).toBe(false);
      expect(normalizer.isSupported('SHIBUSDT')).toBe(false);
      expect(normalizer.isSupported('')).toBe(false);
    });
  });
});
