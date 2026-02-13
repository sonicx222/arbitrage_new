/**
 * Simple Circuit Breaker Tests
 *
 * Tests for the lightweight circuit breaker implementation.
 */

import {
  SimpleCircuitBreaker,
  createSimpleCircuitBreaker,
} from '../../../src/circuit-breaker/simple-circuit-breaker';

describe('SimpleCircuitBreaker', () => {
  let circuitBreaker: SimpleCircuitBreaker;

  beforeEach(() => {
    jest.useFakeTimers();
    circuitBreaker = new SimpleCircuitBreaker(5, 60000);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('constructor', () => {
    it('should initialize with default values', () => {
      const breaker = new SimpleCircuitBreaker();
      const status = breaker.getStatus();

      expect(status.failures).toBe(0);
      expect(status.isOpen).toBe(false);
      expect(status.threshold).toBe(5);
      expect(status.resetTimeoutMs).toBe(60000);
    });

    it('should accept custom threshold and timeout', () => {
      const breaker = new SimpleCircuitBreaker(3, 30000);
      const status = breaker.getStatus();

      expect(status.threshold).toBe(3);
      expect(status.resetTimeoutMs).toBe(30000);
    });

    it('should throw for invalid threshold', () => {
      expect(() => new SimpleCircuitBreaker(0, 60000)).toThrow(
        'threshold must be at least 1'
      );
    });

    it('should throw for negative timeout', () => {
      expect(() => new SimpleCircuitBreaker(5, -1)).toThrow(
        'resetTimeoutMs must be non-negative'
      );
    });
  });

  describe('isCurrentlyOpen', () => {
    it('should return false when circuit is closed', () => {
      expect(circuitBreaker.isCurrentlyOpen()).toBe(false);
    });

    it('should return true when circuit is open and within cooldown', () => {
      // Trip the circuit
      for (let i = 0; i < 5; i++) {
        circuitBreaker.recordFailure();
      }

      expect(circuitBreaker.isCurrentlyOpen()).toBe(true);
    });

    it('should return false when cooldown has expired', () => {
      // Trip the circuit
      for (let i = 0; i < 5; i++) {
        circuitBreaker.recordFailure();
      }

      // Advance past cooldown
      jest.advanceTimersByTime(60001);

      expect(circuitBreaker.isCurrentlyOpen()).toBe(false);
    });
  });

  describe('recordFailure', () => {
    it('should increment failure count', () => {
      circuitBreaker.recordFailure();
      expect(circuitBreaker.getFailures()).toBe(1);

      circuitBreaker.recordFailure();
      expect(circuitBreaker.getFailures()).toBe(2);
    });

    it('should return false when circuit remains closed', () => {
      for (let i = 0; i < 4; i++) {
        expect(circuitBreaker.recordFailure()).toBe(false);
      }
    });

    it('should return true when circuit trips open', () => {
      for (let i = 0; i < 4; i++) {
        circuitBreaker.recordFailure();
      }

      // This should trip the circuit (5th failure)
      expect(circuitBreaker.recordFailure()).toBe(true);
    });

    it('should return false for subsequent failures after tripping', () => {
      // Trip the circuit
      for (let i = 0; i < 5; i++) {
        circuitBreaker.recordFailure();
      }

      // Additional failures should not "re-trip"
      expect(circuitBreaker.recordFailure()).toBe(false);
      expect(circuitBreaker.recordFailure()).toBe(false);
    });

    it('should update lastFailure timestamp', () => {
      const before = Date.now();
      circuitBreaker.recordFailure();
      const status = circuitBreaker.getStatus();

      expect(status.lastFailure).toBeGreaterThanOrEqual(before);
    });
  });

  describe('recordSuccess', () => {
    it('should reset failure count', () => {
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      expect(circuitBreaker.getFailures()).toBe(2);

      circuitBreaker.recordSuccess();
      expect(circuitBreaker.getFailures()).toBe(0);
    });

    it('should return false when circuit was already closed', () => {
      circuitBreaker.recordFailure();
      expect(circuitBreaker.recordSuccess()).toBe(false);
    });

    it('should return true when circuit was open (recovered)', () => {
      // Trip the circuit
      for (let i = 0; i < 5; i++) {
        circuitBreaker.recordFailure();
      }
      expect(circuitBreaker.getStatus().isOpen).toBe(true);

      // Advance past cooldown
      jest.advanceTimersByTime(60001);

      // Record success should recover
      expect(circuitBreaker.recordSuccess()).toBe(true);
      expect(circuitBreaker.getStatus().isOpen).toBe(false);
    });

    it('should close circuit after recovery', () => {
      // Trip and wait for cooldown
      for (let i = 0; i < 5; i++) {
        circuitBreaker.recordFailure();
      }
      jest.advanceTimersByTime(60001);

      circuitBreaker.recordSuccess();

      expect(circuitBreaker.isCurrentlyOpen()).toBe(false);
      expect(circuitBreaker.getFailures()).toBe(0);
    });
  });

  describe('reset', () => {
    it('should reset all state', () => {
      // Trip the circuit
      for (let i = 0; i < 5; i++) {
        circuitBreaker.recordFailure();
      }

      circuitBreaker.reset();

      const status = circuitBreaker.getStatus();
      expect(status.failures).toBe(0);
      expect(status.isOpen).toBe(false);
      expect(status.lastFailure).toBe(0);
    });
  });

  describe('getStatus', () => {
    it('should return complete status snapshot', () => {
      const status = circuitBreaker.getStatus();

      expect(status).toEqual({
        failures: 0,
        isOpen: false,
        lastFailure: 0,
        threshold: 5,
        resetTimeoutMs: 60000,
      });
    });
  });

  describe('getCooldownRemaining', () => {
    it('should return 0 when circuit is closed', () => {
      expect(circuitBreaker.getCooldownRemaining()).toBe(0);
    });

    it('should return remaining time when circuit is open', () => {
      // Trip the circuit
      for (let i = 0; i < 5; i++) {
        circuitBreaker.recordFailure();
      }

      expect(circuitBreaker.getCooldownRemaining()).toBeLessThanOrEqual(60000);
      expect(circuitBreaker.getCooldownRemaining()).toBeGreaterThan(0);

      // Advance time
      jest.advanceTimersByTime(30000);
      expect(circuitBreaker.getCooldownRemaining()).toBeLessThanOrEqual(30000);
    });

    it('should return 0 after cooldown expires', () => {
      // Trip the circuit
      for (let i = 0; i < 5; i++) {
        circuitBreaker.recordFailure();
      }

      jest.advanceTimersByTime(60001);

      // Note: getCooldownRemaining doesn't change isOpen status
      expect(circuitBreaker.getCooldownRemaining()).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('should handle threshold of 1', () => {
      const breaker = new SimpleCircuitBreaker(1, 60000);

      expect(breaker.recordFailure()).toBe(true);
      expect(breaker.isCurrentlyOpen()).toBe(true);
    });

    it('should handle rapid failure/success cycles', () => {
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      circuitBreaker.recordSuccess(); // Resets to 0
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure(); // Should trip (5 consecutive)

      expect(circuitBreaker.isCurrentlyOpen()).toBe(true);
    });

    it('should handle success while open but within cooldown', () => {
      // Trip the circuit
      for (let i = 0; i < 5; i++) {
        circuitBreaker.recordFailure();
      }

      // Success while still in cooldown
      expect(circuitBreaker.recordSuccess()).toBe(true);
      expect(circuitBreaker.isCurrentlyOpen()).toBe(false);
    });

    it('should allow retry after cooldown expires', () => {
      // Trip the circuit
      for (let i = 0; i < 5; i++) {
        circuitBreaker.recordFailure();
      }
      expect(circuitBreaker.isCurrentlyOpen()).toBe(true);

      // Wait for cooldown
      jest.advanceTimersByTime(60001);

      // Should allow retry
      expect(circuitBreaker.isCurrentlyOpen()).toBe(false);

      // If retry fails, circuit should re-open immediately
      // (since failure count persists)
      circuitBreaker.recordFailure();
      expect(circuitBreaker.isCurrentlyOpen()).toBe(true);
    });
  });

  describe('createSimpleCircuitBreaker factory', () => {
    it('should create with default options', () => {
      const breaker = createSimpleCircuitBreaker();
      const status = breaker.getStatus();

      expect(status.threshold).toBe(5);
      expect(status.resetTimeoutMs).toBe(60000);
    });

    it('should create with custom options', () => {
      const breaker = createSimpleCircuitBreaker({
        threshold: 3,
        resetTimeoutMs: 30000,
      });
      const status = breaker.getStatus();

      expect(status.threshold).toBe(3);
      expect(status.resetTimeoutMs).toBe(30000);
    });
  });
});
