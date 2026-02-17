/**
 * Abstract Bridge Router Base Class
 *
 * Extracts shared bridge management logic from StargateRouter, AcrossRouter,
 * and StargateV2Router into a single base class. Each concrete router was
 * ~900 lines with ~400 lines of identical boilerplate for:
 *
 * - Pending bridge tracking with mutex-protected state machine
 * - Auto-cleanup timer lifecycle
 * - ERC20 approval with USDT forceApprove pattern
 * - Health check provider validation
 * - Invalid quote generation
 * - Promise-with-timeout utility
 *
 * Concrete routers now only implement protocol-specific logic:
 * quote(), execute(), isRouteSupported(), getEstimatedTime().
 *
 * @module bridge-router
 */

import { ethers } from 'ethers';
import {
  IBridgeRouter,
  BridgeProtocol,
  BridgeQuoteRequest,
  BridgeQuote,
  BridgeExecuteRequest,
  BridgeExecuteResult,
  BridgeStatusResult,
  BridgeStatus,
  BRIDGE_DEFAULTS,
} from './types';
import type { Logger } from '../logger';
import { clearIntervalSafe } from '../lifecycle-utils';
import { AsyncMutex } from '../async/async-mutex';

// =============================================================================
// Shared Constants
// =============================================================================

/** Timeout for on-chain transaction confirmations (2 minutes) */
export const TX_WAIT_TIMEOUT_MS = 120_000;

/** Basis points denominator for fee/slippage calculations */
export const BPS_DENOMINATOR = 10000n;

/** Gas estimation buffer: 20% above estimate */
export const GAS_BUFFER_NUMERATOR = 120n;
export const GAS_BUFFER_DENOMINATOR = 100n;

/** Maximum pending bridges to track (prevents memory leak) */
const MAX_PENDING_BRIDGES = 1000;

/** Auto-cleanup interval for old bridges (1 hour) */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/** Minimal ERC20 ABI for approval and balance checks */
export const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)',
];

// =============================================================================
// Shared Types
// =============================================================================

/**
 * Pending bridge tracking entry.
 * Shared across all router implementations.
 */
export interface PendingBridge {
  status: BridgeStatus;
  sourceTxHash: string;
  sourceChain: string;
  destChain: string;
  startTime: number;
  destTxHash?: string;
  amountReceived?: string;
  error?: string;
  /** Reason for failure - enables recovery from timeout-failed bridges */
  failReason?: 'timeout' | 'execution_error' | 'unknown';
}

// =============================================================================
// Abstract Base Class
// =============================================================================

/**
 * Abstract base class for bridge router implementations.
 *
 * Provides all shared bridge management logic. Concrete routers must implement:
 * - protocol, supportedSourceChains, supportedDestChains (readonly properties)
 * - quote() - protocol-specific fee calculation and quoting
 * - execute() - protocol-specific transaction construction and submission
 * - isRouteSupported() - protocol-specific route validation
 * - getEstimatedTime() - protocol-specific time estimates
 *
 * Optional overrides:
 * - healthCheck() - extend with protocol-specific checks (e.g., pool liquidity)
 * - getTimeoutMessage() - customize timeout error messages
 * - getRouterName() - customize health check display name
 */
export abstract class AbstractBridgeRouter implements IBridgeRouter {
  abstract readonly protocol: BridgeProtocol;
  abstract readonly supportedSourceChains: string[];
  abstract readonly supportedDestChains: string[];

  protected providers: Map<string, ethers.Provider> = new Map();
  protected pendingBridges: Map<string, PendingBridge> = new Map();
  protected approvalMutexes: Map<string, AsyncMutex> = new Map();
  protected readonly bridgesMutex = new AsyncMutex();
  protected cleanupTimer: NodeJS.Timeout | null = null;
  protected logger: Logger;

  /**
   * @param logger - Logger instance created by the concrete router.
   *   Each router calls `createLogger(name)` and passes the result here,
   *   keeping the createLogger import in the same module as the mock target.
   */
  constructor(logger: Logger, providers?: Map<string, ethers.Provider>) {
    this.logger = logger;
    if (providers) {
      this.providers = providers;
    }
    this.startAutoCleanup();
  }

  // ===========================================================================
  // Abstract Methods (must be implemented by concrete routers)
  // ===========================================================================

  abstract quote(request: BridgeQuoteRequest): Promise<BridgeQuote>;
  abstract execute(request: BridgeExecuteRequest): Promise<BridgeExecuteResult>;
  abstract isRouteSupported(sourceChain: string, destChain: string, token: string): boolean;
  abstract getEstimatedTime(sourceChain: string, destChain: string): number;

  // ===========================================================================
  // Protected Virtual Hooks (override for protocol-specific behavior)
  // ===========================================================================

  /**
   * Get a human-readable timeout error message.
   * Override to provide protocol-specific guidance.
   */
  protected getTimeoutMessage(): string {
    return 'Bridge timeout - transaction may still complete';
  }

  /**
   * Get the display name for health check messages.
   */
  protected getRouterName(): string {
    return `${this.protocol} router`;
  }

  // ===========================================================================
  // Shared Bridge Management
  // ===========================================================================

  /**
   * Register a provider for a chain
   */
  registerProvider(chain: string, provider: ethers.Provider): void {
    this.providers.set(chain, provider);
  }

  /**
   * Get status of a bridge operation.
   * Uses mutex for thread-safe access.
   */
  async getStatus(bridgeId: string): Promise<BridgeStatusResult> {
    return this.bridgesMutex.runExclusive(async () => {
      const pending = this.pendingBridges.get(bridgeId);

      if (!pending) {
        return {
          status: 'failed' as BridgeStatus,
          sourceTxHash: '',
          lastUpdated: Date.now(),
          error: 'Bridge not found',
        };
      }

      const elapsedMs = Date.now() - pending.startTime;
      const estimatedTimeMs = this.getEstimatedTime(pending.sourceChain, pending.destChain) * 1000;

      if (pending.status === 'completed' || pending.status === 'failed') {
        return {
          status: pending.status,
          sourceTxHash: pending.sourceTxHash,
          destTxHash: pending.destTxHash,
          amountReceived: pending.amountReceived,
          lastUpdated: Date.now(),
          error: pending.error,
        };
      }

      // Check if timeout
      if (elapsedMs > BRIDGE_DEFAULTS.maxBridgeWaitMs) {
        pending.status = 'failed';
        pending.error = 'Bridge timeout';
        pending.failReason = 'timeout';

        return {
          status: 'failed' as BridgeStatus,
          sourceTxHash: pending.sourceTxHash,
          lastUpdated: Date.now(),
          error: this.getTimeoutMessage(),
        };
      }

      const estimatedCompletion = pending.startTime + estimatedTimeMs;

      return {
        status: 'bridging' as BridgeStatus,
        sourceTxHash: pending.sourceTxHash,
        lastUpdated: Date.now(),
        estimatedCompletion,
      };
    });
  }

  /**
   * Mark a bridge as completed.
   * Only transitions from 'bridging' to 'completed', with timeout recovery.
   */
  async markCompleted(bridgeId: string, destTxHash: string, amountReceived: string): Promise<void> {
    await this.bridgesMutex.runExclusive(async () => {
      const pending = this.pendingBridges.get(bridgeId);
      if (!pending) {
        this.logger.warn('Cannot mark completed: bridge not found', { bridgeId });
        return;
      }

      if (pending.status !== 'bridging') {
        if (pending.status === 'failed' && pending.failReason === 'timeout') {
          this.logger.info('Recovering timeout-failed bridge', { bridgeId });
          // Fall through to complete
        } else {
          this.logger.warn('Cannot mark completed: invalid state transition', {
            bridgeId,
            currentStatus: pending.status,
            attemptedStatus: 'completed',
          });
          return;
        }
      }

      pending.status = 'completed';
      pending.destTxHash = destTxHash;
      pending.amountReceived = amountReceived;

      this.logger.info('Bridge completed', { bridgeId, destTxHash, amountReceived });
    });
  }

  /**
   * Mark a bridge as failed.
   * Only transitions from 'bridging' to 'failed'.
   */
  async markFailed(bridgeId: string, error: string): Promise<void> {
    await this.bridgesMutex.runExclusive(async () => {
      const pending = this.pendingBridges.get(bridgeId);
      if (!pending) {
        this.logger.warn('Cannot mark failed: bridge not found', { bridgeId });
        return;
      }

      if (pending.status !== 'bridging') {
        this.logger.warn('Cannot mark failed: invalid state transition', {
          bridgeId,
          currentStatus: pending.status,
          attemptedStatus: 'failed',
        });
        return;
      }

      pending.status = 'failed';
      pending.error = error;
      pending.failReason = 'execution_error';

      this.logger.warn('Bridge failed', { bridgeId, error });
    });
  }

  /**
   * Health check for the bridge router.
   * Validates provider connectivity. Override to add protocol-specific checks.
   */
  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    if (this.providers.size === 0) {
      return { healthy: false, message: 'No providers registered' };
    }

    try {
      const testChain = this.supportedSourceChains.find(c => this.providers.has(c));
      if (!testChain) {
        return { healthy: false, message: 'No providers available for supported chains' };
      }

      const destChain = this.supportedDestChains.find(c => c !== testChain);
      if (!destChain) {
        return { healthy: true, message: `${this.getRouterName()} operational (single chain only)` };
      }

      const provider = this.providers.get(testChain)!;
      await provider.getBlockNumber();

      return {
        healthy: true,
        message: `${this.getRouterName()} operational. ${this.providers.size} chains connected.`,
      };
    } catch (error) {
      return {
        healthy: false,
        message: `Health check failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Cleanup old pending bridges.
   */
  async cleanup(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<void> {
    await this.bridgesMutex.runExclusive(async () => {
      const cutoff = Date.now() - maxAgeMs;
      let cleanedCount = 0;

      for (const [bridgeId, bridge] of this.pendingBridges.entries()) {
        if (bridge.startTime < cutoff) {
          this.pendingBridges.delete(bridgeId);
          cleanedCount++;
        }
      }

      if (cleanedCount > 0) {
        this.logger.debug('Cleaned up old bridge entries', {
          cleanedCount,
          remaining: this.pendingBridges.size,
        });
      }
    });
  }

  /**
   * Stop the router and cleanup resources.
   */
  dispose(): void {
    this.cleanupTimer = clearIntervalSafe(this.cleanupTimer);
    this.approvalMutexes.clear();
  }

  // ===========================================================================
  // Protected Helpers (available to concrete routers)
  // ===========================================================================

  /**
   * Store a pending bridge with mutex protection and overflow eviction.
   * Call this from execute() after successful transaction submission.
   */
  protected async storePendingBridge(bridgeId: string, entry: PendingBridge): Promise<void> {
    await this.bridgesMutex.runExclusive(async () => {
      if (this.pendingBridges.size >= MAX_PENDING_BRIDGES) {
        const oldestKey = this.pendingBridges.keys().next().value;
        if (oldestKey) {
          this.pendingBridges.delete(oldestKey);
        }
      }
      this.pendingBridges.set(bridgeId, entry);
    });
  }

  /**
   * Create an invalid quote response for error cases.
   */
  protected createInvalidQuote(
    sourceChain: string, destChain: string, token: string, amount: string, error: string
  ): BridgeQuote {
    return {
      protocol: this.protocol,
      sourceChain,
      destChain,
      token,
      amountIn: amount,
      amountOut: '0',
      bridgeFee: '0',
      gasFee: '0',
      totalFee: '0',
      estimatedTimeSeconds: 0,
      expiresAt: Date.now(),
      valid: false,
      error,
    };
  }

  /**
   * Ensure ERC20 token approval for a spender.
   * Uses forceApprove pattern (reset to 0 first) for USDT compatibility.
   */
  protected async ensureApproval(
    wallet: ethers.Wallet,
    tokenAddress: string,
    spenderAddress: string,
    amount: bigint
  ): Promise<boolean> {
    try {
      const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
      const currentAllowance = await token.allowance(wallet.address, spenderAddress);

      if (currentAllowance >= amount) {
        this.logger.debug('Sufficient allowance already exists', {
          token: tokenAddress,
          spender: spenderAddress,
          allowance: currentAllowance.toString(),
          required: amount.toString(),
        });
        return true;
      }

      this.logger.info(`Approving token for ${this.getRouterName()}`, {
        token: tokenAddress,
        spender: spenderAddress,
        currentAllowance: currentAllowance.toString(),
        requiredAmount: amount.toString(),
      });

      // USDT forceApprove pattern: reset to 0 first if non-zero
      if (currentAllowance > 0n) {
        const resetTx = await token.approve(spenderAddress, 0n);
        await this.waitWithTimeout<ethers.TransactionReceipt | null>(
          resetTx.wait(), TX_WAIT_TIMEOUT_MS, 'Approval reset confirmation'
        );
      }

      const approveTx = await token.approve(spenderAddress, amount);
      const receipt = await this.waitWithTimeout(
        approveTx.wait(), TX_WAIT_TIMEOUT_MS, 'Approval confirmation'
      ) as ethers.TransactionReceipt | null;

      if (!receipt || receipt.status !== 1) {
        this.logger.error('Token approval failed', { token: tokenAddress });
        return false;
      }

      this.logger.info('Token approval successful', {
        token: tokenAddress,
        txHash: receipt.hash,
      });

      return true;
    } catch (error) {
      this.logger.error('Token approval error', {
        token: tokenAddress,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Race a promise against a timeout, ensuring the timer is always cleaned up.
   */
  protected async waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number, description: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${description} timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }

  /**
   * Get or create a per-token approval mutex to prevent concurrent approval races.
   */
  protected getApprovalMutex(tokenAddress: string): AsyncMutex {
    let mutex = this.approvalMutexes.get(tokenAddress);
    if (!mutex) {
      mutex = new AsyncMutex();
      this.approvalMutexes.set(tokenAddress, mutex);
    }
    return mutex;
  }

  // ===========================================================================
  // Private
  // ===========================================================================

  /**
   * Start automatic cleanup of old pending bridges.
   */
  private startAutoCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    this.cleanupTimer = setInterval(() => {
      this.cleanup(24 * 60 * 60 * 1000).catch(err => {
        this.logger.error('Auto-cleanup failed', { error: err instanceof Error ? err.message : String(err) });
      });
    }, CLEANUP_INTERVAL_MS);

    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }
}
