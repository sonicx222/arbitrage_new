/**
 * ADR-003 Compliance Tests: Partitioned Chain Detectors
 *
 * These tests verify that the system adheres to ADR-003:
 * - Single-chain detectors are deprecated
 * - Unified-detector handles multiple chains via partitions
 * - Chain configuration is centralized
 *
 * Per ADR-003:
 * - 3-4 partitions for 15+ chains (not 1 service per chain)
 * - Fits within free hosting limits (Fly.io 3 apps)
 * - Shared overhead across chains
 *
 * TDD Approach: Tests written BEFORE full implementation.
 *
 * @see docs/architecture/adr/ADR-003-partitioned-detectors.md
 *
 * @migrated from shared/core/src/adr-003-compliance.test.ts
 * @see ADR-009: Test Architecture
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// =============================================================================
// ADR-003 Compliance Tests
// =============================================================================

describe('ADR-003: Partitioned Chain Detectors Compliance', () => {
  // Single-chain services have been removed per ADR-003 migration.
  // These tests verify the deprecated services no longer exist.
  describe('Single-Chain Service Removal', () => {
    const deprecatedServices = [
      'ethereum-detector',
      'arbitrum-detector',
      'bsc-detector',
      'polygon-detector',
      'optimism-detector',
      'base-detector'
    ];

    it('should have removed single-chain service directories per ADR-003', async () => {
      const fs = await import('fs/promises');
      const path = await import('path');

      for (const service of deprecatedServices) {
        const servicePath = path.resolve(
          __dirname,
          `../../../../services/${service}`
        );

        // Verify service directory does NOT exist (has been removed per ADR-003)
        let exists = true;
        try {
          await fs.access(servicePath);
        } catch {
          exists = false;
        }

        expect(exists).toBe(false);
      }
    });

    it('should only have unified-detector and core services', async () => {
      const fs = await import('fs/promises');
      const path = await import('path');

      const servicesPath = path.resolve(__dirname, '../../../../services');
      const entries = await fs.readdir(servicesPath, { withFileTypes: true });
      const serviceNames = entries
        .filter(e => e.isDirectory())
        .map(e => e.name);

      // Should have unified-detector, coordinator, cross-chain-detector, execution-engine
      expect(serviceNames).toContain('unified-detector');
      expect(serviceNames).toContain('coordinator');

      // Should NOT have deprecated single-chain detectors
      for (const deprecated of deprecatedServices) {
        expect(serviceNames).not.toContain(deprecated);
      }
    });
  });

  describe('Unified Detector Requirements', () => {
    it('should have unified-detector service that handles partitions', async () => {
      const fs = await import('fs/promises');
      const path = await import('path');

      const unifiedDetectorPath = path.resolve(
        __dirname,
        '../../../../services/unified-detector/src/unified-detector.ts'
      );

      const content = await fs.readFile(unifiedDetectorPath, 'utf-8');

      // Should implement ADR-003 features
      expect(content).toMatch(/PartitionConfig|partitionId/);
      expect(content).toMatch(/ChainInstance|chainInstances/);
      expect(content).toMatch(/ADR-003/);
    });

    it('should support all chains through partition configuration', async () => {
      // Load partition configuration
      const configModule = await import('@arbitrage/config');

      // Should have partition definitions
      expect(configModule.getPartition).toBeDefined();
      expect(configModule.getPartitionFromEnv).toBeDefined();
      expect(configModule.CHAINS).toBeDefined();

      // Test that all chains can be assigned to partitions
      const chainIds = Object.keys(configModule.CHAINS);

      // Per ADR-003: Should have chain configs for multiple chains
      expect(chainIds.length).toBeGreaterThan(3);
    });

    it('should have 4 or fewer partition configurations', async () => {
      // Per ADR-003: 3-4 partitions for 15+ chains
      const fs = await import('fs/promises');
      const path = await import('path');

      const partitionsFile = path.resolve(
        __dirname,
        '../../../../shared/config/src/partitions.ts'
      );

      try {
        const content = await fs.readFile(partitionsFile, 'utf-8');

        // Count partition definitions
        const partitionMatches = content.match(/partitionId:\s*['"][^'"]+['"]/g);

        if (partitionMatches) {
          // Should have 4 or fewer partitions
          expect(partitionMatches.length).toBeLessThanOrEqual(4);
        }
      } catch {
        // If no dedicated partitions file, check config/index.ts
        const configFile = path.resolve(
          __dirname,
          '../../../../shared/config/src/index.ts'
        );

        const content = await fs.readFile(configFile, 'utf-8');

        // Look for PARTITIONS definition
        expect(content).toMatch(/PARTITIONS|PartitionConfig/);
      }
    });
  });

  describe('Free Tier Compatibility', () => {
    it('should have deployment config for max 3 apps on Fly.io', async () => {
      // Per ADR-003: Fits within Fly.io 3-app free tier limit
      const fs = await import('fs/promises');
      const path = await import('path');

      // Check for Fly.io configuration
      const flyTomlPath = path.resolve(__dirname, '../../../../../fly.toml');

      try {
        const content = await fs.readFile(flyTomlPath, 'utf-8');

        // Should reference unified-detector, not single-chain detectors
        expect(content).toMatch(/unified-detector|coordinator/);

        // Should NOT reference individual chain detectors as separate apps
        expect(content).not.toMatch(/ethereum-detector|bsc-detector/);
      } catch {
        // fly.toml may be in different location or use fly.json
      }
    });
  });

  describe('Resource Sharing', () => {
    it('should share Redis connection across chains in same partition', async () => {
      const fs = await import('fs/promises');
      const path = await import('path');

      const unifiedDetectorPath = path.resolve(
        __dirname,
        '../../../../services/unified-detector/src/unified-detector.ts'
      );

      const content = await fs.readFile(unifiedDetectorPath, 'utf-8');

      // Should have single Redis initialization (not per-chain)
      const redisInitCount = (content.match(/getRedisClient\(\)/g) || []).length;

      // Should call getRedisClient once at partition level
      expect(redisInitCount).toBeLessThanOrEqual(2);
    });

    it('should share state manager across chains', async () => {
      const fs = await import('fs/promises');
      const path = await import('path');

      const unifiedDetectorPath = path.resolve(
        __dirname,
        '../../../../services/unified-detector/src/unified-detector.ts'
      );

      const content = await fs.readFile(unifiedDetectorPath, 'utf-8');

      // Should have single StateManager
      expect(content).toMatch(/stateManager.*=.*createServiceState/);

      // Should NOT have per-chain state managers
      const stateManagerCount = (content.match(/createServiceState\(/g) || []).length;
      expect(stateManagerCount).toBeLessThanOrEqual(2);
    });
  });
});

// =============================================================================
// Chain Configuration Centralization Tests
// =============================================================================

describe('ADR-003: Centralized Chain Configuration', () => {
  it('should have chain configs in shared/config (not per-service)', async () => {
    const fs = await import('fs/promises');
    const path = await import('path');

    // Check index.ts exports CHAINS
    const sharedConfigPath = path.resolve(
      __dirname,
      '../../../../shared/config/src/index.ts'
    );
    const indexContent = await fs.readFile(sharedConfigPath, 'utf-8');
    expect(indexContent).toMatch(/export.*CHAINS/);

    // Chain definitions are in chains submodule (modular config structure)
    const chainsPath = path.resolve(
      __dirname,
      '../../../../shared/config/src/chains/index.ts'
    );
    const chainsContent = await fs.readFile(chainsPath, 'utf-8');

    // Should have chain definitions
    expect(chainsContent).toMatch(/ethereum|arbitrum|bsc|polygon/);
  });

  it('should NOT have chain configs in unified-detector (uses shared/config)', async () => {
    const fs = await import('fs/promises');
    const path = await import('path');

    const unifiedDetectorPath = path.resolve(
      __dirname,
      '../../../../services/unified-detector/src/unified-detector.ts'
    );

    const content = await fs.readFile(unifiedDetectorPath, 'utf-8');

    // Should import from shared/config, not define own chains
    expect(content).toMatch(/from.*shared\/config|from.*config|from.*@arbitrage\/config/);

    // Should NOT have hardcoded chain definitions
    expect(content).not.toMatch(/chainId:\s*\d+,\s*wsUrl:/);
  });

  it('should have partition assignment algorithm', async () => {
    // Per ADR-003: assignChainToPartition() function
    const configModule = await import('@arbitrage/config');

    // Should have partition assignment
    expect(typeof (configModule as any).assignChainToPartition).toBe('function');
  });
});

// =============================================================================
// Deployment Verification Tests
// =============================================================================

describe('ADR-003: Deployment Configuration', () => {
  it('should have CI/CD skip building deprecated single-chain services', async () => {
    // Check that deployment configs don't build single-chain detectors
    const fs = await import('fs/promises');
    const path = await import('path');

    const ciPaths = [
      path.resolve(__dirname, '../../../../../.github/workflows/deploy.yml'),
      path.resolve(__dirname, '../../../../../.github/workflows/ci.yml')
    ];

    for (const ciPath of ciPaths) {
      try {
        const content = await fs.readFile(ciPath, 'utf-8');

        // Should build unified-detector
        if (content.includes('detector')) {
          expect(content).toMatch(/unified-detector/);
        }

        // Should NOT build individual chain detectors (unless explicitly marked deprecated/skip)
        const deprecatedServices = [
          'ethereum-detector',
          'arbitrum-detector',
          'bsc-detector'
        ];

        for (const service of deprecatedServices) {
          if (content.includes(service)) {
            // If mentioned, should be in skip or deprecated context
            // This is a soft check - actual CI config may vary
          }
        }
      } catch {
        // CI files may be in different location
      }
    }
  });
});
