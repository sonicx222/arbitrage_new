/**
 * Arbitrum DEX Configurations — 10 DEXes
 * @see S2.2.1: Arbitrum DEX expansion (6→9), Phase 4 (9→10)
 */
import { Dex, FeeBasisPoints } from '../../../../types';

const bps = (value: number): FeeBasisPoints => value as FeeBasisPoints;

export const ARBITRUM_DEXES: Dex[] = [
  {
    name: 'uniswap_v3',       // [C]
    chain: 'arbitrum',
    factoryAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    routerAddress: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    feeBps: bps(30),
  },
  {
    name: 'camelot_v3',       // [C]
    chain: 'arbitrum',
    factoryAddress: '0x1a3c9B1d2F0529D97f2afC5136Cc23e58f1FD35B',
    routerAddress: '0xc873fEcbd354f5A56E00E710B90EF4201db2448d',
    feeBps: bps(30),
  },
  {
    name: 'sushiswap',        // [C]
    chain: 'arbitrum',
    factoryAddress: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
    routerAddress: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
    feeBps: bps(30),
  },
  {
    name: 'trader_joe',       // [H]
    chain: 'arbitrum',
    factoryAddress: '0x1886D09C9Ade0c5DB822D85D21678Db67B6c2982',
    routerAddress: '0xBee5C10cF6E4f68f831E11c1d9e59b43560B3571',
    feeBps: bps(30),
  },
  {
    name: 'zyberswap',        // [M]
    chain: 'arbitrum',
    factoryAddress: '0xaC2ee06A14c52570Ef3B9812Ed240BCe359772e7',
    routerAddress: '0x16e71B13fE6079B4312063F7E81F76d165Ad32Ad',
    feeBps: bps(30),
  },
  {
    name: 'ramses',           // [M]
    chain: 'arbitrum',
    factoryAddress: '0xAAA20D08e59F6561f242b08513D36266C5A29415',
    routerAddress: '0xAAA87963EFeB6f7E0a2711F397663105Acb1805e',
    feeBps: bps(30),
  },
  {
    name: 'balancer_v2',      // [H] - Major liquidity protocol
    chain: 'arbitrum',
    factoryAddress: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    routerAddress: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    feeBps: bps(30),
    enabled: true,
  },
  {
    name: 'curve',            // [H] - Major stablecoin DEX
    chain: 'arbitrum',
    factoryAddress: '0xb17b674D9c5CB2e441F8e196a2f048A81355d031',
    routerAddress: '0xF0d4c12A5768D806021F80a262B4d39d26C58b8D',
    feeBps: bps(4),
  },
  {
    name: 'chronos',          // [M] - ve(3,3) DEX
    chain: 'arbitrum',
    factoryAddress: '0xCe9240869391928253Ed9cc9Bcb8cb98CB5B0722',
    routerAddress: '0xE708aA9E887980750C040a6A2Cb901c37Aa34f3b',
    feeBps: bps(30),
  },
  {
    name: 'uniswap_v2',       // [H] - V2 AMM
    chain: 'arbitrum',
    factoryAddress: '0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9',
    routerAddress: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24',
    feeBps: bps(30),
  },
];
