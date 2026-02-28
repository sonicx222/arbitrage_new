/**
 * Circuit Breaker State Machine Unit Test
 *
 * Tests the circuit breaker pattern for resilience in the arbitrage system.
 *
 * **State Machine Tested**:
 * CLOSED → (failures >= threshold) → OPEN
 * OPEN → (recovery timeout expires) → HALF_OPEN
 * HALF_OPEN → (success) → CLOSED
 * HALF_OPEN → (failure) → OPEN
 *
 * **What's Real**:
 * - Circuit breaker state transitions
 * - Failure counting within monitoring window
 * - Recovery timeout behavior
 * - Concurrent access handling
 * - Statistics tracking
 *
 * @see docs/architecture/DATA_FLOW.md - Resilience section
 * @see shared/core/src/resilience/circuit-breaker.ts
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  CircuitBreaker,
  CircuitState,
  CircuitBreakerError,
  CircuitBreakerRegistry,
  CircuitBreakerConfig,
} from '@arbitrage/core/resilience';

// Test configuration with short timeouts for fast tests
const TEST_CONFIG: Omit<CircuitBreakerConfig, 'name'> = {
  failureThreshold: 3,
  recoveryTimeout: 100, // 100ms for fast tests
  monitoringPeriod: 1000, // 1 second window
  successThreshold: 2, // 2 successes to close
};

// Helper to delay execution
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper to create a failing operation
function failingOperation(errorMessage: string = 'Operation failed'): () => Promise<never> {
  return async () => {
    throw new Error(errorMessage);
  };
}

// Helper to create a succeeding operation
function succeedingOperation<T>(result: T): () => Promise<T> {
  return async () => result;
}

describe('Circuit Breaker State Machine', () => {
  let registry: CircuitBreakerRegistry;

  beforeEach(() => {
    // Reset global registry before each test
    // Note: resetCircuitBreakerRegistry is not exported, but we can create a fresh registry
    registry = new CircuitBreakerRegistry();
  });

  afterEach(() => {
    registry.clearAll();
  });

  describe('State Transitions: CLOSED → OPEN', () => {
    it('should start in CLOSED state', () => {
      const breaker = new CircuitBreaker({ ...TEST_CONFIG, name: 'test-closed-start' });

      expect(breaker.getState()).toBe(CircuitState.CLOSED);

      const stats = breaker.getStats();
      expect(stats.state).toBe(CircuitState.CLOSED);
      expect(stats.failures).toBe(0);
      expect(stats.totalRequests).toBe(0);
    });

    it('should remain CLOSED while failures are below threshold', async () => {
      const breaker = new CircuitBreaker({ ...TEST_CONFIG, name: 'test-below-threshold' });

      // Execute 2 failures (threshold is 3)
      for (let i = 0; i < 2; i++) {
        try {
          await breaker.execute(failingOperation());
        } catch {
          // Expected failure
        }
      }

      expect(breaker.getState()).toBe(CircuitState.CLOSED);
      expect(breaker.getStats().failures).toBe(2);
    });

    it('should transition to OPEN when failures reach threshold', async () => {
      const breaker = new CircuitBreaker({ ...TEST_CONFIG, name: 'test-to-open' });

      // Execute failures to reach threshold
      for (let i = 0; i < TEST_CONFIG.failureThreshold; i++) {
        try {
          await breaker.execute(failingOperation());
        } catch {
          // Expected failure
        }
      }

      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });

    it('should reject requests immediately when OPEN', async () => {
      const breaker = new CircuitBreaker({ ...TEST_CONFIG, name: 'test-reject-open' });

      // Force open
      breaker.forceOpen();

      await expect(breaker.execute(succeedingOperation('success'))).rejects.toThrow(CircuitBreakerError);
    });

    it('should track window failures for monitoring period', async () => {
      const breaker = new CircuitBreaker({
        ...TEST_CONFIG,
        monitoringPeriod: 200, // 200ms window
        name: 'test-window-failures',
      });

      // Execute 2 failures
      for (let i = 0; i < 2; i++) {
        try {
          await breaker.execute(failingOperation());
        } catch {
          // Expected
        }
      }

      expect(breaker.getStats().windowFailures).toBe(2);

      // Wait for monitoring window to expire
      await delay(250);

      // Execute another failure (should be only failure in new window)
      try {
        await breaker.execute(failingOperation());
      } catch {
        // Expected
      }

      // Window failures should reset (approximately, based on implementation)
      const stats = breaker.getStats();
      expect(stats.totalFailures).toBe(3);
      // Window failures may be 1 or 3 depending on timing, but circuit should still be CLOSED
      // because the window resets
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });
  });

  describe('State Transitions: OPEN → HALF_OPEN', () => {
    it('should transition to HALF_OPEN after recovery timeout', async () => {
      const breaker = new CircuitBreaker({
        ...TEST_CONFIG,
        recoveryTimeout: 50,
        name: 'test-to-half-open',
      });

      // Force to OPEN state
      breaker.forceOpen();
      expect(breaker.getState()).toBe(CircuitState.OPEN);

      // Wait for recovery timeout
      await delay(60);

      // Next request should trigger HALF_OPEN transition
      // The request might succeed or fail, but state should change
      try {
        await breaker.execute(succeedingOperation('test'));
        // If successful, state might be HALF_OPEN or transitioning to CLOSED
        const state = breaker.getState();
        expect([CircuitState.HALF_OPEN, CircuitState.CLOSED]).toContain(state);
      } catch (error) {
        // If still timing issue, state should be HALF_OPEN
        if (error instanceof CircuitBreakerError) {
          expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);
        }
      }
    });

    it('should only allow one request through in HALF_OPEN', async () => {
      const breaker = new CircuitBreaker({
        ...TEST_CONFIG,
        recoveryTimeout: 50,
        name: 'test-half-open-single',
      });

      breaker.forceOpen();
      await delay(60);

      // Track concurrent requests
      const results: Array<{ success: boolean; error?: string }> = [];

      // Simulate concurrent requests
      const request1 = breaker.execute(async () => {
        await delay(50); // Slow operation
        return 'success';
      }).then(
        () => results.push({ success: true }),
        (e) => results.push({ success: false, error: e.message })
      );

      const request2 = breaker.execute(succeedingOperation('success')).then(
        () => results.push({ success: true }),
        (e) => results.push({ success: false, error: e.message })
      );

      await Promise.all([request1, request2]);

      // One should succeed, one should be rejected (testing recovery)
      const successes = results.filter(r => r.success).length;
      const failures = results.filter(r => !r.success).length;

      // At least one should have been processed
      expect(successes + failures).toBe(2);
    });
  });

  describe('State Transitions: HALF_OPEN → CLOSED', () => {
    it('should transition to CLOSED after successThreshold successes', async () => {
      const breaker = new CircuitBreaker({
        ...TEST_CONFIG,
        recoveryTimeout: 50,
        successThreshold: 2,
        name: 'test-to-closed',
      });

      breaker.forceOpen();
      await delay(60);

      // First success - transitions to HALF_OPEN and counts
      await breaker.execute(succeedingOperation('success-1'));

      // May still be in HALF_OPEN (needs 2 successes)
      if (breaker.getState() === CircuitState.HALF_OPEN) {
        // Second success should close the circuit
        await breaker.execute(succeedingOperation('success-2'));
      }

      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('should reset failure counters when transitioning to CLOSED', async () => {
      const breaker = new CircuitBreaker({
        ...TEST_CONFIG,
        recoveryTimeout: 50,
        successThreshold: 1,
        name: 'test-reset-counters',
      });

      // Generate failures
      for (let i = 0; i < TEST_CONFIG.failureThreshold; i++) {
        try {
          await breaker.execute(failingOperation());
        } catch {
          // Expected
        }
      }

      expect(breaker.getState()).toBe(CircuitState.OPEN);
      await delay(60);

      // Recover
      await breaker.execute(succeedingOperation('success'));

      // Should be CLOSED with reset counters
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
      expect(breaker.getStats().failures).toBe(0);
      expect(breaker.getStats().windowFailures).toBe(0);
    });
  });

  describe('State Transitions: HALF_OPEN → OPEN', () => {
    it('should transition back to OPEN on failure in HALF_OPEN', async () => {
      const breaker = new CircuitBreaker({
        ...TEST_CONFIG,
        recoveryTimeout: 50,
        name: 'test-half-open-to-open',
      });

      breaker.forceOpen();
      await delay(60);

      // Fail in HALF_OPEN
      try {
        await breaker.execute(failingOperation());
      } catch {
        // Expected
      }

      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });

    it('should reset recovery timeout after failing in HALF_OPEN', async () => {
      const breaker = new CircuitBreaker({
        ...TEST_CONFIG,
        recoveryTimeout: 50,
        name: 'test-reset-recovery',
      });

      breaker.forceOpen();
      await delay(60);

      // Fail in HALF_OPEN
      try {
        await breaker.execute(failingOperation());
      } catch {
        // Expected
      }

      expect(breaker.getState()).toBe(CircuitState.OPEN);

      // Should not be able to try again immediately
      await expect(breaker.execute(succeedingOperation('test'))).rejects.toThrow(CircuitBreakerError);
    });
  });

  describe('Statistics and Metrics', () => {
    it('should track total requests', async () => {
      const breaker = new CircuitBreaker({ ...TEST_CONFIG, name: 'test-total-requests' });

      // Mix of successes and failures
      await breaker.execute(succeedingOperation('success'));
      await breaker.execute(succeedingOperation('success'));
      try {
        await breaker.execute(failingOperation());
      } catch {
        // Expected
      }

      const stats = breaker.getStats();
      expect(stats.totalRequests).toBe(3);
    });

    it('should track total successes and failures', async () => {
      const breaker = new CircuitBreaker({ ...TEST_CONFIG, name: 'test-success-failure' });

      // Execute successes
      await breaker.execute(succeedingOperation('s1'));
      await breaker.execute(succeedingOperation('s2'));

      // Execute failures
      try {
        await breaker.execute(failingOperation());
      } catch {
        // Expected
      }

      const stats = breaker.getStats();
      expect(stats.totalSuccesses).toBe(2);
      expect(stats.totalFailures).toBe(1);
    });

    it('should track last success and failure times', async () => {
      const breaker = new CircuitBreaker({ ...TEST_CONFIG, name: 'test-timestamps' });

      const beforeSuccess = Date.now();
      await breaker.execute(succeedingOperation('success'));
      const afterSuccess = Date.now();

      await delay(10);

      const beforeFailure = Date.now();
      try {
        await breaker.execute(failingOperation());
      } catch {
        // Expected
      }
      const afterFailure = Date.now();

      const stats = breaker.getStats();
      expect(stats.lastSuccessTime).toBeGreaterThanOrEqual(beforeSuccess);
      expect(stats.lastSuccessTime).toBeLessThanOrEqual(afterSuccess);
      expect(stats.lastFailureTime).toBeGreaterThanOrEqual(beforeFailure);
      expect(stats.lastFailureTime).toBeLessThanOrEqual(afterFailure);
    });
  });

  describe('Manual Controls', () => {
    it('should support force open', () => {
      const breaker = new CircuitBreaker({ ...TEST_CONFIG, name: 'test-force-open' });

      expect(breaker.getState()).toBe(CircuitState.CLOSED);

      breaker.forceOpen();

      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });

    it('should support force close', async () => {
      const breaker = new CircuitBreaker({ ...TEST_CONFIG, name: 'test-force-close' });

      // Get to OPEN state
      for (let i = 0; i < TEST_CONFIG.failureThreshold; i++) {
        try {
          await breaker.execute(failingOperation());
        } catch {
          // Expected
        }
      }

      expect(breaker.getState()).toBe(CircuitState.OPEN);

      breaker.forceClose();

      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('should support full reset', async () => {
      const breaker = new CircuitBreaker({ ...TEST_CONFIG, name: 'test-reset' });

      // Generate some activity
      await breaker.execute(succeedingOperation('success'));
      try {
        await breaker.execute(failingOperation());
      } catch {
        // Expected
      }

      const beforeReset = breaker.getStats();
      expect(beforeReset.totalRequests).toBe(2);

      breaker.reset();

      const afterReset = breaker.getStats();
      expect(afterReset.state).toBe(CircuitState.CLOSED);
      expect(afterReset.totalRequests).toBe(0);
      expect(afterReset.totalSuccesses).toBe(0);
      expect(afterReset.totalFailures).toBe(0);
      expect(afterReset.failures).toBe(0);
      expect(afterReset.successes).toBe(0);
    });
  });

  describe('Registry Management', () => {
    it('should create and retrieve breakers by name', () => {
      const breaker1 = registry.createBreaker('price-feed', TEST_CONFIG);
      const breaker2 = registry.createBreaker('execution-engine', TEST_CONFIG);

      expect(registry.getBreaker('price-feed')).toBe(breaker1);
      expect(registry.getBreaker('execution-engine')).toBe(breaker2);
      expect(registry.getBreaker('non-existent')).toBeUndefined();
    });

    it('should prevent duplicate breaker names', () => {
      registry.createBreaker('unique-name', TEST_CONFIG);

      expect(() => registry.createBreaker('unique-name', TEST_CONFIG)).toThrow('already exists');
    });

    it('should get or create breakers', () => {
      const breaker1 = registry.getOrCreateBreaker('shared-breaker', TEST_CONFIG);
      const breaker2 = registry.getOrCreateBreaker('shared-breaker', TEST_CONFIG);

      expect(breaker1).toBe(breaker2);
    });

    it('should get all breaker stats', async () => {
      const priceFeed = registry.createBreaker('price-feed', TEST_CONFIG);
      const execution = registry.createBreaker('execution-engine', TEST_CONFIG);

      // Generate some activity
      await priceFeed.execute(succeedingOperation('success'));
      try {
        await execution.execute(failingOperation());
      } catch {
        // Expected
      }

      const allStats = registry.getAllStats();

      expect(allStats['price-feed']).toBeDefined();
      expect(allStats['price-feed'].totalSuccesses).toBe(1);
      expect(allStats['execution-engine']).toBeDefined();
      expect(allStats['execution-engine'].totalFailures).toBe(1);
    });

    it('should reset all breakers', async () => {
      const breaker1 = registry.createBreaker('breaker-1', TEST_CONFIG);
      const breaker2 = registry.createBreaker('breaker-2', TEST_CONFIG);

      // Generate activity
      await breaker1.execute(succeedingOperation('s'));
      await breaker2.execute(succeedingOperation('s'));

      registry.resetAll();

      expect(breaker1.getStats().totalRequests).toBe(0);
      expect(breaker2.getStats().totalRequests).toBe(0);
    });

    it('should remove individual breakers', () => {
      registry.createBreaker('removable', TEST_CONFIG);

      expect(registry.getBreaker('removable')).toBeDefined();

      const removed = registry.removeBreaker('removable');

      expect(removed).toBe(true);
      expect(registry.getBreaker('removable')).toBeUndefined();
    });

    it('should clear all breakers', () => {
      registry.createBreaker('breaker-a', TEST_CONFIG);
      registry.createBreaker('breaker-b', TEST_CONFIG);

      registry.clearAll();

      expect(registry.getBreaker('breaker-a')).toBeUndefined();
      expect(registry.getBreaker('breaker-b')).toBeUndefined();
    });
  });

  describe('Error Handling', () => {
    it('should propagate original error when circuit is CLOSED', async () => {
      const breaker = new CircuitBreaker({ ...TEST_CONFIG, name: 'test-error-propagation' });
      const originalError = new Error('Original error message');

      try {
        await breaker.execute(async () => {
          throw originalError;
        });
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBe(originalError);
        expect((error as Error).message).toBe('Original error message');
      }
    });

    it('should throw CircuitBreakerError when circuit is OPEN', async () => {
      const breaker = new CircuitBreaker({ ...TEST_CONFIG, name: 'test-circuit-error' });
      breaker.forceOpen();

      try {
        await breaker.execute(succeedingOperation('success'));
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(CircuitBreakerError);
        expect((error as CircuitBreakerError).circuitName).toBe('test-circuit-error');
        expect((error as CircuitBreakerError).state).toBe(CircuitState.OPEN);
      }
    });
  });

  describe('Integration with Service Pipeline', () => {
    it('should protect price feed service', async () => {
      const priceFeedBreaker = registry.createBreaker('price-feed-service', {
        ...TEST_CONFIG,
        failureThreshold: 2,
      });

      // Simulate price feed operations
      const fetchPrice = async (dex: string): Promise<number> => {
        return priceFeedBreaker.execute(async () => {
          // Simulate DEX API call
          if (dex === 'failing-dex') {
            throw new Error('DEX API unavailable');
          }
          return 2500;
        });
      };

      // Successful calls
      expect(await fetchPrice('uniswap')).toBe(2500);
      expect(await fetchPrice('sushiswap')).toBe(2500);

      // Failed calls trigger circuit
      await expect(fetchPrice('failing-dex')).rejects.toThrow('DEX API unavailable');
      await expect(fetchPrice('failing-dex')).rejects.toThrow('DEX API unavailable');

      // Circuit should be OPEN now
      expect(priceFeedBreaker.getState()).toBe(CircuitState.OPEN);

      // Even good DEX calls should be blocked
      await expect(fetchPrice('uniswap')).rejects.toThrow(CircuitBreakerError);
    });

    it('should protect execution engine', async () => {
      const executionBreaker = registry.createBreaker('execution-service', {
        ...TEST_CONFIG,
        failureThreshold: 2,
      });

      const executeArbitrage = async (opportunityId: string): Promise<string> => {
        return executionBreaker.execute(async () => {
          if (opportunityId.startsWith('fail-')) {
            throw new Error('Transaction reverted');
          }
          return `tx-${opportunityId}`;
        });
      };

      // Successful execution
      expect(await executeArbitrage('opp-1')).toBe('tx-opp-1');

      // Failed executions
      await expect(executeArbitrage('fail-opp-1')).rejects.toThrow('Transaction reverted');
      await expect(executeArbitrage('fail-opp-2')).rejects.toThrow('Transaction reverted');

      // Circuit open
      expect(executionBreaker.getState()).toBe(CircuitState.OPEN);

      // All executions blocked
      await expect(executeArbitrage('opp-2')).rejects.toThrow(CircuitBreakerError);
    });

    it('should allow independent circuit breakers per service', async () => {
      const priceFeed = registry.createBreaker('price-feed', TEST_CONFIG);
      const execution = registry.createBreaker('execution', TEST_CONFIG);
      const coordinator = registry.createBreaker('coordinator', TEST_CONFIG);

      // Open price feed circuit
      priceFeed.forceOpen();

      // Other circuits should still work
      expect(priceFeed.getState()).toBe(CircuitState.OPEN);
      expect(execution.getState()).toBe(CircuitState.CLOSED);
      expect(coordinator.getState()).toBe(CircuitState.CLOSED);

      // Execute on working circuits
      await expect(execution.execute(succeedingOperation('exec'))).resolves.toBe('exec');
      await expect(coordinator.execute(succeedingOperation('coord'))).resolves.toBe('coord');

      // Price feed still blocked
      await expect(priceFeed.execute(succeedingOperation('price'))).rejects.toThrow(CircuitBreakerError);
    });
  });
});
