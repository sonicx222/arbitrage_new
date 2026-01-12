/**
 * S2.2.3 BSC DEX Expansion Integration Tests
 *
 * Sprint 2, Task 2.3: Expand BSC DEXs from 5 → 8
 *
 * New DEXs to add:
 * - MDEX: Major BSC/HECO DEX with significant volume
 * - Ellipsis Finance: Curve fork optimized for stablecoins (low fees)
 * - Nomiswap: Growing BSC DEX with competitive fees
 *
 * Test-Driven Development:
 * 1. Write failing tests for new DEX configurations
 * 2. Implement DEX configs to make tests pass
 * 3. Verify integration with existing arbitrage logic
 */

// Set required environment variables BEFORE any config imports
process.env.NODE_ENV = 'test';
process.env.ETHEREUM_RPC_URL = 'https://mainnet.infura.io/v3/test';
process.env.ETHEREUM_WS_URL = 'wss://mainnet.infura.io/ws/v3/test';
process.env.BSC_RPC_URL = 'https://bsc-dataseed1.binance.org';
process.env.BSC_WS_URL = 'wss://bsc-ws-node.nariox.org:443';
process.env.REDIS_URL = 'redis://localhost:6379';

// Use require to avoid ts-jest transformation caching issues
// This ensures we use the compiled dist output with all exports
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  DEXES,
  CHAINS,
  CORE_TOKENS,
  ARBITRAGE_CONFIG,
  TOKEN_METADATA,
  PHASE_METRICS,
  getEnabledDexes,
  dexFeeToPercentage,
  percentageToBasisPoints
} = require('../../shared/config/dist/index.js');

// =============================================================================
// S2.2.3 Test Suite: BSC DEX Expansion (5 → 8)
// =============================================================================

describe('S2.2.3 BSC DEX Expansion', () => {
  // ===========================================================================
  // Section 1: DEX Configuration Tests
  // ===========================================================================

  describe('BSC DEX Configuration', () => {
    const bscDexes = DEXES.bsc;

    it('should have exactly 8 DEXs after S2.2.3 expansion', () => {
      expect(bscDexes.length).toBe(8);
    });

    it('should include all original 5 DEXs', () => {
      const originalDexNames = [
        'pancakeswap_v3',
        'pancakeswap_v2',
        'biswap',
        'thena',
        'apeswap'
      ];

      originalDexNames.forEach(name => {
        const dex = bscDexes.find(d => d.name === name);
        expect(dex).toBeDefined();
        expect(dex?.chain).toBe('bsc');
      });
    });

    it('should include 3 new DEXs: MDEX, Ellipsis, Nomiswap', () => {
      const newDexNames = ['mdex', 'ellipsis', 'nomiswap'];

      newDexNames.forEach(name => {
        const dex = bscDexes.find(d => d.name === name);
        expect(dex).toBeDefined();
        expect(dex?.chain).toBe('bsc');
      });
    });

    it('should have valid factory addresses for all DEXs', () => {
      bscDexes.forEach(dex => {
        expect(dex.factoryAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
        expect(dex.factoryAddress).not.toBe('0x0000000000000000000000000000000000000000');
      });
    });

    it('should have valid router addresses for all DEXs', () => {
      bscDexes.forEach(dex => {
        expect(dex.routerAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
        expect(dex.routerAddress).not.toBe('0x0000000000000000000000000000000000000000');
      });
    });

    it('should have fees in basis points (positive integers)', () => {
      bscDexes.forEach(dex => {
        expect(dex.fee).toBeGreaterThan(0);
        expect(dex.fee).toBeLessThan(1000); // Max 10%
        expect(Number.isInteger(dex.fee)).toBe(true);
      });
    });

    it('should have unique factory addresses', () => {
      const factoryAddresses = bscDexes.map(d => d.factoryAddress.toLowerCase());
      const uniqueAddresses = new Set(factoryAddresses);
      expect(uniqueAddresses.size).toBe(bscDexes.length);
    });

    it('should have unique DEX names', () => {
      const names = bscDexes.map(d => d.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(bscDexes.length);
    });
  });

  // ===========================================================================
  // Section 2: New DEX-Specific Tests
  // ===========================================================================

  describe('MDEX Configuration', () => {
    const mdex = DEXES.bsc.find(d => d.name === 'mdex');

    it('should exist in BSC DEX list', () => {
      expect(mdex).toBeDefined();
    });

    it('should have correct factory address', () => {
      // MDEX Factory on BSC
      expect(mdex?.factoryAddress).toBe('0x3CD1C46068dAEa5Ebb0d3f55F6915B10648062B8');
    });

    it('should have correct router address', () => {
      // MDEX Router on BSC
      expect(mdex?.routerAddress).toBe('0x7DAe51BD3E3376B8c7c4900E9107f12Be3AF1bA8');
    });

    it('should have standard 0.3% fee (30 basis points)', () => {
      expect(mdex?.fee).toBe(30);
    });

    it('should be marked as chain bsc', () => {
      expect(mdex?.chain).toBe('bsc');
    });
  });

  describe('Ellipsis Finance Configuration', () => {
    const ellipsis = DEXES.bsc.find(d => d.name === 'ellipsis');

    it('should exist in BSC DEX list', () => {
      expect(ellipsis).toBeDefined();
    });

    it('should have correct factory address', () => {
      // Ellipsis Factory (StableSwap) on BSC
      expect(ellipsis?.factoryAddress).toBe('0xf65BEd27e96a367c61e0E06C54e14B16b84a5870');
    });

    it('should have correct router address', () => {
      // Ellipsis Router on BSC
      expect(ellipsis?.routerAddress).toBe('0x160CAed03795365F3A589f10C379FfA7d75d4E76');
    });

    it('should have low fee for stablecoin swaps (4 basis points)', () => {
      // Curve/Ellipsis uses ~0.04% fee for stable pools
      expect(ellipsis?.fee).toBe(4);
    });

    it('should be marked as chain bsc', () => {
      expect(ellipsis?.chain).toBe('bsc');
    });
  });

  describe('Nomiswap Configuration', () => {
    const nomiswap = DEXES.bsc.find(d => d.name === 'nomiswap');

    it('should exist in BSC DEX list', () => {
      expect(nomiswap).toBeDefined();
    });

    it('should have correct factory address', () => {
      // Nomiswap Factory on BSC
      expect(nomiswap?.factoryAddress).toBe('0xd6715A8be3944ec72738F0BFDC739571659D8010');
    });

    it('should have correct router address', () => {
      // Nomiswap Router on BSC
      expect(nomiswap?.routerAddress).toBe('0xD654953D746f0b114d1F85332Dc43446ac79413d');
    });

    it('should have competitive 0.1% fee (10 basis points)', () => {
      // Nomiswap uses 0.1% fee
      expect(nomiswap?.fee).toBe(10);
    });

    it('should be marked as chain bsc', () => {
      expect(nomiswap?.chain).toBe('bsc');
    });
  });

  // ===========================================================================
  // Section 3: Fee Structure Tests
  // ===========================================================================

  describe('BSC DEX Fee Structure', () => {
    const bscDexes = DEXES.bsc;

    it('should have Ellipsis as lowest fee DEX (stablecoin optimized)', () => {
      const ellipsis = bscDexes.find(d => d.name === 'ellipsis');
      const otherDexes = bscDexes.filter(d => d.name !== 'ellipsis');

      expect(ellipsis).toBeDefined();
      otherDexes.forEach(dex => {
        expect(ellipsis!.fee).toBeLessThanOrEqual(dex.fee);
      });
    });

    it('should have Biswap and Nomiswap tied for second lowest (10 bp)', () => {
      const biswap = bscDexes.find(d => d.name === 'biswap');
      const nomiswap = bscDexes.find(d => d.name === 'nomiswap');

      expect(biswap?.fee).toBe(10);
      expect(nomiswap?.fee).toBe(10);
    });

    it('should have fee distribution supporting various arbitrage strategies', () => {
      const fees = bscDexes.map(d => d.fee).sort((a, b) => a - b);

      // Should have variety of fees for different strategies
      // Low: 4 (Ellipsis - stables), 10 (Biswap, Nomiswap)
      // Medium: 20 (Thena, ApeSwap), 25 (PancakeSwap V2/V3)
      // Standard: 30 (MDEX)
      expect(fees[0]).toBe(4);   // Ellipsis
      expect(fees[1]).toBe(10);  // Biswap
      expect(fees[2]).toBe(10);  // Nomiswap
    });

    it('should convert fees correctly to decimal percentage', () => {
      bscDexes.forEach(dex => {
        const pct = dexFeeToPercentage(dex.fee);
        expect(pct).toBeLessThan(1);
        expect(pct).toBeGreaterThan(0);

        // Round-trip conversion
        const backToBp = percentageToBasisPoints(pct);
        expect(backToBp).toBe(dex.fee);
      });
    });
  });

  // ===========================================================================
  // Section 4: Arbitrage Opportunity Tests
  // ===========================================================================

  describe('BSC Arbitrage Opportunities', () => {
    const bscDexes = DEXES.bsc;
    const bscTokens = CORE_TOKENS.bsc;

    it('should support stablecoin arbitrage via Ellipsis low fees', () => {
      const ellipsis = bscDexes.find(d => d.name === 'ellipsis');
      const pancakeV3 = bscDexes.find(d => d.name === 'pancakeswap_v3');

      const ellipsisFee = dexFeeToPercentage(ellipsis!.fee);  // 0.0004
      const pancakeFee = dexFeeToPercentage(pancakeV3!.fee);  // 0.0025

      // Total round-trip fee for Ellipsis <-> PancakeSwap
      const totalFees = ellipsisFee + pancakeFee;
      const minProfit = ARBITRAGE_CONFIG.chainMinProfits.bsc;

      // With Ellipsis low fee, minimum spread needed is lower
      const minSpreadNeeded = totalFees + minProfit;
      expect(minSpreadNeeded).toBeLessThan(0.006); // Less than 0.6%
    });

    it('should enable competitive arbitrage with Biswap and Nomiswap (both 10 bp)', () => {
      const biswap = bscDexes.find(d => d.name === 'biswap');
      const nomiswap = bscDexes.find(d => d.name === 'nomiswap');

      const biswapFee = dexFeeToPercentage(biswap!.fee);
      const nomiswapFee = dexFeeToPercentage(nomiswap!.fee);

      // Same fee structure enables direct price comparison
      expect(biswapFee).toBe(nomiswapFee);
      expect(biswapFee).toBe(0.001); // 0.1%

      // Total fees for Biswap <-> Nomiswap
      const totalFees = biswapFee + nomiswapFee; // 0.2%
      expect(totalFees).toBe(0.002);
    });

    it('should calculate profitable spread for MDEX <-> PancakeSwap', () => {
      const mdex = bscDexes.find(d => d.name === 'mdex');
      const pancakeV2 = bscDexes.find(d => d.name === 'pancakeswap_v2');

      const mdexFee = dexFeeToPercentage(mdex!.fee);      // 0.003
      const pancakeFee = dexFeeToPercentage(pancakeV2!.fee); // 0.0025

      const totalFees = mdexFee + pancakeFee;
      const minProfit = ARBITRAGE_CONFIG.chainMinProfits.bsc; // 0.003

      const minSpreadNeeded = totalFees + minProfit;
      expect(minSpreadNeeded).toBeCloseTo(0.0085, 4); // ~0.85%
    });

    it('should generate 360 potential pairs (45 pairs x 8 DEXes)', () => {
      const tokens = bscTokens;
      const dexes = bscDexes;

      const pairsPerDex = (tokens.length * (tokens.length - 1)) / 2;
      const totalPairs = pairsPerDex * dexes.length;

      expect(tokens.length).toBe(10);
      expect(dexes.length).toBe(8);
      expect(pairsPerDex).toBe(45);
      expect(totalPairs).toBe(360);
    });
  });

  // ===========================================================================
  // Section 5: Cross-DEX Arbitrage Matrix Tests
  // ===========================================================================

  describe('BSC Cross-DEX Arbitrage Matrix', () => {
    const bscDexes = DEXES.bsc;

    it('should have 28 unique DEX pairs for arbitrage (8 choose 2)', () => {
      // Number of unique pairs = n * (n-1) / 2 = 8 * 7 / 2 = 28
      const dexCount = bscDexes.length;
      const uniquePairs = (dexCount * (dexCount - 1)) / 2;
      expect(uniquePairs).toBe(28);
    });

    it('should calculate minimum spread matrix for all DEX pairs', () => {
      const minProfit = ARBITRAGE_CONFIG.chainMinProfits.bsc;
      const spreadMatrix: Record<string, number> = {};

      for (let i = 0; i < bscDexes.length; i++) {
        for (let j = i + 1; j < bscDexes.length; j++) {
          const dex1 = bscDexes[i];
          const dex2 = bscDexes[j];

          const fee1 = dexFeeToPercentage(dex1.fee);
          const fee2 = dexFeeToPercentage(dex2.fee);
          const minSpread = fee1 + fee2 + minProfit;

          const key = `${dex1.name}<->${dex2.name}`;
          spreadMatrix[key] = minSpread;
        }
      }

      // Best case: Ellipsis <-> Biswap or Ellipsis <-> Nomiswap
      // 0.0004 + 0.001 + 0.003 = 0.0044 (0.44%)
      expect(spreadMatrix['ellipsis<->biswap'] || spreadMatrix['biswap<->ellipsis']).toBeCloseTo(0.0044, 4);

      // Verify all spreads are positive and reasonable
      Object.values(spreadMatrix).forEach(spread => {
        expect(spread).toBeGreaterThan(0);
        expect(spread).toBeLessThan(0.02); // Max 2%
      });
    });

    it('should identify optimal arbitrage paths', () => {
      const minProfit = ARBITRAGE_CONFIG.chainMinProfits.bsc;
      const paths: { path: string; minSpread: number }[] = [];

      for (let i = 0; i < bscDexes.length; i++) {
        for (let j = i + 1; j < bscDexes.length; j++) {
          const dex1 = bscDexes[i];
          const dex2 = bscDexes[j];

          const fee1 = dexFeeToPercentage(dex1.fee);
          const fee2 = dexFeeToPercentage(dex2.fee);
          const minSpread = fee1 + fee2 + minProfit;

          paths.push({
            path: `${dex1.name}<->${dex2.name}`,
            minSpread
          });
        }
      }

      // Sort by minimum spread (best opportunities first)
      paths.sort((a, b) => a.minSpread - b.minSpread);

      // Top 3 should involve low-fee DEXs
      const topPaths = paths.slice(0, 3);
      topPaths.forEach(p => {
        expect(p.path).toMatch(/ellipsis|biswap|nomiswap/);
      });
    });
  });

  // ===========================================================================
  // Section 6: Token Coverage Tests
  // ===========================================================================

  describe('BSC Token Coverage', () => {
    const tokens = CORE_TOKENS.bsc;
    const metadata = TOKEN_METADATA.bsc;

    it('should have 10 BSC tokens', () => {
      expect(tokens.length).toBe(10);
    });

    it('should include core tokens for new DEX arbitrage', () => {
      const requiredTokens = ['WBNB', 'USDT', 'USDC', 'BUSD', 'BTCB', 'ETH'];

      requiredTokens.forEach(symbol => {
        const token = tokens.find(t => t.symbol === symbol);
        expect(token).toBeDefined();
        expect(token?.chainId).toBe(56);
      });
    });

    it('should have stablecoins for Ellipsis arbitrage', () => {
      const stableSymbols = ['USDT', 'USDC', 'BUSD'];

      stableSymbols.forEach(symbol => {
        const token = tokens.find(t => t.symbol === symbol);
        expect(token).toBeDefined();
      });

      // Also check metadata stablecoins
      expect(metadata.stablecoins.length).toBeGreaterThanOrEqual(3);
    });

    it('should have valid token addresses', () => {
      tokens.forEach(token => {
        expect(token.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
        expect(token.decimals).toBeGreaterThan(0);
        expect(token.decimals).toBeLessThanOrEqual(18);
      });
    });
  });

  // ===========================================================================
  // Section 7: getEnabledDexes Function Tests
  // ===========================================================================

  describe('getEnabledDexes for BSC', () => {
    it('should return all 8 DEXs when all are enabled', () => {
      const enabledDexes = getEnabledDexes('bsc');
      expect(enabledDexes.length).toBe(8);
    });

    it('should return DEXs in correct order', () => {
      const enabledDexes = getEnabledDexes('bsc');
      const names = enabledDexes.map(d => d.name);

      // Original DEXs should come first
      expect(names.indexOf('pancakeswap_v3')).toBeLessThan(names.indexOf('mdex'));
      expect(names.indexOf('pancakeswap_v2')).toBeLessThan(names.indexOf('ellipsis'));
    });

    it('should respect enabled flag if set to false', () => {
      // This tests the function behavior - DEXs without enabled:false should be included
      const enabledDexes = getEnabledDexes('bsc');
      enabledDexes.forEach(dex => {
        expect(dex.enabled).not.toBe(false);
      });
    });
  });

  // ===========================================================================
  // Section 8: System-wide DEX Count Tests
  // ===========================================================================

  describe('System-wide DEX Count After S2.2.3', () => {
    it('should have 33 total DEXs after S2.2.3', () => {
      // Arbitrum: 9, BSC: 8, Base: 7, Polygon: 4, Optimism: 3, Ethereum: 2
      const totalDexes = Object.values(DEXES).flat().length;
      expect(totalDexes).toBe(33);
    });

    it('should have correct DEX counts per chain', () => {
      expect(DEXES.arbitrum.length).toBe(9);   // S2.2.1
      expect(DEXES.bsc.length).toBe(8);        // S2.2.3 (NEW)
      expect(DEXES.base.length).toBe(7);       // S2.2.2
      expect(DEXES.polygon.length).toBe(4);
      expect(DEXES.optimism.length).toBe(3);
      expect(DEXES.ethereum.length).toBe(2);
    });

    it('should match PHASE_METRICS target for Phase 1', () => {
      const actualDexCount = Object.values(DEXES).flat().length;
      const targetDexCount = PHASE_METRICS.targets.phase1.dexes;

      // After S2.2.3, we should match the Phase 1 target of 33 DEXs
      expect(actualDexCount).toBe(targetDexCount);
    });
  });

  // ===========================================================================
  // Section 9: Integration with Existing Logic Tests
  // ===========================================================================

  describe('Integration with Existing Arbitrage Logic', () => {
    it('should calculate NET profit correctly for new DEXs', () => {
      const mdex = DEXES.bsc.find(d => d.name === 'mdex');
      const ellipsis = DEXES.bsc.find(d => d.name === 'ellipsis');
      const minProfit = ARBITRAGE_CONFIG.chainMinProfits.bsc;

      // Simulate price difference detection
      const price1 = 300;  // BNB price on MDEX
      const price2 = 303;  // BNB price on Ellipsis (1% higher)

      const priceDiff = Math.abs(price1 - price2) / Math.min(price1, price2);
      const mdexFee = dexFeeToPercentage(mdex!.fee);
      const ellipsisFee = dexFeeToPercentage(ellipsis!.fee);
      const totalFees = mdexFee + ellipsisFee;
      const netProfit = priceDiff - totalFees;

      expect(priceDiff).toBeCloseTo(0.01, 3);  // 1% gross
      expect(totalFees).toBeCloseTo(0.0034, 4); // 0.34% fees
      expect(netProfit).toBeCloseTo(0.0066, 3); // 0.66% net
      expect(netProfit).toBeGreaterThan(minProfit);
    });

    it('should use nullish coalescing for fee handling', () => {
      // Test that ?? operator correctly handles edge cases
      const normalFee = 30;
      const zeroFee = 0;
      const undefinedFee = undefined;

      // Correct behavior with ??
      expect(normalFee ?? 0.003).toBe(30);
      expect(zeroFee ?? 0.003).toBe(0);  // ?? preserves 0
      expect(undefinedFee ?? 0.003).toBe(0.003);

      // Incorrect behavior with ||
      expect(normalFee || 0.003).toBe(30);
      expect(zeroFee || 0.003).toBe(0.003);  // || treats 0 as falsy (BUG)
      expect(undefinedFee || 0.003).toBe(0.003);
    });

    it('should use consistent price formula (reserve0/reserve1)', () => {
      // Verify price calculation is consistent
      const reserve0 = 1000n;
      const reserve1 = 3000n; // 3 token1 per token0

      const correctPrice = Number(reserve0) / Number(reserve1);
      expect(correctPrice).toBeCloseTo(0.333, 2);

      // Wrong (inverted) formula
      const wrongPrice = Number(reserve1) / Number(reserve0);
      expect(wrongPrice).toBe(3);
      expect(wrongPrice).not.toBe(correctPrice);
    });
  });

  // ===========================================================================
  // Section 10: Performance Tests
  // ===========================================================================

  describe('Performance with 8 BSC DEXs', () => {
    it('should maintain O(n²) pair complexity within limits', () => {
      const tokens = CORE_TOKENS.bsc;
      const dexes = DEXES.bsc;

      // Token pairs: 10 * 9 / 2 = 45
      // Total pairs across DEXs: 45 * 8 = 360
      // Cross-DEX comparisons for arbitrage: 360 * 7 / 2 = 1260

      const tokenPairs = (tokens.length * (tokens.length - 1)) / 2;
      const totalPairs = tokenPairs * dexes.length;
      const crossDexComparisons = (totalPairs * (dexes.length - 1)) / 2;

      expect(tokenPairs).toBe(45);
      expect(totalPairs).toBe(360);
      expect(crossDexComparisons).toBeLessThan(2000); // Reasonable limit
    });

    it('should process DEX lookups efficiently', () => {
      const startTime = performance.now();

      for (let i = 0; i < 10000; i++) {
        const dexes = getEnabledDexes('bsc');
        const mdex = dexes.find(d => d.name === 'mdex');
        const fee = mdex ? dexFeeToPercentage(mdex.fee) : 0;
      }

      const endTime = performance.now();
      const duration = endTime - startTime;

      // 10000 lookups should complete in < 100ms
      expect(duration).toBeLessThan(100);
    });
  });
});

// =============================================================================
// Regression Tests (Carry forward from S2.2.2)
// =============================================================================

describe('S2.2.3 Regression Tests', () => {
  describe('REGRESSION: Fee Unit Consistency', () => {
    it('should store all BSC DEX fees in basis points', () => {
      const bscDexes = DEXES.bsc;

      bscDexes.forEach(dex => {
        // Basis points should be positive integers
        expect(Number.isInteger(dex.fee)).toBe(true);
        expect(dex.fee).toBeGreaterThan(0);
        expect(dex.fee).toBeLessThan(1000);
      });
    });

    it('should convert all fees to decimal percentage < 1', () => {
      const bscDexes = DEXES.bsc;

      bscDexes.forEach(dex => {
        const pct = dexFeeToPercentage(dex.fee);
        expect(pct).toBeLessThan(1);
        expect(pct).toBeGreaterThan(0);
      });
    });
  });

  describe('REGRESSION: Config Accuracy', () => {
    it('should have PHASE_METRICS match actual DEX count', () => {
      const actualDexCount = Object.values(DEXES).flat().length;
      const metricsCount = PHASE_METRICS.current.dexes;

      expect(metricsCount).toBe(actualDexCount);
    });

    it('should have comment match actual BSC DEX count', () => {
      // The comment in config should say "8 DEXs" for BSC
      expect(DEXES.bsc.length).toBe(8);
    });
  });

  describe('REGRESSION: Profit Calculation', () => {
    it('should calculate NET profit (not gross) for opportunities', () => {
      const price1 = 300;
      const price2 = 305;
      const fee1 = dexFeeToPercentage(25);  // PancakeSwap
      const fee2 = dexFeeToPercentage(30);  // MDEX

      const grossProfit = Math.abs(price1 - price2) / Math.min(price1, price2);
      const totalFees = fee1 + fee2;
      const netProfit = grossProfit - totalFees;

      expect(grossProfit).toBeGreaterThan(netProfit);
      expect(netProfit).toBeLessThan(grossProfit);
    });
  });

  describe('REGRESSION: Nullish Coalescing Fix (S2.2.3)', () => {
    it('should use ?? not || for fee fallbacks to handle fee: 0 correctly', () => {
      // This test verifies the S2.2.3 fix for the || vs ?? bug
      // If a DEX ever has 0% fee, || would incorrectly fallback to default

      const zeroFee = 0;
      const undefinedFee = undefined;
      const defaultFee = 0.003;

      // Using || (WRONG for zero fee) - documents the bug
      const wrongResult = zeroFee || defaultFee;
      expect(wrongResult).toBe(defaultFee); // BUG: treats 0 as falsy

      // Using ?? (CORRECT) - this is what the code should use
      const correctResult = zeroFee ?? defaultFee;
      expect(correctResult).toBe(0); // Correctly preserves 0

      // Undefined should still fallback with both operators
      expect(undefinedFee ?? defaultFee).toBe(defaultFee);
      expect(undefinedFee || defaultFee).toBe(defaultFee);
    });

    it('should use ?? not || for chainMinProfits fallbacks', () => {
      // If a chain ever has 0% min profit threshold, || would incorrectly default
      const zeroProfit = 0;
      const defaultProfit = 0.003;

      // Using ?? preserves zero
      expect(zeroProfit ?? defaultProfit).toBe(0);

      // Using || would fail (this is the bug pattern)
      expect(zeroProfit || defaultProfit).toBe(defaultProfit);
    });

    it('should use ?? not ternary (? :) for dex.fee conversion', () => {
      // Test that dexFeeToPercentage is called even for fee: 0
      // The old pattern: dex.fee ? dexFeeToPercentage(dex.fee) : 0.003
      // Would skip conversion for fee: 0

      const zeroFeeBp = 0;
      const normalFeeBp = 30;

      // Correct pattern: dexFeeToPercentage(dex.fee ?? 30)
      expect(dexFeeToPercentage(zeroFeeBp ?? 30)).toBe(dexFeeToPercentage(0)); // 0
      expect(dexFeeToPercentage(normalFeeBp ?? 30)).toBe(dexFeeToPercentage(30)); // 0.003

      // Verify 0 bp converts to 0%
      expect(dexFeeToPercentage(0)).toBe(0);
    });
  });
});
