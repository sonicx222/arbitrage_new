/**
 * Opportunity Router
 *
 * Manages arbitrage opportunity lifecycle:
 * - Storage with size limits
 * - Duplicate detection
 * - Expiry cleanup
 * - Forwarding to execution engine
 *
 * @see R2 - Coordinator Subsystems extraction
 */

import fsPromises from 'fs/promises';
import pathModule from 'path';
import { RedisStreams, normalizeChainId, isCanonicalChainId, type ArbitrageOpportunity } from '@arbitrage/types';
import { findKSmallest } from '@arbitrage/core/data-structures';
import type { TraceContext } from '@arbitrage/core/tracing';
import { serializeOpportunityForStream } from '../utils/stream-serialization';

/**
 * Logger interface for dependency injection
 */
export interface OpportunityRouterLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Redis streams client interface (subset needed by router)
 *
 * FIX W2-8: Extended with options parameter to support MAXLEN trimming.
 */
export interface OpportunityStreamsClient {
  xadd(streamName: string, data: Record<string, unknown>, id?: string, options?: { maxLen?: number; approximate?: boolean }): Promise<string>;
  xaddWithLimit(streamName: string, data: Record<string, unknown>, options?: { approximate?: boolean }): Promise<string>;
}

/**
 * Circuit breaker interface for execution forwarding
 */
export interface CircuitBreaker {
  isCurrentlyOpen(): boolean;
  recordFailure(): boolean;
  recordSuccess(): boolean;
  getFailures(): number;
  getStatus(): { isOpen: boolean; failures: number; resetTimeoutMs: number };
}

/**
 * Alert callback for opportunity events
 */
export interface OpportunityAlert {
  type: 'EXECUTION_CIRCUIT_OPEN' | 'EXECUTION_FORWARD_FAILED';
  message: string;
  severity: 'warning' | 'high' | 'critical';
  data: Record<string, unknown>;
  timestamp: number;
}

/**
 * Configuration for the opportunity router
 */
export interface OpportunityRouterConfig {
  /** Maximum opportunities to keep in memory (default: 1000) */
  maxOpportunities?: number;
  /** Opportunity TTL in milliseconds (default: 60000) */
  opportunityTtlMs?: number;
  /**
   * Duplicate detection window in milliseconds (default: 5000).
   *
   * Why 5 seconds: Balances catching legitimate duplicates from multiple
   * partition detectors seeing the same on-chain event, versus filtering
   * out genuinely distinct opportunities on the same pair. At typical
   * block times (2-12s), a 5s window covers 1-2 blocks — sufficient to
   * catch cross-partition duplicates without being overly aggressive.
   *
   * Note: Consumer group pending messages (un-ACKed, redelivered by Redis)
   * are handled separately by Redis Streams, not by this deduplication.
   */
  duplicateWindowMs?: number;
  /** Instance ID for forwarding metadata */
  instanceId?: string;
  /** Execution requests stream name */
  executionRequestsStream?: string;
  /** Minimum profit percentage (default: -100) */
  minProfitPercentage?: number;
  /** Maximum profit percentage (default: 10000) */
  maxProfitPercentage?: number;
  /** @see OP-14: Per-chain TTL overrides for fast chains (default: built-in fast chain defaults) */
  chainTtlOverrides?: Record<string, number>;
  // P1-7 FIX: Retry and DLQ configuration
  /** Maximum retry attempts for forwarding failures (default: 3) */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff (default: 10) */
  retryBaseDelayMs?: number;
  /** Dead letter queue stream for FORWARDING failures (default: 'stream:forwarding-dlq').
   * P2 FIX #21 NOTE: Intentionally separate from StreamConsumerManager's
   * 'stream:dead-letter-queue' — different failure mode, different schema. */
  dlqStream?: string;
  /** FIX W2-8: MAXLEN for execution requests stream to prevent unbounded growth (default: 5000) */
  executionStreamMaxLen?: number;
  /**
   * RT-003 FIX: Grace period in ms after router creation before forwarding begins (default: 5000).
   * Prevents the startup race where the coordinator forwards opportunities before
   * the execution engine consumer is ready, causing the first message to expire in
   * transit and land in the DLQ.
   */
  startupGracePeriodMs?: number;
}

/**
 * OP-14: Default chain-specific TTL overrides for fast chains.
 * Fast L2s and Solana produce blocks much faster than the 60s global TTL,
 * so opportunities go stale before execution.
 */
const DEFAULT_CHAIN_TTL_OVERRIDES: Record<string, number> = {
  arbitrum: 15000,   // ~60 blocks at 250ms
  optimism: 15000,   // Similar to Arbitrum
  base: 15000,       // Optimism-based
  zksync: 15000,     // ~15 blocks at 1s
  linea: 15000,      // Similar L2 characteristics
  solana: 10000,     // ~25 slots at 400ms
};

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<OpportunityRouterConfig> = {
  maxOpportunities: 1000,
  opportunityTtlMs: 60000,
  duplicateWindowMs: 5000,
  instanceId: 'coordinator',
  executionRequestsStream: RedisStreams.EXECUTION_REQUESTS,
  minProfitPercentage: -100,
  // P0-3 FIX: Lowered from 10,000% to 100%. Even 100% (doubling money) is
  // extremely generous for a single arbitrage trade. The previous 10,000% cap
  // allowed astronomically unrealistic profits through to execution.
  maxProfitPercentage: 100,
  // OP-14: Default chain-specific TTL overrides
  chainTtlOverrides: DEFAULT_CHAIN_TTL_OVERRIDES,
  // P1-7 FIX: Retry and DLQ defaults
  maxRetries: 3,
  retryBaseDelayMs: 10,
  dlqStream: RedisStreams.FORWARDING_DLQ,
  // FIX W2-8: Prevent unbounded stream growth (matches RedisStreamsClient.STREAM_MAX_LENGTHS)
  executionStreamMaxLen: 5000,
  // RT-003 FIX: Grace period for execution engine consumer initialization.
  // RT-004 FIX: Increased from 5s to 15s — execution engine initialization
  // (Redis, nonce manager, providers, KMS, MEV, strategies, risk management,
  // bridge recovery, consumer group creation) typically takes 7-12s.
  startupGracePeriodMs: 15000,
};

/**
 * Opportunity Router
 *
 * Manages the lifecycle of arbitrage opportunities from detection to execution.
 */
export class OpportunityRouter {
  private readonly config: Required<OpportunityRouterConfig>;
  private readonly logger: OpportunityRouterLogger;
  private readonly streamsClient: OpportunityStreamsClient | null;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly onAlert?: (alert: OpportunityAlert) => void;

  private readonly opportunities: Map<string, ArbitrageOpportunity> = new Map();

  // Metrics counters (exposed for coordinator to track)
  private _totalOpportunities = 0;
  private _totalExecutions = 0;
  // P1-7 FIX: Track dropped opportunities for monitoring
  private _opportunitiesDropped = 0;
  // P1-8 FIX: Shutdown flag to cancel in-flight retry delays
  private _shuttingDown = false;
  // RT-003 FIX: Startup grace period — defer forwarding until execution engine consumer is ready
  private readonly _createdAt = Date.now();
  // Consumer lag detection: tracks consecutive expired opportunities.
  // When this exceeds the threshold, the coordinator should skip its consumer
  // backlog to avoid the death spiral where processing stale messages causes
  // even more messages to expire.
  private _consecutiveExpired = 0;
  private static readonly CONSECUTIVE_EXPIRED_WARN_THRESHOLD = 20;

  constructor(
    logger: OpportunityRouterLogger,
    circuitBreaker: CircuitBreaker,
    streamsClient?: OpportunityStreamsClient | null,
    config?: OpportunityRouterConfig,
    onAlert?: (alert: OpportunityAlert) => void
  ) {
    this.logger = logger;
    this.circuitBreaker = circuitBreaker;
    this.streamsClient = streamsClient ?? null;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.onAlert = onAlert;
  }

  /**
   * Get the opportunities map (for API endpoints).
   * Returns a ReadonlyMap backed by the internal map (O(1), no copy).
   */
  getOpportunities(): ReadonlyMap<string, ArbitrageOpportunity> {
    return this.opportunities;
  }

  /**
   * Get pending opportunities count
   */
  getPendingCount(): number {
    return this.opportunities.size;
  }

  /**
   * Get total opportunities processed
   */
  getTotalOpportunities(): number {
    return this._totalOpportunities;
  }

  /**
   * Get total executions forwarded
   */
  getTotalExecutions(): number {
    return this._totalExecutions;
  }

  /**
   * P1-7 FIX: Get total opportunities dropped due to forwarding failures
   */
  getOpportunitiesDropped(): number {
    return this._opportunitiesDropped;
  }

  /**
   * Get the count of consecutive expired opportunities.
   * When this exceeds the threshold, the consumer is lagging and should skip its backlog.
   */
  getConsecutiveExpired(): number {
    return this._consecutiveExpired;
  }

  /**
   * Reset the consecutive expired counter after a backlog skip (SETID to '$').
   * Without this reset, every subsequent message triggers a redundant SETID call,
   * adding latency that causes even more messages to expire — a death spiral
   * within the fix itself.
   */
  resetConsecutiveExpired(): void {
    this._consecutiveExpired = 0;
  }

  /**
   * Process an incoming opportunity.
   * Handles duplicate detection, validation, storage, and optional forwarding.
   *
   * @param data - Raw opportunity data from stream message
   * @param isLeader - Whether this instance should forward to execution
   * @param traceContext - OP-3 FIX: Optional trace context for cross-service correlation
   * @returns true if opportunity was processed, false if rejected
   */
  async processOpportunity(
    data: Record<string, unknown>,
    isLeader: boolean,
    traceContext?: TraceContext,
  ): Promise<boolean> {
    const id = data.id as string | undefined;
    if (!id || typeof id !== 'string') {
      this.logger.debug('Skipping opportunity - missing or invalid id');
      return false;
    }

    const timestamp = typeof data.timestamp === 'number' ? data.timestamp : Date.now();

    // Duplicate detection
    const existing = this.opportunities.get(id);
    if (existing && Math.abs((existing.timestamp ?? 0) - timestamp) < this.config.duplicateWindowMs) {
      this.logger.debug('Duplicate opportunity detected, skipping', {
        id,
        existingTimestamp: existing.timestamp,
        newTimestamp: timestamp,
      });
      return false;
    }

    // Input validation for profit percentage
    const profitPercentage = typeof data.profitPercentage === 'number' ? data.profitPercentage : undefined;
    if (profitPercentage !== undefined) {
      if (profitPercentage < this.config.minProfitPercentage || profitPercentage > this.config.maxProfitPercentage) {
        this.logger.warn('Invalid profit percentage, rejecting opportunity', {
          id,
          profitPercentage,
          reason: profitPercentage < this.config.minProfitPercentage ? 'below_minimum' : 'above_maximum',
        });
        return false;
      }
    }

    // H2 FIX: Validate chain against canonical chain ID whitelist.
    // Defense-in-depth: HMAC signing at the transport layer is the primary defense,
    // but we also reject opportunities with unrecognized chains to prevent processing
    // of forged or misconfigured data.
    const rawChain = typeof data.chain === 'string' ? data.chain : undefined;
    if (rawChain) {
      const normalized = normalizeChainId(rawChain);
      if (!isCanonicalChainId(normalized)) {
        this.logger.warn('Unknown chain in opportunity, rejecting', {
          id,
          chain: rawChain,
          normalizedChain: normalized,
        });
        return false;
      }
    }

    // Build opportunity object — pass through ALL fields required by downstream
    // consumers (serializer, execution engine validation).
    // P0-1 FIX: Previously only 9 fields were whitelisted, dropping tokenIn, tokenOut,
    // amountIn, type, and 10+ other fields. The serializer then produced empty strings
    // for missing fields, and the execution engine rejected them (100% DLQ rate).
    const tokenIn = typeof data.tokenIn === 'string' ? data.tokenIn : undefined;
    const tokenOut = typeof data.tokenOut === 'string' ? data.tokenOut : undefined;
    const token0 = typeof data.token0 === 'string' ? data.token0 : undefined;
    const token1 = typeof data.token1 === 'string' ? data.token1 : undefined;

    const opportunity: ArbitrageOpportunity = {
      id,
      type: typeof data.type === 'string' ? data.type as ArbitrageOpportunity['type'] : undefined,
      confidence: typeof data.confidence === 'number' ? data.confidence : 0,
      timestamp,
      chain: typeof data.chain === 'string' ? data.chain : undefined,
      buyDex: typeof data.buyDex === 'string' ? data.buyDex : undefined,
      sellDex: typeof data.sellDex === 'string' ? data.sellDex : undefined,
      buyChain: typeof data.buyChain === 'string' ? data.buyChain : undefined,
      sellChain: typeof data.sellChain === 'string' ? data.sellChain : undefined,
      profitPercentage,
      // P0-1 FIX: Pass through token fields. Fall back to token0/token1 (Solana partition
      // uses these instead of tokenIn/tokenOut).
      tokenIn: tokenIn ?? token0,
      tokenOut: tokenOut ?? token1,
      token0,
      token1,
      amountIn: typeof data.amountIn === 'string' ? data.amountIn : undefined,
      buyPrice: typeof data.buyPrice === 'number' ? data.buyPrice : undefined,
      sellPrice: typeof data.sellPrice === 'number' ? data.sellPrice : undefined,
      expectedProfit: typeof data.expectedProfit === 'number' ? data.expectedProfit : undefined,
      estimatedProfit: typeof data.estimatedProfit === 'number' ? data.estimatedProfit : undefined,
      gasEstimate: typeof data.gasEstimate === 'string' ? data.gasEstimate : undefined,
      expiresAt: typeof data.expiresAt === 'number' ? data.expiresAt : undefined,
      status: typeof data.status === 'string' ? data.status as ArbitrageOpportunity['status'] : undefined,
      blockNumber: typeof data.blockNumber === 'number' ? data.blockNumber : undefined,
      useFlashLoan: typeof data.useFlashLoan === 'boolean' ? data.useFlashLoan : undefined,
      buyPair: typeof data.buyPair === 'string' ? data.buyPair : undefined,
      sellPair: typeof data.sellPair === 'string' ? data.sellPair : undefined,
    };

    // Store opportunity
    this.opportunities.set(id, opportunity);
    this._totalOpportunities++;

    this.logger.info('Opportunity detected', {
      id,
      chain: opportunity.chain,
      profitPercentage: opportunity.profitPercentage,
      buyDex: opportunity.buyDex,
      sellDex: opportunity.sellDex,
    });

    // P3-FIX: Check expiry BEFORE forwarding to execution engine.
    // Without this, the coordinator forwards already-expired opportunities from its
    // consumer backlog. The execution engine then rejects them all with VAL_EXPIRED
    // (200-265s lag), producing 0 execution results and growing the DLQ continuously.
    if (opportunity.expiresAt !== undefined && opportunity.expiresAt < Date.now()) {
      this._consecutiveExpired++;

      // Log at WARN level periodically when consumer is lagging — debug-only logging
      // made this failure mode invisible during monitoring sessions.
      if (this._consecutiveExpired === OpportunityRouter.CONSECUTIVE_EXPIRED_WARN_THRESHOLD) {
        this.logger.warn('Consumer lag detected: many consecutive opportunities expired before processing', {
          consecutiveExpired: this._consecutiveExpired,
          latestExpiredAgoMs: Date.now() - opportunity.expiresAt,
          chain: opportunity.chain,
        });
      } else if (this._consecutiveExpired > 0 && this._consecutiveExpired % 100 === 0) {
        this.logger.warn('Consumer lag persisting: opportunities continue to expire', {
          consecutiveExpired: this._consecutiveExpired,
          latestExpiredAgoMs: Date.now() - opportunity.expiresAt,
        });
      }

      return true; // Still counts as processed (stored), just not forwarded
    }

    // Reset consecutive expired counter when a fresh opportunity is found
    if (this._consecutiveExpired > 0) {
      this.logger.info('Consumer lag recovered: processing fresh opportunities again', {
        previousConsecutiveExpired: this._consecutiveExpired,
      });
      this._consecutiveExpired = 0;
    }

    // Forward to execution engine if leader and pending
    if (isLeader && (opportunity.status === 'pending' || opportunity.status === undefined)) {
      await this.forwardToExecutionEngine(opportunity, traceContext);
    } else {
      const reason = !isLeader ? 'not_leader' : 'status_not_pending';
      this.logger.debug('Opportunity stored but not forwarded', {
        id,
        reason,
        isLeader,
        status: opportunity.status,
      });
    }

    return true;
  }

  /**
   * Forward an opportunity to the execution engine via Redis Streams.
   *
   * P1-7 FIX: Now includes retry logic with exponential backoff and DLQ support.
   * Retries up to maxRetries times before moving to dead letter queue.
   *
   * OP-3 FIX: Now propagates trace context for cross-service correlation.
   *
   * Only the leader coordinator should call this method to prevent
   * duplicate execution attempts.
   */
  async forwardToExecutionEngine(opportunity: ArbitrageOpportunity, traceContext?: TraceContext): Promise<void> {
    if (!this.streamsClient) {
      this.logger.warn('Cannot forward opportunity - streams client not initialized', {
        id: opportunity.id,
      });
      return;
    }

    // RT-003 FIX: Defer forwarding during startup grace period.
    // The execution engine consumer takes ~2s to initialize after the coordinator
    // starts forwarding. Without this, the first opportunity expires in transit
    // (~1.6s) and lands in the DLQ every startup cycle.
    const elapsedSinceStart = Date.now() - this._createdAt;
    if (elapsedSinceStart < this.config.startupGracePeriodMs) {
      this.logger.debug('Startup grace period active — deferring opportunity forwarding', {
        id: opportunity.id,
        elapsedMs: elapsedSinceStart,
        gracePeriodMs: this.config.startupGracePeriodMs,
      });
      return;
    }

    // Check circuit breaker before attempting to forward
    if (this.circuitBreaker.isCurrentlyOpen()) {
      this.logger.debug('Execution circuit open, skipping opportunity forwarding', {
        id: opportunity.id,
        failures: this.circuitBreaker.getFailures(),
      });
      // P1-7 FIX: Track as dropped when circuit is open
      this._opportunitiesDropped++;
      // OP-2 FIX: Write to DLQ instead of silently dropping.
      // Circuit breaker drops can last minutes — these opportunities are recoverable
      // for analysis and potential manual replay once the circuit closes.
      await this.moveToDeadLetterQueue(opportunity, new Error('Circuit breaker open'));
      return;
    }

    // Phase 0 instrumentation: stamp coordinator timestamp before serialization
    const timestamps = opportunity.pipelineTimestamps ?? {};
    timestamps.coordinatorAt = Date.now();
    opportunity.pipelineTimestamps = timestamps;

    // FIX #12: Use shared serialization utility (single source of truth)
    // OP-3 FIX: Pass trace context for cross-service correlation
    const messageData = serializeOpportunityForStream(opportunity, this.config.instanceId, traceContext);

    // P1-7 FIX: Retry loop with exponential backoff
    // P1-8 FIX: Check shutdown flag before each attempt
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      if (this._shuttingDown) {
        this.logger.debug('Retry loop aborted due to shutdown', { id: opportunity.id, attempt });
        this._opportunitiesDropped++;
        return;
      }
      try {
        // SA-005 FIX: Use xaddWithLimit for automatic MAXLEN from STREAM_MAX_LENGTHS
        await this.streamsClient.xaddWithLimit(this.config.executionRequestsStream, messageData);

        // Success - record and return
        const justRecovered = this.circuitBreaker.recordSuccess();
        if (justRecovered) {
          this.logger.info('Execution circuit breaker closed - recovered');
        }

        this.logger.info('Forwarded opportunity to execution engine', {
          id: opportunity.id,
          chain: opportunity.chain,
          profitPercentage: opportunity.profitPercentage,
          attempt: attempt + 1,
        });

        this._totalExecutions++;
        return; // Success, exit the method

      } catch (error) {
        lastError = error as Error;

        // Record failure for circuit breaker
        const justOpened = this.circuitBreaker.recordFailure();

        if (justOpened) {
          const status = this.circuitBreaker.getStatus();
          this.logger.warn('Execution circuit breaker opened', {
            failures: status.failures,
            resetTimeoutMs: status.resetTimeoutMs,
          });

          this.onAlert?.({
            type: 'EXECUTION_CIRCUIT_OPEN',
            message: `Execution forwarding circuit breaker opened after ${status.failures} failures`,
            severity: 'high',
            data: { failures: status.failures },
            timestamp: Date.now(),
          });
          // Don't retry if circuit breaker just opened
          break;
        }

        // Don't retry if circuit breaker is already open
        if (this.circuitBreaker.isCurrentlyOpen()) {
          break;
        }

        // Log retry attempt
        if (attempt < this.config.maxRetries - 1) {
          const delay = this.config.retryBaseDelayMs * Math.pow(2, attempt);
          this.logger.debug('Retrying opportunity forwarding', {
            id: opportunity.id,
            attempt: attempt + 1,
            maxRetries: this.config.maxRetries,
            nextDelayMs: delay,
            error: lastError.message,
          });
          // Exponential backoff: 10ms, 20ms, 40ms...
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    // P1-7 FIX: All retries exhausted - permanent failure
    this._opportunitiesDropped++;
    const status = this.circuitBreaker.getStatus();

    this.logger.error('Failed to forward opportunity after all retries', {
      id: opportunity.id,
      error: lastError?.message,
      attempts: this.config.maxRetries,
      circuitFailures: status.failures,
      totalDropped: this._opportunitiesDropped,
    });

    // Move to DLQ for later analysis/manual intervention
    await this.moveToDeadLetterQueue(opportunity, lastError);

    // Send alert for permanent forwarding failures (only if circuit not already open)
    if (!status.isOpen) {
      this.onAlert?.({
        type: 'EXECUTION_FORWARD_FAILED',
        message: `Failed to forward opportunity ${opportunity.id} after ${this.config.maxRetries} retries: ${lastError?.message}`,
        severity: 'high',
        data: {
          opportunityId: opportunity.id,
          chain: opportunity.chain,
          attempts: this.config.maxRetries,
          totalDropped: this._opportunitiesDropped,
        },
        timestamp: Date.now(),
      });
    }
  }

  /**
   * P1-7 FIX: Move failed opportunity to dead letter queue for later analysis.
   *
   * DLQ entries include original opportunity data plus error context,
   * allowing for debugging and potential manual replay if needed.
   */
  private async moveToDeadLetterQueue(
    opportunity: ArbitrageOpportunity,
    error: Error | null
  ): Promise<void> {
    if (!this.streamsClient) {
      return;
    }

    try {
      await this.streamsClient.xaddWithLimit(this.config.dlqStream, {
        opportunityId: opportunity.id,
        originalData: JSON.stringify(opportunity),
        error: error?.message || 'Unknown error',
        errorStack: error?.stack?.substring(0, 500),
        failedAt: Date.now().toString(),
        service: 'opportunity-router',
        instanceId: this.config.instanceId,
        targetStream: this.config.executionRequestsStream,
      });

      this.logger.debug('Opportunity moved to DLQ', {
        opportunityId: opportunity.id,
        dlqStream: this.config.dlqStream,
      });
    } catch (dlqError) {
      // OP-16 FIX: If DLQ write fails, write to local file as last-resort backup
      this.logger.error('Failed to move opportunity to DLQ, writing to local fallback', {
        opportunityId: opportunity.id,
        dlqError: (dlqError as Error).message,
        originalError: error?.message,
      });
      this.writeLocalDlqFallback(opportunity, error);
    }
  }

  /**
   * OP-16 FIX: Write failed opportunity to local file when Redis DLQ is unavailable.
   * Last-resort backup for double-failure scenarios.
   */
  /** FIX 4.3: Maximum DLQ fallback file size per day (100MB) */
  private static readonly MAX_DLQ_FILE_BYTES = 100 * 1024 * 1024;

  private async writeLocalDlqFallback(
    opportunity: ArbitrageOpportunity,
    error: Error | null
  ): Promise<void> {
    try {
      const date = new Date().toISOString().split('T')[0];
      const dir = pathModule.resolve('data');
      await fsPromises.mkdir(dir, { recursive: true });
      const filePath = pathModule.join(dir, `dlq-forwarding-fallback-${date}.jsonl`);

      // FIX 4.3: Enforce 100MB daily file size limit to prevent disk exhaustion
      try {
        const stat = await fsPromises.stat(filePath);
        if (stat.size >= OpportunityRouter.MAX_DLQ_FILE_BYTES) {
          this.logger.warn('DLQ fallback file size limit reached, dropping message', {
            filePath,
            sizeBytes: stat.size,
            limitBytes: OpportunityRouter.MAX_DLQ_FILE_BYTES,
            opportunityId: opportunity.id,
          });
          return;
        }
      } catch {
        // File doesn't exist yet — proceed to create it
      }

      const entry = JSON.stringify({
        opportunityId: opportunity.id,
        originalData: opportunity,
        error: error?.message ?? 'Unknown error',
        failedAt: Date.now(),
        service: 'opportunity-router',
        instanceId: this.config.instanceId,
      });
      await fsPromises.appendFile(filePath, entry + '\n');
    } catch (fileError) {
      this.logger.error('Local DLQ fallback write also failed', {
        opportunityId: opportunity.id,
        fileError: (fileError as Error).message,
      });
    }
  }

  /**
   * Clean up expired opportunities.
   *
   * This should be called on a separate interval (e.g., every 10s) to prevent
   * race conditions with concurrent message handlers.
   *
   * @returns Number of opportunities removed
   */
  cleanupExpiredOpportunities(): number {
    const now = Date.now();
    const toDelete: string[] = [];
    const initialSize = this.opportunities.size;

    // Phase 1: Identify expired opportunities
    for (const [id, opp] of this.opportunities) {
      // Delete if explicitly expired
      if (opp.expiresAt && opp.expiresAt < now) {
        toDelete.push(id);
        continue;
      }
      // Delete if older than TTL (for opportunities without expiresAt)
      // OP-14 FIX: Use chain-specific TTL if available, fall back to global default
      const ttl = (opp.chain ? this.config.chainTtlOverrides[opp.chain] : undefined)
        ?? this.config.opportunityTtlMs;
      if (opp.timestamp && (now - opp.timestamp) > ttl) {
        toDelete.push(id);
      }
    }

    // Phase 2: Delete expired entries
    for (const id of toDelete) {
      this.opportunities.delete(id);
    }

    // Phase 3: Enforce size limit by removing oldest entries
    // Uses findKSmallest for O(n log k) with bounded memory
    if (this.opportunities.size > this.config.maxOpportunities) {
      const removeCount = this.opportunities.size - this.config.maxOpportunities;

      // Find the k oldest opportunities efficiently
      // Only keeps removeCount items in memory instead of all opportunities
      const oldestK = findKSmallest(
        this.opportunities.entries(),
        removeCount,
        ([, a], [, b]) => (a.timestamp ?? 0) - (b.timestamp ?? 0)
      );

      // Delete the oldest entries
      for (const [id] of oldestK) {
        this.opportunities.delete(id);
      }
    }

    // Log if cleanup occurred
    const removed = initialSize - this.opportunities.size;
    if (removed > 0) {
      this.logger.debug('Opportunity cleanup completed', {
        removed,
        remaining: this.opportunities.size,
        expiredCount: toDelete.length,
      });
    }

    return removed;
  }

  /**
   * P1-8 FIX: Signal shutdown to cancel in-flight retry delays.
   * This prevents forwardToExecutionEngine() from completing after the
   * coordinator's stop() method has been called.
   */
  shutdown(): void {
    this._shuttingDown = true;
  }

  /**
   * Reset all state (for testing)
   */
  reset(): void {
    this.opportunities.clear();
    this._totalOpportunities = 0;
    this._totalExecutions = 0;
    this._opportunitiesDropped = 0;
    this._shuttingDown = false;
  }
}
