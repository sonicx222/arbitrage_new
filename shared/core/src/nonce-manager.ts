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
  /** Lock to prevent concurrent nonce allocation */
  lock: Promise<void> | null;
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
    this.chainStates.set(chain, {
      confirmedNonce: -1,
      pendingNonce: -1,
      lastSync: 0,
      pendingTxs: new Map(),
      lock: null
    });

    logger.info('Wallet registered for nonce management', {
      chain,
      address: wallet.address.slice(0, 10) + '...'
    });
  }

  /**
   * Get the next available nonce for a chain.
   * This is atomic and handles concurrent requests.
   */
  async getNextNonce(chain: string): Promise<number> {
    const state = this.chainStates.get(chain);
    if (!state) {
      throw new Error(`No wallet registered for chain: ${chain}`);
    }

    // Wait for any pending lock
    if (state.lock) {
      await state.lock;
    }

    // Create new lock
    let resolveLock: () => void;
    state.lock = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });

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
      // Release lock
      state.lock = null;
      resolveLock!();
    }
  }

  /**
   * Confirm a transaction was mined.
   */
  confirmTransaction(chain: string, nonce: number, hash: string): void {
    const state = this.chainStates.get(chain);
    if (!state) return;

    const tx = state.pendingTxs.get(nonce);
    if (tx) {
      tx.status = 'confirmed';
      tx.hash = hash;
      state.pendingTxs.delete(nonce);

      // Update confirmed nonce if this was the next expected
      if (nonce === state.confirmedNonce) {
        state.confirmedNonce = nonce + 1;
        // Clean up any sequential confirmed transactions
        this.advanceConfirmedNonce(chain);
      }

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
   */
  getState(chain: string): { confirmed: number; pending: number; pendingCount: number } | null {
    const state = this.chainStates.get(chain);
    if (!state) return null;

    return {
      confirmed: state.confirmedNonce,
      pending: state.pendingNonce,
      pendingCount: state.pendingTxs.size
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
// Singleton Instance
// =============================================================================

let nonceManagerInstance: NonceManager | null = null;

export function getNonceManager(config?: Partial<NonceManagerConfig>): NonceManager {
  if (!nonceManagerInstance) {
    nonceManagerInstance = new NonceManager(config);
  }
  return nonceManagerInstance;
}

export function resetNonceManager(): void {
  if (nonceManagerInstance) {
    nonceManagerInstance.stop();
    nonceManagerInstance = null;
  }
}
