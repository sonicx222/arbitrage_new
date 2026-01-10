// Base Detector Service Unit Tests
import { BaseDetectorService } from './detector';

// Mock dependencies
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

describe('BaseDetectorService', () => {
  let detector: BaseDetectorService;

  beforeEach(() => {
    const mockRedis = {
      publish: jest.fn().mockResolvedValue(1),
      updateServiceHealth: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined)
    };
    const { getRedisClient } = require('../../../shared/core/src');
    (getRedisClient as jest.Mock).mockReturnValue(mockRedis);

    detector = new BaseDetectorService();
  });

  test('should initialize correctly', () => {
    expect(detector).toBeDefined();
  });
});