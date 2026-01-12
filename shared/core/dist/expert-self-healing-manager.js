"use strict";
// Expert Self-Healing Manager
// Implements enterprise-grade automatic recovery patterns with intelligent decision making
//
// P0-10 FIX (Partial): Migrating from Pub/Sub to Redis Streams for critical system control messages
// This ensures guaranteed delivery per ADR-002.
//
// Migration Status:
// - [DONE] Added streams client for publishing to streams
// - [DONE] Created helper for dual publish (streams + pub/sub for backward compatibility)
// - [TODO] Add consumer groups for stream consumption
// - [TODO] Remove Pub/Sub after all consumers migrated
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExpertSelfHealingManager = exports.RecoveryStrategy = exports.FailureSeverity = void 0;
exports.getExpertSelfHealingManager = getExpertSelfHealingManager;
const logger_1 = require("./logger");
const redis_1 = require("./redis");
const redis_streams_1 = require("./redis-streams");
const circuit_breaker_1 = require("./circuit-breaker");
const dead_letter_queue_1 = require("./dead-letter-queue");
const enhanced_health_monitor_1 = require("./enhanced-health-monitor");
const error_recovery_1 = require("./error-recovery");
const logger = (0, logger_1.createLogger)('expert-self-healing-manager');
// P0-10 FIX: Stream names for system control messages (ADR-002 compliant)
const SYSTEM_STREAMS = {
    FAILURES: 'stream:system-failures',
    CONTROL: 'stream:system-control',
    FAILOVER: 'stream:system-failover',
    SCALING: 'stream:system-scaling'
};
var FailureSeverity;
(function (FailureSeverity) {
    FailureSeverity["LOW"] = "low";
    FailureSeverity["MEDIUM"] = "medium";
    FailureSeverity["HIGH"] = "high";
    FailureSeverity["CRITICAL"] = "critical"; // System-wide impact, emergency procedures
})(FailureSeverity || (exports.FailureSeverity = FailureSeverity = {}));
var RecoveryStrategy;
(function (RecoveryStrategy) {
    RecoveryStrategy["RESTART_SERVICE"] = "restart_service";
    RecoveryStrategy["FAILOVER_TO_BACKUP"] = "failover_to_backup";
    RecoveryStrategy["SCALE_UP_RESOURCES"] = "scale_up_resources";
    RecoveryStrategy["ROLLBACK_DEPLOYMENT"] = "rollback_deployment";
    RecoveryStrategy["CIRCUIT_BREAKER_TRIP"] = "circuit_breaker_trip";
    RecoveryStrategy["LOAD_SHEDDING"] = "load_shedding";
    RecoveryStrategy["DATA_REPAIR"] = "data_repair";
    RecoveryStrategy["NETWORK_RESET"] = "network_reset";
    RecoveryStrategy["MEMORY_COMPACTION"] = "memory_compaction";
    RecoveryStrategy["CONFIGURATION_RESET"] = "configuration_reset";
})(RecoveryStrategy || (exports.RecoveryStrategy = RecoveryStrategy = {}));
class ExpertSelfHealingManager {
    constructor() {
        this.redis = (0, redis_1.getRedisClient)();
        this.streamsClient = null; // P0-10 FIX: Add streams client
        this.circuitBreakers = (0, circuit_breaker_1.getCircuitBreakerRegistry)();
        this.dlq = (0, dead_letter_queue_1.getDeadLetterQueue)();
        this.healthMonitor = (0, enhanced_health_monitor_1.getEnhancedHealthMonitor)();
        this.errorRecovery = (0, error_recovery_1.getErrorRecoveryOrchestrator)();
        this.serviceHealthStates = new Map();
        this.activeRecoveryActions = new Map();
        this.failureHistory = [];
        this.recoveryCooldowns = new Map();
        this.isRunning = false;
        this.monitoringInterval = null;
        this.initializeDefaultStates();
    }
    /**
     * P0-10 FIX: Initialize streams client for ADR-002 compliant message delivery
     */
    async initializeStreamsClient() {
        if (!this.streamsClient) {
            this.streamsClient = await (0, redis_streams_1.getRedisStreamsClient)();
        }
    }
    /**
     * P0-10 FIX: Publish to both Redis Streams (for guaranteed delivery) and Pub/Sub (for backward compatibility)
     * This ensures messages are not lost even if the target service is temporarily unavailable.
     */
    async publishControlMessage(streamName, pubsubChannel, message) {
        const redis = await this.redis;
        // Primary: Publish to Redis Streams (guaranteed delivery)
        if (this.streamsClient) {
            try {
                await this.streamsClient.xadd(streamName, message, '*', { maxLen: 10000 });
                logger.debug('Published control message to stream', { streamName, type: message.type });
            }
            catch (error) {
                logger.error('Failed to publish to stream, falling back to pub/sub only', {
                    streamName,
                    error: error.message
                });
            }
        }
        // Secondary: Publish to Pub/Sub (backward compatibility during migration)
        try {
            await redis.publish(pubsubChannel, message);
        }
        catch (error) {
            logger.error('Failed to publish to pub/sub', {
                channel: pubsubChannel,
                error: error.message
            });
        }
    }
    async start() {
        if (this.isRunning)
            return;
        logger.info('Starting Expert Self-Healing Manager');
        this.isRunning = true;
        // P0-10 FIX: Initialize streams client for ADR-002 compliant messaging
        await this.initializeStreamsClient();
        // Start monitoring and recovery loops
        this.startHealthMonitoring();
        this.startFailureDetection();
        this.startRecoveryOrchestration();
        // Subscribe to failure events
        await this.subscribeToFailureEvents();
        logger.info('Expert Self-Healing Manager started successfully');
    }
    async stop() {
        if (!this.isRunning)
            return;
        logger.info('Stopping Expert Self-Healing Manager');
        this.isRunning = false;
        // Clear monitoring intervals
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.monitoringInterval = null;
        }
        // Cancel all active recovery actions
        for (const [actionId, action] of this.activeRecoveryActions) {
            if (action.status === 'executing') {
                await this.cancelRecoveryAction(actionId, 'System shutdown');
            }
        }
        logger.info('Expert Self-Healing Manager stopped');
    }
    // Report a failure for analysis and recovery
    async reportFailure(serviceName, component, error, context = {}) {
        const failure = {
            id: `failure_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            serviceName,
            component,
            error,
            severity: this.assessFailureSeverity(error, context),
            context,
            timestamp: Date.now(),
            recoveryAttempts: 0
        };
        // Add to history
        this.failureHistory.push(failure);
        if (this.failureHistory.length > 1000) {
            this.failureHistory = this.failureHistory.slice(-1000);
        }
        // Update service health state
        await this.updateServiceHealthState(serviceName, failure);
        // P0-10 FIX: Publish failure event to streams for guaranteed delivery
        await this.publishControlMessage(SYSTEM_STREAMS.FAILURES, 'system:failures', {
            type: 'failure_reported',
            data: {
                id: failure.id,
                serviceName: failure.serviceName,
                component: failure.component,
                errorMessage: failure.error.message,
                severity: failure.severity,
                context: failure.context,
                timestamp: failure.timestamp
            },
            timestamp: Date.now(),
            source: 'expert-self-healing-manager'
        });
        // Trigger immediate analysis and recovery
        await this.analyzeAndRecover(failure);
        logger.warn('Failure reported', {
            service: serviceName,
            component,
            severity: failure.severity,
            error: error.message
        });
    }
    // Assess failure severity based on error type and context
    assessFailureSeverity(error, context) {
        // Network-related failures
        if (error.message.includes('ECONNREFUSED') ||
            error.message.includes('ENOTFOUND') ||
            error.message.includes('timeout')) {
            return FailureSeverity.MEDIUM;
        }
        // Memory/CPU resource issues
        if (error.message.includes('out of memory') ||
            error.message.includes('heap limit') ||
            context.memoryUsage > 0.9) { // 90% memory usage
            return FailureSeverity.HIGH;
        }
        // Database connectivity issues
        if (error.message.includes('Redis') && error.message.includes('connection')) {
            return FailureSeverity.HIGH;
        }
        // Circuit breaker trips
        if (context.circuitBreakerTripped) {
            return FailureSeverity.MEDIUM;
        }
        // WebSocket disconnections (common, low severity)
        if (error.message.includes('WebSocket') &&
            (error.message.includes('close') || error.message.includes('disconnect'))) {
            return FailureSeverity.LOW;
        }
        // Data corruption or critical logic failures
        if (error.message.includes('corrupt') ||
            error.message.includes('invalid') ||
            context.dataIntegrityFailure) {
            return FailureSeverity.CRITICAL;
        }
        // Default to medium severity
        return FailureSeverity.MEDIUM;
    }
    // Update service health state based on failure
    async updateServiceHealthState(serviceName, failure) {
        if (!this.serviceHealthStates.has(serviceName)) {
            this.serviceHealthStates.set(serviceName, {
                serviceName,
                healthScore: 100,
                lastHealthyCheck: Date.now(),
                consecutiveFailures: 0,
                recoveryCooldown: 0,
                activeRecoveryActions: []
            });
        }
        const state = this.serviceHealthStates.get(serviceName);
        // Update consecutive failures
        if (failure.severity !== FailureSeverity.LOW) {
            state.consecutiveFailures++;
        }
        // Decrease health score based on severity
        const healthPenalty = {
            [FailureSeverity.LOW]: 5,
            [FailureSeverity.MEDIUM]: 15,
            [FailureSeverity.HIGH]: 30,
            [FailureSeverity.CRITICAL]: 50
        };
        state.healthScore = Math.max(0, state.healthScore - healthPenalty[failure.severity]);
        // Set recovery cooldown to prevent spam
        const cooldownTime = {
            [FailureSeverity.LOW]: 30000, // 30 seconds
            [FailureSeverity.MEDIUM]: 60000, // 1 minute
            [FailureSeverity.HIGH]: 300000, // 5 minutes
            [FailureSeverity.CRITICAL]: 600000 // 10 minutes
        };
        state.recoveryCooldown = Date.now() + cooldownTime[failure.severity];
        const redis = await this.redis;
        // Store in Redis for persistence
        await redis.set(`health_state:${serviceName}`, state, 3600); // 1 hour TTL
    }
    // Analyze failure and determine recovery strategy
    async analyzeAndRecover(failure) {
        const state = this.serviceHealthStates.get(failure.serviceName);
        if (!state)
            return;
        // Check if we're in recovery cooldown
        if (Date.now() < state.recoveryCooldown) {
            logger.debug('Skipping recovery due to cooldown', {
                service: failure.serviceName,
                cooldownRemaining: state.recoveryCooldown - Date.now()
            });
            return;
        }
        // Check if we have too many active recovery actions
        const activeActions = state.activeRecoveryActions.filter(a => a.status === 'executing');
        if (activeActions.length >= 3) {
            logger.warn('Too many active recovery actions, skipping', {
                service: failure.serviceName,
                activeCount: activeActions.length
            });
            return;
        }
        // Determine recovery strategy based on failure analysis
        const strategy = await this.determineRecoveryStrategy(failure, state);
        if (strategy) {
            await this.executeRecoveryAction(failure, strategy);
        }
    }
    // Determine the best recovery strategy for a failure
    async determineRecoveryStrategy(failure, state) {
        const { serviceName, component, error, severity, recoveryAttempts } = failure;
        // Don't attempt recovery if we've tried too many times recently
        if (recoveryAttempts >= 5) {
            logger.warn('Too many recovery attempts, escalating to manual intervention', {
                service: serviceName,
                attempts: recoveryAttempts
            });
            return null;
        }
        // Strategy selection based on failure pattern
        switch (component) {
            case 'websocket':
                if (severity === FailureSeverity.LOW) {
                    return RecoveryStrategy.NETWORK_RESET;
                }
                break;
            case 'redis':
                if (error.message.includes('connection')) {
                    return RecoveryStrategy.NETWORK_RESET;
                }
                break;
            case 'memory':
                if (severity >= FailureSeverity.HIGH) {
                    return RecoveryStrategy.MEMORY_COMPACTION;
                }
                break;
            case 'circuit_breaker':
                return RecoveryStrategy.CIRCUIT_BREAKER_TRIP;
            case 'database':
                return RecoveryStrategy.DATA_REPAIR;
            case 'service':
                // For service failures, try restart first, then failover
                if (recoveryAttempts === 0) {
                    return RecoveryStrategy.RESTART_SERVICE;
                }
                else if (recoveryAttempts <= 2) {
                    return RecoveryStrategy.FAILOVER_TO_BACKUP;
                }
                break;
        }
        // Health-based strategy selection
        if (state.healthScore < 30) {
            return RecoveryStrategy.SCALE_UP_RESOURCES;
        }
        if (state.consecutiveFailures >= 3) {
            return RecoveryStrategy.CONFIGURATION_RESET;
        }
        // Default strategy
        return RecoveryStrategy.RESTART_SERVICE;
    }
    // Execute a recovery action
    async executeRecoveryAction(failure, strategy) {
        const action = {
            id: `recovery_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            failureId: failure.id,
            strategy,
            status: 'pending',
            startTime: Date.now()
        };
        // Add to active actions
        this.activeRecoveryActions.set(action.id, action);
        const state = this.serviceHealthStates.get(failure.serviceName);
        if (state) {
            state.activeRecoveryActions.push(action);
        }
        try {
            action.status = 'executing';
            const success = await this.performRecoveryAction(failure, strategy);
            action.status = 'completed';
            action.endTime = Date.now();
            action.success = success;
            if (success) {
                // Reset consecutive failures on successful recovery
                if (state) {
                    state.consecutiveFailures = 0;
                    state.healthScore = Math.min(100, state.healthScore + 20); // Boost health
                }
                logger.info('Recovery action completed successfully', {
                    actionId: action.id,
                    strategy,
                    service: failure.serviceName,
                    duration: action.endTime - action.startTime
                });
            }
            else {
                action.rollbackRequired = true;
                logger.warn('Recovery action failed', {
                    actionId: action.id,
                    strategy,
                    service: failure.serviceName
                });
            }
        }
        catch (error) {
            action.status = 'failed';
            action.endTime = Date.now();
            action.error = error.message;
            action.rollbackRequired = true;
            logger.error('Recovery action threw exception', {
                actionId: action.id,
                strategy,
                service: failure.serviceName,
                error: error.message
            });
        }
        // Clean up active actions
        this.activeRecoveryActions.delete(action.id);
        if (state) {
            state.activeRecoveryActions = state.activeRecoveryActions.filter(a => a.id !== action.id);
        }
        const redis = await this.redis;
        // Store recovery action result
        await redis.set(`recovery_action:${action.id}`, action, 86400); // 24 hours
    }
    // Perform the actual recovery action
    async performRecoveryAction(failure, strategy) {
        const { serviceName } = failure;
        switch (strategy) {
            case RecoveryStrategy.RESTART_SERVICE:
                return await this.restartService(serviceName);
            case RecoveryStrategy.NETWORK_RESET:
                return await this.resetNetworkConnection(serviceName);
            case RecoveryStrategy.MEMORY_COMPACTION:
                return await this.performMemoryCompaction(serviceName);
            case RecoveryStrategy.CIRCUIT_BREAKER_TRIP:
                return await this.tripCircuitBreaker(serviceName);
            case RecoveryStrategy.DATA_REPAIR:
                return await this.repairDataIntegrity(serviceName);
            case RecoveryStrategy.CONFIGURATION_RESET:
                return await this.resetConfiguration(serviceName);
            case RecoveryStrategy.FAILOVER_TO_BACKUP:
                return await this.failoverToBackup(serviceName);
            case RecoveryStrategy.SCALE_UP_RESOURCES:
                return await this.scaleUpResources(serviceName);
            default:
                logger.warn('Unknown recovery strategy', { strategy });
                return false;
        }
    }
    // Individual recovery action implementations
    // P0-10 FIX: Updated to use publishControlMessage for dual stream/pub-sub delivery
    async restartService(serviceName) {
        try {
            // P0-10 FIX: Use streams for guaranteed delivery
            await this.publishControlMessage(SYSTEM_STREAMS.CONTROL, `service:${serviceName}:control`, {
                type: 'restart_command',
                serviceName,
                data: { command: 'restart' },
                timestamp: Date.now(),
                source: 'expert-self-healing-manager'
            });
            // Wait for service to report healthy
            const healthy = await this.waitForServiceHealth(serviceName, 30000);
            return healthy;
        }
        catch (error) {
            logger.error('Service restart failed', { service: serviceName, error });
            return false;
        }
    }
    async resetNetworkConnection(serviceName) {
        try {
            // P0-10 FIX: Use streams for guaranteed delivery
            await this.publishControlMessage(SYSTEM_STREAMS.CONTROL, `service:${serviceName}:control`, {
                type: 'reset_network_command',
                serviceName,
                data: { command: 'reset_network' },
                timestamp: Date.now(),
                source: 'expert-self-healing-manager'
            });
            return true;
        }
        catch (error) {
            logger.error('Network reset failed', { service: serviceName, error });
            return false;
        }
    }
    async performMemoryCompaction(serviceName) {
        try {
            // P0-10 FIX: Use streams for guaranteed delivery
            await this.publishControlMessage(SYSTEM_STREAMS.CONTROL, `service:${serviceName}:control`, {
                type: 'memory_compaction_command',
                serviceName,
                data: { command: 'memory_compaction' },
                timestamp: Date.now(),
                source: 'expert-self-healing-manager'
            });
            return true;
        }
        catch (error) {
            logger.error('Memory compaction failed', { service: serviceName, error });
            return false;
        }
    }
    async tripCircuitBreaker(serviceName) {
        try {
            const circuitBreaker = this.circuitBreakers.getBreaker(serviceName);
            if (circuitBreaker) {
                circuitBreaker.forceOpen();
                logger.info('Circuit breaker tripped', { service: serviceName });
            }
            return true;
        }
        catch (error) {
            logger.error('Circuit breaker trip failed', { service: serviceName, error });
            return false;
        }
    }
    async repairDataIntegrity(serviceName) {
        try {
            // P0-10 FIX: Use streams for guaranteed delivery
            await this.publishControlMessage(SYSTEM_STREAMS.CONTROL, `service:${serviceName}:control`, {
                type: 'repair_data_command',
                serviceName,
                data: { command: 'repair_data' },
                timestamp: Date.now(),
                source: 'expert-self-healing-manager'
            });
            return true;
        }
        catch (error) {
            logger.error('Data repair failed', { service: serviceName, error });
            return false;
        }
    }
    async resetConfiguration(serviceName) {
        try {
            // P0-10 FIX: Use streams for guaranteed delivery
            await this.publishControlMessage(SYSTEM_STREAMS.CONTROL, `service:${serviceName}:control`, {
                type: 'reset_config_command',
                serviceName,
                data: { command: 'reset_config' },
                timestamp: Date.now(),
                source: 'expert-self-healing-manager'
            });
            return true;
        }
        catch (error) {
            logger.error('Configuration reset failed', { service: serviceName, error });
            return false;
        }
    }
    async failoverToBackup(serviceName) {
        try {
            // P0-10 FIX: Use streams for guaranteed delivery of critical failover commands
            await this.publishControlMessage(SYSTEM_STREAMS.FAILOVER, 'system:failover', {
                type: 'failover_command',
                data: {
                    service: serviceName,
                    action: 'activate_backup'
                },
                timestamp: Date.now(),
                source: 'expert-self-healing-manager'
            });
            return true;
        }
        catch (error) {
            logger.error('Failover failed', { service: serviceName, error });
            return false;
        }
    }
    async scaleUpResources(serviceName) {
        try {
            // P0-10 FIX: Use streams for guaranteed delivery of scaling commands
            await this.publishControlMessage(SYSTEM_STREAMS.SCALING, 'system:scaling', {
                type: 'scaling_command',
                data: {
                    service: serviceName,
                    action: 'scale_up'
                },
                timestamp: Date.now(),
                source: 'expert-self-healing-manager'
            });
            return true;
        }
        catch (error) {
            logger.error('Scaling failed', { service: serviceName, error });
            return false;
        }
    }
    // Wait for service to report healthy status
    async waitForServiceHealth(serviceName, timeout) {
        const startTime = Date.now();
        const redis = await this.redis;
        while (Date.now() - startTime < timeout) {
            try {
                const health = await redis.getServiceHealth(serviceName);
                if (health && health.status === 'healthy') {
                    return true;
                }
            }
            catch (error) {
                // Continue waiting
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        return false;
    }
    // Cancel a recovery action
    async cancelRecoveryAction(actionId, reason) {
        const action = this.activeRecoveryActions.get(actionId);
        if (!action)
            return;
        action.status = 'failed';
        action.endTime = Date.now();
        action.error = `Cancelled: ${reason}`;
        logger.info('Recovery action cancelled', { actionId, reason });
    }
    // Start periodic health monitoring
    startHealthMonitoring() {
        this.monitoringInterval = setInterval(async () => {
            if (!this.isRunning)
                return;
            try {
                await this.performHealthCheck();
            }
            catch (error) {
                logger.error('Health monitoring failed', { error });
            }
        }, 60000); // Every minute
    }
    // Start failure detection
    startFailureDetection() {
        // Failure detection is handled by reportFailure method
        // This could be enhanced with proactive failure detection
    }
    // Start recovery orchestration
    startRecoveryOrchestration() {
        // Recovery orchestration is handled reactively
        // Could be enhanced with predictive recovery
    }
    // Subscribe to failure events from services
    async subscribeToFailureEvents() {
        const redis = await this.redis;
        await redis.subscribe('system:failures', (event) => {
            // Handle incoming failure reports
            logger.debug('Received failure event', event);
        });
    }
    // Perform periodic health checks
    async performHealthCheck() {
        const redis = await this.redis;
        for (const [serviceName, state] of this.serviceHealthStates) {
            try {
                const health = await redis.getServiceHealth(serviceName);
                if (health && health.status === 'healthy') {
                    // Service is healthy, gradually improve health score
                    state.healthScore = Math.min(100, state.healthScore + 1);
                    state.consecutiveFailures = 0;
                    state.lastHealthyCheck = Date.now();
                }
                else {
                    // Service is not healthy, decrease health score
                    state.healthScore = Math.max(0, state.healthScore - 5);
                }
            }
            catch (error) {
                logger.debug('Health check failed', { service: serviceName, error });
                state.healthScore = Math.max(0, state.healthScore - 10);
            }
        }
    }
    // Initialize default service states
    initializeDefaultStates() {
        // Default services to monitor
        const defaultServices = [
            'bsc-detector',
            'ethereum-detector',
            'arbitrum-detector',
            'base-detector',
            'polygon-detector',
            'cross-chain-detector',
            'execution-engine',
            'coordinator'
        ];
        for (const serviceName of defaultServices) {
            this.serviceHealthStates.set(serviceName, {
                serviceName,
                healthScore: 100,
                lastHealthyCheck: Date.now(),
                consecutiveFailures: 0,
                recoveryCooldown: 0,
                activeRecoveryActions: []
            });
        }
    }
    // Get system health overview
    async getSystemHealthOverview() {
        const services = Array.from(this.serviceHealthStates.values());
        const totalHealth = services.reduce((sum, s) => sum + s.healthScore, 0) / services.length;
        const criticalServices = services.filter(s => s.healthScore < 50);
        const activeRecoveries = services.reduce((sum, s) => sum + s.activeRecoveryActions.filter(a => a.status === 'executing').length, 0);
        return {
            overallHealth: totalHealth,
            serviceCount: services.length,
            criticalServices: criticalServices.length,
            activeRecoveries,
            lastUpdate: Date.now(),
            services: services.map(s => ({
                name: s.serviceName,
                health: s.healthScore,
                failures: s.consecutiveFailures,
                activeActions: s.activeRecoveryActions.length
            }))
        };
    }
    // Get failure statistics
    getFailureStatistics(timeframe = 3600000) {
        const cutoff = Date.now() - timeframe;
        const recentFailures = this.failureHistory.filter(f => f.timestamp >= cutoff);
        const failureByService = recentFailures.reduce((acc, f) => {
            acc[f.serviceName] = (acc[f.serviceName] || 0) + 1;
            return acc;
        }, {});
        const failureBySeverity = recentFailures.reduce((acc, f) => {
            acc[f.severity] = (acc[f.severity] || 0) + 1;
            return acc;
        }, {});
        return Promise.resolve({
            totalFailures: recentFailures.length,
            failureByService,
            failureBySeverity,
            timeframe
        });
    }
}
exports.ExpertSelfHealingManager = ExpertSelfHealingManager;
// Global instance
let expertSelfHealingManager = null;
async function getExpertSelfHealingManager() {
    if (!expertSelfHealingManager) {
        expertSelfHealingManager = new ExpertSelfHealingManager();
        await expertSelfHealingManager.start();
    }
    return expertSelfHealingManager;
}
//# sourceMappingURL=expert-self-healing-manager.js.map