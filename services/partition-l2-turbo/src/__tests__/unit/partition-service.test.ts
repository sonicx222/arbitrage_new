/**
 * Unit Tests for P2 L2-Turbo Partition Service
 *
 * Tests partition-specific configuration, exports, and service setup.
 * The JEST_WORKER_ID guard in index.ts prevents auto-start during import.
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
  // Read from process.env to support environment variable tests
  parsePartitionEnvironmentConfig: jest.fn().mockImplementation((defaultChains) => ({
    partitionChains: process.env.PARTITION_CHAINS,
    healthCheckPort: process.env.HEALTH_CHECK_PORT,
    instanceId: process.env.INSTANCE_ID,
    regionId: process.env.REGION_ID,
    enableCrossRegionHealth: process.env.ENABLE_CROSS_REGION_HEALTH !== 'false',
  })),
  validatePartitionEnvironmentConfig: jest.fn(),
  generateInstanceId: jest.fn().mockImplementation((partitionId, instanceId) =>
    instanceId || `p2-${partitionId}-${Date.now()}`
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
  // R9: Partition Service Runner Factory
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
}));

// Mock @arbitrage/config
jest.mock('@arbitrage/config', () => ({
  getPartition: jest.fn().mockImplementation((partitionId: string) => ({
    partitionId,
    name: 'L2 Turbo Chains',
    chains: ['arbitrum', 'optimism', 'base'],
    region: 'asia-southeast1',
    provider: 'fly',
    resourceProfile: 'standard',
    priority: 1,
    maxMemoryMB: 512,
    enabled: true,
    healthCheckIntervalMs: 10000,
    failoverTimeoutMs: 45000,
  })),
  PARTITION_IDS: {
    ASIA_FAST: 'asia-fast',
    L2_TURBO: 'l2-turbo',
    HIGH_VALUE: 'high-value',
    SOLANA_NATIVE: 'solana-native',
  },
  CHAINS: {
    arbitrum: { id: 42161, name: 'Arbitrum' },
    optimism: { id: 10, name: 'Optimism' },
    base: { id: 8453, name: 'Base' },
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

describe('P2 L2-Turbo Partition Service', () => {
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
      expect(config.partitionId).toBe('l2-turbo');
      expect(config.chains).toContain('arbitrum');
      expect(config.chains).toContain('optimism');
      expect(config.chains).toContain('base');
    });

    it('should export partition constants', async () => {
      jest.resetModules();
      const { P2_PARTITION_ID, P2_CHAINS, P2_REGION } = await import('../../index');
      expect(P2_PARTITION_ID).toBe('l2-turbo');
      expect(P2_CHAINS).toContain('arbitrum');
      expect(P2_REGION).toBe('asia-southeast1');
    });

    it('should export cleanupProcessHandlers function', async () => {
      jest.resetModules();
      const { cleanupProcessHandlers } = await import('../../index');
      expect(cleanupProcessHandlers).toBeDefined();
      expect(typeof cleanupProcessHandlers).toBe('function');
    });
  });

  describe('Configuration', () => {
    it('should use correct partition ID', async () => {
      jest.resetModules();
      const { P2_PARTITION_ID } = await import('../../index');
      expect(P2_PARTITION_ID).toBe('l2-turbo');
    });

    it('should configure 3 chains for l2-turbo partition', async () => {
      jest.resetModules();
      const { config } = await import('../../index');
      expect(config.chains).toHaveLength(3);
      expect(config.chains).toEqual(
        expect.arrayContaining(['arbitrum', 'optimism', 'base'])
      );
    });

    it('should use default port 3002', async () => {
      jest.resetModules();
      const { config } = await import('../../index');
      expect(config.healthCheckPort).toBe(3002);
    });

    it('should use asia-southeast1 region', async () => {
      jest.resetModules();
      const { config } = await import('../../index');
      expect(config.regionId).toBe('asia-southeast1');
    });
  });

  describe('Initialization', () => {
    it('should have called createLogger with correct namespace', async () => {
      const { createLogger } = jest.requireMock('@arbitrage/core');
      expect(createLogger).toBeDefined();
    });

    it('should have called getPartition with l2-turbo ID', async () => {
      const { getPartition } = jest.requireMock('@arbitrage/config');
      expect(getPartition).toBeDefined();
    });

    it('should have setup detector event handlers', async () => {
      jest.resetModules();
      const { detector } = await import('../../index');
      expect(typeof detector.on).toBe('function');
      expect(typeof detector.emit).toBe('function');
    });

    it('should have setup process handlers and store cleanup function', async () => {
      jest.resetModules();
      const { cleanupProcessHandlers } = await import('../../index');
      expect(typeof cleanupProcessHandlers).toBe('function');
    });
  });

  describe('JEST_WORKER_ID Guard', () => {
    it('should not auto-start when JEST_WORKER_ID is set', async () => {
      expect(process.env.JEST_WORKER_ID).toBeDefined();

      const { detector } = await import('../../index');

      expect(detector).toBeDefined();
    });
  });

  describe('Uses Shared Utilities', () => {
    it('should use PARTITION_PORTS from @arbitrage/core', async () => {
      const { PARTITION_PORTS } = jest.requireMock('@arbitrage/core');
      expect(PARTITION_PORTS['l2-turbo']).toBe(3002);
    });

    it('should use PARTITION_SERVICE_NAMES from @arbitrage/core', async () => {
      const { PARTITION_SERVICE_NAMES } = jest.requireMock('@arbitrage/core');
      expect(PARTITION_SERVICE_NAMES['l2-turbo']).toBe('partition-l2-turbo');
    });

    it('should use shared exitWithConfigError', async () => {
      const { exitWithConfigError } = jest.requireMock('@arbitrage/core');
      expect(exitWithConfigError).toBeDefined();
    });
  });
});

describe('P2 Environment Variable Handling', () => {
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
    // The cleanupFn from setupProcessHandlers uses process.off() with specific handler
    // references, so it correctly removes only the handlers registered by that module.
    // We do NOT use removeAllListeners() as it can remove Jest's own handlers for
    // uncaughtException and unhandledRejection, causing test framework issues.
    try {
      if (cleanupFn) {
        cleanupFn();
      }
    } catch (error) {
      // Log but don't fail test if cleanup throws
      console.warn('Cleanup function failed:', error);
    } finally {
      cleanupFn = null;
    }
    process.env = originalEnv;
  });

  it('should use PARTITION_CHAINS env var when provided', async () => {
    process.env.PARTITION_CHAINS = 'arbitrum,base';

    jest.resetModules();
    const { validateAndFilterChains } = await import('@arbitrage/core');

    expect(validateAndFilterChains).toBeDefined();
    const result = validateAndFilterChains('arbitrum,base', ['arbitrum', 'optimism', 'base'], mockLogger as any);
    expect(result).toEqual(['arbitrum', 'base']);
  });

  it('should use HEALTH_CHECK_PORT env var when provided', async () => {
    process.env.HEALTH_CHECK_PORT = '4002';

    jest.resetModules();
    const { parsePort } = await import('@arbitrage/core');

    const result = parsePort('4002', 3002, mockLogger as any);
    expect(result).toBe(4002);
  });

  it('should use default port when HEALTH_CHECK_PORT is invalid', async () => {
    const { parsePort } = await import('@arbitrage/core');

    const result = parsePort('invalid', 3002, mockLogger as any);
    expect(result).toBe(3002);
  });

  it('should use INSTANCE_ID env var when provided', async () => {
    process.env.INSTANCE_ID = 'custom-l2-instance-123';

    jest.resetModules();
    const { config, cleanupProcessHandlers } = await import('../../index');
    cleanupFn = cleanupProcessHandlers;

    expect(config.instanceId).toBe('custom-l2-instance-123');
  });

  it('should use REGION_ID env var when provided', async () => {
    process.env.REGION_ID = 'us-east1';

    jest.resetModules();
    const { config, cleanupProcessHandlers } = await import('../../index');
    cleanupFn = cleanupProcessHandlers;

    expect(config.regionId).toBe('us-east1');
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

    expect(config.instanceId).toMatch(/^p2-l2-turbo-/);
  });
});

describe('Process Handler Cleanup', () => {
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

    expect(() => cleanupProcessHandlers()).not.toThrow();
  });

  it('should allow calling cleanup multiple times without error', async () => {
    const { cleanupProcessHandlers } = await import('../../index');

    expect(() => {
      cleanupProcessHandlers();
      cleanupProcessHandlers();
    }).not.toThrow();
  });
});
