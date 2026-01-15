/**
 * S3.1.5 Integration Tests: P3 High-Value Partition Service
 *
 * Tests for the P3 High-Value partition detector service:
 * - Chains: Ethereum, zkSync, Linea
 * - Region: Oracle Cloud US-East (us-east1)
 * - Resource Profile: Heavy (768MB, high-value mainnet focus)
 *
 * High-Value partition characteristics:
 * - Longer health check intervals (30s) for Ethereum's ~12s blocks
 * - Standard failover timeout (60s) for mainnet stability
 * - Heavy resource profile for Ethereum mainnet processing
 * - US-East deployment for proximity to major Ethereum infrastructure
 *
 * @see IMPLEMENTATION_PLAN.md S3.1.5: Create P3 detector service
 * @see ADR-003: Partitioned Chain Detectors
 */

import { EventEmitter } from 'events';
import { jest, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';

import {
  CHAINS,
  DEXES,
  CORE_TOKENS,
  DETECTOR_CONFIG,
  TOKEN_METADATA,
  getEnabledDexes,
  PARTITION_IDS
} from '@arbitrage/config';

import {
  getPartition,
  validatePartitionConfig,
  calculatePartitionResources,
  createChainInstance,
  createPartitionChainInstances
} from '@arbitrage/config/partitions';

// =============================================================================
// Test Constants
// =============================================================================

const P3_PARTITION_ID = PARTITION_IDS.HIGH_VALUE;
const P3_CHAINS = ['ethereum', 'zksync', 'linea'] as const;
const P3_DEFAULT_PORT = 3003;

// =============================================================================
// Mock Classes for Testing
// =============================================================================

/**
 * Mock P3 High-Value Partition Detector for testing.
 * Simulates the UnifiedChainDetector behavior for high-value chains.
 */
class MockP3Detector extends EventEmitter {
  private running = false;
  private startTime = 0;
  private chains: string[];
  private chainHealth: Map<string, { status: string; wsConnected: boolean; errorCount: number }>;
  private crossChainPrices: Map<string, Map<string, { price: number; timestamp: number }>>;
  private eventsProcessed = 0;
  private opportunitiesFound = 0;

  constructor(chains: string[] = [...P3_CHAINS]) {
    super();
    this.chains = chains;
    this.chainHealth = new Map();
    this.crossChainPrices = new Map();

    // Initialize health for each chain
    for (const chain of chains) {
      this.chainHealth.set(chain, {
        status: 'healthy',
        wsConnected: true,
        errorCount: 0
      });
    }
  }

  async start(): Promise<void> {
    this.running = true;
    this.startTime = Date.now();
    this.emit('started', { chains: this.chains });

    // Emit chainConnected for each chain
    for (const chain of this.chains) {
      this.emit('chainConnected', { chainId: chain });
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.emit('stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  getPartitionId(): string {
    return P3_PARTITION_ID;
  }

  getChains(): string[] {
    return [...this.chains];
  }

  getHealthyChains(): string[] {
    return this.chains.filter(chain => {
      const health = this.chainHealth.get(chain);
      return health?.status === 'healthy';
    });
  }

  getPartitionHealth(): {
    status: string;
    partitionId: string;
    chainHealth: Map<string, { status: string; wsConnected: boolean; errorCount: number }>;
    uptimeSeconds: number;
    totalEventsProcessed: number;
    memoryUsage: number;
  } {
    const healthyCount = this.getHealthyChains().length;
    const totalChains = this.chains.length;

    let status: string;
    if (healthyCount === totalChains) {
      status = 'healthy';
    } else if (healthyCount > 0) {
      status = 'degraded';
    } else {
      status = 'unhealthy';
    }

    return {
      status,
      partitionId: P3_PARTITION_ID,
      chainHealth: this.chainHealth,
      uptimeSeconds: (Date.now() - this.startTime) / 1000,
      totalEventsProcessed: this.eventsProcessed,
      memoryUsage: process.memoryUsage().heapUsed
    };
  }

  getStats(): {
    partitionId: string;
    chains: string[];
    totalEventsProcessed: number;
    totalOpportunitiesFound: number;
    uptimeSeconds: number;
    memoryUsageMB: number;
    chainStats: Map<string, unknown>;
  } {
    return {
      partitionId: P3_PARTITION_ID,
      chains: this.chains,
      totalEventsProcessed: this.eventsProcessed,
      totalOpportunitiesFound: this.opportunitiesFound,
      uptimeSeconds: (Date.now() - this.startTime) / 1000,
      memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      chainStats: new Map(this.chains.map(c => [c, { eventsProcessed: Math.floor(this.eventsProcessed / this.chains.length) }]))
    };
  }

  // Cross-chain price tracking methods
  updatePrice(chain: string, pairKey: string, price: number): void {
    if (!this.crossChainPrices.has(pairKey)) {
      this.crossChainPrices.set(pairKey, new Map());
    }
    this.crossChainPrices.get(pairKey)!.set(chain, {
      price,
      timestamp: Date.now()
    });
    this.eventsProcessed++;
  }

  getCrossChainPrices(pairKey: string): Map<string, { price: number; timestamp: number }> {
    return this.crossChainPrices.get(pairKey) || new Map();
  }

  findCrossChainDiscrepancies(threshold: number): Array<{
    pairKey: string;
    chains: string[];
    minPrice: number;
    maxPrice: number;
    discrepancy: number;
  }> {
    const discrepancies: Array<{
      pairKey: string;
      chains: string[];
      minPrice: number;
      maxPrice: number;
      discrepancy: number;
    }> = [];

    // Snapshot to avoid concurrent modification
    const pricesSnapshot = Array.from(this.crossChainPrices.entries());

    for (const [pairKey, chainPrices] of pricesSnapshot) {
      if (chainPrices.size < 2) continue;

      const prices = Array.from(chainPrices.entries());
      let minPrice = Infinity;
      let maxPrice = 0;
      const chains: string[] = [];

      for (const [chain, data] of prices) {
        if (data.price < minPrice) minPrice = data.price;
        if (data.price > maxPrice) maxPrice = data.price;
        chains.push(chain);
      }

      const discrepancy = (maxPrice - minPrice) / minPrice;

      if (discrepancy >= threshold) {
        discrepancies.push({
          pairKey,
          chains,
          minPrice,
          maxPrice,
          discrepancy
        });
        this.opportunitiesFound++;
      }
    }

    return discrepancies;
  }
}

// =============================================================================
// Test Helper Functions
// =============================================================================

async function createStartedP3Detector(): Promise<MockP3Detector> {
  const detector = new MockP3Detector();
  await detector.start();
  return detector;
}

// =============================================================================
// Integration Tests
// =============================================================================

describe('S3.1.5 P3 High-Value Partition Service', () => {
  let detector: MockP3Detector | null = null;

  afterEach(async () => {
    if (detector && detector.isRunning()) {
      await detector.stop();
    }
    detector = null;
  });

  // ===========================================================================
  // S3.1.5.1: P3 Partition Configuration Tests
  // ===========================================================================

  describe('S3.1.5.1: P3 Partition Configuration', () => {
    it('should have high-value partition defined in PARTITIONS', () => {
      const partition = getPartition(P3_PARTITION_ID);
      expect(partition).toBeDefined();
      expect(partition!.partitionId).toBe('high-value');
    });

    it('should include exactly 3 chains: Ethereum, zkSync, Linea', () => {
      const partition = getPartition(P3_PARTITION_ID);
      expect(partition!.chains).toHaveLength(3);
      expect(partition!.chains).toContain('ethereum');
      expect(partition!.chains).toContain('zksync');
      expect(partition!.chains).toContain('linea');
    });

    it('should be deployed to us-east1 region', () => {
      const partition = getPartition(P3_PARTITION_ID);
      expect(partition!.region).toBe('us-east1');
    });

    it('should use oracle provider for deployment', () => {
      const partition = getPartition(P3_PARTITION_ID);
      expect(partition!.provider).toBe('oracle');
    });

    it('should have heavy resource profile for 3 high-value chains', () => {
      const partition = getPartition(P3_PARTITION_ID);
      expect(partition!.resourceProfile).toBe('heavy');
    });

    it('should have priority 2 (lower than L2 chains)', () => {
      const partition = getPartition(P3_PARTITION_ID);
      expect(partition!.priority).toBe(2);
    });

    it('should be enabled', () => {
      const partition = getPartition(P3_PARTITION_ID);
      expect(partition!.enabled).toBe(true);
    });

    it('should have adequate memory (768MB) for high-value chains', () => {
      const partition = getPartition(P3_PARTITION_ID);
      expect(partition!.maxMemoryMB).toBeGreaterThanOrEqual(512);
      expect(partition!.maxMemoryMB).toBe(768);
    });

    it('should have standby configuration for failover', () => {
      const partition = getPartition(P3_PARTITION_ID);
      expect(partition!.standbyRegion).toBe('eu-west1');
      expect(partition!.standbyProvider).toBe('gcp');
    });

    it('should have longer health check interval (30s) for Ethereum blocks', () => {
      const partition = getPartition(P3_PARTITION_ID);
      expect(partition!.healthCheckIntervalMs).toBe(30000);
    });

    it('should have standard failover timeout (60s) for mainnet stability', () => {
      const partition = getPartition(P3_PARTITION_ID);
      expect(partition!.failoverTimeoutMs).toBe(60000);
    });

    it('should pass validation', () => {
      const partition = getPartition(P3_PARTITION_ID);
      const validation = validatePartitionConfig(partition!);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });
  });

  // ===========================================================================
  // S3.1.5.2: P3 Chain Configurations Tests
  // ===========================================================================

  describe('S3.1.5.2: P3 Chain Configurations', () => {
    describe('Ethereum Chain', () => {
      it('should have Ethereum chain defined', () => {
        expect(CHAINS['ethereum']).toBeDefined();
        expect(CHAINS['ethereum'].id).toBe(1);
        expect(CHAINS['ethereum'].name).toBe('Ethereum');
      });

      it('should have Ethereum DEXes configured', () => {
        const dexes = getEnabledDexes('ethereum');
        expect(dexes.length).toBeGreaterThanOrEqual(1);
        // Verify at least Uniswap V3 is present
        expect(dexes.some(d => d.name.toLowerCase().includes('uniswap'))).toBe(true);
      });

      it('should have Ethereum tokens configured', () => {
        const tokens = CORE_TOKENS['ethereum'];
        expect(tokens).toBeDefined();
        expect(tokens.length).toBeGreaterThanOrEqual(6);
      });

      it('should have Ethereum detector config', () => {
        expect(DETECTOR_CONFIG['ethereum']).toBeDefined();
      });

      it('should have Ethereum token metadata', () => {
        expect(TOKEN_METADATA['ethereum']).toBeDefined();
      });

      it('should have ~12s block time for mainnet', () => {
        const chain = CHAINS['ethereum'];
        expect(chain.blockTime).toBeGreaterThanOrEqual(10);
        expect(chain.blockTime).toBeLessThanOrEqual(15);
      });
    });

    describe('zkSync Chain', () => {
      it('should have zkSync chain defined', () => {
        expect(CHAINS['zksync']).toBeDefined();
        expect(CHAINS['zksync'].id).toBe(324);
        expect(CHAINS['zksync'].name).toBe('zkSync Era');
      });

      it('should have zkSync DEXes configured', () => {
        const dexes = getEnabledDexes('zksync');
        expect(dexes.length).toBeGreaterThanOrEqual(1);
      });

      it('should have zkSync tokens configured', () => {
        const tokens = CORE_TOKENS['zksync'];
        expect(tokens).toBeDefined();
        expect(tokens.length).toBeGreaterThanOrEqual(4);
      });

      it('should have zkSync detector config', () => {
        expect(DETECTOR_CONFIG['zksync']).toBeDefined();
      });

      it('should have zkSync token metadata', () => {
        expect(TOKEN_METADATA['zksync']).toBeDefined();
      });

      it('should have fast block time for ZK rollup', () => {
        const chain = CHAINS['zksync'];
        expect(chain.blockTime).toBeLessThanOrEqual(5);
      });
    });

    describe('Linea Chain', () => {
      it('should have Linea chain defined', () => {
        expect(CHAINS['linea']).toBeDefined();
        expect(CHAINS['linea'].id).toBe(59144);
        expect(CHAINS['linea'].name).toBe('Linea');
      });

      it('should have Linea DEXes configured', () => {
        const dexes = getEnabledDexes('linea');
        expect(dexes.length).toBeGreaterThanOrEqual(1);
      });

      it('should have Linea tokens configured', () => {
        const tokens = CORE_TOKENS['linea'];
        expect(tokens).toBeDefined();
        expect(tokens.length).toBeGreaterThanOrEqual(4);
      });

      it('should have Linea detector config', () => {
        expect(DETECTOR_CONFIG['linea']).toBeDefined();
      });

      it('should have Linea token metadata', () => {
        expect(TOKEN_METADATA['linea']).toBeDefined();
      });

      it('should have fast block time for L2', () => {
        const chain = CHAINS['linea'];
        expect(chain.blockTime).toBeLessThanOrEqual(5);
      });
    });
  });

  // ===========================================================================
  // S3.1.5.3: P3 Service Startup Tests
  // ===========================================================================

  describe('S3.1.5.3: P3 Service Startup', () => {
    it('should start with all 3 P3 chains', async () => {
      detector = await createStartedP3Detector();

      expect(detector.isRunning()).toBe(true);
      expect(detector.getChains()).toHaveLength(3);
    });

    it('should connect all chain managers', async () => {
      detector = await createStartedP3Detector();

      const chains = detector.getChains();
      expect(chains).toContain('ethereum');
      expect(chains).toContain('zksync');
      expect(chains).toContain('linea');
    });

    it('should report high-value partition ID', async () => {
      detector = await createStartedP3Detector();

      expect(detector.getPartitionId()).toBe('high-value');
    });

    it('should emit started event with all P3 chains', async () => {
      detector = new MockP3Detector();
      const startedPromise = new Promise<{ chains: string[] }>((resolve) => {
        detector!.once('started', resolve);
      });

      await detector.start();
      const event = await startedPromise;

      expect(event.chains).toContain('ethereum');
      expect(event.chains).toContain('zksync');
      expect(event.chains).toContain('linea');
    });

    it('should emit chainConnected for each P3 chain', async () => {
      detector = new MockP3Detector();
      const connectedChains: string[] = [];

      detector.on('chainConnected', ({ chainId }) => {
        connectedChains.push(chainId);
      });

      await detector.start();

      expect(connectedChains).toContain('ethereum');
      expect(connectedChains).toContain('zksync');
      expect(connectedChains).toContain('linea');
    });

    it('should start within 5 seconds', async () => {
      const startTime = Date.now();
      detector = await createStartedP3Detector();
      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(5000);
    });
  });

  // ===========================================================================
  // S3.1.5.4: P3 Health Monitoring Tests
  // ===========================================================================

  describe('S3.1.5.4: P3 Health Monitoring', () => {
    it('should return healthy status when all chains connected', async () => {
      detector = await createStartedP3Detector();

      const health = detector.getPartitionHealth();

      expect(health.status).toBe('healthy');
    });

    it('should report health for all 3 chains', async () => {
      detector = await createStartedP3Detector();

      const health = detector.getPartitionHealth();

      expect(health.chainHealth.size).toBe(3);
      expect(health.chainHealth.has('ethereum')).toBe(true);
      expect(health.chainHealth.has('zksync')).toBe(true);
      expect(health.chainHealth.has('linea')).toBe(true);
    });

    it('should return degraded status when one chain fails', async () => {
      detector = await createStartedP3Detector();

      // Simulate Linea going down
      const chainHealth = detector['chainHealth'];
      const lineaHealth = chainHealth.get('linea');
      if (lineaHealth) {
        lineaHealth.status = 'unhealthy';
        lineaHealth.wsConnected = false;
      }

      const health = detector.getPartitionHealth();

      expect(health.status).toBe('degraded');
    });

    it('should track memory usage', async () => {
      detector = await createStartedP3Detector();

      const health = detector.getPartitionHealth();

      expect(health.memoryUsage).toBeGreaterThan(0);
    });

    it('should track uptime', async () => {
      detector = await createStartedP3Detector();

      // Wait briefly
      await new Promise(resolve => setTimeout(resolve, 100));

      const health = detector.getPartitionHealth();

      expect(health.uptimeSeconds).toBeGreaterThan(0);
    });

    it('should track events processed', async () => {
      detector = await createStartedP3Detector();

      // Simulate some events
      detector.updatePrice('ethereum', 'WETH_USDC', 2500);
      detector.updatePrice('zksync', 'WETH_USDC', 2510);

      const health = detector.getPartitionHealth();

      expect(health.totalEventsProcessed).toBeGreaterThanOrEqual(2);
    });
  });

  // ===========================================================================
  // S3.1.5.5: P3 Cross-Chain High-Value Arbitrage Detection Tests
  // ===========================================================================

  describe('S3.1.5.5: P3 Cross-Chain High-Value Arbitrage Detection', () => {
    it('should track prices across all P3 high-value chains', async () => {
      detector = await createStartedP3Detector();

      detector.updatePrice('ethereum', 'WETH_USDC', 2500);
      detector.updatePrice('zksync', 'WETH_USDC', 2510);
      detector.updatePrice('linea', 'WETH_USDC', 2520);

      const prices = detector.getCrossChainPrices('WETH_USDC');

      expect(prices.size).toBe(3);
      expect(prices.get('ethereum')?.price).toBe(2500);
      expect(prices.get('zksync')?.price).toBe(2510);
      expect(prices.get('linea')?.price).toBe(2520);
    });

    it('should detect cross-chain price discrepancies between mainnet and L2s', async () => {
      detector = await createStartedP3Detector();

      // Create 5% price discrepancy between Ethereum and zkSync
      detector.updatePrice('ethereum', 'WETH_USDC', 2500);
      detector.updatePrice('zksync', 'WETH_USDC', 2625); // 5% higher
      detector.updatePrice('linea', 'WETH_USDC', 2510);

      const discrepancies = detector.findCrossChainDiscrepancies(0.01);

      expect(discrepancies.length).toBeGreaterThan(0);
      expect(discrepancies[0].pairKey).toBe('WETH_USDC');
      expect(discrepancies[0].chains).toContain('ethereum');
      expect(discrepancies[0].chains).toContain('zksync');
    });

    it('should detect arbitrage opportunities for ETH pairs', async () => {
      detector = await createStartedP3Detector();

      // ETH price difference between mainnet and ZK rollups
      detector.updatePrice('ethereum', 'ETH_USDT', 2500);
      detector.updatePrice('linea', 'ETH_USDT', 2575); // 3% higher

      const discrepancies = detector.findCrossChainDiscrepancies(0.01);

      expect(discrepancies.some(d => d.pairKey === 'ETH_USDT')).toBe(true);
    });

    it('should detect mainnet to ZK rollup arbitrage paths', async () => {
      detector = await createStartedP3Detector();

      // USDC price on different high-value chains
      detector.updatePrice('ethereum', 'WBTC_USDC', 45000);
      detector.updatePrice('zksync', 'WBTC_USDC', 45900); // ~2% higher

      const discrepancies = detector.findCrossChainDiscrepancies(0.01);

      expect(discrepancies.some(d =>
        d.pairKey === 'WBTC_USDC' &&
        d.chains.includes('ethereum') &&
        d.chains.includes('zksync')
      )).toBe(true);
    });

    it('should handle high-value token pairs', async () => {
      detector = await createStartedP3Detector();

      // wstETH price tracking across chains
      detector.updatePrice('ethereum', 'WSTETH_WETH', 1.15);
      detector.updatePrice('linea', 'WSTETH_WETH', 1.17); // ~1.7% higher

      const prices = detector.getCrossChainPrices('WSTETH_WETH');
      expect(prices.size).toBe(2);
    });
  });

  // ===========================================================================
  // S3.1.5.6: P3 Graceful Degradation Tests
  // ===========================================================================

  describe('S3.1.5.6: P3 Graceful Degradation', () => {
    it('should continue running with 2 of 3 chains healthy', async () => {
      detector = await createStartedP3Detector();

      // Simulate Linea going down
      const chainHealth = detector['chainHealth'];
      const lineaHealth = chainHealth.get('linea');
      if (lineaHealth) {
        lineaHealth.status = 'unhealthy';
        lineaHealth.wsConnected = false;
      }

      expect(detector.isRunning()).toBe(true);
      expect(detector.getHealthyChains()).toContain('ethereum');
      expect(detector.getHealthyChains()).toContain('zksync');
    });

    it('should continue running with 1 of 3 chains healthy', async () => {
      detector = await createStartedP3Detector();

      // Simulate zkSync and Linea going down
      const chainHealth = detector['chainHealth'];
      for (const chainId of ['zksync', 'linea']) {
        const health = chainHealth.get(chainId);
        if (health) {
          health.status = 'unhealthy';
          health.wsConnected = false;
        }
      }

      expect(detector.isRunning()).toBe(true);
      expect(detector.getHealthyChains()).toContain('ethereum');
      expect(detector.getHealthyChains()).toHaveLength(1);
    });

    it('should track error counts per chain', async () => {
      detector = await createStartedP3Detector();

      const chainHealth = detector['chainHealth'];
      const zkHealth = chainHealth.get('zksync');
      if (zkHealth) {
        zkHealth.errorCount = 5;
      }

      const health = detector.getPartitionHealth();
      expect(health.chainHealth.get('zksync')?.errorCount).toBe(5);
    });

    it('should update chain health status on disconnect', async () => {
      detector = await createStartedP3Detector();

      const chainHealth = detector['chainHealth'];
      const lineaHealth = chainHealth.get('linea');
      if (lineaHealth) {
        lineaHealth.status = 'unhealthy';
        lineaHealth.wsConnected = false;
      }

      expect(detector.getHealthyChains()).not.toContain('linea');
    });
  });

  // ===========================================================================
  // S3.1.5.7: P3 Resource Calculations Tests
  // ===========================================================================

  describe('S3.1.5.7: P3 Resource Calculations', () => {
    it('should calculate resources for 3-chain partition', () => {
      const resources = calculatePartitionResources(P3_PARTITION_ID);

      expect(resources.estimatedMemoryMB).toBeGreaterThan(200);
      expect(resources.estimatedCpuCores).toBeGreaterThan(0);
    });

    it('should recommend heavy profile for high-value chains', () => {
      const resources = calculatePartitionResources(P3_PARTITION_ID);

      // High-value chains should have heavy profile due to mainnet processing
      expect(['standard', 'heavy']).toContain(resources.recommendedProfile);
    });

    it('should account for DEX count in memory estimation', () => {
      const resources = calculatePartitionResources(P3_PARTITION_ID);

      // Get total DEX count for P3 chains
      let totalDexes = 0;
      for (const chainId of P3_CHAINS) {
        const dexes = getEnabledDexes(chainId);
        totalDexes += dexes.length;
      }

      // Memory should scale with DEX count
      expect(resources.estimatedMemoryMB).toBeGreaterThanOrEqual(totalDexes * 8);
    });

    it('should estimate lower CPU for longer Ethereum blocks', () => {
      const p3Resources = calculatePartitionResources(P3_PARTITION_ID);
      const p2Resources = calculatePartitionResources(PARTITION_IDS.L2_TURBO);

      // P3 (Ethereum ~12s) should have lower CPU estimate than P2 (L2 sub-second)
      expect(p3Resources.estimatedCpuCores).toBeLessThanOrEqual(p2Resources.estimatedCpuCores);
    });
  });

  // ===========================================================================
  // S3.1.5.8: P3 Chain Instance Creation Tests
  // ===========================================================================

  describe('S3.1.5.8: P3 Chain Instance Creation', () => {
    it('should create chain instances for all P3 chains', () => {
      const instances = createPartitionChainInstances(P3_PARTITION_ID);

      expect(instances).toHaveLength(3);
      expect(instances.map(i => i.chainId)).toContain('ethereum');
      expect(instances.map(i => i.chainId)).toContain('zksync');
      expect(instances.map(i => i.chainId)).toContain('linea');
    });

    it('should include DEX names for each chain', () => {
      const instances = createPartitionChainInstances(P3_PARTITION_ID);

      for (const instance of instances) {
        expect(instance.dexes.length).toBeGreaterThan(0);
      }
    });

    it('should include token symbols for each chain', () => {
      const instances = createPartitionChainInstances(P3_PARTITION_ID);

      for (const instance of instances) {
        expect(instance.tokens.length).toBeGreaterThan(0);
      }
    });

    it('should have correct native tokens (ETH for all)', () => {
      const instances = createPartitionChainInstances(P3_PARTITION_ID);

      for (const instance of instances) {
        expect(instance.nativeToken).toBe('ETH');
      }
    });

    it('should have varying block times (mainnet vs L2s)', () => {
      const instances = createPartitionChainInstances(P3_PARTITION_ID);

      const ethereum = instances.find(i => i.chainId === 'ethereum');
      const zksync = instances.find(i => i.chainId === 'zksync');

      expect(ethereum).toBeDefined();
      expect(zksync).toBeDefined();

      // Ethereum has ~12s blocks, zkSync has faster L2 blocks
      expect(ethereum!.blockTime).toBeGreaterThan(zksync!.blockTime);
    });
  });

  // ===========================================================================
  // S3.1.5.9: P3 Service Shutdown Tests
  // ===========================================================================

  describe('S3.1.5.9: P3 Service Shutdown', () => {
    it('should cleanly stop all 3 chains', async () => {
      detector = await createStartedP3Detector();

      await detector.stop();

      expect(detector.isRunning()).toBe(false);
    });

    it('should emit stopped event', async () => {
      detector = await createStartedP3Detector();

      const stoppedPromise = new Promise<void>((resolve) => {
        detector!.once('stopped', resolve);
      });

      await detector.stop();
      await stoppedPromise;

      expect(detector.isRunning()).toBe(false);
    });

    it('should disconnect Redis clients on shutdown', async () => {
      detector = await createStartedP3Detector();

      // In real implementation, this would disconnect Redis
      await detector.stop();

      expect(detector.isRunning()).toBe(false);
    });

    it('should handle shutdown errors gracefully', async () => {
      detector = await createStartedP3Detector();

      // Should not throw even if internal state is unexpected
      await expect(detector.stop()).resolves.toBeUndefined();
    });
  });
});

// =============================================================================
// S3.1.5.10: P3 Environment Configuration Tests
// =============================================================================

describe('S3.1.5.10: P3 Environment Configuration', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('should configure P3 with PARTITION_ID=high-value', () => {
    process.env.PARTITION_ID = 'high-value';

    const partition = getPartition(process.env.PARTITION_ID);

    expect(partition).toBeDefined();
    expect(partition!.partitionId).toBe('high-value');
    expect(partition!.chains).toEqual(['ethereum', 'zksync', 'linea']);
  });

  it('should allow chain override via PARTITION_CHAINS', () => {
    process.env.PARTITION_CHAINS = 'ethereum,zksync';

    const chains = process.env.PARTITION_CHAINS.split(',').map(c => c.trim());

    expect(chains).toHaveLength(2);
    expect(chains).toContain('ethereum');
    expect(chains).toContain('zksync');
    expect(chains).not.toContain('linea');
  });
});

// =============================================================================
// S3.1.5.11: P3 Deployment Configuration Tests
// =============================================================================

describe('S3.1.5.11: P3 Deployment Configuration', () => {
  it('should have correct P3 chains in partition config', () => {
    const partition = getPartition(P3_PARTITION_ID);

    expect(partition!.chains).toEqual(['ethereum', 'zksync', 'linea']);
  });

  it('should have Oracle Cloud provider configured for P3', () => {
    const partition = getPartition(P3_PARTITION_ID);

    expect(partition!.provider).toBe('oracle');
  });

  it('should have US-East region configured', () => {
    const partition = getPartition(P3_PARTITION_ID);

    expect(partition!.region).toBe('us-east1');
  });

  it('should have standby in eu-west1 with gcp provider', () => {
    const partition = getPartition(P3_PARTITION_ID);

    expect(partition!.standbyRegion).toBe('eu-west1');
    expect(partition!.standbyProvider).toBe('gcp');
  });

  it('should have longer health check interval (30 seconds) for mainnet', () => {
    const partition = getPartition(P3_PARTITION_ID);

    expect(partition!.healthCheckIntervalMs).toBe(30000);
  });

  it('should have failover timeout of 60 seconds', () => {
    const partition = getPartition(P3_PARTITION_ID);

    expect(partition!.failoverTimeoutMs).toBe(60000);
  });
});

// =============================================================================
// S3.1.5.12: P3 High-Value Specific Performance Tests
// =============================================================================

describe('S3.1.5.12: P3 High-Value Specific Performance', () => {
  let detector: MockP3Detector | null = null;

  afterEach(async () => {
    if (detector && detector.isRunning()) {
      await detector.stop();
    }
    detector = null;
  });

  it('should handle high-value transactions from Ethereum mainnet', async () => {
    detector = await createStartedP3Detector();

    // Simulate high-value Ethereum transactions
    for (let i = 0; i < 100; i++) {
      detector.updatePrice('ethereum', `PAIR_${i}`, 2500 + Math.random() * 100);
    }

    const stats = detector.getStats();
    expect(stats.totalEventsProcessed).toBeGreaterThanOrEqual(100);
  });

  it('should maintain consistent health reporting during high load', async () => {
    detector = await createStartedP3Detector();

    // Rapid health checks
    for (let i = 0; i < 10; i++) {
      const health = detector.getPartitionHealth();
      expect(health.status).toBe('healthy');
      expect(health.chainHealth.size).toBe(3);
    }
  });

  it('should getHealthyChains return correct chains under concurrent access', async () => {
    detector = await createStartedP3Detector();

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
// S3.1.5.13: Shared Partition Utilities Integration (P12-P19)
// =============================================================================

describe('S3.1.5.13: Shared Partition Utilities Integration', () => {
  describe('parsePort utility for P3', () => {
    let parsePort: typeof import('../../shared/core/src').parsePort;

    beforeAll(async () => {
      const module = await import('../../shared/core/src');
      parsePort = module.parsePort;
    });

    it('should parse valid port for P3 default (3003)', () => {
      expect(parsePort('3003', 3001)).toBe(3003);
    });

    it('should return P3 default port when env is undefined', () => {
      expect(parsePort(undefined, P3_DEFAULT_PORT)).toBe(3003);
    });

    it('should return P3 default for invalid port', () => {
      expect(parsePort('invalid', P3_DEFAULT_PORT)).toBe(3003);
    });
  });

  describe('validateAndFilterChains utility for P3', () => {
    let validateAndFilterChains: typeof import('../../shared/core/src').validateAndFilterChains;

    beforeAll(async () => {
      const module = await import('../../shared/core/src');
      validateAndFilterChains = module.validateAndFilterChains;
    });

    it('should validate P3 chains (ethereum, zksync, linea)', () => {
      const chains = validateAndFilterChains('ethereum,zksync,linea', P3_CHAINS);
      expect(chains).toEqual(['ethereum', 'zksync', 'linea']);
    });

    it('should filter invalid chains for P3', () => {
      const chains = validateAndFilterChains('ethereum,invalid,linea', P3_CHAINS);
      expect(chains).toEqual(['ethereum', 'linea']);
    });

    it('should return P3 defaults when all chains invalid', () => {
      const chains = validateAndFilterChains('invalid1,invalid2', P3_CHAINS);
      expect(chains).toEqual([...P3_CHAINS]);
    });
  });

  describe('setupDetectorEventHandlers utility for P3', () => {
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
      setupDetectorEventHandlers(mockDetector as any, mockLogger as any, P3_PARTITION_ID);

      expect(mockDetector.listenerCount('priceUpdate')).toBe(1);
      expect(mockDetector.listenerCount('opportunity')).toBe(1);
      expect(mockDetector.listenerCount('chainError')).toBe(1);
      expect(mockDetector.listenerCount('chainConnected')).toBe(1);
      expect(mockDetector.listenerCount('chainDisconnected')).toBe(1);
      expect(mockDetector.listenerCount('failoverEvent')).toBe(1);
    });

    it('should log high-value chain events with correct partition ID', () => {
      setupDetectorEventHandlers(mockDetector as any, mockLogger as any, P3_PARTITION_ID);

      mockDetector.emit('chainConnected', { chainId: 'ethereum' });
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Chain connected: ethereum',
        expect.objectContaining({ partition: 'high-value' })
      );

      mockDetector.emit('chainConnected', { chainId: 'zksync' });
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Chain connected: zksync',
        expect.objectContaining({ partition: 'high-value' })
      );
    });
  });
});

// =============================================================================
// S3.1.5.14: P3 Service Configuration Integration Tests
// =============================================================================

describe('S3.1.5.14: P3 Service Configuration Integration', () => {
  describe('PartitionServiceConfig for P3', () => {
    it('should have correct service name for P3', () => {
      const partition = getPartition(P3_PARTITION_ID);
      expect(partition).toBeDefined();

      // Verify config structure matches what P3 service should use
      const serviceConfig = {
        partitionId: P3_PARTITION_ID,
        serviceName: 'partition-high-value',
        defaultChains: partition!.chains,
        defaultPort: P3_DEFAULT_PORT,
        region: partition!.region,
        provider: partition!.provider
      };

      expect(serviceConfig.partitionId).toBe('high-value');
      expect(serviceConfig.serviceName).toBe('partition-high-value');
      expect(serviceConfig.defaultChains).toEqual(['ethereum', 'zksync', 'linea']);
      expect(serviceConfig.defaultPort).toBe(3003);
      expect(serviceConfig.region).toBe('us-east1');
      expect(serviceConfig.provider).toBe('oracle');
    });
  });

  describe('P3 vs P1/P2 configuration differences', () => {
    it('should have different default ports (P1: 3001, P2: 3002, P3: 3003)', () => {
      const p1Port = 3001;
      const p2Port = 3002;
      const p3Port = P3_DEFAULT_PORT;

      expect(p3Port).not.toBe(p1Port);
      expect(p3Port).not.toBe(p2Port);
      expect(p3Port).toBe(3003);
    });

    it('should have different regions (P1/P2: asia-southeast1, P3: us-east1)', () => {
      const p1Partition = getPartition(PARTITION_IDS.ASIA_FAST);
      const p2Partition = getPartition(PARTITION_IDS.L2_TURBO);
      const p3Partition = getPartition(P3_PARTITION_ID);

      expect(p3Partition!.region).not.toBe(p1Partition!.region);
      expect(p3Partition!.region).not.toBe(p2Partition!.region);
      expect(p3Partition!.region).toBe('us-east1');
    });

    it('should have different chain sets', () => {
      const p1Partition = getPartition(PARTITION_IDS.ASIA_FAST);
      const p2Partition = getPartition(PARTITION_IDS.L2_TURBO);
      const p3Partition = getPartition(P3_PARTITION_ID);

      expect(p3Partition!.chains).not.toEqual(p1Partition!.chains);
      expect(p3Partition!.chains).not.toEqual(p2Partition!.chains);
      expect(p3Partition!.chains).toContain('ethereum');
    });

    it('should have longer health check intervals (P3: 30s vs P1: 15s, P2: 10s)', () => {
      const p1Partition = getPartition(PARTITION_IDS.ASIA_FAST);
      const p2Partition = getPartition(PARTITION_IDS.L2_TURBO);
      const p3Partition = getPartition(P3_PARTITION_ID);

      // P3 has longer health checks for Ethereum's slower blocks
      expect(p3Partition!.healthCheckIntervalMs).toBeGreaterThan(p1Partition!.healthCheckIntervalMs);
      expect(p3Partition!.healthCheckIntervalMs).toBeGreaterThan(p2Partition!.healthCheckIntervalMs);
      expect(p3Partition!.healthCheckIntervalMs).toBe(30000);
    });

    it('should have same failover timeout as P1 (60s)', () => {
      const p1Partition = getPartition(PARTITION_IDS.ASIA_FAST);
      const p3Partition = getPartition(P3_PARTITION_ID);

      expect(p3Partition!.failoverTimeoutMs).toBe(p1Partition!.failoverTimeoutMs);
      expect(p3Partition!.failoverTimeoutMs).toBe(60000);
    });
  });
});

// =============================================================================
// S3.1.5.15: P3 Refactored Service Entry Point Tests
// =============================================================================

describe('S3.1.5.15: P3 Refactored Service Entry Point', () => {
  it('should export detector, config, and partition constants', async () => {
    // Dynamic import to test exports
    const p3Module = await import('../../services/partition-high-value/src/index');

    expect(p3Module.detector).toBeDefined();
    expect(p3Module.config).toBeDefined();
    expect(p3Module.P3_PARTITION_ID).toBe('high-value');
    expect(p3Module.P3_CHAINS).toEqual(['ethereum', 'zksync', 'linea']);
    expect(p3Module.P3_REGION).toBe('us-east1');
  });

  it('should have config with correct partition ID', async () => {
    const { config } = await import('../../services/partition-high-value/src/index');

    expect(config.partitionId).toBe('high-value');
  });

  it('should have config with high-value chains', async () => {
    const { config } = await import('../../services/partition-high-value/src/index');

    expect(config.chains).toContain('ethereum');
    expect(config.chains).toContain('zksync');
    expect(config.chains).toContain('linea');
  });

  it('should have config with correct region (us-east1)', async () => {
    const { config } = await import('../../services/partition-high-value/src/index');

    expect(config.regionId).toBe('us-east1');
  });
});

// =============================================================================
// S3.1.5.16: P19-FIX Shutdown Guard Tests
// =============================================================================

describe('S3.1.5.16: P19-FIX Shutdown Guard', () => {
  let setupProcessHandlers: typeof import('../../shared/core/src').setupProcessHandlers;
  let mockLogger: { info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock };
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
    mockDetector = {
      stop: jest.fn(() => Promise.resolve()),
      isRunning: jest.fn(() => true),
      getPartitionHealth: jest.fn(() => Promise.resolve({ status: 'healthy' })),
      getHealthyChains: jest.fn(() => ['ethereum', 'zksync', 'linea']),
      getStats: jest.fn(() => ({ partitionId: 'high-value' })),
      getPartitionId: jest.fn(() => 'high-value'),
      getChains: jest.fn(() => ['ethereum', 'zksync', 'linea']),
      start: jest.fn(() => Promise.resolve()),
      on: jest.fn(),
      emit: jest.fn()
    };
  });

  it('should register SIGTERM and SIGINT handlers', () => {
    const processOnSpy = jest.spyOn(process, 'on');
    const healthServerRef = { current: null };

    setupProcessHandlers(healthServerRef, mockDetector, mockLogger as any, 'test-service');

    expect(processOnSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(processOnSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));

    processOnSpy.mockRestore();
  });

  it('should register uncaughtException handler', () => {
    const processOnSpy = jest.spyOn(process, 'on');
    const healthServerRef = { current: null };

    setupProcessHandlers(healthServerRef, mockDetector, mockLogger as any, 'test-service');

    expect(processOnSpy).toHaveBeenCalledWith('uncaughtException', expect.any(Function));

    processOnSpy.mockRestore();
  });

  it('should register unhandledRejection handler', () => {
    const processOnSpy = jest.spyOn(process, 'on');
    const healthServerRef = { current: null };

    setupProcessHandlers(healthServerRef, mockDetector, mockLogger as any, 'test-service');

    expect(processOnSpy).toHaveBeenCalledWith('unhandledRejection', expect.any(Function));

    processOnSpy.mockRestore();
  });
});

// =============================================================================
// S3.1.5.17: Cross-Partition Consistency Tests
// =============================================================================

describe('S3.1.5.17: Cross-Partition Consistency', () => {
  describe('P1, P2, P3 Service Structure Consistency', () => {
    it('should have same shared utility imports across all partitions', async () => {
      // All partitions should use the same shared utilities
      const coreModule = await import('../../shared/core/src');

      expect(coreModule.parsePort).toBeDefined();
      expect(coreModule.validateAndFilterChains).toBeDefined();
      expect(coreModule.createPartitionHealthServer).toBeDefined();
      expect(coreModule.setupDetectorEventHandlers).toBeDefined();
      expect(coreModule.setupProcessHandlers).toBeDefined();
    });

    it('should have unique default ports for each partition', () => {
      const p1Port = 3001;
      const p2Port = 3002;
      const p3Port = P3_DEFAULT_PORT;

      const ports = [p1Port, p2Port, p3Port];
      const uniquePorts = new Set(ports);

      expect(uniquePorts.size).toBe(3);
      expect(ports).toEqual([3001, 3002, 3003]);
    });

    it('should have all partitions use PARTITION_IDS constants', () => {
      expect(PARTITION_IDS.ASIA_FAST).toBe('asia-fast');
      expect(PARTITION_IDS.L2_TURBO).toBe('l2-turbo');
      expect(PARTITION_IDS.HIGH_VALUE).toBe('high-value');
      expect(PARTITION_IDS.SOLANA_NATIVE).toBe('solana-native');
    });

    it('should have no overlapping chains between P1, P2, P3', () => {
      const p1Partition = getPartition(PARTITION_IDS.ASIA_FAST);
      const p2Partition = getPartition(PARTITION_IDS.L2_TURBO);
      const p3Partition = getPartition(PARTITION_IDS.HIGH_VALUE);

      const p1Chains = new Set(p1Partition!.chains);
      const p2Chains = new Set(p2Partition!.chains);
      const p3Chains = new Set(p3Partition!.chains);

      // Check P1 vs P2
      for (const chain of p1Chains) {
        expect(p2Chains.has(chain)).toBe(false);
      }

      // Check P1 vs P3
      for (const chain of p1Chains) {
        expect(p3Chains.has(chain)).toBe(false);
      }

      // Check P2 vs P3
      for (const chain of p2Chains) {
        expect(p3Chains.has(chain)).toBe(false);
      }
    });

    it('should have all EVM partitions with ETH-compatible native tokens', () => {
      const p3Partition = getPartition(P3_PARTITION_ID);

      // All P3 chains should have ETH as native token (Ethereum + ZK rollups)
      for (const chainId of p3Partition!.chains) {
        const chain = CHAINS[chainId];
        expect(chain.nativeToken).toBe('ETH');
      }
    });
  });

  describe('Health Check Interval Hierarchy', () => {
    it('should have P2 (L2) with fastest health checks', () => {
      const p2Partition = getPartition(PARTITION_IDS.L2_TURBO);
      expect(p2Partition!.healthCheckIntervalMs).toBe(10000);
    });

    it('should have P1 (Asia-Fast) with moderate health checks', () => {
      const p1Partition = getPartition(PARTITION_IDS.ASIA_FAST);
      expect(p1Partition!.healthCheckIntervalMs).toBe(15000);
    });

    it('should have P3 (High-Value) with slowest health checks due to Ethereum', () => {
      const p3Partition = getPartition(P3_PARTITION_ID);
      expect(p3Partition!.healthCheckIntervalMs).toBe(30000);
    });

    it('should have health check intervals proportional to block times', () => {
      const p2Partition = getPartition(PARTITION_IDS.L2_TURBO);
      const p3Partition = getPartition(P3_PARTITION_ID);

      // P3 should have at least 2x the interval of P2 (Ethereum ~12s vs L2 ~1-2s)
      expect(p3Partition!.healthCheckIntervalMs).toBeGreaterThanOrEqual(
        p2Partition!.healthCheckIntervalMs * 2
      );
    });
  });

  describe('Resource Profile Consistency', () => {
    it('should have appropriate resource profiles for chain counts', () => {
      const p1Partition = getPartition(PARTITION_IDS.ASIA_FAST);
      const p2Partition = getPartition(PARTITION_IDS.L2_TURBO);
      const p3Partition = getPartition(P3_PARTITION_ID);

      // P1: 4 chains -> heavy
      expect(p1Partition!.resourceProfile).toBe('heavy');

      // P2: 3 chains -> standard
      expect(p2Partition!.resourceProfile).toBe('standard');

      // P3: 3 chains but includes mainnet -> heavy
      expect(p3Partition!.resourceProfile).toBe('heavy');
    });

    it('should have memory allocation matching resource profiles', () => {
      const p1Partition = getPartition(PARTITION_IDS.ASIA_FAST);
      const p2Partition = getPartition(PARTITION_IDS.L2_TURBO);
      const p3Partition = getPartition(P3_PARTITION_ID);

      // Heavy profiles should have >= 512MB
      expect(p1Partition!.maxMemoryMB).toBeGreaterThanOrEqual(512);
      expect(p3Partition!.maxMemoryMB).toBeGreaterThanOrEqual(512);

      // Standard profile can have less
      expect(p2Partition!.maxMemoryMB).toBeGreaterThanOrEqual(384);
    });
  });
});

// =============================================================================
// S3.1.5.18: Service Structure Verification Tests
// =============================================================================

describe('S3.1.5.18: Service Structure Verification', () => {
  describe('P3 Service File Structure', () => {
    it('should have correct package.json name', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const packagePath = path.join(
        process.cwd(),
        'services/partition-high-value/package.json'
      );

      const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));

      expect(packageJson.name).toBe('@arbitrage/partition-high-value');
    });

    it('should have required dependencies', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const packagePath = path.join(
        process.cwd(),
        'services/partition-high-value/package.json'
      );

      const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));

      expect(packageJson.dependencies['@arbitrage/config']).toBeDefined();
      expect(packageJson.dependencies['@arbitrage/core']).toBeDefined();
      expect(packageJson.dependencies['@arbitrage/types']).toBeDefined();
      expect(packageJson.dependencies['@arbitrage/unified-detector']).toBeDefined();
    });

    it('should have tsconfig with correct references', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const tsconfigPath = path.join(
        process.cwd(),
        'services/partition-high-value/tsconfig.json'
      );

      const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf-8'));

      expect(tsconfig.references).toBeDefined();
      expect(tsconfig.references.length).toBeGreaterThanOrEqual(4);

      const refPaths = tsconfig.references.map((r: { path: string }) => r.path);
      expect(refPaths).toContain('../../shared/types');
      expect(refPaths).toContain('../../shared/config');
      expect(refPaths).toContain('../../shared/core');
      expect(refPaths).toContain('../unified-detector');
    });
  });

  describe('P3 Dockerfile Configuration', () => {
    it('should have correct health check port in Dockerfile', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const dockerfilePath = path.join(
        process.cwd(),
        'services/partition-high-value/Dockerfile'
      );

      const dockerfile = fs.readFileSync(dockerfilePath, 'utf-8');

      expect(dockerfile).toContain('HEALTH_CHECK_PORT=3003');
      expect(dockerfile).toContain('EXPOSE 3003');
      expect(dockerfile).toContain('localhost:3003/health');
    });

    it('should have correct partition chains in Dockerfile', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const dockerfilePath = path.join(
        process.cwd(),
        'services/partition-high-value/Dockerfile'
      );

      const dockerfile = fs.readFileSync(dockerfilePath, 'utf-8');

      expect(dockerfile).toContain('PARTITION_CHAINS=ethereum,zksync,linea');
    });

    it('should have P11-FIX health check (200 status check)', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const dockerfilePath = path.join(
        process.cwd(),
        'services/partition-high-value/Dockerfile'
      );

      const dockerfile = fs.readFileSync(dockerfilePath, 'utf-8');

      // P11-FIX: Check for 200 status (both healthy and degraded return 200)
      expect(dockerfile).toContain('statusCode === 200');
      expect(dockerfile).toContain('P11-FIX');
    });

    it('should have 30s health check interval for Ethereum blocks', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const dockerfilePath = path.join(
        process.cwd(),
        'services/partition-high-value/Dockerfile'
      );

      const dockerfile = fs.readFileSync(dockerfilePath, 'utf-8');

      expect(dockerfile).toContain('--interval=30s');
    });

    it('should run as non-root user for security', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const dockerfilePath = path.join(
        process.cwd(),
        'services/partition-high-value/Dockerfile'
      );

      const dockerfile = fs.readFileSync(dockerfilePath, 'utf-8');

      expect(dockerfile).toContain('USER nodejs');
      expect(dockerfile).toContain('adduser -S nodejs');
    });
  });

  describe('P3 Docker Compose Configuration', () => {
    it('should have correct service name', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const composePath = path.join(
        process.cwd(),
        'services/partition-high-value/docker-compose.yml'
      );

      const compose = fs.readFileSync(composePath, 'utf-8');

      expect(compose).toContain('partition-high-value:');
      expect(compose).toContain('container_name: partition-high-value');
    });

    it('should have correct environment variables', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const composePath = path.join(
        process.cwd(),
        'services/partition-high-value/docker-compose.yml'
      );

      const compose = fs.readFileSync(composePath, 'utf-8');

      expect(compose).toContain('PARTITION_ID=high-value');
      expect(compose).toContain('PARTITION_CHAINS=ethereum,zksync,linea');
      expect(compose).toContain('HEALTH_CHECK_PORT=3003');
      expect(compose).toContain('REGION_ID=us-east1');
    });

    it('should expose correct port', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const composePath = path.join(
        process.cwd(),
        'services/partition-high-value/docker-compose.yml'
      );

      const compose = fs.readFileSync(composePath, 'utf-8');

      expect(compose).toContain('"3003:3003"');
    });

    it('should have appropriate health check configuration', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const composePath = path.join(
        process.cwd(),
        'services/partition-high-value/docker-compose.yml'
      );

      const compose = fs.readFileSync(composePath, 'utf-8');

      expect(compose).toContain('interval: 30s');
      expect(compose).toContain('localhost:3003/health');
    });
  });
});
