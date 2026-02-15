/**
 * Solana Connection Pool
 *
 * ARCH-REFACTOR: Extracted from solana-detector.ts
 * Manages Solana RPC connections with round-robin selection,
 * health tracking, and reconnection with exponential backoff.
 *
 * No mutex needed — connection pool operations are synchronous
 * (round-robin index, health status array). The reconnecting[]
 * boolean array provides per-index concurrency guard.
 *
 * @see ADR-014: Modular Detector Components
 */

import { Connection } from '@solana/web3.js';
import type {
  SolanaDetectorLogger,
  ConnectionMetrics,
  Commitment,
  SolanaLifecycleDeps,
} from './solana-types';

// =============================================================================
// Public Interface
// =============================================================================

export interface SolanaConnectionPool {
  getConnection(): Connection;
  getConnectionWithIndex(): { connection: Connection; index: number };
  getConnectionByIndex(index: number): Connection;
  markConnectionFailed(index: number): Promise<void>;
  getMetrics(avgLatencyMs: number): ConnectionMetrics;
  getPoolSize(): number;
  getActiveCount(): number;
  getHealthyCount(): number;
  /** Clear all connections and tracking. */
  cleanup(): void;
}

export interface ConnectionPoolInitConfig {
  rpcUrl: string;
  wsUrl: string;
  commitment: Commitment;
  rpcFallbackUrls: string[];
  poolSize: number;
  retryDelayMs: number;
}

export interface ConnectionPoolDeps {
  logger: SolanaDetectorLogger;
  lifecycle: SolanaLifecycleDeps;
  /** Called after a connection at the given index is replaced during reconnection. */
  onConnectionReplaced?: (index: number) => void;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create and initialize a Solana connection pool.
 * Validates the first connection by calling getSlot().
 *
 * @param config - Connection pool configuration
 * @param deps - Dependencies
 * @returns Promise resolving to the connection pool and initial slot
 */
export async function createSolanaConnectionPool(
  config: ConnectionPoolInitConfig,
  deps: ConnectionPoolDeps
): Promise<{ pool: SolanaConnectionPool; initialSlot: number }> {
  const { logger, lifecycle } = deps;
  const allRpcUrls = [config.rpcUrl, ...config.rpcFallbackUrls];

  // Private state
  const connections: Connection[] = [];
  const healthStatus: boolean[] = [];
  const failedRequests: number[] = [];
  const reconnecting: boolean[] = [];
  const reconnectAttempts: number[] = [];
  const reconnectTimers: (NodeJS.Timeout | null)[] = [];
  let currentIndex = 0;

  // Create connections — distribute across available URLs
  for (let i = 0; i < config.poolSize; i++) {
    const urlIndex = i % allRpcUrls.length;
    const rpcUrl = allRpcUrls[urlIndex];

    const connection = new Connection(rpcUrl, {
      commitment: config.commitment,
      wsEndpoint: config.wsUrl
    });

    connections.push(connection);
    healthStatus.push(true);
    failedRequests.push(0);
    reconnecting.push(false);
    reconnectAttempts.push(0);
    reconnectTimers.push(null);
  }

  // Validate first connection
  const initialSlot = await connections[0].getSlot();

  logger.info('Connection pool initialized', {
    size: config.poolSize,
    initialSlot
  });

  // ── Internal helpers ──

  function getConnectionWithIndex(): { connection: Connection; index: number } {
    if (connections.length === 0) {
      throw new Error('Connection pool is empty - detector may not be started');
    }

    // Try to find a healthy connection starting from current index
    const startIndex = currentIndex;
    let attempts = 0;

    while (attempts < connections.length) {
      const index = (startIndex + attempts) % connections.length;
      if (healthStatus[index]) {
        currentIndex = (index + 1) % connections.length;
        return { connection: connections[index], index };
      }
      attempts++;
    }

    // Fallback to round-robin if no healthy connections
    const index = currentIndex;
    const conn = connections[index];
    currentIndex = (index + 1) % connections.length;
    return { connection: conn, index };
  }

  function getConnection(): Connection {
    return getConnectionWithIndex().connection;
  }

  function getConnectionByIndex(index: number): Connection {
    if (index < 0 || index >= connections.length) {
      throw new Error(`Invalid connection index: ${index}`);
    }
    return connections[index];
  }

  async function markConnectionFailed(index: number): Promise<void> {
    if (index >= 0 && index < connections.length) {
      healthStatus[index] = false;
      failedRequests[index]++;

      logger.warn('Connection marked as failed', {
        index,
        failedRequests: failedRequests[index]
      });

      // Schedule reconnection attempt
      reconnectTimers[index] = setTimeout(() => attemptReconnection(index), config.retryDelayMs);
    }
  }

  async function attemptReconnection(index: number): Promise<void> {
    if (lifecycle.isStopping() || !lifecycle.isRunning()) return;

    // Clear any existing timer for this index
    if (reconnectTimers[index]) {
      clearTimeout(reconnectTimers[index]!);
      reconnectTimers[index] = null;
    }

    // Per-index guard prevents concurrent reconnection
    if (reconnecting[index]) {
      logger.debug('Reconnection already in progress', { index });
      return;
    }

    reconnecting[index] = true;

    try {
      const urlIndex = index % allRpcUrls.length;
      const rpcUrl = allRpcUrls[urlIndex];

      const connection = new Connection(rpcUrl, {
        commitment: config.commitment,
        wsEndpoint: config.wsUrl
      });

      // Test the connection
      await connection.getSlot();

      // Replace the failed connection
      connections[index] = connection;
      healthStatus[index] = true;
      reconnectAttempts[index] = 0;

      logger.info('Connection reconnected successfully', { index });

      // Notify consumers so they can resubscribe on the new connection
      deps.onConnectionReplaced?.(index);
    } catch (error) {
      const attempts = reconnectAttempts[index]++;
      const cappedAttempts = Math.min(attempts, 5);
      const backoffDelay = config.retryDelayMs * Math.pow(2, cappedAttempts);

      logger.warn('Reconnection attempt failed', {
        index,
        attempt: attempts + 1,
        nextDelayMs: backoffDelay,
        error
      });
      reconnectTimers[index] = setTimeout(() => attemptReconnection(index), backoffDelay);
    } finally {
      reconnecting[index] = false;
    }
  }

  function getMetrics(avgLatencyMs: number): ConnectionMetrics {
    const healthyCount = healthStatus.filter(h => h).length;
    const totalFailed = failedRequests.reduce((a, b) => a + b, 0);

    return {
      totalConnections: connections.length,
      healthyConnections: healthyCount,
      failedRequests: totalFailed,
      avgLatencyMs
    };
  }

  function getPoolSize(): number {
    return connections.length;
  }

  function getActiveCount(): number {
    return connections.length;
  }

  function getHealthyCount(): number {
    return healthStatus.filter(h => h).length;
  }

  function cleanup(): void {
    reconnectTimers.forEach(t => { if (t) clearTimeout(t); });
    reconnectTimers.length = 0;
    connections.length = 0;
    healthStatus.length = 0;
    failedRequests.length = 0;
    reconnecting.length = 0;
    reconnectAttempts.length = 0;
  }

  const pool: SolanaConnectionPool = {
    getConnection,
    getConnectionWithIndex,
    getConnectionByIndex,
    markConnectionFailed,
    getMetrics,
    getPoolSize,
    getActiveCount,
    getHealthyCount,
    cleanup,
  };

  return { pool, initialSlot };
}
