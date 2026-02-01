/**
 * System Coordinator Service with Monitoring Dashboard
 *
 * Orchestrates all detector services and manages system health.
 * Uses Redis Streams for event consumption (ADR-002) and implements
 * leader election for failover (ADR-007).
 *
 * REFACTORED:
 * - Routes and middleware extracted to api/ folder
 * - R2: Leadership → leadership/ folder (LeadershipElectionService)
 * - R2: Streaming → streaming/ folder (StreamConsumerManager, StreamRateLimiter)
 * - R2: Health monitoring → health/ folder (HealthMonitor)
 * - R2: Opportunities → opportunities/ folder (OpportunityRouter)
 *
 * @see ARCHITECTURE_V2.md Section 4.5 (Layer 5: Coordination)
 * @see ADR-002: Redis Streams over Pub/Sub
 * @see ADR-007: Failover Strategy
 * @see api/ folder for extracted routes and middleware
 * @see streaming/ folder for stream consumer management
 * @see health/ folder for health monitoring
 * @see opportunities/ folder for opportunity routing
 * @see leadership/ folder for leader election
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
  getStreamHealthMonitor,
  // R7 Consolidation: Use shared SimpleCircuitBreaker instead of inline implementation
  SimpleCircuitBreaker
} from '@arbitrage/core';
import type { ServiceHealth, ArbitrageOpportunity } from '@arbitrage/types';
import { isAuthEnabled } from '@shared/security';

// Import extracted API modules
// FIX: Import Logger and Alert from consolidated api/types (single source of truth)
import {
  configureMiddleware,
  setupAllRoutes,
  SystemMetrics,
  CoordinatorStateProvider,
  RouteLogger,
  Logger,
  Alert
} from './api';

// Import alert notification system
import { AlertNotifier } from './alerts';

// Import type guard utilities and collections
import {
  getString,
  getNumber,
  getNonNegativeNumber,
  getOptionalString,
  getOptionalNumber,
  unwrapMessageData,
  hasRequiredString,
  findKSmallest
} from './utils';

// R2: Import extracted subsystem modules
import { StreamConsumerManager, StreamRateLimiter } from './streaming';
import { HealthMonitor, DegradationLevel } from './health';
import { OpportunityRouter } from './opportunities';

// =============================================================================
// Service Name Patterns (FIX 3.2: Configurable instead of hardcoded)
// =============================================================================

/**
 * Service name patterns for degradation level evaluation.
 * FIX 3.2: Extracted from hardcoded checks to enable configuration.
 *
 * These patterns are used to identify service types without coupling
 * the coordinator to specific naming conventions.
 */
export const SERVICE_NAME_PATTERNS = {
  /** Pattern to match execution engine service name */
  EXECUTION_ENGINE: 'execution-engine',
  /** Pattern to identify detector services (contains 'detector') */
  DETECTOR_PATTERN: 'detector',
  /** Pattern to identify cross-chain services */
  CROSS_CHAIN_PATTERN: 'cross-chain',
} as const;

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
 * R2: Re-exported from health/ module for backward compatibility.
 * @see health/health-monitor.ts for implementation
 */
export { DegradationLevel } from './health';

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
  // FIX: Option to disable legacy Redis polling (all services use streams now)
  enableLegacyHealthPolling?: boolean; // Default: false (streams-only mode)
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

// FIX: Alert type is now imported from ./api (consolidated single source of truth)
// The imported Alert uses Record<string, unknown> for data field for flexibility

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
  // FIX 5.5: Track activation state separately from config to avoid concurrent reads of modified config
  // During activation, this is true and bypasses standby checks without modifying config.isStandby
  private isActivating = false;
  private serviceHealth: Map<string, ServiceHealth> = new Map();
  private systemMetrics: SystemMetrics;
  // FIX: Track degradation level per ADR-007
  private degradationLevel: DegradationLevel = DegradationLevel.FULL_OPERATION;
  private alertCooldowns: Map<string, number> = new Map();
  private opportunities: Map<string, ArbitrageOpportunity> = new Map();
  // FIX: Alert notifier for sending alerts to Discord/Slack
  private alertNotifier: AlertNotifier | null = null;

  // FIX P2: Circuit breaker for execution forwarding
  // Prevents hammering the execution stream when it's down
  // R7 Consolidation: Now uses shared SimpleCircuitBreaker from @arbitrage/core
  private executionCircuitBreaker = new SimpleCircuitBreaker(
    5,     // threshold: Open after 5 consecutive failures
    60000  // resetTimeoutMs: Try again after 1 minute
  );

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
  // FIX P1: Dedicated interval for general cleanup operations (activePairs, alertCooldowns)
  // This runs independently of legacy health polling mode
  private generalCleanupInterval: NodeJS.Timeout | null = null;

  // Stream consumers (blocking read pattern - replaces setInterval polling)
  private streamConsumers: StreamConsumer[] = [];

  // Configuration
  private readonly config: CoordinatorConfig;

  // Consumer group configs for streams
  private readonly consumerGroups: ConsumerGroupConfig[];

  // P0-FIX 1.2: Dead Letter Queue stream for failed messages
  // Messages that fail processing are moved here for manual investigation/replay
  private static readonly DLQ_STREAM = 'stream:dead-letter-queue';

  // P0-FIX 1.3: Pending message recovery configuration
  // Messages idle longer than this are considered orphaned and will be reclaimed
  private static readonly PENDING_MESSAGE_IDLE_THRESHOLD_MS = 60000; // 1 minute

  // REFACTOR: Store injected dependencies for use in start() and other methods
  // This enables proper testing without Jest mock hoisting issues
  private readonly deps: Required<CoordinatorDependencies>;

  // R2: Extracted subsystem modules
  // These modules encapsulate specific responsibilities for better testability and maintainability
  private streamConsumerManager: StreamConsumerManager | null = null;
  private healthMonitor: HealthMonitor | null = null;
  private opportunityRouter: OpportunityRouter | null = null;

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
      // FIX Config 3.2: Environment-aware alert cooldown
      // Development: 30 seconds (faster feedback cycle)
      // Production: 5 minutes (prevent alert spam)
      alertCooldownMs: config?.alertCooldownMs ?? parseInt(
        process.env.ALERT_COOLDOWN_MS ||
        (process.env.NODE_ENV === 'development' ? '30000' : '300000')
      ),
      // FIX: Legacy polling disabled by default - all services now use streams
      enableLegacyHealthPolling: config?.enableLegacyHealthPolling ?? (process.env.ENABLE_LEGACY_HEALTH_POLLING === 'true')
    };

    // FIX: Initialize configurable constants from config
    this.MAX_OPPORTUNITIES = this.config.maxOpportunities!;
    this.OPPORTUNITY_TTL_MS = this.config.opportunityTtlMs!;
    this.OPPORTUNITY_CLEANUP_INTERVAL_MS = this.config.opportunityCleanupIntervalMs!;
    this.PAIR_TTL_MS = this.config.pairTtlMs!;

    // FIX: Initialize alert notifier for sending alerts to external channels
    this.alertNotifier = new AlertNotifier(this.logger);

    // R2: Initialize extracted subsystem modules
    // Note: streamConsumerManager and opportunityRouter are initialized in start()
    // after streamsClient is available
    this.healthMonitor = new HealthMonitor(
      this.logger,
      (alert) => this.sendAlert(alert),
      {
        startupGracePeriodMs: CoordinatorService.STARTUP_GRACE_PERIOD_MS,
        alertCooldownMs: this.config.alertCooldownMs,
        servicePatterns: {
          executionEngine: SERVICE_NAME_PATTERNS.EXECUTION_ENGINE,
          detectorPattern: SERVICE_NAME_PATTERNS.DETECTOR_PATTERN,
          crossChainPattern: SERVICE_NAME_PATTERNS.CROSS_CHAIN_PATTERN,
        },
      }
    );

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

      // R2: Initialize stream consumer manager after streams client is available
      this.streamConsumerManager = new StreamConsumerManager(
        this.streamsClient,
        this.logger,
        {
          maxStreamErrors: this.MAX_STREAM_ERRORS,
          dlqStream: CoordinatorService.DLQ_STREAM,
          instanceId: this.config.leaderElection.instanceId,
        },
        (alert) => this.sendAlert({
          type: alert.type,
          message: alert.message,
          severity: alert.severity,
          data: alert.data,
          timestamp: alert.timestamp,
        })
      );

      // R2: Initialize opportunity router after streams client is available
      this.opportunityRouter = new OpportunityRouter(
        this.logger,
        this.executionCircuitBreaker,
        this.streamsClient,
        {
          maxOpportunities: this.MAX_OPPORTUNITIES,
          opportunityTtlMs: this.OPPORTUNITY_TTL_MS,
          instanceId: this.config.leaderElection.instanceId,
          executionRequestsStream: RedisStreamsClient.STREAMS.EXECUTION_REQUESTS,
        },
        (alert) => this.sendAlert({
          type: alert.type,
          message: alert.message,
          severity: alert.severity,
          data: alert.data,
          timestamp: alert.timestamp,
        })
      );

      // R2: Start health monitor (records start time for grace period)
      this.healthMonitor?.start();

      // Create consumer groups for all streams
      await this.createConsumerGroups();

      // P0-FIX 1.3: Recover pending messages from previous coordinator instance
      // This handles messages that were being processed when the previous instance crashed
      await this.recoverPendingMessages();

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
      // FIX: Properly serialize Error object for logging
      this.logger.error('Failed to start Coordinator Service', {
        error: result.error instanceof Error ? result.error.message : String(result.error),
        stack: result.error instanceof Error ? result.error.stack : undefined,
      });
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
      // FIX: Clear activePairs to prevent stale data on restart
      this.activePairs.clear();
      // P2-1 FIX: Reset stream error counter
      this.streamConsumerErrors = 0;

      this.logger.info('Coordinator Service stopped successfully');
    });

    if (!result.success) {
      // FIX: Properly serialize Error object for logging (Error properties aren't enumerable)
      this.logger.error('Error stopping Coordinator Service', {
        error: result.error instanceof Error ? result.error.message : String(result.error),
        stack: result.error instanceof Error ? result.error.stack : undefined,
      });
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
    // FIX P1: Clear general cleanup interval
    if (this.generalCleanupInterval) {
      clearInterval(this.generalCleanupInterval);
      this.generalCleanupInterval = null;
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
    // FIX 5.5: Check isActivating flag to allow activation to proceed
    if (this.config.isStandby && !this.isActivating) {
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

    // FIX 7.3: Ensure EXECUTION_REQUESTS stream exists for publishing
    //
    // The coordinator publishes to EXECUTION_REQUESTS but doesn't consume from it,
    // so we can't use XGROUP CREATE ... MKSTREAM (which only works for consumer groups).
    //
    // Approaches considered:
    // 1. Dummy message (current) - Simple, works reliably, message is harmless
    // 2. XADD with NOMKSTREAM check - Requires extra call, not cleaner
    // 3. Redis XINFO STREAM - Would need error handling for non-existent stream
    //
    // The dummy message approach is standard practice for publish-only streams.
    // The execution-engine will skip 'stream-init' type messages.
    try {
      await this.streamsClient.xadd(
        RedisStreamsClient.STREAMS.EXECUTION_REQUESTS,
        {
          type: 'stream-init',
          message: 'Coordinator stream initialization - safe to ignore',
          timestamp: Date.now().toString()
        }
      );
      this.logger.info('Execution requests stream initialized', {
        stream: RedisStreamsClient.STREAMS.EXECUTION_REQUESTS
      });
    } catch (error) {
      this.logger.warn('Failed to initialize execution requests stream', {
        error,
        stream: RedisStreamsClient.STREAMS.EXECUTION_REQUESTS
      });
    }
  }

  // P2-1 fix: Track stream consumer errors for health monitoring
  private streamConsumerErrors = 0;
  private readonly MAX_STREAM_ERRORS = 10;
  private alertSentForCurrentErrorBurst = false; // P1-NEW-2: Prevent duplicate alerts
  // FIX Race 5.3: Use atomic flag-and-send pattern to prevent race between check and set
  private sendingStreamErrorAlert = false;

  // FIX P1 + R12: Rate limiting for stream message processing
  // Uses shared StreamRateLimiter class (R12 consolidation - removed duplicate inline implementation)
  private readonly streamRateLimiter = new StreamRateLimiter({
    maxTokens: 1000,        // Max messages per refill period
    refillMs: 1000,         // Refill period (1 second)
    tokensPerMessage: 1,    // Cost per message
  });

  /**
   * FIX P1: Wrap a message handler with rate limiting.
   * Uses shared StreamRateLimiter class (R12 consolidation).
   */
  private withRateLimit(
    streamName: string,
    handler: (msg: StreamMessage) => Promise<void>
  ): (msg: StreamMessage) => Promise<void> {
    return async (msg: StreamMessage) => {
      if (!this.streamRateLimiter.checkRateLimit(streamName)) {
        this.logger.warn('Rate limit exceeded, dropping message', {
          stream: streamName,
          messageId: msg.id
        });
        return;
      }
      return handler(msg);
    };
  }

  /**
   * P0-FIX 1.2: Wrap a message handler with deferred acknowledgment and DLQ support.
   *
   * This replaces autoAck: true with manual ACK after successful processing.
   * Failed messages are moved to DLQ before ACK to prevent data loss.
   *
   * Flow:
   * 1. Call handler with message
   * 2. On success: ACK the message
   * 3. On failure: Move to DLQ, then ACK (prevents infinite retries)
   */
  private withDeferredAck(
    groupConfig: ConsumerGroupConfig,
    handler: (msg: StreamMessage) => Promise<void>
  ): (msg: StreamMessage) => Promise<void> {
    return async (msg: StreamMessage) => {
      try {
        await handler(msg);
        // Success: ACK the message
        await this.ackMessage(groupConfig, msg.id);
      } catch (error) {
        // Failure: Move to DLQ, then ACK to prevent infinite retries
        this.logger.error('Message handler failed, moving to DLQ', {
          stream: groupConfig.streamName,
          messageId: msg.id,
          error: (error as Error).message
        });
        await this.moveToDeadLetterQueue(msg, error as Error, groupConfig.streamName);
        await this.ackMessage(groupConfig, msg.id);
      }
    };
  }

  /**
   * P0-FIX 1.2: Acknowledge a message after processing.
   */
  private async ackMessage(groupConfig: ConsumerGroupConfig, messageId: string): Promise<void> {
    if (!this.streamsClient) return;

    try {
      await this.streamsClient.xack(groupConfig.streamName, groupConfig.groupName, messageId);
    } catch (error) {
      this.logger.error('Failed to ACK message', {
        stream: groupConfig.streamName,
        messageId,
        error: (error as Error).message
      });
    }
  }

  /**
   * P0-FIX 1.2: Move a failed message to the Dead Letter Queue.
   *
   * DLQ entries include:
   * - Original message data
   * - Error details
   * - Source stream for replay
   * - Timestamp for TTL-based cleanup
   */
  private async moveToDeadLetterQueue(
    message: StreamMessage,
    error: Error,
    sourceStream: string
  ): Promise<void> {
    if (!this.streamsClient) return;

    try {
      await this.streamsClient.xadd(CoordinatorService.DLQ_STREAM, {
        originalMessageId: message.id,
        originalStream: sourceStream,
        originalData: JSON.stringify(message.data),
        error: error.message,
        errorStack: error.stack?.substring(0, 500), // Truncate stack trace
        timestamp: Date.now(),
        service: 'coordinator',
        instanceId: this.config.leaderElection.instanceId
      });

      this.logger.debug('Message moved to DLQ', {
        originalMessageId: message.id,
        sourceStream
      });
    } catch (dlqError) {
      // If DLQ write fails, log but don't throw - we still want to ACK the original message
      // to prevent infinite retry loops
      this.logger.error('Failed to move message to DLQ', {
        originalMessageId: message.id,
        sourceStream,
        dlqError: (dlqError as Error).message
      });
    }
  }

  /**
   * P0-FIX 1.3: Check for and log pending messages from previous coordinator instance.
   *
   * When coordinator crashes mid-processing, messages remain in XPENDING.
   * This method logs their presence - they will be automatically redelivered
   * by Redis Streams to this consumer when it starts reading.
   *
   * Note: Redis Streams automatically handles redelivery of pending messages
   * to consumers in the same group. When we call xreadgroup with '>',
   * pending messages assigned to this consumer are automatically included.
   *
   * Called during startup after consumer groups are created.
   */
  private async recoverPendingMessages(): Promise<void> {
    if (!this.streamsClient) return;

    for (const groupConfig of this.consumerGroups) {
      try {
        // Get pending messages summary
        const pendingInfo = await this.streamsClient.xpending(
          groupConfig.streamName,
          groupConfig.groupName
        );

        if (!pendingInfo || pendingInfo.total === 0) {
          continue;
        }

        // Log pending messages for observability
        // These will be automatically redelivered by Redis when the consumer starts
        this.logger.warn('Found pending messages from previous instance', {
          stream: groupConfig.streamName,
          pendingCount: pendingInfo.total,
          smallestId: pendingInfo.smallestId,
          largestId: pendingInfo.largestId,
          consumers: pendingInfo.consumers
        });

        // Find pending messages for THIS consumer (if any)
        const ourPending = pendingInfo.consumers.find(
          c => c.name === groupConfig.consumerName
        );
        if (ourPending && ourPending.pending > 0) {
          this.logger.info('This consumer has pending messages to process', {
            stream: groupConfig.streamName,
            pendingForUs: ourPending.pending
          });
        }
      } catch (error) {
        this.logger.error('Failed to check pending messages', {
          stream: groupConfig.streamName,
          error: (error as Error).message
        });
        // Continue with other streams even if one fails
      }
    }
  }

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
    // FIX P1: All handlers are wrapped with rate limiting to prevent DoS attacks
    const handlers: Record<string, (msg: StreamMessage) => Promise<void>> = {
      [RedisStreamsClient.STREAMS.HEALTH]: this.withRateLimit(
        RedisStreamsClient.STREAMS.HEALTH,
        (msg) => this.handleHealthMessage(msg)
      ),
      [RedisStreamsClient.STREAMS.OPPORTUNITIES]: this.withRateLimit(
        RedisStreamsClient.STREAMS.OPPORTUNITIES,
        (msg) => this.handleOpportunityMessage(msg)
      ),
      [RedisStreamsClient.STREAMS.WHALE_ALERTS]: this.withRateLimit(
        RedisStreamsClient.STREAMS.WHALE_ALERTS,
        (msg) => this.handleWhaleAlertMessage(msg)
      ),
      [RedisStreamsClient.STREAMS.SWAP_EVENTS]: this.withRateLimit(
        RedisStreamsClient.STREAMS.SWAP_EVENTS,
        (msg) => this.handleSwapEventMessage(msg)
      ),
      [RedisStreamsClient.STREAMS.VOLUME_AGGREGATES]: this.withRateLimit(
        RedisStreamsClient.STREAMS.VOLUME_AGGREGATES,
        (msg) => this.handleVolumeAggregateMessage(msg)
      ),
      // S3.3.5 FIX: Add price updates handler
      [RedisStreamsClient.STREAMS.PRICE_UPDATES]: this.withRateLimit(
        RedisStreamsClient.STREAMS.PRICE_UPDATES,
        (msg) => this.handlePriceUpdateMessage(msg)
      )
    };

    // REFACTOR: Use injected StreamConsumer class for testability
    // Create a StreamConsumer for each consumer group
    const StreamConsumerClass = this.deps.StreamConsumer;
    for (const groupConfig of this.consumerGroups) {
      const rateLimitedHandler = handlers[groupConfig.streamName];
      if (!rateLimitedHandler) continue;

      // P0-FIX 1.2: Wrap handler with deferred ACK and DLQ support
      // This replaces autoAck: true, ensuring failed messages go to DLQ
      const deferredAckHandler = this.withDeferredAck(groupConfig, rateLimitedHandler);

      const consumer = new StreamConsumerClass(this.streamsClient, {
        config: groupConfig,
        handler: deferredAckHandler,
        batchSize: 10,
        blockMs: 1000, // Block for 1s - immediate delivery when messages arrive
        autoAck: false, // P0-FIX 1.2: Deferred ACK - we handle ACK in withDeferredAck
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
   * FIX Race 5.3: Uses atomic flag pattern to prevent duplicate alerts from concurrent calls.
   */
  private trackStreamError(streamName: string): void {
    this.streamConsumerErrors++;

    // FIX Race 5.3: Check and set alert flag atomically using sendingStreamErrorAlert
    // This prevents multiple concurrent consumers from all passing the check before any sets the flag
    if (this.streamConsumerErrors >= this.MAX_STREAM_ERRORS &&
        !this.alertSentForCurrentErrorBurst &&
        !this.sendingStreamErrorAlert) {
      // Set sending flag FIRST (synchronously) before any async work
      this.sendingStreamErrorAlert = true;

      this.sendAlert({
        type: 'STREAM_CONSUMER_FAILURE',
        message: `Stream consumer experienced ${this.streamConsumerErrors} errors on ${streamName}`,
        severity: 'critical',
        // S3.3.5 FIX: Include streamName in data for programmatic access
        data: { streamName, errorCount: this.streamConsumerErrors },
        timestamp: Date.now()
      });

      // Set permanent flag after sending (prevents retries)
      this.alertSentForCurrentErrorBurst = true;
      this.sendingStreamErrorAlert = false;
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
      const serviceName = getString(data as Record<string, unknown>, 'name', '') ||
                          getString(data as Record<string, unknown>, 'service', '');
      if (!serviceName) {
        // FIX: Log debug warning for invalid messages instead of silent skip
        this.logger.debug('Skipping health message - missing service name', {
          messageId: message.id,
          hasName: 'name' in (data || {}),
          hasService: 'service' in (data || {})
        });
        return;
      }

      // P3-2 FIX: Validate status includes new 'starting' and 'stopping' states
      const typedData = data as Record<string, unknown>;
      const statusValue = getString(typedData, 'status', '');
      const validStatus: ServiceHealth['status'] =
        statusValue === 'healthy' || statusValue === 'degraded' || statusValue === 'unhealthy' ||
          statusValue === 'starting' || statusValue === 'stopping'
          ? statusValue
          : 'unhealthy'; // Default to unhealthy for unknown status

      // FIX: Use type guard utilities for cleaner extraction
      const health: ServiceHealth = {
        name: serviceName,
        status: validStatus,
        uptime: getNonNegativeNumber(typedData, 'uptime', 0),
        memoryUsage: getNonNegativeNumber(typedData, 'memoryUsage', 0),
        cpuUsage: getNonNegativeNumber(typedData, 'cpuUsage', 0),
        lastHeartbeat: getNumber(typedData, 'timestamp', Date.now()),
        // P3-2: Include optional recovery tracking fields if present
        consecutiveFailures: getOptionalNumber(typedData, 'consecutiveFailures'),
        restartCount: getOptionalNumber(typedData, 'restartCount')
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
  // R2: Delegates to OpportunityRouter for processing
  private async handleOpportunityMessage(message: StreamMessage): Promise<void> {
    try {
      const data = message.data as Record<string, unknown>;

      // R2: Delegate to opportunity router
      if (this.opportunityRouter) {
        const processed = await this.opportunityRouter.processOpportunity(data, this.isLeader);
        if (processed) {
          // Update local metrics from router
          this.systemMetrics.totalOpportunities = this.opportunityRouter.getTotalOpportunities();
          this.systemMetrics.pendingOpportunities = this.opportunityRouter.getPendingCount();
          this.systemMetrics.totalExecutions = this.opportunityRouter.getTotalExecutions();
        }
        this.resetStreamErrors();
        return;
      }

      // Fallback for tests without opportunity router
      if (!hasRequiredString(data, 'id')) {
        this.logger.debug('Skipping opportunity message - missing or invalid id', {
          messageId: message.id
        });
        return;
      }

      const opportunityId = getString(data, 'id');
      const opportunityTimestamp = getNumber(data, 'timestamp', Date.now());

      const existing = this.opportunities.get(opportunityId);
      if (existing && Math.abs((existing.timestamp || 0) - opportunityTimestamp) < 5000) {
        this.logger.debug('Duplicate opportunity detected, skipping', {
          id: opportunityId,
          existingTimestamp: existing.timestamp,
          newTimestamp: opportunityTimestamp
        });
        this.resetStreamErrors();
        return;
      }

      let profitPercentage = getOptionalNumber(data, 'profitPercentage');
      if (profitPercentage !== undefined) {
        if (profitPercentage < -100 || profitPercentage > 10000) {
          this.logger.warn('Invalid profit percentage, rejecting opportunity', {
            id: opportunityId,
            profitPercentage,
            reason: profitPercentage < -100 ? 'below_minimum' : 'above_maximum'
          });
          this.resetStreamErrors();
          return;
        }
      }

      const opportunity: ArbitrageOpportunity = {
        id: opportunityId,
        confidence: getNumber(data, 'confidence', 0),
        timestamp: opportunityTimestamp,
        chain: getOptionalString(data, 'chain'),
        buyDex: getOptionalString(data, 'buyDex'),
        sellDex: getOptionalString(data, 'sellDex'),
        profitPercentage,
        expiresAt: getOptionalNumber(data, 'expiresAt'),
        status: getOptionalString(data, 'status') as ArbitrageOpportunity['status'] | undefined
      };

      this.opportunities.set(opportunity.id, opportunity);
      this.systemMetrics.totalOpportunities++;
      this.systemMetrics.pendingOpportunities = this.opportunities.size;

      this.logger.info('Opportunity detected', {
        id: opportunity.id,
        chain: opportunity.chain,
        profitPercentage: opportunity.profitPercentage,
        buyDex: opportunity.buyDex,
        sellDex: opportunity.sellDex
      });

      if (this.isLeader && (opportunity.status === 'pending' || opportunity.status === undefined)) {
        await this.forwardToExecutionEngine(opportunity);
      }

      this.resetStreamErrors();

    } catch (error) {
      this.logger.error('Failed to handle opportunity message', { error, message });
    }
  }

  /**
   * REFACTOR: Extracted opportunity cleanup to prevent race conditions.
   * R2: Delegates to OpportunityRouter for cleanup.
   */
  private cleanupExpiredOpportunities(): void {
    // R2: Delegate to opportunity router
    if (this.opportunityRouter) {
      this.opportunityRouter.cleanupExpiredOpportunities();
      this.systemMetrics.pendingOpportunities = this.opportunityRouter.getPendingCount();
      return;
    }

    // Fallback for tests without opportunity router
    const now = Date.now();
    const toDelete: string[] = [];
    const initialSize = this.opportunities.size;

    for (const [id, opp] of this.opportunities) {
      if (opp.expiresAt && opp.expiresAt < now) {
        toDelete.push(id);
        continue;
      }
      if (opp.timestamp && (now - opp.timestamp) > this.OPPORTUNITY_TTL_MS) {
        toDelete.push(id);
      }
    }

    for (const id of toDelete) {
      this.opportunities.delete(id);
    }

    if (this.opportunities.size > this.MAX_OPPORTUNITIES) {
      const removeCount = this.opportunities.size - this.MAX_OPPORTUNITIES;
      const oldestK = findKSmallest(
        this.opportunities.entries(),
        removeCount,
        ([, a], [, b]) => (a.timestamp || 0) - (b.timestamp || 0)
      );
      for (const [id] of oldestK) {
        this.opportunities.delete(id);
      }
    }

    this.systemMetrics.pendingOpportunities = this.opportunities.size;

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
      const data = message.data as Record<string, unknown>;
      if (!data) return;

      this.systemMetrics.whaleAlerts++;

      // FIX: Use type guard utilities for consistency with other handlers
      const rawAlert = unwrapMessageData(data);
      const usdValue = getNonNegativeNumber(rawAlert, 'usdValue', 0);
      const direction = getString(rawAlert, 'direction', 'unknown');
      const chain = getString(rawAlert, 'chain', 'unknown');
      const address = getOptionalString(rawAlert, 'address');
      const dex = getOptionalString(rawAlert, 'dex');
      const impact = getOptionalString(rawAlert, 'impact');

      this.logger.warn('Whale alert received', {
        address,
        usdValue,
        direction,
        chain,
        dex,
        impact
      });

      // Send alert notification
      this.sendAlert({
        type: 'WHALE_TRANSACTION',
        message: `Whale ${direction} detected: $${usdValue.toLocaleString()} on ${chain}`,
        severity: usdValue > 100000 ? 'critical' : 'high',
        data: rawAlert,
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

      // FIX: Use unwrapMessageData utility for wrapped MessageEvent handling
      const rawEvent = unwrapMessageData(data);
      const pairAddress = getString(rawEvent, 'pairAddress', '');
      const chain = getString(rawEvent, 'chain', 'unknown');
      const dex = getString(rawEvent, 'dex', 'unknown');
      // FIX: Use getNonNegativeNumber to guard against malformed negative values
      const usdValue = getNonNegativeNumber(rawEvent, 'usdValue', 0);

      if (!pairAddress) {
        this.logger.debug('Skipping swap event - missing pairAddress', { messageId: message.id });
        return;
      }

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

      // FIX: Use unwrapMessageData for cleaner wrapped/direct handling
      const rawAggregate = unwrapMessageData(data);
      const pairAddress = getString(rawAggregate, 'pairAddress', '');
      const chain = getString(rawAggregate, 'chain', 'unknown');
      const dex = getString(rawAggregate, 'dex', 'unknown');
      const swapCount = getNonNegativeNumber(rawAggregate, 'swapCount', 0);
      const totalUsdVolume = getNonNegativeNumber(rawAggregate, 'totalUsdVolume', 0);

      if (!pairAddress) {
        this.logger.debug('Skipping volume aggregate - missing pairAddress', { messageId: message.id });
        return;
      }

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

      // FIX: Use unwrapMessageData for cleaner wrapped/direct handling
      const rawUpdate = unwrapMessageData(data);
      const chain = getString(rawUpdate, 'chain', 'unknown');
      const dex = getString(rawUpdate, 'dex', 'unknown');
      const pairKey = getString(rawUpdate, 'pairKey', '');

      if (!pairKey) {
        this.logger.debug('Skipping price update - missing pairKey', { messageId: message.id });
        return;
      }

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
   * FIX P2: Check if execution circuit breaker is open.
   * If open, check if reset timeout has passed (half-open state).
   * R7 Consolidation: Now delegates to SimpleCircuitBreaker.isCurrentlyOpen()
   */
  private isExecutionCircuitOpen(): boolean {
    return this.executionCircuitBreaker.isCurrentlyOpen();
  }

  /**
   * FIX P2: Record execution forwarding failure.
   * R7 Consolidation: Now delegates to SimpleCircuitBreaker.recordFailure()
   */
  private recordExecutionFailure(): void {
    // recordFailure() returns true if this failure just opened the circuit
    const justOpened = this.executionCircuitBreaker.recordFailure();
    const status = this.executionCircuitBreaker.getStatus();

    if (justOpened) {
      this.logger.warn('Execution circuit breaker opened', {
        failures: status.failures,
        resetTimeoutMs: status.resetTimeoutMs
      });

      // Send alert about circuit breaker opening
      this.sendAlert({
        type: 'EXECUTION_CIRCUIT_OPEN',
        message: `Execution forwarding circuit breaker opened after ${status.failures} failures`,
        severity: 'high',
        data: { failures: status.failures },
        timestamp: Date.now()
      });
    }
  }

  /**
   * FIX P2: Record execution forwarding success.
   * R7 Consolidation: Now delegates to SimpleCircuitBreaker.recordSuccess()
   */
  private recordExecutionSuccess(): void {
    // recordSuccess() returns true if the circuit was open and just closed
    const justRecovered = this.executionCircuitBreaker.recordSuccess();

    if (justRecovered) {
      this.logger.info('Execution circuit breaker closed - recovered');
    }
  }

  /**
   * Forward a pending opportunity to the execution engine via Redis Streams.
   * FIX: Implemented actual stream publishing (was TODO stub).
   * FIX P2: Added circuit breaker to prevent hammering failed streams.
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

    // FIX P2: Check circuit breaker before attempting to forward
    if (this.isExecutionCircuitOpen()) {
      this.logger.debug('Execution circuit open, skipping opportunity forwarding', {
        id: opportunity.id,
        failures: this.executionCircuitBreaker.getFailures()
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

      // FIX P2: Record success to close circuit breaker if it was half-open
      this.recordExecutionSuccess();

      this.logger.info('Forwarded opportunity to execution engine', {
        id: opportunity.id,
        chain: opportunity.chain,
        profitPercentage: opportunity.profitPercentage
      });

      // Update metrics
      this.systemMetrics.totalExecutions++;

    } catch (error) {
      // FIX P2: Record failure for circuit breaker
      this.recordExecutionFailure();

      this.logger.error('Failed to forward opportunity to execution engine', {
        id: opportunity.id,
        error: (error as Error).message,
        circuitFailures: this.executionCircuitBreaker.getFailures()
      });

      // Send alert for execution forwarding failures (only if circuit not already open)
      // Use getStatus().isOpen to check raw open state (not affected by half-open logic)
      if (!this.executionCircuitBreaker.getStatus().isOpen) {
        this.sendAlert({
          type: 'EXECUTION_FORWARD_FAILED',
          message: `Failed to forward opportunity ${opportunity.id}: ${(error as Error).message}`,
          severity: 'high',
          data: { opportunityId: opportunity.id, chain: opportunity.chain },
          timestamp: Date.now()
        });
      }
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

    // FIX 7.1: Legacy health polling is DEPRECATED and scheduled for removal.
    // All services now use Redis Streams (ADR-002). This code path is only kept for
    // backward compatibility with older services that don't publish to streams yet.
    //
    // DEPRECATION NOTICE:
    // - Current status: Disabled by default (enableLegacyHealthPolling: false)
    // - Scheduled removal: Next major version
    // - Migration: Ensure all services publish to stream:health instead of Redis keys
    // - To verify: Check that ENABLE_LEGACY_HEALTH_POLLING is not set in any deployment
    //
    // @deprecated Since v2.0.0 - Will be removed in v3.0.0
    if (this.config.enableLegacyHealthPolling) {
      this.logger.warn('⚠️ DEPRECATED: Legacy health polling enabled. This feature will be removed in v3.0.0. Migrate to streams-only mode by setting ENABLE_LEGACY_HEALTH_POLLING=false');
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
        } catch (error) {
          this.logger.error('Legacy health polling failed', { error });
        }
      }, 10000);
    }

    // FIX P1: Use dedicated interval for cleanup operations (not tied to legacy polling)
    // This runs regardless of legacy polling mode to ensure cleanup always happens
    // Previous bug: cleanup only ran if legacy polling was disabled due to ?? operator
    this.generalCleanupInterval = setInterval(() => {
      if (!this.stateManager.isRunning()) return;

      try {
        // P2-3 FIX: Periodically cleanup stale alert cooldowns to prevent memory leak
        this.cleanupAlertCooldowns(Date.now());

        // Cleanup stale active pairs to prevent unbounded memory growth
        this.cleanupActivePairs();
      } catch (error) {
        this.logger.error('Cleanup operations failed', { error });
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
    // R2: Delegate to health monitor for single-pass metrics calculation
    if (this.healthMonitor) {
      this.healthMonitor.updateMetrics(this.serviceHealth, this.systemMetrics);
    } else {
      // Fallback for tests without health monitor
      const now = Date.now();
      let activeServices = 0;
      let totalMemory = 0;
      let totalLatency = 0;

      for (const health of this.serviceHealth.values()) {
        if (health.status === 'healthy') {
          activeServices++;
        }
        totalMemory += health.memoryUsage || 0;
        const latency = health.latency ?? (health.lastHeartbeat ? now - health.lastHeartbeat : 0);
        totalLatency += latency;
      }

      const totalServices = Math.max(this.serviceHealth.size, 1);
      this.systemMetrics.activeServices = activeServices;
      this.systemMetrics.systemHealth = (activeServices / totalServices) * 100;
      this.systemMetrics.averageLatency = totalLatency / totalServices;
      this.systemMetrics.averageMemory = totalMemory / totalServices;
      this.systemMetrics.lastUpdate = now;
    }

    // Update pending opportunities count (from either opportunity router or local map)
    this.systemMetrics.pendingOpportunities = this.opportunityRouter?.getPendingCount() ?? this.opportunities.size;

    // FIX: Evaluate degradation level after updating metrics (ADR-007)
    this.evaluateDegradationLevel();
  }

  /**
   * FIX: Evaluate system degradation level per ADR-007.
   * R2: Delegates to HealthMonitor for evaluation.
   */
  private evaluateDegradationLevel(): void {
    // R2: Delegate to health monitor
    if (this.healthMonitor) {
      this.healthMonitor.evaluateDegradationLevel(this.serviceHealth, this.systemMetrics.systemHealth);
      this.degradationLevel = this.healthMonitor.getDegradationLevel();
    } else {
      // Fallback for tests without health monitor
      const previousLevel = this.degradationLevel;
      const analysis = this.analyzeServiceHealth();

      if (!analysis.hasAnyServices || this.systemMetrics.systemHealth === 0) {
        this.degradationLevel = DegradationLevel.COMPLETE_OUTAGE;
      } else if (!analysis.executorHealthy && !analysis.hasHealthyDetectors) {
        this.degradationLevel = DegradationLevel.READ_ONLY;
      } else if (!analysis.executorHealthy) {
        this.degradationLevel = DegradationLevel.DETECTION_ONLY;
      } else if (!analysis.allDetectorsHealthy) {
        this.degradationLevel = DegradationLevel.REDUCED_CHAINS;
      } else {
        this.degradationLevel = DegradationLevel.FULL_OPERATION;
      }

      if (previousLevel !== this.degradationLevel) {
        this.logger.warn('Degradation level changed', {
          previous: DegradationLevel[previousLevel],
          current: DegradationLevel[this.degradationLevel],
          systemHealth: this.systemMetrics.systemHealth,
          analysis
        });
      }
    }
  }

  /**
   * OPTIMIZATION: Single-pass analysis of service health.
   * Replaces multiple iterations with one pass over serviceHealth map.
   *
   * @returns Analysis result with all degradation-relevant flags
   */
  private analyzeServiceHealth(): {
    hasAnyServices: boolean;
    executorHealthy: boolean;
    hasHealthyDetectors: boolean;
    allDetectorsHealthy: boolean;
    detectorCount: number;
    healthyDetectorCount: number;
  } {
    const result = {
      hasAnyServices: this.serviceHealth.size > 0,
      executorHealthy: false,
      hasHealthyDetectors: false,
      allDetectorsHealthy: true, // Assume true, set false if unhealthy detector found
      detectorCount: 0,
      healthyDetectorCount: 0
    };

    // Single pass over all services
    // FIX 3.2: Use configurable service name patterns instead of hardcoded strings
    for (const [name, health] of this.serviceHealth) {
      const isHealthy = health.status === 'healthy';

      // Check execution engine using configurable pattern
      if (name === SERVICE_NAME_PATTERNS.EXECUTION_ENGINE) {
        result.executorHealthy = isHealthy;
        continue;
      }

      // Check detectors using configurable pattern (contains pattern string)
      if (name.includes(SERVICE_NAME_PATTERNS.DETECTOR_PATTERN)) {
        result.detectorCount++;
        if (isHealthy) {
          result.healthyDetectorCount++;
          result.hasHealthyDetectors = true;
        } else {
          result.allDetectorsHealthy = false;
        }
      }
    }

    // No detectors means allDetectorsHealthy should be false
    if (result.detectorCount === 0) {
      result.allDetectorsHealthy = false;
    }

    return result;
  }

  /**
   * Check if a specific service is healthy.
   * Note: For bulk checks, use analyzeServiceHealth() instead.
   */
  private isServiceHealthy(serviceName: string): boolean {
    const health = this.serviceHealth.get(serviceName);
    return health?.status === 'healthy';
  }

  /**
   * FIX: Get current degradation level (ADR-007).
   * R2: Delegates to HealthMonitor if available.
   */
  getDegradationLevel(): DegradationLevel {
    return this.healthMonitor?.getDegradationLevel() ?? this.degradationLevel;
  }

  /**
   * Check for alerts and trigger notifications.
   * R2: Delegates to HealthMonitor for alert checking.
   */
  private checkForAlerts(): void {
    // R2: Delegate to health monitor
    if (this.healthMonitor) {
      this.healthMonitor.checkForAlerts(this.serviceHealth, this.systemMetrics.systemHealth);
    } else {
      // Fallback for tests without health monitor
      const alerts: Alert[] = [];
      const now = Date.now();
      const inGracePeriod = (now - this.startTime) < CoordinatorService.STARTUP_GRACE_PERIOD_MS;

      if (!inGracePeriod) {
        for (const [serviceName, health] of this.serviceHealth) {
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
      }

      const MIN_SERVICES_FOR_GRACE_PERIOD_ALERT = 3;
      const shouldAlertLowHealth = inGracePeriod
        ? this.serviceHealth.size >= MIN_SERVICES_FOR_GRACE_PERIOD_ALERT && this.systemMetrics.systemHealth < 80
        : this.systemMetrics.systemHealth < 80;

      if (shouldAlertLowHealth) {
        alerts.push({
          type: 'SYSTEM_HEALTH_LOW',
          message: `System health is ${this.systemMetrics.systemHealth.toFixed(1)}%`,
          severity: 'critical',
          timestamp: now
        });
      }

      for (const alert of alerts) {
        this.sendAlert(alert);
      }
    }
  }

  /**
   * P1-NEW-1 FIX: Send alert with cooldown and periodic cleanup
   * P2 FIX: Use Alert type for proper type safety
   * FIX: Now sends to external channels via AlertNotifier
   * R2: Delegates cooldown tracking to healthMonitor if available
   */
  private sendAlert(alert: Alert): void {
    const alertKey = `${alert.type}_${alert.service || 'system'}`;
    const now = Date.now();

    // R2: Use healthMonitor's cooldowns if available for consistency
    const cooldowns = this.healthMonitor?.getAlertCooldowns() ?? this.alertCooldowns;
    const lastAlert = cooldowns.get(alertKey) || 0;
    // FIX: Use configurable cooldown instead of hardcoded 5 minutes
    const cooldownMs = this.config.alertCooldownMs!;

    // Cooldown for same alert type (configurable, default 5 minutes)
    if (now - lastAlert > cooldownMs) {
      this.logger.warn('Alert triggered', alert);

      // R2 + R12: Update cooldowns in the appropriate storage
      // R12 FIX: Use proper public API instead of unsafe private field access
      if (this.healthMonitor) {
        this.healthMonitor.setAlertCooldown(alertKey, now);
      } else {
        this.alertCooldowns.set(alertKey, now);
      }

      // P1-NEW-1 FIX: Periodic cleanup of stale cooldowns (every 100 alerts or 1000+ entries)
      if (cooldowns.size > 1000) {
        if (this.healthMonitor) {
          this.healthMonitor.cleanupAlertCooldowns(now);
        } else {
          this.cleanupAlertCooldowns(now);
        }
      }

      // FIX: Send to external channels (Discord/Slack) via AlertNotifier
      if (this.alertNotifier) {
        // Fire and forget - don't await to avoid blocking
        this.alertNotifier.notify(alert).catch(error => {
          this.logger.error('Failed to send alert notification', { error: (error as Error).message });
        });
      }
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
    // R2: Delegate to opportunity router if available
    return this.opportunityRouter?.getOpportunities() ?? new Map(this.opportunities);
  }

  getAlertCooldowns(): Map<string, number> {
    // R2: Delegate to health monitor if available
    return this.healthMonitor?.getAlertCooldowns() ?? new Map(this.alertCooldowns);
  }

  deleteAlertCooldown(key: string): boolean {
    // R2: Delegate to health monitor if available
    return this.healthMonitor?.deleteAlertCooldown(key) ?? this.alertCooldowns.delete(key);
  }

  getLogger(): RouteLogger {
    return this.logger;
  }

  /**
   * FIX: Get alert history from the notifier for /api/alerts endpoint.
   * @param limit Maximum number of alerts to return (default: 100)
   */
  getAlertHistory(limit: number = 100): Alert[] {
    return this.alertNotifier?.getAlertHistory(limit) ?? [];
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

    // FIX 5.5: Use separate flag instead of modifying config.isStandby
    // This prevents race conditions where other code reads config.isStandby concurrently
    // The isActivating flag bypasses standby checks in tryAcquireLeadership
    this.isActivating = true;

    try {
      // Force attempt to acquire leadership
      // tryAcquireLeadership will check isActivating flag to bypass standby check
      const acquired = await this.tryAcquireLeadership();

      if (acquired) {
        // Successful activation - update config.isStandby atomically at the end
        this.config.isStandby = false;
        this.logger.warn('✅ STANDBY COORDINATOR ACTIVATED - Now leader', {
          instanceId: this.config.leaderElection.instanceId,
          regionId: this.config.regionId
        });
        return true;
      } else {
        this.logger.error('Failed to acquire leadership during activation');
        return false;
      }

    } catch (error) {
      this.logger.error('Error during standby activation', { error });
      return false;
    } finally {
      // Always clear activation flag when done
      this.isActivating = false;
    }
  }
}
