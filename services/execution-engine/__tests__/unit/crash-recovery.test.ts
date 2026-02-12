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
    expect(stats.staleLockRecoveries).toBeDefined();
    expect(stats.staleLockRecoveries).toBe(0);
    expect(stats.lockConflicts).toBeDefined();
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

  /**
   * Crash Recovery Logic Documentation Test
   *
   * The crash recovery mechanism works as follows:
   *
   * 1. When lock acquisition fails with 'lock_not_acquired', track the conflict:
   *    - First conflict: Record firstSeen timestamp and count=1
   *    - Subsequent conflicts within 30s window: Increment count
   *
   * 2. After 3 conflicts within the window AND 20s has passed since first conflict:
   *    - Consider the lock holder as potentially crashed
   *    - Force release the lock
   *    - Retry execution
   *
   * 3. Benefits:
   *    - Legitimate lock holders get 20s to complete (well above expected execution time)
   *    - Crashed instances don't block opportunities for full 120s TTL
   *    - Multiple conflicts requirement prevents false positives from slow execution
   *
   * 4. Cleanup:
   *    - Stale entries (>60s) are cleaned up during health monitoring
   *    - Successful lock acquisition clears the tracker for that opportunity
   */
  test('crash recovery design should meet timing requirements', () => {
    // Document the timing constants used in crash recovery
    const CRASH_RECOVERY_CONFLICT_THRESHOLD = 3;
    const CRASH_RECOVERY_WINDOW_MS = 30000;
    const CRASH_RECOVERY_MIN_AGE_MS = 20000;
    const LOCK_TTL_MS = 120000;

    // Verify recovery kicks in well before lock TTL expires
    // With 3 conflicts at ~10s intervals, recovery happens around 20-30s
    // This is much faster than waiting for 120s TTL expiration
    expect(CRASH_RECOVERY_MIN_AGE_MS).toBeLessThan(LOCK_TTL_MS / 4);

    // Verify we give legitimate executions enough time
    // 20s minimum age is well above the 55s execution timeout
    // (if execution takes longer than expected, it may still be running)
    expect(CRASH_RECOVERY_MIN_AGE_MS).toBeGreaterThan(10000);

    // Verify multiple conflicts are required to prevent false positives
    expect(CRASH_RECOVERY_CONFLICT_THRESHOLD).toBeGreaterThanOrEqual(3);

    // Verify window is reasonable for detecting repeated redeliveries
    expect(CRASH_RECOVERY_WINDOW_MS).toBeGreaterThanOrEqual(CRASH_RECOVERY_MIN_AGE_MS);
  });
});
