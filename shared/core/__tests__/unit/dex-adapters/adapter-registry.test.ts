/**
 * Adapter Registry Unit Tests
 *
 * Tests for the DEX adapter registry that manages vault-model
 * and pool-model DEX adapters.
 *
 * @see ADR-003: Partitioned Detector Strategy
 *
 * @migrated from shared/core/src/dex-adapters/__tests__/adapter-registry.test.ts
 * @see ADR-009: Test Architecture
 */

import { ethers } from 'ethers';
import {
  AdapterRegistry,
  getAdapterRegistry,
  resetAdapterRegistry,
  BalancerV2Adapter,
  GmxAdapter,
  PlatypusAdapter,
  DexAdapter,
  AdapterConfig,
  BALANCER_VAULT_ADDRESSES,
  GMX_ADDRESSES,
  PLATYPUS_ADDRESSES,
} from '@arbitrage/core';

// =============================================================================
// Mocks
// =============================================================================

jest.mock('../../../src/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// Mock fetch for subgraph
global.fetch = jest.fn().mockResolvedValue({
  ok: true,
  json: () => Promise.resolve({ data: { pools: [] } }),
});

// =============================================================================
// Test Fixtures
// =============================================================================

const createMockProvider = () => {
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

const testDexConfig = {
  name: 'balancer_v2',
  chain: 'arbitrum',
  factoryAddress: BALANCER_VAULT_ADDRESSES.arbitrum,
  routerAddress: '',
  fee: 30,
  enabled: true,
};

const testToken0 = {
  address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  symbol: 'WETH',
  decimals: 18,
  chainId: 42161,
};

const testToken1 = {
  address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  symbol: 'USDC',
  decimals: 6,
  chainId: 42161,
};

// =============================================================================
// Test Suite
// =============================================================================

describe('AdapterRegistry', () => {
  let registry: AdapterRegistry;
  let mockProvider: ethers.JsonRpcProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    resetAdapterRegistry();
    mockProvider = createMockProvider();
    registry = new AdapterRegistry();
  });

  afterEach(async () => {
    await registry.destroyAll();
  });

  // ===========================================================================
  // Registration
  // ===========================================================================

  describe('register()', () => {
    it('should register a Balancer V2 adapter', async () => {
      const config: AdapterConfig = {
        name: 'balancer_v2',
        chain: 'arbitrum',
        primaryAddress: BALANCER_VAULT_ADDRESSES.arbitrum,
        provider: mockProvider,
      };

      const adapter = new BalancerV2Adapter(config);
      await registry.register(adapter);

      const retrieved = registry.getAdapter('balancer_v2', 'arbitrum');
      expect(retrieved).toBe(adapter);
    });

    it('should register a GMX adapter', async () => {
      const config: AdapterConfig = {
        name: 'gmx',
        chain: 'avalanche',
        primaryAddress: GMX_ADDRESSES.avalanche.vault,
        secondaryAddress: GMX_ADDRESSES.avalanche.reader,
        provider: mockProvider,
      };

      const adapter = new GmxAdapter(config);
      await registry.register(adapter);

      const retrieved = registry.getAdapter('gmx', 'avalanche');
      expect(retrieved).toBe(adapter);
    });

    it('should register a Platypus adapter', async () => {
      const config: AdapterConfig = {
        name: 'platypus',
        chain: 'avalanche',
        primaryAddress: PLATYPUS_ADDRESSES.avalanche.pool,
        provider: mockProvider,
      };

      const adapter = new PlatypusAdapter(config);
      await registry.register(adapter);

      const retrieved = registry.getAdapter('platypus', 'avalanche');
      expect(retrieved).toBe(adapter);
    });

    it('should replace existing adapter on re-registration', async () => {
      const config1: AdapterConfig = {
        name: 'balancer_v2',
        chain: 'arbitrum',
        primaryAddress: BALANCER_VAULT_ADDRESSES.arbitrum,
        provider: mockProvider,
      };

      const adapter1 = new BalancerV2Adapter(config1);
      await registry.register(adapter1);

      const config2: AdapterConfig = {
        name: 'balancer_v2',
        chain: 'arbitrum',
        primaryAddress: BALANCER_VAULT_ADDRESSES.arbitrum,
        provider: createMockProvider(),
      };

      const adapter2 = new BalancerV2Adapter(config2);
      await registry.register(adapter2);

      const retrieved = registry.getAdapter('balancer_v2', 'arbitrum');
      expect(retrieved).toBe(adapter2);
      expect(retrieved).not.toBe(adapter1);
    });
  });

  // ===========================================================================
  // Retrieval
  // ===========================================================================

  describe('getAdapter()', () => {
    it('should return null for unregistered adapter', () => {
      const adapter = registry.getAdapter('unknown_dex', 'unknown_chain');
      expect(adapter).toBeNull();
    });

    it('should find adapter by dex name and chain', async () => {
      const config: AdapterConfig = {
        name: 'balancer_v2',
        chain: 'ethereum',
        primaryAddress: BALANCER_VAULT_ADDRESSES.ethereum,
        provider: mockProvider,
      };

      const adapter = new BalancerV2Adapter(config);
      await registry.register(adapter);

      // Should find with correct chain
      expect(registry.getAdapter('balancer_v2', 'ethereum')).toBe(adapter);

      // Should not find with wrong chain
      expect(registry.getAdapter('balancer_v2', 'arbitrum')).toBeNull();
    });
  });

  describe('getAdapterForDex()', () => {
    it('should return adapter for Dex config object', async () => {
      const config: AdapterConfig = {
        name: 'balancer_v2',
        chain: 'arbitrum',
        primaryAddress: BALANCER_VAULT_ADDRESSES.arbitrum,
        provider: mockProvider,
      };

      const adapter = new BalancerV2Adapter(config);
      await registry.register(adapter);

      const retrieved = registry.getAdapterForDex(testDexConfig);
      expect(retrieved).toBe(adapter);
    });

    it('should return null for Dex without adapter', () => {
      const dexConfig = {
        name: 'uniswap_v2',
        chain: 'ethereum',
        factoryAddress: '0x...',
        routerAddress: '0x...',
        fee: 30,
        enabled: true,
      };

      const adapter = registry.getAdapterForDex(dexConfig);
      expect(adapter).toBeNull();
    });
  });

  // ===========================================================================
  // Listing
  // ===========================================================================

  describe('listAdapters()', () => {
    it('should return all registered adapters', async () => {
      const balancerConfig: AdapterConfig = {
        name: 'balancer_v2',
        chain: 'arbitrum',
        primaryAddress: BALANCER_VAULT_ADDRESSES.arbitrum,
        provider: mockProvider,
      };

      const gmxConfig: AdapterConfig = {
        name: 'gmx',
        chain: 'avalanche',
        primaryAddress: GMX_ADDRESSES.avalanche.vault,
        provider: mockProvider,
      };

      await registry.register(new BalancerV2Adapter(balancerConfig));
      await registry.register(new GmxAdapter(gmxConfig));

      const adapters = registry.listAdapters();
      expect(adapters).toHaveLength(2);
    });

    it('should return empty array when no adapters registered', () => {
      const adapters = registry.listAdapters();
      expect(adapters).toHaveLength(0);
    });
  });

  describe('listAdaptersByChain()', () => {
    it('should filter adapters by chain', async () => {
      const arbitrumConfig: AdapterConfig = {
        name: 'balancer_v2',
        chain: 'arbitrum',
        primaryAddress: BALANCER_VAULT_ADDRESSES.arbitrum,
        provider: mockProvider,
      };

      const avalancheConfig: AdapterConfig = {
        name: 'gmx',
        chain: 'avalanche',
        primaryAddress: GMX_ADDRESSES.avalanche.vault,
        provider: mockProvider,
      };

      await registry.register(new BalancerV2Adapter(arbitrumConfig));
      await registry.register(new GmxAdapter(avalancheConfig));

      const arbitrumAdapters = registry.listAdaptersByChain('arbitrum');
      expect(arbitrumAdapters).toHaveLength(1);
      expect(arbitrumAdapters[0].chain).toBe('arbitrum');

      const avalancheAdapters = registry.listAdaptersByChain('avalanche');
      expect(avalancheAdapters).toHaveLength(1);
      expect(avalancheAdapters[0].chain).toBe('avalanche');
    });
  });

  // ===========================================================================
  // Removal
  // ===========================================================================

  describe('unregister()', () => {
    it('should remove adapter from registry', async () => {
      const config: AdapterConfig = {
        name: 'balancer_v2',
        chain: 'arbitrum',
        primaryAddress: BALANCER_VAULT_ADDRESSES.arbitrum,
        provider: mockProvider,
      };

      const adapter = new BalancerV2Adapter(config);
      await registry.register(adapter);

      expect(registry.getAdapter('balancer_v2', 'arbitrum')).toBe(adapter);

      await registry.unregister('balancer_v2', 'arbitrum');

      expect(registry.getAdapter('balancer_v2', 'arbitrum')).toBeNull();
    });

    it('should not throw when unregistering non-existent adapter', async () => {
      await expect(registry.unregister('unknown', 'unknown')).resolves.not.toThrow();
    });
  });

  describe('destroyAll()', () => {
    it('should destroy all adapters and clear registry', async () => {
      const config1: AdapterConfig = {
        name: 'balancer_v2',
        chain: 'arbitrum',
        primaryAddress: BALANCER_VAULT_ADDRESSES.arbitrum,
        provider: mockProvider,
      };

      const config2: AdapterConfig = {
        name: 'gmx',
        chain: 'avalanche',
        primaryAddress: GMX_ADDRESSES.avalanche.vault,
        provider: mockProvider,
      };

      await registry.register(new BalancerV2Adapter(config1));
      await registry.register(new GmxAdapter(config2));

      expect(registry.listAdapters()).toHaveLength(2);

      await registry.destroyAll();

      expect(registry.listAdapters()).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Singleton Pattern
  // ===========================================================================

  describe('Singleton Pattern', () => {
    beforeEach(() => {
      resetAdapterRegistry();
    });

    it('should return same instance on subsequent calls', () => {
      const instance1 = getAdapterRegistry();
      const instance2 = getAdapterRegistry();

      expect(instance1).toBe(instance2);
    });

    it('should reset singleton on resetAdapterRegistry', async () => {
      const instance1 = getAdapterRegistry();

      // Register an adapter
      const config: AdapterConfig = {
        name: 'balancer_v2',
        chain: 'arbitrum',
        primaryAddress: BALANCER_VAULT_ADDRESSES.arbitrum,
        provider: mockProvider,
      };
      await instance1.register(new BalancerV2Adapter(config));

      await resetAdapterRegistry();

      const instance2 = getAdapterRegistry();
      expect(instance2).not.toBe(instance1);
      expect(instance2.listAdapters()).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Pool Discovery Integration
  // ===========================================================================

  describe('discoverPair()', () => {
    it('should use adapter to discover pools', async () => {
      const config: AdapterConfig = {
        name: 'balancer_v2',
        chain: 'arbitrum',
        primaryAddress: BALANCER_VAULT_ADDRESSES.arbitrum,
        provider: mockProvider,
        subgraphUrl: 'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-arbitrum-v2',
      };

      const adapter = new BalancerV2Adapter(config);
      await adapter.initialize();
      await registry.register(adapter);

      const pools = await registry.discoverPair(
        'arbitrum',
        testDexConfig,
        testToken0,
        testToken1
      );

      // Even if no pools found, should return empty array (not throw)
      expect(Array.isArray(pools)).toBe(true);
    });

    it('should return empty array for unsupported DEX', async () => {
      const unsupportedDex = {
        name: 'uniswap_v2',
        chain: 'ethereum',
        factoryAddress: '0x...',
        routerAddress: '0x...',
        fee: 30,
        enabled: true,
      };

      const pools = await registry.discoverPair(
        'ethereum',
        unsupportedDex,
        testToken0,
        testToken1
      );

      expect(pools).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Health Check (P1-12)
  // ===========================================================================

  describe('checkHealth()', () => {
    it('should return health status for all registered adapters', async () => {
      const balancerConfig: AdapterConfig = {
        name: 'balancer_v2',
        chain: 'arbitrum',
        primaryAddress: BALANCER_VAULT_ADDRESSES.arbitrum,
        provider: mockProvider,
      };

      const gmxConfig: AdapterConfig = {
        name: 'gmx',
        chain: 'avalanche',
        primaryAddress: GMX_ADDRESSES.avalanche.vault,
        provider: mockProvider,
      };

      const balancerAdapter = new BalancerV2Adapter(balancerConfig);
      await balancerAdapter.initialize();
      await registry.register(balancerAdapter);

      // GMX needs token enumeration mocks for init
      const gmxProvider = createMockProvider();
      const countResult = ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [0]);
      (gmxProvider.call as jest.Mock).mockResolvedValue(countResult);
      const gmxAdapter = new GmxAdapter({ ...gmxConfig, provider: gmxProvider });
      await gmxAdapter.initialize();
      await registry.register(gmxAdapter);

      const health = await registry.checkHealth();

      expect(health.size).toBe(2);
      expect(health.get('balancer_v2:arbitrum' as any)).toBe(true);
      expect(health.get('gmx:avalanche' as any)).toBe(true);
    });

    it('should return false for unhealthy adapters', async () => {
      const failingProvider = createMockProvider();
      // Provider works for init but fails for health check later
      let callCount = 0;
      (failingProvider.getBlockNumber as jest.Mock).mockImplementation(() => {
        callCount++;
        // First call succeeds (initialization), subsequent calls fail (health check)
        if (callCount <= 1) {
          return Promise.resolve(12345678);
        }
        return Promise.reject(new Error('Connection refused'));
      });

      const config: AdapterConfig = {
        name: 'balancer_v2',
        chain: 'arbitrum',
        primaryAddress: BALANCER_VAULT_ADDRESSES.arbitrum,
        provider: failingProvider,
      };

      const adapter = new BalancerV2Adapter(config);
      await adapter.initialize();
      await registry.register(adapter);

      const health = await registry.checkHealth();

      expect(health.size).toBe(1);
      expect(health.get('balancer_v2:arbitrum' as any)).toBe(false);
    });

    it('should return empty map when no adapters registered', async () => {
      const health = await registry.checkHealth();
      expect(health.size).toBe(0);
    });

    it('should handle mixed healthy and unhealthy adapters', async () => {
      // Healthy adapter
      const healthyConfig: AdapterConfig = {
        name: 'balancer_v2',
        chain: 'arbitrum',
        primaryAddress: BALANCER_VAULT_ADDRESSES.arbitrum,
        provider: mockProvider,
      };
      const healthyAdapter = new BalancerV2Adapter(healthyConfig);
      await healthyAdapter.initialize();
      await registry.register(healthyAdapter);

      // Unhealthy adapter (provider fails after init)
      const failingProvider = createMockProvider();
      let initDone = false;
      (failingProvider.getBlockNumber as jest.Mock).mockImplementation(() => {
        if (!initDone) {
          initDone = true;
          return Promise.resolve(12345678);
        }
        return Promise.reject(new Error('Timeout'));
      });

      const unhealthyConfig: AdapterConfig = {
        name: 'balancer_v2',
        chain: 'ethereum',
        primaryAddress: BALANCER_VAULT_ADDRESSES.ethereum,
        provider: failingProvider,
      };
      const unhealthyAdapter = new BalancerV2Adapter(unhealthyConfig);
      await unhealthyAdapter.initialize();
      await registry.register(unhealthyAdapter);

      const health = await registry.checkHealth();

      expect(health.size).toBe(2);
      expect(health.get('balancer_v2:arbitrum' as any)).toBe(true);
      expect(health.get('balancer_v2:ethereum' as any)).toBe(false);
    });
  });

  // ===========================================================================
  // Adapter Key Generation
  // ===========================================================================

  describe('Adapter Key', () => {
    it('should generate consistent keys', async () => {
      const config: AdapterConfig = {
        name: 'Balancer_V2', // Mixed case
        chain: 'ARBITRUM', // Uppercase
        primaryAddress: BALANCER_VAULT_ADDRESSES.arbitrum,
        provider: mockProvider,
      };

      const adapter = new BalancerV2Adapter(config);
      await registry.register(adapter);

      // Should be case-insensitive
      const retrieved = registry.getAdapter('balancer_v2', 'arbitrum');
      expect(retrieved).toBe(adapter);
    });
  });
});
