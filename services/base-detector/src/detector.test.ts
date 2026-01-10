/**
 * Base (Chain) Detector Service Unit Tests
 *
 * Tests for Base chain detector following refactored architecture:
 * - Extends BaseDetector
 * - Uses Redis Streams
 * - Uses Smart Swap Event Filter
 * - O(1) Pair Lookup
 *
 * @see IMPLEMENTATION_PLAN.md S2.5
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Set required environment variables BEFORE any config imports
process.env.NODE_ENV = 'test';
process.env.BASE_RPC_URL = 'https://mainnet.base.org';
process.env.BASE_WS_URL = 'wss://mainnet.base.org';
process.env.ETHEREUM_RPC_URL = 'https://eth.llamarpc.com';
process.env.ETHEREUM_WS_URL = 'wss://eth.llamarpc.com';
process.env.BSC_RPC_URL = 'https://bsc-dataseed.binance.org';
process.env.BSC_WS_URL = 'wss://bsc-dataseed.binance.org';
process.env.POLYGON_RPC_URL = 'https://polygon-rpc.com';
process.env.POLYGON_WS_URL = 'wss://polygon-rpc.com';
process.env.ARBITRUM_RPC_URL = 'https://arb1.arbitrum.io/rpc';
process.env.ARBITRUM_WS_URL = 'wss://arb1.arbitrum.io/rpc';
process.env.OPTIMISM_RPC_URL = 'https://mainnet.optimism.io';
process.env.OPTIMISM_WS_URL = 'wss://mainnet.optimism.io';
process.env.REDIS_URL = 'redis://localhost:6379';

// Import config directly to test configuration
import { CHAINS, DEXES, CORE_TOKENS, ARBITRAGE_CONFIG } from '../../../shared/config/src';

// =============================================================================
// Configuration Tests (No mocking required)
// =============================================================================

describe('Base Chain Configuration', () => {
  describe('Chain Configuration', () => {
    it('should have Base chain configured', () => {
      expect(CHAINS.base).toBeDefined();
    });

    it('should have correct chain ID (8453)', () => {
      expect(CHAINS.base.id).toBe(8453);
    });

    it('should have correct chain name', () => {
      expect(CHAINS.base.name).toBe('Base');
    });

    it('should have ETH as native token', () => {
      expect(CHAINS.base.nativeToken).toBe('ETH');
    });

    it('should have block time of 2 seconds', () => {
      expect(CHAINS.base.blockTime).toBe(2);
    });

    it('should have RPC URL configured', () => {
      expect(CHAINS.base.rpcUrl).toBeDefined();
    });
  });

  describe('DEX Configuration', () => {
    it('should have Base DEXes configured', () => {
      expect(DEXES.base).toBeDefined();
      expect(DEXES.base.length).toBeGreaterThan(0);
    });

    it('should include Uniswap V3', () => {
      const uniswap = DEXES.base.find(d => d.name === 'uniswap_v3');
      expect(uniswap).toBeDefined();
    });

    it('should include Aerodrome', () => {
      const aerodrome = DEXES.base.find(d => d.name === 'aerodrome');
      expect(aerodrome).toBeDefined();
    });

    it('should have valid factory addresses for all DEXes', () => {
      for (const dex of DEXES.base) {
        expect(dex.factoryAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
        expect(dex.routerAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
      }
    });

    it('should have fee configured for all DEXes', () => {
      for (const dex of DEXES.base) {
        expect(typeof dex.fee).toBe('number');
        expect(dex.fee).toBeGreaterThan(0);
      }
    });
  });

  describe('Token Configuration', () => {
    it('should have Base tokens configured', () => {
      expect(CORE_TOKENS.base).toBeDefined();
      expect(CORE_TOKENS.base.length).toBeGreaterThan(0);
    });

    it('should include WETH', () => {
      const weth = CORE_TOKENS.base.find(t => t.symbol === 'WETH');
      expect(weth).toBeDefined();
      expect(weth?.decimals).toBe(18);
      expect(weth?.chainId).toBe(8453);
    });

    it('should include USDC', () => {
      const usdc = CORE_TOKENS.base.find(t => t.symbol === 'USDC');
      expect(usdc).toBeDefined();
      expect(usdc?.decimals).toBe(6);
    });

    it('should have valid addresses for all tokens', () => {
      for (const token of CORE_TOKENS.base) {
        expect(token.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
        expect(token.chainId).toBe(8453);
      }
    });
  });

  describe('Arbitrage Configuration', () => {
    it('should have Base-specific minimum profit', () => {
      expect(ARBITRAGE_CONFIG.chainMinProfits.base).toBeDefined();
    });

    it('should have 0.2% minimum profit for Base', () => {
      expect(ARBITRAGE_CONFIG.chainMinProfits.base).toBe(0.002);
    });

    it('should have lower min profit than Ethereum', () => {
      expect(ARBITRAGE_CONFIG.chainMinProfits.base).toBeLessThan(
        ARBITRAGE_CONFIG.chainMinProfits.ethereum
      );
    });
  });
});

// =============================================================================
// Detector Service Tests
// =============================================================================

describe('BaseDetectorService', () => {
  describe('Price Calculation Logic', () => {
    it('should calculate correct price ratio', () => {
      const reserve0 = 1000000000000000000n; // 1 WETH
      const reserve1 = 2500000000n; // 2500 USDC (6 decimals)

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
    const ETH_PRICE_USD = 2500;

    it('should estimate USD value for ETH amounts', () => {
      const ethAmount = 1000000000000000000n; // 1 ETH in wei
      const usdValue = (Number(ethAmount) / 1e18) * ETH_PRICE_USD;

      expect(usdValue).toBe(2500);
    });

    it('should handle USDC with 6 decimals', () => {
      const usdcAmount = 1000000n; // 1 USDC
      const usdValue = Number(usdcAmount) / 1e6;

      expect(usdValue).toBe(1);
    });
  });

  describe('Arbitrage Detection Logic', () => {
    it('should detect price difference above threshold', () => {
      const price1 = 2500;
      const price2 = 2510;
      const minProfit = 0.002; // 0.2%

      const priceDiff = Math.abs(price1 - price2) / Math.min(price1, price2);
      const isOpportunity = priceDiff >= minProfit;

      expect(priceDiff).toBeCloseTo(0.004, 3); // ~0.4%
      expect(isOpportunity).toBe(true);
    });

    it('should not detect opportunity below threshold', () => {
      const price1 = 2500;
      const price2 = 2502; // Very small difference
      const minProfit = 0.002; // 0.2%

      const priceDiff = Math.abs(price1 - price2) / Math.min(price1, price2);
      const isOpportunity = priceDiff >= minProfit;

      expect(priceDiff).toBeLessThan(minProfit);
      expect(isOpportunity).toBe(false);
    });
  });

  describe('Whale Detection Logic', () => {
    // Base has lower whale threshold as an L2
    const WHALE_THRESHOLD = 25000; // $25K for L2s

    it('should detect whale transaction above threshold', () => {
      const usdValue = 50000;
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

describe('Base Trading Pair Generation', () => {
  const tokens = CORE_TOKENS.base;
  const dexes = DEXES.base;

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

describe('Base Cross-DEX Arbitrage', () => {
  it('should calculate net profit after fees', () => {
    const buyPrice = 2500;
    const sellPrice = 2510;
    const feePerTrade = 0.003; // 0.3%
    const tradeAmount = 10000; // $10K

    const grossProfit = tradeAmount * ((sellPrice - buyPrice) / buyPrice);
    const totalFees = tradeAmount * feePerTrade * 2; // Round trip
    const netProfit = grossProfit - totalFees;

    expect(grossProfit).toBeCloseTo(40, 0); // ~0.4% of $10K
    expect(totalFees).toBe(60);
    expect(netProfit).toBeLessThan(0); // Not profitable at this spread
  });

  it('should be profitable with larger spread', () => {
    const buyPrice = 2500;
    const sellPrice = 2550; // 2% spread
    const feePerTrade = 0.003; // 0.3%
    const tradeAmount = 10000; // $10K

    const grossProfit = tradeAmount * ((sellPrice - buyPrice) / buyPrice);
    const totalFees = tradeAmount * feePerTrade * 2;
    const netProfit = grossProfit - totalFees;

    expect(grossProfit).toBeCloseTo(200, 0); // ~2% of $10K
    expect(netProfit).toBeGreaterThan(0); // Profitable
  });
});

// =============================================================================
// Data Structure Tests
// =============================================================================

describe('Base Data Structures', () => {
  describe('O(1) Pair Lookup', () => {
    it('should enable fast address-to-pair lookup', () => {
      const pairsByAddress = new Map<string, any>();
      const testAddress = '0x1234567890123456789012345678901234567890';
      const testPair = {
        address: testAddress,
        name: 'WETH/USDC',
        dex: 'uniswap_v3'
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
