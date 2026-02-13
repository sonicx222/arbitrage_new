/**
 * PairInitializationService Tests
 *
 * Tests for the extracted pair initialization module.
 * Verifies pair discovery and caching functionality.
 */

import {
  initializePairs,
  resolvePairAddress,
  createTokenPairKey,
  buildFullPairKey,
} from '../../../src/detector/pair-initialization-service';
import type { Dex, Token } from '../../../../types/src';
import type { ServiceLogger } from '../../../src/logging';

describe('PairInitializationService', () => {
  const mockLogger: ServiceLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  const mockDexes: Dex[] = [
    {
      name: 'uniswap_v2',
      chain: 'ethereum',
      factoryAddress: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
      routerAddress: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
      feeBps: 30 as any, // 0.30%
      fee: 30,
    },
    {
      name: 'sushiswap',
      chain: 'ethereum',
      factoryAddress: '0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac',
      routerAddress: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',
      feeBps: 30 as any,
      fee: 30,
    },
  ];

  const mockTokens: Token[] = [
    { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', decimals: 18, chainId: 1 },
    { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6, chainId: 1 },
    { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', decimals: 6, chainId: 1 },
  ];

  const mockPairDiscoveryService = {
    discoverPair: jest.fn(),
    incrementCacheHits: jest.fn(),
    getStats: jest.fn(),
  };

  const mockPairCacheService = {
    get: jest.fn(),
    set: jest.fn(),
    setNull: jest.fn(),
    getStats: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('initializePairs', () => {
    it('should discover pairs from all DEX/token combinations', async () => {
      // Mock cache miss, then discovery success
      mockPairCacheService.get.mockResolvedValue({ status: 'miss' });
      mockPairDiscoveryService.discoverPair.mockResolvedValue({
        address: '0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852',
        token0: mockTokens[0].address,
        token1: mockTokens[1].address,
        discoveredAt: Date.now(),
        discoveryMethod: 'factory',
      });
      mockPairCacheService.set.mockResolvedValue(undefined);

      const result = await initializePairs({
        chain: 'ethereum',
        logger: mockLogger,
        dexes: mockDexes,
        tokens: mockTokens,
        pairDiscoveryService: mockPairDiscoveryService as any,
        pairCacheService: mockPairCacheService as any,
      });

      // Should discover pairs for each DEX/token combination
      // 2 DEXs * 3 token pairs (WETH/USDC, WETH/USDT, USDC/USDT) = 6 pairs
      expect(result.pairsDiscovered).toBe(6);
      expect(result.pairsFailed).toBe(0);
      expect(result.pairs).toHaveLength(6);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      // Verify logger was called
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Initializing'),
        expect.any(Object)
      );
    });

    it('should handle discovery failures gracefully', async () => {
      // Note: resolvePairAddress catches errors internally and logs them,
      // so failures don't bubble up to initializePairs - they result in null addresses
      mockPairCacheService.get.mockResolvedValue({ status: 'miss' });
      mockPairDiscoveryService.discoverPair.mockRejectedValue(new Error('Discovery failed'));

      const result = await initializePairs({
        chain: 'ethereum',
        logger: mockLogger,
        dexes: [mockDexes[0]],
        tokens: mockTokens.slice(0, 2), // Just WETH/USDC
        pairDiscoveryService: mockPairDiscoveryService as any,
        pairCacheService: mockPairCacheService as any,
      });

      // Discovery errors are caught by resolvePairAddress, which returns null
      // This means no pairs are discovered, but no failures are counted either
      expect(result.pairsDiscovered).toBe(0);
      expect(result.pairsFailed).toBe(0); // Errors caught internally, not bubbled up
      // Error was logged by resolvePairAddress
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Error getting pair address'),
        expect.any(Object)
      );
    });

    it('should work without optional services', async () => {
      const result = await initializePairs({
        chain: 'ethereum',
        logger: mockLogger,
        dexes: mockDexes,
        tokens: mockTokens,
        // No pairDiscoveryService or pairCacheService
      });

      // Without services, no pairs can be discovered
      expect(result.pairsDiscovered).toBe(0);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should skip pairs that return zero address', async () => {
      mockPairCacheService.get.mockResolvedValue({ status: 'miss' });
      mockPairDiscoveryService.discoverPair.mockResolvedValue(null); // Pair doesn't exist

      const result = await initializePairs({
        chain: 'ethereum',
        logger: mockLogger,
        dexes: [mockDexes[0]],
        tokens: mockTokens.slice(0, 2),
        pairDiscoveryService: mockPairDiscoveryService as any,
        pairCacheService: mockPairCacheService as any,
      });

      expect(result.pairsDiscovered).toBe(0);
      expect(result.pairsFailed).toBe(0); // Not a failure, just no pair
    });

    it('should include correct pair data in results', async () => {
      const mockPairAddress = '0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852';
      mockPairCacheService.get.mockResolvedValue({ status: 'miss' });
      mockPairDiscoveryService.discoverPair.mockResolvedValue({
        address: mockPairAddress,
        token0: mockTokens[0].address,
        token1: mockTokens[1].address,
        discoveredAt: Date.now(),
        discoveryMethod: 'factory',
      });
      mockPairCacheService.set.mockResolvedValue(undefined);

      const result = await initializePairs({
        chain: 'ethereum',
        logger: mockLogger,
        dexes: [mockDexes[0]],
        tokens: mockTokens.slice(0, 2), // Just WETH/USDC
        pairDiscoveryService: mockPairDiscoveryService as any,
        pairCacheService: mockPairCacheService as any,
      });

      expect(result.pairs).toHaveLength(1);
      const pair = result.pairs[0];
      expect(pair.pairKey).toBe('uniswap_v2_WETH/USDC');
      expect(pair.pair.address).toBe(mockPairAddress);
      expect(pair.pair.token0).toBe(mockTokens[0].address);
      expect(pair.pair.token1).toBe(mockTokens[1].address);
      expect(pair.pair.dex).toBe('uniswap_v2');
      expect(pair.pair.fee).toBe(0.003); // 30 basis points converted to percentage
    });
  });

  describe('resolvePairAddress', () => {
    it('should return cached address on cache hit', async () => {
      const cachedAddress = '0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852';
      mockPairCacheService.get.mockResolvedValue({
        status: 'hit',
        data: { address: cachedAddress },
      });

      const result = await resolvePairAddress(
        'ethereum',
        mockDexes[0],
        mockTokens[0],
        mockTokens[1],
        mockPairDiscoveryService as any,
        mockPairCacheService as any,
        mockLogger
      );

      expect(result).toBe(cachedAddress);
      expect(mockPairDiscoveryService.incrementCacheHits).toHaveBeenCalled();
      expect(mockPairDiscoveryService.discoverPair).not.toHaveBeenCalled();
    });

    it('should return null on cached null result', async () => {
      mockPairCacheService.get.mockResolvedValue({ status: 'null' });

      const result = await resolvePairAddress(
        'ethereum',
        mockDexes[0],
        mockTokens[0],
        mockTokens[1],
        mockPairDiscoveryService as any,
        mockPairCacheService as any,
        mockLogger
      );

      expect(result).toBeNull();
      expect(mockPairDiscoveryService.discoverPair).not.toHaveBeenCalled();
    });

    it('should discover and cache pair on cache miss', async () => {
      const discoveredAddress = '0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852';
      mockPairCacheService.get.mockResolvedValue({ status: 'miss' });
      mockPairDiscoveryService.discoverPair.mockResolvedValue({
        address: discoveredAddress,
        token0: mockTokens[0].address,
        token1: mockTokens[1].address,
        discoveredAt: Date.now(),
        discoveryMethod: 'factory',
      });
      mockPairCacheService.set.mockResolvedValue(undefined);

      const result = await resolvePairAddress(
        'ethereum',
        mockDexes[0],
        mockTokens[0],
        mockTokens[1],
        mockPairDiscoveryService as any,
        mockPairCacheService as any,
        mockLogger
      );

      expect(result).toBe(discoveredAddress);
      expect(mockPairDiscoveryService.discoverPair).toHaveBeenCalled();
      expect(mockPairCacheService.set).toHaveBeenCalledWith(
        'ethereum',
        'uniswap_v2',
        mockTokens[0].address,
        mockTokens[1].address,
        expect.objectContaining({ address: discoveredAddress })
      );
    });

    it('should cache null when pair not found', async () => {
      mockPairCacheService.get.mockResolvedValue({ status: 'miss' });
      mockPairDiscoveryService.discoverPair.mockResolvedValue(null);

      const result = await resolvePairAddress(
        'ethereum',
        mockDexes[0],
        mockTokens[0],
        mockTokens[1],
        mockPairDiscoveryService as any,
        mockPairCacheService as any,
        mockLogger
      );

      expect(result).toBeNull();
      expect(mockPairCacheService.setNull).toHaveBeenCalledWith(
        'ethereum',
        'uniswap_v2',
        mockTokens[0].address,
        mockTokens[1].address
      );
    });

    it('should handle errors gracefully', async () => {
      mockPairCacheService.get.mockRejectedValue(new Error('Cache error'));

      const result = await resolvePairAddress(
        'ethereum',
        mockDexes[0],
        mockTokens[0],
        mockTokens[1],
        mockPairDiscoveryService as any,
        mockPairCacheService as any,
        mockLogger
      );

      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Error getting pair address'),
        expect.any(Object)
      );
    });

    it('should work without cache service', async () => {
      const discoveredAddress = '0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852';
      mockPairDiscoveryService.discoverPair.mockResolvedValue({
        address: discoveredAddress,
        token0: mockTokens[0].address,
        token1: mockTokens[1].address,
        discoveredAt: Date.now(),
        discoveryMethod: 'factory',
      });

      const result = await resolvePairAddress(
        'ethereum',
        mockDexes[0],
        mockTokens[0],
        mockTokens[1],
        mockPairDiscoveryService as any,
        null, // No cache service
        mockLogger
      );

      expect(result).toBe(discoveredAddress);
    });

    it('should work without discovery service', async () => {
      const result = await resolvePairAddress(
        'ethereum',
        mockDexes[0],
        mockTokens[0],
        mockTokens[1],
        null, // No discovery service
        null, // No cache service
        mockLogger
      );

      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Pair services not initialized, returning null',
        expect.any(Object)
      );
    });
  });

  describe('createTokenPairKey', () => {
    it('should create normalized key with tokens in alphabetical order', () => {
      const key1 = createTokenPairKey(
        '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
      );
      const key2 = createTokenPairKey(
        '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
      );

      // Keys should be the same regardless of order
      expect(key1).toBe(key2);
    });

    it('should lowercase addresses', () => {
      const key = createTokenPairKey(
        '0xA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48', // uppercase
        '0xC02AAA39B223FE8D0A0E5C4F27EAD9083C756CC2'  // uppercase
      );

      expect(key).not.toContain('A');
      expect(key).not.toContain('B');
      expect(key).toContain('0x');
    });
  });

  describe('buildFullPairKey', () => {
    it('should combine DEX name and pair name', () => {
      const key = buildFullPairKey('uniswap_v2', 'WETH/USDC');
      expect(key).toBe('uniswap_v2_WETH/USDC');
    });
  });
});
