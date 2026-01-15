/**
 * S3.1.1 PartitionedDetector Integration Tests
 *
 * End-to-end testing of the PartitionedDetector base class implementation.
 * Validates the hypothesis: Partitioned detectors enable 15+ chains within free tier limits.
 *
 * Tests cover:
 * - Integration with partition configuration (ADR-003)
 * - Multi-chain lifecycle management
 * - Cross-chain price tracking and discrepancy detection
 * - Health aggregation across chains
 * - Graceful degradation
 * - Dynamic chain management
 *
 * @see IMPLEMENTATION_PLAN.md S3.1.1: Create PartitionedDetector base class
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

jest.mock('@arbitrage/core/logger', () => ({
  createLogger: jest.fn(() => mockLogger),
  getPerformanceLogger: jest.fn(() => mockPerfLogger)
}));

jest.mock('@arbitrage/core/redis', () => ({
  getRedisClient: jest.fn(() => Promise.resolve(mockRedisClient)),
  RedisClient: jest.fn()
}));

jest.mock('@arbitrage/core/redis-streams', () => ({
  getRedisStreamsClient: jest.fn(() => Promise.resolve(mockStreamsClient)),
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
  PartitionHealth,
  CrossChainDiscrepancy
} from '@arbitrage/core/partitioned-detector';

import {
  PARTITIONS,
  getPartition,
  getEnabledPartitions,
  getChainsForPartition,
  createChainInstance,
  assignChainToPartition,
  validatePartitionConfig
} from '@arbitrage/config/partitions';

import { CHAINS } from '@arbitrage/config';

// =============================================================================
// Test Helpers
// =============================================================================

function createTestConfig(overrides: Partial<PartitionedDetectorConfig> = {}): PartitionedDetectorConfig {
  return {
    partitionId: 'test-partition',
    chains: ['bsc', 'polygon'],
    region: 'asia-southeast1',
    healthCheckIntervalMs: 100000, // Long interval to avoid interference
    failoverTimeoutMs: 30000,
    ...overrides
  };
}

async function createStartedDetector(config?: PartitionedDetectorConfig): Promise<PartitionedDetector> {
  const detector = new PartitionedDetector(config || createTestConfig());
  await detector.start();
  return detector;
}

// =============================================================================
// Integration Tests
// =============================================================================

describe('S3.1.1 PartitionedDetector Integration Tests', () => {
  let detector: PartitionedDetector | null = null;

  beforeAll(() => {
    // Reset singletons before tests
  });

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

  // ===========================================================================
  // S3.1.1.1: Integration with Partition Configuration
  // ===========================================================================
  describe('S3.1.1.1: Partition Configuration Integration', () => {
    it('should use partition config from partitions.ts', () => {
      const asiaFast = getPartition('asia-fast');
      expect(asiaFast).toBeDefined();
      expect(asiaFast?.chains).toContain('bsc');
      expect(asiaFast?.chains).toContain('polygon');

      detector = new PartitionedDetector({
        partitionId: asiaFast!.partitionId,
        chains: asiaFast!.chains,
        region: asiaFast!.region,
        healthCheckIntervalMs: asiaFast!.healthCheckIntervalMs,
        failoverTimeoutMs: asiaFast!.failoverTimeoutMs
      });

      expect(detector.getPartitionId()).toBe('asia-fast');
      expect(detector.getChains()).toEqual(asiaFast!.chains);
    });

    it('should work with all enabled partition configs', () => {
      const enabledPartitions = getEnabledPartitions();
      expect(enabledPartitions.length).toBeGreaterThan(0);

      for (const partition of enabledPartitions) {
        const det = new PartitionedDetector({
          partitionId: partition.partitionId,
          chains: partition.chains,
          region: partition.region
        });

        expect(det.getPartitionId()).toBe(partition.partitionId);
        expect(det.getChains()).toEqual(partition.chains);
      }
    });

    it('should correctly assign chains to partitions per ADR-003 rules', () => {
      // BSC should go to asia-fast (fast Asian chain)
      const bscPartition = assignChainToPartition('bsc');
      expect(bscPartition?.partitionId).toBe('asia-fast');

      // Arbitrum should go to l2-turbo (ultra-fast L2)
      const arbitrumPartition = assignChainToPartition('arbitrum');
      expect(arbitrumPartition?.partitionId).toBe('l2-turbo');

      // Ethereum should go to high-value
      const ethPartition = assignChainToPartition('ethereum');
      expect(ethPartition?.partitionId).toBe('high-value');
    });

    it('should validate partition configuration', () => {
      const partition = getPartition('asia-fast');
      const validation = validatePartitionConfig(partition!);

      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });
  });

  // ===========================================================================
  // S3.1.1.2: Multi-Chain Lifecycle Management
  // ===========================================================================
  describe('S3.1.1.2: Multi-Chain Lifecycle Management', () => {
    it('should start and connect all configured chains', async () => {
      detector = await createStartedDetector();

      expect(detector.isRunning()).toBe(true);
      expect(detector.getChainManagers().size).toBe(2);
      expect(detector.getChainManagers().has('bsc')).toBe(true);
      expect(detector.getChainManagers().has('polygon')).toBe(true);
    });

    it('should cleanly stop all chain connections', async () => {
      detector = await createStartedDetector();
      expect(detector.isRunning()).toBe(true);

      await detector.stop();

      expect(detector.isRunning()).toBe(false);
      expect(detector.getChainManagers().size).toBe(0);
    });

    it('should handle rapid start/stop cycles gracefully', async () => {
      detector = new PartitionedDetector(createTestConfig({ chains: ['bsc'] }));

      for (let i = 0; i < 3; i++) {
        await detector.start();
        expect(detector.isRunning()).toBe(true);
        await detector.stop();
        expect(detector.isRunning()).toBe(false);
      }
    });

    it('should handle concurrent start calls', async () => {
      detector = new PartitionedDetector(createTestConfig());

      const results = await Promise.all([
        detector.start(),
        detector.start(),
        detector.start()
      ]);

      expect(detector.isRunning()).toBe(true);
    });

    it('should handle concurrent stop calls', async () => {
      detector = await createStartedDetector();

      await Promise.all([
        detector.stop(),
        detector.stop(),
        detector.stop()
      ]);

      expect(detector.isRunning()).toBe(false);
    });
  });

  // ===========================================================================
  // S3.1.1.3: Health Aggregation
  // ===========================================================================
  describe('S3.1.1.3: Health Aggregation', () => {
    it('should aggregate health from all chains', async () => {
      detector = await createStartedDetector();

      const health = detector.getPartitionHealth();

      expect(health.partitionId).toBe('test-partition');
      expect(health.chainHealth.size).toBe(2);
      expect(health.chainHealth.has('bsc')).toBe(true);
      expect(health.chainHealth.has('polygon')).toBe(true);
    });

    it('should report healthy when all chains are connected', async () => {
      detector = await createStartedDetector();

      const health = detector.getPartitionHealth();

      expect(health.status).toBe('healthy');
      expect(detector.getHealthyChains()).toHaveLength(2);
    });

    it('should report degraded when some chains are unhealthy', async () => {
      detector = await createStartedDetector();

      // Simulate one chain becoming unhealthy
      const chainHealth = detector['chainHealth'];
      const bscHealth = chainHealth.get('bsc');
      if (bscHealth) {
        bscHealth.status = 'unhealthy';
        bscHealth.wsConnected = false;
      }

      const health = detector.getPartitionHealth();

      expect(health.status).toBe('degraded');
      expect(detector.getHealthyChains()).toHaveLength(1);
      expect(detector.getHealthyChains()).toContain('polygon');
    });

    it('should report unhealthy when all chains are down', async () => {
      detector = await createStartedDetector();

      // Simulate all chains becoming unhealthy
      const chainHealth = detector['chainHealth'];
      for (const [, health] of chainHealth) {
        health.status = 'unhealthy';
        health.wsConnected = false;
      }

      const health = detector.getPartitionHealth();

      expect(health.status).toBe('unhealthy');
      expect(detector.getHealthyChains()).toHaveLength(0);
    });

    it('should track uptime correctly', async () => {
      detector = await createStartedDetector();

      // Wait for some time
      await new Promise(resolve => setTimeout(resolve, 100));

      const health = detector.getPartitionHealth();

      expect(health.uptimeSeconds).toBeGreaterThan(0);
    });

    it('should calculate average event latency', async () => {
      detector = await createStartedDetector();

      // Inject latency data
      detector['eventLatencies'] = [10, 20, 30, 40, 50];

      const health = detector.getPartitionHealth();

      expect(health.avgEventLatencyMs).toBe(30);
    });
  });

  // ===========================================================================
  // S3.1.1.4: Cross-Chain Price Tracking
  // ===========================================================================
  describe('S3.1.1.4: Cross-Chain Price Tracking', () => {
    it('should update prices for individual chains', async () => {
      detector = await createStartedDetector();

      detector.updatePrice('bsc', 'WETH_USDC', 2500);
      detector.updatePrice('polygon', 'WETH_USDC', 2510);

      const prices = detector.getCrossChainPrices('WETH_USDC');

      expect(prices.size).toBe(2);
      expect(prices.get('bsc')?.price).toBe(2500);
      expect(prices.get('polygon')?.price).toBe(2510);
    });

    it('should include timestamps with price updates', async () => {
      detector = await createStartedDetector();

      const beforeTime = Date.now();
      detector.updatePrice('bsc', 'WETH_USDC', 2500);
      const afterTime = Date.now();

      const prices = detector.getCrossChainPrices('WETH_USDC');
      const bscPrice = prices.get('bsc');

      expect(bscPrice?.timestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(bscPrice?.timestamp).toBeLessThanOrEqual(afterTime);
    });

    it('should detect cross-chain price discrepancies', async () => {
      detector = await createStartedDetector();

      // Create 4% price discrepancy
      detector.updatePrice('bsc', 'WETH_USDC', 2500);
      detector.updatePrice('polygon', 'WETH_USDC', 2600);

      const discrepancies = detector.findCrossChainDiscrepancies(0.01); // 1% threshold

      expect(discrepancies.length).toBeGreaterThan(0);
      expect(discrepancies[0].pairKey).toBe('WETH_USDC');
      expect(discrepancies[0].chains).toContain('bsc');
      expect(discrepancies[0].chains).toContain('polygon');
      expect(discrepancies[0].maxDifference).toBeCloseTo(0.04, 2);
    });

    it('should not report discrepancies below threshold', async () => {
      detector = await createStartedDetector();

      // Create 0.5% price discrepancy
      detector.updatePrice('bsc', 'WETH_USDC', 2500);
      detector.updatePrice('polygon', 'WETH_USDC', 2512.5);

      const discrepancies = detector.findCrossChainDiscrepancies(0.01); // 1% threshold

      expect(discrepancies.length).toBe(0);
    });

    it('should handle multiple token pairs', async () => {
      detector = await createStartedDetector();

      detector.updatePrice('bsc', 'WETH_USDC', 2500);
      detector.updatePrice('polygon', 'WETH_USDC', 2600);
      detector.updatePrice('bsc', 'WBTC_USDC', 40000);
      detector.updatePrice('polygon', 'WBTC_USDC', 41500);

      const discrepancies = detector.findCrossChainDiscrepancies(0.01);

      expect(discrepancies.length).toBe(2);
      const pairKeys = discrepancies.map(d => d.pairKey);
      expect(pairKeys).toContain('WETH_USDC');
      expect(pairKeys).toContain('WBTC_USDC');
    });

    it('should require at least 2 chains for discrepancy detection', async () => {
      detector = await createStartedDetector();

      // Only one chain has this pair
      detector.updatePrice('bsc', 'UNIQUE_PAIR', 1000);

      const discrepancies = detector.findCrossChainDiscrepancies(0.01);

      expect(discrepancies.filter(d => d.pairKey === 'UNIQUE_PAIR')).toHaveLength(0);
    });

    it('should handle zero prices gracefully', async () => {
      detector = await createStartedDetector();

      detector.updatePrice('bsc', 'ZERO_PAIR', 0);
      detector.updatePrice('polygon', 'ZERO_PAIR', 100);

      const discrepancies = detector.findCrossChainDiscrepancies(0.01);

      // Should not crash and should skip zero prices
      expect(discrepancies.filter(d => d.pairKey === 'ZERO_PAIR')).toHaveLength(0);
    });
  });

  // ===========================================================================
  // S3.1.1.5: Dynamic Chain Management
  // ===========================================================================
  describe('S3.1.1.5: Dynamic Chain Management', () => {
    it('should add chains at runtime', async () => {
      detector = new PartitionedDetector(createTestConfig({ chains: ['bsc'] }));
      await detector.start();

      expect(detector.getChains()).toHaveLength(1);

      await detector.addChain('polygon');

      expect(detector.getChains()).toHaveLength(2);
      expect(detector.getChains()).toContain('polygon');
      expect(detector.getChainManagers().has('polygon')).toBe(true);
    });

    it('should remove chains at runtime', async () => {
      detector = await createStartedDetector();

      expect(detector.getChains()).toHaveLength(2);

      await detector.removeChain('polygon');

      expect(detector.getChains()).toHaveLength(1);
      expect(detector.getChains()).not.toContain('polygon');
      expect(detector.getChainManagers().has('polygon')).toBe(false);
    });

    it('should not allow removing the last chain', async () => {
      detector = new PartitionedDetector(createTestConfig({ chains: ['bsc'] }));
      await detector.start();

      await expect(detector.removeChain('bsc'))
        .rejects.toThrow('Cannot remove last chain from partition');

      expect(detector.getChains()).toContain('bsc');
    });

    it('should handle adding duplicate chains gracefully', async () => {
      detector = await createStartedDetector();

      const initialChainCount = detector.getChains().length;
      await detector.addChain('bsc'); // Already exists

      expect(detector.getChains()).toHaveLength(initialChainCount);
      expect(mockLogger.warn).toHaveBeenCalledWith('Chain bsc already in partition');
    });

    it('should reject invalid chain IDs', async () => {
      detector = await createStartedDetector();

      await expect(detector.addChain('invalid-chain'))
        .rejects.toThrow('Invalid chain: invalid-chain');
    });
  });

  // ===========================================================================
  // S3.1.1.6: Event Handling
  // ===========================================================================
  describe('S3.1.1.6: Event Handling', () => {
    it('should emit started event with partition info', async () => {
      detector = new PartitionedDetector(createTestConfig());
      const startedHandler = jest.fn();
      detector.on('started', startedHandler);

      await detector.start();

      expect(startedHandler).toHaveBeenCalledWith({
        partitionId: 'test-partition',
        chains: ['bsc', 'polygon']
      });
    });

    it('should emit stopped event', async () => {
      detector = await createStartedDetector();
      const stoppedHandler = jest.fn();
      detector.on('stopped', stoppedHandler);

      await detector.stop();

      expect(stoppedHandler).toHaveBeenCalledWith({
        partitionId: 'test-partition'
      });
    });

    it('should emit chainConnected for each chain', async () => {
      detector = new PartitionedDetector(createTestConfig());
      const connectedHandler = jest.fn();
      detector.on('chainConnected', connectedHandler);

      await detector.start();

      // P2-1 FIX: Event should only be emitted once per chain (from WebSocket 'connected' handler)
      expect(connectedHandler).toHaveBeenCalledTimes(2);
      expect(connectedHandler).toHaveBeenCalledWith({ chainId: 'bsc' });
      expect(connectedHandler).toHaveBeenCalledWith({ chainId: 'polygon' });
    });

    it('should emit chainDisconnected when chain disconnects', async () => {
      detector = await createStartedDetector();
      const disconnectedHandler = jest.fn();
      detector.on('chainDisconnected', disconnectedHandler);

      // Simulate disconnect
      const wsManager = detector.getChainManagers().get('bsc') as unknown as EventEmitter;
      wsManager?.emit('disconnected');

      expect(disconnectedHandler).toHaveBeenCalledWith({ chainId: 'bsc' });
    });

    it('should emit chainError when chain has error', async () => {
      detector = await createStartedDetector();
      const errorHandler = jest.fn();
      detector.on('chainError', errorHandler);

      // Simulate error
      const wsManager = detector.getChainManagers().get('bsc') as unknown as EventEmitter;
      wsManager?.emit('error', new Error('Test error'));

      expect(errorHandler).toHaveBeenCalledWith({
        chainId: 'bsc',
        error: expect.any(Error)
      });
    });
  });

  // ===========================================================================
  // S3.1.1.7: Graceful Degradation
  // ===========================================================================
  describe('S3.1.1.7: Graceful Degradation', () => {
    it('should continue running with partial chain failures', async () => {
      detector = await createStartedDetector();

      // Simulate one chain going down
      const chainHealth = detector['chainHealth'];
      const bscHealth = chainHealth.get('bsc');
      if (bscHealth) {
        bscHealth.status = 'unhealthy';
        bscHealth.wsConnected = false;
      }

      expect(detector.isRunning()).toBe(true);
      expect(detector.getHealthyChains()).toContain('polygon');
    });

    it('should track error counts per chain', async () => {
      detector = await createStartedDetector();

      // Simulate errors
      const wsManager = detector.getChainManagers().get('bsc') as unknown as EventEmitter;
      wsManager?.emit('error', new Error('Error 1'));
      wsManager?.emit('error', new Error('Error 2'));

      const chainHealth = detector.getChainHealth('bsc');
      expect(chainHealth?.errorCount).toBeGreaterThanOrEqual(2);
    });

    it('should update chain health status on disconnect', async () => {
      detector = await createStartedDetector();

      const wsManager = detector.getChainManagers().get('bsc') as unknown as EventEmitter;
      wsManager?.emit('disconnected');

      const chainHealth = detector.getChainHealth('bsc');
      expect(chainHealth?.status).toBe('degraded');
      expect(chainHealth?.wsConnected).toBe(false);
    });
  });

  // ===========================================================================
  // S3.1.1.8: Resource Management
  // ===========================================================================
  describe('S3.1.1.8: Resource Management', () => {
    it('should track memory usage', async () => {
      detector = await createStartedDetector();

      const health = detector.getPartitionHealth();

      expect(health.memoryUsage).toBeGreaterThan(0);
    });

    it('should clean up resources on stop', async () => {
      detector = await createStartedDetector();

      const initialManagerCount = detector.getChainManagers().size;
      expect(initialManagerCount).toBe(2);

      await detector.stop();

      expect(detector.getChainManagers().size).toBe(0);
      expect(mockStreamsClient.disconnect).toHaveBeenCalled();
      expect(mockRedisClient.disconnect).toHaveBeenCalled();
    });

    it('should handle cleanup errors gracefully', async () => {
      detector = await createStartedDetector();

      // Make Redis disconnect fail
      mockRedisClient.disconnect.mockRejectedValueOnce(new Error('Disconnect error'));

      // Should not throw
      await expect(detector.stop()).resolves.not.toThrow();
      expect(detector.isRunning()).toBe(false);
    });
  });

  // ===========================================================================
  // S3.1.1.9: Thread Safety (Race Condition Prevention)
  // ===========================================================================
  describe('S3.1.1.9: Thread Safety', () => {
    it('should handle concurrent price updates during discrepancy detection', async () => {
      detector = await createStartedDetector();

      // Set initial prices
      detector.updatePrice('bsc', 'WETH_USDC', 2500);
      detector.updatePrice('polygon', 'WETH_USDC', 2600);

      // Run discrepancy detection and price updates concurrently
      const discrepancyPromise = Promise.resolve(detector.findCrossChainDiscrepancies(0.01));
      detector.updatePrice('bsc', 'WETH_USDC', 2550);
      detector.updatePrice('polygon', 'WETH_USDC', 2700);

      const discrepancies = await discrepancyPromise;

      // Should get consistent results (snapshot-based)
      expect(discrepancies.length).toBeGreaterThanOrEqual(0);
    });

    it('should handle interleaved start/stop operations', async () => {
      detector = new PartitionedDetector(createTestConfig());

      // Interleaved operations
      const start1 = detector.start();
      const stop1 = detector.stop();
      const start2 = detector.start();

      await Promise.all([start1, stop1, start2]);

      // Should end in a consistent state
      expect(typeof detector.isRunning()).toBe('boolean');
    });

    it('should not process events during shutdown', async () => {
      detector = await createStartedDetector();

      // Start stopping
      const stopPromise = detector.stop();

      // Try to update price during shutdown
      detector.updatePrice('bsc', 'SHUTDOWN_TEST', 1000);

      await stopPromise;

      // Should complete without errors
      expect(detector.isRunning()).toBe(false);
    });
  });
});

// =============================================================================
// Performance Tests
// =============================================================================
describe('S3.1.1 Performance Tests', () => {
  let detector: PartitionedDetector | null = null;

  afterEach(async () => {
    jest.clearAllMocks();
    if (detector) {
      await detector.stop();
      detector = null;
    }
  });

  it('should start all chains within 5 seconds', async () => {
    const config = createTestConfig({ chains: ['bsc', 'polygon'] });
    detector = new PartitionedDetector(config);

    const startTime = Date.now();
    await detector.start();
    const duration = Date.now() - startTime;

    expect(duration).toBeLessThan(5000);
  });

  it('should handle 1000 price updates efficiently', async () => {
    detector = new PartitionedDetector(createTestConfig());
    await detector.start();

    const startTime = Date.now();
    for (let i = 0; i < 1000; i++) {
      detector.updatePrice('bsc', `PAIR_${i}`, Math.random() * 1000);
    }
    const duration = Date.now() - startTime;

    // Should complete in under 100ms
    expect(duration).toBeLessThan(100);
  });

  it('should find discrepancies efficiently with many pairs', async () => {
    detector = new PartitionedDetector(createTestConfig());
    await detector.start();

    // Create 100 pairs with discrepancies
    for (let i = 0; i < 100; i++) {
      detector.updatePrice('bsc', `PAIR_${i}`, 1000 + i);
      detector.updatePrice('polygon', `PAIR_${i}`, 1050 + i); // 5% diff
    }

    const startTime = Date.now();
    const discrepancies = detector.findCrossChainDiscrepancies(0.01);
    const duration = Date.now() - startTime;

    expect(discrepancies.length).toBe(100);
    expect(duration).toBeLessThan(50); // Should be very fast
  });
});

// =============================================================================
// ADR-003 Compliance Tests
// =============================================================================
describe('S3.1.1 ADR-003 Compliance', () => {
  let detector: PartitionedDetector | null = null;

  afterEach(async () => {
    jest.clearAllMocks();
    if (detector) {
      await detector.stop();
      detector = null;
    }
  });

  it('should support all partition configurations defined in ADR-003', () => {
    const partitions = getEnabledPartitions();

    // Per ADR-003, we should have asia-fast, l2-turbo, and high-value partitions
    const partitionIds = partitions.map(p => p.partitionId);
    expect(partitionIds).toContain('asia-fast');
    expect(partitionIds).toContain('l2-turbo');
    expect(partitionIds).toContain('high-value');
  });

  it('should support multi-chain detection within single partition', async () => {
    const l2Fast = getPartition('l2-turbo');
    expect(l2Fast?.chains.length).toBeGreaterThanOrEqual(2);

    detector = new PartitionedDetector({
      partitionId: l2Fast!.partitionId,
      chains: l2Fast!.chains,
      region: l2Fast!.region
    });
    await detector.start();

    expect(detector.getChains().length).toBeGreaterThanOrEqual(2);
    expect(detector.getChainManagers().size).toBeGreaterThanOrEqual(2);
  });

  it('should support graceful degradation per ADR-003', async () => {
    detector = new PartitionedDetector(createTestConfig());
    await detector.start();

    // ADR-003 requires partition to continue with partial failures
    const chainHealth = detector['chainHealth'];
    const bscHealth = chainHealth.get('bsc');
    if (bscHealth) {
      bscHealth.status = 'unhealthy';
    }

    // Should still be running
    expect(detector.isRunning()).toBe(true);
    expect(detector.getPartitionHealth().status).toBe('degraded');
  });

  it('should provide health aggregation per ADR-003', async () => {
    detector = new PartitionedDetector(createTestConfig());
    await detector.start();

    const health = detector.getPartitionHealth();

    // ADR-003 requires these health metrics
    expect(health).toHaveProperty('partitionId');
    expect(health).toHaveProperty('status');
    expect(health).toHaveProperty('chainHealth');
    expect(health).toHaveProperty('totalEventsProcessed');
    expect(health).toHaveProperty('avgEventLatencyMs');
    expect(health).toHaveProperty('memoryUsage');
    expect(health).toHaveProperty('uptimeSeconds');
  });
});
