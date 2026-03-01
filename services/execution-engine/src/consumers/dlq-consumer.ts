/**
 * Dead Letter Queue Consumer
 *
 * Monitors and analyzes messages in the DLQ (Dead Letter Queue) stream for
 * failed opportunity processing. Provides observability into validation
 * failures and optionally supports replaying messages back to the main stream.
 *
 * This is a lightweight monitoring/analysis tool, not a critical path service.
 *
 * Features:
 * - Periodic DLQ scanning with configurable interval
 * - Error type classification and counting
 * - DLQ depth tracking for alerting
 * - Optional message replay capability
 * - Safe lifecycle management with interval cleanup
 *
 * @see opportunity.consumer.ts (writes to DLQ)
 * @see types.ts (DLQ_STREAM constant)
 */

import { clearIntervalSafe } from '@arbitrage/core/async';
import { RedisStreamsClient } from '@arbitrage/core/redis';
import { getErrorMessage } from '@arbitrage/core/resilience';
import type { Logger } from '../types';
import { DLQ_STREAM } from '../types';

// =============================================================================
// Types
// =============================================================================

/**
 * DLQ message format (as written by opportunity.consumer.ts)
 */
export interface DlqMessage {
  originalMessageId: string;
  originalStream: string;
  opportunityId: string;
  opportunityType: string;
  error: string;
  timestamp: number;
  service: string;
  instanceId: string;
  /** Full original message payload preserved for replay capability */
  originalPayload?: string;
}

/**
 * DLQ statistics returned by getDlqStats()
 */
export interface DlqStats {
  /** Total count of messages in DLQ */
  totalCount: number;
  /** Count of messages by error type (extracted from error message) */
  errorCounts: Map<string, number>;
  /** Age of oldest entry in milliseconds (null if DLQ is empty) */
  oldestEntryAge: number | null;
  /** Timestamp of last scan */
  lastScanAt: number | null;
}

/**
 * Configuration for DLQ consumer
 */
export interface DlqConsumerConfig {
  /** Redis Streams client for reading DLQ */
  streamsClient: RedisStreamsClient;
  /** Logger instance */
  logger: Logger;
  /** Scan interval in milliseconds (default: 60000 = 1 minute) */
  scanIntervalMs?: number;
  /** Maximum messages to read per scan (default: 100) */
  maxMessagesPerScan?: number;
  /** F7-FIX: Max age for DLQ messages in ms before auto-trimming (default: 24h, 0 to disable) */
  maxMessageAgeMs?: number;
  /** F7-FIX: Maximum DLQ stream length before trimming (default: 1000, 0 to disable) */
  maxStreamLength?: number;
}

/**
 * Dependencies for DlqConsumer
 */
export interface DlqConsumerDeps {
  streamsClient: RedisStreamsClient;
  logger: Logger;
  scanIntervalMs?: number;
  maxMessagesPerScan?: number;
  maxMessageAgeMs?: number;
  maxStreamLength?: number;
  /** P1-5 FIX: Enable automatic recovery of retryable DLQ messages (default: true) */
  autoRecoveryEnabled?: boolean;
  /** P1-5 FIX: Maximum messages to auto-replay per scan (default: 5) */
  maxAutoReplaysPerScan?: number;
}

// =============================================================================
// DlqConsumer Class
// =============================================================================

export class DlqConsumer {
  private readonly streamsClient: RedisStreamsClient;
  private readonly logger: Logger;
  private readonly scanIntervalMs: number;
  private readonly maxMessagesPerScan: number;
  /** F7-FIX: Max age for DLQ messages before auto-trimming (default: 24h) */
  private readonly maxMessageAgeMs: number;
  /** F7-FIX: Max DLQ stream length before trimming (default: 1000) */
  private readonly maxStreamLength: number;
  /** P1-5 FIX: Auto-recovery configuration */
  private readonly autoRecoveryEnabled: boolean;
  private readonly maxAutoReplaysPerScan: number;

  private scanTimer: NodeJS.Timeout | null = null;
  private stats: DlqStats = {
    totalCount: 0,
    errorCounts: new Map(),
    oldestEntryAge: null,
    lastScanAt: null,
  };

  /**
   * P1-5 FIX: Track recently replayed message IDs to prevent infinite replay loops.
   * Messages stay in this set for 5 minutes (cleared on each scan if older).
   */
  private readonly recentlyReplayed = new Map<string, number>();
  private static readonly REPLAY_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

  /**
   * P1-5 FIX: Error types that indicate transient failures worth retrying.
   * Validation errors (VAL_*) are permanent — the message data won't change.
   * ERR_NO_CHAIN and ERR_NO_STRATEGY are config issues, not transient.
   */
  private static readonly RETRYABLE_ERROR_PATTERNS = [
    'ERR_NONCE',        // Nonce errors resolve on retry
    'ERR_NO_PROVIDER',  // RPC temporarily down, may reconnect
    'ERR_APPROVAL',     // Token approval may succeed on retry
    'ERR_NO_ROUTE',     // Bridge route may become available
    'ERR_NO_BRIDGE',    // Bridge router may initialize later
  ];

  constructor(deps: DlqConsumerDeps) {
    this.streamsClient = deps.streamsClient;
    this.logger = deps.logger;
    this.scanIntervalMs = deps.scanIntervalMs ?? 60000; // Default: 1 minute
    this.maxMessagesPerScan = deps.maxMessagesPerScan ?? 100;
    this.maxMessageAgeMs = deps.maxMessageAgeMs ?? 86_400_000; // Default: 24 hours
    this.maxStreamLength = deps.maxStreamLength ?? 1000; // Default: 1000 messages
    this.autoRecoveryEnabled = deps.autoRecoveryEnabled ?? true;
    this.maxAutoReplaysPerScan = deps.maxAutoReplaysPerScan ?? 5;
  }

  /**
   * Start periodic DLQ scanning.
   * Runs initial scan immediately, then schedules subsequent scans.
   */
  start(): void {
    if (this.scanTimer !== null) {
      this.logger.warn('DLQ consumer already started');
      return;
    }

    this.logger.info('Starting DLQ consumer', {
      scanIntervalMs: this.scanIntervalMs,
      maxMessagesPerScan: this.maxMessagesPerScan,
    });

    // Run initial scan immediately
    this.scanDlq().catch(err => {
      this.logger.error('Initial DLQ scan failed', { error: getErrorMessage(err) });
    });

    // Schedule periodic scans
    this.scanTimer = setInterval(() => {
      this.scanDlq().catch(err => {
        this.logger.error('Periodic DLQ scan failed', { error: getErrorMessage(err) });
      });
    }, this.scanIntervalMs);
  }

  /**
   * Stop periodic DLQ scanning.
   * Clears the scan interval timer safely.
   */
  stop(): void {
    if (this.scanTimer === null) {
      return;
    }

    this.logger.info('Stopping DLQ consumer');
    this.scanTimer = clearIntervalSafe(this.scanTimer);
  }

  /**
   * Scan the DLQ stream and update statistics.
   *
   * P2 Fix F-4: Uses XLEN for accurate total count instead of messages.length,
   * which was capped by maxMessagesPerScan. The scan still reads from '0' each
   * time for full error classification, but totalCount reflects the true stream size.
   */
  async scanDlq(): Promise<void> {
    try {
      const messages = await this.streamsClient.xread(DLQ_STREAM, '0', {
        count: this.maxMessagesPerScan,
      });

      // P2 Fix F-4: Use XLEN for accurate total count (not capped by maxMessagesPerScan)
      const totalCount = await this.streamsClient.xlen(DLQ_STREAM);

      const errorCounts = new Map<string, number>();
      let oldestTimestamp: number | null = null;

      for (const message of messages) {
        const dlqMessage = message.data as unknown as DlqMessage;

        // Extract error type from error message (e.g., "[VAL_MISSING_ID]" or "[ERR_NO_CHAIN]")
        const errorType = this.extractErrorType(dlqMessage.error);
        errorCounts.set(errorType, (errorCounts.get(errorType) ?? 0) + 1);

        // Track oldest entry
        if (oldestTimestamp === null || dlqMessage.timestamp < oldestTimestamp) {
          oldestTimestamp = dlqMessage.timestamp;
        }
      }

      // Calculate oldest entry age
      const oldestEntryAge = oldestTimestamp !== null ? Date.now() - oldestTimestamp : null;

      // Update stats with XLEN-based total count
      this.stats = {
        totalCount,
        errorCounts,
        oldestEntryAge,
        lastScanAt: Date.now(),
      };

      // Log summary when messages are found
      if (messages.length > 0) {
        this.logger.info('DLQ scan complete', {
          totalCount,
          errorTypes: Array.from(errorCounts.entries()).map(([type, count]) => ({
            type,
            count,
          })),
          oldestEntryAgeMs: oldestEntryAge,
        });
      }

      // P1-5 FIX: Attempt auto-recovery for retryable error types
      if (this.autoRecoveryEnabled && messages.length > 0) {
        await this.autoRecoverRetryable(messages);
      }

      // F7-FIX: Auto-trim old messages from DLQ
      await this.autoTrimDlq(totalCount);
    } catch (error) {
      this.logger.error('DLQ scan failed', { error: getErrorMessage(error) });
      throw error;
    }
  }

  /**
   * F7-FIX: Automatically trim stale DLQ messages.
   * Uses MINID-based trimming (by age) and MAXLEN-based trimming (by count).
   * Both thresholds use approximate trimming (~) for Redis efficiency.
   */
  private async autoTrimDlq(currentLength: number): Promise<void> {
    let trimmed = 0;

    // Age-based trimming: remove messages older than maxMessageAgeMs
    if (this.maxMessageAgeMs > 0) {
      // Redis stream IDs encode timestamps: <ms_timestamp>-<seq>
      const cutoffMs = Date.now() - this.maxMessageAgeMs;
      const minId = `${cutoffMs}-0`;
      try {
        const ageResult = await this.streamsClient.xtrim(DLQ_STREAM, { minId });
        trimmed += ageResult;
      } catch (error) {
        this.logger.warn('DLQ age-based trim failed', { error: getErrorMessage(error) });
      }
    }

    // Length-based trimming: cap the stream at maxStreamLength
    if (this.maxStreamLength > 0 && currentLength > this.maxStreamLength) {
      try {
        const lenResult = await this.streamsClient.xtrim(DLQ_STREAM, { maxLen: this.maxStreamLength });
        trimmed += lenResult;
      } catch (error) {
        this.logger.warn('DLQ length-based trim failed', { error: getErrorMessage(error) });
      }
    }

    if (trimmed > 0) {
      this.logger.info('DLQ auto-trimmed stale messages', {
        trimmedCount: trimmed,
        maxMessageAgeMs: this.maxMessageAgeMs,
        maxStreamLength: this.maxStreamLength,
      });
    }
  }

  /**
   * P1-5 FIX: Attempt automatic recovery for messages with retryable error types.
   * Replays up to maxAutoReplaysPerScan messages per scan, with cooldown tracking
   * to prevent infinite replay loops for persistently failing messages.
   */
  private async autoRecoverRetryable(
    messages: Array<{ id: string; data: unknown }>
  ): Promise<void> {
    // Clean up expired cooldown entries
    const now = Date.now();
    for (const [id, timestamp] of this.recentlyReplayed) {
      if (now - timestamp > DlqConsumer.REPLAY_COOLDOWN_MS) {
        this.recentlyReplayed.delete(id);
      }
    }

    // Find retryable messages that haven't been recently replayed
    const retryableCandidates: Array<{ id: string; data: DlqMessage }> = [];
    for (const message of messages) {
      if (retryableCandidates.length >= this.maxAutoReplaysPerScan) break;

      const dlqMessage = message.data as unknown as DlqMessage;

      // Skip already-replayed messages (would create loop)
      if (this.recentlyReplayed.has(message.id)) continue;

      // Skip messages without original payload (can't replay without data)
      if (!dlqMessage.originalPayload) continue;

      // Check if error type is retryable
      const errorType = this.extractErrorType(dlqMessage.error);
      const isRetryable = DlqConsumer.RETRYABLE_ERROR_PATTERNS.some(
        pattern => errorType === pattern
      );

      if (isRetryable) {
        retryableCandidates.push({ id: message.id, data: dlqMessage });
      }
    }

    if (retryableCandidates.length === 0) return;

    let replayed = 0;
    let failed = 0;

    for (const candidate of retryableCandidates) {
      try {
        // Parse and replay the original payload
        const replayData = JSON.parse(candidate.data.originalPayload!) as Record<string, unknown>;
        replayData.replayed = true;
        replayData.originalError = candidate.data.error;
        replayData.replayedAt = now;

        await this.streamsClient.xaddWithLimit(
          RedisStreamsClient.STREAMS.EXECUTION_REQUESTS,
          replayData
        );

        // Track as recently replayed to prevent re-replay
        this.recentlyReplayed.set(candidate.id, now);
        replayed++;
      } catch {
        failed++;
      }
    }

    if (replayed > 0 || failed > 0) {
      this.logger.info('DLQ auto-recovery attempted', {
        retryableCandidates: retryableCandidates.length,
        replayed,
        failed,
        cooldownActive: this.recentlyReplayed.size,
      });
    }
  }

  /**
   * Get current DLQ statistics.
   * Returns a snapshot of the most recent scan results.
   */
  getDlqStats(): DlqStats {
    return {
      ...this.stats,
      errorCounts: new Map(this.stats.errorCounts), // Return a copy
    };
  }

  /**
   * Replay a specific DLQ message back to the main execution stream.
   *
   * Requires that the original message payload was preserved in the DLQ entry
   * (via `originalPayload` field). Messages without a stored payload cannot be
   * replayed — the original opportunity data is needed for validation.
   *
   * WARNING: This does NOT validate the message. Use with caution.
   * The replayed message will go through normal validation in the opportunity consumer.
   *
   * @param messageId - DLQ message ID to replay
   * @returns True if replay succeeded, false if message not found or payload missing
   */
  async replayMessage(messageId: string): Promise<boolean> {
    try {
      // Paginate through DLQ to find the target message (stream may have >100 entries)
      // Limit to 100 pages to prevent unbounded scanning of large DLQ streams
      const MAX_REPLAY_PAGES = 100;
      let cursor = '0';
      let targetMessage: { id: string; data: unknown } | undefined;
      let pagesScanned = 0;

      do {
        const messages = await this.streamsClient.xread(DLQ_STREAM, cursor, {
          count: this.maxMessagesPerScan,
        });

        if (messages.length === 0) break;
        pagesScanned++;

        targetMessage = messages.find(m => m.id === messageId);
        if (targetMessage) break;

        // Advance cursor to last message ID for next page
        cursor = messages[messages.length - 1].id;
      } while (!targetMessage && pagesScanned < MAX_REPLAY_PAGES);

      if (pagesScanned >= MAX_REPLAY_PAGES && !targetMessage) {
        this.logger.warn('DLQ replay scan hit page limit', {
          messageId,
          pagesScanned,
          maxPages: MAX_REPLAY_PAGES,
        });
      }

      if (!targetMessage) {
        this.logger.warn('DLQ message not found for replay', { messageId });
        return false;
      }

      const dlqMessage = targetMessage.data as unknown as DlqMessage;

      // Verify original payload is available for replay
      if (!dlqMessage.originalPayload) {
        this.logger.error('DLQ message has no stored payload — cannot replay', {
          messageId,
          opportunityId: dlqMessage.opportunityId,
        });
        return false;
      }

      // Parse the preserved original payload
      let replayData: Record<string, unknown>;
      try {
        replayData = JSON.parse(dlqMessage.originalPayload) as Record<string, unknown>;
      } catch {
        this.logger.error('DLQ message has corrupt payload — cannot replay', {
          messageId,
          opportunityId: dlqMessage.opportunityId,
        });
        return false;
      }

      // Mark as replayed for tracking/dedup
      replayData.replayed = true;
      replayData.originalError = dlqMessage.error;
      replayData.replayedAt = Date.now();

      // Send back to execution requests stream
      await this.streamsClient.xaddWithLimit(
        RedisStreamsClient.STREAMS.EXECUTION_REQUESTS,
        replayData
      );

      this.logger.info('DLQ message replayed', {
        messageId,
        opportunityId: dlqMessage.opportunityId,
      });

      return true;
    } catch (error) {
      this.logger.error('Failed to replay DLQ message', {
        messageId,
        error: getErrorMessage(error),
      });
      throw error;
    }
  }

  /**
   * Extract error type code from error message.
   * Looks for patterns like "[VAL_MISSING_ID]" or "[ERR_NO_CHAIN]".
   *
   * @param errorMessage - Full error message string
   * @returns Extracted error code or 'UNKNOWN' if no pattern found
   */
  private extractErrorType(errorMessage: string): string {
    // Match error codes in brackets: [VAL_*], [ERR_*], etc.
    const match = errorMessage.match(/\[(VAL_[A-Z_]+|ERR_[A-Z_]+)\]/);
    return match ? match[1] : 'UNKNOWN';
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a DLQ consumer instance.
 * Follows constructor DI pattern for testability.
 *
 * @param deps - DLQ consumer dependencies
 * @returns DlqConsumer instance
 */
export function createDlqConsumer(deps: DlqConsumerDeps): DlqConsumer {
  return new DlqConsumer(deps);
}
