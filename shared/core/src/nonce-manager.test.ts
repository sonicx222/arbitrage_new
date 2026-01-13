/**
 * Nonce Manager Unit Tests
 *
 * P0-2 Regression Tests: Validates atomic nonce allocation to prevent
 * transaction collisions in high-throughput scenarios.
 */

import { NonceManager, getNonceManager, resetNonceManager } from './nonce-manager';
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
});
