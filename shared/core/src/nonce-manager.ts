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
import { clearIntervalSafe } from './async/lifecycle-utils';
import { getErrorMessage } from './resilience/error-handling';
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
  /**
   * FIX 12: Maintained counter of transactions with status === 'pending'.
   * Avoids O(n) iteration in getState() by incrementing/decrementing on state changes.
   */
  pendingStatusCount: number;
  /**
   * Pool generation counter. Incremented each time the nonce pool is cleared
   * (failTransaction, cleanupTimedOut, resetChain). A replenishNoncePool() call
   * that started before a pool clear should abort if the generation changed.
   */
  poolGeneration: number;
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
    this.registerSigner(chain, wallet.address, wallet.provider!);
  }

  /**
   * Register any signer (Wallet, KMS, or AbstractSigner) for a specific chain.
   *
   * This is the generalized registration method that accepts an address and provider
   * directly, making it compatible with any signer type (ethers.Wallet, KmsSigner,
   * or any AbstractSigner subclass).
   *
   * @param chain - Chain identifier (e.g., 'ethereum', 'bsc')
   * @param address - Signer's address (checksummed)
   * @param provider - JSON-RPC provider for nonce queries
   *
   * @see Phase 2 Item #18: NonceManager for KMS signers
   */
  registerSigner(chain: string, address: string, provider: ethers.Provider): void {
    this.providers.set(chain, provider);
    this.walletAddresses.set(chain, address);

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
      pendingStatusCount: 0,
      poolGeneration: 0,
    });

    logger.info('Signer registered for nonce management', {
      chain,
      address: address.slice(0, 10) + '...'
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
    // Lock is acquired BEFORE shift() to prevent nonce ordering issues:
    // Without lock, concurrent callers could shift() nonces out of order, and
    // unshift() on max-pending rejection would insert a nonce before already-allocated
    // later nonces, causing "nonce too low" errors on submission.
    if (this.config.preAllocationPoolSize > 0 && state.noncePool.length > 0) {
      await this.acquireLock(state);
      try {
        // Re-check under lock (pool may have been drained by another caller)
        if (state.noncePool.length > 0) {
          const pooledNonce = state.noncePool.shift()!;

          // Check max pending limit
          if (state.pendingTxs.size >= this.config.maxPendingPerChain) {
            // Put nonce back in pool and throw — safe because we hold the lock
            state.noncePool.unshift(pooledNonce);
            throw new Error(`Max pending transactions (${this.config.maxPendingPerChain}) reached for ${chain}`);
          }

          state.pendingTxs.set(pooledNonce, {
            nonce: pooledNonce,
            timestamp: Date.now(),
            status: 'pending'
          });
          state.pendingStatusCount++;

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
        }
        // Pool drained by another caller — fall through to standard path
      } finally {
        this.releaseLock(state);
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
      state.pendingStatusCount++;

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
    const generationAtStart = state.poolGeneration;

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
        // Abort if pool was cleared while we waited for the lock
        if (state.poolGeneration !== generationAtStart) {
          logger.debug('Nonce pool replenishment aborted: pool generation changed', { chain, startGen: generationAtStart, currentGen: state.poolGeneration });
          return;
        }

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
        error: getErrorMessage(error)
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
      // FIX 12: Decrement pending counter when transitioning from 'pending'
      if (tx.status === 'pending') {
        state.pendingStatusCount--;
        if (state.pendingStatusCount < 0) {
          logger.warn('pendingStatusCount went negative in confirmTransaction, resetting to 0', { chain, nonce, count: state.pendingStatusCount });
          state.pendingStatusCount = 0;
        }
      }
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
      // FIX 12: Decrement pending counter when transitioning from 'pending'
      if (tx.status === 'pending') {
        state.pendingStatusCount--;
        if (state.pendingStatusCount < 0) {
          logger.warn('pendingStatusCount went negative in failTransaction, resetting to 0', { chain, nonce, count: state.pendingStatusCount });
          state.pendingStatusCount = 0;
        }
      }
      tx.status = 'failed';
      state.pendingTxs.delete(nonce);

      logger.warn('Transaction failed', { chain, nonce, error });

      // If this was the lowest pending nonce, we need to reset
      // because the network won't accept higher nonces until this one is used
      // FIX 13: Replace Math.min(...Array.from()) with a simple for-of loop
      // to avoid temporary array allocation
      let lowestPending = Infinity;
      for (const key of state.pendingTxs.keys()) {
        if (key < lowestPending) {
          lowestPending = key;
        }
      }
      if (nonce < lowestPending || state.pendingTxs.size === 0) {
        // Reset to network state on next allocation
        state.confirmedNonce = -1;
        state.pendingNonce = -1;
        // Fix R5: Clear stale nonce pool — pre-allocated nonces are based on the
        // old pendingNonce value and would cause "nonce too low" errors after reset.
        state.noncePool = [];
        state.isReplenishing = false;
        state.poolGeneration++;
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
    state.poolGeneration++;
    // FIX 12: Reset pending counter
    state.pendingStatusCount = 0;

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

    // FIX 12: Use maintained counter instead of O(n) iteration
    return {
      confirmed: state.confirmedNonce,
      pending: state.pendingNonce,
      pendingCount: state.pendingStatusCount,
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
    this.syncInterval = clearIntervalSafe(this.syncInterval);

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
        // FIX 12: Decrement pending counter for pending txs being cleaned up
        const timedOutTx = state.pendingTxs.get(nonce);
        if (timedOutTx?.status === 'pending') {
          state.pendingStatusCount--;
          if (state.pendingStatusCount < 0) {
            logger.warn('pendingStatusCount went negative in cleanupTimedOutTransactions, resetting to 0', { chain, nonce, count: state.pendingStatusCount });
            state.pendingStatusCount = 0;
          }
        }
        state.pendingTxs.delete(nonce);
      }

      // Reset state to sync fresh from network
      state.confirmedNonce = -1;
      state.pendingNonce = -1;
      // Fix: Clear stale nonce pool — pre-allocated nonces are based on the
      // old pendingNonce value and would cause "nonce too low" errors after reset.
      // Matches failTransaction() (line 477-478) and resetChain() (line 496-497).
      state.noncePool = [];
      state.isReplenishing = false;
      state.poolGeneration++;
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

/** PERF-008 FIX: Shallow comparison for flat config objects (avoids JSON.stringify) */
function shallowConfigEquals(
  a: Partial<NonceManagerConfig> | undefined,
  b: Partial<NonceManagerConfig> | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keysA = Object.keys(a) as Array<keyof NonceManagerConfig>;
  const keysB = Object.keys(b) as Array<keyof NonceManagerConfig>;
  if (keysA.length !== keysB.length) return false;
  return keysA.every(k => a[k] === b[k]);
}

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
    // PERF-008 FIX: Shallow key comparison instead of JSON.stringify (avoids 3x traversal)
    const configChanged = shallowConfigEquals(config, nonceManagerInitialConfig) === false;
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
