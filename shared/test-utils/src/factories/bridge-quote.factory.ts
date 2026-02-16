/**
 * Bridge Quote Test Factory
 *
 * Provides factory functions for creating BridgeQuote test fixtures.
 * Reduces duplication in bridge-router and cross-chain tests.
 *
 * Uses the canonical BridgeQuote type from @arbitrage/core bridge-router types.
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
 *   destChain: 'arbitrum',
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
// Types - Using canonical BridgeQuote from @arbitrage/core
// =============================================================================

/**
 * BridgeQuote matching the canonical type from shared/core/src/bridge-router/types.ts.
 * Re-defined here to avoid a hard dependency on @arbitrage/core (which would create
 * a build-order issue since test-utils is used during core's own tests).
 */
export interface BridgeQuote {
  /** Bridge protocol used */
  protocol: 'stargate' | 'stargate-v2' | 'native' | 'across' | 'wormhole' | 'connext' | 'hyperlane';
  /** Source chain */
  sourceChain: string;
  /** Destination chain */
  destChain: string;
  /** Token being bridged */
  token: string;
  /** Input amount in wei */
  amountIn: string;
  /** Expected output amount in wei (after fees) */
  amountOut: string;
  /** Bridge fee in wei */
  bridgeFee: string;
  /** LayerZero/native gas fee in wei */
  gasFee: string;
  /**
   * Total native gas cost in wei.
   * @deprecated Prefer using gasFee directly for clarity. totalFee === gasFee.
   */
  totalFee: string;
  /** Estimated delivery time in seconds */
  estimatedTimeSeconds: number;
  /** Quote expiry timestamp */
  expiresAt: number;
  /** Quote validity (true if route is available) */
  valid: boolean;
  /** Error message if not valid */
  error?: string;
  /** Destination address for bridged tokens */
  recipient?: string;
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
 * Create a bridge quote with sensible defaults matching the canonical type.
 */
export function createBridgeQuote(overrides: BridgeQuoteOverrides = {}): BridgeQuote {
  quoteCounter++;
  const now = Date.now();
  const gasFee = overrides.gasFee ?? '2000000000000000'; // 0.002 ETH

  return {
    protocol: 'stargate',
    sourceChain: 'ethereum',
    destChain: 'arbitrum',
    token: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    amountIn: '1000000000000000000', // 1 ETH
    amountOut: '998000000000000000', // 0.998 ETH (0.2% fee)
    bridgeFee: '2000000000000000', // 0.002 ETH
    gasFee,
    totalFee: gasFee, // totalFee === gasFee per canonical type
    estimatedTimeSeconds: 600, // 10 minutes
    expiresAt: now + 300000, // 5 minutes validity
    valid: true,
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
    this.quote.token = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
    return this;
  }

  fromArbitrum(): this {
    this.quote.sourceChain = 'arbitrum';
    this.quote.token = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
    return this;
  }

  fromBsc(): this {
    this.quote.sourceChain = 'bsc';
    this.quote.token = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
    return this;
  }

  fromPolygon(): this {
    this.quote.sourceChain = 'polygon';
    this.quote.token = '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270';
    return this;
  }

  toEthereum(): this {
    this.quote.destChain = 'ethereum';
    return this;
  }

  toArbitrum(): this {
    this.quote.destChain = 'arbitrum';
    return this;
  }

  toBsc(): this {
    this.quote.destChain = 'bsc';
    return this;
  }

  toPolygon(): this {
    this.quote.destChain = 'polygon';
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

  withBridge(protocol: BridgeQuote['protocol']): this {
    this.quote.protocol = protocol;
    return this;
  }

  withFee(bridgeFee: string): this {
    this.quote.bridgeFee = bridgeFee;
    return this;
  }

  withGasFee(gasFee: string): this {
    this.quote.gasFee = gasFee;
    this.quote.totalFee = gasFee;
    return this;
  }

  withEstimatedTime(seconds: number): this {
    this.quote.estimatedTimeSeconds = seconds;
    return this;
  }

  withRecipient(recipient: string): this {
    this.quote.recipient = recipient;
    return this;
  }

  invalid(error: string): this {
    this.quote.valid = false;
    this.quote.error = error;
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
    destChain: 'optimism',
    token: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    amountIn,
    protocol: 'across',
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
 * Create an invalid quote (for testing error handling).
 */
export function createInvalidQuote(error = 'Route not available'): BridgeQuote {
  return new BridgeQuoteBuilder().invalid(error).build();
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
