/**
 * Shared Test Data Builders for Cross-Chain Detector Tests
 *
 * Builder functions that create test data objects with sensible defaults.
 * Override any field using the `overrides` parameter.
 *
 * @see FIX #30: Shared test helpers for cross-chain-detector
 */

import type { PriceUpdate, WhaleTransaction, PendingSwapIntent } from '@arbitrage/types';

// =============================================================================
// Price Data Builders
// =============================================================================

/**
 * Create a PriceUpdate with sensible defaults.
 * Override any field as needed.
 */
export function createPriceUpdate(overrides: Partial<PriceUpdate> = {}): PriceUpdate {
  return {
    chain: overrides.chain ?? 'ethereum',
    dex: overrides.dex ?? 'uniswap',
    pairKey: overrides.pairKey ?? 'WETH_USDC',
    pairAddress: overrides.pairAddress ?? '0x1234567890abcdef1234567890abcdef12345678',
    token0: overrides.token0 ?? 'WETH',
    token1: overrides.token1 ?? 'USDC',
    reserve0: overrides.reserve0 ?? '1000000000000000000',
    reserve1: overrides.reserve1 ?? '2500000000',
    price: overrides.price ?? 2500,
    timestamp: overrides.timestamp ?? Date.now(),
    blockNumber: overrides.blockNumber ?? 12345,
    latency: overrides.latency ?? 50,
    ...overrides,
  };
}

/**
 * Create a PricePoint (as used in findArbitrageInPrices).
 * Automatically generates the nested `update` field from top-level fields.
 */
export function createPricePoint(overrides: Partial<{
  chain: string;
  dex: string;
  pairKey: string;
  price: number;
  timestamp: number;
}> = {}) {
  const chain = overrides.chain ?? 'ethereum';
  const dex = overrides.dex ?? 'uniswap';
  const pairKey = overrides.pairKey ?? 'WETH_USDC';
  const price = overrides.price ?? 2500;
  const timestamp = overrides.timestamp ?? Date.now();

  return {
    chain,
    dex,
    pairKey,
    price,
    update: createPriceUpdate({ chain, dex, pairKey, price, timestamp }),
  };
}

// =============================================================================
// Whale Transaction Builders
// =============================================================================

/**
 * Create a WhaleTransaction with sensible defaults.
 */
export function createWhaleTransaction(overrides: Partial<WhaleTransaction> = {}): WhaleTransaction {
  return {
    chain: overrides.chain ?? 'ethereum',
    txHash: overrides.txHash ?? '0xabc123',
    from: overrides.from ?? '0x1111111111111111111111111111111111111111',
    to: overrides.to ?? '0x2222222222222222222222222222222222222222',
    token: overrides.token ?? 'WETH',
    amountUsd: overrides.amountUsd ?? 500000,
    direction: overrides.direction ?? 'buy',
    timestamp: overrides.timestamp ?? Date.now(),
    ...overrides,
  } as WhaleTransaction;
}

// =============================================================================
// Pending Opportunity Builders
// =============================================================================

/**
 * Create a PendingSwapIntent with sensible defaults.
 */
export function createPendingSwapIntent(overrides: Partial<PendingSwapIntent> = {}): PendingSwapIntent {
  return {
    txHash: overrides.txHash ?? '0xpending123',
    chain: overrides.chain ?? 'ethereum',
    dex: overrides.dex ?? 'uniswap',
    tokenIn: overrides.tokenIn ?? 'USDC',
    tokenOut: overrides.tokenOut ?? 'WETH',
    amountIn: overrides.amountIn ?? '10000000000',
    expectedAmountOut: overrides.expectedAmountOut ?? '4000000000000000000',
    deadline: overrides.deadline ?? Math.floor(Date.now() / 1000) + 300,
    sender: overrides.sender ?? '0x3333333333333333333333333333333333333333',
    gasPrice: overrides.gasPrice ?? '20000000000',
    ...overrides,
  } as PendingSwapIntent;
}

// =============================================================================
// Cross-Chain Opportunity Builders
// =============================================================================

/**
 * Create a CrossChainOpportunity with sensible defaults.
 * Useful for testing OpportunityPublisher, deduplication, and publishing.
 */
export function createCrossChainOpportunity(overrides: Record<string, any> = {}) {
  return {
    id: overrides.id ?? `opp-${Date.now()}`,
    sourceChain: overrides.sourceChain ?? 'ethereum',
    targetChain: overrides.targetChain ?? 'bsc',
    sourceDex: overrides.sourceDex ?? 'uniswap',
    targetDex: overrides.targetDex ?? 'pancakeswap',
    tokenPair: overrides.tokenPair ?? 'WETH_USDC',
    buyPrice: overrides.buyPrice ?? 2500,
    sellPrice: overrides.sellPrice ?? 2550,
    grossProfitBps: overrides.grossProfitBps ?? 200,
    netProfitBps: overrides.netProfitBps ?? 150,
    confidence: overrides.confidence ?? 0.85,
    bridgeCostEth: overrides.bridgeCostEth ?? 0.001,
    bridgeCostUsd: overrides.bridgeCostUsd ?? 3,
    estimatedLatency: overrides.estimatedLatency ?? 120,
    timestamp: overrides.timestamp ?? Date.now(),
    ...overrides,
  };
}
