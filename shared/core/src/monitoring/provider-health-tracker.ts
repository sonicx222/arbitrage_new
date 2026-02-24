/**
 * Provider Health Tracker
 *
 * CQ8-ALT: Extracted cold-path health tracking logic from websocket-manager.ts.
 * Handles:
 * - Connection quality metrics (message gap, block numbers, reconnect count)
 * - Staleness detection (chain-specific thresholds)
 * - Proactive health check intervals (10s timer)
 * - Data gap detection for block-based subscriptions
 *
 * Performance Note:
 * - All methods here are COLD PATH — metric updates are inlined in processMessage()
 *   via direct property access (this.healthTracker.qualityMetrics.lastMessageTime = ...)
 * - The 10s interval health check is non-blocking
 * - HOT PATH message handling remains monolithic in WebSocketManager
 *
 * @see websocket-manager.ts (consumer)
 */

import { createLogger } from '../logger';
import { clearIntervalSafe } from '../async/lifecycle-utils';
import type { ProviderHealthScorer } from './provider-health-scorer';

const logger = createLogger('provider-health-tracker');

// =============================================================================
// Constants
// =============================================================================

/**
 * T1.5: Chain-specific staleness thresholds based on block times.
 * Fast chains need aggressive staleness detection to avoid missing opportunities.
 */
const CHAIN_STALENESS_THRESHOLDS: Record<string, number> = {
  // Fast chains (sub-1s block times) - 5 seconds
  arbitrum: 5000,
  solana: 5000,

  // Medium chains (1-3s block times) - 10 seconds
  polygon: 10000,
  bsc: 10000,
  optimism: 10000,
  base: 10000,
  avalanche: 10000,
  fantom: 10000,

  // Slow chains (10+ second block times) - 15 seconds
  ethereum: 15000,
  zksync: 15000,
  linea: 15000,

  // Default for unknown chains
  default: 15000
};

/**
 * T1.5: Get staleness threshold for a specific chain.
 */
function getChainStalenessThreshold(chainId: string): number {
  const normalizedChain = chainId.toLowerCase();
  return CHAIN_STALENESS_THRESHOLDS[normalizedChain] ?? CHAIN_STALENESS_THRESHOLDS.default;
}

// =============================================================================
// Types
// =============================================================================

export interface QualityMetrics {
  /** Timestamp of last received message */
  lastMessageTime: number;
  /** Time since last message in ms (updated periodically) */
  messageGapMs: number;
  /** Last block number seen (for block-based subscriptions) */
  lastBlockNumber: number;
  /** Total reconnection count during this session */
  reconnectCount: number;
  /** Connection start time for uptime calculation */
  connectionStartTime: number;
  /** Total messages received */
  messagesReceived: number;
  /** Total errors encountered */
  errorsEncountered: number;
}

export interface HealthTrackerConfig {
  /** Chain ID for health tracking */
  chainId?: string;
  /** Override staleness threshold (ms) instead of chain-based default */
  stalenessThresholdMs?: number;
}

// =============================================================================
// ProviderHealthTracker
// =============================================================================

/**
 * Tracks connection quality metrics and performs staleness detection.
 *
 * WebSocketManager holds a direct reference to this class (Constructor DI).
 * Quality metrics are updated directly by WebSocketManager's processMessage()
 * via the public `qualityMetrics` property for zero-overhead hot-path access.
 */
export class ProviderHealthTracker {
  /** Chain ID for logging/reporting */
  private readonly chainId: string;

  /**
   * S3.3: Connection quality metrics for proactive health monitoring.
   * Public for direct property access from hot-path code in WebSocketManager.
   */
  readonly qualityMetrics: QualityMetrics = {
    lastMessageTime: 0,
    messageGapMs: 0,
    lastBlockNumber: 0,
    reconnectCount: 0,
    connectionStartTime: 0,
    messagesReceived: 0,
    errorsEncountered: 0
  };

  /** Proactive health check interval timer */
  private healthCheckTimer: NodeJS.Timeout | null = null;

  /**
   * T1.5: Staleness threshold in ms — chain-specific.
   * 5s (fast chains) / 10s (medium) / 15s (slow) based on block times.
   */
  private stalenessThresholdMs: number;

  constructor(config: HealthTrackerConfig) {
    this.chainId = config.chainId ?? 'unknown';
    this.stalenessThresholdMs = config.stalenessThresholdMs ??
      getChainStalenessThreshold(this.chainId);
  }

  // ===========================================================================
  // Connection Lifecycle
  // ===========================================================================

  /**
   * Mark connection as established. Resets relevant metrics.
   */
  onConnected(): void {
    this.qualityMetrics.connectionStartTime = Date.now();
    this.qualityMetrics.lastMessageTime = Date.now();
  }

  /**
   * Record a reconnection event.
   */
  onReconnecting(): void {
    this.qualityMetrics.reconnectCount++;
  }

  // ===========================================================================
  // Quality Metrics
  // ===========================================================================

  /**
   * Get connection quality metrics for health monitoring.
   */
  getQualityMetrics(subscriptionCount: number): {
    lastMessageTime: number;
    messageGapMs: number;
    lastBlockNumber: number;
    reconnectCount: number;
    uptime: number;
    messagesReceived: number;
    errorsEncountered: number;
    isStale: boolean;
  } {
    const now = Date.now();
    const messageGapMs = this.qualityMetrics.lastMessageTime > 0
      ? now - this.qualityMetrics.lastMessageTime
      : 0;
    const uptime = this.qualityMetrics.connectionStartTime > 0
      ? now - this.qualityMetrics.connectionStartTime
      : 0;

    return {
      lastMessageTime: this.qualityMetrics.lastMessageTime,
      messageGapMs,
      lastBlockNumber: this.qualityMetrics.lastBlockNumber,
      reconnectCount: this.qualityMetrics.reconnectCount,
      uptime,
      messagesReceived: this.qualityMetrics.messagesReceived,
      errorsEncountered: this.qualityMetrics.errorsEncountered,
      isStale: this.isConnectionStale(subscriptionCount)
    };
  }

  // ===========================================================================
  // Staleness Detection
  // ===========================================================================

  /**
   * Check if the connection appears stale (no messages for too long).
   */
  isConnectionStale(subscriptionCount: number): boolean {
    if (subscriptionCount === 0) return false;
    if (this.qualityMetrics.lastMessageTime === 0) return false;

    const messageGapMs = Date.now() - this.qualityMetrics.lastMessageTime;
    return messageGapMs > this.stalenessThresholdMs;
  }

  /**
   * Set the staleness threshold for proactive rotation.
   */
  setStalenessThreshold(thresholdMs: number): void {
    this.stalenessThresholdMs = thresholdMs;
  }

  // ===========================================================================
  // Block Number Tracking & Data Gap Detection
  // ===========================================================================

  /**
   * Record a block number (can be called externally for more accurate tracking).
   */
  recordBlockNumber(blockNumber: number): void {
    this.qualityMetrics.lastBlockNumber = blockNumber;
    this.qualityMetrics.lastMessageTime = Date.now();
  }

  /**
   * Check for data gaps by comparing received block to last known block.
   * Called internally when processing block notifications.
   *
   * @returns Gap info if missed blocks detected, null otherwise
   */
  checkForDataGap(newBlockNumber: number): {
    fromBlock: number;
    toBlock: number;
    missedBlocks: number;
  } | null {
    const lastKnownBlock = this.qualityMetrics.lastBlockNumber;

    if (lastKnownBlock === 0) {
      return null; // First block, no gap possible
    }

    const missedBlocks = newBlockNumber - lastKnownBlock - 1;

    if (missedBlocks > 0) {
      logger.warn('Data gap detected', {
        chainId: this.chainId,
        lastKnownBlock,
        newBlockNumber,
        missedBlocks
      });

      return {
        fromBlock: lastKnownBlock + 1,
        toBlock: newBlockNumber - 1,
        missedBlocks
      };
    }

    return null;
  }

  // ===========================================================================
  // Proactive Health Check Timer
  // ===========================================================================

  /**
   * Start proactive health monitoring.
   * Periodically checks connection quality and calls the callback if stale.
   *
   * @param intervalMs - Check interval in ms (default 10000)
   * @param onStale - Callback when connection is detected as stale
   * @param isConnected - Function to check if currently connected
   * @param subscriptionCount - Function to get current subscription count
   */
  startProactiveHealthCheck(
    intervalMs: number,
    onStale: () => void,
    isConnected: () => boolean,
    subscriptionCount: () => number,
  ): void {
    this.stopProactiveHealthCheck();

    this.healthCheckTimer = setInterval(() => {
      if (!isConnected()) return;

      // Update message gap metric
      this.qualityMetrics.messageGapMs = this.qualityMetrics.lastMessageTime > 0
        ? Date.now() - this.qualityMetrics.lastMessageTime
        : 0;

      // Check for staleness
      if (this.isConnectionStale(subscriptionCount())) {
        logger.warn('Proactive rotation: connection appears stale', {
          chainId: this.chainId,
          messageGapMs: this.qualityMetrics.messageGapMs,
          lastBlockNumber: this.qualityMetrics.lastBlockNumber,
        });

        onStale();
      }
    }, intervalMs);
  }

  /**
   * Stop proactive health monitoring.
   */
  stopProactiveHealthCheck(): void {
    this.healthCheckTimer = clearIntervalSafe(this.healthCheckTimer);
  }

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  /**
   * Reset all metrics (e.g., after disconnect).
   */
  reset(): void {
    this.stopProactiveHealthCheck();
    this.qualityMetrics.lastMessageTime = 0;
    this.qualityMetrics.messageGapMs = 0;
    this.qualityMetrics.lastBlockNumber = 0;
    this.qualityMetrics.reconnectCount = 0;
    this.qualityMetrics.connectionStartTime = 0;
    this.qualityMetrics.messagesReceived = 0;
    this.qualityMetrics.errorsEncountered = 0;
  }
}
