// Self-Healing Service Manager
// Automatically detects failures and orchestrates recovery

import { createLogger } from '../logger';
import { getRedisClient } from '../redis';
import { getRedisStreamsClient, RedisStreamsClient } from '../redis-streams';
import { CircuitBreaker, CircuitBreakerError, createCircuitBreaker } from './circuit-breaker';
// P3-2 FIX: Import unified ServiceHealth from shared types
import type { ServiceHealth } from '../../../types';

// P2-2-FIX: Import config with fallback for test environment
let SYSTEM_CONSTANTS: typeof import('../../../config/src').SYSTEM_CONSTANTS | undefined;
try {
  SYSTEM_CONSTANTS = require('../../../config/src').SYSTEM_CONSTANTS;
} catch {
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
  httpHealthCheckTimeoutMs: 5000, // 5 second timeout for HTTP health checks
};

const CIRCUIT_BREAKER_DEFAULTS = {
  failureThreshold: SYSTEM_CONSTANTS?.circuitBreaker?.defaultFailureThreshold ?? 3,
  recoveryTimeoutMs: SYSTEM_CONSTANTS?.circuitBreaker?.defaultRecoveryTimeoutMs ?? 30000,
  monitoringPeriodMs: SYSTEM_CONSTANTS?.circuitBreaker?.defaultMonitoringPeriodMs ?? 60000,
  successThreshold: SYSTEM_CONSTANTS?.circuitBreaker?.defaultSuccessThreshold ?? 2,
};

const logger = createLogger('self-healing-manager');

export interface ServiceDefinition {
  name: string;
  startCommand: string;
  healthCheckUrl?: string;
  healthCheckInterval: number;
  restartDelay: number;
  maxRestarts: number;
  environment: Record<string, string>;
  dependencies?: string[];
}

// P3-2 FIX: ServiceHealth interface now imported from @arbitrage/types
// Re-export for backwards compatibility
export type { ServiceHealth } from '../../../types';

export interface RecoveryStrategy {
  name: string;
  priority: number;
  canHandle: (service: ServiceHealth, error?: Error) => boolean;
  execute: (service: ServiceHealth) => Promise<boolean>;
}

export class SelfHealingManager {
  private redis = getRedisClient();
  // P1-16 FIX: Add Redis Streams client for ADR-002 compliance
  private streamsClient: RedisStreamsClient | null = null;
  private services = new Map<string, ServiceDefinition>();
  private serviceHealth = new Map<string, ServiceHealth>();
  private recoveryStrategies: RecoveryStrategy[] = [];
  private healthCheckTimers = new Map<string, NodeJS.Timeout>();
  private restartTimers = new Map<string, NodeJS.Timeout>();
  private circuitBreakers = new Map<string, CircuitBreaker>();
  private isRunning = false;
  // P2-FIX: Lock to prevent concurrent health check updates for the same service
  private healthUpdateLocks = new Map<string, Promise<void>>();
  // P1-2-FIX: Store initialization promise to ensure streams client is ready before use
  private initializationPromise: Promise<void>;
  // P5-FIX: Rate limiter to prevent recovery spam attacks
  private recoveryRateLimiter = new Map<string, number>();
  private readonly RECOVERY_COOLDOWN_MS = SELF_HEALING_DEFAULTS.circuitBreakerCooldownMs;
  // P5-FIX-2: Periodic cleanup timer for rate limiter to prevent memory growth
  private rateLimiterCleanupTimer: NodeJS.Timeout | null = null;
  // Cleanup entries older than 10x the cooldown period (10 minutes by default)
  private readonly RATE_LIMITER_TTL_MS = SELF_HEALING_DEFAULTS.circuitBreakerCooldownMs * 10;
  // Cleanup interval: run every 5 minutes
  private readonly RATE_LIMITER_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

  constructor() {
    this.initializeRecoveryStrategies();
    // P1-2-FIX: Store promise so we can await it before using streams client
    this.initializationPromise = this.initializeStreamsClient();
  }

  /**
   * P1-2-FIX: Ensure the manager is fully initialized before operations.
   * Call this before performing any operations that require the streams client.
   */
  async ensureInitialized(): Promise<void> {
    await this.initializationPromise;
  }

  /**
   * P1-16 FIX: Initialize Redis Streams client for dual-publish pattern.
   */
  private async initializeStreamsClient(): Promise<void> {
    try {
      this.streamsClient = await getRedisStreamsClient();
    } catch (error) {
      logger.warn('Failed to initialize Redis Streams client, will use Pub/Sub only', { error });
    }
  }

  /**
   * P1-16 FIX: Dual-publish helper - publishes to both Redis Streams (primary)
   * and Pub/Sub (secondary/fallback) for backwards compatibility.
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

  // Register a service for self-healing management
  registerService(serviceDef: ServiceDefinition): void {
    this.services.set(serviceDef.name, serviceDef);

    // Initialize health tracking
    // P3-2 FIX: Use unified ServiceHealth with correct field names
    this.serviceHealth.set(serviceDef.name, {
      name: serviceDef.name,
      status: 'stopping',
      lastHeartbeat: 0,
      consecutiveFailures: 0,
      restartCount: 0,
      uptime: 0,
      memoryUsage: 0,
      cpuUsage: 0
    });

    // Create circuit breaker for health checks
    // P2-2-FIX: Use configured constants instead of magic numbers
    const circuitBreaker = createCircuitBreaker(
      `${serviceDef.name}-health-check`,
      {
        failureThreshold: CIRCUIT_BREAKER_DEFAULTS.failureThreshold,
        recoveryTimeout: CIRCUIT_BREAKER_DEFAULTS.recoveryTimeoutMs,
        monitoringPeriod: CIRCUIT_BREAKER_DEFAULTS.monitoringPeriodMs,
        successThreshold: CIRCUIT_BREAKER_DEFAULTS.successThreshold
      }
    );
    this.circuitBreakers.set(serviceDef.name, circuitBreaker);

    logger.info(`Registered service for self-healing: ${serviceDef.name}`);
  }

  // Start the self-healing manager
  async start(): Promise<void> {
    if (this.isRunning) return;

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

    // P5-FIX-2: Start periodic cleanup of rate limiter to prevent memory growth
    this.startRateLimiterCleanup();
  }

  /**
   * P5-FIX-2: Start periodic cleanup of recoveryRateLimiter.
   * Removes entries older than RATE_LIMITER_TTL_MS to prevent unbounded memory growth.
   */
  private startRateLimiterCleanup(): void {
    // Clear existing timer if any
    if (this.rateLimiterCleanupTimer) {
      clearInterval(this.rateLimiterCleanupTimer);
    }

    this.rateLimiterCleanupTimer = setInterval(() => {
      if (!this.isRunning) return;

      const now = Date.now();
      const cutoff = now - this.RATE_LIMITER_TTL_MS;
      let cleanedCount = 0;

      for (const [serviceName, timestamp] of this.recoveryRateLimiter.entries()) {
        if (timestamp < cutoff) {
          this.recoveryRateLimiter.delete(serviceName);
          cleanedCount++;
        }
      }

      if (cleanedCount > 0) {
        logger.debug(`Rate limiter cleanup: removed ${cleanedCount} stale entries`);
      }
    }, this.RATE_LIMITER_CLEANUP_INTERVAL_MS);

    // Ensure timer doesn't prevent process exit
    if (this.rateLimiterCleanupTimer.unref) {
      this.rateLimiterCleanupTimer.unref();
    }
  }

  // Stop the self-healing manager
  async stop(): Promise<void> {
    if (!this.isRunning) return;

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

    // P5-FIX-2: Clear rate limiter cleanup timer
    if (this.rateLimiterCleanupTimer) {
      clearInterval(this.rateLimiterCleanupTimer);
      this.rateLimiterCleanupTimer = null;
    }

    // P2-FIX: Wait for any pending health checks to complete before stopping
    const pendingLocks = Array.from(this.healthUpdateLocks.values());
    if (pendingLocks.length > 0) {
      logger.debug(`Waiting for ${pendingLocks.length} pending health checks to complete`);
      await Promise.all(pendingLocks);
    }
    this.healthUpdateLocks.clear();

    // P5-FIX: Clear rate limiter to prevent memory leaks
    this.recoveryRateLimiter.clear();

    // Circuit breakers don't need explicit destruction in this version

    const redis = await this.redis;
    await redis.disconnect();
    logger.info('Self-healing manager stopped');
  }

  // Get health status of all services
  getAllServiceHealth(): Record<string, ServiceHealth> {
    const health: Record<string, ServiceHealth> = {};
    for (const [name, healthData] of this.serviceHealth) {
      health[name] = { ...healthData };
    }
    return health;
  }

  // Manually trigger recovery for a service
  async triggerRecovery(serviceName: string, error?: Error): Promise<boolean> {
    // P5-FIX: Rate limit recovery triggers to prevent spam/abuse
    const lastRecovery = this.recoveryRateLimiter.get(serviceName) ?? 0;
    const now = Date.now();
    if (now - lastRecovery < this.RECOVERY_COOLDOWN_MS) {
      logger.warn(`Recovery rate limited for ${serviceName}`, {
        cooldownMs: this.RECOVERY_COOLDOWN_MS,
        timeSinceLastMs: now - lastRecovery
      });
      return false;
    }

    const service = this.services.get(serviceName);
    const health = this.serviceHealth.get(serviceName);

    if (!service || !health) {
      logger.error(`Service not found: ${serviceName}`);
      return false;
    }

    // P5-FIX: Record this recovery attempt
    this.recoveryRateLimiter.set(serviceName, now);

    logger.info(`Manually triggering recovery for ${serviceName}`, { error: error?.message });

    return this.executeRecoveryStrategies(service, health, error);
  }

  // Add custom recovery strategy
  addRecoveryStrategy(strategy: RecoveryStrategy): void {
    this.recoveryStrategies.push(strategy);
    this.recoveryStrategies.sort((a, b) => b.priority - a.priority); // Higher priority first
  }

  private initializeRecoveryStrategies(): void {
    // Strategy 1: Simple restart (highest priority)
    this.addRecoveryStrategy({
      name: 'simple_restart',
      priority: 100,
      canHandle: (service, error) => {
        // P3-2 FIX: Add default values for optional fields
        return (service.consecutiveFailures ?? 0) > 0 && (service.restartCount ?? 0) < (this.services.get(service.name)?.maxRestarts || 3);
      },
      execute: async (service) => {
        const serviceDef = this.services.get(service.name);
        if (!serviceDef) return false;

        logger.info(`Executing simple restart for ${service.name}`);

        try {
          await this.restartService(serviceDef);
          return true;
        } catch (error) {
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
        // P3-2 FIX: Add default values for optional fields
        return error instanceof CircuitBreakerError ||
          (service.consecutiveFailures ?? 0) >= 5;
      },
      execute: async (service) => {
        logger.info(`Activating circuit breaker for ${service.name}`);

        const breaker = this.circuitBreakers.get(service.name);
        if (breaker) {
          breaker.forceOpen();
          // P6-FIX: Track recovery timer to prevent orphaned timers on shutdown
          // Clear any existing timer for this service
          const existingTimer = this.restartTimers.get(`cb-recovery:${service.name}`);
          if (existingTimer) {
            clearTimeout(existingTimer);
          }
          // Schedule automatic recovery after cooldown
          // P2-2-FIX: Use configured constant instead of magic number
          const recoveryTimer = setTimeout(() => {
            this.restartTimers.delete(`cb-recovery:${service.name}`);
            if (this.isRunning) {
              logger.info(`Testing recovery for ${service.name}`);
              this.performHealthCheck(service.name);
            }
          }, SELF_HEALING_DEFAULTS.circuitBreakerCooldownMs);
          this.restartTimers.set(`cb-recovery:${service.name}`, recoveryTimer);
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
        if (!serviceDef?.dependencies) return false;

        logger.info(`Restarting dependencies for ${service.name}`, { dependencies: serviceDef.dependencies });

        let success = true;
        for (const dependency of serviceDef.dependencies) {
          try {
            await this.triggerRecovery(dependency);
          } catch (error) {
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
        // P3-2 FIX: Add default values for optional fields
        return (service.restartCount ?? 0) >= 3;
      },
      execute: async (service) => {
        const serviceDef = this.services.get(service.name);
        if (!serviceDef) return false;

        // P2-2-FIX: Use configured constant instead of magic number
        // P3-2 FIX: Add default values for optional fields
        const delay = Math.min(
          serviceDef.restartDelay * Math.pow(2, service.restartCount ?? 0),
          SELF_HEALING_DEFAULTS.maxRestartDelayMs
        );

        logger.info(`Executing escalated restart for ${service.name} with ${delay}ms delay`);

        return new Promise((resolve) => {
          // P6-FIX: Track escalated restart timer to prevent orphaned timers on shutdown
          const timerKey = `escalated-restart:${service.name}`;
          const existingTimer = this.restartTimers.get(timerKey);
          if (existingTimer) {
            clearTimeout(existingTimer);
          }

          const restartTimer = setTimeout(async () => {
            this.restartTimers.delete(timerKey);
            if (!this.isRunning) {
              resolve(false);
              return;
            }
            try {
              await this.restartService(serviceDef);
              resolve(true);
            } catch (error) {
              logger.error(`Escalated restart failed for ${service.name}`, { error });
              resolve(false);
            }
          }, delay);
          this.restartTimers.set(timerKey, restartTimer);
        });
      }
    });

    // Strategy 5: Graceful degradation (lowest priority)
    this.addRecoveryStrategy({
      name: 'graceful_degradation',
      priority: 50,
      canHandle: (service, error) => {
        // P2-2-FIX: Use configured constant instead of magic number
        // P3-2 FIX: Add default values for optional fields
        return (service.consecutiveFailures ?? 0) >= SELF_HEALING_DEFAULTS.gracefulDegradationThreshold;
      },
      execute: async (service) => {
        logger.warn(`Activating graceful degradation for ${service.name}`);

        // Put service in degraded mode
        const health = this.serviceHealth.get(service.name);
        if (health) {
          health.status = 'unhealthy';
          health.error = 'Service in graceful degradation mode';

          // Notify other services of degradation
          await this.notifyServiceDegradation(service.name);
        }

        return true;
      }
    });
  }

  private async startHealthMonitoring(serviceName: string, serviceDef: ServiceDefinition): Promise<void> {
    const timer = setInterval(async () => {
      if (!this.isRunning) return;

      await this.performHealthCheck(serviceName);
    }, serviceDef.healthCheckInterval);

    this.healthCheckTimers.set(serviceName, timer);
    logger.debug(`Started health monitoring for ${serviceName}`);
  }

  private async performHealthCheck(serviceName: string): Promise<void> {
    const serviceDef = this.services.get(serviceName);
    const health = this.serviceHealth.get(serviceName);
    const breaker = this.circuitBreakers.get(serviceName);

    if (!serviceDef || !health || !breaker) return;

    // P2-FIX: Wait for any existing health check to complete for this service
    // This prevents TOCTOU race conditions when multiple health checks run concurrently
    // P6-FIX: Add timeout to prevent deadlock if previous lock never resolves
    const existingLock = this.healthUpdateLocks.get(serviceName);
    if (existingLock) {
      const LOCK_TIMEOUT_MS = 10000; // 10 second timeout
      await Promise.race([
        existingLock,
        new Promise<void>((resolve) => setTimeout(() => {
          logger.warn(`Health check lock timeout for ${serviceName}, proceeding anyway`);
          resolve();
        }, LOCK_TIMEOUT_MS))
      ]);
    }

    // P2-FIX: Create a lock for this health check
    let resolveLock: () => void;
    const lockPromise = new Promise<void>(resolve => {
      resolveLock = resolve;
    });
    this.healthUpdateLocks.set(serviceName, lockPromise);

    try {
      const isHealthy = await breaker.execute(async () => {
        if (serviceDef.healthCheckUrl) {
          // HTTP health check
          return await this.checkHttpHealth(serviceDef.healthCheckUrl);
        } else {
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
            status: 'healthy' as const,
            lastHeartbeat: now,
            consecutiveFailures: 0,
            uptime: now,
            error: undefined
          });
        } else {
          health.lastHeartbeat = now;
        }
      } else {
        // P2-FIX: Capture failure count before increment for recovery decision
        // P3-2 FIX: Add default values for optional fields
        const newFailureCount = (health.consecutiveFailures ?? 0) + 1;
        Object.assign(health, {
          status: 'unhealthy' as const,
          lastHeartbeat: now,
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

    } catch (error: any) {
      // P2-FIX: Atomic error state update
      // P3-2 FIX: Add default values for optional fields
      const newFailureCount = (health.consecutiveFailures ?? 0) + 1;
      if (error instanceof CircuitBreakerError) {
        logger.warn(`Health check circuit breaker open for ${serviceName}`);
        Object.assign(health, {
          status: 'unhealthy' as const,
          error: 'Health check circuit breaker open'
        });
      } else {
        logger.error(`Health check failed for ${serviceName}`, { error });
        Object.assign(health, {
          status: 'unhealthy' as const,
          consecutiveFailures: newFailureCount,
          error: error.message
        });
      }
    } finally {
      // P2-FIX: Release the lock
      this.healthUpdateLocks.delete(serviceName);
      resolveLock!();
    }
  }

  private async executeRecoveryStrategies(serviceDef: ServiceDefinition, health: ServiceHealth, error?: Error): Promise<boolean> {
    for (const strategy of this.recoveryStrategies) {
      if (strategy.canHandle(health, error)) {
        logger.info(`Attempting recovery strategy: ${strategy.name} for ${health.name}`);

        try {
          const success = await strategy.execute(health);
          if (success) {
            logger.info(`Recovery strategy ${strategy.name} succeeded for ${health.name}`);
            return true;
          } else {
            logger.warn(`Recovery strategy ${strategy.name} failed for ${health.name}`);
          }
        } catch (strategyError) {
          logger.error(`Recovery strategy ${strategy.name} threw error for ${health.name}`, { error: strategyError });
        }
      }
    }

    logger.error(`All recovery strategies failed for ${health.name}`);
    return false;
  }

  private async restartService(serviceDef: ServiceDefinition): Promise<void> {
    const health = this.serviceHealth.get(serviceDef.name);
    if (!health) return;

    health.status = 'starting';
    // P3-2 FIX: Handle optional field
    health.restartCount = (health.restartCount ?? 0) + 1;

    logger.info(`Restarting service ${serviceDef.name} (attempt ${health.restartCount})`);

    try {
      // In a real implementation, this would execute the start command
      // For now, we'll simulate the restart process
      await this.simulateServiceRestart(serviceDef);

      health.status = 'healthy';
      health.consecutiveFailures = 0;
      health.uptime = Date.now();
      health.error = undefined;

      logger.info(`Service ${serviceDef.name} restarted successfully`);

    } catch (error) {
      logger.error(`Service restart failed for ${serviceDef.name}`, { error });
      health.status = 'unhealthy';
      throw error;
    }
  }

  private async checkHttpHealth(url: string): Promise<boolean> {
    // Real HTTP health check with timeout
    const timeoutMs = SELF_HEALING_DEFAULTS.httpHealthCheckTimeoutMs || 5000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
      });
      return response.ok;
    } catch (error) {
      // Log but don't throw - unhealthy is not an error condition
      logger.debug('HTTP health check failed', { url, error: (error as Error).message });
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async checkProcessHealth(serviceName: string): Promise<boolean> {
    // Check if process is running (simplified)
    const health = this.serviceHealth.get(serviceName);
    return health ? health.status === 'healthy' : false;
  }

  private async simulateServiceRestart(serviceDef: ServiceDefinition): Promise<void> {
    // P2-2-FIX: Use configured constants instead of magic numbers
    // Simulate restart delay
    await new Promise(resolve => setTimeout(resolve, SELF_HEALING_DEFAULTS.simulatedRestartDelayMs));

    // P6-FIX: Only simulate restart failures in test environment
    // Production code should never randomly fail service restarts
    if (process.env.NODE_ENV === 'test' && Math.random() < SELF_HEALING_DEFAULTS.simulatedRestartFailureRate) {
      throw new Error('Simulated restart failure');
    }
  }

  private async subscribeToHealthUpdates(): Promise<void> {
    const redis = await this.redis;
    await redis.subscribe('service-health-updates', (messageEvent) => {
      try {
        const healthUpdate = messageEvent.data;
        this.handleHealthUpdate(healthUpdate);
      } catch (error) {
        logger.error('Failed to handle health update', { error });
      }
    });
  }

  private handleHealthUpdate(update: any): void {
    // P3-2 FIX: Support both 'name' (new) and 'service' (legacy) field names
    const serviceName = update?.name ?? update?.service;
    const existingHealth = this.serviceHealth.get(serviceName);
    if (existingHealth) {
      Object.assign(existingHealth, update);
    }
  }

  private async updateHealthInRedis(serviceName: string, health: ServiceHealth): Promise<void> {
    const redis = await this.redis;
    await redis.set(`health:${serviceName}`, health, 300); // 5 minute TTL
  }

  private async notifyServiceDegradation(serviceName: string): Promise<void> {
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

    await this.dualPublish(
      'stream:service-degradation',  // Primary: Redis Streams
      'service-degradation',  // Secondary: Pub/Sub
      degradationMessage
    );
  }
}

// P3-1 FIX: Global self-healing manager instance with promise guard
// Prevents race conditions when multiple callers request the singleton concurrently
let globalSelfHealingManager: SelfHealingManager | null = null;
let initializingPromise: Promise<SelfHealingManager> | null = null;

/**
 * Get the singleton SelfHealingManager instance.
 * P3-1 FIX: Uses promise guard to prevent race conditions during initialization.
 * The returned manager is guaranteed to be fully initialized.
 */
export async function getSelfHealingManager(): Promise<SelfHealingManager> {
  // Return existing instance if already initialized
  if (globalSelfHealingManager) {
    return globalSelfHealingManager;
  }

  // If initialization is in progress, await the existing promise
  if (initializingPromise) {
    return initializingPromise;
  }

  // Start initialization with promise guard
  initializingPromise = (async () => {
    const manager = new SelfHealingManager();
    await manager.ensureInitialized();
    globalSelfHealingManager = manager;
    return manager;
  })();

  return initializingPromise;
}

/**
 * Get the singleton synchronously (without waiting for initialization).
 * Use this only when you know the manager is already initialized.
 * Returns null if not yet initialized.
 */
export function getSelfHealingManagerSync(): SelfHealingManager | null {
  return globalSelfHealingManager;
}

/**
 * Reset the singleton (for testing).
 * P3-1 FIX: Properly cleans up both instance and promise guard.
 */
export async function resetSelfHealingManager(): Promise<void> {
  if (globalSelfHealingManager) {
    await globalSelfHealingManager.stop();
  }
  globalSelfHealingManager = null;
  initializingPromise = null;
}

// Convenience function to register a service
export async function registerServiceForSelfHealing(serviceDef: ServiceDefinition): Promise<void> {
  const manager = await getSelfHealingManager();
  manager.registerService(serviceDef);
}