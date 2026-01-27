/**
 * Token Utils Unit Tests
 *
 * Tests for token address handling utilities.
 * Critical for correct pair matching and arbitrage detection.
 */

import {
  normalizeAddress,
  addressEquals,
  isValidAddress,
  isSolanaAddress,
  getAddressChainType,
  getTokenPairKey,
  parseTokenPairKey,
  isSameTokenPair,
  isReverseOrder,
  sortTokens,
  getTokenIndex,
  isStablecoin,
  isWrappedNative,
  toChecksumAddress,
  createAddressSet,
  addressInSet,
  intersectAddresses,
  COMMON_TOKENS,
  NATIVE_TOKENS,
  WRAPPED_NATIVE_TOKENS,
} from '../../../src/components/token-utils';

describe('TokenUtils', () => {
  // ===========================================================================
  // Address Normalization
  // ===========================================================================

  describe('normalizeAddress', () => {
    it('should normalize address to lowercase', () => {
      const address = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
      expect(normalizeAddress(address)).toBe('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
    });

    it('should trim whitespace', () => {
      const address = '  0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2  ';
      expect(normalizeAddress(address)).toBe('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
    });

    it('should return empty string for null/undefined', () => {
      expect(normalizeAddress(null)).toBe('');
      expect(normalizeAddress(undefined)).toBe('');
    });

    it('should return empty string for non-string input', () => {
      expect(normalizeAddress(123 as any)).toBe('');
    });
  });

  describe('addressEquals', () => {
    const weth = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
    const wethLower = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';

    it('should return true for same address different case', () => {
      expect(addressEquals(weth, wethLower)).toBe(true);
    });

    it('should return true for identical addresses', () => {
      expect(addressEquals(weth, weth)).toBe(true);
    });

    it('should return false for different addresses', () => {
      const usdc = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
      expect(addressEquals(weth, usdc)).toBe(false);
    });

    it('should handle null/undefined', () => {
      expect(addressEquals(null, weth)).toBe(false);
      expect(addressEquals(weth, null)).toBe(false);
      expect(addressEquals(null, null)).toBe(true); // Both empty
    });
  });

  describe('isValidAddress', () => {
    it('should return true for valid EVM addresses', () => {
      expect(isValidAddress('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2')).toBe(true);
      expect(isValidAddress('0x0000000000000000000000000000000000000000')).toBe(true);
    });

    it('should return false for invalid addresses', () => {
      expect(isValidAddress('0xInvalid')).toBe(false);
      expect(isValidAddress('not_an_address')).toBe(false);
      expect(isValidAddress('0x123')).toBe(false); // Too short
      expect(isValidAddress('')).toBe(false);
      expect(isValidAddress(null)).toBe(false);
    });
  });

  describe('isSolanaAddress', () => {
    it('should return true for valid Solana addresses', () => {
      // Example Solana addresses (32-44 base58 chars)
      expect(isSolanaAddress('So11111111111111111111111111111111111111112')).toBe(true);
      expect(isSolanaAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(true);
    });

    it('should return false for EVM addresses', () => {
      expect(isSolanaAddress('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2')).toBe(false);
    });

    it('should return false for invalid addresses', () => {
      expect(isSolanaAddress('')).toBe(false);
      expect(isSolanaAddress(null)).toBe(false);
      expect(isSolanaAddress('abc')).toBe(false); // Too short
    });
  });

  describe('getAddressChainType', () => {
    it('should identify EVM addresses', () => {
      expect(getAddressChainType('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2')).toBe('evm');
    });

    it('should identify Solana addresses', () => {
      expect(getAddressChainType('So11111111111111111111111111111111111111112')).toBe('solana');
    });

    it('should return unknown for invalid addresses', () => {
      expect(getAddressChainType('invalid')).toBe('unknown');
      expect(getAddressChainType('')).toBe('unknown');
    });
  });

  // ===========================================================================
  // Token Pair Keys
  // ===========================================================================

  describe('getTokenPairKey', () => {
    const token0 = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'; // USDC
    const token1 = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'; // WETH

    it('should create consistent key regardless of order', () => {
      const key1 = getTokenPairKey(token0, token1);
      const key2 = getTokenPairKey(token1, token0);
      expect(key1).toBe(key2);
    });

    it('should create lowercase keys', () => {
      const key = getTokenPairKey(token0, token1);
      expect(key).toBe(key.toLowerCase());
    });

    it('should create key in format token0_token1 (sorted)', () => {
      const key = getTokenPairKey(token0, token1);
      expect(key).toContain('_');
      const parts = key.split('_');
      expect(parts.length).toBe(2);
      // Verify lexicographic ordering
      expect(parts[0] < parts[1]).toBe(true);
    });
  });

  describe('parseTokenPairKey', () => {
    it('should parse key into token addresses', () => {
      const token0 = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
      const token1 = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
      const key = `${token0}_${token1}`;

      const result = parseTokenPairKey(key);
      expect(result).toEqual([token0, token1]);
    });

    it('should return null for invalid key', () => {
      expect(parseTokenPairKey('invalid')).toBeNull();
      expect(parseTokenPairKey('')).toBeNull();
    });
  });

  describe('isSameTokenPair', () => {
    const token0 = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    const token1 = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

    it('should return true for same pair in same order', () => {
      expect(isSameTokenPair(token0, token1, token0.toLowerCase(), token1.toLowerCase())).toBe(true);
    });

    it('should return true for same pair in reverse order', () => {
      expect(isSameTokenPair(token0, token1, token1, token0)).toBe(true);
    });

    it('should return false for different pairs', () => {
      const token2 = '0xdAC17F958D2ee523a2206206994597C13D831ec7'; // USDT
      expect(isSameTokenPair(token0, token1, token0, token2)).toBe(false);
    });
  });

  // ===========================================================================
  // Token Ordering
  // ===========================================================================

  describe('isReverseOrder', () => {
    const token0 = '0x0000000000000000000000000000000000000001';
    const token1 = '0x0000000000000000000000000000000000000002';

    it('should return false when pair token0s match', () => {
      // isReverseOrder checks if two pairs have different token0
      expect(isReverseOrder(token0, token0)).toBe(false);
    });

    it('should return true when pair token0s differ', () => {
      // Different token0 means the pairs have reversed token order
      expect(isReverseOrder(token0, token1)).toBe(true);
    });
  });

  describe('sortTokens', () => {
    const tokenA = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    const tokenB = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

    it('should sort tokens lexicographically', () => {
      const [sorted0, sorted1] = sortTokens(tokenA, tokenB);
      expect(sorted0.toLowerCase() < sorted1.toLowerCase()).toBe(true);
    });

    it('should be idempotent', () => {
      const [sorted0, sorted1] = sortTokens(tokenA, tokenB);
      const [reSorted0, reSorted1] = sortTokens(sorted0, sorted1);
      expect(sorted0).toBe(reSorted0);
      expect(sorted1).toBe(reSorted1);
    });
  });

  describe('getTokenIndex', () => {
    const token0 = '0x0000000000000000000000000000000000000001';
    const token1 = '0x0000000000000000000000000000000000000002';

    it('should return 0 for first token', () => {
      // getTokenIndex(pairToken0, pairToken1, tokenToFind)
      expect(getTokenIndex(token0, token1, token0)).toBe(0);
    });

    it('should return 1 for second token', () => {
      expect(getTokenIndex(token0, token1, token1)).toBe(1);
    });

    it('should return -1 for unknown token', () => {
      const unknown = '0x0000000000000000000000000000000000000003';
      expect(getTokenIndex(token0, token1, unknown)).toBe(-1);
    });
  });

  // ===========================================================================
  // Token Identification
  // ===========================================================================

  describe('isStablecoin', () => {
    it('should identify USDC as stablecoin', () => {
      expect(isStablecoin('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')).toBe(true);
    });

    it('should identify USDT as stablecoin', () => {
      expect(isStablecoin('0xdAC17F958D2ee523a2206206994597C13D831ec7')).toBe(true);
    });

    it('should not identify WETH as stablecoin', () => {
      expect(isStablecoin('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2')).toBe(false);
    });
  });

  describe('isWrappedNative', () => {
    it('should identify WETH on Ethereum', () => {
      expect(isWrappedNative('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 'ethereum')).toBe(true);
    });

    it('should identify WBNB on BSC', () => {
      expect(isWrappedNative('0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', 'bsc')).toBe(true);
    });

    it('should not identify USDC as wrapped native', () => {
      expect(isWrappedNative('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'ethereum')).toBe(false);
    });
  });

  // ===========================================================================
  // Address Utilities
  // ===========================================================================

  describe('toChecksumAddress', () => {
    it('should convert to checksum format', () => {
      const address = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
      const checksum = toChecksumAddress(address);
      expect(checksum).toBe('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
    });

    it('should return original string for invalid address', () => {
      // Per implementation: returns original address if invalid
      expect(toChecksumAddress('invalid')).toBe('invalid');
    });
  });

  describe('createAddressSet', () => {
    it('should create case-insensitive set', () => {
      const addresses = [
        '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // Same, different case
        '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      ];
      const set = createAddressSet(addresses);
      expect(set.size).toBe(2); // Duplicates removed
    });
  });

  describe('addressInSet', () => {
    it('should find address regardless of case', () => {
      const set = createAddressSet(['0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2']);
      expect(addressInSet(set, '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2')).toBe(true);
    });

    it('should return false for missing address', () => {
      const set = createAddressSet(['0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2']);
      expect(addressInSet(set, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')).toBe(false);
    });
  });

  describe('intersectAddresses', () => {
    it('should return common addresses', () => {
      const set1 = ['0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'];
      const set2 = ['0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', '0xdAC17F958D2ee523a2206206994597C13D831ec7'];
      const intersection = intersectAddresses(set1, set2);
      expect(intersection.length).toBe(1);
      expect(addressEquals(intersection[0], '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2')).toBe(true);
    });
  });

  // ===========================================================================
  // Constants
  // ===========================================================================

  describe('COMMON_TOKENS', () => {
    it('should have ethereum tokens', () => {
      expect(COMMON_TOKENS).toHaveProperty('ethereum');
      expect(COMMON_TOKENS.ethereum).toHaveProperty('WETH');
      expect(COMMON_TOKENS.ethereum).toHaveProperty('USDC');
    });
  });

  describe('NATIVE_TOKENS', () => {
    it('should have native token addresses', () => {
      expect(NATIVE_TOKENS).toHaveProperty('ethereum');
    });
  });

  describe('WRAPPED_NATIVE_TOKENS', () => {
    it('should have wrapped native token addresses', () => {
      expect(WRAPPED_NATIVE_TOKENS).toHaveProperty('ethereum');
      expect(WRAPPED_NATIVE_TOKENS.ethereum.toLowerCase()).toBe(
        '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
      );
    });
  });
});
