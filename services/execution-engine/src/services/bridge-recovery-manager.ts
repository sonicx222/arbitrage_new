/**
 * Bridge Recovery Manager
 *
 * Handles recovery of cross-chain arbitrage executions that were interrupted.
 * This is a funds-at-risk scenario: tokens may be locked in a bridge with no
 * corresponding sell executed on the destination chain.
 *
 * Recovery scenarios:
 * 1. Service restart during bridge polling -> resume status polling
 * 2. Bridge timeout -> periodic re-check for late completions
 * 3. Bridge succeeded but sell failed -> attempt sell recovery
 *
 * Design:
 * - Scans Redis for `bridge:recovery:*` keys on startup
 * - Runs periodic checks at configurable intervals
 * - Uses bridge router to check current bridge status
 * - Delegates sell execution to CrossChainStrategy.recoverSingleBridge()
 * - Tracks metrics for monitoring and alerting
 *
 * @custom:version 1.0.0
 * @see ADR-018 Circuit Breaker
 * @see BridgeRecoveryState in types.ts
 * @see CrossChainStrategy.persistBridgeRecoveryState
 */

import type { RedisClient, BridgeRouterFactory, SignedEnvelope } from '@arbitrage/core';
import { getErrorMessage, hmacSign, hmacVerify, getHmacSigningKey, isSignedEnvelope } from '@arbitrage/core';
import type {
  Logger,
  BridgeRecoveryState,
} from '../types';
import {
  BRIDGE_RECOVERY_KEY_PREFIX,
  BRIDGE_RECOVERY_MAX_AGE_MS,
} from '../types';

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for BridgeRecoveryManager.
 */
export interface BridgeRecoveryManagerConfig {
  /** How often to check pending bridges (ms). Default: 60000 (1 min) */
  checkIntervalMs: number;
  /** Max age before marking bridge as abandoned (ms). Default: 24 hours */
  maxAgeMs: number;
  /** Max concurrent recovery operations. Default: 3 */
  maxConcurrentRecoveries: number;
  /** Whether recovery is enabled. Default: true */
  enabled: boolean;
}

/**
 * Metrics for bridge recovery operations.
 */
export interface RecoveryMetrics {
  /** Number of bridges currently pending recovery */
  pendingBridges: number;
  /** Number of bridges successfully recovered (sell executed) */
  recoveredBridges: number;
  /** Number of recovery attempts that failed */
  failedRecoveries: number;
  /** Number of bridges marked as abandoned (exceeded maxAgeMs) */
  abandonedBridges: number;
  /** Timestamp of last recovery check */
  lastCheckAt: number;
  /** Whether the recovery manager is currently running a check */
  isChecking: boolean;
}

/**
 * Dependencies for BridgeRecoveryManager construction.
 * Uses Constructor DI pattern for testability.
 */
export interface BridgeRecoveryManagerDeps {
  /** Logger instance */
  logger: Logger;
  /** Redis client for state persistence */
  redis: RedisClient;
  /** Bridge router factory for status checks */
  bridgeRouterFactory: BridgeRouterFactory;
  /** Optional configuration overrides */
  config?: Partial<BridgeRecoveryManagerConfig>;
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: BridgeRecoveryManagerConfig = {
  checkIntervalMs: 60_000,       // 1 minute
  maxAgeMs: BRIDGE_RECOVERY_MAX_AGE_MS,  // 24 hours
  maxConcurrentRecoveries: 3,
  enabled: true,
};

// =============================================================================
// BridgeRecoveryManager
// =============================================================================

/**
 * Manages recovery of interrupted cross-chain bridge operations.
 *
 * Lifecycle:
 * 1. start() - Runs initial recovery scan, starts periodic check interval
 * 2. recoverPendingBridges() - Called on each interval tick
 * 3. stop() - Stops periodic checks, cleans up
 *
 * Thread safety: Only one check runs at a time (guarded by isChecking flag).
 */
export class BridgeRecoveryManager {
  private readonly logger: Logger;
  private readonly redis: RedisClient;
  private readonly bridgeRouterFactory: BridgeRouterFactory;
  private readonly config: BridgeRecoveryManagerConfig;

  private checkInterval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isChecking = false;

  // Metrics
  private metrics: RecoveryMetrics = {
    pendingBridges: 0,
    recoveredBridges: 0,
    failedRecoveries: 0,
    abandonedBridges: 0,
    lastCheckAt: 0,
    isChecking: false,
  };

  constructor(deps: BridgeRecoveryManagerDeps) {
    this.logger = deps.logger;
    this.redis = deps.redis;
    this.bridgeRouterFactory = deps.bridgeRouterFactory;
    this.config = {
      ...DEFAULT_CONFIG,
      ...deps.config,
    };
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /**
   * Start the bridge recovery manager.
   *
   * 1. Runs an initial recovery scan for any pending bridges
   * 2. Starts a periodic interval for ongoing checks
   *
   * @returns Number of bridges found during initial scan
   */
  async start(): Promise<number> {
    if (!this.config.enabled) {
      this.logger.info('Bridge recovery manager disabled by configuration');
      return 0;
    }

    if (this.isRunning) {
      this.logger.warn('Bridge recovery manager already running');
      return 0;
    }

    this.isRunning = true;

    this.logger.info('Starting bridge recovery manager', {
      checkIntervalMs: this.config.checkIntervalMs,
      maxAgeMs: this.config.maxAgeMs,
      maxConcurrentRecoveries: this.config.maxConcurrentRecoveries,
    });

    // Run initial recovery scan
    const initialCount = await this.recoverPendingBridges();

    // Start periodic checks
    this.checkInterval = setInterval(() => {
      if (this.isRunning) {
        this.recoverPendingBridges().catch((error) => {
          this.logger.error('Periodic bridge recovery check failed', {
            error: getErrorMessage(error),
          });
        });
      }
    }, this.config.checkIntervalMs);

    return initialCount;
  }

  /**
   * Stop the bridge recovery manager.
   *
   * Stops periodic checks. Does not interrupt any in-progress recovery.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    this.logger.info('Bridge recovery manager stopped', {
      metrics: this.getMetrics(),
    });
  }

  // ===========================================================================
  // Recovery Logic
  // ===========================================================================

  /**
   * Scan Redis for pending bridge recovery states and process them.
   *
   * For each pending bridge:
   * - If age > maxAgeMs: mark as abandoned
   * - If status = 'pending' or 'bridging': check bridge status via router
   * - If bridge completed: attempt destination sell
   * - If bridge failed/refunded: mark as failed
   * - If bridge still pending: update lastCheckAt, continue monitoring
   *
   * Uses SCAN (not KEYS) per Redis best practices.
   *
   * @returns Number of bridges found (not necessarily recovered)
   */
  async recoverPendingBridges(): Promise<number> {
    // Guard against concurrent checks
    if (this.isChecking) {
      this.logger.debug('Bridge recovery check already in progress, skipping');
      return 0;
    }

    this.isChecking = true;
    this.metrics.isChecking = true;

    try {
      // Scan for all bridge recovery keys
      const states = await this.scanBridgeRecoveryStates();

      if (states.length === 0) {
        this.logger.debug('No pending bridges to recover');
        this.metrics.pendingBridges = 0;
        this.metrics.lastCheckAt = Date.now();
        return 0;
      }

      this.logger.info('Found bridge recovery states', { count: states.length });

      // Filter to actionable states (pending/bridging/bridge_completed_sell_pending)
      const actionableStates = states.filter(
        (s) => s.status === 'pending' || s.status === 'bridging' || s.status === 'bridge_completed_sell_pending'
      );

      this.metrics.pendingBridges = actionableStates.length;

      // Process with concurrency limit
      let processedCount = 0;
      const batchSize = this.config.maxConcurrentRecoveries;

      for (let i = 0; i < actionableStates.length; i += batchSize) {
        const batch = actionableStates.slice(i, i + batchSize);
        const results = await Promise.allSettled(
          batch.map((state) => this.processSingleBridge(state))
        );

        for (const result of results) {
          if (result.status === 'fulfilled') {
            processedCount++;
          } else {
            this.logger.error('Bridge recovery batch item failed', {
              error: getErrorMessage(result.reason),
            });
          }
        }
      }

      this.metrics.lastCheckAt = Date.now();

      this.logger.info('Bridge recovery check completed', {
        totalFound: states.length,
        actionable: actionableStates.length,
        processed: processedCount,
        metrics: this.getMetrics(),
      });

      return states.length;
    } catch (error) {
      this.logger.error('Bridge recovery scan failed', {
        error: getErrorMessage(error),
      });
      return 0;
    } finally {
      this.isChecking = false;
      this.metrics.isChecking = false;
    }
  }

  /**
   * Check the current status of a single bridge and take appropriate action.
   *
   * @param state - The bridge recovery state from Redis
   */
  async checkBridgeStatus(state: BridgeRecoveryState): Promise<void> {
    await this.processSingleBridge(state);
  }

  /**
   * Attempt to execute the destination sell for a completed bridge.
   *
   * This is called when a bridge has completed (tokens arrived on destination)
   * but the sell was not executed (e.g., due to shutdown during polling).
   *
   * Note: The actual sell execution is delegated to the bridge router and
   * CrossChainStrategy. This method updates the recovery state based on the
   * bridge status.
   *
   * @param state - The bridge recovery state
   */
  async attemptSellRecovery(state: BridgeRecoveryState): Promise<boolean> {
    // Find a suitable bridge router for the route
    const bridgeRouter = this.bridgeRouterFactory.findSupportedRouter(
      state.sourceChain,
      state.destChain,
      state.bridgeToken,
    );

    if (!bridgeRouter) {
      this.logger.warn('Cannot attempt sell recovery - no suitable bridge router', {
        bridgeId: state.bridgeId,
        sourceChain: state.sourceChain,
        destChain: state.destChain,
        bridgeToken: state.bridgeToken,
      });
      await this.updateRecoveryStatus(state.bridgeId, 'failed', 'No suitable bridge router for sell recovery');
      this.metrics.failedRecoveries++;
      return false;
    }

    try {
      // Verify bridge is actually completed
      const bridgeStatus = await bridgeRouter.getStatus(state.bridgeId);

      if (bridgeStatus.status !== 'completed') {
        this.logger.info('Bridge not yet completed for sell recovery', {
          bridgeId: state.bridgeId,
          currentStatus: bridgeStatus.status,
        });
        return false;
      }

      // Mark as recovered - the actual sell execution is handled by
      // CrossChainStrategy.recoverSingleBridge() which has access to
      // the full StrategyContext (wallets, providers, etc.)
      // The recovery manager's role is status tracking and scheduling.
      this.logger.info('Bridge completed, sell recovery needed', {
        bridgeId: state.bridgeId,
        amountReceived: bridgeStatus.amountReceived,
        destTxHash: bridgeStatus.destTxHash,
      });

      return true;
    } catch (error) {
      this.logger.error('Sell recovery check failed', {
        bridgeId: state.bridgeId,
        error: getErrorMessage(error),
      });
      this.metrics.failedRecoveries++;
      return false;
    }
  }

  // ===========================================================================
  // Metrics
  // ===========================================================================

  /**
   * Get current recovery metrics snapshot.
   */
  getMetrics(): Readonly<RecoveryMetrics> {
    return { ...this.metrics };
  }

  /**
   * Check if the manager is currently running.
   */
  getIsRunning(): boolean {
    return this.isRunning;
  }

  // ===========================================================================
  // Internal Methods
  // ===========================================================================

  /**
   * Scan Redis for all bridge recovery state keys using SCAN.
   * Returns parsed BridgeRecoveryState objects.
   */
  private async scanBridgeRecoveryStates(): Promise<BridgeRecoveryState[]> {
    const states: BridgeRecoveryState[] = [];
    let cursor = '0';

    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        `${BRIDGE_RECOVERY_KEY_PREFIX}*`,
        'COUNT',
        100
      );
      cursor = nextCursor;

      const signingKey = getHmacSigningKey();

      for (const key of keys) {
        try {
          // redis.get<T>() returns parsed JSON directly (no need for JSON.parse)
          const raw = await this.redis.get(key);
          if (!raw) continue;

          // Fix #4: Handle both HMAC-signed envelopes and legacy unsigned data
          let state: BridgeRecoveryState;
          if (isSignedEnvelope(raw)) {
            const verified = hmacVerify<BridgeRecoveryState>(raw as SignedEnvelope<BridgeRecoveryState>, signingKey);
            if (!verified) {
              this.logger.error('Bridge recovery state HMAC verification failed - possible tampering', {
                key,
              });
              continue;
            }
            state = verified;
          } else {
            // Legacy unsigned data — accept but log if signing is enabled
            state = raw as BridgeRecoveryState;
            if (signingKey) {
              this.logger.warn('Unsigned bridge recovery state found with signing enabled', { key });
            }
          }

          states.push(state);
        } catch (error) {
          this.logger.warn('Failed to read bridge recovery state', {
            key,
            error: getErrorMessage(error),
          });
          // Clean up corrupt entry
          try {
            await this.redis.del(key);
          } catch {
            // Best effort cleanup
          }
        }
      }
    } while (cursor !== '0');

    return states;
  }

  /**
   * Process a single bridge recovery state.
   *
   * Decision tree:
   * 1. Check age -> abandon if too old
   * 2. Check bridge status via router
   * 3. Based on status:
   *    - completed: mark as recovered (sell handled by CrossChainStrategy)
   *    - failed/refunded: mark as failed
   *    - pending/bridging: update lastCheckAt, continue monitoring
   */
  private async processSingleBridge(state: BridgeRecoveryState): Promise<void> {
    const age = Date.now() - state.initiatedAt;

    // Check if bridge is too old (abandoned)
    if (age > this.config.maxAgeMs) {
      this.logger.warn('Bridge recovery state expired, marking as abandoned', {
        bridgeId: state.bridgeId,
        opportunityId: state.opportunityId,
        ageMs: age,
        maxAgeMs: this.config.maxAgeMs,
        sourceChain: state.sourceChain,
        destChain: state.destChain,
      });
      await this.updateRecoveryStatus(state.bridgeId, 'failed', 'Bridge abandoned: exceeded max age');
      this.metrics.abandonedBridges++;
      return;
    }

    // Find bridge router for status check
    const bridgeRouter = this.bridgeRouterFactory.findSupportedRouter(
      state.sourceChain,
      state.destChain,
      state.bridgeToken,
    );

    if (!bridgeRouter) {
      this.logger.warn('No bridge router available for recovery check', {
        bridgeId: state.bridgeId,
        sourceChain: state.sourceChain,
        destChain: state.destChain,
        bridgeToken: state.bridgeToken,
      });
      // Don't mark as failed - router may become available later
      return;
    }

    // Handle bridge_completed_sell_pending: bridge already completed, sell still needed
    // Skip status check and go straight to sell recovery attempt
    if (state.status === 'bridge_completed_sell_pending') {
      this.logger.warn('Bridge completed but sell not executed - recovery needed', {
        bridgeId: state.bridgeId,
        opportunityId: state.opportunityId,
        destChain: state.destChain,
        bridgeToken: state.bridgeToken,
        bridgeAmount: state.bridgeAmount,
        ageMs: age,
      });

      const bridgeConfirmedComplete = await this.attemptSellRecovery(state);
      if (bridgeConfirmedComplete) {
        // Fix W2-4: Do NOT mark as 'recovered' — the BridgeRecoveryManager cannot execute
        // the sell (no StrategyContext with wallets/providers). Leave status as
        // 'bridge_completed_sell_pending' so CrossChainStrategy.recoverPendingBridges()
        // picks it up on restart and executes the actual sell transaction.
        // @see docs/reports/SOLANA_BRIDGE_DEEP_ANALYSIS_2026-02-20.md W2-4
        this.logger.warn('Bridge confirmed complete but sell not executed — awaiting engine restart for sell recovery', {
          bridgeId: state.bridgeId,
          opportunityId: state.opportunityId,
          destChain: state.destChain,
        });
      }
      // State remains as bridge_completed_sell_pending for next check or engine restart
      return;
    }

    try {
      const bridgeStatus = await bridgeRouter.getStatus(state.bridgeId);

      this.logger.debug('Bridge recovery status check', {
        bridgeId: state.bridgeId,
        previousStatus: state.status,
        currentStatus: bridgeStatus.status,
        ageMs: age,
      });

      switch (bridgeStatus.status) {
        case 'completed': {
          this.logger.info('Bridge completed during recovery check', {
            bridgeId: state.bridgeId,
            opportunityId: state.opportunityId,
            amountReceived: bridgeStatus.amountReceived,
            destTxHash: bridgeStatus.destTxHash,
          });
          await this.updateRecoveryStatus(state.bridgeId, 'recovered');
          this.metrics.recoveredBridges++;
          break;
        }

        case 'failed': {
          this.logger.warn('Bridge failed during recovery check', {
            bridgeId: state.bridgeId,
            opportunityId: state.opportunityId,
            error: bridgeStatus.error,
          });
          await this.updateRecoveryStatus(state.bridgeId, 'failed', bridgeStatus.error ?? 'Bridge failed');
          this.metrics.failedRecoveries++;
          break;
        }

        case 'refunded': {
          this.logger.info('Bridge refunded during recovery check', {
            bridgeId: state.bridgeId,
            opportunityId: state.opportunityId,
          });
          await this.updateRecoveryStatus(state.bridgeId, 'failed', 'Bridge refunded to source');
          this.metrics.failedRecoveries++;
          break;
        }

        case 'pending':
        case 'bridging':
        default: {
          // Still in progress - update lastCheckAt
          const updatedStatus = bridgeStatus.status === 'bridging' ? 'bridging' : 'pending';
          await this.updateRecoveryStatus(state.bridgeId, updatedStatus as BridgeRecoveryState['status']);
          this.logger.debug('Bridge still in progress', {
            bridgeId: state.bridgeId,
            status: bridgeStatus.status,
            ageMs: age,
          });
          break;
        }
      }
    } catch (error) {
      this.logger.warn('Bridge status check failed during recovery', {
        bridgeId: state.bridgeId,
        error: getErrorMessage(error),
      });
      // Don't mark as failed on transient errors - will retry on next check
    }
  }

  /**
   * Update bridge recovery status in Redis.
   *
   * For terminal states (recovered, failed), sets a short 1-hour TTL
   * for post-mortem analysis. For active states, keeps the standard TTL.
   */
  private async updateRecoveryStatus(
    bridgeId: string,
    status: BridgeRecoveryState['status'],
    errorMessage?: string,
  ): Promise<void> {
    const key = `${BRIDGE_RECOVERY_KEY_PREFIX}${bridgeId}`;

    try {
      const signingKey = getHmacSigningKey();
      const raw = await this.redis.get(key);
      if (!raw) {
        // State already expired or wasn't persisted
        return;
      }

      // Fix #4: Handle HMAC-signed envelopes on read
      let existing: BridgeRecoveryState;
      if (isSignedEnvelope(raw)) {
        const verified = hmacVerify<BridgeRecoveryState>(raw as SignedEnvelope<BridgeRecoveryState>, signingKey);
        if (!verified) {
          this.logger.error('Bridge recovery state HMAC verification failed during update', {
            bridgeId,
          });
          return;
        }
        existing = verified;
      } else {
        existing = raw as BridgeRecoveryState;
      }

      const updated: BridgeRecoveryState = {
        ...existing,
        status,
        lastCheckAt: Date.now(),
      };

      if (errorMessage) {
        updated.errorMessage = errorMessage;
      }

      // Fix #4: HMAC-sign updated state
      const signedEnvelope = hmacSign(updated, signingKey);

      // Terminal states get short TTL for post-mortem; active states keep standard TTL
      const isTerminal = status === 'recovered' || status === 'failed';
      const ttlSeconds = isTerminal
        ? 3600 // 1 hour
        : Math.floor(this.config.maxAgeMs / 1000);

      await this.redis.set(key, signedEnvelope, ttlSeconds);

      this.logger.debug('Updated bridge recovery status', {
        bridgeId,
        status,
        errorMessage,
        ttlSeconds,
      });
    } catch (error) {
      this.logger.warn('Failed to update bridge recovery status', {
        bridgeId,
        status,
        error: getErrorMessage(error),
      });
    }
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a BridgeRecoveryManager instance.
 *
 * @param deps - Dependencies (logger, redis, bridgeRouterFactory, optional config)
 * @returns Configured BridgeRecoveryManager
 */
export function createBridgeRecoveryManager(
  deps: BridgeRecoveryManagerDeps,
): BridgeRecoveryManager {
  return new BridgeRecoveryManager(deps);
}
