/**
 * Partition Migration & Router Tests
 *
 * Tests for partition migration utilities, PartitionRouter, deprecation
 * warnings, service file verification, and fix verifications.
 * Chain assignment / validation overlap is in partition-config.test.ts.
 *
 * @see IMPLEMENTATION_PLAN.md S3.1.7: Migrate existing detectors
 * @see ADR-003: Partitioned Chain Detectors
 */

import { jest, describe, it, expect, beforeAll } from '@jest/globals';

import {
  CHAINS,
  PARTITION_IDS,
  getEnabledDexes,
  CORE_TOKENS,
} from '@arbitrage/config';

import {
  getPartition,
  getEnabledPartitions,
  assignChainToPartition,
  getChainsForPartition,
  isEvmChain,
  getNonEvmChains,
} from '@arbitrage/config/partitions';

import { PARTITION_PORTS, PARTITION_SERVICE_NAMES } from '@arbitrage/core/partition';

// =============================================================================
// Partition Service Ports
// =============================================================================

describe('Partition Service Ports', () => {
  it('should have unique ports for each partition', () => {
    const ports = Object.values(PARTITION_PORTS);
    const uniquePorts = new Set(ports);
    expect(uniquePorts.size).toBe(ports.length);
  });

  it.each([
    [PARTITION_IDS.ASIA_FAST, 3001],
    [PARTITION_IDS.L2_TURBO, 3002],
    [PARTITION_IDS.HIGH_VALUE, 3003],
    [PARTITION_IDS.SOLANA_NATIVE, 3004],
  ])('should have %s on port %d', (partitionId, expectedPort) => {
    expect(PARTITION_PORTS[partitionId]).toBe(expectedPort);
  });

  it('should have ports in valid range (1024-65535)', () => {
    for (const port of Object.values(PARTITION_PORTS)) {
      expect(port).toBeGreaterThanOrEqual(1024);
      expect(port).toBeLessThanOrEqual(65535);
    }
  });

  it('should not use common reserved ports', () => {
    const reservedPorts = [80, 443, 8080, 8443, 3000];
    for (const port of Object.values(PARTITION_PORTS)) {
      expect(reservedPorts).not.toContain(port);
    }
  });
});

// =============================================================================
// Partition Service Names
// =============================================================================

describe('Partition Service Names', () => {
  it.each([
    [PARTITION_IDS.ASIA_FAST, 'partition-asia-fast'],
    [PARTITION_IDS.L2_TURBO, 'partition-l2-turbo'],
    [PARTITION_IDS.HIGH_VALUE, 'partition-high-value'],
    [PARTITION_IDS.SOLANA_NATIVE, 'partition-solana'],
  ])('should map %s to service name %s', (partitionId, expectedName) => {
    expect(PARTITION_SERVICE_NAMES[partitionId]).toBe(expectedName);
  });

  it('should follow partition-* naming convention', () => {
    for (const serviceName of Object.values(PARTITION_SERVICE_NAMES)) {
      expect(serviceName).toMatch(/^partition-/);
    }
  });

  it('should have unique service names', () => {
    const names = Object.values(PARTITION_SERVICE_NAMES);
    expect(new Set(names).size).toBe(names.length);
  });

  it('should match service directory names', async () => {
    const fs = await import('fs');
    const path = await import('path');

    for (const [, serviceName] of Object.entries(PARTITION_SERVICE_NAMES)) {
      const servicePath = path.join(process.cwd(), `services/${serviceName}`);
      expect(fs.existsSync(servicePath)).toBe(true);
    }
  });
});

// =============================================================================
// Service File Structure Verification
// =============================================================================

describe('Service File Structure', () => {
  it.each([
    'partition-asia-fast',
    'partition-l2-turbo',
    'partition-high-value',
    'partition-solana',
  ])('should have %s service index.ts', async (service) => {
    const fs = await import('fs');
    const path = await import('path');
    const servicePath = path.join(process.cwd(), `services/${service}/src/index.ts`);
    expect(fs.existsSync(servicePath)).toBe(true);
  });

  it('should have P1-P3 using createPartitionEntry factory', async () => {
    const fs = await import('fs');
    const path = await import('path');

    const factoryServices = ['partition-asia-fast', 'partition-l2-turbo', 'partition-high-value'];
    for (const service of factoryServices) {
      const content = fs.readFileSync(
        path.join(process.cwd(), `services/${service}/src/index.ts`),
        'utf-8'
      );
      expect(content).toMatch(/createPartitionEntry/);
    }
  });

  it('should have P4 using PARTITION_PORTS in service-config.ts', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const p4ConfigContent = fs.readFileSync(
      path.join(process.cwd(), 'services/partition-solana/src/service-config.ts'),
      'utf-8'
    );
    expect(p4ConfigContent).toMatch(/P4_DEFAULT_PORT.*PARTITION_PORTS.*\?\?.*3004/);
  });

  it('should use UnifiedChainDetector in all partition services', async () => {
    const fs = await import('fs');
    const path = await import('path');

    const partitionServices = [
      'partition-asia-fast', 'partition-l2-turbo',
      'partition-high-value', 'partition-solana',
    ];

    for (const service of partitionServices) {
      const content = fs.readFileSync(
        path.join(process.cwd(), `services/${service}/src/index.ts`),
        'utf-8'
      );
      expect(content).toContain('UnifiedChainDetector');
    }
  });
});

// =============================================================================
// PartitionRouter
// =============================================================================

describe('PartitionRouter', () => {
  let PartitionRouter: typeof import('@arbitrage/core').PartitionRouter;

  beforeAll(async () => {
    const module = await import('@arbitrage/core');
    PartitionRouter = module.PartitionRouter;
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
    expect(endpoints.map(e => e.port)).toEqual(expect.arrayContaining([3001, 3002, 3003, 3004]));
  });

  it('should validate chain is routable', () => {
    expect(PartitionRouter.isRoutable('bsc')).toBe(true);
    expect(PartitionRouter.isRoutable('ethereum')).toBe(true);
    expect(PartitionRouter.isRoutable('solana')).toBe(true);
    expect(PartitionRouter.isRoutable('unknown-chain')).toBe(false);
  });

  it('should get all 15 routable chains', () => {
    const chains = PartitionRouter.getRoutableChains();
    expect(chains.length).toBe(15);
    expect(chains).toContain('bsc');
    expect(chains).toContain('ethereum');
    expect(chains).toContain('blast');
    expect(chains).toContain('scroll');
    expect(chains).toContain('mantle');
    expect(chains).toContain('mode');
    expect(chains).toContain('solana');
  });

  it.each([
    [PARTITION_IDS.ASIA_FAST, 'partition-asia-fast'],
    [PARTITION_IDS.L2_TURBO, 'partition-l2-turbo'],
    [PARTITION_IDS.HIGH_VALUE, 'partition-high-value'],
    [PARTITION_IDS.SOLANA_NATIVE, 'partition-solana'],
  ])('should get service name for %s = %s', (partitionId, expectedName) => {
    expect(PartitionRouter.getServiceName(partitionId)).toBe(expectedName);
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

  describe('Null return consistency', () => {
    it('should return null (not undefined) for unknown chains', () => {
      expect(PartitionRouter.getServiceEndpoint('unknown-chain')).toBeNull();
      expect(PartitionRouter.getServiceEndpoint('')).toBeNull();
      expect(PartitionRouter.getPartitionForChain('unknown')).toBeNull();
      expect(PartitionRouter.getPartitionId('unknown-chain')).toBeNull();
      expect(PartitionRouter.getPartitionId('')).toBeNull();
    });
  });

  describe('Endpoint structure consistency', () => {
    it('should return consistent endpoint structure from getServiceEndpoint', () => {
      const endpoint = PartitionRouter.getServiceEndpoint('bsc');
      expect(endpoint).toHaveProperty('partitionId');
      expect(endpoint).toHaveProperty('serviceName');
      expect(endpoint).toHaveProperty('port');
      expect(endpoint).toHaveProperty('chains');
      expect(endpoint).toHaveProperty('region');
      expect(endpoint).toHaveProperty('provider');
    });

    it('should have identical structure between methods', () => {
      const directEndpoint = PartitionRouter.getServiceEndpoint('arbitrum');
      const allEndpoints = PartitionRouter.getAllEndpoints();
      const fromAllEndpoints = allEndpoints.find(e => e.partitionId === PARTITION_IDS.L2_TURBO);

      expect(directEndpoint!.partitionId).toBe(fromAllEndpoints!.partitionId);
      expect(directEndpoint!.serviceName).toBe(fromAllEndpoints!.serviceName);
      expect(directEndpoint!.port).toBe(fromAllEndpoints!.port);
    });
  });

  describe('Array copy protection', () => {
    it('should return different array instances for chains', () => {
      const endpoint1 = PartitionRouter.getServiceEndpoint('ethereum')!;
      const endpoint2 = PartitionRouter.getServiceEndpoint('ethereum')!;
      expect(endpoint1.chains).toEqual(endpoint2.chains);
      expect(endpoint1.chains).not.toBe(endpoint2.chains);
    });

    it('should not mutate original partition chains when endpoint chains modified', () => {
      const endpoint = PartitionRouter.getServiceEndpoint('bsc')!;
      const originalLength = endpoint.chains.length;
      endpoint.chains.push('fake-chain');
      const newEndpoint = PartitionRouter.getServiceEndpoint('bsc')!;
      expect(newEndpoint.chains.length).toBe(originalLength);
    });

    it('should return array copy from getChainsForPartition', () => {
      const chains1 = PartitionRouter.getChainsForPartition(PARTITION_IDS.ASIA_FAST);
      const chains2 = PartitionRouter.getChainsForPartition(PARTITION_IDS.ASIA_FAST);
      expect(chains1).toEqual(chains2);
      expect(chains1).not.toBe(chains2);
    });

    it('should protect original data from mutation via getChainsForPartition', () => {
      const chains = PartitionRouter.getChainsForPartition(PARTITION_IDS.L2_TURBO);
      const original = [...chains];
      chains.push('fake-chain');
      chains[0] = 'modified';
      const fresh = PartitionRouter.getChainsForPartition(PARTITION_IDS.L2_TURBO);
      expect(fresh).toEqual(original);
    });

    it('should return empty array for unknown partitions', () => {
      const chains = PartitionRouter.getChainsForPartition('nonexistent');
      expect(chains).toEqual([]);
    });
  });

  describe('Fallback behavior', () => {
    it('should use ?? in getServiceName (consistent fallback)', () => {
      expect(PartitionRouter.getServiceName('unknown')).toBe('partition-unknown');
    });

    it('should return default port for unknown partitions', () => {
      expect(PartitionRouter.getPort('not-a-real-partition')).toBe(3000);
    });
  });
});

// =============================================================================
// Deprecation Utilities
// =============================================================================

describe('Deprecation Utilities', () => {
  let createDeprecationWarning: typeof import('@arbitrage/core').createDeprecationWarning;
  let isDeprecatedPattern: typeof import('@arbitrage/core').isDeprecatedPattern;
  let getMigrationRecommendation: typeof import('@arbitrage/core').getMigrationRecommendation;
  let warnIfDeprecated: typeof import('@arbitrage/core').warnIfDeprecated;

  beforeAll(async () => {
    const module = await import('@arbitrage/core');
    createDeprecationWarning = module.createDeprecationWarning;
    isDeprecatedPattern = module.isDeprecatedPattern;
    getMigrationRecommendation = module.getMigrationRecommendation;
    warnIfDeprecated = module.warnIfDeprecated;
  });

  it('should create deprecation warning for direct chain access', () => {
    const warning = createDeprecationWarning('bsc-detector', 'partition-asia-fast');
    expect(warning).toContain('DEPRECATED');
    expect(warning).toContain('partition-asia-fast');
    expect(warning.length).toBeGreaterThan(50);
  });

  it('should identify deprecated patterns for all configured chains', () => {
    const chains = Object.keys(CHAINS);
    for (const chainId of chains) {
      expect(isDeprecatedPattern(`${chainId}-detector`)).toBe(true);
    }
  });

  it('should NOT flag unknown chains as deprecated', () => {
    expect(isDeprecatedPattern('fakecoin-detector')).toBe(false);
    expect(isDeprecatedPattern('testnet-detector')).toBe(false);
  });

  it('should NOT flag partition services as deprecated', () => {
    for (const serviceName of Object.values(PARTITION_SERVICE_NAMES)) {
      expect(isDeprecatedPattern(serviceName)).toBe(false);
    }
  });

  it('should provide migration recommendations for all chains', () => {
    for (const chainId of Object.keys(CHAINS)) {
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

// =============================================================================
// DEX and Token Coverage by Partition
// =============================================================================

describe('DEX and Token Coverage by Partition', () => {
  it.each([
    [PARTITION_IDS.ASIA_FAST],
    [PARTITION_IDS.L2_TURBO],
    [PARTITION_IDS.HIGH_VALUE],
    [PARTITION_IDS.SOLANA_NATIVE],
  ])('should have DEXes configured for all %s chains', (partitionId) => {
    const chains = getChainsForPartition(partitionId);
    for (const chainId of chains) {
      expect(getEnabledDexes(chainId).length).toBeGreaterThan(0);
    }
  });

  it.each([
    [PARTITION_IDS.ASIA_FAST],
    [PARTITION_IDS.L2_TURBO],
    [PARTITION_IDS.HIGH_VALUE],
    [PARTITION_IDS.SOLANA_NATIVE],
  ])('should have tokens configured for all %s chains', (partitionId) => {
    const chains = getChainsForPartition(partitionId);
    for (const chainId of chains) {
      expect(CORE_TOKENS[chainId]).toBeDefined();
      expect(CORE_TOKENS[chainId].length).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// Cross-Chain Detector Integration
// =============================================================================

describe('Cross-Chain Detector Integration', () => {
  it('should have cross-chain-detector service using Redis Streams', async () => {
    const fs = await import('fs');
    const path = await import('path');

    const detectorPath = path.join(process.cwd(), 'services/cross-chain-detector/src/detector.ts');
    expect(fs.existsSync(detectorPath)).toBe(true);

    const content = fs.readFileSync(detectorPath, 'utf-8');
    expect(content).toContain('RedisStreamsClient');
    expect(content).toContain('ADR-002');
  });

  it('should not extend BaseDetector (documented exception)', async () => {
    const fs = await import('fs');
    const path = await import('path');

    const detectorPath = path.join(process.cwd(), 'services/cross-chain-detector/src/detector.ts');
    const content = fs.readFileSync(detectorPath, 'utf-8');
    expect(content).toContain('does NOT extend BaseDetector');
  });
});

// =============================================================================
// Unified Detector Integration
// =============================================================================

describe('Unified Detector Integration', () => {
  it('should have unified-detector service', async () => {
    const fs = await import('fs');
    const path = await import('path');

    const servicePath = path.join(process.cwd(), 'services/unified-detector/src/unified-detector.ts');
    expect(fs.existsSync(servicePath)).toBe(true);
  });

  it('should have ADR-003 compliance in unified-detector', async () => {
    const fs = await import('fs');
    const path = await import('path');

    const detectorPath = path.join(process.cwd(), 'services/unified-detector/src/unified-detector.ts');
    const content = fs.readFileSync(detectorPath, 'utf-8');
    expect(content).toContain('ADR-003');
    expect(content).toContain('Partitioned Chain Detectors');
  });
});

// =============================================================================
// Migration Documentation
// =============================================================================

describe('Migration Documentation', () => {
  it('should have ADR-003 documented', async () => {
    const fs = await import('fs');
    const path = await import('path');

    const adrPath = path.join(process.cwd(), 'docs/architecture/adr/ADR-003-partitioned-detectors.md');
    expect(fs.existsSync(adrPath)).toBe(true);

    const content = fs.readFileSync(adrPath, 'utf-8');
    expect(content).toContain('partition');
  });

  it('should reference partition architecture in ARCHITECTURE_V2.md', async () => {
    const fs = await import('fs');
    const path = await import('path');

    const archPath = path.join(process.cwd(), 'docs/architecture/ARCHITECTURE_V2.md');
    const content = fs.readFileSync(archPath, 'utf-8');
    expect(content.toLowerCase()).toContain('partition');
    expect(content).toContain('ADR-003');
  });
});
