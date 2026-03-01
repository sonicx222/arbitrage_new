/**
 * Tests for Circuit Breaker Manager
 *
 * Verifies per-chain circuit breaker lifecycle, event handling, and public API.
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
  isEnabled: jest.fn().mockReturnValue(true),
  recordSuccess: jest.fn(),
  recordFailure: jest.fn(),
  getConsecutiveFailures: jest.fn().mockReturnValue(0),
  getCooldownRemaining: jest.fn().mockReturnValue(0),
  getMetrics: jest.fn().mockReturnValue({}),
  getConfig: jest.fn().mockReturnValue({}),
  forceClose: jest.fn(),
  forceOpen: jest.fn(),
  enable: jest.fn(),
  disable: jest.fn(),
  stop: jest.fn(),
};

const capturedCallbacks: Map<string, (event: any) => void> = new Map();
let createCallCount = 0;

jest.mock('../../../src/services/circuit-breaker', () => ({
  createCircuitBreaker: jest.fn().mockImplementation((opts) => {
    createCallCount++;
    // Return a fresh mock for each chain
    const breaker = { ...mockCircuitBreaker };
    // Store the callback keyed by call count (chain breakers are created lazily)
    capturedCallbacks.set(`cb-${createCallCount}`, opts.onStateChange);
    return breaker;
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
    capturedCallbacks.clear();
    createCallCount = 0;

    // Re-set mock implementations after clearAllMocks
    (createCircuitBreaker as jest.Mock).mockImplementation((opts: any) => {
      createCallCount++;
      const breaker = {
        getState: jest.fn().mockReturnValue('CLOSED'),
        getStatus: jest.fn().mockReturnValue({ state: 'CLOSED', consecutiveFailures: 0 }),
        isOpen: jest.fn().mockReturnValue(false),
        canExecute: jest.fn().mockReturnValue(true),
        isEnabled: jest.fn().mockReturnValue(true),
        recordSuccess: jest.fn(),
        recordFailure: jest.fn(),
        getConsecutiveFailures: jest.fn().mockReturnValue(0),
        getCooldownRemaining: jest.fn().mockReturnValue(0),
        getMetrics: jest.fn().mockReturnValue({}),
        getConfig: jest.fn().mockReturnValue({}),
        forceClose: jest.fn(),
        forceOpen: jest.fn(),
        enable: jest.fn(),
        disable: jest.fn(),
        stop: jest.fn(),
      };
      capturedCallbacks.set(`cb-${createCallCount}`, opts.onStateChange);
      return breaker;
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
      xaddWithLimit: jest.fn().mockResolvedValue('stream-id'),
    };

    defaultConfig = {
      enabled: true,
      failureThreshold: 5,
      cooldownPeriodMs: 300000,
      halfOpenMaxAttempts: 1,
    };
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
    it('should enable manager when config is enabled', () => {
      const manager = createManager();
      manager.initialize();

      // No circuit breakers created yet — they are lazy per-chain
      expect(createCircuitBreaker).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Per-chain circuit breaker manager initialized',
        expect.objectContaining({ failureThreshold: 5 }),
      );
    });

    it('should not create circuit breakers when disabled', () => {
      const manager = createManager({
        config: { ...defaultConfig, enabled: false },
      });
      manager.initialize();

      expect(createCircuitBreaker).not.toHaveBeenCalled();
      expect(manager.getCircuitBreaker()).toBeNull();
      expect(mockLogger.info).toHaveBeenCalledWith('Circuit breaker disabled by configuration');
    });
  });

  describe('per-chain breaker lifecycle', () => {
    it('should lazily create chain breaker on first access', () => {
      const manager = createManager();
      manager.initialize();

      const breaker = manager.getChainBreaker('ethereum');
      expect(breaker).not.toBeNull();
      expect(createCircuitBreaker).toHaveBeenCalledTimes(1);
      expect(createCircuitBreaker).toHaveBeenCalledWith(expect.objectContaining({
        failureThreshold: 5,
        cooldownPeriodMs: 300000,
        halfOpenMaxAttempts: 1,
        enabled: true,
      }));
    });

    it('should reuse existing chain breaker on subsequent access', () => {
      const manager = createManager();
      manager.initialize();

      const breaker1 = manager.getChainBreaker('ethereum');
      const breaker2 = manager.getChainBreaker('ethereum');
      expect(breaker1).toBe(breaker2);
      expect(createCircuitBreaker).toHaveBeenCalledTimes(1);
    });

    it('should create separate breakers for different chains', () => {
      const manager = createManager();
      manager.initialize();

      const ethBreaker = manager.getChainBreaker('ethereum');
      const solBreaker = manager.getChainBreaker('solana');
      expect(ethBreaker).not.toBe(solBreaker);
      expect(createCircuitBreaker).toHaveBeenCalledTimes(2);
    });

    it('should return null for chain breaker when disabled', () => {
      const manager = createManager({
        config: { ...defaultConfig, enabled: false },
      });
      manager.initialize();

      expect(manager.getChainBreaker('ethereum')).toBeNull();
    });
  });

  describe('per-chain canExecute / recordSuccess / recordFailure', () => {
    it('should delegate canExecute to chain-specific breaker', () => {
      const manager = createManager();
      manager.initialize();

      expect(manager.canExecute('ethereum')).toBe(true);
      expect(createCircuitBreaker).toHaveBeenCalledTimes(1);
    });

    it('should always allow execution when disabled', () => {
      const manager = createManager({
        config: { ...defaultConfig, enabled: false },
      });
      manager.initialize();

      expect(manager.canExecute('ethereum')).toBe(true);
      expect(createCircuitBreaker).not.toHaveBeenCalled();
    });

    it('should record success on the correct chain breaker', () => {
      const manager = createManager();
      manager.initialize();

      manager.recordSuccess('ethereum');
      const breaker = manager.getChainBreaker('ethereum')!;
      expect(breaker.recordSuccess).toHaveBeenCalled();
    });

    it('should record failure on the correct chain breaker', () => {
      const manager = createManager();
      manager.initialize();

      manager.recordFailure('solana');
      const breaker = manager.getChainBreaker('solana')!;
      expect(breaker.recordFailure).toHaveBeenCalled();
    });
  });

  describe('chain isolation', () => {
    it('should isolate failures between chains', () => {
      const manager = createManager();
      manager.initialize();

      // Record failures on Solana
      manager.recordFailure('solana');
      manager.recordFailure('solana');

      // Ethereum should still be functional (separate breaker)
      const ethBreaker = manager.getChainBreaker('ethereum')!;
      const solBreaker = manager.getChainBreaker('solana')!;

      // Different breaker instances
      expect(ethBreaker).not.toBe(solBreaker);
      // Ethereum breaker was not affected by Solana failures
      expect(ethBreaker.recordFailure).not.toHaveBeenCalled();
    });
  });

  describe('state change handling', () => {
    it('should log chain-specific warning when circuit opens', () => {
      const manager = createManager();
      manager.initialize();

      // Trigger chain breaker creation
      manager.getChainBreaker('ethereum');
      const callback = capturedCallbacks.get('cb-1');
      expect(callback).toBeDefined();

      callback!({
        previousState: 'CLOSED',
        newState: 'OPEN',
        reason: 'consecutive failures',
        consecutiveFailures: 5,
        cooldownRemainingMs: 300000,
        timestamp: Date.now(),
      });

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Chain circuit breaker OPENED - halting executions on chain',
        expect.objectContaining({
          chain: 'ethereum',
          reason: 'consecutive failures',
          consecutiveFailures: 5,
        }),
      );
      expect(mockStats.circuitBreakerTrips).toBe(1);
    });

    it('should log chain-specific info when circuit closes', () => {
      const manager = createManager();
      manager.initialize();

      manager.getChainBreaker('solana');
      const callback = capturedCallbacks.get('cb-1');

      callback!({
        previousState: 'HALF_OPEN',
        newState: 'CLOSED',
        reason: 'recovery successful',
        consecutiveFailures: 0,
        cooldownRemainingMs: 0,
        timestamp: Date.now(),
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Chain circuit breaker CLOSED - resuming executions on chain',
        expect.objectContaining({ chain: 'solana', reason: 'recovery successful' }),
      );
    });

    it('should publish chain-annotated event to Redis Stream', async () => {
      const manager = createManager();
      manager.initialize();

      manager.getChainBreaker('arbitrum');
      const callback = capturedCallbacks.get('cb-1');

      callback!({
        previousState: 'CLOSED',
        newState: 'OPEN',
        reason: 'failures',
        consecutiveFailures: 5,
        cooldownRemainingMs: 300000,
        timestamp: 1234567890,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(mockStreamsClient.xaddWithLimit).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          service: 'execution-engine',
          instanceId: 'test-instance-1',
          chain: 'arbitrum',
          previousState: 'CLOSED',
          newState: 'OPEN',
          reason: 'failures',
        }),
      );
    });

    it('should handle publish error gracefully', async () => {
      mockStreamsClient.xaddWithLimit.mockRejectedValue(new Error('Redis down'));

      const manager = createManager();
      manager.initialize();

      manager.getChainBreaker('ethereum');
      const callback = capturedCallbacks.get('cb-1');

      callback!({
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
        expect.objectContaining({
          error: expect.stringContaining('Redis down'),
          chain: 'ethereum',
        }),
      );
    });

    it('should skip publish when streams client is null', async () => {
      const manager = createManager({
        getStreamsClient: () => null,
      });
      manager.initialize();

      manager.getChainBreaker('ethereum');
      const callback = capturedCallbacks.get('cb-1');

      callback!({
        previousState: 'CLOSED',
        newState: 'OPEN',
        reason: 'failures',
        consecutiveFailures: 5,
        cooldownRemainingMs: 300000,
        timestamp: Date.now(),
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(mockStreamsClient.xaddWithLimit).not.toHaveBeenCalled();
    });
  });

  describe('public API', () => {
    it('should return chain-specific status', () => {
      const manager = createManager();
      manager.initialize();

      manager.getChainBreaker('ethereum');
      const status = manager.getChainStatus('ethereum');
      expect(status).toEqual({ state: 'CLOSED', consecutiveFailures: 0 });
    });

    it('should return null status for unknown chain', () => {
      const manager = createManager();
      manager.initialize();

      expect(manager.getChainStatus('unknown')).toBeNull();
    });

    it('should return all chain statuses', () => {
      const manager = createManager();
      manager.initialize();

      manager.getChainBreaker('ethereum');
      manager.getChainBreaker('solana');

      const allStatus = manager.getAllStatus();
      expect(allStatus).toHaveLength(2);
      expect(allStatus.map(s => s.chain).sort()).toEqual(['ethereum', 'solana']);
    });

    it('should check if specific chain is open', () => {
      const manager = createManager();
      manager.initialize();

      expect(manager.isChainOpen('ethereum')).toBe(false);
    });

    it('should return config', () => {
      const manager = createManager();
      expect(manager.getConfig()).toEqual(defaultConfig);
    });

    it('should force close all circuit breakers', () => {
      const manager = createManager();
      manager.initialize();

      const ethBreaker = manager.getChainBreaker('ethereum')!;
      const solBreaker = manager.getChainBreaker('solana')!;

      manager.forceClose();

      expect(ethBreaker.forceClose).toHaveBeenCalled();
      expect(solBreaker.forceClose).toHaveBeenCalled();
    });

    it('should force close a specific chain', () => {
      const manager = createManager();
      manager.initialize();

      const ethBreaker = manager.getChainBreaker('ethereum')!;
      manager.getChainBreaker('solana');

      manager.forceCloseChain('ethereum');
      expect(ethBreaker.forceClose).toHaveBeenCalled();
    });

    it('should force open all circuit breakers', () => {
      const manager = createManager();
      manager.initialize();

      const ethBreaker = manager.getChainBreaker('ethereum')!;
      const solBreaker = manager.getChainBreaker('solana')!;

      manager.forceOpen('emergency');

      expect(ethBreaker.forceOpen).toHaveBeenCalledWith('emergency');
      expect(solBreaker.forceOpen).toHaveBeenCalledWith('emergency');
    });

    it('should stop all chain breakers', () => {
      const manager = createManager();
      manager.initialize();

      const ethBreaker = manager.getChainBreaker('ethereum')!;
      const solBreaker = manager.getChainBreaker('solana')!;

      manager.stopAll();

      expect(ethBreaker.stop).toHaveBeenCalled();
      expect(solBreaker.stop).toHaveBeenCalled();
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
