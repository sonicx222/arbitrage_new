// Coordinator Service Unit Tests
import { CoordinatorService } from './coordinator';

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

describe('CoordinatorService', () => {
  let coordinator: CoordinatorService;

  beforeEach(() => {
    const mockRedis = {
      publish: jest.fn().mockResolvedValue(1),
      subscribe: jest.fn().mockResolvedValue(undefined),
      updateServiceHealth: jest.fn().mockResolvedValue(undefined),
      getAllServiceHealth: jest.fn().mockResolvedValue({}),
      disconnect: jest.fn().mockResolvedValue(undefined)
    };
    const { getRedisClient } = require('../../../shared/core/src');
    (getRedisClient as jest.Mock).mockReturnValue(mockRedis);

    coordinator = new CoordinatorService();
  });

  test('should initialize correctly', () => {
    expect(coordinator).toBeDefined();
  });

  test('should initialize metrics correctly', () => {
    const metrics = (coordinator as any).systemMetrics;
    expect(metrics).toBeDefined();
    expect(metrics.totalOpportunities).toBe(0);
    expect(metrics.systemHealth).toBe(100);
  });

  test('should update system metrics correctly', () => {
    // Mock service health data
    (coordinator as any).serviceHealth = new Map([
      ['bsc-detector', { status: 'healthy', memoryUsage: 50 }],
      ['ethereum-detector', { status: 'healthy', memoryUsage: 60 }],
      ['coordinator', { status: 'unhealthy', memoryUsage: 40 }]
    ]);

    (coordinator as any).updateSystemMetrics();

    const metrics = (coordinator as any).systemMetrics;
    expect(metrics.activeServices).toBe(2); // 2 healthy services
    expect(metrics.systemHealth).toBe(66.67); // 2/3 * 100
  });
});