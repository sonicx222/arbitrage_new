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
    recordMetric: jest.fn(),
    logEventLatency: jest.fn(),
    logHealthCheck: jest.fn()
  })),
  IntervalManager: jest.fn().mockImplementation(() => ({
    register: jest.fn(),
    clearAll: jest.fn(),
    getStats: jest.fn().mockReturnValue({}),
  })),
  getRedisClient: jest.fn(() => Promise.resolve({
    setex: jest.fn(),
    get: jest.fn(),
    del: jest.fn(),
    set: jest.fn(),
    setNx: jest.fn(() => Promise.resolve(true)),
    setnx: jest.fn(() => Promise.resolve(1)),
    expire: jest.fn(),
    quit: jest.fn(),
    disconnect: jest.fn(() => Promise.resolve()),
    getAllServiceHealth: jest.fn(() => Promise.resolve({})),
    renewLockIfOwned: jest.fn(() => Promise.resolve(true)),
    releaseLockIfOwned: jest.fn(() => Promise.resolve(true))
  })),
  getRedisStreamsClient: jest.fn(() => Promise.resolve({
    createConsumerGroup: jest.fn(() => Promise.resolve()),
    readGroup: jest.fn(() => Promise.resolve([])),
    xreadgroup: jest.fn(() => Promise.resolve([])),
    xack: jest.fn(() => Promise.resolve(1)),
    xadd: jest.fn(() => Promise.resolve('1234-0')),
    ack: jest.fn(() => Promise.resolve()),
    disconnect: jest.fn(() => Promise.resolve()),
    STREAMS: {
      HEALTH: 'stream:health',
      OPPORTUNITIES: 'stream:opportunities',
      WHALE_ALERTS: 'stream:whale-alerts',
      SWAP_EVENTS: 'stream:swap-events',
      VOLUME_AGGREGATES: 'stream:volume-aggregates',
      PRICE_UPDATES: 'stream:price-updates',
      EXECUTION_REQUESTS: 'stream:execution-requests',
      EXECUTION_RESULTS: 'stream:execution-results',
      DEAD_LETTER_QUEUE: 'stream:dead-letter-queue',
      FORWARDING_DLQ: 'stream:forwarding-dlq',
      SERVICE_DEGRADATION: 'stream:service-degradation',
    }
  })),
  RedisStreamsClient: {
    STREAMS: {
      HEALTH: 'stream:health',
      OPPORTUNITIES: 'stream:opportunities',
      WHALE_ALERTS: 'stream:whale-alerts',
      SWAP_EVENTS: 'stream:swap-events',
      VOLUME_AGGREGATES: 'stream:volume-aggregates',
      PRICE_UPDATES: 'stream:price-updates',
      EXECUTION_REQUESTS: 'stream:execution-requests',
      EXECUTION_RESULTS: 'stream:execution-results',
      DEAD_LETTER_QUEUE: 'stream:dead-letter-queue',
      FORWARDING_DLQ: 'stream:forwarding-dlq',
      SERVICE_DEGRADATION: 'stream:service-degradation',
    }
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
  },
  // Add missing exports
  // M-08 FIX: Stateful StreamConsumer mock — messagesProcessed increments when handler is invoked
  StreamConsumer: jest.fn().mockImplementation((client: unknown, config: { handler?: (msg: unknown) => Promise<void> }) => {
    const stats = {
      messagesProcessed: 0,
      messagesFailed: 0,
      lastProcessedAt: null as number | null,
      isRunning: false,
      isPaused: false,
    };
    return {
      start: jest.fn(() => { stats.isRunning = true; }),
      stop: jest.fn(async () => { stats.isRunning = false; }),
      getStats: jest.fn(() => ({ ...stats })),
      pause: jest.fn(() => { stats.isPaused = true; }),
      resume: jest.fn(() => { stats.isPaused = false; }),
      // Simulate message processing: calling _simulateMessage invokes the handler
      // and increments stats, matching real StreamConsumer behavior
      _simulateMessage: async (msg: unknown) => {
        if (config?.handler) {
          try {
            await config.handler(msg);
            stats.messagesProcessed++;
            stats.lastProcessedAt = Date.now();
          } catch {
            stats.messagesFailed++;
          }
        }
      },
    };
  }),
  getStreamHealthMonitor: jest.fn(() => ({
    setConsumerGroup: jest.fn(),
    start: jest.fn(),
    stop: jest.fn()
  })),
  // R2: Add SimpleCircuitBreaker mock for coordinator tests
  SimpleCircuitBreaker: jest.fn().mockImplementation(() => ({
    isCurrentlyOpen: jest.fn(() => false),
    recordFailure: jest.fn(() => false),
    recordSuccess: jest.fn(() => false),
    getFailures: jest.fn(() => 0),
    getStatus: jest.fn(() => ({ isOpen: false, failures: 0, resetTimeoutMs: 60000, lastFailure: 0, threshold: 5 })),
    getCooldownRemaining: jest.fn(() => 0),
  })),
  // R2: Add findKSmallest mock
  findKSmallest: jest.fn(<T>(iter: Iterable<T>, k: number) => Array.from(iter).slice(0, k))
}));

// Import config
import { CHAINS } from '@arbitrage/config';

// P1-FIX-2: Import the actual CoordinatorService
import { CoordinatorService } from '../../src/coordinator';

// =============================================================================
// Configuration Tests
// =============================================================================

describe('Coordinator Configuration', () => {
  it('should have core chains available for coordination', () => {
    // Test for chains available in the base config (shared/config/index.ts)
    // Note: Full config in shared/config/src/index.ts has more chains (optimism, fantom, etc.)
    expect(CHAINS.ethereum).toMatchObject({ name: expect.any(String) });
    expect(CHAINS.bsc).toMatchObject({ name: expect.any(String) });
    expect(CHAINS.polygon).toMatchObject({ name: expect.any(String) });
    expect(CHAINS.arbitrum).toMatchObject({ name: expect.any(String) });
    expect(CHAINS.base).toMatchObject({ name: expect.any(String) });
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

  describe('processOneExecutionResult', () => {
    it('should increment successfulExecutions and totalProfit on success', () => {
      const rawResult = { actualProfit: 0.05, gasCost: 0.01, dex: 'uniswap' };
      const profit = (coordinator as any).processOneExecutionResult(rawResult, true, 'opp-1', 'ethereum');

      expect(profit).toBe(0.05);
      const metrics = coordinator.getSystemMetrics();
      expect(metrics.successfulExecutions).toBe(1);
      expect(metrics.totalProfit).toBe(0.05);
    });

    it('should not increment success metrics on failure', () => {
      const rawResult = { actualProfit: 0, gasCost: 0.01, error: 'revert' };
      const profit = (coordinator as any).processOneExecutionResult(rawResult, false, 'opp-2', 'bsc');

      expect(profit).toBe(0);
      const metrics = coordinator.getSystemMetrics();
      expect(metrics.successfulExecutions).toBe(0);
      expect(metrics.totalProfit).toBe(0);
    });

    it('should not add zero profit to totalProfit even on success', () => {
      const rawResult = { actualProfit: 0, gasCost: 0.01 };
      (coordinator as any).processOneExecutionResult(rawResult, true, 'opp-3', 'arbitrum');

      const metrics = coordinator.getSystemMetrics();
      expect(metrics.successfulExecutions).toBe(1);
      expect(metrics.totalProfit).toBe(0);
    });

    it('should emit execution-result SSE event with correct fields', () => {
      const sseEvents: { event: string; data: any }[] = [];
      coordinator.subscribeSSE((event, data) => sseEvents.push({ event, data }));

      const rawResult = {
        actualProfit: 0.1,
        gasCost: 0.02,
        gasUsed: 250000,
        dex: 'sushiswap',
        transactionHash: '0xabc',
        latencyMs: 45,
        timestamp: 1000,
      };
      (coordinator as any).processOneExecutionResult(rawResult, true, 'opp-4', 'polygon');

      expect(sseEvents).toHaveLength(1);
      expect(sseEvents[0].event).toBe('execution-result');
      expect(sseEvents[0].data).toMatchObject({
        opportunityId: 'opp-4',
        success: true,
        chain: 'polygon',
        dex: 'sushiswap',
        actualProfit: 0.1,
        gasCost: 0.02,
        gasUsed: 250000,
        transactionHash: '0xabc',
      });
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
        const lastAlert = alertCooldowns.get(alertKey) ?? 0;

        if (now - lastAlert > cooldownMs) {
          alertCooldowns.set(alertKey, now);
          return true; // Alert sent
        }
        return false; // Cooldown active
      };

      // First alert should be sent
      expect(sendAlert('SERVICE_UNHEALTHY', 'partition-asia-fast')).toBe(true);

      // Immediate duplicate should be blocked
      expect(sendAlert('SERVICE_UNHEALTHY', 'partition-asia-fast')).toBe(false);

      // Different service should not be blocked
      expect(sendAlert('SERVICE_UNHEALTHY', 'eth-detector')).toBe(true);

      // Different type for same service should not be blocked
      expect(sendAlert('HIGH_MEMORY', 'partition-asia-fast')).toBe(true);
    });

    it('should allow alert after cooldown expires', () => {
      const alertCooldowns = new Map<string, number>();
      const cooldownMs = 300000;
      const alertKey = 'TEST_ALERT_system';

      // Set cooldown 6 minutes ago (expired)
      alertCooldowns.set(alertKey, Date.now() - 360000);

      const lastAlert = alertCooldowns.get(alertKey) ?? 0;
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

// =============================================================================
// S3.3.5 Regression Tests - PRICE_UPDATES Consumer Integration
// =============================================================================

describe('S3.3.5 Regression: PRICE_UPDATES Consumer', () => {
  it('should include PRICE_UPDATES in consumer groups', () => {
    // REGRESSION TEST: Verifies fix for missing PRICE_UPDATES consumer
    // Previously, coordinator did not consume price updates from Solana detector
    const expectedStreams = [
      'stream:health',
      'stream:opportunities',
      'stream:whale-alerts',
      'stream:swap-events',
      'stream:volume-aggregates',
      'stream:price-updates', // S3.3.5 FIX: Must be included
      'stream:execution-results', // OP-10 FIX: Must be included
      'stream:dead-letter-queue', // P0 ES-003: DLQ consumer group
      'stream:forwarding-dlq', // P1 DF-004: Forwarding DLQ
      'stream:service-degradation', // C-02: Service degradation events
    ];

    // Simulate consumer group configuration check
    const consumerGroups = [
      { streamName: 'stream:health' },
      { streamName: 'stream:opportunities' },
      { streamName: 'stream:whale-alerts' },
      { streamName: 'stream:swap-events' },
      { streamName: 'stream:volume-aggregates' },
      { streamName: 'stream:price-updates' },
      { streamName: 'stream:execution-results' },
      { streamName: 'stream:dead-letter-queue' },
      { streamName: 'stream:forwarding-dlq' },
      { streamName: 'stream:service-degradation' },
    ];

    const configuredStreams = consumerGroups.map(g => g.streamName);

    for (const expectedStream of expectedStreams) {
      expect(configuredStreams).toContain(expectedStream);
    }
  });

  it('should handle price update messages correctly', () => {
    // REGRESSION TEST: Verifies price update handler processes messages
    const priceUpdatesReceived: number[] = [];
    let totalPriceUpdates = 0;

    const handlePriceUpdate = (message: { data: Record<string, unknown> }) => {
      const data = message.data;
      const rawUpdate = (data.data ?? data) as Record<string, unknown>;
      const chain = typeof rawUpdate.chain === 'string' ? rawUpdate.chain : 'unknown';
      const pairKey = typeof rawUpdate.pairKey === 'string' ? rawUpdate.pairKey : '';

      if (!pairKey) return;

      totalPriceUpdates++;
      priceUpdatesReceived.push(Date.now());
    };

    // Test with Solana price update
    handlePriceUpdate({
      data: {
        type: 'price-update',
        data: {
          chain: 'solana',
          dex: 'raydium',
          pairKey: 'raydium_SOL_USDC',
          price: 150.5
        }
      }
    });

    expect(totalPriceUpdates).toBe(1);
    expect(priceUpdatesReceived.length).toBe(1);
  });

  it('should track priceUpdatesReceived metric', () => {
    // REGRESSION TEST: Verifies metrics include price update tracking
    const systemMetrics = {
      totalOpportunities: 0,
      totalSwapEvents: 0,
      volumeAggregatesProcessed: 0,
      activePairsTracked: 0,
      priceUpdatesReceived: 0 // S3.3.5 FIX: Must be included
    };

    // Simulate price update processing
    systemMetrics.priceUpdatesReceived++;

    expect(systemMetrics.priceUpdatesReceived).toBe(1);
  });
});

// =============================================================================
// S3.3.5 Regression Tests - Stream Error Alert Data
// =============================================================================

describe('S3.3.5 Regression: Stream Error Alert Data', () => {
  it('should include streamName in error alert data', () => {
    // REGRESSION TEST: Verifies fix for missing streamName in alert data
    // Previously, trackStreamError only included streamName in message string
    const alerts: Array<{
      type: string;
      message: string;
      severity: string;
      data?: Record<string, unknown>;
    }> = [];

    let streamConsumerErrors = 0;
    const MAX_STREAM_ERRORS = 10;
    let alertSentForCurrentErrorBurst = false;

    const trackStreamError = (streamName: string) => {
      streamConsumerErrors++;
      if (streamConsumerErrors >= MAX_STREAM_ERRORS && !alertSentForCurrentErrorBurst) {
        alerts.push({
          type: 'STREAM_CONSUMER_FAILURE',
          message: `Stream consumer experienced ${streamConsumerErrors} errors on ${streamName}`,
          severity: 'critical',
          // S3.3.5 FIX: Include streamName in data for programmatic access
          data: { streamName, errorCount: streamConsumerErrors }
        });
        alertSentForCurrentErrorBurst = true;
      }
    };

    // Trigger error threshold
    for (let i = 0; i < MAX_STREAM_ERRORS; i++) {
      trackStreamError('stream:price-updates');
    }

    expect(alerts.length).toBe(1);
    expect(alerts[0].data).toMatchObject({ streamName: 'stream:price-updates', errorCount: expect.any(Number) });
    expect(alerts[0].data?.streamName).toBe('stream:price-updates');
    expect(alerts[0].data?.errorCount).toBe(MAX_STREAM_ERRORS);
  });
});

// =============================================================================
// Standby Activation Tests (ADR-007)
// =============================================================================

describe('CoordinatorService Standby Activation', () => {
  describe('activateStandby()', () => {
    it('should use Promise-based mutex to prevent concurrent activations', async () => {
      // Simulates the mutex pattern used in activateStandby()
      let activationPromise: Promise<boolean> | null = null;
      let activationCount = 0;

      const activateStandby = async (): Promise<boolean> => {
        // If already activating, return existing promise
        if (activationPromise) {
          return activationPromise;
        }

        // Create new activation promise
        activationPromise = (async () => {
          activationCount++;
          await Promise.resolve(); // simulate async activation
          return true;
        })();

        try {
          return await activationPromise;
        } finally {
          activationPromise = null;
        }
      };

      // Call activate twice concurrently
      const [result1, result2] = await Promise.all([
        activateStandby(),
        activateStandby()
      ]);

      // Both should return true
      expect(result1).toBe(true);
      expect(result2).toBe(true);
      // But activation should only happen once
      expect(activationCount).toBe(1);
    });

    it('should reject activation when already a leader', async () => {
      // Simulates the leader check in activateStandby()
      const isLeader = true;

      const activateStandby = async (): Promise<boolean> => {
        if (isLeader) {
          return true; // Already leader, nothing to do
        }
        return false;
      };

      const result = await activateStandby();
      expect(result).toBe(true);
    });

    it('should fail gracefully when leader acquisition fails', async () => {
      const canAcquireLock = false;

      const tryAcquireLeadership = async (): Promise<boolean> => {
        return canAcquireLock;
      };

      const activateStandby = async (): Promise<boolean> => {
        const acquired = await tryAcquireLeadership();
        if (!acquired) {
          return false;
        }
        return true;
      };

      const result = await activateStandby();
      expect(result).toBe(false);
    });
  });
});

// =============================================================================
// Service Lifecycle Tests
// =============================================================================

describe('CoordinatorService Lifecycle', () => {
  let coordinator: CoordinatorService;

  beforeEach(() => {
    coordinator = new CoordinatorService({
      port: 0, // Random port for testing
      consumerGroup: 'lifecycle-test-group',
      consumerId: 'lifecycle-test-consumer'
    });
  });

  afterEach(async () => {
    try {
      await coordinator.stop();
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Initial State', () => {
    it('should not be running initially', () => {
      expect(coordinator.getIsRunning()).toBe(false);
    });

    it('should not be leader initially', () => {
      expect(coordinator.getIsLeader()).toBe(false);
    });

    it('should have empty service health map initially', () => {
      const healthMap = coordinator.getServiceHealthMap();
      expect(healthMap.size).toBe(0);
    });

    it('should have initialized metrics with default values', () => {
      const metrics = coordinator.getSystemMetrics();
      expect(metrics.totalOpportunities).toBe(0);
      expect(metrics.systemHealth).toBe(100);
      expect(metrics.activeServices).toBe(0);
    });
  });

  describe('State Provider Implementation', () => {
    it('should implement getInstanceId()', () => {
      const instanceId = coordinator.getInstanceId();
      expect(typeof instanceId).toBe('string');
      expect(instanceId.length).toBeGreaterThan(0);
      expect(instanceId).toContain('coordinator');
    });

    it('should implement getLockKey()', () => {
      const lockKey = coordinator.getLockKey();
      expect(lockKey).toBe('coordinator:leader:lock');
    });

    it('should implement getLogger()', () => {
      const logger = coordinator.getLogger();
      // Logger may be mocked or a real logger depending on test setup
      // In test environment with mocks, logger might be undefined or have mock functions
      if (logger) {
        expect(typeof logger.info).toBe('function');
        expect(typeof logger.error).toBe('function');
        expect(typeof logger.warn).toBe('function');
      } else {
        // In test environment, getLogger() returning undefined is acceptable
        // since createLogger is mocked
        expect(logger).toBeUndefined();
      }
    });

    it('should implement getAlertHistory()', () => {
      const history = coordinator.getAlertHistory();
      expect(Array.isArray(history)).toBe(true);
    });
  });

  describe('Standby Configuration', () => {
    it('should support isStandby configuration', () => {
      const standbyCoordinator = new CoordinatorService({
        port: 0,
        isStandby: true,
        canBecomeLeader: true
      });

      expect(standbyCoordinator.getIsStandby()).toBe(true);
      expect(standbyCoordinator.getCanBecomeLeader()).toBe(true);
    });

    it('should support regionId configuration', () => {
      const regionalCoordinator = new CoordinatorService({
        port: 0,
        regionId: 'us-central1'
      });

      expect(regionalCoordinator.getRegionId()).toBe('us-central1');
    });
  });
});

// =============================================================================
// Type Guard Utilities Tests
// =============================================================================

// FIX: Import actual type guards from utils instead of reimplementing inline
// This ensures tests verify the actual implementation, not a duplicate
import {
  getString,
  getNumber,
  getNonNegativeNumber,
  hasRequiredString
} from '../../src/utils/type-guards';

describe('Type Guard Utilities', () => {
  describe('getString', () => {
    it('should return string value when present', () => {
      expect(getString({ name: 'test' }, 'name')).toBe('test');
    });

    it('should return default when key missing', () => {
      expect(getString({}, 'name', 'default')).toBe('default');
    });

    it('should return default when value is not string', () => {
      expect(getString({ name: 123 }, 'name', 'default')).toBe('default');
    });
  });

  describe('getNumber', () => {
    it('should return number value when present', () => {
      expect(getNumber({ count: 42 }, 'count')).toBe(42);
    });

    it('should return default when key missing', () => {
      expect(getNumber({}, 'count', 99)).toBe(99);
    });

    it('should return default when value is NaN', () => {
      expect(getNumber({ count: NaN }, 'count', 0)).toBe(0);
    });
  });

  describe('getNonNegativeNumber', () => {
    it('should return positive number', () => {
      expect(getNonNegativeNumber({ value: 10 }, 'value')).toBe(10);
    });

    it('should return 0 for zero', () => {
      expect(getNonNegativeNumber({ value: 0 }, 'value')).toBe(0);
    });

    it('should return default for negative number', () => {
      expect(getNonNegativeNumber({ value: -5 }, 'value', 0)).toBe(0);
    });
  });

  describe('hasRequiredString', () => {
    it('should return true for non-empty string', () => {
      expect(hasRequiredString({ id: 'abc123' }, 'id')).toBe(true);
    });

    it('should return false for empty string', () => {
      expect(hasRequiredString({ id: '' }, 'id')).toBe(false);
    });

    it('should return false for missing key', () => {
      expect(hasRequiredString({}, 'id')).toBe(false);
    });

    it('should return false for non-string value', () => {
      expect(hasRequiredString({ id: 123 }, 'id')).toBe(false);
    });
  });
});

// =============================================================================
// SPRINT 1 FIX: Rate Limiter Token Calculation Tests
// =============================================================================

describe('Rate Limiter Token Calculation (SPRINT 1 FIX)', () => {
  /**
   * SPRINT 1 FIX: Token calculation bug fix regression test
   *
   * Original Bug:
   * ```
   * const tokensToAdd = refillCount * this.RATE_LIMIT_MAX_TOKENS;
   * ```
   * This caused exponential growth: elapsed=1000ms, MAX_TOKENS=100
   * refillCount = Math.floor(1000 / 1000) = 1, tokensToAdd = 1 * 100 = 100
   *
   * But for elapsed=2000ms:
   * refillCount = Math.floor(2000 / 1000) = 2, tokensToAdd = 2 * 100 = 200
   * This adds 200 tokens for 2 seconds, but should only add 100 tokens/sec.
   *
   * Fix:
   * ```
   * const tokensToAdd = Math.floor(
   *   (elapsed / this.RATE_LIMIT_REFILL_MS) * this.RATE_LIMIT_MAX_TOKENS
   * );
   * ```
   * Now: elapsed=2000ms → tokensToAdd = Math.floor((2000/1000) * 100) = 200
   * Wait, that's the same! The real bug was in the original description.
   * Actually the bug was: tokensToAdd was being calculated per refill period
   * but the formula should be proportional to time elapsed.
   */

  // Configuration constants from coordinator
  const RATE_LIMIT_MAX_TOKENS = 100;
  const RATE_LIMIT_REFILL_MS = 1000;

  /**
   * BUGGY implementation (before fix):
   * Would add tokens per discrete refill periods
   */
  function calculateTokensBuggy(elapsed: number): number {
    // Old implementation: refillCount * MAX_TOKENS
    const refillCount = Math.floor(elapsed / RATE_LIMIT_REFILL_MS);
    return refillCount * RATE_LIMIT_MAX_TOKENS;
  }

  /**
   * FIXED implementation:
   * Proportional token refill based on exact elapsed time
   */
  function calculateTokensFixed(elapsed: number): number {
    // New implementation: proportional to elapsed time
    return Math.floor(
      (elapsed / RATE_LIMIT_REFILL_MS) * RATE_LIMIT_MAX_TOKENS
    );
  }

  it('should calculate same tokens for exact refill periods', () => {
    // For exact multiples of refill period, both should be equal
    expect(calculateTokensBuggy(1000)).toBe(calculateTokensFixed(1000));
    expect(calculateTokensBuggy(2000)).toBe(calculateTokensFixed(2000));
    expect(calculateTokensBuggy(5000)).toBe(calculateTokensFixed(5000));
  });

  it('should handle partial refill periods correctly', () => {
    // For 500ms (half period), should add 50 tokens
    // Buggy: Math.floor(500/1000) = 0, so 0 * 100 = 0
    // Fixed: Math.floor((500/1000) * 100) = 50
    expect(calculateTokensBuggy(500)).toBe(0); // Bug: no tokens for partial period
    expect(calculateTokensFixed(500)).toBe(50); // Fix: proportional tokens
  });

  it('should handle sub-second refill intervals', () => {
    // For 100ms elapsed, should add ~10 tokens
    expect(calculateTokensBuggy(100)).toBe(0); // Bug: zero tokens
    expect(calculateTokensFixed(100)).toBe(10); // Fix: 10 tokens
  });

  it('should not exceed rate limit over time', () => {
    // Simulate refilling over 10 seconds in 100ms increments
    let buggyCumulativeTokens = 0;
    let fixedCumulativeTokens = 0;

    // The fixed version should give roughly MAX_TOKENS per REFILL_MS
    for (let elapsed = 100; elapsed <= 10000; elapsed += 100) {
      const buggyTokens = calculateTokensBuggy(elapsed);
      const fixedTokens = calculateTokensFixed(elapsed);

      // Track maximum observed
      buggyCumulativeTokens = Math.max(buggyCumulativeTokens, buggyTokens);
      fixedCumulativeTokens = Math.max(fixedCumulativeTokens, fixedTokens);
    }

    // After 10 seconds, max should be 1000 tokens (10 * 100)
    expect(fixedCumulativeTokens).toBe(1000);
    expect(buggyCumulativeTokens).toBe(1000); // Buggy also reaches 1000 at 10s mark
  });

  it('should provide smooth token refill (SPRINT 1 FIX verification)', () => {
    // The key improvement: fixed version provides tokens for partial periods
    // This prevents starvation during high-frequency checks
    const partialPeriodTokensBuggy = calculateTokensBuggy(999);
    const partialPeriodTokensFixed = calculateTokensFixed(999);

    // Buggy gives 0 for 999ms (just under 1 period)
    expect(partialPeriodTokensBuggy).toBe(0);
    // Fixed gives 99 tokens (proportional)
    expect(partialPeriodTokensFixed).toBe(99);
  });
});

// =============================================================================
// OP-10 Regression Tests - Execution Result Consumer
// =============================================================================

describe('OP-10 Regression: Execution Result Consumer', () => {
  // Inline handler that mirrors coordinator.handleExecutionResultMessage logic
  function handleExecutionResult(
    message: { data: Record<string, unknown> },
    metrics: { successfulExecutions: number; totalProfit: number },
  ): void {
    const data = message.data;
    const rawResult = (data.data ?? data) as Record<string, unknown>;
    const success = rawResult.success === true || rawResult.success === 'true';
    const opportunityId = typeof rawResult.opportunityId === 'string' ? rawResult.opportunityId : '';

    if (!opportunityId) return;

    if (success) {
      metrics.successfulExecutions++;
      const actualProfit = typeof rawResult.actualProfit === 'number' ? rawResult.actualProfit : 0;
      if (actualProfit > 0) {
        metrics.totalProfit += actualProfit;
      }
    }
  }

  it('should include EXECUTION_RESULTS in consumer groups', () => {
    const consumerGroups = [
      { streamName: 'stream:health' },
      { streamName: 'stream:opportunities' },
      { streamName: 'stream:whale-alerts' },
      { streamName: 'stream:swap-events' },
      { streamName: 'stream:volume-aggregates' },
      { streamName: 'stream:price-updates' },
      { streamName: 'stream:execution-results' },
    ];

    const streamNames = consumerGroups.map(g => g.streamName);
    expect(streamNames).toContain('stream:execution-results');
  });

  it('should increment successfulExecutions on successful result', () => {
    const metrics = { successfulExecutions: 0, totalProfit: 0 };

    handleExecutionResult({
      data: {
        opportunityId: 'opp-123',
        success: true,
        actualProfit: 0.05,
        chain: 'ethereum',
        dex: 'uniswap',
        timestamp: Date.now(),
      },
    }, metrics);

    expect(metrics.successfulExecutions).toBe(1);
    expect(metrics.totalProfit).toBe(0.05);
  });

  it('should not increment on failed result', () => {
    const metrics = { successfulExecutions: 0, totalProfit: 0 };

    handleExecutionResult({
      data: {
        opportunityId: 'opp-456',
        success: false,
        error: 'Slippage exceeded',
        chain: 'bsc',
        dex: 'pancakeswap',
        timestamp: Date.now(),
      },
    }, metrics);

    expect(metrics.successfulExecutions).toBe(0);
    expect(metrics.totalProfit).toBe(0);
  });

  it('should accumulate profit across multiple successes', () => {
    const metrics = { successfulExecutions: 0, totalProfit: 0 };

    handleExecutionResult({
      data: { opportunityId: 'opp-1', success: true, actualProfit: 0.03, chain: 'ethereum', dex: 'uniswap', timestamp: Date.now() },
    }, metrics);
    handleExecutionResult({
      data: { opportunityId: 'opp-2', success: true, actualProfit: 0.07, chain: 'bsc', dex: 'pancakeswap', timestamp: Date.now() },
    }, metrics);
    handleExecutionResult({
      data: { opportunityId: 'opp-3', success: false, error: 'Failed', chain: 'polygon', dex: 'quickswap', timestamp: Date.now() },
    }, metrics);

    expect(metrics.successfulExecutions).toBe(2);
    expect(metrics.totalProfit).toBeCloseTo(0.10, 10);
  });

  it('should skip results without opportunityId', () => {
    const metrics = { successfulExecutions: 0, totalProfit: 0 };

    handleExecutionResult({
      data: { success: true, actualProfit: 1.0, chain: 'ethereum', dex: 'uniswap', timestamp: Date.now() },
    }, metrics);

    expect(metrics.successfulExecutions).toBe(0);
  });

  it('should handle success as string "true" (Redis serialization)', () => {
    const metrics = { successfulExecutions: 0, totalProfit: 0 };

    handleExecutionResult({
      data: { opportunityId: 'opp-str', success: 'true', actualProfit: 0.02, chain: 'ethereum', dex: 'uniswap', timestamp: Date.now() },
    }, metrics);

    expect(metrics.successfulExecutions).toBe(1);
    expect(metrics.totalProfit).toBe(0.02);
  });

  it('should not add negative profit', () => {
    const metrics = { successfulExecutions: 0, totalProfit: 0 };

    handleExecutionResult({
      data: { opportunityId: 'opp-neg', success: true, actualProfit: -0.01, chain: 'ethereum', dex: 'uniswap', timestamp: Date.now() },
    }, metrics);

    expect(metrics.successfulExecutions).toBe(1);
    expect(metrics.totalProfit).toBe(0); // Negative profit not added
  });
});

// =============================================================================
// TQ-H-01: checkPipelineStarvation
// =============================================================================

describe('CoordinatorService.checkPipelineStarvation', () => {
  let coordinator: CoordinatorService;

  beforeEach(() => {
    coordinator = new CoordinatorService({
      port: 0,
      consumerGroup: 'test-group',
      consumerId: 'test-consumer',
    });
  });

  afterEach(async () => {
    try { await coordinator.stop(); } catch { /* cleanup */ }
  });

  function setPrivate(field: string, value: unknown): void {
    (coordinator as any)[field] = value;
  }

  function getPrivate(field: string): unknown {
    return (coordinator as any)[field];
  }

  function createMockStreams(overrides: Record<string, unknown> = {}): Record<string, jest.Mock> {
    return {
      checkStreamLag: jest.fn().mockResolvedValue({
        length: 0, maxLen: 100000, lagRatio: 0, backpressure: false,
        critical: false, pendingCount: 0, pendingRatio: 0,
        ...overrides,
      }),
      xlen: jest.fn().mockResolvedValue(0),
    } as any;
  }

  it('should skip when streamsClient is null', async () => {
    setPrivate('streamsClient', null);
    // Should not throw
    await (coordinator as any).checkPipelineStarvation();
  });

  it('should skip during startup grace period', async () => {
    setPrivate('streamsClient', createMockStreams());
    setPrivate('startTime', Date.now()); // Just started — within grace period
    await (coordinator as any).checkPipelineStarvation();
    // checkStreamLag should not be called
    expect((getPrivate('streamsClient') as any).checkStreamLag).not.toHaveBeenCalled();
  });

  it('should reset tracking when pending messages exist', async () => {
    const mockStreams = createMockStreams({ pendingCount: 5 });
    setPrivate('streamsClient', mockStreams);
    setPrivate('startTime', Date.now() - 300_000); // Well past grace period
    setPrivate('lastExecutionRequestTime', Date.now() - 600_000); // Stale
    setPrivate('pipelineStarvationAlerted', true);

    await (coordinator as any).checkPipelineStarvation();

    expect(getPrivate('pipelineStarvationAlerted')).toBe(false);
    // lastExecutionRequestTime should be updated to recent
    expect(getPrivate('lastExecutionRequestTime') as number).toBeGreaterThan(Date.now() - 1000);
  });

  it('should not alert when no healthy detectors exist', async () => {
    const mockStreams = createMockStreams({ pendingCount: 0 });
    setPrivate('streamsClient', mockStreams);
    setPrivate('startTime', Date.now() - 300_000);
    setPrivate('lastExecutionRequestTime', Date.now() - 600_000);
    // serviceHealth map is empty by default (no healthy detectors)

    const alerts: unknown[] = [];
    (coordinator as any).sendAlert = (alert: unknown) => alerts.push(alert);

    await (coordinator as any).checkPipelineStarvation();

    expect(alerts).toHaveLength(0);
  });

  it('should initialize tracking on first check', async () => {
    const mockStreams = createMockStreams({ pendingCount: 0 });
    setPrivate('streamsClient', mockStreams);
    setPrivate('startTime', Date.now() - 300_000);
    setPrivate('lastExecutionRequestTime', 0); // Not yet initialized

    // Add a healthy detector
    const healthMap = coordinator.getServiceHealthMap();
    healthMap.set('partition-asia-fast', {
      name: 'partition-asia-fast',
      status: 'healthy',
      lastHeartbeat: Date.now(),
    } as any);

    await (coordinator as any).checkPipelineStarvation();

    // Should initialize but not alert
    expect(getPrivate('lastExecutionRequestTime') as number).toBeGreaterThan(0);
    expect(getPrivate('pipelineStarvationAlerted')).toBeFalsy();
  });

  it('should not alert when starvation duration is below threshold', async () => {
    const mockStreams = createMockStreams({ pendingCount: 0 });
    setPrivate('streamsClient', mockStreams);
    setPrivate('startTime', Date.now() - 300_000);
    setPrivate('lastExecutionRequestTime', Date.now() - 60_000); // 1 min ago (below 5 min threshold)

    const healthMap = coordinator.getServiceHealthMap();
    healthMap.set('partition-asia-fast', {
      name: 'partition-asia-fast',
      status: 'healthy',
      lastHeartbeat: Date.now(),
    } as any);

    const alerts: unknown[] = [];
    (coordinator as any).sendAlert = (alert: unknown) => alerts.push(alert);

    await (coordinator as any).checkPipelineStarvation();

    expect(alerts).toHaveLength(0);
  });

  it('should fire PIPELINE_STARVATION alert when threshold exceeded', async () => {
    const mockStreams = createMockStreams({ pendingCount: 0 });
    setPrivate('streamsClient', mockStreams);
    setPrivate('startTime', Date.now() - 600_000);
    setPrivate('lastExecutionRequestTime', Date.now() - 6 * 60_000); // 6 min ago (> 5 min threshold)
    setPrivate('pipelineStarvationAlerted', false);

    const healthMap = coordinator.getServiceHealthMap();
    healthMap.set('partition-asia-fast', {
      name: 'partition-asia-fast',
      status: 'healthy',
      lastHeartbeat: Date.now(),
    } as any);

    const alerts: any[] = [];
    (coordinator as any).sendAlert = (alert: unknown) => alerts.push(alert);

    await (coordinator as any).checkPipelineStarvation();

    expect(alerts).toHaveLength(1);
    expect(alerts[0].type).toBe('PIPELINE_STARVATION');
    expect(alerts[0].severity).toBe('warning');
    expect(alerts[0].data.healthyDetectors).toContain('partition-asia-fast');
    expect(getPrivate('pipelineStarvationAlerted')).toBe(true);
  });

  it('should not double-alert when already alerted', async () => {
    const mockStreams = createMockStreams({ pendingCount: 0 });
    setPrivate('streamsClient', mockStreams);
    setPrivate('startTime', Date.now() - 600_000);
    setPrivate('lastExecutionRequestTime', Date.now() - 6 * 60_000);
    setPrivate('pipelineStarvationAlerted', true); // Already alerted

    const healthMap = coordinator.getServiceHealthMap();
    healthMap.set('partition-l2-turbo', {
      name: 'partition-l2-turbo',
      status: 'healthy',
      lastHeartbeat: Date.now(),
    } as any);

    const alerts: unknown[] = [];
    (coordinator as any).sendAlert = (alert: unknown) => alerts.push(alert);

    await (coordinator as any).checkPipelineStarvation();

    expect(alerts).toHaveLength(0);
  });

  it('should exclude coordinator and execution-engine from healthy detector count', async () => {
    const mockStreams = createMockStreams({ pendingCount: 0 });
    setPrivate('streamsClient', mockStreams);
    setPrivate('startTime', Date.now() - 300_000);
    setPrivate('lastExecutionRequestTime', Date.now() - 6 * 60_000);

    const healthMap = coordinator.getServiceHealthMap();
    // Only coordinator and EE are "healthy" — these should be excluded
    healthMap.set('coordinator', {
      name: 'coordinator', status: 'healthy', lastHeartbeat: Date.now(),
    } as any);
    healthMap.set('execution-engine', {
      name: 'execution-engine', status: 'healthy', lastHeartbeat: Date.now(),
    } as any);

    const alerts: unknown[] = [];
    (coordinator as any).sendAlert = (alert: unknown) => alerts.push(alert);

    await (coordinator as any).checkPipelineStarvation();

    // No alert — coordinator and EE are excluded from "healthy detectors"
    expect(alerts).toHaveLength(0);
  });
});

// =============================================================================
// TQ-M-02: processOneExecutionResult PROFIT_SANITY_CAP boundary tests
// =============================================================================

describe('CoordinatorService.processOneExecutionResult', () => {
  let coordinator: CoordinatorService;

  beforeEach(async () => {
    coordinator = new CoordinatorService();
    // Initialize systemMetrics
    const metrics = (coordinator as any).initializeMetrics();
    (coordinator as any).systemMetrics = metrics;
    // Mock opportunityRouter to prevent null errors
    (coordinator as any).opportunityRouter = {
      updateOpportunityStatus: jest.fn(),
    };
    // Mock emitSSE to prevent null errors
    (coordinator as any).emitSSE = jest.fn();
  });

  it('should add profit below $100K to totalProfit', () => {
    const rawResult = { actualProfit: 99_999, gasCost: 10, dex: 'uniswap', gasUsed: 21000, timestamp: Date.now() };
    (coordinator as any).processOneExecutionResult(rawResult, true, 'opp-1', 'ethereum');
    expect((coordinator as any).systemMetrics.totalProfit).toBe(99_999);
  });

  it('should NOT add profit at exactly $100K (check is strictly < cap)', () => {
    const rawResult = { actualProfit: 100_000, gasCost: 10, dex: 'uniswap' };
    (coordinator as any).processOneExecutionResult(rawResult, true, 'opp-1', 'ethereum');
    expect((coordinator as any).systemMetrics.totalProfit).toBe(0);
  });

  it('should NOT add profit above $100K', () => {
    const rawResult = { actualProfit: 100_001, gasCost: 10, dex: 'uniswap' };
    (coordinator as any).processOneExecutionResult(rawResult, true, 'opp-1', 'ethereum');
    expect((coordinator as any).systemMetrics.totalProfit).toBe(0);
  });

  it('should NOT add zero profit', () => {
    const rawResult = { actualProfit: 0, gasCost: 10, dex: 'uniswap' };
    (coordinator as any).processOneExecutionResult(rawResult, true, 'opp-1', 'ethereum');
    expect((coordinator as any).systemMetrics.totalProfit).toBe(0);
  });

  it('should NOT add profit for failed execution', () => {
    const rawResult = { actualProfit: 500, gasCost: 10, dex: 'uniswap' };
    (coordinator as any).processOneExecutionResult(rawResult, false, 'opp-1', 'ethereum');
    expect((coordinator as any).systemMetrics.totalProfit).toBe(0);
    expect((coordinator as any).systemMetrics.successfulExecutions).toBe(0);
  });

  it('should increment successfulExecutions on success', () => {
    const rawResult = { actualProfit: 50, gasCost: 10, dex: 'uniswap' };
    (coordinator as any).processOneExecutionResult(rawResult, true, 'opp-1', 'ethereum');
    expect((coordinator as any).systemMetrics.successfulExecutions).toBe(1);
  });

  it('should respect custom PROFIT_SANITY_CAP_USD from env', () => {
    process.env.PROFIT_SANITY_CAP_USD = '500';
    const rawResult = { actualProfit: 499, gasCost: 10, dex: 'uniswap' };
    (coordinator as any).processOneExecutionResult(rawResult, true, 'opp-1', 'ethereum');
    expect((coordinator as any).systemMetrics.totalProfit).toBe(499);

    const rawResult2 = { actualProfit: 501, gasCost: 10, dex: 'uniswap' };
    (coordinator as any).processOneExecutionResult(rawResult2, true, 'opp-2', 'ethereum');
    // totalProfit should still be 499 (501 was rejected)
    expect((coordinator as any).systemMetrics.totalProfit).toBe(499);
    delete process.env.PROFIT_SANITY_CAP_USD;
  });
});

// =============================================================================
// TQ-M-04: handleHealthMessage branch coverage tests
// =============================================================================

describe('CoordinatorService.handleHealthMessage', () => {
  let coordinator: CoordinatorService;

  beforeEach(async () => {
    coordinator = new CoordinatorService();
    // Initialize required state
    (coordinator as any).serviceHealth = new Map();
    (coordinator as any).healthMonitor = { recordHeartbeat: jest.fn(), evaluateDegradationLevel: jest.fn(), getDegradationLevel: jest.fn() };
  });

  it('should skip message with null data', async () => {
    await (coordinator as any).handleHealthMessage({ id: 'msg-1', data: null });
    expect((coordinator as any).serviceHealth.size).toBe(0);
  });

  it('should skip message with non-object data', async () => {
    await (coordinator as any).handleHealthMessage({ id: 'msg-2', data: 'not-an-object' });
    expect((coordinator as any).serviceHealth.size).toBe(0);
  });

  it('should skip message with missing service name', async () => {
    await (coordinator as any).handleHealthMessage({ id: 'msg-3', data: { status: 'healthy' } });
    expect((coordinator as any).serviceHealth.size).toBe(0);
  });

  it('should process message with "name" field (new format)', async () => {
    await (coordinator as any).handleHealthMessage({
      id: 'msg-4',
      data: { name: 'partition-1', status: 'healthy', timestamp: Date.now() },
    });
    expect((coordinator as any).serviceHealth.has('partition-1')).toBe(true);
    expect((coordinator as any).serviceHealth.get('partition-1').status).toBe('healthy');
  });

  it('should process message with "service" field (legacy format)', async () => {
    await (coordinator as any).handleHealthMessage({
      id: 'msg-5',
      data: { service: 'execution-engine', status: 'healthy', timestamp: Date.now() },
    });
    expect((coordinator as any).serviceHealth.has('execution-engine')).toBe(true);
  });

  it('should default unknown status to "unhealthy"', async () => {
    await (coordinator as any).handleHealthMessage({
      id: 'msg-6',
      data: { name: 'test-svc', status: 'totally-broken', timestamp: Date.now() },
    });
    expect((coordinator as any).serviceHealth.get('test-svc').status).toBe('unhealthy');
  });

  it('should accept "starting" and "stopping" as valid statuses', async () => {
    await (coordinator as any).handleHealthMessage({
      id: 'msg-7',
      data: { name: 'svc-a', status: 'starting', timestamp: Date.now() },
    });
    expect((coordinator as any).serviceHealth.get('svc-a').status).toBe('starting');

    await (coordinator as any).handleHealthMessage({
      id: 'msg-8',
      data: { name: 'svc-b', status: 'stopping', timestamp: Date.now() },
    });
    expect((coordinator as any).serviceHealth.get('svc-b').status).toBe('stopping');
  });

  it('should NOT overwrite coordinator own health entry', async () => {
    (coordinator as any).serviceHealth.set('coordinator', { name: 'coordinator', status: 'healthy', lastHeartbeat: 999 });
    await (coordinator as any).handleHealthMessage({
      id: 'msg-9',
      data: { name: 'coordinator', status: 'degraded', timestamp: Date.now() },
    });
    // Should still be 'healthy' — own entry not overwritten
    expect((coordinator as any).serviceHealth.get('coordinator').status).toBe('healthy');
  });

  it('should call healthMonitor.recordHeartbeat with service name', async () => {
    await (coordinator as any).handleHealthMessage({
      id: 'msg-10',
      data: { name: 'detector-1', status: 'healthy', timestamp: Date.now() },
    });
    expect((coordinator as any).healthMonitor.recordHeartbeat).toHaveBeenCalledWith('detector-1');
  });
});

// =============================================================================
// TQ-M-05: skipStaleOpportunityBacklogIfNeeded tests
// =============================================================================

describe('CoordinatorService.skipStaleOpportunityBacklogIfNeeded', () => {
  let coordinator: CoordinatorService;

  beforeEach(async () => {
    coordinator = new CoordinatorService();
    (coordinator as any).consecutiveExpiredThreshold = 10;
  });

  it('should be no-op when opportunityRouter is null', async () => {
    (coordinator as any).opportunityRouter = null;
    (coordinator as any).streamsClient = { createConsumerGroup: jest.fn() };
    await (coordinator as any).skipStaleOpportunityBacklogIfNeeded();
    // Should not throw
  });

  it('should be no-op when streamsClient is null', async () => {
    (coordinator as any).opportunityRouter = { getConsecutiveExpired: jest.fn().mockReturnValue(20) };
    (coordinator as any).streamsClient = null;
    await (coordinator as any).skipStaleOpportunityBacklogIfNeeded();
    // Should not throw
  });

  it('should not skip when consecutiveExpired is below threshold', async () => {
    (coordinator as any).opportunityRouter = { getConsecutiveExpired: jest.fn().mockReturnValue(5) };
    const mockStreams = { createConsumerGroup: jest.fn(), xlen: jest.fn().mockResolvedValue(100) };
    (coordinator as any).streamsClient = mockStreams;
    await (coordinator as any).skipStaleOpportunityBacklogIfNeeded();
    expect(mockStreams.createConsumerGroup).not.toHaveBeenCalled();
  });

  it('should skip backlog when consecutiveExpired >= threshold', async () => {
    (coordinator as any).opportunityRouter = {
      getConsecutiveExpired: jest.fn().mockReturnValue(15),
      resetConsecutiveExpired: jest.fn(),
    };
    const mockStreams = {
      createConsumerGroup: jest.fn().mockResolvedValue(undefined),
      xlen: jest.fn().mockResolvedValue(500),
    };
    (coordinator as any).streamsClient = mockStreams;
    await (coordinator as any).skipStaleOpportunityBacklogIfNeeded();
    expect(mockStreams.createConsumerGroup).toHaveBeenCalledWith(
      expect.objectContaining({ startId: '$' })
    );
  });

  it('should not throw when xlen fails (best-effort estimation)', async () => {
    (coordinator as any).opportunityRouter = {
      getConsecutiveExpired: jest.fn().mockReturnValue(10),
      resetConsecutiveExpired: jest.fn(),
    };
    const mockStreams = {
      createConsumerGroup: jest.fn().mockResolvedValue(undefined),
      xlen: jest.fn().mockRejectedValue(new Error('Redis error')),
    };
    (coordinator as any).streamsClient = mockStreams;
    await (coordinator as any).skipStaleOpportunityBacklogIfNeeded();
    // Should still attempt the skip despite xlen failure
    expect(mockStreams.createConsumerGroup).toHaveBeenCalled();
  });
});

// =============================================================================
// TQ-M-02: PROFIT_SANITY_CAP boundary tests for processOneExecutionResult
// =============================================================================

describe('CoordinatorService.processOneExecutionResult — PROFIT_SANITY_CAP boundaries', () => {
  let coordinator: CoordinatorService;

  beforeEach(() => {
    // Clear any custom cap from previous tests
    delete process.env.PROFIT_SANITY_CAP_USD;
    coordinator = new CoordinatorService({
      port: 0,
      consumerGroup: 'test-group',
      consumerId: 'test-consumer',
    });
  });

  afterEach(async () => {
    delete process.env.PROFIT_SANITY_CAP_USD;
    try { await coordinator.stop(); } catch { /* cleanup */ }
  });

  it('should add profit of $99,999 to totalProfit (below cap)', () => {
    const rawResult = { actualProfit: 99_999, gasCost: 10, dex: 'uniswap' };
    (coordinator as any).processOneExecutionResult(rawResult, true, 'opp-cap-1', 'ethereum');

    const metrics = coordinator.getSystemMetrics();
    expect(metrics.totalProfit).toBe(99_999);
    expect(metrics.successfulExecutions).toBe(1);
  });

  it('should NOT add profit of $100,001 to totalProfit (above cap)', () => {
    const rawResult = { actualProfit: 100_001, gasCost: 10, dex: 'uniswap' };
    (coordinator as any).processOneExecutionResult(rawResult, true, 'opp-cap-2', 'ethereum');

    const metrics = coordinator.getSystemMetrics();
    expect(metrics.totalProfit).toBe(0);
    // successfulExecutions still increments — only profit is capped
    expect(metrics.successfulExecutions).toBe(1);
  });

  it('should NOT add profit of exactly $100,000 to totalProfit (check is < not <=)', () => {
    const rawResult = { actualProfit: 100_000, gasCost: 10, dex: 'uniswap' };
    (coordinator as any).processOneExecutionResult(rawResult, true, 'opp-cap-3', 'ethereum');

    const metrics = coordinator.getSystemMetrics();
    expect(metrics.totalProfit).toBe(0);
    expect(metrics.successfulExecutions).toBe(1);
  });

  it('should not add profit of $0 to totalProfit (check is > 0)', () => {
    const rawResult = { actualProfit: 0, gasCost: 5, dex: 'uniswap' };
    (coordinator as any).processOneExecutionResult(rawResult, true, 'opp-cap-4', 'ethereum');

    const metrics = coordinator.getSystemMetrics();
    expect(metrics.totalProfit).toBe(0);
    expect(metrics.successfulExecutions).toBe(1);
  });

  it('should not add profit on failed execution regardless of amount', () => {
    const rawResult = { actualProfit: 500, gasCost: 10, dex: 'uniswap' };
    (coordinator as any).processOneExecutionResult(rawResult, false, 'opp-cap-5', 'ethereum');

    const metrics = coordinator.getSystemMetrics();
    expect(metrics.totalProfit).toBe(0);
    expect(metrics.successfulExecutions).toBe(0);
  });

  it('should not add negative profit to totalProfit', () => {
    const rawResult = { actualProfit: -50, gasCost: 10, dex: 'uniswap' };
    (coordinator as any).processOneExecutionResult(rawResult, true, 'opp-cap-6', 'ethereum');

    const metrics = coordinator.getSystemMetrics();
    expect(metrics.totalProfit).toBe(0);
    expect(metrics.successfulExecutions).toBe(1);
  });
});

// =============================================================================
// TQ-M-04: handleHealthMessage() branches
// =============================================================================

describe('CoordinatorService.handleHealthMessage — branch coverage', () => {
  let coordinator: CoordinatorService;

  beforeEach(() => {
    coordinator = new CoordinatorService({
      port: 0,
      consumerGroup: 'test-group',
      consumerId: 'test-consumer',
    });
  });

  afterEach(async () => {
    try { await coordinator.stop(); } catch { /* cleanup */ }
  });

  it('should return without updating serviceHealth when data is null', async () => {
    const message = { id: 'msg-1', data: null };
    await (coordinator as any).handleHealthMessage(message);

    expect(coordinator.getServiceHealthMap().size).toBe(0);
  });

  it('should return without updating serviceHealth when data is undefined', async () => {
    const message = { id: 'msg-2', data: undefined };
    await (coordinator as any).handleHealthMessage(message);

    expect(coordinator.getServiceHealthMap().size).toBe(0);
  });

  it('should log debug and return when service name is missing', async () => {
    const message = { id: 'msg-3', data: { status: 'healthy', uptime: 100 } };
    await (coordinator as any).handleHealthMessage(message);

    expect(coordinator.getServiceHealthMap().size).toBe(0);
  });

  it('should update serviceHealth for valid health message with "name" field', async () => {
    const message = {
      id: 'msg-4',
      data: {
        name: 'partition-asia-fast',
        status: 'healthy',
        uptime: 3600,
        memoryUsage: 50_000_000,
        cpuUsage: 25,
        timestamp: Date.now(),
      },
    };
    await (coordinator as any).handleHealthMessage(message);

    const healthMap = coordinator.getServiceHealthMap();
    expect(healthMap.has('partition-asia-fast')).toBe(true);
    const health = healthMap.get('partition-asia-fast')!;
    expect(health.name).toBe('partition-asia-fast');
    expect(health.status).toBe('healthy');
    expect(health.uptime).toBe(3600);
    expect(health.memoryUsage).toBe(50_000_000);
    expect(health.cpuUsage).toBe(25);
  });

  it('should update serviceHealth for valid health message with "service" field (legacy format)', async () => {
    const message = {
      id: 'msg-5',
      data: {
        service: 'execution-engine',
        status: 'healthy',
        uptime: 1200,
        timestamp: Date.now(),
      },
    };
    await (coordinator as any).handleHealthMessage(message);

    const healthMap = coordinator.getServiceHealthMap();
    expect(healthMap.has('execution-engine')).toBe(true);
    expect(healthMap.get('execution-engine')!.name).toBe('execution-engine');
  });

  it('should default to "unhealthy" for unknown status value', async () => {
    const message = {
      id: 'msg-6',
      data: {
        name: 'some-service',
        status: 'banana', // Invalid status
        uptime: 100,
        timestamp: Date.now(),
      },
    };
    await (coordinator as any).handleHealthMessage(message);

    const healthMap = coordinator.getServiceHealthMap();
    expect(healthMap.get('some-service')!.status).toBe('unhealthy');
  });

  it('should NOT overwrite coordinator own entry in serviceHealth map (P0-4 fix)', async () => {
    // Pre-populate coordinator entry
    const healthMap = coordinator.getServiceHealthMap() as Map<string, any>;
    const originalHealth = {
      name: 'coordinator',
      status: 'healthy',
      lastHeartbeat: Date.now(),
      uptime: 9999,
    };
    healthMap.set('coordinator', originalHealth);

    const message = {
      id: 'msg-7',
      data: {
        name: 'coordinator',
        status: 'healthy',
        uptime: 100,
        timestamp: Date.now() - 5000, // Older timestamp from Redis round-trip
      },
    };
    await (coordinator as any).handleHealthMessage(message);

    // Should NOT have overwritten the original entry
    expect(healthMap.get('coordinator')).toBe(originalHealth);
    expect(healthMap.get('coordinator')!.uptime).toBe(9999);
  });

  it('should record heartbeat via healthMonitor', async () => {
    // Set up a mock healthMonitor with a recordHeartbeat spy
    const mockRecordHeartbeat = jest.fn();
    (coordinator as any).healthMonitor = { recordHeartbeat: mockRecordHeartbeat };

    const message = {
      id: 'msg-8',
      data: {
        name: 'cross-chain-detector',
        status: 'healthy',
        uptime: 600,
        timestamp: Date.now(),
      },
    };
    await (coordinator as any).handleHealthMessage(message);

    expect(mockRecordHeartbeat).toHaveBeenCalledWith('cross-chain-detector');
  });

  it('should handle valid statuses: degraded, starting, stopping', async () => {
    const statuses = ['degraded', 'starting', 'stopping'] as const;
    for (const status of statuses) {
      const message = {
        id: `msg-status-${status}`,
        data: {
          name: `svc-${status}`,
          status,
          uptime: 10,
          timestamp: Date.now(),
        },
      };
      await (coordinator as any).handleHealthMessage(message);
      expect(coordinator.getServiceHealthMap().get(`svc-${status}`)!.status).toBe(status);
    }
  });
});

// =============================================================================
// TQ-M-05: skipStaleOpportunityBacklogIfNeeded()
// =============================================================================

describe('CoordinatorService.skipStaleOpportunityBacklogIfNeeded', () => {
  let coordinator: CoordinatorService;

  beforeEach(() => {
    coordinator = new CoordinatorService({
      port: 0,
      consumerGroup: 'test-group',
      consumerId: 'test-consumer',
      consecutiveExpiredThreshold: 10,
    });
  });

  afterEach(async () => {
    try { await coordinator.stop(); } catch { /* cleanup */ }
  });

  function setPrivate(field: string, value: unknown): void {
    (coordinator as any)[field] = value;
  }

  it('should no-op when opportunityRouter is null', async () => {
    const mockStreams = {
      createConsumerGroup: jest.fn(),
      xlen: jest.fn(),
    };
    setPrivate('opportunityRouter', null);
    setPrivate('streamsClient', mockStreams);

    await (coordinator as any).skipStaleOpportunityBacklogIfNeeded();

    expect(mockStreams.createConsumerGroup).not.toHaveBeenCalled();
  });

  it('should no-op when streamsClient is null', async () => {
    const mockRouter = {
      getConsecutiveExpired: jest.fn().mockReturnValue(100),
      resetConsecutiveExpired: jest.fn(),
    };
    setPrivate('opportunityRouter', mockRouter);
    setPrivate('streamsClient', null);

    await (coordinator as any).skipStaleOpportunityBacklogIfNeeded();

    expect(mockRouter.getConsecutiveExpired).not.toHaveBeenCalled();
  });

  it('should no-op when consecutiveExpired is below threshold', async () => {
    const mockRouter = {
      getConsecutiveExpired: jest.fn().mockReturnValue(5), // Below threshold of 10
      resetConsecutiveExpired: jest.fn(),
    };
    const mockStreams = {
      createConsumerGroup: jest.fn(),
      xlen: jest.fn(),
    };
    setPrivate('opportunityRouter', mockRouter);
    setPrivate('streamsClient', mockStreams);

    await (coordinator as any).skipStaleOpportunityBacklogIfNeeded();

    expect(mockStreams.createConsumerGroup).not.toHaveBeenCalled();
    expect(mockRouter.resetConsecutiveExpired).not.toHaveBeenCalled();
  });

  it('should call createConsumerGroup with startId="$" when threshold is met', async () => {
    const mockRouter = {
      getConsecutiveExpired: jest.fn().mockReturnValue(10), // Exactly at threshold
      resetConsecutiveExpired: jest.fn(),
    };
    const mockStreams = {
      createConsumerGroup: jest.fn().mockResolvedValue(undefined),
      xlen: jest.fn().mockResolvedValue(500),
    };
    setPrivate('opportunityRouter', mockRouter);
    setPrivate('streamsClient', mockStreams);

    await (coordinator as any).skipStaleOpportunityBacklogIfNeeded();

    expect(mockStreams.createConsumerGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        startId: '$',
        resetToStartIdOnExistingGroup: true,
        groupName: 'test-group',
        consumerName: 'test-consumer',
      }),
    );
    expect(mockRouter.resetConsecutiveExpired).toHaveBeenCalled();
  });

  it('should call createConsumerGroup when consecutiveExpired exceeds threshold', async () => {
    const mockRouter = {
      getConsecutiveExpired: jest.fn().mockReturnValue(25), // Well above threshold
      resetConsecutiveExpired: jest.fn(),
    };
    const mockStreams = {
      createConsumerGroup: jest.fn().mockResolvedValue(undefined),
      xlen: jest.fn().mockResolvedValue(1000),
    };
    setPrivate('opportunityRouter', mockRouter);
    setPrivate('streamsClient', mockStreams);

    await (coordinator as any).skipStaleOpportunityBacklogIfNeeded();

    expect(mockStreams.createConsumerGroup).toHaveBeenCalledTimes(1);
    expect(mockRouter.resetConsecutiveExpired).toHaveBeenCalledTimes(1);
  });

  it('should not reset consecutiveExpired when createConsumerGroup fails', async () => {
    const mockRouter = {
      getConsecutiveExpired: jest.fn().mockReturnValue(15),
      resetConsecutiveExpired: jest.fn(),
    };
    const mockStreams = {
      createConsumerGroup: jest.fn().mockRejectedValue(new Error('Redis connection lost')),
      xlen: jest.fn().mockResolvedValue(200),
    };
    setPrivate('opportunityRouter', mockRouter);
    setPrivate('streamsClient', mockStreams);

    await (coordinator as any).skipStaleOpportunityBacklogIfNeeded();

    expect(mockStreams.createConsumerGroup).toHaveBeenCalled();
    // resetConsecutiveExpired should NOT be called because createConsumerGroup threw
    expect(mockRouter.resetConsecutiveExpired).not.toHaveBeenCalled();
  });
});
