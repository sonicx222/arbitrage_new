/**
 * BridgeRecoveryManager Unit Tests
 *
 * Tests bridge recovery lifecycle, status checking, metrics tracking,
 * and edge cases (empty state, abandoned bridges, transient errors).
 *
 * @see services/execution-engine/src/services/bridge-recovery-manager.ts
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  BridgeRecoveryManager,
  createBridgeRecoveryManager,
  type BridgeRecoveryManagerDeps,
  type BridgeRecoveryManagerConfig,
} from '../../../src/services/bridge-recovery-manager';
import type { BridgeRecoveryState } from '../../../src/types';
import {
  BRIDGE_RECOVERY_KEY_PREFIX,
  BRIDGE_RECOVERY_MAX_AGE_MS,
} from '../../../src/types';

// =============================================================================
// Mock Factories
// =============================================================================

function createMockLogger() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

function createMockRedis() {
  return {
    get: jest.fn<any>().mockResolvedValue(null),
    set: jest.fn<any>().mockResolvedValue(undefined),
    del: jest.fn<any>().mockResolvedValue(1),
    scan: jest.fn<any>().mockResolvedValue(['0', []]),
  };
}

function createMockBridgeRouter() {
  return {
    protocol: 'stargate' as const,
    supportedSourceChains: ['ethereum'],
    supportedDestChains: ['arbitrum'],
    quote: jest.fn<any>(),
    execute: jest.fn<any>(),
    getStatus: jest.fn<any>().mockResolvedValue({
      status: 'pending',
      sourceTxHash: '0xsource123',
      lastUpdated: Date.now(),
    }),
    isRouteSupported: jest.fn<any>().mockReturnValue(true),
    getEstimatedTime: jest.fn<any>().mockReturnValue(180),
    healthCheck: jest.fn<any>().mockResolvedValue({ healthy: true, message: 'OK' }),
    dispose: jest.fn(),
  };
}

function createMockBridgeRouterFactory(router?: ReturnType<typeof createMockBridgeRouter>) {
  const mockRouter = router ?? createMockBridgeRouter();
  return {
    findSupportedRouter: jest.fn<any>().mockReturnValue(mockRouter),
    getRouter: jest.fn<any>().mockReturnValue(mockRouter),
    getDefaultRouter: jest.fn<any>().mockReturnValue(mockRouter),
    healthCheckAll: jest.fn<any>(),
    dispose: jest.fn<any>(),
  };
}

function createBridgeRecoveryState(overrides?: Partial<BridgeRecoveryState>): BridgeRecoveryState {
  return {
    opportunityId: 'opp-123',
    bridgeId: 'bridge-456',
    sourceTxHash: '0xsource789',
    sourceChain: 'ethereum',
    destChain: 'arbitrum',
    bridgeToken: 'USDC',
    bridgeAmount: '1000000000', // 1000 USDC (6 decimals)
    sellDex: 'uniswap-v3',
    expectedProfit: 50,
    tokenIn: 'WETH',
    tokenOut: 'USDC',
    initiatedAt: Date.now() - 60000, // 1 minute ago
    bridgeProtocol: 'stargate',
    status: 'pending',
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('BridgeRecoveryManager', () => {
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockRedis: ReturnType<typeof createMockRedis>;
  let mockBridgeRouter: ReturnType<typeof createMockBridgeRouter>;
  let mockBridgeRouterFactory: ReturnType<typeof createMockBridgeRouterFactory>;
  let manager: BridgeRecoveryManager;

  beforeEach(() => {
    jest.useFakeTimers();
    mockLogger = createMockLogger();
    mockRedis = createMockRedis();
    mockBridgeRouter = createMockBridgeRouter();
    mockBridgeRouterFactory = createMockBridgeRouterFactory(mockBridgeRouter);
  });

  afterEach(async () => {
    if (manager) {
      await manager.stop();
    }
    jest.useRealTimers();
  });

  function createManager(configOverrides?: Partial<BridgeRecoveryManagerConfig>) {
    const deps: BridgeRecoveryManagerDeps = {
      logger: mockLogger as any,
      redis: mockRedis as any,
      bridgeRouterFactory: mockBridgeRouterFactory as any,
      config: {
        checkIntervalMs: 60000,
        enabled: true,
        ...configOverrides,
      },
    };
    manager = new BridgeRecoveryManager(deps);
    return manager;
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  describe('start()', () => {
    it('should start and run initial recovery scan', async () => {
      createManager();

      const count = await manager.start();

      expect(count).toBe(0);
      expect(manager.getIsRunning()).toBe(true);
      expect(mockRedis.scan).toHaveBeenCalledWith(
        '0',
        'MATCH',
        `${BRIDGE_RECOVERY_KEY_PREFIX}*`,
        'COUNT',
        100
      );
    });

    it('should find pending bridges on startup', async () => {
      const state = createBridgeRecoveryState();
      mockRedis.scan.mockResolvedValueOnce(['0', [`${BRIDGE_RECOVERY_KEY_PREFIX}bridge-456`]]);
      mockRedis.get.mockResolvedValueOnce(state);
      mockBridgeRouter.getStatus.mockResolvedValueOnce({
        status: 'pending',
        sourceTxHash: '0xsource789',
        lastUpdated: Date.now(),
      });

      createManager();
      const count = await manager.start();

      expect(count).toBe(1);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Found bridge recovery states',
        expect.objectContaining({ count: 1 })
      );
    });

    it('should not start if disabled', async () => {
      createManager({ enabled: false });

      const count = await manager.start();

      expect(count).toBe(0);
      expect(manager.getIsRunning()).toBe(false);
      expect(mockRedis.scan).not.toHaveBeenCalled();
    });

    it('should not start twice', async () => {
      createManager();

      await manager.start();
      const secondCount = await manager.start();

      expect(secondCount).toBe(0);
      expect(mockLogger.warn).toHaveBeenCalledWith('Bridge recovery manager already running');
    });

    it('should start periodic check interval', async () => {
      jest.useRealTimers();

      createManager({ checkIntervalMs: 50 });

      await manager.start();

      // Reset scan mock to track interval call
      mockRedis.scan.mockClear();
      mockRedis.scan.mockResolvedValue(['0', []]);

      // Wait for the interval to fire (50ms + margin)
      await new Promise((resolve) => setTimeout(resolve, 120));

      expect(mockRedis.scan).toHaveBeenCalled();

      // Re-enable fake timers for afterEach
      jest.useFakeTimers();
    });
  });

  describe('stop()', () => {
    it('should stop the manager and clear interval', async () => {
      createManager();
      await manager.start();

      expect(manager.getIsRunning()).toBe(true);

      await manager.stop();

      expect(manager.getIsRunning()).toBe(false);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Bridge recovery manager stopped',
        expect.objectContaining({ metrics: expect.any(Object) })
      );
    });

    it('should be idempotent (no-op if already stopped)', async () => {
      createManager();

      await manager.stop();
      await manager.stop();

      // Should not throw or produce extra logs
    });

    it('should stop periodic checks after stop', async () => {
      createManager({ checkIntervalMs: 10000 });
      await manager.start();
      await manager.stop();

      mockRedis.scan.mockClear();

      jest.advanceTimersByTime(20000);
      await jest.runAllTimersAsync();

      // scan should not be called after stop
      expect(mockRedis.scan).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Recovery Logic
  // ===========================================================================

  describe('recoverPendingBridges()', () => {
    it('should return 0 when no bridges found', async () => {
      createManager();
      await manager.start();

      const count = await manager.recoverPendingBridges();

      expect(count).toBe(0);
      expect(manager.getMetrics().pendingBridges).toBe(0);
    });

    it('should skip already recovered/failed bridges', async () => {
      const recoveredState = createBridgeRecoveryState({ status: 'recovered', bridgeId: 'bridge-1' });
      const failedState = createBridgeRecoveryState({ status: 'failed', bridgeId: 'bridge-2' });

      mockRedis.scan.mockResolvedValueOnce(['0', [
        `${BRIDGE_RECOVERY_KEY_PREFIX}bridge-1`,
        `${BRIDGE_RECOVERY_KEY_PREFIX}bridge-2`,
      ]]);
      mockRedis.get
        .mockResolvedValueOnce(recoveredState)
        .mockResolvedValueOnce(failedState);

      createManager();

      const count = await manager.recoverPendingBridges();

      // Found 2 states but neither is actionable
      expect(count).toBe(2);
      expect(manager.getMetrics().pendingBridges).toBe(0);
      // Should NOT call getStatus since these are terminal states
      expect(mockBridgeRouter.getStatus).not.toHaveBeenCalled();
    });

    it('should mark abandoned bridges that exceed maxAgeMs', async () => {
      const oldState = createBridgeRecoveryState({
        bridgeId: 'old-bridge',
        initiatedAt: Date.now() - (25 * 60 * 60 * 1000), // 25 hours ago
      });

      mockRedis.scan.mockResolvedValueOnce(['0', [`${BRIDGE_RECOVERY_KEY_PREFIX}old-bridge`]]);
      mockRedis.get
        .mockResolvedValueOnce(oldState)   // First call: scanBridgeRecoveryStates
        .mockResolvedValueOnce(oldState);  // Second call: updateRecoveryStatus

      createManager();

      await manager.recoverPendingBridges();

      expect(manager.getMetrics().abandonedBridges).toBe(1);
      expect(mockRedis.set).toHaveBeenCalledWith(
        `${BRIDGE_RECOVERY_KEY_PREFIX}old-bridge`,
        expect.objectContaining({
          status: 'failed',
          errorMessage: 'Bridge abandoned: exceeded max age',
        }),
        3600 // 1 hour TTL for terminal states
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Bridge recovery state expired, marking as abandoned',
        expect.objectContaining({ bridgeId: 'old-bridge' })
      );
    });

    it('should check bridge status for pending bridges', async () => {
      const state = createBridgeRecoveryState({ status: 'pending' });

      mockRedis.scan.mockResolvedValueOnce(['0', [`${BRIDGE_RECOVERY_KEY_PREFIX}bridge-456`]]);
      mockRedis.get.mockResolvedValueOnce(state);
      mockBridgeRouter.getStatus.mockResolvedValueOnce({
        status: 'pending',
        sourceTxHash: '0xsource789',
        lastUpdated: Date.now(),
      });

      createManager();

      await manager.recoverPendingBridges();

      expect(mockBridgeRouter.getStatus).toHaveBeenCalledWith('bridge-456');
    });

    it('should mark bridge as recovered when completed', async () => {
      const state = createBridgeRecoveryState({ status: 'bridging' });

      mockRedis.scan.mockResolvedValueOnce(['0', [`${BRIDGE_RECOVERY_KEY_PREFIX}bridge-456`]]);
      mockRedis.get
        .mockResolvedValueOnce(state)   // scanBridgeRecoveryStates
        .mockResolvedValueOnce(state);  // updateRecoveryStatus
      mockBridgeRouter.getStatus.mockResolvedValueOnce({
        status: 'completed',
        sourceTxHash: '0xsource789',
        destTxHash: '0xdest999',
        amountReceived: '999000000',
        lastUpdated: Date.now(),
      });

      createManager();

      await manager.recoverPendingBridges();

      expect(manager.getMetrics().recoveredBridges).toBe(1);
      expect(mockRedis.set).toHaveBeenCalledWith(
        `${BRIDGE_RECOVERY_KEY_PREFIX}bridge-456`,
        expect.objectContaining({ status: 'recovered' }),
        3600
      );
    });

    it('should mark bridge as failed when bridge status is failed', async () => {
      const state = createBridgeRecoveryState({ status: 'pending' });

      mockRedis.scan.mockResolvedValueOnce(['0', [`${BRIDGE_RECOVERY_KEY_PREFIX}bridge-456`]]);
      mockRedis.get
        .mockResolvedValueOnce(state)
        .mockResolvedValueOnce(state);
      mockBridgeRouter.getStatus.mockResolvedValueOnce({
        status: 'failed',
        sourceTxHash: '0xsource789',
        error: 'Bridge reverted',
        lastUpdated: Date.now(),
      });

      createManager();

      await manager.recoverPendingBridges();

      expect(manager.getMetrics().failedRecoveries).toBe(1);
      expect(mockRedis.set).toHaveBeenCalledWith(
        `${BRIDGE_RECOVERY_KEY_PREFIX}bridge-456`,
        expect.objectContaining({
          status: 'failed',
          errorMessage: 'Bridge reverted',
        }),
        3600
      );
    });

    it('should mark bridge as failed when refunded', async () => {
      const state = createBridgeRecoveryState({ status: 'pending' });

      mockRedis.scan.mockResolvedValueOnce(['0', [`${BRIDGE_RECOVERY_KEY_PREFIX}bridge-456`]]);
      mockRedis.get
        .mockResolvedValueOnce(state)
        .mockResolvedValueOnce(state);
      mockBridgeRouter.getStatus.mockResolvedValueOnce({
        status: 'refunded',
        sourceTxHash: '0xsource789',
        lastUpdated: Date.now(),
      });

      createManager();

      await manager.recoverPendingBridges();

      expect(manager.getMetrics().failedRecoveries).toBe(1);
      expect(mockRedis.set).toHaveBeenCalledWith(
        `${BRIDGE_RECOVERY_KEY_PREFIX}bridge-456`,
        expect.objectContaining({
          status: 'failed',
          errorMessage: 'Bridge refunded to source',
        }),
        3600
      );
    });

    it('should update lastCheckAt for still-pending bridges', async () => {
      const state = createBridgeRecoveryState({ status: 'pending' });

      mockRedis.scan.mockResolvedValueOnce(['0', [`${BRIDGE_RECOVERY_KEY_PREFIX}bridge-456`]]);
      mockRedis.get
        .mockResolvedValueOnce(state)
        .mockResolvedValueOnce(state);
      mockBridgeRouter.getStatus.mockResolvedValueOnce({
        status: 'bridging',
        sourceTxHash: '0xsource789',
        lastUpdated: Date.now(),
      });

      createManager();

      await manager.recoverPendingBridges();

      // Should update to 'bridging' status
      expect(mockRedis.set).toHaveBeenCalledWith(
        `${BRIDGE_RECOVERY_KEY_PREFIX}bridge-456`,
        expect.objectContaining({
          status: 'bridging',
          lastCheckAt: expect.any(Number),
        }),
        expect.any(Number)
      );
    });

    it('should handle transient getStatus errors gracefully', async () => {
      const state = createBridgeRecoveryState({ status: 'pending' });

      mockRedis.scan.mockResolvedValueOnce(['0', [`${BRIDGE_RECOVERY_KEY_PREFIX}bridge-456`]]);
      mockRedis.get.mockResolvedValueOnce(state);
      mockBridgeRouter.getStatus.mockRejectedValueOnce(new Error('Network timeout'));

      createManager();

      await manager.recoverPendingBridges();

      // Should log warning but NOT mark as failed
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Bridge status check failed during recovery',
        expect.objectContaining({
          bridgeId: 'bridge-456',
          error: 'Network timeout',
        })
      );
      expect(manager.getMetrics().failedRecoveries).toBe(0);
    });

    it('should handle no router available gracefully', async () => {
      const state = createBridgeRecoveryState({ status: 'pending' });

      mockRedis.scan.mockResolvedValueOnce(['0', [`${BRIDGE_RECOVERY_KEY_PREFIX}bridge-456`]]);
      mockRedis.get.mockResolvedValueOnce(state);
      mockBridgeRouterFactory.findSupportedRouter.mockReturnValueOnce(null);

      createManager();

      await manager.recoverPendingBridges();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'No bridge router available for recovery check',
        expect.objectContaining({ bridgeId: 'bridge-456' })
      );
      // Should NOT mark as failed - router may become available later
      expect(manager.getMetrics().failedRecoveries).toBe(0);
    });

    it('should guard against concurrent recovery checks', async () => {
      const state = createBridgeRecoveryState({ status: 'pending' });

      // Make scan return slowly
      let scanResolve: (value: any) => void;
      const scanPromise = new Promise((resolve) => { scanResolve = resolve; });
      mockRedis.scan.mockReturnValueOnce(scanPromise);

      createManager();

      // Start first check
      const check1 = manager.recoverPendingBridges();

      // Start second check immediately (should be skipped)
      mockRedis.scan.mockResolvedValueOnce(['0', []]);
      const check2Result = await manager.recoverPendingBridges();
      expect(check2Result).toBe(0);

      // Resolve first check
      scanResolve!(['0', []]);
      await check1;
    });
  });

  // ===========================================================================
  // Redis SCAN pattern
  // ===========================================================================

  describe('Redis SCAN pattern', () => {
    it('should handle multi-page scan results', async () => {
      const state1 = createBridgeRecoveryState({ bridgeId: 'bridge-1', status: 'pending' });
      const state2 = createBridgeRecoveryState({ bridgeId: 'bridge-2', status: 'bridging' });

      // First scan returns cursor '42' (more results) with one key
      mockRedis.scan
        .mockResolvedValueOnce(['42', [`${BRIDGE_RECOVERY_KEY_PREFIX}bridge-1`]])
        .mockResolvedValueOnce(['0', [`${BRIDGE_RECOVERY_KEY_PREFIX}bridge-2`]]);

      mockRedis.get
        .mockResolvedValueOnce(state1) // scan page 1
        .mockResolvedValueOnce(state2) // scan page 2
        .mockResolvedValueOnce(state1) // updateRecoveryStatus for bridge-1
        .mockResolvedValueOnce(state2); // updateRecoveryStatus for bridge-2

      mockBridgeRouter.getStatus
        .mockResolvedValueOnce({ status: 'pending', sourceTxHash: '0x1', lastUpdated: Date.now() })
        .mockResolvedValueOnce({ status: 'pending', sourceTxHash: '0x2', lastUpdated: Date.now() });

      createManager();

      const count = await manager.recoverPendingBridges();

      expect(count).toBe(2);
      expect(mockRedis.scan).toHaveBeenCalledTimes(2);
      // First call with cursor '0'
      expect(mockRedis.scan).toHaveBeenNthCalledWith(1, '0', 'MATCH', `${BRIDGE_RECOVERY_KEY_PREFIX}*`, 'COUNT', 100);
      // Second call with cursor '42'
      expect(mockRedis.scan).toHaveBeenNthCalledWith(2, '42', 'MATCH', `${BRIDGE_RECOVERY_KEY_PREFIX}*`, 'COUNT', 100);
    });

    it('should handle corrupt Redis entries by cleaning them up', async () => {
      mockRedis.scan.mockResolvedValueOnce(['0', [`${BRIDGE_RECOVERY_KEY_PREFIX}corrupt`]]);
      // get returns null (corrupt or expired)
      mockRedis.get.mockResolvedValueOnce(null);

      createManager();

      const count = await manager.recoverPendingBridges();

      expect(count).toBe(0);
    });

    it('should clean up entries that throw on get', async () => {
      mockRedis.scan.mockResolvedValueOnce(['0', [`${BRIDGE_RECOVERY_KEY_PREFIX}bad-key`]]);
      mockRedis.get.mockRejectedValueOnce(new Error('Redis parse error'));

      createManager();

      const count = await manager.recoverPendingBridges();

      expect(count).toBe(0);
      expect(mockRedis.del).toHaveBeenCalledWith(`${BRIDGE_RECOVERY_KEY_PREFIX}bad-key`);
    });
  });

  // ===========================================================================
  // Sell Recovery
  // ===========================================================================

  describe('attemptSellRecovery()', () => {
    it('should return true when bridge is completed', async () => {
      const state = createBridgeRecoveryState({ status: 'bridging' });
      mockBridgeRouter.getStatus.mockResolvedValueOnce({
        status: 'completed',
        sourceTxHash: '0xsource789',
        destTxHash: '0xdest999',
        amountReceived: '999000000',
        lastUpdated: Date.now(),
      });

      createManager();

      const result = await manager.attemptSellRecovery(state);

      expect(result).toBe(true);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Bridge completed, sell recovery needed',
        expect.objectContaining({ bridgeId: 'bridge-456' })
      );
    });

    it('should return false when bridge is not yet completed', async () => {
      const state = createBridgeRecoveryState({ status: 'bridging' });
      mockBridgeRouter.getStatus.mockResolvedValueOnce({
        status: 'bridging',
        sourceTxHash: '0xsource789',
        lastUpdated: Date.now(),
      });

      createManager();

      const result = await manager.attemptSellRecovery(state);

      expect(result).toBe(false);
    });

    it('should return false when no router available', async () => {
      const state = createBridgeRecoveryState();
      mockBridgeRouterFactory.findSupportedRouter.mockReturnValueOnce(null);

      createManager();

      const result = await manager.attemptSellRecovery(state);

      expect(result).toBe(false);
      expect(manager.getMetrics().failedRecoveries).toBe(1);
    });

    it('should return false on getStatus error', async () => {
      const state = createBridgeRecoveryState();
      mockBridgeRouter.getStatus.mockRejectedValueOnce(new Error('API error'));

      createManager();

      const result = await manager.attemptSellRecovery(state);

      expect(result).toBe(false);
      expect(manager.getMetrics().failedRecoveries).toBe(1);
    });
  });

  // ===========================================================================
  // Metrics
  // ===========================================================================

  describe('getMetrics()', () => {
    it('should return initial metrics', () => {
      createManager();

      const metrics = manager.getMetrics();

      expect(metrics).toEqual({
        pendingBridges: 0,
        recoveredBridges: 0,
        failedRecoveries: 0,
        abandonedBridges: 0,
        lastCheckAt: 0,
        isChecking: false,
      });
    });

    it('should track metrics across multiple recovery cycles', async () => {
      // First cycle: 1 completed bridge
      const completedState = createBridgeRecoveryState({ bridgeId: 'bridge-1', status: 'pending' });
      mockRedis.scan.mockResolvedValueOnce(['0', [`${BRIDGE_RECOVERY_KEY_PREFIX}bridge-1`]]);
      mockRedis.get
        .mockResolvedValueOnce(completedState)
        .mockResolvedValueOnce(completedState);
      mockBridgeRouter.getStatus.mockResolvedValueOnce({
        status: 'completed',
        sourceTxHash: '0x1',
        amountReceived: '1000',
        lastUpdated: Date.now(),
      });

      createManager();
      await manager.recoverPendingBridges();

      // Second cycle: 1 failed bridge
      const failedState = createBridgeRecoveryState({ bridgeId: 'bridge-2', status: 'pending' });
      mockRedis.scan.mockResolvedValueOnce(['0', [`${BRIDGE_RECOVERY_KEY_PREFIX}bridge-2`]]);
      mockRedis.get
        .mockResolvedValueOnce(failedState)
        .mockResolvedValueOnce(failedState);
      mockBridgeRouter.getStatus.mockResolvedValueOnce({
        status: 'failed',
        sourceTxHash: '0x2',
        error: 'Reverted',
        lastUpdated: Date.now(),
      });

      await manager.recoverPendingBridges();

      const metrics = manager.getMetrics();
      expect(metrics.recoveredBridges).toBe(1);
      expect(metrics.failedRecoveries).toBe(1);
      expect(metrics.lastCheckAt).toBeGreaterThan(0);
    });

    it('should return a snapshot (not a mutable reference)', () => {
      createManager();

      const metrics1 = manager.getMetrics();
      (metrics1 as any).recoveredBridges = 999;

      const metrics2 = manager.getMetrics();
      expect(metrics2.recoveredBridges).toBe(0);
    });
  });

  // ===========================================================================
  // Concurrency Limit
  // ===========================================================================

  describe('maxConcurrentRecoveries', () => {
    it('should process bridges in batches respecting concurrency limit', async () => {
      const states = Array.from({ length: 5 }, (_, i) =>
        createBridgeRecoveryState({ bridgeId: `bridge-${i}`, status: 'pending' })
      );

      const keys = states.map((s) => `${BRIDGE_RECOVERY_KEY_PREFIX}${s.bridgeId}`);
      mockRedis.scan.mockResolvedValueOnce(['0', keys]);

      // Return states for scan
      for (const state of states) {
        mockRedis.get.mockResolvedValueOnce(state);
      }

      // Return status for each bridge check + update calls
      for (const state of states) {
        mockBridgeRouter.getStatus.mockResolvedValueOnce({
          status: 'pending',
          sourceTxHash: state.sourceTxHash,
          lastUpdated: Date.now(),
        });
        mockRedis.get.mockResolvedValueOnce(state); // for updateRecoveryStatus
      }

      createManager({ maxConcurrentRecoveries: 2 });

      await manager.recoverPendingBridges();

      // All 5 should be processed (in batches of 2)
      expect(mockBridgeRouter.getStatus).toHaveBeenCalledTimes(5);
    });
  });

  // ===========================================================================
  // Factory Function
  // ===========================================================================

  describe('createBridgeRecoveryManager()', () => {
    it('should create an instance with provided deps', () => {
      const instance = createBridgeRecoveryManager({
        logger: mockLogger as any,
        redis: mockRedis as any,
        bridgeRouterFactory: mockBridgeRouterFactory as any,
      });

      expect(instance).toBeInstanceOf(BridgeRecoveryManager);
      expect(instance.getIsRunning()).toBe(false);
    });

    it('should respect config overrides', async () => {
      const instance = createBridgeRecoveryManager({
        logger: mockLogger as any,
        redis: mockRedis as any,
        bridgeRouterFactory: mockBridgeRouterFactory as any,
        config: { enabled: false },
      });

      const count = await instance.start();
      expect(count).toBe(0);
      expect(instance.getIsRunning()).toBe(false);
    });
  });

  // ===========================================================================
  // checkBridgeStatus (public API)
  // ===========================================================================

  describe('checkBridgeStatus()', () => {
    it('should check and process a single bridge state', async () => {
      const state = createBridgeRecoveryState({ status: 'pending' });
      mockBridgeRouter.getStatus.mockResolvedValueOnce({
        status: 'completed',
        sourceTxHash: '0xsource789',
        amountReceived: '999000000',
        lastUpdated: Date.now(),
      });
      mockRedis.get.mockResolvedValueOnce(state); // for updateRecoveryStatus

      createManager();

      await manager.checkBridgeStatus(state);

      expect(mockBridgeRouter.getStatus).toHaveBeenCalledWith('bridge-456');
      expect(manager.getMetrics().recoveredBridges).toBe(1);
    });
  });

  // ===========================================================================
  // Edge cases
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle Redis scan returning empty on error', async () => {
      mockRedis.scan.mockResolvedValueOnce(['0', []]);

      createManager();

      const count = await manager.recoverPendingBridges();

      expect(count).toBe(0);
    });

    it('should handle updateRecoveryStatus when key already expired', async () => {
      const state = createBridgeRecoveryState({ status: 'pending' });

      mockRedis.scan.mockResolvedValueOnce(['0', [`${BRIDGE_RECOVERY_KEY_PREFIX}bridge-456`]]);
      mockRedis.get
        .mockResolvedValueOnce(state)  // scan
        .mockResolvedValueOnce(null);  // updateRecoveryStatus - key already expired
      mockBridgeRouter.getStatus.mockResolvedValueOnce({
        status: 'completed',
        sourceTxHash: '0x1',
        amountReceived: '1000',
        lastUpdated: Date.now(),
      });

      createManager();

      // Should not throw
      await manager.recoverPendingBridges();

      // set should NOT be called since key was expired
      expect(mockRedis.set).not.toHaveBeenCalled();
    });

    it('should handle updateRecoveryStatus Redis write failure', async () => {
      const state = createBridgeRecoveryState({ status: 'pending' });

      mockRedis.scan.mockResolvedValueOnce(['0', [`${BRIDGE_RECOVERY_KEY_PREFIX}bridge-456`]]);
      mockRedis.get
        .mockResolvedValueOnce(state)  // scan
        .mockResolvedValueOnce(state); // updateRecoveryStatus
      mockRedis.set.mockRejectedValueOnce(new Error('Redis write error'));
      mockBridgeRouter.getStatus.mockResolvedValueOnce({
        status: 'completed',
        sourceTxHash: '0x1',
        amountReceived: '1000',
        lastUpdated: Date.now(),
      });

      createManager();

      // Should not throw, just log warning
      await manager.recoverPendingBridges();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to update bridge recovery status',
        expect.objectContaining({ bridgeId: 'bridge-456' })
      );
    });

    it('should handle custom maxAgeMs configuration', async () => {
      const oneHourMs = 60 * 60 * 1000;
      const state = createBridgeRecoveryState({
        bridgeId: 'recent-bridge',
        initiatedAt: Date.now() - (2 * oneHourMs), // 2 hours ago
        status: 'pending',
      });

      mockRedis.scan.mockResolvedValueOnce(['0', [`${BRIDGE_RECOVERY_KEY_PREFIX}recent-bridge`]]);
      mockRedis.get
        .mockResolvedValueOnce(state)
        .mockResolvedValueOnce(state);

      // With 1-hour maxAge, this bridge should be abandoned
      createManager({ maxAgeMs: oneHourMs });

      await manager.recoverPendingBridges();

      expect(manager.getMetrics().abandonedBridges).toBe(1);
    });
  });
});
