// Cross-Chain Detector Service Unit Tests
import { CrossChainDetectorService } from './detector';

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
    logArbitrageOpportunity: jest.fn(),
    logHealthCheck: jest.fn()
  }))
}));

describe('CrossChainDetectorService', () => {
  let detector: CrossChainDetectorService;

  beforeEach(() => {
    const mockRedis = {
      publish: jest.fn().mockResolvedValue(1),
      subscribe: jest.fn().mockResolvedValue(undefined),
      updateServiceHealth: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined)
    };
    const { getRedisClient } = require('../../../shared/core/src');
    (getRedisClient as jest.Mock).mockReturnValue(mockRedis);

    detector = new CrossChainDetectorService();
  });

  test('should initialize correctly', () => {
    expect(detector).toBeDefined();
  });

  test('should calculate bridge costs correctly', () => {
    const mockUpdate = {
      pairKey: 'uniswap_v3_WETH_USDT',
      price: 2500
    };

    // Test bridge cost calculation
    const cost = (detector as any).estimateBridgeCost('ethereum', 'arbitrum', mockUpdate);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(0.01); // Should be reasonable
  });

  test('should filter valid opportunities', () => {
    const opportunities = [
      {
        token: 'WETH/USDT',
        netProfit: 0.1,
        confidence: 0.9
      },
      {
        token: 'WBTC/USDT',
        netProfit: 0.01,
        confidence: 0.3
      },
      {
        token: 'WBNB/USDT',
        netProfit: 0.05,
        confidence: 0.8
      }
    ];

    const validOpps = (detector as any).filterValidOpportunities(opportunities);
    expect(validOpps.length).toBeGreaterThan(0);
    expect(validOpps[0].netProfit).toBeGreaterThan(validOpps[validOpps.length - 1].netProfit);
  });
});