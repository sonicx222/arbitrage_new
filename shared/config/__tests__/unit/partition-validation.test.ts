/**
 * Partition Validation Tests (Fix #27)
 *
 * Tests for partition validation functions including:
 * - validatePartitionConfig with valid/invalid inputs
 * - validateAllPartitions for all production partitions
 * - getPartitionIdFromEnv / getPartitionFromEnv / getChainsFromEnv
 *
 * @see shared/config/src/partitions.ts
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  validatePartitionConfig,
  validateAllPartitions,
  getPartitionIdFromEnv,
  getPartitionFromEnv,
  getChainsFromEnv,
  getPartition,
  PARTITIONS,
  PartitionConfig,
} from '../../src/partitions';

// =============================================================================
// validatePartitionConfig
// =============================================================================

describe('validatePartitionConfig', () => {
  it('should return valid for asia-fast partition', () => {
    const partition = getPartition('asia-fast')!;
    const result = validatePartitionConfig(partition);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should return valid for l2-turbo partition', () => {
    const partition = getPartition('l2-turbo')!;
    const result = validatePartitionConfig(partition);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should return valid for high-value partition', () => {
    const partition = getPartition('high-value')!;
    const result = validatePartitionConfig(partition);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should return valid for solana-native partition', () => {
    const partition = getPartition('solana-native')!;
    const result = validatePartitionConfig(partition);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should return errors when partition has invalid chain', () => {
    const invalidPartition: PartitionConfig = {
      partitionId: 'test-invalid',
      name: 'Test Invalid',
      chains: ['nonexistent-chain'],
      region: 'us-east1',
      provider: 'fly',
      resourceProfile: 'light',
      priority: 1,
      maxMemoryMB: 512,
      enabled: true,
      healthCheckIntervalMs: 15000,
      failoverTimeoutMs: 60000,
    };

    const result = validatePartitionConfig(invalidPartition);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('not found in CHAINS'))).toBe(true);
  });

  it('should return errors when partition ID is too short', () => {
    const shortIdPartition: PartitionConfig = {
      partitionId: 'ab',
      name: 'Short ID',
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

    const result = validatePartitionConfig(shortIdPartition);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('at least 3 characters'))).toBe(true);
  });

  it('should return errors when partition ID is empty', () => {
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

  it('should return warnings for duplicate chains across partitions', () => {
    // Create a partition that duplicates BSC (already in asia-fast)
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

  it('should return warnings for insufficient resources', () => {
    const underResourced: PartitionConfig = {
      partitionId: 'under-resourced',
      name: 'Under Resourced',
      chains: ['bsc', 'polygon', 'arbitrum', 'optimism', 'base'],
      region: 'us-east1',
      provider: 'fly',
      resourceProfile: 'light',
      priority: 1,
      maxMemoryMB: 100,
      enabled: true,
      healthCheckIntervalMs: 15000,
      failoverTimeoutMs: 60000,
    };

    const result = validatePartitionConfig(underResourced);
    expect(result.warnings.some(w => w.includes('insufficient'))).toBe(true);
  });
});

// =============================================================================
// validateAllPartitions
// =============================================================================

describe('validateAllPartitions', () => {
  it('should validate all 4 production partitions', () => {
    const result = validateAllPartitions();
    expect(result.results.size).toBe(PARTITIONS.length);
    expect(result.results.size).toBe(4);
  });

  it('should have entries for all partition IDs', () => {
    const result = validateAllPartitions();
    for (const partition of PARTITIONS) {
      expect(result.results.has(partition.partitionId)).toBe(true);
    }
  });

  it('should report all production partitions as valid', () => {
    const result = validateAllPartitions();
    expect(result.valid).toBe(true);
    for (const [, partResult] of result.results) {
      expect(partResult.valid).toBe(true);
    }
  });

  it('should return boolean valid property', () => {
    const result = validateAllPartitions();
    expect(typeof result.valid).toBe('boolean');
  });
});

// =============================================================================
// getPartitionIdFromEnv / getPartitionFromEnv / getChainsFromEnv
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

    it('should return custom value when PARTITION_ID is set to non-standard value', () => {
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
