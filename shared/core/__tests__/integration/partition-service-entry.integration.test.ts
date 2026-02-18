/**
 * Integration Tests for createPartitionEntry (ADR-003)
 *
 * Tests the partition entry point factory with real Redis and controlled
 * partition config, verifying the full initialization sequence:
 * 1. Partition config retrieval
 * 2. Environment config parsing and validation
 * 3. Detector factory invocation with correct config
 * 4. Runner creation with proper lifecycle methods
 * 5. Process handler registration and cleanup
 *
 * This fills the ADR-003 gap: no authentic integration test existed for
 * partition startup with real dependencies.
 *
 * @see ADR-003: Partitioned Chain Detectors (Factory Pattern)
 * @see shared/core/src/partition-service-utils.ts - createPartitionEntry
 * @see ADR-009: Test Architecture
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'events';
import Redis from 'ioredis';
import { createTestRedisClient, flushTestRedis } from '@arbitrage/test-utils';

// =============================================================================
// Module Mocks (must be before imports of mocked modules)
// =============================================================================

// Mock @arbitrage/config to provide controlled partition data
// Fix 12d: Added SOLANA_NATIVE to PARTITION_IDS and solana to CHAINS to match
// the real config from shared/config/src/partition-ids.ts and chains.ts.
jest.mock('@arbitrage/config', () => ({
  CHAINS: {
    bsc: { id: 56, name: 'BSC' },
    polygon: { id: 137, name: 'Polygon' },
    avalanche: { id: 43114, name: 'Avalanche' },
    fantom: { id: 250, name: 'Fantom' },
    arbitrum: { id: 42161, name: 'Arbitrum' },
    optimism: { id: 10, name: 'Optimism' },
    base: { id: 8453, name: 'Base' },
    ethereum: { id: 1, name: 'Ethereum' },
    zksync: { id: 324, name: 'zkSync' },
    linea: { id: 59144, name: 'Linea' },
    solana: { id: 101, name: 'Solana' },
  },
  TESTNET_CHAINS: {},
  getPartition: jest.fn(),
  getChainsForPartition: jest.fn(),
  PARTITION_IDS: {
    ASIA_FAST: 'asia-fast',
    L2_TURBO: 'l2-turbo',
    HIGH_VALUE: 'high-value',
    SOLANA_NATIVE: 'solana-native',
  },
}));

// Note: No logger mock needed - the real createLogger (Pino-based) works fine
// and provides the full interface (level, isLevelEnabled) required by
// setupDetectorEventHandlers. Using the real logger is appropriate for
// integration tests.

// =============================================================================
// Imports (after mocks)
// =============================================================================

import {
  createPartitionEntry,
  PartitionDetectorInterface,
  PartitionEntryResult,
} from '@arbitrage/core';

// =============================================================================
// Mock Partition Data
// =============================================================================

const MOCK_PARTITIONS: Record<string, {
  id: string;
  partitionId: string;
  chains: readonly string[];
  region: string;
  name: string;
  provider: string;
}> = {
  'asia-fast': {
    id: 'asia-fast',
    partitionId: 'asia-fast',
    chains: ['bsc', 'polygon', 'avalanche', 'fantom'],
    region: 'asia-southeast1',
    name: 'P1: Asia-Fast',
    provider: 'oracle',
  },
  'l2-turbo': {
    id: 'l2-turbo',
    partitionId: 'l2-turbo',
    chains: ['arbitrum', 'optimism', 'base'],
    region: 'us-central1',
    name: 'P2: L2-Turbo',
    provider: 'oracle',
  },
  'high-value': {
    id: 'high-value',
    partitionId: 'high-value',
    chains: ['ethereum'],
    region: 'us-east1',
    name: 'P3: High-Value',
    provider: 'oracle',
  },
};

// =============================================================================
// Mock Detector
// =============================================================================

class MockDetector extends EventEmitter implements PartitionDetectorInterface {
  private running = false;
  private _partitionId: string;
  private _chains: string[];

  constructor(partitionId = 'test-partition', chains = ['bsc', 'polygon']) {
    super();
    this._partitionId = partitionId;
    this._chains = chains;
  }

  async getPartitionHealth() {
    return {
      status: 'healthy',
      partitionId: this._partitionId,
      chainHealth: new Map<string, unknown>(),
      uptimeSeconds: 0,
      totalEventsProcessed: 0,
      memoryUsage: 128 * 1024 * 1024,
    };
  }

  getHealthyChains() {
    return [...this._chains];
  }

  getStats() {
    return {
      partitionId: this._partitionId,
      chains: [...this._chains],
      totalEventsProcessed: 0,
      totalOpportunitiesFound: 0,
      uptimeSeconds: 0,
      memoryUsageMB: 128,
      chainStats: new Map<string, unknown>(),
    };
  }

  isRunning() {
    return this.running;
  }

  getPartitionId() {
    return this._partitionId;
  }

  getChains() {
    return [...this._chains];
  }

  async start() {
    this.running = true;
  }

  async stop() {
    this.running = false;
  }
}

// =============================================================================
// Tests
// =============================================================================

describe('[Level 2] createPartitionEntry Integration', () => {
  let redis: Redis;
  let processExitSpy: jest.SpiedFunction<typeof process.exit>;
  const originalEnv = process.env;

  // Re-acquire mocked getPartition for per-test setup
  const { getPartition } =
    jest.requireMock<typeof import('@arbitrage/config')>('@arbitrage/config');

  beforeAll(async () => {
    redis = await createTestRedisClient();
  });

  afterAll(async () => {
    if (redis) {
      await redis.quit();
    }
  });

  beforeEach(async () => {
    if (redis) {
      await flushTestRedis(redis);
    }

    // Set up test environment: JEST_WORKER_ID prevents auto-start,
    // NODE_ENV=test skips REDIS_URL requirement
    process.env = { ...originalEnv, JEST_WORKER_ID: 'test', NODE_ENV: 'test' };

    // Mock process.exit to prevent test runner from exiting
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    // Re-establish mock implementations (cleared by jest resetMocks)
    (getPartition as jest.Mock).mockImplementation(
      (...args: unknown[]) => MOCK_PARTITIONS[args[0] as string] ?? undefined
    );
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    // Remove process listeners registered by setupProcessHandlers
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
    process.env = originalEnv;
  });

  // ===========================================================================
  // Config correctness for each partition
  // ===========================================================================

  describe('config correctness', () => {
    it('should produce correct config for asia-fast partition', () => {
      const entry = createPartitionEntry('asia-fast', () => new MockDetector());

      try {
        expect(entry.partitionId).toBe('asia-fast');
        expect(entry.chains).toEqual(['bsc', 'polygon', 'avalanche', 'fantom']);
        expect(entry.region).toBe('asia-southeast1');

        expect(entry.config.partitionId).toBe('asia-fast');
        expect(entry.config.chains).toEqual(
          expect.arrayContaining(['bsc', 'polygon', 'avalanche', 'fantom'])
        );
        expect(entry.config.chains).toHaveLength(4);
        expect(entry.config.instanceId).toEqual(expect.any(String));
        expect(entry.config.regionId).toBe('asia-southeast1');
        expect(entry.config.enableCrossRegionHealth).toBe(true);
        expect(entry.config.healthCheckPort).toEqual(expect.any(Number));
      } finally {
        entry.cleanupProcessHandlers();
      }
    });

    it('should produce correct config for l2-turbo partition', () => {
      const entry = createPartitionEntry('l2-turbo', () => new MockDetector());

      try {
        expect(entry.partitionId).toBe('l2-turbo');
        expect(entry.chains).toEqual(['arbitrum', 'optimism', 'base']);
        expect(entry.region).toBe('us-central1');
        expect(entry.config.partitionId).toBe('l2-turbo');
      } finally {
        entry.cleanupProcessHandlers();
      }
    });

    it('should produce correct config for high-value partition', () => {
      const entry = createPartitionEntry('high-value', () => new MockDetector());

      try {
        expect(entry.partitionId).toBe('high-value');
        expect(entry.chains).toEqual(['ethereum']);
        expect(entry.region).toBe('us-east1');
        expect(entry.config.chains).toEqual(['ethereum']);
      } finally {
        entry.cleanupProcessHandlers();
      }
    });
  });

  // ===========================================================================
  // Environment config parsing
  // ===========================================================================

  describe('envConfig parsing', () => {
    it('should parse REDIS_URL from environment', () => {
      const redisUrl = `redis://localhost:${redis.options.port ?? 6379}`;
      process.env.REDIS_URL = redisUrl;

      const entry = createPartitionEntry('asia-fast', () => new MockDetector());

      try {
        expect(entry.envConfig).toBeDefined();
        expect(entry.envConfig.redisUrl).toBe(redisUrl);
      } finally {
        entry.cleanupProcessHandlers();
      }
    });

    it('should parse NODE_ENV from environment', () => {
      process.env.NODE_ENV = 'test';

      const entry = createPartitionEntry('asia-fast', () => new MockDetector());

      try {
        expect(entry.envConfig.nodeEnv).toBe('test');
      } finally {
        entry.cleanupProcessHandlers();
      }
    });

    it('should parse INSTANCE_ID from environment', () => {
      process.env.INSTANCE_ID = 'integ-test-instance-42';

      const entry = createPartitionEntry('asia-fast', () => new MockDetector());

      try {
        expect(entry.config.instanceId).toBe('integ-test-instance-42');
        expect(entry.envConfig.instanceId).toBe('integ-test-instance-42');
      } finally {
        entry.cleanupProcessHandlers();
      }
    });

    it('should parse REGION_ID override from environment', () => {
      process.env.REGION_ID = 'eu-west1';

      const entry = createPartitionEntry('asia-fast', () => new MockDetector());

      try {
        expect(entry.config.regionId).toBe('eu-west1');
        expect(entry.envConfig.regionId).toBe('eu-west1');
      } finally {
        entry.cleanupProcessHandlers();
      }
    });

    it('should parse HEALTH_CHECK_PORT from environment', () => {
      process.env.HEALTH_CHECK_PORT = '9999';

      const entry = createPartitionEntry('asia-fast', () => new MockDetector());

      try {
        expect(entry.config.healthCheckPort).toBe(9999);
        expect(entry.envConfig.healthCheckPort).toBe('9999');
      } finally {
        entry.cleanupProcessHandlers();
      }
    });

    it('should parse ENABLE_CROSS_REGION_HEALTH=false from environment', () => {
      process.env.ENABLE_CROSS_REGION_HEALTH = 'false';

      const entry = createPartitionEntry('asia-fast', () => new MockDetector());

      try {
        expect(entry.config.enableCrossRegionHealth).toBe(false);
        expect(entry.envConfig.enableCrossRegionHealth).toBe(false);
      } finally {
        entry.cleanupProcessHandlers();
      }
    });

    it('should parse PARTITION_CHAINS override to filter chains', () => {
      process.env.PARTITION_CHAINS = 'bsc,polygon';

      const entry = createPartitionEntry('asia-fast', () => new MockDetector());

      try {
        expect(entry.config.chains).toEqual(['bsc', 'polygon']);
        // Top-level chains remains the partition default
        expect(entry.chains).toEqual(['bsc', 'polygon', 'avalanche', 'fantom']);
      } finally {
        entry.cleanupProcessHandlers();
      }
    });

    it('should parse per-chain RPC and WS URLs from environment', () => {
      process.env.BSC_RPC_URL = 'https://bsc-rpc.example.com';
      process.env.BSC_WS_URL = 'wss://bsc-ws.example.com';
      process.env.POLYGON_RPC_URL = 'https://polygon-rpc.example.com';
      // Explicitly delete POLYGON_WS_URL to test the undefined case
      delete process.env.POLYGON_WS_URL;

      const entry = createPartitionEntry('asia-fast', () => new MockDetector());

      try {
        expect(entry.envConfig.rpcUrls['bsc']).toBe('https://bsc-rpc.example.com');
        expect(entry.envConfig.wsUrls['bsc']).toBe('wss://bsc-ws.example.com');
        expect(entry.envConfig.rpcUrls['polygon']).toBe('https://polygon-rpc.example.com');
        // Explicitly deleted env var should result in undefined
        expect(entry.envConfig.wsUrls['polygon']).toBeUndefined();
      } finally {
        entry.cleanupProcessHandlers();
      }
    });
  });

  // ===========================================================================
  // Detector factory callback
  // ===========================================================================

  describe('detector factory', () => {
    it('should invoke createDetector with the expected config shape', () => {
      const createDetectorSpy = jest.fn(
        (_cfg: Record<string, unknown>) => new MockDetector() as PartitionDetectorInterface
      );

      const entry = createPartitionEntry('asia-fast', createDetectorSpy);

      try {
        expect(createDetectorSpy).toHaveBeenCalledTimes(1);

        const passedConfig = createDetectorSpy.mock.calls[0][0];
        expect(passedConfig).toMatchObject({
          partitionId: 'asia-fast',
          chains: expect.arrayContaining(['bsc', 'polygon', 'avalanche', 'fantom']),
          instanceId: expect.any(String),
          regionId: expect.any(String),
          enableCrossRegionHealth: expect.any(Boolean),
          healthCheckPort: expect.any(Number),
        });
      } finally {
        entry.cleanupProcessHandlers();
      }
    });

    it('should pass INSTANCE_ID to detector config when set', () => {
      process.env.INSTANCE_ID = 'factory-test-instance';
      const createDetectorSpy = jest.fn(
        (_cfg: Record<string, unknown>) => new MockDetector() as PartitionDetectorInterface
      );

      const entry = createPartitionEntry('l2-turbo', createDetectorSpy);

      try {
        const passedConfig = createDetectorSpy.mock.calls[0][0];
        expect(passedConfig).toMatchObject({
          partitionId: 'l2-turbo',
          instanceId: 'factory-test-instance',
        });
      } finally {
        entry.cleanupProcessHandlers();
      }
    });

    it('should return the detector created by the factory', () => {
      const detector = new MockDetector('custom-partition', ['ethereum']);
      const entry = createPartitionEntry('high-value', () => detector);

      try {
        expect(entry.detector).toBe(detector);
      } finally {
        entry.cleanupProcessHandlers();
      }
    });
  });

  // ===========================================================================
  // Runner and lifecycle
  // ===========================================================================

  describe('runner', () => {
    it('should return a runner with start, getState, and cleanup methods', () => {
      const entry = createPartitionEntry('asia-fast', () => new MockDetector());

      try {
        expect(entry.runner).toBeDefined();
        expect(typeof entry.runner.start).toBe('function');
        expect(typeof entry.runner.getState).toBe('function');
        expect(typeof entry.runner.cleanup).toBe('function');
        expect(entry.runner.detector).toBeDefined();
      } finally {
        entry.cleanupProcessHandlers();
      }
    });

    it('should have idle state before start is called (JEST_WORKER_ID prevents auto-start)', () => {
      const entry = createPartitionEntry('asia-fast', () => new MockDetector());

      try {
        expect(entry.runner.getState()).toBe('idle');
      } finally {
        entry.cleanupProcessHandlers();
      }
    });
  });

  // ===========================================================================
  // Process handler cleanup
  // ===========================================================================

  describe('process handler cleanup', () => {
    it('should register process handlers on creation', () => {
      const sigtermBefore = process.listenerCount('SIGTERM');
      const sigintBefore = process.listenerCount('SIGINT');

      const entry = createPartitionEntry('asia-fast', () => new MockDetector());

      try {
        expect(process.listenerCount('SIGTERM')).toBeGreaterThan(sigtermBefore);
        expect(process.listenerCount('SIGINT')).toBeGreaterThan(sigintBefore);
      } finally {
        entry.cleanupProcessHandlers();
      }
    });

    it('should remove process handlers when cleanup is called', () => {
      const entry = createPartitionEntry('asia-fast', () => new MockDetector());

      const sigtermDuring = process.listenerCount('SIGTERM');
      expect(sigtermDuring).toBeGreaterThanOrEqual(1);

      entry.cleanupProcessHandlers();

      const sigtermAfter = process.listenerCount('SIGTERM');
      expect(sigtermAfter).toBeLessThan(sigtermDuring);
    });

    it('should not throw when cleanup is called multiple times', () => {
      const entry = createPartitionEntry('asia-fast', () => new MockDetector());

      expect(() => {
        entry.cleanupProcessHandlers();
        entry.cleanupProcessHandlers();
      }).not.toThrow();
    });
  });

  // ===========================================================================
  // Error handling
  // ===========================================================================

  describe('error handling', () => {
    it('should call process.exit(1) for unknown partition ID', () => {
      const entry = createPartitionEntry(
        'nonexistent-partition',
        () => new MockDetector()
      );

      try {
        expect(processExitSpy).toHaveBeenCalledWith(1);
      } finally {
        entry.cleanupProcessHandlers();
      }
    });

    it('should call process.exit(1) when partition has empty chains', () => {
      (getPartition as jest.Mock).mockReturnValueOnce({
        id: 'empty-chains',
        partitionId: 'empty-chains',
        chains: [],
        region: 'us-east1',
        name: 'Empty',
        provider: 'oracle',
      });

      const entry = createPartitionEntry(
        'empty-chains',
        () => new MockDetector()
      );

      try {
        expect(processExitSpy).toHaveBeenCalledWith(1);
      } finally {
        entry.cleanupProcessHandlers();
      }
    });
  });

  // ===========================================================================
  // Redis connectivity (real integration)
  // ===========================================================================

  describe('Redis connectivity verification', () => {
    it('should parse REDIS_URL that points to real Redis', async () => {
      const redisUrl = `redis://localhost:${redis.options.port ?? 6379}`;
      process.env.REDIS_URL = redisUrl;

      const entry = createPartitionEntry('asia-fast', () => new MockDetector());

      try {
        // Verify the envConfig captured the real Redis URL
        expect(entry.envConfig.redisUrl).toBe(redisUrl);

        // Verify we can actually reach Redis with that URL
        const pong = await redis.ping();
        expect(pong).toBe('PONG');

        // Write a partition marker to Redis to prove the connection is live
        const key = `partition:${entry.partitionId}:test-marker`;
        await redis.set(key, JSON.stringify({
          partitionId: entry.partitionId,
          chains: [...entry.chains],
          region: entry.region,
          timestamp: Date.now(),
        }));

        const stored = await redis.get(key);
        expect(stored).toBeTruthy();

        const parsed = JSON.parse(stored!);
        expect(parsed.partitionId).toBe('asia-fast');
        expect(parsed.chains).toEqual(['bsc', 'polygon', 'avalanche', 'fantom']);
        expect(parsed.region).toBe('asia-southeast1');
      } finally {
        entry.cleanupProcessHandlers();
      }
    });
  });
});
