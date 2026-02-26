/**
 * Unit Tests for P4 Environment Validation Module
 *
 * Tests REDIS_URL validation logic with protocol checks and
 * NODE_ENV=test bypass behavior.
 *
 * @see services/partition-solana/src/env-validation.ts
 */

// =============================================================================
// Module Mocks
// =============================================================================

const mockExitWithConfigError = jest.fn();
const mockCreateLogger = jest.fn();

jest.mock('@arbitrage/core', () => ({
  createLogger: mockCreateLogger,
}));

jest.mock('@arbitrage/core/partition', () => ({
  exitWithConfigError: mockExitWithConfigError,
}));

// =============================================================================
// Imports (after mocks)
// =============================================================================

import { validateEnvironment } from '../../src/env-validation';

// =============================================================================
// Test Helpers
// =============================================================================

const originalEnv = process.env;

interface MockLogger {
  info: jest.Mock;
  error: jest.Mock;
  warn: jest.Mock;
  debug: jest.Mock;
}

function createMockLogger(): MockLogger {
  return {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  };
}

function setupTestEnv(overrides: Record<string, string> = {}): void {
  process.env = {
    ...originalEnv,
    NODE_ENV: 'test',
    ...overrides,
  };
}

function clearRedisEnvVars(): void {
  delete process.env.REDIS_URL;
}

// =============================================================================
// Tests
// =============================================================================

describe('validateEnvironment()', () => {
  let mockLogger: MockLogger;

  beforeEach(() => {
    mockLogger = createMockLogger();
    mockExitWithConfigError.mockClear();
    setupTestEnv();
    clearRedisEnvVars();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ---------------------------------------------------------------------------
  // NODE_ENV=test bypass
  // ---------------------------------------------------------------------------

  describe('NODE_ENV=test bypass', () => {
    it('should skip all validation when NODE_ENV is test', () => {
      // NODE_ENV=test, no REDIS_URL
      process.env.NODE_ENV = 'test';
      delete process.env.REDIS_URL;

      validateEnvironment('solana-native', mockLogger as ReturnType<typeof mockCreateLogger>);

      expect(mockExitWithConfigError).not.toHaveBeenCalled();
    });

    it('should skip validation even with missing REDIS_URL when NODE_ENV is test', () => {
      process.env.NODE_ENV = 'test';
      delete process.env.REDIS_URL;

      validateEnvironment('solana-native', mockLogger as ReturnType<typeof mockCreateLogger>);

      expect(mockExitWithConfigError).not.toHaveBeenCalled();
    });

    it('should skip validation even with invalid REDIS_URL when NODE_ENV is test', () => {
      process.env.NODE_ENV = 'test';
      process.env.REDIS_URL = 'http://invalid-protocol:6379';

      validateEnvironment('solana-native', mockLogger as ReturnType<typeof mockCreateLogger>);

      expect(mockExitWithConfigError).not.toHaveBeenCalled();
    });

    it('should skip validation even with malformed REDIS_URL when NODE_ENV is test', () => {
      process.env.NODE_ENV = 'test';
      process.env.REDIS_URL = 'not-a-url-at-all';

      validateEnvironment('solana-native', mockLogger as ReturnType<typeof mockCreateLogger>);

      expect(mockExitWithConfigError).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Missing REDIS_URL in non-test env
  // ---------------------------------------------------------------------------

  describe('Missing REDIS_URL in non-test environments', () => {
    it('should call exitWithConfigError when REDIS_URL is missing in development', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.REDIS_URL;

      validateEnvironment('solana-native', mockLogger as ReturnType<typeof mockCreateLogger>);

      expect(mockExitWithConfigError).toHaveBeenCalledTimes(1);
      expect(mockExitWithConfigError).toHaveBeenCalledWith(
        'REDIS_URL environment variable is required',
        expect.objectContaining({
          partitionId: 'solana-native',
          hint: expect.any(String),
        }),
        mockLogger
      );
    });

    it('should call exitWithConfigError when REDIS_URL is missing in production', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.REDIS_URL;

      validateEnvironment('solana-native', mockLogger as ReturnType<typeof mockCreateLogger>);

      expect(mockExitWithConfigError).toHaveBeenCalledTimes(1);
      expect(mockExitWithConfigError).toHaveBeenCalledWith(
        'REDIS_URL environment variable is required',
        expect.objectContaining({ partitionId: 'solana-native' }),
        mockLogger
      );
    });

    it('should include partitionId in error context', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.REDIS_URL;

      validateEnvironment('custom-partition', mockLogger as ReturnType<typeof mockCreateLogger>);

      expect(mockExitWithConfigError).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ partitionId: 'custom-partition' }),
        mockLogger
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Valid REDIS_URL protocols
  // ---------------------------------------------------------------------------

  describe('Valid REDIS_URL protocols', () => {
    it('should accept redis:// protocol without calling exitWithConfigError', () => {
      process.env.NODE_ENV = 'development';
      process.env.REDIS_URL = 'redis://localhost:6379';

      validateEnvironment('solana-native', mockLogger as ReturnType<typeof mockCreateLogger>);

      expect(mockExitWithConfigError).not.toHaveBeenCalled();
    });

    it('should accept rediss:// protocol (TLS)', () => {
      process.env.NODE_ENV = 'development';
      process.env.REDIS_URL = 'rediss://secure-redis.example.com:6380';

      validateEnvironment('solana-native', mockLogger as ReturnType<typeof mockCreateLogger>);

      expect(mockExitWithConfigError).not.toHaveBeenCalled();
    });

    it('should accept redis+sentinel:// protocol', () => {
      process.env.NODE_ENV = 'development';
      process.env.REDIS_URL = 'redis+sentinel://sentinel-host:26379';

      validateEnvironment('solana-native', mockLogger as ReturnType<typeof mockCreateLogger>);

      expect(mockExitWithConfigError).not.toHaveBeenCalled();
    });

    it('should accept redis:// with authentication', () => {
      process.env.NODE_ENV = 'development';
      process.env.REDIS_URL = 'redis://user:password@localhost:6379';

      validateEnvironment('solana-native', mockLogger as ReturnType<typeof mockCreateLogger>);

      expect(mockExitWithConfigError).not.toHaveBeenCalled();
    });

    it('should accept rediss:// with path and database number', () => {
      process.env.NODE_ENV = 'production';
      process.env.REDIS_URL = 'rediss://user:pass@redis.example.com:6380/0';

      validateEnvironment('solana-native', mockLogger as ReturnType<typeof mockCreateLogger>);

      expect(mockExitWithConfigError).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Invalid REDIS_URL protocols
  // ---------------------------------------------------------------------------

  describe('Invalid REDIS_URL protocols', () => {
    it('should call exitWithConfigError for http:// protocol', () => {
      process.env.NODE_ENV = 'development';
      process.env.REDIS_URL = 'http://localhost:6379';

      validateEnvironment('solana-native', mockLogger as ReturnType<typeof mockCreateLogger>);

      expect(mockExitWithConfigError).toHaveBeenCalledTimes(1);
      expect(mockExitWithConfigError).toHaveBeenCalledWith(
        'REDIS_URL has invalid protocol',
        expect.objectContaining({
          partitionId: 'solana-native',
          protocol: 'http:',
          validProtocols: ['redis:', 'rediss:', 'redis+sentinel:'],
          hint: expect.any(String),
        }),
        mockLogger
      );
    });

    it('should call exitWithConfigError for https:// protocol', () => {
      process.env.NODE_ENV = 'development';
      process.env.REDIS_URL = 'https://redis.example.com:6379';

      validateEnvironment('solana-native', mockLogger as ReturnType<typeof mockCreateLogger>);

      expect(mockExitWithConfigError).toHaveBeenCalledTimes(1);
      expect(mockExitWithConfigError).toHaveBeenCalledWith(
        'REDIS_URL has invalid protocol',
        expect.objectContaining({
          protocol: 'https:',
        }),
        mockLogger
      );
    });

    it('should call exitWithConfigError for ftp:// protocol', () => {
      process.env.NODE_ENV = 'production';
      process.env.REDIS_URL = 'ftp://redis-host:6379';

      validateEnvironment('solana-native', mockLogger as ReturnType<typeof mockCreateLogger>);

      expect(mockExitWithConfigError).toHaveBeenCalledTimes(1);
      expect(mockExitWithConfigError).toHaveBeenCalledWith(
        'REDIS_URL has invalid protocol',
        expect.objectContaining({
          protocol: 'ftp:',
        }),
        mockLogger
      );
    });

    it('should include validProtocols list in error context', () => {
      process.env.NODE_ENV = 'development';
      process.env.REDIS_URL = 'ws://redis-host:6379';

      validateEnvironment('solana-native', mockLogger as ReturnType<typeof mockCreateLogger>);

      expect(mockExitWithConfigError).toHaveBeenCalledWith(
        'REDIS_URL has invalid protocol',
        expect.objectContaining({
          validProtocols: ['redis:', 'rediss:', 'redis+sentinel:'],
        }),
        mockLogger
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Malformed REDIS_URL
  // ---------------------------------------------------------------------------

  describe('Malformed REDIS_URL (invalid URL format)', () => {
    it('should call exitWithConfigError for completely invalid URL', () => {
      process.env.NODE_ENV = 'development';
      process.env.REDIS_URL = 'not-a-url';

      validateEnvironment('solana-native', mockLogger as ReturnType<typeof mockCreateLogger>);

      expect(mockExitWithConfigError).toHaveBeenCalledTimes(1);
      expect(mockExitWithConfigError).toHaveBeenCalledWith(
        'REDIS_URL is not a valid URL',
        expect.objectContaining({
          partitionId: 'solana-native',
          hint: expect.any(String),
        }),
        mockLogger
      );
    });

    it('should call exitWithConfigError for URL with no protocol (parsed as localhost: protocol)', () => {
      process.env.NODE_ENV = 'development';
      // Note: 'localhost:6379' is parsed by `new URL()` as protocol='localhost:',
      // which is not invalid as a URL but IS an invalid Redis protocol
      process.env.REDIS_URL = 'localhost:6379';

      validateEnvironment('solana-native', mockLogger as ReturnType<typeof mockCreateLogger>);

      expect(mockExitWithConfigError).toHaveBeenCalledTimes(1);
      expect(mockExitWithConfigError).toHaveBeenCalledWith(
        'REDIS_URL has invalid protocol',
        expect.objectContaining({
          partitionId: 'solana-native',
          protocol: 'localhost:',
        }),
        mockLogger
      );
    });

    it('should call exitWithConfigError for random string', () => {
      process.env.NODE_ENV = 'production';
      process.env.REDIS_URL = '!!!invalid!!!';

      validateEnvironment('solana-native', mockLogger as ReturnType<typeof mockCreateLogger>);

      expect(mockExitWithConfigError).toHaveBeenCalledTimes(1);
      expect(mockExitWithConfigError).toHaveBeenCalledWith(
        'REDIS_URL is not a valid URL',
        expect.objectContaining({ partitionId: 'solana-native' }),
        mockLogger
      );
    });

    it('should not include the actual URL in the error context (security)', () => {
      process.env.NODE_ENV = 'development';
      process.env.REDIS_URL = 'bad-url-with-password';

      validateEnvironment('solana-native', mockLogger as ReturnType<typeof mockCreateLogger>);

      const errorContext = mockExitWithConfigError.mock.calls[0][1];
      // The URL should not be logged (may contain credentials)
      expect(JSON.stringify(errorContext)).not.toContain('bad-url-with-password');
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('Edge cases', () => {
    it('should handle empty REDIS_URL string as missing (falsy)', () => {
      process.env.NODE_ENV = 'development';
      process.env.REDIS_URL = '';

      validateEnvironment('solana-native', mockLogger as ReturnType<typeof mockCreateLogger>);

      // Empty string is falsy, so it's treated as missing
      expect(mockExitWithConfigError).toHaveBeenCalledWith(
        'REDIS_URL environment variable is required',
        expect.any(Object),
        mockLogger
      );
    });

    it('should work with any partitionId string', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.REDIS_URL;

      validateEnvironment('my-custom-partition-123', mockLogger as ReturnType<typeof mockCreateLogger>);

      expect(mockExitWithConfigError).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ partitionId: 'my-custom-partition-123' }),
        mockLogger
      );
    });

    it('should pass the logger to exitWithConfigError', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.REDIS_URL;

      const specificLogger = createMockLogger();
      validateEnvironment('solana-native', specificLogger as ReturnType<typeof mockCreateLogger>);

      expect(mockExitWithConfigError).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        specificLogger
      );
    });

    it('should handle NODE_ENV=undefined as non-test (triggers validation)', () => {
      delete process.env.NODE_ENV;
      delete process.env.REDIS_URL;

      validateEnvironment('solana-native', mockLogger as ReturnType<typeof mockCreateLogger>);

      // NODE_ENV undefined !== 'test', so validation runs
      expect(mockExitWithConfigError).toHaveBeenCalledWith(
        'REDIS_URL environment variable is required',
        expect.any(Object),
        mockLogger
      );
    });
  });
});
