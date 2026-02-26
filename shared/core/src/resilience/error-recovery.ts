// Comprehensive Error Recovery System
// Integrates circuit breakers, retries, dead letter queues, and graceful degradation

import { createLogger } from '../logger';
import { getCircuitBreakerRegistry, CircuitBreakerError } from './circuit-breaker';
import { getDeadLetterQueue, enqueueFailedOperation } from './dead-letter-queue';
import { getGracefulDegradationManager, triggerDegradation } from './graceful-degradation';
// P0-3 FIX: Removed unused RetryMechanism/RetryPresets imports (simulated retry logic removed)
import { getSelfHealingManager } from './self-healing-manager';

const logger = createLogger('error-recovery');

export interface RecoveryContext {
  operation: string;
  service: string;
  component: string;
  error: Error;
  metadata?: Record<string, unknown>;
  correlationId?: string;
  attemptCount?: number;
  /** Optional callable to retry the failed operation. When provided, retry strategies will invoke it. */
  retryFn?: () => Promise<unknown>;
}

export interface RecoveryResult {
  success: boolean;
  strategy: string;
  duration?: number;
  nextAction?: string;
  error?: Error;
}

// P3-34 FIX: Typed return for getRecoveryStats()
export interface RecoveryStats {
  deadLetterQueue: Record<string, unknown>;
  circuitBreakers: Record<string, unknown>;
  gracefulDegradation: Record<string, unknown>;
  timestamp: number;
}

export interface RecoveryStrategy {
  name: string;
  priority: number;
  canHandle: (context: RecoveryContext) => boolean;
  execute: (context: RecoveryContext) => Promise<RecoveryResult>;
}

export class ErrorRecoveryOrchestrator {
  private strategies: RecoveryStrategy[] = [];
  // P1-11 FIX: Lazy initialization to avoid eagerly constructing all singletons
  // on import. Singletons are created on first use via getters.
  private _circuitBreakers?: ReturnType<typeof getCircuitBreakerRegistry>;
  private _dlq?: ReturnType<typeof getDeadLetterQueue>;
  private _degradationManager?: ReturnType<typeof getGracefulDegradationManager>;
  private _selfHealingManagerPromise?: ReturnType<typeof getSelfHealingManager>;

  private get circuitBreakers() {
    if (!this._circuitBreakers) this._circuitBreakers = getCircuitBreakerRegistry();
    return this._circuitBreakers;
  }
  private get dlq() {
    if (!this._dlq) this._dlq = getDeadLetterQueue();
    return this._dlq;
  }
  private get degradationManager() {
    if (!this._degradationManager) this._degradationManager = getGracefulDegradationManager();
    return this._degradationManager;
  }
  private get selfHealingManagerPromise() {
    if (!this._selfHealingManagerPromise) this._selfHealingManagerPromise = getSelfHealingManager();
    return this._selfHealingManagerPromise;
  }

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

  // P3-34 FIX: Typed return value
  async getRecoveryStats(): Promise<RecoveryStats> {
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
          (context.attemptCount ?? 0) < 3;
      },
      execute: async (context) => {
        if (!context.retryFn) {
          logger.warn('simple_retry: no retryFn provided, cannot retry operation', {
            operation: context.operation,
            service: context.service
          });
          return { success: false, strategy: 'simple_retry', nextAction: 'needs_retryFn' };
        }
        try {
          await context.retryFn();
          return { success: true, strategy: 'simple_retry' };
        } catch (retryError) {
          logger.warn('simple_retry failed', {
            operation: context.operation,
            error: (retryError as Error).message
          });
          return { success: false, strategy: 'simple_retry', error: retryError as Error };
        }
      }
    });

    // Strategy 3: Exponential Backoff
    this.addStrategy({
      name: 'exponential_backoff',
      priority: 80,
      canHandle: (context) => {
        // Use for rate limiting or server overload
        const status = (context.error as { status?: number }).status;
        return context.error.message.includes('rate limit') ||
          context.error.message.includes('too many requests') ||
          status === 429;
      },
      execute: async (context) => {
        if (!context.retryFn) {
          logger.warn('exponential_backoff: no retryFn provided, cannot retry operation', {
            operation: context.operation,
            service: context.service
          });
          return { success: false, strategy: 'exponential_backoff', nextAction: 'needs_retryFn' };
        }
        const delay = Math.min(1000 * Math.pow(2, context.attemptCount ?? 0), 30000);
        await new Promise(resolve => setTimeout(resolve, delay));
        try {
          await context.retryFn();
          return { success: true, strategy: 'exponential_backoff' };
        } catch (retryError) {
          logger.warn('exponential_backoff retry failed', {
            operation: context.operation,
            attempt: context.attemptCount,
            error: (retryError as Error).message
          });
          return { success: false, strategy: 'exponential_backoff', error: retryError as Error };
        }
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
        return (context.attemptCount ?? 0) >= 5;
      },
      execute: async (context) => {
        // P3-1 FIX: Await the promise to get the manager instance
        const manager = await this.selfHealingManagerPromise;
        const healed = await manager.triggerRecovery(context.service, context.error);

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
          payload: context.metadata ?? {},
          error: {
            message: context.error.message,
            code: (context.error as { code?: string }).code,
            stack: context.error.stack
          },
          retryCount: context.attemptCount ?? 0,
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
      // P3-1 FIX: Await the promise to get the manager instance
      const manager = await this.selfHealingManagerPromise;
      await manager.triggerRecovery(context.service, context.error);

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
  metadata?: Record<string, unknown>
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
  return function (target: unknown, propertyName: string, descriptor: PropertyDescriptor) {
    const method = descriptor.value;
    const operationName = options.operation || `${(target as { constructor: { name: string } }).constructor.name}.${propertyName}`;

    descriptor.value = async function (...args: unknown[]) {
      try {
        return await method.apply(this, args);
      } catch (error) {
        const errorObj = error instanceof Error ? error : new Error(String(error));
        const result = await recoverFromError(
          operationName,
          options.service,
          options.component,
          errorObj,
          { args, target: (target as { constructor: { name: string } }).constructor.name }
        );

        if (!result.success) {
          throw error; // Re-throw if recovery failed
        }

        // Return fallback value or throw depending on strategy
        if (result.nextAction === 'service_degraded') {
          // Return degraded response
          return { degraded: true, error: errorObj.message };
        }

        throw error;
      }
    };

    return descriptor;
  };
}

// Utility functions
function generateCorrelationId(): string {
  return `err_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
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
      deadLetterQueue: ((stats.deadLetterQueue as { totalOperations?: number }).totalOperations ?? 0) < 1000, // Not overwhelmed
      circuitBreakers: Object.values(stats.circuitBreakers).every((cb) => ((cb as { failures?: number }).failures ?? 0) < 10),
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