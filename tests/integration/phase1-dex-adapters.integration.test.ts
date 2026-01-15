/**
 * Phase 1 Integration Tests: Vault-Model DEX Adapters
 *
 * Tests for the implemented DEX adapters (Balancer V2, GMX, Platypus, Beethoven X)
 * that handle vault-model and pool-model DEXes which don't follow the standard
 * factory pattern.
 *
 * @see ADR-003: Partitioned Detector Strategy
 * @see shared/core/src/dex-adapters/
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { ethers } from 'ethers';

// Config imports
import {
  DEXES,
  getEnabledDexes,
  CHAINS
} from '../../shared/config/src';

// DEX Adapter imports
import {
  AdapterRegistry,
  getAdapterRegistry,
  resetAdapterRegistry,
  BalancerV2Adapter,
  GmxAdapter,
  PlatypusAdapter,
  BALANCER_VAULT_ADDRESSES,
  GMX_ADDRESSES,
  PLATYPUS_ADDRESSES,
  AdapterConfig,
  DexAdapter
} from '../../shared/core/src/dex-adapters';

// =============================================================================
// Test Constants
// =============================================================================

/**
 * Vault-model DEXes that should now be ENABLED with adapters
 */
const ENABLED_VAULT_MODEL_DEXES = [
  { name: 'balancer_v2', chain: 'arbitrum', model: 'Balancer V2 Vault' },
  { name: 'beethoven_x', chain: 'fantom', model: 'Balancer V2 Vault (fork)' },
  { name: 'gmx', chain: 'avalanche', model: 'GMX Vault' },
  { name: 'platypus', chain: 'avalanche', model: 'Pool Model' }
] as const;

/**
 * Expected vault addresses for each adapter
 */
const EXPECTED_ADDRESSES = {
  balancer_v2: {
    arbitrum: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    ethereum: '0xBA12222222228d8Ba445958a75a0704d566BF2C8'
  },
  beethoven_x: {
    fantom: '0x20dd72Ed959b6147912C2e529F0a0C651c33c9ce'
  },
  gmx: {
    avalanche: '0x9ab2De34A33fB459b538c43f251eB825645e8595'
  },
  platypus: {
    avalanche: '0x66357dCaCe80431aee0A7507e2E361B7e2402370'
  }
};

// =============================================================================
// Mock Setup
// =============================================================================

const createMockProvider = (): ethers.JsonRpcProvider => {
  return {
    call: jest.fn().mockResolvedValue(
      ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [0])
    ),
    getBlockNumber: jest.fn().mockResolvedValue(12345678),
    resolveName: jest.fn().mockResolvedValue(null),
    getNetwork: jest.fn().mockResolvedValue({ chainId: 1n }),
    _isProvider: true,
  } as unknown as ethers.JsonRpcProvider;
};

// Mock fetch for subgraph queries
global.fetch = jest.fn().mockImplementation((url: string) => {
  // Return empty pools for subgraph queries
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ data: { pools: [] } }),
  });
});

// =============================================================================
// Phase 1.1: Vault-Model DEXes Should Be Enabled
// =============================================================================

describe('Phase 1.1: Vault-Model DEXes Configuration', () => {
  describe('All vault-model DEXes should now be ENABLED', () => {
    for (const dex of ENABLED_VAULT_MODEL_DEXES) {
      describe(`${dex.name} on ${dex.chain} (${dex.model})`, () => {
        it(`should exist in DEXES config for ${dex.chain}`, () => {
          const chainDexes = DEXES[dex.chain] || [];
          const found = chainDexes.find((d: any) => d.name === dex.name);
          expect(found).toBeDefined();
        });

        it(`should have enabled=true (adapter implemented)`, () => {
          const chainDexes = DEXES[dex.chain] || [];
          const found = chainDexes.find((d: any) => d.name === dex.name);
          expect(found?.enabled).toBe(true);
        });

        it(`should appear in getEnabledDexes('${dex.chain}')`, () => {
          const enabledDexes = getEnabledDexes(dex.chain);
          const found = enabledDexes.find(d => d.name === dex.name);
          expect(found).toBeDefined();
        });
      });
    }
  });

  describe('Enabled DEX counts after adapter implementation', () => {
    it('should have 6 enabled DEXs on Avalanche (4 factory + GMX + Platypus)', () => {
      const enabledDexes = getEnabledDexes('avalanche');
      const enabledNames = enabledDexes.map(d => d.name);

      // Verify vault model DEXs are NOW included
      expect(enabledNames).toContain('gmx');
      expect(enabledNames).toContain('platypus');

      // Verify total count: trader_joe_v2, pangolin, sushiswap, kyberswap (4) + gmx, platypus (2) = 6
      expect(enabledDexes.length).toBe(6);
    });

    it('should have Beethoven X enabled on Fantom', () => {
      const enabledDexes = getEnabledDexes('fantom');
      const enabledNames = enabledDexes.map(d => d.name);

      expect(enabledNames).toContain('beethoven_x');
    });

    it('should have Balancer V2 enabled on Arbitrum', () => {
      const enabledDexes = getEnabledDexes('arbitrum');
      const enabledNames = enabledDexes.map(d => d.name);

      expect(enabledNames).toContain('balancer_v2');
    });
  });
});

// =============================================================================
// Phase 1.2: Balancer V2 Adapter Tests
// =============================================================================

describe('Phase 1.2: Balancer V2 Adapter Integration', () => {
  let adapter: BalancerV2Adapter;
  let mockProvider: ethers.JsonRpcProvider;

  beforeEach(() => {
    mockProvider = createMockProvider();
  });

  afterEach(async () => {
    if (adapter) {
      await adapter.destroy();
    }
  });

  describe('Adapter instantiation', () => {
    it('should create adapter with correct config for Arbitrum', () => {
      const config: AdapterConfig = {
        name: 'balancer_v2',
        chain: 'arbitrum',
        primaryAddress: BALANCER_VAULT_ADDRESSES.arbitrum,
        provider: mockProvider
      };

      adapter = new BalancerV2Adapter(config);

      expect(adapter.name).toBe('balancer_v2');
      expect(adapter.chain).toBe('arbitrum');
      expect(adapter.type).toBe('vault');
      expect(adapter.primaryAddress).toBe(BALANCER_VAULT_ADDRESSES.arbitrum);
    });

    it('should create adapter for Ethereum', () => {
      const config: AdapterConfig = {
        name: 'balancer_v2',
        chain: 'ethereum',
        primaryAddress: BALANCER_VAULT_ADDRESSES.ethereum,
        provider: mockProvider
      };

      adapter = new BalancerV2Adapter(config);

      expect(adapter.chain).toBe('ethereum');
      expect(adapter.primaryAddress).toBe(BALANCER_VAULT_ADDRESSES.ethereum);
    });

    it('should throw if provider is not provided', () => {
      const config: AdapterConfig = {
        name: 'balancer_v2',
        chain: 'arbitrum',
        primaryAddress: BALANCER_VAULT_ADDRESSES.arbitrum,
        provider: undefined as any
      };

      expect(() => new BalancerV2Adapter(config)).toThrow('requires a provider');
    });
  });

  describe('Adapter initialization', () => {
    it('should initialize successfully', async () => {
      const config: AdapterConfig = {
        name: 'balancer_v2',
        chain: 'arbitrum',
        primaryAddress: BALANCER_VAULT_ADDRESSES.arbitrum,
        provider: mockProvider
      };

      adapter = new BalancerV2Adapter(config);
      await adapter.initialize();

      // Should verify provider is working
      expect(mockProvider.getBlockNumber).toHaveBeenCalled();
    });

    it('should report healthy after initialization', async () => {
      const config: AdapterConfig = {
        name: 'balancer_v2',
        chain: 'arbitrum',
        primaryAddress: BALANCER_VAULT_ADDRESSES.arbitrum,
        provider: mockProvider
      };

      adapter = new BalancerV2Adapter(config);
      await adapter.initialize();

      const isHealthy = await adapter.isHealthy();
      expect(isHealthy).toBe(true);
    });
  });

  describe('Pool discovery', () => {
    it('should return empty array when no subgraph URL configured', async () => {
      const config: AdapterConfig = {
        name: 'balancer_v2',
        chain: 'arbitrum',
        primaryAddress: BALANCER_VAULT_ADDRESSES.arbitrum,
        provider: mockProvider
        // No subgraphUrl
      };

      adapter = new BalancerV2Adapter(config);
      await adapter.initialize();

      const pools = await adapter.discoverPools(
        '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
        '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'  // USDC
      );

      expect(Array.isArray(pools)).toBe(true);
      expect(pools).toHaveLength(0);
    });

    it('should query subgraph for pool discovery when URL provided', async () => {
      const config: AdapterConfig = {
        name: 'balancer_v2',
        chain: 'arbitrum',
        primaryAddress: BALANCER_VAULT_ADDRESSES.arbitrum,
        provider: mockProvider,
        subgraphUrl: 'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-arbitrum-v2'
      };

      adapter = new BalancerV2Adapter(config);
      await adapter.initialize();

      const pools = await adapter.discoverPools(
        '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
      );

      // Should have called fetch
      expect(global.fetch).toHaveBeenCalled();
      expect(Array.isArray(pools)).toBe(true);
    });
  });
});

// =============================================================================
// Phase 1.3: GMX Adapter Tests
// =============================================================================

describe('Phase 1.3: GMX Adapter Integration', () => {
  let adapter: GmxAdapter;
  let mockProvider: ethers.JsonRpcProvider;

  beforeEach(() => {
    mockProvider = createMockProvider();
  });

  afterEach(async () => {
    if (adapter) {
      await adapter.destroy();
    }
  });

  describe('Adapter instantiation', () => {
    it('should create adapter with correct config for Avalanche', () => {
      const config: AdapterConfig = {
        name: 'gmx',
        chain: 'avalanche',
        primaryAddress: GMX_ADDRESSES.avalanche.vault,
        secondaryAddress: GMX_ADDRESSES.avalanche.reader,
        provider: mockProvider
      };

      adapter = new GmxAdapter(config);

      expect(adapter.name).toBe('gmx');
      expect(adapter.chain).toBe('avalanche');
      expect(adapter.type).toBe('vault');
      expect(adapter.primaryAddress).toBe(GMX_ADDRESSES.avalanche.vault);
    });

    it('should throw if provider is not provided', () => {
      const config: AdapterConfig = {
        name: 'gmx',
        chain: 'avalanche',
        primaryAddress: GMX_ADDRESSES.avalanche.vault,
        provider: undefined as any
      };

      expect(() => new GmxAdapter(config)).toThrow('requires a provider');
    });
  });

  describe('Adapter initialization', () => {
    it('should initialize successfully', async () => {
      const config: AdapterConfig = {
        name: 'gmx',
        chain: 'avalanche',
        primaryAddress: GMX_ADDRESSES.avalanche.vault,
        secondaryAddress: GMX_ADDRESSES.avalanche.reader,
        provider: mockProvider
      };

      adapter = new GmxAdapter(config);
      await adapter.initialize();

      expect(mockProvider.getBlockNumber).toHaveBeenCalled();
    });

    it('should report healthy after initialization', async () => {
      const config: AdapterConfig = {
        name: 'gmx',
        chain: 'avalanche',
        primaryAddress: GMX_ADDRESSES.avalanche.vault,
        secondaryAddress: GMX_ADDRESSES.avalanche.reader,
        provider: mockProvider
      };

      adapter = new GmxAdapter(config);
      await adapter.initialize();

      const isHealthy = await adapter.isHealthy();
      expect(isHealthy).toBe(true);
    });
  });
});

// =============================================================================
// Phase 1.4: Platypus Adapter Tests
// =============================================================================

describe('Phase 1.4: Platypus Adapter Integration', () => {
  let adapter: PlatypusAdapter;
  let mockProvider: ethers.JsonRpcProvider;

  beforeEach(() => {
    mockProvider = createMockProvider();
  });

  afterEach(async () => {
    if (adapter) {
      await adapter.destroy();
    }
  });

  describe('Adapter instantiation', () => {
    it('should create adapter with correct config for Avalanche', () => {
      const config: AdapterConfig = {
        name: 'platypus',
        chain: 'avalanche',
        primaryAddress: PLATYPUS_ADDRESSES.avalanche.pool,
        provider: mockProvider
      };

      adapter = new PlatypusAdapter(config);

      expect(adapter.name).toBe('platypus');
      expect(adapter.chain).toBe('avalanche');
      expect(adapter.type).toBe('pool');
      expect(adapter.primaryAddress).toBe(PLATYPUS_ADDRESSES.avalanche.pool);
    });

    it('should throw if provider is not provided', () => {
      const config: AdapterConfig = {
        name: 'platypus',
        chain: 'avalanche',
        primaryAddress: PLATYPUS_ADDRESSES.avalanche.pool,
        provider: undefined as any
      };

      expect(() => new PlatypusAdapter(config)).toThrow('requires a provider');
    });
  });

  describe('Adapter initialization', () => {
    it('should initialize successfully', async () => {
      const config: AdapterConfig = {
        name: 'platypus',
        chain: 'avalanche',
        primaryAddress: PLATYPUS_ADDRESSES.avalanche.pool,
        provider: mockProvider
      };

      adapter = new PlatypusAdapter(config);
      await adapter.initialize();

      expect(mockProvider.getBlockNumber).toHaveBeenCalled();
    });
  });
});

// =============================================================================
// Phase 1.5: Adapter Registry Integration
// =============================================================================

describe('Phase 1.5: Adapter Registry Integration', () => {
  let registry: AdapterRegistry;
  let mockProvider: ethers.JsonRpcProvider;

  beforeEach(async () => {
    await resetAdapterRegistry();
    mockProvider = createMockProvider();
    registry = new AdapterRegistry();
  });

  afterEach(async () => {
    await registry.destroyAll();
  });

  describe('Registry operations', () => {
    it('should register and retrieve Balancer V2 adapter', () => {
      const config: AdapterConfig = {
        name: 'balancer_v2',
        chain: 'arbitrum',
        primaryAddress: BALANCER_VAULT_ADDRESSES.arbitrum,
        provider: mockProvider
      };

      const adapter = new BalancerV2Adapter(config);
      registry.register(adapter);

      const retrieved = registry.getAdapter('balancer_v2', 'arbitrum');
      expect(retrieved).toBe(adapter);
    });

    it('should register and retrieve GMX adapter', () => {
      const config: AdapterConfig = {
        name: 'gmx',
        chain: 'avalanche',
        primaryAddress: GMX_ADDRESSES.avalanche.vault,
        secondaryAddress: GMX_ADDRESSES.avalanche.reader,
        provider: mockProvider
      };

      const adapter = new GmxAdapter(config);
      registry.register(adapter);

      const retrieved = registry.getAdapter('gmx', 'avalanche');
      expect(retrieved).toBe(adapter);
    });

    it('should register and retrieve Platypus adapter', () => {
      const config: AdapterConfig = {
        name: 'platypus',
        chain: 'avalanche',
        primaryAddress: PLATYPUS_ADDRESSES.avalanche.pool,
        provider: mockProvider
      };

      const adapter = new PlatypusAdapter(config);
      registry.register(adapter);

      const retrieved = registry.getAdapter('platypus', 'avalanche');
      expect(retrieved).toBe(adapter);
    });

    it('should list all registered adapters', () => {
      const balancerConfig: AdapterConfig = {
        name: 'balancer_v2',
        chain: 'arbitrum',
        primaryAddress: BALANCER_VAULT_ADDRESSES.arbitrum,
        provider: mockProvider
      };

      const gmxConfig: AdapterConfig = {
        name: 'gmx',
        chain: 'avalanche',
        primaryAddress: GMX_ADDRESSES.avalanche.vault,
        provider: mockProvider
      };

      const platypusConfig: AdapterConfig = {
        name: 'platypus',
        chain: 'avalanche',
        primaryAddress: PLATYPUS_ADDRESSES.avalanche.pool,
        provider: mockProvider
      };

      registry.register(new BalancerV2Adapter(balancerConfig));
      registry.register(new GmxAdapter(gmxConfig));
      registry.register(new PlatypusAdapter(platypusConfig));

      const adapters = registry.listAdapters();
      expect(adapters).toHaveLength(3);
    });

    it('should list adapters by chain', () => {
      const arbitrumConfig: AdapterConfig = {
        name: 'balancer_v2',
        chain: 'arbitrum',
        primaryAddress: BALANCER_VAULT_ADDRESSES.arbitrum,
        provider: mockProvider
      };

      const avalancheGmxConfig: AdapterConfig = {
        name: 'gmx',
        chain: 'avalanche',
        primaryAddress: GMX_ADDRESSES.avalanche.vault,
        provider: mockProvider
      };

      const avalanchePlatypusConfig: AdapterConfig = {
        name: 'platypus',
        chain: 'avalanche',
        primaryAddress: PLATYPUS_ADDRESSES.avalanche.pool,
        provider: mockProvider
      };

      registry.register(new BalancerV2Adapter(arbitrumConfig));
      registry.register(new GmxAdapter(avalancheGmxConfig));
      registry.register(new PlatypusAdapter(avalanchePlatypusConfig));

      const arbitrumAdapters = registry.listAdaptersByChain('arbitrum');
      expect(arbitrumAdapters).toHaveLength(1);
      expect(arbitrumAdapters[0].name).toBe('balancer_v2');

      const avalancheAdapters = registry.listAdaptersByChain('avalanche');
      expect(avalancheAdapters).toHaveLength(2);
    });
  });

  describe('Registry with Dex config lookup', () => {
    it('should find adapter for Dex config object', () => {
      const config: AdapterConfig = {
        name: 'balancer_v2',
        chain: 'arbitrum',
        primaryAddress: BALANCER_VAULT_ADDRESSES.arbitrum,
        provider: mockProvider
      };

      const adapter = new BalancerV2Adapter(config);
      registry.register(adapter);

      const dexConfig = {
        name: 'balancer_v2',
        chain: 'arbitrum',
        factoryAddress: BALANCER_VAULT_ADDRESSES.arbitrum,
        routerAddress: BALANCER_VAULT_ADDRESSES.arbitrum,
        fee: 30,
        enabled: true
      };

      const retrieved = registry.getAdapterForDex(dexConfig);
      expect(retrieved).toBe(adapter);
    });

    it('should return null for Dex without adapter', () => {
      const dexConfig = {
        name: 'uniswap_v2',
        chain: 'ethereum',
        factoryAddress: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
        routerAddress: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
        fee: 30,
        enabled: true
      };

      const adapter = registry.getAdapterForDex(dexConfig);
      expect(adapter).toBeNull();
    });
  });

  describe('Singleton pattern', () => {
    it('should return same instance from getAdapterRegistry', async () => {
      await resetAdapterRegistry();

      const instance1 = getAdapterRegistry();
      const instance2 = getAdapterRegistry();

      expect(instance1).toBe(instance2);
    });

    it('should clear adapters on reset', async () => {
      const globalRegistry = getAdapterRegistry();

      const config: AdapterConfig = {
        name: 'balancer_v2',
        chain: 'arbitrum',
        primaryAddress: BALANCER_VAULT_ADDRESSES.arbitrum,
        provider: mockProvider
      };

      globalRegistry.register(new BalancerV2Adapter(config));
      expect(globalRegistry.listAdapters()).toHaveLength(1);

      await resetAdapterRegistry();

      const newRegistry = getAdapterRegistry();
      expect(newRegistry.listAdapters()).toHaveLength(0);
    });
  });
});

// =============================================================================
// Phase 1.6: Config-to-Adapter Integration
// =============================================================================

describe('Phase 1.6: Config to Adapter Integration', () => {
  describe('Contract addresses match between config and adapter types', () => {
    it('should have matching Balancer V2 Arbitrum address', () => {
      const configDex = DEXES['arbitrum']?.find((d: any) => d.name === 'balancer_v2');
      expect(configDex).toBeDefined();
      expect(configDex!.factoryAddress.toLowerCase()).toBe(
        BALANCER_VAULT_ADDRESSES.arbitrum.toLowerCase()
      );
    });

    it('should have matching Beethoven X Fantom address', () => {
      const configDex = DEXES['fantom']?.find((d: any) => d.name === 'beethoven_x');
      expect(configDex).toBeDefined();
      expect(configDex!.factoryAddress.toLowerCase()).toBe(
        BALANCER_VAULT_ADDRESSES.fantom.toLowerCase()
      );
    });

    it('should have matching GMX Avalanche vault address', () => {
      const configDex = DEXES['avalanche']?.find((d: any) => d.name === 'gmx');
      expect(configDex).toBeDefined();
      expect(configDex!.factoryAddress.toLowerCase()).toBe(
        GMX_ADDRESSES.avalanche.vault.toLowerCase()
      );
    });

    it('should have matching Platypus Avalanche pool address', () => {
      const configDex = DEXES['avalanche']?.find((d: any) => d.name === 'platypus');
      expect(configDex).toBeDefined();
      expect(configDex!.factoryAddress.toLowerCase()).toBe(
        PLATYPUS_ADDRESSES.avalanche.pool.toLowerCase()
      );
    });
  });

  describe('Enabled DEX consistency', () => {
    it('all enabled vault-model DEXes should have adapter type constants', () => {
      // Balancer V2
      expect(BALANCER_VAULT_ADDRESSES.arbitrum).toBeDefined();
      expect(BALANCER_VAULT_ADDRESSES.ethereum).toBeDefined();
      expect(BALANCER_VAULT_ADDRESSES.fantom).toBeDefined();

      // GMX
      expect(GMX_ADDRESSES.avalanche.vault).toBeDefined();
      expect(GMX_ADDRESSES.avalanche.reader).toBeDefined();

      // Platypus
      expect(PLATYPUS_ADDRESSES.avalanche.pool).toBeDefined();
      expect(PLATYPUS_ADDRESSES.avalanche.router).toBeDefined();
    });
  });
});

// =============================================================================
// End-to-End Integration Test
// =============================================================================

describe('End-to-End: Adapter Lifecycle', () => {
  let registry: AdapterRegistry;
  let mockProvider: ethers.JsonRpcProvider;

  beforeEach(async () => {
    await resetAdapterRegistry();
    mockProvider = createMockProvider();
    registry = getAdapterRegistry();
  });

  afterEach(async () => {
    await resetAdapterRegistry();
  });

  it('should complete full lifecycle: create -> initialize -> discover -> destroy', async () => {
    // 1. Create adapter
    const config: AdapterConfig = {
      name: 'balancer_v2',
      chain: 'arbitrum',
      primaryAddress: BALANCER_VAULT_ADDRESSES.arbitrum,
      provider: mockProvider,
      subgraphUrl: 'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-arbitrum-v2'
    };

    const adapter = new BalancerV2Adapter(config);

    // 2. Initialize
    await adapter.initialize();
    expect(await adapter.isHealthy()).toBe(true);

    // 3. Register with registry
    registry.register(adapter);
    expect(registry.getAdapter('balancer_v2', 'arbitrum')).toBe(adapter);

    // 4. Discover pools
    const pools = await adapter.discoverPools(
      '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
    );
    expect(Array.isArray(pools)).toBe(true);

    // 5. Destroy
    await adapter.destroy();
    expect(await adapter.isHealthy()).toBe(false);
  });

  it('should handle multiple adapters across chains', async () => {
    // Create adapters for different chains
    const balancerConfig: AdapterConfig = {
      name: 'balancer_v2',
      chain: 'arbitrum',
      primaryAddress: BALANCER_VAULT_ADDRESSES.arbitrum,
      provider: mockProvider
    };

    const gmxConfig: AdapterConfig = {
      name: 'gmx',
      chain: 'avalanche',
      primaryAddress: GMX_ADDRESSES.avalanche.vault,
      provider: mockProvider
    };

    const beethovenConfig: AdapterConfig = {
      name: 'beethoven_x',
      chain: 'fantom',
      primaryAddress: BALANCER_VAULT_ADDRESSES.fantom,
      provider: mockProvider
    };

    // Register all
    registry.register(new BalancerV2Adapter(balancerConfig));
    registry.register(new GmxAdapter(gmxConfig));
    registry.register(new BalancerV2Adapter(beethovenConfig));

    // Verify retrieval
    expect(registry.getAdapter('balancer_v2', 'arbitrum')).not.toBeNull();
    expect(registry.getAdapter('gmx', 'avalanche')).not.toBeNull();
    expect(registry.getAdapter('beethoven_x', 'fantom')).not.toBeNull();

    // Verify chain filtering
    expect(registry.listAdaptersByChain('arbitrum')).toHaveLength(1);
    expect(registry.listAdaptersByChain('avalanche')).toHaveLength(1);
    expect(registry.listAdaptersByChain('fantom')).toHaveLength(1);

    // Cleanup
    await registry.destroyAll();
    expect(registry.listAdapters()).toHaveLength(0);
  });
});

// =============================================================================
// Regression: Ensure Factory-Model DEXes Still Work
// =============================================================================

describe('Regression: Factory-Model DEXes Unchanged', () => {
  it('should still have Uniswap V2 style DEXes enabled', () => {
    // SushiSwap uses Uniswap V2 factory/router pattern
    const polygonDexes = getEnabledDexes('polygon');
    const sushiswap = polygonDexes.find(d => d.name === 'sushiswap');
    expect(sushiswap).toBeDefined();
    expect(sushiswap?.factoryAddress).toBeDefined();
    expect(sushiswap?.routerAddress).toBeDefined();
  });

  it('should still have Uniswap V3 style DEXes enabled', () => {
    const ethereumDexes = getEnabledDexes('ethereum');
    const uniswapV3 = ethereumDexes.find(d => d.name === 'uniswap_v3');
    expect(uniswapV3).toBeDefined();
  });

  it('should maintain correct total enabled DEX count', () => {
    let totalEnabled = 0;
    for (const chain of Object.keys(CHAINS)) {
      totalEnabled += getEnabledDexes(chain).length;
    }

    // Should have increased due to enabling vault-model DEXes
    // Original: ~45 enabled DEXes, +4 vault-model = ~49
    expect(totalEnabled).toBeGreaterThanOrEqual(45);
  });
});
