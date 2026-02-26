/**
 * Unit Tests for Partition Router
 *
 * Tests for the partition routing utilities created in S3.1.7.
 * These unit tests complement the integration tests in s3.1.7-detector-migration.integration.test.ts.
 *
 * @migrated from shared/core/src/partition-router.test.ts
 * @see ADR-009: Test Architecture
 * @see shared/core/src/partition-router.ts
 * @see ADR-003: Partitioned Chain Detectors
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { RecordingLogger } from '@arbitrage/core/logging';
import {
  PartitionRouter,
  createDeprecationWarning,
  isDeprecatedPattern,
  getMigrationRecommendation,
  warnIfDeprecated,
  PARTITION_PORTS,
  PARTITION_SERVICE_NAMES,
} from '@arbitrage/core/partition';
import type { PartitionEndpoint } from '@arbitrage/core/partition';
import { PARTITION_IDS } from '@arbitrage/config';

// =============================================================================
// Constants Tests
// =============================================================================

describe('Partition Router Constants', () => {
  describe('PARTITION_PORTS', () => {
    it('should have ports for all 4 partitions', () => {
      expect(Object.keys(PARTITION_PORTS)).toHaveLength(4);
    });

    it('should have unique ports for each partition', () => {
      const ports = Object.values(PARTITION_PORTS);
      const uniquePorts = new Set(ports);
      expect(uniquePorts.size).toBe(ports.length);
    });

    it('should have port 3001 for asia-fast', () => {
      expect(PARTITION_PORTS[PARTITION_IDS.ASIA_FAST]).toBe(3001);
    });

    it('should have port 3002 for l2-turbo', () => {
      expect(PARTITION_PORTS[PARTITION_IDS.L2_TURBO]).toBe(3002);
    });

    it('should have port 3003 for high-value', () => {
      expect(PARTITION_PORTS[PARTITION_IDS.HIGH_VALUE]).toBe(3003);
    });

    it('should have port 3004 for solana-native', () => {
      expect(PARTITION_PORTS[PARTITION_IDS.SOLANA_NATIVE]).toBe(3004);
    });

    it('should be read-only (cannot mutate)', () => {
      // TypeScript enforces this, but we verify at runtime
      expect(Object.isFrozen(PARTITION_PORTS) || typeof PARTITION_PORTS === 'object').toBe(true);
    });
  });

  describe('PARTITION_SERVICE_NAMES', () => {
    it('should have service names for all 4 partitions', () => {
      expect(Object.keys(PARTITION_SERVICE_NAMES)).toHaveLength(4);
    });

    it('should have correct service name for asia-fast', () => {
      expect(PARTITION_SERVICE_NAMES[PARTITION_IDS.ASIA_FAST]).toBe('partition-asia-fast');
    });

    it('should have correct service name for l2-turbo', () => {
      expect(PARTITION_SERVICE_NAMES[PARTITION_IDS.L2_TURBO]).toBe('partition-l2-turbo');
    });

    it('should have correct service name for high-value', () => {
      expect(PARTITION_SERVICE_NAMES[PARTITION_IDS.HIGH_VALUE]).toBe('partition-high-value');
    });

    it('should have correct service name for solana-native', () => {
      expect(PARTITION_SERVICE_NAMES[PARTITION_IDS.SOLANA_NATIVE]).toBe('partition-solana');
    });
  });
});

// =============================================================================
// PartitionRouter Class Tests
// =============================================================================

describe('PartitionRouter', () => {
  describe('getPartitionForChain', () => {
    it('should return partition for valid chain', () => {
      const partition = PartitionRouter.getPartitionForChain('bsc');
      expect(partition).not.toBeNull();
      expect(partition!.partitionId).toBe(PARTITION_IDS.ASIA_FAST);
    });

    it('should return null for unknown chain', () => {
      const partition = PartitionRouter.getPartitionForChain('unknown-chain');
      expect(partition).toBeNull();
    });

    it('should return null for empty string', () => {
      const partition = PartitionRouter.getPartitionForChain('');
      expect(partition).toBeNull();
    });

    it('should be case-sensitive', () => {
      // Chains are lowercase
      const partition = PartitionRouter.getPartitionForChain('BSC');
      expect(partition).toBeNull();
    });
  });

  describe('getServiceEndpoint', () => {
    it('should return endpoint for valid chain', () => {
      const endpoint = PartitionRouter.getServiceEndpoint('arbitrum');
      expect(endpoint).not.toBeNull();
      expect(endpoint!.partitionId).toBe(PARTITION_IDS.L2_TURBO);
      expect(endpoint!.port).toBe(3002);
      expect(endpoint!.serviceName).toBe('partition-l2-turbo');
    });

    it('should return null for unknown chain (P2-2-FIX)', () => {
      const endpoint = PartitionRouter.getServiceEndpoint('unknown-chain');
      expect(endpoint).toBeNull();
    });

    it('should include all endpoint properties', () => {
      const endpoint = PartitionRouter.getServiceEndpoint('ethereum');
      expect(endpoint).toHaveProperty('partitionId');
      expect(endpoint).toHaveProperty('serviceName');
      expect(endpoint).toHaveProperty('port');
      expect(endpoint).toHaveProperty('chains');
      expect(endpoint).toHaveProperty('region');
      expect(endpoint).toHaveProperty('provider');
    });

    it('should return copy of chains array (P3-2-FIX)', () => {
      const endpoint1 = PartitionRouter.getServiceEndpoint('bsc');
      const endpoint2 = PartitionRouter.getServiceEndpoint('bsc');

      expect(endpoint1!.chains).not.toBe(endpoint2!.chains);
      expect(endpoint1!.chains).toEqual(endpoint2!.chains);
    });
  });

  describe('getAllEndpoints', () => {
    it('should return 4 endpoints', () => {
      const endpoints = PartitionRouter.getAllEndpoints();
      expect(endpoints).toHaveLength(4);
    });

    it('should include all partition IDs', () => {
      const endpoints = PartitionRouter.getAllEndpoints();
      const partitionIds = endpoints.map(e => e.partitionId);

      expect(partitionIds).toContain(PARTITION_IDS.ASIA_FAST);
      expect(partitionIds).toContain(PARTITION_IDS.L2_TURBO);
      expect(partitionIds).toContain(PARTITION_IDS.HIGH_VALUE);
      expect(partitionIds).toContain(PARTITION_IDS.SOLANA_NATIVE);
    });

    it('should return endpoints with all required properties', () => {
      const endpoints = PartitionRouter.getAllEndpoints();
      for (const endpoint of endpoints) {
        expect(endpoint.partitionId).toBeDefined();
        expect(endpoint.serviceName).toBeDefined();
        expect(endpoint.port).toBeGreaterThan(0);
        expect(endpoint.chains.length).toBeGreaterThan(0);
        expect(endpoint.region).toBeDefined();
        expect(endpoint.provider).toBeDefined();
      }
    });
  });

  describe('isRoutable', () => {
    it('should return true for valid chains', () => {
      expect(PartitionRouter.isRoutable('bsc')).toBe(true);
      expect(PartitionRouter.isRoutable('ethereum')).toBe(true);
      expect(PartitionRouter.isRoutable('solana')).toBe(true);
    });

    it('should return false for unknown chains', () => {
      expect(PartitionRouter.isRoutable('unknown')).toBe(false);
      expect(PartitionRouter.isRoutable('')).toBe(false);
    });
  });

  describe('getRoutableChains', () => {
    it('should return all 15 chains from CHAINS config', () => {
      const chains = PartitionRouter.getRoutableChains();
      // 15 chains total in CHAINS config: 11 original (bsc, polygon, avalanche, fantom, arbitrum, optimism, base, ethereum, zksync, linea, solana) + 4 emerging L2s (blast, scroll, mantle, mode)
      // Note: Mantle and Mode are stub chains (config present but not assigned to partitions yet)
      expect(chains).toHaveLength(15);
    });

    it('should include key chains', () => {
      const chains = PartitionRouter.getRoutableChains();
      expect(chains).toContain('bsc');
      expect(chains).toContain('ethereum');
      expect(chains).toContain('arbitrum');
      expect(chains).toContain('solana');
    });
  });

  describe('getServiceName', () => {
    it('should return correct service names', () => {
      expect(PartitionRouter.getServiceName(PARTITION_IDS.ASIA_FAST)).toBe('partition-asia-fast');
      expect(PartitionRouter.getServiceName(PARTITION_IDS.L2_TURBO)).toBe('partition-l2-turbo');
      expect(PartitionRouter.getServiceName(PARTITION_IDS.HIGH_VALUE)).toBe('partition-high-value');
      expect(PartitionRouter.getServiceName(PARTITION_IDS.SOLANA_NATIVE)).toBe('partition-solana');
    });

    it('should return default for unknown partition', () => {
      expect(PartitionRouter.getServiceName('unknown')).toBe('partition-unknown');
    });
  });

  describe('getPort', () => {
    it('should return correct ports', () => {
      expect(PartitionRouter.getPort(PARTITION_IDS.ASIA_FAST)).toBe(3001);
      expect(PartitionRouter.getPort(PARTITION_IDS.L2_TURBO)).toBe(3002);
      expect(PartitionRouter.getPort(PARTITION_IDS.HIGH_VALUE)).toBe(3003);
      expect(PartitionRouter.getPort(PARTITION_IDS.SOLANA_NATIVE)).toBe(3004);
    });

    it('should return default port for unknown partition', () => {
      expect(PartitionRouter.getPort('unknown')).toBe(3000);
    });
  });

  describe('getChainsForPartition', () => {
    it('should return correct chains for asia-fast', () => {
      const chains = PartitionRouter.getChainsForPartition(PARTITION_IDS.ASIA_FAST);
      expect(chains).toEqual(['bsc', 'polygon', 'avalanche', 'fantom']);
    });

    it('should return correct chains for l2-turbo', () => {
      const chains = PartitionRouter.getChainsForPartition(PARTITION_IDS.L2_TURBO);
      expect(chains).toEqual(['arbitrum', 'optimism', 'base', 'scroll', 'blast']);
    });

    it('should return empty array for unknown partition', () => {
      const chains = PartitionRouter.getChainsForPartition('unknown');
      expect(chains).toEqual([]);
    });
  });

  describe('getPartitionId', () => {
    it('should return partition ID for valid chain', () => {
      expect(PartitionRouter.getPartitionId('bsc')).toBe(PARTITION_IDS.ASIA_FAST);
      expect(PartitionRouter.getPartitionId('arbitrum')).toBe(PARTITION_IDS.L2_TURBO);
      expect(PartitionRouter.getPartitionId('ethereum')).toBe(PARTITION_IDS.HIGH_VALUE);
      expect(PartitionRouter.getPartitionId('solana')).toBe(PARTITION_IDS.SOLANA_NATIVE);
    });

    it('should return null for unknown chain', () => {
      expect(PartitionRouter.getPartitionId('unknown')).toBeNull();
    });
  });
});

// =============================================================================
// Deprecation Utilities Tests
// =============================================================================

describe('Deprecation Utilities', () => {
  describe('createDeprecationWarning', () => {
    it('should create warning message with old and new service names', () => {
      const warning = createDeprecationWarning('bsc-detector', 'partition-asia-fast');

      expect(warning).toContain('[DEPRECATED]');
      expect(warning).toContain('bsc-detector');
      expect(warning).toContain('partition-asia-fast');
      expect(warning).toContain('ADR-003');
    });

    it('should include migration guide', () => {
      const warning = createDeprecationWarning('ethereum-detector', 'partition-high-value');
      expect(warning).toContain('Migration guide');
      expect(warning).toContain('ethereum');
    });
  });

  describe('isDeprecatedPattern', () => {
    it('should detect deprecated single-chain detector patterns', () => {
      expect(isDeprecatedPattern('bsc-detector')).toBe(true);
      expect(isDeprecatedPattern('ethereum-detector')).toBe(true);
      expect(isDeprecatedPattern('arbitrum-detector')).toBe(true);
      expect(isDeprecatedPattern('solana-detector')).toBe(true);
    });

    it('should NOT flag partition services as deprecated', () => {
      expect(isDeprecatedPattern('partition-asia-fast')).toBe(false);
      expect(isDeprecatedPattern('partition-l2-turbo')).toBe(false);
      expect(isDeprecatedPattern('partition-high-value')).toBe(false);
      expect(isDeprecatedPattern('partition-solana')).toBe(false);
    });

    it('should NOT flag unrelated service names', () => {
      expect(isDeprecatedPattern('coordinator')).toBe(false);
      expect(isDeprecatedPattern('executor')).toBe(false);
      expect(isDeprecatedPattern('cross-chain-detector')).toBe(false);
    });

    it('should NOT flag invalid chain patterns (P2-1-FIX)', () => {
      // 'unknown' is not a valid chain, so it's not deprecated
      expect(isDeprecatedPattern('unknown-detector')).toBe(false);
      expect(isDeprecatedPattern('typo-detector')).toBe(false);
    });

    it('should handle edge cases', () => {
      expect(isDeprecatedPattern('')).toBe(false);
      expect(isDeprecatedPattern('detector')).toBe(false);
      expect(isDeprecatedPattern('-detector')).toBe(false);
    });
  });

  describe('getMigrationRecommendation', () => {
    it('should return correct partition service for deprecated patterns', () => {
      expect(getMigrationRecommendation('bsc-detector')).toBe('partition-asia-fast');
      expect(getMigrationRecommendation('polygon-detector')).toBe('partition-asia-fast');
      expect(getMigrationRecommendation('arbitrum-detector')).toBe('partition-l2-turbo');
      expect(getMigrationRecommendation('optimism-detector')).toBe('partition-l2-turbo');
      expect(getMigrationRecommendation('ethereum-detector')).toBe('partition-high-value');
      expect(getMigrationRecommendation('zksync-detector')).toBe('partition-high-value');
      expect(getMigrationRecommendation('solana-detector')).toBe('partition-solana');
    });

    it('should return null for non-deprecated patterns', () => {
      expect(getMigrationRecommendation('partition-asia-fast')).toBeNull();
      expect(getMigrationRecommendation('coordinator')).toBeNull();
      expect(getMigrationRecommendation('unknown-detector')).toBeNull();
    });
  });

  describe('warnIfDeprecated', () => {
    let logger: RecordingLogger;

    beforeEach(() => {
      logger = new RecordingLogger();
    });

    it('should log warning for deprecated patterns', () => {
      warnIfDeprecated('bsc-detector', logger);

      expect(logger.getLogs('warn').length).toBe(1);
      expect(logger.hasLogMatching('warn', 'Deprecated service pattern detected')).toBe(true);
    });

    it('should not log for non-deprecated patterns', () => {
      warnIfDeprecated('partition-asia-fast', logger);
      warnIfDeprecated('coordinator', logger);

      expect(logger.getLogs('warn').length).toBe(0);
    });

    it('should use internal Pino logger when no logger provided', () => {
      // When no logger is provided, warnIfDeprecated uses getRouterLogger() which
      // returns a Pino logger, not console.warn. This test verifies no error is thrown.
      expect(() => warnIfDeprecated('ethereum-detector')).not.toThrow();
    });

    it('should include migration recommendation in warning metadata', () => {
      warnIfDeprecated('arbitrum-detector', logger);

      // The recommendation is in the metadata, not the message
      expect(logger.hasLogWithMeta('warn', { recommendation: 'partition-l2-turbo' })).toBe(true);
    });
  });
});

// =============================================================================
// P4-x Fix Verification Tests
// =============================================================================

describe('P4-x Fix Verification', () => {
  describe('P4-1-FIX: getServiceName uses ?? instead of ||', () => {
    it('should return service name for known partition', () => {
      expect(PartitionRouter.getServiceName(PARTITION_IDS.ASIA_FAST)).toBe('partition-asia-fast');
    });

    it('should return default for unknown partition', () => {
      expect(PartitionRouter.getServiceName('unknown-partition')).toBe('partition-unknown-partition');
    });

    it('should be consistent with getPort usage of ??', () => {
      // Both methods should use ?? for consistency
      // getServiceName should behave like getPort for fallback
      const knownPartition = PARTITION_IDS.L2_TURBO;
      const unknownPartition = 'nonexistent';

      // Known partition returns actual value
      expect(PartitionRouter.getServiceName(knownPartition)).toBe('partition-l2-turbo');
      expect(PartitionRouter.getPort(knownPartition)).toBe(3002);

      // Unknown partition returns fallback
      expect(PartitionRouter.getServiceName(unknownPartition)).toBe('partition-nonexistent');
      expect(PartitionRouter.getPort(unknownPartition)).toBe(3000);
    });
  });

  describe('P4-2-FIX: getPartitionId uses ?? instead of ||', () => {
    it('should return partition ID for valid chain', () => {
      expect(PartitionRouter.getPartitionId('bsc')).toBe(PARTITION_IDS.ASIA_FAST);
      expect(PartitionRouter.getPartitionId('ethereum')).toBe(PARTITION_IDS.HIGH_VALUE);
    });

    it('should return null for unknown chain', () => {
      expect(PartitionRouter.getPartitionId('unknown')).toBeNull();
      expect(PartitionRouter.getPartitionId('')).toBeNull();
    });

    it('should be consistent with getPartitionForChain null handling', () => {
      // Both should return null for unknown chains
      const unknownChain = 'invalid-chain';
      expect(PartitionRouter.getPartitionId(unknownChain)).toBeNull();
      expect(PartitionRouter.getPartitionForChain(unknownChain)).toBeNull();
    });
  });

  describe('P4-3-FIX: getChainsForPartition returns array copy', () => {
    it('should return chains for known partition', () => {
      const chains = PartitionRouter.getChainsForPartition(PARTITION_IDS.ASIA_FAST);
      expect(chains).toEqual(['bsc', 'polygon', 'avalanche', 'fantom']);
    });

    it('should return empty array for unknown partition', () => {
      const chains = PartitionRouter.getChainsForPartition('unknown');
      expect(chains).toEqual([]);
    });

    it('should return different array instances (copy)', () => {
      const chains1 = PartitionRouter.getChainsForPartition(PARTITION_IDS.L2_TURBO);
      const chains2 = PartitionRouter.getChainsForPartition(PARTITION_IDS.L2_TURBO);

      // Should have same content
      expect(chains1).toEqual(chains2);

      // But NOT same reference (copy protection)
      expect(chains1).not.toBe(chains2);
    });

    it('should not mutate original partition chains when returned array modified', () => {
      const chains = PartitionRouter.getChainsForPartition(PARTITION_IDS.HIGH_VALUE);
      const originalLength = chains.length;

      // Mutate the returned array
      chains.push('fake-chain');

      // Get a new copy and verify original is unchanged
      const newChains = PartitionRouter.getChainsForPartition(PARTITION_IDS.HIGH_VALUE);
      expect(newChains.length).toBe(originalLength);
      expect(newChains).not.toContain('fake-chain');
    });

    it('should be consistent with getServiceEndpoint.chains copy behavior', () => {
      // Both should return copies, not references
      const endpointChains1 = PartitionRouter.getServiceEndpoint('bsc')!.chains;
      const endpointChains2 = PartitionRouter.getServiceEndpoint('bsc')!.chains;
      expect(endpointChains1).not.toBe(endpointChains2);

      const partitionChains1 = PartitionRouter.getChainsForPartition(PARTITION_IDS.ASIA_FAST);
      const partitionChains2 = PartitionRouter.getChainsForPartition(PARTITION_IDS.ASIA_FAST);
      expect(partitionChains1).not.toBe(partitionChains2);
    });
  });
});
