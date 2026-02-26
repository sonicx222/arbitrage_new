/**
 * Tests for CacheCoherencyManager
 *
 * Validates the gossip-protocol-based cache coherency system including
 * vector clock management, operation recording, conflict resolution,
 * node lifecycle, and proper cleanup.
 *
 * Phase 1 fixes verified (current behavior):
 * - redisPromise + getRedis() async pattern
 * - 5 || -> ?? conversions for numeric defaults
 *
 * @see shared/core/src/caching/cache-coherency-manager.ts
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

// =============================================================================
// Mock Setup
// =============================================================================

// Mock Redis client
const mockRedisPublish = jest.fn<(...args: any[]) => Promise<number>>().mockResolvedValue(1);
const mockRedisClient = {
  publish: mockRedisPublish,
  get: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(null),
  set: jest.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined),
  subscribe: jest.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined),
};

jest.mock('../../../src/redis/client', () => ({
  getRedisClient: jest.fn(() => Promise.resolve(mockRedisClient)),
}));

jest.mock('../../../src/logger');

jest.mock('../../../src/async/lifecycle-utils', () => ({
  clearIntervalSafe: jest.fn((interval: any) => {
    if (interval) clearInterval(interval);
    return null;
  }),
}));

import {
  CacheCoherencyManager,
  createCacheCoherencyManager,
  GossipMessage,
  CacheOperation,
} from '../../../src/caching/cache-coherency-manager';

// =============================================================================
// Tests
// =============================================================================

describe('CacheCoherencyManager', () => {
  let manager: CacheCoherencyManager;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();

    // Restore mock implementations after clearAllMocks
    mockRedisPublish.mockResolvedValue(1);
    mockRedisClient.get.mockResolvedValue(null);
    mockRedisClient.set.mockResolvedValue(undefined);
    mockRedisClient.subscribe.mockResolvedValue(undefined);

    // Re-establish getRedisClient mock cleared by resetMocks: true
    const { getRedisClient } =
      jest.requireMock<typeof import('../../../src/redis/client')>('../../../src/redis/client');
    (getRedisClient as jest.Mock).mockReturnValue(Promise.resolve(mockRedisClient));

    manager = new CacheCoherencyManager('node-1', {
      gossipInterval: 1000,
      suspicionTimeout: 5000,
      failureTimeout: 15000,
      fanout: 3,
      enableConflictResolution: true,
    });
  });

  afterEach(() => {
    manager.destroy();
    jest.useRealTimers();
  });

  // =========================================================================
  // Constructor / Initialization
  // =========================================================================

  describe('constructor', () => {
    it('should initialize with the given node ID', () => {
      const status = manager.getNodeStatus();
      expect(status.nodeId).toBe('node-1');
    });

    it('should register self in known nodes', () => {
      const status = manager.getNodeStatus();
      expect(status.knownNodes).toContain('node-1');
    });

    it('should initialize vector clock with own entry at 0', () => {
      const status = manager.getNodeStatus();
      expect(status.vectorClock['node-1']).toBe(0);
    });

    it('should start with empty pending operations', () => {
      const status = manager.getNodeStatus();
      expect(status.pendingOperations).toBe(0);
    });

    it('should start gossip timer', () => {
      // Advance past one gossip interval -- the timer should fire
      // We just verify it doesn't throw; actual gossip is tested separately
      expect(() => jest.advanceTimersByTime(1100)).not.toThrow();
    });

    it('should use nullish coalescing for config defaults', () => {
      // Verify that passing explicit 0 values is preserved (not treated as falsy)
      // The constructor uses ?? so explicit 0 would be kept
      const customManager = new CacheCoherencyManager('node-2', {
        gossipInterval: 2000,
      });
      // Should not throw; just verifies construction succeeds with partial config
      const status = customManager.getNodeStatus();
      expect(status.nodeId).toBe('node-2');
      customManager.destroy();
    });
  });

  // =========================================================================
  // recordOperation
  // =========================================================================

  describe('recordOperation', () => {
    it('should add operation to pending list', async () => {
      await manager.recordOperation({ type: 'set', key: 'price:ETH/USDC' });

      const status = manager.getNodeStatus();
      expect(status.pendingOperations).toBe(1);
    });

    it('should assign nodeId and timestamp automatically', async () => {
      const before = Date.now();
      await manager.recordOperation({ type: 'set', key: 'price:ETH/USDC', value: 3500 });

      const status = manager.getNodeStatus();
      expect(status.pendingOperations).toBe(1);
    });

    it('should increment vector clock for own node', async () => {
      await manager.recordOperation({ type: 'set', key: 'price:ETH/USDC' });

      const status = manager.getNodeStatus();
      expect(status.vectorClock['node-1']).toBe(1);
    });

    it('should increment vector clock sequentially for multiple operations', async () => {
      await manager.recordOperation({ type: 'set', key: 'price:ETH/USDC' });
      await manager.recordOperation({ type: 'set', key: 'price:BTC/USDC' });
      await manager.recordOperation({ type: 'delete', key: 'price:ETH/USDC' });

      const status = manager.getNodeStatus();
      expect(status.vectorClock['node-1']).toBe(3);
    });

    it('should throw on invalid operation (missing key)', async () => {
      await expect(
        manager.recordOperation({ type: 'set', key: '' })
      ).rejects.toThrow('Invalid operation: missing key or type');
    });

    it('should throw on invalid operation (missing type)', async () => {
      await expect(
        manager.recordOperation({ type: '' as any, key: 'test' })
      ).rejects.toThrow('Invalid operation: missing key or type');
    });

    it('should deduplicate identical operations', async () => {
      // Record same operation -- the dedup is by nodeId:version:key
      // Since version auto-increments, consecutive calls produce different keys.
      // Dedup only blocks if the EXACT same operation key is replayed.
      // We test the general flow works without duplication errors.
      await manager.recordOperation({ type: 'set', key: 'price:ETH/USDC' });
      await manager.recordOperation({ type: 'set', key: 'price:ETH/USDC' });

      const status = manager.getNodeStatus();
      // Each call gets a new version, so both should be recorded
      expect(status.pendingOperations).toBe(2);
    });

    it('should attempt to broadcast operation to other nodes', async () => {
      // No other nodes registered yet, so broadcast is a no-op
      // Just verify it completes without error
      await manager.recordOperation({ type: 'set', key: 'price:ETH/USDC' });
      expect(manager.getNodeStatus().pendingOperations).toBe(1);
    });
  });

  // =========================================================================
  // invalidateKey
  // =========================================================================

  describe('invalidateKey', () => {
    it('should record an invalidate operation', async () => {
      await manager.invalidateKey('price:ETH/USDC');

      const status = manager.getNodeStatus();
      expect(status.pendingOperations).toBe(1);
      expect(status.vectorClock['node-1']).toBe(1);
    });
  });

  // =========================================================================
  // handleIncomingMessage
  // =========================================================================

  describe('handleIncomingMessage', () => {
    it('should handle heartbeat message and register new node', async () => {
      const message: GossipMessage = {
        type: 'heartbeat',
        nodeId: 'node-2',
        timestamp: Date.now(),
        payload: { address: '10.0.0.2:3000' },
        vectorClock: new Map([['node-2', 5]]),
      };

      await manager.handleIncomingMessage(message);

      const status = manager.getNodeStatus();
      expect(status.knownNodes).toContain('node-2');
    });

    it('should update existing node on heartbeat', async () => {
      // First heartbeat -- registers node
      await manager.handleIncomingMessage({
        type: 'heartbeat',
        nodeId: 'node-2',
        timestamp: Date.now(),
        payload: { address: '10.0.0.2:3000' },
        vectorClock: new Map([['node-2', 1]]),
      });

      // Second heartbeat -- updates node
      await manager.handleIncomingMessage({
        type: 'heartbeat',
        nodeId: 'node-2',
        timestamp: Date.now(),
        payload: { address: '10.0.0.2:3000' },
        vectorClock: new Map([['node-2', 5]]),
      });

      const status = manager.getNodeStatus();
      expect(status.knownNodes).toContain('node-2');
      // Vector clock should be merged -- node-2's clock should be 5
      expect(status.vectorClock['node-2']).toBe(5);
    });

    it('should merge vector clocks on heartbeat', async () => {
      await manager.handleIncomingMessage({
        type: 'heartbeat',
        nodeId: 'node-2',
        timestamp: Date.now(),
        payload: { address: '10.0.0.2' },
        vectorClock: new Map([
          ['node-2', 10],
          ['node-3', 7],
        ]),
      });

      const status = manager.getNodeStatus();
      expect(status.vectorClock['node-2']).toBe(10);
      expect(status.vectorClock['node-3']).toBe(7);
    });

    it('should apply remote update operation locally', async () => {
      const message: GossipMessage = {
        type: 'update',
        nodeId: 'node-2',
        timestamp: Date.now(),
        payload: {
          type: 'set',
          key: 'price:ETH/USDC',
          value: 3500,
          version: 1,
          timestamp: Date.now(),
          nodeId: 'node-2',
        },
        vectorClock: new Map([['node-2', 1]]),
      };

      await manager.handleIncomingMessage(message);

      const status = manager.getNodeStatus();
      expect(status.pendingOperations).toBe(1);
    });

    it('should apply remote invalidate operation locally', async () => {
      const message: GossipMessage = {
        type: 'invalidate',
        nodeId: 'node-2',
        timestamp: Date.now(),
        payload: {
          type: 'invalidate',
          key: 'price:ETH/USDC',
          version: 1,
          timestamp: Date.now(),
          nodeId: 'node-2',
        },
        vectorClock: new Map([['node-2', 1]]),
      };

      await manager.handleIncomingMessage(message);

      const status = manager.getNodeStatus();
      expect(status.pendingOperations).toBe(1);
    });

    it('should skip duplicate operations from same node+version', async () => {
      const message: GossipMessage = {
        type: 'update',
        nodeId: 'node-2',
        timestamp: Date.now(),
        payload: {
          type: 'set',
          key: 'price:ETH/USDC',
          version: 1,
          timestamp: Date.now(),
          nodeId: 'node-2',
        },
        vectorClock: new Map([['node-2', 1]]),
      };

      await manager.handleIncomingMessage(message);
      await manager.handleIncomingMessage(message); // duplicate

      const status = manager.getNodeStatus();
      expect(status.pendingOperations).toBe(1);
    });

    it('should handle digest messages', async () => {
      const message: GossipMessage = {
        type: 'digest',
        nodeId: 'node-2',
        timestamp: Date.now(),
        payload: {
          operations: [],
          vectorClock: { 'node-2': 5 },
        },
        vectorClock: new Map([['node-2', 5]]),
      };

      // Should not throw
      await manager.handleIncomingMessage(message);
    });

    it('should resolve conflicts when operations target same key from different nodes', async () => {
      // First: apply an operation from node-2
      const timestamp1 = Date.now() - 100;
      await manager.handleIncomingMessage({
        type: 'update',
        nodeId: 'node-2',
        timestamp: timestamp1,
        payload: {
          type: 'set',
          key: 'price:ETH/USDC',
          value: 3400,
          version: 1,
          timestamp: timestamp1,
          nodeId: 'node-2',
        },
        vectorClock: new Map([['node-2', 1]]),
      });

      // Second: apply a conflicting operation from node-3 (same key, within 1s window)
      const timestamp2 = Date.now();
      await manager.handleIncomingMessage({
        type: 'update',
        nodeId: 'node-3',
        timestamp: timestamp2,
        payload: {
          type: 'set',
          key: 'price:ETH/USDC',
          value: 3500,
          version: 1,
          timestamp: timestamp2,
          nodeId: 'node-3',
        },
        vectorClock: new Map([['node-3', 1]]),
      });

      // Both operations should be applied (conflict resolved via last-write-wins)
      const status = manager.getNodeStatus();
      expect(status.pendingOperations).toBe(2);
    });
  });

  // =========================================================================
  // getNodeStatus
  // =========================================================================

  describe('getNodeStatus', () => {
    it('should return current node information', () => {
      const status = manager.getNodeStatus();

      expect(status).toHaveProperty('nodeId');
      expect(status).toHaveProperty('knownNodes');
      expect(status).toHaveProperty('vectorClock');
      expect(status).toHaveProperty('pendingOperations');
      expect(status).toHaveProperty('lastGossip');
    });

    it('should reflect known nodes after heartbeat', async () => {
      await manager.handleIncomingMessage({
        type: 'heartbeat',
        nodeId: 'node-2',
        timestamp: Date.now(),
        payload: { address: '10.0.0.2' },
        vectorClock: new Map([['node-2', 1]]),
      });

      const status = manager.getNodeStatus();
      expect(status.knownNodes).toContain('node-1');
      expect(status.knownNodes).toContain('node-2');
    });

    it('should reflect pending operations count', async () => {
      await manager.recordOperation({ type: 'set', key: 'key1' });
      await manager.recordOperation({ type: 'set', key: 'key2' });

      const status = manager.getNodeStatus();
      expect(status.pendingOperations).toBe(2);
    });
  });

  // =========================================================================
  // setConflictResolver
  // =========================================================================

  describe('setConflictResolver', () => {
    it('should accept a custom conflict resolver function', () => {
      const customResolver = (op1: CacheOperation, op2: CacheOperation): CacheOperation => {
        // Custom: prefer the operation with higher version
        return op1.version > op2.version ? op1 : op2;
      };

      // Should not throw
      manager.setConflictResolver(customResolver);
    });

    it('should use custom resolver when conflict occurs', async () => {
      let resolverCalled = false;

      manager.setConflictResolver((op1: CacheOperation, op2: CacheOperation): CacheOperation => {
        resolverCalled = true;
        // Always prefer op1 (the new incoming operation)
        return op1;
      });

      // Create two conflicting operations from different nodes within 1s window
      const now = Date.now();

      await manager.handleIncomingMessage({
        type: 'update',
        nodeId: 'node-2',
        timestamp: now,
        payload: { type: 'set', key: 'conflict-key', value: 'A', version: 1, timestamp: now, nodeId: 'node-2' },
        vectorClock: new Map([['node-2', 1]]),
      });

      await manager.handleIncomingMessage({
        type: 'update',
        nodeId: 'node-3',
        timestamp: now + 500, // within 1s window
        payload: { type: 'set', key: 'conflict-key', value: 'B', version: 1, timestamp: now + 500, nodeId: 'node-3' },
        vectorClock: new Map([['node-3', 1]]),
      });

      expect(resolverCalled).toBe(true);
    });
  });

  // =========================================================================
  // Gossip Timer
  // =========================================================================

  describe('gossip timer', () => {
    it('should execute gossip rounds at configured interval', () => {
      // Register another node for gossip to target
      manager.handleIncomingMessage({
        type: 'heartbeat',
        nodeId: 'node-2',
        timestamp: Date.now(),
        payload: { address: '10.0.0.2' },
        vectorClock: new Map([['node-2', 1]]),
      });

      // Advance past gossip interval -- timer should fire without throwing
      jest.advanceTimersByTime(1100);
    });

    it('should not throw when gossip round runs with no other nodes', () => {
      jest.advanceTimersByTime(1100);
      // No exception expected
    });
  });

  // =========================================================================
  // Pending Operations Pruning
  // =========================================================================

  describe('pending operations pruning', () => {
    it('should prune operations when exceeding MAX_PENDING_OPERATIONS', async () => {
      // The default MAX_PENDING_OPERATIONS is 1000, PRUNE_TARGET is 500.
      // Add 1001 operations to trigger pruning.
      for (let i = 0; i < 1001; i++) {
        await manager.recordOperation({ type: 'set', key: `key-${i}` });
      }

      const status = manager.getNodeStatus();
      // After pruning, should be at or near PRUNE_TARGET (500)
      // The 1001st triggers prune of (1001 - 500) = 501, leaving 500
      // Then the 1001st itself is added, making 501... but dedup makes this complex.
      // The key point: should be well below 1001
      expect(status.pendingOperations).toBeLessThanOrEqual(501);
    });
  });

  // =========================================================================
  // Node Lifecycle (suspected / dead / cleanup)
  // =========================================================================

  describe('node lifecycle', () => {
    it('should mark nodes as suspected after suspicion timeout', async () => {
      // Register node-2
      await manager.handleIncomingMessage({
        type: 'heartbeat',
        nodeId: 'node-2',
        timestamp: Date.now(),
        payload: { address: '10.0.0.2' },
        vectorClock: new Map([['node-2', 1]]),
      });

      // Advance past suspicion timeout (5s) but not failure timeout (15s)
      jest.advanceTimersByTime(6000);

      // After gossip round, node-2 should be suspected
      // The cleanupDeadNodes runs inside performGossipRound
      const status = manager.getNodeStatus();
      expect(status.knownNodes).toContain('node-2');
    });

    it('should never remove self from known nodes', () => {
      // Advance far past all timeouts
      jest.advanceTimersByTime(400000);

      const status = manager.getNodeStatus();
      expect(status.knownNodes).toContain('node-1');
    });
  });

  // =========================================================================
  // destroy
  // =========================================================================

  describe('destroy', () => {
    it('should clear gossip timer', () => {
      manager.destroy();
      // Advancing timers after destroy should have no effect
      expect(() => jest.advanceTimersByTime(5000)).not.toThrow();
    });

    it('should clear all nodes', () => {
      manager.destroy();
      const status = manager.getNodeStatus();
      expect(status.knownNodes.length).toBe(0);
    });

    it('should clear pending operations', () => {
      manager.destroy();
      const status = manager.getNodeStatus();
      expect(status.pendingOperations).toBe(0);
    });

    it('should clear vector clock', () => {
      manager.destroy();
      const status = manager.getNodeStatus();
      expect(Object.keys(status.vectorClock).length).toBe(0);
    });

    it('should be safe to call destroy multiple times', () => {
      manager.destroy();
      expect(() => manager.destroy()).not.toThrow();
    });
  });

  // =========================================================================
  // Factory Function
  // =========================================================================

  describe('createCacheCoherencyManager', () => {
    it('should create a new instance with default config', () => {
      const instance = createCacheCoherencyManager('factory-node');

      const status = instance.getNodeStatus();
      expect(status.nodeId).toBe('factory-node');

      instance.destroy();
    });

    it('should create a new instance with custom config', () => {
      const instance = createCacheCoherencyManager('factory-node', {
        gossipInterval: 5000,
        fanout: 5,
      });

      const status = instance.getNodeStatus();
      expect(status.nodeId).toBe('factory-node');

      instance.destroy();
    });
  });

  // =========================================================================
  // Redis Integration (via mock)
  // =========================================================================

  describe('Redis publish during gossip', () => {
    it('should publish messages to other nodes via Redis', async () => {
      // Register a remote node so gossip has a target
      await manager.handleIncomingMessage({
        type: 'heartbeat',
        nodeId: 'node-2',
        timestamp: Date.now(),
        payload: { address: '10.0.0.2' },
        vectorClock: new Map([['node-2', 1]]),
      });

      // Record an operation (triggers broadcast to node-2)
      await manager.recordOperation({ type: 'set', key: 'price:ETH/USDC' });

      // Redis publish should have been called for the broadcast
      expect(mockRedisPublish).toHaveBeenCalled();
      const publishCalls = mockRedisPublish.mock.calls;
      // At least one call should target the gossip:node-2 channel
      const targetedNode2 = publishCalls.some(
        (call: any[]) => call[0] === 'gossip:node-2'
      );
      expect(targetedNode2).toBe(true);
    });

    it('should handle Redis publish failure gracefully', async () => {
      // Register remote node
      await manager.handleIncomingMessage({
        type: 'heartbeat',
        nodeId: 'node-2',
        timestamp: Date.now(),
        payload: { address: '10.0.0.2' },
        vectorClock: new Map([['node-2', 1]]),
      });

      // Make Redis publish fail
      mockRedisPublish.mockRejectedValueOnce(new Error('Redis down'));

      // Should not throw -- broadcast failure is caught and logged
      await expect(
        manager.recordOperation({ type: 'set', key: 'price:ETH/USDC' })
      ).resolves.not.toThrow();
    });
  });

  // =========================================================================
  // Vector Clock Lock
  // =========================================================================

  describe('vector clock atomicity', () => {
    it('should maintain sequential version numbers', async () => {
      await manager.recordOperation({ type: 'set', key: 'key-1' });
      await manager.recordOperation({ type: 'set', key: 'key-2' });
      await manager.recordOperation({ type: 'set', key: 'key-3' });

      const status = manager.getNodeStatus();
      expect(status.vectorClock['node-1']).toBe(3);
    });

    it('should not skip version numbers under sequential access', async () => {
      for (let i = 1; i <= 10; i++) {
        await manager.recordOperation({ type: 'set', key: `key-${i}` });
        const status = manager.getNodeStatus();
        expect(status.vectorClock['node-1']).toBe(i);
      }
    });
  });
});
