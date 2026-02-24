/**
 * Tests for SolanaExecutionStrategy
 *
 * @see Phase 3 #29: Solana Execution with Jito Bundles
 */

import type { ArbitrageOpportunity } from '@arbitrage/types';
import { SolanaExecutionStrategy } from '../../../src/strategies/solana-execution.strategy';
import type { JupiterSwapClient, JupiterQuote, JupiterSwapResult } from '../../../src/solana/jupiter-client';
import type { SolanaTransactionBuilder } from '../../../src/solana/transaction-builder';

// =============================================================================
// Mocks
// =============================================================================

jest.mock('@arbitrage/core', () => ({
  createLogger: jest.fn(() => createMockLogger()),
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

function createMockJupiterClient(): jest.Mocked<JupiterSwapClient> {
  return {
    getQuote: jest.fn(),
    getSwapTransaction: jest.fn(),
  } as any;
}

function createMockTxBuilder(): jest.Mocked<SolanaTransactionBuilder> {
  return {
    buildBundleTransaction: jest.fn(),
    getRandomTipAccount: jest.fn(),
  } as any;
}

function createMockJitoProvider() {
  return {
    chain: 'solana',
    strategy: 'jito' as const,
    isEnabled: jest.fn().mockReturnValue(true),
    sendProtectedTransaction: jest.fn(),
    simulateTransaction: jest.fn(),
    getMetrics: jest.fn(),
    resetMetrics: jest.fn(),
    healthCheck: jest.fn(),
  };
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
    id: 'test-opp-001',
    type: 'solana',
    chain: 'solana',
    tokenIn: 'So11111111111111111111111111111111111111112',
    tokenOut: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    amountIn: '1000000000', // 1 SOL in lamports
    estimatedProfit: 5000000, // 0.005 SOL estimated profit
    buyDex: 'raydium',
    sellDex: 'orca',
    timestamp: Date.now(),
    ...overrides,
  } as ArbitrageOpportunity;
}

function createTestQuote(overrides?: Partial<JupiterQuote>): JupiterQuote {
  return {
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    inAmount: '1000000000',
    outAmount: '1005000000', // 5M lamport profit
    priceImpactPct: 0.01,
    routePlan: [{
      ammKey: 'test-amm',
      label: 'Raydium',
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      inAmount: '1000000000',
      outAmount: '1005000000',
      feeAmount: '100000',
      feeMint: 'So11111111111111111111111111111111111111112',
      percent: 100,
    }],
    ...overrides,
  };
}

function createTestSwapResult(): JupiterSwapResult {
  return {
    swapTransaction: 'dGVzdC10cmFuc2FjdGlvbg==', // base64 "test-transaction"
    lastValidBlockHeight: 200000000,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('SolanaExecutionStrategy', () => {
  let strategy: SolanaExecutionStrategy;
  let mockJupiterClient: jest.Mocked<JupiterSwapClient>;
  let mockTxBuilder: jest.Mocked<SolanaTransactionBuilder>;
  let mockJitoProvider: ReturnType<typeof createMockJitoProvider>;
  let mockContext: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    mockJupiterClient = createMockJupiterClient();
    mockTxBuilder = createMockTxBuilder();
    mockJitoProvider = createMockJitoProvider();
    mockContext = createMockContext();

    strategy = new SolanaExecutionStrategy(
      mockJupiterClient,
      mockTxBuilder,
      mockJitoProvider,
      {
        walletPublicKey: 'testWalletPublicKey123',
        tipLamports: 1_000_000,
        maxSlippageBps: 100,
        minProfitLamports: 100_000n,
        maxPriceDeviationPct: 1.0,
      },
      createMockLogger(),
    );
  });

  // ===========================================================================
  // Successful execution
  // ===========================================================================

  describe('successful execution', () => {
    it('should execute full flow: quote -> build -> submit -> success', async () => {
      const opportunity = createTestOpportunity();
      const quote = createTestQuote();
      const swapResult = createTestSwapResult();

      mockJupiterClient.getQuote.mockResolvedValue(quote);
      mockJupiterClient.getSwapTransaction.mockResolvedValue(swapResult);
      mockJitoProvider.sendProtectedTransaction.mockResolvedValue({
        success: true,
        transactionHash: 'solana-tx-hash-abc123',
        strategy: 'jito',
        latencyMs: 500,
        usedFallback: false,
      });

      const result = await strategy.execute(opportunity, mockContext);

      expect(result.success).toBe(true);
      expect(result.transactionHash).toBe('solana-tx-hash-abc123');
      expect(result.chain).toBe('solana');
      expect(result.dex).toBe('raydium');
      expect(result.usedMevProtection).toBe(true);
      expect(result.latencyMs).toBeDefined();

      // Verify Jupiter was called correctly
      expect(mockJupiterClient.getQuote).toHaveBeenCalledWith(
        opportunity.tokenIn,
        opportunity.tokenOut,
        opportunity.amountIn,
        100, // maxSlippageBps
      );

      expect(mockJupiterClient.getSwapTransaction).toHaveBeenCalledWith(
        quote,
        'testWalletPublicKey123',
      );

      // Verify Jito was called
      expect(mockJitoProvider.sendProtectedTransaction).toHaveBeenCalled();
    });

    it('should report usedMevProtection=false when fallback was used', async () => {
      const opportunity = createTestOpportunity();

      mockJupiterClient.getQuote.mockResolvedValue(createTestQuote());
      mockJupiterClient.getSwapTransaction.mockResolvedValue(createTestSwapResult());
      mockJitoProvider.sendProtectedTransaction.mockResolvedValue({
        success: true,
        transactionHash: 'fallback-tx-hash',
        strategy: 'jito',
        latencyMs: 1000,
        usedFallback: true,
      });

      const result = await strategy.execute(opportunity, mockContext);

      expect(result.success).toBe(true);
      expect(result.usedMevProtection).toBe(false);
    });
  });

  // ===========================================================================
  // Price deviation check
  // ===========================================================================

  describe('price deviation check', () => {
    it('should abort when price deviation exceeds threshold', async () => {
      const opportunity = createTestOpportunity({
        estimatedProfit: 10_000_000, // Detection estimated 10M lamports profit
      });

      // Quote shows much less profit (only 5M, 50% deviation)
      const quote = createTestQuote({
        outAmount: '1005000000', // 5M profit vs 10M estimated
      });

      mockJupiterClient.getQuote.mockResolvedValue(quote);

      const result = await strategy.execute(opportunity, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('[ERR_PRICE_DEVIATION]');

      // Should NOT have called getSwapTransaction (aborted before)
      expect(mockJupiterClient.getSwapTransaction).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Minimum profit check
  // ===========================================================================

  describe('minimum profit check', () => {
    it('should abort when net profit is below minimum after tip', async () => {
      const opportunity = createTestOpportunity({
        estimatedProfit: 0, // No estimated profit from detection
      });

      // Quote shows tiny profit that won't cover tip
      const quote = createTestQuote({
        inAmount: '1000000000',
        outAmount: '1000500000', // Only 500K lamport gross profit, tip is 1M
      });

      mockJupiterClient.getQuote.mockResolvedValue(quote);

      const result = await strategy.execute(opportunity, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('[ERR_LOW_PROFIT]');

      // Should NOT have called getSwapTransaction
      expect(mockJupiterClient.getSwapTransaction).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Jupiter API error handling
  // ===========================================================================

  describe('Jupiter API error handling', () => {
    it('should handle Jupiter getQuote failure gracefully', async () => {
      const opportunity = createTestOpportunity();

      mockJupiterClient.getQuote.mockRejectedValue(
        new Error('Jupiter API error: 429 Too Many Requests'),
      );

      const result = await strategy.execute(opportunity, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('[ERR_SOLANA_EXECUTION]');
      expect(result.error).toContain('Jupiter API error');
    });

    it('should handle Jupiter getSwapTransaction failure gracefully', async () => {
      const opportunity = createTestOpportunity();

      mockJupiterClient.getQuote.mockResolvedValue(createTestQuote());
      mockJupiterClient.getSwapTransaction.mockRejectedValue(
        new Error('Swap route expired'),
      );

      const result = await strategy.execute(opportunity, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('[ERR_SOLANA_EXECUTION]');
      expect(result.error).toContain('Swap route expired');
    });
  });

  // ===========================================================================
  // Jito submission failure
  // ===========================================================================

  describe('Jito submission failure', () => {
    it('should handle Jito bundle submission failure', async () => {
      const opportunity = createTestOpportunity();

      mockJupiterClient.getQuote.mockResolvedValue(createTestQuote());
      mockJupiterClient.getSwapTransaction.mockResolvedValue(createTestSwapResult());
      mockJitoProvider.sendProtectedTransaction.mockResolvedValue({
        success: false,
        error: 'Bundle not included in time',
        strategy: 'jito',
        latencyMs: 30000,
        usedFallback: true,
      });

      const result = await strategy.execute(opportunity, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('[ERR_JITO_SUBMISSION]');
      expect(result.error).toContain('Bundle not included');
    });

    it('should handle Jito provider throwing an exception', async () => {
      const opportunity = createTestOpportunity();

      mockJupiterClient.getQuote.mockResolvedValue(createTestQuote());
      mockJupiterClient.getSwapTransaction.mockResolvedValue(createTestSwapResult());
      mockJitoProvider.sendProtectedTransaction.mockRejectedValue(
        new Error('Connection to Jito Block Engine refused'),
      );

      const result = await strategy.execute(opportunity, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('[ERR_SOLANA_EXECUTION]');
      expect(result.error).toContain('Connection to Jito Block Engine refused');
    });
  });

  // ===========================================================================
  // Invalid opportunity
  // ===========================================================================

  describe('invalid opportunity', () => {
    it('should return error when tokenIn is missing', async () => {
      const opportunity = createTestOpportunity({ tokenIn: undefined });

      const result = await strategy.execute(opportunity, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('[ERR_INVALID_OPPORTUNITY]');
    });

    it('should return error when amountIn is missing', async () => {
      const opportunity = createTestOpportunity({ amountIn: undefined });

      const result = await strategy.execute(opportunity, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('[ERR_INVALID_OPPORTUNITY]');
    });
  });

  // ===========================================================================
  // Default config
  // ===========================================================================

  describe('default configuration', () => {
    it('should use default values for unspecified config', () => {
      const defaultStrategy = new SolanaExecutionStrategy(
        mockJupiterClient,
        mockTxBuilder,
        mockJitoProvider,
        { walletPublicKey: 'testWallet' },
        createMockLogger(),
      );

      // Strategy should be created without errors
      expect(defaultStrategy).toBeInstanceOf(SolanaExecutionStrategy);
    });
  });
});
