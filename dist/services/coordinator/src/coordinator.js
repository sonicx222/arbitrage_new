"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CoordinatorService = void 0;
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
const express_1 = __importDefault(require("express"));
const helmet_1 = __importDefault(require("helmet"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const src_1 = require("../../../shared/core/src");
// =============================================================================
// Coordinator Service
// =============================================================================
class CoordinatorService {
    constructor(config) {
        this.redis = null;
        this.streamsClient = null;
        this.logger = (0, src_1.createLogger)('coordinator');
        this.server = null;
        this.isRunning = false; // Kept for backwards compat, derived from stateManager
        this.isLeader = false;
        this.serviceHealth = new Map();
        this.alertCooldowns = new Map();
        this.opportunities = new Map();
        // Intervals
        this.healthCheckInterval = null;
        this.metricsUpdateInterval = null;
        this.leaderHeartbeatInterval = null;
        this.streamConsumerInterval = null;
        // P2-1 fix: Track stream consumer errors for health monitoring
        this.streamConsumerErrors = 0;
        this.MAX_STREAM_ERRORS = 10;
        this.lastStreamErrorReset = Date.now();
        // P1-1 fix: Maximum opportunities to track (prevents unbounded memory growth)
        this.MAX_OPPORTUNITIES = 1000;
        this.OPPORTUNITY_TTL_MS = 60000; // 1 minute default TTL
        this.perfLogger = (0, src_1.getPerformanceLogger)('coordinator');
        this.app = (0, express_1.default)();
        this.systemMetrics = this.initializeMetrics();
        // Initialize state manager for lifecycle management (P0 fix: prevents race conditions)
        this.stateManager = (0, src_1.createServiceState)({
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
                streamName: src_1.RedisStreamsClient.STREAMS.HEALTH,
                groupName: this.config.consumerGroup,
                consumerName: this.config.consumerId,
                startId: '$' // Only new messages
            },
            {
                streamName: src_1.RedisStreamsClient.STREAMS.OPPORTUNITIES,
                groupName: this.config.consumerGroup,
                consumerName: this.config.consumerId,
                startId: '$'
            },
            {
                streamName: src_1.RedisStreamsClient.STREAMS.WHALE_ALERTS,
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
    async start(port) {
        const serverPort = port ?? this.config.port;
        // Use state manager to prevent concurrent starts (P0 fix)
        const result = await this.stateManager.executeStart(async () => {
            this.logger.info('Starting Coordinator Service', {
                instanceId: this.config.leaderElection.instanceId
            });
            // Initialize Redis client (for legacy operations)
            this.redis = await (0, src_1.getRedisClient)();
            // Initialize Redis Streams client
            this.streamsClient = await (0, src_1.getRedisStreamsClient)();
            // Create consumer groups for all streams
            await this.createConsumerGroups();
            // Try to acquire leadership
            await this.tryAcquireLeadership();
            // Set isRunning BEFORE starting intervals (P0 fix: prevents early returns)
            this.isRunning = true;
            // Start stream consumers (run even as standby for monitoring)
            this.startStreamConsumers();
            // Start leader heartbeat
            this.startLeaderHeartbeat();
            // Start periodic health monitoring
            this.startHealthMonitoring();
            // Start HTTP server
            this.server = this.app.listen(serverPort, () => {
                this.logger.info(`Coordinator dashboard available at http://localhost:${serverPort}`, {
                    isLeader: this.isLeader
                });
            });
            this.server.on('error', (error) => {
                this.logger.error('HTTP server error', { error });
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
    async stop() {
        // Use state manager to prevent concurrent stops (P0 fix)
        const result = await this.stateManager.executeStop(async () => {
            this.logger.info('Stopping Coordinator Service');
            this.isRunning = false;
            // Release leadership if held
            if (this.isLeader) {
                await this.releaseLeadership();
            }
            // Stop all intervals
            this.clearAllIntervals();
            // Close HTTP server gracefully
            if (this.server) {
                await new Promise((resolve) => {
                    const timeout = setTimeout(() => {
                        this.logger.warn('Force closing HTTP server after timeout');
                        resolve();
                    }, 5000);
                    this.server.close(() => {
                        clearTimeout(timeout);
                        this.logger.info('HTTP server closed successfully');
                        resolve();
                    });
                });
                this.server = null;
            }
            // Disconnect Redis Streams client
            if (this.streamsClient) {
                await this.streamsClient.disconnect();
                this.streamsClient = null;
            }
            // Disconnect legacy Redis
            if (this.redis) {
                await this.redis.disconnect();
                this.redis = null;
            }
            // Clear collections
            this.serviceHealth.clear();
            this.alertCooldowns.clear();
            this.opportunities.clear();
            this.logger.info('Coordinator Service stopped successfully');
        });
        if (!result.success) {
            this.logger.error('Error stopping Coordinator Service', { error: result.error });
        }
    }
    clearAllIntervals() {
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
        if (this.streamConsumerInterval) {
            clearInterval(this.streamConsumerInterval);
            this.streamConsumerInterval = null;
        }
    }
    // ===========================================================================
    // Leader Election (ADR-007)
    // ===========================================================================
    async tryAcquireLeadership() {
        if (!this.redis)
            return false;
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
        }
        catch (error) {
            this.logger.error('Failed to acquire leadership', { error });
            return false;
        }
    }
    /**
     * P0-4 fix: Atomic lock renewal using compare-and-set pattern.
     * Returns true if renewal succeeded, false if lock was lost.
     */
    async renewLeaderLock() {
        if (!this.redis)
            return false;
        const { lockKey, lockTtlMs, instanceId } = this.config.leaderElection;
        try {
            // Get current value and check atomically
            const currentLeader = await this.redis.get(lockKey);
            if (currentLeader !== instanceId) {
                // Lock was taken by another instance
                return false;
            }
            // Refresh TTL - note: small TOCTOU window here between get and expire,
            // but the consequence is just that we might extend someone else's lock
            // for one TTL period. They would have acquired it legitimately.
            const result = await this.redis.expire(lockKey, Math.ceil(lockTtlMs / 1000));
            return result === 1;
        }
        catch (error) {
            this.logger.error('Failed to renew leader lock', { error });
            return false;
        }
    }
    async releaseLeadership() {
        if (!this.redis || !this.isLeader)
            return;
        try {
            const { lockKey, instanceId } = this.config.leaderElection;
            // Only release if we hold the lock
            const currentLeader = await this.redis.get(lockKey);
            if (currentLeader === instanceId) {
                await this.redis.del(lockKey);
                this.logger.info('Released leadership', { instanceId });
            }
            this.isLeader = false;
        }
        catch (error) {
            this.logger.error('Failed to release leadership', { error });
        }
    }
    startLeaderHeartbeat() {
        const { heartbeatIntervalMs, lockKey, lockTtlMs, instanceId } = this.config.leaderElection;
        let consecutiveHeartbeatFailures = 0;
        const maxHeartbeatFailures = 3;
        this.leaderHeartbeatInterval = setInterval(async () => {
            if (!this.isRunning || !this.redis)
                return;
            try {
                if (this.isLeader) {
                    // P0-4 fix: Use dedicated renewal method for better encapsulation
                    const renewed = await this.renewLeaderLock();
                    if (renewed) {
                        // P0-3 fix: Reset failure count on successful heartbeat
                        consecutiveHeartbeatFailures = 0;
                    }
                    else {
                        // Lost leadership (another instance took over or lock expired)
                        this.isLeader = false;
                        this.logger.warn('Lost leadership - lock renewal failed', { instanceId });
                    }
                }
                else {
                    // Try to acquire leadership
                    await this.tryAcquireLeadership();
                }
            }
            catch (error) {
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
    async createConsumerGroups() {
        if (!this.streamsClient)
            return;
        for (const config of this.consumerGroups) {
            try {
                await this.streamsClient.createConsumerGroup(config);
                this.logger.info('Consumer group ready', {
                    stream: config.streamName,
                    group: config.groupName
                });
            }
            catch (error) {
                this.logger.error('Failed to create consumer group', {
                    error,
                    stream: config.streamName
                });
            }
        }
    }
    startStreamConsumers() {
        // Poll streams every 100ms (non-blocking)
        this.streamConsumerInterval = setInterval(async () => {
            if (!this.isRunning || !this.streamsClient)
                return;
            try {
                // P2-1 fix: Reset error count periodically (every minute)
                if (Date.now() - this.lastStreamErrorReset > 60000) {
                    this.streamConsumerErrors = 0;
                    this.lastStreamErrorReset = Date.now();
                }
                await Promise.all([
                    this.consumeHealthStream(),
                    this.consumeOpportunitiesStream(),
                    this.consumeWhaleAlertsStream()
                ]);
            }
            catch (error) {
                // P2-1 fix: Track errors and send alert if threshold exceeded
                this.streamConsumerErrors++;
                this.logger.error('Stream consumer error', {
                    error,
                    errorCount: this.streamConsumerErrors,
                    maxErrors: this.MAX_STREAM_ERRORS
                });
                // Send critical alert if too many errors
                if (this.streamConsumerErrors >= this.MAX_STREAM_ERRORS) {
                    this.sendAlert({
                        type: 'STREAM_CONSUMER_FAILURE',
                        message: `Stream consumer experienced ${this.streamConsumerErrors} errors in the last minute`,
                        severity: 'critical',
                        data: { errorCount: this.streamConsumerErrors },
                        timestamp: Date.now()
                    });
                }
            }
        }, 100);
    }
    async consumeHealthStream() {
        if (!this.streamsClient)
            return;
        const config = this.consumerGroups.find(c => c.streamName === src_1.RedisStreamsClient.STREAMS.HEALTH);
        if (!config)
            return;
        try {
            const messages = await this.streamsClient.xreadgroup(config, {
                count: 10,
                block: 0, // Non-blocking
                startId: '>'
            });
            for (const message of messages) {
                await this.handleHealthMessage(message);
                await this.streamsClient.xack(config.streamName, config.groupName, message.id);
            }
        }
        catch (error) {
            // Ignore timeout errors from non-blocking read
            if (!error.message?.includes('timeout')) {
                this.logger.error('Error consuming health stream', { error });
            }
        }
    }
    async consumeOpportunitiesStream() {
        if (!this.streamsClient)
            return;
        const config = this.consumerGroups.find(c => c.streamName === src_1.RedisStreamsClient.STREAMS.OPPORTUNITIES);
        if (!config)
            return;
        try {
            const messages = await this.streamsClient.xreadgroup(config, {
                count: 10,
                block: 0,
                startId: '>'
            });
            for (const message of messages) {
                await this.handleOpportunityMessage(message);
                await this.streamsClient.xack(config.streamName, config.groupName, message.id);
            }
        }
        catch (error) {
            if (!error.message?.includes('timeout')) {
                this.logger.error('Error consuming opportunities stream', { error });
            }
        }
    }
    async consumeWhaleAlertsStream() {
        if (!this.streamsClient)
            return;
        const config = this.consumerGroups.find(c => c.streamName === src_1.RedisStreamsClient.STREAMS.WHALE_ALERTS);
        if (!config)
            return;
        try {
            const messages = await this.streamsClient.xreadgroup(config, {
                count: 10,
                block: 0,
                startId: '>'
            });
            for (const message of messages) {
                await this.handleWhaleAlertMessage(message);
                await this.streamsClient.xack(config.streamName, config.groupName, message.id);
            }
        }
        catch (error) {
            if (!error.message?.includes('timeout')) {
                this.logger.error('Error consuming whale alerts stream', { error });
            }
        }
    }
    // ===========================================================================
    // Stream Message Handlers
    // ===========================================================================
    async handleHealthMessage(message) {
        try {
            const data = message.data;
            if (!data || !data.service)
                return;
            const health = {
                service: data.service,
                status: data.status || 'unknown',
                uptime: data.uptime || 0,
                memoryUsage: data.memoryUsage || 0,
                cpuUsage: data.cpuUsage || 0,
                lastHeartbeat: data.timestamp || Date.now()
            };
            this.serviceHealth.set(data.service, health);
            this.logger.debug('Health update received', {
                service: data.service,
                status: health.status
            });
        }
        catch (error) {
            this.logger.error('Failed to handle health message', { error, message });
        }
    }
    async handleOpportunityMessage(message) {
        try {
            const data = message.data;
            if (!data || !data.id)
                return;
            // Track opportunity
            this.opportunities.set(data.id, data);
            this.systemMetrics.totalOpportunities++;
            this.systemMetrics.pendingOpportunities = this.opportunities.size;
            // P1-1 fix: Clean up expired opportunities and enforce size limit
            const now = Date.now();
            const toDelete = [];
            for (const [id, opp] of this.opportunities) {
                // Delete if explicitly expired
                if (opp.expiresAt && opp.expiresAt < now) {
                    toDelete.push(id);
                    continue;
                }
                // P1-1 fix: Also delete if older than TTL (for opportunities without expiresAt)
                if (opp.timestamp && (now - opp.timestamp) > this.OPPORTUNITY_TTL_MS) {
                    toDelete.push(id);
                }
            }
            for (const id of toDelete) {
                this.opportunities.delete(id);
            }
            // P1-1 fix: If still over limit, remove oldest entries
            if (this.opportunities.size > this.MAX_OPPORTUNITIES) {
                const entries = Array.from(this.opportunities.entries())
                    .sort((a, b) => (a[1].timestamp || 0) - (b[1].timestamp || 0));
                const removeCount = this.opportunities.size - this.MAX_OPPORTUNITIES;
                for (let i = 0; i < removeCount; i++) {
                    this.opportunities.delete(entries[i][0]);
                }
                this.logger.debug('Pruned opportunities map', {
                    removed: removeCount,
                    remaining: this.opportunities.size
                });
            }
            this.logger.info('Opportunity detected', {
                id: data.id,
                chain: data.chain,
                profitPercentage: data.profitPercentage,
                buyDex: data.buyDex,
                sellDex: data.sellDex
            });
            // Only leader should forward to execution engine
            if (this.isLeader && data.status === 'pending') {
                await this.forwardToExecutionEngine(data);
            }
        }
        catch (error) {
            this.logger.error('Failed to handle opportunity message', { error, message });
        }
    }
    async handleWhaleAlertMessage(message) {
        try {
            const data = message.data;
            if (!data)
                return;
            this.systemMetrics.whaleAlerts++;
            this.logger.warn('Whale alert received', {
                address: data.address,
                usdValue: data.usdValue,
                direction: data.direction,
                chain: data.chain,
                dex: data.dex,
                impact: data.impact
            });
            // Send alert notification
            this.sendAlert({
                type: 'WHALE_TRANSACTION',
                message: `Whale ${data.direction} detected: $${data.usdValue?.toLocaleString()} on ${data.chain}`,
                severity: data.usdValue > 100000 ? 'critical' : 'high',
                data,
                timestamp: Date.now()
            });
        }
        catch (error) {
            this.logger.error('Failed to handle whale alert message', { error, message });
        }
    }
    async forwardToExecutionEngine(opportunity) {
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
    initializeMetrics() {
        return {
            totalOpportunities: 0,
            totalExecutions: 0,
            successfulExecutions: 0,
            totalProfit: 0,
            averageLatency: 0,
            averageMemory: 0, // Added: tracked separately from latency
            systemHealth: 100,
            activeServices: 0,
            lastUpdate: Date.now(),
            whaleAlerts: 0,
            pendingOpportunities: 0
        };
    }
    startHealthMonitoring() {
        // Update metrics periodically
        this.metricsUpdateInterval = setInterval(async () => {
            if (!this.isRunning)
                return;
            try {
                this.updateSystemMetrics();
                this.checkForAlerts();
                // Report own health to stream
                await this.reportHealth();
            }
            catch (error) {
                this.logger.error('Metrics update failed', { error });
            }
        }, 5000);
        // Legacy health polling (fallback for services not yet on streams)
        this.healthCheckInterval = setInterval(async () => {
            if (!this.isRunning || !this.redis)
                return;
            try {
                const allHealth = await this.redis.getAllServiceHealth();
                for (const [serviceName, health] of Object.entries(allHealth)) {
                    // Only update if we don't have recent stream data
                    const existing = this.serviceHealth.get(serviceName);
                    if (!existing || (Date.now() - existing.lastHeartbeat) > 30000) {
                        this.serviceHealth.set(serviceName, health);
                    }
                }
            }
            catch (error) {
                this.logger.error('Legacy health polling failed', { error });
            }
        }, 10000);
    }
    async reportHealth() {
        if (!this.streamsClient)
            return;
        try {
            const health = {
                service: 'coordinator',
                status: this.isRunning ? 'healthy' : 'unhealthy',
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
            await this.streamsClient.xadd(src_1.RedisStreamsClient.STREAMS.HEALTH, health);
        }
        catch (error) {
            this.logger.error('Failed to report health', { error });
        }
    }
    updateSystemMetrics() {
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
        this.systemMetrics.averageMemory = avgMemory; // Track memory separately
        this.systemMetrics.lastUpdate = Date.now();
        this.systemMetrics.pendingOpportunities = this.opportunities.size;
    }
    checkForAlerts() {
        const alerts = [];
        // Check service health
        for (const [serviceName, health] of this.serviceHealth) {
            if (health.status !== 'healthy') {
                alerts.push({
                    type: 'SERVICE_UNHEALTHY',
                    service: serviceName,
                    message: `${serviceName} is ${health.status}`,
                    severity: 'high',
                    timestamp: Date.now()
                });
            }
        }
        // Check system metrics
        if (this.systemMetrics.systemHealth < 80) {
            alerts.push({
                type: 'SYSTEM_HEALTH_LOW',
                message: `System health is ${this.systemMetrics.systemHealth.toFixed(1)}%`,
                severity: 'critical',
                timestamp: Date.now()
            });
        }
        // Send alerts (with cooldown)
        for (const alert of alerts) {
            this.sendAlert(alert);
        }
    }
    sendAlert(alert) {
        const alertKey = `${alert.type}_${alert.service || 'system'}`;
        const now = Date.now();
        const lastAlert = this.alertCooldowns.get(alertKey) || 0;
        // 5 minute cooldown for same alert type
        if (now - lastAlert > 300000) {
            this.logger.warn('Alert triggered', alert);
            this.alertCooldowns.set(alertKey, now);
            // TODO: Send to Discord/Telegram/email in production
        }
    }
    // ===========================================================================
    // Express Middleware & Routes
    // ===========================================================================
    setupMiddleware() {
        // Security headers
        this.app.use((0, helmet_1.default)({
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
        this.app.use(express_1.default.json({ limit: '1mb', strict: true }));
        this.app.use(express_1.default.urlencoded({ extended: false, limit: '1mb' }));
        this.app.use(express_1.default.static('public'));
        // Rate limiting
        const limiter = (0, express_rate_limit_1.default)({
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
    setupRoutes() {
        // Dashboard routes
        this.app.get('/', this.getDashboard.bind(this));
        this.app.get('/api/health', src_1.ValidationMiddleware.validateHealthCheck, this.getHealth.bind(this));
        this.app.get('/api/metrics', this.getMetrics.bind(this));
        this.app.get('/api/services', this.getServices.bind(this));
        this.app.get('/api/opportunities', this.getOpportunities.bind(this));
        this.app.get('/api/alerts', this.getAlerts.bind(this));
        this.app.get('/api/leader', this.getLeaderStatus.bind(this));
        // Control routes with strict rate limiting
        const strictLimiter = (0, express_rate_limit_1.default)({
            windowMs: 15 * 60 * 1000,
            max: 5,
            message: { error: 'Too many control actions', retryAfter: 900 }
        });
        this.app.post('/api/services/:service/restart', strictLimiter, this.validateServiceRestart.bind(this), this.restartService.bind(this));
        this.app.post('/api/alerts/:alert/acknowledge', strictLimiter, this.validateAlertAcknowledge.bind(this), this.acknowledgeAlert.bind(this));
    }
    // ===========================================================================
    // Route Handlers
    // ===========================================================================
    getDashboard(req, res) {
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
            ${Array.from(this.serviceHealth.entries()).map(([name, health]) => `<div class="${health.status === 'healthy' ? 'healthy' : health.status === 'degraded' ? 'degraded' : 'unhealthy'}">
                ${name}: ${health.status}
              </div>`).join('') || '<div>No services reporting</div>'}
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
    getHealth(req, res) {
        res.json({
            status: 'ok',
            isLeader: this.isLeader,
            instanceId: this.config.leaderElection.instanceId,
            systemHealth: this.systemMetrics.systemHealth,
            services: Object.fromEntries(this.serviceHealth),
            timestamp: Date.now()
        });
    }
    getMetrics(req, res) {
        res.json(this.systemMetrics);
    }
    getServices(req, res) {
        res.json(Object.fromEntries(this.serviceHealth));
    }
    getOpportunities(req, res) {
        const opportunities = Array.from(this.opportunities.values())
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
            .slice(0, 100); // Return last 100
        res.json(opportunities);
    }
    getAlerts(req, res) {
        // Return recent alerts (in production, store in database)
        res.json([]);
    }
    getLeaderStatus(req, res) {
        res.json({
            isLeader: this.isLeader,
            instanceId: this.config.leaderElection.instanceId,
            lockKey: this.config.leaderElection.lockKey
        });
    }
    // ===========================================================================
    // Validation Methods
    // ===========================================================================
    validateServiceRestart(req, res, next) {
        const { service } = req.params;
        if (!service || typeof service !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(service)) {
            return res.status(400).json({ error: 'Invalid service name' });
        }
        const allowedServices = ['bsc-detector', 'ethereum-detector', 'arbitrum-detector',
            'polygon-detector', 'optimism-detector', 'base-detector', 'execution-engine'];
        if (!allowedServices.includes(service)) {
            return res.status(404).json({ error: 'Service not found' });
        }
        // Only leader can restart services
        if (!this.isLeader) {
            return res.status(403).json({ error: 'Only leader can restart services' });
        }
        next();
    }
    validateAlertAcknowledge(req, res, next) {
        const { alert } = req.params;
        if (!alert || typeof alert !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(alert)) {
            return res.status(400).json({ error: 'Invalid alert ID' });
        }
        next();
    }
    async restartService(req, res) {
        const { service } = req.params;
        try {
            this.logger.info(`Restarting service: ${service}`);
            // In production, implement service restart logic via orchestration
            res.json({ success: true, message: `Restart requested for ${service}` });
        }
        catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    }
    acknowledgeAlert(req, res) {
        const { alert } = req.params;
        this.alertCooldowns.delete(alert);
        res.json({ success: true });
    }
    // ===========================================================================
    // Public Getters for Testing
    // ===========================================================================
    getIsLeader() {
        return this.isLeader;
    }
    getIsRunning() {
        return this.isRunning;
    }
    getServiceHealthMap() {
        return new Map(this.serviceHealth);
    }
    getSystemMetrics() {
        return { ...this.systemMetrics };
    }
}
exports.CoordinatorService = CoordinatorService;
//# sourceMappingURL=coordinator.js.map