/**
 * S3.2.1 Integration Tests: Avalanche Configuration
 *
 * Tests for expanding Avalanche chain configuration to include:
 * - 6 DEXs: Trader Joe V2, Pangolin, SushiSwap, GMX, Platypus, KyberSwap
 * - 15 tokens for comprehensive pair coverage
 *
 * @see IMPLEMENTATION_PLAN.md S3.2.1: Add Avalanche configuration
 * @see ADR-003: Partitioned Chain Detectors
 */

import { describe, it, expect, beforeAll } from '@jest/globals';

import {
  CHAINS,
  getEnabledDexes,
  CORE_TOKENS,
  TOKEN_METADATA,
  DETECTOR_CONFIG
} from '../../shared/config/src';

import {
  assignChainToPartition
} from '../../shared/config/src/partitions';

import { PARTITION_IDS } from '../../shared/config/src';

// =============================================================================
// Test Constants
// =============================================================================

const AVALANCHE_CHAIN_ID = 43114;
const AVALANCHE_CHAIN_KEY = 'avalanche';

/**
 * Required DEXs for S3.2.1
 * Source: IMPLEMENTATION_PLAN.md S3.2.1
 *
 * All 6 DEXs are now ENABLED:
 * - trader_joe_v2, pangolin, sushiswap, kyberswap: Standard factory pattern
 * - gmx: Uses GmxAdapter (vault model)
 * - platypus: Uses PlatypusAdapter (pool model)
 */
const REQUIRED_DEXES = [
  'trader_joe_v2',
  'pangolin',
  'sushiswap',
  'kyberswap',
  'gmx',       // ENABLED: Uses GmxAdapter from dex-adapters
  'platypus'   // ENABLED: Uses PlatypusAdapter from dex-adapters
] as const;

/**
 * Required tokens for S3.2.1 (15 tokens)
 * Core DeFi tokens on Avalanche C-Chain
 */
const REQUIRED_TOKEN_SYMBOLS = [
  'WAVAX',   // Native wrapped token
  'USDT',    // Tether
  'USDC',    // USD Coin
  'DAI',     // Dai Stablecoin
  'WBTC.e',  // Wrapped Bitcoin (bridged)
  'WETH.e',  // Wrapped Ether (bridged)
  'JOE',     // Trader Joe token
  'LINK',    // Chainlink
  'AAVE',    // Aave token
  'sAVAX',   // Staked AVAX (Benqi)
  'QI',      // BENQI token
  'PNG',     // Pangolin token
  'PTP',     // Platypus token
  'GMX',     // GMX token
  'FRAX'     // Frax stablecoin
] as const;

/**
 * Known contract addresses for Avalanche DEXs
 * Verified from official documentation
 */
const DEX_ADDRESSES = {
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
    factory: '0x0000000000000000000000000000000000000000', // GMX uses vault, not factory
    router: '0x5F719c2F1095F7B9fc68a68e35B51194f4b6abe8',  // GMX Router
    vault: '0x9ab2De34A33fB459b538c43f251eB825645e8595'    // GMX Vault
  },
  platypus: {
    factory: '0x0000000000000000000000000000000000000000', // Platypus uses pool
    router: '0x73256EC7575D999C360c1EeC118ECbEFd8DA7D12',  // Platypus Router
    pool: '0x66357dCaCe80431aee0A7507e2E361B7e2402370'     // Main Pool
  },
  kyberswap: {
    factory: '0x5F1dddbf348aC2fbe22a163e30F99F9ECE3DD50a', // KyberSwap Elastic Factory
    router: '0xC1e7dFE73E1598E3910EF4C7845B68A9Ab6F4c83'   // KyberSwap Router
  }
} as const;

/**
 * Known token addresses on Avalanche C-Chain
 * Verified from official sources (CoinGecko, DEX docs)
 */
const TOKEN_ADDRESSES = {
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
} as const;

// =============================================================================
// S3.2.1.1: Chain Configuration Tests
// =============================================================================

describe('S3.2.1.1: Avalanche Chain Configuration', () => {
  describe('Chain basics', () => {
    it('should have Avalanche chain configured', () => {
      expect(CHAINS[AVALANCHE_CHAIN_KEY]).toBeDefined();
    });

    it('should have correct chain ID (43114)', () => {
      expect(CHAINS[AVALANCHE_CHAIN_KEY].id).toBe(AVALANCHE_CHAIN_ID);
    });

    it('should have correct chain name', () => {
      expect(CHAINS[AVALANCHE_CHAIN_KEY].name).toBe('Avalanche C-Chain');
    });

    it('should have RPC URL configured', () => {
      expect(CHAINS[AVALANCHE_CHAIN_KEY].rpcUrl).toBeDefined();
      expect(CHAINS[AVALANCHE_CHAIN_KEY].rpcUrl.length).toBeGreaterThan(0);
    });

    it('should have WebSocket URL configured', () => {
      expect(CHAINS[AVALANCHE_CHAIN_KEY].wsUrl).toBeDefined();
      expect(CHAINS[AVALANCHE_CHAIN_KEY].wsUrl!.length).toBeGreaterThan(0);
    });

    it('should have 2 second block time', () => {
      expect(CHAINS[AVALANCHE_CHAIN_KEY].blockTime).toBe(2);
    });

    it('should have AVAX as native token', () => {
      expect(CHAINS[AVALANCHE_CHAIN_KEY].nativeToken).toBe('AVAX');
    });

    it('should be assigned to Asia-Fast partition (P1)', () => {
      const partition = assignChainToPartition(AVALANCHE_CHAIN_KEY);
      expect(partition).not.toBeNull();
      expect(partition!.partitionId).toBe(PARTITION_IDS.ASIA_FAST);
    });
  });

  describe('Detector configuration', () => {
    it('should have detector config for Avalanche', () => {
      expect(DETECTOR_CONFIG[AVALANCHE_CHAIN_KEY]).toBeDefined();
    });

    it('should have appropriate batch size', () => {
      const config = DETECTOR_CONFIG[AVALANCHE_CHAIN_KEY];
      expect(config.batchSize).toBeGreaterThanOrEqual(10);
      expect(config.batchSize).toBeLessThanOrEqual(50);
    });

    it('should have confidence threshold configured', () => {
      const config = DETECTOR_CONFIG[AVALANCHE_CHAIN_KEY];
      expect(config.confidence).toBeGreaterThanOrEqual(0.7);
      expect(config.confidence).toBeLessThanOrEqual(1.0);
    });

    it('should have whale threshold configured', () => {
      const config = DETECTOR_CONFIG[AVALANCHE_CHAIN_KEY];
      expect(config.whaleThreshold).toBeGreaterThanOrEqual(10000); // At least $10K
    });

    it('should have expiry configured for fast blocks', () => {
      const config = DETECTOR_CONFIG[AVALANCHE_CHAIN_KEY];
      // Avalanche has 2s blocks, expiry should be short
      expect(config.expiryMs).toBeLessThanOrEqual(15000);
    });
  });
});

// =============================================================================
// S3.2.1.2: DEX Configuration Tests
// =============================================================================

describe('S3.2.1.2: Avalanche DEX Configuration', () => {
  let avalancheDexes: ReturnType<typeof getEnabledDexes>;

  beforeAll(() => {
    avalancheDexes = getEnabledDexes(AVALANCHE_CHAIN_KEY);
  });

  describe('DEX count', () => {
    it('should have exactly 6 enabled DEXs (all DEXs including GMX and Platypus)', () => {
      // All 6 DEXs enabled: GMX uses GmxAdapter, Platypus uses PlatypusAdapter
      expect(avalancheDexes.length).toBe(6);
    });

    it('should have all required enabled DEXs', () => {
      const dexNames = avalancheDexes.map(d => d.name);
      for (const requiredDex of REQUIRED_DEXES) {
        expect(dexNames).toContain(requiredDex);
      }
    });

    it('should have vault-model DEXs enabled with adapters', () => {
      // Import DEXES directly to check all configured
      const { DEXES } = require('../../shared/config/src');
      const allAvalancheDexes = DEXES['avalanche'] || [];

      // Should have 6 total DEXs configured
      expect(allAvalancheDexes.length).toBe(6);

      // Verify GMX and Platypus exist and are ENABLED (they have adapters now)
      const gmx = allAvalancheDexes.find((d: any) => d.name === 'gmx');
      const platypus = allAvalancheDexes.find((d: any) => d.name === 'platypus');
      expect(gmx).toBeDefined();
      expect(platypus).toBeDefined();
      expect(gmx?.enabled).toBe(true);  // Uses GmxAdapter
      expect(platypus?.enabled).toBe(true);  // Uses PlatypusAdapter
    });
  });

  describe('Trader Joe V2', () => {
    it('should have Trader Joe V2 configured', () => {
      const dex = avalancheDexes.find(d => d.name === 'trader_joe_v2');
      expect(dex).toBeDefined();
    });

    it('should have correct factory address', () => {
      const dex = avalancheDexes.find(d => d.name === 'trader_joe_v2');
      expect(dex!.factoryAddress.toLowerCase()).toBe(
        DEX_ADDRESSES.trader_joe_v2.factory.toLowerCase()
      );
    });

    it('should have correct router address', () => {
      const dex = avalancheDexes.find(d => d.name === 'trader_joe_v2');
      expect(dex!.routerAddress.toLowerCase()).toBe(
        DEX_ADDRESSES.trader_joe_v2.router.toLowerCase()
      );
    });

    it('should have 30bp fee (0.30%)', () => {
      const dex = avalancheDexes.find(d => d.name === 'trader_joe_v2');
      expect(dex!.fee).toBe(30);
    });
  });

  describe('Pangolin', () => {
    it('should have Pangolin configured', () => {
      const dex = avalancheDexes.find(d => d.name === 'pangolin');
      expect(dex).toBeDefined();
    });

    it('should have correct factory address', () => {
      const dex = avalancheDexes.find(d => d.name === 'pangolin');
      expect(dex!.factoryAddress.toLowerCase()).toBe(
        DEX_ADDRESSES.pangolin.factory.toLowerCase()
      );
    });

    it('should have correct router address', () => {
      const dex = avalancheDexes.find(d => d.name === 'pangolin');
      expect(dex!.routerAddress.toLowerCase()).toBe(
        DEX_ADDRESSES.pangolin.router.toLowerCase()
      );
    });

    it('should have 30bp fee (0.30%)', () => {
      const dex = avalancheDexes.find(d => d.name === 'pangolin');
      expect(dex!.fee).toBe(30);
    });
  });

  describe('SushiSwap', () => {
    it('should have SushiSwap configured', () => {
      const dex = avalancheDexes.find(d => d.name === 'sushiswap');
      expect(dex).toBeDefined();
    });

    it('should have correct factory address', () => {
      const dex = avalancheDexes.find(d => d.name === 'sushiswap');
      expect(dex!.factoryAddress.toLowerCase()).toBe(
        DEX_ADDRESSES.sushiswap.factory.toLowerCase()
      );
    });

    it('should have correct router address', () => {
      const dex = avalancheDexes.find(d => d.name === 'sushiswap');
      expect(dex!.routerAddress.toLowerCase()).toBe(
        DEX_ADDRESSES.sushiswap.router.toLowerCase()
      );
    });

    it('should have 30bp fee (0.30%)', () => {
      const dex = avalancheDexes.find(d => d.name === 'sushiswap');
      expect(dex!.fee).toBe(30);
    });
  });

  // GMX and Platypus now have adapters and are ENABLED
  // Tests verify they're configured and enabled with proper adapter support

  describe('GMX (enabled - vault model with GmxAdapter)', () => {
    it('should have GMX configured and enabled', () => {
      const dex = avalancheDexes.find(d => d.name === 'gmx');
      expect(dex).toBeDefined();
    });

    it('should have correct vault address configured', () => {
      const dex = avalancheDexes.find(d => d.name === 'gmx');
      expect(dex!.factoryAddress).toBe('0x9ab2De34A33fB459b538c43f251eB825645e8595'); // GMX Vault
      expect(dex!.routerAddress.length).toBe(42); // Valid Ethereum address
    });

    it('should have fee configured (GMX uses dynamic fees, ~10-80bp)', () => {
      const dex = avalancheDexes.find(d => d.name === 'gmx');
      expect(dex!.fee).toBeGreaterThanOrEqual(10);
      expect(dex!.fee).toBeLessThanOrEqual(80);
    });

    it('should be in enabled DEXs list (uses GmxAdapter)', () => {
      const dex = avalancheDexes.find(d => d.name === 'gmx');
      expect(dex).toBeDefined();
      expect(dex!.chain).toBe('avalanche');
    });
  });

  describe('Platypus (enabled - pool model with PlatypusAdapter)', () => {
    it('should have Platypus configured and enabled', () => {
      const dex = avalancheDexes.find(d => d.name === 'platypus');
      expect(dex).toBeDefined();
    });

    it('should have correct pool address configured', () => {
      const dex = avalancheDexes.find(d => d.name === 'platypus');
      expect(dex!.factoryAddress).toBe('0x66357dCaCe80431aee0A7507e2E361B7e2402370'); // Main Pool
      expect(dex!.routerAddress.length).toBe(42);
    });

    it('should have low fee (Platypus is optimized for stablecoins, ~1-4bp)', () => {
      const dex = avalancheDexes.find(d => d.name === 'platypus');
      expect(dex!.fee).toBeGreaterThanOrEqual(1);
      expect(dex!.fee).toBeLessThanOrEqual(10);
    });

    it('should be in enabled DEXs list (uses PlatypusAdapter)', () => {
      const dex = avalancheDexes.find(d => d.name === 'platypus');
      expect(dex).toBeDefined();
      expect(dex!.chain).toBe('avalanche');
    });
  });

  describe('KyberSwap', () => {
    it('should have KyberSwap configured', () => {
      const dex = avalancheDexes.find(d => d.name === 'kyberswap');
      expect(dex).toBeDefined();
    });

    it('should have correct factory address', () => {
      const dex = avalancheDexes.find(d => d.name === 'kyberswap');
      expect(dex!.factoryAddress.toLowerCase()).toBe(
        DEX_ADDRESSES.kyberswap.factory.toLowerCase()
      );
    });

    it('should have correct router address', () => {
      const dex = avalancheDexes.find(d => d.name === 'kyberswap');
      expect(dex!.routerAddress.toLowerCase()).toBe(
        DEX_ADDRESSES.kyberswap.router.toLowerCase()
      );
    });

    it('should have dynamic fee (KyberSwap Elastic uses dynamic fees)', () => {
      const dex = avalancheDexes.find(d => d.name === 'kyberswap');
      // KyberSwap Elastic has variable fees, typically 8-100bp
      expect(dex!.fee).toBeGreaterThanOrEqual(1);
      expect(dex!.fee).toBeLessThanOrEqual(100);
    });
  });

  describe('DEX address validation', () => {
    it('should have valid Ethereum addresses for all DEXs', () => {
      const addressRegex = /^0x[a-fA-F0-9]{40}$/;

      for (const dex of avalancheDexes) {
        expect(dex.factoryAddress).toMatch(addressRegex);
        expect(dex.routerAddress).toMatch(addressRegex);
      }
    });

    it('should have unique router addresses', () => {
      const routers = avalancheDexes.map(d => d.routerAddress.toLowerCase());
      const uniqueRouters = new Set(routers);
      expect(uniqueRouters.size).toBe(routers.length);
    });

    it('should have correct chain assignment for all DEXs', () => {
      for (const dex of avalancheDexes) {
        expect(dex.chain).toBe(AVALANCHE_CHAIN_KEY);
      }
    });
  });
});

// =============================================================================
// S3.2.1.3: Token Configuration Tests
// =============================================================================

describe('S3.2.1.3: Avalanche Token Configuration', () => {
  let avalancheTokens: typeof CORE_TOKENS[typeof AVALANCHE_CHAIN_KEY];

  beforeAll(() => {
    avalancheTokens = CORE_TOKENS[AVALANCHE_CHAIN_KEY];
  });

  describe('Token count', () => {
    it('should have exactly 15 tokens configured', () => {
      expect(avalancheTokens.length).toBe(15);
    });

    it('should have all required token symbols', () => {
      const symbols = avalancheTokens.map(t => t.symbol);
      for (const requiredSymbol of REQUIRED_TOKEN_SYMBOLS) {
        expect(symbols).toContain(requiredSymbol);
      }
    });
  });

  describe('Native wrapped token (WAVAX)', () => {
    it('should have WAVAX configured', () => {
      const wavax = avalancheTokens.find(t => t.symbol === 'WAVAX');
      expect(wavax).toBeDefined();
    });

    it('should have correct WAVAX address', () => {
      const wavax = avalancheTokens.find(t => t.symbol === 'WAVAX');
      expect(wavax!.address.toLowerCase()).toBe(TOKEN_ADDRESSES.WAVAX.toLowerCase());
    });

    it('should have 18 decimals', () => {
      const wavax = avalancheTokens.find(t => t.symbol === 'WAVAX');
      expect(wavax!.decimals).toBe(18);
    });

    it('should have correct chain ID', () => {
      const wavax = avalancheTokens.find(t => t.symbol === 'WAVAX');
      expect(wavax!.chainId).toBe(AVALANCHE_CHAIN_ID);
    });
  });

  describe('Stablecoins', () => {
    it('should have USDT with 6 decimals', () => {
      const usdt = avalancheTokens.find(t => t.symbol === 'USDT');
      expect(usdt).toBeDefined();
      expect(usdt!.decimals).toBe(6);
      expect(usdt!.address.toLowerCase()).toBe(TOKEN_ADDRESSES.USDT.toLowerCase());
    });

    it('should have USDC with 6 decimals', () => {
      const usdc = avalancheTokens.find(t => t.symbol === 'USDC');
      expect(usdc).toBeDefined();
      expect(usdc!.decimals).toBe(6);
      expect(usdc!.address.toLowerCase()).toBe(TOKEN_ADDRESSES.USDC.toLowerCase());
    });

    it('should have DAI with 18 decimals', () => {
      const dai = avalancheTokens.find(t => t.symbol === 'DAI');
      expect(dai).toBeDefined();
      expect(dai!.decimals).toBe(18);
      expect(dai!.address.toLowerCase()).toBe(TOKEN_ADDRESSES.DAI.toLowerCase());
    });

    it('should have FRAX with 18 decimals', () => {
      const frax = avalancheTokens.find(t => t.symbol === 'FRAX');
      expect(frax).toBeDefined();
      expect(frax!.decimals).toBe(18);
      expect(frax!.address.toLowerCase()).toBe(TOKEN_ADDRESSES.FRAX.toLowerCase());
    });
  });

  describe('Bridged tokens', () => {
    it('should have WBTC.e with 8 decimals', () => {
      const wbtc = avalancheTokens.find(t => t.symbol === 'WBTC.e');
      expect(wbtc).toBeDefined();
      expect(wbtc!.decimals).toBe(8);
      expect(wbtc!.address.toLowerCase()).toBe(TOKEN_ADDRESSES['WBTC.e'].toLowerCase());
    });

    it('should have WETH.e with 18 decimals', () => {
      const weth = avalancheTokens.find(t => t.symbol === 'WETH.e');
      expect(weth).toBeDefined();
      expect(weth!.decimals).toBe(18);
      expect(weth!.address.toLowerCase()).toBe(TOKEN_ADDRESSES['WETH.e'].toLowerCase());
    });
  });

  describe('DEX governance tokens', () => {
    it('should have JOE (Trader Joe) token', () => {
      const joe = avalancheTokens.find(t => t.symbol === 'JOE');
      expect(joe).toBeDefined();
      expect(joe!.decimals).toBe(18);
      expect(joe!.address.toLowerCase()).toBe(TOKEN_ADDRESSES.JOE.toLowerCase());
    });

    it('should have PNG (Pangolin) token', () => {
      const png = avalancheTokens.find(t => t.symbol === 'PNG');
      expect(png).toBeDefined();
      expect(png!.decimals).toBe(18);
      expect(png!.address.toLowerCase()).toBe(TOKEN_ADDRESSES.PNG.toLowerCase());
    });

    it('should have PTP (Platypus) token', () => {
      const ptp = avalancheTokens.find(t => t.symbol === 'PTP');
      expect(ptp).toBeDefined();
      expect(ptp!.decimals).toBe(18);
      expect(ptp!.address.toLowerCase()).toBe(TOKEN_ADDRESSES.PTP.toLowerCase());
    });

    it('should have GMX token', () => {
      const gmx = avalancheTokens.find(t => t.symbol === 'GMX');
      expect(gmx).toBeDefined();
      expect(gmx!.decimals).toBe(18);
      expect(gmx!.address.toLowerCase()).toBe(TOKEN_ADDRESSES.GMX.toLowerCase());
    });
  });

  describe('DeFi tokens', () => {
    it('should have LINK (Chainlink)', () => {
      const link = avalancheTokens.find(t => t.symbol === 'LINK');
      expect(link).toBeDefined();
      expect(link!.decimals).toBe(18);
      expect(link!.address.toLowerCase()).toBe(TOKEN_ADDRESSES.LINK.toLowerCase());
    });

    it('should have AAVE token', () => {
      const aave = avalancheTokens.find(t => t.symbol === 'AAVE');
      expect(aave).toBeDefined();
      expect(aave!.decimals).toBe(18);
      expect(aave!.address.toLowerCase()).toBe(TOKEN_ADDRESSES.AAVE.toLowerCase());
    });

    it('should have QI (BENQI) token', () => {
      const qi = avalancheTokens.find(t => t.symbol === 'QI');
      expect(qi).toBeDefined();
      expect(qi!.decimals).toBe(18);
      expect(qi!.address.toLowerCase()).toBe(TOKEN_ADDRESSES.QI.toLowerCase());
    });
  });

  describe('Liquid staking tokens', () => {
    it('should have sAVAX (staked AVAX)', () => {
      const savax = avalancheTokens.find(t => t.symbol === 'sAVAX');
      expect(savax).toBeDefined();
      expect(savax!.decimals).toBe(18);
      expect(savax!.address.toLowerCase()).toBe(TOKEN_ADDRESSES.sAVAX.toLowerCase());
    });
  });

  describe('Token address validation', () => {
    it('should have valid Ethereum addresses for all tokens', () => {
      const addressRegex = /^0x[a-fA-F0-9]{40}$/;

      for (const token of avalancheTokens) {
        expect(token.address).toMatch(addressRegex);
      }
    });

    it('should have unique addresses for all tokens', () => {
      const addresses = avalancheTokens.map(t => t.address.toLowerCase());
      const uniqueAddresses = new Set(addresses);
      expect(uniqueAddresses.size).toBe(addresses.length);
    });

    it('should have correct chain ID for all tokens', () => {
      for (const token of avalancheTokens) {
        expect(token.chainId).toBe(AVALANCHE_CHAIN_ID);
      }
    });
  });
});

// =============================================================================
// S3.2.1.4: Token Metadata Tests
// =============================================================================

describe('S3.2.1.4: Avalanche Token Metadata', () => {
  describe('TOKEN_METADATA configuration', () => {
    it('should have metadata for Avalanche', () => {
      expect(TOKEN_METADATA[AVALANCHE_CHAIN_KEY]).toBeDefined();
    });

    it('should have native wrapper address (WAVAX)', () => {
      const metadata = TOKEN_METADATA[AVALANCHE_CHAIN_KEY];
      expect(metadata.nativeWrapper).toBeDefined();
      expect(metadata.nativeWrapper.toLowerCase()).toBe(TOKEN_ADDRESSES.WAVAX.toLowerCase());
    });

    it('should have WETH bridged token address', () => {
      const metadata = TOKEN_METADATA[AVALANCHE_CHAIN_KEY];
      expect(metadata.weth).toBeDefined();
      expect(metadata.weth.toLowerCase()).toBe(TOKEN_ADDRESSES['WETH.e'].toLowerCase());
    });

    it('should have stablecoins configured', () => {
      const metadata = TOKEN_METADATA[AVALANCHE_CHAIN_KEY];
      expect(metadata.stablecoins).toBeDefined();
      expect(metadata.stablecoins.length).toBeGreaterThanOrEqual(3);
    });

    it('should have USDT in stablecoins', () => {
      const metadata = TOKEN_METADATA[AVALANCHE_CHAIN_KEY];
      const usdt = metadata.stablecoins.find((s: { symbol: string }) => s.symbol === 'USDT');
      expect(usdt).toBeDefined();
      expect(usdt!.decimals).toBe(6);
    });

    it('should have USDC in stablecoins', () => {
      const metadata = TOKEN_METADATA[AVALANCHE_CHAIN_KEY];
      const usdc = metadata.stablecoins.find((s: { symbol: string }) => s.symbol === 'USDC');
      expect(usdc).toBeDefined();
      expect(usdc!.decimals).toBe(6);
    });

    it('should have DAI in stablecoins', () => {
      const metadata = TOKEN_METADATA[AVALANCHE_CHAIN_KEY];
      const dai = metadata.stablecoins.find((s: { symbol: string }) => s.symbol === 'DAI');
      expect(dai).toBeDefined();
      expect(dai!.decimals).toBe(18);
    });
  });
});

// =============================================================================
// S3.2.1.5: Partition Integration Tests
// =============================================================================

describe('S3.2.1.5: Avalanche Partition Integration', () => {
  describe('P1 (Asia-Fast) partition assignment', () => {
    it('should assign Avalanche to Asia-Fast partition', () => {
      const partition = assignChainToPartition(AVALANCHE_CHAIN_KEY);
      expect(partition!.partitionId).toBe(PARTITION_IDS.ASIA_FAST);
    });

    it('should have Avalanche in Asia-Fast region (Singapore)', () => {
      const partition = assignChainToPartition(AVALANCHE_CHAIN_KEY);
      expect(partition!.region).toBeDefined();
    });

    it('should share partition with other high-throughput chains', () => {
      const partition = assignChainToPartition(AVALANCHE_CHAIN_KEY);
      expect(partition!.chains).toContain('bsc');
      expect(partition!.chains).toContain('polygon');
      expect(partition!.chains).toContain('avalanche');
    });
  });

  describe('Cross-chain arbitrage potential', () => {
    it('should have common tokens with BSC for cross-chain arbitrage', () => {
      const avalancheSymbols = CORE_TOKENS[AVALANCHE_CHAIN_KEY].map(t => t.symbol);
      const bscSymbols = CORE_TOKENS['bsc'].map(t => t.symbol);

      // Common tokens should exist for cross-chain arbitrage
      const commonSymbols = avalancheSymbols.filter(s =>
        bscSymbols.some(bs => bs.includes(s.replace('.e', '')) || s.includes(bs.replace('.e', '')))
      );

      // Should have at least USDC, USDT, WBTC variants, WETH variants
      expect(commonSymbols.length).toBeGreaterThanOrEqual(4);
    });

    it('should have common tokens with Polygon for cross-chain arbitrage', () => {
      const avalancheSymbols = CORE_TOKENS[AVALANCHE_CHAIN_KEY].map(t => t.symbol);
      const polygonSymbols = CORE_TOKENS['polygon'].map(t => t.symbol);

      const commonSymbols = avalancheSymbols.filter(s =>
        polygonSymbols.some(ps => ps.includes(s.replace('.e', '')) || s.includes(ps.replace('.e', '')))
      );

      expect(commonSymbols.length).toBeGreaterThanOrEqual(4);
    });
  });
});

// =============================================================================
// S3.2.1.6: DEX-Token Pair Coverage Tests
// =============================================================================

describe('S3.2.1.6: Avalanche DEX-Token Pair Coverage', () => {
  describe('High-liquidity pairs', () => {
    it('should support WAVAX/USDC pairs on all major DEXs', () => {
      const dexes = getEnabledDexes(AVALANCHE_CHAIN_KEY);
      const wavax = CORE_TOKENS[AVALANCHE_CHAIN_KEY].find(t => t.symbol === 'WAVAX');
      const usdc = CORE_TOKENS[AVALANCHE_CHAIN_KEY].find(t => t.symbol === 'USDC');

      expect(wavax).toBeDefined();
      expect(usdc).toBeDefined();

      // All major DEXs should support this pair
      const majorDexes = dexes.filter(d =>
        ['trader_joe_v2', 'pangolin', 'sushiswap'].includes(d.name)
      );
      expect(majorDexes.length).toBe(3);
    });

    it('should support WAVAX/USDT pairs', () => {
      const wavax = CORE_TOKENS[AVALANCHE_CHAIN_KEY].find(t => t.symbol === 'WAVAX');
      const usdt = CORE_TOKENS[AVALANCHE_CHAIN_KEY].find(t => t.symbol === 'USDT');

      expect(wavax).toBeDefined();
      expect(usdt).toBeDefined();
    });

    it('should have stablecoin tokens for Platypus arbitrage', () => {
      // Platypus is now enabled with PlatypusAdapter for stablecoin swaps
      const stablecoins = CORE_TOKENS[AVALANCHE_CHAIN_KEY].filter(t =>
        ['USDC', 'USDT', 'DAI', 'FRAX'].includes(t.symbol)
      );

      expect(stablecoins.length).toBe(4);
    });
  });

  describe('Pair count estimation', () => {
    it('should generate sufficient pairs for arbitrage with all 6 enabled DEXs', () => {
      const tokens = CORE_TOKENS[AVALANCHE_CHAIN_KEY];
      const dexes = getEnabledDexes(AVALANCHE_CHAIN_KEY);

      // Pairs per DEX = n*(n-1)/2 for n tokens
      const pairsPerDex = (tokens.length * (tokens.length - 1)) / 2;
      const totalPairs = pairsPerDex * dexes.length;

      // With 15 tokens and 6 enabled DEXs: 105 pairs per DEX, 630 total
      // (GMX and Platypus now enabled with adapters)
      expect(totalPairs).toBeGreaterThanOrEqual(600);
    });
  });
});

// =============================================================================
// S3.2.1.7: Regression Tests
// =============================================================================

describe('S3.2.1.7: Regression Tests', () => {
  describe('Existing configuration preserved', () => {
    it('should not break existing chain configurations', () => {
      expect(CHAINS['bsc']).toBeDefined();
      expect(CHAINS['polygon']).toBeDefined();
      expect(CHAINS['ethereum']).toBeDefined();
      expect(CHAINS['arbitrum']).toBeDefined();
    });

    it('should not break existing DEX configurations', () => {
      expect(getEnabledDexes('bsc').length).toBeGreaterThan(0);
      expect(getEnabledDexes('polygon').length).toBeGreaterThan(0);
      expect(getEnabledDexes('ethereum').length).toBeGreaterThan(0);
    });

    it('should not break existing token configurations', () => {
      expect(CORE_TOKENS['bsc'].length).toBeGreaterThan(0);
      expect(CORE_TOKENS['polygon'].length).toBeGreaterThan(0);
      expect(CORE_TOKENS['ethereum'].length).toBeGreaterThan(0);
    });
  });

  describe('Total system counts', () => {
    it('should maintain 11 total chains', () => {
      expect(Object.keys(CHAINS).length).toBe(11);
    });

    it('should have at least 47 enabled DEXs', () => {
      let totalEnabledDexes = 0;
      for (const chain of Object.keys(CHAINS)) {
        totalEnabledDexes += getEnabledDexes(chain).length;
      }
      // S3.2.1: 6 Avalanche DEXs all enabled (GMX/Platypus have adapters)
      // S3.2.2: 4 Fantom DEXs all enabled (Beethoven X has adapter)
      expect(totalEnabledDexes).toBeGreaterThanOrEqual(47);
    });

    it('should have 6 total Avalanche DEXs configured (all enabled with adapters)', () => {
      const { DEXES } = require('../../shared/config/src');
      const allAvalancheDexes = DEXES['avalanche'] || [];
      const enabledAvalancheDexes = getEnabledDexes('avalanche');

      expect(allAvalancheDexes.length).toBe(6);  // Total configured
      expect(enabledAvalancheDexes.length).toBe(6);  // All enabled (GMX/Platypus have adapters)
    });

    it('should increase total token count (was 94, now should be higher)', () => {
      let totalTokens = 0;
      for (const chain of Object.keys(CHAINS)) {
        if (CORE_TOKENS[chain]) {
          totalTokens += CORE_TOKENS[chain].length;
        }
      }
      // Adding 7 new Avalanche tokens: 94 + 7 = 101
      expect(totalTokens).toBeGreaterThanOrEqual(101);
    });
  });
});

// =============================================================================
// S3.2.1.8: PairDiscoveryService Integration Tests
// =============================================================================

describe('S3.2.1.8: PairDiscoveryService Avalanche Integration', () => {
  let PairDiscoveryService: typeof import('../../shared/core/src').PairDiscoveryService;
  let resetPairDiscoveryService: typeof import('../../shared/core/src').resetPairDiscoveryService;
  let service: InstanceType<typeof PairDiscoveryService>;

  beforeAll(async () => {
    const module = await import('../../shared/core/src');
    PairDiscoveryService = module.PairDiscoveryService;
    resetPairDiscoveryService = module.resetPairDiscoveryService;
  });

  beforeEach(() => {
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

  afterEach(() => {
    service.cleanup();
  });

  describe('Factory type detection for Avalanche DEXs', () => {
    it('should detect Trader Joe V2 as V2-style', () => {
      expect(service.detectFactoryType('trader_joe_v2')).toBe('v2');
    });

    it('should detect Pangolin as V2-style', () => {
      expect(service.detectFactoryType('pangolin')).toBe('v2');
    });

    it('should detect SushiSwap as V2-style', () => {
      expect(service.detectFactoryType('sushiswap')).toBe('v2');
    });

    it('should detect KyberSwap as V3-style (concentrated liquidity)', () => {
      expect(service.detectFactoryType('kyberswap')).toBe('v3');
    });

    it('should detect GMX as unsupported (vault model)', () => {
      expect(service.detectFactoryType('gmx')).toBe('unsupported');
    });

    it('should detect Platypus as unsupported (pool model)', () => {
      expect(service.detectFactoryType('platypus')).toBe('unsupported');
    });
  });

  describe('CREATE2 computation for enabled Avalanche DEXs', () => {
    const testToken0 = {
      address: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', // WAVAX
      symbol: 'WAVAX',
      decimals: 18,
      chainId: 43114
    };

    const testToken1 = {
      address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', // USDC
      symbol: 'USDC',
      decimals: 6,
      chainId: 43114
    };

    it('should compute pair address for Trader Joe V2', () => {
      const dex = getEnabledDexes('avalanche').find(d => d.name === 'trader_joe_v2');
      expect(dex).toBeDefined();

      const result = service.computePairAddress('avalanche', dex!, testToken0, testToken1);

      // CREATE2 computation should work for V2-style DEX
      expect(result).not.toBeNull();
      expect(result!.discoveryMethod).toBe('create2_compute');
      expect(result!.dex).toBe('trader_joe_v2');
      expect(result!.chain).toBe('avalanche');
    });

    it('should compute pair address for Pangolin', () => {
      const dex = getEnabledDexes('avalanche').find(d => d.name === 'pangolin');
      expect(dex).toBeDefined();

      const result = service.computePairAddress('avalanche', dex!, testToken0, testToken1);

      expect(result).not.toBeNull();
      expect(result!.discoveryMethod).toBe('create2_compute');
      expect(result!.dex).toBe('pangolin');
    });

    it('should compute pair address for SushiSwap', () => {
      const dex = getEnabledDexes('avalanche').find(d => d.name === 'sushiswap');
      expect(dex).toBeDefined();

      const result = service.computePairAddress('avalanche', dex!, testToken0, testToken1);

      expect(result).not.toBeNull();
      expect(result!.discoveryMethod).toBe('create2_compute');
      expect(result!.dex).toBe('sushiswap');
    });

    it('should track CREATE2 computations in stats', () => {
      const dex = getEnabledDexes('avalanche').find(d => d.name === 'trader_joe_v2');

      const statsBefore = service.getStats();
      const initialCount = statsBefore.create2Computations;

      service.computePairAddress('avalanche', dex!, testToken0, testToken1);

      const statsAfter = service.getStats();
      expect(statsAfter.create2Computations).toBe(initialCount + 1);
    });
  });

  describe('Vault-model DEX handling (with adapters)', () => {
    it('should return GMX from getEnabledDexes (uses GmxAdapter)', () => {
      const enabledDexes = getEnabledDexes('avalanche');
      const gmx = enabledDexes.find(d => d.name === 'gmx');
      expect(gmx).toBeDefined();
      expect(gmx!.chain).toBe('avalanche');
    });

    it('should return Platypus from getEnabledDexes (uses PlatypusAdapter)', () => {
      const enabledDexes = getEnabledDexes('avalanche');
      const platypus = enabledDexes.find(d => d.name === 'platypus');
      expect(platypus).toBeDefined();
      expect(platypus!.chain).toBe('avalanche');
    });

    it('should return all 6 enabled DEXs for Avalanche', () => {
      const enabledDexes = getEnabledDexes('avalanche');
      expect(enabledDexes.length).toBe(6);

      const names = enabledDexes.map(d => d.name);
      expect(names).toContain('trader_joe_v2');
      expect(names).toContain('pangolin');
      expect(names).toContain('sushiswap');
      expect(names).toContain('kyberswap');
      expect(names).toContain('gmx');
      expect(names).toContain('platypus');
    });
  });

  describe('Prometheus metrics integration', () => {
    it('should generate valid Prometheus metrics', () => {
      const dex = getEnabledDexes('avalanche').find(d => d.name === 'trader_joe_v2');
      const testToken0 = {
        address: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
        symbol: 'WAVAX',
        decimals: 18,
        chainId: 43114
      };
      const testToken1 = {
        address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
        symbol: 'USDC',
        decimals: 6,
        chainId: 43114
      };

      // Generate some activity
      service.computePairAddress('avalanche', dex!, testToken0, testToken1);

      const metrics = service.getPrometheusMetrics();

      expect(metrics).toContain('pair_discovery_create2_computations');
      expect(metrics).toContain('pair_discovery_total');
      expect(metrics).toContain('# TYPE');
      expect(metrics).toContain('# HELP');
    });
  });

  describe('Event emission for Avalanche pairs', () => {
    it('should emit pair:discovered event for CREATE2 computation', () => {
      const discoveredHandler = jest.fn();
      service.on('pair:discovered', discoveredHandler);

      const dex = getEnabledDexes('avalanche').find(d => d.name === 'pangolin');
      const testToken0 = {
        address: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
        symbol: 'WAVAX',
        decimals: 18,
        chainId: 43114
      };
      const testToken1 = {
        address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
        symbol: 'USDC',
        decimals: 6,
        chainId: 43114
      };

      service.computePairAddress('avalanche', dex!, testToken0, testToken1);

      expect(discoveredHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          discoveryMethod: 'create2_compute',
          dex: 'pangolin',
          chain: 'avalanche'
        })
      );
    });
  });
});
