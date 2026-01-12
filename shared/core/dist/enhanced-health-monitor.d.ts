import { StreamHealthSummary } from './stream-health-monitor';
export interface HealthMetric {
    name: string;
    value: number;
    unit: string;
    timestamp: number;
    tags?: Record<string, string>;
}
export interface HealthThreshold {
    metric: string;
    warning: number;
    critical: number;
    direction: 'above' | 'below';
}
export interface AlertRule {
    name: string;
    condition: (metrics: HealthMetric[], context: any) => boolean | Promise<boolean>;
    severity: 'info' | 'warning' | 'error' | 'critical';
    message: string;
    cooldown: number;
    actions: string[];
}
export interface SystemHealth {
    overall: 'healthy' | 'warning' | 'critical' | 'unknown';
    services: Record<string, ServiceHealth>;
    infrastructure: InfrastructureHealth;
    performance: PerformanceHealth;
    resilience: ResilienceHealth;
    timestamp: number;
}
export interface ServiceHealth {
    name: string;
    status: 'healthy' | 'degraded' | 'unhealthy';
    uptime: number;
    responseTime: number;
    errorRate: number;
    lastSeen: number;
}
export interface InfrastructureHealth {
    redis: boolean;
    database: boolean;
    messageQueue: boolean;
    streams: StreamHealthSummary | null;
    externalAPIs: Record<string, boolean>;
}
export interface PerformanceHealth {
    memoryUsage: number;
    cpuUsage: number;
    throughput: number;
    latency: number;
}
export interface ResilienceHealth {
    circuitBreakers: Record<string, any>;
    deadLetterQueue: any;
    gracefulDegradation: any;
    errorRecovery: any;
}
export declare class EnhancedHealthMonitor {
    private redis;
    private streamsClient;
    private circuitBreakers;
    private dlq;
    private degradationManager;
    private alertRules;
    private lastAlerts;
    private metricsBuffer;
    private thresholds;
    private monitoringTimer?;
    constructor();
    /**
     * P1-17 FIX: Initialize Redis Streams client for dual-publish pattern.
     */
    private initializeStreamsClient;
    /**
     * P1-17 FIX: Dual-publish helper - publishes to both Redis Streams (primary)
     * and Pub/Sub (secondary/fallback) for backwards compatibility.
     */
    private dualPublish;
    start(intervalMs?: number): void;
    stop(): void;
    recordMetric(metric: HealthMetric): void;
    getSystemHealth(): Promise<SystemHealth>;
    addAlertRule(rule: AlertRule): void;
    addThreshold(threshold: HealthThreshold): void;
    private initializeDefaultRules;
    private initializeDefaultThresholds;
    private performHealthCheck;
    private checkServiceHealth;
    private checkInfrastructureHealth;
    private checkPerformanceHealth;
    private checkResilienceHealth;
    private determineServiceStatus;
    private checkAlertRules;
    private checkThresholds;
    private triggerAlert;
    private executeAlertAction;
    private flushMetrics;
}
export declare function getEnhancedHealthMonitor(): EnhancedHealthMonitor;
export declare function recordHealthMetric(metric: HealthMetric): void;
export declare function getCurrentSystemHealth(): Promise<SystemHealth>;
//# sourceMappingURL=enhanced-health-monitor.d.ts.map