// Lock Holder Crash Recovery Tests (SPRINT 1 FIX)
import { jest, describe, test, expect } from '@jest/globals';
import { ExecutionEngineService } from '../../src/engine';
import { createMockLogger, createMockPerfLogger, createMockExecutionStateManager } from '@arbitrage/test-utils';

describe('Lock Holder Crash Recovery (SPRINT 1 FIX)', () => {
  test('should include staleLockRecoveries in stats', () => {
    const mockLogger = createMockLogger();
    const mockPerfLogger = createMockPerfLogger();
    const mockStateManager = createMockExecutionStateManager();

    const engine = new ExecutionEngineService({
      logger: mockLogger,
      perfLogger: mockPerfLogger as any,
      stateManager: mockStateManager as any
    });

    const stats = engine.getStats();

    // Verify staleLockRecoveries stat exists and is initialized to 0
    expect(stats.staleLockRecoveries).toBe(0);
    expect(stats.lockConflicts).toBe(0);
  });

  test('stats should have separate counters for lock conflicts and crash recovery', () => {
    const mockLogger = createMockLogger();
    const mockPerfLogger = createMockPerfLogger();
    const mockStateManager = createMockExecutionStateManager();

    const engine = new ExecutionEngineService({
      logger: mockLogger,
      perfLogger: mockPerfLogger as any,
      stateManager: mockStateManager as any
    });

    const stats = engine.getStats();

    // These should be independent counters (both initialized to 0)
    expect(typeof stats.lockConflicts).toBe('number');
    expect(typeof stats.staleLockRecoveries).toBe('number');

    // Verify they are separate properties in the stats object
    // lockConflicts tracks normal conflicts (another instance has the lock)
    // staleLockRecoveries tracks when we force-release a stale lock from crashed instance
    expect('lockConflicts' in stats).toBe(true);
    expect('staleLockRecoveries' in stats).toBe(true);

    // Both start at 0 - they only diverge when locks are actually contested
    expect(stats.lockConflicts).toBe(0);
    expect(stats.staleLockRecoveries).toBe(0);
  });

});
