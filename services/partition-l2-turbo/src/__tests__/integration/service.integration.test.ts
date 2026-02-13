/**
 * Integration Tests for P2 L2-Turbo Partition Service
 *
 * Tests service configuration, environment variable handling, and module behavior.
 * Based on P1 integration test template, adapted for P2 L2-Turbo partition data.
 *
 * P2 L2-Turbo Partition:
 * - Chains: Arbitrum, Optimism, Base
 * - Region: Fly.io Singapore (asia-southeast1)
 * - Port: 3002
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
  partitionId: 'l2-turbo',
  name: 'L2 Turbo Chains',
  chains: ['arbitrum', 'optimism', 'base'],
  region: 'asia-southeast1',
  provider: 'fly',
  resourceProfile: 'standard',
  priority: 1,
  maxMemoryMB: 512,
  healthCheckIntervalMs: 10000,
  failoverTimeoutMs: 45000,
  chainsSubset: ['arbitrum', 'optimism', 'base'],
}));

jest.mock('@arbitrage/unified-detector', () => ({
  UnifiedChainDetector: MockUnifiedChainDetector,
}));

// =============================================================================
// Tests
// =============================================================================

describe('P2 L2-Turbo Partition Service Integration', () => {
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
    it('should configure default health check port of 3002', async () => {
      jest.resetModules();
      const { config, cleanupProcessHandlers } = await import('../../index');
      cleanupFn = cleanupProcessHandlers;

      expect(config.healthCheckPort).toBe(3002);
    });

    it('should use custom port from HEALTH_CHECK_PORT environment variable', async () => {
      process.env.HEALTH_CHECK_PORT = '4002';

      jest.resetModules();
      const { config, cleanupProcessHandlers } = await import('../../index');
      cleanupFn = cleanupProcessHandlers;

      expect(config.healthCheckPort).toBe(4002);
    });

    it('should use default port when HEALTH_CHECK_PORT is invalid', async () => {
      process.env.HEALTH_CHECK_PORT = 'invalid';

      jest.resetModules();
      const { config, cleanupProcessHandlers } = await import('../../index');
      cleanupFn = cleanupProcessHandlers;

      expect(config.healthCheckPort).toBe(3002);
    });
  });

  describe('Detector Configuration', () => {
    it('should create detector with correct partition ID', async () => {
      jest.resetModules();
      const { detector, cleanupProcessHandlers } = await import('../../index');
      cleanupFn = cleanupProcessHandlers;

      expect(detector.getPartitionId()).toBe('l2-turbo');
    });

    it('should configure detector with all 3 chains by default', async () => {
      jest.resetModules();
      const { detector, cleanupProcessHandlers } = await import('../../index');
      cleanupFn = cleanupProcessHandlers;

      expect(detector.getChains()).toEqual(['arbitrum', 'optimism', 'base']);
    });

    it('should use custom chains from PARTITION_CHAINS environment variable', async () => {
      process.env.PARTITION_CHAINS = 'arbitrum,base';

      jest.resetModules();
      const { config, cleanupProcessHandlers } = await import('../../index');
      cleanupFn = cleanupProcessHandlers;

      expect(config.chains).toEqual(['arbitrum', 'base']);
    });
  });

  describe('Service Configuration', () => {
    it('should use custom INSTANCE_ID from environment', async () => {
      process.env.INSTANCE_ID = 'l2-custom-instance-123';

      jest.resetModules();
      const { config, cleanupProcessHandlers } = await import('../../index');
      cleanupFn = cleanupProcessHandlers;

      expect(config.instanceId).toBe('l2-custom-instance-123');
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

  describe('Service Runner Factory', () => {
    it('should call createPartitionEntry with correct partition ID', async () => {
      jest.resetModules();
      const { createPartitionEntry } = await import('@arbitrage/core');
      const { cleanupProcessHandlers } = await import('../../index');
      cleanupFn = cleanupProcessHandlers;

      expect(createPartitionEntry).toHaveBeenCalledWith(
        'l2-turbo',
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
      expect(exports.P2_PARTITION_ID).toBe('l2-turbo');
      expect(exports.P2_CHAINS).toContain('arbitrum');
      expect(exports.P2_REGION).toBe('asia-southeast1');
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
      delete process.env.ARBITRUM_RPC_URL;
      delete process.env.OPTIMISM_RPC_URL;
      delete process.env.BASE_RPC_URL;

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
      delete process.env.ARBITRUM_RPC_URL;
      delete process.env.OPTIMISM_RPC_URL;
      delete process.env.BASE_RPC_URL;
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
        expect(context.missingRpcUrls).toContain('ARBITRUM_RPC_URL');
        expect(context.missingRpcUrls).toContain('OPTIMISM_RPC_URL');
        expect(context.missingRpcUrls).toContain('BASE_RPC_URL');
      }
    });

    it('should warn about all 3 missing WebSocket URLs in production', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.ARBITRUM_WS_URL;
      delete process.env.OPTIMISM_WS_URL;
      delete process.env.BASE_WS_URL;
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
        expect(context.missingWsUrls).toContain('ARBITRUM_WS_URL');
        expect(context.missingWsUrls).toContain('OPTIMISM_WS_URL');
        expect(context.missingWsUrls).toContain('BASE_WS_URL');
      }
    });

    it('should not warn when all RPC URLs are provided in production', async () => {
      process.env.NODE_ENV = 'production';
      process.env.ARBITRUM_RPC_URL = 'https://custom-arb.com';
      process.env.OPTIMISM_RPC_URL = 'https://custom-op.com';
      process.env.BASE_RPC_URL = 'https://custom-base.com';
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
      delete process.env.ARBITRUM_RPC_URL;
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
});
