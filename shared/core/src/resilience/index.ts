/**
 * Resilience Module
 *
 * Error handling and recovery utilities including:
 * - Error handling: Standardized error classes and utilities (REF-3/ARCH-2)
 * - Retry mechanism: Retry with exponential backoff
 * - Circuit breaker: Fault isolation pattern
 * - Dead letter queue: Failed event handling
 * - Graceful degradation: Feature fallback management
 * - Self-healing: Service recovery automation
 *
 * @module resilience
 */

// Error Handling (REF-3/ARCH-2)
export {
  ArbitrageError,
  ConnectionError,
  ValidationError,
  LifecycleError,
  ExecutionError,
  ErrorCode,
  ErrorSeverity,
  success,
  failure,
  tryCatch,
  tryCatchSync,
  isRetryableError,
  isCriticalError,
  getErrorSeverity,
  getErrorMessage,
  formatErrorForLog,
  formatErrorForResponse,
  ErrorAggregator
} from './error-handling';
export type { Result } from './error-handling';

// Retry Mechanism
export {
  RetryMechanism,
  RetryPresets,
  withRetry,
  retry,
  retryAdvanced,
  ErrorCategory,
  classifyError,
  isRetryableError as isRetryableErrorCheck
} from './retry-mechanism';

// Circuit Breaker
export {
  CircuitBreaker,
  CircuitBreakerError,
  CircuitBreakerRegistry,
  createCircuitBreaker,
  getCircuitBreakerRegistry,
  withCircuitBreaker,
  CircuitState
} from './circuit-breaker';
export type {
  CircuitBreakerConfig,
  CircuitBreakerStats
} from './circuit-breaker';

// Dead Letter Queue
export {
  DeadLetterQueue,
  getDeadLetterQueue,
  enqueueFailedOperation
} from './dead-letter-queue';

// Graceful Degradation
export {
  GracefulDegradationManager,
  getGracefulDegradationManager,
  triggerDegradation,
  isFeatureEnabled,
  getCapabilityFallback
} from './graceful-degradation';

// Self-Healing Manager
export {
  SelfHealingManager,
  getSelfHealingManager,
  registerServiceForSelfHealing
} from './self-healing-manager';

// Expert Self-Healing Manager
export {
  ExpertSelfHealingManager,
  getExpertSelfHealingManager,
  FailureSeverity,
  RecoveryStrategy
} from './expert-self-healing-manager';

// Error Recovery Orchestrator
export {
  ErrorRecoveryOrchestrator,
  getErrorRecoveryOrchestrator,
  recoverFromError,
  withErrorRecovery
} from './error-recovery';
