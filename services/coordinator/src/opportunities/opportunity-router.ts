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
import { tmpdir } from 'os';
import { RedisStreams, normalizeChainId, isCanonicalChainId, type ArbitrageOpportunity, type PipelineTimestamps } from '@arbitrage/types';
import { findKSmallest } from '@arbitrage/core/data-structures';
import type { TraceContext } from '@arbitrage/core/tracing';
import { getCexPriceFeedService, CEX_TRACKED_TOKEN_IDS } from '@arbitrage/core/feeds';
import { getLatencyTracker } from '@arbitrage/core/monitoring';
import { FEATURE_FLAGS, CORE_TOKENS, getEstimatedGasCostUsd } from '@arbitrage/config';
import { serializeOpportunityForStream } from '../utils/stream-serialization';
import { scoreOpportunity } from './opportunity-scoring';
import { computeCexAlignment, getCexDegradedProfitMultiplier } from './cex-alignment';

/**
 * Parse a numeric field that may arrive as a string from Redis Streams.
 * Redis Streams serialize all values as strings, so `typeof data.X === 'number'`
 * always fails for stream-sourced data. This handles both native numbers (from
 * direct calls) and string representations (from Redis).
 *
 * @see SA-058/RT-005: Type erasure caused 98.6% EE validation rejection
 */
function parseNumericField(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isNaN(value) ? undefined : value;
  if (typeof value === 'string' && value !== '') {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

/**
 * Parse a boolean field that may arrive as a string from Redis Streams.
 * Handles both native booleans and string representations ("true"/"false").
 */
function parseBooleanField(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return undefined;
}

const PIPELINE_TS_FIELDS = [
  'wsReceivedAt', 'publishedAt', 'consumedAt',
  'detectedAt', 'coordinatorAt', 'executionReceivedAt',
] as const;

function extractPipelineTimestamps(parsed: Record<string, unknown>): PipelineTimestamps {
  const pts: PipelineTimestamps = {};
  for (const field of PIPELINE_TS_FIELDS) {
    if (typeof parsed[field] === 'number') {
      pts[field] = parsed[field] as number;
    }
  }
  return pts;
}

// =============================================================================
// CEX Token Address Resolution (ADR-036)
// =============================================================================

/**
 * P3-3 FIX: Import CEX-tracked token IDs from normalizer (single source of truth).
 * Previously hardcoded as ['WETH', 'WBTC', 'WBNB', 'SOL', 'AVAX', 'MATIC', 'ARB', 'OP', 'FTM']
 * which drifted from normalizer defaults (AVAX→WAVAX, MATIC→WMATIC, FTM→WFTM).
 */

/** Lazy reverse map: token address (lowercase) -> token ID for CEX lookup */
let _addressToTokenId: Map<string, string> | null = null;

function getAddressToTokenIdMap(): Map<string, string> {
  if (_addressToTokenId) return _addressToTokenId;
  _addressToTokenId = new Map();
  for (const tokens of Object.values(CORE_TOKENS)) {
    for (const token of tokens) {
      if (CEX_TRACKED_TOKEN_IDS.has(token.symbol)) {
        _addressToTokenId.set(token.address.toLowerCase(), token.symbol);
      }
    }
  }
  return _addressToTokenId;
}

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
  type: 'EXECUTION_CIRCUIT_OPEN' | 'EXECUTION_FORWARD_FAILED' | 'ADMISSION_SHEDDING_ACTIVE';
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
   *
   * M-14: Restart risk — This dedup state is in-memory only and is lost on
   * coordinator restart. A brief window of duplicate forwarding may occur
   * until the dedup map rebuilds from incoming messages. This is an accepted
   * trade-off: the execution engine's Redis-based `setNx` lock provides a
   * second dedup layer that survives restarts, so duplicates are caught
   * before actual trade execution.
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
   * Phase 1 Admission Control: Maximum opportunities to forward per batch (default: 0 = unlimited).
   * When > 0, only the top-K highest-scored opportunities are forwarded; the rest are
   * explicitly shed with logging. Score = expectedProfit × confidence × (1/ttlRemaining).
   * @see docs/reports/EXECUTION_BOTTLENECK_RESEARCH_2026-03-06.md — Phase 1
   */
  maxForwardPerBatch?: number;
  /**
   * RT-005 FIX: Multiplier for chain-specific TTLs in simulation mode (default: 1).
   * In simulation mode with high realism, detectors produce 130+ opps/s but chain-specific
   * TTLs (e.g., Arbitrum 15s) expire before the single-threaded coordinator can process them.
   * Setting this to e.g., 5 gives 5x more time for processing without changing production behavior.
   */
  simulationTtlMultiplier?: number;
  /**
   * RT-003 FIX: Grace period in ms after router creation before forwarding begins (default: 5000).
   * Prevents the startup race where the coordinator forwards opportunities before
   * the execution engine consumer is ready, causing the first message to expire in
   * transit and land in the DLQ.
   */
  startupGracePeriodMs?: number;
  /**
   * Phase 2 (ADR-038): Chain-group stream resolver.
   * When provided, routes each opportunity to the per-group stream matching its buyChain
   * (or chain for intra-chain opportunities) instead of the single executionRequestsStream.
   * Falls back to executionRequestsStream when the chain is unknown or the resolver
   * returns the default stream.
   *
   * Usage: pass `getStreamForChain` from `@arbitrage/config` to enable chain-group routing.
   * Leave undefined to use the legacy single-stream mode (backward compatible).
   *
   * @see shared/config/src/execution-chain-groups.ts
   * @see docs/reports/EXECUTION_BOTTLENECK_RESEARCH_2026-03-06.md — Phase 2
   */
  chainGroupStreamResolver?: (chainId: string) => string;
  /**
   * M-12 FIX: Configurable admission depth tier thresholds.
   * Three values [light, medium, full] defining stream depth ratios at which
   * admission budget reduces. Default: [0.3, 0.5, 0.7].
   */
  admissionDepthTiers?: [number, number, number];
}

/**
 * OP-14: Default chain-specific TTL overrides for fast chains.
 * Fast L2s and Solana produce blocks much faster than the 60s global TTL,
 * so opportunities go stale before execution.
 */
/**
 * P2-10 FIX: Differentiate L2 TTL overrides by actual block time.
 * Arbitrum/Optimism/Base have ~250ms blocks — opps go stale 12x faster than Scroll (3s).
 * Previously all L2s shared 15s, causing stale Arbitrum opps to be forwarded.
 */
const DEFAULT_CHAIN_TTL_OVERRIDES: Record<string, number> = {
  // Ultra-fast L2s (~250ms blocks) — tighter TTL
  arbitrum: 10000,   // ~40 blocks at 250ms
  optimism: 10000,   // Similar to Arbitrum
  base: 10000,       // Optimism-based, ~250ms
  // Medium L2s (~1s blocks)
  zksync: 12000,     // ~12 blocks at 1s
  linea: 12000,      // Similar L2 characteristics (~1s)
  // Solana (~400ms slots) — tightest
  solana: 8000,      // ~20 slots at 400ms
  // Slower L2s (~2-3s blocks)
  mantle: 15000,     // ~7 blocks at 2s
  mode: 15000,       // ~7 blocks at 2s
  blast: 15000,      // ~7 blocks at 2s (Optimism-based)
  scroll: 15000,     // ~5 blocks at 3s
};

/**
 * Internal resolved config — all fields filled, callback fields may be undefined.
 * Using an explicit type (not Required<>) so chainGroupStreamResolver can be truthfully
 * typed as `fn | undefined` — Required<> would strip undefined from the union, causing
 * TypeScript to incorrectly treat the `if (resolver)` check as always-truthy.
 */
type ResolvedRouterConfig = Omit<Required<OpportunityRouterConfig>, 'chainGroupStreamResolver'> & {
  chainGroupStreamResolver: ((chainId: string) => string) | undefined;
};

/**
 * Default configuration
 */
const DEFAULT_CONFIG: ResolvedRouterConfig = {
  maxOpportunities: 1000,
  opportunityTtlMs: 60000,
  duplicateWindowMs: 5000,
  instanceId: 'coordinator',
  executionRequestsStream: RedisStreams.EXECUTION_REQUESTS,
  // P0 FIX: Raised from -100 to 0.1%. Previously allowed negative-profit
  // opportunities through, flooding the execution engine with ~88 opps/sec
  // while it could only process ~0.1/sec. A 0.1% minimum profit threshold
  // filters out clearly unprofitable opportunities at the coordinator level.
  minProfitPercentage: 0.1,
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
  // Phase 1 Admission Control: 0 = unlimited (disabled by default)
  maxForwardPerBatch: 0,
  // RT-003 FIX: Grace period for execution engine consumer initialization.
  // RT-004 FIX: Increased from 5s to 15s — execution engine initialization
  // (Redis, nonce manager, providers, KMS, MEV, strategies, risk management,
  // bridge recovery, consumer group creation) typically takes 7-12s.
  startupGracePeriodMs: 15000,
  // RT-005 FIX: Default 1x (no change). Set via SIMULATION_OPPORTUNITY_TTL_MULTIPLIER env var.
  simulationTtlMultiplier: 1,
  // M-12 FIX: Configurable admission depth tier thresholds
  admissionDepthTiers: [0.3, 0.5, 0.7] as [number, number, number],
  // Phase 2 (ADR-038): undefined = legacy single-stream mode (backward compatible)
  chainGroupStreamResolver: undefined,
};

/**
 * Opportunity Router
 *
 * Manages the lifecycle of arbitrage opportunities from detection to execution.
 */
export class OpportunityRouter {
  private readonly config: ResolvedRouterConfig;
  private readonly logger: OpportunityRouterLogger;
  private readonly streamsClient: OpportunityStreamsClient | null;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly onAlert?: (alert: OpportunityAlert) => void;
  // T2-3 FIX: Callback to persist CB state to Redis after state changes.
  // The coordinator provides this so crash-restart cycles don't bypass CB protection.
  private readonly onCircuitBreakerChange?: (status: { failures: number; isOpen: boolean; lastFailure: number }) => void;

  private readonly opportunities: Map<string, ArbitrageOpportunity> = new Map();

  // Metrics counters (exposed for coordinator to track)
  private _totalOpportunities = 0;
  private _totalExecutions = 0;
  // P1-7 FIX: Track dropped opportunities for monitoring
  private _opportunitiesDropped = 0;
  // SM-001 FIX: Per-reason rejection counters for pipeline observability.
  // Without these, the monitoring tool can only see 0 forwards but not WHY.
  private _rejectedExpired = 0;
  private _rejectedDuplicate = 0;
  private _rejectedProfit = 0;
  private _rejectedChain = 0;
  private _deferredGracePeriod = 0;
  private _deferredNotLeader = 0;
  private _deferredCircuitOpen = 0;
  // P1-8 FIX: Shutdown flag to cancel in-flight retry delays
  private _shuttingDown = false;
  // Phase 1 Admission Control: Scoring + admission gate metrics
  private _admittedTotal = 0;
  private _shedTotal = 0;
  private _admittedScoreSum = 0;
  private _shedScoreSum = 0;
  // Execution stream depth ratio (set externally by coordinator for dynamic admission budget)
  private _executionStreamDepthRatio = 0;
  // CEX resilience: effective min profit (adjusted when CEX feed is degraded)
  private effectiveMinProfitPercentage: number = 0;
  // RT-003 FIX: Startup grace period — defer forwarding until execution engine consumer is ready
  private readonly _createdAt = Date.now();
  // Consumer lag detection: tracks consecutive expired opportunities.
  // When this exceeds the threshold, the coordinator should skip its consumer
  // backlog to avoid the death spiral where processing stale messages causes
  // even more messages to expire.
  private _consecutiveExpired = 0;
  // RT-005 FIX: Lowered from 20 to 5 to warn earlier about consumer lag.
  // The coordinator auto-skip threshold is now 10, so warning at 5 gives
  // operators advance notice before the skip fires.
  private static readonly CONSECUTIVE_EXPIRED_WARN_THRESHOLD = 5;
  // PERF-M-01 FIX: Reusable Set buffer to avoid allocating new Set(processedIds) per batch.
  private readonly _processedSetBuffer = new Set<string>();

  constructor(
    logger: OpportunityRouterLogger,
    circuitBreaker: CircuitBreaker,
    streamsClient?: OpportunityStreamsClient | null,
    config?: OpportunityRouterConfig,
    onAlert?: (alert: OpportunityAlert) => void,
    onCircuitBreakerChange?: (status: { failures: number; isOpen: boolean; lastFailure: number }) => void
  ) {
    this.logger = logger;
    this.circuitBreaker = circuitBreaker;
    this.streamsClient = streamsClient ?? null;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.effectiveMinProfitPercentage = this.config.minProfitPercentage;
    this.onAlert = onAlert;
    this.onCircuitBreakerChange = onCircuitBreakerChange;
  }

  /**
   * Get the opportunities map (for API endpoints).
   * Returns a ReadonlyMap backed by the internal map (O(1), no copy).
   */
  getOpportunities(): ReadonlyMap<string, ArbitrageOpportunity> {
    return this.opportunities;
  }

  /**
   * Update the status of an opportunity (e.g., on execution result).
   * Extends the opportunity's TTL so completed/failed results stay visible
   * in the dashboard longer than pending opportunities.
   */
  updateOpportunityStatus(
    opportunityId: string,
    status: 'executing' | 'completed' | 'failed',
    update?: { actualProfit?: number; gasCost?: number; netProfit?: number },
  ): void {
    const opp = this.opportunities.get(opportunityId);
    if (!opp) return;
    opp.status = status;
    if (update?.actualProfit !== undefined) opp.estimatedProfit = update.actualProfit;
    if (update?.gasCost !== undefined) opp.gasCost = update.gasCost;
    if (update?.netProfit !== undefined) opp.netProfit = update.netProfit;
    // Extend TTL: push expiresAt 5 minutes into the future so dashboard can display results
    opp.expiresAt = Date.now() + 5 * 60 * 1000;
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
   * SM-001 FIX: Get per-reason rejection/deferral counters for pipeline observability.
   * Exposes why opportunities are not being forwarded to execution.
   */
  getForwardingMetrics(): {
    expired: number;
    duplicate: number;
    profitRejected: number;
    chainRejected: number;
    gracePeriodDeferred: number;
    notLeader: number;
    circuitOpen: number;
  } {
    return {
      expired: this._rejectedExpired,
      duplicate: this._rejectedDuplicate,
      profitRejected: this._rejectedProfit,
      chainRejected: this._rejectedChain,
      gracePeriodDeferred: this._deferredGracePeriod,
      notLeader: this._deferredNotLeader,
      circuitOpen: this._deferredCircuitOpen,
    };
  }

  /**
   * Phase 1 Admission Control: Set the current execution stream depth ratio.
   * Called by the coordinator when it updates the cached stream depth.
   * Used to dynamically compute admission budget when maxForwardPerBatch is 0.
   */
  setExecutionStreamDepthRatio(ratio: number): void {
    this._executionStreamDepthRatio = ratio;
  }

  /**
   * Phase 1 Admission Control: Get admission metrics for monitoring.
   */
  getAdmissionMetrics(): {
    admitted: number;
    shed: number;
    avgScoreAdmitted: number;
    avgScoreShed: number;
  } {
    return {
      admitted: this._admittedTotal,
      shed: this._shedTotal,
      avgScoreAdmitted: this._admittedTotal > 0 ? this._admittedScoreSum / this._admittedTotal : 0,
      avgScoreShed: this._shedTotal > 0 ? this._shedScoreSum / this._shedTotal : 0,
    };
  }

  /**
   * Phase 1 Admission Control: Compute the admission budget for this batch.
   * Returns the maximum number of opportunities to forward.
   *
   * When maxForwardPerBatch > 0: uses that fixed limit.
   * When maxForwardPerBatch === 0 (default): dynamically adjusts based on stream depth ratio.
   *   - Depth <= 0.3: unlimited (forward all)
   *   - Depth 0.3-0.5: forward 75% of candidates
   *   - Depth 0.5-0.7: forward 25% of candidates
   *   - Depth > 0.7: forward 0 (full backpressure — existing behavior)
   */
  private computeAdmissionBudget(candidateCount: number): number {
    const maxPerBatch = this.config.maxForwardPerBatch ?? 0;
    if (maxPerBatch > 0) {
      return maxPerBatch;
    }

    // M-12 FIX: Dynamic budget based on configurable stream depth tiers
    const depth = this._executionStreamDepthRatio;
    const [light, medium, full] = this.config.admissionDepthTiers;
    if (depth <= light) return candidateCount; // Unlimited
    if (depth <= medium) return Math.max(1, Math.ceil(candidateCount * 0.75));
    if (depth <= full) return Math.max(1, Math.ceil(candidateCount * 0.25));
    return 0; // Full backpressure
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

    const timestamp = parseNumericField(data.timestamp) ?? Date.now();

    // Duplicate detection
    // M-03 FIX: Use chain-aware dedup window. Fast chains (Solana 400ms, Arbitrum 250ms)
    // produce distinct opportunities faster than the default 5s window, which was filtering
    // legitimate opportunities. Use 1/4 of the chain's TTL override, floored at 500ms.
    const chain = (data.chain as string | undefined) ?? '';
    const chainTtl = this.config.chainTtlOverrides[chain];
    const dedupWindow = chainTtl
      ? Math.max(Math.floor(chainTtl / 4), 500)
      : this.config.duplicateWindowMs;
    const existing = this.opportunities.get(id);
    if (existing && Math.abs((existing.timestamp ?? 0) - timestamp) < dedupWindow) {
      this._rejectedDuplicate++;
      this.logger.debug('Duplicate opportunity detected, skipping', {
        id,
        existingTimestamp: existing.timestamp,
        newTimestamp: timestamp,
      });
      return false;
    }

    // Input validation for profit percentage
    const profitPercentage = parseNumericField(data.profitPercentage);
    if (profitPercentage !== undefined) {
      if (profitPercentage < this.effectiveMinProfitPercentage || profitPercentage > this.config.maxProfitPercentage) {
        this._rejectedProfit++;
        this.logger.warn('Invalid profit percentage, rejecting opportunity', {
          id,
          profitPercentage,
          reason: profitPercentage < this.effectiveMinProfitPercentage ? 'below_minimum' : 'above_maximum',
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
        this._rejectedChain++;
        this.logger.warn('Unknown chain in opportunity, rejecting', {
          id,
          chain: rawChain,
          normalizedChain: normalized,
        });
        return false;
      }
    }

    // H2 FIX (ADR-038): Validate buyChain/sellChain against canonical chain ID whitelist.
    // Without this, an unrecognized buyChain bypasses the resolver and falls back to the
    // legacy stream silently — the opportunity executes but on the wrong EE instance.
    const oppType = typeof data.type === 'string' ? data.type : undefined;
    const buyChain = typeof data.buyChain === 'string' ? data.buyChain : undefined;
    const sellChain = typeof data.sellChain === 'string' ? data.sellChain : undefined;
    if (buyChain) {
      const normalizedBuy = normalizeChainId(buyChain);
      if (!isCanonicalChainId(normalizedBuy)) {
        this._rejectedChain++;
        this.logger.warn('Unknown buyChain in opportunity, rejecting', {
          id,
          buyChain,
          normalizedBuyChain: normalizedBuy,
        });
        return false;
      }
    }
    if (sellChain) {
      const normalizedSell = normalizeChainId(sellChain);
      if (!isCanonicalChainId(normalizedSell)) {
        this._rejectedChain++;
        this.logger.warn('Unknown sellChain in opportunity, rejecting', {
          id,
          sellChain,
          normalizedSellChain: normalizedSell,
        });
        return false;
      }
    }

    // RT-OPT-002 FIX: Defense-in-depth — reject cross-chain opportunities where
    // buyChain equals sellChain before forwarding to execution engine. The primary
    // filter is in the cross-chain detector (RT-OPT-001), but if it's bypassed or
    // a code change reintroduces same-chain opps, this prevents DLQ flooding.
    if (oppType === 'cross-chain' && buyChain && sellChain && buyChain === sellChain) {
      this._rejectedChain++;
      this.logger.debug('Rejecting cross-chain opportunity with same buyChain/sellChain', {
        id,
        buyChain,
        sellChain,
      });
      return false;
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
      confidence: parseNumericField(data.confidence) ?? 0,
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
      buyPrice: parseNumericField(data.buyPrice),
      sellPrice: parseNumericField(data.sellPrice),
      expectedProfit: parseNumericField(data.expectedProfit),
      estimatedProfit: parseNumericField(data.estimatedProfit),
      gasEstimate: typeof data.gasEstimate === 'string' ? data.gasEstimate : undefined,
      expiresAt: parseNumericField(data.expiresAt),
      status: typeof data.status === 'string' ? data.status as ArbitrageOpportunity['status'] : undefined,
      blockNumber: parseNumericField(data.blockNumber),
      useFlashLoan: parseBooleanField(data.useFlashLoan),
      buyPair: typeof data.buyPair === 'string' ? data.buyPair : undefined,
      sellPair: typeof data.sellPair === 'string' ? data.sellPair : undefined,
      // SM-012 FIX: Carry CEX alignment factor through to execution stream
      cexAlignmentFactor: parseNumericField(data.cexAlignmentFactor),
    };

    // SM-013 FIX: Carry pipelineTimestamps forward from the upstream detector.
    // parseStreamResult() (streams.ts:1494) JSON.parses the single 'data' field, so
    // pipelineTimestamps arrives as a nested JS object — NOT a string.
    // The string fallback handles the flat-field serialization path (e.g. DLQ replay
    // via serializeOpportunityForStream which JSON.stringifies nested objects).
    const rawTs = data.pipelineTimestamps;
    if (rawTs && typeof rawTs === 'object') {
      opportunity.pipelineTimestamps = extractPipelineTimestamps(rawTs as Record<string, unknown>);
    } else if (typeof rawTs === 'string') {
      try {
        opportunity.pipelineTimestamps = extractPipelineTimestamps(JSON.parse(rawTs) as Record<string, unknown>);
      } catch {
        this.logger.debug('Failed to parse pipelineTimestamps JSON', { rawTs: String(rawTs).substring(0, 100) });
      }
    }

    // P3-FIX / SM-001 FIX: Check expiry BEFORE storing and forwarding.
    // Previously the expiry check was after storage, wasting memory on stale opportunities.
    // Without this, the coordinator forwards already-expired opportunities from its
    // consumer backlog. The execution engine then rejects them all with VAL_EXPIRED
    // (200-265s lag), producing 0 execution results and growing the DLQ continuously.
    //
    // RT-005 FIX: Apply simulation TTL multiplier to extend effective expiry.
    // In simulation mode, detectors produce 130+ opps/s with short chain-specific TTLs
    // (e.g., Arbitrum 15s). The single-threaded coordinator can't keep up, causing 97.7%
    // expiration. The multiplier extends TTLs without changing production behavior.
    let effectiveExpiresAt = opportunity.expiresAt;
    if (effectiveExpiresAt !== undefined && this.config.simulationTtlMultiplier > 1 && opportunity.timestamp) {
      const originalTtl = effectiveExpiresAt - opportunity.timestamp;
      effectiveExpiresAt = opportunity.timestamp + originalTtl * this.config.simulationTtlMultiplier;
    }
    if (effectiveExpiresAt !== undefined && effectiveExpiresAt < Date.now()) {
      this._rejectedExpired++;
      this._consecutiveExpired++;

      // Log at WARN level periodically when consumer is lagging — debug-only logging
      // made this failure mode invisible during monitoring sessions.
      if (this._consecutiveExpired === OpportunityRouter.CONSECUTIVE_EXPIRED_WARN_THRESHOLD) {
        this.logger.warn('Consumer lag detected: many consecutive opportunities expired before processing', {
          consecutiveExpired: this._consecutiveExpired,
          latestExpiredAgoMs: Date.now() - effectiveExpiresAt,
          chain: opportunity.chain,
        });
      } else if (this._consecutiveExpired > 0 && this._consecutiveExpired % 100 === 0) {
        this.logger.warn('Consumer lag persisting: opportunities continue to expire', {
          consecutiveExpired: this._consecutiveExpired,
          latestExpiredAgoMs: Date.now() - effectiveExpiresAt,
        });
      }

      return true; // Counts as processed for ACK — don't re-process expired messages
    }

    // Reset consecutive expired counter when a fresh opportunity is found
    if (this._consecutiveExpired > 0) {
      this.logger.info('Consumer lag recovered: processing fresh opportunities again', {
        previousConsecutiveExpired: this._consecutiveExpired,
      });
      this._consecutiveExpired = 0;
    }

    // Store opportunity only after passing expiry check (SM-001 FIX: avoids
    // wasting memory on stale opportunities during coordinator backlog)
    this.opportunities.set(id, opportunity);
    this._totalOpportunities++;

    // ADR-037: Downgraded from info to debug — at 181 opps/s, structured logging
    // on every opportunity adds ~0.1-0.5ms per message in the hot path.
    this.logger.debug('Opportunity detected', {
      id,
      chain: opportunity.chain,
      profitPercentage: opportunity.profitPercentage,
      buyDex: opportunity.buyDex,
      sellDex: opportunity.sellDex,
    });

    // Forward to execution engine if leader and pending
    if (isLeader && (opportunity.status === 'pending' || opportunity.status === undefined)) {
      await this.forwardToExecutionEngine(opportunity, traceContext);
    } else {
      if (!isLeader) this._deferredNotLeader++;
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
   * OPT-1+2: Process a batch of opportunity messages with dedup, scoring, and admission control.
   *
   * Pipeline:
   * 1. Groups opportunities by chain+pair key, keeps only freshest per group
   * 2. Scores each candidate: expectedProfit × confidence × (1 / max(ttlRemainingMs, 100))
   * 3. Admission gate: forwards top-K by score (K = admission budget from stream depth)
   * 4. Explicitly sheds low-score opportunities with logging and metrics
   *
   * Single-message batches also respect admission backpressure (budget = 0 at depth > 0.7)
   * but skip grouping/scoring overhead.
   *
   * @param batch - Array of raw opportunity data records from a single xreadgroup call.
   *   Each entry includes `streamMessageId` (the Redis stream message ID for XACK).
   * @param isLeader - Whether this instance should forward to execution
   * @returns Array of stream message IDs that were successfully processed (for XACK).
   *   P0 Fix DF-001: Returns stream message IDs (e.g., "1772460218224-0"), NOT opportunity
   *   data IDs (e.g., "multi_ethereum_..."). Previously returned data IDs which Redis XACK
   *   silently ignored, causing all messages to remain permanently pending.
   * @see docs/reports/EXECUTION_BOTTLENECK_RESEARCH_2026-03-06.md — Phase 1
   */
  async processOpportunityBatch(
    batch: Array<{ streamMessageId: string; data: Record<string, unknown>; traceContext?: TraceContext }>,
    isLeader: boolean,
  ): Promise<string[]> {
    if (batch.length === 0) return [];

    // CEX resilience: recalculate effective min profit at batch entry.
    const cexEnabled = FEATURE_FLAGS.useCexPriceSignals;
    const cexFeedForHealth = cexEnabled ? getCexPriceFeedService() : null;
    const cexDegraded = cexFeedForHealth?.getHealthSnapshot().isDegraded ?? false;
    this.effectiveMinProfitPercentage = this.config.minProfitPercentage * getCexDegradedProfitMultiplier(cexDegraded);

    // If batch is just 1 message, skip grouping/scoring overhead.
    // P3-A FIX: Still respect admission backpressure — if budget is 0 (full
    // backpressure at depth > 0.7), shed the opportunity instead of forwarding.
    if (batch.length === 1) {
      const entry = batch[0];
      if (this.computeAdmissionBudget(1) === 0) {
        this._shedTotal++;
        return [entry.streamMessageId];
      }
      await this.processOpportunity(entry.data, isLeader, entry.traceContext);
      // P0 Fix DF-001: Return stream message ID, not opportunity data ID.
      // Always ACK the message — even if processing fails, we don't want
      // permanently pending messages. Failed messages go to DLQ via processOpportunity.
      return [entry.streamMessageId];
    }

    const now = Date.now();
    const processedIds: string[] = [];

    // Step 1: Parse all messages and compute grouping keys
    interface ParsedOpp {
      data: Record<string, unknown>;
      id: string;
      streamMessageId: string;  // P0 Fix DF-001: Redis stream message ID for XACK
      chain: string;
      pairKey: string;  // chain:buyDex:sellDex:tokenIn:tokenOut
      expiresAt: number;
      timestamp: number;
      traceContext?: TraceContext;
    }
    // P3-007 FIX: Type alias for scored opportunities (eliminates 7 repeated casts)
    type ScoredOpp = ParsedOpp & { _score: number };

    const parsed: ParsedOpp[] = [];
    let expiredInBatch = 0;
    let entryIndex = 0;
    for (const entry of batch) {
      entryIndex++;
      // P3-4 FIX: Mid-batch short-circuit when backlog is stale.
      // If first 100+ messages are >95% expired, remaining are almost certainly stale too.
      // ACK them all and let skipStaleOpportunityBacklogIfNeeded reset the consumer.
      if (entryIndex >= 100 && expiredInBatch > entryIndex * 0.95) {
        for (let j = entryIndex; j < batch.length; j++) {
          processedIds.push(batch[j].streamMessageId);
          expiredInBatch++;
        }
        this.logger.info('Mid-batch short-circuit: backlog is stale', {
          processedSoFar: entryIndex,
          expiredSoFar: expiredInBatch,
          totalBatch: batch.length,
          skipped: batch.length - entryIndex,
        });
        break;
      }
      const data = entry.data;
      const id = data.id as string | undefined;
      // P0 Fix DF-002: ACK messages with missing/invalid IDs instead of silently skipping.
      // Without ACK, these messages remain permanently pending in the PEL.
      if (!id || typeof id !== 'string') {
        // DI-L-003 FIX: Log for forensic trail before discarding
        this.logger.warn('ACKing opportunity with missing/invalid ID — no forensic trail', {
          streamMessageId: entry.streamMessageId,
          dataKeys: Object.keys(data),
        });
        processedIds.push(entry.streamMessageId);
        continue;
      }

      const chain = typeof data.chain === 'string' ? data.chain : 'unknown';
      const buyDex = typeof data.buyDex === 'string' ? data.buyDex : '';
      const sellDex = typeof data.sellDex === 'string' ? data.sellDex : '';
      const tokenIn = typeof data.tokenIn === 'string' ? data.tokenIn :
                       typeof data.token0 === 'string' ? data.token0 : '';
      const tokenOut = typeof data.tokenOut === 'string' ? data.tokenOut :
                        typeof data.token1 === 'string' ? data.token1 : '';
      // P1-001 FIX: Use parseNumericField instead of typeof check.
      // Redis Streams serialize all values as strings, so typeof === 'number'
      // always fails for stream-sourced data. Without this fix, expiresAt defaults
      // to now+60000 for all opps, neutralizing TTL-based pre-filtering, dedup
      // freshness, and the urgency component of admission control scoring.
      const expiresAt = parseNumericField(data.expiresAt) ?? (now + 60000);
      const timestamp = parseNumericField(data.timestamp) ?? now;

      // SM-001 FIX: Pre-filter expired opportunities before dedup and forwarding.
      // At high realism (~115 opps/s), the coordinator backlog grows faster than
      // it can drain. Without this filter, expired opportunities pass through dedup
      // and processOpportunity only to be rejected, wasting CPU and growing the DLQ.
      let effectiveExpiresAt = expiresAt;
      if (this.config.simulationTtlMultiplier > 1) {
        const originalTtl = expiresAt - timestamp;
        effectiveExpiresAt = timestamp + originalTtl * this.config.simulationTtlMultiplier;
      }
      // P0 Fix DF-002: ACK expired messages instead of silently skipping.
      // Previously expired messages were skipped with `continue` before being added
      // to `parsed`, so their IDs were never returned for XACK.
      if (effectiveExpiresAt < now) {
        expiredInBatch++;
        processedIds.push(entry.streamMessageId);
        continue;
      }

      parsed.push({
        data,
        id,
        streamMessageId: entry.streamMessageId,
        chain,
        pairKey: `${chain}:${buyDex}:${sellDex}:${tokenIn}:${tokenOut}`,
        expiresAt,
        timestamp,
        traceContext: entry.traceContext,
      });
    }

    // Step 2: Group by pair key, keep only freshest per group
    const freshest = new Map<string, ParsedOpp>();
    for (const opp of parsed) {
      const existing = freshest.get(opp.pairKey);
      if (!existing || opp.expiresAt > existing.expiresAt ||
          (opp.expiresAt === existing.expiresAt && opp.timestamp > existing.timestamp)) {
        freshest.set(opp.pairKey, opp);
      }
    }

    // Step 3: Score and sort by admission priority (descending score).
    // Phase 1 Admission Control: Replaces pure TTL sort with profit-weighted scoring.
    // Score = expectedProfit × confidence × (1 / max(ttlRemainingMs, 100)) × cexAlignmentFactor.
    // This naturally prioritizes urgent high-profit opportunities aligned with CEX prices.
    // PERF-H-01 FIX: Avoid Array.from() allocation on hot path — push directly
    const candidates: ParsedOpp[] = [];
    for (const v of freshest.values()) candidates.push(v);

    // ADR-036: CEX alignment scoring — resolve CEX feed + address map once per batch
    // (cexEnabled already resolved at batch entry for health check)
    const cexFeed = cexEnabled ? getCexPriceFeedService() : null;
    const addrMap = cexEnabled ? getAddressToTokenIdMap() : null;

    for (const opp of candidates) {
      let cexAlignmentFactor: number | undefined;

      if (cexFeed && addrMap) {
        // Resolve token address to CEX-tracked token ID
        const tokenInAddr = typeof opp.data.tokenIn === 'string' ? opp.data.tokenIn.toLowerCase() : '';
        const tokenId = addrMap.get(tokenInAddr);
        if (tokenId) {
          // Feed DEX price to spread calculator for CEX-DEX spread computation
          const buyPrice = parseNumericField(opp.data.buyPrice);
          if (buyPrice !== undefined && buyPrice > 0) {
            cexFeed.updateDexPrice(tokenId, opp.chain, buyPrice);
          }
          // Compute alignment: boost if arb aligns with CEX, penalize if contradicted
          const buyChain = opp.chain;
          const sellChain = typeof opp.data.sellChain === 'string' ? opp.data.sellChain : opp.chain;
          cexAlignmentFactor = computeCexAlignment(tokenId, buyChain, sellChain, cexFeed);
        }
      }

      (opp as ScoredOpp)._score = scoreOpportunity({
        expectedProfit: parseNumericField(opp.data.expectedProfit),
        confidence: parseNumericField(opp.data.confidence),
        expiresAt: opp.expiresAt,
        // H-02 FIX: Gas cost fallback — if detector did not populate gasCost,
        // use per-chain estimated gas cost to prevent zero-gas scoring bias
        estimatedGasCostUsd: parseNumericField(opp.data.gasCost) ?? (opp.chain ? getEstimatedGasCostUsd(opp.chain) : undefined),
        // ADR-036: CEX alignment factor (1.15=aligned, 0.8=contradicted, 1.0=neutral/no data)
        cexAlignmentFactor,
      }, now);
      // SM-012 FIX: Attach cexAlignmentFactor to data so it flows through serialization
      // to execution-requests stream. EE and monitoring can then see the CEX signal.
      if (cexAlignmentFactor !== undefined) {
        opp.data.cexAlignmentFactor = cexAlignmentFactor;
      }
    }
    // Safe cast: all candidates now have _score set by the loop above
    const scored = candidates as ScoredOpp[];
    scored.sort((a, b) => b._score - a._score);

    // Step 3b: Admission gate — limit forwarding to top-K by score.
    const admissionBudget = this.computeAdmissionBudget(scored.length);
    const admitted = admissionBudget >= scored.length
      ? scored
      : scored.slice(0, admissionBudget);
    const shedCount = scored.length - admitted.length;

    // Track admission metrics
    if (shedCount > 0) {
      this._shedTotal += shedCount;
      for (let i = admissionBudget; i < scored.length; i++) {
        this._shedScoreSum += scored[i]._score;
      }
      this.logger.info('Admission control: shed low-score opportunities', {
        admitted: admitted.length,
        shed: shedCount,
        totalCandidates: scored.length,
        admissionBudget,
        streamDepthRatio: this._executionStreamDepthRatio,
        minAdmittedScore: admitted.length > 0 ? admitted[admitted.length - 1]._score : 0,
        maxShedScore: admissionBudget < scored.length ? scored[admissionBudget]._score : 0,
      });
      // H-01 FIX: Emit alert when admission control is actively shedding
      this.onAlert?.({
        type: 'ADMISSION_SHEDDING_ACTIVE',
        message: 'Admission control shedding: ' + shedCount + ' of ' + scored.length + ' opportunities shed (depth=' + this._executionStreamDepthRatio.toFixed(2) + ')',
        severity: 'warning',
        data: { admitted: admitted.length, shed: shedCount, streamDepthRatio: this._executionStreamDepthRatio },
        timestamp: Date.now(),
      });
    }
    if (admitted.length > 0) {
      this._admittedTotal += admitted.length;
      for (const opp of admitted) {
        this._admittedScoreSum += opp._score;
      }
    }

    this.logger.debug('Batch opportunity processing', {
      batchSize: batch.length,
      expiredPreFilter: expiredInBatch,
      parsedCount: parsed.length,
      dedupedCount: scored.length,
      droppedDuplicates: parsed.length - scored.length,
      admitted: admitted.length,
      shed: shedCount,
    });

    // ADR-037: Step 4: Process admitted opportunities in parallel for throughput.
    // Validation (dedup, profit, chain, expiry) is CPU-only with no shared mutable state
    // between opportunities. Forwarding (XADD) calls are independent Redis writes.
    // H-05 FIX: Use Promise.allSettled instead of Promise.all to prevent a single
    // XADD failure from leaving the entire batch (up to 200 messages) unACKed.
    // With Promise.all, one rejection causes all messages to be redelivered,
    // creating a redelivery storm. allSettled ensures partial successes are ACKed.
    const results = await Promise.allSettled(
      admitted.map(opp => this.processOpportunity(opp.data, isLeader, opp.traceContext))
    );
    // Log any rejected forwards (they are already DLQ'd by processOpportunity's retry logic)
    const rejected = results.filter(r => r.status === 'rejected');
    if (rejected.length > 0) {
      this.logger.warn('Batch forwarding had partial failures', {
        total: admitted.length,
        rejected: rejected.length,
        succeeded: admitted.length - rejected.length,
      });
    }

    // P2-001+P2-002 FIX: Shed opportunities are NOT processed through processOpportunity.
    // Previously, shed opps were processed with isLeader=false, which caused:
    // - P2-001: _deferredNotLeader counter inflation (metric pollution)
    // - P2-002: Storage in opportunities map blocked re-admission within dedup window
    // Shed opps are already tracked via _shedTotal/_shedScoreSum and ACKed below.

    // P0 Fix DF-001: Use stream message IDs for XACK, not opportunity data IDs.
    // ACK all processed messages regardless of success — failed messages are already
    // routed to DLQ by processOpportunity. Leaving them unACKed causes unbounded PEL growth.
    // Phase 1: ACK both admitted and shed opportunities (all scored candidates).
    for (let i = 0; i < scored.length; i++) {
      processedIds.push(scored[i].streamMessageId);
    }

    // Also ACK deduplicated (skipped) opportunities — they were intentionally
    // superseded by a fresher version and must not remain pending.
    // PERF-M-01 FIX: Build Set incrementally during scored loop above
    // instead of allocating new Set(processedIds) at the end of every batch.
    const processedSet = this._processedSetBuffer;
    processedSet.clear();
    for (const id of processedIds) processedSet.add(id);
    for (const opp of parsed) {
      if (!processedSet.has(opp.streamMessageId)) {
        processedIds.push(opp.streamMessageId);
      }
    }

    return processedIds;
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
      this._deferredGracePeriod++;
      this.logger.debug('Startup grace period active — deferring opportunity forwarding', {
        id: opportunity.id,
        elapsedMs: elapsedSinceStart,
        gracePeriodMs: this.config.startupGracePeriodMs,
      });
      return;
    }

    // Check circuit breaker before attempting to forward
    if (this.circuitBreaker.isCurrentlyOpen()) {
      this._deferredCircuitOpen++;
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

    // RT-035 FIX: Feed pipeline timestamps to LatencyTracker so the coordinator's
    // DiagnosticsCollector reports real e2e latency instead of zeros. Previously,
    // recordFromTimestamps() was only called in partition processes (publishing-service),
    // but the DiagnosticsCollector runs in the coordinator process.
    getLatencyTracker().recordFromTimestamps(timestamps as PipelineTimestamps);

    // FIX #12: Use shared serialization utility (single source of truth)
    // OP-3 FIX: Pass trace context for cross-service correlation
    const messageData = serializeOpportunityForStream(opportunity, this.config.instanceId, traceContext);

    // Phase 2 (ADR-038): Route to per-chain-group stream when resolver is configured.
    // Uses buyChain for cross-chain opps (buy-side determines execution group);
    // falls back to chain for intra-chain opps; falls back to single stream if unknown.
    const chainId = opportunity.buyChain ?? opportunity.chain;

    // P2-9 FIX: Check Solana feature flag before routing. When FEATURE_SOLANA_EXECUTION
    // is disabled but chain-group routing is enabled, Solana opps route to
    // EXEC_REQUESTS_SOLANA with no consumer, silently accumulating until MAXLEN trim.
    if (chainId === 'solana' && !FEATURE_FLAGS.useSolanaExecution) {
      this._rejectedChain++;
      this.logger.debug('Solana execution disabled — rejecting opportunity', { id: opportunity.id });
      return;
    }

    const targetStream = (this.config.chainGroupStreamResolver && chainId)
      ? this.config.chainGroupStreamResolver(chainId)
      : this.config.executionRequestsStream;

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
        await this.streamsClient.xaddWithLimit(targetStream, messageData);

        // Success - record and return
        const justRecovered = this.circuitBreaker.recordSuccess();
        if (justRecovered) {
          this.logger.info('Execution circuit breaker closed - recovered');
          // T2-3 FIX: Persist CB state to Redis on recovery
          this.persistCircuitBreakerState();
        }

        // ADR-037: Downgraded from info to debug — at peak throughput, two info logs
        // per forwarded opportunity add ~0.2-1ms of structured logging overhead.
        this.logger.debug('Forwarded opportunity to execution engine', {
          id: opportunity.id,
          chain: opportunity.chain,
          stream: targetStream,
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

          // T2-3 FIX: Persist CB state to Redis when circuit opens
          this.persistCircuitBreakerState();

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
   * T2-3 FIX: Persist circuit breaker state to Redis via callback.
   * Fire-and-forget — CB state is best-effort persistence. A failed persist
   * means the next restart might miss 1 state change, which is acceptable
   * since the CB will re-open quickly if the underlying issue persists.
   */
  private persistCircuitBreakerState(): void {
    if (!this.onCircuitBreakerChange) return;
    const status = this.circuitBreaker.getStatus();
    try {
      this.onCircuitBreakerChange({
        failures: status.failures,
        isOpen: status.isOpen,
        lastFailure: (status as { lastFailure?: number }).lastFailure ?? 0,
      });
    } catch {
      this.logger.debug('Failed to persist CB state (non-fatal)');
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
      // BUG-L-02 FIX: Log when DLQ write is skipped due to uninitialized client
      this.logger.debug('Cannot move to DLQ — streams client not initialized', {
        id: opportunity.id,
      });
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
      // M-10 FIX: Use temp dir in test/development to avoid polluting project data/ dir
      const nodeEnv = process.env.NODE_ENV;
      const baseDir = nodeEnv === 'test' || nodeEnv === 'development'
        ? pathModule.join(tmpdir(), 'arbitrage-dlq')
        : pathModule.resolve('data');
      const dir = baseDir;
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
    this._admittedTotal = 0;
    this._shedTotal = 0;
    this._admittedScoreSum = 0;
    this._shedScoreSum = 0;
    this._executionStreamDepthRatio = 0;
  }
}
