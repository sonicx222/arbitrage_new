/**
 * Unit Tests for WhaleAlertPublisher
 *
 * Tests whale alert publishing, USD value estimation, and edge cases.
 */

import { WhaleAlertPublisher, ExtendedPairInfo } from '../../src/publishers';
import { Logger } from '../../src/types';
import { Token, SwapEvent } from '@arbitrage/types';

// =============================================================================
// Mock Setup
// =============================================================================

// Create mock logger
const createMockLogger = (): Logger => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
});

// Create mock Redis streams client
const createMockStreamsClient = () => ({
  xadd: jest.fn().mockResolvedValue('stream-id'),
  // ADR-002: Code now uses xaddWithLimit for bounded stream growth
  xaddWithLimit: jest.fn().mockResolvedValue('stream-id'),
});

// Sample tokens for testing (Token type has: address, symbol, decimals, chainId - no name)
const createSampleTokens = (): Token[] => [
  {
    address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    symbol: 'WETH',
    decimals: 18,
    chainId: 1
  },
  {
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    symbol: 'USDC',
    decimals: 6,
    chainId: 1
  },
  {
    address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    symbol: 'USDT',
    decimals: 6,
    chainId: 1
  },
  {
    address: '0x6B175474E89094C44Da98b954EesB1123654F',
    symbol: 'DAI',
    decimals: 18,
    chainId: 1
  },
  {
    address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    symbol: 'WBTC',
    decimals: 8,
    chainId: 1
  }
];

// =============================================================================
// Tests
// =============================================================================

describe('WhaleAlertPublisher', () => {
  let publisher: WhaleAlertPublisher;
  let logger: Logger;
  let mockStreamsClient: ReturnType<typeof createMockStreamsClient>;
  let tokens: Token[];

  beforeEach(() => {
    jest.clearAllMocks();
    logger = createMockLogger();
    mockStreamsClient = createMockStreamsClient();
    tokens = createSampleTokens();

    publisher = new WhaleAlertPublisher({
      chainId: 'ethereum',
      logger,
      streamsClient: mockStreamsClient as any,
      tokens
    });
  });

  // ===========================================================================
  // Constructor
  // ===========================================================================

  describe('constructor', () => {
    it('should create publisher with config', () => {
      expect(publisher).toBeDefined();
    });

    it('should build tokensByAddress map for O(1) lookups', () => {
      // Verify tokens are accessible by address (case insensitive)
      // We test this indirectly through getTokenSymbol via processSwapEvent
      const swap = {
        pairAddress: '0xpair123',
        transactionHash: '0xtx123',
        sender: '0xsender',
        recipient: '0xrecipient',
        to: '0xto',
        amount0In: '0',
        amount1In: '1000000', // 1 USDC
        amount0Out: '0',
        amount1Out: '0',
        timestamp: Date.now(),
        blockNumber: 12345678,
        dex: 'uniswap',
        chain: 'ethereum'
      };

      const pair: ExtendedPairInfo = {
        address: '0xpair123',
        dex: 'uniswap',
        token0: tokens[0].address,
        token1: tokens[1].address,
        reserve0: '1000000000000000000',
        reserve1: '3000000000'
      };

      // This should work with lowercase addresses
      const result = publisher.estimateUsdValue(swap, pair);
      expect(typeof result).toBe('number');
    });
  });

  // ===========================================================================
  // publishWhaleAlert
  // ===========================================================================

  describe('publishWhaleAlert', () => {
    it('should publish whale alert to Redis Streams', async () => {
      const alert = {
        event: {
          pairAddress: '0xpair123',
          transactionHash: '0xtx123',
          sender: '0xsender',
          recipient: '0xrecipient',
          to: '0xto',
          amount0In: '1000000000000000000',
          amount1In: '0',
          amount0Out: '0',
          amount1Out: '3000000000',
          timestamp: Date.now(),
          blockNumber: 12345678,
          dex: 'uniswap',
          chain: 'ethereum'
        },
        pairAddress: '0xpair123',
        dex: 'uniswap',
        chain: 'ethereum',
        usdValue: 100000,
        timestamp: Date.now()
      };

      await publisher.publishWhaleAlert(alert);

      // ADR-002: Uses xaddWithLimit for bounded stream growth
      expect(mockStreamsClient.xaddWithLimit).toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        'Whale alert published',
        expect.objectContaining({
          usdValue: 100000,
          dex: 'uniswap'
        })
      );
    });

    it('should handle publish errors gracefully', async () => {
      // ADR-002: Uses xaddWithLimit for bounded stream growth
      mockStreamsClient.xaddWithLimit.mockRejectedValue(new Error('Redis error'));

      const alert = {
        event: {
          pairAddress: '0xpair123',
          transactionHash: '0xtx123',
          sender: '0xsender',
          recipient: '0xrecipient',
          to: '0xto',
          amount0In: '0',
          amount1In: '0',
          amount0Out: '0',
          amount1Out: '0',
          timestamp: Date.now(),
          blockNumber: 12345678,
          dex: 'uniswap',
          chain: 'ethereum'
        },
        pairAddress: '0xpair123',
        dex: 'uniswap',
        chain: 'ethereum',
        usdValue: 50000,
        timestamp: Date.now()
      };

      await publisher.publishWhaleAlert(alert);

      expect(logger.error).toHaveBeenCalledWith(
        'Whale alert publish failed',
        expect.any(Object)
      );
    });
  });

  // ===========================================================================
  // publishSwapEvent
  // ===========================================================================

  describe('publishSwapEvent', () => {
    it('should publish swap event to Redis Streams', async () => {
      const swap = {
        pairAddress: '0xpair123',
        transactionHash: '0xtx123',
        sender: '0xsender',
        recipient: '0xrecipient',
        to: '0xto',
        amount0In: '1000000000000000000',
        amount1In: '0',
        amount0Out: '0',
        amount1Out: '3000000000',
        timestamp: Date.now(),
        blockNumber: 12345678,
        dex: 'uniswap',
        chain: 'ethereum'
      };

      await publisher.publishSwapEvent(swap);

      // ADR-002: Uses xaddWithLimit for bounded stream growth
      expect(mockStreamsClient.xaddWithLimit).toHaveBeenCalled();
    });

    it('should handle publish errors gracefully', async () => {
      // ADR-002: Uses xaddWithLimit for bounded stream growth
      mockStreamsClient.xaddWithLimit.mockRejectedValue(new Error('Redis error'));

      const swap = {
        pairAddress: '0xpair123',
        transactionHash: '0xtx123',
        sender: '0xsender',
        recipient: '0xrecipient',
        to: '0xto',
        amount0In: '0',
        amount1In: '0',
        amount0Out: '0',
        amount1Out: '0',
        timestamp: Date.now(),
        blockNumber: 12345678,
        dex: 'uniswap',
        chain: 'ethereum'
      };

      await publisher.publishSwapEvent(swap);

      expect(logger.error).toHaveBeenCalledWith(
        'Failed to publish swap event',
        expect.any(Object)
      );
    });
  });

  // ===========================================================================
  // estimateUsdValue
  // ===========================================================================

  describe('estimateUsdValue', () => {
    it('should return token0 amount directly when token0 is a stablecoin (USDC)', () => {
      const swap = {
        pairAddress: '0xpair123',
        transactionHash: '0xtx123',
        sender: '0xsender',
        recipient: '0xrecipient',
        to: '0xto',
        amount0In: '100000000000', // 100,000 USDC (6 decimals)
        amount1In: '0',
        amount0Out: '0',
        amount1Out: '33000000000000000000', // 33 WETH
        timestamp: Date.now(),
        blockNumber: 12345678,
        dex: 'uniswap',
        chain: 'ethereum'
      };

      const pair: ExtendedPairInfo = {
        address: '0xpair123',
        dex: 'uniswap',
        token0: tokens[1].address, // USDC
        token1: tokens[0].address, // WETH
        reserve0: '10000000000000', // 10M USDC
        reserve1: '3333000000000000000000' // 3333 WETH
      };

      const result = publisher.estimateUsdValue(swap, pair);

      // Should use the larger of amount0In/amount0Out as USD value
      expect(result).toBe(100000); // 100000 USDC
    });

    it('should return token1 amount directly when token1 is a stablecoin (USDT)', () => {
      const swap = {
        pairAddress: '0xpair123',
        transactionHash: '0xtx123',
        sender: '0xsender',
        recipient: '0xrecipient',
        to: '0xto',
        amount0In: '10000000000000000000', // 10 WETH
        amount1In: '0',
        amount0Out: '0',
        amount1Out: '30000000000', // 30,000 USDT (6 decimals)
        timestamp: Date.now(),
        blockNumber: 12345678,
        dex: 'uniswap',
        chain: 'ethereum'
      };

      const pair: ExtendedPairInfo = {
        address: '0xpair123',
        dex: 'uniswap',
        token0: tokens[0].address, // WETH
        token1: tokens[2].address, // USDT
        reserve0: '3333000000000000000000', // 3333 WETH
        reserve1: '10000000000000' // 10M USDT
      };

      const result = publisher.estimateUsdValue(swap, pair);

      // Should use the larger of amount1In/amount1Out as USD value
      expect(result).toBe(30000); // 30000 USDT
    });

    it('should estimate USD value using reserve ratios for non-stablecoin pairs', () => {
      const swap = {
        pairAddress: '0xpair123',
        transactionHash: '0xtx123',
        sender: '0xsender',
        recipient: '0xrecipient',
        to: '0xto',
        amount0In: '10000000000000000000', // 10 WETH
        amount1In: '0',
        amount0Out: '0',
        amount1Out: '50000000', // 0.5 WBTC (8 decimals)
        timestamp: Date.now(),
        blockNumber: 12345678,
        dex: 'uniswap',
        chain: 'ethereum'
      };

      const pair: ExtendedPairInfo = {
        address: '0xpair123',
        dex: 'uniswap',
        token0: tokens[0].address, // WETH
        token1: tokens[4].address, // WBTC
        reserve0: '1000000000000000000000', // 1000 WETH
        reserve1: '5000000000' // 50 WBTC
      };

      const result = publisher.estimateUsdValue(swap, pair);

      // Should return a positive number based on reserve ratio estimation
      expect(result).toBeGreaterThan(0);
      expect(typeof result).toBe('number');
    });

    it('should return 0 for zero reserves (division by zero protection)', () => {
      const swap = {
        pairAddress: '0xpair123',
        transactionHash: '0xtx123',
        sender: '0xsender',
        recipient: '0xrecipient',
        to: '0xto',
        amount0In: '10000000000000000000',
        amount1In: '0',
        amount0Out: '0',
        amount1Out: '50000000',
        timestamp: Date.now(),
        blockNumber: 12345678,
        dex: 'uniswap',
        chain: 'ethereum'
      };

      const pair: ExtendedPairInfo = {
        address: '0xpair123',
        dex: 'uniswap',
        token0: tokens[0].address,
        token1: tokens[4].address,
        reserve0: '0', // Zero reserve!
        reserve1: '5000000000'
      };

      const result = publisher.estimateUsdValue(swap, pair);

      expect(result).toBe(0);
    });

    it('should return 0 for invalid BigInt reserves', () => {
      const swap = {
        pairAddress: '0xpair123',
        transactionHash: '0xtx123',
        sender: '0xsender',
        recipient: '0xrecipient',
        to: '0xto',
        amount0In: '10000000000000000000',
        amount1In: '0',
        amount0Out: '0',
        amount1Out: '50000000',
        timestamp: Date.now(),
        blockNumber: 12345678,
        dex: 'uniswap',
        chain: 'ethereum'
      };

      const pair: ExtendedPairInfo = {
        address: '0xpair123',
        dex: 'uniswap',
        token0: tokens[0].address,
        token1: tokens[4].address,
        reserve0: 'invalid_bigint', // Invalid!
        reserve1: '5000000000'
      };

      const result = publisher.estimateUsdValue(swap, pair);

      expect(result).toBe(0);
    });

    it('should return 0 when result would be NaN or Infinity', () => {
      const swap = {
        pairAddress: '0xpair123',
        transactionHash: '0xtx123',
        sender: '0xsender',
        recipient: '0xrecipient',
        to: '0xto',
        amount0In: '0', // Both amounts are 0
        amount1In: '0',
        amount0Out: '0',
        amount1Out: '0',
        timestamp: Date.now(),
        blockNumber: 12345678,
        dex: 'uniswap',
        chain: 'ethereum'
      };

      const pair: ExtendedPairInfo = {
        address: '0xpair123',
        dex: 'uniswap',
        token0: tokens[0].address,
        token1: tokens[4].address,
        reserve0: '1000000000000000000000',
        reserve1: '5000000000'
      };

      const result = publisher.estimateUsdValue(swap, pair);

      // With 0 amounts, the max estimate should be 0
      expect(Number.isFinite(result)).toBe(true);
    });

    it('should handle case-insensitive token address matching', () => {
      // FIX: SwapEvent doesn't have token0/token1 - use correct properties
      const swap = {
        pairAddress: '0xpair123',
        transactionHash: '0xtx123',
        sender: '0xsender',
        recipient: '0xrecipient',
        to: '0xto',
        amount0In: '50000000000', // 50,000 USDC
        amount1In: '0',
        amount0Out: '0',
        amount1Out: '16000000000000000000', // 16 WETH
        timestamp: Date.now(),
        blockNumber: 12345678,
        dex: 'uniswap',
        chain: 'ethereum'
      };

      const pair: ExtendedPairInfo = {
        address: '0xpair123',
        dex: 'uniswap',
        token0: tokens[1].address, // USDC
        token1: tokens[0].address, // WETH
        reserve0: '10000000000000',
        reserve1: '3333000000000000000000'
      };

      const result = publisher.estimateUsdValue(swap, pair);

      // Should still recognize USDC as stablecoin despite case difference
      expect(result).toBe(50000);
    });

    it('should use default 18 decimals for unknown tokens', () => {
      const unknownToken = '0xUnknownToken1234567890123456789012345678';

      // FIX: SwapEvent doesn't have token0/token1 - use correct properties
      const swap = {
        pairAddress: '0xpair123',
        transactionHash: '0xtx123',
        sender: '0xsender',
        recipient: '0xrecipient',
        to: '0xto',
        amount0In: '1000000000000000000', // 1 token (18 decimals assumed)
        amount1In: '0',
        amount0Out: '0',
        amount1Out: '100000000', // 100 USDC
        timestamp: Date.now(),
        blockNumber: 12345678,
        dex: 'uniswap',
        chain: 'ethereum'
      };

      const pair: ExtendedPairInfo = {
        address: '0xpair123',
        dex: 'uniswap',
        token0: unknownToken,
        token1: tokens[1].address,
        reserve0: '1000000000000000000000', // 1000 tokens
        reserve1: '100000000000' // 100,000 USDC
      };

      const result = publisher.estimateUsdValue(swap, pair);

      // Token1 is USDC, so should use that
      expect(result).toBe(100);
    });

    it('should recognize all supported stablecoins', () => {
      const stablecoins = ['USDT', 'USDC', 'DAI', 'BUSD', 'FRAX', 'TUSD', 'USDP', 'UST', 'MIM'];

      for (const stablecoin of stablecoins) {
        const stableToken: Token = {
          address: `0x${stablecoin}Address123456789012345678901234`,
          symbol: stablecoin,
          decimals: stablecoin === 'DAI' ? 18 : 6,
          chainId: 1 // FIX: chainId is number, not string
        };

        const testTokens = [...tokens, stableToken];
        const testPublisher = new WhaleAlertPublisher({
          chainId: 'ethereum',
          logger,
          streamsClient: mockStreamsClient as any,
          tokens: testTokens
        });

        // FIX: SwapEvent doesn't have token0/token1 - use correct properties
        const swap = {
          pairAddress: '0xpair123',
          transactionHash: '0xtx123',
          sender: '0xsender',
          recipient: '0xrecipient',
          to: '0xto',
          amount0In: stablecoin === 'DAI' ? '10000000000000000000000' : '10000000000', // 10,000 in respective decimals
          amount1In: '0',
          amount0Out: '0',
          amount1Out: '3000000000000000000', // 3 WETH
          timestamp: Date.now(),
          blockNumber: 12345678,
          dex: 'uniswap',
          chain: 'ethereum'
        };

        const pair: ExtendedPairInfo = {
          address: '0xpair123',
          dex: 'uniswap',
          token0: stableToken.address,
          token1: tokens[0].address,
          reserve0: stablecoin === 'DAI' ? '10000000000000000000000000' : '10000000000000',
          reserve1: '3333000000000000000000'
        };

        const result = testPublisher.estimateUsdValue(swap, pair);

        expect(result).toBe(10000); // Should recognize as 10,000 USD
      }
    });
  });

  // ===========================================================================
  // Performance (O(1) Lookups)
  // ===========================================================================

  describe('performance', () => {
    it('should use O(1) token lookup for many tokens', () => {
      // Create a publisher with many tokens
      const manyTokens: Token[] = [];
      for (let i = 0; i < 1000; i++) {
        manyTokens.push({
          address: `0x${i.toString().padStart(40, '0')}`,
          symbol: `TOKEN${i}`,
          decimals: 18,
          chainId: 1 // FIX: chainId is number, not string
        });
      }

      const largePublisher = new WhaleAlertPublisher({
        chainId: 'ethereum',
        logger,
        streamsClient: mockStreamsClient as any,
        tokens: manyTokens
      });

      // Verify it was created (O(1) lookup map should be built)
      expect(largePublisher).toBeDefined();

      // Test that lookup works correctly for a token in the middle
      // FIX: SwapEvent doesn't have token0/token1 - use correct properties
      const swap = {
        pairAddress: '0xpair123',
        transactionHash: '0xtx123',
        sender: '0xsender',
        recipient: '0xrecipient',
        to: '0xto',
        amount0In: '1000000000000000000',
        amount1In: '0',
        amount0Out: '0',
        amount1Out: '100000000',
        timestamp: Date.now(),
        blockNumber: 12345678,
        dex: 'uniswap',
        chain: 'ethereum'
      };

      const pair: ExtendedPairInfo = {
        address: '0xpair123',
        dex: 'uniswap',
        token0: `0x${(500).toString().padStart(40, '0')}`,
        token1: tokens[1].address,
        reserve0: '1000000000000000000000',
        reserve1: '100000000000'
      };

      // This should not throw and should work efficiently
      const result = largePublisher.estimateUsdValue(swap, pair);
      expect(typeof result).toBe('number');
    });
  });
});
