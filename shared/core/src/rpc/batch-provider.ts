/**
 * JSON-RPC 2.0 Batch Provider
 *
 * Implements RPC request batching to reduce individual HTTP calls.
 * This is Phase 3 of the RPC Data Optimization Implementation Plan.
 *
 * Batchable Operations (Non-Hot-Path):
 * - eth_estimateGas: Gas estimation before execution
 * - eth_call: Historical reserve queries and simulations
 * - eth_getTransactionReceipt: Post-execution confirmation
 *
 * NOT Batchable (Hot-Path):
 * - eth_call(getReserves): Handled by reserve cache (Phase 1)
 * - eth_sendRawTransaction: Time-critical execution
 *
 * @see RPC_DATA_OPTIMIZATION_IMPLEMENTATION_PLAN.md Phase 3
 */

import { ethers } from 'ethers';

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
  /** Maximum batch size before auto-flush (default: 10) */
  maxBatchSize?: number;
  /** Maximum time to wait before auto-flush in ms (default: 10) */
  batchTimeoutMs?: number;
  /** Enable batching (can be disabled for debugging) (default: true) */
  enabled?: boolean;
  /** Maximum queue size before rejecting new requests (default: 100) */
  maxQueueSize?: number;
  /** Enable request deduplication within batch window (default: false) */
  enableDeduplication?: boolean;
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
const DEFAULT_MAX_BATCH_SIZE = 10;
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
  };

  // Deduplication map (only when enabled)
  private deduplicationMap: Map<string, PendingRequest[]> | null = null;

  constructor(provider: ethers.JsonRpcProvider, config?: BatchProviderConfig) {
    this.provider = provider;
    this.config = {
      maxBatchSize: config?.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
      batchTimeoutMs: config?.batchTimeoutMs ?? DEFAULT_BATCH_TIMEOUT_MS,
      enabled: config?.enabled ?? true,
      maxQueueSize: config?.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
      enableDeduplication: config?.enableDeduplication ?? false,
    };

    if (this.config.enableDeduplication) {
      this.deduplicationMap = new Map();
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
            console.error('Batch flush error:', error);
          });
        }, this.config.batchTimeoutMs);
      }

      // Auto-flush if batch is full
      if (this.pendingBatch.length >= this.config.maxBatchSize) {
        this.flushBatch().catch((error) => {
          // Log but don't throw - individual requests will be rejected
          console.error('Batch flush error:', error);
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
    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
      this.batchTimeout = null;
    }

    // Get pending requests
    const batch = this.pendingBatch;
    this.pendingBatch = [];
    this.stats.currentQueueSize = 0;

    // Clear deduplication map
    if (this.deduplicationMap) {
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
        this.stats.totalRequestsProcessed++;
        this.stats.totalRequestsBypassed++; // Counted as bypassed since no actual batch
      } catch (error) {
        request.reject(error instanceof Error ? error : new Error(String(error)));
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

      // Resolve individual promises
      this.resolveResponses(batch, batchRequest, responses);

    } catch (error) {
      // Batch-level error - reject all pending requests
      this.stats.totalBatchErrors++;
      const errorObj = error instanceof Error ? error : new Error(String(error));

      for (const request of batch) {
        request.reject(errorObj);
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
    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
      this.batchTimeout = null;
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
   * so we use fetch directly with the provider's URL.
   *
   * PERF-2 FIX: Removed unnecessary getNetwork() call that added async overhead
   * on every batch flush. The URL is obtained synchronously from _getConnection().
   */
  private async sendBatchRequest(
    batchRequest: JsonRpcRequest[]
  ): Promise<JsonRpcResponse[]> {
    // PERF-2 FIX: Get URL synchronously (removed async getNetwork() call)
    // _getConnection() returns the URL without network discovery overhead
    const connection = this.provider._getConnection();
    const url = connection.url;

    // Send batch request
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(batchRequest),
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
   * Resolve individual promises from batch response.
   */
  private resolveResponses(
    batch: PendingRequest[],
    requests: JsonRpcRequest[],
    responses: JsonRpcResponse[]
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
        request.reject(new Error(`No response for request ID ${rpcRequest.id}`));
        continue;
      }

      if (response.error) {
        request.reject(
          new Error(`RPC error ${response.error.code}: ${response.error.message}`)
        );
        continue;
      }

      request.resolve(response.result);
    }
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
