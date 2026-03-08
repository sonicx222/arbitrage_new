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
    it('maps ethereum to sepolia', () => {
      expect(resolveTestnetChain('ethereum')).toBe('sepolia');
    });

    it('maps arbitrum to arbitrumSepolia', () => {
      expect(resolveTestnetChain('arbitrum')).toBe('arbitrumSepolia');
    });

    it('maps base to baseSepolia', () => {
      expect(resolveTestnetChain('base')).toBe('baseSepolia');
    });

    it('maps zksync to zksync-testnet', () => {
      expect(resolveTestnetChain('zksync')).toBe('zksync-testnet');
    });

    it('returns original chain if no mapping exists', () => {
      expect(resolveTestnetChain('polygon')).toBe('polygon');
      expect(resolveTestnetChain('bsc')).toBe('bsc');
      expect(resolveTestnetChain('solana')).toBe('solana');
    });
  });

  describe('hasTestnetSupport', () => {
    it('returns true for supported chains', () => {
      expect(hasTestnetSupport('ethereum')).toBe(true);
      expect(hasTestnetSupport('arbitrum')).toBe(true);
      expect(hasTestnetSupport('base')).toBe(true);
      expect(hasTestnetSupport('zksync')).toBe(true);
    });

    it('returns false for unsupported chains', () => {
      expect(hasTestnetSupport('polygon')).toBe(false);
      expect(hasTestnetSupport('bsc')).toBe(false);
      expect(hasTestnetSupport('avalanche')).toBe(false);
      expect(hasTestnetSupport('solana')).toBe(false);
    });
  });

  describe('isKnownTestnet', () => {
    it('identifies testnet chain names', () => {
      expect(isKnownTestnet('sepolia')).toBe(true);
      expect(isKnownTestnet('arbitrumSepolia')).toBe(true);
      expect(isKnownTestnet('baseSepolia')).toBe(true);
      expect(isKnownTestnet('zksync-testnet')).toBe(true);
    });

    it('rejects mainnet chain names', () => {
      expect(isKnownTestnet('ethereum')).toBe(false);
      expect(isKnownTestnet('arbitrum')).toBe(false);
    });
  });

  describe('getMainnetEquivalent', () => {
    it('returns mainnet name for testnet', () => {
      expect(getMainnetEquivalent('sepolia')).toBe('ethereum');
      expect(getMainnetEquivalent('arbitrumSepolia')).toBe('arbitrum');
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

    it('transforms chain names to testnet', () => {
      const result = transformOpportunityForTestnet(baseOpportunity);
      expect(result).not.toBeNull();
      expect(result!.buyChain).toBe('sepolia');
      expect(result!.sellChain).toBe('sepolia');
      expect(result!.chain).toBe('sepolia');
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
      const result = transformOpportunityForTestnet(crossChainOpp);
      expect(result).not.toBeNull();
      expect(result!.buyChain).toBe('sepolia');
      expect(result!.sellChain).toBe('arbitrumSepolia');
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
      const result = transformOpportunityForTestnet(sameChainOpp);
      expect(result).not.toBeNull();
      expect(result!.buyChain).toBe('arbitrumSepolia');
      expect(result!.chain).toBe('arbitrumSepolia');
    });
  });
});
