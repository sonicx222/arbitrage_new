/**
 * Bridge Router Module
 *
 * Phase 3: Cross-Chain Execution Support
 *
 * Provides abstractions for cross-chain token bridges:
 * - IBridgeRouter interface for multiple bridge implementations
 * - StargateRouter for LayerZero-based bridging
 * - Bridge selection and routing logic
 *
 * @module bridge-router
 */

// Types and interfaces
export type {
  BridgeProtocol,
  BridgeStatus,
  BridgeChainConfig,
  BridgeTokenConfig,
  BridgeQuoteRequest,
  BridgeQuote,
  BridgeExecuteRequest,
  BridgeExecuteResult,
  BridgeStatusResult,
  IBridgeRouter,
  BridgeHealthMetrics,
  BridgeExecutionMetrics,
  PoolLiquidityAlert,
  CrossChainExecutionPlan,
  CrossChainExecutionResult,
} from './types';

// Constants
export {
  BRIDGE_DEFAULTS,
  STARGATE_CHAIN_IDS,
  STARGATE_POOL_IDS,
  STARGATE_ROUTER_ADDRESSES,
  BRIDGE_TIMES,
} from './types';

// Stargate implementation
export {
  StargateRouter,
  createStargateRouter,
} from './stargate-router';

// Across implementation
export {
  AcrossRouter,
  createAcrossRouter,
  ACROSS_SPOKEPOOL_ADDRESSES,
  ACROSS_CHAIN_IDS,
  ACROSS_BRIDGE_TIMES,
} from './across-router';

// Stargate V2 implementation
export {
  StargateV2Router,
  createStargateV2Router,
  STARGATE_V2_POOL_ADDRESSES,
  STARGATE_V2_ENDPOINT_IDS,
  STARGATE_V2_BRIDGE_TIMES,
} from './stargate-v2-router';

// =============================================================================
// Bridge Router Factory
// =============================================================================

import { ethers } from 'ethers';
import { IBridgeRouter, BridgeProtocol, BridgeHealthMetrics, BridgeExecutionMetrics, PoolLiquidityAlert } from './types';
import { StargateRouter } from './stargate-router';
import { AcrossRouter } from './across-router';
import { StargateV2Router } from './stargate-v2-router';
import { selectOptimalBridge, type BridgeUrgency } from '@arbitrage/config';

/**
 * Configuration for bridge router factory
 */
export interface BridgeRouterFactoryConfig {
  /** Default bridge protocol to use */
  defaultProtocol: BridgeProtocol;
  /** Providers per chain */
  providers: Map<string, ethers.Provider>;
  /** Protocols to skip during initialization (e.g., disable V1 when V2 is stable) */
  disabledProtocols?: BridgeProtocol[];
  /** Callback invoked when pool liquidity drops below threshold */
  onPoolAlert?: (alert: PoolLiquidityAlert) => void;
}

/**
 * Factory for creating and managing bridge routers
 */
export class BridgeRouterFactory {
  private routers: Map<BridgeProtocol, IBridgeRouter> = new Map();
  private healthMetrics: Map<BridgeProtocol, BridgeHealthMetrics> = new Map();
  private executionMetrics: Map<BridgeProtocol, BridgeExecutionMetrics> = new Map();
  private defaultProtocol: BridgeProtocol;
  private disabledProtocols: Set<BridgeProtocol>;

  constructor(config: BridgeRouterFactoryConfig) {
    this.defaultProtocol = config.defaultProtocol;
    this.disabledProtocols = new Set(config.disabledProtocols ?? []);

    // Initialize routers, skipping disabled protocols
    if (!this.disabledProtocols.has('stargate')) {
      const stargateRouter = new StargateRouter(config.providers, {
        onPoolAlert: config.onPoolAlert,
      });
      this.routers.set('stargate', stargateRouter);
    }

    if (!this.disabledProtocols.has('across')) {
      const acrossRouter = new AcrossRouter(config.providers);
      this.routers.set('across', acrossRouter);
    }

    if (!this.disabledProtocols.has('stargate-v2')) {
      const stargateV2Router = new StargateV2Router(config.providers);
      this.routers.set('stargate-v2', stargateV2Router);
    }

    // Future: Add more routers (wormhole, connext, hyperlane, native)
  }

  /**
   * Get the default router
   */
  getDefaultRouter(): IBridgeRouter {
    return this.getRouter(this.defaultProtocol);
  }

  /**
   * Get a specific router
   */
  getRouter(protocol: BridgeProtocol): IBridgeRouter {
    const router = this.routers.get(protocol);
    if (!router) {
      throw new Error(`Bridge router not available for protocol: ${protocol}`);
    }
    return router;
  }

  /**
   * Find a router that supports the given route.
   *
   * When multiple routers support the route, uses selectOptimalBridge() from
   * bridge-config to pick the best one based on latency, cost, and reliability.
   * Falls back to first match if scoring is unavailable or only one router matches.
   *
   * @param tradeSizeUsd - Trade size in USD for scoring (default 1000)
   * @param urgency - Bridge urgency for scoring (default 'medium')
   */
  findSupportedRouter(
    sourceChain: string,
    destChain: string,
    token: string,
    tradeSizeUsd?: number,
    urgency?: BridgeUrgency
  ): IBridgeRouter | null {
    // Collect all routers that support this route
    const matchingRouters: IBridgeRouter[] = [];
    for (const router of this.routers.values()) {
      if (router.isRouteSupported(sourceChain, destChain, token)) {
        matchingRouters.push(router);
      }
    }

    if (matchingRouters.length === 0) {
      return null;
    }

    if (matchingRouters.length === 1) {
      return matchingRouters[0];
    }

    // Multiple routers match — use scoring to pick optimal
    const optimalResult = selectOptimalBridge(
      sourceChain, destChain, tradeSizeUsd, urgency
    );

    if (optimalResult) {
      const scoredRouter = matchingRouters.find(
        r => r.protocol === optimalResult.config.bridge
      );
      if (scoredRouter) {
        return scoredRouter;
      }
    }

    // Fallback to first match if scoring didn't resolve
    return matchingRouters[0];
  }

  /**
   * Get all available protocols
   */
  getAvailableProtocols(): BridgeProtocol[] {
    return Array.from(this.routers.keys());
  }

  /** Per-router health check timeout in milliseconds */
  private static readonly HEALTH_CHECK_TIMEOUT_MS = 10_000;

  /**
   * Health check all routers and record per-bridge metrics.
   *
   * Each router is checked with a per-router timeout and error isolation,
   * so a hanging or failing router does not block checks for remaining routers.
   */
  async healthCheckAll(): Promise<Record<BridgeProtocol, { healthy: boolean; message: string }>> {
    const results: Record<string, { healthy: boolean; message: string }> = {};

    for (const [protocol, router] of this.routers) {
      let result: { healthy: boolean; message: string };
      try {
        result = await Promise.race([
          router.healthCheck(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Health check timed out after ${BridgeRouterFactory.HEALTH_CHECK_TIMEOUT_MS}ms`)),
              BridgeRouterFactory.HEALTH_CHECK_TIMEOUT_MS
            )
          ),
        ]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result = { healthy: false, message };
      }

      results[protocol] = result;

      // Update health metrics
      const existing = this.healthMetrics.get(protocol);
      if (existing) {
        existing.totalChecks++;
        if (result.healthy) {
          existing.successfulChecks++;
        } else {
          existing.failedChecks++;
        }
        existing.lastHealthy = result.healthy;
        existing.lastCheckTime = Date.now();
        existing.lastMessage = result.message;
      } else {
        this.healthMetrics.set(protocol, {
          totalChecks: 1,
          successfulChecks: result.healthy ? 1 : 0,
          failedChecks: result.healthy ? 0 : 1,
          lastHealthy: result.healthy,
          lastCheckTime: Date.now(),
          lastMessage: result.message,
        });
      }
    }

    return results;
  }

  /**
   * Get per-bridge health metrics (defensive copy).
   * Metrics are populated by healthCheckAll() calls.
   * Returns a shallow copy so callers cannot mutate internal factory state.
   */
  getHealthMetrics(): Map<BridgeProtocol, BridgeHealthMetrics> {
    return new Map(
      [...this.healthMetrics].map(([k, v]) => [k, { ...v }])
    );
  }

  /**
   * Record a bridge operation outcome for execution metrics tracking.
   * Called by consumers (e.g., cross-chain strategy) after each bridge operation.
   *
   * @param protocol - Bridge protocol used
   * @param operation - Type of operation ('quote' or 'execute')
   * @param success - Whether the operation succeeded
   * @param latencyMs - Operation duration in milliseconds
   */
  recordExecution(
    protocol: BridgeProtocol,
    operation: 'quote' | 'execute',
    success: boolean,
    latencyMs: number = 0
  ): void {
    let metrics = this.executionMetrics.get(protocol);
    if (!metrics) {
      metrics = {
        quoteAttempts: 0,
        quoteSuccesses: 0,
        quoteFailures: 0,
        executeAttempts: 0,
        executeSuccesses: 0,
        executeFailures: 0,
        totalLatencyMs: 0,
        lastExecutionTime: 0,
      };
      this.executionMetrics.set(protocol, metrics);
    }

    if (operation === 'quote') {
      metrics.quoteAttempts++;
      if (success) {
        metrics.quoteSuccesses++;
      } else {
        metrics.quoteFailures++;
      }
    } else {
      metrics.executeAttempts++;
      if (success) {
        metrics.executeSuccesses++;
      } else {
        metrics.executeFailures++;
      }
    }

    metrics.totalLatencyMs += latencyMs;
    metrics.lastExecutionTime = Date.now();
  }

  /**
   * Get per-bridge execution metrics.
   * Metrics are populated by recordExecution() calls from bridge consumers.
   */
  getExecutionMetrics(): Map<BridgeProtocol, BridgeExecutionMetrics> {
    return this.executionMetrics;
  }

  /**
   * Check whether a protocol is disabled.
   */
  isProtocolDisabled(protocol: BridgeProtocol): boolean {
    return this.disabledProtocols.has(protocol);
  }

  /**
   * Dispose all routers and release resources.
   *
   * Stops cleanup timers and other background resources held by router implementations.
   * Must be called during engine shutdown to prevent resource leaks.
   */
  async dispose(): Promise<void> {
    for (const router of this.routers.values()) {
      router.dispose();
    }
    this.routers.clear();
  }
}

/**
 * Create a bridge router factory
 */
export function createBridgeRouterFactory(
  config: BridgeRouterFactoryConfig
): BridgeRouterFactory {
  return new BridgeRouterFactory(config);
}
