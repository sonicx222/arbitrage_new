/**
 * Ethereum DEX Configurations — 5 DEXes (selective — large arbs only)
 * @see Phase 0 Item 3: expanded from 2→5
 */
import { Dex, FeeBasisPoints } from '../../../../types';

const bps = (value: number): FeeBasisPoints => value as FeeBasisPoints;

export const ETHEREUM_DEXES: Dex[] = [
  {
    name: 'uniswap_v3',       // [C]
    chain: 'ethereum',
    factoryAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    routerAddress: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    feeBps: bps(30),
  },
  {
    name: 'sushiswap',        // [C]
    chain: 'ethereum',
    factoryAddress: '0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac',
    routerAddress: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',
    feeBps: bps(30),
  },
  {
    name: 'uniswap_v2',       // [C] - $2B+ TVL
    chain: 'ethereum',
    factoryAddress: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
    routerAddress: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
    feeBps: bps(30),
  },
  {
    name: 'balancer_v2',      // [H] - $1B+ TVL, weighted pools
    chain: 'ethereum',
    factoryAddress: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    routerAddress: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    feeBps: bps(30),
    enabled: true,
  },
  {
    name: 'curve',            // [H] - $3B+ TVL, dominant stablecoin DEX
    chain: 'ethereum',
    factoryAddress: '0xB9fC157394Af804a3578134A6585C0dc9cc990d4',
    routerAddress: '0x99a58482BD75cbab83b27EC03CA68fF489b5788f',
    feeBps: bps(4),
  },
];
