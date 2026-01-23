/**
 * Nonce Manager Unit Tests
 *
 * P0-2 Regression Tests: Validates atomic nonce allocation to prevent
 * transaction collisions in high-throughput scenarios.
 *
 * @migrated from shared/core/src/nonce-manager.test.ts
 * @see ADR-009: Test Architecture
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { NonceManager, getNonceManager, resetNonceManager } from '@arbitrage/core';
import { ethers } from 'ethers';

// =============================================================================
// Mock Provider
// =============================================================================

class MockProvider {
  private nonce = 0;

  async getTransactionCount(_address: string, _blockTag?: string): Promise<number> {
    return this.nonce;
  }

  setNonce(nonce: number): void {
    this.nonce = nonce;
  }
}

// =============================================================================
// Mock Wallet
// =============================================================================

function createMockWallet(address: string, provider: MockProvider): ethers.Wallet {
  // Create a mock wallet with a valid private key for testing
  const privateKey = '0x' + '1'.repeat(64);
  const wallet = new ethers.Wallet(privateKey);

  // Override address getter
  Object.defineProperty(wallet, 'address', {
    get: () => address,
    configurable: true
  });

  // Override provider getter
  Object.defineProperty(wallet, 'provider', {
    get: () => provider as unknown as ethers.Provider,
    configurable: true
  });

  return wallet;
}

// =============================================================================
// Tests
// =============================================================================

describe('P0-2: NonceManager', () => {
  let nonceManager: NonceManager;
  let mockProvider: MockProvider;
  let mockWallet: ethers.Wallet;

  beforeEach(() => {
    // Reset singleton
    resetNonceManager();

    nonceManager = new NonceManager({
      syncIntervalMs: 60000, // Long interval for tests
      pendingTimeoutMs: 5000,
      maxPendingPerChain: 5
    });

    mockProvider = new MockProvider();
    mockWallet = createMockWallet('0x1234567890123456789012345678901234567890', mockProvider);

    nonceManager.registerWallet('ethereum', mockWallet);
  });

  afterEach(() => {
    nonceManager.stop();
  });

  describe('Basic Nonce Allocation', () => {
    it('should allocate sequential nonces', async () => {
      const nonce1 = await nonceManager.getNextNonce('ethereum');
      const nonce2 = await nonceManager.getNextNonce('ethereum');
      const nonce3 = await nonceManager.getNextNonce('ethereum');

      expect(nonce1).toBe(0);
      expect(nonce2).toBe(1);
      expect(nonce3).toBe(2);
    });

    it('should track pending transaction count', async () => {
      await nonceManager.getNextNonce('ethereum');
      await nonceManager.getNextNonce('ethereum');

      const state = nonceManager.getState('ethereum');
      expect(state).not.toBeNull();
      expect(state!.pendingCount).toBe(2);
    });

    it('should throw error for unregistered chain', async () => {
      await expect(nonceManager.getNextNonce('unknown')).rejects.toThrow(
        'No wallet registered for chain: unknown'
      );
    });
  });

  describe('Transaction Confirmation', () => {
    it('should remove pending transaction on confirmation', async () => {
      const nonce = await nonceManager.getNextNonce('ethereum');
      expect(nonceManager.getState('ethereum')!.pendingCount).toBe(1);

      nonceManager.confirmTransaction('ethereum', nonce, '0xhash123');
      expect(nonceManager.getState('ethereum')!.pendingCount).toBe(0);
    });

    it('should update confirmed nonce after confirmation', async () => {
      const nonce = await nonceManager.getNextNonce('ethereum');

      // Initial confirmed nonce should be 0 (from network)
      const stateBefore = nonceManager.getState('ethereum');
      expect(stateBefore!.confirmed).toBe(0);

      // Confirm the transaction
      nonceManager.confirmTransaction('ethereum', nonce, '0xhash123');

      // Confirmed nonce should advance
      const stateAfter = nonceManager.getState('ethereum');
      expect(stateAfter!.confirmed).toBe(1);
    });
  });

  describe('Transaction Failure', () => {
    it('should remove pending transaction on failure', async () => {
      const nonce = await nonceManager.getNextNonce('ethereum');
      expect(nonceManager.getState('ethereum')!.pendingCount).toBe(1);

      nonceManager.failTransaction('ethereum', nonce, 'Transaction reverted');
      expect(nonceManager.getState('ethereum')!.pendingCount).toBe(0);
    });

    it('should reset nonce state when lowest pending fails', async () => {
      // Get two nonces
      const nonce1 = await nonceManager.getNextNonce('ethereum');
      await nonceManager.getNextNonce('ethereum');

      // Fail the first one (lowest pending)
      nonceManager.failTransaction('ethereum', nonce1, 'Transaction reverted');

      // State should be reset (-1 means needs re-sync)
      const state = nonceManager.getState('ethereum');
      expect(state!.confirmed).toBe(-1);
    });
  });

  describe('Concurrent Nonce Allocation (P0-2 Critical)', () => {
    it('should handle concurrent nonce requests without collision', async () => {
      // Simulate concurrent nonce requests
      const promises = [
        nonceManager.getNextNonce('ethereum'),
        nonceManager.getNextNonce('ethereum'),
        nonceManager.getNextNonce('ethereum'),
        nonceManager.getNextNonce('ethereum'),
        nonceManager.getNextNonce('ethereum')
      ];

      const nonces = await Promise.all(promises);

      // All nonces should be unique
      const uniqueNonces = new Set(nonces);
      expect(uniqueNonces.size).toBe(5);

      // Nonces should be sequential
      const sortedNonces = [...nonces].sort((a, b) => a - b);
      expect(sortedNonces).toEqual([0, 1, 2, 3, 4]);
    });

    it('should reject when max pending limit reached', async () => {
      // Fill up pending queue (max 5 in test config)
      for (let i = 0; i < 5; i++) {
        await nonceManager.getNextNonce('ethereum');
      }

      // Next request should fail
      await expect(nonceManager.getNextNonce('ethereum')).rejects.toThrow(
        'Max pending transactions (5) reached for ethereum'
      );
    });
  });

  describe('Network Synchronization', () => {
    it('should sync with network nonce on first call', async () => {
      mockProvider.setNonce(10);

      const nonce = await nonceManager.getNextNonce('ethereum');

      // Should start from network nonce
      expect(nonce).toBe(10);
    });

    it('should handle network nonce ahead of local state', async () => {
      // Get a nonce at 0
      await nonceManager.getNextNonce('ethereum');

      // Network advances to 10 (e.g., transactions from another source)
      mockProvider.setNonce(10);

      // Reset to force re-sync
      await nonceManager.resetChain('ethereum');

      const nonce = await nonceManager.getNextNonce('ethereum');
      expect(nonce).toBe(10);
    });
  });

  describe('Chain Reset', () => {
    it('should clear pending transactions on reset', async () => {
      await nonceManager.getNextNonce('ethereum');
      await nonceManager.getNextNonce('ethereum');

      expect(nonceManager.getState('ethereum')!.pendingCount).toBe(2);

      await nonceManager.resetChain('ethereum');

      expect(nonceManager.getState('ethereum')!.pendingCount).toBe(0);
    });

    it('should re-sync with network on reset', async () => {
      mockProvider.setNonce(5);
      await nonceManager.getNextNonce('ethereum'); // nonce 5

      mockProvider.setNonce(10);
      await nonceManager.resetChain('ethereum');

      const nonce = await nonceManager.getNextNonce('ethereum');
      expect(nonce).toBe(10);
    });
  });

  describe('Singleton Pattern', () => {
    it('should return same instance from getNonceManager', () => {
      resetNonceManager();

      const instance1 = getNonceManager();
      const instance2 = getNonceManager();

      expect(instance1).toBe(instance2);
    });

    it('should create new instance after reset', () => {
      const instance1 = getNonceManager();
      resetNonceManager();
      const instance2 = getNonceManager();

      expect(instance1).not.toBe(instance2);
    });
  });

  describe('Background Sync', () => {
    it('should start and stop background sync', () => {
      const manager = new NonceManager({ syncIntervalMs: 100 });

      // Should not throw
      manager.start();
      manager.start(); // Second call should be no-op
      manager.stop();
      manager.stop(); // Second call should be no-op
    });
  });

  describe('State Monitoring', () => {
    it('should return null state for unregistered chain', () => {
      expect(nonceManager.getState('unknown')).toBeNull();
    });

    it('should return accurate state after operations', async () => {
      await nonceManager.getNextNonce('ethereum');
      await nonceManager.getNextNonce('ethereum');
      nonceManager.confirmTransaction('ethereum', 0, '0xhash1');

      const state = nonceManager.getState('ethereum');
      expect(state).toEqual({
        confirmed: 1,
        pending: 2,
        pendingCount: 1
      });
    });
  });

  // ===========================================================================
  // P0-FIX-1: Out-of-Order Confirmation Regression Tests
  // ===========================================================================

  describe('P0-FIX-1: Out-of-Order Transaction Confirmation', () => {
    it('should correctly advance confirmedNonce when transactions confirm out of order', async () => {
      // Allocate nonces 0, 1, 2
      const nonce0 = await nonceManager.getNextNonce('ethereum');
      const nonce1 = await nonceManager.getNextNonce('ethereum');
      const nonce2 = await nonceManager.getNextNonce('ethereum');

      expect(nonce0).toBe(0);
      expect(nonce1).toBe(1);
      expect(nonce2).toBe(2);

      // Initial state: confirmedNonce = 0, pendingCount = 3
      let state = nonceManager.getState('ethereum');
      expect(state!.confirmed).toBe(0);
      expect(state!.pendingCount).toBe(3);

      // Confirm out of order: 2, then 1, then 0
      nonceManager.confirmTransaction('ethereum', 2, '0xhash2');
      state = nonceManager.getState('ethereum');
      // Should still be 0, waiting for nonce 0 to confirm
      expect(state!.confirmed).toBe(0);
      expect(state!.pendingCount).toBe(2); // 2 removed, 0 and 1 remain

      nonceManager.confirmTransaction('ethereum', 1, '0xhash1');
      state = nonceManager.getState('ethereum');
      // Still waiting for nonce 0
      expect(state!.confirmed).toBe(0);
      expect(state!.pendingCount).toBe(1); // Only 0 remains

      // Now confirm 0 - should advance past all confirmed (0, 1, 2 -> confirmed = 3)
      nonceManager.confirmTransaction('ethereum', 0, '0xhash0');
      state = nonceManager.getState('ethereum');
      expect(state!.confirmed).toBe(3); // Should advance past all confirmed txs
      expect(state!.pendingCount).toBe(0); // All confirmed and cleaned up
    });

    it('should handle partial out-of-order confirmation with gaps', async () => {
      // Allocate nonces 0, 1, 2, 3
      await nonceManager.getNextNonce('ethereum'); // 0
      await nonceManager.getNextNonce('ethereum'); // 1
      await nonceManager.getNextNonce('ethereum'); // 2
      await nonceManager.getNextNonce('ethereum'); // 3

      // Confirm 2 and 0 only (1 and 3 still pending)
      nonceManager.confirmTransaction('ethereum', 2, '0xhash2');
      nonceManager.confirmTransaction('ethereum', 0, '0xhash0');

      const state = nonceManager.getState('ethereum');
      // Should advance to 1 (0 confirmed, but 1 still pending)
      expect(state!.confirmed).toBe(1);
      expect(state!.pendingCount).toBe(2); // 1 and 3 still pending
    });

    it('should advance through multiple sequential confirmations after out-of-order', async () => {
      // Allocate nonces 0, 1, 2, 3, 4
      await nonceManager.getNextNonce('ethereum'); // 0
      await nonceManager.getNextNonce('ethereum'); // 1
      await nonceManager.getNextNonce('ethereum'); // 2
      await nonceManager.getNextNonce('ethereum'); // 3
      await nonceManager.getNextNonce('ethereum'); // 4

      // Confirm 4, 3, 2, 1 first (all out of order, waiting for 0)
      nonceManager.confirmTransaction('ethereum', 4, '0xhash4');
      nonceManager.confirmTransaction('ethereum', 3, '0xhash3');
      nonceManager.confirmTransaction('ethereum', 2, '0xhash2');
      nonceManager.confirmTransaction('ethereum', 1, '0xhash1');

      let state = nonceManager.getState('ethereum');
      expect(state!.confirmed).toBe(0); // Still waiting for 0
      expect(state!.pendingCount).toBe(1); // Only 0 pending

      // Now confirm 0 - should cascade advance to 5
      nonceManager.confirmTransaction('ethereum', 0, '0xhash0');
      state = nonceManager.getState('ethereum');
      expect(state!.confirmed).toBe(5); // Advanced past all
      expect(state!.pendingCount).toBe(0);
    });
  });

  // ===========================================================================
  // P0-FIX-2: Enhanced Concurrent Access Regression Tests
  // ===========================================================================

  describe('P0-FIX-2: Enhanced Concurrent Nonce Allocation', () => {
    it('should handle many concurrent nonce requests without collision', async () => {
      // Use a manager with higher limit for this test
      const highCapacityManager = new NonceManager({
        syncIntervalMs: 60000,
        pendingTimeoutMs: 300000,
        maxPendingPerChain: 100
      });
      highCapacityManager.registerWallet('ethereum', mockWallet);

      // Request many nonces concurrently
      const concurrentRequests = 50;
      const promises = Array.from({ length: concurrentRequests }, () =>
        highCapacityManager.getNextNonce('ethereum')
      );

      const nonces = await Promise.all(promises);

      // All nonces should be unique
      const uniqueNonces = new Set(nonces);
      expect(uniqueNonces.size).toBe(concurrentRequests);

      // Should be sequential (in any order)
      const sortedNonces = [...nonces].sort((a, b) => a - b);
      for (let i = 0; i < concurrentRequests; i++) {
        expect(sortedNonces[i]).toBe(i);
      }

      highCapacityManager.stop();
    });

    it('should handle interleaved allocation and confirmation without race', async () => {
      // Start allocating several nonces
      const nonce0Promise = nonceManager.getNextNonce('ethereum');
      const nonce1Promise = nonceManager.getNextNonce('ethereum');
      const nonce2Promise = nonceManager.getNextNonce('ethereum');

      const nonce0 = await nonce0Promise;
      const nonce1 = await nonce1Promise;
      const nonce2 = await nonce2Promise;

      // Confirm nonce0 while allocating more
      nonceManager.confirmTransaction('ethereum', nonce0, '0xhash0');

      // Allocate more
      const nonce3 = await nonceManager.getNextNonce('ethereum');
      const nonce4 = await nonceManager.getNextNonce('ethereum');

      // All should be unique and sequential
      const allNonces = [nonce0, nonce1, nonce2, nonce3, nonce4];
      expect(new Set(allNonces).size).toBe(5);
      expect(allNonces.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    });
  });

  // ===========================================================================
  // P0-FIX-3: TOCTOU Race Condition Regression Tests
  // Validates the queue-based mutex pattern fixes the check-then-set race
  // ===========================================================================

  describe('P0-FIX-3: TOCTOU Race Condition Prevention', () => {
    it('should prevent TOCTOU race when lock check and set are non-atomic', async () => {
      // This test validates that the queue-based mutex pattern prevents
      // the race condition where:
      // - Thread A checks !isLocked (false)
      // - Thread B checks !isLocked (false) - BEFORE A sets isLocked
      // - Both A and B think they have the lock
      //
      // The fix uses queue-based locking where all callers queue first,
      // then check if they're first in queue AND lock is free.

      const highCapacityManager = new NonceManager({
        syncIntervalMs: 60000,
        pendingTimeoutMs: 300000,
        maxPendingPerChain: 200
      });
      highCapacityManager.registerWallet('ethereum', mockWallet);

      // Launch many concurrent requests immediately (not staggered)
      // This maximizes the chance of triggering a TOCTOU race
      const concurrentRequests = 100;
      const promises: Promise<number>[] = [];

      for (let i = 0; i < concurrentRequests; i++) {
        promises.push(highCapacityManager.getNextNonce('ethereum'));
      }

      const nonces = await Promise.all(promises);

      // Critical assertion: All nonces must be unique
      // If there was a TOCTOU race, we'd see duplicate nonces
      const uniqueNonces = new Set(nonces);
      expect(uniqueNonces.size).toBe(concurrentRequests);

      // Verify sequential allocation (order may vary due to async scheduling)
      const sortedNonces = [...nonces].sort((a, b) => a - b);
      for (let i = 0; i < concurrentRequests; i++) {
        expect(sortedNonces[i]).toBe(i);
      }

      highCapacityManager.stop();
    });

    it('should maintain lock ordering under rapid sequential requests', async () => {
      // Test that rapid back-to-back requests maintain strict ordering
      // This ensures the queue-based pattern doesn't reorder requests

      // Use a high-capacity manager for this test (default has maxPendingPerChain: 5)
      const highCapacityManager = new NonceManager({
        syncIntervalMs: 60000,
        pendingTimeoutMs: 300000,
        maxPendingPerChain: 100
      });
      highCapacityManager.registerWallet('ethereum', mockWallet);

      const results: number[] = [];

      // Fire off requests in rapid succession (but awaiting each)
      // This tests that lock acquisition respects request order
      for (let i = 0; i < 20; i++) {
        const nonce = await highCapacityManager.getNextNonce('ethereum');
        results.push(nonce);
      }

      // Results should be strictly sequential
      expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);

      highCapacityManager.stop();
    });
  });
});
