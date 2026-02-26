// Expert Self-Healing Manager
// Implements enterprise-grade automatic recovery patterns with intelligent decision making
//
// P0-10 FIX: Migrated from Pub/Sub to Redis Streams for critical system control messages
// This ensures guaranteed delivery per ADR-002.
//
// Migration Status:
// - [DONE] Added streams client for publishing to streams
// - [DONE] Created helper for dual publish (streams + pub/sub for backward compatibility)
// - [DONE] Added consumer groups for stream consumption
// - [DONE] Migration flag to disable Pub/Sub when all consumers migrated
//
// To complete migration: Set DISABLE_PUBSUB_FALLBACK=true in environment after verifying
// all consumers are reading from streams.

import { createLogger } from '../logger';
import { clearIntervalSafe, stopAndNullify } from '../async/lifecycle-utils';
import { getRedisClient } from '../redis/client';
import { getRedisStreamsClient, RedisStreamsClient, StreamConsumer, ConsumerGroupConfig } from '../redis/streams';
import { getCircuitBreakerRegistry } from './circuit-breaker';
import { getDeadLetterQueue } from './dead-letter-queue';
import { getEnhancedHealthMonitor } from '../monitoring/enhanced-health-monitor';
import { getErrorRecoveryOrchestrator } from './error-recovery';

const logger = createLogger('expert-self-healing-manager');

// P0-10 FIX: Stream names for system control messages (ADR-002 compliant)
const SYSTEM_STREAMS = {
  FAILURES: 'stream:system-failures',
  CONTROL: 'stream:system-control',
  FAILOVER: 'stream:system-failover',
  SCALING: 'stream:system-scaling'
} as const;

// P0-10 FIX: Consumer group configuration for self-healing manager
const CONSUMER_GROUP_NAME = 'self-healing-manager';
const CONSUMER_NAME = `shm-${process.pid || 'default'}`;

/**
 * P0-10 FIX: Migration flag to disable Pub/Sub fallback.
 * Set DISABLE_PUBSUB_FALLBACK=true after all consumers are confirmed migrated to streams.
 */
const DISABLE_PUBSUB_FALLBACK = process.env.DISABLE_PUBSUB_FALLBACK === 'true';

export enum FailureSeverity {
  LOW = 'low',           // Temporary glitch, self-correcting
  MEDIUM = 'medium',     // Service degradation, requires intervention
  HIGH = 'high',         // Service failure, immediate recovery needed
  CRITICAL = 'critical'  // System-wide impact, emergency procedures
}

export enum RecoveryStrategy {
  RESTART_SERVICE = 'restart_service',
  FAILOVER_TO_BACKUP = 'failover_to_backup',
  SCALE_UP_RESOURCES = 'scale_up_resources',
  ROLLBACK_DEPLOYMENT = 'rollback_deployment',
  CIRCUIT_BREAKER_TRIP = 'circuit_breaker_trip',
  LOAD_SHEDDING = 'load_shedding',
  DATA_REPAIR = 'data_repair',
  NETWORK_RESET = 'network_reset',
  MEMORY_COMPACTION = 'memory_compaction',
  CONFIGURATION_RESET = 'configuration_reset'
}

export interface FailureEvent {
  id: string;
  serviceName: string;
  component: string;
  error: Error;
  severity: FailureSeverity;
  context: Record<string, unknown>;
  timestamp: number;
  recoveryAttempts: number;
  lastRecoveryAttempt?: number;
}

export interface RecoveryAction {
  id: string;
  failureId: string;
  strategy: RecoveryStrategy;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  startTime: number;
  endTime?: number;
  success?: boolean;
  error?: string;
  rollbackRequired?: boolean;
}

// P3-33 FIX: Typed return for getFailureStatistics()
export interface FailureStatistics {
  totalFailures: number;
  failureByService: Record<string, number>;
  failureBySeverity: Record<string, number>;
  timeframe: number;
}

export interface ServiceHealthState {
  serviceName: string;
  healthScore: number; // 0-100
  lastHealthyCheck: number;
  consecutiveFailures: number;
  recoveryCooldown: number; // Don't attempt recovery too frequently
  activeRecoveryActions: RecoveryAction[];
}

export class ExpertSelfHealingManager {
  private redis = getRedisClient();
  private streamsClient: RedisStreamsClient | null = null; // P0-10 FIX: Add streams client
  private circuitBreakers = getCircuitBreakerRegistry();
  private dlq = getDeadLetterQueue();
  private healthMonitor = getEnhancedHealthMonitor();
  private errorRecovery = getErrorRecoveryOrchestrator();

  private serviceHealthStates = new Map<string, ServiceHealthState>();
  private activeRecoveryActions = new Map<string, RecoveryAction>();
  private failureHistory: FailureEvent[] = [];
  private recoveryCooldowns = new Map<string, number>();
  private isRunning = false;
  private monitoringInterval: NodeJS.Timeout | null = null;

  // P0-10 FIX: Stream consumers for ADR-002 compliant message consumption
  private failureStreamConsumer: StreamConsumer | null = null;

  constructor() {
    this.initializeDefaultStates();
  }

  /**
   * P0-10 FIX: Initialize streams client for ADR-002 compliant message delivery
   */
  private async initializeStreamsClient(): Promise<void> {
    if (!this.streamsClient) {
      this.streamsClient = await getRedisStreamsClient();
    }
  }

  /**
   * P0-10 FIX: Initialize consumer groups for all system streams.
   * Consumer groups provide guaranteed message delivery and distributed processing.
   */
  private async initializeConsumerGroups(): Promise<void> {
    if (!this.streamsClient) {
      logger.warn('Streams client not initialized, skipping consumer group creation');
      return;
    }

    // Create consumer groups for all system streams
    const streams = Object.values(SYSTEM_STREAMS);
    for (const streamName of streams) {
      try {
        await this.streamsClient.createConsumerGroup({
          streamName,
          groupName: CONSUMER_GROUP_NAME,
          consumerName: CONSUMER_NAME,
          startId: '$' // Only consume new messages (use '0' to process all existing)
        });
        logger.debug('Consumer group initialized', { streamName, groupName: CONSUMER_GROUP_NAME });
      } catch (error) {
        // createConsumerGroup already handles BUSYGROUP (group exists), so this is a real error
        logger.error('Failed to create consumer group', {
          streamName,
          error: (error as Error).message
        });
      }
    }
  }

  /**
   * P0-10 FIX: Publish to Redis Streams (guaranteed delivery) and optionally Pub/Sub (for backward compatibility).
   * This ensures messages are not lost even if the target service is temporarily unavailable.
   *
   * Migration: Set DISABLE_PUBSUB_FALLBACK=true after all consumers have migrated to streams.
   */
  private async publishControlMessage(
    streamName: string,
    pubsubChannel: string,
    message: Record<string, unknown>
  ): Promise<void> {
    const redis = await this.redis;

    // Primary: Publish to Redis Streams (guaranteed delivery)
    if (this.streamsClient) {
      try {
        await this.streamsClient.xadd(streamName, message, '*', { maxLen: 10000 });
        logger.debug('Published control message to stream', { streamName, type: message.type });
      } catch (error) {
        logger.error('Failed to publish to stream, falling back to pub/sub only', {
          streamName,
          error: (error as Error).message
        });
      }
    }

    // Secondary: Publish to Pub/Sub (backward compatibility during migration)
    // P0-10 FIX: Skip Pub/Sub if migration flag is set (all consumers on streams)
    if (!DISABLE_PUBSUB_FALLBACK) {
      try {
        await redis.publish(pubsubChannel, message as unknown as import('@arbitrage/types').MessageEvent);
      } catch (error) {
        logger.error('Failed to publish to pub/sub', {
          channel: pubsubChannel,
          error: (error as Error).message
        });
      }
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) return;

    logger.info('Starting Expert Self-Healing Manager');

    this.isRunning = true;

    // P0-10 FIX: Initialize streams client for ADR-002 compliant messaging
    await this.initializeStreamsClient();

    // P0-10 FIX: Initialize consumer groups for all system streams
    await this.initializeConsumerGroups();

    // Start monitoring and recovery loops
    this.startHealthMonitoring();
    this.startFailureDetection();
    this.startRecoveryOrchestration();

    // Subscribe to failure events (uses streams consumer group + optional pub/sub fallback)
    await this.subscribeToFailureEvents();

    logger.info('Expert Self-Healing Manager started successfully', {
      pubsubFallbackEnabled: !DISABLE_PUBSUB_FALLBACK
    });
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    logger.info('Stopping Expert Self-Healing Manager');

    this.isRunning = false;

    // Clear monitoring intervals
    this.monitoringInterval = clearIntervalSafe(this.monitoringInterval);

    // P0-10 FIX: Stop stream consumers gracefully
    this.failureStreamConsumer = await stopAndNullify(this.failureStreamConsumer);

    // Cancel all active recovery actions
    for (const [actionId, action] of this.activeRecoveryActions) {
      if (action.status === 'executing') {
        await this.cancelRecoveryAction(actionId, 'System shutdown');
      }
    }

    logger.info('Expert Self-Healing Manager stopped');
  }

  // Report a failure for analysis and recovery
  async reportFailure(
    serviceName: string,
    component: string,
    error: Error,
    context: Record<string, unknown> = {}
  ): Promise<void> {
    const failure: FailureEvent = {
      id: `failure_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
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
    await this.publishControlMessage(
      SYSTEM_STREAMS.FAILURES,
      'system:failures',
      {
        type: 'failure_reported',
        data: {
          id: failure.id,
          serviceName: failure.serviceName,
          component: failure.component,
          errorMessage: failure.error?.message ?? 'unknown error',
          severity: failure.severity,
          context: failure.context,
          timestamp: failure.timestamp
        },
        timestamp: Date.now(),
        source: 'expert-self-healing-manager'
      }
    );

    // Trigger immediate analysis and recovery
    await this.analyzeAndRecover(failure);

    logger.warn('Failure reported', {
      service: serviceName,
      component,
      severity: failure.severity,
      error: error?.message ?? 'unknown error'
    });
  }

  // Assess failure severity based on error type and context
  private assessFailureSeverity(error: Error, context: Record<string, unknown>): FailureSeverity {
    // Guard against null/undefined error
    const message = error?.message ?? '';

    // Network-related failures
    if (message.includes('ECONNREFUSED') ||
      message.includes('ENOTFOUND') ||
      message.includes('timeout')) {
      return FailureSeverity.MEDIUM;
    }

    // Memory/CPU resource issues
    if (message.includes('out of memory') ||
      message.includes('heap limit') ||
      ((context?.memoryUsage as number | undefined) ?? 0) > 0.9) { // 90% memory usage
      return FailureSeverity.HIGH;
    }

    // Database connectivity issues
    if (message.includes('Redis') && message.includes('connection')) {
      return FailureSeverity.HIGH;
    }

    // Circuit breaker trips
    if (context?.circuitBreakerTripped === true) {
      return FailureSeverity.MEDIUM;
    }

    // WebSocket disconnections (common, low severity)
    if (message.includes('WebSocket') &&
      (message.includes('close') || message.includes('disconnect'))) {
      return FailureSeverity.LOW;
    }

    // Data corruption or critical logic failures
    if (message.includes('corrupt') ||
      message.includes('invalid') ||
      context?.dataIntegrityFailure === true) {
      return FailureSeverity.CRITICAL;
    }

    // Default to medium severity
    return FailureSeverity.MEDIUM;
  }

  // Update service health state based on failure
  private async updateServiceHealthState(serviceName: string, failure: FailureEvent): Promise<void> {
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

    const state = this.serviceHealthStates.get(serviceName)!;

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
      [FailureSeverity.LOW]: 30000,      // 30 seconds
      [FailureSeverity.MEDIUM]: 60000,   // 1 minute
      [FailureSeverity.HIGH]: 300000,    // 5 minutes
      [FailureSeverity.CRITICAL]: 600000 // 10 minutes
    };

    state.recoveryCooldown = Date.now() + cooldownTime[failure.severity];

    const redis = await this.redis;
    // Store in Redis for persistence
    await redis.set(`health_state:${serviceName}`, state, 3600); // 1 hour TTL
  }

  // Analyze failure and determine recovery strategy
  private async analyzeAndRecover(failure: FailureEvent): Promise<void> {
    const state = this.serviceHealthStates.get(failure.serviceName);
    if (!state) return;

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
  private async determineRecoveryStrategy(
    failure: FailureEvent,
    state: ServiceHealthState
  ): Promise<RecoveryStrategy | null> {
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
        // P0-2 FIX: Use includes() instead of >= for string enum comparison.
        // Lexicographic >= is wrong: 'critical' < 'high' and 'low' > 'high',
        // which inverts severity — CRITICAL wouldn't trigger but LOW would.
        if ([FailureSeverity.HIGH, FailureSeverity.CRITICAL].includes(severity)) {
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
        } else if (recoveryAttempts <= 2) {
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
  private async executeRecoveryAction(
    failure: FailureEvent,
    strategy: RecoveryStrategy
  ): Promise<void> {
    const action: RecoveryAction = {
      id: `recovery_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
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
      } else {
        action.rollbackRequired = true;
        logger.warn('Recovery action failed', {
          actionId: action.id,
          strategy,
          service: failure.serviceName
        });
      }

    } catch (error) {
      action.status = 'failed';
      action.endTime = Date.now();
      action.error = (error as Error).message;
      action.rollbackRequired = true;

      logger.error('Recovery action threw exception', {
        actionId: action.id,
        strategy,
        service: failure.serviceName,
        error: (error as Error).message
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
  private async performRecoveryAction(
    failure: FailureEvent,
    strategy: RecoveryStrategy
  ): Promise<boolean> {
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
  private async restartService(serviceName: string): Promise<boolean> {
    try {
      // P0-10 FIX: Use streams for guaranteed delivery
      await this.publishControlMessage(
        SYSTEM_STREAMS.CONTROL,
        `service:${serviceName}:control`,
        {
          type: 'restart_command',
          serviceName,
          data: { command: 'restart' },
          timestamp: Date.now(),
          source: 'expert-self-healing-manager'
        }
      );

      // Wait for service to report healthy
      const healthy = await this.waitForServiceHealth(serviceName, 30000);
      return healthy;
    } catch (error) {
      logger.error('Service restart failed', { service: serviceName, error });
      return false;
    }
  }

  private async resetNetworkConnection(serviceName: string): Promise<boolean> {
    try {
      // P0-10 FIX: Use streams for guaranteed delivery
      await this.publishControlMessage(
        SYSTEM_STREAMS.CONTROL,
        `service:${serviceName}:control`,
        {
          type: 'reset_network_command',
          serviceName,
          data: { command: 'reset_network' },
          timestamp: Date.now(),
          source: 'expert-self-healing-manager'
        }
      );
      return true;
    } catch (error) {
      logger.error('Network reset failed', { service: serviceName, error });
      return false;
    }
  }

  private async performMemoryCompaction(serviceName: string): Promise<boolean> {
    try {
      // P0-10 FIX: Use streams for guaranteed delivery
      await this.publishControlMessage(
        SYSTEM_STREAMS.CONTROL,
        `service:${serviceName}:control`,
        {
          type: 'memory_compaction_command',
          serviceName,
          data: { command: 'memory_compaction' },
          timestamp: Date.now(),
          source: 'expert-self-healing-manager'
        }
      );
      return true;
    } catch (error) {
      logger.error('Memory compaction failed', { service: serviceName, error });
      return false;
    }
  }

  private async tripCircuitBreaker(serviceName: string): Promise<boolean> {
    try {
      const circuitBreaker = this.circuitBreakers.getBreaker(serviceName);
      if (circuitBreaker) {
        circuitBreaker.forceOpen();
        logger.info('Circuit breaker tripped', { service: serviceName });
      }
      return true;
    } catch (error) {
      logger.error('Circuit breaker trip failed', { service: serviceName, error });
      return false;
    }
  }

  private async repairDataIntegrity(serviceName: string): Promise<boolean> {
    try {
      // P0-10 FIX: Use streams for guaranteed delivery
      await this.publishControlMessage(
        SYSTEM_STREAMS.CONTROL,
        `service:${serviceName}:control`,
        {
          type: 'repair_data_command',
          serviceName,
          data: { command: 'repair_data' },
          timestamp: Date.now(),
          source: 'expert-self-healing-manager'
        }
      );
      return true;
    } catch (error) {
      logger.error('Data repair failed', { service: serviceName, error });
      return false;
    }
  }

  private async resetConfiguration(serviceName: string): Promise<boolean> {
    try {
      // P0-10 FIX: Use streams for guaranteed delivery
      await this.publishControlMessage(
        SYSTEM_STREAMS.CONTROL,
        `service:${serviceName}:control`,
        {
          type: 'reset_config_command',
          serviceName,
          data: { command: 'reset_config' },
          timestamp: Date.now(),
          source: 'expert-self-healing-manager'
        }
      );
      return true;
    } catch (error) {
      logger.error('Configuration reset failed', { service: serviceName, error });
      return false;
    }
  }

  private async failoverToBackup(serviceName: string): Promise<boolean> {
    try {
      // P0-10 FIX: Use streams for guaranteed delivery of critical failover commands
      await this.publishControlMessage(
        SYSTEM_STREAMS.FAILOVER,
        'system:failover',
        {
          type: 'failover_command',
          data: {
            service: serviceName,
            action: 'activate_backup'
          },
          timestamp: Date.now(),
          source: 'expert-self-healing-manager'
        }
      );
      return true;
    } catch (error) {
      logger.error('Failover failed', { service: serviceName, error });
      return false;
    }
  }

  private async scaleUpResources(serviceName: string): Promise<boolean> {
    try {
      // P0-10 FIX: Use streams for guaranteed delivery of scaling commands
      await this.publishControlMessage(
        SYSTEM_STREAMS.SCALING,
        'system:scaling',
        {
          type: 'scaling_command',
          data: {
            service: serviceName,
            action: 'scale_up'
          },
          timestamp: Date.now(),
          source: 'expert-self-healing-manager'
        }
      );
      return true;
    } catch (error) {
      logger.error('Scaling failed', { service: serviceName, error });
      return false;
    }
  }

  // Wait for service to report healthy status
  private async waitForServiceHealth(serviceName: string, timeout: number): Promise<boolean> {
    const startTime = Date.now();

    const redis = await this.redis;
    while (Date.now() - startTime < timeout) {
      try {
        const health = await redis.getServiceHealth(serviceName);
        if (health && health.status === 'healthy') {
          return true;
        }
      } catch (error) {
        // Continue waiting
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return false;
  }

  // Cancel a recovery action
  private async cancelRecoveryAction(actionId: string, reason: string): Promise<void> {
    const action = this.activeRecoveryActions.get(actionId);
    if (!action) return;

    action.status = 'failed';
    action.endTime = Date.now();
    action.error = `Cancelled: ${reason}`;

    logger.info('Recovery action cancelled', { actionId, reason });
  }

  // Start periodic health monitoring
  private startHealthMonitoring(): void {
    this.monitoringInterval = setInterval(async () => {
      if (!this.isRunning) return;

      try {
        await this.performHealthCheck();
      } catch (error) {
        logger.error('Health monitoring failed', { error });
      }
    }, 60000); // Every minute
  }

  // Start failure detection
  private startFailureDetection(): void {
    // Failure detection is handled by reportFailure method
    // This could be enhanced with proactive failure detection
  }

  // Start recovery orchestration
  private startRecoveryOrchestration(): void {
    // Recovery orchestration is handled reactively
    // Could be enhanced with predictive recovery
  }

  /**
   * P0-10 FIX: Subscribe to failure events using Redis Streams consumer group.
   * Falls back to Pub/Sub during migration period unless DISABLE_PUBSUB_FALLBACK is set.
   *
   * Consumer groups provide:
   * - Guaranteed message delivery (messages persist until acknowledged)
   * - Distributed processing (multiple consumers share the workload)
   * - At-least-once semantics (failed messages can be reprocessed)
   */
  private async subscribeToFailureEvents(): Promise<void> {
    // Primary: Stream consumer group (guaranteed delivery)
    if (this.streamsClient) {
      const consumerConfig: ConsumerGroupConfig = {
        streamName: SYSTEM_STREAMS.FAILURES,
        groupName: CONSUMER_GROUP_NAME,
        consumerName: CONSUMER_NAME
      };

      this.failureStreamConsumer = new StreamConsumer(this.streamsClient, {
        config: consumerConfig,
        handler: async (message) => {
          try {
            const event = message.data as Record<string, unknown>;
            const eventData = event.data as Record<string, unknown> | undefined;
            logger.debug('Received failure event from stream', {
              messageId: message.id,
              eventType: event.type,
              serviceName: eventData?.serviceName
            });

            // Process the failure event
            if (event.type === 'failure_reported' && eventData) {
              // Note: External failure events are logged but not re-analyzed
              // to avoid infinite loops (we already reported this failure)
              logger.info('External failure event received', {
                serviceName: eventData.serviceName,
                component: eventData.component,
                severity: eventData.severity
              });
            }
          } catch (error) {
            logger.error('Error processing failure event from stream', {
              error: (error as Error).message,
              messageId: message.id
            });
          }
        },
        batchSize: 10,
        blockMs: 5000, // Block for 5 seconds waiting for messages
        autoAck: true,
        logger: {
          error: (msg, ctx) => logger.error(msg, ctx),
          debug: (msg, ctx) => logger.debug(msg, ctx)
        }
      });

      this.failureStreamConsumer.start();
      logger.info('Started failure event stream consumer', {
        streamName: SYSTEM_STREAMS.FAILURES,
        groupName: CONSUMER_GROUP_NAME,
        consumerName: CONSUMER_NAME
      });
    }

    // Secondary: Pub/Sub fallback during migration period
    // P0-10 FIX: Skip Pub/Sub subscription if migration flag is set
    if (!DISABLE_PUBSUB_FALLBACK) {
      const redis = await this.redis;
      await redis.subscribe('system:failures', (event) => {
        // Handle incoming failure reports from legacy Pub/Sub
        logger.debug('Received failure event from pub/sub (legacy)', event);
      });
      logger.debug('Subscribed to pub/sub failure channel (legacy fallback)');
    }
  }

  // Perform periodic health checks
  private async performHealthCheck(): Promise<void> {
    const redis = await this.redis;
    for (const [serviceName, state] of this.serviceHealthStates) {
      try {
        const health = await redis.getServiceHealth(serviceName);

        if (health && health.status === 'healthy') {
          // Service is healthy, gradually improve health score
          state.healthScore = Math.min(100, state.healthScore + 1);
          state.consecutiveFailures = 0;
          state.lastHealthyCheck = Date.now();
        } else {
          // Service is not healthy, decrease health score
          state.healthScore = Math.max(0, state.healthScore - 5);
        }
      } catch (error) {
        logger.debug('Health check failed', { service: serviceName, error });
        state.healthScore = Math.max(0, state.healthScore - 10);
      }
    }
  }

  // Initialize default service states
  private initializeDefaultStates(): void {
    // P3-35 FIX: Updated to partition-based naming per ADR-003 partitioned detector architecture
    const defaultServices = [
      'partition-asia-fast',
      'partition-l2-turbo',
      'partition-high-value',
      'partition-solana',
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
  async getSystemHealthOverview(): Promise<{
    overallHealth: number;
    serviceCount: number;
    criticalServices: number;
    activeRecoveries: number;
    lastUpdate: number;
    services: Array<{
      name: string;
      health: number;
      failures: number;
      activeActions: number;
    }>;
  }> {
    const services = Array.from(this.serviceHealthStates.values());
    const totalHealth = services.reduce((sum, s) => sum + s.healthScore, 0) / services.length;

    const criticalServices = services.filter(s => s.healthScore < 50);
    const activeRecoveries = services.reduce((sum, s) =>
      sum + s.activeRecoveryActions.filter(a => a.status === 'executing').length, 0);

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

  // P3-33 FIX: Made async (removes Promise.resolve wrapper) and added typed return
  async getFailureStatistics(timeframe: number = 3600000): Promise<FailureStatistics> {
    const cutoff = Date.now() - timeframe;
    const recentFailures = this.failureHistory.filter(f => f.timestamp >= cutoff);

    const failureByService = recentFailures.reduce((acc, f) => {
      acc[f.serviceName] = (acc[f.serviceName] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const failureBySeverity = recentFailures.reduce((acc, f) => {
      acc[f.severity] = (acc[f.severity] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    return {
      totalFailures: recentFailures.length,
      failureByService,
      failureBySeverity,
      timeframe
    };
  }
}

// Global instance
let expertSelfHealingManager: ExpertSelfHealingManager | null = null;

export async function getExpertSelfHealingManager(): Promise<ExpertSelfHealingManager> {
  if (!expertSelfHealingManager) {
    expertSelfHealingManager = new ExpertSelfHealingManager();
    await expertSelfHealingManager.start();
  }
  return expertSelfHealingManager;
}

/**
 * P2-22 FIX: Reset singleton for test cleanup, matching pattern of other singletons
 * (resetGracefulDegradationManager, resetRedisInstance, etc.)
 */
export async function resetExpertSelfHealingManager(): Promise<void> {
  if (expertSelfHealingManager) {
    await expertSelfHealingManager.stop();
    expertSelfHealingManager = null;
  }
}