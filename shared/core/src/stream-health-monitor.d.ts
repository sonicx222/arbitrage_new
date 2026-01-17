/**
 * Redis Streams Health Monitor
 *
 * Monitors Redis Streams health, lag, and performance metrics
 *
 * @see ADR-002: Redis Streams over Pub/Sub
 * @see S1.1.5: Add Stream health monitoring
 */
import { RedisStreamsClient } from './redis-streams';
/** Logger interface for dependency injection */
interface Logger {
    info: (message: string, meta?: object) => void;
    error: (message: string, meta?: object) => void;
    warn: (message: string, meta?: object) => void;
    debug: (message: string, meta?: object) => void;
}
/** Configuration options for StreamHealthMonitor */
export interface StreamHealthMonitorConfig {
    /** Optional logger for testing (defaults to createLogger) */
    logger?: Logger;
    /** Optional streams client for testing (defaults to getRedisStreamsClient) */
    streamsClient?: RedisStreamsClient;
}
export type StreamHealthStatus = 'healthy' | 'warning' | 'critical' | 'unknown';
export interface StreamLagInfo {
    streamName: string;
    groupName: string;
    pendingMessages: number;
    oldestPendingId: string | null;
    newestPendingId: string | null;
    consumers: ConsumerLagInfo[];
    status: StreamHealthStatus;
    timestamp: number;
}
export interface ConsumerLagInfo {
    name: string;
    pending: number;
    idle: number;
}
export interface MonitoredStreamInfo {
    name: string;
    length: number;
    pendingCount: number;
    consumerGroups: number;
    lastGeneratedId: string;
    status: StreamHealthStatus;
}
export interface StreamHealth {
    overall: StreamHealthStatus;
    streams: Record<string, MonitoredStreamInfo>;
    timestamp: number;
}
export interface StreamMetrics {
    streamName: string;
    length: number;
    messagesPerSecond: number;
    pendingCount: number;
    consumerCount: number;
    oldestMessageAge: number;
}
export interface ConsumerGroupHealth {
    groupName: string;
    consumers: number;
    pending: number;
    lastDeliveredId: string;
    status: StreamHealthStatus;
}
export interface StreamHealthSummary {
    totalStreams: number;
    healthyStreams: number;
    warningStreams: number;
    criticalStreams: number;
    totalPending: number;
    averageLag: number;
    timestamp: number;
}
export interface StreamHealthThresholds {
    lagWarning: number;
    lagCritical: number;
    lengthWarning: number;
    lengthCritical: number;
}
export interface StreamAlert {
    type: string;
    severity: 'info' | 'warning' | 'critical';
    stream: string;
    message: string;
    timestamp: number;
}
type AlertHandler = (alert: StreamAlert) => void;
/**
 * Redis Streams Health Monitor
 * Provides comprehensive monitoring for Redis Streams
 */
export declare class StreamHealthMonitor {
    private streamsClient;
    private injectedStreamsClient;
    private logger;
    private monitoredStreams;
    private thresholds;
    private alertHandlers;
    private monitoringInterval;
    private lastMetrics;
    private initialized;
    private initializingPromise;
    private lastAlerts;
    private alertCooldownMs;
    private defaultConsumerGroup;
    private maxAlertAge;
    private maxMetricsAge;
    constructor(config?: StreamHealthMonitorConfig);
    /**
     * Initialize the streams client (with race condition protection)
     */
    private ensureInitialized;
    /**
     * Set the default consumer group name
     */
    setConsumerGroup(groupName: string): void;
    /**
     * Set alert cooldown period
     */
    setAlertCooldown(cooldownMs: number): void;
    /**
     * Start periodic health monitoring
     */
    start(intervalMs?: number): Promise<void>;
    /**
     * Cleanup old entries from maps to prevent memory leaks
     */
    private cleanupOldEntries;
    /**
     * Stop health monitoring
     */
    stop(): Promise<void>;
    /**
     * Check health of all monitored streams
     */
    checkStreamHealth(): Promise<StreamHealth>;
    /**
     * Get detailed info for a specific stream.
     * Handles streams that don't exist yet (common during startup).
     */
    private getStreamInfo;
    /**
     * Get lag info for a specific stream and consumer group
     */
    getStreamLag(streamName: string, groupName: string): Promise<StreamLagInfo>;
    /**
     * Get stream metrics including throughput
     */
    getStreamMetrics(streamName: string): Promise<StreamMetrics>;
    /**
     * Get health of a specific consumer group
     */
    getConsumerGroupHealth(streamName: string, groupName: string): Promise<ConsumerGroupHealth>;
    /**
     * Get summary statistics for all monitored streams
     */
    getSummary(): Promise<StreamHealthSummary>;
    /**
     * Export metrics in Prometheus format
     */
    getPrometheusMetrics(): Promise<string>;
    /**
     * Register an alert handler
     */
    onAlert(handler: AlertHandler): void;
    /**
     * Trigger an alert to all registered handlers (with deduplication)
     */
    private triggerAlert;
    /**
     * Configure thresholds
     */
    setThresholds(thresholds: Partial<StreamHealthThresholds>): void;
    /**
     * Get current configuration
     */
    getConfig(): StreamHealthThresholds;
    /**
     * Add a stream to monitor
     */
    addStream(streamName: string): void;
    /**
     * Remove a stream from monitoring
     */
    removeStream(streamName: string): void;
    /**
     * Get list of monitored streams
     */
    getMonitoredStreams(): string[];
}
/**
 * Get the global stream health monitor instance
 */
export declare function getStreamHealthMonitor(): StreamHealthMonitor;
/**
 * Reset the global instance (for testing)
 */
export declare function resetStreamHealthMonitor(): void;
export {};
//# sourceMappingURL=stream-health-monitor.d.ts.map