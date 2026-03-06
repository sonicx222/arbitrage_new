/**
 * Linea DEX Configurations — 3 DEXes
 * @see Phase 4: expanded from 2→3
 */
import { Dex, FeeBasisPoints } from '../../../../types';

const bps = (value: number): FeeBasisPoints => value as FeeBasisPoints;

export const LINEA_DEXES: Dex[] = [
  {
    name: 'syncswap',         // [C]
    chain: 'linea',
    factoryAddress: '0x37BAc764494c8db4e54BDE72f6965beA9fa0AC2d',
    routerAddress: '0x80e38291e06339d10AAB483C65695D004dBD5C69',
    feeBps: bps(30),
  },
  {
    name: 'velocore',         // [H]
    chain: 'linea',
    factoryAddress: '0x7160570BB153Edd0Ea1775EC2b2Ac9b65F1aB61B',
    routerAddress: '0x1d0188c4B276A09366D05d6Be06aF61a73bC7535',
    feeBps: bps(30),
  },
  {
    name: 'pancakeswap_v3',   // [H]
    chain: 'linea',
    factoryAddress: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
    routerAddress: '0x678Aa4bF4E210cf2166753e054d5b7c31cc7fa86',
    feeBps: bps(25),
  },
];
