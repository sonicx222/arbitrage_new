/**
 * Parameterized Partition Configuration Integration Tests
 *
 * Consolidates S3.1.3, S3.1.4, S3.1.5, S3.1.6 partition tests into a single
 * parameterized test suite using describe.each().
 *
 * Tested partitions:
 * - P1 (asia-fast): BSC, Polygon, Avalanche, Fantom
 * - P2 (l2-turbo): Arbitrum, Optimism, Base
 * - P3 (high-value): Ethereum, zkSync, Linea
 * - P4 (solana-native): Solana (non-EVM)
 *
 * @see IMPLEMENTATION_PLAN.md S3.1.x: Create partition detector services
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
    this.removeAllListeners(); // Clean up listeners to prevent memory leaks
  }

  subscribe(_subscription: unknown): void {
    // Mock subscription
  }

  getConnectionStats() {
    return { connected: this.connected, reconnects: 0 };
  }
}

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
  type PartitionedDetectorConfig,
  type PartitionedDetectorDeps,
  type TokenNormalizeFn
} from '@arbitrage/core';

import {
  PARTITIONS,
  getPartition,
  createChainInstance,
  createPartitionChainInstances,
  calculatePartitionResources,
  validatePartitionConfig,
  isEvmChain
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
// Test Data - All Partition Configurations
// =============================================================================

interface PartitionTestData {
  partitionId: string;
  partitionKey: keyof typeof PARTITION_IDS;
  name: string;
  chains: readonly string[];
  chainCount: number;
  region: string;
  provider: string;
  resourceProfile: string;
  priority: number;
  healthCheckIntervalMs: number;
  failoverTimeoutMs: number;
  standbyRegion: string;
  standbyProvider: string;
  minMemoryMB: number;
  minDexCount: number;
  isEvm: boolean;
  chainIds: Record<string, number>;
  nativeTokens: Record<string, string>;
  nativeWrappers: Record<string, string>;
  minTokensPerChain: Record<string, number>;
  minDexesPerChain: Record<string, number>;
}

const PARTITION_TEST_DATA: PartitionTestData[] = [
  {
    partitionId: 'asia-fast',
    partitionKey: 'ASIA_FAST',
    name: 'P1 Asia-Fast',
    chains: ['bsc', 'polygon', 'avalanche', 'fantom'],
    chainCount: 4,
    region: 'asia-southeast1',
    provider: 'oracle',
    resourceProfile: 'heavy',
    priority: 1,
    healthCheckIntervalMs: 15000,
    failoverTimeoutMs: 60000,
    standbyRegion: 'us-west1',
    standbyProvider: 'render',
    minMemoryMB: 512,
    minDexCount: 14,
    isEvm: true,
    chainIds: { bsc: 56, polygon: 137, avalanche: 43114, fantom: 250 },
    nativeTokens: { bsc: 'BNB', polygon: 'MATIC', avalanche: 'AVAX', fantom: 'FTM' },
    nativeWrappers: {
      bsc: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
      polygon: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
      avalanche: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
      fantom: '0x21be370D5312f44cB42ce377BC9b8a0cEF1A4C83'
    },
    minTokensPerChain: { bsc: 8, polygon: 8, avalanche: 6, fantom: 5 },
    minDexesPerChain: { bsc: 5, polygon: 3, avalanche: 2, fantom: 2 }
  },
  {
    partitionId: 'l2-turbo',
    partitionKey: 'L2_TURBO',
    name: 'P2 L2-Turbo',
    chains: ['arbitrum', 'optimism', 'base'],
    chainCount: 3,
    region: 'asia-southeast1',
    provider: 'fly',
    resourceProfile: 'standard',
    priority: 1,
    healthCheckIntervalMs: 10000,
    failoverTimeoutMs: 45000,
    standbyRegion: 'us-east1',
    standbyProvider: 'railway',
    minMemoryMB: 256,
    minDexCount: 8,
    isEvm: true,
    chainIds: { arbitrum: 42161, optimism: 10, base: 8453 },
    nativeTokens: { arbitrum: 'ETH', optimism: 'ETH', base: 'ETH' },
    nativeWrappers: {
      arbitrum: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
      optimism: '0x4200000000000000000000000000000000000006',
      base: '0x4200000000000000000000000000000000000006'
    },
    minTokensPerChain: { arbitrum: 8, optimism: 8, base: 8 },
    minDexesPerChain: { arbitrum: 3, optimism: 2, base: 2 }
  },
  {
    partitionId: 'high-value',
    partitionKey: 'HIGH_VALUE',
    name: 'P3 High-Value',
    chains: ['ethereum', 'zksync', 'linea'],
    chainCount: 3,
    region: 'us-east1',
    provider: 'oracle',
    resourceProfile: 'heavy',
    priority: 2,
    healthCheckIntervalMs: 30000,
    failoverTimeoutMs: 60000,
    standbyRegion: 'eu-west1',
    standbyProvider: 'gcp',
    minMemoryMB: 256,
    minDexCount: 5,
    isEvm: true,
    chainIds: { ethereum: 1, zksync: 324, linea: 59144 },
    nativeTokens: { ethereum: 'ETH', zksync: 'ETH', linea: 'ETH' },
    nativeWrappers: {
      ethereum: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      zksync: '0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91',
      linea: '0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f'
    },
    minTokensPerChain: { ethereum: 6, zksync: 5, linea: 5 },
    minDexesPerChain: { ethereum: 2, zksync: 1, linea: 1 }
  },
  {
    partitionId: 'solana-native',
    partitionKey: 'SOLANA_NATIVE',
    name: 'P4 Solana-Native',
    chains: ['solana'],
    chainCount: 1,
    region: 'us-west1',
    provider: 'fly',
    resourceProfile: 'heavy',
    priority: 2,
    healthCheckIntervalMs: 10000,
    failoverTimeoutMs: 45000,
    standbyRegion: 'us-east1',
    standbyProvider: 'railway',
    minMemoryMB: 256,
    minDexCount: 3,
    isEvm: false,
    chainIds: { solana: 101 },
    nativeTokens: { solana: 'SOL' },
    nativeWrappers: { solana: 'So11111111111111111111111111111111111111112' },
    minTokensPerChain: { solana: 10 },
    minDexesPerChain: { solana: 3 }
  }
];

// =============================================================================
// Test Helpers
// =============================================================================

const mockNormalizeToken: TokenNormalizeFn = (symbol: string) => {
  const upper = symbol.toUpperCase().trim();
  const aliases: Record<string, string> = {
    'FUSDT': 'USDT', 'WFTM': 'FTM', 'WAVAX': 'AVAX',
    'WETH.E': 'WETH', 'WBTC.E': 'WBTC', 'USDT.E': 'USDT',
    'WBNB': 'BNB', 'BTCB': 'WBTC', 'ETH': 'WETH',
    'WMATIC': 'MATIC', 'WETH': 'WETH', 'WBTC': 'WBTC',
    'USDC': 'USDC', 'USDT': 'USDT', 'DAI': 'DAI',
    'WSOL': 'SOL'
  };
  return aliases[upper] || upper;
};

const createMockDetectorDeps = (): PartitionedDetectorDeps => ({
  logger: mockLogger,
  perfLogger: mockPerfLogger as any,
  normalizeToken: mockNormalizeToken
});

function createPartitionConfig(
  partitionId: string,
  chains: readonly string[],
  region: string,
  overrides: Partial<PartitionedDetectorConfig> = {}
): PartitionedDetectorConfig {
  return {
    partitionId,
    chains: [...chains],
    region,
    healthCheckIntervalMs: 100000,
    failoverTimeoutMs: 60000,
    ...overrides
  };
}

async function createStartedDetector(
  partitionId: string,
  chains: readonly string[],
  region: string
): Promise<PartitionedDetector> {
  const config = createPartitionConfig(partitionId, chains, region);
  const detector = new PartitionedDetector(config, createMockDetectorDeps());
  await detector.start();
  return detector;
}

// =============================================================================
// Parameterized Partition Tests
// =============================================================================

describe.each(PARTITION_TEST_DATA)(
  '$name Partition Configuration',
  (testData) => {
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

    // =========================================================================
    // Partition Configuration Tests
    // =========================================================================

    describe('Partition Configuration', () => {
      it(`should have ${testData.partitionId} partition defined in PARTITIONS`, () => {
        const partition = getPartition(testData.partitionId);
        expect(partition).toBeDefined();
        expect(partition!.partitionId).toBe(testData.partitionId);
      });

      it(`should include exactly ${testData.chainCount} chains`, () => {
        const partition = getPartition(testData.partitionId);
        expect(partition!.chains).toHaveLength(testData.chainCount);
        for (const chain of testData.chains) {
          expect(partition!.chains).toContain(chain);
        }
      });

      it(`should be deployed to ${testData.region} region`, () => {
        const partition = getPartition(testData.partitionId);
        expect(partition!.region).toBe(testData.region);
      });

      it(`should use ${testData.provider} provider for deployment`, () => {
        const partition = getPartition(testData.partitionId);
        expect(partition!.provider).toBe(testData.provider);
      });

      it(`should have ${testData.resourceProfile} resource profile`, () => {
        const partition = getPartition(testData.partitionId);
        expect(partition!.resourceProfile).toBe(testData.resourceProfile);
      });

      it(`should have priority ${testData.priority}`, () => {
        const partition = getPartition(testData.partitionId);
        expect(partition!.priority).toBe(testData.priority);
      });

      it('should be enabled', () => {
        const partition = getPartition(testData.partitionId);
        expect(partition!.enabled).toBe(true);
      });

      it(`should have adequate memory (>= ${testData.minMemoryMB}MB)`, () => {
        const partition = getPartition(testData.partitionId);
        expect(partition!.maxMemoryMB).toBeGreaterThanOrEqual(testData.minMemoryMB);
      });

      it('should have standby configuration for failover', () => {
        const partition = getPartition(testData.partitionId);
        expect(partition!.standbyRegion).toBe(testData.standbyRegion);
        expect(partition!.standbyProvider).toBe(testData.standbyProvider);
      });

      it('should pass validation', () => {
        const partition = getPartition(testData.partitionId);
        const validation = validatePartitionConfig(partition!);
        expect(validation.valid).toBe(true);
        expect(validation.errors).toHaveLength(0);
      });

      it(`should have health check interval of ${testData.healthCheckIntervalMs}ms`, () => {
        const partition = getPartition(testData.partitionId);
        expect(partition!.healthCheckIntervalMs).toBe(testData.healthCheckIntervalMs);
      });

      it(`should have failover timeout of ${testData.failoverTimeoutMs}ms`, () => {
        const partition = getPartition(testData.partitionId);
        expect(partition!.failoverTimeoutMs).toBe(testData.failoverTimeoutMs);
      });
    });

    // =========================================================================
    // Chain Configuration Tests
    // =========================================================================

    describe('Chain Configurations', () => {
      describe.each(testData.chains.map(chain => ({ chain })))(
        '$chain chain',
        ({ chain }) => {
          it('should have chain defined', () => {
            expect(CHAINS[chain]).toBeDefined();
            expect(CHAINS[chain].id).toBe(testData.chainIds[chain]);
          });

          it('should have DEXes configured', () => {
            expect(DEXES[chain]).toBeDefined();
            expect(DEXES[chain].length).toBeGreaterThanOrEqual(testData.minDexesPerChain[chain]);
          });

          it('should have tokens configured', () => {
            expect(CORE_TOKENS[chain]).toBeDefined();
            expect(CORE_TOKENS[chain].length).toBeGreaterThanOrEqual(testData.minTokensPerChain[chain]);
          });

          it('should have detector config', () => {
            expect(DETECTOR_CONFIG[chain]).toBeDefined();
          });

          it('should have token metadata', () => {
            expect(TOKEN_METADATA[chain]).toBeDefined();
            if (testData.isEvm) {
              expect(TOKEN_METADATA[chain].nativeWrapper).toBe(testData.nativeWrappers[chain]);
            }
          });

          if (testData.isEvm) {
            it('should be EVM compatible', () => {
              expect(isEvmChain(chain)).toBe(true);
            });
          } else {
            it('should be non-EVM', () => {
              expect(isEvmChain(chain)).toBe(false);
            });
          }
        }
      );
    });

    // =========================================================================
    // Service Startup Tests
    // =========================================================================

    describe('Service Startup', () => {
      it(`should start with all ${testData.chainCount} chains`, async () => {
        detector = await createStartedDetector(testData.partitionId, testData.chains, testData.region);

        expect(detector.isRunning()).toBe(true);
        expect(detector.getChains()).toHaveLength(testData.chainCount);
        for (const chain of testData.chains) {
          expect(detector.getChains()).toContain(chain);
        }
      });

      it('should connect all chain managers', async () => {
        detector = await createStartedDetector(testData.partitionId, testData.chains, testData.region);

        expect(detector.getChainManagers().size).toBe(testData.chainCount);
        for (const chain of testData.chains) {
          expect(detector.getChainManagers().has(chain)).toBe(true);
        }
      });

      it(`should report ${testData.partitionId} partition ID`, async () => {
        detector = await createStartedDetector(testData.partitionId, testData.chains, testData.region);
        expect(detector.getPartitionId()).toBe(testData.partitionId);
      });

      it('should emit started event with all chains', async () => {
        const config = createPartitionConfig(testData.partitionId, testData.chains, testData.region);
        detector = new PartitionedDetector(config, createMockDetectorDeps());
        const startedHandler = jest.fn();
        detector.on('started', startedHandler);

        await detector.start();

        expect(startedHandler).toHaveBeenCalledWith({
          partitionId: testData.partitionId,
          chains: [...testData.chains]
        });
      });

      it('should emit chainConnected for each chain', async () => {
        const config = createPartitionConfig(testData.partitionId, testData.chains, testData.region);
        detector = new PartitionedDetector(config, createMockDetectorDeps());
        const connectedHandler = jest.fn();
        detector.on('chainConnected', connectedHandler);

        await detector.start();

        expect(connectedHandler).toHaveBeenCalledTimes(testData.chainCount);
        for (const chain of testData.chains) {
          expect(connectedHandler).toHaveBeenCalledWith({ chainId: chain });
        }
      });

      it('should start within 5 seconds', async () => {
        const config = createPartitionConfig(testData.partitionId, testData.chains, testData.region);
        detector = new PartitionedDetector(config, createMockDetectorDeps());

        const startTime = Date.now();
        await detector.start();
        const duration = Date.now() - startTime;

        expect(duration).toBeLessThan(5000);
      });
    });

    // =========================================================================
    // Health Monitoring Tests
    // =========================================================================

    describe('Health Monitoring', () => {
      it('should return healthy status when all chains connected', async () => {
        detector = await createStartedDetector(testData.partitionId, testData.chains, testData.region);

        const health = detector.getPartitionHealth();

        expect(health.status).toBe('healthy');
        expect(health.partitionId).toBe(testData.partitionId);
        expect(health.chainHealth.size).toBe(testData.chainCount);
      });

      it('should report health for all chains', async () => {
        detector = await createStartedDetector(testData.partitionId, testData.chains, testData.region);

        const health = detector.getPartitionHealth();

        for (const chain of testData.chains) {
          expect(health.chainHealth.has(chain)).toBe(true);
        }
      });

      it('should return degraded/unhealthy status when one chain fails', async () => {
        detector = await createStartedDetector(testData.partitionId, testData.chains, testData.region);

        // Simulate first chain going down
        const chainHealth = detector['chainHealth'];
        const firstChainHealth = chainHealth.get(testData.chains[0]);
        if (firstChainHealth) {
          firstChainHealth.status = 'unhealthy';
          firstChainHealth.wsConnected = false;
        }

        const health = detector.getPartitionHealth();

        // Single-chain partitions (like Solana) become 'unhealthy' when the only chain fails
        // Multi-chain partitions become 'degraded' when one chain fails
        if (testData.chainCount === 1) {
          expect(health.status).toBe('unhealthy');
        } else {
          expect(health.status).toBe('degraded');
        }
        expect(detector.getHealthyChains()).toHaveLength(testData.chainCount - 1);
        expect(detector.getHealthyChains()).not.toContain(testData.chains[0]);
      });

      it('should track memory usage', async () => {
        detector = await createStartedDetector(testData.partitionId, testData.chains, testData.region);

        const health = detector.getPartitionHealth();

        expect(health.memoryUsage).toBeGreaterThan(0);
      });

      it('should track uptime', async () => {
        detector = await createStartedDetector(testData.partitionId, testData.chains, testData.region);
        await new Promise(resolve => setTimeout(resolve, 100));

        const health = detector.getPartitionHealth();

        expect(health.uptimeSeconds).toBeGreaterThan(0);
      });

      it('should track events processed', async () => {
        detector = await createStartedDetector(testData.partitionId, testData.chains, testData.region);

        const health = detector.getPartitionHealth();

        expect(typeof health.totalEventsProcessed).toBe('number');
      });
    });

    // =========================================================================
    // Cross-Chain Price Detection Tests (EVM only)
    // =========================================================================

    if (testData.isEvm && testData.chainCount > 1) {
      describe('Cross-Chain Arbitrage Detection', () => {
        it('should track prices across all chains', async () => {
          detector = await createStartedDetector(testData.partitionId, testData.chains, testData.region);

          let basePrice = 2500;
          for (const chain of testData.chains) {
            detector.updatePrice(chain, 'WETH_USDC', basePrice);
            basePrice += 10;
          }

          const prices = detector.getCrossChainPrices('WETH_USDC');

          expect(prices.size).toBe(testData.chainCount);
          basePrice = 2500;
          for (const chain of testData.chains) {
            expect(prices.get(chain)?.price).toBe(basePrice);
            basePrice += 10;
          }
        });

        it('should detect cross-chain price discrepancies', async () => {
          detector = await createStartedDetector(testData.partitionId, testData.chains, testData.region);

          // Create 5% price discrepancy between first and last chain
          const firstChain = testData.chains[0];
          const lastChain = testData.chains[testData.chains.length - 1];

          detector.updatePrice(firstChain, 'WETH_USDC', 2500);
          detector.updatePrice(lastChain, 'WETH_USDC', 2625); // 5% higher

          const discrepancies = detector.findCrossChainDiscrepancies(0.01);

          expect(discrepancies.length).toBeGreaterThan(0);
          expect(discrepancies[0].pairKey).toBe('WETH_USDC');
        });
      });
    }

    // =========================================================================
    // Intra-Partition Detection Tests (Solana specific)
    // =========================================================================

    if (!testData.isEvm) {
      describe('Intra-Partition Arbitrage Detection', () => {
        it('should track prices on single chain across multiple DEXes', async () => {
          detector = await createStartedDetector(testData.partitionId, testData.chains, testData.region);

          // Solana uses program-based price tracking
          detector.updatePrice('solana', 'SOL_USDC', 150);

          const prices = detector.getCrossChainPrices('SOL_USDC');

          expect(prices.size).toBe(1);
          expect(prices.get('solana')?.price).toBe(150);
        });
      });
    }

    // =========================================================================
    // Graceful Degradation Tests
    // =========================================================================

    describe('Graceful Degradation', () => {
      it(`should continue running with ${testData.chainCount - 1} of ${testData.chainCount} chains healthy`, async () => {
        detector = await createStartedDetector(testData.partitionId, testData.chains, testData.region);

        // Simulate first chain going down
        const chainHealth = detector['chainHealth'];
        const firstChainHealth = chainHealth.get(testData.chains[0]);
        if (firstChainHealth) {
          firstChainHealth.status = 'unhealthy';
          firstChainHealth.wsConnected = false;
        }

        expect(detector.isRunning()).toBe(true);
        expect(detector.getHealthyChains()).toHaveLength(testData.chainCount - 1);
      });

      if (testData.chainCount > 2) {
        it(`should continue running with ${testData.chainCount - 2} of ${testData.chainCount} chains healthy`, async () => {
          detector = await createStartedDetector(testData.partitionId, testData.chains, testData.region);

          // Simulate first two chains going down
          const chainHealth = detector['chainHealth'];
          for (let i = 0; i < 2; i++) {
            const health = chainHealth.get(testData.chains[i]);
            if (health) {
              health.status = 'unhealthy';
              health.wsConnected = false;
            }
          }

          expect(detector.isRunning()).toBe(true);
          expect(detector.getPartitionHealth().status).toBe('degraded');
          expect(detector.getHealthyChains()).toHaveLength(testData.chainCount - 2);
        });
      }

      it('should track error counts per chain', async () => {
        detector = await createStartedDetector(testData.partitionId, testData.chains, testData.region);

        const firstChain = testData.chains[0];
        const wsManager = detector.getChainManagers().get(firstChain) as unknown as EventEmitter;
        wsManager?.emit('error', new Error('Connection reset'));
        wsManager?.emit('error', new Error('Timeout'));

        const chainHealth = detector.getChainHealth(firstChain);
        expect(chainHealth?.errorCount).toBeGreaterThanOrEqual(2);
      });

      it('should update chain health status on disconnect', async () => {
        detector = await createStartedDetector(testData.partitionId, testData.chains, testData.region);

        const firstChain = testData.chains[0];
        const wsManager = detector.getChainManagers().get(firstChain) as unknown as EventEmitter;
        wsManager?.emit('disconnected');

        const chainHealth = detector.getChainHealth(firstChain);
        expect(chainHealth?.status).toBe('degraded');
        expect(chainHealth?.wsConnected).toBe(false);
      });
    });

    // =========================================================================
    // Resource Calculation Tests
    // =========================================================================

    describe('Resource Calculations', () => {
      it(`should calculate resources for ${testData.chainCount}-chain partition`, () => {
        const resources = calculatePartitionResources(testData.partitionId);

        expect(resources.estimatedMemoryMB).toBeGreaterThan(100);
        expect(['light', 'standard', 'heavy']).toContain(resources.recommendedProfile);
      });

      it('should estimate CPU cores based on block times', () => {
        const resources = calculatePartitionResources(testData.partitionId);

        expect(resources.estimatedCpuCores).toBeGreaterThanOrEqual(0.25);
      });

      it('should account for DEX count in memory estimation', () => {
        let totalDexes = 0;
        for (const chainId of testData.chains) {
          totalDexes += getEnabledDexes(chainId).length;
        }

        expect(totalDexes).toBeGreaterThanOrEqual(testData.minDexCount);

        const resources = calculatePartitionResources(testData.partitionId);
        expect(resources.estimatedMemoryMB).toBeGreaterThan(totalDexes * 5);
      });
    });

    // =========================================================================
    // Chain Instance Creation Tests
    // =========================================================================

    describe('Chain Instance Creation', () => {
      it(`should create chain instances for all ${testData.chainCount} chains`, () => {
        const instances = createPartitionChainInstances(testData.partitionId);

        expect(instances).toHaveLength(testData.chainCount);
        for (const chain of testData.chains) {
          expect(instances.map(i => i.chainId)).toContain(chain);
        }
      });

      it('should include DEX names for each chain', () => {
        for (const chain of testData.chains) {
          const instance = createChainInstance(chain);
          expect(instance).not.toBeNull();
          expect(instance!.dexes.length).toBeGreaterThanOrEqual(1);
        }
      });

      it('should include token symbols for each chain', () => {
        for (const chain of testData.chains) {
          const instance = createChainInstance(chain);
          expect(instance).not.toBeNull();
          expect(instance!.tokens.length).toBeGreaterThanOrEqual(1);
        }
      });

      it('should have correct native tokens', () => {
        const instances = createPartitionChainInstances(testData.partitionId);

        for (const chain of testData.chains) {
          const instance = instances.find(i => i.chainId === chain);
          expect(instance).toBeDefined();
          expect(instance!.nativeToken).toBe(testData.nativeTokens[chain]);
        }
      });
    });

    // =========================================================================
    // Service Shutdown Tests
    // =========================================================================

    describe('Service Shutdown', () => {
      it(`should cleanly stop all ${testData.chainCount} chains`, async () => {
        detector = await createStartedDetector(testData.partitionId, testData.chains, testData.region);
        expect(detector.isRunning()).toBe(true);

        await detector.stop();

        expect(detector.isRunning()).toBe(false);
        expect(detector.getChainManagers().size).toBe(0);
      });

      it('should emit stopped event', async () => {
        detector = await createStartedDetector(testData.partitionId, testData.chains, testData.region);
        const stoppedHandler = jest.fn();
        detector.on('stopped', stoppedHandler);

        await detector.stop();

        expect(stoppedHandler).toHaveBeenCalledWith({
          partitionId: testData.partitionId
        });
      });

      it('should disconnect Redis clients on shutdown', async () => {
        detector = await createStartedDetector(testData.partitionId, testData.chains, testData.region);

        await detector.stop();

        expect(mockRedisClient.disconnect).toHaveBeenCalled();
        expect(mockStreamsClient.disconnect).toHaveBeenCalled();
      });

      it('should handle shutdown errors gracefully', async () => {
        detector = await createStartedDetector(testData.partitionId, testData.chains, testData.region);
        mockRedisClient.disconnect.mockRejectedValueOnce(new Error('Disconnect error'));

        await expect(detector.stop()).resolves.not.toThrow();
        expect(detector.isRunning()).toBe(false);
      });

      it('should complete shutdown within timeout period', async () => {
        detector = await createStartedDetector(testData.partitionId, testData.chains, testData.region);

        const startTime = Date.now();
        await detector.stop();
        const duration = Date.now() - startTime;

        expect(duration).toBeLessThan(5000);
      });
    });

    // =========================================================================
    // Chain Validation Tests
    // =========================================================================

    describe('Chain Validation', () => {
      it('should accept valid chain IDs', () => {
        const validChains = Object.keys(CHAINS);

        for (const chain of testData.chains) {
          expect(validChains).toContain(chain);
        }
      });

      it('should have all chains defined in CHAINS config', () => {
        for (const chainId of testData.chains) {
          expect(CHAINS[chainId]).toBeDefined();
          expect(CHAINS[chainId].id).toBeGreaterThan(0);
          expect(CHAINS[chainId].name).toBeTruthy();
        }
      });

      it('should validate chain IDs are lowercase strings', () => {
        for (const chainId of testData.chains) {
          expect(chainId).toBe(chainId.toLowerCase());
          expect(typeof chainId).toBe('string');
        }
      });

      it('should have numeric chain IDs in CHAINS config', () => {
        for (const chain of testData.chains) {
          expect(CHAINS[chain].id).toBe(testData.chainIds[chain]);
        }
      });
    });

    // =========================================================================
    // getHealthyChains Method Tests
    // =========================================================================

    describe('getHealthyChains Method', () => {
      it('should return all chains when all are healthy', async () => {
        detector = await createStartedDetector(testData.partitionId, testData.chains, testData.region);

        const healthyChains = detector.getHealthyChains();

        expect(healthyChains).toHaveLength(testData.chainCount);
        for (const chain of testData.chains) {
          expect(healthyChains).toContain(chain);
        }
      });

      it('should return empty array when no chains are healthy', async () => {
        detector = await createStartedDetector(testData.partitionId, testData.chains, testData.region);

        const chainHealth = detector['chainHealth'];
        for (const [, health] of chainHealth) {
          health.status = 'unhealthy';
          health.wsConnected = false;
        }

        const healthyChains = detector.getHealthyChains();

        expect(healthyChains).toHaveLength(0);
      });

      it('should return string array type', async () => {
        detector = await createStartedDetector(testData.partitionId, testData.chains, testData.region);

        const healthyChains = detector.getHealthyChains();

        expect(Array.isArray(healthyChains)).toBe(true);
        for (const chain of healthyChains) {
          expect(typeof chain).toBe('string');
        }
      });

      it('should be consistent with getPartitionHealth status', async () => {
        detector = await createStartedDetector(testData.partitionId, testData.chains, testData.region);

        const health = detector.getPartitionHealth();
        const healthyChains = detector.getHealthyChains();

        let healthyCount = 0;
        for (const [, chainHealth] of health.chainHealth) {
          if (chainHealth.status === 'healthy') {
            healthyCount++;
          }
        }

        expect(healthyChains.length).toBe(healthyCount);
      });

      it('should update dynamically when chain status changes', async () => {
        detector = await createStartedDetector(testData.partitionId, testData.chains, testData.region);

        expect(detector.getHealthyChains()).toHaveLength(testData.chainCount);

        const chainHealth = detector['chainHealth'];
        const firstChainHealth = chainHealth.get(testData.chains[0]);
        if (firstChainHealth) {
          firstChainHealth.status = 'unhealthy';
          firstChainHealth.wsConnected = false;
        }

        expect(detector.getHealthyChains()).toHaveLength(testData.chainCount - 1);
        expect(detector.getHealthyChains()).not.toContain(testData.chains[0]);

        if (firstChainHealth) {
          firstChainHealth.status = 'healthy';
          firstChainHealth.wsConnected = true;
        }

        expect(detector.getHealthyChains()).toHaveLength(testData.chainCount);
        expect(detector.getHealthyChains()).toContain(testData.chains[0]);
      });
    });
  }
);

// =============================================================================
// Environment Configuration Tests (Shared across partitions)
// =============================================================================

describe('Environment Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe.each(PARTITION_TEST_DATA)(
    '$name environment config',
    (testData) => {
      it(`should configure with PARTITION_ID=${testData.partitionId}`, async () => {
        process.env.PARTITION_ID = testData.partitionId;

        const { getPartitionFromEnv } = await import('../../../shared/config/src/partitions');
        const partition = getPartitionFromEnv();

        expect(partition).toBeDefined();
        expect(partition!.partitionId).toBe(testData.partitionId);
        expect(partition!.chains).toHaveLength(testData.chainCount);
      });
    }
  );

  it('should default to asia-fast when PARTITION_ID not set', async () => {
    delete process.env.PARTITION_ID;

    const { getPartitionIdFromEnv } = await import('../../../shared/config/src/partitions');
    const partitionId = getPartitionIdFromEnv();

    expect(partitionId).toBe('asia-fast');
  });

  it('should allow chain override via PARTITION_CHAINS', async () => {
    process.env.PARTITION_ID = 'asia-fast';
    process.env.PARTITION_CHAINS = 'bsc, polygon';

    const { getChainsFromEnv } = await import('../../../shared/config/src/partitions');
    const chains = getChainsFromEnv();

    expect(chains).toEqual(['bsc', 'polygon']);
  });
});

// =============================================================================
// Cross-Partition Validation Tests
// =============================================================================

describe('Cross-Partition Validation', () => {
  it('should have all 4 partitions enabled', () => {
    const enabledPartitions = PARTITIONS.filter(p => p.enabled);
    expect(enabledPartitions).toHaveLength(4);
  });

  it('should cover all 11 chains across partitions', () => {
    const allChains = new Set<string>();
    for (const partition of PARTITIONS) {
      if (partition.enabled) {
        for (const chain of partition.chains) {
          allChains.add(chain);
        }
      }
    }
    expect(allChains.size).toBe(11);
  });

  it('should not have duplicate chains across partitions', () => {
    const seenChains = new Set<string>();
    const duplicates: string[] = [];

    for (const partition of PARTITIONS) {
      if (partition.enabled) {
        for (const chain of partition.chains) {
          if (seenChains.has(chain)) {
            duplicates.push(chain);
          }
          seenChains.add(chain);
        }
      }
    }

    expect(duplicates).toHaveLength(0);
  });

  it('should have unique partition IDs', () => {
    const partitionIds = PARTITIONS.map(p => p.partitionId);
    const uniqueIds = new Set(partitionIds);
    expect(uniqueIds.size).toBe(partitionIds.length);
  });
});
