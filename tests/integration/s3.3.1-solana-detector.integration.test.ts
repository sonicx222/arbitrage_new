/**
 * S3.3.1 Integration Tests: SolanaDetector Base Infrastructure
 *
 * Tests for the SolanaDetector class configuration and structure:
 * - Configuration validation
 * - Pool management (no Redis required)
 * - Arbitrage detection logic
 * - DEX program constants
 *
 * Note: Tests that require starting the detector (which needs Redis)
 * are covered in the unit tests at shared/core/src/solana-detector.test.ts
 *
 * @see IMPLEMENTATION_PLAN.md S3.3.1: Create Solana detector base infrastructure
 * @see ADR-003: Partitioned Chain Detectors
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// =============================================================================
// Test Imports - Use package aliases as configured in jest.config
// =============================================================================

// Import types and constants
import {
  SolanaDetector,
  SOLANA_DEX_PROGRAMS,
  SolanaDetectorConfig,
  SolanaPool,
  SolanaDetectorRedisClient,
  SolanaDetectorStreamsClient
} from '@arbitrage/core/solana-detector';

// =============================================================================
// Test Constants
// =============================================================================

const TEST_RPC_URL = 'https://api.mainnet-beta.solana.com';
const TEST_WS_URL = 'wss://api.mainnet-beta.solana.com';
const FALLBACK_RPC_URL = 'https://solana-mainnet.g.alchemy.com/v2/test';

// Valid Solana addresses for testing
const VALID_POOL_ADDRESS = 'HZ1znC9XBasm9AMDhGocd9EHSyH8Pyj1EUdiPb4WnZjo';
const VALID_PROGRAM_ID = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const VALID_TOKEN_MINT_1 = 'So11111111111111111111111111111111111111112'; // Wrapped SOL
const VALID_TOKEN_MINT_2 = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC

// =============================================================================
// Test Helper Functions
// =============================================================================

function createTestConfig(overrides: Partial<SolanaDetectorConfig> = {}): SolanaDetectorConfig {
  return {
    rpcUrl: TEST_RPC_URL,
    wsUrl: TEST_WS_URL,
    commitment: 'confirmed',
    rpcFallbackUrls: [FALLBACK_RPC_URL],
    wsFallbackUrls: [],
    healthCheckIntervalMs: 60000,
    connectionPoolSize: 2,
    maxRetries: 2,
    retryDelayMs: 50,
    minProfitThreshold: 0.3,
    ...overrides
  };
}

function createTestPool(overrides: Partial<SolanaPool> = {}): SolanaPool {
  return {
    address: VALID_POOL_ADDRESS,
    programId: VALID_PROGRAM_ID,
    dex: 'raydium',
    token0: {
      mint: VALID_TOKEN_MINT_1,
      symbol: 'SOL',
      decimals: 9
    },
    token1: {
      mint: VALID_TOKEN_MINT_2,
      symbol: 'USDC',
      decimals: 6
    },
    fee: 25, // 0.25% in basis points
    reserve0: '1000000000000',
    reserve1: '150000000000',
    price: 150,
    lastSlot: 100000,
    ...overrides
  };
}

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
};

const mockPerfLogger = {
  logHealthCheck: jest.fn(),
  logEventLatency: jest.fn(),
  logArbitrageOpportunity: jest.fn()
};

// =============================================================================
// Mock Redis Clients for DI Pattern
// =============================================================================

function createMockRedisClient(): SolanaDetectorRedisClient {
  return {
    ping: jest.fn<() => Promise<string>>().mockResolvedValue('PONG'),
    disconnect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    updateServiceHealth: jest.fn<() => Promise<void>>().mockResolvedValue(undefined)
  };
}

function createMockStreamBatcher() {
  return {
    add: jest.fn(),
    destroy: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    getStats: jest.fn().mockReturnValue({ currentQueueSize: 0, batchesSent: 0 })
  };
}

function createMockStreamsClient(): SolanaDetectorStreamsClient {
  const batcher = createMockStreamBatcher();
  return {
    disconnect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    createBatcher: jest.fn().mockReturnValue(batcher),
    __batcher: batcher // For test assertions
  } as any;
}

// =============================================================================
// Integration Tests - Configuration (no Redis required)
// =============================================================================

describe('S3.3.1 SolanaDetector Configuration Integration', () => {
  let detector: SolanaDetector | null = null;

  afterEach(() => {
    detector = null;
  });

  describe('S3.3.1.1: Initialization and Configuration', () => {
    it('should initialize with valid RPC URL', () => {
      detector = new SolanaDetector(createTestConfig(), {
        logger: mockLogger,
        perfLogger: mockPerfLogger
      });

      expect(detector).toBeDefined();
      expect(detector.getRpcUrl()).toBe(TEST_RPC_URL);
    });

    it('should throw error for missing RPC URL', () => {
      expect(() => {
        new SolanaDetector({ rpcUrl: '' }, {
          logger: mockLogger,
          perfLogger: mockPerfLogger
        });
      }).toThrow('RPC URL is required');
    });

    it('should derive WebSocket URL from RPC URL when not provided', () => {
      detector = new SolanaDetector({
        rpcUrl: 'https://api.mainnet-beta.solana.com'
      }, {
        logger: mockLogger,
        perfLogger: mockPerfLogger
      });

      expect(detector.getWsUrl()).toBe('wss://api.mainnet-beta.solana.com');
    });

    it('should use provided WebSocket URL', () => {
      detector = new SolanaDetector(createTestConfig({
        wsUrl: 'wss://custom-ws.solana.com'
      }), {
        logger: mockLogger,
        perfLogger: mockPerfLogger
      });

      expect(detector.getWsUrl()).toBe('wss://custom-ws.solana.com');
    });

    it('should return solana as chain', () => {
      detector = new SolanaDetector(createTestConfig(), {
        logger: mockLogger,
        perfLogger: mockPerfLogger
      });

      expect(detector.getChain()).toBe('solana');
    });

    it('should return false for isEVM', () => {
      detector = new SolanaDetector(createTestConfig(), {
        logger: mockLogger,
        perfLogger: mockPerfLogger
      });

      expect(detector.isEVM()).toBe(false);
    });

    it('should return correct commitment level', () => {
      detector = new SolanaDetector(createTestConfig({
        commitment: 'finalized'
      }), {
        logger: mockLogger,
        perfLogger: mockPerfLogger
      });

      expect(detector.getCommitment()).toBe('finalized');
    });

    it('should return fallback URLs', () => {
      detector = new SolanaDetector(createTestConfig(), {
        logger: mockLogger,
        perfLogger: mockPerfLogger
      });

      const fallbacks = detector.getFallbackUrls();
      expect(fallbacks.rpc).toContain(FALLBACK_RPC_URL);
    });

    it('should not be running initially', () => {
      detector = new SolanaDetector(createTestConfig(), {
        logger: mockLogger,
        perfLogger: mockPerfLogger
      });

      expect(detector.isRunning()).toBe(false);
    });
  });
});

// =============================================================================
// Integration Tests - Pool Management (no Redis required)
// =============================================================================

describe('S3.3.1 SolanaDetector Pool Management Integration', () => {
  let detector: SolanaDetector;

  beforeEach(() => {
    detector = new SolanaDetector(createTestConfig(), {
      logger: mockLogger,
      perfLogger: mockPerfLogger
    });
  });

  describe('S3.3.1.5: Pool Management', () => {
    it('should add pool to tracking', () => {
      const pool = createTestPool();
      detector.addPool(pool);

      expect(detector.getPoolCount()).toBe(1);
      expect(detector.getPool(VALID_POOL_ADDRESS)).toBeDefined();
    });

    it('should remove pool from tracking', () => {
      const pool = createTestPool();
      detector.addPool(pool);
      detector.removePool(VALID_POOL_ADDRESS);

      expect(detector.getPoolCount()).toBe(0);
      expect(detector.getPool(VALID_POOL_ADDRESS)).toBeUndefined();
    });

    it('should get pools by DEX', () => {
      detector.addPool(createTestPool({ dex: 'raydium' }));
      detector.addPool(createTestPool({
        address: 'DKT8ncTnQMDZ1AnPrKbJTWMqzL7HXSkFHSFCdK8qBM9F',
        dex: 'orca'
      }));

      const raydiumPools = detector.getPoolsByDex('raydium');
      const orcaPools = detector.getPoolsByDex('orca');

      expect(raydiumPools.length).toBe(1);
      expect(orcaPools.length).toBe(1);
    });

    it('should get pools by token pair', () => {
      detector.addPool(createTestPool({
        dex: 'raydium',
        token0: { mint: VALID_TOKEN_MINT_1, symbol: 'SOL', decimals: 9 },
        token1: { mint: VALID_TOKEN_MINT_2, symbol: 'USDC', decimals: 6 }
      }));
      detector.addPool(createTestPool({
        address: 'DKT8ncTnQMDZ1AnPrKbJTWMqzL7HXSkFHSFCdK8qBM9F',
        dex: 'orca',
        token0: { mint: VALID_TOKEN_MINT_1, symbol: 'SOL', decimals: 9 },
        token1: { mint: VALID_TOKEN_MINT_2, symbol: 'USDC', decimals: 6 }
      }));

      const pools = detector.getPoolsByTokenPair(VALID_TOKEN_MINT_1, VALID_TOKEN_MINT_2);

      expect(pools.length).toBe(2);
    });

    it('should handle removing non-existent pool gracefully', () => {
      detector.removePool('non-existent-address');
      expect(detector.getPoolCount()).toBe(0);
    });

    it('should return empty array for non-existent DEX', () => {
      const pools = detector.getPoolsByDex('non-existent-dex');
      expect(pools).toEqual([]);
    });

    it('should return empty array for non-existent token pair', () => {
      const pools = detector.getPoolsByTokenPair('token1', 'token2');
      expect(pools).toEqual([]);
    });
  });
});

// =============================================================================
// Integration Tests - Arbitrage Detection Logic (no Redis required)
// =============================================================================

describe('S3.3.1 SolanaDetector Arbitrage Detection Integration', () => {
  let detector: SolanaDetector;

  beforeEach(() => {
    detector = new SolanaDetector(createTestConfig({
      minProfitThreshold: 0.3 // 0.3%
    }), {
      logger: mockLogger,
      perfLogger: mockPerfLogger
    });
  });

  describe('S3.3.1.6: Arbitrage Detection', () => {
    it('should detect arbitrage opportunity between pools with significant price difference', async () => {
      // Add two pools with price discrepancy
      detector.addPool(createTestPool({
        address: 'Pool1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa11',
        dex: 'raydium',
        price: 150,
        fee: 25 // 0.25%
      }));

      detector.addPool(createTestPool({
        address: 'Pool2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb22',
        dex: 'orca',
        price: 152, // 1.33% difference
        fee: 25
      }));

      const opportunities = await detector.checkArbitrage();

      expect(opportunities.length).toBeGreaterThan(0);
      expect(opportunities[0].chain).toBe('solana');
      expect(opportunities[0].buyDex).toBe('raydium'); // Lower price
      expect(opportunities[0].sellDex).toBe('orca'); // Higher price
    });

    it('should not detect arbitrage below threshold', async () => {
      // Add two pools with small price discrepancy (0.2%, below 0.3% threshold)
      detector.addPool(createTestPool({
        address: 'Pool1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa11',
        dex: 'raydium',
        price: 150,
        fee: 25
      }));

      detector.addPool(createTestPool({
        address: 'Pool2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb22',
        dex: 'orca',
        price: 150.30, // 0.2% difference
        fee: 25
      }));

      const opportunities = await detector.checkArbitrage();

      expect(opportunities.length).toBe(0);
    });

    it('should require at least 2 pools for arbitrage', async () => {
      // Add only one pool
      detector.addPool(createTestPool());

      const opportunities = await detector.checkArbitrage();

      expect(opportunities.length).toBe(0);
    });

    it('should calculate correct profit after fees', async () => {
      // 2% price difference, 0.5% total fees = ~1.5% net profit
      detector.addPool(createTestPool({
        address: 'Pool1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa11',
        dex: 'raydium',
        price: 100,
        fee: 25 // 0.25%
      }));

      detector.addPool(createTestPool({
        address: 'Pool2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb22',
        dex: 'orca',
        price: 102, // 2% higher
        fee: 25 // 0.25%
      }));

      const opportunities = await detector.checkArbitrage();

      expect(opportunities.length).toBe(1);
      // Net profit should be ~1.5% (2% - 0.5% fees)
      expect(opportunities[0].profitPercentage).toBeGreaterThan(1.0);
      expect(opportunities[0].profitPercentage).toBeLessThan(2.0);
    });

    it('should handle multiple token pairs', async () => {
      // SOL/USDC pair
      detector.addPool(createTestPool({
        address: 'Pool1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa11',
        dex: 'raydium',
        token0: { mint: VALID_TOKEN_MINT_1, symbol: 'SOL', decimals: 9 },
        token1: { mint: VALID_TOKEN_MINT_2, symbol: 'USDC', decimals: 6 },
        price: 150,
        fee: 25
      }));

      detector.addPool(createTestPool({
        address: 'Pool2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb22',
        dex: 'orca',
        token0: { mint: VALID_TOKEN_MINT_1, symbol: 'SOL', decimals: 9 },
        token1: { mint: VALID_TOKEN_MINT_2, symbol: 'USDC', decimals: 6 },
        price: 153, // 2% higher
        fee: 25
      }));

      // RAY/USDC pair (different token pair)
      const rayMint = 'Token3RAYaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa33';
      detector.addPool(createTestPool({
        address: 'Pool3ccccccccccccccccccccccccccccccccccccc33',
        dex: 'raydium',
        token0: { mint: rayMint, symbol: 'RAY', decimals: 6 },
        token1: { mint: VALID_TOKEN_MINT_2, symbol: 'USDC', decimals: 6 },
        price: 1.5,
        fee: 25
      }));

      detector.addPool(createTestPool({
        address: 'Pool4ddddddddddddddddddddddddddddddddddddd44',
        dex: 'orca',
        token0: { mint: rayMint, symbol: 'RAY', decimals: 6 },
        token1: { mint: VALID_TOKEN_MINT_2, symbol: 'USDC', decimals: 6 },
        price: 1.53, // 2% higher
        fee: 25
      }));

      const opportunities = await detector.checkArbitrage();

      // Should find opportunities in both pairs
      expect(opportunities.length).toBe(2);
    });

    it('should identify correct buy and sell sides', async () => {
      detector.addPool(createTestPool({
        address: 'Pool1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa11',
        dex: 'raydium',
        price: 100, // Lower price - buy here
        fee: 25
      }));

      detector.addPool(createTestPool({
        address: 'Pool2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb22',
        dex: 'orca',
        price: 105, // Higher price - sell here
        fee: 25
      }));

      const opportunities = await detector.checkArbitrage();

      expect(opportunities.length).toBe(1);
      expect(opportunities[0].buyDex).toBe('raydium');
      expect(opportunities[0].sellDex).toBe('orca');
      expect(opportunities[0].buyPrice).toBe(100);
      expect(opportunities[0].sellPrice).toBe(105);
    });
  });
});

// =============================================================================
// Integration Tests - DEX Program Constants
// =============================================================================

describe('S3.3.1 SolanaDetector DEX Program Constants Integration', () => {
  describe('S3.3.1.10: DEX Program Constants', () => {
    it('should have Raydium AMM program ID', () => {
      expect(SOLANA_DEX_PROGRAMS.RAYDIUM_AMM).toBeDefined();
      expect(SOLANA_DEX_PROGRAMS.RAYDIUM_AMM).toBe('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
    });

    it('should have Raydium CLMM program ID', () => {
      expect(SOLANA_DEX_PROGRAMS.RAYDIUM_CLMM).toBeDefined();
      expect(SOLANA_DEX_PROGRAMS.RAYDIUM_CLMM).toBe('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
    });

    it('should have Orca Whirlpool program ID', () => {
      expect(SOLANA_DEX_PROGRAMS.ORCA_WHIRLPOOL).toBeDefined();
      expect(SOLANA_DEX_PROGRAMS.ORCA_WHIRLPOOL).toBe('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
    });

    it('should have Jupiter program ID', () => {
      expect(SOLANA_DEX_PROGRAMS.JUPITER).toBeDefined();
      expect(SOLANA_DEX_PROGRAMS.JUPITER).toBe('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
    });

    it('should have Meteora DLMM program ID', () => {
      expect(SOLANA_DEX_PROGRAMS.METEORA_DLMM).toBeDefined();
      expect(SOLANA_DEX_PROGRAMS.METEORA_DLMM).toBe('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
    });

    it('should have Phoenix program ID', () => {
      expect(SOLANA_DEX_PROGRAMS.PHOENIX).toBeDefined();
      expect(SOLANA_DEX_PROGRAMS.PHOENIX).toBe('PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY');
    });

    it('should have Lifinity program ID', () => {
      expect(SOLANA_DEX_PROGRAMS.LIFINITY).toBeDefined();
      expect(SOLANA_DEX_PROGRAMS.LIFINITY).toBe('2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c');
    });

    it('should have valid base58 format for all program IDs', () => {
      const base58Regex = /^[A-HJ-NP-Za-km-z1-9]+$/;

      for (const [name, programId] of Object.entries(SOLANA_DEX_PROGRAMS)) {
        expect(base58Regex.test(programId)).toBe(true);
        expect(programId.length).toBeGreaterThanOrEqual(32);
        expect(programId.length).toBeLessThanOrEqual(50);
      }
    });

    it('should not contain EVM-style hex addresses', () => {
      for (const [name, programId] of Object.entries(SOLANA_DEX_PROGRAMS)) {
        expect(programId).not.toMatch(/^0x/);
      }
    });
  });
});

// =============================================================================
// Integration Tests - Cross-Component Integration (no Redis required)
// =============================================================================

describe('S3.3.1 SolanaDetector Cross-Component Integration', () => {
  let detector: SolanaDetector;

  beforeEach(() => {
    detector = new SolanaDetector(createTestConfig({
      minProfitThreshold: 0.3
    }), {
      logger: mockLogger,
      perfLogger: mockPerfLogger
    });
  });

  it('should maintain consistency between pool indexes', async () => {
    // Add multiple pools
    const pools = [
      createTestPool({
        address: 'Pool1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa11',
        dex: 'raydium',
        token0: { mint: VALID_TOKEN_MINT_1, symbol: 'SOL', decimals: 9 },
        token1: { mint: VALID_TOKEN_MINT_2, symbol: 'USDC', decimals: 6 }
      }),
      createTestPool({
        address: 'Pool2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb22',
        dex: 'orca',
        token0: { mint: VALID_TOKEN_MINT_1, symbol: 'SOL', decimals: 9 },
        token1: { mint: VALID_TOKEN_MINT_2, symbol: 'USDC', decimals: 6 }
      }),
      createTestPool({
        address: 'Pool3ccccccccccccccccccccccccccccccccccccc33',
        dex: 'raydium',
        token0: { mint: 'Token3MINT3333333333333333333333333333333', symbol: 'RAY', decimals: 6 },
        token1: { mint: VALID_TOKEN_MINT_2, symbol: 'USDC', decimals: 6 }
      })
    ];

    for (const pool of pools) {
      detector.addPool(pool);
    }

    // Verify indexes
    expect(detector.getPoolCount()).toBe(3);
    expect(detector.getPoolsByDex('raydium').length).toBe(2);
    expect(detector.getPoolsByDex('orca').length).toBe(1);
    expect(detector.getPoolsByTokenPair(VALID_TOKEN_MINT_1, VALID_TOKEN_MINT_2).length).toBe(2);

    // Remove one pool
    detector.removePool('Pool1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa11');

    // Verify indexes updated
    expect(detector.getPoolCount()).toBe(2);
    expect(detector.getPoolsByDex('raydium').length).toBe(1);
    expect(detector.getPoolsByTokenPair(VALID_TOKEN_MINT_1, VALID_TOKEN_MINT_2).length).toBe(1);
  });

  it('should correctly normalize token pair keys regardless of order', () => {
    // Add pools with tokens in different orders
    detector.addPool(createTestPool({
      address: 'Pool1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa11',
      dex: 'raydium',
      token0: { mint: VALID_TOKEN_MINT_1, symbol: 'SOL', decimals: 9 },
      token1: { mint: VALID_TOKEN_MINT_2, symbol: 'USDC', decimals: 6 }
    }));

    // Query with same order
    const pools1 = detector.getPoolsByTokenPair(VALID_TOKEN_MINT_1, VALID_TOKEN_MINT_2);

    // Query with reversed order
    const pools2 = detector.getPoolsByTokenPair(VALID_TOKEN_MINT_2, VALID_TOKEN_MINT_1);

    // Should find the same pool regardless of order
    expect(pools1.length).toBe(1);
    expect(pools2.length).toBe(1);
    expect(pools1[0].address).toBe(pools2[0].address);
  });

  it('should handle edge case of empty pool set', async () => {
    const opportunities = await detector.checkArbitrage();
    expect(opportunities).toEqual([]);
  });
});

// =============================================================================
// Integration Tests - Lifecycle with DI Pattern (Redis injected)
// =============================================================================

describe('S3.3.1 SolanaDetector Lifecycle Integration (DI Pattern)', () => {
  let detector: SolanaDetector | null = null;
  let mockRedisClient: SolanaDetectorRedisClient;
  let mockStreamsClient: SolanaDetectorStreamsClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedisClient = createMockRedisClient();
    mockStreamsClient = createMockStreamsClient();
  });

  afterEach(async () => {
    if (detector && detector.isRunning()) {
      await detector.stop();
    }
    detector = null;
  });

  describe('S3.3.1.2: Lifecycle Management (with DI)', () => {
    it('should start successfully with injected Redis clients', async () => {
      detector = new SolanaDetector(createTestConfig(), {
        logger: mockLogger,
        perfLogger: mockPerfLogger,
        redisClient: mockRedisClient,
        streamsClient: mockStreamsClient
      });

      await detector.start();

      expect(detector.isRunning()).toBe(true);
    });

    it('should emit started event', async () => {
      detector = new SolanaDetector(createTestConfig(), {
        logger: mockLogger,
        perfLogger: mockPerfLogger,
        redisClient: mockRedisClient,
        streamsClient: mockStreamsClient
      });

      const startedPromise = new Promise<{ chain: string }>((resolve) => {
        detector!.once('started', resolve);
      });

      await detector.start();
      const event = await startedPromise;

      expect(event.chain).toBe('solana');
    });

    it('should stop successfully', async () => {
      detector = new SolanaDetector(createTestConfig(), {
        logger: mockLogger,
        perfLogger: mockPerfLogger,
        redisClient: mockRedisClient,
        streamsClient: mockStreamsClient
      });

      await detector.start();
      await detector.stop();

      expect(detector.isRunning()).toBe(false);
    });

    it('should emit stopped event', async () => {
      detector = new SolanaDetector(createTestConfig(), {
        logger: mockLogger,
        perfLogger: mockPerfLogger,
        redisClient: mockRedisClient,
        streamsClient: mockStreamsClient
      });

      await detector.start();

      const stoppedPromise = new Promise<{ chain: string }>((resolve) => {
        detector!.once('stopped', resolve);
      });

      await detector.stop();
      const event = await stoppedPromise;

      expect(event.chain).toBe('solana');
    });

    it('should handle multiple start calls gracefully', async () => {
      detector = new SolanaDetector(createTestConfig(), {
        logger: mockLogger,
        perfLogger: mockPerfLogger,
        redisClient: mockRedisClient,
        streamsClient: mockStreamsClient
      });

      await detector.start();
      await detector.start(); // Should not throw

      expect(detector.isRunning()).toBe(true);
    });

    it('should handle multiple stop calls gracefully', async () => {
      detector = new SolanaDetector(createTestConfig(), {
        logger: mockLogger,
        perfLogger: mockPerfLogger,
        redisClient: mockRedisClient,
        streamsClient: mockStreamsClient
      });

      await detector.start();
      await detector.stop();
      await detector.stop(); // Should not throw

      expect(detector.isRunning()).toBe(false);
    });
  });

  describe('S3.3.1.3: Connection Pool (with DI)', () => {
    it('should initialize connection pool on start', async () => {
      detector = new SolanaDetector(createTestConfig({
        connectionPoolSize: 3
      }), {
        logger: mockLogger,
        perfLogger: mockPerfLogger,
        redisClient: mockRedisClient,
        streamsClient: mockStreamsClient
      });

      await detector.start();

      expect(detector.getConnectionPoolSize()).toBe(3);
    });

    it('should return healthy connection count', async () => {
      detector = new SolanaDetector(createTestConfig({
        connectionPoolSize: 2
      }), {
        logger: mockLogger,
        perfLogger: mockPerfLogger,
        redisClient: mockRedisClient,
        streamsClient: mockStreamsClient
      });

      await detector.start();

      expect(detector.getHealthyConnectionCount()).toBe(2);
    });

    it('should provide connection metrics', async () => {
      detector = new SolanaDetector(createTestConfig(), {
        logger: mockLogger,
        perfLogger: mockPerfLogger,
        redisClient: mockRedisClient,
        streamsClient: mockStreamsClient
      });

      await detector.start();

      const metrics = detector.getConnectionMetrics();

      expect(metrics.totalConnections).toBe(2);
      expect(metrics.healthyConnections).toBe(2);
    });
  });

  describe('S3.3.1.7: Health Monitoring (with DI)', () => {
    it('should return healthy status when running', async () => {
      detector = new SolanaDetector(createTestConfig(), {
        logger: mockLogger,
        perfLogger: mockPerfLogger,
        redisClient: mockRedisClient,
        streamsClient: mockStreamsClient
      });

      await detector.start();

      const health = await detector.getHealth();

      expect(health.status).toBe('healthy');
      expect(health.service).toBe('solana-detector');
    });

    it('should return unhealthy status when not running', async () => {
      detector = new SolanaDetector(createTestConfig(), {
        logger: mockLogger,
        perfLogger: mockPerfLogger,
        redisClient: mockRedisClient,
        streamsClient: mockStreamsClient
      });

      const health = await detector.getHealth();

      expect(health.status).toBe('unhealthy');
    });
  });

  describe('S3.3.1.11: Redis Integration (with DI)', () => {
    it('should create batcher on start', async () => {
      detector = new SolanaDetector(createTestConfig(), {
        logger: mockLogger,
        perfLogger: mockPerfLogger,
        redisClient: mockRedisClient,
        streamsClient: mockStreamsClient
      });

      await detector.start();

      expect(mockStreamsClient.createBatcher).toHaveBeenCalled();
    });

    it('should disconnect Redis on stop', async () => {
      detector = new SolanaDetector(createTestConfig(), {
        logger: mockLogger,
        perfLogger: mockPerfLogger,
        redisClient: mockRedisClient,
        streamsClient: mockStreamsClient
      });

      await detector.start();
      await detector.stop();

      expect(mockRedisClient.disconnect).toHaveBeenCalled();
      expect(mockStreamsClient.disconnect).toHaveBeenCalled();
    });
  });

  describe('S3.3.1.12: Resource Cleanup (with DI)', () => {
    it('should clear pools on stop', async () => {
      detector = new SolanaDetector(createTestConfig(), {
        logger: mockLogger,
        perfLogger: mockPerfLogger,
        redisClient: mockRedisClient,
        streamsClient: mockStreamsClient
      });

      await detector.start();
      detector.addPool(createTestPool());

      expect(detector.getPoolCount()).toBe(1);

      await detector.stop();

      expect(detector.getPoolCount()).toBe(0);
    });

    it('should clear connection pool on stop', async () => {
      detector = new SolanaDetector(createTestConfig(), {
        logger: mockLogger,
        perfLogger: mockPerfLogger,
        redisClient: mockRedisClient,
        streamsClient: mockStreamsClient
      });

      await detector.start();

      expect(detector.getActiveConnections()).toBe(2);

      await detector.stop();

      expect(detector.getActiveConnections()).toBe(0);
    });
  });
});
