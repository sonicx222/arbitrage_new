import {
  normalizeChainId,
  isCanonicalChainId,
  isEVMChain,
  isTestnet,
  isMainnet,
  getMainnetChains,
  getTestnetChains,
  getEVMChains,
  getAllChains,
  getChainMetadata,
  getChainName,
  getEVMChainId,
  CHAIN_ALIASES,
  CHAIN_METADATA,
} from '../../src/chains';

describe('normalizeChainId', () => {
  describe('canonical IDs (passthrough)', () => {
    it('returns canonical mainnet IDs unchanged', () => {
      expect(normalizeChainId('ethereum')).toBe('ethereum');
      expect(normalizeChainId('polygon')).toBe('polygon');
      expect(normalizeChainId('arbitrum')).toBe('arbitrum');
      expect(normalizeChainId('bsc')).toBe('bsc');
      expect(normalizeChainId('solana')).toBe('solana');
      expect(normalizeChainId('zksync')).toBe('zksync');
    });

    it('returns canonical testnet IDs unchanged', () => {
      expect(normalizeChainId('sepolia')).toBe('sepolia');
      expect(normalizeChainId('arbitrum-sepolia')).toBe('arbitrum-sepolia');
      expect(normalizeChainId('solana-devnet')).toBe('solana-devnet');
    });
  });

  describe('alias resolution', () => {
    it('resolves lowercase aliases', () => {
      expect(normalizeChainId('eth')).toBe('ethereum');
      expect(normalizeChainId('matic')).toBe('polygon');
      expect(normalizeChainId('arb')).toBe('arbitrum');
      expect(normalizeChainId('bnb')).toBe('bsc');
      expect(normalizeChainId('avax')).toBe('avalanche');
      expect(normalizeChainId('ftm')).toBe('fantom');
      expect(normalizeChainId('sol')).toBe('solana');
    });

    it('resolves camelCase aliases (Hardhat config)', () => {
      expect(normalizeChainId('arbitrumSepolia')).toBe('arbitrum-sepolia');
      expect(normalizeChainId('baseSepolia')).toBe('base-sepolia');
      expect(normalizeChainId('zkSyncSepolia')).toBe('zksync-sepolia');
    });

    it('resolves legacy names', () => {
      expect(normalizeChainId('binance')).toBe('bsc');
      expect(normalizeChainId('binance-smart-chain')).toBe('bsc');
    });

    it('resolves zkSync aliases', () => {
      expect(normalizeChainId('zksync-mainnet')).toBe('zksync');
      expect(normalizeChainId('zksync-testnet')).toBe('zksync-sepolia');
      expect(normalizeChainId('zkSync')).toBe('zksync');
    });
  });

  describe('case-insensitive resolution (Fix #2)', () => {
    it('resolves uppercase versions of aliases', () => {
      expect(normalizeChainId('ETH')).toBe('ethereum');
      expect(normalizeChainId('MATIC')).toBe('polygon');
      expect(normalizeChainId('BNB')).toBe('bsc');
    });

    it('resolves mixed-case camelCase aliases', () => {
      expect(normalizeChainId('ARBITRUMSEPOLIA')).toBe('arbitrum-sepolia');
      expect(normalizeChainId('ArbitrumSepolia')).toBe('arbitrum-sepolia');
      expect(normalizeChainId('BASESEPOLIA')).toBe('base-sepolia');
      expect(normalizeChainId('ZKSYNCSEPOLIA')).toBe('zksync-sepolia');
    });

    it('resolves uppercase legacy names', () => {
      expect(normalizeChainId('BINANCE')).toBe('bsc');
      expect(normalizeChainId('ZKSYNC')).toBe('zksync');
    });
  });

  describe('unrecognized inputs', () => {
    it('returns unrecognized string as-is', () => {
      expect(normalizeChainId('unknown-chain')).toBe('unknown-chain');
    });

    it('returns empty string as-is', () => {
      expect(normalizeChainId('')).toBe('');
    });
  });
});

describe('isCanonicalChainId', () => {
  it('returns true for all canonical IDs', () => {
    const chains = getAllChains();
    for (const chain of chains) {
      expect(isCanonicalChainId(chain)).toBe(true);
    }
  });

  it('returns false for aliases', () => {
    expect(isCanonicalChainId('eth')).toBe(false);
    expect(isCanonicalChainId('matic')).toBe(false);
    expect(isCanonicalChainId('arbitrumSepolia')).toBe(false);
  });

  it('returns false for unknown strings', () => {
    expect(isCanonicalChainId('unknown')).toBe(false);
    expect(isCanonicalChainId('')).toBe(false);
  });
});

describe('isEVMChain', () => {
  it('returns true for EVM mainnets', () => {
    expect(isEVMChain('ethereum')).toBe(true);
    expect(isEVMChain('polygon')).toBe(true);
    expect(isEVMChain('zksync')).toBe(true);
  });

  it('returns true for EVM testnets', () => {
    expect(isEVMChain('sepolia')).toBe(true);
    expect(isEVMChain('arbitrum-sepolia')).toBe(true);
  });

  it('returns false for Solana chains', () => {
    expect(isEVMChain('solana')).toBe(false);
    expect(isEVMChain('solana-devnet')).toBe(false);
  });

  it('handles aliases', () => {
    expect(isEVMChain('eth')).toBe(true);
    expect(isEVMChain('sol')).toBe(false);
  });
});

describe('isTestnet', () => {
  it('returns true for testnets', () => {
    expect(isTestnet('sepolia')).toBe(true);
    expect(isTestnet('arbitrum-sepolia')).toBe(true);
    expect(isTestnet('base-sepolia')).toBe(true);
    expect(isTestnet('zksync-sepolia')).toBe(true);
    expect(isTestnet('solana-devnet')).toBe(true);
  });

  it('returns false for mainnets', () => {
    expect(isTestnet('ethereum')).toBe(false);
    expect(isTestnet('polygon')).toBe(false);
    expect(isTestnet('solana')).toBe(false);
  });

  it('handles aliases', () => {
    expect(isTestnet('zkSyncSepolia')).toBe(true);
    expect(isTestnet('eth')).toBe(false);
  });
});

describe('isMainnet', () => {
  it('returns true for mainnets', () => {
    expect(isMainnet('ethereum')).toBe(true);
    expect(isMainnet('polygon')).toBe(true);
    expect(isMainnet('solana')).toBe(true);
    expect(isMainnet('bsc')).toBe(true);
  });

  it('returns false for testnets', () => {
    expect(isMainnet('sepolia')).toBe(false);
    expect(isMainnet('solana-devnet')).toBe(false);
  });

  it('returns false for unknown chains', () => {
    expect(isMainnet('unknown')).toBe(false);
  });
});

describe('get*Chains functions', () => {
  it('getMainnetChains returns 15 mainnets', () => {
    const chains = getMainnetChains();
    expect(chains).toHaveLength(15);
    expect(chains).toContain('ethereum');
    expect(chains).toContain('solana');
    expect(chains).not.toContain('sepolia');
  });

  it('getTestnetChains returns 5 testnets', () => {
    const chains = getTestnetChains();
    expect(chains).toHaveLength(5);
    expect(chains).toContain('sepolia');
    expect(chains).toContain('solana-devnet');
    expect(chains).not.toContain('ethereum');
  });

  it('getEVMChains returns all EVM chains (18)', () => {
    const chains = getEVMChains();
    expect(chains).toHaveLength(18);
    expect(chains).toContain('ethereum');
    expect(chains).toContain('sepolia');
    expect(chains).not.toContain('solana');
    expect(chains).not.toContain('solana-devnet');
  });

  it('getAllChains returns 20 total chains', () => {
    const chains = getAllChains();
    expect(chains).toHaveLength(20);
    expect(chains).toContain('ethereum');
    expect(chains).toContain('solana');
    expect(chains).toContain('sepolia');
    expect(chains).toContain('solana-devnet');
  });

  it('returns the same array reference (no per-call allocation)', () => {
    expect(getMainnetChains()).toBe(getMainnetChains());
    expect(getTestnetChains()).toBe(getTestnetChains());
    expect(getEVMChains()).toBe(getEVMChains());
    expect(getAllChains()).toBe(getAllChains());
  });
});

describe('getChainMetadata', () => {
  it('returns metadata for canonical IDs', () => {
    const meta = getChainMetadata('ethereum');
    expect(meta).toBeDefined();
    expect(meta!.id).toBe('ethereum');
    expect(meta!.name).toBe('Ethereum Mainnet');
    expect(meta!.chainId).toBe(1);
    expect(meta!.testnet).toBe(false);
    expect(meta!.evm).toBe(true);
  });

  it('returns metadata via alias', () => {
    const meta = getChainMetadata('eth');
    expect(meta).toBeDefined();
    expect(meta!.id).toBe('ethereum');
  });

  it('returns undefined for unknown chains', () => {
    expect(getChainMetadata('unknown')).toBeUndefined();
  });

  it('returns null chainId for Solana', () => {
    const meta = getChainMetadata('solana');
    expect(meta!.chainId).toBeNull();
    expect(meta!.evm).toBe(false);
  });
});

describe('getChainName', () => {
  it('returns human-readable name for known chains', () => {
    expect(getChainName('ethereum')).toBe('Ethereum Mainnet');
    expect(getChainName('bsc')).toBe('BNB Smart Chain');
  });

  it('returns original input for unknown chains', () => {
    expect(getChainName('unknown')).toBe('unknown');
  });

  it('resolves aliases before getting name', () => {
    expect(getChainName('eth')).toBe('Ethereum Mainnet');
  });
});

describe('getEVMChainId', () => {
  it('returns numeric chain ID for EVM chains', () => {
    expect(getEVMChainId('ethereum')).toBe(1);
    expect(getEVMChainId('polygon')).toBe(137);
    expect(getEVMChainId('arbitrum')).toBe(42161);
    expect(getEVMChainId('bsc')).toBe(56);
  });

  it('returns null for Solana', () => {
    expect(getEVMChainId('solana')).toBeNull();
  });

  it('returns null for unknown chains', () => {
    expect(getEVMChainId('unknown')).toBeNull();
  });

  it('resolves aliases', () => {
    expect(getEVMChainId('eth')).toBe(1);
    expect(getEVMChainId('matic')).toBe(137);
  });
});

describe('CHAIN_ALIASES consistency', () => {
  it('all alias values are canonical chain IDs', () => {
    for (const [alias, canonical] of Object.entries(CHAIN_ALIASES)) {
      expect(isCanonicalChainId(canonical)).toBe(true);
    }
  });
});

describe('CHAIN_METADATA consistency', () => {
  it('has metadata for all canonical chain IDs', () => {
    const allChains = getAllChains();
    for (const chain of allChains) {
      expect(CHAIN_METADATA[chain]).toBeDefined();
      expect(CHAIN_METADATA[chain].id).toBe(chain);
    }
  });

  it('testnet flag matches isTestnet()', () => {
    for (const [id, meta] of Object.entries(CHAIN_METADATA)) {
      expect(meta.testnet).toBe(isTestnet(id));
    }
  });

  it('evm flag matches isEVMChain()', () => {
    for (const [id, meta] of Object.entries(CHAIN_METADATA)) {
      expect(meta.evm).toBe(isEVMChain(id));
    }
  });
});
