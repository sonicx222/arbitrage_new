/**
 * BatchQuoterService Unit Tests
 *
 * Tests the batched quote service including:
 * - Constructor and initialization (batching enabled/disabled)
 * - getBatchedQuotes (batched contract path + fallback path)
 * - simulateArbitragePath (batched + fallback)
 * - compareArbitragePaths (batched + fallback)
 * - Metrics tracking
 * - Error handling and timeout behavior
 *
 * @see batch-quoter.service.ts
 * @see Phase 2 M9: BatchQuoterService has no dedicated unit test
 */

import {
  BatchQuoterService,
  type QuoteRequest,
  type BatchQuoterConfig,
} from '../../../../src/services/simulation/batch-quoter.service';

// =============================================================================
// Mocks
// =============================================================================

// Mock @arbitrage/config (CHAINS required by types.ts for SUPPORTED_CHAINS init)
jest.mock('@arbitrage/config', () => ({
  getMultiPathQuoterAddress: jest.fn().mockReturnValue(undefined),
  ARBITRAGE_CONFIG: {},
  CHAINS: { ethereum: {} },
}));

// Mock @arbitrage/core/resilience
jest.mock('@arbitrage/core/resilience', () => ({
  getErrorMessage: jest.fn((err: unknown) =>
    err instanceof Error ? err.message : String(err)
  ),
}));

// Mock ethers.Contract
// NOTE: jest.resetAllMocks() in setupTests.ts afterEach clears mockImplementation,
// so we re-apply it in beforeEach via applyEthersMock() below.
const mockGetBatchedQuotes = jest.fn();
const mockSimulateArbitragePath = jest.fn();
const mockCompareArbitragePaths = jest.fn();
const mockGetAmountsOut = jest.fn();

jest.mock('ethers', () => ({
  __esModule: true,
  ethers: {
    Contract: jest.fn(),
  },
}));

/** Re-apply ethers.Contract mockImplementation (survives jest.resetAllMocks) */
function applyEthersMock(): void {
  const { ethers } = require('ethers');
  (ethers.Contract as jest.Mock).mockImplementation((_address: string, abi: unknown) => {
    const abiStr = JSON.stringify(abi);
    const isQuoter = abiStr.includes('getBatchedQuotes');
    if (isQuoter) {
      return {
        getBatchedQuotes: mockGetBatchedQuotes,
        simulateArbitragePath: mockSimulateArbitragePath,
        compareArbitragePaths: mockCompareArbitragePaths,
      };
    }
    // DEX Router
    return {
      getAmountsOut: mockGetAmountsOut,
    };
  });
}

function createMockLogger() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as any;
}

function createMockProvider() {
  return {} as any;
}

function createQuoteRequest(overrides: Partial<QuoteRequest> = {}): QuoteRequest {
  return {
    router: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
    tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    amountIn: 1000000000000000000n,
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('BatchQuoterService', () => {
  let service: BatchQuoterService;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    jest.clearAllMocks();
    applyEthersMock();
    logger = createMockLogger();
  });

  // ===========================================================================
  // Constructor & Initialization
  // ===========================================================================

  describe('constructor', () => {
    it('should initialize without quoter contract when no address provided', () => {
      service = new BatchQuoterService({
        provider: createMockProvider(),
        logger,
      });

      expect(service.isBatchingEnabled()).toBe(false);
    });

    it('should initialize with quoter contract when address provided', () => {
      service = new BatchQuoterService({
        provider: createMockProvider(),
        quoterAddress: '0x1234567890123456789012345678901234567890',
        logger,
      });

      expect(service.isBatchingEnabled()).toBe(true);
    });

    it('should auto-resolve quoter address from chainId', () => {
      const { getMultiPathQuoterAddress } = require('@arbitrage/config');
      getMultiPathQuoterAddress.mockReturnValue('0xABCDEF1234567890ABCDEF1234567890ABCDEF12');

      service = new BatchQuoterService({
        provider: createMockProvider(),
        chainId: 'arbitrum',
        logger,
      });

      expect(service.isBatchingEnabled()).toBe(true);
      expect(logger.info).toHaveBeenCalledWith(
        'Auto-resolved MultiPathQuoter address from registry',
        expect.any(Object),
      );
    });

    it('should fall back when chainId has no quoter address', () => {
      const { getMultiPathQuoterAddress } = require('@arbitrage/config');
      getMultiPathQuoterAddress.mockReturnValue(undefined);

      service = new BatchQuoterService({
        provider: createMockProvider(),
        chainId: 'fantom',
        logger,
      });

      expect(service.isBatchingEnabled()).toBe(false);
    });
  });

  // ===========================================================================
  // getBatchedQuotes
  // ===========================================================================

  describe('getBatchedQuotes', () => {
    it('should return batched results when quoter contract available', async () => {
      mockGetBatchedQuotes.mockResolvedValue([
        { amountOut: 150000000n, success: true },
        { amountOut: 200000000n, success: true },
      ]);

      service = new BatchQuoterService({
        provider: createMockProvider(),
        quoterAddress: '0x1234567890123456789012345678901234567890',
        logger,
      });

      const results = await service.getBatchedQuotes([
        createQuoteRequest(),
        createQuoteRequest({ tokenIn: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' }),
      ]);

      expect(results).toHaveLength(2);
      expect(results[0].amountOut).toBe(150000000n);
      expect(results[0].success).toBe(true);
      expect(results[1].amountOut).toBe(200000000n);
    });

    it('should use fallback when quoter contract not available', async () => {
      mockGetAmountsOut.mockResolvedValue([1000000000000000000n, 150000000n]);

      service = new BatchQuoterService({
        provider: createMockProvider(),
        logger,
      });

      const results = await service.getBatchedQuotes([createQuoteRequest()]);

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);

      const metrics = service.getMetrics();
      expect(metrics.fallbackUsed).toBe(1);
    });

    it('should handle fallback errors gracefully per quote', async () => {
      mockGetAmountsOut.mockRejectedValue(new Error('execution reverted'));

      service = new BatchQuoterService({
        provider: createMockProvider(),
        logger,
      });

      const results = await service.getBatchedQuotes([createQuoteRequest()]);

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(results[0].amountOut).toBe(0n);
    });

    it('should propagate contract-level errors', async () => {
      mockGetBatchedQuotes.mockRejectedValue(new Error('RPC unavailable'));

      service = new BatchQuoterService({
        provider: createMockProvider(),
        quoterAddress: '0x1234567890123456789012345678901234567890',
        logger,
      });

      await expect(service.getBatchedQuotes([createQuoteRequest()])).rejects.toThrow(
        'RPC unavailable',
      );

      expect(logger.error).toHaveBeenCalledWith(
        'Failed to get batched quotes',
        expect.objectContaining({ requestCount: 1 }),
      );
    });
  });

  // ===========================================================================
  // simulateArbitragePath
  // ===========================================================================

  describe('simulateArbitragePath', () => {
    it('should return simulation result with batched contract', async () => {
      mockSimulateArbitragePath.mockResolvedValue([
        50000000n, // expectedProfit
        1050000000n, // finalAmount
        true, // allSuccess
      ]);

      service = new BatchQuoterService({
        provider: createMockProvider(),
        quoterAddress: '0x1234567890123456789012345678901234567890',
        logger,
      });

      const result = await service.simulateArbitragePath(
        [createQuoteRequest()],
        1000000000n,
        9,
      );

      expect(result.expectedProfit).toBe(50000000n);
      expect(result.finalAmount).toBe(1050000000n);
      expect(result.allSuccess).toBe(true);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should use fallback sequential simulation when no quoter', async () => {
      // First call: swap step returns output
      mockGetAmountsOut.mockResolvedValue([1000000000n, 1001000000n]);

      service = new BatchQuoterService({
        provider: createMockProvider(),
        logger,
      });

      const result = await service.simulateArbitragePath(
        [createQuoteRequest()],
        1000000000n,
        9, // 0.09% fee
      );

      expect(result.allSuccess).toBe(true);
      // flashLoanFee = 1000000000 * 9 / 10000 = 900000
      // amountOwed = 1000000000 + 900000 = 1000900000
      // expectedProfit = 1001000000 - 1000900000 = 100000
      expect(result.expectedProfit).toBe(100000n);

      const metrics = service.getMetrics();
      expect(metrics.fallbackUsed).toBe(1);
    });

    it('should return 0 profit when fallback simulation fails', async () => {
      mockGetAmountsOut.mockRejectedValue(new Error('execution reverted'));

      service = new BatchQuoterService({
        provider: createMockProvider(),
        logger,
      });

      const result = await service.simulateArbitragePath(
        [createQuoteRequest()],
        1000000000n,
        9,
      );

      expect(result.allSuccess).toBe(false);
      expect(result.expectedProfit).toBe(0n);
    });

    it('should propagate batched contract errors', async () => {
      mockSimulateArbitragePath.mockRejectedValue(new Error('Contract call failed'));

      service = new BatchQuoterService({
        provider: createMockProvider(),
        quoterAddress: '0x1234567890123456789012345678901234567890',
        logger,
      });

      await expect(
        service.simulateArbitragePath([createQuoteRequest()], 1000000000n, 9),
      ).rejects.toThrow('Contract call failed');
    });
  });

  // ===========================================================================
  // compareArbitragePaths
  // ===========================================================================

  describe('compareArbitragePaths', () => {
    it('should compare multiple paths via batched contract', async () => {
      mockCompareArbitragePaths.mockResolvedValue([
        [50000000n, 30000000n], // profits
        [true, true], // successFlags
      ]);

      service = new BatchQuoterService({
        provider: createMockProvider(),
        quoterAddress: '0x1234567890123456789012345678901234567890',
        logger,
      });

      const result = await service.compareArbitragePaths(
        [[createQuoteRequest()], [createQuoteRequest()]],
        [1000000000n, 500000000n],
        9,
      );

      expect(result.profits).toHaveLength(2);
      expect(result.profits[0]).toBe(50000000n);
      expect(result.profits[1]).toBe(30000000n);
      expect(result.successFlags).toEqual([true, true]);
    });

    it('should fallback to sequential comparison when no quoter', async () => {
      mockGetAmountsOut
        .mockResolvedValueOnce([1000000000n, 1001000000n])
        .mockResolvedValueOnce([500000000n, 500200000n]);

      service = new BatchQuoterService({
        provider: createMockProvider(),
        logger,
      });

      const result = await service.compareArbitragePaths(
        [[createQuoteRequest()], [createQuoteRequest()]],
        [1000000000n, 500000000n],
        9,
      );

      expect(result.profits).toHaveLength(2);
      expect(result.successFlags).toHaveLength(2);
    });

    it('should handle partial failures in fallback comparison', async () => {
      mockGetAmountsOut
        .mockResolvedValueOnce([1000000000n, 1001000000n]) // path 1 succeeds
        .mockRejectedValueOnce(new Error('reverted')); // path 2 fails

      service = new BatchQuoterService({
        provider: createMockProvider(),
        logger,
      });

      const result = await service.compareArbitragePaths(
        [[createQuoteRequest()], [createQuoteRequest()]],
        [1000000000n, 500000000n],
        9,
      );

      expect(result.profits).toHaveLength(2);
      expect(result.profits[1]).toBe(0n);
      expect(result.successFlags[1]).toBe(false);
    });
  });

  // ===========================================================================
  // Metrics
  // ===========================================================================

  describe('metrics', () => {
    it('should initialize with zero metrics', () => {
      service = new BatchQuoterService({
        provider: createMockProvider(),
        logger,
      });

      const metrics = service.getMetrics();
      expect(metrics.totalQuotes).toBe(0);
      expect(metrics.successfulQuotes).toBe(0);
      expect(metrics.failedQuotes).toBe(0);
      expect(metrics.fallbackUsed).toBe(0);
      expect(metrics.averageLatencyMs).toBe(0);
    });

    it('should track successful quotes', async () => {
      mockGetBatchedQuotes.mockResolvedValue([
        { amountOut: 150000000n, success: true },
      ]);

      service = new BatchQuoterService({
        provider: createMockProvider(),
        quoterAddress: '0x1234567890123456789012345678901234567890',
        logger,
      });

      await service.getBatchedQuotes([createQuoteRequest()]);

      const metrics = service.getMetrics();
      expect(metrics.totalQuotes).toBe(1);
      expect(metrics.successfulQuotes).toBe(1);
      expect(metrics.failedQuotes).toBe(0);
    });

    it('should track failed quotes', async () => {
      mockGetBatchedQuotes.mockResolvedValue([
        { amountOut: 0n, success: false },
      ]);

      service = new BatchQuoterService({
        provider: createMockProvider(),
        quoterAddress: '0x1234567890123456789012345678901234567890',
        logger,
      });

      await service.getBatchedQuotes([createQuoteRequest()]);

      const metrics = service.getMetrics();
      expect(metrics.failedQuotes).toBe(1);
    });

    it('should reset metrics', async () => {
      mockGetBatchedQuotes.mockResolvedValue([
        { amountOut: 150000000n, success: true },
      ]);

      service = new BatchQuoterService({
        provider: createMockProvider(),
        quoterAddress: '0x1234567890123456789012345678901234567890',
        logger,
      });

      await service.getBatchedQuotes([createQuoteRequest()]);
      service.resetMetrics();

      const metrics = service.getMetrics();
      expect(metrics.totalQuotes).toBe(0);
      expect(metrics.successfulQuotes).toBe(0);
    });

    it('should return a copy of metrics (not reference)', () => {
      service = new BatchQuoterService({
        provider: createMockProvider(),
        logger,
      });

      const metrics1 = service.getMetrics();
      metrics1.totalQuotes = 999;

      const metrics2 = service.getMetrics();
      expect(metrics2.totalQuotes).toBe(0);
    });
  });
});
