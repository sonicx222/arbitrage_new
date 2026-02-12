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
  GracefulDegradationManager,
  getGracefulDegradationManager,
  FailoverEvent,
  PartitionDetectorInterface
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
// REFACTOR: Import shared types to eliminate duplication
// ChainStats moved to types.ts to fix circular dependency
import type { Logger, ChainStats } from './types';

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

// ChainStats moved to types.ts to fix circular dependency:
// - chain-instance.ts imported ChainStats from unified-detector.ts
// - unified-detector.ts imported ChainDetectorInstance from chain-instance.ts
// Re-export for backward compatibility with existing consumers
export type { ChainStats } from './types';

// =============================================================================
// Unified Chain Detector
// =============================================================================

export class UnifiedChainDetector extends EventEmitter implements PartitionDetectorInterface {
  private logger: Logger;
  private perfLogger: PerformanceLogger;
  private stateManager: ServiceStateManager;

  private redis: RedisClient | null = null;
  private streamsClient: RedisStreamsClient | null = null;
  private injectedRedis: RedisClient | null = null;
  private injectedStreamsClient: RedisStreamsClient | null = null;
  private degradationManager: GracefulDegradationManager | null = null;

  private config: Required<BaseDetectorConfig>;
  private partition: PartitionConfig | null = null;

  // REFACTOR 9.1: Delegate to extracted modules instead of inline implementation
  private chainInstanceManager: ChainInstanceManager | null = null;
  private healthReporter: HealthReporter | null = null;
  private metricsCollector: MetricsCollector | null = null;

  private startTime: number = 0;
  private chainInstanceFactory: ChainInstanceFactory;

  // PERF-FIX: Track CPU usage for health reporting
  private lastCpuUsage: { user: number; system: number; timestamp: number } | null = null;

  // BUG-FIX: Track active opportunities with expiration times
  // Previously only incremented, causing unbounded memory growth
  // Now stores expiresAt timestamps for proper cleanup
  private activeOpportunities: Map<string, number> = new Map(); // opportunityId -> expiresAt
  private opportunityCleanupInterval: NodeJS.Timeout | null = null;
  private static readonly OPPORTUNITY_CLEANUP_INTERVAL_MS = 5000;

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

      // CrossRegionHealth is managed exclusively by HealthReporter
      // This prevents: (a) double event subscriptions, (b) resource waste, (c) lifecycle conflicts

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
      this.chainInstanceManager.on('opportunity', (opp) => {
        // BUG-FIX: Track active opportunities with proper expiration
        // Store opportunity ID with expiration time for cleanup
        const expiresAt = opp.expiresAt || (Date.now() + 5000); // Default 5s expiry
        this.activeOpportunities.set(opp.id, expiresAt);
        this.emit('opportunity', opp);
      });
      this.chainInstanceManager.on('chainError', (event) => this.emit('chainError', event));
      this.chainInstanceManager.on('statusChange', (event) => this.emit('statusChange', event));

      // BUG-FIX: Start cleanup interval to remove expired opportunities
      this.startOpportunityCleanup();

      // Start chain instances via manager
      const startResult = await this.chainInstanceManager.startAll();

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

  /**
   * BUG-FIX: Start periodic cleanup of expired opportunities.
   * Prevents unbounded memory growth from never-cleaned opportunity tracking.
   */
  private startOpportunityCleanup(): void {
    // Clear any existing interval (safety for restart scenarios)
    if (this.opportunityCleanupInterval) {
      clearInterval(this.opportunityCleanupInterval);
    }

    this.opportunityCleanupInterval = setInterval(() => {
      const now = Date.now();
      let expiredCount = 0;

      // Remove expired opportunities
      for (const [id, expiresAt] of this.activeOpportunities) {
        if (expiresAt < now) {
          this.activeOpportunities.delete(id);
          expiredCount++;
        }
      }

      // Only log if we cleaned up a significant number (reduce log noise)
      if (expiredCount > 10) {
        this.logger.debug('Cleaned up expired opportunities', {
          expired: expiredCount,
          remaining: this.activeOpportunities.size
        });
      }
    }, UnifiedChainDetector.OPPORTUNITY_CLEANUP_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    const result = await this.stateManager.executeStop(async () => {
      this.logger.info('Stopping UnifiedChainDetector');

      // BUG-FIX: Stop opportunity cleanup interval and clear tracking
      if (this.opportunityCleanupInterval) {
        clearInterval(this.opportunityCleanupInterval);
        this.opportunityCleanupInterval = null;
      }
      this.activeOpportunities.clear();

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

      // BUG-FIX: Clear degradation manager reference to allow proper cleanup
      // Note: The manager is a singleton, so we don't stop it, just clear our reference
      this.degradationManager = null;

      // Disconnect Redis
      if (this.streamsClient) {
        await this.streamsClient.disconnect();
        this.streamsClient = null;
      }

      if (this.redis) {
        await this.redis.disconnect();
        this.redis = null;
      }

      // BUG-FIX: Reset CPU tracking state to avoid stale data on restart
      this.lastCpuUsage = null;

      this.logger.info('UnifiedChainDetector stopped');
    });

    if (!result.success) {
      this.logger.error('Error stopping UnifiedChainDetector', {
        error: result.error
      });
    }
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
    return this.chainInstanceManager?.getChains() ?? [];
  }

  /**
   * Returns list of chain IDs that are currently healthy (connected status)
   */
  getHealthyChains(): string[] {
    return this.chainInstanceManager?.getHealthyChains() ?? [];
  }

  getChainInstance(chainId: string): ChainDetectorInstance | undefined {
    return this.chainInstanceManager?.getChainInstance(chainId);
  }

  getStats(): UnifiedDetectorStats {
    const chainStats = this.chainInstanceManager?.getStats() ?? new Map<string, ChainStats>();
    const chains = this.chainInstanceManager?.getChains() ?? [];

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

    // Get current chain stats from manager
    const chainStats = this.chainInstanceManager?.getStats() ?? new Map<string, ChainStats>();

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
      // BUG-FIX: Use Map.size for accurate active opportunity count
      activeOpportunities: this.activeOpportunities.size
    };
  }
}
