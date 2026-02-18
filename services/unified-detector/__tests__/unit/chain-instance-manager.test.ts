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
import { RecordingLogger } from '@arbitrage/core';

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

    // FIX B1: Test that failed instances are removed from the map
    it('should remove failed instances from map (B1 fix)', async () => {
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

      // Only successful chain should be in the map
      expect(result.chainsStarted).toBe(1);
      expect(result.chainsFailed).toBe(1);
      expect(manager.getChains()).toHaveLength(1);
      expect(manager.getChains()).toContain('polygon');
      expect(manager.getChains()).not.toContain('ethereum');
      expect(manager.getChainInstance('ethereum')).toBeUndefined();
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
