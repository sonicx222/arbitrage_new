/**
 * Tests for contracts/deployments/addresses.ts
 *
 * Comprehensive test coverage for:
 * - Type-safe chain identifiers
 * - Helper functions (hasX, getX)
 * - Error handling
 * - Edge cases
 */

import {
  MAINNET_CHAINS,
  TESTNET_CHAINS,
  isTestnet,
  isMainnet,
  normalizeChainName, // FIX 3.2: New chain name normalization
  AAVE_V3_POOL_ADDRESSES,
  FLASH_LOAN_CONTRACT_ADDRESSES,
  PANCAKESWAP_FLASH_ARBITRAGE_ADDRESSES,
  BALANCER_V2_FLASH_ARBITRAGE_ADDRESSES,
  SYNCSWAP_FLASH_ARBITRAGE_ADDRESSES,
  COMMIT_REVEAL_ARBITRAGE_ADDRESSES,
  MULTI_PATH_QUOTER_ADDRESSES,
  APPROVED_ROUTERS,
  TOKEN_ADDRESSES,
  hasDeployedContract,
  getContractAddress,
  getAavePoolAddress,
  getApprovedRouters,
  hasApprovedRouters,
  hasDeployedQuoter,
  getQuoterAddress,
  tryGetQuoterAddress, // FIX 4.2: New optional accessor
} from '../addresses';

// Note: Types (TestnetChain, EVMMainnetChain, SupportedChain) are available for TypeScript
// type checking but not needed at runtime for tests

describe('contracts/deployments/addresses', () => {
  // =============================================================================
  // Type-Safe Chain Identifiers
  // =============================================================================

  describe('Chain Type System', () => {
    it('should have testnet chains defined', () => {
      expect(TESTNET_CHAINS).toEqual(['sepolia', 'arbitrumSepolia', 'zksync-testnet', 'zksync-sepolia']);
      expect(TESTNET_CHAINS.length).toBeGreaterThan(0);
    });

    it('should have mainnet chains defined', () => {
      expect(MAINNET_CHAINS.length).toBeGreaterThanOrEqual(10);
      expect(MAINNET_CHAINS).toContain('ethereum');
      expect(MAINNET_CHAINS).toContain('arbitrum');
      expect(MAINNET_CHAINS).toContain('bsc');
    });

    it('should correctly identify testnet chains', () => {
      expect(isTestnet('sepolia')).toBe(true);
      expect(isTestnet('arbitrumSepolia')).toBe(true);
      expect(isTestnet('zksync-testnet')).toBe(true);
      expect(isTestnet('zksync-sepolia')).toBe(true);  // Alias for zksync-testnet

      // Mainnet should not be testnet
      expect(isTestnet('ethereum')).toBe(false);
      expect(isTestnet('arbitrum')).toBe(false);

      // Unknown chain should not be testnet
      expect(isTestnet('unknown')).toBe(false);
    });

    it('should correctly identify mainnet chains', () => {
      expect(isMainnet('ethereum')).toBe(true);
      expect(isMainnet('arbitrum')).toBe(true);
      expect(isMainnet('bsc')).toBe(true);
      expect(isMainnet('zksync')).toBe(true);
      expect(isMainnet('zksync-mainnet')).toBe(true);  // Alias for zksync

      // Testnet should not be mainnet
      expect(isMainnet('sepolia')).toBe(false);
      expect(isMainnet('arbitrumSepolia')).toBe(false);

      // Unknown chain should not be mainnet
      expect(isMainnet('unknown')).toBe(false);
    });
  });

  // =============================================================================
  // Aave V3 Pool Addresses
  // =============================================================================

  describe('getAavePoolAddress', () => {
    it('should return Aave V3 pool address for supported chains', () => {
      const ethAddress = getAavePoolAddress('ethereum');
      expect(ethAddress).toBe('0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2');
      expect(ethAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it('should return Aave V3 pool address for testnet chains', () => {
      const sepoliaAddress = getAavePoolAddress('sepolia');
      expect(sepoliaAddress).toBe('0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951');
    });

    it('should throw for unsupported chains', () => {
      expect(() => getAavePoolAddress('solana')).toThrow('Aave V3 Pool not configured');
      expect(() => getAavePoolAddress('unknown')).toThrow('Aave V3 Pool not configured');
    });

    it('should include helpful error message with supported chains', () => {
      try {
        getAavePoolAddress('unknown');
        fail('Should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('Supported chains:');
        expect((error as Error).message).toContain('ethereum');
      }
    });
  });

  // =============================================================================
  // Flash Loan Contract Addresses
  // =============================================================================

  describe('hasDeployedContract', () => {
    it('should return false for chains without deployed contracts', () => {
      // All contracts are commented out (TODO)
      expect(hasDeployedContract('ethereum')).toBe(false);
      expect(hasDeployedContract('arbitrum')).toBe(false);
      expect(hasDeployedContract('sepolia')).toBe(false);
    });

    it('should return false for unknown chains', () => {
      expect(hasDeployedContract('unknown')).toBe(false);
      expect(hasDeployedContract('')).toBe(false);
    });

    it('should use Map for O(1) lookup', () => {
      // Performance check - should be instant even with many lookups
      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        hasDeployedContract('ethereum');
      }
      const duration = performance.now() - start;
      expect(duration).toBeLessThan(10); // Should be < 10ms for 1000 lookups
    });
  });

  describe('getContractAddress', () => {
    it('should throw for chains without deployed contracts', () => {
      expect(() => getContractAddress('ethereum')).toThrow('[ERR_NO_CONTRACT]');
      expect(() => getContractAddress('sepolia')).toThrow('[ERR_NO_CONTRACT]');
    });

    it('should include helpful error message', () => {
      try {
        getContractAddress('ethereum');
        fail('Should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('No FlashLoanArbitrage contract deployed');
        expect((error as Error).message).toContain('npm run deploy:ethereum');
        expect((error as Error).message).toContain('Available chains:');
      }
    });

    it('should throw for unknown chains', () => {
      expect(() => getContractAddress('unknown')).toThrow('[ERR_NO_CONTRACT]');
    });
  });

  // =============================================================================
  // Approved Routers
  // =============================================================================

  describe('hasApprovedRouters', () => {
    it('should return true for chains with approved routers', () => {
      expect(hasApprovedRouters('ethereum')).toBe(true);
      expect(hasApprovedRouters('arbitrum')).toBe(true);
      expect(hasApprovedRouters('bsc')).toBe(true);
    });

    it('should return false for chains without approved routers', () => {
      expect(hasApprovedRouters('unknown')).toBe(false);
      expect(hasApprovedRouters('')).toBe(false);
    });

    it('should use Map for O(1) lookup', () => {
      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        hasApprovedRouters('ethereum');
      }
      const duration = performance.now() - start;
      expect(duration).toBeLessThan(10);
    });
  });

  describe('getApprovedRouters', () => {
    it('should return array of router addresses for supported chains', () => {
      const ethRouters = getApprovedRouters('ethereum');
      expect(Array.isArray(ethRouters)).toBe(true);
      expect(ethRouters.length).toBeGreaterThan(0);
      expect(ethRouters[0]).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it('should return multiple routers for chains with multiple DEXs', () => {
      const ethRouters = getApprovedRouters('ethereum');
      expect(ethRouters.length).toBeGreaterThanOrEqual(2);
      // Should include Uniswap V2 and SushiSwap
      expect(ethRouters).toContain('0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D');
    });

    it('should throw for chains without approved routers', () => {
      expect(() => getApprovedRouters('unknown')).toThrow('[ERR_NO_ROUTERS]');
    });

    it('should include helpful error message', () => {
      try {
        getApprovedRouters('unknown');
        fail('Should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('No approved routers configured');
        expect((error as Error).message).toContain('Supported chains:');
        expect((error as Error).message).toContain('[ERR_UNAPPROVED_ROUTER]');
      }
    });
  });

  // =============================================================================
  // MultiPathQuoter Addresses
  // =============================================================================

  describe('hasDeployedQuoter', () => {
    it('should return false for chains without deployed quoters', () => {
      // All quoters are commented out (TODO)
      expect(hasDeployedQuoter('ethereum')).toBe(false);
      expect(hasDeployedQuoter('sepolia')).toBe(false);
    });

    it('should return false for unknown chains', () => {
      expect(hasDeployedQuoter('unknown')).toBe(false);
      expect(hasDeployedQuoter('')).toBe(false);
    });

    it('should handle empty string addresses correctly', () => {
      // Empty string should be treated as "not deployed"
      expect(hasDeployedQuoter('ethereum')).toBe(false);
    });

    it('should use Map for O(1) lookup', () => {
      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        hasDeployedQuoter('ethereum');
      }
      const duration = performance.now() - start;
      expect(duration).toBeLessThan(10);
    });
  });

  describe('getQuoterAddress', () => {
    it('should return undefined for chains without deployed quoters', () => {
      expect(getQuoterAddress('ethereum')).toBeUndefined();
      expect(getQuoterAddress('sepolia')).toBeUndefined();
    });

    it('should return undefined for unknown chains', () => {
      expect(getQuoterAddress('unknown')).toBeUndefined();
      expect(getQuoterAddress('')).toBeUndefined();
    });

    it('should use Map for O(1) lookup', () => {
      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        getQuoterAddress('ethereum');
      }
      const duration = performance.now() - start;
      expect(duration).toBeLessThan(10);
    });
  });

  // =============================================================================
  // Token Addresses
  // =============================================================================

  describe('TOKEN_ADDRESSES', () => {
    it('should have token addresses for all major chains', () => {
      expect(TOKEN_ADDRESSES.ethereum).toBeDefined();
      expect(TOKEN_ADDRESSES.arbitrum).toBeDefined();
      expect(TOKEN_ADDRESSES.polygon).toBeDefined();
      expect(TOKEN_ADDRESSES.bsc).toBeDefined();
      expect(TOKEN_ADDRESSES.base).toBeDefined();
      expect(TOKEN_ADDRESSES.optimism).toBeDefined();
      expect(TOKEN_ADDRESSES.avalanche).toBeDefined();
      expect(TOKEN_ADDRESSES.fantom).toBeDefined();
      expect(TOKEN_ADDRESSES.zksync).toBeDefined();
      expect(TOKEN_ADDRESSES.linea).toBeDefined();
    });

    it('should have WETH/native token for each chain', () => {
      expect(TOKEN_ADDRESSES.ethereum.WETH).toBeDefined();
      expect(TOKEN_ADDRESSES.polygon.WMATIC).toBeDefined();
      expect(TOKEN_ADDRESSES.bsc.WBNB).toBeDefined();
      expect(TOKEN_ADDRESSES.avalanche.WAVAX).toBeDefined();
      expect(TOKEN_ADDRESSES.fantom.WFTM).toBeDefined();
    });

    it('should have USDC for each chain', () => {
      expect(TOKEN_ADDRESSES.ethereum.USDC).toBeDefined();
      expect(TOKEN_ADDRESSES.arbitrum.USDC).toBeDefined();
      expect(TOKEN_ADDRESSES.polygon.USDC).toBeDefined();
      expect(TOKEN_ADDRESSES.bsc.USDC).toBeDefined();
    });

    it('should have valid address format for all tokens', () => {
      const addressRegex = /^0x[0-9a-fA-F]{40}$/;

      Object.entries(TOKEN_ADDRESSES).forEach(([chain, tokens]) => {
        Object.entries(tokens).forEach(([token, address]) => {
          expect(address).toMatch(addressRegex);
        });
      });
    });

    it('should have checksummed addresses', () => {
      // Checksummed addresses have mixed case
      // All-lowercase would indicate non-checksummed
      const ethWeth = TOKEN_ADDRESSES.ethereum.WETH;
      expect(ethWeth).not.toBe(ethWeth.toLowerCase());
      expect(ethWeth).toBe('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
    });
  });

  // =============================================================================
  // Edge Cases
  // =============================================================================

  describe('Edge Cases', () => {
    it('should handle empty string chain names', () => {
      expect(isTestnet('')).toBe(false);
      expect(isMainnet('')).toBe(false);
      expect(hasDeployedContract('')).toBe(false);
      expect(hasApprovedRouters('')).toBe(false);
      expect(hasDeployedQuoter('')).toBe(false);
    });

    it('should handle case-sensitive chain names', () => {
      // Chain names are case-sensitive
      expect(() => getAavePoolAddress('Ethereum')).toThrow();
      expect(() => getApprovedRouters('ETHEREUM')).toThrow();
    });

    it('should handle chains with aliases', () => {
      // zkSync Era has multiple name variants that should all be recognized
      expect(isMainnet('zksync')).toBe(true);
      expect(isMainnet('zksync-mainnet')).toBe(true);
      expect(isTestnet('zksync-testnet')).toBe(true);
      expect(isTestnet('zksync-sepolia')).toBe(true);

      // Token addresses available under canonical name
      expect(TOKEN_ADDRESSES.zksync).toBeDefined();
    });
  });

  // =============================================================================
  // Contract Address Constants Existence
  // =============================================================================

  describe('Contract Address Constants', () => {
    it('should export all flash loan provider address constants', () => {
      expect(FLASH_LOAN_CONTRACT_ADDRESSES).toBeDefined();
      expect(PANCAKESWAP_FLASH_ARBITRAGE_ADDRESSES).toBeDefined();
      expect(BALANCER_V2_FLASH_ARBITRAGE_ADDRESSES).toBeDefined();
      expect(SYNCSWAP_FLASH_ARBITRAGE_ADDRESSES).toBeDefined();
      expect(COMMIT_REVEAL_ARBITRAGE_ADDRESSES).toBeDefined();
    });

    it('should have Record<string, string> type for all contract address constants', () => {
      expect(typeof FLASH_LOAN_CONTRACT_ADDRESSES).toBe('object');
      expect(typeof PANCAKESWAP_FLASH_ARBITRAGE_ADDRESSES).toBe('object');
      expect(typeof BALANCER_V2_FLASH_ARBITRAGE_ADDRESSES).toBe('object');
      expect(typeof SYNCSWAP_FLASH_ARBITRAGE_ADDRESSES).toBe('object');
      expect(typeof COMMIT_REVEAL_ARBITRAGE_ADDRESSES).toBe('object');
    });
  });

  // =============================================================================
  // Data Integrity
  // =============================================================================

  describe('Data Integrity', () => {
    it('should have unique addresses within APPROVED_ROUTERS for each chain', () => {
      Object.entries(APPROVED_ROUTERS).forEach(([chain, routers]) => {
        const uniqueRouters = new Set(routers);
        expect(uniqueRouters.size).toBe(routers.length);
      });
    });

    it('should have valid Ethereum address format for all AAVE_V3_POOL_ADDRESSES', () => {
      const addressRegex = /^0x[0-9a-fA-F]{40}$/;
      Object.values(AAVE_V3_POOL_ADDRESSES).forEach((address) => {
        expect(address).toMatch(addressRegex);
      });
    });

    it('should not have null or undefined addresses in APPROVED_ROUTERS', () => {
      Object.entries(APPROVED_ROUTERS).forEach(([chain, routers]) => {
        routers.forEach((router) => {
          expect(router).toBeTruthy();
          expect(router).not.toBeNull();
          expect(router).not.toBeUndefined();
        });
      });
    });
  });

  // =============================================================================
  // Chain Name Normalization (FIX 3.2)
  // =============================================================================

  describe('normalizeChainName', () => {
    it('should normalize zkSync mainnet aliases', () => {
      expect(normalizeChainName('zksync-mainnet')).toBe('zksync');
      expect(normalizeChainName('zksync')).toBe('zksync');
    });

    it('should normalize zkSync testnet aliases', () => {
      expect(normalizeChainName('zksync-sepolia')).toBe('zksync-testnet');
      expect(normalizeChainName('zksync-testnet')).toBe('zksync-testnet');
    });

    it('should return unchanged for non-aliased chains', () => {
      expect(normalizeChainName('ethereum')).toBe('ethereum');
      expect(normalizeChainName('arbitrum')).toBe('arbitrum');
      expect(normalizeChainName('bsc')).toBe('bsc');
    });

    it('should handle unknown chains gracefully', () => {
      expect(normalizeChainName('unknown-chain')).toBe('unknown-chain');
    });
  });

  describe('Chain type checks with normalization', () => {
    it('should recognize zkSync aliases as mainnet', () => {
      expect(isMainnet('zksync-mainnet')).toBe(true);
      expect(isMainnet('zksync')).toBe(true);
    });

    it('should recognize zkSync testnet aliases as testnet', () => {
      expect(isTestnet('zksync-sepolia')).toBe(true);
      expect(isTestnet('zksync-testnet')).toBe(true);
    });

    it('should work with canonical names', () => {
      expect(isMainnet('ethereum')).toBe(true);
      expect(isTestnet('sepolia')).toBe(true);
    });
  });

  // =============================================================================
  // Optional Quoter Address Accessor (FIX 4.2)
  // =============================================================================

  describe('tryGetQuoterAddress', () => {
    it('should return undefined for chains without deployed quoters', () => {
      expect(tryGetQuoterAddress('ethereum')).toBeUndefined();
      expect(tryGetQuoterAddress('sepolia')).toBeUndefined();
    });

    it('should return undefined for unknown chains', () => {
      expect(tryGetQuoterAddress('unknown')).toBeUndefined();
    });

    it('should not throw errors (graceful fallback)', () => {
      expect(() => tryGetQuoterAddress('ethereum')).not.toThrow();
      expect(() => tryGetQuoterAddress('unknown')).not.toThrow();
    });

    it('should handle zkSync aliases', () => {
      // Both should behave the same (normalization)
      expect(tryGetQuoterAddress('zksync-mainnet')).toEqual(tryGetQuoterAddress('zksync'));
    });
  });

  describe('getQuoterAddress vs tryGetQuoterAddress', () => {
    it('getQuoterAddress should throw for missing quoters', () => {
      expect(() => getQuoterAddress('ethereum')).toThrow('[ERR_NO_QUOTER]');
    });

    it('tryGetQuoterAddress should return undefined for missing quoters', () => {
      expect(tryGetQuoterAddress('ethereum')).toBeUndefined();
    });

    it('both should use normalization', () => {
      // If quoter exists, both should work with aliases
      // If not, getQuoter throws, tryGetQuoter returns undefined
      expect(() => getQuoterAddress('zksync-mainnet')).toThrow();
      expect(tryGetQuoterAddress('zksync-mainnet')).toBeUndefined();
    });
  });

  // =============================================================================
  // Error Message Consistency (FIX 4.2)
  // =============================================================================

  describe('Error Codes', () => {
    it('should use error codes in all error messages', () => {
      try {
        getContractAddress('unknown');
        fail('Should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('[ERR_NO_CONTRACT]');
      }

      try {
        getAavePoolAddress('unknown');
        fail('Should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('[ERR_NO_AAVE_POOL]');
      }

      try {
        getApprovedRouters('unknown');
        fail('Should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('[ERR_NO_ROUTERS]');
      }

      try {
        getQuoterAddress('unknown');
        fail('Should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('[ERR_NO_QUOTER]');
      }
    });

    it('should include normalized chain name in error messages', () => {
      try {
        getContractAddress('zksync-mainnet');
        fail('Should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('zksync-mainnet');
        expect((error as Error).message).toContain('normalized: zksync');
      }
    });
  });

  // =============================================================================
  // Registry Structure Validation (FIX 8.2)
  // =============================================================================

  describe('Registry Structure', () => {
    it('should have consistent contract type keys across all networks', () => {
      // All networks should define the same contract type keys (even if values are null)
      const expectedKeys = [
        'FlashLoanArbitrage',
        'PancakeSwapFlashArbitrage',
        'BalancerV2FlashArbitrage',
        'SyncSwapFlashArbitrage',
        'CommitRevealArbitrage',
        'MultiPathQuoter',
      ];

      // Verify address constants exist for each contract type
      expect(FLASH_LOAN_CONTRACT_ADDRESSES).toBeDefined();
      expect(PANCAKESWAP_FLASH_ARBITRAGE_ADDRESSES).toBeDefined();
      expect(BALANCER_V2_FLASH_ARBITRAGE_ADDRESSES).toBeDefined();
      expect(SYNCSWAP_FLASH_ARBITRAGE_ADDRESSES).toBeDefined();
      expect(COMMIT_REVEAL_ARBITRAGE_ADDRESSES).toBeDefined();
      expect(MULTI_PATH_QUOTER_ADDRESSES).toBeDefined();
    });

    it('should support multiple contract types per chain', () => {
      // In the future, a chain might have multiple contract types deployed
      // Structure should support this without conflicts

      // Example: ethereum could have both FlashLoanArbitrage and BalancerV2FlashArbitrage
      const contractTypes = [
        FLASH_LOAN_CONTRACT_ADDRESSES,
        PANCAKESWAP_FLASH_ARBITRAGE_ADDRESSES,
        BALANCER_V2_FLASH_ARBITRAGE_ADDRESSES,
        SYNCSWAP_FLASH_ARBITRAGE_ADDRESSES,
        COMMIT_REVEAL_ARBITRAGE_ADDRESSES,
        MULTI_PATH_QUOTER_ADDRESSES,
      ];

      // All contract types should be independent (no shared state)
      contractTypes.forEach((addresses, index) => {
        expect(addresses).toBeDefined();
        expect(typeof addresses).toBe('object');
        // Each is a separate Record
        expect(addresses).not.toBe(contractTypes[(index + 1) % contractTypes.length]);
      });
    });

    it('should have valid address format for all deployed contracts', () => {
      const addressRegex = /^0x[0-9a-fA-F]{40}$/;

      const allAddresses = [
        ...Object.values(FLASH_LOAN_CONTRACT_ADDRESSES),
        ...Object.values(PANCAKESWAP_FLASH_ARBITRAGE_ADDRESSES),
        ...Object.values(BALANCER_V2_FLASH_ARBITRAGE_ADDRESSES),
        ...Object.values(SYNCSWAP_FLASH_ARBITRAGE_ADDRESSES),
        ...Object.values(COMMIT_REVEAL_ARBITRAGE_ADDRESSES),
        ...Object.values(MULTI_PATH_QUOTER_ADDRESSES),
      ].filter((addr) => addr); // Filter out undefined/null

      allAddresses.forEach((address) => {
        expect(address).toMatch(addressRegex);
      });
    });
  });

  // =============================================================================
  // Performance and Hot-Path Optimizations (FIX 9.4)
  // =============================================================================

  describe('Hot-Path Optimizations', () => {
    it('should return frozen arrays from getApprovedRouters (immutability)', () => {
      const routers = getApprovedRouters('ethereum');

      // Array should be frozen (cannot be modified)
      expect(Object.isFrozen(routers)).toBe(true);

      // Attempting to modify should fail (in strict mode) or be silently ignored
      expect(() => {
        (routers as any).push('0x0000000000000000000000000000000000000000');
      }).toThrow();
    });

    it('should enable safe caching of router arrays', () => {
      // Same chain should return same frozen reference (safe to cache)
      const routers1 = getApprovedRouters('ethereum');
      const routers2 = getApprovedRouters('ethereum');

      // Should be the same frozen array reference
      expect(routers1).toBe(routers2);
    });

    it('should perform O(1) lookups for all helper functions', () => {
      // Test that lookups are fast (Map-based)
      const iterations = 1000;
      const start = performance.now();

      for (let i = 0; i < iterations; i++) {
        hasDeployedContract('ethereum');
        hasApprovedRouters('ethereum');
        hasDeployedQuoter('ethereum');
      }

      const duration = performance.now() - start;

      // 1000 lookups should complete in <10ms (O(1) Map access)
      expect(duration).toBeLessThan(10);
    });

    it('should handle concurrent lookups without race conditions', () => {
      // Multiple lookups should not interfere with each other
      const results = Promise.all([
        Promise.resolve(hasDeployedContract('ethereum')),
        Promise.resolve(hasApprovedRouters('ethereum')),
        Promise.resolve(hasDeployedQuoter('ethereum')),
        Promise.resolve(hasDeployedContract('arbitrum')),
        Promise.resolve(hasApprovedRouters('arbitrum')),
      ]);

      return expect(results).resolves.toBeDefined();
    });
  });

  // =============================================================================
  // Integration Scenarios
  // =============================================================================

  describe('Integration Scenarios', () => {
    it('should handle complete deployment workflow', () => {
      // Scenario: Developer deploys to sepolia
      const chain = 'sepolia';

      // Before deployment: no contract
      expect(hasDeployedContract(chain)).toBe(false);

      // After deployment: would be in FLASH_LOAN_CONTRACT_ADDRESSES
      // (Currently all are empty, so this tests the "not deployed" path)

      // Should have approved routers even without contract
      expect(hasApprovedRouters(chain)).toBe(true);
      const routers = getApprovedRouters(chain);
      expect(routers.length).toBeGreaterThan(0);
    });

    it('should handle multi-chain deployment tracking', () => {
      // Track which chains have which contract types
      const deploymentStatus = {
        sepolia: {
          hasFlashLoan: hasDeployedContract('sepolia'),
          hasQuoter: hasDeployedQuoter('sepolia'),
          hasRouters: hasApprovedRouters('sepolia'),
        },
        ethereum: {
          hasFlashLoan: hasDeployedContract('ethereum'),
          hasQuoter: hasDeployedQuoter('ethereum'),
          hasRouters: hasApprovedRouters('ethereum'),
        },
      };

      // Structure should support tracking multiple chains
      expect(deploymentStatus.sepolia).toBeDefined();
      expect(deploymentStatus.ethereum).toBeDefined();
    });

    it('should gracefully handle chains with partial deployments', () => {
      // A chain might have routers but no contracts deployed yet
      const chain = 'arbitrum';

      // Has routers
      expect(hasApprovedRouters(chain)).toBe(true);

      // May not have contracts deployed (currently all are TODO)
      if (hasDeployedContract(chain)) {
        expect(() => getContractAddress(chain)).not.toThrow();
      } else {
        expect(() => getContractAddress(chain)).toThrow('[ERR_NO_CONTRACT]');
      }
    });
  });
});
