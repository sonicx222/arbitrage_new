/**
 * JSON-RPC 2.0 Batch Provider
 *
 * Implements RPC request batching to reduce individual HTTP calls.
 *
 * Batchable Operations (Non-Hot-Path):
 * - eth_estimateGas: Gas estimation before execution
 * - eth_call: Historical reserve queries and simulations
 * - eth_getTransactionReceipt: Post-execution confirmation
 *
 * NOT Batchable (Hot-Path):
 * - eth_call(getReserves): Handled by reserve cache
 * - eth_sendRawTransaction: Time-critical execution
 *
 * @see docs/architecture/adr/ADR-024-rpc-rate-limiting.md
 */

import { ethers } from 'ethers';
import { clearTimeoutSafe } from '../async/lifecycle-utils';
import { createLogger } from '../logger';
import { Http2SessionPool } from './http2-session-pool';

const logger = createLogger('batch-provider');
import {
  TokenBucketRateLimiter,
  type RateLimiterConfig,
  getRateLimitConfig,
  isRateLimitExempt,
} from './rate-limiter';

// =============================================================================
// Types
// =============================================================================

/**
 * JSON-RPC 2.0 request format.
 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params: unknown[];
  id: number | string;
}

/**
 * JSON-RPC 2.0 response format.
 */
export interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: number | string;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * Pending request in the batch queue.
 */
interface PendingRequest {
  method: string;
  params: unknown[];
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timestamp: number;
}

/**
 * Batch provider configuration.
 */
export interface BatchProviderConfig {
  /** Maximum batch size before auto-flush (default: 20) */
  maxBatchSize?: number;
  /** Maximum time to wait before auto-flush in ms (default: 10) */
  batchTimeoutMs?: number;
  /** Enable batching (can be disabled for debugging) (default: true) */
  enabled?: boolean;
  /** Maximum queue size before rejecting new requests (default: 100) */
  maxQueueSize?: number;
  /** Enable request deduplication within batch window (default: true) */
  enableDeduplication?: boolean;
  /**
   * R3 Optimization: Enable per-chain rate limiting.
   * Uses token bucket algorithm to prevent 429 errors from RPC providers.
   * Hot-path methods (eth_sendRawTransaction) are exempt.
   * @default false (opt-in for backward compatibility)
   * @see docs/architecture/adr/ADR-024-rpc-rate-limiting.md
   */
  enableRateLimiting?: boolean;
  /**
   * R3 Optimization: Custom rate limit configuration.
   * If not provided, defaults are used based on detected provider.
   */
  rateLimitConfig?: RateLimiterConfig;
  /**
   * R3 Optimization: Chain/provider name for rate limit defaults.
   * Used to auto-detect appropriate rate limits.
   */
  chainOrProvider?: string;
  /**
   * P3 Enhancement: Use HTTP/2 for batch RPC calls.
   * HTTP/2 multiplexing reduces connection overhead for high-frequency batch flushes.
   * Falls back to HTTP/1.1 fetch on connection failure.
   * @default false (opt-in)
   */
  enableHttp2?: boolean;
}

/**
 * Batch provider statistics.
 */
export interface BatchProviderStats {
  /** Total number of batch flushes */
  totalBatchFlushes: number;
  /** Total number of individual requests processed */
  totalRequestsProcessed: number;
  /** Total number of requests batched together */
  totalRequestsBatched: number;
  /** Total number of requests bypassed (sent individually) */
  totalRequestsBypassed: number;
  /** Total number of batch errors */
  totalBatchErrors: number;
  /** Average batch size */
  avgBatchSize: number;
  /** Number of deduplicated requests (if enabled) */
  totalDeduplicated: number;
  /** Current queue size */
  currentQueueSize: number;
  /** R3 Optimization: Number of requests throttled by rate limiter */
  totalRateLimited: number;
}

// =============================================================================
// Constants
// =============================================================================

/** Methods that support batching */
export const BATCHABLE_METHODS = new Set([
  'eth_call',
  'eth_estimateGas',
  'eth_getTransactionReceipt',
  'eth_getBalance',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getTransactionCount',
  'eth_blockNumber',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getLogs',
]);

/** Methods that should never be batched (time-critical) */
export const NON_BATCHABLE_METHODS = new Set([
  'eth_sendRawTransaction',
  'eth_sendTransaction',
  'eth_subscribe',
  'eth_unsubscribe',
]);

/** Default configuration values */
// R4 Optimization: Increased from 10 to 20 for 15-20% reduction in HTTP overhead
// JSON-RPC batch protocol has minimal per-request overhead, larger batches are more efficient
// @see docs/architecture/adr/ADR-024-rpc-rate-limiting.md
const DEFAULT_MAX_BATCH_SIZE = 20;
const DEFAULT_BATCH_TIMEOUT_MS = 10;
const DEFAULT_MAX_QUEUE_SIZE = 100;

// =============================================================================
// BatchProvider Class
// =============================================================================

/**
 * BatchProvider wraps an ethers JsonRpcProvider to support request batching.
 *
 * Usage:
 * ```typescript
 * const provider = new ethers.JsonRpcProvider(rpcUrl);
 * const batchProvider = new BatchProvider(provider);
 *
 * // Queue requests for batching
 * const [receipt1, receipt2] = await Promise.all([
 *   batchProvider.queueRequest('eth_getTransactionReceipt', [txHash1]),
 *   batchProvider.queueRequest('eth_getTransactionReceipt', [txHash2]),
 * ]);
 *
 * // Or use convenience methods
 * const receipts = await batchProvider.batchGetTransactionReceipts([txHash1, txHash2]);
 * ```
 */
export class BatchProvider {
  private readonly provider: ethers.JsonRpcProvider;
  private readonly config: Required<BatchProviderConfig>;

  // Cached connection info from provider (avoids calling private _getConnection() per flush)
  private readonly cachedUrl: string;
  private readonly cachedHeaders: Record<string, string>;

  private pendingBatch: PendingRequest[] = [];
  private batchTimeout: NodeJS.Timeout | null = null;
  private nextId = 1;
  private isShuttingDown = false;

  // Statistics
  private stats: BatchProviderStats = {
    totalBatchFlushes: 0,
    totalRequestsProcessed: 0,
    totalRequestsBatched: 0,
    totalRequestsBypassed: 0,
    totalBatchErrors: 0,
    avgBatchSize: 0,
    totalDeduplicated: 0,
    currentQueueSize: 0,
    totalRateLimited: 0,
  };

  // Deduplication map (only when enabled)
  private deduplicationMap: Map<string, PendingRequest[]> | null = null;

  // R3 Optimization: Rate limiter instance (only when enabled)
  private rateLimiter: TokenBucketRateLimiter | null = null;

  // P3 Enhancement: HTTP/2 session pool (only when enabled)
  private http2Pool: Http2SessionPool | null = null;

  constructor(provider: ethers.JsonRpcProvider, config?: BatchProviderConfig) {
    this.provider = provider;

    // Resolve rate limit config once so stored config matches actual limiter
    const resolvedRateLimitConfig = config?.rateLimitConfig
      ?? getRateLimitConfig(config?.chainOrProvider ?? 'default');

    this.config = {
      maxBatchSize: config?.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
      batchTimeoutMs: config?.batchTimeoutMs ?? DEFAULT_BATCH_TIMEOUT_MS,
      enabled: config?.enabled ?? true,
      maxQueueSize: config?.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
      // R1 Optimization: Enable deduplication by default to reduce 5-10% redundant RPC calls
      enableDeduplication: config?.enableDeduplication ?? true,
      // R3 Optimization: Rate limiting (opt-in for backward compatibility)
      enableRateLimiting: config?.enableRateLimiting ?? false,
      rateLimitConfig: resolvedRateLimitConfig,
      chainOrProvider: config?.chainOrProvider ?? 'default',
      enableHttp2: config?.enableHttp2 ?? false,
    };

    // Cache connection URL and headers at construction time.
    // This avoids calling the private _getConnection() on every batch flush,
    // reducing coupling to ethers internals.
    const connection = this.provider._getConnection();
    this.cachedUrl = connection.url;
    this.cachedHeaders = { 'Content-Type': 'application/json' };
    // Forward auth headers from provider's FetchRequest if present
    const authHeader = this.extractAuthHeader(connection);
    if (authHeader) {
      this.cachedHeaders['Authorization'] = authHeader;
    }

    if (this.config.enableDeduplication) {
      this.deduplicationMap = new Map();
    }

    // R3 Optimization: Initialize rate limiter if enabled
    if (this.config.enableRateLimiting) {
      this.rateLimiter = new TokenBucketRateLimiter(this.config.rateLimitConfig);
    }

    // P3 Enhancement: Initialize HTTP/2 session pool if enabled
    if (this.config.enableHttp2) {
      this.http2Pool = new Http2SessionPool();
      logger.info('HTTP/2 transport enabled for batch RPC calls');
    }
  }

  // ===========================================================================
  // Core API
  // ===========================================================================

  /**
   * Queue a request for batching.
   *
   * Automatically flushes when batch size reached or timeout expires.
   * Non-batchable methods are sent immediately without batching.
   *
   * @param method - JSON-RPC method name
   * @param params - Method parameters
   * @returns Promise resolved when the request completes
   */
  async queueRequest<T = unknown>(method: string, params: unknown[]): Promise<T> {
    // Check if shutting down
    if (this.isShuttingDown) {
      throw new Error('BatchProvider is shutting down');
    }

    // R3 Optimization: Check rate limiter before processing (hot-path exempt methods bypass)
    if (this.rateLimiter && !isRateLimitExempt(method)) {
      if (!this.rateLimiter.tryAcquire()) {
        this.stats.totalRateLimited++;
        throw new Error(`Rate limited: ${method} - too many requests`);
      }
    }

    // Bypass batching if disabled or method is not batchable
    if (!this.config.enabled || NON_BATCHABLE_METHODS.has(method)) {
      this.stats.totalRequestsBypassed++;
      return this.provider.send(method, params);
    }

    // Check queue size limit
    if (this.pendingBatch.length >= this.config.maxQueueSize) {
      // Force flush before rejecting to try to make room
      await this.flushBatch();
      if (this.pendingBatch.length >= this.config.maxQueueSize) {
        throw new Error(`BatchProvider queue full (${this.config.maxQueueSize})`);
      }
    }

    return new Promise<T>((resolve, reject) => {
      const request: PendingRequest = {
        method,
        params,
        resolve: resolve as (value: unknown) => void,
        reject,
        timestamp: Date.now(),
      };

      // Handle deduplication if enabled
      if (this.deduplicationMap) {
        const key = this.getDeduplicationKey(method, params);
        const existing = this.deduplicationMap.get(key);

        if (existing) {
          // Add to existing deduplication group
          existing.push(request);
          this.stats.totalDeduplicated++;
          return;
        }

        // Create new deduplication group
        this.deduplicationMap.set(key, [request]);
      }

      // Add to pending batch
      this.pendingBatch.push(request);
      this.stats.currentQueueSize = this.pendingBatch.length;

      // Schedule flush on first request
      if (!this.batchTimeout) {
        this.batchTimeout = setTimeout(() => {
          this.flushBatch().catch((error) => {
            // Log but don't throw - individual requests will be rejected
            logger.error('Batch flush error', { error });
          });
        }, this.config.batchTimeoutMs);
      }

      // Auto-flush if batch is full
      if (this.pendingBatch.length >= this.config.maxBatchSize) {
        this.flushBatch().catch((error) => {
          // Log but don't throw - individual requests will be rejected
          logger.error('Batch flush error', { error });
        });
      }
    });
  }

  /**
   * Execute batch immediately.
   *
   * Sends all pending requests as a single HTTP request.
   * Each individual promise is resolved/rejected based on its result.
   */
  async flushBatch(): Promise<void> {
    // Clear timeout if set
    this.batchTimeout = clearTimeoutSafe(this.batchTimeout);

    // Get pending requests
    const batch = this.pendingBatch;
    this.pendingBatch = [];
    this.stats.currentQueueSize = 0;

    // FIX: Save dedup groups before clearing so we can propagate results
    // to duplicate callers after the primary request resolves.
    // Previously, the map was cleared here and duplicate promises were never
    // resolved/rejected, causing permanent hangs for any deduplicated request.
    let savedDedupGroups: Map<string, PendingRequest[]> | null = null;
    if (this.deduplicationMap) {
      if (this.deduplicationMap.size > 0) {
        savedDedupGroups = new Map(this.deduplicationMap);
      }
      this.deduplicationMap.clear();
    }

    // Nothing to flush
    if (batch.length === 0) {
      return;
    }

    // Single request - no need for batch format
    if (batch.length === 1) {
      const request = batch[0];
      try {
        const result = await this.provider.send(request.method, request.params);
        request.resolve(result);
        this.resolveDedupGroup(savedDedupGroups, request, result, null);
        this.stats.totalRequestsProcessed++;
      } catch (error) {
        const errorObj = error instanceof Error ? error : new Error(String(error));
        request.reject(errorObj);
        this.resolveDedupGroup(savedDedupGroups, request, undefined, errorObj);
        this.stats.totalBatchErrors++;
      }
      return;
    }

    // Build batch request
    const batchRequest: JsonRpcRequest[] = batch.map((req, index) => ({
      jsonrpc: '2.0',
      method: req.method,
      params: req.params,
      id: index + this.nextId,
    }));

    this.nextId += batch.length;

    try {
      // Send batch request
      // Note: ethers provider.send doesn't support batch natively,
      // so we use the underlying FetchRequest or direct fetch
      const responses = await this.sendBatchRequest(batchRequest);

      // Update statistics
      this.stats.totalBatchFlushes++;
      this.stats.totalRequestsProcessed += batch.length;
      this.stats.totalRequestsBatched += batch.length;
      this.updateAverageBatchSize(batch.length);

      // Resolve individual promises and propagate to dedup groups
      this.resolveResponses(batch, batchRequest, responses, savedDedupGroups);

    } catch (error) {
      // Batch-level error - reject all pending requests and their dedup groups
      this.stats.totalBatchErrors++;
      const errorObj = error instanceof Error ? error : new Error(String(error));

      for (const request of batch) {
        request.reject(errorObj);
        this.resolveDedupGroup(savedDedupGroups, request, undefined, errorObj);
      }
    }
  }

  /**
   * Shut down the batch provider.
   *
   * Flushes any pending requests and prevents new requests.
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;

    // Flush any pending requests
    await this.flushBatch();

    // Clear timeout
    this.batchTimeout = clearTimeoutSafe(this.batchTimeout);

    // Close HTTP/2 sessions
    if (this.http2Pool) {
      await this.http2Pool.close();
      this.http2Pool = null;
    }
  }

  // ===========================================================================
  // Convenience Methods
  // ===========================================================================

  /**
   * Batch multiple eth_estimateGas calls.
   *
   * @param transactions - Array of transaction objects
   * @returns Array of gas estimates
   */
  async batchEstimateGas(
    transactions: ethers.TransactionRequest[]
  ): Promise<(bigint | Error)[]> {
    const results = await Promise.allSettled(
      transactions.map((tx) => this.queueRequest<string>('eth_estimateGas', [tx]))
    );

    return results.map((result) => {
      if (result.status === 'fulfilled') {
        return BigInt(result.value);
      }
      return result.reason instanceof Error
        ? result.reason
        : new Error(String(result.reason));
    });
  }

  /**
   * Batch multiple eth_call requests.
   *
   * @param calls - Array of { to, data } objects
   * @param blockTag - Block tag (default: 'latest')
   * @returns Array of call results or errors
   */
  async batchCall(
    calls: Array<{ to: string; data: string }>,
    blockTag = 'latest'
  ): Promise<(string | Error)[]> {
    const results = await Promise.allSettled(
      calls.map((call) =>
        this.queueRequest<string>('eth_call', [call, blockTag])
      )
    );

    return results.map((result) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      return result.reason instanceof Error
        ? result.reason
        : new Error(String(result.reason));
    });
  }

  /**
   * Batch multiple eth_getTransactionReceipt calls.
   *
   * @param txHashes - Array of transaction hashes
   * @returns Array of receipts or null (for pending) or errors
   */
  async batchGetTransactionReceipts(
    txHashes: string[]
  ): Promise<(ethers.TransactionReceipt | null | Error)[]> {
    const results = await Promise.allSettled(
      txHashes.map((hash) =>
        this.queueRequest<ethers.TransactionReceipt | null>(
          'eth_getTransactionReceipt',
          [hash]
        )
      )
    );

    return results.map((result) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      return result.reason instanceof Error
        ? result.reason
        : new Error(String(result.reason));
    });
  }

  /**
   * Batch multiple eth_getBalance calls.
   *
   * @param addresses - Array of addresses
   * @param blockTag - Block tag (default: 'latest')
   * @returns Array of balances or errors
   */
  async batchGetBalances(
    addresses: string[],
    blockTag = 'latest'
  ): Promise<(bigint | Error)[]> {
    const results = await Promise.allSettled(
      addresses.map((addr) =>
        this.queueRequest<string>('eth_getBalance', [addr, blockTag])
      )
    );

    return results.map((result) => {
      if (result.status === 'fulfilled') {
        return BigInt(result.value);
      }
      return result.reason instanceof Error
        ? result.reason
        : new Error(String(result.reason));
    });
  }

  // ===========================================================================
  // Statistics
  // ===========================================================================

  /**
   * Get batch provider statistics.
   */
  getStats(): Readonly<BatchProviderStats> {
    return { ...this.stats };
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.stats = {
      totalBatchFlushes: 0,
      totalRequestsProcessed: 0,
      totalRequestsBatched: 0,
      totalRequestsBypassed: 0,
      totalBatchErrors: 0,
      avgBatchSize: 0,
      totalDeduplicated: 0,
      currentQueueSize: this.pendingBatch.length,
      totalRateLimited: 0,
    };
  }

  /**
   * Get batch efficiency ratio.
   * Returns the percentage of requests that were batched vs individual.
   */
  getBatchEfficiency(): number {
    const total = this.stats.totalRequestsBatched + this.stats.totalRequestsBypassed;
    if (total === 0) return 0;
    return (this.stats.totalRequestsBatched / total) * 100;
  }

  /**
   * Check if batching is enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Get underlying provider.
   */
  getProvider(): ethers.JsonRpcProvider {
    return this.provider;
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Send batch request to the RPC endpoint.
   *
   * Note: ethers.JsonRpcProvider doesn't natively support batch requests,
   * so we use fetch directly with the provider's cached URL.
   * Auth headers from the provider's connection are forwarded automatically.
   */
  private async sendBatchRequest(
    batchRequest: JsonRpcRequest[]
  ): Promise<JsonRpcResponse[]> {
    const bodyStr = JSON.stringify(batchRequest);

    // P3 Enhancement: Use HTTP/2 when enabled, fall back to fetch on error
    if (this.http2Pool) {
      try {
        const h2Response = await this.http2Pool.request(this.cachedUrl, {
          method: 'POST',
          headers: this.cachedHeaders,
          body: bodyStr,
        });

        if (h2Response.status < 200 || h2Response.status >= 300) {
          throw new Error(`HTTP/2 error: ${h2Response.status}`);
        }

        const results = JSON.parse(h2Response.body);
        if (!Array.isArray(results)) {
          throw new Error('Invalid batch response: expected array');
        }
        return results;
      } catch (h2Error) {
        // Fall back to HTTP/1.1 fetch
        logger.debug('HTTP/2 request failed, falling back to fetch', {
          error: h2Error instanceof Error ? h2Error.message : String(h2Error),
        });
      }
    }

    const response = await fetch(this.cachedUrl, {
      method: 'POST',
      headers: this.cachedHeaders,
      body: bodyStr,
    });

    if (!response.ok) {
      throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
    }

    const results = await response.json();

    // Validate response is an array
    if (!Array.isArray(results)) {
      throw new Error('Invalid batch response: expected array');
    }

    return results;
  }

  /**
   * Extract Authorization header from an ethers FetchRequest connection, if present.
   */
  private extractAuthHeader(connection: unknown): string | null {
    // ethers v6 FetchRequest exposes getHeader() for accessing request headers
    if (connection && typeof connection === 'object' && 'getHeader' in connection) {
      const conn = connection as { getHeader: (name: string) => string | undefined };
      const auth = conn.getHeader('Authorization');
      if (auth) return auth;
    }
    return null;
  }

  /**
   * Resolve individual promises from batch response.
   * Also propagates results to deduplicated request groups.
   */
  private resolveResponses(
    batch: PendingRequest[],
    requests: JsonRpcRequest[],
    responses: JsonRpcResponse[],
    dedupGroups: Map<string, PendingRequest[]> | null
  ): void {
    // Create ID to response map for efficient lookup
    const responseMap = new Map<number | string, JsonRpcResponse>();
    for (const response of responses) {
      responseMap.set(response.id, response);
    }

    // Resolve each request
    for (let i = 0; i < batch.length; i++) {
      const request = batch[i];
      const rpcRequest = requests[i];
      const response = responseMap.get(rpcRequest.id);

      if (!response) {
        const error = new Error(`No response for request ID ${rpcRequest.id}`);
        request.reject(error);
        this.resolveDedupGroup(dedupGroups, request, undefined, error);
        continue;
      }

      if (response.error) {
        const error = new Error(`RPC error ${response.error.code}: ${response.error.message}`);
        request.reject(error);
        this.resolveDedupGroup(dedupGroups, request, undefined, error);
        continue;
      }

      request.resolve(response.result);
      this.resolveDedupGroup(dedupGroups, request, response.result, null);
    }
  }

  /**
   * Propagate a result or error to all duplicate requests in a dedup group.
   *
   * When deduplication is enabled, the first request for a given (method, params)
   * goes into pendingBatch. Subsequent identical requests are stored only in the
   * dedup group (index 1+). After the primary request resolves, this method
   * resolves/rejects all the duplicates with the same outcome.
   */
  private resolveDedupGroup(
    dedupGroups: Map<string, PendingRequest[]> | null,
    primaryRequest: PendingRequest,
    result: unknown,
    error: Error | null
  ): void {
    if (!dedupGroups) return;

    const key = this.getDeduplicationKey(primaryRequest.method, primaryRequest.params);
    const group = dedupGroups.get(key);
    if (!group) return;

    // Index 0 is the primary request (already resolved/rejected by caller).
    // Propagate to duplicates at index 1+.
    for (let i = 1; i < group.length; i++) {
      if (error) {
        group[i].reject(error);
      } else {
        group[i].resolve(result);
      }
    }

    // Remove from map so we don't double-process
    dedupGroups.delete(key);
  }

  /**
   * Generate deduplication key for a request.
   */
  private getDeduplicationKey(method: string, params: unknown[]): string {
    return `${method}:${JSON.stringify(params)}`;
  }

  /**
   * Update rolling average batch size.
   */
  private updateAverageBatchSize(newSize: number): void {
    const totalBatches = this.stats.totalBatchFlushes;
    const prevAvg = this.stats.avgBatchSize;

    // Incremental average calculation
    this.stats.avgBatchSize = prevAvg + (newSize - prevAvg) / totalBatches;
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a new BatchProvider instance.
 *
 * @param provider - ethers JsonRpcProvider
 * @param config - Optional configuration
 * @returns BatchProvider instance
 */
export function createBatchProvider(
  provider: ethers.JsonRpcProvider,
  config?: BatchProviderConfig
): BatchProvider {
  return new BatchProvider(provider, config);
}
