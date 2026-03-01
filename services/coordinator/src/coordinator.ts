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
 * - R2: Streaming → streaming/ folder (StreamConsumerManager)
 * - R2: Health monitoring → health/ folder (HealthMonitor)
 * - R2: Opportunities → opportunities/ folder (OpportunityRouter)
 * - P2-11: IntervalManager (@arbitrage/core) for centralized interval lifecycle
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
import { SimpleCircuitBreaker } from '@arbitrage/core/circuit-breaker';
import { findKSmallest } from '@arbitrage/core/data-structures';
import { getStreamHealthMonitor, CpuUsageTracker } from '@arbitrage/core/monitoring';
import {
  RedisClient,
  getRedisClient,
  RedisStreamsClient,
  getRedisStreamsClient,
  ConsumerGroupConfig,
  StreamConsumer,
  unwrapBatchMessages,
} from '@arbitrage/core/redis';
import { getErrorMessage } from '@arbitrage/core/resilience';
import { ServiceStateManager, createServiceState } from '@arbitrage/core/service-lifecycle';
import { disconnectWithTimeout } from '@arbitrage/core/utils';
import { createLogger, getPerformanceLogger, PerformanceLogger } from '@arbitrage/core';
import type { ServiceHealth, ArbitrageOpportunity } from '@arbitrage/types';
import { RedisStreams } from '@arbitrage/types';
import { isAuthEnabled } from '@arbitrage/security';
import { safeParseInt } from '@arbitrage/config';
import { serializeOpportunityForStream } from './utils/stream-serialization';

// Import extracted API modules
// FIX: Import Logger and Alert from consolidated api/types (single source of truth)
import {
  configureMiddleware,
  setupAllRoutes,
  SystemMetrics,
  CoordinatorStateProvider,
  MinimalLogger,
  Logger,
  Alert
} from './api';

// Import alert notification system
import { AlertNotifier, AlertCooldownManager } from './alerts';

// Import type guard utilities
import {
  getString,
  getNumber,
  getNonNegativeNumber,
  getOptionalString,
  getOptionalNumber,
  unwrapMessageData,
  hasRequiredString,
} from './utils';

// R2: Import extracted subsystem modules
import { StreamConsumerManager } from './streaming';
import { HealthMonitor, DegradationLevel } from './health';
import { OpportunityRouter } from './opportunities';
// P1-8 FIX: Import LeadershipElectionService to replace inline leadership code
import { LeadershipElectionService } from './leadership';

// P1-2: Import extracted ActivePairsTracker for bounded pair tracking
import { ActivePairsTracker } from './tracking';

// OP-3 FIX: Import trace context utilities for cross-service correlation
import { extractContext, createTraceContext, createChildContext } from '@arbitrage/core/tracing';
import type { TraceContext } from '@arbitrage/core/tracing';

// P2-11: Import IntervalManager for centralized interval lifecycle management
import { IntervalManager } from '@arbitrage/core/async';
// REFACTOR: Import extracted standby activation manager
import { StandbyActivationManager } from './standby-activation-manager';

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
 * @deprecated Import directly from './health' instead
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
  maxActivePairs?: number;         // P3-005: Max active pairs in memory (default: 10000)
  alertCooldownMs?: number;        // Alert cooldown duration (default: 300000)
  // OP-22 FIX: Configurable execution circuit breaker thresholds
  executionCbThreshold?: number;   // Failures before opening CB (default: 5)
  executionCbResetMs?: number;     // Time before half-open attempt (default: 60000)
  // P0-3 FIX: enableLegacyHealthPolling REMOVED - all services use streams (ADR-002)
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
  // P1-8 FIX: Leadership election service (replaces inline leadership code)
  // Manages distributed leadership election using Redis locks
  private leadershipElection: LeadershipElectionService | null = null;
  // P1-8 FIX: Track leadership status (delegated to LeadershipElectionService)
  // P2 FIX #19: This field is a write-target for the onLeadershipChange callback
  // and fallback before leadershipElection is initialized. All reads that affect
  // behavior should use getIsLeader() which delegates to LeadershipElectionService.
  private isLeader = false;
  // REFACTOR: Standby activation delegated to StandbyActivationManager
  private standbyActivationManager: StandbyActivationManager | null = null;
  // P1-8 FIX: Activation state tracking (backward compat flag)
  private isActivating = false;
  private serviceHealth: Map<string, ServiceHealth> = new Map();
  private systemMetrics: SystemMetrics;
  // FIX: Track degradation level per ADR-007
  private degradationLevel: DegradationLevel = DegradationLevel.FULL_OPERATION;
  // R2: Alert cooldown manager (encapsulates dual-storage pattern with HealthMonitor)
  private alertCooldownManager: AlertCooldownManager | null = null;
  private opportunities: Map<string, ArbitrageOpportunity> = new Map();
  // FIX: Alert notifier for sending alerts to Discord/Slack
  private alertNotifier: AlertNotifier | null = null;

  // FIX P2: Circuit breaker for execution forwarding
  // Prevents hammering the execution stream when it's down
  // R7 Consolidation: Now uses shared SimpleCircuitBreaker from @arbitrage/core
  // OP-22 FIX: Thresholds now configurable via config/env vars (previously hardcoded)
  private executionCircuitBreaker!: SimpleCircuitBreaker;

  // Startup grace period: Don't report critical alerts during initial startup
  // This prevents false alerts when services haven't reported health yet
  private static readonly STARTUP_GRACE_PERIOD_MS = 120000; // 120 seconds — partitions take 59-80s to register
  private startTime: number = 0;

  // P2-11: Centralized interval management (replaces individual interval fields)
  private readonly intervalManager = new IntervalManager();

  // Stream consumers (blocking read pattern - replaces setInterval polling)
  private streamConsumers: StreamConsumer[] = [];

  // H2 FIX: Delta-based CPU usage tracking (replaces hardcoded 0)
  private readonly cpuTracker = new CpuUsageTracker();

  // M4 FIX: Pipeline starvation detection — track last time execution requests were seen
  private lastExecutionRequestTime = 0;
  private pipelineStarvationAlerted = false;
  private static readonly PIPELINE_STARVATION_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

  // P1 Fix: Cached execution stream depth for backpressure detection.
  // Updated every 5s in health monitoring. When ratio > 0.8, forwardToExecution()
  // logs a warning. When ratio > 0.95, forwarding is skipped to prevent MAXLEN trimming.
  private cachedExecutionStreamDepthRatio = 0;

  // Configuration
  private readonly config: CoordinatorConfig;

  // Consumer group configs for streams
  private readonly consumerGroups: ConsumerGroupConfig[];

  // P0-FIX 1.2: Dead Letter Queue stream for GENERAL message processing failures.
  // Used by StreamConsumerManager for messages that fail parsing/handling.
  // P2 FIX #21 NOTE: OpportunityRouter uses a separate DLQ ('stream:forwarding-dlq')
  // for execution forwarding failures — different failure mode, different schema.
  private static readonly DLQ_STREAM = RedisStreams.DEAD_LETTER_QUEUE;

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

    // P3-001 STANDARD: Nullish Coalescing Usage Convention
    // - Use `??` for numbers/booleans where 0/false are valid (e.g., config values, counters)
    // - Use `||` for strings where empty string is invalid (e.g., hostnames, service names)
    // - Use `||` for ports/IDs where 0 is semantically invalid
    // See: docs/agent/code_conventions.md for full guidelines

    // P1 FIX #14: NaN-safe parseInt — imported from @arbitrage/config (shared utility)

    this.config = {
      // P2 FIX #20: Read COORDINATOR_PORT (per .env.example) with PORT fallback
      port: config?.port || safeParseInt(process.env.COORDINATOR_PORT ?? process.env.PORT, 3000),
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
      // P1 FIX #14: Use safeParseInt to guard against NaN from malformed env vars
      maxOpportunities: config?.maxOpportunities ?? safeParseInt(process.env.MAX_OPPORTUNITIES, 1000),
      opportunityTtlMs: config?.opportunityTtlMs ?? safeParseInt(process.env.OPPORTUNITY_TTL_MS, 60000),
      opportunityCleanupIntervalMs: config?.opportunityCleanupIntervalMs ?? safeParseInt(process.env.OPPORTUNITY_CLEANUP_INTERVAL_MS, 10000),
      pairTtlMs: config?.pairTtlMs ?? safeParseInt(process.env.PAIR_TTL_MS, 300000),
      // P3-005 FIX: Add configurable max active pairs limit
      maxActivePairs: config?.maxActivePairs ?? safeParseInt(process.env.MAX_ACTIVE_PAIRS, 10000),
      // FIX Config 3.2: Environment-aware alert cooldown
      // Development: 30 seconds (faster feedback cycle)
      // Production: 5 minutes (prevent alert spam)
      // P2-12 FIX: Use ?? instead of || for env var — empty string is not a valid cooldown
      alertCooldownMs: config?.alertCooldownMs ?? safeParseInt(
        process.env.ALERT_COOLDOWN_MS ??
        (process.env.NODE_ENV === 'development' ? '30000' : '300000'),
        300000
      ),
      // OP-22 FIX: Configurable execution circuit breaker thresholds
      executionCbThreshold: config?.executionCbThreshold ?? safeParseInt(process.env.EXECUTION_CB_THRESHOLD, 5),
      executionCbResetMs: config?.executionCbResetMs ?? safeParseInt(process.env.EXECUTION_CB_RESET_MS, 60000),
      // P0-3 FIX: enableLegacyHealthPolling REMOVED - all services use streams (ADR-002)
    };

    // OP-22 FIX: Initialize CB with configurable thresholds (previously hardcoded 5, 60000)
    this.executionCircuitBreaker = new SimpleCircuitBreaker(
      this.config.executionCbThreshold!,
      this.config.executionCbResetMs!
    );

    // FIX: Initialize configurable constants from config
    this.MAX_OPPORTUNITIES = this.config.maxOpportunities!;
    this.OPPORTUNITY_TTL_MS = this.config.opportunityTtlMs!;
    this.OPPORTUNITY_CLEANUP_INTERVAL_MS = this.config.opportunityCleanupIntervalMs!;

    // P1-2: Initialize extracted ActivePairsTracker
    this.activePairsTracker = new ActivePairsTracker(
      this.logger,
      {
        pairTtlMs: this.config.pairTtlMs!,
        maxActivePairs: this.config.maxActivePairs!,
      }
    );

    // FIX: Initialize alert notifier for sending alerts to external channels
    // P0-002 FIX: Add defensive initialization with fallback
    try {
      this.alertNotifier = new AlertNotifier(this.logger);
    } catch (error) {
      this.logger.error('Failed to initialize AlertNotifier, alerts will be logged only', {
        error: getErrorMessage(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      // Keep alertNotifier as null - alerts will still be logged via sendAlert()
      // but won't be sent to external channels (Discord/Slack)
    }

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

    // R2: Initialize alert cooldown manager with HealthMonitor as delegate
    // This centralizes cooldown logic and eliminates duplicate code
    this.alertCooldownManager = new AlertCooldownManager(
      this.logger,
      this.healthMonitor,
      { cooldownMs: this.config.alertCooldownMs }
    );

    // REFACTOR: Initialize standby activation manager (uses getters for lazy deps)
    this.standbyActivationManager = new StandbyActivationManager({
      logger: this.logger,
      getLeadershipElection: () => this.leadershipElection,
      getIsLeader: () => this.getIsLeader(),
      getIsStandby: () => this.config.isStandby ?? false,
      getCanBecomeLeader: () => this.config.canBecomeLeader ?? true,
      instanceId: this.config.leaderElection.instanceId,
      regionId: this.config.regionId,
      onActivationSuccess: () => { this.config.isStandby = false; },
      setIsActivating: (value) => { this.isActivating = value; },
    });

    // Define consumer groups for all streams we need to consume
    // Includes swap-events, volume-aggregates, and price-updates for analytics and monitoring
    //
    // P1-3 DESIGN NOTE: startId: '$' (only new messages) is INTENTIONAL for a trading system:
    // - Stale opportunities are dangerous to execute (prices may have moved)
    // - Stale price updates would corrupt our price state
    // - Processing old messages after restart could cause bad trades
    // If messages arrive during coordinator downtime, they're intentionally skipped.
    // Use recoverPendingMessages() for messages that were being processed during crash.
    this.consumerGroups = [
      {
        streamName: RedisStreamsClient.STREAMS.HEALTH,
        groupName: this.config.consumerGroup,
        consumerName: this.config.consumerId,
        startId: '$', // Only new messages - stale health data not useful
        resetToStartIdOnExistingGroup: true
      },
      {
        streamName: RedisStreamsClient.STREAMS.OPPORTUNITIES,
        groupName: this.config.consumerGroup,
        consumerName: this.config.consumerId,
        startId: '$',
        resetToStartIdOnExistingGroup: true
      },
      {
        streamName: RedisStreamsClient.STREAMS.WHALE_ALERTS,
        groupName: this.config.consumerGroup,
        consumerName: this.config.consumerId,
        startId: '$',
        resetToStartIdOnExistingGroup: true
      },
      {
        streamName: RedisStreamsClient.STREAMS.SWAP_EVENTS,
        groupName: this.config.consumerGroup,
        consumerName: this.config.consumerId,
        startId: '$',
        resetToStartIdOnExistingGroup: true
      },
      {
        streamName: RedisStreamsClient.STREAMS.VOLUME_AGGREGATES,
        groupName: this.config.consumerGroup,
        consumerName: this.config.consumerId,
        startId: '$',
        resetToStartIdOnExistingGroup: true
      },
      // S3.3.5 FIX: Add PRICE_UPDATES consumer for Solana price feed integration
      {
        streamName: RedisStreamsClient.STREAMS.PRICE_UPDATES,
        groupName: this.config.consumerGroup,
        consumerName: this.config.consumerId,
        startId: '$',
        resetToStartIdOnExistingGroup: true
      },
      // OP-10 FIX: Consume execution results to populate successfulExecutions/totalProfit
      {
        streamName: RedisStreamsClient.STREAMS.EXECUTION_RESULTS,
        groupName: this.config.consumerGroup,
        consumerName: this.config.consumerId,
        startId: '$',
        resetToStartIdOnExistingGroup: true
      }
    ];

    // REFACTORED: Use extracted middleware and routes from api/ folder
    configureMiddleware(this.app, this.logger);
    this.setupRoutes(); // Logs auth status and calls setupAllRoutes
  }

  // ===========================================================================
  // Lifecycle Methods
  // ===========================================================================

  /**
   * Start the Coordinator Service.
   *
   * Initializes all subsystems:
   * - Redis clients (Streams and standard)
   * - Stream consumers for health/opportunities/events
   * - HTTP API server with authentication and rate limiting
   * - Leader election (if not standby)
   * - Periodic health reporting and cleanup tasks
   *
   * Uses ServiceStateManager to prevent concurrent starts.
   * Automatically attempts leadership acquisition if canBecomeLeader is true.
   *
   * @param port - Optional port override (defaults to config.port)
   * @throws Error if service is already starting/started or initialization fails
   * @see ADR-007 for standby and failover behavior
   * @see ADR-002 for Redis Streams architecture
   */
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
          maxStreamErrors: 10, // Threshold before alerting
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

      // P0-4 FIX: Seed the coordinator's own serviceHealth entry at startup
      // before the health monitor starts. This prevents detectStaleServices()
      // from seeing an absent/ancient coordinator entry during the startup phase.
      this.serviceHealth.set('coordinator', {
        name: 'coordinator',
        status: 'healthy',
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage().heapUsed,
        cpuUsage: 0,
        lastHeartbeat: Date.now(),
      });

      // R2: Start health monitor (records start time for grace period)
      this.healthMonitor?.start();

      // Create consumer groups for all streams
      await this.createConsumerGroups();

      // P0-FIX 1.3: Recover pending messages from previous coordinator instance
      // R2 REFACTOR: Use StreamConsumerManager for pending message recovery
      await this.streamConsumerManager.recoverPendingMessages(
        this.consumerGroups.map(g => ({
          streamName: g.streamName,
          groupName: g.groupName,
          consumerName: g.consumerName,
        }))
      );

      // Configure StreamHealthMonitor to use our consumer group
      // This fixes the XPENDING errors when monitoring stream health
      const streamHealthMonitor = this.deps.getStreamHealthMonitor();
      streamHealthMonitor.setConsumerGroup(this.config.consumerGroup);

      // P1-8 FIX: Initialize and start LeadershipElectionService (replaces inline leadership code)
      this.leadershipElection = new LeadershipElectionService({
        config: this.config.leaderElection,
        redis: this.redis,
        logger: this.logger,
        isStandby: this.config.isStandby ?? false,
        canBecomeLeader: this.config.canBecomeLeader ?? true,
        onAlert: (alert) => this.sendAlert({
          type: alert.type,
          message: alert.message,
          // P1-8 FIX: Map LeadershipElectionService severity to coordinator AlertSeverity
          // 'info' → 'low' (coordinator uses 'low' instead of 'info')
          severity: alert.severity === 'info' ? 'low' : alert.severity,
          data: alert.data,
          timestamp: alert.timestamp,
        }),
        onLeadershipChange: (isLeader: boolean) => {
          // P1-8 FIX: Update local isLeader field when leadership status changes
          this.isLeader = isLeader;
          this.logger.info('Leadership status changed', { isLeader });
        },
      });

      // P1-8 FIX: Start leadership election service (replaces tryAcquireLeadership + startLeaderHeartbeat)
      await this.leadershipElection.start();

      // REFACTOR: Removed isRunning = true - stateManager.executeStart() handles state
      // The stateManager transitions to 'running' state after this callback completes

      // Start stream consumers (run even as standby for monitoring)
      // FIX: Await the async method for proper error handling
      await this.startStreamConsumers();

      // P1-8 FIX: LeadershipElectionService now manages heartbeat internally
      // Removed: this.startLeaderHeartbeat()

      // Start periodic health monitoring
      this.startHealthMonitoring();

      // REFACTOR: Start opportunity cleanup on separate interval (prevents race conditions)
      this.startOpportunityCleanup();

      // Start HTTP server
      // In production, bind to localhost if no auth is configured to prevent
      // exposing admin endpoints (restart, alerts) on public interfaces
      const isProduction = process.env.NODE_ENV === 'production';
      const authConfigured = isAuthEnabled();
      const bindHost = (isProduction && !authConfigured) ? '127.0.0.1' : undefined;

      if (isProduction && !authConfigured) {
        this.logger.warn(
          'Production mode with no authentication configured — binding to 127.0.0.1 only. ' +
          'Set JWT_SECRET or API_KEYS to bind on all interfaces.',
          { port: serverPort }
        );
      }

      const listenCallback = () => {
        this.logger.info(`Coordinator dashboard available at http://${bindHost ?? 'localhost'}:${serverPort}`, {
          isLeader: this.isLeader,
          bindHost: bindHost ?? '0.0.0.0',
          authEnabled: authConfigured,
        });
      };

      if (bindHost) {
        this.server = this.app.listen(serverPort, bindHost, listenCallback);
      } else {
        this.server = this.app.listen(serverPort, listenCallback);
      }

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

  /**
   * Stop the Coordinator Service gracefully.
   *
   * Performs orderly shutdown of all subsystems:
   * - Releases leadership lock (if leader)
   * - Stops all periodic intervals (health reporting, cleanup)
   * - Disconnects stream consumers
   * - Closes HTTP server
   * - Disconnects Redis clients
   *
   * Uses ServiceStateManager to prevent concurrent stops.
   * Idempotent - safe to call multiple times.
   *
   * @throws Error if shutdown fails (logged but not re-thrown)
   */
  async stop(): Promise<void> {
    // Use state manager to prevent concurrent stops (P0 fix)
    const result = await this.stateManager.executeStop(async () => {
      this.logger.info('Stopping Coordinator Service');
      // REFACTOR: Removed isRunning = false - stateManager.executeStop() handles state
      // The stateManager transitions to 'stopping' immediately upon entering this callback

      // P1-8 FIX: Signal opportunity router shutdown to cancel in-flight retry delays
      this.opportunityRouter?.shutdown();

      // OP-11 FIX: Stop consumers BEFORE releasing leadership to prevent
      // duplicate execution if a new coordinator acquires leadership while
      // old consumers are still running
      await this.clearAllIntervals();

      // P1-8 FIX: Stop leadership election service (replaces releaseLeadership)
      // This handles leadership release and heartbeat cleanup internally
      if (this.leadershipElection) {
        await this.leadershipElection.stop();
      }

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
      await disconnectWithTimeout(this.streamsClient, 'Streams client', 5000, this.logger);
      this.streamsClient = null;

      // P0-NEW-6 FIX: Disconnect legacy Redis with timeout
      await disconnectWithTimeout(this.redis, 'Redis', 5000, this.logger);
      this.redis = null;

      // Clear collections
      this.serviceHealth.clear();
      this.alertCooldownManager?.clear();
      this.opportunities.clear();
      // FIX: Clear activePairs to prevent stale data on restart
      this.activePairsTracker?.clear();
      // R2 REFACTOR: Reset stream consumer manager state
      this.streamConsumerManager?.reset();

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
    // P2-11: Use IntervalManager for centralized cleanup
    await this.intervalManager.clearAll();

    // H1 FIX: Use Promise.allSettled to ensure all consumers are stopped even if
    // some throw. Promise.all rejects on first error, losing subsequent results.
    const results = await Promise.allSettled(this.streamConsumers.map(c => c.stop()));
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.error('Failed to stop stream consumer during shutdown', {
          error: (result.reason as Error).message,
        });
      }
    }
    this.streamConsumers = [];
  }

  // ===========================================================================
  // Leader Election (ADR-007)
  // ===========================================================================
  //
  // P1-8 FIX: Leadership election now delegated to LeadershipElectionService
  // The following methods have been REMOVED and replaced by the service:
  //   - tryAcquireLeadership() → leadershipElection.tryAcquireLeadership()
  //   - renewLeaderLock() → handled internally by service heartbeat
  //   - releaseLeadership() → leadershipElection.stop()
  //   - startLeaderHeartbeat() → handled internally by service.start()
  //
  // Benefits of this refactoring (P1-8):
  //   - Single source of truth for leadership logic (~164 lines removed)
  //   - Reusable service (already tested with 409-line implementation)
  //   - Cleaner separation of concerns
  //   - Easier to test leadership behavior in isolation
  //
  // See: ./leadership/leadership-election-service.ts for implementation
  // ===========================================================================

  // ===========================================================================
  // Redis Streams Consumer Groups (ADR-002)
  // ===========================================================================

  private async createConsumerGroups(): Promise<void> {
    if (!this.streamsClient) return;

    // OP-19 FIX: Track creation failures and warn if ALL groups fail
    let successCount = 0;
    let failureCount = 0;

    for (const config of this.consumerGroups) {
      try {
        await this.streamsClient.createConsumerGroup(config);
        successCount++;
        this.logger.info('Consumer group ready', {
          stream: config.streamName,
          group: config.groupName
        });
      } catch (error) {
        failureCount++;
        this.logger.error('Failed to create consumer group', {
          error,
          stream: config.streamName
        });
      }
    }

    // OP-19 FIX: Alert if any consumer groups failed to create
    if (failureCount > 0) {
      const message = `${failureCount}/${failureCount + successCount} consumer groups failed to create`;
      this.logger.warn(message, { successCount, failureCount });
      // If ALL consumer groups failed, the coordinator is non-functional
      if (successCount === 0 && failureCount > 0) {
        this.logger.error('CRITICAL: All consumer groups failed - coordinator cannot consume streams', {
          failureCount,
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
    if (!this.streamsClient || !this.streamConsumerManager) return;

    // Raw handler map for each stream (will be wrapped by streamConsumerManager)
    const rawHandlers: Record<string, (msg: StreamMessage) => Promise<void>> = {
      [RedisStreamsClient.STREAMS.HEALTH]: (msg) => this.handleHealthMessage(msg),
      [RedisStreamsClient.STREAMS.OPPORTUNITIES]: (msg) => this.handleOpportunityMessage(msg),
      [RedisStreamsClient.STREAMS.WHALE_ALERTS]: (msg) => this.handleWhaleAlertMessage(msg),
      [RedisStreamsClient.STREAMS.SWAP_EVENTS]: (msg) => this.handleSwapEventMessage(msg),
      [RedisStreamsClient.STREAMS.VOLUME_AGGREGATES]: (msg) => this.handleVolumeAggregateMessage(msg),
      [RedisStreamsClient.STREAMS.PRICE_UPDATES]: (msg) => this.handlePriceUpdateMessage(msg),
      // OP-10 FIX: Consume execution results to populate successfulExecutions/totalProfit
      [RedisStreamsClient.STREAMS.EXECUTION_RESULTS]: (msg) => this.handleExecutionResultMessage(msg),
    };

    // REFACTOR: Use injected StreamConsumer class for testability
    // Create a StreamConsumer for each consumer group
    const StreamConsumerClass = this.deps.StreamConsumer;
    for (const groupConfig of this.consumerGroups) {
      const rawHandler = rawHandlers[groupConfig.streamName];
      if (!rawHandler) continue;

      // R2 REFACTOR: Use StreamConsumerManager.wrapHandler for combined rate limiting + deferred ACK
      // This replaces duplicate withRateLimit/withDeferredAck methods
      const wrappedHandler = this.streamConsumerManager.wrapHandler(
        {
          streamName: groupConfig.streamName,
          groupName: groupConfig.groupName,
          consumerName: groupConfig.consumerName,
        },
        rawHandler
      );

      const consumer = new StreamConsumerClass(this.streamsClient, {
        config: groupConfig,
        handler: wrappedHandler,
        batchSize: 10,
        blockMs: 1000, // Block for 1s - immediate delivery when messages arrive
        autoAck: false, // Deferred ACK - handled by streamConsumerManager.wrapHandler
        logger: {
          error: (msg, ctx) => {
            this.logger.error(msg, ctx);
            // R2 REFACTOR: Use StreamConsumerManager for error tracking
            this.streamConsumerManager!.trackError(groupConfig.streamName);
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
  // ===========================================================================
  // Stream Message Handlers
  // ===========================================================================
  //
  // P2-001 FIX: Handlers should NOT catch errors internally.
  // StreamConsumerManager.withDeferredAck() wraps all handlers with:
  // - Error catching
  // - DLQ forwarding on failure
  // - Message ACK
  //
  // Handlers should throw errors to signal failure, which will:
  // 1. Log error (by wrapper)
  // 2. Move message to DLQ (for manual review)
  // 3. ACK message (prevent infinite retries)
  //
  // This pattern ensures failed messages are captured for debugging
  // rather than being silently swallowed.
  // ===========================================================================

  // P2 FIX: Use StreamMessage type instead of any
  private async handleHealthMessage(message: StreamMessage): Promise<void> {
    const data = message.data;
    if (!data || typeof data !== 'object') {
      this.logger.debug('Skipping health message - null or invalid data', { messageId: message.id });
      return;
    }
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

    // P0-4 FIX: Skip overwriting the coordinator's own serviceHealth entry from Redis.
    // The coordinator's entry is maintained directly in startHealthMonitoring() (F3 FIX).
    // Consuming its own round-tripped health message would overwrite the fresh local
    // lastHeartbeat with a potentially older Redis timestamp, causing detectStaleServices()
    // to see a stale coordinator heartbeat between the Redis round-trip and the next
    // local update — triggering false health oscillation.
    if (serviceName !== 'coordinator') {
      this.serviceHealth.set(serviceName, health);
    }

    // FIX #2: Record heartbeat so HealthMonitor's grace period logic works.
    // Without this, firstHeartbeatReceived is never populated, and the C4 FIX
    // grace period check in detectStaleServices() is dead code — causing
    // continuous degradation oscillation despite healthy services.
    this.healthMonitor?.recordHeartbeat(serviceName);

    this.logger.debug('Health update received', {
      name: serviceName,
      status: health.status
    });

    // P2-5: Do not reset stream errors from health messages.
    // Health messages arrive every 5-10s and would mask real stream errors,
    // making the consecutive error threshold unreachable.
  }

  // P1-1 fix: Maximum opportunities to track (prevents unbounded memory growth)
  // FIX: Now configurable via CoordinatorConfig
  private readonly MAX_OPPORTUNITIES: number;
  private readonly OPPORTUNITY_TTL_MS: number;
  private readonly OPPORTUNITY_CLEANUP_INTERVAL_MS: number;

  // P2 FIX: Use StreamMessage type instead of any
  // R2: Delegates to OpportunityRouter for processing
  private async handleOpportunityMessage(message: StreamMessage): Promise<void> {
    const data = message.data as Record<string, unknown>;

    // OP-3 FIX: Extract or create trace context for cross-service correlation.
    // If the upstream detector included trace context, continue the trace chain.
    // Otherwise, start a new trace rooted at the coordinator.
    const parentCtx = extractContext(data);
    const traceCtx: TraceContext = parentCtx
      ? createChildContext(parentCtx, 'coordinator')
      : createTraceContext('coordinator');

    // R2: Delegate to opportunity router
    if (this.opportunityRouter) {
      // P2 FIX #19: Use getIsLeader() to always read canonical leadership state
      // OP-3 FIX: Pass trace context for propagation to execution engine
      const processed = await this.opportunityRouter.processOpportunity(data, this.getIsLeader(), traceCtx);
      if (processed) {
        // Update local metrics from router
        this.systemMetrics.totalOpportunities = this.opportunityRouter.getTotalOpportunities();
        this.systemMetrics.pendingOpportunities = this.opportunityRouter.getPendingCount();
        this.systemMetrics.totalExecutions = this.opportunityRouter.getTotalExecutions();
        // P0 FIX #3: Only reset errors when opportunity is successfully processed.
        // Previously called on every message (including duplicates and rejects),
        // which masked legitimate stream consumer errors by resetting the counter.
        this.streamConsumerManager?.resetErrors();
      }
      // P1-7 FIX: Always sync dropped opportunities (not just when processed)
      this.systemMetrics.opportunitiesDropped = this.opportunityRouter.getOpportunitiesDropped();
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
    if (existing && Math.abs((existing.timestamp ?? 0) - opportunityTimestamp) < 5000) {
      this.logger.debug('Duplicate opportunity detected, skipping', {
        id: opportunityId,
        existingTimestamp: existing.timestamp,
        newTimestamp: opportunityTimestamp
      });
      // P0 FIX #3: Do not reset errors on duplicate/rejected messages
      return;
    }

    const profitPercentage = getOptionalNumber(data, 'profitPercentage');
    if (profitPercentage !== undefined) {
      if (profitPercentage < -100 || profitPercentage > 10000) {
        this.logger.warn('Invalid profit percentage, rejecting opportunity', {
          id: opportunityId,
          profitPercentage,
          reason: profitPercentage < -100 ? 'below_minimum' : 'above_maximum'
        });
        // P0 FIX #3: Do not reset errors on duplicate/rejected messages
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

    // P2 FIX #19: Use getIsLeader() to always read canonical leadership state
    if (this.getIsLeader() && (opportunity.status === 'pending' || opportunity.status === undefined)) {
      await this.forwardToExecutionEngine(opportunity);
    }

    this.streamConsumerManager?.resetErrors();
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
        ([, a], [, b]) => (a.timestamp ?? 0) - (b.timestamp ?? 0)
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
    // P2-11: Use IntervalManager for centralized lifecycle management
    this.intervalManager.set(
      'opportunity-cleanup',
      () => {
        if (!this.stateManager.isRunning()) return;

        try {
          this.cleanupExpiredOpportunities();
        } catch (error) {
          this.logger.error('Opportunity cleanup failed', { error });
        }
      },
      this.OPPORTUNITY_CLEANUP_INTERVAL_MS
    );

    this.logger.info('Opportunity cleanup interval started', {
      intervalMs: this.OPPORTUNITY_CLEANUP_INTERVAL_MS,
      maxOpportunities: this.MAX_OPPORTUNITIES,
      ttlMs: this.OPPORTUNITY_TTL_MS
    });
  }

  // P2 FIX: Use StreamMessage type instead of any
  private async handleWhaleAlertMessage(message: StreamMessage): Promise<void> {
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

    // P2-5: Do not reset stream errors from whale alerts.
    // Only the opportunity handler (primary data path) should reset errors.
  }

  // P1-2: Active pairs tracking extracted to ActivePairsTracker class
  // Provides TTL-based cleanup and emergency eviction with hysteresis
  private activePairsTracker: ActivePairsTracker | null = null;

  /**
   * @deprecated Access via activePairsTracker instead. Kept for backward compat in tests.
   * Returns the internal Map from activePairsTracker for test access via (coordinator as any).activePairs
   */
  private get activePairs(): ActivePairsTracker | null {
    return this.activePairsTracker;
  }

  /**
   * Handle swap event messages from stream:swap-events.
   * Tracks swap activity for analytics and market monitoring.
   *
   * Note: Raw swap events are filtered by SwapEventFilter in detectors before publishing.
   * Only significant swaps (>$10 USD, deduplicated) reach this handler.
   */
  private async handleSwapEventMessage(message: StreamMessage): Promise<void> {
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
    // P2 FIX #15: Guard against precision loss at Number.MAX_SAFE_INTEGER.
    // At realistic volumes (<$1B/day), this takes ~24,000 years to hit.
    // Cap at MAX_SAFE_INTEGER to prevent silent precision degradation.
    if (this.systemMetrics.totalVolumeUsd < Number.MAX_SAFE_INTEGER - usdValue) {
      this.systemMetrics.totalVolumeUsd += usdValue;
    }

    // P3-005 FIX: Track active pairs with size limit enforcement
    this.trackActivePair(pairAddress, chain, dex);

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

    // P2-5: Do not reset stream errors from swap events.
    // Only the opportunity handler (primary data path) should reset errors.
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

    // P3-005 FIX: Track active pairs with size limit enforcement
    this.trackActivePair(pairAddress, chain, dex);

    // Skip detailed logging for empty windows (no swaps in this 5s period)
    if (swapCount === 0) {
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

    // P2-5: Do not reset stream errors from volume aggregates.
    // Only the opportunity handler (primary data path) should reset errors.
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
    const data = message.data as Record<string, unknown>;
    if (!data) return;

    // Unwrap batch envelopes from StreamBatcher (ADR-002 batching)
    // For non-batched messages, returns single-element array (backward compatible)
    const items = unwrapBatchMessages<Record<string, unknown>>(data);

    let validCount = 0;
    for (const item of items) {
      // FIX: Use unwrapMessageData for cleaner wrapped/direct handling
      const rawUpdate = unwrapMessageData(item);
      const chain = getString(rawUpdate, 'chain', 'unknown');
      const dex = getString(rawUpdate, 'dex', 'unknown');
      const pairKey = getString(rawUpdate, 'pairKey', '');

      if (!pairKey) {
        this.logger.debug('Skipping price update - missing pairKey', { messageId: message.id });
        continue;
      }

      validCount++;
      // Update metrics
      this.systemMetrics.priceUpdatesReceived++;

      // P3-005 FIX: Track active pairs with size limit enforcement
      this.trackActivePair(pairKey, chain, dex);
    }

    if (validCount === 0 && items.length > 0) {
      this.logger.debug('All items in batch filtered out (missing pairKey)', {
        messageId: message.id,
        batchSize: items.length,
      });
    }

    // P2-5: Do not reset stream errors from price updates.
    // Only the opportunity handler (primary data path) should reset errors.
  }

  /**
   * OP-10 FIX: Handle execution result messages from stream:execution-results.
   * Updates successfulExecutions and totalProfit metrics that were previously always zero.
   *
   * The execution engine publishes results after each trade attempt.
   * The coordinator consumes these to maintain aggregate trading metrics
   * for the dashboard and health monitoring.
   *
   * @see services/execution-engine/src/engine.ts publishExecutionResult()
   * @see shared/types/src/execution.ts ExecutionResult interface
   */
  private async handleExecutionResultMessage(message: StreamMessage): Promise<void> {
    const data = message.data as Record<string, unknown>;
    if (!data) return;

    const rawResult = unwrapMessageData(data);
    const success = rawResult.success === true || rawResult.success === 'true';
    const opportunityId = getString(rawResult, 'opportunityId', '');
    const chain = getString(rawResult, 'chain', 'unknown');

    if (!opportunityId) {
      this.logger.debug('Skipping execution result - missing opportunityId', {
        messageId: message.id,
      });
      return;
    }

    if (success) {
      this.systemMetrics.successfulExecutions++;
      const actualProfit = getNumber(rawResult, 'actualProfit', 0);
      if (actualProfit > 0) {
        this.systemMetrics.totalProfit += actualProfit;
      }
      this.logger.info('Execution result: success', {
        opportunityId,
        chain,
        actualProfit,
        totalSuccessful: this.systemMetrics.successfulExecutions,
      });
    } else {
      const error = getOptionalString(rawResult, 'error');
      this.logger.debug('Execution result: failure', {
        opportunityId,
        chain,
        error,
      });
    }

    // P2-5: Do not reset stream errors from execution results.
    // Only the opportunity handler (primary data path) should reset errors.
  }

  /**
   * P1-2: Delegates to ActivePairsTracker.cleanup().
   * Kept as method for backward compatibility with integration tests.
   */
  private cleanupActivePairs(): void {
    this.activePairsTracker!.cleanup();
    this.systemMetrics.activePairsTracked = this.activePairsTracker!.size;
  }

  /**
   * P1-2: Delegates to ActivePairsTracker.trackPair().
   * Kept as method for backward compatibility with startStreamConsumers handler map.
   */
  private trackActivePair(pairKey: string, chain: string, dex: string): void {
    this.activePairsTracker!.trackPair(pairKey, chain, dex);
    this.systemMetrics.activePairsTracked = this.activePairsTracker!.size;
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
      // P1-7 FIX: Track dropped opportunity
      this.systemMetrics.opportunitiesDropped++;
      this.logger.warn('Cannot forward opportunity - streams client not initialized', {
        id: opportunity.id,
        totalDropped: this.systemMetrics.opportunitiesDropped
      });
      return;
    }

    // FIX P2: Check circuit breaker before attempting to forward
    if (this.isExecutionCircuitOpen()) {
      // P1-7 FIX: Track dropped opportunity due to circuit breaker
      this.systemMetrics.opportunitiesDropped++;
      this.logger.debug('Execution circuit open, skipping opportunity forwarding', {
        id: opportunity.id,
        failures: this.executionCircuitBreaker.getFailures(),
        totalDropped: this.systemMetrics.opportunitiesDropped
      });
      return;
    }

    // P1 Fix: End-to-end backpressure — skip forwarding when execution stream is
    // near MAXLEN capacity. Dropping newest opportunities is safer than having MAXLEN
    // trim oldest (potentially in-progress) messages from the stream.
    if (this.cachedExecutionStreamDepthRatio > 0.95) {
      this.systemMetrics.opportunitiesDropped++;
      this.logger.warn('Execution stream backpressure — skipping forwarding', {
        id: opportunity.id,
        depthRatio: this.cachedExecutionStreamDepthRatio,
        totalDropped: this.systemMetrics.opportunitiesDropped,
        action: 'Execution engine may be overloaded — check consumer health',
      });
      return;
    }

    try {
      // Phase 0 instrumentation: stamp coordinator timestamp before serialization
      const timestamps = opportunity.pipelineTimestamps ?? {};
      timestamps.coordinatorAt = Date.now();
      opportunity.pipelineTimestamps = timestamps;

      // Publish to execution-requests stream for the execution engine to consume
      // FIX #12: Use shared serialization utility (single source of truth)
      // @see OP-6: Use xaddWithLimit to prevent unbounded stream growth
      await this.streamsClient.xaddWithLimit(
        RedisStreamsClient.STREAMS.EXECUTION_REQUESTS,
        serializeOpportunityForStream(opportunity, this.config.leaderElection.instanceId)
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

      // P1-7 FIX: Track dropped opportunity on error
      this.systemMetrics.opportunitiesDropped++;

      this.logger.error('Failed to forward opportunity to execution engine', {
        id: opportunity.id,
        error: (error as Error).message,
        circuitFailures: this.executionCircuitBreaker.getFailures(),
        totalDropped: this.systemMetrics.opportunitiesDropped
      });

      // Send alert for execution forwarding failures (only if circuit not already open)
      // Use getStatus().isOpen to check raw open state (not affected by half-open logic)
      if (!this.executionCircuitBreaker.getStatus().isOpen) {
        this.sendAlert({
          type: 'EXECUTION_FORWARD_FAILED',
          message: `Failed to forward opportunity ${opportunity.id}: ${(error as Error).message}`,
          severity: 'high',
          data: { opportunityId: opportunity.id, chain: opportunity.chain, totalDropped: this.systemMetrics.opportunitiesDropped },
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
      priceUpdatesReceived: 0,
      // P1-7 FIX: Track dropped opportunities
      opportunitiesDropped: 0
    };
  }

  private startHealthMonitoring(): void {
    // P2-11: Use IntervalManager for centralized lifecycle management
    // Update metrics periodically
    this.intervalManager.set(
      'metrics-update',
      async () => {
        // P1-8 FIX: Use stateManager.isRunning() for consistency
        if (!this.stateManager.isRunning()) return;

        try {
          // P0-4 FIX: Update the coordinator's own serviceHealth entry BEFORE
          // updateSystemMetrics(), which calls detectStaleServices().
          // Previously, the F3 FIX was placed AFTER updateSystemMetrics(), meaning
          // detectStaleServices() would see the coordinator's old lastHeartbeat and
          // mark it as stale — causing health oscillation (50-100%) and false
          // degradation level changes.
          this.serviceHealth.set('coordinator', {
            name: 'coordinator',
            status: this.stateManager.isRunning() ? 'healthy' : 'unhealthy',
            uptime: process.uptime(),
            memoryUsage: process.memoryUsage().heapUsed,
            cpuUsage: this.cpuTracker.getUsagePercent(),
            lastHeartbeat: Date.now(),
          });

          this.updateSystemMetrics();
          this.checkForAlerts();

          // Report own health to stream (for other services to consume)
          await this.reportHealth();

          // P1 Fix: Monitor execution stream depth for backpressure detection.
          // Cached value is checked in forwardToExecution() to prevent message loss.
          if (this.streamsClient) {
            const lag = await this.streamsClient.checkStreamLag(
              RedisStreamsClient.STREAMS.EXECUTION_REQUESTS
            );
            this.cachedExecutionStreamDepthRatio = lag.lagRatio;
          }

        } catch (error) {
          this.logger.error('Metrics update failed', { error });
        }
      },
      5000
    );

    // P0-3 FIX: Legacy health polling REMOVED (was deprecated since v2.0.0)
    // All services now use Redis Streams exclusively (ADR-002)
    // See REFACTORING_IMPLEMENTATION_PLAN.md P0-3 for details

    // M4 FIX: Pipeline starvation detection — check stream depths every 60s.
    // Alerts when detectors are healthy but execution pipeline has been idle for 5+ minutes.
    this.intervalManager.set(
      'pipeline-starvation-check',
      async () => {
        if (!this.stateManager.isRunning()) return;
        if (!this.streamsClient) return;

        try {
          await this.checkPipelineStarvation();
        } catch (error) {
          this.logger.debug('Pipeline starvation check failed (best-effort)', { error });
        }
      },
      60_000
    );

    // FIX P1: Use dedicated interval for cleanup operations
    // This runs regardless of legacy polling mode to ensure cleanup always happens
    // Previous bug: cleanup only ran if legacy polling was disabled due to ?? operator
    this.intervalManager.set(
      'general-cleanup',
      () => {
        if (!this.stateManager.isRunning()) return;

        try {
          // P2-3 FIX: Periodically cleanup stale alert cooldowns to prevent memory leak
          this.alertCooldownManager?.cleanup(Date.now());

          // Cleanup stale active pairs to prevent unbounded memory growth
          this.cleanupActivePairs();
        } catch (error) {
          this.logger.error('Cleanup operations failed', { error });
        }
      },
      10000
    );
  }

  /**
   * M4 FIX: Check for pipeline starvation — detectors healthy but no execution requests.
   * Uses XLEN to check stream depths without blocking.
   */
  private async checkPipelineStarvation(): Promise<void> {
    if (!this.streamsClient) return;

    // Skip during startup grace period
    if (Date.now() - this.startTime < CoordinatorService.STARTUP_GRACE_PERIOD_MS) return;

    const executionRequestsLen = await this.streamsClient.xlen(
      RedisStreamsClient.STREAMS.EXECUTION_REQUESTS
    );

    // If execution requests exist, pipeline is active
    if (executionRequestsLen > 0) {
      this.lastExecutionRequestTime = Date.now();
      this.pipelineStarvationAlerted = false;
      return;
    }

    // Check if any detectors are healthy
    const healthyDetectors = Array.from(this.serviceHealth.values()).filter(
      s => s.status === 'healthy' && s.name !== 'coordinator' && s.name !== 'execution-engine'
    );

    if (healthyDetectors.length === 0) {
      // No healthy detectors — starvation is expected, not an alert condition
      return;
    }

    // Initialize tracking on first check
    if (this.lastExecutionRequestTime === 0) {
      this.lastExecutionRequestTime = Date.now();
      return;
    }

    const starvationDuration = Date.now() - this.lastExecutionRequestTime;
    if (starvationDuration >= CoordinatorService.PIPELINE_STARVATION_THRESHOLD_MS && !this.pipelineStarvationAlerted) {
      this.pipelineStarvationAlerted = true;
      this.sendAlert({
        type: 'PIPELINE_STARVATION',
        service: 'coordinator',
        severity: 'warning',
        message: `Pipeline starved: ${healthyDetectors.length} healthy detector(s) but 0 execution requests for ${Math.round(starvationDuration / 1000)}s`,
        data: {
          healthyDetectors: healthyDetectors.map(s => s.name),
          starvationDurationMs: starvationDuration,
          executionRequestStreamLen: executionRequestsLen,
        },
        timestamp: Date.now(),
      });
    }
  }

  private async reportHealth(): Promise<void> {
    // P1-8 FIX: Check running state before reporting
    if (!this.streamsClient || !this.stateManager.isRunning()) return;

    try {
      // P2-002 FIX: Include AlertNotifier health status in health report
      const notificationHealth = this.alertNotifier ? {
        hasConfiguredChannels: this.alertNotifier.hasConfiguredChannels(),
        circuitStatus: this.alertNotifier.getCircuitStatus(),
        droppedAlerts: this.alertNotifier.getDroppedAlerts()
      } : null;

      const health = {
        // P3-2 FIX: Use 'name' as primary field for consistency with handleHealthMessage
        name: 'coordinator',
        service: 'coordinator', // Keep for backwards compatibility
        // P1-8 FIX: Use stateManager.isRunning() for consistency
        status: this.stateManager.isRunning() ? 'healthy' : 'unhealthy',
        isLeader: this.getIsLeader(),
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage().heapUsed,
        cpuUsage: this.cpuTracker.getUsagePercent(),
        timestamp: Date.now(),
        metrics: {
          activeServices: this.systemMetrics.activeServices,
          totalOpportunities: this.systemMetrics.totalOpportunities,
          pendingOpportunities: this.systemMetrics.pendingOpportunities
        },
        // P2-002 FIX: Add notification health to health report
        ...(notificationHealth && { notificationHealth })
      };

      await this.streamsClient.xadd(RedisStreamsClient.STREAMS.HEALTH, health);

    } catch (error) {
      this.logger.error('Failed to report health', { error });
    }
  }

  private updateSystemMetrics(): void {
    // R2: Delegate to health monitor for single-pass metrics calculation
    // Note: healthMonitor is always initialized in constructor
    this.healthMonitor!.updateMetrics(this.serviceHealth, this.systemMetrics);

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
    // R2: Delegate to health monitor (always initialized in constructor)
    this.healthMonitor!.evaluateDegradationLevel(this.serviceHealth, this.systemMetrics.systemHealth);
    this.degradationLevel = this.healthMonitor!.getDegradationLevel();
  }

  /**
   * Check if a specific service is healthy.
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
    // R2: Delegate to health monitor (always initialized in constructor)
    this.healthMonitor!.checkForAlerts(this.serviceHealth, this.systemMetrics.systemHealth);
  }

  /**
   * P1-NEW-1 FIX: Send alert with cooldown and periodic cleanup
   * P2 FIX: Use Alert type for proper type safety
   * FIX: Now sends to external channels via AlertNotifier
   * R2: Delegates cooldown tracking to healthMonitor if available
   */
  /**
   * Send an alert with cooldown management.
   * Uses AlertCooldownManager to prevent alert spam.
   */
  private sendAlert(alert: Alert): void {
    const alertKey = AlertCooldownManager.createKey(alert.type, alert.service);

    // Use AlertCooldownManager for cooldown check and recording
    // The manager handles delegation to HealthMonitor and automatic cleanup
    if (!this.alertCooldownManager?.shouldSendAndRecord(alertKey)) {
      return; // Alert is on cooldown, skip
    }

    // Log and send alert
    this.logger.warn('Alert triggered', { ...alert });

    // Send to external channels (Discord/Slack) via AlertNotifier
    if (this.alertNotifier) {
      // Fire and forget - don't await to avoid blocking
      this.alertNotifier.notify(alert).catch(error => {
        this.logger.error('Failed to send alert notification', { error: (error as Error).message });
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
  // ===========================================================================
  // CoordinatorStateProvider Interface Implementation
  // ===========================================================================
  // P3-002 FIX: Added comprehensive JSDoc to all public methods

  /**
   * Check if this coordinator instance is currently the leader.
   *
   * Leadership is required for:
   * - Forwarding opportunities to execution engine
   * - Triggering cross-region failovers
   * - Coordinating system-wide operations
   *
   * @returns true if this instance holds the distributed leader lock
   * @see LeadershipElectionService for leadership election mechanism
   * @see ADR-007 for failover strategy
   */
  getIsLeader(): boolean {
    // P1-8 FIX: Delegate to LeadershipElectionService if available
    // Falls back to local field for backward compatibility
    return this.leadershipElection?.isLeader ?? this.isLeader;
  }

  /**
   * Get the unique identifier for this coordinator instance.
   *
   * The instance ID is used for leader election and distributed locking.
   * Format: `coordinator-{region}-{hostname}-{timestamp}`
   *
   * @returns Unique instance identifier
   */
  getInstanceId(): string {
    return this.config.leaderElection.instanceId;
  }

  /**
   * Get the Redis key used for the distributed leader lock.
   *
   * @returns Redis key for leader lock (default: 'coordinator:leader:lock')
   */
  getLockKey(): string {
    return this.config.leaderElection.lockKey;
  }

  /**
   * Check if the coordinator service is currently running.
   *
   * Uses ServiceStateManager as the single source of truth for lifecycle state.
   * Safe to call at any time, including during initialization or shutdown.
   *
   * @returns true if service is running, false otherwise
   */
  getIsRunning(): boolean {
    // REFACTOR: stateManager is now the single source of truth for running state
    // Returns false if stateManager is not initialized (shouldn't happen in production)
    return this.stateManager?.isRunning() ?? false;
  }

  /**
   * Get a snapshot of all service health statuses.
   *
   * Returns a copy to prevent external mutation of internal state.
   * Health statuses are updated via Redis Streams (ADR-002) from
   * each service's periodic health reports.
   *
   * @returns Map of service name to health status
   * @see handleHealthMessage for how health is updated
   * @see ADR-002 for health reporting architecture
   */
  getServiceHealthMap(): Map<string, ServiceHealth> {
    return new Map(this.serviceHealth);
  }

  /**
   * Get current system-wide metrics.
   *
   * Includes:
   * - Total opportunities detected
   * - Pending opportunities count
   * - Total executions and success rate
   * - Total profit accumulated
   * - Active services count
   * - System health score (0-100)
   * - Various event counters (swaps, alerts, etc.)
   *
   * @returns Copy of current system metrics
   */
  getSystemMetrics(): SystemMetrics {
    return { ...this.systemMetrics };
  }

  /**
   * Get all tracked arbitrage opportunities.
   *
   * Delegates to OpportunityRouter if available (R2 refactoring).
   * Opportunities are automatically cleaned up based on TTL and max count limits.
   *
   * @returns Map of opportunity ID to opportunity data
   * @see OpportunityRouter for opportunity management logic
   */
  getOpportunities(): ReadonlyMap<string, ArbitrageOpportunity> {
    // R2: Delegate to opportunity router if available
    return this.opportunityRouter?.getOpportunities() ?? this.opportunities;
  }

  /**
   * Get all active alert cooldowns.
   *
   * Alert cooldowns prevent duplicate alerts from being sent too frequently.
   * Delegates to AlertCooldownManager (which in turn delegates to HealthMonitor).
   *
   * @returns Map of alert key to last alert timestamp
   * @see HealthMonitor for cooldown logic
   */
  getAlertCooldowns(): Map<string, number> {
    // R2: Delegate to AlertCooldownManager (which delegates to HealthMonitor)
    return this.alertCooldownManager?.getCooldowns() ?? new Map();
  }

  /**
   * Delete a specific alert cooldown entry.
   *
   * Useful for testing or forcing an alert to be sent immediately.
   * Delegates to HealthMonitor for deletion.
   *
   * @param key - Alert cooldown key to delete
   * @returns true if deleted, false if not found
   */
  deleteAlertCooldown(key: string): boolean {
    // R2: Delegate to health monitor for deletion (manager doesn't expose delete)
    return this.healthMonitor?.deleteAlertCooldown(key) ?? false;
  }

  /**
   * Get the logger instance for route handlers.
   *
   * Provides minimal logging interface for HTTP route handlers.
   *
   * @returns Logger instance
   */
  getLogger(): MinimalLogger {
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
   * REFACTOR: Delegates to StandbyActivationManager.
   */
  getIsActivating(): boolean {
    return this.standbyActivationManager?.getIsActivating() ?? false;
  }

  /**
   * Activate a standby coordinator to become the active leader.
   * REFACTOR: Delegates to StandbyActivationManager.
   *
   * @see standby-activation-manager.ts for full implementation
   */
  async activateStandby(): Promise<boolean> {
    if (!this.standbyActivationManager) {
      this.logger.error('StandbyActivationManager not initialized');
      return false;
    }
    return this.standbyActivationManager.activateStandby();
  }
}
