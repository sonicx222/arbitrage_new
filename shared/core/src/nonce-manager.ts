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
}

export interface NonceManagerConfig {
  /** How often to sync with network (ms). Default: 30000 (30s) */
  syncIntervalMs: number;
  /** Max time to wait for confirmation before reset (ms). Default: 300000 (5min) */
  pendingTimeoutMs: number;
  /** Max pending transactions per chain. Default: 10 */
  maxPendingPerChain: number;
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: NonceManagerConfig = {
  syncIntervalMs: 30000,
  pendingTimeoutMs: 300000,
  maxPendingPerChain: 10
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
    this.chainStates.set(chain, {
      confirmedNonce: -1,
      pendingNonce: -1,
      lastSync: 0,
      pendingTxs: new Map(),
      lockQueue: [],
      isLocked: false
    });

    logger.info('Wallet registered for nonce management', {
      chain,
      address: wallet.address.slice(0, 10) + '...'
    });
  }

  /**
   * Get the next available nonce for a chain.
   * This is atomic and handles concurrent requests.
   *
   * P0-FIX-2: Uses queue-based mutex to prevent race conditions.
   * The previous implementation had a TOCTOU race where multiple callers
   * could pass the lock check before any of them set the lock.
   */
  async getNextNonce(chain: string): Promise<number> {
    const state = this.chainStates.get(chain);
    if (!state) {
      throw new Error(`No wallet registered for chain: ${chain}`);
    }

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

      logger.debug('Nonce allocated', { chain, nonce, pending: state.pendingTxs.size });

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

    await this.syncNonce(chain);

    logger.info('Chain nonce state reset', { chain, newNonce: state.confirmedNonce });
  }

  /**
   * Get current state for monitoring.
   *
   * P0-FIX-1: pendingCount now only counts transactions with status='pending',
   * not confirmed ones that are waiting for lower nonces to advance.
   */
  getState(chain: string): { confirmed: number; pending: number; pendingCount: number } | null {
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
      pendingCount: pendingStatusCount
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
let nonceManagerInitPromise: Promise<NonceManager> | null = null;

/**
 * CRITICAL-4 FIX: Thread-safe singleton with Promise-based initialization.
 * Prevents TOCTOU race condition where multiple callers could create
 * multiple instances due to async gaps between null check and assignment.
 *
 * Pattern: First caller creates the Promise, all subsequent callers
 * await the same Promise until it resolves.
 */
export function getNonceManager(config?: Partial<NonceManagerConfig>): NonceManager {
  // Fast path: instance already exists
  if (nonceManagerInstance) {
    return nonceManagerInstance;
  }

  // Slow path: create instance synchronously to avoid async race
  // This is safe because NonceManager constructor is synchronous
  nonceManagerInstance = new NonceManager(config);
  return nonceManagerInstance;
}

/**
 * Async version for cases where initialization needs to be awaited.
 * Ensures only one instance is ever created, even under concurrent calls.
 */
export async function getNonceManagerAsync(config?: Partial<NonceManagerConfig>): Promise<NonceManager> {
  // Fast path: instance already exists
  if (nonceManagerInstance) {
    return nonceManagerInstance;
  }

  // Check if initialization is already in progress
  if (nonceManagerInitPromise) {
    return nonceManagerInitPromise;
  }

  // Start initialization - capture the Promise immediately to prevent races
  nonceManagerInitPromise = (async () => {
    // Double-check after acquiring the "lock"
    if (nonceManagerInstance) {
      return nonceManagerInstance;
    }

    const instance = new NonceManager(config);
    nonceManagerInstance = instance;
    return instance;
  })();

  try {
    return await nonceManagerInitPromise;
  } finally {
    // Clear the init promise after completion
    nonceManagerInitPromise = null;
  }
}

export function resetNonceManager(): void {
  if (nonceManagerInstance) {
    nonceManagerInstance.stop();
    nonceManagerInstance = null;
  }
  nonceManagerInitPromise = null;
}
