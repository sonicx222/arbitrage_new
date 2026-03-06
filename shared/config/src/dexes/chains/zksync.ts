/**
 * zkSync Era DEX Configurations — 4 DEXes
 * @see Phase 4: expanded from 2→4
 */
import { Dex, FeeBasisPoints } from '../../../../types';

const bps = (value: number): FeeBasisPoints => value as FeeBasisPoints;

export const ZKSYNC_DEXES: Dex[] = [
  {
    name: 'syncswap',         // [C] - Largest on zkSync
    chain: 'zksync',
    factoryAddress: '0xf2DAd89f2788a8CD54625C60b55cD3d2D0ACa7Cb',
    routerAddress: '0x2da10A1e27bF85cEdD8FFb1AbBe97e53391C0295',
    feeBps: bps(30),
  },
  {
    name: 'mute',             // [H]
    chain: 'zksync',
    factoryAddress: '0x40be1cBa6C5B47cDF9da7f963B6F761F4C60627D',
    routerAddress: '0x8B791913eB07C32779a16750e3868aA8495F5964',
    feeBps: bps(30),
  },
  {
    name: 'pancakeswap_v3',   // [H]
    chain: 'zksync',
    factoryAddress: '0x1BB72E0CbbEA93c08f535fc7856E0338D7F7a8aB',
    routerAddress: '0xf8b59f3c3Ab33200ec80a8A58b2aA5F5D2a8944C',
    feeBps: bps(25),
  },
  {
    name: 'spacefi',          // [M]
    chain: 'zksync',
    factoryAddress: '0x0700Fb51560CfC8F896B2c812499D17c5B0bF6A7',
    routerAddress: '0xbE7D1FD1f6748bbDefC4fbaCafBb11C6Fc506d1d',
    feeBps: bps(30),
  },
];
