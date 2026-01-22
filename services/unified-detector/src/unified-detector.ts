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
  getGracefulDegradationManager,
  FailoverEvent
} from '@arbitrage/core';

import {
  PartitionConfig,
  PartitionHealth,
  ChainHealth,
  getPartitionFromEnv,
  getChainsFromEnv,
  getPartition
} from '@arbitrage/config';

import { ChainDetectorInstance } from './chain-instance';
import {
  ChainInstanceManager,
  createChainInstanceManager,
  ChainInstanceFactory,
} from './chain-instance-manager';
import { HealthReporter, createHealthReporter } from './health-reporter';
import { MetricsCollector, createMetricsCollector } from './metrics-collector';
// REFACTOR: Import shared Logger type to eliminate duplication
import type { Logger } from './types';

// =============================================================================
// Types
// =============================================================================

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

// Re-export ChainInstanceFactory for backward compatibility
export { ChainInstanceFactory };

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

  // REFACTOR 9.1: Delegate to extracted modules instead of inline implementation
  private chainInstanceManager: ChainInstanceManager | null = null;
  private healthReporter: HealthReporter | null = null;
  private metricsCollector: MetricsCollector | null = null;

  // Legacy: Keep chainInstances for backward compatibility with getChainInstance()
  // This is populated from chainInstanceManager for existing API consumers
  private chainInstances: Map<string, ChainDetectorInstance> = new Map();

  private startTime: number = 0;
  private chainInstanceFactory: ChainInstanceFactory;

  // DEPRECATED: These are only used by deprecated methods (kept for backward compatibility)
  // FIX Bug 4.2: Declare properties that were used but never declared
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private metricsInterval: NodeJS.Timeout | null = null;

  // PERF-FIX: Track CPU usage for health reporting
  private lastCpuUsage: { user: number; system: number; timestamp: number } | null = null;

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

      // REFACTOR 9.1: Use ChainInstanceManager for chain lifecycle
      this.chainInstanceManager = createChainInstanceManager({
        chains: this.config.chains,
        partitionId: this.config.partitionId,
        streamsClient: this.streamsClient,
        perfLogger: this.perfLogger,
        chainInstanceFactory: this.chainInstanceFactory,
        logger: this.logger,
        degradationManager: this.degradationManager,
      });

      // Forward events from chain instance manager
      this.chainInstanceManager.on('priceUpdate', (update) => this.emit('priceUpdate', update));
      this.chainInstanceManager.on('opportunity', (opp) => this.emit('opportunity', opp));
      this.chainInstanceManager.on('chainError', (event) => this.emit('chainError', event));
      this.chainInstanceManager.on('statusChange', (event) => this.emit('statusChange', event));

      // Start chain instances via manager
      const startResult = await this.chainInstanceManager.startAll();

      // Update legacy chainInstances map for backward compatibility
      for (const chainId of startResult.startedChains) {
        const instance = this.chainInstanceManager.getChainInstance(chainId);
        if (instance) {
          this.chainInstances.set(chainId, instance);
        }
      }

      // REFACTOR 9.1: Use HealthReporter for health monitoring
      this.healthReporter = createHealthReporter({
        partitionId: this.config.partitionId,
        instanceId: this.config.instanceId,
        regionId: this.config.regionId,
        streamsClient: this.streamsClient,
        stateManager: this.stateManager,
        logger: this.logger,
        getHealthData: () => this.getPartitionHealth(),
        enableCrossRegionHealth: this.config.enableCrossRegionHealth,
        partition: this.partition ?? undefined,
      });

      // Forward failover events from health reporter
      this.healthReporter.on('failoverEvent', (event) => this.emit('failoverEvent', event));

      await this.healthReporter.start();

      // REFACTOR 9.1: Use MetricsCollector for metrics collection
      this.metricsCollector = createMetricsCollector({
        partitionId: this.config.partitionId,
        perfLogger: this.perfLogger,
        stateManager: this.stateManager,
        logger: this.logger,
        getStats: () => this.getStats(),
      });

      this.metricsCollector.start();

      this.logger.info('UnifiedChainDetector started successfully', {
        chainsStarted: startResult.chainsStarted,
        chainsFailed: startResult.chainsFailed,
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

      // REFACTOR 9.1: Stop extracted modules

      // Stop metrics collection
      if (this.metricsCollector) {
        await this.metricsCollector.stop();
        this.metricsCollector = null;
      }

      // Stop health reporter (includes cross-region health if enabled)
      if (this.healthReporter) {
        this.healthReporter.removeAllListeners();
        await this.healthReporter.stop();
        this.healthReporter = null;
      }

      // Stop chain instance manager
      if (this.chainInstanceManager) {
        this.chainInstanceManager.removeAllListeners();
        await this.chainInstanceManager.stop();
        this.chainInstanceManager = null;
      }

      // Clear legacy chainInstances map
      this.chainInstances.clear();

      // Stop cross-region health if not managed by health reporter
      // (for backward compatibility with tests that inject crossRegionHealth directly)
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
    this.crossRegionHealth.on('failoverEvent', (event: FailoverEvent) => {
      this.logger.info('Received failover event', event);
      this.emit('failoverEvent', event);
    });
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
    // REFACTOR 9.1: Delegate to chain instance manager when available
    if (this.chainInstanceManager) {
      return this.chainInstanceManager.getChains();
    }
    return Array.from(this.chainInstances.keys());
  }

  /**
   * Returns list of chain IDs that are currently healthy (connected status)
   */
  getHealthyChains(): string[] {
    // REFACTOR 9.1: Delegate to chain instance manager when available
    if (this.chainInstanceManager) {
      return this.chainInstanceManager.getHealthyChains();
    }
    // Fallback to legacy implementation
    // FIX Perf 10.4: Iterate Map directly instead of creating intermediate array
    const healthyChains: string[] = [];
    for (const [chainId, instance] of this.chainInstances) {
      const stats = instance.getStats();
      if (stats.status === 'connected') {
        healthyChains.push(chainId);
      }
    }
    return healthyChains;
  }

  getChainInstance(chainId: string): ChainDetectorInstance | undefined {
    // REFACTOR 9.1: Delegate to chain instance manager when available
    if (this.chainInstanceManager) {
      return this.chainInstanceManager.getChainInstance(chainId);
    }
    return this.chainInstances.get(chainId);
  }

  getStats(): UnifiedDetectorStats {
    // REFACTOR 9.1: Use chain instance manager's stats when available
    let chainStats: Map<string, ChainStats>;
    let chains: string[];

    if (this.chainInstanceManager) {
      chainStats = this.chainInstanceManager.getStats();
      chains = this.chainInstanceManager.getChains();
    } else {
      // Fallback to legacy implementation
      // FIX Perf 10.4: Iterate Map directly instead of creating intermediate array
      chainStats = new Map<string, ChainStats>();
      chains = [];
      for (const [chainId, instance] of this.chainInstances) {
        chainStats.set(chainId, instance.getStats());
        chains.push(chainId);
      }
    }

    // Calculate totals from chain stats
    let totalEvents = 0;
    let totalOpportunities = 0;
    for (const stats of chainStats.values()) {
      totalEvents += stats.eventsProcessed;
      totalOpportunities += stats.opportunitiesFound;
    }

    const memUsage = process.memoryUsage();

    return {
      partitionId: this.config.partitionId,
      chains,
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

    // FIX Issue 1.1: Use chainInstanceManager stats instead of stale chainInstances map
    // This ensures we have current chain status after reconnections/failures
    let chainStats: Map<string, ChainStats>;
    if (this.chainInstanceManager) {
      chainStats = this.chainInstanceManager.getStats();
    } else {
      // Fallback to legacy chainInstances map for backward compatibility
      // FIX Perf 10.4: Iterate Map directly instead of creating intermediate array
      chainStats = new Map();
      for (const [chainId, instance] of this.chainInstances) {
        chainStats.set(chainId, instance.getStats());
      }
    }

    // FIX: Calculate uptime safely - if startTime is 0, service hasn't started yet
    const uptimeMs = this.startTime > 0 ? Date.now() - this.startTime : 0;
    const uptimeSeconds = uptimeMs / 1000;

    for (const [chainId, stats] of chainStats.entries()) {
      const health: ChainHealth = {
        chainId,
        status: stats.status === 'connected' ? 'healthy' :
                stats.status === 'error' ? 'unhealthy' : 'degraded',
        blocksBehind: 0, // Would need chain sync status
        lastBlockTime: Date.now(),
        wsConnected: stats.status === 'connected',
        // FIX: Avoid division by near-zero; if not started, eventsPerSecond is 0
        eventsPerSecond: uptimeSeconds > 0 ? stats.eventsProcessed / uptimeSeconds : 0,
        errorCount: stats.status === 'error' ? 1 : 0
      };
      chainHealth.set(chainId, health);
      totalEvents += stats.eventsProcessed;
      totalLatency += stats.avgBlockLatencyMs;
    }

    const memUsage = process.memoryUsage();
    const healthyChains = Array.from(chainHealth.values()).filter(h => h.status === 'healthy').length;
    const totalChains = chainHealth.size;

    // PERF-FIX: Calculate actual CPU usage percentage using process.cpuUsage()
    // CPU usage is measured as elapsed microseconds / wall clock time * 100
    const currentCpu = process.cpuUsage();
    const now = Date.now();
    let cpuUsagePercent = 0;

    if (this.lastCpuUsage) {
      const elapsedMs = now - this.lastCpuUsage.timestamp;
      if (elapsedMs > 0) {
        // Calculate delta CPU time in microseconds
        const userDelta = currentCpu.user - this.lastCpuUsage.user;
        const systemDelta = currentCpu.system - this.lastCpuUsage.system;
        const totalCpuMicros = userDelta + systemDelta;
        // Convert elapsed wall time to microseconds for percentage calculation
        const elapsedMicros = elapsedMs * 1000;
        // CPU percentage (can exceed 100% on multi-core systems, so cap at reasonable value)
        cpuUsagePercent = Math.min((totalCpuMicros / elapsedMicros) * 100, 400);
      }
    }

    // Update last CPU reading for next call
    this.lastCpuUsage = { user: currentCpu.user, system: currentCpu.system, timestamp: now };

    // Determine overall partition status
    // 'starting' is used when no chains are initialized yet (common during startup)
    let status: 'healthy' | 'degraded' | 'unhealthy' | 'starting';
    if (totalChains === 0) {
      // No chains started yet - report as 'starting' instead of misleading 'healthy'
      status = 'starting';
    } else if (healthyChains === totalChains) {
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
      cpuUsage: Math.round(cpuUsagePercent * 100) / 100, // Round to 2 decimal places
      uptimeSeconds,
      lastHealthCheck: Date.now(),
      activeOpportunities: 0 // Would track from opportunities found
    };
  }
}
