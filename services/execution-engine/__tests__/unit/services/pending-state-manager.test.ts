/**
 * Tests for Pending State Manager
 *
 * Verifies lifecycle management of Phase 2 pending state simulation components.
 */

import {
  PendingStateManager,
  createPendingStateManager,
  type PendingStateManagerDeps,
  type PendingStateProviderSource,
} from '../../../src/services/pending-state-manager';
import type { PendingStateEngineConfig } from '../../../src/types';

// Mock simulation modules
const mockAnvilForkManager = {
  startFork: jest.fn().mockResolvedValue(undefined),
  shutdown: jest.fn().mockResolvedValue(undefined),
  getState: jest.fn().mockReturnValue('running'),
};

const mockPendingStateSimulator = {
  _type: 'simulator',
};

const mockHotForkSynchronizer = {
  start: jest.fn().mockResolvedValue(undefined),
  stop: jest.fn().mockResolvedValue(undefined),
};

jest.mock('../../../src/services/simulation/anvil-manager', () => ({
  createAnvilForkManager: jest.fn().mockImplementation(() => mockAnvilForkManager),
}));

jest.mock('../../../src/services/simulation/pending-state-simulator', () => ({
  createPendingStateSimulator: jest.fn().mockImplementation(() => mockPendingStateSimulator),
}));

jest.mock('../../../src/services/simulation/hot-fork-synchronizer', () => ({
  createHotForkSynchronizer: jest.fn().mockImplementation(() => mockHotForkSynchronizer),
}));

import { createAnvilForkManager } from '../../../src/services/simulation/anvil-manager';
import { createPendingStateSimulator } from '../../../src/services/simulation/pending-state-simulator';
import { createHotForkSynchronizer } from '../../../src/services/simulation/hot-fork-synchronizer';

describe('PendingStateManager', () => {
  let mockLogger: any;
  let mockProviderSource: PendingStateProviderSource;
  let defaultConfig: PendingStateEngineConfig;

  beforeEach(() => {
    jest.clearAllMocks();

    // Re-set mock implementations after clearAllMocks
    (createAnvilForkManager as jest.Mock).mockImplementation(() => mockAnvilForkManager);
    (createPendingStateSimulator as jest.Mock).mockImplementation(() => mockPendingStateSimulator);
    (createHotForkSynchronizer as jest.Mock).mockImplementation(() => mockHotForkSynchronizer);

    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    mockProviderSource = {
      getProvider: jest.fn().mockReturnValue({ _chain: 'ethereum' }),
    };

    defaultConfig = {
      enabled: true,
      rpcUrl: 'http://localhost:8545',
      chain: 'ethereum',
      anvilPort: 8546,
      autoStartAnvil: true,
      enableHotSync: true,
      syncIntervalMs: 1000,
      adaptiveSync: true,
      minSyncIntervalMs: 200,
      maxSyncIntervalMs: 5000,
      maxConsecutiveFailures: 5,
      simulationTimeoutMs: 5000,
    };

    // Reset mock states
    mockAnvilForkManager.startFork.mockResolvedValue(undefined);
    mockAnvilForkManager.shutdown.mockResolvedValue(undefined);
    mockAnvilForkManager.getState.mockReturnValue('running');
    mockHotForkSynchronizer.start.mockResolvedValue(undefined);
    mockHotForkSynchronizer.stop.mockResolvedValue(undefined);
  });

  function createManager(overrides: Partial<PendingStateManagerDeps> = {}): PendingStateManager {
    return createPendingStateManager({
      config: defaultConfig,
      providerSource: mockProviderSource,
      logger: mockLogger,
      ...overrides,
    });
  }

  describe('initialize', () => {
    it('should skip when rpcUrl is not configured', async () => {
      const manager = createManager({
        config: { ...defaultConfig, rpcUrl: undefined },
      });

      await manager.initialize();

      expect(createAnvilForkManager).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Phase 2 pending state simulation skipped - no RPC URL configured',
        expect.any(Object),
      );
    });

    it('should create all components when fully configured', async () => {
      const manager = createManager();
      await manager.initialize();

      expect(createAnvilForkManager).toHaveBeenCalledWith(expect.objectContaining({
        rpcUrl: 'http://localhost:8545',
        chain: 'ethereum',
        port: 8546,
        autoStart: false,
      }));
      expect(mockAnvilForkManager.startFork).toHaveBeenCalled();
      expect(createPendingStateSimulator).toHaveBeenCalledWith(expect.objectContaining({
        anvilManager: mockAnvilForkManager,
        timeoutMs: 5000,
      }));
      expect(createHotForkSynchronizer).toHaveBeenCalled();
      expect(mockHotForkSynchronizer.start).toHaveBeenCalled();
    });

    it('should skip auto-start when autoStartAnvil is false', async () => {
      const manager = createManager({
        config: { ...defaultConfig, autoStartAnvil: false },
      });
      await manager.initialize();

      expect(mockAnvilForkManager.startFork).not.toHaveBeenCalled();
    });

    it('should skip hot fork synchronizer when enableHotSync is false', async () => {
      const manager = createManager({
        config: { ...defaultConfig, enableHotSync: false },
      });
      await manager.initialize();

      expect(createHotForkSynchronizer).not.toHaveBeenCalled();
    });

    it('should skip hot fork synchronizer when anvil is not running', async () => {
      mockAnvilForkManager.getState.mockReturnValue('stopped');

      const manager = createManager();
      await manager.initialize();

      expect(createHotForkSynchronizer).not.toHaveBeenCalled();
    });

    it('should skip hot fork synchronizer when no source provider', async () => {
      (mockProviderSource.getProvider as jest.Mock).mockReturnValue(undefined);

      const manager = createManager();
      await manager.initialize();

      expect(createHotForkSynchronizer).not.toHaveBeenCalled();
    });

    it('should clean up on initialization failure', async () => {
      mockAnvilForkManager.startFork.mockRejectedValue(new Error('Anvil start failed'));

      const manager = createManager();
      await manager.initialize();

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to initialize Phase 2 pending state simulation',
        expect.objectContaining({ error: expect.stringContaining('Anvil start failed') }),
      );
      // Cleanup should have been called
      expect(manager.getSimulator()).toBeNull();
      expect(manager.getAnvilManager()).toBeNull();
    });

    it('should default chain to ethereum when not specified', async () => {
      const manager = createManager({
        config: { ...defaultConfig, chain: undefined },
      });
      await manager.initialize();

      expect(createAnvilForkManager).toHaveBeenCalledWith(expect.objectContaining({
        chain: 'ethereum',
      }));
    });
  });

  describe('shutdown', () => {
    it('should stop all components in correct order', async () => {
      const manager = createManager();
      await manager.initialize();
      await manager.shutdown();

      expect(mockHotForkSynchronizer.stop).toHaveBeenCalled();
      expect(mockAnvilForkManager.shutdown).toHaveBeenCalled();
      expect(manager.getSimulator()).toBeNull();
      expect(manager.getAnvilManager()).toBeNull();
      expect(manager.getSynchronizer()).toBeNull();
    });

    it('should be idempotent (safe to call multiple times)', async () => {
      const manager = createManager();
      await manager.shutdown(); // No init, should be safe
      await manager.shutdown(); // Double call

      expect(mockHotForkSynchronizer.stop).not.toHaveBeenCalled();
      expect(mockAnvilForkManager.shutdown).not.toHaveBeenCalled();
    });

    it('should handle synchronizer stop error gracefully', async () => {
      const manager = createManager();
      await manager.initialize();

      mockHotForkSynchronizer.stop.mockRejectedValue(new Error('stop failed'));
      await manager.shutdown();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Error stopping hot fork synchronizer',
        expect.any(Object),
      );
      // Should still proceed to shutdown anvil
      expect(mockAnvilForkManager.shutdown).toHaveBeenCalled();
    });

    it('should handle anvil shutdown error gracefully', async () => {
      const manager = createManager();
      await manager.initialize();

      mockAnvilForkManager.shutdown.mockRejectedValue(new Error('shutdown failed'));
      await manager.shutdown();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Error shutting down Anvil fork',
        expect.any(Object),
      );
    });
  });

  describe('getters', () => {
    it('should return null for all getters before initialization', () => {
      const manager = createManager();

      expect(manager.getSimulator()).toBeNull();
      expect(manager.getAnvilManager()).toBeNull();
      expect(manager.getSynchronizer()).toBeNull();
    });

    it('should return initialized components after init', async () => {
      const manager = createManager();
      await manager.initialize();

      expect(manager.getSimulator()).toBe(mockPendingStateSimulator);
      expect(manager.getAnvilManager()).toBe(mockAnvilForkManager);
      expect(manager.getSynchronizer()).toBe(mockHotForkSynchronizer);
    });

    it('should return null for all getters after shutdown', async () => {
      const manager = createManager();
      await manager.initialize();
      await manager.shutdown();

      expect(manager.getSimulator()).toBeNull();
      expect(manager.getAnvilManager()).toBeNull();
      expect(manager.getSynchronizer()).toBeNull();
    });
  });

  describe('factory function', () => {
    it('should create a PendingStateManager instance', () => {
      const manager = createPendingStateManager({
        config: defaultConfig,
        providerSource: mockProviderSource,
        logger: mockLogger,
      });

      expect(manager).toBeInstanceOf(PendingStateManager);
    });
  });
});
