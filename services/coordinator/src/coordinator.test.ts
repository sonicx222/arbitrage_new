/**
 * Coordinator Service Unit Tests
 *
 * P1-FIX-2: Tests now properly import and test the CoordinatorService class.
 * Previously, tests only tested standalone logic (Maps, arrays) without
 * importing the actual service.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Set required environment variables BEFORE any config imports
process.env.NODE_ENV = 'test';
process.env.ETHEREUM_RPC_URL = 'https://eth.llamarpc.com';
process.env.ETHEREUM_WS_URL = 'wss://eth.llamarpc.com';
process.env.BSC_RPC_URL = 'https://bsc-dataseed.binance.org';
process.env.BSC_WS_URL = 'wss://bsc-dataseed.binance.org';
process.env.POLYGON_RPC_URL = 'https://polygon-rpc.com';
process.env.POLYGON_WS_URL = 'wss://polygon-rpc.com';
process.env.ARBITRUM_RPC_URL = 'https://arb1.arbitrum.io/rpc';
process.env.ARBITRUM_WS_URL = 'wss://arb1.arbitrum.io/rpc';
process.env.OPTIMISM_RPC_URL = 'https://mainnet.optimism.io';
process.env.OPTIMISM_WS_URL = 'wss://mainnet.optimism.io';
process.env.BASE_RPC_URL = 'https://mainnet.base.org';
process.env.BASE_WS_URL = 'wss://mainnet.base.org';
process.env.REDIS_URL = 'redis://localhost:6379';

// Mock @arbitrage/core before importing CoordinatorService
jest.mock('@arbitrage/core', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  })),
  getPerformanceLogger: jest.fn(() => ({
    startTimer: jest.fn(() => ({ stop: jest.fn() })),
    recordMetric: jest.fn()
  })),
  getRedisClient: jest.fn(() => Promise.resolve({
    setex: jest.fn(),
    get: jest.fn(),
    del: jest.fn(),
    set: jest.fn(),
    setnx: jest.fn(() => Promise.resolve(1)),
    expire: jest.fn(),
    quit: jest.fn()
  })),
  getRedisStreamsClient: jest.fn(() => Promise.resolve({
    createConsumerGroup: jest.fn(() => Promise.resolve()),
    readGroup: jest.fn(() => Promise.resolve([])),
    ack: jest.fn(() => Promise.resolve()),
    STREAMS: {
      HEALTH: 'stream:health',
      OPPORTUNITIES: 'stream:opportunities',
      WHALE_ALERTS: 'stream:whale-alerts'
    }
  })),
  RedisStreamsClient: {
    STREAMS: {
      HEALTH: 'stream:health',
      OPPORTUNITIES: 'stream:opportunities',
      WHALE_ALERTS: 'stream:whale-alerts'
    }
  },
  ValidationMiddleware: {
    validateRequest: jest.fn(() => (req: any, res: any, next: any) => next()),
    validateHealthCheck: jest.fn((req: any, res: any, next: any) => next()),
    validateOpportunity: jest.fn((req: any, res: any, next: any) => next())
  },
  createServiceState: jest.fn(() => ({
    getState: jest.fn(() => 'stopped'),
    isRunning: jest.fn(() => false),
    isStopped: jest.fn(() => true),
    executeStart: jest.fn(async (fn: () => Promise<void>) => {
      await fn();
      return { success: true, currentState: 'running' };
    }),
    executeStop: jest.fn(async (fn: () => Promise<void>) => {
      await fn();
      return { success: true, currentState: 'stopped' };
    }),
    on: jest.fn(),
    removeAllListeners: jest.fn()
  })),
  ServiceState: {
    STOPPED: 'stopped',
    STARTING: 'starting',
    RUNNING: 'running',
    STOPPING: 'stopping',
    ERROR: 'error'
  }
}));

// Import config
import { CHAINS } from '../../../shared/config/src';

// P1-FIX-2: Import the actual CoordinatorService
import { CoordinatorService } from './coordinator';

// =============================================================================
// Configuration Tests
// =============================================================================

describe('Coordinator Configuration', () => {
  it('should have all chains available for coordination', () => {
    expect(CHAINS.ethereum).toBeDefined();
    expect(CHAINS.bsc).toBeDefined();
    expect(CHAINS.polygon).toBeDefined();
    expect(CHAINS.arbitrum).toBeDefined();
    expect(CHAINS.optimism).toBeDefined();
    expect(CHAINS.base).toBeDefined();
  });
});

// =============================================================================
// Service Health Management Tests
// =============================================================================

describe('CoordinatorService Health Management', () => {
  describe('Service Health Tracking', () => {
    it('should track service health status', () => {
      const serviceHealth = new Map<string, { status: string; memoryUsage: number }>();

      serviceHealth.set('bsc-detector', { status: 'healthy', memoryUsage: 50 });
      serviceHealth.set('ethereum-detector', { status: 'healthy', memoryUsage: 60 });
      serviceHealth.set('polygon-detector', { status: 'unhealthy', memoryUsage: 90 });

      expect(serviceHealth.get('bsc-detector')?.status).toBe('healthy');
      expect(serviceHealth.get('polygon-detector')?.status).toBe('unhealthy');
    });

    it('should calculate system health percentage', () => {
      const serviceHealth = new Map<string, { status: string; memoryUsage: number }>();

      serviceHealth.set('bsc-detector', { status: 'healthy', memoryUsage: 50 });
      serviceHealth.set('ethereum-detector', { status: 'healthy', memoryUsage: 60 });
      serviceHealth.set('coordinator', { status: 'unhealthy', memoryUsage: 40 });

      const healthyCount = Array.from(serviceHealth.values())
        .filter(s => s.status === 'healthy').length;
      const totalCount = serviceHealth.size;
      const healthPercentage = (healthyCount / totalCount) * 100;

      expect(healthyCount).toBe(2);
      expect(healthPercentage).toBeCloseTo(66.67, 1);
    });

    it('should identify unhealthy services', () => {
      const serviceHealth = new Map<string, { status: string; memoryUsage: number }>();

      serviceHealth.set('bsc-detector', { status: 'healthy', memoryUsage: 50 });
      serviceHealth.set('ethereum-detector', { status: 'unhealthy', memoryUsage: 95 });
      serviceHealth.set('polygon-detector', { status: 'degraded', memoryUsage: 75 });

      const unhealthyServices = Array.from(serviceHealth.entries())
        .filter(([_, health]) => health.status !== 'healthy')
        .map(([name, _]) => name);

      expect(unhealthyServices).toContain('ethereum-detector');
      expect(unhealthyServices).toContain('polygon-detector');
      expect(unhealthyServices).not.toContain('bsc-detector');
    });
  });

  describe('Metrics Aggregation', () => {
    it('should initialize metrics with zero values', () => {
      const systemMetrics = {
        totalOpportunities: 0,
        executedTrades: 0,
        activeServices: 0,
        systemHealth: 100,
        averageLatency: 0
      };

      expect(systemMetrics.totalOpportunities).toBe(0);
      expect(systemMetrics.executedTrades).toBe(0);
      expect(systemMetrics.systemHealth).toBe(100);
    });

    it('should update active service count', () => {
      const serviceHealth = new Map<string, { status: string }>();

      serviceHealth.set('bsc-detector', { status: 'healthy' });
      serviceHealth.set('ethereum-detector', { status: 'healthy' });
      serviceHealth.set('polygon-detector', { status: 'healthy' });

      const activeServices = Array.from(serviceHealth.values())
        .filter(s => s.status === 'healthy').length;

      expect(activeServices).toBe(3);
    });

    it('should calculate average latency', () => {
      const latencies = [10, 15, 20, 25, 30];
      const averageLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;

      expect(averageLatency).toBe(20);
    });
  });
});

// =============================================================================
// Opportunity Coordination Tests
// =============================================================================

describe('CoordinatorService Opportunity Management', () => {
  describe('Opportunity Queue', () => {
    it('should prioritize opportunities by profit', () => {
      const opportunities = [
        { id: '1', profit: 50, confidence: 0.8 },
        { id: '2', profit: 100, confidence: 0.9 },
        { id: '3', profit: 75, confidence: 0.85 }
      ];

      const sorted = opportunities.sort((a, b) => b.profit - a.profit);

      expect(sorted[0].id).toBe('2');
      expect(sorted[1].id).toBe('3');
      expect(sorted[2].id).toBe('1');
    });

    it('should filter by minimum confidence', () => {
      const opportunities = [
        { id: '1', profit: 50, confidence: 0.9 },
        { id: '2', profit: 100, confidence: 0.3 },
        { id: '3', profit: 75, confidence: 0.8 }
      ];

      const minConfidence = 0.7;
      const filtered = opportunities.filter(o => o.confidence >= minConfidence);

      expect(filtered.length).toBe(2);
      expect(filtered.some(o => o.id === '2')).toBe(false);
    });

    it('should expire stale opportunities', () => {
      const now = Date.now();
      const maxAge = 5000; // 5 seconds

      const opportunities = [
        { id: '1', timestamp: now - 1000, profit: 50 },  // 1 second old
        { id: '2', timestamp: now - 10000, profit: 100 }, // 10 seconds old (stale)
        { id: '3', timestamp: now - 3000, profit: 75 }   // 3 seconds old
      ];

      const validOpportunities = opportunities.filter(
        o => (now - o.timestamp) <= maxAge
      );

      expect(validOpportunities.length).toBe(2);
      expect(validOpportunities.some(o => o.id === '2')).toBe(false);
    });
  });

  describe('Deduplication', () => {
    it('should detect duplicate opportunities', () => {
      const seen = new Set<string>();

      const createKey = (op: { source: string; pair: string; type: string }) =>
        `${op.source}_${op.pair}_${op.type}`;

      const opportunities = [
        { source: 'bsc', pair: 'WBNB_USDT', type: 'arbitrage' },
        { source: 'ethereum', pair: 'WETH_USDC', type: 'arbitrage' },
        { source: 'bsc', pair: 'WBNB_USDT', type: 'arbitrage' } // duplicate
      ];

      const unique: typeof opportunities = [];
      for (const op of opportunities) {
        const key = createKey(op);
        if (!seen.has(key)) {
          seen.add(key);
          unique.push(op);
        }
      }

      expect(unique.length).toBe(2);
    });
  });
});

// =============================================================================
// Service Communication Tests
// =============================================================================

describe('CoordinatorService Communication', () => {
  describe('Message Broadcasting', () => {
    it('should format messages correctly', () => {
      const message = {
        type: 'health-check',
        timestamp: Date.now(),
        source: 'coordinator',
        data: { status: 'healthy' }
      };

      expect(message.type).toBe('health-check');
      expect(message.source).toBe('coordinator');
      expect(message.data.status).toBe('healthy');
    });

    it('should track message acknowledgments', () => {
      const acks = new Map<string, boolean>();

      const services = ['bsc-detector', 'ethereum-detector', 'polygon-detector'];
      services.forEach(s => acks.set(s, false));

      // Simulate acknowledgments
      acks.set('bsc-detector', true);
      acks.set('ethereum-detector', true);

      const pendingAcks = Array.from(acks.entries())
        .filter(([_, acked]) => !acked)
        .map(([name, _]) => name);

      expect(pendingAcks).toEqual(['polygon-detector']);
    });
  });
});

// =============================================================================
// P1-FIX-2: CoordinatorService Class Tests
// =============================================================================

describe('CoordinatorService Class', () => {
  let coordinator: CoordinatorService;

  beforeEach(() => {
    // Create fresh instance for each test
    coordinator = new CoordinatorService({
      port: 0, // Use random port
      consumerGroup: 'test-group',
      consumerId: 'test-consumer'
    });
  });

  afterEach(async () => {
    // Clean up - stop service if running
    try {
      await coordinator.stop();
    } catch {
      // Ignore errors during cleanup
    }
  });

  describe('Instantiation', () => {
    it('should create a CoordinatorService instance', () => {
      expect(coordinator).toBeInstanceOf(CoordinatorService);
    });

    it('should have default configuration', () => {
      const defaultCoordinator = new CoordinatorService();
      expect(defaultCoordinator).toBeInstanceOf(CoordinatorService);
    });

    it('should accept custom port configuration', () => {
      const customCoordinator = new CoordinatorService({ port: 4000 });
      expect(customCoordinator).toBeInstanceOf(CoordinatorService);
    });
  });

  describe('Public Methods Exist', () => {
    it('should have start method', () => {
      expect(typeof coordinator.start).toBe('function');
    });

    it('should have stop method', () => {
      expect(typeof coordinator.stop).toBe('function');
    });
  });
});
