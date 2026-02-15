/**
 * Solana Connection Pool Unit Tests
 *
 * Tests for connection creation, round-robin selection,
 * health tracking, failure marking, and reconnection.
 */

import { createSolanaConnectionPool, type SolanaConnectionPool } from '../../../src/solana/solana-connection-pool';
import { createMockLogger, createMockLifecycle } from './solana-test-helpers';

// Mock @solana/web3.js Connection
const mockGetSlot = jest.fn().mockResolvedValue(200000000);
const mockOnProgramAccountChange = jest.fn().mockReturnValue(1);
const mockRemoveProgramAccountChangeListener = jest.fn().mockResolvedValue(undefined);

jest.mock('@solana/web3.js', () => ({
  Connection: jest.fn().mockImplementation(() => ({
    getSlot: mockGetSlot,
    onProgramAccountChange: mockOnProgramAccountChange,
    removeProgramAccountChangeListener: mockRemoveProgramAccountChangeListener,
    rpcEndpoint: 'https://api.mainnet-beta.solana.com'
  }))
}));

const { Connection: MockConnection } = require('@solana/web3.js');

describe('SolanaConnectionPool', () => {
  let logger: ReturnType<typeof createMockLogger>;
  let lifecycle: ReturnType<typeof createMockLifecycle>;
  const baseConfig = {
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    wsUrl: 'wss://api.mainnet-beta.solana.com',
    commitment: 'confirmed' as const,
    rpcFallbackUrls: ['https://fallback1.solana.com'],
    poolSize: 3,
    retryDelayMs: 1000
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    logger = createMockLogger();
    lifecycle = createMockLifecycle();
    mockGetSlot.mockResolvedValue(200000000);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // =========================================================================
  // Factory initialization
  // =========================================================================

  describe('factory initialization', () => {
    it('should create pool and return initial slot', async () => {
      const { pool, initialSlot } = await createSolanaConnectionPool(baseConfig, { logger, lifecycle });

      expect(initialSlot).toBe(200000000);
      expect(pool.getPoolSize()).toBe(3);
      expect(pool.getHealthyCount()).toBe(3);
    });

    it('should create connections with round-robin URL distribution', async () => {
      await createSolanaConnectionPool(baseConfig, { logger, lifecycle });

      // poolSize=3, 2 URLs -> indices 0,1,0 -> URLs[0], URLs[1], URLs[0]
      expect(MockConnection).toHaveBeenCalledTimes(3);
      expect(MockConnection).toHaveBeenNthCalledWith(1, baseConfig.rpcUrl, expect.any(Object));
      expect(MockConnection).toHaveBeenNthCalledWith(2, baseConfig.rpcFallbackUrls[0], expect.any(Object));
      expect(MockConnection).toHaveBeenNthCalledWith(3, baseConfig.rpcUrl, expect.any(Object));
    });

    it('should throw when initial getSlot fails', async () => {
      mockGetSlot.mockRejectedValueOnce(new Error('RPC error'));

      await expect(createSolanaConnectionPool(baseConfig, { logger, lifecycle }))
        .rejects.toThrow('RPC error');
    });

    it('should log initialization with pool size and initial slot', async () => {
      await createSolanaConnectionPool(baseConfig, { logger, lifecycle });

      expect(logger.info).toHaveBeenCalledWith('Connection pool initialized', {
        size: 3,
        initialSlot: 200000000
      });
    });
  });

  // =========================================================================
  // getConnection / getConnectionWithIndex
  // =========================================================================

  describe('getConnection', () => {
    it('should round-robin through connections', async () => {
      const { pool } = await createSolanaConnectionPool(baseConfig, { logger, lifecycle });

      const first = pool.getConnectionWithIndex();
      const second = pool.getConnectionWithIndex();
      const third = pool.getConnectionWithIndex();
      const fourth = pool.getConnectionWithIndex(); // wraps around

      expect(first.index).toBe(0);
      expect(second.index).toBe(1);
      expect(third.index).toBe(2);
      expect(fourth.index).toBe(0);
    });

    it('should skip unhealthy connections', async () => {
      const { pool } = await createSolanaConnectionPool(baseConfig, { logger, lifecycle });

      // Mark connection 0 as failed
      await pool.markConnectionFailed(0);

      // Should skip index 0 and return index 1
      const result = pool.getConnectionWithIndex();
      expect(result.index).toBe(1);
    });

    it('should fallback to round-robin when all connections unhealthy', async () => {
      const { pool } = await createSolanaConnectionPool(baseConfig, { logger, lifecycle });

      // Mark all as failed
      await pool.markConnectionFailed(0);
      await pool.markConnectionFailed(1);
      await pool.markConnectionFailed(2);

      // Should still return a connection (fallback)
      const result = pool.getConnectionWithIndex();
      expect(result.connection).toBeDefined();
    });

    it('should throw when pool is empty (after cleanup)', async () => {
      const { pool } = await createSolanaConnectionPool(baseConfig, { logger, lifecycle });
      pool.cleanup();

      expect(() => pool.getConnection()).toThrow('Connection pool is empty');
    });
  });

  // =========================================================================
  // getConnectionByIndex
  // =========================================================================

  describe('getConnectionByIndex', () => {
    it('should return connection at specified index', async () => {
      const { pool } = await createSolanaConnectionPool(baseConfig, { logger, lifecycle });
      const conn = pool.getConnectionByIndex(1);
      expect(conn).toBeDefined();
    });

    it('should throw for negative index', async () => {
      const { pool } = await createSolanaConnectionPool(baseConfig, { logger, lifecycle });
      expect(() => pool.getConnectionByIndex(-1)).toThrow('Invalid connection index: -1');
    });

    it('should throw for out-of-range index', async () => {
      const { pool } = await createSolanaConnectionPool(baseConfig, { logger, lifecycle });
      expect(() => pool.getConnectionByIndex(10)).toThrow('Invalid connection index: 10');
    });
  });

  // =========================================================================
  // markConnectionFailed
  // =========================================================================

  describe('markConnectionFailed', () => {
    it('should mark connection as unhealthy', async () => {
      const { pool } = await createSolanaConnectionPool(baseConfig, { logger, lifecycle });

      await pool.markConnectionFailed(0);
      expect(pool.getHealthyCount()).toBe(2);
    });

    it('should log warning with index and failed count', async () => {
      const { pool } = await createSolanaConnectionPool(baseConfig, { logger, lifecycle });

      await pool.markConnectionFailed(1);
      expect(logger.warn).toHaveBeenCalledWith('Connection marked as failed', {
        index: 1,
        failedRequests: 1
      });
    });

    it('should schedule reconnection attempt', async () => {
      const { pool } = await createSolanaConnectionPool(baseConfig, { logger, lifecycle });

      await pool.markConnectionFailed(0);

      // Advance past retryDelayMs
      mockGetSlot.mockResolvedValue(200000001);
      jest.advanceTimersByTime(baseConfig.retryDelayMs + 100);

      // Allow async reconnection to run
      await jest.runAllTimersAsync();

      expect(pool.getHealthyCount()).toBe(3);
    });

    it('should be a no-op for out-of-range index', async () => {
      const { pool } = await createSolanaConnectionPool(baseConfig, { logger, lifecycle });

      await pool.markConnectionFailed(99);
      expect(pool.getHealthyCount()).toBe(3);
    });

    it('should not reconnect when stopping', async () => {
      const { pool } = await createSolanaConnectionPool(baseConfig, { logger, lifecycle });

      await pool.markConnectionFailed(0);
      lifecycle.isStopping.mockReturnValue(true);
      lifecycle.isRunning.mockReturnValue(false);

      await jest.advanceTimersByTimeAsync(baseConfig.retryDelayMs + 100);

      // Should still be unhealthy since reconnection was skipped
      expect(pool.getHealthyCount()).toBe(2);
    });
  });

  // =========================================================================
  // getMetrics
  // =========================================================================

  describe('getMetrics', () => {
    it('should return correct metrics', async () => {
      const { pool } = await createSolanaConnectionPool(baseConfig, { logger, lifecycle });

      const metrics = pool.getMetrics(42);
      expect(metrics).toEqual({
        totalConnections: 3,
        healthyConnections: 3,
        failedRequests: 0,
        avgLatencyMs: 42
      });
    });

    it('should reflect failed connections in metrics', async () => {
      const { pool } = await createSolanaConnectionPool(baseConfig, { logger, lifecycle });

      await pool.markConnectionFailed(0);
      await pool.markConnectionFailed(1);

      const metrics = pool.getMetrics(100);
      expect(metrics.healthyConnections).toBe(1);
      expect(metrics.failedRequests).toBe(2);
    });
  });

  // =========================================================================
  // cleanup
  // =========================================================================

  describe('cleanup', () => {
    it('should clear all connections and tracking arrays', async () => {
      const { pool } = await createSolanaConnectionPool(baseConfig, { logger, lifecycle });

      pool.cleanup();

      expect(pool.getPoolSize()).toBe(0);
      expect(pool.getActiveCount()).toBe(0);
      expect(pool.getHealthyCount()).toBe(0);
    });

    it('should cancel pending reconnection timers on cleanup', async () => {
      const { pool } = await createSolanaConnectionPool(baseConfig, { logger, lifecycle });

      // Fail a connection to schedule a reconnection timer
      mockGetSlot.mockRejectedValue(new Error('RPC error'));
      await pool.markConnectionFailed(0);

      // Cleanup should cancel the timer
      pool.cleanup();

      // Advance time past the retry delay — if timer wasn't cancelled,
      // attemptReconnection would fire against empty arrays
      await jest.advanceTimersByTimeAsync(baseConfig.retryDelayMs * 10);

      // Pool should stay empty (cleanup was clean, no post-cleanup activity)
      expect(pool.getPoolSize()).toBe(0);
    });
  });

  // =========================================================================
  // REGRESSION: onConnectionReplaced callback
  // =========================================================================

  describe('REGRESSION: onConnectionReplaced callback', () => {
    it('should call onConnectionReplaced after successful reconnection', async () => {
      const onConnectionReplaced = jest.fn();
      const { pool } = await createSolanaConnectionPool(baseConfig, {
        logger,
        lifecycle,
        onConnectionReplaced
      });

      // Fail connection 0, then let it reconnect successfully
      await pool.markConnectionFailed(0);
      mockGetSlot.mockResolvedValue(200000001);
      await jest.runAllTimersAsync();

      expect(onConnectionReplaced).toHaveBeenCalledWith(0);
    });

    it('should not call onConnectionReplaced on failed reconnection', async () => {
      const onConnectionReplaced = jest.fn();
      const { pool } = await createSolanaConnectionPool(baseConfig, {
        logger,
        lifecycle,
        onConnectionReplaced
      });

      // Fail connection 0 and make reconnection also fail
      mockGetSlot.mockRejectedValue(new Error('Still failing'));
      await pool.markConnectionFailed(0);
      await jest.advanceTimersByTimeAsync(baseConfig.retryDelayMs + 100);

      expect(onConnectionReplaced).not.toHaveBeenCalled();
    });
  });
});
