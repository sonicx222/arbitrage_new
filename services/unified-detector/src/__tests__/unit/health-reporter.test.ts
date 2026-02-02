/**
 * Unit Tests for HealthReporter
 *
 * Tests the health reporting module extracted from UnifiedChainDetector.
 */

import { EventEmitter } from 'events';
import {
  HealthReporter,
  createHealthReporter,
  HealthReporterConfig,
} from '../../health-reporter';
import type { ChainStats } from '../../types';
import { PartitionHealth, ChainHealth } from '@arbitrage/config';
import { RecordingLogger } from '@arbitrage/core';

// =============================================================================
// Mock Types
// =============================================================================

interface MockCrossRegionHealthManager extends EventEmitter {
  start: jest.Mock;
  stop: jest.Mock;
}

// =============================================================================
// Tests
// =============================================================================

describe('HealthReporter', () => {
  let logger: RecordingLogger;
  let mockStreamsClient: { xadd: jest.Mock };
  let mockStateManager: { isRunning: jest.Mock };
  let mockCrossRegionHealth: MockCrossRegionHealthManager;
  let mockGetCrossRegionHealthManager: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    logger = new RecordingLogger();

    mockStreamsClient = {
      xadd: jest.fn().mockResolvedValue('stream-id'),
    };

    mockStateManager = {
      isRunning: jest.fn().mockReturnValue(true),
    };

    mockCrossRegionHealth = new EventEmitter() as MockCrossRegionHealthManager;
    mockCrossRegionHealth.start = jest.fn().mockResolvedValue(undefined);
    mockCrossRegionHealth.stop = jest.fn().mockResolvedValue(undefined);

    mockGetCrossRegionHealthManager = jest.fn().mockReturnValue(mockCrossRegionHealth);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ===========================================================================
  // Creation
  // ===========================================================================

  describe('createHealthReporter', () => {
    it('should create reporter with required config', () => {
      const reporter = createHealthReporter({
        partitionId: 'test-partition',
        instanceId: 'test-instance',
        regionId: 'us-east1',
        streamsClient: mockStreamsClient as any,
        stateManager: mockStateManager as any,
        logger: logger as any,
        getHealthData: jest.fn(),
      });

      expect(reporter).toBeDefined();
      expect(typeof reporter.start).toBe('function');
      expect(typeof reporter.stop).toBe('function');
    });
  });

  // ===========================================================================
  // start
  // ===========================================================================

  // Default mock health data
  const mockHealthData: PartitionHealth = {
    partitionId: 'test-partition',
    status: 'healthy',
    chainHealth: new Map(),
    totalEventsProcessed: 0,
    avgEventLatencyMs: 0,
    memoryUsage: 0,
    cpuUsage: 0,
    uptimeSeconds: 0,
    lastHealthCheck: Date.now(),
    activeOpportunities: 0,
  };

  describe('start', () => {
    it('should initialize cross-region health when enabled', async () => {
      const reporter = createHealthReporter({
        partitionId: 'test-partition',
        instanceId: 'test-instance',
        regionId: 'us-east1',
        streamsClient: mockStreamsClient as any,
        stateManager: mockStateManager as any,
        logger: logger as any,
        getHealthData: jest.fn().mockResolvedValue(mockHealthData),
        enableCrossRegionHealth: true,
        getCrossRegionHealthManager: mockGetCrossRegionHealthManager,
      });

      await reporter.start();

      expect(mockGetCrossRegionHealthManager).toHaveBeenCalledWith(
        expect.objectContaining({
          instanceId: 'test-instance',
          regionId: 'us-east1',
        })
      );
      expect(mockCrossRegionHealth.start).toHaveBeenCalled();
    });

    it('should not initialize cross-region health when disabled', async () => {
      const reporter = createHealthReporter({
        partitionId: 'test-partition',
        instanceId: 'test-instance',
        regionId: 'us-east1',
        streamsClient: mockStreamsClient as any,
        stateManager: mockStateManager as any,
        logger: logger as any,
        getHealthData: jest.fn().mockResolvedValue(mockHealthData),
        enableCrossRegionHealth: false,
      });

      await reporter.start();

      expect(mockGetCrossRegionHealthManager).not.toHaveBeenCalled?.();
    });

    it('should start health monitoring interval', async () => {
      const mockGetHealthData = jest.fn().mockResolvedValue({
        partitionId: 'test-partition',
        status: 'healthy',
        chainHealth: new Map(),
        totalEventsProcessed: 100,
        avgEventLatencyMs: 50,
        memoryUsage: 1024,
        cpuUsage: 0,
        uptimeSeconds: 60,
        lastHealthCheck: Date.now(),
        activeOpportunities: 0,
      } as PartitionHealth);

      const reporter = createHealthReporter({
        partitionId: 'test-partition',
        instanceId: 'test-instance',
        regionId: 'us-east1',
        streamsClient: mockStreamsClient as any,
        stateManager: mockStateManager as any,
        logger: logger as any,
        getHealthData: mockGetHealthData,
        healthCheckIntervalMs: 1000,
      });

      await reporter.start();

      // Advance timer to trigger health check
      jest.advanceTimersByTime(1000);
      await Promise.resolve(); // Allow async operations to complete

      expect(mockGetHealthData).toHaveBeenCalled();
    });

    it('should emit failover events from cross-region health', async () => {
      const reporter = createHealthReporter({
        partitionId: 'test-partition',
        instanceId: 'test-instance',
        regionId: 'us-east1',
        streamsClient: mockStreamsClient as any,
        stateManager: mockStateManager as any,
        logger: logger as any,
        getHealthData: jest.fn().mockResolvedValue(mockHealthData),
        enableCrossRegionHealth: true,
        getCrossRegionHealthManager: mockGetCrossRegionHealthManager,
      });

      const failoverHandler = jest.fn();
      reporter.on('failoverEvent', failoverHandler);

      await reporter.start();

      // Emit failover event from cross-region health
      const mockEvent = { type: 'failover', region: 'us-west1' };
      mockCrossRegionHealth.emit('failoverEvent', mockEvent);

      expect(failoverHandler).toHaveBeenCalledWith(mockEvent);
    });

    // FIX B2: Test concurrency guard prevents concurrent health checks
    it('should skip health check when already checking (B2 fix)', async () => {
      let resolveSlowHealthData: (value: PartitionHealth) => void;
      const slowHealthData = new Promise<PartitionHealth>((resolve) => {
        resolveSlowHealthData = resolve;
      });

      let callCount = 0;
      const mockGetHealthData = jest.fn().mockImplementation(() => {
        callCount++;
        // First call is from initial fire-and-forget (fast)
        // Second call will be slow (from interval)
        if (callCount === 2) {
          return slowHealthData; // Second call is slow
        }
        return Promise.resolve(mockHealthData); // Other calls are fast
      });

      const reporter = createHealthReporter({
        partitionId: 'test-partition',
        instanceId: 'test-instance',
        regionId: 'us-east1',
        streamsClient: mockStreamsClient as any,
        stateManager: mockStateManager as any,
        logger: logger as any,
        getHealthData: mockGetHealthData,
        healthCheckIntervalMs: 100, // Short interval
      });

      await reporter.start();
      // Allow initial fire-and-forget to complete
      await Promise.resolve();
      await Promise.resolve();

      // First call is from initial health report
      expect(mockGetHealthData).toHaveBeenCalledTimes(1);

      // First interval tick - starts slow health check (call 2)
      jest.advanceTimersByTime(100);
      await Promise.resolve();

      expect(mockGetHealthData).toHaveBeenCalledTimes(2);

      // Second interval tick - should be skipped due to concurrency guard
      jest.advanceTimersByTime(100);
      await Promise.resolve();

      // Third interval tick - should still be skipped
      jest.advanceTimersByTime(100);
      await Promise.resolve();

      // Still only 2 calls (initial + slow one) - concurrency guard prevents new calls
      expect(mockGetHealthData).toHaveBeenCalledTimes(2);

      // Now resolve the slow health check
      resolveSlowHealthData!(mockHealthData);
      // Let the publishHealth complete
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Concurrency guard should be cleared now, next interval should work
      // The interval has already ticked while we were waiting, so no extra calls yet
      // We need another interval tick
      jest.advanceTimersByTime(100);
      // Multiple promise resolutions to let async operations complete
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Should have call 3 now
      expect(mockGetHealthData).toHaveBeenCalledTimes(3);
    });
  });

  // ===========================================================================
  // stop
  // ===========================================================================

  describe('stop', () => {
    it('should clear health check interval', async () => {
      const getHealthDataMock = jest.fn().mockResolvedValue(mockHealthData);
      const reporter = createHealthReporter({
        partitionId: 'test-partition',
        instanceId: 'test-instance',
        regionId: 'us-east1',
        streamsClient: mockStreamsClient as any,
        stateManager: mockStateManager as any,
        logger: logger as any,
        getHealthData: getHealthDataMock,
        healthCheckIntervalMs: 1000,
      });

      await reporter.start();
      await reporter.stop();

      // Clear the mock call count after stop
      getHealthDataMock.mockClear();

      // Advance timer - health check should NOT be called after stop
      jest.advanceTimersByTime(2000);

      expect(getHealthDataMock).not.toHaveBeenCalled();
    });

    it('should stop cross-region health manager', async () => {
      const reporter = createHealthReporter({
        partitionId: 'test-partition',
        instanceId: 'test-instance',
        regionId: 'us-east1',
        streamsClient: mockStreamsClient as any,
        stateManager: mockStateManager as any,
        logger: logger as any,
        getHealthData: jest.fn().mockResolvedValue(mockHealthData),
        enableCrossRegionHealth: true,
        getCrossRegionHealthManager: mockGetCrossRegionHealthManager,
      });

      await reporter.start();
      await reporter.stop();

      expect(mockCrossRegionHealth.stop).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // publishHealth
  // ===========================================================================

  describe('publishHealth', () => {
    it('should publish health to Redis Streams', async () => {
      const mockHealth: PartitionHealth = {
        partitionId: 'test-partition',
        status: 'healthy',
        chainHealth: new Map([
          ['ethereum', {
            chainId: 'ethereum',
            status: 'healthy',
            blocksBehind: 0,
            lastBlockTime: Date.now(),
            wsConnected: true,
            eventsPerSecond: 10,
            errorCount: 0,
          }],
        ]),
        totalEventsProcessed: 100,
        avgEventLatencyMs: 50,
        memoryUsage: 1024,
        cpuUsage: 0,
        uptimeSeconds: 60,
        lastHealthCheck: Date.now(),
        activeOpportunities: 0,
      };

      const mockGetHealthData = jest.fn().mockResolvedValue(mockHealth);

      const reporter = createHealthReporter({
        partitionId: 'test-partition',
        instanceId: 'test-instance',
        regionId: 'us-east1',
        streamsClient: mockStreamsClient as any,
        stateManager: mockStateManager as any,
        logger: logger as any,
        getHealthData: mockGetHealthData,
        healthCheckIntervalMs: 1000,
      });

      await reporter.start();

      // Trigger health check
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve(); // Allow multiple microtask cycles

      expect(mockStreamsClient.xadd).toHaveBeenCalled();
    });

    it('should skip publishing when service is not running', async () => {
      mockStateManager.isRunning.mockReturnValue(false);

      const mockGetHealthData = jest.fn().mockResolvedValue({
        partitionId: 'test-partition',
        status: 'healthy',
        chainHealth: new Map(),
      });

      const reporter = createHealthReporter({
        partitionId: 'test-partition',
        instanceId: 'test-instance',
        regionId: 'us-east1',
        streamsClient: mockStreamsClient as any,
        stateManager: mockStateManager as any,
        logger: logger as any,
        getHealthData: mockGetHealthData,
        healthCheckIntervalMs: 1000,
      });

      await reporter.start();

      // Advance timer
      jest.advanceTimersByTime(1000);
      await Promise.resolve();

      // Should not publish when service is not running
      expect(mockStreamsClient.xadd).not.toHaveBeenCalled();
    });

    it('should handle publish errors gracefully', async () => {
      mockStreamsClient.xadd.mockRejectedValue(new Error('Redis connection error'));

      const mockGetHealthData = jest.fn().mockResolvedValue({
        partitionId: 'test-partition',
        status: 'healthy',
        chainHealth: new Map(),
        totalEventsProcessed: 0,
        avgEventLatencyMs: 0,
        memoryUsage: 0,
        cpuUsage: 0,
        uptimeSeconds: 0,
        lastHealthCheck: Date.now(),
        activeOpportunities: 0,
      });

      const reporter = createHealthReporter({
        partitionId: 'test-partition',
        instanceId: 'test-instance',
        regionId: 'us-east1',
        streamsClient: mockStreamsClient as any,
        stateManager: mockStateManager as any,
        logger: logger as any,
        getHealthData: mockGetHealthData,
        healthCheckIntervalMs: 1000,
      });

      await reporter.start();

      // Trigger health check
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();

      // Should log error but not crash
      expect(logger.hasLogMatching('error', /publish/i)).toBe(true);
      const errorLogs = logger.getLogs('error');
      expect(errorLogs.length).toBeGreaterThan(0);
      expect(errorLogs[0].meta).toBeDefined();
    });
  });
});
