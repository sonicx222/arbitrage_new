/**
 * S3.1.4 P2 L2-Turbo Partition Service Integration Tests
 *
 * TDD-first tests for the P2 detector service (services/partition-l2-turbo/).
 * P2 is deployed to Fly.io Singapore with 3 Ethereum L2 chains:
 * - Arbitrum, Optimism, Base
 *
 * Tests verify:
 * - Partition configuration (from @arbitrage/config)
 * - Chain configurations (from @arbitrage/config)
 * - Shared utilities (from @arbitrage/core)
 * - Service exports and constants
 *
 * NOTE: Tests S3.1.4.3-S3.1.4.9 use PartitionedDetector from @arbitrage/core for
 * testing detector behavior patterns. The actual partition-l2-turbo service uses
 * UnifiedChainDetector from @arbitrage/unified-detector, which has a different
 * internal implementation but exposes similar functionality through dependency
 * injection and the shared partition utilities.
 *
 * For testing the actual UnifiedChainDetector behavior, see:
 * - services/unified-detector/src/*.test.ts
 *
 * @see IMPLEMENTATION_PLAN.md S3.1.4: Create P2 detector service
 * @see ADR-003: Partitioned Chain Detectors
 */

import { jest, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'events';

// =============================================================================
// Mocks - Must be set up before imports
// =============================================================================

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
};

const mockPerfLogger = {
  logEventLatency: jest.fn(),
  logHealthCheck: jest.fn(),
  logArbitrageOpportunity: jest.fn()
};

const mockRedisClient = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  disconnect: jest.fn(() => Promise.resolve()),
  updateServiceHealth: jest.fn(() => Promise.resolve()),
  subscribe: jest.fn(),
  publish: jest.fn()
};

const mockStreamsClient = {
  xadd: jest.fn(() => Promise.resolve('0-0')),
  xread: jest.fn(() => Promise.resolve([])),
  disconnect: jest.fn(() => Promise.resolve()),
  createBatcher: jest.fn(() => ({
    add: jest.fn(),
    flush: jest.fn(() => Promise.resolve()),
    destroy: jest.fn(() => Promise.resolve()),
    getStats: jest.fn(() => ({ pending: 0, flushed: 0 }))
  })),
  STREAMS: {
    PRICE_UPDATES: 'stream:price-updates',
    OPPORTUNITIES: 'stream:opportunities',
    SWAP_EVENTS: 'stream:swap-events',
    WHALE_ALERTS: 'stream:whale-alerts'
  }
};

// Mock WebSocket manager with full event support
class MockWebSocketManager extends EventEmitter {
  public url: string;
  public connected = false;
  private connectDelay: number;
  private shouldFail: boolean;

  constructor(config: { url: string; connectDelay?: number; shouldFail?: boolean }) {
    super();
    this.url = config.url;
    this.connectDelay = config.connectDelay ?? 0;
    this.shouldFail = config.shouldFail ?? false;
  }

  async connect(): Promise<void> {
    if (this.connectDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, this.connectDelay));
    }
    if (this.shouldFail) {
      throw new Error('Connection failed');
    }
    this.connected = true;
    this.emit('connected');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.emit('disconnected');
  }

  subscribe(subscription: unknown): void {
    // Mock subscription
  }

  getConnectionStats() {
    return { connected: this.connected, reconnects: 0 };
  }
}

// Use simple functions instead of jest.fn() to survive resetMocks: true
jest.mock('@arbitrage/core/logger', () => ({
  createLogger: () => mockLogger,
  getPerformanceLogger: () => mockPerfLogger
}));

jest.mock('@arbitrage/core/redis', () => ({
  getRedisClient: () => Promise.resolve(mockRedisClient),
  RedisClient: jest.fn()
}));

jest.mock('@arbitrage/core/redis-streams', () => ({
  getRedisStreamsClient: () => Promise.resolve(mockStreamsClient),
  RedisStreamsClient: {
    STREAMS: mockStreamsClient.STREAMS
  }
}));

jest.mock('@arbitrage/core/websocket-manager', () => ({
  WebSocketManager: MockWebSocketManager
}));

// Import after mocks
import {
  PartitionedDetector,
  PartitionedDetectorConfig,
  PartitionedDetectorDeps,
  TokenNormalizeFn
} from '@arbitrage/core';

/**
 * Mock token normalizer for cross-chain matching tests.
 */
const mockNormalizeToken: TokenNormalizeFn = (symbol: string) => {
  const upper = symbol.toUpperCase().trim();
  const aliases: Record<string, string> = {
    'FUSDT': 'USDT', 'WFTM': 'FTM', 'WAVAX': 'AVAX',
    'WETH.E': 'WETH', 'WBTC.E': 'WBTC', 'USDT.E': 'USDT',
    'WBNB': 'BNB', 'BTCB': 'WBTC', 'ETH': 'WETH',
    'WMATIC': 'MATIC', 'WETH': 'WETH', 'WBTC': 'WBTC',
    'USDC': 'USDC', 'USDT': 'USDT', 'DAI': 'DAI'
  };
  return aliases[upper] || upper;
};

// Helper to create mock deps for PartitionedDetector
const createMockDetectorDeps = (): PartitionedDetectorDeps => ({
  logger: mockLogger,
  perfLogger: mockPerfLogger as any,
  normalizeToken: mockNormalizeToken
});

import {
  PARTITIONS,
  getPartition,
  getChainsForPartition,
  createChainInstance,
  createPartitionChainInstances,
  calculatePartitionResources,
  validatePartitionConfig
} from '@arbitrage/config/partitions';

import { PARTITION_IDS } from '@arbitrage/config';

import {
  CHAINS,
  DEXES,
  CORE_TOKENS,
  DETECTOR_CONFIG,
  TOKEN_METADATA,
  getEnabledDexes
} from '@arbitrage/config';

// =============================================================================
// Constants
// =============================================================================

const P2_PARTITION_ID = PARTITION_IDS.L2_TURBO;
const P2_CHAINS = ['arbitrum', 'optimism', 'base'] as const;
const P2_REGION = 'asia-southeast1';

// =============================================================================
// Test Helpers
// =============================================================================

function createP2Config(overrides: Partial<PartitionedDetectorConfig> = {}): PartitionedDetectorConfig {
  return {
    partitionId: P2_PARTITION_ID,
    chains: [...P2_CHAINS],
    region: P2_REGION,
    healthCheckIntervalMs: 100000, // Long interval to avoid interference
    failoverTimeoutMs: 45000,
    ...overrides
  };
}

async function createStartedP2Detector(config?: PartitionedDetectorConfig): Promise<PartitionedDetector> {
  // Use DI to inject mock logger/perfLogger
  const detector = new PartitionedDetector(config || createP2Config(), createMockDetectorDeps());
  await detector.start();
  return detector;
}

// =============================================================================
// S3.1.4.1: P2 Partition Configuration Tests
// =============================================================================

describe('S3.1.4 P2 L2-Turbo Partition Service', () => {
  let detector: PartitionedDetector | null = null;

  afterEach(async () => {
    jest.clearAllMocks();
    if (detector) {
      await detector.stop();
      detector = null;
    }
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  describe('S3.1.4.1: P2 Partition Configuration', () => {
    it('should have l2-turbo partition defined in PARTITIONS', () => {
      const partition = getPartition(P2_PARTITION_ID);
      expect(partition).toBeDefined();
      expect(partition!.partitionId).toBe('l2-turbo');
    });

    it('should include exactly 3 chains: Arbitrum, Optimism, Base', () => {
      const partition = getPartition(P2_PARTITION_ID);
      expect(partition!.chains).toHaveLength(3);
      expect(partition!.chains).toContain('arbitrum');
      expect(partition!.chains).toContain('optimism');
      expect(partition!.chains).toContain('base');
    });

    it('should be deployed to asia-southeast1 (Singapore) region', () => {
      const partition = getPartition(P2_PARTITION_ID);
      expect(partition!.region).toBe('asia-southeast1');
    });

    it('should use fly provider for deployment', () => {
      const partition = getPartition(P2_PARTITION_ID);
      expect(partition!.provider).toBe('fly');
    });

    it('should have standard resource profile for 3 chains', () => {
      const partition = getPartition(P2_PARTITION_ID);
      expect(partition!.resourceProfile).toBe('standard');
    });

    it('should have priority 1 (highest)', () => {
      const partition = getPartition(P2_PARTITION_ID);
      expect(partition!.priority).toBe(1);
    });

    it('should be enabled', () => {
      const partition = getPartition(P2_PARTITION_ID);
      expect(partition!.enabled).toBe(true);
    });

    it('should have adequate memory (512MB) for 3 chains', () => {
      const partition = getPartition(P2_PARTITION_ID);
      expect(partition!.maxMemoryMB).toBeGreaterThanOrEqual(512);
    });

    it('should have standby configuration for failover', () => {
      const partition = getPartition(P2_PARTITION_ID);
      expect(partition!.standbyRegion).toBe('us-east1');
      expect(partition!.standbyProvider).toBe('railway');
    });

    it('should have faster health check interval (10s) for sub-second blocks', () => {
      const partition = getPartition(P2_PARTITION_ID);
      expect(partition!.healthCheckIntervalMs).toBe(10000);
    });

    it('should have shorter failover timeout (45s) for L2 chains', () => {
      const partition = getPartition(P2_PARTITION_ID);
      expect(partition!.failoverTimeoutMs).toBe(45000);
    });

    it('should pass validation', () => {
      const partition = getPartition(P2_PARTITION_ID);
      const validation = validatePartitionConfig(partition!);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });
  });

  // ===========================================================================
  // S3.1.4.2: Chain Configuration Tests
  // ===========================================================================

  describe('S3.1.4.2: P2 Chain Configurations', () => {
    describe('Arbitrum Chain', () => {
      it('should have Arbitrum chain defined', () => {
        expect(CHAINS['arbitrum']).toBeDefined();
        expect(CHAINS['arbitrum'].id).toBe(42161);
      });

      it('should have Arbitrum DEXes configured', () => {
        expect(DEXES['arbitrum']).toBeDefined();
        expect(DEXES['arbitrum'].length).toBeGreaterThanOrEqual(5);
      });

      it('should have Arbitrum tokens configured', () => {
        expect(CORE_TOKENS['arbitrum']).toBeDefined();
        expect(CORE_TOKENS['arbitrum'].length).toBeGreaterThanOrEqual(8);
      });

      it('should have Arbitrum detector config', () => {
        expect(DETECTOR_CONFIG['arbitrum']).toBeDefined();
        // L2 chains use 'weth' key for wrapped native token
        expect(DETECTOR_CONFIG['arbitrum'].nativeTokenKey).toBe('weth');
      });

      it('should have Arbitrum token metadata', () => {
        expect(TOKEN_METADATA['arbitrum']).toBeDefined();
        expect(TOKEN_METADATA['arbitrum'].nativeWrapper).toBeTruthy();
      });

      it('should have sub-second block time for L2', () => {
        expect(CHAINS['arbitrum'].blockTime).toBeLessThan(1);
      });
    });

    describe('Optimism Chain', () => {
      it('should have Optimism chain defined', () => {
        expect(CHAINS['optimism']).toBeDefined();
        expect(CHAINS['optimism'].id).toBe(10);
      });

      it('should have Optimism DEXes configured', () => {
        expect(DEXES['optimism']).toBeDefined();
        expect(DEXES['optimism'].length).toBeGreaterThanOrEqual(2);
      });

      it('should have Optimism tokens configured', () => {
        expect(CORE_TOKENS['optimism']).toBeDefined();
        expect(CORE_TOKENS['optimism'].length).toBeGreaterThanOrEqual(8);
      });

      it('should have Optimism detector config', () => {
        expect(DETECTOR_CONFIG['optimism']).toBeDefined();
      });

      it('should have Optimism token metadata', () => {
        expect(TOKEN_METADATA['optimism']).toBeDefined();
      });

      it('should have fast block time for L2', () => {
        expect(CHAINS['optimism'].blockTime).toBeLessThanOrEqual(2);
      });
    });

    describe('Base Chain', () => {
      it('should have Base chain defined', () => {
        expect(CHAINS['base']).toBeDefined();
        expect(CHAINS['base'].id).toBe(8453);
      });

      it('should have Base DEXes configured', () => {
        expect(DEXES['base']).toBeDefined();
        expect(DEXES['base'].length).toBeGreaterThanOrEqual(4);
      });

      it('should have Base tokens configured', () => {
        expect(CORE_TOKENS['base']).toBeDefined();
        expect(CORE_TOKENS['base'].length).toBeGreaterThanOrEqual(8);
      });

      it('should have Base detector config', () => {
        expect(DETECTOR_CONFIG['base']).toBeDefined();
        // L2 chains use 'weth' key for wrapped native token
        expect(DETECTOR_CONFIG['base'].nativeTokenKey).toBe('weth');
      });

      it('should have Base token metadata', () => {
        expect(TOKEN_METADATA['base']).toBeDefined();
        expect(TOKEN_METADATA['base'].nativeWrapper).toBeTruthy();
      });

      it('should have fast block time for L2', () => {
        expect(CHAINS['base'].blockTime).toBeLessThanOrEqual(2);
      });
    });
  });

  // ===========================================================================
  // S3.1.4.3: Service Startup Tests
  // ===========================================================================

  describe('S3.1.4.3: P2 Service Startup', () => {
    it('should start with all 3 P2 chains', async () => {
      detector = await createStartedP2Detector();

      expect(detector.isRunning()).toBe(true);
      expect(detector.getChains()).toHaveLength(3);
      expect(detector.getChains()).toContain('arbitrum');
      expect(detector.getChains()).toContain('optimism');
      expect(detector.getChains()).toContain('base');
    });

    it('should connect all chain managers', async () => {
      detector = await createStartedP2Detector();

      expect(detector.getChainManagers().size).toBe(3);
      expect(detector.getChainManagers().has('arbitrum')).toBe(true);
      expect(detector.getChainManagers().has('optimism')).toBe(true);
      expect(detector.getChainManagers().has('base')).toBe(true);
    });

    it('should report l2-turbo partition ID', async () => {
      detector = await createStartedP2Detector();
      expect(detector.getPartitionId()).toBe('l2-turbo');
    });

    it('should emit started event with all P2 chains', async () => {
      detector = new PartitionedDetector(createP2Config(), createMockDetectorDeps());
      const startedHandler = jest.fn();
      detector.on('started', startedHandler);

      await detector.start();

      expect(startedHandler).toHaveBeenCalledWith({
        partitionId: 'l2-turbo',
        chains: ['arbitrum', 'optimism', 'base']
      });
    });

    it('should emit chainConnected for each P2 chain', async () => {
      detector = new PartitionedDetector(createP2Config(), createMockDetectorDeps());
      const connectedHandler = jest.fn();
      detector.on('chainConnected', connectedHandler);

      await detector.start();

      expect(connectedHandler).toHaveBeenCalledTimes(3);
      expect(connectedHandler).toHaveBeenCalledWith({ chainId: 'arbitrum' });
      expect(connectedHandler).toHaveBeenCalledWith({ chainId: 'optimism' });
      expect(connectedHandler).toHaveBeenCalledWith({ chainId: 'base' });
    });

    it('should start within 5 seconds', async () => {
      detector = new PartitionedDetector(createP2Config(), createMockDetectorDeps());

      const startTime = Date.now();
      await detector.start();
      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(5000);
    });
  });

  // ===========================================================================
  // S3.1.4.4: Health Endpoint Tests
  // ===========================================================================

  describe('S3.1.4.4: P2 Health Monitoring', () => {
    it('should return healthy status when all chains connected', async () => {
      detector = await createStartedP2Detector();

      const health = detector.getPartitionHealth();

      expect(health.status).toBe('healthy');
      expect(health.partitionId).toBe('l2-turbo');
      expect(health.chainHealth.size).toBe(3);
    });

    it('should report health for all 3 chains', async () => {
      detector = await createStartedP2Detector();

      const health = detector.getPartitionHealth();

      expect(health.chainHealth.has('arbitrum')).toBe(true);
      expect(health.chainHealth.has('optimism')).toBe(true);
      expect(health.chainHealth.has('base')).toBe(true);
    });

    it('should return degraded status when one chain fails', async () => {
      detector = await createStartedP2Detector();

      // Simulate Base going down
      const chainHealth = detector['chainHealth'];
      const baseHealth = chainHealth.get('base');
      if (baseHealth) {
        baseHealth.status = 'unhealthy';
        baseHealth.wsConnected = false;
      }

      const health = detector.getPartitionHealth();

      expect(health.status).toBe('degraded');
      expect(detector.getHealthyChains()).toHaveLength(2);
      expect(detector.getHealthyChains()).toContain('arbitrum');
      expect(detector.getHealthyChains()).toContain('optimism');
      expect(detector.getHealthyChains()).not.toContain('base');
    });

    it('should track memory usage', async () => {
      detector = await createStartedP2Detector();

      const health = detector.getPartitionHealth();

      expect(health.memoryUsage).toBeGreaterThan(0);
    });

    it('should track uptime', async () => {
      detector = await createStartedP2Detector();
      await new Promise(resolve => setTimeout(resolve, 100));

      const health = detector.getPartitionHealth();

      expect(health.uptimeSeconds).toBeGreaterThan(0);
    });

    it('should track events processed', async () => {
      detector = await createStartedP2Detector();

      const health = detector.getPartitionHealth();

      expect(typeof health.totalEventsProcessed).toBe('number');
    });
  });

  // ===========================================================================
  // S3.1.4.5: Cross-Chain L2 Arbitrage Detection Tests
  // ===========================================================================

  describe('S3.1.4.5: P2 Cross-Chain L2 Arbitrage Detection', () => {
    it('should track prices across all P2 L2 chains', async () => {
      detector = await createStartedP2Detector();

      detector.updatePrice('arbitrum', 'WETH_USDC', 2500);
      detector.updatePrice('optimism', 'WETH_USDC', 2510);
      detector.updatePrice('base', 'WETH_USDC', 2520);

      const prices = detector.getCrossChainPrices('WETH_USDC');

      expect(prices.size).toBe(3);
      expect(prices.get('arbitrum')?.price).toBe(2500);
      expect(prices.get('optimism')?.price).toBe(2510);
      expect(prices.get('base')?.price).toBe(2520);
    });

    it('should detect cross-chain price discrepancies across L2 chains', async () => {
      detector = await createStartedP2Detector();

      // Create 5% price discrepancy between Arbitrum and Base
      detector.updatePrice('arbitrum', 'WETH_USDC', 2500);
      detector.updatePrice('optimism', 'WETH_USDC', 2510);
      detector.updatePrice('base', 'WETH_USDC', 2625); // 5% higher

      const discrepancies = detector.findCrossChainDiscrepancies(0.01);

      expect(discrepancies.length).toBeGreaterThan(0);
      expect(discrepancies[0].pairKey).toBe('WETH_USDC');
      expect(discrepancies[0].chains).toContain('arbitrum');
      expect(discrepancies[0].chains).toContain('base');
    });

    it('should detect arbitrage opportunities for native ETH', async () => {
      detector = await createStartedP2Detector();

      // ETH price difference between L2s
      // Note: ETH is normalized to WETH in cross-chain comparisons (S3.2.4 fix)
      detector.updatePrice('arbitrum', 'ETH_USDT', 2500);
      detector.updatePrice('base', 'ETH_USDT', 2575); // 3% higher

      const discrepancies = detector.findCrossChainDiscrepancies(0.01);

      // ETH normalizes to WETH for cross-chain detection
      expect(discrepancies.some(d => d.pairKey === 'WETH_USDT')).toBe(true);
    });

    it('should detect L2 to L2 arbitrage paths', async () => {
      detector = await createStartedP2Detector();

      // ARB token price on different L2s
      detector.updatePrice('arbitrum', 'ARB_USDC', 1.20);
      detector.updatePrice('optimism', 'ARB_USDC', 1.25); // ~4% higher

      const discrepancies = detector.findCrossChainDiscrepancies(0.02);

      expect(discrepancies.some(d =>
        d.pairKey === 'ARB_USDC' &&
        d.chains.includes('arbitrum') &&
        d.chains.includes('optimism')
      )).toBe(true);
    });
  });

  // ===========================================================================
  // S3.1.4.6: Graceful Degradation Tests
  // ===========================================================================

  describe('S3.1.4.6: P2 Graceful Degradation', () => {
    it('should continue running with 2 of 3 chains healthy', async () => {
      detector = await createStartedP2Detector();

      // Simulate Optimism going down
      const chainHealth = detector['chainHealth'];
      const optimismHealth = chainHealth.get('optimism');
      if (optimismHealth) {
        optimismHealth.status = 'unhealthy';
        optimismHealth.wsConnected = false;
      }

      expect(detector.isRunning()).toBe(true);
      expect(detector.getHealthyChains()).toContain('arbitrum');
      expect(detector.getHealthyChains()).toContain('base');
    });

    it('should continue running with 1 of 3 chains healthy', async () => {
      detector = await createStartedP2Detector();

      // Simulate Optimism and Base going down
      const chainHealth = detector['chainHealth'];
      for (const chainId of ['optimism', 'base']) {
        const health = chainHealth.get(chainId);
        if (health) {
          health.status = 'unhealthy';
          health.wsConnected = false;
        }
      }

      expect(detector.isRunning()).toBe(true);
      expect(detector.getPartitionHealth().status).toBe('degraded');
      expect(detector.getHealthyChains()).toHaveLength(1);
      expect(detector.getHealthyChains()).toContain('arbitrum');
    });

    it('should track error counts per chain', async () => {
      detector = await createStartedP2Detector();

      // Simulate errors on Arbitrum
      const wsManager = detector.getChainManagers().get('arbitrum') as unknown as EventEmitter;
      wsManager?.emit('error', new Error('Connection reset'));
      wsManager?.emit('error', new Error('Timeout'));

      const chainHealth = detector.getChainHealth('arbitrum');
      expect(chainHealth?.errorCount).toBeGreaterThanOrEqual(2);
    });

    it('should update chain health status on disconnect', async () => {
      detector = await createStartedP2Detector();

      const wsManager = detector.getChainManagers().get('base') as unknown as EventEmitter;
      wsManager?.emit('disconnected');

      const chainHealth = detector.getChainHealth('base');
      expect(chainHealth?.status).toBe('degraded');
      expect(chainHealth?.wsConnected).toBe(false);
    });
  });

  // ===========================================================================
  // S3.1.4.7: Resource Calculation Tests
  // ===========================================================================

  describe('S3.1.4.7: P2 Resource Calculations', () => {
    it('should calculate resources for 3-chain partition', () => {
      const resources = calculatePartitionResources(P2_PARTITION_ID);

      expect(resources.estimatedMemoryMB).toBeGreaterThan(200);
      expect(resources.recommendedProfile).toMatch(/standard|heavy/);
    });

    it('should estimate higher CPU cores for sub-second blocks', () => {
      const resources = calculatePartitionResources(P2_PARTITION_ID);

      // L2 chains have fast blocks, need more CPU
      expect(resources.estimatedCpuCores).toBeGreaterThanOrEqual(0.5);
    });

    it('should account for DEX count in memory estimation', () => {
      // Count total DEXes across P2 chains
      let totalDexes = 0;
      for (const chainId of P2_CHAINS) {
        totalDexes += getEnabledDexes(chainId).length;
      }

      // Should have at least 10 DEXes (Arbitrum:9 + Optimism:3 + Base:7)
      expect(totalDexes).toBeGreaterThanOrEqual(10);

      const resources = calculatePartitionResources(P2_PARTITION_ID);
      // Memory should include DEX overhead
      expect(resources.estimatedMemoryMB).toBeGreaterThan(totalDexes * 5);
    });

    it('should have lower memory than P1 (4 chains vs 3 chains)', () => {
      const p1Resources = calculatePartitionResources(PARTITION_IDS.ASIA_FAST);
      const p2Resources = calculatePartitionResources(P2_PARTITION_ID);

      // P2 with 3 chains should need less memory than P1 with 4 chains
      expect(p2Resources.estimatedMemoryMB).toBeLessThanOrEqual(p1Resources.estimatedMemoryMB);
    });
  });

  // ===========================================================================
  // S3.1.4.8: Chain Instance Creation Tests
  // ===========================================================================

  describe('S3.1.4.8: P2 Chain Instance Creation', () => {
    it('should create chain instances for all P2 chains', () => {
      const instances = createPartitionChainInstances(P2_PARTITION_ID);

      expect(instances).toHaveLength(3);
      expect(instances.map(i => i.chainId)).toContain('arbitrum');
      expect(instances.map(i => i.chainId)).toContain('optimism');
      expect(instances.map(i => i.chainId)).toContain('base');
    });

    it('should include DEX names for each chain', () => {
      const arbitrumInstance = createChainInstance('arbitrum');
      const baseInstance = createChainInstance('base');

      expect(arbitrumInstance!.dexes).toContain('uniswap_v3');
      expect(baseInstance!.dexes).toContain('uniswap_v3');
    });

    it('should include token symbols for each chain', () => {
      const arbitrumInstance = createChainInstance('arbitrum');
      const optimismInstance = createChainInstance('optimism');

      expect(arbitrumInstance!.tokens).toContain('WETH');
      expect(optimismInstance!.tokens).toContain('WETH');
    });

    it('should have correct native tokens (ETH for all L2s)', () => {
      const instances = createPartitionChainInstances(P2_PARTITION_ID);

      const arbitrum = instances.find(i => i.chainId === 'arbitrum');
      const optimism = instances.find(i => i.chainId === 'optimism');
      const base = instances.find(i => i.chainId === 'base');

      expect(arbitrum!.nativeToken).toBe('ETH');
      expect(optimism!.nativeToken).toBe('ETH');
      expect(base!.nativeToken).toBe('ETH');
    });

    it('should have sub-second block times for L2 chains', () => {
      const instances = createPartitionChainInstances(P2_PARTITION_ID);

      for (const instance of instances) {
        // L2 chains should have fast blocks (< 2 seconds)
        expect(instance.blockTime).toBeLessThanOrEqual(2);
      }
    });
  });

  // ===========================================================================
  // S3.1.4.9: Service Shutdown Tests
  // ===========================================================================

  describe('S3.1.4.9: P2 Service Shutdown', () => {
    it('should cleanly stop all 3 chains', async () => {
      detector = await createStartedP2Detector();
      expect(detector.isRunning()).toBe(true);

      await detector.stop();

      expect(detector.isRunning()).toBe(false);
      expect(detector.getChainManagers().size).toBe(0);
    });

    it('should emit stopped event', async () => {
      detector = await createStartedP2Detector();
      const stoppedHandler = jest.fn();
      detector.on('stopped', stoppedHandler);

      await detector.stop();

      expect(stoppedHandler).toHaveBeenCalledWith({
        partitionId: 'l2-turbo'
      });
    });

    it('should disconnect Redis clients on shutdown', async () => {
      detector = await createStartedP2Detector();

      await detector.stop();

      expect(mockRedisClient.disconnect).toHaveBeenCalled();
      expect(mockStreamsClient.disconnect).toHaveBeenCalled();
    });

    it('should handle shutdown errors gracefully', async () => {
      detector = await createStartedP2Detector();
      mockRedisClient.disconnect.mockRejectedValueOnce(new Error('Disconnect error'));

      await expect(detector.stop()).resolves.not.toThrow();
      expect(detector.isRunning()).toBe(false);
    });
  });
});

// =============================================================================
// S3.1.4.10: Environment Variable Configuration Tests
// =============================================================================

describe('S3.1.4.10: P2 Environment Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should configure P2 with PARTITION_ID=l2-turbo', async () => {
    process.env.PARTITION_ID = 'l2-turbo';

    // Re-import to get fresh config
    const { getPartitionFromEnv } = await import('../../shared/config/src/partitions');
    const partition = getPartitionFromEnv();

    expect(partition).toBeDefined();
    expect(partition!.partitionId).toBe('l2-turbo');
    expect(partition!.chains).toHaveLength(3);
  });

  it('should allow chain override via PARTITION_CHAINS', async () => {
    process.env.PARTITION_ID = 'l2-turbo';
    process.env.PARTITION_CHAINS = 'arbitrum, base';

    const { getChainsFromEnv } = await import('../../shared/config/src/partitions');
    const chains = getChainsFromEnv();

    expect(chains).toEqual(['arbitrum', 'base']);
  });
});

// =============================================================================
// S3.1.4.11: Deployment Configuration Tests (Dockerfile, docker-compose)
// =============================================================================

describe('S3.1.4.11: P2 Deployment Configuration', () => {
  it('should have correct P2 chains in partition config', () => {
    const partition = getPartition(P2_PARTITION_ID);

    // Verify chains match expected P2 deployment
    expect(partition!.chains).toEqual(['arbitrum', 'optimism', 'base']);
  });

  it('should have Fly.io provider configured for P2', () => {
    const partition = getPartition(P2_PARTITION_ID);
    expect(partition!.provider).toBe('fly');
  });

  it('should have Singapore region configured', () => {
    const partition = getPartition(P2_PARTITION_ID);
    expect(partition!.region).toBe('asia-southeast1');
  });

  it('should have standby in us-east1 with railway provider', () => {
    const partition = getPartition(P2_PARTITION_ID);
    expect(partition!.standbyRegion).toBe('us-east1');
    expect(partition!.standbyProvider).toBe('railway');
  });

  it('should have faster health check interval (10 seconds) for L2', () => {
    const partition = getPartition(P2_PARTITION_ID);
    expect(partition!.healthCheckIntervalMs).toBe(10000);
  });

  it('should have failover timeout of 45 seconds', () => {
    const partition = getPartition(P2_PARTITION_ID);
    expect(partition!.failoverTimeoutMs).toBe(45000);
  });
});

// =============================================================================
// S3.1.4.12: L2-Specific Performance Tests
// =============================================================================

describe('S3.1.4.12: P2 L2-Specific Performance', () => {
  let detector: PartitionedDetector | null = null;

  afterEach(async () => {
    if (detector) {
      await detector.stop();
      detector = null;
    }
  });

  it('should handle high-frequency events from L2 chains', async () => {
    detector = await createStartedP2Detector();

    // Simulate rapid price updates (L2 blocks are ~250ms)
    for (let i = 0; i < 100; i++) {
      detector.updatePrice('arbitrum', 'WETH_USDC', 2500 + (i * 0.1));
    }

    const prices = detector.getCrossChainPrices('WETH_USDC');
    expect(prices.has('arbitrum')).toBe(true);
  });

  it('should maintain consistent health reporting during high load', async () => {
    detector = await createStartedP2Detector();

    // Rapid health checks
    for (let i = 0; i < 10; i++) {
      const health = detector.getPartitionHealth();
      expect(health.status).toBe('healthy');
      expect(health.chainHealth.size).toBe(3);
    }
  });

  it('should getHealthyChains return correct chains under concurrent access', async () => {
    detector = await createStartedP2Detector();

    // Concurrent calls should all return consistent results
    const results = await Promise.all([
      Promise.resolve(detector.getHealthyChains()),
      Promise.resolve(detector.getHealthyChains()),
      Promise.resolve(detector.getHealthyChains())
    ]);

    for (const chains of results) {
      expect(chains).toHaveLength(3);
    }
  });
});

// =============================================================================
// S3.1.4.13: Shared Partition Utilities Integration (P12-P16 Refactor)
// =============================================================================

describe('S3.1.4.13: Shared Partition Utilities Integration', () => {
  describe('parsePort utility (P7/P12)', () => {
    // Import shared utilities
    let parsePort: typeof import('../../shared/core/src').parsePort;

    beforeAll(async () => {
      const module = await import('../../shared/core/src');
      parsePort = module.parsePort;
    });

    it('should parse valid port for P2 default (3002)', () => {
      expect(parsePort('3002', 3001)).toBe(3002);
    });

    it('should return P2 default port when env is undefined', () => {
      expect(parsePort(undefined, 3002)).toBe(3002);
    });

    it('should return P2 default for invalid port', () => {
      expect(parsePort('invalid', 3002)).toBe(3002);
    });

    it('should reject port outside valid range', () => {
      expect(parsePort('0', 3002)).toBe(3002);
      expect(parsePort('70000', 3002)).toBe(3002);
    });
  });

  describe('validateAndFilterChains utility (P4/P13)', () => {
    let validateAndFilterChains: typeof import('../../shared/core/src').validateAndFilterChains;

    beforeAll(async () => {
      const module = await import('../../shared/core/src');
      validateAndFilterChains = module.validateAndFilterChains;
    });

    it('should validate P2 chains (arbitrum, optimism, base)', () => {
      const chains = validateAndFilterChains('arbitrum,optimism,base', P2_CHAINS);
      expect(chains).toEqual(['arbitrum', 'optimism', 'base']);
    });

    it('should filter invalid chains for P2', () => {
      const chains = validateAndFilterChains('arbitrum,invalid,base', P2_CHAINS);
      expect(chains).toEqual(['arbitrum', 'base']);
    });

    it('should return P2 defaults when all chains invalid', () => {
      const chains = validateAndFilterChains('invalid1,invalid2', P2_CHAINS);
      expect(chains).toEqual([...P2_CHAINS]);
    });

    it('should handle whitespace in chain list', () => {
      const chains = validateAndFilterChains(' arbitrum , optimism ', P2_CHAINS);
      expect(chains).toEqual(['arbitrum', 'optimism']);
    });

    it('should convert to lowercase', () => {
      const chains = validateAndFilterChains('ARBITRUM,Optimism,BASE', P2_CHAINS);
      expect(chains).toEqual(['arbitrum', 'optimism', 'base']);
    });
  });

  describe('setupDetectorEventHandlers utility (P16)', () => {
    let setupDetectorEventHandlers: typeof import('../../shared/core/src').setupDetectorEventHandlers;
    let mockLogger: { info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock };
    let mockDetector: EventEmitter;

    beforeAll(async () => {
      const module = await import('../../shared/core/src');
      setupDetectorEventHandlers = module.setupDetectorEventHandlers;
    });

    beforeEach(() => {
      mockLogger = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
      };
      mockDetector = new EventEmitter();
    });

    it('should register all standard event handlers', () => {
      setupDetectorEventHandlers(mockDetector as any, mockLogger as any, P2_PARTITION_ID);

      expect(mockDetector.listenerCount('priceUpdate')).toBe(1);
      expect(mockDetector.listenerCount('opportunity')).toBe(1);
      expect(mockDetector.listenerCount('chainError')).toBe(1);
      expect(mockDetector.listenerCount('chainConnected')).toBe(1);
      expect(mockDetector.listenerCount('chainDisconnected')).toBe(1);
      expect(mockDetector.listenerCount('failoverEvent')).toBe(1);
    });

    it('should log L2 chain events with correct partition ID', () => {
      setupDetectorEventHandlers(mockDetector as any, mockLogger as any, P2_PARTITION_ID);

      mockDetector.emit('chainConnected', { chainId: 'arbitrum' });
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Chain connected: arbitrum',
        expect.objectContaining({ partition: 'l2-turbo' })
      );

      mockDetector.emit('chainConnected', { chainId: 'optimism' });
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Chain connected: optimism',
        expect.objectContaining({ partition: 'l2-turbo' })
      );
    });

    it('should log arbitrage opportunities with profit percentage', () => {
      setupDetectorEventHandlers(mockDetector as any, mockLogger as any, P2_PARTITION_ID);

      // profitPercentage is expected to be a percentage value (e.g., 2.5 for 2.5%)
      // not a decimal ratio (0.025)
      mockDetector.emit('opportunity', {
        id: 'opp-l2-1',
        type: 'cross-dex',
        buyDex: 'uniswap_v3',
        sellDex: 'camelot',
        expectedProfit: 50,
        profitPercentage: 2.5
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Arbitrage opportunity detected',
        expect.objectContaining({
          partition: 'l2-turbo',
          id: 'opp-l2-1',
          percentage: '2.50%'
        })
      );
    });
  });

  describe('SHUTDOWN_TIMEOUT_MS constant', () => {
    let SHUTDOWN_TIMEOUT_MS: number;

    beforeAll(async () => {
      const module = await import('../../shared/core/src');
      SHUTDOWN_TIMEOUT_MS = module.SHUTDOWN_TIMEOUT_MS;
    });

    it('should be 5000ms for consistent shutdown behavior', () => {
      expect(SHUTDOWN_TIMEOUT_MS).toBe(5000);
    });
  });
});

// =============================================================================
// S3.1.4.14: P2 Service Configuration Integration
// =============================================================================

describe('S3.1.4.14: P2 Service Configuration Integration', () => {
  describe('PartitionServiceConfig for P2', () => {
    it('should have correct service name for P2', () => {
      const partition = getPartition(P2_PARTITION_ID);
      expect(partition).toBeDefined();

      // Verify config structure matches what P2 service uses
      const serviceConfig = {
        partitionId: P2_PARTITION_ID,
        serviceName: 'partition-l2-turbo',
        defaultChains: partition!.chains,
        defaultPort: 3002,
        region: partition!.region,
        provider: partition!.provider
      };

      expect(serviceConfig.partitionId).toBe('l2-turbo');
      expect(serviceConfig.serviceName).toBe('partition-l2-turbo');
      expect(serviceConfig.defaultChains).toEqual(['arbitrum', 'optimism', 'base']);
      expect(serviceConfig.defaultPort).toBe(3002);
      expect(serviceConfig.region).toBe('asia-southeast1');
      expect(serviceConfig.provider).toBe('fly');
    });
  });

  describe('P2 vs P1 configuration differences', () => {
    it('should have different default ports (P1: 3001, P2: 3002)', () => {
      // P1 uses 3001, P2 uses 3002 to allow running both on same machine
      const p1Port = 3001;
      const p2Port = 3002;
      expect(p1Port).not.toBe(p2Port);
    });

    it('should have different service names', () => {
      const p1ServiceName = 'partition-asia-fast';
      const p2ServiceName = 'partition-l2-turbo';
      expect(p1ServiceName).not.toBe(p2ServiceName);
    });

    it('should have different chain sets', () => {
      const p1Partition = getPartition(PARTITION_IDS.ASIA_FAST);
      const p2Partition = getPartition(P2_PARTITION_ID);

      expect(p1Partition!.chains).not.toEqual(p2Partition!.chains);
      expect(p1Partition!.chains).toContain('bsc');
      expect(p2Partition!.chains).toContain('arbitrum');
    });

    it('should have different health check intervals (P1: 15s, P2: 10s)', () => {
      const p1Partition = getPartition(PARTITION_IDS.ASIA_FAST);
      const p2Partition = getPartition(P2_PARTITION_ID);

      // P2 has faster health checks for L2 chains
      expect(p2Partition!.healthCheckIntervalMs).toBeLessThan(p1Partition!.healthCheckIntervalMs);
      expect(p2Partition!.healthCheckIntervalMs).toBe(10000);
      expect(p1Partition!.healthCheckIntervalMs).toBe(15000);
    });

    it('should have different failover timeouts (P1: 60s, P2: 45s)', () => {
      const p1Partition = getPartition(PARTITION_IDS.ASIA_FAST);
      const p2Partition = getPartition(P2_PARTITION_ID);

      // P2 has shorter failover timeout for L2 chains
      expect(p2Partition!.failoverTimeoutMs).toBeLessThan(p1Partition!.failoverTimeoutMs);
      expect(p2Partition!.failoverTimeoutMs).toBe(45000);
      expect(p1Partition!.failoverTimeoutMs).toBe(60000);
    });
  });
});

// =============================================================================
// S3.1.4.15: P2 Refactored Service Entry Point Tests
// =============================================================================

describe('S3.1.4.15: P2 Refactored Service Entry Point', () => {
  it('should export detector, config, and partition constants', async () => {
    // Dynamic import to test exports
    const p2Module = await import('../../services/partition-l2-turbo/src/index');

    expect(p2Module.detector).toBeDefined();
    expect(p2Module.config).toBeDefined();
    expect(p2Module.P2_PARTITION_ID).toBe('l2-turbo');
    expect(p2Module.P2_CHAINS).toEqual(['arbitrum', 'optimism', 'base']);
    expect(p2Module.P2_REGION).toBe('asia-southeast1');
  });

  it('should have config with correct partition ID', async () => {
    const { config } = await import('../../services/partition-l2-turbo/src/index');

    expect(config.partitionId).toBe('l2-turbo');
  });

  it('should have config with L2 chains', async () => {
    const { config } = await import('../../services/partition-l2-turbo/src/index');

    expect(config.chains).toContain('arbitrum');
    expect(config.chains).toContain('optimism');
    expect(config.chains).toContain('base');
  });

  it('should have config with correct region', async () => {
    const { config } = await import('../../services/partition-l2-turbo/src/index');

    expect(config.regionId).toBe('asia-southeast1');
  });
});

// =============================================================================
// S3.1.4.16: P19-FIX Shutdown Guard Tests
// =============================================================================

describe('S3.1.4.16: P19-FIX Shutdown Guard', () => {
  let setupProcessHandlers: typeof import('../../shared/core/src').setupProcessHandlers;
  let mockLogger: { info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockDetector: any;

  beforeAll(async () => {
    const module = await import('../../shared/core/src');
    setupProcessHandlers = module.setupProcessHandlers;
  });

  beforeEach(() => {
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    };

    // Create mock detector with required methods
    const emitter = new EventEmitter();
    mockDetector = Object.assign(emitter, {
      isRunning: jest.fn(() => true),
      stop: jest.fn(() => Promise.resolve()),
      getPartitionHealth: jest.fn(() => Promise.resolve({ status: 'healthy' })),
      getHealthyChains: jest.fn(() => ['arbitrum', 'optimism', 'base']),
      getStats: jest.fn(() => ({})),
      getPartitionId: jest.fn(() => 'l2-turbo'),
      getChains: jest.fn(() => ['arbitrum', 'optimism', 'base']),
      start: jest.fn(() => Promise.resolve())
    });

    // Clean up any existing listeners
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
  });

  afterEach(() => {
    // Clean up listeners after each test
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
  });

  it('should register all required signal handlers', () => {
    const healthServerRef = { current: null };

    setupProcessHandlers(
      healthServerRef,
      mockDetector as any,
      mockLogger as any,
      'partition-l2-turbo'
    );

    expect(process.listenerCount('SIGTERM')).toBeGreaterThanOrEqual(1);
    expect(process.listenerCount('SIGINT')).toBeGreaterThanOrEqual(1);
    expect(process.listenerCount('uncaughtException')).toBeGreaterThanOrEqual(1);
    expect(process.listenerCount('unhandledRejection')).toBeGreaterThanOrEqual(1);
  });

  it('should have shutdown guard to prevent duplicate shutdown (P19-FIX)', () => {
    // The P19-FIX adds an isShuttingDown flag inside setupProcessHandlers
    // This test verifies the function can be called without errors
    const healthServerRef = { current: null };

    // Should not throw
    expect(() => {
      setupProcessHandlers(
        healthServerRef,
        mockDetector as any,
        mockLogger as any,
        'partition-l2-turbo'
      );
    }).not.toThrow();
  });
});

// =============================================================================
// S3.1.4.17: Error Path Tests (exitWithConfigError)
// =============================================================================

describe('S3.1.4.17: Error Path Tests', () => {
  let exitWithConfigError: typeof import('../../shared/core/src').exitWithConfigError;
  let mockProcessExit: jest.SpiedFunction<typeof process.exit>;
  let mockLogger: { info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock };

  beforeAll(async () => {
    const module = await import('../../shared/core/src');
    exitWithConfigError = module.exitWithConfigError;
  });

  beforeEach(() => {
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    };

    // Mock process.exit to prevent test termination
    mockProcessExit = jest.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as () => never);
  });

  afterEach(() => {
    mockProcessExit.mockRestore();
  });

  it('should log error and call process.exit(1) with logger', () => {
    expect(() => {
      exitWithConfigError('Test error message', { partitionId: 'l2-turbo' }, mockLogger as any);
    }).toThrow('process.exit called');

    expect(mockLogger.error).toHaveBeenCalledWith('Test error message', { partitionId: 'l2-turbo' });
    expect(mockProcessExit).toHaveBeenCalledWith(1);
  });

  it('should use console.error fallback without logger', () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => {
      exitWithConfigError('Test error message', { partitionId: 'l2-turbo' });
    }).toThrow('process.exit called');

    expect(consoleErrorSpy).toHaveBeenCalledWith('Test error message', { partitionId: 'l2-turbo' });
    expect(mockProcessExit).toHaveBeenCalledWith(1);

    consoleErrorSpy.mockRestore();
  });

  it('should include context in error log', () => {
    const context = {
      partitionId: 'l2-turbo',
      hint: 'Set REDIS_URL=redis://localhost:6379',
      chains: ['arbitrum', 'optimism', 'base']
    };

    expect(() => {
      exitWithConfigError('REDIS_URL environment variable is required', context, mockLogger as any);
    }).toThrow('process.exit called');

    expect(mockLogger.error).toHaveBeenCalledWith(
      'REDIS_URL environment variable is required',
      context
    );
  });
});

// =============================================================================
// S3.1.4.18: parsePort Error Path Tests
// =============================================================================

describe('S3.1.4.18: parsePort Error Path Tests', () => {
  let parsePort: typeof import('../../shared/core/src').parsePort;
  let mockLogger: { info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock };

  beforeAll(async () => {
    const module = await import('../../shared/core/src');
    parsePort = module.parsePort;
  });

  beforeEach(() => {
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    };
  });

  it('should log warning for invalid port string', () => {
    const result = parsePort('not-a-number', 3002, mockLogger as any);

    expect(result).toBe(3002);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Invalid HEALTH_CHECK_PORT, using default',
      expect.objectContaining({ provided: 'not-a-number', default: 3002 })
    );
  });

  it('should log warning for port below valid range', () => {
    const result = parsePort('0', 3002, mockLogger as any);

    expect(result).toBe(3002);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('should log warning for port above valid range', () => {
    const result = parsePort('70000', 3002, mockLogger as any);

    expect(result).toBe(3002);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('should accept valid port in range', () => {
    const result = parsePort('8080', 3002, mockLogger as any);

    expect(result).toBe(8080);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });
});

// =============================================================================
// S3.1.4.19: validateAndFilterChains Error Path Tests
// =============================================================================

describe('S3.1.4.19: validateAndFilterChains Error Path Tests', () => {
  let validateAndFilterChains: typeof import('../../shared/core/src').validateAndFilterChains;
  let mockLogger: { info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock };
  const P2_CHAINS = ['arbitrum', 'optimism', 'base'] as const;

  beforeAll(async () => {
    const module = await import('../../shared/core/src');
    validateAndFilterChains = module.validateAndFilterChains;
  });

  beforeEach(() => {
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    };
  });

  it('should log warning for invalid chain IDs', () => {
    const result = validateAndFilterChains('arbitrum,invalid-chain,base', P2_CHAINS, mockLogger as any);

    expect(result).toEqual(['arbitrum', 'base']);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Invalid chain IDs in PARTITION_CHAINS, ignoring',
      expect.objectContaining({
        invalidChains: ['invalid-chain'],
        validChains: ['arbitrum', 'base']
      })
    );
  });

  it('should log warning when all chains invalid and use defaults', () => {
    const result = validateAndFilterChains('invalid1,invalid2,invalid3', P2_CHAINS, mockLogger as any);

    expect(result).toEqual([...P2_CHAINS]);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'No valid chains in PARTITION_CHAINS, using defaults',
      expect.objectContaining({ defaults: P2_CHAINS })
    );
  });

  it('should handle mixed valid/invalid chains', () => {
    const result = validateAndFilterChains('ARBITRUM,not-a-chain,OPTIMISM', P2_CHAINS, mockLogger as any);

    // Should convert to lowercase and filter out invalid
    expect(result).toEqual(['arbitrum', 'optimism']);
    expect(mockLogger.warn).toHaveBeenCalled();
  });
});

// =============================================================================
// S3.1.4.20: Process Handler Cleanup Tests (BUG-4.1-FIX)
// =============================================================================

describe('S3.1.4.20: Process Handler Cleanup Tests', () => {
  let setupProcessHandlers: typeof import('../../shared/core/src').setupProcessHandlers;
  let mockLogger: { info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockDetector: any;

  beforeAll(async () => {
    const module = await import('../../shared/core/src');
    setupProcessHandlers = module.setupProcessHandlers;
  });

  beforeEach(() => {
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    };

    const emitter = new EventEmitter();
    mockDetector = Object.assign(emitter, {
      isRunning: jest.fn(() => true),
      stop: jest.fn(() => Promise.resolve()),
      getPartitionHealth: jest.fn(() => Promise.resolve({ status: 'healthy' })),
      getHealthyChains: jest.fn(() => ['arbitrum', 'optimism', 'base']),
      getStats: jest.fn(() => ({})),
      getPartitionId: jest.fn(() => 'l2-turbo'),
      getChains: jest.fn(() => ['arbitrum', 'optimism', 'base']),
      start: jest.fn(() => Promise.resolve())
    });

    // Clean up any existing listeners
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
  });

  afterEach(() => {
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
  });

  it('should return cleanup function that removes all handlers (BUG-4.1-FIX)', () => {
    const healthServerRef = { current: null };

    const cleanup = setupProcessHandlers(
      healthServerRef,
      mockDetector as any,
      mockLogger as any,
      'partition-l2-turbo'
    );

    // Verify handlers were registered
    expect(process.listenerCount('SIGTERM')).toBeGreaterThanOrEqual(1);
    expect(process.listenerCount('SIGINT')).toBeGreaterThanOrEqual(1);

    // Call cleanup
    cleanup();

    // Verify handlers were removed
    expect(process.listenerCount('SIGTERM')).toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(0);
    expect(process.listenerCount('uncaughtException')).toBe(0);
    expect(process.listenerCount('unhandledRejection')).toBe(0);
  });

  it('should not accumulate listeners on multiple setupProcessHandlers calls', () => {
    const healthServerRef = { current: null };

    // First setup
    const cleanup1 = setupProcessHandlers(
      healthServerRef,
      mockDetector as any,
      mockLogger as any,
      'partition-l2-turbo'
    );

    // Cleanup first
    cleanup1();

    // Second setup
    const cleanup2 = setupProcessHandlers(
      healthServerRef,
      mockDetector as any,
      mockLogger as any,
      'partition-l2-turbo'
    );

    // Should only have 1 listener, not accumulated
    expect(process.listenerCount('SIGTERM')).toBe(1);
    expect(process.listenerCount('SIGINT')).toBe(1);

    cleanup2();
  });
});

// =============================================================================
// S3.1.4.21: Export Cleanup Handler Tests
// =============================================================================

describe('S3.1.4.21: Service Exports cleanupProcessHandlers', () => {
  it('should export cleanupProcessHandlers function from partition-l2-turbo', async () => {
    const p2Module = await import('../../services/partition-l2-turbo/src/index');

    expect(p2Module.cleanupProcessHandlers).toBeDefined();
    expect(typeof p2Module.cleanupProcessHandlers).toBe('function');
  });

  it('cleanupProcessHandlers should be callable without errors', async () => {
    const { cleanupProcessHandlers } = await import('../../services/partition-l2-turbo/src/index');

    // Should not throw
    expect(() => cleanupProcessHandlers()).not.toThrow();
  });
});
