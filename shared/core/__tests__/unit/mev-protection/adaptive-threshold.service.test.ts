/**
 * Unit tests for AdaptiveThresholdService
 *
 * Task 3.2: Adaptive Risk Scoring
 * Tests for historical MEV attack tracking and threshold adaptation
 */

// Mock logger to suppress console output
jest.mock('../../../src/logger');

// Mock Redis client
const mockRedis = {
  zadd: jest.fn().mockResolvedValue(1),
  zremrangebyscore: jest.fn().mockResolvedValue(0),
  zcard: jest.fn().mockResolvedValue(0),
  zpopmin: jest.fn().mockResolvedValue([]),
  expire: jest.fn().mockResolvedValue(1),
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
  scanStream: jest.fn().mockReturnValue({
    [Symbol.asyncIterator]: async function* () {
      yield [];
    },
  }),
  zrangebyscore: jest.fn().mockResolvedValue([]),
};

// Mock Redis BEFORE service import
// The source code does: (client as unknown as { client: Redis }).client
// So getRedisClient must return an object with a `client` property.
jest.mock('../../../src/redis/client', () => ({
  getRedisClient: () => Promise.resolve({ client: mockRedis })
}));

import {
  AdaptiveThresholdService,
  SandwichAttackEvent,
  ThresholdAdjustment,
  ADAPTIVE_THRESHOLD_DEFAULTS,
} from '../../../src/mev-protection/adaptive-threshold.service';

describe('AdaptiveThresholdService', () => {
  let service: AdaptiveThresholdService;

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset scanStream mock after clearAllMocks
    mockRedis.scanStream.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield [];
      },
    });

    service = new AdaptiveThresholdService({ enabled: true });
  });

  // ===========================================================================
  // Configuration Tests
  // ===========================================================================

  describe('Configuration', () => {
    it('should use default configuration', () => {
      const defaultService = new AdaptiveThresholdService();
      expect(defaultService).toBeDefined();
    });

    it('should accept custom configuration', () => {
      const customService = new AdaptiveThresholdService({
        enabled: true,
        attackThreshold: 3,
        reductionPercent: 0.5,
      });
      expect(customService).toBeDefined();
    });

    it('should not operate when disabled', async () => {
      const disabledService = new AdaptiveThresholdService({ enabled: false });

      await disabledService.recordAttack({
        chain: 'ethereum',
        dex: 'uniswap_v2',
        ourTxHash: '0x123',
        frontRunTxHash: '0x456',
        backRunTxHash: '0x789',
        mevExtractedUsd: 100,
      });

      expect(mockRedis.zadd).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Record Attack Tests
  // ===========================================================================

  describe('recordAttack', () => {
    it('should record sandwich attack event to Redis', async () => {
      const event = {
        chain: 'ethereum',
        dex: 'uniswap_v2',
        ourTxHash: '0xabc',
        frontRunTxHash: '0xdef',
        backRunTxHash: '0x123',
        mevExtractedUsd: 150,
      };

      await service.recordAttack(event);

      // Verify ZADD called with timestamp and event data
      expect(mockRedis.zadd).toHaveBeenCalledWith(
        'adaptive:sandwich_attacks',
        expect.any(Number), // timestamp
        expect.stringContaining('"chain":"ethereum"')
      );

      // Verify retention pruning called
      expect(mockRedis.zremrangebyscore).toHaveBeenCalled();

      // Verify count check for FIFO pruning
      expect(mockRedis.zcard).toHaveBeenCalled();

      // Verify TTL set
      expect(mockRedis.expire).toHaveBeenCalled();
    });

    it('should prune events beyond max count (FIFO)', async () => {
      // Mock Redis to return count > maxEvents
      mockRedis.zcard.mockResolvedValueOnce(10001);

      await service.recordAttack({
        chain: 'ethereum',
        dex: 'uniswap_v2',
        ourTxHash: '0x123',
        frontRunTxHash: '0x456',
        backRunTxHash: '0x789',
        mevExtractedUsd: 100,
      });

      // Verify ZPOPMIN called to remove oldest events
      expect(mockRedis.zpopmin).toHaveBeenCalledWith(
        'adaptive:sandwich_attacks',
        1 // Remove 1 event to get back to 10000
      );
    });

    it('should not prune when under max count', async () => {
      // Mock Redis to return count < maxEvents
      mockRedis.zcard.mockResolvedValueOnce(5000);

      await service.recordAttack({
        chain: 'ethereum',
        dex: 'uniswap_v2',
        ourTxHash: '0x123',
        frontRunTxHash: '0x456',
        backRunTxHash: '0x789',
        mevExtractedUsd: 100,
      });

      // Verify ZPOPMIN not called
      expect(mockRedis.zpopmin).not.toHaveBeenCalled();
    });

    it('should update threshold adjustment after recording', async () => {
      // Mock events to trigger threshold adjustment (WITHSCORES format)
      const attacks = Array(5).fill(null).map((_, i) => ({
        chain: 'ethereum',
        dex: 'uniswap_v2',
        timestamp: Date.now() - i * 1000,
      }));

      const mockEvents: any[] = [];
      attacks.forEach(a => {
        mockEvents.push(JSON.stringify(a));
        mockEvents.push(a.timestamp.toString());
      });

      mockRedis.zrangebyscore.mockResolvedValueOnce(mockEvents);

      await service.recordAttack({
        chain: 'ethereum',
        dex: 'uniswap_v2',
        ourTxHash: '0x123',
        frontRunTxHash: '0x456',
        backRunTxHash: '0x789',
        mevExtractedUsd: 100,
      });

      // Verify adjustment stored in Redis
      expect(mockRedis.set).toHaveBeenCalledWith(
        'adaptive:threshold_adjustments:ethereum:uniswap_v2',
        expect.stringContaining('"profitMultiplier"'),
        'EX',
        expect.any(Number)
      );
    });

    it('should throw on Redis write error', async () => {
      mockRedis.zadd.mockRejectedValueOnce(new Error('Redis error'));

      await expect(
        service.recordAttack({
          chain: 'ethereum',
          dex: 'uniswap_v2',
          ourTxHash: '0x123',
          frontRunTxHash: '0x456',
          backRunTxHash: '0x789',
          mevExtractedUsd: 100,
        })
      ).rejects.toThrow('Redis error');
    });
  });

  // ===========================================================================
  // Get Adjustment Tests
  // ===========================================================================

  describe('getAdjustment', () => {
    it('should return default adjustment when no attacks recorded', async () => {
      mockRedis.get.mockResolvedValueOnce(null);

      const adjustment = await service.getAdjustment('ethereum', 'uniswap_v2');

      expect(adjustment).toMatchObject({
        chain: 'ethereum',
        dex: 'uniswap_v2',
        profitMultiplier: 1.0,
        slippageMultiplier: 1.0,
        attackCount: 0,
      });
    });

    it('should return cached adjustment if valid', async () => {
      const cachedAdjustment: ThresholdAdjustment = {
        chain: 'ethereum',
        dex: 'uniswap_v2',
        profitMultiplier: 0.7,
        slippageMultiplier: 0.7,
        attackCount: 5,
        lastAttackTimestamp: Date.now() - 1000,
        expiresAt: Date.now() + 10000,
      };

      mockRedis.get.mockResolvedValueOnce(JSON.stringify(cachedAdjustment));

      const adjustment = await service.getAdjustment('ethereum', 'uniswap_v2');

      expect(adjustment.profitMultiplier).toBeCloseTo(0.7, 1);
      expect(adjustment.slippageMultiplier).toBeCloseTo(0.7, 1);
      expect(adjustment.attackCount).toBe(5);
    });

    it('should return default when adjustment expired', async () => {
      const expiredAdjustment: ThresholdAdjustment = {
        chain: 'ethereum',
        dex: 'uniswap_v2',
        profitMultiplier: 0.7,
        slippageMultiplier: 0.7,
        attackCount: 5,
        lastAttackTimestamp: Date.now() - 100000,
        expiresAt: Date.now() - 1000, // Expired
      };

      mockRedis.get.mockResolvedValueOnce(JSON.stringify(expiredAdjustment));

      const adjustment = await service.getAdjustment('ethereum', 'uniswap_v2');

      expect(adjustment.profitMultiplier).toBe(1.0);
      expect(adjustment.slippageMultiplier).toBe(1.0);
    });

    it('should apply decay when last attack is old', async () => {
      const now = Date.now();
      const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;

      const adjustment: ThresholdAdjustment = {
        chain: 'ethereum',
        dex: 'uniswap_v2',
        profitMultiplier: 0.7,
        slippageMultiplier: 0.7,
        attackCount: 5,
        lastAttackTimestamp: twoDaysAgo,
        expiresAt: now + 10000,
      };

      mockRedis.get.mockResolvedValueOnce(JSON.stringify(adjustment));

      const result = await service.getAdjustment('ethereum', 'uniswap_v2');

      // After 2 days with 10% decay per day, should move from 0.7 toward 1.0
      // Decay amount = 0.1 * 2 = 0.2
      // New multiplier ≈ 0.7 + 0.2 * (1.0 - 0.7) = 0.7 + 0.06 = 0.76
      expect(result.profitMultiplier).toBeGreaterThan(0.7);
      expect(result.profitMultiplier).toBeLessThan(1.0);
    });

    it('should return default on Redis read error', async () => {
      mockRedis.get.mockRejectedValueOnce(new Error('Redis error'));

      const adjustment = await service.getAdjustment('ethereum', 'uniswap_v2');

      // Should not throw - returns default
      expect(adjustment.profitMultiplier).toBe(1.0);
      expect(adjustment.slippageMultiplier).toBe(1.0);
    });

    it('should return default when service disabled', async () => {
      const disabledService = new AdaptiveThresholdService({ enabled: false });

      const adjustment = await disabledService.getAdjustment('ethereum', 'uniswap_v2');

      expect(adjustment.profitMultiplier).toBe(1.0);
      expect(adjustment.slippageMultiplier).toBe(1.0);
      expect(mockRedis.get).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Get All Adjustments Tests
  // ===========================================================================

  describe('getAllAdjustments', () => {
    it('should return empty object when no adjustments', async () => {
      const adjustments = await service.getAllAdjustments();

      expect(adjustments).toEqual({});
    });

    it('should return all active adjustments', async () => {
      // Mock SCAN to return adjustment keys
      mockRedis.scanStream.mockReturnValueOnce({
        [Symbol.asyncIterator]: async function* () {
          yield ['adaptive:threshold_adjustments:ethereum:uniswap_v2'];
          yield ['adaptive:threshold_adjustments:bsc:pancakeswap'];
        },
      });

      const adjustment1: ThresholdAdjustment = {
        chain: 'ethereum',
        dex: 'uniswap_v2',
        profitMultiplier: 0.7,
        slippageMultiplier: 0.7,
        attackCount: 5,
        lastAttackTimestamp: Date.now(),
        expiresAt: Date.now() + 10000,
      };

      const adjustment2: ThresholdAdjustment = {
        chain: 'bsc',
        dex: 'pancakeswap',
        profitMultiplier: 0.8,
        slippageMultiplier: 0.8,
        attackCount: 3,
        lastAttackTimestamp: Date.now(),
        expiresAt: Date.now() + 10000,
      };

      mockRedis.get
        .mockResolvedValueOnce(JSON.stringify(adjustment1))
        .mockResolvedValueOnce(JSON.stringify(adjustment2));

      const adjustments = await service.getAllAdjustments();

      expect(adjustments).toHaveProperty('ethereum:uniswap_v2');
      expect(adjustments).toHaveProperty('bsc:pancakeswap');
      expect(adjustments['ethereum:uniswap_v2'].attackCount).toBe(5);
      expect(adjustments['bsc:pancakeswap'].attackCount).toBe(3);
    });

    it('should use SCAN instead of KEYS', async () => {
      await service.getAllAdjustments();

      expect(mockRedis.scanStream).toHaveBeenCalledWith({
        match: 'adaptive:threshold_adjustments:*',
        count: 100,
      });
    });

    it('should return empty on Redis error', async () => {
      mockRedis.scanStream.mockReturnValueOnce({
        [Symbol.asyncIterator]: async function* () {
          yield; // satisfy require-yield before throwing
          throw new Error('Redis error');
        },
      });

      const adjustments = await service.getAllAdjustments();

      expect(adjustments).toEqual({});
    });
  });

  // ===========================================================================
  // Clear Tests
  // ===========================================================================

  describe('clear', () => {
    it('should clear all attack events', async () => {
      await service.clear();

      expect(mockRedis.del).toHaveBeenCalledWith('adaptive:sandwich_attacks');
    });

    it('should clear all adjustment keys', async () => {
      mockRedis.scanStream.mockReturnValueOnce({
        [Symbol.asyncIterator]: async function* () {
          yield ['adaptive:threshold_adjustments:ethereum:uniswap_v2'];
        },
      });

      await service.clear();

      expect(mockRedis.del).toHaveBeenCalledWith(
        'adaptive:threshold_adjustments:ethereum:uniswap_v2'
      );
    });

    it('should throw on Redis error', async () => {
      mockRedis.del.mockRejectedValueOnce(new Error('Redis error'));

      await expect(service.clear()).rejects.toThrow('Redis error');
    });
  });

  // ===========================================================================
  // Threshold Calculation Tests
  // ===========================================================================

  describe('Threshold Calculation Logic', () => {
    it('should reduce thresholds by 30% after 5 attacks', async () => {
      // Record 5 attacks
      const attacks = Array(5).fill(null).map((_, i) => ({
        chain: 'ethereum',
        dex: 'uniswap_v2',
        timestamp: Date.now() - i * 1000,
      }));

      // Mock zrangebyscore to return [event, score, event, score, ...] (WITHSCORES format)
      const withScores: any[] = [];
      attacks.forEach(a => {
        withScores.push(JSON.stringify(a));
        withScores.push(a.timestamp.toString());
      });

      mockRedis.zrangebyscore.mockResolvedValueOnce(withScores);

      await service.recordAttack({
        chain: 'ethereum',
        dex: 'uniswap_v2',
        ourTxHash: '0x123',
        frontRunTxHash: '0x456',
        backRunTxHash: '0x789',
        mevExtractedUsd: 100,
      });

      // Verify adjustment stored with 0.7 multiplier
      const setCall = mockRedis.set.mock.calls.find((call: any) =>
        call[0] === 'adaptive:threshold_adjustments:ethereum:uniswap_v2'
      );

      expect(setCall).toBeDefined();
      const adjustmentData = JSON.parse(setCall![1]);
      expect(adjustmentData.profitMultiplier).toBe(0.7);
      expect(adjustmentData.slippageMultiplier).toBe(0.7);
    });

    it('should not reduce thresholds with fewer than 5 attacks', async () => {
      // Record 3 attacks
      const attacks = Array(3).fill(null).map((_, i) => ({
        chain: 'ethereum',
        dex: 'uniswap_v2',
        timestamp: Date.now() - i * 1000,
      }));

      // Mock zrangebyscore to return WITHSCORES format
      const withScores: any[] = [];
      attacks.forEach(a => {
        withScores.push(JSON.stringify(a));
        withScores.push(a.timestamp.toString());
      });

      mockRedis.zrangebyscore.mockResolvedValueOnce(withScores);

      await service.recordAttack({
        chain: 'ethereum',
        dex: 'uniswap_v2',
        ourTxHash: '0x123',
        frontRunTxHash: '0x456',
        backRunTxHash: '0x789',
        mevExtractedUsd: 100,
      });

      const setCall = mockRedis.set.mock.calls.find((call: any) =>
        call[0] === 'adaptive:threshold_adjustments:ethereum:uniswap_v2'
      );

      expect(setCall).toBeDefined();
      const adjustmentData = JSON.parse(setCall![1]);
      expect(adjustmentData.profitMultiplier).toBe(1.0);
      expect(adjustmentData.slippageMultiplier).toBe(1.0);
    });

    it('should only count attacks in active window (24h)', async () => {
      const now = Date.now();
      const attacks = [
        // Recent attacks (within 24h)
        { chain: 'ethereum', dex: 'uniswap_v2', timestamp: now - 1000 },
        { chain: 'ethereum', dex: 'uniswap_v2', timestamp: now - 10000 },
        // Old attacks (beyond 24h) - should be filtered
        { chain: 'ethereum', dex: 'uniswap_v2', timestamp: now - 25 * 60 * 60 * 1000 },
        { chain: 'ethereum', dex: 'uniswap_v2', timestamp: now - 30 * 60 * 60 * 1000 },
      ];

      // Mock zrangebyscore to return WITHSCORES format
      const withScores: any[] = [];
      attacks.forEach(a => {
        withScores.push(JSON.stringify(a));
        withScores.push(a.timestamp.toString());
      });

      mockRedis.zrangebyscore.mockResolvedValueOnce(withScores);

      await service.recordAttack({
        chain: 'ethereum',
        dex: 'uniswap_v2',
        ourTxHash: '0x123',
        frontRunTxHash: '0x456',
        backRunTxHash: '0x789',
        mevExtractedUsd: 100,
      });

      const setCall = mockRedis.set.mock.calls.find((call: any) =>
        call[0] === 'adaptive:threshold_adjustments:ethereum:uniswap_v2'
      );

      const adjustmentData = JSON.parse(setCall![1]);
      // Only 2 recent attacks, should not trigger reduction
      expect(adjustmentData.profitMultiplier).toBe(1.0);
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('Edge Cases', () => {
    it('should handle attacks from different DEXes independently', async () => {
      // Record attacks for uniswap
      const uniswapAttacks = Array(5).fill(null).map(() => ({
        chain: 'ethereum',
        dex: 'uniswap_v2',
        timestamp: Date.now(),
      }));

      // Record attacks for sushiswap
      const sushiswapAttacks = Array(2).fill(null).map(() => ({
        chain: 'ethereum',
        dex: 'sushiswap',
        timestamp: Date.now(),
      }));

      // Mock zrangebyscore to return WITHSCORES format
      const uniswapWithScores: any[] = [];
      uniswapAttacks.forEach(a => {
        uniswapWithScores.push(JSON.stringify(a));
        uniswapWithScores.push(a.timestamp.toString());
      });

      const sushiswapWithScores: any[] = [];
      sushiswapAttacks.forEach(a => {
        sushiswapWithScores.push(JSON.stringify(a));
        sushiswapWithScores.push(a.timestamp.toString());
      });

      mockRedis.zrangebyscore
        .mockResolvedValueOnce(uniswapWithScores)
        .mockResolvedValueOnce(sushiswapWithScores);

      await service.recordAttack({
        chain: 'ethereum',
        dex: 'uniswap_v2',
        ourTxHash: '0x111',
        frontRunTxHash: '0x222',
        backRunTxHash: '0x333',
        mevExtractedUsd: 100,
      });

      await service.recordAttack({
        chain: 'ethereum',
        dex: 'sushiswap',
        ourTxHash: '0x444',
        frontRunTxHash: '0x555',
        backRunTxHash: '0x666',
        mevExtractedUsd: 100,
      });

      // Verify separate adjustments
      expect(mockRedis.set).toHaveBeenCalledWith(
        'adaptive:threshold_adjustments:ethereum:uniswap_v2',
        expect.any(String),
        'EX',
        expect.any(Number)
      );

      expect(mockRedis.set).toHaveBeenCalledWith(
        'adaptive:threshold_adjustments:ethereum:sushiswap',
        expect.any(String),
        'EX',
        expect.any(Number)
      );
    });

    it('should handle very large MEV extracted values', async () => {
      await service.recordAttack({
        chain: 'ethereum',
        dex: 'uniswap_v2',
        ourTxHash: '0x123',
        frontRunTxHash: '0x456',
        backRunTxHash: '0x789',
        mevExtractedUsd: 1000000, // $1M
      });

      expect(mockRedis.zadd).toHaveBeenCalled();
    });

    it('should handle zero MEV extracted', async () => {
      await service.recordAttack({
        chain: 'ethereum',
        dex: 'uniswap_v2',
        ourTxHash: '0x123',
        frontRunTxHash: '0x456',
        backRunTxHash: '0x789',
        mevExtractedUsd: 0,
      });

      expect(mockRedis.zadd).toHaveBeenCalled();
    });
  });
});
