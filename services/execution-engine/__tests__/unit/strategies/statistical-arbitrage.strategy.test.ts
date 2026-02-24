/**
 * StatisticalArbitrageStrategy Tests
 *
 * Tests for the statistical arbitrage execution strategy.
 * Validates pre-execution checks and delegation to flash loan infrastructure.
 */

import type { ArbitrageOpportunity } from '@arbitrage/types';
import { StatisticalArbitrageStrategy } from '../../../src/strategies/statistical-arbitrage.strategy';

// =============================================================================
// Mocks
// =============================================================================

// Must mock before imports that use these
jest.mock('@arbitrage/config', () => ({
  ARBITRAGE_CONFIG: { slippageTolerance: 0.005 },
  FLASH_LOAN_PROVIDERS: {},
  DEXES: {},
  MEV_CONFIG: {},
  isExecutionSupported: jest.fn().mockReturnValue(true),
  getSupportedExecutionChains: jest.fn().mockReturnValue(['ethereum']),
  getNativeTokenPrice: jest.fn().mockReturnValue(2000),
  CHAINS: {},
}));

jest.mock('@arbitrage/core', () => ({
  getErrorMessage: jest.fn((e: unknown) => e instanceof Error ? e.message : String(e)),
  createPinoLogger: jest.fn(() => createMockLogger()),
}));

function createMockLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockReturnThis(),
  } as any;
}

function createMockContext(overrides?: any) {
  return {
    logger: createMockLogger(),
    perfLogger: { startTimer: jest.fn(), endTimer: jest.fn() } as any,
    providers: new Map(),
    wallets: new Map(),
    providerHealth: new Map(),
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

function createTestOpportunity(overrides?: Partial<ArbitrageOpportunity>): ArbitrageOpportunity {
  return {
    id: 'stat-arb-test-1',
    type: 'statistical',
    chain: 'ethereum',
    tokenIn: '0xDAI',
    tokenOut: '0xWETH',
    confidence: 0.8,
    expectedProfit: 50,
    timestamp: Date.now(),
    ...overrides,
  };
}

function createMockFlashLoanStrategy() {
  return {
    execute: jest.fn().mockResolvedValue({
      opportunityId: 'stat-arb-test-1',
      success: true,
      transactionHash: '0xabc123',
      timestamp: Date.now(),
      chain: 'ethereum',
      dex: 'uniswap-v3',
    }),
  };
}

describe('StatisticalArbitrageStrategy', () => {
  let strategy: StatisticalArbitrageStrategy;
  let mockFlashLoan: ReturnType<typeof createMockFlashLoanStrategy>;
  let ctx: any;

  beforeEach(() => {
    mockFlashLoan = createMockFlashLoanStrategy();
    strategy = new StatisticalArbitrageStrategy(
      createMockLogger(),
      {
        minConfidence: 0.5,
        maxOpportunityAgeMs: 30_000,
        minExpectedProfitUsd: 10,
      },
      mockFlashLoan,
    );
    ctx = createMockContext();
  });

  // ===========================================================================
  // Successful Execution
  // ===========================================================================

  describe('successful execution', () => {
    it('should delegate to flash loan strategy with useFlashLoan=true', async () => {
      const opp = createTestOpportunity();
      const result = await strategy.execute(opp, ctx);

      expect(result.success).toBe(true);
      expect(mockFlashLoan.execute).toHaveBeenCalledWith(
        expect.objectContaining({ useFlashLoan: true }),
        ctx,
      );
    });

    it('should pass the opportunity through to flash loan', async () => {
      const opp = createTestOpportunity({
        tokenIn: '0xUSDC',
        tokenOut: '0xWBTC',
      });
      await strategy.execute(opp, ctx);

      const calledOpp = mockFlashLoan.execute.mock.calls[0][0];
      expect(calledOpp.tokenIn).toBe('0xUSDC');
      expect(calledOpp.tokenOut).toBe('0xWBTC');
      expect(calledOpp.type).toBe('statistical');
    });
  });

  // ===========================================================================
  // Stale Opportunity Rejection
  // ===========================================================================

  describe('stale opportunity rejection', () => {
    it('should skip opportunities that are too old', async () => {
      const opp = createTestOpportunity({
        timestamp: Date.now() - 60_000, // 60 seconds ago
      });

      const result = await strategy.execute(opp, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('ERR_STALE');
      expect(mockFlashLoan.execute).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Low Confidence Rejection
  // ===========================================================================

  describe('low confidence rejection', () => {
    it('should skip opportunities with confidence below threshold', async () => {
      const opp = createTestOpportunity({
        confidence: 0.3,
      });

      const result = await strategy.execute(opp, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('ERR_LOW_CONFIDENCE');
      expect(mockFlashLoan.execute).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Low Profit Rejection
  // ===========================================================================

  describe('low profit rejection', () => {
    it('should skip opportunities with profit below threshold', async () => {
      const opp = createTestOpportunity({
        expectedProfit: 5, // below $10 threshold
      });

      const result = await strategy.execute(opp, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('ERR_LOW_PROFIT');
      expect(mockFlashLoan.execute).not.toHaveBeenCalled();
    });

    it('should skip when expectedProfit is missing (defaults to 0)', async () => {
      const opp = createTestOpportunity({
        expectedProfit: undefined,
      });

      const result = await strategy.execute(opp, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('ERR_LOW_PROFIT');
    });
  });

  // ===========================================================================
  // Missing Token Fields
  // ===========================================================================

  describe('missing token fields', () => {
    it('should reject opportunity without tokenIn', async () => {
      const opp = createTestOpportunity({
        tokenIn: undefined,
      });

      const result = await strategy.execute(opp, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('ERR_INVALID_OPPORTUNITY');
    });

    it('should reject opportunity without tokenOut', async () => {
      const opp = createTestOpportunity({
        tokenOut: undefined,
      });

      const result = await strategy.execute(opp, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('ERR_INVALID_OPPORTUNITY');
    });
  });

  // ===========================================================================
  // Flash Loan Strategy Failure
  // ===========================================================================

  describe('flash loan strategy failure', () => {
    it('should catch and return error when flash loan strategy throws', async () => {
      mockFlashLoan.execute.mockRejectedValue(new Error('Flash loan reverted'));

      const opp = createTestOpportunity();
      const result = await strategy.execute(opp, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('ERR_FLASH_LOAN_FAILED');
      expect(result.error).toContain('Flash loan reverted');
    });
  });

  // ===========================================================================
  // No Flash Loan Strategy Available
  // ===========================================================================

  describe('no flash loan strategy', () => {
    it('should return simulated result when no flash loan strategy is wired', async () => {
      const strategyNoFlash = new StatisticalArbitrageStrategy(
        createMockLogger(),
        { minConfidence: 0.5, maxOpportunityAgeMs: 30_000, minExpectedProfitUsd: 10 },
      );

      const opp = createTestOpportunity();
      const result = await strategyNoFlash.execute(opp, ctx);

      // Returns a "success" with zero hash as placeholder
      expect(result.success).toBe(true);
      expect(result.transactionHash).toContain('0x00000');
    });
  });

  // ===========================================================================
  // Default Config
  // ===========================================================================

  describe('default configuration', () => {
    it('should use defaults when no config is provided', async () => {
      const strategyDefaults = new StatisticalArbitrageStrategy(
        createMockLogger(),
        undefined,
        mockFlashLoan,
      );

      const opp = createTestOpportunity({ confidence: 0.6, expectedProfit: 15 });
      const result = await strategyDefaults.execute(opp, ctx);

      expect(result.success).toBe(true);
    });
  });
});
