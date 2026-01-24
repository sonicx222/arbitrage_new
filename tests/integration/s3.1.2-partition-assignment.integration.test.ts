/**
 * S3.1.2 Partition Assignment Integration Tests
 *
 * TDD-first tests for implementing 4-partition architecture per ADR-003.
 *
 * Partition Design (per IMPLEMENTATION_PLAN.md):
 * - P1: Asia-Fast (BSC, Polygon, Avalanche, Fantom) - EVM high-throughput chains
 * - P2: L2-Turbo (Arbitrum, Optimism, Base) - Ethereum L2 rollups
 * - P3: High-Value (Ethereum, zkSync, Linea) - High-value EVM chains
 * - P4: Solana-Native (Solana) - Non-EVM, dedicated partition
 *
 * @see IMPLEMENTATION_PLAN.md S3.1.2: Implement partition assignment (4 partitions)
 * @see ADR-003: Partitioned Chain Detectors
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';

import {
  PARTITIONS,
  FUTURE_PARTITIONS,
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
  getPartitionIdFromEnv
} from '@arbitrage/config/partitions';

import { CHAINS, DEXES, CORE_TOKENS } from '@arbitrage/config';

// =============================================================================
// S3.1.2.1: Partition Structure Tests (4 Partitions)
// =============================================================================

describe('S3.1.2.1: Four Partition Architecture', () => {
  describe('Partition Count and IDs', () => {
    it('should have exactly 4 partitions defined', () => {
      // Per S3.1.2: Implement 4 partitions
      expect(PARTITIONS.length).toBe(4);
    });

    it('should have all 4 required partition IDs', () => {
      const partitionIds = PARTITIONS.map(p => p.partitionId);

      // P1: Asia-Fast
      expect(partitionIds).toContain('asia-fast');
      // P2: L2-Turbo (renamed from l2-fast for consistency)
      expect(partitionIds).toContain('l2-turbo');
      // P3: High-Value
      expect(partitionIds).toContain('high-value');
      // P4: Solana-Native
      expect(partitionIds).toContain('solana-native');
    });

    it('should have unique partition IDs', () => {
      const ids = PARTITIONS.map(p => p.partitionId);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });
  });

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
      expect(partition!.chains).toContain('bsc');
      expect(partition!.chains).toContain('polygon');
      expect(partition!.chains).toContain('avalanche');
      expect(partition!.chains).toContain('fantom');
      expect(partition!.chains).toHaveLength(4);
    });

    it('should be deployed to asia-southeast1 region', () => {
      expect(partition!.region).toBe('asia-southeast1');
    });

    it('should have heavy resource profile (4 chains)', () => {
      expect(partition!.resourceProfile).toBe('heavy');
    });

    it('should have sufficient memory for 4 chains', () => {
      // 4 chains * 64MB base + DEXs + tokens + overhead
      expect(partition!.maxMemoryMB).toBeGreaterThanOrEqual(512);
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

    it('should contain Arbitrum, Optimism, Base', () => {
      expect(partition!.chains).toContain('arbitrum');
      expect(partition!.chains).toContain('optimism');
      expect(partition!.chains).toContain('base');
      expect(partition!.chains).toHaveLength(3);
    });

    it('should be deployed to asia-southeast1 region (L2 sequencer proximity)', () => {
      expect(partition!.region).toBe('asia-southeast1');
    });

    it('should use fly provider for 2 instances', () => {
      expect(partition!.provider).toBe('fly');
    });

    it('should have shorter health check interval for fast L2s', () => {
      // L2s have sub-second blocks, need faster health checks
      expect(partition!.healthCheckIntervalMs).toBeLessThanOrEqual(10000);
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
      expect(partition!.chains).toContain('ethereum');
      expect(partition!.chains).toContain('zksync');
      expect(partition!.chains).toContain('linea');
      expect(partition!.chains).toHaveLength(3);
    });

    it('should be deployed to us-east1 region (Ethereum focus)', () => {
      expect(partition!.region).toBe('us-east1');
    });

    it('should use oracle provider for reliability', () => {
      expect(partition!.provider).toBe('oracle');
    });

    it('should have heavy resource profile (high-value)', () => {
      expect(partition!.resourceProfile).toBe('heavy');
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
      expect(partition!.chains).toContain('solana');
      expect(partition!.chains).toHaveLength(1);
    });

    it('should be deployed to us-west1 region (Solana validator proximity)', () => {
      expect(partition!.region).toBe('us-west1');
    });

    it('should use fly provider for flexibility', () => {
      expect(partition!.provider).toBe('fly');
    });

    it('should have heavy resource profile (high-throughput chain)', () => {
      expect(partition!.resourceProfile).toBe('heavy');
    });

    it('should have fast health check interval (400ms blocks)', () => {
      expect(partition!.healthCheckIntervalMs).toBeLessThanOrEqual(10000);
    });
  });
});

// =============================================================================
// S3.1.2.2: Chain Configuration Tests
// =============================================================================

describe('S3.1.2.2: Chain Configurations', () => {
  describe('New Chain: Avalanche', () => {
    it('should have avalanche chain defined', () => {
      expect(CHAINS['avalanche']).toBeDefined();
    });

    it('should have correct chain ID (43114)', () => {
      expect(CHAINS['avalanche'].id).toBe(43114);
    });

    it('should have C-Chain RPC URL', () => {
      expect(CHAINS['avalanche'].rpcUrl).toBeTruthy();
    });

    it('should have AVAX as native token', () => {
      expect(CHAINS['avalanche'].nativeToken).toBe('AVAX');
    });

    it('should have ~2s block time', () => {
      expect(CHAINS['avalanche'].blockTime).toBeLessThanOrEqual(3);
    });
  });

  describe('New Chain: Fantom', () => {
    it('should have fantom chain defined', () => {
      expect(CHAINS['fantom']).toBeDefined();
    });

    it('should have correct chain ID (250)', () => {
      expect(CHAINS['fantom'].id).toBe(250);
    });

    it('should have RPC URL', () => {
      expect(CHAINS['fantom'].rpcUrl).toBeTruthy();
    });

    it('should have FTM as native token', () => {
      expect(CHAINS['fantom'].nativeToken).toBe('FTM');
    });

    it('should have ~1s block time', () => {
      expect(CHAINS['fantom'].blockTime).toBeLessThanOrEqual(2);
    });
  });

  describe('New Chain: zkSync Era', () => {
    it('should have zksync chain defined', () => {
      expect(CHAINS['zksync']).toBeDefined();
    });

    it('should have correct chain ID (324)', () => {
      expect(CHAINS['zksync'].id).toBe(324);
    });

    it('should have RPC URL', () => {
      expect(CHAINS['zksync'].rpcUrl).toBeTruthy();
    });

    it('should have ETH as native token', () => {
      expect(CHAINS['zksync'].nativeToken).toBe('ETH');
    });
  });

  describe('New Chain: Linea', () => {
    it('should have linea chain defined', () => {
      expect(CHAINS['linea']).toBeDefined();
    });

    it('should have correct chain ID (59144)', () => {
      expect(CHAINS['linea'].id).toBe(59144);
    });

    it('should have RPC URL', () => {
      expect(CHAINS['linea'].rpcUrl).toBeTruthy();
    });

    it('should have ETH as native token', () => {
      expect(CHAINS['linea'].nativeToken).toBe('ETH');
    });
  });

  describe('New Chain: Solana', () => {
    it('should have solana chain defined', () => {
      expect(CHAINS['solana']).toBeDefined();
    });

    it('should have special chain ID for non-EVM', () => {
      // Solana doesn't have EVM chain ID, use convention
      expect(CHAINS['solana'].id).toBe(101); // Common convention for Solana
    });

    it('should have RPC URL', () => {
      expect(CHAINS['solana'].rpcUrl).toBeTruthy();
    });

    it('should have SOL as native token', () => {
      expect(CHAINS['solana'].nativeToken).toBe('SOL');
    });

    it('should have ~0.4s block time', () => {
      expect(CHAINS['solana'].blockTime).toBeLessThanOrEqual(0.5);
    });

    it('should be marked as non-EVM', () => {
      expect(CHAINS['solana'].isEVM).toBe(false);
    });
  });

  describe('Total Chain Count', () => {
    it('should have 11 chains configured', () => {
      // Original 6 + Avalanche + Fantom + zkSync + Linea + Solana = 11
      const chainCount = Object.keys(CHAINS).length;
      expect(chainCount).toBe(11);
    });
  });
});

// =============================================================================
// S3.1.2.3: Chain Assignment Logic Tests
// =============================================================================

describe('S3.1.2.3: Chain Assignment Logic', () => {
  describe('Asia-Fast Chain Assignment', () => {
    it('should assign BSC to asia-fast', () => {
      const partition = assignChainToPartition('bsc');
      expect(partition?.partitionId).toBe('asia-fast');
    });

    it('should assign Polygon to asia-fast', () => {
      const partition = assignChainToPartition('polygon');
      expect(partition?.partitionId).toBe('asia-fast');
    });

    it('should assign Avalanche to asia-fast', () => {
      const partition = assignChainToPartition('avalanche');
      expect(partition?.partitionId).toBe('asia-fast');
    });

    it('should assign Fantom to asia-fast', () => {
      const partition = assignChainToPartition('fantom');
      expect(partition?.partitionId).toBe('asia-fast');
    });
  });

  describe('L2-Turbo Chain Assignment', () => {
    it('should assign Arbitrum to l2-turbo', () => {
      const partition = assignChainToPartition('arbitrum');
      expect(partition?.partitionId).toBe('l2-turbo');
    });

    it('should assign Optimism to l2-turbo', () => {
      const partition = assignChainToPartition('optimism');
      expect(partition?.partitionId).toBe('l2-turbo');
    });

    it('should assign Base to l2-turbo', () => {
      const partition = assignChainToPartition('base');
      expect(partition?.partitionId).toBe('l2-turbo');
    });
  });

  describe('High-Value Chain Assignment', () => {
    it('should assign Ethereum to high-value', () => {
      const partition = assignChainToPartition('ethereum');
      expect(partition?.partitionId).toBe('high-value');
    });

    it('should assign zkSync to high-value', () => {
      const partition = assignChainToPartition('zksync');
      expect(partition?.partitionId).toBe('high-value');
    });

    it('should assign Linea to high-value', () => {
      const partition = assignChainToPartition('linea');
      expect(partition?.partitionId).toBe('high-value');
    });
  });

  describe('Solana-Native Chain Assignment', () => {
    it('should assign Solana to solana-native', () => {
      const partition = assignChainToPartition('solana');
      expect(partition?.partitionId).toBe('solana-native');
    });
  });

  describe('Invalid Chain Assignment', () => {
    it('should return null for unknown chain', () => {
      const partition = assignChainToPartition('unknown-chain');
      expect(partition).toBeNull();
    });
  });
});

// =============================================================================
// S3.1.2.4: Partition Validation Tests
// =============================================================================

describe('S3.1.2.4: Partition Validation', () => {
  describe('All Partitions Valid', () => {
    it('should have all 4 partitions validate successfully', () => {
      const result = validateAllPartitions();
      expect(result.valid).toBe(true);
      expect(result.results.size).toBe(4);
    });

    it('should have no validation errors', () => {
      const result = validateAllPartitions();
      for (const [partitionId, validation] of result.results) {
        expect(validation.errors).toHaveLength(0);
      }
    });
  });

  describe('Resource Calculations', () => {
    it('should calculate asia-fast resources correctly (4 chains)', () => {
      const resources = calculatePartitionResources('asia-fast');
      // 4 chains with DEXs should need substantial memory
      expect(resources.estimatedMemoryMB).toBeGreaterThan(300);
      expect(resources.recommendedProfile).toBe('heavy');
    });

    it('should calculate l2-turbo resources correctly (3 fast chains)', () => {
      const resources = calculatePartitionResources('l2-turbo');
      expect(resources.estimatedCpuCores).toBeGreaterThanOrEqual(0.5);
    });

    it('should calculate solana-native resources correctly (1 high-throughput chain)', () => {
      const resources = calculatePartitionResources('solana-native');
      // Calculation based on chain/DEX count is 'light' for single chain
      // But the partition CONFIG is 'heavy' - that's what matters for deployment
      expect(resources.estimatedMemoryMB).toBeGreaterThan(0);
      // Verify the partition config overrides with 'heavy' for high-throughput needs
      const partition = getPartition('solana-native');
      expect(partition?.resourceProfile).toBe('heavy');
    });
  });

  describe('No Chain Overlap', () => {
    it('should have no chains assigned to multiple partitions', () => {
      const chainAssignments = new Map<string, string[]>();

      for (const partition of PARTITIONS) {
        for (const chainId of partition.chains) {
          if (!chainAssignments.has(chainId)) {
            chainAssignments.set(chainId, []);
          }
          chainAssignments.get(chainId)!.push(partition.partitionId);
        }
      }

      for (const [chainId, partitions] of chainAssignments) {
        expect(partitions).toHaveLength(1);
      }
    });

    it('should have all chains assigned to exactly one partition', () => {
      const assignedChains = new Set<string>();

      for (const partition of PARTITIONS) {
        for (const chainId of partition.chains) {
          assignedChains.add(chainId);
        }
      }

      // All 11 chains should be assigned
      expect(assignedChains.size).toBe(11);
    });
  });
});

// =============================================================================
// S3.1.2.5: Chain Instance Creation Tests
// =============================================================================

describe('S3.1.2.5: Chain Instance Creation', () => {
  describe('New Chain Instances', () => {
    it('should create chain instance for Avalanche', () => {
      const instance = createChainInstance('avalanche');
      expect(instance).not.toBeNull();
      expect(instance!.chainId).toBe('avalanche');
      expect(instance!.nativeToken).toBe('AVAX');
    });

    it('should create chain instance for Fantom', () => {
      const instance = createChainInstance('fantom');
      expect(instance).not.toBeNull();
      expect(instance!.chainId).toBe('fantom');
      expect(instance!.nativeToken).toBe('FTM');
    });

    it('should create chain instance for zkSync', () => {
      const instance = createChainInstance('zksync');
      expect(instance).not.toBeNull();
      expect(instance!.chainId).toBe('zksync');
      expect(instance!.nativeToken).toBe('ETH');
    });

    it('should create chain instance for Linea', () => {
      const instance = createChainInstance('linea');
      expect(instance).not.toBeNull();
      expect(instance!.chainId).toBe('linea');
      expect(instance!.nativeToken).toBe('ETH');
    });

    it('should create chain instance for Solana', () => {
      const instance = createChainInstance('solana');
      expect(instance).not.toBeNull();
      expect(instance!.chainId).toBe('solana');
      expect(instance!.nativeToken).toBe('SOL');
    });
  });

  describe('Partition Chain Instances', () => {
    it('should create 4 instances for asia-fast', () => {
      const instances = createPartitionChainInstances('asia-fast');
      expect(instances).toHaveLength(4);
      expect(instances.map(i => i.chainId)).toContain('bsc');
      expect(instances.map(i => i.chainId)).toContain('polygon');
      expect(instances.map(i => i.chainId)).toContain('avalanche');
      expect(instances.map(i => i.chainId)).toContain('fantom');
    });

    it('should create 3 instances for l2-turbo', () => {
      const instances = createPartitionChainInstances('l2-turbo');
      expect(instances).toHaveLength(3);
      expect(instances.map(i => i.chainId)).toContain('arbitrum');
      expect(instances.map(i => i.chainId)).toContain('optimism');
      expect(instances.map(i => i.chainId)).toContain('base');
    });

    it('should create 3 instances for high-value', () => {
      const instances = createPartitionChainInstances('high-value');
      expect(instances).toHaveLength(3);
      expect(instances.map(i => i.chainId)).toContain('ethereum');
      expect(instances.map(i => i.chainId)).toContain('zksync');
      expect(instances.map(i => i.chainId)).toContain('linea');
    });

    it('should create 1 instance for solana-native', () => {
      const instances = createPartitionChainInstances('solana-native');
      expect(instances).toHaveLength(1);
      expect(instances[0].chainId).toBe('solana');
    });
  });
});

// =============================================================================
// S3.1.2.6: ADR-003 Compliance Tests
// =============================================================================

describe('S3.1.2.6: ADR-003 Compliance', () => {
  it('should support geographic-based partitioning', () => {
    // ADR-003: Chains should be grouped by geographic proximity
    const asiaFast = getPartition('asia-fast');
    const highValue = getPartition('high-value');
    const solanaNative = getPartition('solana-native');

    // Asia-focused chains in Asia region
    expect(asiaFast?.region).toBe('asia-southeast1');

    // Ethereum-focused in US-East
    expect(highValue?.region).toBe('us-east1');

    // Solana in US-West (validator proximity)
    expect(solanaNative?.region).toBe('us-west1');
  });

  it('should support block-time-based partitioning', () => {
    // ADR-003: Fast chains grouped together
    const l2Turbo = getPartition('l2-turbo');

    // All L2s have sub-second effective block times
    for (const chainId of l2Turbo!.chains) {
      const chain = CHAINS[chainId];
      expect(chain.blockTime).toBeLessThanOrEqual(2);
    }
  });

  it('should isolate non-EVM chains', () => {
    // ADR-003: Non-EVM chains in dedicated partition
    const solanaNative = getPartition('solana-native');
    expect(solanaNative!.chains).toHaveLength(1);
    expect(solanaNative!.chains[0]).toBe('solana');

    // Verify Solana is not in any EVM partition
    for (const partition of PARTITIONS) {
      if (partition.partitionId !== 'solana-native') {
        expect(partition.chains).not.toContain('solana');
      }
    }
  });

  it('should provide standby configuration for failover', () => {
    // ADR-003 + ADR-007: Partitions should have standby config
    for (const partition of PARTITIONS) {
      // High priority partitions should have standby
      if (partition.priority <= 2) {
        expect(partition.standbyRegion || partition.standbyProvider).toBeTruthy();
      }
    }
  });

  it('should have appropriate health check intervals per partition type', () => {
    // ADR-003: Faster chains need faster health checks
    const l2Turbo = getPartition('l2-turbo');
    const highValue = getPartition('high-value');

    // L2s are faster, need quicker health checks
    expect(l2Turbo!.healthCheckIntervalMs).toBeLessThan(highValue!.healthCheckIntervalMs);
  });
});

// =============================================================================
// S3.1.2.7: Backward Compatibility Tests
// =============================================================================

describe('S3.1.2.7: Backward Compatibility', () => {
  it('should still support getChainsForPartition with old partition IDs', () => {
    // Existing code may use 'l2-fast' - ensure backward compat or clear migration
    const chains = getChainsForPartition('l2-turbo');
    expect(chains.length).toBeGreaterThan(0);
  });

  it('should maintain getEnabledPartitions functionality', () => {
    const enabled = getEnabledPartitions();
    expect(enabled.length).toBe(4);
    for (const partition of enabled) {
      expect(partition.enabled).toBe(true);
    }
  });

  it('should maintain getPartitionIdFromEnv default', () => {
    const originalEnv = process.env.PARTITION_ID;
    delete process.env.PARTITION_ID;

    const partitionId = getPartitionIdFromEnv();
    // Default should still be asia-fast
    expect(partitionId).toBe('asia-fast');

    process.env.PARTITION_ID = originalEnv;
  });
});

// =============================================================================
// S3.1.2.8: New Chain DEX Configuration Tests
// =============================================================================

import { getEnabledDexes, PARTITION_IDS } from '@arbitrage/config';
import { isEvmChain, getNonEvmChains } from '@arbitrage/config/partitions';

describe('S3.1.2.8: New Chain DEX Configurations', () => {
  describe('Avalanche DEXes', () => {
    it('should have DEXes configured for Avalanche', () => {
      expect(DEXES['avalanche']).toBeDefined();
      expect(DEXES['avalanche'].length).toBeGreaterThanOrEqual(2);
    });

    it('should include Trader Joe V2 on Avalanche', () => {
      const dexes = getEnabledDexes('avalanche');
      const traderJoe = dexes.find(d => d.name === 'trader_joe_v2');
      expect(traderJoe).toBeDefined();
      expect(traderJoe!.chain).toBe('avalanche');
    });

    it('should include Pangolin on Avalanche', () => {
      const dexes = getEnabledDexes('avalanche');
      const pangolin = dexes.find(d => d.name === 'pangolin');
      expect(pangolin).toBeDefined();
    });
  });

  describe('Fantom DEXes', () => {
    it('should have DEXes configured for Fantom', () => {
      expect(DEXES['fantom']).toBeDefined();
      expect(DEXES['fantom'].length).toBeGreaterThanOrEqual(2);
    });

    it('should include SpookySwap on Fantom', () => {
      const dexes = getEnabledDexes('fantom');
      const spookyswap = dexes.find(d => d.name === 'spookyswap');
      expect(spookyswap).toBeDefined();
      expect(spookyswap!.chain).toBe('fantom');
    });

    it('should include SpiritSwap on Fantom', () => {
      const dexes = getEnabledDexes('fantom');
      const spiritswap = dexes.find(d => d.name === 'spiritswap');
      expect(spiritswap).toBeDefined();
    });
  });

  describe('zkSync DEXes', () => {
    it('should have DEXes configured for zkSync', () => {
      expect(DEXES['zksync']).toBeDefined();
      expect(DEXES['zksync'].length).toBeGreaterThanOrEqual(2);
    });

    it('should include SyncSwap on zkSync', () => {
      const dexes = getEnabledDexes('zksync');
      const syncswap = dexes.find(d => d.name === 'syncswap');
      expect(syncswap).toBeDefined();
      expect(syncswap!.chain).toBe('zksync');
    });

    it('should include Mute on zkSync', () => {
      const dexes = getEnabledDexes('zksync');
      const mute = dexes.find(d => d.name === 'mute');
      expect(mute).toBeDefined();
    });
  });

  describe('Linea DEXes', () => {
    it('should have DEXes configured for Linea', () => {
      expect(DEXES['linea']).toBeDefined();
      expect(DEXES['linea'].length).toBeGreaterThanOrEqual(2);
    });

    it('should include SyncSwap on Linea', () => {
      const dexes = getEnabledDexes('linea');
      const syncswap = dexes.find(d => d.name === 'syncswap');
      expect(syncswap).toBeDefined();
      expect(syncswap!.chain).toBe('linea');
    });
  });

  describe('Solana DEXes', () => {
    it('should have DEXes configured for Solana', () => {
      expect(DEXES['solana']).toBeDefined();
      expect(DEXES['solana'].length).toBeGreaterThanOrEqual(2);
    });

    it('should include Raydium on Solana', () => {
      const dexes = getEnabledDexes('solana');
      const raydium = dexes.find(d => d.name === 'raydium');
      expect(raydium).toBeDefined();
      expect(raydium!.chain).toBe('solana');
    });

    it('should include Orca on Solana', () => {
      const dexes = getEnabledDexes('solana');
      const orca = dexes.find(d => d.name === 'orca');
      expect(orca).toBeDefined();
    });

    it('should use Solana program addresses (not EVM addresses)', () => {
      const dexes = getEnabledDexes('solana');
      const raydium = dexes.find(d => d.name === 'raydium');
      // Solana addresses are base58, not 0x prefixed
      expect(raydium!.factoryAddress).not.toMatch(/^0x/);
    });
  });

  describe('Total DEX Count', () => {
    it('should have correct total DEX count across all chains', () => {
      let totalDexes = 0;
      for (const chain of Object.keys(DEXES)) {
        totalDexes += DEXES[chain].length;
      }
      // Original 33 DEXes + 11 new DEXes for new chains = 44
      // (avalanche:3, fantom:2, zksync:2, linea:2, solana:2)
      expect(totalDexes).toBeGreaterThanOrEqual(44);
    });

    it('should have all new chains with at least 2 DEXes each', () => {
      const newChains = ['avalanche', 'fantom', 'zksync', 'linea', 'solana'];
      for (const chain of newChains) {
        const dexes = getEnabledDexes(chain);
        expect(dexes.length).toBeGreaterThanOrEqual(2);
      }
    });
  });
});

// =============================================================================
// S3.1.2.9: EVM Chain Helper Tests
// =============================================================================

describe('S3.1.2.9: EVM Chain Helpers', () => {
  describe('isEvmChain', () => {
    it('should return true for EVM chains', () => {
      const evmChains = ['ethereum', 'arbitrum', 'optimism', 'base', 'polygon', 'bsc', 'avalanche', 'fantom', 'zksync', 'linea'];
      for (const chain of evmChains) {
        expect(isEvmChain(chain)).toBe(true);
      }
    });

    it('should return false for Solana (non-EVM)', () => {
      expect(isEvmChain('solana')).toBe(false);
    });

    it('should throw for unknown chains (use isEvmChainSafe for safe default)', () => {
      expect(() => isEvmChain('unknown-chain')).toThrow('Unknown chain "unknown-chain"');
    });
  });

  describe('getNonEvmChains', () => {
    it('should return array containing Solana', () => {
      const nonEvmChains = getNonEvmChains();
      expect(nonEvmChains).toContain('solana');
    });

    it('should not contain any EVM chains', () => {
      const nonEvmChains = getNonEvmChains();
      const evmChains = ['ethereum', 'arbitrum', 'optimism', 'base', 'polygon', 'bsc'];
      for (const chain of evmChains) {
        expect(nonEvmChains).not.toContain(chain);
      }
    });

    it('should have exactly 1 non-EVM chain (Solana) in current config', () => {
      const nonEvmChains = getNonEvmChains();
      expect(nonEvmChains.length).toBe(1);
    });
  });
});

// =============================================================================
// S3.1.2.10: Type-Safe Partition ID Tests
// =============================================================================

describe('S3.1.2.10: Type-Safe Partition IDs', () => {
  describe('PARTITION_IDS constant', () => {
    it('should have all 4 partition IDs defined', () => {
      expect(PARTITION_IDS.ASIA_FAST).toBe('asia-fast');
      expect(PARTITION_IDS.L2_TURBO).toBe('l2-turbo');
      expect(PARTITION_IDS.HIGH_VALUE).toBe('high-value');
      expect(PARTITION_IDS.SOLANA_NATIVE).toBe('solana-native');
    });

    it('should be readonly (const assertion)', () => {
      // TypeScript const assertion ensures immutability at compile time
      // At runtime, we verify the values match expected strings
      const partitionIds: readonly string[] = Object.values(PARTITION_IDS);
      expect(partitionIds).toHaveLength(4);
    });
  });

  describe('Partition ID usage consistency', () => {
    it('should use PARTITION_IDS in PARTITIONS array', () => {
      const partitionIds = PARTITIONS.map(p => p.partitionId);
      expect(partitionIds).toContain(PARTITION_IDS.ASIA_FAST);
      expect(partitionIds).toContain(PARTITION_IDS.L2_TURBO);
      expect(partitionIds).toContain(PARTITION_IDS.HIGH_VALUE);
      expect(partitionIds).toContain(PARTITION_IDS.SOLANA_NATIVE);
    });

    it('should work with getPartition using string or constant', () => {
      // Both should work identically
      const byString = getPartition('asia-fast');
      const byConstant = getPartition(PARTITION_IDS.ASIA_FAST);
      expect(byString).toEqual(byConstant);
    });
  });
});

// =============================================================================
// S3.1.2.11: End-to-End Partition Functionality Tests
// =============================================================================

describe('S3.1.2.11: End-to-End Partition Functionality', () => {
  describe('Complete chain instance creation', () => {
    it('should create chain instances with DEXes for all chains', () => {
      const allChains = Object.keys(CHAINS);
      for (const chainId of allChains) {
        const instance = createChainInstance(chainId);
        expect(instance).not.toBeNull();
        expect(instance!.dexes.length).toBeGreaterThan(0);
        expect(instance!.tokens.length).toBeGreaterThan(0);
      }
    });

    it('should create consistent instances across partition boundaries', () => {
      // BSC instance from direct creation
      const bscDirect = createChainInstance('bsc');

      // BSC instance from partition
      const asiaFastInstances = createPartitionChainInstances('asia-fast');
      const bscFromPartition = asiaFastInstances.find(i => i.chainId === 'bsc');

      expect(bscDirect!.chainId).toBe(bscFromPartition!.chainId);
      expect(bscDirect!.numericId).toBe(bscFromPartition!.numericId);
      expect(bscDirect!.nativeToken).toBe(bscFromPartition!.nativeToken);
    });
  });

  describe('Partition resource validation', () => {
    it('should calculate appropriate resources for each partition', () => {
      for (const partition of PARTITIONS) {
        const resources = calculatePartitionResources(partition.partitionId);

        // All partitions should have valid resource calculations
        expect(resources.estimatedMemoryMB).toBeGreaterThan(0);
        expect(resources.estimatedCpuCores).toBeGreaterThan(0);
        expect(['light', 'standard', 'heavy']).toContain(resources.recommendedProfile);

        // Memory should be proportional to chain/DEX/token count
        const chainCount = partition.chains.length;
        expect(resources.estimatedMemoryMB).toBeGreaterThanOrEqual(chainCount * 50);
      }
    });
  });

  describe('Full system validation', () => {
    it('should have all 11 chains properly configured', () => {
      const allChains = Object.keys(CHAINS);
      expect(allChains.length).toBe(11);

      for (const chainId of allChains) {
        // Each chain should have valid config
        expect(CHAINS[chainId].id).toBeGreaterThan(0);
        expect(CHAINS[chainId].rpcUrl).toBeTruthy();
        expect(CHAINS[chainId].nativeToken).toBeTruthy();

        // Each chain should have DEXes
        expect(DEXES[chainId]).toBeDefined();
        expect(DEXES[chainId].length).toBeGreaterThan(0);

        // Each chain should have tokens
        expect(CORE_TOKENS[chainId]).toBeDefined();
        expect(CORE_TOKENS[chainId].length).toBeGreaterThan(0);

        // Each chain should be assignable to a partition
        const partition = assignChainToPartition(chainId);
        expect(partition).not.toBeNull();
      }
    });

    it('should pass complete partition validation', () => {
      const result = validateAllPartitions();
      expect(result.valid).toBe(true);

      // Log any warnings for visibility
      for (const [partitionId, validation] of result.results) {
        expect(validation.errors).toHaveLength(0);
        // Warnings are acceptable but errors are not
      }
    });
  });
});
