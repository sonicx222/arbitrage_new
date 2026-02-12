// Queue Service Pause/Resume Tests (ADR-007)
import { jest, describe, test, expect } from '@jest/globals';
import { QueueServiceImpl } from '../../src/services/queue.service';
import { createMockLogger } from '@arbitrage/test-utils';

describe('QueueService Pause/Resume (ADR-007)', () => {
  /**
   * GIVEN: A QueueService in active state (processing opportunities)
   * WHEN: The queue is manually paused (e.g., during failover to standby mode)
   * THEN: New opportunities should be blocked from entering the queue
   *
   * **Business Value**: Prevents duplicate executions during multi-region failover.
   * When transitioning to standby, we must stop accepting new opportunities
   * while allowing in-flight executions to complete gracefully.
   *
   * **ADR-007**: Multi-region standby configuration requires queue pause capability.
   */
  test('should prevent new opportunity enqueuing when transitioning to standby mode', () => {
    // Given: Active queue service
    const mockLogger = createMockLogger();
    const queueService = new QueueServiceImpl({
      logger: mockLogger
    });
    expect(queueService.isPaused()).toBe(false);
    expect(queueService.isManuallyPaused()).toBe(false);

    // When: Manually pausing for standby transition
    queueService.pause();

    // Then: Queue is paused and no new enqueues accepted
    expect(queueService.isPaused()).toBe(true);
    expect(queueService.isManuallyPaused()).toBe(true);
    expect(mockLogger.info).toHaveBeenCalledWith('Queue manually paused (standby mode)');
  });

  test('should resume manually paused queue on activation', () => {
    const mockLogger = createMockLogger();
    const queueService = new QueueServiceImpl({
      logger: mockLogger
    });

    queueService.pause();
    expect(queueService.isPaused()).toBe(true);

    queueService.resume();

    expect(queueService.isPaused()).toBe(false);
    expect(queueService.isManuallyPaused()).toBe(false);
    expect(mockLogger.info).toHaveBeenCalledWith('Queue manually resumed (activated)');
  });

  test('should not enqueue when manually paused', () => {
    const mockLogger = createMockLogger();
    const queueService = new QueueServiceImpl({
      logger: mockLogger
    });

    queueService.pause();

    const result = queueService.canEnqueue();
    expect(result).toBe(false);
  });

  test('should allow enqueue after resume', () => {
    const mockLogger = createMockLogger();
    const queueService = new QueueServiceImpl({
      logger: mockLogger
    });

    queueService.pause();
    expect(queueService.canEnqueue()).toBe(false);

    queueService.resume();
    expect(queueService.canEnqueue()).toBe(true);
  });

  test('should notify callback on pause state change', () => {
    const mockLogger = createMockLogger();
    const mockCallback = jest.fn();
    const queueService = new QueueServiceImpl({
      logger: mockLogger
    });

    queueService.onPauseStateChange(mockCallback);

    queueService.pause();
    expect(mockCallback).toHaveBeenCalledWith(true);

    queueService.resume();
    expect(mockCallback).toHaveBeenCalledWith(false);
  });

  test('should not double-pause or double-resume', () => {
    const mockLogger = createMockLogger();
    const queueService = new QueueServiceImpl({
      logger: mockLogger
    });

    queueService.pause();
    const callCount = (mockLogger.info as jest.Mock).mock.calls.length;

    queueService.pause(); // Should not log again
    expect((mockLogger.info as jest.Mock).mock.calls.length).toBe(callCount);

    queueService.resume();
    const resumeCallCount = (mockLogger.info as jest.Mock).mock.calls.length;

    queueService.resume(); // Should not log again
    expect((mockLogger.info as jest.Mock).mock.calls.length).toBe(resumeCallCount);
  });

  test('clear should reset manual pause state', () => {
    const mockLogger = createMockLogger();
    const queueService = new QueueServiceImpl({
      logger: mockLogger
    });

    queueService.pause();
    expect(queueService.isManuallyPaused()).toBe(true);

    queueService.clear();
    expect(queueService.isManuallyPaused()).toBe(false);
    expect(queueService.isPaused()).toBe(false);
  });
});
