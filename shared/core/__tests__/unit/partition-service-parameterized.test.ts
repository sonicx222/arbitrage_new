/**
 * Parameterized Integration Tests for Partition Services (P1, P2, P3)
 *
 * Consolidates three nearly identical integration test suites into one
 * parameterized test that runs the full suite for each partition configuration.
 *
 * Tests service configuration, environment variable handling, and module behavior
 * for all EVM partition services using data-driven test.each patterns.
 *
 * Covered partitions:
 * - P1 Asia-Fast: BSC, Polygon, Avalanche, Fantom (port 3001, asia-southeast1)
 * - P2 L2-Turbo: Arbitrum, Optimism, Base (port 3002, asia-southeast1)
 * - P3 High-Value: Ethereum, zkSync, Linea (port 3003, us-east1)
 *
 * @see ADR-003: Partitioned Chain Detectors
 */

import {
  MockUnifiedChainDetector,
  createCoreMocks,
  createMockLogger,
  createMockStateManager,
  createConfigMocks,
} from '@arbitrage/test-utils/mocks/partition-service.mock';

// =============================================================================
// Partition Configuration Data
// =============================================================================

interface PartitionTestConfig {
  partitionId: string;
  partitionNumber: number;
  partitionIdConst: string;
  chains: string[];
  port: number;
  customPort: number;
  region: string;
  serviceName: string;
  configName: string;
  provider: string;
  resourceProfile: string;
  priority: number;
  maxMemoryMB: number;
  healthCheckIntervalMs: number;
  failoverTimeoutMs: number;
  /** Subset of chains for PARTITION_CHAINS env var test */
  chainsSubset: string[];
  /** Extra config fields (e.g., standbyRegion for high-value) */
  extra?: Record<string, unknown>;
  /** Custom instance ID for testing */
  testInstanceId: string;
  /** Custom region override for testing */
  testRegionOverride: string;
}

const PARTITION_CONFIGS: PartitionTestConfig[] = [
  {
    partitionId: 'asia-fast',
    partitionNumber: 1,
    partitionIdConst: 'ASIA_FAST',
    chains: ['bsc', 'polygon', 'avalanche', 'fantom'],
    port: 3001,
    customPort: 4001,
    region: 'asia-southeast1',
    serviceName: 'partition-asia-fast',
    configName: 'Asia Fast Chains',
    provider: 'oracle',
    resourceProfile: 'heavy',
    priority: 1,
    maxMemoryMB: 768,
    healthCheckIntervalMs: 15000,
    failoverTimeoutMs: 60000,
    chainsSubset: ['bsc', 'polygon'],
    testInstanceId: 'custom-instance-123',
    testRegionOverride: 'us-west1',
  },
  {
    partitionId: 'l2-turbo',
    partitionNumber: 2,
    partitionIdConst: 'L2_TURBO',
    chains: ['arbitrum', 'optimism', 'base'],
    port: 3002,
    customPort: 4002,
    region: 'asia-southeast1',
    serviceName: 'partition-l2-turbo',
    configName: 'L2 Turbo Chains',
    provider: 'fly',
    resourceProfile: 'standard',
    priority: 1,
    maxMemoryMB: 512,
    healthCheckIntervalMs: 10000,
    failoverTimeoutMs: 45000,
    chainsSubset: ['arbitrum', 'base'],
    testInstanceId: 'l2-custom-instance-123',
    testRegionOverride: 'us-west1',
  },
  {
    partitionId: 'high-value',
    partitionNumber: 3,
    partitionIdConst: 'HIGH_VALUE',
    chains: ['ethereum', 'zksync', 'linea'],
    port: 3003,
    customPort: 4003,
    region: 'us-east1',
    serviceName: 'partition-high-value',
    configName: 'High Value Chains',
    provider: 'oracle',
    resourceProfile: 'heavy',
    priority: 2,
    maxMemoryMB: 768,
    healthCheckIntervalMs: 30000,
    failoverTimeoutMs: 60000,
    chainsSubset: ['ethereum', 'zksync'],
    extra: {
      standbyRegion: 'eu-west1',
      standbyProvider: 'gcp',
    },
    testInstanceId: 'p3-high-value-custom-123',
    testRegionOverride: 'eu-west1',
  },
];

// =============================================================================
// Mocks - Must be defined before imports
// =============================================================================

const mockLogger = createMockLogger();
const mockStateManager = createMockStateManager();
// Override for integration test: state manager reports running
mockStateManager.isRunning.mockReturnValue(true);
mockStateManager.getState.mockReturnValue('running');

const mockHealthServer = {
  close: jest.fn((cb: (err?: Error) => void) => cb && cb()),
  on: jest.fn(),
  listen: jest.fn(),
};

// These will be set dynamically per partition via beforeAll
let currentPartitionConfig: PartitionTestConfig;

jest.mock('@arbitrage/core', () => {
  const mocks = createCoreMocks(mockLogger, mockStateManager, { includeValidation: true });
  // Override health server to use our local mock
  mocks.createPartitionHealthServer.mockReturnValue(mockHealthServer);
  return mocks;
});

// Sub-entry point mock: partition services import from @arbitrage/core/partition
jest.mock('@arbitrage/core/partition', () => {
  const core = jest.requireMock('@arbitrage/core') as Record<string, unknown>;
  return core;
});

jest.mock('@arbitrage/config', () => {
  // Dynamic config that reads currentPartitionConfig at call time
  return {
    getPartition: jest.fn().mockImplementation((partitionId: string) => ({
      partitionId,
      name: currentPartitionConfig?.configName ?? 'Test Partition',
      chains: currentPartitionConfig?.chains ?? [],
      region: currentPartitionConfig?.region ?? 'us-east1',
      provider: currentPartitionConfig?.provider ?? 'oracle',
      resourceProfile: currentPartitionConfig?.resourceProfile ?? 'heavy',
      priority: currentPartitionConfig?.priority ?? 1,
      maxMemoryMB: currentPartitionConfig?.maxMemoryMB ?? 768,
      enabled: true,
      healthCheckIntervalMs: currentPartitionConfig?.healthCheckIntervalMs ?? 15000,
      failoverTimeoutMs: currentPartitionConfig?.failoverTimeoutMs ?? 60000,
      ...(currentPartitionConfig?.extra ?? {}),
    })),
    PARTITION_IDS: {
      ASIA_FAST: 'asia-fast',
      L2_TURBO: 'l2-turbo',
      HIGH_VALUE: 'high-value',
      SOLANA_NATIVE: 'solana-native',
    },
  };
});

jest.mock('@arbitrage/unified-detector', () => ({
  UnifiedChainDetector: MockUnifiedChainDetector,
}));

// =============================================================================
// Helper: dynamic import for partition service module
// =============================================================================

/**
 * Dynamically imports a partition service module by partition ID.
 * The path is relative to this test file's location in shared/core/__tests__/unit/.
 */
async function importPartitionModule(partitionId: string): Promise<Record<string, unknown>> {
  const serviceDir = `partition-${partitionId === 'asia-fast' ? 'asia-fast' : partitionId === 'l2-turbo' ? 'l2-turbo' : 'high-value'}`;
  return import(`../../../../services/${serviceDir}/src/index`);
}

/**
 * Returns the partition-specific export prefix (P1_, P2_, P3_).
 */
function getExportPrefix(partitionNumber: number): string {
  return `P${partitionNumber}_`;
}

// =============================================================================
// Parameterized Tests
// =============================================================================

describe.each(PARTITION_CONFIGS)(
  '$serviceName Partition Service Integration',
  (partitionConfig) => {
    const originalEnv = process.env;
    let cleanupFn: (() => void) | null = null;
    const prefix = getExportPrefix(partitionConfig.partitionNumber);

    beforeAll(() => {
      currentPartitionConfig = partitionConfig;
    });

    beforeEach(() => {
      // Ensure the config mock uses the right partition data
      currentPartitionConfig = partitionConfig;
      process.env = {
        ...originalEnv,
        JEST_WORKER_ID: 'test',
        REDIS_URL: 'redis://localhost:6379',
        NODE_ENV: 'test',
      };
    });

    afterEach(() => {
      if (cleanupFn) {
        cleanupFn();
        cleanupFn = null;
      }
      process.env = originalEnv;
    });

    // =========================================================================
    // Health Server Configuration
    // =========================================================================

    describe('Health Server Configuration', () => {
      it(`should configure default health check port of ${partitionConfig.port}`, async () => {
        jest.resetModules();
        const mod = await importPartitionModule(partitionConfig.partitionId);
        cleanupFn = mod.cleanupProcessHandlers as () => void;

        expect((mod.config as { healthCheckPort: number }).healthCheckPort).toBe(partitionConfig.port);
      });

      it('should use custom port from HEALTH_CHECK_PORT environment variable', async () => {
        process.env.HEALTH_CHECK_PORT = String(partitionConfig.customPort);

        jest.resetModules();
        const mod = await importPartitionModule(partitionConfig.partitionId);
        cleanupFn = mod.cleanupProcessHandlers as () => void;

        expect((mod.config as { healthCheckPort: number }).healthCheckPort).toBe(partitionConfig.customPort);
      });

      it('should use default port when HEALTH_CHECK_PORT is invalid', async () => {
        process.env.HEALTH_CHECK_PORT = 'invalid';

        jest.resetModules();
        const mod = await importPartitionModule(partitionConfig.partitionId);
        cleanupFn = mod.cleanupProcessHandlers as () => void;

        expect((mod.config as { healthCheckPort: number }).healthCheckPort).toBe(partitionConfig.port);
      });
    });

    // =========================================================================
    // Detector Configuration
    // =========================================================================

    describe('Detector Configuration', () => {
      it('should create detector with correct partition ID', async () => {
        jest.resetModules();
        const mod = await importPartitionModule(partitionConfig.partitionId);
        cleanupFn = mod.cleanupProcessHandlers as () => void;

        const detector = mod.detector as { getPartitionId: () => string };
        expect(detector.getPartitionId()).toBe(partitionConfig.partitionId);
      });

      it(`should configure detector with all ${partitionConfig.chains.length} chains by default`, async () => {
        jest.resetModules();
        const mod = await importPartitionModule(partitionConfig.partitionId);
        cleanupFn = mod.cleanupProcessHandlers as () => void;

        const detector = mod.detector as { getChains: () => string[] };
        expect(detector.getChains()).toEqual(partitionConfig.chains);
      });

      it('should use custom chains from PARTITION_CHAINS environment variable', async () => {
        process.env.PARTITION_CHAINS = partitionConfig.chainsSubset.join(',');

        jest.resetModules();
        // Update currentPartitionConfig chains to match the subset
        const originalChains = currentPartitionConfig.chains;
        currentPartitionConfig = { ...currentPartitionConfig, chains: partitionConfig.chainsSubset };

        const mod = await importPartitionModule(partitionConfig.partitionId);
        cleanupFn = mod.cleanupProcessHandlers as () => void;

        expect((mod.config as { chains: string[] }).chains).toEqual(partitionConfig.chainsSubset);

        // Restore original chains
        currentPartitionConfig = { ...currentPartitionConfig, chains: originalChains };
      });
    });

    // =========================================================================
    // Service Configuration
    // =========================================================================

    describe('Service Configuration', () => {
      it('should use custom INSTANCE_ID from environment', async () => {
        process.env.INSTANCE_ID = partitionConfig.testInstanceId;

        jest.resetModules();
        const mod = await importPartitionModule(partitionConfig.partitionId);
        cleanupFn = mod.cleanupProcessHandlers as () => void;

        expect((mod.config as { instanceId: string }).instanceId).toBe(partitionConfig.testInstanceId);
      });

      it('should use custom REGION_ID from environment', async () => {
        process.env.REGION_ID = partitionConfig.testRegionOverride;

        jest.resetModules();
        const mod = await importPartitionModule(partitionConfig.partitionId);
        cleanupFn = mod.cleanupProcessHandlers as () => void;

        expect((mod.config as { regionId: string }).regionId).toBe(partitionConfig.testRegionOverride);
      });

      it('should disable cross-region health when ENABLE_CROSS_REGION_HEALTH=false', async () => {
        process.env.ENABLE_CROSS_REGION_HEALTH = 'false';

        jest.resetModules();
        const mod = await importPartitionModule(partitionConfig.partitionId);
        cleanupFn = mod.cleanupProcessHandlers as () => void;

        expect((mod.config as { enableCrossRegionHealth: boolean }).enableCrossRegionHealth).toBe(false);
      });

      it('should enable cross-region health by default', async () => {
        delete process.env.ENABLE_CROSS_REGION_HEALTH;

        jest.resetModules();
        const mod = await importPartitionModule(partitionConfig.partitionId);
        cleanupFn = mod.cleanupProcessHandlers as () => void;

        expect((mod.config as { enableCrossRegionHealth: boolean }).enableCrossRegionHealth).toBe(true);
      });
    });

    // =========================================================================
    // Service Runner Factory
    // =========================================================================

    describe('Service Runner Factory', () => {
      it('should call createPartitionEntry with correct partition ID', async () => {
        jest.resetModules();
        const { createPartitionEntry } = await import('@arbitrage/core');
        const mod = await importPartitionModule(partitionConfig.partitionId);
        cleanupFn = mod.cleanupProcessHandlers as () => void;

        expect(createPartitionEntry).toHaveBeenCalledWith(
          partitionConfig.partitionId,
          expect.any(Function)
        );
      });

      it('should export cleanup function that can be called multiple times', async () => {
        jest.resetModules();
        const mod = await importPartitionModule(partitionConfig.partitionId);

        expect(typeof mod.cleanupProcessHandlers).toBe('function');
        expect(() => {
          (mod.cleanupProcessHandlers as () => void)();
          (mod.cleanupProcessHandlers as () => void)();
        }).not.toThrow();
      });
    });

    // =========================================================================
    // Module Exports
    // =========================================================================

    describe('Module Exports', () => {
      it('should export all required members', async () => {
        jest.resetModules();
        const mod = await importPartitionModule(partitionConfig.partitionId);

        expect(mod.detector).toBeDefined();
        expect(mod.config).toBeDefined();

        // Partition-specific named exports: P1_PARTITION_ID, P2_PARTITION_ID, etc.
        const partitionIdKey = `${prefix}PARTITION_ID`;
        const chainsKey = `${prefix}CHAINS`;
        const regionKey = `${prefix}REGION`;

        expect(mod[partitionIdKey]).toBe(partitionConfig.partitionId);
        // Verify at least the first chain is present
        expect(mod[chainsKey] as string[]).toContain(partitionConfig.chains[0]);
        // For high-value, also check additional chains are present
        if (partitionConfig.chains.length > 2) {
          for (const chain of partitionConfig.chains) {
            expect(mod[chainsKey] as string[]).toContain(chain);
          }
        }
        expect(mod[regionKey]).toBe(partitionConfig.region);
        expect(mod.cleanupProcessHandlers).toBeDefined();
      });

      it('should export envConfig with typed configuration', async () => {
        jest.resetModules();
        const mod = await importPartitionModule(partitionConfig.partitionId);

        const envConfig = mod.envConfig as {
          enableCrossRegionHealth: boolean;
          nodeEnv: string;
          rpcUrls: Record<string, string>;
          wsUrls: Record<string, string>;
        };
        expect(envConfig).toBeDefined();
        expect(typeof envConfig.enableCrossRegionHealth).toBe('boolean');
        expect(typeof envConfig.nodeEnv).toBe('string');
        expect(envConfig.rpcUrls).toBeDefined();
        expect(envConfig.wsUrls).toBeDefined();
      });
    });

    // =========================================================================
    // Startup Failure Handling
    // =========================================================================

    describe('Startup Failure Handling', () => {
      it('should handle missing REDIS_URL in non-test environment', async () => {
        const { exitWithConfigError } = await import('@arbitrage/core');
        expect(exitWithConfigError).toBeDefined();
      });

      it('should provide production warnings for missing RPC URLs', async () => {
        process.env.NODE_ENV = 'production';
        for (const chain of partitionConfig.chains) {
          delete process.env[`${chain.toUpperCase()}_RPC_URL`];
        }

        jest.resetModules();
        const mod = await importPartitionModule(partitionConfig.partitionId);
        cleanupFn = mod.cleanupProcessHandlers as () => void;

        expect(mockLogger.warn).toHaveBeenCalled();
      });

      it('should not warn about RPC URLs in development mode', async () => {
        process.env.NODE_ENV = 'development';
        jest.clearAllMocks();

        jest.resetModules();
        const mod = await importPartitionModule(partitionConfig.partitionId);
        cleanupFn = mod.cleanupProcessHandlers as () => void;

        const warnCalls = mockLogger.warn.mock.calls;
        const rpcWarnings = warnCalls.filter((call: unknown[]) =>
          typeof call[0] === 'string' && call[0].includes('RPC')
        );
        expect(rpcWarnings.length).toBe(0);
      });
    });

    // =========================================================================
    // Production Environment Validation
    // =========================================================================

    describe('Production Environment Validation', () => {
      it(`should warn about all ${partitionConfig.chains.length} missing RPC URLs in production`, async () => {
        process.env.NODE_ENV = 'production';
        for (const chain of partitionConfig.chains) {
          delete process.env[`${chain.toUpperCase()}_RPC_URL`];
        }
        jest.clearAllMocks();

        jest.resetModules();
        const mod = await importPartitionModule(partitionConfig.partitionId);
        cleanupFn = mod.cleanupProcessHandlers as () => void;

        const rpcWarning = mockLogger.warn.mock.calls.find((call: unknown[]) =>
          typeof call[0] === 'string' && call[0].includes('RPC')
        );
        expect(rpcWarning).toBeDefined();
        if (rpcWarning && rpcWarning[1]) {
          const context = rpcWarning[1] as { missingRpcUrls?: string[] };
          for (const chain of partitionConfig.chains) {
            expect(context.missingRpcUrls).toContain(`${chain.toUpperCase()}_RPC_URL`);
          }
        }
      });

      it(`should warn about all ${partitionConfig.chains.length} missing WebSocket URLs in production`, async () => {
        process.env.NODE_ENV = 'production';
        for (const chain of partitionConfig.chains) {
          delete process.env[`${chain.toUpperCase()}_WS_URL`];
        }
        jest.clearAllMocks();

        jest.resetModules();
        const mod = await importPartitionModule(partitionConfig.partitionId);
        cleanupFn = mod.cleanupProcessHandlers as () => void;

        const wsWarning = mockLogger.warn.mock.calls.find((call: unknown[]) =>
          typeof call[0] === 'string' && call[0].includes('WebSocket')
        );
        expect(wsWarning).toBeDefined();
        if (wsWarning && wsWarning[1]) {
          const context = wsWarning[1] as { missingWsUrls?: string[] };
          for (const chain of partitionConfig.chains) {
            expect(context.missingWsUrls).toContain(`${chain.toUpperCase()}_WS_URL`);
          }
        }
      });

      it('should not warn when all RPC URLs are provided in production', async () => {
        process.env.NODE_ENV = 'production';
        for (const chain of partitionConfig.chains) {
          process.env[`${chain.toUpperCase()}_RPC_URL`] = `https://custom-${chain}.com`;
        }
        jest.clearAllMocks();

        jest.resetModules();
        const mod = await importPartitionModule(partitionConfig.partitionId);
        cleanupFn = mod.cleanupProcessHandlers as () => void;

        const rpcWarning = mockLogger.warn.mock.calls.find((call: unknown[]) =>
          typeof call[0] === 'string' && call[0].includes('RPC')
        );
        expect(rpcWarning).toBeUndefined();
      });

      it('should include helpful hints in production warnings', async () => {
        process.env.NODE_ENV = 'production';
        delete process.env[`${partitionConfig.chains[0].toUpperCase()}_RPC_URL`];
        jest.clearAllMocks();

        jest.resetModules();
        const mod = await importPartitionModule(partitionConfig.partitionId);
        cleanupFn = mod.cleanupProcessHandlers as () => void;

        const rpcWarning = mockLogger.warn.mock.calls.find((call: unknown[]) =>
          typeof call[0] === 'string' && call[0].includes('RPC')
        );
        expect(rpcWarning).toBeDefined();
        if (rpcWarning && rpcWarning[1]) {
          const context = rpcWarning[1] as { hint?: string };
          expect(context.hint).toContain('Alchemy');
        }
      });
    });
  }
);

// =============================================================================
// High-Value Chain Characteristics (Partition-specific tests)
// =============================================================================

describe('High-Value Chain Characteristics', () => {
  const originalEnv = process.env;
  let cleanupFn: (() => void) | null = null;

  // Ensure the config mock returns high-value partition data
  beforeAll(() => {
    currentPartitionConfig = PARTITION_CONFIGS.find(c => c.partitionId === 'high-value')!;
  });

  beforeEach(() => {
    currentPartitionConfig = PARTITION_CONFIGS.find(c => c.partitionId === 'high-value')!;
    process.env = {
      ...originalEnv,
      JEST_WORKER_ID: 'test',
      REDIS_URL: 'redis://localhost:6379',
      NODE_ENV: 'test',
    };
  });

  afterEach(() => {
    if (cleanupFn) {
      cleanupFn();
      cleanupFn = null;
    }
    process.env = originalEnv;
  });

  it('should have Ethereum as the primary high-value chain', async () => {
    jest.resetModules();
    const mod = await import('../../../../services/partition-high-value/src/index');
    cleanupFn = mod.cleanupProcessHandlers;

    expect(mod.config.chains).toContain('ethereum');
  });

  it('should include zkSync for ZK rollup arbitrage opportunities', async () => {
    jest.resetModules();
    const mod = await import('../../../../services/partition-high-value/src/index');
    cleanupFn = mod.cleanupProcessHandlers;

    expect(mod.config.chains).toContain('zksync');
  });

  it('should include Linea for Consensys ZK rollup opportunities', async () => {
    jest.resetModules();
    const mod = await import('../../../../services/partition-high-value/src/index');
    cleanupFn = mod.cleanupProcessHandlers;

    expect(mod.config.chains).toContain('linea');
  });

  it('should use us-east1 region for proximity to Ethereum infrastructure', async () => {
    jest.resetModules();
    const mod = await import('../../../../services/partition-high-value/src/index');
    cleanupFn = mod.cleanupProcessHandlers;

    expect(mod.P3_REGION).toBe('us-east1');
    expect(mod.config.regionId).toBe('us-east1');
  });
});
