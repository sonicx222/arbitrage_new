// Jest setup for Execution engine tests
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.REDIS_URL = 'redis://localhost:6379';

// Hardhat default private key #0 — ONLY for test environments
// Security: This key is publicly known and must never be used in production
const HARDHAT_DEFAULT_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
if (process.env.NODE_ENV === 'production') {
  throw new Error(
    '[SECURITY] Hardhat default private key detected in production environment. ' +
    'This key is publicly known and MUST NOT be used outside of tests.'
  );
}

// Mock private keys for testing
process.env.ETHEREUM_PRIVATE_KEY = HARDHAT_DEFAULT_KEY;
process.env.BSC_PRIVATE_KEY = HARDHAT_DEFAULT_KEY;
process.env.ARBITRUM_PRIVATE_KEY = HARDHAT_DEFAULT_KEY;
process.env.BASE_PRIVATE_KEY = HARDHAT_DEFAULT_KEY;
process.env.POLYGON_PRIVATE_KEY = HARDHAT_DEFAULT_KEY;

// Note: jest.clearAllMocks/resetAllMocks removed — handled by jest.config.base.js
// (clearMocks: true, resetMocks: true, restoreMocks: true)

// FIX #23: Use shared performance mock (single source of truth)
import '@arbitrage/test-utils/setup/performance-mock';