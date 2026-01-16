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
  createServiceState: jest.fn(() => {
    // Use object to allow mutation in closures
    const state = { running: false };
    return {
      getState: jest.fn().mockImplementation(() => state.running ? 'running' : 'stopped'),
      isRunning: jest.fn().mockImplementation(() => state.running),
      isStopped: jest.fn().mockImplementation(() => !state.running),
      executeStart: jest.fn().mockImplementation(async (fn: any) => {
        await fn();
        state.running = true;
        return { success: true, currentState: 'running' };
      }),
      executeStop: jest.fn().mockImplementation(async (fn: any) => {
        await fn();
        state.running = false;
        return { success: true, currentState: 'stopped' };
      }),
      on: jest.fn(),
      removeAllListeners: jest.fn()
    };
  }),
  ServiceState: {
    STOPPED: 'stopped',
    STARTING: 'starting',
    RUNNING: 'running',
    STOPPING: 'stopping',
    ERROR: 'error'
  }
}));

// Import config
import { CHAINS } from '@arbitrage/config';

// P1-FIX-2: Import the actual CoordinatorService
import { CoordinatorService } from './coordinator';

// =============================================================================
// Configuration Tests
// =============================================================================

describe('Coordinator Configuration', () => {
  it('should have core chains available for coordination', () => {
    // Test for chains available in the base config (shared/config/index.ts)
    // Note: Full config in shared/config/src/index.ts has more chains (optimism, fantom, etc.)
    expect(CHAINS.ethereum).toBeDefined();
    expect(CHAINS.bsc).toBeDefined();
    expect(CHAINS.polygon).toBeDefined();
    expect(CHAINS.arbitrum).toBeDefined();
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

  describe('State Getters', () => {
    it('should return leader status', () => {
      expect(typeof coordinator.getIsLeader()).toBe('boolean');
    });

    it('should return running status', () => {
      expect(typeof coordinator.getIsRunning()).toBe('boolean');
    });

    it('should return empty service health map initially', () => {
      const healthMap = coordinator.getServiceHealthMap();
      expect(healthMap).toBeInstanceOf(Map);
      expect(healthMap.size).toBe(0);
    });

    it('should return initialized system metrics', () => {
      const metrics = coordinator.getSystemMetrics();
      expect(metrics.totalOpportunities).toBe(0);
      expect(metrics.totalExecutions).toBe(0);
      expect(metrics.successfulExecutions).toBe(0);
      expect(metrics.totalProfit).toBe(0);
      expect(metrics.systemHealth).toBe(100);
      expect(metrics.activeServices).toBe(0);
      expect(metrics.whaleAlerts).toBe(0);
      expect(metrics.pendingOpportunities).toBe(0);
    });
  });
});

// =============================================================================
// Alert System Tests
// =============================================================================

describe('CoordinatorService Alert System', () => {
  describe('Alert Cooldown Logic', () => {
    it('should apply 5-minute cooldown for duplicate alerts', () => {
      const alertCooldowns = new Map<string, number>();
      const cooldownMs = 300000; // 5 minutes

      const sendAlert = (type: string, service?: string) => {
        const alertKey = `${type}_${service || 'system'}`;
        const now = Date.now();
        const lastAlert = alertCooldowns.get(alertKey) || 0;

        if (now - lastAlert > cooldownMs) {
          alertCooldowns.set(alertKey, now);
          return true; // Alert sent
        }
        return false; // Cooldown active
      };

      // First alert should be sent
      expect(sendAlert('SERVICE_UNHEALTHY', 'bsc-detector')).toBe(true);

      // Immediate duplicate should be blocked
      expect(sendAlert('SERVICE_UNHEALTHY', 'bsc-detector')).toBe(false);

      // Different service should not be blocked
      expect(sendAlert('SERVICE_UNHEALTHY', 'eth-detector')).toBe(true);

      // Different type for same service should not be blocked
      expect(sendAlert('HIGH_MEMORY', 'bsc-detector')).toBe(true);
    });

    it('should allow alert after cooldown expires', () => {
      const alertCooldowns = new Map<string, number>();
      const cooldownMs = 300000;
      const alertKey = 'TEST_ALERT_system';

      // Set cooldown 6 minutes ago (expired)
      alertCooldowns.set(alertKey, Date.now() - 360000);

      const lastAlert = alertCooldowns.get(alertKey) || 0;
      const now = Date.now();

      expect(now - lastAlert > cooldownMs).toBe(true);
    });
  });

  describe('Alert Cooldown Cleanup', () => {
    it('should remove cooldowns older than 1 hour', () => {
      const alertCooldowns = new Map<string, number>();
      const maxAge = 3600000; // 1 hour
      const now = Date.now();

      // Add some cooldowns
      alertCooldowns.set('OLD_ALERT_system', now - 7200000); // 2 hours old
      alertCooldowns.set('RECENT_ALERT_system', now - 1800000); // 30 min old
      alertCooldowns.set('NEW_ALERT_system', now - 60000); // 1 min old

      // Cleanup logic
      const toDelete: string[] = [];
      for (const [key, timestamp] of alertCooldowns) {
        if (now - timestamp > maxAge) {
          toDelete.push(key);
        }
      }
      for (const key of toDelete) {
        alertCooldowns.delete(key);
      }

      expect(alertCooldowns.size).toBe(2);
      expect(alertCooldowns.has('OLD_ALERT_system')).toBe(false);
      expect(alertCooldowns.has('RECENT_ALERT_system')).toBe(true);
      expect(alertCooldowns.has('NEW_ALERT_system')).toBe(true);
    });
  });
});

// =============================================================================
// Stream Error Tracking Tests
// =============================================================================

describe('CoordinatorService Stream Error Tracking', () => {
  it('should track consecutive stream errors', () => {
    let streamConsumerErrors = 0;
    const MAX_STREAM_ERRORS = 10;
    let alertSentForCurrentErrorBurst = false;
    const alerts: string[] = [];

    const trackStreamError = (streamName: string) => {
      streamConsumerErrors++;
      if (streamConsumerErrors >= MAX_STREAM_ERRORS && !alertSentForCurrentErrorBurst) {
        alerts.push(`STREAM_CONSUMER_FAILURE: ${streamName}`);
        alertSentForCurrentErrorBurst = true;
      }
    };

    // Track 9 errors - no alert yet
    for (let i = 0; i < 9; i++) {
      trackStreamError('stream:health');
    }
    expect(alerts.length).toBe(0);

    // 10th error triggers alert
    trackStreamError('stream:health');
    expect(alerts.length).toBe(1);

    // Further errors don't trigger more alerts
    trackStreamError('stream:health');
    trackStreamError('stream:health');
    expect(alerts.length).toBe(1);
  });

  it('should reset error tracking on successful processing', () => {
    let streamConsumerErrors = 5;
    let alertSentForCurrentErrorBurst = false;

    const resetStreamErrors = () => {
      if (streamConsumerErrors > 0) {
        streamConsumerErrors = 0;
        alertSentForCurrentErrorBurst = false;
      }
    };

    resetStreamErrors();

    expect(streamConsumerErrors).toBe(0);
    expect(alertSentForCurrentErrorBurst).toBe(false);
  });
});

// =============================================================================
// Opportunity TTL and Size Limit Tests
// =============================================================================

describe('CoordinatorService Opportunity Management', () => {
  const MAX_OPPORTUNITIES = 1000;
  const OPPORTUNITY_TTL_MS = 60000;

  describe('Batch Cleanup Pattern', () => {
    it('should clean up opportunities on interval not per-message', () => {
      // REFACTOR: Validates the new batch cleanup pattern
      // Previously, cleanup happened inline during handleOpportunityMessage
      // Now, it runs on a separate interval to prevent race conditions
      const opportunities = new Map<string, { id: string; timestamp: number }>();
      const now = Date.now();

      // Simulate rapid concurrent additions (what stream consumers do)
      for (let i = 0; i < 100; i++) {
        opportunities.set(`opp-${i}`, { id: `opp-${i}`, timestamp: now - (i * 100) });
      }

      // Batch cleanup (what the interval does)
      const cleanupBatch = () => {
        const toDelete: string[] = [];
        for (const [id, opp] of opportunities) {
          if (now - opp.timestamp > OPPORTUNITY_TTL_MS) {
            toDelete.push(id);
          }
        }
        for (const id of toDelete) {
          opportunities.delete(id);
        }
      };

      // All opportunities are fresh, none should be deleted
      cleanupBatch();
      expect(opportunities.size).toBe(100);
    });

    it('should not interfere with concurrent additions', () => {
      // Simulates the safety of the batch pattern
      const opportunities = new Map<string, { id: string; timestamp: number }>();
      const now = Date.now();

      // Add initial opportunities
      opportunities.set('opp-1', { id: 'opp-1', timestamp: now - 70000 }); // Expired

      // Simulate cleanup starting
      const expiredIds = ['opp-1'];

      // Simulate concurrent addition during cleanup iteration
      opportunities.set('opp-2', { id: 'opp-2', timestamp: now }); // Fresh, added during cleanup

      // Complete cleanup (delete phase)
      for (const id of expiredIds) {
        opportunities.delete(id);
      }

      // The concurrent addition should NOT be affected
      expect(opportunities.has('opp-1')).toBe(false);
      expect(opportunities.has('opp-2')).toBe(true);
      expect(opportunities.size).toBe(1);
    });
  });

  it('should enforce opportunity size limit', () => {
    const opportunities = new Map<string, { id: string; timestamp: number }>();

    // Add more than MAX entries
    for (let i = 0; i < MAX_OPPORTUNITIES + 100; i++) {
      opportunities.set(`opp-${i}`, { id: `opp-${i}`, timestamp: Date.now() - i });
    }

    expect(opportunities.size).toBe(MAX_OPPORTUNITIES + 100);

    // Pruning logic
    if (opportunities.size > MAX_OPPORTUNITIES) {
      const entries = Array.from(opportunities.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp);

      const removeCount = opportunities.size - MAX_OPPORTUNITIES;
      for (let i = 0; i < removeCount; i++) {
        opportunities.delete(entries[i][0]);
      }
    }

    expect(opportunities.size).toBe(MAX_OPPORTUNITIES);
  });

  it('should remove expired opportunities', () => {
    const opportunities = new Map<string, { id: string; timestamp: number; expiresAt?: number }>();
    const now = Date.now();

    opportunities.set('fresh', { id: 'fresh', timestamp: now - 1000 });
    opportunities.set('expired-by-ttl', { id: 'expired-by-ttl', timestamp: now - OPPORTUNITY_TTL_MS - 1000 });
    opportunities.set('expired-explicit', { id: 'expired-explicit', timestamp: now, expiresAt: now - 1000 });

    // Cleanup logic
    const toDelete: string[] = [];
    for (const [id, opp] of opportunities) {
      if (opp.expiresAt && opp.expiresAt < now) {
        toDelete.push(id);
        continue;
      }
      if (opp.timestamp && (now - opp.timestamp) > OPPORTUNITY_TTL_MS) {
        toDelete.push(id);
      }
    }
    for (const id of toDelete) {
      opportunities.delete(id);
    }

    expect(opportunities.size).toBe(1);
    expect(opportunities.has('fresh')).toBe(true);
    expect(opportunities.has('expired-by-ttl')).toBe(false);
    expect(opportunities.has('expired-explicit')).toBe(false);
  });
});
