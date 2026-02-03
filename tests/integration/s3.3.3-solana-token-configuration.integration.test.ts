/**
 * S3.3.3 Solana Token Configuration Integration Tests
 *
 * TDD tests for Solana token configurations (15 tokens):
 * - Anchor tokens: SOL, USDC, USDT
 * - Core DeFi: JUP, RAY, ORCA
 * - High-volume meme: BONK, WIF
 * - Governance/Utility: JTO, PYTH, W, MNDE
 * - Liquid Staking: mSOL, jitoSOL, BSOL
 *
 * @see IMPLEMENTATION_PLAN.md S3.3.3
 */

import { describe, it, expect, beforeAll } from '@jest/globals';

// Import config directly
import {
  CHAINS,
  CORE_TOKENS,
  TOKEN_METADATA
} from '@arbitrage/config';

// =============================================================================
// S3.3.3 Expected Token Configuration
// =============================================================================

/**
 * Expected Solana token addresses from implementation plan.
 * All addresses are base58-encoded Solana mint addresses.
 */
const EXPECTED_TOKENS = {
  // Anchor tokens - Essential for all trading
  SOL: {
    address: 'So11111111111111111111111111111111111111112',
    symbol: 'SOL',
    decimals: 9,
    category: 'anchor'
  },
  USDC: {
    address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    symbol: 'USDC',
    decimals: 6,
    category: 'stablecoin'
  },
  USDT: {
    address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    symbol: 'USDT',
    decimals: 6,
    category: 'stablecoin'
  },

  // Core DeFi - DEX governance tokens
  JUP: {
    address: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    symbol: 'JUP',
    decimals: 6,
    category: 'defi'
  },
  RAY: {
    address: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
    symbol: 'RAY',
    decimals: 6,
    category: 'defi'
  },
  ORCA: {
    address: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',
    symbol: 'ORCA',
    decimals: 6,
    category: 'defi'
  },

  // High-volume meme tokens
  BONK: {
    address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    symbol: 'BONK',
    decimals: 5,
    category: 'meme'
  },
  WIF: {
    address: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    symbol: 'WIF',
    decimals: 6,
    category: 'meme'
  },

  // Governance/Utility tokens
  JTO: {
    address: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',
    symbol: 'JTO',
    decimals: 9,
    category: 'governance'
  },
  PYTH: {
    address: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
    symbol: 'PYTH',
    decimals: 6,
    category: 'governance'
  },
  W: {
    address: '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ',
    symbol: 'W',
    decimals: 6,
    category: 'governance'
  },
  MNDE: {
    address: 'MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey',
    symbol: 'MNDE',
    decimals: 9,
    category: 'governance'
  },

  // Liquid Staking Tokens (LSTs)
  mSOL: {
    address: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
    symbol: 'mSOL',
    decimals: 9,
    category: 'lst'
  },
  jitoSOL: {
    address: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
    symbol: 'jitoSOL',
    decimals: 9,
    category: 'lst'
  },
  BSOL: {
    address: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',
    symbol: 'BSOL',
    decimals: 9,
    category: 'lst'
  }
} as const;

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
 * Validates that an address is not an EVM hex address
 */
function isNotEvmAddress(address: string): boolean {
  return !address.startsWith('0x');
}

/**
 * Get token from config by symbol
 */
function getTokenBySymbol(symbol: string): { address: string; symbol: string; decimals: number; chainId: number } | undefined {
  return CORE_TOKENS.solana?.find(t => t.symbol === symbol);
}

// =============================================================================
// S3.3.3.1: Token Count and Basic Structure Tests
// =============================================================================

describe('S3.3.3.1: Solana Token Count and Basic Structure', () => {
  let solanaTokens: Array<{ address: string; symbol: string; decimals: number; chainId: number }>;

  beforeAll(() => {
    solanaTokens = CORE_TOKENS.solana || [];
  });

  it('should have Solana tokens configured', () => {
    expect(CORE_TOKENS.solana).toBeDefined();
    expect(Array.isArray(CORE_TOKENS.solana)).toBe(true);
  });

  it('should have at least 15 Solana tokens configured', () => {
    expect(solanaTokens.length).toBeGreaterThanOrEqual(15);
  });

  it('should have all tokens with required fields', () => {
    for (const token of solanaTokens) {
      expect(token.address).toBeDefined();
      expect(token.symbol).toBeDefined();
      expect(token.decimals).toBeDefined();
      expect(token.chainId).toBeDefined();
    }
  });

  it('should have all tokens with Solana chain ID (101)', () => {
    for (const token of solanaTokens) {
      expect(token.chainId).toBe(101);
    }
  });

  it('should have all tokens with valid Solana addresses', () => {
    for (const token of solanaTokens) {
      expect(isValidSolanaAddress(token.address)).toBe(true);
      expect(isNotEvmAddress(token.address)).toBe(true);
    }
  });

  it('should have unique token addresses', () => {
    const addresses = solanaTokens.map(t => t.address);
    const uniqueAddresses = new Set(addresses);
    expect(uniqueAddresses.size).toBe(addresses.length);
  });

  it('should have unique token symbols', () => {
    const symbols = solanaTokens.map(t => t.symbol);
    const uniqueSymbols = new Set(symbols);
    expect(uniqueSymbols.size).toBe(symbols.length);
  });
});

// =============================================================================
// S3.3.3.2: Anchor Token Tests (SOL, USDC, USDT)
// =============================================================================

describe('S3.3.3.2: Anchor Tokens (SOL, USDC, USDT)', () => {
  it('should have SOL (native) token configured', () => {
    const sol = getTokenBySymbol('SOL');
    expect(sol).toBeDefined();
    expect(sol!.address).toBe(EXPECTED_TOKENS.SOL.address);
    expect(sol!.decimals).toBe(9); // SOL has 9 decimals
  });

  it('should have USDC stablecoin configured', () => {
    const usdc = getTokenBySymbol('USDC');
    expect(usdc).toBeDefined();
    expect(usdc!.address).toBe(EXPECTED_TOKENS.USDC.address);
    expect(usdc!.decimals).toBe(6); // USDC has 6 decimals
  });

  it('should have USDT stablecoin configured', () => {
    const usdt = getTokenBySymbol('USDT');
    expect(usdt).toBeDefined();
    expect(usdt!.address).toBe(EXPECTED_TOKENS.USDT.address);
    expect(usdt!.decimals).toBe(6); // USDT has 6 decimals
  });

  it('should have SOL address matching wrapped SOL program', () => {
    const sol = getTokenBySymbol('SOL');
    // The native SOL wrapper uses a special program-derived address
    expect(sol!.address).toBe('So11111111111111111111111111111111111111112');
  });
});

// =============================================================================
// S3.3.3.3: Core DeFi Token Tests (JUP, RAY, ORCA)
// =============================================================================

describe('S3.3.3.3: Core DeFi Tokens (JUP, RAY, ORCA)', () => {
  it('should have JUP (Jupiter) token configured', () => {
    const jup = getTokenBySymbol('JUP');
    expect(jup).toBeDefined();
    expect(jup!.address).toBe(EXPECTED_TOKENS.JUP.address);
    expect(jup!.decimals).toBe(6);
  });

  it('should have RAY (Raydium) token configured', () => {
    const ray = getTokenBySymbol('RAY');
    expect(ray).toBeDefined();
    expect(ray!.address).toBe(EXPECTED_TOKENS.RAY.address);
    expect(ray!.decimals).toBe(6);
  });

  it('should have ORCA token configured', () => {
    const orca = getTokenBySymbol('ORCA');
    expect(orca).toBeDefined();
    expect(orca!.address).toBe(EXPECTED_TOKENS.ORCA.address);
    expect(orca!.decimals).toBe(6);
  });
});

// =============================================================================
// S3.3.3.4: Meme Token Tests (BONK, WIF)
// =============================================================================

describe('S3.3.3.4: Meme Tokens (BONK, WIF)', () => {
  it('should have BONK token configured', () => {
    const bonk = getTokenBySymbol('BONK');
    expect(bonk).toBeDefined();
    expect(bonk!.address).toBe(EXPECTED_TOKENS.BONK.address);
    expect(bonk!.decimals).toBe(5); // BONK has 5 decimals
  });

  it('should have WIF (dogwifhat) token configured', () => {
    const wif = getTokenBySymbol('WIF');
    expect(wif).toBeDefined();
    expect(wif!.address).toBe(EXPECTED_TOKENS.WIF.address);
    expect(wif!.decimals).toBe(6);
  });
});

// =============================================================================
// S3.3.3.5: Governance/Utility Token Tests (JTO, PYTH, W, MNDE)
// =============================================================================

describe('S3.3.3.5: Governance/Utility Tokens (JTO, PYTH, W, MNDE)', () => {
  it('should have JTO (Jito) token configured', () => {
    const jto = getTokenBySymbol('JTO');
    expect(jto).toBeDefined();
    expect(jto!.address).toBe(EXPECTED_TOKENS.JTO.address);
    expect(jto!.decimals).toBe(9);
  });

  it('should have PYTH (Pyth Network) token configured', () => {
    const pyth = getTokenBySymbol('PYTH');
    expect(pyth).toBeDefined();
    expect(pyth!.address).toBe(EXPECTED_TOKENS.PYTH.address);
    expect(pyth!.decimals).toBe(6);
  });

  it('should have W (Wormhole) token configured', () => {
    const w = getTokenBySymbol('W');
    expect(w).toBeDefined();
    expect(w!.address).toBe(EXPECTED_TOKENS.W.address);
    expect(w!.decimals).toBe(6);
  });

  it('should have MNDE (Marinade) token configured', () => {
    const mnde = getTokenBySymbol('MNDE');
    expect(mnde).toBeDefined();
    expect(mnde!.address).toBe(EXPECTED_TOKENS.MNDE.address);
    expect(mnde!.decimals).toBe(9);
  });
});

// =============================================================================
// S3.3.3.6: Liquid Staking Token Tests (mSOL, jitoSOL, BSOL)
// =============================================================================

describe('S3.3.3.6: Liquid Staking Tokens (mSOL, jitoSOL, BSOL)', () => {
  it('should have mSOL (Marinade staked SOL) token configured', () => {
    const msol = getTokenBySymbol('mSOL');
    expect(msol).toBeDefined();
    expect(msol!.address).toBe(EXPECTED_TOKENS.mSOL.address);
    expect(msol!.decimals).toBe(9); // Same as SOL
  });

  it('should have jitoSOL (Jito staked SOL) token configured', () => {
    const jitoSol = getTokenBySymbol('jitoSOL');
    expect(jitoSol).toBeDefined();
    expect(jitoSol!.address).toBe(EXPECTED_TOKENS.jitoSOL.address);
    expect(jitoSol!.decimals).toBe(9); // Same as SOL
  });

  it('should have BSOL (BlazeStake staked SOL) token configured', () => {
    const bsol = getTokenBySymbol('BSOL');
    expect(bsol).toBeDefined();
    expect(bsol!.address).toBe(EXPECTED_TOKENS.BSOL.address);
    expect(bsol!.decimals).toBe(9); // Same as SOL
  });

  it('should have all LST tokens with 9 decimals (matching SOL)', () => {
    const lstTokens = ['mSOL', 'jitoSOL', 'BSOL'];
    for (const symbol of lstTokens) {
      const token = getTokenBySymbol(symbol);
      expect(token).toBeDefined();
      expect(token!.decimals).toBe(9);
    }
  });
});

// =============================================================================
// S3.3.3.7: Token Decimal Validation Tests
// =============================================================================

describe('S3.3.3.7: Token Decimal Validation', () => {
  it('should have valid decimal values for all tokens', () => {
    const solanaTokens = CORE_TOKENS.solana || [];
    for (const token of solanaTokens) {
      expect(token.decimals).toBeGreaterThanOrEqual(0);
      expect(token.decimals).toBeLessThanOrEqual(18);
      expect(Number.isInteger(token.decimals)).toBe(true);
    }
  });

  it('should have stablecoins with 6 decimals', () => {
    const stablecoins = ['USDC', 'USDT'];
    for (const symbol of stablecoins) {
      const token = getTokenBySymbol(symbol);
      expect(token).toBeDefined();
      expect(token!.decimals).toBe(6);
    }
  });

  it('should have SOL-based tokens with 9 decimals', () => {
    const solBasedTokens = ['SOL', 'mSOL', 'jitoSOL', 'BSOL', 'JTO', 'MNDE'];
    for (const symbol of solBasedTokens) {
      const token = getTokenBySymbol(symbol);
      expect(token).toBeDefined();
      expect(token!.decimals).toBe(9);
    }
  });

  it('should have BONK with 5 decimals (unique)', () => {
    const bonk = getTokenBySymbol('BONK');
    expect(bonk).toBeDefined();
    expect(bonk!.decimals).toBe(5);
  });
});

// =============================================================================
// S3.3.3.8: Token Metadata Integration Tests
// =============================================================================

describe('S3.3.3.8: Token Metadata Integration', () => {
  it('should have Solana in TOKEN_METADATA', () => {
    expect(TOKEN_METADATA.solana).toBeDefined();
  });

  it('should have weth pointing to wrapped SOL', () => {
    expect(TOKEN_METADATA.solana.weth).toBe('So11111111111111111111111111111111111111112');
  });

  it('should have nativeWrapper pointing to wrapped SOL', () => {
    expect(TOKEN_METADATA.solana.nativeWrapper).toBe('So11111111111111111111111111111111111111112');
  });

  it('should have stablecoins array with USDC', () => {
    const usdc = TOKEN_METADATA.solana.stablecoins.find(s => s.symbol === 'USDC');
    expect(usdc).toBeDefined();
    expect(usdc!.address).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(usdc!.decimals).toBe(6);
  });

  it('should have stablecoins array with USDT', () => {
    const usdt = TOKEN_METADATA.solana.stablecoins.find(s => s.symbol === 'USDT');
    expect(usdt).toBeDefined();
    expect(usdt!.address).toBe('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');
    expect(usdt!.decimals).toBe(6);
  });

  it('should have at least 2 stablecoins configured', () => {
    expect(TOKEN_METADATA.solana.stablecoins.length).toBeGreaterThanOrEqual(2);
  });
});

// =============================================================================
// S3.3.3.9: Chain Integration Tests
// =============================================================================

describe('S3.3.3.9: Chain Integration', () => {
  it('should have Solana chain configured', () => {
    expect(CHAINS.solana).toBeDefined();
  });

  it('should have Solana marked as non-EVM', () => {
    expect(CHAINS.solana.isEVM).toBe(false);
  });

  it('should have Solana chain ID matching token chain IDs', () => {
    const solanaTokens = CORE_TOKENS.solana || [];
    for (const token of solanaTokens) {
      expect(token.chainId).toBe(CHAINS.solana.id);
    }
  });

  it('should have native token as SOL', () => {
    expect(CHAINS.solana.nativeToken).toBe('SOL');
  });
});

// =============================================================================
// S3.3.3.10: Regression Tests
// =============================================================================

describe('S3.3.3.10: Regression Tests', () => {
  it('should maintain at least 15 Solana tokens after any config changes', () => {
    const solanaTokens = CORE_TOKENS.solana || [];
    expect(solanaTokens.length).toBeGreaterThanOrEqual(15);
  });

  it('should maintain anchor tokens (SOL, USDC, USDT)', () => {
    const anchorSymbols = ['SOL', 'USDC', 'USDT'];
    for (const symbol of anchorSymbols) {
      const token = getTokenBySymbol(symbol);
      expect(token).toBeDefined();
    }
  });

  it('should maintain DEX governance tokens (JUP, RAY, ORCA)', () => {
    const dexSymbols = ['JUP', 'RAY', 'ORCA'];
    for (const symbol of dexSymbols) {
      const token = getTokenBySymbol(symbol);
      expect(token).toBeDefined();
    }
  });

  it('should maintain liquid staking tokens (mSOL, jitoSOL, BSOL)', () => {
    const lstSymbols = ['mSOL', 'jitoSOL', 'BSOL'];
    for (const symbol of lstSymbols) {
      const token = getTokenBySymbol(symbol);
      expect(token).toBeDefined();
    }
  });

  it('should not regress to EVM-style addresses', () => {
    const solanaTokens = CORE_TOKENS.solana || [];
    for (const token of solanaTokens) {
      expect(token.address.startsWith('0x')).toBe(false);
    }
  });

  it('should have all expected token symbols', () => {
    const expectedSymbols = [
      'SOL', 'USDC', 'USDT',
      'JUP', 'RAY', 'ORCA',
      'BONK', 'WIF',
      'JTO', 'PYTH', 'W', 'MNDE',
      'mSOL', 'jitoSOL', 'BSOL'
    ];

    for (const symbol of expectedSymbols) {
      const token = getTokenBySymbol(symbol);
      expect(token).toBeDefined();
    }
  });
});

// =============================================================================
// S3.3.3.11: Arbitrage Pair Potential Tests
// =============================================================================

describe('S3.3.3.11: Arbitrage Pair Potential', () => {
  it('should have tokens that can form SOL/stablecoin pairs', () => {
    const sol = getTokenBySymbol('SOL');
    const usdc = getTokenBySymbol('USDC');
    const usdt = getTokenBySymbol('USDT');

    expect(sol).toBeDefined();
    expect(usdc).toBeDefined();
    expect(usdt).toBeDefined();
  });

  it('should have tokens for LST arbitrage (SOL vs mSOL vs jitoSOL)', () => {
    const sol = getTokenBySymbol('SOL');
    const msol = getTokenBySymbol('mSOL');
    const jitoSol = getTokenBySymbol('jitoSOL');
    const bsol = getTokenBySymbol('BSOL');

    expect(sol).toBeDefined();
    expect(msol).toBeDefined();
    expect(jitoSol).toBeDefined();
    expect(bsol).toBeDefined();
  });

  it('should have high-volume meme tokens for volatility arbitrage', () => {
    const bonk = getTokenBySymbol('BONK');
    const wif = getTokenBySymbol('WIF');

    expect(bonk).toBeDefined();
    expect(wif).toBeDefined();
  });

  it('should have at least 100 potential pairs with 15 tokens', () => {
    const solanaTokens = CORE_TOKENS.solana || [];
    const tokenCount = solanaTokens.length;
    // n*(n-1)/2 pairs for n tokens
    const potentialPairs = (tokenCount * (tokenCount - 1)) / 2;
    expect(potentialPairs).toBeGreaterThanOrEqual(105); // 15*14/2 = 105
  });
});

// =============================================================================
// S3.3.3.12: Summary Statistics Tests
// =============================================================================

describe('S3.3.3.12: Summary Statistics', () => {
  it('should report correct total Solana token count', () => {
    const solanaTokens = CORE_TOKENS.solana || [];
     
    console.log(`Total Solana tokens configured: ${solanaTokens.length}`);
    expect(solanaTokens.length).toBeGreaterThanOrEqual(15);
  });

  it('should report token category distribution', () => {
    const solanaTokens = CORE_TOKENS.solana || [];
    const categories: Record<string, number> = {
      anchor: 0,    // SOL
      stablecoin: 0, // USDC, USDT
      defi: 0,       // JUP, RAY, ORCA
      meme: 0,       // BONK, WIF
      governance: 0, // JTO, PYTH, W, MNDE
      lst: 0         // mSOL, jitoSOL, BSOL
    };

    for (const token of solanaTokens) {
      if (token.symbol === 'SOL') categories.anchor++;
      else if (['USDC', 'USDT'].includes(token.symbol)) categories.stablecoin++;
      else if (['JUP', 'RAY', 'ORCA'].includes(token.symbol)) categories.defi++;
      else if (['BONK', 'WIF'].includes(token.symbol)) categories.meme++;
      else if (['JTO', 'PYTH', 'W', 'MNDE'].includes(token.symbol)) categories.governance++;
      else if (['mSOL', 'jitoSOL', 'BSOL'].includes(token.symbol)) categories.lst++;
    }

     
    console.log('Token category distribution:', categories);

    expect(categories.anchor).toBe(1);
    expect(categories.stablecoin).toBe(2);
    expect(categories.defi).toBe(3);
    expect(categories.meme).toBe(2);
    expect(categories.governance).toBe(4);
    expect(categories.lst).toBe(3);
  });

  it('should report decimal distribution', () => {
    const solanaTokens = CORE_TOKENS.solana || [];
    const decimals: Record<number, number> = {};

    for (const token of solanaTokens) {
      decimals[token.decimals] = (decimals[token.decimals] || 0) + 1;
    }

     
    console.log('Decimal distribution:', decimals);

    // Expected decimal distribution for 15 Solana tokens:
    // - 6 decimals (8): USDC, USDT, JUP, RAY, ORCA, PYTH, W, WIF
    // - 9 decimals (6): SOL, mSOL, jitoSOL, BSOL, JTO, MNDE
    // - 5 decimals (1): BONK
    expect(decimals[6]).toBe(8);
    expect(decimals[9]).toBe(6);
    expect(decimals[5]).toBe(1);
  });
});
