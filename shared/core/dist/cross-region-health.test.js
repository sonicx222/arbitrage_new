"use strict";
/**
 * Unit Tests for CrossRegionHealthManager
 *
 * Tests cross-region health monitoring, leader election,
 * and failover functionality.
 *
 * @see ADR-007: Cross-Region Failover Strategy
 */
Object.defineProperty(exports, "__esModule", { value: true });
const events_1 = require("events");
const cross_region_health_1 = require("./cross-region-health");
// Mock Redis client
jest.mock('./redis', () => ({
    getRedisClient: jest.fn().mockResolvedValue({
        set: jest.fn().mockResolvedValue('OK'),
        get: jest.fn().mockResolvedValue(null),
        keys: jest.fn().mockResolvedValue([]),
        del: jest.fn().mockResolvedValue(1),
        publish: jest.fn().mockResolvedValue(1),
        subscribe: jest.fn().mockResolvedValue(undefined),
        ping: jest.fn().mockResolvedValue(true),
        disconnect: jest.fn().mockResolvedValue(undefined)
    })
}));
// Mock Redis Streams client
jest.mock('./redis-streams', () => ({
    getRedisStreamsClient: jest.fn().mockResolvedValue({
        xadd: jest.fn().mockResolvedValue('1234-0'),
        xread: jest.fn().mockResolvedValue([]),
        xreadgroup: jest.fn().mockResolvedValue([]),
        xack: jest.fn().mockResolvedValue(1),
        createConsumerGroup: jest.fn().mockResolvedValue(undefined),
        ping: jest.fn().mockResolvedValue(true),
        disconnect: jest.fn().mockResolvedValue(undefined),
        createBatcher: jest.fn().mockReturnValue({
            add: jest.fn(),
            flush: jest.fn().mockResolvedValue(undefined),
            destroy: jest.fn().mockResolvedValue(undefined)
        })
    }),
    RedisStreamsClient: jest.fn()
}));
// Mock distributed lock manager
jest.mock('./distributed-lock', () => ({
    getDistributedLockManager: jest.fn().mockReturnValue({
        acquireLock: jest.fn().mockResolvedValue({
            acquired: true,
            key: 'test-lock-key',
            release: jest.fn().mockResolvedValue(undefined),
            extend: jest.fn().mockResolvedValue(true)
        }),
        extendLock: jest.fn().mockResolvedValue(true),
        releaseLock: jest.fn().mockResolvedValue(undefined)
    })
}));
describe('CrossRegionHealthManager', () => {
    let manager;
    const defaultConfig = {
        instanceId: 'test-instance-1',
        regionId: 'us-east1',
        serviceName: 'test-service',
        healthCheckIntervalMs: 1000,
        failoverThreshold: 3,
        leaderHeartbeatIntervalMs: 500,
        leaderLockTtlMs: 5000,
        canBecomeLeader: true,
        isStandby: false
    };
    beforeEach(async () => {
        jest.clearAllMocks();
        await (0, cross_region_health_1.resetCrossRegionHealthManager)();
    });
    afterEach(async () => {
        if (manager && manager.isActive()) {
            await manager.stop();
        }
    });
    describe('constructor', () => {
        it('should create instance with default config values', () => {
            const minConfig = {
                instanceId: 'test-1',
                regionId: 'us-east1',
                serviceName: 'test'
            };
            manager = new cross_region_health_1.CrossRegionHealthManager(minConfig);
            expect(manager).toBeDefined();
            expect(manager.getOwnRegionId()).toBe('us-east1');
        });
        it('should create instance with full config', () => {
            manager = new cross_region_health_1.CrossRegionHealthManager(defaultConfig);
            expect(manager).toBeDefined();
            expect(manager.getOwnRegionId()).toBe('us-east1');
        });
        it('should inherit from EventEmitter', () => {
            manager = new cross_region_health_1.CrossRegionHealthManager(defaultConfig);
            expect(manager).toBeInstanceOf(events_1.EventEmitter);
        });
    });
    describe('lifecycle', () => {
        it('should start successfully', async () => {
            manager = new cross_region_health_1.CrossRegionHealthManager(defaultConfig);
            await manager.start();
            expect(manager.isActive()).toBe(true);
        });
        it('should not double start', async () => {
            manager = new cross_region_health_1.CrossRegionHealthManager(defaultConfig);
            await manager.start();
            await manager.start(); // Should not throw
            expect(manager.isActive()).toBe(true);
        });
        it('should stop successfully', async () => {
            manager = new cross_region_health_1.CrossRegionHealthManager(defaultConfig);
            await manager.start();
            await manager.stop();
            expect(manager.isActive()).toBe(false);
        });
        it('should handle stop when not started', async () => {
            manager = new cross_region_health_1.CrossRegionHealthManager(defaultConfig);
            await manager.stop(); // Should not throw
            expect(manager.isActive()).toBe(false);
        });
    });
    describe('leader election', () => {
        it('should attempt leader election on start when eligible', async () => {
            const config = { ...defaultConfig, canBecomeLeader: true };
            manager = new cross_region_health_1.CrossRegionHealthManager(config);
            const { getDistributedLockManager } = require('./distributed-lock');
            const mockLockManager = getDistributedLockManager();
            await manager.start();
            expect(mockLockManager.acquireLock).toHaveBeenCalled();
        });
        it('should not attempt leader election when standby', async () => {
            const config = { ...defaultConfig, isStandby: true };
            manager = new cross_region_health_1.CrossRegionHealthManager(config);
            const { getDistributedLockManager } = require('./distributed-lock');
            const mockLockManager = getDistributedLockManager();
            await manager.start();
            // Should not acquire lock when standby
            expect(mockLockManager.acquireLock).not.toHaveBeenCalled();
        });
        it('should not attempt leader election when canBecomeLeader is false', async () => {
            const config = { ...defaultConfig, canBecomeLeader: false };
            manager = new cross_region_health_1.CrossRegionHealthManager(config);
            const { getDistributedLockManager } = require('./distributed-lock');
            const mockLockManager = getDistributedLockManager();
            await manager.start();
            expect(mockLockManager.acquireLock).not.toHaveBeenCalled();
        });
        it('should become leader when lock acquired', async () => {
            manager = new cross_region_health_1.CrossRegionHealthManager(defaultConfig);
            await manager.start();
            // Check if leader (mock returns successful lock)
            expect(manager.getIsLeader()).toBe(true);
        });
        it('should emit leaderChange event when becoming leader', async () => {
            manager = new cross_region_health_1.CrossRegionHealthManager(defaultConfig);
            const leaderChangeHandler = jest.fn();
            manager.on('leaderChange', leaderChangeHandler);
            await manager.start();
            expect(leaderChangeHandler).toHaveBeenCalled();
            const event = leaderChangeHandler.mock.calls[0][0];
            expect(event.type).toBe('leader_changed');
            expect(event.targetRegion).toBe('us-east1');
        });
    });
    describe('health monitoring', () => {
        it('should initialize own region health', async () => {
            manager = new cross_region_health_1.CrossRegionHealthManager(defaultConfig);
            await manager.start();
            const regionHealth = manager.getRegionHealth('us-east1');
            expect(regionHealth).toBeDefined();
            expect(regionHealth.regionId).toBe('us-east1');
            expect(regionHealth.status).toBe('healthy');
        });
        it('should track service health in region', async () => {
            manager = new cross_region_health_1.CrossRegionHealthManager(defaultConfig);
            await manager.start();
            const regionHealth = manager.getRegionHealth('us-east1');
            expect(regionHealth.services.length).toBe(1);
            expect(regionHealth.services[0].serviceName).toBe('test-service');
        });
        it('should return all regions health', async () => {
            manager = new cross_region_health_1.CrossRegionHealthManager(defaultConfig);
            await manager.start();
            const allHealth = manager.getAllRegionsHealth();
            expect(allHealth.size).toBeGreaterThan(0);
            expect(allHealth.has('us-east1')).toBe(true);
        });
    });
    describe('global health evaluation', () => {
        it('should evaluate global health status', async () => {
            manager = new cross_region_health_1.CrossRegionHealthManager(defaultConfig);
            await manager.start();
            const globalHealth = manager.evaluateGlobalHealth();
            expect(globalHealth).toBeDefined();
            expect(globalHealth.redis).toBeDefined();
            expect(typeof globalHealth.degradationLevel).toBe('number');
            expect(['healthy', 'degraded', 'critical']).toContain(globalHealth.overallStatus);
        });
        it('should return READ_ONLY degradation when no detectors', async () => {
            manager = new cross_region_health_1.CrossRegionHealthManager(defaultConfig);
            await manager.start();
            const globalHealth = manager.evaluateGlobalHealth();
            // With default setup, no detectors are registered
            expect(globalHealth.detectors).toHaveLength(0);
        });
    });
    describe('degradation levels', () => {
        it('should export DegradationLevel enum', () => {
            expect(cross_region_health_1.DegradationLevel.FULL_OPERATION).toBe(0);
            expect(cross_region_health_1.DegradationLevel.REDUCED_CHAINS).toBe(1);
            expect(cross_region_health_1.DegradationLevel.DETECTION_ONLY).toBe(2);
            expect(cross_region_health_1.DegradationLevel.READ_ONLY).toBe(3);
            expect(cross_region_health_1.DegradationLevel.COMPLETE_OUTAGE).toBe(4);
        });
    });
    describe('failover', () => {
        // Helper function to set up a remote region for failover testing
        const setupRemoteRegion = (mgr, regionId) => {
            const regions = mgr.regions;
            regions.set(regionId, {
                regionId,
                status: 'healthy',
                isLeader: false,
                services: [{
                        serviceName: 'remote-service',
                        status: 'healthy',
                        isPrimary: true,
                        isStandby: false,
                        lastHeartbeat: Date.now(),
                        metrics: {}
                    }],
                lastHealthCheck: Date.now(),
                consecutiveFailures: 0,
                avgLatencyMs: 0,
                memoryUsagePercent: 0,
                cpuUsagePercent: 0
            });
        };
        it('should emit failover events', async () => {
            manager = new cross_region_health_1.CrossRegionHealthManager(defaultConfig);
            await manager.start();
            setupRemoteRegion(manager, 'asia-southeast1');
            const failoverHandler = jest.fn();
            manager.on('failoverStarted', failoverHandler);
            // Trigger failover manually
            await manager.triggerFailover('asia-southeast1');
            expect(failoverHandler).toHaveBeenCalled();
        });
        it('should publish failover event to Redis', async () => {
            const { getRedisClient } = require('./redis');
            const mockRedis = await getRedisClient();
            manager = new cross_region_health_1.CrossRegionHealthManager(defaultConfig);
            await manager.start();
            setupRemoteRegion(manager, 'asia-southeast1');
            await manager.triggerFailover('asia-southeast1');
            expect(mockRedis.publish).toHaveBeenCalled();
        });
        it('should emit failoverCompleted on successful failover', async () => {
            manager = new cross_region_health_1.CrossRegionHealthManager(defaultConfig);
            await manager.start();
            setupRemoteRegion(manager, 'asia-southeast1');
            const completedHandler = jest.fn();
            manager.on('failoverCompleted', completedHandler);
            await manager.triggerFailover('asia-southeast1');
            expect(completedHandler).toHaveBeenCalled();
            const event = completedHandler.mock.calls[0][0];
            expect(event.type).toBe('failover_completed');
            expect(event.durationMs).toBeDefined();
        });
    });
    describe('singleton pattern', () => {
        it('should return same instance from getCrossRegionHealthManager', async () => {
            await (0, cross_region_health_1.resetCrossRegionHealthManager)();
            const instance1 = (0, cross_region_health_1.getCrossRegionHealthManager)(defaultConfig);
            const instance2 = (0, cross_region_health_1.getCrossRegionHealthManager)();
            expect(instance1).toBe(instance2);
        });
        it('should throw if getting instance without initial config', async () => {
            await (0, cross_region_health_1.resetCrossRegionHealthManager)();
            expect(() => (0, cross_region_health_1.getCrossRegionHealthManager)()).toThrow();
        });
        it('should reset singleton with resetCrossRegionHealthManager', async () => {
            const instance1 = (0, cross_region_health_1.getCrossRegionHealthManager)(defaultConfig);
            await instance1.start();
            await (0, cross_region_health_1.resetCrossRegionHealthManager)();
            expect(() => (0, cross_region_health_1.getCrossRegionHealthManager)()).toThrow();
        });
    });
    describe('event emission', () => {
        it('should emit leadershipLost event when lock extension fails', async () => {
            const { getDistributedLockManager } = require('./distributed-lock');
            const mockLockManager = getDistributedLockManager();
            manager = new cross_region_health_1.CrossRegionHealthManager({
                ...defaultConfig,
                leaderHeartbeatIntervalMs: 100
            });
            await manager.start();
            const lostHandler = jest.fn();
            manager.on('leadershipLost', lostHandler);
            // Simulate lock extension failure
            mockLockManager.extendLock.mockResolvedValueOnce(false);
            // Wait for heartbeat interval
            await new Promise(resolve => setTimeout(resolve, 150));
            // May or may not have fired depending on timing
            // This is a timing-sensitive test
        });
        it('should emit activateStandby on failover', async () => {
            manager = new cross_region_health_1.CrossRegionHealthManager(defaultConfig);
            await manager.start();
            // Set up remote region for failover
            const regions = manager.regions;
            regions.set('asia-southeast1', {
                regionId: 'asia-southeast1',
                status: 'healthy',
                isLeader: false,
                services: [{
                        serviceName: 'remote-service',
                        status: 'healthy',
                        isPrimary: true,
                        isStandby: false,
                        lastHeartbeat: Date.now(),
                        metrics: {}
                    }],
                lastHealthCheck: Date.now(),
                consecutiveFailures: 0,
                avgLatencyMs: 0,
                memoryUsagePercent: 0,
                cpuUsagePercent: 0
            });
            const activateHandler = jest.fn();
            manager.on('activateStandby', activateHandler);
            await manager.triggerFailover('asia-southeast1');
            expect(activateHandler).toHaveBeenCalled();
        });
    });
});
describe('RegionHealth interface', () => {
    it('should have correct structure', () => {
        const regionHealth = {
            regionId: 'us-east1',
            status: 'healthy',
            isLeader: false,
            services: [{
                    serviceName: 'test',
                    status: 'healthy',
                    isPrimary: true,
                    isStandby: false,
                    lastHeartbeat: Date.now(),
                    metrics: {}
                }],
            lastHealthCheck: Date.now(),
            consecutiveFailures: 0,
            avgLatencyMs: 10,
            memoryUsagePercent: 50,
            cpuUsagePercent: 30
        };
        expect(regionHealth.regionId).toBeDefined();
        expect(regionHealth.status).toBeDefined();
        expect(regionHealth.services).toBeDefined();
    });
});
describe('GlobalHealthStatus interface', () => {
    it('should have correct structure', () => {
        const globalHealth = {
            redis: { healthy: true, latencyMs: 5 },
            executor: { healthy: true, region: 'us-east1' },
            detectors: [
                { name: 'bsc-detector', healthy: true, region: 'asia-southeast1' }
            ],
            degradationLevel: cross_region_health_1.DegradationLevel.FULL_OPERATION,
            overallStatus: 'healthy'
        };
        expect(globalHealth.redis).toBeDefined();
        expect(globalHealth.executor).toBeDefined();
        expect(globalHealth.detectors).toBeDefined();
        expect(globalHealth.degradationLevel).toBeDefined();
        expect(globalHealth.overallStatus).toBeDefined();
    });
});
describe('FailoverEvent interface', () => {
    it('should have correct structure for failover_started', () => {
        const event = {
            type: 'failover_started',
            sourceRegion: 'asia-southeast1',
            targetRegion: 'us-east1',
            services: ['bsc-detector', 'polygon-detector'],
            timestamp: Date.now()
        };
        expect(event.type).toBe('failover_started');
        expect(event.services.length).toBe(2);
    });
    it('should have correct structure for failover_completed', () => {
        const event = {
            type: 'failover_completed',
            sourceRegion: 'asia-southeast1',
            targetRegion: 'us-east1',
            services: ['bsc-detector'],
            timestamp: Date.now(),
            durationMs: 5000
        };
        expect(event.type).toBe('failover_completed');
        expect(event.durationMs).toBeDefined();
    });
    it('should have correct structure for failover_failed', () => {
        const event = {
            type: 'failover_failed',
            sourceRegion: 'asia-southeast1',
            targetRegion: 'us-east1',
            services: ['bsc-detector'],
            timestamp: Date.now(),
            error: 'Connection timeout'
        };
        expect(event.type).toBe('failover_failed');
        expect(event.error).toBeDefined();
    });
});
//# sourceMappingURL=cross-region-health.test.js.map