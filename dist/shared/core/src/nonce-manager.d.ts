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
export interface NonceManagerConfig {
    /** How often to sync with network (ms). Default: 30000 (30s) */
    syncIntervalMs: number;
    /** Max time to wait for confirmation before reset (ms). Default: 300000 (5min) */
    pendingTimeoutMs: number;
    /** Max pending transactions per chain. Default: 10 */
    maxPendingPerChain: number;
}
export declare class NonceManager {
    private config;
    private chainStates;
    private providers;
    private walletAddresses;
    private syncInterval;
    constructor(config?: Partial<NonceManagerConfig>);
    /**
     * Register a wallet for a specific chain.
     */
    registerWallet(chain: string, wallet: ethers.Wallet): void;
    /**
     * Get the next available nonce for a chain.
     * This is atomic and handles concurrent requests.
     *
     * P0-FIX-2: Uses queue-based mutex to prevent race conditions.
     * The previous implementation had a TOCTOU race where multiple callers
     * could pass the lock check before any of them set the lock.
     */
    getNextNonce(chain: string): Promise<number>;
    /**
     * P0-FIX-2: Acquire lock using queue-based mutex.
     * Guarantees mutual exclusion even under concurrent access.
     */
    private acquireLock;
    /**
     * P0-FIX-2: Release lock and wake up next waiter.
     */
    private releaseLock;
    /**
     * Confirm a transaction was mined.
     *
     * P0-FIX-1: Fixed out-of-order confirmation handling.
     * Previously, transactions were deleted from pendingTxs before advanceConfirmedNonce
     * could process them, causing out-of-order confirmations to not cascade properly.
     * Now we keep confirmed transactions in pendingTxs (with status='confirmed') until
     * advanceConfirmedNonce processes and removes them in sequence.
     */
    confirmTransaction(chain: string, nonce: number, hash: string): void;
    /**
     * Mark a transaction as failed (will not be mined).
     */
    failTransaction(chain: string, nonce: number, error: string): void;
    /**
     * Reset nonce state for a chain (call after stuck transactions).
     */
    resetChain(chain: string): Promise<void>;
    /**
     * Get current state for monitoring.
     *
     * P0-FIX-1: pendingCount now only counts transactions with status='pending',
     * not confirmed ones that are waiting for lower nonces to advance.
     */
    getState(chain: string): {
        confirmed: number;
        pending: number;
        pendingCount: number;
    } | null;
    /**
     * Start background sync.
     */
    start(): void;
    /**
     * Stop background sync.
     */
    stop(): void;
    private syncNonce;
    private syncAllChains;
    private cleanupTimedOutTransactions;
    private advanceConfirmedNonce;
}
/**
 * CRITICAL-4 FIX: Thread-safe singleton with Promise-based initialization.
 * Prevents TOCTOU race condition where multiple callers could create
 * multiple instances due to async gaps between null check and assignment.
 *
 * Pattern: First caller creates the Promise, all subsequent callers
 * await the same Promise until it resolves.
 */
export declare function getNonceManager(config?: Partial<NonceManagerConfig>): NonceManager;
/**
 * Async version for cases where initialization needs to be awaited.
 * Ensures only one instance is ever created, even under concurrent calls.
 */
export declare function getNonceManagerAsync(config?: Partial<NonceManagerConfig>): Promise<NonceManager>;
export declare function resetNonceManager(): void;
//# sourceMappingURL=nonce-manager.d.ts.map