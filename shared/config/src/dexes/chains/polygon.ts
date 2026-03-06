/**
 * Polygon DEX Configurations — 4 DEXes
 */
import { Dex, FeeBasisPoints } from '../../../../types';

const bps = (value: number): FeeBasisPoints => value as FeeBasisPoints;

export const POLYGON_DEXES: Dex[] = [
  {
    name: 'uniswap_v3',       // [C]
    chain: 'polygon',
    factoryAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    routerAddress: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    feeBps: bps(30),
  },
  {
    name: 'quickswap_v3',     // [C]
    chain: 'polygon',
    factoryAddress: '0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28',
    routerAddress: '0xf5b509bB0909a69B1c207E495f687a596C168E12',
    feeBps: bps(30),
  },
  {
    name: 'sushiswap',        // [H]
    chain: 'polygon',
    factoryAddress: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
    routerAddress: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
    feeBps: bps(30),
  },
  {
    name: 'apeswap',          // [M]
    chain: 'polygon',
    factoryAddress: '0xCf083Be4164828f00cAE704EC15a36D711491284',
    routerAddress: '0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607',
    feeBps: bps(20),
  },
];
