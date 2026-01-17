"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.assignChainToPartition = exports.getPartitionFromEnv = exports.getPartition = exports.PARTITION_IDS = exports.PARTITIONS = exports.CROSS_CHAIN_TOKEN_ALIASES = exports.SYSTEM_CONSTANTS = exports.BRIDGE_COSTS = exports.FLASH_LOAN_PROVIDERS = exports.DETECTOR_CONFIG = exports.EVENT_SIGNATURES = exports.TOKEN_METADATA = exports.PHASE_METRICS = exports.PARTITION_CONFIG = exports.EVENT_CONFIG = exports.ARBITRAGE_CONFIG = exports.PERFORMANCE_THRESHOLDS = exports.SERVICE_CONFIGS = exports.CORE_TOKENS = exports.DEXES = exports.CHAINS = void 0;
exports.getEnabledDexes = getEnabledDexes;
exports.dexFeeToPercentage = dexFeeToPercentage;
exports.percentageToBasisPoints = percentageToBasisPoints;
exports.getBridgeCost = getBridgeCost;
exports.calculateBridgeCostUsd = calculateBridgeCostUsd;
exports.normalizeTokenForCrossChain = normalizeTokenForCrossChain;
exports.findCommonTokensBetweenChains = findCommonTokensBetweenChains;
exports.getChainSpecificTokenSymbol = getChainSpecificTokenSymbol;
// Validate required environment variables at startup (skip in test environment)
if (process.env.NODE_ENV !== 'test') {
    if (!process.env.ETHEREUM_RPC_URL) {
        throw new Error('CRITICAL CONFIG ERROR: ETHEREUM_RPC_URL environment variable is required');
    }
    if (!process.env.ETHEREUM_WS_URL) {
        throw new Error('CRITICAL CONFIG ERROR: ETHEREUM_WS_URL environment variable is required');
    }
}
// =============================================================================
// CHAIN CONFIGURATIONS - Phase 1: 7 Chains
// Priority: T1 (Arbitrum, BSC, Base), T2 (Polygon, Optimism), T3 (Ethereum)
// =============================================================================
exports.CHAINS = {
    // T1: Highest arbitrage potential
    arbitrum: {
        id: 42161,
        name: 'Arbitrum',
        rpcUrl: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',
        wsUrl: process.env.ARBITRUM_WS_URL || 'wss://arb1.arbitrum.io/feed',
        // S3.3: WebSocket fallback URLs for resilience
        wsFallbackUrls: [
            'wss://arbitrum.publicnode.com',
            'wss://arbitrum-mainnet.public.blastapi.io',
            'wss://arb-mainnet.g.alchemy.com/v2/demo'
        ],
        rpcFallbackUrls: [
            'https://arbitrum.publicnode.com',
            'https://arbitrum-mainnet.public.blastapi.io',
            'https://arb1.croswap.com/rpc'
        ],
        blockTime: 0.25,
        nativeToken: 'ETH'
    },
    bsc: {
        id: 56,
        name: 'BSC',
        rpcUrl: process.env.BSC_RPC_URL || 'https://bsc-dataseed1.binance.org',
        // FIX: Use more reliable publicnode.com as primary (nariox.org times out frequently)
        wsUrl: process.env.BSC_WS_URL || 'wss://bsc.publicnode.com',
        // S3.3: WebSocket fallback URLs for resilience
        wsFallbackUrls: [
            'wss://bsc-mainnet.public.blastapi.io',
            'wss://bsc-rpc.publicnode.com',
            'wss://bsc-ws-node.nariox.org:443' // Moved to fallback - known to be unreliable
        ],
        rpcFallbackUrls: [
            'https://bsc-dataseed2.binance.org',
            'https://bsc-dataseed3.binance.org',
            'https://bsc.publicnode.com'
        ],
        blockTime: 3,
        nativeToken: 'BNB'
    },
    base: {
        id: 8453,
        name: 'Base',
        rpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
        wsUrl: process.env.BASE_WS_URL || 'wss://mainnet.base.org',
        // S3.3: WebSocket fallback URLs for resilience
        wsFallbackUrls: [
            'wss://base.publicnode.com',
            'wss://base-mainnet.public.blastapi.io'
        ],
        rpcFallbackUrls: [
            'https://base.publicnode.com',
            'https://base-mainnet.public.blastapi.io',
            'https://1rpc.io/base'
        ],
        blockTime: 2,
        nativeToken: 'ETH'
    },
    // T2: High value, mature ecosystems
    polygon: {
        id: 137,
        name: 'Polygon',
        rpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
        wsUrl: process.env.POLYGON_WS_URL || 'wss://polygon-rpc.com',
        // S3.3: WebSocket fallback URLs for resilience
        wsFallbackUrls: [
            'wss://polygon-bor-rpc.publicnode.com',
            'wss://polygon-mainnet.public.blastapi.io'
        ],
        rpcFallbackUrls: [
            'https://polygon-bor-rpc.publicnode.com',
            'https://polygon-mainnet.public.blastapi.io',
            'https://polygon.llamarpc.com'
        ],
        blockTime: 2,
        nativeToken: 'MATIC'
    },
    optimism: {
        id: 10,
        name: 'Optimism',
        rpcUrl: process.env.OPTIMISM_RPC_URL || 'https://opt-mainnet.g.alchemy.com/v2/' + (process.env.ALCHEMY_OPTIMISM_KEY || ''),
        wsUrl: process.env.OPTIMISM_WS_URL || 'wss://opt-mainnet.g.alchemy.com/v2/' + (process.env.ALCHEMY_OPTIMISM_KEY || ''),
        wsFallbackUrls: [
            'wss://mainnet.optimism.io',
            'wss://optimism.publicnode.com',
            'wss://optimism-mainnet.public.blastapi.io'
        ],
        rpcFallbackUrls: [
            'https://mainnet.optimism.io',
            'https://optimism.publicnode.com',
            'https://optimism-mainnet.public.blastapi.io'
        ],
        blockTime: 2,
        nativeToken: 'ETH'
    },
    // T3: Selective - only large opportunities
    ethereum: {
        id: 1,
        name: 'Ethereum',
        rpcUrl: process.env.ETHEREUM_RPC_URL || 'https://eth.llamarpc.com',
        wsUrl: process.env.ETHEREUM_WS_URL || 'wss://eth.llamarpc.com',
        // S3.3: WebSocket fallback URLs for resilience
        wsFallbackUrls: [
            'wss://ethereum.publicnode.com',
            'wss://eth-mainnet.public.blastapi.io'
        ],
        rpcFallbackUrls: [
            'https://ethereum.publicnode.com',
            'https://eth-mainnet.public.blastapi.io',
            'https://1rpc.io/eth'
        ],
        blockTime: 12,
        nativeToken: 'ETH'
    },
    // =============================================================================
    // S3.1.2: New Chains for 4-Partition Architecture
    // =============================================================================
    // Asia-Fast expansion (P1)
    avalanche: {
        id: 43114,
        name: 'Avalanche C-Chain',
        rpcUrl: process.env.AVALANCHE_RPC_URL || 'https://api.avax.network/ext/bc/C/rpc',
        wsUrl: process.env.AVALANCHE_WS_URL || 'wss://api.avax.network/ext/bc/C/ws',
        // S3.3: WebSocket fallback URLs for resilience
        wsFallbackUrls: [
            'wss://avalanche-c-chain.publicnode.com',
            'wss://avax-mainnet.public.blastapi.io/ext/bc/C/ws'
        ],
        rpcFallbackUrls: [
            'https://avalanche-c-chain.publicnode.com',
            'https://avax-mainnet.public.blastapi.io/ext/bc/C/rpc',
            'https://1rpc.io/avax/c'
        ],
        blockTime: 2,
        nativeToken: 'AVAX'
    },
    fantom: {
        id: 250,
        name: 'Fantom Opera',
        rpcUrl: process.env.FANTOM_RPC_URL || 'https://rpc.ftm.tools',
        // FIX: Use more reliable publicnode.com as primary (wsapi.fantom.network is unstable)
        wsUrl: process.env.FANTOM_WS_URL || 'wss://fantom.publicnode.com',
        // S3.3: WebSocket fallback URLs for resilience - expanded with more reliable providers
        wsFallbackUrls: [
            'wss://fantom-mainnet.public.blastapi.io',
            'wss://fantom.drpc.org',
            'wss://wsapi.fantom.network' // Moved to fallback - known to be unreliable
        ],
        rpcFallbackUrls: [
            'https://fantom.publicnode.com',
            'https://fantom-mainnet.public.blastapi.io',
            'https://fantom.drpc.org',
            'https://1rpc.io/ftm'
        ],
        blockTime: 1,
        nativeToken: 'FTM'
    },
    // High-Value expansion (P3)
    zksync: {
        id: 324,
        name: 'zkSync Era',
        rpcUrl: process.env.ZKSYNC_RPC_URL || 'https://mainnet.era.zksync.io',
        wsUrl: process.env.ZKSYNC_WS_URL || 'wss://mainnet.era.zksync.io/ws',
        // S3.3: WebSocket fallback URLs for resilience
        wsFallbackUrls: [
            'wss://zksync.drpc.org',
            'wss://zksync-era.publicnode.com'
        ],
        rpcFallbackUrls: [
            'https://zksync.drpc.org',
            'https://zksync-era.publicnode.com',
            'https://1rpc.io/zksync2-era'
        ],
        blockTime: 1,
        nativeToken: 'ETH'
    },
    linea: {
        id: 59144,
        name: 'Linea',
        rpcUrl: process.env.LINEA_RPC_URL || 'https://rpc.linea.build',
        wsUrl: process.env.LINEA_WS_URL || 'wss://rpc.linea.build',
        // S3.3: WebSocket fallback URLs for resilience
        wsFallbackUrls: [
            'wss://linea.drpc.org'
        ],
        rpcFallbackUrls: [
            'https://linea.drpc.org',
            'https://1rpc.io/linea',
            'https://linea-mainnet.public.blastapi.io'
        ],
        blockTime: 2,
        nativeToken: 'ETH'
    },
    // Non-EVM chain (P4)
    solana: {
        id: 101, // Convention for Solana mainnet
        name: 'Solana',
        rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
        wsUrl: process.env.SOLANA_WS_URL || 'wss://api.mainnet-beta.solana.com',
        // S3.3: WebSocket fallback URLs for resilience
        wsFallbackUrls: [
            'wss://solana.publicnode.com'
        ],
        rpcFallbackUrls: [
            'https://solana.publicnode.com',
            'https://solana-mainnet.g.alchemy.com/v2/demo'
        ],
        blockTime: 0.4,
        nativeToken: 'SOL',
        isEVM: false
    }
};
// =============================================================================
// DEX CONFIGURATIONS - 33 DEXs (S2.2.1: Arbitrum 6→9, S2.2.2: Base 5→7, S2.2.3: BSC 5→8)
// [C] = Critical, [H] = High Priority, [M] = Medium Priority
// =============================================================================
exports.DEXES = {
    // Arbitrum: 9 DEXs (highest fragmentation) - S2.2.1 expanded
    arbitrum: [
        {
            name: 'uniswap_v3', // [C]
            chain: 'arbitrum',
            factoryAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
            routerAddress: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
            fee: 30
        },
        {
            name: 'camelot_v3', // [C]
            chain: 'arbitrum',
            factoryAddress: '0x1a3c9B1d2F0529D97f2afC5136Cc23e58f1FD35B',
            routerAddress: '0xc873fEcbd354f5A56E00E710B90EF4201db2448d',
            fee: 30
        },
        {
            name: 'sushiswap', // [C]
            chain: 'arbitrum',
            factoryAddress: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
            routerAddress: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
            fee: 30
        },
        {
            name: 'trader_joe', // [H]
            chain: 'arbitrum',
            factoryAddress: '0x1886D09C9Ade0c5DB822D85D21678Db67B6c2982',
            routerAddress: '0xBee5C10cF6E4f68f831E11c1d9e59b43560B3571',
            fee: 30
        },
        {
            name: 'zyberswap', // [M]
            chain: 'arbitrum',
            factoryAddress: '0xaC2ee06A14c52570Ef3B9812Ed240BCe359772e7',
            routerAddress: '0x16e71B13fE6079B4312063F7E81F76d165Ad32Ad',
            fee: 30
        },
        {
            name: 'ramses', // [M]
            chain: 'arbitrum',
            factoryAddress: '0xAAA20D08e59F6561f242b08513D36266C5A29415',
            routerAddress: '0xAAA87963EFeB6f7E0a2711F397663105Acb1805e',
            fee: 30
        },
        // === S2.2.1: New DEXs (6 → 9) ===
        // Balancer V2 uses Vault model - uses BalancerV2Adapter for pool discovery
        {
            name: 'balancer_v2', // [H] - Major liquidity protocol
            chain: 'arbitrum',
            factoryAddress: '0xBA12222222228d8Ba445958a75a0704d566BF2C8', // Balancer V2 Vault (uses adapter)
            routerAddress: '0xBA12222222228d8Ba445958a75a0704d566BF2C8', // Vault is also router for swaps
            fee: 30, // Variable fees per pool, using default
            enabled: true // ENABLED: Uses BalancerV2Adapter from dex-adapters
        },
        {
            name: 'curve', // [H] - Major stablecoin DEX
            chain: 'arbitrum',
            factoryAddress: '0xb17b674D9c5CB2e441F8e196a2f048A81355d031', // Curve Factory
            routerAddress: '0xF0d4c12A5768D806021F80a262B4d39d26C58b8D', // Curve Router
            fee: 4 // 0.04% typical for stablecoin pools
        },
        {
            name: 'chronos', // [M] - ve(3,3) DEX
            chain: 'arbitrum',
            factoryAddress: '0xCe9240869391928253Ed9cc9Bcb8cb98CB5B0722', // Chronos Factory
            routerAddress: '0xE708aA9E887980750C040a6A2Cb901c37Aa34f3b', // Chronos Router
            fee: 30
        }
    ],
    // BSC: 8 DEXs (highest volume) - S2.2.3 expanded from 5 → 8
    bsc: [
        {
            name: 'pancakeswap_v3', // [C]
            chain: 'bsc',
            factoryAddress: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
            routerAddress: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4',
            fee: 25
        },
        {
            name: 'pancakeswap_v2', // [C]
            chain: 'bsc',
            factoryAddress: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
            routerAddress: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
            fee: 25
        },
        {
            name: 'biswap', // [C]
            chain: 'bsc',
            factoryAddress: '0x858E3312ed3A876947EA49d572A7C42DE08af7EE',
            routerAddress: '0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8',
            fee: 10
        },
        {
            name: 'thena', // [H]
            chain: 'bsc',
            factoryAddress: '0xAFD89d21BdB66d00817d4153E055830B1c2B3970',
            routerAddress: '0x20a304a7d126758dfe6B243D0fc515F83bCA8431',
            fee: 20
        },
        {
            name: 'apeswap', // [H]
            chain: 'bsc',
            factoryAddress: '0x0841BD0B734E4F5853f0dD8d7Ea041c241fb0Da6',
            routerAddress: '0xcF0feBd3f17CEf5b47b0cD257aCf6025c5BFf3b7',
            fee: 20
        },
        // === S2.2.3: New DEXs (5 → 8) ===
        {
            name: 'mdex', // [H] - Major BSC/HECO DEX
            chain: 'bsc',
            factoryAddress: '0x3CD1C46068dAEa5Ebb0d3f55F6915B10648062B8',
            routerAddress: '0x7DAe51BD3E3376B8c7c4900E9107f12Be3AF1bA8',
            fee: 30
        },
        {
            name: 'ellipsis', // [H] - Curve fork for stablecoins (low fees)
            chain: 'bsc',
            factoryAddress: '0xf65BEd27e96a367c61e0E06C54e14B16b84a5870',
            routerAddress: '0x160CAed03795365F3A589f10C379FfA7d75d4E76',
            fee: 4 // 0.04% typical for stablecoin pools
        },
        {
            name: 'nomiswap', // [M] - Competitive fees
            chain: 'bsc',
            factoryAddress: '0xD6715A8BE3944Ec72738f0bFdc739571659D8010',
            routerAddress: '0xD654953D746f0b114d1F85332Dc43446ac79413d',
            fee: 10 // 0.1% competitive fee
        }
    ],
    // Base: 7 DEXs (fastest growing) - S2.2.2 expanded from 5 → 7
    base: [
        {
            name: 'uniswap_v3', // [C]
            chain: 'base',
            factoryAddress: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
            routerAddress: '0x2626664c2603336E57B271c5C0b26F421741e481',
            fee: 30
        },
        {
            name: 'aerodrome', // [C]
            chain: 'base',
            factoryAddress: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
            routerAddress: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
            fee: 30
        },
        {
            name: 'baseswap', // [C]
            chain: 'base',
            factoryAddress: '0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB',
            routerAddress: '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86',
            fee: 30
        },
        {
            name: 'sushiswap', // [H]
            chain: 'base',
            factoryAddress: '0x71524B4f93c58fcbF659783284E38825f0622859',
            routerAddress: '0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891',
            fee: 30
        },
        {
            name: 'swapbased', // [M]
            chain: 'base',
            factoryAddress: '0x04C9f118d21e8B767D2e50C946f0cC9F6C367300',
            routerAddress: '0xaaa3b1F1bd7BCc97fD1917c18ADE665C5D31F066',
            fee: 30
        },
        // S2.2.2: New DEXs added (5 → 7)
        {
            name: 'maverick', // [H] - Dynamic fee AMM
            chain: 'base',
            factoryAddress: '0x0A7e848Aca42d879EF06507Fca0E7b33A0a63c1e',
            routerAddress: '0x32aed3Bce901Da12ca8F29D3e95fC3cc54a85Fd9',
            fee: 1 // 1 bp base fee (dynamic)
        },
        {
            name: 'alienbase', // [M] - Native Base DEX
            chain: 'base',
            factoryAddress: '0x3E84D913803b02A4a7f027165E8cA42C14C0FdE7',
            routerAddress: '0x8c1A3cF8f83074169FE5D7aD50B978e1cD6b37c7',
            fee: 30
        }
    ],
    // Polygon: 4 DEXs (low gas)
    polygon: [
        {
            name: 'uniswap_v3', // [C]
            chain: 'polygon',
            factoryAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
            routerAddress: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
            fee: 30
        },
        {
            name: 'quickswap_v3', // [C]
            chain: 'polygon',
            factoryAddress: '0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28',
            routerAddress: '0xf5b509bB0909a69B1c207E495f687a596C168E12',
            fee: 30
        },
        {
            name: 'sushiswap', // [H]
            chain: 'polygon',
            factoryAddress: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
            routerAddress: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
            fee: 30
        },
        {
            name: 'apeswap', // [M]
            chain: 'polygon',
            factoryAddress: '0xCf083Be4164828f00cAE704EC15a36D711491284',
            routerAddress: '0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607',
            fee: 20
        }
    ],
    // Optimism: 3 DEXs (NEW - Phase 1)
    optimism: [
        {
            name: 'uniswap_v3', // [C]
            chain: 'optimism',
            factoryAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
            routerAddress: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
            fee: 30
        },
        {
            name: 'velodrome', // [C]
            chain: 'optimism',
            factoryAddress: '0x25CbdDb98b35ab1FF77413456B31EC81A6B6B746',
            routerAddress: '0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858',
            fee: 30
        },
        {
            name: 'sushiswap', // [H]
            chain: 'optimism',
            factoryAddress: '0xFbc12984689e5f15626Bad03Ad60160Fe98B303C',
            routerAddress: '0x4C5D5234f232BD2D76B96aA33F5AE4FCF0E4BFAb',
            fee: 30
        }
    ],
    // Ethereum: 2 DEXs (selective - large arbs only)
    ethereum: [
        {
            name: 'uniswap_v3', // [C]
            chain: 'ethereum',
            factoryAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
            routerAddress: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
            fee: 30
        },
        {
            name: 'sushiswap', // [C]
            chain: 'ethereum',
            factoryAddress: '0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac',
            routerAddress: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',
            fee: 30
        }
    ],
    // =============================================================================
    // S3.1.2: New Chain DEXs for 4-Partition Architecture
    // S3.2.1: Expanded Avalanche DEXs (6 total)
    // =============================================================================
    // Avalanche: 6 DEXs
    avalanche: [
        {
            name: 'trader_joe_v2', // [C] - Dominant on Avalanche
            chain: 'avalanche',
            factoryAddress: '0x8e42f2F4101563bF679975178e880FD87d3eFd4e',
            routerAddress: '0x60aE616a2155Ee3d9A68541Ba4544862310933d4',
            fee: 30
        },
        {
            name: 'pangolin', // [H] - Native Avalanche DEX
            chain: 'avalanche',
            factoryAddress: '0xefa94DE7a4656D787667C749f7E1223D71E9FD88',
            routerAddress: '0xE54Ca86531e17Ef3616d22Ca28b0D458b6C89106',
            fee: 30
        },
        {
            name: 'sushiswap', // [H] - Multi-chain presence
            chain: 'avalanche',
            factoryAddress: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
            routerAddress: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
            fee: 30
        },
        // S3.2.1: New DEXs added
        // GMX uses Vault model - uses GmxAdapter for pool discovery
        {
            name: 'gmx', // [C] - Perpetuals/Spot, uses vault model
            chain: 'avalanche',
            factoryAddress: '0x9ab2De34A33fB459b538c43f251eB825645e8595', // GMX Vault (uses adapter)
            routerAddress: '0x5F719c2F1095F7B9fc68a68e35B51194f4b6abe8', // GMX Router
            fee: 30, // GMX uses dynamic fees 10-80bp, using 30bp average
            enabled: true // ENABLED: Uses GmxAdapter from dex-adapters
        },
        // Platypus uses Pool model - uses PlatypusAdapter for pool discovery
        {
            name: 'platypus', // [H] - Stablecoin-optimized AMM
            chain: 'avalanche',
            factoryAddress: '0x66357dCaCe80431aee0A7507e2E361B7e2402370', // Main Pool (uses adapter)
            routerAddress: '0x73256EC7575D999C360c1EeC118ECbEFd8DA7D12', // Platypus Router
            fee: 4, // Platypus: ~1-4bp for stablecoins
            enabled: true // ENABLED: Uses PlatypusAdapter from dex-adapters
        },
        {
            name: 'kyberswap', // [H] - KyberSwap Elastic (concentrated liquidity)
            chain: 'avalanche',
            factoryAddress: '0x5F1dddbf348aC2fbe22a163e30F99F9ECE3DD50a', // KyberSwap Elastic Factory
            routerAddress: '0xC1e7dFE73E1598E3910EF4C7845B68A9Ab6F4c83', // KyberSwap Router
            fee: 10 // KyberSwap: dynamic fees, typically 8-100bp (V3-style getPool)
        }
    ],
    // Fantom: 4 DEXs (S3.2.2)
    fantom: [
        {
            name: 'spookyswap', // [C] - Dominant on Fantom
            chain: 'fantom',
            factoryAddress: '0x152eE697f2E276fA89E96742e9bB9aB1F2E61bE3',
            routerAddress: '0xF491e7B69E4244ad4002BC14e878a34207E38c29',
            fee: 30
        },
        {
            name: 'spiritswap', // [H] - Second largest
            chain: 'fantom',
            factoryAddress: '0xEF45d134b73241eDa7703fa787148D9C9F4950b0',
            routerAddress: '0x16327E3FbDaCA3bcF7E38F5Af2599D2DDc33aE52',
            fee: 30
        },
        {
            name: 'equalizer', // [H] - Solidly fork with ve(3,3) model
            chain: 'fantom',
            factoryAddress: '0xc6366EFD0AF1d09171fe0EBF32c7943BB310832a', // Equalizer V2 Factory
            routerAddress: '0x1A05EB736873485655F29a37DEf8a0AA87F5a447', // Equalizer Router
            fee: 30 // Default volatile fee (stable pools use 1bp)
        },
        // Beethoven X uses Balancer V2 Vault model - uses BalancerV2Adapter for pool discovery
        {
            name: 'beethoven_x', // [H] - Balancer V2 fork, weighted pools
            chain: 'fantom',
            factoryAddress: '0x20dd72Ed959b6147912C2e529F0a0C651c33c9ce', // Beethoven X Vault (uses adapter)
            routerAddress: '0x20dd72Ed959b6147912C2e529F0a0C651c33c9ce', // Vault is also router for swaps
            fee: 30, // Variable per pool, 10-200bp typical
            enabled: true // ENABLED: Uses BalancerV2Adapter from dex-adapters
        }
    ],
    // zkSync Era: 2 DEXs
    zksync: [
        {
            name: 'syncswap', // [C] - Largest on zkSync
            chain: 'zksync',
            factoryAddress: '0xf2DAd89f2788a8CD54625C60b55cD3d2D0ACa7Cb',
            routerAddress: '0x2da10A1e27bF85cEdD8FFb1AbBe97e53391C0295',
            fee: 30
        },
        {
            name: 'mute', // [H] - Native zkSync DEX
            chain: 'zksync',
            factoryAddress: '0x40be1cBa6C5B47cDF9da7f963B6F761F4C60627D',
            routerAddress: '0x8B791913eB07C32779a16750e3868aA8495F5964',
            fee: 30
        }
    ],
    // Linea: 2 DEXs
    linea: [
        {
            name: 'syncswap', // [C] - Multi-chain presence
            chain: 'linea',
            factoryAddress: '0x37BAc764494c8db4e54BDE72f6965beA9fa0AC2d',
            routerAddress: '0x80e38291e06339d10AAB483C65695D004dBD5C69',
            fee: 30
        },
        {
            name: 'velocore', // [H] - Native Linea DEX
            chain: 'linea',
            factoryAddress: '0x7160570BB153Edd0Ea1775EC2b2Ac9b65F1aB61B',
            routerAddress: '0x1d0188c4B276A09366D05d6Be06aF61a73bC7535', // Velocore Vault on Linea
            fee: 30
        }
    ],
    // S3.3.2: Solana DEXs (Non-EVM, uses Solana program IDs)
    // 7 DEXs: Jupiter, Raydium AMM, Raydium CLMM, Orca, Meteora, Phoenix, Lifinity
    solana: [
        {
            name: 'jupiter', // [C] - Largest aggregator on Solana
            chain: 'solana',
            factoryAddress: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
            routerAddress: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
            fee: 0, // Aggregator - fee comes from underlying DEX
            type: 'aggregator',
            enabled: false // Disabled for direct pool detection (routes through other DEXs)
        },
        {
            name: 'raydium', // [C] - Largest AMM on Solana
            chain: 'solana',
            factoryAddress: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // AMM Program
            routerAddress: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
            fee: 25, // 0.25%
            type: 'amm',
            enabled: true
        },
        {
            name: 'raydium-clmm', // [C] - Raydium Concentrated Liquidity
            chain: 'solana',
            factoryAddress: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // CLMM Program
            routerAddress: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
            fee: 25, // Dynamic based on pool
            type: 'clmm',
            enabled: true
        },
        {
            name: 'orca', // [H] - Second largest, Whirlpools
            chain: 'solana',
            // FIX S3.3.2: Corrected Orca Whirlpool program ID (was 9W959... legacy token swap)
            factoryAddress: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Whirlpool Program
            routerAddress: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
            fee: 30, // Dynamic based on pool
            type: 'clmm',
            enabled: true
        },
        {
            name: 'meteora', // [H] - Dynamic Liquidity Market Maker
            chain: 'solana',
            factoryAddress: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // DLMM Program
            routerAddress: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
            fee: 20, // Dynamic based on bin step
            type: 'dlmm',
            enabled: true
        },
        {
            name: 'phoenix', // [H] - On-chain order book
            chain: 'solana',
            factoryAddress: 'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY',
            routerAddress: 'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY',
            fee: 10, // 0.1% taker fee
            type: 'orderbook',
            enabled: true
        },
        {
            name: 'lifinity', // [H] - Proactive market maker with oracle pricing
            chain: 'solana',
            factoryAddress: '2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c',
            routerAddress: '2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c',
            fee: 20, // 0.2%
            type: 'pmm',
            enabled: true
        }
    ]
};
// =============================================================================
// TOKEN CONFIGURATIONS - Phase 1: 60 Tokens
// Categories: Anchor (native, stables), Core DeFi, Chain Governance, High-Volume
// =============================================================================
exports.CORE_TOKENS = {
    // Arbitrum: 12 tokens
    arbitrum: [
        // Anchor tokens
        { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', symbol: 'WETH', decimals: 18, chainId: 42161 },
        { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', symbol: 'USDT', decimals: 6, chainId: 42161 },
        { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6, chainId: 42161 },
        { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', symbol: 'DAI', decimals: 18, chainId: 42161 },
        { address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', symbol: 'WBTC', decimals: 8, chainId: 42161 },
        // Chain governance
        { address: '0x912CE59144191C1204E64559FE8253a0e49E6548', symbol: 'ARB', decimals: 18, chainId: 42161 },
        // Core DeFi
        { address: '0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0', symbol: 'UNI', decimals: 18, chainId: 42161 },
        { address: '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4', symbol: 'LINK', decimals: 18, chainId: 42161 },
        { address: '0x6C2C06790b3E3E3c38e12Ee22F8183b37a13EE55', symbol: 'DPX', decimals: 18, chainId: 42161 },
        { address: '0x539bdE0d7Dbd336b79148AA742883198BBF60342', symbol: 'MAGIC', decimals: 18, chainId: 42161 },
        // High-volume
        { address: '0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a', symbol: 'GMX', decimals: 18, chainId: 42161 },
        { address: '0x5979D7b546E38E414F7E9822514be443A4800529', symbol: 'wstETH', decimals: 18, chainId: 42161 }
    ],
    // BSC: 10 tokens
    bsc: [
        // Anchor tokens
        { address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', symbol: 'WBNB', decimals: 18, chainId: 56 },
        { address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', decimals: 18, chainId: 56 },
        { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', symbol: 'USDC', decimals: 18, chainId: 56 },
        { address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', symbol: 'BUSD', decimals: 18, chainId: 56 },
        { address: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', symbol: 'BTCB', decimals: 18, chainId: 56 },
        // Bridged ETH
        { address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', symbol: 'ETH', decimals: 18, chainId: 56 },
        // Core DeFi
        { address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', symbol: 'CAKE', decimals: 18, chainId: 56 },
        { address: '0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD', symbol: 'LINK', decimals: 18, chainId: 56 },
        // High-volume
        { address: '0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE', symbol: 'XRP', decimals: 18, chainId: 56 },
        { address: '0x3EE2200Efb3400fAbB9AacF31297cBdD1d435D47', symbol: 'ADA', decimals: 18, chainId: 56 }
    ],
    // Base: 10 tokens
    base: [
        // Anchor tokens
        { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18, chainId: 8453 },
        { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6, chainId: 8453 },
        { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', symbol: 'DAI', decimals: 18, chainId: 8453 },
        // Bridged BTC
        { address: '0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b', symbol: 'tBTC', decimals: 18, chainId: 8453 },
        // LST tokens
        { address: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452', symbol: 'wstETH', decimals: 18, chainId: 8453 },
        { address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', symbol: 'cbETH', decimals: 18, chainId: 8453 },
        // Core DeFi
        { address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', symbol: 'AERO', decimals: 18, chainId: 8453 },
        // High-volume meme
        { address: '0x532f27101965dd16442E59d40670FaF5eBB142E4', symbol: 'BRETT', decimals: 18, chainId: 8453 },
        { address: '0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4', symbol: 'TOSHI', decimals: 18, chainId: 8453 },
        { address: '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b', symbol: 'VIRTUAL', decimals: 18, chainId: 8453 }
    ],
    // Polygon: 10 tokens
    polygon: [
        // Anchor tokens
        { address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', symbol: 'WMATIC', decimals: 18, chainId: 137 },
        { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', symbol: 'USDT', decimals: 6, chainId: 137 },
        { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', symbol: 'USDC', decimals: 6, chainId: 137 },
        { address: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', symbol: 'DAI', decimals: 18, chainId: 137 },
        { address: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', symbol: 'WBTC', decimals: 8, chainId: 137 },
        // Bridged ETH
        { address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', symbol: 'WETH', decimals: 18, chainId: 137 },
        // Core DeFi
        { address: '0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39', symbol: 'LINK', decimals: 18, chainId: 137 },
        { address: '0xD6DF932A45C0f255f85145f286eA0b292B21C90B', symbol: 'AAVE', decimals: 18, chainId: 137 },
        // High-volume
        { address: '0x2C89bbc92BD86F8075d1DEcc58C7F4E0107f286b', symbol: 'AVAX', decimals: 18, chainId: 137 },
        { address: '0xB0B195aEFA3650A6908f15CdaC7D92F8a5791B0B', symbol: 'BOB', decimals: 18, chainId: 137 }
    ],
    // Optimism: 10 tokens (NEW - Phase 1)
    optimism: [
        // Anchor tokens
        { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18, chainId: 10 },
        { address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', symbol: 'USDT', decimals: 6, chainId: 10 },
        { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', symbol: 'USDC', decimals: 6, chainId: 10 },
        { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', symbol: 'DAI', decimals: 18, chainId: 10 },
        { address: '0x68f180fcCe6836688e9084f035309E29Bf0A2095', symbol: 'WBTC', decimals: 8, chainId: 10 },
        // Chain governance
        { address: '0x4200000000000000000000000000000000000042', symbol: 'OP', decimals: 18, chainId: 10 },
        // LST tokens
        { address: '0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb', symbol: 'wstETH', decimals: 18, chainId: 10 },
        // Core DeFi
        { address: '0x350a791Bfc2C21F9Ed5d10980Dad2e2638ffa7f6', symbol: 'LINK', decimals: 18, chainId: 10 },
        { address: '0x9e1028F5F1D5eDE59748FFceE5532509976840E0', symbol: 'PERP', decimals: 18, chainId: 10 },
        { address: '0x3c8B650257cFb5f272f799F5e2b4e65093a11a05', symbol: 'VELO', decimals: 18, chainId: 10 }
    ],
    // Ethereum: 8 tokens (selective - large arbs only)
    ethereum: [
        // Anchor tokens
        { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', decimals: 18, chainId: 1 },
        { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', decimals: 6, chainId: 1 },
        { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6, chainId: 1 },
        { address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', symbol: 'WBTC', decimals: 8, chainId: 1 },
        // LST tokens (high volume)
        { address: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', symbol: 'wstETH', decimals: 18, chainId: 1 },
        { address: '0xae78736Cd615f374D3085123A210448E74Fc6393', symbol: 'rETH', decimals: 18, chainId: 1 },
        // Core DeFi
        { address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', symbol: 'UNI', decimals: 18, chainId: 1 },
        { address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', symbol: 'LINK', decimals: 18, chainId: 1 }
    ],
    // =============================================================================
    // S3.1.2: New Chain Tokens for 4-Partition Architecture
    // S3.2.1: Expanded Avalanche Tokens (15 total)
    // =============================================================================
    // Avalanche: 15 tokens
    avalanche: [
        // Anchor tokens
        { address: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', symbol: 'WAVAX', decimals: 18, chainId: 43114 },
        { address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', symbol: 'USDT', decimals: 6, chainId: 43114 },
        { address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', symbol: 'USDC', decimals: 6, chainId: 43114 },
        { address: '0xd586E7F844cEa2F87f50152665BCbc2C279D8d70', symbol: 'DAI', decimals: 18, chainId: 43114 },
        // Bridged BTC
        { address: '0x50b7545627a5162F82A992c33b87aDc75187B218', symbol: 'WBTC.e', decimals: 8, chainId: 43114 },
        // Bridged ETH
        { address: '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB', symbol: 'WETH.e', decimals: 18, chainId: 43114 },
        // Core DeFi
        { address: '0x6e84a6216eA6dACC71eE8E6b0a5B7322EEbC0fDd', symbol: 'JOE', decimals: 18, chainId: 43114 },
        { address: '0x5947BB275c521040051D82396192181b413227A3', symbol: 'LINK', decimals: 18, chainId: 43114 },
        // S3.2.1: New tokens added
        { address: '0x63a72806098Bd3D9520cC43356dD78afe5D386D9', symbol: 'AAVE', decimals: 18, chainId: 43114 },
        { address: '0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE', symbol: 'sAVAX', decimals: 18, chainId: 43114 }, // Staked AVAX (Benqi)
        { address: '0x8729438EB15e2C8B576fCc6AeCdA6A148776C0F5', symbol: 'QI', decimals: 18, chainId: 43114 }, // BENQI token
        { address: '0x60781C2586D68229fde47564546784ab3fACA982', symbol: 'PNG', decimals: 18, chainId: 43114 }, // Pangolin token
        { address: '0x22d4002028f537599bE9f666d1c4Fa138522f9c8', symbol: 'PTP', decimals: 18, chainId: 43114 }, // Platypus token
        { address: '0x62edc0692BD897D2295872a9FFCac5425011c661', symbol: 'GMX', decimals: 18, chainId: 43114 }, // GMX token
        { address: '0xD24C2Ad096400B6FBcd2ad8B24E7acBc21A1da64', symbol: 'FRAX', decimals: 18, chainId: 43114 } // Frax stablecoin
    ],
    // Fantom: 10 tokens (S3.2.2)
    fantom: [
        // Anchor tokens
        { address: '0x21be370D5312f44cB42ce377BC9b8a0cEF1A4C83', symbol: 'WFTM', decimals: 18, chainId: 250 },
        { address: '0x049d68029688eAbF473097a2fC38ef61633A3C7A', symbol: 'fUSDT', decimals: 6, chainId: 250 },
        { address: '0x04068DA6C83AFCFA0e13ba15A6696662335D5B75', symbol: 'USDC', decimals: 6, chainId: 250 },
        { address: '0x8D11eC38a3EB5E956B052f67Da8Bdc9bef8Abf3E', symbol: 'DAI', decimals: 18, chainId: 250 },
        // Bridged tokens
        { address: '0x74b23882a30290451A17c44f4F05243b6b58C76d', symbol: 'WETH', decimals: 18, chainId: 250 },
        { address: '0x321162Cd933E2Be498Cd2267a90534A804051b11', symbol: 'WBTC', decimals: 8, chainId: 250 },
        // DEX governance tokens (S3.2.2)
        { address: '0x841FAD6EAe12c286d1Fd18d1d525DFfA75C7EFFE', symbol: 'BOO', decimals: 18, chainId: 250 }, // SpookySwap
        { address: '0x5Cc61A78F164885776AA610fb0FE1257df78E59B', symbol: 'SPIRIT', decimals: 18, chainId: 250 }, // SpiritSwap
        { address: '0x3Fd3A0c85B70754eFc07aC9Ac0cbBDCe664865A6', symbol: 'EQUAL', decimals: 18, chainId: 250 }, // Equalizer
        { address: '0xF24Bcf4d1e507740041C9cFd2DddB29585aDCe1e', symbol: 'BEETS', decimals: 18, chainId: 250 } // Beethoven X
    ],
    // zkSync Era: 6 tokens
    zksync: [
        // Anchor tokens
        { address: '0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91', symbol: 'WETH', decimals: 18, chainId: 324 },
        { address: '0x493257fD37EDB34451f62EDf8D2a0C418852bA4C', symbol: 'USDT', decimals: 6, chainId: 324 },
        { address: '0x3355df6D4c9C3035724Fd0e3914dE96A5a83aaf4', symbol: 'USDC', decimals: 6, chainId: 324 },
        // Core DeFi
        { address: '0xBBeB516fb02a01611cBBE0453Fe3c580D7281011', symbol: 'WBTC', decimals: 8, chainId: 324 },
        { address: '0x5A7d6b2F92C77FAD6CCaBd7EE0624E64907Eaf3E', symbol: 'ZK', decimals: 18, chainId: 324 },
        { address: '0x32fD44Bb4895705dca62f5E22ba9e3A6cd3C8B13', symbol: 'MUTE', decimals: 18, chainId: 324 }
    ],
    // Linea: 6 tokens
    linea: [
        // Anchor tokens
        { address: '0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f', symbol: 'WETH', decimals: 18, chainId: 59144 },
        { address: '0xA219439258ca9da29E9Cc4cE5596924745e12B93', symbol: 'USDT', decimals: 6, chainId: 59144 },
        { address: '0x176211869cA2b568f2A7D4EE941E073a821EE1ff', symbol: 'USDC', decimals: 6, chainId: 59144 },
        { address: '0x4AF15ec2A0BD43Db75dd04E62FAA3B8EF36b00d5', symbol: 'DAI', decimals: 18, chainId: 59144 },
        // Core DeFi
        { address: '0x3aAB2285ddcDdaD8edf438C1bAB47e1a9D05a9b4', symbol: 'WBTC', decimals: 8, chainId: 59144 },
        { address: '0x7d43AABC515C356145049227CeE54B608342c0ad', symbol: 'BUSD', decimals: 18, chainId: 59144 }
    ],
    // S3.3.3: Solana - 15 tokens (non-EVM - uses different address format)
    // Categories: anchor (1), stablecoin (2), defi (3), meme (2), governance (4), LST (3)
    solana: [
        // Anchor tokens - Solana uses base58 addresses
        { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL', decimals: 9, chainId: 101 },
        // Stablecoins
        { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6, chainId: 101 },
        { address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT', decimals: 6, chainId: 101 },
        // Core DeFi (DEX governance tokens)
        { address: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', symbol: 'JUP', decimals: 6, chainId: 101 },
        { address: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', symbol: 'RAY', decimals: 6, chainId: 101 },
        { address: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE', symbol: 'ORCA', decimals: 6, chainId: 101 },
        // High-volume meme tokens
        { address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK', decimals: 5, chainId: 101 },
        { address: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', symbol: 'WIF', decimals: 6, chainId: 101 },
        // S3.3.3: Governance tokens (ecosystem protocols)
        { address: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', symbol: 'JTO', decimals: 9, chainId: 101 }, // Jito governance
        { address: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', symbol: 'PYTH', decimals: 6, chainId: 101 }, // Pyth Network oracle
        { address: '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ', symbol: 'W', decimals: 6, chainId: 101 }, // Wormhole governance
        { address: 'MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey', symbol: 'MNDE', decimals: 9, chainId: 101 }, // Marinade governance
        // S3.3.3: Liquid Staking Tokens (LST) - High volume for arbitrage
        { address: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', symbol: 'mSOL', decimals: 9, chainId: 101 }, // Marinade staked SOL
        { address: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', symbol: 'jitoSOL', decimals: 9, chainId: 101 }, // Jito staked SOL
        { address: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', symbol: 'BSOL', decimals: 9, chainId: 101 } // BlazeStake staked SOL
    ]
};
// =============================================================================
// SERVICE CONFIGURATIONS
// =============================================================================
exports.SERVICE_CONFIGS = {
    redis: {
        url: process.env.REDIS_URL || 'redis://localhost:6379',
        password: process.env.REDIS_PASSWORD
    },
    monitoring: {
        enabled: process.env.MONITORING_ENABLED === 'true',
        interval: parseInt(process.env.MONITORING_INTERVAL || '30000'),
        endpoints: (process.env.MONITORING_ENDPOINTS || '').split(',')
    }
};
// =============================================================================
// PERFORMANCE THRESHOLDS
// =============================================================================
exports.PERFORMANCE_THRESHOLDS = {
    maxEventLatency: 50, // ms - target for Phase 3
    minCacheHitRate: 0.9, // 90%
    maxMemoryUsage: 400 * 1024 * 1024, // 400MB
    maxCpuUsage: 80, // %
    maxFalsePositiveRate: 0.05 // 5%
};
// =============================================================================
// ARBITRAGE DETECTION PARAMETERS
// =============================================================================
exports.ARBITRAGE_CONFIG = {
    minProfitPercentage: 0.003, // 0.3%
    maxGasPrice: 50000000000, // 50 gwei
    confidenceThreshold: 0.75,
    maxTradeSize: '1000000000000000000', // 1 ETH equivalent
    triangularEnabled: true,
    crossChainEnabled: false, // Enable in Phase 2
    predictiveEnabled: false, // Enable in Phase 3
    // Additional config properties for opportunity calculation
    defaultAmount: 1000, // Default trade amount in USD
    estimatedGasCost: 5, // Estimated gas cost in USD
    opportunityTimeoutMs: 30000, // 30 seconds
    minProfitThreshold: 10, // Minimum $10 net profit
    minConfidenceThreshold: 0.7, // Minimum 70% confidence
    feePercentage: 0.003, // 0.3% DEX trading fee
    // P1-4 FIX: Configurable slippage tolerance (was hardcoded 0.9 = 10%)
    slippageTolerance: 0.10, // 10% slippage tolerance (minProfit = expectedProfit * (1 - slippageTolerance))
    // P1-5 FIX: Gas price spike protection - reject transactions if gas exceeds threshold
    gasPriceSpikeMultiplier: 2.0, // Max 2x above baseline gas price
    gasPriceBaselineWindowMs: 300000, // 5 minute window for baseline calculation
    gasPriceSpikeEnabled: true, // Enable/disable gas spike protection
    // Chain-specific minimum profits (due to gas costs)
    // S3.1.2: Added all 11 chains
    chainMinProfits: {
        // Original 6 chains
        ethereum: 0.005, // 0.5% - higher due to gas
        arbitrum: 0.002, // 0.2% - low gas
        optimism: 0.002, // 0.2% - low gas
        base: 0.002, // 0.2% - low gas
        polygon: 0.002, // 0.2% - low gas
        bsc: 0.003, // 0.3% - moderate gas
        // S3.1.2: New chains
        avalanche: 0.002, // 0.2% - low gas (C-Chain)
        fantom: 0.002, // 0.2% - very low gas
        zksync: 0.002, // 0.2% - L2 gas pricing
        linea: 0.002, // 0.2% - L2 gas pricing
        solana: 0.001 // 0.1% - minimal transaction fees
    }
};
// =============================================================================
// EVENT MONITORING CONFIGURATION
// =============================================================================
exports.EVENT_CONFIG = {
    syncEvents: {
        enabled: true,
        priority: 'high'
    },
    swapEvents: {
        enabled: true,
        priority: 'medium',
        minAmountUSD: 10000, // $10K minimum for processing
        whaleThreshold: 50000, // $50K for whale alerts
        samplingRate: 0.01 // 1% sampling for <$10K swaps
    }
};
// =============================================================================
// PARTITION CONFIGURATION
// S3.1.2: 4-Partition Architecture - Aligns with ADR-003 and ADR-008
// =============================================================================
/**
 * Partition IDs - Use these constants instead of magic strings
 * to prevent typos and enable IDE autocomplete.
 */
// PARTITION_IDS is now exported from partitions.ts to avoid circular dependency
// Re-exported below via named re-exports
/**
 * Partition chain assignments - S3.1.2 configuration
 * Use getChainsForPartition() from partitions.ts for runtime access.
 */
exports.PARTITION_CONFIG = {
    // P1: Asia-Fast - EVM high-throughput chains
    P1_ASIA_FAST: ['bsc', 'polygon', 'avalanche', 'fantom'],
    // P2: L2-Turbo - Ethereum L2 rollups
    P2_L2_TURBO: ['arbitrum', 'optimism', 'base'],
    // P3: High-Value - Ethereum mainnet + ZK rollups
    P3_HIGH_VALUE: ['ethereum', 'zksync', 'linea'],
    // P4: Solana-Native - Non-EVM chains
    P4_SOLANA_NATIVE: ['solana']
};
// =============================================================================
// PHASE METRICS
// Track progress against targets from ADR-008
// S3.1.2: Updated for 4-partition architecture (11 chains, 44 DEXes, 94 tokens)
// S3.2.2: Updated for Fantom expansion (11 chains, 46 DEXes, 98 tokens)
// S3.3.3: Updated for Solana token expansion (11 chains, 49 DEXes, 112 tokens)
// Phase 1 Adapters: Added vault-model DEX adapters (GMX, Platypus, Beethoven X)
// =============================================================================
exports.PHASE_METRICS = {
    current: {
        phase: 1,
        chains: Object.keys(exports.CHAINS).length,
        dexes: Object.values(exports.DEXES).flat().length,
        tokens: Object.values(exports.CORE_TOKENS).flat().length,
        targetOpportunities: 500 // Increased with more chains/DEXes
    },
    targets: {
        // Phase 1 with vault-model adapters:
        // - 11 chains (original 6 + avalanche, fantom, zksync, linea, solana)
        // - 49 DEXes (46 + 3 newly enabled: GMX, Platypus, Beethoven X with adapters)
        // - 112 tokens breakdown:
        //   Original 6 chains: 60 (arb:12 + bsc:10 + base:10 + poly:10 + opt:10 + eth:8)
        //   S3.1.2 new chains: 12 (zksync:6 + linea:6)
        //   S3.2.1 Avalanche: 15, S3.2.2 Fantom: 10, S3.3.3 Solana: 15
        phase1: { chains: 11, dexes: 49, tokens: 112, opportunities: 500 },
        phase2: { chains: 15, dexes: 60, tokens: 145, opportunities: 750 },
        phase3: { chains: 20, dexes: 80, tokens: 200, opportunities: 1000 }
    }
};
// =============================================================================
// TOKEN METADATA - Chain-specific token addresses and categories
// Used for USD value estimation and price calculations
// =============================================================================
exports.TOKEN_METADATA = {
    optimism: {
        weth: '0x4200000000000000000000000000000000000006',
        nativeWrapper: '0x4200000000000000000000000000000000000006',
        stablecoins: [
            { address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', symbol: 'USDT', decimals: 6 },
            { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', symbol: 'USDC', decimals: 6 },
            { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', symbol: 'DAI', decimals: 18 }
        ]
    },
    arbitrum: {
        weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
        nativeWrapper: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
        stablecoins: [
            { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', symbol: 'USDT', decimals: 6 },
            { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6 },
            { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', symbol: 'DAI', decimals: 18 }
        ]
    },
    bsc: {
        weth: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', // ETH on BSC
        nativeWrapper: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB
        stablecoins: [
            { address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', decimals: 18 },
            { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', symbol: 'USDC', decimals: 18 },
            { address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', symbol: 'BUSD', decimals: 18 }
        ]
    },
    base: {
        weth: '0x4200000000000000000000000000000000000006',
        nativeWrapper: '0x4200000000000000000000000000000000000006',
        stablecoins: [
            { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 },
            { address: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', symbol: 'USDbC', decimals: 6 }, // Bridged USDC
            { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', symbol: 'DAI', decimals: 18 }
        ]
    },
    polygon: {
        weth: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
        nativeWrapper: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', // WMATIC
        stablecoins: [
            { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', symbol: 'USDT', decimals: 6 },
            { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', symbol: 'USDC', decimals: 6 },
            { address: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', symbol: 'DAI', decimals: 18 }
        ]
    },
    ethereum: {
        weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        nativeWrapper: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        stablecoins: [
            { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', decimals: 6 },
            { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 }
        ]
    },
    // =============================================================================
    // S3.1.2: New Chain Token Metadata
    // S3.2.1: Updated Avalanche stablecoins (added FRAX)
    // =============================================================================
    avalanche: {
        weth: '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB', // WETH.e on Avalanche
        nativeWrapper: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', // WAVAX
        stablecoins: [
            { address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', symbol: 'USDT', decimals: 6 },
            { address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', symbol: 'USDC', decimals: 6 },
            { address: '0xd586E7F844cEa2F87f50152665BCbc2C279D8d70', symbol: 'DAI', decimals: 18 },
            { address: '0xD24C2Ad096400B6FBcd2ad8B24E7acBc21A1da64', symbol: 'FRAX', decimals: 18 } // S3.2.1: Added FRAX
        ]
    },
    fantom: {
        weth: '0x74b23882a30290451A17c44f4F05243b6b58C76d', // WETH on Fantom
        nativeWrapper: '0x21be370D5312f44cB42ce377BC9b8a0cEF1A4C83', // WFTM
        stablecoins: [
            { address: '0x049d68029688eAbF473097a2fC38ef61633A3C7A', symbol: 'fUSDT', decimals: 6 },
            { address: '0x04068DA6C83AFCFA0e13ba15A6696662335D5B75', symbol: 'USDC', decimals: 6 },
            { address: '0x8D11eC38a3EB5E956B052f67Da8Bdc9bef8Abf3E', symbol: 'DAI', decimals: 18 }
        ]
    },
    zksync: {
        weth: '0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91', // WETH on zkSync
        nativeWrapper: '0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91', // WETH (native is ETH)
        stablecoins: [
            { address: '0x493257fD37EDB34451f62EDf8D2a0C418852bA4C', symbol: 'USDT', decimals: 6 },
            { address: '0x3355df6D4c9C3035724Fd0e3914dE96A5a83aaf4', symbol: 'USDC', decimals: 6 }
        ]
    },
    linea: {
        weth: '0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f', // WETH on Linea
        nativeWrapper: '0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f', // WETH (native is ETH)
        stablecoins: [
            { address: '0xA219439258ca9da29E9Cc4cE5596924745e12B93', symbol: 'USDT', decimals: 6 },
            { address: '0x176211869cA2b568f2A7D4EE941E073a821EE1ff', symbol: 'USDC', decimals: 6 },
            { address: '0x4AF15ec2A0BD43Db75dd04E62FAA3B8EF36b00d5', symbol: 'DAI', decimals: 18 }
        ]
    },
    solana: {
        weth: 'So11111111111111111111111111111111111111112', // Wrapped SOL (native equivalent)
        nativeWrapper: 'So11111111111111111111111111111111111111112', // Wrapped SOL
        stablecoins: [
            { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6 },
            { address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT', decimals: 6 }
        ]
    }
};
// =============================================================================
// EVENT SIGNATURES - Pre-computed for performance
// =============================================================================
exports.EVENT_SIGNATURES = {
    // Uniswap V2 / SushiSwap style
    SYNC: '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1',
    SWAP_V2: '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
    // Alternative signatures for different DEX implementations
    SWAP_V3: '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'
};
// =============================================================================
// DEX HELPER FUNCTIONS
// Standardize DEX access patterns across the codebase
// =============================================================================
/**
 * Get enabled DEXs for a chain.
 * Filters out DEXs with enabled === false (enabled defaults to true if not specified).
 *
 * @param chainId - The chain identifier (e.g., 'arbitrum', 'bsc')
 * @returns Array of enabled Dex objects for the chain
 */
function getEnabledDexes(chainId) {
    const chainDexes = exports.DEXES[chainId];
    if (!chainDexes)
        return [];
    return chainDexes.filter(dex => dex.enabled !== false);
}
/**
 * Convert DEX fee from basis points to percentage.
 * Config stores fees in basis points (e.g., 30 = 0.30%), calculations use percentage.
 *
 * @param feeBasisPoints - Fee in basis points (e.g., 30 for 0.30%)
 * @returns Fee as a decimal percentage (e.g., 0.003 for 0.30%)
 */
function dexFeeToPercentage(feeBasisPoints) {
    return feeBasisPoints / 10000;
}
/**
 * Convert percentage to basis points.
 * Inverse of dexFeeToPercentage.
 *
 * @param percentage - Fee as decimal (e.g., 0.003 for 0.30%)
 * @returns Fee in basis points (e.g., 30 for 0.30%)
 */
function percentageToBasisPoints(percentage) {
    return Math.round(percentage * 10000);
}
exports.DETECTOR_CONFIG = {
    ethereum: {
        batchSize: 15, // Lower batch size for 12s blocks
        batchTimeout: 50,
        healthCheckInterval: 30000,
        confidence: 0.75, // Lower due to higher gas variability
        expiryMs: 15000, // 15s (longer for slow blocks)
        gasEstimate: 250000, // Higher gas on mainnet
        whaleThreshold: 100000, // $100K (higher due to gas costs)
        nativeTokenKey: 'weth'
    },
    arbitrum: {
        batchSize: 30, // Higher batch size for ultra-fast 250ms blocks
        batchTimeout: 20, // Lower timeout for faster processing
        healthCheckInterval: 15000, // More frequent health checks
        confidence: 0.85, // Higher due to ultra-fast processing
        expiryMs: 5000, // 5s (faster for quick blocks)
        gasEstimate: 50000, // Very low gas on Arbitrum
        whaleThreshold: 25000, // $25K (lower threshold for L2)
        nativeTokenKey: 'weth'
    },
    optimism: {
        batchSize: 20,
        batchTimeout: 30,
        healthCheckInterval: 30000,
        confidence: 0.80,
        expiryMs: 10000, // 10s
        gasEstimate: 100000,
        whaleThreshold: 25000, // $25K
        nativeTokenKey: 'weth'
    },
    base: {
        batchSize: 20,
        batchTimeout: 30,
        healthCheckInterval: 30000,
        confidence: 0.80,
        expiryMs: 10000, // 10s
        gasEstimate: 100000,
        whaleThreshold: 25000, // $25K
        nativeTokenKey: 'weth'
    },
    polygon: {
        batchSize: 20,
        batchTimeout: 30,
        healthCheckInterval: 30000,
        confidence: 0.80,
        expiryMs: 10000, // 10s
        gasEstimate: 150000,
        whaleThreshold: 25000, // $25K
        nativeTokenKey: 'weth' // WETH on Polygon, not WMATIC for USD calc
    },
    bsc: {
        batchSize: 20,
        batchTimeout: 30,
        healthCheckInterval: 30000,
        confidence: 0.80,
        expiryMs: 10000, // 10s
        gasEstimate: 200000,
        whaleThreshold: 50000, // $50K (moderate threshold)
        nativeTokenKey: 'nativeWrapper' // WBNB for USD calc
    },
    // =============================================================================
    // S3.1.2: New Chain Detector Configurations
    // =============================================================================
    avalanche: {
        batchSize: 20,
        batchTimeout: 30,
        healthCheckInterval: 30000,
        confidence: 0.80,
        expiryMs: 10000, // 10s (2s block time)
        gasEstimate: 150000, // Moderate gas on C-Chain
        whaleThreshold: 25000, // $25K
        nativeTokenKey: 'nativeWrapper' // WAVAX for USD calc
    },
    fantom: {
        batchSize: 25, // Higher batch for 1s blocks
        batchTimeout: 25, // Faster timeout for quick blocks
        healthCheckInterval: 20000, // More frequent health checks
        confidence: 0.82,
        expiryMs: 8000, // 8s (faster for 1s blocks)
        gasEstimate: 100000, // Low gas on Fantom
        whaleThreshold: 25000, // $25K
        nativeTokenKey: 'nativeWrapper' // WFTM for USD calc
    },
    zksync: {
        batchSize: 25, // Higher batch for fast ZK rollup
        batchTimeout: 25,
        healthCheckInterval: 20000,
        confidence: 0.82,
        expiryMs: 8000, // 8s
        gasEstimate: 80000, // Low gas on zkSync (ZK proofs)
        whaleThreshold: 25000, // $25K
        nativeTokenKey: 'weth'
    },
    linea: {
        batchSize: 20,
        batchTimeout: 30,
        healthCheckInterval: 30000,
        confidence: 0.80,
        expiryMs: 10000, // 10s
        gasEstimate: 100000, // Moderate gas on Linea
        whaleThreshold: 25000, // $25K
        nativeTokenKey: 'weth'
    },
    solana: {
        batchSize: 50, // Very high batch for 400ms blocks
        batchTimeout: 10, // Very fast timeout
        healthCheckInterval: 10000, // Frequent health checks
        confidence: 0.85, // High confidence for fast chain
        expiryMs: 5000, // 5s (very fast blocks)
        gasEstimate: 5000, // Very low transaction fees
        whaleThreshold: 50000, // $50K (high activity chain)
        nativeTokenKey: 'nativeWrapper' // Wrapped SOL for USD calc
    }
};
// =============================================================================
// FLASH LOAN PROVIDER CONFIGURATION (P1-4 fix)
// Moved from hardcoded values in execution-engine
// =============================================================================
exports.FLASH_LOAN_PROVIDERS = {
    // Aave V3 Pool addresses - https://docs.aave.com/developers/deployed-contracts
    ethereum: {
        address: '0x87870BcD2C4C2e84a8c3C3a3fcACc94666C0d6CF',
        protocol: 'aave_v3',
        fee: 9 // 0.09% flash loan fee
    },
    polygon: {
        address: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
        protocol: 'aave_v3',
        fee: 9
    },
    arbitrum: {
        address: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
        protocol: 'aave_v3',
        fee: 9
    },
    base: {
        address: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
        protocol: 'aave_v3',
        fee: 9
    },
    optimism: {
        address: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
        protocol: 'aave_v3',
        fee: 9
    },
    // BSC uses Pancakeswap flash loans (no Aave V3)
    bsc: {
        address: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4', // PancakeSwap V3 Router
        protocol: 'pancakeswap_v3',
        fee: 25 // 0.25% flash swap fee
    }
};
exports.BRIDGE_COSTS = [
    // Stargate (LayerZero) - Good for stablecoins
    { bridge: 'stargate', sourceChain: 'ethereum', targetChain: 'arbitrum', feePercentage: 0.06, minFeeUsd: 1, estimatedLatencySeconds: 180, reliability: 0.95 },
    { bridge: 'stargate', sourceChain: 'ethereum', targetChain: 'optimism', feePercentage: 0.06, minFeeUsd: 1, estimatedLatencySeconds: 180, reliability: 0.95 },
    { bridge: 'stargate', sourceChain: 'ethereum', targetChain: 'polygon', feePercentage: 0.06, minFeeUsd: 1, estimatedLatencySeconds: 180, reliability: 0.95 },
    { bridge: 'stargate', sourceChain: 'ethereum', targetChain: 'bsc', feePercentage: 0.06, minFeeUsd: 1, estimatedLatencySeconds: 180, reliability: 0.95 },
    { bridge: 'stargate', sourceChain: 'ethereum', targetChain: 'base', feePercentage: 0.06, minFeeUsd: 1, estimatedLatencySeconds: 180, reliability: 0.95 },
    { bridge: 'stargate', sourceChain: 'arbitrum', targetChain: 'ethereum', feePercentage: 0.06, minFeeUsd: 0.5, estimatedLatencySeconds: 180, reliability: 0.95 },
    { bridge: 'stargate', sourceChain: 'arbitrum', targetChain: 'optimism', feePercentage: 0.04, minFeeUsd: 0.3, estimatedLatencySeconds: 90, reliability: 0.95 },
    { bridge: 'stargate', sourceChain: 'arbitrum', targetChain: 'base', feePercentage: 0.04, minFeeUsd: 0.3, estimatedLatencySeconds: 90, reliability: 0.95 },
    // Across Protocol - Fast with relayer model
    { bridge: 'across', sourceChain: 'ethereum', targetChain: 'arbitrum', feePercentage: 0.04, minFeeUsd: 2, estimatedLatencySeconds: 120, reliability: 0.97 },
    { bridge: 'across', sourceChain: 'ethereum', targetChain: 'optimism', feePercentage: 0.04, minFeeUsd: 2, estimatedLatencySeconds: 120, reliability: 0.97 },
    { bridge: 'across', sourceChain: 'ethereum', targetChain: 'polygon', feePercentage: 0.04, minFeeUsd: 2, estimatedLatencySeconds: 120, reliability: 0.97 },
    { bridge: 'across', sourceChain: 'ethereum', targetChain: 'base', feePercentage: 0.04, minFeeUsd: 2, estimatedLatencySeconds: 120, reliability: 0.97 },
    { bridge: 'across', sourceChain: 'arbitrum', targetChain: 'ethereum', feePercentage: 0.04, minFeeUsd: 1, estimatedLatencySeconds: 120, reliability: 0.97 },
    { bridge: 'across', sourceChain: 'arbitrum', targetChain: 'optimism', feePercentage: 0.03, minFeeUsd: 0.5, estimatedLatencySeconds: 60, reliability: 0.97 },
    { bridge: 'across', sourceChain: 'optimism', targetChain: 'arbitrum', feePercentage: 0.03, minFeeUsd: 0.5, estimatedLatencySeconds: 60, reliability: 0.97 },
    { bridge: 'across', sourceChain: 'base', targetChain: 'arbitrum', feePercentage: 0.03, minFeeUsd: 0.5, estimatedLatencySeconds: 60, reliability: 0.97 },
    // Native bridges (L2 -> L1 are slower)
    { bridge: 'native', sourceChain: 'arbitrum', targetChain: 'ethereum', feePercentage: 0.0, minFeeUsd: 5, estimatedLatencySeconds: 604800, reliability: 0.99 }, // 7 days
    { bridge: 'native', sourceChain: 'optimism', targetChain: 'ethereum', feePercentage: 0.0, minFeeUsd: 5, estimatedLatencySeconds: 604800, reliability: 0.99 }, // 7 days
    { bridge: 'native', sourceChain: 'base', targetChain: 'ethereum', feePercentage: 0.0, minFeeUsd: 5, estimatedLatencySeconds: 604800, reliability: 0.99 }, // 7 days
];
/**
 * P1-5 FIX: Get bridge cost for a specific route
 */
function getBridgeCost(sourceChain, targetChain, bridge) {
    const normalizedSource = sourceChain.toLowerCase();
    const normalizedTarget = targetChain.toLowerCase();
    if (bridge) {
        return exports.BRIDGE_COSTS.find(b => b.sourceChain === normalizedSource &&
            b.targetChain === normalizedTarget &&
            b.bridge === bridge.toLowerCase());
    }
    // Find best bridge (lowest fee)
    const options = exports.BRIDGE_COSTS.filter(b => b.sourceChain === normalizedSource && b.targetChain === normalizedTarget);
    if (options.length === 0)
        return undefined;
    return options.reduce((best, current) => current.feePercentage < best.feePercentage ? current : best);
}
/**
 * P1-5 FIX: Calculate bridge cost for a given USD amount
 */
function calculateBridgeCostUsd(sourceChain, targetChain, amountUsd, bridge) {
    const config = getBridgeCost(sourceChain, targetChain, bridge);
    if (!config)
        return undefined;
    const percentageFee = amountUsd * (config.feePercentage / 100);
    const fee = Math.max(percentageFee, config.minFeeUsd);
    return {
        fee,
        latency: config.estimatedLatencySeconds,
        bridge: config.bridge
    };
}
// =============================================================================
// SYSTEM CONSTANTS (P2-2-FIX)
// Centralized configuration to eliminate magic numbers across the codebase
// =============================================================================
exports.SYSTEM_CONSTANTS = {
    // Redis configuration
    redis: {
        /** Maximum message size in bytes for Redis pub/sub (1MB) */
        maxMessageSize: 1024 * 1024,
        /** Maximum channel name length */
        maxChannelNameLength: 128,
        /** Default SCAN batch size for iterating keys */
        scanBatchSize: 100,
        /** Default TTL for health data in seconds */
        healthDataTtl: 300,
        /** Default TTL for metrics data in seconds */
        metricsDataTtl: 86400,
        /** Maximum rolling metrics entries */
        maxRollingMetrics: 100,
        /** Disconnect timeout in milliseconds */
        disconnectTimeout: 5000,
    },
    // Cache configuration
    cache: {
        /** Average entry size estimate in bytes for L1 capacity calculation */
        averageEntrySize: 1024,
        /** Default L1 cache size in MB */
        defaultL1SizeMb: 64,
        /** Default L2 TTL in seconds */
        defaultL2TtlSeconds: 300,
        /** Auto-demotion threshold in milliseconds */
        demotionThresholdMs: 5 * 60 * 1000,
        /** Minimum access count before demotion */
        minAccessCountBeforeDemotion: 3,
    },
    // Self-healing configuration
    selfHealing: {
        /** Circuit breaker recovery cooldown in milliseconds */
        circuitBreakerCooldownMs: 60000,
        /** Health check failure threshold before recovery */
        healthCheckFailureThreshold: 3,
        /** Graceful degradation failure threshold */
        gracefulDegradationThreshold: 10,
        /** Maximum restart delay in milliseconds */
        maxRestartDelayMs: 300000,
        /** Simulated restart delay for testing in milliseconds */
        simulatedRestartDelayMs: 2000,
        /** Simulated restart failure rate (0-1) */
        simulatedRestartFailureRate: 0.2,
    },
    // WebSocket configuration
    webSocket: {
        /** Default reconnect delay in milliseconds */
        defaultReconnectDelayMs: 1000,
        /** Maximum reconnect delay in milliseconds */
        maxReconnectDelayMs: 30000,
        /** Reconnect backoff multiplier */
        reconnectBackoffMultiplier: 2,
        /** Maximum reconnect attempts */
        maxReconnectAttempts: 10,
        /** Connection timeout in milliseconds */
        connectionTimeoutMs: 10000,
    },
    // Circuit breaker configuration
    circuitBreaker: {
        /** Default failure threshold */
        defaultFailureThreshold: 3,
        /** Default recovery timeout in milliseconds */
        defaultRecoveryTimeoutMs: 30000,
        /** Default monitoring period in milliseconds */
        defaultMonitoringPeriodMs: 60000,
        /** Default success threshold for closing */
        defaultSuccessThreshold: 2,
    },
    // P4-FIX: Centralized timeout constants
    timeouts: {
        /** HTTP health check timeout in milliseconds */
        httpHealthCheck: 5000,
        /** Redis operation timeout in milliseconds */
        redisOperation: 5000,
        /** Graceful shutdown timeout in milliseconds */
        gracefulShutdown: 30000,
        /** Opportunity deduplication TTL in seconds (Redis SET NX) */
        opportunityDedupTtlSeconds: 30,
        /** Subgraph API request timeout in milliseconds */
        subgraphRequest: 10000,
        /** RPC provider request timeout in milliseconds */
        rpcRequest: 15000,
    },
};
// =============================================================================
// CROSS-CHAIN TOKEN NORMALIZATION (S3.2.4)
// =============================================================================
/**
 * Cross-chain token aliases for identifying equivalent tokens across chains.
 * Maps chain-specific token symbols to their canonical form.
 *
 * Purpose: Enable cross-chain arbitrage detection by recognizing that
 * WETH.e (Avalanche), ETH (BSC), and WETH (most chains) are all the same asset.
 *
 * Note: This is DIFFERENT from price-oracle's TOKEN_ALIASES which maps
 * wrapped tokens to native for pricing (WETH→ETH). Here we use WETH as
 * canonical because it's the actual tradeable asset on DEXes.
 *
 * @see services/cross-chain-detector/src/detector.ts
 * @see shared/core/src/price-oracle.ts (different purpose)
 */
exports.CROSS_CHAIN_TOKEN_ALIASES = {
    // Fantom-specific (keys are UPPERCASE for case-insensitive matching)
    'FUSDT': 'USDT',
    'WFTM': 'FTM',
    // Avalanche-specific (bridged tokens use .e suffix)
    'WAVAX': 'AVAX',
    'WETH.E': 'WETH', // Note: .E is uppercase for matching
    'WBTC.E': 'WBTC',
    'USDT.E': 'USDT',
    'USDC.E': 'USDC',
    'DAI.E': 'DAI',
    // BSC-specific
    'WBNB': 'BNB',
    'BTCB': 'WBTC', // Binance wrapped BTC → canonical WBTC
    'ETH': 'WETH', // BSC bridged ETH → canonical WETH
    // Polygon-specific
    'WMATIC': 'MATIC',
    // Generic wrappers (if found without chain context)
    'WETH': 'WETH', // Identity mapping for clarity
    'WBTC': 'WBTC'
};
/**
 * Normalize a token symbol to its canonical form for cross-chain comparison.
 * This enables identifying equivalent tokens across different chains.
 *
 * Examples:
 * - normalizeTokenForCrossChain('WETH.e') → 'WETH'  (Avalanche bridged ETH)
 * - normalizeTokenForCrossChain('ETH') → 'WETH'     (BSC bridged ETH)
 * - normalizeTokenForCrossChain('fUSDT') → 'USDT'   (Fantom USDT)
 * - normalizeTokenForCrossChain('BTCB') → 'WBTC'    (BSC wrapped BTC)
 * - normalizeTokenForCrossChain('USDC') → 'USDC'    (passthrough)
 *
 * @param symbol - The token symbol to normalize
 * @returns The canonical token symbol for cross-chain comparison
 */
function normalizeTokenForCrossChain(symbol) {
    const upper = symbol.toUpperCase().trim();
    return exports.CROSS_CHAIN_TOKEN_ALIASES[upper] || upper;
}
/**
 * Find common tokens between two chains using normalized comparison.
 * Returns canonical token symbols that exist on both chains.
 *
 * @param chainA - First chain ID
 * @param chainB - Second chain ID
 * @returns Array of canonical token symbols common to both chains
 */
function findCommonTokensBetweenChains(chainA, chainB) {
    const tokensA = exports.CORE_TOKENS[chainA] || [];
    const tokensB = exports.CORE_TOKENS[chainB] || [];
    const normalizedA = new Set(tokensA.map(t => normalizeTokenForCrossChain(t.symbol)));
    const normalizedB = new Set(tokensB.map(t => normalizeTokenForCrossChain(t.symbol)));
    return Array.from(normalizedA).filter(token => normalizedB.has(token));
}
/**
 * Get the chain-specific token symbol for a canonical symbol.
 * Useful for building pair keys when you know the canonical token.
 *
 * @param chainId - The chain ID
 * @param canonicalSymbol - The canonical token symbol (e.g., 'WETH')
 * @returns The chain-specific symbol (e.g., 'WETH.e' on Avalanche) or undefined
 */
function getChainSpecificTokenSymbol(chainId, canonicalSymbol) {
    const tokens = exports.CORE_TOKENS[chainId] || [];
    // First try exact match
    const exactMatch = tokens.find(t => t.symbol === canonicalSymbol);
    if (exactMatch)
        return exactMatch.symbol;
    // Then try normalized match
    for (const token of tokens) {
        if (normalizeTokenForCrossChain(token.symbol) === canonicalSymbol) {
            return token.symbol;
        }
    }
    return undefined;
}
// =============================================================================
// PARTITION EXPORTS (ADR-003)
// =============================================================================
__exportStar(require("./partitions"), exports);
// Named re-exports for ADR-003 compliance tests
var partitions_1 = require("./partitions");
Object.defineProperty(exports, "PARTITIONS", { enumerable: true, get: function () { return partitions_1.PARTITIONS; } });
Object.defineProperty(exports, "PARTITION_IDS", { enumerable: true, get: function () { return partitions_1.PARTITION_IDS; } });
Object.defineProperty(exports, "getPartition", { enumerable: true, get: function () { return partitions_1.getPartition; } });
Object.defineProperty(exports, "getPartitionFromEnv", { enumerable: true, get: function () { return partitions_1.getPartitionFromEnv; } });
Object.defineProperty(exports, "assignChainToPartition", { enumerable: true, get: function () { return partitions_1.assignChainToPartition; } });
//# sourceMappingURL=index.js.map