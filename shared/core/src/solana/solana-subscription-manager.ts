/**
 * Solana Subscription Manager
 *
 * ARCH-REFACTOR: Extracted from solana-detector.ts
 * Manages program account subscriptions. Owns its own
 * subscription-to-connection tracking (subscriptionConnections Map).
 *
 * Uses callback-based communication (onAccountUpdate) instead
 * of EventEmitter — the orchestrator wires this to emit events.
 *
 * @see ADR-014: Modular Detector Components
 */

import { PublicKey, AccountInfo, Context, Connection } from '@solana/web3.js';
import type {
  SolanaDetectorLogger,
  ProgramSubscription,
  Commitment,
  SolanaLifecycleDeps,
} from './solana-types';

// =============================================================================
// Public Interface
// =============================================================================

export interface SolanaSubscriptionManager {
  subscribeToProgramAccounts(programId: string): Promise<void>;
  unsubscribeFromProgram(programId: string): Promise<void>;
  isSubscribedToProgram(programId: string): boolean;
  getSubscriptionCount(): number;
  /** Re-subscribe all subscriptions that were on the given connection index. */
  resubscribeForConnection(connectionIndex: number): Promise<void>;
  /** Unsubscribe all and clear state. */
  cleanup(): Promise<void>;
}

export interface SubscriptionManagerDeps {
  logger: SolanaDetectorLogger;
  /** Get connection + index for creating subscriptions. */
  getConnectionWithIndex: () => { connection: Connection; index: number };
  /** Get connection by index for unsubscribing. */
  getConnectionByIndex: (index: number) => Connection;
  /** Fallback connection getter. */
  getConnection: () => Connection;
  /** Callback when account update received. */
  onAccountUpdate: (
    programId: string,
    accountInfo: { accountId: PublicKey; accountInfo: AccountInfo<Buffer> },
    context: Context
  ) => void;
  lifecycle: SolanaLifecycleDeps;
  commitment: Commitment;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a Solana subscription manager.
 *
 * @param deps - Dependencies
 * @returns SolanaSubscriptionManager
 */
export function createSolanaSubscriptionManager(
  deps: SubscriptionManagerDeps
): SolanaSubscriptionManager {
  const { logger, lifecycle, commitment } = deps;

  // Private state — owns both subscriptions and connection tracking
  const subscriptions = new Map<string, ProgramSubscription>();
  const subscriptionConnections = new Map<string, number>();

  function isValidSolanaAddress(address: string): boolean {
    try {
      new PublicKey(address);
      return true;
    } catch {
      return false;
    }
  }

  async function subscribeToProgramAccounts(programId: string): Promise<void> {
    if (!isValidSolanaAddress(programId)) {
      logger.error('Invalid program ID', { programId });
      throw new Error(`Invalid program ID: ${programId}`);
    }

    if (subscriptions.has(programId)) {
      logger.debug('Already subscribed to program', { programId });
      return;
    }

    const { connection, index: connectionIndex } = deps.getConnectionWithIndex();
    const pubkey = new PublicKey(programId);

    const subscriptionId = connection.onProgramAccountChange(
      pubkey,
      (accountInfo: { accountId: PublicKey; accountInfo: AccountInfo<Buffer> }, context: Context) => {
        if (lifecycle.isStopping() || !lifecycle.isRunning()) return;
        deps.onAccountUpdate(programId, accountInfo, context);
      },
      commitment
    );

    subscriptions.set(programId, {
      programId,
      subscriptionId
    });

    // Track which connection this subscription was created on
    subscriptionConnections.set(programId, connectionIndex);

    logger.info('Subscribed to program accounts', {
      programId,
      subscriptionId,
      connectionIndex
    });
  }

  async function unsubscribeFromProgram(programId: string): Promise<void> {
    const subscription = subscriptions.get(programId);
    if (!subscription) {
      logger.debug('Not subscribed to program', { programId });
      return;
    }

    // Use the same connection that created the subscription
    const connectionIndex = subscriptionConnections.get(programId);
    let connection: Connection;

    try {
      if (connectionIndex !== undefined) {
        connection = deps.getConnectionByIndex(connectionIndex);
      } else {
        logger.warn('Subscription connection index not found, using current connection', { programId });
        connection = deps.getConnection();
      }
    } catch {
      // If getConnectionByIndex throws (out of range), fall back
      logger.warn('Subscription connection index invalid, using current connection', { programId });
      connection = deps.getConnection();
    }

    try {
      await connection.removeProgramAccountChangeListener(subscription.subscriptionId);
    } catch (error) {
      logger.warn('Error removing subscription listener', { programId, error });
    }

    subscriptions.delete(programId);
    subscriptionConnections.delete(programId);

    logger.info('Unsubscribed from program', { programId });
  }

  function isSubscribedToProgram(programId: string): boolean {
    return subscriptions.has(programId);
  }

  function getSubscriptionCount(): number {
    return subscriptions.size;
  }

  async function resubscribeForConnection(connectionIndex: number): Promise<void> {
    // Find all subscriptions that were on the replaced connection
    const programIds: string[] = [];
    for (const [programId, connIdx] of subscriptionConnections) {
      if (connIdx === connectionIndex) {
        programIds.push(programId);
      }
    }

    if (programIds.length === 0) return;

    logger.info('Resubscribing programs after connection replacement', {
      connectionIndex,
      programCount: programIds.length,
    });

    for (const programId of programIds) {
      try {
        // Remove old subscription tracking
        const oldSub = subscriptions.get(programId);
        if (oldSub) {
          // Try to remove old listener (may fail if connection is dead — that's ok)
          try {
            const oldConnection = deps.getConnectionByIndex(connectionIndex);
            await oldConnection.removeProgramAccountChangeListener(oldSub.subscriptionId);
          } catch {
            // Old connection was replaced; listener is already orphaned
          }
          subscriptions.delete(programId);
          subscriptionConnections.delete(programId);
        }

        // Re-subscribe (will pick connection via getConnectionWithIndex)
        await subscribeToProgramAccounts(programId);
      } catch (error) {
        logger.error('Failed to resubscribe program after connection replacement', {
          programId,
          connectionIndex,
          error,
        });
      }
    }
  }

  async function cleanup(): Promise<void> {
    // Unsubscribe from all programs
    for (const [programId] of subscriptions) {
      try {
        await unsubscribeFromProgram(programId);
      } catch (error) {
        logger.warn(`Error unsubscribing from ${programId}`, { error });
      }
    }
    subscriptions.clear();
    subscriptionConnections.clear();
  }

  return {
    subscribeToProgramAccounts,
    unsubscribeFromProgram,
    isSubscribedToProgram,
    getSubscriptionCount,
    resubscribeForConnection,
    cleanup,
  };
}
