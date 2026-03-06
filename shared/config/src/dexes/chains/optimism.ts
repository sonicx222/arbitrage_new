/**
 * Optimism DEX Configurations — 5 DEXes
 * @see Phase 4: expanded from 3→5
 */
import { Dex, FeeBasisPoints } from '../../../../types';
import { BALANCER_V2_VAULTS } from '../../addresses';

const bps = (value: number): FeeBasisPoints => value as FeeBasisPoints;

export const OPTIMISM_DEXES: Dex[] = [
  {
    name: 'uniswap_v3',       // [C]
    chain: 'optimism',
    factoryAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    routerAddress: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    feeBps: bps(30),
  },
  {
    name: 'velodrome',        // [C]
    chain: 'optimism',
    factoryAddress: '0x25CbdDb98b35ab1FF77413456B31EC81A6B6B746',
    routerAddress: '0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858',
    feeBps: bps(30),
  },
  {
    name: 'sushiswap',        // [H]
    chain: 'optimism',
    factoryAddress: '0xFbc12984689e5f15626Bad03Ad60160Fe98B303C',
    routerAddress: '0x4C5D5234f232BD2D76B96aA33F5AE4FCF0E4BFAb',
    feeBps: bps(30),
  },
  {
    name: 'balancer_v2',      // [H] - 0% flash loan fees
    chain: 'optimism',
    factoryAddress: BALANCER_V2_VAULTS.optimism,  // Single source: addresses.ts
    routerAddress: BALANCER_V2_VAULTS.optimism,    // Vault is also router
    feeBps: bps(30),
    enabled: true,
  },
  {
    name: 'curve',            // [H] - Major stablecoin DEX
    chain: 'optimism',
    factoryAddress: '0x2db0E83599a91b508Ac268a6197b8B14F5e72840',
    routerAddress: '0xF0d4c12A5768D806021F80a262B4d39d26C58b8D',
    feeBps: bps(4),
  },
];
