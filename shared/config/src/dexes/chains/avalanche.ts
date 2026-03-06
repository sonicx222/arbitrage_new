/**
 * Avalanche DEX Configurations — 6 DEXes
 * @see S3.2.1: Expanded Avalanche DEXs
 */
import { Dex, FeeBasisPoints } from '../../../../types';

const bps = (value: number): FeeBasisPoints => value as FeeBasisPoints;

export const AVALANCHE_DEXES: Dex[] = [
  {
    name: 'trader_joe_v2',    // [C] - Dominant on Avalanche
    chain: 'avalanche',
    factoryAddress: '0x8e42f2F4101563bF679975178e880FD87d3eFd4e',
    routerAddress: '0x60aE616a2155Ee3d9A68541Ba4544862310933d4',
    feeBps: bps(30),
  },
  {
    name: 'pangolin',         // [H]
    chain: 'avalanche',
    factoryAddress: '0xefa94DE7a4656D787667C749f7E1223D71E9FD88',
    routerAddress: '0xE54Ca86531e17Ef3616d22Ca28b0D458b6C89106',
    feeBps: bps(30),
  },
  {
    name: 'sushiswap',        // [H]
    chain: 'avalanche',
    factoryAddress: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
    routerAddress: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
    feeBps: bps(30),
  },
  {
    name: 'gmx',              // [C] - Perpetuals/Spot, vault model
    chain: 'avalanche',
    factoryAddress: '0x9ab2De34A33fB459b538c43f251eB825645e8595',
    routerAddress: '0x5F719c2F1095F7B9fc68a68e35B51194f4b6abe8',
    feeBps: bps(30),
    enabled: true,
  },
  {
    name: 'platypus',         // [H] - Stablecoin-optimized AMM
    chain: 'avalanche',
    factoryAddress: '0x66357dCaCe80431aee0A7507e2E361B7e2402370',
    routerAddress: '0x73256EC7575D999C360c1EeC118ECbEFd8DA7D12',
    feeBps: bps(4),
    enabled: true,
  },
  {
    name: 'kyberswap',        // [H] - Concentrated liquidity
    chain: 'avalanche',
    factoryAddress: '0x5F1dddbf348aC2fbe22a163e30F99F9ECE3DD50a',
    routerAddress: '0xC1e7dFE73E1598E3910EF4C7845B68A9Ab6F4c83',
    feeBps: bps(10),
  },
];
