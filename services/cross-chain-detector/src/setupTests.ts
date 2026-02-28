// Jest setup for Cross-Chain detector tests
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.REDIS_URL = 'redis://localhost:6379';

// Note: jest.clearAllMocks/resetAllMocks removed — handled by jest.config.base.js
// (clearMocks: true, resetMocks: true, restoreMocks: true)

// FIX #23: Use shared performance mock (single source of truth)
import '@arbitrage/test-utils/setup/performance-mock';