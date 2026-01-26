// Jest setup for Mempool Detector tests
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.STRICT_CONFIG_VALIDATION = 'false'; // Skip config validation in tests

global.beforeEach(() => {
  jest.clearAllMocks();
});

global.afterEach(() => {
  jest.resetAllMocks();
});

(global as unknown as { performance: { now: jest.Mock } }).performance = {
  now: jest.fn().mockReturnValue(1000)
};
