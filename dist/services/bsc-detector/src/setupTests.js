"use strict";
// Jest setup for BSC detector tests
// Mock environment variables
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.REDIS_URL = 'redis://localhost:6379';
// Global test utilities
global.beforeEach(() => {
    jest.clearAllMocks();
});
global.afterEach(() => {
    jest.resetAllMocks();
});
// Mock performance.now for consistent timing tests
const mockPerformanceNow = jest.fn();
mockPerformanceNow.mockReturnValue(1000);
// Mock global performance
global.performance = {
    now: mockPerformanceNow
};
//# sourceMappingURL=setupTests.js.map