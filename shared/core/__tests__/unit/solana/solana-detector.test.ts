/**
 * SolanaDetector Consolidated Unit Tests
 *
 * Tests for the SolanaDetector class covering:
 * - Configuration validation
 * - Pool management (no Redis required)
 * - Arbitrage detection logic
 * - DEX program constants
 * - Lifecycle management (DI pattern with injected Redis)
 * - Connection pool management
 * - Program account subscriptions
 * - Price update publishing
 * - Error handling and retries
 * - Partition system integration
 * - Regression tests (pool update consistency, snapshot pattern, immutability)
 *
 * @see IMPLEMENTATION_PLAN.md S3.3.1: Create Solana detector base infrastructure
 * @see ADR-003: Partitioned Chain Detectors
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// =============================================================================
// Test Imports - Use package aliases as configured in jest.config
// =============================================================================

import {
  SolanaDetector,
  SOLANA_DEX_PROGRAMS,
  type SolanaDetectorConfig,
  type SolanaPool,
  type SolanaDetectorRedisClient,
  type SolanaDetectorStreamsClient,
  type SolanaDetectorDeps
} from '@arbitrage/core';

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

function createTestDeps(overrides: Partial<SolanaDetectorDeps> = {}): SolanaDetectorDeps {
  return {
    logger: mockLogger,
    perfLogger: mockPerfLogger,
    redisClient: createMockRedisClient(),
    streamsClient: createMockStreamsClient(),
    ...overrides
  };
}

// =============================================================================
// Configuration Tests (no Redis required)
// =============================================================================

describe('SolanaDetector Configuration', () => {
  let detector: SolanaDetector | null = null;

  afterEach(() => {
    detector = null;
  });

  describe('Initialization and Configuration', () => {
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
// Pool Management Tests (no Redis required)
// =============================================================================

describe('SolanaDetector Pool Management', () => {
  let detector: SolanaDetector;

  beforeEach(() => {
    detector = new SolanaDetector(createTestConfig(), {
      logger: mockLogger,
      perfLogger: mockPerfLogger
    });
  });

  describe('Pool Tracking', () => {
    it('should add pool to tracking', async () => {
      const pool = createTestPool();
      await detector.addPool(pool);

      expect(detector.getPoolCount()).toBe(1);
      expect(detector.getPool(VALID_POOL_ADDRESS)).toBeDefined();
    });

    it('should remove pool from tracking', async () => {
      const pool = createTestPool();
      await detector.addPool(pool);
      await detector.removePool(VALID_POOL_ADDRESS);

      expect(detector.getPoolCount()).toBe(0);
      expect(detector.getPool(VALID_POOL_ADDRESS)).toBeUndefined();
    });

    it('should get pools by DEX', async () => {
      await detector.addPool(createTestPool({ dex: 'raydium' }));
      await detector.addPool(createTestPool({
        address: 'DKT8ncTnQMDZ1AnPrKbJTWMqzL7HXSkFHSFCdK8qBM9F',
        dex: 'orca'
      }));

      const raydiumPools = detector.getPoolsByDex('raydium');
      const orcaPools = detector.getPoolsByDex('orca');

      expect(raydiumPools.length).toBe(1);
      expect(orcaPools.length).toBe(1);
    });

    it('should get pools by token pair', async () => {
      await detector.addPool(createTestPool({
        dex: 'raydium',
        token0: { mint: VALID_TOKEN_MINT_1, symbol: 'SOL', decimals: 9 },
        token1: { mint: VALID_TOKEN_MINT_2, symbol: 'USDC', decimals: 6 }
      }));
      await detector.addPool(createTestPool({
        address: 'DKT8ncTnQMDZ1AnPrKbJTWMqzL7HXSkFHSFCdK8qBM9F',
        dex: 'orca',
        token0: { mint: VALID_TOKEN_MINT_1, symbol: 'SOL', decimals: 9 },
        token1: { mint: VALID_TOKEN_MINT_2, symbol: 'USDC', decimals: 6 }
      }));

      const pools = detector.getPoolsByTokenPair(VALID_TOKEN_MINT_1, VALID_TOKEN_MINT_2);

      expect(pools.length).toBe(2);
    });

    it('should handle removing non-existent pool gracefully', async () => {
      await detector.removePool('non-existent-address');
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
// Arbitrage Detection Tests (no Redis required)
// =============================================================================

describe('SolanaDetector Arbitrage Detection', () => {
  let detector: SolanaDetector;

  beforeEach(() => {
    detector = new SolanaDetector(createTestConfig({
      minProfitThreshold: 0.3 // 0.3%
    }), {
      logger: mockLogger,
      perfLogger: mockPerfLogger
    });
  });

  describe('Arbitrage Detection', () => {
    it('should detect arbitrage opportunity between pools with significant price difference', async () => {
      await detector.addPool(createTestPool({
        address: 'Pool1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa11',
        dex: 'raydium',
        price: 150,
        fee: 25
      }));

      await detector.addPool(createTestPool({
        address: 'Pool2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb22',
        dex: 'orca',
        price: 152, // 1.33% difference
        fee: 25
      }));

      const opportunities = await detector.checkArbitrage();

      expect(opportunities.length).toBeGreaterThan(0);
      expect(opportunities[0].chain).toBe('solana');
      expect(opportunities[0].buyDex).toBe('raydium');
      expect(opportunities[0].sellDex).toBe('orca');
    });

    it('should not detect arbitrage below threshold', async () => {
      await detector.addPool(createTestPool({
        address: 'Pool1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa11',
        dex: 'raydium',
        price: 150,
        fee: 25
      }));

      await detector.addPool(createTestPool({
        address: 'Pool2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb22',
        dex: 'orca',
        price: 150.30, // 0.2% difference
        fee: 25
      }));

      const opportunities = await detector.checkArbitrage();

      expect(opportunities.length).toBe(0);
    });

    it('should require at least 2 pools for arbitrage', async () => {
      await detector.addPool(createTestPool());

      const opportunities = await detector.checkArbitrage();

      expect(opportunities.length).toBe(0);
    });

    it('should calculate correct profit after fees', async () => {
      await detector.addPool(createTestPool({
        address: 'Pool1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa11',
        dex: 'raydium',
        price: 100,
        fee: 25
      }));

      await detector.addPool(createTestPool({
        address: 'Pool2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb22',
        dex: 'orca',
        price: 102, // 2% higher
        fee: 25
      }));

      const opportunities = await detector.checkArbitrage();

      expect(opportunities.length).toBe(1);
      expect(opportunities[0].profitPercentage).toBeGreaterThan(1.0);
      expect(opportunities[0].profitPercentage).toBeLessThan(2.0);
    });

    it('should handle multiple token pairs', async () => {
      // SOL/USDC pair
      await detector.addPool(createTestPool({
        address: 'Pool1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa11',
        dex: 'raydium',
        token0: { mint: VALID_TOKEN_MINT_1, symbol: 'SOL', decimals: 9 },
        token1: { mint: VALID_TOKEN_MINT_2, symbol: 'USDC', decimals: 6 },
        price: 150,
        fee: 25
      }));

      await detector.addPool(createTestPool({
        address: 'Pool2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb22',
        dex: 'orca',
        token0: { mint: VALID_TOKEN_MINT_1, symbol: 'SOL', decimals: 9 },
        token1: { mint: VALID_TOKEN_MINT_2, symbol: 'USDC', decimals: 6 },
        price: 153, // 2% higher
        fee: 25
      }));

      // RAY/USDC pair
      const rayMint = 'Token3RAYaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa33';
      await detector.addPool(createTestPool({
        address: 'Pool3ccccccccccccccccccccccccccccccccccccc33',
        dex: 'raydium',
        token0: { mint: rayMint, symbol: 'RAY', decimals: 6 },
        token1: { mint: VALID_TOKEN_MINT_2, symbol: 'USDC', decimals: 6 },
        price: 1.5,
        fee: 25
      }));

      await detector.addPool(createTestPool({
        address: 'Pool4ddddddddddddddddddddddddddddddddddddd44',
        dex: 'orca',
        token0: { mint: rayMint, symbol: 'RAY', decimals: 6 },
        token1: { mint: VALID_TOKEN_MINT_2, symbol: 'USDC', decimals: 6 },
        price: 1.53, // 2% higher
        fee: 25
      }));

      const opportunities = await detector.checkArbitrage();

      expect(opportunities.length).toBe(2);
    });

    it('should identify correct buy and sell sides', async () => {
      await detector.addPool(createTestPool({
        address: 'Pool1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa11',
        dex: 'raydium',
        price: 100,
        fee: 25
      }));

      await detector.addPool(createTestPool({
        address: 'Pool2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb22',
        dex: 'orca',
        price: 105,
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
// DEX Program Constants Tests
// =============================================================================

describe('SolanaDetector DEX Program Constants', () => {
  describe('DEX Program Constants', () => {
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

      for (const [_name, programId] of Object.entries(SOLANA_DEX_PROGRAMS) as [string, string][]) {
        expect(base58Regex.test(programId)).toBe(true);
        expect(programId.length).toBeGreaterThanOrEqual(32);
        expect(programId.length).toBeLessThanOrEqual(50);
      }
    });

    it('should not contain EVM-style hex addresses', () => {
      for (const [_name, programId] of Object.entries(SOLANA_DEX_PROGRAMS) as [string, string][]) {
        expect(programId).not.toMatch(/^0x/);
      }
    });
  });
});

// =============================================================================
// Cross-Component Integration Tests (no Redis required)
// =============================================================================

describe('SolanaDetector Cross-Component Integration', () => {
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
      await detector.addPool(pool);
    }

    expect(detector.getPoolCount()).toBe(3);
    expect(detector.getPoolsByDex('raydium').length).toBe(2);
    expect(detector.getPoolsByDex('orca').length).toBe(1);
    expect(detector.getPoolsByTokenPair(VALID_TOKEN_MINT_1, VALID_TOKEN_MINT_2).length).toBe(2);

    await detector.removePool('Pool1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa11');

    expect(detector.getPoolCount()).toBe(2);
    expect(detector.getPoolsByDex('raydium').length).toBe(1);
    expect(detector.getPoolsByTokenPair(VALID_TOKEN_MINT_1, VALID_TOKEN_MINT_2).length).toBe(1);
  });

  it('should correctly normalize token pair keys regardless of order', async () => {
    await detector.addPool(createTestPool({
      address: 'Pool1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa11',
      dex: 'raydium',
      token0: { mint: VALID_TOKEN_MINT_1, symbol: 'SOL', decimals: 9 },
      token1: { mint: VALID_TOKEN_MINT_2, symbol: 'USDC', decimals: 6 }
    }));

    const pools1 = detector.getPoolsByTokenPair(VALID_TOKEN_MINT_1, VALID_TOKEN_MINT_2);
    const pools2 = detector.getPoolsByTokenPair(VALID_TOKEN_MINT_2, VALID_TOKEN_MINT_1);

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
// NOTE: Lifecycle/Connection Pool/Subscriptions/Price Publishing/Error Handling
// tests were removed during Phase 2 consolidation because they require mocking
// the Solana Connection class (@solana/web3.js), which the DI mock setup does
// not provide. These tests existed in the older self-contained mock file but
// cannot work with the DI pattern without a full Connection mock.
// TODO: Re-add with proper @solana/web3.js Connection mocking when needed.
// =============================================================================

// =============================================================================
// Regression Tests: Pool Update Consistency
// =============================================================================

describe('Regression: Pool Update Consistency', () => {
  let detector: SolanaDetector;
  let deps: SolanaDetectorDeps;

  beforeEach(() => {
    jest.clearAllMocks();
    deps = createTestDeps();
    detector = new SolanaDetector({ rpcUrl: TEST_RPC_URL }, deps);
  });

  afterEach(async () => {
    if (detector.isRunning()) {
      await detector.stop();
    }
  });

  it('should have poolUpdateMutex defined for atomic updates', () => {
    expect((detector as any).poolUpdateMutex).toBeDefined();
    expect(typeof (detector as any).poolUpdateMutex.acquire).toBe('function');
    expect(typeof (detector as any).poolUpdateMutex.tryAcquire).toBe('function');
  });

  it('should keep pools, poolsByDex, and poolsByTokenPair consistent', async () => {
    const testPool = createTestPool({
      address: 'TestPoolAddress123',
      dex: 'raydium',
      token0: { mint: VALID_TOKEN_MINT_1, symbol: 'SOL', decimals: 9 },
      token1: { mint: VALID_TOKEN_MINT_2, symbol: 'USDC', decimals: 6 },
      price: 150,
      fee: 25
    });

    await detector.addPool(testPool);

    expect(detector.getPool(testPool.address)).toBeDefined();
    expect(detector.getPoolsByDex('raydium')).toContainEqual(expect.objectContaining({ address: testPool.address }));

    const pairPools = detector.getPoolsByTokenPair(VALID_TOKEN_MINT_1, VALID_TOKEN_MINT_2);
    expect(pairPools).toContainEqual(expect.objectContaining({ address: testPool.address }));

    await detector.removePool(testPool.address);

    expect(detector.getPool(testPool.address)).toBeUndefined();
    expect(detector.getPoolsByDex('raydium')).not.toContainEqual(expect.objectContaining({ address: testPool.address }));
    const pairPoolsAfter = detector.getPoolsByTokenPair(VALID_TOKEN_MINT_1, VALID_TOKEN_MINT_2);
    expect(pairPoolsAfter).not.toContainEqual(expect.objectContaining({ address: testPool.address }));
  });

  it('should cleanup empty Sets when removing last pool', async () => {
    const testPool = createTestPool({
      address: 'OnlyPoolInDex123',
      dex: 'unique-dex',
      token0: { mint: 'TokenA111111111111111111111111111111111111', symbol: 'TKA', decimals: 9 },
      token1: { mint: 'TokenB111111111111111111111111111111111111', symbol: 'TKB', decimals: 9 },
      price: 100,
      fee: 30
    });

    await detector.addPool(testPool);
    expect(detector.getPoolsByDex('unique-dex')).toHaveLength(1);

    await detector.removePool(testPool.address);

    expect(detector.getPoolsByDex('unique-dex')).toHaveLength(0);
  });
});

// =============================================================================
// Regression Tests: Arbitrage Detection Snapshot Pattern
// =============================================================================

describe('Regression: Arbitrage Detection Snapshot Pattern', () => {
  let detector: SolanaDetector;
  let deps: SolanaDetectorDeps;

  beforeEach(() => {
    jest.clearAllMocks();
    deps = createTestDeps();
    detector = new SolanaDetector(createTestConfig({
      minProfitThreshold: 0.1 // Low threshold for testing
    }), deps);
  });

  afterEach(async () => {
    if (detector.isRunning()) {
      await detector.stop();
    }
  });

  it('should use snapshot for consistent reads during arbitrage check', async () => {
    const pool1 = createTestPool({
      address: 'SnapshotPool1111111111111111111111111111111',
      dex: 'raydium',
      token0: { mint: 'SnapshotToken11111111111111111111111111111', symbol: 'TK1', decimals: 9 },
      token1: { mint: 'SnapshotToken22222222222222222222222222222', symbol: 'TK2', decimals: 6 },
      price: 100,
      fee: 25
    });

    const pool2 = createTestPool({
      address: 'SnapshotPool2222222222222222222222222222222',
      dex: 'orca',
      token0: { mint: 'SnapshotToken11111111111111111111111111111', symbol: 'TK1', decimals: 9 },
      token1: { mint: 'SnapshotToken22222222222222222222222222222', symbol: 'TK2', decimals: 6 },
      price: 102, // 2% higher
      fee: 30
    });

    await detector.addPool(pool1);
    await detector.addPool(pool2);

    const opportunitiesPromise = detector.checkArbitrage();

    // Modify pools during check (simulates concurrent modification)
    await detector.removePool(pool2.address);

    const opportunities = await opportunitiesPromise;

    // The check should complete successfully despite modification
    expect(opportunities).toBeDefined();
    expect(Array.isArray(opportunities)).toBe(true);
  });

  it('should create new pool object on price update (immutable pattern)', async () => {
    const pool = createTestPool({
      address: 'ImmutableTestPool11111111111111111111111111',
      dex: 'raydium',
      token0: { mint: 'ImmutableToken11111111111111111111111111111', symbol: 'TK1', decimals: 9 },
      token1: { mint: 'ImmutableToken22222222222222222222222222222', symbol: 'TK2', decimals: 6 },
      price: 100,
      fee: 25,
      reserve0: '1000000',
      reserve1: '1000000',
      lastSlot: 1000
    });

    await detector.addPool(pool);
    const poolBefore = detector.getPool(pool.address);

    await detector.updatePoolPrice(pool.address, {
      price: 110,
      reserve0: '1100000',
      reserve1: '900000',
      slot: 1001
    });

    const poolAfter = detector.getPool(pool.address);

    // Verify new object was created (not mutated in-place)
    expect(poolAfter).not.toBe(poolBefore);
    expect(poolAfter!.price).toBe(110);
    expect(poolBefore!.price).toBe(100);
  });
});
