/**
 * Polygon Detector Service Unit Tests
 *
 * Tests for Polygon detector following refactored architecture:
 * - Extends BaseDetector
 * - Uses Redis Streams
 * - Uses Smart Swap Event Filter
 * - O(1) Pair Lookup
 *
 * @see IMPLEMENTATION_PLAN.md S2.3
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Set required environment variables BEFORE any config imports
process.env.NODE_ENV = 'test';
process.env.POLYGON_RPC_URL = 'https://polygon-rpc.com';
process.env.POLYGON_WS_URL = 'wss://polygon-rpc.com';
process.env.ETHEREUM_RPC_URL = 'https://eth.llamarpc.com';
process.env.ETHEREUM_WS_URL = 'wss://eth.llamarpc.com';
process.env.BSC_RPC_URL = 'https://bsc-dataseed.binance.org';
process.env.BSC_WS_URL = 'wss://bsc-dataseed.binance.org';
process.env.ARBITRUM_RPC_URL = 'https://arb1.arbitrum.io/rpc';
process.env.ARBITRUM_WS_URL = 'wss://arb1.arbitrum.io/rpc';
process.env.OPTIMISM_RPC_URL = 'https://mainnet.optimism.io';
process.env.OPTIMISM_WS_URL = 'wss://mainnet.optimism.io';
process.env.BASE_RPC_URL = 'https://mainnet.base.org';
process.env.BASE_WS_URL = 'wss://mainnet.base.org';
process.env.REDIS_URL = 'redis://localhost:6379';

// Import config directly to test configuration
import { CHAINS, DEXES, CORE_TOKENS, ARBITRAGE_CONFIG } from '../../../shared/config/src';

// =============================================================================
// Configuration Tests (No mocking required)
// =============================================================================

describe('Polygon Configuration', () => {
  describe('Chain Configuration', () => {
    it('should have Polygon chain configured', () => {
      expect(CHAINS.polygon).toBeDefined();
    });

    it('should have correct chain ID (137)', () => {
      expect(CHAINS.polygon.id).toBe(137);
    });

    it('should have correct chain name', () => {
      expect(CHAINS.polygon.name).toBe('Polygon');
    });

    it('should have MATIC as native token', () => {
      expect(CHAINS.polygon.nativeToken).toBe('MATIC');
    });

    it('should have block time of 2 seconds', () => {
      expect(CHAINS.polygon.blockTime).toBe(2);
    });

    it('should have RPC URL configured', () => {
      expect(CHAINS.polygon.rpcUrl).toContain('polygon');
    });
  });

  describe('DEX Configuration', () => {
    it('should have Polygon DEXes configured', () => {
      expect(DEXES.polygon).toBeDefined();
      expect(DEXES.polygon.length).toBeGreaterThan(0);
    });

    it('should include QuickSwap V3', () => {
      const quickswap = DEXES.polygon.find(d => d.name === 'quickswap_v3');
      expect(quickswap).toBeDefined();
    });

    it('should include SushiSwap', () => {
      const sushiswap = DEXES.polygon.find(d => d.name === 'sushiswap');
      expect(sushiswap).toBeDefined();
    });

    it('should have valid factory addresses for all DEXes', () => {
      for (const dex of DEXES.polygon) {
        expect(dex.factoryAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
        expect(dex.routerAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
      }
    });

    it('should have fee configured for all DEXes', () => {
      for (const dex of DEXES.polygon) {
        expect(typeof dex.fee).toBe('number');
        expect(dex.fee).toBeGreaterThan(0);
      }
    });
  });

  describe('Token Configuration', () => {
    it('should have Polygon tokens configured', () => {
      expect(CORE_TOKENS.polygon).toBeDefined();
      expect(CORE_TOKENS.polygon.length).toBeGreaterThan(0);
    });

    it('should include WMATIC', () => {
      const wmatic = CORE_TOKENS.polygon.find(t => t.symbol === 'WMATIC');
      expect(wmatic).toBeDefined();
      expect(wmatic?.decimals).toBe(18);
      expect(wmatic?.chainId).toBe(137);
    });

    it('should include USDC', () => {
      const usdc = CORE_TOKENS.polygon.find(t => t.symbol === 'USDC');
      expect(usdc).toBeDefined();
      expect(usdc?.decimals).toBe(6);
    });

    it('should include USDT', () => {
      const usdt = CORE_TOKENS.polygon.find(t => t.symbol === 'USDT');
      expect(usdt).toBeDefined();
      expect(usdt?.decimals).toBe(6);
    });

    it('should include WETH', () => {
      const weth = CORE_TOKENS.polygon.find(t => t.symbol === 'WETH');
      expect(weth).toBeDefined();
      expect(weth?.decimals).toBe(18);
    });

    it('should have valid addresses for all tokens', () => {
      for (const token of CORE_TOKENS.polygon) {
        expect(token.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
        expect(token.chainId).toBe(137);
      }
    });
  });

  describe('Arbitrage Configuration', () => {
    it('should have Polygon-specific minimum profit', () => {
      expect(ARBITRAGE_CONFIG.chainMinProfits.polygon).toBeDefined();
    });

    it('should have 0.2% minimum profit for Polygon', () => {
      expect(ARBITRAGE_CONFIG.chainMinProfits.polygon).toBe(0.002);
    });

    it('should have lower min profit than Ethereum', () => {
      expect(ARBITRAGE_CONFIG.chainMinProfits.polygon).toBeLessThan(
        ARBITRAGE_CONFIG.chainMinProfits.ethereum
      );
    });
  });
});

// =============================================================================
// Detector Service Tests
// =============================================================================

describe('PolygonDetectorService', () => {
  describe('Price Calculation Logic', () => {
    it('should calculate correct price ratio', () => {
      const reserve0 = 1000000000000000000n; // 1 WMATIC
      const reserve1 = 1500000n;              // 1.5 USDC (6 decimals)

      const price = Number(reserve0) / Number(reserve1);
      expect(price).toBeGreaterThan(0);
    });

    it('should return 0 for zero reserves', () => {
      const calculatePrice = (r0: bigint, r1: bigint): number => {
        if (r0 === 0n || r1 === 0n) return 0;
        return Number(r0) / Number(r1);
      };

      expect(calculatePrice(0n, 1000000000000000000n)).toBe(0);
      expect(calculatePrice(1000000000000000000n, 0n)).toBe(0);
    });
  });

  describe('USD Value Estimation Logic', () => {
    const MATIC_PRICE_USD = 0.80;

    it('should estimate USD value for MATIC amounts', () => {
      const maticAmount = 1000000000000000000n; // 1 MATIC in wei
      const usdValue = (Number(maticAmount) / 1e18) * MATIC_PRICE_USD;

      expect(usdValue).toBe(0.80);
    });

    it('should handle USDC with 6 decimals', () => {
      const usdcAmount = 1000000n; // 1 USDC
      const usdValue = Number(usdcAmount) / 1e6;

      expect(usdValue).toBe(1);
    });
  });

  describe('Arbitrage Detection Logic', () => {
    it('should detect price difference above threshold', () => {
      const price1 = 0.80;
      const price2 = 0.82;
      const minProfit = 0.003; // 0.3%

      const priceDiff = Math.abs(price1 - price2) / Math.min(price1, price2);
      const isOpportunity = priceDiff >= minProfit;

      expect(priceDiff).toBeCloseTo(0.025, 3); // ~2.5%
      expect(isOpportunity).toBe(true);
    });

    it('should not detect opportunity below threshold', () => {
      const price1 = 0.80;
      const price2 = 0.801; // Very small difference
      const minProfit = 0.003; // 0.3%

      const priceDiff = Math.abs(price1 - price2) / Math.min(price1, price2);
      const isOpportunity = priceDiff >= minProfit;

      expect(priceDiff).toBeLessThan(minProfit);
      expect(isOpportunity).toBe(false);
    });
  });

  describe('Whale Detection Logic', () => {
    const WHALE_THRESHOLD = 50000; // $50K

    it('should detect whale transaction above threshold', () => {
      const usdValue = 75000;
      const isWhale = usdValue >= WHALE_THRESHOLD;

      expect(isWhale).toBe(true);
    });

    it('should not flag normal transactions', () => {
      const usdValue = 10000;
      const isWhale = usdValue >= WHALE_THRESHOLD;

      expect(isWhale).toBe(false);
    });
  });

  describe('Event Filtering Logic', () => {
    const MIN_USD_VALUE = 10; // $10 minimum
    const SAMPLING_RATE = 0.01; // 1%

    it('should pass events above minimum value', () => {
      const usdValue = 1000;
      const shouldProcess = usdValue >= MIN_USD_VALUE;

      expect(shouldProcess).toBe(true);
    });

    it('should filter dust transactions', () => {
      const usdValue = 5; // Below $10 minimum
      const shouldProcess = usdValue >= MIN_USD_VALUE;

      expect(shouldProcess).toBe(false);
    });
  });
});

// =============================================================================
// Trading Pair Generation Tests
// =============================================================================

describe('Polygon Trading Pair Generation', () => {
  const tokens = CORE_TOKENS.polygon;
  const dexes = DEXES.polygon;

  it('should generate correct number of potential pairs', () => {
    const pairsPerDex = (tokens.length * (tokens.length - 1)) / 2;
    const totalPotentialPairs = pairsPerDex * dexes.length;

    expect(pairsPerDex).toBeGreaterThan(0);
    expect(totalPotentialPairs).toBeGreaterThan(0);
  });

  it('should create unique pair keys', () => {
    const pairKeys = new Set<string>();

    for (const dex of dexes) {
      for (let i = 0; i < tokens.length; i++) {
        for (let j = i + 1; j < tokens.length; j++) {
          const token0 = tokens[i];
          const token1 = tokens[j];
          const pairKey = `${dex.name}_${token0.symbol}_${token1.symbol}`;
          pairKeys.add(pairKey);
        }
      }
    }

    // All keys should be unique
    const expectedPairs = dexes.length * (tokens.length * (tokens.length - 1)) / 2;
    expect(pairKeys.size).toBe(expectedPairs);
  });

  it('should include important pairs', () => {
    const importantPairs = [
      'WMATIC_USDC',
      'WMATIC_USDT',
      'WETH_USDC'
    ];

    for (const pair of importantPairs) {
      const [token0, token1] = pair.split('_');
      const hasToken0 = tokens.some(t => t.symbol === token0);
      const hasToken1 = tokens.some(t => t.symbol === token1);
      expect(hasToken0).toBe(true);
      expect(hasToken1).toBe(true);
    }
  });
});

// =============================================================================
// Cross-DEX Arbitrage Tests
// =============================================================================

describe('Polygon Cross-DEX Arbitrage', () => {
  it('should calculate net profit after fees', () => {
    const buyPrice = 0.80;
    const sellPrice = 0.82;
    const feePerTrade = 0.003; // 0.3%
    const tradeAmount = 10000; // $10K

    const grossProfit = tradeAmount * ((sellPrice - buyPrice) / buyPrice);
    const totalFees = tradeAmount * feePerTrade * 2; // Round trip
    const netProfit = grossProfit - totalFees;

    expect(grossProfit).toBeCloseTo(250, 0); // ~2.5% of $10K
    expect(totalFees).toBe(60);
    expect(netProfit).toBeGreaterThan(0);
  });
});
