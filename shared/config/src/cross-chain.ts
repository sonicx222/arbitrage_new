/**
 * Cross-Chain Token Normalization
 *
 * Token aliases for identifying equivalent tokens across chains.
 * Enables cross-chain arbitrage detection.
 *
 * @see S3.2.4: Cross-chain token normalization
 * @see services/cross-chain-detector/src/detector.ts
 */

import { CORE_TOKENS } from './tokens';

// =============================================================================
// CROSS-CHAIN TOKEN NORMALIZATION (S3.2.4)
// =============================================================================

/**
 * Cross-chain token aliases for identifying equivalent tokens across chains.
 * Maps chain-specific token symbols to their canonical form.
 *
 * Purpose: Enable cross-chain arbitrage detection by recognizing that
 * WETH.e (Avalanche), ETH (BSC), and WETH (most chains) are all the same asset.
 *
 * Note: This is DIFFERENT from price-oracle's TOKEN_ALIASES which maps
 * wrapped tokens to native for pricing (WETH→ETH). Here we use WETH as
 * canonical because it's the actual tradeable asset on DEXes.
 *
 * @see services/cross-chain-detector/src/detector.ts
 * @see shared/core/src/price-oracle.ts (different purpose)
 */
export const CROSS_CHAIN_TOKEN_ALIASES: Readonly<Record<string, string>> = {
  // Fantom-specific (keys are UPPERCASE for case-insensitive matching)
  'FUSDT': 'USDT',
  'WFTM': 'FTM',

  // Avalanche-specific (bridged tokens use .e suffix)
  'WAVAX': 'AVAX',
  'WETH.E': 'WETH', // Note: .E is uppercase for matching
  'WBTC.E': 'WBTC',
  'USDT.E': 'USDT',
  'USDC.E': 'USDC',
  'DAI.E': 'DAI',
  'SAVAX': 'AVAX', // Staked AVAX (Benqi) → canonical AVAX

  // BSC-specific
  'WBNB': 'BNB',
  'BTCB': 'WBTC', // Binance wrapped BTC → canonical WBTC
  'ETH': 'WETH',  // BSC bridged ETH → canonical WETH

  // Polygon-specific
  'WMATIC': 'MATIC',

  // Solana-specific (Liquid Staking Tokens)
  'MSOL': 'SOL',     // Marinade staked SOL → canonical SOL
  'JITOSOL': 'SOL',  // Jito staked SOL → canonical SOL
  'BSOL': 'SOL',     // BlazeStake staked SOL → canonical SOL

  // Generic wrappers (if found without chain context)
  'WETH': 'WETH', // Identity mapping for clarity
  'WBTC': 'WBTC',
  'SOL': 'SOL'    // Identity for clarity
} as const;

/**
 * Normalize a token symbol to its canonical form for cross-chain comparison.
 * This enables identifying equivalent tokens across different chains.
 *
 * Examples:
 * - normalizeTokenForCrossChain('WETH.e') → 'WETH'  (Avalanche bridged ETH)
 * - normalizeTokenForCrossChain('ETH') → 'WETH'     (BSC bridged ETH)
 * - normalizeTokenForCrossChain('fUSDT') → 'USDT'   (Fantom USDT)
 * - normalizeTokenForCrossChain('BTCB') → 'WBTC'    (BSC wrapped BTC)
 * - normalizeTokenForCrossChain('USDC') → 'USDC'    (passthrough)
 *
 * @param symbol - The token symbol to normalize
 * @returns The canonical token symbol for cross-chain comparison
 */
export function normalizeTokenForCrossChain(symbol: string): string {
  const upper = symbol.toUpperCase().trim();
  return CROSS_CHAIN_TOKEN_ALIASES[upper] || upper;
}

/**
 * Find common tokens between two chains using normalized comparison.
 * Returns canonical token symbols that exist on both chains.
 *
 * @param chainA - First chain ID
 * @param chainB - Second chain ID
 * @returns Array of canonical token symbols common to both chains
 */
export function findCommonTokensBetweenChains(chainA: string, chainB: string): string[] {
  const tokensA = CORE_TOKENS[chainA] || [];
  const tokensB = CORE_TOKENS[chainB] || [];

  const normalizedA = new Set(tokensA.map(t => normalizeTokenForCrossChain(t.symbol)));
  const normalizedB = new Set(tokensB.map(t => normalizeTokenForCrossChain(t.symbol)));

  return Array.from(normalizedA).filter(token => normalizedB.has(token));
}

/**
 * Get the chain-specific token symbol for a canonical symbol.
 * Useful for building pair keys when you know the canonical token.
 *
 * @param chainId - The chain ID
 * @param canonicalSymbol - The canonical token symbol (e.g., 'WETH')
 * @returns The chain-specific symbol (e.g., 'WETH.e' on Avalanche) or undefined
 */
export function getChainSpecificTokenSymbol(chainId: string, canonicalSymbol: string): string | undefined {
  const tokens = CORE_TOKENS[chainId.toLowerCase()] || [];
  const normalizedCanonical = canonicalSymbol.toUpperCase();

  // First try exact match (case-insensitive)
  const exactMatch = tokens.find(t => t.symbol.toUpperCase() === normalizedCanonical);
  if (exactMatch) return exactMatch.symbol;

  // Then try normalized match (handles aliases like WETH.e → WETH)
  for (const token of tokens) {
    if (normalizeTokenForCrossChain(token.symbol) === normalizedCanonical) {
      return token.symbol;
    }
  }

  return undefined;
}

// =============================================================================
// CHAIN-SPECIFIC DEFAULT QUOTE TOKENS (Refactored from detector.ts)
// =============================================================================

/**
 * Chain-specific default quote tokens for whale transaction parsing.
 * Different chains have different primary stablecoins used as quote currency.
 *
 * Used when a whale transaction contains a single token (e.g., "WETH")
 * and we need to infer the quote token for the trading pair.
 *
 * @see services/cross-chain-detector/src/detector.ts - analyzeWhaleImpact()
 */
export const DEFAULT_QUOTE_TOKENS: Readonly<Record<string, string>> = {
  ethereum: 'USDC',
  arbitrum: 'USDC',
  optimism: 'USDC',
  polygon: 'USDC',
  base: 'USDC',
  bsc: 'BUSD',         // BSC uses BUSD as primary stablecoin
  avalanche: 'USDC.e', // Avalanche uses bridged USDC
  fantom: 'USDC',
  zksync: 'USDC',
  linea: 'USDC',
  solana: 'USDC',
} as const;

/**
 * Get the default quote token for a given chain.
 * Falls back to 'USDC' if the chain is not configured.
 *
 * @param chain - The chain identifier (lowercase)
 * @returns The default quote token symbol for that chain
 */
export function getDefaultQuoteToken(chain: string): string {
  return DEFAULT_QUOTE_TOKENS[chain.toLowerCase()] || 'USDC';
}
