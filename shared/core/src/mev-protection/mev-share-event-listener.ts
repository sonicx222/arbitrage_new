/**
 * MEV-Share SSE Event Listener
 *
 * Subscribes to the Flashbots MEV-Share SSE endpoint to receive real-time
 * pending transaction hints. Identifies backrun opportunities by matching
 * transaction hints against known DEX router addresses.
 *
 * ## How MEV-Share Works
 *
 * 1. Users submit transactions to MEV-Share (via Protect RPC or direct API)
 * 2. MEV-Share streams partial transaction hints via SSE
 * 3. Searchers match hints to identify profitable backrun opportunities
 * 4. Searchers submit backrun bundles referencing the original tx hash
 * 5. Profits are shared between user (refund) and searcher
 *
 * ## Event Format (from SSE stream)
 *
 * Each event contains partial info about a pending transaction:
 * - hash: Transaction hash (if revealed)
 * - logs: Event logs (if revealed)
 * - txs: Transaction details with to/callData/functionSelector hints
 *
 * @see https://docs.flashbots.net/flashbots-mev-share/searchers/event-stream
 * @see Phase 2 Item #23: MEV-Share backrun filling
 */

import { EventEmitter } from 'events';
import { generateTraceId } from '../tracing/trace-context';
import { CircuitBreaker, CircuitBreakerError } from '../resilience/circuit-breaker';
import type { Logger } from '../logger';

// =============================================================================
// Types
// =============================================================================

/**
 * A pending transaction event from the MEV-Share SSE stream.
 */
export interface MevShareEvent {
  /** Transaction hash (may be hidden based on user's hint preferences) */
  hash?: string;
  /** Revealed event logs */
  logs?: MevShareEventLog[];
  /** Transaction hints */
  txs?: MevShareEventTx[];
  /** Inclusion block range */
  version?: string;
}

/**
 * Revealed event log from MEV-Share.
 */
export interface MevShareEventLog {
  /** Contract address that emitted the log */
  address: string;
  /** Log topics (indexed parameters) */
  topics: string[];
  /** Log data (non-indexed parameters) */
  data: string;
}

/**
 * Transaction hint from MEV-Share event.
 */
export interface MevShareEventTx {
  /** Target contract address (if revealed) */
  to?: string;
  /** Function selector (first 4 bytes, if revealed) */
  functionSelector?: string;
  /** Full calldata (if revealed) */
  callData?: string;
}

/**
 * A detected backrun opportunity from an MEV-Share event.
 */
export interface BackrunOpportunity {
  /** Original transaction hash to backrun */
  txHash: string;
  /** The MEV-Share event that triggered this opportunity */
  event: MevShareEvent;
  /** Target DEX router address */
  routerAddress: string;
  /** Function selector of the original swap */
  functionSelector: string;
  /** Detected token pair from logs (if available) */
  tokenPair?: {
    tokenIn: string;
    tokenOut: string;
  };
  /** Fix #29: Pair contract address from Swap event logs (requires on-chain query to resolve tokens) */
  pairAddress?: string;
  /** Timestamp when opportunity was detected */
  detectedAt: number;
  /** Fix #42: Trace ID for correlating SSE event -> bundle -> outcome */
  traceId?: string;
}

/**
 * Configuration for the MEV-Share event listener.
 */
export interface MevShareEventListenerConfig {
  /** SSE endpoint URL (default: https://mev-share.flashbots.net) */
  sseEndpoint?: string;
  /** Known DEX router addresses to match against (lowercase) */
  dexRouterAddresses: Set<string>;
  /** Known swap function selectors to match (e.g., '0x38ed1739' for swapExactTokensForTokens) */
  swapSelectors?: Set<string>;
  /** Maximum events to process per second (rate limiting) */
  maxEventsPerSecond?: number;
  /** Reconnect delay in ms after SSE disconnect (default: 1000) */
  reconnectDelayMs?: number;
  /** Maximum reconnect attempts before giving up (default: 10) */
  maxReconnectAttempts?: number;
  /** Logger instance */
  logger: Logger;
}

/**
 * Common DEX swap function selectors (Uniswap V2/V3 and forks).
 */
/** Fix #12: Maximum SSE buffer size before discarding partial data (1MB). */
const MAX_SSE_BUFFER_SIZE = 1024 * 1024;

/** Fix #39: Cooldown period after exhausting reconnect attempts (60 seconds). */
const RECOVERY_COOLDOWN_MS = 60_000;

export const COMMON_SWAP_SELECTORS = new Set([
  '0x38ed1739', // swapExactTokensForTokens (V2)
  '0x8803dbee', // swapTokensForExactTokens (V2)
  '0x7ff36ab5', // swapExactETHForTokens (V2)
  '0x4a25d94a', // swapTokensForExactETH (V2)
  '0x18cbafe5', // swapExactTokensForETH (V2)
  '0xfb3bdb41', // swapETHForExactTokens (V2)
  '0x5ae401dc', // multicall (V3 Router)
  '0xac9650d8', // multicall (V3 Router02)
  '0x04e45aaf', // exactInputSingle (V3)
  '0xb858183f', // exactInput (V3)
  '0xdb3e2198', // exactOutputSingle (V3)
  '0xf28c0498', // exactOutput (V3)
]);

// =============================================================================
// Event Listener Implementation
// =============================================================================

/**
 * MEV-Share SSE Event Listener
 *
 * Connects to the Flashbots MEV-Share SSE stream and emits backrun
 * opportunities when pending transactions match known DEX routers.
 *
 * @example
 * ```typescript
 * const listener = new MevShareEventListener({
 *   dexRouterAddresses: new Set(['0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D']),
 *   logger,
 * });
 *
 * listener.on('backrunOpportunity', (opp: BackrunOpportunity) => {
 *   console.log('Backrun opportunity:', opp.txHash, opp.routerAddress);
 * });
 *
 * await listener.start();
 * ```
 */
export class MevShareEventListener extends EventEmitter {
  private readonly config: Required<
    Pick<MevShareEventListenerConfig, 'sseEndpoint' | 'maxEventsPerSecond' | 'reconnectDelayMs' | 'maxReconnectAttempts'>
  > & MevShareEventListenerConfig;

  private readonly logger: Logger;
  private abortController: AbortController | null = null;
  private reconnectAttempts = 0;
  private isRunning = false;

  /** Rate limiting: track events in current second */
  private eventCountThisSecond = 0;
  private rateLimitResetTimer: ReturnType<typeof setInterval> | null = null;

  /** Fix #46: Dedup — track recently processed tx hashes to avoid duplicate bundle submissions */
  private readonly processedTxHashes = new Map<string, number>();
  private static readonly TX_HASH_TTL_MS = 30_000;
  /** Fix #13: Hard cap on processedTxHashes map size to prevent unbounded growth.
   * At 100 events/s and 30s TTL, normal max is ~3000 entries. Cap at 10_000 for safety. */
  private static readonly MAX_PROCESSED_TX_HASHES = 10_000;
  private dedupCleanupTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Fix #44: Circuit breaker for SSE connection attempts.
   * Opens after repeated connection failures, preventing resource waste when
   * the MEV-Share endpoint is degraded. Complements the existing reconnect
   * backoff logic by providing standard CB state visibility to the engine.
   */
  private readonly connectionCircuitBreaker: CircuitBreaker;

  /** Metrics */
  private metrics = {
    totalEventsReceived: 0,
    eventsMatched: 0,
    eventsDropped: 0,
    reconnections: 0,
    parseErrors: 0,
    lastEventAt: 0,
    /** Fix #24: Number of times the listener entered recovery cooldown (60s blind spot) */
    recoveryCooldowns: 0,
    /** Fix #24: Total milliseconds spent in recovery cooldown (blind spot duration) */
    totalCooldownMs: 0,
  };

  constructor(config: MevShareEventListenerConfig) {
    super();

    // P0 Fix #3: Remove ...config spread which overwrites ?? defaults with undefined.
    // Use explicit ?? per field only. Required fields passed directly from config.
    this.config = {
      dexRouterAddresses: config.dexRouterAddresses,
      swapSelectors: config.swapSelectors,
      logger: config.logger,
      sseEndpoint: config.sseEndpoint ?? 'https://mev-share.flashbots.net',
      maxEventsPerSecond: config.maxEventsPerSecond ?? 100,
      reconnectDelayMs: config.reconnectDelayMs ?? 1000,
      maxReconnectAttempts: config.maxReconnectAttempts ?? 10,
    };

    this.logger = config.logger;

    // Fix #44: Initialize connection circuit breaker.
    // failureThreshold matches maxReconnectAttempts so CB opens when reconnects are exhausted.
    // recoveryTimeout matches RECOVERY_COOLDOWN_MS (60s) for consistent cooldown behavior.
    this.connectionCircuitBreaker = new CircuitBreaker({
      name: 'mev-share-sse',
      failureThreshold: this.config.maxReconnectAttempts,
      recoveryTimeout: RECOVERY_COOLDOWN_MS,
      monitoringPeriod: RECOVERY_COOLDOWN_MS * 2,
      successThreshold: 1, // One successful connection closes the breaker
    });
  }

  /**
   * Start listening to the MEV-Share SSE stream.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('MEV-Share event listener already running');
      return;
    }

    this.isRunning = true;
    this.reconnectAttempts = 0;

    // Start rate limit reset timer
    this.rateLimitResetTimer = setInterval(() => {
      this.eventCountThisSecond = 0;
    }, 1000);

    // Fix #46 + Fix #19: Start dedup cleanup timer.
    // Fix #19: Interval = half of TTL (15s) so entries don't linger up to 2x TTL.
    // With interval === TTL, an entry added just after a cleanup could live for
    // nearly 2 * TTL before the next sweep removes it.
    this.dedupCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [hash, timestamp] of this.processedTxHashes) {
        if (now - timestamp > MevShareEventListener.TX_HASH_TTL_MS) {
          this.processedTxHashes.delete(hash);
        }
      }
    }, MevShareEventListener.TX_HASH_TTL_MS / 2);

    this.logger.info('Starting MEV-Share event listener', {
      endpoint: this.config.sseEndpoint,
      routerCount: this.config.dexRouterAddresses.size,
      maxEventsPerSecond: this.config.maxEventsPerSecond,
    });

    await this.connect();
  }

  /**
   * Stop listening and clean up resources.
   */
  async stop(): Promise<void> {
    this.isRunning = false;

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    if (this.rateLimitResetTimer) {
      clearInterval(this.rateLimitResetTimer);
      this.rateLimitResetTimer = null;
    }

    // Fix #46: Clean up dedup timer
    if (this.dedupCleanupTimer) {
      clearInterval(this.dedupCleanupTimer);
      this.dedupCleanupTimer = null;
    }
    this.processedTxHashes.clear();

    // FIX 9: Remove all event listeners to prevent memory leaks on restart
    this.removeAllListeners();

    this.logger.info('MEV-Share event listener stopped', {
      metrics: this.getMetrics(),
    });
  }

  /**
   * Get current listener metrics.
   */
  getMetrics(): typeof this.metrics {
    return { ...this.metrics };
  }

  /**
   * Connect to the SSE stream with automatic reconnection.
   */
  private async connect(): Promise<void> {
    while (this.isRunning) {
      this.abortController = new AbortController();

      try {
        // Fix #44: Wrap SSE connection in circuit breaker for standard state tracking.
        // The CB records success/failure; reconnect backoff is handled below.
        const response = await this.connectionCircuitBreaker.execute(async () => {
          const res = await fetch(this.config.sseEndpoint, {
            headers: { Accept: 'text/event-stream' },
            signal: this.abortController!.signal,
          });

          if (!res.ok) {
            throw new Error(`SSE connection failed: HTTP ${res.status}`);
          }

          if (!res.body) {
            throw new Error('SSE response has no body');
          }

          return res;
        });

        this.reconnectAttempts = 0;
        this.logger.info('Connected to MEV-Share SSE stream');
        this.emit('connected');

        await this.processStream(response.body!);
      } catch (error) {
        if (!this.isRunning) {
          // Intentional shutdown
          return;
        }

        const errorMessage = error instanceof Error ? error.message : String(error);

        // Don't log abort errors during shutdown
        if (errorMessage.includes('abort')) {
          return;
        }

        // Fix #44: When circuit breaker is OPEN, skip directly to cooldown.
        // The CB tracks failures internally — don't double-count reconnect attempts.
        if (error instanceof CircuitBreakerError) {
          this.metrics.recoveryCooldowns++;
          const cooldownStart = Date.now();
          this.logger.warn('MEV-Share SSE circuit breaker OPEN — entering recovery cooldown', {
            cbState: error.state,
            cooldownMs: RECOVERY_COOLDOWN_MS,
            blindSpotNumber: this.metrics.recoveryCooldowns,
          });
          this.emit('maxReconnectsExceeded');
          await new Promise(resolve => setTimeout(resolve, RECOVERY_COOLDOWN_MS));
          this.metrics.totalCooldownMs += Date.now() - cooldownStart;

          if (!this.isRunning) {
            return;
          }

          this.reconnectAttempts = 0;
          this.logger.info('MEV-Share SSE resuming after circuit breaker cooldown');
          continue;
        }

        this.reconnectAttempts++;
        this.metrics.reconnections++;

        if (this.reconnectAttempts > this.config.maxReconnectAttempts) {
          // Fix #39: Instead of permanently dying, enter a cooldown period
          // then reset reconnect counter and retry. This ensures auto-recovery
          // after transient outages.
          // Fix #24: Track and warn about SSE reconnect blind spot during cooldown.
          // During this 60-second window, no MEV-Share events are processed.
          this.metrics.recoveryCooldowns++;
          const cooldownStart = Date.now();
          this.logger.warn('MEV-Share SSE entering recovery cooldown — events will NOT be processed during this period', {
            attempts: this.reconnectAttempts,
            cooldownMs: RECOVERY_COOLDOWN_MS,
            blindSpotNumber: this.metrics.recoveryCooldowns,
          });
          this.logger.error('MEV-Share SSE max reconnect attempts exceeded, entering cooldown', {
            attempts: this.reconnectAttempts,
            cooldownMs: RECOVERY_COOLDOWN_MS,
          });
          this.emit('maxReconnectsExceeded');
          await new Promise(resolve => setTimeout(resolve, RECOVERY_COOLDOWN_MS));
          this.metrics.totalCooldownMs += Date.now() - cooldownStart;

          if (!this.isRunning) {
            return;
          }

          this.reconnectAttempts = 0;
          this.logger.info('MEV-Share SSE resuming after cooldown');
          continue;
        }

        // Exponential backoff: delay * 2^(attempt-1), capped at 30s
        const backoffMs = Math.min(
          this.config.reconnectDelayMs * Math.pow(2, this.reconnectAttempts - 1),
          30000
        );

        this.logger.warn('MEV-Share SSE disconnected, reconnecting', {
          error: errorMessage,
          attempt: this.reconnectAttempts,
          backoffMs,
        });

        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }
  }

  /**
   * Process the SSE stream body, parsing events line by line.
   *
   * SSE format:
   *   :comment
   *   event: eventName
   *   data: {...json...}
   *   \n\n (end of event)
   */
  private async processStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (this.isRunning) {
        const { done, value } = await reader.read();

        if (done) {
          this.logger.info('MEV-Share SSE stream ended');
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        // Fix #12: Prevent OOM if SSE endpoint sends data without delimiters
        if (buffer.length > MAX_SSE_BUFFER_SIZE) {
          this.logger.warn('SSE buffer overflow, discarding partial data', {
            bufferLength: buffer.length,
            maxSize: MAX_SSE_BUFFER_SIZE,
          });
          buffer = '';
          this.metrics.eventsDropped++;
        }

        // Process complete events (separated by double newline)
        const events = buffer.split('\n\n');
        // Keep the last incomplete chunk in the buffer
        buffer = events.pop() ?? '';

        for (const rawEvent of events) {
          if (!rawEvent.trim()) continue;
          this.handleRawEvent(rawEvent);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Fix #8: Public method to process a parsed MEV-Share event.
   * Enables direct unit testing of the event matching logic without
   * needing to mock SSE streams.
   *
   * @internal For testing only. Production code should NOT call this directly.
   * FIX 14: Now includes rate limiting check to prevent abuse if called externally.
   */
  processEvent(event: MevShareEvent): void {
    // FIX 14: Apply rate limiting to prevent abuse via direct calls
    if (this.eventCountThisSecond >= this.config.maxEventsPerSecond) {
      this.metrics.eventsDropped++;
      return;
    }
    this.eventCountThisSecond++;

    this.metrics.totalEventsReceived++;
    this.metrics.lastEventAt = Date.now();
    this.emit('event', event);
    this.evaluateBackrunOpportunity(event);
  }

  /**
   * Parse and handle a single raw SSE event.
   */
  private handleRawEvent(raw: string): void {
    // Rate limiting
    if (this.eventCountThisSecond >= this.config.maxEventsPerSecond) {
      this.metrics.eventsDropped++;
      return;
    }
    this.eventCountThisSecond++;

    // Extract data field from SSE event
    let data: string | null = null;
    for (const line of raw.split('\n')) {
      if (line.startsWith('data:')) {
        data = line.slice(5).trim();
      }
    }

    if (!data) return;

    // Parse JSON
    let event: MevShareEvent;
    try {
      event = JSON.parse(data) as MevShareEvent;
    } catch {
      this.metrics.parseErrors++;
      this.logger.debug('MEV-Share event parse error', { dataLength: data.length });
      return;
    }

    // Fix #47: Minimal structural validation — reject events with neither hash nor txs
    if (typeof event.hash !== 'string' && !Array.isArray(event.txs)) {
      this.metrics.parseErrors++;
      this.logger.debug('MEV-Share event validation failed: no hash or txs');
      return;
    }

    this.metrics.totalEventsReceived++;
    this.metrics.lastEventAt = Date.now();

    // Emit raw event for monitoring
    this.emit('event', event);

    // Check for backrun opportunity
    this.evaluateBackrunOpportunity(event);
  }

  /**
   * Evaluate whether an MEV-Share event represents a backrun opportunity.
   *
   * Matching criteria:
   * 1. Transaction has a revealed hash (needed to reference in backrun bundle)
   * 2. Target address matches a known DEX router
   * 3. Function selector matches a known swap function (if revealed)
   */
  private evaluateBackrunOpportunity(event: MevShareEvent): void {
    // Must have a hash to build a backrun bundle
    if (!event.hash) return;

    // Fix #46: Skip duplicate tx hashes to avoid redundant bundle submissions
    if (this.processedTxHashes.has(event.hash)) {
      return;
    }

    // Fix #13: Enforce hard cap — evict oldest entries when map exceeds limit.
    // HOT-PATH: Map.keys().next() is O(1) for insertion-ordered Maps.
    if (this.processedTxHashes.size >= MevShareEventListener.MAX_PROCESSED_TX_HASHES) {
      const oldest = this.processedTxHashes.keys().next().value;
      if (oldest !== undefined) {
        this.processedTxHashes.delete(oldest);
      }
    }

    this.processedTxHashes.set(event.hash, Date.now());

    // Check each revealed transaction hint
    if (!event.txs || event.txs.length === 0) return;

    for (const tx of event.txs) {
      if (!tx.to) continue;

      const targetAddress = tx.to.toLowerCase();

      // Match against known DEX routers
      if (!this.config.dexRouterAddresses.has(targetAddress)) {
        continue;
      }

      // If function selector is revealed, check it matches known swap selectors
      const selectors = this.config.swapSelectors ?? COMMON_SWAP_SELECTORS;
      if (tx.functionSelector && !selectors.has(tx.functionSelector)) {
        continue;
      }

      // Fix #29: Extract pair address from logs (not misleading tokenIn/tokenOut)
      let pairAddress: string | undefined;
      if (event.logs && event.logs.length > 0) {
        pairAddress = this.extractPairAddressFromLogs(event.logs);
      }

      // Fix #42: Generate traceId for end-to-end correlation
      const traceId = generateTraceId();

      const opportunity: BackrunOpportunity = {
        txHash: event.hash,
        event,
        routerAddress: targetAddress,
        functionSelector: tx.functionSelector ?? 'unknown',
        pairAddress,
        detectedAt: Date.now(),
        traceId,
      };

      this.metrics.eventsMatched++;
      this.emit('backrunOpportunity', opportunity);

      this.logger.debug('MEV-Share backrun opportunity detected', {
        txHash: event.hash,
        router: targetAddress,
        selector: tx.functionSelector,
        hasPairAddress: !!pairAddress,
        traceId,
      });

      // Only emit one opportunity per event (first match)
      return;
    }
  }

  /**
   * Attempt to extract token pair from revealed Swap event logs.
   *
   * Uniswap V2 Swap event:
   *   event Swap(address indexed sender, uint amount0In, uint amount1In,
   *              uint amount0Out, uint amount1Out, address indexed to)
   *   Topic[0] = keccak256("Swap(address,uint256,uint256,uint256,uint256,address)")
   *            = 0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822
   *
   * The pair contract address (log.address) identifies the token pair.
   */
  /**
   * Fix #29: Extract pair contract address from Swap event logs.
   * Returns only the pair address — full token resolution requires on-chain queries
   * (pair.token0() / pair.token1()). Previously returned pair address as both
   * tokenIn and tokenOut which was misleading.
   */
  private extractPairAddressFromLogs(logs: MevShareEventLog[]): string | undefined {
    // Uniswap V2 Swap event signature
    const SWAP_TOPIC = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';

    for (const log of logs) {
      if (log.topics.length > 0 && log.topics[0] === SWAP_TOPIC) {
        return log.address;
      }
    }

    return undefined;
  }

  /**
   * Fix #44: Expose the connection circuit breaker for external state monitoring.
   * Allows the engine to query CB state (CLOSED/OPEN/HALF_OPEN) and stats.
   */
  getConnectionCircuitBreaker(): CircuitBreaker {
    return this.connectionCircuitBreaker;
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create an MEV-Share event listener.
 */
export function createMevShareEventListener(
  config: MevShareEventListenerConfig
): MevShareEventListener {
  return new MevShareEventListener(config);
}
