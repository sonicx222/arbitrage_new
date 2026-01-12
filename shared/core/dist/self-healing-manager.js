"use strict";
// Self-Healing Service Manager
// Automatically detects failures and orchestrates recovery
Object.defineProperty(exports, "__esModule", { value: true });
exports.SelfHealingManager = void 0;
exports.getSelfHealingManager = getSelfHealingManager;
exports.registerServiceForSelfHealing = registerServiceForSelfHealing;
const logger_1 = require("./logger");
const redis_1 = require("./redis");
const redis_streams_1 = require("./redis-streams");
const circuit_breaker_1 = require("./circuit-breaker");
// P2-2-FIX: Import config with fallback for test environment
let SYSTEM_CONSTANTS;
try {
    SYSTEM_CONSTANTS = require('../../config/src').SYSTEM_CONSTANTS;
}
catch {
    // Config not available, will use defaults
}
// P2-2-FIX: Default values for when config is not available
const SELF_HEALING_DEFAULTS = {
    circuitBreakerCooldownMs: SYSTEM_CONSTANTS?.selfHealing?.circuitBreakerCooldownMs ?? 60000,
    healthCheckFailureThreshold: SYSTEM_CONSTANTS?.selfHealing?.healthCheckFailureThreshold ?? 3,
    gracefulDegradationThreshold: SYSTEM_CONSTANTS?.selfHealing?.gracefulDegradationThreshold ?? 10,
    maxRestartDelayMs: SYSTEM_CONSTANTS?.selfHealing?.maxRestartDelayMs ?? 300000,
    simulatedRestartDelayMs: SYSTEM_CONSTANTS?.selfHealing?.simulatedRestartDelayMs ?? 2000,
    simulatedRestartFailureRate: SYSTEM_CONSTANTS?.selfHealing?.simulatedRestartFailureRate ?? 0.2,
};
const CIRCUIT_BREAKER_DEFAULTS = {
    failureThreshold: SYSTEM_CONSTANTS?.circuitBreaker?.defaultFailureThreshold ?? 3,
    recoveryTimeoutMs: SYSTEM_CONSTANTS?.circuitBreaker?.defaultRecoveryTimeoutMs ?? 30000,
    monitoringPeriodMs: SYSTEM_CONSTANTS?.circuitBreaker?.defaultMonitoringPeriodMs ?? 60000,
    successThreshold: SYSTEM_CONSTANTS?.circuitBreaker?.defaultSuccessThreshold ?? 2,
};
const logger = (0, logger_1.createLogger)('self-healing-manager');
class SelfHealingManager {
    constructor() {
        this.redis = (0, redis_1.getRedisClient)();
        // P1-16 FIX: Add Redis Streams client for ADR-002 compliance
        this.streamsClient = null;
        this.services = new Map();
        this.serviceHealth = new Map();
        this.recoveryStrategies = [];
        this.healthCheckTimers = new Map();
        this.restartTimers = new Map();
        this.circuitBreakers = new Map();
        this.isRunning = false;
        // P2-FIX: Lock to prevent concurrent health check updates for the same service
        this.healthUpdateLocks = new Map();
        this.initializeRecoveryStrategies();
        // P1-2-FIX: Store promise so we can await it before using streams client
        this.initializationPromise = this.initializeStreamsClient();
    }
    /**
     * P1-2-FIX: Ensure the manager is fully initialized before operations.
     * Call this before performing any operations that require the streams client.
     */
    async ensureInitialized() {
        await this.initializationPromise;
    }
    /**
     * P1-16 FIX: Initialize Redis Streams client for dual-publish pattern.
     */
    async initializeStreamsClient() {
        try {
            this.streamsClient = await (0, redis_streams_1.getRedisStreamsClient)();
        }
        catch (error) {
            logger.warn('Failed to initialize Redis Streams client, will use Pub/Sub only', { error });
        }
    }
    /**
     * P1-16 FIX: Dual-publish helper - publishes to both Redis Streams (primary)
     * and Pub/Sub (secondary/fallback) for backwards compatibility.
     */
    async dualPublish(streamName, pubsubChannel, message) {
        // Primary: Redis Streams (ADR-002 compliant)
        if (this.streamsClient) {
            try {
                await this.streamsClient.xadd(streamName, message);
            }
            catch (error) {
                logger.error('Failed to publish to Redis Stream', { error, streamName });
            }
        }
        // Secondary: Pub/Sub (backwards compatibility)
        try {
            const redis = await this.redis;
            await redis.publish(pubsubChannel, message);
        }
        catch (error) {
            logger.error('Failed to publish to Pub/Sub', { error, pubsubChannel });
        }
    }
    // Register a service for self-healing management
    registerService(serviceDef) {
        this.services.set(serviceDef.name, serviceDef);
        // Initialize health tracking
        this.serviceHealth.set(serviceDef.name, {
            name: serviceDef.name,
            status: 'stopping',
            lastHealthCheck: 0,
            consecutiveFailures: 0,
            restartCount: 0,
            uptime: 0
        });
        // Create circuit breaker for health checks
        // P2-2-FIX: Use configured constants instead of magic numbers
        const circuitBreaker = (0, circuit_breaker_1.createCircuitBreaker)(`${serviceDef.name}-health-check`, {
            failureThreshold: CIRCUIT_BREAKER_DEFAULTS.failureThreshold,
            recoveryTimeout: CIRCUIT_BREAKER_DEFAULTS.recoveryTimeoutMs,
            monitoringPeriod: CIRCUIT_BREAKER_DEFAULTS.monitoringPeriodMs,
            successThreshold: CIRCUIT_BREAKER_DEFAULTS.successThreshold
        });
        this.circuitBreakers.set(serviceDef.name, circuitBreaker);
        logger.info(`Registered service for self-healing: ${serviceDef.name}`);
    }
    // Start the self-healing manager
    async start() {
        if (this.isRunning)
            return;
        // P1-2-FIX: Ensure async initialization is complete before starting
        await this.ensureInitialized();
        this.isRunning = true;
        logger.info('Self-healing manager started');
        // Start health monitoring for all registered services
        for (const [serviceName, serviceDef] of this.services) {
            this.startHealthMonitoring(serviceName, serviceDef);
        }
        // Subscribe to service health updates
        await this.subscribeToHealthUpdates();
    }
    // Stop the self-healing manager
    async stop() {
        if (!this.isRunning)
            return;
        this.isRunning = false;
        logger.info('Self-healing manager stopping');
        // Clear all timers
        for (const timer of this.healthCheckTimers.values()) {
            clearInterval(timer);
        }
        for (const timer of this.restartTimers.values()) {
            clearTimeout(timer);
        }
        this.healthCheckTimers.clear();
        this.restartTimers.clear();
        // P2-FIX: Wait for any pending health checks to complete before stopping
        const pendingLocks = Array.from(this.healthUpdateLocks.values());
        if (pendingLocks.length > 0) {
            logger.debug(`Waiting for ${pendingLocks.length} pending health checks to complete`);
            await Promise.all(pendingLocks);
        }
        this.healthUpdateLocks.clear();
        // Circuit breakers don't need explicit destruction in this version
        const redis = await this.redis;
        await redis.disconnect();
        logger.info('Self-healing manager stopped');
    }
    // Get health status of all services
    getAllServiceHealth() {
        const health = {};
        for (const [name, healthData] of this.serviceHealth) {
            health[name] = { ...healthData };
        }
        return health;
    }
    // Manually trigger recovery for a service
    async triggerRecovery(serviceName, error) {
        const service = this.services.get(serviceName);
        const health = this.serviceHealth.get(serviceName);
        if (!service || !health) {
            logger.error(`Service not found: ${serviceName}`);
            return false;
        }
        logger.info(`Manually triggering recovery for ${serviceName}`, { error: error?.message });
        return this.executeRecoveryStrategies(service, health, error);
    }
    // Add custom recovery strategy
    addRecoveryStrategy(strategy) {
        this.recoveryStrategies.push(strategy);
        this.recoveryStrategies.sort((a, b) => b.priority - a.priority); // Higher priority first
    }
    initializeRecoveryStrategies() {
        // Strategy 1: Simple restart (highest priority)
        this.addRecoveryStrategy({
            name: 'simple_restart',
            priority: 100,
            canHandle: (service, error) => {
                return service.consecutiveFailures > 0 && service.restartCount < (this.services.get(service.name)?.maxRestarts || 3);
            },
            execute: async (service) => {
                const serviceDef = this.services.get(service.name);
                if (!serviceDef)
                    return false;
                logger.info(`Executing simple restart for ${service.name}`);
                try {
                    await this.restartService(serviceDef);
                    return true;
                }
                catch (error) {
                    logger.error(`Simple restart failed for ${service.name}`, { error });
                    return false;
                }
            }
        });
        // Strategy 2: Circuit breaker protection
        this.addRecoveryStrategy({
            name: 'circuit_breaker',
            priority: 90,
            canHandle: (service, error) => {
                return error instanceof circuit_breaker_1.CircuitBreakerError ||
                    service.consecutiveFailures >= 5;
            },
            execute: async (service) => {
                logger.info(`Activating circuit breaker for ${service.name}`);
                const breaker = this.circuitBreakers.get(service.name);
                if (breaker) {
                    breaker.forceOpen();
                    // Schedule automatic recovery after cooldown
                    // P2-2-FIX: Use configured constant instead of magic number
                    setTimeout(() => {
                        logger.info(`Testing recovery for ${service.name}`);
                        this.performHealthCheck(service.name);
                    }, SELF_HEALING_DEFAULTS.circuitBreakerCooldownMs);
                }
                return true;
            }
        });
        // Strategy 3: Dependency restart
        this.addRecoveryStrategy({
            name: 'dependency_restart',
            priority: 80,
            canHandle: (service, error) => {
                const serviceDef = this.services.get(service.name);
                return !!(serviceDef?.dependencies?.length);
            },
            execute: async (service) => {
                const serviceDef = this.services.get(service.name);
                if (!serviceDef?.dependencies)
                    return false;
                logger.info(`Restarting dependencies for ${service.name}`, { dependencies: serviceDef.dependencies });
                let success = true;
                for (const dependency of serviceDef.dependencies) {
                    try {
                        await this.triggerRecovery(dependency);
                    }
                    catch (error) {
                        logger.error(`Failed to restart dependency ${dependency}`, { error });
                        success = false;
                    }
                }
                return success;
            }
        });
        // Strategy 4: Escalated restart with increased delay
        this.addRecoveryStrategy({
            name: 'escalated_restart',
            priority: 70,
            canHandle: (service, error) => {
                return service.restartCount >= 3;
            },
            execute: async (service) => {
                const serviceDef = this.services.get(service.name);
                if (!serviceDef)
                    return false;
                // P2-2-FIX: Use configured constant instead of magic number
                const delay = Math.min(serviceDef.restartDelay * Math.pow(2, service.restartCount), SELF_HEALING_DEFAULTS.maxRestartDelayMs);
                logger.info(`Executing escalated restart for ${service.name} with ${delay}ms delay`);
                return new Promise((resolve) => {
                    setTimeout(async () => {
                        try {
                            await this.restartService(serviceDef);
                            resolve(true);
                        }
                        catch (error) {
                            logger.error(`Escalated restart failed for ${service.name}`, { error });
                            resolve(false);
                        }
                    }, delay);
                });
            }
        });
        // Strategy 5: Graceful degradation (lowest priority)
        this.addRecoveryStrategy({
            name: 'graceful_degradation',
            priority: 50,
            canHandle: (service, error) => {
                // P2-2-FIX: Use configured constant instead of magic number
                return service.consecutiveFailures >= SELF_HEALING_DEFAULTS.gracefulDegradationThreshold;
            },
            execute: async (service) => {
                logger.warn(`Activating graceful degradation for ${service.name}`);
                // Put service in degraded mode
                const health = this.serviceHealth.get(service.name);
                if (health) {
                    health.status = 'unhealthy';
                    health.errorMessage = 'Service in graceful degradation mode';
                    // Notify other services of degradation
                    await this.notifyServiceDegradation(service.name);
                }
                return true;
            }
        });
    }
    async startHealthMonitoring(serviceName, serviceDef) {
        const timer = setInterval(async () => {
            if (!this.isRunning)
                return;
            await this.performHealthCheck(serviceName);
        }, serviceDef.healthCheckInterval);
        this.healthCheckTimers.set(serviceName, timer);
        logger.debug(`Started health monitoring for ${serviceName}`);
    }
    async performHealthCheck(serviceName) {
        const serviceDef = this.services.get(serviceName);
        const health = this.serviceHealth.get(serviceName);
        const breaker = this.circuitBreakers.get(serviceName);
        if (!serviceDef || !health || !breaker)
            return;
        // P2-FIX: Wait for any existing health check to complete for this service
        // This prevents TOCTOU race conditions when multiple health checks run concurrently
        const existingLock = this.healthUpdateLocks.get(serviceName);
        if (existingLock) {
            await existingLock;
        }
        // P2-FIX: Create a lock for this health check
        let resolveLock;
        const lockPromise = new Promise(resolve => {
            resolveLock = resolve;
        });
        this.healthUpdateLocks.set(serviceName, lockPromise);
        try {
            const isHealthy = await breaker.execute(async () => {
                if (serviceDef.healthCheckUrl) {
                    // HTTP health check
                    return await this.checkHttpHealth(serviceDef.healthCheckUrl);
                }
                else {
                    // Process-based health check (simplified)
                    return await this.checkProcessHealth(serviceName);
                }
            });
            // P2-FIX: Atomic health update using Object.assign to prevent partial updates
            const now = Date.now();
            if (isHealthy) {
                if (health.status !== 'healthy') {
                    logger.info(`Service ${serviceName} recovered`);
                    // Atomic update of all fields at once
                    Object.assign(health, {
                        status: 'healthy',
                        lastHealthCheck: now,
                        consecutiveFailures: 0,
                        uptime: now,
                        errorMessage: undefined
                    });
                }
                else {
                    health.lastHealthCheck = now;
                }
            }
            else {
                // P2-FIX: Capture failure count before increment for recovery decision
                const newFailureCount = health.consecutiveFailures + 1;
                Object.assign(health, {
                    status: 'unhealthy',
                    lastHealthCheck: now,
                    consecutiveFailures: newFailureCount
                });
                // Trigger recovery if needed (using the captured count to avoid race)
                // P2-2-FIX: Use configured constant instead of magic number
                if (newFailureCount >= SELF_HEALING_DEFAULTS.healthCheckFailureThreshold) {
                    await this.executeRecoveryStrategies(serviceDef, health);
                }
            }
            // Update Redis with health status
            await this.updateHealthInRedis(serviceName, health);
        }
        catch (error) {
            // P2-FIX: Atomic error state update
            const newFailureCount = health.consecutiveFailures + 1;
            if (error instanceof circuit_breaker_1.CircuitBreakerError) {
                logger.warn(`Health check circuit breaker open for ${serviceName}`);
                Object.assign(health, {
                    status: 'unhealthy',
                    errorMessage: 'Health check circuit breaker open'
                });
            }
            else {
                logger.error(`Health check failed for ${serviceName}`, { error });
                Object.assign(health, {
                    status: 'unhealthy',
                    consecutiveFailures: newFailureCount,
                    errorMessage: error.message
                });
            }
        }
        finally {
            // P2-FIX: Release the lock
            this.healthUpdateLocks.delete(serviceName);
            resolveLock();
        }
    }
    async executeRecoveryStrategies(serviceDef, health, error) {
        for (const strategy of this.recoveryStrategies) {
            if (strategy.canHandle(health, error)) {
                logger.info(`Attempting recovery strategy: ${strategy.name} for ${health.name}`);
                try {
                    const success = await strategy.execute(health);
                    if (success) {
                        logger.info(`Recovery strategy ${strategy.name} succeeded for ${health.name}`);
                        return true;
                    }
                    else {
                        logger.warn(`Recovery strategy ${strategy.name} failed for ${health.name}`);
                    }
                }
                catch (strategyError) {
                    logger.error(`Recovery strategy ${strategy.name} threw error for ${health.name}`, { error: strategyError });
                }
            }
        }
        logger.error(`All recovery strategies failed for ${health.name}`);
        return false;
    }
    async restartService(serviceDef) {
        const health = this.serviceHealth.get(serviceDef.name);
        if (!health)
            return;
        health.status = 'starting';
        health.restartCount++;
        logger.info(`Restarting service ${serviceDef.name} (attempt ${health.restartCount})`);
        try {
            // In a real implementation, this would execute the start command
            // For now, we'll simulate the restart process
            await this.simulateServiceRestart(serviceDef);
            health.status = 'healthy';
            health.consecutiveFailures = 0;
            health.uptime = Date.now();
            health.errorMessage = undefined;
            logger.info(`Service ${serviceDef.name} restarted successfully`);
        }
        catch (error) {
            logger.error(`Service restart failed for ${serviceDef.name}`, { error });
            health.status = 'unhealthy';
            throw error;
        }
    }
    async checkHttpHealth(url) {
        // Simplified HTTP health check
        // In production, this would make actual HTTP requests
        return Math.random() > 0.1; // 90% success rate for simulation
    }
    async checkProcessHealth(serviceName) {
        // Check if process is running (simplified)
        const health = this.serviceHealth.get(serviceName);
        return health ? health.status === 'healthy' : false;
    }
    async simulateServiceRestart(serviceDef) {
        // P2-2-FIX: Use configured constants instead of magic numbers
        // Simulate restart delay
        await new Promise(resolve => setTimeout(resolve, SELF_HEALING_DEFAULTS.simulatedRestartDelayMs));
        // Simulate occasional restart failures
        if (Math.random() < SELF_HEALING_DEFAULTS.simulatedRestartFailureRate) {
            throw new Error('Simulated restart failure');
        }
    }
    async subscribeToHealthUpdates() {
        const redis = await this.redis;
        await redis.subscribe('service-health-updates', (messageEvent) => {
            try {
                const healthUpdate = messageEvent.data;
                this.handleHealthUpdate(healthUpdate);
            }
            catch (error) {
                logger.error('Failed to handle health update', { error });
            }
        });
    }
    handleHealthUpdate(update) {
        const existingHealth = this.serviceHealth.get(update.service);
        if (existingHealth) {
            Object.assign(existingHealth, update);
        }
    }
    async updateHealthInRedis(serviceName, health) {
        const redis = await this.redis;
        await redis.set(`health:${serviceName}`, health, 300); // 5 minute TTL
    }
    async notifyServiceDegradation(serviceName) {
        // P1-16 FIX: Use dual-publish pattern (Streams + Pub/Sub)
        const degradationMessage = {
            type: 'service_degraded',
            data: {
                service: serviceName,
                message: 'Service entered graceful degradation mode'
            },
            timestamp: Date.now(),
            source: 'self-healing-manager'
        };
        await this.dualPublish('stream:service-degradation', // Primary: Redis Streams
        'service-degradation', // Secondary: Pub/Sub
        degradationMessage);
    }
}
exports.SelfHealingManager = SelfHealingManager;
// Global self-healing manager instance
let globalSelfHealingManager = null;
function getSelfHealingManager() {
    if (!globalSelfHealingManager) {
        globalSelfHealingManager = new SelfHealingManager();
    }
    return globalSelfHealingManager;
}
// Convenience function to register a service
function registerServiceForSelfHealing(serviceDef) {
    getSelfHealingManager().registerService(serviceDef);
}
//# sourceMappingURL=self-healing-manager.js.map