"use strict";
// Jest setup for Cross-Chain detector tests
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