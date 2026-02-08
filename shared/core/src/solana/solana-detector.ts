/**
 * S3.3.1 Solana Detector Base Infrastructure
 *
 * Base class for Solana blockchain detection that provides:
 * - @solana/web3.js integration (different from ethers.js for EVM)
 * - Program account subscriptions (not event logs)
 * - Connection pooling for RPC rate limits
 * - Solana-specific price feed handling
 * - Arbitrage detection between Solana DEXs
 *
 * Key Differences from EVM BaseDetector:
 * - Uses Connection instead of JsonRpcProvider
 * - Uses accountSubscribe/programSubscribe instead of eth_subscribe
 * - Program IDs instead of contract addresses
 * - Instruction parsing instead of event log decoding
 * - Slot instead of block number
 *
 * @see IMPLEMENTATION_PLAN.md S3.3.1
 * @see ADR-003: Partitioned Chain Detectors
 */

import { EventEmitter } from 'events';
import { Connection, PublicKey, Commitment, AccountInfo, Context } from '@solana/web3.js';
import {
  createLogger,
  getPerformanceLogger,
  PerformanceLogger
} from '../logger';
import { AsyncMutex } from '../async/async-mutex';
import { withTimeout } from '../async/async-utils';
import { getRedisClient, RedisClient } from '../redis';
import {
  getRedisStreamsClient,
  RedisStreamsClient,
  StreamBatcher
} from '../redis-streams';
import { PriceUpdate, ArbitrageOpportunity, MessageEvent } from '../../../types';
import { basisPointsToDecimal, meetsThreshold } from '../components/price-calculator';

// =============================================================================
// Constants
// =============================================================================

/**
 * Default gas estimate for Solana DEX swaps.
 * Solana uses compute units (CU) instead of gas. Typical DEX swap: 200,000-400,000 CU.
 * With priority fee of ~0.0001 SOL per CU, estimated cost is ~0.02-0.04 SOL.
 */
const SOLANA_DEFAULT_GAS_ESTIMATE = '300000';

// =============================================================================
// Type Definitions
// =============================================================================

/**
 * Logger interface for SolanaDetector.
 * Allows injecting mock loggers for testing.
 */
export interface SolanaDetectorLogger {
  info: (message: string, meta?: object) => void;
  warn: (message: string, meta?: object) => void;
  error: (message: string, meta?: object) => void;
  debug: (message: string, meta?: object) => void;
}

/**
 * Performance logger interface for SolanaDetector.
 * Minimal interface for testing dependency injection.
 */
export interface SolanaDetectorPerfLogger {
  logHealthCheck: (service: string, status: any) => void;
  logEventLatency?: (operation: string, latency: number, metadata?: any) => void;
  logArbitrageOpportunity?: (opportunity: any) => void;
}

/**
 * Redis client interface for dependency injection.
 * Matches the subset of RedisClient methods used by SolanaDetector.
 */
export interface SolanaDetectorRedisClient {
  ping(): Promise<string>;
  disconnect(): Promise<void>;
  updateServiceHealth?(serviceName: string, status: any): Promise<void>;
}

/**
 * Redis streams client interface for dependency injection.
 * Matches the subset of RedisStreamsClient methods used by SolanaDetector.
 */
export interface SolanaDetectorStreamsClient {
  disconnect(): Promise<void>;
  createBatcher(streamName: string, config: any): {
    add(message: any): void;
    destroy(): Promise<void>;
    getStats(): { currentQueueSize: number; batchesSent: number };
  };
}

/**
 * Dependencies that can be injected into SolanaDetector.
 * Enables proper testing without Jest mock hoisting issues.
 */
export interface SolanaDetectorDeps {
  logger?: SolanaDetectorLogger;
  perfLogger?: SolanaDetectorPerfLogger | PerformanceLogger;
  /** Optional Redis client for dependency injection (used in tests) */
  redisClient?: SolanaDetectorRedisClient;
  /** Optional Redis streams client for dependency injection (used in tests) */
  streamsClient?: SolanaDetectorStreamsClient;
}

/**
 * Configuration for SolanaDetector.
 */
export interface SolanaDetectorConfig {
  /** Solana RPC endpoint URL */
  rpcUrl: string;

  /** Solana WebSocket endpoint URL (optional, derived from rpcUrl if not provided) */
  wsUrl?: string;

  /** Commitment level for transactions (default: 'confirmed') */
  commitment?: Commitment;

  /** Fallback RPC URLs for resilience */
  rpcFallbackUrls?: string[];

  /** Fallback WebSocket URLs for resilience */
  wsFallbackUrls?: string[];

  /** Health check interval in milliseconds (default: 30000) */
  healthCheckIntervalMs?: number;

  /** Number of connections in the pool (default: 3) */
  connectionPoolSize?: number;

  /** Maximum retry attempts for failed operations (default: 3) */
  maxRetries?: number;

  /** Delay between retries in milliseconds (default: 1000) */
  retryDelayMs?: number;

  /**
   * Minimum profit threshold for arbitrage in percent form (default: 0.3 = 0.3%).
   * Note: EVM detectors use decimal form (0.003 = 0.3%). This is converted internally
   * for consistency: thresholdDecimal = minProfitThreshold / 100.
   */
  minProfitThreshold?: number;
}

/**
 * Connection pool configuration.
 */
export interface ConnectionPoolConfig {
  size: number;
  connections: Connection[];
  currentIndex: number;
  healthStatus: boolean[];
  latencies: number[];
  failedRequests: number[];
  /** Track which connection index each subscription was created on */
  subscriptionConnections: Map<string, number>;
  /** Mutex flags for reconnection attempts (prevents concurrent reconnects) */
  reconnecting: boolean[];
  /** Track reconnection attempts for exponential backoff */
  reconnectAttempts: number[];
}

/**
 * Program subscription tracking.
 */
export interface ProgramSubscription {
  programId: string;
  subscriptionId: number;
  callback?: (accountInfo: AccountInfo<Buffer>, context: Context, accountId: string) => void;
}

/**
 * Solana token information in a pool.
 */
export interface SolanaTokenInfo {
  mint: string;
  symbol: string;
  decimals: number;
}

/**
 * Solana DEX pool information.
 */
export interface SolanaPool {
  address: string;
  programId: string;
  dex: string;
  token0: SolanaTokenInfo;
  token1: SolanaTokenInfo;
  fee: number; // In basis points (e.g., 25 = 0.25%)
  reserve0?: string;
  reserve1?: string;
  price?: number;
  lastSlot?: number;
  sqrtPriceX64?: string; // For concentrated liquidity pools
  liquidity?: string;
  tickCurrentIndex?: number;
}

/**
 * Solana-specific price update.
 */
export interface SolanaPriceUpdate {
  poolAddress: string;
  dex: string;
  token0: string;
  token1: string;
  price: number;
  reserve0: string;
  reserve1: string;
  slot: number;
  timestamp: number;
  // Concentrated liquidity fields (optional)
  sqrtPriceX64?: string;
  liquidity?: string;
  tickCurrentIndex?: number;
}

/**
 * Connection metrics for monitoring.
 */
export interface ConnectionMetrics {
  totalConnections: number;
  healthyConnections: number;
  failedRequests: number;
  avgLatencyMs: number;
}

/**
 * Health status for the detector.
 */
export interface SolanaDetectorHealth {
  service: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  memoryUsage: number;
  lastHeartbeat: number;
  connections: ConnectionMetrics;
  subscriptions: number;
  pools: number;
  slot: number;
}

// =============================================================================
// Known Solana DEX Program IDs
// =============================================================================

export const SOLANA_DEX_PROGRAMS = {
  // Jupiter Aggregator
  JUPITER: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',

  // Raydium AMM
  RAYDIUM_AMM: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',

  // Raydium CLMM (Concentrated Liquidity)
  RAYDIUM_CLMM: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',

  // Orca Whirlpools
  ORCA_WHIRLPOOL: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',

  // Meteora DLMM
  METEORA_DLMM: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',

  // Phoenix (Order Book)
  PHOENIX: 'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY',

  // Lifinity
  LIFINITY: '2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c'
} as const;

// =============================================================================
// SolanaDetector Class
// =============================================================================

/**
 * Base class for Solana blockchain detection.
 * Provides connection pooling, program subscriptions, and arbitrage detection.
 */
export class SolanaDetector extends EventEmitter {
  // Configuration
  protected config: Required<SolanaDetectorConfig>;
  protected logger: SolanaDetectorLogger;
  protected perfLogger: SolanaDetectorPerfLogger;

  // Connection management
  protected connectionPool: ConnectionPoolConfig;
  protected currentRpcUrl: string;
  protected allRpcUrls: string[];

  // Redis clients
  protected redis: RedisClient | null = null;
  protected streamsClient: RedisStreamsClient | null = null;
  protected priceUpdateBatcher: StreamBatcher<MessageEvent> | null = null;

  // Injected dependencies (for DI pattern in tests)
  protected injectedRedisClient?: SolanaDetectorRedisClient;
  protected injectedStreamsClient?: SolanaDetectorStreamsClient;

  // Subscription tracking
  protected subscriptions: Map<string, ProgramSubscription> = new Map();

  // Pool management
  protected pools: Map<string, SolanaPool> = new Map();
  protected poolsByDex: Map<string, Set<string>> = new Map();
  protected poolsByTokenPair: Map<string, Set<string>> = new Map();

  // State tracking
  protected running = false;
  protected stopping = false;
  protected startTime = 0;
  protected currentSlot = 0;
  protected healthCheckInterval: NodeJS.Timeout | null = null;

  // Lifecycle protection (prevents concurrent start/stop operations)
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;

  // Latency tracking for health metrics
  protected recentLatencies: number[] = [];
  protected static readonly MAX_LATENCY_SAMPLES = 100;
  protected static readonly MAX_LATENCY_VALUE_MS = 30000; // Cap extreme values
  // S3.3.5 FIX: Timeout for slot updates to prevent indefinite hangs
  protected static readonly SLOT_UPDATE_TIMEOUT_MS = 10000; // 10 seconds

  // RACE CONDITION FIX: Mutex to prevent concurrent updateCurrentSlot execution
  private slotUpdateMutex = new AsyncMutex();

  // RACE CONDITION FIX: Mutex for atomic pool updates across multiple maps
  // Ensures pools, poolsByDex, and poolsByTokenPair stay consistent
  private poolUpdateMutex = new AsyncMutex();

  constructor(config: SolanaDetectorConfig, deps?: SolanaDetectorDeps) {
    super();

    // Validate required config
    if (!config.rpcUrl || config.rpcUrl.trim() === '') {
      throw new Error('RPC URL is required for SolanaDetector');
    }

    // Set defaults
    this.config = {
      rpcUrl: config.rpcUrl,
      wsUrl: config.wsUrl || this.deriveWsUrl(config.rpcUrl),
      commitment: config.commitment || 'confirmed',
      rpcFallbackUrls: config.rpcFallbackUrls || [],
      wsFallbackUrls: config.wsFallbackUrls || [],
      healthCheckIntervalMs: config.healthCheckIntervalMs || 30000,
      connectionPoolSize: config.connectionPoolSize || 3,
      maxRetries: config.maxRetries || 3,
      retryDelayMs: config.retryDelayMs || 1000,
      minProfitThreshold: config.minProfitThreshold || 0.3
    };

    // Set up logging
    this.logger = deps?.logger || createLogger('solana-detector');
    this.perfLogger = deps?.perfLogger || getPerformanceLogger('solana-detector');

    // Store injected Redis clients for DI pattern (used in tests)
    this.injectedRedisClient = deps?.redisClient;
    this.injectedStreamsClient = deps?.streamsClient;

    // Initialize RPC URLs list
    this.currentRpcUrl = this.config.rpcUrl;
    this.allRpcUrls = [this.config.rpcUrl, ...this.config.rpcFallbackUrls];

    // Initialize connection pool structure (connections created on start)
    this.connectionPool = {
      size: this.config.connectionPoolSize,
      connections: [],
      currentIndex: 0,
      healthStatus: [],
      latencies: [],
      failedRequests: [],
      subscriptionConnections: new Map(),
      reconnecting: [],
      reconnectAttempts: []
    };

    this.logger.info('SolanaDetector initialized', {
      rpcUrl: this.config.rpcUrl,
      wsUrl: this.config.wsUrl,
      commitment: this.config.commitment,
      poolSize: this.config.connectionPoolSize,
      fallbackUrls: this.config.rpcFallbackUrls.length
    });
  }

  // ===========================================================================
  // Configuration Getters
  // ===========================================================================

  getChain(): string {
    return 'solana';
  }

  isEVM(): boolean {
    return false;
  }

  getRpcUrl(): string {
    return this.config.rpcUrl;
  }

  getWsUrl(): string {
    return this.config.wsUrl;
  }

  getCommitment(): Commitment {
    return this.config.commitment;
  }

  getFallbackUrls(): { rpc: string[]; ws: string[] } {
    return {
      rpc: this.config.rpcFallbackUrls,
      ws: this.config.wsFallbackUrls
    };
  }

  getCurrentRpcUrl(): string {
    return this.currentRpcUrl;
  }

  // ===========================================================================
  // Lifecycle Methods (with race-condition protection)
  // ===========================================================================

  async start(): Promise<void> {
    // Return existing promise if start in progress (prevents race conditions)
    if (this.startPromise) {
      return this.startPromise;
    }

    // Wait for pending stop
    if (this.stopPromise) {
      await this.stopPromise;
    }

    // Guard against starting while stopping
    if (this.stopping) {
      this.logger.warn('Cannot start: SolanaDetector is stopping');
      return;
    }

    // Guard against double start
    if (this.running) {
      this.logger.warn('SolanaDetector already running');
      return;
    }

    this.startPromise = this.performStart();

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async performStart(): Promise<void> {
    this.logger.info('Starting SolanaDetector', {
      rpcUrl: this.currentRpcUrl,
      commitment: this.config.commitment
    });

    try {
      // Initialize Redis
      await this.initializeRedis();

      // Initialize connection pool
      await this.initializeConnectionPool();

      // Get initial slot
      await this.updateCurrentSlot();

      // Start health monitoring
      this.startHealthMonitoring();

      this.running = true;
      this.startTime = Date.now();

      this.emit('started', { chain: 'solana' });

      this.logger.info('SolanaDetector started successfully', {
        slot: this.currentSlot,
        connections: this.connectionPool.connections.length
      });

    } catch (error) {
      this.logger.error('Failed to start SolanaDetector', { error });
      await this.cleanup();
      throw error;
    }
  }

  async stop(): Promise<void> {
    // Return existing promise if stop in progress
    if (this.stopPromise) {
      return this.stopPromise;
    }

    // Guard against stop when not running
    if (!this.running && !this.stopping) {
      this.logger.debug('SolanaDetector not running');
      return;
    }

    this.stopPromise = this.performStop();

    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  private async performStop(): Promise<void> {
    this.logger.info('Stopping SolanaDetector');

    this.stopping = true;
    this.running = false;

    await this.cleanup();

    this.stopping = false;

    this.emit('stopped', { chain: 'solana' });
    this.logger.info('SolanaDetector stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  private async cleanup(): Promise<void> {
    // Stop health monitoring
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    // Unsubscribe from all programs
    for (const [programId] of this.subscriptions) {
      try {
        await this.unsubscribeFromProgram(programId);
      } catch (error) {
        this.logger.warn(`Error unsubscribing from ${programId}`, { error });
      }
    }
    this.subscriptions.clear();

    // Clean up batcher
    if (this.priceUpdateBatcher) {
      try {
        await this.priceUpdateBatcher.destroy();
      } catch (error) {
        this.logger.warn('Error destroying price update batcher', { error });
      }
      this.priceUpdateBatcher = null;
    }

    // Disconnect Redis
    if (this.streamsClient) {
      try {
        await this.streamsClient.disconnect();
      } catch (error) {
        this.logger.warn('Error disconnecting streams client', { error });
      }
      this.streamsClient = null;
    }

    if (this.redis) {
      try {
        await this.redis.disconnect();
      } catch (error) {
        this.logger.warn('Error disconnecting redis', { error });
      }
      this.redis = null;
    }

    // Clear connection pool
    this.connectionPool.connections = [];
    this.connectionPool.healthStatus = [];
    this.connectionPool.reconnecting = [];
    this.connectionPool.reconnectAttempts = [];
    this.connectionPool.subscriptionConnections.clear();

    // Clear pools
    this.pools.clear();
    this.poolsByDex.clear();
    this.poolsByTokenPair.clear();

    // Clear latency tracking
    this.recentLatencies = [];
  }

  // ===========================================================================
  // Redis Initialization
  // ===========================================================================

  private async initializeRedis(): Promise<void> {
    // Use injected clients if available (DI pattern for tests), otherwise use singletons
    if (this.injectedRedisClient) {
      this.redis = this.injectedRedisClient as any;
    } else {
      this.redis = await getRedisClient();
    }

    if (this.injectedStreamsClient) {
      this.streamsClient = this.injectedStreamsClient as any;
    } else {
      this.streamsClient = await getRedisStreamsClient();
    }

    // Create price update batcher
    this.priceUpdateBatcher = this.streamsClient!.createBatcher(
      RedisStreamsClient.STREAMS.PRICE_UPDATES,
      {
        maxBatchSize: 50,
        maxWaitMs: 100
      }
    );

    this.logger.debug('Redis clients initialized');
  }

  // ===========================================================================
  // Connection Pool Management
  // ===========================================================================

  private async initializeConnectionPool(): Promise<void> {
    const { size, commitment } = { size: this.config.connectionPoolSize, commitment: this.config.commitment };

    this.connectionPool = {
      size,
      connections: [],
      currentIndex: 0,
      healthStatus: [],
      latencies: [],
      failedRequests: [],
      subscriptionConnections: new Map(),
      reconnecting: [],
      reconnectAttempts: []
    };

    // Create connections - distribute across available URLs
    for (let i = 0; i < size; i++) {
      const urlIndex = i % this.allRpcUrls.length;
      const rpcUrl = this.allRpcUrls[urlIndex];

      const connection = new Connection(rpcUrl, {
        commitment,
        wsEndpoint: this.config.wsUrl
      });

      this.connectionPool.connections.push(connection);
      this.connectionPool.healthStatus.push(true);
      this.connectionPool.latencies.push(0);
      this.connectionPool.failedRequests.push(0);
      this.connectionPool.reconnecting.push(false);
      this.connectionPool.reconnectAttempts.push(0);
    }

    // Validate at least one connection works
    const slot = await this.connectionPool.connections[0].getSlot();
    this.currentSlot = slot;

    this.logger.info('Connection pool initialized', {
      size,
      initialSlot: slot
    });
  }

  getConnectionPoolSize(): number {
    return this.connectionPool.size;
  }

  getActiveConnections(): number {
    return this.connectionPool.connections.length;
  }

  getHealthyConnectionCount(): number {
    return this.connectionPool.healthStatus.filter(h => h).length;
  }

  /**
   * Get a connection from the pool using round-robin.
   * Prefers healthy connections when available.
   * Returns the connection and the actual index used.
   */
  getConnection(): Connection {
    const { connection } = this.getConnectionWithIndex();
    return connection;
  }

  /**
   * Get a connection from the pool along with its index.
   * This is critical for subscription tracking - subscriptions must be
   * unsubscribed from the same connection that created them.
   * @internal
   */
  protected getConnectionWithIndex(): { connection: Connection; index: number } {
    // Safety check for empty pool
    if (this.connectionPool.connections.length === 0) {
      throw new Error('Connection pool is empty - detector may not be started');
    }

    // Try to find a healthy connection starting from current index
    const startIndex = this.connectionPool.currentIndex;
    let attempts = 0;

    while (attempts < this.connectionPool.size) {
      const index = (startIndex + attempts) % this.connectionPool.size;
      if (this.connectionPool.healthStatus[index]) {
        this.connectionPool.currentIndex = (index + 1) % this.connectionPool.size;
        return { connection: this.connectionPool.connections[index], index };
      }
      attempts++;
    }

    // Fallback to round-robin if no healthy connections
    const index = this.connectionPool.currentIndex;
    const conn = this.connectionPool.connections[index];
    this.connectionPool.currentIndex = (index + 1) % this.connectionPool.size;
    return { connection: conn, index };
  }

  /**
   * Get a connection by index (for subscription tracking).
   * @internal
   */
  private getConnectionByIndex(index: number): Connection {
    if (index < 0 || index >= this.connectionPool.connections.length) {
      throw new Error(`Invalid connection index: ${index}`);
    }
    return this.connectionPool.connections[index];
  }

  /**
   * Get the current connection index (for subscription tracking).
   * @internal
   */
  private getCurrentConnectionIndex(): number {
    return this.connectionPool.currentIndex;
  }

  /**
   * Mark a connection as failed.
   */
  async markConnectionFailed(index: number): Promise<void> {
    if (index >= 0 && index < this.connectionPool.size) {
      this.connectionPool.healthStatus[index] = false;
      this.connectionPool.failedRequests[index]++;

      this.logger.warn('Connection marked as failed', {
        index,
        failedRequests: this.connectionPool.failedRequests[index]
      });

      // Schedule reconnection attempt
      setTimeout(() => this.attemptReconnection(index), this.config.retryDelayMs);
    }
  }

  private async attemptReconnection(index: number): Promise<void> {
    if (this.stopping || !this.running) return;

    // Mutex: prevent concurrent reconnection attempts for same index
    if (this.connectionPool.reconnecting[index]) {
      this.logger.debug('Reconnection already in progress', { index });
      return;
    }

    this.connectionPool.reconnecting[index] = true;

    try {
      // Create new connection
      const urlIndex = index % this.allRpcUrls.length;
      const rpcUrl = this.allRpcUrls[urlIndex];

      const connection = new Connection(rpcUrl, {
        commitment: this.config.commitment,
        wsEndpoint: this.config.wsUrl
      });

      // Test the connection
      await connection.getSlot();

      // Replace the failed connection
      this.connectionPool.connections[index] = connection;
      this.connectionPool.healthStatus[index] = true;
      // BUG FIX: Reset attempt counter on successful reconnection
      this.connectionPool.reconnectAttempts[index] = 0;

      this.logger.info('Connection reconnected successfully', { index });
    } catch (error) {
      // BUG FIX: Proper exponential backoff with attempt tracking
      const attempts = this.connectionPool.reconnectAttempts[index]++;
      // Cap at 5 attempts to prevent extremely long delays (max ~32x base delay)
      const cappedAttempts = Math.min(attempts, 5);
      const backoffDelay = this.config.retryDelayMs * Math.pow(2, cappedAttempts);

      this.logger.warn('Reconnection attempt failed', {
        index,
        attempt: attempts + 1,
        nextDelayMs: backoffDelay,
        error
      });
      setTimeout(() => this.attemptReconnection(index), backoffDelay);
    } finally {
      this.connectionPool.reconnecting[index] = false;
    }
  }

  getConnectionMetrics(): ConnectionMetrics {
    const healthyCount = this.connectionPool.healthStatus.filter(h => h).length;
    const totalFailed = this.connectionPool.failedRequests.reduce((a, b) => a + b, 0);
    const avgLatency = this.recentLatencies.length > 0
      ? this.recentLatencies.reduce((a, b) => a + b, 0) / this.recentLatencies.length
      : 0;

    return {
      totalConnections: this.connectionPool.size,
      healthyConnections: healthyCount,
      failedRequests: totalFailed,
      avgLatencyMs: avgLatency
    };
  }

  // ===========================================================================
  // Program Account Subscriptions
  // ===========================================================================

  async subscribeToProgramAccounts(programId: string): Promise<void> {
    // Validate program ID
    if (!this.isValidSolanaAddress(programId)) {
      this.logger.error('Invalid program ID', { programId });
      throw new Error(`Invalid program ID: ${programId}`);
    }

    if (this.subscriptions.has(programId)) {
      this.logger.debug('Already subscribed to program', { programId });
      return;
    }

    // BUG FIX: Get connection AND its actual index atomically
    // Previously captured index BEFORE getConnection(), which could return
    // a different connection if some were unhealthy
    const { connection, index: connectionIndex } = this.getConnectionWithIndex();
    const pubkey = new PublicKey(programId);

    const subscriptionId = connection.onProgramAccountChange(
      pubkey,
      (accountInfo: { accountId: PublicKey; accountInfo: AccountInfo<Buffer> }, context: Context) => {
        this.handleProgramAccountUpdate(programId, accountInfo, context);
      },
      this.config.commitment
    );

    this.subscriptions.set(programId, {
      programId,
      subscriptionId
    });

    // Track which connection this subscription was created on
    this.connectionPool.subscriptionConnections.set(programId, connectionIndex);

    this.logger.info('Subscribed to program accounts', {
      programId,
      subscriptionId,
      connectionIndex
    });
  }

  async unsubscribeFromProgram(programId: string): Promise<void> {
    const subscription = this.subscriptions.get(programId);
    if (!subscription) {
      this.logger.debug('Not subscribed to program', { programId });
      return;
    }

    // Use the same connection that was used to create the subscription
    // This is critical - subscription IDs are tied to specific connections
    const connectionIndex = this.connectionPool.subscriptionConnections.get(programId);
    let connection: Connection;

    if (connectionIndex !== undefined && connectionIndex < this.connectionPool.connections.length) {
      connection = this.connectionPool.connections[connectionIndex];
    } else {
      // Fallback if connection index is invalid (shouldn't happen normally)
      this.logger.warn('Subscription connection index not found, using current connection', { programId });
      connection = this.getConnection();
    }

    try {
      await connection.removeProgramAccountChangeListener(subscription.subscriptionId);
    } catch (error) {
      // Log but don't throw - we still want to clean up our tracking
      this.logger.warn('Error removing subscription listener', { programId, error });
    }

    this.subscriptions.delete(programId);
    this.connectionPool.subscriptionConnections.delete(programId);

    this.logger.info('Unsubscribed from program', { programId });
  }

  isSubscribedToProgram(programId: string): boolean {
    return this.subscriptions.has(programId);
  }

  getSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  private handleProgramAccountUpdate(
    programId: string,
    accountInfo: { accountId: PublicKey; accountInfo: AccountInfo<Buffer> },
    context: Context
  ): void {
    if (this.stopping || !this.running) return;

    this.emit('accountUpdate', {
      programId,
      accountId: accountInfo.accountId.toBase58(),
      data: accountInfo.accountInfo.data,
      slot: context.slot
    });

    // Update current slot
    if (context.slot > this.currentSlot) {
      this.currentSlot = context.slot;
    }
  }

  /**
   * Simulate an account update (for testing).
   */
  simulateAccountUpdate(programId: string, data: any): void {
    this.emit('accountUpdate', {
      programId,
      accountId: data.accountId,
      data: data.accountInfo?.data,
      slot: this.currentSlot + 1
    });
  }

  // ===========================================================================
  // Pool Management
  // ===========================================================================

  addPool(pool: SolanaPool): void {
    this.pools.set(pool.address, pool);

    // Index by DEX
    if (!this.poolsByDex.has(pool.dex)) {
      this.poolsByDex.set(pool.dex, new Set());
    }
    this.poolsByDex.get(pool.dex)!.add(pool.address);

    // Index by token pair (normalized)
    const pairKey = this.getTokenPairKey(pool.token0.mint, pool.token1.mint);
    if (!this.poolsByTokenPair.has(pairKey)) {
      this.poolsByTokenPair.set(pairKey, new Set());
    }
    this.poolsByTokenPair.get(pairKey)!.add(pool.address);

    this.logger.debug('Pool added', {
      address: pool.address,
      dex: pool.dex,
      pair: `${pool.token0.symbol}/${pool.token1.symbol}`
    });
  }

  removePool(address: string): void {
    const pool = this.pools.get(address);
    if (!pool) return;

    // Remove from DEX index and clean up empty Set
    const dexSet = this.poolsByDex.get(pool.dex);
    if (dexSet) {
      dexSet.delete(address);
      if (dexSet.size === 0) {
        this.poolsByDex.delete(pool.dex);
      }
    }

    // Remove from token pair index and clean up empty Set
    const pairKey = this.getTokenPairKey(pool.token0.mint, pool.token1.mint);
    const pairSet = this.poolsByTokenPair.get(pairKey);
    if (pairSet) {
      pairSet.delete(address);
      if (pairSet.size === 0) {
        this.poolsByTokenPair.delete(pairKey);
      }
    }

    // Remove from main map
    this.pools.delete(address);

    this.logger.debug('Pool removed', { address });
  }

  getPool(address: string): SolanaPool | undefined {
    return this.pools.get(address);
  }

  getPoolCount(): number {
    return this.pools.size;
  }

  getPoolsByDex(dex: string): SolanaPool[] {
    const addresses = this.poolsByDex.get(dex);
    if (!addresses) return [];

    return Array.from(addresses)
      .map(addr => this.pools.get(addr))
      .filter((p): p is SolanaPool => p !== undefined);
  }

  getPoolsByTokenPair(token0: string, token1: string): SolanaPool[] {
    const pairKey = this.getTokenPairKey(token0, token1);
    const addresses = this.poolsByTokenPair.get(pairKey);
    if (!addresses) return [];

    return Array.from(addresses)
      .map(addr => this.pools.get(addr))
      .filter((p): p is SolanaPool => p !== undefined);
  }

  async updatePoolPrice(
    poolAddress: string,
    update: { price: number; reserve0: string; reserve1: string; slot: number }
  ): Promise<void> {
    const pool = this.pools.get(poolAddress);
    if (!pool) {
      this.logger.warn('Pool not found for price update', { poolAddress });
      return;
    }

    pool.price = update.price;
    pool.reserve0 = update.reserve0;
    pool.reserve1 = update.reserve1;
    pool.lastSlot = update.slot;
  }

  private getTokenPairKey(token0: string, token1: string): string {
    // Normalize by sorting alphabetically
    const sorted = [token0.toLowerCase(), token1.toLowerCase()].sort();
    return `${sorted[0]}_${sorted[1]}`;
  }

  // ===========================================================================
  // Price Update Publishing
  // ===========================================================================

  async publishPriceUpdate(update: SolanaPriceUpdate): Promise<void> {
    if (!this.priceUpdateBatcher) {
      throw new Error('Price update batcher not initialized');
    }

    const standardUpdate = this.toStandardPriceUpdate(update);

    const message: MessageEvent = {
      type: 'price-update',
      data: standardUpdate,
      timestamp: Date.now(),
      source: 'solana-detector'
    };

    this.priceUpdateBatcher.add(message);
  }

  /**
   * Convert Solana-specific price update to standard format.
   */
  toStandardPriceUpdate(update: SolanaPriceUpdate): PriceUpdate {
    return {
      pairKey: `${update.dex}_${update.token0}_${update.token1}`,
      pairAddress: update.poolAddress,
      dex: update.dex,
      chain: 'solana',
      token0: update.token0,
      token1: update.token1,
      price: update.price,
      reserve0: update.reserve0,
      reserve1: update.reserve1,
      blockNumber: update.slot, // Slot maps to blockNumber
      timestamp: update.timestamp,
      latency: 0
    };
  }

  getPendingUpdates(): number {
    if (!this.priceUpdateBatcher) {
      // INCONSISTENCY FIX: Log warning for observability (matches publishPriceUpdate behavior)
      this.logger.debug('getPendingUpdates called with no batcher initialized');
      return 0;
    }
    return this.priceUpdateBatcher.getStats().currentQueueSize || 0;
  }

  getBatcherStats(): { pending: number; flushed: number } {
    if (!this.priceUpdateBatcher) {
      // INCONSISTENCY FIX: Log warning for observability (matches publishPriceUpdate behavior)
      this.logger.debug('getBatcherStats called with no batcher initialized');
      return { pending: 0, flushed: 0 };
    }
    const stats = this.priceUpdateBatcher.getStats();
    return {
      pending: stats.currentQueueSize || 0,
      flushed: stats.batchesSent || 0
    };
  }

  // ===========================================================================
  // Arbitrage Detection
  // ===========================================================================

  async checkArbitrage(): Promise<ArbitrageOpportunity[]> {
    const opportunities: ArbitrageOpportunity[] = [];

    // RACE CONDITION FIX: Snapshot the pools map and token pairs at the start
    // This prevents inconsistent reads if addPool/removePool is called during iteration
    const poolsSnapshot = new Map(this.pools);
    const pairKeysSnapshot = Array.from(this.poolsByTokenPair.entries());

    // Get all unique token pairs
    for (const [pairKey, poolAddresses] of pairKeysSnapshot) {
      if (poolAddresses.size < 2) continue; // Need at least 2 pools for arbitrage

      // Use snapshot for pool lookup
      const pools = Array.from(poolAddresses)
        .map(addr => poolsSnapshot.get(addr))
        .filter((p): p is SolanaPool => p !== undefined && p.price !== undefined);

      if (pools.length < 2) continue;

      // Compare all pool pairs
      for (let i = 0; i < pools.length; i++) {
        for (let j = i + 1; j < pools.length; j++) {
          const pool1 = pools[i];
          const pool2 = pools[j];

          const opportunity = this.calculateArbitrageOpportunity(pool1, pool2);
          if (opportunity) {
            opportunities.push(opportunity);
          }
        }
      }
    }

    return opportunities;
  }

  private calculateArbitrageOpportunity(
    pool1: SolanaPool,
    pool2: SolanaPool
  ): ArbitrageOpportunity | null {
    if (!pool1.price || !pool2.price) return null;

    // Calculate price difference
    const minPrice = Math.min(pool1.price, pool2.price);
    const maxPrice = Math.max(pool1.price, pool2.price);
    const grossDiff = (maxPrice - minPrice) / minPrice;

    // ARCH-REFACTOR: Use centralized basisPointsToDecimal for fee conversion
    const fee1 = basisPointsToDecimal(pool1.fee);
    const fee2 = basisPointsToDecimal(pool2.fee);
    const totalFees = fee1 + fee2;

    // Net profit after fees
    const netProfit = grossDiff - totalFees;

    // Check against threshold
    // ARCH-REFACTOR: Standardize on decimal format for consistency with EVM detectors
    // Config minProfitThreshold is in percent (e.g., 0.3 = 0.3%), convert to decimal for comparison
    const thresholdDecimal = this.config.minProfitThreshold / 100;

    // ARCH-REFACTOR: Use centralized meetsThreshold for consistent comparison
    if (!meetsThreshold(netProfit, thresholdDecimal)) {
      return null;
    }

    // Determine buy/sell direction
    const buyPool = pool1.price < pool2.price ? pool1 : pool2;
    const sellPool = pool1.price < pool2.price ? pool2 : pool1;

    // Generate unique ID with random suffix to prevent collisions
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).slice(2, 11);

    return {
      id: `solana-${buyPool.address}-${sellPool.address}-${timestamp}-${randomSuffix}`,
      type: 'intra-dex',
      chain: 'solana',
      buyDex: buyPool.dex,
      sellDex: sellPool.dex,
      buyPair: buyPool.address,
      sellPair: sellPool.address,
      token0: buyPool.token0.mint,
      token1: buyPool.token1.mint,
      buyPrice: buyPool.price,
      sellPrice: sellPool.price,
      profitPercentage: netProfit * 100,
      expectedProfit: netProfit,
      confidence: 0.85, // Solana has fast finality
      timestamp,
      expiresAt: timestamp + 1000, // 1 second expiry (Solana is fast)
      gasEstimate: SOLANA_DEFAULT_GAS_ESTIMATE,
      status: 'pending'
    };
  }

  // ===========================================================================
  // Health Monitoring
  // ===========================================================================

  async getHealth(): Promise<SolanaDetectorHealth> {
    const metrics = this.getConnectionMetrics();

    // Determine health status with degraded support
    let status: 'healthy' | 'degraded' | 'unhealthy';
    if (!this.running) {
      status = 'unhealthy';
    } else if (metrics.healthyConnections === 0) {
      status = 'unhealthy';
    } else if (metrics.healthyConnections < metrics.totalConnections) {
      // Some but not all connections healthy = degraded
      status = 'degraded';
    } else {
      status = 'healthy';
    }

    return {
      service: 'solana-detector',
      status,
      uptime: this.startTime > 0 ? (Date.now() - this.startTime) / 1000 : 0,
      memoryUsage: process.memoryUsage().heapUsed,
      lastHeartbeat: Date.now(),
      connections: metrics,
      subscriptions: this.subscriptions.size,
      pools: this.pools.size,
      slot: this.currentSlot
    };
  }

  private startHealthMonitoring(): void {
    this.healthCheckInterval = setInterval(async () => {
      if (!this.running || this.stopping) {
        if (this.healthCheckInterval) {
          clearInterval(this.healthCheckInterval);
          this.healthCheckInterval = null;
        }
        return;
      }

      try {
        // Update current slot
        await this.updateCurrentSlot();

        // Get and log health
        const health = await this.getHealth();
        this.perfLogger.logHealthCheck('solana-detector', health);

        // Update Redis
        if (this.redis) {
          await this.redis.updateServiceHealth('solana-detector', {
            name: 'solana-detector',
            status: health.status,
            uptime: health.uptime,
            memoryUsage: health.memoryUsage,
            cpuUsage: 0,
            lastHeartbeat: health.lastHeartbeat,
            latency: health.connections.avgLatencyMs
          });
        }

      } catch (error) {
        if (!this.stopping) {
          this.logger.error('Health monitoring failed', { error });
        }
      }
    }, this.config.healthCheckIntervalMs);
  }

  private async updateCurrentSlot(): Promise<void> {
    // RACE CONDITION FIX: Use mutex to prevent concurrent execution
    // Health check intervals may queue multiple executions if getSlot() is slow
    const release = await this.slotUpdateMutex.acquire();
    try {
      const startTime = Date.now();
      const connection = this.getConnection();
      // S3.3.5 FIX: Add timeout to prevent indefinite hangs on slow RPC nodes
      this.currentSlot = await withTimeout(
        connection.getSlot(),
        SolanaDetector.SLOT_UPDATE_TIMEOUT_MS,
        'getSlot'
      );
      let latency = Date.now() - startTime;

      // Cap extreme latency values to avoid skewing metrics
      if (latency > SolanaDetector.MAX_LATENCY_VALUE_MS) {
        this.logger.warn('Extreme latency detected, capping value', {
          actual: latency,
          capped: SolanaDetector.MAX_LATENCY_VALUE_MS
        });
        latency = SolanaDetector.MAX_LATENCY_VALUE_MS;
      }

      // Track latency (ring buffer) - now race-safe under mutex
      this.recentLatencies.push(latency);
      if (this.recentLatencies.length > SolanaDetector.MAX_LATENCY_SAMPLES) {
        this.recentLatencies.shift();
      }
    } catch (error) {
      this.logger.warn('Failed to update current slot', { error });
    } finally {
      release();
    }
  }

  // ===========================================================================
  // Error Handling
  // ===========================================================================

  async handleRpcError(error: Error): Promise<void> {
    const errorCode = (error as any).code;

    if (errorCode === 429) {
      this.logger.warn('RPC rate limit hit', { error: error.message });
      // Could implement exponential backoff here
    } else {
      this.logger.error('RPC error', { error: error.message, code: errorCode });
    }
  }

  async handleRpcFailure(failedUrl: string): Promise<void> {
    this.logger.warn('RPC endpoint failed', { url: failedUrl });

    // Find next available URL
    const currentIndex = this.allRpcUrls.indexOf(this.currentRpcUrl);
    const nextIndex = (currentIndex + 1) % this.allRpcUrls.length;

    if (nextIndex !== currentIndex) {
      this.currentRpcUrl = this.allRpcUrls[nextIndex];
      this.logger.info('Switched to fallback RPC', { url: this.currentRpcUrl });
    }
  }

  async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;

        if (attempt < this.config.maxRetries) {
          const delay = this.config.retryDelayMs * attempt;
          await this.sleep(delay);
        }
      }
    }

    this.logger.error('Operation failed after retries', {
      maxRetries: this.config.maxRetries,
      error: lastError?.message
    });

    throw lastError;
  }

  emitError(error: Error): void {
    this.emit('error', error);
  }

  // ===========================================================================
  // Utility Methods
  // ===========================================================================

  private deriveWsUrl(rpcUrl: string): string {
    // Convert http(s) to ws(s)
    return rpcUrl.replace(/^http/, 'ws');
  }

  private isValidSolanaAddress(address: string): boolean {
    try {
      new PublicKey(address);
      return true;
    } catch {
      return false;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default SolanaDetector;
