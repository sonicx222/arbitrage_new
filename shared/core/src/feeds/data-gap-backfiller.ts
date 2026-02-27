/**
 * Data Gap Backfiller
 *
 * Fills missed blockchain events after WebSocket reconnection by fetching
 * historical logs via eth_getLogs. Prevents missed arbitrage opportunities
 * during connection interruptions.
 *
 * Features:
 * - Rate-limited: max 1 backfill per chain per configurable interval
 * - Capped: maximum block range per query to prevent RPC overload
 * - Concurrency-guarded: prevents parallel backfills for the same chain
 * - Event-driven: emits recoveredLogs, backfillComplete, backfillError
 *
 * @see C3 - Data Gap Backfill (Terminal Analysis Consolidated Plan)
 * @see websocket-manager.ts - Emits 'dataGap' events consumed by this module
 */

import { EventEmitter } from 'events';
import { EVENT_SIGNATURES } from '@arbitrage/config';

// =============================================================================
// Types
// =============================================================================

/**
 * Payload emitted by WebSocketManager on 'dataGap' event.
 */
export interface DataGapEvent {
  chainId: string;
  fromBlock: number;
  toBlock: number;
  missedBlocks: number;
  url: string;
}

/**
 * Raw Ethereum log entry returned by eth_getLogs.
 */
export interface EthLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  transactionIndex: string;
  blockHash: string;
  logIndex: string;
  removed: boolean;
}

/**
 * Minimal interface for a data gap source (WebSocketManager or mock).
 * Uses duck typing to avoid circular dependency on WebSocketManager.
 */
export interface DataGapSource {
  on(event: 'dataGap', listener: (gap: DataGapEvent) => void): this;
  off(event: 'dataGap', listener: (gap: DataGapEvent) => void): this;
  sendRequest<T = unknown>(method: string, params?: unknown[], timeoutMs?: number): Promise<T>;
}

/**
 * Configuration for the data gap backfiller.
 */
export interface DataGapBackfillerConfig {
  /** Maximum block range per eth_getLogs query (default: 100) */
  maxBlockRange?: number;
  /** Minimum interval between backfills for the same chain in ms (default: 10000) */
  rateLimitMs?: number;
  /** Timeout for each eth_getLogs request in ms (default: 10000) */
  requestTimeoutMs?: number;
  /** Event topic hashes to query (default: SYNC, SWAP_V2, SWAP_V3) */
  eventTopics?: string[];
}

/**
 * Backfill statistics for monitoring.
 */
export interface BackfillStats {
  backfillsAttempted: number;
  backfillsSucceeded: number;
  backfillsFailed: number;
  backfillsRateLimited: number;
  totalBlocksBackfilled: number;
  totalLogsRecovered: number;
}

/**
 * Logger interface for dependency injection.
 */
export interface DataGapBackfillerLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

// =============================================================================
// Defaults
// =============================================================================

const DEFAULT_EVENT_TOPICS = [
  EVENT_SIGNATURES.SYNC,
  EVENT_SIGNATURES.SWAP_V2,
  EVENT_SIGNATURES.SWAP_V3,
];

const DEFAULT_CONFIG: Required<DataGapBackfillerConfig> = {
  maxBlockRange: 100,
  rateLimitMs: 10_000,
  requestTimeoutMs: 10_000,
  eventTopics: DEFAULT_EVENT_TOPICS,
};

// =============================================================================
// DataGapBackfiller
// =============================================================================

/**
 * Listens for data gap events from WebSocket managers and fetches missed
 * blockchain events via eth_getLogs.
 *
 * @example
 * ```ts
 * const backfiller = new DataGapBackfiller(logger);
 * backfiller.attach(wsManager);
 * backfiller.on('recoveredLogs', ({ chainId, logs }) => {
 *   processRecoveredEvents(chainId, logs);
 * });
 * ```
 */
export class DataGapBackfiller extends EventEmitter {
  private readonly config: Required<DataGapBackfillerConfig>;
  private readonly logger: DataGapBackfillerLogger;
  private readonly stats: BackfillStats = {
    backfillsAttempted: 0,
    backfillsSucceeded: 0,
    backfillsFailed: 0,
    backfillsRateLimited: 0,
    totalBlocksBackfilled: 0,
    totalLogsRecovered: 0,
  };

  /** Last backfill timestamp per chain for rate limiting */
  private lastBackfillTime: Map<string, number> = new Map();

  /** Prevents concurrent backfills for the same chain */
  private activeBackfills: Set<string> = new Set();

  /** Attached sources with their listeners for cleanup */
  private attachedSources: Map<DataGapSource, (gap: DataGapEvent) => void> = new Map();

  constructor(logger: DataGapBackfillerLogger, config?: DataGapBackfillerConfig) {
    super();
    this.logger = logger;
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      eventTopics: config?.eventTopics ?? DEFAULT_EVENT_TOPICS,
    };
  }

  /**
   * Attach to a WebSocketManager (or any DataGapSource) to listen for data gaps.
   * Multiple sources can be attached (e.g., one per chain).
   */
  attach(source: DataGapSource): void {
    if (this.attachedSources.has(source)) {
      return;
    }

    const handler = (gap: DataGapEvent): void => {
      this.handleDataGap(source, gap).catch(error => {
        this.logger.error('Unhandled error in data gap backfill handler', {
          chainId: gap.chainId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    };

    source.on('dataGap', handler);
    this.attachedSources.set(source, handler);
    this.logger.debug('DataGapBackfiller attached to source');
  }

  /**
   * Detach from a specific source.
   */
  detachSource(source: DataGapSource): void {
    const handler = this.attachedSources.get(source);
    if (handler) {
      source.off('dataGap', handler);
      this.attachedSources.delete(source);
    }
  }

  /**
   * Detach from all sources and clean up.
   */
  detach(): void {
    for (const [source, handler] of this.attachedSources) {
      source.off('dataGap', handler);
    }
    this.attachedSources.clear();
    this.activeBackfills.clear();
    this.lastBackfillTime.clear();
  }

  /**
   * Get backfill statistics (returns a copy).
   */
  getStats(): Readonly<BackfillStats> {
    return { ...this.stats };
  }

  /**
   * Check if a backfill is currently active for a chain.
   */
  isBackfillActive(chainId: string): boolean {
    return this.activeBackfills.has(chainId);
  }

  /**
   * Get the number of attached sources.
   */
  getAttachedSourceCount(): number {
    return this.attachedSources.size;
  }

  /**
   * Handle a data gap event. Rate-limits, caps block range, and fetches logs.
   */
  private async handleDataGap(source: DataGapSource, gap: DataGapEvent): Promise<void> {
    const { chainId, fromBlock, toBlock, missedBlocks } = gap;

    // Rate limit: max 1 backfill per chain per rateLimitMs
    const now = Date.now();
    const lastBackfill = this.lastBackfillTime.get(chainId) ?? 0;
    if (now - lastBackfill < this.config.rateLimitMs) {
      this.stats.backfillsRateLimited++;
      this.logger.debug('Backfill rate-limited', {
        chainId,
        timeSinceLastMs: now - lastBackfill,
        rateLimitMs: this.config.rateLimitMs,
      });
      return;
    }

    // Prevent concurrent backfills for the same chain
    if (this.activeBackfills.has(chainId)) {
      this.logger.debug('Backfill already in progress for chain', { chainId });
      return;
    }

    this.activeBackfills.add(chainId);
    this.lastBackfillTime.set(chainId, now);
    this.stats.backfillsAttempted++;

    try {
      // Cap the block range to prevent unbounded queries
      const cappedToBlock = Math.min(toBlock, fromBlock + this.config.maxBlockRange - 1);
      const actualBlocks = cappedToBlock - fromBlock + 1;

      if (cappedToBlock < toBlock) {
        this.logger.warn('Backfill range capped', {
          chainId,
          requestedBlocks: missedBlocks,
          cappedBlocks: actualBlocks,
          maxBlockRange: this.config.maxBlockRange,
        });
      }

      this.logger.info('Starting data gap backfill', {
        chainId,
        fromBlock,
        toBlock: cappedToBlock,
        blocks: actualBlocks,
      });

      const logs = await this.fetchLogs(source, fromBlock, cappedToBlock);

      this.stats.backfillsSucceeded++;
      this.stats.totalBlocksBackfilled += actualBlocks;
      this.stats.totalLogsRecovered += logs.length;

      this.logger.info('Data gap backfill complete', {
        chainId,
        fromBlock,
        toBlock: cappedToBlock,
        logsRecovered: logs.length,
      });

      if (logs.length > 0) {
        this.emit('recoveredLogs', {
          chainId,
          logs,
          fromBlock,
          toBlock: cappedToBlock,
        });
      }

      this.emit('backfillComplete', {
        chainId,
        logsRecovered: logs.length,
        blocksBackfilled: actualBlocks,
      });
    } catch (error) {
      this.stats.backfillsFailed++;
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.logger.error('Data gap backfill failed', {
        chainId,
        fromBlock,
        toBlock,
        error: errorMessage,
      });

      this.emit('backfillError', {
        chainId,
        error: error instanceof Error ? error : new Error(errorMessage),
        fromBlock,
        toBlock,
      });
    } finally {
      this.activeBackfills.delete(chainId);
    }
  }

  /**
   * Fetch logs for a block range using eth_getLogs.
   * Uses the source's sendRequest to issue JSON-RPC calls.
   */
  private async fetchLogs(
    source: DataGapSource,
    fromBlock: number,
    toBlock: number
  ): Promise<EthLog[]> {
    const { requestTimeoutMs, eventTopics } = this.config;

    const params = [{
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: `0x${toBlock.toString(16)}`,
      topics: [eventTopics],
    }];

    const logs = await source.sendRequest<EthLog[]>(
      'eth_getLogs',
      params,
      requestTimeoutMs
    );

    return Array.isArray(logs) ? logs : [];
  }
}
