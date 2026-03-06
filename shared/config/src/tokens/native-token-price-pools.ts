/**
 * DEX Pool Addresses for On-Chain Native Token Pricing
 *
 * Each chain maps to a Uniswap V2-style liquidity pool (NativeToken/Stablecoin)
 * used to fetch real-time native token prices via `getReserves()`.
 *
 * Pool selection criteria:
 * 1. Highest TVL NativeToken/USDC (or NativeToken/USDT) pair on the chain's largest DEX
 * 2. V2-style pair preferred (simpler math than V3 sqrtPriceX96)
 * 3. Minimum $100K TVL threshold for price reliability
 *
 * @see ADR-040: Real-Time Native Token Pricing and Gas Cost Calibration
 * @see shared/core/src/caching/gas-price-cache.ts — consumer of this config
 */

/**
 * Configuration for a single on-chain price pool.
 */
export interface NativeTokenPricePool {
  /** V2-style pair contract address */
  poolAddress: string;
  /** Whether token0 in the pair is the native wrapper (vs stablecoin) */
  token0IsNative: boolean;
  /** Decimals of the stablecoin in the pair (USDC=6, BUSD=18, USDB=18) */
  stablecoinDecimals: number;
  /** Decimals of the native wrapper token (always 18 for EVM chains) */
  nativeDecimals: number;
  /** DEX name for logging/debugging */
  dex: string;
  /** Stablecoin symbol for logging */
  stablecoinSymbol: string;
}

/**
 * Per-chain DEX pool addresses for native token pricing.
 *
 * Chains using ETH as native token (arbitrum, optimism, base, zksync, linea,
 * blast, scroll, mode) share the same underlying price as ethereum — their
 * pools are still listed for independent verification, but the system can
 * fall back to ethereum's price if a chain's pool query fails.
 *
 * Last verified: 2026-03-06
 */
export const NATIVE_TOKEN_PRICE_POOLS: Record<string, NativeTokenPricePool> = {
  ethereum: {
    // Uniswap V2: WETH/USDC — highest TVL ETH pair
    poolAddress: '0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc',
    token0IsNative: false, // token0=USDC, token1=WETH
    stablecoinDecimals: 6,
    nativeDecimals: 18,
    dex: 'Uniswap V2',
    stablecoinSymbol: 'USDC',
  },
  bsc: {
    // PancakeSwap V2: WBNB/BUSD
    poolAddress: '0x58F876857a02D6762E0101bb5C46A8c1ED44Dc16',
    token0IsNative: false, // token0=BUSD, token1=WBNB
    stablecoinDecimals: 18,
    nativeDecimals: 18,
    dex: 'PancakeSwap V2',
    stablecoinSymbol: 'BUSD',
  },
  polygon: {
    // QuickSwap V2: WMATIC/USDC
    poolAddress: '0x6e7a5FAFcec6BB1e78bAE2A1F0B612012BF14827',
    token0IsNative: true, // token0=WMATIC, token1=USDC
    stablecoinDecimals: 6,
    nativeDecimals: 18,
    dex: 'QuickSwap V2',
    stablecoinSymbol: 'USDC',
  },
  avalanche: {
    // TraderJoe V1: WAVAX/USDC
    poolAddress: '0xf4003F4efBE8691B60249E6afbD307aBE7758adb',
    token0IsNative: true, // token0=WAVAX, token1=USDC
    stablecoinDecimals: 6,
    nativeDecimals: 18,
    dex: 'TraderJoe V1',
    stablecoinSymbol: 'USDC',
  },
  fantom: {
    // SpookySwap V2: WFTM/USDC
    poolAddress: '0x2b4C76d0dc16BE1C31D4C1DC53bF9B45987Fc75c',
    token0IsNative: false, // token0=USDC, token1=WFTM
    stablecoinDecimals: 6,
    nativeDecimals: 18,
    dex: 'SpookySwap',
    stablecoinSymbol: 'USDC',
  },
  arbitrum: {
    // Camelot V2: WETH/USDC
    poolAddress: '0x84652bb2539513BAf36e225c930Fdd8eaa63CE27',
    token0IsNative: true, // token0=WETH, token1=USDC
    stablecoinDecimals: 6,
    nativeDecimals: 18,
    dex: 'Camelot V2',
    stablecoinSymbol: 'USDC',
  },
  optimism: {
    // Velodrome V2: WETH/USDC
    poolAddress: '0x0493Bf8b6DBB159Ce2Db2E0E8403E753D8f4b39A',
    token0IsNative: false, // token0=USDC, token1=WETH
    stablecoinDecimals: 6,
    nativeDecimals: 18,
    dex: 'Velodrome V2',
    stablecoinSymbol: 'USDC',
  },
  base: {
    // Aerodrome: WETH/USDC
    poolAddress: '0xcDAC0d6c6C59727a65F871236188350531885C43',
    token0IsNative: false, // token0=USDC, token1=WETH
    stablecoinDecimals: 6,
    nativeDecimals: 18,
    dex: 'Aerodrome',
    stablecoinSymbol: 'USDC',
  },
  zksync: {
    // SyncSwap: WETH/USDC Classic Pool
    poolAddress: '0x80115c708E12eDd42E504c1cD52Aea96C547c05c',
    token0IsNative: true, // token0=WETH, token1=USDC
    stablecoinDecimals: 6,
    nativeDecimals: 18,
    dex: 'SyncSwap',
    stablecoinSymbol: 'USDC',
  },
  linea: {
    // Lynex: WETH/USDC
    poolAddress: '0x58aacbccAeC30938cb2bb11653Cad726e5C4194a',
    token0IsNative: true, // token0=WETH, token1=USDC
    stablecoinDecimals: 6,
    nativeDecimals: 18,
    dex: 'Lynex',
    stablecoinSymbol: 'USDC',
  },
  mantle: {
    // Merchant Moe: WMNT/USDC
    poolAddress: '0x06c017CDd73979F97FAdF44BA86e15F7eC8Fa39e',
    token0IsNative: true, // token0=WMNT, token1=USDC
    stablecoinDecimals: 6,
    nativeDecimals: 18,
    dex: 'Merchant Moe',
    stablecoinSymbol: 'USDC',
  },
  // Chains without reliable V2 pools — will use shared ETH price from ethereum pool:
  // blast, scroll, mode (low TVL V2 pools, high manipulation risk)
};

/** ABI for Uniswap V2-style getReserves() — universal across all V2 forks */
export const V2_PAIR_ABI = [
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
] as const;

/**
 * Chains that share ETH as native token and can fall back to ethereum's price.
 * If their own pool query fails, use ethereum's native token price.
 */
export const ETH_NATIVE_CHAINS = [
  'arbitrum', 'optimism', 'base', 'zksync', 'linea', 'blast', 'scroll', 'mode',
] as const;

/**
 * Minimum TVL in USD for a pool to be considered reliable.
 * Below this threshold, fall back to static NATIVE_TOKEN_PRICES.
 */
export const MIN_POOL_TVL_USD = 100_000;

/**
 * Calculate native token price from V2 pool reserves.
 *
 * @param reserve0 - Reserve of token0
 * @param reserve1 - Reserve of token1
 * @param pool - Pool configuration
 * @returns Native token price in USD, or null if calculation fails
 */
export function calculateNativeTokenPrice(
  reserve0: bigint,
  reserve1: bigint,
  pool: NativeTokenPricePool,
): number | null {
  if (reserve0 === 0n || reserve1 === 0n) return null;

  const nativeReserve = pool.token0IsNative ? reserve0 : reserve1;
  const stableReserve = pool.token0IsNative ? reserve1 : reserve0;

  // Normalize to same decimal scale:
  // price = stableReserve / nativeReserve * (10^nativeDecimals / 10^stableDecimals)
  const decimalDiff = pool.nativeDecimals - pool.stablecoinDecimals;
  const scaleFactor = 10 ** decimalDiff;

  const price = (Number(stableReserve) / Number(nativeReserve)) * scaleFactor;

  // Sanity check: native token price should be between $0.001 and $1,000,000
  if (!Number.isFinite(price) || price < 0.001 || price > 1_000_000) {
    return null;
  }

  return price;
}
