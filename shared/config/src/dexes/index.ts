/**
 * DEX Configurations
 *
 * Contains all DEX configurations per chain including:
 * - Factory and router addresses
 * - Fee structures
 * - Priority classifications: [C] Critical, [H] High, [M] Medium
 *
 * Total: 78 DEXes across 15 chains (57 EVM + 7 Solana + 14 Emerging L2s)
 *
 * @see S2.2.1: Arbitrum DEX expansion (6→9)
 * @see S2.2.2: Base DEX expansion (5→7)
 * @see S2.2.3: BSC DEX expansion (5→8)
 * @see S3.1.2: New chain DEXes
 */

import { Dex, FeeBasisPoints } from '../../../types';

// Fee conversion constants - inline to avoid circular dependency with @arbitrage/core
// See @arbitrage/core utils/fee-utils.ts for the canonical source of truth
const BPS_DENOMINATOR = 10000;

/** Helper to create typed FeeBasisPoints value */
const bps = (value: number): FeeBasisPoints => value as FeeBasisPoints;

// =============================================================================
// DEX CONFIGURATIONS - 78 DEXs
// [C] = Critical, [H] = High Priority, [M] = Medium Priority
// =============================================================================
export const DEXES: Record<string, Dex[]> = {
  // Arbitrum: 10 DEXs (highest fragmentation) - S2.2.1 + Phase 4 expanded
  arbitrum: [
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
    // === S2.2.1: New DEXs (6 → 9) ===
    // Balancer V2 uses Vault model - uses BalancerV2Adapter for pool discovery
    {
      name: 'balancer_v2',      // [H] - Major liquidity protocol
      chain: 'arbitrum',
      factoryAddress: '0xBA12222222228d8Ba445958a75a0704d566BF2C8', // Balancer V2 Vault (uses adapter)
      routerAddress: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',  // Vault is also router for swaps
      feeBps: bps(30),  // Variable fees per pool, using default
      enabled: true  // ENABLED: Uses BalancerV2Adapter from dex-adapters
    },
    {
      name: 'curve',            // [H] - Major stablecoin DEX
      chain: 'arbitrum',
      factoryAddress: '0xb17b674D9c5CB2e441F8e196a2f048A81355d031', // Curve Factory
      routerAddress: '0xF0d4c12A5768D806021F80a262B4d39d26C58b8D',  // Curve Router
      feeBps: bps(4),  // 0.04% typical for stablecoin pools
    },
    {
      name: 'chronos',          // [M] - ve(3,3) DEX
      chain: 'arbitrum',
      factoryAddress: '0xCe9240869391928253Ed9cc9Bcb8cb98CB5B0722', // Chronos Factory
      routerAddress: '0xE708aA9E887980750C040a6A2Cb901c37Aa34f3b',  // Chronos Router
      feeBps: bps(30),
    },
    // === Phase 4: New DEXs (9 → 10) ===
    {
      name: 'uniswap_v2',       // [H] - V2 AMM, directly compatible with IDexRouter
      chain: 'arbitrum',
      factoryAddress: '0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9', // Uniswap V2 Factory on Arbitrum
      routerAddress: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24',  // Uniswap V2 Router on Arbitrum
      feeBps: bps(30),
    }
  ],
  // BSC: 8 DEXs (highest volume) - S2.2.3 expanded from 5 → 8
  bsc: [
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
    // === S2.2.3: New DEXs (5 → 8) ===
    {
      name: 'mdex',             // [H] - Major BSC/HECO DEX
      chain: 'bsc',
      factoryAddress: '0x3CD1C46068dAEa5Ebb0d3f55F6915B10648062B8',
      routerAddress: '0x7DAe51BD3E3376B8c7c4900E9107f12Be3AF1bA8',
      feeBps: bps(30),
    },
    {
      name: 'ellipsis',         // [H] - Curve fork for stablecoins (low fees)
      chain: 'bsc',
      factoryAddress: '0xf65BEd27e96a367c61e0E06C54e14B16b84a5870',
      routerAddress: '0x160CAed03795365F3A589f10C379FfA7d75d4E76',
      feeBps: bps(4),  // 0.04% typical for stablecoin pools
    },
    {
      name: 'nomiswap',         // [M] - Competitive fees
      chain: 'bsc',
      factoryAddress: '0xD6715A8BE3944Ec72738f0bFdc739571659D8010',
      routerAddress: '0xD654953D746f0b114d1F85332Dc43446ac79413d',
      feeBps: bps(10),  // 0.1% competitive fee
    }
  ],
  // Base: 8 DEXs (fastest growing) - S2.2.2 + Phase 4 expanded
  base: [
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
    // S2.2.2: New DEXs added (5 → 7)
    {
      name: 'maverick',         // [H] - Dynamic fee AMM
      chain: 'base',
      factoryAddress: '0x0A7e848Aca42d879EF06507Fca0E7b33A0a63c1e',
      routerAddress: '0x32aed3Bce901Da12ca8F29D3e95fC3cc54a85Fd9',
      feeBps: bps(1),  // 1 bp base fee (dynamic)
    },
    {
      name: 'alienbase',        // [M] - Native Base DEX
      chain: 'base',
      factoryAddress: '0x3E84D913803b02A4a7f027165E8cA42C14C0FdE7',
      routerAddress: '0x8c1A3cF8f83074169FE5D7aD50B978e1cD6b37c7',
      feeBps: bps(30),
    },
    // === Phase 4: PancakeSwap V3 ===
    // Factory verified in shared/config/src/addresses.ts:125
    {
      name: 'pancakeswap_v3',   // [H] - Multi-chain V3 AMM
      chain: 'base',
      factoryAddress: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', // PancakeSwap V3 Factory
      routerAddress: '0x678Aa4bF4E210cf2166753e054d5b7c31cc7fa86',  // PancakeSwap V3 SmartRouter on Base
      feeBps: bps(25),
    }
  ],
  // Polygon: 4 DEXs (low gas)
  polygon: [
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
    }
  ],
  // Optimism: 5 DEXs — expanded from 3 → 5 (Phase 4)
  optimism: [
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
    // === Phase 4: New DEXs (3 → 5) ===
    // Balancer V2 uses Vault model - verified in shared/config/src/addresses.ts:169
    {
      name: 'balancer_v2',      // [H] - Major liquidity protocol, 0% flash loan fees
      chain: 'optimism',
      factoryAddress: '0xBA12222222228d8Ba445958a75a0704d566BF2C8', // Balancer V2 Vault
      routerAddress: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',  // Vault is also router for swaps
      feeBps: bps(30),  // Variable fees per pool, using default
      enabled: true  // ENABLED: Uses BalancerV2Adapter from dex-adapters
    },
    {
      name: 'curve',            // [H] - Major stablecoin DEX
      chain: 'optimism',
      factoryAddress: '0x2db0E83599a91b508Ac268a6197b8B14F5e72840', // Curve Factory on Optimism
      routerAddress: '0xF0d4c12A5768D806021F80a262B4d39d26C58b8D',  // Curve Router (multi-chain)
      feeBps: bps(4),  // 0.04% typical for stablecoin pools
    }
  ],
  // Ethereum: 5 DEXs (selective - large arbs only) — Phase 0 Item 3: expanded from 2 → 5
  ethereum: [
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
    // === Phase 0 Item 3: New Ethereum DEXs (2 → 5) ===
    {
      name: 'uniswap_v2',       // [C] - $2B+ TVL, largest V2 AMM
      chain: 'ethereum',
      factoryAddress: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
      routerAddress: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
      feeBps: bps(30),
    },
    // Balancer V2 uses Vault model - uses BalancerV2Adapter for pool discovery
    {
      name: 'balancer_v2',      // [H] - $1B+ TVL, weighted pools
      chain: 'ethereum',
      factoryAddress: '0xBA12222222228d8Ba445958a75a0704d566BF2C8', // Balancer V2 Vault (uses adapter)
      routerAddress: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',  // Vault is also router for swaps
      feeBps: bps(30),  // Variable fees per pool, using default
      enabled: true  // ENABLED: Uses BalancerV2Adapter from dex-adapters
    },
    {
      name: 'curve',            // [H] - $3B+ TVL, dominant stablecoin DEX
      chain: 'ethereum',
      factoryAddress: '0xB9fC157394Af804a3578134A6585C0dc9cc990d4', // Curve Factory (meta pool)
      routerAddress: '0x99a58482BD75cbab83b27EC03CA68fF489b5788f',  // Curve Router v1.0
      feeBps: bps(4),  // 0.04% typical for stablecoin pools
    },
  ],
  // =============================================================================
  // S3.1.2: New Chain DEXs for 4-Partition Architecture
  // S3.2.1: Expanded Avalanche DEXs (6 total)
  // =============================================================================
  // Avalanche: 6 DEXs
  avalanche: [
    {
      name: 'trader_joe_v2',    // [C] - Dominant on Avalanche
      chain: 'avalanche',
      factoryAddress: '0x8e42f2F4101563bF679975178e880FD87d3eFd4e',
      routerAddress: '0x60aE616a2155Ee3d9A68541Ba4544862310933d4',
      feeBps: bps(30),
    },
    {
      name: 'pangolin',         // [H] - Native Avalanche DEX
      chain: 'avalanche',
      factoryAddress: '0xefa94DE7a4656D787667C749f7E1223D71E9FD88',
      routerAddress: '0xE54Ca86531e17Ef3616d22Ca28b0D458b6C89106',
      feeBps: bps(30),
    },
    {
      name: 'sushiswap',        // [H] - Multi-chain presence
      chain: 'avalanche',
      factoryAddress: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
      routerAddress: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
      feeBps: bps(30),
    },
    // S3.2.1: New DEXs added
    // GMX uses Vault model - uses GmxAdapter for pool discovery
    {
      name: 'gmx',              // [C] - Perpetuals/Spot, uses vault model
      chain: 'avalanche',
      factoryAddress: '0x9ab2De34A33fB459b538c43f251eB825645e8595', // GMX Vault (uses adapter)
      routerAddress: '0x5F719c2F1095F7B9fc68a68e35B51194f4b6abe8',  // GMX Router
      feeBps: bps(30),
      enabled: true  // ENABLED: Uses GmxAdapter from dex-adapters
    },
    // Platypus uses Pool model - uses PlatypusAdapter for pool discovery
    {
      name: 'platypus',         // [H] - Stablecoin-optimized AMM
      chain: 'avalanche',
      factoryAddress: '0x66357dCaCe80431aee0A7507e2E361B7e2402370', // Main Pool (uses adapter)
      routerAddress: '0x73256EC7575D999C360c1EeC118ECbEFd8DA7D12',  // Platypus Router
      feeBps: bps(4),
      enabled: true  // ENABLED: Uses PlatypusAdapter from dex-adapters
    },
    {
      name: 'kyberswap',        // [H] - KyberSwap Elastic (concentrated liquidity)
      chain: 'avalanche',
      factoryAddress: '0x5F1dddbf348aC2fbe22a163e30F99F9ECE3DD50a', // KyberSwap Elastic Factory
      routerAddress: '0xC1e7dFE73E1598E3910EF4C7845B68A9Ab6F4c83',  // KyberSwap Router
      feeBps: bps(10),
    }
  ],
  // Fantom: 4 DEXs (S3.2.2)
  fantom: [
    {
      name: 'spookyswap',       // [C] - Dominant on Fantom
      chain: 'fantom',
      factoryAddress: '0x152eE697f2E276fA89E96742e9bB9aB1F2E61bE3',
      routerAddress: '0xF491e7B69E4244ad4002BC14e878a34207E38c29',
      feeBps: bps(30),
    },
    {
      name: 'spiritswap',       // [H] - Second largest
      chain: 'fantom',
      factoryAddress: '0xEF45d134b73241eDa7703fa787148D9C9F4950b0',
      routerAddress: '0x16327E3FbDaCA3bcF7E38F5Af2599D2DDc33aE52',
      feeBps: bps(30),
    },
    {
      name: 'equalizer',        // [H] - Solidly fork with ve(3,3) model
      chain: 'fantom',
      factoryAddress: '0xc6366EFD0AF1d09171fe0EBF32c7943BB310832a',  // Equalizer V2 Factory
      routerAddress: '0x1A05EB736873485655F29a37DEf8a0AA87F5a447',   // Equalizer Router
      feeBps: bps(30),
    },
    // Beethoven X uses Balancer V2 Vault model - uses BalancerV2Adapter for pool discovery
    {
      name: 'beethoven_x',      // [H] - Balancer V2 fork, weighted pools
      chain: 'fantom',
      factoryAddress: '0x20dd72Ed959b6147912C2e529F0a0C651c33c9ce',  // Beethoven X Vault (uses adapter)
      routerAddress: '0x20dd72Ed959b6147912C2e529F0a0C651c33c9ce',   // Vault is also router for swaps
      feeBps: bps(30),
      enabled: true  // ENABLED: Uses BalancerV2Adapter from dex-adapters
    }
  ],
  // zkSync Era: 4 DEXs — expanded from 2 → 4 (Phase 4)
  zksync: [
    {
      name: 'syncswap',         // [C] - Largest on zkSync
      chain: 'zksync',
      factoryAddress: '0xf2DAd89f2788a8CD54625C60b55cD3d2D0ACa7Cb',
      routerAddress: '0x2da10A1e27bF85cEdD8FFb1AbBe97e53391C0295',
      feeBps: bps(30),
    },
    {
      name: 'mute',             // [H] - Native zkSync DEX
      chain: 'zksync',
      factoryAddress: '0x40be1cBa6C5B47cDF9da7f963B6F761F4C60627D',
      routerAddress: '0x8B791913eB07C32779a16750e3868aA8495F5964',
      feeBps: bps(30),
    },
    // === Phase 4: New DEXs (2 → 4) ===
    // PancakeSwap V3 factory verified in shared/config/src/addresses.ts:124
    {
      name: 'pancakeswap_v3',   // [H] - Multi-chain V3 AMM
      chain: 'zksync',
      factoryAddress: '0x1BB72E0CbbEA93c08f535fc7856E0338D7F7a8aB', // PancakeSwap V3 Factory (zkSync)
      routerAddress: '0xf8b59f3c3Ab33200ec80a8A58b2aA5F5D2a8944C',  // PancakeSwap V3 SmartRouter (zkSync)
      feeBps: bps(25),
    },
    {
      name: 'spacefi',          // [M] - V2-compatible DEX on zkSync
      chain: 'zksync',
      factoryAddress: '0x0700Fb51560CfC8F896B2c812499D17c5B0bF6A7', // SpaceFi Factory
      routerAddress: '0xbE7D1FD1f6748bbDefC4fbaCafBb11C6Fc506d1d',  // SpaceFi Router
      feeBps: bps(30),
    }
  ],
  // Linea: 3 DEXs — expanded from 2 → 3 (Phase 4)
  linea: [
    {
      name: 'syncswap',         // [C] - Multi-chain presence
      chain: 'linea',
      factoryAddress: '0x37BAc764494c8db4e54BDE72f6965beA9fa0AC2d',
      routerAddress: '0x80e38291e06339d10AAB483C65695D004dBD5C69',
      feeBps: bps(30),
    },
    {
      name: 'velocore',         // [H] - Native Linea DEX
      chain: 'linea',
      factoryAddress: '0x7160570BB153Edd0Ea1775EC2b2Ac9b65F1aB61B',
      routerAddress: '0x1d0188c4B276A09366D05d6Be06aF61a73bC7535', // Velocore Vault on Linea
      feeBps: bps(30),
    },
    // === Phase 4: PancakeSwap V3 ===
    // Factory verified in shared/config/src/addresses.ts:127
    {
      name: 'pancakeswap_v3',   // [H] - Multi-chain V3 AMM
      chain: 'linea',
      factoryAddress: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', // PancakeSwap V3 Factory
      routerAddress: '0x678Aa4bF4E210cf2166753e054d5b7c31cc7fa86',  // PancakeSwap V3 SmartRouter on Linea
      feeBps: bps(25),
    }
  ],
  // =============================================================================
  // Emerging L2s: Blast, Scroll, Mantle, Mode
  // TODO: Verify on-chain addresses before mainnet
  // =============================================================================
  // Blast: 4 DEXs
  // TODO: Verify on-chain addresses before mainnet
  blast: [
    {
      name: 'thruster_v3',       // [C] - Dominant on Blast
      chain: 'blast',
      factoryAddress: '0x0000000000000000000000000000000000000001',
      routerAddress: '0x0000000000000000000000000000000000000002',
      feeBps: bps(30),
    },
    {
      name: 'thruster_v2',       // [C] - V2 AMM on Blast
      chain: 'blast',
      factoryAddress: '0x0000000000000000000000000000000000000003',
      routerAddress: '0x0000000000000000000000000000000000000004',
      feeBps: bps(30),
    },
    {
      name: 'bladeswap',         // [H] - Native Blast DEX
      chain: 'blast',
      factoryAddress: '0x0000000000000000000000000000000000000005',
      routerAddress: '0x0000000000000000000000000000000000000006',
      feeBps: bps(30),
    },
    {
      name: 'ring_protocol',     // [M] - Ring Protocol on Blast
      chain: 'blast',
      factoryAddress: '0x0000000000000000000000000000000000000007',
      routerAddress: '0x0000000000000000000000000000000000000008',
      feeBps: bps(30),
    }
  ],
  // Scroll: 4 DEXs
  // TODO: Verify on-chain addresses before mainnet
  scroll: [
    {
      name: 'syncswap',          // [C] - Multi-chain presence on Scroll
      chain: 'scroll',
      factoryAddress: '0x0000000000000000000000000000000000000009',
      routerAddress: '0x000000000000000000000000000000000000000a',
      feeBps: bps(30),
    },
    {
      name: 'spacefi',           // [H] - Native Scroll DEX
      chain: 'scroll',
      factoryAddress: '0x000000000000000000000000000000000000000b',
      routerAddress: '0x000000000000000000000000000000000000000c',
      feeBps: bps(30),
    },
    {
      name: 'ambient',           // [H] - CrocSwap/Ambient on Scroll
      chain: 'scroll',
      factoryAddress: '0x000000000000000000000000000000000000000d',
      routerAddress: '0x000000000000000000000000000000000000000e',
      feeBps: bps(30),
    },
    {
      name: 'zebra',             // [M] - Zebra DEX on Scroll
      chain: 'scroll',
      factoryAddress: '0x000000000000000000000000000000000000000f',
      routerAddress: '0x0000000000000000000000000000000000000010',
      feeBps: bps(30),
    }
  ],
  // Mantle: 3 DEXs
  // TODO: Verify on-chain addresses before mainnet
  mantle: [
    {
      name: 'merchant_moe',      // [C] - Dominant on Mantle
      chain: 'mantle',
      factoryAddress: '0x0000000000000000000000000000000000000011',
      routerAddress: '0x0000000000000000000000000000000000000012',
      feeBps: bps(30),
    },
    {
      name: 'agni_finance',      // [H] - Agni Finance on Mantle
      chain: 'mantle',
      factoryAddress: '0x0000000000000000000000000000000000000013',
      routerAddress: '0x0000000000000000000000000000000000000014',
      feeBps: bps(30),
    },
    {
      name: 'fusionx',           // [H] - FusionX on Mantle
      chain: 'mantle',
      factoryAddress: '0x0000000000000000000000000000000000000015',
      routerAddress: '0x0000000000000000000000000000000000000016',
      feeBps: bps(30),
    }
  ],
  // Mode: 3 DEXs
  // TODO: Verify on-chain addresses before mainnet
  mode: [
    {
      name: 'kim_exchange',      // [C] - Dominant on Mode
      chain: 'mode',
      factoryAddress: '0x0000000000000000000000000000000000000017',
      routerAddress: '0x0000000000000000000000000000000000000018',
      feeBps: bps(30),
    },
    {
      name: 'supswap',           // [H] - SupSwap on Mode
      chain: 'mode',
      factoryAddress: '0x0000000000000000000000000000000000000019',
      routerAddress: '0x000000000000000000000000000000000000001a',
      feeBps: bps(30),
    },
    {
      name: 'swapmode',          // [M] - SwapMode native DEX
      chain: 'mode',
      factoryAddress: '0x000000000000000000000000000000000000001b',
      routerAddress: '0x000000000000000000000000000000000000001c',
      feeBps: bps(30),
    }
  ],
  // S3.3.2: Solana DEXs (Non-EVM, uses Solana program IDs)
  // 7 DEXs: Jupiter, Raydium AMM, Raydium CLMM, Orca, Meteora, Phoenix, Lifinity
  solana: [
    {
      name: 'jupiter',          // [C] - Largest aggregator on Solana
      chain: 'solana',
      factoryAddress: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
      routerAddress: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
      feeBps: bps(0),
      type: 'aggregator',
      enabled: false // Disabled for direct pool detection (routes through other DEXs)
    },
    {
      name: 'raydium',          // [C] - Largest AMM on Solana
      chain: 'solana',
      factoryAddress: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // AMM Program
      routerAddress: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
      feeBps: bps(25),
      type: 'amm',
      enabled: true
    },
    {
      name: 'raydium-clmm',     // [C] - Raydium Concentrated Liquidity
      chain: 'solana',
      factoryAddress: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // CLMM Program
      routerAddress: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
      feeBps: bps(25),
      type: 'clmm',
      enabled: true
    },
    {
      name: 'orca',             // [H] - Second largest, Whirlpools
      chain: 'solana',
      // FIX S3.3.2: Corrected Orca Whirlpool program ID (was 9W959... legacy token swap)
      factoryAddress: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Whirlpool Program
      routerAddress: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
      feeBps: bps(30),
      type: 'clmm',
      enabled: true
    },
    {
      name: 'meteora',          // [H] - Dynamic Liquidity Market Maker
      chain: 'solana',
      factoryAddress: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // DLMM Program
      routerAddress: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
      feeBps: bps(20),
      type: 'dlmm',
      enabled: true
    },
    {
      name: 'phoenix',          // [H] - On-chain order book
      chain: 'solana',
      factoryAddress: 'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY',
      routerAddress: 'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY',
      feeBps: bps(10),
      type: 'orderbook',
      enabled: true
    },
    {
      name: 'lifinity',         // [H] - Proactive market maker with oracle pricing
      chain: 'solana',
      factoryAddress: '2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c',
      routerAddress: '2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c',
      feeBps: bps(20),
      type: 'pmm',
      enabled: true
    }
  ]
};

// =============================================================================
// DEX HELPER FUNCTIONS
// Standardize DEX access patterns across the codebase
// =============================================================================

/**
 * PERFORMANCE FIX: Pre-computed enabled DEXes cache.
 * Computed once at module load instead of filtering on every getEnabledDexes() call.
 * This is a hot-path optimization for arbitrage detection.
 */
const ENABLED_DEXES_CACHE: Record<string, Dex[]> = Object.fromEntries(
  Object.entries(DEXES).map(([chainId, dexes]) => [
    chainId,
    dexes.filter(dex => dex.enabled !== false)
  ])
);

/**
 * Get enabled DEXs for a chain.
 * Returns pre-computed filtered list (enabled !== false).
 * Uses cached result for performance in hot-path code.
 *
 * @param chainId - The chain identifier (e.g., 'arbitrum', 'bsc')
 * @returns Array of enabled Dex objects for the chain (read-only reference)
 */
export function getEnabledDexes(chainId: string): Dex[] {
  return ENABLED_DEXES_CACHE[chainId] || [];
}

/**
 * Convert DEX fee from basis points to percentage.
 * Config stores fees in basis points (e.g., 30 = 0.30%), calculations use percentage.
 *
 * @deprecated Use bpsToDecimal from '@arbitrage/core' instead
 * @param feeBasisPoints - Fee in basis points (e.g., 30 for 0.30%)
 * @returns Fee as a decimal percentage (e.g., 0.003 for 0.30%)
 */
export function dexFeeToPercentage(feeBasisPoints: number): number {
  return feeBasisPoints / BPS_DENOMINATOR;
}

/**
 * Convert percentage to basis points.
 * Inverse of dexFeeToPercentage.
 *
 * @deprecated Use decimalToBps from '@arbitrage/core' instead
 * @param percentage - Fee as decimal (e.g., 0.003 for 0.30%)
 * @returns Fee in basis points (e.g., 30 for 0.30%)
 */
export function percentageToBasisPoints(percentage: number): number {
  return Math.round(percentage * BPS_DENOMINATOR);
}
