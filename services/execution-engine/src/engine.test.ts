// Execution Engine Service Unit Tests
import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { ExecutionEngineService } from './engine';

// Mock config module
jest.mock('@arbitrage/config', () => ({
  CHAINS: {},
  ARBITRAGE_CONFIG: {
    minProfitPercentage: 0.003, // 0.3%
    confidenceThreshold: 0.75,
    maxSlippage: 0.01,
    maxGasPrice: 100,
    executionTimeout: 30000
  },
  FLASH_LOAN_PROVIDERS: {}
}));

jest.mock('@arbitrage/core', () => ({
  getRedisClient: jest.fn(),
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  })),
  getPerformanceLogger: jest.fn(() => ({
    logEventLatency: jest.fn(),
    logExecutionResult: jest.fn(),
    logHealthCheck: jest.fn()
  })),
  createServiceState: jest.fn(() => ({
    getState: jest.fn(() => 'idle'),
    transition: jest.fn(() => Promise.resolve({ success: true })),
    isTransitioning: jest.fn(() => false),
    waitForIdle: jest.fn(() => Promise.resolve()),
    on: jest.fn(),
    off: jest.fn(),
    canTransition: jest.fn(() => true)
  })),
  ServiceState: {
    IDLE: 'idle',
    STARTING: 'starting',
    RUNNING: 'running',
    STOPPING: 'stopping',
    STOPPED: 'stopped',
    ERROR: 'error'
  },
  RedisStreamsClient: {
    STREAMS: {
      OPPORTUNITIES: 'opportunities',
      EXECUTIONS: 'executions',
      PRICE_UPDATES: 'price-updates',
      EVENTS: 'events'
    }
  }
}));

describe('ExecutionEngineService', () => {
  let engine: ExecutionEngineService;

  beforeEach(() => {
    const mockRedis = {
      publish: jest.fn(() => Promise.resolve(1)),
      subscribe: jest.fn(() => Promise.resolve(undefined)),
      updateServiceHealth: jest.fn(() => Promise.resolve(undefined)),
      disconnect: jest.fn(() => Promise.resolve(undefined))
    };
    const { getRedisClient } = require('@arbitrage/core');
    (getRedisClient as jest.Mock).mockReturnValue(mockRedis);

    engine = new ExecutionEngineService();
  });

  test('should initialize correctly', () => {
    expect(engine).toBeDefined();
  });

  test('should validate opportunities correctly', () => {
    // Note: buyChain is omitted/undefined to skip wallet check in validation
    const validOpportunity = {
      id: 'test-opp-1',
      type: 'cross-dex',
      buyDex: 'uniswap_v3',
      sellDex: 'sushiswap',
      buyChain: undefined, // No wallet check when undefined
      tokenIn: 'WETH',
      tokenOut: 'USDT',
      amountIn: '1000000000000000000',
      expectedProfit: 0.1, // Above minProfitPercentage (0.003)
      profitPercentage: 0.02,
      gasEstimate: 200000,
      confidence: 0.85, // Above confidenceThreshold (0.75)
      timestamp: Date.now(),
      blockNumber: 18000000
    };

    const isValid = (engine as any).validateOpportunity(validOpportunity);
    expect(isValid).toBe(true);

    const invalidOpportunity = {
      ...validOpportunity,
      confidence: 0.5 // Below threshold (0.75)
    };

    const isInvalid = (engine as any).validateOpportunity(invalidOpportunity);
    expect(isInvalid).toBe(false);
  });

  test('should build swap paths correctly', () => {
    const opportunity = {
      tokenIn: 'WETH',
      tokenOut: 'USDT',
      buyDex: 'uniswap_v3',
      sellDex: 'sushiswap'
    };

    const path = (engine as any).buildSwapPath(opportunity);
    expect(path).toEqual(['WETH', 'USDT']);
  });
});