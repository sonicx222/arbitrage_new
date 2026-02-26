/**
 * Shared types for SolanaDetector module decomposition.
 *
 * ARCH-REFACTOR: Extracted from solana-detector.ts to provide
 * shared types across all Solana detector modules.
 *
 * @see ADR-014: Modular Detector Components
 */

import type { Connection, Commitment, AccountInfo, Context } from '@solana/web3.js';
import type { ServiceLogger } from '../logging/types';

// Re-export ServiceLogger for convenience
export type { ServiceLogger };
export type { Connection, Commitment, AccountInfo, Context };

// =============================================================================
// Logger Interfaces (minimal DI)
// =============================================================================

/**
 * Logger interface for SolanaDetector modules.
 * Alias for ServiceLogger - kept for backward compatibility.
 */
export type SolanaDetectorLogger = ServiceLogger;

/**
 * Performance logger interface for SolanaDetector modules.
 * Minimal interface for dependency injection.
 * Parameter name `meta` (not `metadata`) matches IPerformanceLogger.logEventLatency.
 *
 * Uses Record<string, unknown> for status/meta parameters to remain compatible
 * with PerformanceLogger (which uses LogMeta = Record<string, unknown>).
 */
export interface SolanaDetectorPerfLogger {
  logHealthCheck: (service: string, status: Record<string, unknown>) => void;
  logEventLatency?: (operation: string, latency: number, meta?: Record<string, unknown>) => void;
  logArbitrageOpportunity?: (opportunity: Record<string, unknown>) => void;
}

// =============================================================================
// Redis DI Interfaces (minimal)
// =============================================================================

/**
 * Redis client interface for dependency injection.
 * Matches the subset of RedisClient methods used by SolanaDetector.
 */
export interface SolanaDetectorRedisClient {
  ping(): Promise<string>;
  disconnect(): Promise<void>;
  updateServiceHealth?(serviceName: string, status: Record<string, unknown>): Promise<void>;
}

/**
 * Redis streams client interface for dependency injection.
 */
export interface SolanaDetectorStreamsClient {
  disconnect(): Promise<void>;
  createBatcher(streamName: string, config: Record<string, unknown>): SolanaPriceUpdateBatcher;
}

/**
 * Batcher interface for price update batching.
 */
export interface SolanaPriceUpdateBatcher {
  add(message: Record<string, unknown>): void;
  destroy(): Promise<void>;
  getStats(): { currentQueueSize: number; batchesSent: number };
}

// =============================================================================
// Pool Types
// =============================================================================

/**
 * Solana token information in a pool.
 */
export interface SolanaTokenInfo {
  mint: string;
  symbol: string;
  decimals: number;
}

/**
 * Solana DEX pool information.
 */
export interface SolanaPool {
  address: string;
  programId: string;
  dex: string;
  token0: SolanaTokenInfo;
  token1: SolanaTokenInfo;
  fee: number; // In basis points (e.g., 25 = 0.25%)
  reserve0?: string;
  reserve1?: string;
  price?: number;
  lastSlot?: number;
  sqrtPriceX64?: string;
  liquidity?: string;
  tickCurrentIndex?: number;
}

// =============================================================================
// Price Update Types
// =============================================================================

/**
 * Solana-specific price update.
 */
export interface SolanaPriceUpdate {
  poolAddress: string;
  dex: string;
  token0: string;
  token1: string;
  price: number;
  reserve0: string;
  reserve1: string;
  slot: number;
  timestamp: number;
  sqrtPriceX64?: string;
  liquidity?: string;
  tickCurrentIndex?: number;
}

// =============================================================================
// Subscription Types
// =============================================================================

/**
 * Program subscription tracking.
 */
export interface ProgramSubscription {
  programId: string;
  subscriptionId: number;
  callback?: (accountInfo: AccountInfo<Buffer>, context: Context, accountId: string) => void;
}

// =============================================================================
// Connection Types
// =============================================================================

/**
 * Connection pool configuration.
 */
export interface ConnectionPoolConfig {
  size: number;
  connections: Connection[];
  currentIndex: number;
  healthStatus: boolean[];
  latencies: number[];
  failedRequests: number[];
  subscriptionConnections: Map<string, number>;
  reconnecting: boolean[];
  reconnectAttempts: number[];
}

/**
 * Connection metrics for monitoring.
 */
export interface ConnectionMetrics {
  totalConnections: number;
  healthyConnections: number;
  failedRequests: number;
  avgLatencyMs: number;
}

// =============================================================================
// Health Types
// =============================================================================

/**
 * Health status for the Solana detector.
 */
export interface SolanaDetectorHealth {
  service: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  memoryUsage: number;
  lastHeartbeat: number;
  connections: ConnectionMetrics;
  subscriptions: number;
  pools: number;
  slot: number;
}

// =============================================================================
// Config
// =============================================================================

/**
 * Configuration for SolanaDetector.
 */
export interface SolanaDetectorConfig {
  rpcUrl: string;
  wsUrl?: string;
  commitment?: Commitment;
  rpcFallbackUrls?: string[];
  wsFallbackUrls?: string[];
  healthCheckIntervalMs?: number;
  connectionPoolSize?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  minProfitThreshold?: number;
  opportunityExpiryMs?: number;
}

/**
 * Dependencies that can be injected into SolanaDetector.
 */
export interface SolanaDetectorDeps {
  logger?: SolanaDetectorLogger;
  perfLogger?: SolanaDetectorPerfLogger;
  redisClient?: SolanaDetectorRedisClient;
  streamsClient?: SolanaDetectorStreamsClient;
}

// =============================================================================
// Lifecycle Deps Pattern
// =============================================================================

/**
 * Lifecycle callbacks for modules that need to check detector state.
 */
export interface SolanaLifecycleDeps {
  isRunning: () => boolean;
  isStopping: () => boolean;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Default gas estimate for Solana DEX swaps.
 * Solana uses compute units (CU) instead of gas. Typical DEX swap: 200,000-400,000 CU.
 */
export const SOLANA_DEFAULT_GAS_ESTIMATE = '300000';

/**
 * Known Solana DEX Program IDs.
 */
export const SOLANA_DEX_PROGRAMS = {
  JUPITER: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  RAYDIUM_AMM: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  RAYDIUM_CLMM: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  ORCA_WHIRLPOOL: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  METEORA_DLMM: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  PHOENIX: 'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY',
  LIFINITY: '2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c'
} as const;
