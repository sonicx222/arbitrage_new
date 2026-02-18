/**
 * Shared Mock Factories for Cross-Chain Detector Tests
 *
 * Consolidated mock factory functions for all cross-chain-detector test files.
 * Each factory returns a fresh mock object with default return values.
 * Factories should be called in beforeEach() to survive jest.resetAllMocks().
 *
 * Usage:
 * ```typescript
 * import { createMockRedisClient, createMockStateManager } from '../helpers/mock-factories';
 *
 * let mockRedis: ReturnType<typeof createMockRedisClient>;
 * beforeEach(() => {
 *   mockRedis = createMockRedisClient();
 * });
 * ```
 *
 * @see FIX #30: Shared test helpers for cross-chain-detector
 * @see FIX #16: Typed test mocks
 */

import { jest } from '@jest/globals';

// =============================================================================
// Infrastructure Mocks (Redis, Logger, PriceOracle)
// =============================================================================

/**
 * Create a mock Redis client with default resolved values.
 */
export function createMockRedisClient() {
  return {
    disconnect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    updateServiceHealth: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    get: jest.fn<() => Promise<string | null>>().mockResolvedValue(null),
    set: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

/**
 * Create a mock Redis Streams client with default resolved values.
 */
export function createMockStreamsClient() {
  return {
    disconnect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    xreadgroup: jest.fn<() => Promise<any[]>>().mockResolvedValue([]),
    xack: jest.fn<() => Promise<number>>().mockResolvedValue(1),
    xaddWithLimit: jest.fn<() => Promise<string>>().mockResolvedValue('stream-id'),
    createConsumerGroup: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

/**
 * Create a mock PriceOracle that returns a default ETH price of $3000.
 */
export function createMockPriceOracle() {
  return {
    getPrice: jest.fn<any>().mockResolvedValue({ price: 3000, isStale: false, source: 'mock' }),
  };
}

/**
 * Create a mock logger with info/warn/error/debug methods.
 */
export function createMockLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

/**
 * Create a mock PerformanceLogger.
 */
export function createMockPerfLogger() {
  return {
    startTimer: jest.fn().mockReturnValue({ stop: jest.fn() }),
    recordMetric: jest.fn(),
    getMetrics: jest.fn().mockReturnValue({}),
    logHealthCheck: jest.fn(),
  };
}

// =============================================================================
// Domain Mocks (Whale Tracker, State Manager)
// =============================================================================

/**
 * Create a mock WhaleActivityTracker with neutral default activity.
 */
export function createMockWhaleTracker() {
  return {
    recordTransaction: jest.fn(),
    getActivitySummary: jest.fn().mockReturnValue({
      dominantDirection: 'neutral',
      buyVolumeUsd: 0,
      sellVolumeUsd: 0,
      superWhaleCount: 0,
      netFlowUsd: 0,
      transactionCount: 0,
      recentTransactions: [],
    }),
  };
}

/**
 * Create a mock ServiceStateManager that tracks state transitions.
 *
 * Supports: STOPPED -> STARTING -> RUNNING -> STOPPING -> STOPPED
 * Error state on callback throws.
 */
export function createMockStateManager() {
  let state = 'STOPPED';
  return {
    getState: jest.fn(() => state),
    isRunning: jest.fn(() => state === 'RUNNING'),
    executeStart: jest.fn(async (fn: () => Promise<void>) => {
      if (state !== 'STOPPED') {
        return { success: false, error: new Error(`Cannot start from state ${state}`) };
      }
      state = 'STARTING';
      try {
        await fn();
        state = 'RUNNING';
        return { success: true };
      } catch (error) {
        state = 'ERROR';
        return { success: false, error };
      }
    }),
    executeStop: jest.fn(async (fn: () => Promise<void>) => {
      if (state !== 'RUNNING' && state !== 'ERROR') {
        return { success: false, error: new Error(`Cannot stop from state ${state}`) };
      }
      state = 'STOPPING';
      try {
        await fn();
        state = 'STOPPED';
        return { success: true };
      } catch (error) {
        state = 'ERROR';
        return { success: false, error };
      }
    }),
  };
}

// =============================================================================
// Cross-Chain Detector Module Mocks (ADR-014 modules)
// =============================================================================

/**
 * Create a mock StreamConsumer (EventEmitter-like interface).
 */
export function createMockStreamConsumer() {
  return {
    createConsumerGroups: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    start: jest.fn(),
    stop: jest.fn(),
    on: jest.fn(),
    removeAllListeners: jest.fn(),
    emit: jest.fn(),
  };
}

/**
 * Create a mock PriceDataManager with empty default data.
 */
export function createMockPriceDataManager() {
  return {
    handlePriceUpdate: jest.fn(),
    getPairCount: jest.fn().mockReturnValue(0),
    getChains: jest.fn().mockReturnValue([]),
    createIndexedSnapshot: jest.fn().mockReturnValue({
      tokenPairs: [],
      byToken: new Map(),
      byChain: new Map(),
      timestamp: Date.now(),
    }),
    cleanup: jest.fn(),
    clear: jest.fn(),
  };
}

/**
 * Create a mock OpportunityPublisher that resolves publish calls.
 */
export function createMockOpportunityPublisher() {
  return {
    publish: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    getCacheSize: jest.fn().mockReturnValue(0),
    cleanup: jest.fn(),
    clear: jest.fn(),
  };
}

/**
 * Create a mock BridgeCostEstimator with default cost values.
 * Default: 0.001 ETH bridge cost, $3 USD, 120s latency, 95% reliability.
 */
export function createMockBridgeCostEstimator() {
  return {
    estimateBridgeCost: jest.fn().mockReturnValue(0.001),
    getDetailedEstimate: jest.fn().mockReturnValue({
      costEth: 0.001,
      costUsd: 3,
      predictedLatency: 120,
      reliability: 0.95,
    }),
    extractTokenAmount: jest.fn().mockReturnValue(1000),
    updateEthPrice: jest.fn(),
    getEthPrice: jest.fn().mockReturnValue(3000),
  };
}

/**
 * Create a mock MLPredictionManager.
 * Default: initialize succeeds, not ready, no cached predictions.
 */
export function createMockMLPredictionManager() {
  return {
    initialize: jest.fn<any>().mockResolvedValue(true),
    isReady: jest.fn().mockReturnValue(false),
    trackPriceUpdate: jest.fn(),
    prefetchPredictions: jest.fn<() => Promise<Map<string, any>>>().mockResolvedValue(new Map()),
    getCachedPrediction: jest.fn().mockReturnValue(null),
    cleanup: jest.fn(),
    clear: jest.fn(),
  };
}
