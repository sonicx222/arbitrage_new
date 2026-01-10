// Self-Healing Service Manager
// Automatically detects failures and orchestrates recovery

import { createLogger } from './logger';
import { getRedisClient } from './redis';
import { CircuitBreaker, CircuitBreakerError, createCircuitBreaker } from './circuit-breaker';

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

export interface ServiceHealth {
  name: string;
  status: 'healthy' | 'unhealthy' | 'starting' | 'stopping';
  lastHealthCheck: number;
  consecutiveFailures: number;
  restartCount: number;
  uptime: number;
  memoryUsage?: number;
  cpuUsage?: number;
  errorMessage?: string;
}

export interface RecoveryStrategy {
  name: string;
  priority: number;
  canHandle: (service: ServiceHealth, error?: Error) => boolean;
  execute: (service: ServiceHealth) => Promise<boolean>;
}

export class SelfHealingManager {
  private redis = getRedisClient();
  private services = new Map<string, ServiceDefinition>();
  private serviceHealth = new Map<string, ServiceHealth>();
  private recoveryStrategies: RecoveryStrategy[] = [];
  private healthCheckTimers = new Map<string, NodeJS.Timeout>();
  private restartTimers = new Map<string, NodeJS.Timeout>();
  private circuitBreakers = new Map<string, CircuitBreaker>();
  private isRunning = false;

  constructor() {
    this.initializeRecoveryStrategies();
  }

  // Register a service for self-healing management
  registerService(serviceDef: ServiceDefinition): void {
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
    const circuitBreaker = createCircuitBreaker(
      {
        failureThreshold: 3,
        recoveryTimeout: 30000,
        monitoringPeriod: 60000,
        successThreshold: 2,
        timeout: 5000
      },
      `${serviceDef.name}-health-check`
    );
    this.circuitBreakers.set(serviceDef.name, circuitBreaker);

    logger.info(`Registered service for self-healing: ${serviceDef.name}`);
  }

  // Start the self-healing manager
  async start(): Promise<void> {
    if (this.isRunning) return;

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
        return service.consecutiveFailures > 0 && service.restartCount < (this.services.get(service.name)?.maxRestarts || 3);
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
        return error instanceof CircuitBreakerError ||
          service.consecutiveFailures >= 5;
      },
      execute: async (service) => {
        logger.info(`Activating circuit breaker for ${service.name}`);

        const breaker = this.circuitBreakers.get(service.name);
        if (breaker) {
          breaker.forceOpen();
          // Schedule automatic recovery after cooldown
          setTimeout(() => {
            logger.info(`Testing recovery for ${service.name}`);
            this.performHealthCheck(service.name);
          }, 60000); // 1 minute cooldown
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
        return service.restartCount >= 3;
      },
      execute: async (service) => {
        const serviceDef = this.services.get(service.name);
        if (!serviceDef) return false;

        const delay = Math.min(serviceDef.restartDelay * Math.pow(2, service.restartCount), 300000); // Max 5 minutes

        logger.info(`Executing escalated restart for ${service.name} with ${delay}ms delay`);

        return new Promise((resolve) => {
          setTimeout(async () => {
            try {
              await this.restartService(serviceDef);
              resolve(true);
            } catch (error) {
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
        return service.consecutiveFailures >= 10;
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

      health.lastHealthCheck = Date.now();

      if (isHealthy) {
        if (health.status !== 'healthy') {
          logger.info(`Service ${serviceName} recovered`);
          health.status = 'healthy';
          health.consecutiveFailures = 0;
          health.uptime = Date.now();
          health.errorMessage = undefined;
        }
      } else {
        health.status = 'unhealthy';
        health.consecutiveFailures++;

        // Trigger recovery if needed
        if (health.consecutiveFailures >= 3) {
          await this.executeRecoveryStrategies(serviceDef, health);
        }
      }

      // Update Redis with health status
      await this.updateHealthInRedis(serviceName, health);

    } catch (error) {
      if (error instanceof CircuitBreakerError) {
        logger.warn(`Health check circuit breaker open for ${serviceName}`);
        health.status = 'unhealthy';
        health.errorMessage = 'Health check circuit breaker open';
      } else {
        logger.error(`Health check failed for ${serviceName}`, { error });
        health.status = 'unhealthy';
        health.consecutiveFailures++;
        health.errorMessage = error.message;
      }
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

    } catch (error) {
      logger.error(`Service restart failed for ${serviceDef.name}`, { error });
      health.status = 'unhealthy';
      throw error;
    }
  }

  private async checkHttpHealth(url: string): Promise<boolean> {
    // Simplified HTTP health check
    // In production, this would make actual HTTP requests
    return Math.random() > 0.1; // 90% success rate for simulation
  }

  private async checkProcessHealth(serviceName: string): Promise<boolean> {
    // Check if process is running (simplified)
    const health = this.serviceHealth.get(serviceName);
    return health ? health.status === 'healthy' : false;
  }

  private async simulateServiceRestart(serviceDef: ServiceDefinition): Promise<void> {
    // Simulate restart delay
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Simulate occasional restart failures
    if (Math.random() < 0.2) { // 20% failure rate
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
    const existingHealth = this.serviceHealth.get(update.service);
    if (existingHealth) {
      Object.assign(existingHealth, update);
    }
  }

  private async updateHealthInRedis(serviceName: string, health: ServiceHealth): Promise<void> {
    const redis = await this.redis;
    await redis.set(`health:${serviceName}`, health, 300); // 5 minute TTL
  }

  private async notifyServiceDegradation(serviceName: string): Promise<void> {
    const redis = await this.redis;
    await redis.publish('service-degradation', {
      type: 'service_degraded',
      data: {
        service: serviceName,
        message: 'Service entered graceful degradation mode'
      },
      timestamp: Date.now(),
      source: 'self-healing-manager'
    });
  }
}

// Global self-healing manager instance
let globalSelfHealingManager: SelfHealingManager | null = null;

export function getSelfHealingManager(): SelfHealingManager {
  if (!globalSelfHealingManager) {
    globalSelfHealingManager = new SelfHealingManager();
  }
  return globalSelfHealingManager;
}

// Convenience function to register a service
export function registerServiceForSelfHealing(serviceDef: ServiceDefinition): void {
  getSelfHealingManager().registerService(serviceDef);
}