import type { ArbitrageOpportunity } from '@arbitrage/types';
import {
  resolveTestnetChain,
  hasTestnetSupport,
  isKnownTestnet,
  getMainnetEquivalent,
  resolveTestnetTokenAddress,
  getTestnetRouter,
  getTestnetRouters,
  getTestnetFlashLoanContract,
  transformOpportunityForTestnet,
} from '../../../src/services/testnet-resolver';

describe('testnet-resolver', () => {
  // =========================================================================
  // Step 4: Chain Name Resolution
  // =========================================================================

  describe('resolveTestnetChain', () => {
    it.each([
      ['ethereum', 'sepolia'],
      ['arbitrum', 'arbitrumSepolia'],
      ['base', 'baseSepolia'],
      ['zksync', 'zksync-testnet'],
    ])('maps %s to %s', (mainnet, testnet) => {
      expect(resolveTestnetChain(mainnet)).toBe(testnet);
    });

    it.each(['polygon', 'bsc', 'solana'])(
      'returns original chain for unsupported %s',
      (chain) => {
        expect(resolveTestnetChain(chain)).toBe(chain);
      }
    );
  });

  describe('hasTestnetSupport', () => {
    it.each(['ethereum', 'arbitrum', 'base', 'zksync'])(
      'returns true for %s',
      (chain) => {
        expect(hasTestnetSupport(chain)).toBe(true);
      }
    );

    it.each(['polygon', 'bsc', 'avalanche', 'solana'])(
      'returns false for %s',
      (chain) => {
        expect(hasTestnetSupport(chain)).toBe(false);
      }
    );
  });

  describe('isKnownTestnet', () => {
    it.each(['sepolia', 'arbitrumSepolia', 'baseSepolia', 'zksync-testnet'])(
      'identifies %s as testnet',
      (chain) => {
        expect(isKnownTestnet(chain)).toBe(true);
      }
    );

    it.each(['ethereum', 'arbitrum'])(
      'rejects mainnet %s',
      (chain) => {
        expect(isKnownTestnet(chain)).toBe(false);
      }
    );
  });

  describe('getMainnetEquivalent', () => {
    it.each([
      ['sepolia', 'ethereum'],
      ['arbitrumSepolia', 'arbitrum'],
    ])('maps %s back to %s', (testnet, mainnet) => {
      expect(getMainnetEquivalent(testnet)).toBe(mainnet);
    });

    it('returns undefined for unknown chains', () => {
      expect(getMainnetEquivalent('ethereum')).toBeUndefined();
    });
  });

  // =========================================================================
  // Step 5: Token Address Resolution
  // =========================================================================

  describe('resolveTestnetTokenAddress', () => {
    it('maps Ethereum WETH to Sepolia WETH', () => {
      const mainnetWeth = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
      const testnetWeth = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14';
      expect(resolveTestnetTokenAddress('ethereum', mainnetWeth)).toBe(testnetWeth);
    });

    it('maps Ethereum USDC to Sepolia USDC', () => {
      const mainnetUsdc = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
      const testnetUsdc = '0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8';
      expect(resolveTestnetTokenAddress('ethereum', mainnetUsdc)).toBe(testnetUsdc);
    });

    it('maps Arbitrum WETH to Arbitrum Sepolia WETH', () => {
      const mainnetWeth = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
      const testnetWeth = '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73';
      expect(resolveTestnetTokenAddress('arbitrum', mainnetWeth)).toBe(testnetWeth);
    });

    it('is case-insensitive for address lookup', () => {
      const lowerCase = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
      const mixedCase = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
      const result1 = resolveTestnetTokenAddress('ethereum', lowerCase);
      const result2 = resolveTestnetTokenAddress('ethereum', mixedCase);
      expect(result1).toBe(result2);
    });

    it('returns original address if no mapping exists', () => {
      const unknownToken = '0x1234567890abcdef1234567890abcdef12345678';
      expect(resolveTestnetTokenAddress('ethereum', unknownToken)).toBe(unknownToken);
    });

    it('returns original address if chain has no token map', () => {
      const weth = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
      expect(resolveTestnetTokenAddress('polygon', weth)).toBe(weth);
    });

    it('maps Base WETH predeploy correctly', () => {
      const baseWeth = '0x4200000000000000000000000000000000000006';
      // Base WETH predeploy is same address on testnet
      expect(resolveTestnetTokenAddress('base', baseWeth)).toBe(baseWeth);
    });
  });

  // =========================================================================
  // Step 6: Router & Contract Resolution
  // =========================================================================

  describe('getTestnetRouter', () => {
    it('returns primary router for sepolia', () => {
      expect(getTestnetRouter('sepolia')).toBe('0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008');
    });

    it('returns primary router for arbitrumSepolia', () => {
      expect(getTestnetRouter('arbitrumSepolia')).toBe('0x101F443B4d1b059569D643917553c771E1b9663E');
    });

    it('returns undefined for unknown chain', () => {
      expect(getTestnetRouter('polygon')).toBeUndefined();
    });
  });

  describe('getTestnetRouters', () => {
    it('returns all routers for arbitrumSepolia', () => {
      const routers = getTestnetRouters('arbitrumSepolia');
      expect(routers).toHaveLength(2);
    });

    it('returns empty array for unknown chain', () => {
      expect(getTestnetRouters('polygon')).toHaveLength(0);
    });
  });

  describe('getTestnetFlashLoanContract', () => {
    it('returns contract for sepolia', () => {
      expect(getTestnetFlashLoanContract('sepolia')).toBe('0x2f091cc77601C5aE2439A763C4916d9d32e035B6');
    });

    it('returns contract for arbitrumSepolia', () => {
      expect(getTestnetFlashLoanContract('arbitrumSepolia')).toBe('0xE5b26749430ed50917b75689B654a4C5808b23FB');
    });

    it('returns undefined for chain without deployment', () => {
      expect(getTestnetFlashLoanContract('zksync-testnet')).toBeUndefined();
    });
  });

  // =========================================================================
  // Opportunity Transformation (Integration)
  // =========================================================================

  describe('transformOpportunityForTestnet', () => {
    const baseOpportunity: ArbitrageOpportunity = {
      id: 'test-opp-1',
      type: 'flash-loan',
      buyChain: 'ethereum',
      sellChain: 'ethereum',
      buyDex: 'uniswap_v3',
      sellDex: 'sushiswap',
      chain: 'ethereum',
      tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH mainnet
      tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC mainnet
      token0: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      token1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      amountIn: '1000000000000000000',
      expectedProfit: 50,
      profitPercentage: 1.5,
      confidence: 0.85,
      timestamp: Date.now(),
    };

    it('preserves mainnet chain names for infrastructure lookups (C-01)', () => {
      const result = transformOpportunityForTestnet(baseOpportunity);
      expect(result).not.toBeNull();
      // Chain names stay as mainnet for provider/wallet/config lookups
      expect(result!.buyChain).toBe('ethereum');
      expect(result!.sellChain).toBe('ethereum');
      expect(result!.chain).toBe('ethereum');
    });

    it('adds testnet chain metadata (C-01)', () => {
      const result = transformOpportunityForTestnet(baseOpportunity) as any;
      expect(result).not.toBeNull();
      expect(result._testnetBuyChain).toBe('sepolia');
      expect(result._testnetSellChain).toBe('sepolia');
      expect(result._testnetChain).toBe('sepolia');
    });

    it('transforms token addresses to testnet', () => {
      const result = transformOpportunityForTestnet(baseOpportunity);
      expect(result).not.toBeNull();
      // WETH mainnet -> WETH sepolia
      expect(result!.tokenIn).toBe('0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14');
      // USDC mainnet -> USDC sepolia
      expect(result!.tokenOut).toBe('0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8');
      expect(result!.token0).toBe('0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14');
      expect(result!.token1).toBe('0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8');
    });

    it('preserves non-address fields', () => {
      const result = transformOpportunityForTestnet(baseOpportunity);
      expect(result).not.toBeNull();
      expect(result!.id).toBe('test-opp-1');
      expect(result!.type).toBe('flash-loan');
      expect(result!.expectedProfit).toBe(50);
      expect(result!.amountIn).toBe('1000000000000000000');
    });

    it('returns null for unsupported chain', () => {
      const polygonOpp: ArbitrageOpportunity = {
        ...baseOpportunity,
        buyChain: 'polygon',
        sellChain: 'polygon',
        chain: 'polygon',
      };
      expect(transformOpportunityForTestnet(polygonOpp)).toBeNull();
    });

    it('returns null for cross-chain with unsupported sell chain', () => {
      const crossChainOpp: ArbitrageOpportunity = {
        ...baseOpportunity,
        buyChain: 'ethereum',
        sellChain: 'polygon', // no testnet support
      };
      expect(transformOpportunityForTestnet(crossChainOpp)).toBeNull();
    });

    it('handles cross-chain with both chains supported', () => {
      const crossChainOpp: ArbitrageOpportunity = {
        ...baseOpportunity,
        buyChain: 'ethereum',
        sellChain: 'arbitrum',
      };
      const result = transformOpportunityForTestnet(crossChainOpp) as any;
      expect(result).not.toBeNull();
      // Mainnet chain names preserved for infrastructure
      expect(result.buyChain).toBe('ethereum');
      expect(result.sellChain).toBe('arbitrum');
      // Testnet chain names in metadata
      expect(result._testnetBuyChain).toBe('sepolia');
      expect(result._testnetSellChain).toBe('arbitrumSepolia');
    });

    it('resolves tokenOut using sell chain map for cross-chain (H-02)', () => {
      const crossChainOpp: ArbitrageOpportunity = {
        ...baseOpportunity,
        buyChain: 'ethereum',
        sellChain: 'arbitrum',
        tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',  // Ethereum WETH
        tokenOut: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // Arbitrum WETH
      };
      const result = transformOpportunityForTestnet(crossChainOpp);
      expect(result).not.toBeNull();
      // tokenIn resolved via ethereum map -> Sepolia WETH
      expect(result!.tokenIn).toBe('0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14');
      // tokenOut resolved via arbitrum map -> Arbitrum Sepolia WETH
      expect(result!.tokenOut).toBe('0x980B62Da83eFf3D4576C647993b0c1D7faf17c73');
    });

    it('returns null when opportunity has no chain', () => {
      const noChainOpp = {
        ...baseOpportunity,
        buyChain: undefined,
        chain: undefined,
      } as unknown as ArbitrageOpportunity;
      expect(transformOpportunityForTestnet(noChainOpp)).toBeNull();
    });

    it('falls back to chain field when buyChain is undefined', () => {
      const sameChainOpp: ArbitrageOpportunity = {
        ...baseOpportunity,
        buyChain: undefined,
        chain: 'arbitrum',
        sellChain: undefined,
      };
      const result = transformOpportunityForTestnet(sameChainOpp) as any;
      expect(result).not.toBeNull();
      // Mainnet chain names preserved (buyChain stays undefined)
      expect(result.buyChain).toBeUndefined();
      expect(result.chain).toBe('arbitrum');
      // Testnet metadata derived from chain field
      expect(result._testnetBuyChain).toBe('arbitrumSepolia');
      expect(result._testnetChain).toBe('arbitrumSepolia');
    });

    it('preserves undefined tokenIn/tokenOut without error', () => {
      const noTokenOpp: ArbitrageOpportunity = {
        ...baseOpportunity,
        tokenIn: undefined as unknown as string,
        tokenOut: undefined as unknown as string,
        token0: undefined as unknown as string,
        token1: undefined as unknown as string,
      };
      const result = transformOpportunityForTestnet(noTokenOpp);
      expect(result).not.toBeNull();
      expect(result!.tokenIn).toBeUndefined();
      expect(result!.tokenOut).toBeUndefined();
      expect(result!.token0).toBeUndefined();
      expect(result!.token1).toBeUndefined();
    });

    it('transforms hops[] tokenOut addresses (M-03)', () => {
      const mainnetWeth = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
      const mainnetUsdc = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
      const testnetWeth = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14';
      const testnetUsdc = '0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8';

      const hopsOpp: ArbitrageOpportunity = {
        ...baseOpportunity,
        hops: [
          { tokenOut: mainnetUsdc, dex: 'uniswap_v3' },
          { tokenOut: mainnetWeth, dex: 'sushiswap' },
        ],
      };
      const result = transformOpportunityForTestnet(hopsOpp);
      expect(result).not.toBeNull();
      expect(result!.hops).toHaveLength(2);
      expect(result!.hops![0].tokenOut).toBe(testnetUsdc);
      expect(result!.hops![1].tokenOut).toBe(testnetWeth);
    });

    it('preserves hops[] non-address fields', () => {
      const hopsOpp: ArbitrageOpportunity = {
        ...baseOpportunity,
        hops: [
          { tokenOut: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', dex: 'uniswap_v3', expectedOutput: '500' },
        ],
      };
      const result = transformOpportunityForTestnet(hopsOpp);
      expect(result).not.toBeNull();
      expect(result!.hops![0].dex).toBe('uniswap_v3');
      expect(result!.hops![0].expectedOutput).toBe('500');
    });

    it('handles opportunity with no hops (undefined)', () => {
      const result = transformOpportunityForTestnet(baseOpportunity);
      expect(result).not.toBeNull();
      expect(result!.hops).toBeUndefined();
    });
  });
});
