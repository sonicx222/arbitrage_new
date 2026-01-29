/**
 * Leadership Election Service
 *
 * Extracted from coordinator.ts (P2-SERVICE) to provide a reusable
 * distributed leadership election mechanism based on Redis locks.
 *
 * Features:
 * - Atomic lock acquisition using SETNX
 * - Atomic lock renewal using Lua scripts (TOCTOU-safe)
 * - Atomic lock release using Lua scripts
 * - Jittered heartbeat to prevent thundering herd
 * - Consecutive failure tracking with automatic demotion
 * - Standby mode support (ADR-007)
 *
 * @see ADR-007: Cross-Region Failover
 * @see P2-SERVICE from refactoring-roadmap.md
 */

/**
 * Minimal logger interface for dependency injection.
 * Using a local interface to avoid circular dependencies with shared packages.
 */
interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Configuration for leadership election
 */
export interface LeadershipElectionConfig {
  /** Redis key for the leader lock */
  lockKey: string;
  /** Time-to-live for the lock in milliseconds */
  lockTtlMs: number;
  /** Heartbeat interval in milliseconds (should be ~1/3 of lockTtlMs) */
  heartbeatIntervalMs: number;
  /** Unique identifier for this instance */
  instanceId: string;
}

/**
 * Redis client interface required for leadership election
 */
export interface LeadershipRedisClient {
  /** Set a key only if it doesn't exist, with TTL in seconds */
  setNx(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  /** Atomically renew lock if owned by this instance */
  renewLockIfOwned(key: string, expectedValue: string, ttlSeconds: number): Promise<boolean>;
  /** Atomically release lock if owned by this instance */
  releaseLockIfOwned(key: string, expectedValue: string): Promise<boolean>;
}

/**
 * Alert callback for leadership events
 */
export interface LeadershipAlert {
  type: 'LEADER_ACQUIRED' | 'LEADER_LOST' | 'LEADER_DEMOTION' | 'LEADER_HEARTBEAT_FAILURE';
  message: string;
  severity: 'info' | 'warning' | 'critical';
  data: Record<string, unknown>;
  timestamp: number;
}

/**
 * Options for the leadership election service
 */
export interface LeadershipElectionOptions {
  /** Leadership election configuration */
  config: LeadershipElectionConfig;
  /** Redis client for distributed locking */
  redis: LeadershipRedisClient;
  /** Logger instance */
  logger: Logger;
  /** Whether this instance is in standby mode (ADR-007) */
  isStandby?: boolean;
  /** Whether this instance is allowed to become leader */
  canBecomeLeader?: boolean;
  /** Callback when an alert should be sent */
  onAlert?: (alert: LeadershipAlert) => void;
  /** Callback when leadership status changes */
  onLeadershipChange?: (isLeader: boolean) => void;
  /** Maximum consecutive heartbeat failures before demotion (default: 3) */
  maxHeartbeatFailures?: number;
  /** Jitter range in milliseconds for heartbeat interval (default: 4000, meaning ±2000ms) */
  jitterRangeMs?: number;
}

/**
 * Leadership Election Service
 *
 * Manages distributed leadership election using Redis locks.
 * Only one instance across all nodes can be leader at a time.
 */
export class LeadershipElectionService {
  private readonly config: LeadershipElectionConfig;
  private readonly redis: LeadershipRedisClient;
  private readonly logger: Logger;
  private readonly isStandby: boolean;
  private readonly canBecomeLeader: boolean;
  private readonly onAlert?: (alert: LeadershipAlert) => void;
  private readonly onLeadershipChange?: (isLeader: boolean) => void;
  private readonly maxHeartbeatFailures: number;
  private readonly jitterRangeMs: number;

  private _isLeader = false;
  private _isActivating = false;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private consecutiveHeartbeatFailures = 0;
  private running = false;

  constructor(options: LeadershipElectionOptions) {
    this.config = options.config;
    this.redis = options.redis;
    this.logger = options.logger;
    this.isStandby = options.isStandby ?? false;
    this.canBecomeLeader = options.canBecomeLeader ?? true;
    this.onAlert = options.onAlert;
    this.onLeadershipChange = options.onLeadershipChange;
    this.maxHeartbeatFailures = options.maxHeartbeatFailures ?? 3;
    this.jitterRangeMs = options.jitterRangeMs ?? 4000;
  }

  /**
   * Get current leadership status
   */
  get isLeader(): boolean {
    return this._isLeader;
  }

  /**
   * Get the instance ID
   */
  get instanceId(): string {
    return this.config.instanceId;
  }

  /**
   * Start the leadership election service
   */
  async start(): Promise<void> {
    if (this.running) {
      this.logger.warn('Leadership election service already running');
      return;
    }

    this.running = true;
    this.consecutiveHeartbeatFailures = 0;

    // Try initial leadership acquisition
    await this.tryAcquireLeadership();

    // Start heartbeat loop
    this.startHeartbeat();

    this.logger.info('Leadership election service started', {
      instanceId: this.config.instanceId,
      isStandby: this.isStandby,
      canBecomeLeader: this.canBecomeLeader,
    });
  }

  /**
   * Stop the leadership election service and release leadership if held
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;

    // Stop heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Release leadership if we hold it
    await this.releaseLeadership();

    this.logger.info('Leadership election service stopped', {
      instanceId: this.config.instanceId,
    });
  }

  /**
   * Signal that this standby instance is activating (ADR-007)
   * Call this when the cross-region health manager signals activation.
   */
  setActivating(activating: boolean): void {
    this._isActivating = activating;
    this.logger.info('Leadership activation state changed', {
      instanceId: this.config.instanceId,
      activating,
    });
  }

  /**
   * Attempt to acquire leadership
   * @returns true if leadership was acquired
   */
  async tryAcquireLeadership(): Promise<boolean> {
    // ADR-007: Respect standby configuration
    if (!this.canBecomeLeader) {
      this.logger.debug('Cannot become leader - canBecomeLeader is false');
      return false;
    }

    // ADR-007: Standby instances should not proactively acquire leadership
    // They wait for CrossRegionHealthManager to signal activation
    if (this.isStandby && !this._isActivating) {
      this.logger.debug('Standby instance - waiting for activation signal');
      return false;
    }

    try {
      const { lockKey, lockTtlMs, instanceId } = this.config;

      // Try to set the lock with NX (only if not exists)
      const acquired = await this.redis.setNx(
        lockKey,
        instanceId,
        Math.ceil(lockTtlMs / 1000)
      );

      if (acquired) {
        this.setLeaderStatus(true);
        this.logger.info('Acquired leadership', { instanceId });
        this.sendAlert({
          type: 'LEADER_ACQUIRED',
          message: `Instance ${instanceId} acquired leadership`,
          severity: 'info',
          data: { instanceId },
          timestamp: Date.now(),
        });
        return true;
      }

      // S4.1.1-FIX-1: Use atomic renewLockIfOwned instead of TOCTOU-prone get+expire
      // This atomically checks if we own the lock and extends TTL in one operation.
      const renewed = await this.redis.renewLockIfOwned(
        lockKey,
        instanceId,
        Math.ceil(lockTtlMs / 1000)
      );

      if (renewed) {
        // We already held the lock and successfully renewed it
        this.setLeaderStatus(true);
        return true;
      }

      this.logger.debug('Another instance is leader', { lockKey });
      return false;

    } catch (error) {
      this.logger.error('Failed to acquire leadership', { error });
      return false;
    }
  }

  /**
   * Renew the leader lock (called from heartbeat)
   * @returns true if renewal succeeded
   * @throws if there's a Redis connection error (so caller can handle retry logic)
   */
  private async renewLeaderLock(): Promise<boolean> {
    const { lockKey, lockTtlMs, instanceId } = this.config;

    // P0-NEW-5 FIX: Use atomic Lua script for check-and-extend
    // Note: We don't catch errors here - we let them propagate to the heartbeat
    // so it can track consecutive failures and demote accordingly
    const renewed = await this.redis.renewLockIfOwned(
      lockKey,
      instanceId,
      Math.ceil(lockTtlMs / 1000)
    );
    return renewed;
  }

  /**
   * Release leadership (called on stop or demotion)
   */
  private async releaseLeadership(): Promise<void> {
    if (!this._isLeader) return;

    try {
      const { lockKey, instanceId } = this.config;

      // P0-NEW-5 FIX: Use atomic Lua script for check-and-delete
      const released = await this.redis.releaseLockIfOwned(lockKey, instanceId);

      if (released) {
        this.logger.info('Released leadership', { instanceId });
      } else {
        this.logger.warn('Lock was not released - not owned by this instance', { instanceId });
      }

      this.setLeaderStatus(false);

    } catch (error) {
      this.logger.error('Failed to release leadership', { error });
      this.setLeaderStatus(false);
    }
  }

  /**
   * Start the heartbeat loop with jittered interval
   */
  private startHeartbeat(): void {
    const { heartbeatIntervalMs, instanceId } = this.config;

    // S4.1.1-FIX-3: Add jitter to prevent thundering herd on leader failover
    const jitterMs = Math.floor(Math.random() * this.jitterRangeMs) - (this.jitterRangeMs / 2);
    const effectiveInterval = Math.max(1000, heartbeatIntervalMs + jitterMs);

    this.logger.debug('Leader heartbeat interval with jitter', {
      baseInterval: heartbeatIntervalMs,
      jitter: jitterMs,
      effectiveInterval,
    });

    this.heartbeatInterval = setInterval(async () => {
      if (!this.running) return;

      try {
        if (this._isLeader) {
          const renewed = await this.renewLeaderLock();
          if (renewed) {
            // Reset failure count on successful heartbeat
            this.consecutiveHeartbeatFailures = 0;
          } else {
            // Lost leadership (another instance took over or lock expired)
            this.setLeaderStatus(false);
            this.logger.warn('Lost leadership - lock renewal failed', { instanceId });
            this.sendAlert({
              type: 'LEADER_LOST',
              message: `Instance ${instanceId} lost leadership - lock renewal failed`,
              severity: 'warning',
              data: { instanceId },
              timestamp: Date.now(),
            });
          }
        } else {
          // Try to acquire leadership
          await this.tryAcquireLeadership();
        }

      } catch (error) {
        // Track consecutive failures and demote if threshold exceeded
        this.consecutiveHeartbeatFailures++;
        this.logger.error('Leader heartbeat failed', {
          error,
          consecutiveFailures: this.consecutiveHeartbeatFailures,
          maxFailures: this.maxHeartbeatFailures,
          wasLeader: this._isLeader,
        });

        this.sendAlert({
          type: 'LEADER_HEARTBEAT_FAILURE',
          message: `Heartbeat failure #${this.consecutiveHeartbeatFailures}`,
          severity: 'warning',
          data: {
            instanceId,
            consecutiveFailures: this.consecutiveHeartbeatFailures,
            maxFailures: this.maxHeartbeatFailures,
            wasLeader: this._isLeader,
          },
          timestamp: Date.now(),
        });

        // If we're the leader and have too many failures, demote self
        if (this._isLeader && this.consecutiveHeartbeatFailures >= this.maxHeartbeatFailures) {
          this.setLeaderStatus(false);
          this.logger.error('Demoting self from leader due to consecutive heartbeat failures', {
            failures: this.consecutiveHeartbeatFailures,
          });

          this.sendAlert({
            type: 'LEADER_DEMOTION',
            message: `Leader demoted due to ${this.consecutiveHeartbeatFailures} consecutive heartbeat failures`,
            severity: 'critical',
            data: { instanceId, failures: this.consecutiveHeartbeatFailures },
            timestamp: Date.now(),
          });
        }
      }
    }, effectiveInterval);
  }

  /**
   * Update leadership status and notify listeners
   */
  private setLeaderStatus(isLeader: boolean): void {
    if (this._isLeader === isLeader) return;

    this._isLeader = isLeader;
    this.onLeadershipChange?.(isLeader);
  }

  /**
   * Send an alert through the callback if configured
   */
  private sendAlert(alert: LeadershipAlert): void {
    this.onAlert?.(alert);
  }
}
