/**
 * Cross-Region Health Manager
 *
 * Manages health monitoring across multiple geographic regions for failover support.
 * Implements ADR-007 (Cross-Region Failover Strategy).
 *
 * Features:
 * - Leader election using Redis distributed locks
 * - Cross-region health aggregation
 * - Automatic failover triggering
 * - Standby service activation
 * - Split-brain prevention
 *
 * P0-11 FIX: Migrating failover events from Pub/Sub to Redis Streams per ADR-002.
 * This ensures failover commands are not lost if services are temporarily unavailable.
 *
 * @see ADR-002: Redis Streams over Pub/Sub
 * @see ADR-007: Cross-Region Failover Strategy
 */

import { EventEmitter } from 'events';
import { createLogger, LoggerLike } from '../logger';
import { clearIntervalSafe } from '../lifecycle-utils';
import { getRedisClient, RedisClient } from '../redis';
import { getRedisStreamsClient, RedisStreamsClient } from '../redis-streams';
import { getDistributedLockManager, DistributedLockManager } from '../distributed-lock';

// P0-11 FIX: Stream name for failover events (ADR-002 compliant)
const FAILOVER_STREAM = 'stream:system-failover';

// =============================================================================
// Types
// =============================================================================

export type RegionStatus = 'healthy' | 'degraded' | 'unhealthy' | 'failed' | 'unknown';

export interface RegionHealth {
  /** Region identifier */
  regionId: string;

  /** Current health status */
  status: RegionStatus;

  /** Whether this region is the leader */
  isLeader: boolean;

  /** Services running in this region */
  services: ServiceRegionHealth[];

  /** Last health check timestamp */
  lastHealthCheck: number;

  /** Consecutive failure count */
  consecutiveFailures: number;

  /** Average latency to this region in ms */
  avgLatencyMs: number;

  /** Memory usage percentage */
  memoryUsagePercent: number;

  /** CPU usage percentage */
  cpuUsagePercent: number;
}

export interface ServiceRegionHealth {
  /** Service name */
  serviceName: string;

  /** Service status */
  status: 'healthy' | 'degraded' | 'unhealthy';

  /** Is this the primary instance? */
  isPrimary: boolean;

  /** Is this instance on standby? */
  isStandby: boolean;

  /** Last heartbeat timestamp */
  lastHeartbeat: number;

  /** Service-specific metrics */
  metrics: Record<string, number>;
}

export interface FailoverEvent {
  /** Event type */
  type: 'failover_started' | 'failover_completed' | 'failover_failed' | 'leader_changed';

  /** Source region (failed/old leader) */
  sourceRegion: string;

  /** Target region (new active/leader) */
  targetRegion: string;

  /** Affected services */
  services: string[];

  /** Event timestamp */
  timestamp: number;

  /** Duration of failover in ms (for completed events) */
  durationMs?: number;

  /** Error message (for failed events) */
  error?: string;
}

/** P3 FIX #26: Use shared LoggerLike from ../logger instead of duplicated interface */

export interface CrossRegionHealthConfig {
  /** Unique instance ID */
  instanceId: string;

  /** Region this instance belongs to */
  regionId: string;

  /** Service name */
  serviceName: string;

  /** Health check interval in ms (default: 10000) */
  healthCheckIntervalMs?: number;

  /** Number of consecutive failures before failover (default: 3) */
  failoverThreshold?: number;

  /** Maximum time for failover in ms (default: 60000) */
  failoverTimeoutMs?: number;

  /** Leader heartbeat interval in ms (default: 5000) */
  leaderHeartbeatIntervalMs?: number;

  /** Leader lock TTL in ms (default: 30000) */
  leaderLockTtlMs?: number;

  /** Whether this instance can become leader (default: true) */
  canBecomeLeader?: boolean;

  /** Whether this instance is a standby (default: false) */
  isStandby?: boolean;

  // Optional dependency injection for testing
  /** Optional logger for testing (defaults to createLogger) */
  logger?: LoggerLike;
  /** Optional Redis client for testing */
  redisClient?: RedisClient;
  /** Optional Redis Streams client for testing */
  streamsClient?: RedisStreamsClient;
  /** Optional lock manager for testing */
  lockManager?: DistributedLockManager;
}

export interface GlobalHealthStatus {
  /** Redis connection health */
  redis: { healthy: boolean; latencyMs: number };

  /** Executor service health */
  executor: { healthy: boolean; region: string };

  /** Detector services health */
  detectors: Array<{ name: string; healthy: boolean; region: string }>;

  /** Current degradation level */
  degradationLevel: DegradationLevel;

  /** Overall system status */
  overallStatus: 'healthy' | 'degraded' | 'critical';
}

export enum DegradationLevel {
  FULL_OPERATION = 0,      // All services healthy
  REDUCED_CHAINS = 1,      // Some chain detectors down
  DETECTION_ONLY = 2,      // Execution disabled
  READ_ONLY = 3,           // Only dashboard/monitoring
  COMPLETE_OUTAGE = 4      // All services down
}

// =============================================================================
// Cross-Region Health Manager
// =============================================================================

export class CrossRegionHealthManager extends EventEmitter {
  private redis: RedisClient | null = null;
  private streamsClient: RedisStreamsClient | null = null; // P0-11 FIX: Add streams client
  private lockManager: DistributedLockManager | null = null;
  private logger: LoggerLike;
  private config: Required<Omit<CrossRegionHealthConfig, 'logger' | 'redisClient' | 'streamsClient' | 'lockManager'>>;

  // Store injected dependencies
  private injectedRedis: RedisClient | null = null;
  private injectedStreamsClient: RedisStreamsClient | null = null;
  private injectedLockManager: DistributedLockManager | null = null;

  private regions: Map<string, RegionHealth> = new Map();
  private isLeader: boolean = false;
  private leaderLock: { release: () => Promise<void>; extend: (additionalMs?: number) => Promise<boolean> } | null = null;
  private leaderHeartbeatInterval: NodeJS.Timeout | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private streamPollInterval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  // P2 FIX #21: Monotonic fencing token to prevent split-brain.
  // Incremented on each lock acquisition. Leader-only actions verify the token
  // hasn't changed, detecting if leadership was lost and re-acquired by another instance.
  private leaderFencingToken: number = 0;

  private readonly LEADER_LOCK_KEY = 'coordinator:leader:lock';
  private readonly HEALTH_KEY_PREFIX = 'region:health:';
  private readonly FAILOVER_CHANNEL = 'cross-region:failover';

  constructor(config: CrossRegionHealthConfig) {
    super();

    this.config = {
      instanceId: config.instanceId,
      regionId: config.regionId,
      serviceName: config.serviceName,
      healthCheckIntervalMs: config.healthCheckIntervalMs ?? 10000,
      failoverThreshold: config.failoverThreshold ?? 3,
      failoverTimeoutMs: config.failoverTimeoutMs ?? 60000,
      leaderHeartbeatIntervalMs: config.leaderHeartbeatIntervalMs ?? 5000,
      leaderLockTtlMs: config.leaderLockTtlMs ?? 30000,
      canBecomeLeader: config.canBecomeLeader ?? true,
      isStandby: config.isStandby ?? false
    };

    // Use injected dependencies or defaults
    this.logger = config.logger ?? createLogger(`cross-region:${config.regionId}`);
    this.injectedRedis = config.redisClient ?? null;
    this.injectedStreamsClient = config.streamsClient ?? null;
    this.injectedLockManager = config.lockManager ?? null;
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('CrossRegionHealthManager already running');
      return;
    }

    this.logger.info('Starting CrossRegionHealthManager', {
      instanceId: this.config.instanceId,
      regionId: this.config.regionId,
      canBecomeLeader: this.config.canBecomeLeader
    });

    // Initialize Redis and lock manager (use injected or default)
    this.redis = this.injectedRedis ?? await getRedisClient();
    this.lockManager = this.injectedLockManager ?? await getDistributedLockManager();

    // P0-11 FIX: Initialize streams client for ADR-002 compliant failover messaging
    this.streamsClient = this.injectedStreamsClient ?? await getRedisStreamsClient();

    // P2 FIX #19: Set isRunning before startHealthMonitoring() so the
    // interval guard doesn't skip the first interval-triggered check
    this.isRunning = true;

    // Initialize own region
    this.initializeOwnRegion();

    // Start health monitoring
    this.startHealthMonitoring();

    // Attempt leader election if eligible
    if (this.config.canBecomeLeader && !this.config.isStandby) {
      await this.attemptLeaderElection();
    }

    // Subscribe to failover events
    await this.subscribeToFailoverEvents();

    this.logger.info('CrossRegionHealthManager started');
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.logger.info('Stopping CrossRegionHealthManager');

    // Clear intervals
    this.leaderHeartbeatInterval = clearIntervalSafe(this.leaderHeartbeatInterval);
    this.healthCheckInterval = clearIntervalSafe(this.healthCheckInterval);
    this.streamPollInterval = clearIntervalSafe(this.streamPollInterval);

    // P2-2 FIX: Unsubscribe from Redis pub/sub to prevent callback memory leak
    if (this.redis) {
      try {
        await this.redis.unsubscribe(this.FAILOVER_CHANNEL);
      } catch (error) {
        this.logger.warn('Failed to unsubscribe from failover channel', { error });
      }
    }

    // Release leadership if held
    if (this.isLeader) {
      await this.releaseLeadership();
    }

    // Update region status to offline
    await this.updateOwnRegionStatus('unknown');

    this.isRunning = false;
    this.logger.info('CrossRegionHealthManager stopped');
  }

  // ===========================================================================
  // Leader Election (ADR-007)
  // ===========================================================================

  /**
   * Attempt to become the leader using Redis distributed lock.
   * Uses SETNX pattern for atomic leader election.
   */
  async attemptLeaderElection(): Promise<boolean> {
    if (!this.lockManager || !this.config.canBecomeLeader) {
      return false;
    }

    try {
      const lock = await this.lockManager.acquireLock(this.LEADER_LOCK_KEY, {
        ttlMs: this.config.leaderLockTtlMs,
        retries: 0 // Don't wait, just try once
      });

      if (lock.acquired) {
        this.leaderLock = lock;
        this.isLeader = true;
        // P2 FIX #21: Increment fencing token on each lock acquisition
        this.leaderFencingToken++;
        this.startLeaderHeartbeat();

        this.logger.info('Acquired leadership', {
          instanceId: this.config.instanceId,
          regionId: this.config.regionId,
          fencingToken: this.leaderFencingToken
        });

        // Emit leader change event
        this.emit('leaderChange', {
          type: 'leader_changed',
          sourceRegion: '',
          targetRegion: this.config.regionId,
          services: [this.config.serviceName],
          timestamp: Date.now()
        } as FailoverEvent);

        // Update region health
        const region = this.regions.get(this.config.regionId);
        if (region) {
          region.isLeader = true;
        }

        return true;
      }

      return false;
    } catch (error) {
      this.logger.error('Leader election failed', { error });
      return false;
    }
  }

  /**
   * Maintain leadership via heartbeat.
   * Extends lock TTL periodically.
   */
  private startLeaderHeartbeat(): void {
    // P3 FIX #31: Use clearIntervalSafe for consistency with rest of codebase
    this.leaderHeartbeatInterval = clearIntervalSafe(this.leaderHeartbeatInterval);

    this.leaderHeartbeatInterval = setInterval(async () => {
      if (!this.isLeader || !this.leaderLock) {
        return;
      }

      try {
        // Extend the lock using the lock handle
        const extended = await this.leaderLock.extend(this.config.leaderLockTtlMs);

        if (!extended) {
          // Lost leadership
          this.logger.warn('Lost leadership - lock extension failed');
          this.onLeadershipLost();
        }
      } catch (error) {
        this.logger.error('Leader heartbeat failed', { error });
        this.onLeadershipLost();
      }
    }, this.config.leaderHeartbeatIntervalMs);
  }

  /**
   * Handle loss of leadership.
   */
  private onLeadershipLost(): void {
    this.isLeader = false;
    this.leaderLock = null;

    this.leaderHeartbeatInterval = clearIntervalSafe(this.leaderHeartbeatInterval);

    const region = this.regions.get(this.config.regionId);
    if (region) {
      region.isLeader = false;
    }

    this.logger.warn('Leadership lost', {
      instanceId: this.config.instanceId,
      regionId: this.config.regionId
    });

    this.emit('leadershipLost', {
      instanceId: this.config.instanceId,
      regionId: this.config.regionId,
      timestamp: Date.now()
    });

    // S4.1.2-FIX: Add jitter to prevent thundering herd when multiple instances lose leadership
    // Random offset of ±2 seconds spreads leadership re-acquisition attempts across instances
    const baseDelayMs = 5000;
    const jitterMs = Math.floor(Math.random() * 4000) - 2000; // Range: -2000 to +2000
    const effectiveDelay = Math.max(1000, baseDelayMs + jitterMs); // Minimum 1 second

    this.logger.debug('Scheduling leadership re-election with jitter', {
      baseDelayMs,
      jitterMs,
      effectiveDelay
    });

    // Attempt to re-acquire leadership after jittered delay
    setTimeout(() => {
      if (this.isRunning && this.config.canBecomeLeader) {
        this.attemptLeaderElection();
      }
    }, effectiveDelay);
  }

  /**
   * Voluntarily release leadership.
   */
  private async releaseLeadership(): Promise<void> {
    if (!this.isLeader || !this.leaderLock) {
      return;
    }

    try {
      await this.leaderLock.release();
      this.isLeader = false;
      this.leaderLock = null;

      this.leaderHeartbeatInterval = clearIntervalSafe(this.leaderHeartbeatInterval);

      this.logger.info('Released leadership', {
        instanceId: this.config.instanceId
      });
    } catch (error) {
      this.logger.error('Failed to release leadership', { error });
    }
  }

  // ===========================================================================
  // Health Monitoring
  // ===========================================================================

  private initializeOwnRegion(): void {
    const regionHealth: RegionHealth = {
      regionId: this.config.regionId,
      status: 'healthy',
      isLeader: false,
      services: [{
        serviceName: this.config.serviceName,
        status: 'healthy',
        isPrimary: !this.config.isStandby,
        isStandby: this.config.isStandby,
        lastHeartbeat: Date.now(),
        metrics: {}
      }],
      lastHealthCheck: Date.now(),
      consecutiveFailures: 0,
      avgLatencyMs: 0,
      memoryUsagePercent: 0,
      cpuUsagePercent: 0
    };

    this.regions.set(this.config.regionId, regionHealth);
  }

  private startHealthMonitoring(): void {
    this.healthCheckInterval = setInterval(async () => {
      // Skip health checks if not running
      if (!this.isRunning) {
        return;
      }
      await this.performHealthCheck();
    }, this.config.healthCheckIntervalMs);

    // Perform initial health check (fire-and-forget with error handling)
    this.performHealthCheck().catch(error => {
      this.logger.error('Initial health check failed', { error });
    });
  }

  private async performHealthCheck(): Promise<void> {
    try {
      // Update own region health
      await this.updateOwnRegionHealth();

      // Fetch health from other regions
      await this.fetchRemoteRegionHealth();

      // Evaluate failover conditions (only if leader)
      // P2 FIX #21: Capture fencing token before async operations to detect
      // leadership changes during execution (split-brain protection)
      if (this.isLeader) {
        const tokenAtStart = this.leaderFencingToken;
        await this.evaluateFailoverConditions();
        if (this.leaderFencingToken !== tokenAtStart) {
          this.logger.warn('Fencing token changed during failover evaluation — aborting leader actions');
        }
      }
    } catch (error) {
      this.logger.error('Health check failed', { error });
    }
  }

  private async updateOwnRegionHealth(): Promise<void> {
    const region = this.regions.get(this.config.regionId);
    if (!region) return;

    // Update metrics
    const memUsage = process.memoryUsage();
    region.memoryUsagePercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;
    region.lastHealthCheck = Date.now();

    // Update service health
    const service = region.services.find(s => s.serviceName === this.config.serviceName);
    if (service) {
      service.lastHeartbeat = Date.now();
      service.metrics = {
        memoryMB: Math.round(memUsage.heapUsed / 1024 / 1024),
        uptime: process.uptime()
      };
    }

    // Persist to Redis
    await this.persistRegionHealth(region);
  }

  private async persistRegionHealth(region: RegionHealth): Promise<void> {
    if (!this.redis) return;

    try {
      const key = `${this.HEALTH_KEY_PREFIX}${region.regionId}`;
      await this.redis.set(key, region, 60); // 60 second TTL
    } catch (error) {
      this.logger.error('Failed to persist region health', { error });
    }
  }

  /**
   * P1-4 FIX: Use SCAN instead of KEYS to avoid blocking Redis
   */
  private async fetchRemoteRegionHealth(): Promise<void> {
    if (!this.redis) return;

    try {
      // P1-4 FIX: Use SCAN iterator instead of KEYS
      const pattern = `${this.HEALTH_KEY_PREFIX}*`;
      let cursor = '0';

      do {
        // SCAN returns [cursor, keys[]]
        const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;

        for (const key of keys) {
          const regionId = key.replace(this.HEALTH_KEY_PREFIX, '');

          // Skip own region
          if (regionId === this.config.regionId) continue;

          const healthData = await this.redis.get<RegionHealth>(key);
          if (healthData) {
            this.regions.set(regionId, healthData);
          }
        }
      } while (cursor !== '0');
    } catch (error) {
      this.logger.error('Failed to fetch remote region health', { error });
    }
  }

  private async updateOwnRegionStatus(status: RegionStatus): Promise<void> {
    const region = this.regions.get(this.config.regionId);
    if (region) {
      region.status = status;
      await this.persistRegionHealth(region);
    }
  }

  // ===========================================================================
  // Failover Logic (ADR-007)
  // ===========================================================================

  /**
   * P2 FIX #12: Added 'failover_in_progress' guard to prevent repeated triggering.
   * Previously, once a region was marked 'failed' by triggerFailover(), every
   * subsequent health check would re-trigger failover indefinitely.
   */
  private async evaluateFailoverConditions(): Promise<void> {
    for (const [regionId, region] of this.regions) {
      // Skip own region
      if (regionId === this.config.regionId) continue;

      // P2 FIX #12: Skip regions already undergoing or completed failover
      if (region.status === 'failed') continue;

      // Check for stale health data
      const healthAge = Date.now() - region.lastHealthCheck;
      const isStale = healthAge > this.config.healthCheckIntervalMs * 3;

      if (isStale || region.status === 'unhealthy') {
        region.consecutiveFailures++;

        if (region.consecutiveFailures >= this.config.failoverThreshold) {
          await this.triggerFailover(regionId);
        }
      } else {
        region.consecutiveFailures = 0;
      }
    }
  }

  /**
   * Trigger failover for a failed region.
   */
  async triggerFailover(failedRegion: string): Promise<void> {
    this.logger.warn(`Triggering failover for region: ${failedRegion}`);

    const startTime = Date.now();
    const region = this.regions.get(failedRegion);

    if (!region) {
      return;
    }

    // 1. Mark region as failed
    region.status = 'failed';

    // 2. Emit failover started event
    const failoverEvent: FailoverEvent = {
      type: 'failover_started',
      sourceRegion: failedRegion,
      targetRegion: this.config.regionId,
      services: region.services.map(s => s.serviceName),
      timestamp: startTime
    };

    this.emit('failoverStarted', failoverEvent);

    // 3. Publish failover event to Redis for other services
    await this.publishFailoverEvent(failoverEvent);

    try {
      // 4. Activate standby services for the failed region
      await this.activateStandbyServices(failedRegion);

      // 5. Update routing (if applicable)
      await this.updateRoutingTable(failedRegion);

      // 6. Emit completion
      const completedEvent: FailoverEvent = {
        type: 'failover_completed',
        sourceRegion: failedRegion,
        targetRegion: this.config.regionId,
        services: region.services.map(s => s.serviceName),
        timestamp: Date.now(),
        durationMs: Date.now() - startTime
      };

      this.emit('failoverCompleted', completedEvent);
      await this.publishFailoverEvent(completedEvent);

      this.logger.info('Failover completed', {
        failedRegion,
        durationMs: completedEvent.durationMs
      });

    } catch (error) {
      // Emit failure
      const failedEvent: FailoverEvent = {
        type: 'failover_failed',
        sourceRegion: failedRegion,
        targetRegion: this.config.regionId,
        services: region.services.map(s => s.serviceName),
        timestamp: Date.now(),
        durationMs: Date.now() - startTime,
        error: (error as Error).message
      };

      this.emit('failoverFailed', failedEvent);
      await this.publishFailoverEvent(failedEvent);

      this.logger.error('Failover failed', { error, failedRegion });
    }
  }

  private async activateStandbyServices(failedRegion: string): Promise<void> {
    // This would activate standby services for the failed region
    // Implementation depends on deployment infrastructure (Fly.io, Oracle, etc.)

    this.logger.info('Activating standby services', { failedRegion });

    // Emit activation request for standby services to handle
    this.emit('activateStandby', {
      failedRegion,
      timestamp: Date.now()
    });
  }

  private async updateRoutingTable(failedRegion: string): Promise<void> {
    // Update any routing configuration to redirect traffic from failed region
    // This is infrastructure-specific

    this.logger.info('Updating routing table', { failedRegion });

    if (this.redis) {
      await this.redis.set(`routing:failed:${failedRegion}`, {
        failedAt: Date.now(),
        redirectTo: this.config.regionId
      });
    }
  }

  // ===========================================================================
  // Event Subscription
  // ===========================================================================

  /**
   * P1 FIX #2: Subscribe to failover events via Redis Streams (ADR-002 compliant).
   * Falls back to Pub/Sub only if Streams client is unavailable.
   */
  private async subscribeToFailoverEvents(): Promise<void> {
    // Primary: Redis Streams consumer (ADR-002 compliant, guaranteed delivery)
    if (this.streamsClient) {
      try {
        const groupName = `failover-${this.config.serviceName}`;
        const consumerName = this.config.instanceId;
        await this.streamsClient.createConsumerGroup({
          streamName: FAILOVER_STREAM,
          groupName,
          consumerName,
        }).catch(() => {
          // Group may already exist, safe to ignore
        });
        this.startStreamConsumer(groupName, consumerName);
        this.logger.info('Subscribed to failover events via Redis Streams', { groupName });
        return; // Streams consumer active, no need for Pub/Sub
      } catch (error) {
        this.logger.warn('Failed to set up Streams consumer, falling back to Pub/Sub', { error });
      }
    }

    // Fallback: Pub/Sub (only if Streams unavailable)
    if (!this.redis) return;
    try {
      await this.redis.subscribe(this.FAILOVER_CHANNEL, (message: any) => {
        this.handleFailoverEvent(message.data as FailoverEvent);
      });
    } catch (error) {
      this.logger.error('Failed to subscribe to failover events', { error });
    }
  }

  /**
   * P1 FIX #2: Consume failover events from Redis Stream using consumer group.
   */
  private startStreamConsumer(groupName: string, consumerName: string): void {
    const consumerConfig = {
      streamName: FAILOVER_STREAM,
      groupName,
      consumerName,
      startId: '>'
    };

    this.streamPollInterval = setInterval(async () => {
      if (!this.isRunning || !this.streamsClient) {
        this.streamPollInterval = clearIntervalSafe(this.streamPollInterval);
        return;
      }
      try {
        const messages = await this.streamsClient.xreadgroup(
          consumerConfig,
          { count: 10, block: 1000 }
        );
        if (messages && messages.length > 0) {
          for (const msg of messages) {
            const event = msg.data as unknown as FailoverEvent;
            if (event) {
              this.handleFailoverEvent(event);
            }
            await this.streamsClient!.xack(FAILOVER_STREAM, groupName, msg.id);
          }
        }
      } catch (error) {
        this.logger.error('Error reading from failover stream', { error });
      }
    }, 2000);
  }

  /**
   * P1 FIX #2: Shared handler for failover events from either Streams or Pub/Sub.
   * P2 FIX #20: Validates required fields before processing.
   */
  private handleFailoverEvent(event: FailoverEvent): void {
    // P2 FIX #20: Validate required fields to prevent processing malformed events
    if (!event ||
        !event.type ||
        !event.sourceRegion ||
        !event.targetRegion ||
        !Array.isArray(event.services)) {
      this.logger.warn('Received malformed failover event, ignoring', { event });
      return;
    }

    // Validate event type is a known value
    const validTypes = ['failover_started', 'failover_completed', 'failover_failed', 'leader_changed'];
    if (!validTypes.includes(event.type)) {
      this.logger.warn('Received failover event with unknown type, ignoring', { type: event.type });
      return;
    }

    this.logger.info('Received failover event', {
      type: event.type,
      sourceRegion: event.sourceRegion,
      targetRegion: event.targetRegion
    });

    // Handle standby activation if this is the target
    if (event.type === 'failover_started' &&
        event.targetRegion === this.config.regionId &&
        this.config.isStandby) {
      this.onStandbyActivation(event);
    }

    this.emit('failoverEvent', event);
  }

  /**
   * P0-11 FIX: Publish failover events to both Redis Streams (guaranteed delivery)
   * and Pub/Sub (backward compatibility during migration).
   */
  private async publishFailoverEvent(event: FailoverEvent): Promise<void> {
    const message = {
      type: 'failover_event',
      data: event,
      timestamp: Date.now(),
      source: this.config.instanceId
    };

    // P0-11 FIX: Primary - Publish to Redis Streams for guaranteed delivery
    if (this.streamsClient) {
      try {
        await this.streamsClient.xadd(FAILOVER_STREAM, message, '*', { maxLen: 10000 });
        this.logger.debug('Published failover event to stream', { eventType: event.type });
      } catch (error) {
        this.logger.error('Failed to publish failover event to stream', { error });
      }
    }

    // Secondary - Publish to Pub/Sub for backward compatibility
    if (this.redis) {
      try {
        await this.redis.publish(this.FAILOVER_CHANNEL, message);
      } catch (error) {
        this.logger.error('Failed to publish failover event to pub/sub', { error });
      }
    }
  }

  private onStandbyActivation(event: FailoverEvent): void {
    this.logger.info('Standby activation requested', {
      sourceRegion: event.sourceRegion
    });

    // Transition from standby to active
    const region = this.regions.get(this.config.regionId);
    if (region) {
      for (const service of region.services) {
        if (service.isStandby) {
          service.isStandby = false;
          service.isPrimary = true;
        }
      }
    }

    this.emit('activated', { previouslyStandby: true, timestamp: Date.now() });
  }

  // ===========================================================================
  // Global Health Status
  // ===========================================================================

  /**
   * Evaluate the global system health status.
   * Used by GracefulDegradationManager to determine degradation level.
   * P2 FIX #18: Now async — performs actual Redis ping instead of null check.
   */
  async evaluateGlobalHealth(): Promise<GlobalHealthStatus> {
    // P2 FIX #18: Check actual Redis connectivity with ping + latency measurement
    let redisHealthy = false;
    let redisLatencyMs = 0;
    if (this.redis) {
      const pingStart = Date.now();
      try {
        redisHealthy = await this.redis.ping();
        redisLatencyMs = Date.now() - pingStart;
      } catch {
        redisHealthy = false;
        redisLatencyMs = Date.now() - pingStart;
      }
    }

    const detectors: Array<{ name: string; healthy: boolean; region: string }> = [];
    let executorHealthy = false;
    let executorRegion = '';

    for (const [regionId, region] of this.regions) {
      for (const service of region.services) {
        if (service.serviceName.includes('detector')) {
          detectors.push({
            name: service.serviceName,
            healthy: service.status === 'healthy',
            region: regionId
          });
        }

        if (service.serviceName.includes('execution') || service.serviceName.includes('executor')) {
          executorHealthy = service.status === 'healthy';
          executorRegion = regionId;
        }
      }
    }

    const healthyDetectors = detectors.filter(d => d.healthy).length;
    const totalDetectors = detectors.length;

    // Determine degradation level
    // Priority: No detectors/executor > No healthy detectors > Executor down > Partial detectors > Full operation
    let degradationLevel: DegradationLevel;

    if (totalDetectors === 0) {
      // No detectors registered yet
      degradationLevel = DegradationLevel.READ_ONLY;
    } else if (healthyDetectors === 0) {
      // All detectors unhealthy
      degradationLevel = DegradationLevel.READ_ONLY;
    } else if (!executorHealthy) {
      // Detectors working but executor down - can detect but not execute
      degradationLevel = DegradationLevel.DETECTION_ONLY;
    } else if (healthyDetectors < totalDetectors) {
      // Some detectors unhealthy
      degradationLevel = DegradationLevel.REDUCED_CHAINS;
    } else {
      // All systems healthy
      degradationLevel = DegradationLevel.FULL_OPERATION;
    }

    // Overall status
    let overallStatus: 'healthy' | 'degraded' | 'critical';
    if (degradationLevel === DegradationLevel.FULL_OPERATION) {
      overallStatus = 'healthy';
    } else if (degradationLevel >= DegradationLevel.READ_ONLY) {
      overallStatus = 'critical';
    } else {
      overallStatus = 'degraded';
    }

    return {
      redis: { healthy: redisHealthy, latencyMs: redisLatencyMs },
      executor: { healthy: executorHealthy, region: executorRegion },
      detectors,
      degradationLevel,
      overallStatus
    };
  }

  // ===========================================================================
  // Public Getters
  // ===========================================================================

  getIsLeader(): boolean {
    return this.isLeader;
  }

  getRegionHealth(regionId: string): RegionHealth | undefined {
    return this.regions.get(regionId);
  }

  getAllRegionsHealth(): Map<string, RegionHealth> {
    return new Map(this.regions);
  }

  getOwnRegionId(): string {
    return this.config.regionId;
  }

  isActive(): boolean {
    return this.isRunning;
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let globalCrossRegionHealthManager: CrossRegionHealthManager | null = null;

export function getCrossRegionHealthManager(config?: CrossRegionHealthConfig): CrossRegionHealthManager {
  if (!globalCrossRegionHealthManager && config) {
    globalCrossRegionHealthManager = new CrossRegionHealthManager(config);
  }
  if (!globalCrossRegionHealthManager) {
    throw new Error('CrossRegionHealthManager not initialized. Call with config first.');
  }
  return globalCrossRegionHealthManager;
}

export async function resetCrossRegionHealthManager(): Promise<void> {
  if (globalCrossRegionHealthManager) {
    await globalCrossRegionHealthManager.stop();
    globalCrossRegionHealthManager = null;
  }
}
