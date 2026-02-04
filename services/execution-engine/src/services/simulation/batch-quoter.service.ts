/**
 * BatchQuoterService
 *
 * Provides batched quote fetching using the MultiPathQuoter contract.
 * Reduces latency from N sequential RPC calls to 1 batched call.
 *
 * @see contracts/src/MultiPathQuoter.sol
 * @see ADR-016: Transaction Simulation (Extended)
 */

import { ethers } from 'ethers';
import { type Logger, createServiceLogger } from '../../types';

// =============================================================================
// Types
// =============================================================================

/**
 * Quote request for a single swap
 */
export interface QuoteRequest {
  /** DEX router address */
  router: string;
  /** Input token address */
  tokenIn: string;
  /** Output token address */
  tokenOut: string;
  /** Input amount (use 0 for chained quotes to use previous output) */
  amountIn: bigint;
}

/**
 * Result of a quote request
 */
export interface QuoteResult {
  /** Output amount */
  amountOut: bigint;
  /** Whether the quote was successful */
  success: boolean;
}

/**
 * Arbitrage simulation result
 */
export interface ArbitrageSimulationResult {
  /** Expected profit after flash loan fee */
  expectedProfit: bigint;
  /** Final amount after all swaps */
  finalAmount: bigint;
  /** Whether all quotes succeeded */
  allSuccess: boolean;
  /** Latency of the quote request in ms */
  latencyMs: number;
}

/**
 * Configuration for BatchQuoterService
 */
export interface BatchQuoterConfig {
  /** JSON RPC provider */
  provider: ethers.JsonRpcProvider;
  /** MultiPathQuoter contract address (optional - uses fallback if not set) */
  quoterAddress?: string;
  /** Logger instance */
  logger?: Logger;
  /** Request timeout in ms */
  timeoutMs?: number;
}

/**
 * Service metrics
 */
export interface BatchQuoterMetrics {
  /** Total quotes requested */
  totalQuotes: number;
  /** Successful quotes */
  successfulQuotes: number;
  /** Failed quotes */
  failedQuotes: number;
  /** Times fallback was used */
  fallbackUsed: number;
  /** Average latency in ms */
  averageLatencyMs: number;
  /** Last updated timestamp */
  lastUpdated: number;
}

// =============================================================================
// MultiPathQuoter Contract ABI (minimal)
// =============================================================================

const MULTI_PATH_QUOTER_ABI = [
  'function getBatchedQuotes((address router, address tokenIn, address tokenOut, uint256 amountIn)[] requests) external view returns ((uint256 amountOut, bool success)[])',
  'function getIndependentQuotes((address router, address tokenIn, address tokenOut, uint256 amountIn)[] requests) external view returns (uint256[] amountsOut, bool[] successFlags)',
  'function simulateArbitragePath((address router, address tokenIn, address tokenOut, uint256 amountIn)[] requests, uint256 flashLoanAmount, uint256 flashLoanFeeBps) external view returns (uint256 expectedProfit, uint256 finalAmount, bool allSuccess)',
  'function compareArbitragePaths((address router, address tokenIn, address tokenOut, uint256 amountIn)[][] pathRequests, uint256[] flashLoanAmounts, uint256 flashLoanFeeBps) external view returns (uint256[] profits, bool[] successFlags)',
];

// DEX Router ABI for fallback
const DEX_ROUTER_ABI = [
  'function getAmountsOut(uint256 amountIn, address[] path) external view returns (uint256[] amounts)',
];

// =============================================================================
// Service Implementation
// =============================================================================

/**
 * BatchQuoterService provides efficient batched quote fetching.
 *
 * Features:
 * - Uses MultiPathQuoter contract when available for single-RPC batching
 * - Falls back to individual getAmountsOut calls when quoter not deployed
 * - Tracks metrics for performance monitoring
 *
 * Performance:
 * - Batched: 1 RPC call for N quotes (~50ms)
 * - Fallback: N RPC calls (~50-200ms per call)
 *
 * @example
 * ```typescript
 * const quoter = new BatchQuoterService({
 *   provider,
 *   quoterAddress: '0x...',
 * });
 *
 * // Get batched quotes for a 3-hop path
 * const result = await quoter.simulateArbitragePath(
 *   [
 *     { router: uniswap, tokenIn: WETH, tokenOut: USDC, amountIn: parseEther('10') },
 *     { router: sushi, tokenIn: USDC, tokenOut: DAI, amountIn: 0n }, // Chain from previous
 *     { router: uniswap, tokenIn: DAI, tokenOut: WETH, amountIn: 0n },
 *   ],
 *   parseEther('10'),
 *   9 // Aave V3 fee = 0.09%
 * );
 * ```
 */
export class BatchQuoterService {
  private readonly provider: ethers.JsonRpcProvider;
  private readonly quoterAddress?: string;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private quoterContract?: ethers.Contract;
  private metrics: BatchQuoterMetrics;

  constructor(config: BatchQuoterConfig) {
    this.provider = config.provider;
    this.quoterAddress = config.quoterAddress;
    this.logger = config.logger ?? createServiceLogger('batch-quoter');
    this.timeoutMs = config.timeoutMs ?? 5000;

    // Initialize contract if address provided
    if (this.quoterAddress) {
      this.quoterContract = new ethers.Contract(
        this.quoterAddress,
        MULTI_PATH_QUOTER_ABI,
        this.provider
      );
    }

    // Initialize metrics
    this.metrics = {
      totalQuotes: 0,
      successfulQuotes: 0,
      failedQuotes: 0,
      fallbackUsed: 0,
      averageLatencyMs: 0,
      lastUpdated: Date.now(),
    };
  }

  /**
   * Check if batched quoting is available (quoter contract deployed)
   */
  isBatchingEnabled(): boolean {
    return !!this.quoterContract;
  }

  /**
   * Get batched quotes for multiple swap paths
   *
   * @param requests - Array of quote requests
   * @returns Array of quote results
   */
  async getBatchedQuotes(requests: QuoteRequest[]): Promise<QuoteResult[]> {
    const startTime = Date.now();
    this.metrics.totalQuotes += requests.length;

    try {
      let results: QuoteResult[];

      if (this.quoterContract) {
        // Use batched contract call
        results = await this.callBatchedQuotes(requests);
      } else {
        // Fall back to individual calls
        this.metrics.fallbackUsed++;
        results = await this.fallbackGetQuotes(requests);
      }

      // Update metrics
      const latencyMs = Date.now() - startTime;
      const successCount = results.filter(r => r.success).length;
      this.metrics.successfulQuotes += successCount;
      this.metrics.failedQuotes += results.length - successCount;
      this.updateAverageLatency(latencyMs);

      return results;
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      this.metrics.failedQuotes += requests.length;
      this.updateAverageLatency(latencyMs);
      this.logger.error('Failed to get batched quotes', {
        error: error instanceof Error ? error.message : String(error),
        requestCount: requests.length,
      });
      throw error;
    }
  }

  /**
   * Simulate an arbitrage path and calculate expected profit
   *
   * @param requests - Array of quote requests representing the arbitrage path
   * @param flashLoanAmount - Amount to flash loan
   * @param flashLoanFeeBps - Flash loan fee in basis points (9 for Aave V3)
   * @returns Simulation result with expected profit
   */
  async simulateArbitragePath(
    requests: QuoteRequest[],
    flashLoanAmount: bigint,
    flashLoanFeeBps: number
  ): Promise<ArbitrageSimulationResult> {
    const startTime = Date.now();
    this.metrics.totalQuotes += requests.length;

    try {
      if (this.quoterContract) {
        // Use batched contract call
        const requestsArray = requests.map(r => ({
          router: r.router,
          tokenIn: r.tokenIn,
          tokenOut: r.tokenOut,
          amountIn: r.amountIn,
        }));

        const [expectedProfit, finalAmount, allSuccess] =
          await this.quoterContract.simulateArbitragePath(
            requestsArray,
            flashLoanAmount,
            flashLoanFeeBps
          );

        const latencyMs = Date.now() - startTime;
        this.updateAverageLatency(latencyMs);

        if (allSuccess) {
          this.metrics.successfulQuotes += requests.length;
        } else {
          this.metrics.failedQuotes += requests.length;
        }

        return {
          expectedProfit: BigInt(expectedProfit),
          finalAmount: BigInt(finalAmount),
          allSuccess,
          latencyMs,
        };
      } else {
        // Fall back to sequential quote simulation
        this.metrics.fallbackUsed++;
        return await this.fallbackSimulateArbitrage(
          requests,
          flashLoanAmount,
          flashLoanFeeBps,
          startTime
        );
      }
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      this.metrics.failedQuotes += requests.length;
      this.updateAverageLatency(latencyMs);
      this.logger.error('Failed to simulate arbitrage path', {
        error: error instanceof Error ? error.message : String(error),
        requestCount: requests.length,
      });
      throw error;
    }
  }

  /**
   * Compare multiple arbitrage paths and get profits for each
   *
   * @param paths - 2D array of quote requests (each inner array is a path)
   * @param flashLoanAmounts - Flash loan amounts for each path
   * @param flashLoanFeeBps - Flash loan fee in basis points
   * @returns Array of profits and success flags
   */
  async compareArbitragePaths(
    paths: QuoteRequest[][],
    flashLoanAmounts: bigint[],
    flashLoanFeeBps: number
  ): Promise<{ profits: bigint[]; successFlags: boolean[]; latencyMs: number }> {
    const startTime = Date.now();
    const totalQuotes = paths.reduce((sum, p) => sum + p.length, 0);
    this.metrics.totalQuotes += totalQuotes;

    try {
      if (this.quoterContract) {
        const pathsArray = paths.map(path =>
          path.map(r => ({
            router: r.router,
            tokenIn: r.tokenIn,
            tokenOut: r.tokenOut,
            amountIn: r.amountIn,
          }))
        );

        const [profitsRaw, successFlags] =
          await this.quoterContract.compareArbitragePaths(
            pathsArray,
            flashLoanAmounts,
            flashLoanFeeBps
          );

        const latencyMs = Date.now() - startTime;
        this.updateAverageLatency(latencyMs);

        const profits = profitsRaw.map((p: bigint) => BigInt(p));

        // P3 Fix: Track quotes per path correctly using integer math
        // Instead of averaging (which produces floats), count quotes per path individually
        for (let p = 0; p < paths.length; p++) {
          const pathQuoteCount = paths[p].length;
          if (successFlags[p]) {
            this.metrics.successfulQuotes += pathQuoteCount;
          } else {
            this.metrics.failedQuotes += pathQuoteCount;
          }
        }

        return { profits, successFlags, latencyMs };
      } else {
        // Fall back to sequential simulations
        this.metrics.fallbackUsed++;
        const profits: bigint[] = [];
        const successFlags: boolean[] = [];

        for (let i = 0; i < paths.length; i++) {
          try {
            const result = await this.fallbackSimulateArbitrage(
              paths[i],
              flashLoanAmounts[i],
              flashLoanFeeBps,
              startTime
            );
            profits.push(result.expectedProfit);
            successFlags.push(result.allSuccess);
          } catch {
            profits.push(0n);
            successFlags.push(false);
          }
        }

        return {
          profits,
          successFlags,
          latencyMs: Date.now() - startTime,
        };
      }
    } catch (error) {
      this.metrics.failedQuotes += totalQuotes;
      this.logger.error('Failed to compare arbitrage paths', {
        error: error instanceof Error ? error.message : String(error),
        pathCount: paths.length,
      });
      throw error;
    }
  }

  /**
   * Get current metrics
   */
  getMetrics(): BatchQuoterMetrics {
    return { ...this.metrics };
  }

  /**
   * Reset metrics
   */
  resetMetrics(): void {
    this.metrics = {
      totalQuotes: 0,
      successfulQuotes: 0,
      failedQuotes: 0,
      fallbackUsed: 0,
      averageLatencyMs: 0,
      lastUpdated: Date.now(),
    };
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  private async callBatchedQuotes(requests: QuoteRequest[]): Promise<QuoteResult[]> {
    if (!this.quoterContract) {
      throw new Error('Quoter contract not available');
    }

    const requestsArray = requests.map(r => ({
      router: r.router,
      tokenIn: r.tokenIn,
      tokenOut: r.tokenOut,
      amountIn: r.amountIn,
    }));

    // P2 Fix: Add timeout wrapper to prevent RPC calls from hanging indefinitely
    const results = await this.withTimeout(
      this.quoterContract.getBatchedQuotes(requestsArray),
      'Batched quotes timeout'
    );

    return results.map((r: { amountOut: bigint; success: boolean }) => ({
      amountOut: BigInt(r.amountOut),
      success: r.success,
    }));
  }

  private async fallbackGetQuotes(requests: QuoteRequest[]): Promise<QuoteResult[]> {
    const results: QuoteResult[] = [];
    let previousOutput = 0n;

    for (let i = 0; i < requests.length; i++) {
      const req = requests[i];
      const inputAmount = req.amountIn === 0n ? previousOutput : req.amountIn;

      try {
        const router = new ethers.Contract(req.router, DEX_ROUTER_ABI, this.provider);
        // P2 Fix: Add timeout wrapper to prevent RPC calls from hanging indefinitely
        const amountOut = await this.withTimeout(
          router.getAmountsOut(inputAmount, [req.tokenIn, req.tokenOut]),
          `Quote timeout for ${req.tokenIn} → ${req.tokenOut}`
        ).then(amounts => BigInt(amounts[amounts.length - 1]));

        results.push({ amountOut, success: true });
        previousOutput = amountOut;
      } catch {
        results.push({ amountOut: 0n, success: false });
        previousOutput = 0n;
      }
    }

    return results;
  }

  private async fallbackSimulateArbitrage(
    requests: QuoteRequest[],
    flashLoanAmount: bigint,
    flashLoanFeeBps: number,
    startTime: number
  ): Promise<ArbitrageSimulationResult> {
    let currentAmount = flashLoanAmount;
    let allSuccess = true;

    for (const req of requests) {
      const inputAmount = req.amountIn > 0n ? req.amountIn : currentAmount;

      try {
        const router = new ethers.Contract(req.router, DEX_ROUTER_ABI, this.provider);
        // P2 Fix: Add timeout wrapper to prevent RPC calls from hanging indefinitely
        const amounts = await this.withTimeout(
          router.getAmountsOut(inputAmount, [req.tokenIn, req.tokenOut]),
          `Arbitrage simulation timeout for ${req.tokenIn} → ${req.tokenOut}`
        );
        currentAmount = BigInt(amounts[amounts.length - 1]);
      } catch {
        allSuccess = false;
        break;
      }
    }

    const finalAmount = currentAmount;
    const flashLoanFee = (flashLoanAmount * BigInt(flashLoanFeeBps)) / 10000n;
    const amountOwed = flashLoanAmount + flashLoanFee;
    const expectedProfit = allSuccess && finalAmount > amountOwed ? finalAmount - amountOwed : 0n;

    const latencyMs = Date.now() - startTime;
    this.updateAverageLatency(latencyMs);

    if (allSuccess) {
      this.metrics.successfulQuotes += requests.length;
    } else {
      this.metrics.failedQuotes += requests.length;
    }

    return {
      expectedProfit,
      finalAmount,
      allSuccess,
      latencyMs,
    };
  }

  private updateAverageLatency(latencyMs: number): void {
    const totalOps = this.metrics.successfulQuotes + this.metrics.failedQuotes;
    if (totalOps === 0) {
      this.metrics.averageLatencyMs = latencyMs;
    } else {
      this.metrics.averageLatencyMs =
        (this.metrics.averageLatencyMs * (totalOps - 1) + latencyMs) / totalOps;
    }
    this.metrics.lastUpdated = Date.now();
  }

  /**
   * P2 Fix: Wraps a promise with a timeout to prevent indefinite hangs.
   * Uses Promise.race pattern with proper cleanup.
   */
  private async withTimeout<T>(promise: Promise<T>, errorMessage: string): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(errorMessage));
      }, this.timeoutMs);
    });

    try {
      const result = await Promise.race([promise, timeoutPromise]);
      return result;
    } finally {
      // Always clear timeout to prevent memory leak
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }
}

/**
 * Create a BatchQuoterService instance
 */
export function createBatchQuoterService(config: BatchQuoterConfig): BatchQuoterService {
  return new BatchQuoterService(config);
}
