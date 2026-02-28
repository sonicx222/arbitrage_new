/**
 * Event Configuration
 *
 * Event monitoring settings and pre-computed event signatures.
 *
 * @see S3.3: Event processing configuration
 */

// =============================================================================
// EVENT MONITORING CONFIGURATION
// =============================================================================
export const EVENT_CONFIG = {
  syncEvents: {
    enabled: true,
    priority: 'high'
  },
  swapEvents: {
    enabled: true,
    priority: 'medium',
    minAmountUSD: 10000,    // $10K minimum for processing
    whaleThreshold: 50000,  // $50K for whale alerts
    samplingRate: 0.01      // 1% sampling for <$10K swaps
  }
};

// =============================================================================
// EVENT SIGNATURES - Pre-computed for performance
//
// P2-7 NOTE: Coverage assessment:
// - SWAP_V2 also covers Solidly/Velodrome (same event signature)
// - SWAP_V3 also covers Algebra (same event signature as Uniswap V3)
// - Balancer V2 Swap and Curve TokenExchange/TokenExchangeUnderlying have
//   different signatures but are detected via factory-level subscription in
//   shared/core/src/factory-subscription.ts (FactoryEventSignatures).
//   Their pool swap events are decoded by the unified-detector per-pool.
// =============================================================================
export const EVENT_SIGNATURES = {
  // Uniswap V2 / SushiSwap / Solidly / Velodrome / Camelot V2 style
  // Swap(address sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address to)
  SYNC: '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1',
  SWAP_V2: '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
  // Uniswap V3 / Algebra / PancakeSwap V3 style
  // Swap(address sender, address recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)
  SWAP_V3: '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
  // Curve TokenExchange (StableSwap pools)
  // TokenExchange(address indexed buyer, int128 sold_id, uint256 tokens_sold, int128 bought_id, uint256 tokens_bought)
  CURVE_TOKEN_EXCHANGE: '0x8b3e96f2b889fa771c53c981b40daf005f63f637f1869f707052d15a3dd97140',
  // Curve TokenExchangeUnderlying (lending/metapool)
  CURVE_TOKEN_EXCHANGE_UNDERLYING: '0xd013ca23e77a65003c2c659c5442c00c805371b7fc1ebd4c206c41d1536bd90b',
  // Balancer V2 Swap
  // Swap(bytes32 indexed poolId, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut)
  BALANCER_SWAP: '0x2170c741c41531aec20e7c107c24eecfdd15e69c9bb0a8dd37b1840b9e0b207b',
};
