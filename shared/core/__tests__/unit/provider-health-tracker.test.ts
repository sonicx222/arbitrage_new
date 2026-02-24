/**
 * ProviderHealthTracker Unit Tests
 *
 * Tests for the provider health tracker that manages connection quality metrics,
 * staleness detection, block number tracking, and proactive health checks.
 *
 * Fix 3.2: Phase 3 test coverage for extracted cold-path health tracking logic.
 *
 * @see shared/core/src/provider-health-tracker.ts
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

// =============================================================================
// Mock Setup — Must be before source imports
// =============================================================================

jest.mock('../../src/logger');

jest.mock('../../src/lifecycle-utils');

// =============================================================================
// Import under test (after mocks)
// =============================================================================

import { ProviderHealthTracker, HealthTrackerConfig } from '../../src/monitoring/provider-health-tracker';
import { clearIntervalSafe } from '../../src/lifecycle-utils';

const mockedClearIntervalSafe = clearIntervalSafe as jest.MockedFunction<typeof clearIntervalSafe>;

// =============================================================================
// Test Helpers
// =============================================================================

function createTracker(overrides: Partial<HealthTrackerConfig> = {}): ProviderHealthTracker {
  return new ProviderHealthTracker({
    chainId: 'ethereum',
    ...overrides,
  });
}

// =============================================================================
// Tests
// =============================================================================

describe('ProviderHealthTracker', () => {
  let tracker: ProviderHealthTracker;
  let dateNowSpy: jest.SpiedFunction<typeof Date.now>;

  beforeEach(() => {
    jest.useFakeTimers();
    // Re-set mock implementation (resetMocks: true in jest.config clears after each test)
    mockedClearIntervalSafe.mockImplementation((interval: NodeJS.Timeout | null) => {
      if (interval) {
        clearInterval(interval);
      }
      return null;
    });
    tracker = createTracker();
    dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(1000000);
  });

  afterEach(() => {
    tracker.reset();
    dateNowSpy.mockRestore();
    jest.useRealTimers();
  });

  // ===========================================================================
  // Constructor / Chain-Specific Thresholds
  // ===========================================================================

  describe('constructor', () => {
    it('should default chainId to "unknown"', () => {
      const unknownTracker = new ProviderHealthTracker({});
      // The tracker should function — verified through staleness threshold being 15000 (default)
      unknownTracker.onConnected();
      dateNowSpy.mockReturnValue(1000000 + 15001);
      expect(unknownTracker.isConnectionStale(1)).toBe(true);
    });

    it('should use custom stalenessThresholdMs when provided', () => {
      const customTracker = createTracker({ stalenessThresholdMs: 3000 });
      customTracker.onConnected();

      dateNowSpy.mockReturnValue(1000000 + 3001);
      expect(customTracker.isConnectionStale(1)).toBe(true);
    });

    it('should use chain-specific threshold when stalenessThresholdMs is not provided', () => {
      const arbTracker = createTracker({ chainId: 'arbitrum' });
      arbTracker.onConnected();

      // Arbitrum threshold is 5000ms
      dateNowSpy.mockReturnValue(1000000 + 4999);
      expect(arbTracker.isConnectionStale(1)).toBe(false);

      dateNowSpy.mockReturnValue(1000000 + 5001);
      expect(arbTracker.isConnectionStale(1)).toBe(true);
    });

    describe('chain-specific staleness thresholds', () => {
      const fastChains = ['arbitrum', 'solana'];
      const mediumChains = ['polygon', 'bsc', 'optimism', 'base', 'avalanche', 'fantom'];
      const slowChains = ['ethereum', 'zksync', 'linea'];

      for (const chain of fastChains) {
        it(`should use 5000ms threshold for ${chain}`, () => {
          const t = createTracker({ chainId: chain });
          t.onConnected();

          dateNowSpy.mockReturnValue(1000000 + 5000);
          expect(t.isConnectionStale(1)).toBe(false);

          dateNowSpy.mockReturnValue(1000000 + 5001);
          expect(t.isConnectionStale(1)).toBe(true);
        });
      }

      for (const chain of mediumChains) {
        it(`should use 10000ms threshold for ${chain}`, () => {
          const t = createTracker({ chainId: chain });
          t.onConnected();

          dateNowSpy.mockReturnValue(1000000 + 10000);
          expect(t.isConnectionStale(1)).toBe(false);

          dateNowSpy.mockReturnValue(1000000 + 10001);
          expect(t.isConnectionStale(1)).toBe(true);
        });
      }

      for (const chain of slowChains) {
        it(`should use 15000ms threshold for ${chain}`, () => {
          const t = createTracker({ chainId: chain });
          t.onConnected();

          dateNowSpy.mockReturnValue(1000000 + 15000);
          expect(t.isConnectionStale(1)).toBe(false);

          dateNowSpy.mockReturnValue(1000000 + 15001);
          expect(t.isConnectionStale(1)).toBe(true);
        });
      }

      it('should use 15000ms default threshold for unknown chains', () => {
        const t = createTracker({ chainId: 'some-unknown-chain' });
        t.onConnected();

        dateNowSpy.mockReturnValue(1000000 + 15001);
        expect(t.isConnectionStale(1)).toBe(true);
      });

      it('should be case-insensitive for chain matching', () => {
        const t = createTracker({ chainId: 'ARBITRUM' });
        t.onConnected();

        // Arbitrum threshold = 5000ms
        dateNowSpy.mockReturnValue(1000000 + 5001);
        expect(t.isConnectionStale(1)).toBe(true);
      });
    });
  });

  // ===========================================================================
  // Connection Lifecycle
  // ===========================================================================

  describe('onConnected()', () => {
    it('should set connectionStartTime to current time', () => {
      tracker.onConnected();
      expect(tracker.qualityMetrics.connectionStartTime).toBe(1000000);
    });

    it('should set lastMessageTime to current time', () => {
      tracker.onConnected();
      expect(tracker.qualityMetrics.lastMessageTime).toBe(1000000);
    });

    it('should update both timestamps when called again', () => {
      tracker.onConnected();
      dateNowSpy.mockReturnValue(2000000);
      tracker.onConnected();

      expect(tracker.qualityMetrics.connectionStartTime).toBe(2000000);
      expect(tracker.qualityMetrics.lastMessageTime).toBe(2000000);
    });
  });

  describe('onReconnecting()', () => {
    it('should increment reconnectCount by 1', () => {
      expect(tracker.qualityMetrics.reconnectCount).toBe(0);

      tracker.onReconnecting();
      expect(tracker.qualityMetrics.reconnectCount).toBe(1);

      tracker.onReconnecting();
      expect(tracker.qualityMetrics.reconnectCount).toBe(2);
    });

    it('should not affect other metrics', () => {
      tracker.onConnected();
      const prevMessageTime = tracker.qualityMetrics.lastMessageTime;
      const prevStartTime = tracker.qualityMetrics.connectionStartTime;

      tracker.onReconnecting();

      expect(tracker.qualityMetrics.lastMessageTime).toBe(prevMessageTime);
      expect(tracker.qualityMetrics.connectionStartTime).toBe(prevStartTime);
    });
  });

  // ===========================================================================
  // Quality Metrics
  // ===========================================================================

  describe('getQualityMetrics()', () => {
    it('should return all quality metrics', () => {
      tracker.onConnected();
      tracker.qualityMetrics.messagesReceived = 42;
      tracker.qualityMetrics.errorsEncountered = 3;

      const metrics = tracker.getQualityMetrics(5);

      expect(metrics.lastMessageTime).toBe(1000000);
      expect(metrics.reconnectCount).toBe(0);
      expect(metrics.messagesReceived).toBe(42);
      expect(metrics.errorsEncountered).toBe(3);
      expect(metrics.lastBlockNumber).toBe(0);
    });

    it('should calculate messageGapMs from lastMessageTime', () => {
      tracker.onConnected();
      dateNowSpy.mockReturnValue(1005000); // 5 seconds later

      const metrics = tracker.getQualityMetrics(1);
      expect(metrics.messageGapMs).toBe(5000);
    });

    it('should return messageGapMs as 0 when lastMessageTime is 0', () => {
      // Never connected
      const metrics = tracker.getQualityMetrics(0);
      expect(metrics.messageGapMs).toBe(0);
    });

    it('should calculate uptime from connectionStartTime', () => {
      tracker.onConnected();
      dateNowSpy.mockReturnValue(1010000); // 10 seconds later

      const metrics = tracker.getQualityMetrics(1);
      expect(metrics.uptime).toBe(10000);
    });

    it('should return uptime as 0 when connectionStartTime is 0', () => {
      const metrics = tracker.getQualityMetrics(0);
      expect(metrics.uptime).toBe(0);
    });

    it('should include isStale flag', () => {
      tracker.onConnected();

      // Not stale yet
      dateNowSpy.mockReturnValue(1001000);
      expect(tracker.getQualityMetrics(1).isStale).toBe(false);

      // Stale (ethereum threshold = 15000ms)
      dateNowSpy.mockReturnValue(1015001);
      expect(tracker.getQualityMetrics(1).isStale).toBe(true);
    });

    it('should report not stale when subscriptionCount is 0', () => {
      tracker.onConnected();
      dateNowSpy.mockReturnValue(1100000); // way past threshold

      expect(tracker.getQualityMetrics(0).isStale).toBe(false);
    });
  });

  // ===========================================================================
  // Staleness Detection
  // ===========================================================================

  describe('isConnectionStale()', () => {
    it('should return false when subscriptionCount is 0', () => {
      tracker.onConnected();
      dateNowSpy.mockReturnValue(1100000);
      expect(tracker.isConnectionStale(0)).toBe(false);
    });

    it('should return false when lastMessageTime is 0 (never received a message)', () => {
      expect(tracker.isConnectionStale(1)).toBe(false);
    });

    it('should return false when message gap is within threshold', () => {
      tracker.onConnected();
      dateNowSpy.mockReturnValue(1000000 + 14999); // just under 15000ms
      expect(tracker.isConnectionStale(1)).toBe(false);
    });

    it('should return false when message gap equals threshold exactly', () => {
      tracker.onConnected();
      dateNowSpy.mockReturnValue(1000000 + 15000); // exactly at threshold
      expect(tracker.isConnectionStale(1)).toBe(false);
    });

    it('should return true when message gap exceeds threshold', () => {
      tracker.onConnected();
      dateNowSpy.mockReturnValue(1000000 + 15001);
      expect(tracker.isConnectionStale(1)).toBe(true);
    });

    it('should use updated lastMessageTime from recordBlockNumber', () => {
      tracker.onConnected();
      dateNowSpy.mockReturnValue(1010000);
      tracker.recordBlockNumber(100);

      // Now lastMessageTime is 1010000
      dateNowSpy.mockReturnValue(1010000 + 14999);
      expect(tracker.isConnectionStale(1)).toBe(false);

      dateNowSpy.mockReturnValue(1010000 + 15001);
      expect(tracker.isConnectionStale(1)).toBe(true);
    });
  });

  describe('setStalenessThreshold()', () => {
    it('should override the chain-specific threshold', () => {
      tracker.onConnected();

      // Default ethereum threshold is 15000ms
      tracker.setStalenessThreshold(3000);

      dateNowSpy.mockReturnValue(1000000 + 3001);
      expect(tracker.isConnectionStale(1)).toBe(true);
    });

    it('should allow setting a very short threshold', () => {
      tracker.onConnected();
      tracker.setStalenessThreshold(1);

      dateNowSpy.mockReturnValue(1000000 + 2);
      expect(tracker.isConnectionStale(1)).toBe(true);
    });

    it('should allow setting a very long threshold', () => {
      tracker.onConnected();
      tracker.setStalenessThreshold(3600000); // 1 hour

      dateNowSpy.mockReturnValue(1000000 + 3599999);
      expect(tracker.isConnectionStale(1)).toBe(false);
    });
  });

  // ===========================================================================
  // Block Number Tracking & Data Gap Detection
  // ===========================================================================

  describe('recordBlockNumber()', () => {
    it('should update lastBlockNumber', () => {
      tracker.recordBlockNumber(12345);
      expect(tracker.qualityMetrics.lastBlockNumber).toBe(12345);
    });

    it('should update lastMessageTime to current time', () => {
      dateNowSpy.mockReturnValue(2000000);
      tracker.recordBlockNumber(100);
      expect(tracker.qualityMetrics.lastMessageTime).toBe(2000000);
    });

    it('should update with successive block numbers', () => {
      tracker.recordBlockNumber(100);
      tracker.recordBlockNumber(101);
      tracker.recordBlockNumber(102);
      expect(tracker.qualityMetrics.lastBlockNumber).toBe(102);
    });
  });

  describe('checkForDataGap()', () => {
    it('should return null for the first block (no previous block to compare)', () => {
      const result = tracker.checkForDataGap(100);
      expect(result).toBeNull();
    });

    it('should return null for consecutive blocks (no gap)', () => {
      tracker.recordBlockNumber(100);
      const result = tracker.checkForDataGap(101);
      expect(result).toBeNull();
    });

    it('should detect a gap of 1 missed block', () => {
      tracker.recordBlockNumber(100);
      const result = tracker.checkForDataGap(102);

      expect(result).toEqual({
        fromBlock: 101,
        toBlock: 101,
        missedBlocks: 1,
      });
    });

    it('should detect a gap of multiple missed blocks', () => {
      tracker.recordBlockNumber(100);
      const result = tracker.checkForDataGap(110);

      expect(result).toEqual({
        fromBlock: 101,
        toBlock: 109,
        missedBlocks: 9,
      });
    });

    it('should return null when new block is same as last (no gap)', () => {
      tracker.recordBlockNumber(100);
      // missedBlocks = 100 - 100 - 1 = -1, which is not > 0
      const result = tracker.checkForDataGap(100);
      expect(result).toBeNull();
    });

    it('should return null when new block is less than last (reorg/backward)', () => {
      tracker.recordBlockNumber(100);
      // missedBlocks = 95 - 100 - 1 = -6, not > 0
      const result = tracker.checkForDataGap(95);
      expect(result).toBeNull();
    });

    it('should detect large gaps', () => {
      tracker.recordBlockNumber(1000);
      const result = tracker.checkForDataGap(2000);

      expect(result).toEqual({
        fromBlock: 1001,
        toBlock: 1999,
        missedBlocks: 999,
      });
    });
  });

  // ===========================================================================
  // Proactive Health Check Timer
  // ===========================================================================

  describe('startProactiveHealthCheck()', () => {
    let onStaleMock: jest.Mock;
    let isConnectedMock: jest.Mock<() => boolean>;
    let subscriptionCountMock: jest.Mock<() => number>;

    beforeEach(() => {
      onStaleMock = jest.fn();
      isConnectedMock = jest.fn<() => boolean>().mockReturnValue(true);
      subscriptionCountMock = jest.fn<() => number>().mockReturnValue(1);
    });

    it('should call onStale when connection is stale', () => {
      tracker.onConnected();

      tracker.startProactiveHealthCheck(
        10000,
        onStaleMock,
        isConnectedMock,
        subscriptionCountMock,
      );

      // Advance past staleness threshold (ethereum = 15000ms)
      dateNowSpy.mockReturnValue(1000000 + 16000);
      jest.advanceTimersByTime(10000);

      expect(onStaleMock).toHaveBeenCalledTimes(1);
    });

    it('should not call onStale when connection is not stale', () => {
      tracker.onConnected();

      tracker.startProactiveHealthCheck(
        10000,
        onStaleMock,
        isConnectedMock,
        subscriptionCountMock,
      );

      // Advance but keep within threshold
      dateNowSpy.mockReturnValue(1000000 + 5000);
      jest.advanceTimersByTime(10000);

      expect(onStaleMock).not.toHaveBeenCalled();
    });

    it('should not call onStale when not connected', () => {
      tracker.onConnected();
      isConnectedMock.mockReturnValue(false);

      tracker.startProactiveHealthCheck(
        10000,
        onStaleMock,
        isConnectedMock,
        subscriptionCountMock,
      );

      dateNowSpy.mockReturnValue(1000000 + 20000);
      jest.advanceTimersByTime(10000);

      expect(onStaleMock).not.toHaveBeenCalled();
    });

    it('should not call onStale when subscriptionCount is 0', () => {
      tracker.onConnected();
      subscriptionCountMock.mockReturnValue(0);

      tracker.startProactiveHealthCheck(
        10000,
        onStaleMock,
        isConnectedMock,
        subscriptionCountMock,
      );

      dateNowSpy.mockReturnValue(1000000 + 20000);
      jest.advanceTimersByTime(10000);

      expect(onStaleMock).not.toHaveBeenCalled();
    });

    it('should update messageGapMs metric each interval tick', () => {
      tracker.onConnected();

      tracker.startProactiveHealthCheck(
        5000,
        onStaleMock,
        isConnectedMock,
        subscriptionCountMock,
      );

      dateNowSpy.mockReturnValue(1000000 + 3000);
      jest.advanceTimersByTime(5000);

      expect(tracker.qualityMetrics.messageGapMs).toBe(3000);
    });

    it('should set messageGapMs to 0 when lastMessageTime is 0', () => {
      // Never connected, so lastMessageTime = 0

      tracker.startProactiveHealthCheck(
        5000,
        onStaleMock,
        isConnectedMock,
        subscriptionCountMock,
      );

      jest.advanceTimersByTime(5000);

      expect(tracker.qualityMetrics.messageGapMs).toBe(0);
    });

    it('should fire repeatedly on each interval', () => {
      tracker.onConnected();

      tracker.startProactiveHealthCheck(
        5000,
        onStaleMock,
        isConnectedMock,
        subscriptionCountMock,
      );

      // Each tick is stale
      dateNowSpy.mockReturnValue(1000000 + 20000);

      jest.advanceTimersByTime(5000);
      expect(onStaleMock).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(5000);
      expect(onStaleMock).toHaveBeenCalledTimes(2);

      jest.advanceTimersByTime(5000);
      expect(onStaleMock).toHaveBeenCalledTimes(3);
    });

    it('should stop previous health check before starting a new one', () => {
      tracker.onConnected();

      const firstOnStale = jest.fn();
      tracker.startProactiveHealthCheck(
        5000,
        firstOnStale,
        isConnectedMock,
        subscriptionCountMock,
      );

      // Start a new one — should stop the first
      tracker.startProactiveHealthCheck(
        5000,
        onStaleMock,
        isConnectedMock,
        subscriptionCountMock,
      );

      dateNowSpy.mockReturnValue(1000000 + 20000);
      jest.advanceTimersByTime(5000);

      // Only the new callback should fire
      expect(firstOnStale).not.toHaveBeenCalled();
      expect(onStaleMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('stopProactiveHealthCheck()', () => {
    it('should stop the interval timer', () => {
      const onStaleMock = jest.fn();
      tracker.onConnected();

      tracker.startProactiveHealthCheck(
        5000,
        onStaleMock,
        jest.fn<() => boolean>().mockReturnValue(true),
        jest.fn<() => number>().mockReturnValue(1),
      );

      tracker.stopProactiveHealthCheck();

      dateNowSpy.mockReturnValue(1000000 + 20000);
      jest.advanceTimersByTime(10000);

      expect(onStaleMock).not.toHaveBeenCalled();
    });

    it('should be safe to call when no timer is running', () => {
      expect(() => tracker.stopProactiveHealthCheck()).not.toThrow();
    });

    it('should be safe to call multiple times', () => {
      tracker.startProactiveHealthCheck(
        5000,
        jest.fn(),
        jest.fn<() => boolean>().mockReturnValue(true),
        jest.fn<() => number>().mockReturnValue(1),
      );

      tracker.stopProactiveHealthCheck();
      tracker.stopProactiveHealthCheck();
      // No error should occur
    });
  });

  // ===========================================================================
  // Cleanup / Reset
  // ===========================================================================

  describe('reset()', () => {
    it('should reset all quality metrics to initial values', () => {
      tracker.onConnected();
      tracker.onReconnecting();
      tracker.onReconnecting();
      tracker.recordBlockNumber(12345);
      tracker.qualityMetrics.messagesReceived = 100;
      tracker.qualityMetrics.errorsEncountered = 5;
      tracker.qualityMetrics.messageGapMs = 3000;

      tracker.reset();

      expect(tracker.qualityMetrics.lastMessageTime).toBe(0);
      expect(tracker.qualityMetrics.messageGapMs).toBe(0);
      expect(tracker.qualityMetrics.lastBlockNumber).toBe(0);
      expect(tracker.qualityMetrics.reconnectCount).toBe(0);
      expect(tracker.qualityMetrics.connectionStartTime).toBe(0);
      expect(tracker.qualityMetrics.messagesReceived).toBe(0);
      expect(tracker.qualityMetrics.errorsEncountered).toBe(0);
    });

    it('should stop proactive health check timer', () => {
      const onStaleMock = jest.fn();
      tracker.onConnected();

      tracker.startProactiveHealthCheck(
        5000,
        onStaleMock,
        jest.fn<() => boolean>().mockReturnValue(true),
        jest.fn<() => number>().mockReturnValue(1),
      );

      tracker.reset();

      dateNowSpy.mockReturnValue(1000000 + 20000);
      jest.advanceTimersByTime(10000);

      expect(onStaleMock).not.toHaveBeenCalled();
    });

    it('should allow fresh connection after reset', () => {
      tracker.onConnected();
      tracker.recordBlockNumber(100);
      tracker.onReconnecting();

      tracker.reset();

      // All metrics should be zeroed
      expect(tracker.qualityMetrics.lastBlockNumber).toBe(0);
      expect(tracker.qualityMetrics.reconnectCount).toBe(0);

      // Can reconnect fresh
      dateNowSpy.mockReturnValue(3000000);
      tracker.onConnected();
      expect(tracker.qualityMetrics.connectionStartTime).toBe(3000000);
    });
  });

  // ===========================================================================
  // Direct qualityMetrics Access (Public Property)
  // ===========================================================================

  describe('qualityMetrics (public property)', () => {
    it('should be directly accessible for hot-path writes', () => {
      tracker.qualityMetrics.lastMessageTime = 5000000;
      tracker.qualityMetrics.messagesReceived = 999;
      tracker.qualityMetrics.lastBlockNumber = 54321;

      expect(tracker.qualityMetrics.lastMessageTime).toBe(5000000);
      expect(tracker.qualityMetrics.messagesReceived).toBe(999);
      expect(tracker.qualityMetrics.lastBlockNumber).toBe(54321);
    });

    it('should reflect direct writes in getQualityMetrics()', () => {
      tracker.qualityMetrics.lastMessageTime = 1000000;
      tracker.qualityMetrics.connectionStartTime = 990000;
      tracker.qualityMetrics.messagesReceived = 50;
      tracker.qualityMetrics.errorsEncountered = 2;
      tracker.qualityMetrics.lastBlockNumber = 999;

      dateNowSpy.mockReturnValue(1005000);
      const metrics = tracker.getQualityMetrics(1);

      expect(metrics.messagesReceived).toBe(50);
      expect(metrics.errorsEncountered).toBe(2);
      expect(metrics.lastBlockNumber).toBe(999);
      expect(metrics.messageGapMs).toBe(5000);
      expect(metrics.uptime).toBe(15000); // 1005000 - 990000
    });

    it('should reflect direct writes in isConnectionStale()', () => {
      // Set lastMessageTime directly (like WebSocketManager hot path)
      tracker.qualityMetrics.lastMessageTime = 1000000;

      dateNowSpy.mockReturnValue(1000000 + 14999);
      expect(tracker.isConnectionStale(1)).toBe(false);

      dateNowSpy.mockReturnValue(1000000 + 15001);
      expect(tracker.isConnectionStale(1)).toBe(true);
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle very large block numbers', () => {
      tracker.recordBlockNumber(999999999);
      expect(tracker.qualityMetrics.lastBlockNumber).toBe(999999999);

      const gap = tracker.checkForDataGap(1000000010);
      expect(gap).toEqual({
        fromBlock: 1000000000,
        toBlock: 1000000009,
        missedBlocks: 10,
      });
    });

    it('should handle block number 0', () => {
      // lastBlockNumber starts at 0, so checkForDataGap returns null
      const result = tracker.checkForDataGap(0);
      expect(result).toBeNull();
    });

    it('should handle block number 1 after initialization', () => {
      // lastBlockNumber = 0 (initial), so first block returns null
      const result = tracker.checkForDataGap(1);
      expect(result).toBeNull();
    });

    it('should handle multiple onConnected calls (reconnection scenario)', () => {
      tracker.onConnected();
      expect(tracker.qualityMetrics.connectionStartTime).toBe(1000000);

      dateNowSpy.mockReturnValue(2000000);
      tracker.onConnected();
      expect(tracker.qualityMetrics.connectionStartTime).toBe(2000000);
      expect(tracker.qualityMetrics.lastMessageTime).toBe(2000000);
    });

    it('should handle interleaved recordBlockNumber and checkForDataGap', () => {
      tracker.recordBlockNumber(100);
      expect(tracker.checkForDataGap(101)).toBeNull(); // consecutive, no gap

      tracker.recordBlockNumber(101);
      expect(tracker.checkForDataGap(105)).toEqual({
        fromBlock: 102,
        toBlock: 104,
        missedBlocks: 3,
      });

      // After detecting gap, recording updates lastBlockNumber
      tracker.recordBlockNumber(105);
      expect(tracker.checkForDataGap(106)).toBeNull(); // consecutive again
    });
  });
});
