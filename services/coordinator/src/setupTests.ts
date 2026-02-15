// Jest setup for Coordinator tests
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.REDIS_URL = 'redis://localhost:6379';

// Required environment variables for @shared/config
// These are needed even when not used because config validates at import time
process.env.ETHEREUM_RPC_URL = 'https://eth-mainnet.example.com';
process.env.ETHEREUM_WS_URL = 'wss://eth-mainnet.example.com';
process.env.BSC_RPC_URL = 'https://bsc-mainnet.example.com';
process.env.BSC_WS_URL = 'wss://bsc-mainnet.example.com';
process.env.POLYGON_RPC_URL = 'https://polygon-mainnet.example.com';
process.env.POLYGON_WS_URL = 'wss://polygon-mainnet.example.com';

global.beforeEach(() => {
  jest.clearAllMocks();
});

global.afterEach(() => {
  jest.resetAllMocks();
});

// FIX #23: Use shared performance mock (single source of truth)
import '@arbitrage/test-utils/setup/performance-mock';