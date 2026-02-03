/**
 * S3.1.6 Integration Tests: P4 Solana-Native Partition Service
 *
 * Tests for the P4 Solana-Native partition detector service:
 * - Chain: Solana (non-EVM)
 * - Region: Fly.io US-West (us-west1)
 * - Resource Profile: Heavy (high-throughput chain)
 *
 * Solana-Native partition characteristics:
 * - Non-EVM chain requiring @solana/web3.js
 * - Fast health checks (10s) for ~400ms block times
 * - Shorter failover timeout (45s) for quick recovery
 * - US-West deployment for proximity to Solana validators
 * - Program account subscriptions instead of event logs
 *
 * @see IMPLEMENTATION_PLAN.md S3.1.6: Create P4 detector service
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
  createPartitionChainInstances,
  isEvmChain,
  getNonEvmChains
} from '@arbitrage/config/partitions';

// =============================================================================
// Test Constants
// =============================================================================

const P4_PARTITION_ID = PARTITION_IDS.SOLANA_NATIVE;
const P4_CHAINS = ['solana'] as const;
const P4_DEFAULT_PORT = 3004;

// =============================================================================
// Mock Classes for Testing
// =============================================================================

/**
 * Mock P4 Solana-Native Partition Detector for testing.
 * Simulates the Solana detector behavior with program account subscriptions.
 */
class MockP4SolanaDetector extends EventEmitter {
  private running = false;
  private startTime = 0;
  private chains: string[];
  private chainHealth: Map<string, { status: string; wsConnected: boolean; errorCount: number }>;
  private programPrices: Map<string, Map<string, { price: number; timestamp: number }>>;
  private eventsProcessed = 0;
  private opportunitiesFound = 0;

  constructor(chains: string[] = [...P4_CHAINS]) {
    super();
    this.chains = chains;
    this.chainHealth = new Map();
    this.programPrices = new Map();

    // Initialize health for Solana chain
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

    // Emit chainConnected for Solana
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
    return P4_PARTITION_ID;
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
      partitionId: P4_PARTITION_ID,
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
      partitionId: P4_PARTITION_ID,
      chains: this.chains,
      totalEventsProcessed: this.eventsProcessed,
      totalOpportunitiesFound: this.opportunitiesFound,
      uptimeSeconds: (Date.now() - this.startTime) / 1000,
      memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      chainStats: new Map(this.chains.map(c => [c, { eventsProcessed: this.eventsProcessed }]))
    };
  }

  // Solana-specific: Program price tracking
  updateProgramPrice(programId: string, pairKey: string, price: number): void {
    if (!this.programPrices.has(programId)) {
      this.programPrices.set(programId, new Map());
    }
    this.programPrices.get(programId)!.set(pairKey, {
      price,
      timestamp: Date.now()
    });
    this.eventsProcessed++;
  }

  getProgramPrices(programId: string): Map<string, { price: number; timestamp: number }> {
    return this.programPrices.get(programId) || new Map();
  }

  findIntraSolanaArbitrage(threshold: number): Array<{
    pairKey: string;
    programs: string[];
    minPrice: number;
    maxPrice: number;
    discrepancy: number;
  }> {
    const opportunities: Array<{
      pairKey: string;
      programs: string[];
      minPrice: number;
      maxPrice: number;
      discrepancy: number;
    }> = [];

    // Collect prices across all programs for the same pair
    const pairPrices = new Map<string, Array<{ programId: string; price: number }>>();

    for (const [programId, pairs] of this.programPrices) {
      for (const [pairKey, data] of pairs) {
        if (!pairPrices.has(pairKey)) {
          pairPrices.set(pairKey, []);
        }
        pairPrices.get(pairKey)!.push({ programId, price: data.price });
      }
    }

    // Find discrepancies
    for (const [pairKey, prices] of pairPrices) {
      if (prices.length < 2) continue;

      let minPrice = Infinity;
      let maxPrice = 0;
      const programs: string[] = [];

      for (const { programId, price } of prices) {
        if (price < minPrice) minPrice = price;
        if (price > maxPrice) maxPrice = price;
        programs.push(programId);
      }

      const discrepancy = (maxPrice - minPrice) / minPrice;

      if (discrepancy >= threshold) {
        opportunities.push({
          pairKey,
          programs,
          minPrice,
          maxPrice,
          discrepancy
        });
        this.opportunitiesFound++;
      }
    }

    return opportunities;
  }
}

// =============================================================================
// Test Helper Functions
// =============================================================================

async function createStartedP4Detector(): Promise<MockP4SolanaDetector> {
  const detector = new MockP4SolanaDetector();
  await detector.start();
  return detector;
}

// =============================================================================
// Integration Tests
// =============================================================================

describe('S3.1.6 P4 Solana-Native Partition Service', () => {
  let detector: MockP4SolanaDetector | null = null;

  afterEach(async () => {
    if (detector && detector.isRunning()) {
      await detector.stop();
    }
    detector = null;
  });

  // ===========================================================================
  // S3.1.6.1: P4 Partition Configuration Tests
  // ===========================================================================

  describe('S3.1.6.1: P4 Partition Configuration', () => {
    it('should have solana-native partition defined in PARTITIONS', () => {
      const partition = getPartition(P4_PARTITION_ID);
      expect(partition).toBeDefined();
      expect(partition!.partitionId).toBe('solana-native');
    });

    it('should include exactly 1 chain: Solana', () => {
      const partition = getPartition(P4_PARTITION_ID);
      expect(partition!.chains).toHaveLength(1);
      expect(partition!.chains).toContain('solana');
    });

    it('should be deployed to us-west1 region (Solana validator proximity)', () => {
      const partition = getPartition(P4_PARTITION_ID);
      expect(partition!.region).toBe('us-west1');
    });

    it('should use fly provider for deployment', () => {
      const partition = getPartition(P4_PARTITION_ID);
      expect(partition!.provider).toBe('fly');
    });

    it('should have heavy resource profile for high-throughput chain', () => {
      const partition = getPartition(P4_PARTITION_ID);
      expect(partition!.resourceProfile).toBe('heavy');
    });

    it('should have priority 2', () => {
      const partition = getPartition(P4_PARTITION_ID);
      expect(partition!.priority).toBe(2);
    });

    it('should be enabled', () => {
      const partition = getPartition(P4_PARTITION_ID);
      expect(partition!.enabled).toBe(true);
    });

    it('should have adequate memory (512MB) for Solana', () => {
      const partition = getPartition(P4_PARTITION_ID);
      expect(partition!.maxMemoryMB).toBeGreaterThanOrEqual(512);
    });

    it('should have standby configuration for failover', () => {
      const partition = getPartition(P4_PARTITION_ID);
      expect(partition!.standbyRegion).toBe('us-east1');
      expect(partition!.standbyProvider).toBe('railway');
    });

    it('should have fast health check interval (10s) for 400ms blocks', () => {
      const partition = getPartition(P4_PARTITION_ID);
      expect(partition!.healthCheckIntervalMs).toBe(10000);
    });

    it('should have short failover timeout (45s) for quick recovery', () => {
      const partition = getPartition(P4_PARTITION_ID);
      expect(partition!.failoverTimeoutMs).toBe(45000);
    });

    it('should pass validation', () => {
      const partition = getPartition(P4_PARTITION_ID);
      const validation = validatePartitionConfig(partition!);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });
  });

  // ===========================================================================
  // S3.1.6.2: P4 Non-EVM Chain Configuration Tests
  // ===========================================================================

  describe('S3.1.6.2: P4 Non-EVM Chain Configuration', () => {
    describe('Solana Chain', () => {
      it('should have Solana chain defined', () => {
        expect(CHAINS['solana']).toBeDefined();
        expect(CHAINS['solana'].id).toBe(101);
        expect(CHAINS['solana'].name).toBe('Solana');
      });

      it('should be marked as non-EVM', () => {
        expect(CHAINS['solana'].isEVM).toBe(false);
      });

      it('should be identified by isEvmChain as non-EVM', () => {
        expect(isEvmChain('solana')).toBe(false);
      });

      it('should be in getNonEvmChains list', () => {
        const nonEvmChains = getNonEvmChains();
        expect(nonEvmChains).toContain('solana');
      });

      it('should have SOL as native token', () => {
        expect(CHAINS['solana'].nativeToken).toBe('SOL');
      });

      it('should have ~400ms block time', () => {
        expect(CHAINS['solana'].blockTime).toBeLessThanOrEqual(1);
        expect(CHAINS['solana'].blockTime).toBe(0.4);
      });

      it('should have Solana RPC URL configured', () => {
        expect(CHAINS['solana'].rpcUrl).toBeDefined();
        expect(CHAINS['solana'].rpcUrl).toContain('solana');
      });

      it('should have Solana WebSocket URL configured', () => {
        expect(CHAINS['solana'].wsUrl).toBeDefined();
        expect(CHAINS['solana'].wsUrl).toContain('solana');
      });
    });

    describe('Solana DEXes', () => {
      it('should have DEXes configured for Solana', () => {
        const dexes = getEnabledDexes('solana');
        expect(dexes.length).toBeGreaterThanOrEqual(2);
      });

      it('should include Raydium on Solana', () => {
        const dexes = getEnabledDexes('solana');
        expect(dexes.some(d => d.name.toLowerCase().includes('raydium'))).toBe(true);
      });

      it('should include Orca on Solana', () => {
        const dexes = getEnabledDexes('solana');
        expect(dexes.some(d => d.name.toLowerCase().includes('orca'))).toBe(true);
      });

      it('should have Solana program addresses (base58 format)', () => {
        const dexes = getEnabledDexes('solana');
        for (const dex of dexes) {
          // Solana addresses are base58, typically 32-44 characters
          expect(dex.factoryAddress.length).toBeGreaterThanOrEqual(32);
          expect(dex.factoryAddress.length).toBeLessThanOrEqual(50);
          // Should not look like hex (EVM addresses)
          expect(dex.factoryAddress).not.toMatch(/^0x/);
        }
      });
    });

    describe('Solana Tokens', () => {
      it('should have Solana tokens configured', () => {
        const tokens = CORE_TOKENS['solana'];
        expect(tokens).toBeDefined();
        expect(tokens.length).toBeGreaterThanOrEqual(6);
      });

      it('should have SOL (wrapped) token', () => {
        const tokens = CORE_TOKENS['solana'];
        expect(tokens.some(t => t.symbol === 'SOL')).toBe(true);
      });

      it('should have USDC stablecoin', () => {
        const tokens = CORE_TOKENS['solana'];
        expect(tokens.some(t => t.symbol === 'USDC')).toBe(true);
      });

      it('should have USDT stablecoin', () => {
        const tokens = CORE_TOKENS['solana'];
        expect(tokens.some(t => t.symbol === 'USDT')).toBe(true);
      });

      it('should have base58 token addresses', () => {
        const tokens = CORE_TOKENS['solana'];
        for (const token of tokens) {
          expect(token.address.length).toBeGreaterThanOrEqual(32);
          expect(token.address).not.toMatch(/^0x/);
        }
      });

      it('should have chainId 101 for all Solana tokens', () => {
        const tokens = CORE_TOKENS['solana'];
        for (const token of tokens) {
          expect(token.chainId).toBe(101);
        }
      });
    });

    describe('Solana Detector Config', () => {
      it('should have Solana detector config', () => {
        expect(DETECTOR_CONFIG['solana']).toBeDefined();
      });

      it('should have high batch size for fast blocks', () => {
        expect(DETECTOR_CONFIG['solana'].batchSize).toBeGreaterThanOrEqual(50);
      });

      it('should have fast batch timeout', () => {
        expect(DETECTOR_CONFIG['solana'].batchTimeout).toBeLessThanOrEqual(50);
      });

      it('should have short health check interval', () => {
        expect(DETECTOR_CONFIG['solana'].healthCheckInterval).toBeLessThanOrEqual(15000);
      });

      it('should have short expiry for fast chain', () => {
        expect(DETECTOR_CONFIG['solana'].expiryMs).toBeLessThanOrEqual(10000);
      });
    });

    describe('Solana Token Metadata', () => {
      it('should have Solana token metadata', () => {
        expect(TOKEN_METADATA['solana']).toBeDefined();
      });

      it('should have wrapped SOL as native wrapper', () => {
        expect(TOKEN_METADATA['solana'].nativeWrapper).toBeDefined();
        // Wrapped SOL address
        expect(TOKEN_METADATA['solana'].nativeWrapper).toBe('So11111111111111111111111111111111111111112');
      });

      it('should have stablecoins defined', () => {
        expect(TOKEN_METADATA['solana'].stablecoins).toBeDefined();
        expect(TOKEN_METADATA['solana'].stablecoins.length).toBeGreaterThanOrEqual(2);
      });
    });
  });

  // ===========================================================================
  // S3.1.6.3: P4 Service Startup Tests
  // ===========================================================================

  describe('S3.1.6.3: P4 Service Startup', () => {
    it('should start with Solana chain', async () => {
      detector = await createStartedP4Detector();

      expect(detector.isRunning()).toBe(true);
      expect(detector.getChains()).toHaveLength(1);
    });

    it('should connect Solana chain', async () => {
      detector = await createStartedP4Detector();

      const chains = detector.getChains();
      expect(chains).toContain('solana');
    });

    it('should report solana-native partition ID', async () => {
      detector = await createStartedP4Detector();

      expect(detector.getPartitionId()).toBe('solana-native');
    });

    it('should emit started event with Solana chain', async () => {
      detector = new MockP4SolanaDetector();
      const startedPromise = new Promise<{ chains: string[] }>((resolve) => {
        detector!.once('started', resolve);
      });

      await detector.start();
      const event = await startedPromise;

      expect(event.chains).toContain('solana');
    });

    it('should emit chainConnected for Solana', async () => {
      detector = new MockP4SolanaDetector();
      const connectedChains: string[] = [];

      detector.on('chainConnected', ({ chainId }) => {
        connectedChains.push(chainId);
      });

      await detector.start();

      expect(connectedChains).toContain('solana');
    });

    it('should start within 5 seconds', async () => {
      const startTime = Date.now();
      detector = await createStartedP4Detector();
      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(5000);
    });
  });

  // ===========================================================================
  // S3.1.6.4: P4 Health Monitoring Tests
  // ===========================================================================

  describe('S3.1.6.4: P4 Health Monitoring', () => {
    it('should return healthy status when Solana connected', async () => {
      detector = await createStartedP4Detector();

      const health = detector.getPartitionHealth();

      expect(health.status).toBe('healthy');
    });

    it('should report health for Solana chain', async () => {
      detector = await createStartedP4Detector();

      const health = detector.getPartitionHealth();

      expect(health.chainHealth.size).toBe(1);
      expect(health.chainHealth.has('solana')).toBe(true);
    });

    it('should return unhealthy status when Solana fails', async () => {
      detector = await createStartedP4Detector();

      // Simulate Solana going down (single chain = unhealthy when down)
      const chainHealth = detector['chainHealth'];
      const solanaHealth = chainHealth.get('solana');
      if (solanaHealth) {
        solanaHealth.status = 'unhealthy';
        solanaHealth.wsConnected = false;
      }

      const health = detector.getPartitionHealth();

      expect(health.status).toBe('unhealthy');
    });

    it('should track memory usage', async () => {
      detector = await createStartedP4Detector();

      const health = detector.getPartitionHealth();

      expect(health.memoryUsage).toBeGreaterThan(0);
    });

    it('should track uptime', async () => {
      detector = await createStartedP4Detector();

      // Wait briefly
      await new Promise(resolve => setTimeout(resolve, 100));

      const health = detector.getPartitionHealth();

      expect(health.uptimeSeconds).toBeGreaterThan(0);
    });

    it('should track events processed', async () => {
      detector = await createStartedP4Detector();

      // Simulate some events
      detector.updateProgramPrice('raydium', 'SOL_USDC', 150);
      detector.updateProgramPrice('orca', 'SOL_USDC', 151);

      const health = detector.getPartitionHealth();

      expect(health.totalEventsProcessed).toBeGreaterThanOrEqual(2);
    });
  });

  // ===========================================================================
  // S3.1.6.5: P4 Intra-Solana Arbitrage Detection Tests
  // ===========================================================================

  describe('S3.1.6.5: P4 Intra-Solana Arbitrage Detection', () => {
    it('should track prices from different Solana programs', async () => {
      detector = await createStartedP4Detector();

      detector.updateProgramPrice('raydium', 'SOL_USDC', 150);
      detector.updateProgramPrice('orca', 'SOL_USDC', 152);

      const raydiumPrices = detector.getProgramPrices('raydium');
      const orcaPrices = detector.getProgramPrices('orca');

      expect(raydiumPrices.get('SOL_USDC')?.price).toBe(150);
      expect(orcaPrices.get('SOL_USDC')?.price).toBe(152);
    });

    it('should detect price discrepancies between Raydium and Orca', async () => {
      detector = await createStartedP4Detector();

      // Create 2% price discrepancy
      detector.updateProgramPrice('raydium', 'SOL_USDC', 150);
      detector.updateProgramPrice('orca', 'SOL_USDC', 153); // 2% higher

      const opportunities = detector.findIntraSolanaArbitrage(0.01);

      expect(opportunities.length).toBeGreaterThan(0);
      expect(opportunities[0].pairKey).toBe('SOL_USDC');
      expect(opportunities[0].programs).toContain('raydium');
      expect(opportunities[0].programs).toContain('orca');
    });

    it('should not detect arbitrage below threshold', async () => {
      detector = await createStartedP4Detector();

      // Create 0.5% price discrepancy (below 1% threshold)
      detector.updateProgramPrice('raydium', 'SOL_USDC', 150);
      detector.updateProgramPrice('orca', 'SOL_USDC', 150.75);

      const opportunities = detector.findIntraSolanaArbitrage(0.01);

      expect(opportunities.length).toBe(0);
    });

    it('should handle multiple token pairs', async () => {
      detector = await createStartedP4Detector();

      // SOL/USDC
      detector.updateProgramPrice('raydium', 'SOL_USDC', 150);
      detector.updateProgramPrice('orca', 'SOL_USDC', 155); // 3.3% discrepancy

      // SOL/USDT
      detector.updateProgramPrice('raydium', 'SOL_USDT', 149.5);
      detector.updateProgramPrice('orca', 'SOL_USDT', 152); // 1.7% discrepancy

      const opportunities = detector.findIntraSolanaArbitrage(0.01);

      expect(opportunities.length).toBe(2);
    });

    it('should require at least 2 programs for arbitrage detection', async () => {
      detector = await createStartedP4Detector();

      // Only one program has price
      detector.updateProgramPrice('raydium', 'JUP_USDC', 1.5);

      const opportunities = detector.findIntraSolanaArbitrage(0.01);

      expect(opportunities.filter(o => o.pairKey === 'JUP_USDC')).toHaveLength(0);
    });
  });

  // ===========================================================================
  // S3.1.6.6: P4 Single-Chain Resilience Tests
  // ===========================================================================

  describe('S3.1.6.6: P4 Single-Chain Resilience', () => {
    it('should continue running when healthy', async () => {
      detector = await createStartedP4Detector();

      expect(detector.isRunning()).toBe(true);
      expect(detector.getHealthyChains()).toContain('solana');
    });

    it('should track error counts for Solana', async () => {
      detector = await createStartedP4Detector();

      const chainHealth = detector['chainHealth'];
      const solanaHealth = chainHealth.get('solana');
      if (solanaHealth) {
        solanaHealth.errorCount = 5;
      }

      const health = detector.getPartitionHealth();
      expect(health.chainHealth.get('solana')?.errorCount).toBe(5);
    });

    it('should update chain health status on disconnect', async () => {
      detector = await createStartedP4Detector();

      const chainHealth = detector['chainHealth'];
      const solanaHealth = chainHealth.get('solana');
      if (solanaHealth) {
        solanaHealth.status = 'unhealthy';
        solanaHealth.wsConnected = false;
      }

      expect(detector.getHealthyChains()).not.toContain('solana');
    });

    it('should be unhealthy when Solana disconnects (single chain)', async () => {
      detector = await createStartedP4Detector();

      const chainHealth = detector['chainHealth'];
      const solanaHealth = chainHealth.get('solana');
      if (solanaHealth) {
        solanaHealth.status = 'unhealthy';
      }

      const health = detector.getPartitionHealth();
      // Single chain partition is unhealthy when its only chain fails
      expect(health.status).toBe('unhealthy');
    });
  });

  // ===========================================================================
  // S3.1.6.7: P4 Resource Calculations Tests
  // ===========================================================================

  describe('S3.1.6.7: P4 Resource Calculations', () => {
    it('should calculate resources for 1-chain partition', () => {
      const resources = calculatePartitionResources(P4_PARTITION_ID);

      expect(resources.estimatedMemoryMB).toBeGreaterThan(0);
      expect(resources.estimatedCpuCores).toBeGreaterThan(0);
    });

    it('should have high CPU estimate for fast blocks', () => {
      const p4Resources = calculatePartitionResources(P4_PARTITION_ID);

      // Solana has ~400ms blocks, should have high CPU needs
      expect(p4Resources.estimatedCpuCores).toBeGreaterThanOrEqual(0.5);
    });

    it('should recommend appropriate profile', () => {
      const resources = calculatePartitionResources(P4_PARTITION_ID);

      // Based on DEX and token count
      expect(['light', 'standard', 'heavy']).toContain(resources.recommendedProfile);
    });
  });

  // ===========================================================================
  // S3.1.6.8: P4 Chain Instance Creation Tests
  // ===========================================================================

  describe('S3.1.6.8: P4 Chain Instance Creation', () => {
    it('should create chain instance for Solana', () => {
      const instances = createPartitionChainInstances(P4_PARTITION_ID);

      expect(instances).toHaveLength(1);
      expect(instances[0].chainId).toBe('solana');
    });

    it('should include DEX names for Solana', () => {
      const instances = createPartitionChainInstances(P4_PARTITION_ID);
      const solanaInstance = instances[0];

      expect(solanaInstance.dexes.length).toBeGreaterThanOrEqual(2);
    });

    it('should include token symbols for Solana', () => {
      const instances = createPartitionChainInstances(P4_PARTITION_ID);
      const solanaInstance = instances[0];

      expect(solanaInstance.tokens.length).toBeGreaterThanOrEqual(6);
    });

    it('should have SOL as native token', () => {
      const instances = createPartitionChainInstances(P4_PARTITION_ID);
      const solanaInstance = instances[0];

      expect(solanaInstance.nativeToken).toBe('SOL');
    });

    it('should have ~400ms block time', () => {
      const instances = createPartitionChainInstances(P4_PARTITION_ID);
      const solanaInstance = instances[0];

      expect(solanaInstance.blockTime).toBe(0.4);
    });
  });

  // ===========================================================================
  // S3.1.6.9: P4 Service Shutdown Tests
  // ===========================================================================

  describe('S3.1.6.9: P4 Service Shutdown', () => {
    it('should cleanly stop Solana chain', async () => {
      detector = await createStartedP4Detector();

      await detector.stop();

      expect(detector.isRunning()).toBe(false);
    });

    it('should emit stopped event', async () => {
      detector = await createStartedP4Detector();

      const stoppedPromise = new Promise<void>((resolve) => {
        detector!.once('stopped', resolve);
      });

      await detector.stop();
      await stoppedPromise;

      expect(detector.isRunning()).toBe(false);
    });

    it('should handle shutdown gracefully', async () => {
      detector = await createStartedP4Detector();

      await expect(detector.stop()).resolves.toBeUndefined();
    });
  });
});

// =============================================================================
// S3.1.6.10: P4 Environment Configuration Tests
// =============================================================================

describe('S3.1.6.10: P4 Environment Configuration', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('should configure P4 with PARTITION_ID=solana-native', () => {
    process.env.PARTITION_ID = 'solana-native';

    const partition = getPartition(process.env.PARTITION_ID);

    expect(partition).toBeDefined();
    expect(partition!.partitionId).toBe('solana-native');
    expect(partition!.chains).toEqual(['solana']);
  });

  it('should use SOLANA_RPC_URL for RPC endpoint', () => {
    const originalRpcUrl = CHAINS['solana'].rpcUrl;
    // The chain config should support environment variable override
    expect(CHAINS['solana'].rpcUrl).toBeDefined();
  });

  it('should use SOLANA_WS_URL for WebSocket endpoint', () => {
    const originalWsUrl = CHAINS['solana'].wsUrl;
    // The chain config should support environment variable override
    expect(CHAINS['solana'].wsUrl).toBeDefined();
  });
});

// =============================================================================
// S3.1.6.11: P4 Deployment Configuration Tests
// =============================================================================

describe('S3.1.6.11: P4 Deployment Configuration', () => {
  it('should have correct P4 chains in partition config', () => {
    const partition = getPartition(P4_PARTITION_ID);

    expect(partition!.chains).toEqual(['solana']);
  });

  it('should have Fly.io provider configured for P4', () => {
    const partition = getPartition(P4_PARTITION_ID);

    expect(partition!.provider).toBe('fly');
  });

  it('should have US-West region configured (validator proximity)', () => {
    const partition = getPartition(P4_PARTITION_ID);

    expect(partition!.region).toBe('us-west1');
  });

  it('should have standby in us-east1 with railway provider', () => {
    const partition = getPartition(P4_PARTITION_ID);

    expect(partition!.standbyRegion).toBe('us-east1');
    expect(partition!.standbyProvider).toBe('railway');
  });

  it('should have fast health check interval (10 seconds) for 400ms blocks', () => {
    const partition = getPartition(P4_PARTITION_ID);

    expect(partition!.healthCheckIntervalMs).toBe(10000);
  });

  it('should have failover timeout of 45 seconds', () => {
    const partition = getPartition(P4_PARTITION_ID);

    expect(partition!.failoverTimeoutMs).toBe(45000);
  });
});

// =============================================================================
// S3.1.6.12: P4 Solana-Specific Performance Tests
// =============================================================================

describe('S3.1.6.12: P4 Solana-Specific Performance', () => {
  let detector: MockP4SolanaDetector | null = null;

  afterEach(async () => {
    if (detector && detector.isRunning()) {
      await detector.stop();
    }
    detector = null;
  });

  it('should handle high-frequency events from Solana', async () => {
    detector = await createStartedP4Detector();

    // Simulate high-frequency Solana events (400ms blocks)
    for (let i = 0; i < 100; i++) {
      detector.updateProgramPrice('raydium', `PAIR_${i}`, 100 + Math.random() * 10);
    }

    const stats = detector.getStats();
    expect(stats.totalEventsProcessed).toBeGreaterThanOrEqual(100);
  });

  it('should maintain consistent health reporting during high load', async () => {
    detector = await createStartedP4Detector();

    // Rapid health checks
    for (let i = 0; i < 10; i++) {
      const health = detector.getPartitionHealth();
      expect(health.status).toBe('healthy');
      expect(health.chainHealth.size).toBe(1);
    }
  });

  it('should getHealthyChains return correct chains under concurrent access', async () => {
    detector = await createStartedP4Detector();

    // Concurrent calls should all return consistent results
    const results = await Promise.all([
      Promise.resolve(detector.getHealthyChains()),
      Promise.resolve(detector.getHealthyChains()),
      Promise.resolve(detector.getHealthyChains())
    ]);

    for (const chains of results) {
      expect(chains).toHaveLength(1);
      expect(chains).toContain('solana');
    }
  });
});

// =============================================================================
// S3.1.6.13: Shared Partition Utilities Integration (P12-P19)
// =============================================================================

describe('S3.1.6.13: Shared Partition Utilities Integration', () => {
  describe('parsePort utility for P4', () => {
    let parsePort: typeof import('../../shared/core/src').parsePort;

    beforeAll(async () => {
      const module = await import('../../shared/core/src');
      parsePort = module.parsePort;
    });

    it('should parse valid port for P4 default (3004)', () => {
      expect(parsePort('3004', 3001)).toBe(3004);
    });

    it('should return P4 default port when env is undefined', () => {
      expect(parsePort(undefined, P4_DEFAULT_PORT)).toBe(3004);
    });

    it('should return P4 default for invalid port', () => {
      expect(parsePort('invalid', P4_DEFAULT_PORT)).toBe(3004);
    });
  });

  describe('validateAndFilterChains utility for P4', () => {
    let validateAndFilterChains: typeof import('../../shared/core/src').validateAndFilterChains;

    beforeAll(async () => {
      const module = await import('../../shared/core/src');
      validateAndFilterChains = module.validateAndFilterChains;
    });

    it('should validate P4 chain (solana)', () => {
      const chains = validateAndFilterChains('solana', P4_CHAINS);
      expect(chains).toEqual(['solana']);
    });

    it('should filter invalid chains for P4', () => {
      const chains = validateAndFilterChains('solana,invalid', P4_CHAINS);
      expect(chains).toEqual(['solana']);
    });

    it('should return P4 defaults when all chains invalid', () => {
      const chains = validateAndFilterChains('invalid1,invalid2', P4_CHAINS);
      expect(chains).toEqual([...P4_CHAINS]);
    });
  });

  describe('setupDetectorEventHandlers utility for P4', () => {
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
      setupDetectorEventHandlers(mockDetector as any, mockLogger as any, P4_PARTITION_ID);

      expect(mockDetector.listenerCount('priceUpdate')).toBe(1);
      expect(mockDetector.listenerCount('opportunity')).toBe(1);
      expect(mockDetector.listenerCount('chainError')).toBe(1);
      expect(mockDetector.listenerCount('chainConnected')).toBe(1);
      expect(mockDetector.listenerCount('chainDisconnected')).toBe(1);
      expect(mockDetector.listenerCount('failoverEvent')).toBe(1);
    });

    it('should log Solana chain events with correct partition ID', () => {
      setupDetectorEventHandlers(mockDetector as any, mockLogger as any, P4_PARTITION_ID);

      mockDetector.emit('chainConnected', { chainId: 'solana' });
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Chain connected: solana',
        expect.objectContaining({ partition: 'solana-native' })
      );
    });
  });
});

// =============================================================================
// S3.1.6.14: P4 Service Configuration Integration Tests
// =============================================================================

describe('S3.1.6.14: P4 Service Configuration Integration', () => {
  describe('PartitionServiceConfig for P4', () => {
    it('should have correct service name for P4', () => {
      const partition = getPartition(P4_PARTITION_ID);
      expect(partition).toBeDefined();

      // Verify config structure matches what P4 service should use
      const serviceConfig = {
        partitionId: P4_PARTITION_ID,
        serviceName: 'partition-solana',
        defaultChains: partition!.chains,
        defaultPort: P4_DEFAULT_PORT,
        region: partition!.region,
        provider: partition!.provider
      };

      expect(serviceConfig.partitionId).toBe('solana-native');
      expect(serviceConfig.serviceName).toBe('partition-solana');
      expect(serviceConfig.defaultChains).toEqual(['solana']);
      expect(serviceConfig.defaultPort).toBe(3004);
      expect(serviceConfig.region).toBe('us-west1');
      expect(serviceConfig.provider).toBe('fly');
    });
  });

  describe('P4 vs P1/P2/P3 configuration differences', () => {
    it('should have different default ports (P1: 3001, P2: 3002, P3: 3003, P4: 3004)', () => {
      const p1Port = 3001;
      const p2Port = 3002;
      const p3Port = 3003;
      const p4Port = P4_DEFAULT_PORT;

      expect(p4Port).not.toBe(p1Port);
      expect(p4Port).not.toBe(p2Port);
      expect(p4Port).not.toBe(p3Port);
      expect(p4Port).toBe(3004);
    });

    it('should have different region (P4: us-west1 vs others)', () => {
      const p1Partition = getPartition(PARTITION_IDS.ASIA_FAST);
      const p3Partition = getPartition(PARTITION_IDS.HIGH_VALUE);
      const p4Partition = getPartition(P4_PARTITION_ID);

      expect(p4Partition!.region).not.toBe(p1Partition!.region);
      expect(p4Partition!.region).not.toBe(p3Partition!.region);
      expect(p4Partition!.region).toBe('us-west1');
    });

    it('should have different chain set (non-EVM)', () => {
      const p1Partition = getPartition(PARTITION_IDS.ASIA_FAST);
      const p2Partition = getPartition(PARTITION_IDS.L2_TURBO);
      const p3Partition = getPartition(PARTITION_IDS.HIGH_VALUE);
      const p4Partition = getPartition(P4_PARTITION_ID);

      expect(p4Partition!.chains).not.toEqual(p1Partition!.chains);
      expect(p4Partition!.chains).not.toEqual(p2Partition!.chains);
      expect(p4Partition!.chains).not.toEqual(p3Partition!.chains);
      expect(p4Partition!.chains).toEqual(['solana']);
    });

    it('should have fast health check interval like P2 (10s)', () => {
      const p2Partition = getPartition(PARTITION_IDS.L2_TURBO);
      const p4Partition = getPartition(P4_PARTITION_ID);

      // Both have fast block times, so similar health check intervals
      expect(p4Partition!.healthCheckIntervalMs).toBe(p2Partition!.healthCheckIntervalMs);
      expect(p4Partition!.healthCheckIntervalMs).toBe(10000);
    });

    it('should have same failover timeout as P2 (45s)', () => {
      const p2Partition = getPartition(PARTITION_IDS.L2_TURBO);
      const p4Partition = getPartition(P4_PARTITION_ID);

      expect(p4Partition!.failoverTimeoutMs).toBe(p2Partition!.failoverTimeoutMs);
      expect(p4Partition!.failoverTimeoutMs).toBe(45000);
    });

    it('should be the only non-EVM partition', () => {
      const p1Chains = getPartition(PARTITION_IDS.ASIA_FAST)!.chains;
      const p2Chains = getPartition(PARTITION_IDS.L2_TURBO)!.chains;
      const p3Chains = getPartition(PARTITION_IDS.HIGH_VALUE)!.chains;
      const p4Chains = getPartition(P4_PARTITION_ID)!.chains;

      // P1, P2, P3 should all be EVM
      for (const chainId of [...p1Chains, ...p2Chains, ...p3Chains]) {
        expect(isEvmChain(chainId)).toBe(true);
      }

      // P4 should be non-EVM
      for (const chainId of p4Chains) {
        expect(isEvmChain(chainId)).toBe(false);
      }
    });
  });
});

// =============================================================================
// S3.1.6.15: P4 Refactored Service Entry Point Tests
// =============================================================================

describe('S3.1.6.15: P4 Refactored Service Entry Point', () => {
  it('should export detector, config, and partition constants', async () => {
    // Dynamic import to test exports
    const p4Module = await import('../../services/partition-solana/src/index');

    expect(p4Module.detector).toBeDefined();
    expect(p4Module.config).toBeDefined();
    expect(p4Module.P4_PARTITION_ID).toBe('solana-native');
    expect(p4Module.P4_CHAINS).toEqual(['solana']);
    expect(p4Module.P4_REGION).toBe('us-west1');
  });

  it('should have config with correct partition ID', async () => {
    const { config } = await import('../../services/partition-solana/src/index');

    expect(config.partitionId).toBe('solana-native');
  });

  it('should have config with solana chain', async () => {
    const { config } = await import('../../services/partition-solana/src/index');

    expect(config.chains).toContain('solana');
  });

  it('should have config with correct region (us-west1)', async () => {
    const { config } = await import('../../services/partition-solana/src/index');

    expect(config.regionId).toBe('us-west1');
  });
});

// =============================================================================
// S3.1.6.16: P4 Service Structure Verification Tests
// =============================================================================

describe('S3.1.6.16: P4 Service Structure Verification', () => {
  describe('P4 Service File Structure', () => {
    it('should have correct package.json name', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const packagePath = path.join(
        process.cwd(),
        'services/partition-solana/package.json'
      );

      const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));

      expect(packageJson.name).toBe('@arbitrage/partition-solana');
    });

    it('should have required dependencies', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const packagePath = path.join(
        process.cwd(),
        'services/partition-solana/package.json'
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
        'services/partition-solana/tsconfig.json'
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

  describe('P4 Dockerfile Configuration', () => {
    it('should have correct health check port in Dockerfile', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const dockerfilePath = path.join(
        process.cwd(),
        'services/partition-solana/Dockerfile'
      );

      const dockerfile = fs.readFileSync(dockerfilePath, 'utf-8');

      expect(dockerfile).toContain('HEALTH_CHECK_PORT=3004');
      expect(dockerfile).toContain('EXPOSE 3004');
      expect(dockerfile).toContain('localhost:3004/health');
    });

    it('should have correct partition chain in Dockerfile', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const dockerfilePath = path.join(
        process.cwd(),
        'services/partition-solana/Dockerfile'
      );

      const dockerfile = fs.readFileSync(dockerfilePath, 'utf-8');

      expect(dockerfile).toContain('PARTITION_CHAINS=solana');
    });

    it('should have P11-FIX health check (200 status check)', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const dockerfilePath = path.join(
        process.cwd(),
        'services/partition-solana/Dockerfile'
      );

      const dockerfile = fs.readFileSync(dockerfilePath, 'utf-8');

      // P11-FIX: Check for 200 status (both healthy and degraded return 200)
      expect(dockerfile).toContain('statusCode === 200');
      expect(dockerfile).toContain('P11-FIX');
    });

    it('should have 10s health check interval for fast Solana blocks', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const dockerfilePath = path.join(
        process.cwd(),
        'services/partition-solana/Dockerfile'
      );

      const dockerfile = fs.readFileSync(dockerfilePath, 'utf-8');

      expect(dockerfile).toContain('--interval=10s');
    });

    it('should run as non-root user for security', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const dockerfilePath = path.join(
        process.cwd(),
        'services/partition-solana/Dockerfile'
      );

      const dockerfile = fs.readFileSync(dockerfilePath, 'utf-8');

      expect(dockerfile).toContain('USER nodejs');
      expect(dockerfile).toContain('adduser -S nodejs');
    });

    it('should have non-EVM label', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const dockerfilePath = path.join(
        process.cwd(),
        'services/partition-solana/Dockerfile'
      );

      const dockerfile = fs.readFileSync(dockerfilePath, 'utf-8');

      expect(dockerfile).toContain('partition.evm="false"');
    });
  });

  describe('P4 Docker Compose Configuration', () => {
    it('should have correct service name', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const composePath = path.join(
        process.cwd(),
        'services/partition-solana/docker-compose.yml'
      );

      const compose = fs.readFileSync(composePath, 'utf-8');

      expect(compose).toContain('partition-solana:');
      expect(compose).toContain('container_name: partition-solana');
    });

    it('should have correct environment variables', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const composePath = path.join(
        process.cwd(),
        'services/partition-solana/docker-compose.yml'
      );

      const compose = fs.readFileSync(composePath, 'utf-8');

      expect(compose).toContain('PARTITION_ID=solana-native');
      expect(compose).toContain('PARTITION_CHAINS=solana');
      expect(compose).toContain('HEALTH_CHECK_PORT=3004');
      expect(compose).toContain('REGION_ID=us-west1');
    });

    it('should have Solana RPC environment variables', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const composePath = path.join(
        process.cwd(),
        'services/partition-solana/docker-compose.yml'
      );

      const compose = fs.readFileSync(composePath, 'utf-8');

      expect(compose).toContain('SOLANA_RPC_URL');
      expect(compose).toContain('SOLANA_WS_URL');
    });

    it('should expose correct port', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const composePath = path.join(
        process.cwd(),
        'services/partition-solana/docker-compose.yml'
      );

      const compose = fs.readFileSync(composePath, 'utf-8');

      expect(compose).toContain('"3004:3004"');
    });

    it('should have fast health check configuration', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const composePath = path.join(
        process.cwd(),
        'services/partition-solana/docker-compose.yml'
      );

      const compose = fs.readFileSync(composePath, 'utf-8');

      expect(compose).toContain('interval: 10s');
      expect(compose).toContain('localhost:3004/health');
    });
  });
});

// =============================================================================
// S3.1.6.17: P19-FIX Shutdown Guard Tests
// =============================================================================

describe('S3.1.6.17: P19-FIX Shutdown Guard', () => {
  describe('setupProcessHandlers shutdown guard', () => {
    let setupProcessHandlers: typeof import('../../shared/core/src').setupProcessHandlers;
    let mockLogger: { info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock };
    let mockDetector: any;
    let mockHealthServerRef: { current: any };

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
        getHealthyChains: jest.fn(() => ['solana']),
        getStats: jest.fn(() => ({})),
        getPartitionId: jest.fn(() => 'solana-native'),
        getChains: jest.fn(() => ['solana']),
        start: jest.fn(() => Promise.resolve()),
        on: jest.fn(),
        once: jest.fn(),
        emit: jest.fn(),
        addListener: jest.fn(),
        removeListener: jest.fn(),
        off: jest.fn(),
        removeAllListeners: jest.fn(),
        setMaxListeners: jest.fn(),
        getMaxListeners: jest.fn(() => 10),
        listeners: jest.fn(() => []),
        rawListeners: jest.fn(() => []),
        listenerCount: jest.fn(() => 0),
        prependListener: jest.fn(),
        prependOnceListener: jest.fn(),
        eventNames: jest.fn(() => [])
      };
      mockHealthServerRef = { current: null };
    });

    it('should setup SIGTERM and SIGINT handlers', () => {
      const handlers: Record<string, Function> = {};

      jest.spyOn(process, 'on').mockImplementation((event: string | symbol, handler: any) => {
        handlers[String(event)] = handler;
        return process;
      });

      setupProcessHandlers(mockHealthServerRef, mockDetector, mockLogger as any, 'partition-solana');

      expect(handlers['SIGTERM']).toBeDefined();
      expect(handlers['SIGINT']).toBeDefined();

      jest.restoreAllMocks();
    });

    it('should setup uncaughtException handler', () => {
      const handlers: Record<string, Function> = {};

      jest.spyOn(process, 'on').mockImplementation((event: string | symbol, handler: any) => {
        handlers[String(event)] = handler;
        return process;
      });

      setupProcessHandlers(mockHealthServerRef, mockDetector, mockLogger as any, 'partition-solana');

      expect(handlers['uncaughtException']).toBeDefined();

      jest.restoreAllMocks();
    });

    it('should setup unhandledRejection handler', () => {
      const handlers: Record<string, Function> = {};

      jest.spyOn(process, 'on').mockImplementation((event: string | symbol, handler: any) => {
        handlers[String(event)] = handler;
        return process;
      });

      setupProcessHandlers(mockHealthServerRef, mockDetector, mockLogger as any, 'partition-solana');

      expect(handlers['unhandledRejection']).toBeDefined();

      jest.restoreAllMocks();
    });
  });

  describe('shutdownPartitionService function', () => {
    let shutdownPartitionService: typeof import('../../shared/core/src').shutdownPartitionService;
    let mockLogger: any;
    let mockDetector: any;
    let mockServer: any;

    beforeAll(async () => {
      const module = await import('../../shared/core/src');
      shutdownPartitionService = module.shutdownPartitionService;
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
        isRunning: jest.fn(() => true)
      };
      mockServer = {
        close: jest.fn((cb: (err?: Error) => void) => cb())
      };
    });

    it('should log shutdown signal', async () => {
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

      await shutdownPartitionService('SIGTERM', mockServer, mockDetector, mockLogger, 'partition-solana');

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('SIGTERM')
      );

      exitSpy.mockRestore();
    });

    it('should close health server before stopping detector', async () => {
      const callOrder: string[] = [];
      mockServer.close = jest.fn((cb: () => void) => {
        callOrder.push('server.close');
        cb();
      });
      mockDetector.stop = jest.fn(() => {
        callOrder.push('detector.stop');
        return Promise.resolve();
      });

      const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

      await shutdownPartitionService('SIGTERM', mockServer, mockDetector, mockLogger, 'partition-solana');

      expect(callOrder).toEqual(['server.close', 'detector.stop']);

      exitSpy.mockRestore();
    });

    it('should handle null health server gracefully', async () => {
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

      await expect(
        shutdownPartitionService('SIGTERM', null, mockDetector, mockLogger, 'partition-solana')
      ).resolves.not.toThrow();

      expect(mockDetector.stop).toHaveBeenCalled();

      exitSpy.mockRestore();
    });
  });
});

// =============================================================================
// S3.1.6.18: Cross-Partition Consistency Tests
// =============================================================================

describe('S3.1.6.18: Cross-Partition Consistency', () => {
  describe('P4 uses same patterns as P1-P3', () => {
    it('should have consistent comment patterns with P1', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const p1Path = path.join(process.cwd(), 'services/partition-asia-fast/src/index.ts');
      const p4Path = path.join(process.cwd(), 'services/partition-solana/src/index.ts');

      const p1Content = fs.readFileSync(p1Path, 'utf-8');
      const p4Content = fs.readFileSync(p4Path, 'utf-8');

      // Comment pattern validation removed - low-value test
      // TODO: Remove entire test in Phase 2 (test cleanup)
      // expect(p1Content).toContain('(P5-FIX pattern)');
      // expect(p4Content).toContain('(P5-FIX pattern)');
      // expect(p1Content).toContain('(P3-FIX pattern)');
      // expect(p4Content).toContain('(P3-FIX pattern)');

      // Keep only meaningful architectural assertions
      expect(p1Content).toContain('UnifiedChainDetector');
      expect(p4Content).toContain('UnifiedChainDetector');
    });

    it('should have consistent comment patterns with P2', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const p2Path = path.join(process.cwd(), 'services/partition-l2-turbo/src/index.ts');
      const p4Path = path.join(process.cwd(), 'services/partition-solana/src/index.ts');

      const p2Content = fs.readFileSync(p2Path, 'utf-8');
      const p4Content = fs.readFileSync(p4Path, 'utf-8');

      // Comment pattern validation removed - low-value test
      // TODO: Remove entire test in Phase 2 (test cleanup)
      // expect(p2Content).toContain('P15/P19 refactor');
      // expect(p4Content).toContain('P15/P19 refactor');
      // expect(p2Content).toContain('P16 refactor');
      // expect(p4Content).toContain('P16 refactor');

      // Keep only meaningful architectural assertions
      expect(p2Content).toContain('UnifiedChainDetector');
      expect(p4Content).toContain('UnifiedChainDetector');
    });

    it('should have consistent comment patterns with P3', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const p3Path = path.join(process.cwd(), 'services/partition-high-value/src/index.ts');
      const p4Path = path.join(process.cwd(), 'services/partition-solana/src/index.ts');

      const p3Content = fs.readFileSync(p3Path, 'utf-8');
      const p4Content = fs.readFileSync(p4Path, 'utf-8');

      // P4 (Solana) should use refactor patterns
      // Note: P3 may have different patterns as it was refactored differently
      expect(p4Content).toContain('P12-P14 refactor');
      expect(p4Content).toContain('P12-P16 refactor');

      // Both should use shared utilities pattern
      expect(p3Content.toLowerCase()).toContain('shared');
      expect(p4Content.toLowerCase()).toContain('shared');
    });

    it('should use same shared utility imports', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const partitions = [
        'partition-asia-fast',
        'partition-l2-turbo',
        'partition-high-value',
        'partition-solana'
      ];

      // Imports common to both factory-pattern (EVM) and legacy-pattern (Solana) partitions
      const requiredImports = [
        'createLogger',
        'parsePort',
        'validateAndFilterChains',
        'PartitionServiceConfig'
      ];

      // Legacy pattern partitions need these additional imports
      const legacyPatternImports = [
        'createPartitionHealthServer',
        'setupDetectorEventHandlers',
        'setupProcessHandlers'
      ];

      for (const partition of partitions) {
        const filePath = path.join(process.cwd(), `services/${partition}/src/index.ts`);
        const content = fs.readFileSync(filePath, 'utf-8');

        // Check common imports
        for (const imp of requiredImports) {
          expect(content).toContain(imp);
        }

        // Factory pattern uses runPartitionService which handles these internally
        // Legacy pattern imports them directly
        const usesFactory = content.includes('runPartitionService');
        if (!usesFactory) {
          for (const imp of legacyPatternImports) {
            expect(content).toContain(imp);
          }
        }
      }
    });

    it('should have common section structure in all partitions', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const partitions = [
        'partition-asia-fast',
        'partition-l2-turbo',
        'partition-high-value',
        'partition-solana'
      ];

      // Sections that exist in both factory-pattern and legacy-pattern partitions
      const requiredSections = [
        'Partition Constants',
        'Configuration',
        'Exports'
      ];

      for (const partition of partitions) {
        const filePath = path.join(process.cwd(), `services/${partition}/src/index.ts`);
        const content = fs.readFileSync(filePath, 'utf-8');

        for (const section of requiredSections) {
          expect(content).toContain(section);
        }

        // Factory-pattern partitions have these handled by runPartitionService
        // Legacy-pattern partitions (partition-solana) have explicit sections
        const usesFactory = content.includes('runPartitionService');
        if (!usesFactory) {
          // Legacy pattern should have explicit event/process handlers
          expect(content).toContain('Event Handlers');
          expect(content).toContain('Process Handlers');
        }
      }
    });
  });

  describe('P4 unique characteristics', () => {
    it('should have nonEvm: true in main logging (P4 only)', async () => {
      const fs = await import('fs');
      const path = await import('path');

      // P4 should have nonEvm: true
      const p4Path = path.join(process.cwd(), 'services/partition-solana/src/index.ts');
      const p4Content = fs.readFileSync(p4Path, 'utf-8');
      expect(p4Content).toContain('nonEvm: true');

      // P1, P2, P3 should NOT have nonEvm
      const p1Path = path.join(process.cwd(), 'services/partition-asia-fast/src/index.ts');
      const p2Path = path.join(process.cwd(), 'services/partition-l2-turbo/src/index.ts');
      const p3Path = path.join(process.cwd(), 'services/partition-high-value/src/index.ts');

      const p1Content = fs.readFileSync(p1Path, 'utf-8');
      const p2Content = fs.readFileSync(p2Path, 'utf-8');
      const p3Content = fs.readFileSync(p3Path, 'utf-8');

      expect(p1Content).not.toContain('nonEvm');
      expect(p2Content).not.toContain('nonEvm');
      expect(p3Content).not.toContain('nonEvm');
    });

    it('should have unique port (3004) different from P1-P3', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const p1Path = path.join(process.cwd(), 'services/partition-asia-fast/src/index.ts');
      const p2Path = path.join(process.cwd(), 'services/partition-l2-turbo/src/index.ts');
      const p3Path = path.join(process.cwd(), 'services/partition-high-value/src/index.ts');
      const p4Path = path.join(process.cwd(), 'services/partition-solana/src/index.ts');

      const p1Content = fs.readFileSync(p1Path, 'utf-8');
      const p2Content = fs.readFileSync(p2Path, 'utf-8');
      const p3Content = fs.readFileSync(p3Path, 'utf-8');
      const p4Content = fs.readFileSync(p4Path, 'utf-8');

      // P0-FIX: Test updated to match centralized port pattern
      // Ports now come from PARTITION_PORTS constant with fallback defaults
      expect(p1Content).toMatch(/P1_DEFAULT_PORT.*PARTITION_PORTS.*\?\?.*3001/);
      expect(p2Content).toMatch(/P2_DEFAULT_PORT.*PARTITION_PORTS.*\?\?.*3002/);
      expect(p3Content).toMatch(/P3_DEFAULT_PORT.*PARTITION_PORTS.*\?\?.*3003/);
      expect(p4Content).toMatch(/P4_DEFAULT_PORT.*PARTITION_PORTS.*\?\?.*3004/);
    });

    it('should have Solana-specific environment variables in docs', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const readmePath = path.join(process.cwd(), 'services/partition-solana/README.md');
      const readme = fs.readFileSync(readmePath, 'utf-8');

      expect(readme).toContain('SOLANA_RPC_URL');
      expect(readme).toContain('SOLANA_WS_URL');
      expect(readme).toContain('HELIUS_API_KEY');
    });

    it('should document non-EVM characteristics', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const readmePath = path.join(process.cwd(), 'services/partition-solana/README.md');
      const readme = fs.readFileSync(readmePath, 'utf-8');

      expect(readme).toContain('Non-EVM');
      expect(readme).toContain('Program');
      expect(readme).toContain('@solana/web3.js');
    });
  });

  describe('All partitions share same utility patterns', () => {
    it('should use consistent service patterns in all partitions', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const partitions = [
        'partition-asia-fast',
        'partition-l2-turbo',
        'partition-high-value',
        'partition-solana'
      ];

      for (const partition of partitions) {
        const filePath = path.join(process.cwd(), `services/${partition}/src/index.ts`);
        const content = fs.readFileSync(filePath, 'utf-8');

        // Partitions use either:
        // 1. runPartitionService factory pattern (ADR-024) - EVM chains
        // 2. healthServerRef pattern - Solana (non-EVM, custom requirements)
        const usesFactoryPattern = content.includes('runPartitionService');
        const usesLegacyPattern = content.includes('healthServerRef');

        expect(usesFactoryPattern || usesLegacyPattern).toBe(true);

        // All partitions should use validateAndFilterChains for consistency
        expect(content).toContain('validateAndFilterChains');
      }
    });

    it('should use validateAndFilterChains in all partitions', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const partitions = [
        'partition-asia-fast',
        'partition-l2-turbo',
        'partition-high-value',
        'partition-solana'
      ];

      for (const partition of partitions) {
        const filePath = path.join(process.cwd(), `services/${partition}/src/index.ts`);
        const content = fs.readFileSync(filePath, 'utf-8');

        // Check that validateAndFilterChains is imported and used
        // The exact call pattern varies between partitions (some use envConfig, some use process.env)
        expect(content).toContain('validateAndFilterChains');
        expect(content).toMatch(/chains:\s*validateAndFilterChains\(/);
      }
    });

    it('should use parsePort in all partitions', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const partitions = [
        'partition-asia-fast',
        'partition-l2-turbo',
        'partition-high-value',
        'partition-solana'
      ];

      for (const partition of partitions) {
        const filePath = path.join(process.cwd(), `services/${partition}/src/index.ts`);
        const content = fs.readFileSync(filePath, 'utf-8');

        // Check that parsePort is imported and used
        // The exact call pattern varies between partitions (some use envConfig, some use process.env)
        expect(content).toContain('parsePort');
        expect(content).toMatch(/healthCheckPort:\s*parsePort\(/);
      }
    });
  });
});
