/**
 * S3.1.7 Integration Tests: Detector Migration
 *
 * Tests for migrating from single-chain detectors to partitioned architecture:
 * - PartitionRouter: Routes chains to correct partitions
 * - Migration utilities: Deprecation warnings, coverage verification
 * - Routing verification: All chains properly assigned
 *
 * @see IMPLEMENTATION_PLAN.md S3.1.7: Migrate existing detectors
 * @see ADR-003: Partitioned Chain Detectors
 */

import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';

import {
  CHAINS,
  PARTITION_IDS,
  getEnabledDexes,
  CORE_TOKENS
} from '@arbitrage/config';

import {
  getPartition,
  getEnabledPartitions,
  assignChainToPartition,
  getChainsForPartition,
  validateAllPartitions,
  isEvmChain,
  getNonEvmChains
} from '@arbitrage/config/partitions';

// P1-1-FIX: Import PARTITION_PORTS from single source of truth
import {
  PARTITION_PORTS,
  PARTITION_SERVICE_NAMES
} from '@arbitrage/core';

// =============================================================================
// Test Constants
// =============================================================================

const ALL_CONFIGURED_CHAINS = Object.keys(CHAINS);
// P1-1-FIX: Use imported constants instead of duplicating port values
const PARTITION_SERVICE_PORTS = PARTITION_PORTS;

// =============================================================================
// S3.1.7.1: Chain Coverage Tests
// =============================================================================

describe('S3.1.7.1: Chain Coverage Verification', () => {
  describe('All chains assigned to partitions', () => {
    it('should have all 11 configured chains', () => {
      expect(ALL_CONFIGURED_CHAINS.length).toBe(11);
    });

    it('should assign every chain to a partition', () => {
      for (const chainId of ALL_CONFIGURED_CHAINS) {
        const partition = assignChainToPartition(chainId);
        expect(partition).not.toBeNull();
        expect(partition!.partitionId).toBeDefined();
      }
    });

    it('should cover all EVM chains across partitions', () => {
      const evmChains = ALL_CONFIGURED_CHAINS.filter(c => isEvmChain(c));
      expect(evmChains.length).toBe(10); // All except Solana

      for (const chainId of evmChains) {
        const partition = assignChainToPartition(chainId);
        expect(partition).not.toBeNull();
        expect(partition!.partitionId).not.toBe(PARTITION_IDS.SOLANA_NATIVE);
      }
    });

    it('should cover all non-EVM chains in Solana partition', () => {
      const nonEvmChains = getNonEvmChains();
      expect(nonEvmChains).toContain('solana');

      for (const chainId of nonEvmChains) {
        const partition = assignChainToPartition(chainId);
        expect(partition).not.toBeNull();
        expect(partition!.partitionId).toBe(PARTITION_IDS.SOLANA_NATIVE);
      }
    });

    it('should not have any chain in multiple partitions', () => {
      const chainAssignments = new Map<string, string[]>();

      const partitions = getEnabledPartitions();
      for (const partition of partitions) {
        for (const chainId of partition.chains) {
          const existing = chainAssignments.get(chainId) || [];
          existing.push(partition.partitionId);
          chainAssignments.set(chainId, existing);
        }
      }

      for (const [chainId, partitions] of chainAssignments) {
        expect(partitions.length).toBe(1);
      }
    });
  });

  describe('Partition completeness', () => {
    it('should have exactly 4 enabled partitions', () => {
      const partitions = getEnabledPartitions();
      expect(partitions.length).toBe(4);
    });

    it('should have all partition IDs defined', () => {
      expect(PARTITION_IDS.ASIA_FAST).toBe('asia-fast');
      expect(PARTITION_IDS.L2_TURBO).toBe('l2-turbo');
      expect(PARTITION_IDS.HIGH_VALUE).toBe('high-value');
      expect(PARTITION_IDS.SOLANA_NATIVE).toBe('solana-native');
    });

    it('should have correct chains in P1 (Asia-Fast)', () => {
      const chains = getChainsForPartition(PARTITION_IDS.ASIA_FAST);
      expect(chains).toEqual(['bsc', 'polygon', 'avalanche', 'fantom']);
    });

    it('should have correct chains in P2 (L2-Turbo)', () => {
      const chains = getChainsForPartition(PARTITION_IDS.L2_TURBO);
      expect(chains).toEqual(['arbitrum', 'optimism', 'base']);
    });

    it('should have correct chains in P3 (High-Value)', () => {
      const chains = getChainsForPartition(PARTITION_IDS.HIGH_VALUE);
      expect(chains).toEqual(['ethereum', 'zksync', 'linea']);
    });

    it('should have correct chains in P4 (Solana-Native)', () => {
      const chains = getChainsForPartition(PARTITION_IDS.SOLANA_NATIVE);
      expect(chains).toEqual(['solana']);
    });

    it('should pass validation for all partitions', () => {
      const { valid, results } = validateAllPartitions();
      expect(valid).toBe(true);

      for (const [partitionId, result] of results) {
        expect(result.errors).toHaveLength(0);
      }
    });
  });
});

// =============================================================================
// S3.1.7.2: Partition Router Tests
// =============================================================================

describe('S3.1.7.2: Partition Router', () => {
  describe('Chain to partition routing', () => {
    it('should route BSC to Asia-Fast partition', () => {
      const partition = assignChainToPartition('bsc');
      expect(partition!.partitionId).toBe(PARTITION_IDS.ASIA_FAST);
    });

    it('should route Polygon to Asia-Fast partition', () => {
      const partition = assignChainToPartition('polygon');
      expect(partition!.partitionId).toBe(PARTITION_IDS.ASIA_FAST);
    });

    it('should route Avalanche to Asia-Fast partition', () => {
      const partition = assignChainToPartition('avalanche');
      expect(partition!.partitionId).toBe(PARTITION_IDS.ASIA_FAST);
    });

    it('should route Fantom to Asia-Fast partition', () => {
      const partition = assignChainToPartition('fantom');
      expect(partition!.partitionId).toBe(PARTITION_IDS.ASIA_FAST);
    });

    it('should route Arbitrum to L2-Turbo partition', () => {
      const partition = assignChainToPartition('arbitrum');
      expect(partition!.partitionId).toBe(PARTITION_IDS.L2_TURBO);
    });

    it('should route Optimism to L2-Turbo partition', () => {
      const partition = assignChainToPartition('optimism');
      expect(partition!.partitionId).toBe(PARTITION_IDS.L2_TURBO);
    });

    it('should route Base to L2-Turbo partition', () => {
      const partition = assignChainToPartition('base');
      expect(partition!.partitionId).toBe(PARTITION_IDS.L2_TURBO);
    });

    it('should route Ethereum to High-Value partition', () => {
      const partition = assignChainToPartition('ethereum');
      expect(partition!.partitionId).toBe(PARTITION_IDS.HIGH_VALUE);
    });

    it('should route zkSync to High-Value partition', () => {
      const partition = assignChainToPartition('zksync');
      expect(partition!.partitionId).toBe(PARTITION_IDS.HIGH_VALUE);
    });

    it('should route Linea to High-Value partition', () => {
      const partition = assignChainToPartition('linea');
      expect(partition!.partitionId).toBe(PARTITION_IDS.HIGH_VALUE);
    });

    it('should route Solana to Solana-Native partition', () => {
      const partition = assignChainToPartition('solana');
      expect(partition!.partitionId).toBe(PARTITION_IDS.SOLANA_NATIVE);
    });

    it('should return null for unknown chains', () => {
      const partition = assignChainToPartition('unknown-chain');
      expect(partition).toBeNull();
    });
  });

  describe('Partition service ports', () => {
    it('should have unique ports for each partition', () => {
      const ports = Object.values(PARTITION_SERVICE_PORTS);
      const uniquePorts = new Set(ports);
      expect(uniquePorts.size).toBe(ports.length);
    });

    it('should have P1 on port 3001', () => {
      expect(PARTITION_SERVICE_PORTS[PARTITION_IDS.ASIA_FAST]).toBe(3001);
    });

    it('should have P2 on port 3002', () => {
      expect(PARTITION_SERVICE_PORTS[PARTITION_IDS.L2_TURBO]).toBe(3002);
    });

    it('should have P3 on port 3003', () => {
      expect(PARTITION_SERVICE_PORTS[PARTITION_IDS.HIGH_VALUE]).toBe(3003);
    });

    it('should have P4 on port 3004', () => {
      expect(PARTITION_SERVICE_PORTS[PARTITION_IDS.SOLANA_NATIVE]).toBe(3004);
    });
  });
});

// =============================================================================
// S3.1.7.3: Partition Service Configuration Tests
// =============================================================================

describe('S3.1.7.3: Partition Service Configuration', () => {
  describe('Service file structure verification', () => {
    it('should have partition-asia-fast service', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const servicePath = path.join(process.cwd(), 'services/partition-asia-fast/src/index.ts');
      expect(fs.existsSync(servicePath)).toBe(true);
    });

    it('should have partition-l2-turbo service', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const servicePath = path.join(process.cwd(), 'services/partition-l2-turbo/src/index.ts');
      expect(fs.existsSync(servicePath)).toBe(true);
    });

    it('should have partition-high-value service', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const servicePath = path.join(process.cwd(), 'services/partition-high-value/src/index.ts');
      expect(fs.existsSync(servicePath)).toBe(true);
    });

    it('should have partition-solana service', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const servicePath = path.join(process.cwd(), 'services/partition-solana/src/index.ts');
      expect(fs.existsSync(servicePath)).toBe(true);
    });
  });

  describe('Service exports verification', () => {
    it('should export P1 constants from partition-asia-fast', async () => {
      const p1Module = await import('../../services/partition-asia-fast/src/index');
      expect(p1Module.P1_PARTITION_ID).toBe('asia-fast');
      expect(p1Module.P1_CHAINS).toBeDefined();
      expect(p1Module.P1_REGION).toBeDefined();
    });

    it('should export P2 constants from partition-l2-turbo', async () => {
      const p2Module = await import('../../services/partition-l2-turbo/src/index');
      expect(p2Module.P2_PARTITION_ID).toBe('l2-turbo');
      expect(p2Module.P2_CHAINS).toBeDefined();
      expect(p2Module.P2_REGION).toBeDefined();
    });

    it('should export P3 constants from partition-high-value', async () => {
      const p3Module = await import('../../services/partition-high-value/src/index');
      expect(p3Module.P3_PARTITION_ID).toBe('high-value');
      expect(p3Module.P3_CHAINS).toBeDefined();
      expect(p3Module.P3_REGION).toBeDefined();
    });

    it('should export P4 constants from partition-solana', async () => {
      const p4Module = await import('../../services/partition-solana/src/index');
      expect(p4Module.P4_PARTITION_ID).toBe('solana-native');
      expect(p4Module.P4_CHAINS).toBeDefined();
      expect(p4Module.P4_REGION).toBeDefined();
    });
  });
});

// =============================================================================
// S3.1.7.4: Migration Utilities Tests
// =============================================================================

describe('S3.1.7.4: Migration Utilities', () => {
  let PartitionRouter: typeof import('../../shared/core/src').PartitionRouter;

  beforeAll(async () => {
    const module = await import('../../shared/core/src');
    PartitionRouter = module.PartitionRouter;
  });

  describe('PartitionRouter class', () => {
    it('should exist in shared/core exports', () => {
      expect(PartitionRouter).toBeDefined();
    });

    it('should return partition for chain', () => {
      const partition = PartitionRouter.getPartitionForChain('bsc');
      expect(partition).not.toBeNull();
      expect(partition!.partitionId).toBe(PARTITION_IDS.ASIA_FAST);
    });

    it('should return service endpoint for chain', () => {
      const endpoint = PartitionRouter.getServiceEndpoint('arbitrum');
      expect(endpoint).toBeDefined();
      expect(endpoint!.port).toBe(3002);
      expect(endpoint!.serviceName).toBe('partition-l2-turbo');
    });

    it('should return all partition endpoints', () => {
      const endpoints = PartitionRouter.getAllEndpoints();
      expect(endpoints.length).toBe(4);

      const ports = endpoints.map(e => e.port);
      expect(ports).toContain(3001);
      expect(ports).toContain(3002);
      expect(ports).toContain(3003);
      expect(ports).toContain(3004);
    });

    it('should validate chain is routable', () => {
      expect(PartitionRouter.isRoutable('bsc')).toBe(true);
      expect(PartitionRouter.isRoutable('ethereum')).toBe(true);
      expect(PartitionRouter.isRoutable('solana')).toBe(true);
      expect(PartitionRouter.isRoutable('unknown-chain')).toBe(false);
    });

    it('should get all routable chains', () => {
      const chains = PartitionRouter.getRoutableChains();
      expect(chains.length).toBe(11);
      expect(chains).toContain('bsc');
      expect(chains).toContain('ethereum');
      expect(chains).toContain('solana');
    });

    it('should get partition service name', () => {
      expect(PartitionRouter.getServiceName(PARTITION_IDS.ASIA_FAST)).toBe('partition-asia-fast');
      expect(PartitionRouter.getServiceName(PARTITION_IDS.L2_TURBO)).toBe('partition-l2-turbo');
      expect(PartitionRouter.getServiceName(PARTITION_IDS.HIGH_VALUE)).toBe('partition-high-value');
      expect(PartitionRouter.getServiceName(PARTITION_IDS.SOLANA_NATIVE)).toBe('partition-solana');
    });
  });

  describe('Deprecation utilities', () => {
    let createDeprecationWarning: typeof import('../../shared/core/src').createDeprecationWarning;
    let isDeprecatedPattern: typeof import('../../shared/core/src').isDeprecatedPattern;

    beforeAll(async () => {
      const module = await import('../../shared/core/src');
      createDeprecationWarning = module.createDeprecationWarning;
      isDeprecatedPattern = module.isDeprecatedPattern;
    });

    it('should create deprecation warning for direct chain access', () => {
      const warning = createDeprecationWarning('bsc-detector', 'partition-asia-fast');
      expect(warning).toContain('deprecated');
      expect(warning).toContain('partition-asia-fast');
    });

    it('should identify deprecated patterns', () => {
      // Old single-chain detector patterns are deprecated
      expect(isDeprecatedPattern('bsc-detector')).toBe(true);
      expect(isDeprecatedPattern('arbitrum-detector')).toBe(true);

      // Partition services are not deprecated
      expect(isDeprecatedPattern('partition-asia-fast')).toBe(false);
      expect(isDeprecatedPattern('partition-l2-turbo')).toBe(false);
    });
  });
});

// =============================================================================
// S3.1.7.5: Cross-Chain Detector Integration Tests
// =============================================================================

describe('S3.1.7.5: Cross-Chain Detector Integration', () => {
  it('should have cross-chain-detector service', async () => {
    const fs = await import('fs');
    const path = await import('path');

    const servicePath = path.join(process.cwd(), 'services/cross-chain-detector/src/detector.ts');
    expect(fs.existsSync(servicePath)).toBe(true);
  });

  it('should consume from Redis Streams (ADR-002 compliant)', async () => {
    const fs = await import('fs');
    const path = await import('path');

    const detectorPath = path.join(process.cwd(), 'services/cross-chain-detector/src/detector.ts');
    const content = fs.readFileSync(detectorPath, 'utf-8');

    // Verify it uses Redis Streams
    expect(content).toContain('RedisStreamsClient');
    expect(content).toContain('ADR-002');
  });

  it('should not extend BaseDetector (documented exception)', async () => {
    const fs = await import('fs');
    const path = await import('path');

    const detectorPath = path.join(process.cwd(), 'services/cross-chain-detector/src/detector.ts');
    const content = fs.readFileSync(detectorPath, 'utf-8');

    // Verify documented exception
    expect(content).toContain('does NOT extend BaseDetector');
    expect(content).toContain('Consumer vs Producer');
  });
});

// =============================================================================
// S3.1.7.6: DEX and Token Coverage Tests
// =============================================================================

describe('S3.1.7.6: DEX and Token Coverage', () => {
  describe('DEX coverage by partition', () => {
    it('should have DEXes configured for all P1 chains', () => {
      const p1Chains = getChainsForPartition(PARTITION_IDS.ASIA_FAST);
      for (const chainId of p1Chains) {
        const dexes = getEnabledDexes(chainId);
        expect(dexes.length).toBeGreaterThan(0);
      }
    });

    it('should have DEXes configured for all P2 chains', () => {
      const p2Chains = getChainsForPartition(PARTITION_IDS.L2_TURBO);
      for (const chainId of p2Chains) {
        const dexes = getEnabledDexes(chainId);
        expect(dexes.length).toBeGreaterThan(0);
      }
    });

    it('should have DEXes configured for all P3 chains', () => {
      const p3Chains = getChainsForPartition(PARTITION_IDS.HIGH_VALUE);
      for (const chainId of p3Chains) {
        const dexes = getEnabledDexes(chainId);
        expect(dexes.length).toBeGreaterThan(0);
      }
    });

    it('should have DEXes configured for all P4 chains', () => {
      const p4Chains = getChainsForPartition(PARTITION_IDS.SOLANA_NATIVE);
      for (const chainId of p4Chains) {
        const dexes = getEnabledDexes(chainId);
        expect(dexes.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Token coverage by partition', () => {
    it('should have tokens configured for all P1 chains', () => {
      const p1Chains = getChainsForPartition(PARTITION_IDS.ASIA_FAST);
      for (const chainId of p1Chains) {
        const tokens = CORE_TOKENS[chainId];
        expect(tokens).toBeDefined();
        expect(tokens.length).toBeGreaterThan(0);
      }
    });

    it('should have tokens configured for all P2 chains', () => {
      const p2Chains = getChainsForPartition(PARTITION_IDS.L2_TURBO);
      for (const chainId of p2Chains) {
        const tokens = CORE_TOKENS[chainId];
        expect(tokens).toBeDefined();
        expect(tokens.length).toBeGreaterThan(0);
      }
    });

    it('should have tokens configured for all P3 chains', () => {
      const p3Chains = getChainsForPartition(PARTITION_IDS.HIGH_VALUE);
      for (const chainId of p3Chains) {
        const tokens = CORE_TOKENS[chainId];
        expect(tokens).toBeDefined();
        expect(tokens.length).toBeGreaterThan(0);
      }
    });

    it('should have tokens configured for all P4 chains', () => {
      const p4Chains = getChainsForPartition(PARTITION_IDS.SOLANA_NATIVE);
      for (const chainId of p4Chains) {
        const tokens = CORE_TOKENS[chainId];
        expect(tokens).toBeDefined();
        expect(tokens.length).toBeGreaterThan(0);
      }
    });
  });
});

// =============================================================================
// S3.1.7.7: Health Check Endpoint Tests
// =============================================================================

describe('S3.1.7.7: Health Check Endpoints', () => {
  describe('Partition health endpoint configuration', () => {
    it('should have unique health check ports for all partitions', () => {
      const ports = new Set<number>();

      const partitions = getEnabledPartitions();
      for (const partition of partitions) {
        const port = PARTITION_SERVICE_PORTS[partition.partitionId];
        expect(ports.has(port)).toBe(false);
        ports.add(port);
      }

      expect(ports.size).toBe(4);
    });

    it('should have health check interval configured for all partitions', () => {
      const partitions = getEnabledPartitions();
      for (const partition of partitions) {
        expect(partition.healthCheckIntervalMs).toBeDefined();
        expect(partition.healthCheckIntervalMs).toBeGreaterThan(0);
      }
    });

    it('should have faster health checks for fast-block partitions', () => {
      const p2 = getPartition(PARTITION_IDS.L2_TURBO);
      const p4 = getPartition(PARTITION_IDS.SOLANA_NATIVE);
      const p3 = getPartition(PARTITION_IDS.HIGH_VALUE);

      // L2 and Solana have faster blocks, need faster checks
      expect(p2!.healthCheckIntervalMs).toBeLessThan(p3!.healthCheckIntervalMs);
      expect(p4!.healthCheckIntervalMs).toBeLessThan(p3!.healthCheckIntervalMs);
    });
  });
});

// =============================================================================
// S3.1.7.8: Failover Configuration Tests
// =============================================================================

describe('S3.1.7.8: Failover Configuration', () => {
  describe('Standby configuration', () => {
    it('should have standby region for all partitions', () => {
      const partitions = getEnabledPartitions();
      for (const partition of partitions) {
        expect(partition.standbyRegion).toBeDefined();
      }
    });

    it('should have standby provider for all partitions', () => {
      const partitions = getEnabledPartitions();
      for (const partition of partitions) {
        expect(partition.standbyProvider).toBeDefined();
      }
    });

    it('should have failover timeout configured', () => {
      const partitions = getEnabledPartitions();
      for (const partition of partitions) {
        expect(partition.failoverTimeoutMs).toBeDefined();
        expect(partition.failoverTimeoutMs).toBeGreaterThan(0);
      }
    });

    it('should have shorter failover for fast-block partitions', () => {
      const p2 = getPartition(PARTITION_IDS.L2_TURBO);
      const p4 = getPartition(PARTITION_IDS.SOLANA_NATIVE);
      const p3 = getPartition(PARTITION_IDS.HIGH_VALUE);

      // L2 and Solana need faster failover
      expect(p2!.failoverTimeoutMs).toBeLessThanOrEqual(p3!.failoverTimeoutMs);
      expect(p4!.failoverTimeoutMs).toBeLessThanOrEqual(p3!.failoverTimeoutMs);
    });
  });
});

// =============================================================================
// S3.1.7.9: Unified Detector Integration Tests
// =============================================================================

describe('S3.1.7.9: Unified Detector Integration', () => {
  it('should have unified-detector service', async () => {
    const fs = await import('fs');
    const path = await import('path');

    const servicePath = path.join(process.cwd(), 'services/unified-detector/src/unified-detector.ts');
    expect(fs.existsSync(servicePath)).toBe(true);
  });

  it('should use UnifiedChainDetector in all partition services', async () => {
    const fs = await import('fs');
    const path = await import('path');

    const partitionServices = [
      'partition-asia-fast',
      'partition-l2-turbo',
      'partition-high-value',
      'partition-solana'
    ];

    for (const service of partitionServices) {
      const indexPath = path.join(process.cwd(), `services/${service}/src/index.ts`);
      const content = fs.readFileSync(indexPath, 'utf-8');

      expect(content).toContain('UnifiedChainDetector');
      expect(content).toContain('UnifiedDetectorConfig');
    }
  });

  it('should have ADR-003 compliance comments in unified-detector', async () => {
    const fs = await import('fs');
    const path = await import('path');

    const detectorPath = path.join(process.cwd(), 'services/unified-detector/src/unified-detector.ts');
    const content = fs.readFileSync(detectorPath, 'utf-8');

    expect(content).toContain('ADR-003');
    expect(content).toContain('Partitioned Chain Detectors');
  });
});

// =============================================================================
// S3.1.7.10: Migration Documentation Tests
// =============================================================================

describe('S3.1.7.10: Migration Documentation', () => {
  it('should have partition architecture documented in ADR-003', async () => {
    const fs = await import('fs');
    const path = await import('path');

    const adrPath = path.join(process.cwd(), 'docs/architecture/adr/ADR-003-partitioned-detectors.md');
    const exists = fs.existsSync(adrPath);

    // ADR-003 should exist
    expect(exists).toBe(true);

    if (exists) {
      const content = fs.readFileSync(adrPath, 'utf-8');
      expect(content).toContain('partition');
    }
  });

  it('should reference partition architecture in documentation', async () => {
    const fs = await import('fs');
    const path = await import('path');

    // Architecture documentation should reference partition architecture
    const archPath = path.join(process.cwd(), 'docs/architecture/ARCHITECTURE_V2.md');
    const content = fs.readFileSync(archPath, 'utf-8');

    // Should reference partitioned architecture
    expect(content.toLowerCase()).toContain('partition');
    // Should reference ADR for partitioned detectors
    expect(content).toContain('ADR-003');
  });
});

// =============================================================================
// S3.1.7.11: Code Analysis Fix Verification Tests
// =============================================================================

describe('S3.1.7.11: Code Analysis Fix Verification', () => {
  describe('P1-1-FIX: PARTITION_PORTS single source of truth', () => {
    it('should export PARTITION_PORTS from shared/core', () => {
      expect(PARTITION_PORTS).toBeDefined();
      expect(typeof PARTITION_PORTS).toBe('object');
    });

    it('should have correct port values', () => {
      expect(PARTITION_PORTS[PARTITION_IDS.ASIA_FAST]).toBe(3001);
      expect(PARTITION_PORTS[PARTITION_IDS.L2_TURBO]).toBe(3002);
      expect(PARTITION_PORTS[PARTITION_IDS.HIGH_VALUE]).toBe(3003);
      expect(PARTITION_PORTS[PARTITION_IDS.SOLANA_NATIVE]).toBe(3004);
    });

    it('should match ports used in partition services', async () => {
      const fs = await import('fs');
      const path = await import('path');

      // P0-FIX: Test updated to match centralized port pattern
      // Ports now come from PARTITION_PORTS constant with fallback defaults

      // Verify P1 uses correct port via PARTITION_PORTS
      const p1Content = fs.readFileSync(
        path.join(process.cwd(), 'services/partition-asia-fast/src/index.ts'),
        'utf-8'
      );
      expect(p1Content).toMatch(/P1_DEFAULT_PORT.*PARTITION_PORTS.*\?\?.*3001/);

      // Verify P2 uses correct port via PARTITION_PORTS
      const p2Content = fs.readFileSync(
        path.join(process.cwd(), 'services/partition-l2-turbo/src/index.ts'),
        'utf-8'
      );
      expect(p2Content).toMatch(/P2_DEFAULT_PORT.*PARTITION_PORTS.*\?\?.*3002/);

      // Verify P3 uses correct port via PARTITION_PORTS
      const p3Content = fs.readFileSync(
        path.join(process.cwd(), 'services/partition-high-value/src/index.ts'),
        'utf-8'
      );
      expect(p3Content).toMatch(/P3_DEFAULT_PORT.*PARTITION_PORTS.*\?\?.*3003/);

      // Verify P4 uses correct port via PARTITION_PORTS
      const p4Content = fs.readFileSync(
        path.join(process.cwd(), 'services/partition-solana/src/index.ts'),
        'utf-8'
      );
      expect(p4Content).toMatch(/P4_DEFAULT_PORT.*PARTITION_PORTS.*\?\?.*3004/);
    });
  });

  describe('P1-2-FIX: PARTITION_SERVICE_NAMES single source of truth', () => {
    it('should export PARTITION_SERVICE_NAMES from shared/core', () => {
      expect(PARTITION_SERVICE_NAMES).toBeDefined();
      expect(typeof PARTITION_SERVICE_NAMES).toBe('object');
    });

    it('should have correct service names', () => {
      expect(PARTITION_SERVICE_NAMES[PARTITION_IDS.ASIA_FAST]).toBe('partition-asia-fast');
      expect(PARTITION_SERVICE_NAMES[PARTITION_IDS.L2_TURBO]).toBe('partition-l2-turbo');
      expect(PARTITION_SERVICE_NAMES[PARTITION_IDS.HIGH_VALUE]).toBe('partition-high-value');
      expect(PARTITION_SERVICE_NAMES[PARTITION_IDS.SOLANA_NATIVE]).toBe('partition-solana');
    });

    it('should match service directory names', async () => {
      const fs = await import('fs');
      const path = await import('path');

      for (const [partitionId, serviceName] of Object.entries(PARTITION_SERVICE_NAMES)) {
        const servicePath = path.join(process.cwd(), `services/${serviceName}`);
        expect(fs.existsSync(servicePath)).toBe(true);
      }
    });
  });

  describe('P2-1-FIX: Dynamic deprecation detection', () => {
    let isDeprecatedPattern: typeof import('../../shared/core/src').isDeprecatedPattern;

    beforeAll(async () => {
      const module = await import('../../shared/core/src');
      isDeprecatedPattern = module.isDeprecatedPattern;
    });

    it('should detect all configured chains as deprecated when using -detector suffix', () => {
      const chains = Object.keys(CHAINS);
      for (const chainId of chains) {
        const deprecatedName = `${chainId}-detector`;
        expect(isDeprecatedPattern(deprecatedName)).toBe(true);
      }
    });

    it('should NOT flag unknown chains as deprecated (dynamic check)', () => {
      // These are not real chains, so should NOT be flagged
      expect(isDeprecatedPattern('fakecoin-detector')).toBe(false);
      expect(isDeprecatedPattern('testnet-detector')).toBe(false);
      expect(isDeprecatedPattern('mychain-detector')).toBe(false);
    });

    it('should NOT flag partition services as deprecated', () => {
      for (const serviceName of Object.values(PARTITION_SERVICE_NAMES)) {
        expect(isDeprecatedPattern(serviceName)).toBe(false);
      }
    });
  });

  describe('P2-2-FIX: Standardized null return type', () => {
    let PartitionRouter: typeof import('../../shared/core/src').PartitionRouter;

    beforeAll(async () => {
      const module = await import('../../shared/core/src');
      PartitionRouter = module.PartitionRouter;
    });

    it('should return null (not undefined) for unknown chains', () => {
      const endpoint = PartitionRouter.getServiceEndpoint('unknown-chain');
      expect(endpoint).toBeNull();
      expect(endpoint).not.toBeUndefined();
    });

    it('should return null (not undefined) for empty string', () => {
      const endpoint = PartitionRouter.getServiceEndpoint('');
      expect(endpoint).toBeNull();
    });

    it('should be consistent with getPartitionForChain return type', () => {
      const partition = PartitionRouter.getPartitionForChain('unknown');
      const endpoint = PartitionRouter.getServiceEndpoint('unknown');

      // Both should return null for unknown chains
      expect(partition).toBeNull();
      expect(endpoint).toBeNull();
    });
  });

  describe('P3-1-FIX: DRY endpoint creation', () => {
    let PartitionRouter: typeof import('../../shared/core/src').PartitionRouter;

    beforeAll(async () => {
      const module = await import('../../shared/core/src');
      PartitionRouter = module.PartitionRouter;
    });

    it('should return consistent endpoint structure from getServiceEndpoint', () => {
      const endpoint = PartitionRouter.getServiceEndpoint('bsc');
      expect(endpoint).toHaveProperty('partitionId');
      expect(endpoint).toHaveProperty('serviceName');
      expect(endpoint).toHaveProperty('port');
      expect(endpoint).toHaveProperty('chains');
      expect(endpoint).toHaveProperty('region');
      expect(endpoint).toHaveProperty('provider');
    });

    it('should return consistent endpoint structure from getAllEndpoints', () => {
      const endpoints = PartitionRouter.getAllEndpoints();
      for (const endpoint of endpoints) {
        expect(endpoint).toHaveProperty('partitionId');
        expect(endpoint).toHaveProperty('serviceName');
        expect(endpoint).toHaveProperty('port');
        expect(endpoint).toHaveProperty('chains');
        expect(endpoint).toHaveProperty('region');
        expect(endpoint).toHaveProperty('provider');
      }
    });

    it('should have identical structure between methods', () => {
      const directEndpoint = PartitionRouter.getServiceEndpoint('arbitrum');
      const allEndpoints = PartitionRouter.getAllEndpoints();
      const fromAllEndpoints = allEndpoints.find(e => e.partitionId === PARTITION_IDS.L2_TURBO);

      expect(directEndpoint!.partitionId).toBe(fromAllEndpoints!.partitionId);
      expect(directEndpoint!.serviceName).toBe(fromAllEndpoints!.serviceName);
      expect(directEndpoint!.port).toBe(fromAllEndpoints!.port);
      expect(directEndpoint!.region).toBe(fromAllEndpoints!.region);
      expect(directEndpoint!.provider).toBe(fromAllEndpoints!.provider);
    });
  });

  describe('P3-2-FIX: Array copy to prevent mutation', () => {
    let PartitionRouter: typeof import('../../shared/core/src').PartitionRouter;

    beforeAll(async () => {
      const module = await import('../../shared/core/src');
      PartitionRouter = module.PartitionRouter;
    });

    it('should return different array instances for chains', () => {
      const endpoint1 = PartitionRouter.getServiceEndpoint('ethereum');
      const endpoint2 = PartitionRouter.getServiceEndpoint('ethereum');

      // Should be equal in content
      expect(endpoint1!.chains).toEqual(endpoint2!.chains);

      // But NOT the same array instance (copy protection)
      expect(endpoint1!.chains).not.toBe(endpoint2!.chains);
    });

    it('should not mutate original partition chains when endpoint chains modified', () => {
      const endpoint = PartitionRouter.getServiceEndpoint('bsc');
      const originalLength = endpoint!.chains.length;

      // Mutate the returned chains array
      endpoint!.chains.push('fake-chain');

      // Get a new endpoint and verify original data is unchanged
      const newEndpoint = PartitionRouter.getServiceEndpoint('bsc');
      expect(newEndpoint!.chains.length).toBe(originalLength);
      expect(newEndpoint!.chains).not.toContain('fake-chain');
    });
  });
});

// =============================================================================
// S3.1.7.12: Regression Tests
// =============================================================================

describe('S3.1.7.12: Regression Tests', () => {
  describe('Port consistency across codebase', () => {
    it('should have no port conflicts between partitions', () => {
      const ports = Object.values(PARTITION_PORTS);
      const uniquePorts = new Set(ports);
      expect(uniquePorts.size).toBe(ports.length);
    });

    it('should have ports in valid range (1024-65535)', () => {
      for (const port of Object.values(PARTITION_PORTS)) {
        expect(port).toBeGreaterThanOrEqual(1024);
        expect(port).toBeLessThanOrEqual(65535);
      }
    });

    it('should not use common reserved ports', () => {
      const reservedPorts = [80, 443, 8080, 8443, 3000]; // Common web ports
      for (const port of Object.values(PARTITION_PORTS)) {
        expect(reservedPorts).not.toContain(port);
      }
    });
  });

  describe('Service name consistency', () => {
    it('should follow partition-* naming convention', () => {
      for (const serviceName of Object.values(PARTITION_SERVICE_NAMES)) {
        expect(serviceName).toMatch(/^partition-/);
      }
    });

    it('should have unique service names', () => {
      const names = Object.values(PARTITION_SERVICE_NAMES);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(names.length);
    });

    it('should match partition ID suffix', () => {
      for (const [partitionId, serviceName] of Object.entries(PARTITION_SERVICE_NAMES)) {
        // Special case: solana-native -> partition-solana
        if (partitionId === PARTITION_IDS.SOLANA_NATIVE) {
          expect(serviceName).toBe('partition-solana');
        } else {
          expect(serviceName).toBe(`partition-${partitionId}`);
        }
      }
    });
  });

  describe('Chain coverage completeness', () => {
    it('should route all 11 chains without errors', () => {
      const chains = Object.keys(CHAINS);
      expect(chains.length).toBe(11);

      for (const chainId of chains) {
        const partition = assignChainToPartition(chainId);
        expect(partition).not.toBeNull();
      }
    });

    it('should have no orphaned chains (not in any partition)', () => {
      const allPartitionChains = new Set<string>();
      const partitions = getEnabledPartitions();

      for (const partition of partitions) {
        for (const chain of partition.chains) {
          allPartitionChains.add(chain);
        }
      }

      const configuredChains = Object.keys(CHAINS);
      for (const chain of configuredChains) {
        expect(allPartitionChains.has(chain)).toBe(true);
      }
    });
  });

  describe('PartitionRouter API stability', () => {
    let PartitionRouter: typeof import('../../shared/core/src').PartitionRouter;

    beforeAll(async () => {
      const module = await import('../../shared/core/src');
      PartitionRouter = module.PartitionRouter;
    });

    it('should have all expected static methods', () => {
      expect(typeof PartitionRouter.getPartitionForChain).toBe('function');
      expect(typeof PartitionRouter.getServiceEndpoint).toBe('function');
      expect(typeof PartitionRouter.getAllEndpoints).toBe('function');
      expect(typeof PartitionRouter.isRoutable).toBe('function');
      expect(typeof PartitionRouter.getRoutableChains).toBe('function');
      expect(typeof PartitionRouter.getServiceName).toBe('function');
      expect(typeof PartitionRouter.getPort).toBe('function');
      expect(typeof PartitionRouter.getChainsForPartition).toBe('function');
      expect(typeof PartitionRouter.getPartitionId).toBe('function');
    });

    it('should have consistent return types', () => {
      // null returns
      expect(PartitionRouter.getPartitionForChain('unknown')).toBeNull();
      expect(PartitionRouter.getServiceEndpoint('unknown')).toBeNull();
      expect(PartitionRouter.getPartitionId('unknown')).toBeNull();

      // array returns
      expect(Array.isArray(PartitionRouter.getAllEndpoints())).toBe(true);
      expect(Array.isArray(PartitionRouter.getRoutableChains())).toBe(true);
      expect(Array.isArray(PartitionRouter.getChainsForPartition(PARTITION_IDS.ASIA_FAST))).toBe(true);

      // boolean returns
      expect(typeof PartitionRouter.isRoutable('bsc')).toBe('boolean');

      // string returns
      expect(typeof PartitionRouter.getServiceName(PARTITION_IDS.ASIA_FAST)).toBe('string');

      // number returns
      expect(typeof PartitionRouter.getPort(PARTITION_IDS.ASIA_FAST)).toBe('number');
    });
  });

  describe('Deprecation utilities stability', () => {
    let createDeprecationWarning: typeof import('../../shared/core/src').createDeprecationWarning;
    let getMigrationRecommendation: typeof import('../../shared/core/src').getMigrationRecommendation;
    let warnIfDeprecated: typeof import('../../shared/core/src').warnIfDeprecated;

    beforeAll(async () => {
      const module = await import('../../shared/core/src');
      createDeprecationWarning = module.createDeprecationWarning;
      getMigrationRecommendation = module.getMigrationRecommendation;
      warnIfDeprecated = module.warnIfDeprecated;
    });

    it('should generate valid deprecation warnings', () => {
      const warning = createDeprecationWarning('bsc-detector', 'partition-asia-fast');
      expect(warning).toContain('DEPRECATED');
      expect(warning.length).toBeGreaterThan(50);
    });

    it('should provide migration recommendations for all chains', () => {
      const chains = Object.keys(CHAINS);
      for (const chainId of chains) {
        const recommendation = getMigrationRecommendation(`${chainId}-detector`);
        expect(recommendation).not.toBeNull();
        expect(recommendation).toMatch(/^partition-/);
      }
    });

    it('should not throw when warning with valid logger', () => {
      const mockLogger = { warn: jest.fn() };
      expect(() => warnIfDeprecated('bsc-detector', mockLogger)).not.toThrow();
    });

    it('should not throw when warning with no logger', () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      expect(() => warnIfDeprecated('ethereum-detector')).not.toThrow();
      consoleSpy.mockRestore();
    });
  });
});

// =============================================================================
// S3.1.7.13: P4-x Fix Verification Tests (Second Pass Analysis)
// =============================================================================

describe('S3.1.7.13: P4-x Fix Verification (Second Pass)', () => {
  let PartitionRouter: typeof import('../../shared/core/src').PartitionRouter;

  beforeAll(async () => {
    const module = await import('../../shared/core/src');
    PartitionRouter = module.PartitionRouter;
  });

  describe('P4-1-FIX: Nullish coalescing consistency', () => {
    it('should use ?? in getServiceName (not ||)', () => {
      // This tests the behavior, not the implementation
      // getServiceName should fall back correctly like getPort does
      expect(PartitionRouter.getServiceName(PARTITION_IDS.ASIA_FAST)).toBe('partition-asia-fast');
      expect(PartitionRouter.getServiceName('unknown')).toBe('partition-unknown');
    });

    it('should have consistent fallback behavior between getServiceName and getPort', () => {
      // Both should return fallback for unknown partitions
      const unknownPartition = 'not-a-real-partition';
      const serviceName = PartitionRouter.getServiceName(unknownPartition);
      const port = PartitionRouter.getPort(unknownPartition);

      expect(serviceName).toBe(`partition-${unknownPartition}`);
      expect(port).toBe(3000); // default port
    });
  });

  describe('P4-2-FIX: getPartitionId null handling', () => {
    it('should return null for unknown chains using ?? operator', () => {
      expect(PartitionRouter.getPartitionId('unknown-chain')).toBeNull();
      expect(PartitionRouter.getPartitionId('')).toBeNull();
    });

    it('should be consistent with getPartitionForChain', () => {
      const unknownChains = ['unknown', 'fake-chain', 'not-real'];
      for (const chain of unknownChains) {
        expect(PartitionRouter.getPartitionId(chain)).toBeNull();
        expect(PartitionRouter.getPartitionForChain(chain)).toBeNull();
      }
    });
  });

  describe('P4-3-FIX: getChainsForPartition array copy protection', () => {
    it('should return array copy, not reference', () => {
      const chains1 = PartitionRouter.getChainsForPartition(PARTITION_IDS.ASIA_FAST);
      const chains2 = PartitionRouter.getChainsForPartition(PARTITION_IDS.ASIA_FAST);

      // Same content
      expect(chains1).toEqual(chains2);
      expect(chains1).toEqual(['bsc', 'polygon', 'avalanche', 'fantom']);

      // Different instances
      expect(chains1).not.toBe(chains2);
    });

    it('should protect original data from mutation', () => {
      // Get initial chains
      const chains = PartitionRouter.getChainsForPartition(PARTITION_IDS.L2_TURBO);
      const originalChains = [...chains]; // Save original for comparison

      // Mutate returned array
      chains.push('fake-chain');
      chains[0] = 'modified';

      // Verify original is unchanged
      const freshChains = PartitionRouter.getChainsForPartition(PARTITION_IDS.L2_TURBO);
      expect(freshChains).toEqual(originalChains);
      expect(freshChains).not.toContain('fake-chain');
      expect(freshChains[0]).not.toBe('modified');
    });

    it('should be consistent with getServiceEndpoint chains copy', () => {
      // Both methods should return copies
      const endpointChains1 = PartitionRouter.getServiceEndpoint('arbitrum')!.chains;
      const endpointChains2 = PartitionRouter.getServiceEndpoint('arbitrum')!.chains;
      expect(endpointChains1).not.toBe(endpointChains2);

      const partitionChains1 = PartitionRouter.getChainsForPartition(PARTITION_IDS.L2_TURBO);
      const partitionChains2 = PartitionRouter.getChainsForPartition(PARTITION_IDS.L2_TURBO);
      expect(partitionChains1).not.toBe(partitionChains2);
    });

    it('should return empty array (not error) for unknown partitions', () => {
      const chains = PartitionRouter.getChainsForPartition('nonexistent');
      expect(chains).toEqual([]);
      expect(Array.isArray(chains)).toBe(true);
    });
  });

  describe('Cross-validation: All P4 fixes working together', () => {
    it('should have all partition methods consistent', () => {
      const partitions = getEnabledPartitions();

      for (const partition of partitions) {
        const partitionId = partition.partitionId;

        // getServiceName should work
        const serviceName = PartitionRouter.getServiceName(partitionId);
        expect(serviceName).toMatch(/^partition-/);

        // getPort should work
        const port = PartitionRouter.getPort(partitionId);
        expect(port).toBeGreaterThan(0);

        // getChainsForPartition should return copy
        const chains1 = PartitionRouter.getChainsForPartition(partitionId);
        const chains2 = PartitionRouter.getChainsForPartition(partitionId);
        expect(chains1).not.toBe(chains2);
        expect(chains1).toEqual(partition.chains);

        // getPartitionId should work for all chains in partition
        for (const chainId of partition.chains) {
          expect(PartitionRouter.getPartitionId(chainId)).toBe(partitionId);
        }
      }
    });
  });
});
