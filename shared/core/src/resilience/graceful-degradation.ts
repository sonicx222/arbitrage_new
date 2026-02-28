// Graceful Degradation System
// Allows services to continue operating with reduced functionality during failures
//
// S4.1.3-FIX (Option A): Unified DegradationLevel enum with cross-region-health.ts
// This aligns with ADR-007 which defines the canonical degradation levels.

import { createLogger } from '../logger';
import { getRedisClient } from '../redis/client';
import { getRedisStreamsClient, RedisStreamsClient } from '../redis/streams';
import { dualPublish as dualPublishUtil } from './dual-publish';
// S4.1.3-FIX: Import canonical DegradationLevel enum from cross-region-health (ADR-007)
import { DegradationLevel } from '../monitoring/cross-region-health';

const logger = createLogger('graceful-degradation');

// Re-export for convenience so consumers can import from resilience module
export { DegradationLevel };

/**
 * S4.1.3-FIX: Renamed from DegradationLevel to DegradationLevelConfig to avoid
 * conflict with the canonical DegradationLevel enum from ADR-007.
 *
 * This interface provides detailed configuration for each degradation level,
 * including which features are enabled/disabled and recovery priority.
 */
export interface DegradationLevelConfig {
  /** Canonical degradation level from ADR-007 enum */
  level: DegradationLevel;
  /** Human-readable name for this configuration */
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
  fallback?: unknown;    // Fallback implementation when capability fails
  /** S4.1.3-FIX: Use canonical DegradationLevel enum instead of string */
  degradationLevel: DegradationLevel;
}

export interface DegradationState {
  serviceName: string;
  /** S4.1.3-FIX: Use DegradationLevelConfig for full config object */
  currentLevel: DegradationLevelConfig;
  previousLevel?: DegradationLevelConfig;
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
  /** S4.1.3-FIX: Map stores DegradationLevelConfig (config objects), keyed by "serviceName:level" */
  private degradationLevels = new Map<string, DegradationLevelConfig>();
  private serviceCapabilities = new Map<string, ServiceCapability[]>();
  private serviceStates = new Map<string, DegradationState>();
  private recoveryTimers = new Map<string, NodeJS.Timeout>();
  // S4.1.3-FIX: Track in-progress recoveries to prevent race conditions
  private recoveryInProgress = new Set<string>();
  // S4.1.3-FIX: Injectable capability tester for deterministic testing
  private capabilityTester?: (serviceName: string, capability: ServiceCapability) => Promise<boolean>;

  // P1-10 FIX: Store initialization promise so dualPublish can await readiness
  private initPromise: Promise<void>;

  constructor() {
    this.initializeDefaultDegradationLevels();
    // P1-10 FIX: Store init promise so dualPublish can await readiness
    this.initPromise = this.initializeStreamsClient();
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
   * P2-17 FIX: Delegates to shared dualPublishUtil to avoid code duplication.
   * P1-10 FIX: Awaits initPromise to ensure streams client is ready.
   */
  private async dualPublish(
    streamName: string,
    pubsubChannel: string,
    message: Record<string, unknown>
  ): Promise<void> {
    await this.initPromise;
    const redis = await this.redis;
    await dualPublishUtil(this.streamsClient, redis, streamName, pubsubChannel, message);
  }

  /**
   * Register degradation level configurations for a service.
   * S4.1.3-FIX: Now accepts DegradationLevelConfig with canonical enum level.
   * Key format: "serviceName:enumValue" (e.g., "bsc-detector:1" for REDUCED_CHAINS)
   */
  registerDegradationLevels(serviceName: string, levels: DegradationLevelConfig[]): void {
    for (const levelConfig of levels) {
      // S4.1.3-FIX: Key by enum value for type-safe lookup
      this.degradationLevels.set(`${serviceName}:${levelConfig.level}`, levelConfig);
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

    // S4.1.3-FIX: Determine appropriate degradation level using enum value
    const degradationKey = `${serviceName}:${capability.degradationLevel}`;
    const degradationLevelConfig = this.degradationLevels.get(degradationKey);

    if (!degradationLevelConfig) {
      logger.error(`Degradation level ${DegradationLevel[capability.degradationLevel]} not found for ${serviceName}`);
      return false;
    }

    // Check if already in this degradation state (compare by canonical enum level)
    const currentState = this.serviceStates.get(serviceName);
    if (currentState?.currentLevel.level === degradationLevelConfig.level) {
      logger.debug(`Already in degradation level ${degradationLevelConfig.name} for ${serviceName}`);
      return true;
    }

    // Apply degradation
    const newState: DegradationState = {
      serviceName,
      currentLevel: degradationLevelConfig,
      previousLevel: currentState?.currentLevel,
      triggeredBy: failedCapability,
      timestamp: Date.now(),
      canRecover: true,
      recoveryAttempts: 0,
      metrics: {
        performanceImpact: degradationLevelConfig.performanceImpact,
        errorRate: 0.1, // Estimate based on degradation
        throughputReduction: degradationLevelConfig.performanceImpact * 0.5
      }
    };

    this.serviceStates.set(serviceName, newState);

    // Notify other services
    await this.notifyDegradation(serviceName, newState);

    // Apply the degradation changes
    await this.applyDegradation(serviceName, degradationLevelConfig);

    // Schedule recovery attempt
    this.scheduleRecovery(serviceName);

    logger.warn(`Applied graceful degradation for ${serviceName}`, {
      level: degradationLevelConfig.name,
      triggeredBy: failedCapability,
      performanceImpact: degradationLevelConfig.performanceImpact
    });

    return true;
  }

  // Attempt to recover from degradation
  // S4.1.3-FIX: Added mutex to prevent concurrent recovery attempts (race condition)
  async attemptRecovery(serviceName: string): Promise<boolean> {
    const state = this.serviceStates.get(serviceName);
    if (!state || !state.canRecover) {
      return false;
    }

    // S4.1.3-FIX: Prevent concurrent recovery attempts for the same service
    if (this.recoveryInProgress.has(serviceName)) {
      logger.debug(`Recovery already in progress for ${serviceName}, skipping`);
      return false;
    }

    this.recoveryInProgress.add(serviceName);
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
    } finally {
      // S4.1.3-FIX: Always release the lock
      this.recoveryInProgress.delete(serviceName);
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
  getCapabilityFallback(serviceName: string, capabilityName: string): unknown {
    const capabilities = this.serviceCapabilities.get(serviceName);
    if (!capabilities) return null;

    const capability = capabilities.find(c => c.name === capabilityName);
    return capability?.fallback ?? null;
  }

  // Force recovery (admin function)
  async forceRecovery(serviceName: string): Promise<boolean> {
    const state = this.serviceStates.get(serviceName);
    if (!state) return true; // Already recovered

    logger.info(`Forcing recovery for ${serviceName}`);
    return await this.recoverService(serviceName, state);
  }

  /**
   * S4.1.3-FIX: Set a custom capability tester for deterministic testing.
   * This allows tests to control capability test outcomes instead of using Math.random().
   */
  setCapabilityTester(tester: (serviceName: string, capability: ServiceCapability) => Promise<boolean>): void {
    this.capabilityTester = tester;
  }

  /**
   * S4.1.3-FIX (Option A): Initialize default degradation levels with canonical enum values.
   *
   * Mapping from ADR-007 DegradationLevel enum to DegradationLevelConfig:
   * - FULL_OPERATION (0) → 'normal' - All services healthy
   * - REDUCED_CHAINS (1) → 'partial', 'reduced_accuracy' - Some chains/features down
   * - DETECTION_ONLY (2) → 'batch_only' - Execution disabled, detection continues
   * - READ_ONLY (3) → 'minimal' - Only dashboard/monitoring
   * - COMPLETE_OUTAGE (4) → 'emergency' - All services down
   */
  private initializeDefaultDegradationLevels(): void {
    // Define common degradation levels with canonical enum values (ADR-007)
    const defaultLevels: DegradationLevelConfig[] = [
      {
        level: DegradationLevel.FULL_OPERATION,
        name: 'normal',
        description: 'Full functionality',
        enabledFeatures: ['arbitrage_detection', 'price_prediction', 'bridge_calls', 'real_time_updates'],
        disabledFeatures: [],
        performanceImpact: 0,
        recoveryPriority: 10
      },
      {
        level: DegradationLevel.REDUCED_CHAINS,
        name: 'partial',
        description: 'Partial chain coverage - some chains unavailable',
        enabledFeatures: ['arbitrage_detection', 'price_prediction', 'real_time_updates'],
        disabledFeatures: [],
        performanceImpact: 0.15,
        recoveryPriority: 9
      },
      {
        level: DegradationLevel.DETECTION_ONLY,
        name: 'batch_only',
        description: 'Batch processing only, no real-time updates',
        enabledFeatures: ['arbitrage_detection'],
        disabledFeatures: ['price_prediction', 'bridge_calls', 'real_time_updates'],
        performanceImpact: 0.5,
        recoveryPriority: 6
      },
      {
        level: DegradationLevel.READ_ONLY,
        name: 'minimal',
        description: 'Minimal functionality, basic arbitrage only',
        enabledFeatures: ['basic_arbitrage'],
        disabledFeatures: ['price_prediction', 'bridge_calls', 'real_time_updates', 'cross_chain'],
        performanceImpact: 0.8,
        recoveryPriority: 4
      },
      {
        level: DegradationLevel.COMPLETE_OUTAGE,
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
      'unified-detector-solana-native'
    ];

    for (const service of services) {
      for (const levelConfig of defaultLevels) {
        // S4.1.3-FIX: Key by enum value for type-safe lookup
        this.degradationLevels.set(`${service}:${levelConfig.level}`, levelConfig);
      }
    }
  }

  /** S4.1.3-FIX: Updated to use DegradationLevelConfig */
  private async applyDegradation(serviceName: string, levelConfig: DegradationLevelConfig): Promise<void> {
    const redis = await this.redis;

    // P1-15 FIX: Use dual-publish pattern (Streams + Pub/Sub)
    // Notify the service to adjust its behavior
    const degradationMessage = {
      type: 'degradation_applied',
      data: {
        serviceName,
        // S4.1.3-FIX: Include both enum level and human-readable name
        degradationLevel: levelConfig.level,
        degradationLevelName: levelConfig.name,
        enabledFeatures: levelConfig.enabledFeatures,
        disabledFeatures: levelConfig.disabledFeatures,
        performanceImpact: levelConfig.performanceImpact
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
      level: levelConfig.level,
      levelName: levelConfig.name,
      enabledFeatures: levelConfig.enabledFeatures,
      disabledFeatures: levelConfig.disabledFeatures,
      appliedAt: Date.now()
    });

    logger.info(`Applied degradation level ${levelConfig.name} (${DegradationLevel[levelConfig.level]}) to ${serviceName}`);
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
    // S4.1.3-FIX: Use injectable tester if provided (for deterministic testing)
    if (this.capabilityTester) {
      return this.capabilityTester(serviceName, capability);
    }

    // Production capability testing
    const redis = await this.redis;
    switch (capability.name) {
      case 'redis_connection':
        return await redis.ping();

      case 'web3_connection':
        // P2-24 FIX: Default to false — untested capabilities should not
        // optimistically report as healthy. Services should register a
        // capabilityTester via constructor for accurate probing.
        logger.debug(`No probe available for web3_connection on ${serviceName}, assuming unavailable`);
        return false;

      case 'ml_prediction':
        // P2-24 FIX: Default to false — untested capabilities should not
        // optimistically report as healthy.
        logger.debug(`No probe available for ml_prediction on ${serviceName}, assuming unavailable`);
        return false;

      default:
        // P2-24 FIX: Unknown capabilities default to false. Services should
        // register a capabilityTester for accurate testing.
        logger.debug(`No probe available for unknown capability ${capability.name} on ${serviceName}`);
        return false;
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

/**
 * S4.1.3-FIX: Reset the singleton instance (for testing).
 * This prevents test pollution across test files.
 */
export function resetGracefulDegradationManager(): void {
  if (globalDegradationManager) {
    // Clear all recovery timers to prevent leaks
    const manager = globalDegradationManager as unknown as { recoveryTimers?: Map<string, NodeJS.Timeout> };
    if (manager.recoveryTimers) {
      for (const timer of manager.recoveryTimers.values()) {
        clearTimeout(timer);
      }
      manager.recoveryTimers.clear();
    }
  }
  globalDegradationManager = null;
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

export function getCapabilityFallback(serviceName: string, capabilityName: string): unknown {
  return getGracefulDegradationManager().getCapabilityFallback(serviceName, capabilityName);
}