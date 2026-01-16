/**
 * System Coordinator Service with Monitoring Dashboard
 *
 * Orchestrates all detector services and manages system health.
 * Uses Redis Streams for event consumption (ADR-002) and implements
 * leader election for failover (ADR-007).
 *
 * @see ARCHITECTURE_V2.md Section 4.5 (Layer 5: Coordination)
 * @see ADR-002: Redis Streams over Pub/Sub
 * @see ADR-007: Failover Strategy
 */
import http from 'http';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import {
  RedisClient,
  getRedisClient,
  createLogger,
  getPerformanceLogger,
  PerformanceLogger,
  ValidationMiddleware,
  RedisStreamsClient,
  getRedisStreamsClient,
  ConsumerGroupConfig,
  ServiceStateManager,
  createServiceState,
  ServiceState,
  StreamConsumer,
  getStreamHealthMonitor
} from '@arbitrage/core';
import type { ServiceHealth, ArbitrageOpportunity } from '@arbitrage/types';

// =============================================================================
// Types
// =============================================================================

interface SystemMetrics {
  totalOpportunities: number;
  totalExecutions: number;
  successfulExecutions: number;
  totalProfit: number;
  averageLatency: number;
  averageMemory: number;  // Added: previously memory was incorrectly assigned to latency
  systemHealth: number;
  activeServices: number;
  lastUpdate: number;
  whaleAlerts: number;
  pendingOpportunities: number;
}

interface LeaderElectionConfig {
  lockKey: string;
  lockTtlMs: number;
  heartbeatIntervalMs: number;
  instanceId: string;
}

// =============================================================================
// Dependency Injection Interface
// =============================================================================

/**
 * Logger interface for dependency injection.
 * Allows injecting mock loggers in tests.
 * Uses `unknown` for meta parameter to match @arbitrage/core Logger type.
 */
interface Logger {
  info: (message: string, meta?: unknown) => void;
  error: (message: string, meta?: unknown) => void;
  warn: (message: string, meta?: unknown) => void;
  debug: (message: string, meta?: unknown) => void;
}

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

export class CoordinatorService {
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
  private serviceHealth: Map<string, ServiceHealth> = new Map();
  private systemMetrics: SystemMetrics;
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
      consumerId: config?.consumerId || instanceId
    };

    // Define consumer groups for all streams we need to consume
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
      }
    ];

    this.setupMiddleware();
    this.setupRoutes();
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
      this.startStreamConsumers();

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

    try {
      const { lockKey, lockTtlMs, instanceId } = this.config.leaderElection;

      // Try to set the lock with NX (only if not exists)
      const acquired = await this.redis.setNx(lockKey, instanceId, Math.ceil(lockTtlMs / 1000));

      if (acquired) {
        this.isLeader = true;
        this.logger.info('Acquired leadership', { instanceId });
        return true;
      }

      // P0-4 fix: Check if we already hold the lock
      // Note: There's an inherent TOCTOU between setNx failure and this get,
      // but the consequence is benign - we just don't become leader this round.
      // The next heartbeat interval will retry. Using a Lua script would be
      // more atomic but adds complexity for minimal benefit here.
      const currentLeader = await this.redis.get(lockKey);
      if (currentLeader === instanceId) {
        // We already hold the lock - refresh TTL to prevent expiration
        await this.redis.expire(lockKey, Math.ceil(lockTtlMs / 1000));
        this.isLeader = true;
        return true;
      }

      this.logger.info('Another instance is leader', { currentLeader });
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
    }, heartbeatIntervalMs);
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
  private startStreamConsumers(): void {
    if (!this.streamsClient) return;

    // Handler map for each stream
    const handlers: Record<string, (msg: StreamMessage) => Promise<void>> = {
      [RedisStreamsClient.STREAMS.HEALTH]: (msg) => this.handleHealthMessage(msg),
      [RedisStreamsClient.STREAMS.OPPORTUNITIES]: (msg) => this.handleOpportunityMessage(msg),
      [RedisStreamsClient.STREAMS.WHALE_ALERTS]: (msg) => this.handleWhaleAlertMessage(msg)
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

      consumer.start();
      this.streamConsumers.push(consumer);

      this.logger.info('Stream consumer started', {
        stream: groupConfig.streamName,
        blockMs: 1000
      });
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
  private readonly MAX_OPPORTUNITIES = 1000;
  private readonly OPPORTUNITY_TTL_MS = 60000; // 1 minute default TTL
  private readonly OPPORTUNITY_CLEANUP_INTERVAL_MS = 10000; // 10 seconds

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

  private async forwardToExecutionEngine(opportunity: ArbitrageOpportunity): Promise<void> {
    // In production, this would forward to the execution engine via streams
    // For now, just log the intent
    this.logger.info('Forwarding opportunity to execution engine', {
      id: opportunity.id,
      chain: opportunity.chain
    });

    // TODO: Publish to execution-requests stream when execution engine is ready
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
      pendingOpportunities: 0
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
    const cooldownMs = 300000; // 5 minutes

    // 5 minute cooldown for same alert type
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
  // Express Middleware & Routes
  // ===========================================================================

  private setupMiddleware(): void {
    // Security headers
    this.app.use(helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          imgSrc: ["'self'", "data:", "https:"],
        },
      },
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
      }
    }));

    // CORS
    this.app.use((req, res, next) => {
      const allowedOrigins = process.env.ALLOWED_ORIGINS ?
        process.env.ALLOWED_ORIGINS.split(',') :
        ['http://localhost:3000', 'http://localhost:3001'];

      const origin = req.headers.origin;
      if (origin && allowedOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
      }

      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
      res.header('Access-Control-Allow-Credentials', 'true');
      res.header('X-Content-Type-Options', 'nosniff');
      res.header('X-Frame-Options', 'DENY');
      res.header('X-XSS-Protection', '1; mode=block');

      if (req.method === 'OPTIONS') {
        res.sendStatus(200);
        return;
      }

      next();
    });

    // JSON parsing with limits
    this.app.use(express.json({ limit: '1mb', strict: true }));
    this.app.use(express.urlencoded({ extended: false, limit: '1mb' }));
    this.app.use(express.static('public'));

    // Rate limiting
    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 100,
      message: { error: 'Too many requests', retryAfter: 900 },
      standardHeaders: true,
      legacyHeaders: false
    });
    this.app.use(limiter);

    // Request logging
    this.app.use((req, res, next) => {
      const start = Date.now();
      const clientIP = req.ip || req.connection.remoteAddress || 'unknown';

      res.on('finish', () => {
        const duration = Date.now() - start;
        this.logger.info('API Request', {
          method: req.method,
          url: req.url,
          status: res.statusCode,
          duration,
          ip: clientIP
        });
      });

      next();
    });
  }

  private setupRoutes(): void {
    // Dashboard routes
    this.app.get('/', this.getDashboard.bind(this));
    this.app.get('/api/health', ValidationMiddleware.validateHealthCheck, this.getHealth.bind(this));
    this.app.get('/api/metrics', this.getMetrics.bind(this));
    this.app.get('/api/services', this.getServices.bind(this));
    this.app.get('/api/opportunities', this.getOpportunities.bind(this));
    this.app.get('/api/alerts', this.getAlerts.bind(this));
    this.app.get('/api/leader', this.getLeaderStatus.bind(this));

    // Control routes with strict rate limiting
    const strictLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 5,
      message: { error: 'Too many control actions', retryAfter: 900 }
    });

    this.app.post('/api/services/:service/restart',
      strictLimiter,
      this.validateServiceRestart.bind(this),
      this.restartService.bind(this)
    );
    this.app.post('/api/alerts/:alert/acknowledge',
      strictLimiter,
      this.validateAlertAcknowledge.bind(this),
      this.acknowledgeAlert.bind(this)
    );
  }

  // ===========================================================================
  // Route Handlers
  // ===========================================================================

  // P2 FIX: Use Express types instead of any
  private getDashboard(_req: Request, res: Response): void {
    const leaderBadge = this.isLeader
      ? '<span style="background:green;color:white;padding:2px 8px;border-radius:3px;">LEADER</span>'
      : '<span style="background:orange;color:white;padding:2px 8px;border-radius:3px;">STANDBY</span>';

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Arbitrage System Dashboard</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; background: #1a1a2e; color: #eee; }
          .metric { background: #16213e; padding: 15px; margin: 10px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.3); }
          .healthy { color: #00ff88; }
          .unhealthy { color: #ff4444; }
          .degraded { color: #ffaa00; }
          .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
          h1 { color: #00ff88; }
          h3 { color: #4da6ff; margin-bottom: 10px; }
          .leader-status { margin-bottom: 20px; }
        </style>
      </head>
      <body>
        <h1>🏦 Professional Arbitrage System Dashboard</h1>
        <div class="leader-status">Status: ${leaderBadge}</div>

        <div class="grid">
          <div class="metric">
            <h3>System Health</h3>
            <div class="${this.systemMetrics.systemHealth > 80 ? 'healthy' : this.systemMetrics.systemHealth > 50 ? 'degraded' : 'unhealthy'}">
              ${this.systemMetrics.systemHealth.toFixed(1)}%
            </div>
            <small>${this.systemMetrics.activeServices} services active</small>
          </div>

          <div class="metric">
            <h3>Opportunities</h3>
            <div>Detected: ${this.systemMetrics.totalOpportunities}</div>
            <div>Pending: ${this.systemMetrics.pendingOpportunities}</div>
            <div>Whale Alerts: ${this.systemMetrics.whaleAlerts}</div>
          </div>

          <div class="metric">
            <h3>Trading Performance</h3>
            <div>Executions: ${this.systemMetrics.totalExecutions}</div>
            <div>Success Rate: ${this.systemMetrics.totalExecutions > 0 ?
              ((this.systemMetrics.successfulExecutions / this.systemMetrics.totalExecutions) * 100).toFixed(1) : 0}%</div>
            <div>Total Profit: $${this.systemMetrics.totalProfit.toFixed(2)}</div>
          </div>

          <div class="metric">
            <h3>Service Status</h3>
            ${Array.from(this.serviceHealth.entries()).map(([name, health]) =>
              `<div class="${health.status === 'healthy' ? 'healthy' : health.status === 'degraded' ? 'degraded' : 'unhealthy'}">
                ${name}: ${health.status}
              </div>`
            ).join('') || '<div>No services reporting</div>'}
          </div>
        </div>

        <div class="metric">
          <h3>System Information</h3>
          <div>Instance: ${this.config.leaderElection.instanceId}</div>
          <div>Last Update: ${new Date(this.systemMetrics.lastUpdate).toLocaleString()}</div>
          <div>Uptime: ${Math.floor(process.uptime() / 3600)}h ${Math.floor((process.uptime() % 3600) / 60)}m</div>
        </div>

        <script>
          // Auto-refresh every 10 seconds
          setTimeout(() => window.location.reload(), 10000);
        </script>
      </body>
      </html>
    `);
  }

  private getHealth(_req: Request, res: Response): void {
    res.json({
      status: 'ok',
      isLeader: this.isLeader,
      instanceId: this.config.leaderElection.instanceId,
      systemHealth: this.systemMetrics.systemHealth,
      services: Object.fromEntries(this.serviceHealth),
      timestamp: Date.now()
    });
  }

  private getMetrics(_req: Request, res: Response): void {
    res.json(this.systemMetrics);
  }

  private getServices(_req: Request, res: Response): void {
    res.json(Object.fromEntries(this.serviceHealth));
  }

  private getOpportunities(_req: Request, res: Response): void {
    const opportunities = Array.from(this.opportunities.values())
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, 100); // Return last 100
    res.json(opportunities);
  }

  private getAlerts(_req: Request, res: Response): void {
    // Return recent alerts (in production, store in database)
    res.json([]);
  }

  private getLeaderStatus(_req: Request, res: Response): void {
    res.json({
      isLeader: this.isLeader,
      instanceId: this.config.leaderElection.instanceId,
      lockKey: this.config.leaderElection.lockKey
    });
  }

  // ===========================================================================
  // Validation Methods
  // ===========================================================================

  // P2 FIX: Use Express types instead of any
  private validateServiceRestart(req: Request, res: Response, next: NextFunction): void {
    const { service } = req.params;

    if (!service || typeof service !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(service)) {
      res.status(400).json({ error: 'Invalid service name' });
      return;
    }

    const allowedServices = ['bsc-detector', 'ethereum-detector', 'arbitrum-detector',
      'polygon-detector', 'optimism-detector', 'base-detector', 'execution-engine'];

    if (!allowedServices.includes(service)) {
      res.status(404).json({ error: 'Service not found' });
      return;
    }

    // Only leader can restart services
    if (!this.isLeader) {
      res.status(403).json({ error: 'Only leader can restart services' });
      return;
    }

    next();
  }

  private validateAlertAcknowledge(req: Request, res: Response, next: NextFunction): void {
    const { alert } = req.params;

    if (!alert || typeof alert !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(alert)) {
      res.status(400).json({ error: 'Invalid alert ID' });
      return;
    }

    next();
  }

  private async restartService(req: Request, res: Response): Promise<void> {
    const { service } = req.params;

    try {
      this.logger.info(`Restarting service: ${service}`);
      // In production, implement service restart logic via orchestration
      res.json({ success: true, message: `Restart requested for ${service}` });
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  }

  private acknowledgeAlert(req: Request, res: Response): void {
    const { alert } = req.params;
    // FIX: Alert cooldown keys are stored as `${type}_${service}`, e.g., "SERVICE_UNHEALTHY_bsc-detector"
    // The alert param can be either the full key or just the type
    // Try exact match first, then try with _system suffix for system alerts
    let deleted = this.alertCooldowns.delete(alert);
    if (!deleted) {
      // Try with _system suffix (for alerts without service)
      deleted = this.alertCooldowns.delete(`${alert}_system`);
    }
    res.json({ success: deleted, message: deleted ? 'Alert acknowledged' : 'Alert not found in cooldowns' });
  }

  // ===========================================================================
  // Public Getters for Testing
  // ===========================================================================

  getIsLeader(): boolean {
    return this.isLeader;
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
}
