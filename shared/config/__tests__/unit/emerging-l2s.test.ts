/**
 * Emerging L2s Configuration Validation Tests
 *
 * Validates that Blast, Scroll, Mantle, and Mode chain configurations
 * are properly integrated across all config modules:
 * - Chain entries in CHAINS with correct chain IDs
 * - DEX entries with minimum expected count
 * - Token entries in CORE_TOKENS
 * - MAINNET_CHAIN_IDS inclusion
 * - SUPPORTED_EXECUTION_CHAINS inclusion
 * - Partition assignment to P2 (l2-turbo)
 * - Flash loan availability entries
 * - MEV config entries
 *
 * @see Group 1B: Emerging L2s (Blast, Scroll, Mantle, Mode)
 */

import { describe, it, expect } from '@jest/globals';

import {
  CHAINS,
  MAINNET_CHAIN_IDS,
  DEXES,
  getEnabledDexes,
  CORE_TOKENS,
  TOKEN_METADATA,
  FLASH_LOAN_AVAILABILITY,
  isExecutionSupported,
  MEV_CONFIG,
  NATIVE_TOKEN_PRICES,
  assignChainToPartition,
  PARTITION_IDS,
  getBridgeCost,
  getAllBridgeOptions,
} from '@arbitrage/config';

// =============================================================================
// Test Data
// =============================================================================

interface EmergingL2TestData {
  chainKey: string;
  chainId: number;
  chainName: string;
  nativeToken: string;
  blockTime: number;
  minDexCount: number;
  minTokenCount: number;
  requiredTokenSymbols: string[];
  mevStrategy: string;
}

const EMERGING_L2_CHAINS: EmergingL2TestData[] = [
  {
    chainKey: 'blast',
    chainId: 81457,
    chainName: 'Blast',
    nativeToken: 'ETH',
    blockTime: 2,
    minDexCount: 3,
    minTokenCount: 5,
    requiredTokenSymbols: ['WETH', 'USDB', 'BLAST', 'WBTC', 'MIM'],
    mevStrategy: 'sequencer',
  },
  {
    chainKey: 'scroll',
    chainId: 534352,
    chainName: 'Scroll',
    nativeToken: 'ETH',
    blockTime: 3,
    minDexCount: 3,
    minTokenCount: 7,
    requiredTokenSymbols: ['WETH', 'USDC', 'USDT', 'DAI', 'WBTC', 'wstETH', 'SCR'],
    mevStrategy: 'sequencer',
  },
  {
    chainKey: 'mantle',
    chainId: 5000,
    chainName: 'Mantle',
    nativeToken: 'MNT',
    blockTime: 2,
    minDexCount: 3,
    minTokenCount: 2,
    requiredTokenSymbols: ['WMNT', 'USDC'],
    mevStrategy: 'sequencer',
  },
  {
    chainKey: 'mode',
    chainId: 34443,
    chainName: 'Mode',
    nativeToken: 'ETH',
    blockTime: 2,
    minDexCount: 3,
    minTokenCount: 2,
    requiredTokenSymbols: ['WETH', 'USDC'],
    mevStrategy: 'sequencer',
  },
];

// =============================================================================
// Parameterized Tests
// =============================================================================

describe('Emerging L2s Configuration', () => {
  describe.each(EMERGING_L2_CHAINS)(
    '$chainKey (chain ID: $chainId)',
    (chainData) => {
      // -----------------------------------------------------------------------
      // Chain Configuration
      // -----------------------------------------------------------------------
      describe('Chain entry', () => {
        it('exists in CHAINS', () => {
          expect(CHAINS[chainData.chainKey]).toBeDefined();
        });

        it('has correct chain ID', () => {
          expect(CHAINS[chainData.chainKey].id).toBe(chainData.chainId);
        });

        it('has correct name', () => {
          expect(CHAINS[chainData.chainKey].name).toBe(chainData.chainName);
        });

        it('has correct native token', () => {
          expect(CHAINS[chainData.chainKey].nativeToken).toBe(chainData.nativeToken);
        });

        it('has correct block time', () => {
          expect(CHAINS[chainData.chainKey].blockTime).toBe(chainData.blockTime);
        });

        it('has RPC URL configured', () => {
          expect(CHAINS[chainData.chainKey].rpcUrl).toBeDefined();
          expect(typeof CHAINS[chainData.chainKey].rpcUrl).toBe('string');
          expect(CHAINS[chainData.chainKey].rpcUrl.length).toBeGreaterThan(0);
        });

        it('has WebSocket URL configured', () => {
          const chain = CHAINS[chainData.chainKey];
          expect(chain.wsUrl).toBeDefined();
          expect(typeof chain.wsUrl).toBe('string');
          expect(chain.wsUrl!.length).toBeGreaterThan(0);
        });

        it('has RPC fallback URLs', () => {
          expect(CHAINS[chainData.chainKey].rpcFallbackUrls).toBeDefined();
          expect(Array.isArray(CHAINS[chainData.chainKey].rpcFallbackUrls)).toBe(true);
          expect(CHAINS[chainData.chainKey].rpcFallbackUrls!.length).toBeGreaterThan(0);
        });

        it('has WebSocket fallback URLs', () => {
          expect(CHAINS[chainData.chainKey].wsFallbackUrls).toBeDefined();
          expect(Array.isArray(CHAINS[chainData.chainKey].wsFallbackUrls)).toBe(true);
          expect(CHAINS[chainData.chainKey].wsFallbackUrls!.length).toBeGreaterThan(0);
        });
      });

      // -----------------------------------------------------------------------
      // MAINNET_CHAIN_IDS
      // -----------------------------------------------------------------------
      describe('MAINNET_CHAIN_IDS', () => {
        it('includes chain in MAINNET_CHAIN_IDS', () => {
          expect((MAINNET_CHAIN_IDS as readonly string[]).includes(chainData.chainKey)).toBe(true);
        });
      });

      // -----------------------------------------------------------------------
      // DEX Configuration
      // -----------------------------------------------------------------------
      describe('DEX entries', () => {
        it('has DEX entries in DEXES', () => {
          expect(DEXES[chainData.chainKey]).toBeDefined();
          expect(Array.isArray(DEXES[chainData.chainKey])).toBe(true);
        });

        it(`has at least ${chainData.minDexCount} DEX entries`, () => {
          expect(DEXES[chainData.chainKey].length).toBeGreaterThanOrEqual(chainData.minDexCount);
        });

        it('all DEX entries have correct chain', () => {
          for (const dex of DEXES[chainData.chainKey]) {
            expect(dex.chain).toBe(chainData.chainKey);
          }
        });

        it('all DEX entries have valid addresses', () => {
          for (const dex of DEXES[chainData.chainKey]) {
            expect(dex.factoryAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
            expect(dex.routerAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
          }
        });

        it('all DEX entries have fee configured', () => {
          for (const dex of DEXES[chainData.chainKey]) {
            expect(dex.feeBps).toBeDefined();
            expect(typeof dex.feeBps).toBe('number');
            expect(dex.feeBps).toBeGreaterThanOrEqual(0);
          }
        });

        it('getEnabledDexes returns DEXes for chain', () => {
          const enabled = getEnabledDexes(chainData.chainKey);
          expect(enabled.length).toBeGreaterThan(0);
        });
      });

      // -----------------------------------------------------------------------
      // Token Configuration
      // -----------------------------------------------------------------------
      describe('Token entries', () => {
        it('has token entries in CORE_TOKENS', () => {
          expect(CORE_TOKENS[chainData.chainKey]).toBeDefined();
          expect(Array.isArray(CORE_TOKENS[chainData.chainKey])).toBe(true);
        });

        it(`has at least ${chainData.minTokenCount} tokens`, () => {
          expect(CORE_TOKENS[chainData.chainKey].length).toBeGreaterThanOrEqual(chainData.minTokenCount);
        });

        it('includes required token symbols', () => {
          const tokenSymbols = CORE_TOKENS[chainData.chainKey].map(t => t.symbol);
          for (const required of chainData.requiredTokenSymbols) {
            expect(tokenSymbols).toContain(required);
          }
        });

        it('all tokens have correct chainId', () => {
          for (const token of CORE_TOKENS[chainData.chainKey]) {
            expect(token.chainId).toBe(chainData.chainId);
          }
        });

        it('all tokens have valid addresses', () => {
          for (const token of CORE_TOKENS[chainData.chainKey]) {
            expect(token.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
          }
        });

        it('has TOKEN_METADATA entry', () => {
          expect(TOKEN_METADATA[chainData.chainKey]).toBeDefined();
          expect(TOKEN_METADATA[chainData.chainKey].weth).toBeDefined();
          expect(TOKEN_METADATA[chainData.chainKey].nativeWrapper).toBeDefined();
          expect(TOKEN_METADATA[chainData.chainKey].stablecoins).toBeDefined();
          expect(TOKEN_METADATA[chainData.chainKey].stablecoins.length).toBeGreaterThan(0);
        });

        it('has NATIVE_TOKEN_PRICES entry', () => {
          expect(NATIVE_TOKEN_PRICES[chainData.chainKey]).toBeDefined();
          expect(typeof NATIVE_TOKEN_PRICES[chainData.chainKey]).toBe('number');
          expect(NATIVE_TOKEN_PRICES[chainData.chainKey]).toBeGreaterThan(0);
        });
      });

      // -----------------------------------------------------------------------
      // Execution Support
      // -----------------------------------------------------------------------
      describe('Execution support', () => {
        it('is in SUPPORTED_EXECUTION_CHAINS', () => {
          expect(isExecutionSupported(chainData.chainKey)).toBe(true);
        });
      });

      // -----------------------------------------------------------------------
      // Partition Assignment
      // -----------------------------------------------------------------------
      describe('Partition assignment', () => {
        it('is assigned to expected partition', () => {
          const partition = assignChainToPartition(chainData.chainKey);
          expect(partition).not.toBeNull();
          // Scroll and Blast are fully supported in P2 (l2-turbo) with real DEX addresses
          // Mantle and Mode remain stubs — they fall through to HIGH_VALUE default
          if (chainData.chainKey === 'scroll' || chainData.chainKey === 'blast') {
            expect(partition!.partitionId).toBe(PARTITION_IDS.L2_TURBO);
          } else {
            expect(partition!.partitionId).toBe(PARTITION_IDS.HIGH_VALUE);
          }
        });
      });

      // -----------------------------------------------------------------------
      // Flash Loan Availability
      // -----------------------------------------------------------------------
      describe('Flash loan availability', () => {
        it('has entry in FLASH_LOAN_AVAILABILITY', () => {
          expect(FLASH_LOAN_AVAILABILITY[chainData.chainKey]).toBeDefined();
        });

        it('has all protocol keys', () => {
          const entry = FLASH_LOAN_AVAILABILITY[chainData.chainKey];
          expect(entry).toHaveProperty('aave_v3');
          expect(entry).toHaveProperty('balancer_v2');
          expect(entry).toHaveProperty('pancakeswap_v3');
          expect(entry).toHaveProperty('syncswap');
          expect(entry).toHaveProperty('dai_flash_mint');
        });
      });

      // -----------------------------------------------------------------------
      // MEV Configuration
      // -----------------------------------------------------------------------
      describe('MEV configuration', () => {
        it('has chain settings in MEV_CONFIG', () => {
          expect(MEV_CONFIG.chainSettings[chainData.chainKey]).toBeDefined();
        });

        it(`uses ${chainData.mevStrategy} strategy`, () => {
          expect(MEV_CONFIG.chainSettings[chainData.chainKey].strategy).toBe(chainData.mevStrategy);
        });

        it('is enabled', () => {
          expect(MEV_CONFIG.chainSettings[chainData.chainKey].enabled).toBe(true);
        });
      });
    }
  );

  // ===========================================================================
  // Cross-Chain Validation
  // ===========================================================================

  describe('Cross-chain validation', () => {
    it('all 4 emerging L2s are present in CHAINS', () => {
      const emergingChains = ['blast', 'scroll', 'mantle', 'mode'];
      for (const chain of emergingChains) {
        expect(CHAINS[chain]).toBeDefined();
      }
    });

    it('total chain count is now 15', () => {
      expect(Object.keys(CHAINS).length).toBe(15);
    });

    it('MAINNET_CHAIN_IDS has 15 entries', () => {
      expect(MAINNET_CHAIN_IDS.length).toBe(15);
    });

    it('P2 partition has 5 chains (Scroll and Blast added with real DEX addresses)', () => {
      const p2 = assignChainToPartition('arbitrum');
      expect(p2).not.toBeNull();
      expect(p2!.chains.length).toBe(5);
      expect(p2!.chains).toContain('arbitrum');
      expect(p2!.chains).toContain('optimism');
      expect(p2!.chains).toContain('base');
      expect(p2!.chains).toContain('scroll');
      expect(p2!.chains).toContain('blast');
      // Mantle and Mode remain stubs — not in P2:
      expect(p2!.chains).not.toContain('mantle');
      expect(p2!.chains).not.toContain('mode');
    });

    it('Scroll has SyncSwap and Aave V3 flash loan support', () => {
      expect(FLASH_LOAN_AVAILABILITY['scroll']?.syncswap).toBe(true);
      expect(FLASH_LOAN_AVAILABILITY['scroll']?.aave_v3).toBe(true);
    });

    it('Blast, Mantle, Mode have no flash loan support', () => {
      for (const chain of ['blast', 'mantle', 'mode']) {
        const entry = FLASH_LOAN_AVAILABILITY[chain];
        const hasAnySupport = Object.values(entry).some(v => v === true);
        expect(hasAnySupport).toBe(false);
      }
    });

    it('Scroll has bridge routes configured', () => {
      const scrollFromEth = getBridgeCost('ethereum', 'scroll');
      expect(scrollFromEth).toBeDefined();
      expect(scrollFromEth!.feeBps).toBeGreaterThanOrEqual(0);

      const scrollToEth = getBridgeCost('scroll', 'ethereum');
      expect(scrollToEth).toBeDefined();

      const allScrollFromEth = getAllBridgeOptions('ethereum', 'scroll');
      expect(allScrollFromEth.length).toBeGreaterThanOrEqual(2);
    });

    it('Blast has bridge routes configured', () => {
      const blastFromEth = getBridgeCost('ethereum', 'blast');
      expect(blastFromEth).toBeDefined();
      expect(blastFromEth!.feeBps).toBeGreaterThanOrEqual(0);

      const blastToEth = getBridgeCost('blast', 'ethereum');
      expect(blastToEth).toBeDefined();

      const allBlastFromEth = getAllBridgeOptions('ethereum', 'blast');
      expect(allBlastFromEth.length).toBeGreaterThanOrEqual(2);
    });
  });
});
