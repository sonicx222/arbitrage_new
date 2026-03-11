/**
 * Live Price Bootstrapper (Batch 1, Task 1.1)
 *
 * Fetches current token prices from CoinGecko free API on simulator startup.
 * Falls back to static BASE_PRICES if the API is unavailable.
 *
 * CoinGecko free tier: 50 requests/minute, no API key required.
 * We batch all tokens into a single request using the /simple/price endpoint.
 *
 * @module simulation
 * @see docs/plans/2026-03-11-simulation-realism-enhancement.md — Task 1.1
 */

import { BASE_PRICES } from './constants';
import { createLogger } from '../logger';

const logger = createLogger('price-bootstrapper');

/** CoinGecko API base URL */
const COINGECKO_API = 'https://api.coingecko.com/api/v3';

/** Request timeout in milliseconds */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Maps token symbols used in BASE_PRICES to CoinGecko coin IDs.
 * Only tokens we actively simulate need mapping.
 */
const SYMBOL_TO_COINGECKO_ID: Record<string, string> = {
  // Major assets
  WETH: 'ethereum',
  ETH: 'ethereum',
  WBTC: 'bitcoin',
  BTCB: 'bitcoin',

  // Native tokens
  WBNB: 'binancecoin',
  BNB: 'binancecoin',
  MATIC: 'matic-network',
  WMATIC: 'matic-network',
  AVAX: 'avalanche-2',
  WAVAX: 'avalanche-2',
  FTM: 'fantom',
  WFTM: 'fantom',
  SOL: 'solana',

  // Stablecoins
  USDC: 'usd-coin',
  USDT: 'tether',
  BUSD: 'binance-usd',
  DAI: 'dai',
  FRAX: 'frax',

  // Governance tokens
  ARB: 'arbitrum',
  OP: 'optimism',
  UNI: 'uniswap',

  // DeFi tokens
  LINK: 'chainlink',
  AAVE: 'aave',
  GMX: 'gmx',
  CRV: 'curve-dao-token',
  PENDLE: 'pendle',

  // LST tokens
  WSTETH: 'wrapped-steth',
  RETH: 'rocket-pool-eth',
  STETH: 'staked-ether',
  CBETH: 'coinbase-wrapped-staked-eth',
  MSOL: 'msol',
  JITOSOL: 'jito-staked-sol',

  // DEX tokens
  CAKE: 'pancakeswap-token',
  JOE: 'joe',
  AERO: 'aerodrome-finance',
  VELO: 'velodrome-finance',

  // Meme tokens
  PEPE: 'pepe',
  SHIB: 'shiba-inu',
  DOGE: 'dogecoin',

  // Solana tokens
  JUP: 'jupiter-exchange-solana',
  RAY: 'raydium',
  ORCA: 'orca',
  BONK: 'bonk',
  WIF: 'dogwifcoin',
  JTO: 'jito-governance-token',
  PYTH: 'pyth-network',

  // Mantle
  MNT: 'mantle',
  WMNT: 'mantle',
};

/**
 * Reverse mapping: CoinGecko ID → all symbol aliases that share it.
 * Built once to efficiently distribute fetched prices.
 */
function buildReverseMap(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [symbol, id] of Object.entries(SYMBOL_TO_COINGECKO_ID)) {
    const existing = map.get(id);
    if (existing) {
      existing.push(symbol);
    } else {
      map.set(id, [symbol]);
    }
  }
  return map;
}

export interface PriceBootstrapResult {
  /** Number of tokens successfully updated from live API */
  updatedCount: number;
  /** Total tokens in BASE_PRICES */
  totalCount: number;
  /** Whether fallback to static prices was used */
  usedFallback: boolean;
  /** Error message if fetch failed */
  error?: string;
}

/**
 * Fetch live prices from CoinGecko and update BASE_PRICES in-place.
 *
 * This is designed to be called once at simulator startup. The function:
 * 1. Collects unique CoinGecko IDs from SYMBOL_TO_COINGECKO_ID
 * 2. Makes a single /simple/price API call
 * 3. Updates BASE_PRICES for all matching symbols
 * 4. Falls back silently if the API is unavailable
 *
 * @returns Bootstrap result with stats
 */
export async function bootstrapLivePrices(): Promise<PriceBootstrapResult> {
  const reverseMap = buildReverseMap();
  const coinIds = [...reverseMap.keys()];

  if (coinIds.length === 0) {
    return { updatedCount: 0, totalCount: Object.keys(BASE_PRICES).length, usedFallback: true };
  }

  try {
    const url = `${COINGECKO_API}/simple/price?ids=${coinIds.join(',')}&vs_currencies=usd`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const errorMsg = `CoinGecko API returned ${response.status}`;
      logger.warn('Price bootstrap failed, using static BASE_PRICES', { error: errorMsg });
      return {
        updatedCount: 0,
        totalCount: Object.keys(BASE_PRICES).length,
        usedFallback: true,
        error: errorMsg,
      };
    }

    const data = await response.json() as Record<string, { usd?: number }>;
    let updatedCount = 0;

    for (const [coinId, priceData] of Object.entries(data)) {
      const usdPrice = priceData?.usd;
      if (typeof usdPrice !== 'number' || !Number.isFinite(usdPrice) || usdPrice <= 0) {
        continue;
      }

      const symbols = reverseMap.get(coinId);
      if (!symbols) continue;

      for (const symbol of symbols) {
        BASE_PRICES[symbol] = usdPrice;
        updatedCount++;
      }
    }

    logger.info('Price bootstrap complete', {
      updatedCount,
      totalTokens: Object.keys(BASE_PRICES).length,
      samplePrices: {
        WETH: BASE_PRICES['WETH'],
        WBTC: BASE_PRICES['WBTC'],
        SOL: BASE_PRICES['SOL'],
      },
    });

    return {
      updatedCount,
      totalCount: Object.keys(BASE_PRICES).length,
      usedFallback: false,
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.warn('Price bootstrap failed, using static BASE_PRICES', { error: errorMsg });
    return {
      updatedCount: 0,
      totalCount: Object.keys(BASE_PRICES).length,
      usedFallback: true,
      error: errorMsg,
    };
  }
}

// Re-export for tests
export { SYMBOL_TO_COINGECKO_ID };
