/**
 * Fantom DEX Configurations — 4 DEXes
 * @see S3.2.2
 */
import { Dex, FeeBasisPoints } from '../../../../types';
import { BALANCER_V2_VAULTS } from '../../addresses';

const bps = (value: number): FeeBasisPoints => value as FeeBasisPoints;

export const FANTOM_DEXES: Dex[] = [
  {
    name: 'spookyswap',       // [C] - Dominant on Fantom
    chain: 'fantom',
    factoryAddress: '0x152eE697f2E276fA89E96742e9bB9aB1F2E61bE3',
    routerAddress: '0xF491e7B69E4244ad4002BC14e878a34207E38c29',
    feeBps: bps(30),
  },
  {
    name: 'spiritswap',       // [H]
    chain: 'fantom',
    factoryAddress: '0xEF45d134b73241eDa7703fa787148D9C9F4950b0',
    routerAddress: '0x16327E3FbDaCA3bcF7E38F5Af2599D2DDc33aE52',
    feeBps: bps(30),
  },
  {
    name: 'equalizer',        // [H] - Solidly fork with ve(3,3)
    chain: 'fantom',
    factoryAddress: '0xc6366EFD0AF1d09171fe0EBF32c7943BB310832a',
    routerAddress: '0x1A05EB736873485655F29a37DEf8a0AA87F5a447',
    feeBps: bps(30),
  },
  {
    name: 'beethoven_x',      // [H] - Balancer V2 fork
    chain: 'fantom',
    factoryAddress: BALANCER_V2_VAULTS.fantom,  // Single source: addresses.ts (Beethoven X Vault)
    routerAddress: BALANCER_V2_VAULTS.fantom,    // Vault is also router
    feeBps: bps(30),
    enabled: true,
  },
];
