/**
 * Solana Arbitrage Detector Unit Tests
 *
 * Tests for arbitrage detection: price comparison, fee calculation,
 * profit thresholds, buy/sell direction, and confidence scoring.
 */

import { createSolanaArbitrageDetector, type SolanaArbitrageDetectorModule } from '../../../src/solana/solana-arbitrage-detector';
import { createMockLogger, createTestPool } from './solana-test-helpers';

// Mock dependencies — factories register the mocks; implementations are set
// in beforeEach to survive resetMocks: true from root jest config.
jest.mock('../../../src/components/price-calculator', () => ({
  meetsThreshold: jest.fn()
}));

jest.mock('../../../src/utils/fee-utils', () => ({
  basisPointsToDecimal: jest.fn()
}));

// Get references to mocked functions for re-implementation in beforeEach
const { meetsThreshold } = jest.requireMock<{ meetsThreshold: jest.Mock }>(
  '../../../src/components/price-calculator'
);
const { basisPointsToDecimal } = jest.requireMock<{ basisPointsToDecimal: jest.Mock }>(
  '../../../src/utils/fee-utils'
);

describe('SolanaArbitrageDetector', () => {
  let detector: SolanaArbitrageDetectorModule;
  let logger: ReturnType<typeof createMockLogger>;
  let getPoolsSnapshot: jest.Mock;
  let getCurrentSlot: jest.Mock;

  const defaultConfig = {
    minProfitThreshold: 0.3, // 0.3% -> 0.003 decimal
    opportunityExpiryMs: 30000
  };

  beforeEach(() => {
    // Re-set mock implementations (resetMocks: true clears these between tests)
    meetsThreshold.mockImplementation(
      (netProfit: number, threshold: number) => netProfit >= threshold
    );
    basisPointsToDecimal.mockImplementation(
      (bps: number) => bps / 10000
    );

    logger = createMockLogger();
    getCurrentSlot = jest.fn().mockReturnValue(200000010);
    getPoolsSnapshot = jest.fn().mockReturnValue({
      pools: new Map(),
      pairEntries: []
    });

    detector = createSolanaArbitrageDetector(defaultConfig, {
      logger,
      getPoolsSnapshot,
      getCurrentSlot
    });
  });

  // =========================================================================
  // checkArbitrage — basic detection
  // =========================================================================

  describe('checkArbitrage', () => {
    it('should return empty array when no pools exist', async () => {
      const result = await detector.checkArbitrage();
      expect(result).toEqual([]);
    });

    it('should return empty array when pair has only 1 pool', async () => {
      const pool = createTestPool({ price: 100 });
      getPoolsSnapshot.mockReturnValue({
        pools: new Map([['addr1', pool]]),
        pairEntries: [['SOL_USDC', new Set(['addr1'])]]
      });

      const result = await detector.checkArbitrage();
      expect(result).toEqual([]);
    });

    it('should detect arbitrage between two pools with sufficient price difference', async () => {
      const pool1 = createTestPool({
        address: 'Pool1Addr1111111111111111111111111111111111',
        dex: 'raydium',
        price: 100,
        fee: 25, // 0.25%
        lastSlot: 200000009
      });
      const pool2 = createTestPool({
        address: 'Pool2Addr1111111111111111111111111111111111',
        dex: 'orca',
        price: 102,
        fee: 30, // 0.30%
        lastSlot: 200000008
      });

      // 2% gross diff, 0.55% fees -> 1.45% net profit > 0.5% profit floor > 0.3% threshold
      getPoolsSnapshot.mockReturnValue({
        pools: new Map([
          [pool1.address, pool1],
          [pool2.address, pool2]
        ]),
        pairEntries: [['SOL_USDC', new Set([pool1.address, pool2.address])]]
      });

      const result = await detector.checkArbitrage();
      expect(result).toHaveLength(1);
      expect(result[0].chain).toBe('solana');
      expect(result[0].buyPrice).toBe(100);
      expect(result[0].sellPrice).toBe(102);
      expect(result[0].buyDex).toBe('raydium');
      expect(result[0].sellDex).toBe('orca');
    });

    it('should return empty when profit is below threshold', async () => {
      const pool1 = createTestPool({
        address: 'Pool1Addr1111111111111111111111111111111111',
        price: 100,
        fee: 25 // 0.25%
      });
      const pool2 = createTestPool({
        address: 'Pool2Addr1111111111111111111111111111111111',
        price: 100.3, // 0.3% diff - 0.5% fees = negative
        fee: 25
      });

      getPoolsSnapshot.mockReturnValue({
        pools: new Map([
          [pool1.address, pool1],
          [pool2.address, pool2]
        ]),
        pairEntries: [['SOL_USDC', new Set([pool1.address, pool2.address])]]
      });

      const result = await detector.checkArbitrage();
      expect(result).toEqual([]);
    });

    it('should skip pools without prices', async () => {
      const pool1 = createTestPool({
        address: 'Pool1Addr1111111111111111111111111111111111',
        price: undefined
      });
      const pool2 = createTestPool({
        address: 'Pool2Addr1111111111111111111111111111111111',
        price: 100
      });

      getPoolsSnapshot.mockReturnValue({
        pools: new Map([
          [pool1.address, pool1],
          [pool2.address, pool2]
        ]),
        pairEntries: [['SOL_USDC', new Set([pool1.address, pool2.address])]]
      });

      const result = await detector.checkArbitrage();
      expect(result).toEqual([]);
    });

    it('should reject opportunities below minimum net profit floor (Fix 6)', async () => {
      const pool1 = createTestPool({
        address: 'Pool1Addr1111111111111111111111111111111111',
        dex: 'raydium',
        price: 100,
        fee: 25, // 0.25%
        lastSlot: 200000009
      });
      const pool2 = createTestPool({
        address: 'Pool2Addr1111111111111111111111111111111111',
        dex: 'orca',
        price: 101, // 1% gross - 0.55% fees = 0.45% net < 0.5% floor
        fee: 30, // 0.30%
        lastSlot: 200000008
      });

      getPoolsSnapshot.mockReturnValue({
        pools: new Map([
          [pool1.address, pool1],
          [pool2.address, pool2]
        ]),
        pairEntries: [['SOL_USDC', new Set([pool1.address, pool2.address])]]
      });

      const result = await detector.checkArbitrage();
      expect(result).toEqual([]);
    });

    it('should reject pools with stale slot data (Fix 9)', async () => {
      getCurrentSlot.mockReturnValue(200000050);
      const pool1 = createTestPool({
        address: 'Pool1Addr1111111111111111111111111111111111',
        price: 100,
        fee: 10,
        lastSlot: 200000010 // age = 40 > maxSlotAge (10)
      });
      const pool2 = createTestPool({
        address: 'Pool2Addr1111111111111111111111111111111111',
        dex: 'orca',
        price: 105,
        fee: 10,
        lastSlot: 200000010
      });

      getPoolsSnapshot.mockReturnValue({
        pools: new Map([
          [pool1.address, pool1],
          [pool2.address, pool2]
        ]),
        pairEntries: [['SOL_USDC', new Set([pool1.address, pool2.address])]]
      });

      const result = await detector.checkArbitrage();
      expect(result).toEqual([]);
    });

    it('should allow configurable maxSlotAge', async () => {
      getCurrentSlot.mockReturnValue(200000050);
      const customDetector = createSolanaArbitrageDetector(
        { ...defaultConfig, maxSlotAge: 100 },
        { logger, getPoolsSnapshot, getCurrentSlot }
      );

      const pool1 = createTestPool({
        address: 'Pool1Addr1111111111111111111111111111111111',
        price: 100,
        fee: 10,
        lastSlot: 200000010 // age = 40 < maxSlotAge (100)
      });
      const pool2 = createTestPool({
        address: 'Pool2Addr1111111111111111111111111111111111',
        dex: 'orca',
        price: 105,
        fee: 10,
        lastSlot: 200000010
      });

      getPoolsSnapshot.mockReturnValue({
        pools: new Map([
          [pool1.address, pool1],
          [pool2.address, pool2]
        ]),
        pairEntries: [['SOL_USDC', new Set([pool1.address, pool2.address])]]
      });

      const result = await customDetector.checkArbitrage();
      expect(result).toHaveLength(1);
    });
  });

  // =========================================================================
  // Opportunity structure
  // =========================================================================

  describe('opportunity structure', () => {
    function createProfitableSnapshot() {
      const pool1 = createTestPool({
        address: 'BuyPool11111111111111111111111111111111111',
        dex: 'raydium',
        price: 100,
        fee: 10, // 0.10%
        lastSlot: 200000005
      });
      const pool2 = createTestPool({
        address: 'SellPool1111111111111111111111111111111111',
        dex: 'orca',
        price: 105, // 5% diff
        fee: 10,
        lastSlot: 200000005
      });

      getPoolsSnapshot.mockReturnValue({
        pools: new Map([
          [pool1.address, pool1],
          [pool2.address, pool2]
        ]),
        pairEntries: [['SOL_USDC', new Set([pool1.address, pool2.address])]]
      });
    }

    it('should set type to cross-dex for different DEXes', async () => {
      createProfitableSnapshot();
      const result = await detector.checkArbitrage();

      expect(result[0].type).toBe('cross-dex');
    });

    it('should set type to intra-dex for same DEX', async () => {
      const pool1 = createTestPool({
        address: 'Pool1Addr1111111111111111111111111111111111',
        dex: 'raydium',
        price: 100,
        fee: 10,
        lastSlot: 200000005
      });
      const pool2 = createTestPool({
        address: 'Pool2Addr1111111111111111111111111111111111',
        dex: 'raydium',
        price: 105,
        fee: 10,
        lastSlot: 200000005
      });

      getPoolsSnapshot.mockReturnValue({
        pools: new Map([
          [pool1.address, pool1],
          [pool2.address, pool2]
        ]),
        pairEntries: [['SOL_USDC', new Set([pool1.address, pool2.address])]]
      });

      const result = await detector.checkArbitrage();
      expect(result[0].type).toBe('intra-dex');
    });

    it('should assign buyPool as the lower-priced pool', async () => {
      createProfitableSnapshot();
      const result = await detector.checkArbitrage();

      expect(result[0].buyPrice).toBe(100);
      expect(result[0].buyDex).toBe('raydium');
      expect(result[0].sellPrice).toBe(105);
      expect(result[0].sellDex).toBe('orca');
    });

    it('should set gasEstimate to SOLANA_DEFAULT_GAS_ESTIMATE', async () => {
      createProfitableSnapshot();
      const result = await detector.checkArbitrage();

      expect(result[0].gasEstimate).toBe('300000');
    });

    it('should set status to pending', async () => {
      createProfitableSnapshot();
      const result = await detector.checkArbitrage();

      expect(result[0].status).toBe('pending');
    });

    it('should set expiresAt based on config', async () => {
      createProfitableSnapshot();
      const before = Date.now();
      const result = await detector.checkArbitrage();

      expect(result[0].expiresAt).toBeGreaterThanOrEqual(before + defaultConfig.opportunityExpiryMs);
    });

    it('should generate unique ID with solana prefix', async () => {
      createProfitableSnapshot();
      const result = await detector.checkArbitrage();

      expect(result[0].id).toMatch(/^solana-/);
    });
  });

  // =========================================================================
  // Confidence calculation
  // =========================================================================

  describe('confidence calculation', () => {
    // Confidence tests use maxSlotAge: Infinity to bypass stale-data rejection,
    // since these tests focus on confidence scoring math, not staleness filtering.
    let confidenceDetector: SolanaArbitrageDetectorModule;

    beforeEach(() => {
      confidenceDetector = createSolanaArbitrageDetector(
        { ...defaultConfig, maxSlotAge: Infinity },
        { logger, getPoolsSnapshot, getCurrentSlot }
      );
    });

    function createSnapshotWithSlots(slot1: number, slot2: number) {
      const pool1 = createTestPool({
        address: 'Pool1Addr1111111111111111111111111111111111',
        price: 100,
        fee: 10,
        lastSlot: slot1
      });
      const pool2 = createTestPool({
        address: 'Pool2Addr1111111111111111111111111111111111',
        dex: 'orca',
        price: 105,
        fee: 10,
        lastSlot: slot2
      });

      getPoolsSnapshot.mockReturnValue({
        pools: new Map([
          [pool1.address, pool1],
          [pool2.address, pool2]
        ]),
        pairEntries: [['SOL_USDC', new Set([pool1.address, pool2.address])]]
      });
    }

    it('should have high confidence for recent slots', async () => {
      getCurrentSlot.mockReturnValue(200000010);
      createSnapshotWithSlots(200000010, 200000010);

      const result = await confidenceDetector.checkArbitrage();
      expect(result[0].confidence).toBeCloseTo(0.95); // capped at 0.95
    });

    it('should have lower confidence for stale slots', async () => {
      getCurrentSlot.mockReturnValue(200000050);
      createSnapshotWithSlots(200000010, 200000020);

      const result = await confidenceDetector.checkArbitrage();
      // slotAge = 200000050 - max(200000010, 200000020) = 30
      // confidence = min(0.95, max(0.5, 1.0 - 30 * 0.01)) = 0.7
      expect(result[0].confidence).toBeCloseTo(0.7);
    });

    it('should clamp confidence to minimum 0.5', async () => {
      getCurrentSlot.mockReturnValue(200000200);
      createSnapshotWithSlots(200000010, 200000010);

      const result = await confidenceDetector.checkArbitrage();
      // slotAge = 190, confidence = max(0.5, 1.0 - 190 * 0.01) = max(0.5, -0.9) = 0.5
      expect(result[0].confidence).toBe(0.5);
    });

    it('should use currentSlot as fallback for missing lastSlot', async () => {
      getCurrentSlot.mockReturnValue(200000010);
      createSnapshotWithSlots(undefined as unknown as number, undefined as unknown as number);

      const result = await confidenceDetector.checkArbitrage();
      // lastSlot defaults to currentSlot for confidence, so slotAge = 0 -> confidence = 0.95
      expect(result[0].confidence).toBeCloseTo(0.95);
    });
  });

  // =========================================================================
  // Multiple pairs
  // =========================================================================

  describe('multiple pairs', () => {
    it('should detect opportunities across multiple token pairs', async () => {
      const pool1 = createTestPool({
        address: 'Pool1Addr1111111111111111111111111111111111',
        dex: 'raydium',
        price: 100,
        fee: 10,
        lastSlot: 200000005
      });
      const pool2 = createTestPool({
        address: 'Pool2Addr1111111111111111111111111111111111',
        dex: 'orca',
        price: 105,
        fee: 10,
        lastSlot: 200000005
      });
      const pool3 = createTestPool({
        address: 'Pool3Addr1111111111111111111111111111111111',
        dex: 'raydium',
        price: 50,
        fee: 10,
        lastSlot: 200000005,
        token0: { mint: 'TokenA111111111111111111111111111111111', symbol: 'A', decimals: 9 },
        token1: { mint: 'TokenB111111111111111111111111111111111', symbol: 'B', decimals: 6 }
      });
      const pool4 = createTestPool({
        address: 'Pool4Addr1111111111111111111111111111111111',
        dex: 'orca',
        price: 55,
        fee: 10,
        lastSlot: 200000005,
        token0: { mint: 'TokenA111111111111111111111111111111111', symbol: 'A', decimals: 9 },
        token1: { mint: 'TokenB111111111111111111111111111111111', symbol: 'B', decimals: 6 }
      });

      getPoolsSnapshot.mockReturnValue({
        pools: new Map([
          [pool1.address, pool1],
          [pool2.address, pool2],
          [pool3.address, pool3],
          [pool4.address, pool4]
        ]),
        pairEntries: [
          ['SOL_USDC', new Set([pool1.address, pool2.address])],
          ['A_B', new Set([pool3.address, pool4.address])]
        ]
      });

      const result = await detector.checkArbitrage();
      expect(result).toHaveLength(2);
    });

    it('should compare all pool pairs within same token pair (3 pools = 3 comparisons)', async () => {
      const pool1 = createTestPool({
        address: 'Pool1Addr1111111111111111111111111111111111',
        dex: 'raydium',
        price: 100,
        fee: 10,
        lastSlot: 200000005
      });
      const pool2 = createTestPool({
        address: 'Pool2Addr1111111111111111111111111111111111',
        dex: 'orca',
        price: 106,
        fee: 10,
        lastSlot: 200000005
      });
      const pool3 = createTestPool({
        address: 'Pool3Addr1111111111111111111111111111111111',
        dex: 'meteora',
        price: 112,
        fee: 10,
        lastSlot: 200000005
      });

      getPoolsSnapshot.mockReturnValue({
        pools: new Map([
          [pool1.address, pool1],
          [pool2.address, pool2],
          [pool3.address, pool3]
        ]),
        pairEntries: [['SOL_USDC', new Set([pool1.address, pool2.address, pool3.address])]]
      });

      const result = await detector.checkArbitrage();
      // 3 pools -> 3 pair combinations, all profitable
      expect(result).toHaveLength(3);
    });
  });
});
