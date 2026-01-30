/**
 * Pending State Simulator
 *
 * Simulates pending swap transactions to predict post-swap pool reserves.
 * Uses AnvilForkManager to apply transactions and query resulting state.
 *
 * Features:
 * - Simulate individual pending swaps
 * - Batch simulation for multiple transactions
 * - Predict pool reserves after swap execution
 * - Calculate execution prices
 * - Detect affected liquidity pools
 *
 * @see Phase 2: Pending-State Simulation Engine (Implementation Plan v3.0)
 * @see Task 2.3.1: Anvil Fork Manager
 */

import { ethers } from 'ethers';
import { createPinoLogger, type ILogger } from '@arbitrage/core';
import type { AnvilForkManager } from './anvil-manager';
import type { Logger } from '../../types';
// Fix 9.3: Import shared SimulationLog type for consistent log typing
// Fix 6.3: Import shared rolling average utility
// Fix 6.2: Import getSimulationErrorMessage for consistent error handling
// Fix 9.4: Import extractRevertReason for consistent revert reason extraction
import {
  isWethAddress,
  createCancellableTimeout,
  SimulationLog,
  updateRollingAverage,
  getSimulationErrorMessage,
  extractRevertReason,
} from './types';

// =============================================================================
// Default Logger (Fix 4.1)
// =============================================================================

/**
 * Lazy-initialized Pino logger for when no logger is provided.
 * Uses Pino for proper structured logging with LOG_LEVEL support.
 */
let _defaultLogger: ILogger | null = null;
function getDefaultLogger(): ILogger {
  if (!_defaultLogger) {
    _defaultLogger = createPinoLogger('pending-state-simulator');
  }
  return _defaultLogger;
}

/**
 * Extended simulation result with logs for execution price calculation.
 *
 * Fix 9.3: Uses shared SimulationLog type from types.ts for consistent
 * log structure across the codebase.
 */
interface ExtendedSimulationResult {
  success: boolean;
  txHash?: string;
  gasUsed?: bigint;
  latencyMs: number;
  revertReason?: string;
  error?: string;
  /** Transaction logs for parsing actual swap amounts */
  logs?: SimulationLog[]; // Fix 9.3: Use shared type instead of inline definition
}

// =============================================================================
// Types
// =============================================================================

/**
 * Pending swap intent from mempool.
 * Matches the structure from mempool-detector.
 */
export interface PendingSwapIntent {
  hash: string;
  router: string;
  type: 'uniswapV2' | 'uniswapV3' | 'sushiswap' | 'curve' | '1inch' | 'pancakeswap' | 'unknown';
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  expectedAmountOut: bigint;
  path: string[];
  slippageTolerance: number;
  deadline: number;
  sender: string;
  gasPrice: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  nonce: number;
  chainId: number;
  firstSeen: number;
  /** V3 pool fee tier (100, 500, 3000, or 10000). Defaults to 3000 (0.3%) */
  fee?: number;
  /** Whether this is a native ETH input swap (requires msg.value) */
  isNativeInput?: boolean;
}

/**
 * Configuration for PendingStateSimulator.
 *
 * Fix 10.5: Added maxSnapshotPoolSize for configurable snapshot pool.
 * Fix 4.1: Added logger for structured logging.
 * Fix 10.4: Added maxBatchTimeoutMs for configurable batch timeout.
 */
export interface PendingStateSimulatorConfig {
  /** AnvilForkManager instance to use for simulation */
  anvilManager: AnvilForkManager;
  /** Default pools to query reserves for (if not specified per call) */
  defaultPools?: string[];
  /** Maximum number of pools to query per simulation */
  maxPoolsPerSimulation?: number;
  /** Timeout for each simulation in ms (default: 5000) */
  timeoutMs?: number;
  /** Known pool registry for pool detection */
  poolRegistry?: Map<string, PoolInfo>;
  /**
   * Fix 10.5: Maximum number of snapshots to keep in the reuse pool.
   * Higher values reduce snapshot creation overhead but consume more memory.
   * Default: 5
   */
  maxSnapshotPoolSize?: number;
  /**
   * Fix 4.1: Logger instance for structured logging.
   * Uses Pino logger with LOG_LEVEL support if not provided.
   */
  logger?: Logger;
  /**
   * Fix 10.4: Maximum batch simulation timeout in ms.
   * Hard cap for batch simulations to prevent stale opportunities.
   * Default: 10000 (10 seconds)
   */
  maxBatchTimeoutMs?: number;
}

/**
 * Result of simulating a pending swap.
 */
export interface PendingSwapSimulationResult {
  /** Whether the swap simulation succeeded */
  success: boolean;
  /** Predicted reserves for each pool after the swap */
  predictedReserves: Map<string, [bigint, bigint]>;
  /** Effective execution price (amountOut / amountIn) */
  executionPrice?: bigint;
  /** Actual amount received (if determinable) */
  actualAmountOut?: bigint;
  /** Gas used by the transaction */
  gasUsed?: bigint;
  /** Revert reason if failed */
  revertReason?: string;
  /** Error message if simulation failed */
  error?: string;
  /** Simulation latency in ms */
  latencyMs: number;
  /** Transaction hash from simulation */
  txHash?: string;
}

/**
 * Options for batch simulation.
 */
export interface BatchSimulationOptions {
  /** Stop simulation on first failure (default: false) */
  stopOnFailure?: boolean;
  /** Pools to query reserves for */
  pools?: string[];
}

/**
 * Pool information for detection.
 */
export interface PoolInfo {
  address: string;
  token0: string;
  token1: string;
  dex: string;
  type: 'v2' | 'v3';
}

/**
 * Metrics for simulator operations.
 */
export interface SimulatorMetrics {
  totalSimulations: number;
  successfulSimulations: number;
  failedSimulations: number;
  averageLatencyMs: number;
  lastUpdated: number;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_POOLS = 10;
/**
 * Fix 10.4: Default maximum batch timeout.
 * For competitive arbitrage, opportunities become stale after 1-2 seconds.
 * 10 seconds is the hard cap to avoid wasting resources on stale ops.
 */
const DEFAULT_MAX_BATCH_TIMEOUT_MS = 10000;

// =============================================================================
// PendingStateSimulator Implementation
// =============================================================================

/**
 * Simulates pending swap transactions to predict post-swap state.
 *
 * Usage:
 * ```typescript
 * const simulator = new PendingStateSimulator({
 *   anvilManager: manager,
 *   defaultPools: [poolAddress1, poolAddress2],
 * });
 *
 * const result = await simulator.simulatePendingSwap(pendingIntent);
 * console.log('Predicted reserves:', result.predictedReserves);
 * ```
 */
export class PendingStateSimulator {
  private readonly anvilManager: AnvilForkManager;
  private readonly defaultPools: string[];
  private readonly maxPoolsPerSimulation: number;
  private readonly timeoutMs: number;
  private readonly poolRegistry: Map<string, PoolInfo>;
  private metrics: SimulatorMetrics;
  /**
   * Fix 10.2: Token pair index for O(1) pool lookups instead of O(n) scan.
   * Maps "token0:token1" (sorted, lowercase) -> Set of pool addresses
   */
  private readonly poolTokenIndex: Map<string, Set<string>>;

  /**
   * Fix 10.4: Cache ABI interfaces to avoid re-parsing on each call.
   * Key = interface type (e.g., 'v2', 'v3single', 'v3multi')
   */
  private readonly abiCache: Map<string, ethers.Interface>;

  /**
   * Fix 10.5: Pool of reusable snapshots for simulation.
   * Instead of creating new snapshots each time, reuse existing ones.
   */
  private readonly snapshotPool: string[];
  private readonly maxSnapshotPoolSize: number;

  /**
   * Fix 4.1: Logger instance for structured logging.
   */
  private readonly logger: Logger;

  /**
   * Fix 10.4: Maximum batch timeout in milliseconds.
   */
  private readonly maxBatchTimeoutMs: number;

  constructor(config: PendingStateSimulatorConfig) {
    this.anvilManager = config.anvilManager;
    this.defaultPools = config.defaultPools ?? [];
    this.maxPoolsPerSimulation = config.maxPoolsPerSimulation ?? DEFAULT_MAX_POOLS;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.poolRegistry = config.poolRegistry ?? new Map();
    this.metrics = this.createEmptyMetrics();

    // Fix 4.1: Initialize logger
    this.logger = config.logger ?? getDefaultLogger();

    // Fix 10.4: Initialize batch timeout
    this.maxBatchTimeoutMs = config.maxBatchTimeoutMs ?? DEFAULT_MAX_BATCH_TIMEOUT_MS;

    // Fix 10.2: Build token pair index for fast lookups
    this.poolTokenIndex = new Map();
    this.buildTokenIndex();

    // Fix 10.4: Initialize ABI cache
    this.abiCache = new Map();
    this.initializeAbiCache();

    // Fix 10.5: Initialize snapshot pool with configurable size
    this.snapshotPool = [];
    this.maxSnapshotPoolSize = config.maxSnapshotPoolSize ?? 5; // Fix 10.5: Now configurable
  }

  /**
   * Fix 10.2: Pre-warm the snapshot pool for optimal hot-path performance.
   *
   * Call this method after AnvilForkManager is started to pre-create snapshots.
   * This eliminates first-simulation latency spikes caused by snapshot creation.
   *
   * @returns Number of snapshots created
   */
  async warmupSnapshotPool(): Promise<number> {
    let created = 0;
    for (let i = this.snapshotPool.length; i < this.maxSnapshotPoolSize; i++) {
      try {
        const snapshot = await this.anvilManager.createSnapshot();
        this.snapshotPool.push(snapshot);
        created++;
      } catch {
        // If snapshot creation fails, stop warming up
        break;
      }
    }
    return created;
  }

  /**
   * Fix 10.4: Pre-initialize ABI interfaces for common swap types.
   * This avoids repeated ABI parsing during hot-path simulation.
   */
  private initializeAbiCache(): void {
    // V2 swap interfaces
    this.abiCache.set('v2', new ethers.Interface([
      'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
      'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
      'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
    ]));

    // V3 single-hop swap interface
    this.abiCache.set('v3single', new ethers.Interface([
      'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
    ]));

    // V3 multi-hop swap interface
    this.abiCache.set('v3multi', new ethers.Interface([
      'function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum)) external payable returns (uint256 amountOut)',
    ]));
  }

  /**
   * Fix 10.5: Get a snapshot from pool or create new one.
   */
  private async getSnapshot(): Promise<string> {
    if (this.snapshotPool.length > 0) {
      return this.snapshotPool.pop()!;
    }
    return await this.anvilManager.createSnapshot();
  }

  /**
   * Fix 10.5 + Fix 4.3 (CRITICAL): Return snapshot to pool for reuse.
   *
   * IMPORTANT: In Anvil/Hardhat, `evm_revert` CONSUMES the snapshot (one-time use).
   * After reverting, the original snapshot ID is INVALID and cannot be reused.
   *
   * Fix 4.3: After reverting, create a NEW snapshot and add that to the pool,
   * rather than trying to reuse the consumed snapshot ID.
   */
  private async releaseSnapshot(snapshotId: string): Promise<void> {
    try {
      // Revert to snapshot to restore clean state (this CONSUMES the snapshot)
      await this.anvilManager.revertToSnapshot(snapshotId);

      // Fix 4.3: The original snapshotId is now INVALID (consumed by revert).
      // Create a NEW snapshot from the clean state to add to the pool.
      if (this.snapshotPool.length < this.maxSnapshotPoolSize) {
        const newSnapshot = await this.anvilManager.createSnapshot();
        this.snapshotPool.push(newSnapshot);
      }
      // Otherwise don't create new snapshot (pool is full, save resources)
    } catch (error) {
      // Fix 4.1: Log snapshot release failures for debugging and monitoring.
      // If revert fails, don't add to pool (state may be corrupted).
      // This can happen if Anvil process crashed or network issues occurred.
      this.logger.warn('Failed to release snapshot', {
        snapshotId,
        error: getSimulationErrorMessage(error),
        poolSize: this.snapshotPool.length,
        maxPoolSize: this.maxSnapshotPoolSize,
      });
    }
  }

  /**
   * Fix 10.2: Build index for O(1) token pair lookups.
   * Called once during construction.
   */
  private buildTokenIndex(): void {
    for (const [address, pool] of this.poolRegistry) {
      const key = this.getTokenPairKey(pool.token0, pool.token1);
      if (!this.poolTokenIndex.has(key)) {
        this.poolTokenIndex.set(key, new Set());
      }
      this.poolTokenIndex.get(key)!.add(address);
    }
  }

  /**
   * Fix 10.2: Create a canonical key for a token pair.
   * Tokens are sorted alphabetically to ensure (A,B) and (B,A) produce same key.
   */
  private getTokenPairKey(token0: string, token1: string): string {
    const t0 = token0.toLowerCase();
    const t1 = token1.toLowerCase();
    return t0 < t1 ? `${t0}:${t1}` : `${t1}:${t0}`;
  }

  // ===========================================================================
  // Public Methods - Simulation
  // ===========================================================================

  /**
   * Simulate a pending swap and predict resulting pool reserves.
   *
   * @param intent - Pending swap intent from mempool
   * @param pools - Pool addresses to query reserves for (uses defaults if not specified)
   * @returns Simulation result with predicted reserves
   */
  async simulatePendingSwap(
    intent: PendingSwapIntent,
    pools?: string[]
  ): Promise<PendingSwapSimulationResult> {
    const startTime = Date.now();
    this.metrics.totalSimulations++;

    const poolsToQuery = pools ?? this.defaultPools;
    let snapshotId: string | undefined;

    // Fix 4.1: Use cancellable timeout to prevent timer leaks (using shared utility from types.ts)
    const { promise: timeoutPromise, cancel: cancelTimeout } = createCancellableTimeout<PendingSwapSimulationResult>(
      this.timeoutMs,
      'Simulation timeout'
    );

    try {
      // Fix 10.5: Use snapshot pool for better performance (reuse snapshots)
      snapshotId = await this.getSnapshot();

      // Pre-encode swap data once (avoid double encoding on hot path)
      const encodedData = this.encodeSwapData(intent);

      const simulationPromise = this.executeSimulation(intent, encodedData, poolsToQuery);

      const result = await Promise.race([simulationPromise, timeoutPromise]);

      // Update metrics
      if (result.success) {
        this.metrics.successfulSimulations++;
      } else {
        this.metrics.failedSimulations++;
      }
      this.updateAverageLatency(result.latencyMs);

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.metrics.failedSimulations++;

      return {
        success: false,
        predictedReserves: new Map(),
        error: errorMessage,
        latencyMs: Date.now() - startTime,
      };
    } finally {
      // Fix 4.1: Always cancel timeout to prevent timer leak
      cancelTimeout();

      // Fix 10.5: Release snapshot back to pool for reuse
      if (snapshotId) {
        await this.releaseSnapshot(snapshotId);
      }
    }
  }

  /**
   * Simulate multiple pending swaps in sequence.
   *
   * Fix 4.2: Added timeout protection to prevent batch simulation from hanging.
   *
   * @param intents - Array of pending swap intents
   * @param options - Batch simulation options
   * @returns Array of simulation results
   */
  async simulateBatch(
    intents: PendingSwapIntent[],
    options: BatchSimulationOptions = {}
  ): Promise<PendingSwapSimulationResult[]> {
    if (intents.length === 0) {
      return [];
    }

    const { stopOnFailure = false, pools } = options;
    const results: PendingSwapSimulationResult[] = [];
    let snapshotId: string | undefined;

    // Fix 4.2 & 10.4: Calculate timeout based on number of intents with AGGRESSIVE bounds
    // For competitive arbitrage, opportunities are stale after 1-2 seconds
    // Batch timeout capped by configurable maxBatchTimeoutMs to avoid wasting resources on stale ops
    const batchTimeoutMs = Math.min(
      this.timeoutMs * intents.length,
      this.maxBatchTimeoutMs // Fix 10.4: Now configurable (default: 10 seconds)
    );
    const { promise: timeoutPromise, cancel: cancelTimeout } = createCancellableTimeout<PendingSwapSimulationResult[]>(
      batchTimeoutMs,
      `Batch simulation timeout after ${batchTimeoutMs}ms`
    );

    const batchOperation = async (): Promise<PendingSwapSimulationResult[]> => {
      // Create initial snapshot
      snapshotId = await this.anvilManager.createSnapshot();

      for (const intent of intents) {
        const result = await this.simulateSingleInBatch(intent, pools);
        results.push(result);

        if (!result.success && stopOnFailure) {
          break;
        }
      }

      return results;
    };

    try {
      return await Promise.race([batchOperation(), timeoutPromise]);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // Return partial results with timeout error
      results.push({
        success: false,
        predictedReserves: new Map(),
        error: errorMessage,
        latencyMs: 0,
      });
      return results;
    } finally {
      // Fix 4.2: Always cancel timeout to prevent timer leak
      cancelTimeout();

      // Revert to initial state
      if (snapshotId) {
        try {
          await this.anvilManager.revertToSnapshot(snapshotId);
        } catch {
          // Cleanup error
        }
      }
    }
  }

  /**
   * Build a raw transaction hex from a pending swap intent.
   *
   * Note: Since we use impersonation, we don't need a signed transaction.
   * This returns serialized transaction data suitable for impersonation.
   *
   * @param intent - Pending swap intent
   * @returns Raw transaction hex string
   */
  async buildRawTransaction(intent: PendingSwapIntent): Promise<string> {
    // Build transaction data based on router type
    const data = this.encodeSwapData(intent);

    // Build transaction object compatible with ethers TransactionLike
    const txLike: ethers.TransactionLike = {
      to: intent.router,
      data,
      value: this.isNativeSwap(intent) ? intent.amountIn : 0n,
      nonce: intent.nonce,
      chainId: BigInt(intent.chainId),
      gasLimit: 500000n, // Conservative estimate
    };

    // Add gas pricing
    if (intent.maxFeePerGas && intent.maxPriorityFeePerGas) {
      // EIP-1559
      txLike.maxFeePerGas = intent.maxFeePerGas;
      txLike.maxPriorityFeePerGas = intent.maxPriorityFeePerGas;
      txLike.type = 2;
    } else {
      // Legacy
      txLike.gasPrice = intent.gasPrice;
      txLike.type = 0;
    }

    // Return serialized unsigned transaction for impersonation
    return ethers.Transaction.from(txLike).unsignedSerialized;
  }

  /**
   * Detect pools that would be affected by a swap.
   *
   * Fix 10.2: Now uses O(1) indexed lookup instead of O(n) scan.
   * Fix 10.6: Uses Set instead of Array.includes() for O(1) duplicate detection.
   *
   * @param intent - Pending swap intent
   * @returns Array of pool addresses
   */
  async detectAffectedPools(intent: PendingSwapIntent): Promise<string[]> {
    // Fix 10.6: Use Set for O(1) duplicate detection instead of O(n) Array.includes()
    const detectedPoolsSet = new Set<string>();
    const path = intent.path;

    // For each pair of tokens in the path, find corresponding pool
    // Fix 10.2: Use indexed lookup for O(1) per pair instead of O(n) scan
    for (let i = 0; i < path.length - 1; i++) {
      const token0 = path[i];
      const token1 = path[i + 1];
      const key = this.getTokenPairKey(token0, token1);

      const poolAddresses = this.poolTokenIndex.get(key);
      if (poolAddresses) {
        // Set.add is O(1) and automatically handles duplicates
        for (const address of poolAddresses) {
          detectedPoolsSet.add(address);
        }
      }
    }

    return Array.from(detectedPoolsSet);
  }

  // ===========================================================================
  // Public Methods - Metrics
  // ===========================================================================

  /**
   * Get current simulation metrics.
   */
  getMetrics(): SimulatorMetrics {
    return { ...this.metrics };
  }

  /**
   * Reset metrics.
   */
  resetMetrics(): void {
    this.metrics = this.createEmptyMetrics();
  }

  // ===========================================================================
  // Private Methods - Simulation Execution
  // ===========================================================================

  /**
   * Execute the core simulation logic.
   *
   * @param intent - The pending swap intent
   * @param encodedData - Pre-encoded swap calldata (avoids re-encoding)
   * @param poolsToQuery - Pool addresses to query reserves for
   */
  private async executeSimulation(
    intent: PendingSwapIntent,
    encodedData: string,
    poolsToQuery: string[]
  ): Promise<PendingSwapSimulationResult> {
    const startTime = Date.now();

    // Apply the pending transaction using impersonation
    const txResult = await this.applyWithImpersonation(intent, encodedData);

    if (!txResult.success) {
      return {
        success: false,
        predictedReserves: new Map(),
        revertReason: txResult.revertReason,
        error: txResult.error,
        latencyMs: Date.now() - startTime,
      };
    }

    // Query pool reserves after the swap
    const predictedReserves = await this.queryPoolReserves(poolsToQuery);

    // Parse actual swap amounts from logs
    const { executionPrice, actualAmountOut } = this.parseSwapResult(intent, txResult);

    return {
      success: true,
      predictedReserves,
      executionPrice,
      actualAmountOut,
      gasUsed: txResult.gasUsed,
      txHash: txResult.txHash,
      latencyMs: Date.now() - startTime,
    };
  }

  /**
   * Apply transaction with account impersonation (Anvil feature).
   *
   * @param intent - The pending swap intent
   * @param encodedData - Pre-encoded swap calldata
   */
  private async applyWithImpersonation(
    intent: PendingSwapIntent,
    encodedData: string
  ): Promise<ExtendedSimulationResult> {
    const startTime = Date.now();
    const provider = this.anvilManager.getProvider();
    if (!provider) {
      return {
        success: false,
        error: 'Anvil not running',
        latencyMs: 0,
      };
    }

    try {
      // Impersonate the sender
      await provider.send('anvil_impersonateAccount', [intent.sender]);

      // Fund the account with ETH for gas
      await provider.send('anvil_setBalance', [
        intent.sender,
        '0x' + (10n ** 20n).toString(16), // 100 ETH
      ]);

      // Build and send transaction using pre-encoded data
      const tx = {
        from: intent.sender,
        to: intent.router,
        data: encodedData,
        value: this.isNativeSwap(intent) ? '0x' + intent.amountIn.toString(16) : '0x0',
        gas: '0x' + (500000).toString(16),
        gasPrice: '0x' + intent.gasPrice.toString(16),
      };

      const txHash = await provider.send('eth_sendTransaction', [tx]);

      // Mine the transaction
      await provider.send('evm_mine', []);

      // Get receipt
      const receipt = await provider.send('eth_getTransactionReceipt', [txHash]);

      // Stop impersonation
      await provider.send('anvil_stopImpersonatingAccount', [intent.sender]);

      const latencyMs = Date.now() - startTime;

      if (receipt && receipt.status === '0x1') {
        return {
          success: true,
          txHash,
          gasUsed: receipt.gasUsed ? BigInt(receipt.gasUsed) : undefined,
          latencyMs,
          logs: receipt.logs ?? [],
        };
      } else {
        return {
          success: false,
          revertReason: 'Transaction reverted',
          latencyMs,
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Try to stop impersonation even on error
      try {
        await provider.send('anvil_stopImpersonatingAccount', [intent.sender]);
      } catch {
        // Ignore cleanup errors
      }

      return {
        success: false,
        revertReason: extractRevertReason(errorMessage),
        error: errorMessage,
        latencyMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Simulate a single transaction in a batch (without snapshot management).
   */
  private async simulateSingleInBatch(
    intent: PendingSwapIntent,
    pools?: string[]
  ): Promise<PendingSwapSimulationResult> {
    const startTime = Date.now();
    const poolsToQuery = pools ?? this.defaultPools;

    try {
      // Pre-encode swap data once
      const encodedData = this.encodeSwapData(intent);
      const result = await this.executeSimulation(intent, encodedData, poolsToQuery);
      result.latencyMs = Date.now() - startTime;
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        predictedReserves: new Map(),
        error: errorMessage,
        latencyMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Query reserves for multiple pools.
   *
   * Fix 10.3: Performance optimization opportunity documented.
   *
   * Current implementation: Uses Promise.all() for parallel individual RPC calls.
   * This is efficient for local Anvil fork where RPC latency is minimal (~1ms per call).
   *
   * Future optimization: For remote RPC or higher pool counts, consider:
   * 1. Multicall3 batching (0xcA11bde05977b3631167028862bE2a173976CA11)
   *    - Single RPC call for all pool queries
   *    - Reduces network round-trips
   *    - Recommended when querying >5 pools over network
   *
   * 2. ethers.js JSON-RPC batching (provider.send with batch)
   *    - Groups multiple eth_call into single HTTP request
   *    - Less efficient than multicall but simpler to implement
   *
   * For local Anvil fork simulation, the current parallel approach is optimal
   * as it avoids the overhead of multicall encoding/decoding.
   */
  private async queryPoolReserves(
    pools: string[]
  ): Promise<Map<string, [bigint, bigint]>> {
    const reserves = new Map<string, [bigint, bigint]>();
    const poolsToQuery = pools.slice(0, this.maxPoolsPerSimulation);

    // Parallel queries - optimal for local Anvil fork where latency is ~1ms
    const promises = poolsToQuery.map(async (pool) => {
      try {
        const [reserve0, reserve1] = await this.anvilManager.getPoolReserves(pool);
        reserves.set(pool, [reserve0, reserve1]);
      } catch {
        // Skip pools that fail to query (may not be V2-style pairs)
      }
    });

    await Promise.all(promises);
    return reserves;
  }

  // ===========================================================================
  // Private Methods - Transaction Encoding
  // ===========================================================================

  /**
   * Encode swap data based on router type.
   */
  private encodeSwapData(intent: PendingSwapIntent): string {
    switch (intent.type) {
      case 'uniswapV2':
      case 'sushiswap':
      case 'pancakeswap':
        return this.encodeV2Swap(intent);
      case 'uniswapV3':
        return this.encodeV3Swap(intent);
      default:
        return this.encodeV2Swap(intent); // Default to V2 encoding
    }
  }

  /**
   * Encode Uniswap V2 style swap.
   * Fix 10.4: Uses cached ABI interface for performance.
   */
  private encodeV2Swap(intent: PendingSwapIntent): string {
    // Fix 10.4: Use cached ABI instead of creating new Interface each time
    const iface = this.abiCache.get('v2')!;

    // Calculate minimum output with slippage
    const amountOutMin = intent.expectedAmountOut -
      (intent.expectedAmountOut * BigInt(Math.floor(intent.slippageTolerance * 10000))) / 10000n;

    const isNative = this.isNativeSwap(intent);

    if (isNative) {
      // ETH -> Token swap
      return iface.encodeFunctionData('swapExactETHForTokens', [
        amountOutMin,
        intent.path,
        intent.sender,
        intent.deadline,
      ]);
    } else {
      // Token -> Token or Token -> ETH swap
      // Fix 6.3: Use multi-chain WETH address detection instead of hardcoded Mainnet address
      const lastPathToken = intent.path[intent.path.length - 1];
      const isTokenToEth = intent.tokenOut.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' ||
        isWethAddress(lastPathToken, intent.chainId);

      if (isTokenToEth) {
        return iface.encodeFunctionData('swapExactTokensForETH', [
          intent.amountIn,
          amountOutMin,
          intent.path,
          intent.sender,
          intent.deadline,
        ]);
      }

      return iface.encodeFunctionData('swapExactTokensForTokens', [
        intent.amountIn,
        amountOutMin,
        intent.path,
        intent.sender,
        intent.deadline,
      ]);
    }
  }

  /**
   * Encode Uniswap V3 style swap.
   *
   * Fix 7.3: Added support for multi-hop swaps using `exactInput`.
   * Fix 10.4: Uses cached ABI interface for performance.
   * Single-hop swaps use `exactInputSingle` for gas efficiency.
   * Multi-hop swaps use `exactInput` with encoded path.
   */
  private encodeV3Swap(intent: PendingSwapIntent): string {
    const amountOutMin = intent.expectedAmountOut -
      (intent.expectedAmountOut * BigInt(Math.floor(intent.slippageTolerance * 10000))) / 10000n;

    // Use fee from intent, default to 3000 (0.3%) if not specified
    const fee = intent.fee ?? 3000;

    // Fix 7.3: Check if this is a multi-hop swap (path length > 2)
    if (intent.path.length > 2) {
      return this.encodeV3MultiHopSwap(intent, amountOutMin, fee);
    }

    // Fix 10.4: Use cached ABI instead of creating new Interface each time
    const iface = this.abiCache.get('v3single')!;

    return iface.encodeFunctionData('exactInputSingle', [
      {
        tokenIn: intent.tokenIn,
        tokenOut: intent.tokenOut,
        fee,
        recipient: intent.sender,
        deadline: intent.deadline,
        amountIn: intent.amountIn,
        amountOutMinimum: amountOutMin,
        sqrtPriceLimitX96: 0n,
      },
    ]);
  }

  /**
   * Fix 7.3: Encode Uniswap V3 multi-hop swap using `exactInput`.
   * Fix 10.4: Uses cached ABI interface for performance.
   *
   * The path is encoded as: token0, fee01, token1, fee12, token2, ...
   * Each segment is: address (20 bytes) + fee (3 bytes)
   */
  private encodeV3MultiHopSwap(
    intent: PendingSwapIntent,
    amountOutMin: bigint,
    defaultFee: number
  ): string {
    // Fix 10.4: Use cached ABI instead of creating new Interface each time
    const iface = this.abiCache.get('v3multi')!;

    // Encode the path: token0 (20 bytes) + fee (3 bytes) + token1 (20 bytes) + ...
    const encodedPath = this.encodeV3Path(intent.path, defaultFee);

    return iface.encodeFunctionData('exactInput', [
      {
        path: encodedPath,
        recipient: intent.sender,
        deadline: intent.deadline,
        amountIn: intent.amountIn,
        amountOutMinimum: amountOutMin,
      },
    ]);
  }

  /**
   * Fix 7.3: Encode a V3 swap path.
   *
   * Format: token0 (20 bytes) + fee (3 bytes) + token1 (20 bytes) + fee (3 bytes) + ...
   * Last token has no trailing fee.
   *
   * @param path - Array of token addresses
   * @param defaultFee - Default fee tier (100, 500, 3000, 10000)
   * @returns Encoded path as hex string
   */
  private encodeV3Path(path: string[], defaultFee: number): string {
    if (path.length < 2) {
      throw new Error('V3 path must have at least 2 tokens');
    }

    // Each token is 20 bytes, each fee is 3 bytes
    // Total: n tokens * 20 + (n-1) fees * 3
    const parts: string[] = [];

    for (let i = 0; i < path.length; i++) {
      // Add token address (remove 0x prefix, pad to 40 hex chars = 20 bytes)
      const token = path[i].toLowerCase().replace('0x', '').padStart(40, '0');
      parts.push(token);

      // Add fee between tokens (3 bytes = 6 hex chars)
      if (i < path.length - 1) {
        const feeHex = defaultFee.toString(16).padStart(6, '0');
        parts.push(feeHex);
      }
    }

    return '0x' + parts.join('');
  }

  // ===========================================================================
  // Private Methods - Utilities
  // ===========================================================================

  /**
   * Check if this is a native ETH input swap (requires msg.value).
   *
   * Note: A swap with WETH as input is NOT a native swap - the user already has WETH.
   * A native swap is when the user sends ETH with the transaction, which gets
   * wrapped to WETH by the router.
   */
  private isNativeSwap(intent: PendingSwapIntent): boolean {
    // Use explicit flag if set (most reliable)
    if (intent.isNativeInput !== undefined) {
      return intent.isNativeInput;
    }

    // Check for native ETH placeholder address (standard convention)
    const nativeAddress = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    return intent.tokenIn.toLowerCase() === nativeAddress;
  }

  /**
   * Parse swap result from transaction logs to get actual amounts.
   *
   * Fix 4.3: Added defensive null checks for log.topics and log.data
   * to handle malformed or unexpected log formats from Anvil.
   *
   * Looks for Uniswap V2/V3 Swap events to extract actual output amounts.
   */
  private parseSwapResult(
    intent: PendingSwapIntent,
    txResult: ExtendedSimulationResult
  ): { executionPrice?: bigint; actualAmountOut?: bigint } {
    // UniswapV2 Swap event: Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)
    const V2_SWAP_TOPIC = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
    // UniswapV3 Swap event: Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, ...)
    const V3_SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';

    const logs = txResult.logs ?? [];
    let actualAmountOut: bigint | undefined;

    for (const log of logs) {
      // Fix 4.3: Defensive null checks for log structure
      if (!log || !Array.isArray(log.topics) || log.topics.length === 0 || !log.data) {
        continue;
      }

      const topic0 = log.topics[0]?.toLowerCase();
      if (!topic0) {
        continue;
      }

      if (topic0 === V2_SWAP_TOPIC) {
        // Parse V2 Swap event
        try {
          const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
            ['uint256', 'uint256', 'uint256', 'uint256'],
            log.data
          );
          // amounts: [amount0In, amount1In, amount0Out, amount1Out]
          const amount0Out = BigInt(decoded[2].toString());
          const amount1Out = BigInt(decoded[3].toString());
          // The actual output is whichever is non-zero
          actualAmountOut = amount0Out > 0n ? amount0Out : amount1Out;
          break;
        } catch {
          // Failed to parse, continue looking
        }
      } else if (topic0 === V3_SWAP_TOPIC) {
        // Parse V3 Swap event
        try {
          const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
            ['int256', 'int256', 'uint160', 'uint128', 'int24'],
            log.data
          );
          // amounts: [amount0, amount1, sqrtPriceX96, liquidity, tick]
          // Negative means tokens leaving the pool (user receives)
          const amount0 = BigInt(decoded[0].toString());
          const amount1 = BigInt(decoded[1].toString());
          // User receives the negative amount (tokens leaving pool)
          actualAmountOut = amount0 < 0n ? -amount0 : (amount1 < 0n ? -amount1 : undefined);
          break;
        } catch {
          // Failed to parse, continue looking
        }
      }
    }

    // Calculate execution price
    let executionPrice: bigint | undefined;
    if (actualAmountOut !== undefined && intent.amountIn > 0n) {
      // Price = amountOut / amountIn (scaled by 1e18 for precision)
      executionPrice = (actualAmountOut * (10n ** 18n)) / intent.amountIn;
    } else if (intent.amountIn > 0n && intent.expectedAmountOut > 0n) {
      // Fallback to expected price if logs parsing failed
      executionPrice = (intent.expectedAmountOut * (10n ** 18n)) / intent.amountIn;
    }

    return { executionPrice, actualAmountOut };
  }

  /**
   * Update rolling average latency.
   * Fix 6.3: Uses shared updateRollingAverage utility to eliminate duplication.
   */
  private updateAverageLatency(latencyMs: number): void {
    this.metrics.averageLatencyMs = updateRollingAverage(
      this.metrics.averageLatencyMs,
      latencyMs,
      this.metrics.totalSimulations
    );
    this.metrics.lastUpdated = Date.now();
  }

  /**
   * Create empty metrics object.
   */
  private createEmptyMetrics(): SimulatorMetrics {
    return {
      totalSimulations: 0,
      successfulSimulations: 0,
      failedSimulations: 0,
      averageLatencyMs: 0,
      lastUpdated: Date.now(),
    };
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a PendingStateSimulator instance.
 */
export function createPendingStateSimulator(
  config: PendingStateSimulatorConfig
): PendingStateSimulator {
  return new PendingStateSimulator(config);
}
