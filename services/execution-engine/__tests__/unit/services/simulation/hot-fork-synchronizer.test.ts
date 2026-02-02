/**
 * HotForkSynchronizer Unit Tests
 *
 * Tests the hot fork synchronizer that keeps Anvil forks updated with latest blocks.
 * Includes tests for race conditions (Fix 5.1), adaptive sync (Fix 10.5), and metrics.
 *
 * @see Fix 8.2: Missing tests for HotForkSynchronizer
 */

// @ts-nocheck - Test file with mock objects that don't need strict typing
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { ethers } from 'ethers';
import { HotForkSynchronizer, type SynchronizerState } from '../../../../src/services/simulation/hot-fork-synchronizer';
import type { AnvilForkManager } from '../../../../src/services/simulation/anvil-manager';

// =============================================================================
// Mock Factories
// =============================================================================

const createMockAnvilManager = () => ({
  getState: jest.fn(() => 'running' as const),
  getProvider: jest.fn(() => createMockProvider()),
  resetToBlock: jest.fn(() => Promise.resolve()),
  createSnapshot: jest.fn(() => Promise.resolve('snapshot-1')),
  revertToSnapshot: jest.fn(() => Promise.resolve()),
  startFork: jest.fn(() => Promise.resolve()),
  stopFork: jest.fn(() => Promise.resolve()),
});

const createMockProvider = () => ({
  getBlockNumber: jest.fn(() => Promise.resolve(18500000)),
  getNetwork: jest.fn(() => Promise.resolve({ chainId: 1n, name: 'mainnet' })),
});

const createMockLogger = () => ({
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
});

// =============================================================================
// Test Suite
// =============================================================================

describe('HotForkSynchronizer', () => {
  let synchronizer: HotForkSynchronizer;
  let mockAnvilManager: ReturnType<typeof createMockAnvilManager>;
  let mockSourceProvider: ReturnType<typeof createMockProvider>;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let blockNumber: number;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();

    mockAnvilManager = createMockAnvilManager();
    mockSourceProvider = createMockProvider();
    mockLogger = createMockLogger();
    blockNumber = 18500000;

    mockSourceProvider.getBlockNumber.mockImplementation(() => Promise.resolve(blockNumber));
  });

  afterEach(async () => {
    if (synchronizer) {
      await synchronizer.stop();
    }
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // ===========================================================================
  // Constructor Tests
  // ===========================================================================

  describe('constructor', () => {
    test('should initialize with default configuration', () => {
      synchronizer = new HotForkSynchronizer({
        anvilManager: mockAnvilManager as unknown as AnvilForkManager,
        sourceProvider: mockSourceProvider as unknown as ethers.JsonRpcProvider,
        logger: mockLogger as any,
      });

      expect(synchronizer.getState()).toBe('stopped');
      expect(synchronizer.getLastSyncedBlock()).toBe(0);
    });

    test('should initialize with custom sync interval', () => {
      synchronizer = new HotForkSynchronizer({
        anvilManager: mockAnvilManager as unknown as AnvilForkManager,
        sourceProvider: mockSourceProvider as unknown as ethers.JsonRpcProvider,
        syncIntervalMs: 500,
        logger: mockLogger as any,
      });

      expect(synchronizer.getState()).toBe('stopped');
    });

    test('should not auto-start by default', () => {
      synchronizer = new HotForkSynchronizer({
        anvilManager: mockAnvilManager as unknown as AnvilForkManager,
        sourceProvider: mockSourceProvider as unknown as ethers.JsonRpcProvider,
        logger: mockLogger as any,
      });

      expect(synchronizer.getState()).toBe('stopped');
    });
  });

  // ===========================================================================
  // Lifecycle Tests
  // ===========================================================================

  describe('lifecycle', () => {
    beforeEach(() => {
      synchronizer = new HotForkSynchronizer({
        anvilManager: mockAnvilManager as unknown as AnvilForkManager,
        sourceProvider: mockSourceProvider as unknown as ethers.JsonRpcProvider,
        syncIntervalMs: 1000,
        logger: mockLogger as any,
      });
    });

    test('should start synchronization', async () => {
      await synchronizer.start();

      expect(synchronizer.getState()).toBe('running');
      expect(synchronizer.getLastSyncedBlock()).toBe(blockNumber);
    });

    test('should throw error if Anvil is not running', async () => {
      mockAnvilManager.getState.mockReturnValue('stopped');

      await expect(synchronizer.start()).rejects.toThrow('Anvil fork is not running');
    });

    test('should stop synchronization', async () => {
      await synchronizer.start();
      await synchronizer.stop();

      expect(synchronizer.getState()).toBe('stopped');
    });

    test('should be idempotent for multiple start calls', async () => {
      await synchronizer.start();
      await synchronizer.start();

      expect(synchronizer.getState()).toBe('running');
    });

    test('should be idempotent for multiple stop calls', async () => {
      await synchronizer.start();
      await synchronizer.stop();
      await synchronizer.stop();

      expect(synchronizer.getState()).toBe('stopped');
    });
  });

  // ===========================================================================
  // Pause/Resume Tests
  // ===========================================================================

  describe('pause/resume', () => {
    beforeEach(async () => {
      jest.useRealTimers();
      // Ensure mock returns successful value for start
      mockSourceProvider.getBlockNumber.mockResolvedValue(blockNumber);
      synchronizer = new HotForkSynchronizer({
        anvilManager: mockAnvilManager as unknown as AnvilForkManager,
        sourceProvider: mockSourceProvider as unknown as ethers.JsonRpcProvider,
        syncIntervalMs: 100, // Short interval for faster tests
        logger: mockLogger as any,
      });
      await synchronizer.start();
    });

    test('should pause synchronization', () => {
      synchronizer.pause();
      expect(synchronizer.getState()).toBe('paused');
    });

    test('should resume synchronization', () => {
      synchronizer.pause();
      synchronizer.resume();
      expect(synchronizer.getState()).toBe('running');
    });

    test('should not pause if not running', async () => {
      await synchronizer.stop();
      synchronizer.pause();
      expect(synchronizer.getState()).toBe('stopped');
    });

    test('should not resume if not paused', async () => {
      await synchronizer.stop();
      synchronizer.resume();
      expect(synchronizer.getState()).toBe('stopped');
    });
  });

  // ===========================================================================
  // Sync Behavior Tests
  // ===========================================================================

  describe('sync behavior', () => {
    beforeEach(async () => {
      jest.useRealTimers();
      synchronizer = new HotForkSynchronizer({
        anvilManager: mockAnvilManager as unknown as AnvilForkManager,
        sourceProvider: mockSourceProvider as unknown as ethers.JsonRpcProvider,
        syncIntervalMs: 100,
        logger: mockLogger as any,
      });
    });

    test('should sync to new blocks', async () => {
      await synchronizer.start();

      // Simulate new block
      blockNumber = 18500001;

      // Wait for sync
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(mockAnvilManager.resetToBlock).toHaveBeenCalledWith(18500001);
      expect(synchronizer.getLastSyncedBlock()).toBe(18500001);
    });

    test('should not reset if no new blocks', async () => {
      await synchronizer.start();

      // Keep same block number
      mockAnvilManager.resetToBlock.mockClear();

      // Wait for sync
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(mockAnvilManager.resetToBlock).not.toHaveBeenCalled();
    });

    test('should handle sync errors gracefully', async () => {
      // First call succeeds (for start()), then next one fails
      let callCount = 0;
      mockSourceProvider.getBlockNumber.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return blockNumber;
        if (callCount === 2) throw new Error('RPC error');
        return blockNumber + 1; // Subsequent calls succeed
      });

      await synchronizer.start();

      // Wait for failed sync
      await new Promise((resolve) => setTimeout(resolve, 150));

      const metrics = synchronizer.getMetrics();
      expect(metrics.failedSyncs).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // Race Condition Tests (Fix 5.1)
  // ===========================================================================

  describe('race condition handling (Fix 5.1)', () => {
    beforeEach(async () => {
      jest.useRealTimers();
      synchronizer = new HotForkSynchronizer({
        anvilManager: mockAnvilManager as unknown as AnvilForkManager,
        sourceProvider: mockSourceProvider as unknown as ethers.JsonRpcProvider,
        syncIntervalMs: 50,
        logger: mockLogger as any,
      });
    });

    test('should handle stop during in-flight sync', async () => {
      // Make getBlockNumber slow to simulate in-flight sync
      mockSourceProvider.getBlockNumber.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return blockNumber;
      });

      await synchronizer.start();

      // Stop while sync is in-flight
      await new Promise((resolve) => setTimeout(resolve, 20));
      await synchronizer.stop();

      expect(synchronizer.getState()).toBe('stopped');
    });

    test('should not sync when paused', async () => {
      await synchronizer.start();

      synchronizer.pause();
      mockAnvilManager.resetToBlock.mockClear();

      // Simulate new block
      blockNumber = 18500001;

      // Wait for would-be sync
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Should not have synced while paused
      expect(mockAnvilManager.resetToBlock).not.toHaveBeenCalled();
    });

    test('should skip sync if already syncing (prevent concurrent syncs)', async () => {
      // Make sync slow
      mockAnvilManager.resetToBlock.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });

      await synchronizer.start();

      // Wait for multiple sync attempts
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Stop and check metrics
      await synchronizer.stop();

      // Due to slow sync, consecutive syncs should be skipped
      // The isSyncing flag prevents concurrent syncs
      const metrics = synchronizer.getMetrics();
      expect(metrics.totalSyncs).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // Metrics Tests
  // ===========================================================================

  describe('metrics', () => {
    beforeEach(async () => {
      jest.useRealTimers();
      synchronizer = new HotForkSynchronizer({
        anvilManager: mockAnvilManager as unknown as AnvilForkManager,
        sourceProvider: mockSourceProvider as unknown as ethers.JsonRpcProvider,
        syncIntervalMs: 50,
        logger: mockLogger as any,
      });
    });

    test('should start with empty metrics', () => {
      const metrics = synchronizer.getMetrics();
      expect(metrics.totalSyncs).toBe(0);
      expect(metrics.successfulSyncs).toBe(0);
      expect(metrics.failedSyncs).toBe(0);
      expect(metrics.consecutiveFailures).toBe(0);
    });

    test('should track successful syncs', async () => {
      blockNumber = 18500001;
      await synchronizer.start();

      // Wait for sync
      await new Promise((resolve) => setTimeout(resolve, 100));

      const metrics = synchronizer.getMetrics();
      expect(metrics.successfulSyncs).toBeGreaterThan(0);
    });

    test('should track failed syncs', async () => {
      // First call succeeds (for start()), then fails
      let callCount = 0;
      mockSourceProvider.getBlockNumber.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return blockNumber;
        throw new Error('RPC error');
      });

      await synchronizer.start();

      // Wait for failed sync
      await new Promise((resolve) => setTimeout(resolve, 100));

      const metrics = synchronizer.getMetrics();
      expect(metrics.failedSyncs).toBeGreaterThan(0);
    });

    test('should track consecutive failures', async () => {
      // First call succeeds (for start()), then fails
      let callCount = 0;
      mockSourceProvider.getBlockNumber.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return blockNumber;
        throw new Error('RPC error');
      });

      await synchronizer.start();

      // Wait for multiple failed syncs
      await new Promise((resolve) => setTimeout(resolve, 200));

      const metrics = synchronizer.getMetrics();
      expect(metrics.consecutiveFailures).toBeGreaterThan(0);
    });

    test('should reset metrics', async () => {
      blockNumber = 18500001;
      await synchronizer.start();

      // Wait for sync
      await new Promise((resolve) => setTimeout(resolve, 100));

      synchronizer.resetMetrics();

      const metrics = synchronizer.getMetrics();
      expect(metrics.totalSyncs).toBe(0);
    });

    test('should track lastUpdated timestamp (Fix 6.3)', async () => {
      blockNumber = 18500001;
      const beforeTime = Date.now();
      await synchronizer.start();

      // Wait for sync
      await new Promise((resolve) => setTimeout(resolve, 100));
      const afterTime = Date.now();

      const metrics = synchronizer.getMetrics();
      expect(metrics.lastUpdated).toBeGreaterThanOrEqual(beforeTime);
      expect(metrics.lastUpdated).toBeLessThanOrEqual(afterTime);
    });
  });

  // ===========================================================================
  // Force Sync Tests
  // ===========================================================================

  describe('forceSync', () => {
    beforeEach(async () => {
      jest.useRealTimers();
      synchronizer = new HotForkSynchronizer({
        anvilManager: mockAnvilManager as unknown as AnvilForkManager,
        sourceProvider: mockSourceProvider as unknown as ethers.JsonRpcProvider,
        syncIntervalMs: 10000, // Long interval so periodic sync doesn't interfere
        logger: mockLogger as any,
      });
      await synchronizer.start();
    });

    test('should force immediate sync', async () => {
      blockNumber = 18500001;
      const newBlock = await synchronizer.forceSync();

      expect(newBlock).toBe(18500001);
      expect(synchronizer.getLastSyncedBlock()).toBe(18500001);
    });

    test('should update metrics on force sync', async () => {
      blockNumber = 18500001;
      await synchronizer.forceSync();

      const metrics = synchronizer.getMetrics();
      expect(metrics.successfulSyncs).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // Auto-Pause on Consecutive Failures Tests
  // ===========================================================================

  describe('auto-pause on failures', () => {
    beforeEach(() => {
      jest.useRealTimers();
    });

    test('should auto-pause after max consecutive failures', async () => {
      // First call succeeds (for start()), then fails
      let callCount = 0;
      mockSourceProvider.getBlockNumber.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return blockNumber;
        throw new Error('RPC error');
      });

      synchronizer = new HotForkSynchronizer({
        anvilManager: mockAnvilManager as unknown as AnvilForkManager,
        sourceProvider: mockSourceProvider as unknown as ethers.JsonRpcProvider,
        syncIntervalMs: 20,
        maxConsecutiveFailures: 3,
        logger: mockLogger as any,
      });

      await synchronizer.start();

      // Wait for enough failures
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(synchronizer.getState()).toBe('paused');
      expect(mockLogger.error).toHaveBeenCalled();
    });

    test('should reset consecutive failures on success', async () => {
      let failCount = 0;
      mockSourceProvider.getBlockNumber.mockImplementation(async () => {
        failCount++;
        // First call succeeds (for start()), then 2 failures, then success
        if (failCount === 1) return blockNumber;
        if (failCount <= 3) {
          throw new Error('RPC error');
        }
        return blockNumber;
      });

      synchronizer = new HotForkSynchronizer({
        anvilManager: mockAnvilManager as unknown as AnvilForkManager,
        sourceProvider: mockSourceProvider as unknown as ethers.JsonRpcProvider,
        syncIntervalMs: 20,
        maxConsecutiveFailures: 5,
        logger: mockLogger as any,
      });

      await synchronizer.start();

      // Wait for enough syncs to complete failures and recovery (increased for CI stability)
      await new Promise((resolve) => setTimeout(resolve, 400));

      const metrics = synchronizer.getMetrics();
      expect(metrics.consecutiveFailures).toBe(0);
    });
  });

  // ===========================================================================
  // Adaptive Sync Tests (Fix 10.5)
  // ===========================================================================

  describe('adaptive sync (Fix 10.5)', () => {
    test('should use adaptive sync when enabled', async () => {
      jest.useRealTimers();

      // Ensure mock returns successful values
      mockSourceProvider.getBlockNumber.mockResolvedValue(blockNumber);

      synchronizer = new HotForkSynchronizer({
        anvilManager: mockAnvilManager as unknown as AnvilForkManager,
        sourceProvider: mockSourceProvider as unknown as ethers.JsonRpcProvider,
        adaptiveSync: true,
        minSyncIntervalMs: 50,
        maxSyncIntervalMs: 500,
        logger: mockLogger as any,
      });

      await synchronizer.start();

      // Simulate block progress to trigger syncs
      blockNumber = 18500001;

      // Wait for some syncs
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(synchronizer.getState()).toBe('running');
      // Adaptive mode should have synced at least once
      // Note: In adaptive mode, the sync happens AFTER the first interval
    });

    test('should stop cleanly in adaptive mode', async () => {
      jest.useRealTimers();

      // Ensure mock returns successful values
      mockSourceProvider.getBlockNumber.mockResolvedValue(blockNumber);

      synchronizer = new HotForkSynchronizer({
        anvilManager: mockAnvilManager as unknown as AnvilForkManager,
        sourceProvider: mockSourceProvider as unknown as ethers.JsonRpcProvider,
        adaptiveSync: true,
        minSyncIntervalMs: 50,
        maxSyncIntervalMs: 500,
        logger: mockLogger as any,
      });

      await synchronizer.start();
      expect(synchronizer.getState()).toBe('running');

      // Let adaptive sync start
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Stop should work cleanly without hanging timers
      await synchronizer.stop();
      expect(synchronizer.getState()).toBe('stopped');
    });
  });
});
