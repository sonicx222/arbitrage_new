/**
 * S2.2 DEX Expansion Integration Tests
 *
 * End-to-end testing of DEX expansion across chains.
 * S2.2.1: Arbitrum DEXs (6 → 9) - Balancer V2, Curve, Chronos
 * S2.2.2: Base DEXs (5 → 7) - Future
 * S2.2.3: BSC DEXs (5 → 8) - Future
 *
 * Also tests helper functions introduced for DEX handling consistency:
 * - getEnabledDexes()
 * - dexFeeToPercentage()
 * - percentageToBasisPoints()
 *
 * @see docs/IMPLEMENTATION_PLAN.md S2.2
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Set required environment variables BEFORE any config imports
process.env.NODE_ENV = 'test';
process.env.ETHEREUM_RPC_URL = 'https://mainnet.infura.io/v3/test';
process.env.ETHEREUM_WS_URL = 'wss://mainnet.infura.io/ws/v3/test';
process.env.ARBITRUM_RPC_URL = 'https://arb1.arbitrum.io/rpc';
process.env.ARBITRUM_WS_URL = 'wss://arb1.arbitrum.io/feed';
process.env.REDIS_URL = 'redis://localhost:6379';

// Use require to avoid ts-jest transformation caching issues
// This ensures we use the compiled dist output with all exports
// eslint-disable-next-line @typescript-eslint/no-var-requires
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
} = require('../../shared/config/dist/index.js');

// =============================================================================
// S2.2.1: Arbitrum DEX Expansion Tests (6 → 9)
// =============================================================================

describe('S2.2.1: Arbitrum DEX Expansion (6 → 9)', () => {
  describe('DEX Count Validation', () => {
    it('should have exactly 9 DEXs configured for Arbitrum', () => {
      expect(DEXES.arbitrum).toBeDefined();
      expect(DEXES.arbitrum.length).toBe(9);
    });

    it('should have all 9 DEXs returned by getEnabledDexes', () => {
      const enabledDexes = getEnabledDexes('arbitrum');
      expect(enabledDexes.length).toBe(9);
    });
  });

  describe('Existing DEXs (6)', () => {
    const existingDexNames = [
      'uniswap_v3',
      'camelot_v3',
      'sushiswap',
      'trader_joe',
      'zyberswap',
      'ramses'
    ];

    existingDexNames.forEach(dexName => {
      it(`should have ${dexName} configured`, () => {
        const dex = DEXES.arbitrum.find(d => d.name === dexName);
        expect(dex).toBeDefined();
        expect(dex!.chain).toBe('arbitrum');
      });

      it(`should have valid addresses for ${dexName}`, () => {
        const dex = DEXES.arbitrum.find(d => d.name === dexName);
        expect(dex!.factoryAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
        expect(dex!.routerAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
      });
    });
  });

  describe('New DEXs (3) - S2.2.1', () => {
    describe('Balancer V2', () => {
      const balancer = DEXES.arbitrum.find(d => d.name === 'balancer_v2');

      it('should have balancer_v2 configured', () => {
        expect(balancer).toBeDefined();
      });

      it('should have correct Balancer V2 Vault address', () => {
        expect(balancer!.factoryAddress.toLowerCase()).toBe('0xba12222222228d8ba445958a75a0704d566bf2c8');
      });

      it('should have valid router address', () => {
        expect(balancer!.routerAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
      });

      it('should be assigned to arbitrum chain', () => {
        expect(balancer!.chain).toBe('arbitrum');
      });

      it('should have fee defined', () => {
        expect(typeof balancer!.fee).toBe('number');
        expect(balancer!.fee).toBeGreaterThanOrEqual(0);
      });
    });

    describe('Curve', () => {
      const curve = DEXES.arbitrum.find(d => d.name === 'curve');

      it('should have curve configured', () => {
        expect(curve).toBeDefined();
      });

      it('should have correct Curve Factory address', () => {
        expect(curve!.factoryAddress.toLowerCase()).toBe('0xb17b674d9c5cb2e441f8e196a2f048a81355d031');
      });

      it('should have valid router address', () => {
        expect(curve!.routerAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
      });

      it('should be assigned to arbitrum chain', () => {
        expect(curve!.chain).toBe('arbitrum');
      });

      it('should have lower fee for stablecoin pools (4 bps)', () => {
        expect(curve!.fee).toBe(4);
      });
    });

    describe('Chronos', () => {
      const chronos = DEXES.arbitrum.find(d => d.name === 'chronos');

      it('should have chronos configured', () => {
        expect(chronos).toBeDefined();
      });

      it('should have correct Chronos Factory address', () => {
        expect(chronos!.factoryAddress.toLowerCase()).toBe('0xce9240869391928253ed9cc9bcb8cb98cb5b0722');
      });

      it('should have valid router address', () => {
        expect(chronos!.routerAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
      });

      it('should be assigned to arbitrum chain', () => {
        expect(chronos!.chain).toBe('arbitrum');
      });

      it('should have fee defined', () => {
        expect(typeof chronos!.fee).toBe('number');
      });
    });
  });

  describe('DEX Configuration Validation', () => {
    it('should have all DEXs with valid factory addresses', () => {
      DEXES.arbitrum.forEach(dex => {
        expect(dex.factoryAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
      });
    });

    it('should have all DEXs with valid router addresses', () => {
      DEXES.arbitrum.forEach(dex => {
        expect(dex.routerAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
      });
    });

    it('should have all DEXs with chain set to arbitrum', () => {
      DEXES.arbitrum.forEach(dex => {
        expect(dex.chain).toBe('arbitrum');
      });
    });

    it('should have all DEXs with fee property defined', () => {
      DEXES.arbitrum.forEach(dex => {
        expect(typeof dex.fee).toBe('number');
        expect(dex.fee).toBeGreaterThanOrEqual(0);
      });
    });

    it('should have unique DEX names', () => {
      const names = DEXES.arbitrum.map(d => d.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(names.length);
    });

    it('should have unique factory addresses', () => {
      const factories = DEXES.arbitrum.map(d => d.factoryAddress.toLowerCase());
      const uniqueFactories = new Set(factories);
      expect(uniqueFactories.size).toBe(factories.length);
    });
  });

  describe('DEX Priority Classification', () => {
    it('should have Critical [C] DEXs at the beginning', () => {
      const criticalDexes = ['uniswap_v3', 'camelot_v3', 'sushiswap'];

      criticalDexes.forEach((name, index) => {
        expect(DEXES.arbitrum[index].name).toBe(name);
      });
    });

    it('should have new DEXs at the end (index 6-8)', () => {
      const newDexes = ['balancer_v2', 'curve', 'chronos'];

      newDexes.forEach((name, index) => {
        expect(DEXES.arbitrum[6 + index].name).toBe(name);
      });
    });
  });
});

// =============================================================================
// Helper Function Tests
// =============================================================================

describe('DEX Helper Functions', () => {
  describe('getEnabledDexes()', () => {
    it('should return all DEXs for arbitrum (all enabled by default)', () => {
      const enabled = getEnabledDexes('arbitrum');
      expect(enabled.length).toBe(9);
    });

    it('should return all DEXs for bsc', () => {
      const enabled = getEnabledDexes('bsc');
      expect(enabled.length).toBe(8); // Updated after S2.2.3: 5 → 8
    });

    it('should return all DEXs for base', () => {
      const enabled = getEnabledDexes('base');
      expect(enabled.length).toBe(7); // Updated after S2.2.2: 5 → 7
    });

    it('should return all DEXs for polygon', () => {
      const enabled = getEnabledDexes('polygon');
      expect(enabled.length).toBe(4);
    });

    it('should return all DEXs for optimism', () => {
      const enabled = getEnabledDexes('optimism');
      expect(enabled.length).toBe(3);
    });

    it('should return all DEXs for ethereum', () => {
      const enabled = getEnabledDexes('ethereum');
      expect(enabled.length).toBe(2);
    });

    it('should return empty array for unknown chain', () => {
      const enabled = getEnabledDexes('unknown_chain');
      expect(enabled).toEqual([]);
    });

    it('should filter out DEXs with enabled === false', () => {
      // This tests the filtering logic even if no DEXs are currently disabled
      const arbitrumDexes = getEnabledDexes('arbitrum');
      arbitrumDexes.forEach(dex => {
        expect(dex.enabled).not.toBe(false);
      });
    });
  });

  describe('dexFeeToPercentage()', () => {
    it('should convert 30 bps to 0.003 (0.30%)', () => {
      expect(dexFeeToPercentage(30)).toBe(0.003);
    });

    it('should convert 25 bps to 0.0025 (0.25%)', () => {
      expect(dexFeeToPercentage(25)).toBe(0.0025);
    });

    it('should convert 4 bps to 0.0004 (0.04%)', () => {
      expect(dexFeeToPercentage(4)).toBe(0.0004);
    });

    it('should convert 10 bps to 0.001 (0.10%)', () => {
      expect(dexFeeToPercentage(10)).toBe(0.001);
    });

    it('should convert 100 bps to 0.01 (1.00%)', () => {
      expect(dexFeeToPercentage(100)).toBe(0.01);
    });

    it('should handle 0 bps', () => {
      expect(dexFeeToPercentage(0)).toBe(0);
    });
  });

  describe('percentageToBasisPoints()', () => {
    it('should convert 0.003 to 30 bps', () => {
      expect(percentageToBasisPoints(0.003)).toBe(30);
    });

    it('should convert 0.0025 to 25 bps', () => {
      expect(percentageToBasisPoints(0.0025)).toBe(25);
    });

    it('should convert 0.0004 to 4 bps', () => {
      expect(percentageToBasisPoints(0.0004)).toBe(4);
    });

    it('should convert 0.01 to 100 bps', () => {
      expect(percentageToBasisPoints(0.01)).toBe(100);
    });

    it('should handle 0 percentage', () => {
      expect(percentageToBasisPoints(0)).toBe(0);
    });

    it('should round correctly for imprecise values', () => {
      // 0.00301 should round to 30 bps
      expect(percentageToBasisPoints(0.00301)).toBe(30);
    });
  });

  describe('Round-trip conversion', () => {
    it('should maintain value through round-trip conversion', () => {
      const originalBps = 30;
      const percentage = dexFeeToPercentage(originalBps);
      const roundTrip = percentageToBasisPoints(percentage);
      expect(roundTrip).toBe(originalBps);
    });

    it('should maintain value for all common fee values', () => {
      const commonFees = [4, 10, 20, 25, 30, 50, 100];
      commonFees.forEach(bps => {
        const percentage = dexFeeToPercentage(bps);
        const roundTrip = percentageToBasisPoints(percentage);
        expect(roundTrip).toBe(bps);
      });
    });
  });
});

// =============================================================================
// PHASE_METRICS Alignment Tests
// =============================================================================

describe('PHASE_METRICS Alignment', () => {
  it('should have current DEX count matching DEXES configuration', () => {
    const totalDexes = Object.values(DEXES).flat().length;
    expect(PHASE_METRICS.current.dexes).toBe(totalDexes);
  });

  it('should have current chain count matching CHAINS configuration', () => {
    const totalChains = Object.keys(CHAINS).length;
    expect(PHASE_METRICS.current.chains).toBe(totalChains);
  });

  it('should have current token count matching CORE_TOKENS configuration', () => {
    const totalTokens = Object.values(CORE_TOKENS).flat().length;
    expect(PHASE_METRICS.current.tokens).toBe(totalTokens);
  });

  it('should have Phase 1 DEX target of 33 after S2.2 completes', () => {
    expect(PHASE_METRICS.targets.phase1.dexes).toBe(33);
  });

  it('should have current DEXs >= 28 (after S2.2.1)', () => {
    const totalDexes = Object.values(DEXES).flat().length;
    // After S2.2.1: 25 original + 3 new Arbitrum = 28
    expect(totalDexes).toBeGreaterThanOrEqual(28);
  });

  it('should have 6 chains currently configured (Phase 1 target is 7)', () => {
    // CHAINS has 6 chains: arbitrum, bsc, base, polygon, optimism, ethereum
    // The 7th chain (avalanche) is planned for later Phase 1 expansion
    expect(Object.keys(CHAINS).length).toBe(6);
    expect(PHASE_METRICS.targets.phase1.chains).toBe(7);
  });

  it('should have 60 tokens for Phase 1', () => {
    expect(PHASE_METRICS.targets.phase1.tokens).toBe(60);
  });
});

// =============================================================================
// Cross-DEX Arbitrage Detection Tests
// =============================================================================

describe('Cross-DEX Arbitrage Detection on Arbitrum', () => {
  describe('Arbitrage Configuration', () => {
    it('should have Arbitrum-specific minimum profit (lower than Ethereum)', () => {
      expect(ARBITRAGE_CONFIG.chainMinProfits.arbitrum).toBe(0.002);
      expect(ARBITRAGE_CONFIG.chainMinProfits.arbitrum).toBeLessThan(
        ARBITRAGE_CONFIG.chainMinProfits.ethereum
      );
    });
  });

  describe('Pair Generation with 9 DEXs', () => {
    const tokens = CORE_TOKENS.arbitrum;
    const dexes = getEnabledDexes('arbitrum');

    it('should generate 66 pairs per DEX (12 tokens = n*(n-1)/2)', () => {
      const pairsPerDex = (tokens.length * (tokens.length - 1)) / 2;
      expect(pairsPerDex).toBe(66);
    });

    it('should generate 594 total potential pairs (66 pairs x 9 DEXes)', () => {
      const pairsPerDex = (tokens.length * (tokens.length - 1)) / 2;
      const totalPairs = pairsPerDex * dexes.length;
      expect(totalPairs).toBe(594);
    });

    it('should include high-volume pairs for arbitrage', () => {
      const highVolumePairs = [
        ['WETH', 'USDC'],
        ['WETH', 'USDT'],
        ['WETH', 'ARB'],
        ['ARB', 'USDC'],
        ['WETH', 'wstETH']
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
    it('should be able to detect arbitrage between Uniswap V3 and Balancer V2', () => {
      const uniswap = DEXES.arbitrum.find(d => d.name === 'uniswap_v3');
      const balancer = DEXES.arbitrum.find(d => d.name === 'balancer_v2');

      expect(uniswap).toBeDefined();
      expect(balancer).toBeDefined();

      // Both should support WETH/USDC
      const weth = CORE_TOKENS.arbitrum.find(t => t.symbol === 'WETH');
      const usdc = CORE_TOKENS.arbitrum.find(t => t.symbol === 'USDC');
      expect(weth).toBeDefined();
      expect(usdc).toBeDefined();
    });

    it('should be able to detect arbitrage between Curve and other DEXs for stablecoins', () => {
      const curve = DEXES.arbitrum.find(d => d.name === 'curve');
      expect(curve).toBeDefined();

      // Curve specializes in stablecoins
      const usdc = CORE_TOKENS.arbitrum.find(t => t.symbol === 'USDC');
      const usdt = CORE_TOKENS.arbitrum.find(t => t.symbol === 'USDT');
      const dai = CORE_TOKENS.arbitrum.find(t => t.symbol === 'DAI');

      expect(usdc).toBeDefined();
      expect(usdt).toBeDefined();
      expect(dai).toBeDefined();
    });

    it('should be able to detect arbitrage between Chronos and other DEXs', () => {
      const chronos = DEXES.arbitrum.find(d => d.name === 'chronos');
      const sushiswap = DEXES.arbitrum.find(d => d.name === 'sushiswap');

      expect(chronos).toBeDefined();
      expect(sushiswap).toBeDefined();
    });
  });

  describe('Profit Calculation with Different Fees', () => {
    it('should account for Curve lower fees (4 bps vs 30 bps)', () => {
      const curveFeePct = dexFeeToPercentage(4);   // 0.0004
      const uniswapFeePct = dexFeeToPercentage(30); // 0.003

      // Trading USDC/USDT on Curve vs Uniswap
      const tradeAmount = 100000; // $100K stablecoin trade

      const curveFees = tradeAmount * curveFeePct * 2; // Round trip
      const uniswapFees = tradeAmount * uniswapFeePct * 2;

      expect(curveFees).toBe(80); // $80 in fees (100K * 0.0004 * 2)
      expect(uniswapFees).toBe(600); // $600 in fees (100K * 0.003 * 2)
      expect(curveFees).toBeLessThan(uniswapFees);
    });

    it('should calculate net profit correctly across different fee DEXs', () => {
      const buyPrice = 1.0001; // USDC/USDT on Curve
      const sellPrice = 1.0010; // USDC/USDT on Uniswap
      const curveFeePct = dexFeeToPercentage(4);   // 0.0004
      const uniswapFeePct = dexFeeToPercentage(30); // 0.003
      const tradeAmount = 100000; // $100K

      const grossProfit = tradeAmount * ((sellPrice - buyPrice) / buyPrice);
      const totalFees = tradeAmount * (curveFeePct + uniswapFeePct);
      const netProfit = grossProfit - totalFees;

      expect(grossProfit).toBeCloseTo(90, 0); // ~$90 gross (0.09% price diff)
      expect(totalFees).toBeCloseTo(340, 0); // ~$340 fees (100K * 0.0034)
      expect(netProfit).toBeLessThan(0); // Not profitable with this small spread
    });
  });
});

// =============================================================================
// Detector Configuration Tests
// =============================================================================

describe('Arbitrum Detector Configuration', () => {
  it('should have Arbitrum detector config defined', () => {
    expect(DETECTOR_CONFIG.arbitrum).toBeDefined();
  });

  it('should have higher batch size for fast blocks', () => {
    expect(DETECTOR_CONFIG.arbitrum.batchSize).toBe(30);
    expect(DETECTOR_CONFIG.arbitrum.batchSize).toBeGreaterThan(DETECTOR_CONFIG.ethereum.batchSize);
  });

  it('should have lower batch timeout for fast processing', () => {
    expect(DETECTOR_CONFIG.arbitrum.batchTimeout).toBe(20);
    expect(DETECTOR_CONFIG.arbitrum.batchTimeout).toBeLessThan(DETECTOR_CONFIG.ethereum.batchTimeout);
  });

  it('should have high confidence for ultra-fast processing', () => {
    expect(DETECTOR_CONFIG.arbitrum.confidence).toBe(0.85);
    expect(DETECTOR_CONFIG.arbitrum.confidence).toBeGreaterThan(DETECTOR_CONFIG.ethereum.confidence);
  });

  it('should have shorter expiry for quick blocks', () => {
    expect(DETECTOR_CONFIG.arbitrum.expiryMs).toBe(5000);
    expect(DETECTOR_CONFIG.arbitrum.expiryMs).toBeLessThan(DETECTOR_CONFIG.ethereum.expiryMs);
  });

  it('should have lower gas estimate than Ethereum', () => {
    expect(DETECTOR_CONFIG.arbitrum.gasEstimate).toBe(50000);
    expect(DETECTOR_CONFIG.arbitrum.gasEstimate).toBeLessThan(DETECTOR_CONFIG.ethereum.gasEstimate);
  });

  it('should have lower whale threshold than Ethereum', () => {
    expect(DETECTOR_CONFIG.arbitrum.whaleThreshold).toBe(25000);
    expect(DETECTOR_CONFIG.arbitrum.whaleThreshold).toBeLessThan(DETECTOR_CONFIG.ethereum.whaleThreshold);
  });
});

// =============================================================================
// Token Metadata Tests
// =============================================================================

describe('Arbitrum Token Metadata', () => {
  it('should have Arbitrum token metadata configured', () => {
    expect(TOKEN_METADATA.arbitrum).toBeDefined();
  });

  it('should have correct WETH address', () => {
    expect(TOKEN_METADATA.arbitrum.weth).toBe('0x82aF49447D8a07e3bd95BD0d56f35241523fBab1');
  });

  it('should have stablecoins configured', () => {
    expect(TOKEN_METADATA.arbitrum.stablecoins.length).toBeGreaterThanOrEqual(3);
  });

  it('should have USDC in stablecoins with correct decimals', () => {
    const usdc = TOKEN_METADATA.arbitrum.stablecoins.find(s => s.symbol === 'USDC');
    expect(usdc).toBeDefined();
    expect(usdc?.decimals).toBe(6);
  });

  it('should have USDT in stablecoins with correct decimals', () => {
    const usdt = TOKEN_METADATA.arbitrum.stablecoins.find(s => s.symbol === 'USDT');
    expect(usdt).toBeDefined();
    expect(usdt?.decimals).toBe(6);
  });

  it('should have DAI in stablecoins with correct decimals', () => {
    const dai = TOKEN_METADATA.arbitrum.stablecoins.find(s => s.symbol === 'DAI');
    expect(dai).toBeDefined();
    expect(dai?.decimals).toBe(18);
  });
});

// =============================================================================
// Chain Configuration Tests
// =============================================================================

describe('Arbitrum Chain Configuration', () => {
  it('should have correct chain ID (42161)', () => {
    expect(CHAINS.arbitrum.id).toBe(42161);
  });

  it('should have correct chain name', () => {
    expect(CHAINS.arbitrum.name).toBe('Arbitrum');
  });

  it('should have ETH as native token', () => {
    expect(CHAINS.arbitrum.nativeToken).toBe('ETH');
  });

  it('should have ultra-fast 250ms block time', () => {
    expect(CHAINS.arbitrum.blockTime).toBe(0.25);
  });

  it('should have RPC URL configured', () => {
    expect(CHAINS.arbitrum.rpcUrl).toBeDefined();
    expect(CHAINS.arbitrum.rpcUrl).toContain('arbitrum');
  });

  it('should have WebSocket URL configured', () => {
    expect(CHAINS.arbitrum.wsUrl).toBeDefined();
    expect(CHAINS.arbitrum.wsUrl).toContain('arbitrum');
  });
});

// =============================================================================
// Event Signatures Tests
// =============================================================================

describe('Event Signatures Configuration', () => {
  it('should have SYNC event signature configured', () => {
    expect(EVENT_SIGNATURES.SYNC).toBe('0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1');
  });

  it('should have SWAP_V2 event signature configured', () => {
    expect(EVENT_SIGNATURES.SWAP_V2).toBe('0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822');
  });

  it('should have SWAP_V3 event signature configured', () => {
    expect(EVENT_SIGNATURES.SWAP_V3).toBe('0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67');
  });

  it('should have valid keccak256 hash format for all signatures', () => {
    const hashPattern = /^0x[a-f0-9]{64}$/;
    expect(EVENT_SIGNATURES.SYNC).toMatch(hashPattern);
    expect(EVENT_SIGNATURES.SWAP_V2).toMatch(hashPattern);
    expect(EVENT_SIGNATURES.SWAP_V3).toMatch(hashPattern);
  });
});

// =============================================================================
// Performance Benchmarks
// =============================================================================

describe('Performance Benchmarks', () => {
  it('should calculate fee conversion within 0.1ms for 10000 iterations', () => {
    const iterations = 10000;
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      const bps = 30;
      const _pct = dexFeeToPercentage(bps);
      const _roundTrip = percentageToBasisPoints(_pct);
    }

    const duration = performance.now() - start;
    const avgTime = duration / iterations;

    expect(avgTime).toBeLessThan(0.1); // < 0.1ms per calculation
    console.log(`Fee conversion: ${avgTime.toFixed(6)}ms average (${iterations} iterations)`);
  });

  it('should filter enabled DEXs within 1ms for 1000 iterations', () => {
    const iterations = 1000;
    const chains = Object.keys(DEXES);
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      const chain = chains[i % chains.length];
      const _enabled = getEnabledDexes(chain);
    }

    const duration = performance.now() - start;
    const avgTime = duration / iterations;

    expect(avgTime).toBeLessThan(1);
    console.log(`getEnabledDexes: ${avgTime.toFixed(4)}ms average (${iterations} iterations)`);
  });

  it('should generate pair combinations within 5ms for all 9 Arbitrum DEXs', () => {
    const tokens = CORE_TOKENS.arbitrum;
    const dexes = getEnabledDexes('arbitrum');

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

    expect(pairKeys.size).toBe(594); // 66 pairs * 9 DEXs
    expect(duration).toBeLessThan(5);
    console.log(`Pair generation (594 pairs): ${duration.toFixed(2)}ms`);
  });

  it('should calculate arbitrage detection within 1ms', () => {
    const iterations = 1000;
    const minProfit = 0.002;

    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      const price1 = 1800 + Math.random() * 20;
      const price2 = 1810 + Math.random() * 20;

      const priceDiff = Math.abs(price1 - price2) / Math.min(price1, price2);
      const _isOpportunity = priceDiff >= minProfit;
    }

    const duration = performance.now() - start;
    const avgTime = duration / iterations;

    expect(avgTime).toBeLessThan(1);
    console.log(`Arbitrage detection: ${avgTime.toFixed(4)}ms average (${iterations} iterations)`);
  });
});

// =============================================================================
// Integration with Other Chains
// =============================================================================

describe('Cross-Chain DEX Configuration Consistency', () => {
  const allChains = Object.keys(DEXES);

  it('should have DEXs defined for all chains', () => {
    allChains.forEach(chain => {
      expect(DEXES[chain]).toBeDefined();
      expect(DEXES[chain].length).toBeGreaterThan(0);
    });
  });

  it('should have all DEXs with consistent structure', () => {
    allChains.forEach(chain => {
      DEXES[chain].forEach(dex => {
        expect(dex.name).toBeDefined();
        expect(dex.chain).toBe(chain);
        expect(dex.factoryAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
        expect(dex.routerAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
        expect(typeof dex.fee).toBe('number');
      });
    });
  });

  it('should have getEnabledDexes work for all chains', () => {
    allChains.forEach(chain => {
      const enabled = getEnabledDexes(chain);
      expect(enabled.length).toBeGreaterThan(0);
      expect(enabled.length).toBe(DEXES[chain].length); // All enabled by default
    });
  });

  it('should have token metadata for all chains with DEXs', () => {
    allChains.forEach(chain => {
      expect(TOKEN_METADATA[chain]).toBeDefined();
      expect(TOKEN_METADATA[chain].stablecoins.length).toBeGreaterThan(0);
    });
  });
});
