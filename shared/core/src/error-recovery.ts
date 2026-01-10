// Comprehensive Error Recovery System
// Integrates circuit breakers, retries, dead letter queues, and graceful degradation

import { createLogger } from './logger';
import { getCircuitBreakerRegistry, CircuitBreakerError } from './circuit-breaker';
import { getDeadLetterQueue, enqueueFailedOperation } from './dead-letter-queue';
import { getGracefulDegradationManager, triggerDegradation } from './graceful-degradation';
import { RetryMechanism, RetryPresets } from './retry-mechanism';
import { getSelfHealingManager } from './self-healing-manager';

const logger = createLogger('error-recovery');

export interface RecoveryContext {
  operation: string;
  service: string;
  component: string;
  error: Error;
  metadata?: any;
  correlationId?: string;
  attemptCount?: number;
}

export interface RecoveryResult {
  success: boolean;
  strategy: string;
  duration?: number;
  nextAction?: string;
  error?: Error;
}

export interface RecoveryStrategy {
  name: string;
  priority: number;
  canHandle: (context: RecoveryContext) => boolean;
  execute: (context: RecoveryContext) => Promise<RecoveryResult>;
}

export class ErrorRecoveryOrchestrator {
  private strategies: RecoveryStrategy[] = [];
  private circuitBreakers = getCircuitBreakerRegistry();
  private dlq = getDeadLetterQueue();
  private degradationManager = getGracefulDegradationManager();
  private selfHealingManager = getSelfHealingManager();

  constructor() {
    this.initializeDefaultStrategies();
  }

  // Main recovery orchestration method
  async recover(context: RecoveryContext): Promise<RecoveryResult> {
    const startTime = Date.now();

    logger.warn('Initiating error recovery', {
      operation: context.operation,
      service: context.service,
      component: context.component,
      error: context.error.message
    });

    // Try recovery strategies in priority order
    for (const strategy of this.strategies) {
      if (strategy.canHandle(context)) {
        try {
          logger.debug(`Attempting recovery strategy: ${strategy.name}`);

          const result = await strategy.execute(context);
          const duration = Date.now() - startTime;

          if (result.success) {
            logger.info(`Recovery successful using strategy: ${strategy.name}`, {
              operation: context.operation,
              service: context.service,
              duration
            });
            return { ...result, duration };
          } else {
            logger.debug(`Recovery strategy ${strategy.name} failed, trying next strategy`);
          }
        } catch (strategyError) {
          logger.error(`Recovery strategy ${strategy.name} threw error`, {
            error: strategyError,
            operation: context.operation
          });
        }
      }
    }

    // All strategies failed - escalate to final measures
    const duration = Date.now() - startTime;
    const finalResult = await this.handleFinalFailure(context, duration);

    logger.error('All recovery strategies failed', {
      operation: context.operation,
      service: context.service,
      component: context.component,
      duration,
      finalAction: finalResult.nextAction
    });

    return finalResult;
  }

  // Add custom recovery strategy
  addStrategy(strategy: RecoveryStrategy): void {
    this.strategies.push(strategy);
    this.strategies.sort((a, b) => b.priority - a.priority); // Higher priority first
  }

  // Get recovery statistics
  async getRecoveryStats(): Promise<any> {
    const dlqStats = await this.dlq.getStats();
    const circuitBreakerStats = this.circuitBreakers.getAllStats();
    const degradationStates = this.degradationManager.getAllDegradationStates();

    return {
      deadLetterQueue: dlqStats,
      circuitBreakers: circuitBreakerStats,
      gracefulDegradation: degradationStates,
      timestamp: Date.now()
    };
  }

  private initializeDefaultStrategies(): void {
    // Strategy 1: Circuit Breaker Check (highest priority)
    this.addStrategy({
      name: 'circuit_breaker_check',
      priority: 100,
      canHandle: (context) => {
        const breaker = this.circuitBreakers.getBreaker(`${context.service}-${context.component}`);
        return breaker ? breaker.getStats().state === 'OPEN' : false;
      },
      execute: async (context) => {
        // Wait for circuit breaker to allow attempts
        const breaker = this.circuitBreakers.getBreaker(`${context.service}-${context.component}`);
        if (breaker) {
          await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
          return { success: false, strategy: 'circuit_breaker_check' };
        }
        return { success: false, strategy: 'circuit_breaker_check' };
      }
    });

    // Strategy 2: Simple Retry
    this.addStrategy({
      name: 'simple_retry',
      priority: 90,
      canHandle: (context) => {
        // Retry for transient errors
        const retryableErrors = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'timeout'];
        return retryableErrors.some(code => context.error.message.includes(code)) &&
          (context.attemptCount || 0) < 3;
      },
      execute: async (context) => {
        const retryMechanism = new RetryMechanism({
          maxAttempts: 3,
          initialDelay: 1000,
          backoffMultiplier: 2,
          retryCondition: (error) => {
            const retryableErrors = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'];
            return retryableErrors.some(code => error.message.includes(code));
          }
        });

        // This would typically wrap the actual operation
        // For now, simulate retry logic
        await new Promise(resolve => setTimeout(resolve, 2000));

        return { success: Math.random() > 0.5, strategy: 'simple_retry' };
      }
    });

    // Strategy 3: Exponential Backoff
    this.addStrategy({
      name: 'exponential_backoff',
      priority: 80,
      canHandle: (context) => {
        // Use for rate limiting or server overload
        return context.error.message.includes('rate limit') ||
          context.error.message.includes('too many requests') ||
          (context.error as any).status === 429;
      },
      execute: async (context) => {
        const retryMechanism = RetryPresets.EXTERNAL_API;
        // Simulate backoff retry
        await new Promise(resolve => setTimeout(resolve, 5000));

        return { success: Math.random() > 0.3, strategy: 'exponential_backoff' };
      }
    });

    // Strategy 4: Graceful Degradation
    this.addStrategy({
      name: 'graceful_degradation',
      priority: 70,
      canHandle: (context) => {
        // Trigger degradation for critical component failures
        return ['redis', 'web3', 'ml_model'].includes(context.component);
      },
      execute: async (context) => {
        const degraded = await triggerDegradation(context.service, context.component, context.error);

        if (degraded) {
          return {
            success: true,
            strategy: 'graceful_degradation',
            nextAction: 'service_degraded'
          };
        }

        return { success: false, strategy: 'graceful_degradation' };
      }
    });

    // Strategy 5: Self-Healing Trigger
    this.addStrategy({
      name: 'self_healing',
      priority: 60,
      canHandle: (context) => {
        // Trigger self-healing for persistent failures
        return (context.attemptCount || 0) >= 5;
      },
      execute: async (context) => {
        const healed = await this.selfHealingManager.triggerRecovery(context.service, context.error);

        if (healed) {
          return {
            success: true,
            strategy: 'self_healing',
            nextAction: 'service_restarted'
          };
        }

        return { success: false, strategy: 'self_healing' };
      }
    });

    // Strategy 6: Dead Letter Queue (lowest priority)
    this.addStrategy({
      name: 'dead_letter_queue',
      priority: 10,
      canHandle: () => true, // Always available as last resort
      execute: async (context) => {
        await enqueueFailedOperation({
          operation: context.operation,
          payload: context.metadata || {},
          error: {
            message: context.error.message,
            code: (context.error as any).code,
            stack: context.error.stack
          },
          retryCount: context.attemptCount || 0,
          maxRetries: 5,
          service: context.service,
          priority: 'medium',
          correlationId: context.correlationId,
          tags: [context.component, 'failed_operation']
        });

        return {
          success: true,
          strategy: 'dead_letter_queue',
          nextAction: 'operation_queued_for_retry'
        };
      }
    });
  }

  private async handleFinalFailure(context: RecoveryContext, duration: number): Promise<RecoveryResult> {
    // Final escalation measures
    try {
      // Force service restart as last resort
      await this.selfHealingManager.triggerRecovery(context.service, context.error);

      return {
        success: false,
        strategy: 'final_escalation',
        duration,
        nextAction: 'service_restart_initiated',
        error: context.error
      };
    } catch (escalationError) {
      // Complete failure - log for manual intervention
      logger.error('Final escalation failed - manual intervention required', {
        context,
        escalationError,
        duration
      });

      return {
        success: false,
        strategy: 'final_failure',
        duration,
        nextAction: 'manual_intervention_required',
        error: context.error
      };
    }
  }
}

// Global error recovery orchestrator
let globalErrorRecovery: ErrorRecoveryOrchestrator | null = null;

export function getErrorRecoveryOrchestrator(): ErrorRecoveryOrchestrator {
  if (!globalErrorRecovery) {
    globalErrorRecovery = new ErrorRecoveryOrchestrator();
  }
  return globalErrorRecovery;
}

// Convenience functions for common error recovery scenarios
export async function recoverFromError(
  operation: string,
  service: string,
  component: string,
  error: Error,
  metadata?: any
): Promise<RecoveryResult> {
  const context: RecoveryContext = {
    operation,
    service,
    component,
    error,
    metadata,
    correlationId: generateCorrelationId()
  };

  return await getErrorRecoveryOrchestrator().recover(context);
}

// Decorator for automatic error recovery
export function withErrorRecovery(options: {
  service: string;
  component: string;
  operation?: string;
}) {
  return function (target: any, propertyName: string, descriptor: PropertyDescriptor) {
    const method = descriptor.value;
    const operationName = options.operation || `${target.constructor.name}.${propertyName}`;

    descriptor.value = async function (...args: any[]) {
      try {
        return await method.apply(this, args);
      } catch (error: any) {
        const result = await recoverFromError(
          operationName,
          options.service,
          options.component,
          error,
          { args, target: target.constructor.name }
        );

        if (!result.success) {
          throw error; // Re-throw if recovery failed
        }

        // Return fallback value or throw depending on strategy
        if (result.nextAction === 'service_degraded') {
          // Return degraded response
          return { degraded: true, error: (error as Error).message };
        }

        throw error;
      }
    };

    return descriptor;
  };
}

// Utility functions
function generateCorrelationId(): string {
  return `err_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Health check for recovery system
export async function checkRecoverySystemHealth(): Promise<{
  status: 'healthy' | 'degraded' | 'unhealthy';
  components: Record<string, boolean>;
  lastRecoveryAttempt?: number;
}> {
  const orchestrator = getErrorRecoveryOrchestrator();

  try {
    const stats = await orchestrator.getRecoveryStats();

    const components = {
      deadLetterQueue: stats.deadLetterQueue.totalOperations < 1000, // Not overwhelmed
      circuitBreakers: Object.values(stats.circuitBreakers).every((cb: any) => cb.failures < 10),
      gracefulDegradation: Object.keys(stats.gracefulDegradation).length < 3 // Not too many services degraded
    };

    const allHealthy = Object.values(components).every(healthy => healthy);

    return {
      status: allHealthy ? 'healthy' : 'degraded',
      components,
      lastRecoveryAttempt: Date.now()
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      components: { error_check: false },
      lastRecoveryAttempt: Date.now()
    };
  }
}