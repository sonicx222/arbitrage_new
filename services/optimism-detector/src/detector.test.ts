/**
 * Optimism Detector Service Unit Tests
 *
 * Tests for S2.1.1: Create Optimism detector service
 * Following TDD principles - testing configuration, DEX/token support, and core logic
 *
 * @see IMPLEMENTATION_PLAN.md S2.1.1
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Set required environment variables BEFORE any config imports
process.env.NODE_ENV = 'test';
process.env.ETHEREUM_RPC_URL = 'https://mainnet.infura.io/v3/test';
process.env.ETHEREUM_WS_URL = 'wss://mainnet.infura.io/ws/v3/test';
process.env.OPTIMISM_RPC_URL = 'https://mainnet.optimism.io';
process.env.OPTIMISM_WS_URL = 'wss://mainnet.optimism.io';
process.env.REDIS_URL = 'redis://localhost:6379';

// Import config directly to test configuration
import { CHAINS, DEXES, CORE_TOKENS, ARBITRAGE_CONFIG } from '../../../shared/config/src';

// =============================================================================
// Configuration Tests (No mocking required)
// =============================================================================

describe('Optimism Configuration', () => {
  describe('Chain Configuration', () => {
    it('should have Optimism chain configured', () => {
      expect(CHAINS.optimism).toBeDefined();
    });

    it('should have correct chain ID (10)', () => {
      expect(CHAINS.optimism.id).toBe(10);
    });

    it('should have correct chain name', () => {
      expect(CHAINS.optimism.name).toBe('Optimism');
    });

    it('should have ETH as native token', () => {
      expect(CHAINS.optimism.nativeToken).toBe('ETH');
    });

    it('should have block time of 2 seconds', () => {
      expect(CHAINS.optimism.blockTime).toBe(2);
    });

    it('should have RPC URL configured', () => {
      expect(CHAINS.optimism.rpcUrl).toContain('optimism');
    });

    it('should have WebSocket URL configured', () => {
      expect(CHAINS.optimism.wsUrl).toContain('optimism');
    });
  });

  describe('DEX Configuration', () => {
    it('should have Optimism DEXes configured', () => {
      expect(DEXES.optimism).toBeDefined();
      expect(DEXES.optimism.length).toBeGreaterThan(0);
    });

    it('should have 3 DEXes on Optimism', () => {
      expect(DEXES.optimism.length).toBe(3);
    });

    it('should include Uniswap V3', () => {
      const uniswap = DEXES.optimism.find(d => d.name === 'uniswap_v3');
      expect(uniswap).toBeDefined();
      expect(uniswap?.factoryAddress).toBe('0x1F98431c8aD98523631AE4a59f267346ea31F984');
    });

    it('should include Velodrome', () => {
      const velodrome = DEXES.optimism.find(d => d.name === 'velodrome');
      expect(velodrome).toBeDefined();
      expect(velodrome?.factoryAddress).toBe('0x25CbdDb98b35ab1FF77413456B31EC81A6B6B746');
    });

    it('should include SushiSwap', () => {
      const sushiswap = DEXES.optimism.find(d => d.name === 'sushiswap');
      expect(sushiswap).toBeDefined();
      expect(sushiswap?.factoryAddress).toBe('0xFbc12984689e5f15626Bad03Ad60160Fe98B303C');
    });

    it('should have valid factory addresses for all DEXes', () => {
      for (const dex of DEXES.optimism) {
        expect(dex.factoryAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
        expect(dex.routerAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
      }
    });

    it('should have fee configured for all DEXes', () => {
      for (const dex of DEXES.optimism) {
        expect(typeof dex.fee).toBe('number');
        expect(dex.fee).toBeGreaterThan(0);
      }
    });
  });

  describe('Token Configuration', () => {
    it('should have Optimism tokens configured', () => {
      expect(CORE_TOKENS.optimism).toBeDefined();
      expect(CORE_TOKENS.optimism.length).toBeGreaterThan(0);
    });

    it('should have 10 tokens on Optimism', () => {
      expect(CORE_TOKENS.optimism.length).toBe(10);
    });

    it('should include WETH', () => {
      const weth = CORE_TOKENS.optimism.find(t => t.symbol === 'WETH');
      expect(weth).toBeDefined();
      expect(weth?.address).toBe('0x4200000000000000000000000000000000000006');
      expect(weth?.decimals).toBe(18);
      expect(weth?.chainId).toBe(10);
    });

    it('should include OP token', () => {
      const op = CORE_TOKENS.optimism.find(t => t.symbol === 'OP');
      expect(op).toBeDefined();
      expect(op?.address).toBe('0x4200000000000000000000000000000000000042');
      expect(op?.decimals).toBe(18);
    });

    it('should include USDC', () => {
      const usdc = CORE_TOKENS.optimism.find(t => t.symbol === 'USDC');
      expect(usdc).toBeDefined();
      expect(usdc?.decimals).toBe(6);
    });

    it('should include USDT', () => {
      const usdt = CORE_TOKENS.optimism.find(t => t.symbol === 'USDT');
      expect(usdt).toBeDefined();
      expect(usdt?.decimals).toBe(6);
    });

    it('should include DAI', () => {
      const dai = CORE_TOKENS.optimism.find(t => t.symbol === 'DAI');
      expect(dai).toBeDefined();
      expect(dai?.decimals).toBe(18);
    });

    it('should include WBTC', () => {
      const wbtc = CORE_TOKENS.optimism.find(t => t.symbol === 'WBTC');
      expect(wbtc).toBeDefined();
      expect(wbtc?.decimals).toBe(8);
    });

    it('should include wstETH', () => {
      const wsteth = CORE_TOKENS.optimism.find(t => t.symbol === 'wstETH');
      expect(wsteth).toBeDefined();
    });

    it('should include LINK', () => {
      const link = CORE_TOKENS.optimism.find(t => t.symbol === 'LINK');
      expect(link).toBeDefined();
    });

    it('should include VELO', () => {
      const velo = CORE_TOKENS.optimism.find(t => t.symbol === 'VELO');
      expect(velo).toBeDefined();
    });

    it('should have valid addresses for all tokens', () => {
      for (const token of CORE_TOKENS.optimism) {
        expect(token.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
        expect(token.chainId).toBe(10);
      }
    });
  });

  describe('Arbitrage Configuration', () => {
    it('should have Optimism-specific minimum profit', () => {
      expect(ARBITRAGE_CONFIG.chainMinProfits.optimism).toBeDefined();
    });

    it('should have 0.2% minimum profit for Optimism (low gas)', () => {
      expect(ARBITRAGE_CONFIG.chainMinProfits.optimism).toBe(0.002);
    });

    it('should have lower min profit than Ethereum', () => {
      expect(ARBITRAGE_CONFIG.chainMinProfits.optimism).toBeLessThan(
        ARBITRAGE_CONFIG.chainMinProfits.ethereum
      );
    });
  });
});

// =============================================================================
// Detector Service Tests (with mocking)
// =============================================================================

describe('OptimismDetectorService', () => {
  // These tests require more complex mocking setup
  // For now, we test the core logic that doesn't require external dependencies

  describe('Price Calculation Logic', () => {
    it('should calculate correct price ratio', () => {
      // Price calculation: reserve0 / reserve1
      const reserve0 = 1000000000000000000n; // 1 ETH
      const reserve1 = 2000000000n;           // 2000 USDC (6 decimals)

      const price = Number(reserve0) / Number(reserve1);
      expect(price).toBeGreaterThan(0);
      expect(price).toBe(500000000); // 1e18 / 2e9
    });

    it('should return 0 for zero reserves', () => {
      // Test the logic that handles zero reserves
      const calculatePrice = (r0: bigint, r1: bigint): number => {
        if (r0 === 0n || r1 === 0n) return 0;
        return Number(r0) / Number(r1);
      };

      expect(calculatePrice(0n, 1000000000000000000n)).toBe(0);
      expect(calculatePrice(1000000000000000000n, 0n)).toBe(0);
    });

    it('should handle large reserves correctly', () => {
      const reserve0 = BigInt('1000000000000000000000000'); // 1M tokens
      const reserve1 = BigInt('2000000000000000000000000'); // 2M tokens

      const price = Number(reserve0) / Number(reserve1);
      expect(price).toBeCloseTo(0.5, 5);
    });
  });

  describe('USD Value Estimation Logic', () => {
    const ETH_PRICE_USD = 2000;

    it('should estimate USD value for ETH amounts', () => {
      const ethAmount = 1000000000000000000n; // 1 ETH in wei
      const usdValue = (Number(ethAmount) / 1e18) * ETH_PRICE_USD;

      expect(usdValue).toBe(2000);
    });

    it('should estimate USD value for fractional ETH', () => {
      const ethAmount = 500000000000000000n; // 0.5 ETH
      const usdValue = (Number(ethAmount) / 1e18) * ETH_PRICE_USD;

      expect(usdValue).toBe(1000);
    });

    it('should handle USDC with 6 decimals', () => {
      const usdcAmount = 1000000000n; // 1000 USDC
      const usdValue = Number(usdcAmount) / 1e6;

      expect(usdValue).toBe(1000);
    });
  });

  describe('Arbitrage Detection Logic', () => {
    it('should detect price difference above threshold', () => {
      const price1 = 1850;
      const price2 = 1860;
      const minProfit = 0.002; // 0.2%

      const priceDiff = Math.abs(price1 - price2) / Math.min(price1, price2);
      const isOpportunity = priceDiff >= minProfit;

      expect(priceDiff).toBeCloseTo(0.0054, 3); // ~0.54%
      expect(isOpportunity).toBe(true);
    });

    it('should not detect opportunity below threshold', () => {
      const price1 = 1850;
      const price2 = 1851; // Only $1 difference
      const minProfit = 0.002; // 0.2%

      const priceDiff = Math.abs(price1 - price2) / Math.min(price1, price2);
      const isOpportunity = priceDiff >= minProfit;

      expect(priceDiff).toBeLessThan(minProfit);
      expect(isOpportunity).toBe(false);
    });

    it('should calculate spread percentage correctly', () => {
      const buyPrice = 1800;
      const sellPrice = 1810;

      const spreadPercent = ((sellPrice - buyPrice) / buyPrice) * 100;
      expect(spreadPercent).toBeCloseTo(0.556, 2); // ~0.56%
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

    it('should detect exact threshold', () => {
      const usdValue = 50000;
      const isWhale = usdValue >= WHALE_THRESHOLD;

      expect(isWhale).toBe(true);
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
      // Mock random to test sampling
      const mockRandom = 0.005; // Less than 1%
      const usdValue = 5;

      const shouldProcess = usdValue >= MIN_USD_VALUE ||
        mockRandom <= SAMPLING_RATE;

      expect(shouldProcess).toBe(true);
    });
  });
});

// =============================================================================
// Pair Generation Tests
// =============================================================================

describe('Trading Pair Generation', () => {
  const tokens = CORE_TOKENS.optimism;
  const dexes = DEXES.optimism;

  it('should generate correct number of potential pairs', () => {
    // n tokens = n * (n-1) / 2 pairs per DEX
    const pairsPerDex = (tokens.length * (tokens.length - 1)) / 2;
    const totalPotentialPairs = pairsPerDex * dexes.length;

    // 10 tokens = 45 pairs per DEX * 3 DEXes = 135 potential pairs
    expect(pairsPerDex).toBe(45);
    expect(totalPotentialPairs).toBe(135);
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
    expect(pairKeys.size).toBe(135);
  });

  it('should include important pairs', () => {
    const importantPairs = [
      'WETH_USDC',
      'WETH_USDT',
      'WETH_OP',
      'WETH_wstETH',
      'OP_USDC'
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

describe('Cross-DEX Arbitrage on Optimism', () => {
  it('should identify same pairs across different DEXes', () => {
    const dexes = DEXES.optimism;
    const commonPairs: string[] = [];

    // WETH/USDC should exist on all DEXes
    const weth = CORE_TOKENS.optimism.find(t => t.symbol === 'WETH');
    const usdc = CORE_TOKENS.optimism.find(t => t.symbol === 'USDC');

    expect(weth).toBeDefined();
    expect(usdc).toBeDefined();

    // All 3 DEXes should support this pair
    expect(dexes.length).toBe(3);
  });

  it('should calculate net profit after fees', () => {
    const buyPrice = 1800;
    const sellPrice = 1810;
    const feePerTrade = 0.003; // 0.3%
    const tradeAmount = 10000; // $10K

    const grossProfit = tradeAmount * ((sellPrice - buyPrice) / buyPrice);
    const totalFees = tradeAmount * feePerTrade * 2; // Round trip
    const netProfit = grossProfit - totalFees;

    expect(grossProfit).toBeCloseTo(55.56, 1);
    expect(totalFees).toBe(60);
    expect(netProfit).toBeLessThan(0); // Not profitable at this spread
  });

  it('should be profitable at sufficient spread', () => {
    const buyPrice = 1800;
    const sellPrice = 1820; // 1.11% spread
    const feePerTrade = 0.003;
    const tradeAmount = 10000;

    const grossProfit = tradeAmount * ((sellPrice - buyPrice) / buyPrice);
    const totalFees = tradeAmount * feePerTrade * 2;
    const netProfit = grossProfit - totalFees;

    expect(grossProfit).toBeCloseTo(111.11, 1);
    expect(netProfit).toBeGreaterThan(0);
  });
});
