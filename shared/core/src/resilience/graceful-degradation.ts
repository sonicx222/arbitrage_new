// Graceful Degradation System
// Allows services to continue operating with reduced functionality during failures

import { createLogger } from '../logger';
import { getRedisClient } from '../redis';
import { getRedisStreamsClient, RedisStreamsClient } from '../redis-streams';

const logger = createLogger('graceful-degradation');

export interface DegradationLevel {
  name: string;
  description: string;
  enabledFeatures: string[];
  disabledFeatures: string[];
  performanceImpact: number; // 0-1, where 1 is full degradation
  recoveryPriority: number; // Higher numbers recover first
}

export interface ServiceCapability {
  name: string;
  required: boolean; // If true, service cannot operate without this
  fallback?: any;    // Fallback implementation when capability fails
  degradationLevel: string; // Which degradation level to apply
}

export interface DegradationState {
  serviceName: string;
  currentLevel: DegradationLevel;
  previousLevel?: DegradationLevel;
  triggeredBy: string; // What caused the degradation
  timestamp: number;
  canRecover: boolean;
  recoveryAttempts: number;
  metrics: {
    performanceImpact: number;
    errorRate: number;
    throughputReduction: number;
  };
}

export class GracefulDegradationManager {
  private redis = getRedisClient();
  // P1-15 FIX: Add Redis Streams client for ADR-002 compliance
  private streamsClient: RedisStreamsClient | null = null;
  private degradationLevels = new Map<string, DegradationLevel>();
  private serviceCapabilities = new Map<string, ServiceCapability[]>();
  private serviceStates = new Map<string, DegradationState>();
  private recoveryTimers = new Map<string, NodeJS.Timeout>();

  constructor() {
    this.initializeDefaultDegradationLevels();
    // P1-15 FIX: Initialize streams client asynchronously
    this.initializeStreamsClient();
  }

  /**
   * P1-15 FIX: Initialize Redis Streams client for dual-publish pattern.
   * Streams is the primary transport (ADR-002), Pub/Sub is fallback.
   */
  private async initializeStreamsClient(): Promise<void> {
    try {
      this.streamsClient = await getRedisStreamsClient();
    } catch (error) {
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
  private async dualPublish(
    streamName: string,
    pubsubChannel: string,
    message: Record<string, any>
  ): Promise<void> {
    // Primary: Redis Streams (ADR-002 compliant)
    if (this.streamsClient) {
      try {
        await this.streamsClient.xadd(streamName, message);
      } catch (error) {
        logger.error('Failed to publish to Redis Stream', { error, streamName });
      }
    }

    // Secondary: Pub/Sub (backwards compatibility)
    try {
      const redis = await this.redis;
      await redis.publish(pubsubChannel, message as any);
    } catch (error) {
      logger.error('Failed to publish to Pub/Sub', { error, pubsubChannel });
    }
  }

  // Register degradation levels for a service
  registerDegradationLevels(serviceName: string, levels: DegradationLevel[]): void {
    for (const level of levels) {
      this.degradationLevels.set(`${serviceName}:${level.name}`, level);
    }
    logger.info(`Registered ${levels.length} degradation levels for ${serviceName}`);
  }

  // Register service capabilities
  registerCapabilities(serviceName: string, capabilities: ServiceCapability[]): void {
    this.serviceCapabilities.set(serviceName, capabilities);
    logger.info(`Registered ${capabilities.length} capabilities for ${serviceName}`);
  }

  // Trigger degradation when a capability fails
  async triggerDegradation(
    serviceName: string,
    failedCapability: string,
    error?: Error
  ): Promise<boolean> {
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
    const newState: DegradationState = {
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
  async attemptRecovery(serviceName: string): Promise<boolean> {
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
      } else {
        // Schedule another recovery attempt with exponential backoff
        const delay = Math.min(30000 * Math.pow(2, state.recoveryAttempts), 300000); // Max 5 minutes
        this.scheduleRecovery(serviceName, delay);
        logger.debug(`Recovery failed for ${serviceName}, retrying in ${delay}ms`);
        return false;
      }
    } catch (error) {
      logger.error(`Recovery attempt failed for ${serviceName}`, { error });
      return false;
    }
  }

  // Get current degradation state
  getDegradationState(serviceName: string): DegradationState | null {
    return this.serviceStates.get(serviceName) || null;
  }

  // Get all degradation states
  getAllDegradationStates(): Record<string, DegradationState> {
    const states: Record<string, DegradationState> = {};
    for (const [serviceName, state] of this.serviceStates) {
      states[serviceName] = state;
    }
    return states;
  }

  // Check if a feature is available in current degradation state
  isFeatureEnabled(serviceName: string, featureName: string): boolean {
    const state = this.serviceStates.get(serviceName);
    if (!state) return true; // No degradation = all features enabled

    return state.currentLevel.enabledFeatures.includes(featureName);
  }

  // Get fallback implementation for a capability
  getCapabilityFallback(serviceName: string, capabilityName: string): any {
    const capabilities = this.serviceCapabilities.get(serviceName);
    if (!capabilities) return null;

    const capability = capabilities.find(c => c.name === capabilityName);
    return capability?.fallback || null;
  }

  // Force recovery (admin function)
  async forceRecovery(serviceName: string): Promise<boolean> {
    const state = this.serviceStates.get(serviceName);
    if (!state) return true; // Already recovered

    logger.info(`Forcing recovery for ${serviceName}`);
    return await this.recoverService(serviceName, state);
  }

  private initializeDefaultDegradationLevels(): void {
    // Define common degradation levels that can be used across services
    const defaultLevels: DegradationLevel[] = [
      {
        name: 'normal',
        description: 'Full functionality',
        enabledFeatures: ['arbitrage_detection', 'price_prediction', 'bridge_calls', 'real_time_updates'],
        disabledFeatures: [],
        performanceImpact: 0,
        recoveryPriority: 10
      },
      {
        name: 'partial',
        description: 'Partial chain coverage - some chains unavailable',
        enabledFeatures: ['arbitrage_detection', 'price_prediction', 'real_time_updates'],
        disabledFeatures: [],
        performanceImpact: 0.15,
        recoveryPriority: 9
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
    // FIX: Added unified-detector partition services to support graceful degradation
    const services = [
      'bsc-detector',
      'ethereum-detector',
      'cross-chain-detector',
      'execution-engine',
      'coordinator',
      // Unified detector partitions (ADR-003)
      'unified-detector-asia-fast',
      'unified-detector-l2-turbo',
      'unified-detector-high-value',
      'unified-detector-solana'
    ];

    for (const service of services) {
      for (const level of defaultLevels) {
        this.degradationLevels.set(`${service}:${level.name}`, level);
      }
    }
  }

  private async applyDegradation(serviceName: string, level: DegradationLevel): Promise<void> {
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

    await this.dualPublish(
      'stream:service-degradation',  // Primary: Redis Streams
      `service-degradation:${serviceName}`,  // Secondary: Pub/Sub
      degradationMessage
    );

    // Update service configuration in Redis
    await redis.set(`service-config:${serviceName}:degradation`, {
      level: level.name,
      enabledFeatures: level.enabledFeatures,
      disabledFeatures: level.disabledFeatures,
      appliedAt: Date.now()
    });

    logger.info(`Applied degradation level ${level.name} to ${serviceName}`);
  }

  private async testRecovery(serviceName: string, state: DegradationState): Promise<boolean> {
    // Test if the failed capabilities are now working
    const capabilities = this.serviceCapabilities.get(serviceName);
    if (!capabilities) return true; // No capabilities to test

    for (const capability of capabilities) {
      try {
        // Test the capability (this would be service-specific)
        const isWorking = await this.testCapability(serviceName, capability);
        if (!isWorking) {
          return false; // Still failing
        }
      } catch (error) {
        logger.debug(`Capability ${capability.name} still failing for ${serviceName}`, { error });
        return false;
      }
    }

    return true; // All capabilities working
  }

  private async testCapability(serviceName: string, capability: ServiceCapability): Promise<boolean> {
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

  private async recoverService(serviceName: string, state: DegradationState): Promise<boolean> {
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

      await this.dualPublish(
        'stream:service-recovery',  // Primary: Redis Streams
        `service-recovery:${serviceName}`,  // Secondary: Pub/Sub
        recoveryMessage
      );

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

    } catch (error) {
      logger.error(`Failed to recover service ${serviceName}`, { error });
      return false;
    }
  }

  private scheduleRecovery(serviceName: string, delay: number = 60000): void {
    const existingTimer = this.recoveryTimers.get(serviceName);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(async () => {
      await this.attemptRecovery(serviceName);
    }, delay);

    this.recoveryTimers.set(serviceName, timer);
  }

  private async notifyDegradation(serviceName: string, state: DegradationState): Promise<void> {
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

    await this.dualPublish(
      'stream:service-degradation',  // Primary: Redis Streams
      'service-degradation',  // Secondary: Pub/Sub (broadcast channel)
      notifyMessage
    );
  }
}

// Global degradation manager instance
let globalDegradationManager: GracefulDegradationManager | null = null;

export function getGracefulDegradationManager(): GracefulDegradationManager {
  if (!globalDegradationManager) {
    globalDegradationManager = new GracefulDegradationManager();
  }
  return globalDegradationManager;
}

// Convenience functions
export async function triggerDegradation(
  serviceName: string,
  failedCapability: string,
  error?: Error
): Promise<boolean> {
  return await getGracefulDegradationManager().triggerDegradation(serviceName, failedCapability, error);
}

export function isFeatureEnabled(serviceName: string, featureName: string): boolean {
  return getGracefulDegradationManager().isFeatureEnabled(serviceName, featureName);
}

export function getCapabilityFallback(serviceName: string, capabilityName: string): any {
  return getGracefulDegradationManager().getCapabilityFallback(serviceName, capabilityName);
}