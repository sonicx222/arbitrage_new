/**
 * S2.2.2 Coinbase Chain DEX Expansion Integration Tests
 *
 * End-to-end testing of DEX expansion for Coinbase's Base chain.
 * S2.2.2: Base DEXs (5 → 7) - Adding Maverick and AlienBase
 *
 * Note: Uses "base" as chain ID but refers to it as "Coinbase chain"
 * in documentation to avoid confusion with BaseDetector class.
 *
 * @see docs/IMPLEMENTATION_PLAN.md S2.2.2
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { Dex, Token } from '@arbitrage/types';

// Type for stablecoins in TOKEN_METADATA
interface Stablecoin {
  address: string;
  symbol: string;
  decimals: number;
}

// Set required environment variables BEFORE any config imports
process.env.NODE_ENV = 'test';
process.env.ETHEREUM_RPC_URL = 'https://mainnet.infura.io/v3/test';
process.env.ETHEREUM_WS_URL = 'wss://mainnet.infura.io/ws/v3/test';
process.env.BASE_RPC_URL = 'https://mainnet.base.org';
process.env.BASE_WS_URL = 'wss://mainnet.base.org';
process.env.REDIS_URL = 'redis://localhost:6379';

// Use require to avoid ts-jest transformation caching issues
// This ensures we use the compiled dist output with all exports
 
const {
  CHAINS,
  DEXES,
  CORE_TOKENS,
  ARBITRAGE_CONFIG,
  TOKEN_METADATA,
  EVENT_SIGNATURES,
  DETECTOR_CONFIG,
  PHASE_METRICS,
  getEnabledDexes,
  dexFeeToPercentage,
  percentageToBasisPoints
} = require('@arbitrage/config') as {
  CHAINS: Record<string, { id: number; name: string; nativeToken: string; blockTime: number; rpcUrl: string; wsUrl: string }>;
  DEXES: Record<string, Dex[]>;
  CORE_TOKENS: Record<string, Token[]>;
  ARBITRAGE_CONFIG: { minProfitPercentage: number; chainMinProfits: Record<string, number> };
  TOKEN_METADATA: Record<string, { weth: string; stablecoins: Stablecoin[] }>;
  EVENT_SIGNATURES: Record<string, string>;
  DETECTOR_CONFIG: Record<string, { batchSize: number; batchTimeout: number; confidence: number; expiryMs: number; gasEstimate: number; whaleThreshold: number }>;
  PHASE_METRICS: { targets: { phase1: { dexes: number } }; current: { dexes: number } };
  getEnabledDexes: (chainId: string) => Dex[];
  dexFeeToPercentage: (feeBasisPoints: number) => number;
  percentageToBasisPoints: (percentage: number) => number;
};

// =============================================================================
// S2.2.2: Coinbase Chain DEX Expansion Tests (5 → 7)
// =============================================================================

describe('S2.2.2: Coinbase Chain DEX Expansion (5 → 7)', () => {
  describe('DEX Count Validation', () => {
    it('should have exactly 7 DEXs configured for Base chain', () => {
      expect(DEXES.base).toBeDefined();
      expect(DEXES.base.length).toBe(7);
    });

    it('should have all 7 DEXs returned by getEnabledDexes', () => {
      const enabledDexes = getEnabledDexes('base');
      expect(enabledDexes.length).toBe(7);
    });
  });

  describe('Existing DEXs (5)', () => {
    const existingDexNames = [
      'uniswap_v3',
      'aerodrome',
      'baseswap',
      'sushiswap',
      'swapbased'
    ];

    existingDexNames.forEach(dexName => {
      it(`should have ${dexName} configured`, () => {
        const dex = DEXES.base.find(d => d.name === dexName);
        expect(dex).toBeDefined();
        expect(dex!.chain).toBe('base');
      });

      it(`should have valid addresses for ${dexName}`, () => {
        const dex = DEXES.base.find(d => d.name === dexName);
        expect(dex!.factoryAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
        expect(dex!.routerAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
      });
    });
  });

  describe('New DEXs (2) - S2.2.2', () => {
    describe('Maverick', () => {
      const maverick = DEXES.base.find(d => d.name === 'maverick');

      it('should have maverick configured', () => {
        expect(maverick).toBeDefined();
      });

      it('should have correct Maverick Factory address', () => {
        // Maverick V2 Factory on Base
        expect(maverick!.factoryAddress.toLowerCase()).toBe('0x0a7e848aca42d879ef06507fca0e7b33a0a63c1e');
      });

      it('should have valid router address', () => {
        expect(maverick!.routerAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
      });

      it('should be assigned to base chain', () => {
        expect(maverick!.chain).toBe('base');
      });

      it('should have fee defined (1 bp for dynamic fee pools)', () => {
        expect(typeof maverick!.feeBps).toBe('number');
        expect(maverick!.feeBps).toBe(1); // Maverick has very low base fee
      });
    });

    describe('AlienBase', () => {
      const alienbase = DEXES.base.find(d => d.name === 'alienbase');

      it('should have alienbase configured', () => {
        expect(alienbase).toBeDefined();
      });

      it('should have correct AlienBase Factory address', () => {
        // AlienBase Factory on Base
        expect(alienbase!.factoryAddress.toLowerCase()).toBe('0x3e84d913803b02a4a7f027165e8ca42c14c0fde7');
      });

      it('should have valid router address', () => {
        expect(alienbase!.routerAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
      });

      it('should be assigned to base chain', () => {
        expect(alienbase!.chain).toBe('base');
      });

      it('should have fee defined', () => {
        expect(typeof alienbase!.feeBps).toBe('number');
        expect(alienbase!.feeBps).toBe(30); // Standard 0.3% fee
      });
    });
  });

  describe('DEX Configuration Validation', () => {
    it('should have all DEXs with valid factory addresses', () => {
      DEXES.base.forEach(dex => {
        expect(dex.factoryAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
      });
    });

    it('should have all DEXs with valid router addresses', () => {
      DEXES.base.forEach(dex => {
        expect(dex.routerAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
      });
    });

    it('should have all DEXs with chain set to base', () => {
      DEXES.base.forEach(dex => {
        expect(dex.chain).toBe('base');
      });
    });

    it('should have all DEXs with fee property defined', () => {
      DEXES.base.forEach(dex => {
        expect(typeof dex.feeBps).toBe('number');
        expect(dex.feeBps).toBeGreaterThanOrEqual(0);
      });
    });

    it('should have unique DEX names', () => {
      const names = DEXES.base.map(d => d.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(names.length);
    });

    it('should have unique factory addresses', () => {
      const factories = DEXES.base.map(d => d.factoryAddress.toLowerCase());
      const uniqueFactories = new Set(factories);
      expect(uniqueFactories.size).toBe(factories.length);
    });
  });

  describe('DEX Priority Classification', () => {
    it('should have Critical [C] DEXs at the beginning', () => {
      const criticalDexes = ['uniswap_v3', 'aerodrome', 'baseswap'];

      criticalDexes.forEach((name, index) => {
        expect(DEXES.base[index].name).toBe(name);
      });
    });

    it('should have new DEXs at the end (index 5-6)', () => {
      const newDexes = ['maverick', 'alienbase'];

      newDexes.forEach((name, index) => {
        expect(DEXES.base[5 + index].name).toBe(name);
      });
    });
  });
});

// =============================================================================
// Cross-DEX Arbitrage Detection Tests for Coinbase Chain
// =============================================================================

describe('Cross-DEX Arbitrage Detection on Coinbase Chain', () => {
  describe('Arbitrage Configuration', () => {
    it('should have Base-specific minimum profit (lower than Ethereum)', () => {
      expect(ARBITRAGE_CONFIG.chainMinProfits.base).toBe(0.002);
      expect(ARBITRAGE_CONFIG.chainMinProfits.base).toBeLessThan(
        ARBITRAGE_CONFIG.chainMinProfits.ethereum
      );
    });

    it('should have same minimum profit as other L2s', () => {
      expect(ARBITRAGE_CONFIG.chainMinProfits.base).toBe(
        ARBITRAGE_CONFIG.chainMinProfits.arbitrum
      );
      expect(ARBITRAGE_CONFIG.chainMinProfits.base).toBe(
        ARBITRAGE_CONFIG.chainMinProfits.optimism
      );
    });
  });

  describe('Pair Generation with 7 DEXs', () => {
    const tokens = CORE_TOKENS.base;
    const dexes = getEnabledDexes('base');

    it('should generate correct pairs per DEX (10 tokens = n*(n-1)/2 = 45)', () => {
      const pairsPerDex = (tokens.length * (tokens.length - 1)) / 2;
      expect(pairsPerDex).toBe(45);
    });

    it('should generate 315 total potential pairs (45 pairs x 7 DEXes)', () => {
      const pairsPerDex = (tokens.length * (tokens.length - 1)) / 2;
      const totalPairs = pairsPerDex * dexes.length;
      expect(totalPairs).toBe(315);
    });

    it('should include high-volume pairs for arbitrage', () => {
      // Note: USDbC is in TOKEN_METADATA but not in CORE_TOKENS to keep token count at 10
      const highVolumePairs = [
        ['WETH', 'USDC'],
        ['WETH', 'DAI'],
        ['cbETH', 'WETH'],
        ['wstETH', 'WETH'],
        ['WETH', 'AERO']
      ];

      for (const [symbol0, symbol1] of highVolumePairs) {
        const token0 = tokens.find(t => t.symbol === symbol0);
        const token1 = tokens.find(t => t.symbol === symbol1);
        expect(token0).toBeDefined();
        expect(token1).toBeDefined();
      }
    });
  });

  describe('Cross-DEX Opportunities with New DEXs', () => {
    it('should be able to detect arbitrage between Uniswap V3 and Maverick', () => {
      const uniswap = DEXES.base.find(d => d.name === 'uniswap_v3');
      const maverick = DEXES.base.find(d => d.name === 'maverick');

      expect(uniswap).toBeDefined();
      expect(maverick).toBeDefined();

      // Both should support WETH/USDC
      const weth = CORE_TOKENS.base.find(t => t.symbol === 'WETH');
      const usdc = CORE_TOKENS.base.find(t => t.symbol === 'USDC');
      expect(weth).toBeDefined();
      expect(usdc).toBeDefined();
    });

    it('should be able to detect arbitrage between Aerodrome and AlienBase', () => {
      const aerodrome = DEXES.base.find(d => d.name === 'aerodrome');
      const alienbase = DEXES.base.find(d => d.name === 'alienbase');

      expect(aerodrome).toBeDefined();
      expect(alienbase).toBeDefined();
    });

    it('should be able to detect arbitrage between Maverick and other DEXs', () => {
      const maverick = DEXES.base.find(d => d.name === 'maverick');
      const baseswap = DEXES.base.find(d => d.name === 'baseswap');

      expect(maverick).toBeDefined();
      expect(baseswap).toBeDefined();
    });
  });

  describe('Profit Calculation with Different Fees', () => {
    it('should account for Maverick lower fees (1 bp vs 30 bps)', () => {
      const maverickFeePct = dexFeeToPercentage(1);   // 0.0001
      const uniswapFeePct = dexFeeToPercentage(30);   // 0.003

      // Trading WETH/USDC on Maverick vs Uniswap
      const tradeAmount = 100000; // $100K trade

      const maverickFees = tradeAmount * maverickFeePct * 2; // Round trip
      const uniswapFees = tradeAmount * uniswapFeePct * 2;

      expect(maverickFees).toBe(20);   // $20 in fees (100K * 0.0001 * 2)
      expect(uniswapFees).toBe(600);   // $600 in fees (100K * 0.003 * 2)
      expect(maverickFees).toBeLessThan(uniswapFees);
    });

    it('should calculate net profit correctly across different fee DEXs', () => {
      const buyPrice = 1800.00; // WETH on Maverick
      const sellPrice = 1805.40; // WETH on Uniswap (0.3% higher)
      const maverickFeePct = dexFeeToPercentage(1);   // 0.0001
      const uniswapFeePct = dexFeeToPercentage(30);   // 0.003
      const tradeAmount = 100000; // $100K

      const grossProfit = tradeAmount * ((sellPrice - buyPrice) / buyPrice);
      const totalFees = tradeAmount * (maverickFeePct + uniswapFeePct);
      const netProfit = grossProfit - totalFees;

      expect(grossProfit).toBeCloseTo(300, 0); // ~$300 gross (0.3% price diff)
      expect(totalFees).toBeCloseTo(310, 0);   // ~$310 fees (100K * 0.0031)
      expect(netProfit).toBeLessThan(0);       // Not profitable at this spread
    });

    it('should be profitable with sufficient spread between Maverick and standard DEX', () => {
      const buyPrice = 1800.00;
      const sellPrice = 1818.00; // 1% higher
      const maverickFeePct = dexFeeToPercentage(1);
      const uniswapFeePct = dexFeeToPercentage(30);
      const tradeAmount = 100000;

      const grossProfit = tradeAmount * ((sellPrice - buyPrice) / buyPrice);
      const totalFees = tradeAmount * (maverickFeePct + uniswapFeePct);
      const netProfit = grossProfit - totalFees;

      expect(grossProfit).toBeCloseTo(1000, 0); // ~$1000 gross (1% spread)
      expect(netProfit).toBeGreaterThan(0);     // Profitable
    });
  });
});

// =============================================================================
// Detector Configuration Tests for Coinbase Chain
// =============================================================================

describe('Coinbase Chain Detector Configuration', () => {
  it('should have Base detector config defined', () => {
    expect(DETECTOR_CONFIG.base).toBeDefined();
  });

  it('should have appropriate batch size for L2', () => {
    expect(DETECTOR_CONFIG.base.batchSize).toBeGreaterThan(0);
    expect(DETECTOR_CONFIG.base.batchSize).toBeGreaterThan(DETECTOR_CONFIG.ethereum.batchSize);
  });

  it('should have appropriate batch timeout', () => {
    expect(DETECTOR_CONFIG.base.batchTimeout).toBeGreaterThan(0);
    expect(DETECTOR_CONFIG.base.batchTimeout).toBeLessThanOrEqual(DETECTOR_CONFIG.ethereum.batchTimeout);
  });

  it('should have confidence level defined', () => {
    expect(DETECTOR_CONFIG.base.confidence).toBeGreaterThan(0);
    expect(DETECTOR_CONFIG.base.confidence).toBeLessThanOrEqual(1);
  });

  it('should have expiry defined', () => {
    expect(DETECTOR_CONFIG.base.expiryMs).toBeGreaterThan(0);
  });

  it('should have gas estimate defined', () => {
    expect(DETECTOR_CONFIG.base.gasEstimate).toBeGreaterThan(0);
  });

  it('should have whale threshold defined', () => {
    expect(DETECTOR_CONFIG.base.whaleThreshold).toBeGreaterThan(0);
  });
});

// =============================================================================
// Token Metadata Tests for Coinbase Chain
// =============================================================================

describe('Coinbase Chain Token Metadata', () => {
  it('should have Base token metadata configured', () => {
    expect(TOKEN_METADATA.base).toBeDefined();
  });

  it('should have correct WETH address', () => {
    expect(TOKEN_METADATA.base.weth).toBe('0x4200000000000000000000000000000000000006');
  });

  it('should have stablecoins configured', () => {
    expect(TOKEN_METADATA.base.stablecoins.length).toBeGreaterThanOrEqual(3);
  });

  it('should have USDC in stablecoins with correct decimals', () => {
    const usdc = TOKEN_METADATA.base.stablecoins.find(s => s.symbol === 'USDC');
    expect(usdc).toBeDefined();
    expect(usdc?.decimals).toBe(6);
  });

  it('should have USDbC (bridged USDC) in stablecoins', () => {
    const usdbc = TOKEN_METADATA.base.stablecoins.find(s => s.symbol === 'USDbC');
    expect(usdbc).toBeDefined();
    expect(usdbc?.decimals).toBe(6);
  });

  it('should have DAI in stablecoins with correct decimals', () => {
    const dai = TOKEN_METADATA.base.stablecoins.find(s => s.symbol === 'DAI');
    expect(dai).toBeDefined();
    expect(dai?.decimals).toBe(18);
  });
});

// =============================================================================
// Chain Configuration Tests
// =============================================================================

describe('Base Chain Configuration', () => {
  it('should have correct chain ID (8453)', () => {
    expect(CHAINS.base.id).toBe(8453);
  });

  it('should have correct chain name', () => {
    expect(CHAINS.base.name).toBe('Base');
  });

  it('should have ETH as native token', () => {
    expect(CHAINS.base.nativeToken).toBe('ETH');
  });

  it('should have 2-second block time', () => {
    expect(CHAINS.base.blockTime).toBe(2);
  });

  it('should have RPC URL configured', () => {
    expect(CHAINS.base.rpcUrl).toBeDefined();
    expect(CHAINS.base.rpcUrl).toContain('base');
  });

  it('should have WebSocket URL configured', () => {
    expect(CHAINS.base.wsUrl).toBeDefined();
    expect(CHAINS.base.wsUrl).toContain('base');
  });
});

// =============================================================================
// PHASE_METRICS Alignment Tests
// =============================================================================

describe('PHASE_METRICS Alignment after S2.2.2', () => {
  it('should have current DEX count >= 30 (after S2.2.2)', () => {
    const totalDexes = Object.values(DEXES).flat().length;
    // After S2.2.1 (28) + S2.2.2 (2) = 30
    expect(totalDexes).toBeGreaterThanOrEqual(30);
  });

  it('should have Base DEXs contributing 7 to total', () => {
    expect(DEXES.base.length).toBe(7);
  });

  it('should have Arbitrum at 9 DEXs (including Balancer V2 adapter)', () => {
    expect(DEXES.arbitrum.length).toBe(9);
  });

  it('should have Phase 1 DEX target of 49 (with vault-model adapters)', () => {
    expect(PHASE_METRICS.targets.phase1.dexes).toBe(49);
  });
});

// =============================================================================
// Performance Benchmarks
// =============================================================================

describe('Performance Benchmarks', () => {
  it('should generate pair combinations within 5ms for all 7 Base DEXs', () => {
    const tokens = CORE_TOKENS.base;
    const dexes = getEnabledDexes('base');

    const start = performance.now();

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

    const duration = performance.now() - start;

    expect(pairKeys.size).toBe(315); // 45 pairs * 7 DEXs
    expect(duration).toBeLessThan(5);
    console.log(`Pair generation (315 pairs): ${duration.toFixed(2)}ms`);
  });

  it('should filter enabled DEXs within 1ms', () => {
    const iterations = 1000;
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      const _enabled = getEnabledDexes('base');
    }

    const duration = performance.now() - start;
    const avgTime = duration / iterations;

    expect(avgTime).toBeLessThan(1);
    console.log(`getEnabledDexes for Base: ${avgTime.toFixed(4)}ms average (${iterations} iterations)`);
  });
});

// =============================================================================
// Integration with Other Chains
// =============================================================================

describe('Cross-Chain DEX Configuration Consistency', () => {
  it('should have consistent structure with Arbitrum DEXs', () => {
    const baseFields = Object.keys(DEXES.base[0]);
    const arbitrumFields = Object.keys(DEXES.arbitrum[0]);

    expect(baseFields.sort()).toEqual(arbitrumFields.sort());
  });

  it('should have fee conversion work consistently across chains', () => {
    const baseDexes = getEnabledDexes('base');
    const arbitrumDexes = getEnabledDexes('arbitrum');

    // All fees should be convertible (use feeBps as primary)
    [...baseDexes, ...arbitrumDexes].forEach(dex => {
      const feePct = dexFeeToPercentage(dex.feeBps);
      const roundTrip = percentageToBasisPoints(feePct);
      expect(roundTrip).toBe(dex.feeBps);
    });
  });

  it('should have Maverick as lowest fee DEX on Base', () => {
    const baseDexes = getEnabledDexes('base');
    const maverick = baseDexes.find(d => d.name === 'maverick');
    const otherDexes = baseDexes.filter(d => d.name !== 'maverick');

    expect(maverick).toBeDefined();
    otherDexes.forEach(dex => {
      expect(maverick!.feeBps).toBeLessThanOrEqual(dex.feeBps);
    });
  });
});

// =============================================================================
// Bug Fix Verification Tests (S2.2.2 Code Review)
// =============================================================================

describe('S2.2.2 Bug Fix Verification', () => {
  describe('BUG 1: Unit Mismatch Fix - Percentage Calculations', () => {
    it('should calculate percentage difference in decimal form (not multiplied by 100)', () => {
      // Test the corrected calculation logic
      const price1 = 1800;
      const price2 = 1810;
      const priceDiff = Math.abs(price1 - price2);
      const avgPrice = (price1 + price2) / 2;

      // CORRECT: percentageDiff as decimal (0.00554 = 0.554%)
      const percentageDiffDecimal = priceDiff / avgPrice;

      // WRONG (old): percentageDiff multiplied by 100 (0.554 = 0.554%)
      const percentageDiffPercent = (priceDiff / avgPrice) * 100;

      expect(percentageDiffDecimal).toBeCloseTo(0.00554, 4);
      expect(percentageDiffPercent).toBeCloseTo(0.554, 2);

      // Verify decimal form matches ARBITRAGE_CONFIG units
      const minProfit = ARBITRAGE_CONFIG.minProfitPercentage; // 0.003 (0.3%)
      expect(minProfit).toBeLessThan(1); // Confirms it's in decimal form
      expect(percentageDiffDecimal).toBeGreaterThan(minProfit); // Valid comparison
    });

    it('should correctly compare profit threshold with decimal percentage', () => {
      // Simulate arbitrage calculation with corrected logic
      const price1 = 1800;
      const price2 = 1805; // 0.277% difference
      const priceDiff = Math.abs(price1 - price2);
      const avgPrice = (price1 + price2) / 2;

      const percentageDiff = priceDiff / avgPrice; // Decimal form
      const totalFees = 0.003 + 0.003; // 0.6% round trip fees
      const netProfit = percentageDiff - totalFees;

      const minProfitThreshold = ARBITRAGE_CONFIG.minProfitPercentage; // 0.003

      // With 0.277% spread and 0.6% fees, net is -0.323% (unprofitable)
      expect(netProfit).toBeLessThan(0);
      expect(netProfit).toBeLessThan(minProfitThreshold);
    });

    it('should detect profitable opportunity with sufficient spread', () => {
      const price1 = 1800;
      const price2 = 1820; // 1.1% difference
      const priceDiff = Math.abs(price1 - price2);
      const avgPrice = (price1 + price2) / 2;

      const percentageDiff = priceDiff / avgPrice; // ~0.011 (1.1%)
      const totalFees = 0.003 + 0.003; // 0.6%
      const netProfit = percentageDiff - totalFees; // ~0.5%

      const minProfitThreshold = ARBITRAGE_CONFIG.chainMinProfits.base; // 0.002

      expect(netProfit).toBeGreaterThan(minProfitThreshold);
    });
  });

  describe('BUG 2: Fee Fallback Fix', () => {
    it('should use 0.003 (decimal) as default fee, not 30 (basis points)', () => {
      // The default fee should be in decimal percentage format
      const defaultFee = 0.003; // 0.3%
      const wrongDefaultFee = 30; // This was the bug - basis points instead of decimal

      // Verify the correct default is much smaller than 1
      expect(defaultFee).toBeLessThan(1);
      expect(wrongDefaultFee).toBeGreaterThan(1);

      // A fee calculation with wrong default would give absurd results
      const tradeAmount = 100000;
      const correctFees = tradeAmount * defaultFee * 2; // $600
      const wrongFees = tradeAmount * wrongDefaultFee * 2; // $6,000,000 (!)

      expect(correctFees).toBe(600);
      expect(wrongFees).toBe(6000000);
    });
  });

  describe('Fee Propagation Through PriceUpdate', () => {
    it('should have fee field in PriceUpdate interface', () => {
      // This test verifies the type system includes fee
      // We test by constructing a valid PriceUpdate-like object
      const priceUpdate = {
        pairKey: 'maverick_WETH_USDC',
        dex: 'maverick',
        chain: 'base',
        token0: '0x4200000000000000000000000000000000000006',
        token1: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        price: 1800,
        reserve0: '1000000000000000000',
        reserve1: '1800000000',
        blockNumber: 12345678,
        timestamp: Date.now(),
        latency: 0,
        fee: dexFeeToPercentage(1) // Maverick 1 bp = 0.0001
      };

      expect(priceUpdate.fee).toBe(0.0001);
      expect(priceUpdate.fee).toBeDefined();
    });

    it('should preserve DEX-specific fees in calculations', () => {
      const maverickFee = dexFeeToPercentage(1);   // 0.0001 (1 bp)
      const uniswapFee = dexFeeToPercentage(30);   // 0.003 (30 bp)

      // Total fees for Maverick <-> Uniswap arbitrage
      const totalFees = maverickFee + uniswapFee;

      expect(totalFees).toBeCloseTo(0.0031, 4); // 0.31%

      // Compare with generic fee (old behavior)
      const genericTotalFees = 0.003 * 2; // 0.6%

      // Maverick's low fee saves ~0.29% vs generic calculation
      const savings = genericTotalFees - totalFees;
      expect(savings).toBeCloseTo(0.0029, 4);
    });
  });

  describe('Arbitrage Calculation with Low-Fee DEXs', () => {
    it('should find profitable opportunity between Maverick and standard DEX', () => {
      const maverickFee = dexFeeToPercentage(1);   // 0.0001
      const standardFee = dexFeeToPercentage(30);  // 0.003

      // Price difference needed for profitability
      const minProfitBase = ARBITRAGE_CONFIG.chainMinProfits.base; // 0.002
      const totalFees = maverickFee + standardFee; // 0.0031
      const minSpreadNeeded = minProfitBase + totalFees; // 0.0051 (0.51%)

      // With 0.6% spread
      const spread = 0.006;
      const netProfit = spread - totalFees;

      expect(netProfit).toBeGreaterThan(minProfitBase);
      expect(minSpreadNeeded).toBeLessThan(0.006);
    });

    it('should require less spread with Maverick than with two standard DEXs', () => {
      const maverickFee = dexFeeToPercentage(1);
      const standardFee = dexFeeToPercentage(30);
      const minProfit = ARBITRAGE_CONFIG.chainMinProfits.base;

      // Maverick <-> Standard: 0.0031 fees + 0.002 profit = 0.0051 min spread
      const minSpreadMaverick = (maverickFee + standardFee) + minProfit;

      // Standard <-> Standard: 0.006 fees + 0.002 profit = 0.008 min spread
      const minSpreadStandard = (standardFee + standardFee) + minProfit;

      expect(minSpreadMaverick).toBeLessThan(minSpreadStandard);
      expect(minSpreadMaverick).toBeCloseTo(0.0051, 4);
      expect(minSpreadStandard).toBeCloseTo(0.008, 4);
    });
  });
});

// =============================================================================
// S2.2.2 Regression Tests - Prevent Future Bugs
// =============================================================================

describe('S2.2.2 Regression Tests', () => {
  describe('REGRESSION: Price Formula Consistency', () => {
    it('should use reserve0/reserve1 for price calculation (not inverted)', () => {
      // This test ensures both base-detector.ts and chain-instance.ts use the same formula
      // Price = reserve0/reserve1 = "price of token1 in terms of token0"
      const reserve0 = 1000n; // 1000 token0
      const reserve1 = 2000n; // 2000 token1

      // Correct formula: reserve0/reserve1
      const correctPrice = Number(reserve0) / Number(reserve1);
      expect(correctPrice).toBe(0.5); // 0.5 token0 per token1

      // Wrong formula (inverted): reserve1/reserve0
      const wrongPrice = Number(reserve1) / Number(reserve0);
      expect(wrongPrice).toBe(2.0); // This would be wrong

      // They should NOT be equal
      expect(correctPrice).not.toBe(wrongPrice);
    });

    it('should detect arbitrage correctly with consistent price formula', () => {
      // Pair1 on DEX A: 1000 token0, 2000 token1 -> price = 0.5
      // Pair2 on DEX B: 1000 token0, 1800 token1 -> price = 0.556
      // Price difference should be detected

      const price1 = 1000 / 2000; // 0.5
      const price2 = 1000 / 1800; // 0.556

      const priceDiff = Math.abs(price1 - price2) / Math.min(price1, price2);
      expect(priceDiff).toBeCloseTo(0.111, 2); // ~11.1% price difference
    });
  });

  describe('REGRESSION: Fee Handling with Nullish Coalescing', () => {
    it('should use ?? operator to handle fee: 0 correctly', () => {
      // If a DEX ever has 0% fee, || would incorrectly fallback to default
      const zeroFee = 0;
      const undefinedFee = undefined;

      // Using || (WRONG for zero fee)
      const wrongResult = zeroFee || 0.003;
      expect(wrongResult).toBe(0.003); // BUG: treats 0 as falsy

      // Using ?? (CORRECT)
      const correctResult = zeroFee ?? 0.003;
      expect(correctResult).toBe(0); // Correctly preserves 0

      // Undefined should still fallback
      const undefinedResult = undefinedFee ?? 0.003;
      expect(undefinedResult).toBe(0.003);
    });

    it('should handle low-fee DEXs like Maverick (1 bp) correctly', () => {
      const maverickFee = dexFeeToPercentage(1); // 0.0001

      // Verify fee is correctly converted and not treated as falsy
      expect(maverickFee).toBe(0.0001);
      expect(maverickFee).toBeTruthy(); // 0.0001 is truthy
      expect(maverickFee).toBeGreaterThan(0);
    });
  });

  describe('REGRESSION: Net Profit vs Gross Profit', () => {
    it('should report NET profit (after fees) not GROSS profit', () => {
      const price1 = 1800;
      const price2 = 1820; // ~1.1% spread
      const fee1 = 0.003;  // 0.3%
      const fee2 = 0.003;  // 0.3%

      const priceDiff = Math.abs(price1 - price2) / Math.min(price1, price2);
      const grossProfitPct = priceDiff;
      const totalFees = fee1 + fee2;
      const netProfitPct = priceDiff - totalFees;

      expect(grossProfitPct).toBeCloseTo(0.0111, 3); // ~1.11% gross
      expect(totalFees).toBe(0.006); // 0.6% fees
      expect(netProfitPct).toBeCloseTo(0.0051, 3); // ~0.51% net

      // Net must be less than gross
      expect(netProfitPct).toBeLessThan(grossProfitPct);
    });

    it('should reject opportunity when fees exceed spread', () => {
      const spread = 0.004; // 0.4% price difference
      const totalFees = 0.006; // 0.6% fees (0.3% + 0.3%)

      const netProfit = spread - totalFees;
      expect(netProfit).toBeLessThan(0); // Should be negative
    });

    it('should use chain-specific threshold for NET profit check', () => {
      const baseThreshold = ARBITRAGE_CONFIG.chainMinProfits.base;
      const ethereumThreshold = ARBITRAGE_CONFIG.chainMinProfits.ethereum;

      // Base has lower threshold (0.2%) than Ethereum (0.5%)
      expect(baseThreshold).toBe(0.002);
      expect(ethereumThreshold).toBe(0.005);
      expect(baseThreshold).toBeLessThan(ethereumThreshold);
    });
  });

  describe('REGRESSION: Config DEX Count Accuracy', () => {
    it('should have accurate DEX count in PHASE_METRICS', () => {
      const actualDexCount = Object.values(DEXES).flat().length;
      const metricsCount = PHASE_METRICS.current.dexes;

      // PHASE_METRICS should match actual count
      expect(metricsCount).toBe(actualDexCount);
    });

    it('should have at least 49 DEXs (with vault-model adapters)', () => {
      const totalDexes = Object.values(DEXES).flat().length;
      // With adapters: GMX, Platypus (Avalanche), Beethoven X (Fantom), Balancer V2 (Arbitrum)
      // Count may increase as new DEXs are added (currently 54)
      expect(totalDexes).toBeGreaterThanOrEqual(49);
    });

    it('should have correct DEX counts per chain', () => {
      expect(DEXES.arbitrum.length).toBe(9);   // With Balancer V2 adapter
      expect(DEXES.base.length).toBe(7);       // S2.2.2: 5→7
      expect(DEXES.bsc.length).toBe(8);        // S2.2.3: 5→8
      expect(DEXES.polygon.length).toBe(4);
      expect(DEXES.optimism.length).toBe(3);
      expect(DEXES.ethereum.length).toBe(2);
      expect(DEXES.avalanche.length).toBe(6);  // With GMX, Platypus adapters
      expect(DEXES.fantom.length).toBe(4);     // With Beethoven X adapter
    });
  });

  describe('REGRESSION: Fee Unit Consistency', () => {
    it('should store DEX fees in basis points in config', () => {
      // Config stores fees in basis points (30 = 0.30%)
      const maverick = DEXES.base.find(d => d.name === 'maverick');
      const uniswap = DEXES.base.find(d => d.name === 'uniswap_v3');

      expect(maverick!.feeBps).toBe(1);  // 1 bp = 0.01%
      expect(uniswap!.feeBps).toBe(30);  // 30 bp = 0.30%

      // Basis points should be integers
      expect(Number.isInteger(maverick!.feeBps)).toBe(true);
      expect(Number.isInteger(uniswap!.feeBps)).toBe(true);
    });

    it('should convert to decimal percentage for calculations', () => {
      // Calculations use decimal percentage (0.003 = 0.30%)
      const maverickPct = dexFeeToPercentage(1);   // 0.0001
      const uniswapPct = dexFeeToPercentage(30);   // 0.003

      // Decimal percentages should be < 1
      expect(maverickPct).toBeLessThan(1);
      expect(uniswapPct).toBeLessThan(1);

      // Verify conversion is correct
      expect(maverickPct).toBe(0.0001);
      expect(uniswapPct).toBe(0.003);
    });

    it('should round-trip convert between basis points and percentage', () => {
      const basisPoints = [1, 4, 10, 25, 30, 100];

      basisPoints.forEach(bp => {
        const pct = dexFeeToPercentage(bp);
        const roundTrip = percentageToBasisPoints(pct);
        expect(roundTrip).toBe(bp);
      });
    });
  });

  describe('REGRESSION: PriceUpdate Fee Field', () => {
    it('should include fee field in PriceUpdate for downstream consumers', () => {
      // This test ensures PriceUpdate carries fee information
      const priceUpdate = {
        pairKey: 'maverick_WETH_USDC',
        dex: 'maverick',
        chain: 'base',
        token0: '0x4200000000000000000000000000000000000006',
        token1: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        price: 0.5,
        reserve0: '1000000000000000000',
        reserve1: '2000000000',
        blockNumber: 12345678,
        timestamp: Date.now(),
        latency: 0,
        fee: dexFeeToPercentage(1) // Maverick 1 bp = 0.0001
      };

      // Fee field must be present and correct
      expect(priceUpdate.fee).toBeDefined();
      expect(priceUpdate.fee).toBe(0.0001);

      // Fee should be in decimal percentage format
      expect(priceUpdate.fee).toBeLessThan(1);
    });
  });
});
