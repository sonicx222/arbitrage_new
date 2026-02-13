/**
 * Nonce Allocation Manager
 *
 * Manages per-chain nonce locks to prevent race conditions when multiple strategies
 * attempt to allocate nonces for the same chain concurrently.
 *
 * Extracted from base.strategy.ts as part of R4 refactoring.
 *
 * Problem: Multiple strategies executing in parallel for the SAME chain could
 * allocate the same nonce, causing transaction failures and wasted gas.
 *
 * Solution: Simple mutex per chain using Promise-based locking.
 * When acquiring a lock, if another operation holds it, we wait for its release.
 *
 * @see base.strategy.ts (consumer)
 * @see REFACTORING_ROADMAP.md R4
 */

import type { Logger } from '../types';
import { createCancellableTimeout } from './simulation/types';

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for the NonceAllocationManager.
 */
export interface NonceAllocationManagerConfig {
  /** Default timeout for acquiring nonce lock (ms) */
  defaultLockTimeoutMs?: number;
}

// =============================================================================
// NonceAllocationManager Class
// =============================================================================

/**
 * NonceAllocationManager - Manages per-chain nonce locks to prevent race conditions.
 *
 * This class provides a centralized way to manage nonce allocation across chains.
 * It ensures that only one nonce allocation happens at a time per chain, preventing
 * the race condition where multiple strategies could allocate the same nonce.
 *
 * Usage:
 * ```typescript
 * const manager = new NonceAllocationManager(logger);
 * await manager.acquireLock(chain, opportunityId);
 * try {
 *   const nonce = await nonceManager.getNextNonce(chain);
 *   // use nonce...
 * } finally {
 *   manager.releaseLock(chain, opportunityId);
 * }
 * ```
 */
export class NonceAllocationManager {
  private readonly logger: Logger;
  private readonly defaultLockTimeoutMs: number;

  /**
   * Per-chain nonce locks to prevent concurrent nonce allocation.
   * Key: chain name
   * Value: Promise that resolves when the current lock holder releases
   */
  private readonly chainNonceLocks = new Map<string, Promise<void>>();
  private readonly chainNonceLockResolvers = new Map<string, () => void>();

  /**
   * Track in-progress nonce allocations per chain.
   * Used to detect potential race conditions when multiple strategies
   * attempt to allocate nonces for the same chain concurrently.
   * Key: chain name
   * Value: Set of opportunity IDs currently allocating nonces
   */
  private readonly inProgressNonceAllocations = new Map<string, Set<string>>();

  constructor(logger: Logger, config?: NonceAllocationManagerConfig) {
    this.logger = logger;
    this.defaultLockTimeoutMs = config?.defaultLockTimeoutMs ?? 10000;
  }

  /**
   * Acquire per-chain nonce lock.
   *
   * This ensures only one nonce allocation happens at a time per chain,
   * preventing the race condition in Issue #156.
   *
   * @param chain - Chain to acquire lock for
   * @param opportunityId - ID for logging
   * @param timeoutMs - Max time to wait for lock (default 10s)
   * @throws Error if timeout waiting for lock
   */
  async acquireLock(
    chain: string,
    opportunityId: string,
    timeoutMs?: number
  ): Promise<void> {
    const timeout = timeoutMs ?? this.defaultLockTimeoutMs;

    // FIX (Issue 1.4): Use absolute deadline to prevent timeout accumulation across retries
    // Without this, each retry gets full timeout (3 retries = 30s instead of 10s total)
    const deadline = Date.now() + timeout;

    // FIX 5.1: Retry loop to handle race when multiple waiters are released simultaneously
    // This prevents TOCTOU bug where multiple callers could create locks after waiting
    while (true) {
      const existingLock = this.chainNonceLocks.get(chain);

      if (existingLock) {
        // FIX (Issue 1.4): Calculate remaining time from absolute deadline
        const remainingTime = deadline - Date.now();
        if (remainingTime <= 0) {
          // Total timeout exceeded across all retries
          const error = new Error(`[ERR_NONCE_LOCK_TIMEOUT] Timeout waiting for nonce lock on ${chain}`);
          this.logger.warn('[WARN_NONCE_LOCK_TIMEOUT] Timeout waiting for nonce lock', {
            chain,
            opportunityId,
            totalTimeoutMs: timeout,
            retriesExhausted: 'Deadline exceeded',
          });
          throw error;
        }

        this.logger.debug('[NONCE_LOCK] Waiting for existing lock', {
          chain,
          opportunityId,
          remainingTimeMs: remainingTime,
        });

        // Wait for existing lock with remaining time until deadline
        // P1 FIX: Use cancellable timeout to prevent timer leak when lock resolves before timeout
        const { promise: timeoutPromise, cancel: cancelTimeout } = createCancellableTimeout<void>(
          remainingTime,
          `[ERR_NONCE_LOCK_TIMEOUT] Timeout waiting for nonce lock on ${chain}`
        );

        try {
          await Promise.race([existingLock, timeoutPromise]);
        } catch (error) {
          // If timeout, log and throw
          const elapsedTime = Date.now() - (deadline - timeout);
          this.logger.warn('[WARN_NONCE_LOCK_TIMEOUT] Timeout waiting for nonce lock', {
            chain,
            opportunityId,
            totalTimeoutMs: timeout,
            elapsedTimeMs: elapsedTime,
          });
          throw error;
        } finally {
          cancelTimeout();
        }

        // FIX 5.1: Re-check lock after wait completes
        // If another waiter already created a lock, wait again
        // This handles the race where multiple waiters complete simultaneously
        continue; // Re-check from top of loop (will use remaining time)
      }

      // FIX 5.1: No existing lock - atomically create new lock
      // Between checking (!existingLock) and creating lock, Node.js event loop
      // won't interleave other async operations, so this is safe
      let resolver: () => void;
      const lockPromise = new Promise<void>((resolve) => {
        resolver = resolve;
      });

      this.chainNonceLocks.set(chain, lockPromise);
      this.chainNonceLockResolvers.set(chain, resolver!);

      this.logger.debug('[NONCE_LOCK] Lock acquired', {
        chain,
        opportunityId,
        totalWaitTime: Date.now() - (deadline - timeout),
      });

      break; // Lock acquired successfully
    }
  }

  /**
   * Release per-chain nonce lock.
   *
   * @param chain - Chain to release lock for
   * @param opportunityId - ID for logging
   */
  releaseLock(chain: string, opportunityId: string): void {
    const resolver = this.chainNonceLockResolvers.get(chain);
    if (resolver) {
      resolver();
      this.chainNonceLocks.delete(chain);
      this.chainNonceLockResolvers.delete(chain);

      this.logger.debug('[NONCE_LOCK] Lock released', {
        chain,
        opportunityId,
      });
    }
  }

  /**
   * Check and warn if concurrent nonce access is detected.
   * Now deprecated in favor of acquireLock (Fix 3.1), but kept
   * for backward compatibility and additional logging.
   *
   * @param chain - Chain being accessed
   * @param opportunityId - ID of the opportunity requesting nonce
   * @returns true if concurrency was detected
   */
  checkConcurrentAccess(chain: string, opportunityId: string): boolean {
    let inProgress = this.inProgressNonceAllocations.get(chain);
    if (!inProgress) {
      inProgress = new Set();
      this.inProgressNonceAllocations.set(chain, inProgress);
    }

    const hadConcurrency = inProgress.size > 0;
    if (hadConcurrency) {
      // This should now rarely happen due to per-chain locking
      // If it does happen, it indicates a bug in the locking logic
      this.logger.warn('[WARN_RACE_CONDITION] Concurrent nonce access detected despite locking', {
        chain,
        opportunityId,
        concurrentOpportunities: Array.from(inProgress),
        warning: 'This indicates a potential bug in per-chain nonce locking.',
        tracking: 'https://github.com/arbitrage-system/arbitrage/issues/156',
      });
    }

    inProgress.add(opportunityId);
    return hadConcurrency;
  }

  /**
   * Clear in-progress nonce allocation tracking for an opportunity.
   *
   * @param chain - Chain being accessed
   * @param opportunityId - ID of the opportunity that finished
   */
  clearTracking(chain: string, opportunityId: string): void {
    const inProgress = this.inProgressNonceAllocations.get(chain);
    if (inProgress) {
      inProgress.delete(opportunityId);
      if (inProgress.size === 0) {
        this.inProgressNonceAllocations.delete(chain);
      }
    }
  }

  /**
   * Check if a chain currently has a lock held.
   *
   * @param chain - Chain to check
   * @returns true if lock is currently held
   */
  hasLock(chain: string): boolean {
    return this.chainNonceLocks.has(chain);
  }

  /**
   * Get the number of in-progress allocations for a chain.
   *
   * @param chain - Chain to check
   * @returns Number of in-progress allocations
   */
  getInProgressCount(chain: string): number {
    return this.inProgressNonceAllocations.get(chain)?.size ?? 0;
  }

  /**
   * Reset all locks and tracking (for testing).
   */
  reset(): void {
    // Release all locks
    for (const resolver of this.chainNonceLockResolvers.values()) {
      resolver();
    }
    this.chainNonceLocks.clear();
    this.chainNonceLockResolvers.clear();
    this.inProgressNonceAllocations.clear();
  }
}

// =============================================================================
// Module-level Singleton (for backward compatibility)
// =============================================================================

let _defaultManager: NonceAllocationManager | null = null;

/**
 * Get or create the default NonceAllocationManager instance.
 * Uses a lazy-initialized singleton for backward compatibility with
 * code that relied on module-level Maps.
 *
 * @param logger - Logger instance (required on first call)
 * @returns Default NonceAllocationManager instance
 */
export function getDefaultNonceAllocationManager(logger?: Logger): NonceAllocationManager {
  if (!_defaultManager) {
    if (!logger) {
      throw new Error('Logger required for first NonceAllocationManager initialization');
    }
    _defaultManager = new NonceAllocationManager(logger);
  }
  return _defaultManager;
}

/**
 * Reset the default singleton (for testing).
 */
export function resetDefaultNonceAllocationManager(): void {
  if (_defaultManager) {
    _defaultManager.reset();
    _defaultManager = null;
  }
}

// P2 FIX #13: Removed 4 deprecated standalone functions
// (acquireChainNonceLock, releaseChainNonceLock, checkConcurrentNonceAccess, clearNonceAllocationTracking)
// All had zero production callers — strategies use NonceAllocationManager instance methods directly.
