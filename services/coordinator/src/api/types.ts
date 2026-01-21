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
 */
export type AlertSeverity = 'low' | 'high' | 'critical';

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
  getLogger(): RouteLogger;

  /** Get alert history for /api/alerts endpoint */
  getAlertHistory(limit?: number): Alert[];
}

/**
 * Logger interface for route handlers and coordinator internals.
 * FIX: Consolidated Logger interface (previously duplicated in coordinator.ts)
 */
export interface RouteLogger {
  info: (message: string, meta?: unknown) => void;
  error: (message: string, meta?: unknown) => void;
  warn: (message: string, meta?: unknown) => void;
  debug?: (message: string, meta?: unknown) => void; // Optional for routes, required for coordinator
}

/**
 * FIX: Full logger interface with required debug method.
 * Used by CoordinatorService for internal logging.
 */
export interface Logger extends RouteLogger {
  debug: (message: string, meta?: unknown) => void;
}
