/**
 * Standby Activation Manager
 *
 * Extracted from coordinator.ts to reduce file complexity.
 * Manages standby-to-active coordinator activation:
 * - Promise-based mutex for concurrent activation requests
 * - Validation of standby/leader state before activation
 * - Delegation to LeadershipElectionService for actual leader acquisition
 *
 * Hot-path note:
 * - activateStandby() is COLD path (triggered by cross-region failover events)
 * - No allocations in tight loops, no blocking operations on hot path
 *
 * @see coordinator.ts (consumer)
 * @see leadership/leadership-election-service.ts (LeadershipElectionService)
 * @see ADR-007: Failover Strategy
 */

import type { LeadershipElectionService } from './leadership';

/**
 * Logger interface matching coordinator's Logger type.
 */
interface Logger {
  info: (message: string, meta?: object) => void;
  error: (message: string, meta?: object) => void;
  warn: (message: string, meta?: object) => void;
  debug: (message: string, meta?: object) => void;
}

/**
 * Dependencies for StandbyActivationManager construction.
 *
 * Uses getter functions for mutable state that may change between calls.
 */
export interface StandbyActivationManagerDeps {
  logger: Logger;

  /** Get leadership election service (may not be initialized yet) */
  getLeadershipElection: () => LeadershipElectionService | null;

  /** Check if this coordinator is currently the leader */
  getIsLeader: () => boolean;
  /** Check if this coordinator is in standby mode */
  getIsStandby: () => boolean;
  /** Check if this coordinator can become leader */
  getCanBecomeLeader: () => boolean;

  /** Instance ID for logging */
  instanceId: string;
  /** Region ID for logging */
  regionId: string | undefined;

  /** Callback when activation succeeds — clears standby flag on config */
  onActivationSuccess: () => void;
  /** Callback to set local isActivating flag for backward compatibility */
  setIsActivating: (value: boolean) => void;
}

/**
 * Manages standby coordinator activation with Promise-based mutex.
 *
 * Ensures only one activation runs at a time using a Promise-based
 * mutex pattern. Concurrent callers wait for the in-progress activation
 * to complete and receive its result.
 */
export class StandbyActivationManager {
  private activationPromise: Promise<boolean> | null = null;
  private readonly deps: StandbyActivationManagerDeps;

  constructor(deps: StandbyActivationManagerDeps) {
    this.deps = deps;
  }

  /**
   * Check if activation is currently in progress.
   */
  getIsActivating(): boolean {
    return this.activationPromise !== null;
  }

  /**
   * Activate a standby coordinator to become the active leader.
   * This is called when CrossRegionHealthManager signals activation.
   *
   * FIX: Uses Promise-based mutex pattern.
   * Previously used a boolean flag which had a race window between check and set.
   * Now uses activationPromise to ensure only one activation runs at a time.
   *
   * P1-002 FIX: Moved promise creation to be atomic with mutex check to eliminate
   * race window where two concurrent calls could both pass the checks and create
   * separate promises before either sets activationPromise.
   *
   * @returns Promise<boolean> - true if activation succeeded
   */
  async activateStandby(): Promise<boolean> {
    // P1-002 FIX: Atomic check-and-set pattern
    // Check activationPromise FIRST before any other checks to acquire mutex immediately
    if (this.activationPromise) {
      this.deps.logger.warn('Activation already in progress, waiting for result');
      return this.activationPromise;
    }

    // Create promise immediately to claim the mutex before any async checks
    // This prevents race condition where two threads both pass the check above
    const activationLogic = async (): Promise<boolean> => {
      // Now that we have the mutex, perform all validation checks
      if (this.deps.getIsLeader()) {
        this.deps.logger.warn('Coordinator already leader, skipping activation');
        return true;
      }

      if (!this.deps.getIsStandby()) {
        this.deps.logger.warn('activateStandby called on non-standby instance');
        return false;
      }

      if (!this.deps.getCanBecomeLeader()) {
        this.deps.logger.error('Cannot activate - canBecomeLeader is false');
        return false;
      }

      // Perform the actual activation
      return this.doActivateStandby();
    };

    // Set activationPromise synchronously before any await
    this.activationPromise = activationLogic();

    try {
      return await this.activationPromise;
    } finally {
      // Clear the promise when done (success or failure)
      this.activationPromise = null;
    }
  }

  // ===========================================================================
  // Internal Implementation
  // ===========================================================================

  /**
   * Internal implementation of standby activation.
   * Separated to allow Promise-based mutex in activateStandby().
   *
   * P1-8 FIX: Delegates to LeadershipElectionService.setActivating()
   */
  private async doActivateStandby(): Promise<boolean> {
    const { logger, getLeadershipElection, instanceId, regionId } = this.deps;

    const leadershipElection = getLeadershipElection();
    if (!leadershipElection) {
      logger.error('LeadershipElectionService not initialized');
      return false;
    }

    logger.warn('🚀 ACTIVATING STANDBY COORDINATOR', {
      instanceId,
      regionId,
      previousIsLeader: this.deps.getIsLeader()
    });

    // P1-8 FIX: Use LeadershipElectionService.setActivating() instead of local flag
    // This signals the service to bypass standby checks in tryAcquireLeadership
    leadershipElection.setActivating(true);
    // Update local flag for backward compatibility
    this.deps.setIsActivating(true);

    try {
      // P1-8 FIX: Use service's tryAcquireLeadership() method
      const acquired = await leadershipElection.tryAcquireLeadership();

      if (acquired) {
        // Successful activation - notify parent to clear standby flag
        this.deps.onActivationSuccess();
        // P1 FIX #4: Clear standby in LeadershipElectionService so it can
        // re-acquire leadership if lost, without needing another activation signal
        leadershipElection.clearStandby();
        logger.warn('✅ STANDBY COORDINATOR ACTIVATED - Now leader', {
          instanceId,
          regionId,
        });
        return true;
      } else {
        logger.error('Failed to acquire leadership during activation');
        return false;
      }

    } catch (error) {
      logger.error('Error during standby activation', { error });
      return false;
    } finally {
      // P1-8 FIX: Clear activation flag in both service and local field
      leadershipElection.setActivating(false);
      this.deps.setIsActivating(false);
    }
  }
}
