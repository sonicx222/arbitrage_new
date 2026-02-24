/**
 * Tests for Disconnect Utilities
 *
 * Validates timeout-guarded disconnect for various client types.
 *
 * @see shared/core/src/disconnect-utils.ts
 */

import { jest, describe, it, expect } from '@jest/globals';
import { disconnectWithTimeout } from '../../src/utils/disconnect-utils';

describe('disconnect-utils', () => {
  const createMockLogger = () => ({
    warn: jest.fn(),
  });

  describe('disconnectWithTimeout', () => {
    it('is a no-op when client is null', async () => {
      const logger = createMockLogger();
      await disconnectWithTimeout(null, 'NullClient', 5000, logger);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('is a no-op when client is undefined', async () => {
      const logger = createMockLogger();
      await disconnectWithTimeout(undefined, 'UndefinedClient', 5000, logger);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('calls disconnect() on a client with disconnect method', async () => {
      const logger = createMockLogger();
      const client = { disconnect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined) };

      await disconnectWithTimeout(client, 'TestClient', 5000, logger);

      expect(client.disconnect).toHaveBeenCalledTimes(1);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('calls shutdown() on a client with shutdown method', async () => {
      const logger = createMockLogger();
      const client = { shutdown: jest.fn<() => Promise<void>>().mockResolvedValue(undefined) };

      await disconnectWithTimeout(client, 'TestClient', 5000, logger);

      expect(client.shutdown).toHaveBeenCalledTimes(1);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('handles synchronous disconnect() that returns void', async () => {
      const logger = createMockLogger();
      const client = { disconnect: jest.fn<() => void>() };

      await disconnectWithTimeout(client, 'SyncClient', 5000, logger);

      expect(client.disconnect).toHaveBeenCalledTimes(1);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('handles synchronous shutdown() that returns void', async () => {
      const logger = createMockLogger();
      const client = { shutdown: jest.fn<() => void>() };

      await disconnectWithTimeout(client, 'SyncShutdownClient', 5000, logger);

      expect(client.shutdown).toHaveBeenCalledTimes(1);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('logs warning when disconnect times out', async () => {
      const logger = createMockLogger();
      const client = {
        disconnect: jest.fn<() => Promise<void>>().mockImplementation(
          () => new Promise(() => {}) // never resolves
        ),
      };

      await disconnectWithTimeout(client, 'SlowClient', 50, logger);

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        'SlowClient disconnect timeout or error',
        expect.objectContaining({ error: expect.stringContaining('disconnect timeout') })
      );
    });

    it('logs warning when disconnect throws an error', async () => {
      const logger = createMockLogger();
      const client = {
        disconnect: jest.fn<() => Promise<void>>().mockRejectedValue(new Error('Connection reset')),
      };

      await disconnectWithTimeout(client, 'FailClient', 5000, logger);

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        'FailClient disconnect timeout or error',
        expect.objectContaining({ error: 'Connection reset' })
      );
    });

    it('prefers disconnect over shutdown when both exist', async () => {
      const logger = createMockLogger();
      const client = {
        disconnect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        shutdown: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      };

      await disconnectWithTimeout(client, 'DualClient', 5000, logger);

      // 'disconnect' in client is true, so disconnect should be called
      expect(client.disconnect).toHaveBeenCalledTimes(1);
      expect(client.shutdown).not.toHaveBeenCalled();
    });

    it('includes client name in the timeout error message', async () => {
      const logger = createMockLogger();
      const client = {
        disconnect: jest.fn<() => Promise<void>>().mockImplementation(
          () => new Promise(() => {}) // never resolves
        ),
      };

      await disconnectWithTimeout(client, 'MyRedisClient', 50, logger);

      expect(logger.warn).toHaveBeenCalledWith(
        'MyRedisClient disconnect timeout or error',
        expect.objectContaining({ error: 'MyRedisClient disconnect timeout' })
      );
    });
  });
});
