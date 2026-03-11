import { getV3AdapterAddress, hasV3Adapter, V3_ADAPTER_ADDRESSES } from '../../src/v3-adapter-addresses';

describe('V3 Adapter Addresses', () => {
  it('returns address for deployed chain', () => {
    expect(getV3AdapterAddress('arbitrumSepolia')).toBe('0x1A9838ce19Ae905B4e5941a17891ba180F30F630');
  });

  it('returns null for chain with no deployment', () => {
    expect(getV3AdapterAddress('ethereum')).toBeNull();
    expect(getV3AdapterAddress('bsc')).toBeNull();
  });

  it('returns null for unknown chain', () => {
    expect(getV3AdapterAddress('unknown_chain')).toBeNull();
  });

  it('hasV3Adapter returns true for deployed chain', () => {
    expect(hasV3Adapter('arbitrumSepolia')).toBe(true);
  });

  it('hasV3Adapter returns false for undeployed chain', () => {
    expect(hasV3Adapter('ethereum')).toBe(false);
    expect(hasV3Adapter('nonexistent')).toBe(false);
  });

  it('registry has entries for all expected chains', () => {
    const expectedChains = [
      'arbitrumSepolia', 'ethereum', 'arbitrum', 'base', 'optimism',
      'polygon', 'bsc', 'avalanche', 'fantom', 'linea', 'zksync',
      'blast', 'scroll', 'mantle', 'mode',
    ];
    for (const chain of expectedChains) {
      expect(chain in V3_ADAPTER_ADDRESSES).toBe(true);
    }
  });
});
