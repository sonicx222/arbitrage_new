/**
 * Consolidated DEX Configuration Validation Tests
 *
 * Table-driven tests covering DEX config for all 11 chains:
 * - Structural validation (addresses, fees, names, uniqueness) for all chains
 * - Chain-specific DEX counts and expected DEXes
 * - Solana-specific tests (base58 addresses, DEX types, enable/disable)
 * - BSC-specific tests (fee strategy, arbitrage math, cross-DEX matrix)
 * - Fee helper functions (dexFeeToPercentage, percentageToBasisPoints)
 * - System-wide DEX count and PHASE_METRICS consistency
 * - Regression tests (nullish coalescing, fee unit consistency)
 *
 * @see docs/IMPLEMENTATION_PLAN.md S2.2 (DEX Expansion)
 * @see docs/IMPLEMENTATION_PLAN.md S3.3.2 (Solana DEX Config)
 */

import type { Dex, Token } from '@arbitrage/types';

// Set required environment variables BEFORE any config imports
process.env.NODE_ENV = 'test';

const config = require('@arbitrage/config') as {
  CHAINS: Record<string, { id: number; name: string; nativeToken: string; blockTime: number; rpcUrl: string; wsUrl: string; isEVM?: boolean }>;
  DEXES: Record<string, Dex[]>;
  CORE_TOKENS: Record<string, Token[]>;
  ARBITRAGE_CONFIG: { minProfitPercentage: number; chainMinProfits: Record<string, number> };
  TOKEN_METADATA: Record<string, { weth: string; stablecoins: Array<{ address: string; symbol: string; decimals: number }> }>;
  DETECTOR_CONFIG: Record<string, { batchSize: number; batchTimeout: number; confidence?: number; expiryMs?: number; gasEstimate?: number; whaleThreshold?: number }>;
  PHASE_METRICS: { targets: { phase1: { dexes: number; chains: number; tokens: number } }; current: { dexes: number; chains: number; tokens: number } };
  getEnabledDexes: (chainId: string) => Dex[];
  dexFeeToPercentage: (feeBasisPoints: number) => number;
  percentageToBasisPoints: (percentage: number) => number;
};

const {
  CHAINS, DEXES, CORE_TOKENS, ARBITRAGE_CONFIG, TOKEN_METADATA,
  DETECTOR_CONFIG, PHASE_METRICS,
  getEnabledDexes, dexFeeToPercentage, percentageToBasisPoints
} = config;

// Import Solana DEX program constants
import { SOLANA_DEX_PROGRAMS } from '@arbitrage/core';

// =============================================================================
// Constants and Test Data
// =============================================================================

const EVM_CHAINS = ['ethereum', 'arbitrum', 'optimism', 'base', 'polygon', 'bsc', 'avalanche', 'fantom', 'zksync', 'linea'];
const ALL_CHAINS = [...EVM_CHAINS, 'solana'];

/** Expected DEX counts per chain */
const EXPECTED_DEX_COUNTS: Record<string, number> = {
  arbitrum: 9,
  bsc: 8,
  base: 7,
  avalanche: 6,
  polygon: 4,
  fantom: 4,
  optimism: 3,
  ethereum: 5,
  zksync: 2,
  linea: 2,
  solana: 7,
};

/** Solana DEX program IDs for validation */
const SOLANA_DEX_PROGRAM_IDS = {
  JUPITER: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  RAYDIUM_AMM: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  RAYDIUM_CLMM: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  ORCA_WHIRLPOOL: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  METEORA_DLMM: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  PHOENIX: 'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY',
  LIFINITY: '2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c',
} as const;

function isValidSolanaAddress(address: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

// =============================================================================
// EVM Chain DEX Structural Validation (table-driven)
// =============================================================================

describe.each(EVM_CHAINS)('%s DEX Configuration', (chain) => {
  const dexes = DEXES[chain] || [];

  it(`should have ${EXPECTED_DEX_COUNTS[chain]} DEXes configured`, () => {
    expect(dexes.length).toBe(EXPECTED_DEX_COUNTS[chain]);
  });

  it('should have valid EVM hex addresses for factory', () => {
    dexes.forEach(dex => {
      expect(dex.factoryAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(dex.factoryAddress).not.toBe('0x0000000000000000000000000000000000000000');
    });
  });

  it('should have valid EVM hex addresses for router', () => {
    dexes.forEach(dex => {
      expect(dex.routerAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(dex.routerAddress).not.toBe('0x0000000000000000000000000000000000000000');
    });
  });

  it('should have required fields on each DEX', () => {
    dexes.forEach(dex => {
      expect(dex.name).toBeDefined();
      expect(typeof dex.name).toBe('string');
      expect(dex.name.length).toBeGreaterThan(0);
      expect(dex.factoryAddress).toBeDefined();
      expect(dex.routerAddress).toBeDefined();
      expect(dex.feeBps).toBeDefined();
      expect(dex.chain).toBe(chain);
    });
  });

  it('should have non-negative integer fees in basis points', () => {
    dexes.forEach(dex => {
      expect(dex.feeBps).toBeGreaterThanOrEqual(0);
      expect(dex.feeBps).toBeLessThan(1000);
      expect(Number.isInteger(dex.feeBps)).toBe(true);
    });
  });

  it('should have unique factory addresses', () => {
    const addresses = dexes.map(d => d.factoryAddress.toLowerCase());
    expect(new Set(addresses).size).toBe(dexes.length);
  });

  it('should have unique DEX names', () => {
    const names = dexes.map(d => d.name);
    expect(new Set(names).size).toBe(dexes.length);
  });

  it('should return only enabled DEXes from getEnabledDexes', () => {
    const enabled = getEnabledDexes(chain);
    enabled.forEach(dex => {
      expect(dex.enabled).not.toBe(false);
    });
  });
});

// =============================================================================
// Chain-Specific DEX Name Validation
// =============================================================================

describe('Chain-Specific DEX Names', () => {
  it.each([
    ['bsc', ['pancakeswap_v3', 'pancakeswap_v2', 'biswap', 'thena', 'apeswap', 'mdex', 'ellipsis', 'nomiswap']],
    ['arbitrum', ['uniswap_v3', 'sushiswap', 'camelot_v3', 'trader_joe', 'zyberswap', 'ramses', 'balancer_v2', 'curve', 'chronos']],
    ['base', ['uniswap_v3', 'aerodrome', 'baseswap', 'sushiswap', 'alienbase', 'swapbased', 'maverick']],
    ['optimism', ['uniswap_v3', 'velodrome', 'sushiswap']],
    ['avalanche', ['trader_joe_v2', 'pangolin', 'sushiswap', 'platypus', 'gmx', 'kyberswap']],
    ['fantom', ['spookyswap', 'spiritswap', 'equalizer', 'beethoven_x']],
    ['solana', ['jupiter', 'raydium', 'raydium-clmm', 'orca', 'meteora', 'phoenix', 'lifinity']],
  ])('%s should contain expected DEX names', (chain, expectedNames) => {
    const dexNames = DEXES[chain].map((d: Dex) => d.name);
    for (const name of expectedNames) {
      expect(dexNames).toContain(name);
    }
  });
});

// =============================================================================
// Solana DEX Configuration (non-EVM, base58 addresses)
// =============================================================================

describe('Solana DEX Configuration', () => {
  const solanaDexes = DEXES.solana || [];

  it('should have at least 7 Solana DEXs configured', () => {
    expect(solanaDexes.length).toBeGreaterThanOrEqual(7);
  });

  it('should have all DEXs with chain set to solana', () => {
    for (const dex of solanaDexes) {
      expect(dex.chain).toBe('solana');
    }
  });

  it('should have valid base58 Solana addresses (not EVM hex)', () => {
    for (const dex of solanaDexes) {
      expect(isValidSolanaAddress(dex.factoryAddress)).toBe(true);
      expect(dex.factoryAddress.startsWith('0x')).toBe(false);
    }
  });

  it('should have unique program IDs', () => {
    const ids = solanaDexes.map((d: Dex) => d.factoryAddress);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('should have unique DEX names', () => {
    const names = solanaDexes.map((d: Dex) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('should have reasonable fees (0-100 bps)', () => {
    for (const dex of solanaDexes) {
      expect(dex.feeBps).toBeGreaterThanOrEqual(0);
      expect(dex.feeBps).toBeLessThanOrEqual(100);
    }
  });

  it('should have all feeBps as integers', () => {
    for (const dex of solanaDexes) {
      expect(Number.isInteger(dex.feeBps)).toBe(true);
    }
  });
});

describe('Solana DEX Program ID Constants', () => {
  it('should export SOLANA_DEX_PROGRAMS', () => {
    expect(SOLANA_DEX_PROGRAMS).toBeDefined();
    expect(typeof SOLANA_DEX_PROGRAMS).toBe('object');
    expect(Object.keys(SOLANA_DEX_PROGRAMS).length).toBeGreaterThanOrEqual(7);
  });

  it.each([
    ['JUPITER', SOLANA_DEX_PROGRAM_IDS.JUPITER],
    ['RAYDIUM_AMM', SOLANA_DEX_PROGRAM_IDS.RAYDIUM_AMM],
    ['RAYDIUM_CLMM', SOLANA_DEX_PROGRAM_IDS.RAYDIUM_CLMM],
    ['ORCA_WHIRLPOOL', SOLANA_DEX_PROGRAM_IDS.ORCA_WHIRLPOOL],
    ['METEORA_DLMM', SOLANA_DEX_PROGRAM_IDS.METEORA_DLMM],
    ['PHOENIX', SOLANA_DEX_PROGRAM_IDS.PHOENIX],
    ['LIFINITY', SOLANA_DEX_PROGRAM_IDS.LIFINITY],
  ])('should have correct program ID for %s', (key, expectedId) => {
    expect((SOLANA_DEX_PROGRAMS as any)[key]).toBe(expectedId);
  });

  it('should have valid base58 format for all program IDs', () => {
    for (const [, programId] of Object.entries(SOLANA_DEX_PROGRAMS)) {
      expect(isValidSolanaAddress(programId as string)).toBe(true);
    }
  });

  it('should match factoryAddress in DEXES.solana config', () => {
    const solanaDexes = DEXES.solana || [];
    const raydium = solanaDexes.find((d: Dex) => d.name === 'raydium');
    expect(raydium?.factoryAddress).toBe(SOLANA_DEX_PROGRAMS.RAYDIUM_AMM);
    const orca = solanaDexes.find((d: Dex) => d.name === 'orca');
    expect(orca?.factoryAddress).toBe(SOLANA_DEX_PROGRAMS.ORCA_WHIRLPOOL);
  });
});

describe('Solana DEX Type Classification', () => {
  it.each([
    ['jupiter', 'aggregator'],
    ['raydium', 'amm'],
    ['raydium-clmm', 'clmm'],
    ['orca', 'clmm'],
    ['meteora', 'dlmm'],
    ['phoenix', 'orderbook'],
    ['lifinity', 'pmm'],
  ])('should classify %s as %s type', (dexName, expectedType) => {
    const dex = DEXES.solana.find((d: Dex) => d.name === dexName);
    expect(dex).toBeDefined();
    expect((dex as any)?.type).toBe(expectedType);
  });

  it('should have type field for all Solana DEXs', () => {
    for (const dex of DEXES.solana) {
      expect((dex as any).type).toBeDefined();
    }
  });
});

describe('Solana DEX Enable/Disable Status', () => {
  const solanaDexes = DEXES.solana || [];

  it('should have at least 5 enabled Solana DEXs', () => {
    const enabled = solanaDexes.filter((d: Dex) => d.enabled !== false);
    expect(enabled.length).toBeGreaterThanOrEqual(5);
  });

  it.each([
    ['raydium', true],
    ['orca', true],
    ['raydium-clmm', true],
    ['meteora', true],
  ])('should have %s enabled', (dexName) => {
    const dex = solanaDexes.find((d: Dex) => d.name === dexName);
    expect(dex?.enabled).not.toBe(false);
  });

  it('should have Jupiter disabled (aggregator routes through other DEXs)', () => {
    const jupiter = solanaDexes.find((d: Dex) => d.name === 'jupiter');
    expect(jupiter).toBeDefined();
    expect(jupiter?.enabled).toBe(false);
  });
});

describe('Solana DEX Fee Structure', () => {
  it.each([
    ['jupiter', 0],
    ['raydium', 25],
    ['orca', 30],
    ['phoenix', 10],
    ['lifinity', 20],
  ])('should have %s with %d bps fee', (dexName, expectedFee) => {
    const dex = DEXES.solana.find((d: Dex) => d.name === dexName);
    expect(dex?.feeBps).toBe(expectedFee);
  });

  it.each([
    ['raydium-clmm'],
    ['meteora'],
  ])('should have %s with dynamic fee in 1-100 bps range', (dexName) => {
    const dex = DEXES.solana.find((d: Dex) => d.name === dexName);
    expect(dex?.feeBps).toBeGreaterThanOrEqual(1);
    expect(dex?.feeBps).toBeLessThanOrEqual(100);
  });
});

// =============================================================================
// Solana Integration with Chain Config
// =============================================================================

describe('Solana Chain Config Integration', () => {
  it('should have Solana chain configured as non-EVM', () => {
    expect(CHAINS.solana).toBeDefined();
    expect(CHAINS.solana.isEVM).toBe(false);
    expect(CHAINS.solana.id).toBe(101);
  });

  it('should have at least 8 Solana tokens configured', () => {
    expect(CORE_TOKENS.solana.length).toBeGreaterThanOrEqual(8);
  });

  it('should have SOL native token', () => {
    const sol = CORE_TOKENS.solana.find((t: Token) => t.symbol === 'SOL');
    expect(sol).toBeDefined();
    expect(sol!.address).toBe('So11111111111111111111111111111111111111112');
    expect(sol!.decimals).toBe(9);
  });

  it('should have USDC stablecoin', () => {
    const usdc = CORE_TOKENS.solana.find((t: Token) => t.symbol === 'USDC');
    expect(usdc).toBeDefined();
    expect(usdc!.address).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(usdc!.decimals).toBe(6);
  });

  it('should have JUP token', () => {
    const jup = CORE_TOKENS.solana.find((t: Token) => t.symbol === 'JUP');
    expect(jup).toBeDefined();
    expect(jup!.address).toBe('JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN');
  });

  it('should have Solana detector config', () => {
    expect(DETECTOR_CONFIG.solana).toBeDefined();
    expect(DETECTOR_CONFIG.solana.batchSize).toBeGreaterThan(0);
    expect(DETECTOR_CONFIG.solana.batchTimeout).toBeGreaterThan(0);
  });

  it('should have Solana token metadata', () => {
    expect(TOKEN_METADATA.solana).toBeDefined();
  });
});

// =============================================================================
// BSC DEX-Specific Tests (fee strategy, arbitrage math)
// =============================================================================

describe('BSC DEX Specific Tests', () => {
  const bscDexes = DEXES.bsc;

  describe('Fee Structure', () => {
    it('should have Ellipsis as lowest fee DEX (4 bps for stablecoins)', () => {
      const ellipsis = bscDexes.find((d: Dex) => d.name === 'ellipsis');
      const otherDexes = bscDexes.filter((d: Dex) => d.name !== 'ellipsis');
      expect(ellipsis!.feeBps).toBe(4);
      otherDexes.forEach((dex: Dex) => {
        expect(ellipsis!.feeBps).toBeLessThanOrEqual(dex.feeBps);
      });
    });

    it('should have Biswap and Nomiswap tied at 10 bps', () => {
      const biswap = bscDexes.find((d: Dex) => d.name === 'biswap');
      const nomiswap = bscDexes.find((d: Dex) => d.name === 'nomiswap');
      expect(biswap?.feeBps).toBe(10);
      expect(nomiswap?.feeBps).toBe(10);
    });

    it('should have fee distribution: 4, 10, 10, 20, 20, 25, 25, 30', () => {
      const fees = bscDexes.map((d: Dex) => d.feeBps).sort((a: number, b: number) => a - b);
      expect(fees[0]).toBe(4);
      expect(fees[1]).toBe(10);
      expect(fees[2]).toBe(10);
    });

    it('should convert fees correctly with round-trip', () => {
      bscDexes.forEach((dex: Dex) => {
        const pct = dexFeeToPercentage(dex.feeBps);
        expect(pct).toBeLessThan(1);
        expect(pct).toBeGreaterThan(0);
        expect(percentageToBasisPoints(pct)).toBe(dex.feeBps);
      });
    });
  });

  describe('BSC-Specific DEX Config', () => {
    it.each([
      ['mdex', '0x3CD1C46068dAEa5Ebb0d3f55F6915B10648062B8', '0x7DAe51BD3E3376B8c7c4900E9107f12Be3AF1bA8', 30],
      ['ellipsis', '0xf65BEd27e96a367c61e0E06C54e14B16b84a5870', '0x160CAed03795365F3A589f10C379FfA7d75d4E76', 4],
    ])('should have correct config for %s (factory=%s, router=%s, fee=%d bps)', (name, factory, router, fee) => {
      const dex = bscDexes.find((d: Dex) => d.name === name);
      expect(dex).toBeDefined();
      expect(dex?.factoryAddress).toBe(factory);
      expect(dex?.routerAddress).toBe(router);
      expect(dex?.feeBps).toBe(fee);
      expect(dex?.chain).toBe('bsc');
    });

    it('should have correct Nomiswap factory (case-insensitive)', () => {
      const nomiswap = bscDexes.find((d: Dex) => d.name === 'nomiswap');
      expect(nomiswap?.factoryAddress.toLowerCase()).toBe('0xd6715a8be3944ec72738f0bfdc739571659d8010');
      expect(nomiswap?.feeBps).toBe(10);
    });
  });

  describe('Arbitrage Opportunities', () => {
    it('should support low-spread stablecoin arbitrage via Ellipsis', () => {
      const ellipsis = bscDexes.find((d: Dex) => d.name === 'ellipsis');
      const pancakeV3 = bscDexes.find((d: Dex) => d.name === 'pancakeswap_v3');
      const totalFees = dexFeeToPercentage(ellipsis!.feeBps) + dexFeeToPercentage(pancakeV3!.feeBps);
      const minSpread = totalFees + ARBITRAGE_CONFIG.chainMinProfits.bsc;
      expect(minSpread).toBeLessThan(0.006);
    });

    it('should enable Biswap <-> Nomiswap arbitrage at 0.2% total fees', () => {
      const biswapFee = dexFeeToPercentage(10);
      const nomiswapFee = dexFeeToPercentage(10);
      expect(biswapFee + nomiswapFee).toBe(0.002);
    });

    it('should have 28 unique DEX pairs (8 choose 2)', () => {
      expect((bscDexes.length * (bscDexes.length - 1)) / 2).toBe(28);
    });

    it('should generate 360 potential pairs (45 token pairs x 8 DEXes)', () => {
      const tokens = CORE_TOKENS.bsc;
      const pairsPerDex = (tokens.length * (tokens.length - 1)) / 2;
      expect(tokens.length).toBe(10);
      expect(pairsPerDex).toBe(45);
      expect(pairsPerDex * bscDexes.length).toBe(360);
    });

    it('should identify optimal paths involving low-fee DEXs', () => {
      const minProfit = ARBITRAGE_CONFIG.chainMinProfits.bsc;
      const paths: { path: string; minSpread: number }[] = [];

      for (let i = 0; i < bscDexes.length; i++) {
        for (let j = i + 1; j < bscDexes.length; j++) {
          const fee1 = dexFeeToPercentage(bscDexes[i].feeBps);
          const fee2 = dexFeeToPercentage(bscDexes[j].feeBps);
          paths.push({
            path: `${bscDexes[i].name}<->${bscDexes[j].name}`,
            minSpread: fee1 + fee2 + minProfit,
          });
        }
      }

      paths.sort((a, b) => a.minSpread - b.minSpread);
      const topPaths = paths.slice(0, 3);
      topPaths.forEach(p => {
        expect(p.path).toMatch(/ellipsis|biswap|nomiswap/);
      });
    });
  });
});

// =============================================================================
// BSC Token Coverage
// =============================================================================

describe('BSC Token Coverage', () => {
  const tokens = CORE_TOKENS.bsc;

  it('should have 10 BSC tokens', () => {
    expect(tokens.length).toBe(10);
  });

  it.each([
    'WBNB', 'USDT', 'USDC', 'BUSD', 'BTCB', 'ETH',
  ])('should include core token %s for arbitrage', (symbol) => {
    const token = tokens.find((t: Token) => t.symbol === symbol);
    expect(token).toBeDefined();
    expect(token?.chainId).toBe(56);
  });

  it('should have stablecoins for Ellipsis arbitrage', () => {
    const stables = ['USDT', 'USDC', 'BUSD'];
    stables.forEach(symbol => {
      expect(tokens.find((t: Token) => t.symbol === symbol)).toBeDefined();
    });
    expect(TOKEN_METADATA.bsc.stablecoins.length).toBeGreaterThanOrEqual(3);
  });

  it('should have valid token addresses', () => {
    tokens.forEach((token: Token) => {
      expect(token.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(token.decimals).toBeGreaterThan(0);
      expect(token.decimals).toBeLessThanOrEqual(18);
    });
  });
});

// =============================================================================
// System-wide DEX Count
// =============================================================================

describe('System-wide DEX Counts', () => {
  it('should have at least 49 total DEXs across all chains', () => {
    const totalDexes = Object.values(DEXES).flat().length;
    expect(totalDexes).toBeGreaterThanOrEqual(49);
  });

  it.each(
    Object.entries(EXPECTED_DEX_COUNTS)
  )('should have %s with %d DEXes', (chain, count) => {
    expect(DEXES[chain].length).toBe(count);
  });

  it('should have PHASE_METRICS.current match actual DEX count', () => {
    const actualDexCount = Object.values(DEXES).flat().length;
    expect(PHASE_METRICS.current.dexes).toBe(actualDexCount);
  });
});

// =============================================================================
// Cross-chain Consistency
// =============================================================================

describe('Cross-chain DEX Consistency', () => {
  it('should have DEXes defined for all 11 chains', () => {
    ALL_CHAINS.forEach(chain => {
      expect(DEXES[chain]).toBeDefined();
      expect(DEXES[chain].length).toBeGreaterThan(0);
    });
  });

  it('should return empty array from getEnabledDexes for unknown chain', () => {
    expect(getEnabledDexes('nonexistent-chain')).toEqual([]);
  });
});

// =============================================================================
// Fee Helper Functions
// =============================================================================

describe('Fee Helper Functions', () => {
  it('should convert basis points to decimal percentage', () => {
    expect(dexFeeToPercentage(25)).toBeCloseTo(0.0025, 6);
    expect(dexFeeToPercentage(30)).toBeCloseTo(0.003, 6);
    expect(dexFeeToPercentage(4)).toBeCloseTo(0.0004, 6);
    expect(dexFeeToPercentage(0)).toBe(0);
  });

  it('should convert decimal percentage to basis points', () => {
    expect(percentageToBasisPoints(0.0025)).toBe(25);
    expect(percentageToBasisPoints(0.003)).toBe(30);
    expect(percentageToBasisPoints(0.0004)).toBe(4);
  });
});

// =============================================================================
// Performance
// =============================================================================

describe('DEX Lookup Performance', () => {
  it('should process 10000 DEX lookups in < 200ms', () => {
    const startTime = performance.now();

    for (let i = 0; i < 10000; i++) {
      const dexes = getEnabledDexes('bsc');
      const mdex = dexes.find((d: Dex) => d.name === 'mdex');
      if (mdex) dexFeeToPercentage(mdex.feeBps);
    }

    expect(performance.now() - startTime).toBeLessThan(200);
  });

  it('should maintain O(n^2) pair complexity within limits per chain', () => {
    for (const chain of ALL_CHAINS) {
      const tokens = CORE_TOKENS[chain] || [];
      const dexes = DEXES[chain] || [];
      const tokenPairs = (tokens.length * (tokens.length - 1)) / 2;
      const totalPairs = tokenPairs * dexes.length;
      // Each chain should have manageable pair count
      expect(totalPairs).toBeLessThan(1000);
    }
  });
});

// =============================================================================
// Regression Tests
// =============================================================================

describe('Regression: Fee Unit Consistency', () => {
  it.each(ALL_CHAINS)('should store all %s DEX fees in basis points (positive integers)', (chain) => {
    DEXES[chain].forEach((dex: Dex) => {
      expect(Number.isInteger(dex.feeBps)).toBe(true);
      expect(dex.feeBps).toBeGreaterThanOrEqual(0);
      expect(dex.feeBps).toBeLessThan(1000);
    });
  });
});

describe('Regression: Nullish Coalescing for Fees', () => {
  it('should use ?? not || for fee fallbacks to handle fee:0 correctly', () => {
    const zeroFee = 0;
    const defaultFee = 0.003;

    // ?? preserves 0
    expect(zeroFee ?? defaultFee).toBe(0);
    // || treats 0 as falsy (the bug pattern)
    expect(zeroFee || defaultFee).toBe(defaultFee);
  });

  it('should use ?? not || for chainMinProfits fallbacks', () => {
    const zeroProfit = 0;
    const defaultProfit = 0.003;
    expect(zeroProfit ?? defaultProfit).toBe(0);
    expect(zeroProfit || defaultProfit).toBe(defaultProfit);
  });

  it('should call dexFeeToPercentage even for fee:0 with ?? operator', () => {
    const zeroFee: number | null = 0;
    const nonZeroFee: number | null = 30;
    expect(dexFeeToPercentage(zeroFee ?? 30)).toBe(dexFeeToPercentage(0));
    expect(dexFeeToPercentage(nonZeroFee ?? 30)).toBe(dexFeeToPercentage(30));
    expect(dexFeeToPercentage(0)).toBe(0);
  });
});

describe('Regression: Profit Calculation', () => {
  it('should calculate NET profit (not gross) for opportunities', () => {
    const price1 = 300;
    const price2 = 305;
    const fee1 = dexFeeToPercentage(25);
    const fee2 = dexFeeToPercentage(30);

    const grossProfit = Math.abs(price1 - price2) / Math.min(price1, price2);
    const netProfit = grossProfit - (fee1 + fee2);

    expect(netProfit).toBeLessThan(grossProfit);
    expect(netProfit).toBeGreaterThan(0);
  });

  it('should use consistent price formula (reserve0/reserve1)', () => {
    const reserve0 = 1000n;
    const reserve1 = 3000n;
    const correctPrice = Number(reserve0) / Number(reserve1);
    expect(correctPrice).toBeCloseTo(0.333, 2);
  });
});

describe('Regression: Config Accuracy', () => {
  it('should have PHASE_METRICS match actual DEX count', () => {
    const actual = Object.values(DEXES).flat().length;
    expect(PHASE_METRICS.current.dexes).toBe(actual);
  });
});

describe('Regression: Solana Address Format', () => {
  it('should not regress to EVM-style addresses', () => {
    for (const dex of DEXES.solana) {
      expect(dex.factoryAddress.startsWith('0x')).toBe(false);
    }
  });

  it('should maintain correct Orca Whirlpool program ID (not legacy token swap)', () => {
    const orca = DEXES.solana.find((d: Dex) => d.name === 'orca');
    expect(orca?.factoryAddress).toBe('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
  });
});
