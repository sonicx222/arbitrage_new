"use strict";
// Jest setup for Unified Detector tests
// Set required environment variables before module imports
// Required by shared/config/src/index.ts
process.env.ETHEREUM_RPC_URL = 'https://mainnet.infura.io/v3/test';
process.env.ETHEREUM_WS_URL = 'wss://mainnet.infura.io/ws/v3/test';
// Other chain URLs (optional but good to have for consistency)
process.env.ARBITRUM_RPC_URL = 'https://arb1.arbitrum.io/rpc';
process.env.ARBITRUM_WS_URL = 'wss://arb1.arbitrum.io/feed';
process.env.BSC_RPC_URL = 'https://bsc-dataseed1.binance.org';
process.env.BSC_WS_URL = 'wss://bsc-ws-node.nariox.org:443';
process.env.POLYGON_RPC_URL = 'https://polygon-rpc.com';
process.env.POLYGON_WS_URL = 'wss://polygon-rpc.com';
process.env.OPTIMISM_RPC_URL = 'https://mainnet.optimism.io';
process.env.OPTIMISM_WS_URL = 'wss://mainnet.optimism.io';
process.env.BASE_RPC_URL = 'https://mainnet.base.org';
process.env.BASE_WS_URL = 'wss://mainnet.base.org';
// Test environment settings
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.REDIS_URL = 'redis://localhost:6379';
global.beforeEach(() => {
    jest.clearAllMocks();
});
global.afterEach(() => {
    jest.resetAllMocks();
});
global.performance = {
    now: jest.fn().mockReturnValue(1000)
};
//# sourceMappingURL=setupTests.js.map