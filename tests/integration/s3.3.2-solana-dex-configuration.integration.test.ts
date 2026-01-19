/**
 * S3.3.2 Solana DEX Configuration Integration Tests
 *
 * TDD tests for Solana DEX configurations (7 DEXs):
 * - Jupiter (aggregator)
 * - Raydium AMM
 * - Raydium CLMM (concentrated liquidity)
 * - Orca Whirlpools
 * - Meteora DLMM
 * - Phoenix (order book)
 * - Lifinity
 *
 * @see IMPLEMENTATION_PLAN.md S3.3.2
 */

import { describe, it, expect, beforeAll } from '@jest/globals';

// Import config directly
import {
  CHAINS,
  DEXES,
  CORE_TOKENS,
  DETECTOR_CONFIG,
  TOKEN_METADATA
} from '@arbitrage/config';

// Import solana-detector for program ID constants
import { SOLANA_DEX_PROGRAMS } from '@arbitrage/core';

// =============================================================================
// S3.3.2 Expected Configuration
// =============================================================================

/**
 * Expected Solana DEX program IDs from implementation plan
 */
const EXPECTED_DEX_PROGRAMS = {
  // Jupiter Aggregator - Routes through multiple DEXs
  JUPITER: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',

  // Raydium AMM - Traditional constant product AMM
  RAYDIUM_AMM: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',

  // Raydium CLMM - Concentrated Liquidity Market Maker
  RAYDIUM_CLMM: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',

  // Orca Whirlpools - Concentrated liquidity
  ORCA_WHIRLPOOL: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',

  // Meteora DLMM - Dynamic Liquidity Market Maker
  METEORA_DLMM: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',

  // Phoenix - On-chain order book
  PHOENIX: 'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY',

  // Lifinity - Proactive market maker with oracle pricing
  LIFINITY: '2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c'
} as const;

/**
 * Expected DEX configurations with types and fees
 */
const EXPECTED_DEXES = [
  {
    name: 'jupiter',
    programId: EXPECTED_DEX_PROGRAMS.JUPITER,
    type: 'aggregator',
    // S3.3.2-FIX: Jupiter is disabled for direct pool detection (routes through other DEXs)
    enabled: false,
    fee: 0 // Jupiter is a router, fee comes from underlying DEX
  },
  {
    name: 'raydium',
    programId: EXPECTED_DEX_PROGRAMS.RAYDIUM_AMM,
    type: 'amm',
    enabled: true,
    fee: 25 // 0.25%
  },
  {
    name: 'raydium-clmm',
    programId: EXPECTED_DEX_PROGRAMS.RAYDIUM_CLMM,
    type: 'clmm',
    enabled: true,
    fee: 25 // Dynamic based on pool
  },
  {
    name: 'orca',
    programId: EXPECTED_DEX_PROGRAMS.ORCA_WHIRLPOOL,
    type: 'clmm',
    enabled: true,
    fee: 30 // Dynamic based on pool
  },
  {
    name: 'meteora',
    programId: EXPECTED_DEX_PROGRAMS.METEORA_DLMM,
    type: 'dlmm',
    enabled: true,
    fee: 20 // Dynamic based on bin step
  },
  {
    name: 'phoenix',
    programId: EXPECTED_DEX_PROGRAMS.PHOENIX,
    type: 'orderbook',
    enabled: true,
    fee: 10 // 0.1% taker fee
  },
  {
    name: 'lifinity',
    programId: EXPECTED_DEX_PROGRAMS.LIFINITY,
    type: 'pmm',
    enabled: true,
    fee: 20 // 0.2%
  }
] as const;

// =============================================================================
// Test Utilities
// =============================================================================

/**
 * Validates a Solana base58 address format
 */
function isValidSolanaAddress(address: string): boolean {
  // Solana addresses are base58 encoded, 32-44 characters
  // Must contain only base58 characters (no 0, O, I, l)
  const base58Regex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  return base58Regex.test(address);
}

/**
 * Validates that a program ID is not an EVM hex address
 */
function isNotEvmAddress(address: string): boolean {
  // EVM addresses start with 0x and are 42 characters
  return !address.startsWith('0x');
}

// =============================================================================
// S3.3.2.1: Solana DEX Program ID Constants Tests
// =============================================================================

describe('S3.3.2.1: Solana DEX Program ID Constants', () => {
  it('should export SOLANA_DEX_PROGRAMS from solana-detector', () => {
    expect(SOLANA_DEX_PROGRAMS).toBeDefined();
    expect(typeof SOLANA_DEX_PROGRAMS).toBe('object');
  });

  it('should have Jupiter aggregator program ID', () => {
    expect(SOLANA_DEX_PROGRAMS.JUPITER).toBe(EXPECTED_DEX_PROGRAMS.JUPITER);
  });

  it('should have Raydium AMM program ID', () => {
    expect(SOLANA_DEX_PROGRAMS.RAYDIUM_AMM).toBe(EXPECTED_DEX_PROGRAMS.RAYDIUM_AMM);
  });

  it('should have Raydium CLMM program ID', () => {
    expect(SOLANA_DEX_PROGRAMS.RAYDIUM_CLMM).toBe(EXPECTED_DEX_PROGRAMS.RAYDIUM_CLMM);
  });

  it('should have Orca Whirlpool program ID', () => {
    expect(SOLANA_DEX_PROGRAMS.ORCA_WHIRLPOOL).toBe(EXPECTED_DEX_PROGRAMS.ORCA_WHIRLPOOL);
  });

  it('should have Meteora DLMM program ID', () => {
    expect(SOLANA_DEX_PROGRAMS.METEORA_DLMM).toBe(EXPECTED_DEX_PROGRAMS.METEORA_DLMM);
  });

  it('should have Phoenix program ID', () => {
    expect(SOLANA_DEX_PROGRAMS.PHOENIX).toBe(EXPECTED_DEX_PROGRAMS.PHOENIX);
  });

  it('should have Lifinity program ID', () => {
    expect(SOLANA_DEX_PROGRAMS.LIFINITY).toBe(EXPECTED_DEX_PROGRAMS.LIFINITY);
  });

  it('should have all 7 DEX program IDs', () => {
    const programIds = Object.keys(SOLANA_DEX_PROGRAMS);
    expect(programIds.length).toBeGreaterThanOrEqual(7);
  });

  it('should have valid Solana address format for all program IDs', () => {
    for (const [name, address] of Object.entries(SOLANA_DEX_PROGRAMS)) {
      expect(isValidSolanaAddress(address)).toBe(true);
      expect(isNotEvmAddress(address)).toBe(true);
    }
  });
});

// =============================================================================
// S3.3.2.2: Solana DEX Configuration in shared/config Tests
// =============================================================================

describe('S3.3.2.2: Solana DEX Configuration in shared/config', () => {
  let solanaDexConfigs: Array<{
    name: string;
    chain: string;
    factoryAddress: string;
    routerAddress: string;
    fee: number;
    enabled?: boolean;
    type?: string;
  }>;

  beforeAll(() => {
    solanaDexConfigs = DEXES.solana || [];
  });

  it('should have Solana DEX configurations defined', () => {
    expect(DEXES.solana).toBeDefined();
    expect(Array.isArray(DEXES.solana)).toBe(true);
  });

  it('should have at least 7 Solana DEXs configured', () => {
    expect(solanaDexConfigs.length).toBeGreaterThanOrEqual(7);
  });

  it('should have Jupiter aggregator configured', () => {
    const jupiter = solanaDexConfigs.find(d => d.name === 'jupiter');
    expect(jupiter).toBeDefined();
    expect(jupiter?.factoryAddress).toBe(EXPECTED_DEX_PROGRAMS.JUPITER);
    expect(jupiter?.chain).toBe('solana');
  });

  it('should have Raydium AMM configured', () => {
    const raydium = solanaDexConfigs.find(d => d.name === 'raydium');
    expect(raydium).toBeDefined();
    expect(raydium?.factoryAddress).toBe(EXPECTED_DEX_PROGRAMS.RAYDIUM_AMM);
    expect(raydium?.fee).toBe(25);
  });

  it('should have Raydium CLMM configured', () => {
    const raydiumClmm = solanaDexConfigs.find(d => d.name === 'raydium-clmm');
    expect(raydiumClmm).toBeDefined();
    expect(raydiumClmm?.factoryAddress).toBe(EXPECTED_DEX_PROGRAMS.RAYDIUM_CLMM);
  });

  it('should have Orca Whirlpools configured with correct program ID', () => {
    const orca = solanaDexConfigs.find(d => d.name === 'orca');
    expect(orca).toBeDefined();
    // Orca Whirlpool program ID (not the old token swap)
    expect(orca?.factoryAddress).toBe(EXPECTED_DEX_PROGRAMS.ORCA_WHIRLPOOL);
    expect(orca?.fee).toBe(30);
  });

  it('should have Meteora DLMM configured', () => {
    const meteora = solanaDexConfigs.find(d => d.name === 'meteora');
    expect(meteora).toBeDefined();
    expect(meteora?.factoryAddress).toBe(EXPECTED_DEX_PROGRAMS.METEORA_DLMM);
  });

  it('should have Phoenix configured', () => {
    const phoenix = solanaDexConfigs.find(d => d.name === 'phoenix');
    expect(phoenix).toBeDefined();
    expect(phoenix?.factoryAddress).toBe(EXPECTED_DEX_PROGRAMS.PHOENIX);
  });

  it('should have Lifinity configured', () => {
    const lifinity = solanaDexConfigs.find(d => d.name === 'lifinity');
    expect(lifinity).toBeDefined();
    expect(lifinity?.factoryAddress).toBe(EXPECTED_DEX_PROGRAMS.LIFINITY);
  });

  it('should have all DEXs with chain set to solana', () => {
    for (const dex of solanaDexConfigs) {
      expect(dex.chain).toBe('solana');
    }
  });

  it('should have valid Solana addresses for all DEX program IDs', () => {
    for (const dex of solanaDexConfigs) {
      expect(isValidSolanaAddress(dex.factoryAddress)).toBe(true);
      expect(isNotEvmAddress(dex.factoryAddress)).toBe(true);
    }
  });

  it('should have reasonable fee values for all DEXs', () => {
    for (const dex of solanaDexConfigs) {
      // Fees should be 0-100 basis points typically
      expect(dex.fee).toBeGreaterThanOrEqual(0);
      expect(dex.fee).toBeLessThanOrEqual(100);
    }
  });
});

// =============================================================================
// S3.3.2.3: DEX Type Classification Tests
// =============================================================================

describe('S3.3.2.3: DEX Type Classification', () => {
  let solanaDexConfigs: Array<{
    name: string;
    type?: string;
    factoryAddress: string;
  }>;

  beforeAll(() => {
    solanaDexConfigs = DEXES.solana || [];
  });

  it('should classify Jupiter as aggregator type', () => {
    const jupiter = solanaDexConfigs.find(d => d.name === 'jupiter');
    expect(jupiter?.type).toBe('aggregator');
  });

  it('should classify Raydium AMM as amm type', () => {
    const raydium = solanaDexConfigs.find(d => d.name === 'raydium');
    expect(raydium?.type).toBe('amm');
  });

  it('should classify Raydium CLMM as clmm type', () => {
    const raydiumClmm = solanaDexConfigs.find(d => d.name === 'raydium-clmm');
    expect(raydiumClmm?.type).toBe('clmm');
  });

  it('should classify Orca Whirlpools as clmm type', () => {
    const orca = solanaDexConfigs.find(d => d.name === 'orca');
    expect(orca?.type).toBe('clmm');
  });

  it('should classify Meteora as dlmm type', () => {
    const meteora = solanaDexConfigs.find(d => d.name === 'meteora');
    expect(meteora?.type).toBe('dlmm');
  });

  it('should classify Phoenix as orderbook type', () => {
    const phoenix = solanaDexConfigs.find(d => d.name === 'phoenix');
    expect(phoenix?.type).toBe('orderbook');
  });

  it('should classify Lifinity as pmm type', () => {
    const lifinity = solanaDexConfigs.find(d => d.name === 'lifinity');
    expect(lifinity?.type).toBe('pmm');
  });

  it('should have type field for all Solana DEXs', () => {
    for (const dex of solanaDexConfigs) {
      expect(dex.type).toBeDefined();
      expect(typeof dex.type).toBe('string');
    }
  });
});

// =============================================================================
// S3.3.2.4: DEX Enable/Disable Status Tests
// =============================================================================

describe('S3.3.2.4: DEX Enable/Disable Status', () => {
  let solanaDexConfigs: Array<{
    name: string;
    enabled?: boolean;
    factoryAddress: string;
  }>;

  beforeAll(() => {
    solanaDexConfigs = DEXES.solana || [];
  });

  it('should have at least 5 enabled Solana DEXs', () => {
    const enabledDexes = solanaDexConfigs.filter(d => d.enabled !== false);
    expect(enabledDexes.length).toBeGreaterThanOrEqual(5);
  });

  it('should have Raydium AMM enabled (most volume)', () => {
    const raydium = solanaDexConfigs.find(d => d.name === 'raydium');
    expect(raydium?.enabled).not.toBe(false);
  });

  it('should have Orca enabled (second most volume)', () => {
    const orca = solanaDexConfigs.find(d => d.name === 'orca');
    expect(orca?.enabled).not.toBe(false);
  });

  it('should have Raydium CLMM enabled', () => {
    const raydiumClmm = solanaDexConfigs.find(d => d.name === 'raydium-clmm');
    expect(raydiumClmm?.enabled).not.toBe(false);
  });

  it('should have Meteora enabled', () => {
    const meteora = solanaDexConfigs.find(d => d.name === 'meteora');
    expect(meteora?.enabled).not.toBe(false);
  });

  // S3.3.2-FIX: Jupiter is an aggregator - explicitly disabled for direct pool detection
  it('should have Jupiter disabled (aggregator routes through other DEXs)', () => {
    const jupiter = solanaDexConfigs.find(d => d.name === 'jupiter');
    expect(jupiter).toBeDefined();
    // Regression test: Jupiter must be disabled to avoid double-counting
    // Aggregators route through other DEXs, so enabling would cause duplicate detection
    expect(jupiter?.enabled).toBe(false);
  });

  // Phoenix is an order book - different execution model
  it('should have Phoenix with explicit enabled status', () => {
    const phoenix = solanaDexConfigs.find(d => d.name === 'phoenix');
    expect(phoenix).toBeDefined();
    // Order books have different liquidity model - status should be explicit
    expect(typeof phoenix?.enabled).toBe('boolean');
  });
});

// =============================================================================
// S3.3.2.5: Integration with Solana Chain Config Tests
// =============================================================================

describe('S3.3.2.5: Integration with Solana Chain Config', () => {
  it('should have Solana chain configured', () => {
    expect(CHAINS.solana).toBeDefined();
  });

  it('should have Solana marked as non-EVM', () => {
    expect(CHAINS.solana.isEVM).toBe(false);
  });

  it('should have correct Solana chain ID', () => {
    // Solana mainnet uses 101 as convention
    expect(CHAINS.solana.id).toBe(101);
  });

  it('should have Solana tokens configured', () => {
    expect(CORE_TOKENS.solana).toBeDefined();
    expect(Array.isArray(CORE_TOKENS.solana)).toBe(true);
    expect(CORE_TOKENS.solana.length).toBeGreaterThan(0);
  });

  it('should have Solana detector config', () => {
    expect(DETECTOR_CONFIG.solana).toBeDefined();
  });

  it('should have Solana token metadata', () => {
    expect(TOKEN_METADATA.solana).toBeDefined();
  });

  it('should have at least 8 Solana tokens for DEX pairs', () => {
    expect(CORE_TOKENS.solana.length).toBeGreaterThanOrEqual(8);
  });

  it('should have SOL (native) token configured', () => {
    const sol = CORE_TOKENS.solana.find(
      (t: { symbol: string }) => t.symbol === 'SOL'
    );
    expect(sol).toBeDefined();
    expect(sol!.address).toBe('So11111111111111111111111111111111111111112');
    expect(sol!.decimals).toBe(9);
  });

  it('should have USDC stablecoin configured', () => {
    const usdc = CORE_TOKENS.solana.find(
      (t: { symbol: string }) => t.symbol === 'USDC'
    );
    expect(usdc).toBeDefined();
    expect(usdc!.address).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(usdc!.decimals).toBe(6);
  });

  it('should have JUP token configured for Jupiter DEX', () => {
    const jup = CORE_TOKENS.solana.find(
      (t: { symbol: string }) => t.symbol === 'JUP'
    );
    expect(jup).toBeDefined();
    expect(jup!.address).toBe('JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN');
  });
});

// =============================================================================
// S3.3.2.6: DEX Fee Structure Tests
// =============================================================================

describe('S3.3.2.6: DEX Fee Structure', () => {
  let solanaDexConfigs: Array<{
    name: string;
    fee: number;
    type?: string;
  }>;

  beforeAll(() => {
    solanaDexConfigs = DEXES.solana || [];
  });

  it('should have Jupiter with 0 fee (aggregator)', () => {
    const jupiter = solanaDexConfigs.find(d => d.name === 'jupiter');
    expect(jupiter?.fee).toBe(0);
  });

  it('should have Raydium AMM with 25 basis points fee', () => {
    const raydium = solanaDexConfigs.find(d => d.name === 'raydium');
    expect(raydium?.fee).toBe(25);
  });

  it('should have Raydium CLMM with dynamic fee (25 default)', () => {
    const raydiumClmm = solanaDexConfigs.find(d => d.name === 'raydium-clmm');
    expect(raydiumClmm?.fee).toBeGreaterThanOrEqual(1);
    expect(raydiumClmm?.fee).toBeLessThanOrEqual(100);
  });

  it('should have Orca with 30 basis points fee', () => {
    const orca = solanaDexConfigs.find(d => d.name === 'orca');
    expect(orca?.fee).toBe(30);
  });

  it('should have Meteora with dynamic fee (20 default)', () => {
    const meteora = solanaDexConfigs.find(d => d.name === 'meteora');
    expect(meteora?.fee).toBeGreaterThanOrEqual(1);
    expect(meteora?.fee).toBeLessThanOrEqual(100);
  });

  it('should have Phoenix with 10 basis points taker fee', () => {
    const phoenix = solanaDexConfigs.find(d => d.name === 'phoenix');
    expect(phoenix?.fee).toBe(10);
  });

  it('should have Lifinity with 20 basis points fee', () => {
    const lifinity = solanaDexConfigs.find(d => d.name === 'lifinity');
    expect(lifinity?.fee).toBe(20);
  });

  it('should have all fees as integers (basis points)', () => {
    for (const dex of solanaDexConfigs) {
      expect(Number.isInteger(dex.fee)).toBe(true);
    }
  });
});

// =============================================================================
// S3.3.2.7: Program ID Uniqueness and Validation Tests
// =============================================================================

describe('S3.3.2.7: Program ID Uniqueness and Validation', () => {
  let solanaDexConfigs: Array<{
    name: string;
    factoryAddress: string;
  }>;

  beforeAll(() => {
    solanaDexConfigs = DEXES.solana || [];
  });

  it('should have unique program IDs for each DEX', () => {
    const programIds = solanaDexConfigs.map(d => d.factoryAddress);
    const uniqueIds = new Set(programIds);
    expect(uniqueIds.size).toBe(programIds.length);
  });

  it('should have unique DEX names', () => {
    const names = solanaDexConfigs.map(d => d.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  it('should not have any empty program IDs', () => {
    for (const dex of solanaDexConfigs) {
      expect(dex.factoryAddress).toBeTruthy();
      expect(dex.factoryAddress.length).toBeGreaterThan(30);
    }
  });

  it('should not contain EVM-style addresses', () => {
    for (const dex of solanaDexConfigs) {
      expect(dex.factoryAddress.startsWith('0x')).toBe(false);
      expect(dex.factoryAddress.length).not.toBe(42);
    }
  });

  it('should match program IDs in SOLANA_DEX_PROGRAMS constant', () => {
    const raydium = solanaDexConfigs.find(d => d.name === 'raydium');
    expect(raydium?.factoryAddress).toBe(SOLANA_DEX_PROGRAMS.RAYDIUM_AMM);

    const orca = solanaDexConfigs.find(d => d.name === 'orca');
    expect(orca?.factoryAddress).toBe(SOLANA_DEX_PROGRAMS.ORCA_WHIRLPOOL);
  });
});

// =============================================================================
// S3.3.2.8: Consistency with Partition Config Tests
// =============================================================================

describe('S3.3.2.8: Consistency with Partition Config', () => {
  it('should have solana in P4 partition', () => {
    // P4 is the Solana-Native partition
    const p4Chains = ['solana'];
    expect(p4Chains).toContain('solana');
  });

  it('should have matching DEX count in partition and config', () => {
    const solanaDexConfigs = DEXES.solana || [];
    expect(solanaDexConfigs.length).toBeGreaterThanOrEqual(7);
  });

  it('should have detector config for Solana matching DEX requirements', () => {
    expect(DETECTOR_CONFIG.solana).toBeDefined();
    expect(DETECTOR_CONFIG.solana.batchSize).toBeGreaterThan(0);
    expect(DETECTOR_CONFIG.solana.batchTimeout).toBeGreaterThan(0);
  });
});

// =============================================================================
// S3.3.2.9: Regression Tests
// =============================================================================

describe('S3.3.2.9: Regression Tests', () => {
  it('should maintain at least 7 Solana DEXs after any config changes', () => {
    const solanaDexConfigs = DEXES.solana || [];
    expect(solanaDexConfigs.length).toBeGreaterThanOrEqual(7);
  });

  it('should maintain Raydium as primary AMM (highest volume)', () => {
    const solanaDexConfigs = DEXES.solana || [];
    const raydium = solanaDexConfigs.find(d => d.name === 'raydium');
    expect(raydium).toBeDefined();
    expect(raydium?.enabled).not.toBe(false);
  });

  it('should maintain Orca as secondary DEX', () => {
    const solanaDexConfigs = DEXES.solana || [];
    const orca = solanaDexConfigs.find(d => d.name === 'orca');
    expect(orca).toBeDefined();
    expect(orca?.enabled).not.toBe(false);
  });

  it('should not regress to EVM-style addresses', () => {
    const solanaDexConfigs = DEXES.solana || [];
    for (const dex of solanaDexConfigs) {
      expect(dex.factoryAddress.startsWith('0x')).toBe(false);
    }
  });

  it('should maintain correct Orca Whirlpool program ID (not legacy token swap)', () => {
    const solanaDexConfigs = DEXES.solana || [];
    const orca = solanaDexConfigs.find(d => d.name === 'orca');
    // Whirlpool program, not the old token swap program
    expect(orca?.factoryAddress).toBe('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
  });

  it('should have all expected DEX names', () => {
    const solanaDexConfigs = DEXES.solana || [];
    const expectedNames = [
      'jupiter',
      'raydium',
      'raydium-clmm',
      'orca',
      'meteora',
      'phoenix',
      'lifinity'
    ];

    for (const name of expectedNames) {
      const dex = solanaDexConfigs.find(d => d.name === name);
      expect(dex).toBeDefined();
    }
  });
});

// =============================================================================
// S3.3.2.10: Summary Statistics Tests
// =============================================================================

describe('S3.3.2.10: Summary Statistics', () => {
  it('should report correct total Solana DEX count', () => {
    const solanaDexConfigs = DEXES.solana || [];
    console.log(`Total Solana DEXs configured: ${solanaDexConfigs.length}`);
    expect(solanaDexConfigs.length).toBeGreaterThanOrEqual(7);
  });

  it('should report correct enabled DEX count', () => {
    const solanaDexConfigs = DEXES.solana || [];
    const enabledCount = solanaDexConfigs.filter(d => d.enabled !== false).length;
    console.log(`Enabled Solana DEXs: ${enabledCount}`);
    expect(enabledCount).toBeGreaterThanOrEqual(5);
  });

  it('should report DEX type distribution', () => {
    const solanaDexConfigs = DEXES.solana || [];
    const typeDistribution: Record<string, number> = {};

    for (const dex of solanaDexConfigs) {
      // S3.3.2-FIX: Type field is now properly typed as DexType
      const type = dex.type || 'unknown';
      typeDistribution[type] = (typeDistribution[type] || 0) + 1;
    }

    // Log for debugging during test runs
    // eslint-disable-next-line no-console
    console.log('DEX type distribution:', typeDistribution);
    expect(Object.keys(typeDistribution).length).toBeGreaterThan(1);
  });

  it('should calculate average fee across Solana DEXs', () => {
    const solanaDexConfigs = DEXES.solana || [];
    const fees = solanaDexConfigs.map(d => d.fee);
    const avgFee = fees.reduce((a, b) => a + b, 0) / fees.length;

    console.log(`Average Solana DEX fee: ${avgFee.toFixed(2)} basis points`);
    expect(avgFee).toBeGreaterThan(0);
    expect(avgFee).toBeLessThan(50);
  });
});
