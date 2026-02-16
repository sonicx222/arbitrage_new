/**
 * Unit tests for StandbyActivationManager
 *
 * Tests the Promise-based mutex pattern, validation checks,
 * successful/failed activation flows, and cleanup behavior.
 *
 * @see standby-activation-manager.ts
 * @see ADR-007: Failover Strategy
 */

import {
  StandbyActivationManager,
  StandbyActivationManagerDeps,
} from '../../src/standby-activation-manager';

export {};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockLeadershipElection() {
  return {
    setActivating: jest.fn(),
    tryAcquireLeadership: jest.fn().mockResolvedValue(true),
    clearStandby: jest.fn(),
  };
}

type MockLeadershipElection = ReturnType<typeof createMockLeadershipElection>;

function createMockLogger() {
  return {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  };
}

function createMockDeps(
  overrides: Partial<StandbyActivationManagerDeps> = {},
  leadershipElection: MockLeadershipElection | null = createMockLeadershipElection(),
): { deps: StandbyActivationManagerDeps; leadershipElection: MockLeadershipElection | null } {
  const deps: StandbyActivationManagerDeps = {
    logger: createMockLogger(),
    getLeadershipElection: jest.fn(() => leadershipElection) as StandbyActivationManagerDeps['getLeadershipElection'],
    getIsLeader: jest.fn(() => false),
    getIsStandby: jest.fn(() => true),
    getCanBecomeLeader: jest.fn(() => true),
    instanceId: 'test-instance',
    regionId: 'us-east-1',
    onActivationSuccess: jest.fn(),
    setIsActivating: jest.fn(),
    ...overrides,
  };
  return { deps, leadershipElection };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StandbyActivationManager', () => {
  let manager: StandbyActivationManager;
  let deps: StandbyActivationManagerDeps;
  let mockLeadership: MockLeadershipElection | null;

  beforeEach(() => {
    const created = createMockDeps();
    deps = created.deps;
    mockLeadership = created.leadershipElection;
    manager = new StandbyActivationManager(deps);
  });

  // =========================================================================
  // getIsActivating
  // =========================================================================

  describe('getIsActivating', () => {
    it('should return false initially', () => {
      expect(manager.getIsActivating()).toBe(false);
    });

    it('should return true while activation is in progress', async () => {
      // Use a deferred promise to hold the activation open
      let resolveAcquire!: (value: boolean) => void;
      mockLeadership!.tryAcquireLeadership.mockReturnValue(
        new Promise<boolean>((resolve) => {
          resolveAcquire = resolve;
        }),
      );

      const activationPromise = manager.activateStandby();

      // Activation is in progress, so getIsActivating should be true
      expect(manager.getIsActivating()).toBe(true);

      // Let the activation complete
      resolveAcquire(true);
      await activationPromise;

      expect(manager.getIsActivating()).toBe(false);
    });

    it('should return false after activation completes', async () => {
      await manager.activateStandby();
      expect(manager.getIsActivating()).toBe(false);
    });
  });

  // =========================================================================
  // activateStandby — pre-activation validation
  // =========================================================================

  describe('activateStandby', () => {
    describe('pre-activation validation', () => {
      it('should return true without acquiring leadership when already leader', async () => {
        (deps.getIsLeader as jest.Mock).mockReturnValue(true);

        const result = await manager.activateStandby();

        expect(result).toBe(true);
        expect(deps.logger.warn).toHaveBeenCalledWith(
          'Coordinator already leader, skipping activation',
        );
        // Should NOT call tryAcquireLeadership
        expect(mockLeadership!.tryAcquireLeadership).not.toHaveBeenCalled();
        // Should NOT set activating flags
        expect(mockLeadership!.setActivating).not.toHaveBeenCalled();
        expect(deps.setIsActivating).not.toHaveBeenCalled();
      });

      it('should return false when not in standby mode', async () => {
        (deps.getIsStandby as jest.Mock).mockReturnValue(false);

        const result = await manager.activateStandby();

        expect(result).toBe(false);
        expect(deps.logger.warn).toHaveBeenCalledWith(
          'activateStandby called on non-standby instance',
        );
        expect(mockLeadership!.tryAcquireLeadership).not.toHaveBeenCalled();
      });

      it('should return false when canBecomeLeader is false', async () => {
        (deps.getCanBecomeLeader as jest.Mock).mockReturnValue(false);

        const result = await manager.activateStandby();

        expect(result).toBe(false);
        expect(deps.logger.error).toHaveBeenCalledWith(
          'Cannot activate - canBecomeLeader is false',
        );
        expect(mockLeadership!.tryAcquireLeadership).not.toHaveBeenCalled();
      });
    });

    // =========================================================================
    // activateStandby — successful activation
    // =========================================================================

    describe('successful activation', () => {
      it('should return true when leadership is acquired', async () => {
        mockLeadership!.tryAcquireLeadership.mockResolvedValue(true);

        const result = await manager.activateStandby();

        expect(result).toBe(true);
      });

      it('should call onActivationSuccess when leadership is acquired', async () => {
        mockLeadership!.tryAcquireLeadership.mockResolvedValue(true);

        await manager.activateStandby();

        expect(deps.onActivationSuccess).toHaveBeenCalledTimes(1);
      });

      it('should call clearStandby on leadershipElection after acquisition', async () => {
        mockLeadership!.tryAcquireLeadership.mockResolvedValue(true);

        await manager.activateStandby();

        expect(mockLeadership!.clearStandby).toHaveBeenCalledTimes(1);
      });

      it('should set activating true before tryAcquireLeadership and false after', async () => {
        const callOrder: string[] = [];

        mockLeadership!.setActivating.mockImplementation((val: boolean) => {
          callOrder.push(`leadership.setActivating(${val})`);
        });
        (deps.setIsActivating as jest.Mock).mockImplementation((val: boolean) => {
          callOrder.push(`deps.setIsActivating(${val})`);
        });
        mockLeadership!.tryAcquireLeadership.mockImplementation(async () => {
          callOrder.push('tryAcquireLeadership');
          return true;
        });
        mockLeadership!.clearStandby.mockImplementation(() => {
          callOrder.push('clearStandby');
        });
        (deps.onActivationSuccess as jest.Mock).mockImplementation(() => {
          callOrder.push('onActivationSuccess');
        });

        await manager.activateStandby();

        expect(callOrder).toEqual([
          'leadership.setActivating(true)',
          'deps.setIsActivating(true)',
          'tryAcquireLeadership',
          'onActivationSuccess',
          'clearStandby',
          'leadership.setActivating(false)',
          'deps.setIsActivating(false)',
        ]);
      });

      it('should log activation with instanceId and regionId', async () => {
        mockLeadership!.tryAcquireLeadership.mockResolvedValue(true);

        await manager.activateStandby();

        expect(deps.logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('ACTIVATING STANDBY COORDINATOR'),
          expect.objectContaining({
            instanceId: 'test-instance',
            regionId: 'us-east-1',
          }),
        );
      });
    });

    // =========================================================================
    // activateStandby — failed activation
    // =========================================================================

    describe('failed activation', () => {
      it('should return false when tryAcquireLeadership returns false', async () => {
        mockLeadership!.tryAcquireLeadership.mockResolvedValue(false);

        const result = await manager.activateStandby();

        expect(result).toBe(false);
        expect(deps.onActivationSuccess).not.toHaveBeenCalled();
        expect(mockLeadership!.clearStandby).not.toHaveBeenCalled();
        expect(deps.logger.error).toHaveBeenCalledWith(
          'Failed to acquire leadership during activation',
        );
      });

      it('should return false when leadershipElection is null', async () => {
        const { deps: nullDeps } = createMockDeps({}, null);
        const nullManager = new StandbyActivationManager(nullDeps);

        const result = await nullManager.activateStandby();

        expect(result).toBe(false);
        expect(nullDeps.logger.error).toHaveBeenCalledWith(
          'LeadershipElectionService not initialized',
        );
      });

      it('should return false when tryAcquireLeadership throws', async () => {
        const testError = new Error('Redis connection lost');
        mockLeadership!.tryAcquireLeadership.mockRejectedValue(testError);

        const result = await manager.activateStandby();

        expect(result).toBe(false);
        expect(deps.logger.error).toHaveBeenCalledWith(
          'Error during standby activation',
          expect.objectContaining({ error: testError }),
        );
      });

      it('should call setActivating(false) in finally block even on error', async () => {
        mockLeadership!.tryAcquireLeadership.mockRejectedValue(new Error('boom'));

        await manager.activateStandby();

        // setActivating should have been called with true (start) and false (cleanup)
        expect(mockLeadership!.setActivating).toHaveBeenCalledWith(true);
        expect(mockLeadership!.setActivating).toHaveBeenCalledWith(false);
        expect(deps.setIsActivating).toHaveBeenCalledWith(true);
        expect(deps.setIsActivating).toHaveBeenCalledWith(false);
      });

      it('should call setActivating(false) in finally block on failed acquisition', async () => {
        mockLeadership!.tryAcquireLeadership.mockResolvedValue(false);

        await manager.activateStandby();

        expect(mockLeadership!.setActivating).toHaveBeenCalledWith(false);
        expect(deps.setIsActivating).toHaveBeenCalledWith(false);
      });
    });

    // =========================================================================
    // activateStandby — mutex behavior
    // =========================================================================

    describe('mutex behavior', () => {
      it('should only call tryAcquireLeadership once for concurrent calls', async () => {
        let resolveAcquire!: (value: boolean) => void;
        mockLeadership!.tryAcquireLeadership.mockReturnValue(
          new Promise<boolean>((resolve) => {
            resolveAcquire = resolve;
          }),
        );

        // Launch two concurrent activations
        const promise1 = manager.activateStandby();
        const promise2 = manager.activateStandby();

        // Second call should log the warning about already in progress
        expect(deps.logger.warn).toHaveBeenCalledWith(
          'Activation already in progress, waiting for result',
        );

        // Resolve the single acquire
        resolveAcquire(true);

        const [result1, result2] = await Promise.all([promise1, promise2]);

        // Both should get the same result
        expect(result1).toBe(true);
        expect(result2).toBe(true);

        // Only ONE call to tryAcquireLeadership
        expect(mockLeadership!.tryAcquireLeadership).toHaveBeenCalledTimes(1);
      });

      it('should clear mutex after successful completion', async () => {
        mockLeadership!.tryAcquireLeadership.mockResolvedValue(true);

        await manager.activateStandby();
        expect(manager.getIsActivating()).toBe(false);

        // Second call should start a new activation, not reuse
        mockLeadership!.tryAcquireLeadership.mockResolvedValue(false);
        const result = await manager.activateStandby();

        expect(result).toBe(false);
        expect(mockLeadership!.tryAcquireLeadership).toHaveBeenCalledTimes(2);
      });

      it('should clear mutex after error', async () => {
        mockLeadership!.tryAcquireLeadership.mockRejectedValue(new Error('fail'));

        const result1 = await manager.activateStandby();
        expect(result1).toBe(false);
        expect(manager.getIsActivating()).toBe(false);

        // Next activation should work independently
        mockLeadership!.tryAcquireLeadership.mockResolvedValue(true);
        const result2 = await manager.activateStandby();

        expect(result2).toBe(true);
        expect(mockLeadership!.tryAcquireLeadership).toHaveBeenCalledTimes(2);
      });

      it('should allow three concurrent callers to share the same activation result', async () => {
        let resolveAcquire!: (value: boolean) => void;
        mockLeadership!.tryAcquireLeadership.mockReturnValue(
          new Promise<boolean>((resolve) => {
            resolveAcquire = resolve;
          }),
        );

        const promise1 = manager.activateStandby();
        const promise2 = manager.activateStandby();
        const promise3 = manager.activateStandby();

        resolveAcquire(false);

        const [r1, r2, r3] = await Promise.all([promise1, promise2, promise3]);

        expect(r1).toBe(false);
        expect(r2).toBe(false);
        expect(r3).toBe(false);
        expect(mockLeadership!.tryAcquireLeadership).toHaveBeenCalledTimes(1);
      });
    });

    // =========================================================================
    // activateStandby — edge cases
    // =========================================================================

    describe('edge cases', () => {
      it('should work with undefined regionId', async () => {
        const { deps: undefinedRegionDeps, leadershipElection: le } = createMockDeps({
          regionId: undefined,
        });
        const noRegionManager = new StandbyActivationManager(undefinedRegionDeps);

        le!.tryAcquireLeadership.mockResolvedValue(true);

        const result = await noRegionManager.activateStandby();

        expect(result).toBe(true);
        expect(undefinedRegionDeps.logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('ACTIVATING STANDBY COORDINATOR'),
          expect.objectContaining({
            instanceId: 'test-instance',
            regionId: undefined,
          }),
        );
      });

      it('should pass current isLeader state as previousIsLeader in log', async () => {
        // getIsLeader returns false for the validation check (not already leader),
        // but the log captures the current value at time of doActivateStandby
        (deps.getIsLeader as jest.Mock).mockReturnValue(false);

        await manager.activateStandby();

        expect(deps.logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('ACTIVATING STANDBY COORDINATOR'),
          expect.objectContaining({
            previousIsLeader: false,
          }),
        );
      });
    });
  });
});
