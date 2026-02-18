/**
 * Error Recovery Orchestrator Tests
 *
 * Tests for ErrorRecoveryOrchestrator including strategy selection,
 * retry execution with retryFn, DLQ fallback, and stats collection.
 *
 * @see shared/core/src/resilience/error-recovery.ts
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import {
  ErrorRecoveryOrchestrator,
  RecoveryContext,
  RecoveryResult,
} from '../../../src/resilience/error-recovery';

// Mock all external dependencies.
// clearMocks: true in jest.config.js wipes jest.fn() implementations between tests,
// so factories use bare jest.fn() and implementations are re-set in beforeEach.

jest.mock('../../../src/resilience/circuit-breaker', () => ({
  getCircuitBreakerRegistry: jest.fn(),
  CircuitBreakerError: class extends Error {},
}));

jest.mock('../../../src/resilience/dead-letter-queue', () => ({
  getDeadLetterQueue: jest.fn(),
  enqueueFailedOperation: jest.fn(),
}));

jest.mock('../../../src/resilience/graceful-degradation', () => ({
  getGracefulDegradationManager: jest.fn(),
  triggerDegradation: jest.fn(),
}));

jest.mock('../../../src/resilience/self-healing-manager', () => ({
  getSelfHealingManager: jest.fn(),
}));

// Retrieve mock modules
const cbMod = require('../../../src/resilience/circuit-breaker') as any;
const dlqMod = require('../../../src/resilience/dead-letter-queue') as any;
const gdMod = require('../../../src/resilience/graceful-degradation') as any;
const shMod = require('../../../src/resilience/self-healing-manager') as any;

// Shared mock functions used across beforeEach and individual tests
const mockGetBreaker = jest.fn();
const mockGetAllStats = jest.fn();

describe('ErrorRecoveryOrchestrator', () => {
  let orchestrator: ErrorRecoveryOrchestrator;

  const createContext = (overrides: Partial<RecoveryContext> = {}): RecoveryContext => ({
    operation: 'test_operation',
    service: 'test-service',
    component: 'test-component',
    error: new Error('Test error'),
    attemptCount: 0,
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();

    // Re-establish mock implementations after clearMocks wipes them.

    // Circuit breaker registry
    mockGetBreaker.mockReturnValue(null); // No circuit breaker by default
    mockGetAllStats.mockReturnValue({});
    cbMod.getCircuitBreakerRegistry.mockReturnValue({
      getBreaker: mockGetBreaker,
      getAllStats: mockGetAllStats,
    });

    // DLQ
    dlqMod.getDeadLetterQueue.mockReturnValue({
      enqueue: jest.fn(() => Promise.resolve('dlq_123')),
      getStats: jest.fn(() => Promise.resolve({
        totalOperations: 0,
        byPriority: {},
        byService: {},
        byTag: {},
        oldestOperation: 0,
        newestOperation: 0,
        averageRetries: 0,
      })),
    });
    dlqMod.enqueueFailedOperation.mockReturnValue(Promise.resolve('dlq_123'));

    // Graceful degradation
    gdMod.getGracefulDegradationManager.mockReturnValue({
      getAllDegradationStates: jest.fn(() => ({})),
    });
    gdMod.triggerDegradation.mockReturnValue(Promise.resolve(false));

    // Self-healing manager
    shMod.getSelfHealingManager.mockReturnValue(Promise.resolve({
      triggerRecovery: jest.fn(() => Promise.resolve(false)),
    }));

    orchestrator = new ErrorRecoveryOrchestrator();
  });

  describe('strategy selection', () => {
    it('should select simple_retry for transient connection errors', async () => {
      const context = createContext({
        error: new Error('ECONNRESET: connection lost'),
        attemptCount: 0,
      });

      const result = await orchestrator.recover(context);

      // simple_retry should be selected but fail (no retryFn)
      // Then DLQ should catch it as last resort
      expect(result.strategy).toBe('dead_letter_queue');
      expect(result.success).toBe(true);
    });

    it('should select exponential_backoff for rate limit errors', async () => {
      const retryFn = jest.fn(() => Promise.resolve());
      const context = createContext({
        error: new Error('rate limit exceeded'),
        retryFn: retryFn as () => Promise<unknown>,
      });

      const result = await orchestrator.recover(context);

      expect(result.success).toBe(true);
      expect(result.strategy).toBe('exponential_backoff');
      expect(retryFn).toHaveBeenCalledTimes(1);
    });

    it('should fall through to DLQ when all strategies fail', async () => {
      const context = createContext({
        error: new Error('unknown error type'),
        component: 'unknown-component',
        attemptCount: 0,
      });

      const result = await orchestrator.recover(context);

      expect(result.strategy).toBe('dead_letter_queue');
      expect(result.success).toBe(true);
      expect(result.nextAction).toBe('operation_queued_for_retry');
    });
  });

  describe('simple_retry strategy', () => {
    it('should succeed when retryFn is provided and succeeds', async () => {
      const retryFn = jest.fn(() => Promise.resolve());
      const context = createContext({
        error: new Error('ETIMEDOUT: connection timed out'),
        retryFn: retryFn as () => Promise<unknown>,
        attemptCount: 0,
      });

      const result = await orchestrator.recover(context);

      expect(result.success).toBe(true);
      expect(result.strategy).toBe('simple_retry');
      expect(retryFn).toHaveBeenCalledTimes(1);
    });

    it('should fall through when retryFn is not provided', async () => {
      const context = createContext({
        error: new Error('ECONNRESET: network error'),
        attemptCount: 0,
        // No retryFn
      });

      const result = await orchestrator.recover(context);

      // simple_retry returns failure (no retryFn), falls through to DLQ
      expect(result.strategy).toBe('dead_letter_queue');
    });

    it('should fall through when retryFn throws', async () => {
      const retryFn = jest.fn(() => Promise.reject(new Error('retry also failed')));
      const context = createContext({
        error: new Error('ETIMEDOUT: connection timed out'),
        retryFn: retryFn as () => Promise<unknown>,
        attemptCount: 0,
      });

      const result = await orchestrator.recover(context);

      // simple_retry failed, should fall through to DLQ
      expect(retryFn).toHaveBeenCalled();
      expect(result.strategy).toBe('dead_letter_queue');
    });

    it('should not be selected when attemptCount >= 3', async () => {
      const retryFn = jest.fn(() => Promise.resolve());
      const context = createContext({
        error: new Error('ECONNRESET'),
        retryFn: retryFn as () => Promise<unknown>,
        attemptCount: 3, // At limit
      });

      const result = await orchestrator.recover(context);

      // simple_retry canHandle returns false when attemptCount >= 3
      expect(retryFn).not.toHaveBeenCalled();
      expect(result.strategy).toBe('dead_letter_queue');
    });
  });

  describe('exponential_backoff strategy', () => {
    it('should succeed when retryFn succeeds after backoff', async () => {
      const retryFn = jest.fn(() => Promise.resolve());
      const context = createContext({
        error: new Error('too many requests'),
        retryFn: retryFn as () => Promise<unknown>,
        attemptCount: 0,
      });

      const result = await orchestrator.recover(context);

      expect(result.success).toBe(true);
      expect(result.strategy).toBe('exponential_backoff');
      expect(retryFn).toHaveBeenCalled();
    });

    it('should return needs_retryFn when no retryFn provided', async () => {
      const context = createContext({
        error: new Error('rate limit exceeded'),
        // No retryFn
      });

      const result = await orchestrator.recover(context);

      // exponential_backoff fails without retryFn, falls to DLQ
      expect(result.strategy).toBe('dead_letter_queue');
    });
  });

  describe('DLQ fallback strategy', () => {
    it('should always accept as last resort', async () => {
      const context = createContext({
        error: new Error('completely unknown error'),
        component: 'nonexistent',
      });

      const result = await orchestrator.recover(context);

      expect(result.success).toBe(true);
      expect(result.strategy).toBe('dead_letter_queue');
      expect(result.nextAction).toBe('operation_queued_for_retry');
    });
  });

  describe('circuit_breaker_check strategy', () => {
    it('should be selected when circuit breaker is OPEN', async () => {
      mockGetBreaker.mockReturnValue({
        getStats: () => ({ state: 'OPEN' }),
      });

      const context = createContext({
        error: new Error('service unavailable'),
      });

      const result = await orchestrator.recover(context);

      // Circuit breaker check returns failure, falls through to DLQ
      expect(result.success).toBe(true); // DLQ succeeds
    });
  });

  describe('custom strategies', () => {
    it('should allow adding custom strategies', async () => {
      const customStrategy = {
        name: 'custom_strategy',
        priority: 95, // Higher than simple_retry
        canHandle: (ctx: RecoveryContext) => ctx.error.message.includes('custom'),
        execute: async (): Promise<RecoveryResult> => ({
          success: true,
          strategy: 'custom_strategy',
          nextAction: 'custom_action',
        }),
      };

      orchestrator.addStrategy(customStrategy);

      const context = createContext({
        error: new Error('custom error type'),
      });

      const result = await orchestrator.recover(context);

      expect(result.success).toBe(true);
      expect(result.strategy).toBe('custom_strategy');
    });
  });

  describe('getRecoveryStats', () => {
    it('should aggregate stats from all subsystems', async () => {
      const stats = await orchestrator.getRecoveryStats();

      expect(stats).toHaveProperty('deadLetterQueue');
      expect(stats).toHaveProperty('circuitBreakers');
      expect(stats).toHaveProperty('gracefulDegradation');
      expect(stats).toHaveProperty('timestamp');
      expect(stats.timestamp).toBeGreaterThan(0);
    });
  });

  describe('recovery result', () => {
    it('should include duration in successful results', async () => {
      const retryFn = jest.fn(() => Promise.resolve());
      const context = createContext({
        error: new Error('ECONNRESET'),
        retryFn: retryFn as () => Promise<unknown>,
      });

      const result = await orchestrator.recover(context);

      expect(result.duration).toBeDefined();
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });
  });
});
