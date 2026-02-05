/**
 * PartitionedDetector Base Class
 *
 * Base class for partition-specific detectors that manage multiple chains.
 * Implements ADR-003 (Partitioned Chain Detectors) for efficient multi-chain
 * monitoring within free-tier resource limits.
 *
 * Features:
 * - Multi-chain WebSocket connection management
 * - Aggregated health reporting across chains
 * - Cross-chain price tracking for arbitrage detection
 * - Graceful degradation when individual chains fail
 * - Dynamic chain addition/removal at runtime
 *
 * Design Goals:
 * - Enable 15+ chains within free tier limits
 * - Isolate failures to individual chains
 * - Provide unified health reporting per partition
 *
 * @see ADR-003: Partitioned Chain Detectors
 * @see S3.1.1: Create PartitionedDetector base class
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { createLogger, getPerformanceLogger, PerformanceLogger } from './logger';
import { getRedisClient, RedisClient } from './redis';
import { getRedisStreamsClient, RedisStreamsClient } from './redis-streams';
import { WebSocketManager, WebSocketConfig, WebSocketMessage } from './websocket-manager';
// P0-1 FIX: Import LRUCache for bounded price tracking
import { LRUCache } from './data-structures';
import {
  CHAINS,
  CORE_TOKENS,
  DETECTOR_CONFIG,
  EVENT_SIGNATURES,
  getEnabledDexes,
  // S3.2.4-FIX: Import token normalization for cross-chain matching
  normalizeTokenForCrossChain
} from '../../config/src';
import { Dex, Token, PriceUpdate } from '../../types/src';

// =============================================================================
// Types
// =============================================================================

export interface PartitionedDetectorConfig {
  /** Unique partition identifier */
  partitionId: string;

  /** Array of chain IDs to monitor (accepts readonly arrays from PartitionConfig) */
  chains: readonly string[] | string[];

  /** Deployment region */
  region: string;

  /** Health check interval in ms (default: 15000) */
  healthCheckIntervalMs?: number;

  /** Failover timeout in ms (default: 60000) */
  failoverTimeoutMs?: number;

  /** Maximum reconnect attempts per chain (default: 5) */
  maxReconnectAttempts?: number;
}

/** Internal config type with mutable chains array for runtime modifications */
interface InternalDetectorConfig extends Omit<Required<PartitionedDetectorConfig>, 'chains'> {
  chains: string[];
}

export interface ChainHealth {
  chainId: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  wsConnected: boolean;
  blocksBehind: number;
  lastBlockTime: number;
  eventsPerSecond: number;
  errorCount: number;
}

export interface PartitionHealth {
  partitionId: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  chainHealth: Map<string, ChainHealth>;
  totalEventsProcessed: number;
  avgEventLatencyMs: number;
  memoryUsage: number;
  cpuUsage: number;
  uptimeSeconds: number;
  lastHealthCheck: number;
  activeOpportunities: number;
}

export interface ChainStats {
  eventsProcessed: number;
  lastBlockNumber: number;
  lastBlockTimestamp: number;
}

export interface PricePoint {
  price: number;
  timestamp: number;
}

export interface CrossChainDiscrepancy {
  pairKey: string;
  chains: string[];
  prices: Map<string, number>;
  maxDifference: number;
  timestamp: number;
}

/**
 * Logger interface for PartitionedDetector.
 * Allows injecting mock loggers for testing.
 */
export interface PartitionedDetectorLogger {
  info: (message: string, meta?: object) => void;
  warn: (message: string, meta?: object) => void;
  error: (message: string, meta?: object) => void;
  debug: (message: string, meta?: object) => void;
}

/**
 * Function signature for token normalization (for cross-chain matching).
 */
export type TokenNormalizeFn = (symbol: string) => string;

/**
 * Dependencies that can be injected into PartitionedDetector.
 * This enables proper testing without Jest mock hoisting issues.
 */
export interface PartitionedDetectorDeps {
  /** Logger instance - if provided, used instead of createLogger() */
  logger?: PartitionedDetectorLogger;
  /** Performance logger instance - if provided, used instead of getPerformanceLogger() */
  perfLogger?: PerformanceLogger;
  /** Token normalizer function - if provided, used for cross-chain token matching */
  normalizeToken?: TokenNormalizeFn;
}

// P0-1 FIX: Proper types for Ethereum RPC events (consistent with chain-instance.ts)
interface EthereumLog {
  address: string;
  data: string;
  topics: string[];
  blockNumber: string;  // Hex string
  transactionHash?: string;
}

interface EthereumBlockHeader {
  number: string;  // Hex string
  timestamp?: string;
  hash?: string;
}

// =============================================================================
// S3.2.4-FIX: Token Pair Normalization Helper
// Moved to PartitionedDetector.normalizeTokenPair() method for DI support
// =============================================================================

// =============================================================================
// PartitionedDetector Base Class
// =============================================================================

export class PartitionedDetector extends EventEmitter {
  protected config: InternalDetectorConfig;
  protected logger: PartitionedDetectorLogger;
  protected perfLogger: PerformanceLogger;
  protected normalizeToken: TokenNormalizeFn;

  // Clients
  protected redis: RedisClient | null = null;
  protected streamsClient: RedisStreamsClient | null = null;

  // Chain management
  protected chainManagers: Map<string, WebSocketManager> = new Map();
  protected chainProviders: Map<string, ethers.JsonRpcProvider> = new Map();
  protected chainHealth: Map<string, ChainHealth> = new Map();
  protected chainStats: Map<string, ChainStats> = new Map();
  protected chainConfigs: Map<string, typeof CHAINS[keyof typeof CHAINS]> = new Map();

  // Cross-chain price tracking
  // P0-1 FIX: Use LRUCache per chain to prevent unbounded memory growth
  // Max 50,000 pairs per chain bounds memory at ~50MB total (11 chains x 4.5MB each)
  // LRUCache maintains O(1) get/set while auto-evicting oldest entries
  private static readonly MAX_PRICE_CACHE_PER_CHAIN = 50000;
  protected chainPrices: Map<string, LRUCache<string, PricePoint>> = new Map();

  // Health tracking
  // P6-FIX: Add max size constant to prevent unbounded memory growth
  private static readonly MAX_LATENCY_SAMPLES = 1000;
  // P1-001 FIX: Use ring buffer instead of array with slice() to avoid memory churn
  // Float64Array is pre-allocated and reused - no GC pressure in hot path
  protected eventLatencies: Float64Array = new Float64Array(PartitionedDetector.MAX_LATENCY_SAMPLES);
  protected eventLatencyIndex: number = 0;  // Current write position
  protected eventLatencyCount: number = 0;  // Number of samples written (up to MAX_LATENCY_SAMPLES)
  protected healthMonitoringInterval: NodeJS.Timeout | null = null;
  protected startTime: number = 0;

  // P1-002 FIX: Cache for normalized token pairs to avoid repeated string allocations in hot path
  // LRU-style cache with bounded size to prevent memory growth
  private static readonly MAX_NORMALIZED_PAIR_CACHE_SIZE = 10000;
  private normalizedPairCache: Map<string, string> = new Map();

  // Lifecycle state
  private running: boolean = false;
  private stopping: boolean = false;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(config: PartitionedDetectorConfig, deps?: PartitionedDetectorDeps) {
    super();

    // Validate chains
    if (!config.chains || config.chains.length === 0) {
      throw new Error('At least one chain must be specified');
    }

    for (const chainId of config.chains) {
      if (!CHAINS[chainId as keyof typeof CHAINS]) {
        throw new Error(`Invalid chain: ${chainId}`);
      }
    }

    // Set defaults
    this.config = {
      partitionId: config.partitionId,
      chains: [...config.chains],
      region: config.region,
      healthCheckIntervalMs: config.healthCheckIntervalMs ?? 15000,
      failoverTimeoutMs: config.failoverTimeoutMs ?? 60000,
      maxReconnectAttempts: config.maxReconnectAttempts ?? 5
    };

    // Use injected dependencies if provided, otherwise create defaults
    this.logger = deps?.logger ?? createLogger(`partition:${config.partitionId}`);
    this.perfLogger = deps?.perfLogger ?? getPerformanceLogger(`partition:${config.partitionId}`);
    this.normalizeToken = deps?.normalizeToken ?? normalizeTokenForCrossChain;

    // Initialize chain configs
    for (const chainId of this.config.chains) {
      this.chainConfigs.set(chainId, CHAINS[chainId as keyof typeof CHAINS]);
      this.initializeChainHealth(chainId);
    }
  }

  // ===========================================================================
  // Token Pair Normalization (S3.2.4-FIX)
  // ===========================================================================

  /**
   * Normalize a token pair string for cross-chain matching.
   * Uses the injected normalizeToken function (or default) for DI support.
   * Handles different token symbol conventions across chains:
   * - WETH.e_USDT (Avalanche) → WETH_USDT
   * - ETH_USDT (BSC) → WETH_USDT
   * - WBTC.e_USDC (Avalanche) → WBTC_USDC
   *
   * @param pairKey - Token pair string in format "TOKEN0_TOKEN1" or "DEX_TOKEN0_TOKEN1"
   * @returns Normalized token pair string
   */
  protected normalizeTokenPair(pairKey: string): string {
    // P1-002 FIX: Check cache first to avoid repeated string allocations
    const cached = this.normalizedPairCache.get(pairKey);
    if (cached !== undefined) {
      return cached;
    }

    // P2-3 FIX: Use lastIndexOf instead of split() to avoid array allocation in hot path
    // Format: "TOKEN0_TOKEN1" or "DEX_TOKEN0_TOKEN1"
    const lastSep = pairKey.lastIndexOf('_');
    if (lastSep === -1) {
      // Cache and return unchanged key
      this.cacheNormalizedPair(pairKey, pairKey);
      return pairKey;
    }

    const token1 = pairKey.slice(lastSep + 1);
    const beforeLastSep = pairKey.slice(0, lastSep);
    const secondLastSep = beforeLastSep.lastIndexOf('_');

    // If no second separator, format is "TOKEN0_TOKEN1"
    const token0 = secondLastSep === -1
      ? beforeLastSep
      : beforeLastSep.slice(secondLastSep + 1);

    // Normalize each token in the pair using injected function
    const normalizedToken0 = this.normalizeToken(token0);
    const normalizedToken1 = this.normalizeToken(token1);

    const result = `${normalizedToken0}_${normalizedToken1}`;

    // Cache the result for future lookups
    this.cacheNormalizedPair(pairKey, result);

    return result;
  }

  /**
   * P1-002 FIX: Cache normalized pair with bounded size to prevent memory leak.
   * Uses simple eviction: clear half the cache when full.
   */
  private cacheNormalizedPair(key: string, value: string): void {
    // Evict half the cache if at capacity (simple but effective for this use case)
    if (this.normalizedPairCache.size >= PartitionedDetector.MAX_NORMALIZED_PAIR_CACHE_SIZE) {
      // Get first half of entries to delete (oldest entries in Map insertion order)
      const entriesToDelete = Math.floor(this.normalizedPairCache.size / 2);
      let deleted = 0;
      for (const cacheKey of this.normalizedPairCache.keys()) {
        if (deleted >= entriesToDelete) break;
        this.normalizedPairCache.delete(cacheKey);
        deleted++;
      }
    }
    this.normalizedPairCache.set(key, value);
  }

  // ===========================================================================
  // Lifecycle Methods
  // ===========================================================================

  async start(): Promise<void> {
    // Return existing promise if start in progress
    if (this.startPromise) {
      return this.startPromise;
    }

    // Wait for pending stop
    if (this.stopPromise) {
      await this.stopPromise;
    }

    // Guard against starting while stopping
    if (this.stopping) {
      this.logger.warn('Cannot start: PartitionedDetector is stopping');
      return;
    }

    // Guard against double start
    if (this.running) {
      this.logger.warn('PartitionedDetector already running');
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
    this.logger.info('Starting PartitionedDetector', {
      partitionId: this.config.partitionId,
      chains: this.config.chains,
      region: this.config.region
    });

    this.startTime = Date.now();

    try {
      // Initialize Redis clients
      await this.initializeRedis();

      // Initialize chain connections
      await this.initializeChainConnections();

      // Start health monitoring
      this.startHealthMonitoring();

      this.running = true;

      this.emit('started', {
        partitionId: this.config.partitionId,
        chains: this.config.chains
      });

      this.logger.info('PartitionedDetector started successfully', {
        chainsConnected: this.chainManagers.size
      });

    } catch (error) {
      // Cleanup on failure
      await this.cleanup();
      this.logger.error('Failed to start PartitionedDetector', { error });
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
      this.logger.debug('PartitionedDetector not running');
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
    this.logger.info('Stopping PartitionedDetector', {
      partitionId: this.config.partitionId
    });

    this.stopping = true;
    this.running = false;

    await this.cleanup();

    this.stopping = false;

    this.emit('stopped', {
      partitionId: this.config.partitionId
    });

    this.logger.info('PartitionedDetector stopped');
  }

  private async cleanup(): Promise<void> {
    // Stop health monitoring
    if (this.healthMonitoringInterval) {
      clearInterval(this.healthMonitoringInterval);
      this.healthMonitoringInterval = null;
    }

    // Disconnect all WebSocket managers
    const disconnectPromises: Promise<void>[] = [];
    for (const [chainId, wsManager] of this.chainManagers) {
      disconnectPromises.push(
        this.disconnectChain(chainId).catch(err => {
          this.logger.warn(`Error disconnecting ${chainId}`, { error: err });
        })
      );
    }
    await Promise.allSettled(disconnectPromises);

    // Clear chain managers
    this.chainManagers.clear();
    this.chainProviders.clear();

    // Disconnect Redis
    if (this.streamsClient) {
      try {
        await this.streamsClient.disconnect();
      } catch (error) {
        this.logger.warn('Error disconnecting Streams client', { error });
      }
      this.streamsClient = null;
    }

    if (this.redis) {
      try {
        await this.redis.disconnect();
      } catch (error) {
        this.logger.warn('Error disconnecting Redis client', { error });
      }
      this.redis = null;
    }

    // Clear tracking data
    this.chainPrices.clear();
    // P1-001 FIX: Reset ring buffer state (no allocation - just reset indices)
    this.eventLatencyIndex = 0;
    this.eventLatencyCount = 0;
    // P1-002 FIX: Clear normalization cache to free memory
    this.normalizedPairCache.clear();
  }

  // ===========================================================================
  // Redis Initialization
  // ===========================================================================

  private async initializeRedis(): Promise<void> {
    this.redis = await getRedisClient();
    this.streamsClient = await getRedisStreamsClient();

    this.logger.debug('Redis clients initialized');
  }

  // ===========================================================================
  // Chain Connection Management
  // ===========================================================================

  private async initializeChainConnections(): Promise<void> {
    const connectionPromises: Promise<void>[] = [];

    for (const chainId of this.config.chains) {
      connectionPromises.push(
        this.connectChain(chainId).catch(err => {
          this.logger.error(`Failed to connect ${chainId}`, { error: err });
          this.updateChainHealth(chainId, 'unhealthy', false);
        })
      );
    }

    // Wait for all connections (successful or failed)
    await Promise.allSettled(connectionPromises);
  }

  private async connectChain(chainId: string): Promise<void> {
    const chainConfig = this.chainConfigs.get(chainId);
    if (!chainConfig) {
      throw new Error(`Chain config not found: ${chainId}`);
    }

    // Initialize RPC provider
    const provider = new ethers.JsonRpcProvider(chainConfig.rpcUrl);
    this.chainProviders.set(chainId, provider);

    // Initialize WebSocket manager
    const wsConfig: WebSocketConfig = {
      url: chainConfig.wsUrl || chainConfig.rpcUrl,
      fallbackUrls: chainConfig.wsFallbackUrls,
      reconnectInterval: 5000,
      maxReconnectAttempts: this.config.maxReconnectAttempts,
      pingInterval: 30000,
      connectionTimeout: 10000
    };

    const wsManager = new WebSocketManager(wsConfig);

    // Set up event handlers BEFORE connecting
    // The 'connected' handler will emit chainConnected and update health
    this.setupChainEventHandlers(chainId, wsManager);

    // Connect - this will trigger 'connected' event which handles:
    // - updateChainHealth(chainId, 'healthy', true)
    // - emit('chainConnected', { chainId })
    await wsManager.connect();

    // P2-1 FIX: Only add to chainManagers here - health and event are handled by 'connected' handler
    // This prevents duplicate chainConnected events and ensures consistency for reconnections
    this.chainManagers.set(chainId, wsManager);

    this.logger.info(`Chain ${chainId} connected`);
  }

  private async disconnectChain(chainId: string): Promise<void> {
    const wsManager = this.chainManagers.get(chainId);
    if (wsManager) {
      wsManager.removeAllListeners();
      await Promise.race([
        wsManager.disconnect(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('Disconnect timeout')), 5000)
        )
      ]).catch(() => {
        // Timeout is acceptable during cleanup
      });
    }

    this.chainProviders.delete(chainId);
    this.updateChainHealth(chainId, 'unhealthy', false);
  }

  private setupChainEventHandlers(chainId: string, wsManager: WebSocketManager): void {
    wsManager.on('connected', () => {
      this.updateChainHealth(chainId, 'healthy', true);
      this.emit('chainConnected', { chainId });
    });

    wsManager.on('disconnected', () => {
      this.logger.warn(`Chain ${chainId} disconnected, will attempt reconnection`);
      this.updateChainHealth(chainId, 'degraded', false);
      this.emit('chainDisconnected', { chainId });
    });

    wsManager.on('error', (error: Error) => {
      this.updateChainHealth(chainId, 'unhealthy', false);
      this.emit('chainError', { chainId, error });
    });

    wsManager.on('message', (message: WebSocketMessage) => {
      this.handleChainMessage(chainId, message);
    });
  }

  // ===========================================================================
  // Dynamic Chain Management
  // ===========================================================================

  async addChain(chainId: string): Promise<void> {
    if (!CHAINS[chainId as keyof typeof CHAINS]) {
      throw new Error(`Invalid chain: ${chainId}`);
    }

    if (this.config.chains.includes(chainId)) {
      this.logger.warn(`Chain ${chainId} already in partition`);
      return;
    }

    this.config.chains.push(chainId);
    this.chainConfigs.set(chainId, CHAINS[chainId as keyof typeof CHAINS]);
    this.initializeChainHealth(chainId);

    if (this.running) {
      await this.connectChain(chainId);
    }

    this.logger.info(`Chain ${chainId} added to partition`);
  }

  async removeChain(chainId: string): Promise<void> {
    if (this.config.chains.length === 1) {
      throw new Error('Cannot remove last chain from partition');
    }

    const index = this.config.chains.indexOf(chainId);
    if (index === -1) {
      this.logger.warn(`Chain ${chainId} not in partition`);
      return;
    }

    // Disconnect if running
    if (this.chainManagers.has(chainId)) {
      await this.disconnectChain(chainId);
      this.chainManagers.delete(chainId);
    }

    // Remove from config
    this.config.chains.splice(index, 1);
    this.chainConfigs.delete(chainId);
    this.chainHealth.delete(chainId);
    this.chainStats.delete(chainId);
    this.chainPrices.delete(chainId);

    this.logger.info(`Chain ${chainId} removed from partition`);
  }

  // ===========================================================================
  // Health Management
  // ===========================================================================

  private initializeChainHealth(chainId: string): void {
    this.chainHealth.set(chainId, {
      chainId,
      status: 'unhealthy',
      wsConnected: false,
      blocksBehind: 0,
      lastBlockTime: 0,
      eventsPerSecond: 0,
      errorCount: 0
    });

    this.chainStats.set(chainId, {
      eventsProcessed: 0,
      lastBlockNumber: 0,
      lastBlockTimestamp: 0
    });

    // P0-1 FIX: Use LRUCache to bound memory per chain
    this.chainPrices.set(chainId, new LRUCache<string, PricePoint>(
      PartitionedDetector.MAX_PRICE_CACHE_PER_CHAIN
    ));
  }

  private updateChainHealth(chainId: string, status: ChainHealth['status'], wsConnected: boolean): void {
    const health = this.chainHealth.get(chainId);
    if (health) {
      health.status = status;
      health.wsConnected = wsConnected;
      if (status === 'unhealthy') {
        health.errorCount++;
      }
    }
  }

  private startHealthMonitoring(): void {
    this.healthMonitoringInterval = setInterval(async () => {
      if (!this.running || this.stopping) {
        return;
      }

      try {
        const health = this.getPartitionHealth();

        // Persist to Redis - convert to ServiceHealth format
        // P3-2 FIX: Use unified ServiceHealth with 'name' field
        if (this.redis) {
          const serviceHealth = {
            name: `partition:${this.config.partitionId}`,
            status: health.status,
            uptime: health.uptimeSeconds,
            memoryUsage: health.memoryUsage,
            cpuUsage: health.cpuUsage,
            lastHeartbeat: health.lastHealthCheck,
            latency: health.avgEventLatencyMs
          };
          await this.redis.updateServiceHealth(
            `partition:${this.config.partitionId}`,
            serviceHealth
          );
        }

        this.emit('healthUpdate', health);
        this.perfLogger.logHealthCheck(this.config.partitionId, health);

      } catch (error) {
        this.logger.error('Health monitoring failed', { error });
      }
    }, this.config.healthCheckIntervalMs);
  }

  getPartitionHealth(): PartitionHealth {
    let totalEvents = 0;
    let healthyChains = 0;

    for (const stats of this.chainStats.values()) {
      totalEvents += stats.eventsProcessed;
    }

    for (const health of this.chainHealth.values()) {
      if (health.status === 'healthy') {
        healthyChains++;
      }
    }

    const totalChains = this.config.chains.length;
    let status: PartitionHealth['status'];

    if (healthyChains === totalChains) {
      status = 'healthy';
    } else if (healthyChains === 0) {
      status = 'unhealthy';
    } else {
      status = 'degraded';
    }

    // P1-001 FIX: Calculate average from ring buffer without creating new arrays
    let avgLatency = 0;
    if (this.eventLatencyCount > 0) {
      let sum = 0;
      for (let i = 0; i < this.eventLatencyCount; i++) {
        sum += this.eventLatencies[i];
      }
      avgLatency = sum / this.eventLatencyCount;
    }

    return {
      partitionId: this.config.partitionId,
      status,
      chainHealth: new Map(this.chainHealth),
      totalEventsProcessed: totalEvents,
      avgEventLatencyMs: avgLatency,
      memoryUsage: process.memoryUsage().heapUsed,
      cpuUsage: 0, // Would need os module for accurate CPU
      uptimeSeconds: this.startTime > 0 ? (Date.now() - this.startTime) / 1000 : 0,
      lastHealthCheck: Date.now(),
      activeOpportunities: 0
    };
  }

  getHealthyChains(): string[] {
    const healthy: string[] = [];
    for (const [chainId, health] of this.chainHealth) {
      if (health.status === 'healthy') {
        healthy.push(chainId);
      }
    }
    return healthy;
  }

  /**
   * P6-FIX + P1-001 FIX: Record event latency using ring buffer.
   * O(1) operation with zero memory allocation - critical for hot path performance.
   * Keeps only the most recent MAX_LATENCY_SAMPLES entries.
   * Subclasses should use this method to record latencies safely.
   */
  protected recordEventLatency(latencyMs: number): void {
    // Write to current position in ring buffer
    this.eventLatencies[this.eventLatencyIndex] = latencyMs;
    // Advance index with wrap-around
    this.eventLatencyIndex = (this.eventLatencyIndex + 1) % PartitionedDetector.MAX_LATENCY_SAMPLES;
    // Track count up to max (for accurate average when buffer not yet full)
    if (this.eventLatencyCount < PartitionedDetector.MAX_LATENCY_SAMPLES) {
      this.eventLatencyCount++;
    }
  }

  // ===========================================================================
  // Message Handling
  // ===========================================================================

  protected handleChainMessage(chainId: string, message: WebSocketMessage): void {
    // Guard against processing during shutdown
    if (this.stopping || !this.running) {
      return;
    }

    try {
      if (message.method === 'eth_subscription') {
        const result = message.params?.result;
        // P0-1 FIX: Type-safe checks with proper casting
        if (result && typeof result === 'object' && 'topics' in result) {
          this.handleLogEvent(chainId, result as EthereumLog);
        } else if (result && typeof result === 'object' && 'number' in result) {
          this.handleNewBlock(chainId, result as EthereumBlockHeader);
        }
      }
    } catch (error) {
      this.logger.error(`Error handling message from ${chainId}`, { error });
    }
  }

  // P0-1 FIX: Use EthereumLog type instead of any
  protected handleLogEvent(chainId: string, log: EthereumLog): void {
    const topic0 = log.topics?.[0];

    if (topic0 === EVENT_SIGNATURES.SYNC) {
      this.handleSyncEvent(chainId, log);
    } else if (topic0 === EVENT_SIGNATURES.SWAP_V2) {
      this.handleSwapEvent(chainId, log);
    }

    // Update stats
    const stats = this.chainStats.get(chainId);
    if (stats) {
      stats.eventsProcessed++;
    }
  }

  // P0-1 FIX: Use EthereumLog type instead of any
  protected handleSyncEvent(chainId: string, log: EthereumLog): void {
    // Override in subclass for specific handling
  }

  // P0-1 FIX: Use EthereumLog type instead of any
  protected handleSwapEvent(chainId: string, log: EthereumLog): void {
    // Override in subclass for specific handling
  }

  // P0-1 FIX: Use EthereumBlockHeader type instead of any
  protected handleNewBlock(chainId: string, block: EthereumBlockHeader): void {
    const stats = this.chainStats.get(chainId);
    if (stats) {
      const blockNumber = parseInt(block.number, 16);
      stats.lastBlockNumber = blockNumber;
      stats.lastBlockTimestamp = Date.now();
    }

    const health = this.chainHealth.get(chainId);
    if (health) {
      health.lastBlockTime = Date.now();
    }
  }

  // ===========================================================================
  // Cross-Chain Price Tracking
  // ===========================================================================

  updatePrice(chainId: string, pairKey: string, price: number): void {
    const chainPriceMap = this.chainPrices.get(chainId);
    if (chainPriceMap) {
      chainPriceMap.set(pairKey, { price, timestamp: Date.now() });
    }
  }

  getCrossChainPrices(pairKey: string): Map<string, PricePoint> {
    const prices = new Map<string, PricePoint>();

    for (const [chainId, chainPriceMap] of this.chainPrices) {
      const pricePoint = chainPriceMap.get(pairKey);
      if (pricePoint) {
        prices.set(chainId, pricePoint);
      }
    }

    return prices;
  }

  findCrossChainDiscrepancies(minDifferencePercent: number): CrossChainDiscrepancy[] {
    const discrepancies: CrossChainDiscrepancy[] = [];

    // P1-1 FIX: Create a deep snapshot of all chain prices to prevent race conditions
    // during iteration. If updatePrice is called during discrepancy detection,
    // we work with consistent point-in-time data.
    const pricesSnapshot = new Map<string, Map<string, PricePoint>>();
    for (const [chainId, chainPriceMap] of this.chainPrices) {
      pricesSnapshot.set(chainId, new Map(chainPriceMap));
    }

    // S3.2.4-FIX: Group prices by NORMALIZED pair key to detect cross-chain discrepancies
    // Different chains may use different token symbols for the same asset:
    // - Avalanche: WETH.e_USDT → normalizes to WETH_USDT
    // - BSC: ETH_USDT → normalizes to WETH_USDT
    // Without normalization, these would be treated as different pairs!
    const normalizedPrices = new Map<string, Map<string, { price: PricePoint; originalPairKey: string }>>();

    for (const [chainId, chainPriceMap] of pricesSnapshot) {
      for (const [pairKey, pricePoint] of chainPriceMap) {
        const normalizedPair = this.normalizeTokenPair(pairKey);

        if (!normalizedPrices.has(normalizedPair)) {
          normalizedPrices.set(normalizedPair, new Map());
        }
        normalizedPrices.get(normalizedPair)!.set(chainId, {
          price: pricePoint,
          originalPairKey: pairKey
        });
      }
    }

    // Check each normalized pair for cross-chain discrepancies
    for (const [normalizedPair, chainPriceData] of normalizedPrices) {
      if (chainPriceData.size < 2) continue;

      // P0-1 FIX: Single-pass min/max without array allocation (hot-path optimization)
      // Previous code created 2 array allocations per pair - bad for GC in tight loop
      let minPrice = Infinity;
      let maxPrice = -Infinity;
      for (const data of chainPriceData.values()) {
        const price = data.price.price;
        if (price < minPrice) minPrice = price;
        if (price > maxPrice) maxPrice = price;
      }

      if (minPrice === 0) continue;

      const difference = (maxPrice - minPrice) / minPrice;

      if (difference >= minDifferencePercent) {
        const priceMap = new Map<string, number>();
        for (const [chainId, data] of chainPriceData) {
          priceMap.set(chainId, data.price.price);
        }

        discrepancies.push({
          pairKey: normalizedPair, // Use normalized pair key for consistency
          chains: Array.from(chainPriceData.keys()),
          prices: priceMap,
          maxDifference: difference,
          timestamp: Date.now()
        });
      }
    }

    return discrepancies;
  }

  // ===========================================================================
  // Public Getters
  // ===========================================================================

  isRunning(): boolean {
    return this.running;
  }

  getPartitionId(): string {
    return this.config.partitionId;
  }

  getChains(): string[] {
    return [...this.config.chains];
  }

  getRegion(): string {
    return this.config.region;
  }

  getChainManagers(): Map<string, WebSocketManager> {
    return new Map(this.chainManagers);
  }

  getChainHealth(chainId: string): ChainHealth | undefined {
    return this.chainHealth.get(chainId);
  }
}

export default PartitionedDetector;
