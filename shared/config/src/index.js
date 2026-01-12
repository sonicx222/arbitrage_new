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
exports.assignChainToPartition = exports.getPartitionFromEnv = exports.getPartition = exports.PARTITIONS = exports.BRIDGE_COSTS = exports.FLASH_LOAN_PROVIDERS = exports.DETECTOR_CONFIG = exports.EVENT_SIGNATURES = exports.TOKEN_METADATA = exports.PHASE_METRICS = exports.PARTITION_CONFIG = exports.EVENT_CONFIG = exports.ARBITRAGE_CONFIG = exports.PERFORMANCE_THRESHOLDS = exports.SERVICE_CONFIGS = exports.CORE_TOKENS = exports.DEXES = exports.CHAINS = void 0;
exports.getBridgeCost = getBridgeCost;
exports.calculateBridgeCostUsd = calculateBridgeCostUsd;
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
        blockTime: 0.25,
        nativeToken: 'ETH'
    },
    bsc: {
        id: 56,
        name: 'BSC',
        rpcUrl: process.env.BSC_RPC_URL || 'https://bsc-dataseed1.binance.org',
        wsUrl: process.env.BSC_WS_URL || 'wss://bsc-ws-node.nariox.org:443',
        blockTime: 3,
        nativeToken: 'BNB'
    },
    base: {
        id: 8453,
        name: 'Base',
        rpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
        wsUrl: process.env.BASE_WS_URL || 'wss://mainnet.base.org',
        blockTime: 2,
        nativeToken: 'ETH'
    },
    // T2: High value, mature ecosystems
    polygon: {
        id: 137,
        name: 'Polygon',
        rpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
        wsUrl: process.env.POLYGON_WS_URL || 'wss://polygon-rpc.com',
        blockTime: 2,
        nativeToken: 'MATIC'
    },
    optimism: {
        id: 10,
        name: 'Optimism',
        rpcUrl: process.env.OPTIMISM_RPC_URL || 'https://mainnet.optimism.io',
        wsUrl: process.env.OPTIMISM_WS_URL || 'wss://mainnet.optimism.io',
        blockTime: 2,
        nativeToken: 'ETH'
    },
    // T3: Selective - only large opportunities
    ethereum: {
        id: 1,
        name: 'Ethereum',
        rpcUrl: process.env.ETHEREUM_RPC_URL || 'https://eth.llamarpc.com',
        wsUrl: process.env.ETHEREUM_WS_URL || 'wss://eth.llamarpc.com',
        blockTime: 12,
        nativeToken: 'ETH'
    }
};
// =============================================================================
// DEX CONFIGURATIONS - Phase 1: 25 DEXs
// [C] = Critical, [H] = High Priority, [M] = Medium Priority
// =============================================================================
exports.DEXES = {
    // Arbitrum: 6 DEXs (highest fragmentation)
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
            routerAddress: '0xbeE5c10Cf6E4F68f831E11C1D9E59B43560B3571',
            fee: 30
        },
        {
            name: 'zyberswap', // [M]
            chain: 'arbitrum',
            factoryAddress: '0xAC2ee06A14c52570Ef3B9812Ed240BCe359772e7',
            routerAddress: '0x16e71B13fE6079B4312063F7E81F76d165Ad32Ad',
            fee: 30
        },
        {
            name: 'ramses', // [M]
            chain: 'arbitrum',
            factoryAddress: '0xAAA20D08e59F6561f242b08513D36266C5A29415',
            routerAddress: '0xAAA87963EFeB6f7E0a2711F397663105Acb1805e',
            fee: 30
        }
    ],
    // BSC: 5 DEXs (highest volume)
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
        }
    ],
    // Base: 5 DEXs (fastest growing)
    base: [
        {
            name: 'uniswap_v3', // [C]
            chain: 'base',
            factoryAddress: '0x33128a8fC17869897dcE68Ed026d694621f6FdFD',
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
    // Chain-specific minimum profits (due to gas costs)
    chainMinProfits: {
        ethereum: 0.005, // 0.5% - higher due to gas
        arbitrum: 0.002, // 0.2% - low gas
        optimism: 0.002, // 0.2% - low gas
        base: 0.002, // 0.2% - low gas
        polygon: 0.002, // 0.2% - low gas
        bsc: 0.003 // 0.3% - moderate gas
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
// Aligns with ADR-003 and ADR-008
// =============================================================================
exports.PARTITION_CONFIG = {
    P1_ASIA_FAST: ['bsc', 'polygon'], // Phase 1
    P2_L2_TURBO: ['arbitrum', 'optimism', 'base'], // Phase 1
    P3_HIGH_VALUE: ['ethereum'], // Phase 1
    // Future phases
    P1_ASIA_FAST_PHASE2: ['bsc', 'polygon', 'avalanche', 'fantom'],
    P3_HIGH_VALUE_PHASE3: ['ethereum', 'zksync', 'linea']
};
// =============================================================================
// PHASE METRICS
// Track progress against targets from ADR-008
// =============================================================================
exports.PHASE_METRICS = {
    current: {
        phase: 1,
        chains: Object.keys(exports.CHAINS).length,
        dexes: Object.values(exports.DEXES).flat().length,
        tokens: Object.values(exports.CORE_TOKENS).flat().length,
        targetOpportunities: 300
    },
    targets: {
        phase1: { chains: 7, dexes: 25, tokens: 60, opportunities: 300 },
        phase2: { chains: 9, dexes: 45, tokens: 110, opportunities: 550 },
        phase3: { chains: 10, dexes: 55, tokens: 150, opportunities: 780 }
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
    }
};
// =============================================================================
// FLASH LOAN PROVIDER CONFIGURATION (P1-4 fix)
// Moved from hardcoded values in execution-engine
// =============================================================================
exports.FLASH_LOAN_PROVIDERS = {
    // Aave V3 Pool addresses - https://docs.aave.com/developers/deployed-contracts
    ethereum: {
        address: '0x87870Bcd2C4c2e84A8c3C3a3FcACC94666c0d6Cf',
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
// PARTITION EXPORTS (ADR-003)
// =============================================================================
__exportStar(require("./partitions"), exports);
// Named re-exports for ADR-003 compliance tests
var partitions_1 = require("./partitions");
Object.defineProperty(exports, "PARTITIONS", { enumerable: true, get: function () { return partitions_1.PARTITIONS; } });
Object.defineProperty(exports, "getPartition", { enumerable: true, get: function () { return partitions_1.getPartition; } });
Object.defineProperty(exports, "getPartitionFromEnv", { enumerable: true, get: function () { return partitions_1.getPartitionFromEnv; } });
Object.defineProperty(exports, "assignChainToPartition", { enumerable: true, get: function () { return partitions_1.assignChainToPartition; } });
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJpbmRleC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7OztBQW11QkEsc0NBMEJDO0FBS0Qsd0RBaUJDO0FBL3dCRCxnRkFBZ0Y7QUFDaEYsSUFBSSxPQUFPLENBQUMsR0FBRyxDQUFDLFFBQVEsS0FBSyxNQUFNLEVBQUUsQ0FBQztJQUNwQyxJQUFJLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxnQkFBZ0IsRUFBRSxDQUFDO1FBQ2xDLE1BQU0sSUFBSSxLQUFLLENBQUMsMEVBQTBFLENBQUMsQ0FBQztJQUM5RixDQUFDO0lBQ0QsSUFBSSxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsZUFBZSxFQUFFLENBQUM7UUFDakMsTUFBTSxJQUFJLEtBQUssQ0FBQyx5RUFBeUUsQ0FBQyxDQUFDO0lBQzdGLENBQUM7QUFDSCxDQUFDO0FBRUQsZ0ZBQWdGO0FBQ2hGLDJDQUEyQztBQUMzQyw0RUFBNEU7QUFDNUUsZ0ZBQWdGO0FBQ25FLFFBQUEsTUFBTSxHQUEwQjtJQUMzQyxrQ0FBa0M7SUFDbEMsUUFBUSxFQUFFO1FBQ1IsRUFBRSxFQUFFLEtBQUs7UUFDVCxJQUFJLEVBQUUsVUFBVTtRQUNoQixNQUFNLEVBQUUsT0FBTyxDQUFDLEdBQUcsQ0FBQyxnQkFBZ0IsSUFBSSw4QkFBOEI7UUFDdEUsS0FBSyxFQUFFLE9BQU8sQ0FBQyxHQUFHLENBQUMsZUFBZSxJQUFJLDZCQUE2QjtRQUNuRSxTQUFTLEVBQUUsSUFBSTtRQUNmLFdBQVcsRUFBRSxLQUFLO0tBQ25CO0lBQ0QsR0FBRyxFQUFFO1FBQ0gsRUFBRSxFQUFFLEVBQUU7UUFDTixJQUFJLEVBQUUsS0FBSztRQUNYLE1BQU0sRUFBRSxPQUFPLENBQUMsR0FBRyxDQUFDLFdBQVcsSUFBSSxtQ0FBbUM7UUFDdEUsS0FBSyxFQUFFLE9BQU8sQ0FBQyxHQUFHLENBQUMsVUFBVSxJQUFJLGtDQUFrQztRQUNuRSxTQUFTLEVBQUUs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RSxPQUFPLEVBQUUsNENBQTRDLEVBQUUsTUFBTSxFQUFFLE1BQU0sRUFBRSxRQUFRLEVBQUUsRUFBRSxFQUFFLE9BQU8sRUFBRSxLQUFLLEVBQUU7UUFDdkcsRUFBRSxPQUFPLEVBQUUsNENBQTRDLEVBQUUsTUFBTSxFQUFFLE1BQU0sRUFBRSxRQUFRLEVBQUUsQ0FBQyxFQUFFLE9BQU8sRUFBRSxLQUFLLEVBQUU7UUFDdEcsRUFBRSxPQUFPLEVBQUUsNENBQTRDLEVBQUUsTUFBTSxFQUFFLE1BQU0sRUFBRSxRQUFRLEVBQUUsQ0FBQyxFQUFFLE9BQU8sRUFBRSxLQUFLLEVBQUU7UUFDdEcsRUFBRSxPQUFPLEVBQUUsNENBQTRDLEVBQUUsTUFBTSxFQUFFLEtBQUssRUFBRSxRQUFRLEVBQUUsRUFBRSxFQUFFLE9BQU8sRUFBRSxLQUFLLEVBQUU7UUFDdEcsRUFBRSxPQUFPLEVBQUUsNENBQTRDLEVBQUUsTUFBTSxFQUFFLE1BQU0sRUFBRSxRQUFRLEVBQUUsQ0FBQyxFQUFFLE9BQU8sRUFBRSxLQUFLLEVBQUU7UUFDdEcsbUJBQW1CO1FBQ25CLEVBQUUsT0FBTyxFQUFFLDRDQUE0QyxFQUFFLE1BQU0sRUFBRSxLQUFLLEVBQUUsUUFBUSxFQUFFLEVBQUUsRUFBRSxPQUFPLEVBQUUsS0FBSyxFQUFFO1FBQ3RHLFlBQVk7UUFDWixFQUFFLE9BQU8sRUFBRSw0Q0FBNEMsRUFBRSxNQUFNLEVBQUUsS0FBSyxFQUFFLFFBQVEsRUFBRSxFQUFFLEVBQUUsT0FBTyxFQUFFLEtBQUssRUFBRTtRQUN0RyxFQUFFLE9BQU8sRUFBRSw0Q0FBNEMsRUFBRSxNQUFNLEVBQUUsTUFBTSxFQUFFLFFBQVEsRUFBRSxFQUFFLEVBQUUsT0FBTyxFQUFFLEtBQUssRUFBRTtRQUN2RyxFQUFFLE9BQU8sRUFBRSw0Q0FBNEMsRUFBRSxNQUFNLEVBQUUsS0FBSyxFQUFFLFFBQVEsRUFBRSxFQUFFLEVBQUUsT0FBTyxFQUFFLEtBQUssRUFBRTtRQUN0RyxFQUFFLE9BQU8sRUFBRSw0Q0FBNEMsRUFBRSxNQUFNLEVBQUUsT0FBTyxF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LElBQUksRUFBRSxTQUFTLEVBQUUsQ0FBQyxFQUFFLHVCQUF1QixFQUFFLEdBQUcsRUFBRSxXQUFXLEVBQUUsSUFBSSxFQUFFO0lBQ3hKLEVBQUUsTUFBTSxFQUFFLFVBQVUsRUFBRSxXQUFXLEVBQUUsVUFBVSxFQUFFLFdBQVcsRUFBRSxVQUFVLEVBQUUsYUFBYSxFQUFFLElBQUksRUFBRSxTQUFTLEVBQUUsR0FBRyxFQUFFLHVCQUF1QixFQUFFLEdBQUcsRUFBRSxXQUFXLEVBQUUsSUFBSSxFQUFFO0lBQzlKLEVBQUUsTUFBTSxFQUFFLFVBQVUsRUFBRSxXQUFXLEVBQUUsVUFBVSxFQUFFLFdBQVcsRUFBRSxVQUFVLEVBQUUsYUFBYSxFQUFFLElBQUksRUFBRSxTQUFTLEVBQUUsR0FBRyxFQUFFLHVCQUF1QixFQUFFLEVBQUUsRUFBRSxXQUFXLEVBQUUsSUFBSSxFQUFFO0lBQzdKLEVBQUUsTUFBTSxFQUFFLFVBQVUsRUFBRSxXQUFXLEVBQUUsVUFBVSxFQUFFLFdBQVcsRUFBRSxNQUFNLEVBQUUsYUFBYSxFQUFFLElBQUksRUFBRSxTQUFTLEVBQUUsR0FBRyxFQUFFLHVCQUF1QixFQUFFLEVBQUUsRUFBRSxXQUFXLEVBQUUsSUFBSSxFQUFFO0lBRXpKLDRDQUE0QztJQUM1QyxFQUFFLE1BQU0sRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLFVBQVUsRUFBRSxXQUFXLEVBQUUsVUFBVSxFQUFFLGFBQWEsRUFBRSxJQUFJLEVBQUUsU0FBUyxFQUFFLENBQUMsRUFBRSx1QkFBdUIsRUFBRSxHQUFHLEVBQUUsV0FBVyxFQUFFLElBQUksRUFBRTtJQUMxSixFQUFFLE1BQU0sRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLFVBQVUsRUFBRSxXQUFXLEVBQUUsVUFBVSxFQUFFLGFBQWEsRUFBRSxJQUFJLEVBQUUsU0FBUyxFQUFFLENBQUMsRUFBRSx1QkFBdUIsRUFBRSxHQUFHLEVBQUUsV0FBVyxFQUFFLElBQUksRUFBRTtJQUMxSixFQUFFLE1BQU0sRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLFVBQVUsRUFBRSxXQUFXLEVBQUUsU0FBUyxFQUFFLGFBQWEsRUFBRSxJQUFJLEVBQUUsU0FBUyxFQUFFLENBQUMsRUFBRSx1QkFBdUIsRUFBRSxHQUFHLEVBQUUsV0FBVyxFQUFFLElBQUksRUFBRTtJQUN6SixFQUFFLE1BQU0sRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLFVBQVUsRUFBRSxXQUFXLEVBQUUsTUFBTSxFQUFFLGFBQWEsRUFBRSxJQUFJLEVBQUUsU0FBUyxFQUFFLENBQUMsRUFBRSx1QkFBdUIsRUFBRSxHQUFHLEVBQUUsV0FBVyxFQUFFLElBQUksRUFBRTtJQUN0SixFQUFFLE1BQU0sRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLFVBQVUsRUFBRSxXQUFXLEVBQUUsVUFBVSxFQUFFLGFBQWEsRUFBRSxJQUFJLEVBQUUsU0FBUyxFQUFFLENBQUMsRUFBRSx1QkFBdUIsRUFBRSxHQUFHLEVBQUUsV0FBVyxFQUFFLElBQUksRUFBRTtJQUMxSixFQUFFLE1BQU0sRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLFVBQVUsRUFBRSxXQUFXLEVBQUUsVUFBVSxFQUFFLGFBQWEsRUFBRSxJQUFJLEVBQUUsU0FBUyxFQUFFLEdBQUcsRUFBRSx1QkFBdUIsRUFBRSxFQUFFLEVBQUUsV0FBVyxFQUFFLElBQUksRUFBRTtJQUMzSixFQUFFLE1BQU0sRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLFVBQVUsRUFBRSxXQUFXLEVBQUUsVUFBVSxFQUFFLGFBQWEsRUFBRSxJQUFJLEVBQUUsU0FBUyxFQUFFLEdBQUcsRUFBRSx1QkFBdUIsRUFBRSxFQUFFLEVBQUUsV0FBVyxFQUFFLElBQUksRUFBRTtJQUMzSixFQUFFLE1BQU0sRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLE1BQU0sRUFBRSxXQUFXLEVBQUUsVUFBVSxFQUFFLGFBQWEsRUFBRSxJQUFJLEVBQUUsU0FBUyxFQUFFLEdBQUcsRUFBRSx1QkFBdUIsRUFBRSxFQUFFLEVBQUUsV0FBVyxFQUFFLElBQUksRUFBRTtJQUV2Six1Q0FBdUM7SUFDdkMsRUFBRSxNQUFNLEVB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c0IsT0FBQSIsInNvdXJjZXNDb250ZW50IjpbIi8vIFNoYXJlZCBjb25maWd1cmF0aW9uIGZvciB0aGUgYXJiaXRyYWdlIHN5c3RlbVxyXG4vLyBVcGRhdGVkOiAyMDI1LTAxLTEwIC0gUGhhc2UgMSBleHBhbnNpb24gKDcgY2hhaW5zLCAyNSBERVhzLCA2MCB0b2tlbnMpXHJcbmltcG9ydCB7IENoYWluLCBEZXgsIFRva2VuIH0gZnJvbSAnLi4vLi4vdHlwZXMnO1xyXG5cclxuLy8gVmFsaWRhdGUgcmVxdWlyZWQgZW52aXJvbm1lbnQgdmFyaWFibGVzIGF0IHN0YXJ0dXAgKHNraXAgaW4gdGVzdCBlbnZpcm9ubWVudClcclxuaWYgKHByb2Nlc3MuZW52Lk5PREVfRU5WICE9PSAndGVzdCcpIHtcclxuICBpZiAoIXByb2Nlc3MuZW52LkVUSEVSRVVNX1JQQ19VUkwpIHtcclxuICAgIHRocm93IG5ldyBFcnJvcignQ1JJVElDQUwgQ09ORklHIEVSUk9SOiBFVEhFUkVVTV9SUENfVVJMIGVudmlyb25tZW50IHZhcmlhYmxlIGlzIHJlcXVpcmVkJyk7XHJcbiAgfVxyXG4gIGlmICghcHJvY2Vzcy5lbnYuRVRIRVJFVU1fV1NfVVJMKSB7XHJcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ0NSSVRJQ0FMIENPTkZJRyBFUlJPUjogRVRIRVJFVU1fV1NfVVJMIGVudmlyb25tZW50IHZhcmlhYmxlIGlzIHJlcXVpcmVkJyk7XHJcbiAgfVxyXG59XHJcblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4vLyBDSEFJTiBDT05GSUdVUkFUSU9OUyAtIFBoYXNlIDE6IDcgQ2hhaW5zXHJcbi8vIFByaW9yaXR5OiBUMSAoQXJiaXRydW0sIEJTQywgQmFzZSksIFQyIChQb2x5Z29uLCBPcHRpbWlzbSksIFQzIChFdGhlcmV1bSlcclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuZXhwb3J0IGNvbnN0IENIQUlOUzogUmVjb3JkPHN0cmluZywgQ2hhaW4+ID0ge1xyXG4gIC8vIFQxOiBIaWdoZXN0IGFyYml0cmFnZSBwb3RlbnRpYWxcclxuICBhcmJpdHJ1bToge1xyXG4gICAgaWQ6IDQyMTYxLFxyXG4gICAgbmFtZTogJ0FyYml0cnVtJyxcclxuICAgIHJwY1VybDogcHJvY2Vzcy5lbnYuQVJCSVRSVU1fUlBDX1VSTCB8fCAnaHR0cHM6Ly9hcmIxLmFyYml0cnVtLmlvL3JwYycsXHJcbiAgICB3c1VybDogcHJvY2Vzcy5lbnYuQVJCSVRSVU1fV1NfVVJMIHx8ICd3c3M6Ly9hcmIxLmFyYml0cnVtLmlvL2ZlZWQnLFxyXG4gICAgYmxvY2tUaW1lOiAwLjI1LFxyXG4gICAgbmF0aXZlVG9rZW46ICdFVEgnXHJcbiAgfSxcclxuICBic2M6IHtcclxuICAgIGlkOiA1NixcclxuICAgIG5hbWU6ICdCU0MnLFxyXG4gICAgcnBjVXJsOiBwcm9jZXNzLmVudi5CU0NfUlBDX1VSTCB8fCAnaHR0cHM6Ly9ic2MtZGF0YXNlZWQxLmJpbmFuY2Uub3JnJyxcclxuICAgIHdzVXJsOiBwcm9jZXNzLmVudi5CU0NfV1NfVVJMIHx8ICd3c3M6Ly9ic2Mtd3Mtbm9kZS5uYXJpb3gub3JnOjQ0MycsXHJcbiAgICBibG9ja1RpbWU6IDMsXHJcbiAgICBuYXRpdmVUb2tlbjogJ0JOQidcclxuICB9LFxyXG4gIGJhc2U6IHtcclxuICAgIGlkOiA4NDUzLFxyXG4gICAgbmFtZTogJ0Jhc2UnLFxyXG4gICAgcnBjVXJsOiBwcm9jZXNzLmVudi5CQVNFX1JQQ19VUkwgfHwgJ2h0dHBzOi8vbWFpbm5ldC5iYXNlLm9yZycsXHJcbiAgICB3c1VybDogcHJvY2Vzcy5lbnYuQkFTRV9XU19VUkwgfHwgJ3dzczovL21haW5uZXQuYmFzZS5vcmcnLFxyXG4gICAgYmxvY2tUaW1lOiAyLFxyXG4gICAgbmF0aXZlVG9rZW46ICdFVEgnXHJcbiAgfSxcclxuICAvLyBUMjogSGlnaCB2YWx1ZSwgbWF0dXJlIGVjb3N5c3RlbXNcclxuICBwb2x5Z29uOiB7XHJcbiAgICBpZDogMTM3LFxyXG4gICAgbmFtZTogJ1BvbHlnb24nLFxyXG4gICAgcnBjVXJsOiBwcm9jZXNzLmVudi5QT0xZR09OX1JQQ19VUkwgfHwgJ2h0dHBzOi8vcG9seWdvbi1ycGMuY29tJyxcclxuICAgIHdzVXJsOiBwcm9jZXNzLmVudi5QT0xZR09OX1dTX1VSTCB8fCAnd3NzOi8vcG9seWdvbi1ycGMuY29tJyxcclxuICAgIGJsb2NrVGltZTogMixcclxuICAgIG5hdGl2ZVRva2VuOiAnTUFUSUMnXHJcbiAgfSxcclxuICBvcHRpbWlzbToge1xyXG4gICAgaWQ6IDEwLFxyXG4gICAgbmFtZTogJ09wdGltaXNtJyxcclxuICAgIHJwY1VybDogcHJvY2Vzcy5lbnYuT1BUSU1JU01fUlBDX1VSTCB8fCAnaHR0cHM6Ly9tYWlubmV0Lm9wdGltaXNtLmlvJyxcclxuICAgIHdzVXJsOiBwcm9jZXNzLmVudi5PUFRJTUlTTV9XU19VUkwgfHwgJ3dzczovL21haW5uZXQub3B0aW1pc20uaW8nLFxyXG4gICAgYmxvY2tUaW1lOiAyLFxyXG4gICAgbmF0aXZlVG9rZW46ICdFVEgnXHJcbiAgfSxcclxuICAvLyBUMzogU2VsZWN0aXZlIC0gb25seSBsYXJnZSBvcHBvcnR1bml0aWVzXHJcbiAgZXRoZXJldW06IHtcclxuICAgIGlkOiAxLFxyXG4gICAgbmFtZTogJ0V0aGVyZXVtJyxcclxuICAgIHJwY1VybDogcHJvY2Vzcy5lbnYuRVRIRVJFVU1fUlBDX1VSTCB8fCAnaHR0cHM6Ly9ldGgubGxhbWFycGMuY29tJyxcclxuICAgIHdzVXJsOiBwcm9jZXNzLmVudi5FVEhFUkVVTV9XU19VUkwgfHwgJ3dzczovL2V0aC5sbGFtYXJwYy5jb20nLFxyXG4gICAgYmxvY2tUaW1lOiAxMixcclxuICAgIG5hdGl2ZVRva2VuOiAnRVRIJ1xyXG4gIH1cclxufTtcclxuXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbi8vIERFWCBDT05GSUdVUkFUSU9OUyAtIFBoYXNlIDE6IDI1IERFWHNcclxuLy8gW0NdID0gQ3JpdGljYWwsIFtIXSA9IEhpZ2ggUHJpb3JpdHksIFtNXSA9IE1lZGl1bSBQcmlvcml0eVxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5leHBvcnQgY29uc3QgREVYRVM6IFJlY29yZDxzdHJpbmcsIERleFtdPiA9IHtcclxuICAvLyBBcmJpdHJ1bTogNiBERVhzIChoaWdoZXN0IGZyYWdtZW50YXRpb24pXHJcbiAgYXJiaXRydW06IFtcclxuICAgIHtcclxuICAgICAgbmFtZTogJ3VuaXN3YXBfdjMnLCAgICAgICAvLyBbQ11cclxuICAgICAgY2hhaW46ICdhcmJpdHJ1bScsXHJcbiAgICAgIGZhY3RvcnlBZGRyZXNzOiAnMHgxRjk4NDMxYzhhRDk4NTIzNjMxQUU0YTU5ZjI2NzM0NmVhMzFGOTg0JyxcclxuICAgICAgcm91dGVyQWRkcmVzczogJzB4RTU5MjQyN0EwQUVjZTkyRGUzRWRlZTFGMThFMDE1N0MwNTg2MTU2NCcsXHJcbiAgICAgIGZlZTogMzBcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIG5hbWU6ICdjYW1lbG90X3YzJywgICAgICAgLy8gW0NdXHJcbiAgICAgIGNoYWluOiAnYXJiaXRydW0nLFxyXG4gICAgICBmYWN0b3J5QWRkcmVzczogJzB4MWEzYzlCMWQyRjA1MjlEOTdmMmFmQzUxMzZDYzIzZTU4ZjFGRDM1QicsXHJcbiAgICAgIHJvdXRlckFkZHJlc3M6ICcweGM4NzNmRWNiZDM1NGY1QTU2RTAwRTcxMEI5MEVGNDIwMWRiMjQ0OGQnLFxyXG4gICAgICBmZWU6IDMwXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBuYW1lOiAnc3VzaGlzd2FwJywgICAgICAgIC8vIFtDXVxyXG4gICAgICBjaGFpbjogJ2FyYml0cnVtJyxcclxuICAgICAgZmFjdG9yeUFkZHJlc3M6ICcweGMzNURBREI2NTAxMmVDNTc5NjUzNmJEOTg2NGVEODc3M2FCYzc0QzQnLFxyXG4gICAgICByb3V0ZXJBZGRyZXNzOiAnMHgxYjAyZEE4Q2IwZDA5N2VCOEQ1N0ExNzViODhjN0Q4YjQ3OTk3NTA2JyxcclxuICAgICAgZmVlOiAzMFxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgbmFtZTogJ3RyYWRlcl9qb2UnLCAgICAgICAvLyBbSF1cclxuICAgICAgY2hhaW46ICdhcmJpdHJ1bScsXHJcbiAgICAgIGZhY3RvcnlBZGRyZXNzOiAnMHgxODg2RDA5QzlBZGUwYzVEQjgyMkQ4NUQyMTY3OERiNjdCNmMyOTgyJyxcclxuICAgICAgcm91dGVyQWRkcmVzczogJzB4YmVFNWMxMENmNkU0RjY4ZjgzMUUxMUMxRDlFNTlCNDM1NjBCMzU3MScsXHJcbiAgICAgIGZlZTogMzBcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIG5hbWU6ICd6eWJlcnN3YXAnLCAgICAgICAgLy8gW01dXHJcbiAgICAgIGNoYWluOiAnYXJiaXRydW0nLFxyXG4gICAgICBmYWN0b3J5QWRkcmVzczogJzB4QUMyZWUwNkExNGM1MjU3MEVmM0I5ODEyRWQyNDBCQ2UzNTk3NzJlNycsXHJcbiAgICAgIHJvdXRlckFkZHJlc3M6ICcweDE2ZTcxQjEzZkU2MDc5QjQzMTIwNjNGN0U4MUY3NmQxNjVBZDMyQWQnLFxyXG4gICAgICBmZWU6IDMwXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBuYW1lOiAncmFtc2VzJywgICAgICAgICAgIC8vIFtNXVxyXG4gICAgICBjaGFpbjogJ2FyYml0cnVtJyxcclxuICAgICAgZmFjdG9yeUFkZHJlc3M6ICcweEFBQTIwRDA4ZTU5RjY1NjFmMjQyYjA4NTEzRDM2MjY2QzVBMjk0MTUnLFxyXG4gICAgICByb3V0ZXJBZGRyZXNzOiAnMHhBQUE4Nzk2M0VGZUI2ZjdFMGEyNzExRjM5NzY2MzEwNUFjYjE4MDVlJyxcclxuICAgICAgZmVlOiAzMFxyXG4gICAgfVxyXG4gIF0sXHJcbiAgLy8gQlNDOiA1IERFWHMgKGhpZ2hlc3Qgdm9sdW1lKVxyXG4gIGJzYzogW1xyXG4gICAge1xyXG4gICAgICBuYW1lOiAncGFuY2FrZXN3YXBfdjMnLCAgIC8vIFtDXVxyXG4gICAgICBjaGFpbjogJ2JzYycsXHJcbiAgICAgIGZhY3RvcnlBZGRyZXNzOiAnMHgwQkZiQ0Y5ZmE0ZjlDNTZCMEY0MGE2NzFBZDQwRTA4MDVBMDkxODY1JyxcclxuICAgICAgcm91dGVyQWRkcmVzczogJzB4MTNmNEVBODNEMGJkNDBFNzVDODIyMjI1NWJjODU1YTk3NDU2OERkNCcsXHJcbiAgICAgIGZlZTogMjVcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIG5hbWU6ICdwYW5jYWtlc3dhcF92MicsICAgLy8gW0NdXHJcbiAgICAgIGNoYWluOiAnYnNjJyxcclxuICAgICAgZmFjdG9yeUFkZHJlc3M6ICcweGNBMTQzQ2UzMkZlNzhmMWY3MDE5ZDdkNTUxYTY0MDJmQzUzNTBjNzMnLFxyXG4gICAgICByb3V0ZXJBZGRyZXNzOiAnMHgxMEVENDNDNzE4NzE0ZWI2M2Q1YUE1N0I3OEI1NDcwNEUyNTYwMjRFJyxcclxuICAgICAgZmVlOiAyNVxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgbmFtZTogJ2Jpc3dhcCcsICAgICAgICAgICAvLyBbQ11cclxuICAgICAgY2hhaW46ICdic2MnLFxyXG4gICAgICBmYWN0b3J5QWRkcmVzczogJzB4ODU4RTMzMTJlZDNBODc2OTQ3RUE0OWQ1NzJBN0M0MkRFMDhhZjdFRScsXHJcbiAgICAgIHJvdXRlckFkZHJlc3M6ICcweDNhNmQ4Y0EyMUQxQ0Y3NkY2NTNBNjc1NzdGQTBEMjc0NTMzNTBkRDgnLFxyXG4gICAgICBmZWU6IDEwXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBuYW1lOiAndGhlbmEnLCAgICAgICAgICAgIC8vIFtIXVxyXG4gICAgICBjaGFpbjogJ2JzYycsXHJcbiAgICAgIGZhY3RvcnlBZGRyZXNzOiAnMHhBRkQ4OWQyMUJkQjY2ZDAwODE3ZDQxNTNFMDU1ODMwQjFjMkIzOTcwJyxcclxuICAgICAgcm91dGVyQWRkcmVzczogJzB4MjBhMzA0YTdkMTI2NzU4ZGZlNkIyNDNEMGZjNTE1RjgzYkNBODQzMScsXHJcbiAgICAgIGZlZTogMjBcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIG5hbWU6ICdhcGVzd2FwJywgICAgICAgICAgLy8gW0hdXHJcbiAgICAgIGNoYWluOiAnYnNjJyxcclxuICAgICAgZmFjdG9yeUFkZHJlc3M6ICcweDA4NDFCRDBCNzM0RTRGNTg1M2YwZEQ4ZDdFYTA0MWMyNDFmYjBEYTYnLFxyXG4gICAgICByb3V0ZXJBZGRyZXNzOiAnMHhjRjBmZUJkM2YxN0NFZjViNDdiMGNEMjU3YUNmNjAyNWM1QkZmM2I3JyxcclxuICAgICAgZmVlOiAyMFxyXG4gICAgfVxyXG4gIF0sXHJcbiAgLy8gQmFzZTogNSBERVhzIChmYXN0ZXN0IGdyb3dpbmcpXHJcbiAgYmFzZTogW1xyXG4gICAge1xyXG4gICAgICBuYW1lOiAndW5pc3dhcF92MycsICAgICAgIC8vIFtDXVxyXG4gICAgICBjaGFpbjogJ2Jhc2UnLFxyXG4gICAgICBmYWN0b3J5QWRkcmVzczogJzB4MzMxMjhhOGZDMTc4Njk4OTdkY0U2OEVkMDI2ZDY5NDYyMWY2RmRGRCcsXHJcbiAgICAgIHJvdXRlckFkZHJlc3M6ICcweDI2MjY2NjRjMjYwMzMzNkU1N0IyNzFjNUMwYjI2RjQyMTc0MWU0ODEnLFxyXG4gICAgICBmZWU6IDMwXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBuYW1lOiAnYWVyb2Ryb21lJywgICAgICAgIC8vIFtDXVxyXG4gICAgICBjaGFpbjogJ2Jhc2UnLFxyXG4gICAgICBmYWN0b3J5QWRkcmVzczogJzB4NDIwREQzODFiMzFhRWY2NjgzZGI2QjkwMjA4NGNCMEZGRUNlNDBEYScsXHJcbiAgICAgIHJvdXRlckFkZHJlc3M6ICcweGNGNzdhM0JhOUE1Q0EzOTlCN2M5N2M3NGQ1NGU1YjFCZWI4NzRFNDMnLFxyXG4gICAgICBmZWU6IDMwXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBuYW1lOiAnYmFzZXN3YXAnLCAgICAgICAgIC8vIFtDXVxyXG4gICAgICBjaGFpbjogJ2Jhc2UnLFxyXG4gICAgICBmYWN0b3J5QWRkcmVzczogJzB4RkRhNjE5YjZkMjA5NzViZTgwQTEwMzMyY0QzOWI5YTRiMEZBYThCQicsXHJcbiAgICAgIHJvdXRlckFkZHJlc3M6ICcweDMyN0RmMUU2ZGUwNTg5NWQyYWIwODUxM2FhREQ5MzEzRmU1MDVkODYnLFxyXG4gICAgICBmZWU6IDMwXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBuYW1lOiAnc3VzaGlzd2FwJywgICAgICAgIC8vIFtIXVxyXG4gICAgICBjaGFpbjogJ2Jhc2UnLFxyXG4gICAgICBmYWN0b3J5QWRkcmVzczogJzB4NzE1MjRCNGY5M2M1OGZjYkY2NTk3ODMyODRFMzg4MjVmMDYyMjg1OScsXHJcbiAgICAgIHJvdXRlckFkZHJlc3M6ICcweDZCREVENDJjNkRBOEZCZjBkMmJBNTVCMmZhMTIwQzVlMGM4RDc4OTEnLFxyXG4gICAgICBmZWU6IDMwXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBuYW1lOiAnc3dhcGJhc2VkJywgICAgICAgIC8vIFtNXVxyXG4gICAgICBjaGFpbjogJ2Jhc2UnLFxyXG4gICAgICBmYWN0b3J5QWRkcmVzczogJzB4MDRDOWYxMThkMjFlOEI3NjdEMmU1MEM5NDZmMGNDOUY2QzM2NzMwMCcsXHJcbiAgICAgIHJvdXRlckFkZHJlc3M6ICcweGFhYTNiMUYxYmQ3QkNjOTdmRDE5MTdjMThBREU2NjVDNUQzMUYwNjYnLFxyXG4gICAgICBmZWU6IDMwXHJcbiAgICB9XHJcbiAgXSxcclxuICAvLyBQb2x5Z29uOiA0IERFWHMgKGxvdyBnYXMpXHJcbiAgcG9seWdvbjogW1xyXG4gICAge1xyXG4gICAgICBuYW1lOiAndW5pc3dhcF92MycsICAgICAgIC8vIFtDXVxyXG4gICAgICBjaGFpbjogJ3BvbHlnb24nLFxyXG4gICAgICBmYWN0b3J5QWRkcmVzczogJzB4MUY5ODQzMWM4YUQ5ODUyMzYzMUFFNGE1OWYyNjczNDZlYTMxRjk4NCcsXHJcbiAgICAgIHJvdXRlckFkZHJlc3M6ICcweEU1OTI0MjdBMEFFY2U5MkRlM0VkZWUxRjE4RTAxNTdDMDU4NjE1NjQnLFxyXG4gICAgICBmZWU6IDMwXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBuYW1lOiAncXVpY2tzd2FwX3YzJywgICAgIC8vIFtDXVxyXG4gICAgICBjaGFpbjogJ3BvbHlnb24nLFxyXG4gICAgICBmYWN0b3J5QWRkcmVzczogJzB4NDExYjBmQWNDMzQ4OTY5MWYyOGFkNThjNDcwMDZBRjVFM0FiM0EyOCcsXHJcbiAgICAgIHJvdXRlckFkZHJlc3M6ICcweGY1YjUwOWJCMDkwOWE2OUIxYzIwN0U0OTVmNjg3YTU5NkMxNjhFMTInLFxyXG4gICAgICBmZWU6IDMwXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBuYW1lOiAnc3VzaGlzd2FwJywgICAgICAgIC8vIFtIXVxyXG4gICAgICBjaGFpbjogJ3BvbHlnb24nLFxyXG4gICAgICBmYWN0b3J5QWRkcmVzczogJzB4YzM1REFEQjY1MDEyZUM1Nzk2NTM2YkQ5ODY0ZUQ4NzczYUJjNzRDNCcsXHJcbiAgICAgIHJvdXRlckFkZHJlc3M6ICcweDFiMDJkQThDYjBkMDk3ZUI4RDU3QTE3NWI4OGM3RDhiNDc5OTc1MDYnLFxyXG4gICAgICBmZWU6IDMwXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBuYW1lOiAnYXBlc3dhcCcsICAgICAgICAgIC8vIFtNXVxyXG4gICAgICBjaGFpbjogJ3BvbHlnb24nLFxyXG4gICAgICBmYWN0b3J5QWRkcmVzczogJzB4Q2YwODNCZTQxNjQ4MjhmMDBjQUU3MDRFQzE1YTM2RDcxMTQ5MTI4NCcsXHJcbiAgICAgIHJvdXRlckFkZHJlc3M6ICcweEMwNzg4QTNhRDQzZDc5YWE1M0IwOWMyRWFDYzMxM0E3ODdkMWQ2MDcnLFxyXG4gICAgICBmZWU6IDIwXHJcbiAgICB9XHJcbiAgXSxcclxuICAvLyBPcHRpbWlzbTogMyBERVhzIChORVcgLSBQaGFzZSAxKVxyXG4gIG9wdGltaXNtOiBbXHJcbiAgICB7XHJcbiAgICAgIG5hbWU6ICd1bmlzd2FwX3YzJywgICAgICAgLy8gW0NdXHJcbiAgICAgIGNoYWluOiAnb3B0aW1pc20nLFxyXG4gICAgICBmYWN0b3J5QWRkcmVzczogJzB4MUY5ODQzMWM4YUQ5ODUyMzYzMUFFNGE1OWYyNjczNDZlYTMxRjk4NCcsXHJcbiAgICAgIHJvdXRlckFkZHJlc3M6ICcweEU1OTI0MjdBMEFFY2U5MkRlM0VkZWUxRjE4RTAxNTdDMDU4NjE1NjQnLFxyXG4gICAgICBmZWU6IDMwXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBuYW1lOiAndmVsb2Ryb21lJywgICAgICAgIC8vIFtDXVxyXG4gICAgICBjaGFpbjogJ29wdGltaXNtJyxcclxuICAgICAgZmFjdG9yeUFkZHJlc3M6ICcweDI1Q2JkRGI5OGIzNWFiMUZGNzc0MTM0NTZCMzFFQzgxQTZCNkI3NDYnLFxyXG4gICAgICByb3V0ZXJBZGRyZXNzOiAnMHhhMDYyYUU4QTljNWUxMWFhQTAyNmZjMjY3MEIwRDY1Y0NjOEIyODU4JyxcclxuICAgICAgZmVlOiAzMFxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgbmFtZTogJ3N1c2hpc3dhcCcsICAgICAgICAvLyBbSF1cclxuICAgICAgY2hhaW46ICdvcHRpbWlzbScsXHJcbiAgICAgIGZhY3RvcnlBZGRyZXNzOiAnMHhGYmMxMjk4NDY4OWU1ZjE1NjI2QmFkMDNBZDYwMTYwRmU5OEIzMDNDJyxcclxuICAgICAgcm91dGVyQWRkcmVzczogJzB4NEM1RDUyMzRmMjMyQkQyRDc2Qjk2YUEzM0Y1QUU0RkNGMEU0QkZBYicsXHJcbiAgICAgIGZlZTogMzBcclxuICAgIH1cclxuICBdLFxyXG4gIC8vIEV0aGVyZXVtOiAyIERFWHMgKHNlbGVjdGl2ZSAtIGxhcmdlIGFyYnMgb25seSlcclxuICBldGhlcmV1bTogW1xyXG4gICAge1xyXG4gICAgICBuYW1lOiAndW5pc3dhcF92MycsICAgICAgIC8vIFtDXVxyXG4gICAgICBjaGFpbjogJ2V0aGVyZXVtJyxcclxuICAgICAgZmFjdG9yeUFkZHJlc3M6ICcweDFGOTg0MzFjOGFEOTg1MjM2MzFBRTRhNTlmMjY3MzQ2ZWEzMUY5ODQnLFxyXG4gICAgICByb3V0ZXJBZGRyZXNzOiAnMHhFNTkyNDI3QTBBRWNlOTJEZTNFZGVlMUYxOEUwMTU3QzA1ODYxNTY0JyxcclxuICAgICAgZmVlOiAzMFxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgbmFtZTogJ3N1c2hpc3dhcCcsICAgICAgICAvLyBbQ11cclxuICAgICAgY2hhaW46ICdldGhlcmV1bScsXHJcbiAgICAgIGZhY3RvcnlBZGRyZXNzOiAnMHhDMEFFZTQ3OGUzNjU4ZTI2MTBjNUY3QTRBMkUxNzc3Y0U5ZTRmMkFjJyxcclxuICAgICAgcm91dGVyQWRkcmVzczogJzB4ZDllMWNFMTdmMjY0MWYyNGFFODM2MzdhYjY2YTJjY2E5QzM3OEI5RicsXHJcbiAgICAgIGZlZTogMzBcclxuICAgIH1cclxuICBdXHJcbn07XHJcblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4vLyBUT0tFTiBDT05GSUdVUkFUSU9OUyAtIFBoYXNlIDE6IDYwIFRva2Vuc1xyXG4vLyBDYXRlZ29yaWVzOiBBbmNob3IgKG5hdGl2ZSwgc3RhYmxlcyksIENvcmUgRGVGaSwgQ2hhaW4gR292ZXJuYW5jZSwgSGlnaC1Wb2x1bWVcclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuZXhwb3J0IGNvbnN0IENPUkVfVE9LRU5TOiBSZWNvcmQ8c3RyaW5nLCBUb2tlbltdPiA9IHtcclxuICAvLyBBcmJpdHJ1bTogMTIgdG9rZW5zXHJcbiAgYXJiaXRydW06IFtcclxuICAgIC8vIEFuY2hvciB0b2tlbnNcclxuICAgIHsgYWRkcmVzczogJzB4ODJhRjQ5NDQ3RDhhMDdlM2JkOTVCRDBkNTZmMzUyNDE1MjNmQmFiMScsIHN5bWJvbDogJ1dFVEgnLCBkZWNpbWFsczogMTgsIGNoYWluSWQ6IDQyMTYxIH0sXHJcbiAgICB7IGFkZHJlc3M6ICcweEZkMDg2YkM3Q0Q1QzQ4MURDQzlDODVlYkU0NzhBMUMwYjY5RkNiYjknLCBzeW1ib2w6ICdVU0RUJywgZGVjaW1hbHM6IDYsIGNoYWluSWQ6IDQyMTYxIH0sXHJcbiAgICB7IGFkZHJlc3M6ICcweGFmODhkMDY1ZTc3YzhjQzIyMzkzMjdDNUVEYjNBNDMyMjY4ZTU4MzEnLCBzeW1ib2w6ICdVU0RDJywgZGVjaW1hbHM6IDYsIGNoYWluSWQ6IDQyMTYxIH0sXHJcbiAgICB7IGFkZHJlc3M6ICcweERBMTAwMDljQmQ1RDA3ZGQwQ2VDYzY2MTYxRkM5M0Q3YzkwMDBkYTEnLCBzeW1ib2w6ICdEQUknLCBkZWNpbWFsczogMTgsIGNoYWluSWQ6IDQyMTYxIH0sXHJcbiAgICB7IGFkZHJlc3M6ICcweDJmMmEyNTQzQjc2QTQxNjY1NDlGN2FhQjJlNzVCZWYwYWVmQzVCMGYnLCBzeW1ib2w6ICdXQlRDJywgZGVjaW1hbHM6IDgsIGNoYWluSWQ6IDQyMTYxIH0sXHJcbiAgICAvLyBDaGFpbiBnb3Zlcm5hbmNlXHJcbiAgICB7IGFkZHJlc3M6ICcweDkxMkNFNTkxNDQxOTFDMTIwNEU2NDU1OUZFODI1M2EwZTQ5RTY1NDgnLCBzeW1ib2w6ICdBUkInLCBkZWNpbWFsczogMTgsIGNoYWluSWQ6IDQyMTYxIH0sXHJcbiAgICAvLyBDb3JlIERlRmlcclxuICAgIHsgYWRkcmVzczogJzB4RmE3Rjg5ODBiMGYxRTY0QTIwNjI3OTFjYzNiMDg3MTU3MmYxRjdmMCcsIHN5bWJvbDogJ1VOSScsIGRlY2ltYWxzOiAxOCwgY2hhaW5JZDogNDIxNjEgfSxcclxuICAgIHsgYWRkcmVzczogJzB4Zjk3ZjRkZjc1MTE3YTc4YzFBNWEwREJiODE0QWY5MjQ1ODUzOUZCNCcsIHN5bWJvbDogJ0xJTksnLCBkZWNpbWFsczogMTgsIGNoYWluSWQ6IDQyMTYxIH0sXHJcbiAgICB7IGFkZHJlc3M6ICcweDZDMkMwNjc5MGIzRTNFM2MzOGUxMkVlMjJGODE4M2IzN2ExM0VFNTUnLCBzeW1ib2w6ICdEUFgnLCBkZWNpbWFsczogMTgsIGNoYWluSWQ6IDQyMTYxIH0sXHJcbiAgICB7IGFkZHJlc3M6ICcweDUzOWJkRTBkN0RiZDMzNmI3OTE0OEFBNzQyODgzMTk4QkJGNjAzNDInLCBzeW1ib2w6ICdNQUdJQycsIGRlY2ltYWxzOiAxOCwgY2hhaW5JZDogNDIxNjEgfSxcclxuICAgIC8vIEhpZ2gtdm9sdW1lXHJcbiAgICB7IGFkZHJlc3M6ICcweGZjNUExQTZFQjA3NmEyQzdhRDA2ZUQyMkM5MGQ3RTcxMEUzNWFkMGEnLCBzeW1ib2w6ICdHTVgnLCBkZWNpbWFsczogMTgsIGNoYWluSWQ6IDQyMTYxIH0sXHJcbiAgICB7IGFkZHJlc3M6ICcweDU5NzlEN2I1NDZFMzhFNDE0RjdFOTgyMjUxNGJlNDQzQTQ4MDA1MjknLCBzeW1ib2w6ICd3c3RFVEgnLCBkZWNpbWFsczogMTgsIGNoYWluSWQ6IDQyMTYxIH1cclxuICBdLFxyXG4gIC8vIEJTQzogMTAgdG9rZW5zXHJcbiAgYnNjOiBbXHJcbiAgICAvLyBBbmNob3IgdG9rZW5zXHJcbiAgICB7IGFkZHJlc3M6ICcweGJiNENkQjlDQmQzNkIwMWJEMWNCYUVCRjJEZTA4ZDkxNzNiYzA5NWMnLCBzeW1ib2w6ICdXQk5CJywgZGVjaW1hbHM6IDE4LCBjaGFpbklkOiA1NiB9LFxyXG4gICAgeyBhZGRyZXNzOiAnMHg1NWQzOTgzMjZmOTkwNTlmRjc3NTQ4NTI0Njk5OTAyN0IzMTk3OTU1Jywgc3ltYm9sOiAnVVNEVCcsIGRlY2ltYWxzOiAxOCwgY2hhaW5JZDogNTYgfSxcclxuICAgIHsgYWRkcmVzczogJzB4OEFDNzZhNTFjYzk1MGQ5ODIyRDY4YjgzZkUxQWQ5N0IzMkNkNTgwZCcsIHN5bWJvbDogJ1VTREMnLCBkZWNpbWFsczogMTgsIGNoYWluSWQ6IDU2IH0sXHJcbiAgICB7IGFkZHJlc3M6ICcweGU5ZTdDRUEzRGVkY0E1OTg0NzgwQmFmYzU5OWJENjlBRGQwODdENTYnLCBzeW1ib2w6ICdCVVNEJywgZGVjaW1hbHM6IDE4LCBjaGFpbklkOiA1NiB9LFxyXG4gICAgeyBhZGRyZXNzOiAnMHg3MTMwZDJBMTJCOUJDYkZBZTRmMjYzNGQ4NjRBMUVlMUNlM0VhZDljJywgc3ltYm9sOiAnQlRDQicsIGRlY2ltYWxzOiAxOCwgY2hhaW5JZDogNTYgfSxcclxuICAgIC8vIEJyaWRnZWQgRVRIXHJcbiAgICB7IGFkZHJlc3M6ICcweDIxNzBFZDA4ODBhYzlBNzU1ZmQyOUIyNjg4OTU2QkQ5NTlGOTMzRjgnLCBzeW1ib2w6ICdFVEgnLCBkZWNpbWFsczogMTgsIGNoYWluSWQ6IDU2IH0sXHJcbiAgICAvLyBDb3JlIERlRmlcclxuICAgIHsgYWRkcmVzczogJzB4MEUwOUZhQkI3M0JkM0FkZTBhMTdFQ0MzMjFmRDEzYTE5ZTgxY0U4MicsIHN5bWJvbDogJ0NBS0UnLCBkZWNpbWFsczogMTgsIGNoYWluSWQ6IDU2IH0sXHJcbiAgICB7IGFkZHJlc3M6ICcweEY4QTBCRjljRjU0QmI5MkYxNzM3NGQ5ZTlBMzIxRTZhMTExYTUxYkQnLCBzeW1ib2w6ICdMSU5LJywgZGVjaW1hbHM6IDE4LCBjaGFpbklkOiA1NiB9LFxyXG4gICAgLy8gSGlnaC12b2x1bWVcclxuICAgIHsgYWRkcmVzczogJzB4MUQyRjBkYTE2OWNlQjlmQzdCMzE0NDYyOGRCMTU2ZjNGNmM2MGRCRScsIHN5bWJvbDogJ1hSUCcsIGRlY2ltYWxzOiAxOCwgY2hhaW5JZDogNTYgfSxcclxuICAgIHsgYWRkcmVzczogJzB4M0VFMjIwMEVmYjM0MDBmQWJCOUFhY0YzMTI5N2NCZEQxZDQzNUQ0NycsIHN5bWJvbDogJ0FEQScsIGRlY2ltYWxzOiAxOCwgY2hhaW5JZDogNTYgfVxyXG4gIF0sXHJcbiAgLy8gQmFzZTogMTAgdG9rZW5zXHJcbiAgYmFzZTogW1xyXG4gICAgLy8gQW5jaG9yIHRva2Vuc1xyXG4gICAgeyBhZGRyZXNzOiAnMHg0MjAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA2Jywgc3ltYm9sOiAnV0VUSCcsIGRlY2ltYWxzOiAxOCwgY2hhaW5JZDogODQ1MyB9LFxyXG4gICAgeyBhZGRyZXNzOiAnMHg4MzM1ODlmQ0Q2ZURiNkUwOGY0YzdDMzJENGY3MWI1NGJkQTAyOTEzJywgc3ltYm9sOiAnVVNEQycsIGRlY2ltYWxzOiA2LCBjaGFpbklkOiA4NDUzIH0sXHJcbiAgICB7IGFkZHJlc3M6ICcweDUwYzU3MjU5NDlBNkYwYzcyRTZDNGE2NDFGMjQwNDlBOTE3REIwQ2InLCBzeW1ib2w6ICdEQUknLCBkZWNpbWFsczogMTgsIGNoYWluSWQ6IDg0NTMgfSxcclxuICAgIC8vIEJyaWRnZWQgQlRDXHJcbiAgICB7IGFkZHJlc3M6ICcweDIzNmFhNTA5NzlENWYzRGUzQmQxRWViNDBFODExMzdGMjJhYjc5NGInLCBzeW1ib2w6ICd0QlRDJywgZGVjaW1hbHM6IDE4LCBjaGFpbklkOiA4NDUzIH0sXHJcbiAgICAvLyBMU1QgdG9rZW5zXHJcbiAgICB7IGFkZHJlc3M6ICcweGMxQ0JhM2ZDZWEzNDRmOTJEOTIzOWMwOEMwNTY4ZjZGMkYwZWU0NTInLCBzeW1ib2w6ICd3c3RFVEgnLCBkZWNpbWFsczogMTgsIGNoYWluSWQ6IDg0NTMgfSxcclxuICAgIHsgYWRkcmVzczogJzB4MkFlM0YxRWM3RjFGNTAxMkNGRWFiMDE4NWJmYzdhYTNjZjBERWMyMicsIHN5bWJvbDogJ2NiRVRIJywgZGVjaW1hbHM6IDE4LCBjaGFpbklkOiA4NDUzIH0sXHJcbiAgICAvLyBDb3JlIERlRmlcclxuICAgIHsgYWRkcmVzczogJzB4OTQwMTgxYTk0QTM1QTQ1NjlFNDUyOUEzQ0RmQjc0ZTM4RkQ5ODYzMScsIHN5bWJvbDogJ0FFUk8nLCBkZWNpbWFsczogMTgsIGNoYWluSWQ6IDg0NTMgfSxcclxuICAgIC8vIEhpZ2gtdm9sdW1lIG1lbWVcclxuICAgIHsgYWRkcmVzczogJzB4NTMyZjI3MTAxOTY1ZGQxNjQ0MkU1OWQ0MDY3MEZhRjVlQkIxNDJFNCcsIHN5bWJvbDogJ0JSRVRUJywgZGVjaW1hbHM6IDE4LCBjaGFpbklkOiA4NDUzIH0sXHJcbiAgICB7IGFkZHJlc3M6ICcweEFDMUJkMjQ4NmFBZjNCNUMwZmMzRmQ4Njg1NThiMDgyYTUzMUIyQjQnLCBzeW1ib2w6ICdUT1NISScsIGRlY2ltYWxzOiAxOCwgY2hhaW5JZDogODQ1MyB9LFxyXG4gICAgeyBhZGRyZXNzOiAnMHgwYjNlMzI4NDU1YzQwNTlFRWI5ZTNmODRiNTU0M0Y3NEUyNGU3RTFiJywgc3ltYm9sOiAnVklSVFVBTCcsIGRlY2ltYWxzOiAxOCwgY2hhaW5JZDogODQ1MyB9XHJcbiAgXSxcclxuICAvLyBQb2x5Z29uOiAxMCB0b2tlbnNcclxuICBwb2x5Z29uOiBbXHJcbiAgICAvLyBBbmNob3IgdG9rZW5zXHJcbiAgICB7IGFkZHJlc3M6ICcweDBkNTAwQjFkOEU4ZUYzMUUyMUM5OWQxRGI5QTY0NDRkM0FEZjEyNzAnLCBzeW1ib2w6ICdXTUFUSUMnLCBkZWNpbWFsczogMTgsIGNoYWluSWQ6IDEzNyB9LFxyXG4gICAgeyBhZGRyZXNzOiAnMHhjMjEzMkQwNUQzMWM5MTRhODdDNjYxMUMxMDc0OEFFYjA0QjU4ZThGJywgc3ltYm9sOiAnVVNEVCcsIGRlY2ltYWxzOiA2LCBjaGFpbklkOiAxMzcgfSxcclxuICAgIHsgYWRkcmVzczogJzB4M2M0OTljNTQyY0VGNUUzODExZTExOTJjZTcwZDhjQzAzZDVjMzM1OScsIHN5bWJvbDogJ1VTREMnLCBkZWNpbWFsczogNiwgY2hhaW5JZDogMTM3IH0sXHJcbiAgICB7IGFkZHJlc3M6ICcweDhmM0NmN2FkMjNDZDNDYURiRDk3MzVBRmY5NTgwMjMyMzljNkEwNjMnLCBzeW1ib2w6ICdEQUknLCBkZWNpbWFsczogMTgsIGNoYWluSWQ6IDEzNyB9LFxyXG4gICAgeyBhZGRyZXNzOiAnMHgxQkZENjcwMzdCNDJDZjczYWNGMjA0NzA2N2JkNEYyQzQ3RDlCZkQ2Jywgc3ltYm9sOiAnV0JUQycsIGRlY2ltYWxzOiA4LCBjaGFpbklkOiAxMzcgfSxcclxuICAgIC8vIEJyaWRnZWQgRVRIXHJcbiAgICB7IGFkZHJlc3M6ICcweDdjZUIyM2ZENmJDMGFkRDU5RTYyYWMyNTU3ODI3MGNGZjFiOWY2MTknLCBzeW1ib2w6ICdXRVRIJywgZGVjaW1hbHM6IDE4LCBjaGFpbklkOiAxMzcgfSxcclxuICAgIC8vIENvcmUgRGVGaVxyXG4gICAgeyBhZGRyZXNzOiAnMHg1M0UwYmNhMzVlQzM1NkJENWRkREZlYmJEMUZjMGZEMDNGYUJhZDM5Jywgc3ltYm9sOiAnTElOSycsIGRlY2ltYWxzOiAxOCwgY2hhaW5JZDogMTM3IH0sXHJcbiAgICB7IGFkZHJlc3M6ICcweEQ2REY5MzJBNDVDMGYyNTVmODUxNDVmMjg2ZUEwYjI5MkIyMUM5MEInLCBzeW1ib2w6ICdBQVZFJywgZGVjaW1hbHM6IDE4LCBjaGFpbklkOiAxMzcgfSxcclxuICAgIC8vIEhpZ2gtdm9sdW1lXHJcbiAgICB7IGFkZHJlc3M6ICcweDJDODliYmM5MkJEODZGODA3NWQxREVjYzU4QzdGNEUwMTA3ZjI4NmInLCBzeW1ib2w6ICdBVkFYJywgZGVjaW1hbHM6IDE4LCBjaGFpbklkOiAxMzcgfSxcclxuICAgIHsgYWRkcmVzczogJzB4QjBCMTk1YUVGQTM2NTBBNjkwOGYxNUNkYUM3RDkyRjhhNTc5MUIwQicsIHN5bWJvbDogJ0JPQicsIGRlY2ltYWxzOiAxOCwgY2hhaW5JZDogMTM3IH1cclxuICBdLFxyXG4gIC8vIE9wdGltaXNtOiAxMCB0b2tlbnMgKE5FVyAtIFBoYXNlIDEpXHJcbiAgb3B0aW1pc206IFtcclxuICAgIC8vIEFuY2hvciB0b2tlbnNcclxuICAgIHsgYWRkcmVzczogJzB4NDIwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwNicsIHN5bWJvbDogJ1dFVEgnLCBkZWNpbWFsczogMTgsIGNoYWluSWQ6IDEwIH0sXHJcbiAgICB7IGFkZHJlc3M6ICcweDk0YjAwOGFBMDA1NzljMTMwN0IwRUYyYzQ5OWFEOThhOGNlNThlNTgnLCBzeW1ib2w6ICdVU0RUJywgZGVjaW1hbHM6IDYsIGNoYWluSWQ6IDEwIH0sXHJcbiAgICB7IGFkZHJlc3M6ICcweDBiMkM2MzljNTMzODEzZjRBYTlENzgzN0NBZjYyNjUzZDA5N0ZmODUnLCBzeW1ib2w6ICdVU0RDJywgZGVjaW1hbHM6IDYsIGNoYWluSWQ6IDEwIH0sXHJcbiAgICB7IGFkZHJlc3M6ICcweERBMTAwMDljQmQ1RDA3ZGQwQ2VDYzY2MTYxRkM5M0Q3YzkwMDBkYTEnLCBzeW1ib2w6ICdEQUknLCBkZWNpbWFsczogMTgsIGNoYWluSWQ6IDEwIH0sXHJcbiAgICB7IGFkZHJlc3M6ICcweDY4ZjE4MGZjQ2U2ODM2Njg4ZTkwODRmMDM1MzA5RTI5QmYwQTIwOTUnLCBzeW1ib2w6ICdXQlRDJywgZGVjaW1hbHM6IDgsIGNoYWluSWQ6IDEwIH0sXHJcbiAgICAvLyBDaGFpbiBnb3Zlcm5hbmNlXHJcbiAgICB7IGFkZHJlc3M6ICcweDQyMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwNDInLCBzeW1ib2w6ICdPUCcsIGRlY2ltYWxzOiAxOCwgY2hhaW5JZDogMTAgfSxcclxuICAgIC8vIExTVCB0b2tlbnNcclxuICAgIHsgYWRkcmVzczogJzB4MUYzMmIxYzIzNDU1MzhjMGM2ZjU4MmZDQjAyMjczOWM0QTE5NEViYicsIHN5bWJvbDogJ3dzdEVUSCcsIGRlY2ltYWxzOiAxOCwgY2hhaW5JZDogMTAgfSxcclxuICAgIC8vIENvcmUgRGVGaVxyXG4gICAgeyBhZGRyZXNzOiAnMHgzNTBhNzkxQmZjMkMyMUY5RWQ1ZDEwOTgwRGFkMmUyNjM4ZmZhN2Y2Jywgc3ltYm9sOiAnTElOSycsIGRlY2ltYWxzOiAxOCwgY2hhaW5JZDogMTAgfSxcclxuICAgIHsgYWRkcmVzczogJzB4OWUxMDI4RjVGMUQ1ZURFNTk3NDhGRmNlRTU1MzI1MDk5NzY4NDBFMCcsIHN5bWJvbDogJ1BFUlAnLCBkZWNpbWFsczogMTgsIGNoYWluSWQ6IDEwIH0sXHJcbiAgICB7IGFkZHJlc3M6ICcweDNjOEI2NTAyNTdjRmI1ZjI3MmY3OTlGNWUyYjRlNjUwOTNhMTFhMDUnLCBzeW1ib2w6ICdWRUxPJywgZGVjaW1hbHM6IDE4LCBjaGFpbklkOiAxMCB9XHJcbiAgXSxcclxuICAvLyBFdGhlcmV1bTogOCB0b2tlbnMgKHNlbGVjdGl2ZSAtIGxhcmdlIGFyYnMgb25seSlcclxuICBldGhlcmV1bTogW1xyXG4gICAgLy8gQW5jaG9yIHRva2Vuc1xyXG4gICAgeyBhZGRyZXNzOiAnMHhDMDJhYUEzOWIyMjNGRThEMEEwZTVDNEYyN2VBRDkwODNDNzU2Q2MyJywgc3ltYm9sOiAnV0VUSCcsIGRlY2ltYWxzOiAxOCwgY2hhaW5JZDogMSB9LFxyXG4gICAgeyBhZGRyZXNzOiAnMHhkQUMxN0Y5NThEMmVlNTIzYTIyMDYyMDY5OTQ1OTdDMTNEODMxZWM3Jywgc3ltYm9sOiAnVVNEVCcsIGRlY2ltYWxzOiA2LCBjaGFpbklkOiAxIH0sXHJcbiAgICB7IGFkZHJlc3M6ICcweEEwYjg2OTkxYzYyMThiMzZjMWQxOUQ0YTJlOUViMGNFMzYwNmVCNDgnLCBzeW1ib2w6ICdVU0RDJywgZGVjaW1hbHM6IDYsIGNoYWluSWQ6IDEgfSxcclxuICAgIHsgYWRkcmVzczogJzB4MjI2MEZBQzVFNTU0MmE3NzNBYTQ0ZkJDZmVEZjdDMTkzYmMyQzU5OScsIHN5bWJvbDogJ1dCVEMnLCBkZWNpbWFsczogOCwgY2hhaW5JZDogMSB9LFxyXG4gICAgLy8gTFNUIHRva2VucyAoaGlnaCB2b2x1bWUpXHJcbiAgICB7IGFkZHJlc3M6ICcweDdmMzlDNTgxRjU5NUI1M2M1Y2IxOWJEMGIzZjhkQTZjOTM1RTJDYTAnLCBzeW1ib2w6ICd3c3RFVEgnLCBkZWNpbWFsczogMTgsIGNoYWluSWQ6IDEgfSxcclxuICAgIHsgYWRkcmVzczogJzB4YWU3ODczNkNkNjE1ZjM3NEQzMDg1MTIzQTIxMDQ0OEU3NEZjNjM5MycsIHN5bWJvbDogJ3JFVEgnLCBkZWNpbWFsczogMTgsIGNoYWluSWQ6IDEgfSxcclxuICAgIC8vIENvcmUgRGVGaVxyXG4gICAgeyBhZGRyZXNzOiAnMHgxZjk4NDBhODVkNWFGNWJmMUQxNzYyRjkyNUJEQURkQzQyMDFGOTg0Jywgc3ltYm9sOiAnVU5JJywgZGVjaW1hbHM6IDE4LCBjaGFpbklkOiAxIH0sXHJcbiAgICB7IGFkZHJlc3M6ICcweDUxNDkxMDc3MUFGOUNhNjU2YWY4NDBkZmY4M0U4MjY0RWNGOTg2Q0EnLCBzeW1ib2w6ICdMSU5LJywgZGVjaW1hbHM6IDE4LCBjaGFpbklkOiAxIH1cclxuICBdXHJcbn07XHJcblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4vLyBTRVJWSUNFIENPTkZJR1VSQVRJT05TXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbmV4cG9ydCBjb25zdCBTRVJWSUNFX0NPTkZJR1MgPSB7XHJcbiAgcmVkaXM6IHtcclxuICAgIHVybDogcHJvY2Vzcy5lbnYuUkVESVNfVVJMIHx8ICdyZWRpczovL2xvY2FsaG9zdDo2Mzc5JyxcclxuICAgIHBhc3N3b3JkOiBwcm9jZXNzLmVudi5SRURJU19QQVNTV09SRFxyXG4gIH0sXHJcbiAgbW9uaXRvcmluZzoge1xyXG4gICAgZW5hYmxlZDogcHJvY2Vzcy5lbnYuTU9OSVRPUklOR19FTkFCTEVEID09PSAndHJ1ZScsXHJcbiAgICBpbnRlcnZhbDogcGFyc2VJbnQocHJvY2Vzcy5lbnYuTU9OSVRPUklOR19JTlRFUlZBTCB8fCAnMzAwMDAnKSxcclxuICAgIGVuZHBvaW50czogKHByb2Nlc3MuZW52Lk1PTklUT1JJTkdfRU5EUE9JTlRTIHx8ICcnKS5zcGxpdCgnLCcpXHJcbiAgfVxyXG59O1xyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuLy8gUEVSRk9STUFOQ0UgVEhSRVNIT0xEU1xyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5leHBvcnQgY29uc3QgUEVSRk9STUFOQ0VfVEhSRVNIT0xEUyA9IHtcclxuICBtYXhFdmVudExhdGVuY3k6IDUwLCAvLyBtcyAtIHRhcmdldCBmb3IgUGhhc2UgM1xyXG4gIG1pbkNhY2hlSGl0UmF0ZTogMC45LCAvLyA5MCVcclxuICBtYXhNZW1vcnlVc2FnZTogNDAwICogMTAyNCAqIDEwMjQsIC8vIDQwME1CXHJcbiAgbWF4Q3B1VXNhZ2U6IDgwLCAvLyAlXHJcbiAgbWF4RmFsc2VQb3NpdGl2ZVJhdGU6IDAuMDUgLy8gNSVcclxufTtcclxuXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbi8vIEFSQklUUkFHRSBERVRFQ1RJT04gUEFSQU1FVEVSU1xyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5leHBvcnQgY29uc3QgQVJCSVRSQUdFX0NPTkZJRyA9IHtcclxuICBtaW5Qcm9maXRQZXJjZW50YWdlOiAwLjAwMywgLy8gMC4zJVxyXG4gIG1heEdhc1ByaWNlOiA1MDAwMDAwMDAwMCwgLy8gNTAgZ3dlaVxyXG4gIGNvbmZpZGVuY2VUaHJlc2hvbGQ6IDAuNzUsXHJcbiAgbWF4VHJhZGVTaXplOiAnMTAwMDAwMDAwMDAwMDAwMDAwMCcsIC8vIDEgRVRIIGVxdWl2YWxlbnRcclxuICB0cmlhbmd1bGFyRW5hYmxlZDogdHJ1ZSxcclxuICBjcm9zc0NoYWluRW5hYmxlZDogZmFsc2UsIC8vIEVuYWJsZSBpbiBQaGFzZSAyXHJcbiAgcHJlZGljdGl2ZUVuYWJsZWQ6IGZhbHNlLCAvLyBFbmFibGUgaW4gUGhhc2UgM1xyXG4gIC8vIEFkZGl0aW9uYWwgY29uZmlnIHByb3BlcnRpZXMgZm9yIG9wcG9ydHVuaXR5IGNhbGN1bGF0aW9uXHJcbiAgZGVmYXVsdEFtb3VudDogMTAwMCwgLy8gRGVmYXVsdCB0cmFkZSBhbW91bnQgaW4gVVNEXHJcbiAgZXN0aW1hdGVkR2FzQ29zdDogNSwgLy8gRXN0aW1hdGVkIGdhcyBjb3N0IGluIFVTRFxyXG4gIG9wcG9ydHVuaXR5VGltZW91dE1zOiAzMDAwMCwgLy8gMzAgc2Vjb25kc1xyXG4gIG1pblByb2ZpdFRocmVzaG9sZDogMTAsIC8vIE1pbmltdW0gJDEwIG5ldCBwcm9maXRcclxuICBtaW5Db25maWRlbmNlVGhyZXNob2xkOiAwLjcsIC8vIE1pbmltdW0gNzAlIGNvbmZpZGVuY2VcclxuICBmZWVQZXJjZW50YWdlOiAwLjAwMywgLy8gMC4zJSBERVggdHJhZGluZyBmZWVcclxuICAvLyBDaGFpbi1zcGVjaWZpYyBtaW5pbXVtIHByb2ZpdHMgKGR1ZSB0byBnYXMgY29zdHMpXHJcbiAgY2hhaW5NaW5Qcm9maXRzOiB7XHJcbiAgICBldGhlcmV1bTogMC4wMDUsICAgLy8gMC41JSAtIGhpZ2hlciBkdWUgdG8gZ2FzXHJcbiAgICBhcmJpdHJ1bTogMC4wMDIsICAgLy8gMC4yJSAtIGxvdyBnYXNcclxuICAgIG9wdGltaXNtOiAwLjAwMiwgICAvLyAwLjIlIC0gbG93IGdhc1xyXG4gICAgYmFzZTogMC4wMDIsICAgICAgIC8vIDAuMiUgLSBsb3cgZ2FzXHJcbiAgICBwb2x5Z29uOiAwLjAwMiwgICAgLy8gMC4yJSAtIGxvdyBnYXNcclxuICAgIGJzYzogMC4wMDMgICAgICAgICAvLyAwLjMlIC0gbW9kZXJhdGUgZ2FzXHJcbiAgfVxyXG59O1xyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuLy8gRVZFTlQgTU9OSVRPUklORyBDT05GSUdVUkFUSU9OXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbmV4cG9ydCBjb25zdCBFVkVOVF9DT05GSUcgPSB7XHJcbiAgc3luY0V2ZW50czoge1xyXG4gICAgZW5hYmxlZDogdHJ1ZSxcclxuICAgIHByaW9yaXR5OiAnaGlnaCdcclxuICB9LFxyXG4gIHN3YXBFdmVudHM6IHtcclxuICAgIGVuYWJsZWQ6IHRydWUsXHJcbiAgICBwcmlvcml0eTogJ21lZGl1bScsXHJcbiAgICBtaW5BbW91bnRVU0Q6IDEwMDAwLCAgICAvLyAkMTBLIG1pbmltdW0gZm9yIHByb2Nlc3NpbmdcclxuICAgIHdoYWxlVGhyZXNob2xkOiA1MDAwMCwgIC8vICQ1MEsgZm9yIHdoYWxlIGFsZXJ0c1xyXG4gICAgc2FtcGxpbmdSYXRlOiAwLjAxICAgICAgLy8gMSUgc2FtcGxpbmcgZm9yIDwkMTBLIHN3YXBzXHJcbiAgfVxyXG59O1xyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuLy8gUEFSVElUSU9OIENPTkZJR1VSQVRJT05cclxuLy8gQWxpZ25zIHdpdGggQURSLTAwMyBhbmQgQURSLTAwOFxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5leHBvcnQgY29uc3QgUEFSVElUSU9OX0NPTkZJRyA9IHtcclxuICBQMV9BU0lBX0ZBU1Q6IFsnYnNjJywgJ3BvbHlnb24nXSwgICAgICAgICAgIC8vIFBoYXNlIDFcclxuICBQMl9MMl9UVVJCTzogWydhcmJpdHJ1bScsICdvcHRpbWlzbScsICdiYXNlJ10sIC8vIFBoYXNlIDFcclxuICBQM19ISUdIX1ZBTFVFOiBbJ2V0aGVyZXVtJ10sICAgICAgICAgICAgICAgICAvLyBQaGFzZSAxXHJcbiAgLy8gRnV0dXJlIHBoYXNlc1xyXG4gIFAxX0FTSUFfRkFTVF9QSEFTRTI6IFsnYnNjJywgJ3BvbHlnb24nLCAnYXZhbGFuY2hlJywgJ2ZhbnRvbSddLFxyXG4gIFAzX0hJR0hfVkFMVUVfUEhBU0UzOiBbJ2V0aGVyZXVtJywgJ3prc3luYycsICdsaW5lYSddXHJcbn07XHJcblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4vLyBQSEFTRSBNRVRSSUNTXHJcbi8vIFRyYWNrIHByb2dyZXNzIGFnYWluc3QgdGFyZ2V0cyBmcm9tIEFEUi0wMDhcclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuZXhwb3J0IGNvbnN0IFBIQVNFX01FVFJJQ1MgPSB7XHJcbiAgY3VycmVudDoge1xyXG4gICAgcGhhc2U6IDEsXHJcbiAgICBjaGFpbnM6IE9iamVjdC5rZXlzKENIQUlOUykubGVuZ3RoLFxyXG4gICAgZGV4ZXM6IE9iamVjdC52YWx1ZXMoREVYRVMpLmZsYXQoKS5sZW5ndGgsXHJcbiAgICB0b2tlbnM6IE9iamVjdC52YWx1ZXMoQ09SRV9UT0tFTlMpLmZsYXQoKS5sZW5ndGgsXHJcbiAgICB0YXJnZXRPcHBvcnR1bml0aWVzOiAzMDBcclxuICB9LFxyXG4gIHRhcmdldHM6IHtcclxuICAgIHBoYXNlMTogeyBjaGFpbnM6IDcsIGRleGVzOiAyNSwgdG9rZW5zOiA2MCwgb3Bwb3J0dW5pdGllczogMzAwIH0sXHJcbiAgICBwaGFzZTI6IHsgY2hhaW5zOiA5LCBkZXhlczogNDUsIHRva2VuczogMTEwLCBvcHBvcnR1bml0aWVzOiA1NTAgfSxcclxuICAgIHBoYXNlMzogeyBjaGFpbnM6IDEwLCBkZXhlczogNTUsIHRva2VuczogMTUwLCBvcHBvcnR1bml0aWVzOiA3ODAgfVxyXG4gIH1cclxufTtcclxuXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbi8vIFRPS0VOIE1FVEFEQVRBIC0gQ2hhaW4tc3BlY2lmaWMgdG9rZW4gYWRkcmVzc2VzIGFuZCBjYXRlZ29yaWVzXHJcbi8vIFVzZWQgZm9yIFVTRCB2YWx1ZSBlc3RpbWF0aW9uIGFuZCBwcmljZSBjYWxjdWxhdGlvbnNcclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuZXhwb3J0IGNvbnN0IFRPS0VOX01FVEFEQVRBOiBSZWNvcmQ8c3RyaW5nLCB7XHJcbiAgd2V0aDogc3RyaW5nO1xyXG4gIHN0YWJsZWNvaW5zOiB7IGFkZHJlc3M6IHN0cmluZzsgc3ltYm9sOiBzdHJpbmc7IGRlY2ltYWxzOiBudW1iZXIgfVtdO1xyXG4gIG5hdGl2ZVdyYXBwZXI6IHN0cmluZztcclxufT4gPSB7XHJcbiAgb3B0aW1pc206IHtcclxuICAgIHdldGg6ICcweDQyMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDYnLFxyXG4gICAgbmF0aXZlV3JhcHBlcjogJzB4NDIwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwNicsXHJcbiAgICBzdGFibGVjb2luczogW1xyXG4gICAgICB7IGFkZHJlc3M6ICcweDk0YjAwOGFBMDA1NzljMTMwN0IwRUYyYzQ5OWFEOThhOGNlNThlNTgnLCBzeW1ib2w6ICdVU0RUJywgZGVjaW1hbHM6IDYgfSxcclxuICAgICAgeyBhZGRyZXNzOiAnMHgwYjJDNjM5YzUzMzgxM2Y0QWE5RDc4MzdDQWY2MjY1M2QwOTdGZjg1Jywgc3ltYm9sOiAnVVNEQycsIGRlY2ltYWxzOiA2IH0sXHJcbiAgICAgIHsgYWRkcmVzczogJzB4REExMDAwOWNCZDVEMDdkZDBDZUNjNjYxNjFGQzkzRDdjOTAwMGRhMScsIHN5bWJvbDogJ0RBSScsIGRlY2ltYWxzOiAxOCB9XHJcbiAgICBdXHJcbiAgfSxcclxuICBhcmJpdHJ1bToge1xyXG4gICAgd2V0aDogJzB4ODJhRjQ5NDQ3RDhhMDdlM2JkOTVCRDBkNTZmMzUyNDE1MjNmQmFiMScsXHJcbiAgICBuYXRpdmVXcmFwcGVyOiAnMHg4MmFGNDk0NDdEOGEwN2UzYmQ5NUJEMGQ1NmYzNTI0MTUyM2ZCYWIxJyxcclxuICAgIHN0YWJsZWNvaW5zOiBbXHJcbiAgICAgIHsgYWRkcmVzczogJzB4RmQwODZiQzdDRDVDNDgxRENDOUM4NWViRTQ3OEExQzBiNjlGQ2JiOScsIHN5bWJvbDogJ1VTRFQnLCBkZWNpbWFsczogNiB9LFxyXG4gICAgICB7IGFkZHJlc3M6ICcweGFmODhkMDY1ZTc3YzhjQzIyMzkzMjdDNUVEYjNBNDMyMjY4ZTU4MzEnLCBzeW1ib2w6ICdVU0RDJywgZGVjaW1hbHM6IDYgfSxcclxuICAgICAgeyBhZGRyZXNzOiAnMHhEQTEwMDA5Y0JkNUQwN2RkMENlQ2M2NjE2MUZDOTNEN2M5MDAwZGExJywgc3ltYm9sOiAnREFJJywgZGVjaW1hbHM6IDE4IH1cclxuICAgIF1cclxuICB9LFxyXG4gIGJzYzoge1xyXG4gICAgd2V0aDogJzB4MjE3MEVkMDg4MGFjOUE3NTVmZDI5QjI2ODg5NTZCRDk1OUY5MzNGOCcsIC8vIEVUSCBvbiBCU0NcclxuICAgIG5hdGl2ZVdyYXBwZXI6ICcweGJiNENkQjlDQmQzNkIwMWJEMWNCYUVCRjJEZTA4ZDkxNzNiYzA5NWMnLCAvLyBXQk5CXHJcbiAgICBzdGFibGVjb2luczogW1xyXG4gICAgICB7IGFkZHJlc3M6ICcweDU1ZDM5ODMyNmY5OTA1OWZGNzc1NDg1MjQ2OTk5MDI3QjMxOTc5NTUnLCBzeW1ib2w6ICdVU0RUJywgZGVjaW1hbHM6IDE4IH0sXHJcbiAgICAgIHsgYWRkcmVzczogJzB4OEFDNzZhNTFjYzk1MGQ5ODIyRDY4YjgzZkUxQWQ5N0IzMkNkNTgwZCcsIHN5bWJvbDogJ1VTREMnLCBkZWNpbWFsczogMTggfSxcclxuICAgICAgeyBhZGRyZXNzOiAnMHhlOWU3Q0VBM0RlZGNBNTk4NDc4MEJhZmM1OTliRDY5QURkMDg3RDU2Jywgc3ltYm9sOiAnQlVTRCcsIGRlY2ltYWxzOiAxOCB9XHJcbiAgICBdXHJcbiAgfSxcclxuICBiYXNlOiB7XHJcbiAgICB3ZXRoOiAnMHg0MjAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA2JyxcclxuICAgIG5hdGl2ZVdyYXBwZXI6ICcweDQyMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDYnLFxyXG4gICAgc3RhYmxlY29pbnM6IFtcclxuICAgICAgeyBhZGRyZXNzOiAnMHg4MzM1ODlmQ0Q2ZURiNkUwOGY0YzdDMzJENGY3MWI1NGJkQTAyOTEzJywgc3ltYm9sOiAnVVNEQycsIGRlY2ltYWxzOiA2IH0sXHJcbiAgICAgIHsgYWRkcmVzczogJzB4NTBjNTcyNTk0OUE2RjBjNzJFNkM0YTY0MUYyNDA0OUE5MTdEQjBDYicsIHN5bWJvbDogJ0RBSScsIGRlY2ltYWxzOiAxOCB9XHJcbiAgICBdXHJcbiAgfSxcclxuICBwb2x5Z29uOiB7XHJcbiAgICB3ZXRoOiAnMHg3Y2VCMjNmRDZiQzBhZEQ1OUU2MmFjMjU1NzgyNzBjRmYxYjlmNjE5JyxcclxuICAgIG5hdGl2ZVdyYXBwZXI6ICcweDBkNTAwQjFkOEU4ZUYzMUUyMUM5OWQxRGI5QTY0NDRkM0FEZjEyNzAnLCAvLyBXTUFUSUNcclxuICAgIHN0YWJsZWNvaW5zOiBbXHJcbiAgICAgIHsgYWRkcmVzczogJzB4YzIxMzJEMDVEMzFjOTE0YTg3QzY2MTFDMTA3NDhBRWIwNEI1OGU4RicsIHN5bWJvbDogJ1VTRFQnLCBkZWNpbWFsczogNiB9LFxyXG4gICAgICB7IGFkZHJlc3M6ICcweDNjNDk5YzU0MmNFRjVFMzgxMWUxMTkyY2U3MGQ4Y0MwM2Q1YzMzNTknLCBzeW1ib2w6ICdVU0RDJywgZGVjaW1hbHM6IDYgfSxcclxuICAgICAgeyBhZGRyZXNzOiAnMHg4ZjNDZjdhZDIzQ2QzQ2FEYkQ5NzM1QUZmOTU4MDIzMjM5YzZBMDYzJywgc3ltYm9sOiAnREFJJywgZGVjaW1hbHM6IDE4IH1cclxuICAgIF1cclxuICB9LFxyXG4gIGV0aGVyZXVtOiB7XHJcbiAgICB3ZXRoOiAnMHhDMDJhYUEzOWIyMjNGRThEMEEwZTVDNEYyN2VBRDkwODNDNzU2Q2MyJyxcclxuICAgIG5hdGl2ZVdyYXBwZXI6ICcweEMwMmFhQTM5YjIyM0ZFOEQwQTBlNUM0RjI3ZUFEOTA4M0M3NTZDYzInLFxyXG4gICAgc3RhYmxlY29pbnM6IFtcclxuICAgICAgeyBhZGRyZXNzOiAnMHhkQUMxN0Y5NThEMmVlNTIzYTIyMDYyMDY5OTQ1OTdDMTNEODMxZWM3Jywgc3ltYm9sOiAnVVNEVCcsIGRlY2ltYWxzOiA2IH0sXHJcbiAgICAgIHsgYWRkcmVzczogJzB4QTBiODY5OTFjNjIxOGIzNmMxZDE5RDRhMmU5RWIwY0UzNjA2ZUI0OCcsIHN5bWJvbDogJ1VTREMnLCBkZWNpbWFsczogNiB9XHJcbiAgICBdXHJcbiAgfVxyXG59O1xyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuLy8gRVZFTlQgU0lHTkFUVVJFUyAtIFByZS1jb21wdXRlZCBmb3IgcGVyZm9ybWFuY2VcclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuZXhwb3J0IGNvbnN0IEVWRU5UX1NJR05BVFVSRVMgPSB7XHJcbiAgLy8gVW5pc3dhcCBWMiAvIFN1c2hpU3dhcCBzdHlsZVxyXG4gIFNZTkM6ICcweDFjNDExZTlhOTZlMDcxMjQxYzJmMjFmNzcyNmIxN2FlODllM2NhYjRjNzhiZTUwZTA2MmIwM2E5ZmZmYmJhZDEnLFxyXG4gIFNXQVBfVjI6ICcweGQ3OGFkOTVmYTQ2Yzk5NGI2NTUxZDBkYTg1ZmMyNzVmZTYxM2NlMzc2NTdmYjhkNWUzZDEzMDg0MDE1OWQ4MjInLFxyXG4gIC8vIEFsdGVybmF0aXZlIHNpZ25hdHVyZXMgZm9yIGRpZmZlcmVudCBERVggaW1wbGVtZW50YXRpb25zXHJcbiAgU1dBUF9WMzogJzB4YzQyMDc5Zjk0YTYzNTBkN2U2MjM1ZjI5MTc0OTI0ZjkyOGNjMmFjODE4ZWI2NGZlZDgwMDRlMTE1ZmJjY2E2NydcclxufTtcclxuXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbi8vIERFVEVDVE9SIENPTkZJR1VSQVRJT04gLSBDaGFpbi1zcGVjaWZpYyBkZXRlY3RvciBzZXR0aW5nc1xyXG4vLyBDb25zb2xpZGF0ZXMgaGFyZGNvZGVkIHZhbHVlcyBmcm9tIGluZGl2aWR1YWwgZGV0ZWN0b3IgaW1wbGVtZW50YXRpb25zXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbmV4cG9ydCBpbnRlcmZhY2UgRGV0ZWN0b3JDaGFpbkNvbmZpZyB7XHJcbiAgLy8gQmF0Y2hpbmcgY29uZmlndXJhdGlvblxyXG4gIGJhdGNoU2l6ZTogbnVtYmVyO1xyXG4gIGJhdGNoVGltZW91dDogbnVtYmVyO1xyXG4gIGhlYWx0aENoZWNrSW50ZXJ2YWw6IG51bWJlcjtcclxuICAvLyBBcmJpdHJhZ2UgZGV0ZWN0aW9uXHJcbiAgY29uZmlkZW5jZTogbnVtYmVyOyAgICAgICAgICAgLy8gT3Bwb3J0dW5pdHkgY29uZmlkZW5jZSBzY29yZSAoMC0xKVxyXG4gIGV4cGlyeU1zOiBudW1iZXI7ICAgICAgICAgICAgIC8vIE9wcG9ydHVuaXR5IGV4cGlyeSBpbiBtaWxsaXNlY29uZHNcclxuICBnYXNFc3RpbWF0ZTogbnVtYmVyOyAgICAgICAgICAvLyBFc3RpbWF0ZWQgZ2FzIGZvciBzd2FwIGV4ZWN1dGlvblxyXG4gIC8vIFdoYWxlIGRldGVjdGlvblxyXG4gIHdoYWxlVGhyZXNob2xkOiBudW1iZXI7ICAgICAgIC8vIFVTRCB2YWx1ZSB0aHJlc2hvbGQgZm9yIHdoYWxlIGFsZXJ0c1xyXG4gIC8vIFRva2VuIG1ldGFkYXRhIGtleSBmb3IgbmF0aXZlIHRva2VuXHJcbiAgbmF0aXZlVG9rZW5LZXk6ICd3ZXRoJyB8ICduYXRpdmVXcmFwcGVyJztcclxufVxyXG5cclxuZXhwb3J0IGNvbnN0IERFVEVDVE9SX0NPTkZJRzogUmVjb3JkPHN0cmluZywgRGV0ZWN0b3JDaGFpbkNvbmZpZz4gPSB7XHJcbiAgZXRoZXJldW06IHtcclxuICAgIGJhdGNoU2l6ZTogMTUsICAgICAgICAgICAgICAvLyBMb3dlciBiYXRjaCBzaXplIGZvciAxMnMgYmxvY2tzXHJcbiAgICBiYXRjaFRpbWVvdXQ6IDUwLFxyXG4gICAgaGVhbHRoQ2hlY2tJbnRlcnZhbDogMzAwMDAsXHJcbiAgICBjb25maWRlbmNlOiAwLjc1LCAgICAgICAgICAgLy8gTG93ZXIgZHVlIHRvIGhpZ2hlciBnYXMgdmFyaWFiaWxpdHlcclxuICAgIGV4cGlyeU1zOiAxNTAwMCwgICAgICAgICAgICAvLyAxNXMgKGxvbmdlciBmb3Igc2xvdyBibG9ja3MpXHJcbiAgICBnYXNFc3RpbWF0ZTogMjUwMDAwLCAgICAgICAgLy8gSGlnaGVyIGdhcyBvbiBtYWlubmV0XHJcbiAgICB3aGFsZVRocmVzaG9sZDogMTAwMDAwLCAgICAgLy8gJDEwMEsgKGhpZ2hlciBkdWUgdG8gZ2FzIGNvc3RzKVxyXG4gICAgbmF0aXZlVG9rZW5LZXk6ICd3ZXRoJ1xyXG4gIH0sXHJcbiAgYXJiaXRydW06IHtcclxuICAgIGJhdGNoU2l6ZTogMzAsICAgICAgICAgICAgICAvLyBIaWdoZXIgYmF0Y2ggc2l6ZSBmb3IgdWx0cmEtZmFzdCAyNTBtcyBibG9ja3NcclxuICAgIGJhdGNoVGltZW91dDogMjAsICAgICAgICAgICAvLyBMb3dlciB0aW1lb3V0IGZvciBmYXN0ZXIgcHJvY2Vzc2luZ1xyXG4gICAgaGVhbHRoQ2hlY2tJbnRlcnZhbDogMTUwMDAsIC8vIE1vcmUgZnJlcXVlbnQgaGVhbHRoIGNoZWNrc1xyXG4gICAgY29uZmlkZW5jZTogMC44NSwgICAgICAgICAgIC8vIEhpZ2hlciBkdWUgdG8gdWx0cmEtZmFzdCBwcm9jZXNzaW5nXHJcbiAgICBleHBpcnlNczogNTAwMCwgICAgICAgICAgICAgLy8gNXMgKGZhc3RlciBmb3IgcXVpY2sgYmxvY2tzKVxyXG4gICAgZ2FzRXN0aW1hdGU6IDUwMDAwLCAgICAgICAgIC8vIFZlcnkgbG93IGdhcyBvbiBBcmJpdHJ1bVxyXG4gICAgd2hhbGVUaHJlc2hvbGQ6IDI1MDAwLCAgICAgIC8vICQyNUsgKGxvd2VyIHRocmVzaG9sZCBmb3IgTDIpXHJcbiAgICBuYXRpdmVUb2tlbktleTogJ3dldGgnXHJcbiAgfSxcclxuICBvcHRpbWlzbToge1xyXG4gICAgYmF0Y2hTaXplOiAyMCxcclxuICAgIGJhdGNoVGltZW91dDogMzAsXHJcbiAgICBoZWFsdGhDaGVja0ludGVydmFsOiAzMDAwMCxcclxuICAgIGNvbmZpZGVuY2U6IDAuODAsXHJcbiAgICBleHBpcnlNczogMTAwMDAsICAgICAgICAgICAgLy8gMTBzXHJcbiAgICBnYXNFc3RpbWF0ZTogMTAwMDAwLFxyXG4gICAgd2hhbGVUaHJlc2hvbGQ6IDI1MDAwLCAgICAgIC8vICQyNUtcclxuICAgIG5hdGl2ZVRva2VuS2V5OiAnd2V0aCdcclxuICB9LFxyXG4gIGJhc2U6IHtcclxuICAgIGJhdGNoU2l6ZTogMjAsXHJcbiAgICBiYXRjaFRpbWVvdXQ6IDMwLFxyXG4gICAgaGVhbHRoQ2hlY2tJbnRlcnZhbDogMzAwMDAsXHJcbiAgICBjb25maWRlbmNlOiAwLjgwLFxyXG4gICAgZXhwaXJ5TXM6IDEwMDAwLCAgICAgICAgICAgIC8vIDEwc1xyXG4gICAgZ2FzRXN0aW1hdGU6IDEwMDAwMCxcclxuICAgIHdoYWxlVGhyZXNob2xkOiAyNTAwMCwgICAgICAvLyAkMjVLXHJcbiAgICBuYXRpdmVUb2tlbktleTogJ3dldGgnXHJcbiAgfSxcclxuICBwb2x5Z29uOiB7XHJcbiAgICBiYXRjaFNpemU6IDIwLFxyXG4gICAgYmF0Y2hUaW1lb3V0OiAzMCxcclxuICAgIGhlYWx0aENoZWNrSW50ZXJ2YWw6IDMwMDAwLFxyXG4gICAgY29uZmlkZW5jZTogMC44MCxcclxuICAgIGV4cGlyeU1zOiAxMDAwMCwgICAgICAgICAgICAvLyAxMHNcclxuICAgIGdhc0VzdGltYXRlOiAxNTAwMDAsXHJcbiAgICB3aGFsZVRocmVzaG9sZDogMjUwMDAsICAgICAgLy8gJDI1S1xyXG4gICAgbmF0aXZlVG9rZW5LZXk6ICd3ZXRoJyAgICAgIC8vIFdFVEggb24gUG9seWdvbiwgbm90IFdNQVRJQyBmb3IgVVNEIGNhbGNcclxuICB9LFxyXG4gIGJzYzoge1xyXG4gICAgYmF0Y2hTaXplOiAyMCxcclxuICAgIGJhdGNoVGltZW91dDogMzAsXHJcbiAgICBoZWFsdGhDaGVja0ludGVydmFsOiAzMDAwMCxcclxuICAgIGNvbmZpZGVuY2U6IDAuODAsXHJcbiAgICBleHBpcnlNczogMTAwMDAsICAgICAgICAgICAgLy8gMTBzXHJcbiAgICBnYXNFc3RpbWF0ZTogMjAwMDAwLFxyXG4gICAgd2hhbGVUaHJlc2hvbGQ6IDUwMDAwLCAgICAgIC8vICQ1MEsgKG1vZGVyYXRlIHRocmVzaG9sZClcclxuICAgIG5hdGl2ZVRva2VuS2V5OiAnbmF0aXZlV3JhcHBlcicgIC8vIFdCTkIgZm9yIFVTRCBjYWxjXHJcbiAgfVxyXG59O1xyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuLy8gRkxBU0ggTE9BTiBQUk9WSURFUiBDT05GSUdVUkFUSU9OIChQMS00IGZpeClcclxuLy8gTW92ZWQgZnJvbSBoYXJkY29kZWQgdmFsdWVzIGluIGV4ZWN1dGlvbi1lbmdpbmVcclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuZXhwb3J0IGNvbnN0IEZMQVNIX0xPQU5fUFJPVklERVJTOiBSZWNvcmQ8c3RyaW5nLCB7XHJcbiAgYWRkcmVzczogc3RyaW5nO1xyXG4gIHByb3RvY29sOiBzdHJpbmc7XHJcbiAgZmVlOiBudW1iZXI7ICAvLyBCYXNpcyBwb2ludHMgKDEwMCA9IDElKVxyXG59PiA9IHtcclxuICAvLyBBYXZlIFYzIFBvb2wgYWRkcmVzc2VzIC0gaHR0cHM6Ly9kb2NzLmFhdmUuY29tL2RldmVsb3BlcnMvZGVwbG95ZWQtY29udHJhY3RzXHJcbiAgZXRoZXJldW06IHtcclxuICAgIGFkZHJlc3M6ICcweDg3ODcwQmNkMkM0YzJlODRBOGMzQzNhM0ZjQUNDOTQ2NjZjMGQ2Q2YnLFxyXG4gICAgcHJvdG9jb2w6ICdhYXZlX3YzJyxcclxuICAgIGZlZTogOSAgLy8gMC4wOSUgZmxhc2ggbG9hbiBmZWVcclxuICB9LFxyXG4gIHBvbHlnb246IHtcclxuICAgIGFkZHJlc3M6ICcweDc5NGE2MTM1OEQ2ODQ1NTk0Rjk0ZGMxREIwMkEyNTJiNWI0ODE0YUQnLFxyXG4gICAgcHJvdG9jb2w6ICdhYXZlX3YzJyxcclxuICAgIGZlZTogOVxyXG4gIH0sXHJcbiAgYXJiaXRydW06IHtcclxuICAgIGFkZHJlc3M6ICcweDc5NGE2MTM1OEQ2ODQ1NTk0Rjk0ZGMxREIwMkEyNTJiNWI0ODE0YUQnLFxyXG4gICAgcHJvdG9jb2w6ICdhYXZlX3YzJyxcclxuICAgIGZlZTogOVxyXG4gIH0sXHJcbiAgYmFzZToge1xyXG4gICAgYWRkcmVzczogJzB4QTIzOERkODBDMjU5YTcyZTgxZDdlNDY2NGE5ODAxNTkzRjk4ZDFjNScsXHJcbiAgICBwcm90b2NvbDogJ2FhdmVfdjMnLFxyXG4gICAgZmVlOiA5XHJcbiAgfSxcclxuICBvcHRpbWlzbToge1xyXG4gICAgYWRkcmVzczogJzB4Nzk0YTYxMzU4RDY4NDU1OTRGOTRkYzFEQjAyQTI1MmI1YjQ4MTRhRCcsXHJcbiAgICBwcm90b2NvbDogJ2FhdmVfdjMnLFxyXG4gICAgZmVlOiA5XHJcbiAgfSxcclxuICAvLyBCU0MgdXNlcyBQYW5jYWtlc3dhcCBmbGFzaCBsb2FucyAobm8gQWF2ZSBWMylcclxuICBic2M6IHtcclxuICAgIGFkZHJlc3M6ICcweDEzZjRFQTgzRDBiZDQwRTc1QzgyMjIyNTViYzg1NWE5NzQ1NjhEZDQnLCAgLy8gUGFuY2FrZVN3YXAgVjMgUm91dGVyXHJcbiAgICBwcm90b2NvbDogJ3BhbmNha2Vzd2FwX3YzJyxcclxuICAgIGZlZTogMjUgIC8vIDAuMjUlIGZsYXNoIHN3YXAgZmVlXHJcbiAgfVxyXG59O1xyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuLy8gQlJJREdFIENPU1QgQ09ORklHVVJBVElPTiAoUDEtNSBGSVgpXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcblxyXG4vKipcclxuICogUDEtNSBGSVg6IEJyaWRnZSBjb3N0IGNvbmZpZ3VyYXRpb24gdG8gcmVwbGFjZSBoYXJkY29kZWQgbXVsdGlwbGllcnMuXHJcbiAqIEZlZXMgYXJlIGluIGJhc2lzIHBvaW50cyAoMSBicCA9IDAuMDElKS4gTGF0ZW5jeSBpbiBzZWNvbmRzLlxyXG4gKlxyXG4gKiBEYXRhIHNvdXJjZXM6XHJcbiAqIC0gU3RhcmdhdGU6IGh0dHBzOi8vc3RhcmdhdGUuZmluYW5jZS9icmlkZ2UgKGZlZXMgdmFyeSBieSByb3V0ZSlcclxuICogLSBBY3Jvc3M6IGh0dHBzOi8vYWNyb3NzLnRvLyAoZHluYW1pYyBmZWVzKVxyXG4gKiAtIExheWVyWmVybzogaHR0cHM6Ly9sYXllcnplcm8ubmV0d29yay8gKGdhcy1kZXBlbmRlbnQgZmVlcylcclxuICpcclxuICogTm90ZTogVGhlc2UgYXJlIGJhc2VsaW5lIGVzdGltYXRlcy4gUHJvZHVjdGlvbiBzaG91bGQgdXNlIHJlYWwtdGltZSBBUEkgZGF0YS5cclxuICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgQnJpZGdlQ29zdENvbmZpZyB7XHJcbiAgYnJpZGdlOiBzdHJpbmc7XHJcbiAgc291cmNlQ2hhaW46IHN0cmluZztcclxuICB0YXJnZXRDaGFpbjogc3RyaW5nO1xyXG4gIGZlZVBlcmNlbnRhZ2U6IG51bWJlcjsgIC8vIEluIHBlcmNlbnRhZ2UgKGUuZy4sIDAuMDYgPSAwLjA2JSlcclxuICBtaW5GZWVVc2Q6IG51bWJlcjsgICAgICAvLyBNaW5pbXVtIGZlZSBpbiBVU0RcclxuICBlc3RpbWF0ZWRMYXRlbmN5U2Vjb25kczogbnVtYmVyO1xyXG4gIHJlbGlhYmlsaXR5OiBudW1iZXI7ICAgIC8vIDAtMSBzY2FsZVxyXG59XHJcblxyXG5leHBvcnQgY29uc3QgQlJJREdFX0NPU1RTOiBCcmlkZ2VDb3N0Q29uZmlnW10gPSBbXHJcbiAgLy8gU3RhcmdhdGUgKExheWVyWmVybykgLSBHb29kIGZvciBzdGFibGVjb2luc1xyXG4gIHsgYnJpZGdlOiAnc3RhcmdhdGUnLCBzb3VyY2VDaGFpbjogJ2V0aGVyZXVtJywgdGFyZ2V0Q2hhaW46ICdhcmJpdHJ1bScsIGZlZVBlcmNlbnRhZ2U6IDAuMDYsIG1pbkZlZVVzZDogMSwgZXN0aW1hdGVkTGF0ZW5jeVNlY29uZHM6IDE4MCwgcmVsaWFiaWxpdHk6IDAuOTUgfSxcclxuICB7IGJyaWRnZTogJ3N0YXJnYXRlJywgc291cmNlQ2hhaW46ICdldGhlcmV1bScsIHRhcmdldENoYWluOiAnb3B0aW1pc20nLCBmZWVQZXJjZW50YWdlOiAwLjA2LCBtaW5GZWVVc2Q6IDEsIGVzdGltYXRlZExhdGVuY3lTZWNvbmRzOiAxODAsIHJlbGlhYmlsaXR5OiAwLjk1IH0sXHJcbiAgeyBicmlkZ2U6ICdzdGFyZ2F0ZScsIHNvdXJjZUNoYWluOiAnZXRoZXJldW0nLCB0YXJnZXRDaGFpbjogJ3BvbHlnb24nLCBmZWVQZXJjZW50YWdlOiAwLjA2LCBtaW5GZWVVc2Q6IDEsIGVzdGltYXRlZExhdGVuY3lTZWNvbmRzOiAxODAsIHJlbGlhYmlsaXR5OiAwLjk1IH0sXHJcbiAgeyBicmlkZ2U6ICdzdGFyZ2F0ZScsIHNvdXJjZUNoYWluOiAnZXRoZXJldW0nLCB0YXJnZXRDaGFpbjogJ2JzYycsIGZlZVBlcmNlbnRhZ2U6IDAuMDYsIG1pbkZlZVVzZDogMSwgZXN0aW1hdGVkTGF0ZW5jeVNlY29uZHM6IDE4MCwgcmVsaWFiaWxpdHk6IDAuOTUgfSxcclxuICB7IGJyaWRnZTogJ3N0YXJnYXRlJywgc291cmNlQ2hhaW46ICdldGhlcmV1bScsIHRhcmdldENoYWluOiAnYmFzZScsIGZlZVBlcmNlbnRhZ2U6IDAuMDYsIG1pbkZlZVVzZDogMSwgZXN0aW1hdGVkTGF0ZW5jeVNlY29uZHM6IDE4MCwgcmVsaWFiaWxpdHk6IDAuOTUgfSxcclxuICB7IGJyaWRnZTogJ3N0YXJnYXRlJywgc291cmNlQ2hhaW46ICdhcmJpdHJ1bScsIHRhcmdldENoYWluOiAnZXRoZXJldW0nLCBmZWVQZXJjZW50YWdlOiAwLjA2LCBtaW5GZWVVc2Q6IDAuNSwgZXN0aW1hdGVkTGF0ZW5jeVNlY29uZHM6IDE4MCwgcmVsaWFiaWxpdHk6IDAuOTUgfSxcclxuICB7IGJyaWRnZTogJ3N0YXJnYXRlJywgc291cmNlQ2hhaW46ICdhcmJpdHJ1bScsIHRhcmdldENoYWluOiAnb3B0aW1pc20nLCBmZWVQZXJjZW50YWdlOiAwLjA0LCBtaW5GZWVVc2Q6IDAuMywgZXN0aW1hdGVkTGF0ZW5jeVNlY29uZHM6IDkwLCByZWxpYWJpbGl0eTogMC45NSB9LFxyXG4gIHsgYnJpZGdlOiAnc3RhcmdhdGUnLCBzb3VyY2VDaGFpbjogJ2FyYml0cnVtJywgdGFyZ2V0Q2hhaW46ICdiYXNlJywgZmVlUGVyY2VudGFnZTogMC4wNCwgbWluRmVlVXNkOiAwLjMsIGVzdGltYXRlZExhdGVuY3lTZWNvbmRzOiA5MCwgcmVsaWFiaWxpdHk6IDAuOTUgfSxcclxuXHJcbiAgLy8gQWNyb3NzIFByb3RvY29sIC0gRmFzdCB3aXRoIHJlbGF5ZXIgbW9kZWxcclxuICB7IGJyaWRnZTogJ2Fjcm9zcycsIHNvdXJjZUNoYWluOiAnZXRoZXJldW0nLCB0YXJnZXRDaGFpbjogJ2FyYml0cnVtJywgZmVlUGVyY2VudGFnZTogMC4wNCwgbWluRmVlVXNkOiAyLCBlc3RpbWF0ZWRMYXRlbmN5U2Vjb25kczogMTIwLCByZWxpYWJpbGl0eTogMC45NyB9LFxyXG4gIHsgYnJpZGdlOiAnYWNyb3NzJywgc291cmNlQ2hhaW46ICdldGhlcmV1bScsIHRhcmdldENoYWluOiAnb3B0aW1pc20nLCBmZWVQZXJjZW50YWdlOiAwLjA0LCBtaW5GZWVVc2Q6IDIsIGVzdGltYXRlZExhdGVuY3lTZWNvbmRzOiAxMjAsIHJlbGlhYmlsaXR5OiAwLjk3IH0sXHJcbiAgeyBicmlkZ2U6ICdhY3Jvc3MnLCBzb3VyY2VDaGFpbjogJ2V0aGVyZXVtJywgdGFyZ2V0Q2hhaW46ICdwb2x5Z29uJywgZmVlUGVyY2VudGFnZTogMC4wNCwgbWluRmVlVXNkOiAyLCBlc3RpbWF0ZWRMYXRlbmN5U2Vjb25kczogMTIwLCByZWxpYWJpbGl0eTogMC45NyB9LFxyXG4gIHsgYnJpZGdlOiAnYWNyb3NzJywgc291cmNlQ2hhaW46ICdldGhlcmV1bScsIHRhcmdldENoYWluOiAnYmFzZScsIGZlZVBlcmNlbnRhZ2U6IDAuMDQsIG1pbkZlZVVzZDogMiwgZXN0aW1hdGVkTGF0ZW5jeVNlY29uZHM6IDEyMCwgcmVsaWFiaWxpdHk6IDAuOTcgfSxcclxuICB7IGJyaWRnZTogJ2Fjcm9zcycsIHNvdXJjZUNoYWluOiAnYXJiaXRydW0nLCB0YXJnZXRDaGFpbjogJ2V0aGVyZXVtJywgZmVlUGVyY2VudGFnZTogMC4wNCwgbWluRmVlVXNkOiAxLCBlc3RpbWF0ZWRMYXRlbmN5U2Vjb25kczogMTIwLCByZWxpYWJpbGl0eTogMC45NyB9LFxyXG4gIHsgYnJpZGdlOiAnYWNyb3NzJywgc291cmNlQ2hhaW46ICdhcmJpdHJ1bScsIHRhcmdldENoYWluOiAnb3B0aW1pc20nLCBmZWVQZXJjZW50YWdlOiAwLjAzLCBtaW5GZWVVc2Q6IDAuNSwgZXN0aW1hdGVkTGF0ZW5jeVNlY29uZHM6IDYwLCByZWxpYWJpbGl0eTogMC45NyB9LFxyXG4gIHsgYnJpZGdlOiAnYWNyb3NzJywgc291cmNlQ2hhaW46ICdvcHRpbWlzbScsIHRhcmdldENoYWluOiAnYXJiaXRydW0nLCBmZWVQZXJjZW50YWdlOiAwLjAzLCBtaW5GZWVVc2Q6IDAuNSwgZXN0aW1hdGVkTGF0ZW5jeVNlY29uZHM6IDYwLCByZWxpYWJpbGl0eTogMC45NyB9LFxyXG4gIHsgYnJpZGdlOiAnYWNyb3NzJywgc291cmNlQ2hhaW46ICdiYXNlJywgdGFyZ2V0Q2hhaW46ICdhcmJpdHJ1bScsIGZlZVBlcmNlbnRhZ2U6IDAuMDMsIG1pbkZlZVVzZDogMC41LCBlc3RpbWF0ZWRMYXRlbmN5U2Vjb25kczogNjAsIHJlbGlhYmlsaXR5OiAwLjk3IH0sXHJcblxyXG4gIC8vIE5hdGl2ZSBicmlkZ2VzIChMMiAtPiBMMSBhcmUgc2xvd2VyKVxyXG4gIHsgYnJpZGdlOiAnbmF0aXZlJywgc291cmNlQ2hhaW46ICdhcmJpdHJ1bScsIHRhcmdldENoYWluOiAnZXRoZXJldW0nLCBmZWVQZXJjZW50YWdlOiAwLjAsIG1pbkZlZVVzZDogNSwgZXN0aW1hdGVkTGF0ZW5jeVNlY29uZHM6IDYwNDgwMCwgcmVsaWFiaWxpdHk6IDAuOTkgfSwgLy8gNyBkYXlzXHJcbiAgeyBicmlkZ2U6ICduYXRpdmUnLCBzb3VyY2VDaGFpbjogJ29wdGltaXNtJywgdGFyZ2V0Q2hhaW46ICdldGhlcmV1bScsIGZlZVBlcmNlbnRhZ2U6IDAuMCwgbWluRmVlVXNkOiA1LCBlc3RpbWF0ZWRMYXRlbmN5U2Vjb25kczogNjA0ODAwLCByZWxpYWJpbGl0eTogMC45OSB9LCAvLyA3IGRheXNcclxuICB7IGJyaWRnZTogJ25hdGl2ZScsIHNvdXJjZUNoYWluOiAnYmFzZScsIHRhcmdldENoYWluOiAnZXRoZXJldW0nLCBmZWVQZXJjZW50YWdlOiAwLjAsIG1pbkZlZVVzZDogNSwgZXN0aW1hdGVkTGF0ZW5jeVNlY29uZHM6IDYwNDgwMCwgcmVsaWFiaWxpdHk6IDAuOTkgfSwgLy8gNyBkYXlzXHJcbl07XHJcblxyXG4vKipcclxuICogUDEtNSBGSVg6IEdldCBicmlkZ2UgY29zdCBmb3IgYSBzcGVjaWZpYyByb3V0ZVxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGdldEJyaWRnZUNvc3QoXHJcbiAgc291cmNlQ2hhaW46IHN0cmluZyxcclxuICB0YXJnZXRDaGFpbjogc3RyaW5nLFxyXG4gIGJyaWRnZT86IHN0cmluZ1xyXG4pOiBCcmlkZ2VDb3N0Q29uZmlnIHwgdW5kZWZpbmVkIHtcclxuICBjb25zdCBub3JtYWxpemVkU291cmNlID0gc291cmNlQ2hhaW4udG9Mb3dlckNhc2UoKTtcclxuICBjb25zdCBub3JtYWxpemVkVGFyZ2V0ID0gdGFyZ2V0Q2hhaW4udG9Mb3dlckNhc2UoKTtcclxuXHJcbiAgaWYgKGJyaWRnZSkge1xyXG4gICAgcmV0dXJuIEJSSURHRV9DT1NUUy5maW5kKFxyXG4gICAgICBiID0+IGIuc291cmNlQ2hhaW4gPT09IG5vcm1hbGl6ZWRTb3VyY2UgJiZcclxuICAgICAgICAgICBiLnRhcmdldENoYWluID09PSBub3JtYWxpemVkVGFyZ2V0ICYmXHJcbiAgICAgICAgICAgYi5icmlkZ2UgPT09IGJyaWRnZS50b0xvd2VyQ2FzZSgpXHJcbiAgICApO1xyXG4gIH1cclxuXHJcbiAgLy8gRmluZCBiZXN0IGJyaWRnZSAobG93ZXN0IGZlZSlcclxuICBjb25zdCBvcHRpb25zID0gQlJJREdFX0NPU1RTLmZpbHRlcihcclxuICAgIGIgPT4gYi5zb3VyY2VDaGFpbiA9PT0gbm9ybWFsaXplZFNvdXJjZSAmJiBiLnRhcmdldENoYWluID09PSBub3JtYWxpemVkVGFyZ2V0XHJcbiAgKTtcclxuXHJcbiAgaWYgKG9wdGlvbnMubGVuZ3RoID09PSAwKSByZXR1cm4gdW5kZWZpbmVkO1xyXG5cclxuICByZXR1cm4gb3B0aW9ucy5yZWR1Y2UoKGJlc3QsIGN1cnJlbnQpID0+XHJcbiAgICBjdXJyZW50LmZlZVBlcmNlbnRhZ2UgPCBiZXN0LmZlZVBlcmNlbnRhZ2UgPyBjdXJyZW50IDogYmVzdFxyXG4gICk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBQMS01IEZJWDogQ2FsY3VsYXRlIGJyaWRnZSBjb3N0IGZvciBhIGdpdmVuIFVTRCBhbW91bnRcclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBjYWxjdWxhdGVCcmlkZ2VDb3N0VXNkKFxyXG4gIHNvdXJjZUNoYWluOiBzdHJpbmcsXHJcbiAgdGFyZ2V0Q2hhaW46IHN0cmluZyxcclxuICBhbW91bnRVc2Q6IG51bWJlcixcclxuICBicmlkZ2U/OiBzdHJpbmdcclxuKTogeyBmZWU6IG51bWJlcjsgbGF0ZW5jeTogbnVtYmVyOyBicmlkZ2U6IHN0cmluZyB9IHwgdW5kZWZpbmVkIHtcclxuICBjb25zdCBjb25maWcgPSBnZXRCcmlkZ2VDb3N0KHNvdXJjZUNoYWluLCB0YXJnZXRDaGFpbiwgYnJpZGdlKTtcclxuICBpZiAoIWNvbmZpZykgcmV0dXJuIHVuZGVmaW5lZDtcclxuXHJcbiAgY29uc3QgcGVyY2VudGFnZUZlZSA9IGFtb3VudFVzZCAqIChjb25maWcuZmVlUGVyY2VudGFnZSAvIDEwMCk7XHJcbiAgY29uc3QgZmVlID0gTWF0aC5tYXgocGVyY2VudGFnZUZlZSwgY29uZmlnLm1pbkZlZVVzZCk7XHJcblxyXG4gIHJldHVybiB7XHJcbiAgICBmZWUsXHJcbiAgICBsYXRlbmN5OiBjb25maWcuZXN0aW1hdGVkTGF0ZW5jeVNlY29uZHMsXHJcbiAgICBicmlkZ2U6IGNvbmZpZy5icmlkZ2VcclxuICB9O1xyXG59XHJcblxyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4vLyBQQVJUSVRJT04gRVhQT1JUUyAoQURSLTAwMylcclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuZXhwb3J0ICogZnJvbSAnLi9wYXJ0aXRpb25zJztcclxuXHJcbi8vIE5hbWVkIHJlLWV4cG9ydHMgZm9yIEFEUi0wMDMgY29tcGxpYW5jZSB0ZXN0c1xyXG5leHBvcnQge1xyXG4gIFBBUlRJVElPTlMsXHJcbiAgUGFydGl0aW9uQ29uZmlnLFxyXG4gIGdldFBhcnRpdGlvbixcclxuICBnZXRQYXJ0aXRpb25Gcm9tRW52LFxyXG4gIGFzc2lnbkNoYWluVG9QYXJ0aXRpb25cclxufSBmcm9tICcuL3BhcnRpdGlvbnMnO1xyXG4iXX0=