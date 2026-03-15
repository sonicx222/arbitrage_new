/**
 * P1-3 FIX: BridgeRecoveryService Unit Tests
 *
 * Tests for the bridge recovery service that handles persistence,
 * status updates, and recovery of pending bridge transactions.
 * This is security-critical code handling real fund recovery.
 *
 * @see services/execution-engine/src/strategies/bridge-recovery-service.ts
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import {
  BridgeRecoveryService,
  type BridgeRecoveryDelegate,
} from '../../../src/strategies/bridge-recovery-service';
import type { BridgeRecoveryState, Logger } from '../../../src/types';
import {
  BRIDGE_RECOVERY_KEY_PREFIX,
} from '../../../src/types';

// Mock HMAC utilities
jest.mock('@arbitrage/core/utils', () => ({
  hmacSign: jest.fn((data: unknown, _key: string, _context?: string) => ({
    data,
    sig: 'mock-hmac-sig',
    alg: 'sha256',
  })),
  hmacVerify: jest.fn((envelope: { data: unknown }) => envelope.data),
  getHmacSigningKey: jest.fn(() => 'mock-signing-key'),
  isSignedEnvelope: jest.fn((obj: unknown) =>
    obj !== null && typeof obj === 'object' && 'sig' in (obj as Record<string, unknown>)
  ),
}));

jest.mock('@arbitrage/core/resilience', () => ({
  getErrorMessage: jest.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
}));

// =============================================================================
// Test Helpers
// =============================================================================

function createMockLogger(): Logger {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as Logger;
}

function createMockRedis() {
  return {
    set: jest.fn<(key: string, value: unknown, ttl?: number) => Promise<string>>().mockResolvedValue('OK'),
    get: jest.fn<(key: string) => Promise<unknown>>().mockResolvedValue(null),
    del: jest.fn<(key: string) => Promise<number>>().mockResolvedValue(1),
    scan: jest.fn<(...args: unknown[]) => Promise<[string, string[]]>>().mockResolvedValue(['0', []]),
  };
}

function createMockDelegate(): BridgeRecoveryDelegate {
  return {
    prepareDexSwapTransaction: jest.fn<BridgeRecoveryDelegate['prepareDexSwapTransaction']>()
      .mockResolvedValue({ to: '0x1234', data: '0x5678' }),
    estimateTradeSizeUsd: jest.fn<BridgeRecoveryDelegate['estimateTradeSizeUsd']>()
      .mockReturnValue(1000),
  };
}

function createMockBridgeState(overrides?: Partial<BridgeRecoveryState>): BridgeRecoveryState {
  return {
    opportunityId: 'opp-1',
    bridgeId: 'bridge-1',
    sourceTxHash: '0xabc',
    sourceChain: 'ethereum',
    destChain: 'arbitrum',
    bridgeToken: 'USDC',
    bridgeAmount: '1000000000',
    sellDex: 'uniswap-v3',
    expectedProfit: 50,
    tokenIn: 'WETH',
    tokenOut: 'USDC',
    initiatedAt: Date.now() - 60000, // 1 minute ago
    bridgeProtocol: 'stargate',
    status: 'pending',
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('BridgeRecoveryService', () => {
  let service: BridgeRecoveryService;
  let logger: Logger;
  let delegate: BridgeRecoveryDelegate;
  let redis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    jest.clearAllMocks();

    // Re-apply mock implementations cleared by resetMocks: true in jest.config.base.js
    const coreUtils = jest.requireMock('@arbitrage/core/utils') as Record<string, jest.Mock>;
    coreUtils.hmacSign.mockImplementation((data: unknown, _key: string, _context?: string) => ({
      data,
      sig: 'mock-hmac-sig',
      alg: 'sha256',
    }));
    coreUtils.hmacVerify.mockImplementation((envelope: { data: unknown }) => envelope.data);
    coreUtils.getHmacSigningKey.mockReturnValue('mock-signing-key');
    coreUtils.isSignedEnvelope.mockImplementation((obj: unknown) =>
      obj !== null && typeof obj === 'object' && 'sig' in (obj as Record<string, unknown>)
    );

    const coreResilience = jest.requireMock('@arbitrage/core/resilience') as Record<string, jest.Mock>;
    coreResilience.getErrorMessage.mockImplementation((e: unknown) =>
      e instanceof Error ? e.message : String(e)
    );

    logger = createMockLogger();
    delegate = createMockDelegate();
    redis = createMockRedis();
    service = new BridgeRecoveryService(logger, delegate);
  });

  describe('persistState', () => {
    it('should persist HMAC-signed state to Redis with protocol-aware TTL', async () => {
      const state = createMockBridgeState();

      await service.persistState(state, redis as any);

      expect(redis.set).toHaveBeenCalledWith(
        `${BRIDGE_RECOVERY_KEY_PREFIX}bridge-1`,
        expect.objectContaining({ sig: 'mock-hmac-sig' }),
        expect.any(Number),
      );
      expect(logger.debug).toHaveBeenCalledWith(
        'Persisted bridge recovery state',
        expect.objectContaining({ bridgeId: 'bridge-1' }),
      );
    });

    it('should log warning but not throw on Redis error', async () => {
      const state = createMockBridgeState();
      redis.set.mockRejectedValue(new Error('Redis connection refused'));

      await service.persistState(state, redis as any);

      expect(logger.warn).toHaveBeenCalledWith(
        'Failed to persist bridge recovery state',
        expect.objectContaining({ bridgeId: 'bridge-1' }),
      );
    });

    it('should use correct key prefix for bridge recovery', async () => {
      const state = createMockBridgeState({ bridgeId: 'br-unique-123' });

      await service.persistState(state, redis as any);

      expect(redis.set).toHaveBeenCalledWith(
        'bridge:recovery:br-unique-123',
        expect.any(Object),
        expect.any(Number),
      );
    });
  });

  describe('updateStatus', () => {
    it('should update status of existing HMAC-signed state', async () => {
      const state = createMockBridgeState();
      redis.get.mockResolvedValue({ data: state, sig: 'valid-sig', alg: 'sha256' });

      await service.updateStatus('bridge-1', 'recovered', redis as any);

      expect(redis.set).toHaveBeenCalledWith(
        `${BRIDGE_RECOVERY_KEY_PREFIX}bridge-1`,
        expect.objectContaining({ sig: 'mock-hmac-sig' }),
        expect.any(Number),
      );
    });

    it('should warn when state not found in Redis', async () => {
      redis.get.mockResolvedValue(null);

      await service.updateStatus('bridge-nonexistent', 'failed', redis as any);

      expect(logger.warn).toHaveBeenCalledWith(
        'Cannot update bridge recovery status - state not found or corrupt',
        expect.objectContaining({ bridgeId: 'bridge-nonexistent' }),
      );
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('should include error message for failed status', async () => {
      const state = createMockBridgeState();
      redis.get.mockResolvedValue({ data: state, sig: 'valid-sig', alg: 'sha256' });

      await service.updateStatus('bridge-1', 'failed', redis as any, 'Sell transaction reverted');

      // The state passed to set should have the error message
      const setCall = redis.set.mock.calls[0];
      const signedEnvelope = setCall?.[1] as { data: BridgeRecoveryState };
      expect(signedEnvelope.data.status).toBe('failed');
      expect(signedEnvelope.data.errorMessage).toBe('Sell transaction reverted');
    });

    it('should handle Redis error gracefully', async () => {
      redis.get.mockRejectedValue(new Error('Timeout'));

      await service.updateStatus('bridge-1', 'failed', redis as any);

      expect(logger.warn).toHaveBeenCalledWith(
        'Failed to update bridge recovery status',
        expect.objectContaining({ bridgeId: 'bridge-1' }),
      );
    });
  });

  describe('recoverPendingBridges', () => {
    it('should return 0 when no pending bridges found', async () => {
      redis.scan.mockResolvedValue(['0', []]);

      const ctx = { bridgeRouterFactory: null } as any;
      const result = await service.recoverPendingBridges(ctx, redis as any);

      expect(result).toBe(0);
      expect(logger.debug).toHaveBeenCalledWith('No pending bridges to recover');
    });

    it('should skip already recovered bridges', async () => {
      const recoveredState = createMockBridgeState({ status: 'recovered' });
      redis.scan.mockResolvedValue(['0', ['bridge:recovery:bridge-1']]);
      redis.get.mockResolvedValue({ data: recoveredState, sig: 'valid-sig', alg: 'sha256' });

      const ctx = { bridgeRouterFactory: null } as any;
      const result = await service.recoverPendingBridges(ctx, redis as any);

      expect(result).toBe(0);
    });

    it('should skip expired bridges and mark as failed', async () => {
      const expiredState = createMockBridgeState({
        initiatedAt: Date.now() - (73 * 60 * 60 * 1000), // 73 hours ago (> 72h default)
      });
      redis.scan.mockResolvedValue(['0', ['bridge:recovery:bridge-1']]);
      redis.get.mockResolvedValue({ data: expiredState, sig: 'valid-sig', alg: 'sha256' });

      const ctx = { bridgeRouterFactory: null } as any;
      const result = await service.recoverPendingBridges(ctx, redis as any);

      expect(result).toBe(0);
      expect(logger.warn).toHaveBeenCalledWith(
        'Bridge recovery state expired',
        expect.objectContaining({ bridgeId: 'bridge-1' }),
      );
    });

    it('should exclude corrupt dead-letter keys from scan results', async () => {
      redis.scan.mockResolvedValue(['0', [
        'bridge:recovery:bridge-1',
        'bridge:recovery:corrupt:bridge-2', // SA-107: should be filtered
      ]]);
      const state = createMockBridgeState({ status: 'recovered' });
      redis.get.mockResolvedValue({ data: state, sig: 'valid-sig', alg: 'sha256' });

      const ctx = { bridgeRouterFactory: null } as any;
      await service.recoverPendingBridges(ctx, redis as any);

      // Only bridge-1 should be fetched, not the corrupt key
      expect(redis.get).toHaveBeenCalledTimes(1);
      expect(redis.get).toHaveBeenCalledWith('bridge:recovery:bridge-1');
    });

    it('should delete corrupt (non-object) recovery data', async () => {
      redis.scan.mockResolvedValue(['0', ['bridge:recovery:bridge-1']]);
      redis.get.mockResolvedValue('corrupt-string-data');

      const ctx = { bridgeRouterFactory: null } as any;
      await service.recoverPendingBridges(ctx, redis as any);

      expect(redis.del).toHaveBeenCalledWith('bridge:recovery:bridge-1');
      expect(logger.warn).toHaveBeenCalledWith(
        'Corrupt bridge recovery state during scan, deleting key',
        expect.objectContaining({ key: 'bridge:recovery:bridge-1' }),
      );
    });

    it('should handle scan errors gracefully and return partial count', async () => {
      redis.scan.mockRejectedValue(new Error('Redis cluster failover'));

      const ctx = { bridgeRouterFactory: null } as any;
      const result = await service.recoverPendingBridges(ctx, redis as any);

      expect(result).toBe(0);
      expect(logger.error).toHaveBeenCalledWith(
        'Bridge recovery scan failed',
        expect.objectContaining({ error: 'Redis cluster failover' }),
      );
    });
  });
});
