"use strict";
/**
 * Stream Health Monitor Tests
 *
 * TDD Test Suite for Redis Streams health monitoring
 *
 * @see ADR-002: Redis Streams over Pub/Sub
 * @see S1.1.5: Add Stream health monitoring
 */
Object.defineProperty(exports, "__esModule", { value: true });
const globals_1 = require("@jest/globals");
const stream_health_monitor_1 = require("./stream-health-monitor");
// Mock Redis Streams Client
globals_1.jest.mock('./redis-streams', () => {
    const mockStreamsClient = {
        xlen: globals_1.jest.fn().mockResolvedValue(100),
        xinfo: globals_1.jest.fn().mockResolvedValue({
            length: 100,
            radixTreeKeys: 1,
            radixTreeNodes: 2,
            lastGeneratedId: '1234567890-0',
            groups: 2
        }),
        xpending: globals_1.jest.fn().mockResolvedValue({
            total: 5,
            smallestId: '1234-0',
            largestId: '1234-4',
            consumers: [
                { name: 'consumer-1', pending: 3 },
                { name: 'consumer-2', pending: 2 }
            ]
        }),
        ping: globals_1.jest.fn().mockResolvedValue(true),
        disconnect: globals_1.jest.fn().mockResolvedValue(undefined)
    };
    return {
        getRedisStreamsClient: globals_1.jest.fn().mockResolvedValue(mockStreamsClient),
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
(0, globals_1.describe)('StreamHealthMonitor', () => {
    let monitor;
    (0, globals_1.beforeEach)(() => {
        globals_1.jest.clearAllMocks();
        monitor = new stream_health_monitor_1.StreamHealthMonitor();
    });
    (0, globals_1.afterEach)(async () => {
        await monitor.stop();
    });
    (0, globals_1.describe)('Stream Health Check', () => {
        (0, globals_1.it)('should check health of all monitored streams', async () => {
            const health = await monitor.checkStreamHealth();
            (0, globals_1.expect)(health).toBeDefined();
            (0, globals_1.expect)(health.overall).toBeDefined();
            (0, globals_1.expect)(health.streams).toBeDefined();
            (0, globals_1.expect)(health.timestamp).toBeGreaterThan(0);
        });
        (0, globals_1.it)('should report stream length for each stream', async () => {
            const health = await monitor.checkStreamHealth();
            (0, globals_1.expect)(health.streams['stream:price-updates']).toBeDefined();
            (0, globals_1.expect)(health.streams['stream:price-updates'].length).toBe(100);
        });
        (0, globals_1.it)('should detect when stream is healthy', async () => {
            const health = await monitor.checkStreamHealth();
            (0, globals_1.expect)(health.overall).toBe('healthy');
        });
        (0, globals_1.it)('should detect pending message lag', async () => {
            const health = await monitor.checkStreamHealth();
            (0, globals_1.expect)(health.streams['stream:price-updates'].pendingCount).toBe(5);
        });
    });
    (0, globals_1.describe)('Stream Lag Monitoring', () => {
        (0, globals_1.it)('should calculate consumer lag', async () => {
            const lagInfo = await monitor.getStreamLag('stream:price-updates', 'arbitrage-group');
            (0, globals_1.expect)(lagInfo).toBeDefined();
            (0, globals_1.expect)(lagInfo.pendingMessages).toBe(5);
        });
        (0, globals_1.it)('should warn when lag exceeds threshold', async () => {
            const { getRedisStreamsClient } = require('./redis-streams');
            const client = await getRedisStreamsClient();
            client.xpending.mockResolvedValueOnce({
                total: 500, // Warning level: above 100 (warning) but below 1000 (critical)
                smallestId: '1234-0',
                largestId: '1234-499',
                consumers: [{ name: 'consumer-1', pending: 500 }]
            });
            const lagInfo = await monitor.getStreamLag('stream:price-updates', 'arbitrage-group');
            (0, globals_1.expect)(lagInfo.status).toBe('warning');
        });
        (0, globals_1.it)('should alert when lag is critical', async () => {
            const { getRedisStreamsClient } = require('./redis-streams');
            const client = await getRedisStreamsClient();
            client.xpending.mockResolvedValueOnce({
                total: 10000, // Critical pending count
                smallestId: '1234-0',
                largestId: '1234-9999',
                consumers: [{ name: 'consumer-1', pending: 10000 }]
            });
            const lagInfo = await monitor.getStreamLag('stream:price-updates', 'arbitrage-group');
            (0, globals_1.expect)(lagInfo.status).toBe('critical');
        });
    });
    (0, globals_1.describe)('Stream Metrics', () => {
        (0, globals_1.it)('should track stream throughput', async () => {
            const metrics = await monitor.getStreamMetrics('stream:price-updates');
            (0, globals_1.expect)(metrics).toBeDefined();
            (0, globals_1.expect)(metrics.messagesPerSecond).toBeDefined();
        });
        (0, globals_1.it)('should track consumer group health', async () => {
            const groupHealth = await monitor.getConsumerGroupHealth('stream:price-updates', 'arbitrage-group');
            (0, globals_1.expect)(groupHealth).toBeDefined();
            (0, globals_1.expect)(groupHealth.consumers).toBeGreaterThanOrEqual(0);
        });
    });
    (0, globals_1.describe)('Alerting', () => {
        (0, globals_1.it)('should trigger alert on high stream lag', async () => {
            const alertHandler = globals_1.jest.fn();
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
            (0, globals_1.expect)(alertHandler).toHaveBeenCalled();
        });
        (0, globals_1.it)('should trigger alert when stream is unavailable', async () => {
            const alertHandler = globals_1.jest.fn();
            monitor.onAlert(alertHandler);
            const { getRedisStreamsClient } = require('./redis-streams');
            const client = await getRedisStreamsClient();
            client.ping.mockResolvedValueOnce(false);
            await monitor.checkStreamHealth();
            (0, globals_1.expect)(alertHandler).toHaveBeenCalledWith(globals_1.expect.objectContaining({
                severity: 'critical',
                type: 'stream_unavailable'
            }));
        });
    });
    (0, globals_1.describe)('Health Dashboard Integration', () => {
        (0, globals_1.it)('should provide summary stats for dashboard', async () => {
            const summary = await monitor.getSummary();
            (0, globals_1.expect)(summary).toBeDefined();
            (0, globals_1.expect)(summary.totalStreams).toBeDefined();
            (0, globals_1.expect)(summary.healthyStreams).toBeDefined();
            (0, globals_1.expect)(summary.totalPending).toBeDefined();
            (0, globals_1.expect)(summary.averageLag).toBeDefined();
        });
        (0, globals_1.it)('should export metrics in Prometheus format', async () => {
            const prometheusMetrics = await monitor.getPrometheusMetrics();
            (0, globals_1.expect)(prometheusMetrics).toContain('stream_length');
            (0, globals_1.expect)(prometheusMetrics).toContain('stream_pending');
        });
    });
    (0, globals_1.describe)('Configuration', () => {
        (0, globals_1.it)('should allow configuring lag thresholds', () => {
            monitor.setThresholds({
                lagWarning: 500,
                lagCritical: 2000
            });
            const config = monitor.getConfig();
            (0, globals_1.expect)(config.lagWarning).toBe(500);
            (0, globals_1.expect)(config.lagCritical).toBe(2000);
        });
        (0, globals_1.it)('should allow adding custom streams to monitor', () => {
            monitor.addStream('stream:custom');
            const streams = monitor.getMonitoredStreams();
            (0, globals_1.expect)(streams).toContain('stream:custom');
        });
    });
});
(0, globals_1.describe)('StreamHealthStatus Types', () => {
    (0, globals_1.it)('should have correct status types', () => {
        const statuses = ['healthy', 'warning', 'critical', 'unknown'];
        (0, globals_1.expect)(statuses).toHaveLength(4);
    });
});
(0, globals_1.describe)('StreamLagInfo Types', () => {
    (0, globals_1.it)('should have required properties', () => {
        const lagInfo = {
            streamName: 'test',
            groupName: 'test-group',
            pendingMessages: 0,
            oldestPendingId: null,
            newestPendingId: null,
            consumers: [],
            status: 'healthy',
            timestamp: Date.now()
        };
        (0, globals_1.expect)(lagInfo.streamName).toBeDefined();
        (0, globals_1.expect)(lagInfo.status).toBe('healthy');
    });
});
//# sourceMappingURL=stream-health-monitor.test.js.map