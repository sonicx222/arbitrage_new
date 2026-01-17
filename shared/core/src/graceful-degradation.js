"use strict";
// Graceful Degradation System
// Allows services to continue operating with reduced functionality during failures
Object.defineProperty(exports, "__esModule", { value: true });
exports.GracefulDegradationManager = void 0;
exports.getGracefulDegradationManager = getGracefulDegradationManager;
exports.triggerDegradation = triggerDegradation;
exports.isFeatureEnabled = isFeatureEnabled;
exports.getCapabilityFallback = getCapabilityFallback;
const logger_1 = require("./logger");
const redis_1 = require("./redis");
const redis_streams_1 = require("./redis-streams");
const logger = (0, logger_1.createLogger)('graceful-degradation');
class GracefulDegradationManager {
    constructor() {
        this.redis = (0, redis_1.getRedisClient)();
        // P1-15 FIX: Add Redis Streams client for ADR-002 compliance
        this.streamsClient = null;
        this.degradationLevels = new Map();
        this.serviceCapabilities = new Map();
        this.serviceStates = new Map();
        this.recoveryTimers = new Map();
        this.initializeDefaultDegradationLevels();
        // P1-15 FIX: Initialize streams client asynchronously
        this.initializeStreamsClient();
    }
    /**
     * P1-15 FIX: Initialize Redis Streams client for dual-publish pattern.
     * Streams is the primary transport (ADR-002), Pub/Sub is fallback.
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
     * P1-15 FIX: Dual-publish helper - publishes to both Redis Streams (primary)
     * and Pub/Sub (secondary/fallback) for backwards compatibility.
     *
     * This follows the migration pattern from ADR-002 where we transition
     * from Pub/Sub to Streams while maintaining backwards compatibility.
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
    // Register degradation levels for a service
    registerDegradationLevels(serviceName, levels) {
        for (const level of levels) {
            this.degradationLevels.set(`${serviceName}:${level.name}`, level);
        }
        logger.info(`Registered ${levels.length} degradation levels for ${serviceName}`);
    }
    // Register service capabilities
    registerCapabilities(serviceName, capabilities) {
        this.serviceCapabilities.set(serviceName, capabilities);
        logger.info(`Registered ${capabilities.length} capabilities for ${serviceName}`);
    }
    // Trigger degradation when a capability fails
    async triggerDegradation(serviceName, failedCapability, error) {
        const capabilities = this.serviceCapabilities.get(serviceName);
        if (!capabilities) {
            logger.warn(`No capabilities registered for ${serviceName}`);
            return false;
        }
        const capability = capabilities.find(c => c.name === failedCapability);
        if (!capability) {
            logger.warn(`Capability ${failedCapability} not found for ${serviceName}`);
            return false;
        }
        // Determine appropriate degradation level
        const degradationKey = `${serviceName}:${capability.degradationLevel}`;
        const degradationLevel = this.degradationLevels.get(degradationKey);
        if (!degradationLevel) {
            logger.error(`Degradation level ${capability.degradationLevel} not found for ${serviceName}`);
            return false;
        }
        // Check if already in this degradation state
        const currentState = this.serviceStates.get(serviceName);
        if (currentState?.currentLevel.name === degradationLevel.name) {
            logger.debug(`Already in degradation level ${degradationLevel.name} for ${serviceName}`);
            return true;
        }
        // Apply degradation
        const newState = {
            serviceName,
            currentLevel: degradationLevel,
            previousLevel: currentState?.currentLevel,
            triggeredBy: failedCapability,
            timestamp: Date.now(),
            canRecover: true,
            recoveryAttempts: 0,
            metrics: {
                performanceImpact: degradationLevel.performanceImpact,
                errorRate: 0.1, // Estimate based on degradation
                throughputReduction: degradationLevel.performanceImpact * 0.5
            }
        };
        this.serviceStates.set(serviceName, newState);
        // Notify other services
        await this.notifyDegradation(serviceName, newState);
        // Apply the degradation changes
        await this.applyDegradation(serviceName, degradationLevel);
        // Schedule recovery attempt
        this.scheduleRecovery(serviceName);
        logger.warn(`Applied graceful degradation for ${serviceName}`, {
            level: degradationLevel.name,
            triggeredBy: failedCapability,
            performanceImpact: degradationLevel.performanceImpact
        });
        return true;
    }
    // Attempt to recover from degradation
    async attemptRecovery(serviceName) {
        const state = this.serviceStates.get(serviceName);
        if (!state || !state.canRecover) {
            return false;
        }
        state.recoveryAttempts++;
        try {
            // Test if capabilities are working again
            const canRecover = await this.testRecovery(serviceName, state);
            if (canRecover) {
                await this.recoverService(serviceName, state);
                logger.info(`Successfully recovered ${serviceName} from degradation`);
                return true;
            }
            else {
                // Schedule another recovery attempt with exponential backoff
                const delay = Math.min(30000 * Math.pow(2, state.recoveryAttempts), 300000); // Max 5 minutes
                this.scheduleRecovery(serviceName, delay);
                logger.debug(`Recovery failed for ${serviceName}, retrying in ${delay}ms`);
                return false;
            }
        }
        catch (error) {
            logger.error(`Recovery attempt failed for ${serviceName}`, { error });
            return false;
        }
    }
    // Get current degradation state
    getDegradationState(serviceName) {
        return this.serviceStates.get(serviceName) || null;
    }
    // Get all degradation states
    getAllDegradationStates() {
        const states = {};
        for (const [serviceName, state] of this.serviceStates) {
            states[serviceName] = state;
        }
        return states;
    }
    // Check if a feature is available in current degradation state
    isFeatureEnabled(serviceName, featureName) {
        const state = this.serviceStates.get(serviceName);
        if (!state)
            return true; // No degradation = all features enabled
        return state.currentLevel.enabledFeatures.includes(featureName);
    }
    // Get fallback implementation for a capability
    getCapabilityFallback(serviceName, capabilityName) {
        const capabilities = this.serviceCapabilities.get(serviceName);
        if (!capabilities)
            return null;
        const capability = capabilities.find(c => c.name === capabilityName);
        return capability?.fallback || null;
    }
    // Force recovery (admin function)
    async forceRecovery(serviceName) {
        const state = this.serviceStates.get(serviceName);
        if (!state)
            return true; // Already recovered
        logger.info(`Forcing recovery for ${serviceName}`);
        return await this.recoverService(serviceName, state);
    }
    initializeDefaultDegradationLevels() {
        // Define common degradation levels that can be used across services
        const defaultLevels = [
            {
                name: 'normal',
                description: 'Full functionality',
                enabledFeatures: ['arbitrage_detection', 'price_prediction', 'bridge_calls', 'real_time_updates'],
                disabledFeatures: [],
                performanceImpact: 0,
                recoveryPriority: 10
            },
            {
                name: 'reduced_accuracy',
                description: 'Reduced prediction accuracy, cached data',
                enabledFeatures: ['arbitrage_detection', 'real_time_updates'],
                disabledFeatures: ['price_prediction', 'bridge_calls'],
                performanceImpact: 0.2,
                recoveryPriority: 8
            },
            {
                name: 'batch_only',
                description: 'Batch processing only, no real-time updates',
                enabledFeatures: ['arbitrage_detection'],
                disabledFeatures: ['price_prediction', 'bridge_calls', 'real_time_updates'],
                performanceImpact: 0.5,
                recoveryPriority: 6
            },
            {
                name: 'minimal',
                description: 'Minimal functionality, basic arbitrage only',
                enabledFeatures: ['basic_arbitrage'],
                disabledFeatures: ['price_prediction', 'bridge_calls', 'real_time_updates', 'cross_chain'],
                performanceImpact: 0.8,
                recoveryPriority: 4
            },
            {
                name: 'emergency',
                description: 'Emergency mode, very basic functionality',
                enabledFeatures: [],
                disabledFeatures: ['arbitrage_detection', 'price_prediction', 'bridge_calls', 'real_time_updates', 'cross_chain'],
                performanceImpact: 1.0,
                recoveryPriority: 2
            }
        ];
        // Register default levels for common services
        const services = ['bsc-detector', 'ethereum-detector', 'cross-chain-detector', 'execution-engine', 'coordinator'];
        for (const service of services) {
            for (const level of defaultLevels) {
                this.degradationLevels.set(`${service}:${level.name}`, level);
            }
        }
    }
    async applyDegradation(serviceName, level) {
        const redis = await this.redis;
        // P1-15 FIX: Use dual-publish pattern (Streams + Pub/Sub)
        // Notify the service to adjust its behavior
        const degradationMessage = {
            type: 'degradation_applied',
            data: {
                serviceName,
                degradationLevel: level.name,
                enabledFeatures: level.enabledFeatures,
                disabledFeatures: level.disabledFeatures,
                performanceImpact: level.performanceImpact
            },
            timestamp: Date.now(),
            source: 'graceful-degradation-manager'
        };
        await this.dualPublish('stream:service-degradation', // Primary: Redis Streams
        `service-degradation:${serviceName}`, // Secondary: Pub/Sub
        degradationMessage);
        // Update service configuration in Redis
        await redis.set(`service-config:${serviceName}:degradation`, {
            level: level.name,
            enabledFeatures: level.enabledFeatures,
            disabledFeatures: level.disabledFeatures,
            appliedAt: Date.now()
        });
        logger.info(`Applied degradation level ${level.name} to ${serviceName}`);
    }
    async testRecovery(serviceName, state) {
        // Test if the failed capabilities are now working
        const capabilities = this.serviceCapabilities.get(serviceName);
        if (!capabilities)
            return true; // No capabilities to test
        for (const capability of capabilities) {
            try {
                // Test the capability (this would be service-specific)
                const isWorking = await this.testCapability(serviceName, capability);
                if (!isWorking) {
                    return false; // Still failing
                }
            }
            catch (error) {
                logger.debug(`Capability ${capability.name} still failing for ${serviceName}`, { error });
                return false;
            }
        }
        return true; // All capabilities working
    }
    async testCapability(serviceName, capability) {
        // This would implement service-specific capability testing
        // For now, we'll use a simple health check simulation
        const redis = await this.redis;
        switch (capability.name) {
            case 'redis_connection':
                return await redis.ping();
            case 'web3_connection':
                // Would test blockchain connectivity
                return Math.random() > 0.1; // Simulate 90% success
            case 'ml_prediction':
                // Would test ML model availability
                return Math.random() > 0.05; // Simulate 95% success
            default:
                return Math.random() > 0.2; // Simulate 80% success for unknown capabilities
        }
    }
    async recoverService(serviceName, state) {
        try {
            // Clear degradation state
            this.serviceStates.delete(serviceName);
            const redis = await this.redis;
            // P1-15 FIX: Use dual-publish pattern (Streams + Pub/Sub)
            // Notify service of recovery
            const recoveryMessage = {
                type: 'service_recovered',
                data: {
                    serviceName,
                    recoveredFrom: state.currentLevel.name
                },
                timestamp: Date.now(),
                source: 'graceful-degradation-manager'
            };
            await this.dualPublish('stream:service-recovery', // Primary: Redis Streams
            `service-recovery:${serviceName}`, // Secondary: Pub/Sub
            recoveryMessage);
            // Clear recovery timer
            const timer = this.recoveryTimers.get(serviceName);
            if (timer) {
                clearTimeout(timer);
                this.recoveryTimers.delete(serviceName);
            }
            // Remove degradation configuration
            await redis.del(`service-config:${serviceName}:degradation`);
            logger.info(`Service ${serviceName} recovered from degradation level ${state.currentLevel.name}`);
            return true;
        }
        catch (error) {
            logger.error(`Failed to recover service ${serviceName}`, { error });
            return false;
        }
    }
    scheduleRecovery(serviceName, delay = 60000) {
        const existingTimer = this.recoveryTimers.get(serviceName);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }
        const timer = setTimeout(async () => {
            await this.attemptRecovery(serviceName);
        }, delay);
        this.recoveryTimers.set(serviceName, timer);
    }
    async notifyDegradation(serviceName, state) {
        // P1-15 FIX: Use dual-publish pattern (Streams + Pub/Sub)
        const notifyMessage = {
            type: 'service_degradation',
            data: {
                serviceName,
                degradationLevel: state.currentLevel.name,
                triggeredBy: state.triggeredBy,
                performanceImpact: state.metrics.performanceImpact
            },
            timestamp: state.timestamp,
            source: 'graceful-degradation-manager'
        };
        await this.dualPublish('stream:service-degradation', // Primary: Redis Streams
        'service-degradation', // Secondary: Pub/Sub (broadcast channel)
        notifyMessage);
    }
}
exports.GracefulDegradationManager = GracefulDegradationManager;
// Global degradation manager instance
let globalDegradationManager = null;
function getGracefulDegradationManager() {
    if (!globalDegradationManager) {
        globalDegradationManager = new GracefulDegradationManager();
    }
    return globalDegradationManager;
}
// Convenience functions
async function triggerDegradation(serviceName, failedCapability, error) {
    return await getGracefulDegradationManager().triggerDegradation(serviceName, failedCapability, error);
}
function isFeatureEnabled(serviceName, featureName) {
    return getGracefulDegradationManager().isFeatureEnabled(serviceName, featureName);
}
function getCapabilityFallback(serviceName, capabilityName) {
    return getGracefulDegradationManager().getCapabilityFallback(serviceName, capabilityName);
}
//# sourceMappingURL=graceful-degradation.js.map