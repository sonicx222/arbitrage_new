/**
 * Tests for UniswapX Filler Strategy
 *
 * @see Phase 2 Item #22: UniswapX filler integration
 */

import { ethers } from 'ethers';
import {
  UniswapXFillerStrategy,
  createUniswapXFillerStrategy,
} from '../../../src/strategies/uniswapx-filler.strategy';
import type { UniswapXOrder } from '../../../src/strategies/uniswapx-filler.strategy';

// =============================================================================
// Mocks
// =============================================================================

function createMockLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockReturnThis(),
  } as any;
}

function createMockProvider() {
  return {
    getNetwork: jest.fn().mockResolvedValue({ chainId: 1n }),
    getBlockNumber: jest.fn().mockResolvedValue(18000000),
    getFeeData: jest.fn().mockResolvedValue({
      gasPrice: ethers.parseUnits('20', 'gwei'),
      maxFeePerGas: ethers.parseUnits('30', 'gwei'),
      maxPriorityFeePerGas: ethers.parseUnits('2', 'gwei'),
    }),
    estimateGas: jest.fn().mockResolvedValue(200000n),
    getTransactionReceipt: jest.fn().mockResolvedValue(null),
  } as any;
}

function createMockWallet() {
  const wallet = ethers.Wallet.createRandom();
  return wallet;
}

function createMockContext(overrides?: any) {
  const provider = createMockProvider();
  const wallet = createMockWallet();

  return {
    logger: createMockLogger(),
    perfLogger: { startTimer: jest.fn(), endTimer: jest.fn() } as any,
    providers: new Map([['ethereum', provider]]),
    wallets: new Map([['ethereum', wallet as any]]),
    providerHealth: new Map([['ethereum', { healthy: true, lastCheck: Date.now(), consecutiveFailures: 0 }]]),
    nonceManager: null,
    mevProviderFactory: null,
    bridgeRouterFactory: null,
    stateManager: { getState: jest.fn() } as any,
    gasBaselines: new Map(),
    lastGasPrices: new Map(),
    stats: {
      providerHealthCheckFailures: 0,
      simulationsPerformed: 0,
      simulationsSkipped: 0,
      simulationErrors: 0,
    },
    ...overrides,
  } as any;
}

function createTestOrder(overrides?: Partial<UniswapXOrder>): UniswapXOrder {
  const now = Math.floor(Date.now() / 1000);
  return {
    encodedOrder: '0x' + 'ab'.repeat(100),
    signature: '0x' + 'cd'.repeat(65),
    chainId: 1,
    reactorAddress: '0x6000da47483062A0D734Ba3dc7576Ce6A0B645C4',
    inputToken: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    inputAmount: ethers.parseEther('10').toString(),
    outputToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
    outputStartAmount: ethers.parseUnits('20000', 6).toString(), // 20,000 USDC
    outputEndAmount: ethers.parseUnits('19500', 6).toString(),   // 19,500 USDC
    decayStartTime: now - 10,
    decayEndTime: now + 290, // 5 min decay
    nonce: '1',
    deadline: now + 600, // 10 min deadline
    swapper: '0x' + 'ab'.repeat(20),
    orderHash: '0x' + 'ef'.repeat(32),
    ...overrides,
  };
}

function createTestOpportunity(order?: UniswapXOrder, overrides?: any) {
  const testOrder = order ?? createTestOrder();
  return {
    id: 'test-opp-1',
    type: 'simple' as const,
    chain: 'ethereum',
    tokenIn: testOrder.inputToken,
    tokenOut: testOrder.outputToken,
    amountIn: testOrder.inputAmount,
    expectedProfit: 50,
    confidence: 0.9,
    timestamp: Date.now(),
    buyDex: 'uniswap_v3',
    sellDex: 'uniswap_v3',
    uniswapxOrder: testOrder,
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('UniswapXFillerStrategy', () => {
  let strategy: UniswapXFillerStrategy;

  beforeEach(() => {
    strategy = new UniswapXFillerStrategy(createMockLogger());
  });

  describe('constructor', () => {
    it('should create instance with default config', () => {
      const s = createUniswapXFillerStrategy(createMockLogger());
      expect(s).toBeInstanceOf(UniswapXFillerStrategy);
    });

    it('should accept custom config', () => {
      const s = new UniswapXFillerStrategy(createMockLogger(), {
        minProfitUsd: 5.0,
        maxGasPriceGwei: 100,
        useFlashLoan: true,
      });
      expect(s).toBeInstanceOf(UniswapXFillerStrategy);
    });
  });

  describe('calculateCurrentOutputAmount', () => {
    it('should return startAmount before decay starts', () => {
      const order = createTestOrder({
        outputStartAmount: '20000000000', // 20,000 USDC (6 decimals)
        outputEndAmount: '19500000000',   // 19,500 USDC
        decayStartTime: 1000,
        decayEndTime: 2000,
      });

      const result = strategy.calculateCurrentOutputAmount(order, 500); // before start
      expect(result).toBe(BigInt('20000000000'));
    });

    it('should return endAmount after decay ends', () => {
      const order = createTestOrder({
        outputStartAmount: '20000000000',
        outputEndAmount: '19500000000',
        decayStartTime: 1000,
        decayEndTime: 2000,
      });

      const result = strategy.calculateCurrentOutputAmount(order, 2500); // after end
      expect(result).toBe(BigInt('19500000000'));
    });

    it('should return midpoint at halfway through decay', () => {
      const order = createTestOrder({
        outputStartAmount: '20000000000',
        outputEndAmount: '19000000000',
        decayStartTime: 1000,
        decayEndTime: 2000,
      });

      const result = strategy.calculateCurrentOutputAmount(order, 1500); // midpoint
      // midpoint = 20000 - (20000 - 19000) * 500 / 1000 = 19500
      expect(result).toBe(BigInt('19500000000'));
    });

    it('should handle decay at exact start time', () => {
      const order = createTestOrder({
        outputStartAmount: '20000000000',
        outputEndAmount: '19500000000',
        decayStartTime: 1000,
        decayEndTime: 2000,
      });

      const result = strategy.calculateCurrentOutputAmount(order, 1000);
      expect(result).toBe(BigInt('20000000000'));
    });

    it('should handle decay at exact end time', () => {
      const order = createTestOrder({
        outputStartAmount: '20000000000',
        outputEndAmount: '19500000000',
        decayStartTime: 1000,
        decayEndTime: 2000,
      });

      const result = strategy.calculateCurrentOutputAmount(order, 2000);
      expect(result).toBe(BigInt('19500000000'));
    });

    it('should handle equal start and end amounts (no decay)', () => {
      const order = createTestOrder({
        outputStartAmount: '20000000000',
        outputEndAmount: '20000000000',
        decayStartTime: 1000,
        decayEndTime: 2000,
      });

      const result = strategy.calculateCurrentOutputAmount(order, 1500);
      expect(result).toBe(BigInt('20000000000'));
    });
  });

  describe('execute', () => {
    it('should fail when no UniswapX order data is present', async () => {
      const ctx = createMockContext();
      const opportunity = {
        id: 'test-1',
        chain: 'ethereum',
        confidence: 0.9,
        timestamp: Date.now(),
      };

      const result = await strategy.execute(opportunity as any, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('No UniswapX order data');
    });

    it('should fail when order has expired', async () => {
      const ctx = createMockContext();
      const order = createTestOrder({
        deadline: Math.floor(Date.now() / 1000) - 100, // expired
      });
      const opportunity = createTestOpportunity(order);

      const result = await strategy.execute(opportunity as any, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('expired');
    });

    it('should fail when profit is below minimum', async () => {
      const ctx = createMockContext();
      const opportunity = createTestOpportunity(undefined, {
        expectedProfit: 0.001, // below default 1.0
      });

      const result = await strategy.execute(opportunity as any, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('below minimum');
    });

    it('should skip when in exclusivity window for another filler', async () => {
      const ctx = createMockContext();
      const now = Math.floor(Date.now() / 1000);
      const order = createTestOrder({
        exclusiveFiller: '0x' + '11'.repeat(20), // someone else
        decayStartTime: now + 100, // exclusivity hasn't expired
        decayEndTime: now + 400,
        deadline: now + 600,
      });
      const opportunity = createTestOpportunity(order);

      const result = await strategy.execute(opportunity as any, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('exclusivity window');
    });

    it('should include dex field in result', async () => {
      const ctx = createMockContext();
      const opportunity = createTestOpportunity(undefined, {
        expectedProfit: 0.001, // will fail but we check result format
      });

      const result = await strategy.execute(opportunity as any, ctx);

      expect(result.dex).toBe('uniswapx');
    });

    it('should include chain field in result', async () => {
      const ctx = createMockContext();
      const opportunity = {
        id: 'test-1',
        chain: 'ethereum',
        confidence: 0.9,
        timestamp: Date.now(),
      };

      const result = await strategy.execute(opportunity as any, ctx);

      expect(result.chain).toBe('ethereum');
    });
  });

  describe('getFillerMetrics', () => {
    it('should return initial zero metrics', () => {
      const metrics = strategy.getFillerMetrics();
      expect(metrics.fillsAttempted).toBe(0);
      expect(metrics.fillsSucceeded).toBe(0);
      expect(metrics.fillsFailed).toBe(0);
      expect(metrics.fillsSkipped).toBe(0);
      expect(metrics.totalProfitUsd).toBe(0);
    });

    it('should track skipped fills', async () => {
      const ctx = createMockContext();
      const opportunity = createTestOpportunity(undefined, {
        expectedProfit: 0.001, // below minimum
      });

      await strategy.execute(opportunity as any, ctx);

      const metrics = strategy.getFillerMetrics();
      expect(metrics.fillsSkipped).toBe(1);
    });

    it('should return a copy (not reference)', () => {
      const m1 = strategy.getFillerMetrics();
      const m2 = strategy.getFillerMetrics();
      expect(m1).not.toBe(m2);
      expect(m1).toEqual(m2);
    });
  });

  describe('Fix #14: happy-path execution past guards', () => {
    it('should pass all validation guards with a valid order and context', async () => {
      const ctx = createMockContext();
      const order = createTestOrder();
      const opportunity = createTestOpportunity(order, {
        expectedProfit: 50,
      });

      const result = await strategy.execute(opportunity as any, ctx);

      // The strategy passes all guards (chain, provider, wallet, order present,
      // not expired, not exclusive, profit above min, gas below max).
      // It then hits the reactor whitelist check (Fix #11).
      expect(result.chain).toBe('ethereum');
      expect(result.dex).toBe('uniswapx');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);

      // Metrics: should count as attempted
      const metrics = strategy.getFillerMetrics();
      expect(metrics.fillsAttempted).toBe(1);
    });

    it('should reject unknown reactor addresses (Fix #11)', async () => {
      const ctx = createMockContext();
      const order = createTestOrder({
        reactorAddress: '0x0000000000000000000000000000000000000BAD',
      });
      const opportunity = createTestOpportunity(order);

      const result = await strategy.execute(opportunity as any, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown reactor address');
      expect(result.error).toContain('not in whitelist');
    });

    it('should accept known reactor address and attempt fill', async () => {
      const ctx = createMockContext();
      const order = createTestOrder({
        // Use a known reactor address from the whitelist
        reactorAddress: '0x6000da47483062A0D734Ba3dc7576Ce6A0B645C4',
      });
      const opportunity = createTestOpportunity(order);

      const result = await strategy.execute(opportunity as any, ctx);

      // Should pass reactor whitelist, then fail on contract interaction
      // (since we don't have a real contract in unit test).
      // The important thing is it passed all guards.
      if (!result.success) {
        expect(result.error).not.toContain('No UniswapX order data');
        expect(result.error).not.toContain('expired');
        expect(result.error).not.toContain('below minimum');
        expect(result.error).not.toContain('exclusivity window');
        expect(result.error).not.toContain('Unknown reactor address');
      }

      const metrics = strategy.getFillerMetrics();
      expect(metrics.fillsAttempted).toBe(1);
      expect(metrics.fillsSkipped).toBe(0);
    });

    it('should include traceId in log context (Fix #42)', async () => {
      const mockLogger = createMockLogger();
      const traceStrategy = new UniswapXFillerStrategy(mockLogger);
      const ctx = createMockContext();
      const opportunity = createTestOpportunity();

      await traceStrategy.execute(opportunity as any, ctx);

      // Fix #64: "evaluating" log was moved from info to debug level
      const debugCalls = mockLogger.debug.mock.calls;
      const evalLog = debugCalls.find((c: any[]) =>
        typeof c[0] === 'string' && c[0].includes('evaluating')
      );
      expect(evalLog).toBeDefined();
      if (evalLog) {
        expect(evalLog[1].traceId).toBeDefined();
      }
    });

    it('should complete full happy-path execution in hybrid mode', async () => {
      const originalEnv = process.env.EXECUTION_HYBRID_MODE;
      const originalRandom = Math.random;

      try {
        process.env.EXECUTION_HYBRID_MODE = 'true';
        Math.random = () => 0; // Always below default 0.95 success rate threshold

        const provider = createMockProvider();
        const wallet = createMockWallet();
        const ctx = createMockContext({
          providers: new Map([['ethereum', provider]]),
          wallets: new Map([['ethereum', wallet as any]]),
        });

        const order = createTestOrder({
          // Use a known whitelisted reactor address
          reactorAddress: '0x6000da47483062A0D734Ba3dc7576Ce6A0B645C4',
        });
        const opportunity = createTestOpportunity(order, {
          expectedProfit: 50,
        });

        const result = await strategy.execute(opportunity as any, ctx);

        expect(result.success).toBe(true);
        expect(result.transactionHash).toBeDefined();
        expect(result.chain).toBe('ethereum');
        expect(result.dex).toBe('uniswapx');
        expect(result.actualProfit).toBeDefined();

        const metrics = strategy.getFillerMetrics();
        expect(metrics.fillsSucceeded).toBe(1);
        expect(metrics.fillsSkipped).toBe(0);
        // Fix #15 + FIX 6 + Fix #10: totalProfitUsd deducts gas cost converted to USD.
        // Gas: 150000 gasUsed * 30 gwei maxFeePerGas = 0.0045 ETH
        // getNativeTokenPrice('ethereum') = $3200 (from @arbitrage/config)
        // Gas USD: 0.0045 * $3200 = $14.4
        // Profit: $50 - $14.4 = $35.6
        expect(metrics.totalProfitUsd).toBeCloseTo(35.6, 0);
      } finally {
        process.env.EXECUTION_HYBRID_MODE = originalEnv;
        Math.random = originalRandom;
      }
    }, 10000);
  });
});
