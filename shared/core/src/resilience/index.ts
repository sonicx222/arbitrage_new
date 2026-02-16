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
// P1-7 FIX: isRetryableError from retry-mechanism uses classifyError() heuristics;
// the primary isRetryableError (from error-handling.ts above) checks ArbitrageError codes.
// Renamed to isRetryableErrorCheck to avoid collision — use the error-handling version
// for ArbitrageError subclasses, and isRetryableErrorCheck for general error classification.
export {
  RetryMechanism,
  RetryPresets,
  withRetry,
  retry,
  retryAdvanced,
  ErrorCategory,
  classifyError,
  isRetryableError as isRetryableErrorCheck,
  retryWithLogging
} from './retry-mechanism';
export type {
  RetryLogger,
  RetryWithLoggingConfig
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
// S4.1.3-FIX (Option A): Re-export DegradationLevel enum for unified access
export {
  GracefulDegradationManager,
  getGracefulDegradationManager,
  resetGracefulDegradationManager,  // S4.1.3-FIX: Export reset for testing
  triggerDegradation,
  isFeatureEnabled,
  getCapabilityFallback,
  DegradationLevel  // S4.1.3-FIX: Re-export canonical enum from cross-region-health
} from './graceful-degradation';
export type {
  DegradationLevelConfig,  // S4.1.3-FIX: Export renamed config interface
  ServiceCapability,
  DegradationState
} from './graceful-degradation';

// Self-Healing Manager
export {
  SelfHealingManager,
  getSelfHealingManager,
  registerServiceForSelfHealing
} from './self-healing-manager';

// Expert Self-Healing Manager
// P1-14 FIX: Rename RecoveryStrategy to RecoveryStrategyEnum to avoid shadowing
// the RecoveryStrategy interface from error-recovery.ts and self-healing-manager.ts
export {
  ExpertSelfHealingManager,
  getExpertSelfHealingManager,
  resetExpertSelfHealingManager,  // P2-22 FIX: Export reset for test cleanup
  FailureSeverity,
  RecoveryStrategy as RecoveryStrategyEnum
} from './expert-self-healing-manager';

// Dual-Publish Utility (P2-17 FIX)
export { dualPublish } from './dual-publish';

// Error Recovery Orchestrator
export {
  ErrorRecoveryOrchestrator,
  getErrorRecoveryOrchestrator,
  recoverFromError,
  withErrorRecovery
} from './error-recovery';
export type { RecoveryStats } from './error-recovery';  // P3-34 FIX
export type { FailureStatistics } from './expert-self-healing-manager';  // P3-33 FIX
