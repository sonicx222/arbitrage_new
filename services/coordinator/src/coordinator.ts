/**
 * System Coordinator Service with Monitoring Dashboard
 *
 * Orchestrates all detector services and manages system health.
 * Uses Redis Streams for event consumption (ADR-002) and implements
 * leader election for failover (ADR-007).
 *
 * REFACTORED: Routes and middleware extracted to api/ folder.
 *
 * @see ARCHITECTURE_V2.md Section 4.5 (Layer 5: Coordination)
 * @see ADR-002: Redis Streams over Pub/Sub
 * @see ADR-007: Failover Strategy
 * @see api/ folder for extracted routes and middleware
 */
import http from 'http';
import express from 'express';
import {
  RedisClient,
  getRedisClient,
  createLogger,
  getPerformanceLogger,
  PerformanceLogger,
  RedisStreamsClient,
  getRedisStreamsClient,
  ConsumerGroupConfig,
  ServiceStateManager,
  createServiceState,
  StreamConsumer,
  getStreamHealthMonitor
} from '@arbitrage/core';
import type { ServiceHealth, ArbitrageOpportunity } from '@arbitrage/types';
import { isAuthEnabled } from '@shared/security';

// Import extracted API modules
// FIX: Import Logger from consolidated api/types (was duplicated locally)
import {
  configureMiddleware,
  setupAllRoutes,
  SystemMetrics,
  CoordinatorStateProvider,
  RouteLogger,
  Logger
} from './api';

// =============================================================================
// Types
// =============================================================================

// SystemMetrics is now imported from ./api/types

interface LeaderElectionConfig {
  lockKey: string;
  lockTtlMs: number;
  heartbeatIntervalMs: number;
  instanceId: string;
}

/**
 * FIX: Graceful degradation modes per ADR-007.
 * Allows coordinator to communicate system capability level.
 */
export enum DegradationLevel {
  FULL_OPERATION = 0,      // All services healthy
  REDUCED_CHAINS = 1,      // Some chain detectors down
  DETECTION_ONLY = 2,      // Execution disabled
  READ_ONLY = 3,           // Only dashboard/monitoring
  COMPLETE_OUTAGE = 4      // All services down
}

// =============================================================================
// Dependency Injection Interface
// =============================================================================

// FIX: Logger interface now imported from ./api/types (consolidated)

/**
 * StreamHealthMonitor interface for dependency injection.
 */
interface StreamHealthMonitor {
  setConsumerGroup: (group: string) => void;
  start?: () => void;
  stop?: () => void;
}

/**
 * Dependencies that can be injected into CoordinatorService.
 * This enables proper testing without Jest mock hoisting issues.
 *
 * All dependencies are optional - if not provided, real implementations
 * are used from @arbitrage/core.
 */
export interface CoordinatorDependencies {
  /** Custom logger instance */
  logger?: Logger;
  /** Custom performance logger instance */
  perfLogger?: PerformanceLogger;
  /** Factory function to get Redis client */
  getRedisClient?: () => Promise<RedisClient>;
  /** Factory function to get Redis Streams client */
  getRedisStreamsClient?: () => Promise<RedisStreamsClient>;
  /** Factory function to create service state manager */
  createServiceState?: (config: { serviceName: string; transitionTimeoutMs: number }) => ServiceStateManager;
  /** Factory function to get stream health monitor */
  getStreamHealthMonitor?: () => StreamHealthMonitor;
  /** StreamConsumer class constructor */
  StreamConsumer?: typeof StreamConsumer;
}

interface CoordinatorConfig {
  port: number;
  leaderElection: LeaderElectionConfig;
  consumerGroup: string;
  consumerId: string;
  // Standby configuration (ADR-007)
  isStandby?: boolean;
  canBecomeLeader?: boolean;
  regionId?: string;
  // FIX: Configurable constants (previously hardcoded)
  maxOpportunities?: number;       // Max opportunities in memory (default: 1000)
  opportunityTtlMs?: number;       // Opportunity expiry time (default: 60000)
  opportunityCleanupIntervalMs?: number; // Cleanup interval (default: 10000)
  pairTtlMs?: number;              // Active pair expiry time (default: 300000)
  alertCooldownMs?: number;        // Alert cooldown duration (default: 300000)
}

// P2 FIX: Proper type for stream messages with typed data access
interface StreamMessage {
  id: string;
  data: StreamMessageData;
}

// P2 FIX: Type for stream message data with common fields
interface StreamMessageData {
  // Health message fields
  name?: string;    // P3-2: Unified field name (preferred)
  service?: string; // P3-2: Legacy field name (fallback)
  status?: string;
  uptime?: number;
  memoryUsage?: number;
  cpuUsage?: number;
  timestamp?: number;
  // Opportunity message fields
  id?: string;
  chain?: string;
  profitPercentage?: number;
  buyDex?: string;
  sellDex?: string;
  expiresAt?: number;
  // Whale alert fields
  address?: string;
  usdValue?: number;
  direction?: string;
  dex?: string;
  impact?: string;
  // Allow additional fields
  [key: string]: unknown;
}

// P2 FIX: Proper type for alerts
interface Alert {
  type: string;
  service?: string;
  message?: string;
  severity?: 'low' | 'high' | 'critical';
  data?: StreamMessageData;
  timestamp: number;
}

// =============================================================================
// Coordinator Service
// =============================================================================

export class CoordinatorService implements CoordinatorStateProvider {
  private redis: RedisClient | null = null;
  private streamsClient: RedisStreamsClient | null = null;
  private logger: Logger;
  private perfLogger: PerformanceLogger;
  private stateManager: ServiceStateManager;
  private app: express.Application;
  // P2 FIX: Proper type instead of any
  private server: http.Server | null = null;
  // REFACTOR: Removed duplicate isRunning flag - stateManager is now the single source of truth
  // This eliminates potential sync issues between the flag and stateManager
  private isLeader = false;
  // FIX: Use Promise-based mutex to prevent race condition in activateStandby()
  // Two rapid calls could both pass the boolean check before either sets it
  private activationPromise: Promise<boolean> | null = null;
  private serviceHealth: Map<string, ServiceHealth> = new Map();
  private systemMetrics: SystemMetrics;
  // FIX: Track degradation level per ADR-007
  private degradationLevel: DegradationLevel = DegradationLevel.FULL_OPERATION;
  private alertCooldowns: Map<string, number> = new Map();
  private opportunities: Map<string, ArbitrageOpportunity> = new Map();

  // Startup grace period: Don't report critical alerts during initial startup
  // This prevents false alerts when services haven't reported health yet
  private static readonly STARTUP_GRACE_PERIOD_MS = 60000; // 60 seconds
  private startTime: number = 0;

  // Intervals
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private metricsUpdateInterval: NodeJS.Timeout | null = null;
  private leaderHeartbeatInterval: NodeJS.Timeout | null = null;
  // REFACTOR: Separate interval for opportunity cleanup to prevent race conditions
  // with concurrent stream consumers adding opportunities
  private opportunityCleanupInterval: NodeJS.Timeout | null = null;

  // Stream consumers (blocking read pattern - replaces setInterval polling)
  private streamConsumers: StreamConsumer[] = [];

  // Configuration
  private readonly config: CoordinatorConfig;

  // Consumer group configs for streams
  private readonly consumerGroups: ConsumerGroupConfig[];

  // REFACTOR: Store injected dependencies for use in start() and other methods
  // This enables proper testing without Jest mock hoisting issues
  private readonly deps: Required<CoordinatorDependencies>;

  constructor(config?: Partial<CoordinatorConfig>, deps?: CoordinatorDependencies) {
    // REFACTOR: Initialize dependencies with defaults or injected values
    // This pattern allows tests to inject mock dependencies directly
    this.deps = {
      logger: deps?.logger ?? createLogger('coordinator'),
      perfLogger: deps?.perfLogger ?? getPerformanceLogger('coordinator'),
      getRedisClient: deps?.getRedisClient ?? getRedisClient,
      getRedisStreamsClient: deps?.getRedisStreamsClient ?? getRedisStreamsClient,
      createServiceState: deps?.createServiceState ?? createServiceState,
      getStreamHealthMonitor: deps?.getStreamHealthMonitor ?? getStreamHealthMonitor,
      StreamConsumer: deps?.StreamConsumer ?? StreamConsumer
    };

    this.logger = this.deps.logger;
    this.perfLogger = this.deps.perfLogger;
    this.app = express();
    this.systemMetrics = this.initializeMetrics();

    // Initialize state manager for lifecycle management (P0 fix: prevents race conditions)
    this.stateManager = this.deps.createServiceState({
      serviceName: 'coordinator',
      transitionTimeoutMs: 30000
    });

    // Generate unique instance ID for leader election
    const instanceId = `coordinator-${process.env.HOSTNAME || 'local'}-${Date.now()}`;

    this.config = {
      port: config?.port || parseInt(process.env.PORT || '3000'),
      leaderElection: {
        lockKey: 'coordinator:leader:lock',
        lockTtlMs: 30000, // 30 seconds
        heartbeatIntervalMs: 10000, // 10 seconds (1/3 of TTL)
        instanceId,
        ...config?.leaderElection
      },
      consumerGroup: config?.consumerGroup || 'coordinator-group',
      consumerId: config?.consumerId || instanceId,
      // Standby configuration (ADR-007)
      isStandby: config?.isStandby ?? false,
      canBecomeLeader: config?.canBecomeLeader ?? true,
      regionId: config?.regionId,
      // FIX: Configurable constants with env var support
      maxOpportunities: config?.maxOpportunities ?? parseInt(process.env.MAX_OPPORTUNITIES || '1000'),
      opportunityTtlMs: config?.opportunityTtlMs ?? parseInt(process.env.OPPORTUNITY_TTL_MS || '60000'),
      opportunityCleanupIntervalMs: config?.opportunityCleanupIntervalMs ?? parseInt(process.env.OPPORTUNITY_CLEANUP_INTERVAL_MS || '10000'),
      pairTtlMs: config?.pairTtlMs ?? parseInt(process.env.PAIR_TTL_MS || '300000'),
      alertCooldownMs: config?.alertCooldownMs ?? parseInt(process.env.ALERT_COOLDOWN_MS || '300000')
    };

    // FIX: Initialize configurable constants from config
    this.MAX_OPPORTUNITIES = this.config.maxOpportunities!;
    this.OPPORTUNITY_TTL_MS = this.config.opportunityTtlMs!;
    this.OPPORTUNITY_CLEANUP_INTERVAL_MS = this.config.opportunityCleanupIntervalMs!;
    this.PAIR_TTL_MS = this.config.pairTtlMs!;

    // Define consumer groups for all streams we need to consume
    // Includes swap-events, volume-aggregates, and price-updates for analytics and monitoring
    this.consumerGroups = [
      {
        streamName: RedisStreamsClient.STREAMS.HEALTH,
        groupName: this.config.consumerGroup,
        consumerName: this.config.consumerId,
        startId: '$' // Only new messages
      },
      {
        streamName: RedisStreamsClient.STREAMS.OPPORTUNITIES,
        groupName: this.config.consumerGroup,
        consumerName: this.config.consumerId,
        startId: '$'
      },
      {
        streamName: RedisStreamsClient.STREAMS.WHALE_ALERTS,
        groupName: this.config.consumerGroup,
        consumerName: this.config.consumerId,
        startId: '$'
      },
      {
        streamName: RedisStreamsClient.STREAMS.SWAP_EVENTS,
        groupName: this.config.consumerGroup,
        consumerName: this.config.consumerId,
        startId: '$'
      },
      {
        streamName: RedisStreamsClient.STREAMS.VOLUME_AGGREGATES,
        groupName: this.config.consumerGroup,
        consumerName: this.config.consumerId,
        startId: '$'
      },
      // S3.3.5 FIX: Add PRICE_UPDATES consumer for Solana price feed integration
      {
        streamName: RedisStreamsClient.STREAMS.PRICE_UPDATES,
        groupName: this.config.consumerGroup,
        consumerName: this.config.consumerId,
        startId: '$'
      }
    ];

    // REFACTORED: Use extracted middleware and routes from api/ folder
    configureMiddleware(this.app, this.logger);
    this.setupRoutes(); // Logs auth status and calls setupAllRoutes
  }

  // ===========================================================================
  // Lifecycle Methods
  // ===========================================================================

  async start(port?: number): Promise<void> {
    const serverPort = port ?? this.config.port;

    // Use state manager to prevent concurrent starts (P0 fix)
    const result = await this.stateManager.executeStart(async () => {
      // Track start time for startup grace period
      this.startTime = Date.now();

      this.logger.info('Starting Coordinator Service', {
        instanceId: this.config.leaderElection.instanceId
      });

      // REFACTOR: Use injected dependencies for testability
      // Initialize Redis client (for legacy operations)
      this.redis = await this.deps.getRedisClient() as RedisClient;

      // Initialize Redis Streams client
      this.streamsClient = await this.deps.getRedisStreamsClient();

      // Create consumer groups for all streams
      await this.createConsumerGroups();

      // Configure StreamHealthMonitor to use our consumer group
      // This fixes the XPENDING errors when monitoring stream health
      const streamHealthMonitor = this.deps.getStreamHealthMonitor();
      streamHealthMonitor.setConsumerGroup(this.config.consumerGroup);

      // Try to acquire leadership
      await this.tryAcquireLeadership();

      // REFACTOR: Removed isRunning = true - stateManager.executeStart() handles state
      // The stateManager transitions to 'running' state after this callback completes

      // Start stream consumers (run even as standby for monitoring)
      // FIX: Await the async method for proper error handling
      await this.startStreamConsumers();

      // Start leader heartbeat
      this.startLeaderHeartbeat();

      // Start periodic health monitoring
      this.startHealthMonitoring();

      // REFACTOR: Start opportunity cleanup on separate interval (prevents race conditions)
      this.startOpportunityCleanup();

      // Start HTTP server
      this.server = this.app.listen(serverPort, () => {
        this.logger.info(`Coordinator dashboard available at http://localhost:${serverPort}`, {
          isLeader: this.isLeader
        });
      });

      // P2 FIX: Use proper Error type
      this.server.on('error', (error: Error) => {
        this.logger.error('HTTP server error', { error: error.message });
      });

      this.logger.info('Coordinator Service started successfully', {
        isLeader: this.isLeader,
        instanceId: this.config.leaderElection.instanceId
      });
    });

    if (!result.success) {
      this.logger.error('Failed to start Coordinator Service', { error: result.error });
      throw result.error;
    }
  }

  async stop(): Promise<void> {
    // Use state manager to prevent concurrent stops (P0 fix)
    const result = await this.stateManager.executeStop(async () => {
      this.logger.info('Stopping Coordinator Service');
      // REFACTOR: Removed isRunning = false - stateManager.executeStop() handles state
      // The stateManager transitions to 'stopping' immediately upon entering this callback

      // Release leadership if held
      if (this.isLeader) {
        await this.releaseLeadership();
      }

      // Stop all intervals and stream consumers
      await this.clearAllIntervals();

      // Close HTTP server gracefully
      if (this.server) {
        // P2 FIX: Capture server reference to satisfy TypeScript null check
        const serverRef = this.server;
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            this.logger.warn('Force closing HTTP server after timeout');
            resolve();
          }, 5000);

          serverRef.close(() => {
            clearTimeout(timeout);
            this.logger.info('HTTP server closed successfully');
            resolve();
          });
        });
        this.server = null;
      }

      // P0-NEW-6 FIX: Disconnect Redis Streams client with timeout
      if (this.streamsClient) {
        try {
          await Promise.race([
            this.streamsClient.disconnect(),
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error('Streams client disconnect timeout')), 5000)
            )
          ]);
        } catch (error) {
          this.logger.warn('Streams client disconnect timeout or error', { error: (error as Error).message });
        }
        this.streamsClient = null;
      }

      // P0-NEW-6 FIX: Disconnect legacy Redis with timeout
      if (this.redis) {
        try {
          await Promise.race([
            this.redis.disconnect(),
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error('Redis disconnect timeout')), 5000)
            )
          ]);
        } catch (error) {
          this.logger.warn('Redis disconnect timeout or error', { error: (error as Error).message });
        }
        this.redis = null;
      }

      // Clear collections
      this.serviceHealth.clear();
      this.alertCooldowns.clear();
      this.opportunities.clear();
      // P2-1 FIX: Reset stream error counter
      this.streamConsumerErrors = 0;

      this.logger.info('Coordinator Service stopped successfully');
    });

    if (!result.success) {
      this.logger.error('Error stopping Coordinator Service', { error: result.error });
    }
  }

  private async clearAllIntervals(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    if (this.metricsUpdateInterval) {
      clearInterval(this.metricsUpdateInterval);
      this.metricsUpdateInterval = null;
    }
    if (this.leaderHeartbeatInterval) {
      clearInterval(this.leaderHeartbeatInterval);
      this.leaderHeartbeatInterval = null;
    }
    // REFACTOR: Clear opportunity cleanup interval
    if (this.opportunityCleanupInterval) {
      clearInterval(this.opportunityCleanupInterval);
      this.opportunityCleanupInterval = null;
    }
    // Stop all stream consumers (replaces setInterval pattern)
    await Promise.all(this.streamConsumers.map(c => c.stop()));
    this.streamConsumers = [];
  }

  // ===========================================================================
  // Leader Election (ADR-007)
  // ===========================================================================

  private async tryAcquireLeadership(): Promise<boolean> {
    if (!this.redis) return false;

    // ADR-007: Respect standby configuration - don't acquire leadership if not allowed
    if (!this.config.canBecomeLeader) {
      this.logger.debug('Cannot become leader - canBecomeLeader is false');
      return false;
    }

    // ADR-007: Standby instances should not proactively acquire leadership
    // They wait for CrossRegionHealthManager to signal activation
    if (this.config.isStandby) {
      this.logger.debug('Standby instance - waiting for activation signal');
      return false;
    }

    try {
      const { lockKey, lockTtlMs, instanceId } = this.config.leaderElection;

      // Try to set the lock with NX (only if not exists)
      const acquired = await this.redis.setNx(lockKey, instanceId, Math.ceil(lockTtlMs / 1000));

      if (acquired) {
        this.isLeader = true;
        this.logger.info('Acquired leadership', { instanceId });
        return true;
      }

      // S4.1.1-FIX-1: Use atomic renewLockIfOwned instead of TOCTOU-prone get+expire
      // This atomically checks if we own the lock and extends TTL in one operation.
      // Eliminates race condition where lock could expire between get and expire calls.
      const renewed = await this.redis.renewLockIfOwned(
        lockKey,
        instanceId,
        Math.ceil(lockTtlMs / 1000)
      );
      if (renewed) {
        // We already held the lock and successfully renewed it
        this.isLeader = true;
        return true;
      }

      this.logger.info('Another instance is leader', { lockKey });
      return false;

    } catch (error) {
      this.logger.error('Failed to acquire leadership', { error });
      return false;
    }
  }

  /**
   * P0-NEW-5 FIX: Truly atomic lock renewal using Lua script.
   * Uses renewLockIfOwned() which atomically checks ownership and extends TTL.
   * This eliminates the TOCTOU race condition that existed before.
   *
   * Returns true if renewal succeeded, false if lock was lost.
   */
  private async renewLeaderLock(): Promise<boolean> {
    if (!this.redis) return false;

    const { lockKey, lockTtlMs, instanceId } = this.config.leaderElection;

    try {
      // P0-NEW-5 FIX: Use atomic Lua script for check-and-extend
      // This prevents the TOCTOU race where another instance could acquire
      // the lock between our GET and EXPIRE calls
      const renewed = await this.redis.renewLockIfOwned(
        lockKey,
        instanceId,
        Math.ceil(lockTtlMs / 1000)
      );
      return renewed;

    } catch (error) {
      this.logger.error('Failed to renew leader lock', { error });
      return false;
    }
  }

  /**
   * P0-NEW-5 FIX: Atomic lock release using Lua script.
   * Uses releaseLockIfOwned() which atomically checks ownership and deletes.
   * This prevents releasing a lock that was acquired by another instance.
   */
  private async releaseLeadership(): Promise<void> {
    if (!this.redis || !this.isLeader) return;

    try {
      const { lockKey, instanceId } = this.config.leaderElection;

      // P0-NEW-5 FIX: Use atomic Lua script for check-and-delete
      const released = await this.redis.releaseLockIfOwned(lockKey, instanceId);
      if (released) {
        this.logger.info('Released leadership', { instanceId });
      } else {
        this.logger.warn('Lock was not released - not owned by this instance', { instanceId });
      }

      this.isLeader = false;

    } catch (error) {
      this.logger.error('Failed to release leadership', { error });
    }
  }

  private startLeaderHeartbeat(): void {
    const { heartbeatIntervalMs, lockKey, lockTtlMs, instanceId } = this.config.leaderElection;
    let consecutiveHeartbeatFailures = 0;
    const maxHeartbeatFailures = 3;

    // S4.1.1-FIX-3: Add jitter to prevent thundering herd on leader failover
    // Random offset of ±2 seconds spreads leadership acquisition attempts across instances
    const jitterMs = Math.floor(Math.random() * 4000) - 2000; // Range: -2000 to +2000
    const effectiveInterval = Math.max(1000, heartbeatIntervalMs + jitterMs); // Minimum 1 second
    this.logger.debug('Leader heartbeat interval with jitter', {
      baseInterval: heartbeatIntervalMs,
      jitter: jitterMs,
      effectiveInterval
    });

    this.leaderHeartbeatInterval = setInterval(async () => {
      // P1-8 FIX: Use stateManager.isRunning() for consistency
      if (!this.stateManager.isRunning() || !this.redis) return;

      try {
        if (this.isLeader) {
          // P0-4 fix: Use dedicated renewal method for better encapsulation
          const renewed = await this.renewLeaderLock();
          if (renewed) {
            // P0-3 fix: Reset failure count on successful heartbeat
            consecutiveHeartbeatFailures = 0;
          } else {
            // Lost leadership (another instance took over or lock expired)
            this.isLeader = false;
            this.logger.warn('Lost leadership - lock renewal failed', { instanceId });
          }
        } else {
          // Try to acquire leadership
          await this.tryAcquireLeadership();
        }

      } catch (error) {
        // P0-3 fix: Track consecutive failures and demote if threshold exceeded
        consecutiveHeartbeatFailures++;
        this.logger.error('Leader heartbeat failed', {
          error,
          consecutiveFailures: consecutiveHeartbeatFailures,
          maxFailures: maxHeartbeatFailures,
          wasLeader: this.isLeader
        });

        // If we're the leader and have too many failures, demote self
        // This prevents a zombie leader scenario where we think we're leading
        // but can't actually renew our lock
        if (this.isLeader && consecutiveHeartbeatFailures >= maxHeartbeatFailures) {
          this.isLeader = false;
          this.logger.error('Demoting self from leader due to consecutive heartbeat failures', {
            failures: consecutiveHeartbeatFailures
          });

          // Send critical alert
          this.sendAlert({
            type: 'LEADER_DEMOTION',
            message: `Leader demoted due to ${consecutiveHeartbeatFailures} consecutive heartbeat failures`,
            severity: 'critical',
            data: { instanceId, failures: consecutiveHeartbeatFailures },
            timestamp: Date.now()
          });
        }
      }
    }, effectiveInterval); // S4.1.1-FIX-3: Use jittered interval
  }

  // ===========================================================================
  // Redis Streams Consumer Groups (ADR-002)
  // ===========================================================================

  private async createConsumerGroups(): Promise<void> {
    if (!this.streamsClient) return;

    for (const config of this.consumerGroups) {
      try {
        await this.streamsClient.createConsumerGroup(config);
        this.logger.info('Consumer group ready', {
          stream: config.streamName,
          group: config.groupName
        });
      } catch (error) {
        this.logger.error('Failed to create consumer group', {
          error,
          stream: config.streamName
        });
      }
    }
  }

  // P2-1 fix: Track stream consumer errors for health monitoring
  private streamConsumerErrors = 0;
  private readonly MAX_STREAM_ERRORS = 10;
  private alertSentForCurrentErrorBurst = false; // P1-NEW-2: Prevent duplicate alerts

  /**
   * Start stream consumers using blocking reads pattern.
   * Replaces setInterval polling for better latency and reduced Redis command usage.
   *
   * Benefits:
   * - Latency: <1ms vs ~50ms average with 100ms polling
   * - Redis commands: ~90% reduction (only call when messages exist)
   * - Architecture: Aligns with ADR-002 Redis Streams design
   */
  /**
   * FIX: Made async to properly await consumer.start() and catch initialization errors.
   * Previously, errors in consumer.start() were silently lost.
   */
  private async startStreamConsumers(): Promise<void> {
    if (!this.streamsClient) return;

    // Handler map for each stream
    const handlers: Record<string, (msg: StreamMessage) => Promise<void>> = {
      [RedisStreamsClient.STREAMS.HEALTH]: (msg) => this.handleHealthMessage(msg),
      [RedisStreamsClient.STREAMS.OPPORTUNITIES]: (msg) => this.handleOpportunityMessage(msg),
      [RedisStreamsClient.STREAMS.WHALE_ALERTS]: (msg) => this.handleWhaleAlertMessage(msg),
      [RedisStreamsClient.STREAMS.SWAP_EVENTS]: (msg) => this.handleSwapEventMessage(msg),
      [RedisStreamsClient.STREAMS.VOLUME_AGGREGATES]: (msg) => this.handleVolumeAggregateMessage(msg),
      // S3.3.5 FIX: Add price updates handler
      [RedisStreamsClient.STREAMS.PRICE_UPDATES]: (msg) => this.handlePriceUpdateMessage(msg)
    };

    // REFACTOR: Use injected StreamConsumer class for testability
    // Create a StreamConsumer for each consumer group
    const StreamConsumerClass = this.deps.StreamConsumer;
    for (const groupConfig of this.consumerGroups) {
      const handler = handlers[groupConfig.streamName];
      if (!handler) continue;

      const consumer = new StreamConsumerClass(this.streamsClient, {
        config: groupConfig,
        handler,
        batchSize: 10,
        blockMs: 1000, // Block for 1s - immediate delivery when messages arrive
        autoAck: true,
        logger: {
          error: (msg, ctx) => {
            this.logger.error(msg, ctx);
            this.trackStreamError(groupConfig.streamName);
          },
          debug: (msg, ctx) => this.logger.debug(msg, ctx)
        }
      });

      // FIX: Wrap start() in try-catch to catch synchronous initialization errors
      // Note: start() is synchronous but kicks off async polling loop internally
      try {
        consumer.start();
        this.streamConsumers.push(consumer);

        this.logger.info('Stream consumer started', {
          stream: groupConfig.streamName,
          blockMs: 1000
        });
      } catch (error) {
        this.logger.error('Failed to start stream consumer', {
          stream: groupConfig.streamName,
          error: (error as Error).message
        });
        // Continue starting other consumers - don't fail completely
      }
    }
  }

  /**
   * Track stream consumer errors and send alerts if threshold exceeded.
   * Preserves P2-1 and P1-NEW-2 error tracking behavior.
   */
  private trackStreamError(streamName: string): void {
    this.streamConsumerErrors++;

    // P1-NEW-2 FIX: Send critical alert only once per error burst
    if (this.streamConsumerErrors >= this.MAX_STREAM_ERRORS && !this.alertSentForCurrentErrorBurst) {
      this.sendAlert({
        type: 'STREAM_CONSUMER_FAILURE',
        message: `Stream consumer experienced ${this.streamConsumerErrors} errors on ${streamName}`,
        severity: 'critical',
        // S3.3.5 FIX: Include streamName in data for programmatic access
        data: { streamName, errorCount: this.streamConsumerErrors },
        timestamp: Date.now()
      });
      this.alertSentForCurrentErrorBurst = true;
    }
  }

  /**
   * Reset stream error tracking (called on successful processing).
   */
  private resetStreamErrors(): void {
    if (this.streamConsumerErrors > 0) {
      this.logger.debug('Stream consumer recovered', {
        previousErrors: this.streamConsumerErrors
      });
      this.streamConsumerErrors = 0;
      this.alertSentForCurrentErrorBurst = false;
    }
  }

  // ===========================================================================
  // Stream Message Handlers
  // ===========================================================================

  // P2 FIX: Use StreamMessage type instead of any
  private async handleHealthMessage(message: StreamMessage): Promise<void> {
    try {
      const data = message.data;
      // P3-2 FIX: Support both 'name' (new) and 'service' (legacy) field names
      const serviceName = data?.name ?? data?.service;
      if (!serviceName || typeof serviceName !== 'string') return;

      // P3-2 FIX: Validate status includes new 'starting' and 'stopping' states
      const statusValue = data.status;
      const validStatus: ServiceHealth['status'] =
        statusValue === 'healthy' || statusValue === 'degraded' || statusValue === 'unhealthy' ||
          statusValue === 'starting' || statusValue === 'stopping'
          ? statusValue
          : 'unhealthy'; // Default to unhealthy for unknown status

      // P3-2 FIX: Use unified ServiceHealth with 'name' field
      const health: ServiceHealth = {
        name: serviceName,
        status: validStatus,
        uptime: typeof data.uptime === 'number' ? data.uptime : 0,
        memoryUsage: typeof data.memoryUsage === 'number' ? data.memoryUsage : 0,
        cpuUsage: typeof data.cpuUsage === 'number' ? data.cpuUsage : 0,
        lastHeartbeat: typeof data.timestamp === 'number' ? data.timestamp : Date.now(),
        // P3-2: Include optional recovery tracking fields if present
        consecutiveFailures: typeof data.consecutiveFailures === 'number' ? data.consecutiveFailures : undefined,
        restartCount: typeof data.restartCount === 'number' ? data.restartCount : undefined
      };

      this.serviceHealth.set(serviceName, health);

      this.logger.debug('Health update received', {
        name: serviceName,
        status: health.status
      });

      // FIX: Reset stream errors on successful processing
      this.resetStreamErrors();

    } catch (error) {
      this.logger.error('Failed to handle health message', { error, message });
    }
  }

  // P1-1 fix: Maximum opportunities to track (prevents unbounded memory growth)
  // FIX: Now configurable via CoordinatorConfig
  private readonly MAX_OPPORTUNITIES: number;
  private readonly OPPORTUNITY_TTL_MS: number;
  private readonly OPPORTUNITY_CLEANUP_INTERVAL_MS: number;

  // P2 FIX: Use StreamMessage type instead of any
  private async handleOpportunityMessage(message: StreamMessage): Promise<void> {
    try {
      const data = message.data;
      // P2 FIX: Type guard for required id field
      if (!data || typeof data.id !== 'string') return;

      // P2 FIX: Create ArbitrageOpportunity with proper type safety
      const opportunity: ArbitrageOpportunity = {
        id: data.id,
        confidence: typeof data.confidence === 'number' ? data.confidence : 0,
        timestamp: typeof data.timestamp === 'number' ? data.timestamp : Date.now(),
        // Optional fields
        chain: typeof data.chain === 'string' ? data.chain : undefined,
        buyDex: typeof data.buyDex === 'string' ? data.buyDex : undefined,
        sellDex: typeof data.sellDex === 'string' ? data.sellDex : undefined,
        profitPercentage: typeof data.profitPercentage === 'number' ? data.profitPercentage : undefined,
        expiresAt: typeof data.expiresAt === 'number' ? data.expiresAt : undefined,
        status: typeof data.status === 'string' ? data.status as ArbitrageOpportunity['status'] : undefined
      };

      // Track opportunity (fast path - cleanup happens on separate interval)
      // REFACTOR: Removed inline cleanup to prevent race conditions with concurrent consumers
      this.opportunities.set(data.id, opportunity);
      this.systemMetrics.totalOpportunities++;
      this.systemMetrics.pendingOpportunities = this.opportunities.size;

      this.logger.info('Opportunity detected', {
        id: opportunity.id,
        chain: opportunity.chain,
        profitPercentage: opportunity.profitPercentage,
        buyDex: opportunity.buyDex,
        sellDex: opportunity.sellDex
      });

      // Only leader should forward to execution engine
      if (this.isLeader && opportunity.status === 'pending') {
        await this.forwardToExecutionEngine(opportunity);
      }

      // FIX: Reset stream errors on successful processing
      this.resetStreamErrors();

    } catch (error) {
      this.logger.error('Failed to handle opportunity message', { error, message });
    }
  }

  /**
   * REFACTOR: Extracted opportunity cleanup to prevent race conditions.
   *
   * This runs on a separate interval (every 10s) instead of on every message.
   * Benefits:
   * - Eliminates race condition where concurrent consumers could over-prune
   * - Faster message handling (no cleanup overhead per message)
   * - Predictable cleanup timing
   * - Follows Node.js best practice of batched background operations
   */
  private cleanupExpiredOpportunities(): void {
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
      if (opp.timestamp && (now - opp.timestamp) > this.OPPORTUNITY_TTL_MS) {
        toDelete.push(id);
      }
    }

    // Phase 2: Delete expired entries
    for (const id of toDelete) {
      this.opportunities.delete(id);
    }

    // Phase 3: Enforce size limit by removing oldest entries
    if (this.opportunities.size > this.MAX_OPPORTUNITIES) {
      const entries = Array.from(this.opportunities.entries())
        .sort((a, b) => (a[1].timestamp || 0) - (b[1].timestamp || 0));

      const removeCount = this.opportunities.size - this.MAX_OPPORTUNITIES;
      for (let i = 0; i < removeCount; i++) {
        this.opportunities.delete(entries[i][0]);
      }
    }

    // Update metrics
    this.systemMetrics.pendingOpportunities = this.opportunities.size;

    // Log if cleanup occurred
    const removed = initialSize - this.opportunities.size;
    if (removed > 0) {
      this.logger.debug('Opportunity cleanup completed', {
        removed,
        remaining: this.opportunities.size,
        expiredCount: toDelete.length
      });
    }
  }

  /**
   * Start the opportunity cleanup interval.
   * Runs every 10 seconds to clean up expired opportunities.
   */
  private startOpportunityCleanup(): void {
    this.opportunityCleanupInterval = setInterval(() => {
      if (!this.stateManager.isRunning()) return;

      try {
        this.cleanupExpiredOpportunities();
      } catch (error) {
        this.logger.error('Opportunity cleanup failed', { error });
      }
    }, this.OPPORTUNITY_CLEANUP_INTERVAL_MS);

    this.logger.info('Opportunity cleanup interval started', {
      intervalMs: this.OPPORTUNITY_CLEANUP_INTERVAL_MS,
      maxOpportunities: this.MAX_OPPORTUNITIES,
      ttlMs: this.OPPORTUNITY_TTL_MS
    });
  }

  // P2 FIX: Use StreamMessage type instead of any
  private async handleWhaleAlertMessage(message: StreamMessage): Promise<void> {
    try {
      const data = message.data;
      if (!data) return;

      this.systemMetrics.whaleAlerts++;

      // P2 FIX: Extract values with proper type checking
      const usdValue = typeof data.usdValue === 'number' ? data.usdValue : 0;
      const direction = typeof data.direction === 'string' ? data.direction : 'unknown';
      const chain = typeof data.chain === 'string' ? data.chain : 'unknown';

      this.logger.warn('Whale alert received', {
        address: data.address,
        usdValue,
        direction,
        chain,
        dex: data.dex,
        impact: data.impact
      });

      // Send alert notification
      this.sendAlert({
        type: 'WHALE_TRANSACTION',
        message: `Whale ${direction} detected: $${usdValue.toLocaleString()} on ${chain}`,
        severity: usdValue > 100000 ? 'critical' : 'high',
        data,
        timestamp: Date.now()
      });

      // FIX: Reset stream errors on successful processing
      this.resetStreamErrors();

    } catch (error) {
      this.logger.error('Failed to handle whale alert message', { error, message });
    }
  }

  // Track active pairs for volume monitoring (rolling window)
  private activePairs: Map<string, { lastSeen: number; chain: string; dex: string }> = new Map();
  // FIX: Now configurable via CoordinatorConfig (previously static)
  private readonly PAIR_TTL_MS: number;

  /**
   * Handle swap event messages from stream:swap-events.
   * Tracks swap activity for analytics and market monitoring.
   *
   * Note: Raw swap events are filtered by SwapEventFilter in detectors before publishing.
   * Only significant swaps (>$10 USD, deduplicated) reach this handler.
   */
  private async handleSwapEventMessage(message: StreamMessage): Promise<void> {
    try {
      const data = message.data as Record<string, unknown>;
      if (!data) return;

      // Extract swap event data with type checking
      // Handle wrapped MessageEvent (type='swap-event', data={...}) or direct SwapEvent
      const rawEvent = (data.data ?? data) as Record<string, unknown>;
      const pairAddress = typeof rawEvent.pairAddress === 'string' ? rawEvent.pairAddress : '';
      const chain = typeof rawEvent.chain === 'string' ? rawEvent.chain : 'unknown';
      const dex = typeof rawEvent.dex === 'string' ? rawEvent.dex : 'unknown';
      // Guard against negative values from malformed data
      const rawUsdValue = typeof rawEvent.usdValue === 'number' ? rawEvent.usdValue : 0;
      const usdValue = rawUsdValue >= 0 ? rawUsdValue : 0;

      if (!pairAddress) return;

      // Update metrics
      this.systemMetrics.totalSwapEvents++;
      this.systemMetrics.totalVolumeUsd += usdValue;

      // Track active pairs
      this.activePairs.set(pairAddress, {
        lastSeen: Date.now(),
        chain,
        dex
      });
      this.systemMetrics.activePairsTracked = this.activePairs.size;

      // Log significant swaps (whales are handled separately, this is for analytics)
      if (usdValue >= 10000) {
        this.logger.debug('Large swap event received', {
          pairAddress,
          chain,
          dex,
          usdValue,
          txHash: rawEvent.transactionHash
        });
      }

      // FIX: Reset stream errors on successful processing
      this.resetStreamErrors();

    } catch (error) {
      this.logger.error('Failed to handle swap event message', { error, message });
    }
  }

  /**
   * Handle volume aggregate messages from stream:volume-aggregates.
   * Processes 5-second aggregated volume data per pair for market monitoring.
   *
   * VolumeAggregate provides:
   * - swapCount: Number of swaps in window
   * - totalUsdVolume: Total USD value traded
   * - minPrice, maxPrice, avgPrice: Price statistics
   * - windowStartMs, windowEndMs: Time window boundaries
   */
  private async handleVolumeAggregateMessage(message: StreamMessage): Promise<void> {
    try {
      const data = message.data as Record<string, unknown>;
      if (!data) return;

      // Extract volume aggregate data with type checking
      // Handle wrapped MessageEvent (type='volume-aggregate', data={...}) or direct VolumeAggregate
      const rawAggregate = (data.data ?? data) as Record<string, unknown>;
      const pairAddress = typeof rawAggregate.pairAddress === 'string' ? rawAggregate.pairAddress : '';
      const chain = typeof rawAggregate.chain === 'string' ? rawAggregate.chain : 'unknown';
      const dex = typeof rawAggregate.dex === 'string' ? rawAggregate.dex : 'unknown';
      const swapCount = typeof rawAggregate.swapCount === 'number' ? rawAggregate.swapCount : 0;
      // Guard against negative values from malformed data
      const rawVolume = typeof rawAggregate.totalUsdVolume === 'number' ? rawAggregate.totalUsdVolume : 0;
      const totalUsdVolume = rawVolume >= 0 ? rawVolume : 0;

      if (!pairAddress) return;

      // Update metrics - always track aggregates, even if swapCount is 0
      // (swapCount=0 aggregates indicate monitored but quiet pairs)
      this.systemMetrics.volumeAggregatesProcessed++;

      // Track active pairs - any pair producing aggregates is active
      this.activePairs.set(pairAddress, {
        lastSeen: Date.now(),
        chain,
        dex
      });
      this.systemMetrics.activePairsTracked = this.activePairs.size;

      // Skip detailed logging for empty windows (no swaps in this 5s period)
      if (swapCount === 0) {
        this.resetStreamErrors();
        return;
      }

      // Log high-volume periods (potential trading opportunities)
      if (totalUsdVolume >= 50000) {
        this.logger.info('High volume aggregate detected', {
          pairAddress,
          chain,
          dex,
          swapCount,
          totalUsdVolume,
          avgPrice: rawAggregate.avgPrice
        });
      }

      // FIX: Reset stream errors on successful processing
      this.resetStreamErrors();

    } catch (error) {
      this.logger.error('Failed to handle volume aggregate message', { error, message });
    }
  }

  /**
   * Handle price update messages from stream:price-updates.
   * S3.3.5 FIX: Coordinator now consumes price updates for monitoring.
   *
   * Price updates contain:
   * - chain: Source blockchain (e.g., 'solana', 'ethereum')
   * - dex: DEX name (e.g., 'raydium', 'orca')
   * - pairKey: Trading pair identifier
   * - price: Current price
   * - timestamp: Update timestamp
   */
  private async handlePriceUpdateMessage(message: StreamMessage): Promise<void> {
    try {
      const data = message.data as Record<string, unknown>;
      if (!data) return;

      // Extract price update data with type checking
      // Handle wrapped MessageEvent (type='price-update', data={...}) or direct PriceUpdate
      const rawUpdate = (data.data ?? data) as Record<string, unknown>;
      const chain = typeof rawUpdate.chain === 'string' ? rawUpdate.chain : 'unknown';
      const dex = typeof rawUpdate.dex === 'string' ? rawUpdate.dex : 'unknown';
      const pairKey = typeof rawUpdate.pairKey === 'string' ? rawUpdate.pairKey : '';

      if (!pairKey) return;

      // Update metrics
      this.systemMetrics.priceUpdatesReceived++;

      // Track active pairs - any pair producing price updates is active
      this.activePairs.set(pairKey, {
        lastSeen: Date.now(),
        chain,
        dex
      });
      this.systemMetrics.activePairsTracked = this.activePairs.size;

      // FIX: Reset stream errors on successful processing
      this.resetStreamErrors();

    } catch (error) {
      this.logger.error('Failed to handle price update message', { error, message });
    }
  }

  /**
   * Cleanup stale entries from activePairs map.
   * Called periodically to prevent unbounded memory growth.
   */
  private cleanupActivePairs(): void {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [pairAddress, info] of this.activePairs) {
      if (now - info.lastSeen > this.PAIR_TTL_MS) {
        toDelete.push(pairAddress);
      }
    }

    for (const pairAddress of toDelete) {
      this.activePairs.delete(pairAddress);
    }

    this.systemMetrics.activePairsTracked = this.activePairs.size;

    if (toDelete.length > 0) {
      this.logger.debug('Cleaned up stale active pairs', {
        removed: toDelete.length,
        remaining: this.activePairs.size
      });
    }
  }

  /**
   * Forward a pending opportunity to the execution engine via Redis Streams.
   * FIX: Implemented actual stream publishing (was TODO stub).
   *
   * Only the leader coordinator should call this method to prevent
   * duplicate execution attempts.
   */
  private async forwardToExecutionEngine(opportunity: ArbitrageOpportunity): Promise<void> {
    if (!this.streamsClient) {
      this.logger.warn('Cannot forward opportunity - streams client not initialized', {
        id: opportunity.id
      });
      return;
    }

    try {
      // Publish to execution-requests stream for the execution engine to consume
      await this.streamsClient.xadd(
        RedisStreamsClient.STREAMS.EXECUTION_REQUESTS,
        {
          id: opportunity.id,
          type: opportunity.type || 'simple',
          chain: opportunity.chain || 'unknown',
          buyDex: opportunity.buyDex || '',
          sellDex: opportunity.sellDex || '',
          profitPercentage: opportunity.profitPercentage?.toString() || '0',
          confidence: opportunity.confidence?.toString() || '0',
          timestamp: opportunity.timestamp?.toString() || Date.now().toString(),
          expiresAt: opportunity.expiresAt?.toString() || '',
          // Include token info if available
          tokenIn: opportunity.tokenIn || '',
          tokenOut: opportunity.tokenOut || '',
          amountIn: opportunity.amountIn || '',
          // Source metadata
          forwardedBy: this.config.leaderElection.instanceId,
          forwardedAt: Date.now().toString()
        }
      );

      this.logger.info('Forwarded opportunity to execution engine', {
        id: opportunity.id,
        chain: opportunity.chain,
        profitPercentage: opportunity.profitPercentage
      });

      // Update metrics
      this.systemMetrics.totalExecutions++;

    } catch (error) {
      this.logger.error('Failed to forward opportunity to execution engine', {
        id: opportunity.id,
        error: (error as Error).message
      });

      // Send alert for execution forwarding failures
      this.sendAlert({
        type: 'EXECUTION_FORWARD_FAILED',
        message: `Failed to forward opportunity ${opportunity.id}: ${(error as Error).message}`,
        severity: 'high',
        data: { opportunityId: opportunity.id, chain: opportunity.chain },
        timestamp: Date.now()
      });
    }
  }

  // ===========================================================================
  // Metrics & Health
  // ===========================================================================

  private initializeMetrics(): SystemMetrics {
    return {
      totalOpportunities: 0,
      totalExecutions: 0,
      successfulExecutions: 0,
      totalProfit: 0,
      averageLatency: 0,
      averageMemory: 0,  // Added: tracked separately from latency
      systemHealth: 100,
      activeServices: 0,
      lastUpdate: Date.now(),
      whaleAlerts: 0,
      pendingOpportunities: 0,
      // Volume and swap event metrics (S1.2)
      totalSwapEvents: 0,
      totalVolumeUsd: 0,
      volumeAggregatesProcessed: 0,
      activePairsTracked: 0,
      // Price feed metrics (S3.3.5)
      priceUpdatesReceived: 0
    };
  }

  private startHealthMonitoring(): void {
    // Update metrics periodically
    this.metricsUpdateInterval = setInterval(async () => {
      // P1-8 FIX: Use stateManager.isRunning() for consistency
      if (!this.stateManager.isRunning()) return;

      try {
        this.updateSystemMetrics();
        this.checkForAlerts();

        // Report own health to stream
        await this.reportHealth();

      } catch (error) {
        this.logger.error('Metrics update failed', { error });
      }
    }, 5000);

    // Legacy health polling (fallback for services not yet on streams)
    this.healthCheckInterval = setInterval(async () => {
      // P1-8 FIX: Use stateManager.isRunning() for consistency
      if (!this.stateManager.isRunning() || !this.redis) return;

      try {
        const allHealth = await this.redis.getAllServiceHealth();
        for (const [serviceName, health] of Object.entries(allHealth)) {
          // Only update if we don't have recent stream data
          const existing = this.serviceHealth.get(serviceName);
          if (!existing || (Date.now() - existing.lastHeartbeat) > 30000) {
            this.serviceHealth.set(serviceName, health as ServiceHealth);
          }
        }

        // P2-3 FIX: Periodically cleanup stale alert cooldowns to prevent memory leak
        this.cleanupAlertCooldowns(Date.now());

        // Cleanup stale active pairs to prevent unbounded memory growth
        this.cleanupActivePairs();
      } catch (error) {
        this.logger.error('Legacy health polling failed', { error });
      }
    }, 10000);
  }

  private async reportHealth(): Promise<void> {
    // P1-8 FIX: Check running state before reporting
    if (!this.streamsClient || !this.stateManager.isRunning()) return;

    try {
      const health = {
        // P3-2 FIX: Use 'name' as primary field for consistency with handleHealthMessage
        name: 'coordinator',
        service: 'coordinator', // Keep for backwards compatibility
        // P1-8 FIX: Use stateManager.isRunning() for consistency
        status: this.stateManager.isRunning() ? 'healthy' : 'unhealthy',
        isLeader: this.isLeader,
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage().heapUsed,
        cpuUsage: 0,
        timestamp: Date.now(),
        metrics: {
          activeServices: this.systemMetrics.activeServices,
          totalOpportunities: this.systemMetrics.totalOpportunities,
          pendingOpportunities: this.systemMetrics.pendingOpportunities
        }
      };

      await this.streamsClient.xadd(RedisStreamsClient.STREAMS.HEALTH, health);

    } catch (error) {
      this.logger.error('Failed to report health', { error });
    }
  }

  private updateSystemMetrics(): void {
    const activeServices = Array.from(this.serviceHealth.values())
      .filter(health => health.status === 'healthy').length;

    const totalServices = Math.max(this.serviceHealth.size, 1);
    const systemHealth = (activeServices / totalServices) * 100;

    // Calculate average memory usage
    const avgMemory = Array.from(this.serviceHealth.values())
      .reduce((sum, health) => sum + (health.memoryUsage || 0), 0) / totalServices;

    // Calculate average latency from service health data
    // P1-5 fix: Fixed operator precedence - now correctly uses health.latency if available,
    // otherwise falls back to calculating from lastHeartbeat
    const avgLatency = Array.from(this.serviceHealth.values())
      .reduce((sum, health) => {
        // Use explicit latency if available, otherwise calculate from heartbeat
        const latency = health.latency ?? (health.lastHeartbeat ? Date.now() - health.lastHeartbeat : 0);
        return sum + latency;
      }, 0) / totalServices;

    this.systemMetrics.activeServices = activeServices;
    this.systemMetrics.systemHealth = systemHealth;
    this.systemMetrics.averageLatency = avgLatency; // FIX: Use actual latency, not memory
    this.systemMetrics.averageMemory = avgMemory;   // Track memory separately
    this.systemMetrics.lastUpdate = Date.now();
    this.systemMetrics.pendingOpportunities = this.opportunities.size;

    // FIX: Evaluate degradation level after updating metrics (ADR-007)
    this.evaluateDegradationLevel();
  }

  /**
   * FIX: Evaluate system degradation level per ADR-007.
   * Updates degradationLevel based on service health status.
   */
  private evaluateDegradationLevel(): void {
    const previousLevel = this.degradationLevel;

    // Check critical services
    const executorHealthy = this.isServiceHealthy('execution-engine');
    const hasHealthyDetectors = this.hasHealthyDetectors();
    const hasAnyServices = this.serviceHealth.size > 0;

    // Determine degradation level
    if (!hasAnyServices || this.systemMetrics.systemHealth === 0) {
      this.degradationLevel = DegradationLevel.COMPLETE_OUTAGE;
    } else if (!executorHealthy && !hasHealthyDetectors) {
      this.degradationLevel = DegradationLevel.READ_ONLY;
    } else if (!executorHealthy) {
      this.degradationLevel = DegradationLevel.DETECTION_ONLY;
    } else if (!this.hasAllDetectorsHealthy()) {
      this.degradationLevel = DegradationLevel.REDUCED_CHAINS;
    } else {
      this.degradationLevel = DegradationLevel.FULL_OPERATION;
    }

    // Log degradation level changes
    if (previousLevel !== this.degradationLevel) {
      this.logger.warn('Degradation level changed', {
        previous: DegradationLevel[previousLevel],
        current: DegradationLevel[this.degradationLevel],
        systemHealth: this.systemMetrics.systemHealth
      });
    }
  }

  /**
   * Check if a specific service is healthy.
   */
  private isServiceHealthy(serviceName: string): boolean {
    const health = this.serviceHealth.get(serviceName);
    return health?.status === 'healthy';
  }

  /**
   * Check if at least one detector is healthy.
   */
  private hasHealthyDetectors(): boolean {
    for (const [name, health] of this.serviceHealth) {
      if (name.includes('detector') && health.status === 'healthy') {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if all detectors are healthy.
   */
  private hasAllDetectorsHealthy(): boolean {
    let hasDetectors = false;
    for (const [name, health] of this.serviceHealth) {
      if (name.includes('detector')) {
        hasDetectors = true;
        if (health.status !== 'healthy') {
          return false;
        }
      }
    }
    return hasDetectors; // Return false if no detectors are reporting
  }

  /**
   * FIX: Get current degradation level (ADR-007).
   */
  getDegradationLevel(): DegradationLevel {
    return this.degradationLevel;
  }

  /**
   * Check for alerts and trigger notifications.
   * Respects startup grace period to avoid false alerts during initialization.
   */
  private checkForAlerts(): void {
    // P2 FIX: Use Alert type instead of any
    const alerts: Alert[] = [];
    const now = Date.now();

    // Check if we're still in the startup grace period
    const inGracePeriod = (now - this.startTime) < CoordinatorService.STARTUP_GRACE_PERIOD_MS;

    // Check service health
    for (const [serviceName, health] of this.serviceHealth) {
      // Skip 'starting' and 'stopping' status - these are transient states
      if (health.status !== 'healthy' && health.status !== 'starting' && health.status !== 'stopping') {
        alerts.push({
          type: 'SERVICE_UNHEALTHY',
          service: serviceName,
          message: `${serviceName} is ${health.status}`,
          severity: 'high',
          timestamp: now
        });
      }
    }

    // Check system metrics
    // During grace period: only alert if there are services AND health is low
    // After grace period: alert on any low health
    const shouldAlertLowHealth = inGracePeriod
      ? this.serviceHealth.size > 0 && this.systemMetrics.systemHealth < 80
      : this.systemMetrics.systemHealth < 80;

    if (shouldAlertLowHealth) {
      alerts.push({
        type: 'SYSTEM_HEALTH_LOW',
        message: `System health is ${this.systemMetrics.systemHealth.toFixed(1)}%`,
        severity: 'critical',
        timestamp: now
      });
    }

    // Send alerts (with cooldown)
    for (const alert of alerts) {
      this.sendAlert(alert);
    }
  }

  /**
   * P1-NEW-1 FIX: Send alert with cooldown and periodic cleanup
   * P2 FIX: Use Alert type for proper type safety
   */
  private sendAlert(alert: Alert): void {
    const alertKey = `${alert.type}_${alert.service || 'system'}`;
    const now = Date.now();
    const lastAlert = this.alertCooldowns.get(alertKey) || 0;
    // FIX: Use configurable cooldown instead of hardcoded 5 minutes
    const cooldownMs = this.config.alertCooldownMs!;

    // Cooldown for same alert type (configurable, default 5 minutes)
    if (now - lastAlert > cooldownMs) {
      this.logger.warn('Alert triggered', alert);
      this.alertCooldowns.set(alertKey, now);

      // P1-NEW-1 FIX: Periodic cleanup of stale cooldowns (every 100 alerts or 1000+ entries)
      if (this.alertCooldowns.size > 1000) {
        this.cleanupAlertCooldowns(now);
      }

      // TODO: Send to Discord/Telegram/email in production
    }
  }

  /**
   * P1-NEW-1 FIX: Clean up stale alert cooldown entries
   */
  private cleanupAlertCooldowns(now: number): void {
    const maxAge = 3600000; // 1 hour - remove cooldowns older than this
    const toDelete: string[] = [];

    for (const [key, timestamp] of this.alertCooldowns) {
      if (now - timestamp > maxAge) {
        toDelete.push(key);
      }
    }

    for (const key of toDelete) {
      this.alertCooldowns.delete(key);
    }

    if (toDelete.length > 0) {
      this.logger.debug('Cleaned up stale alert cooldowns', {
        removed: toDelete.length,
        remaining: this.alertCooldowns.size
      });
    }
  }

  // ===========================================================================
  // Express Routes Setup (REFACTORED - routes extracted to api/ folder)
  // ===========================================================================

  /**
   * Setup routes using extracted route modules.
   * Logs authentication status and delegates to setupAllRoutes.
   */
  private setupRoutes(): void {
    // Log authentication status on startup (defensive check for test environments)
    if (this.logger) {
      if (isAuthEnabled()) {
        this.logger.info('API authentication enabled');
      } else {
        this.logger.warn('API authentication NOT configured - endpoints are unprotected. Set JWT_SECRET or API_KEYS env vars for production.');
      }
    }

    // REFACTORED: Use extracted routes from api/routes/
    setupAllRoutes(this.app, this);
  }

  // ===========================================================================
  // CoordinatorStateProvider Interface Implementation
  // ===========================================================================

  getIsLeader(): boolean {
    return this.isLeader;
  }

  getInstanceId(): string {
    return this.config.leaderElection.instanceId;
  }

  getLockKey(): string {
    return this.config.leaderElection.lockKey;
  }

  getIsRunning(): boolean {
    // REFACTOR: stateManager is now the single source of truth for running state
    // Returns false if stateManager is not initialized (shouldn't happen in production)
    return this.stateManager?.isRunning() ?? false;
  }

  getServiceHealthMap(): Map<string, ServiceHealth> {
    return new Map(this.serviceHealth);
  }

  getSystemMetrics(): SystemMetrics {
    return { ...this.systemMetrics };
  }

  getOpportunities(): Map<string, ArbitrageOpportunity> {
    return new Map(this.opportunities);
  }

  getAlertCooldowns(): Map<string, number> {
    return new Map(this.alertCooldowns);
  }

  deleteAlertCooldown(key: string): boolean {
    return this.alertCooldowns.delete(key);
  }

  getLogger(): RouteLogger {
    return this.logger;
  }

  // ===========================================================================
  // Standby Configuration Getters (ADR-007)
  // ===========================================================================

  getIsStandby(): boolean {
    return this.config.isStandby ?? false;
  }

  getCanBecomeLeader(): boolean {
    return this.config.canBecomeLeader ?? true;
  }

  getRegionId(): string | undefined {
    return this.config.regionId;
  }

  /**
   * FIX: Updated to use Promise-based mutex check
   */
  getIsActivating(): boolean {
    return this.activationPromise !== null;
  }

  /**
   * Activate a standby coordinator to become the active leader.
   * This is called when CrossRegionHealthManager signals activation.
   *
   * @returns Promise<boolean> - true if activation succeeded
   */
  /**
   * FIX: Refactored to use Promise-based mutex pattern.
   * Previously used a boolean flag which had a race window between check and set.
   * Now uses activationPromise to ensure only one activation runs at a time.
   */
  async activateStandby(): Promise<boolean> {
    // Check if already leader
    if (this.isLeader) {
      this.logger.warn('Coordinator already leader, skipping activation');
      return true;
    }

    // FIX: Promise-based mutex - if activation is in progress, wait for it
    if (this.activationPromise) {
      this.logger.warn('Activation already in progress, waiting for result');
      return this.activationPromise;
    }

    if (!this.config.isStandby) {
      this.logger.warn('activateStandby called on non-standby instance');
      return false;
    }

    if (!this.config.canBecomeLeader) {
      this.logger.error('Cannot activate - canBecomeLeader is false');
      return false;
    }

    // FIX: Create and store the activation promise BEFORE any await
    // This ensures concurrent calls get the same promise
    this.activationPromise = this.doActivateStandby();

    try {
      return await this.activationPromise;
    } finally {
      // Clear the promise when done (success or failure)
      this.activationPromise = null;
    }
  }

  /**
   * Internal implementation of standby activation.
   * Separated to allow Promise-based mutex in activateStandby().
   */
  private async doActivateStandby(): Promise<boolean> {
    this.logger.warn('🚀 ACTIVATING STANDBY COORDINATOR', {
      instanceId: this.config.leaderElection.instanceId,
      regionId: this.config.regionId,
      previousIsLeader: this.isLeader
    });

    // Temporarily allow leadership acquisition
    const originalIsStandby = this.config.isStandby;
    this.config.isStandby = false;

    try {
      // Force attempt to acquire leadership
      const acquired = await this.tryAcquireLeadership();

      if (acquired) {
        this.logger.warn('✅ STANDBY COORDINATOR ACTIVATED - Now leader', {
          instanceId: this.config.leaderElection.instanceId,
          regionId: this.config.regionId
        });
        return true;
      } else {
        // Restore standby state if we couldn't acquire
        this.config.isStandby = originalIsStandby;
        this.logger.error('Failed to acquire leadership during activation');
        return false;
      }

    } catch (error) {
      this.config.isStandby = originalIsStandby;
      this.logger.error('Error during standby activation', { error });
      return false;
    }
  }
}
