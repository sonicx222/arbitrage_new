/**
 * HotForkSynchronizer Unit Tests
 *
 * Tests the hot fork synchronization functionality.
 *
 * Run with: npm test -- hot-fork-synchronizer
 *
 * @see Phase 2: Pending-State Simulation Engine (Implementation Plan v3.0)
 * @see Task 2.3.2: Hot Fork Synchronization
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, jest } from '@jest/globals';
import { execSync } from 'child_process';
import { ethers } from 'ethers';
import { HotForkSynchronizer, type HotForkSynchronizerConfig } from '../../../services/simulation/hot-fork-synchronizer';
import { AnvilForkManager, type AnvilForkConfig } from '../../../services/simulation/anvil-manager';

// =============================================================================
// Test Configuration
// =============================================================================

const TEST_RPC_URL = process.env.ETH_RPC_URL || 'https://eth.llamarpc.com';
const TEST_TIMEOUT = 90000;

// Check if Anvil is available
let anvilAvailable = false;
try {
  execSync('anvil --version', { stdio: 'pipe' });
  anvilAvailable = true;
} catch {
  console.log('Anvil not found. Integration tests will be skipped.');
}

// =============================================================================
// Test Utilities
// =============================================================================

const createAnvilConfig = (port: number): AnvilForkConfig => ({
  rpcUrl: TEST_RPC_URL,
  chain: 'ethereum',
  port,
  autoStart: false,
});

const getUniquePort = () => 8545 + Math.floor(Math.random() * 1000);

// =============================================================================
// Unit Tests (no Anvil required)
// =============================================================================

describe('HotForkSynchronizer - Unit Tests', () => {
  test('should throw when Anvil is not running', async () => {
    const mockManager = {
      getState: () => 'stopped',
      resetToBlock: async () => {},
    } as unknown as AnvilForkManager;

    const mockProvider = {
      getBlockNumber: async () => 18000000,
    } as unknown as ethers.JsonRpcProvider;

    const synchronizer = new HotForkSynchronizer({
      anvilManager: mockManager,
      sourceProvider: mockProvider,
    });

    await expect(synchronizer.start()).rejects.toThrow(/not running/i);
  });

  test('should initialize with default config', () => {
    const mockManager = {
      getState: () => 'stopped',
    } as unknown as AnvilForkManager;

    const mockProvider = {} as ethers.JsonRpcProvider;

    const synchronizer = new HotForkSynchronizer({
      anvilManager: mockManager,
      sourceProvider: mockProvider,
    });

    expect(synchronizer.getState()).toBe('stopped');
  });

  test('should return initial metrics', () => {
    const mockManager = {
      getState: () => 'stopped',
    } as unknown as AnvilForkManager;

    const mockProvider = {} as ethers.JsonRpcProvider;

    const synchronizer = new HotForkSynchronizer({
      anvilManager: mockManager,
      sourceProvider: mockProvider,
    });

    const metrics = synchronizer.getMetrics();
    expect(metrics.totalSyncs).toBe(0);
    expect(metrics.successfulSyncs).toBe(0);
    expect(metrics.failedSyncs).toBe(0);
    expect(metrics.consecutiveFailures).toBe(0);
  });

  // Fix 6.3: Test lastUpdated field in metrics
  test('should include lastUpdated field in metrics (Fix 6.3)', () => {
    const mockManager = {
      getState: () => 'stopped',
    } as unknown as AnvilForkManager;

    const mockProvider = {} as ethers.JsonRpcProvider;

    const synchronizer = new HotForkSynchronizer({
      anvilManager: mockManager,
      sourceProvider: mockProvider,
    });

    const metrics = synchronizer.getMetrics();
    expect(metrics).toHaveProperty('lastUpdated');
    expect(typeof metrics.lastUpdated).toBe('number');
    expect(metrics.lastUpdated).toBeGreaterThan(0);
  });

  test('should be able to pause and resume', () => {
    const mockManager = {
      getState: () => 'running',
    } as unknown as AnvilForkManager;

    const mockProvider = {} as ethers.JsonRpcProvider;

    const synchronizer = new HotForkSynchronizer({
      anvilManager: mockManager,
      sourceProvider: mockProvider,
    });

    // Can't pause when stopped
    synchronizer.pause();
    expect(synchronizer.getState()).toBe('stopped');

    // Can't resume when stopped
    synchronizer.resume();
    expect(synchronizer.getState()).toBe('stopped');
  });

  test('stop should be idempotent', async () => {
    const mockManager = {
      getState: () => 'stopped',
    } as unknown as AnvilForkManager;

    const mockProvider = {} as ethers.JsonRpcProvider;

    const synchronizer = new HotForkSynchronizer({
      anvilManager: mockManager,
      sourceProvider: mockProvider,
    });

    await synchronizer.stop();
    await synchronizer.stop();
    expect(synchronizer.getState()).toBe('stopped');
  });
});

// =============================================================================
// Adaptive Sync Unit Tests (Fix 10.5)
// =============================================================================

describe('HotForkSynchronizer - Adaptive Sync Unit Tests', () => {
  test('should initialize with adaptive sync config', () => {
    const mockManager = {
      getState: () => 'stopped',
    } as unknown as AnvilForkManager;

    const mockProvider = {} as ethers.JsonRpcProvider;

    const synchronizer = new HotForkSynchronizer({
      anvilManager: mockManager,
      sourceProvider: mockProvider,
      adaptiveSync: true,
      minSyncIntervalMs: 100,
      maxSyncIntervalMs: 5000,
    });

    expect(synchronizer.getState()).toBe('stopped');
    // Internal config should be set (verified by not throwing)
  });

  test('should accept custom logger', () => {
    const mockManager = {
      getState: () => 'stopped',
    } as unknown as AnvilForkManager;

    const mockProvider = {} as ethers.JsonRpcProvider;

    const mockLogger = {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
    };

    const synchronizer = new HotForkSynchronizer({
      anvilManager: mockManager,
      sourceProvider: mockProvider,
      logger: mockLogger,
    });

    expect(synchronizer.getState()).toBe('stopped');
    // Logger should be set (can't verify directly, but no errors means success)
  });

  test('should reset metrics', () => {
    const mockManager = {
      getState: () => 'stopped',
    } as unknown as AnvilForkManager;

    const mockProvider = {} as ethers.JsonRpcProvider;

    const synchronizer = new HotForkSynchronizer({
      anvilManager: mockManager,
      sourceProvider: mockProvider,
    });

    // Get initial metrics
    const initialMetrics = synchronizer.getMetrics();
    expect(initialMetrics.totalSyncs).toBe(0);

    // Reset should work (even though nothing changed)
    synchronizer.resetMetrics();

    const resetMetrics = synchronizer.getMetrics();
    expect(resetMetrics.totalSyncs).toBe(0);
    expect(resetMetrics.consecutiveFailures).toBe(0);
  });

  test('should handle sync failures gracefully', async () => {
    // Track call count for block number to ensure it always increases
    let blockCallCount = 0;

    const mockManager = {
      getState: () => 'running',
      resetToBlock: async () => {
        // Always fail
        throw new Error('Mock sync failure');
      },
    } as unknown as AnvilForkManager;

    const mockProvider = {
      getBlockNumber: async () => {
        // Each call returns a higher block number to ensure sync attempt happens
        blockCallCount++;
        return 18000000 + blockCallCount;
      },
    } as unknown as ethers.JsonRpcProvider;

    const mockLogger = {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
    };

    const synchronizer = new HotForkSynchronizer({
      anvilManager: mockManager,
      sourceProvider: mockProvider,
      syncIntervalMs: 20,
      maxConsecutiveFailures: 3,
      logger: mockLogger,
    });

    await synchronizer.start();
    expect(synchronizer.getState()).toBe('running');

    // Wait for enough intervals to accumulate failures (3 failures + buffer time)
    // With 20ms interval and max 3 failures, we need at least 60ms + some buffer
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Should have paused after max consecutive failures
    expect(synchronizer.getState()).toBe('paused');
    expect(synchronizer.getMetrics().consecutiveFailures).toBeGreaterThanOrEqual(3);

    await synchronizer.stop();
  });

  test('should start synchronizer in running state when Anvil is running', async () => {
    let syncedBlock = 18000000;
    const mockManager = {
      getState: () => 'running',
      resetToBlock: async (blockNumber: number) => {
        syncedBlock = blockNumber;
      },
    } as unknown as AnvilForkManager;

    const mockProvider = {
      getBlockNumber: async () => syncedBlock + 1,
    } as unknown as ethers.JsonRpcProvider;

    const synchronizer = new HotForkSynchronizer({
      anvilManager: mockManager,
      sourceProvider: mockProvider,
      syncIntervalMs: 1000, // Slow so we can control timing
    });

    await synchronizer.start();
    expect(synchronizer.getState()).toBe('running');
    expect(synchronizer.getLastSyncedBlock()).toBe(syncedBlock + 1);

    await synchronizer.stop();
    expect(synchronizer.getState()).toBe('stopped');
  });

  test('start should be idempotent when already running', async () => {
    let syncCount = 0;
    const mockManager = {
      getState: () => 'running',
      resetToBlock: async () => {
        syncCount++;
      },
    } as unknown as AnvilForkManager;

    const mockProvider = {
      getBlockNumber: async () => 18000000,
    } as unknown as ethers.JsonRpcProvider;

    const synchronizer = new HotForkSynchronizer({
      anvilManager: mockManager,
      sourceProvider: mockProvider,
      syncIntervalMs: 10000,
    });

    await synchronizer.start();
    expect(synchronizer.getState()).toBe('running');

    // Starting again should be a no-op
    await synchronizer.start();
    expect(synchronizer.getState()).toBe('running');

    await synchronizer.stop();
  });
});
