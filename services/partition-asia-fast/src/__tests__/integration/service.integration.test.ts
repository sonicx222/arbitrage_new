/**
 * Integration Tests for P1 Asia-Fast Partition Service
 *
 * Tests service configuration, environment variable handling, and module behavior.
 * Note: Health server tests are simplified since Jest module caching makes it
 * difficult to test actual HTTP server creation across test cases.
 */

import { EventEmitter } from 'events';

// =============================================================================
// Mocks - Must be defined before imports
// =============================================================================

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
  isRunning: jest.fn().mockReturnValue(true),
  getState: jest.fn().mockReturnValue('running'),
};

const mockHealthServer = {
  close: jest.fn((cb) => cb && cb()),
  on: jest.fn(),
  listen: jest.fn(),
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
  createPartitionHealthServer: jest.fn().mockReturnValue(mockHealthServer),
  setupDetectorEventHandlers: jest.fn(),
  setupProcessHandlers: jest.fn().mockReturnValue(jest.fn()),
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
  // P0-FIX: Add PARTITION_PORTS and PARTITION_SERVICE_NAMES to mock
  // These are required by index.ts for P1_DEFAULT_PORT calculation
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
  exitWithConfigError: jest.fn(),
  PartitionServiceConfig: {},
}));

jest.mock('@arbitrage/config', () => ({
  getPartition: jest.fn().mockImplementation((partitionId: string) => ({
    partitionId,
    name: 'Asia Fast Chains',
    chains: ['bsc', 'polygon', 'avalanche', 'fantom'],
    region: 'asia-southeast1',
    provider: 'oracle',
    resourceProfile: 'heavy',
    priority: 1,
    maxMemoryMB: 768,
    enabled: true,
    healthCheckIntervalMs: 15000,
    failoverTimeoutMs: 60000,
  })),
  PARTITION_IDS: {
    ASIA_FAST: 'asia-fast',
    L2_TURBO: 'l2-turbo',
    HIGH_VALUE: 'high-value',
    SOLANA_NATIVE: 'solana-native',
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
    return this._started ? (this._config.chains as string[]) : [];
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
      status: this._started ? 'healthy' : 'starting',
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

describe('P1 Asia-Fast Partition Service Integration', () => {
  const originalEnv = process.env;
  let cleanupFn: (() => void) | null = null;

  beforeEach(() => {
    jest.clearAllMocks();
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

  describe('Health Server Configuration', () => {
    // Note: createPartitionHealthServer is called inside main(), which doesn't run
    // during test imports (JEST_WORKER_ID guard). These tests verify the config
    // that would be passed to createPartitionHealthServer.

    it('should configure default health check port of 3001', async () => {
      jest.resetModules();
      const { config, cleanupProcessHandlers } = await import('../../index');
      cleanupFn = cleanupProcessHandlers;

      expect(config.healthCheckPort).toBe(3001);
    });

    it('should use custom port from HEALTH_CHECK_PORT environment variable', async () => {
      process.env.HEALTH_CHECK_PORT = '4001';

      jest.resetModules();
      const { config, cleanupProcessHandlers } = await import('../../index');
      cleanupFn = cleanupProcessHandlers;

      expect(config.healthCheckPort).toBe(4001);
    });

    it('should use default port when HEALTH_CHECK_PORT is invalid', async () => {
      process.env.HEALTH_CHECK_PORT = 'invalid';

      jest.resetModules();
      const { config, cleanupProcessHandlers } = await import('../../index');
      cleanupFn = cleanupProcessHandlers;

      // parsePort mock returns defaultPort for invalid input
      expect(config.healthCheckPort).toBe(3001);
    });
  });

  describe('Detector Configuration', () => {
    it('should create detector with correct partition ID', async () => {
      jest.resetModules();
      const { detector, cleanupProcessHandlers } = await import('../../index');
      cleanupFn = cleanupProcessHandlers;

      expect(detector.getPartitionId()).toBe('asia-fast');
    });

    it('should configure detector with all 4 chains by default', async () => {
      jest.resetModules();
      const { detector, cleanupProcessHandlers } = await import('../../index');
      cleanupFn = cleanupProcessHandlers;

      expect(detector.getChains()).toEqual(['bsc', 'polygon', 'avalanche', 'fantom']);
    });

    it('should use custom chains from PARTITION_CHAINS environment variable', async () => {
      process.env.PARTITION_CHAINS = 'bsc,polygon';

      jest.resetModules();
      const { config, cleanupProcessHandlers } = await import('../../index');
      cleanupFn = cleanupProcessHandlers;

      expect(config.chains).toEqual(['bsc', 'polygon']);
    });
  });

  describe('Service Configuration', () => {
    it('should use custom INSTANCE_ID from environment', async () => {
      process.env.INSTANCE_ID = 'custom-instance-123';

      jest.resetModules();
      const { config, cleanupProcessHandlers } = await import('../../index');
      cleanupFn = cleanupProcessHandlers;

      expect(config.instanceId).toBe('custom-instance-123');
    });

    it('should use custom REGION_ID from environment', async () => {
      process.env.REGION_ID = 'us-west1';

      jest.resetModules();
      const { config, cleanupProcessHandlers } = await import('../../index');
      cleanupFn = cleanupProcessHandlers;

      expect(config.regionId).toBe('us-west1');
    });

    it('should disable cross-region health when ENABLE_CROSS_REGION_HEALTH=false', async () => {
      process.env.ENABLE_CROSS_REGION_HEALTH = 'false';

      jest.resetModules();
      const { config, cleanupProcessHandlers } = await import('../../index');
      cleanupFn = cleanupProcessHandlers;

      expect(config.enableCrossRegionHealth).toBe(false);
    });

    it('should enable cross-region health by default', async () => {
      delete process.env.ENABLE_CROSS_REGION_HEALTH;

      jest.resetModules();
      const { config, cleanupProcessHandlers } = await import('../../index');
      cleanupFn = cleanupProcessHandlers;

      expect(config.enableCrossRegionHealth).toBe(true);
    });
  });

  describe('Event Handler Setup', () => {
    it('should call setupDetectorEventHandlers with correct parameters', async () => {
      jest.resetModules();
      const { setupDetectorEventHandlers } = await import('@arbitrage/core');
      const { detector, cleanupProcessHandlers } = await import('../../index');
      cleanupFn = cleanupProcessHandlers;

      expect(setupDetectorEventHandlers).toHaveBeenCalledWith(
        detector,
        expect.anything(), // logger
        'asia-fast'
      );
    });
  });

  describe('Process Handler Setup', () => {
    it('should call setupProcessHandlers with correct parameters', async () => {
      jest.resetModules();
      const { setupProcessHandlers } = await import('@arbitrage/core');
      await import('../../index');

      expect(setupProcessHandlers).toHaveBeenCalled();
      const callArgs = (setupProcessHandlers as jest.Mock).mock.calls[0];
      expect(callArgs[3]).toBe('partition-asia-fast'); // serviceName
    });

    it('should export cleanup function that can be called multiple times', async () => {
      jest.resetModules();
      const { cleanupProcessHandlers } = await import('../../index');

      expect(typeof cleanupProcessHandlers).toBe('function');
      expect(() => {
        cleanupProcessHandlers();
        cleanupProcessHandlers();
      }).not.toThrow();
    });
  });

  describe('Module Exports', () => {
    it('should export all required members', async () => {
      jest.resetModules();
      const exports = await import('../../index');

      expect(exports.detector).toBeDefined();
      expect(exports.config).toBeDefined();
      expect(exports.P1_PARTITION_ID).toBe('asia-fast');
      expect(exports.P1_CHAINS).toContain('bsc');
      expect(exports.P1_REGION).toBe('asia-southeast1');
      expect(exports.cleanupProcessHandlers).toBeDefined();
    });
  });
});
