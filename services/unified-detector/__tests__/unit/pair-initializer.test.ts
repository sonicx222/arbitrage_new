/**
 * PairInitializer Tests
 *
 * Tests for the extracted pair initialization module.
 * Verifies pair generation, address normalization, fee validation,
 * and data structure correctness.
 *
 * @see pair-initializer.ts
 * @see Finding #8 in .agent-reports/unified-detector-deep-analysis.md
 */

// Mock ethers for deterministic testing
const mockKeccak256 = jest.fn();
const mockSolidityPacked = jest.fn();

jest.mock('ethers', () => ({
  ethers: {
    keccak256: mockKeccak256,
    solidityPacked: mockSolidityPacked,
  }
}));

jest.mock('@arbitrage/core', () => ({
  bpsToDecimal: jest.fn((bps: number) => bps / 10000),
  validateFee: jest.fn((fee: number) => fee),
}));

import { initializePairs, generatePairAddress } from '../../src/pair-initializer';
import type { PairInitializerConfig } from '../../src/pair-initializer';
import { bpsToDecimal } from '@arbitrage/core/components';
import { validateFee } from '@arbitrage/core/utils';
import type { Dex, Token } from '@arbitrage/types';

// =============================================================================
// Fixtures
// =============================================================================

function createMockDex(name: string, feeBps: number = 30): Dex {
  return {
    name,
    chain: 'ethereum',
    factoryAddress: `0x${name}Factory000000000000000000000000000`,
    feeBps: feeBps as unknown as Dex['feeBps'],
    routerAddress: `0x${name}Router0000000000000000000000000000`,
    enabled: true,
  };
}

function createMockToken(symbol: string, address: string): Token {
  return {
    symbol,
    address,
    decimals: 18,
    chainId: 1,
  };
}

// =============================================================================
// Setup
// =============================================================================

beforeEach(() => {
  jest.clearAllMocks();

  // Re-establish mocks after jest.resetAllMocks() in global afterEach
  (bpsToDecimal as jest.Mock).mockImplementation((bps: number) => bps / 10000);
  (validateFee as jest.Mock).mockImplementation((fee: number) => fee);

  // Default: return a deterministic hash based on input
  mockSolidityPacked.mockImplementation((_types: string[], values: string[]) => {
    return values.join('');
  });
  mockKeccak256.mockImplementation((data: string) => {
    // Return a 66-char hex string (0x + 64 hex chars)
    // Use a simple deterministic hash for testing
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      hash = ((hash << 5) - hash + data.charCodeAt(i)) | 0;
    }
    const hexHash = Math.abs(hash).toString(16).padStart(64, '0');
    return '0x' + hexHash;
  });
});

// =============================================================================
// Tests
// =============================================================================

describe('generatePairAddress', () => {
  it('should generate a deterministic address from factory and token addresses', () => {
    const factory = '0xFactory';
    const token0 = '0xToken0';
    const token1 = '0xToken1';

    const address = generatePairAddress(factory, token0, token1);

    expect(mockSolidityPacked).toHaveBeenCalledWith(
      ['address', 'address', 'address'],
      [factory, token0, token1]
    );
    expect(mockKeccak256).toHaveBeenCalled();
    expect(address).toMatch(/^0x[a-f0-9]+$/);
  });

  it('should return different addresses for different inputs', () => {
    // Set up different return values for different inputs
    let callCount = 0;
    mockKeccak256.mockImplementation(() => {
      callCount++;
      return '0x' + callCount.toString().padStart(64, '0');
    });

    const addr1 = generatePairAddress('0xF1', '0xT0', '0xT1');
    const addr2 = generatePairAddress('0xF2', '0xT0', '0xT1');

    expect(addr1).not.toEqual(addr2);
  });

  it('should use solidityPacked with address types', () => {
    generatePairAddress('0xAAA', '0xBBB', '0xCCC');

    expect(mockSolidityPacked).toHaveBeenCalledWith(
      ['address', 'address', 'address'],
      ['0xAAA', '0xBBB', '0xCCC']
    );
  });
});

describe('initializePairs', () => {
  const mockGetTokenPairKey = jest.fn((t0: string, t1: string) => {
    const a = t0.toLowerCase();
    const b = t1.toLowerCase();
    return a < b ? `${a}_${b}` : `${b}_${a}`;
  });

  beforeEach(() => {
    mockGetTokenPairKey.mockClear();
  });

  describe('basic pair generation', () => {
    it('should generate correct number of pairs for dexes × tokens', () => {
      const config: PairInitializerConfig = {
        chainId: 'ethereum',
        dexes: [createMockDex('uniswap'), createMockDex('sushiswap')],
        tokens: [
          createMockToken('WETH', '0xWETH'),
          createMockToken('USDC', '0xUSDC'),
          createMockToken('DAI', '0xDAI'),
        ],
      };

      const result = initializePairs(config, mockGetTokenPairKey);

      // 2 dexes × C(3,2) token pairs = 2 × 3 = 6 pairs
      expect(result.pairs.size).toBe(6);
      expect(result.pairsByAddress.size).toBe(6);
    });

    it('should generate zero pairs when dexes array is empty', () => {
      const config: PairInitializerConfig = {
        chainId: 'ethereum',
        dexes: [],
        tokens: [createMockToken('WETH', '0xWETH'), createMockToken('USDC', '0xUSDC')],
      };

      const result = initializePairs(config, mockGetTokenPairKey);

      expect(result.pairs.size).toBe(0);
      expect(result.pairsByAddress.size).toBe(0);
      expect(result.pairAddressesCache).toHaveLength(0);
    });

    it('should generate zero pairs when tokens array is empty', () => {
      const config: PairInitializerConfig = {
        chainId: 'ethereum',
        dexes: [createMockDex('uniswap')],
        tokens: [],
      };

      const result = initializePairs(config, mockGetTokenPairKey);

      expect(result.pairs.size).toBe(0);
    });

    it('should generate zero pairs when only one token exists', () => {
      const config: PairInitializerConfig = {
        chainId: 'ethereum',
        dexes: [createMockDex('uniswap')],
        tokens: [createMockToken('WETH', '0xWETH')],
      };

      const result = initializePairs(config, mockGetTokenPairKey);

      expect(result.pairs.size).toBe(0);
    });
  });

  describe('address normalization', () => {
    it('should normalize pair addresses to lowercase', () => {
      // Make keccak256 return a mixed-case hash
      mockKeccak256.mockReturnValue('0x000000000000000000000000AABBCCDD11223344AABBCCDD11223344AABBCCDD');

      const config: PairInitializerConfig = {
        chainId: 'ethereum',
        dexes: [createMockDex('uniswap')],
        tokens: [
          createMockToken('WETH', '0xWETH'),
          createMockToken('USDC', '0xUSDC'),
        ],
      };

      const result = initializePairs(config, mockGetTokenPairKey);

      for (const [address] of result.pairsByAddress) {
        expect(address).toBe(address.toLowerCase());
      }
    });

    it('should normalize token addresses to lowercase', () => {
      const config: PairInitializerConfig = {
        chainId: 'ethereum',
        dexes: [createMockDex('uniswap')],
        tokens: [
          createMockToken('WETH', '0xAAAA'),
          createMockToken('USDC', '0xBBBB'),
        ],
      };

      const result = initializePairs(config, mockGetTokenPairKey);

      for (const [, pair] of result.pairs) {
        expect(pair.token0).toBe('0xaaaa');
        expect(pair.token1).toBe('0xbbbb');
      }
    });
  });

  describe('pair key formats', () => {
    it('should set pairKey in format "dex_token0Symbol_token1Symbol"', () => {
      const config: PairInitializerConfig = {
        chainId: 'ethereum',
        dexes: [createMockDex('uniswap')],
        tokens: [
          createMockToken('WETH', '0xWETH'),
          createMockToken('USDC', '0xUSDC'),
        ],
      };

      const result = initializePairs(config, mockGetTokenPairKey);

      const pair = result.pairs.get('uniswap_WETH_USDC');
      expect(pair).toBeDefined();
      expect(pair!.pairKey).toBe('uniswap_WETH_USDC');
    });

    it('should set chainPairKey in format "chainId:address"', () => {
      const config: PairInitializerConfig = {
        chainId: 'bsc',
        dexes: [createMockDex('pancakeswap')],
        tokens: [
          createMockToken('WBNB', '0xWBNB'),
          createMockToken('BUSD', '0xBUSD'),
        ],
      };

      const result = initializePairs(config, mockGetTokenPairKey);

      for (const [, pair] of result.pairs) {
        expect(pair.chainPairKey).toMatch(/^bsc:0x[a-f0-9]+$/);
      }
    });
  });

  describe('fee handling', () => {
    it('should convert fee from basis points to decimal using bpsToDecimal', () => {
      const config: PairInitializerConfig = {
        chainId: 'ethereum',
        dexes: [createMockDex('uniswap', 30)], // 30 bps = 0.003
        tokens: [
          createMockToken('WETH', '0xWETH'),
          createMockToken('USDC', '0xUSDC'),
        ],
      };

      initializePairs(config, mockGetTokenPairKey);

      expect(bpsToDecimal).toHaveBeenCalledWith(30);
    });

    it('should validate fee at source using validateFee', () => {
      const config: PairInitializerConfig = {
        chainId: 'ethereum',
        dexes: [createMockDex('uniswap', 30)],
        tokens: [
          createMockToken('WETH', '0xWETH'),
          createMockToken('USDC', '0xUSDC'),
        ],
      };

      initializePairs(config, mockGetTokenPairKey);

      expect(validateFee).toHaveBeenCalledWith(0.003); // bpsToDecimal(30)
    });

    it('should default to 30 bps when dex.feeBps is undefined', () => {
      const dex = createMockDex('uniswap');
      (dex as any).feeBps = undefined;

      const config: PairInitializerConfig = {
        chainId: 'ethereum',
        dexes: [dex],
        tokens: [
          createMockToken('WETH', '0xWETH'),
          createMockToken('USDC', '0xUSDC'),
        ],
      };

      initializePairs(config, mockGetTokenPairKey);

      expect(bpsToDecimal).toHaveBeenCalledWith(30);
    });
  });

  describe('data structure indexing', () => {
    it('should populate pairsByTokens index using getTokenPairKey callback', () => {
      const config: PairInitializerConfig = {
        chainId: 'ethereum',
        dexes: [createMockDex('uniswap'), createMockDex('sushiswap')],
        tokens: [
          createMockToken('WETH', '0xWETH'),
          createMockToken('USDC', '0xUSDC'),
        ],
      };

      const result = initializePairs(config, mockGetTokenPairKey);

      // Both dexes have WETH/USDC pair → should be grouped together
      expect(mockGetTokenPairKey).toHaveBeenCalledTimes(2);
      // One token pair key for the one combination, with 2 pairs (one per dex)
      expect(result.pairsByTokens.size).toBe(1);

      const tokenKey = mockGetTokenPairKey.mock.results[0].value;
      const pairsForToken = result.pairsByTokens.get(tokenKey);
      expect(pairsForToken).toHaveLength(2);
    });

    it('should build pairAddressesCache with all pair addresses', () => {
      const config: PairInitializerConfig = {
        chainId: 'ethereum',
        dexes: [createMockDex('uniswap')],
        tokens: [
          createMockToken('WETH', '0xWETH'),
          createMockToken('USDC', '0xUSDC'),
          createMockToken('DAI', '0xDAI'),
        ],
      };

      const result = initializePairs(config, mockGetTokenPairKey);

      // 1 dex × C(3,2) = 3 pairs
      expect(result.pairAddressesCache).toHaveLength(3);
      expect(result.pairAddressesCache).toEqual(Array.from(result.pairsByAddress.keys()));
    });
  });

  describe('initial pair state', () => {
    it('should set initial reserves to "0"', () => {
      const config: PairInitializerConfig = {
        chainId: 'ethereum',
        dexes: [createMockDex('uniswap')],
        tokens: [
          createMockToken('WETH', '0xWETH'),
          createMockToken('USDC', '0xUSDC'),
        ],
      };

      const result = initializePairs(config, mockGetTokenPairKey);

      for (const [, pair] of result.pairs) {
        expect(pair.reserve0).toBe('0');
        expect(pair.reserve1).toBe('0');
      }
    });

    it('should set initial blockNumber to 0 and lastUpdate to 0', () => {
      const config: PairInitializerConfig = {
        chainId: 'ethereum',
        dexes: [createMockDex('uniswap')],
        tokens: [
          createMockToken('WETH', '0xWETH'),
          createMockToken('USDC', '0xUSDC'),
        ],
      };

      const result = initializePairs(config, mockGetTokenPairKey);

      for (const [, pair] of result.pairs) {
        expect(pair.blockNumber).toBe(0);
        expect(pair.lastUpdate).toBe(0);
      }
    });

    it('should set dex name correctly on each pair', () => {
      const config: PairInitializerConfig = {
        chainId: 'ethereum',
        dexes: [createMockDex('uniswap')],
        tokens: [
          createMockToken('WETH', '0xWETH'),
          createMockToken('USDC', '0xUSDC'),
        ],
      };

      const result = initializePairs(config, mockGetTokenPairKey);

      for (const [, pair] of result.pairs) {
        expect(pair.dex).toBe('uniswap');
      }
    });
  });
});
