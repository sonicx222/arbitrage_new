/**
 * BSC DEX Configurations — 8 DEXes (highest volume)
 * @see S2.2.3: BSC DEX expansion (5→8)
 */
import { Dex, FeeBasisPoints } from '../../../../types';

const bps = (value: number): FeeBasisPoints => value as FeeBasisPoints;

export const BSC_DEXES: Dex[] = [
  {
    name: 'pancakeswap_v3',   // [C]
    chain: 'bsc',
    factoryAddress: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
    routerAddress: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4',
    feeBps: bps(25),
  },
  {
    name: 'pancakeswap_v2',   // [C]
    chain: 'bsc',
    factoryAddress: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
    routerAddress: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
    feeBps: bps(25),
  },
  {
    name: 'biswap',           // [C]
    chain: 'bsc',
    factoryAddress: '0x858E3312ed3A876947EA49d572A7C42DE08af7EE',
    routerAddress: '0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8',
    feeBps: bps(10),
  },
  {
    name: 'thena',            // [H]
    chain: 'bsc',
    factoryAddress: '0xAFD89d21BdB66d00817d4153E055830B1c2B3970',
    routerAddress: '0x20a304a7d126758dfe6B243D0fc515F83bCA8431',
    feeBps: bps(20),
  },
  {
    name: 'apeswap',          // [H]
    chain: 'bsc',
    factoryAddress: '0x0841BD0B734E4F5853f0dD8d7Ea041c241fb0Da6',
    routerAddress: '0xcF0feBd3f17CEf5b47b0cD257aCf6025c5BFf3b7',
    feeBps: bps(20),
  },
  {
    name: 'mdex',             // [H] - Major BSC/HECO DEX
    chain: 'bsc',
    factoryAddress: '0x3CD1C46068dAEa5Ebb0d3f55F6915B10648062B8',
    routerAddress: '0x7DAe51BD3E3376B8c7c4900E9107f12Be3AF1bA8',
    feeBps: bps(30),
  },
  {
    name: 'ellipsis',         // [H] - Curve fork for stablecoins
    chain: 'bsc',
    factoryAddress: '0xf65BEd27e96a367c61e0E06C54e14B16b84a5870',
    routerAddress: '0x160CAed03795365F3A589f10C379FfA7d75d4E76',
    feeBps: bps(4),
  },
  {
    name: 'nomiswap',         // [M] - Competitive fees
    chain: 'bsc',
    factoryAddress: '0xD6715A8BE3944Ec72738f0bFdc739571659D8010',
    routerAddress: '0xD654953D746f0b114d1F85332Dc43446ac79413d',
    feeBps: bps(10),
  },
];
