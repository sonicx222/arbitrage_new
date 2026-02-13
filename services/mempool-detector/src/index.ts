/**
 * Mempool Detector Service Entry Point
 *
 * Service for detecting arbitrage opportunities from pending transactions
 * via bloXroute BDN and other mempool data providers.
 *
 * Features:
 * - bloXroute BDN integration for pre-block transaction detection
 * - Pending transaction decoding and filtering
 * - Redis Streams publishing for detected opportunities
 * - Health monitoring and metrics (HTTP endpoint)
 * - O(1) latency tracking with circular buffer
 *
 * @see Phase 1: Mempool Detection Service (Implementation Plan v3.0)
 */

import { EventEmitter } from 'events';
import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import {
  createLogger,
  CircularBuffer,
  getRedisStreamsClient,
  resetRedisStreamsInstance,
  setupServiceShutdown,
  runServiceMain,
  type Logger,
  type RedisStreamsClient,
  type StreamBatcher,
} from '@arbitrage/core';
import {
  MEMPOOL_CONFIG,
  getEnabledMempoolChains,
  CHAIN_NAME_TO_ID,
} from '@arbitrage/config';
import { BloXrouteFeed, createBloXrouteFeed } from './bloxroute-feed';
// Use DecoderRegistry directly for better hot-path performance (no wrapper overhead)
import { DecoderRegistry, createDecoderRegistry } from './decoders';
import {
  DEFAULT_PENDING_OPPORTUNITIES_STREAM,
  DEFAULT_MEMPOOL_DETECTOR_PORT,
  type MempoolDetectorConfig,
  type MempoolDetectorHealth,
  type RawPendingTransaction,
  type PendingSwapIntent,
  type FeedHealthMetrics,
} from './types';
import type { PendingOpportunity, PendingSwapIntent as SerializablePendingSwapIntent } from '@arbitrage/types';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Validate and sanitize a numeric config value.
 * Ensures value is a positive integer within valid range.
 *
 * @param value - Raw config value (may be NaN, 0, negative)
 * @param defaultValue - Fallback if invalid
 * @param min - Minimum valid value (inclusive)
 * @param max - Maximum valid value (inclusive)
 * @param fieldName - Field name for error messages
 * @returns Validated number
 */
function validateNumericConfig(
  value: number,
  defaultValue: number,
  min: number,
  max: number,
  fieldName: string
): number {
  // Handle NaN (from malformed parseInt)
  if (isNaN(value)) {
    return defaultValue;
  }

  // Validate range
  if (value < min || value > max) {
    console.warn(
      `[WARN] Invalid ${fieldName}: ${value}. Must be ${min}-${max}. Using default: ${defaultValue}`
    );
    return defaultValue;
  }

  return value;
}

/**
 * Default service configuration.
 *
 * IMPORTANT: minSwapSizeUsd CAN be 0 (to capture all swaps), but other numeric
 * fields must be positive. Using ?? is insufficient because parseInt() never
 * returns undefined - it returns number or NaN.
 */
export const DEFAULT_CONFIG: Partial<MempoolDetectorConfig> = {
  // Port: 1-65535 (0 is invalid, NaN is invalid)
  healthCheckPort: validateNumericConfig(
    MEMPOOL_CONFIG.service.port,
    DEFAULT_MEMPOOL_DETECTOR_PORT,
    1,
    65535,
    'healthCheckPort'
  ),

  // Stream name: string, safe to use ??
  opportunityStream: MEMPOOL_CONFIG.streams.pendingOpportunities ?? 'stream:pending-opportunities',

  // Min swap size: 0 is valid (capture all), but NaN is not
  minSwapSizeUsd: isNaN(MEMPOOL_CONFIG.filters.minSwapSizeUsd)
    ? 1000
    : Math.max(0, MEMPOOL_CONFIG.filters.minSwapSizeUsd),

  // Buffer size: Must be >= 1 (can't have 0-size buffer)
  maxBufferSize: validateNumericConfig(
    MEMPOOL_CONFIG.service.maxBufferSize,
    10000,
    1,
    1000000,
    'maxBufferSize'
  ),

  // Batch size: Must be >= 1 (can't batch 0 items)
  batchSize: validateNumericConfig(
    MEMPOOL_CONFIG.service.batchSize,
    100,
    1,
    10000,
    'batchSize'
  ),

  // Batch timeout: 0 is valid (immediate flush), but NaN is not
  batchTimeoutMs: isNaN(MEMPOOL_CONFIG.service.batchTimeoutMs)
    ? 50
    : Math.max(0, MEMPOOL_CONFIG.service.batchTimeoutMs),
};

/**
 * Latency buffer size for O(1) percentile calculation.
 * FIX 4.2/10.4: Use circular buffer instead of array.shift()
 */
const LATENCY_BUFFER_SIZE = 1000;

/**
 * Maximum stream length to prevent unbounded growth.
 * Applied to Redis stream batcher for automatic trimming.
 */
const MAX_STREAM_LENGTH = 50000;

/**
 * High-resolution timer for accurate latency measurement.
 * Uses performance.now() for sub-millisecond precision.
 */
const getHighResTime = (): number => {
  // performance.now() provides microsecond precision
  return performance.now();
};

/**
 * FIX 4.1/6.1: Convert local PendingSwapIntent (bigint) to serializable format.
 * BigInt cannot be JSON.stringify'd, so we convert to strings for Redis publishing.
 *
 * @param intent - Local PendingSwapIntent with bigint fields
 * @returns Serializable PendingSwapIntent with string fields
 */
function toSerializableIntent(intent: PendingSwapIntent): SerializablePendingSwapIntent {
  return {
    hash: intent.hash,
    router: intent.router,
    type: intent.type,
    tokenIn: intent.tokenIn,
    tokenOut: intent.tokenOut,
    amountIn: intent.amountIn.toString(),
    expectedAmountOut: intent.expectedAmountOut.toString(),
    path: intent.path,
    slippageTolerance: intent.slippageTolerance,
    deadline: intent.deadline,
    sender: intent.sender,
    gasPrice: intent.gasPrice.toString(),
    maxFeePerGas: intent.maxFeePerGas?.toString(),
    maxPriorityFeePerGas: intent.maxPriorityFeePerGas?.toString(),
    nonce: intent.nonce,
    chainId: intent.chainId,
    firstSeen: intent.firstSeen,
  };
}

/**
 * FIX 4.1: Wrap PendingSwapIntent in PendingOpportunity for cross-chain-detector.
 * The cross-chain-detector expects a wrapper with type='pending' discriminator.
 *
 * @param intent - Local PendingSwapIntent with bigint fields
 * @returns PendingOpportunity wrapper with serializable intent
 */
function createPendingOpportunity(intent: PendingSwapIntent): PendingOpportunity {
  return {
    type: 'pending',
    intent: toSerializableIntent(intent),
    publishedAt: Date.now(),
  };
}

// =============================================================================
// SERVICE CLASS
// =============================================================================

/**
 * Mempool Detector Service
 *
 * Connects to mempool data providers (bloXroute BDN) to receive pending
 * transactions before they are included in blocks. Decodes swap intents
 * and publishes potential arbitrage opportunities.
 *
 * @example
 * ```typescript
 * const service = createMempoolDetectorService({
 *   instanceId: 'mempool-detector-1',
 *   chains: ['ethereum', 'bsc'],
 *   healthCheckPort: 3007,
 * });
 *
 * service.on('pendingOpportunity', (opportunity) => {
 *   console.log('Pending opportunity detected:', opportunity);
 * });
 *
 * await service.start();
 * ```
 */
export class MempoolDetectorService extends EventEmitter {
  private config: MempoolDetectorConfig;
  private logger: Logger;
  private feeds: Map<string, BloXrouteFeed> = new Map();
  private isRunning = false;
  private startTime = 0;

  // FIX 1.1: Health HTTP server
  private healthServer: Server | null = null;

  // FIX 1.2/7.1: Redis publishing
  private streamsClient: RedisStreamsClient | null = null;
  // FIX 4.1: Batcher now publishes PendingOpportunity wrapper (not raw PendingSwapIntent)
  private streamBatcher: StreamBatcher<PendingOpportunity> | null = null;

  // FIX 2.1: Swap decoder (using DecoderRegistry directly for hot-path performance)
  private swapDecoder: DecoderRegistry | null = null;

  // FIX 1.3/7.1: Transaction buffer with backpressure
  private txBuffer: CircularBuffer<{ tx: RawPendingTransaction; chainId: string }>;

  // FIX 4.2/10.4: Use CircularBuffer for O(1) latency tracking
  private latencyBuffer: CircularBuffer<number>;

  // Statistics (FIX 6.3: All metrics are now used)
  private stats = {
    txReceived: 0,
    txDecoded: 0,
    txDecodeFailures: 0,
    opportunitiesPublished: 0,
    bufferOverflows: 0,
  };

  constructor(config: Partial<MempoolDetectorConfig> = {}) {
    super();

    // FIX 4.3: Set max listeners to prevent memory leak warnings
    this.setMaxListeners(20);

    // Merge with default config
    this.config = {
      instanceId: config.instanceId || MEMPOOL_CONFIG.service.instanceId || `mempool-detector-${Date.now()}`,
      chains: config.chains || getEnabledMempoolChains(),
      healthCheckPort: config.healthCheckPort ?? DEFAULT_CONFIG.healthCheckPort!,
      opportunityStream: config.opportunityStream ?? DEFAULT_CONFIG.opportunityStream,
      minSwapSizeUsd: config.minSwapSizeUsd ?? DEFAULT_CONFIG.minSwapSizeUsd,
      maxBufferSize: config.maxBufferSize ?? DEFAULT_CONFIG.maxBufferSize,
      batchSize: config.batchSize ?? DEFAULT_CONFIG.batchSize,
      batchTimeoutMs: config.batchTimeoutMs ?? DEFAULT_CONFIG.batchTimeoutMs,
      bloxroute: config.bloxroute,
    };

    this.logger = createLogger('mempool-detector');

    // FIX 4.2/10.4: Initialize circular buffers
    this.latencyBuffer = new CircularBuffer<number>(LATENCY_BUFFER_SIZE);
    this.txBuffer = new CircularBuffer<{ tx: RawPendingTransaction; chainId: string }>(
      this.config.maxBufferSize!
    );

    // Configuration validation
    this.validateConfig();
  }

  /**
   * Validate configuration values.
   * @throws Error if configuration is invalid
   */
  private validateConfig(): void {
    // Validate port is in valid range
    if (this.config.healthCheckPort < 1 || this.config.healthCheckPort > 65535) {
      throw new Error(`Invalid health check port: ${this.config.healthCheckPort}. Must be between 1 and 65535.`);
    }

    // Validate chains array is not empty
    if (!this.config.chains || this.config.chains.length === 0) {
      this.logger.warn('No chains configured for mempool detection');
    }

    // Validate numeric values are positive
    if (this.config.minSwapSizeUsd !== undefined && this.config.minSwapSizeUsd < 0) {
      throw new Error(`Invalid minSwapSizeUsd: ${this.config.minSwapSizeUsd}. Must be non-negative.`);
    }

    if (this.config.maxBufferSize !== undefined && this.config.maxBufferSize < 1) {
      throw new Error(`Invalid maxBufferSize: ${this.config.maxBufferSize}. Must be at least 1.`);
    }

    if (this.config.batchSize !== undefined && this.config.batchSize < 1) {
      throw new Error(`Invalid batchSize: ${this.config.batchSize}. Must be at least 1.`);
    }

    this.logger.debug('Configuration validated', {
      instanceId: this.config.instanceId,
      chains: this.config.chains,
      healthCheckPort: this.config.healthCheckPort,
    });
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Start the mempool detector service.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Service already running');
      return;
    }

    this.logger.info('Starting mempool detector service', {
      instanceId: this.config.instanceId,
      chains: this.config.chains,
      healthCheckPort: this.config.healthCheckPort,
    });

    try {
      // FIX 2.1: Initialize swap decoder (using DecoderRegistry directly for hot-path performance)
      this.swapDecoder = createDecoderRegistry(this.logger);

      // FIX 1.2: Initialize Redis streams client
      await this.initializeRedisStreams();

      // FIX 1.1: Start health HTTP server
      this.startHealthServer();

      // Initialize feeds for each chain
      await this.initializeFeeds();

      this.isRunning = true;
      this.startTime = Date.now();

      this.logger.info('Mempool detector service started', {
        instanceId: this.config.instanceId,
        feedCount: this.feeds.size,
        healthPort: this.config.healthCheckPort,
      });

      this.emit('started');
    } catch (error) {
      this.logger.error('Failed to start service', { error });
      // Cleanup on failure
      await this.cleanup();
      throw error;
    }
  }

  /**
   * Stop the mempool detector service.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      this.logger.debug('Service not running');
      return;
    }

    this.logger.info('Stopping mempool detector service', {
      instanceId: this.config.instanceId,
    });

    await this.cleanup();

    this.isRunning = false;

    this.logger.info('Mempool detector service stopped');
    this.emit('stopped');
  }

  /**
   * Cleanup all resources.
   */
  private async cleanup(): Promise<void> {
    // Close health server
    if (this.healthServer) {
      await new Promise<void>((resolve) => {
        this.healthServer!.close(() => resolve());
      });
      this.healthServer = null;
      this.logger.debug('Health server closed');
    }

    // Disconnect all feeds
    for (const [chainId, feed] of this.feeds) {
      try {
        feed.disconnect();
        this.logger.debug('Disconnected feed', { chainId });
      } catch (error) {
        this.logger.error('Error disconnecting feed', { chainId, error });
      }
    }
    this.feeds.clear();

    // Flush and close Redis streams
    if (this.streamBatcher) {
      try {
        await this.streamBatcher.destroy();
      } catch (error) {
        this.logger.error('Error destroying stream batcher', { error });
      }
      this.streamBatcher = null;
    }

    if (this.streamsClient) {
      try {
        await resetRedisStreamsInstance();
      } catch (error) {
        this.logger.error('Error closing Redis streams', { error });
      }
      this.streamsClient = null;
    }
  }

  /**
   * Get service health status.
   */
  getHealth(): MempoolDetectorHealth {
    const feedHealth: Record<string, FeedHealthMetrics> = {};

    for (const [chainId, feed] of this.feeds) {
      feedHealth[chainId] = feed.getHealth();
    }

    // FIX 4.2/10.4: Calculate percentiles from circular buffer (single sort pass)
    const { p50: latencyP50, p99: latencyP99 } = this.calculatePercentiles();

    // Determine health status based on feed health
    let status: 'healthy' | 'degraded' | 'unhealthy' = 'unhealthy';
    if (this.isRunning) {
      const feedCount = this.feeds.size;
      const healthyFeeds = [...this.feeds.values()].filter(
        f => f.getHealth().connectionState === 'connected'
      ).length;

      if (healthyFeeds === feedCount && feedCount > 0) {
        status = 'healthy';
      } else if (healthyFeeds > 0) {
        status = 'degraded';
      }
    }

    return {
      instanceId: this.config.instanceId,
      status,
      feeds: feedHealth,
      bufferSize: this.txBuffer.size,
      stats: {
        txReceived: this.stats.txReceived,
        txDecoded: this.stats.txDecoded,
        opportunitiesPublished: this.stats.opportunitiesPublished,
        latencyP50,
        latencyP99,
      },
      uptime: this.isRunning ? Date.now() - this.startTime : 0,
      timestamp: Date.now(),
    };
  }

  /**
   * Simulate a feed error for testing.
   */
  simulateFeedError(error: Error): void {
    this.logger.error('Simulated feed error', { error: error.message });
    this.emit('error', error);
  }

  // ===========================================================================
  // Private Methods - Initialization
  // ===========================================================================

  /**
   * FIX 1.2: Initialize Redis streams client and batcher.
   */
  private async initializeRedisStreams(): Promise<void> {
    try {
      this.streamsClient = await getRedisStreamsClient();

      // Create batcher for efficient publishing
      // FIX 2.2: Use default from types.ts instead of removed constant
      // FIX 4.1: Batcher now publishes PendingOpportunity wrapper
      this.streamBatcher = this.streamsClient.createBatcher<PendingOpportunity>(
        this.config.opportunityStream || DEFAULT_PENDING_OPPORTUNITIES_STREAM,
        {
          maxBatchSize: this.config.batchSize!,
          maxWaitMs: this.config.batchTimeoutMs!,
        }
      );

      this.logger.info('Redis streams client initialized');
    } catch (error) {
      this.logger.warn('Failed to initialize Redis streams - running without publishing', {
        error: (error as Error).message,
      });
      // Don't throw - service can run without Redis for local testing
    }
  }

  /**
   * FIX 1.1: Start HTTP health check server.
   */
  private startHealthServer(): void {
    this.healthServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/health' || req.url === '/') {
        const health = this.getHealth();
        const statusCode = health.status === 'healthy' ? 200 :
                          health.status === 'degraded' ? 200 : 503;

        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(health));
      } else if (req.url === '/ready') {
        const ready = this.isRunning && this.feeds.size > 0;
        res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ready,
          instanceId: this.config.instanceId,
          feedCount: this.feeds.size,
        }));
      } else if (req.url === '/stats') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          instanceId: this.config.instanceId,
          stats: this.stats,
          bufferStats: this.txBuffer.getStats(),
          latencyBufferStats: this.latencyBuffer.getStats(),
          batcherStats: this.streamBatcher?.getStats() ?? null,
        }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });

    this.healthServer.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        this.logger.error('Health server port already in use', {
          port: this.config.healthCheckPort,
        });
      } else {
        this.logger.error('Health server error', { error: error.message });
      }
    });

    this.healthServer.listen(this.config.healthCheckPort, () => {
      this.logger.info('Health server listening', {
        port: this.config.healthCheckPort,
        endpoints: ['/health', '/ready', '/stats'],
      });
    });
  }

  /**
   * Initialize feeds for configured chains.
   */
  private async initializeFeeds(): Promise<void> {
    if (!MEMPOOL_CONFIG.enabled) {
      this.logger.warn('Mempool detection is disabled in config');
      return;
    }

    // Initialize bloXroute feed if enabled
    if (MEMPOOL_CONFIG.bloxroute.enabled) {
      await this.initializeBloXrouteFeed();
    }
  }

  /**
   * Initialize bloXroute BDN feed.
   */
  private async initializeBloXrouteFeed(): Promise<void> {
    const bloxConfig = MEMPOOL_CONFIG.bloxroute;

    if (!bloxConfig.authHeader) {
      this.logger.warn('bloXroute auth header not configured');
      return;
    }

    // Log which configured chains lack BloXroute endpoint support
    const unsupportedChains = this.config.chains.filter(
      chain => !this.getBloXrouteEndpoint(chain)
    );
    if (unsupportedChains.length > 0) {
      this.logger.warn('Configured chains without BloXroute BDN endpoint support', {
        unsupportedChains,
        supportedChains: ['ethereum', 'bsc'],
        hint: 'These chains will not receive mempool data via BloXroute',
      });
    }

    // Create feeds for each enabled chain
    for (const chainId of this.config.chains) {
      const chainSettings = MEMPOOL_CONFIG.chainSettings[chainId];

      if (!chainSettings?.enabled || chainSettings.feedType !== 'bloxroute') {
        continue;
      }

      const endpoint = this.getBloXrouteEndpoint(chainId);
      if (!endpoint) {
        this.logger.warn('No bloXroute endpoint for chain', { chainId });
        continue;
      }

      try {
        const feed = createBloXrouteFeed({
          config: {
            authHeader: bloxConfig.authHeader,
            endpoint,
            chains: [chainId],
            includeRouters: MEMPOOL_CONFIG.filters.includeRouters,
            includeTraders: MEMPOOL_CONFIG.filters.includeTraders,
            connectionTimeout: bloxConfig.connectionTimeout,
            heartbeatInterval: bloxConfig.heartbeatInterval,
            reconnect: bloxConfig.reconnect,
          },
          logger: this.logger.child({ chainId }),
        });

        // FIX 4.3: Set max listeners on feed
        feed.setMaxListeners(10);

        // Set up event handlers
        this.setupFeedHandlers(feed, chainId);

        // Connect to the feed
        await feed.connect();
        feed.subscribePendingTxs();

        this.feeds.set(chainId, feed);
        this.logger.info('Initialized bloXroute feed', { chainId, endpoint });

      } catch (error) {
        this.logger.error('Failed to initialize bloXroute feed', { chainId, error });
      }
    }
  }

  /**
   * Get bloXroute endpoint for a chain.
   *
   * Currently only Ethereum and BSC have dedicated BloXroute BDN WebSocket
   * endpoints. Other chains (Arbitrum, Polygon, etc.) require different
   * mempool data providers or BloXroute plan upgrades.
   */
  private getBloXrouteEndpoint(chainId: string): string | null {
    const bloxConfig = MEMPOOL_CONFIG.bloxroute;

    switch (chainId.toLowerCase()) {
      case 'ethereum':
        return bloxConfig.wsEndpoint;
      case 'bsc':
        return bloxConfig.bscWsEndpoint;
      default:
        return null;
    }
  }

  /**
   * Set up event handlers for a feed.
   */
  private setupFeedHandlers(feed: BloXrouteFeed, chainId: string): void {
    feed.on('pendingTx', (tx: RawPendingTransaction) => {
      this.handlePendingTransaction(tx, chainId);
    });

    feed.on('error', (error: Error) => {
      this.logger.error('Feed error', { chainId, error: error.message });
      this.emit('error', error);
    });

    feed.on('disconnected', () => {
      this.logger.warn('Feed disconnected', { chainId });
    });

    feed.on('reconnecting', ({ attempt, delay }) => {
      this.logger.info('Feed reconnecting', { chainId, attempt, delay });
    });
  }

  // ===========================================================================
  // Private Methods - Transaction Processing
  // ===========================================================================

  /**
   * Handle a pending transaction from a feed.
   *
   * FIX 1.1: Implements backpressure via txBuffer
   * FIX 4.1: Uses high-resolution timer for accurate latency
   * FIX 4.5: Only counts published after successful add
   * FIX 6.1: Consistent error handling
   */
  private handlePendingTransaction(tx: RawPendingTransaction, chainId: string): void {
    this.stats.txReceived++;

    // FIX 4.1: Use high-resolution timer for accurate sub-ms latency measurement
    const startTime = getHighResTime();

    try {
      // FIX 4.2: Guard against uninitialized decoder
      if (!this.swapDecoder) {
        this.logger.error('swapDecoder not initialized - cannot process transaction');
        return;
      }

      // FIX 2.1: Decode transaction to extract swap intent
      const chainNumericId = CHAIN_NAME_TO_ID[chainId.toLowerCase()] ?? tx.chainId ?? 1;
      const swapIntent = this.swapDecoder.decode(tx, chainNumericId);

      if (!swapIntent) {
        // FIX 6.2: Only count as failure if selector was recognized but decode failed
        // Most transactions are NOT swaps - only count failures for actual swap attempts
        const selector = tx.input?.slice(0, 10)?.toLowerCase();
        if (selector && this.swapDecoder.getDecoderForSelector(selector)) {
          // Selector was recognized but decode failed - this is a true failure
          this.stats.txDecodeFailures++;
        }
        // Non-swap transactions (no recognized selector) are expected - don't count as failures
        return;
      }

      this.stats.txDecoded++;

      // FIX 4.5: Publish to Redis stream - only count on successful add
      // FIX 4.1: Wrap in PendingOpportunity and serialize bigint fields
      if (this.streamBatcher) {
        try {
          const pendingOpp = createPendingOpportunity(swapIntent);
          this.streamBatcher.add(pendingOpp);
          this.stats.opportunitiesPublished++;
        } catch (publishError) {
          this.logger.warn('Failed to add to stream batcher', {
            txHash: tx.hash,
            error: (publishError as Error).message,
          });
        }
      }

      // FIX 4.1: Record latency with O(1) circular buffer using high-res time
      const latency = getHighResTime() - startTime;
      this.latencyBuffer.pushOverwrite(latency);

      // FIX 1.1: Add to buffer for backpressure tracking
      const added = this.txBuffer.push({ tx, chainId });
      if (!added) {
        // Buffer full - track overflow
        this.stats.bufferOverflows++;
        this.txBuffer.pushOverwrite({ tx, chainId });
      }

      // FIX 10.2.4: Only emit events if there are listeners (hot path optimization)
      if (this.listenerCount('pendingTx') > 0) {
        this.emit('pendingTx', { tx, chainId, swapIntent });
      }
      if (this.listenerCount('swapIntent') > 0) {
        this.emit('swapIntent', swapIntent);
      }

    } catch (error) {
      this.stats.txDecodeFailures++;
      this.logger.error('Error processing pending tx', {
        txHash: tx.hash,
        chainId,
        error: (error as Error).message,
      });
    }
  }

  // ===========================================================================
  // Private Methods - Performance Optimizations
  // ===========================================================================

  /**
   * FIX 4.2/10.4: Calculate percentiles from circular buffer.
   * Sorts once and returns both P50 and P99 to avoid redundant sorts.
   */
  private calculatePercentiles(): { p50: number; p99: number } {
    if (this.latencyBuffer.isEmpty) {
      return { p50: 0, p99: 0 };
    }

    const samples = this.latencyBuffer.toArray();
    samples.sort((a, b) => a - b);

    const p50Index = Math.max(0, Math.ceil(0.5 * samples.length) - 1);
    const p99Index = Math.max(0, Math.ceil(0.99 * samples.length) - 1);
    return { p50: samples[p50Index], p99: samples[p99Index] };
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Create a new MempoolDetectorService instance.
 *
 * @param config - Service configuration
 * @returns Configured MempoolDetectorService instance
 */
export function createMempoolDetectorService(
  config?: Partial<MempoolDetectorConfig>
): MempoolDetectorService {
  return new MempoolDetectorService(config);
}

// =============================================================================
// RE-EXPORTS
// =============================================================================

export * from './types';
export * from './bloxroute-feed';
// R5: Removed deprecated './swap-decoder' re-export - use './decoders' directly
export * from './decoders';

// =============================================================================
// MAIN ENTRY POINT
// =============================================================================

const _bootstrapLogger = createLogger('mempool-detector');

async function main() {
  const service = createMempoolDetectorService();

  await service.start();

  setupServiceShutdown({
    logger: _bootstrapLogger,
    serviceName: 'Mempool Detector',
    onShutdown: async () => {
      await service.stop();
    },
  });
}

runServiceMain({ main, serviceName: 'Mempool Detector Service', logger: _bootstrapLogger });
