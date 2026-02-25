/**
 * Consolidated Partition Configuration Tests
 *
 * Tests for the partition configuration system including:
 * - Partition constants (PARTITIONS, FUTURE_PARTITIONS, PARTITION_CONFIG)
 * - Chain assignment logic (assignChainToPartition)
 * - EVM chain helpers (isEvmChain, isEvmChainSafe, getNonEvmChains)
 * - Partition lookup (getPartition, getEnabledPartitions, getChainsForPartition)
 * - Chain instance creation (createChainInstance, createPartitionChainInstances)
 * - Resource calculation (calculatePartitionResources)
 * - Partition validation (validatePartitionConfig, validateAllPartitions)
 * - Environment configuration (getPartitionIdFromEnv, getPartitionFromEnv, getChainsFromEnv)
 * - 4-partition architecture (P1-P4) per ADR-003
 * - Chain configuration for all 15 chains
 * - Deployment scenarios, failover, resource allocation
 * - ADR-003 compliance
 *
 * @see ADR-003: Partitioned Chain Detectors
 * @see ADR-007: Cross-Region Failover Strategy
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from '@jest/globals';

import {
  PARTITIONS,
  FUTURE_PARTITIONS,
  PARTITION_CONFIG,
  PartitionConfig,
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
  getChainsFromEnv,
  isEvmChain,
  isEvmChainSafe,
  getNonEvmChains,
} from '../../src/partitions';

import {
  CHAINS,
  DEXES,
  CORE_TOKENS,
  PARTITION_IDS,
  getEnabledDexes,
} from '@arbitrage/config';

import {
  DegradationLevel,
  CrossRegionHealthConfig,
} from '@arbitrage/core';

// =============================================================================
// PARTITIONS Constant
// =============================================================================

describe('PARTITIONS constant', () => {
  it('should have exactly 4 partitions defined', () => {
    expect(PARTITIONS.length).toBe(4);
  });

  it('should have all 4 required partition IDs', () => {
    const ids = PARTITIONS.map(p => p.partitionId);
    expect(ids).toContain('asia-fast');
    expect(ids).toContain('l2-turbo');
    expect(ids).toContain('high-value');
    expect(ids).toContain('solana-native');
  });

  it('should have unique partition IDs', () => {
    const ids = PARTITIONS.map(p => p.partitionId);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
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

// =============================================================================
// Per-Partition Configuration Tests (P1-P4)
// =============================================================================

describe('P1: Asia-Fast Partition', () => {
  let partition: PartitionConfig | undefined;

  beforeAll(() => {
    partition = getPartition('asia-fast');
  });

  it('should exist and be enabled', () => {
    expect(partition).toBeDefined();
    expect(partition!.enabled).toBe(true);
  });

  it('should contain BSC, Polygon, Avalanche, Fantom', () => {
    expect(partition!.chains).toEqual(['bsc', 'polygon', 'avalanche', 'fantom']);
  });

  it('should be deployed to asia-southeast1 on Fly.io', () => {
    expect(partition!.region).toBe('asia-southeast1');
    expect(partition!.provider).toBe('fly');
  });

  it('should have heavy resource profile with sufficient memory', () => {
    expect(partition!.resourceProfile).toBe('heavy');
    expect(partition!.maxMemoryMB).toBe(768);
  });

  it('should have 15s health check interval', () => {
    expect(partition!.healthCheckIntervalMs).toBe(15000);
  });
});

describe('P2: L2-Turbo Partition', () => {
  let partition: PartitionConfig | undefined;

  beforeAll(() => {
    partition = getPartition('l2-turbo');
  });

  it('should exist and be enabled', () => {
    expect(partition).toBeDefined();
    expect(partition!.enabled).toBe(true);
  });

  it('should contain Arbitrum, Optimism, Base (emerging L2s removed -- placeholder addresses)', () => {
    expect(partition!.chains).toEqual(['arbitrum', 'optimism', 'base']);
  });

  it('should be deployed to asia-southeast1 on Fly.io', () => {
    expect(partition!.region).toBe('asia-southeast1');
    expect(partition!.provider).toBe('fly');
  });

  it('should have standard resource profile with 512MB memory (3 chains)', () => {
    expect(partition!.resourceProfile).toBe('standard');
    expect(partition!.maxMemoryMB).toBe(512);
  });

  it('should have fastest health check interval (10s for fast L2s)', () => {
    expect(partition!.healthCheckIntervalMs).toBe(10000);
  });
});

describe('P3: High-Value Partition', () => {
  let partition: PartitionConfig | undefined;

  beforeAll(() => {
    partition = getPartition('high-value');
  });

  it('should exist and be enabled', () => {
    expect(partition).toBeDefined();
    expect(partition!.enabled).toBe(true);
  });

  it('should contain Ethereum, zkSync, Linea', () => {
    expect(partition!.chains).toEqual(['ethereum', 'zksync', 'linea']);
  });

  it('should be deployed to us-east1 on Fly.io', () => {
    expect(partition!.region).toBe('us-east1');
    expect(partition!.provider).toBe('fly');
  });

  it('should have heavy resource profile with 768MB memory', () => {
    expect(partition!.resourceProfile).toBe('heavy');
    expect(partition!.maxMemoryMB).toBe(768);
  });

  it('should have 30s health check interval', () => {
    expect(partition!.healthCheckIntervalMs).toBe(30000);
  });
});

describe('P4: Solana-Native Partition', () => {
  let partition: PartitionConfig | undefined;

  beforeAll(() => {
    partition = getPartition('solana-native');
  });

  it('should exist and be enabled', () => {
    expect(partition).toBeDefined();
    expect(partition!.enabled).toBe(true);
  });

  it('should contain only Solana', () => {
    expect(partition!.chains).toEqual(['solana']);
  });

  it('should be deployed to us-west1 on Fly.io', () => {
    expect(partition!.region).toBe('us-west1');
    expect(partition!.provider).toBe('fly');
  });

  it('should have heavy resource profile (high-throughput chain)', () => {
    expect(partition!.resourceProfile).toBe('heavy');
  });

  it('should have fast health check interval (400ms blocks)', () => {
    expect(partition!.healthCheckIntervalMs).toBeLessThanOrEqual(10000);
  });
});

// =============================================================================
// FUTURE_PARTITIONS and PARTITION_CONFIG
// =============================================================================

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

describe('PARTITION_CONFIG immutability', () => {
  it('should have frozen arrays that cannot be mutated', () => {
    const originalLength = PARTITION_CONFIG.P1_ASIA_FAST.length;
    expect(() => {
      (PARTITION_CONFIG.P1_ASIA_FAST as string[]).push('test');
    }).toThrow();
    expect(PARTITION_CONFIG.P1_ASIA_FAST.length).toBe(originalLength);
  });

  it('should have frozen object that cannot have properties reassigned', () => {
    expect(() => {
      (PARTITION_CONFIG as any).P1_ASIA_FAST = [];
    }).toThrow();
  });
});

// =============================================================================
// Chain Assignment Logic
// =============================================================================

describe('assignChainToPartition', () => {
  it.each([
    ['bsc', 'asia-fast'],
    ['polygon', 'asia-fast'],
    ['avalanche', 'asia-fast'],
    ['fantom', 'asia-fast'],
    ['arbitrum', 'l2-turbo'],
    ['optimism', 'l2-turbo'],
    ['base', 'l2-turbo'],
    ['ethereum', 'high-value'],
    ['zksync', 'high-value'],
    ['linea', 'high-value'],
    ['solana', 'solana-native'],
  ])('should assign %s to %s partition', (chain, expectedPartition) => {
    const partition = assignChainToPartition(chain);
    expect(partition).not.toBeNull();
    expect(partition!.partitionId).toBe(expectedPartition);
  });

  it('should return null for unknown chain', () => {
    const partition = assignChainToPartition('unknown-chain');
    expect(partition).toBeNull();
  });

  it('should assign all defined chains to exactly one partition', () => {
    const allChains = new Set<string>();
    const chainToPartition = new Map<string, string>();

    for (const partition of PARTITIONS) {
      for (const chain of partition.chains) {
        if (chainToPartition.has(chain)) {
          fail(`Chain ${chain} in multiple partitions: ${chainToPartition.get(chain)} and ${partition.partitionId}`);
        }
        chainToPartition.set(chain, partition.partitionId);
        allChains.add(chain);
      }
    }

    for (const chain of allChains) {
      const assigned = assignChainToPartition(chain);
      expect(assigned).not.toBeNull();
      expect(assigned!.chains).toContain(chain);
    }
  });

  it('should have all chains assigned to exactly one partition (15 total)', () => {
    const assignedChains = new Set<string>();
    for (const partition of PARTITIONS) {
      for (const chainId of partition.chains) {
        assignedChains.add(chainId);
      }
    }
    expect(assignedChains.size).toBe(11); // 15 - 4 placeholder L2s (blast, scroll, mantle, mode)
  });
});

// =============================================================================
// EVM Chain Helpers
// =============================================================================

describe('isEvmChain', () => {
  it.each([
    ['ethereum'], ['arbitrum'], ['optimism'], ['base'],
    ['polygon'], ['bsc'], ['avalanche'], ['fantom'],
    ['zksync'], ['linea'],
  ])('should return true for EVM chain %s', (chain) => {
    expect(isEvmChain(chain)).toBe(true);
  });

  it('should return false for Solana (non-EVM)', () => {
    expect(isEvmChain('solana')).toBe(false);
  });

  it('should throw error for unknown chains', () => {
    expect(() => isEvmChain('unknown-chain')).toThrow('Unknown chain "unknown-chain"');
    expect(() => isEvmChain('')).toThrow('Unknown chain ""');
  });
});

describe('isEvmChainSafe', () => {
  it('should return true for EVM chains', () => {
    expect(isEvmChainSafe('ethereum')).toBe(true);
    expect(isEvmChainSafe('arbitrum')).toBe(true);
  });

  it('should return false for non-EVM chains', () => {
    expect(isEvmChainSafe('solana')).toBe(false);
  });

  it('should return false for unknown chains (not throw)', () => {
    expect(isEvmChainSafe('unknown-chain')).toBe(false);
    expect(isEvmChainSafe('')).toBe(false);
  });
});

describe('getNonEvmChains', () => {
  it('should return Solana as the only non-EVM chain', () => {
    const nonEvm = getNonEvmChains();
    expect(nonEvm).toContain('solana');
    expect(nonEvm.length).toBe(1);
  });

  it('should not include EVM chains', () => {
    const nonEvm = getNonEvmChains();
    expect(nonEvm).not.toContain('ethereum');
    expect(nonEvm).not.toContain('arbitrum');
    expect(nonEvm).not.toContain('bsc');
  });
});

// =============================================================================
// Partition Lookup
// =============================================================================

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
  it('should return only enabled partitions (all 4)', () => {
    const enabled = getEnabledPartitions();
    expect(enabled.length).toBe(4);
    for (const partition of enabled) {
      expect(partition.enabled).toBe(true);
    }
  });

  it('should not include disabled FUTURE_PARTITIONS', () => {
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

  it('should return chains for l2-turbo partition', () => {
    const chains = getChainsForPartition('l2-turbo');
    expect(chains).toEqual(['arbitrum', 'optimism', 'base']);
  });

  it('should have matching assignments for all partitions', () => {
    for (const partition of PARTITIONS) {
      const chains = getChainsForPartition(partition.partitionId);
      expect(chains).toEqual(partition.chains);
    }
  });

  it('should return empty array for unknown partition', () => {
    const chains = getChainsForPartition('unknown');
    expect(chains).toEqual([]);
  });
});

// =============================================================================
// Chain Instance Creation
// =============================================================================

describe('createChainInstance', () => {
  it.each([
    ['bsc', 56, 'BNB'],
    ['ethereum', 1, 'ETH'],
    ['arbitrum', 42161, 'ETH'],
    ['avalanche', 43114, 'AVAX'],
    ['fantom', 250, 'FTM'],
    ['zksync', 324, 'ETH'],
    ['linea', 59144, 'ETH'],
    ['solana', 101, 'SOL'],
  ])('should create instance for %s with chainId=%d and nativeToken=%s', (chain, numericId, nativeToken) => {
    const instance = createChainInstance(chain);
    expect(instance).not.toBeNull();
    expect(instance!.chainId).toBe(chain);
    expect(instance!.numericId).toBe(numericId);
    expect(instance!.nativeToken).toBe(nativeToken);
  });

  it('should include DEX names and tokens in BSC instance', () => {
    const instance = createChainInstance('bsc');
    expect(instance!.dexes.length).toBeGreaterThan(0);
    expect(instance!.dexes).toContain('pancakeswap_v3');
    expect(instance!.tokens.length).toBeGreaterThan(0);
    expect(instance!.tokens).toContain('WBNB');
  });

  it('should have disconnected status initially', () => {
    const instance = createChainInstance('bsc');
    expect(instance!.status).toBe('disconnected');
  });

  it('should return null for unknown chain', () => {
    const instance = createChainInstance('unknown');
    expect(instance).toBeNull();
  });
});

describe('createPartitionChainInstances', () => {
  it.each([
    ['asia-fast', 4, ['bsc', 'polygon', 'avalanche', 'fantom']],
    ['l2-turbo', 3, ['arbitrum', 'optimism', 'base']],
    ['high-value', 3, ['ethereum', 'zksync', 'linea']],
    ['solana-native', 1, ['solana']],
  ])('should create %d instances for %s partition', (partitionId, expectedCount, expectedChains) => {
    const instances = createPartitionChainInstances(partitionId);
    expect(instances).toHaveLength(expectedCount);
    for (const chain of expectedChains) {
      expect(instances.map(i => i.chainId)).toContain(chain);
    }
  });

  it('should return empty array for unknown partition', () => {
    const instances = createPartitionChainInstances('unknown');
    expect(instances).toEqual([]);
  });

  it('should create consistent instances across partition boundaries', () => {
    const bscDirect = createChainInstance('bsc');
    const asiaFastInstances = createPartitionChainInstances('asia-fast');
    const bscFromPartition = asiaFastInstances.find(i => i.chainId === 'bsc');

    expect(bscDirect!.chainId).toBe(bscFromPartition!.chainId);
    expect(bscDirect!.numericId).toBe(bscFromPartition!.numericId);
    expect(bscDirect!.nativeToken).toBe(bscFromPartition!.nativeToken);
  });

  it('should create valid chain instances with URLs and DEXes for all partitions', () => {
    for (const partition of PARTITIONS) {
      const instances = createPartitionChainInstances(partition.partitionId);
      expect(instances.length).toBe(partition.chains.length);

      for (const instance of instances) {
        expect(partition.chains).toContain(instance.chainId);
        expect(instance.wsUrl).toBeDefined();
        expect(instance.rpcUrl).toBeDefined();
        expect(instance.dexes.length).toBeGreaterThan(0);
        expect(instance.tokens.length).toBeGreaterThan(0);
      }
    }
  });
});

// =============================================================================
// Resource Calculation
// =============================================================================

describe('calculatePartitionResources', () => {
  it('should calculate asia-fast resources (4 chains, heavy)', () => {
    const resources = calculatePartitionResources('asia-fast');
    expect(resources.estimatedMemoryMB).toBeGreaterThan(300);
    expect(resources.estimatedCpuCores).toBeGreaterThan(0);
    expect(resources.recommendedProfile).toBe('heavy');
  });

  it('should calculate l2-turbo resources (fast chains, more CPU)', () => {
    const resources = calculatePartitionResources('l2-turbo');
    expect(resources.estimatedMemoryMB).toBeGreaterThan(0);
    expect(resources.estimatedCpuCores).toBeGreaterThanOrEqual(0.5);
  });

  it('should return defaults for unknown partition', () => {
    const resources = calculatePartitionResources('unknown');
    expect(resources.estimatedMemoryMB).toBe(256);
    expect(resources.estimatedCpuCores).toBe(0.5);
    expect(resources.recommendedProfile).toBe('light');
  });

  it('should have resources proportional to chain/DEX/token count', () => {
    for (const partition of PARTITIONS) {
      const resources = calculatePartitionResources(partition.partitionId);
      expect(resources.estimatedMemoryMB).toBeGreaterThanOrEqual(partition.chains.length * 50);
    }
  });
});

// =============================================================================
// Partition Validation
// =============================================================================

describe('validatePartitionConfig', () => {
  it.each([
    ['asia-fast'], ['l2-turbo'], ['high-value'], ['solana-native'],
  ])('should return valid for %s partition', (partitionId) => {
    const partition = getPartition(partitionId)!;
    const result = validatePartitionConfig(partition);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should detect invalid partition ID (too short)', () => {
    const invalidPartition: PartitionConfig = {
      partitionId: 'ab',
      name: 'Test',
      chains: ['bsc'],
      region: 'asia-southeast1',
      provider: 'fly',
      resourceProfile: 'light',
      priority: 1,
      maxMemoryMB: 256,
      enabled: true,
      healthCheckIntervalMs: 30000,
      failoverTimeoutMs: 60000,
    };
    const result = validatePartitionConfig(invalidPartition);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('at least 3 characters'))).toBe(true);
  });

  it('should detect empty partition ID', () => {
    const emptyIdPartition: PartitionConfig = {
      partitionId: '',
      name: 'Empty ID',
      chains: ['bsc'],
      region: 'us-east1',
      provider: 'fly',
      resourceProfile: 'light',
      priority: 1,
      maxMemoryMB: 512,
      enabled: true,
      healthCheckIntervalMs: 15000,
      failoverTimeoutMs: 60000,
    };
    const result = validatePartitionConfig(emptyIdPartition);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('at least 3 characters'))).toBe(true);
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
      failoverTimeoutMs: 60000,
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
      maxMemoryMB: 100,
      enabled: true,
      healthCheckIntervalMs: 30000,
      failoverTimeoutMs: 60000,
    };
    const result = validatePartitionConfig(partition);
    expect(result.warnings.some(w => w.includes('insufficient'))).toBe(true);
  });

  it('should warn about duplicate chains across partitions', () => {
    const duplicatePartition: PartitionConfig = {
      partitionId: 'duplicate-test',
      name: 'Duplicate Test',
      chains: ['bsc'],
      region: 'us-east1',
      provider: 'fly',
      resourceProfile: 'light',
      priority: 1,
      maxMemoryMB: 512,
      enabled: true,
      healthCheckIntervalMs: 15000,
      failoverTimeoutMs: 60000,
    };
    const result = validatePartitionConfig(duplicatePartition);
    expect(result.warnings.some(w => w.includes('multiple partitions'))).toBe(true);
  });

  it('should detect resource mismatches (too light for many chains)', () => {
    const testPartition: PartitionConfig = {
      partitionId: 'test-mismatch',
      name: 'Test Mismatch',
      chains: ['bsc', 'polygon', 'arbitrum', 'optimism', 'base', 'ethereum'],
      region: 'asia-southeast1',
      provider: 'fly',
      resourceProfile: 'light',
      priority: 1,
      maxMemoryMB: 128,
      enabled: true,
      healthCheckIntervalMs: 30000,
      failoverTimeoutMs: 60000,
    };
    const validation = validatePartitionConfig(testPartition);
    expect(validation.warnings.length).toBeGreaterThan(0);
  });
});

describe('validateAllPartitions', () => {
  it('should validate all 4 production partitions', () => {
    const result = validateAllPartitions();
    expect(result.results.size).toBe(4);
  });

  it('should report all production partitions as valid', () => {
    const result = validateAllPartitions();
    expect(result.valid).toBe(true);
    for (const [, partResult] of result.results) {
      expect(partResult.valid).toBe(true);
      expect(partResult.errors).toHaveLength(0);
    }
  });

  it('should have entries for all partition IDs', () => {
    const result = validateAllPartitions();
    for (const partition of PARTITIONS) {
      expect(result.results.has(partition.partitionId)).toBe(true);
    }
  });
});

// =============================================================================
// Environment Configuration
// =============================================================================

describe('Environment Configuration', () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  describe('getPartitionIdFromEnv', () => {
    it('should return asia-fast as default when PARTITION_ID is not set', () => {
      delete process.env.PARTITION_ID;
      expect(getPartitionIdFromEnv()).toBe('asia-fast');
    });

    it('should return PARTITION_ID when env var is set', () => {
      process.env.PARTITION_ID = 'l2-turbo';
      expect(getPartitionIdFromEnv()).toBe('l2-turbo');
    });

    it('should return custom value when set to non-standard value', () => {
      process.env.PARTITION_ID = 'custom-partition';
      expect(getPartitionIdFromEnv()).toBe('custom-partition');
    });
  });

  describe('getPartitionFromEnv', () => {
    it('should return partition config for asia-fast by default', () => {
      delete process.env.PARTITION_ID;
      const partition = getPartitionFromEnv();
      expect(partition).toBeDefined();
      expect(partition!.partitionId).toBe('asia-fast');
    });

    it('should return partition config when PARTITION_ID is set', () => {
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
    it('should return partition chains when PARTITION_CHAINS is not set', () => {
      delete process.env.PARTITION_CHAINS;
      process.env.PARTITION_ID = 'asia-fast';
      const chains = getChainsFromEnv();
      expect(chains).toContain('bsc');
      expect(chains).toContain('polygon');
    });

    it('should parse comma-separated PARTITION_CHAINS override', () => {
      process.env.PARTITION_CHAINS = 'bsc,polygon,arbitrum';
      const chains = getChainsFromEnv();
      expect(chains).toEqual(['bsc', 'polygon', 'arbitrum']);
    });

    it('should handle spaces in comma-separated PARTITION_CHAINS', () => {
      process.env.PARTITION_CHAINS = 'bsc, polygon, arbitrum';
      const chains = getChainsFromEnv();
      expect(chains).toEqual(['bsc', 'polygon', 'arbitrum']);
    });

    it('should filter invalid chains from PARTITION_CHAINS', () => {
      process.env.PARTITION_CHAINS = 'bsc,invalid-chain,polygon';
      const chains = getChainsFromEnv();
      expect(chains).toContain('bsc');
      expect(chains).toContain('polygon');
      expect(chains).not.toContain('invalid-chain');
    });

    it('should normalize chains to lowercase', () => {
      process.env.PARTITION_CHAINS = 'BSC,POLYGON';
      const chains = getChainsFromEnv();
      expect(chains).toContain('bsc');
      expect(chains).toContain('polygon');
    });

    it('should return a copy of the chains array (not a reference)', () => {
      delete process.env.PARTITION_CHAINS;
      process.env.PARTITION_ID = 'asia-fast';
      const chains1 = getChainsFromEnv();
      const chains2 = getChainsFromEnv();
      expect(chains1).toEqual(chains2);
      expect(chains1).not.toBe(chains2);
    });

    it('should return empty array when partition is unknown and PARTITION_CHAINS not set', () => {
      delete process.env.PARTITION_CHAINS;
      process.env.PARTITION_ID = 'nonexistent';
      const chains = getChainsFromEnv();
      expect(chains).toEqual([]);
    });
  });
});

// =============================================================================
// PARTITION_IDS Type-Safe Constants
// =============================================================================

describe('PARTITION_IDS constant', () => {
  it('should have all 4 partition IDs defined', () => {
    expect(PARTITION_IDS.ASIA_FAST).toBe('asia-fast');
    expect(PARTITION_IDS.L2_TURBO).toBe('l2-turbo');
    expect(PARTITION_IDS.HIGH_VALUE).toBe('high-value');
    expect(PARTITION_IDS.SOLANA_NATIVE).toBe('solana-native');
  });

  it('should be consistent with PARTITIONS array', () => {
    const partitionIds = PARTITIONS.map(p => p.partitionId);
    expect(partitionIds).toContain(PARTITION_IDS.ASIA_FAST);
    expect(partitionIds).toContain(PARTITION_IDS.L2_TURBO);
    expect(partitionIds).toContain(PARTITION_IDS.HIGH_VALUE);
    expect(partitionIds).toContain(PARTITION_IDS.SOLANA_NATIVE);
  });

  it('should work with getPartition using string or constant', () => {
    const byString = getPartition('asia-fast');
    const byConstant = getPartition(PARTITION_IDS.ASIA_FAST);
    expect(byString).toEqual(byConstant);
  });
});

// =============================================================================
// Chain Configuration (all 15 chains)
// =============================================================================

describe('Chain Configuration', () => {
  it('should have 15 chains configured', () => {
    expect(Object.keys(CHAINS).length).toBe(15);
  });

  it.each([
    ['avalanche', 43114, 'AVAX'],
    ['fantom', 250, 'FTM'],
    ['zksync', 324, 'ETH'],
    ['linea', 59144, 'ETH'],
    ['solana', 101, 'SOL'],
  ])('should have correct config for new chain %s (id=%d, token=%s)', (chain, id, nativeToken) => {
    expect(CHAINS[chain]).toBeDefined();
    expect(CHAINS[chain].id).toBe(id);
    expect(CHAINS[chain].rpcUrl).toBeTruthy();
    expect(CHAINS[chain].nativeToken).toBe(nativeToken);
  });

  it('should have Solana marked as non-EVM', () => {
    expect(CHAINS['solana'].isEVM).toBe(false);
  });

  it('should have appropriate block times for fast chains', () => {
    expect(CHAINS['avalanche'].blockTime).toBeLessThanOrEqual(3);
    expect(CHAINS['fantom'].blockTime).toBeLessThanOrEqual(2);
    expect(CHAINS['solana'].blockTime).toBeLessThanOrEqual(0.5);
  });

  it('should have all chains properly configured with DEXes, tokens, and partition', () => {
    for (const chainId of Object.keys(CHAINS)) {
      expect(CHAINS[chainId].id).toBeGreaterThan(0);
      expect(CHAINS[chainId].rpcUrl).toBeTruthy();
      expect(CHAINS[chainId].nativeToken).toBeTruthy();
      expect(DEXES[chainId]).toBeDefined();
      expect(DEXES[chainId].length).toBeGreaterThan(0);
      expect(CORE_TOKENS[chainId]).toBeDefined();
      expect(CORE_TOKENS[chainId].length).toBeGreaterThan(0);
      expect(assignChainToPartition(chainId)).not.toBeNull();
    }
  });
});

// =============================================================================
// DEX Configuration for New Chains
// =============================================================================

describe('DEX Configuration for New Chains', () => {
  it.each([
    ['avalanche', 'trader_joe_v2'],
    ['avalanche', 'pangolin'],
    ['fantom', 'spookyswap'],
    ['fantom', 'spiritswap'],
    ['zksync', 'syncswap'],
    ['zksync', 'mute'],
    ['linea', 'syncswap'],
    ['solana', 'raydium'],
    ['solana', 'orca'],
  ])('should have %s DEX on %s', (chain, dexName) => {
    const dexes = getEnabledDexes(chain);
    const found = dexes.find(d => d.name === dexName);
    expect(found).toBeDefined();
  });

  it('should have at least 2 DEXes for each new chain', () => {
    const newChains = ['avalanche', 'fantom', 'zksync', 'linea', 'solana'];
    for (const chain of newChains) {
      expect(getEnabledDexes(chain).length).toBeGreaterThanOrEqual(2);
    }
  });

  it('should use Solana program addresses (not EVM addresses)', () => {
    const dexes = getEnabledDexes('solana');
    const raydium = dexes.find(d => d.name === 'raydium');
    expect(raydium!.factoryAddress).not.toMatch(/^0x/);
  });

  it('should have correct total DEX count (>=44)', () => {
    let totalDexes = 0;
    for (const chain of Object.keys(DEXES)) {
      totalDexes += DEXES[chain].length;
    }
    expect(totalDexes).toBeGreaterThanOrEqual(44);
  });
});

// =============================================================================
// Failover Configuration
// =============================================================================

describe('Failover Configuration', () => {
  it('should have standby regions for all partitions', () => {
    for (const partition of PARTITIONS.filter(p => p.enabled)) {
      expect(partition.standbyRegion).toBeDefined();
      expect(partition.standbyProvider).toBeDefined();
    }
  });

  it('should have different standby providers for redundancy', () => {
    for (const partition of PARTITIONS.filter(p => p.enabled)) {
      if (partition.standbyProvider) {
        expect(partition.standbyProvider).not.toBe(partition.provider);
      }
    }
  });

  it('should have failover timeouts within 30-60 seconds (ADR-007)', () => {
    for (const partition of PARTITIONS) {
      expect(partition.failoverTimeoutMs).toBeLessThanOrEqual(60000);
      expect(partition.failoverTimeoutMs).toBeGreaterThanOrEqual(30000);
    }
  });

  it('should have faster health checks for L2 than high-value', () => {
    const l2 = getPartition('l2-turbo');
    const highValue = getPartition('high-value');
    expect(l2!.healthCheckIntervalMs).toBeLessThan(highValue!.healthCheckIntervalMs);
  });
});

// =============================================================================
// Resource Allocation
// =============================================================================

describe('Resource Allocation', () => {
  it('should have total resources within reasonable limits', () => {
    let totalMemoryMB = 0;
    let totalServices = 0;

    for (const partition of PARTITIONS.filter(p => p.enabled)) {
      totalMemoryMB += partition.maxMemoryMB;
      totalServices++;
    }

    expect(totalServices).toBeLessThanOrEqual(5);
    expect(totalMemoryMB).toBeLessThanOrEqual(3072);
  });

  it('should respect Fly.io memory limit (<= 1024MB)', () => {
    const flyPartitions = PARTITIONS.filter(p => p.provider === 'fly' && p.enabled);
    for (const partition of flyPartitions) {
      expect(partition.maxMemoryMB).toBeLessThanOrEqual(1024);
    }
  });

  it('should respect Oracle Cloud free tier limits (<= 1024MB)', () => {
    const oraclePartitions = PARTITIONS.filter(p => p.provider === 'oracle' && p.enabled);
    for (const partition of oraclePartitions) {
      expect(partition.maxMemoryMB).toBeLessThanOrEqual(1024);
    }
  });
});

// =============================================================================
// ADR-003 Compliance
// =============================================================================

describe('ADR-003 Compliance', () => {
  it('should support geographic-based partitioning', () => {
    expect(getPartition('asia-fast')?.region).toBe('asia-southeast1');
    expect(getPartition('high-value')?.region).toBe('us-east1');
    expect(getPartition('solana-native')?.region).toBe('us-west1');
  });

  it('should support block-time-based partitioning (L2s <= 3s)', () => {
    const l2Turbo = getPartition('l2-turbo');
    for (const chainId of l2Turbo!.chains) {
      expect(CHAINS[chainId].blockTime).toBeLessThanOrEqual(3);
    }
  });

  it('should isolate non-EVM chains in dedicated partition', () => {
    const solanaNative = getPartition('solana-native');
    expect(solanaNative!.chains).toEqual(['solana']);

    for (const partition of PARTITIONS) {
      if (partition.partitionId !== 'solana-native') {
        expect(partition.chains).not.toContain('solana');
      }
    }
  });

  it('should have at least 2 regions for redundancy', () => {
    const regions = new Set(PARTITIONS.filter(p => p.enabled).map(p => p.region));
    expect(regions.size).toBeGreaterThanOrEqual(2);
  });

  it('should have no overlapping chains in enabled partitions', () => {
    const chainAssignments = new Map<string, string>();
    for (const partition of PARTITIONS.filter(p => p.enabled)) {
      for (const chain of partition.chains) {
        if (chainAssignments.has(chain)) {
          fail(`Chain ${chain} assigned to both ${chainAssignments.get(chain)} and ${partition.partitionId}`);
        }
        chainAssignments.set(chain, partition.partitionId);
      }
    }
    expect(chainAssignments.size).toBeGreaterThan(0);
  });
});

// =============================================================================
// Degradation Level
// =============================================================================

describe('DegradationLevel', () => {
  it('should have monotonically increasing severity', () => {
    expect(DegradationLevel.FULL_OPERATION).toBe(0);
    expect(DegradationLevel.REDUCED_CHAINS).toBe(1);
    expect(DegradationLevel.DETECTION_ONLY).toBe(2);
    expect(DegradationLevel.READ_ONLY).toBe(3);
    expect(DegradationLevel.COMPLETE_OUTAGE).toBe(4);
  });
});

// =============================================================================
// CrossRegionHealthConfig
// =============================================================================

describe('CrossRegionHealthConfig', () => {
  it('should have valid defaults for creating CrossRegionHealthManager', () => {
    const config: CrossRegionHealthConfig = {
      instanceId: 'test-1',
      regionId: 'us-east1',
      serviceName: 'unified-detector-asia-fast',
    };
    expect(config.instanceId).toBeDefined();
    expect(config.regionId).toBeDefined();
    expect(config.serviceName).toBeDefined();
  });
});
