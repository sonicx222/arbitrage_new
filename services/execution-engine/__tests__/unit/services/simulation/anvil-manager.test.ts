/**
 * AnvilForkManager Integration Tests
 *
 * Tests the Anvil fork manager with real connections.
 * Requires Anvil to be installed (from Foundry).
 *
 * Run with: npm test -- anvil-manager
 *
 * @see Phase 2: Pending-State Simulation Engine (Implementation Plan v3.0)
 * @see Task 2.3.1: Anvil Fork Manager
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from '@jest/globals';
import { ethers } from 'ethers';
import { execSync } from 'child_process';
import type { AnvilForkConfig } from '../../../../src/services/simulation/anvil-manager';
import { AnvilForkManager } from '../../../../src/services/simulation/anvil-manager';

// =============================================================================
// Test Configuration
// =============================================================================

// Use a free public RPC for testing
const TEST_RPC_URL = process.env.ETH_RPC_URL || 'https://eth.llamarpc.com';
const TEST_TIMEOUT = 60000; // 60 seconds for integration tests

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

const createTestConfig = (port: number): AnvilForkConfig => ({
  rpcUrl: TEST_RPC_URL,
  chain: 'ethereum',
  port,
  autoStart: false,
});

// Generate unique port for each test to avoid conflicts
const getUniquePort = () => 8545 + Math.floor(Math.random() * 1000);

// =============================================================================
// Unit Tests (no Anvil required)
// =============================================================================

describe('AnvilForkManager - Unit Tests', () => {
  let manager: AnvilForkManager;

  afterEach(async () => {
    if (manager) {
      await manager.shutdown();
    }
  });

  describe('constructor', () => {
    test('should initialize with valid config', () => {
      manager = new AnvilForkManager(createTestConfig(getUniquePort()));
      expect(manager).toBeDefined();
      expect(manager.getState()).toBe('stopped');
    });

    test('should default to stopped state', () => {
      manager = new AnvilForkManager(createTestConfig(getUniquePort()));
      expect(manager.getState()).toBe('stopped');
    });

    test('should accept custom port', () => {
      manager = new AnvilForkManager(createTestConfig(9999));
      expect(manager).toBeDefined();
    });

    test('should accept fork block number', () => {
      const config = { ...createTestConfig(getUniquePort()), forkBlockNumber: 18000000 };
      manager = new AnvilForkManager(config);
      expect(manager).toBeDefined();
    });
  });

  describe('getState', () => {
    test('should return stopped before start', () => {
      manager = new AnvilForkManager(createTestConfig(getUniquePort()));
      expect(manager.getState()).toBe('stopped');
    });
  });

  describe('getProvider', () => {
    test('should return null when not running', () => {
      manager = new AnvilForkManager(createTestConfig(getUniquePort()));
      expect(manager.getProvider()).toBeNull();
    });
  });

  describe('getForkInfo', () => {
    test('should throw when not running', () => {
      manager = new AnvilForkManager(createTestConfig(getUniquePort()));
      expect(() => manager.getForkInfo()).toThrow(/not running/i);
    });
  });

  describe('operations when stopped', () => {
    test('resetToBlock should throw when not running', async () => {
      manager = new AnvilForkManager(createTestConfig(getUniquePort()));
      await expect(manager.resetToBlock(18000000)).rejects.toThrow(/not running/i);
    });

    test('applyPendingTx should throw when not running', async () => {
      manager = new AnvilForkManager(createTestConfig(getUniquePort()));
      await expect(manager.applyPendingTx('0x...')).rejects.toThrow(/not running/i);
    });

    test('getPoolReserves should throw when not running', async () => {
      manager = new AnvilForkManager(createTestConfig(getUniquePort()));
      await expect(manager.getPoolReserves('0x...')).rejects.toThrow(/not running/i);
    });

    test('createSnapshot should throw when not running', async () => {
      manager = new AnvilForkManager(createTestConfig(getUniquePort()));
      await expect(manager.createSnapshot()).rejects.toThrow(/not running/i);
    });

    test('revertToSnapshot should throw when not running', async () => {
      manager = new AnvilForkManager(createTestConfig(getUniquePort()));
      await expect(manager.revertToSnapshot('0x1')).rejects.toThrow(/not running/i);
    });
  });

  describe('health and metrics', () => {
    test('should return initial health status', () => {
      manager = new AnvilForkManager(createTestConfig(getUniquePort()));
      const health = manager.getHealth();
      expect(health.healthy).toBe(false);
      expect(health.processRunning).toBe(false);
    });

    test('should return initial metrics', () => {
      manager = new AnvilForkManager(createTestConfig(getUniquePort()));
      const metrics = manager.getMetrics();
      expect(metrics.totalSimulations).toBe(0);
      expect(metrics.successfulSimulations).toBe(0);
      expect(metrics.failedSimulations).toBe(0);
    });
  });

  describe('shutdown', () => {
    test('should be idempotent (safe to call multiple times)', async () => {
      manager = new AnvilForkManager(createTestConfig(getUniquePort()));
      await manager.shutdown();
      await manager.shutdown();
      expect(manager.getState()).toBe('stopped');
    });
  });
});

// =============================================================================
// Integration Tests (requires Anvil)
// =============================================================================

const describeIntegration = anvilAvailable ? describe : describe.skip;

describeIntegration('AnvilForkManager - Integration Tests', () => {
  let manager: AnvilForkManager;
  let testPort: number;

  beforeAll(() => {
    testPort = getUniquePort();
  });

  afterEach(async () => {
    if (manager) {
      await manager.shutdown();
    }
  });

  describe('startFork', () => {
    test('should start Anvil process successfully', async () => {
      manager = new AnvilForkManager(createTestConfig(testPort));
      await manager.startFork(30000);

      expect(manager.getState()).toBe('running');
      expect(manager.getProvider()).not.toBeNull();

      const health = manager.getHealth();
      expect(health.healthy).toBe(true);
      expect(health.processRunning).toBe(true);
    }, TEST_TIMEOUT);

    test('should return fork info when running', async () => {
      manager = new AnvilForkManager(createTestConfig(testPort + 1));
      await manager.startFork(30000);

      const info = manager.getForkInfo();
      expect(info.rpcUrl).toContain('127.0.0.1');
      expect(info.chainId).toBe(1);
      expect(info.blockNumber).toBeGreaterThan(0);
    }, TEST_TIMEOUT);
  });

  describe('getPoolReserves', () => {
    test('should return reserves for Uniswap V2 ETH/USDT pool', async () => {
      manager = new AnvilForkManager(createTestConfig(testPort + 2));
      await manager.startFork(30000);

      // ETH/USDT Uniswap V2 pool
      const poolAddress = '0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852';
      const [reserve0, reserve1] = await manager.getPoolReserves(poolAddress);

      expect(reserve0).toBeGreaterThan(0n);
      expect(reserve1).toBeGreaterThan(0n);
    }, TEST_TIMEOUT);
  });

  describe('snapshots', () => {
    test('should create and revert snapshots', async () => {
      manager = new AnvilForkManager(createTestConfig(testPort + 3));
      await manager.startFork(30000);

      const snapshotId = await manager.createSnapshot();
      expect(snapshotId).toBeDefined();
      expect(snapshotId.startsWith('0x')).toBe(true);

      await manager.revertToSnapshot(snapshotId);
      // Should not throw
    }, TEST_TIMEOUT);
  });

  describe('resetToBlock', () => {
    test('should reset fork to earlier block', async () => {
      manager = new AnvilForkManager(createTestConfig(testPort + 4));
      await manager.startFork(30000);

      const provider = manager.getProvider()!;
      const currentBlock = await provider.getBlockNumber();

      // Reset to 100 blocks earlier
      const targetBlock = currentBlock - 100;
      await manager.resetToBlock(targetBlock);

      const info = manager.getForkInfo();
      expect(info.blockNumber).toBe(targetBlock);
    }, TEST_TIMEOUT);
  });

  describe('shutdown', () => {
    test('should cleanup properly after running', async () => {
      manager = new AnvilForkManager(createTestConfig(testPort + 5));
      await manager.startFork(30000);
      expect(manager.getState()).toBe('running');

      await manager.shutdown();
      expect(manager.getState()).toBe('stopped');
      expect(manager.getProvider()).toBeNull();
    }, TEST_TIMEOUT);
  });
});
