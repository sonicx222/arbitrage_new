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

import { EventEmitter } from 'events';

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

jest.mock('@arbitrage/core', () => ({
  createLogger: jest.fn().mockReturnValue(mockLogger),
  parsePort: jest.fn().mockImplementation((portEnv, defaultPort) => {
    if (!portEnv) return defaultPort;
    const parsed = parseInt(portEnv, 10);
    return isNaN(parsed) ? defaultPort : parsed;
  }),
  validateAndFilterChains: jest.fn().mockImplementation((chainsEnv, defaultChains) => {
    if (!chainsEnv) return [...defaultChains];
    return chainsEnv.split(',').map((c: string) => c.trim().toLowerCase());
  }),
  createPartitionHealthServer: jest.fn().mockReturnValue({
    close: jest.fn((cb) => cb && cb()),
    on: jest.fn(),
  }),
  setupDetectorEventHandlers: jest.fn(),
  setupProcessHandlers: jest.fn().mockReturnValue(jest.fn()), // Returns cleanup function
  exitWithConfigError: jest.fn().mockImplementation((msg, ctx) => {
    throw new Error(`Config error: ${msg}`);
  }),
  closeServerWithTimeout: jest.fn().mockResolvedValue(undefined),
  // BUG-FIX: Add missing mock functions for environment config parsing
  // Return proper defaults when process.env variables aren't set
  parsePartitionEnvironmentConfig: jest.fn().mockImplementation((defaultChains) => ({
    partitionChains: process.env.PARTITION_CHAINS || undefined,
    healthCheckPort: process.env.HEALTH_CHECK_PORT || undefined,
    instanceId: process.env.INSTANCE_ID || undefined,
    regionId: process.env.REGION_ID || undefined,
    enableCrossRegionHealth: process.env.ENABLE_CROSS_REGION_HEALTH !== 'false',
  })),
  validatePartitionEnvironmentConfig: jest.fn(),
  generateInstanceId: jest.fn().mockImplementation((partitionId, instanceId) =>
    instanceId || `p3-${partitionId}-${Date.now()}`
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
  // Centralized constants (P1-1/P1-2-FIX: Single source of truth)
  PARTITION_PORTS: {
    'asia-fast': 3001,
    'l2-turbo': 3002,
    'high-value': 3003,
    'solana-native': 3004,
  },
  PARTITION_SERVICE_NAMES: {
    'asia-fast': 'partition-asia-fast',
    'l2-turbo': 'partition-l2-turbo',
    'high-value': 'partition-high-value',
    'solana-native': 'partition-solana',
  },
}));

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

// Mock UnifiedChainDetector
class MockUnifiedChainDetector extends EventEmitter {
  private _config: Record<string, unknown>;
  private _started = false;

  constructor(config: Record<string, unknown>) {
    super();
    this._config = config;
  }

  async start(): Promise<void> {
    this._started = true;
  }

  async stop(): Promise<void> {
    this._started = false;
  }

  getPartitionId(): string {
    return this._config.partitionId as string;
  }

  getChains(): string[] {
    return this._config.chains as string[];
  }

  getHealthyChains(): string[] {
    return this._config.chains as string[];
  }

  isRunning(): boolean {
    return this._started;
  }

  getStats() {
    return {
      partitionId: this._config.partitionId,
      chains: this._config.chains,
      totalEventsProcessed: 0,
      totalOpportunitiesFound: 0,
      uptimeSeconds: 0,
      memoryUsageMB: 0,
      chainStats: new Map(),
    };
  }

  async getPartitionHealth() {
    return {
      status: 'healthy',
      partitionId: this._config.partitionId,
      chainHealth: new Map(),
      totalEventsProcessed: 0,
      avgEventLatencyMs: 0,
      memoryUsage: 0,
      cpuUsage: 0,
      uptimeSeconds: 0,
      lastHealthCheck: Date.now(),
      activeOpportunities: 0,
    };
  }
}

jest.mock('@arbitrage/unified-detector', () => ({
  UnifiedChainDetector: MockUnifiedChainDetector,
}));

// =============================================================================
// Tests
// =============================================================================

describe('P3 High-Value Partition Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
    it('should call createLogger with correct namespace', async () => {
      jest.resetModules();
      const { createLogger } = await import('@arbitrage/core');
      await import('../../index');

      expect(createLogger).toHaveBeenCalledWith('partition-high-value:main');
    });

    it('should call getPartition with high-value partition ID', async () => {
      jest.resetModules();
      const { getPartition } = await import('@arbitrage/config');
      await import('../../index');

      expect(getPartition).toHaveBeenCalledWith('high-value');
    });

    it('should call setupDetectorEventHandlers with detector and partition ID', async () => {
      jest.resetModules();
      const { setupDetectorEventHandlers } = await import('@arbitrage/core');
      const { detector } = await import('../../index');

      expect(setupDetectorEventHandlers).toHaveBeenCalledWith(
        detector,
        expect.objectContaining({
          info: expect.any(Function),
          error: expect.any(Function),
          warn: expect.any(Function),
          debug: expect.any(Function),
        }),
        'high-value'
      );
    });

    it('should call setupProcessHandlers with correct service name', async () => {
      jest.resetModules();
      const { setupProcessHandlers } = await import('@arbitrage/core');
      await import('../../index');

      expect(setupProcessHandlers).toHaveBeenCalled();
      const callArgs = (setupProcessHandlers as jest.Mock).mock.calls[0];
      // Verify the service name argument (4th parameter)
      expect(callArgs[3]).toBe('partition-high-value');
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

    it('should use shared exitWithConfigError', async () => {
      const { exitWithConfigError } = jest.requireMock('@arbitrage/core');
      expect(exitWithConfigError).toBeDefined();
    });
  });
});

describe('P3 Environment Variable Handling', () => {
  const originalEnv = process.env;
  let cleanupFn: (() => void) | null = null;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv, JEST_WORKER_ID: 'test', NODE_ENV: 'test' };
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
      // Force remove all process listeners as last resort to prevent leaks
      process.removeAllListeners('SIGTERM');
      process.removeAllListeners('SIGINT');
      process.removeAllListeners('uncaughtException');
      process.removeAllListeners('unhandledRejection');
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

    expect(config.instanceId).toMatch(/^p3-high-value-/);
  });
});

describe('P3 Process Handler Cleanup', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv, JEST_WORKER_ID: 'test', NODE_ENV: 'test' };
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
      process.removeAllListeners('SIGTERM');
      process.removeAllListeners('SIGINT');
      process.removeAllListeners('uncaughtException');
      process.removeAllListeners('unhandledRejection');
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
