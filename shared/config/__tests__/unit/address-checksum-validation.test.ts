/**
 * Address Checksum Validation Tests (Fix #40)
 *
 * Build-time validation that all addresses in addresses.ts are properly formatted.
 * Catches misconfiguration (invalid addresses, wrong format, copy-paste errors)
 * before runtime.
 *
 * @see shared/config/src/addresses.ts
 */

import { describe, it, expect } from '@jest/globals';
import {
  AAVE_V3_POOLS,
  NATIVE_TOKENS,
  STABLECOINS,
  DEX_ROUTERS,
  BRIDGE_CONTRACTS,
  COMMIT_REVEAL_CONTRACTS,
  SOLANA_PROGRAMS,
  isValidEthereumAddress,
  isValidSolanaAddress,
} from '../../src/addresses';

// =============================================================================
// Validation Helper Tests
// =============================================================================

describe('Address validation helpers', () => {
  describe('isValidEthereumAddress', () => {
    it('should accept valid ethereum addresses', () => {
      expect(isValidEthereumAddress('0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2')).toBe(true);
      expect(isValidEthereumAddress('0x0000000000000000000000000000000000000000')).toBe(true);
    });

    it('should reject invalid ethereum addresses', () => {
      expect(isValidEthereumAddress('')).toBe(false);
      expect(isValidEthereumAddress('0x123')).toBe(false);
      expect(isValidEthereumAddress('not-an-address')).toBe(false);
      expect(isValidEthereumAddress('0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG')).toBe(false);
    });
  });

  describe('isValidSolanaAddress', () => {
    it('should accept valid solana addresses', () => {
      expect(isValidSolanaAddress('So11111111111111111111111111111111111111112')).toBe(true);
      expect(isValidSolanaAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(true);
    });

    it('should reject invalid solana addresses', () => {
      expect(isValidSolanaAddress('')).toBe(false);
      expect(isValidSolanaAddress('short')).toBe(false);
      expect(isValidSolanaAddress('0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2')).toBe(false);
    });
  });
});

// =============================================================================
// AAVE_V3_POOLS
// =============================================================================

describe('AAVE_V3_POOLS address validation', () => {
  it('should have all pool addresses as valid ethereum addresses', () => {
    for (const [chain, address] of Object.entries(AAVE_V3_POOLS)) {
      expect(isValidEthereumAddress(address)).toBe(true);
    }
  });

  it('should have addresses with 0x prefix and 42 characters', () => {
    for (const address of Object.values(AAVE_V3_POOLS)) {
      expect(address).toMatch(/^0x/);
      expect(address).toHaveLength(42);
    }
  });
});

// =============================================================================
// NATIVE_TOKENS
// =============================================================================

describe('NATIVE_TOKENS address validation', () => {
  const evmChains = [
    'ethereum', 'polygon', 'arbitrum', 'base', 'optimism',
    'bsc', 'avalanche', 'fantom', 'zksync', 'linea',
    'sepolia', 'arbitrumSepolia',
  ];

  it('should have valid ethereum addresses for all EVM chains', () => {
    for (const chain of evmChains) {
      const address = NATIVE_TOKENS[chain];
      if (address) {
        expect(isValidEthereumAddress(address)).toBe(true);
      }
    }
  });

  it('should have valid solana address for solana chain', () => {
    const solanaToken = NATIVE_TOKENS.solana;
    expect(solanaToken).toBeDefined();
    expect(isValidSolanaAddress(solanaToken)).toBe(true);
  });

  it('should not have empty addresses', () => {
    for (const [chain, address] of Object.entries(NATIVE_TOKENS)) {
      expect(address.length).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// STABLECOINS
// =============================================================================

describe('STABLECOINS address validation', () => {
  const evmChains = [
    'ethereum', 'polygon', 'arbitrum', 'base', 'optimism',
    'bsc', 'avalanche', 'fantom', 'zksync', 'linea',
  ];

  it('should have valid ethereum addresses for all EVM chain stablecoins', () => {
    for (const chain of evmChains) {
      const chainStablecoins = STABLECOINS[chain];
      if (chainStablecoins) {
        for (const [symbol, address] of Object.entries(chainStablecoins)) {
          expect(isValidEthereumAddress(address)).toBe(true);
        }
      }
    }
  });

  it('should have valid solana addresses for solana stablecoins', () => {
    const solanaStables = STABLECOINS.solana;
    if (solanaStables) {
      for (const [symbol, address] of Object.entries(solanaStables)) {
        expect(isValidSolanaAddress(address)).toBe(true);
      }
    }
  });

  it('should not have empty stablecoin addresses', () => {
    for (const [chain, stablecoins] of Object.entries(STABLECOINS)) {
      for (const [symbol, address] of Object.entries(stablecoins)) {
        expect(address.length).toBeGreaterThan(0);
      }
    }
  });
});

// =============================================================================
// DEX_ROUTERS
// =============================================================================

describe('DEX_ROUTERS address validation', () => {
  it('should have valid ethereum addresses for all router entries', () => {
    for (const [chain, routers] of Object.entries(DEX_ROUTERS)) {
      for (const [dex, address] of Object.entries(routers)) {
        expect(isValidEthereumAddress(address)).toBe(true);
      }
    }
  });

  it('should have addresses with 0x prefix and 42 characters', () => {
    for (const routers of Object.values(DEX_ROUTERS)) {
      for (const address of Object.values(routers)) {
        expect(address).toMatch(/^0x/);
        expect(address).toHaveLength(42);
      }
    }
  });
});

// =============================================================================
// BRIDGE_CONTRACTS
// =============================================================================

describe('BRIDGE_CONTRACTS address validation', () => {
  it('should have valid addresses for all bridge entries', () => {
    for (const [bridge, contracts] of Object.entries(BRIDGE_CONTRACTS)) {
      for (const [chain, address] of Object.entries(contracts)) {
        if (chain === 'solana') {
          expect(isValidSolanaAddress(address)).toBe(true);
        } else {
          expect(isValidEthereumAddress(address)).toBe(true);
        }
      }
    }
  });

  it('should not have empty bridge addresses', () => {
    for (const contracts of Object.values(BRIDGE_CONTRACTS)) {
      for (const address of Object.values(contracts)) {
        expect(address.length).toBeGreaterThan(0);
      }
    }
  });
});

// =============================================================================
// COMMIT_REVEAL_CONTRACTS
// =============================================================================

describe('COMMIT_REVEAL_CONTRACTS address validation', () => {
  it('should have valid ethereum addresses for non-empty values', () => {
    for (const [chain, address] of Object.entries(COMMIT_REVEAL_CONTRACTS)) {
      if (address && address.length > 0) {
        expect(isValidEthereumAddress(address)).toBe(true);
      }
    }
  });

  it('should allow empty strings (env vars not set)', () => {
    // COMMIT_REVEAL_CONTRACTS reads from env vars and defaults to empty string
    // This is expected behavior - contracts may not be deployed yet
    for (const address of Object.values(COMMIT_REVEAL_CONTRACTS)) {
      expect(typeof address).toBe('string');
    }
  });
});

// =============================================================================
// SOLANA_PROGRAMS
// =============================================================================

describe('SOLANA_PROGRAMS address validation', () => {
  it('should have valid solana addresses for all program IDs', () => {
    for (const [name, address] of Object.entries(SOLANA_PROGRAMS)) {
      expect(isValidSolanaAddress(address)).toBe(true);
    }
  });

  it('should not have empty program IDs', () => {
    for (const address of Object.values(SOLANA_PROGRAMS)) {
      expect(address.length).toBeGreaterThan(0);
    }
  });

  it('should have expected core programs', () => {
    expect(SOLANA_PROGRAMS.token_program).toBeDefined();
    expect(SOLANA_PROGRAMS.system_program).toBeDefined();
    expect(SOLANA_PROGRAMS.jupiter).toBeDefined();
  });
});
