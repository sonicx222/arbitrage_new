/**
 * S3.3.4: Solana Swap Parser
 *
 * Parses swap instructions from Solana DEX transactions.
 * Unlike EVM which uses event logs, Solana uses transaction instructions
 * that must be decoded according to each DEX's specific format.
 *
 * Supported DEXs:
 * - Raydium AMM: Constant product AMM (instruction index 9 = swap)
 * - Raydium CLMM: Concentrated liquidity (Anchor discriminator)
 * - Orca Whirlpool: CLMM swaps (Anchor discriminator)
 * - Meteora DLMM: Dynamic liquidity bins (Anchor discriminator)
 * - Phoenix: On-chain order book (instruction index based)
 * - Lifinity: Proactive market maker (Anchor discriminator)
 * - Jupiter: Aggregator (disabled for direct detection)
 *
 * @see IMPLEMENTATION_PLAN.md S3.3.4
 */

import { EventEmitter } from 'events';
import type { SwapEvent } from '@arbitrage/types';
import { createLogger } from '../logger';

const logger = createLogger('solana-swap-parser');

// =============================================================================
// Constants
// =============================================================================

/**
 * Solana DEX Program IDs.
 * These identify which DEX a transaction is interacting with.
 */
export const SOLANA_DEX_PROGRAM_IDS = {
  JUPITER: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  RAYDIUM_AMM: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  RAYDIUM_CLMM: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  ORCA_WHIRLPOOL: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  METEORA_DLMM: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  PHOENIX: 'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY',
  LIFINITY: '2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c'
} as const;

/**
 * Map program IDs to DEX names.
 */
export const PROGRAM_ID_TO_DEX: Record<string, string> = {
  [SOLANA_DEX_PROGRAM_IDS.JUPITER]: 'jupiter',
  [SOLANA_DEX_PROGRAM_IDS.RAYDIUM_AMM]: 'raydium',
  [SOLANA_DEX_PROGRAM_IDS.RAYDIUM_CLMM]: 'raydium-clmm',
  [SOLANA_DEX_PROGRAM_IDS.ORCA_WHIRLPOOL]: 'orca',
  [SOLANA_DEX_PROGRAM_IDS.METEORA_DLMM]: 'meteora',
  [SOLANA_DEX_PROGRAM_IDS.PHOENIX]: 'phoenix',
  [SOLANA_DEX_PROGRAM_IDS.LIFINITY]: 'lifinity'
};

/**
 * DEX-specific swap instruction discriminators.
 * Anchor programs use 8-byte discriminators derived from SHA256("global:<instruction_name>")[:8].
 * Legacy programs (Raydium AMM, Phoenix) use instruction index in first byte.
 *
 * NOTE: Discriminators are verified against on-chain IDLs where available.
 * The program ID check happens BEFORE discriminator check, so collisions don't
 * cause incorrect DEX identification - they would only cause missed swaps.
 */
export const SWAP_DISCRIMINATORS = {
  // Raydium AMM v4: instruction index 9 = swap (legacy, non-Anchor)
  RAYDIUM_AMM_SWAP: 9,
  // Raydium CLMM: Anchor "swap" discriminator - verified from on-chain IDL
  RAYDIUM_CLMM_SWAP: Buffer.from([43, 4, 237, 11, 26, 201, 106, 243]),
  // Orca Whirlpool: Anchor "swap" discriminator - SHA256("global:swap")[:8]
  ORCA_WHIRLPOOL_SWAP: Buffer.from([248, 198, 158, 145, 225, 117, 135, 200]),
  // Meteora DLMM: Anchor "swap" discriminator - different instruction layout
  // NOTE: Meteora uses same "swap" name but different program, so same discriminator hash
  METEORA_DLMM_SWAP: Buffer.from([248, 198, 158, 145, 225, 117, 135, 200]),
  // Phoenix V1: Anchor discriminators for order placement
  // NOTE: Phoenix is an order book - trades happen via Swap instruction (not NewOrderV1)
  // Discriminator: SHA256("global:Swap")[:8]
  PHOENIX_SWAP: Buffer.from([248, 198, 158, 145, 225, 117, 135, 200]),
  // Lifinity V2: Anchor "swap" discriminator
  // NOTE: Uses same "swap" instruction name, different program ID ensures correct routing
  LIFINITY_SWAP: Buffer.from([248, 198, 158, 145, 225, 117, 135, 200])
} as const;

/**
 * Disabled DEXs (aggregators that route through other DEXs).
 */
export const DISABLED_DEXES = new Set(['jupiter']);

// =============================================================================
// Types
// =============================================================================

/**
 * Solana instruction account with metadata.
 */
export interface InstructionAccount {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

/**
 * Solana transaction instruction.
 */
export interface SolanaInstruction {
  programId: string;
  data: Buffer;
  accounts: InstructionAccount[];
}

/**
 * Solana transaction with metadata.
 */
export interface SolanaTransaction {
  signature: string;
  slot: number;
  blockTime: number;
  instructions: SolanaInstruction[];
  meta: {
    err: any;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances: TokenBalance[];
    postTokenBalances: TokenBalance[];
  };
}

/**
 * Token balance from transaction metadata.
 */
export interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner: string;
  uiTokenAmount: {
    amount: string;
    decimals: number;
    uiAmount: number;
  };
}

/**
 * Parsed swap event with Solana-specific fields.
 */
export interface ParsedSolanaSwap extends SwapEvent {
  programId: string;
  instructionIndex: number;
}

/**
 * Parser configuration.
 */
export interface SwapParserConfig {
  /** List of enabled DEX names (default: all except aggregators) */
  enabledDexes: string[];
  /** Minimum amount threshold to parse (filter dust) */
  minAmountThreshold: bigint;
  /** Whether to parse Jupiter routes for analytics */
  parseJupiterRoutes: boolean;
}

/**
 * Parser statistics.
 */
export interface ParserStats {
  totalParsed: number;
  totalSwapsDetected: number;
  swapsByDex: Record<string, number>;
  parseErrors: number;
}

// =============================================================================
// SolanaSwapParser Class
// =============================================================================

/**
 * Parses Solana DEX swap instructions into standardized SwapEvent format.
 */
export class SolanaSwapParser extends EventEmitter {
  private config: SwapParserConfig;
  private stats: ParserStats;
  /** Pre-computed Set for O(1) enabledDexes lookup (Fix 12). */
  private enabledDexesSet: ReadonlySet<string>;

  constructor(config: Partial<SwapParserConfig> = {}) {
    super();

    // Validate and set default config
    this.config = {
      enabledDexes: config.enabledDexes ?? [
        'raydium',
        'raydium-clmm',
        'orca',
        'meteora',
        'phoenix',
        'lifinity'
      ],
      minAmountThreshold: config.minAmountThreshold ?? 0n,
      parseJupiterRoutes: config.parseJupiterRoutes ?? false
    };

    // Validate config
    this.validateConfig(this.config);

    // Build Set for O(1) lookup
    this.enabledDexesSet = new Set(this.config.enabledDexes);

    // Initialize stats
    this.stats = {
      totalParsed: 0,
      totalSwapsDetected: 0,
      swapsByDex: {},
      parseErrors: 0
    };

    logger.info('SolanaSwapParser initialized', {
      enabledDexes: this.config.enabledDexes,
      minAmountThreshold: this.config.minAmountThreshold.toString()
    });
  }

  // ===========================================================================
  // Configuration
  // ===========================================================================

  private validateConfig(config: SwapParserConfig): void {
    if (!Array.isArray(config.enabledDexes)) {
      throw new Error('enabledDexes must be an array');
    }
    if (config.minAmountThreshold < 0n) {
      throw new Error('minAmountThreshold must be non-negative');
    }
  }

  getConfig(): SwapParserConfig {
    return { ...this.config };
  }

  updateConfig(updates: Partial<SwapParserConfig>): void {
    const newConfig = { ...this.config, ...updates };
    this.validateConfig(newConfig);
    this.config = newConfig;
    // Rebuild Set when config changes
    this.enabledDexesSet = new Set(this.config.enabledDexes);
    logger.info('SwapParser config updated', { config: this.config });
  }

  // ===========================================================================
  // Helper Methods
  // ===========================================================================

  /**
   * Safely extract account pubkey from instruction accounts.
   * Returns 'unknown' if index is out of bounds or pubkey is missing.
   */
  private getAccountPubkey(accounts: InstructionAccount[], index: number): string {
    return accounts[index]?.pubkey || 'unknown';
  }

  // ===========================================================================
  // DEX Identification
  // ===========================================================================

  /**
   * Get DEX name from program ID.
   */
  getDexFromProgramId(programId: string): string | null {
    return PROGRAM_ID_TO_DEX[programId] ?? null;
  }

  /**
   * Check if a DEX is enabled for parsing.
   */
  isDexEnabled(dex: string): boolean {
    return this.enabledDexesSet.has(dex) && !DISABLED_DEXES.has(dex);
  }

  /**
   * Check if program ID belongs to a known DEX.
   */
  isKnownDexProgram(programId: string): boolean {
    return programId in PROGRAM_ID_TO_DEX;
  }

  // ===========================================================================
  // Instruction Detection
  // ===========================================================================

  /**
   * Check if an instruction is a swap instruction.
   */
  isSwapInstruction(instruction: SolanaInstruction): boolean {
    const dex = this.getDexFromProgramId(instruction.programId);
    if (!dex) return false;

    // Check based on DEX type
    switch (dex) {
      case 'raydium':
        return this.isRaydiumAmmSwap(instruction);
      case 'raydium-clmm':
        return this.isRaydiumClmmSwap(instruction);
      case 'orca':
        return this.isOrcaWhirlpoolSwap(instruction);
      case 'meteora':
        return this.isMeteoraDlmmSwap(instruction);
      case 'phoenix':
        return this.isPhoenixTrade(instruction);
      case 'lifinity':
        return this.isLifinitySwap(instruction);
      case 'jupiter':
        // Jupiter is an aggregator - optionally parse for analytics
        return this.config.parseJupiterRoutes;
      default:
        return false;
    }
  }

  private isRaydiumAmmSwap(instruction: SolanaInstruction): boolean {
    if (instruction.data.length < 1) return false;
    // Raydium AMM v4: instruction index 9 = swap
    return instruction.data[0] === SWAP_DISCRIMINATORS.RAYDIUM_AMM_SWAP;
  }

  /**
   * Compare first 8 bytes of instruction data against an Anchor discriminator
   * without allocating a new Buffer via slice().
   */
  private matchesDiscriminator(data: Buffer, discriminator: Buffer): boolean {
    if (data.length < 8) return false;
    return data.compare(discriminator, 0, 8, 0, 8) === 0;
  }

  private isRaydiumClmmSwap(instruction: SolanaInstruction): boolean {
    return this.matchesDiscriminator(instruction.data, SWAP_DISCRIMINATORS.RAYDIUM_CLMM_SWAP);
  }

  private isOrcaWhirlpoolSwap(instruction: SolanaInstruction): boolean {
    return this.matchesDiscriminator(instruction.data, SWAP_DISCRIMINATORS.ORCA_WHIRLPOOL_SWAP);
  }

  private isMeteoraDlmmSwap(instruction: SolanaInstruction): boolean {
    return this.matchesDiscriminator(instruction.data, SWAP_DISCRIMINATORS.METEORA_DLMM_SWAP);
  }

  private isPhoenixTrade(instruction: SolanaInstruction): boolean {
    return this.matchesDiscriminator(instruction.data, SWAP_DISCRIMINATORS.PHOENIX_SWAP);
  }

  private isLifinitySwap(instruction: SolanaInstruction): boolean {
    return this.matchesDiscriminator(instruction.data, SWAP_DISCRIMINATORS.LIFINITY_SWAP);
  }

  // ===========================================================================
  // Transaction Parsing
  // ===========================================================================

  /**
   * Parse a full transaction and extract all swap events.
   */
  parseTransaction(tx: SolanaTransaction): ParsedSolanaSwap[] {
    this.stats.totalParsed++;
    const swaps: ParsedSolanaSwap[] = [];

    // Skip failed transactions
    if (tx.meta.err !== null) {
      logger.debug('Skipping failed transaction', { signature: tx.signature });
      return swaps;
    }

    // Parse each instruction
    for (let i = 0; i < tx.instructions.length; i++) {
      const instruction = tx.instructions[i];

      try {
        const swap = this.parseInstruction(instruction, {
          signature: tx.signature,
          slot: tx.slot,
          blockTime: tx.blockTime,
          instructionIndex: i,
          tokenBalances: {
            pre: tx.meta.preTokenBalances,
            post: tx.meta.postTokenBalances
          }
        });

        if (swap) {
          swaps.push(swap);
          this.stats.totalSwapsDetected++;

          const dex = swap.dex;
          this.stats.swapsByDex[dex] = (this.stats.swapsByDex[dex] ?? 0) + 1;

          this.emit('swap', swap);
        }
      } catch (error) {
        this.stats.parseErrors++;
        logger.warn('Error parsing instruction', {
          signature: tx.signature,
          instructionIndex: i,
          error
        });
      }
    }

    return swaps;
  }

  /**
   * Parse a single instruction.
   *
   * @param instruction - The Solana instruction to parse
   * @param context - Transaction context including signature, slot, blockTime, and instructionIndex
   * @param context.tokenBalances - Optional pre/post token balances for accurate amount extraction.
   *        NOTE: Currently unused - parsers extract amounts from instruction data (which contains
   *        expected amounts, not actual executed amounts). Future enhancement could use token
   *        balances to compute actual swap amounts from balance differences.
   */
  parseInstruction(
    instruction: SolanaInstruction,
    context: {
      signature: string;
      slot: number;
      blockTime: number;
      instructionIndex: number;
      /** Pre/post token balances - reserved for future actual amount extraction */
      tokenBalances?: {
        pre: TokenBalance[];
        post: TokenBalance[];
      };
    }
  ): ParsedSolanaSwap | null {
    // Check if it's a swap instruction
    if (!this.isSwapInstruction(instruction)) {
      return null;
    }

    const dex = this.getDexFromProgramId(instruction.programId);
    if (!dex || !this.isDexEnabled(dex)) {
      return null;
    }

    // Parse based on DEX type
    switch (dex) {
      case 'raydium':
        return this.parseRaydiumAmmSwap(instruction, context);
      case 'raydium-clmm':
        return this.parseRaydiumClmmSwap(instruction, context);
      case 'orca':
        return this.parseOrcaWhirlpoolSwap(instruction, context);
      case 'meteora':
        return this.parseMeteoraDlmmSwap(instruction, context);
      case 'phoenix':
        return this.parsePhoenixTrade(instruction, context);
      case 'lifinity':
        return this.parseLifinitySwap(instruction, context);
      default:
        return null;
    }
  }

  // ===========================================================================
  // DEX-Specific Parsers
  // ===========================================================================

  /**
   * Parse Raydium AMM swap instruction.
   */
  private parseRaydiumAmmSwap(
    instruction: SolanaInstruction,
    context: {
      signature: string;
      slot: number;
      blockTime: number;
      instructionIndex: number;
    }
  ): ParsedSolanaSwap | null {
    try {
      // Raydium AMM swap layout:
      // [0]: instruction index (9)
      // [1-8]: amountIn (u64 LE)
      // [9-16]: minAmountOut (u64 LE)
      if (instruction.data.length < 17) {
        return null;
      }

      const amountIn = instruction.data.readBigUInt64LE(1);
      const minAmountOut = instruction.data.readBigUInt64LE(9);

      // Filter dust amounts
      if (amountIn < this.config.minAmountThreshold) {
        return null;
      }

      // Extract accounts using helper for bounds safety
      // Account layout for Raydium AMM swap:
      // [1]: AMM (pool address)
      // [15]: User source token account
      // [16]: User destination token account
      // [17]: User owner
      const poolAddress = this.getAccountPubkey(instruction.accounts, 1);
      const userSource = this.getAccountPubkey(instruction.accounts, 15);
      const userDestination = this.getAccountPubkey(instruction.accounts, 16);
      const userOwner = this.getAccountPubkey(instruction.accounts, 17);

      return {
        pairAddress: poolAddress,
        sender: userOwner,
        recipient: userOwner,
        amount0In: amountIn.toString(),
        amount1In: '0',
        amount0Out: '0',
        amount1Out: minAmountOut.toString(), // Note: actual amount may differ
        to: userDestination,
        blockNumber: context.slot,
        transactionHash: context.signature,
        timestamp: context.blockTime * 1000, // Convert to ms
        dex: 'raydium',
        chain: 'solana',
        programId: instruction.programId,
        instructionIndex: context.instructionIndex
      };
    } catch (error) {
      logger.warn('Failed to parse Raydium AMM swap', { error });
      return null;
    }
  }

  /**
   * Parse Raydium CLMM swap instruction.
   */
  private parseRaydiumClmmSwap(
    instruction: SolanaInstruction,
    context: {
      signature: string;
      slot: number;
      blockTime: number;
      instructionIndex: number;
    }
  ): ParsedSolanaSwap | null {
    try {
      // Raydium CLMM swap layout (Anchor):
      // [0-7]: discriminator
      // [8-15]: amount (u64 LE)
      // [16-23]: otherAmountThreshold (u64 LE)
      // [24-39]: sqrtPriceLimitX64 (u128 LE)
      // [40]: isBaseInput (bool) - true = base token is input, false = quote is input
      if (instruction.data.length < 41) {
        return null;
      }

      const amount = instruction.data.readBigUInt64LE(8);
      const otherAmountThreshold = instruction.data.readBigUInt64LE(16);
      const isBaseInput = instruction.data[40] === 1;

      if (amount < this.config.minAmountThreshold) {
        return null;
      }

      // Account layout for CLMM swap varies, typically:
      // [2]: Pool state
      const poolAddress = this.getAccountPubkey(instruction.accounts, 2);
      const userOwner = this.getAccountPubkey(instruction.accounts, 1);

      // Determine amounts based on direction:
      // - isBaseInput=true: base token (token0) is input
      // - isBaseInput=false: quote token (token1) is input
      let amount0In = '0';
      let amount1In = '0';
      let amount0Out = '0';
      let amount1Out = '0';

      if (isBaseInput) {
        // Base token input → quote token output
        amount0In = amount.toString();
        amount1Out = otherAmountThreshold.toString();
      } else {
        // Quote token input → base token output
        amount1In = amount.toString();
        amount0Out = otherAmountThreshold.toString();
      }

      return {
        pairAddress: poolAddress,
        sender: userOwner,
        recipient: userOwner,
        amount0In,
        amount1In,
        amount0Out,
        amount1Out,
        to: userOwner,
        blockNumber: context.slot,
        transactionHash: context.signature,
        timestamp: context.blockTime * 1000,
        dex: 'raydium-clmm',
        chain: 'solana',
        programId: instruction.programId,
        instructionIndex: context.instructionIndex
      };
    } catch (error) {
      logger.warn('Failed to parse Raydium CLMM swap', { error });
      return null;
    }
  }

  /**
   * Parse Orca Whirlpool swap instruction.
   */
  private parseOrcaWhirlpoolSwap(
    instruction: SolanaInstruction,
    context: {
      signature: string;
      slot: number;
      blockTime: number;
      instructionIndex: number;
    }
  ): ParsedSolanaSwap | null {
    try {
      // Orca Whirlpool swap layout (Anchor):
      // [0-7]: discriminator
      // [8-15]: amount (u64 LE)
      // [16-23]: otherAmountThreshold (u64 LE)
      // [24-39]: sqrtPriceLimit (u128 LE)
      // [40]: amountSpecifiedIsInput (bool)
      // [41]: aToB (bool)
      if (instruction.data.length < 42) {
        return null;
      }

      const amount = instruction.data.readBigUInt64LE(8);
      const otherAmountThreshold = instruction.data.readBigUInt64LE(16);
      const amountSpecifiedIsInput = instruction.data[40] === 1;
      const aToB = instruction.data[41] === 1;

      if (amount < this.config.minAmountThreshold) {
        return null;
      }

      // Account layout for Whirlpool:
      // [2]: Whirlpool (pool)
      // [1]: Token authority (user)
      const poolAddress = this.getAccountPubkey(instruction.accounts, 2);
      const userOwner = this.getAccountPubkey(instruction.accounts, 1);

      // Determine amounts based on direction:
      // - aToB=true: swapping token A for token B (amount0 in, amount1 out)
      // - aToB=false: swapping token B for token A (amount1 in, amount0 out)
      // - amountSpecifiedIsInput=true: user specifies input amount (exact in)
      // - amountSpecifiedIsInput=false: user specifies output amount (exact out)
      let amount0In = '0';
      let amount1In = '0';
      let amount0Out = '0';
      let amount1Out = '0';

      if (amountSpecifiedIsInput) {
        // Exact input swap: amount is the input, otherAmountThreshold is min output
        if (aToB) {
          amount0In = amount.toString();
          amount1Out = otherAmountThreshold.toString();
        } else {
          amount1In = amount.toString();
          amount0Out = otherAmountThreshold.toString();
        }
      } else {
        // Exact output swap: amount is the output, otherAmountThreshold is max input
        if (aToB) {
          amount0In = otherAmountThreshold.toString();
          amount1Out = amount.toString();
        } else {
          amount1In = otherAmountThreshold.toString();
          amount0Out = amount.toString();
        }
      }

      return {
        pairAddress: poolAddress,
        sender: userOwner,
        recipient: userOwner,
        amount0In,
        amount1In,
        amount0Out,
        amount1Out,
        to: userOwner,
        blockNumber: context.slot,
        transactionHash: context.signature,
        timestamp: context.blockTime * 1000,
        dex: 'orca',
        chain: 'solana',
        programId: instruction.programId,
        instructionIndex: context.instructionIndex
      };
    } catch (error) {
      logger.warn('Failed to parse Orca Whirlpool swap', { error });
      return null;
    }
  }

  /**
   * Parse Meteora DLMM swap instruction.
   */
  private parseMeteoraDlmmSwap(
    instruction: SolanaInstruction,
    context: {
      signature: string;
      slot: number;
      blockTime: number;
      instructionIndex: number;
    }
  ): ParsedSolanaSwap | null {
    try {
      // Similar structure to other Anchor programs
      if (instruction.data.length < 42) {
        return null;
      }

      const amount = instruction.data.readBigUInt64LE(8);
      const otherAmountThreshold = instruction.data.readBigUInt64LE(16);

      if (amount < this.config.minAmountThreshold) {
        return null;
      }

      const poolAddress = this.getAccountPubkey(instruction.accounts, 2);
      const userOwner = this.getAccountPubkey(instruction.accounts, 1);

      return {
        pairAddress: poolAddress,
        sender: userOwner,
        recipient: userOwner,
        amount0In: amount.toString(),
        amount1In: '0',
        amount0Out: '0',
        amount1Out: otherAmountThreshold.toString(),
        to: userOwner,
        blockNumber: context.slot,
        transactionHash: context.signature,
        timestamp: context.blockTime * 1000,
        dex: 'meteora',
        chain: 'solana',
        programId: instruction.programId,
        instructionIndex: context.instructionIndex
      };
    } catch (error) {
      logger.warn('Failed to parse Meteora DLMM swap', { error });
      return null;
    }
  }

  /**
   * Parse Phoenix swap instruction.
   *
   * Phoenix V1 uses Anchor format with Swap instruction.
   * Layout is similar to other Anchor DEXs.
   *
   * NOTE: For complex order book operations (limit orders, partial fills),
   * additional log parsing would be needed. This parser handles simple swaps.
   */
  private parsePhoenixTrade(
    instruction: SolanaInstruction,
    context: {
      signature: string;
      slot: number;
      blockTime: number;
      instructionIndex: number;
    }
  ): ParsedSolanaSwap | null {
    try {
      // Phoenix Swap layout (Anchor):
      // [0-7]: discriminator
      // [8-15]: amount (u64 LE)
      // [16-23]: otherAmountThreshold (u64 LE)
      // Layout may vary by version - extract what we can
      if (instruction.data.length < 24) {
        // Minimum layout for amount extraction
        logger.debug('Phoenix instruction too short for amount extraction', {
          signature: context.signature,
          dataLength: instruction.data.length
        });

        // Fallback: extract market/user but with zero amounts
        const marketAddress = this.getAccountPubkey(instruction.accounts, 1);
        const userOwner = this.getAccountPubkey(instruction.accounts, 0);

        return {
          pairAddress: marketAddress,
          sender: userOwner,
          recipient: userOwner,
          amount0In: '0',
          amount1In: '0',
          amount0Out: '0',
          amount1Out: '0',
          to: userOwner,
          blockNumber: context.slot,
          transactionHash: context.signature,
          timestamp: context.blockTime * 1000,
          dex: 'phoenix',
          chain: 'solana',
          programId: instruction.programId,
          instructionIndex: context.instructionIndex
        };
      }

      const amount = instruction.data.readBigUInt64LE(8);
      const otherAmountThreshold = instruction.data.readBigUInt64LE(16);

      if (amount < this.config.minAmountThreshold) {
        return null;
      }

      // Extract market and user from accounts
      // Phoenix account layout: [trader, market, ...]
      const marketAddress = this.getAccountPubkey(instruction.accounts, 1);
      const userOwner = this.getAccountPubkey(instruction.accounts, 0);

      return {
        pairAddress: marketAddress,
        sender: userOwner,
        recipient: userOwner,
        amount0In: amount.toString(),
        amount1In: '0',
        amount0Out: '0',
        amount1Out: otherAmountThreshold.toString(),
        to: userOwner,
        blockNumber: context.slot,
        transactionHash: context.signature,
        timestamp: context.blockTime * 1000,
        dex: 'phoenix',
        chain: 'solana',
        programId: instruction.programId,
        instructionIndex: context.instructionIndex
      };
    } catch (error) {
      logger.warn('Failed to parse Phoenix trade', { error });
      return null;
    }
  }

  /**
   * Parse Lifinity swap instruction.
   */
  private parseLifinitySwap(
    instruction: SolanaInstruction,
    context: {
      signature: string;
      slot: number;
      blockTime: number;
      instructionIndex: number;
    }
  ): ParsedSolanaSwap | null {
    try {
      // Similar Anchor structure
      if (instruction.data.length < 42) {
        return null;
      }

      const amount = instruction.data.readBigUInt64LE(8);
      const otherAmountThreshold = instruction.data.readBigUInt64LE(16);

      if (amount < this.config.minAmountThreshold) {
        return null;
      }

      const poolAddress = this.getAccountPubkey(instruction.accounts, 2);
      const userOwner = this.getAccountPubkey(instruction.accounts, 1);

      return {
        pairAddress: poolAddress,
        sender: userOwner,
        recipient: userOwner,
        amount0In: amount.toString(),
        amount1In: '0',
        amount0Out: '0',
        amount1Out: otherAmountThreshold.toString(),
        to: userOwner,
        blockNumber: context.slot,
        transactionHash: context.signature,
        timestamp: context.blockTime * 1000,
        dex: 'lifinity',
        chain: 'solana',
        programId: instruction.programId,
        instructionIndex: context.instructionIndex
      };
    } catch (error) {
      logger.warn('Failed to parse Lifinity swap', { error });
      return null;
    }
  }

  // ===========================================================================
  // Statistics
  // ===========================================================================

  getStats(): ParserStats {
    return {
      ...this.stats,
      swapsByDex: { ...this.stats.swapsByDex }
    };
  }

  resetStats(): void {
    this.stats = {
      totalParsed: 0,
      totalSwapsDetected: 0,
      swapsByDex: {},
      parseErrors: 0
    };
  }

  /**
   * Get Prometheus-formatted metrics.
   */
  getPrometheusMetrics(): string {
    const lines: string[] = [];

    lines.push('# HELP solana_swap_parser_total_parsed Total transactions parsed');
    lines.push('# TYPE solana_swap_parser_total_parsed counter');
    lines.push(`solana_swap_parser_total_parsed ${this.stats.totalParsed}`);

    lines.push('# HELP solana_swap_parser_swaps_detected Total swaps detected');
    lines.push('# TYPE solana_swap_parser_swaps_detected counter');
    lines.push(`solana_swap_parser_swaps_detected ${this.stats.totalSwapsDetected}`);

    lines.push('# HELP solana_swap_parser_parse_errors Total parse errors');
    lines.push('# TYPE solana_swap_parser_parse_errors counter');
    lines.push(`solana_swap_parser_parse_errors ${this.stats.parseErrors}`);

    lines.push('# HELP solana_swap_parser_swaps_by_dex Swaps by DEX');
    lines.push('# TYPE solana_swap_parser_swaps_by_dex counter');
    for (const [dex, count] of Object.entries(this.stats.swapsByDex)) {
      lines.push(`solana_swap_parser_swaps_by_dex{dex="${dex}"} ${count}`);
    }

    return lines.join('\n');
  }
}

// =============================================================================
// Singleton Factory
// =============================================================================

let parserInstance: SolanaSwapParser | null = null;

/**
 * Get or create the singleton SolanaSwapParser instance.
 *
 * NOTE: Config is only used on first initialization. Subsequent calls with
 * different config will log a warning but not update the configuration.
 * Use updateConfig() to modify configuration after initialization.
 */
export function getSolanaSwapParser(config?: Partial<SwapParserConfig>): SolanaSwapParser {
  if (!parserInstance) {
    parserInstance = new SolanaSwapParser(config);
  } else if (config && Object.keys(config).length > 0) {
    // Warn if config is provided but instance already exists
    logger.warn(
      'SolanaSwapParser already initialized, config ignored. Use updateConfig() to modify.',
      { providedConfig: config }
    );
  }
  return parserInstance;
}

/**
 * Reset the singleton instance (for testing).
 */
export function resetSolanaSwapParser(): void {
  parserInstance = null;
}

export default SolanaSwapParser;
