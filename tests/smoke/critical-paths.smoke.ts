/**
 * Smoke Tests - Critical Paths
 *
 * Quick sanity checks to verify core functionality works.
 * These tests should:
 * - Run in <30 seconds total
 * - Test critical initialization paths
 * - Verify basic functionality of core components
 * - Not require external services (use mocks)
 *
 * Run with: npm run test:smoke
 *
 * @see docs/TEST_ARCHITECTURE.md - Phase 6: Smoke Test Suite
 */

// Import the full-featured RedisMock from the mocks module (has stream support)
import {
  createRedisMock,
  RedisMock,
} from '@arbitrage/test-utils/mocks/redis.mock';
import {
  CHAINS,
  DEXES,
  CORE_TOKENS,
  ARBITRAGE_CONFIG,
} from '@arbitrage/config';
import { DistributedLockManager } from '@arbitrage/core/redis';
import { ServiceState, createServiceState } from '@arbitrage/core/service-lifecycle';
import {
  createSwapEvent,
  swapEvent,
  createPriceUpdate,
} from '@arbitrage/test-utils';

// =============================================================================
// Configuration Smoke Tests
// =============================================================================

describe('Smoke Tests - Configuration', () => {
  it('should load chain configuration', () => {
    expect(CHAINS).toBeDefined();
    expect(Object.keys(CHAINS).length).toBeGreaterThan(0);

    // Verify essential chains exist
    expect(CHAINS.ethereum).toBeDefined();
    expect(CHAINS.arbitrum).toBeDefined();
    expect(CHAINS.bsc).toBeDefined();
  });

  it('should load DEX configuration', () => {
    expect(DEXES).toBeDefined();

    // Verify DEXes have required properties
    const dexNames = Object.keys(DEXES);
    expect(dexNames.length).toBeGreaterThan(0);

    // Check at least one DEX structure
    const firstDex = DEXES[dexNames[0]];
    if (Array.isArray(firstDex)) {
      expect(firstDex.length).toBeGreaterThan(0);
    }
  });

  it('should load token configuration', () => {
    expect(CORE_TOKENS).toBeDefined();

    // Verify tokens exist for major chains
    expect(CORE_TOKENS.ethereum || CORE_TOKENS['ethereum']).toBeDefined();
  });

  it('should load threshold configuration', () => {
    expect(ARBITRAGE_CONFIG).toBeDefined();
    expect(ARBITRAGE_CONFIG.minProfitPercentage).toBeDefined();
    expect(typeof ARBITRAGE_CONFIG.minProfitPercentage).toBe('number');
  });
});

// =============================================================================
// Redis Mock Smoke Tests
// =============================================================================

describe('Smoke Tests - Redis Mock', () => {
  let redis: RedisMock;

  beforeEach(() => {
    redis = createRedisMock();
  });

  afterEach(() => {
    redis.clear();
  });

  it('should perform basic get/set operations', async () => {
    await redis.set('test:key', 'test-value');
    const value = await redis.get('test:key');

    expect(value).toBe('test-value');
  });

  it('should handle Redis streams operations', async () => {
    const messageId = await redis.xadd(
      'test:stream',
      '*',
      'type', 'price_update',
      'data', JSON.stringify({ price: 3000 })
    );

    expect(messageId).toBeDefined();
    expect(messageId).toMatch(/^\d+-\d+$/);

    const streamLength = await redis.xlen('test:stream');
    expect(streamLength).toBe(1);
  });

  it('should respond to ping', async () => {
    const response = await redis.ping();
    expect(response).toBe('PONG');
  });

  it('should handle hash operations', async () => {
    await redis.hset('test:hash', 'field1', 'value1');
    const value = await redis.hget('test:hash', 'field1');

    expect(value).toBe('value1');
  });
});

// =============================================================================
// Core Module Smoke Tests
// =============================================================================

describe('Smoke Tests - Core Modules', () => {
  it('should import core module without errors', () => {
    // ES imports already validated at top of file
    expect(ServiceState).toBeDefined();
    expect(DistributedLockManager).toBeDefined();
    expect(createServiceState).toBeDefined();
  });

  it('should export ServiceState enum', () => {
    expect(ServiceState).toBeDefined();
    expect(ServiceState.STOPPED).toBeDefined();
    expect(ServiceState.STARTING).toBeDefined();
    expect(ServiceState.RUNNING).toBeDefined();
    expect(ServiceState.STOPPING).toBeDefined();
    expect(ServiceState.ERROR).toBeDefined();
  });

  it('should export DistributedLockManager', () => {
    expect(DistributedLockManager).toBeDefined();
    expect(typeof DistributedLockManager).toBe('function');
  });

  it('should export ServiceStateManager factory', () => {
    expect(createServiceState).toBeDefined();
    expect(typeof createServiceState).toBe('function');
  });
});

// =============================================================================
// Service State Smoke Tests
// =============================================================================

describe('Smoke Tests - Service State', () => {
  it('should create service state manager', () => {
    const stateManager = createServiceState({
      serviceName: 'smoke-test-service',
      transitionTimeoutMs: 1000,
    });

    expect(stateManager).toBeDefined();
    expect(stateManager.getState()).toBe(ServiceState.STOPPED);
  });

  it('should transition through basic lifecycle', async () => {
    const stateManager = createServiceState({
      serviceName: 'smoke-test-service',
      transitionTimeoutMs: 1000,
    });

    // STOPPED -> STARTING
    const startResult = await stateManager.transitionTo(ServiceState.STARTING);
    expect(startResult.success).toBe(true);
    expect(stateManager.getState()).toBe(ServiceState.STARTING);

    // STARTING -> RUNNING
    const runResult = await stateManager.transitionTo(ServiceState.RUNNING);
    expect(runResult.success).toBe(true);
    expect(stateManager.getState()).toBe(ServiceState.RUNNING);
    expect(stateManager.isRunning()).toBe(true);
  });
});

// =============================================================================
// Price Calculation Smoke Tests
// =============================================================================

describe('Smoke Tests - Price Calculation', () => {
  it('should calculate price from reserves', () => {
    // Basic constant-product AMM price calculation
    const reserve0 = BigInt('10000000000000000000000'); // 10,000 tokens (18 decimals)
    const reserve1 = BigInt('30000000000000');          // 30,000,000 tokens (6 decimals)

    // Price = reserve1 / reserve0 (adjusted for decimals)
    const price = Number(reserve1) / Number(reserve0) * 1e12; // Adjust for decimal difference

    expect(price).toBeGreaterThan(0);
    expect(price).toBeCloseTo(3000, 0); // ~3000 USDC per ETH
  });

  it('should calculate spread between two prices', () => {
    const price1 = 3000;
    const price2 = 3015; // 0.5% higher

    const spread = Math.abs(price1 - price2) / Math.min(price1, price2);

    expect(spread).toBeCloseTo(0.005, 3); // ~0.5%
  });

  it('should detect profitable arbitrage opportunity', () => {
    const buyPrice = 3000;
    const sellPrice = 3020;
    const fee1 = 0.003; // 0.3%
    const fee2 = 0.003; // 0.3%

    const grossSpread = (sellPrice - buyPrice) / buyPrice;
    const netProfit = grossSpread - fee1 - fee2;

    expect(netProfit).toBeGreaterThan(0);
    expect(netProfit).toBeCloseTo(0.00067, 4); // ~0.067% net profit
  });
});

// =============================================================================
// Distributed Lock Smoke Tests
// =============================================================================

describe('Smoke Tests - Distributed Lock', () => {
  let redis: RedisMock;

  beforeEach(() => {
    redis = createRedisMock();
  });

  afterEach(() => {
    redis.clear();
  });

  it('should acquire lock with mock Redis', async () => {
    const lockManager = new DistributedLockManager();
    await lockManager.initialize(redis as any);
    const result = await lockManager.acquireLock('smoke:test:lock', { ttlMs: 5000 });

    expect(result.acquired).toBe(true);
    expect(result.release).toBeDefined();
    expect(typeof result.release).toBe('function');

    // Release the lock
    await result.release();
  });

  it('should prevent double acquisition', async () => {
    const lockManager = new DistributedLockManager();
    await lockManager.initialize(redis as any);

    const first = await lockManager.acquireLock('smoke:test:lock2', { ttlMs: 5000 });
    const second = await lockManager.acquireLock('smoke:test:lock2', { ttlMs: 5000 });

    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(false);

    await first.release();
  });
});

// =============================================================================
// Test Utils Smoke Tests
// =============================================================================

describe('Smoke Tests - Test Utilities', () => {
  it('should create swap events from factory', () => {
    const event = createSwapEvent({
      dex: 'uniswap_v3',
      chain: 'ethereum',
    });

    expect(event).toBeDefined();
    expect(event.dex).toBe('uniswap_v3');
    expect(event.chain).toBe('ethereum');
    expect(event.pairAddress).toBeDefined();
  });

  it('should create price updates from factory', () => {
    const priceUpdate = createPriceUpdate({
      price: 3000,
      token0: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    });

    expect(priceUpdate).toBeDefined();
    expect(priceUpdate.price).toBe(3000);
  });

  it('should use builder pattern for swap events', () => {
    const event = swapEvent()
      .onChain('arbitrum')
      .onDex('sushiswap')
      .withUsdValue(10000)
      .build();

    expect(event.chain).toBe('arbitrum');
    expect(event.dex).toBe('sushiswap');
    expect(event.usdValue).toBe(10000);
  });
});

// =============================================================================
// Environment Smoke Tests
// =============================================================================

describe('Smoke Tests - Environment', () => {
  it('should have Node.js version >= 18', () => {
    const nodeVersion = parseInt(process.versions.node.split('.')[0], 10);
    expect(nodeVersion).toBeGreaterThanOrEqual(18);
  });

  it('should be running in test environment', () => {
    expect(process.env.NODE_ENV).toBe('test');
  });

  it('should have Jest globals available', () => {
    expect(typeof describe).toBe('function');
    expect(typeof it).toBe('function');
    expect(typeof expect).toBe('function');
    expect(typeof beforeEach).toBe('function');
    expect(typeof afterEach).toBe('function');
  });
});
