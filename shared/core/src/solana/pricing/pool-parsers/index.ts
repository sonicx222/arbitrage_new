/**
 * Solana Pool Parsers
 *
 * Modular parsers for Solana DEX pool account data.
 * Each parser handles a specific DEX's account layout and price calculation.
 *
 * Supported DEXes:
 * - Raydium AMM: Constant product AMM
 * - Raydium CLMM: Concentrated liquidity
 * - Orca Whirlpool: Concentrated liquidity
 *
 * @module solana/pricing/pool-parsers
 */

// =============================================================================
// Types (shared across all parsers)
// =============================================================================

export type {
  PoolParserLogger,
  BaseParsedPoolState,
  ParsedPriceData,
  PoolParser
} from './types';

// =============================================================================
// Utilities (shared across all parsers)
// =============================================================================

export {
  readU128LE,
  readPubkey,
  safeInversePrice,
  calculateClmmPriceFromSqrt,
  tickToPrice,
  priceToTick
} from './utils';

// =============================================================================
// Raydium AMM Parser
// =============================================================================

export {
  RAYDIUM_AMM_LAYOUT,
  parseRaydiumAmmState,
  calculateAmmPrice,
  parseRaydiumAmmPriceUpdate,
  getDexName as getRaydiumAmmDexName,
  getMinAccountSize as getRaydiumAmmMinAccountSize
} from './raydium-amm-parser';

export type { RaydiumAmmPoolState } from './raydium-amm-parser';

// =============================================================================
// Raydium CLMM Parser
// =============================================================================

export {
  RAYDIUM_CLMM_LAYOUT,
  parseRaydiumClmmState,
  calculateClmmPrice,
  parseRaydiumClmmPriceUpdate,
  getDexName as getRaydiumClmmDexName,
  getMinAccountSize as getRaydiumClmmMinAccountSize
} from './raydium-clmm-parser';

export type { RaydiumClmmPoolState } from './raydium-clmm-parser';

// =============================================================================
// Orca Whirlpool Parser
// =============================================================================

export {
  ORCA_WHIRLPOOL_LAYOUT,
  parseOrcaWhirlpoolState,
  calculateWhirlpoolPrice,
  parseOrcaWhirlpoolPriceUpdate,
  getDexName as getOrcaWhirlpoolDexName,
  getMinAccountSize as getOrcaWhirlpoolMinAccountSize
} from './orca-whirlpool-parser';

export type { OrcaWhirlpoolState } from './orca-whirlpool-parser';
