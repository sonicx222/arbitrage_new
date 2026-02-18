/**
 * Unit Tests for MetricsCollector
 *
 * Tests the metrics collection module extracted from UnifiedChainDetector.
 */

import {
  MetricsCollector,
  createMetricsCollector,
} from '../../src/metrics-collector';
import type { UnifiedDetectorStats } from '../../src/unified-detector';
import type { ChainStats } from '../../src/types';
import { RecordingLogger } from '@arbitrage/core';

// =============================================================================
// Tests
// =============================================================================

describe('MetricsCollector', () => {
  let logger: RecordingLogger;
  let mockPerfLogger: { logHealthCheck: jest.Mock };
  let mockStateManager: { isRunning: jest.Mock };
  let mockGetStats: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    logger = new RecordingLogger();

    mockPerfLogger = {
      logHealthCheck: jest.fn(),
    };

    mockStateManager = {
      isRunning: jest.fn().mockReturnValue(true),
    };

    mockGetStats = jest.fn().mockReturnValue({
      partitionId: 'test-partition',
      chains: ['ethereum', 'polygon'],
      totalEventsProcessed: 1000,
      totalOpportunitiesFound: 50,
      uptimeSeconds: 3600,
      memoryUsageMB: 256,
      chainStats: new Map<string, ChainStats>([
        ['ethereum', {
          chainId: 'ethereum',
          status: 'connected',
          eventsProcessed: 600,
          opportunitiesFound: 30,
          lastBlockNumber: 12345678,
          avgBlockLatencyMs: 100,
          pairsMonitored: 50,
        }],
        ['polygon', {
          chainId: 'polygon',
          status: 'connected',
          eventsProcessed: 400,
          opportunitiesFound: 20,
          lastBlockNumber: 54321,
          avgBlockLatencyMs: 50,
          pairsMonitored: 30,
        }],
      ]),
    } as UnifiedDetectorStats);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ===========================================================================
  // Creation
  // ===========================================================================

  describe('createMetricsCollector', () => {
    it('should create collector with required config', () => {
      const collector = createMetricsCollector({
        partitionId: 'test-partition',
        perfLogger: mockPerfLogger as any,
        stateManager: mockStateManager as any,
        logger: logger as any,
        getStats: mockGetStats,
      });

      expect(collector).toBeDefined();
      expect(typeof collector.start).toBe('function');
      expect(typeof collector.stop).toBe('function');
    });
  });

  // ===========================================================================
  // start
  // ===========================================================================

  describe('start', () => {
    it('should start metrics collection interval', () => {
      const collector = createMetricsCollector({
        partitionId: 'test-partition',
        perfLogger: mockPerfLogger as any,
        stateManager: mockStateManager as any,
        logger: logger as any,
        getStats: mockGetStats,
        metricsIntervalMs: 1000,
      });

      collector.start();

      // Advance timer to trigger metrics collection
      jest.advanceTimersByTime(1000);

      expect(mockGetStats).toHaveBeenCalled();
      expect(mockPerfLogger.logHealthCheck).toHaveBeenCalledWith(
        'unified-detector-test-partition',
        expect.objectContaining({
          status: 'healthy',
          uptime: 3600,
          chainsMonitored: 2,
          eventsProcessed: 1000,
          opportunitiesFound: 50,
        })
      );
    });

    it('should use default interval of 60 seconds', () => {
      const collector = createMetricsCollector({
        partitionId: 'test-partition',
        perfLogger: mockPerfLogger as any,
        stateManager: mockStateManager as any,
        logger: logger as any,
        getStats: mockGetStats,
      });

      collector.start();

      // Should not be called before 60 seconds
      jest.advanceTimersByTime(59000);
      expect(mockPerfLogger.logHealthCheck).not.toHaveBeenCalled();

      // Should be called at 60 seconds
      jest.advanceTimersByTime(1000);
      expect(mockPerfLogger.logHealthCheck).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // stop
  // ===========================================================================

  describe('stop', () => {
    it('should clear metrics collection interval', async () => {
      const collector = createMetricsCollector({
        partitionId: 'test-partition',
        perfLogger: mockPerfLogger as any,
        stateManager: mockStateManager as any,
        logger: logger as any,
        getStats: mockGetStats,
        metricsIntervalMs: 1000,
      });

      collector.start();
      await collector.stop(); // FIX I1: now async

      // Advance timer - metrics should NOT be collected after stop
      mockGetStats.mockClear();
      mockPerfLogger.logHealthCheck.mockClear();
      jest.advanceTimersByTime(2000);

      expect(mockGetStats).not.toHaveBeenCalled();
      expect(mockPerfLogger.logHealthCheck).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // State-aware collection
  // ===========================================================================

  describe('state-aware collection', () => {
    it('should skip collection when service is not running', () => {
      mockStateManager.isRunning.mockReturnValue(false);

      const collector = createMetricsCollector({
        partitionId: 'test-partition',
        perfLogger: mockPerfLogger as any,
        stateManager: mockStateManager as any,
        logger: logger as any,
        getStats: mockGetStats,
        metricsIntervalMs: 1000,
      });

      collector.start();

      // Advance timer
      jest.advanceTimersByTime(1000);

      // Should not collect when not running
      expect(mockGetStats).not.toHaveBeenCalled();
      expect(mockPerfLogger.logHealthCheck).not.toHaveBeenCalled();
    });

    it('should handle getStats errors gracefully', () => {
      mockGetStats.mockImplementation(() => {
        throw new Error('Stats collection error');
      });

      const collector = createMetricsCollector({
        partitionId: 'test-partition',
        perfLogger: mockPerfLogger as any,
        stateManager: mockStateManager as any,
        logger: logger as any,
        getStats: mockGetStats,
        metricsIntervalMs: 1000,
      });

      collector.start();

      // Should not throw
      expect(() => jest.advanceTimersByTime(1000)).not.toThrow();

      // Should log error
      expect(logger.hasLogMatching('error', /Metrics collection error/)).toBe(true);
    });
  });

  // ===========================================================================
  // Memory calculation
  // ===========================================================================

  describe('memory calculation', () => {
    it('should convert memory from MB to bytes for perfLogger', () => {
      const collector = createMetricsCollector({
        partitionId: 'test-partition',
        perfLogger: mockPerfLogger as any,
        stateManager: mockStateManager as any,
        logger: logger as any,
        getStats: mockGetStats,
        metricsIntervalMs: 1000,
      });

      collector.start();
      jest.advanceTimersByTime(1000);

      expect(mockPerfLogger.logHealthCheck).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          memoryUsage: 256 * 1024 * 1024, // 256 MB in bytes
        })
      );
    });
  });
});
