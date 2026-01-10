// Jest setup for Execution engine tests
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.REDIS_URL = 'redis://localhost:6379';

// Mock private keys for testing
process.env.ETHEREUM_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
process.env.BSC_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
process.env.ARBITRUM_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
process.env.BASE_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
process.env.POLYGON_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

global.beforeEach(() => {
  jest.clearAllMocks();
});

global.afterEach(() => {
  jest.resetAllMocks();
});

(global as any).performance = {
  now: jest.fn().mockReturnValue(1000)
};