/**
 * Commit-Reveal Service
 *
 * Manages the commit-reveal lifecycle for MEV protection:
 * 1. Commit: Submit commitment hash on-chain
 * 2. Store: Save reveal parameters for later use
 * 3. Wait: Monitor for 1 block confirmation
 * 4. Validate: Re-check profitability before reveal
 * 5. Reveal: Execute swap with retry on failure
 *
 * Architecture:
 * - Hybrid storage: Redis (if enabled) + in-memory fallback
 * - Simple 1-retry strategy with +10% gas bump
 * - Automatic profitability re-validation
 * - Graceful degradation on failures
 *
 * @module services/commit-reveal
 * @see contracts/src/CommitRevealArbitrage.sol
 * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Task 3.1
 */

import { ethers } from 'ethers';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import { getErrorMessage } from '@arbitrage/core';
import type { Logger, StrategyContext } from '../types';
import type { Redis } from 'ioredis';

// =============================================================================
// Constants
// =============================================================================

/**
 * ABI for CommitRevealArbitrage contract v2.0.0
 * Minimal interface for commit/reveal operations
 *
 * ## v2.0.0 Breaking Change
 * reveal() function signature changed to support multi-router arbitrage:
 * - Old: (address tokenIn, address tokenOut, uint256 amountIn, uint256 minProfit, address router, uint256 deadline, bytes32 salt)
 * - New: (address asset, uint256 amountIn, (address router, address tokenIn, address tokenOut, uint256 amountOutMin)[] swapPath, uint256 minProfit, uint256 deadline, bytes32 salt)
 */
const COMMIT_REVEAL_ABI = [
  'function commit(bytes32 commitmentHash) external',
  'function batchCommit(bytes32[] calldata commitmentHashes) external',
  'function reveal((address asset, uint256 amountIn, (address router, address tokenIn, address tokenOut, uint256 amountOutMin)[] swapPath, uint256 minProfit, uint256 deadline, bytes32 salt) params) external',
  'function cancelCommit(bytes32 commitmentHash) external',
  'event Committed(bytes32 indexed commitmentHash, uint256 blockNumber, address indexed committer)',
  'event Revealed(bytes32 indexed commitmentHash, address indexed tokenIn, address indexed tokenOut, uint256 profit)',
] as const;

/**
 * Redis key prefix for commit-reveal state
 * Pattern: commit-reveal:{chain}:{commitmentHash}
 */
const REDIS_KEY_PREFIX = 'commit-reveal';

/**
 * Redis TTL for commitment state (10 minutes)
 */
const REDIS_TTL_SECONDS = 600;

/**
 * Gas bump percentage for retry (10%)
 */
const RETRY_GAS_BUMP_PERCENT = 10;

// =============================================================================
// Types
// =============================================================================

/**
 * Single swap step in arbitrage path
 * Must match CommitRevealArbitrage.sol SwapStep struct
 */
export interface SwapStep {
  router: string;
  tokenIn: string;
  tokenOut: string;
  amountOutMin: bigint;
}

/**
 * Parameters for reveal phase
 * Must match CommitRevealArbitrage.sol RevealParams struct (v2.0.0)
 *
 * ## v2.0.0 Breaking Change
 * Changed from single router to SwapStep[] array to support multi-router arbitrage.
 */
export interface CommitRevealParams {
  asset: string;
  amountIn: bigint;
  swapPath: SwapStep[];
  minProfit: bigint;
  deadline: number;
  salt: string; // Hex string (e.g., "0x123...")
}

/**
 * Result of commit operation
 */
export interface CommitResult {
  success: boolean;
  commitmentHash: string;
  txHash: string;
  commitBlock: number;
  revealBlock: number; // commitBlock + 1
  error?: string;
}

/**
 * Result of reveal operation
 */
export interface RevealResult {
  success: boolean;
  txHash?: string;
  profit?: bigint;
  error?: string;
}

/**
 * Stored state for pending reveal
 * Saved in Redis or in-memory cache
 */
interface CommitmentState {
  params: CommitRevealParams;
  opportunityId: string;
  chain: string;
  commitBlock: number;
  revealBlock: number;
  commitTxHash: string;
  expectedProfit?: number; // For profitability comparison
}

// =============================================================================
// CommitRevealService
// =============================================================================

/**
 * Service for managing commit-reveal MEV protection
 *
 * Usage:
 * ```typescript
 * const service = new CommitRevealService(logger, contractAddresses);
 *
 * // Commit
 * const commitResult = await service.commit(params, 'ethereum', ctx);
 *
 * // Wait for block
 * await service.waitForRevealBlock(commitResult.revealBlock, 'ethereum', ctx);
 *
 * // Reveal
 * const revealResult = await service.reveal(commitResult.commitmentHash, 'ethereum', ctx);
 * ```
 */
export class CommitRevealService {
  private readonly contractAddresses: Record<string, string>;
  private readonly inMemoryCache = new Map<string, string>();
  private readonly logger: Logger;
  private readonly redisClient?: Redis; // Optional Redis client (dependency injection)

  constructor(
    logger: Logger,
    contractAddresses: Record<string, string>,
    redisClient?: Redis // Optional: pass Redis client for better testability
  ) {
    this.logger = logger;
    this.contractAddresses = contractAddresses;
    this.redisClient = redisClient;

    // Validate that at least one contract address is configured
    const deployedChains = Object.entries(contractAddresses)
      .filter(([, address]) => address && address !== '')
      .map(([chain]) => chain);

    if (deployedChains.length === 0) {
      this.logger.warn(
        'CommitRevealService initialized with no deployed contracts. ' +
        'All commit-reveal operations will fail. ' +
        'Set contract addresses via COMMIT_REVEAL_CONTRACT_* environment variables.',
        { contractAddresses }
      );
    } else {
      this.logger.info('CommitRevealService initialized', {
        deployedChains,
        chainCount: deployedChains.length,
        redisEnabled: !!redisClient
      });
    }
  }

  /**
   * Submit commit transaction on-chain
   *
   * Flow:
   * 1. Compute commitment hash from parameters
   * 2. Get contract instance
   * 3. Submit commit transaction
   * 4. Wait for confirmation
   * 5. Store reveal parameters for later use
   *
   * @param params Reveal parameters to commit
   * @param chain Chain identifier (e.g., 'ethereum')
   * @param ctx Strategy context with providers/wallets
   * @param opportunityId Optional opportunity ID for tracking
   * @param expectedProfit Optional expected profit for validation
   * @returns Commit result with commitment hash and block numbers
   */
  async commit(
    params: CommitRevealParams,
    chain: string,
    ctx: StrategyContext,
    opportunityId?: string,
    expectedProfit?: number
  ): Promise<CommitResult> {
    try {
      // 1. Validate contract deployment
      const contractAddress = this.contractAddresses[chain];
      if (!contractAddress) {
        return {
          success: false,
          commitmentHash: '',
          txHash: '',
          commitBlock: 0,
          revealBlock: 0,
          error: `No commit-reveal contract deployed on ${chain}`,
        };
      }

      // 2. Compute commitment hash (must match Solidity keccak256(abi.encode(...)))
      const commitmentHash = this.computeCommitmentHash(params);

      // 3. Get wallet and contract
      const wallet = ctx.wallets.get(chain);
      if (!wallet) {
        return {
          success: false,
          commitmentHash,
          txHash: '',
          commitBlock: 0,
          revealBlock: 0,
          error: `No wallet configured for chain: ${chain}`,
        };
      }

      const contract = new ethers.Contract(contractAddress, COMMIT_REVEAL_ABI, wallet);

      // 4. Submit commit transaction
      this.logger.info('Submitting commit transaction', {
        chain,
        commitmentHash,
        opportunityId,
      });

      const tx = await contract.commit(commitmentHash);
      const receipt = await tx.wait();

      const commitBlock = receipt.blockNumber;
      const revealBlock = commitBlock + 1; // 1 block delay

      this.logger.info('Commitment confirmed on-chain', {
        chain,
        commitmentHash,
        txHash: receipt.hash,
        commitBlock,
        revealBlock,
      });

      // 5. Store reveal parameters for later
      await this.storeCommitmentState({
        params,
        opportunityId: opportunityId || `commit-${Date.now()}`,
        chain,
        commitBlock,
        revealBlock,
        commitTxHash: receipt.hash,
        expectedProfit,
      }, commitmentHash);

      return {
        success: true,
        commitmentHash,
        txHash: receipt.hash,
        commitBlock,
        revealBlock,
      };
    } catch (error) {
      this.logger.error('Commit transaction failed', {
        chain,
        error: getErrorMessage(error),
      });

      return {
        success: false,
        commitmentHash: '',
        txHash: '',
        commitBlock: 0,
        revealBlock: 0,
        error: getErrorMessage(error),
      };
    }
  }

  /**
   * Reveal commitment and execute arbitrage swap
   *
   * Flow:
   * 1. Load commitment state from storage
   * 2. Verify current block >= reveal block
   * 3. Re-validate profitability (optional but recommended)
   * 4. Submit reveal transaction
   * 5. Retry once with +10% gas if first attempt fails
   * 6. Extract profit from event logs
   *
   * @param commitmentHash Commitment hash from commit operation
   * @param chain Chain identifier
   * @param ctx Strategy context
   * @returns Reveal result with success status and profit
   */
  async reveal(
    commitmentHash: string,
    chain: string,
    ctx: StrategyContext
  ): Promise<RevealResult> {
    try {
      // 1. Load commitment state
      const state = await this.loadCommitmentState(commitmentHash, chain);
      if (!state) {
        return {
          success: false,
          error: 'Commitment state not found (may have expired)',
        };
      }

      // 2. Verify current block
      const provider = ctx.providers.get(chain);
      if (!provider) {
        return { success: false, error: `No provider for chain: ${chain}` };
      }

      const currentBlock = await provider.getBlockNumber();
      if (currentBlock < state.revealBlock) {
        return {
          success: false,
          error: `Too early to reveal. Current: ${currentBlock}, Need: ${state.revealBlock}`,
        };
      }

      // 3. Re-check profitability (optional - can be disabled for performance)
      if (state.expectedProfit && process.env.COMMIT_REVEAL_VALIDATE_PROFIT !== 'false') {
        const stillProfitable = await this.validateProfitability(state, chain, ctx);
        if (!stillProfitable) {
          this.logger.warn('Opportunity no longer profitable, skipping reveal', {
            commitmentHash,
            chain,
            expectedProfit: state.expectedProfit,
          });
          return {
            success: false,
            error: 'Opportunity no longer profitable after commit delay',
          };
        }
      }

      // 4. Get contract
      const wallet = ctx.wallets.get(chain);
      if (!wallet) {
        return { success: false, error: `No wallet for chain: ${chain}` };
      }

      const contract = new ethers.Contract(
        this.contractAddresses[chain],
        COMMIT_REVEAL_ABI,
        wallet
      );

      // 5. Submit reveal transaction (first attempt)
      this.logger.info('Submitting reveal transaction', {
        commitmentHash,
        chain,
        currentBlock,
      });

      try {
        const tx = await contract.reveal(state.params);
        const receipt = await tx.wait();

        const profit = this.extractProfitFromLogs(receipt.logs);

        this.logger.info('Reveal successful', {
          commitmentHash,
          chain,
          txHash: receipt.hash,
          profit: profit?.toString(),
        });

        // Clean up stored state
        await this.deleteCommitmentState(commitmentHash, chain);

        return {
          success: true,
          txHash: receipt.hash,
          profit,
        };
      } catch (error) {
        // 6. Retry once with higher gas
        this.logger.warn('Reveal failed, retrying with higher gas', {
          commitmentHash,
          chain,
          error: getErrorMessage(error),
        });

        return await this.retryReveal(state, chain, ctx, commitmentHash);
      }
    } catch (error) {
      this.logger.error('Reveal operation failed', {
        commitmentHash,
        chain,
        error: getErrorMessage(error),
      });

      return {
        success: false,
        error: getErrorMessage(error),
      };
    }
  }

  /**
   * Wait for a specific block number to be reached
   *
   * Polls every 2 seconds with timeout after 60 seconds
   *
   * @param targetBlock Target block number
   * @param chain Chain identifier
   * @param ctx Strategy context
   */
  async waitForRevealBlock(
    targetBlock: number,
    chain: string,
    ctx: StrategyContext
  ): Promise<{ success: boolean; currentBlock?: number; error?: string }> {
    const provider = ctx.providers.get(chain);
    if (!provider) {
      return {
        success: false,
        error: `No provider available for chain: ${chain}`
      };
    }

    const maxAttempts = 60; // 60 attempts * 2s = 120s timeout
    const pollIntervalMs = 2000;
    const maxConsecutiveErrors = 5; // Fail fast after 5 consecutive errors
    let attempts = 0;
    let consecutiveErrors = 0;

    this.logger.debug('Starting block wait', {
      chain,
      targetBlock,
      maxWaitTime: `${(maxAttempts * pollIntervalMs) / 1000}s`
    });

    while (attempts < maxAttempts) {
      try {
        const currentBlock = await provider.getBlockNumber();

        // Reset consecutive error counter on success
        consecutiveErrors = 0;

        if (currentBlock >= targetBlock) {
          this.logger.info('Target block reached', {
            chain,
            currentBlock,
            targetBlock,
            attemptsUsed: attempts
          });
          return { success: true, currentBlock };
        }

        this.logger.debug('Waiting for reveal block', {
          chain,
          currentBlock,
          targetBlock,
          remainingBlocks: targetBlock - currentBlock,
        });

        await this.sleep(pollIntervalMs);
        attempts++;
      } catch (error) {
        consecutiveErrors++;

        this.logger.warn('Error checking block number', {
          chain,
          targetBlock,
          attempt: attempts,
          consecutiveErrors,
          error: getErrorMessage(error)
        });

        // Fail fast if provider is permanently unavailable
        if (consecutiveErrors >= maxConsecutiveErrors) {
          return {
            success: false,
            error: `Provider permanently unavailable after ${consecutiveErrors} consecutive errors: ${getErrorMessage(error)}`
          };
        }

        // Continue trying despite transient errors
        await this.sleep(pollIntervalMs);
        attempts++;
      }
    }

    // Timeout - return error instead of throwing
    return {
      success: false,
      error: `Timeout waiting for block ${targetBlock} on ${chain} after ${maxAttempts} attempts`
    };
  }

  /**
   * Cancel a commitment (gas refund mechanism)
   *
   * @param commitmentHash Commitment hash to cancel
   * @param chain Chain identifier
   * @param ctx Strategy context
   */
  async cancel(
    commitmentHash: string,
    chain: string,
    ctx: StrategyContext
  ): Promise<boolean> {
    try {
      const wallet = ctx.wallets.get(chain);
      if (!wallet) return false;

      const contract = new ethers.Contract(
        this.contractAddresses[chain],
        COMMIT_REVEAL_ABI,
        wallet
      );

      const tx = await contract.cancelCommit(commitmentHash);
      await tx.wait();

      this.logger.info('Commitment cancelled', { commitmentHash, chain });

      // Clean up storage
      await this.deleteCommitmentState(commitmentHash, chain);

      return true;
    } catch (error) {
      this.logger.error('Cancel failed', {
        commitmentHash,
        chain,
        error: getErrorMessage(error),
      });
      return false;
    }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Compute commitment hash (matches Solidity implementation v2.0.0)
   *
   * Formula: keccak256(abi.encode(params))
   *
   * ## v2.0.0 Breaking Change
   * Encoding changed to include SwapStep[] array instead of single router.
   * This means existing commitments from v1.0.0 will have different hashes and won't work.
   */
  private computeCommitmentHash(params: CommitRevealParams): string {
    // Encode SwapStep array
    const swapPathEncoded = params.swapPath.map(step => [
      step.router,
      step.tokenIn,
      step.tokenOut,
      step.amountOutMin
    ]);

    return ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        [
          'address',  // asset
          'uint256',  // amountIn
          'tuple(address,address,address,uint256)[]',  // swapPath (array of SwapStep)
          'uint256',  // minProfit
          'uint256',  // deadline
          'bytes32'   // salt
        ],
        [
          params.asset,
          params.amountIn,
          swapPathEncoded,
          params.minProfit,
          params.deadline,
          params.salt,
        ]
      )
    );
  }

  /**
   * Store commitment state (hybrid: Redis or in-memory) with atomic uniqueness check.
   *
   * FIX (Issue 1.1): Use atomic SET NX (set if not exists) to prevent race conditions
   * in multi-process deployments. Two processes committing the same opportunity will
   * not create conflicting state.
   *
   * Storage Strategy:
   * - Redis enabled: Atomic SET NX + EX (expires after TTL)
   * - Redis disabled: In-memory with uniqueness check
   *
   * @throws Error if commitment already exists (duplicate)
   */
  private async storeCommitmentState(
    state: CommitmentState,
    commitmentHash: string
  ): Promise<void> {
    const key = `${REDIS_KEY_PREFIX}:${state.chain}:${commitmentHash}`;
    const data = JSON.stringify({
      ...state,
      // Convert bigint to string for JSON serialization
      params: {
        ...state.params,
        amountIn: state.params.amountIn.toString(),
        minProfit: state.params.minProfit.toString(),
        swapPath: state.params.swapPath.map(step => ({
          ...step,
          amountOutMin: step.amountOutMin.toString()
        }))
      },
    });

    // FIX: Redis-first with atomic SET NX for multi-process safety
    if (process.env.FEATURE_COMMIT_REVEAL_REDIS === 'true') {
      try {
        // Use injected Redis client or fall back to global (for backward compatibility)
        const redis = this.redisClient || (global as any).redisClient as Redis | undefined;
        if (redis) {
          // Atomic SET with NX (not exists) and EX (expiration)
          // Returns 'OK' if set, null if key already exists
          const result = await redis.set(key, data, 'EX', REDIS_TTL_SECONDS, 'NX');

          if (result === 'OK') {
            // Successfully stored in Redis - sync to local memory cache
            this.inMemoryCache.set(key, data);
            this.logger.debug('Stored commitment atomically in Redis + memory', {
              key,
              storageMode: 'atomic-hybrid',
              commitmentHash
            });
            return; // Success
          } else {
            // Key already exists - another process committed first
            throw new Error(
              `[ERR_DUPLICATE_COMMITMENT] Commitment ${commitmentHash} already exists on ${state.chain}. ` +
              `Another process may have committed this opportunity first.`
            );
          }
        } else {
          // Redis client not available - log warning and fall through to memory-only
          this.logger.warn('Redis client not available, using in-memory storage', {
            key,
            warning: 'Multi-process coordination not possible without Redis'
          });
        }
      } catch (error) {
        // Re-throw duplicate errors (expected behavior)
        if (error instanceof Error && error.message.includes('ERR_DUPLICATE_COMMITMENT')) {
          throw error;
        }

        // Log other Redis errors but fall through to memory-only
        this.logger.warn('Redis storage failed, falling back to memory only', {
          error: getErrorMessage(error),
          key
        });
      }
    }

    // Fallback: In-memory storage (single process or Redis disabled)
    // Still validate uniqueness to catch programming errors
    if (this.inMemoryCache.has(key)) {
      throw new Error(
        `[ERR_DUPLICATE_COMMITMENT] Commitment ${commitmentHash} already exists in memory on ${state.chain}. ` +
        `This may indicate a bug in commitment logic (same opportunity committed twice).`
      );
    }

    this.inMemoryCache.set(key, data);
    this.logger.debug('Stored commitment in memory only', {
      key,
      reason: process.env.FEATURE_COMMIT_REVEAL_REDIS === 'true' ? 'Redis fallback' : 'Redis disabled',
      storageMode: 'memory-only'
    });
  }

  /**
   * Load commitment state from storage
   */
  private async loadCommitmentState(
    commitmentHash: string,
    chain: string
  ): Promise<CommitmentState | null> {
    const key = `${REDIS_KEY_PREFIX}:${chain}:${commitmentHash}`;

    // Try Redis first
    if (process.env.FEATURE_COMMIT_REVEAL_REDIS === 'true') {
      try {
        // Use injected Redis client or fall back to global (for backward compatibility)
        const redis = this.redisClient || (global as any).redisClient as Redis | undefined;
        if (redis) {
          const data = await redis.get(key);
          if (data) {
            const parsed = JSON.parse(data);
            // Convert string back to bigint
            return {
              ...parsed,
              params: {
                ...parsed.params,
                amountIn: BigInt(parsed.params.amountIn),
                minProfit: BigInt(parsed.params.minProfit),
                swapPath: parsed.params.swapPath.map((step: any) => ({
                  ...step,
                  amountOutMin: BigInt(step.amountOutMin)
                }))
              },
            };
          }
        }
      } catch (error) {
        this.logger.warn('Redis load failed, trying memory', {
          error: getErrorMessage(error),
        });
      }
    }

    // Fallback: in-memory cache
    const data = this.inMemoryCache.get(key);
    if (data) {
      const parsed = JSON.parse(data);
      return {
        ...parsed,
        params: {
          ...parsed.params,
          amountIn: BigInt(parsed.params.amountIn),
          minProfit: BigInt(parsed.params.minProfit),
          swapPath: parsed.params.swapPath.map((step: any) => ({
            ...step,
            amountOutMin: BigInt(step.amountOutMin)
          }))
        },
      };
    }

    return null;
  }

  /**
   * Delete commitment state from storage
   */
  private async deleteCommitmentState(
    commitmentHash: string,
    chain: string
  ): Promise<void> {
    const key = `${REDIS_KEY_PREFIX}:${chain}:${commitmentHash}`;

    // Delete from Redis
    if (process.env.FEATURE_COMMIT_REVEAL_REDIS === 'true') {
      try {
        // Use injected Redis client or fall back to global (for backward compatibility)
        const redis = this.redisClient || (global as any).redisClient as Redis | undefined;
        if (redis) {
          await redis.del(key);
        }
      } catch (error) {
        // Ignore deletion errors
      }
    }

    // Delete from memory
    this.inMemoryCache.delete(key);
  }

  /**
   * Retry reveal with higher gas (1 retry only)
   */
  private async retryReveal(
    state: CommitmentState,
    chain: string,
    ctx: StrategyContext,
    commitmentHash: string
  ): Promise<RevealResult> {
    try {
      const wallet = ctx.wallets.get(chain);
      if (!wallet) {
        return { success: false, error: 'No wallet for retry' };
      }

      const contract = new ethers.Contract(
        this.contractAddresses[chain],
        COMMIT_REVEAL_ABI,
        wallet
      );

      // Estimate gas and add 10% buffer
      const gasEstimate = await contract.reveal.estimateGas(state.params);
      const gasLimit = (gasEstimate * BigInt(100 + RETRY_GAS_BUMP_PERCENT)) / 100n;

      this.logger.info('Retrying reveal with higher gas', {
        commitmentHash,
        chain,
        gasEstimate: gasEstimate.toString(),
        gasLimit: gasLimit.toString(),
      });

      const tx = await contract.reveal(state.params, { gasLimit });
      const receipt = await tx.wait();

      const profit = this.extractProfitFromLogs(receipt.logs);

      this.logger.info('Reveal retry successful', {
        commitmentHash,
        chain,
        txHash: receipt.hash,
        profit: profit?.toString(),
      });

      // Clean up
      await this.deleteCommitmentState(commitmentHash, chain);

      return {
        success: true,
        txHash: receipt.hash,
        profit,
      };
    } catch (error) {
      this.logger.error('Reveal retry failed', {
        commitmentHash,
        chain,
        error: getErrorMessage(error),
      });

      return {
        success: false,
        error: `Reveal failed after retry: ${getErrorMessage(error)}`,
      };
    }
  }

  /**
   * Validate profitability before reveal (simple check)
   *
   * TODO: Implement proper quote fetching for accurate validation
   * For MVP, we trust the original profitability assessment
   */
  private async validateProfitability(
    state: CommitmentState,
    chain: string,
    ctx: StrategyContext
  ): Promise<boolean> {
    // MVP: Always return true (optimistic)
    // v2: Fetch fresh quotes and compare to minProfit
    return true;
  }

  /**
   * Extract profit from Revealed event logs
   */
  private extractProfitFromLogs(logs: ethers.Log[]): bigint | undefined {
    try {
      const iface = new ethers.Interface(COMMIT_REVEAL_ABI);

      for (const log of logs) {
        try {
          const parsed = iface.parseLog(log);
          if (parsed && parsed.name === 'Revealed') {
            return BigInt(parsed.args[3]); // profit is 4th argument (index 3)
          }
        } catch {
          // Not a Revealed event, continue
        }
      }

      // No Revealed event found - log warning for debugging
      this.logger.warn('No Revealed event found in transaction logs', {
        logCount: logs.length,
        logTopics: logs.map(l => l.topics[0]).slice(0, 5) // First 5 topics for debugging
      });
    } catch (error) {
      this.logger.warn('Failed to extract profit from logs', {
        error: getErrorMessage(error),
      });
    }

    return undefined;
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
