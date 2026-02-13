/**
 * Integration Tests for P3 High-Value Partition Service
 *
 * Tests service configuration, environment variable handling, and module behavior.
 * Based on P1 integration test template, adapted for P3 High-Value partition data.
 *
 * P3 High-Value Partition:
 * - Chains: Ethereum, zkSync, Linea
 * - Region: Oracle Cloud US-East (us-east1)
 * - Port: 3003
 * - Health Check Interval: 30s (longer for Ethereum's ~12s blocks)
 */

import {
  MockUnifiedChainDetector,
  createCoreMocks,
  createMockLogger,
  createMockStateManager,
  createConfigMocks,
} from '@arbitrage/test-utils/mocks/partition-service.mock';
import type { CoreMocksOptions } from '@arbitrage/test-utils/mocks/partition-service.mock';

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

jest.mock('@arbitrage/core', () => {
  const mocks = createCoreMocks(mockLogger, mockStateManager, { includeValidation: true });
  // Override health server to use our local mock
  mocks.createPartitionHealthServer.mockReturnValue(mockHealthServer);
  return mocks;
});

jest.mock('@arbitrage/config', () => createConfigMocks({
  partitionId: 'high-value',
  name: 'High Value Chains',
  chains: ['ethereum', 'zksync', 'linea'],
  region: 'us-east1',
  provider: 'oracle',
  resourceProfile: 'heavy',
  priority: 2,
  maxMemoryMB: 768,
  healthCheckIntervalMs: 30000,
  failoverTimeoutMs: 60000,
  chainsSubset: ['ethereum', 'zksync', 'linea'],
  extra: {
    standbyRegion: 'eu-west1',
    standbyProvider: 'gcp',
  },
}));

jest.mock('@arbitrage/unified-detector', () => ({
  UnifiedChainDetector: MockUnifiedChainDetector,
}));

// =============================================================================
// Tests
// =============================================================================

describe('P3 High-Value Partition Service Integration', () => {
  const originalEnv = process.env;
  let cleanupFn: (() => void) | null = null;

  beforeEach(() => {
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
    it('should configure default health check port of 3003', async () => {
      jest.resetModules();
      const { config, cleanupProcessHandlers } = await import('../../index');
      cleanupFn = cleanupProcessHandlers;

      expect(config.healthCheckPort).toBe(3003);
    });

    it('should use custom port from HEALTH_CHECK_PORT environment variable', async () => {
      process.env.HEALTH_CHECK_PORT = '4003';

      jest.resetModules();
      const { config, cleanupProcessHandlers } = await import('../../index');
      cleanupFn = cleanupProcessHandlers;

      expect(config.healthCheckPort).toBe(4003);
    });

    it('should use default port when HEALTH_CHECK_PORT is invalid', async () => {
      process.env.HEALTH_CHECK_PORT = 'invalid';

      jest.resetModules();
      const { config, cleanupProcessHandlers } = await import('../../index');
      cleanupFn = cleanupProcessHandlers;

      expect(config.healthCheckPort).toBe(3003);
    });
  });

  describe('Detector Configuration', () => {
    it('should create detector with correct partition ID', async () => {
      jest.resetModules();
      const { detector, cleanupProcessHandlers } = await import('../../index');
      cleanupFn = cleanupProcessHandlers;

      expect(detector.getPartitionId()).toBe('high-value');
    });

    it('should configure detector with all 3 chains by default', async () => {
      jest.resetModules();
      const { detector, cleanupProcessHandlers } = await import('../../index');
      cleanupFn = cleanupProcessHandlers;

      expect(detector.getChains()).toEqual(['ethereum', 'zksync', 'linea']);
    });

    it('should use custom chains from PARTITION_CHAINS environment variable', async () => {
      process.env.PARTITION_CHAINS = 'ethereum,zksync';

      jest.resetModules();
      const { config, cleanupProcessHandlers } = await import('../../index');
      cleanupFn = cleanupProcessHandlers;

      expect(config.chains).toEqual(['ethereum', 'zksync']);
    });
  });

  describe('Service Configuration', () => {
    it('should use custom INSTANCE_ID from environment', async () => {
      process.env.INSTANCE_ID = 'p3-high-value-custom-123';

      jest.resetModules();
      const { config, cleanupProcessHandlers } = await import('../../index');
      cleanupFn = cleanupProcessHandlers;

      expect(config.instanceId).toBe('p3-high-value-custom-123');
    });

    it('should use custom REGION_ID from environment', async () => {
      process.env.REGION_ID = 'eu-west1';

      jest.resetModules();
      const { config, cleanupProcessHandlers } = await import('../../index');
      cleanupFn = cleanupProcessHandlers;

      expect(config.regionId).toBe('eu-west1');
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

  describe('Service Runner Factory', () => {
    it('should call createPartitionEntry with correct partition ID', async () => {
      jest.resetModules();
      const { createPartitionEntry } = await import('@arbitrage/core');
      const { cleanupProcessHandlers } = await import('../../index');
      cleanupFn = cleanupProcessHandlers;

      expect(createPartitionEntry).toHaveBeenCalledWith(
        'high-value',
        expect.any(Function)
      );
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
      expect(exports.P3_PARTITION_ID).toBe('high-value');
      expect(exports.P3_CHAINS).toContain('ethereum');
      expect(exports.P3_CHAINS).toContain('zksync');
      expect(exports.P3_CHAINS).toContain('linea');
      expect(exports.P3_REGION).toBe('us-east1');
      expect(exports.cleanupProcessHandlers).toBeDefined();
    });

    it('should export envConfig with typed configuration', async () => {
      jest.resetModules();
      const exports = await import('../../index');

      expect(exports.envConfig).toBeDefined();
      expect(typeof exports.envConfig.enableCrossRegionHealth).toBe('boolean');
      expect(typeof exports.envConfig.nodeEnv).toBe('string');
      expect(exports.envConfig.rpcUrls).toBeDefined();
      expect(exports.envConfig.wsUrls).toBeDefined();
    });
  });

  describe('Startup Failure Handling', () => {
    it('should handle missing REDIS_URL in non-test environment', async () => {
      const { exitWithConfigError } = await import('@arbitrage/core');
      expect(exitWithConfigError).toBeDefined();
    });

    it('should provide production warnings for missing RPC URLs', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.ETHEREUM_RPC_URL;
      delete process.env.ZKSYNC_RPC_URL;
      delete process.env.LINEA_RPC_URL;

      jest.resetModules();
      const { cleanupProcessHandlers } = await import('../../index');
      cleanupFn = cleanupProcessHandlers;

      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should not warn about RPC URLs in development mode', async () => {
      process.env.NODE_ENV = 'development';
      jest.clearAllMocks();

      jest.resetModules();
      const { cleanupProcessHandlers } = await import('../../index');
      cleanupFn = cleanupProcessHandlers;

      const warnCalls = mockLogger.warn.mock.calls;
      const rpcWarnings = warnCalls.filter((call: unknown[]) =>
        typeof call[0] === 'string' && call[0].includes('RPC')
      );
      expect(rpcWarnings.length).toBe(0);
    });
  });

  describe('Production Environment Validation', () => {
    it('should warn about all 3 missing RPC URLs in production', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.ETHEREUM_RPC_URL;
      delete process.env.ZKSYNC_RPC_URL;
      delete process.env.LINEA_RPC_URL;
      jest.clearAllMocks();

      jest.resetModules();
      const { cleanupProcessHandlers } = await import('../../index');
      cleanupFn = cleanupProcessHandlers;

      const rpcWarning = mockLogger.warn.mock.calls.find((call: unknown[]) =>
        typeof call[0] === 'string' && call[0].includes('RPC')
      );
      expect(rpcWarning).toBeDefined();
      if (rpcWarning && rpcWarning[1]) {
        const context = rpcWarning[1] as { missingRpcUrls?: string[] };
        expect(context.missingRpcUrls).toContain('ETHEREUM_RPC_URL');
        expect(context.missingRpcUrls).toContain('ZKSYNC_RPC_URL');
        expect(context.missingRpcUrls).toContain('LINEA_RPC_URL');
      }
    });

    it('should warn about all 3 missing WebSocket URLs in production', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.ETHEREUM_WS_URL;
      delete process.env.ZKSYNC_WS_URL;
      delete process.env.LINEA_WS_URL;
      jest.clearAllMocks();

      jest.resetModules();
      const { cleanupProcessHandlers } = await import('../../index');
      cleanupFn = cleanupProcessHandlers;

      const wsWarning = mockLogger.warn.mock.calls.find((call: unknown[]) =>
        typeof call[0] === 'string' && call[0].includes('WebSocket')
      );
      expect(wsWarning).toBeDefined();
      if (wsWarning && wsWarning[1]) {
        const context = wsWarning[1] as { missingWsUrls?: string[] };
        expect(context.missingWsUrls).toContain('ETHEREUM_WS_URL');
        expect(context.missingWsUrls).toContain('ZKSYNC_WS_URL');
        expect(context.missingWsUrls).toContain('LINEA_WS_URL');
      }
    });

    it('should not warn when all RPC URLs are provided in production', async () => {
      process.env.NODE_ENV = 'production';
      process.env.ETHEREUM_RPC_URL = 'https://custom-eth.com';
      process.env.ZKSYNC_RPC_URL = 'https://custom-zksync.com';
      process.env.LINEA_RPC_URL = 'https://custom-linea.com';
      jest.clearAllMocks();

      jest.resetModules();
      const { cleanupProcessHandlers } = await import('../../index');
      cleanupFn = cleanupProcessHandlers;

      const rpcWarning = mockLogger.warn.mock.calls.find((call: unknown[]) =>
        typeof call[0] === 'string' && call[0].includes('RPC')
      );
      expect(rpcWarning).toBeUndefined();
    });

    it('should include helpful hints in production warnings', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.ETHEREUM_RPC_URL;
      jest.clearAllMocks();

      jest.resetModules();
      const { cleanupProcessHandlers } = await import('../../index');
      cleanupFn = cleanupProcessHandlers;

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

  describe('High-Value Chain Characteristics', () => {
    it('should have Ethereum as the primary high-value chain', async () => {
      jest.resetModules();
      const { config, cleanupProcessHandlers } = await import('../../index');
      cleanupFn = cleanupProcessHandlers;

      expect(config.chains).toContain('ethereum');
    });

    it('should include zkSync for ZK rollup arbitrage opportunities', async () => {
      jest.resetModules();
      const { config, cleanupProcessHandlers } = await import('../../index');
      cleanupFn = cleanupProcessHandlers;

      expect(config.chains).toContain('zksync');
    });

    it('should include Linea for Consensys ZK rollup opportunities', async () => {
      jest.resetModules();
      const { config, cleanupProcessHandlers } = await import('../../index');
      cleanupFn = cleanupProcessHandlers;

      expect(config.chains).toContain('linea');
    });

    it('should use us-east1 region for proximity to Ethereum infrastructure', async () => {
      jest.resetModules();
      const { P3_REGION, config, cleanupProcessHandlers } = await import('../../index');
      cleanupFn = cleanupProcessHandlers;

      expect(P3_REGION).toBe('us-east1');
      expect(config.regionId).toBe('us-east1');
    });
  });
});
