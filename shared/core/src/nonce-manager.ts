/**
 * Nonce Manager
 *
 * P0-2 FIX: Manages transaction nonces to prevent collisions in high-throughput scenarios.
 *
 * Problem: When sending multiple transactions in quick succession, the default
 * behavior of fetching the nonce from the network can lead to:
 * - Nonce collisions (two transactions with same nonce)
 * - Transaction replacement/cancellation
 * - Stuck transactions
 *
 * Solution: Track pending nonces locally and increment atomically.
 *
 * @see ADR-008: Execution Engine Design
 */

import { ethers } from 'ethers';
import { createLogger } from './logger';

const logger = createLogger('nonce-manager');

// =============================================================================
// Types
// =============================================================================

interface PendingTransaction {
  nonce: number;
  hash?: string;
  timestamp: number;
  status: 'pending' | 'confirmed' | 'failed';
}

interface ChainNonceState {
  /** Current nonce from network (confirmed transactions) */
  confirmedNonce: number;
  /** Next nonce to use (may be ahead of confirmed if transactions pending) */
  pendingNonce: number;
  /** Last time we synced with network */
  lastSync: number;
  /** Pending transactions awaiting confirmation */
  pendingTxs: Map<number, PendingTransaction>;
  /**
   * P0-FIX-2: Queue-based mutex to prevent concurrent nonce allocation race.
   * Previous implementation had a TOCTOU race between checking and setting the lock.
   * Now uses a queue where each caller waits for all previous callers to complete.
   */
  lockQueue: Array<() => void>;
  /** Whether the lock is currently held */
  isLocked: boolean;
  /**
   * Tier 2 Enhancement: Pre-allocated nonce pool for burst submissions.
   * Array of pre-fetched nonces ready for instant allocation.
   * Reduces lock contention and eliminates network latency during bursts.
   */
  noncePool: number[];
  /** Whether a pool replenishment is in progress */
  isReplenishing: boolean;
}

export interface NonceManagerConfig {
  /** How often to sync with network (ms). Default: 30000 (30s) */
  syncIntervalMs: number;
  /** Max time to wait for confirmation before reset (ms). Default: 300000 (5min) */
  pendingTimeoutMs: number;
  /** Max pending transactions per chain. Default: 10 */
  maxPendingPerChain: number;
  /**
   * Tier 2 Enhancement: Pre-allocation pool size per chain.
   * Pre-fetches N nonces ahead of time for instant burst submissions.
   * Set to 0 to disable pre-allocation (default behavior).
   * Default: 5 (provides 5 instant nonces per chain before needing network sync)
   */
  preAllocationPoolSize: number;
  /**
   * Tier 2 Enhancement: Auto-replenish threshold.
   * When pool drops to this size, trigger background replenishment.
   * Default: 2 (replenish when only 2 nonces remain in pool)
   */
  poolReplenishThreshold: number;
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: NonceManagerConfig = {
  syncIntervalMs: 30000,
  pendingTimeoutMs: 300000,
  maxPendingPerChain: 10,
  // Tier 2 Enhancement: Pre-allocation pool for burst submissions
  preAllocationPoolSize: 5,
  poolReplenishThreshold: 2,
};

// =============================================================================
// NonceManager Implementation
// =============================================================================

export class NonceManager {
  private config: NonceManagerConfig;
  private chainStates: Map<string, ChainNonceState> = new Map();
  private providers: Map<string, ethers.Provider> = new Map();
  private walletAddresses: Map<string, string> = new Map();
  private syncInterval: NodeJS.Timeout | null = null;

  constructor(config: Partial<NonceManagerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Register a wallet for a specific chain.
   */
  registerWallet(chain: string, wallet: ethers.Wallet): void {
    this.providers.set(chain, wallet.provider!);
    this.walletAddresses.set(chain, wallet.address);

    // Initialize chain state
    // P0-FIX-2: Use queue-based mutex instead of simple lock
    // Tier 2: Initialize empty nonce pool
    this.chainStates.set(chain, {
      confirmedNonce: -1,
      pendingNonce: -1,
      lastSync: 0,
      pendingTxs: new Map(),
      lockQueue: [],
      isLocked: false,
      noncePool: [],
      isReplenishing: false,
    });

    logger.info('Wallet registered for nonce management', {
      chain,
      address: wallet.address.slice(0, 10) + '...'
    });

    // Tier 2: Pre-fill nonce pool if enabled
    if (this.config.preAllocationPoolSize > 0) {
      this.replenishNoncePool(chain).catch(error => {
        logger.warn('Failed to pre-fill nonce pool on registration', { chain, error });
      });
    }
  }

  /**
   * Get the next available nonce for a chain.
   * This is atomic and handles concurrent requests.
   *
   * P0-FIX-2: Uses queue-based mutex to prevent race conditions.
   * The previous implementation had a TOCTOU race where multiple callers
   * could pass the lock check before any of them set the lock.
   *
   * Tier 2 Enhancement: Uses pre-allocated nonce pool for instant allocation
   * during bursts, reducing lock contention and network latency.
   */
  async getNextNonce(chain: string): Promise<number> {
    const state = this.chainStates.get(chain);
    if (!state) {
      throw new Error(`No wallet registered for chain: ${chain}`);
    }

    // Tier 2: Try to get nonce from pre-allocated pool first (fast path)
    // NOTE: The length check and shift() are NOT atomic across async boundaries.
    // Two concurrent callers could both see length > 0, both call shift(), and one gets undefined.
    // This is INTENTIONAL - undefined result safely falls through to standard lock path below.
    // The trade-off is: occasional fallback vs. always acquiring lock on pool access.
    if (this.config.preAllocationPoolSize > 0 && state.noncePool.length > 0) {
      const pooledNonce = state.noncePool.shift();
      if (pooledNonce !== undefined) {
        // Track pending transaction (still need lock for pendingTxs)
        await this.acquireLock(state);
        try {
          // Check max pending limit
          if (state.pendingTxs.size >= this.config.maxPendingPerChain) {
            // Put nonce back in pool and throw
            state.noncePool.unshift(pooledNonce);
            throw new Error(`Max pending transactions (${this.config.maxPendingPerChain}) reached for ${chain}`);
          }

          state.pendingTxs.set(pooledNonce, {
            nonce: pooledNonce,
            timestamp: Date.now(),
            status: 'pending'
          });

          logger.debug('Nonce allocated from pool', {
            chain,
            nonce: pooledNonce,
            pending: state.pendingTxs.size,
            poolRemaining: state.noncePool.length
          });

          // Trigger background replenishment if pool is low
          if (state.noncePool.length <= this.config.poolReplenishThreshold && !state.isReplenishing) {
            this.replenishNoncePool(chain).catch(error => {
              logger.warn('Failed to replenish nonce pool', { chain, error });
            });
          }

          return pooledNonce;
        } finally {
          this.releaseLock(state);
        }
      }
    }

    // Standard path: Pool empty or disabled, allocate from pendingNonce
    // P0-FIX-2: Acquire lock using queue-based mutex
    await this.acquireLock(state);

    try {
      // Sync if needed
      if (state.confirmedNonce === -1 || Date.now() - state.lastSync > this.config.syncIntervalMs) {
        await this.syncNonce(chain);
      }

      // Check for timed out pending transactions
      this.cleanupTimedOutTransactions(chain);

      // Check max pending limit
      if (state.pendingTxs.size >= this.config.maxPendingPerChain) {
        throw new Error(`Max pending transactions (${this.config.maxPendingPerChain}) reached for ${chain}`);
      }

      // Get next nonce
      const nonce = state.pendingNonce;
      state.pendingNonce++;

      // Track pending transaction
      state.pendingTxs.set(nonce, {
        nonce,
        timestamp: Date.now(),
        status: 'pending'
      });

      logger.debug('Nonce allocated (direct)', { chain, nonce, pending: state.pendingTxs.size });

      return nonce;
    } finally {
      // P0-FIX-2: Release lock
      this.releaseLock(state);
    }
  }

  /**
   * P0-FIX-2: Acquire lock using queue-based mutex.
   * Guarantees mutual exclusion even under concurrent access.
   *
   * P0-FIX-3: Fixed TOCTOU race condition in lock acquisition.
   * Previous implementation had a race where two concurrent callers could both
   * pass the `!state.isLocked` check before either set `isLocked = true`.
   *
   * New implementation: Always queue, process synchronously.
   * The first caller to queue triggers immediate resolution if lock is free.
   */
  private acquireLock(state: ChainNonceState): Promise<void> {
    return new Promise<void>((resolve) => {
      // Always add to queue first (atomic operation)
      state.lockQueue.push(resolve);

      // If we're the only one in queue and lock is free, acquire immediately
      // This check is safe because JS is single-threaded - by the time we check,
      // our resolve is already in the queue, so no one else can "steal" the lock
      if (state.lockQueue.length === 1 && !state.isLocked) {
        state.isLocked = true;
        // Resolve synchronously - we're first and lock is ours
        state.lockQueue.shift();
        resolve();
      }
      // Otherwise, releaseLock will wake us up when it's our turn
    });
  }

  /**
   * P0-FIX-2: Release lock and wake up next waiter.
   */
  private releaseLock(state: ChainNonceState): void {
    // Wake up next waiter if any
    const nextWaiter = state.lockQueue.shift();
    if (nextWaiter) {
      // Hand off lock directly to next waiter (lock stays held)
      // Use setImmediate to prevent stack overflow with many waiters
      setImmediate(() => nextWaiter());
    } else {
      // No waiters, release the lock
      state.isLocked = false;
    }
  }

  /**
   * Tier 2 Enhancement: Replenish the nonce pre-allocation pool.
   *
   * Called automatically when:
   * - Wallet is registered (initial fill)
   * - Pool drops to replenishThreshold during getNextNonce()
   *
   * @param chain - Chain to replenish pool for
   */
  private async replenishNoncePool(chain: string): Promise<void> {
    const state = this.chainStates.get(chain);
    if (!state || state.isReplenishing) return;

    // Prevent concurrent replenishment
    state.isReplenishing = true;

    try {
      // Calculate how many nonces to pre-allocate
      const targetSize = this.config.preAllocationPoolSize;
      const currentSize = state.noncePool.length;
      const needed = targetSize - currentSize;

      if (needed <= 0) {
        return; // Pool is already at target size
      }

      // Acquire lock to safely read/update pendingNonce
      await this.acquireLock(state);

      try {
        // Ensure we have a valid base nonce
        if (state.confirmedNonce === -1 || Date.now() - state.lastSync > this.config.syncIntervalMs) {
          await this.syncNonce(chain);
        }

        // Allocate nonces for the pool (don't track as pending - they're reserved)
        const newNonces: number[] = [];
        for (let i = 0; i < needed; i++) {
          newNonces.push(state.pendingNonce);
          state.pendingNonce++;
        }

        // Add to pool
        state.noncePool.push(...newNonces);

        logger.info('Nonce pool replenished', {
          chain,
          added: needed,
          poolSize: state.noncePool.length,
          nextNonce: state.pendingNonce
        });
      } finally {
        this.releaseLock(state);
      }
    } catch (error) {
      logger.error('Failed to replenish nonce pool', {
        chain,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      state.isReplenishing = false;
    }
  }

  /**
   * Tier 2 Enhancement: Get current pool status for monitoring.
   *
   * @param chain - Chain to check
   * @returns Pool status or null if chain not registered
   */
  getPoolStatus(chain: string): { poolSize: number; isReplenishing: boolean } | null {
    const state = this.chainStates.get(chain);
    if (!state) return null;

    return {
      poolSize: state.noncePool.length,
      isReplenishing: state.isReplenishing
    };
  }

  /**
   * Tier 2 Enhancement: Manually trigger pool replenishment.
   * Useful for pre-warming before expected burst activity.
   *
   * @param chain - Chain to replenish
   */
  async warmPool(chain: string): Promise<void> {
    return this.replenishNoncePool(chain);
  }

  /**
   * Confirm a transaction was mined.
   *
   * P0-FIX-1: Fixed out-of-order confirmation handling.
   * Previously, transactions were deleted from pendingTxs before advanceConfirmedNonce
   * could process them, causing out-of-order confirmations to not cascade properly.
   * Now we keep confirmed transactions in pendingTxs (with status='confirmed') until
   * advanceConfirmedNonce processes and removes them in sequence.
   */
  confirmTransaction(chain: string, nonce: number, hash: string): void {
    const state = this.chainStates.get(chain);
    if (!state) return;

    const tx = state.pendingTxs.get(nonce);
    if (tx) {
      tx.status = 'confirmed';
      tx.hash = hash;

      // P0-FIX-1: Only delete and advance if this is the next expected nonce.
      // If it's a higher nonce (out-of-order), keep it in pendingTxs as 'confirmed'
      // so advanceConfirmedNonce can clean it up when lower nonces confirm.
      if (nonce === state.confirmedNonce) {
        state.pendingTxs.delete(nonce);
        state.confirmedNonce = nonce + 1;
        // Clean up any sequential confirmed transactions that were waiting
        this.advanceConfirmedNonce(chain);
      }
      // If nonce > confirmedNonce, leave it in pendingTxs with status='confirmed'
      // It will be cleaned up when advanceConfirmedNonce eventually reaches it

      logger.debug('Transaction confirmed', { chain, nonce, hash: hash.slice(0, 10) + '...' });
    }
  }

  /**
   * Mark a transaction as failed (will not be mined).
   */
  failTransaction(chain: string, nonce: number, error: string): void {
    const state = this.chainStates.get(chain);
    if (!state) return;

    const tx = state.pendingTxs.get(nonce);
    if (tx) {
      tx.status = 'failed';
      state.pendingTxs.delete(nonce);

      logger.warn('Transaction failed', { chain, nonce, error });

      // If this was the lowest pending nonce, we need to reset
      // because the network won't accept higher nonces until this one is used
      const lowestPending = Math.min(...Array.from(state.pendingTxs.keys()));
      if (nonce < lowestPending || state.pendingTxs.size === 0) {
        // Reset to network state on next allocation
        state.confirmedNonce = -1;
        state.pendingNonce = -1;
        logger.info('Nonce state reset due to failed transaction', { chain, nonce });
      }
    }
  }

  /**
   * Reset nonce state for a chain (call after stuck transactions).
   */
  async resetChain(chain: string): Promise<void> {
    const state = this.chainStates.get(chain);
    if (!state) return;

    state.pendingTxs.clear();
    state.confirmedNonce = -1;
    state.pendingNonce = -1;
    state.lastSync = 0;
    // Tier 2: Clear pool on reset
    state.noncePool = [];
    state.isReplenishing = false;

    await this.syncNonce(chain);

    // Tier 2: Replenish pool after reset if enabled
    if (this.config.preAllocationPoolSize > 0) {
      await this.replenishNoncePool(chain);
    }

    logger.info('Chain nonce state reset', { chain, newNonce: state.confirmedNonce });
  }

  /**
   * Get current state for monitoring.
   *
   * P0-FIX-1: pendingCount now only counts transactions with status='pending',
   * not confirmed ones that are waiting for lower nonces to advance.
   *
   * Tier 2: Now includes pool status for monitoring burst readiness.
   */
  getState(chain: string): {
    confirmed: number;
    pending: number;
    pendingCount: number;
    poolSize: number;
    isReplenishing: boolean;
  } | null {
    const state = this.chainStates.get(chain);
    if (!state) return null;

    // P0-FIX-1: Count only transactions with 'pending' status
    let pendingStatusCount = 0;
    for (const tx of state.pendingTxs.values()) {
      if (tx.status === 'pending') {
        pendingStatusCount++;
      }
    }

    return {
      confirmed: state.confirmedNonce,
      pending: state.pendingNonce,
      pendingCount: pendingStatusCount,
      // Tier 2: Pool status
      poolSize: state.noncePool.length,
      isReplenishing: state.isReplenishing
    };
  }

  /**
   * Start background sync.
   */
  start(): void {
    if (this.syncInterval) return;

    this.syncInterval = setInterval(() => {
      this.syncAllChains().catch(error => {
        logger.error('Background sync failed', { error });
      });
    }, this.config.syncIntervalMs);

    logger.info('NonceManager started');
  }

  /**
   * Stop background sync.
   */
  stop(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }

    logger.info('NonceManager stopped');
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private async syncNonce(chain: string): Promise<void> {
    const state = this.chainStates.get(chain);
    const provider = this.providers.get(chain);
    const address = this.walletAddresses.get(chain);

    if (!state || !provider || !address) return;

    try {
      const networkNonce = await provider.getTransactionCount(address, 'pending');

      state.confirmedNonce = networkNonce;
      state.pendingNonce = Math.max(state.pendingNonce, networkNonce);
      state.lastSync = Date.now();

      logger.debug('Nonce synced', { chain, nonce: networkNonce });
    } catch (error) {
      logger.error('Failed to sync nonce', { chain, error });
    }
  }

  private async syncAllChains(): Promise<void> {
    const chains = Array.from(this.chainStates.keys());
    await Promise.all(chains.map(chain => this.syncNonce(chain)));
  }

  private cleanupTimedOutTransactions(chain: string): void {
    const state = this.chainStates.get(chain);
    if (!state) return;

    const now = Date.now();
    const timedOut: number[] = [];

    for (const [nonce, tx] of state.pendingTxs) {
      if (now - tx.timestamp > this.config.pendingTimeoutMs) {
        timedOut.push(nonce);
      }
    }

    if (timedOut.length > 0) {
      logger.warn('Cleaning up timed out transactions', { chain, count: timedOut.length });

      for (const nonce of timedOut) {
        state.pendingTxs.delete(nonce);
      }

      // Reset state to sync fresh from network
      state.confirmedNonce = -1;
      state.pendingNonce = -1;
    }
  }

  private advanceConfirmedNonce(chain: string): void {
    const state = this.chainStates.get(chain);
    if (!state) return;

    // Find sequential confirmed nonces and advance
    while (state.pendingTxs.has(state.confirmedNonce)) {
      const tx = state.pendingTxs.get(state.confirmedNonce);
      if (tx?.status === 'confirmed') {
        state.pendingTxs.delete(state.confirmedNonce);
        state.confirmedNonce++;
      } else {
        break;
      }
    }
  }
}

// =============================================================================
// Singleton Instance (CRITICAL-4 FIX: Race-safe initialization)
// =============================================================================

let nonceManagerInstance: NonceManager | null = null;
let nonceManagerInitialConfig: Partial<NonceManagerConfig> | undefined = undefined;

/**
 * Get the singleton NonceManager instance.
 *
 * FIX 1.1: Configuration is only applied on first initialization.
 * Subsequent calls with different config will log a warning.
 *
 * FIX 1.2: Removed unnecessary async version since constructor is synchronous.
 * The previous getNonceManagerAsync added complexity without benefit.
 *
 * @param config - Optional configuration (only used on first call)
 * @returns The singleton NonceManager instance
 */
export function getNonceManager(config?: Partial<NonceManagerConfig>): NonceManager {
  if (!nonceManagerInstance) {
    nonceManagerInstance = new NonceManager(config);
    nonceManagerInitialConfig = config;
  } else if (config !== undefined) {
    // FIX 1.1: Warn if different config provided after initialization
    const configChanged = JSON.stringify(config) !== JSON.stringify(nonceManagerInitialConfig);
    if (configChanged) {
      logger.warn('getNonceManager called with different config after initialization. Config ignored.', {
        initialConfig: nonceManagerInitialConfig,
        ignoredConfig: config
      });
    }
  }
  return nonceManagerInstance;
}

/**
 * @deprecated Use getNonceManager() instead - the sync version is sufficient.
 *
 * This async wrapper exists only for backward compatibility and will be removed
 * in the next major version. The constructor is synchronous, so there's no
 * benefit to the async version.
 *
 * Migration: Replace `await getNonceManagerAsync()` with `getNonceManager()`
 *
 * @param config - Optional configuration (only used on first call)
 * @returns Promise resolving to the singleton NonceManager instance
 */
let deprecationWarningLastShown = 0;
const DEPRECATION_WARNING_THROTTLE_MS = 60000; // 1 minute between warnings
export async function getNonceManagerAsync(
  config?: Partial<NonceManagerConfig>
): Promise<NonceManager> {
  const now = Date.now();
  // Show warning: always in development, throttled in production
  const shouldWarn =
    process.env.NODE_ENV !== 'production' ||
    now - deprecationWarningLastShown > DEPRECATION_WARNING_THROTTLE_MS;

  if (shouldWarn) {
    deprecationWarningLastShown = now;
    logger.warn(
      'getNonceManagerAsync is deprecated. Use getNonceManager() instead. ' +
      'This function will be removed in the next major version.'
    );
  }
  return getNonceManager(config);
}

export function resetNonceManager(): void {
  if (nonceManagerInstance) {
    nonceManagerInstance.stop();
    nonceManagerInstance = null;
  }
  nonceManagerInitialConfig = undefined;
}
