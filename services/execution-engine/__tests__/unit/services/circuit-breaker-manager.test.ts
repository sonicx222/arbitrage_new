/**
 * Tests for Circuit Breaker Manager
 *
 * Verifies circuit breaker lifecycle, event handling, and public API.
 */

import {
  CircuitBreakerManager,
  createCircuitBreakerManager,
  type CircuitBreakerManagerDeps,
} from '../../../src/services/circuit-breaker-manager';
import type { CircuitBreakerConfig, ExecutionStats } from '../../../src/types';
import { createInitialStats } from '../../../src/types';

// Mock circuit breaker module
const mockCircuitBreaker = {
  getState: jest.fn().mockReturnValue('CLOSED'),
  getStatus: jest.fn().mockReturnValue({ state: 'CLOSED', consecutiveFailures: 0 }),
  isOpen: jest.fn().mockReturnValue(false),
  canExecute: jest.fn().mockReturnValue(true),
  recordSuccess: jest.fn(),
  recordFailure: jest.fn(),
  forceClose: jest.fn(),
  forceOpen: jest.fn(),
  stop: jest.fn(),
};

let capturedOnStateChange: ((event: any) => void) | undefined;

jest.mock('../../../src/services/circuit-breaker', () => ({
  createCircuitBreaker: jest.fn().mockImplementation((opts) => {
    capturedOnStateChange = opts.onStateChange;
    return mockCircuitBreaker;
  }),
}));

import { createCircuitBreaker } from '../../../src/services/circuit-breaker';

describe('CircuitBreakerManager', () => {
  let mockLogger: any;
  let mockStats: ExecutionStats;
  let mockStreamsClient: any;
  let defaultConfig: Required<CircuitBreakerConfig>;

  beforeEach(() => {
    jest.clearAllMocks();
    capturedOnStateChange = undefined;

    // Re-set mock implementations after clearAllMocks
    (createCircuitBreaker as jest.Mock).mockImplementation((opts: any) => {
      capturedOnStateChange = opts.onStateChange;
      return mockCircuitBreaker;
    });

    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    mockStats = createInitialStats();

    mockStreamsClient = {
      xadd: jest.fn().mockResolvedValue('stream-id'),
    };

    defaultConfig = {
      enabled: true,
      failureThreshold: 5,
      cooldownPeriodMs: 300000,
      halfOpenMaxAttempts: 1,
    };

    // Reset mock states
    mockCircuitBreaker.getState.mockReturnValue('CLOSED');
    mockCircuitBreaker.getStatus.mockReturnValue({ state: 'CLOSED', consecutiveFailures: 0 });
    mockCircuitBreaker.isOpen.mockReturnValue(false);
    mockCircuitBreaker.canExecute.mockReturnValue(true);
  });

  function createManager(overrides: Partial<CircuitBreakerManagerDeps> = {}): CircuitBreakerManager {
    return createCircuitBreakerManager({
      config: defaultConfig,
      logger: mockLogger,
      stats: mockStats,
      instanceId: 'test-instance-1',
      getStreamsClient: () => mockStreamsClient,
      ...overrides,
    });
  }

  describe('initialize', () => {
    it('should create circuit breaker when enabled', () => {
      const manager = createManager();
      manager.initialize();

      expect(createCircuitBreaker).toHaveBeenCalledWith(expect.objectContaining({
        failureThreshold: 5,
        cooldownPeriodMs: 300000,
        halfOpenMaxAttempts: 1,
        enabled: true,
      }));
      expect(manager.getCircuitBreaker()).toBe(mockCircuitBreaker);
    });

    it('should not create circuit breaker when disabled', () => {
      const manager = createManager({
        config: { ...defaultConfig, enabled: false },
      });
      manager.initialize();

      expect(createCircuitBreaker).not.toHaveBeenCalled();
      expect(manager.getCircuitBreaker()).toBeNull();
      expect(mockLogger.info).toHaveBeenCalledWith('Circuit breaker disabled by configuration');
    });

    it('should log initialization details', () => {
      const manager = createManager();
      manager.initialize();

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Circuit breaker initialized',
        expect.objectContaining({
          failureThreshold: 5,
          cooldownPeriodMs: 300000,
          halfOpenMaxAttempts: 1,
        }),
      );
    });
  });

  describe('state change handling', () => {
    it('should log warning and increment stats when circuit opens', () => {
      const manager = createManager();
      manager.initialize();

      expect(capturedOnStateChange).toBeDefined();
      capturedOnStateChange!({
        previousState: 'CLOSED',
        newState: 'OPEN',
        reason: 'consecutive failures',
        consecutiveFailures: 5,
        cooldownRemainingMs: 300000,
        timestamp: Date.now(),
      });

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Circuit breaker OPENED - halting executions',
        expect.objectContaining({
          reason: 'consecutive failures',
          consecutiveFailures: 5,
        }),
      );
      expect(mockStats.circuitBreakerTrips).toBe(1);
    });

    it('should log info when circuit closes', () => {
      const manager = createManager();
      manager.initialize();

      capturedOnStateChange!({
        previousState: 'HALF_OPEN',
        newState: 'CLOSED',
        reason: 'recovery successful',
        consecutiveFailures: 0,
        cooldownRemainingMs: 0,
        timestamp: Date.now(),
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Circuit breaker CLOSED - resuming executions',
        expect.objectContaining({ reason: 'recovery successful' }),
      );
    });

    it('should log info when circuit enters half-open', () => {
      const manager = createManager();
      manager.initialize();

      capturedOnStateChange!({
        previousState: 'OPEN',
        newState: 'HALF_OPEN',
        reason: 'cooldown expired',
        consecutiveFailures: 5,
        cooldownRemainingMs: 0,
        timestamp: Date.now(),
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Circuit breaker HALF_OPEN - testing recovery',
        expect.objectContaining({ reason: 'cooldown expired' }),
      );
    });

    it('should publish event to Redis Stream', async () => {
      const manager = createManager();
      manager.initialize();

      capturedOnStateChange!({
        previousState: 'CLOSED',
        newState: 'OPEN',
        reason: 'failures',
        consecutiveFailures: 5,
        cooldownRemainingMs: 300000,
        timestamp: 1234567890,
      });

      // Allow async publish to complete
      await new Promise(resolve => setImmediate(resolve));

      expect(mockStreamsClient.xadd).toHaveBeenCalledWith(
        expect.any(String), // STREAMS.CIRCUIT_BREAKER
        expect.objectContaining({
          service: 'execution-engine',
          instanceId: 'test-instance-1',
          previousState: 'CLOSED',
          newState: 'OPEN',
          reason: 'failures',
        }),
      );
    });

    it('should handle publish error gracefully', async () => {
      mockStreamsClient.xadd.mockRejectedValue(new Error('Redis down'));

      const manager = createManager();
      manager.initialize();

      capturedOnStateChange!({
        previousState: 'CLOSED',
        newState: 'OPEN',
        reason: 'failures',
        consecutiveFailures: 5,
        cooldownRemainingMs: 300000,
        timestamp: Date.now(),
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to publish circuit breaker event',
        expect.objectContaining({ error: expect.stringContaining('Redis down') }),
      );
    });

    it('should skip publish when streams client is null', async () => {
      const manager = createManager({
        getStreamsClient: () => null,
      });
      manager.initialize();

      capturedOnStateChange!({
        previousState: 'CLOSED',
        newState: 'OPEN',
        reason: 'failures',
        consecutiveFailures: 5,
        cooldownRemainingMs: 300000,
        timestamp: Date.now(),
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(mockStreamsClient.xadd).not.toHaveBeenCalled();
    });
  });

  describe('public API', () => {
    it('should return status from circuit breaker', () => {
      const manager = createManager();
      manager.initialize();

      const status = manager.getStatus();
      expect(status).toEqual({ state: 'CLOSED', consecutiveFailures: 0 });
    });

    it('should return null status when not initialized', () => {
      const manager = createManager();
      expect(manager.getStatus()).toBeNull();
    });

    it('should check if circuit is open', () => {
      const manager = createManager();
      manager.initialize();

      expect(manager.isOpen()).toBe(false);
      mockCircuitBreaker.isOpen.mockReturnValue(true);
      expect(manager.isOpen()).toBe(true);
    });

    it('should return false for isOpen when not initialized', () => {
      const manager = createManager();
      expect(manager.isOpen()).toBe(false);
    });

    it('should return config', () => {
      const manager = createManager();
      const config = manager.getConfig();

      expect(config).toEqual(defaultConfig);
    });

    it('should delegate forceClose to circuit breaker', () => {
      const manager = createManager();
      manager.initialize();
      manager.forceClose();

      expect(mockLogger.warn).toHaveBeenCalledWith('Manually force-closing circuit breaker');
      expect(mockCircuitBreaker.forceClose).toHaveBeenCalled();
    });

    it('should be safe to call forceClose when not initialized', () => {
      const manager = createManager();
      manager.forceClose(); // Should not throw
      expect(mockCircuitBreaker.forceClose).not.toHaveBeenCalled();
    });

    it('should delegate forceOpen to circuit breaker', () => {
      const manager = createManager();
      manager.initialize();
      manager.forceOpen('maintenance');

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Manually force-opening circuit breaker',
        { reason: 'maintenance' },
      );
      expect(mockCircuitBreaker.forceOpen).toHaveBeenCalledWith('maintenance');
    });

    it('should use default reason for forceOpen', () => {
      const manager = createManager();
      manager.initialize();
      manager.forceOpen();

      expect(mockCircuitBreaker.forceOpen).toHaveBeenCalledWith('manual override');
    });
  });

  describe('factory function', () => {
    it('should create a CircuitBreakerManager instance', () => {
      const manager = createCircuitBreakerManager({
        config: defaultConfig,
        logger: mockLogger,
        stats: mockStats,
        instanceId: 'test-1',
        getStreamsClient: () => null,
      });

      expect(manager).toBeInstanceOf(CircuitBreakerManager);
    });
  });
});
