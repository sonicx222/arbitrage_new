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
import { RedisClient } from './redis';
import { RedisStreamsClient } from './redis-streams';
import { DistributedLockManager } from './distributed-lock';
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
/** Logger interface for dependency injection */
interface Logger {
    info: (message: string, meta?: object) => void;
    error: (message: string, meta?: object) => void;
    warn: (message: string, meta?: object) => void;
    debug: (message: string, meta?: object) => void;
}
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
    /** Optional logger for testing (defaults to createLogger) */
    logger?: Logger;
    /** Optional Redis client for testing */
    redisClient?: RedisClient;
    /** Optional Redis Streams client for testing */
    streamsClient?: RedisStreamsClient;
    /** Optional lock manager for testing */
    lockManager?: DistributedLockManager;
}
export interface GlobalHealthStatus {
    /** Redis connection health */
    redis: {
        healthy: boolean;
        latencyMs: number;
    };
    /** Executor service health */
    executor: {
        healthy: boolean;
        region: string;
    };
    /** Detector services health */
    detectors: Array<{
        name: string;
        healthy: boolean;
        region: string;
    }>;
    /** Current degradation level */
    degradationLevel: DegradationLevel;
    /** Overall system status */
    overallStatus: 'healthy' | 'degraded' | 'critical';
}
export declare enum DegradationLevel {
    FULL_OPERATION = 0,// All services healthy
    REDUCED_CHAINS = 1,// Some chain detectors down
    DETECTION_ONLY = 2,// Execution disabled
    READ_ONLY = 3,// Only dashboard/monitoring
    COMPLETE_OUTAGE = 4
}
export declare class CrossRegionHealthManager extends EventEmitter {
    private redis;
    private streamsClient;
    private lockManager;
    private logger;
    private config;
    private injectedRedis;
    private injectedStreamsClient;
    private injectedLockManager;
    private regions;
    private isLeader;
    private leaderLock;
    private leaderHeartbeatInterval;
    private healthCheckInterval;
    private isRunning;
    private readonly LEADER_LOCK_KEY;
    private readonly HEALTH_KEY_PREFIX;
    private readonly FAILOVER_CHANNEL;
    constructor(config: CrossRegionHealthConfig);
    start(): Promise<void>;
    stop(): Promise<void>;
    /**
     * Attempt to become the leader using Redis distributed lock.
     * Uses SETNX pattern for atomic leader election.
     */
    attemptLeaderElection(): Promise<boolean>;
    /**
     * Maintain leadership via heartbeat.
     * Extends lock TTL periodically.
     */
    private startLeaderHeartbeat;
    /**
     * Handle loss of leadership.
     */
    private onLeadershipLost;
    /**
     * Voluntarily release leadership.
     */
    private releaseLeadership;
    private initializeOwnRegion;
    private startHealthMonitoring;
    private performHealthCheck;
    private updateOwnRegionHealth;
    private persistRegionHealth;
    /**
     * P1-4 FIX: Use SCAN instead of KEYS to avoid blocking Redis
     */
    private fetchRemoteRegionHealth;
    private updateOwnRegionStatus;
    private evaluateFailoverConditions;
    /**
     * Trigger failover for a failed region.
     */
    triggerFailover(failedRegion: string): Promise<void>;
    private activateStandbyServices;
    private updateRoutingTable;
    private subscribeToFailoverEvents;
    /**
     * P0-11 FIX: Publish failover events to both Redis Streams (guaranteed delivery)
     * and Pub/Sub (backward compatibility during migration).
     */
    private publishFailoverEvent;
    private onStandbyActivation;
    /**
     * Evaluate the global system health status.
     * Used by GracefulDegradationManager to determine degradation level.
     */
    evaluateGlobalHealth(): GlobalHealthStatus;
    getIsLeader(): boolean;
    getRegionHealth(regionId: string): RegionHealth | undefined;
    getAllRegionsHealth(): Map<string, RegionHealth>;
    getOwnRegionId(): string;
    isActive(): boolean;
}
export declare function getCrossRegionHealthManager(config?: CrossRegionHealthConfig): CrossRegionHealthManager;
export declare function resetCrossRegionHealthManager(): Promise<void>;
export {};
//# sourceMappingURL=cross-region-health.d.ts.map