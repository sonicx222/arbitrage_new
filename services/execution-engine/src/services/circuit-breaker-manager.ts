/**
 * Circuit Breaker Manager — Per-Chain Isolation
 *
 * Manages per-chain circuit breaker lifecycle, event handling, and public API.
 * Each chain gets its own lazily-created CircuitBreaker so that failures on
 * one chain (e.g., Solana RPC issues) do not block execution on other chains.
 *
 * Hot-path note:
 * - canExecute(chainId) is O(1) — Map.get + boolean check
 * - recordSuccess/recordFailure are O(1) delegate calls
 * - Chain breakers are created lazily on first access (not hot path)
 * - State change publishing is async fire-and-forget
 *
 * @see engine.ts (consumer)
 * @see services/circuit-breaker.ts (implementation)
 */

import {
  getErrorMessage,
  RedisStreamsClient,
} from '@arbitrage/core';
import {
  createCircuitBreaker,
  type CircuitBreaker,
  type CircuitBreakerEvent,
  type CircuitBreakerStatus,
} from './circuit-breaker';
import type { CircuitBreakerConfig, ExecutionStats, Logger } from '../types';

/**
 * Dependencies for CircuitBreakerManager construction.
 */
export interface CircuitBreakerManagerDeps {
  config: Required<CircuitBreakerConfig>;
  logger: Logger;
  stats: ExecutionStats;
  instanceId: string;
  /** Getter for nullable streams client (may disconnect during shutdown) */
  getStreamsClient: () => RedisStreamsClient | null;
}

/**
 * Per-chain status entry returned by getAllStatus().
 */
export interface ChainCircuitBreakerStatus extends CircuitBreakerStatus {
  chain: string;
}

/**
 * Manages per-chain circuit breaker lifecycle and event handling.
 *
 * Each chain gets its own CircuitBreaker instance, lazily created on first
 * access. This prevents cascading failures — e.g., Solana RPC issues won't
 * block Ethereum or Arbitrum execution.
 */
export class CircuitBreakerManager {
  /** Per-chain circuit breakers, lazily created */
  private readonly chainBreakers = new Map<string, CircuitBreaker>();
  private enabled = false;

  private readonly config: Required<CircuitBreakerConfig>;
  private readonly logger: Logger;
  private readonly stats: ExecutionStats;
  private readonly instanceId: string;
  private readonly getStreamsClient: () => RedisStreamsClient | null;

  constructor(deps: CircuitBreakerManagerDeps) {
    this.config = deps.config;
    this.logger = deps.logger;
    this.stats = deps.stats;
    this.instanceId = deps.instanceId;
    this.getStreamsClient = deps.getStreamsClient;
  }

  /**
   * Initialize the circuit breaker manager.
   * No breakers are created here — they are lazily created per-chain on first access.
   */
  initialize(): void {
    if (!this.config.enabled) {
      this.logger.info('Circuit breaker disabled by configuration');
      return;
    }

    this.enabled = true;
    this.logger.info('Per-chain circuit breaker manager initialized', {
      failureThreshold: this.config.failureThreshold,
      cooldownPeriodMs: this.config.cooldownPeriodMs,
      halfOpenMaxAttempts: this.config.halfOpenMaxAttempts,
    });
  }

  // ===========================================================================
  // Per-Chain API (primary interface for engine.ts)
  // ===========================================================================

  /**
   * Get or lazily create a circuit breaker for a specific chain.
   * Returns null if circuit breakers are disabled.
   */
  getChainBreaker(chainId: string): CircuitBreaker | null {
    if (!this.enabled) return null;

    let breaker = this.chainBreakers.get(chainId);
    if (!breaker) {
      breaker = createCircuitBreaker({
        logger: this.logger,
        failureThreshold: this.config.failureThreshold,
        cooldownPeriodMs: this.config.cooldownPeriodMs,
        halfOpenMaxAttempts: this.config.halfOpenMaxAttempts,
        enabled: true,
        onStateChange: (event: CircuitBreakerEvent) => {
          this.handleChainStateChange(chainId, event);
        },
      });
      this.chainBreakers.set(chainId, breaker);
    }

    return breaker;
  }

  /**
   * Check if execution is allowed on a specific chain.
   * Returns true if disabled (fail-open for execution, fail-closed handled elsewhere).
   */
  canExecute(chainId: string): boolean {
    if (!this.enabled) return true;
    const breaker = this.getChainBreaker(chainId);
    return breaker?.canExecute() ?? true;
  }

  /** Record a successful execution for a specific chain. */
  recordSuccess(chainId: string): void {
    if (!this.enabled) return;
    this.getChainBreaker(chainId)?.recordSuccess();
  }

  /** Record a failed execution for a specific chain. */
  recordFailure(chainId: string): void {
    if (!this.enabled) return;
    this.getChainBreaker(chainId)?.recordFailure();
  }

  /** Get status for a specific chain. Returns null if chain has no breaker. */
  getChainStatus(chainId: string): CircuitBreakerStatus | null {
    return this.chainBreakers.get(chainId)?.getStatus() ?? null;
  }

  /** Get status for all chains that have breakers. */
  getAllStatus(): ChainCircuitBreakerStatus[] {
    const result: ChainCircuitBreakerStatus[] = [];
    for (const [chain, breaker] of this.chainBreakers) {
      result.push({ chain, ...breaker.getStatus() });
    }
    return result;
  }

  /** Check if a specific chain's circuit breaker is open. */
  isChainOpen(chainId: string): boolean {
    return this.chainBreakers.get(chainId)?.isOpen() ?? false;
  }

  /** Force close a specific chain's circuit breaker. */
  forceCloseChain(chainId: string): void {
    this.chainBreakers.get(chainId)?.forceClose();
  }

  /** Force open a specific chain's circuit breaker. */
  forceOpenChain(chainId: string, reason = 'manual override'): void {
    this.chainBreakers.get(chainId)?.forceOpen(reason);
  }

  /** Stop all chain breakers and clear the map. */
  stopAll(): void {
    for (const breaker of this.chainBreakers.values()) {
      breaker.stop();
    }
    // FIX P1-7: Clear the map to prevent stale state leaking into a new lifecycle.
    // Previously, old breaker instances persisted after stop, causing state leaks on restart.
    // @see docs/reports/EXECUTION_ENGINE_DEEP_ANALYSIS_2026-02-20.md P1 #7
    this.chainBreakers.clear();
  }

  // ===========================================================================
  // Backward-Compatible API (used by health endpoints, dashboard, etc.)
  // ===========================================================================

  /**
   * Get the first circuit breaker instance (backward compatibility).
   * Returns null if no chain breakers exist or disabled.
   */
  getCircuitBreaker(): CircuitBreaker | null {
    if (!this.enabled) return null;
    const first = this.chainBreakers.values().next();
    return first.done ? null : first.value;
  }

  /** Get status of first chain breaker (backward compatibility). */
  getStatus(): CircuitBreakerStatus | null {
    return this.getCircuitBreaker()?.getStatus() ?? null;
  }

  /** Check if any chain's circuit breaker is open. */
  isOpen(): boolean {
    for (const breaker of this.chainBreakers.values()) {
      if (breaker.isOpen()) return true;
    }
    return false;
  }

  /** Get circuit breaker configuration. */
  getConfig(): Readonly<Required<CircuitBreakerConfig>> {
    return this.config;
  }

  /** Force close ALL chain circuit breakers. */
  forceClose(): void {
    for (const breaker of this.chainBreakers.values()) {
      breaker.forceClose();
    }
  }

  /** Force open ALL chain circuit breakers. */
  forceOpen(reason = 'manual override'): void {
    for (const breaker of this.chainBreakers.values()) {
      breaker.forceOpen(reason);
    }
  }

  // ===========================================================================
  // Event Handling (NOT on hot path — async, rare events)
  // ===========================================================================

  // ===========================================================================
  // State Persistence via CIRCUIT_BREAKER Stream (FIX W2-11)
  // ===========================================================================

  /**
   * FIX W2-11: Restore circuit breaker states from recent CIRCUIT_BREAKER stream events.
   *
   * On startup, reads recent circuit breaker events from the stream and
   * force-opens any chains whose most recent event was an OPEN transition
   * within the cooldown window. This prevents a restarting instance from
   * immediately resuming execution on a chain that was tripping.
   *
   * Uses the existing CIRCUIT_BREAKER stream (already published to by
   * handleChainStateChange) — no separate persistence mechanism needed.
   *
   * Should be called after initialize() and before processing begins.
   *
   * @returns Number of chains restored to OPEN state
   */
  async restorePersistedState(): Promise<number> {
    if (!this.enabled) return 0;

    const streamsClient = this.getStreamsClient();
    if (!streamsClient) return 0;

    try {
      // Read the most recent circuit breaker events from the stream
      const messages = await streamsClient.xread(
        RedisStreamsClient.STREAMS.CIRCUIT_BREAKER,
        '0',
        { count: 200 } // Read up to 200 recent events
      );

      if (!messages || messages.length === 0) return 0;

      // Build latest state per chain from events (last write wins)
      const latestByChain = new Map<string, { newState: string; reason: string; consecutiveFailures: string; timestamp: string }>();
      for (const msg of messages) {
        const data = msg.data as Record<string, string>;
        if (data.chain && data.newState) {
          latestByChain.set(data.chain, {
            newState: data.newState,
            reason: data.reason ?? 'unknown',
            consecutiveFailures: data.consecutiveFailures ?? '0',
            timestamp: data.timestamp ?? '0',
          });
        }
      }

      // Restore OPEN states that are still within the cooldown window
      let restored = 0;
      const now = Date.now();
      for (const [chain, state] of latestByChain) {
        if (state.newState === 'OPEN') {
          const eventTimestamp = parseInt(state.timestamp, 10) || 0;
          const ageMs = now - eventTimestamp;

          // Only restore if the OPEN event is within the cooldown period
          if (ageMs < this.config.cooldownPeriodMs) {
            const breaker = this.getChainBreaker(chain);
            if (breaker) {
              breaker.forceOpen(`Restored from restart: ${state.reason}`);
              restored++;
              this.logger.info('Restored circuit breaker OPEN state from stream', {
                chain,
                originalReason: state.reason,
                consecutiveFailures: parseInt(state.consecutiveFailures, 10),
                ageMs,
              });
            }
          }
        }
      }

      if (restored > 0) {
        this.logger.info('Circuit breaker state restoration complete', { restored });
      }

      return restored;
    } catch (error) {
      this.logger.warn('Failed to restore circuit breaker states (non-fatal)', {
        error: getErrorMessage(error),
      });
      return 0;
    }
  }

  // ===========================================================================
  // Event Handling (NOT on hot path — async, rare events)
  // ===========================================================================

  /**
   * Handle chain-specific circuit breaker state change.
   */
  private handleChainStateChange(chain: string, event: CircuitBreakerEvent): void {
    if (event.newState === 'OPEN') {
      this.logger.warn('Chain circuit breaker OPENED - halting executions on chain', {
        chain,
        reason: event.reason,
        consecutiveFailures: event.consecutiveFailures,
        cooldownRemainingMs: event.cooldownRemainingMs,
      });
      this.stats.circuitBreakerTrips++;
    } else if (event.newState === 'CLOSED') {
      this.logger.info('Chain circuit breaker CLOSED - resuming executions on chain', {
        chain,
        reason: event.reason,
      });
    } else if (event.newState === 'HALF_OPEN') {
      this.logger.info('Chain circuit breaker HALF_OPEN - testing recovery on chain', {
        chain,
        reason: event.reason,
      });
    }

    void this.publishChainEvent(chain, event);
  }

  /**
   * Publish chain-annotated circuit breaker event to Redis Stream.
   */
  private async publishChainEvent(chain: string, event: CircuitBreakerEvent): Promise<void> {
    const streamsClient = this.getStreamsClient();
    if (!streamsClient) return;

    try {
      await streamsClient.xadd(RedisStreamsClient.STREAMS.CIRCUIT_BREAKER, {
        service: 'execution-engine',
        instanceId: this.instanceId,
        chain,
        previousState: event.previousState,
        newState: event.newState,
        reason: event.reason,
        timestamp: event.timestamp,
        consecutiveFailures: event.consecutiveFailures,
        cooldownRemainingMs: event.cooldownRemainingMs,
      });
    } catch (error) {
      this.logger.error('Failed to publish circuit breaker event', {
        error: getErrorMessage(error),
        chain,
      });
    }
  }
}

/**
 * Factory function for CircuitBreakerManager.
 * Follows codebase convention of factory functions for DI.
 */
export function createCircuitBreakerManager(
  deps: CircuitBreakerManagerDeps,
): CircuitBreakerManager {
  return new CircuitBreakerManager(deps);
}
