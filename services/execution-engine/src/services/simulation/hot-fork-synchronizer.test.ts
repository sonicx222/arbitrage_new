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
import { HotForkSynchronizer, type HotForkSynchronizerConfig } from './hot-fork-synchronizer';
import { AnvilForkManager, type AnvilForkConfig } from './anvil-manager';

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
// Integration Tests (requires Anvil)
// =============================================================================

const describeIntegration = anvilAvailable ? describe : describe.skip;

describeIntegration('HotForkSynchronizer - Integration Tests', () => {
  let anvilManager: AnvilForkManager;
  let sourceProvider: ethers.JsonRpcProvider;
  let synchronizer: HotForkSynchronizer;
  let testPort: number;

  beforeAll(async () => {
    testPort = getUniquePort();
    anvilManager = new AnvilForkManager(createAnvilConfig(testPort));
    await anvilManager.startFork(30000);

    sourceProvider = new ethers.JsonRpcProvider(TEST_RPC_URL);
  }, TEST_TIMEOUT);

  afterEach(async () => {
    if (synchronizer) {
      await synchronizer.stop();
    }
  });

  afterAll(async () => {
    if (anvilManager) {
      await anvilManager.shutdown();
    }
  });

  test('should start and sync to latest block', async () => {
    synchronizer = new HotForkSynchronizer({
      anvilManager,
      sourceProvider,
      syncIntervalMs: 100, // Fast sync for testing
    });

    await synchronizer.start();
    expect(synchronizer.getState()).toBe('running');
    expect(synchronizer.getLastSyncedBlock()).toBeGreaterThan(0);
  }, TEST_TIMEOUT);

  test('should force sync on demand', async () => {
    synchronizer = new HotForkSynchronizer({
      anvilManager,
      sourceProvider,
      syncIntervalMs: 10000, // Slow interval
    });

    await synchronizer.start();
    const initialBlock = synchronizer.getLastSyncedBlock();

    // Force sync should work
    const newBlock = await synchronizer.forceSync();
    expect(newBlock).toBeGreaterThanOrEqual(initialBlock);
  }, TEST_TIMEOUT);

  test('should pause and resume', async () => {
    synchronizer = new HotForkSynchronizer({
      anvilManager,
      sourceProvider,
      syncIntervalMs: 100,
    });

    await synchronizer.start();
    expect(synchronizer.getState()).toBe('running');

    synchronizer.pause();
    expect(synchronizer.getState()).toBe('paused');

    synchronizer.resume();
    expect(synchronizer.getState()).toBe('running');
  }, TEST_TIMEOUT);

  test('should track metrics after syncs', async () => {
    synchronizer = new HotForkSynchronizer({
      anvilManager,
      sourceProvider,
      syncIntervalMs: 50,
    });

    await synchronizer.start();

    // Wait for some syncs to happen
    await new Promise((resolve) => setTimeout(resolve, 200));

    const metrics = synchronizer.getMetrics();
    expect(metrics.totalSyncs).toBeGreaterThan(0);
    expect(metrics.lastSyncTime).toBeGreaterThan(0);
  }, TEST_TIMEOUT);

  test('should start with adaptive sync enabled', async () => {
    synchronizer = new HotForkSynchronizer({
      anvilManager,
      sourceProvider,
      syncIntervalMs: 500,
      adaptiveSync: true,
      minSyncIntervalMs: 100,
      maxSyncIntervalMs: 2000,
    });

    await synchronizer.start();
    expect(synchronizer.getState()).toBe('running');

    // Wait for some syncs
    await new Promise((resolve) => setTimeout(resolve, 700));

    const metrics = synchronizer.getMetrics();
    // Should have synced at least once with adaptive mode
    expect(metrics.totalSyncs).toBeGreaterThan(0);
  }, TEST_TIMEOUT);

  test('should stop cleanly with adaptive sync', async () => {
    synchronizer = new HotForkSynchronizer({
      anvilManager,
      sourceProvider,
      syncIntervalMs: 100,
      adaptiveSync: true,
    });

    await synchronizer.start();
    expect(synchronizer.getState()).toBe('running');

    await synchronizer.stop();
    expect(synchronizer.getState()).toBe('stopped');

    // Should be able to stop multiple times without error
    await synchronizer.stop();
    expect(synchronizer.getState()).toBe('stopped');
  }, TEST_TIMEOUT);
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
});
