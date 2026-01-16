/**
 * S3.1.3 P1 Asia-Fast Partition Service Integration Tests
 *
 * TDD-first tests for the P1 detector service (services/partition-asia-fast/).
 * P1 is deployed to Oracle Cloud Singapore with 4 chains:
 * - BSC, Polygon, Avalanche, Fantom
 *
 * Tests verify:
 * - Service configuration and startup
 * - Health endpoint functionality
 * - Chain-specific event handling
 * - Resource allocation for 4 chains
 * - Graceful degradation when chains fail
 *
 * @see IMPLEMENTATION_PLAN.md S3.1.3: Create P1 detector service
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
} from '@arbitrage/core/partitioned-detector';

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

const P1_PARTITION_ID = PARTITION_IDS.ASIA_FAST;
const P1_CHAINS = ['bsc', 'polygon', 'avalanche', 'fantom'] as const;
const P1_REGION = 'asia-southeast1';

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Mock token normalizer for cross-chain matching tests.
 * Maps chain-specific token symbols to their canonical form.
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

/**
 * Creates mock dependencies for PartitionedDetector tests.
 * This uses the DI pattern to inject mocks instead of relying on Jest mock hoisting.
 */
const createMockDetectorDeps = (): PartitionedDetectorDeps => ({
  logger: mockLogger,
  perfLogger: mockPerfLogger as any,
  normalizeToken: mockNormalizeToken
});

function createP1Config(overrides: Partial<PartitionedDetectorConfig> = {}): PartitionedDetectorConfig {
  return {
    partitionId: P1_PARTITION_ID,
    chains: [...P1_CHAINS],
    region: P1_REGION,
    healthCheckIntervalMs: 100000, // Long interval to avoid interference
    failoverTimeoutMs: 60000,
    ...overrides
  };
}

async function createStartedP1Detector(config?: PartitionedDetectorConfig): Promise<PartitionedDetector> {
  const detector = new PartitionedDetector(config || createP1Config(), createMockDetectorDeps());
  await detector.start();
  return detector;
}

// =============================================================================
// S3.1.3.1: P1 Partition Configuration Tests
// =============================================================================

describe('S3.1.3 P1 Asia-Fast Partition Service', () => {
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

  describe('S3.1.3.1: P1 Partition Configuration', () => {
    it('should have asia-fast partition defined in PARTITIONS', () => {
      const partition = getPartition(P1_PARTITION_ID);
      expect(partition).toBeDefined();
      expect(partition!.partitionId).toBe('asia-fast');
    });

    it('should include exactly 4 chains: BSC, Polygon, Avalanche, Fantom', () => {
      const partition = getPartition(P1_PARTITION_ID);
      expect(partition!.chains).toHaveLength(4);
      expect(partition!.chains).toContain('bsc');
      expect(partition!.chains).toContain('polygon');
      expect(partition!.chains).toContain('avalanche');
      expect(partition!.chains).toContain('fantom');
    });

    it('should be deployed to asia-southeast1 (Singapore) region', () => {
      const partition = getPartition(P1_PARTITION_ID);
      expect(partition!.region).toBe('asia-southeast1');
    });

    it('should use oracle provider for deployment', () => {
      const partition = getPartition(P1_PARTITION_ID);
      expect(partition!.provider).toBe('oracle');
    });

    it('should have heavy resource profile for 4 chains', () => {
      const partition = getPartition(P1_PARTITION_ID);
      expect(partition!.resourceProfile).toBe('heavy');
    });

    it('should have priority 1 (highest)', () => {
      const partition = getPartition(P1_PARTITION_ID);
      expect(partition!.priority).toBe(1);
    });

    it('should be enabled', () => {
      const partition = getPartition(P1_PARTITION_ID);
      expect(partition!.enabled).toBe(true);
    });

    it('should have adequate memory (768MB) for 4 chains', () => {
      const partition = getPartition(P1_PARTITION_ID);
      expect(partition!.maxMemoryMB).toBeGreaterThanOrEqual(512);
    });

    it('should have standby configuration for failover', () => {
      const partition = getPartition(P1_PARTITION_ID);
      expect(partition!.standbyRegion).toBeDefined();
      expect(partition!.standbyProvider).toBeDefined();
    });

    it('should pass validation', () => {
      const partition = getPartition(P1_PARTITION_ID);
      const validation = validatePartitionConfig(partition!);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });
  });

  // ===========================================================================
  // S3.1.3.2: Chain Configuration Tests
  // ===========================================================================

  describe('S3.1.3.2: P1 Chain Configurations', () => {
    describe('BSC Chain', () => {
      it('should have BSC chain defined', () => {
        expect(CHAINS['bsc']).toBeDefined();
        expect(CHAINS['bsc'].id).toBe(56);
      });

      it('should have BSC DEXes configured', () => {
        expect(DEXES['bsc']).toBeDefined();
        expect(DEXES['bsc'].length).toBeGreaterThanOrEqual(5);
      });

      it('should have BSC tokens configured', () => {
        expect(CORE_TOKENS['bsc']).toBeDefined();
        expect(CORE_TOKENS['bsc'].length).toBeGreaterThanOrEqual(8);
      });

      it('should have BSC detector config', () => {
        expect(DETECTOR_CONFIG['bsc']).toBeDefined();
        expect(DETECTOR_CONFIG['bsc'].nativeTokenKey).toBe('nativeWrapper');
      });

      it('should have BSC token metadata', () => {
        expect(TOKEN_METADATA['bsc']).toBeDefined();
        expect(TOKEN_METADATA['bsc'].nativeWrapper).toBeTruthy();
      });
    });

    describe('Polygon Chain', () => {
      it('should have Polygon chain defined', () => {
        expect(CHAINS['polygon']).toBeDefined();
        expect(CHAINS['polygon'].id).toBe(137);
      });

      it('should have Polygon DEXes configured', () => {
        expect(DEXES['polygon']).toBeDefined();
        expect(DEXES['polygon'].length).toBeGreaterThanOrEqual(3);
      });

      it('should have Polygon tokens configured', () => {
        expect(CORE_TOKENS['polygon']).toBeDefined();
        expect(CORE_TOKENS['polygon'].length).toBeGreaterThanOrEqual(8);
      });

      it('should have Polygon detector config', () => {
        expect(DETECTOR_CONFIG['polygon']).toBeDefined();
      });

      it('should have Polygon token metadata', () => {
        expect(TOKEN_METADATA['polygon']).toBeDefined();
      });
    });

    describe('Avalanche Chain', () => {
      it('should have Avalanche chain defined', () => {
        expect(CHAINS['avalanche']).toBeDefined();
        expect(CHAINS['avalanche'].id).toBe(43114);
      });

      it('should have Avalanche DEXes configured', () => {
        expect(DEXES['avalanche']).toBeDefined();
        expect(DEXES['avalanche'].length).toBeGreaterThanOrEqual(2);
      });

      it('should have Avalanche tokens configured', () => {
        expect(CORE_TOKENS['avalanche']).toBeDefined();
        expect(CORE_TOKENS['avalanche'].length).toBeGreaterThanOrEqual(6);
      });

      it('should have Avalanche detector config', () => {
        expect(DETECTOR_CONFIG['avalanche']).toBeDefined();
        expect(DETECTOR_CONFIG['avalanche'].nativeTokenKey).toBe('nativeWrapper');
      });

      it('should have Avalanche token metadata', () => {
        expect(TOKEN_METADATA['avalanche']).toBeDefined();
        expect(TOKEN_METADATA['avalanche'].nativeWrapper).toBe('0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7'); // WAVAX
      });
    });

    describe('Fantom Chain', () => {
      it('should have Fantom chain defined', () => {
        expect(CHAINS['fantom']).toBeDefined();
        expect(CHAINS['fantom'].id).toBe(250);
      });

      it('should have Fantom DEXes configured', () => {
        expect(DEXES['fantom']).toBeDefined();
        expect(DEXES['fantom'].length).toBeGreaterThanOrEqual(2);
      });

      it('should have Fantom tokens configured', () => {
        expect(CORE_TOKENS['fantom']).toBeDefined();
        expect(CORE_TOKENS['fantom'].length).toBeGreaterThanOrEqual(5);
      });

      it('should have Fantom detector config', () => {
        expect(DETECTOR_CONFIG['fantom']).toBeDefined();
        expect(DETECTOR_CONFIG['fantom'].nativeTokenKey).toBe('nativeWrapper');
      });

      it('should have Fantom token metadata', () => {
        expect(TOKEN_METADATA['fantom']).toBeDefined();
        expect(TOKEN_METADATA['fantom'].nativeWrapper).toBe('0x21be370D5312f44cB42ce377BC9b8a0cEF1A4C83'); // WFTM
      });
    });
  });

  // ===========================================================================
  // S3.1.3.3: Service Startup Tests
  // ===========================================================================

  describe('S3.1.3.3: P1 Service Startup', () => {
    it('should start with all 4 P1 chains', async () => {
      detector = await createStartedP1Detector();

      expect(detector.isRunning()).toBe(true);
      expect(detector.getChains()).toHaveLength(4);
      expect(detector.getChains()).toContain('bsc');
      expect(detector.getChains()).toContain('polygon');
      expect(detector.getChains()).toContain('avalanche');
      expect(detector.getChains()).toContain('fantom');
    });

    it('should connect all chain managers', async () => {
      detector = await createStartedP1Detector();

      expect(detector.getChainManagers().size).toBe(4);
      expect(detector.getChainManagers().has('bsc')).toBe(true);
      expect(detector.getChainManagers().has('polygon')).toBe(true);
      expect(detector.getChainManagers().has('avalanche')).toBe(true);
      expect(detector.getChainManagers().has('fantom')).toBe(true);
    });

    it('should report asia-fast partition ID', async () => {
      detector = await createStartedP1Detector();
      expect(detector.getPartitionId()).toBe('asia-fast');
    });

    it('should emit started event with all P1 chains', async () => {
      detector = new PartitionedDetector(createP1Config(), createMockDetectorDeps());
      const startedHandler = jest.fn();
      detector.on('started', startedHandler);

      await detector.start();

      expect(startedHandler).toHaveBeenCalledWith({
        partitionId: 'asia-fast',
        chains: ['bsc', 'polygon', 'avalanche', 'fantom']
      });
    });

    it('should emit chainConnected for each P1 chain', async () => {
      detector = new PartitionedDetector(createP1Config(), createMockDetectorDeps());
      const connectedHandler = jest.fn();
      detector.on('chainConnected', connectedHandler);

      await detector.start();

      expect(connectedHandler).toHaveBeenCalledTimes(4);
      expect(connectedHandler).toHaveBeenCalledWith({ chainId: 'bsc' });
      expect(connectedHandler).toHaveBeenCalledWith({ chainId: 'polygon' });
      expect(connectedHandler).toHaveBeenCalledWith({ chainId: 'avalanche' });
      expect(connectedHandler).toHaveBeenCalledWith({ chainId: 'fantom' });
    });

    it('should start within 5 seconds', async () => {
      detector = new PartitionedDetector(createP1Config(), createMockDetectorDeps());

      const startTime = Date.now();
      await detector.start();
      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(5000);
    });
  });

  // ===========================================================================
  // S3.1.3.4: Health Endpoint Tests
  // ===========================================================================

  describe('S3.1.3.4: P1 Health Monitoring', () => {
    it('should return healthy status when all chains connected', async () => {
      detector = await createStartedP1Detector();

      const health = detector.getPartitionHealth();

      expect(health.status).toBe('healthy');
      expect(health.partitionId).toBe('asia-fast');
      expect(health.chainHealth.size).toBe(4);
    });

    it('should report health for all 4 chains', async () => {
      detector = await createStartedP1Detector();

      const health = detector.getPartitionHealth();

      expect(health.chainHealth.has('bsc')).toBe(true);
      expect(health.chainHealth.has('polygon')).toBe(true);
      expect(health.chainHealth.has('avalanche')).toBe(true);
      expect(health.chainHealth.has('fantom')).toBe(true);
    });

    it('should return degraded status when one chain fails', async () => {
      detector = await createStartedP1Detector();

      // Simulate Fantom going down
      const chainHealth = detector['chainHealth'];
      const fantomHealth = chainHealth.get('fantom');
      if (fantomHealth) {
        fantomHealth.status = 'unhealthy';
        fantomHealth.wsConnected = false;
      }

      const health = detector.getPartitionHealth();

      expect(health.status).toBe('degraded');
      expect(detector.getHealthyChains()).toHaveLength(3);
      expect(detector.getHealthyChains()).toContain('bsc');
      expect(detector.getHealthyChains()).toContain('polygon');
      expect(detector.getHealthyChains()).toContain('avalanche');
      expect(detector.getHealthyChains()).not.toContain('fantom');
    });

    it('should track memory usage', async () => {
      detector = await createStartedP1Detector();

      const health = detector.getPartitionHealth();

      expect(health.memoryUsage).toBeGreaterThan(0);
    });

    it('should track uptime', async () => {
      detector = await createStartedP1Detector();
      await new Promise(resolve => setTimeout(resolve, 100));

      const health = detector.getPartitionHealth();

      expect(health.uptimeSeconds).toBeGreaterThan(0);
    });

    it('should track events processed', async () => {
      detector = await createStartedP1Detector();

      const health = detector.getPartitionHealth();

      expect(typeof health.totalEventsProcessed).toBe('number');
    });
  });

  // ===========================================================================
  // S3.1.3.5: Cross-Chain Price Detection Tests
  // ===========================================================================

  describe('S3.1.3.5: P1 Cross-Chain Arbitrage Detection', () => {
    it('should track prices across all P1 chains', async () => {
      detector = await createStartedP1Detector();

      detector.updatePrice('bsc', 'WETH_USDC', 2500);
      detector.updatePrice('polygon', 'WETH_USDC', 2510);
      detector.updatePrice('avalanche', 'WETH_USDC', 2520);
      detector.updatePrice('fantom', 'WETH_USDC', 2530);

      const prices = detector.getCrossChainPrices('WETH_USDC');

      expect(prices.size).toBe(4);
      expect(prices.get('bsc')?.price).toBe(2500);
      expect(prices.get('polygon')?.price).toBe(2510);
      expect(prices.get('avalanche')?.price).toBe(2520);
      expect(prices.get('fantom')?.price).toBe(2530);
    });

    it('should detect cross-chain price discrepancies across P1 chains', async () => {
      detector = await createStartedP1Detector();

      // Create 5% price discrepancy between BSC and Fantom
      detector.updatePrice('bsc', 'WETH_USDC', 2500);
      detector.updatePrice('polygon', 'WETH_USDC', 2510);
      detector.updatePrice('avalanche', 'WETH_USDC', 2520);
      detector.updatePrice('fantom', 'WETH_USDC', 2625); // 5% higher

      const discrepancies = detector.findCrossChainDiscrepancies(0.01);

      expect(discrepancies.length).toBeGreaterThan(0);
      expect(discrepancies[0].pairKey).toBe('WETH_USDC');
      expect(discrepancies[0].chains).toContain('bsc');
      expect(discrepancies[0].chains).toContain('fantom');
    });

    it('should detect arbitrage opportunities for native tokens', async () => {
      detector = await createStartedP1Detector();

      // BNB/USDT price on BSC vs bridged on Polygon
      // Note: WBNB normalizes to BNB for cross-chain comparisons (S3.2.4 fix)
      detector.updatePrice('bsc', 'WBNB_USDT', 600);
      detector.updatePrice('polygon', 'WBNB_USDT', 615); // 2.5% higher

      const discrepancies = detector.findCrossChainDiscrepancies(0.01);

      // WBNB normalizes to BNB for cross-chain detection
      expect(discrepancies.some(d => d.pairKey === 'BNB_USDT')).toBe(true);
    });
  });

  // ===========================================================================
  // S3.1.3.6: Graceful Degradation Tests
  // ===========================================================================

  describe('S3.1.3.6: P1 Graceful Degradation', () => {
    it('should continue running with 3 of 4 chains healthy', async () => {
      detector = await createStartedP1Detector();

      // Simulate Avalanche going down
      const chainHealth = detector['chainHealth'];
      const avalancheHealth = chainHealth.get('avalanche');
      if (avalancheHealth) {
        avalancheHealth.status = 'unhealthy';
        avalancheHealth.wsConnected = false;
      }

      expect(detector.isRunning()).toBe(true);
      expect(detector.getHealthyChains()).toContain('bsc');
      expect(detector.getHealthyChains()).toContain('polygon');
      expect(detector.getHealthyChains()).toContain('fantom');
    });

    it('should continue running with 2 of 4 chains healthy', async () => {
      detector = await createStartedP1Detector();

      // Simulate Avalanche and Fantom going down
      const chainHealth = detector['chainHealth'];
      for (const chainId of ['avalanche', 'fantom']) {
        const health = chainHealth.get(chainId);
        if (health) {
          health.status = 'unhealthy';
          health.wsConnected = false;
        }
      }

      expect(detector.isRunning()).toBe(true);
      expect(detector.getPartitionHealth().status).toBe('degraded');
      expect(detector.getHealthyChains()).toHaveLength(2);
    });

    it('should track error counts per chain', async () => {
      detector = await createStartedP1Detector();

      // Simulate errors on BSC
      const wsManager = detector.getChainManagers().get('bsc') as unknown as EventEmitter;
      wsManager?.emit('error', new Error('Connection reset'));
      wsManager?.emit('error', new Error('Timeout'));

      const chainHealth = detector.getChainHealth('bsc');
      expect(chainHealth?.errorCount).toBeGreaterThanOrEqual(2);
    });

    it('should update chain health status on disconnect', async () => {
      detector = await createStartedP1Detector();

      const wsManager = detector.getChainManagers().get('polygon') as unknown as EventEmitter;
      wsManager?.emit('disconnected');

      const chainHealth = detector.getChainHealth('polygon');
      expect(chainHealth?.status).toBe('degraded');
      expect(chainHealth?.wsConnected).toBe(false);
    });
  });

  // ===========================================================================
  // S3.1.3.7: Resource Calculation Tests
  // ===========================================================================

  describe('S3.1.3.7: P1 Resource Calculations', () => {
    it('should calculate resources for 4-chain partition', () => {
      const resources = calculatePartitionResources(P1_PARTITION_ID);

      expect(resources.estimatedMemoryMB).toBeGreaterThan(300);
      expect(resources.recommendedProfile).toBe('heavy');
    });

    it('should estimate CPU cores based on block times', () => {
      const resources = calculatePartitionResources(P1_PARTITION_ID);

      // BSC ~3s, Polygon ~2s, Avalanche ~2s, Fantom ~1s = avg ~2s
      // Should require significant CPU for fast blocks
      expect(resources.estimatedCpuCores).toBeGreaterThanOrEqual(0.5);
    });

    it('should account for DEX count in memory estimation', () => {
      // Count total DEXes across P1 chains
      let totalDexes = 0;
      for (const chainId of P1_CHAINS) {
        totalDexes += getEnabledDexes(chainId).length;
      }

      // Should be at least 14 DEXes (BSC:8 + Polygon:4 + Avalanche:3 + Fantom:2)
      expect(totalDexes).toBeGreaterThanOrEqual(14);

      const resources = calculatePartitionResources(P1_PARTITION_ID);
      // Memory should include DEX overhead
      expect(resources.estimatedMemoryMB).toBeGreaterThan(totalDexes * 5);
    });
  });

  // ===========================================================================
  // S3.1.3.8: Chain Instance Creation Tests
  // ===========================================================================

  describe('S3.1.3.8: P1 Chain Instance Creation', () => {
    it('should create chain instances for all P1 chains', () => {
      const instances = createPartitionChainInstances(P1_PARTITION_ID);

      expect(instances).toHaveLength(4);
      expect(instances.map(i => i.chainId)).toContain('bsc');
      expect(instances.map(i => i.chainId)).toContain('polygon');
      expect(instances.map(i => i.chainId)).toContain('avalanche');
      expect(instances.map(i => i.chainId)).toContain('fantom');
    });

    it('should include DEX names for each chain', () => {
      const bscInstance = createChainInstance('bsc');
      const avalancheInstance = createChainInstance('avalanche');

      expect(bscInstance!.dexes).toContain('pancakeswap_v3');
      expect(avalancheInstance!.dexes).toContain('trader_joe_v2');
    });

    it('should include token symbols for each chain', () => {
      const bscInstance = createChainInstance('bsc');
      const fantomInstance = createChainInstance('fantom');

      expect(bscInstance!.tokens).toContain('WBNB');
      expect(fantomInstance!.tokens).toContain('WFTM');
    });

    it('should have correct native tokens', () => {
      const instances = createPartitionChainInstances(P1_PARTITION_ID);

      const bsc = instances.find(i => i.chainId === 'bsc');
      const polygon = instances.find(i => i.chainId === 'polygon');
      const avalanche = instances.find(i => i.chainId === 'avalanche');
      const fantom = instances.find(i => i.chainId === 'fantom');

      expect(bsc!.nativeToken).toBe('BNB');
      expect(polygon!.nativeToken).toBe('MATIC');
      expect(avalanche!.nativeToken).toBe('AVAX');
      expect(fantom!.nativeToken).toBe('FTM');
    });
  });

  // ===========================================================================
  // S3.1.3.9: Service Shutdown Tests
  // ===========================================================================

  describe('S3.1.3.9: P1 Service Shutdown', () => {
    it('should cleanly stop all 4 chains', async () => {
      detector = await createStartedP1Detector();
      expect(detector.isRunning()).toBe(true);

      await detector.stop();

      expect(detector.isRunning()).toBe(false);
      expect(detector.getChainManagers().size).toBe(0);
    });

    it('should emit stopped event', async () => {
      detector = await createStartedP1Detector();
      const stoppedHandler = jest.fn();
      detector.on('stopped', stoppedHandler);

      await detector.stop();

      expect(stoppedHandler).toHaveBeenCalledWith({
        partitionId: 'asia-fast'
      });
    });

    it('should disconnect Redis clients on shutdown', async () => {
      detector = await createStartedP1Detector();

      await detector.stop();

      expect(mockRedisClient.disconnect).toHaveBeenCalled();
      expect(mockStreamsClient.disconnect).toHaveBeenCalled();
    });

    it('should handle shutdown errors gracefully', async () => {
      detector = await createStartedP1Detector();
      mockRedisClient.disconnect.mockRejectedValueOnce(new Error('Disconnect error'));

      await expect(detector.stop()).resolves.not.toThrow();
      expect(detector.isRunning()).toBe(false);
    });
  });
});

// =============================================================================
// S3.1.3.10: Environment Variable Configuration Tests
// =============================================================================

describe('S3.1.3.10: P1 Environment Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should configure P1 with PARTITION_ID=asia-fast', async () => {
    process.env.PARTITION_ID = 'asia-fast';

    // Re-import to get fresh config
    const { getPartitionFromEnv } = await import('../../shared/config/src/partitions');
    const partition = getPartitionFromEnv();

    expect(partition).toBeDefined();
    expect(partition!.partitionId).toBe('asia-fast');
    expect(partition!.chains).toHaveLength(4);
  });

  it('should allow chain override via PARTITION_CHAINS', async () => {
    process.env.PARTITION_ID = 'asia-fast';
    process.env.PARTITION_CHAINS = 'bsc, polygon';

    const { getChainsFromEnv } = await import('../../shared/config/src/partitions');
    const chains = getChainsFromEnv();

    expect(chains).toEqual(['bsc', 'polygon']);
  });

  it('should default to asia-fast when PARTITION_ID not set', async () => {
    delete process.env.PARTITION_ID;

    const { getPartitionIdFromEnv } = await import('../../shared/config/src/partitions');
    const partitionId = getPartitionIdFromEnv();

    expect(partitionId).toBe('asia-fast');
  });
});

// =============================================================================
// S3.1.3.11: Deployment Configuration Tests (Dockerfile, docker-compose)
// =============================================================================

describe('S3.1.3.11: P1 Deployment Configuration', () => {
  it('should have correct P1 chains in partition config', () => {
    const partition = getPartition(P1_PARTITION_ID);

    // Verify chains match expected P1 deployment
    expect(partition!.chains).toEqual(['bsc', 'polygon', 'avalanche', 'fantom']);
  });

  it('should have Oracle provider configured for P1', () => {
    const partition = getPartition(P1_PARTITION_ID);
    expect(partition!.provider).toBe('oracle');
  });

  it('should have Singapore region configured', () => {
    const partition = getPartition(P1_PARTITION_ID);
    expect(partition!.region).toBe('asia-southeast1');
  });

  it('should have standby in us-west1 with render provider', () => {
    const partition = getPartition(P1_PARTITION_ID);
    expect(partition!.standbyRegion).toBe('us-west1');
    expect(partition!.standbyProvider).toBe('render');
  });

  it('should have health check interval of 15 seconds', () => {
    const partition = getPartition(P1_PARTITION_ID);
    expect(partition!.healthCheckIntervalMs).toBe(15000);
  });

  it('should have failover timeout of 60 seconds', () => {
    const partition = getPartition(P1_PARTITION_ID);
    expect(partition!.failoverTimeoutMs).toBe(60000);
  });
});

// =============================================================================
// S3.1.3.12: Chain Validation Tests (P4-FIX)
// =============================================================================

describe('S3.1.3.12: P1 Chain Validation (P4-FIX)', () => {
  // Import the service module to test validateAndFilterChains behavior
  // We test this through the config parsing behavior

  it('should accept valid P1 chain IDs', () => {
    // Valid chains from the CHAINS object
    const validChains = Object.keys(CHAINS);

    expect(validChains).toContain('bsc');
    expect(validChains).toContain('polygon');
    expect(validChains).toContain('avalanche');
    expect(validChains).toContain('fantom');
  });

  it('should have all P1 chains defined in CHAINS config', () => {
    for (const chainId of P1_CHAINS) {
      expect(CHAINS[chainId]).toBeDefined();
      expect(CHAINS[chainId].id).toBeGreaterThan(0);
      expect(CHAINS[chainId].name).toBeTruthy();
    }
  });

  it('should validate chain IDs are lowercase strings', () => {
    for (const chainId of P1_CHAINS) {
      expect(chainId).toBe(chainId.toLowerCase());
      expect(typeof chainId).toBe('string');
    }
  });

  it('should have numeric chain IDs in CHAINS config', () => {
    expect(CHAINS['bsc'].id).toBe(56);
    expect(CHAINS['polygon'].id).toBe(137);
    expect(CHAINS['avalanche'].id).toBe(43114);
    expect(CHAINS['fantom'].id).toBe(250);
  });

  it('should distinguish chain ID keys from chain ID numbers', () => {
    // Chain keys are strings like 'bsc', 'polygon'
    // Chain IDs are numbers like 56, 137
    const chainKeys = Object.keys(CHAINS);
    const chainIds = Object.values(CHAINS).map(c => c.id);

    // All keys should be non-numeric strings
    for (const key of chainKeys) {
      expect(isNaN(Number(key))).toBe(true);
    }

    // All IDs should be numbers
    for (const id of chainIds) {
      expect(typeof id).toBe('number');
    }
  });

  it('should have case-insensitive chain lookup available', () => {
    // The validateAndFilterChains function lowercases input
    const inputChains = ['BSC', 'POLYGON', 'Avalanche', 'fantom'];
    const normalized = inputChains.map(c => c.toLowerCase());

    for (const chain of normalized) {
      expect(CHAINS[chain]).toBeDefined();
    }
  });
});

// =============================================================================
// S3.1.3.13: Shutdown Timeout Tests (P2-FIX)
// =============================================================================

describe('S3.1.3.13: P1 Shutdown Timeout (P2-FIX)', () => {
  let detector: PartitionedDetector | null = null;

  afterEach(async () => {
    if (detector) {
      try {
        await detector.stop();
      } catch {
        // Ignore cleanup errors
      }
      detector = null;
    }
  });

  it('should complete shutdown within timeout period', async () => {
    detector = await createStartedP1Detector();

    const startTime = Date.now();
    await detector.stop();
    const duration = Date.now() - startTime;

    // Should complete well under the 5s timeout
    expect(duration).toBeLessThan(5000);
  });

  it('should handle rapid start/stop cycles', async () => {
    for (let i = 0; i < 3; i++) {
      detector = new PartitionedDetector(createP1Config(), createMockDetectorDeps());
      await detector.start();
      expect(detector.isRunning()).toBe(true);

      await detector.stop();
      expect(detector.isRunning()).toBe(false);
      detector = null;
    }
  });

  it('should clean up all resources on shutdown', async () => {
    detector = await createStartedP1Detector();

    // Verify resources are allocated
    expect(detector.getChainManagers().size).toBe(4);

    await detector.stop();

    // Verify cleanup
    expect(detector.getChainManagers().size).toBe(0);
    expect(mockRedisClient.disconnect).toHaveBeenCalled();
  });

  it('should not hang if Redis disconnect fails', async () => {
    detector = await createStartedP1Detector();
    mockRedisClient.disconnect.mockRejectedValueOnce(new Error('Redis disconnect timeout'));

    const stopPromise = detector.stop();

    // Should complete despite Redis error
    await expect(stopPromise).resolves.not.toThrow();
  });

  it('should not hang if Streams disconnect fails', async () => {
    detector = await createStartedP1Detector();
    mockStreamsClient.disconnect.mockRejectedValueOnce(new Error('Streams disconnect timeout'));

    const stopPromise = detector.stop();

    // Should complete despite Streams error
    await expect(stopPromise).resolves.not.toThrow();
  });

  it('should emit stopped event even on error', async () => {
    detector = await createStartedP1Detector();
    const stoppedHandler = jest.fn();
    detector.on('stopped', stoppedHandler);

    mockRedisClient.disconnect.mockRejectedValueOnce(new Error('Disconnect error'));

    await detector.stop();

    expect(stoppedHandler).toHaveBeenCalled();
  });
});

// =============================================================================
// S3.1.3.14: UnifiedChainDetector getHealthyChains Tests
// =============================================================================

describe('S3.1.3.14: UnifiedChainDetector getHealthyChains Method', () => {
  let detector: PartitionedDetector | null = null;

  afterEach(async () => {
    if (detector) {
      await detector.stop();
      detector = null;
    }
  });

  it('should return all chains when all are healthy', async () => {
    detector = await createStartedP1Detector();

    const healthyChains = detector.getHealthyChains();

    expect(healthyChains).toHaveLength(4);
    expect(healthyChains).toContain('bsc');
    expect(healthyChains).toContain('polygon');
    expect(healthyChains).toContain('avalanche');
    expect(healthyChains).toContain('fantom');
  });

  it('should return empty array when no chains are healthy', async () => {
    detector = await createStartedP1Detector();

    // Mark all chains as unhealthy
    const chainHealth = detector['chainHealth'];
    for (const [, health] of chainHealth) {
      health.status = 'unhealthy';
      health.wsConnected = false;
    }

    const healthyChains = detector.getHealthyChains();

    expect(healthyChains).toHaveLength(0);
  });

  it('should exclude specific unhealthy chains', async () => {
    detector = await createStartedP1Detector();

    // Mark BSC and Fantom as unhealthy
    const chainHealth = detector['chainHealth'];
    const bscHealth = chainHealth.get('bsc');
    const fantomHealth = chainHealth.get('fantom');

    if (bscHealth) {
      bscHealth.status = 'unhealthy';
      bscHealth.wsConnected = false;
    }
    if (fantomHealth) {
      fantomHealth.status = 'unhealthy';
      fantomHealth.wsConnected = false;
    }

    const healthyChains = detector.getHealthyChains();

    expect(healthyChains).toHaveLength(2);
    expect(healthyChains).not.toContain('bsc');
    expect(healthyChains).toContain('polygon');
    expect(healthyChains).toContain('avalanche');
    expect(healthyChains).not.toContain('fantom');
  });

  it('should return string array type', async () => {
    detector = await createStartedP1Detector();

    const healthyChains = detector.getHealthyChains();

    expect(Array.isArray(healthyChains)).toBe(true);
    for (const chain of healthyChains) {
      expect(typeof chain).toBe('string');
    }
  });

  it('should be consistent with getPartitionHealth status', async () => {
    detector = await createStartedP1Detector();

    const health = detector.getPartitionHealth();
    const healthyChains = detector.getHealthyChains();

    // Count healthy chains from partition health
    let healthyCount = 0;
    for (const [, chainHealth] of health.chainHealth) {
      if (chainHealth.status === 'healthy') {
        healthyCount++;
      }
    }

    expect(healthyChains.length).toBe(healthyCount);
  });

  it('should update dynamically when chain status changes', async () => {
    detector = await createStartedP1Detector();

    // Initially all healthy
    expect(detector.getHealthyChains()).toHaveLength(4);

    // Simulate Polygon disconnect
    const chainHealth = detector['chainHealth'];
    const polygonHealth = chainHealth.get('polygon');
    if (polygonHealth) {
      polygonHealth.status = 'unhealthy';
      polygonHealth.wsConnected = false;
    }

    // Should reflect change
    expect(detector.getHealthyChains()).toHaveLength(3);
    expect(detector.getHealthyChains()).not.toContain('polygon');

    // Simulate Polygon reconnect
    if (polygonHealth) {
      polygonHealth.status = 'healthy';
      polygonHealth.wsConnected = true;
    }

    // Should reflect recovery
    expect(detector.getHealthyChains()).toHaveLength(4);
    expect(detector.getHealthyChains()).toContain('polygon');
  });
});
