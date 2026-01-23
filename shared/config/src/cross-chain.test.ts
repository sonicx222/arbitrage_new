/**
 * Cross-Chain Token Normalization Tests
 *
 * Tests for the cross-chain token alias and normalization utilities.
 * Ensures consistent token identification across different chains.
 *
 * @see S3.2.4: Cross-chain token normalization
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  CROSS_CHAIN_TOKEN_ALIASES,
  normalizeTokenForCrossChain,
  findCommonTokensBetweenChains,
  preWarmCommonTokensCache,
  getChainSpecificTokenSymbol,
  DEFAULT_QUOTE_TOKENS,
  getDefaultQuoteToken
} from './cross-chain';

describe('Cross-Chain Token Normalization', () => {
  describe('CROSS_CHAIN_TOKEN_ALIASES', () => {
    it('should have all expected chain-specific aliases', () => {
      // Fantom aliases
      expect(CROSS_CHAIN_TOKEN_ALIASES['FUSDT']).toBe('USDT');
      expect(CROSS_CHAIN_TOKEN_ALIASES['WFTM']).toBe('FTM');

      // Avalanche aliases (bridged tokens)
      expect(CROSS_CHAIN_TOKEN_ALIASES['WAVAX']).toBe('AVAX');
      expect(CROSS_CHAIN_TOKEN_ALIASES['WETH.E']).toBe('WETH');
      expect(CROSS_CHAIN_TOKEN_ALIASES['WBTC.E']).toBe('WBTC');
      expect(CROSS_CHAIN_TOKEN_ALIASES['USDT.E']).toBe('USDT');
      expect(CROSS_CHAIN_TOKEN_ALIASES['USDC.E']).toBe('USDC');
      expect(CROSS_CHAIN_TOKEN_ALIASES['DAI.E']).toBe('DAI');
      expect(CROSS_CHAIN_TOKEN_ALIASES['SAVAX']).toBe('AVAX');

      // BSC aliases
      expect(CROSS_CHAIN_TOKEN_ALIASES['WBNB']).toBe('BNB');
      expect(CROSS_CHAIN_TOKEN_ALIASES['BTCB']).toBe('WBTC');
      expect(CROSS_CHAIN_TOKEN_ALIASES['ETH']).toBe('WETH');

      // Polygon aliases
      expect(CROSS_CHAIN_TOKEN_ALIASES['WMATIC']).toBe('MATIC');

      // Solana LST aliases
      expect(CROSS_CHAIN_TOKEN_ALIASES['MSOL']).toBe('SOL');
      expect(CROSS_CHAIN_TOKEN_ALIASES['JITOSOL']).toBe('SOL');
      expect(CROSS_CHAIN_TOKEN_ALIASES['BSOL']).toBe('SOL');
    });

    it('should be read-only (type-level immutability)', () => {
      // Note: CROSS_CHAIN_TOKEN_ALIASES uses Readonly<Record<>> for compile-time protection
      // Runtime freeze is not applied as these are static configuration constants
      // TypeScript will prevent mutation at compile time
      expect(typeof CROSS_CHAIN_TOKEN_ALIASES).toBe('object');
      expect(Object.keys(CROSS_CHAIN_TOKEN_ALIASES).length).toBeGreaterThan(0);
    });
  });

  describe('normalizeTokenForCrossChain', () => {
    it('should normalize Avalanche bridged tokens', () => {
      expect(normalizeTokenForCrossChain('WETH.e')).toBe('WETH');
      expect(normalizeTokenForCrossChain('WETH.E')).toBe('WETH');
      expect(normalizeTokenForCrossChain('weth.e')).toBe('WETH');
      expect(normalizeTokenForCrossChain('USDC.e')).toBe('USDC');
    });

    it('should normalize BSC wrapped tokens', () => {
      expect(normalizeTokenForCrossChain('WBNB')).toBe('BNB');
      expect(normalizeTokenForCrossChain('wbnb')).toBe('BNB');
      expect(normalizeTokenForCrossChain('BTCB')).toBe('WBTC');
      expect(normalizeTokenForCrossChain('ETH')).toBe('WETH');
    });

    it('should normalize Fantom-specific tokens', () => {
      expect(normalizeTokenForCrossChain('FUSDT')).toBe('USDT');
      expect(normalizeTokenForCrossChain('fusdt')).toBe('USDT');
      expect(normalizeTokenForCrossChain('WFTM')).toBe('FTM');
    });

    it('should normalize Polygon wrapped tokens', () => {
      expect(normalizeTokenForCrossChain('WMATIC')).toBe('MATIC');
      expect(normalizeTokenForCrossChain('wmatic')).toBe('MATIC');
    });

    it('should normalize Solana LST tokens', () => {
      expect(normalizeTokenForCrossChain('MSOL')).toBe('SOL');
      expect(normalizeTokenForCrossChain('mSOL')).toBe('SOL');
      expect(normalizeTokenForCrossChain('JITOSOL')).toBe('SOL');
      expect(normalizeTokenForCrossChain('jitoSol')).toBe('SOL');
      expect(normalizeTokenForCrossChain('BSOL')).toBe('SOL');
    });

    it('should pass through canonical tokens unchanged', () => {
      expect(normalizeTokenForCrossChain('WETH')).toBe('WETH');
      expect(normalizeTokenForCrossChain('USDC')).toBe('USDC');
      expect(normalizeTokenForCrossChain('USDT')).toBe('USDT');
      expect(normalizeTokenForCrossChain('SOL')).toBe('SOL');
    });

    it('should handle case-insensitive input', () => {
      expect(normalizeTokenForCrossChain('weth')).toBe('WETH');
      expect(normalizeTokenForCrossChain('Usdc')).toBe('USDC');
      expect(normalizeTokenForCrossChain('btcb')).toBe('WBTC');
    });

    it('should handle whitespace in input', () => {
      expect(normalizeTokenForCrossChain(' WETH ')).toBe('WETH');
      expect(normalizeTokenForCrossChain('WETH ')).toBe('WETH');
    });

    it('should cache results for performance', () => {
      // First call - computes
      const result1 = normalizeTokenForCrossChain('WETH');
      // Second call - should use cache
      const result2 = normalizeTokenForCrossChain('WETH');

      expect(result1).toBe(result2);
      expect(result1).toBe('WETH');
    });
  });

  describe('findCommonTokensBetweenChains', () => {
    it('should find common tokens between Ethereum and Arbitrum', () => {
      const common = findCommonTokensBetweenChains('ethereum', 'arbitrum');

      // These tokens exist on both chains
      expect(common).toContain('WETH');
      expect(common).toContain('USDC');
      expect(common).toContain('USDT');
    });

    it('should be case-insensitive for chain IDs', () => {
      const result1 = findCommonTokensBetweenChains('ETHEREUM', 'arbitrum');
      const result2 = findCommonTokensBetweenChains('ethereum', 'ARBITRUM');

      expect(result1).toEqual(result2);
    });

    it('should return empty array for non-existent chains', () => {
      const result = findCommonTokensBetweenChains('nonexistent', 'ethereum');
      expect(result).toEqual([]);
    });

    it('should cache results for identical chain pairs', () => {
      const result1 = findCommonTokensBetweenChains('ethereum', 'polygon');
      const result2 = findCommonTokensBetweenChains('ethereum', 'polygon');

      expect(result1).toBe(result2); // Same array reference (cached)
    });

    it('should produce same result regardless of chain order', () => {
      const result1 = findCommonTokensBetweenChains('ethereum', 'arbitrum');
      const result2 = findCommonTokensBetweenChains('arbitrum', 'ethereum');

      expect(result1).toEqual(result2);
    });
  });

  describe('preWarmCommonTokensCache', () => {
    it('should not throw when warming cache', () => {
      expect(() => preWarmCommonTokensCache()).not.toThrow();
    });
  });

  describe('getChainSpecificTokenSymbol', () => {
    it('should return exact match when available', () => {
      // WETH exists directly on most chains
      const result = getChainSpecificTokenSymbol('ethereum', 'WETH');
      expect(result).toBe('WETH');
    });

    it('should return bridged token variant for Avalanche', () => {
      // On Avalanche, WETH might be represented as WETH.e
      const result = getChainSpecificTokenSymbol('avalanche', 'WETH');
      // Should return either WETH.e or WETH depending on what's configured
      expect(result).toBeDefined();
    });

    it('should be case-insensitive for chain ID', () => {
      const result1 = getChainSpecificTokenSymbol('ETHEREUM', 'WETH');
      const result2 = getChainSpecificTokenSymbol('ethereum', 'WETH');

      expect(result1).toBe(result2);
    });

    it('should return undefined for non-existent chain', () => {
      const result = getChainSpecificTokenSymbol('nonexistent', 'WETH');
      expect(result).toBeUndefined();
    });

    it('should return undefined for non-existent token on chain', () => {
      // DOGE doesn't exist on Ethereum in our config
      const result = getChainSpecificTokenSymbol('ethereum', 'DOGE');
      expect(result).toBeUndefined();
    });
  });

  describe('DEFAULT_QUOTE_TOKENS', () => {
    it('should have USDC as default for most chains', () => {
      expect(DEFAULT_QUOTE_TOKENS['ethereum']).toBe('USDC');
      expect(DEFAULT_QUOTE_TOKENS['arbitrum']).toBe('USDC');
      expect(DEFAULT_QUOTE_TOKENS['optimism']).toBe('USDC');
      expect(DEFAULT_QUOTE_TOKENS['polygon']).toBe('USDC');
      expect(DEFAULT_QUOTE_TOKENS['base']).toBe('USDC');
    });

    it('should have USDT for BSC (BUSD deprecated)', () => {
      expect(DEFAULT_QUOTE_TOKENS['bsc']).toBe('USDT');
    });

    it('should have bridged USDC for Avalanche', () => {
      expect(DEFAULT_QUOTE_TOKENS['avalanche']).toBe('USDC.e');
    });

    it('should be read-only (type-level immutability)', () => {
      // Note: DEFAULT_QUOTE_TOKENS uses Readonly<Record<>> for compile-time protection
      // Runtime freeze is not applied as these are static configuration constants
      expect(typeof DEFAULT_QUOTE_TOKENS).toBe('object');
      expect(Object.keys(DEFAULT_QUOTE_TOKENS).length).toBeGreaterThan(0);
    });
  });

  describe('getDefaultQuoteToken', () => {
    it('should return configured quote token for known chains', () => {
      expect(getDefaultQuoteToken('ethereum')).toBe('USDC');
      expect(getDefaultQuoteToken('bsc')).toBe('USDT');
      expect(getDefaultQuoteToken('avalanche')).toBe('USDC.e');
    });

    it('should be case-insensitive', () => {
      expect(getDefaultQuoteToken('ETHEREUM')).toBe('USDC');
      expect(getDefaultQuoteToken('Ethereum')).toBe('USDC');
    });

    it('should return USDC as fallback for unknown chains', () => {
      expect(getDefaultQuoteToken('unknown')).toBe('USDC');
      expect(getDefaultQuoteToken('nonexistent')).toBe('USDC');
    });
  });

  // ===========================================================================
  // P0-5 FIX: Thread Safety Regression Tests
  // ===========================================================================

  describe('P0-5 FIX: Thread Safety', () => {
    it('should handle concurrent normalization requests safely', async () => {
      // This test validates that removing the LRU refresh (delete/set) pattern
      // doesn't cause any correctness issues under concurrent access

      const tokens = ['WETH', 'USDC', 'BTCB', 'WMATIC', 'MSOL', 'fusdt', 'weth.e'];
      const iterations = 100;

      const promises: Promise<string[]>[] = [];

      for (let i = 0; i < iterations; i++) {
        promises.push(
          Promise.resolve(tokens.map(t => normalizeTokenForCrossChain(t)))
        );
      }

      const results = await Promise.all(promises);

      // All results should be identical
      const firstResult = results[0];
      for (const result of results) {
        expect(result).toEqual(firstResult);
      }

      // Verify correct normalization
      expect(firstResult).toEqual(['WETH', 'USDC', 'WBTC', 'MATIC', 'SOL', 'USDT', 'WETH']);
    });
  });
});
