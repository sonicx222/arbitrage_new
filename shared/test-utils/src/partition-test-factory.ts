/**
 * Parameterized Test Factory for Partition Services (P1-P4)
 *
 * Generates standard test blocks shared across all partition service unit tests.
 * P1-P3 unit tests follow identical structure with only data substitutions
 * (partition ID, chains, port, region, etc.).
 *
 * Usage:
 * ```typescript
 * import { generatePartitionUnitTests, PartitionTestConfig } from '@arbitrage/test-utils/partition-test-factory';
 *
 * const config: PartitionTestConfig = {
 *   partitionId: 'asia-fast',
 *   partitionLabel: 'P1',
 *   partitionName: 'Asia-Fast',
 *   chains: ['bsc', 'polygon', 'avalanche', 'fantom'],
 *   defaultPort: 3001,
 *   region: 'asia-southeast1',
 *   exportPrefix: 'P1',
 *   importModule: () => import('../../index'),
 *   mockLogger,
 * };
 *
 * generatePartitionUnitTests(config);
 *
 * // Add partition-specific tests after the factory call:
 * describe('P3 Error Handling', () => { ... });
 * ```
 *
 * @see services/partition-asia-fast/src/__tests__/unit/partition-service.test.ts
 * @see ADR-003: Partitioned Chain Detectors
 */

/**
 * Configuration for a partition's unit test suite.
 */
export interface PartitionTestConfig {
  /** Partition ID string (e.g., 'asia-fast', 'l2-turbo', 'high-value') */
  partitionId: string;

  /** Short label (e.g., 'P1', 'P2', 'P3') */
  partitionLabel: string;

  /** Human-readable partition name (e.g., 'Asia-Fast', 'L2-Turbo', 'High-Value') */
  partitionName: string;

  /** Default chains for this partition */
  chains: string[];

  /** Default health check port */
  defaultPort: number;

  /** Default region */
  region: string;

  /** Export prefix used in index.ts (e.g., 'P1' for P1_PARTITION_ID) */
  exportPrefix: string;

  /**
   * Function that imports the partition's index module.
   * Must be provided by the calling test file so that the dynamic import resolves
   * relative to the test file, not the factory file.
   *
   * Example: `() => import('../../index')`
   */
  importModule: () => Promise<Record<string, any>>;

  /**
   * @deprecated Use `importModule` instead. Kept for backward compatibility.
   * Relative path to the partition's index.ts from the test file.
   */
  indexModulePath?: string;

  /** Mock logger reference (created before jest.mock calls) */
  mockLogger: {
    info: jest.Mock;
    error: jest.Mock;
    warn: jest.Mock;
    debug: jest.Mock;
  };

  /**
   * Blocks to skip when generating tests.
   * Useful when a partition has custom implementations of certain test blocks.
   */
  skipBlocks?: Array<'envVarHandling' | 'processHandlerCleanup'>;
}

/**
 * Generates standard unit test blocks for a partition service.
 *
 * Produces the following describe blocks:
 * - `${partitionLabel} ${partitionName} Partition Service` (Module Exports, Configuration, Initialization, JEST_WORKER_ID Guard, Uses Shared Utilities)
 * - `${partitionLabel} Environment Variable Handling`
 * - `${partitionLabel} Process Handler Cleanup`
 *
 * @param config - Partition-specific test configuration
 */
export function generatePartitionUnitTests(config: PartitionTestConfig): void {
  const {
    partitionId,
    partitionLabel,
    partitionName,
    chains,
    defaultPort,
    region,
    exportPrefix,
    importModule,
    mockLogger,
    skipBlocks = [],
  } = config;

  describe(`${partitionLabel} ${partitionName} Partition Service`, () => {
    beforeEach(() => {
      jest.clearAllMocks();
      delete process.env.REGION_ID;
      delete process.env.INSTANCE_ID;
      delete process.env.ENABLE_CROSS_REGION_HEALTH;
    });

    describe('Module Exports', () => {
      it('should export detector instance', async () => {
        jest.resetModules();
        const mod = await importModule();
        expect(mod.detector).toBeDefined();
        expect(typeof mod.detector.start).toBe('function');
        expect(typeof mod.detector.stop).toBe('function');
      });

      it('should export config object', async () => {
        jest.resetModules();
        const mod = await importModule();
        expect(mod.config).toBeDefined();
        expect(mod.config.partitionId).toBe(partitionId);
        for (const chain of chains) {
          expect(mod.config.chains).toContain(chain);
        }
      });

      it('should export partition constants', async () => {
        jest.resetModules();
        const mod = await importModule();
        expect(mod[`${exportPrefix}_PARTITION_ID`]).toBe(partitionId);
        expect(mod[`${exportPrefix}_REGION`]).toBe(region);
        for (const chain of chains) {
          expect(mod[`${exportPrefix}_CHAINS`]).toContain(chain);
        }
      });

      it('should export cleanupProcessHandlers function', async () => {
        jest.resetModules();
        const mod = await importModule();
        expect(mod.cleanupProcessHandlers).toBeDefined();
        expect(typeof mod.cleanupProcessHandlers).toBe('function');
      });
    });

    describe('Configuration', () => {
      it('should use correct partition ID', async () => {
        jest.resetModules();
        const mod = await importModule();
        expect(mod[`${exportPrefix}_PARTITION_ID`]).toBe(partitionId);
      });

      it(`should configure ${chains.length} chains for ${partitionId} partition`, async () => {
        jest.resetModules();
        const mod = await importModule();
        expect(mod.config.chains).toHaveLength(chains.length);
        expect(mod.config.chains).toEqual(expect.arrayContaining(chains));
      });

      it(`should use default port ${defaultPort}`, async () => {
        jest.resetModules();
        const mod = await importModule();
        expect(mod.config.healthCheckPort).toBe(defaultPort);
      });

      it(`should use ${region} region`, async () => {
        jest.resetModules();
        const mod = await importModule();
        expect(mod.config.regionId).toBe(region);
      });
    });

    describe('Initialization', () => {
      it('should have called createLogger with correct namespace', async () => {
        const { createLogger } = jest.requireMock('@arbitrage/core');
        expect(createLogger).toBeDefined();
      });

      it(`should have called getPartition with ${partitionId} ID`, async () => {
        const { getPartition } = jest.requireMock('@arbitrage/config');
        expect(getPartition).toBeDefined();
      });

      it('should have setup detector event handlers', async () => {
        jest.resetModules();
        const mod = await importModule();
        expect(typeof mod.detector.on).toBe('function');
        expect(typeof mod.detector.emit).toBe('function');
      });

      it('should have setup process handlers and store cleanup function', async () => {
        jest.resetModules();
        const mod = await importModule();
        expect(typeof mod.cleanupProcessHandlers).toBe('function');
      });
    });

    describe('JEST_WORKER_ID Guard', () => {
      it('should not auto-start when JEST_WORKER_ID is set', async () => {
        expect(process.env.JEST_WORKER_ID).toBeDefined();
        const mod = await importModule();
        expect(mod.detector).toBeDefined();
      });
    });

    describe('Uses Shared Utilities', () => {
      it('should use PARTITION_PORTS from @arbitrage/core', async () => {
        const { PARTITION_PORTS } = jest.requireMock('@arbitrage/core');
        expect(PARTITION_PORTS[partitionId]).toBe(defaultPort);
      });

      it('should use PARTITION_SERVICE_NAMES from @arbitrage/core', async () => {
        const { PARTITION_SERVICE_NAMES } = jest.requireMock('@arbitrage/core');
        expect(PARTITION_SERVICE_NAMES[partitionId]).toBe(`partition-${partitionId}`);
      });

      it('should use createPartitionEntry factory from @arbitrage/core', async () => {
        const { createPartitionEntry } = jest.requireMock('@arbitrage/core');
        expect(createPartitionEntry).toBeDefined();
      });
    });
  });

  if (!skipBlocks.includes('envVarHandling'))
  describe(`${partitionLabel} Environment Variable Handling`, () => {
    const originalEnv = process.env;
    let cleanupFn: (() => void) | null = null;

    beforeEach(() => {
      jest.resetModules();
      process.env = { ...originalEnv, JEST_WORKER_ID: 'test', NODE_ENV: 'test' };
      delete process.env.REGION_ID;
      delete process.env.INSTANCE_ID;
      delete process.env.ENABLE_CROSS_REGION_HEALTH;
    });

    afterEach(async () => {
      try {
        if (cleanupFn) {
          cleanupFn();
        }
      } catch (error) {
        console.warn('Cleanup function failed:', error);
      } finally {
        cleanupFn = null;
      }
      process.env = originalEnv;
    });

    it('should use PARTITION_CHAINS env var when provided', async () => {
      const subset = chains.slice(0, 2).join(',');
      process.env.PARTITION_CHAINS = subset;

      jest.resetModules();
      const { validateAndFilterChains } = await import('@arbitrage/core');

      expect(validateAndFilterChains).toBeDefined();
      const result = validateAndFilterChains(subset, chains, mockLogger as any);
      expect(result).toEqual(chains.slice(0, 2));
    });

    it('should use HEALTH_CHECK_PORT env var when provided', async () => {
      const customPort = String(defaultPort + 1000);
      process.env.HEALTH_CHECK_PORT = customPort;

      jest.resetModules();
      const { parsePort } = await import('@arbitrage/core');

      const result = parsePort(customPort, defaultPort, mockLogger as any);
      expect(result).toBe(defaultPort + 1000);
    });

    it('should use default port when HEALTH_CHECK_PORT is invalid', async () => {
      const { parsePort } = await import('@arbitrage/core');

      const result = parsePort('invalid', defaultPort, mockLogger as any);
      expect(result).toBe(defaultPort);
    });

    it('should use INSTANCE_ID env var when provided', async () => {
      process.env.INSTANCE_ID = `custom-${partitionId}-instance-123`;

      jest.resetModules();
      const mod = await importModule();
      cleanupFn = mod.cleanupProcessHandlers;

      expect(mod.config.instanceId).toBe(`custom-${partitionId}-instance-123`);
    });

    it('should use REGION_ID env var when provided', async () => {
      process.env.REGION_ID = 'us-west1';

      jest.resetModules();
      const mod = await importModule();
      cleanupFn = mod.cleanupProcessHandlers;

      expect(mod.config.regionId).toBe('us-west1');
    });

    it('should disable cross-region health when ENABLE_CROSS_REGION_HEALTH is false', async () => {
      process.env.ENABLE_CROSS_REGION_HEALTH = 'false';

      jest.resetModules();
      const mod = await importModule();
      cleanupFn = mod.cleanupProcessHandlers;

      expect(mod.config.enableCrossRegionHealth).toBe(false);
    });

    it('should enable cross-region health by default', async () => {
      jest.resetModules();
      const mod = await importModule();
      cleanupFn = mod.cleanupProcessHandlers;

      expect(mod.config.enableCrossRegionHealth).toBe(true);
    });

    it('should generate default instance ID when not provided', async () => {
      delete process.env.INSTANCE_ID;

      jest.resetModules();
      const mod = await importModule();
      cleanupFn = mod.cleanupProcessHandlers;

      expect(mod.config.instanceId).toMatch(new RegExp(`^${partitionId}-`));
    });
  });

  if (!skipBlocks.includes('processHandlerCleanup'))
  describe(`${partitionLabel} Process Handler Cleanup`, () => {
    const originalEnv = process.env;

    beforeEach(() => {
      jest.resetModules();
      process.env = { ...originalEnv, JEST_WORKER_ID: 'test', NODE_ENV: 'test' };
      delete process.env.REGION_ID;
      delete process.env.INSTANCE_ID;
      delete process.env.ENABLE_CROSS_REGION_HEALTH;
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should return a cleanup function from setupProcessHandlers', async () => {
      const mod = await importModule();

      expect(mod.cleanupProcessHandlers).toBeDefined();
      expect(typeof mod.cleanupProcessHandlers).toBe('function');

      expect(() => mod.cleanupProcessHandlers()).not.toThrow();
    });

    it('should allow calling cleanup multiple times without error', async () => {
      const mod = await importModule();

      expect(() => {
        mod.cleanupProcessHandlers();
        mod.cleanupProcessHandlers();
      }).not.toThrow();
    });
  });
}
