import {
  FLASH_LOAN_PROVIDER_REGISTRY,
  getProvidersForChain,
  type FlashLoanProviderEntry,
} from '../../src/flash-loan-providers/multi-provider-registry';
import { FLASH_LOAN_PROVIDERS } from '../../src/service-config';
import { AAVE_V3_POOLS, BALANCER_V2_VAULTS, DSS_FLASH_ADDRESSES, PANCAKESWAP_V3_FACTORIES, SYNCSWAP_VAULTS } from '../../src/addresses';

describe('Multi-Provider Registry', () => {
  describe('FLASH_LOAN_PROVIDER_REGISTRY', () => {
    it('has at least one provider for every registry chain', () => {
      for (const [chain, providers] of Object.entries(FLASH_LOAN_PROVIDER_REGISTRY)) {
        expect(providers.length).toBeGreaterThanOrEqual(1);
      }
    });

    it('registry chains are subset of FLASH_LOAN_PROVIDERS chains (excluding mode/blast with zero availability)', () => {
      const flpChains = new Set(Object.keys(FLASH_LOAN_PROVIDERS));
      for (const chain of Object.keys(FLASH_LOAN_PROVIDER_REGISTRY)) {
        // linea is in registry via PancakeSwap V3 but not in legacy single-provider map
        if (chain === 'linea') continue;
        expect(flpChains.has(chain)).toBe(true);
      }
    });

    it('has multiple providers for ethereum, arbitrum, base, zksync, scroll', () => {
      const multiChains = ['ethereum', 'arbitrum', 'base', 'zksync', 'scroll'];
      for (const chain of multiChains) {
        expect(FLASH_LOAN_PROVIDER_REGISTRY[chain].length).toBeGreaterThanOrEqual(2);
      }
    });

    it('has scroll with both aave_v3 and syncswap', () => {
      const scrollProviders = FLASH_LOAN_PROVIDER_REGISTRY['scroll'];
      const protocols = scrollProviders.map(p => p.protocol);
      expect(protocols).toContain('aave_v3');
      expect(protocols).toContain('syncswap');
    });

    it('multi-provider chains have distinct protocols', () => {
      for (const [chain, providers] of Object.entries(FLASH_LOAN_PROVIDER_REGISTRY)) {
        const protocols = providers.map(p => p.protocol);
        const unique = new Set(protocols);
        expect(unique.size).toBe(protocols.length);
      }
    });

    it('all fee values are non-negative integers', () => {
      for (const [, providers] of Object.entries(FLASH_LOAN_PROVIDER_REGISTRY)) {
        for (const p of providers) {
          expect(p.feeBps).toBeGreaterThanOrEqual(0);
          expect(Number.isInteger(p.feeBps)).toBe(true);
        }
      }
    });

    it('all addresses are valid hex strings', () => {
      for (const [, providers] of Object.entries(FLASH_LOAN_PROVIDER_REGISTRY)) {
        for (const p of providers) {
          expect(p.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
        }
      }
    });

    it('Aave V3 addresses match AAVE_V3_POOLS', () => {
      for (const [chain, providers] of Object.entries(FLASH_LOAN_PROVIDER_REGISTRY)) {
        const aave = providers.find(p => p.protocol === 'aave_v3');
        if (aave) {
          expect(aave.address).toBe(AAVE_V3_POOLS[chain]);
        }
      }
    });

    it('Balancer V2 addresses match BALANCER_V2_VAULTS', () => {
      for (const [chain, providers] of Object.entries(FLASH_LOAN_PROVIDER_REGISTRY)) {
        const bal = providers.find(p => p.protocol === 'balancer_v2');
        if (bal) {
          expect(bal.address).toBe(BALANCER_V2_VAULTS[chain]);
        }
      }
    });

    it('DAI Flash Mint addresses match DSS_FLASH_ADDRESSES', () => {
      for (const [chain, providers] of Object.entries(FLASH_LOAN_PROVIDER_REGISTRY)) {
        const dai = providers.find(p => p.protocol === 'dai_flash_mint');
        if (dai) {
          expect(dai.address).toBe(DSS_FLASH_ADDRESSES[chain]);
        }
      }
    });

    it('PancakeSwap V3 addresses match PANCAKESWAP_V3_FACTORIES', () => {
      for (const [chain, providers] of Object.entries(FLASH_LOAN_PROVIDER_REGISTRY)) {
        const ps = providers.find(p => p.protocol === 'pancakeswap_v3');
        if (ps) {
          expect(ps.address).toBe(PANCAKESWAP_V3_FACTORIES[chain]);
        }
      }
    });

    it('ethereum has dai_flash_mint provider (H-01b)', () => {
      const eth = FLASH_LOAN_PROVIDER_REGISTRY['ethereum'];
      expect(eth.find(p => p.protocol === 'dai_flash_mint')).toBeDefined();
    });

    it('linea has pancakeswap_v3 provider (H-01c)', () => {
      const linea = FLASH_LOAN_PROVIDER_REGISTRY['linea'];
      expect(linea).toBeDefined();
      expect(linea.find(p => p.protocol === 'pancakeswap_v3')).toBeDefined();
    });

    it('zksync has both pancakeswap_v3 and syncswap (H-01c)', () => {
      const zk = FLASH_LOAN_PROVIDER_REGISTRY['zksync'];
      expect(zk.find(p => p.protocol === 'pancakeswap_v3')).toBeDefined();
      expect(zk.find(p => p.protocol === 'syncswap')).toBeDefined();
    });

    it('providers are sorted by feeBps ascending within each chain', () => {
      for (const [, providers] of Object.entries(FLASH_LOAN_PROVIDER_REGISTRY)) {
        for (let i = 1; i < providers.length; i++) {
          expect(providers[i].feeBps).toBeGreaterThanOrEqual(providers[i - 1].feeBps);
        }
      }
    });
  });

  describe('getProvidersForChain', () => {
    it('returns providers for known chain', () => {
      const providers = getProvidersForChain('ethereum');
      expect(providers.length).toBeGreaterThanOrEqual(1);
    });

    it('returns empty array for unknown chain', () => {
      expect(getProvidersForChain('nonexistent')).toEqual([]);
    });

    it('returns frozen array (immutable)', () => {
      const providers = getProvidersForChain('ethereum');
      expect(Object.isFrozen(providers)).toBe(true);
    });
  });
});
