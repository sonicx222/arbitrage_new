/**
 * Base DEX Configurations — 8 DEXes (fastest growing)
 * @see S2.2.2: Base DEX expansion (5→7), Phase 4 (7→8)
 */
import { Dex, FeeBasisPoints } from '../../../../types';

const bps = (value: number): FeeBasisPoints => value as FeeBasisPoints;

export const BASE_DEXES: Dex[] = [
  {
    name: 'uniswap_v3',       // [C]
    chain: 'base',
    factoryAddress: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
    routerAddress: '0x2626664c2603336E57B271c5C0b26F421741e481',
    feeBps: bps(30),
  },
  {
    name: 'aerodrome',        // [C]
    chain: 'base',
    factoryAddress: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
    routerAddress: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
    feeBps: bps(30),
  },
  {
    name: 'baseswap',         // [C]
    chain: 'base',
    factoryAddress: '0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB',
    routerAddress: '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86',
    feeBps: bps(30),
  },
  {
    name: 'sushiswap',        // [H]
    chain: 'base',
    factoryAddress: '0x71524B4f93c58fcbF659783284E38825f0622859',
    routerAddress: '0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891',
    feeBps: bps(30),
  },
  {
    name: 'swapbased',        // [M]
    chain: 'base',
    factoryAddress: '0x04C9f118d21e8B767D2e50C946f0cC9F6C367300',
    routerAddress: '0xaaa3b1F1bd7BCc97fD1917c18ADE665C5D31F066',
    feeBps: bps(30),
  },
  {
    name: 'maverick',         // [H] - Dynamic fee AMM
    chain: 'base',
    factoryAddress: '0x0A7e848Aca42d879EF06507Fca0E7b33A0a63c1e',
    routerAddress: '0x32aed3Bce901Da12ca8F29D3e95fC3cc54a85Fd9',
    feeBps: bps(1),
  },
  {
    name: 'alienbase',        // [M] - Native Base DEX
    chain: 'base',
    factoryAddress: '0x3E84D913803b02A4a7f027165E8cA42C14C0FdE7',
    routerAddress: '0x8c1A3cF8f83074169FE5D7aD50B978e1cD6b37c7',
    feeBps: bps(30),
  },
  {
    name: 'pancakeswap_v3',   // [H] - Multi-chain V3 AMM
    chain: 'base',
    factoryAddress: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
    routerAddress: '0x678Aa4bF4E210cf2166753e054d5b7c31cc7fa86',
    feeBps: bps(25),
  },
];
