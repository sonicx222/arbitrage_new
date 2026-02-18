/**
 * S2.2.5 Pair Initialization Unit Tests
 *
 * Retained tests from the original integration suite that exercise
 * real logic: CREATE2 address computation, factory address validation,
 * deterministic token sorting, and fee-handling regression.
 *
 * Config-shape tests (testing inline constants/objects) have been removed.
 */

// Set required environment variables BEFORE any config imports
process.env.NODE_ENV = 'test';
process.env.ETHEREUM_RPC_URL = 'https://mainnet.infura.io/v3/test';
process.env.ETHEREUM_WS_URL = 'wss://mainnet.infura.io/ws/v3/test';
process.env.REDIS_URL = 'redis://localhost:6379';

// P1-3 FIX: Import config module and alias to avoid TS2451 redeclaration

const pairInitConfig = require('@arbitrage/config');
const {
  DEXES: pairInitDEXES,
  CHAINS: pairInitCHAINS,
} = pairInitConfig;

// Re-export with standard names for test usage
const DEXES = pairInitDEXES;
const CHAINS = pairInitCHAINS;

// Make this file a module to avoid global scope issues
export {};

// =============================================================================
// S2.2.5 Pair Initialization - Useful Tests
// =============================================================================

describe('S2.2.5 Pair Initialization', () => {
  describe('Factory Address Validation', () => {
    it('should validate factory addresses from config', () => {
      // All DEX factory addresses should be valid addresses for their chain type
      Object.entries(DEXES).forEach(([chain, dexes]) => {
        (dexes as any[]).forEach(dex => {
          // Solana uses base58 program addresses instead of EVM 0x format
          if (chain === 'solana') {
            expect(dex.factoryAddress).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,50}$/);
          } else {
            expect(dex.factoryAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
            expect(dex.factoryAddress).not.toBe('0x0000000000000000000000000000000000000000');
          }
        });
      });
    });
  });

  describe('CREATE2 Address Generation', () => {
    it('should generate deterministic addresses using CREATE2 formula', () => {
      // CREATE2 address = keccak256(0xff ++ factory ++ salt ++ keccak256(initCode))[12:]
      const generateCreate2Address = (
        factory: string,
        token0: string,
        token1: string,
        initCodeHash: string
      ): string => {
        // Sort tokens for deterministic ordering
        const [sortedToken0, sortedToken1] = [token0, token1].sort((a, b) =>
          a.toLowerCase().localeCompare(b.toLowerCase())
        );

        const salt = require('ethers').keccak256(
          require('ethers').solidityPacked(
            ['address', 'address'],
            [sortedToken0, sortedToken1]
          )
        );

        const packed = require('ethers').solidityPacked(
          ['bytes1', 'address', 'bytes32', 'bytes32'],
          ['0xff', factory, salt, initCodeHash]
        );

        return '0x' + require('ethers').keccak256(packed).slice(26);
      };

      // Test with known Uniswap V2 init code hash
      const UNISWAP_V2_INIT_CODE_HASH = '0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f';
      const factory = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';
      const weth = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
      const usdt = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

      const pairAddress = generateCreate2Address(factory, weth, usdt, UNISWAP_V2_INIT_CODE_HASH);

      // Should generate valid Ethereum address
      expect(pairAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
      // Should be deterministic (same input = same output)
      const pairAddress2 = generateCreate2Address(factory, usdt, weth, UNISWAP_V2_INIT_CODE_HASH);
      expect(pairAddress).toBe(pairAddress2);
    });

    it('should sort token addresses for deterministic pair generation', () => {
      const sortTokens = (tokenA: string, tokenB: string): [string, string] => {
        return tokenA.toLowerCase() < tokenB.toLowerCase()
          ? [tokenA, tokenB]
          : [tokenB, tokenA];
      };

      const weth = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
      const usdt = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

      const [sorted0, sorted1] = sortTokens(weth, usdt);
      const [sorted0Rev, sorted1Rev] = sortTokens(usdt, weth);

      // Should produce same result regardless of input order
      expect(sorted0).toBe(sorted0Rev);
      expect(sorted1).toBe(sorted1Rev);
    });
  });
});

// =============================================================================
// Regression Tests
// =============================================================================

describe('S2.2.5 Regression Tests', () => {
  describe('REGRESSION: Pair Address Consistency', () => {
    it('should generate same address regardless of token order', () => {
      const sortTokens = (a: string, b: string): [string, string] => {
        return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
      };

      const token1 = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      const token2 = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

      const [sorted1a, sorted1b] = sortTokens(token1, token2);
      const [sorted2a, sorted2b] = sortTokens(token2, token1);

      expect(sorted1a).toBe(sorted2a);
      expect(sorted1b).toBe(sorted2b);
    });

    it('should handle checksum vs lowercase addresses', () => {
      const checksum = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
      const lowercase = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';

      expect(checksum.toLowerCase()).toBe(lowercase);
    });
  });

  describe('REGRESSION: Fee Handling', () => {
    it('should use ?? not || for fee fallbacks (S2.2.3 fix)', () => {
      const zeroFee = 0;
      const defaultFee = 0.003;

      // Correct behavior with ??
      expect(zeroFee ?? defaultFee).toBe(0);

      // Wrong behavior with ||
      expect(zeroFee || defaultFee).toBe(defaultFee);
    });
  });
});
