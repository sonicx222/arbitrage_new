/**
 * Bridge Quote Test Factory
 *
 * Provides factory functions for creating BridgeQuote test fixtures.
 * Reduces duplication in bridge-router and cross-chain tests.
 *
 * @example
 * ```typescript
 * import { createBridgeQuote, BridgeQuoteBuilder } from '@arbitrage/test-utils';
 *
 * // Simple creation with defaults
 * const quote = createBridgeQuote();
 *
 * // With overrides
 * const customQuote = createBridgeQuote({
 *   sourceChain: 'ethereum',
 *   targetChain: 'arbitrum',
 *   amountOut: '1000000000000000000',
 * });
 *
 * // Using builder pattern
 * const builderQuote = new BridgeQuoteBuilder()
 *   .fromEthereum()
 *   .toArbitrum()
 *   .withAmount('2000000000000000000')
 *   .build();
 * ```
 */

// =============================================================================
// Types
// =============================================================================

export interface BridgeQuote {
  /** Source chain identifier */
  sourceChain: string;
  /** Target chain identifier */
  targetChain: string;
  /** Source token address */
  sourceToken: string;
  /** Target token address */
  targetToken: string;
  /** Input amount in wei/smallest unit */
  amountIn: string;
  /** Output amount in wei/smallest unit */
  amountOut: string;
  /** Bridge protocol name */
  bridgeProtocol: string;
  /** Estimated bridge fee in native token */
  bridgeFee: string;
  /** Estimated gas cost for the bridge transaction */
  estimatedGas: string;
  /** Estimated time to complete bridge in seconds */
  estimatedTimeSeconds: number;
  /** Timestamp when quote was generated */
  timestamp: number;
  /** Quote expiry timestamp */
  expiresAt: number;
  /** Optional: Route details for multi-hop bridges */
  route?: string[];
  /** Optional: Slippage tolerance as decimal (0.01 = 1%) */
  slippageTolerance?: number;
}

export interface BridgeQuoteOverrides extends Partial<BridgeQuote> {}

// =============================================================================
// Factory State
// =============================================================================

let quoteCounter = 0;

/**
 * Reset the factory counter (for test isolation).
 */
export function resetBridgeQuoteFactory(): void {
  quoteCounter = 0;
}

/**
 * Get the current counter value (for debugging).
 */
export function getBridgeQuoteCounter(): number {
  return quoteCounter;
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a bridge quote with sensible defaults.
 */
export function createBridgeQuote(overrides: BridgeQuoteOverrides = {}): BridgeQuote {
  quoteCounter++;
  const now = Date.now();

  return {
    sourceChain: 'ethereum',
    targetChain: 'arbitrum',
    sourceToken: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH on Ethereum
    targetToken: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // WETH on Arbitrum
    amountIn: '1000000000000000000', // 1 ETH
    amountOut: '998000000000000000', // 0.998 ETH (0.2% fee)
    bridgeProtocol: 'stargate',
    bridgeFee: '2000000000000000', // 0.002 ETH
    estimatedGas: '150000',
    estimatedTimeSeconds: 600, // 10 minutes
    timestamp: now,
    expiresAt: now + 300000, // 5 minutes validity
    slippageTolerance: 0.005, // 0.5%
    ...overrides,
  };
}

/**
 * Create multiple bridge quotes.
 */
export function createBridgeQuotes(
  count: number,
  overrides: BridgeQuoteOverrides = {}
): BridgeQuote[] {
  return Array.from({ length: count }, () => createBridgeQuote(overrides));
}

// =============================================================================
// Builder Pattern
// =============================================================================

/**
 * Fluent builder for creating BridgeQuote test fixtures.
 */
export class BridgeQuoteBuilder {
  private quote: BridgeQuote;

  constructor() {
    this.quote = createBridgeQuote();
  }

  fromEthereum(): this {
    this.quote.sourceChain = 'ethereum';
    this.quote.sourceToken = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
    return this;
  }

  fromArbitrum(): this {
    this.quote.sourceChain = 'arbitrum';
    this.quote.sourceToken = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
    return this;
  }

  fromBsc(): this {
    this.quote.sourceChain = 'bsc';
    this.quote.sourceToken = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
    return this;
  }

  fromPolygon(): this {
    this.quote.sourceChain = 'polygon';
    this.quote.sourceToken = '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270';
    return this;
  }

  toEthereum(): this {
    this.quote.targetChain = 'ethereum';
    this.quote.targetToken = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
    return this;
  }

  toArbitrum(): this {
    this.quote.targetChain = 'arbitrum';
    this.quote.targetToken = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
    return this;
  }

  toBsc(): this {
    this.quote.targetChain = 'bsc';
    this.quote.targetToken = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
    return this;
  }

  toPolygon(): this {
    this.quote.targetChain = 'polygon';
    this.quote.targetToken = '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270';
    return this;
  }

  withAmount(amountIn: string, amountOut?: string): this {
    this.quote.amountIn = amountIn;
    if (amountOut) {
      this.quote.amountOut = amountOut;
    } else {
      // Default 0.2% fee
      const inBigInt = BigInt(amountIn);
      this.quote.amountOut = ((inBigInt * 998n) / 1000n).toString();
    }
    return this;
  }

  withBridge(protocol: string): this {
    this.quote.bridgeProtocol = protocol;
    return this;
  }

  withFee(fee: string): this {
    this.quote.bridgeFee = fee;
    return this;
  }

  withEstimatedTime(seconds: number): this {
    this.quote.estimatedTimeSeconds = seconds;
    return this;
  }

  expired(): this {
    this.quote.expiresAt = Date.now() - 60000; // Expired 1 minute ago
    return this;
  }

  expiringIn(ms: number): this {
    this.quote.expiresAt = Date.now() + ms;
    return this;
  }

  withSlippage(tolerance: number): this {
    this.quote.slippageTolerance = tolerance;
    return this;
  }

  withRoute(route: string[]): this {
    this.quote.route = route;
    return this;
  }

  build(): BridgeQuote {
    return { ...this.quote };
  }
}

// =============================================================================
// Convenience Factory Instance
// =============================================================================

/**
 * Convenience factory instance for quick quote creation.
 * Use this when you don't need the full builder pattern.
 */
export const bridgeQuote = {
  create: createBridgeQuote,
  createMany: createBridgeQuotes,
  builder: () => new BridgeQuoteBuilder(),
  reset: resetBridgeQuoteFactory,
};

// =============================================================================
// Common Scenarios
// =============================================================================

/**
 * Create a quote for ETH -> ARB bridge.
 */
export function createEthToArbQuote(amountIn = '1000000000000000000'): BridgeQuote {
  return new BridgeQuoteBuilder()
    .fromEthereum()
    .toArbitrum()
    .withAmount(amountIn)
    .withBridge('stargate')
    .withEstimatedTime(600)
    .build();
}

/**
 * Create a quote for cross-L2 bridge (Arbitrum -> Optimism).
 */
export function createL2ToL2Quote(amountIn = '1000000000000000000'): BridgeQuote {
  return createBridgeQuote({
    sourceChain: 'arbitrum',
    targetChain: 'optimism',
    sourceToken: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    targetToken: '0x4200000000000000000000000000000000000006',
    amountIn,
    bridgeProtocol: 'hop',
    estimatedTimeSeconds: 1200, // 20 minutes for L2-L2
  });
}

/**
 * Create an expired quote (for testing expiry handling).
 */
export function createExpiredQuote(): BridgeQuote {
  return new BridgeQuoteBuilder().expired().build();
}

/**
 * Create a high-fee quote (for testing fee threshold checks).
 */
export function createHighFeeQuote(): BridgeQuote {
  return createBridgeQuote({
    bridgeFee: '50000000000000000', // 0.05 ETH - high fee
    amountOut: '950000000000000000', // Only 0.95 ETH out for 1 ETH in
  });
}
