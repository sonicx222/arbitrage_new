/**
 * Stream Health Monitor Tests
 *
 * TDD Test Suite for Redis Streams health monitoring
 *
 * @migrated from shared/core/src/stream-health-monitor.test.ts
 * @see ADR-002: Redis Streams over Pub/Sub
 * @see ADR-009: Test Architecture
 * @see S1.1.5: Add Stream health monitoring
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Import directly from source (DI pattern per ADR-009)
import {
  StreamHealthMonitor,
  RedisStreamsClient
} from '../../src';
import type {
  StreamHealthStatus,
  StreamLagInfo,
  StreamHealthMonitorConfig
} from '../../src';

// ============================================================================
// Mock Factories (using dependency injection instead of module mocks)
// ============================================================================

// Mock logger factory
const createMockLogger = () => ({
  info: jest.fn<(msg: string, meta?: object) => void>(),
  error: jest.fn<(msg: string, meta?: object) => void>(),
  warn: jest.fn<(msg: string, meta?: object) => void>(),
  debug: jest.fn<(msg: string, meta?: object) => void>()
});

// Mock streams client factory
const createMockStreamsClient = () => ({
  xlen: jest.fn<() => Promise<number>>().mockResolvedValue(100),
  xinfo: jest.fn<() => Promise<any>>().mockResolvedValue({
    length: 100,
    radixTreeKeys: 1,
    radixTreeNodes: 2,
    lastGeneratedId: '1234567890-0',
    groups: 2
  }),
  xpending: jest.fn<() => Promise<any>>().mockResolvedValue({
    total: 5,
    smallestId: '1234-0',
    largestId: '1234-4',
    consumers: [
      { name: 'consumer-1', pending: 3 },
      { name: 'consumer-2', pending: 2 }
    ]
  }),
  ping: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
  disconnect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined)
});

describe('StreamHealthMonitor', () => {
  let monitor: StreamHealthMonitor;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockStreamsClient: ReturnType<typeof createMockStreamsClient>;

  // Create test config with injected mocks
  const createTestConfig = (overrides: Partial<StreamHealthMonitorConfig> = {}): StreamHealthMonitorConfig => ({
    logger: mockLogger,
    streamsClient: mockStreamsClient as any,
    ...overrides
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockStreamsClient = createMockStreamsClient();
    monitor = new StreamHealthMonitor(createTestConfig());
  });

  afterEach(async () => {
    await monitor.stop();
  });

  describe('Stream Health Check', () => {
    it('should check health of all monitored streams', async () => {
      const health = await monitor.checkStreamHealth();

      expect(health).toBeDefined();
      expect(health.overall).toBeDefined();
      expect(health.streams).toBeDefined();
      expect(health.timestamp).toBeGreaterThan(0);
    });

    it('should report stream length for each stream', async () => {
      const health = await monitor.checkStreamHealth();

      expect(health.streams['stream:price-updates']).toBeDefined();
      expect(health.streams['stream:price-updates'].length).toBe(100);
    });

    it('should detect when stream is healthy', async () => {
      const health = await monitor.checkStreamHealth();

      expect(health.overall).toBe('healthy');
    });

    it('should detect pending message lag', async () => {
      const health = await monitor.checkStreamHealth();

      expect(health.streams['stream:price-updates'].pendingCount).toBe(5);
    });
  });

  describe('Stream Lag Monitoring', () => {
    it('should calculate consumer lag', async () => {
      const lagInfo = await monitor.getStreamLag('stream:price-updates', 'arbitrage-group');

      expect(lagInfo).toBeDefined();
      expect(lagInfo.pendingMessages).toBe(5);
    });

    it('should warn when lag exceeds threshold', async () => {
      mockStreamsClient.xpending.mockResolvedValueOnce({
        total: 500, // Warning level: above 100 (warning) but below 1000 (critical)
        smallestId: '1234-0',
        largestId: '1234-499',
        consumers: [{ name: 'consumer-1', pending: 500 }]
      });

      const lagInfo = await monitor.getStreamLag('stream:price-updates', 'arbitrage-group');

      expect(lagInfo.status).toBe('warning');
    });

    it('should alert when lag is critical', async () => {
      mockStreamsClient.xpending.mockResolvedValueOnce({
        total: 10000, // Critical pending count
        smallestId: '1234-0',
        largestId: '1234-9999',
        consumers: [{ name: 'consumer-1', pending: 10000 }]
      });

      const lagInfo = await monitor.getStreamLag('stream:price-updates', 'arbitrage-group');

      expect(lagInfo.status).toBe('critical');
    });
  });

  describe('Stream Metrics', () => {
    it('should track stream throughput', async () => {
      const metrics = await monitor.getStreamMetrics('stream:price-updates');

      expect(metrics).toBeDefined();
      expect(metrics.messagesPerSecond).toBeDefined();
    });

    it('should track consumer group health', async () => {
      const groupHealth = await monitor.getConsumerGroupHealth(
        'stream:price-updates',
        'arbitrage-group'
      );

      expect(groupHealth).toBeDefined();
      expect(groupHealth.consumers).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Alerting', () => {
    it('should trigger alert on high stream lag', async () => {
      const alertHandler = jest.fn();
      monitor.onAlert(alertHandler);

      mockStreamsClient.xpending.mockResolvedValue({
        total: 5000,
        smallestId: '1234-0',
        largestId: '1234-4999',
        consumers: [{ name: 'consumer-1', pending: 5000 }]
      });

      await monitor.checkStreamHealth();

      // Alert should be triggered
      expect(alertHandler).toHaveBeenCalled();
    });

    it('should trigger alert when stream is unavailable', async () => {
      const alertHandler = jest.fn();
      monitor.onAlert(alertHandler);

      mockStreamsClient.ping.mockResolvedValueOnce(false);

      await monitor.checkStreamHealth();

      expect(alertHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          severity: 'critical',
          type: 'stream_unavailable'
        })
      );
    });
  });

  describe('Health Dashboard Integration', () => {
    it('should provide summary stats for dashboard', async () => {
      const summary = await monitor.getSummary();

      expect(summary).toBeDefined();
      expect(summary.totalStreams).toBeDefined();
      expect(summary.healthyStreams).toBeDefined();
      expect(summary.totalPending).toBeDefined();
      expect(summary.averageLag).toBeDefined();
    });

    it('should export metrics in Prometheus format', async () => {
      const prometheusMetrics = await monitor.getPrometheusMetrics();

      expect(prometheusMetrics).toContain('stream_length');
      expect(prometheusMetrics).toContain('stream_pending');
    });
  });

  describe('Configuration', () => {
    it('should allow configuring lag thresholds', () => {
      monitor.setThresholds({
        lagWarning: 500,
        lagCritical: 2000
      });

      const config = monitor.getConfig();

      expect(config.lagWarning).toBe(500);
      expect(config.lagCritical).toBe(2000);
    });

    it('should allow adding custom streams to monitor', () => {
      monitor.addStream('stream:custom');

      const streams = monitor.getMonitoredStreams();

      expect(streams).toContain('stream:custom');
    });
  });
});

describe('StreamHealthMonitor Lifecycle', () => {
  let monitor: StreamHealthMonitor;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockStreamsClient: ReturnType<typeof createMockStreamsClient>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockStreamsClient = createMockStreamsClient();
  });

  afterEach(async () => {
    if (monitor) {
      await monitor.stop();
    }
  });

  describe('start()', () => {
    it('should initialize streams client on start', async () => {
      monitor = new StreamHealthMonitor({
        logger: mockLogger,
        streamsClient: mockStreamsClient as any
      });

      await monitor.start(60000);

      // Verify client is initialized by making a health check
      const health = await monitor.checkStreamHealth();
      expect(health).toBeDefined();
      expect(mockStreamsClient.ping).toHaveBeenCalled();
    });

    it('should log start with interval info', async () => {
      monitor = new StreamHealthMonitor({
        logger: mockLogger,
        streamsClient: mockStreamsClient as any
      });

      await monitor.start(5000);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Stream health monitoring started',
        expect.objectContaining({ intervalMs: 5000 })
      );
    });
  });

  describe('stop() clears state for restart (P2 #16)', () => {
    it('should clear alert handlers on stop', async () => {
      monitor = new StreamHealthMonitor({
        logger: mockLogger,
        streamsClient: mockStreamsClient as any
      });

      const alertHandler = jest.fn();
      monitor.onAlert(alertHandler);

      await monitor.stop();

      // After stop, re-initialize and trigger alert — old handler should NOT fire
      mockStreamsClient.ping.mockResolvedValueOnce(false);
      await monitor.checkStreamHealth();

      expect(alertHandler).not.toHaveBeenCalled();
    });

    it('should reset initialized state on stop allowing re-init', async () => {
      monitor = new StreamHealthMonitor({
        logger: mockLogger,
        streamsClient: mockStreamsClient as any
      });

      // Start initializes the client
      await monitor.start(60000);
      await monitor.stop();

      // After stop, a new checkStreamHealth should re-initialize
      const health = await monitor.checkStreamHealth();
      expect(health).toBeDefined();
    });
  });
});

describe('StreamHealthMonitor Concurrent Init', () => {
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockStreamsClient: ReturnType<typeof createMockStreamsClient>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockStreamsClient = createMockStreamsClient();
  });

  it('should handle concurrent ensureInitialized calls safely', async () => {
    const monitor = new StreamHealthMonitor({
      logger: mockLogger,
      streamsClient: mockStreamsClient as any
    });

    // Fire multiple concurrent health checks which each call ensureInitialized
    const results = await Promise.all([
      monitor.checkStreamHealth(),
      monitor.checkStreamHealth(),
      monitor.checkStreamHealth()
    ]);

    // All should resolve successfully (no double-init errors)
    for (const result of results) {
      expect(result).toBeDefined();
      expect(result.timestamp).toBeGreaterThan(0);
    }

    await monitor.stop();
  });
});

describe('StreamHealthMonitor Alert Deduplication', () => {
  let monitor: StreamHealthMonitor;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockStreamsClient: ReturnType<typeof createMockStreamsClient>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockStreamsClient = createMockStreamsClient();
    monitor = new StreamHealthMonitor({
      logger: mockLogger,
      streamsClient: mockStreamsClient as any
    });
  });

  afterEach(async () => {
    await monitor.stop();
  });

  it('should deduplicate identical alerts within cooldown period', async () => {
    const alertHandler = jest.fn();
    monitor.onAlert(alertHandler);
    // Set a long cooldown so second call is within it
    monitor.setAlertCooldown(60000);

    // Trigger critical lag twice
    mockStreamsClient.xpending.mockResolvedValue({
      total: 5000,
      smallestId: '1234-0',
      largestId: '1234-4999',
      consumers: [{ name: 'consumer-1', pending: 5000 }]
    });

    await monitor.checkStreamHealth();
    const firstCallCount = alertHandler.mock.calls.length;

    await monitor.checkStreamHealth();
    const secondCallCount = alertHandler.mock.calls.length;

    // Second check should NOT produce additional alerts (dedup suppresses them)
    expect(secondCallCount).toBe(firstCallCount);
  });

  it('should allow same alert after cooldown expires', async () => {
    const alertHandler = jest.fn();
    monitor.onAlert(alertHandler);
    // Set a very short cooldown
    monitor.setAlertCooldown(1);

    mockStreamsClient.ping.mockResolvedValue(false);

    await monitor.checkStreamHealth();
    const firstCallCount = alertHandler.mock.calls.length;
    expect(firstCallCount).toBeGreaterThan(0);

    // Wait for cooldown to expire
    await new Promise(resolve => setTimeout(resolve, 10));

    mockStreamsClient.ping.mockResolvedValue(false);
    await monitor.checkStreamHealth();

    // After cooldown, same alert should fire again
    expect(alertHandler.mock.calls.length).toBeGreaterThan(firstCallCount);
  });
});

describe('StreamHealthStatus Types', () => {
  it('should have correct status types', () => {
    const statuses: StreamHealthStatus[] = ['healthy', 'warning', 'critical', 'unknown'];
    expect(statuses).toHaveLength(4);
  });
});

describe('StreamLagInfo Types', () => {
  it('should have required properties', () => {
    const lagInfo: StreamLagInfo = {
      streamName: 'test',
      groupName: 'test-group',
      pendingMessages: 0,
      oldestPendingId: null,
      newestPendingId: null,
      consumers: [],
      status: 'healthy',
      timestamp: Date.now()
    };

    expect(lagInfo.streamName).toBeDefined();
    expect(lagInfo.status).toBe('healthy');
  });
});
