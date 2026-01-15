/**
 * Unified Chain Detector
 *
 * Multi-chain detector service that runs multiple blockchain detectors
 * in a single process based on partition configuration.
 *
 * Implements ADR-003 (Partitioned Chain Detectors) by consolidating
 * multiple chain detectors into configurable partitions.
 *
 * Features:
 * - Multi-chain support in single process
 * - Partition-based configuration
 * - Cross-region health reporting
 * - Graceful degradation support
 * - Resource-aware chain management
 *
 * @see ADR-003: Partitioned Chain Detectors
 * @see ADR-007: Cross-Region Failover Strategy
 */

import { EventEmitter } from 'events';
import {
  createLogger,
  getPerformanceLogger,
  PerformanceLogger,
  ServiceStateManager,
  ServiceState,
  createServiceState,
  RedisClient,
  getRedisClient,
  RedisStreamsClient,
  getRedisStreamsClient,
  CrossRegionHealthManager,
  getCrossRegionHealthManager,
  GracefulDegradationManager,
  getGracefulDegradationManager
} from '@arbitrage/core';

import {
  PartitionConfig,
  ChainInstance,
  PartitionHealth,
  ChainHealth,
  getPartitionFromEnv,
  getChainsFromEnv,
  createChainInstance,
  getPartition,
  CHAINS,
  DEXES,
  CORE_TOKENS
} from '@arbitrage/config';

import { ChainDetectorInstance } from './chain-instance';

// =============================================================================
// Types
// =============================================================================

/** Logger interface for dependency injection */
interface Logger {
  info: (message: string, meta?: object) => void;
  error: (message: string, meta?: object) => void;
  warn: (message: string, meta?: object) => void;
  debug: (message: string, meta?: object) => void;
}

/** Base config options (without DI) */
interface BaseDetectorConfig {
  /** Partition ID to run (from env or explicit) */
  partitionId?: string;

  /** Override chains to monitor (comma-separated or array) */
  chains?: string[];

  /** Instance ID for this detector */
  instanceId?: string;

  /** Region ID for cross-region health */
  regionId?: string;

  /** Whether to enable cross-region health manager */
  enableCrossRegionHealth?: boolean;

  /** Health check port for HTTP endpoint */
  healthCheckPort?: number;
}

/** Factory type for creating chain detector instances */
export type ChainInstanceFactory = (config: {
  chainId: string;
  partitionId: string;
  streamsClient: RedisStreamsClient;
  perfLogger: PerformanceLogger;
}) => ChainDetectorInstance;

export interface UnifiedDetectorConfig extends BaseDetectorConfig {
  /** Optional logger for testing (defaults to createLogger) */
  logger?: Logger;

  /** Optional perf logger for testing */
  perfLogger?: PerformanceLogger;

  /** Optional state manager for testing */
  stateManager?: ServiceStateManager;

  /** Optional Redis client for testing */
  redisClient?: RedisClient;

  /** Optional Redis Streams client for testing */
  streamsClient?: RedisStreamsClient;

  /** Optional chain instance factory for testing */
  chainInstanceFactory?: ChainInstanceFactory;
}

export interface UnifiedDetectorStats {
  /** Partition being monitored */
  partitionId: string;

  /** Chains being monitored */
  chains: string[];

  /** Total events processed across all chains */
  totalEventsProcessed: number;

  /** Total opportunities found */
  totalOpportunitiesFound: number;

  /** Uptime in seconds */
  uptimeSeconds: number;

  /** Memory usage in MB */
  memoryUsageMB: number;

  /** Per-chain statistics */
  chainStats: Map<string, ChainStats>;
}

export interface ChainStats {
  chainId: string;
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  eventsProcessed: number;
  opportunitiesFound: number;
  lastBlockNumber: number;
  avgBlockLatencyMs: number;
  pairsMonitored: number;
}

// =============================================================================
// Unified Chain Detector
// =============================================================================

export class UnifiedChainDetector extends EventEmitter {
  private logger: Logger;
  private perfLogger: PerformanceLogger;
  private stateManager: ServiceStateManager;

  private redis: RedisClient | null = null;
  private streamsClient: RedisStreamsClient | null = null;
  private injectedRedis: RedisClient | null = null;
  private injectedStreamsClient: RedisStreamsClient | null = null;
  private crossRegionHealth: CrossRegionHealthManager | null = null;
  private degradationManager: GracefulDegradationManager | null = null;

  private config: Required<BaseDetectorConfig>;
  private partition: PartitionConfig | null = null;
  private chainInstances: Map<string, ChainDetectorInstance> = new Map();

  private startTime: number = 0;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private metricsInterval: NodeJS.Timeout | null = null;
  private chainInstanceFactory: ChainInstanceFactory;

  constructor(config: UnifiedDetectorConfig = {}) {
    super();

    // Resolve configuration from environment and defaults
    const partition = config.partitionId
      ? getPartition(config.partitionId)
      : getPartitionFromEnv();

    this.config = {
      partitionId: partition?.partitionId || 'asia-fast',
      chains: config.chains || getChainsFromEnv(),
      instanceId: config.instanceId || `unified-${process.env.HOSTNAME || 'local'}-${Date.now()}`,
      regionId: config.regionId || partition?.region || 'asia-southeast1',
      enableCrossRegionHealth: config.enableCrossRegionHealth ?? true,
      healthCheckPort: config.healthCheckPort || 3001
    };

    this.partition = partition || null;

    // Use injected dependencies or defaults
    this.logger = config.logger ?? createLogger(`unified-detector:${this.config.partitionId}`);
    this.perfLogger = config.perfLogger ?? getPerformanceLogger(`unified-detector:${this.config.partitionId}`);

    // Initialize state manager
    this.stateManager = config.stateManager ?? createServiceState({
      serviceName: `unified-detector-${this.config.partitionId}`,
      transitionTimeoutMs: 60000 // Longer timeout for multi-chain startup
    });

    // Save injected Redis clients for testing
    this.injectedRedis = config.redisClient ?? null;
    this.injectedStreamsClient = config.streamsClient ?? null;

    // Chain instance factory (defaults to real ChainDetectorInstance)
    this.chainInstanceFactory = config.chainInstanceFactory ??
      ((cfg) => new ChainDetectorInstance(cfg));
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  async start(): Promise<void> {
    const result = await this.stateManager.executeStart(async () => {
      this.startTime = Date.now();

      this.logger.info('Starting UnifiedChainDetector', {
        partitionId: this.config.partitionId,
        chains: this.config.chains,
        instanceId: this.config.instanceId,
        regionId: this.config.regionId
      });

      // Initialize Redis connections (use injected clients if provided)
      this.redis = this.injectedRedis ?? await getRedisClient();
      this.streamsClient = this.injectedStreamsClient ?? await getRedisStreamsClient();

      // P0-7 FIX: Validate all critical dependencies BEFORE continuing with startup
      // If these fail, state transition hasn't committed any resources yet
      if (!this.redis) {
        throw new Error('Failed to initialize Redis client - service cannot start');
      }
      if (!this.streamsClient) {
        throw new Error('Failed to initialize Redis Streams client - service cannot start');
      }

      // Initialize cross-region health if enabled
      if (this.config.enableCrossRegionHealth) {
        await this.initializeCrossRegionHealth();
      }

      // Initialize degradation manager
      this.degradationManager = getGracefulDegradationManager();

      // Start chain instances
      await this.startChainInstances();

      // Start health monitoring
      this.startHealthMonitoring();

      // Start metrics collection
      this.startMetricsCollection();

      this.logger.info('UnifiedChainDetector started successfully', {
        chainsStarted: this.chainInstances.size
      });
    });

    if (!result.success) {
      this.logger.error('Failed to start UnifiedChainDetector', {
        error: result.error
      });
      throw result.error;
    }
  }

  async stop(): Promise<void> {
    const result = await this.stateManager.executeStop(async () => {
      this.logger.info('Stopping UnifiedChainDetector');

      // Clear intervals
      if (this.healthCheckInterval) {
        clearInterval(this.healthCheckInterval);
        this.healthCheckInterval = null;
      }

      if (this.metricsInterval) {
        clearInterval(this.metricsInterval);
        this.metricsInterval = null;
      }

      // Stop all chain instances
      await this.stopChainInstances();

      // Stop cross-region health (P1-1 fix: remove listeners before stopping)
      if (this.crossRegionHealth) {
        this.crossRegionHealth.removeAllListeners();
        await this.crossRegionHealth.stop();
        this.crossRegionHealth = null;
      }

      // Disconnect Redis
      if (this.streamsClient) {
        await this.streamsClient.disconnect();
        this.streamsClient = null;
      }

      if (this.redis) {
        await this.redis.disconnect();
        this.redis = null;
      }

      this.logger.info('UnifiedChainDetector stopped');
    });

    if (!result.success) {
      this.logger.error('Error stopping UnifiedChainDetector', {
        error: result.error
      });
    }
  }

  // ===========================================================================
  // Chain Instance Management
  // ===========================================================================

  private async startChainInstances(): Promise<void> {
    // Verify streams client is available before starting chains
    if (!this.streamsClient) {
      throw new Error('StreamsClient not initialized - cannot start chain instances');
    }

    const startPromises: Promise<void>[] = [];

    for (const chainId of this.config.chains) {
      // Validate chain exists in configuration
      if (!CHAINS[chainId]) {
        this.logger.warn(`Chain ${chainId} not found in configuration, skipping`);
        continue;
      }

      const instance = this.chainInstanceFactory({
        chainId,
        partitionId: this.config.partitionId,
        streamsClient: this.streamsClient,
        perfLogger: this.perfLogger
      });

      // Set up event handlers
      instance.on('priceUpdate', (update) => {
        this.emit('priceUpdate', update);
      });

      instance.on('opportunity', (opp) => {
        this.emit('opportunity', opp);
      });

      instance.on('error', (error) => {
        this.handleChainError(chainId, error);
      });

      instance.on('statusChange', (status) => {
        this.logger.info(`Chain ${chainId} status changed to ${status}`);
      });

      this.chainInstances.set(chainId, instance);

      // Start instances in parallel
      startPromises.push(
        instance.start().catch((error) => {
          this.logger.error(`Failed to start chain instance: ${chainId}`, { error });
          // Don't fail the entire startup for one chain
          this.handleChainError(chainId, error);
        })
      );
    }

    // Wait for all chains to start (or fail gracefully)
    await Promise.allSettled(startPromises);

    const successfulChains = Array.from(this.chainInstances.values())
      .filter(i => i.isConnected())
      .map(i => i.getChainId());

    this.logger.info('Chain instances started', {
      requested: this.config.chains.length,
      successful: successfulChains.length,
      chains: successfulChains
    });
  }

  // P1-8 FIX: Timeout for individual chain shutdown operations
  private static readonly CHAIN_STOP_TIMEOUT_MS = 30000; // 30 seconds

  private async stopChainInstances(): Promise<void> {
    const stopPromises: Promise<void>[] = [];

    // P1-7 FIX: Take snapshot of chainInstances to avoid iterator issues during modification
    const instancesSnapshot = Array.from(this.chainInstances.entries());

    for (const [chainId, instance] of instancesSnapshot) {
      // P1-1 fix: Remove listeners before stopping to prevent memory leak
      instance.removeAllListeners();

      // P1-8 FIX: Wrap stop() with timeout to prevent indefinite hangs
      const stopWithTimeout = Promise.race([
        instance.stop(),
        new Promise<void>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Chain ${chainId} stop timeout after ${UnifiedChainDetector.CHAIN_STOP_TIMEOUT_MS}ms`)),
            UnifiedChainDetector.CHAIN_STOP_TIMEOUT_MS
          )
        )
      ]).catch((error) => {
        this.logger.error(`Error stopping chain instance: ${chainId}`, { error: (error as Error).message });
      });

      stopPromises.push(stopWithTimeout);
    }

    await Promise.allSettled(stopPromises);
    this.chainInstances.clear();
  }

  private handleChainError(chainId: string, error: Error): void {
    this.logger.error(`Chain error: ${chainId}`, { error: error.message });

    // Trigger degradation if needed
    if (this.degradationManager) {
      this.degradationManager.triggerDegradation(
        `unified-detector-${this.config.partitionId}`,
        `chain_${chainId}_failure`,
        error
      );
    }

    this.emit('chainError', { chainId, error });
  }

  // ===========================================================================
  // Health Monitoring
  // ===========================================================================

  private async initializeCrossRegionHealth(): Promise<void> {
    this.crossRegionHealth = getCrossRegionHealthManager({
      instanceId: this.config.instanceId,
      regionId: this.config.regionId,
      serviceName: `unified-detector-${this.config.partitionId}`,
      healthCheckIntervalMs: this.partition?.healthCheckIntervalMs || 15000,
      failoverTimeoutMs: this.partition?.failoverTimeoutMs || 60000,
      canBecomeLeader: false, // Detectors don't lead, coordinator does
      isStandby: false
    });

    await this.crossRegionHealth.start();

    // Listen for failover events
    this.crossRegionHealth.on('failoverEvent', (event) => {
      this.logger.info('Received failover event', event);
      this.emit('failoverEvent', event);
    });
  }

  private startHealthMonitoring(): void {
    const interval = this.partition?.healthCheckIntervalMs || 30000;

    this.healthCheckInterval = setInterval(async () => {
      // Skip health checks if service is stopping
      if (!this.stateManager.isRunning()) {
        return;
      }

      try {
        const health = await this.getPartitionHealth();
        await this.publishHealth(health);
      } catch (error) {
        this.logger.error('Health monitoring error', { error });
      }
    }, interval);

    // Initial health report (fire-and-forget with proper error handling)
    // P1-NEW-4 FIX: Check state before publishing
    this.getPartitionHealth()
      .then(health => {
        if (this.stateManager.isRunning()) {
          return this.publishHealth(health);
        }
      })
      .catch(error => this.logger.error('Initial health report failed', { error }));
  }

  private async publishHealth(health: PartitionHealth): Promise<void> {
    // P1-NEW-4 FIX: Also check state at publish time
    if (!this.streamsClient || !this.stateManager.isRunning()) return;

    try {
      await this.streamsClient.xadd(
        RedisStreamsClient.STREAMS.HEALTH,
        {
          service: `unified-detector-${this.config.partitionId}`,
          ...health,
          chainHealth: Object.fromEntries(health.chainHealth)
        }
      );
    } catch (error) {
      this.logger.error('Failed to publish health', { error });
    }
  }

  // ===========================================================================
  // Metrics Collection
  // ===========================================================================

  private startMetricsCollection(): void {
    this.metricsInterval = setInterval(() => {
      // Skip metrics collection if service is stopping
      if (!this.stateManager.isRunning()) {
        return;
      }

      const stats = this.getStats();

      this.perfLogger.logHealthCheck(
        `unified-detector-${this.config.partitionId}`,
        {
          status: 'healthy',
          uptime: stats.uptimeSeconds,
          memoryUsage: stats.memoryUsageMB * 1024 * 1024,
          chainsMonitored: stats.chains.length,
          eventsProcessed: stats.totalEventsProcessed,
          opportunitiesFound: stats.totalOpportunitiesFound
        }
      );
    }, 60000); // Every minute
  }

  // ===========================================================================
  // Public Getters
  // ===========================================================================

  isRunning(): boolean {
    return this.stateManager.isRunning();
  }

  getState(): ServiceState {
    return this.stateManager.getState();
  }

  getPartitionId(): string {
    return this.config.partitionId;
  }

  getChains(): string[] {
    return Array.from(this.chainInstances.keys());
  }

  /**
   * Returns list of chain IDs that are currently healthy (connected status)
   */
  getHealthyChains(): string[] {
    // P9-FIX: Take snapshot to avoid iterator issues during concurrent modification
    const instancesSnapshot = Array.from(this.chainInstances.entries());
    const healthyChains: string[] = [];
    for (const [chainId, instance] of instancesSnapshot) {
      const stats = instance.getStats();
      if (stats.status === 'connected') {
        healthyChains.push(chainId);
      }
    }
    return healthyChains;
  }

  getChainInstance(chainId: string): ChainDetectorInstance | undefined {
    return this.chainInstances.get(chainId);
  }

  getStats(): UnifiedDetectorStats {
    // P10-FIX: Take snapshot to avoid iterator issues during concurrent modification
    const instancesSnapshot = Array.from(this.chainInstances.entries());
    const chainStats = new Map<string, ChainStats>();
    let totalEvents = 0;
    let totalOpportunities = 0;

    for (const [chainId, instance] of instancesSnapshot) {
      const stats = instance.getStats();
      chainStats.set(chainId, stats);
      totalEvents += stats.eventsProcessed;
      totalOpportunities += stats.opportunitiesFound;
    }

    const memUsage = process.memoryUsage();

    return {
      partitionId: this.config.partitionId,
      chains: instancesSnapshot.map(([chainId]) => chainId),
      totalEventsProcessed: totalEvents,
      totalOpportunitiesFound: totalOpportunities,
      uptimeSeconds: (Date.now() - this.startTime) / 1000,
      memoryUsageMB: Math.round(memUsage.heapUsed / 1024 / 1024),
      chainStats
    };
  }

  async getPartitionHealth(): Promise<PartitionHealth> {
    const chainHealth = new Map<string, ChainHealth>();
    let totalEvents = 0;
    let totalLatency = 0;

    // P1-7 FIX: Take snapshot of chainInstances to avoid iterator errors
    // during concurrent startup/shutdown operations
    const instancesSnapshot = Array.from(this.chainInstances.entries());

    for (const [chainId, instance] of instancesSnapshot) {
      const stats = instance.getStats();
      const health: ChainHealth = {
        chainId,
        status: stats.status === 'connected' ? 'healthy' :
                stats.status === 'error' ? 'unhealthy' : 'degraded',
        blocksBehind: 0, // Would need chain sync status
        lastBlockTime: Date.now(),
        wsConnected: stats.status === 'connected',
        eventsPerSecond: stats.eventsProcessed / Math.max(1, (Date.now() - this.startTime) / 1000),
        errorCount: stats.status === 'error' ? 1 : 0
      };
      chainHealth.set(chainId, health);
      totalEvents += stats.eventsProcessed;
      totalLatency += stats.avgBlockLatencyMs;
    }

    const memUsage = process.memoryUsage();
    const healthyChains = Array.from(chainHealth.values()).filter(h => h.status === 'healthy').length;
    const totalChains = chainHealth.size;

    let status: 'healthy' | 'degraded' | 'unhealthy';
    if (healthyChains === totalChains) {
      status = 'healthy';
    } else if (healthyChains > 0) {
      status = 'degraded';
    } else {
      status = 'unhealthy';
    }

    return {
      partitionId: this.config.partitionId,
      status,
      chainHealth,
      totalEventsProcessed: totalEvents,
      avgEventLatencyMs: totalChains > 0 ? totalLatency / totalChains : 0,
      memoryUsage: memUsage.heapUsed,
      cpuUsage: 0, // Would need OS-level metrics
      uptimeSeconds: (Date.now() - this.startTime) / 1000,
      lastHealthCheck: Date.now(),
      activeOpportunities: 0 // Would track from opportunities found
    };
  }
}
