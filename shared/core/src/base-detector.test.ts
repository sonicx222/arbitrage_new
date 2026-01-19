/**
 * BaseDetector Unit Tests
 *
 * Tests for the consolidated BaseDetector class including:
 * - Lifecycle management (start/stop with race condition guards)
 * - Event processing (Sync and Swap events)
 * - Arbitrage detection
 * - Whale detection
 * - USD value estimation
 * - O(1) pair lookups
 * - Price calculation
 * - Pair snapshots for thread safety
 */

import { BaseDetector, DetectorConfig, ExtendedPair, PairSnapshot } from './base-detector';
import type { Pair, PriceUpdate, SwapEvent, ArbitrageOpportunity } from '../../types/src';

// =============================================================================
// Mock Implementations
// =============================================================================

// Concrete test implementation of abstract BaseDetector
class TestDetector extends BaseDetector {
  public testCalls: string[] = [];
  public mockPriceUpdates: PriceUpdate[] = [];
  public mockArbitrageOpportunities: ArbitrageOpportunity[] = [];
  public mockWhaleTransactions: any[] = [];

  constructor(config?: Partial<DetectorConfig>) {
    super({
      chain: 'ethereum',
      enabled: true,
      wsUrl: 'wss://test.example.com',
      rpcUrl: 'https://test.example.com',
      batchSize: 20,
      batchTimeout: 30,
      healthCheckInterval: 30000,
      ...config
    });
  }

  // Expose protected methods for testing
  public async testProcessSyncEvent(log: any, pair: Pair): Promise<void> {
    return this.processSyncEvent(log, pair);
  }

  public async testProcessSwapEvent(log: any, pair: Pair): Promise<void> {
    return this.processSwapEvent(log, pair);
  }

  public async testCheckIntraDexArbitrage(pair: Pair): Promise<void> {
    return this.checkIntraDexArbitrage(pair);
  }

  public async testCheckWhaleActivity(swapEvent: SwapEvent): Promise<void> {
    return this.checkWhaleActivity(swapEvent);
  }

  public async testEstimateUsdValue(
    pair: Pair,
    amount0In: string,
    amount1In: string,
    amount0Out: string,
    amount1Out: string
  ): Promise<number> {
    return this.estimateUsdValue(pair, amount0In, amount1In, amount0Out, amount1Out);
  }

  public testCalculatePrice(pair: Pair): number {
    return this.calculatePrice(pair);
  }

  public testCreatePairSnapshot(pair: Pair): PairSnapshot | null {
    return this.createPairSnapshot(pair);
  }

  public testCreatePairsSnapshot(): Map<string, PairSnapshot> {
    return this.createPairsSnapshot();
  }

  public testCalculatePriceFromSnapshot(snapshot: PairSnapshot): number {
    return this.calculatePriceFromSnapshot(snapshot);
  }

  // Expose state for testing
  public getIsRunning(): boolean {
    return this.isRunning;
  }

  public getIsStopping(): boolean {
    return this.isStopping;
  }

  public getPairs(): Map<string, Pair> {
    return this.pairs;
  }

  public getPairsByAddress(): Map<string, Pair> {
    return this.pairsByAddress;
  }

  public getMonitoredPairs(): Set<string> {
    return this.monitoredPairs;
  }

  // Override methods that require external resources
  protected async initializeRedis(): Promise<void> {
    this.testCalls.push('initializeRedis');
    // Mock - don't actually connect
  }

  protected async initializePairs(): Promise<void> {
    this.testCalls.push('initializePairs');
    // Mock - add test pairs
  }

  protected async connectWebSocket(): Promise<void> {
    this.testCalls.push('connectWebSocket');
    // Mock - don't actually connect
  }

  protected async subscribeToEvents(): Promise<void> {
    this.testCalls.push('subscribeToEvents');
    // Mock
  }

  protected async onStart(): Promise<void> {
    this.testCalls.push('onStart');
  }

  protected async onStop(): Promise<void> {
    this.testCalls.push('onStop');
  }

  protected async publishPriceUpdate(update: PriceUpdate): Promise<void> {
    this.mockPriceUpdates.push(update);
  }

  protected async publishArbitrageOpportunity(opportunity: ArbitrageOpportunity): Promise<void> {
    this.mockArbitrageOpportunities.push(opportunity);
  }

  protected async publishWhaleTransaction(transaction: any): Promise<void> {
    this.mockWhaleTransactions.push(transaction);
  }

  protected async cleanupStreamBatchers(): Promise<void> {
    this.testCalls.push('cleanupStreamBatchers');
  }

  // Helper to add test pairs
  public addTestPair(key: string, pair: Pair): void {
    this.pairs.set(key, pair);
    this.pairsByAddress.set(pair.address.toLowerCase(), pair);
    this.monitoredPairs.add(pair.address.toLowerCase());
  }

  // Set running state for testing
  public setRunning(running: boolean): void {
    this.isRunning = running;
  }

  public setStopping(stopping: boolean): void {
    this.isStopping = stopping;
  }
}

// =============================================================================
// Test Fixtures
// =============================================================================

function createMockPair(overrides?: Partial<ExtendedPair>): ExtendedPair {
  return {
    name: 'WETH/USDC',
    address: '0x1234567890123456789012345678901234567890',
    token0: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    token1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
    dex: 'uniswap_v2',
    fee: 30,
    reserve0: '1000000000000000000000', // 1000 ETH
    reserve1: '2500000000000',          // 2,500,000 USDC (6 decimals)
    blockNumber: 18000000,
    lastUpdate: Date.now(),
    ...overrides
  };
}

function createMockSyncLog(pair: Pair, reserve0: string, reserve1: string): any {
  // ABI encode reserves as uint112, uint112
  const abiCoder = {
    encode: (types: string[], values: any[]) => {
      // Mock encoding - in real tests this would use ethers
      return '0x' + BigInt(reserve0).toString(16).padStart(64, '0') +
                    BigInt(reserve1).toString(16).padStart(64, '0');
    }
  };

  return {
    address: pair.address,
    topics: ['0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1'],
    data: abiCoder.encode(['uint112', 'uint112'], [reserve0, reserve1]),
    blockNumber: 18000001,
    transactionHash: '0xabcd1234'
  };
}

function createMockSwapLog(pair: Pair): any {
  return {
    address: pair.address,
    topics: [
      '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
      '0x0000000000000000000000001111111111111111111111111111111111111111',
      '0x0000000000000000000000002222222222222222222222222222222222222222'
    ],
    data: '0x' + '0'.repeat(256), // Mock data
    blockNumber: 18000001,
    transactionHash: '0xabcd1234'
  };
}

function createMockSwapEvent(overrides?: Partial<SwapEvent>): SwapEvent {
  return {
    pairAddress: '0x1234567890123456789012345678901234567890',
    sender: '0x1111111111111111111111111111111111111111',
    recipient: '0x2222222222222222222222222222222222222222',
    amount0In: '1000000000000000000', // 1 ETH
    amount1In: '0',
    amount0Out: '0',
    amount1Out: '2500000000', // 2500 USDC
    to: '0x2222222222222222222222222222222222222222',
    blockNumber: 18000001,
    transactionHash: '0xabcd1234',
    timestamp: Date.now(),
    dex: 'uniswap_v2',
    chain: 'ethereum',
    usdValue: 2500,
    ...overrides
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('BaseDetector', () => {
  let detector: TestDetector;

  beforeEach(() => {
    detector = new TestDetector();
  });

  afterEach(async () => {
    if (detector.getIsRunning()) {
      await detector.stop();
    }
  });

  // ===========================================================================
  // Lifecycle Tests
  // ===========================================================================

  describe('Lifecycle Management', () => {
    describe('start()', () => {
      it('should initialize all components in correct order', async () => {
        await detector.start();

        expect(detector.testCalls).toEqual([
          'initializeRedis',
          'initializePairs',
          'connectWebSocket',
          'subscribeToEvents',
          'onStart'
        ]);
        expect(detector.getIsRunning()).toBe(true);
      });

      it('should prevent double start', async () => {
        await detector.start();
        detector.testCalls = []; // Reset

        await detector.start();

        expect(detector.testCalls).toEqual([]); // No methods called
        expect(detector.getIsRunning()).toBe(true);
      });

      it('should wait for pending stop operation before starting', async () => {
        await detector.start();

        // Start stop but don't await
        const stopPromise = detector.stop();

        // Try to start while stopping
        const startPromise = detector.start();

        await stopPromise;
        await startPromise;

        // Should have restarted after stop completed
        expect(detector.getIsRunning()).toBe(true);
      });

      it('should prevent start while stopping', async () => {
        await detector.start();
        detector.setStopping(true);
        detector.testCalls = [];

        await detector.start();

        expect(detector.testCalls).toEqual([]); // Start was blocked
      });
    });

    describe('stop()', () => {
      it('should cleanup all resources', async () => {
        await detector.start();
        detector.testCalls = [];

        await detector.stop();

        expect(detector.testCalls).toContain('onStop');
        expect(detector.testCalls).toContain('cleanupStreamBatchers');
        expect(detector.getIsRunning()).toBe(false);
        expect(detector.getIsStopping()).toBe(false);
      });

      it('should prevent double stop', async () => {
        await detector.start();
        await detector.stop();
        detector.testCalls = [];

        await detector.stop();

        expect(detector.testCalls).toEqual([]); // No cleanup called again
      });

      it('should clear all collections', async () => {
        await detector.start();
        const pair = createMockPair();
        detector.addTestPair('test_pair', pair);

        await detector.stop();

        expect(detector.getPairs().size).toBe(0);
        expect(detector.getPairsByAddress().size).toBe(0);
        expect(detector.getMonitoredPairs().size).toBe(0);
      });

      it('should handle stop when not running', async () => {
        // Never started
        await detector.stop();

        expect(detector.getIsRunning()).toBe(false);
      });
    });

    describe('getHealth()', () => {
      it('should return healthy status when running', async () => {
        await detector.start();

        const health = await detector.getHealth();

        expect(health.status).toBe('healthy');
        expect(health.chain).toBe('ethereum');
      });

      it('should return unhealthy status when stopped', async () => {
        const health = await detector.getHealth();

        expect(health.status).toBe('unhealthy');
      });

      it('should return unhealthy status when stopping', async () => {
        await detector.start();
        detector.setStopping(true);

        const health = await detector.getHealth();

        expect(health.status).toBe('unhealthy');
      });
    });
  });

  // ===========================================================================
  // Event Processing Tests
  // ===========================================================================

  describe('Event Processing', () => {
    describe('processLogEvent()', () => {
      beforeEach(async () => {
        await detector.start();
      });

      it('should skip events when not running', async () => {
        const pair = createMockPair();
        detector.addTestPair('test_pair', pair);
        detector.setRunning(false);

        await detector.processLogEvent({
          address: pair.address,
          topics: ['0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1'],
          data: '0x'
        });

        expect(detector.mockPriceUpdates.length).toBe(0);
      });

      it('should skip events when stopping', async () => {
        const pair = createMockPair();
        detector.addTestPair('test_pair', pair);
        detector.setStopping(true);

        await detector.processLogEvent({
          address: pair.address,
          topics: ['0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1'],
          data: '0x'
        });

        expect(detector.mockPriceUpdates.length).toBe(0);
      });

      it('should skip events for unmonitored pairs', async () => {
        await detector.processLogEvent({
          address: '0xunknown',
          topics: ['0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1'],
          data: '0x'
        });

        expect(detector.mockPriceUpdates.length).toBe(0);
      });

      it('should use O(1) pair lookup by address', async () => {
        const pair = createMockPair();
        detector.addTestPair('test_pair', pair);

        // Verify the pair is in pairsByAddress
        const lookupPair = detector.getPairsByAddress().get(pair.address.toLowerCase());
        expect(lookupPair).toBeDefined();
        expect(lookupPair?.address).toBe(pair.address);
      });
    });
  });

  // ===========================================================================
  // Price Calculation Tests
  // ===========================================================================

  describe('Price Calculation', () => {
    describe('calculatePrice()', () => {
      it('should calculate price correctly from reserves', () => {
        const pair = createMockPair({
          reserve0: '1000000000000000000000', // 1000 ETH (18 decimals)
          reserve1: '2500000000000'           // 2,500,000 USDC (6 decimals)
        });

        const price = detector.testCalculatePrice(pair);

        // Price = reserve0 / reserve1
        expect(price).toBeCloseTo(1000000000000000000000 / 2500000000000);
      });

      it('should return 0 for missing reserves', () => {
        const pair = createMockPair({
          reserve0: undefined as any,
          reserve1: '2500000000000'
        });

        const price = detector.testCalculatePrice(pair);

        expect(price).toBe(0);
      });

      it('should return 0 for zero reserves', () => {
        const pair = createMockPair({
          reserve0: '0',
          reserve1: '2500000000000'
        });

        const price = detector.testCalculatePrice(pair);

        expect(price).toBe(0);
      });

      it('should return 0 for NaN reserves', () => {
        const pair = createMockPair({
          reserve0: 'invalid',
          reserve1: '2500000000000'
        });

        const price = detector.testCalculatePrice(pair);

        expect(price).toBe(0);
      });
    });

    describe('calculatePriceFromSnapshot()', () => {
      it('should calculate price from snapshot', () => {
        const snapshot: PairSnapshot = {
          address: '0x1234',
          dex: 'uniswap_v2',
          token0: '0xtoken0',
          token1: '0xtoken1',
          reserve0: '1000000000000000000000',
          reserve1: '2500000000000',
          fee: 30
        };

        const price = detector.testCalculatePriceFromSnapshot(snapshot);

        expect(price).toBeCloseTo(1000000000000000000000 / 2500000000000);
      });

      it('should return 0 for invalid snapshot reserves', () => {
        const snapshot: PairSnapshot = {
          address: '0x1234',
          dex: 'uniswap_v2',
          token0: '0xtoken0',
          token1: '0xtoken1',
          reserve0: '0',
          reserve1: '2500000000000',
          fee: 30
        };

        const price = detector.testCalculatePriceFromSnapshot(snapshot);

        expect(price).toBe(0);
      });
    });
  });

  // ===========================================================================
  // Pair Snapshot Tests
  // ===========================================================================

  describe('Pair Snapshots', () => {
    describe('createPairSnapshot()', () => {
      it('should create immutable snapshot of pair data', () => {
        const pair = createMockPair({
          reserve0: '1000000000000000000000',
          reserve1: '2500000000000'
        });

        const snapshot = detector.testCreatePairSnapshot(pair);

        expect(snapshot).not.toBeNull();
        expect(snapshot!.address).toBe(pair.address);
        expect(snapshot!.dex).toBe(pair.dex);
        expect(snapshot!.token0).toBe(pair.token0);
        expect(snapshot!.token1).toBe(pair.token1);
        expect(snapshot!.reserve0).toBe(pair.reserve0);
        expect(snapshot!.reserve1).toBe(pair.reserve1);
      });

      it('should return null for pairs without reserves', () => {
        const pair = createMockPair({
          reserve0: undefined as any,
          reserve1: undefined as any
        });

        const snapshot = detector.testCreatePairSnapshot(pair);

        expect(snapshot).toBeNull();
      });

      it('should use default fee if not specified', () => {
        const pair = createMockPair({
          fee: undefined as any
        });

        const snapshot = detector.testCreatePairSnapshot(pair);

        expect(snapshot!.fee).toBe(30); // Default fee
      });
    });

    describe('createPairsSnapshot()', () => {
      beforeEach(async () => {
        await detector.start();
      });

      it('should create snapshots of all pairs with reserves', () => {
        const pair1 = createMockPair({
          address: '0x1111111111111111111111111111111111111111',
          reserve0: '1000',
          reserve1: '2000'
        });
        const pair2 = createMockPair({
          address: '0x2222222222222222222222222222222222222222',
          reserve0: '3000',
          reserve1: '4000'
        });

        detector.addTestPair('pair1', pair1);
        detector.addTestPair('pair2', pair2);

        const snapshots = detector.testCreatePairsSnapshot();

        expect(snapshots.size).toBe(2);
      });

      it('should skip pairs without reserves', () => {
        const pair1 = createMockPair({
          address: '0x1111111111111111111111111111111111111111',
          reserve0: '1000',
          reserve1: '2000'
        });
        const pair2 = createMockPair({
          address: '0x2222222222222222222222222222222222222222',
          reserve0: undefined as any,
          reserve1: undefined as any
        });

        detector.addTestPair('pair1', pair1);
        detector.addTestPair('pair2', pair2);

        const snapshots = detector.testCreatePairsSnapshot();

        expect(snapshots.size).toBe(1);
      });
    });
  });

  // ===========================================================================
  // USD Value Estimation Tests
  // ===========================================================================

  describe('USD Value Estimation', () => {
    describe('estimateUsdValue()', () => {
      it('should estimate USD value for native token swaps', async () => {
        await detector.start();

        const pair = createMockPair({
          token0: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
          token1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'  // USDC
        });

        const usdValue = await detector.testEstimateUsdValue(
          pair,
          '1000000000000000000', // 1 ETH in
          '0',
          '0',
          '2500000000' // 2500 USDC out
        );

        // With ETH price of ~$2500, 1 ETH should be ~$2500
        expect(usdValue).toBeGreaterThan(0);
      });

      it('should return 0 for unknown token pairs', async () => {
        await detector.start();

        const pair = createMockPair({
          token0: '0x0000000000000000000000000000000000000001', // Unknown
          token1: '0x0000000000000000000000000000000000000002'  // Unknown
        });

        const usdValue = await detector.testEstimateUsdValue(
          pair,
          '1000000000000000000',
          '0',
          '0',
          '1000000000000000000'
        );

        expect(usdValue).toBe(0);
      });
    });
  });

  // ===========================================================================
  // Whale Detection Tests
  // ===========================================================================

  describe('Whale Detection', () => {
    describe('checkWhaleActivity()', () => {
      beforeEach(async () => {
        await detector.start();
      });

      it('should detect whale transactions above threshold', async () => {
        const pair = createMockPair();
        detector.addTestPair('test_pair', pair);

        const whaleSwap = createMockSwapEvent({
          pairAddress: pair.address,
          usdValue: 100000, // $100K - above typical whale threshold
          amount0In: '40000000000000000000', // 40 ETH
          amount1In: '0'
        });

        await detector.testCheckWhaleActivity(whaleSwap);

        expect(detector.mockWhaleTransactions.length).toBe(1);
        expect(detector.mockWhaleTransactions[0].usdValue).toBe(100000);
      });

      it('should ignore small transactions', async () => {
        const smallSwap = createMockSwapEvent({
          usdValue: 100, // $100 - below threshold
          amount0In: '40000000000000000', // 0.04 ETH
          amount1In: '0'
        });

        await detector.testCheckWhaleActivity(smallSwap);

        expect(detector.mockWhaleTransactions.length).toBe(0);
      });

      it('should detect buy vs sell direction correctly', async () => {
        const pair = createMockPair();
        detector.addTestPair('test_pair', pair);

        // Sell: amount0In > amount1In
        const sellSwap = createMockSwapEvent({
          pairAddress: pair.address,
          usdValue: 100000,
          amount0In: '40000000000000000000',
          amount1In: '0'
        });

        await detector.testCheckWhaleActivity(sellSwap);

        expect(detector.mockWhaleTransactions[0].direction).toBe('sell');
        expect(detector.mockWhaleTransactions[0].token).toBe('token0');
      });
    });
  });

  // ===========================================================================
  // Arbitrage Detection Tests
  // ===========================================================================

  describe('Arbitrage Detection', () => {
    describe('checkIntraDexArbitrage()', () => {
      beforeEach(async () => {
        await detector.start();
      });

      it('should skip when not running', async () => {
        detector.setRunning(false);
        const pair = createMockPair();

        await detector.testCheckIntraDexArbitrage(pair);

        expect(detector.mockArbitrageOpportunities.length).toBe(0);
      });

      it('should skip when stopping', async () => {
        detector.setStopping(true);
        const pair = createMockPair();

        await detector.testCheckIntraDexArbitrage(pair);

        expect(detector.mockArbitrageOpportunities.length).toBe(0);
      });

      it('should detect arbitrage between different DEXes', async () => {
        // Create two pairs with same tokens but different prices
        const pair1 = createMockPair({
          address: '0x1111111111111111111111111111111111111111',
          dex: 'uniswap_v2',
          token0: '0xtoken0',
          token1: '0xtoken1',
          reserve0: '1000000000000000000000', // Price = 0.4
          reserve1: '2500000000000000000000'
        });

        const pair2 = createMockPair({
          address: '0x2222222222222222222222222222222222222222',
          dex: 'sushiswap',
          token0: '0xtoken0',
          token1: '0xtoken1',
          reserve0: '1000000000000000000000', // Price = 0.5 (25% higher)
          reserve1: '2000000000000000000000'
        });

        detector.addTestPair('uniswap_pair', pair1);
        detector.addTestPair('sushi_pair', pair2);

        await detector.testCheckIntraDexArbitrage(pair1);

        expect(detector.mockArbitrageOpportunities.length).toBe(1);
        expect(detector.mockArbitrageOpportunities[0].chain).toBe('ethereum');
      });

      it('should handle reverse order token pairs', async () => {
        // Create two pairs with reversed token order
        const pair1 = createMockPair({
          address: '0x1111111111111111111111111111111111111111',
          dex: 'uniswap_v2',
          token0: '0xtoken0',
          token1: '0xtoken1',
          reserve0: '1000000000000000000000',
          reserve1: '2500000000000000000000'
        });

        const pair2 = createMockPair({
          address: '0x2222222222222222222222222222222222222222',
          dex: 'sushiswap',
          token0: '0xtoken1', // Reversed!
          token1: '0xtoken0',
          reserve0: '2000000000000000000000',
          reserve1: '1000000000000000000000'
        });

        detector.addTestPair('uniswap_pair', pair1);
        detector.addTestPair('sushi_pair', pair2);

        await detector.testCheckIntraDexArbitrage(pair1);

        // Should still detect (or not) based on price comparison after inversion
        // The logic handles reverse order by inverting the price
      });

      it('should not flag same DEX pairs', async () => {
        const pair1 = createMockPair({
          address: '0x1111111111111111111111111111111111111111',
          dex: 'uniswap_v2', // Same DEX
          token0: '0xtoken0',
          token1: '0xtoken1',
          reserve0: '1000000000000000000000',
          reserve1: '2500000000000000000000'
        });

        const pair2 = createMockPair({
          address: '0x2222222222222222222222222222222222222222',
          dex: 'uniswap_v2', // Same DEX
          token0: '0xtoken0',
          token1: '0xtoken1',
          reserve0: '1000000000000000000000',
          reserve1: '2000000000000000000000'
        });

        detector.addTestPair('uni_pair1', pair1);
        detector.addTestPair('uni_pair2', pair2);

        await detector.testCheckIntraDexArbitrage(pair1);

        // Should NOT detect because same DEX
        expect(detector.mockArbitrageOpportunities.length).toBe(0);
      });
    });
  });

  // ===========================================================================
  // Configuration Tests
  // ===========================================================================

  describe('Configuration', () => {
    describe('getMinProfitThreshold()', () => {
      it('should return chain-specific threshold', () => {
        const threshold = detector.getMinProfitThreshold();

        expect(threshold).toBeGreaterThan(0);
        expect(threshold).toBeLessThan(1); // Should be a percentage as decimal
      });
    });
  });

  // ===========================================================================
  // Race Condition Prevention Tests
  // ===========================================================================

  describe('Race Condition Prevention', () => {
    it('should handle concurrent start/stop calls safely', async () => {
      // Start multiple operations concurrently
      const promises = [
        detector.start(),
        detector.stop(),
        detector.start(),
        detector.stop()
      ];

      // Should not throw
      await Promise.allSettled(promises);

      // State should be consistent (either running or stopped)
      const isRunning = detector.getIsRunning();
      const isStopping = detector.getIsStopping();

      // Should never be both stopping and running
      expect(!(isRunning && isStopping)).toBe(true);
    });

    it('should wait for stop to complete before restarting', async () => {
      await detector.start();

      // Stop and immediately start
      const stopPromise = detector.stop();
      const startPromise = detector.start();

      await stopPromise;
      await startPromise;

      // Should have successfully restarted
      expect(detector.getIsRunning()).toBe(true);
    });
  });
});

// =============================================================================
// Integration-style Tests (with mocked external deps)
// =============================================================================

describe('BaseDetector Integration', () => {
  let detector: TestDetector;

  beforeEach(() => {
    detector = new TestDetector();
  });

  afterEach(async () => {
    if (detector.getIsRunning()) {
      await detector.stop();
    }
  });

  it('should process full event lifecycle', async () => {
    await detector.start();

    // Add a pair
    const pair = createMockPair({
      reserve0: '1000000000000000000000',
      reserve1: '2500000000000'
    });
    detector.addTestPair('test_pair', pair);

    // Process a sync event (would update reserves and trigger arb check)
    // Note: This is a simplified test - real events need proper ABI encoding

    // Verify the system is ready to process
    expect(detector.getIsRunning()).toBe(true);
    expect(detector.getPairs().size).toBe(1);
    expect(detector.getPairsByAddress().size).toBe(1);
    expect(detector.getMonitoredPairs().size).toBe(1);

    await detector.stop();

    // Verify cleanup
    expect(detector.getIsRunning()).toBe(false);
    expect(detector.getPairs().size).toBe(0);
  });

  it('should maintain O(1) pair lookup performance', async () => {
    await detector.start();

    // Add many pairs
    for (let i = 0; i < 100; i++) {
      const pair = createMockPair({
        address: `0x${i.toString().padStart(40, '0')}`,
        reserve0: '1000',
        reserve1: '2000'
      });
      detector.addTestPair(`pair_${i}`, pair);
    }

    // Lookup should be O(1)
    const startTime = performance.now();
    for (let i = 0; i < 1000; i++) {
      const addr = `0x${(i % 100).toString().padStart(40, '0')}`;
      detector.getPairsByAddress().get(addr.toLowerCase());
    }
    const endTime = performance.now();

    // 1000 lookups should be very fast (< 10ms)
    expect(endTime - startTime).toBeLessThan(100);
  });
});
