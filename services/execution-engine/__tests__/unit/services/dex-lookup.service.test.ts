/**
 * DexLookupService Tests
 *
 * Tests O(1) Map-based DEX and router lookups.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { DexLookupService } from '../../../src/services/dex-lookup.service';

describe('DexLookupService', () => {
  let service: DexLookupService;

  beforeEach(() => {
    service = new DexLookupService();
  });

  describe('initialization', () => {
    it('should initialize caches for all chains', () => {
      expect(service.hasChain('ethereum')).toBe(true);
      expect(service.hasChain('arbitrum')).toBe(true);
      expect(service.hasChain('bsc')).toBe(true);
      expect(service.hasChain('unknown_chain')).toBe(false);
    });
  });

  describe('getRouterAddress', () => {
    it('should return router address for valid DEX', () => {
      const router = service.getRouterAddress('ethereum', 'uniswap_v3');
      expect(router).toBe('0xe592427a0aece92de3edee1f18e0157c05861564');
    });

    it('should be case-insensitive', () => {
      const router1 = service.getRouterAddress('ethereum', 'UNISWAP_V3');
      const router2 = service.getRouterAddress('ethereum', 'uniswap_v3');
      expect(router1).toBe(router2);
      expect(router1).toBeDefined();
    });

    it('should return consistently lowercase addresses', () => {
      const router1 = service.getRouterAddress('ethereum', 'uniswap_v3');
      const router2 = service.getRouterAddress('ethereum', 'UNISWAP_V3');

      // Addresses should be consistently lowercase
      expect(router1).toBe(router1?.toLowerCase());
      expect(router2).toBe(router2?.toLowerCase());
      expect(router1).toBe(router2);
    });

    it('should return undefined for unknown DEX', () => {
      const router = service.getRouterAddress('ethereum', 'unknown_dex');
      expect(router).toBeUndefined();
    });

    it('should return undefined for unknown chain', () => {
      const router = service.getRouterAddress('unknown_chain', 'uniswap_v3');
      expect(router).toBeUndefined();
    });
  });

  describe('getDexByName', () => {
    it('should return full DEX config by name', () => {
      const dex = service.getDexByName('ethereum', 'uniswap_v3');
      expect(dex).toBeDefined();
      expect(dex?.name).toBe('uniswap_v3');
      expect(dex?.chain).toBe('ethereum');
      expect(dex?.routerAddress).toBe('0xe592427a0aece92de3edee1f18e0157c05861564');
    });

    it('should be case-insensitive', () => {
      const dex1 = service.getDexByName('ethereum', 'UNISWAP_V3');
      const dex2 = service.getDexByName('ethereum', 'uniswap_v3');
      expect(dex1).toBe(dex2);
    });

    it('should return undefined for unknown DEX', () => {
      const dex = service.getDexByName('ethereum', 'unknown_dex');
      expect(dex).toBeUndefined();
    });
  });

  describe('findDexByRouter', () => {
    it('should reverse lookup DEX by router address', () => {
      const dex = service.findDexByRouter('ethereum', '0xE592427A0AEce92De3Edee1F18E0157C05861564');
      expect(dex).toBeDefined();
      expect(dex?.name).toBe('uniswap_v3');
      expect(dex?.routerAddress).toBe('0xe592427a0aece92de3edee1f18e0157c05861564');
    });

    it('should be case-insensitive for addresses', () => {
      const dex1 = service.findDexByRouter('ethereum', '0xE592427A0AEce92De3Edee1F18E0157C05861564');
      const dex2 = service.findDexByRouter('ethereum', '0xe592427a0aece92de3edee1f18e0157c05861564');
      expect(dex1).toBe(dex2);
    });

    it('should return undefined for unknown router', () => {
      const dex = service.findDexByRouter('ethereum', '0x0000000000000000000000000000000000000000');
      expect(dex).toBeUndefined();
    });
  });

  describe('getAllDexesForChain', () => {
    it('should return all DEXes for a chain', () => {
      const dexes = service.getAllDexesForChain('ethereum');
      expect(Array.isArray(dexes)).toBe(true);
      expect(dexes.length).toBeGreaterThan(0);
    });

    it('should return empty array for unknown chain', () => {
      const dexes = service.getAllDexesForChain('unknown_chain');
      expect(Array.isArray(dexes)).toBe(true);
      expect(dexes.length).toBe(0);
    });
  });

  describe('isValidRouter', () => {
    it('should return true for valid router', () => {
      const valid = service.isValidRouter('ethereum', '0xE592427A0AEce92De3Edee1F18E0157C05861564');
      expect(valid).toBe(true);
    });

    it('should return false for invalid router', () => {
      const valid = service.isValidRouter('ethereum', '0x0000000000000000000000000000000000000000');
      expect(valid).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle whitespace in DEX names', () => {
      const dex1 = service.getDexByName('ethereum', '  uniswap_v3  ');
      const dex2 = service.getDexByName('ethereum', 'uniswap_v3');
      expect(dex1).toBe(dex2);
      expect(dex1).toBeDefined();
    });

    it('should return only enabled DEXes in getAllDexesForChain', () => {
      const dexes = service.getAllDexesForChain('solana');
      // Jupiter is disabled (enabled: false) - should not appear
      const jupiterDex = dexes.find(d => d.name === 'jupiter');
      expect(jupiterDex).toBeUndefined();
    });

    it('should return consistent address casing across all methods', () => {
      const router = service.getRouterAddress('ethereum', 'uniswap_v3');
      const dex = service.getDexByName('ethereum', 'uniswap_v3');
      const foundDex = service.findDexByRouter('ethereum', '0xE592427A0AEce92De3Edee1F18E0157C05861564');

      // All router addresses should be consistently lowercase
      expect(router).toBe(router?.toLowerCase());
      expect(dex?.routerAddress).toBe(dex?.routerAddress.toLowerCase());
      expect(foundDex?.routerAddress).toBe(foundDex?.routerAddress.toLowerCase());
    });
  });

  describe('performance', () => {
    it('should perform O(1) lookups in <0.01ms', () => {
      const iterations = 10000;
      const start = performance.now();

      for (let i = 0; i < iterations; i++) {
        service.getRouterAddress('ethereum', 'uniswap_v3');
      }

      const elapsed = performance.now() - start;
      const avgMs = elapsed / iterations;

      // Should be < 0.01ms per lookup (O(1) Map access)
      expect(avgMs).toBeLessThan(0.01);
    });

    it('should handle all 49 DEXes across 11 chains', () => {
      // Test a representative sample from each chain
      const testCases = [
        { chain: 'ethereum', dex: 'uniswap_v3' },
        { chain: 'arbitrum', dex: 'camelot_v3' },
        { chain: 'bsc', dex: 'pancakeswap_v3' },
        { chain: 'base', dex: 'aerodrome' },
        { chain: 'polygon', dex: 'quickswap_v3' },
        { chain: 'optimism', dex: 'velodrome' },
        { chain: 'avalanche', dex: 'trader_joe_v2' },
        { chain: 'fantom', dex: 'spookyswap' },
        { chain: 'zksync', dex: 'syncswap' },
        { chain: 'linea', dex: 'syncswap' },
        { chain: 'solana', dex: 'raydium' }
      ];

      for (const { chain, dex } of testCases) {
        const router = service.getRouterAddress(chain, dex);
        expect(router).toBeDefined();
        expect(typeof router).toBe('string');
        // EVM addresses (0x + 40 hex chars) or Solana addresses (32-44 base58 chars, case-insensitive)
        expect(router).toMatch(/^(0x[a-f0-9]{40}|[1-9a-hj-np-za-km-z]{32,44})$/i);
      }
    });
  });
});
