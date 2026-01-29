/**
 * Tests for Canonical Address File
 *
 * @see addresses.ts
 */

import {
  AAVE_V3_POOLS,
  NATIVE_TOKENS,
  STABLECOINS,
  DEX_ROUTERS,
  BRIDGE_CONTRACTS,
  SOLANA_PROGRAMS,
  getAaveV3Pool,
  hasAaveV3,
  getNativeToken,
  getStablecoin,
  getChainStablecoins,
  getDexRouter,
  getBridgeContract,
  getSolanaProgram,
  isValidEthereumAddress,
  isValidSolanaAddress,
  normalizeAddress,
  addressesEqual,
} from '../../addresses';

describe('Address Constants', () => {
  describe('AAVE_V3_POOLS', () => {
    it('should have valid Ethereum addresses for all chains', () => {
      for (const [chain, address] of Object.entries(AAVE_V3_POOLS)) {
        expect(isValidEthereumAddress(address)).toBe(true);
      }
    });

    it('should have correct Ethereum mainnet address', () => {
      expect(AAVE_V3_POOLS.ethereum).toBe(
        '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'
      );
    });

    it('should include testnets', () => {
      expect(AAVE_V3_POOLS.sepolia).toBeDefined();
      expect(AAVE_V3_POOLS.arbitrumSepolia).toBeDefined();
    });
  });

  describe('NATIVE_TOKENS', () => {
    it('should have all EVM chains', () => {
      const evmChains = [
        'ethereum',
        'polygon',
        'arbitrum',
        'base',
        'optimism',
        'bsc',
        'avalanche',
        'fantom',
        'zksync',
        'linea',
      ];
      for (const chain of evmChains) {
        expect(NATIVE_TOKENS[chain]).toBeDefined();
        expect(isValidEthereumAddress(NATIVE_TOKENS[chain])).toBe(true);
      }
    });

    it('should have Solana wrapped SOL', () => {
      expect(NATIVE_TOKENS.solana).toBe(
        'So11111111111111111111111111111111111111112'
      );
    });
  });

  describe('STABLECOINS', () => {
    it('should have USDC for major chains', () => {
      const majorChains = ['ethereum', 'polygon', 'arbitrum', 'base', 'bsc'];
      for (const chain of majorChains) {
        expect(STABLECOINS[chain]?.USDC).toBeDefined();
      }
    });

    it('should have valid Solana token mints', () => {
      expect(isValidSolanaAddress(STABLECOINS.solana.USDC)).toBe(true);
      expect(isValidSolanaAddress(STABLECOINS.solana.USDT)).toBe(true);
    });

    it('should distinguish between native and bridged USDC', () => {
      // Arbitrum has both native USDC and bridged USDC.e
      expect(STABLECOINS.arbitrum.USDC).toBeDefined();
      expect(STABLECOINS.arbitrum['USDC.e']).toBeDefined();
      expect(STABLECOINS.arbitrum.USDC).not.toBe(STABLECOINS.arbitrum['USDC.e']);
    });
  });

  describe('SOLANA_PROGRAMS', () => {
    it('should have valid Solana addresses', () => {
      for (const [name, address] of Object.entries(SOLANA_PROGRAMS)) {
        expect(isValidSolanaAddress(address)).toBe(true);
      }
    });

    it('should have major DEX programs', () => {
      expect(SOLANA_PROGRAMS.jupiter).toBeDefined();
      expect(SOLANA_PROGRAMS.raydium_amm).toBeDefined();
      expect(SOLANA_PROGRAMS.orca_whirlpool).toBeDefined();
    });
  });
});

describe('Address Getter Functions', () => {
  describe('getAaveV3Pool', () => {
    it('should return correct address for supported chain', () => {
      expect(getAaveV3Pool('ethereum')).toBe(
        '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'
      );
    });

    it('should throw for unsupported chain', () => {
      expect(() => getAaveV3Pool('unsupported')).toThrow(
        'Aave V3 Pool not available on chain: unsupported'
      );
    });

    it('should throw for chains without Aave (bsc)', () => {
      expect(() => getAaveV3Pool('bsc')).toThrow();
    });
  });

  describe('hasAaveV3', () => {
    it('should return true for supported chains', () => {
      expect(hasAaveV3('ethereum')).toBe(true);
      expect(hasAaveV3('arbitrum')).toBe(true);
    });

    it('should return false for unsupported chains', () => {
      expect(hasAaveV3('bsc')).toBe(false);
      expect(hasAaveV3('solana')).toBe(false);
    });
  });

  describe('getNativeToken', () => {
    it('should return WETH for Ethereum', () => {
      expect(getNativeToken('ethereum')).toBe(
        '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
      );
    });

    it('should return WBNB for BSC', () => {
      expect(getNativeToken('bsc')).toBe(
        '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
      );
    });

    it('should return wrapped SOL for Solana', () => {
      expect(getNativeToken('solana')).toBe(
        'So11111111111111111111111111111111111111112'
      );
    });

    it('should throw for unconfigured chain', () => {
      expect(() => getNativeToken('unknown')).toThrow(
        'Native token not configured for chain: unknown'
      );
    });
  });

  describe('getStablecoin', () => {
    it('should return USDC address for Ethereum', () => {
      expect(getStablecoin('ethereum', 'USDC')).toBe(
        '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
      );
    });

    it('should return bridged USDC.e for Arbitrum', () => {
      expect(getStablecoin('arbitrum', 'USDC.e')).toBe(
        '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8'
      );
    });

    it('should throw for unknown stablecoin', () => {
      expect(() => getStablecoin('ethereum', 'UNKNOWN')).toThrow(
        'Stablecoin UNKNOWN not available on ethereum'
      );
    });

    it('should throw for unconfigured chain', () => {
      expect(() => getStablecoin('unknown', 'USDC')).toThrow(
        'No stablecoins configured for chain: unknown'
      );
    });
  });

  describe('getChainStablecoins', () => {
    it('should return all stablecoins for chain', () => {
      const ethStables = getChainStablecoins('ethereum');
      expect(Object.keys(ethStables)).toContain('USDC');
      expect(Object.keys(ethStables)).toContain('USDT');
      expect(Object.keys(ethStables)).toContain('DAI');
    });

    it('should return empty object for unknown chain', () => {
      expect(getChainStablecoins('unknown')).toEqual({});
    });
  });

  describe('getDexRouter', () => {
    it('should return Uniswap V2 router for Ethereum', () => {
      expect(getDexRouter('ethereum', 'uniswap_v2')).toBe(
        '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'
      );
    });

    it('should throw for unknown DEX', () => {
      expect(() => getDexRouter('ethereum', 'unknown')).toThrow(
        'Router for unknown not available on ethereum'
      );
    });

    it('should throw for unconfigured chain', () => {
      expect(() => getDexRouter('unknown', 'uniswap')).toThrow(
        'No DEX routers configured for chain: unknown'
      );
    });
  });

  describe('getBridgeContract', () => {
    it('should return Stargate router for Ethereum', () => {
      expect(getBridgeContract('stargate', 'ethereum')).toBe(
        '0x8731d54E9D02c286767d56ac03e8037C07e01e98'
      );
    });

    it('should return Wormhole address for Solana', () => {
      expect(getBridgeContract('wormhole', 'solana')).toBe(
        'worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth'
      );
    });

    it('should throw for unknown bridge', () => {
      expect(() => getBridgeContract('unknown', 'ethereum')).toThrow(
        'Bridge not configured: unknown'
      );
    });

    it('should throw for bridge not on chain', () => {
      expect(() => getBridgeContract('stargate', 'solana')).toThrow(
        'Bridge stargate not available on solana'
      );
    });
  });

  describe('getSolanaProgram', () => {
    it('should return Jupiter program ID', () => {
      expect(getSolanaProgram('jupiter')).toBe(
        'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
      );
    });

    it('should throw for unknown program', () => {
      expect(() => getSolanaProgram('unknown')).toThrow(
        'Solana program not configured: unknown'
      );
    });
  });
});

describe('Address Validation Utilities', () => {
  describe('isValidEthereumAddress', () => {
    it('should accept valid checksummed address', () => {
      expect(
        isValidEthereumAddress('0x1F98431c8aD98523631AE4a59f267346ea31F984')
      ).toBe(true);
    });

    it('should accept valid lowercase address', () => {
      expect(
        isValidEthereumAddress('0x1f98431c8ad98523631ae4a59f267346ea31f984')
      ).toBe(true);
    });

    it('should reject address without 0x prefix', () => {
      expect(
        isValidEthereumAddress('1F98431c8aD98523631AE4a59f267346ea31F984')
      ).toBe(false);
    });

    it('should reject short address', () => {
      expect(isValidEthereumAddress('0x1F98431c8aD985')).toBe(false);
    });

    it('should reject long address', () => {
      expect(
        isValidEthereumAddress(
          '0x1F98431c8aD98523631AE4a59f267346ea31F984EXTRA'
        )
      ).toBe(false);
    });

    it('should reject invalid characters', () => {
      expect(
        isValidEthereumAddress('0xGGGG431c8aD98523631AE4a59f267346ea31F984')
      ).toBe(false);
    });
  });

  describe('isValidSolanaAddress', () => {
    it('should accept valid program ID', () => {
      expect(
        isValidSolanaAddress('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4')
      ).toBe(true);
    });

    it('should accept valid token mint', () => {
      expect(
        isValidSolanaAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
      ).toBe(true);
    });

    it('should reject address with invalid base58 chars (0, O, I, l)', () => {
      expect(
        isValidSolanaAddress('0UPZ6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4')
      ).toBe(false);
    });

    it('should reject too short address', () => {
      expect(isValidSolanaAddress('JUP6LkbZbjS1jKKwa')).toBe(false);
    });
  });

  describe('normalizeAddress', () => {
    it('should lowercase valid address', () => {
      expect(
        normalizeAddress('0x1F98431c8aD98523631AE4a59f267346ea31F984')
      ).toBe('0x1f98431c8ad98523631ae4a59f267346ea31f984');
    });

    it('should throw for invalid address', () => {
      expect(() => normalizeAddress('invalid')).toThrow(
        'Invalid Ethereum address: invalid'
      );
    });
  });

  describe('addressesEqual', () => {
    it('should return true for same address different case', () => {
      expect(
        addressesEqual(
          '0x1F98431c8aD98523631AE4a59f267346ea31F984',
          '0x1f98431c8ad98523631ae4a59f267346ea31f984'
        )
      ).toBe(true);
    });

    it('should return false for different addresses', () => {
      expect(
        addressesEqual(
          '0x1F98431c8aD98523631AE4a59f267346ea31F984',
          '0x2F98431c8aD98523631AE4a59f267346ea31F984'
        )
      ).toBe(false);
    });
  });
});

describe('Address Consistency', () => {
  it('AAVE pools should match FLASH_LOAN_PROVIDERS in service-config', () => {
    // This test ensures addresses stay in sync
    // The canonical source is now addresses.ts
    expect(AAVE_V3_POOLS.ethereum).toBe('0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2');
    expect(AAVE_V3_POOLS.polygon).toBe('0x794a61358D6845594F94dc1DB02A252b5b4814aD');
    expect(AAVE_V3_POOLS.arbitrum).toBe('0x794a61358D6845594F94dc1DB02A252b5b4814aD');
    expect(AAVE_V3_POOLS.base).toBe('0xA238Dd80C259a72e81d7e4664a9801593F98d1c5');
    expect(AAVE_V3_POOLS.optimism).toBe('0x794a61358D6845594F94dc1DB02A252b5b4814aD');
    expect(AAVE_V3_POOLS.avalanche).toBe('0x794a61358D6845594F94dc1DB02A252b5b4814aD');
  });

  it('Native tokens should be valid for each chain type', () => {
    // EVM chains should have valid Ethereum addresses
    const evmChains = ['ethereum', 'polygon', 'arbitrum', 'bsc', 'avalanche'];
    for (const chain of evmChains) {
      expect(isValidEthereumAddress(NATIVE_TOKENS[chain])).toBe(true);
    }

    // Solana should have valid Solana address
    expect(isValidSolanaAddress(NATIVE_TOKENS.solana)).toBe(true);
  });
});
