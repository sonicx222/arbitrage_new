/**
 * Parameterized Chain Configuration Integration Tests
 *
 * Consolidates S3.2.1, S3.2.2 chain configuration tests into a single
 * parameterized test suite using describe.each().
 *
 * Tested chains:
 * - Avalanche: 6 DEXes (Trader Joe V2, Pangolin, SushiSwap, KyberSwap, GMX, Platypus)
 * - Fantom: 4 DEXes (SpookySwap, SpiritSwap, Equalizer, Beethoven X)
 *
 * @see IMPLEMENTATION_PLAN.md S3.2.x: Add chain configurations
 * @see ADR-003: Partitioned Chain Detectors
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, jest } from '@jest/globals';

import {
  CHAINS,
  getEnabledDexes,
  CORE_TOKENS,
  TOKEN_METADATA,
  DETECTOR_CONFIG
} from '@arbitrage/config';

import {
  assignChainToPartition
} from '@arbitrage/config/partitions';

import { PARTITION_IDS } from '@arbitrage/config';

// =============================================================================
// Test Data - Chain Configurations
// =============================================================================

interface DexAddress {
  factory: string;
  router: string;
  vault?: string;
  pool?: string;
}

interface ChainTestData {
  chainKey: string;
  chainId: number;
  chainName: string;
  nativeToken: string;
  nativeWrapper: string;
  blockTime: number;
  partitionId: string;
  tokenCount: number;
  enabledDexCount: number;
  requiredDexes: readonly string[];
  requiredTokens: readonly string[];
  tokenAddresses: Record<string, string>;
  dexAddresses: Record<string, DexAddress>;
  crossChainPartners: string[];
  minCommonTokens: number;
  maxExpiryMs: number;
  stablecoinSymbols: readonly string[];
  stablecoinUsdtSymbol: string;
  wethSymbol: string;
  wethAddress: string;
  vaultModelDexes: readonly string[];
  standardDexes: readonly string[];
}

const CHAIN_TEST_DATA: ChainTestData[] = [
  {
    chainKey: 'avalanche',
    chainId: 43114,
    chainName: 'Avalanche C-Chain',
    nativeToken: 'AVAX',
    nativeWrapper: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
    blockTime: 2,
    partitionId: PARTITION_IDS.ASIA_FAST,
    tokenCount: 15,
    enabledDexCount: 6,
    requiredDexes: ['trader_joe_v2', 'pangolin', 'sushiswap', 'kyberswap', 'gmx', 'platypus'],
    requiredTokens: ['WAVAX', 'USDT', 'USDC', 'DAI', 'WBTC.e', 'WETH.e', 'JOE', 'LINK', 'AAVE', 'sAVAX', 'QI', 'PNG', 'PTP', 'GMX', 'FRAX'],
    tokenAddresses: {
      WAVAX: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
      USDT: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7',
      USDC: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
      DAI: '0xd586E7F844cEa2F87f50152665BCbc2C279D8d70',
      'WBTC.e': '0x50b7545627a5162F82A992c33b87aDc75187B218',
      'WETH.e': '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB',
      JOE: '0x6e84a6216eA6dACC71eE8E6b0a5B7322EEbC0fDd',
      LINK: '0x5947BB275c521040051D82396192181b413227A3',
      AAVE: '0x63a72806098Bd3D9520cC43356dD78afe5D386D9',
      sAVAX: '0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE',
      QI: '0x8729438EB15e2C8B576fCc6AeCdA6A148776C0F5',
      PNG: '0x60781C2586D68229fde47564546784ab3fACA982',
      PTP: '0x22d4002028f537599bE9f666d1c4Fa138522f9c8',
      GMX: '0x62edc0692BD897D2295872a9FFCac5425011c661',
      FRAX: '0xD24C2Ad096400B6FBcd2ad8B24E7acBc21A1da64'
    },
    dexAddresses: {
      trader_joe_v2: {
        factory: '0x8e42f2F4101563bF679975178e880FD87d3eFd4e',
        router: '0x60aE616a2155Ee3d9A68541Ba4544862310933d4'
      },
      pangolin: {
        factory: '0xefa94DE7a4656D787667C749f7E1223D71E9FD88',
        router: '0xE54Ca86531e17Ef3616d22Ca28b0D458b6C89106'
      },
      sushiswap: {
        factory: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
        router: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506'
      },
      gmx: {
        factory: '0x9ab2De34A33fB459b538c43f251eB825645e8595',
        router: '0x5F719c2F1095F7B9fc68a68e35B51194f4b6abe8',
        vault: '0x9ab2De34A33fB459b538c43f251eB825645e8595'
      },
      platypus: {
        factory: '0x66357dCaCe80431aee0A7507e2E361B7e2402370',
        router: '0x73256EC7575D999C360c1EeC118ECbEFd8DA7D12',
        pool: '0x66357dCaCe80431aee0A7507e2E361B7e2402370'
      },
      kyberswap: {
        factory: '0x5F1dddbf348aC2fbe22a163e30F99F9ECE3DD50a',
        router: '0xC1e7dFE73E1598E3910EF4C7845B68A9Ab6F4c83'
      }
    },
    crossChainPartners: ['bsc', 'polygon'],
    minCommonTokens: 4,
    maxExpiryMs: 15000,
    stablecoinSymbols: ['USDC', 'USDT', 'DAI', 'FRAX'],
    stablecoinUsdtSymbol: 'USDT',
    wethSymbol: 'WETH.e',
    wethAddress: '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB',
    vaultModelDexes: ['gmx', 'platypus'],
    // Note: kyberswap is V3-style (not V2), so it's not included in standardDexes
    // V3 DEXes have different pool creation mechanisms that don't use CREATE2
    standardDexes: ['trader_joe_v2', 'pangolin', 'sushiswap']
  },
  {
    chainKey: 'fantom',
    chainId: 250,
    chainName: 'Fantom Opera',
    nativeToken: 'FTM',
    nativeWrapper: '0x21be370D5312f44cB42ce377BC9b8a0cEF1A4C83',
    blockTime: 1,
    partitionId: PARTITION_IDS.ASIA_FAST,
    tokenCount: 10,
    enabledDexCount: 4,
    requiredDexes: ['spookyswap', 'spiritswap', 'equalizer', 'beethoven_x'],
    requiredTokens: ['WFTM', 'fUSDT', 'USDC', 'DAI', 'WETH', 'WBTC', 'BOO', 'SPIRIT', 'EQUAL', 'BEETS'],
    tokenAddresses: {
      WFTM: '0x21be370D5312f44cB42ce377BC9b8a0cEF1A4C83',
      fUSDT: '0x049d68029688eAbF473097a2fC38ef61633A3C7A',
      USDC: '0x04068DA6C83AFCFA0e13ba15A6696662335D5B75',
      DAI: '0x8D11eC38a3EB5E956B052f67Da8Bdc9bef8Abf3E',
      WETH: '0x74b23882a30290451A17c44f4F05243b6b58C76d',
      WBTC: '0x321162Cd933E2Be498Cd2267a90534A804051b11',
      BOO: '0x841FAD6EAe12c286d1Fd18d1d525DFfA75C7EFFE',
      SPIRIT: '0x5Cc61A78F164885776AA610fb0FE1257df78E59B',
      EQUAL: '0x3Fd3A0c85B70754eFc07aC9Ac0cbBDCe664865A6',
      BEETS: '0xF24Bcf4d1e507740041C9cFd2DddB29585aDCe1e'
    },
    dexAddresses: {
      spookyswap: {
        factory: '0x152eE697f2E276fA89E96742e9bB9aB1F2E61bE3',
        router: '0xF491e7B69E4244ad4002BC14e878a34207E38c29'
      },
      spiritswap: {
        factory: '0xEF45d134b73241eDa7703fa787148D9C9F4950b0',
        router: '0x16327E3FbDaCA3bcF7E38F5Af2599D2DDc33aE52'
      },
      equalizer: {
        factory: '0xc6366EFD0AF1d09171fe0EBF32c7943BB310832a',
        router: '0x1A05EB736873485655F29a37DEf8a0AA87F5a447'
      },
      beethoven_x: {
        factory: '0x60467cb225092cE0c989361934311175f437Cf53',
        router: '0x20dd72Ed959b6147912C2e529F0a0C651c33c9ce'
      }
    },
    crossChainPartners: ['polygon', 'bsc'],
    minCommonTokens: 3,
    maxExpiryMs: 10000,
    stablecoinSymbols: ['USDC', 'fUSDT', 'DAI'],
    stablecoinUsdtSymbol: 'fUSDT',
    wethSymbol: 'WETH',
    wethAddress: '0x74b23882a30290451A17c44f4F05243b6b58C76d',
    vaultModelDexes: ['beethoven_x'],
    standardDexes: ['spookyswap', 'spiritswap', 'equalizer']
  }
];

// =============================================================================
// Parameterized Chain Configuration Tests
// =============================================================================

describe.each(CHAIN_TEST_DATA)(
  '$chainKey Chain Configuration',
  (testData) => {
    // =========================================================================
    // Chain Basics Tests
    // =========================================================================

    describe('Chain Basics', () => {
      it('should have chain configured', () => {
        expect(CHAINS[testData.chainKey]).toBeDefined();
      });

      it(`should have correct chain ID (${testData.chainId})`, () => {
        expect(CHAINS[testData.chainKey].id).toBe(testData.chainId);
      });

      it('should have correct chain name', () => {
        expect(CHAINS[testData.chainKey].name).toBe(testData.chainName);
      });

      it('should have RPC URL configured', () => {
        expect(CHAINS[testData.chainKey].rpcUrl).toBeDefined();
        expect(CHAINS[testData.chainKey].rpcUrl.length).toBeGreaterThan(0);
      });

      it('should have WebSocket URL configured', () => {
        expect(CHAINS[testData.chainKey].wsUrl).toBeDefined();
        expect(CHAINS[testData.chainKey].wsUrl!.length).toBeGreaterThan(0);
      });

      it(`should have ${testData.blockTime} second block time`, () => {
        expect(CHAINS[testData.chainKey].blockTime).toBe(testData.blockTime);
      });

      it(`should have ${testData.nativeToken} as native token`, () => {
        expect(CHAINS[testData.chainKey].nativeToken).toBe(testData.nativeToken);
      });

      it(`should be assigned to ${testData.partitionId} partition`, () => {
        const partition = assignChainToPartition(testData.chainKey);
        expect(partition).not.toBeNull();
        expect(partition!.partitionId).toBe(testData.partitionId);
      });
    });

    // =========================================================================
    // Detector Configuration Tests
    // =========================================================================

    describe('Detector Configuration', () => {
      it('should have detector config', () => {
        expect(DETECTOR_CONFIG[testData.chainKey]).toBeDefined();
      });

      it('should have appropriate batch size', () => {
        const config = DETECTOR_CONFIG[testData.chainKey];
        expect(config.batchSize).toBeGreaterThanOrEqual(10);
        expect(config.batchSize).toBeLessThanOrEqual(50);
      });

      it('should have confidence threshold configured', () => {
        const config = DETECTOR_CONFIG[testData.chainKey];
        expect(config.confidence).toBeGreaterThanOrEqual(0.7);
        expect(config.confidence).toBeLessThanOrEqual(1.0);
      });

      it('should have whale threshold configured', () => {
        const config = DETECTOR_CONFIG[testData.chainKey];
        expect(config.whaleThreshold).toBeGreaterThanOrEqual(10000);
      });

      it('should have expiry configured for fast blocks', () => {
        const config = DETECTOR_CONFIG[testData.chainKey];
        expect(config.expiryMs).toBeLessThanOrEqual(testData.maxExpiryMs);
      });
    });

    // =========================================================================
    // DEX Configuration Tests
    // =========================================================================

    describe('DEX Configuration', () => {
      let dexes: ReturnType<typeof getEnabledDexes>;

      beforeAll(() => {
        dexes = getEnabledDexes(testData.chainKey);
      });

      it(`should have exactly ${testData.enabledDexCount} enabled DEXs`, () => {
        expect(dexes.length).toBe(testData.enabledDexCount);
      });

      it('should have all required DEXs', () => {
        const dexNames = dexes.map(d => d.name);
        for (const requiredDex of testData.requiredDexes) {
          expect(dexNames).toContain(requiredDex);
        }
      });

      describe('DEX Address Validation', () => {
        it('should have valid Ethereum addresses for all DEXs', () => {
          const addressRegex = /^0x[a-fA-F0-9]{40}$/;

          for (const dex of dexes) {
            expect(dex.factoryAddress).toMatch(addressRegex);
            expect(dex.routerAddress).toMatch(addressRegex);
          }
        });

        it('should have unique router addresses', () => {
          const routers = dexes.map(d => d.routerAddress.toLowerCase());
          const uniqueRouters = new Set(routers);
          expect(uniqueRouters.size).toBe(routers.length);
        });

        it('should have correct chain assignment for all DEXs', () => {
          for (const dex of dexes) {
            expect(dex.chain).toBe(testData.chainKey);
          }
        });
      });

      describe.each(testData.standardDexes.map(name => ({ name })))(
        '$name DEX',
        ({ name }) => {
          it('should be configured and enabled', () => {
            const dex = dexes.find(d => d.name === name);
            expect(dex).toBeDefined();
          });

          it('should have valid addresses', () => {
            const dex = dexes.find(d => d.name === name);
            if (testData.dexAddresses[name]) {
              expect(dex!.factoryAddress.toLowerCase()).toBe(
                testData.dexAddresses[name].factory.toLowerCase()
              );
              expect(dex!.routerAddress.toLowerCase()).toBe(
                testData.dexAddresses[name].router.toLowerCase()
              );
            }
          });

          it('should have fee configured', () => {
            const dex = dexes.find(d => d.name === name);
            expect(dex!.fee).toBeGreaterThanOrEqual(1);
            expect(dex!.fee).toBeLessThanOrEqual(100);
          });
        }
      );

      if (testData.vaultModelDexes.length > 0) {
        describe.each(testData.vaultModelDexes.map(name => ({ name })))(
          '$name DEX (vault model with adapter)',
          ({ name }) => {
            it('should be configured and enabled', () => {
              const dex = dexes.find(d => d.name === name);
              expect(dex).toBeDefined();
            });

            it('should have address configured', () => {
              const dex = dexes.find(d => d.name === name);
              expect(dex!.factoryAddress.length).toBe(42);
              expect(dex!.routerAddress.length).toBe(42);
            });

            it('should be in enabled DEXs list', () => {
              const dex = dexes.find(d => d.name === name);
              expect(dex).toBeDefined();
              expect(dex!.chain).toBe(testData.chainKey);
            });
          }
        );
      }
    });

    // =========================================================================
    // Token Configuration Tests
    // =========================================================================

    describe('Token Configuration', () => {
      let tokens: typeof CORE_TOKENS[string];

      beforeAll(() => {
        tokens = CORE_TOKENS[testData.chainKey];
      });

      it(`should have exactly ${testData.tokenCount} tokens configured`, () => {
        expect(tokens.length).toBe(testData.tokenCount);
      });

      it('should have all required token symbols', () => {
        const symbols = tokens.map(t => t.symbol);
        for (const requiredSymbol of testData.requiredTokens) {
          expect(symbols).toContain(requiredSymbol);
        }
      });

      describe('Native Wrapped Token', () => {
        const nativeSymbol = testData.requiredTokens[0];

        it(`should have ${nativeSymbol} configured`, () => {
          const nativeToken = tokens.find(t => t.symbol === nativeSymbol);
          expect(nativeToken).toBeDefined();
        });

        it('should have correct address', () => {
          const nativeToken = tokens.find(t => t.symbol === nativeSymbol);
          expect(nativeToken!.address.toLowerCase()).toBe(
            testData.tokenAddresses[nativeSymbol].toLowerCase()
          );
        });

        it('should have 18 decimals', () => {
          const nativeToken = tokens.find(t => t.symbol === nativeSymbol);
          expect(nativeToken!.decimals).toBe(18);
        });

        it('should have correct chain ID', () => {
          const nativeToken = tokens.find(t => t.symbol === nativeSymbol);
          expect(nativeToken!.chainId).toBe(testData.chainId);
        });
      });

      describe('Stablecoins', () => {
        it('should have USDC with 6 decimals', () => {
          const usdc = tokens.find(t => t.symbol === 'USDC');
          expect(usdc).toBeDefined();
          expect(usdc!.decimals).toBe(6);
          expect(usdc!.address.toLowerCase()).toBe(
            testData.tokenAddresses.USDC.toLowerCase()
          );
        });

        it(`should have ${testData.stablecoinUsdtSymbol} with 6 decimals`, () => {
          const usdt = tokens.find(t => t.symbol === testData.stablecoinUsdtSymbol);
          expect(usdt).toBeDefined();
          expect(usdt!.decimals).toBe(6);
        });

        it('should have DAI with 18 decimals', () => {
          const dai = tokens.find(t => t.symbol === 'DAI');
          expect(dai).toBeDefined();
          expect(dai!.decimals).toBe(18);
          expect(dai!.address.toLowerCase()).toBe(
            testData.tokenAddresses.DAI.toLowerCase()
          );
        });
      });

      describe('Token Address Validation', () => {
        it('should have valid Ethereum addresses for all tokens', () => {
          const addressRegex = /^0x[a-fA-F0-9]{40}$/;

          for (const token of tokens) {
            expect(token.address).toMatch(addressRegex);
          }
        });

        it('should have unique addresses for all tokens', () => {
          const addresses = tokens.map(t => t.address.toLowerCase());
          const uniqueAddresses = new Set(addresses);
          expect(uniqueAddresses.size).toBe(addresses.length);
        });

        it('should have correct chain ID for all tokens', () => {
          for (const token of tokens) {
            expect(token.chainId).toBe(testData.chainId);
          }
        });
      });
    });

    // =========================================================================
    // Token Metadata Tests
    // =========================================================================

    describe('Token Metadata', () => {
      it('should have metadata configured', () => {
        expect(TOKEN_METADATA[testData.chainKey]).toBeDefined();
      });

      it('should have native wrapper address', () => {
        const metadata = TOKEN_METADATA[testData.chainKey];
        expect(metadata.nativeWrapper).toBeDefined();
        expect(metadata.nativeWrapper.toLowerCase()).toBe(
          testData.nativeWrapper.toLowerCase()
        );
      });

      it('should have WETH bridged token address', () => {
        const metadata = TOKEN_METADATA[testData.chainKey];
        expect(metadata.weth).toBeDefined();
        expect(metadata.weth.toLowerCase()).toBe(
          testData.wethAddress.toLowerCase()
        );
      });

      it('should have stablecoins configured', () => {
        const metadata = TOKEN_METADATA[testData.chainKey];
        expect(metadata.stablecoins).toBeDefined();
        expect(metadata.stablecoins.length).toBeGreaterThanOrEqual(3);
      });

      it('should have USDC in stablecoins', () => {
        const metadata = TOKEN_METADATA[testData.chainKey];
        const usdc = metadata.stablecoins.find((s: { symbol: string }) => s.symbol === 'USDC');
        expect(usdc).toBeDefined();
        expect(usdc!.decimals).toBe(6);
      });

      it(`should have ${testData.stablecoinUsdtSymbol} in stablecoins`, () => {
        const metadata = TOKEN_METADATA[testData.chainKey];
        const usdt = metadata.stablecoins.find(
          (s: { symbol: string }) => s.symbol === testData.stablecoinUsdtSymbol
        );
        expect(usdt).toBeDefined();
        expect(usdt!.decimals).toBe(6);
      });

      it('should have DAI in stablecoins', () => {
        const metadata = TOKEN_METADATA[testData.chainKey];
        const dai = metadata.stablecoins.find((s: { symbol: string }) => s.symbol === 'DAI');
        expect(dai).toBeDefined();
        expect(dai!.decimals).toBe(18);
      });
    });

    // =========================================================================
    // Partition Integration Tests
    // =========================================================================

    describe('Partition Integration', () => {
      it(`should assign to ${testData.partitionId} partition`, () => {
        const partition = assignChainToPartition(testData.chainKey);
        expect(partition!.partitionId).toBe(testData.partitionId);
      });

      it('should have valid region', () => {
        const partition = assignChainToPartition(testData.chainKey);
        expect(partition!.region).toBeDefined();
      });

      it('should share partition with other chains', () => {
        const partition = assignChainToPartition(testData.chainKey);
        expect(partition!.chains).toContain(testData.chainKey);
        expect(partition!.chains.length).toBeGreaterThan(1);
      });

      describe('Cross-Chain Arbitrage Potential', () => {
        it.each(testData.crossChainPartners.map(partner => ({ partner })))(
          'should have common tokens with $partner',
          ({ partner }) => {
            const chainSymbols = CORE_TOKENS[testData.chainKey].map(t => t.symbol);
            const partnerSymbols = CORE_TOKENS[partner].map(t => t.symbol);

            const normalizeSymbol = (s: string) => s.replace(/^f/, '').replace(/\.e$/, '');
            const commonSymbols = chainSymbols.filter(s =>
              partnerSymbols.some(ps =>
                normalizeSymbol(ps) === normalizeSymbol(s) ||
                ps.includes(normalizeSymbol(s)) ||
                normalizeSymbol(s).includes(normalizeSymbol(ps))
              )
            );

            expect(commonSymbols.length).toBeGreaterThanOrEqual(testData.minCommonTokens);
          }
        );
      });
    });

    // =========================================================================
    // Pair Coverage Tests
    // =========================================================================

    describe('Pair Coverage', () => {
      it('should support native/USDC pairs on major DEXs', () => {
        const dexes = getEnabledDexes(testData.chainKey);
        const nativeSymbol = testData.requiredTokens[0];
        const nativeToken = CORE_TOKENS[testData.chainKey].find(t => t.symbol === nativeSymbol);
        const usdc = CORE_TOKENS[testData.chainKey].find(t => t.symbol === 'USDC');

        expect(nativeToken).toBeDefined();
        expect(usdc).toBeDefined();

        const majorDexes = dexes.filter(d => testData.standardDexes.includes(d.name));
        expect(majorDexes.length).toBeGreaterThanOrEqual(2);
      });

      it('should have stablecoin tokens for DEX arbitrage', () => {
        const stablecoins = CORE_TOKENS[testData.chainKey].filter(t =>
          testData.stablecoinSymbols.includes(t.symbol)
        );

        expect(stablecoins.length).toBeGreaterThanOrEqual(3);
      });

      it('should generate sufficient pairs for arbitrage', () => {
        const tokens = CORE_TOKENS[testData.chainKey];
        const dexes = getEnabledDexes(testData.chainKey);

        const pairsPerDex = (tokens.length * (tokens.length - 1)) / 2;
        const totalPairs = pairsPerDex * dexes.length;

        // Minimum pairs: tokens=10, dexes=4 -> 45*4=180
        expect(totalPairs).toBeGreaterThanOrEqual(180);
      });
    });
  }
);

// =============================================================================
// PairDiscoveryService Integration Tests
// =============================================================================

describe('PairDiscoveryService Chain Integration', () => {
  let PairDiscoveryService: typeof import('../../../shared/core/src').PairDiscoveryService;
  let resetPairDiscoveryService: typeof import('../../../shared/core/src').resetPairDiscoveryService;
  let service: InstanceType<typeof PairDiscoveryService>;

  beforeAll(async () => {
    const module = await import('../../../shared/core/src');
    PairDiscoveryService = module.PairDiscoveryService;
    resetPairDiscoveryService = module.resetPairDiscoveryService;

    resetPairDiscoveryService();
    service = new PairDiscoveryService({
      maxConcurrentQueries: 5,
      batchSize: 10,
      batchDelayMs: 0,
      retryAttempts: 2,
      retryDelayMs: 10,
      circuitBreakerThreshold: 3,
      circuitBreakerResetMs: 100,
      queryTimeoutMs: 1000
    });
  });

  beforeEach(() => {
    service.resetState();
  });

  afterAll(() => {
    service.cleanup();
  });

  describe.each(CHAIN_TEST_DATA)(
    '$chainKey PairDiscoveryService',
    (testData) => {
      describe('Factory Type Detection', () => {
        it.each(testData.standardDexes.map(name => ({ name })))(
          'should detect $name as V2-style or V3-style',
          ({ name }) => {
            const factoryType = service.detectFactoryType(name);
            expect(['v2', 'v3']).toContain(factoryType);
          }
        );

        if (testData.vaultModelDexes.length > 0) {
          it.each(testData.vaultModelDexes.map(name => ({ name })))(
            'should detect $name as unsupported (vault model)',
            ({ name }) => {
              expect(service.detectFactoryType(name)).toBe('unsupported');
            }
          );
        }
      });

      describe('CREATE2 Computation', () => {
        const getTestTokens = () => ({
          token0: {
            address: testData.nativeWrapper,
            symbol: testData.requiredTokens[0],
            decimals: 18,
            chainId: testData.chainId
          },
          token1: {
            address: testData.tokenAddresses.USDC,
            symbol: 'USDC',
            decimals: 6,
            chainId: testData.chainId
          }
        });

        it.each(testData.standardDexes.map(name => ({ name })))(
          'should compute pair address for $name',
          ({ name }) => {
            const dex = getEnabledDexes(testData.chainKey).find(d => d.name === name);
            expect(dex).toBeDefined();

            const { token0, token1 } = getTestTokens();
            const result = service.computePairAddress(testData.chainKey, dex!, token0, token1);

            expect(result).not.toBeNull();
            expect(result!.discoveryMethod).toBe('create2_compute');
            expect(result!.dex).toBe(name);
            expect(result!.chain).toBe(testData.chainKey);
          }
        );

        it('should compute different addresses for different DEXs', () => {
          const { token0, token1 } = getTestTokens();
          const results: Map<string, string> = new Map();

          for (const dexName of testData.standardDexes) {
            const dex = getEnabledDexes(testData.chainKey).find(d => d.name === dexName);
            if (dex) {
              const result = service.computePairAddress(testData.chainKey, dex, token0, token1);
              if (result) {
                results.set(dexName, result.address.toLowerCase());
              }
            }
          }

          const addresses = Array.from(results.values());
          const uniqueAddresses = new Set(addresses);
          expect(uniqueAddresses.size).toBe(addresses.length);
        });

        it('should track CREATE2 computations in stats', () => {
          const dex = getEnabledDexes(testData.chainKey).find(
            d => d.name === testData.standardDexes[0]
          );

          const statsBefore = service.getStats();
          const initialCount = statsBefore.create2Computations;

          const { token0, token1 } = getTestTokens();
          service.computePairAddress(testData.chainKey, dex!, token0, token1);

          const statsAfter = service.getStats();
          expect(statsAfter.create2Computations).toBe(initialCount + 1);
        });
      });

      if (testData.vaultModelDexes.length > 0) {
        describe('Vault-Model DEX Handling', () => {
          it.each(testData.vaultModelDexes.map(name => ({ name })))(
            'should include $name in getEnabledDexes (uses adapter)',
            ({ name }) => {
              const enabledDexes = getEnabledDexes(testData.chainKey);
              const dex = enabledDexes.find(d => d.name === name);
              expect(dex).toBeDefined();
              expect(dex!.chain).toBe(testData.chainKey);
            }
          );

          it('should return all DEXs from getEnabledDexes', () => {
            const enabledDexes = getEnabledDexes(testData.chainKey);
            expect(enabledDexes.length).toBe(testData.enabledDexCount);
          });
        });
      }

      describe('Prometheus Metrics', () => {
        it('should generate valid Prometheus metrics', () => {
          const dex = getEnabledDexes(testData.chainKey).find(
            d => d.name === testData.standardDexes[0]
          );
          const token0 = {
            address: testData.nativeWrapper,
            symbol: testData.requiredTokens[0],
            decimals: 18,
            chainId: testData.chainId
          };
          const token1 = {
            address: testData.tokenAddresses.USDC,
            symbol: 'USDC',
            decimals: 6,
            chainId: testData.chainId
          };

          service.computePairAddress(testData.chainKey, dex!, token0, token1);

          const metrics = service.getPrometheusMetrics();

          expect(metrics).toContain('pair_discovery_create2_computations');
          expect(metrics).toContain('pair_discovery_total');
          expect(metrics).toContain('# TYPE');
          expect(metrics).toContain('# HELP');
        });
      });

      describe('Event Emission', () => {
        it('should emit pair:discovered event for CREATE2 computation', () => {
          const discoveredHandler = jest.fn();
          service.on('pair:discovered', discoveredHandler);

          const dex = getEnabledDexes(testData.chainKey).find(
            d => d.name === testData.standardDexes[0]
          );
          const token0 = {
            address: testData.nativeWrapper,
            symbol: testData.requiredTokens[0],
            decimals: 18,
            chainId: testData.chainId
          };
          const token1 = {
            address: testData.tokenAddresses.USDC,
            symbol: 'USDC',
            decimals: 6,
            chainId: testData.chainId
          };

          service.computePairAddress(testData.chainKey, dex!, token0, token1);

          expect(discoveredHandler).toHaveBeenCalledWith(
            expect.objectContaining({
              discoveryMethod: 'create2_compute',
              dex: testData.standardDexes[0],
              chain: testData.chainKey
            })
          );
        });
      });
    }
  );
});

// =============================================================================
// Regression Tests
// =============================================================================

describe('Regression Tests', () => {
  describe('Existing Configuration Preserved', () => {
    const existingChains = ['bsc', 'polygon', 'ethereum', 'arbitrum'];

    it.each(existingChains.map(chain => ({ chain })))(
      'should not break $chain chain configuration',
      ({ chain }) => {
        expect(CHAINS[chain]).toBeDefined();
      }
    );

    it.each(existingChains.map(chain => ({ chain })))(
      'should not break $chain DEX configurations',
      ({ chain }) => {
        expect(getEnabledDexes(chain).length).toBeGreaterThan(0);
      }
    );

    it.each(existingChains.map(chain => ({ chain })))(
      'should not break $chain token configurations',
      ({ chain }) => {
        expect(CORE_TOKENS[chain].length).toBeGreaterThan(0);
      }
    );
  });

  describe('Total System Counts', () => {
    it('should maintain 11 total chains', () => {
      expect(Object.keys(CHAINS).length).toBe(11);
    });

    it('should have at least 47 enabled DEXs', () => {
      let totalEnabledDexes = 0;
      for (const chain of Object.keys(CHAINS)) {
        totalEnabledDexes += getEnabledDexes(chain).length;
      }
      expect(totalEnabledDexes).toBeGreaterThanOrEqual(47);
    });

    it('should have at least 98 total tokens', () => {
      let totalTokens = 0;
      for (const chain of Object.keys(CHAINS)) {
        if (CORE_TOKENS[chain]) {
          totalTokens += CORE_TOKENS[chain].length;
        }
      }
      expect(totalTokens).toBeGreaterThanOrEqual(98);
    });
  });

  describe.each(CHAIN_TEST_DATA)(
    '$chainKey Specific Counts',
    (testData) => {
      it(`should have ${testData.enabledDexCount} DEXs enabled`, () => {
        const enabledDexes = getEnabledDexes(testData.chainKey);
        expect(enabledDexes.length).toBe(testData.enabledDexCount);
      });

      it(`should have ${testData.tokenCount} tokens configured`, () => {
        const tokens = CORE_TOKENS[testData.chainKey];
        expect(tokens.length).toBe(testData.tokenCount);
      });
    }
  );
});
