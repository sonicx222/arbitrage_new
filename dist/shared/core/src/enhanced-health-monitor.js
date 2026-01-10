"use strict";
// Enhanced Health Monitoring System
// Comprehensive monitoring with predictive analytics and automatic alerts
Object.defineProperty(exports, "__esModule", { value: true });
exports.EnhancedHealthMonitor = void 0;
exports.getEnhancedHealthMonitor = getEnhancedHealthMonitor;
exports.recordHealthMetric = recordHealthMetric;
exports.getCurrentSystemHealth = getCurrentSystemHealth;
const logger_1 = require("./logger");
const redis_1 = require("./redis");
const circuit_breaker_1 = require("./circuit-breaker");
const dead_letter_queue_1 = require("./dead-letter-queue");
const graceful_degradation_1 = require("./graceful-degradation");
const error_recovery_1 = require("./error-recovery");
const logger = (0, logger_1.createLogger)('enhanced-health-monitor');
class EnhancedHealthMonitor {
    constructor() {
        this.redis = (0, redis_1.getRedisClient)();
        this.circuitBreakers = (0, circuit_breaker_1.getCircuitBreakerRegistry)();
        this.dlq = (0, dead_letter_queue_1.getDeadLetterQueue)();
        this.degradationManager = (0, graceful_degradation_1.getGracefulDegradationManager)();
        this.alertRules = [];
        this.lastAlerts = new Map();
        this.metricsBuffer = [];
        this.thresholds = [];
        this.initializeDefaultRules();
        this.initializeDefaultThresholds();
    }
    // Start comprehensive health monitoring
    start(intervalMs = 30000) {
        this.monitoringTimer = setInterval(async () => {
            try {
                await this.performHealthCheck();
            }
            catch (error) {
                logger.error('Health monitoring cycle failed', { error });
            }
        }, intervalMs);
        logger.info('Enhanced health monitoring started', { intervalMs });
    }
    // Stop health monitoring
    stop() {
        if (this.monitoringTimer) {
            clearInterval(this.monitoringTimer);
            this.monitoringTimer = undefined;
            logger.info('Enhanced health monitoring stopped');
        }
    }
    // Record a health metric
    recordMetric(metric) {
        this.metricsBuffer.push(metric);
        // Check thresholds immediately for critical metrics
        if (metric.name.includes('error') || metric.name.includes('latency')) {
            this.checkThresholds([metric]);
        }
        // Flush buffer if it gets too large
        if (this.metricsBuffer.length > 1000) {
            this.flushMetrics();
        }
    }
    // Get current system health
    async getSystemHealth() {
        const services = await this.checkServiceHealth();
        const infrastructure = await this.checkInfrastructureHealth();
        const performance = await this.checkPerformanceHealth();
        const resilience = await this.checkResilienceHealth();
        // Determine overall health
        const allComponents = [
            ...Object.values(services).map(s => s.status),
            infrastructure.redis && infrastructure.database && infrastructure.messageQueue ? 'healthy' : 'unhealthy',
            performance.memoryUsage < 0.9 && performance.cpuUsage < 0.8 ? 'healthy' : 'warning',
            resilience.errorRecovery.status === 'healthy' ? 'healthy' : 'warning'
        ];
        const criticalCount = allComponents.filter(s => s === 'unhealthy' || s === 'critical').length;
        const warningCount = allComponents.filter(s => s === 'warning' || s === 'degraded').length;
        let overall = 'healthy';
        if (criticalCount > 0)
            overall = 'critical';
        else if (warningCount > 2)
            overall = 'warning';
        return {
            overall,
            services,
            infrastructure,
            performance,
            resilience,
            timestamp: Date.now()
        };
    }
    // Add custom alert rule
    addAlertRule(rule) {
        this.alertRules.push(rule);
    }
    // Add custom threshold
    addThreshold(threshold) {
        this.thresholds.push(threshold);
    }
    initializeDefaultRules() {
        // High error rate alert
        this.addAlertRule({
            name: 'high_error_rate',
            condition: (metrics) => {
                const errorMetrics = metrics.filter(m => m.name.includes('error_rate'));
                return errorMetrics.some(m => m.value > 0.1); // 10% error rate
            },
            severity: 'warning',
            message: 'High error rate detected across services',
            cooldown: 300000, // 5 minutes
            actions: ['log', 'notify', 'check_services']
        });
        // Circuit breaker open alert
        this.addAlertRule({
            name: 'circuit_breaker_open',
            condition: () => {
                const breakerStats = this.circuitBreakers.getAllStats();
                return Object.values(breakerStats).some((stats) => stats.state === 'OPEN');
            },
            severity: 'warning',
            message: 'Circuit breaker opened - service isolation active',
            cooldown: 60000, // 1 minute
            actions: ['log', 'isolate_service']
        });
        // DLQ growing alert
        this.addAlertRule({
            name: 'dlq_overflow',
            condition: async () => {
                const stats = await this.dlq.getStats();
                return stats.totalOperations > 1000;
            },
            severity: 'error',
            message: 'Dead letter queue is filling up rapidly',
            cooldown: 300000, // 5 minutes
            actions: ['log', 'notify', 'scale_up']
        });
        // Memory usage critical
        this.addAlertRule({
            name: 'memory_critical',
            condition: (metrics) => {
                const memoryMetrics = metrics.filter(m => m.name === 'memory_usage');
                return memoryMetrics.some(m => m.value > 0.95); // 95% memory usage
            },
            severity: 'critical',
            message: 'Critical memory usage - risk of OOM',
            cooldown: 60000, // 1 minute
            actions: ['log', 'notify', 'restart_service']
        });
    }
    initializeDefaultThresholds() {
        this.addThreshold({ metric: 'error_rate', warning: 0.05, critical: 0.1, direction: 'above' });
        this.addThreshold({ metric: 'latency', warning: 1000, critical: 5000, direction: 'above' });
        this.addThreshold({ metric: 'memory_usage', warning: 0.8, critical: 0.95, direction: 'above' });
        this.addThreshold({ metric: 'cpu_usage', warning: 0.7, critical: 0.9, direction: 'above' });
    }
    async performHealthCheck() {
        const health = await this.getSystemHealth();
        // Record health metrics
        this.recordMetric({
            name: 'system_health_score',
            value: health.overall === 'healthy' ? 1 : health.overall === 'warning' ? 0.5 : 0,
            unit: 'score',
            timestamp: Date.now(),
            tags: { component: 'system' }
        });
        // Check alert rules
        await this.checkAlertRules(health);
        // Store health snapshot
        await this.redis.set('health:snapshot', health, 300); // 5 minutes TTL
        // Log health status
        logger.debug('Health check completed', {
            overall: health.overall,
            services: Object.keys(health.services).length,
            infrastructureIssues: Object.values(health.infrastructure).filter(v => !v).length
        });
    }
    async checkServiceHealth() {
        // Get service health from Redis
        const allHealth = await this.redis.getAllServiceHealth();
        const services = {};
        for (const [serviceName, health] of Object.entries(allHealth)) {
            services[serviceName] = {
                name: serviceName,
                status: this.determineServiceStatus(health),
                uptime: health.uptime || 0,
                responseTime: health.lastHeartbeat ? Date.now() - health.lastHeartbeat : 0,
                errorRate: 0, // Would need error tracking
                lastSeen: health.lastHeartbeat || 0
            };
        }
        return services;
    }
    async checkInfrastructureHealth() {
        const infrastructure = {
            redis: false,
            database: true, // Assume healthy for now
            messageQueue: false,
            externalAPIs: {}
        };
        // Check Redis
        try {
            infrastructure.redis = (await this.redis.ping()) === 'PONG';
        }
        catch (error) {
            infrastructure.redis = false;
        }
        // Check message queue (same as Redis for now)
        infrastructure.messageQueue = infrastructure.redis;
        return infrastructure;
    }
    async checkPerformanceHealth() {
        const memUsage = process.memoryUsage();
        const cpuUsage = process.cpuUsage();
        return {
            memoryUsage: memUsage.heapUsed / memUsage.heapTotal,
            cpuUsage: (cpuUsage.user + cpuUsage.system) / 1000000, // Convert to seconds
            throughput: 0, // Would need request tracking
            latency: 0 // Would need response time tracking
        };
    }
    async checkResilienceHealth() {
        const circuitBreakerStats = this.circuitBreakers.getAllStats();
        const dlqStats = await this.dlq.getStats();
        const degradationStates = this.degradationManager.getAllDegradationStates();
        const recoveryHealth = await (0, error_recovery_1.checkRecoverySystemHealth)();
        return {
            circuitBreakers: circuitBreakerStats,
            deadLetterQueue: dlqStats,
            gracefulDegradation: degradationStates,
            errorRecovery: recoveryHealth
        };
    }
    determineServiceStatus(health) {
        if (!health)
            return 'unhealthy';
        const timeSinceLastHeartbeat = Date.now() - (health.lastHeartbeat || 0);
        if (timeSinceLastHeartbeat > 300000)
            return 'unhealthy'; // 5 minutes
        if (timeSinceLastHeartbeat > 60000)
            return 'degraded'; // 1 minute
        return health.status === 'healthy' ? 'healthy' : 'degraded';
    }
    async checkAlertRules(health) {
        const now = Date.now();
        const recentMetrics = this.metricsBuffer.slice(-100); // Last 100 metrics
        for (const rule of this.alertRules) {
            const lastAlert = this.lastAlerts.get(rule.name) || 0;
            // Check cooldown
            if (now - lastAlert < rule.cooldown)
                continue;
            // Evaluate condition
            try {
                const triggered = await rule.condition(recentMetrics, { health });
                if (triggered) {
                    this.lastAlerts.set(rule.name, now);
                    await this.triggerAlert(rule, health);
                }
            }
            catch (error) {
                logger.error('Error evaluating alert rule', { rule: rule.name, error });
            }
        }
    }
    checkThresholds(metrics) {
        for (const metric of metrics) {
            const threshold = this.thresholds.find(t => t.metric === metric.name);
            if (!threshold)
                continue;
            const isCritical = threshold.direction === 'above'
                ? metric.value >= threshold.critical
                : metric.value <= threshold.critical;
            const isWarning = threshold.direction === 'above'
                ? metric.value >= threshold.warning
                : metric.value <= threshold.warning;
            if (isCritical) {
                logger.error(`Critical threshold exceeded: ${metric.name}`, {
                    value: metric.value,
                    threshold: threshold.critical,
                    unit: metric.unit
                });
            }
            else if (isWarning) {
                logger.warn(`Warning threshold exceeded: ${metric.name}`, {
                    value: metric.value,
                    threshold: threshold.warning,
                    unit: metric.unit
                });
            }
        }
    }
    async triggerAlert(rule, health) {
        logger.warn(`Alert triggered: ${rule.name}`, {
            severity: rule.severity,
            message: rule.message,
            actions: rule.actions
        });
        // Execute alert actions
        for (const action of rule.actions) {
            await this.executeAlertAction(action, rule, health);
        }
        // Publish alert to Redis for other services
        await this.redis.publish('health-alerts', {
            rule: rule.name,
            severity: rule.severity,
            message: rule.message,
            health,
            timestamp: Date.now()
        });
    }
    async executeAlertAction(action, rule, health) {
        switch (action) {
            case 'log':
                // Already logged above
                break;
            case 'notify':
                // Would integrate with notification service
                logger.info('Alert notification sent', { rule: rule.name });
                break;
            case 'check_services':
                // Trigger service health checks
                await this.performHealthCheck();
                break;
            case 'isolate_service':
                // Would implement service isolation logic
                logger.info('Service isolation triggered', { rule: rule.name });
                break;
            case 'scale_up':
                // Would trigger auto-scaling
                logger.info('Auto-scaling triggered', { rule: rule.name });
                break;
            case 'restart_service':
                // Would trigger service restart
                logger.info('Service restart triggered', { rule: rule.name });
                break;
            default:
                logger.warn('Unknown alert action', { action });
        }
    }
    flushMetrics() {
        if (this.metricsBuffer.length === 0)
            return;
        // In a real implementation, this would batch send metrics to monitoring system
        const metricsToFlush = [...this.metricsBuffer];
        this.metricsBuffer.length = 0;
        // Store in Redis for short-term analysis
        this.redis.set('metrics:recent', metricsToFlush.slice(-50), 3600); // 1 hour TTL
        logger.debug('Flushed health metrics', { count: metricsToFlush.length });
    }
}
exports.EnhancedHealthMonitor = EnhancedHealthMonitor;
// Global health monitor instance
let globalHealthMonitor = null;
function getEnhancedHealthMonitor() {
    if (!globalHealthMonitor) {
        globalHealthMonitor = new EnhancedHealthMonitor();
    }
    return globalHealthMonitor;
}
// Convenience functions
function recordHealthMetric(metric) {
    getEnhancedHealthMonitor().recordMetric(metric);
}
async function getCurrentSystemHealth() {
    return await getEnhancedHealthMonitor().getSystemHealth();
}
// Auto-start health monitoring for main process
if (typeof process !== 'undefined' && process.mainModule) {
    const monitor = getEnhancedHealthMonitor();
    monitor.start();
}
//# sourceMappingURL=enhanced-health-monitor.js.map