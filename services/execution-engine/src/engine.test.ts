// Execution Engine Service Unit Tests
import { ExecutionEngineService } from './engine';

jest.mock('../../../shared/core/src', () => ({
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
  }))
}));

describe('ExecutionEngineService', () => {
  let engine: ExecutionEngineService;

  beforeEach(() => {
    const mockRedis = {
      publish: jest.fn().mockResolvedValue(1),
      subscribe: jest.fn().mockResolvedValue(undefined),
      updateServiceHealth: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined)
    };
    const { getRedisClient } = require('../../../shared/core/src');
    (getRedisClient as jest.Mock).mockReturnValue(mockRedis);

    engine = new ExecutionEngineService();
  });

  test('should initialize correctly', () => {
    expect(engine).toBeDefined();
  });

  test('should validate opportunities correctly', () => {
    const validOpportunity = {
      id: 'test-opp-1',
      type: 'cross-dex',
      buyDex: 'uniswap_v3',
      sellDex: 'sushiswap',
      buyChain: 'ethereum',
      tokenIn: 'WETH',
      tokenOut: 'USDT',
      amountIn: '1000000000000000000',
      expectedProfit: 0.1,
      profitPercentage: 0.02,
      gasEstimate: 200000,
      confidence: 0.85,
      timestamp: Date.now(),
      blockNumber: 18000000
    };

    const isValid = (engine as any).validateOpportunity(validOpportunity);
    expect(isValid).toBe(true);

    const invalidOpportunity = {
      ...validOpportunity,
      confidence: 0.5 // Below threshold
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