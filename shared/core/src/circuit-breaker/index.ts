/**
 * Circuit Breaker Module
 *
 * Exports simple circuit breaker for shared use across services.
 *
 * For basic failure tracking:
 * @see SimpleCircuitBreaker - Lightweight, for coordinator/detector use cases
 *
 * For full circuit breaker pattern (CLOSED/OPEN/HALF_OPEN with metrics):
 * @see services/execution-engine/src/services/circuit-breaker.ts
 */

export {
  SimpleCircuitBreaker,
  createSimpleCircuitBreaker,
  type SimpleCircuitBreakerOptions,
  type SimpleCircuitBreakerStatus,
} from './simple-circuit-breaker';
