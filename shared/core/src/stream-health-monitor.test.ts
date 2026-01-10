/**
 * Stream Health Monitor Tests
 *
 * TDD Test Suite for Redis Streams health monitoring
 *
 * @see ADR-002: Redis Streams over Pub/Sub
 * @see S1.1.5: Add Stream health monitoring
 */

import { StreamHealthMonitor, StreamHealthStatus, StreamLagInfo } from './stream-health-monitor';

// Mock Redis Streams Client
jest.mock('./redis-streams', () => {
  const mockStreamsClient = {
    xlen: jest.fn().mockResolvedValue(100),
    xinfo: jest.fn().mockResolvedValue({
      length: 100,
      radixTreeKeys: 1,
      radixTreeNodes: 2,
      lastGeneratedId: '1234567890-0',
      groups: 2
    }),
    xpending: jest.fn().mockResolvedValue({
      total: 5,
      smallestId: '1234-0',
      largestId: '1234-4',
      consumers: [
        { name: 'consumer-1', pending: 3 },
        { name: 'consumer-2', pending: 2 }
      ]
    }),
    ping: jest.fn().mockResolvedValue(true),
    disconnect: jest.fn().mockResolvedValue(undefined)
  };

  return {
    getRedisStreamsClient: jest.fn().mockResolvedValue(mockStreamsClient),
    RedisStreamsClient: {
      STREAMS: {
        PRICE_UPDATES: 'stream:price-updates',
        SWAP_EVENTS: 'stream:swap-events',
        OPPORTUNITIES: 'stream:opportunities',
        WHALE_ALERTS: 'stream:whale-alerts',
        VOLUME_AGGREGATES: 'stream:volume-aggregates',
        HEALTH: 'stream:health'
      }
    }
  };
});

describe('StreamHealthMonitor', () => {
  let monitor: StreamHealthMonitor;

  beforeEach(() => {
    jest.clearAllMocks();
    monitor = new StreamHealthMonitor();
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
      const { getRedisStreamsClient } = require('./redis-streams');
      const client = await getRedisStreamsClient();
      client.xpending.mockResolvedValueOnce({
        total: 500, // Warning level: above 100 (warning) but below 1000 (critical)
        smallestId: '1234-0',
        largestId: '1234-499',
        consumers: [{ name: 'consumer-1', pending: 500 }]
      });

      const lagInfo = await monitor.getStreamLag('stream:price-updates', 'arbitrage-group');

      expect(lagInfo.status).toBe('warning');
    });

    it('should alert when lag is critical', async () => {
      const { getRedisStreamsClient } = require('./redis-streams');
      const client = await getRedisStreamsClient();
      client.xpending.mockResolvedValueOnce({
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

      const { getRedisStreamsClient } = require('./redis-streams');
      const client = await getRedisStreamsClient();
      client.xpending.mockResolvedValue({
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

      const { getRedisStreamsClient } = require('./redis-streams');
      const client = await getRedisStreamsClient();
      client.ping.mockResolvedValueOnce(false);

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
