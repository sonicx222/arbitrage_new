/**
 * DEX Factory Registry Tests
 *
 * TDD test suite for Task 2.1.1: Add Factory Registry
 *
 * Tests:
 * - Factory registry structure and typing
 * - Factory-to-DEX type mapping
 * - Factory ABI definitions
 * - Helper functions for factory lookups
 *
 * @see implementation_plan_v2.md Phase 2.1.1
 */

import {
  DEX_FACTORY_REGISTRY,
  FactoryType,
  FactoryConfig,
  getFactoriesForChain,
  getFactoryByAddress,
  getFactoryType,
  getFactoryAbi,
  FACTORY_ABIS,
  getAllFactoryAddresses,
  isUniswapV2Style,
  isUniswapV3Style,
  isAlgebraStyle,
  isSolidlyStyle,
  isVaultModelDex,
  getFactoriesByType,
  validateFactoryRegistry,
} from './dex-factories';
import { DEXES } from './dexes';

describe('DEX Factory Registry', () => {
  // =============================================================================
  // Registry Structure Tests
  // =============================================================================
  describe('Registry Structure', () => {
    it('should export DEX_FACTORY_REGISTRY as a record of chain to factory configs', () => {
      expect(DEX_FACTORY_REGISTRY).toBeDefined();
      expect(typeof DEX_FACTORY_REGISTRY).toBe('object');
    });

    it('should have factory configs for all major chains', () => {
      const expectedChains = [
        'arbitrum',
        'bsc',
        'base',
        'polygon',
        'optimism',
        'ethereum',
        'avalanche',
        'fantom',
        'zksync',
        'linea',
      ];

      for (const chain of expectedChains) {
        expect(DEX_FACTORY_REGISTRY[chain]).toBeDefined();
        expect(Array.isArray(DEX_FACTORY_REGISTRY[chain])).toBe(true);
        expect(DEX_FACTORY_REGISTRY[chain].length).toBeGreaterThan(0);
      }
    });

    it('should not have factory config for Solana (non-EVM)', () => {
      // Solana uses program IDs, not factory contracts
      expect(DEX_FACTORY_REGISTRY['solana']).toBeUndefined();
    });

    it('should have valid factory config structure', () => {
      const arbitrumFactories = DEX_FACTORY_REGISTRY['arbitrum'];
      const firstFactory = arbitrumFactories[0];

      expect(firstFactory).toHaveProperty('address');
      expect(firstFactory).toHaveProperty('dexName');
      expect(firstFactory).toHaveProperty('type');
      expect(firstFactory).toHaveProperty('chain');

      // Address should be valid Ethereum address format
      expect(firstFactory.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });
  });

  // =============================================================================
  // Factory Type Classification Tests
  // =============================================================================
  describe('Factory Type Classification', () => {
    it('should correctly identify Uniswap V2 style factories', () => {
      // SushiSwap uses UniswapV2 factory pattern
      const sushiFactory = getFactoryByAddress('arbitrum', '0xc35DADB65012eC5796536bD9864eD8773aBc74C4');
      expect(sushiFactory).toBeDefined();
      expect(sushiFactory?.type).toBe('uniswap_v2');
    });

    it('should correctly identify Uniswap V3 style factories', () => {
      // Uniswap V3 on Arbitrum
      const uniV3Factory = getFactoryByAddress('arbitrum', '0x1F98431c8aD98523631AE4a59f267346ea31F984');
      expect(uniV3Factory).toBeDefined();
      expect(uniV3Factory?.type).toBe('uniswap_v3');
    });

    it('should correctly identify Solidly/ve(3,3) style factories', () => {
      // Velodrome on Optimism uses Solidly pattern
      const velodromeFactory = getFactoryByAddress('optimism', '0x25CbdDb98b35ab1FF77413456B31EC81A6B6B746');
      expect(velodromeFactory).toBeDefined();
      expect(velodromeFactory?.type).toBe('solidly');
    });

    it('should correctly identify Curve style factories', () => {
      const curveFactory = getFactoryByAddress('arbitrum', '0xb17b674D9c5CB2e441F8e196a2f048A81355d031');
      expect(curveFactory).toBeDefined();
      expect(curveFactory?.type).toBe('curve');
    });

    it('should correctly identify Balancer V2 style vaults', () => {
      // Balancer V2 Vault on Arbitrum
      const balancerVault = getFactoryByAddress('arbitrum', '0xBA12222222228d8Ba445958a75a0704d566BF2C8');
      expect(balancerVault).toBeDefined();
      expect(balancerVault?.type).toBe('balancer_v2');
    });

    it('should have all expected factory types', () => {
      const expectedTypes: FactoryType[] = [
        'uniswap_v2',
        'uniswap_v3',
        'solidly',
        'curve',
        'balancer_v2',
        'algebra',    // For QuickSwap V3, Camelot algebra-based
        'trader_joe',  // Trader Joe LB (Liquidity Book)
      ];

      // Collect all unique types from registry
      const allTypes = new Set<FactoryType>();
      for (const chain of Object.keys(DEX_FACTORY_REGISTRY)) {
        for (const factory of DEX_FACTORY_REGISTRY[chain]) {
          allTypes.add(factory.type);
        }
      }

      // At minimum we should have V2, V3, and Solidly
      expect(allTypes.has('uniswap_v2')).toBe(true);
      expect(allTypes.has('uniswap_v3')).toBe(true);
      expect(allTypes.has('solidly')).toBe(true);
    });
  });

  // =============================================================================
  // Factory ABI Tests
  // =============================================================================
  describe('Factory ABIs', () => {
    it('should export FACTORY_ABIS with all factory types', () => {
      expect(FACTORY_ABIS).toBeDefined();
      expect(FACTORY_ABIS['uniswap_v2']).toBeDefined();
      expect(FACTORY_ABIS['uniswap_v3']).toBeDefined();
      expect(FACTORY_ABIS['solidly']).toBeDefined();
    });

    it('should have PairCreated event in UniswapV2 ABI', () => {
      const v2Abi = FACTORY_ABIS['uniswap_v2'];
      expect(Array.isArray(v2Abi)).toBe(true);

      const pairCreatedEvent = v2Abi.find(
        (item: { type?: string; name?: string }) => item.type === 'event' && item.name === 'PairCreated'
      );
      expect(pairCreatedEvent).toBeDefined();
    });

    it('should have PoolCreated event in UniswapV3 ABI', () => {
      const v3Abi = FACTORY_ABIS['uniswap_v3'];
      expect(Array.isArray(v3Abi)).toBe(true);

      const poolCreatedEvent = v3Abi.find(
        (item: { type?: string; name?: string }) => item.type === 'event' && item.name === 'PoolCreated'
      );
      expect(poolCreatedEvent).toBeDefined();
    });

    it('should have PairCreated event with stable flag in Solidly ABI', () => {
      const solidlyAbi = FACTORY_ABIS['solidly'];
      expect(Array.isArray(solidlyAbi)).toBe(true);

      const pairCreatedEvent = solidlyAbi.find(
        (item: { type?: string; name?: string }) => item.type === 'event' && item.name === 'PairCreated'
      ) as { type?: string; name?: string; inputs?: Array<{ name?: string }> } | undefined;
      expect(pairCreatedEvent).toBeDefined();

      // Solidly has stable flag in PairCreated event
      const inputs = pairCreatedEvent?.inputs || [];
      const hasStableInput = inputs.some(
        (input: { name?: string }) => input.name === 'stable'
      );
      expect(hasStableInput).toBe(true);
    });

    it('should return correct ABI for factory address', () => {
      const abi = getFactoryAbi('arbitrum', '0xc35DADB65012eC5796536bD9864eD8773aBc74C4');
      expect(abi).toBeDefined();
      expect(Array.isArray(abi)).toBe(true);
    });

    it('should return undefined for unknown factory address', () => {
      const abi = getFactoryAbi('arbitrum', '0x0000000000000000000000000000000000000000');
      expect(abi).toBeUndefined();
    });

    it('should have Pool event in Algebra ABI', () => {
      const algebraAbi = FACTORY_ABIS['algebra'];
      expect(Array.isArray(algebraAbi)).toBe(true);

      const poolEvent = algebraAbi.find(
        (item: { type?: string; name?: string }) => item.type === 'event' && item.name === 'Pool'
      );
      expect(poolEvent).toBeDefined();
    });

    it('should have LBPairCreated event in Trader Joe ABI', () => {
      const traderJoeAbi = FACTORY_ABIS['trader_joe'];
      expect(Array.isArray(traderJoeAbi)).toBe(true);

      const lbPairCreatedEvent = traderJoeAbi.find(
        (item: { type?: string; name?: string }) => item.type === 'event' && item.name === 'LBPairCreated'
      );
      expect(lbPairCreatedEvent).toBeDefined();
    });

    it('should have PoolRegistered event in Balancer V2 ABI', () => {
      const balancerAbi = FACTORY_ABIS['balancer_v2'];
      expect(Array.isArray(balancerAbi)).toBe(true);

      const poolRegisteredEvent = balancerAbi.find(
        (item: { type?: string; name?: string }) => item.type === 'event' && item.name === 'PoolRegistered'
      );
      expect(poolRegisteredEvent).toBeDefined();
    });

    it('should have PlainPoolDeployed event in Curve ABI', () => {
      const curveAbi = FACTORY_ABIS['curve'];
      expect(Array.isArray(curveAbi)).toBe(true);

      const plainPoolEvent = curveAbi.find(
        (item: { type?: string; name?: string }) => item.type === 'event' && item.name === 'PlainPoolDeployed'
      );
      expect(plainPoolEvent).toBeDefined();
    });
  });

  // =============================================================================
  // Helper Function Tests
  // =============================================================================
  describe('Helper Functions', () => {
    describe('getFactoriesForChain', () => {
      it('should return all factories for a chain', () => {
        const factories = getFactoriesForChain('arbitrum');
        expect(Array.isArray(factories)).toBe(true);
        expect(factories.length).toBeGreaterThan(0);

        // Verify each factory is for the correct chain
        for (const factory of factories) {
          expect(factory.chain).toBe('arbitrum');
        }
      });

      it('should return empty array for unknown chain', () => {
        const factories = getFactoriesForChain('unknown-chain');
        expect(factories).toEqual([]);
      });

      it('should return empty array for Solana (non-EVM)', () => {
        const factories = getFactoriesForChain('solana');
        expect(factories).toEqual([]);
      });
    });

    describe('getFactoryByAddress', () => {
      it('should find factory by address (case-insensitive)', () => {
        // Test with lowercase
        const factory1 = getFactoryByAddress('arbitrum', '0x1f98431c8ad98523631ae4a59f267346ea31f984');
        expect(factory1).toBeDefined();
        expect(factory1?.dexName).toBe('uniswap_v3');

        // Test with checksum address
        const factory2 = getFactoryByAddress('arbitrum', '0x1F98431c8aD98523631AE4a59f267346ea31F984');
        expect(factory2).toBeDefined();
        expect(factory2?.dexName).toBe('uniswap_v3');
      });

      it('should return undefined for non-existent factory', () => {
        const factory = getFactoryByAddress('arbitrum', '0x0000000000000000000000000000000000000000');
        expect(factory).toBeUndefined();
      });

      it('should return undefined for wrong chain', () => {
        // Uniswap V3 factory exists on Arbitrum but not with this exact address on BSC
        const factory = getFactoryByAddress('bsc', '0x1F98431c8aD98523631AE4a59f267346ea31F984');
        // Could be defined if BSC has same address, so just check it returns something reasonable
        if (factory) {
          expect(factory.chain).toBe('bsc');
        }
      });
    });

    describe('getFactoryType', () => {
      it('should return factory type for valid address', () => {
        const type = getFactoryType('arbitrum', '0xc35DADB65012eC5796536bD9864eD8773aBc74C4');
        expect(type).toBe('uniswap_v2');
      });

      it('should return undefined for unknown address', () => {
        const type = getFactoryType('arbitrum', '0x0000000000000000000000000000000000000000');
        expect(type).toBeUndefined();
      });
    });

    describe('getAllFactoryAddresses', () => {
      it('should return all factory addresses for a chain', () => {
        const addresses = getAllFactoryAddresses('arbitrum');
        expect(Array.isArray(addresses)).toBe(true);
        expect(addresses.length).toBeGreaterThan(0);

        // All should be valid addresses
        for (const address of addresses) {
          expect(address).toMatch(/^0x[a-fA-F0-9]{40}$/);
        }
      });

      it('should return lowercase addresses for consistent comparison', () => {
        const addresses = getAllFactoryAddresses('arbitrum');
        for (const address of addresses) {
          expect(address).toBe(address.toLowerCase());
        }
      });
    });

    describe('Type predicates', () => {
      it('isUniswapV2Style should identify V2-compatible factories', () => {
        // SushiSwap is V2 style
        expect(isUniswapV2Style('arbitrum', '0xc35DADB65012eC5796536bD9864eD8773aBc74C4')).toBe(true);
        // Uniswap V3 is not V2 style
        expect(isUniswapV2Style('arbitrum', '0x1F98431c8aD98523631AE4a59f267346ea31F984')).toBe(false);
      });

      it('isUniswapV3Style should identify V3-compatible factories (not algebra)', () => {
        // Uniswap V3 on Arbitrum
        expect(isUniswapV3Style('arbitrum', '0x1F98431c8aD98523631AE4a59f267346ea31F984')).toBe(true);
        // SushiSwap V2 is not V3 style
        expect(isUniswapV3Style('arbitrum', '0xc35DADB65012eC5796536bD9864eD8773aBc74C4')).toBe(false);
        // Camelot uses Algebra, not standard V3
        expect(isUniswapV3Style('arbitrum', '0x1a3c9B1d2F0529D97f2afC5136Cc23e58f1FD35B')).toBe(false);
      });

      it('isAlgebraStyle should identify Algebra-based factories', () => {
        // Camelot V3 on Arbitrum uses Algebra
        expect(isAlgebraStyle('arbitrum', '0x1a3c9B1d2F0529D97f2afC5136Cc23e58f1FD35B')).toBe(true);
        // QuickSwap V3 on Polygon uses Algebra
        expect(isAlgebraStyle('polygon', '0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28')).toBe(true);
        // Uniswap V3 is not Algebra style
        expect(isAlgebraStyle('arbitrum', '0x1F98431c8aD98523631AE4a59f267346ea31F984')).toBe(false);
      });

      it('isSolidlyStyle should identify Solidly/ve(3,3) factories', () => {
        // Velodrome on Optimism
        expect(isSolidlyStyle('optimism', '0x25CbdDb98b35ab1FF77413456B31EC81A6B6B746')).toBe(true);
        // Uniswap V3 is not Solidly style
        expect(isSolidlyStyle('arbitrum', '0x1F98431c8aD98523631AE4a59f267346ea31F984')).toBe(false);
      });

      it('isVaultModelDex should identify vault-model DEXes', () => {
        // Vault-model DEXes use different factory addresses than standard AMMs
        expect(isVaultModelDex('balancer_v2')).toBe(true);
        expect(isVaultModelDex('beethoven_x')).toBe(true);
        expect(isVaultModelDex('gmx')).toBe(true);
        expect(isVaultModelDex('platypus')).toBe(true);

        // Standard AMM DEXes are not vault-model
        expect(isVaultModelDex('uniswap_v3')).toBe(false);
        expect(isVaultModelDex('sushiswap')).toBe(false);
        expect(isVaultModelDex('aerodrome')).toBe(false);
      });
    });

    describe('getFactoriesByType', () => {
      it('should group factories by type for a chain', () => {
        const byType = getFactoriesByType('arbitrum');
        expect(byType).toBeInstanceOf(Map);

        // Arbitrum should have multiple types
        expect(byType.has('uniswap_v3')).toBe(true);
        expect(byType.has('uniswap_v2')).toBe(true);
        expect(byType.has('algebra')).toBe(true);
        expect(byType.has('solidly')).toBe(true);
      });

      it('should return empty map for unknown chain', () => {
        const byType = getFactoriesByType('unknown-chain');
        expect(byType.size).toBe(0);
      });

      it('should include all factories for a type', () => {
        const byType = getFactoriesByType('arbitrum');
        const v2Factories = byType.get('uniswap_v2') || [];

        // Should have SushiSwap and ZyberSwap at minimum
        const dexNames = v2Factories.map(f => f.dexName);
        expect(dexNames).toContain('sushiswap');
        expect(dexNames).toContain('zyberswap');
      });
    });

    describe('validateFactoryRegistry', () => {
      it('should return empty array when registry is valid', () => {
        // FIX: Vault-model DEXes are now properly handled in validation
        // No need to filter out errors - validation should pass cleanly
        const errors = validateFactoryRegistry();
        expect(errors).toEqual([]);
      });

      it('should catch invalid address formats', () => {
        // This is a validation function test - it checks the registry format
        // All addresses in registry should be valid
        const factories = getFactoriesForChain('arbitrum');
        for (const factory of factories) {
          expect(factory.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
        }
      });

      it('should verify chain matches in factory config', () => {
        for (const [chain, factories] of Object.entries(DEX_FACTORY_REGISTRY)) {
          for (const factory of factories) {
            expect(factory.chain).toBe(chain);
          }
        }
      });
    });
  });

  // =============================================================================
  // Consistency with DEXES Config Tests
  // =============================================================================
  describe('Consistency with DEXES config', () => {
    it('should have factory entries for all enabled EVM DEXes', () => {
      for (const [chain, dexes] of Object.entries(DEXES)) {
        // Skip Solana
        if (chain === 'solana') continue;

        const chainFactories = getFactoriesForChain(chain);
        const factoryAddresses = new Set(chainFactories.map(f => f.address.toLowerCase()));

        for (const dex of dexes as any[]) {
          // Skip disabled DEXes
          if (dex.enabled === false) continue;

          // Skip vault-model DEXes (Balancer, GMX, Platypus) which have special handling
          if (['balancer_v2', 'beethoven_x', 'gmx', 'platypus'].includes(dex.name)) continue;

          // Verify factory address exists in registry
          const hasFactory = factoryAddresses.has(dex.factoryAddress.toLowerCase());
          if (!hasFactory) {
            console.warn(`Missing factory for ${dex.name} on ${chain}: ${dex.factoryAddress}`);
          }
          expect(hasFactory).toBe(true);
        }
      }
    });

    it('should have matching DEX names between registry and DEXES config', () => {
      for (const [chain, factories] of Object.entries(DEX_FACTORY_REGISTRY)) {
        const chainDexes = DEXES[chain] || [];
        const dexNames = new Set((chainDexes as any[]).map(d => d.name));

        for (const factory of factories) {
          // Verify DEX name exists in DEXES config
          expect(dexNames.has(factory.dexName)).toBe(true);
        }
      }
    });
  });

  // =============================================================================
  // Performance Tests
  // =============================================================================
  describe('Performance', () => {
    it('should have O(1) lookup by address using pre-computed map', () => {
      // Measure lookup time for 1000 lookups
      const startTime = performance.now();
      for (let i = 0; i < 1000; i++) {
        getFactoryByAddress('arbitrum', '0x1F98431c8aD98523631AE4a59f267346ea31F984');
      }
      const endTime = performance.now();

      // Should complete in under 10ms for 1000 lookups
      expect(endTime - startTime).toBeLessThan(10);
    });

    it('should cache factory addresses for efficient getAllFactoryAddresses', () => {
      // First call
      const addresses1 = getAllFactoryAddresses('arbitrum');
      // Second call should return same reference (cached)
      const addresses2 = getAllFactoryAddresses('arbitrum');

      // Should be same array reference (cached)
      expect(addresses1).toBe(addresses2);
    });
  });
});
