"use strict";
/**
 * Redis Streams Health Monitor
 *
 * Monitors Redis Streams health, lag, and performance metrics
 *
 * @see ADR-002: Redis Streams over Pub/Sub
 * @see S1.1.5: Add Stream health monitoring
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.StreamHealthMonitor = void 0;
exports.getStreamHealthMonitor = getStreamHealthMonitor;
exports.resetStreamHealthMonitor = resetStreamHealthMonitor;
const logger_1 = require("./logger");
const redis_streams_1 = require("./redis-streams");
const defaultLogger = (0, logger_1.createLogger)('stream-health-monitor');
/**
 * Redis Streams Health Monitor
 * Provides comprehensive monitoring for Redis Streams
 */
class StreamHealthMonitor {
    constructor(config = {}) {
        this.streamsClient = null;
        this.injectedStreamsClient = null;
        this.monitoredStreams = new Set();
        this.alertHandlers = [];
        this.monitoringInterval = null;
        this.lastMetrics = new Map();
        this.initialized = false;
        this.initializingPromise = null; // Race condition fix
        this.lastAlerts = new Map(); // Alert deduplication
        this.alertCooldownMs = 60000; // 1 minute cooldown between same alerts
        this.defaultConsumerGroup = 'arbitrage-group'; // Configurable group name
        this.maxAlertAge = 3600000; // Remove alerts older than 1 hour
        this.maxMetricsAge = 600000; // Remove metrics older than 10 minutes
        // Use injected dependencies or defaults
        this.logger = config.logger ?? defaultLogger;
        this.injectedStreamsClient = config.streamsClient ?? null;
        // Default thresholds
        this.thresholds = {
            lagWarning: 100,
            lagCritical: 1000,
            lengthWarning: 10000,
            lengthCritical: 100000
        };
        // Initialize default streams to monitor
        this.monitoredStreams.add(redis_streams_1.RedisStreamsClient.STREAMS.PRICE_UPDATES);
        this.monitoredStreams.add(redis_streams_1.RedisStreamsClient.STREAMS.SWAP_EVENTS);
        this.monitoredStreams.add(redis_streams_1.RedisStreamsClient.STREAMS.OPPORTUNITIES);
        this.monitoredStreams.add(redis_streams_1.RedisStreamsClient.STREAMS.WHALE_ALERTS);
        this.monitoredStreams.add(redis_streams_1.RedisStreamsClient.STREAMS.VOLUME_AGGREGATES);
        this.monitoredStreams.add(redis_streams_1.RedisStreamsClient.STREAMS.HEALTH);
    }
    /**
     * Initialize the streams client (with race condition protection)
     */
    async ensureInitialized() {
        if (this.initialized) {
            return;
        }
        // Use injected client if provided
        if (this.injectedStreamsClient) {
            this.streamsClient = this.injectedStreamsClient;
            this.initialized = true;
            return;
        }
        // Prevent concurrent initialization (race condition fix)
        if (this.initializingPromise) {
            return this.initializingPromise;
        }
        this.initializingPromise = (async () => {
            try {
                this.streamsClient = await (0, redis_streams_1.getRedisStreamsClient)();
                this.initialized = true;
            }
            catch (error) {
                this.logger.error('Failed to initialize streams client', { error });
                this.initializingPromise = null; // Allow retry on failure
                throw error;
            }
        })();
        return this.initializingPromise;
    }
    /**
     * Set the default consumer group name
     */
    setConsumerGroup(groupName) {
        this.defaultConsumerGroup = groupName;
        this.logger.info('Default consumer group updated', { groupName });
    }
    /**
     * Set alert cooldown period
     */
    setAlertCooldown(cooldownMs) {
        this.alertCooldownMs = cooldownMs;
    }
    /**
     * Start periodic health monitoring
     */
    async start(intervalMs = 30000) {
        await this.ensureInitialized();
        this.monitoringInterval = setInterval(async () => {
            try {
                await this.checkStreamHealth();
                // Periodically cleanup old entries to prevent memory leaks
                this.cleanupOldEntries();
            }
            catch (error) {
                this.logger.error('Stream health check failed', { error });
            }
        }, intervalMs);
        this.logger.info('Stream health monitoring started', {
            streams: Array.from(this.monitoredStreams),
            intervalMs
        });
    }
    /**
     * Cleanup old entries from maps to prevent memory leaks
     */
    cleanupOldEntries() {
        const now = Date.now();
        // Cleanup old alert entries
        for (const [key, timestamp] of this.lastAlerts.entries()) {
            if (now - timestamp > this.maxAlertAge) {
                this.lastAlerts.delete(key);
            }
        }
        // Cleanup old metrics entries
        for (const [key, metric] of this.lastMetrics.entries()) {
            if (now - metric.timestamp > this.maxMetricsAge) {
                this.lastMetrics.delete(key);
            }
        }
    }
    /**
     * Stop health monitoring
     */
    async stop() {
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.monitoringInterval = null;
        }
        // Clear maps to free memory
        this.lastAlerts.clear();
        this.lastMetrics.clear();
        this.logger.info('Stream health monitoring stopped');
    }
    /**
     * Check health of all monitored streams
     */
    async checkStreamHealth() {
        await this.ensureInitialized();
        const streams = {};
        let hasWarning = false;
        let hasCritical = false;
        // Check Redis connectivity first
        const isConnected = await this.streamsClient.ping();
        if (!isConnected) {
            this.triggerAlert({
                type: 'stream_unavailable',
                severity: 'critical',
                stream: 'all',
                message: 'Redis Streams connection unavailable',
                timestamp: Date.now()
            });
            return {
                overall: 'critical',
                streams: {},
                timestamp: Date.now()
            };
        }
        for (const streamName of this.monitoredStreams) {
            try {
                const info = await this.getStreamInfo(streamName);
                streams[streamName] = info;
                // Only count initialized streams for health status
                // 'unknown' means stream not initialized yet - not an error
                if (info.status === 'critical') {
                    hasCritical = true;
                }
                else if (info.status === 'warning') {
                    hasWarning = true;
                }
                // 'unknown' status is ignored for overall health - it's a startup condition
                // Only trigger lag alerts for initialized streams with actual lag
                if (info.status !== 'unknown') {
                    if (info.pendingCount >= this.thresholds.lagCritical) {
                        this.triggerAlert({
                            type: 'high_lag',
                            severity: 'critical',
                            stream: streamName,
                            message: `Critical lag detected: ${info.pendingCount} pending messages`,
                            timestamp: Date.now()
                        });
                    }
                    else if (info.pendingCount >= this.thresholds.lagWarning) {
                        this.triggerAlert({
                            type: 'high_lag',
                            severity: 'warning',
                            stream: streamName,
                            message: `Warning: ${info.pendingCount} pending messages`,
                            timestamp: Date.now()
                        });
                    }
                }
            }
            catch (error) {
                this.logger.warn(`Failed to get health for stream: ${streamName}`, { error });
                streams[streamName] = {
                    name: streamName,
                    length: 0,
                    pendingCount: 0,
                    consumerGroups: 0,
                    lastGeneratedId: '',
                    status: 'unknown'
                };
            }
        }
        let overall = 'healthy';
        if (hasCritical) {
            overall = 'critical';
        }
        else if (hasWarning) {
            overall = 'warning';
        }
        return {
            overall,
            streams,
            timestamp: Date.now()
        };
    }
    /**
     * Get detailed info for a specific stream.
     * Handles streams that don't exist yet (common during startup).
     */
    async getStreamInfo(streamName) {
        const length = await this.streamsClient.xlen(streamName);
        const info = await this.streamsClient.xinfo(streamName);
        // Calculate pending count by checking consumer groups
        // xpending now returns defaults if group doesn't exist (no throw)
        const pendingInfo = await this.streamsClient.xpending(streamName, this.defaultConsumerGroup);
        const pendingCount = pendingInfo.total;
        // Determine status based on stream state
        let status;
        // Stream doesn't exist yet (length=0 and no lastGeneratedId)
        const streamNotInitialized = info.length === 0 && info.lastGeneratedId === '0-0';
        if (streamNotInitialized) {
            // Not an error - stream just hasn't received data yet
            status = 'unknown';
        }
        else if (pendingCount >= this.thresholds.lagCritical || length >= this.thresholds.lengthCritical) {
            status = 'critical';
        }
        else if (pendingCount >= this.thresholds.lagWarning || length >= this.thresholds.lengthWarning) {
            status = 'warning';
        }
        else {
            status = 'healthy';
        }
        return {
            name: streamName,
            length: info.length,
            pendingCount,
            consumerGroups: info.groups,
            lastGeneratedId: info.lastGeneratedId,
            status
        };
    }
    /**
     * Get lag info for a specific stream and consumer group
     */
    async getStreamLag(streamName, groupName) {
        await this.ensureInitialized();
        try {
            const pendingInfo = await this.streamsClient.xpending(streamName, groupName);
            // Determine status based on thresholds
            let status = 'healthy';
            if (pendingInfo.total >= this.thresholds.lagCritical) {
                status = 'critical';
            }
            else if (pendingInfo.total >= this.thresholds.lagWarning) {
                status = 'warning';
            }
            // Map consumer info
            const consumers = (pendingInfo.consumers || []).map((c) => ({
                name: c.name,
                pending: parseInt(String(c.pending)),
                idle: 0
            }));
            return {
                streamName,
                groupName,
                pendingMessages: pendingInfo.total,
                oldestPendingId: pendingInfo.smallestId,
                newestPendingId: pendingInfo.largestId,
                consumers,
                status,
                timestamp: Date.now()
            };
        }
        catch (error) {
            this.logger.warn(`Failed to get lag for ${streamName}:${groupName}`, { error });
            return {
                streamName,
                groupName,
                pendingMessages: 0,
                oldestPendingId: null,
                newestPendingId: null,
                consumers: [],
                status: 'unknown',
                timestamp: Date.now()
            };
        }
    }
    /**
     * Get stream metrics including throughput
     */
    async getStreamMetrics(streamName) {
        await this.ensureInitialized();
        const length = await this.streamsClient.xlen(streamName);
        const now = Date.now();
        // Calculate messages per second based on length change
        let messagesPerSecond = 0;
        const lastMetric = this.lastMetrics.get(streamName);
        if (lastMetric) {
            const timeDiff = (now - lastMetric.timestamp) / 1000;
            if (timeDiff > 0) {
                messagesPerSecond = Math.max(0, (length - lastMetric.length) / timeDiff);
            }
        }
        // Store current metric for next calculation
        this.lastMetrics.set(streamName, { length, timestamp: now });
        // Get pending count
        let pendingCount = 0;
        try {
            const pendingInfo = await this.streamsClient.xpending(streamName, this.defaultConsumerGroup);
            pendingCount = pendingInfo.total;
        }
        catch {
            // Group may not exist
        }
        return {
            streamName,
            length,
            messagesPerSecond,
            pendingCount,
            consumerCount: 0, // Would need XINFO GROUPS for this
            oldestMessageAge: 0 // Would need to parse message IDs
        };
    }
    /**
     * Get health of a specific consumer group
     */
    async getConsumerGroupHealth(streamName, groupName) {
        await this.ensureInitialized();
        try {
            const pendingInfo = await this.streamsClient.xpending(streamName, groupName);
            let status = 'healthy';
            if (pendingInfo.total >= this.thresholds.lagCritical) {
                status = 'critical';
            }
            else if (pendingInfo.total >= this.thresholds.lagWarning) {
                status = 'warning';
            }
            return {
                groupName,
                consumers: (pendingInfo.consumers || []).length,
                pending: pendingInfo.total,
                lastDeliveredId: pendingInfo.largestId || '',
                status
            };
        }
        catch (error) {
            return {
                groupName,
                consumers: 0,
                pending: 0,
                lastDeliveredId: '',
                status: 'unknown'
            };
        }
    }
    /**
     * Get summary statistics for all monitored streams
     */
    async getSummary() {
        const health = await this.checkStreamHealth();
        let healthyCount = 0;
        let warningCount = 0;
        let criticalCount = 0;
        let totalPending = 0;
        for (const streamInfo of Object.values(health.streams)) {
            if (streamInfo.status === 'healthy')
                healthyCount++;
            else if (streamInfo.status === 'warning')
                warningCount++;
            else if (streamInfo.status === 'critical')
                criticalCount++;
            totalPending += streamInfo.pendingCount;
        }
        const streamCount = Object.keys(health.streams).length;
        const averageLag = streamCount > 0 ? totalPending / streamCount : 0;
        return {
            totalStreams: streamCount,
            healthyStreams: healthyCount,
            warningStreams: warningCount,
            criticalStreams: criticalCount,
            totalPending,
            averageLag,
            timestamp: Date.now()
        };
    }
    /**
     * Export metrics in Prometheus format
     */
    async getPrometheusMetrics() {
        const health = await this.checkStreamHealth();
        const lines = [];
        lines.push('# HELP stream_length Number of messages in stream');
        lines.push('# TYPE stream_length gauge');
        for (const [name, info] of Object.entries(health.streams)) {
            lines.push(`stream_length{stream="${name}"} ${info.length}`);
        }
        lines.push('# HELP stream_pending Number of pending messages');
        lines.push('# TYPE stream_pending gauge');
        for (const [name, info] of Object.entries(health.streams)) {
            lines.push(`stream_pending{stream="${name}"} ${info.pendingCount}`);
        }
        lines.push('# HELP stream_consumer_groups Number of consumer groups');
        lines.push('# TYPE stream_consumer_groups gauge');
        for (const [name, info] of Object.entries(health.streams)) {
            lines.push(`stream_consumer_groups{stream="${name}"} ${info.consumerGroups}`);
        }
        lines.push('# HELP stream_health_status Stream health status (1=healthy, 0.5=warning, 0=critical)');
        lines.push('# TYPE stream_health_status gauge');
        for (const [name, info] of Object.entries(health.streams)) {
            const statusValue = info.status === 'healthy' ? 1 : info.status === 'warning' ? 0.5 : 0;
            lines.push(`stream_health_status{stream="${name}"} ${statusValue}`);
        }
        return lines.join('\n');
    }
    /**
     * Register an alert handler
     */
    onAlert(handler) {
        this.alertHandlers.push(handler);
    }
    /**
     * Trigger an alert to all registered handlers (with deduplication)
     */
    triggerAlert(alert) {
        // Alert deduplication - create unique key from type and stream
        const alertKey = `${alert.type}:${alert.stream}:${alert.severity}`;
        const lastAlertTime = this.lastAlerts.get(alertKey);
        const now = Date.now();
        // Skip if same alert was triggered within cooldown period
        if (lastAlertTime && (now - lastAlertTime) < this.alertCooldownMs) {
            this.logger.debug('Alert suppressed (cooldown)', { alertKey, cooldownRemaining: this.alertCooldownMs - (now - lastAlertTime) });
            return;
        }
        // Update last alert time
        this.lastAlerts.set(alertKey, now);
        this.logger.warn('Stream alert triggered', alert);
        for (const handler of this.alertHandlers) {
            try {
                handler(alert);
            }
            catch (error) {
                this.logger.error('Alert handler error', { error });
            }
        }
    }
    /**
     * Configure thresholds
     */
    setThresholds(thresholds) {
        this.thresholds = { ...this.thresholds, ...thresholds };
        this.logger.info('Stream health thresholds updated', this.thresholds);
    }
    /**
     * Get current configuration
     */
    getConfig() {
        return { ...this.thresholds };
    }
    /**
     * Add a stream to monitor
     */
    addStream(streamName) {
        this.monitoredStreams.add(streamName);
        this.logger.info('Added stream to monitoring', { streamName });
    }
    /**
     * Remove a stream from monitoring
     */
    removeStream(streamName) {
        this.monitoredStreams.delete(streamName);
        this.logger.info('Removed stream from monitoring', { streamName });
    }
    /**
     * Get list of monitored streams
     */
    getMonitoredStreams() {
        return Array.from(this.monitoredStreams);
    }
}
exports.StreamHealthMonitor = StreamHealthMonitor;
// Singleton instance
let globalStreamHealthMonitor = null;
/**
 * Get the global stream health monitor instance
 */
function getStreamHealthMonitor() {
    if (!globalStreamHealthMonitor) {
        globalStreamHealthMonitor = new StreamHealthMonitor();
    }
    return globalStreamHealthMonitor;
}
/**
 * Reset the global instance (for testing)
 */
function resetStreamHealthMonitor() {
    if (globalStreamHealthMonitor) {
        globalStreamHealthMonitor.stop();
        globalStreamHealthMonitor = null;
    }
}
//# sourceMappingURL=stream-health-monitor.js.map