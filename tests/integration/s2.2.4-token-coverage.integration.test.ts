/**
 * S2.2.4 Token Coverage Verification Integration Tests
 *
 * Sprint 2, Task 2.4: Expand token coverage to 60 (VERIFICATION)
 *
 * This task verifies:
 * 1. Total token count matches Phase 1 target (60 tokens)
 * 2. All token addresses are valid Ethereum addresses
 * 3. Token configurations are correct (decimals, chainId)
 * 4. Required high-volume tokens are present per chain
 *
 * Test-Driven Development:
 * 1. Write failing tests for token coverage validation
 * 2. Verify existing configuration meets requirements
 * 3. Document any gaps for future expansion
 */

// Set required environment variables BEFORE any config imports
process.env.NODE_ENV = 'test';
process.env.ETHEREUM_RPC_URL = 'https://mainnet.infura.io/v3/test';
process.env.ETHEREUM_WS_URL = 'wss://mainnet.infura.io/ws/v3/test';
process.env.REDIS_URL = 'redis://localhost:6379';

// Use require to avoid ts-jest transformation caching issues
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  CHAINS,
  CORE_TOKENS,
  TOKEN_METADATA,
  PHASE_METRICS
} = require('@arbitrage/config');

// =============================================================================
// S2.2.4 Test Suite: Token Coverage Verification
// =============================================================================

describe('S2.2.4 Token Coverage Verification', () => {
  // ===========================================================================
  // Section 1: Total Token Count Tests
  // ===========================================================================

  describe('Total Token Count', () => {
    it('should have at least 60 tokens across all chains (original Phase 1 target)', () => {
      // S3.1.2 added 5 new chains: avalanche (8), fantom (6), zksync (6), linea (6), solana (8)
      // Total is now 60 + 34 = 94 tokens
      const totalTokens = Object.values(CORE_TOKENS).flat().length;
      expect(totalTokens).toBeGreaterThanOrEqual(60); // Original Phase 1 target
    });

    it('should match PHASE_METRICS current token count', () => {
      const totalTokens = Object.values(CORE_TOKENS).flat().length;
      expect(PHASE_METRICS.current.tokens).toBe(totalTokens);
    });

    it('should have tokens for all 11 chains after S3.1.2 expansion', () => {
      const totalTokens = Object.values(CORE_TOKENS).flat().length;
      // 11 chains with tokens: original 6 + 5 new chains
      // S3.2.1: Avalanche expanded to 15, Fantom to 10
      // S3.3.3: Solana expanded to 15 → Total 112
      expect(totalTokens).toBe(112);
    });

    it('should have tokens configured for all chains', () => {
      const chainNames = Object.keys(CHAINS);
      const tokenChains = Object.keys(CORE_TOKENS);

      chainNames.forEach(chain => {
        expect(tokenChains).toContain(chain);
        expect(CORE_TOKENS[chain].length).toBeGreaterThan(0);
      });
    });
  });

  // ===========================================================================
  // Section 2: Per-Chain Token Count Tests
  // ===========================================================================

  describe('Per-Chain Token Count', () => {
    // S3.1.2: Added 5 new chains with token configurations
    // S3.2.1: Expanded Avalanche to 15, Fantom to 10
    // S3.3.3: Expanded Solana to 15
    const expectedCounts: Record<string, number> = {
      // Original 6 chains
      arbitrum: 12,
      bsc: 10,
      base: 10,
      polygon: 10,
      optimism: 10,
      ethereum: 8,
      // S3.1.2: New chains (S3.2.1: avalanche expanded to 15, fantom to 10, S3.3.3: solana to 15)
      avalanche: 15,
      fantom: 10,
      zksync: 6,
      linea: 6,
      solana: 15
    };

    Object.entries(expectedCounts).forEach(([chain, expectedCount]) => {
      it(`should have ${expectedCount} tokens for ${chain}`, () => {
        expect(CORE_TOKENS[chain]).toBeDefined();
        expect(CORE_TOKENS[chain].length).toBe(expectedCount);
      });
    });

    it('should have total matching sum of per-chain counts', () => {
      const sumOfCounts = Object.values(expectedCounts).reduce((a, b) => a + b, 0);
      const actualTotal = Object.values(CORE_TOKENS).flat().length;
      expect(actualTotal).toBe(sumOfCounts);
    });
  });

  // ===========================================================================
  // Section 3: Token Address Validation Tests
  // ===========================================================================

  describe('Token Address Validation', () => {
    const isValidEthereumAddress = (address: string): boolean => {
      return /^0x[a-fA-F0-9]{40}$/.test(address);
    };

    // Solana uses base58-encoded addresses (32-44 chars, alphanumeric)
    const isValidSolanaAddress = (address: string): boolean => {
      return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
    };

    // Non-EVM chains that use different address formats
    const nonEvmChains = ['solana'];

    Object.entries(CORE_TOKENS).forEach(([chain, tokens]) => {
      describe(`${chain} token addresses`, () => {
        (tokens as any[]).forEach((token: any, index: number) => {
          it(`should have valid address for ${token.symbol} (index ${index})`, () => {
            if (nonEvmChains.includes(chain)) {
              // Non-EVM chains use different address formats
              expect(isValidSolanaAddress(token.address)).toBe(true);
            } else {
              expect(isValidEthereumAddress(token.address)).toBe(true);
            }
          });

          it(`should not have zero address for ${token.symbol}`, () => {
            if (!nonEvmChains.includes(chain)) {
              expect(token.address).not.toBe('0x0000000000000000000000000000000000000000');
            }
          });
        });
      });
    });

    it('should have all token addresses be unique per chain', () => {
      Object.entries(CORE_TOKENS).forEach(([chain, tokens]) => {
        const addresses = (tokens as any[]).map(t => t.address.toLowerCase());
        const uniqueAddresses = new Set(addresses);
        expect(uniqueAddresses.size).toBe(addresses.length);
      });
    });

    it('should have all token symbols be unique per chain', () => {
      Object.entries(CORE_TOKENS).forEach(([chain, tokens]) => {
        const symbols = (tokens as any[]).map(t => t.symbol);
        const uniqueSymbols = new Set(symbols);
        expect(uniqueSymbols.size).toBe(symbols.length);
      });
    });
  });

  // ===========================================================================
  // Section 4: Token Configuration Tests
  // ===========================================================================

  describe('Token Configuration', () => {
    Object.entries(CORE_TOKENS).forEach(([chain, tokens]) => {
      describe(`${chain} token configuration`, () => {
        (tokens as any[]).forEach((token: any) => {
          it(`should have valid decimals for ${token.symbol}`, () => {
            expect(token.decimals).toBeGreaterThan(0);
            expect(token.decimals).toBeLessThanOrEqual(18);
            expect(Number.isInteger(token.decimals)).toBe(true);
          });

          it(`should have correct chainId for ${token.symbol}`, () => {
            const chainConfig = CHAINS[chain];
            expect(token.chainId).toBe(chainConfig.id);
          });

          it(`should have symbol defined for token at ${token.address.slice(0, 10)}...`, () => {
            expect(token.symbol).toBeDefined();
            expect(token.symbol.length).toBeGreaterThan(0);
            expect(token.symbol.length).toBeLessThanOrEqual(10);
          });
        });
      });
    });
  });

  // ===========================================================================
  // Section 5: Required Token Tests (Anchor Tokens)
  // ===========================================================================

  describe('Required Anchor Tokens', () => {
    // Every chain should have certain "anchor" tokens for arbitrage
    const requiredStablecoins = ['USDT', 'USDC'];

    describe('Stablecoin coverage', () => {
      Object.keys(CORE_TOKENS).forEach(chain => {
        it(`should have at least one stablecoin on ${chain}`, () => {
          const tokens = CORE_TOKENS[chain] as any[];
          const stablecoins = tokens.filter(t =>
            ['USDT', 'USDC', 'DAI', 'BUSD'].includes(t.symbol)
          );
          expect(stablecoins.length).toBeGreaterThanOrEqual(1);
        });
      });
    });

    describe('Native wrapper coverage', () => {
      const nativeWrappers: Record<string, string> = {
        arbitrum: 'WETH',
        bsc: 'WBNB',
        base: 'WETH',
        polygon: 'WMATIC',
        optimism: 'WETH',
        ethereum: 'WETH'
      };

      Object.entries(nativeWrappers).forEach(([chain, wrapperSymbol]) => {
        it(`should have ${wrapperSymbol} on ${chain}`, () => {
          const tokens = CORE_TOKENS[chain] as any[];
          const wrapper = tokens.find(t => t.symbol === wrapperSymbol);
          expect(wrapper).toBeDefined();
        });
      });
    });
  });

  // ===========================================================================
  // Section 6: TOKEN_METADATA Consistency Tests
  // ===========================================================================

  describe('TOKEN_METADATA Consistency', () => {
    // Non-EVM chains use different address formats
    const nonEvmChains = ['solana'];
    const isValidSolanaAddress = (address: string): boolean => {
      return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
    };

    Object.entries(TOKEN_METADATA).forEach(([chain, metadata]: [string, any]) => {
      if (!metadata) return;

      describe(`${chain} metadata`, () => {
        it('should have weth address defined', () => {
          expect(metadata.weth).toBeDefined();
          if (nonEvmChains.includes(chain)) {
            expect(isValidSolanaAddress(metadata.weth)).toBe(true);
          } else {
            expect(/^0x[a-fA-F0-9]{40}$/.test(metadata.weth)).toBe(true);
          }
        });

        it('should have nativeWrapper address defined', () => {
          expect(metadata.nativeWrapper).toBeDefined();
          if (nonEvmChains.includes(chain)) {
            expect(isValidSolanaAddress(metadata.nativeWrapper)).toBe(true);
          } else {
            expect(/^0x[a-fA-F0-9]{40}$/.test(metadata.nativeWrapper)).toBe(true);
          }
        });

        it('should have stablecoins array defined', () => {
          expect(metadata.stablecoins).toBeDefined();
          expect(Array.isArray(metadata.stablecoins)).toBe(true);
          expect(metadata.stablecoins.length).toBeGreaterThan(0);
        });

        it('should have valid stablecoin configurations', () => {
          metadata.stablecoins.forEach((stable: any) => {
            if (nonEvmChains.includes(chain)) {
              expect(isValidSolanaAddress(stable.address)).toBe(true);
            } else {
              expect(/^0x[a-fA-F0-9]{40}$/.test(stable.address)).toBe(true);
            }
            expect(stable.symbol).toBeDefined();
            expect(stable.decimals).toBeGreaterThan(0);
          });
        });

        it('should have stablecoin addresses match CORE_TOKENS', () => {
          const coreTokens = CORE_TOKENS[chain] as any[];
          if (!coreTokens) return;

          metadata.stablecoins.forEach((stable: any) => {
            const coreToken = coreTokens.find(t =>
              t.address.toLowerCase() === stable.address.toLowerCase()
            );
            // Stablecoin should exist in CORE_TOKENS or be a bridged variant
            // Some stablecoins like USDbC may be in metadata but not CORE_TOKENS
            if (coreToken) {
              expect(coreToken.symbol).toBe(stable.symbol);
            }
          });
        });
      });
    });
  });

  // ===========================================================================
  // Section 7: Decimal Configuration Tests
  // ===========================================================================

  describe('Decimal Configuration', () => {
    // Standard token decimals
    const standardDecimals: Record<string, number> = {
      USDT: 6,  // Exception: BSC stablecoins (USDT, USDC) use 18 decimals
      USDC: 6,  // Exception: BSC USDC is 18
      DAI: 18,
      WETH: 18,
      WBNB: 18,
      WMATIC: 18,
      WBTC: 8
    };

    it('should have correct decimals for standard tokens', () => {
      Object.entries(CORE_TOKENS).forEach(([chain, tokens]) => {
        (tokens as any[]).forEach(token => {
          const expectedDecimals = standardDecimals[token.symbol];
          if (expectedDecimals !== undefined) {
            // BSC stablecoins (USDT, USDC) use 18 decimals as an exception
            if (chain === 'bsc' && ['USDT', 'USDC'].includes(token.symbol)) {
              expect(token.decimals).toBe(18);
            } else {
              expect(token.decimals).toBe(expectedDecimals);
            }
          }
        });
      });
    });

    it('should have stablecoins with 6 or 18 decimals', () => {
      Object.entries(CORE_TOKENS).forEach(([chain, tokens]) => {
        (tokens as any[]).forEach(token => {
          if (['USDT', 'USDC', 'DAI', 'BUSD'].includes(token.symbol)) {
            expect([6, 18]).toContain(token.decimals);
          }
        });
      });
    });
  });

  // ===========================================================================
  // Section 8: Cross-Chain Token Mapping Tests
  // ===========================================================================

  describe('Cross-Chain Token Mapping', () => {
    // Tokens that should exist on multiple chains for cross-chain arbitrage
    const crossChainTokens = ['WETH', 'USDT', 'USDC', 'WBTC'];

    crossChainTokens.forEach(symbol => {
      it(`should have ${symbol} on at least 3 chains`, () => {
        let chainCount = 0;

        Object.values(CORE_TOKENS).forEach(tokens => {
          const hasToken = (tokens as any[]).some(t =>
            t.symbol === symbol ||
            (symbol === 'WETH' && ['WETH', 'WBNB', 'WMATIC'].includes(t.symbol)) // Native wrappers
          );
          if (hasToken) chainCount++;
        });

        // WBTC may not be on all chains
        if (symbol === 'WBTC') {
          expect(chainCount).toBeGreaterThanOrEqual(3);
        } else {
          expect(chainCount).toBeGreaterThanOrEqual(4);
        }
      });
    });
  });

  // ===========================================================================
  // Section 9: Pair Generation Potential Tests
  // ===========================================================================

  describe('Pair Generation Potential', () => {
    it('should generate sufficient pairs per chain for arbitrage', () => {
      // Minimum pairs needed: n*(n-1)/2 where n = tokens
      // For effective arbitrage, we want at least 15 pairs per chain

      Object.entries(CORE_TOKENS).forEach(([chain, tokens]) => {
        const tokenCount = (tokens as any[]).length;
        const potentialPairs = (tokenCount * (tokenCount - 1)) / 2;

        // Every chain should have at least 15 potential pairs
        expect(potentialPairs).toBeGreaterThanOrEqual(15);
      });
    });

    it('should calculate correct total potential pairs', () => {
      let totalPairs = 0;

      Object.values(CORE_TOKENS).forEach(tokens => {
        const tokenCount = (tokens as any[]).length;
        totalPairs += (tokenCount * (tokenCount - 1)) / 2;
      });

      // With current config: 66 + 45 + 45 + 45 + 45 + 28 = 274 pairs
      // This is sufficient for Phase 1 target of 300 opportunities/day
      expect(totalPairs).toBeGreaterThanOrEqual(250);
    });
  });

  // ===========================================================================
  // Section 10: Known Token Address Verification
  // ===========================================================================

  describe('Known Token Address Verification', () => {
    // Verify critical tokens have correct addresses
    const knownAddresses: Record<string, Record<string, string>> = {
      ethereum: {
        WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
        USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        WBTC: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599'
      },
      arbitrum: {
        WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
        USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
        USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
        ARB: '0x912CE59144191C1204E64559FE8253a0e49E6548'
      },
      bsc: {
        WBNB: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
        USDT: '0x55d398326f99059fF775485246999027B3197955',
        USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
        BUSD: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56'
      },
      polygon: {
        WMATIC: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
        USDT: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
        USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
        WETH: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619'
      },
      optimism: {
        WETH: '0x4200000000000000000000000000000000000006',
        USDT: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
        USDC: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
        OP: '0x4200000000000000000000000000000000000042'
      },
      base: {
        WETH: '0x4200000000000000000000000000000000000006',
        USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        DAI: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb'
      }
    };

    Object.entries(knownAddresses).forEach(([chain, addresses]) => {
      describe(`${chain} known addresses`, () => {
        Object.entries(addresses).forEach(([symbol, expectedAddress]) => {
          it(`should have correct address for ${symbol}`, () => {
            const tokens = CORE_TOKENS[chain] as any[];
            const token = tokens.find(t => t.symbol === symbol);

            expect(token).toBeDefined();
            expect(token.address.toLowerCase()).toBe(expectedAddress.toLowerCase());
          });
        });
      });
    });
  });
});

// =============================================================================
// Regression Tests
// =============================================================================

describe('S2.2.4 Regression Tests', () => {
  describe('REGRESSION: Token Configuration Integrity', () => {
    it('should not have duplicate chainId values that differ from CHAINS', () => {
      Object.entries(CORE_TOKENS).forEach(([chain, tokens]) => {
        const chainConfig = CHAINS[chain];
        (tokens as any[]).forEach(token => {
          expect(token.chainId).toBe(chainConfig.id);
        });
      });
    });

    it('should have consistent token data structure', () => {
      const requiredFields = ['address', 'symbol', 'decimals', 'chainId'];

      Object.values(CORE_TOKENS).forEach(tokens => {
        (tokens as any[]).forEach(token => {
          requiredFields.forEach(field => {
            expect(token[field]).toBeDefined();
          });
        });
      });
    });
  });

  describe('REGRESSION: PHASE_METRICS Token Count Accuracy', () => {
    it('should have PHASE_METRICS.current.tokens equal to actual count', () => {
      const actualCount = Object.values(CORE_TOKENS).flat().length;
      expect(PHASE_METRICS.current.tokens).toBe(actualCount);
    });

    it('should have achieved Phase 1 token target', () => {
      const actualCount = Object.values(CORE_TOKENS).flat().length;
      expect(actualCount).toBeGreaterThanOrEqual(PHASE_METRICS.targets.phase1.tokens);
    });
  });
});
