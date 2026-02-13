/**
 * Tests for Lifecycle Utilities
 *
 * Validates safe interval/timeout clearing and stopAndNullify.
 *
 * @see shared/core/src/lifecycle-utils.ts
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import {
  clearIntervalSafe,
  clearTimeoutSafe,
  stopAndNullify,
} from '../../src/lifecycle-utils';

describe('lifecycle-utils', () => {
  // ===========================================================================
  // clearIntervalSafe
  // ===========================================================================

  describe('clearIntervalSafe', () => {
    it('clears an active interval and returns null', () => {
      const interval = setInterval(() => {}, 10000);
      const result = clearIntervalSafe(interval);
      expect(result).toBeNull();
    });

    it('returns null when called with null (no-op)', () => {
      const result = clearIntervalSafe(null);
      expect(result).toBeNull();
    });

    it('can be used for direct assignment pattern', () => {
      let interval: NodeJS.Timeout | null = setInterval(() => {}, 10000);
      interval = clearIntervalSafe(interval);
      expect(interval).toBeNull();
    });
  });

  // ===========================================================================
  // clearTimeoutSafe
  // ===========================================================================

  describe('clearTimeoutSafe', () => {
    it('clears an active timeout and returns null', () => {
      const timeout = setTimeout(() => {}, 10000);
      const result = clearTimeoutSafe(timeout);
      expect(result).toBeNull();
    });

    it('returns null when called with null (no-op)', () => {
      const result = clearTimeoutSafe(null);
      expect(result).toBeNull();
    });

    it('can be used for direct assignment pattern', () => {
      let timeout: NodeJS.Timeout | null = setTimeout(() => {}, 10000);
      timeout = clearTimeoutSafe(timeout);
      expect(timeout).toBeNull();
    });
  });

  // ===========================================================================
  // stopAndNullify
  // ===========================================================================

  describe('stopAndNullify', () => {
    it('calls stop() on the object and returns null', async () => {
      const mockObj = { stop: jest.fn<() => void>() };
      const result = await stopAndNullify(mockObj);
      expect(mockObj.stop).toHaveBeenCalledTimes(1);
      expect(result).toBeNull();
    });

    it('handles async stop() correctly', async () => {
      let stopped = false;
      const mockObj = {
        stop: jest.fn<() => Promise<void>>(async () => {
          stopped = true;
        }),
      };
      const result = await stopAndNullify(mockObj);
      expect(stopped).toBe(true);
      expect(result).toBeNull();
    });

    it('returns null when called with null (no-op)', async () => {
      const result = await stopAndNullify(null);
      expect(result).toBeNull();
    });

    it('propagates errors thrown by stop()', async () => {
      const mockObj = {
        stop: jest.fn<() => Promise<void>>().mockRejectedValue(new Error('stop failed')),
      };
      await expect(stopAndNullify(mockObj)).rejects.toThrow('stop failed');
    });

    it('can be used for direct assignment pattern', async () => {
      let ref: { stop(): void } | null = { stop: jest.fn<() => void>() };
      ref = await stopAndNullify(ref);
      expect(ref).toBeNull();
    });
  });
});
