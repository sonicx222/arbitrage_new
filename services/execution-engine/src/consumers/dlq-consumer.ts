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
}

/**
 * Dependencies for DlqConsumer
 */
export interface DlqConsumerDeps {
  streamsClient: RedisStreamsClient;
  logger: Logger;
  scanIntervalMs?: number;
  maxMessagesPerScan?: number;
}

// =============================================================================
// DlqConsumer Class
// =============================================================================

export class DlqConsumer {
  private readonly streamsClient: RedisStreamsClient;
  private readonly logger: Logger;
  private readonly scanIntervalMs: number;
  private readonly maxMessagesPerScan: number;

  private scanTimer: NodeJS.Timeout | null = null;
  private stats: DlqStats = {
    totalCount: 0,
    errorCounts: new Map(),
    oldestEntryAge: null,
    lastScanAt: null,
  };

  constructor(deps: DlqConsumerDeps) {
    this.streamsClient = deps.streamsClient;
    this.logger = deps.logger;
    this.scanIntervalMs = deps.scanIntervalMs ?? 60000; // Default: 1 minute
    this.maxMessagesPerScan = deps.maxMessagesPerScan ?? 100;
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
   * Reads messages from the beginning of the stream (ID '0') to analyze all entries.
   */
  async scanDlq(): Promise<void> {
    try {
      // Read from beginning of stream (ID '0') to get all messages
      const messages = await this.streamsClient.xread(DLQ_STREAM, '0', {
        count: this.maxMessagesPerScan,
      });

      // Reset stats for fresh count
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

      // Update stats
      this.stats = {
        totalCount: messages.length,
        errorCounts,
        oldestEntryAge,
        lastScanAt: Date.now(),
      };

      // Log summary
      if (messages.length > 0) {
        this.logger.info('DLQ scan complete', {
          totalCount: messages.length,
          errorTypes: Array.from(errorCounts.entries()).map(([type, count]) => ({
            type,
            count,
          })),
          oldestEntryAgeMs: oldestEntryAge,
        });
      }
    } catch (error) {
      this.logger.error('DLQ scan failed', { error: getErrorMessage(error) });
      throw error;
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
      await this.streamsClient.xadd(
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
