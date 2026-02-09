/**
 * DexLookupService Tests
 *
 * Tests O(1) Map-based DEX and router lookups.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { DexLookupService } from '../../dex-lookup.service';

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
      expect(router).toBe('0xE592427A0AEce92De3Edee1F18E0157C05861564');
    });

    it('should be case-insensitive', () => {
      const router1 = service.getRouterAddress('ethereum', 'UNISWAP_V3');
      const router2 = service.getRouterAddress('ethereum', 'uniswap_v3');
      expect(router1).toBe(router2);
      expect(router1).toBeDefined();
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
});
