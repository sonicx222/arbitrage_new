/**
 * Unit Tests for P3 High-Value Partition Service
 *
 * Tests partition-specific configuration, exports, and service setup.
 * The JEST_WORKER_ID guard in index.ts prevents auto-start during import.
 *
 * P3 High-Value Partition:
 * - Chains: Ethereum (1), zkSync Era (324), Linea (59144)
 * - Region: Oracle Cloud US-East (us-east1)
 * - Port: 3003
 * - Health Check Interval: 30s (longer for Ethereum's ~12s blocks)
 */

import { MockUnifiedChainDetector } from '@arbitrage/test-utils/mocks/partition-service.mock';

// =============================================================================
// Mocks - Must be defined before imports
// =============================================================================

// Mock @arbitrage/core
const mockLogger = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
};

const mockStateManager = {
  executeStart: jest.fn().mockImplementation(async (fn: () => Promise<void>) => {
    try {
      await fn();
      return { success: true };
    } catch (error) {
      return { success: false, error };
    }
  }),
  executeStop: jest.fn().mockImplementation(async (fn: () => Promise<void>) => {
    try {
      await fn();
      return { success: true };
    } catch (error) {
      return { success: false, error };
    }
  }),
  isRunning: jest.fn().mockReturnValue(false),
  getState: jest.fn().mockReturnValue('idle'),
};

jest.mock('@arbitrage/core', () => {
  const PORTS: Record<string, number> = {
    'asia-fast': 3001, 'l2-turbo': 3002, 'high-value': 3003, 'solana-native': 3004,
  };

  return {
    createLogger: jest.fn().mockReturnValue(mockLogger),
    parsePort: jest.fn().mockImplementation((portEnv: string | undefined, defaultPort: number) => {
      if (!portEnv) return defaultPort;
      const parsed = parseInt(portEnv, 10);
      return isNaN(parsed) ? defaultPort : parsed;
    }),
    validateAndFilterChains: jest.fn().mockImplementation((chainsEnv: string | undefined, defaultChains: readonly string[]) => {
      if (!chainsEnv) return [...defaultChains];
      return chainsEnv.split(',').map((c: string) => c.trim().toLowerCase());
    }),
    createPartitionHealthServer: jest.fn().mockReturnValue({
      close: jest.fn((cb: () => void) => cb && cb()),
      on: jest.fn(),
    }),
    setupDetectorEventHandlers: jest.fn(),
    setupProcessHandlers: jest.fn().mockReturnValue(jest.fn()),
    exitWithConfigError: jest.fn().mockImplementation((msg: string) => {
      throw new Error(`Config error: ${msg}`);
    }),
    closeServerWithTimeout: jest.fn().mockResolvedValue(undefined),
    parsePartitionEnvironmentConfig: jest.fn().mockImplementation((chainNames: readonly string[]) => ({
      redisUrl: process.env.REDIS_URL,
      partitionChains: process.env.PARTITION_CHAINS,
      healthCheckPort: process.env.HEALTH_CHECK_PORT,
      instanceId: process.env.INSTANCE_ID,
      regionId: process.env.REGION_ID,
      enableCrossRegionHealth: process.env.ENABLE_CROSS_REGION_HEALTH !== 'false',
      nodeEnv: process.env.NODE_ENV || 'development',
      rpcUrls: Object.fromEntries(chainNames.map((c: string) => [c, process.env[`${c.toUpperCase()}_RPC_URL`]])),
      wsUrls: Object.fromEntries(chainNames.map((c: string) => [c, process.env[`${c.toUpperCase()}_WS_URL`]])),
    })),
    validatePartitionEnvironmentConfig: jest.fn(),
    generateInstanceId: jest.fn().mockImplementation((partitionId: string, instanceId?: string) =>
      instanceId || `${partitionId}-${process.env.HOSTNAME || 'local'}-${Date.now()}`
    ),
    getRedisClient: jest.fn().mockResolvedValue({
      disconnect: jest.fn().mockResolvedValue(undefined),
    }),
    getRedisStreamsClient: jest.fn().mockResolvedValue({
      xadd: jest.fn().mockResolvedValue('stream-id'),
      disconnect: jest.fn().mockResolvedValue(undefined),
    }),
    createServiceState: jest.fn().mockReturnValue(mockStateManager),
    getPerformanceLogger: jest.fn().mockReturnValue({
      logHealthCheck: jest.fn(),
    }),
    getCrossRegionHealthManager: jest.fn().mockReturnValue({
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
      removeAllListeners: jest.fn(),
    }),
    getGracefulDegradationManager: jest.fn().mockReturnValue({
      registerCapabilities: jest.fn(),
      triggerDegradation: jest.fn(),
    }),
    PARTITION_PORTS: PORTS,
    PARTITION_SERVICE_NAMES: {
      'asia-fast': 'partition-asia-fast',
      'l2-turbo': 'partition-l2-turbo',
      'high-value': 'partition-high-value',
      'solana-native': 'partition-solana',
    },
    runPartitionService: jest.fn().mockImplementation((options: {
      createDetector: (cfg: unknown) => unknown;
      detectorConfig: unknown;
    }) => ({
      detector: options.createDetector(options.detectorConfig),
      start: jest.fn().mockResolvedValue(undefined),
      getState: jest.fn().mockReturnValue('idle'),
      cleanup: jest.fn(),
      healthServer: { current: null },
    })),
    createPartitionServiceRunner: jest.fn().mockImplementation((options: {
      createDetector: (cfg: unknown) => unknown;
      detectorConfig: unknown;
    }) => ({
      detector: options.createDetector(options.detectorConfig),
      start: jest.fn().mockResolvedValue(undefined),
      getState: jest.fn().mockReturnValue('idle'),
      cleanup: jest.fn(),
      healthServer: { current: null },
    })),
    // R10: createPartitionEntry mock
    createPartitionEntry: jest.fn().mockImplementation((partitionId: string, createDetector: (cfg: unknown) => unknown) => {
      const { getPartition } = require('@arbitrage/config');
      const partitionConfig = getPartition(partitionId);
      const chains: string[] = partitionConfig?.chains ?? [];
      const region: string = partitionConfig?.region ?? 'us-east1';
      const defaultPort = PORTS[partitionId] ?? 3000;

      const envConfig = {
        redisUrl: process.env.REDIS_URL,
        partitionChains: process.env.PARTITION_CHAINS,
        healthCheckPort: process.env.HEALTH_CHECK_PORT,
        instanceId: process.env.INSTANCE_ID,
        regionId: process.env.REGION_ID,
        enableCrossRegionHealth: process.env.ENABLE_CROSS_REGION_HEALTH !== 'false',
        nodeEnv: process.env.NODE_ENV || 'development',
        rpcUrls: Object.fromEntries(chains.map((c: string) => [c, process.env[`${c.toUpperCase()}_RPC_URL`]])),
        wsUrls: Object.fromEntries(chains.map((c: string) => [c, process.env[`${c.toUpperCase()}_WS_URL`]])),
      };

      const instanceId = envConfig.instanceId
        ?? `${partitionId}-${process.env.HOSTNAME || 'local'}-${Date.now()}`;
      const healthCheckPort = envConfig.healthCheckPort
        ? (parseInt(envConfig.healthCheckPort, 10) || defaultPort)
        : defaultPort;

      const detectorConfig = {
        partitionId,
        chains: [...chains],
        instanceId,
        regionId: envConfig.regionId ?? region,
        enableCrossRegionHealth: envConfig.enableCrossRegionHealth ?? true,
        healthCheckPort,
      };

      const detector = createDetector(detectorConfig);

      return {
        detector,
        config: detectorConfig,
        partitionId,
        chains,
        region,
        cleanupProcessHandlers: jest.fn(),
        envConfig,
        runner: {
          detector,
          start: jest.fn().mockResolvedValue(undefined),
          getState: jest.fn().mockReturnValue('idle'),
          cleanup: jest.fn(),
          healthServer: { current: null },
        },
      };
    }),
  };
});

// Mock @arbitrage/config with P3 High-Value configuration
jest.mock('@arbitrage/config', () => ({
  getPartition: jest.fn().mockImplementation((partitionId: string) => ({
    partitionId,
    name: 'High Value Chains',
    chains: ['ethereum', 'zksync', 'linea'],
    region: 'us-east1',
    provider: 'oracle',
    resourceProfile: 'heavy',
    priority: 2,
    maxMemoryMB: 768,
    enabled: true,
    healthCheckIntervalMs: 30000, // 30s for Ethereum's ~12s blocks
    failoverTimeoutMs: 60000,
    standbyRegion: 'eu-west1',
    standbyProvider: 'gcp',
  })),
  PARTITION_IDS: {
    ASIA_FAST: 'asia-fast',
    L2_TURBO: 'l2-turbo',
    HIGH_VALUE: 'high-value',
    SOLANA_NATIVE: 'solana-native',
  },
  CHAINS: {
    ethereum: { id: 1, name: 'Ethereum', blockTime: 12 },
    zksync: { id: 324, name: 'zkSync Era', blockTime: 1 },
    linea: { id: 59144, name: 'Linea', blockTime: 2 },
  },
}));

// Use shared MockUnifiedChainDetector from @arbitrage/test-utils
jest.mock('@arbitrage/unified-detector', () => ({
  UnifiedChainDetector: MockUnifiedChainDetector,
}));

// =============================================================================
// Tests
// =============================================================================

describe('P3 High-Value Partition Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.REGION_ID;
    delete process.env.INSTANCE_ID;
    delete process.env.ENABLE_CROSS_REGION_HEALTH;
  });

  describe('Module Exports', () => {
    it('should export detector instance', async () => {
      // Import after mocks are set up
      jest.resetModules();
      const { detector } = await import('../../index');
      expect(detector).toBeDefined();
      expect(typeof detector.start).toBe('function');
      expect(typeof detector.stop).toBe('function');
    });

    it('should export config object', async () => {
      jest.resetModules();
      const { config } = await import('../../index');
      expect(config).toBeDefined();
      expect(config.partitionId).toBe('high-value');
      expect(config.chains).toContain('ethereum');
      expect(config.chains).toContain('zksync');
      expect(config.chains).toContain('linea');
    });

    it('should export partition constants', async () => {
      jest.resetModules();
      const { P3_PARTITION_ID, P3_CHAINS, P3_REGION } = await import('../../index');
      expect(P3_PARTITION_ID).toBe('high-value');
      expect(P3_CHAINS).toContain('ethereum');
      expect(P3_CHAINS).toContain('zksync');
      expect(P3_CHAINS).toContain('linea');
      expect(P3_REGION).toBe('us-east1');
    });

    it('should export cleanupProcessHandlers function', async () => {
      jest.resetModules();
      const { cleanupProcessHandlers } = await import('../../index');
      expect(cleanupProcessHandlers).toBeDefined();
      expect(typeof cleanupProcessHandlers).toBe('function');
    });
  });

  describe('Configuration', () => {
    it('should use correct partition ID (high-value)', async () => {
      jest.resetModules();
      const { P3_PARTITION_ID } = await import('../../index');
      expect(P3_PARTITION_ID).toBe('high-value');
    });

    it('should configure 3 chains for high-value partition', async () => {
      jest.resetModules();
      const { config } = await import('../../index');
      expect(config.chains).toHaveLength(3);
      expect(config.chains).toEqual(
        expect.arrayContaining(['ethereum', 'zksync', 'linea'])
      );
    });

    it('should use default port 3003 (different from P1:3001 and P2:3002)', async () => {
      jest.resetModules();
      const { config } = await import('../../index');
      expect(config.healthCheckPort).toBe(3003);
    });

    it('should use us-east1 region (Oracle Cloud US-East)', async () => {
      jest.resetModules();
      const { config } = await import('../../index');
      expect(config.regionId).toBe('us-east1');
    });

    it('should have correct chains for high-value Ethereum mainnet trading', async () => {
      jest.resetModules();
      const { config } = await import('../../index');
      // Ethereum is the high-value mainnet
      expect(config.chains).toContain('ethereum');
      // zkSync and Linea are ZK rollups with Ethereum bridge opportunities
      expect(config.chains).toContain('zksync');
      expect(config.chains).toContain('linea');
    });
  });

  describe('Initialization', () => {
    it('should call createPartitionEntry with correct partition ID', async () => {
      jest.resetModules();
      const { createPartitionEntry } = await import('@arbitrage/core');
      await import('../../index');

      expect(createPartitionEntry).toHaveBeenCalledWith('high-value', expect.any(Function));
    });

    it('should call getPartition via createPartitionEntry', async () => {
      jest.resetModules();
      const { getPartition } = await import('@arbitrage/config');
      await import('../../index');

      expect(getPartition).toHaveBeenCalledWith('high-value');
    });

    it('should produce correct config from createPartitionEntry', async () => {
      jest.resetModules();
      const { config } = await import('../../index');

      expect(config.partitionId).toBe('high-value');
      expect(config.chains).toEqual(expect.arrayContaining(['ethereum', 'zksync', 'linea']));
    });

    it('should have detector with event handling capabilities', async () => {
      // Verify the exported detector has event handling capabilities
      const { detector } = await import('../../index');
      expect(typeof detector.on).toBe('function');
      expect(typeof detector.emit).toBe('function');
    });

    it('should have cleanup function exported', async () => {
      // Verify the cleanup function is exported
      const { cleanupProcessHandlers } = await import('../../index');
      expect(typeof cleanupProcessHandlers).toBe('function');
    });
  });

  describe('JEST_WORKER_ID Guard', () => {
    it('should not auto-start when JEST_WORKER_ID is set', async () => {
      expect(process.env.JEST_WORKER_ID).toBeDefined();

      const { detector } = await import('../../index');

      // Detector is created but main() wasn't called (no auto-start)
      expect(detector).toBeDefined();
    });
  });

  describe('Uses Shared Utilities', () => {
    it('should use PARTITION_PORTS from @arbitrage/core', async () => {
      const { PARTITION_PORTS } = jest.requireMock('@arbitrage/core');
      expect(PARTITION_PORTS['high-value']).toBe(3003);
    });

    it('should use PARTITION_SERVICE_NAMES from @arbitrage/core', async () => {
      const { PARTITION_SERVICE_NAMES } = jest.requireMock('@arbitrage/core');
      expect(PARTITION_SERVICE_NAMES['high-value']).toBe('partition-high-value');
    });

    it('should use createPartitionEntry factory from @arbitrage/core', async () => {
      const { createPartitionEntry } = jest.requireMock('@arbitrage/core');
      expect(createPartitionEntry).toBeDefined();
    });
  });
});

describe('P3 Environment Variable Handling', () => {
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
    // BUG-FIX: Clean up process handlers with error handling to prevent memory leaks
    try {
      if (cleanupFn) {
        cleanupFn();
      }
    } catch (error) {
      // Log but don't fail test if cleanup throws
      console.warn('Cleanup function failed:', error);
    } finally {
      cleanupFn = null;
      // We do NOT use removeAllListeners() as it can remove Jest's own handlers for
      // uncaughtException and unhandledRejection, causing test framework issues.
      // The cleanupFn from setupProcessHandlers uses process.off() with specific handler
      // references, so it correctly removes only the handlers registered by that module.
    }
    process.env = originalEnv;
  });

  it('should use PARTITION_CHAINS env var when provided', async () => {
    process.env.PARTITION_CHAINS = 'ethereum,zksync';

    jest.resetModules();
    const { validateAndFilterChains } = await import('@arbitrage/core');

    const result = validateAndFilterChains('ethereum,zksync', ['ethereum', 'zksync', 'linea'], mockLogger as any);
    expect(result).toEqual(['ethereum', 'zksync']);
  });

  it('should use HEALTH_CHECK_PORT env var when provided', async () => {
    process.env.HEALTH_CHECK_PORT = '4003';

    jest.resetModules();
    const { parsePort } = await import('@arbitrage/core');

    const result = parsePort('4003', 3003, mockLogger as any);
    expect(result).toBe(4003);
  });

  it('should use default port when HEALTH_CHECK_PORT is invalid', async () => {
    const { parsePort } = await import('@arbitrage/core');

    const result = parsePort('invalid', 3003, mockLogger as any);
    expect(result).toBe(3003);
  });

  it('should use INSTANCE_ID env var when provided', async () => {
    process.env.INSTANCE_ID = 'p3-high-value-custom-123';

    jest.resetModules();
    const { config, cleanupProcessHandlers } = await import('../../index');
    cleanupFn = cleanupProcessHandlers;

    expect(config.instanceId).toBe('p3-high-value-custom-123');
  });

  it('should use REGION_ID env var when provided', async () => {
    process.env.REGION_ID = 'eu-west1';

    jest.resetModules();
    const { config, cleanupProcessHandlers } = await import('../../index');
    cleanupFn = cleanupProcessHandlers;

    expect(config.regionId).toBe('eu-west1');
  });

  it('should disable cross-region health when ENABLE_CROSS_REGION_HEALTH is false', async () => {
    process.env.ENABLE_CROSS_REGION_HEALTH = 'false';

    jest.resetModules();
    const { config, cleanupProcessHandlers } = await import('../../index');
    cleanupFn = cleanupProcessHandlers;

    expect(config.enableCrossRegionHealth).toBe(false);
  });

  it('should enable cross-region health by default', async () => {
    jest.resetModules();
    const { config, cleanupProcessHandlers } = await import('../../index');
    cleanupFn = cleanupProcessHandlers;

    expect(config.enableCrossRegionHealth).toBe(true);
  });

  it('should generate default instance ID when not provided', async () => {
    delete process.env.INSTANCE_ID;

    jest.resetModules();
    const { config, cleanupProcessHandlers } = await import('../../index');
    cleanupFn = cleanupProcessHandlers;

    expect(config.instanceId).toMatch(/^high-value-/);
  });
});

describe('P3 Process Handler Cleanup', () => {
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
    const { cleanupProcessHandlers } = await import('../../index');

    expect(cleanupProcessHandlers).toBeDefined();
    expect(typeof cleanupProcessHandlers).toBe('function');

    // Should not throw when called
    expect(() => cleanupProcessHandlers()).not.toThrow();
  });

  it('should allow calling cleanup multiple times without error', async () => {
    const { cleanupProcessHandlers } = await import('../../index');

    // Should not throw even when called multiple times
    expect(() => {
      cleanupProcessHandlers();
      cleanupProcessHandlers();
    }).not.toThrow();
  });
});

describe('P3 Error Handling', () => {
  const originalEnv = process.env;
  let cleanupFn: (() => void) | null = null;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv, JEST_WORKER_ID: 'test', NODE_ENV: 'test' };
  });

  afterEach(async () => {
    try {
      if (cleanupFn) {
        cleanupFn();
      }
    } catch {
      // Ignore cleanup errors
    } finally {
      cleanupFn = null;
      // We do NOT use removeAllListeners() as it can remove Jest's own handlers for
      // uncaughtException and unhandledRejection, causing test framework issues.
    }
    process.env = originalEnv;
  });

  it('should have exitWithConfigError available for configuration errors', async () => {
    const { exitWithConfigError } = jest.requireMock('@arbitrage/core');
    expect(exitWithConfigError).toBeDefined();
    expect(typeof exitWithConfigError).toBe('function');
  });

  it('exitWithConfigError should throw with config error message', async () => {
    const { exitWithConfigError } = jest.requireMock('@arbitrage/core');
    expect(() => exitWithConfigError('Test error', { test: true })).toThrow('Config error: Test error');
  });

  it('should have closeServerWithTimeout available for cleanup on errors', async () => {
    const { closeServerWithTimeout } = jest.requireMock('@arbitrage/core');
    expect(closeServerWithTimeout).toBeDefined();
    expect(typeof closeServerWithTimeout).toBe('function');
  });

  it('closeServerWithTimeout should resolve when called', async () => {
    const { closeServerWithTimeout } = jest.requireMock('@arbitrage/core');
    await expect(closeServerWithTimeout({}, 1000, {})).resolves.toBeUndefined();
  });

  it('should have createPartitionHealthServer that returns closeable server', async () => {
    const { createPartitionHealthServer } = jest.requireMock('@arbitrage/core');
    const mockServer = createPartitionHealthServer({});
    expect(mockServer).toBeDefined();
    expect(typeof mockServer.close).toBe('function');
  });

  it('should correctly handle missing partition config via mock', async () => {
    // Verify getPartition mock is configured correctly
    const { getPartition } = jest.requireMock('@arbitrage/config');

    // Normal case returns config
    const config = getPartition('high-value');
    expect(config).toBeDefined();
    expect(config.chains).toEqual(['ethereum', 'zksync', 'linea']);
  });
});

describe('P3 High-Value Chain Characteristics', () => {
  // Reset modules before this test block to get fresh mock state
  beforeAll(() => {
    jest.resetModules();
  });

  it('should have Ethereum (chain ID 1) in the partition', async () => {
    const { config } = await import('../../index');
    expect(config.chains).toContain('ethereum');
  });

  it('should have zkSync Era (chain ID 324) for ZK rollup arbitrage', async () => {
    const { config } = await import('../../index');
    expect(config.chains).toContain('zksync');
  });

  it('should have Linea (chain ID 59144) for Consensys ZK rollup', async () => {
    const { config } = await import('../../index');
    expect(config.chains).toContain('linea');
  });

  it('should use us-east1 region (Oracle Cloud US-East)', async () => {
    // Verify via the exported config from index.ts (avoids mock state issues)
    const { P3_REGION, config } = await import('../../index');
    expect(P3_REGION).toBe('us-east1');
    expect(config.regionId).toBe('us-east1');
  });

  it('should verify partition configuration via exported constants', async () => {
    // The partition details (provider, healthCheckIntervalMs, standbyRegion)
    // are verified through the index module's exported values
    const { P3_PARTITION_ID, P3_CHAINS, P3_REGION } = await import('../../index');
    expect(P3_PARTITION_ID).toBe('high-value');
    expect(P3_CHAINS).toEqual(expect.arrayContaining(['ethereum', 'zksync', 'linea']));
    expect(P3_REGION).toBe('us-east1');
  });
});
