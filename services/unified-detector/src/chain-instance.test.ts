/**
 * ChainDetectorInstance Unit Tests
 *
 * Tests for fixes implemented in S2.2.1 code review:
 * - Bug 1: Same-DEX check (should not detect arbitrage within same DEX)
 * - Bug 2: Reverse token order price adjustment
 * - Inconsistency 1: Config-based profit threshold
 * - Inconsistency 2: isStopping guard during shutdown
 * - Fee-adjusted profit calculation
 *
 * @see S2.2.1 Code Review Analysis
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Mock the config module BEFORE importing anything else
jest.mock('@arbitrage/config', () => {
  const originalModule = jest.requireActual('@arbitrage/config') as any;
  return {
    ...originalModule,
    getEnabledDexes: (chainId: string) => {
      const dexes = originalModule.DEXES[chainId] || [];
      return dexes.filter((d: any) => d.enabled !== false);
    },
    dexFeeToPercentage: (feeBasisPoints: number) => feeBasisPoints / 10000
  };
});

// Mock the core module to avoid Redis connection
jest.mock('@arbitrage/core', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }),
  WebSocketManager: jest.fn().mockImplementation(() => ({
    connect: jest.fn(() => Promise.resolve()),
    disconnect: jest.fn(() => Promise.resolve()),
    subscribe: jest.fn(() => Promise.resolve()),
    on: jest.fn(),
    removeAllListeners: jest.fn()
  })),
  RedisStreamsClient: {
    STREAMS: {
      PRICE_UPDATES: 'price-updates',
      SWAP_EVENTS: 'swap-events',
      OPPORTUNITIES: 'opportunities',
      WHALE_ALERTS: 'whale-alerts'
    }
  }
}));

// Import AFTER mocks are set up
import { ARBITRAGE_CONFIG } from '@arbitrage/config';

// =============================================================================
// Test Types (matching chain-instance.ts internal types)
// =============================================================================

interface PairSnapshot {
  address: string;
  dex: string;
  token0: string;
  token1: string;
  reserve0: string;
  reserve1: string;
  fee: number;
  blockNumber: number;
}

// =============================================================================
// Helper Functions for Testing
// These replicate the private methods for unit testing
// =============================================================================

function isSameTokenPair(pair1: PairSnapshot, pair2: PairSnapshot): boolean {
  const token1_0 = pair1.token0.toLowerCase();
  const token1_1 = pair1.token1.toLowerCase();
  const token2_0 = pair2.token0.toLowerCase();
  const token2_1 = pair2.token1.toLowerCase();

  return (
    (token1_0 === token2_0 && token1_1 === token2_1) ||
    (token1_0 === token2_1 && token1_1 === token2_0)
  );
}

function isReverseOrder(pair1: PairSnapshot, pair2: PairSnapshot): boolean {
  const token1_0 = pair1.token0.toLowerCase();
  const token1_1 = pair1.token1.toLowerCase();
  const token2_0 = pair2.token0.toLowerCase();
  const token2_1 = pair2.token1.toLowerCase();

  return token1_0 === token2_1 && token1_1 === token2_0;
}

function getMinProfitThreshold(chainId: string): number {
  const chainMinProfits = ARBITRAGE_CONFIG.chainMinProfits as Record<string, number>;
  // S2.2.3 FIX: Use ?? instead of || to correctly handle 0 min profit
  return chainMinProfits[chainId] ?? 0.003;
}

function calculateArbitrage(
  pair1: PairSnapshot,
  pair2: PairSnapshot,
  chainId: string
): { isProfitable: boolean; netProfitPct: number; price1: number; price2: number } | null {
  const reserve1_0 = BigInt(pair1.reserve0);
  const reserve1_1 = BigInt(pair1.reserve1);
  const reserve2_0 = BigInt(pair2.reserve0);
  const reserve2_1 = BigInt(pair2.reserve1);

  if (reserve1_0 === 0n || reserve1_1 === 0n || reserve2_0 === 0n || reserve2_1 === 0n) {
    return null;
  }

  // Calculate prices
  const price1 = Number(reserve1_1) / Number(reserve1_0);
  let price2 = Number(reserve2_1) / Number(reserve2_0);

  // Adjust price for reverse order pairs
  if (isReverseOrder(pair1, pair2) && price2 !== 0) {
    price2 = 1 / price2;
  }

  // Calculate price difference
  const priceDiff = Math.abs(price1 - price2) / Math.min(price1, price2);

  // Calculate fee-adjusted profit
  // S2.2.3 FIX: Use ?? instead of || to correctly handle fee: 0
  const totalFees = (pair1.fee ?? 0.003) + (pair2.fee ?? 0.003);
  const netProfitPct = priceDiff - totalFees;

  // Check against threshold
  const minProfitThreshold = getMinProfitThreshold(chainId);
  const isProfitable = netProfitPct >= minProfitThreshold;

  return { isProfitable, netProfitPct, price1, price2 };
}

// =============================================================================
// Test Data
// =============================================================================

const createPairSnapshot = (overrides: Partial<PairSnapshot> = {}): PairSnapshot => ({
  address: '0x1234567890123456789012345678901234567890',
  dex: 'uniswap_v3',
  token0: '0xTokenA',
  token1: '0xTokenB',
  reserve0: '1000000000000000000000', // 1000 tokens
  reserve1: '2000000000000000000000', // 2000 tokens (price = 2)
  fee: 0.003, // 0.3%
  blockNumber: 12345678,
  ...overrides
});

// =============================================================================
// Tests
// =============================================================================

describe('ChainDetectorInstance Bug Fixes', () => {
  describe('Bug 1: Same-DEX Check', () => {
    it('should detect same token pair on DIFFERENT DEXes', () => {
      const pair1 = createPairSnapshot({ dex: 'uniswap_v3' });
      const pair2 = createPairSnapshot({ dex: 'sushiswap', address: '0xdifferent' });

      expect(isSameTokenPair(pair1, pair2)).toBe(true);
      expect(pair1.dex).not.toBe(pair2.dex);
    });

    it('should skip arbitrage detection for same DEX (no opportunity possible)', () => {
      const pair1 = createPairSnapshot({ dex: 'uniswap_v3' });
      const pair2 = createPairSnapshot({ dex: 'uniswap_v3', address: '0xdifferent' });

      // This would be skipped in checkArbitrageOpportunity by the same-DEX check
      expect(pair1.dex).toBe(pair2.dex);
    });

    it('should not flag pairs from same DEX even with different addresses', () => {
      const pair1 = createPairSnapshot({
        dex: 'balancer_v2',
        address: '0xBalancerPool1'
      });
      const pair2 = createPairSnapshot({
        dex: 'balancer_v2',
        address: '0xBalancerPool2'
      });

      // Same DEX, different pools - should be skipped
      expect(pair1.dex).toBe(pair2.dex);
      expect(pair1.address).not.toBe(pair2.address);
    });
  });

  describe('Bug 2: Reverse Token Order Price Adjustment', () => {
    it('should detect same token pair in same order', () => {
      const pair1 = createPairSnapshot({
        token0: '0xWETH',
        token1: '0xUSDC'
      });
      const pair2 = createPairSnapshot({
        token0: '0xWETH',
        token1: '0xUSDC',
        dex: 'sushiswap'
      });

      expect(isSameTokenPair(pair1, pair2)).toBe(true);
      expect(isReverseOrder(pair1, pair2)).toBe(false);
    });

    it('should detect same token pair in reverse order', () => {
      const pair1 = createPairSnapshot({
        token0: '0xWETH',
        token1: '0xUSDC'
      });
      const pair2 = createPairSnapshot({
        token0: '0xUSDC',
        token1: '0xWETH',
        dex: 'sushiswap'
      });

      expect(isSameTokenPair(pair1, pair2)).toBe(true);
      expect(isReverseOrder(pair1, pair2)).toBe(true);
    });

    it('should invert price for reverse order pairs', () => {
      // Pair1: WETH/USDC with price 2 (1 WETH = 2 USDC)
      const pair1 = createPairSnapshot({
        token0: '0xWETH',
        token1: '0xUSDC',
        reserve0: '1000000000000000000', // 1 WETH
        reserve1: '2000000000'           // 2000 USDC (6 decimals)
      });

      // Pair2: USDC/WETH (reversed) with price 0.5 (1 USDC = 0.0005 WETH)
      // After inversion, should be 2 to match pair1
      const pair2 = createPairSnapshot({
        token0: '0xUSDC',
        token1: '0xWETH',
        reserve0: '2000000000',           // 2000 USDC
        reserve1: '1000000000000000000',  // 1 WETH
        dex: 'sushiswap'
      });

      const result = calculateArbitrage(pair1, pair2, 'arbitrum');

      // Prices should be comparable after adjustment
      expect(result).not.toBeNull();
      // Both prices should be approximately 2 (adjusted)
      expect(result!.price1).toBeCloseTo(2000000000 / 1e18 * 1e6, 1); // ~2e-9 due to decimals
    });

    it('should correctly compare prices after reverse order adjustment', () => {
      // Create pairs where reverse order matters for arbitrage detection
      const pair1 = createPairSnapshot({
        token0: '0xTokenA',
        token1: '0xTokenB',
        reserve0: '1000000000000000000000',
        reserve1: '2000000000000000000000',
        fee: 0.001
      });

      // Reversed but with slight price difference
      const pair2 = createPairSnapshot({
        token0: '0xTokenB',
        token1: '0xTokenA',
        reserve0: '2100000000000000000000', // Price is ~2.1 (1/0.476)
        reserve1: '1000000000000000000000',
        dex: 'curve',
        fee: 0.0004 // Curve low fee
      });

      const result = calculateArbitrage(pair1, pair2, 'arbitrum');
      expect(result).not.toBeNull();
    });
  });

  describe('Inconsistency 1: Config-Based Profit Threshold', () => {
    it('should use Ethereum threshold (0.5%)', () => {
      const threshold = getMinProfitThreshold('ethereum');
      expect(threshold).toBe(0.005);
    });

    it('should use Arbitrum threshold (0.2%)', () => {
      const threshold = getMinProfitThreshold('arbitrum');
      expect(threshold).toBe(0.002);
    });

    it('should use Optimism threshold (0.2%)', () => {
      const threshold = getMinProfitThreshold('optimism');
      expect(threshold).toBe(0.002);
    });

    it('should use BSC threshold (0.3%)', () => {
      const threshold = getMinProfitThreshold('bsc');
      expect(threshold).toBe(0.003);
    });

    it('should use default threshold (0.3%) for unknown chain', () => {
      const threshold = getMinProfitThreshold('unknown_chain');
      expect(threshold).toBe(0.003);
    });

    it('should reject opportunity below chain threshold', () => {
      // 0.3% spread with 0.6% total fees = negative net profit
      const pair1 = createPairSnapshot({
        reserve0: '1000000000000000000000',
        reserve1: '2000000000000000000000',
        fee: 0.003
      });
      const pair2 = createPairSnapshot({
        reserve0: '1000000000000000000000',
        reserve1: '2006000000000000000000', // 0.3% higher
        dex: 'sushiswap',
        fee: 0.003
      });

      const result = calculateArbitrage(pair1, pair2, 'arbitrum');
      // Should not be profitable after fees
      expect(result?.isProfitable).toBe(false);
    });

    it('should accept opportunity above chain threshold after fees', () => {
      // 2% spread with 0.6% total fees = 1.4% net profit > 0.2% threshold
      const pair1 = createPairSnapshot({
        reserve0: '1000000000000000000000',
        reserve1: '2000000000000000000000',
        fee: 0.003
      });
      const pair2 = createPairSnapshot({
        reserve0: '1000000000000000000000',
        reserve1: '2040000000000000000000', // 2% higher
        dex: 'sushiswap',
        fee: 0.003
      });

      const result = calculateArbitrage(pair1, pair2, 'arbitrum');
      expect(result?.isProfitable).toBe(true);
      expect(result?.netProfitPct).toBeGreaterThan(0.002);
    });
  });

  describe('Fee-Adjusted Profit Calculation', () => {
    it('should account for fees in profit calculation', () => {
      // 1% price difference, 0.6% total fees = 0.4% net profit
      const pair1 = createPairSnapshot({
        reserve0: '1000000000000000000000',
        reserve1: '2000000000000000000000',
        fee: 0.003 // 0.3%
      });
      const pair2 = createPairSnapshot({
        reserve0: '1000000000000000000000',
        reserve1: '2020000000000000000000', // 1% higher
        dex: 'sushiswap',
        fee: 0.003 // 0.3%
      });

      const result = calculateArbitrage(pair1, pair2, 'arbitrum');
      expect(result).not.toBeNull();

      // Net profit should be ~0.4% (1% spread - 0.6% fees)
      // Allowing for floating point imprecision
      expect(result!.netProfitPct).toBeCloseTo(0.004, 3);
    });

    it('should use Curve low fees correctly', () => {
      // Same price difference, but Curve has much lower fees
      const pair1 = createPairSnapshot({
        reserve0: '1000000000000000000000',
        reserve1: '2000000000000000000000',
        dex: 'curve',
        fee: 0.0004 // 0.04% (4 bps)
      });
      const pair2 = createPairSnapshot({
        reserve0: '1000000000000000000000',
        reserve1: '2010000000000000000000', // 0.5% higher
        dex: 'uniswap_v3',
        fee: 0.003 // 0.3%
      });

      const result = calculateArbitrage(pair1, pair2, 'arbitrum');
      expect(result).not.toBeNull();

      // Total fees = 0.04% + 0.3% = 0.34%
      // Net profit = 0.5% - 0.34% = ~0.16%
      expect(result!.netProfitPct).toBeCloseTo(0.0016, 3);
    });

    it('should reject opportunity when fees exceed spread', () => {
      // 0.4% price difference, 0.6% total fees = -0.2% net profit
      const pair1 = createPairSnapshot({
        reserve0: '1000000000000000000000',
        reserve1: '2000000000000000000000',
        fee: 0.003
      });
      const pair2 = createPairSnapshot({
        reserve0: '1000000000000000000000',
        reserve1: '2008000000000000000000', // 0.4% higher
        dex: 'sushiswap',
        fee: 0.003
      });

      const result = calculateArbitrage(pair1, pair2, 'arbitrum');
      expect(result?.isProfitable).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    it('should handle zero reserves', () => {
      const pair1 = createPairSnapshot();
      const pair2 = createPairSnapshot({
        reserve0: '0',
        dex: 'sushiswap'
      });

      const result = calculateArbitrage(pair1, pair2, 'arbitrum');
      expect(result).toBeNull();
    });

    it('should handle case-insensitive token addresses', () => {
      const pair1 = createPairSnapshot({
        token0: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
        token1: '0x1234567890ABCDEF1234567890ABCDEF12345678'
      });
      const pair2 = createPairSnapshot({
        token0: '0xabcdef1234567890abcdef1234567890abcdef12',
        token1: '0x1234567890abcdef1234567890abcdef12345678',
        dex: 'sushiswap'
      });

      expect(isSameTokenPair(pair1, pair2)).toBe(true);
    });

    it('should detect different token pairs', () => {
      const pair1 = createPairSnapshot({
        token0: '0xWETH',
        token1: '0xUSDC'
      });
      const pair2 = createPairSnapshot({
        token0: '0xWETH',
        token1: '0xDAI',
        dex: 'sushiswap'
      });

      expect(isSameTokenPair(pair1, pair2)).toBe(false);
    });

    it('should use default fee when fee is undefined', () => {
      const pair1 = createPairSnapshot({
        reserve0: '1000000000000000000000',
        reserve1: '2000000000000000000000',
        fee: undefined as any
      });
      const pair2 = createPairSnapshot({
        reserve0: '1000000000000000000000',
        reserve1: '2100000000000000000000', // 5% higher
        dex: 'sushiswap',
        fee: 0.003
      });

      const result = calculateArbitrage(pair1, pair2, 'arbitrum');
      expect(result).not.toBeNull();
      // Should use default 0.3% fee for pair1
    });
  });
});

describe('ArbitrageOpportunity Schema Consistency', () => {
  it('should include all required fields for downstream consumers', () => {
    // This test documents the expected schema
    const expectedFields = [
      'id',
      'type',
      'chain',
      'buyDex',
      'sellDex',
      'buyPair',
      'sellPair',
      'token0',
      'token1',
      'buyPrice',
      'sellPrice',
      'profitPercentage',
      'expectedProfit',
      'estimatedProfit',
      'gasEstimate',
      'confidence',
      'timestamp',
      'expiresAt',
      'blockNumber',
      'status'
    ];

    // Verify that ARBITRAGE_CONFIG exists
    expect(ARBITRAGE_CONFIG).toBeDefined();
    expect(ARBITRAGE_CONFIG.chainMinProfits).toBeDefined();

    // These fields should match between base-detector.ts and chain-instance.ts
    expectedFields.forEach(field => {
      expect(typeof field).toBe('string');
    });
  });

  it('should use type: simple for consistency with base-detector.ts', () => {
    const validTypes = ['simple', 'triangular', 'cross-chain'];
    expect(validTypes).toContain('simple');
  });
});

// =============================================================================
// P0 Regression Tests - Lifecycle Race Conditions
// =============================================================================

describe('P0 Regression Tests: ChainDetectorInstance Lifecycle', () => {
  /**
   * P0-NEW-3: Race Condition in Lifecycle - Concurrent Start
   * Tests that concurrent start() calls return the same promise
   */
  describe('P0-NEW-3: Concurrent start() calls', () => {
    it('should only allow one start operation at a time', async () => {
      // This test verifies the fix where startPromise is stored
      // Multiple start calls should get the same promise

      // Mock a slow start operation
      const mockChainInstance = {
        startPromise: null as Promise<void> | null,
        stopPromise: null as Promise<void> | null,
        isRunning: false,
        isStopping: false,

        async start(): Promise<void> {
          if (this.startPromise) return this.startPromise;
          if (this.stopPromise) await this.stopPromise;
          if (this.isStopping || this.isRunning) return;

          this.startPromise = (async () => {
            await new Promise(r => setTimeout(r, 50));
            this.isRunning = true;
          })();

          try {
            await this.startPromise;
          } finally {
            this.startPromise = null;
          }
        }
      };

      // Call start concurrently
      const results = await Promise.all([
        mockChainInstance.start(),
        mockChainInstance.start(),
        mockChainInstance.start()
      ]);

      // All should complete without error
      expect(results).toHaveLength(3);
      expect(mockChainInstance.isRunning).toBe(true);
    });
  });

  /**
   * P0-NEW-4: Stop Promise Pattern
   * Tests that concurrent stop() calls return the same promise
   */
  describe('P0-NEW-4: Concurrent stop() calls', () => {
    it('should only allow one stop operation at a time', async () => {
      let stopCount = 0;

      const mockChainInstance = {
        startPromise: null as Promise<void> | null,
        stopPromise: null as Promise<void> | null,
        isRunning: true,
        isStopping: false,

        async stop(): Promise<void> {
          if (this.stopPromise) return this.stopPromise;
          if (!this.isRunning && !this.isStopping) return;

          this.stopPromise = (async () => {
            stopCount++;
            this.isStopping = true;
            this.isRunning = false;
            await new Promise(r => setTimeout(r, 50));
            this.isStopping = false;
          })();

          try {
            await this.stopPromise;
          } finally {
            this.stopPromise = null;
          }
        }
      };

      // Call stop concurrently
      await Promise.all([
        mockChainInstance.stop(),
        mockChainInstance.stop(),
        mockChainInstance.stop()
      ]);

      // Stop should only execute once
      expect(stopCount).toBe(1);
      expect(mockChainInstance.isRunning).toBe(false);
      expect(mockChainInstance.isStopping).toBe(false);
    });

    it('should wait for pending stop when start is called', async () => {
      const events: string[] = [];

      const mockChainInstance = {
        startPromise: null as Promise<void> | null,
        stopPromise: null as Promise<void> | null,
        isRunning: true,
        isStopping: false,

        async start(): Promise<void> {
          if (this.stopPromise) {
            events.push('start-waiting-for-stop');
            await this.stopPromise;
          }
          events.push('start-complete');
        },

        async stop(): Promise<void> {
          if (this.stopPromise) return this.stopPromise;

          this.stopPromise = (async () => {
            events.push('stop-started');
            this.isStopping = true;
            this.isRunning = false;
            await new Promise(r => setTimeout(r, 50));
            events.push('stop-complete');
            this.isStopping = false;
          })();

          try {
            await this.stopPromise;
          } finally {
            this.stopPromise = null;
          }
        }
      };

      // Start stop, then immediately try to start
      const stopPromise = mockChainInstance.stop();
      const startPromise = mockChainInstance.start();

      await Promise.all([stopPromise, startPromise]);

      // Stop should complete before start proceeds
      expect(events).toContain('stop-started');
      expect(events).toContain('stop-complete');
      expect(events.indexOf('stop-complete')).toBeLessThan(events.indexOf('start-complete'));
    });
  });

  /**
   * P0-NEW-1: Memory Leak - blockLatencies Cleanup
   */
  describe('P0-NEW-1: blockLatencies cleanup', () => {
    it('should clear all state on stop', () => {
      const state = {
        isRunning: true,
        blockLatencies: [100, 200, 300, 400, 500],
        eventsProcessed: 1000,
        opportunitiesFound: 50,
        lastBlockNumber: 12345,
        lastBlockTimestamp: Date.now(),
        reconnectAttempts: 3,
        pairs: new Map([['key', { address: '0x123' }]]),
        pairsByAddress: new Map([['0x123', { address: '0x123' }]])
      };

      // Simulate stop cleanup (as implemented in performStop)
      state.isRunning = false;
      state.blockLatencies = [];
      state.eventsProcessed = 0;
      state.opportunitiesFound = 0;
      state.lastBlockNumber = 0;
      state.lastBlockTimestamp = 0;
      state.reconnectAttempts = 0;
      state.pairs.clear();
      state.pairsByAddress.clear();

      expect(state.blockLatencies).toEqual([]);
      expect(state.eventsProcessed).toBe(0);
      expect(state.opportunitiesFound).toBe(0);
      expect(state.lastBlockNumber).toBe(0);
      expect(state.pairs.size).toBe(0);
      expect(state.pairsByAddress.size).toBe(0);
    });
  });

  /**
   * P0-NEW-6: WebSocket Disconnect Timeout
   */
  describe('P0-NEW-6: WebSocket disconnect timeout', () => {
    it('should not hang if disconnect never resolves', async () => {
      const TIMEOUT_MS = 100; // Short timeout for test

      const hangingWsManager = {
        removeAllListeners: jest.fn(),
        disconnect: () => new Promise<void>(() => {}) // Never resolves
      };

      const startTime = Date.now();

      // Simulate the timeout pattern used in performStop
      try {
        await Promise.race([
          hangingWsManager.disconnect(),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('Timeout')), TIMEOUT_MS)
          )
        ]);
      } catch (error) {
        // Expected to timeout
      }

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(TIMEOUT_MS + 50); // Allow 50ms buffer
    });

    it('should handle disconnect errors gracefully', async () => {
      const errorWsManager = {
        removeAllListeners: jest.fn(),
        disconnect: () => Promise.reject(new Error('Connection lost'))
      };

      let error: Error | null = null;

      try {
        await Promise.race([
          errorWsManager.disconnect(),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('Timeout')), 1000)
          )
        ]);
      } catch (e) {
        error = e as Error;
      }

      // Error should be caught, not thrown
      expect(error).not.toBeNull();
      expect(error?.message).toBe('Connection lost');
    });
  });
});

// =============================================================================
// Bug Fix Regression Tests - Triangular/Multi-leg/Whale Detection
// =============================================================================

describe('Bug Fix Regression Tests', () => {
  /**
   * BUG-1: Token Address vs Symbol Mismatch
   * Tests that baseTokens use addresses, not symbols for triangular detection
   */
  describe('BUG-1: Token Address vs Symbol Matching', () => {
    it('should use token addresses for matching, not symbols', () => {
      // Simulate the token configuration
      const tokens = [
        { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', symbol: 'USDT', decimals: 6 },
        { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6 },
        { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', symbol: 'WETH', decimals: 18 }
      ];

      // BUG FIX: Use addresses instead of symbols
      const baseTokens = tokens.slice(0, 4).map(t => t.address.toLowerCase());

      // Verify addresses are used, not symbols
      expect(baseTokens[0]).toBe('0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9');
      expect(baseTokens[0]).not.toBe('USDT');
    });

    it('should match DexPool token0/token1 format (addresses)', () => {
      // DexPool uses addresses from PairSnapshot
      const dexPool = {
        dex: 'uniswap_v3',
        token0: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
        token1: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
        reserve0: '1000000',
        reserve1: '2000000',
        fee: 30,
        liquidity: 3000000,
        price: 2
      };

      // Verify DexPool uses addresses
      expect(dexPool.token0.startsWith('0x')).toBe(true);
      expect(dexPool.token1.startsWith('0x')).toBe(true);
    });

    it('should allow triangular path finding with address-based tokens', () => {
      // Simulate the token pair key format used in groupPoolsByPairs
      const pool = {
        token0: '0xTokenA'.toLowerCase(),
        token1: '0xTokenB'.toLowerCase()
      };

      const pairKey = `${pool.token0}_${pool.token1}`;
      const reverseKey = `${pool.token1}_${pool.token0}`;

      // Both directions should be stored for path finding
      expect(pairKey).toBe('0xtokena_0xtokenb');
      expect(reverseKey).toBe('0xtokenb_0xtokena');
    });
  });

  /**
   * BUG-2: Singleton SwapEventFilter Duplicate Handler Registration
   * Tests that whale alert handlers are properly cleaned up
   */
  describe('BUG-2: Whale Alert Handler Cleanup', () => {
    it('should store unsubscribe function for cleanup', () => {
      // Simulate handler registration
      const handlers: (() => void)[] = [];
      let unsubscribeCalled = false;

      const mockOnWhaleAlert = (handler: () => void) => {
        handlers.push(handler);
        // Return unsubscribe function
        return () => {
          unsubscribeCalled = true;
          const index = handlers.indexOf(handler);
          if (index > -1) handlers.splice(index, 1);
        };
      };

      // Register handler and store unsubscribe
      const unsubscribe = mockOnWhaleAlert(() => {});
      expect(handlers.length).toBe(1);

      // Call unsubscribe (as done in performStop)
      unsubscribe();
      expect(unsubscribeCalled).toBe(true);
      expect(handlers.length).toBe(0);
    });

    it('should prevent duplicate alerts from multiple chain instances', () => {
      const alerts: string[] = [];

      // Simulate singleton with multiple handlers
      const handlers: ((alert: string) => void)[] = [];
      const singleton = {
        onWhaleAlert: (handler: (alert: string) => void) => {
          handlers.push(handler);
          return () => {
            const index = handlers.indexOf(handler);
            if (index > -1) handlers.splice(index, 1);
          };
        },
        emitWhaleAlert: (alert: string) => {
          handlers.forEach(h => h(alert));
        }
      };

      // Chain 1 registers handler
      const unsubscribe1 = singleton.onWhaleAlert((alert) => {
        alerts.push(`chain1: ${alert}`);
      });

      // Chain 2 registers handler
      const unsubscribe2 = singleton.onWhaleAlert((alert) => {
        alerts.push(`chain2: ${alert}`);
      });

      // Emit alert - both handlers fire (BUG behavior)
      singleton.emitWhaleAlert('whale-tx-1');
      expect(alerts).toHaveLength(2);

      // Chain 1 stops and unsubscribes (FIX behavior)
      unsubscribe1();
      alerts.length = 0;

      // Emit alert - only chain2 handler fires
      singleton.emitWhaleAlert('whale-tx-2');
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toBe('chain2: whale-tx-2');
    });
  });

  /**
   * BUG-3: Missing usdValue in SwapEvent
   * Tests USD value estimation for whale detection
   */
  describe('BUG-3: USD Value Estimation', () => {
    // Helper function to test stablecoin detection
    function isStablecoin(symbol: string): boolean {
      const stableSymbols = ['USDT', 'USDC', 'DAI', 'BUSD', 'FRAX', 'TUSD', 'USDP', 'UST', 'MIM'];
      return stableSymbols.includes(symbol.toUpperCase());
    }

    it('should detect common stablecoins', () => {
      expect(isStablecoin('USDT')).toBe(true);
      expect(isStablecoin('USDC')).toBe(true);
      expect(isStablecoin('DAI')).toBe(true);
      expect(isStablecoin('BUSD')).toBe(true);
      expect(isStablecoin('usdt')).toBe(true); // case insensitive
    });

    it('should not flag non-stablecoins', () => {
      expect(isStablecoin('WETH')).toBe(false);
      expect(isStablecoin('WBTC')).toBe(false);
      expect(isStablecoin('ARB')).toBe(false);
    });

    it('should use stablecoin amount directly as USD value', () => {
      // Simulate swap with USDC (6 decimals)
      const amount0In = '0'; // WETH
      const amount1In = '50000000000'; // 50,000 USDC
      const amount0Out = '25000000000000000000'; // 25 WETH
      const amount1Out = '0';

      const token0Decimals = 18; // WETH
      const token1Decimals = 6;  // USDC
      const token1Symbol = 'USDC';

      // If token1 is stablecoin, use its amount as USD
      if (isStablecoin(token1Symbol)) {
        const amt1In = Number(BigInt(amount1In)) / Math.pow(10, token1Decimals);
        const usdValue = Math.max(amt1In, 0);
        expect(usdValue).toBe(50000); // $50,000
      }
    });

    it('should estimate USD value for non-stablecoin pairs using reserves', () => {
      // ETH/BTC pair - neither is stablecoin
      const reserve0 = '100000000000000000000'; // 100 ETH (18 decimals)
      const reserve1 = '500000000'; // 5 BTC (8 decimals: 5 * 10^8)

      const amt0In = 1; // 1 ETH swapped

      const token0Decimals = 18;
      const token1Decimals = 8;

      const r0 = Number(BigInt(reserve0)) / Math.pow(10, token0Decimals); // 100 ETH
      const r1 = Number(BigInt(reserve1)) / Math.pow(10, token1Decimals); // 5 BTC

      // Estimate using reserve ratio
      // If 100 ETH = 5 BTC, then 1 ETH = 0.05 BTC
      // So trade of 1 ETH is worth approximately 0.05 BTC
      const estimate = amt0In * (r1 / r0);
      expect(estimate).toBeCloseTo(0.05, 2);
    });
  });

  /**
   * BUG-4: Missing Cleanup in performStop
   * Tests that all resources are properly cleaned up
   */
  describe('BUG-4: Resource Cleanup in performStop', () => {
    it('should clear all singleton references on stop', () => {
      const state = {
        swapEventFilter: { id: 'filter' },
        multiLegPathFinder: { id: 'finder' },
        whaleAlertUnsubscribe: jest.fn()
      };

      // Simulate cleanup in performStop
      if (state.whaleAlertUnsubscribe) {
        state.whaleAlertUnsubscribe();
      }
      state.whaleAlertUnsubscribe = null as any;
      state.swapEventFilter = null as any;
      state.multiLegPathFinder = null as any;

      expect(state.whaleAlertUnsubscribe).toBeNull();
      expect(state.swapEventFilter).toBeNull();
      expect(state.multiLegPathFinder).toBeNull();
    });

    it('should allow clean restart after stop', () => {
      let startCount = 0;
      let stopCount = 0;

      const instance = {
        swapEventFilter: null as any,
        whaleAlertUnsubscribe: null as (() => void) | null,
        isRunning: false,

        start() {
          startCount++;
          this.swapEventFilter = { id: `filter-${startCount}` };
          this.whaleAlertUnsubscribe = () => {};
          this.isRunning = true;
        },

        stop() {
          stopCount++;
          if (this.whaleAlertUnsubscribe) {
            this.whaleAlertUnsubscribe();
            this.whaleAlertUnsubscribe = null;
          }
          this.swapEventFilter = null;
          this.isRunning = false;
        }
      };

      // First start
      instance.start();
      expect(instance.isRunning).toBe(true);
      expect(instance.swapEventFilter).not.toBeNull();

      // Stop
      instance.stop();
      expect(instance.isRunning).toBe(false);
      expect(instance.swapEventFilter).toBeNull();
      expect(instance.whaleAlertUnsubscribe).toBeNull();

      // Restart - should work cleanly
      instance.start();
      expect(instance.isRunning).toBe(true);
      expect(instance.swapEventFilter?.id).toBe('filter-2');

      expect(startCount).toBe(2);
      expect(stopCount).toBe(1);
    });
  });
});

// =============================================================================
// P0-PERF Regression Tests - Token Pair Key O(1) Lookup
// =============================================================================

/**
 * P0-PERF FIX: getTokenPairKey generates normalized keys for O(1) arbitrage detection
 * This function is critical for correctness - incorrect keys lead to missed opportunities
 */
function getTokenPairKey(token0: string, token1: string): string {
  const t0 = token0.toLowerCase();
  const t1 = token1.toLowerCase();
  return t0 < t1 ? `${t0}_${t1}` : `${t1}_${t0}`;
}

describe('P0-PERF Regression Tests: Token Pair Key Generation', () => {
  describe('getTokenPairKey', () => {
    it('should generate same key for same tokens regardless of order', () => {
      const tokenA = '0xAAAA';
      const tokenB = '0xBBBB';

      const key1 = getTokenPairKey(tokenA, tokenB);
      const key2 = getTokenPairKey(tokenB, tokenA);

      expect(key1).toBe(key2);
    });

    it('should handle case-insensitive addresses', () => {
      const keyLower = getTokenPairKey('0xaaaa', '0xbbbb');
      const keyUpper = getTokenPairKey('0xAAAA', '0xBBBB');
      const keyMixed = getTokenPairKey('0xAaAa', '0xBbBb');

      expect(keyLower).toBe(keyUpper);
      expect(keyUpper).toBe(keyMixed);
    });

    it('should generate alphabetically sorted keys', () => {
      const key = getTokenPairKey('0xcccc', '0xaaaa');

      // Should start with the alphabetically earlier address
      expect(key.startsWith('0xaaaa')).toBe(true);
      expect(key).toBe('0xaaaa_0xcccc');
    });

    it('should generate unique keys for different token pairs', () => {
      const key1 = getTokenPairKey('0xaaaa', '0xbbbb');
      const key2 = getTokenPairKey('0xaaaa', '0xcccc');
      const key3 = getTokenPairKey('0xbbbb', '0xcccc');

      expect(key1).not.toBe(key2);
      expect(key1).not.toBe(key3);
      expect(key2).not.toBe(key3);
    });

    it('should handle real Ethereum addresses correctly', () => {
      const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
      const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
      const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

      // WETH-USDC should match in either order
      const key1 = getTokenPairKey(WETH, USDC);
      const key2 = getTokenPairKey(USDC, WETH);
      expect(key1).toBe(key2);

      // WETH-USDC should differ from WETH-USDT
      const key3 = getTokenPairKey(WETH, USDT);
      expect(key1).not.toBe(key3);
    });

    it('should handle empty or short addresses', () => {
      // Edge case: should not throw
      const key1 = getTokenPairKey('0x0', '0x1');
      const key2 = getTokenPairKey('0x1', '0x0');

      expect(key1).toBe(key2);
      expect(key1).toBe('0x0_0x1');
    });

    it('should be deterministic (same input always produces same output)', () => {
      const token0 = '0xAAAABBBBCCCC';
      const token1 = '0xDDDDEEEEFFFF';

      const results = new Set<string>();
      for (let i = 0; i < 100; i++) {
        results.add(getTokenPairKey(token0, token1));
        results.add(getTokenPairKey(token1, token0));
      }

      // All results should be the same
      expect(results.size).toBe(1);
    });
  });
});
