/**
 * Tests for LeadershipElectionService
 *
 * @see P2-SERVICE from refactoring-roadmap.md
 */

import {
  LeadershipElectionService,
  LeadershipElectionConfig,
  LeadershipElectionOptions,
  LeadershipRedisClient,
  LeadershipAlert,
} from './leadership-election-service';

// Mock logger
const createMockLogger = () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
});

// Mock Redis client
const createMockRedis = (): jest.Mocked<LeadershipRedisClient> => ({
  setNx: jest.fn(),
  renewLockIfOwned: jest.fn(),
  releaseLockIfOwned: jest.fn(),
});

describe('LeadershipElectionService', () => {
  let service: LeadershipElectionService;
  let mockRedis: jest.Mocked<LeadershipRedisClient>;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let config: LeadershipElectionConfig;
  let alerts: LeadershipAlert[];
  let leadershipChanges: boolean[];

  beforeEach(() => {
    jest.useFakeTimers();

    mockRedis = createMockRedis();
    mockLogger = createMockLogger();
    alerts = [];
    leadershipChanges = [];

    config = {
      lockKey: 'test:leader:lock',
      lockTtlMs: 30000,
      heartbeatIntervalMs: 10000,
      instanceId: 'test-instance-1',
    };

    // Default: Redis operations succeed
    mockRedis.setNx.mockResolvedValue(true);
    mockRedis.renewLockIfOwned.mockResolvedValue(true);
    mockRedis.releaseLockIfOwned.mockResolvedValue(true);
  });

  afterEach(async () => {
    if (service) {
      await service.stop();
    }
    jest.useRealTimers();
  });

  const createService = (overrides?: Partial<LeadershipElectionOptions>) => {
    service = new LeadershipElectionService({
      config,
      redis: mockRedis,
      logger: mockLogger,
      onAlert: (alert) => alerts.push(alert),
      onLeadershipChange: (isLeader) => leadershipChanges.push(isLeader),
      jitterRangeMs: 0, // Disable jitter for predictable tests
      ...overrides,
    });
    return service;
  };

  describe('start', () => {
    it('should acquire leadership on start', async () => {
      const svc = createService();

      await svc.start();

      expect(svc.isLeader).toBe(true);
      expect(mockRedis.setNx).toHaveBeenCalledWith(
        'test:leader:lock',
        'test-instance-1',
        30 // TTL in seconds
      );
    });

    it('should not become leader if setNx fails', async () => {
      mockRedis.setNx.mockResolvedValue(false);
      mockRedis.renewLockIfOwned.mockResolvedValue(false);

      const svc = createService();
      await svc.start();

      expect(svc.isLeader).toBe(false);
    });

    it('should not start twice', async () => {
      const svc = createService();

      await svc.start();
      await svc.start();

      expect(mockRedis.setNx).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).toHaveBeenCalledWith('Leadership election service already running');
    });

    it('should send LEADER_ACQUIRED alert when becoming leader', async () => {
      const svc = createService();

      await svc.start();

      expect(alerts).toHaveLength(1);
      expect(alerts[0].type).toBe('LEADER_ACQUIRED');
      expect(alerts[0].severity).toBe('info');
    });

    it('should notify leadership change callback', async () => {
      const svc = createService();

      await svc.start();

      expect(leadershipChanges).toEqual([true]);
    });
  });

  describe('stop', () => {
    it('should release leadership on stop', async () => {
      const svc = createService();
      await svc.start();

      await svc.stop();

      expect(mockRedis.releaseLockIfOwned).toHaveBeenCalledWith(
        'test:leader:lock',
        'test-instance-1'
      );
      expect(svc.isLeader).toBe(false);
    });

    it('should notify leadership change callback on stop', async () => {
      const svc = createService();
      await svc.start();
      leadershipChanges.length = 0; // Clear initial acquisition

      await svc.stop();

      expect(leadershipChanges).toEqual([false]);
    });
  });

  describe('heartbeat', () => {
    it('should renew lock on heartbeat when leader', async () => {
      const svc = createService();
      await svc.start();

      jest.advanceTimersByTime(10000);
      await Promise.resolve();

      expect(mockRedis.renewLockIfOwned).toHaveBeenCalled();
    });

    it('should try to acquire leadership on heartbeat when not leader', async () => {
      mockRedis.setNx.mockResolvedValue(false);
      mockRedis.renewLockIfOwned.mockResolvedValue(false);

      const svc = createService();
      await svc.start();

      expect(svc.isLeader).toBe(false);

      // Heartbeat should try acquisition
      mockRedis.setNx.mockResolvedValue(true);
      jest.advanceTimersByTime(10000);
      await Promise.resolve();

      expect(mockRedis.setNx).toHaveBeenCalledTimes(2); // Initial + heartbeat
    });

    it('should lose leadership when renewal fails', async () => {
      const svc = createService();
      await svc.start();

      expect(svc.isLeader).toBe(true);

      // Simulate renewal failure
      mockRedis.renewLockIfOwned.mockResolvedValue(false);

      // Advance timers and run all pending callbacks
      jest.advanceTimersByTime(10000);
      jest.runAllTicks();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(svc.isLeader).toBe(false);
      expect(alerts.some(a => a.type === 'LEADER_LOST')).toBe(true);
    });

    it('should demote after consecutive heartbeat failures', async () => {
      const svc = createService({ maxHeartbeatFailures: 3 });
      await svc.start();

      expect(svc.isLeader).toBe(true);

      // Simulate consecutive failures
      mockRedis.renewLockIfOwned.mockRejectedValue(new Error('Redis error'));

      // Helper to advance and flush
      const advanceAndFlush = async () => {
        jest.advanceTimersByTime(10000);
        jest.runAllTicks();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      };

      // First failure
      await advanceAndFlush();
      expect(svc.isLeader).toBe(true); // Still leader

      // Second failure
      await advanceAndFlush();
      expect(svc.isLeader).toBe(true); // Still leader

      // Third failure - should demote
      await advanceAndFlush();

      expect(svc.isLeader).toBe(false);
      expect(alerts.some(a => a.type === 'LEADER_DEMOTION')).toBe(true);
    });

    it('should reset failure count on successful renewal', async () => {
      const svc = createService({ maxHeartbeatFailures: 3 });
      await svc.start();

      // Two failures
      mockRedis.renewLockIfOwned.mockRejectedValue(new Error('Redis error'));
      jest.advanceTimersByTime(10000);
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(10000);
      await Promise.resolve();
      await Promise.resolve();

      // Success - should reset counter
      mockRedis.renewLockIfOwned.mockResolvedValue(true);
      jest.advanceTimersByTime(10000);
      await Promise.resolve();

      // Another two failures - should NOT demote because counter was reset
      mockRedis.renewLockIfOwned.mockRejectedValue(new Error('Redis error'));
      jest.advanceTimersByTime(10000);
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(10000);
      await Promise.resolve();
      await Promise.resolve();

      expect(svc.isLeader).toBe(true); // Still leader
    });
  });

  describe('standby mode', () => {
    it('should not acquire leadership in standby mode', async () => {
      const svc = createService({ isStandby: true });

      await svc.start();

      expect(svc.isLeader).toBe(false);
      expect(mockRedis.setNx).not.toHaveBeenCalled();
    });

    it('should acquire leadership when activating from standby', async () => {
      const svc = createService({ isStandby: true });

      await svc.start();
      expect(svc.isLeader).toBe(false);

      // Signal activation
      svc.setActivating(true);
      await svc.tryAcquireLeadership();

      expect(svc.isLeader).toBe(true);
    });

    it('should not acquire leadership when canBecomeLeader is false', async () => {
      const svc = createService({ canBecomeLeader: false });

      await svc.start();

      expect(svc.isLeader).toBe(false);
      expect(mockRedis.setNx).not.toHaveBeenCalled();
    });
  });

  describe('tryAcquireLeadership', () => {
    it('should return true when lock is acquired via setNx', async () => {
      const svc = createService();

      const result = await svc.tryAcquireLeadership();

      expect(result).toBe(true);
      expect(svc.isLeader).toBe(true);
    });

    it('should return true when lock is renewed (already owned)', async () => {
      mockRedis.setNx.mockResolvedValue(false);
      mockRedis.renewLockIfOwned.mockResolvedValue(true);

      const svc = createService();
      const result = await svc.tryAcquireLeadership();

      expect(result).toBe(true);
      expect(svc.isLeader).toBe(true);
    });

    it('should return false when another instance holds the lock', async () => {
      mockRedis.setNx.mockResolvedValue(false);
      mockRedis.renewLockIfOwned.mockResolvedValue(false);

      const svc = createService();
      const result = await svc.tryAcquireLeadership();

      expect(result).toBe(false);
      expect(svc.isLeader).toBe(false);
    });

    it('should handle Redis errors gracefully', async () => {
      mockRedis.setNx.mockRejectedValue(new Error('Connection failed'));

      const svc = createService();
      const result = await svc.tryAcquireLeadership();

      expect(result).toBe(false);
      expect(svc.isLeader).toBe(false);
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('instanceId', () => {
    it('should expose instance ID', () => {
      const svc = createService();

      expect(svc.instanceId).toBe('test-instance-1');
    });
  });
});
