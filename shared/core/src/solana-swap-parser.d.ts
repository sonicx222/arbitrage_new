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
import { SwapEvent } from '../../types';
/**
 * Solana DEX Program IDs.
 * These identify which DEX a transaction is interacting with.
 */
export declare const SOLANA_DEX_PROGRAM_IDS: {
    readonly JUPITER: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
    readonly RAYDIUM_AMM: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
    readonly RAYDIUM_CLMM: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
    readonly ORCA_WHIRLPOOL: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
    readonly METEORA_DLMM: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
    readonly PHOENIX: "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY";
    readonly LIFINITY: "2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c";
};
/**
 * Map program IDs to DEX names.
 */
export declare const PROGRAM_ID_TO_DEX: Record<string, string>;
/**
 * DEX-specific swap instruction discriminators.
 * Anchor programs use 8-byte discriminators derived from SHA256("global:<instruction_name>")[:8].
 * Legacy programs (Raydium AMM, Phoenix) use instruction index in first byte.
 *
 * NOTE: Discriminators are verified against on-chain IDLs where available.
 * The program ID check happens BEFORE discriminator check, so collisions don't
 * cause incorrect DEX identification - they would only cause missed swaps.
 */
export declare const SWAP_DISCRIMINATORS: {
    readonly RAYDIUM_AMM_SWAP: 9;
    readonly RAYDIUM_CLMM_SWAP: Buffer<ArrayBuffer>;
    readonly ORCA_WHIRLPOOL_SWAP: Buffer<ArrayBuffer>;
    readonly METEORA_DLMM_SWAP: Buffer<ArrayBuffer>;
    readonly PHOENIX_SWAP: Buffer<ArrayBuffer>;
    readonly LIFINITY_SWAP: Buffer<ArrayBuffer>;
};
/**
 * Disabled DEXs (aggregators that route through other DEXs).
 */
export declare const DISABLED_DEXES: Set<string>;
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
/**
 * Parses Solana DEX swap instructions into standardized SwapEvent format.
 */
export declare class SolanaSwapParser extends EventEmitter {
    private config;
    private stats;
    constructor(config?: Partial<SwapParserConfig>);
    private validateConfig;
    getConfig(): SwapParserConfig;
    updateConfig(updates: Partial<SwapParserConfig>): void;
    /**
     * Safely extract account pubkey from instruction accounts.
     * Returns 'unknown' if index is out of bounds or pubkey is missing.
     */
    private getAccountPubkey;
    /**
     * Get DEX name from program ID.
     */
    getDexFromProgramId(programId: string): string | null;
    /**
     * Check if a DEX is enabled for parsing.
     */
    isDexEnabled(dex: string): boolean;
    /**
     * Check if program ID belongs to a known DEX.
     */
    isKnownDexProgram(programId: string): boolean;
    /**
     * Check if an instruction is a swap instruction.
     */
    isSwapInstruction(instruction: SolanaInstruction): boolean;
    private isRaydiumAmmSwap;
    private isRaydiumClmmSwap;
    private isOrcaWhirlpoolSwap;
    private isMeteoraDlmmSwap;
    private isPhoenixTrade;
    private isLifinitySwap;
    /**
     * Parse a full transaction and extract all swap events.
     */
    parseTransaction(tx: SolanaTransaction): ParsedSolanaSwap[];
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
    parseInstruction(instruction: SolanaInstruction, context: {
        signature: string;
        slot: number;
        blockTime: number;
        instructionIndex: number;
        /** Pre/post token balances - reserved for future actual amount extraction */
        tokenBalances?: {
            pre: TokenBalance[];
            post: TokenBalance[];
        };
    }): ParsedSolanaSwap | null;
    /**
     * Parse Raydium AMM swap instruction.
     */
    private parseRaydiumAmmSwap;
    /**
     * Parse Raydium CLMM swap instruction.
     */
    private parseRaydiumClmmSwap;
    /**
     * Parse Orca Whirlpool swap instruction.
     */
    private parseOrcaWhirlpoolSwap;
    /**
     * Parse Meteora DLMM swap instruction.
     */
    private parseMeteoraDlmmSwap;
    /**
     * Parse Phoenix swap instruction.
     *
     * Phoenix V1 uses Anchor format with Swap instruction.
     * Layout is similar to other Anchor DEXs.
     *
     * NOTE: For complex order book operations (limit orders, partial fills),
     * additional log parsing would be needed. This parser handles simple swaps.
     */
    private parsePhoenixTrade;
    /**
     * Parse Lifinity swap instruction.
     */
    private parseLifinitySwap;
    getStats(): ParserStats;
    resetStats(): void;
    /**
     * Get Prometheus-formatted metrics.
     */
    getPrometheusMetrics(): string;
}
/**
 * Get or create the singleton SolanaSwapParser instance.
 *
 * NOTE: Config is only used on first initialization. Subsequent calls with
 * different config will log a warning but not update the configuration.
 * Use updateConfig() to modify configuration after initialization.
 */
export declare function getSolanaSwapParser(config?: Partial<SwapParserConfig>): SolanaSwapParser;
/**
 * Reset the singleton instance (for testing).
 */
export declare function resetSolanaSwapParser(): void;
export default SolanaSwapParser;
//# sourceMappingURL=solana-swap-parser.d.ts.map