"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EVENT_CONFIG = exports.ARBITRAGE_CONFIG = exports.PERFORMANCE_THRESHOLDS = exports.SERVICE_CONFIGS = exports.CORE_TOKENS = exports.DEXES = exports.CHAINS = void 0;
// Validate required environment variables at startup
if (!process.env.ETHEREUM_RPC_URL) {
    throw new Error('CRITICAL CONFIG ERROR: ETHEREUM_RPC_URL environment variable is required');
}
if (!process.env.ETHEREUM_WS_URL) {
    throw new Error('CRITICAL CONFIG ERROR: ETHEREUM_WS_URL environment variable is required');
}
// Chain configurations based on optimal selection analysis
exports.CHAINS = {
    bsc: {
        id: 56,
        name: 'BSC',
        rpcUrl: process.env.BSC_RPC_URL || 'https://bsc-dataseed1.binance.org',
        wsUrl: process.env.BSC_WS_URL || 'wss://bsc-ws-node.nariox.org:443',
        blockTime: 3,
        nativeToken: 'BNB'
    },
    ethereum: {
        id: 1,
        name: 'Ethereum',
        rpcUrl: process.env.ETHEREUM_RPC_URL,
        wsUrl: process.env.ETHEREUM_WS_URL,
        blockTime: 12,
        nativeToken: 'ETH'
    },
    arbitrum: {
        id: 42161,
        name: 'Arbitrum',
        rpcUrl: 'https://arb1.arbitrum.io/rpc',
        wsUrl: 'wss://arb1.arbitrum.io/feed',
        blockTime: 0.25,
        nativeToken: 'ETH'
    },
    base: {
        id: 8453,
        name: 'Base',
        rpcUrl: 'https://mainnet.base.org',
        wsUrl: 'wss://mainnet.base.org',
        blockTime: 2,
        nativeToken: 'ETH'
    },
    polygon: {
        id: 137,
        name: 'Polygon',
        rpcUrl: 'https://polygon-rpc.com',
        wsUrl: 'wss://polygon-rpc.com',
        blockTime: 2,
        nativeToken: 'MATIC'
    }
};
// DEX configurations with optimal priority selection
exports.DEXES = {
    bsc: [
        {
            name: 'pancake',
            chain: 'bsc',
            factoryAddress: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
            routerAddress: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
            fee: 25 // 0.25%
        },
        {
            name: 'biswap',
            chain: 'bsc',
            factoryAddress: '0x858E3312ed3A876947EA49d572A7C42DE08af7EE0',
            routerAddress: '0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8',
            fee: 10 // 0.1%
        },
        {
            name: 'apeswap',
            chain: 'bsc',
            factoryAddress: '0x0841BD0B734E4F5853f0dD8d7Ea041c241fb0Da6',
            routerAddress: '0xcF0feBd3f17CEf5b47b0cD257aCf6025c5BFf3b7',
            fee: 20 // 0.2%
        }
    ],
    ethereum: [
        {
            name: 'uniswap_v3',
            chain: 'ethereum',
            factoryAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
            routerAddress: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
            fee: 30 // 0.3% (variable)
        },
        {
            name: 'uniswap_v2',
            chain: 'ethereum',
            factoryAddress: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
            routerAddress: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
            fee: 30 // 0.3%
        },
        {
            name: 'sushiswap',
            chain: 'ethereum',
            factoryAddress: '0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac',
            routerAddress: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',
            fee: 30 // 0.3%
        }
    ],
    arbitrum: [
        {
            name: 'uniswap_v3',
            chain: 'arbitrum',
            factoryAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
            routerAddress: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
            fee: 30 // 0.3% (variable)
        },
        {
            name: 'sushiswap',
            chain: 'arbitrum',
            factoryAddress: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
            routerAddress: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
            fee: 30 // 0.3%
        }
    ],
    base: [
        {
            name: 'uniswap_v3',
            chain: 'base',
            factoryAddress: '0x33128a8fC17869897dcE68Ed026d694621f6FDFD',
            routerAddress: '0x2626664c2603336E57B271c5C0b26F421741e481',
            fee: 30 // 0.3% (variable)
        }
    ],
    polygon: [
        {
            name: 'quickswap',
            chain: 'polygon',
            factoryAddress: '0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32',
            routerAddress: '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff',
            fee: 30 // 0.3%
        },
        {
            name: 'uniswap_v3',
            chain: 'polygon',
            factoryAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
            routerAddress: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
            fee: 30 // 0.3% (variable)
        }
    ]
};
// Core tokens to monitor on all chains
exports.CORE_TOKENS = {
    bsc: [
        { address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', symbol: 'WBNB', decimals: 18, chainId: 56 },
        { address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', decimals: 18, chainId: 56 },
        { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', symbol: 'USDC', decimals: 18, chainId: 56 },
        { address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', symbol: 'BUSD', decimals: 18, chainId: 56 },
        { address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', symbol: 'ETH', decimals: 18, chainId: 56 }
    ],
    ethereum: [
        { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', decimals: 18, chainId: 1 },
        { address: '0xA0b86a33E6441e88C5F2712C3E9b74F5c4d6E3F5', symbol: 'USDT', decimals: 6, chainId: 1 },
        { address: '0xA0b86a33E6441e88C5F2712C3E9b74F5c4d6E3F5', symbol: 'USDC', decimals: 6, chainId: 1 },
        { address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', symbol: 'WBTC', decimals: 8, chainId: 1 },
        { address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', symbol: 'UNI', decimals: 18, chainId: 1 }
    ],
    arbitrum: [
        { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', symbol: 'WETH', decimals: 18, chainId: 42161 },
        { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', symbol: 'USDT', decimals: 6, chainId: 42161 },
        { address: '0xFF970A61A04b1cA14834A43f5de4533eBDDB5CC8', symbol: 'USDC', decimals: 6, chainId: 42161 },
        { address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', symbol: 'WBTC', decimals: 8, chainId: 42161 },
        { address: '0x912CE59144191C1204E64559FE8253a0e49E6548', symbol: 'ARB', decimals: 18, chainId: 42161 }
    ],
    base: [
        { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18, chainId: 8453 },
        { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6, chainId: 8453 },
        { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', symbol: 'DAI', decimals: 18, chainId: 8453 }
    ],
    polygon: [
        { address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', symbol: 'WMATIC', decimals: 18, chainId: 137 },
        { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', symbol: 'USDT', decimals: 6, chainId: 137 },
        { address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', symbol: 'USDC', decimals: 6, chainId: 137 },
        { address: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', symbol: 'WBTC', decimals: 8, chainId: 137 }
    ]
};
// Service configurations
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
// Performance thresholds
exports.PERFORMANCE_THRESHOLDS = {
    maxEventLatency: 50, // ms
    minCacheHitRate: 0.9, // 90%
    maxMemoryUsage: 400 * 1024 * 1024, // 400MB
    maxCpuUsage: 80, // %
    maxFalsePositiveRate: 0.05 // 5%
};
// Arbitrage detection parameters
exports.ARBITRAGE_CONFIG = {
    minProfitPercentage: 0.003, // 0.3%
    maxGasPrice: 50000000000, // 50 gwei
    confidenceThreshold: 0.75,
    maxTradeSize: '1000000000000000000', // 1 ETH equivalent
    triangularEnabled: true,
    crossChainEnabled: false, // Enable later
    predictiveEnabled: false // Enable later
};
// Event monitoring configuration
exports.EVENT_CONFIG = {
    syncEvents: {
        enabled: true,
        priority: 'high'
    },
    swapEvents: {
        enabled: true,
        priority: 'medium',
        minAmountUSD: 1000,
        samplingRate: 0.1
    }
};
//# sourceMappingURL=index.js.map