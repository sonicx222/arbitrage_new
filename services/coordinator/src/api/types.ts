/**
 * API Types for Coordinator Service
 *
 * Defines interfaces for route handlers to access coordinator state.
 * Enables extraction of routes while maintaining type safety.
 *
 * @see coordinator.ts (main service)
 */

import type { ServiceHealth, ArbitrageOpportunity } from '@arbitrage/types';

// =============================================================================
// Alert Types (consolidated - single source of truth)
// =============================================================================

/**
 * Alert severity levels.
 * R2: Added 'warning' for stream consumer alerts
 */
export type AlertSeverity = 'low' | 'warning' | 'high' | 'critical';

/**
 * Alert structure - used throughout coordinator, notifier, and API responses.
 * FIX: Consolidated from duplicate definitions in coordinator.ts and alerts/notifier.ts
 */
export interface Alert {
  type: string;
  service?: string;
  message?: string;
  severity?: AlertSeverity;
  data?: Record<string, unknown>;
  timestamp: number;
}

// FIX: Removed deprecated AlertResponse alias - use Alert directly
// Migration: Replace AlertResponse with Alert in all consuming code

// =============================================================================
// System Metrics (extracted from coordinator.ts)
// =============================================================================

/**
 * System-wide metrics tracked by the coordinator.
 */
export interface SystemMetrics {
  totalOpportunities: number;
  totalExecutions: number;
  successfulExecutions: number;
  totalProfit: number;
  averageLatency: number;
  averageMemory: number;
  systemHealth: number;
  activeServices: number;
  lastUpdate: number;
  whaleAlerts: number;
  pendingOpportunities: number;
  // Volume and swap event metrics (S1.2 - Swap Event Filter)
  totalSwapEvents: number;
  totalVolumeUsd: number;
  volumeAggregatesProcessed: number;
  activePairsTracked: number;
  // Price feed metrics (S3.3.5 - Solana Price Feed Integration)
  priceUpdatesReceived: number;
  // P1-7 FIX: Track dropped opportunities for monitoring
  opportunitiesDropped: number;
}

// =============================================================================
// State Provider Interface
// =============================================================================

/**
 * Interface for coordinator state that routes need to access.
 * Implemented by CoordinatorService to provide state to extracted routes.
 *
 * This enables:
 * - Routes to be extracted to separate files
 * - Type-safe access to coordinator state
 * - Easy testing with mock state providers
 */
export interface CoordinatorStateProvider {
  /** Whether this instance is the leader */
  getIsLeader(): boolean;

  /** Whether this coordinator is currently running */
  getIsRunning(): boolean;

  /** Instance ID for this coordinator */
  getInstanceId(): string;

  /** Leader election lock key */
  getLockKey(): string;

  /** Current system metrics */
  getSystemMetrics(): SystemMetrics;

  /** Map of service name to health status */
  getServiceHealthMap(): Map<string, ServiceHealth>;

  /** Map of opportunity ID to opportunity */
  getOpportunities(): Map<string, ArbitrageOpportunity>;

  /** Map of alert key to last alert timestamp (for cooldowns) */
  getAlertCooldowns(): Map<string, number>;

  /** Delete an alert cooldown entry, returns true if deleted */
  deleteAlertCooldown(key: string): boolean;

  /** Logger for route handlers */
  getLogger(): MinimalLogger;

  /** Get alert history for /api/alerts endpoint */
  getAlertHistory(limit?: number): Alert[];
}

// ===========================================================================
// P3-004 FIX: Consolidated Logger Interfaces with Clear Naming
// ===========================================================================

/**
 * Minimal logger interface for route handlers and external-facing code.
 *
 * The debug method is optional because HTTP routes typically only need
 * info/warn/error for user-facing operations. Use this for:
 * - Express route handlers
 * - Middleware functions
 * - External API integrations
 *
 * Use `object` instead of `unknown` for meta because:
 * - Meta should always be a key-value structure (not primitives)
 * - Provides better type safety for structured logging
 * - Consistent with winston/pino logger signatures
 */
export interface MinimalLogger {
  info: (message: string, meta?: object) => void;
  error: (message: string, meta?: object) => void;
  warn: (message: string, meta?: object) => void;
  debug?: (message: string, meta?: object) => void;
}

/**
 * Full logger interface for internal service operations.
 *
 * Requires debug method for detailed operational logging. Use this for:
 * - CoordinatorService internal logic
 * - Stream message handlers
 * - Background tasks and monitoring
 * - Any code requiring detailed debug logging
 *
 * Matches unified-detector's Logger interface signature.
 */
export interface Logger {
  info: (message: string, meta?: object) => void;
  error: (message: string, meta?: object) => void;
  warn: (message: string, meta?: object) => void;
  debug: (message: string, meta?: object) => void;
}

/**
 * @deprecated Use MinimalLogger instead for better clarity
 * Backward compatibility alias for existing route handlers
 */
export type RouteLogger = MinimalLogger;
