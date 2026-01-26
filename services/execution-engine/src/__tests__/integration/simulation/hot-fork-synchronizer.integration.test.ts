/**
 * HotForkSynchronizer Integration Tests
 *
 * Tests the hot fork synchronization with real Anvil instance.
 * Requires Anvil (Foundry) to be installed.
 *
 * Run with: npm run test:integration -- hot-fork-synchronizer
 *
 * @see Phase 2: Pending-State Simulation Engine (Implementation Plan v3.0)
 * @see Task 2.3.2: Hot Fork Synchronization
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from '@jest/globals';
import { execSync } from 'child_process';
import { ethers } from 'ethers';
import { HotForkSynchronizer } from '../../../services/simulation/hot-fork-synchronizer';
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

  test('should update average latency metric', async () => {
    synchronizer = new HotForkSynchronizer({
      anvilManager,
      sourceProvider,
      syncIntervalMs: 50,
    });

    await synchronizer.start();

    // Wait for multiple syncs
    await new Promise((resolve) => setTimeout(resolve, 300));

    const metrics = synchronizer.getMetrics();
    expect(metrics.successfulSyncs).toBeGreaterThan(0);
    expect(metrics.averageSyncLatencyMs).toBeGreaterThan(0);
  }, TEST_TIMEOUT);
});

// =============================================================================
// Success Criteria Tests (Phase 2 Section 2.4)
// =============================================================================

describeIntegration('HotForkSynchronizer - Success Criteria (2.4)', () => {
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

  /**
   * Success Criteria 2.4: Reserve prediction accuracy >95% vs actual post-block state
   *
   * This test verifies that the sync operation correctly updates to the latest block,
   * which is essential for accurate reserve prediction.
   */
  test('should maintain sync accuracy with source chain', async () => {
    synchronizer = new HotForkSynchronizer({
      anvilManager,
      sourceProvider,
      syncIntervalMs: 100,
    });

    await synchronizer.start();

    // Wait for initial sync
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Get the last synced block from synchronizer
    const syncedBlock = synchronizer.getLastSyncedBlock();

    // Get the actual latest block from source
    const sourceBlock = await sourceProvider.getBlockNumber();

    // The synced block should be close to the source block (within 2 blocks)
    // This accounts for network latency and block production during test
    expect(Math.abs(sourceBlock - syncedBlock)).toBeLessThanOrEqual(2);

    const metrics = synchronizer.getMetrics();
    // Success rate should be high
    const successRate = metrics.successfulSyncs / metrics.totalSyncs;
    expect(successRate).toBeGreaterThanOrEqual(0.95);
  }, TEST_TIMEOUT);

  /**
   * Success Criteria 2.4: Low latency sync operations
   *
   * Tests that average sync latency stays reasonable.
   */
  test('should maintain low average sync latency', async () => {
    synchronizer = new HotForkSynchronizer({
      anvilManager,
      sourceProvider,
      syncIntervalMs: 100,
    });

    await synchronizer.start();

    // Wait for multiple syncs
    await new Promise((resolve) => setTimeout(resolve, 500));

    const metrics = synchronizer.getMetrics();
    // Average latency should be reasonable (< 500ms for sync operations)
    expect(metrics.averageSyncLatencyMs).toBeLessThan(500);
    expect(metrics.successfulSyncs).toBeGreaterThan(3);
  }, TEST_TIMEOUT);
});
