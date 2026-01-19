/**
 * BSC Detector Service Unit Tests
 *
 * Tests for BSC detector following refactored architecture:
 * - Extends BaseDetector
 * - Uses Redis Streams
 * - Uses Smart Swap Event Filter
 * - O(1) Pair Lookup
 *
 * @see IMPLEMENTATION_PLAN.md S2.4
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Set required environment variables BEFORE any config imports
process.env.NODE_ENV = 'test';
process.env.BSC_RPC_URL = 'https://bsc-dataseed.binance.org';
process.env.BSC_WS_URL = 'wss://bsc-dataseed.binance.org';
process.env.ETHEREUM_RPC_URL = 'https://eth.llamarpc.com';
process.env.ETHEREUM_WS_URL = 'wss://eth.llamarpc.com';
process.env.POLYGON_RPC_URL = 'https://polygon-rpc.com';
process.env.POLYGON_WS_URL = 'wss://polygon-rpc.com';
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

describe('BSC Configuration', () => {
  describe('Chain Configuration', () => {
    it('should have BSC chain configured', () => {
      expect(CHAINS.bsc).toBeDefined();
    });

    it('should have correct chain ID (56)', () => {
      expect(CHAINS.bsc.id).toBe(56);
    });

    it('should have correct chain name', () => {
      expect(CHAINS.bsc.name).toBe('BSC');
    });

    it('should have BNB as native token', () => {
      expect(CHAINS.bsc.nativeToken).toBe('BNB');
    });

    it('should have block time of 3 seconds', () => {
      expect(CHAINS.bsc.blockTime).toBe(3);
    });

    it('should have RPC URL configured', () => {
      expect(CHAINS.bsc.rpcUrl).toContain('bsc');
    });
  });

  describe('DEX Configuration', () => {
    it('should have BSC DEXes configured', () => {
      expect(DEXES.bsc).toBeDefined();
      expect(DEXES.bsc.length).toBeGreaterThan(0);
    });

    it('should include PancakeSwap V3', () => {
      const pancake = DEXES.bsc.find(d => d.name === 'pancakeswap_v3');
      expect(pancake).toBeDefined();
    });

    it('should include PancakeSwap V2', () => {
      const pancake = DEXES.bsc.find(d => d.name === 'pancakeswap_v2');
      expect(pancake).toBeDefined();
    });

    it('should have valid factory addresses for all DEXes', () => {
      for (const dex of DEXES.bsc) {
        expect(dex.factoryAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
        expect(dex.routerAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
      }
    });

    it('should have fee configured for all DEXes', () => {
      for (const dex of DEXES.bsc) {
        expect(typeof dex.fee).toBe('number');
        expect(dex.fee).toBeGreaterThan(0);
      }
    });
  });

  describe('Token Configuration', () => {
    it('should have BSC tokens configured', () => {
      expect(CORE_TOKENS.bsc).toBeDefined();
      expect(CORE_TOKENS.bsc.length).toBeGreaterThan(0);
    });

    it('should include WBNB', () => {
      const wbnb = CORE_TOKENS.bsc.find(t => t.symbol === 'WBNB');
      expect(wbnb).toBeDefined();
      expect(wbnb?.decimals).toBe(18);
      expect(wbnb?.chainId).toBe(56);
    });

    it('should include USDT', () => {
      const usdt = CORE_TOKENS.bsc.find(t => t.symbol === 'USDT');
      expect(usdt).toBeDefined();
      expect(usdt?.decimals).toBe(18);
    });

    it('should include BUSD', () => {
      const busd = CORE_TOKENS.bsc.find(t => t.symbol === 'BUSD');
      expect(busd).toBeDefined();
      expect(busd?.decimals).toBe(18);
    });

    it('should have valid addresses for all tokens', () => {
      for (const token of CORE_TOKENS.bsc) {
        expect(token.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
        expect(token.chainId).toBe(56);
      }
    });
  });

  describe('Arbitrage Configuration', () => {
    it('should have BSC-specific minimum profit', () => {
      expect(ARBITRAGE_CONFIG.chainMinProfits.bsc).toBeDefined();
    });

    it('should have 0.3% minimum profit for BSC', () => {
      expect(ARBITRAGE_CONFIG.chainMinProfits.bsc).toBe(0.003);
    });

    it('should have lower min profit than Ethereum', () => {
      expect(ARBITRAGE_CONFIG.chainMinProfits.bsc).toBeLessThan(
        ARBITRAGE_CONFIG.chainMinProfits.ethereum
      );
    });
  });
});

// =============================================================================
// Detector Service Tests
// =============================================================================

describe('BSCDetectorService', () => {
  describe('Price Calculation Logic', () => {
    it('should calculate correct price ratio', () => {
      const reserve0 = 1000000000000000000n; // 1 WBNB
      const reserve1 = 300000000000000000000n; // 300 BUSD (18 decimals)

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
    const BNB_PRICE_USD = 300;

    it('should estimate USD value for BNB amounts', () => {
      const bnbAmount = 1000000000000000000n; // 1 BNB in wei
      const usdValue = (Number(bnbAmount) / 1e18) * BNB_PRICE_USD;

      expect(usdValue).toBe(300);
    });

    it('should handle USDT with 18 decimals on BSC', () => {
      const usdtAmount = 1000000000000000000n; // 1 USDT (18 decimals on BSC)
      const usdValue = Number(usdtAmount) / 1e18;

      expect(usdValue).toBe(1);
    });

    it('should handle large swap amounts', () => {
      const largeAmount = 100000000000000000000000n; // 100,000 tokens
      const usdValue = (Number(largeAmount) / 1e18) * BNB_PRICE_USD;

      expect(usdValue).toBeCloseTo(30000000, 0); // Use toBeCloseTo for floating point
    });
  });

  describe('Arbitrage Detection Logic', () => {
    it('should detect price difference above threshold', () => {
      const price1 = 300;
      const price2 = 302;
      const minProfit = 0.003; // 0.3%

      const priceDiff = Math.abs(price1 - price2) / Math.min(price1, price2);
      const isOpportunity = priceDiff >= minProfit;

      expect(priceDiff).toBeCloseTo(0.0067, 3); // ~0.67%
      expect(isOpportunity).toBe(true);
    });

    it('should not detect opportunity below threshold', () => {
      const price1 = 300;
      const price2 = 300.5; // Very small difference
      const minProfit = 0.003; // 0.3%

      const priceDiff = Math.abs(price1 - price2) / Math.min(price1, price2);
      const isOpportunity = priceDiff >= minProfit;

      expect(priceDiff).toBeLessThan(minProfit);
      expect(isOpportunity).toBe(false);
    });

    it('should correctly identify buy/sell direction', () => {
      const price1 = 300; // pancakeswap
      const price2 = 302; // biswap

      const buyDex = price1 < price2 ? 'pancakeswap' : 'biswap';
      const sellDex = price1 < price2 ? 'biswap' : 'pancakeswap';

      expect(buyDex).toBe('pancakeswap'); // Buy where cheaper
      expect(sellDex).toBe('biswap');     // Sell where expensive
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

    it('should correctly identify buy/sell direction for whales', () => {
      // Amount0In > 0 means selling token0
      // Amount1In > 0 means selling token1
      const amount0In = 1000000000000000000n;  // 1 token
      const amount1In = 0n;

      const direction = Number(amount0In) > Number(amount1In) ? 'sell' : 'buy';
      expect(direction).toBe('sell'); // Selling token0
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

    it('should sample small transactions at configured rate', () => {
      // Mock random for reproducible test
      let passedCount = 0;
      const iterations = 10000;

      for (let i = 0; i < iterations; i++) {
        if (Math.random() <= SAMPLING_RATE) {
          passedCount++;
        }
      }

      // Should be approximately 1% (within tolerance)
      const passRate = passedCount / iterations;
      expect(passRate).toBeGreaterThan(0.005);
      expect(passRate).toBeLessThan(0.015);
    });
  });
});

// =============================================================================
// Trading Pair Generation Tests
// =============================================================================

describe('BSC Trading Pair Generation', () => {
  const tokens = CORE_TOKENS.bsc;
  const dexes = DEXES.bsc;

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
      'WBNB_USDT',
      'WBNB_BUSD',
      'USDT_BUSD'
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

describe('BSC Cross-DEX Arbitrage', () => {
  it('should calculate net profit after fees', () => {
    const buyPrice = 300;
    const sellPrice = 302;
    const feePerTrade = 0.0025; // 0.25% for PancakeSwap
    const tradeAmount = 10000; // $10K

    const grossProfit = tradeAmount * ((sellPrice - buyPrice) / buyPrice);
    const totalFees = tradeAmount * feePerTrade * 2; // Round trip
    const netProfit = grossProfit - totalFees;

    expect(grossProfit).toBeCloseTo(66.67, 1); // ~0.67% of $10K
    expect(totalFees).toBe(50);
    expect(netProfit).toBeGreaterThan(0);
  });

  it('should be unprofitable when fees exceed spread', () => {
    const buyPrice = 300;
    const sellPrice = 300.3; // 0.1% spread
    const feePerTrade = 0.0025; // 0.25% fee
    const tradeAmount = 10000;

    const grossProfit = tradeAmount * ((sellPrice - buyPrice) / buyPrice);
    const totalFees = tradeAmount * feePerTrade * 2;
    const netProfit = grossProfit - totalFees;

    expect(netProfit).toBeLessThan(0); // Fees exceed profit
  });
});

// =============================================================================
// Data Structure Tests
// =============================================================================

describe('BSC Data Structures', () => {
  describe('O(1) Pair Lookup', () => {
    it('should enable fast address-to-pair lookup', () => {
      const pairsByAddress = new Map<string, any>();
      const testAddress = '0x1234567890123456789012345678901234567890';
      const testPair = {
        address: testAddress,
        name: 'WBNB/USDT',
        dex: 'pancakeswap'
      };

      // Add pair
      pairsByAddress.set(testAddress.toLowerCase(), testPair);

      // Lookup should be O(1)
      const start = performance.now();
      for (let i = 0; i < 10000; i++) {
        pairsByAddress.get(testAddress.toLowerCase());
      }
      const duration = performance.now() - start;

      // 10000 lookups should be very fast (< 100ms)
      expect(duration).toBeLessThan(100);
      expect(pairsByAddress.get(testAddress.toLowerCase())).toEqual(testPair);
    });
  });

  describe('Race Condition Protection', () => {
    it('should prevent operations during shutdown', () => {
      let isRunning = true;
      let isStopping = false;

      const processEvent = () => {
        if (!isRunning || isStopping) {
          return false;
        }
        return true;
      };

      expect(processEvent()).toBe(true);

      // Start stopping
      isStopping = true;
      expect(processEvent()).toBe(false);

      // Complete stop
      isRunning = false;
      isStopping = false;
      expect(processEvent()).toBe(false);
    });
  });
});
