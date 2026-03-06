/**
 * Tests for consolidated flash loan provider descriptors.
 *
 * Validates that per-protocol descriptors correctly reference addresses,
 * chains, and fees, and that the aggregator functions derive the right data.
 */
import { describe, it, expect } from '@jest/globals';
import {
  ALL_PROVIDERS,
  PROVIDER_BY_PROTOCOL,
  getProviderDescriptor,
  getActiveProviders,
  getProvidersByStatus,
  AAVE_V3_PROVIDER,
  BALANCER_V2_PROVIDER,
  PANCAKESWAP_V3_PROVIDER,
  SYNCSWAP_PROVIDER,
  DAI_FLASH_MINT_PROVIDER,
  MORPHO_PROVIDER,
  SPOOKYSWAP_PROVIDER,
} from '../../src/flash-loan-providers';
import { AAVE_V3_POOLS, BALANCER_V2_VAULTS, SYNCSWAP_VAULTS } from '../../src/addresses';
import { isProtocolSupported } from '../../src/flash-loan-availability';

describe('flash-loan-providers', () => {
  describe('ALL_PROVIDERS', () => {
    it('should have 7 providers', () => {
      expect(ALL_PROVIDERS).toHaveLength(7);
    });

    it('should have unique protocol names', () => {
      const protocols = ALL_PROVIDERS.map(p => p.protocol);
      expect(new Set(protocols).size).toBe(protocols.length);
    });

    it('each provider should have non-negative feeBps', () => {
      for (const p of ALL_PROVIDERS) {
        expect(p.feeBps).toBeGreaterThanOrEqual(0);
      }
    });

    it('each provider should have a valid status', () => {
      for (const p of ALL_PROVIDERS) {
        expect(['active', 'deferred', 'stub']).toContain(p.status);
      }
    });
  });

  describe('AAVE_V3_PROVIDER', () => {
    it('should reference AAVE_V3_POOLS addresses', () => {
      expect(AAVE_V3_PROVIDER.addresses).toBe(AAVE_V3_POOLS);
    });

    it('should have 9 bps fee', () => {
      expect(AAVE_V3_PROVIDER.feeBps).toBe(9);
    });

    it('should cover 7 mainnet chains', () => {
      expect(AAVE_V3_PROVIDER.chains).toContain('ethereum');
      expect(AAVE_V3_PROVIDER.chains).toContain('polygon');
      expect(AAVE_V3_PROVIDER.chains).toContain('arbitrum');
      expect(AAVE_V3_PROVIDER.chains).toContain('scroll');
      expect(AAVE_V3_PROVIDER.chains).toHaveLength(7);
    });

    it('should be active', () => {
      expect(AAVE_V3_PROVIDER.status).toBe('active');
    });
  });

  describe('BALANCER_V2_PROVIDER', () => {
    it('should reference BALANCER_V2_VAULTS addresses', () => {
      expect(BALANCER_V2_PROVIDER.addresses).toBe(BALANCER_V2_VAULTS);
    });

    it('should have 0 bps fee', () => {
      expect(BALANCER_V2_PROVIDER.feeBps).toBe(0);
    });

    it('should include fantom (Beethoven X)', () => {
      expect(BALANCER_V2_PROVIDER.chains).toContain('fantom');
    });

    it('should be deferred until BalancerV2FlashArbitrage.sol is multi-chain deployed', () => {
      expect(BALANCER_V2_PROVIDER.status).toBe('deferred');
      expect(BALANCER_V2_PROVIDER.deferredReason).toBeTruthy();
    });
  });

  describe('SYNCSWAP_PROVIDER', () => {
    it('should reference SYNCSWAP_VAULTS addresses', () => {
      expect(SYNCSWAP_PROVIDER.addresses).toBe(SYNCSWAP_VAULTS);
    });

    it('should cover zksync and scroll', () => {
      expect(SYNCSWAP_PROVIDER.chains).toEqual(expect.arrayContaining(['zksync', 'scroll']));
    });
  });

  describe('DAI_FLASH_MINT_PROVIDER', () => {
    it('should be ethereum-only', () => {
      expect(DAI_FLASH_MINT_PROVIDER.chains).toEqual(['ethereum']);
    });

    it('should have 1 bps fee', () => {
      expect(DAI_FLASH_MINT_PROVIDER.feeBps).toBe(1);
    });
  });

  describe('MORPHO_PROVIDER', () => {
    it('should be deferred', () => {
      expect(MORPHO_PROVIDER.status).toBe('deferred');
    });

    it('should have a deferred reason', () => {
      expect(MORPHO_PROVIDER.deferredReason).toBeTruthy();
    });
  });

  describe('SPOOKYSWAP_PROVIDER', () => {
    it('should be a stub with no chains', () => {
      expect(SPOOKYSWAP_PROVIDER.status).toBe('stub');
      expect(SPOOKYSWAP_PROVIDER.chains).toHaveLength(0);
    });
  });

  describe('PROVIDER_BY_PROTOCOL', () => {
    it('should have O(1) lookup for all 7 protocols', () => {
      expect(PROVIDER_BY_PROTOCOL.size).toBe(7);
      expect(PROVIDER_BY_PROTOCOL.get('aave_v3')).toBe(AAVE_V3_PROVIDER);
      expect(PROVIDER_BY_PROTOCOL.get('balancer_v2')).toBe(BALANCER_V2_PROVIDER);
      expect(PROVIDER_BY_PROTOCOL.get('pancakeswap_v3')).toBe(PANCAKESWAP_V3_PROVIDER);
      expect(PROVIDER_BY_PROTOCOL.get('syncswap')).toBe(SYNCSWAP_PROVIDER);
      expect(PROVIDER_BY_PROTOCOL.get('dai_flash_mint')).toBe(DAI_FLASH_MINT_PROVIDER);
      expect(PROVIDER_BY_PROTOCOL.get('morpho')).toBe(MORPHO_PROVIDER);
      expect(PROVIDER_BY_PROTOCOL.get('spookyswap')).toBe(SPOOKYSWAP_PROVIDER);
    });
  });

  describe('getProviderDescriptor', () => {
    it('should return descriptor for valid protocol', () => {
      expect(getProviderDescriptor('aave_v3')).toBe(AAVE_V3_PROVIDER);
    });

    it('should return undefined for unknown protocol', () => {
      expect(getProviderDescriptor('nonexistent' as any)).toBeUndefined();
    });
  });

  describe('getActiveProviders', () => {
    it('should exclude deferred and stub providers', () => {
      const active = getActiveProviders();
      for (const p of active) {
        expect(p.status).toBe('active');
      }
      expect(active).not.toContainEqual(expect.objectContaining({ protocol: 'morpho' }));
      expect(active).not.toContainEqual(expect.objectContaining({ protocol: 'spookyswap' }));
      expect(active).not.toContainEqual(expect.objectContaining({ protocol: 'balancer_v2' }));
    });
  });

  describe('getProvidersByStatus', () => {
    it('should return deferred providers', () => {
      // Strict count guard: adding a deferred provider requires updating this test.
      const deferred = getProvidersByStatus('deferred');
      expect(deferred).toHaveLength(2);
      const protocols = deferred.map(p => p.protocol);
      expect(protocols).toContain('morpho');
      expect(protocols).toContain('balancer_v2');
    });

    it('should return stub providers', () => {
      // Strict count guard: adding a stub provider requires updating this test.
      const stubs = getProvidersByStatus('stub');
      expect(stubs).toHaveLength(1);
      expect(stubs[0].protocol).toBe('spookyswap');
    });
  });

  describe('cross-validation with FLASH_LOAN_AVAILABILITY', () => {
    it('active provider chains should all be enabled in FLASH_LOAN_AVAILABILITY', () => {
      // Deferred/stub providers are intentionally excluded: their chains may exist on-chain
      // but our arbitrage contracts are not deployed there yet.
      const active = getActiveProviders();
      for (const p of active) {
        for (const chain of p.chains) {
          expect(isProtocolSupported(chain, p.protocol)).toBe(true);
        }
      }
    });
  });

  describe('address consistency with availability matrix', () => {
    it('aave_v3 chains should all have addresses in AAVE_V3_POOLS', () => {
      for (const chain of AAVE_V3_PROVIDER.chains) {
        expect(AAVE_V3_PROVIDER.addresses[chain]).toBeTruthy();
      }
    });

    it('balancer_v2 chains should all have addresses in BALANCER_V2_VAULTS', () => {
      for (const chain of BALANCER_V2_PROVIDER.chains) {
        expect(BALANCER_V2_PROVIDER.addresses[chain]).toBeTruthy();
      }
    });

    it('syncswap chains should all have addresses in SYNCSWAP_VAULTS', () => {
      for (const chain of SYNCSWAP_PROVIDER.chains) {
        expect(SYNCSWAP_PROVIDER.addresses[chain]).toBeTruthy();
      }
    });
  });
});
