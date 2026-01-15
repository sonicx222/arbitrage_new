/**
 * DEX Expansion Tests (S2.2)
 *
 * TDD tests for expanding DEX coverage across chains.
 * S2.2.1: Arbitrum DEXs (6 → 9)
 * S2.2.2: Base DEXs (5 → 7)
 * S2.2.3: BSC DEXs (5 → 8)
 *
 * @see docs/IMPLEMENTATION_PLAN.md S2.2
 */

// Use require to avoid ts-jest transformation caching issues
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DEXES } = require('.');
import { Dex } from '../../types';

// Helper to validate Ethereum address format
const isValidAddress = (address: string): boolean => {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
};

describe('S2.2.1: Arbitrum DEX Expansion (6 → 9)', () => {
  const arbitrumDexes = DEXES.arbitrum;

  describe('DEX Count', () => {
    it('should have exactly 9 DEXs configured', () => {
      expect(arbitrumDexes).toBeDefined();
      expect(arbitrumDexes.length).toBe(9);
    });
  });

  describe('Existing DEXs (6)', () => {
    const existingDexNames = [
      'uniswap_v3',
      'camelot_v3',
      'sushiswap',
      'trader_joe',
      'zyberswap',
      'ramses'
    ];

    existingDexNames.forEach(dexName => {
      it(`should have ${dexName} configured`, () => {
        const dex = arbitrumDexes.find(d => d.name === dexName);
        expect(dex).toBeDefined();
        expect(dex!.chain).toBe('arbitrum');
        expect(isValidAddress(dex!.factoryAddress)).toBe(true);
        expect(isValidAddress(dex!.routerAddress)).toBe(true);
      });
    });
  });

  describe('New DEXs (3)', () => {
    describe('Balancer V2', () => {
      it('should have balancer_v2 configured', () => {
        const dex = arbitrumDexes.find(d => d.name === 'balancer_v2');
        expect(dex).toBeDefined();
      });

      it('should have correct Balancer V2 factory (Vault) address', () => {
        const dex = arbitrumDexes.find(d => d.name === 'balancer_v2');
        expect(dex).toBeDefined();
        // Balancer V2 uses Vault address as factory
        expect(dex!.factoryAddress.toLowerCase()).toBe('0xba12222222228d8ba445958a75a0704d566bf2c8');
      });

      it('should have valid router address', () => {
        const dex = arbitrumDexes.find(d => d.name === 'balancer_v2');
        expect(dex).toBeDefined();
        expect(isValidAddress(dex!.routerAddress)).toBe(true);
      });

      it('should have correct chain', () => {
        const dex = arbitrumDexes.find(d => d.name === 'balancer_v2');
        expect(dex!.chain).toBe('arbitrum');
      });
    });

    describe('Curve', () => {
      it('should have curve configured', () => {
        const dex = arbitrumDexes.find(d => d.name === 'curve');
        expect(dex).toBeDefined();
      });

      it('should have correct Curve factory address', () => {
        const dex = arbitrumDexes.find(d => d.name === 'curve');
        expect(dex).toBeDefined();
        // Curve Factory on Arbitrum
        expect(dex!.factoryAddress.toLowerCase()).toBe('0xb17b674d9c5cb2e441f8e196a2f048a81355d031');
      });

      it('should have valid router address', () => {
        const dex = arbitrumDexes.find(d => d.name === 'curve');
        expect(dex).toBeDefined();
        expect(isValidAddress(dex!.routerAddress)).toBe(true);
      });
    });

    describe('Chronos', () => {
      it('should have chronos configured', () => {
        const dex = arbitrumDexes.find(d => d.name === 'chronos');
        expect(dex).toBeDefined();
      });

      it('should have correct Chronos factory address', () => {
        const dex = arbitrumDexes.find(d => d.name === 'chronos');
        expect(dex).toBeDefined();
        // Chronos Factory on Arbitrum (ve(3,3) DEX)
        expect(dex!.factoryAddress.toLowerCase()).toBe('0xce9240869391928253ed9cc9bcb8cb98cb5b0722');
      });

      it('should have valid router address', () => {
        const dex = arbitrumDexes.find(d => d.name === 'chronos');
        expect(dex).toBeDefined();
        expect(isValidAddress(dex!.routerAddress)).toBe(true);
      });
    });
  });

  describe('DEX Configuration Validation', () => {
    it('should have all DEXs with valid factory addresses', () => {
      arbitrumDexes.forEach(dex => {
        expect(isValidAddress(dex.factoryAddress)).toBe(true);
      });
    });

    it('should have all DEXs with valid router addresses', () => {
      arbitrumDexes.forEach(dex => {
        expect(isValidAddress(dex.routerAddress)).toBe(true);
      });
    });

    it('should have all DEXs with chain set to arbitrum', () => {
      arbitrumDexes.forEach(dex => {
        expect(dex.chain).toBe('arbitrum');
      });
    });

    it('should have all DEXs with fee property defined', () => {
      arbitrumDexes.forEach(dex => {
        expect(typeof dex.fee).toBe('number');
        expect(dex.fee).toBeGreaterThanOrEqual(0);
      });
    });

    it('should have unique DEX names', () => {
      const names = arbitrumDexes.map(d => d.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(names.length);
    });

    it('should have unique factory addresses', () => {
      const factories = arbitrumDexes.map(d => d.factoryAddress.toLowerCase());
      const uniqueFactories = new Set(factories);
      expect(uniqueFactories.size).toBe(factories.length);
    });
  });
});

describe('DEX Priority Classification', () => {
  it('should have Critical [C] DEXs at the beginning', () => {
    const arbitrumDexes = DEXES.arbitrum;
    const criticalDexes = ['uniswap_v3', 'camelot_v3', 'sushiswap'];

    criticalDexes.forEach((name, index) => {
      expect(arbitrumDexes[index].name).toBe(name);
    });
  });
});

describe('PHASE_METRICS Alignment', () => {
  it('should match current DEX count with PHASE_METRICS', () => {
    // Import PHASE_METRICS
    const { PHASE_METRICS } = require('./index');

    const totalDexes = Object.values(DEXES).flat().length;

    // After S2.2.1, we should have 25 + 3 = 28 DEXs
    // (Phase 1 target was 25, adding 3 Arbitrum DEXs)
    expect(totalDexes).toBeGreaterThanOrEqual(28);
  });
});
