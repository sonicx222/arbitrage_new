"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.CrossRegionHealthManager = exports.DegradationLevel = void 0;
exports.getCrossRegionHealthManager = getCrossRegionHealthManager;
exports.resetCrossRegionHealthManager = resetCrossRegionHealthManager;
const events_1 = require("events");
const logger_1 = require("./logger");
const redis_1 = require("./redis");
const redis_streams_1 = require("./redis-streams");
const distributed_lock_1 = require("./distributed-lock");
// P0-11 FIX: Stream name for failover events (ADR-002 compliant)
const FAILOVER_STREAM = 'stream:system-failover';
var DegradationLevel;
(function (DegradationLevel) {
    DegradationLevel[DegradationLevel["FULL_OPERATION"] = 0] = "FULL_OPERATION";
    DegradationLevel[DegradationLevel["REDUCED_CHAINS"] = 1] = "REDUCED_CHAINS";
    DegradationLevel[DegradationLevel["DETECTION_ONLY"] = 2] = "DETECTION_ONLY";
    DegradationLevel[DegradationLevel["READ_ONLY"] = 3] = "READ_ONLY";
    DegradationLevel[DegradationLevel["COMPLETE_OUTAGE"] = 4] = "COMPLETE_OUTAGE"; // All services down
})(DegradationLevel || (exports.DegradationLevel = DegradationLevel = {}));
// =============================================================================
// Cross-Region Health Manager
// =============================================================================
class CrossRegionHealthManager extends events_1.EventEmitter {
    constructor(config) {
        super();
        this.redis = null;
        this.streamsClient = null; // P0-11 FIX: Add streams client
        this.lockManager = null;
        this.regions = new Map();
        this.isLeader = false;
        this.leaderLock = null;
        this.leaderHeartbeatInterval = null;
        this.healthCheckInterval = null;
        this.isRunning = false;
        this.LEADER_LOCK_KEY = 'coordinator:leader:lock';
        this.HEALTH_KEY_PREFIX = 'region:health:';
        this.FAILOVER_CHANNEL = 'cross-region:failover';
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
        this.logger = (0, logger_1.createLogger)(`cross-region:${config.regionId}`);
    }
    // ===========================================================================
    // Lifecycle
    // ===========================================================================
    async start() {
        if (this.isRunning) {
            this.logger.warn('CrossRegionHealthManager already running');
            return;
        }
        this.logger.info('Starting CrossRegionHealthManager', {
            instanceId: this.config.instanceId,
            regionId: this.config.regionId,
            canBecomeLeader: this.config.canBecomeLeader
        });
        // Initialize Redis and lock manager
        this.redis = await (0, redis_1.getRedisClient)();
        this.lockManager = await (0, distributed_lock_1.getDistributedLockManager)();
        // P0-11 FIX: Initialize streams client for ADR-002 compliant failover messaging
        this.streamsClient = await (0, redis_streams_1.getRedisStreamsClient)();
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
        this.isRunning = true;
        this.logger.info('CrossRegionHealthManager started');
    }
    async stop() {
        if (!this.isRunning) {
            return;
        }
        this.logger.info('Stopping CrossRegionHealthManager');
        // Clear intervals
        if (this.leaderHeartbeatInterval) {
            clearInterval(this.leaderHeartbeatInterval);
            this.leaderHeartbeatInterval = null;
        }
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
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
    async attemptLeaderElection() {
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
                this.startLeaderHeartbeat();
                this.logger.info('Acquired leadership', {
                    instanceId: this.config.instanceId,
                    regionId: this.config.regionId
                });
                // Emit leader change event
                this.emit('leaderChange', {
                    type: 'leader_changed',
                    sourceRegion: '',
                    targetRegion: this.config.regionId,
                    services: [this.config.serviceName],
                    timestamp: Date.now()
                });
                // Update region health
                const region = this.regions.get(this.config.regionId);
                if (region) {
                    region.isLeader = true;
                }
                return true;
            }
            return false;
        }
        catch (error) {
            this.logger.error('Leader election failed', { error });
            return false;
        }
    }
    /**
     * Maintain leadership via heartbeat.
     * Extends lock TTL periodically.
     */
    startLeaderHeartbeat() {
        if (this.leaderHeartbeatInterval) {
            clearInterval(this.leaderHeartbeatInterval);
        }
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
            }
            catch (error) {
                this.logger.error('Leader heartbeat failed', { error });
                this.onLeadershipLost();
            }
        }, this.config.leaderHeartbeatIntervalMs);
    }
    /**
     * Handle loss of leadership.
     */
    onLeadershipLost() {
        this.isLeader = false;
        this.leaderLock = null;
        if (this.leaderHeartbeatInterval) {
            clearInterval(this.leaderHeartbeatInterval);
            this.leaderHeartbeatInterval = null;
        }
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
        // Attempt to re-acquire leadership after delay
        setTimeout(() => {
            if (this.isRunning && this.config.canBecomeLeader) {
                this.attemptLeaderElection();
            }
        }, 5000);
    }
    /**
     * Voluntarily release leadership.
     */
    async releaseLeadership() {
        if (!this.isLeader || !this.leaderLock) {
            return;
        }
        try {
            await this.leaderLock.release();
            this.isLeader = false;
            this.leaderLock = null;
            if (this.leaderHeartbeatInterval) {
                clearInterval(this.leaderHeartbeatInterval);
                this.leaderHeartbeatInterval = null;
            }
            this.logger.info('Released leadership', {
                instanceId: this.config.instanceId
            });
        }
        catch (error) {
            this.logger.error('Failed to release leadership', { error });
        }
    }
    // ===========================================================================
    // Health Monitoring
    // ===========================================================================
    initializeOwnRegion() {
        const regionHealth = {
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
    startHealthMonitoring() {
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
    async performHealthCheck() {
        try {
            // Update own region health
            await this.updateOwnRegionHealth();
            // Fetch health from other regions
            await this.fetchRemoteRegionHealth();
            // Evaluate failover conditions (only if leader)
            if (this.isLeader) {
                await this.evaluateFailoverConditions();
            }
        }
        catch (error) {
            this.logger.error('Health check failed', { error });
        }
    }
    async updateOwnRegionHealth() {
        const region = this.regions.get(this.config.regionId);
        if (!region)
            return;
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
    async persistRegionHealth(region) {
        if (!this.redis)
            return;
        try {
            const key = `${this.HEALTH_KEY_PREFIX}${region.regionId}`;
            await this.redis.set(key, region, 60); // 60 second TTL
        }
        catch (error) {
            this.logger.error('Failed to persist region health', { error });
        }
    }
    async fetchRemoteRegionHealth() {
        if (!this.redis)
            return;
        try {
            // Get all region health keys
            const keys = await this.redis.keys(`${this.HEALTH_KEY_PREFIX}*`);
            for (const key of keys) {
                const regionId = key.replace(this.HEALTH_KEY_PREFIX, '');
                // Skip own region
                if (regionId === this.config.regionId)
                    continue;
                const healthData = await this.redis.get(key);
                if (healthData) {
                    this.regions.set(regionId, healthData);
                }
            }
        }
        catch (error) {
            this.logger.error('Failed to fetch remote region health', { error });
        }
    }
    async updateOwnRegionStatus(status) {
        const region = this.regions.get(this.config.regionId);
        if (region) {
            region.status = status;
            await this.persistRegionHealth(region);
        }
    }
    // ===========================================================================
    // Failover Logic (ADR-007)
    // ===========================================================================
    async evaluateFailoverConditions() {
        for (const [regionId, region] of this.regions) {
            // Skip own region
            if (regionId === this.config.regionId)
                continue;
            // Check for stale health data
            const healthAge = Date.now() - region.lastHealthCheck;
            const isStale = healthAge > this.config.healthCheckIntervalMs * 3;
            if (isStale || region.status === 'failed') {
                region.consecutiveFailures++;
                if (region.consecutiveFailures >= this.config.failoverThreshold) {
                    await this.triggerFailover(regionId);
                }
            }
            else {
                region.consecutiveFailures = 0;
            }
        }
    }
    /**
     * Trigger failover for a failed region.
     */
    async triggerFailover(failedRegion) {
        this.logger.warn(`Triggering failover for region: ${failedRegion}`);
        const startTime = Date.now();
        const region = this.regions.get(failedRegion);
        if (!region) {
            return;
        }
        // 1. Mark region as failed
        region.status = 'failed';
        // 2. Emit failover started event
        const failoverEvent = {
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
            const completedEvent = {
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
        }
        catch (error) {
            // Emit failure
            const failedEvent = {
                type: 'failover_failed',
                sourceRegion: failedRegion,
                targetRegion: this.config.regionId,
                services: region.services.map(s => s.serviceName),
                timestamp: Date.now(),
                durationMs: Date.now() - startTime,
                error: error.message
            };
            this.emit('failoverFailed', failedEvent);
            await this.publishFailoverEvent(failedEvent);
            this.logger.error('Failover failed', { error, failedRegion });
        }
    }
    async activateStandbyServices(failedRegion) {
        // This would activate standby services for the failed region
        // Implementation depends on deployment infrastructure (Fly.io, Oracle, etc.)
        this.logger.info('Activating standby services', { failedRegion });
        // Emit activation request for standby services to handle
        this.emit('activateStandby', {
            failedRegion,
            timestamp: Date.now()
        });
    }
    async updateRoutingTable(failedRegion) {
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
    async subscribeToFailoverEvents() {
        if (!this.redis)
            return;
        try {
            await this.redis.subscribe(this.FAILOVER_CHANNEL, (message) => {
                const event = message.data;
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
            });
        }
        catch (error) {
            this.logger.error('Failed to subscribe to failover events', { error });
        }
    }
    /**
     * P0-11 FIX: Publish failover events to both Redis Streams (guaranteed delivery)
     * and Pub/Sub (backward compatibility during migration).
     */
    async publishFailoverEvent(event) {
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
            }
            catch (error) {
                this.logger.error('Failed to publish failover event to stream', { error });
            }
        }
        // Secondary - Publish to Pub/Sub for backward compatibility
        if (this.redis) {
            try {
                await this.redis.publish(this.FAILOVER_CHANNEL, message);
            }
            catch (error) {
                this.logger.error('Failed to publish failover event to pub/sub', { error });
            }
        }
    }
    onStandbyActivation(event) {
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
     */
    evaluateGlobalHealth() {
        const detectors = [];
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
        let degradationLevel;
        if (totalDetectors === 0) {
            // No detectors registered yet
            degradationLevel = DegradationLevel.READ_ONLY;
        }
        else if (healthyDetectors === 0) {
            // All detectors unhealthy
            degradationLevel = DegradationLevel.READ_ONLY;
        }
        else if (!executorHealthy) {
            // Detectors working but executor down - can detect but not execute
            degradationLevel = DegradationLevel.DETECTION_ONLY;
        }
        else if (healthyDetectors < totalDetectors) {
            // Some detectors unhealthy
            degradationLevel = DegradationLevel.REDUCED_CHAINS;
        }
        else {
            // All systems healthy
            degradationLevel = DegradationLevel.FULL_OPERATION;
        }
        // Overall status
        let overallStatus;
        if (degradationLevel === DegradationLevel.FULL_OPERATION) {
            overallStatus = 'healthy';
        }
        else if (degradationLevel >= DegradationLevel.READ_ONLY) {
            overallStatus = 'critical';
        }
        else {
            overallStatus = 'degraded';
        }
        return {
            redis: { healthy: this.redis !== null, latencyMs: 0 },
            executor: { healthy: executorHealthy, region: executorRegion },
            detectors,
            degradationLevel,
            overallStatus
        };
    }
    // ===========================================================================
    // Public Getters
    // ===========================================================================
    getIsLeader() {
        return this.isLeader;
    }
    getRegionHealth(regionId) {
        return this.regions.get(regionId);
    }
    getAllRegionsHealth() {
        return new Map(this.regions);
    }
    getOwnRegionId() {
        return this.config.regionId;
    }
    isActive() {
        return this.isRunning;
    }
}
exports.CrossRegionHealthManager = CrossRegionHealthManager;
// =============================================================================
// Singleton Instance
// =============================================================================
let globalCrossRegionHealthManager = null;
function getCrossRegionHealthManager(config) {
    if (!globalCrossRegionHealthManager && config) {
        globalCrossRegionHealthManager = new CrossRegionHealthManager(config);
    }
    if (!globalCrossRegionHealthManager) {
        throw new Error('CrossRegionHealthManager not initialized. Call with config first.');
    }
    return globalCrossRegionHealthManager;
}
async function resetCrossRegionHealthManager() {
    if (globalCrossRegionHealthManager) {
        await globalCrossRegionHealthManager.stop();
        globalCrossRegionHealthManager = null;
    }
}
//# sourceMappingURL=cross-region-health.js.map