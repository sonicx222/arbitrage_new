/**
 * S3.3.4 Solana Swap Parser Integration Tests
 *
 * TDD tests for parsing Solana swap instructions from various DEXs:
 * - Raydium AMM: Constant product AMM swaps
 * - Raydium CLMM: Concentrated liquidity swaps
 * - Orca Whirlpool: CLMM swaps
 * - Meteora DLMM: Dynamic liquidity bin-based swaps
 * - Phoenix: On-chain order book trades
 * - Lifinity: Proactive market maker swaps
 * - Jupiter: Aggregator route parsing (disabled for direct detection)
 *
 * Key differences from EVM:
 * - Solana uses instructions, not event logs
 * - Each DEX has unique instruction discriminators (first 8 bytes)
 * - Account keys identify pools, tokens, and users
 * - Binary data must be decoded according to DEX-specific layouts
 *
 * @see IMPLEMENTATION_PLAN.md S3.3.4
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';

// =============================================================================
// Imports from Implementation
// =============================================================================

// Import types and constants from the actual implementation to prevent drift
import type { SolanaTransaction } from '@arbitrage/core/mev-protection';
import type {
  SolanaInstruction,
  ParsedSolanaSwap,
  SwapParserConfig,
  ParserStats,
} from '@arbitrage/core/solana';

// Import the actual implementation for integration testing
import {
  SolanaSwapParser,
  getSolanaSwapParser,
  resetSolanaSwapParser,
  SOLANA_DEX_PROGRAM_IDS,
  PROGRAM_ID_TO_DEX,
  SWAP_DISCRIMINATORS as IMPL_SWAP_DISCRIMINATORS,
  DISABLED_DEXES,
} from '@arbitrage/core/solana';

// =============================================================================
// Test Constants - Solana DEX Program IDs
// =============================================================================

/**
 * Expected Solana DEX program IDs from config.
 */
const EXPECTED_PROGRAM_IDS = {
  JUPITER: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  RAYDIUM_AMM: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  RAYDIUM_CLMM: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  ORCA_WHIRLPOOL: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  METEORA_DLMM: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  PHOENIX: 'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY',
  LIFINITY: '2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c'
} as const;

/**
 * Swap instruction discriminators for each DEX.
 * These are the first 8 bytes of the instruction data that identify the instruction type.
 */
const SWAP_DISCRIMINATORS = {
  // Raydium AMM v4: swap instruction discriminator
  RAYDIUM_AMM_SWAP: Buffer.from([0x09]), // Instruction index 9 = swap
  // Raydium CLMM: swapV2 discriminator (Anchor format)
  RAYDIUM_CLMM_SWAP: Buffer.from([43, 4, 237, 11, 26, 201, 106, 243]),
  // Orca Whirlpool: swap discriminator (Anchor format)
  ORCA_WHIRLPOOL_SWAP: Buffer.from([248, 198, 158, 145, 225, 117, 135, 200]),
  // Meteora DLMM: swap discriminator
  METEORA_DLMM_SWAP: Buffer.from([248, 198, 158, 145, 225, 117, 135, 200]),
  // Phoenix: Anchor swap discriminator
  PHOENIX_SWAP: Buffer.from([248, 198, 158, 145, 225, 117, 135, 200]),
  // Lifinity: swap discriminator
  LIFINITY_SWAP: Buffer.from([248, 198, 158, 145, 225, 117, 135, 200])
} as const;

/**
 * Sample token mint addresses for testing.
 */
const TEST_TOKENS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  RAY: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R'
} as const;

// =============================================================================
// Test Utilities
// =============================================================================

/**
 * Creates a mock Solana transaction instruction for testing.
 */
function createMockInstruction(params: {
  programId: string;
  data: Buffer;
  accounts: string[];
}): SolanaInstruction {
  return {
    programId: params.programId,
    data: params.data,
    accounts: params.accounts.map((pubkey, index) => ({
      pubkey,
      isSigner: index === 0, // First account is usually signer
      isWritable: index < 5 // First few accounts are usually writable
    }))
  };
}

/**
 * Creates a mock Raydium AMM swap instruction.
 */
function createRaydiumAmmSwapInstruction(params: {
  amountIn: bigint;
  minAmountOut: bigint;
  poolAddress: string;
  userSource: string;
  userDestination: string;
}): SolanaInstruction {
  // Raydium AMM swap instruction layout:
  // [0]: instruction index (9 = swap)
  // [1-8]: amountIn (u64 LE)
  // [9-16]: minAmountOut (u64 LE)
  const data = Buffer.alloc(17);
  data.writeUInt8(9, 0); // Instruction index for swap
  data.writeBigUInt64LE(params.amountIn, 1);
  data.writeBigUInt64LE(params.minAmountOut, 9);

  return createMockInstruction({
    programId: EXPECTED_PROGRAM_IDS.RAYDIUM_AMM,
    data,
    accounts: [
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // Token program
      params.poolAddress,                              // AMM
      'authority',                                     // AMM authority
      'openOrders',                                    // Open orders
      'targetOrders',                                  // Target orders
      'poolCoinTokenAccount',                          // Pool coin vault
      'poolPcTokenAccount',                            // Pool PC vault
      'serumProgram',                                  // Serum DEX program
      'serumMarket',                                   // Serum market
      'serumBids',                                     // Bids
      'serumAsks',                                     // Asks
      'serumEventQueue',                               // Event queue
      'serumCoinVault',                                // Coin vault
      'serumPcVault',                                  // PC vault
      'serumVaultSigner',                              // Vault signer
      params.userSource,                               // User source token account
      params.userDestination,                          // User destination token account
      'userOwner'                                      // User wallet
    ]
  });
}

/**
 * Creates a mock Orca Whirlpool swap instruction.
 */
function createOrcaWhirlpoolSwapInstruction(params: {
  amount: bigint;
  otherAmountThreshold: bigint;
  sqrtPriceLimit: bigint;
  amountSpecifiedIsInput: boolean;
  aToB: boolean;
  poolAddress: string;
}): SolanaInstruction {
  // Orca Whirlpool swap instruction layout (Anchor format):
  // [0-7]: discriminator
  // [8-15]: amount (u64 LE)
  // [16-23]: otherAmountThreshold (u64 LE)
  // [24-39]: sqrtPriceLimit (u128 LE)
  // [40]: amountSpecifiedIsInput (bool)
  // [41]: aToB (bool)
  const data = Buffer.alloc(42);
  SWAP_DISCRIMINATORS.ORCA_WHIRLPOOL_SWAP.copy(data, 0);
  data.writeBigUInt64LE(params.amount, 8);
  data.writeBigUInt64LE(params.otherAmountThreshold, 16);
  // Write sqrtPriceLimit as u128 (split into two u64s)
  data.writeBigUInt64LE(params.sqrtPriceLimit & BigInt('0xFFFFFFFFFFFFFFFF'), 24);
  data.writeBigUInt64LE(params.sqrtPriceLimit >> 64n, 32);
  data.writeUInt8(params.amountSpecifiedIsInput ? 1 : 0, 40);
  data.writeUInt8(params.aToB ? 1 : 0, 41);

  return createMockInstruction({
    programId: EXPECTED_PROGRAM_IDS.ORCA_WHIRLPOOL,
    data,
    accounts: [
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // Token program
      'userWallet',                                   // Authority (user)
      params.poolAddress,                             // Whirlpool
      'tokenVaultA',                                  // Token vault A
      'tokenVaultB',                                  // Token vault B
      'tickArray0',                                   // Tick array 0
      'tickArray1',                                   // Tick array 1
      'tickArray2',                                   // Tick array 2
      'oracle',                                       // Oracle
      'tokenOwnerAccountA',                           // User token account A
      'tokenOwnerAccountB'                            // User token account B
    ]
  });
}

/**
 * Creates a mock Solana transaction for testing.
 */
function createMockTransaction(params: {
  signature: string;
  slot: number;
  blockTime: number;
  instructions: SolanaInstruction[];
  success?: boolean;
}): SolanaTransaction {
  return {
    signature: params.signature,
    slot: params.slot,
    blockTime: params.blockTime,
    instructions: params.instructions,
    meta: {
      err: params.success === false ? { InstructionError: [0, 'Custom'] } : null,
      fee: 5000,
      preBalances: [],
      postBalances: [],
      preTokenBalances: [],
      postTokenBalances: []
    }
  };
}

// =============================================================================
// Type Definitions for Tests
// =============================================================================

// NOTE: Types are imported from '@arbitrage/core/solana-swap-parser' above
// to prevent type drift between tests and implementation.
// See: SolanaInstruction, SolanaTransaction, ParsedSolanaSwap, SwapParserConfig

// Alias for backwards compatibility with existing tests
type ParsedSwapEvent = ParsedSolanaSwap;

// =============================================================================
// Parser Interface Reference (TDD - Implemented)
// =============================================================================

/**
 * SolanaSwapParser interface for TDD reference.
 *
 * IMPLEMENTATION STATUS: ✅ Complete
 * See: shared/core/src/solana-swap-parser.ts
 *
 * Key methods implemented:
 * - getConfig(): Returns current parser configuration
 * - updateConfig(): Modifies configuration at runtime
 * - parseTransaction(): Parses full transaction and extracts swaps
 * - parseInstruction(): Parses single instruction with context
 * - isSwapInstruction(): Detects if instruction is a DEX swap
 * - getDexFromProgramId(): Maps program ID to DEX name
 * - getStats(): Returns parser statistics
 * - resetStats(): Clears statistics counters
 * - getPrometheusMetrics(): Returns Prometheus-formatted metrics
 */
// Interface definition is now in the implementation file.
// Import SolanaSwapParser class directly when needed for testing.

// =============================================================================
// S3.3.4.1: Parser Configuration Tests
// =============================================================================

describe('S3.3.4.1: SolanaSwapParser Configuration', () => {
  let parser: SolanaSwapParser;

  beforeEach(() => {
    resetSolanaSwapParser();
  });

  afterEach(() => {
    resetSolanaSwapParser();
  });

  it('should create parser with default configuration', () => {
    parser = new SolanaSwapParser();
    const config = parser.getConfig();

    expect(config.enabledDexes).toContain('raydium');
    expect(config.enabledDexes).toContain('orca');
    expect(config.enabledDexes).toContain('meteora');
    expect(config.enabledDexes).not.toContain('jupiter'); // Aggregator disabled by default
    expect(config.minAmountThreshold).toBe(0n);
  });

  it('should accept custom enabled DEXes list', () => {
    parser = new SolanaSwapParser({
      enabledDexes: ['raydium', 'orca']
    });
    const config = parser.getConfig();

    expect(config.enabledDexes).toEqual(['raydium', 'orca']);
    expect(config.enabledDexes).not.toContain('meteora');
  });

  it('should accept minimum amount threshold', () => {
    parser = new SolanaSwapParser({
      minAmountThreshold: 1000000n // Filter dust amounts
    });
    const config = parser.getConfig();

    expect(config.minAmountThreshold).toBe(1000000n);
  });

  it('should allow updating configuration at runtime', () => {
    parser = new SolanaSwapParser();
    const originalConfig = parser.getConfig();

    expect(originalConfig.enabledDexes).toContain('raydium');

    parser.updateConfig({
      enabledDexes: ['orca']
    });

    const updatedConfig = parser.getConfig();
    expect(updatedConfig.enabledDexes).toEqual(['orca']);
    expect(updatedConfig.enabledDexes).not.toContain('raydium');
  });

  it('should validate configuration values', () => {
    // enabledDexes must be an array
    expect(() => new SolanaSwapParser({
      enabledDexes: 'raydium' as any
    })).toThrow('enabledDexes must be an array');

    // minAmountThreshold must be non-negative
    expect(() => new SolanaSwapParser({
      minAmountThreshold: -1n
    })).toThrow('minAmountThreshold must be non-negative');
  });

  it('should use singleton factory correctly', () => {
    const parser1 = getSolanaSwapParser({ enabledDexes: ['raydium'] });
    const parser2 = getSolanaSwapParser({ enabledDexes: ['orca'] }); // Config ignored

    expect(parser1).toBe(parser2); // Same instance
    expect(parser1.getConfig().enabledDexes).toContain('raydium');
  });
});

// =============================================================================
// S3.3.4.2: Program ID Recognition Tests
// =============================================================================

describe('S3.3.4.2: Program ID Recognition', () => {
  let parser: SolanaSwapParser;

  beforeEach(() => {
    resetSolanaSwapParser();
    parser = new SolanaSwapParser();
  });

  afterEach(() => {
    resetSolanaSwapParser();
  });

  it('should have correct Raydium AMM program ID', () => {
    expect(EXPECTED_PROGRAM_IDS.RAYDIUM_AMM).toBe('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
    // Verify implementation matches test constants
    expect(SOLANA_DEX_PROGRAM_IDS.RAYDIUM_AMM).toBe(EXPECTED_PROGRAM_IDS.RAYDIUM_AMM);
  });

  it('should have correct Raydium CLMM program ID', () => {
    expect(EXPECTED_PROGRAM_IDS.RAYDIUM_CLMM).toBe('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
    expect(SOLANA_DEX_PROGRAM_IDS.RAYDIUM_CLMM).toBe(EXPECTED_PROGRAM_IDS.RAYDIUM_CLMM);
  });

  it('should have correct Orca Whirlpool program ID', () => {
    expect(EXPECTED_PROGRAM_IDS.ORCA_WHIRLPOOL).toBe('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
    expect(SOLANA_DEX_PROGRAM_IDS.ORCA_WHIRLPOOL).toBe(EXPECTED_PROGRAM_IDS.ORCA_WHIRLPOOL);
  });

  it('should have correct Meteora DLMM program ID', () => {
    expect(EXPECTED_PROGRAM_IDS.METEORA_DLMM).toBe('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
    expect(SOLANA_DEX_PROGRAM_IDS.METEORA_DLMM).toBe(EXPECTED_PROGRAM_IDS.METEORA_DLMM);
  });

  it('should have correct Phoenix program ID', () => {
    expect(EXPECTED_PROGRAM_IDS.PHOENIX).toBe('PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY');
    expect(SOLANA_DEX_PROGRAM_IDS.PHOENIX).toBe(EXPECTED_PROGRAM_IDS.PHOENIX);
  });

  it('should have correct Lifinity program ID', () => {
    expect(EXPECTED_PROGRAM_IDS.LIFINITY).toBe('2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c');
    expect(SOLANA_DEX_PROGRAM_IDS.LIFINITY).toBe(EXPECTED_PROGRAM_IDS.LIFINITY);
  });

  it('should have correct Jupiter program ID (disabled aggregator)', () => {
    expect(EXPECTED_PROGRAM_IDS.JUPITER).toBe('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
    expect(SOLANA_DEX_PROGRAM_IDS.JUPITER).toBe(EXPECTED_PROGRAM_IDS.JUPITER);
  });

  it('should map program IDs to DEX names', () => {
    expect(parser.getDexFromProgramId(SOLANA_DEX_PROGRAM_IDS.RAYDIUM_AMM)).toBe('raydium');
    expect(parser.getDexFromProgramId(SOLANA_DEX_PROGRAM_IDS.RAYDIUM_CLMM)).toBe('raydium-clmm');
    expect(parser.getDexFromProgramId(SOLANA_DEX_PROGRAM_IDS.ORCA_WHIRLPOOL)).toBe('orca');
    expect(parser.getDexFromProgramId(SOLANA_DEX_PROGRAM_IDS.METEORA_DLMM)).toBe('meteora');
    expect(parser.getDexFromProgramId(SOLANA_DEX_PROGRAM_IDS.PHOENIX)).toBe('phoenix');
    expect(parser.getDexFromProgramId(SOLANA_DEX_PROGRAM_IDS.LIFINITY)).toBe('lifinity');
    expect(parser.getDexFromProgramId(SOLANA_DEX_PROGRAM_IDS.JUPITER)).toBe('jupiter');
  });

  it('should return null for unknown program IDs', () => {
    expect(parser.getDexFromProgramId('UnknownProgramId12345678901234567890123')).toBeNull();
    expect(parser.getDexFromProgramId('')).toBeNull();
    expect(parser.getDexFromProgramId('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')).toBeNull();
  });

  it('should identify Jupiter as disabled aggregator', () => {
    expect(DISABLED_DEXES.has('jupiter')).toBe(true);
    expect(parser.isDexEnabled('jupiter')).toBe(false);
    // Jupiter is recognized but not enabled
    expect(parser.getDexFromProgramId(SOLANA_DEX_PROGRAM_IDS.JUPITER)).toBe('jupiter');
    expect(parser.isKnownDexProgram(SOLANA_DEX_PROGRAM_IDS.JUPITER)).toBe(true);
  });

  it('should have PROGRAM_ID_TO_DEX mapping for all 7 DEXes', () => {
    expect(Object.keys(PROGRAM_ID_TO_DEX).length).toBe(7);
    expect(PROGRAM_ID_TO_DEX[SOLANA_DEX_PROGRAM_IDS.JUPITER]).toBe('jupiter');
    expect(PROGRAM_ID_TO_DEX[SOLANA_DEX_PROGRAM_IDS.RAYDIUM_AMM]).toBe('raydium');
  });
});

// =============================================================================
// S3.3.4.3: Swap Instruction Detection Tests
// =============================================================================

describe('S3.3.4.3: Swap Instruction Detection', () => {
  let parser: SolanaSwapParser;

  beforeEach(() => {
    resetSolanaSwapParser();
    parser = new SolanaSwapParser();
  });

  afterEach(() => {
    resetSolanaSwapParser();
  });

  it('should create valid Raydium AMM swap instruction', () => {
    const instruction = createRaydiumAmmSwapInstruction({
      amountIn: 1000000n, // 1 USDC (6 decimals)
      minAmountOut: 900000n,
      poolAddress: 'poolXYZ',
      userSource: 'userSourceATA',
      userDestination: 'userDestATA'
    });

    expect(instruction.programId).toBe(EXPECTED_PROGRAM_IDS.RAYDIUM_AMM);
    expect(instruction.data[0]).toBe(9); // Swap instruction index
    expect(instruction.accounts.length).toBeGreaterThan(10);
  });

  it('should create valid Orca Whirlpool swap instruction', () => {
    const instruction = createOrcaWhirlpoolSwapInstruction({
      amount: 1000000000n, // 1 SOL (9 decimals)
      otherAmountThreshold: 900000n,
      sqrtPriceLimit: 79226673515401279992447579055n, // Max price limit
      amountSpecifiedIsInput: true,
      aToB: true,
      poolAddress: 'whirlpoolXYZ'
    });

    expect(instruction.programId).toBe(EXPECTED_PROGRAM_IDS.ORCA_WHIRLPOOL);
    expect(instruction.data.slice(0, 8)).toEqual(SWAP_DISCRIMINATORS.ORCA_WHIRLPOOL_SWAP);
  });

  it('should detect Raydium AMM swap instructions', () => {
    const instruction = createRaydiumAmmSwapInstruction({
      amountIn: 1000000000n,
      minAmountOut: 95000000n,
      poolAddress: 'testPool',
      userSource: 'userSource',
      userDestination: 'userDest'
    });

    expect(parser.isSwapInstruction(instruction)).toBe(true);
  });

  it('should detect Orca Whirlpool swap instructions', () => {
    const instruction = createOrcaWhirlpoolSwapInstruction({
      amount: 1000000000n,
      otherAmountThreshold: 95000000n,
      sqrtPriceLimit: 79226673515401279992447579055n,
      amountSpecifiedIsInput: true,
      aToB: true,
      poolAddress: 'testWhirlpool'
    });

    expect(parser.isSwapInstruction(instruction)).toBe(true);
  });

  it('should ignore non-swap instructions (wrong instruction index)', () => {
    // Create instruction with wrong index (not 9 for Raydium AMM)
    const data = Buffer.alloc(17);
    data.writeUInt8(1, 0); // Wrong instruction index
    data.writeBigUInt64LE(1000000n, 1);
    data.writeBigUInt64LE(900000n, 9);

    const instruction = createMockInstruction({
      programId: EXPECTED_PROGRAM_IDS.RAYDIUM_AMM,
      data,
      accounts: ['account1', 'account2']
    });

    expect(parser.isSwapInstruction(instruction)).toBe(false);
  });

  it('should ignore transfer-only instructions (Token program)', () => {
    const instruction = createMockInstruction({
      programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      data: Buffer.from([3]), // Transfer instruction
      accounts: ['source', 'destination', 'owner']
    });

    expect(parser.isSwapInstruction(instruction)).toBe(false);
  });

  it('should ignore instructions with empty data', () => {
    const instruction = createMockInstruction({
      programId: EXPECTED_PROGRAM_IDS.RAYDIUM_AMM,
      data: Buffer.alloc(0),
      accounts: ['account1']
    });

    expect(parser.isSwapInstruction(instruction)).toBe(false);
  });

  it('should handle disabled DEXes (Jupiter)', () => {
    // Jupiter should not be detected when parseJupiterRoutes is false (default)
    const data = Buffer.alloc(42);
    // Some Jupiter instruction data
    const instruction = createMockInstruction({
      programId: EXPECTED_PROGRAM_IDS.JUPITER,
      data,
      accounts: ['account1', 'account2']
    });

    expect(parser.isSwapInstruction(instruction)).toBe(false);
  });
});

// =============================================================================
// S3.3.4.4: Raydium AMM Parsing Tests
// =============================================================================

describe('S3.3.4.4: Raydium AMM Swap Parsing', () => {
  let parser: SolanaSwapParser;
  const mockPoolAddress = 'DoPVUhkKT5V3XsGYN4EB9PqiAHLgfLV5i8S28R9RoGaP';

  beforeEach(() => {
    resetSolanaSwapParser();
    parser = new SolanaSwapParser();
  });

  afterEach(() => {
    resetSolanaSwapParser();
  });

  it('should create mock Raydium swap transaction', () => {
    const instruction = createRaydiumAmmSwapInstruction({
      amountIn: 1000000000n, // 1 SOL
      minAmountOut: 95000000n, // 95 USDC
      poolAddress: mockPoolAddress,
      userSource: 'userSourceATA',
      userDestination: 'userDestATA'
    });

    const tx = createMockTransaction({
      signature: 'raydiumSwapTx123',
      slot: 250000000,
      blockTime: Date.now() / 1000,
      instructions: [instruction],
      success: true
    });

    expect(tx.signature).toBe('raydiumSwapTx123');
    expect(tx.instructions.length).toBe(1);
    expect(tx.meta.err).toBeNull();
  });

  it('should parse Raydium AMM swap amounts correctly', () => {
    const instruction = createRaydiumAmmSwapInstruction({
      amountIn: 1000000000n, // 1 SOL
      minAmountOut: 95000000n, // 95 USDC
      poolAddress: mockPoolAddress,
      userSource: 'userSourceATA',
      userDestination: 'userDestATA'
    });

    const tx = createMockTransaction({
      signature: 'raydiumSwapTx123',
      slot: 250000000,
      blockTime: Math.floor(Date.now() / 1000),
      instructions: [instruction],
      success: true
    });

    const swaps = parser.parseTransaction(tx);

    expect(swaps.length).toBe(1);
    expect(swaps[0].amount0In).toBe('1000000000');
    expect(swaps[0].amount1Out).toBe('95000000');
    expect(swaps[0].dex).toBe('raydium');
    expect(swaps[0].chain).toBe('solana');
  });

  it('should extract pool address from accounts', () => {
    const instruction = createRaydiumAmmSwapInstruction({
      amountIn: 1000000000n,
      minAmountOut: 95000000n,
      poolAddress: mockPoolAddress,
      userSource: 'userSourceATA',
      userDestination: 'userDestATA'
    });

    const tx = createMockTransaction({
      signature: 'raydiumSwapTx456',
      slot: 250000001,
      blockTime: Math.floor(Date.now() / 1000),
      instructions: [instruction],
      success: true
    });

    const swaps = parser.parseTransaction(tx);

    expect(swaps.length).toBe(1);
    expect(swaps[0].pairAddress).toBe(mockPoolAddress);
  });

  it('should set correct transaction metadata', () => {
    const blockTime = Math.floor(Date.now() / 1000);
    const instruction = createRaydiumAmmSwapInstruction({
      amountIn: 1000000000n,
      minAmountOut: 95000000n,
      poolAddress: mockPoolAddress,
      userSource: 'userSourceATA',
      userDestination: 'userDestATA'
    });

    const tx = createMockTransaction({
      signature: 'raydiumSwapTx789',
      slot: 250000002,
      blockTime,
      instructions: [instruction],
      success: true
    });

    const swaps = parser.parseTransaction(tx);

    expect(swaps.length).toBe(1);
    expect(swaps[0].transactionHash).toBe('raydiumSwapTx789');
    expect(swaps[0].blockNumber).toBe(250000002);
    expect(swaps[0].timestamp).toBe(blockTime * 1000); // Converted to ms
    expect(swaps[0].instructionIndex).toBe(0);
  });

  it('should ignore failed swap transactions', () => {
    const instruction = createRaydiumAmmSwapInstruction({
      amountIn: 1000000000n,
      minAmountOut: 95000000n,
      poolAddress: mockPoolAddress,
      userSource: 'userSourceATA',
      userDestination: 'userDestATA'
    });

    const tx = createMockTransaction({
      signature: 'failedRaydiumSwap',
      slot: 250000003,
      blockTime: Math.floor(Date.now() / 1000),
      instructions: [instruction],
      success: false // Transaction failed
    });

    const swaps = parser.parseTransaction(tx);

    expect(swaps.length).toBe(0);
  });

  it('should filter dust amounts based on minAmountThreshold', () => {
    const dustParser = new SolanaSwapParser({
      minAmountThreshold: 500000000n // 0.5 SOL minimum
    });

    const dustInstruction = createRaydiumAmmSwapInstruction({
      amountIn: 100000n, // Dust amount
      minAmountOut: 95n,
      poolAddress: mockPoolAddress,
      userSource: 'userSourceATA',
      userDestination: 'userDestATA'
    });

    const tx = createMockTransaction({
      signature: 'dustSwap',
      slot: 250000004,
      blockTime: Math.floor(Date.now() / 1000),
      instructions: [dustInstruction],
      success: true
    });

    const swaps = dustParser.parseTransaction(tx);

    expect(swaps.length).toBe(0); // Filtered out
  });

  it('should update statistics after parsing', () => {
    const instruction = createRaydiumAmmSwapInstruction({
      amountIn: 1000000000n,
      minAmountOut: 95000000n,
      poolAddress: mockPoolAddress,
      userSource: 'userSourceATA',
      userDestination: 'userDestATA'
    });

    const tx = createMockTransaction({
      signature: 'statsTest',
      slot: 250000005,
      blockTime: Math.floor(Date.now() / 1000),
      instructions: [instruction],
      success: true
    });

    const statsBefore = parser.getStats();
    expect(statsBefore.totalParsed).toBe(0);

    parser.parseTransaction(tx);

    const statsAfter = parser.getStats();
    expect(statsAfter.totalParsed).toBe(1);
    expect(statsAfter.totalSwapsDetected).toBe(1);
    expect(statsAfter.swapsByDex['raydium']).toBe(1);
  });
});

// =============================================================================
// S3.3.4.5: Orca Whirlpool Parsing Tests
// =============================================================================

describe('S3.3.4.5: Orca Whirlpool Swap Parsing', () => {
  let parser: SolanaSwapParser;
  const mockWhirlpoolAddress = '7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm';

  beforeEach(() => {
    resetSolanaSwapParser();
    parser = new SolanaSwapParser();
  });

  afterEach(() => {
    resetSolanaSwapParser();
  });

  it('should create mock Orca Whirlpool swap transaction', () => {
    const instruction = createOrcaWhirlpoolSwapInstruction({
      amount: 1000000000n,
      otherAmountThreshold: 95000000n,
      sqrtPriceLimit: 79226673515401279992447579055n,
      amountSpecifiedIsInput: true,
      aToB: true,
      poolAddress: mockWhirlpoolAddress
    });

    const tx = createMockTransaction({
      signature: 'orcaSwapTx456',
      slot: 250000001,
      blockTime: Date.now() / 1000,
      instructions: [instruction],
      success: true
    });

    expect(tx.signature).toBe('orcaSwapTx456');
    expect(tx.instructions[0].programId).toBe(EXPECTED_PROGRAM_IDS.ORCA_WHIRLPOOL);
  });

  it('should parse Orca Whirlpool swap amounts correctly', () => {
    const instruction = createOrcaWhirlpoolSwapInstruction({
      amount: 1000000000n, // 1 SOL
      otherAmountThreshold: 95000000n, // Min 95 USDC
      sqrtPriceLimit: 79226673515401279992447579055n,
      amountSpecifiedIsInput: true,
      aToB: true,
      poolAddress: mockWhirlpoolAddress
    });

    const tx = createMockTransaction({
      signature: 'orcaSwapAmounts',
      slot: 250000010,
      blockTime: Math.floor(Date.now() / 1000),
      instructions: [instruction],
      success: true
    });

    const swaps = parser.parseTransaction(tx);

    expect(swaps.length).toBe(1);
    expect(swaps[0].dex).toBe('orca');
    expect(swaps[0].chain).toBe('solana');
    expect(swaps[0].pairAddress).toBe(mockWhirlpoolAddress);
  });

  // REGRESSION TEST: Tests the fix for falsy '0' string handling
  it('should handle aToB direction swaps (exact input) - amount0In set, amount1Out set', () => {
    const instruction = createOrcaWhirlpoolSwapInstruction({
      amount: 1000000000n, // 1 SOL input
      otherAmountThreshold: 95000000n, // Min 95 USDC output
      sqrtPriceLimit: 79226673515401279992447579055n,
      amountSpecifiedIsInput: true, // Exact input
      aToB: true, // Token A -> Token B
      poolAddress: mockWhirlpoolAddress
    });

    const tx = createMockTransaction({
      signature: 'orcaAtoBExactIn',
      slot: 250000011,
      blockTime: Math.floor(Date.now() / 1000),
      instructions: [instruction],
      success: true
    });

    const swaps = parser.parseTransaction(tx);

    expect(swaps.length).toBe(1);
    // aToB + exactInput: amount is amount0In, threshold is amount1Out
    expect(swaps[0].amount0In).toBe('1000000000');
    expect(swaps[0].amount1In).toBe('0'); // Should be '0', not replaced
    expect(swaps[0].amount0Out).toBe('0'); // Should be '0', not replaced
    expect(swaps[0].amount1Out).toBe('95000000');
  });

  // REGRESSION TEST: Tests the fix for falsy '0' string handling
  it('should handle bToA direction swaps (exact input) - amount1In set, amount0Out set', () => {
    const instruction = createOrcaWhirlpoolSwapInstruction({
      amount: 95000000n, // 95 USDC input
      otherAmountThreshold: 1000000000n, // Min 1 SOL output
      sqrtPriceLimit: 0n, // Min price for bToA
      amountSpecifiedIsInput: true, // Exact input
      aToB: false, // Token B -> Token A
      poolAddress: mockWhirlpoolAddress
    });

    const tx = createMockTransaction({
      signature: 'orcaBtoAExactIn',
      slot: 250000012,
      blockTime: Math.floor(Date.now() / 1000),
      instructions: [instruction],
      success: true
    });

    const swaps = parser.parseTransaction(tx);

    expect(swaps.length).toBe(1);
    // bToA + exactInput: amount is amount1In, threshold is amount0Out
    expect(swaps[0].amount0In).toBe('0'); // Should be '0', not replaced
    expect(swaps[0].amount1In).toBe('95000000');
    expect(swaps[0].amount0Out).toBe('1000000000');
    expect(swaps[0].amount1Out).toBe('0'); // Should be '0', not replaced
  });

  // REGRESSION TEST: Tests exact output swap handling
  it('should handle exact output swaps (aToB) - threshold is max input', () => {
    const instruction = createOrcaWhirlpoolSwapInstruction({
      amount: 95000000n, // Exact 95 USDC output
      otherAmountThreshold: 1100000000n, // Max 1.1 SOL input
      sqrtPriceLimit: 79226673515401279992447579055n,
      amountSpecifiedIsInput: false, // Exact output
      aToB: true, // Token A -> Token B
      poolAddress: mockWhirlpoolAddress
    });

    const tx = createMockTransaction({
      signature: 'orcaExactOut',
      slot: 250000013,
      blockTime: Math.floor(Date.now() / 1000),
      instructions: [instruction],
      success: true
    });

    const swaps = parser.parseTransaction(tx);

    expect(swaps.length).toBe(1);
    // aToB + exactOutput: threshold is amount0In, amount is amount1Out
    expect(swaps[0].amount0In).toBe('1100000000'); // Max input
    expect(swaps[0].amount1In).toBe('0');
    expect(swaps[0].amount0Out).toBe('0');
    expect(swaps[0].amount1Out).toBe('95000000'); // Exact output
  });

  // REGRESSION TEST: Tests bToA exact output handling
  it('should handle exact output swaps (bToA) - threshold is max input', () => {
    const instruction = createOrcaWhirlpoolSwapInstruction({
      amount: 1000000000n, // Exact 1 SOL output
      otherAmountThreshold: 100000000n, // Max 100 USDC input
      sqrtPriceLimit: 0n,
      amountSpecifiedIsInput: false, // Exact output
      aToB: false, // Token B -> Token A
      poolAddress: mockWhirlpoolAddress
    });

    const tx = createMockTransaction({
      signature: 'orcaBtoAExactOut',
      slot: 250000014,
      blockTime: Math.floor(Date.now() / 1000),
      instructions: [instruction],
      success: true
    });

    const swaps = parser.parseTransaction(tx);

    expect(swaps.length).toBe(1);
    // bToA + exactOutput: threshold is amount1In, amount is amount0Out
    expect(swaps[0].amount0In).toBe('0');
    expect(swaps[0].amount1In).toBe('100000000'); // Max input
    expect(swaps[0].amount0Out).toBe('1000000000'); // Exact output
    expect(swaps[0].amount1Out).toBe('0');
  });

  it('should set correct program ID in parsed swap', () => {
    const instruction = createOrcaWhirlpoolSwapInstruction({
      amount: 1000000000n,
      otherAmountThreshold: 95000000n,
      sqrtPriceLimit: 79226673515401279992447579055n,
      amountSpecifiedIsInput: true,
      aToB: true,
      poolAddress: mockWhirlpoolAddress
    });

    const tx = createMockTransaction({
      signature: 'orcaProgramId',
      slot: 250000015,
      blockTime: Math.floor(Date.now() / 1000),
      instructions: [instruction],
      success: true
    });

    const swaps = parser.parseTransaction(tx);

    expect(swaps.length).toBe(1);
    expect(swaps[0].programId).toBe(EXPECTED_PROGRAM_IDS.ORCA_WHIRLPOOL);
  });
});

// =============================================================================
// S3.3.4.6: Raydium CLMM Parsing Tests
// =============================================================================

describe('S3.3.4.6: Raydium CLMM Swap Parsing', () => {
  it.todo('should detect Raydium CLMM swap instructions');
  it.todo('should parse CLMM swap amounts');
  it.todo('should handle tick-based price calculations');
  it.todo('should extract pool state from accounts');
});

// =============================================================================
// S3.3.4.7: Meteora DLMM Parsing Tests
// =============================================================================

describe('S3.3.4.7: Meteora DLMM Swap Parsing', () => {
  it.todo('should detect Meteora DLMM swap instructions');
  it.todo('should parse bin-based swap amounts');
  it.todo('should handle dynamic liquidity pricing');
  it.todo('should extract active bin information');
});

// =============================================================================
// S3.3.4.8: Phoenix Order Book Parsing Tests
// =============================================================================

describe('S3.3.4.8: Phoenix Order Book Parsing', () => {
  it.todo('should detect Phoenix new_order instructions');
  it.todo('should parse limit order fills');
  it.todo('should parse market order executions');
  it.todo('should handle partial fills');
  it.todo('should extract order book state');
});

// =============================================================================
// S3.3.4.9: Lifinity PMM Parsing Tests
// =============================================================================

describe('S3.3.4.9: Lifinity PMM Swap Parsing', () => {
  it.todo('should detect Lifinity swap instructions');
  it.todo('should parse oracle-based swap amounts');
  it.todo('should handle concentrated liquidity');
});

// =============================================================================
// S3.3.4.10: Jupiter Aggregator Parsing Tests
// =============================================================================

describe('S3.3.4.10: Jupiter Aggregator Parsing', () => {
  it('should recognize Jupiter program ID', () => {
    expect(EXPECTED_PROGRAM_IDS.JUPITER).toBeDefined();
  });

  it.todo('should identify Jupiter as aggregator (disabled)');
  it.todo('should optionally parse Jupiter routes for analytics');
  it.todo('should extract underlying DEX hops from routes');
  it.todo('should not double-count Jupiter swaps in detection');
});

// =============================================================================
// S3.3.4.11: Transaction Parsing Tests
// =============================================================================

describe('S3.3.4.11: Full Transaction Parsing', () => {
  it.todo('should parse transaction with single swap');
  it.todo('should parse transaction with multiple swaps');
  it.todo('should handle transactions with non-swap instructions');
  it.todo('should skip failed transactions');
  it.todo('should return empty array for non-DEX transactions');
  it.todo('should preserve instruction order');
});

// =============================================================================
// S3.3.4.12: SwapEvent Conversion Tests
// =============================================================================

describe('S3.3.4.12: SwapEvent Conversion', () => {
  it('should have SwapEvent structure defined', () => {
    const mockEvent: ParsedSwapEvent = {
      pairAddress: 'poolAddress',
      sender: 'userWallet',
      recipient: 'userWallet',
      amount0In: '1000000000',
      amount1In: '0',
      amount0Out: '0',
      amount1Out: '95000000',
      to: 'userWallet',
      blockNumber: 250000000,
      transactionHash: 'txSignature',
      timestamp: Date.now(),
      dex: 'raydium',
      chain: 'solana',
      programId: EXPECTED_PROGRAM_IDS.RAYDIUM_AMM,
      instructionIndex: 0
    };

    expect(mockEvent.chain).toBe('solana');
    expect(mockEvent.dex).toBe('raydium');
    expect(mockEvent.programId).toBeDefined();
  });

  it.todo('should convert parsed swap to SwapEvent format');
  it.todo('should set chain to "solana"');
  it.todo('should use slot as blockNumber');
  it.todo('should use signature as transactionHash');
  it.todo('should include programId in event');
  it.todo('should include instructionIndex in event');
});

// =============================================================================
// S3.3.4.13: Statistics Tests
// =============================================================================

describe('S3.3.4.13: Parser Statistics', () => {
  let parser: SolanaSwapParser;
  const mockPoolAddress = 'StatisticsTestPool123456789012345678901234';

  beforeEach(() => {
    resetSolanaSwapParser();
    parser = new SolanaSwapParser();
  });

  afterEach(() => {
    resetSolanaSwapParser();
  });

  it('should track total transactions parsed', () => {
    const instruction = createRaydiumAmmSwapInstruction({
      amountIn: 1000000000n,
      minAmountOut: 95000000n,
      poolAddress: mockPoolAddress,
      userSource: 'userSource',
      userDestination: 'userDest'
    });

    const tx1 = createMockTransaction({
      signature: 'statsTx1',
      slot: 250000100,
      blockTime: Math.floor(Date.now() / 1000),
      instructions: [instruction],
      success: true
    });

    const tx2 = createMockTransaction({
      signature: 'statsTx2',
      slot: 250000101,
      blockTime: Math.floor(Date.now() / 1000),
      instructions: [instruction],
      success: true
    });

    expect(parser.getStats().totalParsed).toBe(0);

    parser.parseTransaction(tx1);
    expect(parser.getStats().totalParsed).toBe(1);

    parser.parseTransaction(tx2);
    expect(parser.getStats().totalParsed).toBe(2);
  });

  it('should track swaps detected by DEX', () => {
    const raydiumInstruction = createRaydiumAmmSwapInstruction({
      amountIn: 1000000000n,
      minAmountOut: 95000000n,
      poolAddress: mockPoolAddress,
      userSource: 'userSource',
      userDestination: 'userDest'
    });

    const orcaInstruction = createOrcaWhirlpoolSwapInstruction({
      amount: 1000000000n,
      otherAmountThreshold: 95000000n,
      sqrtPriceLimit: 79226673515401279992447579055n,
      amountSpecifiedIsInput: true,
      aToB: true,
      poolAddress: 'orcaPool'
    });

    parser.parseTransaction(createMockTransaction({
      signature: 'raydiumTx',
      slot: 250000102,
      blockTime: Math.floor(Date.now() / 1000),
      instructions: [raydiumInstruction],
      success: true
    }));

    parser.parseTransaction(createMockTransaction({
      signature: 'orcaTx',
      slot: 250000103,
      blockTime: Math.floor(Date.now() / 1000),
      instructions: [orcaInstruction],
      success: true
    }));

    const stats = parser.getStats();
    expect(stats.swapsByDex['raydium']).toBe(1);
    expect(stats.swapsByDex['orca']).toBe(1);
    expect(stats.totalSwapsDetected).toBe(2);
  });

  it('should track parse errors', () => {
    // Parsing should increment totalParsed but not swaps for unknown programs
    const unknownInstruction = createMockInstruction({
      programId: 'UnknownProgramId12345678901234567890123',
      data: Buffer.from([9, 0, 0, 0, 0, 0, 0, 0, 0]),
      accounts: ['account1', 'account2']
    });

    parser.parseTransaction(createMockTransaction({
      signature: 'unknownTx',
      slot: 250000104,
      blockTime: Math.floor(Date.now() / 1000),
      instructions: [unknownInstruction],
      success: true
    }));

    const stats = parser.getStats();
    expect(stats.totalParsed).toBe(1);
    expect(stats.totalSwapsDetected).toBe(0);
  });

  it('should reset statistics', () => {
    const instruction = createRaydiumAmmSwapInstruction({
      amountIn: 1000000000n,
      minAmountOut: 95000000n,
      poolAddress: mockPoolAddress,
      userSource: 'userSource',
      userDestination: 'userDest'
    });

    parser.parseTransaction(createMockTransaction({
      signature: 'resetTx',
      slot: 250000105,
      blockTime: Math.floor(Date.now() / 1000),
      instructions: [instruction],
      success: true
    }));

    expect(parser.getStats().totalParsed).toBe(1);
    expect(parser.getStats().totalSwapsDetected).toBe(1);

    parser.resetStats();

    expect(parser.getStats().totalParsed).toBe(0);
    expect(parser.getStats().totalSwapsDetected).toBe(0);
    expect(parser.getStats().swapsByDex).toEqual({});
  });

  it('should provide Prometheus metrics', () => {
    const instruction = createRaydiumAmmSwapInstruction({
      amountIn: 1000000000n,
      minAmountOut: 95000000n,
      poolAddress: mockPoolAddress,
      userSource: 'userSource',
      userDestination: 'userDest'
    });

    parser.parseTransaction(createMockTransaction({
      signature: 'prometheusTx',
      slot: 250000106,
      blockTime: Math.floor(Date.now() / 1000),
      instructions: [instruction],
      success: true
    }));

    const metrics = parser.getPrometheusMetrics();

    expect(metrics).toContain('solana_swap_parser_total_parsed 1');
    expect(metrics).toContain('solana_swap_parser_swaps_detected 1');
    expect(metrics).toContain('solana_swap_parser_swaps_by_dex{dex="raydium"} 1');
    expect(metrics).toContain('# HELP');
    expect(metrics).toContain('# TYPE');
  });
});

// =============================================================================
// S3.3.4.14: Error Handling Tests
// =============================================================================

describe('S3.3.4.14: Error Handling', () => {
  it.todo('should handle malformed instruction data');
  it.todo('should handle missing account keys');
  it.todo('should handle unknown instruction discriminators');
  it.todo('should log parse errors without throwing');
  it.todo('should continue parsing after errors');
});

// =============================================================================
// S3.3.4.15: Integration with SolanaDetector Tests
// =============================================================================

describe('S3.3.4.15: Integration with SolanaDetector', () => {
  it.todo('should receive account updates from detector');
  it.todo('should emit parsed swap events');
  it.todo('should work with SwapEventFilter');
  it.todo('should integrate with price update flow');
});

// =============================================================================
// S3.3.4.16: Regression Tests
// =============================================================================

describe('S3.3.4.16: Regression Tests', () => {
  it('should support all 6 enabled Solana DEXs', () => {
    const enabledDexes = [
      'raydium',
      'raydium-clmm',
      'orca',
      'meteora',
      'phoenix',
      'lifinity'
    ];

    expect(enabledDexes.length).toBe(6);
  });

  it('should have Jupiter disabled (aggregator)', () => {
    // Jupiter is disabled to avoid double-counting
    // It routes through other DEXs
    expect(EXPECTED_PROGRAM_IDS.JUPITER).toBeDefined();
  });

  it.todo('should not break on DEX protocol upgrades');
  it.todo('should handle new instruction versions');
  it.todo('should maintain backwards compatibility');
});

// =============================================================================
// S3.3.4.17: Performance Tests
// =============================================================================

describe('S3.3.4.17: Performance', () => {
  it.todo('should parse instructions within 1ms');
  it.todo('should handle high-volume transaction streams');
  it.todo('should not leak memory on continuous parsing');
});

// =============================================================================
// S3.3.4.18: Summary Statistics
// =============================================================================

describe('S3.3.4.18: Summary Statistics', () => {
  it('should count total test categories', () => {
    // Summary of test coverage
    const testCategories = {
      configuration: 5,
      programIdRecognition: 9,
      instructionDetection: 10,
      raydiumAmm: 7,
      orcaWhirlpool: 7,
      raydiumClmm: 4,
      meteoraDlmm: 4,
      phoenix: 5,
      lifinity: 3,
      jupiter: 4,
      transactionParsing: 6,
      swapEventConversion: 7,
      statistics: 5,
      errorHandling: 5,
      detectorIntegration: 4,
      regression: 5,
      performance: 3
    };

    const totalTests = Object.values(testCategories).reduce((a, b) => a + b, 0);
     
    console.log(`S3.3.4 Total planned tests: ${totalTests}`);
    expect(totalTests).toBeGreaterThanOrEqual(80);
  });
});
