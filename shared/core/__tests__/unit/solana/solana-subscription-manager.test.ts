/**
 * Solana Subscription Manager Unit Tests
 *
 * Tests for program subscription, unsubscription,
 * connection tracking, and cleanup.
 */

import { createSolanaSubscriptionManager, type SolanaSubscriptionManager } from '../../../src/solana/solana-subscription-manager';
import { createMockLogger, createMockConnection, createMockLifecycle } from './solana-test-helpers';

// Mock @solana/web3.js PublicKey
jest.mock('@solana/web3.js', () => ({
  PublicKey: jest.fn().mockImplementation((key: string) => {
    // Simulate PublicKey validation: base58, 32-44 chars
    if (!key || key.length < 32) {
      throw new Error('Invalid public key input');
    }
    return { toBase58: () => key, toString: () => key };
  })
}));

describe('SolanaSubscriptionManager', () => {
  let manager: SolanaSubscriptionManager;
  let logger: ReturnType<typeof createMockLogger>;
  let lifecycle: ReturnType<typeof createMockLifecycle>;
  let mockConnection: ReturnType<typeof createMockConnection>;
  let onAccountUpdate: jest.Mock;

  // Valid Solana addresses (32+ chars base58)
  const RAYDIUM_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
  const ORCA_PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';

  beforeEach(() => {
    // Re-establish PublicKey mock after resetMocks clears it
    const { PublicKey: MockPublicKey } = require('@solana/web3.js');
    MockPublicKey.mockImplementation((key: string) => {
      if (!key || key.length < 32) {
        throw new Error('Invalid public key input');
      }
      return { toBase58: () => key, toString: () => key };
    });

    logger = createMockLogger();
    lifecycle = createMockLifecycle();
    mockConnection = createMockConnection();
    onAccountUpdate = jest.fn();

    manager = createSolanaSubscriptionManager({
      logger,
      getConnectionWithIndex: jest.fn().mockReturnValue({ connection: mockConnection, index: 0 }),
      getConnectionByIndex: jest.fn().mockReturnValue(mockConnection),
      getConnection: jest.fn().mockReturnValue(mockConnection),
      onAccountUpdate,
      lifecycle,
      commitment: 'confirmed'
    });
  });

  // =========================================================================
  // subscribeToProgramAccounts
  // =========================================================================

  describe('subscribeToProgramAccounts', () => {
    it('should create subscription and track it', async () => {
      await manager.subscribeToProgramAccounts(RAYDIUM_PROGRAM);

      expect(manager.isSubscribedToProgram(RAYDIUM_PROGRAM)).toBe(true);
      expect(manager.getSubscriptionCount()).toBe(1);
      expect(mockConnection.onProgramAccountChange).toHaveBeenCalledTimes(1);
    });

    it('should log subscription with programId, subscriptionId, and connectionIndex', async () => {
      await manager.subscribeToProgramAccounts(RAYDIUM_PROGRAM);

      expect(logger.info).toHaveBeenCalledWith('Subscribed to program accounts', {
        programId: RAYDIUM_PROGRAM,
        subscriptionId: 1,
        connectionIndex: 0
      });
    });

    it('should skip duplicate subscription', async () => {
      await manager.subscribeToProgramAccounts(RAYDIUM_PROGRAM);
      await manager.subscribeToProgramAccounts(RAYDIUM_PROGRAM);

      expect(manager.getSubscriptionCount()).toBe(1);
      expect(mockConnection.onProgramAccountChange).toHaveBeenCalledTimes(1);
      expect(logger.debug).toHaveBeenCalledWith('Already subscribed to program', { programId: RAYDIUM_PROGRAM });
    });

    it('should throw for invalid program ID', async () => {
      await expect(manager.subscribeToProgramAccounts('short'))
        .rejects.toThrow('Invalid program ID: short');
      expect(logger.error).toHaveBeenCalledWith('Invalid program ID', { programId: 'short' });
    });

    it('should handle multiple programs', async () => {
      await manager.subscribeToProgramAccounts(RAYDIUM_PROGRAM);
      await manager.subscribeToProgramAccounts(ORCA_PROGRAM);

      expect(manager.getSubscriptionCount()).toBe(2);
      expect(manager.isSubscribedToProgram(RAYDIUM_PROGRAM)).toBe(true);
      expect(manager.isSubscribedToProgram(ORCA_PROGRAM)).toBe(true);
    });

    it('should not invoke callback when lifecycle is stopping', async () => {
      // Subscribe first (lifecycle running)
      await manager.subscribeToProgramAccounts(RAYDIUM_PROGRAM);

      // Get the callback that was registered
      const registeredCallback = mockConnection.onProgramAccountChange.mock.calls[0][1];

      // Simulate stopping
      lifecycle.isStopping.mockReturnValue(true);

      // Invoke the callback
      registeredCallback({ accountId: {}, accountInfo: {} }, { slot: 1 });

      // onAccountUpdate should NOT have been called
      expect(onAccountUpdate).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // unsubscribeFromProgram
  // =========================================================================

  describe('unsubscribeFromProgram', () => {
    it('should remove subscription and clean up tracking', async () => {
      await manager.subscribeToProgramAccounts(RAYDIUM_PROGRAM);
      await manager.unsubscribeFromProgram(RAYDIUM_PROGRAM);

      expect(manager.isSubscribedToProgram(RAYDIUM_PROGRAM)).toBe(false);
      expect(manager.getSubscriptionCount()).toBe(0);
      expect(mockConnection.removeProgramAccountChangeListener).toHaveBeenCalledWith(1);
    });

    it('should be a no-op for non-subscribed program', async () => {
      await manager.unsubscribeFromProgram(RAYDIUM_PROGRAM);

      expect(manager.getSubscriptionCount()).toBe(0);
      expect(logger.debug).toHaveBeenCalledWith('Not subscribed to program', { programId: RAYDIUM_PROGRAM });
    });

    it('should handle listener removal failure gracefully', async () => {
      mockConnection.removeProgramAccountChangeListener.mockRejectedValueOnce(new Error('Remove failed'));

      await manager.subscribeToProgramAccounts(RAYDIUM_PROGRAM);
      await manager.unsubscribeFromProgram(RAYDIUM_PROGRAM);

      // Should still clean up internal state
      expect(manager.isSubscribedToProgram(RAYDIUM_PROGRAM)).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith('Error removing subscription listener', expect.any(Object));
    });

    it('should use fallback connection when original connection index is invalid', async () => {
      const fallbackConnection = createMockConnection();
      const getConnectionByIndex = jest.fn().mockImplementation(() => {
        throw new Error('Index out of range');
      });
      const getConnection = jest.fn().mockReturnValue(fallbackConnection);

      const mgr = createSolanaSubscriptionManager({
        logger,
        getConnectionWithIndex: jest.fn().mockReturnValue({ connection: mockConnection, index: 5 }),
        getConnectionByIndex,
        getConnection,
        onAccountUpdate,
        lifecycle,
        commitment: 'confirmed'
      });

      await mgr.subscribeToProgramAccounts(RAYDIUM_PROGRAM);
      await mgr.unsubscribeFromProgram(RAYDIUM_PROGRAM);

      expect(logger.warn).toHaveBeenCalledWith(
        'Subscription connection index invalid, using current connection',
        { programId: RAYDIUM_PROGRAM }
      );
      expect(fallbackConnection.removeProgramAccountChangeListener).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Query methods
  // =========================================================================

  describe('query methods', () => {
    it('should return false for non-subscribed program', () => {
      expect(manager.isSubscribedToProgram(RAYDIUM_PROGRAM)).toBe(false);
    });

    it('should return 0 for empty subscriptions', () => {
      expect(manager.getSubscriptionCount()).toBe(0);
    });
  });

  // =========================================================================
  // cleanup
  // =========================================================================

  describe('cleanup', () => {
    it('should unsubscribe from all programs', async () => {
      await manager.subscribeToProgramAccounts(RAYDIUM_PROGRAM);
      await manager.subscribeToProgramAccounts(ORCA_PROGRAM);

      await manager.cleanup();

      expect(manager.getSubscriptionCount()).toBe(0);
      expect(manager.isSubscribedToProgram(RAYDIUM_PROGRAM)).toBe(false);
      expect(manager.isSubscribedToProgram(ORCA_PROGRAM)).toBe(false);
    });

    it('should handle errors during cleanup gracefully', async () => {
      mockConnection.removeProgramAccountChangeListener.mockRejectedValue(new Error('cleanup error'));

      await manager.subscribeToProgramAccounts(RAYDIUM_PROGRAM);
      await manager.cleanup();

      // Should still clear internal state
      expect(manager.getSubscriptionCount()).toBe(0);
    });
  });

  // =========================================================================
  // REGRESSION: resubscribeForConnection
  // =========================================================================

  describe('REGRESSION: resubscribeForConnection', () => {
    it('should re-subscribe programs that were on the replaced connection', async () => {
      // Subscribe to a program (goes to connection index 0)
      await manager.subscribeToProgramAccounts(RAYDIUM_PROGRAM);
      expect(manager.getSubscriptionCount()).toBe(1);

      // Simulate connection replacement — resubscribe all on index 0
      mockConnection.onProgramAccountChange.mockReturnValue(2); // new subscription ID
      await manager.resubscribeForConnection(0);

      // Should still be subscribed (re-subscribed on new connection)
      expect(manager.isSubscribedToProgram(RAYDIUM_PROGRAM)).toBe(true);
      expect(manager.getSubscriptionCount()).toBe(1);

      // Should have attempted to remove old listener
      expect(mockConnection.removeProgramAccountChangeListener).toHaveBeenCalledWith(1);
      // Should have created new subscription
      expect(mockConnection.onProgramAccountChange).toHaveBeenCalledTimes(2);
    });

    it('should be a no-op when no subscriptions on the given connection index', async () => {
      // Subscribe to connection index 0
      await manager.subscribeToProgramAccounts(RAYDIUM_PROGRAM);

      // Try to resubscribe for a different index
      await manager.resubscribeForConnection(5);

      // Original subscription should be unchanged
      expect(manager.isSubscribedToProgram(RAYDIUM_PROGRAM)).toBe(true);
      expect(manager.getSubscriptionCount()).toBe(1);
      // No removal or new subscription
      expect(mockConnection.removeProgramAccountChangeListener).not.toHaveBeenCalled();
      expect(mockConnection.onProgramAccountChange).toHaveBeenCalledTimes(1);
    });

    it('should handle errors during resubscription gracefully', async () => {
      await manager.subscribeToProgramAccounts(RAYDIUM_PROGRAM);

      // Make re-subscribe fail
      mockConnection.onProgramAccountChange.mockImplementationOnce(() => {
        throw new Error('Subscribe failed');
      });

      await manager.resubscribeForConnection(0);

      // Should log error but not throw
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to resubscribe program after connection replacement',
        expect.objectContaining({ programId: RAYDIUM_PROGRAM })
      );
    });

    it('should handle old listener removal failure silently', async () => {
      await manager.subscribeToProgramAccounts(RAYDIUM_PROGRAM);

      // Make old listener removal fail (connection already dead)
      mockConnection.removeProgramAccountChangeListener.mockRejectedValueOnce(
        new Error('Connection closed')
      );
      mockConnection.onProgramAccountChange.mockReturnValue(2);

      await manager.resubscribeForConnection(0);

      // Should still re-subscribe successfully despite removal failure
      expect(manager.isSubscribedToProgram(RAYDIUM_PROGRAM)).toBe(true);
      expect(manager.getSubscriptionCount()).toBe(1);
    });
  });
});
