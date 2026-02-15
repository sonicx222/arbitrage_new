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

// =============================================================================
// Bridge Router Factory
// =============================================================================

import { ethers } from 'ethers';
import { IBridgeRouter, BridgeProtocol } from './types';
import { StargateRouter } from './stargate-router';

/**
 * Configuration for bridge router factory
 */
export interface BridgeRouterFactoryConfig {
  /** Default bridge protocol to use */
  defaultProtocol: BridgeProtocol;
  /** Providers per chain */
  providers: Map<string, ethers.Provider>;
}

/**
 * Factory for creating and managing bridge routers
 */
export class BridgeRouterFactory {
  private routers: Map<BridgeProtocol, IBridgeRouter> = new Map();
  private defaultProtocol: BridgeProtocol;

  constructor(config: BridgeRouterFactoryConfig) {
    this.defaultProtocol = config.defaultProtocol;

    // Initialize Stargate router
    const stargateRouter = new StargateRouter(config.providers);
    this.routers.set('stargate', stargateRouter);

    // Future: Add more routers (across, wormhole, connext, hyperlane, native)
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
   * Returns the first matching router, not necessarily the optimal one.
   * For multi-factor optimal bridge selection, use selectOptimalBridge() from bridge-config.
   */
  findSupportedRouter(
    sourceChain: string,
    destChain: string,
    token: string
  ): IBridgeRouter | null {
    // Check each router for support
    for (const router of this.routers.values()) {
      if (router.isRouteSupported(sourceChain, destChain, token)) {
        return router;
      }
    }
    return null;
  }

  /**
   * Get all available protocols
   */
  getAvailableProtocols(): BridgeProtocol[] {
    return Array.from(this.routers.keys());
  }

  /**
   * Health check all routers
   */
  async healthCheckAll(): Promise<Record<BridgeProtocol, { healthy: boolean; message: string }>> {
    const results: Record<string, { healthy: boolean; message: string }> = {};

    for (const [protocol, router] of this.routers) {
      results[protocol] = await router.healthCheck();
    }

    return results;
  }

  /**
   * Dispose all routers and release resources.
   *
   * Stops cleanup timers and other background resources held by router implementations.
   * Must be called during engine shutdown to prevent resource leaks.
   */
  async dispose(): Promise<void> {
    for (const router of this.routers.values()) {
      if ('dispose' in router && typeof (router as any).dispose === 'function') {
        await (router as any).dispose();
      }
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
