/**
 * Unit Tests for Partition Configuration
 *
 * Tests the partition configuration system including:
 * - PartitionConfig validation
 * - Chain assignment logic
 * - Resource calculation
 * - Environment variable parsing
 *
 * @see ADR-003: Partitioned Chain Detectors
 */

import {
  PARTITIONS,
  FUTURE_PARTITIONS,
  PartitionConfig,
  ChainInstance,
  assignChainToPartition,
  getPartition,
  getEnabledPartitions,
  getChainsForPartition,
  createChainInstance,
  createPartitionChainInstances,
  calculatePartitionResources,
  validatePartitionConfig,
  validateAllPartitions,
  getPartitionIdFromEnv,
  getPartitionFromEnv,
  getChainsFromEnv
} from './partitions';

describe('PartitionConfig', () => {
  describe('PARTITIONS constant', () => {
    it('should have at least 3 partitions defined', () => {
      expect(PARTITIONS.length).toBeGreaterThanOrEqual(3);
    });

    it('should have unique partition IDs', () => {
      const ids = PARTITIONS.map(p => p.partitionId);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it('should have asia-fast partition with BSC and Polygon', () => {
      const asiaFast = PARTITIONS.find(p => p.partitionId === 'asia-fast');
      expect(asiaFast).toBeDefined();
      expect(asiaFast!.chains).toContain('bsc');
      expect(asiaFast!.chains).toContain('polygon');
    });

    it('should have l2-fast partition with L2 chains', () => {
      const l2Fast = PARTITIONS.find(p => p.partitionId === 'l2-fast');
      expect(l2Fast).toBeDefined();
      expect(l2Fast!.chains).toContain('arbitrum');
      expect(l2Fast!.chains).toContain('optimism');
      expect(l2Fast!.chains).toContain('base');
    });

    it('should have high-value partition with Ethereum', () => {
      const highValue = PARTITIONS.find(p => p.partitionId === 'high-value');
      expect(highValue).toBeDefined();
      expect(highValue!.chains).toContain('ethereum');
    });

    it('should have all partitions enabled', () => {
      for (const partition of PARTITIONS) {
        expect(partition.enabled).toBe(true);
      }
    });

    it('should have valid resource profiles', () => {
      const validProfiles = ['light', 'standard', 'heavy'];
      for (const partition of PARTITIONS) {
        expect(validProfiles).toContain(partition.resourceProfile);
      }
    });

    it('should have valid regions', () => {
      const validRegions = ['asia-southeast1', 'us-east1', 'us-west1', 'eu-west1'];
      for (const partition of PARTITIONS) {
        expect(validRegions).toContain(partition.region);
      }
    });

    it('should have valid providers', () => {
      const validProviders = ['fly', 'oracle', 'railway', 'render', 'koyeb', 'gcp'];
      for (const partition of PARTITIONS) {
        expect(validProviders).toContain(partition.provider);
      }
    });
  });

  describe('FUTURE_PARTITIONS constant', () => {
    it('should have all partitions disabled', () => {
      for (const partition of FUTURE_PARTITIONS) {
        expect(partition.enabled).toBe(false);
      }
    });

    it('should include expanded chain lists', () => {
      const expanded = FUTURE_PARTITIONS.find(p => p.partitionId === 'asia-fast-expanded');
      expect(expanded).toBeDefined();
      expect(expanded!.chains.length).toBeGreaterThan(2);
    });
  });
});

describe('assignChainToPartition', () => {
  it('should assign BSC to asia-fast partition', () => {
    const partition = assignChainToPartition('bsc');
    expect(partition).toBeDefined();
    expect(partition!.partitionId).toBe('asia-fast');
  });

  it('should assign Polygon to asia-fast partition', () => {
    const partition = assignChainToPartition('polygon');
    expect(partition).toBeDefined();
    expect(partition!.partitionId).toBe('asia-fast');
  });

  it('should assign Arbitrum to l2-fast partition', () => {
    const partition = assignChainToPartition('arbitrum');
    expect(partition).toBeDefined();
    expect(partition!.partitionId).toBe('l2-fast');
  });

  it('should assign Optimism to l2-fast partition', () => {
    const partition = assignChainToPartition('optimism');
    expect(partition).toBeDefined();
    expect(partition!.partitionId).toBe('l2-fast');
  });

  it('should assign Base to l2-fast partition', () => {
    const partition = assignChainToPartition('base');
    expect(partition).toBeDefined();
    expect(partition!.partitionId).toBe('l2-fast');
  });

  it('should assign Ethereum to high-value partition', () => {
    const partition = assignChainToPartition('ethereum');
    expect(partition).toBeDefined();
    expect(partition!.partitionId).toBe('high-value');
  });

  it('should return null for unknown chain', () => {
    const partition = assignChainToPartition('unknown-chain');
    expect(partition).toBeNull();
  });
});

describe('getPartition', () => {
  it('should return partition by ID', () => {
    const partition = getPartition('asia-fast');
    expect(partition).toBeDefined();
    expect(partition!.partitionId).toBe('asia-fast');
  });

  it('should return undefined for unknown partition', () => {
    const partition = getPartition('unknown-partition');
    expect(partition).toBeUndefined();
  });
});

describe('getEnabledPartitions', () => {
  it('should return only enabled partitions', () => {
    const enabled = getEnabledPartitions();
    expect(enabled.length).toBeGreaterThan(0);
    for (const partition of enabled) {
      expect(partition.enabled).toBe(true);
    }
  });

  it('should not include disabled partitions', () => {
    const enabled = getEnabledPartitions();
    const ids = enabled.map(p => p.partitionId);
    for (const future of FUTURE_PARTITIONS) {
      expect(ids).not.toContain(future.partitionId);
    }
  });
});

describe('getChainsForPartition', () => {
  it('should return chains for asia-fast partition', () => {
    const chains = getChainsForPartition('asia-fast');
    expect(chains).toContain('bsc');
    expect(chains).toContain('polygon');
  });

  it('should return chains for l2-fast partition', () => {
    const chains = getChainsForPartition('l2-fast');
    expect(chains).toContain('arbitrum');
    expect(chains).toContain('optimism');
    expect(chains).toContain('base');
  });

  it('should return empty array for unknown partition', () => {
    const chains = getChainsForPartition('unknown');
    expect(chains).toEqual([]);
  });
});

describe('createChainInstance', () => {
  it('should create chain instance for BSC', () => {
    const instance = createChainInstance('bsc');
    expect(instance).toBeDefined();
    expect(instance!.chainId).toBe('bsc');
    expect(instance!.numericId).toBe(56);
    expect(instance!.nativeToken).toBe('BNB');
    expect(instance!.status).toBe('disconnected');
  });

  it('should create chain instance for Ethereum', () => {
    const instance = createChainInstance('ethereum');
    expect(instance).toBeDefined();
    expect(instance!.chainId).toBe('ethereum');
    expect(instance!.numericId).toBe(1);
    expect(instance!.nativeToken).toBe('ETH');
  });

  it('should create chain instance for Arbitrum', () => {
    const instance = createChainInstance('arbitrum');
    expect(instance).toBeDefined();
    expect(instance!.chainId).toBe('arbitrum');
    expect(instance!.numericId).toBe(42161);
    expect(instance!.blockTime).toBe(0.25);
  });

  it('should include DEX names in instance', () => {
    const instance = createChainInstance('bsc');
    expect(instance!.dexes.length).toBeGreaterThan(0);
    expect(instance!.dexes).toContain('pancakeswap_v3');
  });

  it('should include token symbols in instance', () => {
    const instance = createChainInstance('bsc');
    expect(instance!.tokens.length).toBeGreaterThan(0);
    expect(instance!.tokens).toContain('WBNB');
  });

  it('should return null for unknown chain', () => {
    const instance = createChainInstance('unknown');
    expect(instance).toBeNull();
  });
});

describe('createPartitionChainInstances', () => {
  it('should create instances for all chains in partition', () => {
    const instances = createPartitionChainInstances('asia-fast');
    expect(instances.length).toBe(2); // BSC and Polygon
    expect(instances.map(i => i.chainId)).toContain('bsc');
    expect(instances.map(i => i.chainId)).toContain('polygon');
  });

  it('should create instances for L2 partition', () => {
    const instances = createPartitionChainInstances('l2-fast');
    expect(instances.length).toBe(3); // Arbitrum, Optimism, Base
    expect(instances.map(i => i.chainId)).toContain('arbitrum');
    expect(instances.map(i => i.chainId)).toContain('optimism');
    expect(instances.map(i => i.chainId)).toContain('base');
  });

  it('should return empty array for unknown partition', () => {
    const instances = createPartitionChainInstances('unknown');
    expect(instances).toEqual([]);
  });
});

describe('calculatePartitionResources', () => {
  it('should calculate resources for asia-fast partition', () => {
    const resources = calculatePartitionResources('asia-fast');
    expect(resources.estimatedMemoryMB).toBeGreaterThan(0);
    expect(resources.estimatedCpuCores).toBeGreaterThan(0);
    expect(['light', 'standard', 'heavy']).toContain(resources.recommendedProfile);
  });

  it('should calculate resources for l2-fast partition', () => {
    const resources = calculatePartitionResources('l2-fast');
    expect(resources.estimatedMemoryMB).toBeGreaterThan(0);
    // L2s have faster blocks, should need more CPU
    expect(resources.estimatedCpuCores).toBeGreaterThanOrEqual(0.5);
  });

  it('should return defaults for unknown partition', () => {
    const resources = calculatePartitionResources('unknown');
    expect(resources.estimatedMemoryMB).toBe(256);
    expect(resources.estimatedCpuCores).toBe(0.5);
    expect(resources.recommendedProfile).toBe('light');
  });
});

describe('validatePartitionConfig', () => {
  it('should validate a valid partition config', () => {
    const partition = getPartition('asia-fast')!;
    const result = validatePartitionConfig(partition);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should detect invalid partition ID', () => {
    const invalidPartition: PartitionConfig = {
      partitionId: 'ab', // Too short
      name: 'Test',
      chains: ['bsc'],
      region: 'asia-southeast1',
      provider: 'fly',
      resourceProfile: 'light',
      priority: 1,
      maxMemoryMB: 256,
      enabled: true,
      healthCheckIntervalMs: 30000,
      failoverTimeoutMs: 60000
    };

    const result = validatePartitionConfig(invalidPartition);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('should detect unknown chains', () => {
    const invalidPartition: PartitionConfig = {
      partitionId: 'test-partition',
      name: 'Test',
      chains: ['unknown-chain'],
      region: 'asia-southeast1',
      provider: 'fly',
      resourceProfile: 'light',
      priority: 1,
      maxMemoryMB: 256,
      enabled: true,
      healthCheckIntervalMs: 30000,
      failoverTimeoutMs: 60000
    };

    const result = validatePartitionConfig(invalidPartition);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('not found'))).toBe(true);
  });

  it('should warn about insufficient memory', () => {
    const partition: PartitionConfig = {
      partitionId: 'test-partition',
      name: 'Test',
      chains: ['bsc', 'polygon', 'arbitrum', 'optimism', 'base'],
      region: 'asia-southeast1',
      provider: 'fly',
      resourceProfile: 'light',
      priority: 1,
      maxMemoryMB: 100, // Too low for 5 chains
      enabled: true,
      healthCheckIntervalMs: 30000,
      failoverTimeoutMs: 60000
    };

    const result = validatePartitionConfig(partition);
    expect(result.warnings.some(w => w.includes('insufficient'))).toBe(true);
  });
});

describe('validateAllPartitions', () => {
  it('should validate all defined partitions', () => {
    const result = validateAllPartitions();
    expect(result.results.size).toBe(PARTITIONS.length);
  });

  it('should report overall validity', () => {
    const result = validateAllPartitions();
    expect(typeof result.valid).toBe('boolean');
  });
});

describe('Environment Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('getPartitionIdFromEnv', () => {
    it('should return default partition ID when env not set', () => {
      delete process.env.PARTITION_ID;
      const partitionId = getPartitionIdFromEnv();
      expect(partitionId).toBe('asia-fast');
    });

    it('should return partition ID from env', () => {
      process.env.PARTITION_ID = 'l2-fast';
      const partitionId = getPartitionIdFromEnv();
      expect(partitionId).toBe('l2-fast');
    });
  });

  describe('getPartitionFromEnv', () => {
    it('should return partition config from env', () => {
      process.env.PARTITION_ID = 'high-value';
      const partition = getPartitionFromEnv();
      expect(partition).toBeDefined();
      expect(partition!.partitionId).toBe('high-value');
    });

    it('should return null for unknown partition in env', () => {
      process.env.PARTITION_ID = 'nonexistent';
      const partition = getPartitionFromEnv();
      expect(partition).toBeNull();
    });
  });

  describe('getChainsFromEnv', () => {
    it('should parse comma-separated chains from env', () => {
      process.env.PARTITION_CHAINS = 'bsc, polygon, arbitrum';
      const chains = getChainsFromEnv();
      expect(chains).toEqual(['bsc', 'polygon', 'arbitrum']);
    });

    it('should fall back to partition chains when env not set', () => {
      delete process.env.PARTITION_CHAINS;
      process.env.PARTITION_ID = 'asia-fast';
      const chains = getChainsFromEnv();
      expect(chains).toContain('bsc');
      expect(chains).toContain('polygon');
    });
  });
});
