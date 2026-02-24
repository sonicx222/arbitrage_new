/**
 * Tests for Backrunning Strategy
 *
 * @see Phase 2 Item #26: Backrunning strategy
 */

import { ethers } from 'ethers';
import {
  BackrunStrategy,
  createBackrunStrategy,
} from '../../../src/strategies/backrun.strategy';
import type { BackrunTarget } from '../../../src/strategies/backrun.strategy';

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
  return ethers.Wallet.createRandom();
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

function createTestBackrunTarget(overrides?: Partial<BackrunTarget>): BackrunTarget {
  return {
    txHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    routerAddress: '0x7a250d5630b4cf539739df2c5dacb4c659f2488d',
    swapDirection: 'sell',
    source: 'mev-share',
    estimatedSwapSize: ethers.parseEther('100').toString(),
    ...overrides,
  };
}

function createTestOpportunity(target?: BackrunTarget, overrides?: any) {
  return {
    id: 'backrun-opp-1',
    type: 'simple' as const,
    chain: 'ethereum',
    tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
    amountIn: ethers.parseEther('1').toString(),
    expectedProfit: 5.0,
    confidence: 0.85,
    timestamp: Date.now(),
    buyDex: 'uniswap_v2',
    sellDex: 'sushiswap',
    backrunTarget: target ?? createTestBackrunTarget(),
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('BackrunStrategy', () => {
  let strategy: BackrunStrategy;

  beforeEach(() => {
    strategy = new BackrunStrategy(createMockLogger());
  });

  describe('constructor', () => {
    it('should create instance with default config', () => {
      const s = createBackrunStrategy(createMockLogger());
      expect(s).toBeInstanceOf(BackrunStrategy);
    });

    it('should accept custom config', () => {
      const s = new BackrunStrategy(createMockLogger(), {
        minProfitUsd: 2.0,
        maxGasPriceGwei: 50,
        maxOpportunityAgeMs: 1000,
        slippageBps: 200,
        useMevShareBundles: false,
        mevShareRefundPercent: 80,
      });
      expect(s).toBeInstanceOf(BackrunStrategy);
    });
  });

  describe('execute', () => {
    it('should fail when no backrun target data is present', async () => {
      const ctx = createMockContext();
      const opportunity = {
        id: 'test-1',
        chain: 'ethereum',
        confidence: 0.9,
        timestamp: Date.now(),
      };

      const result = await strategy.execute(opportunity as any, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('No backrun target data');
    });

    it('should fail when opportunity is too old', async () => {
      const ctx = createMockContext();
      const opportunity = createTestOpportunity(undefined, {
        timestamp: Date.now() - 5000, // 5 seconds old, default max is 2000ms
      });

      const result = await strategy.execute(opportunity as any, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('too old');
    });

    it('should fail when profit is below minimum', async () => {
      const ctx = createMockContext();
      const opportunity = createTestOpportunity(undefined, {
        expectedProfit: 0.01, // below default 0.50
      });

      const result = await strategy.execute(opportunity as any, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('below min');
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

    it('should include dex field in result', async () => {
      const ctx = createMockContext();
      const opportunity = createTestOpportunity(undefined, {
        expectedProfit: 0.01, // will fail
      });

      const result = await strategy.execute(opportunity as any, ctx);
      expect(result.dex).toBeDefined();
    });

    it('should fail when no provider for chain', async () => {
      const ctx = createMockContext({
        providers: new Map(), // empty
      });
      const opportunity = createTestOpportunity();

      const result = await strategy.execute(opportunity as any, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('No provider');
    });

    it('should fail when no wallet for chain', async () => {
      const ctx = createMockContext({
        wallets: new Map(), // empty
      });
      const opportunity = createTestOpportunity();

      const result = await strategy.execute(opportunity as any, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('No wallet');
    });
  });

  describe('getBackrunMetrics', () => {
    it('should return initial zero metrics', () => {
      const metrics = strategy.getBackrunMetrics();
      expect(metrics.backrunsAttempted).toBe(0);
      expect(metrics.backrunsSucceeded).toBe(0);
      expect(metrics.backrunsFailed).toBe(0);
      expect(metrics.backrunsSkipped).toBe(0);
      expect(metrics.totalProfitUsd).toBe(0);
    });

    it('should track skipped backruns', async () => {
      const ctx = createMockContext();
      const opportunity = createTestOpportunity(undefined, {
        expectedProfit: 0.01, // below minimum
      });

      await strategy.execute(opportunity as any, ctx);

      const metrics = strategy.getBackrunMetrics();
      expect(metrics.backrunsSkipped).toBe(1);
    });

    it('should track attempted backruns', async () => {
      const ctx = createMockContext();
      const opportunity = createTestOpportunity(undefined, {
        timestamp: Date.now() - 5000, // too old — still counts as attempted
      });

      await strategy.execute(opportunity as any, ctx);

      const metrics = strategy.getBackrunMetrics();
      expect(metrics.backrunsAttempted).toBe(1);
    });

    it('should return a copy (not reference)', () => {
      const m1 = strategy.getBackrunMetrics();
      const m2 = strategy.getBackrunMetrics();
      expect(m1).not.toBe(m2);
      expect(m1).toEqual(m2);
    });
  });

  describe('with custom age limit', () => {
    it('should accept opportunities within custom age limit', async () => {
      const customStrategy = new BackrunStrategy(createMockLogger(), {
        maxOpportunityAgeMs: 10000, // 10 seconds
      });

      const ctx = createMockContext();
      const opportunity = createTestOpportunity(undefined, {
        timestamp: Date.now() - 5000, // 5 seconds old
        expectedProfit: 5.0,
      });

      // Won't fail on age (might fail on other things like gas, but won't be "too old")
      const result = await customStrategy.execute(opportunity as any, ctx);
      if (!result.success) {
        expect(result.error).not.toContain('too old');
      }
    });
  });

  describe('Fix #14: happy-path execution past guards', () => {
    it('should pass all validation guards with a fresh, profitable opportunity', async () => {
      const ctx = createMockContext();
      const opportunity = createTestOpportunity(createTestBackrunTarget(), {
        expectedProfit: 5.0,
        timestamp: Date.now(), // fresh
      });

      const result = await strategy.execute(opportunity as any, ctx);

      // The strategy passes all guards (chain, provider, wallet, target, age, profit, gas).
      // It will attempt to build the backrun transaction, which will fail because
      // the mock provider doesn't have real router contracts. But the error should NOT
      // be from any guard, proving we reached the execution phase.
      expect(result.chain).toBe('ethereum');
      expect(result.dex).toBeDefined();
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.timestamp).toBeGreaterThan(0);

      if (!result.success) {
        // Should not fail on guards
        expect(result.error).not.toContain('No backrun target');
        expect(result.error).not.toContain('too old');
        expect(result.error).not.toContain('below min');
        expect(result.error).not.toContain('No provider');
        expect(result.error).not.toContain('No wallet');
        expect(result.error).not.toContain('exceeds max');
      }

      // Metrics: should count as attempted (not skipped)
      const metrics = strategy.getBackrunMetrics();
      expect(metrics.backrunsAttempted).toBe(1);
      expect(metrics.backrunsSkipped).toBe(0);
    });

    it('should reject backrun on non-Ethereum chains', async () => {
      const ctx = createMockContext({
        providers: new Map([['arbitrum', createMockProvider()]]),
        wallets: new Map([['arbitrum', createMockWallet() as any]]),
        providerHealth: new Map([['arbitrum', { healthy: true, lastCheck: Date.now(), consecutiveFailures: 0 }]]),
      });
      const opportunity = createTestOpportunity(createTestBackrunTarget(), {
        chain: 'arbitrum',
      });

      const result = await strategy.execute(opportunity as any, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('only supported on Ethereum');
    });

    it('should include traceId in log context (Fix #42)', async () => {
      const mockLogger = createMockLogger();
      const traceStrategy = new BackrunStrategy(mockLogger);
      const ctx = createMockContext();

      const traceId = 'abc123def456abc123def456abc12345';
      const opportunity = createTestOpportunity(
        createTestBackrunTarget({ traceId }),
      );

      await traceStrategy.execute(opportunity as any, ctx);

      // Fix #64: Evaluation log was downgraded to debug level
      const debugCalls = mockLogger.debug.mock.calls;
      const evalLog = debugCalls.find((c: any[]) =>
        typeof c[0] === 'string' && c[0].includes('evaluating')
      );
      expect(evalLog).toBeDefined();
      if (evalLog) {
        expect(evalLog[1].traceId).toBe(traceId);
      }
    });

    it('should complete full happy-path execution in hybrid mode', async () => {
      const originalEnv = process.env.EXECUTION_HYBRID_MODE;
      const originalRandom = Math.random;

      try {
        process.env.EXECUTION_HYBRID_MODE = 'true';
        Math.random = () => 0; // Always below default 0.95 success rate threshold

        const provider = createMockProvider();

        // Mock provider.call for routerContract.getAmountsOut(amountIn, path)
        const routerIface = new ethers.Interface([
          'function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)',
        ]);
        const amountIn = ethers.parseEther('1');
        const expectedOut = ethers.parseUnits('2000', 6); // 2000 USDC
        provider.call = jest.fn().mockResolvedValue(
          routerIface.encodeFunctionResult('getAmountsOut', [[amountIn, expectedOut]])
        );

        const wallet = createMockWallet();
        const ctx = createMockContext({
          providers: new Map([['ethereum', provider]]),
          wallets: new Map([['ethereum', wallet as any]]),
        });

        // Set buyDex/sellDex to undefined so dexLookup is bypassed
        // and target.routerAddress is used directly
        const opportunity = createTestOpportunity(createTestBackrunTarget(), {
          buyDex: undefined,
          sellDex: undefined,
          expectedProfit: 5.0,
          timestamp: Date.now(),
        });

        const result = await strategy.execute(opportunity as any, ctx);

        expect(result.success).toBe(true);
        expect(result.transactionHash).toBeDefined();
        expect(result.chain).toBe('ethereum');

        // Verify MEV-Share profit deduction: searcher retains 90%
        // actualProfit = expectedProfit * 0.9 - gasCost
        expect(result.actualProfit).toBeDefined();
        expect(result.actualProfit!).toBeLessThanOrEqual(4.5); // 5.0 * 0.9

        const metrics = strategy.getBackrunMetrics();
        expect(metrics.backrunsSucceeded).toBe(1);
        expect(metrics.backrunsSkipped).toBe(0);
        // totalProfitUsd = expectedProfit * mevShareRefundPercent/100 = 5.0 * 0.9
        expect(metrics.totalProfitUsd).toBe(4.5);
      } finally {
        process.env.EXECUTION_HYBRID_MODE = originalEnv;
        Math.random = originalRandom;
      }
    }, 10000);
  });
});
