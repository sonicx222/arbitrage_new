/**
 * Shared types for Solana pool parsers.
 *
 * @module solana/pricing/pool-parsers/types
 */

/**
 * Logger interface for pool parsers.
 */
export interface PoolParserLogger {
  info: (message: string, meta?: object) => void;
  warn: (message: string, meta?: object) => void;
  error: (message: string, meta?: object) => void;
  debug: (message: string, meta?: object) => void;
}

/**
 * Base parsed pool state common to all DEXes.
 */
export interface BaseParsedPoolState {
  /** Pool status (0 = uninitialized, 1 = active, etc.) */
  status: number;
  /** Token 0 mint address */
  token0Mint: string;
  /** Token 1 mint address */
  token1Mint: string;
  /** Token 0 decimals */
  token0Decimals: number;
  /** Token 1 decimals */
  token1Decimals: number;
}

/**
 * Parsed price update from pool state.
 */
export interface ParsedPriceData {
  /** Pool address */
  poolAddress: string;
  /** DEX name */
  dex: string;
  /** Token 0 mint address */
  token0: string;
  /** Token 1 mint address */
  token1: string;
  /** Price (token1 per token0) */
  price: number;
  /** Inverse price (token0 per token1) */
  inversePrice: number;
  /** Token 0 reserves (normalized string) */
  reserve0: string;
  /** Token 1 reserves (normalized string) */
  reserve1: string;
  /** Solana slot number */
  slot: number;
  /** Timestamp of update */
  timestamp: number;
  /** For CLMM: sqrt price as string */
  sqrtPriceX64?: string;
  /** For CLMM: current liquidity */
  liquidity?: string;
  /** For CLMM: current tick index */
  tickCurrentIndex?: number;
}

/**
 * Pool parser interface for type-safe parsing.
 */
export interface PoolParser<TState extends BaseParsedPoolState> {
  /** Parse pool state from account data buffer */
  parseState(data: Buffer, logger?: PoolParserLogger): TState | null;
  /** Calculate price from parsed state */
  calculatePrice(state: TState): number;
  /** Get DEX name for this parser */
  getDexName(): string;
  /** Get minimum account size required */
  getMinAccountSize(): number;
}
