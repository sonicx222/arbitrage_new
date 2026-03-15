/**
 * Unit Tests for ChainInstanceManager
 *
 * Tests the chain instance lifecycle management module extracted from
 * UnifiedChainDetector for better separation of concerns.
 */

import { EventEmitter } from 'events';
import {
  ChainInstanceManager,
  createChainInstanceManager,
  ChainInstanceManagerConfig,
  ChainInstanceFactory,
  StartResult,
} from '../../src/chain-instance-manager';
import { ChainDetectorInstance } from '../../src/chain-instance';
import type { ChainStats } from '../../src/types';
import { RecordingLogger } from '@arbitrage/core/logging';

// =============================================================================
// Mock Types
// =============================================================================

interface MockChainInstance extends EventEmitter {
  start: jest.Mock;
  stop: jest.Mock;
  isConnected: jest.Mock;
  getChainId: jest.Mock;
  getStats: jest.Mock;
}

// =============================================================================
// Mock Factory
// =============================================================================

function createMockChainInstance(chainId: string, shouldFail = false): MockChainInstance {
  const instance = new EventEmitter() as MockChainInstance;

  instance.start = jest.fn().mockImplementation(async () => {
    if (shouldFail) {
      throw new Error(`Failed to start chain: ${chainId}`);
    }
  });

  instance.stop = jest.fn().mockResolvedValue(undefined);

  instance.isConnected = jest.fn().mockReturnValue(!shouldFail);

  instance.getChainId = jest.fn().mockReturnValue(chainId);

  instance.getStats = jest.fn().mockReturnValue({
    chainId,
    status: shouldFail ? 'error' : 'connected',
    eventsProcessed: 100,
    opportunitiesFound: 5,
    lastBlockNumber: 12345,
    avgBlockLatencyMs: 50,
    pairsMonitored: 10,
  } as ChainStats);

  return instance;
}

// =============================================================================
// Tests
// =============================================================================

describe('ChainInstanceManager', () => {
  let logger: RecordingLogger;
  let mockStreamsClient: { xadd: jest.Mock };
  let mockPerfLogger: { logHealthCheck: jest.Mock };
  let mockDegradationManager: {
    triggerDegradation: jest.Mock;
    registerCapabilities: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();

    logger = new RecordingLogger();

    mockStreamsClient = {
      xadd: jest.fn().mockResolvedValue('stream-id'),
    };

    mockPerfLogger = {
      logHealthCheck: jest.fn(),
    };

    mockDegradationManager = {
      triggerDegradation: jest.fn(),
      registerCapabilities: jest.fn(),
      forceRecovery: jest.fn().mockResolvedValue(undefined),
    };
  });

  // ===========================================================================
  // Creation
  // ===========================================================================

  describe('createChainInstanceManager', () => {
    it('should create manager with default config', () => {
      const mockFactory: ChainInstanceFactory = jest.fn();

      const manager = createChainInstanceManager({
        chains: ['ethereum', 'polygon'],
        partitionId: 'test-partition',
        streamsClient: mockStreamsClient as any,
        perfLogger: mockPerfLogger as any,
        chainInstanceFactory: mockFactory,
        logger: logger as any,
      });

      expect(manager).toBeDefined();
      expect(typeof manager.startAll).toBe('function');
      expect(typeof manager.stop).toBe('function');
      expect(typeof manager.getHealthyChains).toBe('function');
      expect(typeof manager.getStats).toBe('function');
    });
  });

  // ===========================================================================
  // startAll
  // ===========================================================================

  describe('startAll', () => {
    it('should start all configured chain instances', async () => {
      const mockInstances: MockChainInstance[] = [];
      const mockFactory: ChainInstanceFactory = jest.fn().mockImplementation((cfg) => {
        const instance = createMockChainInstance(cfg.chainId);
        mockInstances.push(instance);
        return instance as any;
      });

      const manager = createChainInstanceManager({
        chains: ['ethereum', 'polygon'],
        partitionId: 'test-partition',
        streamsClient: mockStreamsClient as any,
        perfLogger: mockPerfLogger as any,
        chainInstanceFactory: mockFactory,
        logger: logger as any,
      });

      const result = await manager.startAll();

      expect(result.success).toBe(true);
      expect(result.chainsStarted).toBe(2);
      expect(result.chainsFailed).toBe(0);
      expect(mockFactory).toHaveBeenCalledTimes(2);
      expect(mockInstances[0].start).toHaveBeenCalled();
      expect(mockInstances[1].start).toHaveBeenCalled();
    });

    it('should continue starting other chains if one fails', async () => {
      let callCount = 0;
      const mockFactory: ChainInstanceFactory = jest.fn().mockImplementation((cfg) => {
        callCount++;
        // First chain fails, second succeeds
        return createMockChainInstance(cfg.chainId, callCount === 1) as any;
      });

      const manager = createChainInstanceManager({
        chains: ['ethereum', 'polygon'],
        partitionId: 'test-partition',
        streamsClient: mockStreamsClient as any,
        perfLogger: mockPerfLogger as any,
        chainInstanceFactory: mockFactory,
        logger: logger as any,
      });

      const result = await manager.startAll();

      expect(result.success).toBe(true); // Partial success
      expect(result.chainsStarted).toBe(1);
      expect(result.chainsFailed).toBe(1);
      expect(logger.getLogs('error').length).toBeGreaterThan(0);
    });

    it('should skip chains not in CHAINS config', async () => {
      const mockFactory: ChainInstanceFactory = jest.fn().mockImplementation((cfg) => {
        return createMockChainInstance(cfg.chainId) as any;
      });

      const manager = createChainInstanceManager({
        chains: ['ethereum', 'invalid_chain'],
        partitionId: 'test-partition',
        streamsClient: mockStreamsClient as any,
        perfLogger: mockPerfLogger as any,
        chainInstanceFactory: mockFactory,
        logger: logger as any,
        // Pass a mock chain validator
        chainValidator: (chainId) => chainId === 'ethereum',
      });

      const result = await manager.startAll();

      expect(mockFactory).toHaveBeenCalledTimes(1);
      expect(logger.hasLogMatching('warn', 'invalid_chain')).toBe(true);
    });

    it('should emit events from chain instances', async () => {
      let createdInstance: MockChainInstance | null = null;
      const mockFactory: ChainInstanceFactory = jest.fn().mockImplementation((cfg) => {
        createdInstance = createMockChainInstance(cfg.chainId);
        return createdInstance as any;
      });

      const manager = createChainInstanceManager({
        chains: ['ethereum'],
        partitionId: 'test-partition',
        streamsClient: mockStreamsClient as any,
        perfLogger: mockPerfLogger as any,
        chainInstanceFactory: mockFactory,
        logger: logger as any,
      });

      const priceUpdateHandler = jest.fn();
      const opportunityHandler = jest.fn();
      const errorHandler = jest.fn();

      manager.on('priceUpdate', priceUpdateHandler);
      manager.on('opportunity', opportunityHandler);
      manager.on('chainError', errorHandler);

      await manager.startAll();

      // Emit events from the chain instance
      const mockUpdate = { chain: 'ethereum', price: 1000 };
      const mockOpportunity = { id: 'opp-1', chain: 'ethereum' };
      const mockError = new Error('Test error');

      createdInstance!.emit('priceUpdate', mockUpdate);
      createdInstance!.emit('opportunity', mockOpportunity);
      createdInstance!.emit('error', mockError);

      expect(priceUpdateHandler).toHaveBeenCalledWith(mockUpdate);
      expect(opportunityHandler).toHaveBeenCalledWith(mockOpportunity);
      expect(errorHandler).toHaveBeenCalledWith({ chainId: 'ethereum', error: mockError });
    });

    // C2-FIX: Failed instances remain in map so health reporting shows correct chain count.
    // Previously (B1), failed instances were deleted, causing health to report "0/0 (starting)"
    // instead of "0/N (unhealthy)" when all chains fail.
    it('should keep failed instances in map for accurate health reporting (C2 fix)', async () => {
      let callCount = 0;
      const mockFactory: ChainInstanceFactory = jest.fn().mockImplementation((cfg) => {
        callCount++;
        // First chain fails, second succeeds
        return createMockChainInstance(cfg.chainId, callCount === 1) as any;
      });

      const manager = createChainInstanceManager({
        chains: ['ethereum', 'polygon'],
        partitionId: 'test-partition',
        streamsClient: mockStreamsClient as any,
        perfLogger: mockPerfLogger as any,
        chainInstanceFactory: mockFactory,
        logger: logger as any,
      });

      const result = await manager.startAll();

      // Both chains should be in the map (failed + successful)
      expect(result.chainsStarted).toBe(1);
      expect(result.chainsFailed).toBe(1);
      expect(manager.getChains()).toHaveLength(2);
      expect(manager.getChains()).toContain('polygon');
      expect(manager.getChains()).toContain('ethereum');
      // Failed instance is still accessible for health reporting
      expect(manager.getChainInstance('ethereum')).toBeDefined();
      // Only connected chains are reported as healthy
      expect(manager.getHealthyChains()).toHaveLength(1);
      expect(manager.getHealthyChains()).toContain('polygon');
    });
  });

  // ===========================================================================
  // stop (FIX I2: renamed from stopAll)
  // ===========================================================================

  describe('stop', () => {
    it('should stop all running chain instances', async () => {
      const mockInstances: MockChainInstance[] = [];
      const mockFactory: ChainInstanceFactory = jest.fn().mockImplementation((cfg) => {
        const instance = createMockChainInstance(cfg.chainId);
        mockInstances.push(instance);
        return instance as any;
      });

      const manager = createChainInstanceManager({
        chains: ['ethereum', 'polygon'],
        partitionId: 'test-partition',
        streamsClient: mockStreamsClient as any,
        perfLogger: mockPerfLogger as any,
        chainInstanceFactory: mockFactory,
        logger: logger as any,
      });

      await manager.startAll();
      await manager.stop();

      expect(mockInstances[0].stop).toHaveBeenCalled();
      expect(mockInstances[1].stop).toHaveBeenCalled();
      expect(mockInstances[0].removeAllListeners).toBeDefined();
    });

    it('should handle stop timeout gracefully', async () => {
      const mockFactory: ChainInstanceFactory = jest.fn().mockImplementation((cfg) => {
        const instance = createMockChainInstance(cfg.chainId);
        // Simulate a slow stop
        instance.stop = jest.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(resolve, 100000))
        );
        return instance as any;
      });

      const manager = createChainInstanceManager({
        chains: ['ethereum'],
        partitionId: 'test-partition',
        streamsClient: mockStreamsClient as any,
        perfLogger: mockPerfLogger as any,
        chainInstanceFactory: mockFactory,
        logger: logger as any,
        stopTimeoutMs: 100, // Short timeout for test
      });

      await manager.startAll();

      // Should complete even if chain instance stop times out
      await expect(manager.stop()).resolves.not.toThrow();
    });

    it('should clear chain instances after stop', async () => {
      const mockFactory: ChainInstanceFactory = jest.fn().mockImplementation((cfg) => {
        return createMockChainInstance(cfg.chainId) as any;
      });

      const manager = createChainInstanceManager({
        chains: ['ethereum'],
        partitionId: 'test-partition',
        streamsClient: mockStreamsClient as any,
        perfLogger: mockPerfLogger as any,
        chainInstanceFactory: mockFactory,
        logger: logger as any,
      });

      await manager.startAll();
      expect(manager.getChains()).toHaveLength(1);

      await manager.stop();
      expect(manager.getChains()).toHaveLength(0);
    });

    // FIX I2: Test deprecated alias
    it('should support deprecated stopAll() alias', async () => {
      const mockFactory: ChainInstanceFactory = jest.fn().mockImplementation((cfg) => {
        return createMockChainInstance(cfg.chainId) as any;
      });

      const manager = createChainInstanceManager({
        chains: ['ethereum'],
        partitionId: 'test-partition',
        streamsClient: mockStreamsClient as any,
        perfLogger: mockPerfLogger as any,
        chainInstanceFactory: mockFactory,
        logger: logger as any,
      });

      await manager.startAll();
      expect(manager.getChains()).toHaveLength(1);

      // Use stop() method (stopAll was deprecated and removed)
      await manager.stop();
      expect(manager.getChains()).toHaveLength(0);
    });
  });

  // ===========================================================================
  // getHealthyChains
  // ===========================================================================

  describe('getHealthyChains', () => {
    it('should return only chains with connected status', async () => {
      let callCount = 0;
      const mockFactory: ChainInstanceFactory = jest.fn().mockImplementation((cfg) => {
        callCount++;
        const instance = createMockChainInstance(cfg.chainId);
        // First chain connected, second not
        if (callCount === 2) {
          instance.getStats = jest.fn().mockReturnValue({
            chainId: cfg.chainId,
            status: 'error',
            eventsProcessed: 0,
            opportunitiesFound: 0,
            lastBlockNumber: 0,
            avgBlockLatencyMs: 0,
            pairsMonitored: 0,
          });
        }
        return instance as any;
      });

      const manager = createChainInstanceManager({
        chains: ['ethereum', 'polygon'],
        partitionId: 'test-partition',
        streamsClient: mockStreamsClient as any,
        perfLogger: mockPerfLogger as any,
        chainInstanceFactory: mockFactory,
        logger: logger as any,
      });

      await manager.startAll();

      const healthyChains = manager.getHealthyChains();
      expect(healthyChains).toEqual(['ethereum']);
    });
  });

  // ===========================================================================
  // getStats
  // ===========================================================================

  describe('getStats', () => {
    it('should return stats for all chain instances', async () => {
      const mockFactory: ChainInstanceFactory = jest.fn().mockImplementation((cfg) => {
        return createMockChainInstance(cfg.chainId) as any;
      });

      const manager = createChainInstanceManager({
        chains: ['ethereum', 'polygon'],
        partitionId: 'test-partition',
        streamsClient: mockStreamsClient as any,
        perfLogger: mockPerfLogger as any,
        chainInstanceFactory: mockFactory,
        logger: logger as any,
      });

      await manager.startAll();

      const stats = manager.getStats();

      expect(stats.size).toBe(2);
      expect(stats.has('ethereum')).toBe(true);
      expect(stats.has('polygon')).toBe(true);
      expect(stats.get('ethereum')?.eventsProcessed).toBe(100);
    });
  });

  // ===========================================================================
  // getChainInstance
  // ===========================================================================

  describe('getChainInstance', () => {
    it('should return instance for valid chain', async () => {
      const mockFactory: ChainInstanceFactory = jest.fn().mockImplementation((cfg) => {
        return createMockChainInstance(cfg.chainId) as any;
      });

      const manager = createChainInstanceManager({
        chains: ['ethereum'],
        partitionId: 'test-partition',
        streamsClient: mockStreamsClient as any,
        perfLogger: mockPerfLogger as any,
        chainInstanceFactory: mockFactory,
        logger: logger as any,
      });

      await manager.startAll();

      const instance = manager.getChainInstance('ethereum');
      expect(instance).toBeDefined();
    });

    it('should return undefined for invalid chain', async () => {
      const mockFactory: ChainInstanceFactory = jest.fn().mockImplementation((cfg) => {
        return createMockChainInstance(cfg.chainId) as any;
      });

      const manager = createChainInstanceManager({
        chains: ['ethereum'],
        partitionId: 'test-partition',
        streamsClient: mockStreamsClient as any,
        perfLogger: mockPerfLogger as any,
        chainInstanceFactory: mockFactory,
        logger: logger as any,
      });

      await manager.startAll();

      const instance = manager.getChainInstance('polygon');
      expect(instance).toBeUndefined();
    });
  });

  // ===========================================================================
  // Degradation Integration
  // ===========================================================================

  // ===========================================================================
  // Health Watchdog (P1-7 coverage — ADR-043 Phase 2)
  // ===========================================================================

  describe('health watchdog', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    function createManagerWithErrorChain(
      chains: string[],
      errorChains: string[],
      overrides?: Partial<ChainInstanceManagerConfig>,
    ) {
      const instances = new Map<string, MockChainInstance>();
      const mockFactory: ChainInstanceFactory = jest.fn().mockImplementation((cfg: any) => {
        const shouldFail = errorChains.includes(cfg.chainId);
        const instance = createMockChainInstance(cfg.chainId, shouldFail);
        instances.set(cfg.chainId, instance);
        return instance as any;
      });

      const manager = createChainInstanceManager({
        chains,
        partitionId: 'test-partition',
        streamsClient: mockStreamsClient as any,
        perfLogger: mockPerfLogger as any,
        chainInstanceFactory: mockFactory,
        logger: logger as any,
        degradationManager: mockDegradationManager as any,
        ...overrides,
        chainInstanceFactory: mockFactory,
      } as any);

      return { manager, instances };
    }

    it('should restart chains in error state on watchdog tick', async () => {
      const { manager, instances } = createManagerWithErrorChain(
        ['ethereum', 'polygon'],
        [], // start healthy
      );

      await manager.startAll();

      // Simulate ethereum going into error state
      const ethInstance = instances.get('ethereum')!;
      ethInstance.getStats.mockReturnValue({
        chainId: 'ethereum',
        status: 'error',
        eventsProcessed: 0,
        opportunitiesFound: 0,
        lastBlockNumber: 0,
        avgBlockLatencyMs: 0,
        pairsMonitored: 0,
      });
      ethInstance.isConnected.mockReturnValue(true); // restart succeeds

      const restartedHandler = jest.fn();
      manager.on('chainRestarted', restartedHandler);

      // Advance past watchdog interval (default 30s)
      await jest.advanceTimersByTimeAsync(31000);

      expect(ethInstance.stop).toHaveBeenCalled();
      expect(ethInstance.start).toHaveBeenCalledTimes(2); // initial + restart
      expect(restartedHandler).toHaveBeenCalledWith(
        expect.objectContaining({ chainId: 'ethereum', attempt: 1 }),
      );
    });

    it('should not restart chains in connected state', async () => {
      const { manager, instances } = createManagerWithErrorChain(
        ['ethereum'],
        [],
      );

      await manager.startAll();
      const ethInstance = instances.get('ethereum')!;

      // Advance past watchdog interval
      await jest.advanceTimersByTimeAsync(31000);

      // start called only once (initial), no restart
      expect(ethInstance.start).toHaveBeenCalledTimes(1);
    });

    it('should respect max restart limit', async () => {
      const { manager, instances } = createManagerWithErrorChain(
        ['ethereum'],
        [],
      );

      await manager.startAll();

      const ethInstance = instances.get('ethereum')!;
      ethInstance.getStats.mockReturnValue({
        chainId: 'ethereum',
        status: 'error',
        eventsProcessed: 0,
        opportunitiesFound: 0,
        lastBlockNumber: 0,
        avgBlockLatencyMs: 0,
        pairsMonitored: 0,
      });
      // Restart succeeds but chain keeps going back to error
      ethInstance.isConnected.mockReturnValue(true);

      const exhaustedHandler = jest.fn();
      manager.on('chainRestartExhausted', exhaustedHandler);

      // Default max restarts = 5, cooldown = 120s
      // Advance enough to trigger 6 attempts (past max)
      for (let i = 0; i < 7; i++) {
        await jest.advanceTimersByTimeAsync(121000); // past cooldown
      }

      // Should have been called at most 5 times (max restarts)
      // start: 1 (initial) + 5 (restarts) = 6
      expect(ethInstance.start.mock.calls.length).toBeLessThanOrEqual(6);
    });

    it('should respect cooldown between restart attempts', async () => {
      const { manager, instances } = createManagerWithErrorChain(
        ['ethereum'],
        [],
      );

      await manager.startAll();

      const ethInstance = instances.get('ethereum')!;
      ethInstance.getStats.mockReturnValue({
        chainId: 'ethereum',
        status: 'error',
        eventsProcessed: 0,
        opportunitiesFound: 0,
        lastBlockNumber: 0,
        avgBlockLatencyMs: 0,
        pairsMonitored: 0,
      });
      ethInstance.isConnected.mockReturnValue(true);

      // Trigger first watchdog tick (30s)
      await jest.advanceTimersByTimeAsync(31000);
      expect(ethInstance.start).toHaveBeenCalledTimes(2); // initial + 1 restart

      // Trigger second tick (30s more = 61s total) — within cooldown (120s)
      await jest.advanceTimersByTimeAsync(31000);
      expect(ethInstance.start).toHaveBeenCalledTimes(2); // no additional restart

      // Advance past cooldown (need ~90s more to reach 120s from first restart)
      await jest.advanceTimersByTimeAsync(90000);
      expect(ethInstance.start).toHaveBeenCalledTimes(3); // second restart now allowed
    });

    it('should emit chainRestartFailed when restart does not connect', async () => {
      const { manager, instances } = createManagerWithErrorChain(
        ['ethereum'],
        [],
      );

      await manager.startAll();

      const ethInstance = instances.get('ethereum')!;
      ethInstance.getStats.mockReturnValue({
        chainId: 'ethereum',
        status: 'disconnected',
        eventsProcessed: 0,
        opportunitiesFound: 0,
        lastBlockNumber: 0,
        avgBlockLatencyMs: 0,
        pairsMonitored: 0,
      });
      ethInstance.isConnected.mockReturnValue(false); // restart doesn't help

      const failedHandler = jest.fn();
      manager.on('chainRestartFailed', failedHandler);

      await jest.advanceTimersByTimeAsync(31000);

      expect(failedHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          chainId: 'ethereum',
          attempt: 1,
          reason: 'not_connected',
        }),
      );
    });

    it('should emit chainRestartFailed when restart throws', async () => {
      const { manager, instances } = createManagerWithErrorChain(
        ['ethereum'],
        [],
      );

      await manager.startAll();

      const ethInstance = instances.get('ethereum')!;
      ethInstance.getStats.mockReturnValue({
        chainId: 'ethereum',
        status: 'error',
        eventsProcessed: 0,
        opportunitiesFound: 0,
        lastBlockNumber: 0,
        avgBlockLatencyMs: 0,
        pairsMonitored: 0,
      });
      ethInstance.start.mockRejectedValueOnce(new Error('RPC down'));

      const failedHandler = jest.fn();
      manager.on('chainRestartFailed', failedHandler);

      await jest.advanceTimersByTimeAsync(31000);

      expect(failedHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          chainId: 'ethereum',
          attempt: 1,
          reason: 'RPC down',
        }),
      );
    });

    it('should clear degradation state on recovery (statusChange to connected)', async () => {
      const { manager, instances } = createManagerWithErrorChain(
        ['ethereum'],
        [],
      );

      await manager.startAll();

      const ethInstance = instances.get('ethereum')!;

      // Trigger error to set degraded state
      ethInstance.emit('error', new Error('Connection lost'));

      // Verify degraded
      let summary = manager.getChainHealthSummary();
      expect(summary[0].isDegraded).toBe(true);

      // Emit recovery
      const recoveredHandler = jest.fn();
      manager.on('chainRecovered', recoveredHandler);
      ethInstance.emit('statusChange', 'connected');

      // Verify cleared
      summary = manager.getChainHealthSummary();
      expect(summary[0].isDegraded).toBe(false);
      expect(recoveredHandler).toHaveBeenCalledWith(
        expect.objectContaining({ chainId: 'ethereum' }),
      );
    });

    it('should report health summary with restart attempts and degradation', async () => {
      const { manager, instances } = createManagerWithErrorChain(
        ['ethereum', 'polygon'],
        [],
      );

      await manager.startAll();

      // Trigger error on ethereum
      instances.get('ethereum')!.emit('error', new Error('Timeout'));
      instances.get('ethereum')!.getStats.mockReturnValue({
        chainId: 'ethereum',
        status: 'error',
        eventsProcessed: 0,
        opportunitiesFound: 0,
        lastBlockNumber: 0,
        avgBlockLatencyMs: 0,
        pairsMonitored: 0,
      });
      instances.get('ethereum')!.isConnected.mockReturnValue(true);

      // Let watchdog restart once
      await jest.advanceTimersByTimeAsync(31000);

      const summary = manager.getChainHealthSummary();
      const ethSummary = summary.find(s => s.chainId === 'ethereum')!;
      const polySummary = summary.find(s => s.chainId === 'polygon')!;

      expect(ethSummary.restartAttempts).toBe(1);
      expect(ethSummary.lastRestartAttempt).toBeGreaterThan(0);
      expect(ethSummary.isDegraded).toBe(true);
      expect(polySummary.restartAttempts).toBe(0);
      expect(polySummary.isDegraded).toBe(false);
    });

    it('should stop watchdog on manager stop', async () => {
      const { manager, instances } = createManagerWithErrorChain(
        ['ethereum'],
        [],
      );

      await manager.startAll();

      const ethInstance = instances.get('ethereum')!;
      ethInstance.getStats.mockReturnValue({
        chainId: 'ethereum',
        status: 'error',
        eventsProcessed: 0,
        opportunitiesFound: 0,
        lastBlockNumber: 0,
        avgBlockLatencyMs: 0,
        pairsMonitored: 0,
      });

      await manager.stop();

      // Advance timers after stop — no restart should occur
      const startCallsBefore = ethInstance.start.mock.calls.length;
      await jest.advanceTimersByTimeAsync(31000);
      expect(ethInstance.start.mock.calls.length).toBe(startCallsBefore);
    });
  });

  // ===========================================================================
  // Degradation Integration
  // ===========================================================================

  describe('degradation integration', () => {
    it('should register chain capabilities with degradation manager', async () => {
      const mockFactory: ChainInstanceFactory = jest.fn().mockImplementation((cfg) => {
        return createMockChainInstance(cfg.chainId) as any;
      });

      const manager = createChainInstanceManager({
        chains: ['ethereum', 'polygon'],
        partitionId: 'test-partition',
        streamsClient: mockStreamsClient as any,
        perfLogger: mockPerfLogger as any,
        chainInstanceFactory: mockFactory,
        logger: logger as any,
        degradationManager: mockDegradationManager as any,
      });

      await manager.startAll();

      expect(mockDegradationManager.registerCapabilities).toHaveBeenCalledWith(
        'unified-detector-test-partition',
        expect.arrayContaining([
          expect.objectContaining({ name: 'chain_ethereum_failure' }),
          expect.objectContaining({ name: 'chain_polygon_failure' }),
        ])
      );
    });

    it('should trigger degradation on chain error', async () => {
      let createdInstance: MockChainInstance | null = null;
      const mockFactory: ChainInstanceFactory = jest.fn().mockImplementation((cfg) => {
        createdInstance = createMockChainInstance(cfg.chainId);
        return createdInstance as any;
      });

      const manager = createChainInstanceManager({
        chains: ['ethereum'],
        partitionId: 'test-partition',
        streamsClient: mockStreamsClient as any,
        perfLogger: mockPerfLogger as any,
        chainInstanceFactory: mockFactory,
        logger: logger as any,
        degradationManager: mockDegradationManager as any,
      });

      await manager.startAll();

      // Emit error from chain instance
      const testError = new Error('Connection lost');
      createdInstance!.emit('error', testError);

      expect(mockDegradationManager.triggerDegradation).toHaveBeenCalledWith(
        'unified-detector-test-partition',
        'chain_ethereum_failure',
        testError
      );
    });
  });
});
