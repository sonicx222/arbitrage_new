/**
 * Test Data Factories
 *
 * Creates realistic test data for integration tests.
 * Uses real mainnet addresses for authenticity.
 */

import type { PriceUpdate, ArbitrageOpportunity } from '@arbitrage/types';

/**
 * Well-known token addresses on Ethereum mainnet
 */
export const TEST_TOKENS = {
  WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  DAI: '0x6B175474E89094C44Da98b954EesdfDcD5F72dB',
  WBTC: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
} as const;

/**
 * Well-known pair addresses on Ethereum mainnet
 */
export const TEST_PAIRS = {
  UNISWAP_V3_WETH_USDC: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640',
  SUSHISWAP_WETH_USDC: '0x397FF1542f962076d0BFE58eA045FfA2d347ACa0',
  UNISWAP_V2_WETH_USDC: '0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc',
} as const;

/**
 * Create a test price update
 */
export function createTestPriceUpdate(overrides: Partial<PriceUpdate> = {}): PriceUpdate {
  return {
    pairKey: 'UNISWAP_V3_WETH_USDC',
    pairAddress: TEST_PAIRS.UNISWAP_V3_WETH_USDC,
    dex: 'uniswap_v3',
    chain: 'ethereum',
    token0: TEST_TOKENS.WETH,
    token1: TEST_TOKENS.USDC,
    price: 2500,
    reserve0: '1000000000000000000000', // 1000 WETH
    reserve1: '2500000000000', // 2.5M USDC (6 decimals)
    blockNumber: 18000000,
    timestamp: Date.now(),
    latency: 50,
    ...overrides,
  };
}

/**
 * Create a test arbitrage opportunity
 */
export function createTestOpportunity(overrides: Partial<ArbitrageOpportunity> = {}): ArbitrageOpportunity {
  return {
    id: `opp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type: 'cross-dex',
    chain: 'ethereum',
    buyDex: 'uniswap_v3',
    sellDex: 'sushiswap',
    buyPair: TEST_PAIRS.UNISWAP_V3_WETH_USDC,
    sellPair: TEST_PAIRS.SUSHISWAP_WETH_USDC,
    tokenIn: TEST_TOKENS.WETH,
    tokenOut: TEST_TOKENS.USDC,
    buyPrice: 2500,
    sellPrice: 2520,
    expectedProfit: 20,
    confidence: 0.85,
    timestamp: Date.now(),
    expiresAt: Date.now() + 30000,
    ...overrides,
  };
}

/**
 * Create a scenario that should trigger arbitrage detection
 *
 * Returns price updates for two DEXs with significant price difference.
 * Uses different pair addresses for each DEX to properly simulate real conditions.
 */
export function createArbitrageScenario(options: {
  chain?: string;
  priceDiffPercent?: number;
} = {}): { lowPriceUpdate: PriceUpdate; highPriceUpdate: PriceUpdate } {
  const { chain = 'ethereum', priceDiffPercent = 2 } = options;
  const basePrice = 2500;
  const priceDiff = basePrice * (priceDiffPercent / 100);

  return {
    lowPriceUpdate: createTestPriceUpdate({
      chain,
      dex: 'sushiswap',
      pairKey: 'SUSHISWAP_WETH_USDC',
      pairAddress: TEST_PAIRS.SUSHISWAP_WETH_USDC, // Use SushiSwap pair address
      price: basePrice,
    }),
    highPriceUpdate: createTestPriceUpdate({
      chain,
      dex: 'uniswap_v3',
      pairKey: 'UNISWAP_V3_WETH_USDC',
      pairAddress: TEST_PAIRS.UNISWAP_V3_WETH_USDC, // Use Uniswap V3 pair address
      price: basePrice + priceDiff,
    }),
  };
}
