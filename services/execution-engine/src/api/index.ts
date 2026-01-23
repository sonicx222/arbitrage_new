/**
 * API Module Exports
 *
 * Exports API handlers for the execution engine health server.
 */

export {
  createCircuitBreakerApiHandler,
  isCircuitBreakerRoute,
  type CircuitBreakerEngineInterface,
} from './circuit-breaker-api';
