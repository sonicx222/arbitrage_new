/**
 * Correlation Analyzer Tests (TDD)
 *
 * Tests for the CorrelationAnalyzer class that tracks co-occurrence of
 * price updates to enable predictive cache warming.
 *
 * @see docs/reports/implementation_plan_v2.md - Task 2.2.1
 */

import {
  CorrelationAnalyzer,
  createCorrelationAnalyzer,
  getCorrelationAnalyzer,
  resetCorrelationAnalyzer,
  CorrelationAnalyzerConfig,
  PairCorrelation,
  CorrelationStats
} from '../../src/caching/correlation-analyzer';

describe('CorrelationAnalyzer', () => {
  let analyzer: CorrelationAnalyzer;

  beforeEach(() => {
    resetCorrelationAnalyzer();
    analyzer = new CorrelationAnalyzer();
  });

  afterEach(() => {
    analyzer.destroy();
    resetCorrelationAnalyzer();
  });

  // ===========================================================================
  // Construction and Configuration
  // ===========================================================================

  describe('Construction', () => {
    it('should create with default configuration', () => {
      const stats = analyzer.getStats();
      expect(stats.trackedPairs).toBe(0);
      expect(stats.correlationsComputed).toBe(0);
    });

    it('should create with custom configuration', () => {
      const customAnalyzer = new CorrelationAnalyzer({
        coOccurrenceWindowMs: 500,
        correlationUpdateIntervalMs: 30000,
        maxTrackedPairs: 100,
        minCoOccurrences: 5,
        topCorrelatedLimit: 5
      });

      expect(customAnalyzer).toBeDefined();
      customAnalyzer.destroy();
    });

    it('should use singleton pattern via getCorrelationAnalyzer', () => {
      const instance1 = getCorrelationAnalyzer();
      const instance2 = getCorrelationAnalyzer();
      expect(instance1).toBe(instance2);
    });

    it('should create new instance via factory function', () => {
      const instance = createCorrelationAnalyzer();
      expect(instance).toBeInstanceOf(CorrelationAnalyzer);
      instance.destroy();
    });
  });

  // ===========================================================================
  // Recording Price Updates
  // ===========================================================================

  describe('Recording Price Updates', () => {
    it('should record a single price update', () => {
      const pairA = '0xPairA';
      analyzer.recordPriceUpdate(pairA);

      const stats = analyzer.getStats();
      expect(stats.trackedPairs).toBe(1);
      expect(stats.totalUpdates).toBe(1);
    });

    it('should track multiple updates for the same pair', () => {
      const pairA = '0xPairA';
      analyzer.recordPriceUpdate(pairA);
      analyzer.recordPriceUpdate(pairA);
      analyzer.recordPriceUpdate(pairA);

      const stats = analyzer.getStats();
      expect(stats.trackedPairs).toBe(1);
      expect(stats.totalUpdates).toBe(3);
    });

    it('should track updates across multiple pairs', () => {
      analyzer.recordPriceUpdate('0xPairA');
      analyzer.recordPriceUpdate('0xPairB');
      analyzer.recordPriceUpdate('0xPairC');

      const stats = analyzer.getStats();
      expect(stats.trackedPairs).toBe(3);
      expect(stats.totalUpdates).toBe(3);
    });

    it('should normalize pair addresses to lowercase', () => {
      analyzer.recordPriceUpdate('0xPairA');
      analyzer.recordPriceUpdate('0xPAIRA'); // Same pair, different case

      const stats = analyzer.getStats();
      expect(stats.trackedPairs).toBe(1); // Should be same pair
      expect(stats.totalUpdates).toBe(2);
    });

    it('should accept optional timestamp', () => {
      const timestamp = Date.now() - 1000;
      analyzer.recordPriceUpdate('0xPairA', timestamp);

      const stats = analyzer.getStats();
      expect(stats.trackedPairs).toBe(1);
    });
  });

  // ===========================================================================
  // Co-occurrence Tracking
  // ===========================================================================

  describe('Co-occurrence Tracking', () => {
    it('should detect co-occurrence when updates happen within window', () => {
      // Create analyzer with 1000ms window and minCoOccurrences=1 for this test
      const testAnalyzer = new CorrelationAnalyzer({
        coOccurrenceWindowMs: 1000,
        minCoOccurrences: 1
      });

      const now = Date.now();
      testAnalyzer.recordPriceUpdate('0xPairA', now);
      testAnalyzer.recordPriceUpdate('0xPairB', now + 100); // Within 1000ms window

      // Trigger correlation calculation
      testAnalyzer.updateCorrelations();

      const correlations = testAnalyzer.getCorrelatedPairs('0xPairA');
      expect(correlations.length).toBeGreaterThan(0);
      expect(correlations.some(c => c.pairAddress.toLowerCase() === '0xpairb')).toBe(true);

      testAnalyzer.destroy();
    });

    it('should not detect co-occurrence when updates are outside window', () => {
      const testAnalyzer = new CorrelationAnalyzer({
        coOccurrenceWindowMs: 100, // Very short window
        minCoOccurrences: 1
      });

      const now = Date.now();
      testAnalyzer.recordPriceUpdate('0xPairA', now);
      testAnalyzer.recordPriceUpdate('0xPairB', now + 500); // Outside 100ms window

      testAnalyzer.updateCorrelations();

      const correlations = testAnalyzer.getCorrelatedPairs('0xPairA');
      const pairBCorrelation = correlations.find(c => c.pairAddress.toLowerCase() === '0xpairb');
      expect(pairBCorrelation).toBeUndefined();

      testAnalyzer.destroy();
    });

    it('should count multiple co-occurrences between the same pairs', () => {
      const testAnalyzer = new CorrelationAnalyzer({
        coOccurrenceWindowMs: 1000,
        minCoOccurrences: 1
      });

      // Simulate multiple co-occurrences
      for (let i = 0; i < 5; i++) {
        const baseTime = Date.now() + i * 2000; // Spread out to avoid overlap
        testAnalyzer.recordPriceUpdate('0xPairA', baseTime);
        testAnalyzer.recordPriceUpdate('0xPairB', baseTime + 50);
      }

      testAnalyzer.updateCorrelations();

      const correlations = testAnalyzer.getCorrelatedPairs('0xPairA');
      const pairBCorrelation = correlations.find(c => c.pairAddress.toLowerCase() === '0xpairb');

      expect(pairBCorrelation).toBeDefined();
      expect(pairBCorrelation!.coOccurrenceCount).toBeGreaterThanOrEqual(5);

      testAnalyzer.destroy();
    });

    it('should track bi-directional correlations', () => {
      const testAnalyzer = new CorrelationAnalyzer({
        coOccurrenceWindowMs: 1000,
        minCoOccurrences: 1
      });

      const now = Date.now();
      testAnalyzer.recordPriceUpdate('0xPairA', now);
      testAnalyzer.recordPriceUpdate('0xPairB', now + 50);

      testAnalyzer.updateCorrelations();

      // A->B correlation
      const correlationsA = testAnalyzer.getCorrelatedPairs('0xPairA');
      expect(correlationsA.some(c => c.pairAddress.toLowerCase() === '0xpairb')).toBe(true);

      // B->A correlation (should also exist)
      const correlationsB = testAnalyzer.getCorrelatedPairs('0xPairB');
      expect(correlationsB.some(c => c.pairAddress.toLowerCase() === '0xpaira')).toBe(true);

      testAnalyzer.destroy();
    });
  });

  // ===========================================================================
  // Correlation Scoring
  // ===========================================================================

  describe('Correlation Scoring', () => {
    it('should calculate correlation score between 0 and 1', () => {
      const testAnalyzer = new CorrelationAnalyzer({
        coOccurrenceWindowMs: 1000,
        minCoOccurrences: 1
      });

      // Create multiple co-occurrences
      for (let i = 0; i < 10; i++) {
        const baseTime = Date.now() + i * 2000;
        testAnalyzer.recordPriceUpdate('0xPairA', baseTime);
        testAnalyzer.recordPriceUpdate('0xPairB', baseTime + 50);
      }

      testAnalyzer.updateCorrelations();

      const correlations = testAnalyzer.getCorrelatedPairs('0xPairA');
      const pairBCorrelation = correlations.find(c => c.pairAddress.toLowerCase() === '0xpairb');

      expect(pairBCorrelation).toBeDefined();
      expect(pairBCorrelation!.correlationScore).toBeGreaterThanOrEqual(0);
      expect(pairBCorrelation!.correlationScore).toBeLessThanOrEqual(1);

      testAnalyzer.destroy();
    });

    it('should filter out correlations below minCoOccurrences threshold', () => {
      const testAnalyzer = new CorrelationAnalyzer({
        coOccurrenceWindowMs: 1000,
        minCoOccurrences: 5 // Require at least 5 co-occurrences
      });

      // Only create 2 co-occurrences (below threshold)
      for (let i = 0; i < 2; i++) {
        const baseTime = Date.now() + i * 2000;
        testAnalyzer.recordPriceUpdate('0xPairA', baseTime);
        testAnalyzer.recordPriceUpdate('0xPairB', baseTime + 50);
      }

      testAnalyzer.updateCorrelations();

      const correlations = testAnalyzer.getCorrelatedPairs('0xPairA');
      const pairBCorrelation = correlations.find(c => c.pairAddress.toLowerCase() === '0xpairb');

      expect(pairBCorrelation).toBeUndefined(); // Should be filtered out

      testAnalyzer.destroy();
    });

    it('should return correlations sorted by score (highest first)', () => {
      const testAnalyzer = new CorrelationAnalyzer({
        coOccurrenceWindowMs: 1000,
        minCoOccurrences: 1
      });

      // Create varying co-occurrence counts
      // PairA-PairB: 10 co-occurrences (high)
      // PairA-PairC: 3 co-occurrences (medium)
      // PairA-PairD: 1 co-occurrence (low)

      for (let i = 0; i < 10; i++) {
        const baseTime = Date.now() + i * 2000;
        testAnalyzer.recordPriceUpdate('0xPairA', baseTime);
        testAnalyzer.recordPriceUpdate('0xPairB', baseTime + 50);
        if (i < 3) {
          testAnalyzer.recordPriceUpdate('0xPairC', baseTime + 60);
        }
        if (i < 1) {
          testAnalyzer.recordPriceUpdate('0xPairD', baseTime + 70);
        }
      }

      testAnalyzer.updateCorrelations();

      const correlations = testAnalyzer.getCorrelatedPairs('0xPairA');

      // Should be sorted by score (co-occurrence count correlates with score)
      expect(correlations.length).toBeGreaterThanOrEqual(2);
      for (let i = 0; i < correlations.length - 1; i++) {
        expect(correlations[i].correlationScore).toBeGreaterThanOrEqual(correlations[i + 1].correlationScore);
      }

      testAnalyzer.destroy();
    });

    it('should limit results to topCorrelatedLimit', () => {
      const testAnalyzer = new CorrelationAnalyzer({
        coOccurrenceWindowMs: 1000,
        minCoOccurrences: 1,
        topCorrelatedLimit: 3
      });

      // Create co-occurrences with 5 different pairs
      for (let i = 0; i < 5; i++) {
        const baseTime = Date.now() + i * 2000;
        testAnalyzer.recordPriceUpdate('0xPairA', baseTime);
        testAnalyzer.recordPriceUpdate(`0xPair${i + 1}`, baseTime + 50);
      }

      testAnalyzer.updateCorrelations();

      const correlations = testAnalyzer.getCorrelatedPairs('0xPairA');
      expect(correlations.length).toBeLessThanOrEqual(3);

      testAnalyzer.destroy();
    });
  });

  // ===========================================================================
  // Periodic Updates
  // ===========================================================================

  describe('Periodic Correlation Updates', () => {
    it('should update correlations manually via updateCorrelations()', () => {
      // Create analyzer with minCoOccurrences=1 for this test
      const testAnalyzer = new CorrelationAnalyzer({
        coOccurrenceWindowMs: 1000,
        minCoOccurrences: 1
      });

      const now = Date.now();
      testAnalyzer.recordPriceUpdate('0xPairA', now);
      testAnalyzer.recordPriceUpdate('0xPairB', now + 50); // Within window

      const statsBefore = testAnalyzer.getStats();
      expect(statsBefore.correlationsComputed).toBe(0);

      testAnalyzer.updateCorrelations();

      const statsAfter = testAnalyzer.getStats();
      expect(statsAfter.correlationsComputed).toBeGreaterThan(0);

      testAnalyzer.destroy();
    });

    it('should track last correlation update time', () => {
      const before = Date.now();

      analyzer.recordPriceUpdate('0xPairA');
      analyzer.updateCorrelations();

      const after = Date.now();
      const stats = analyzer.getStats();

      expect(stats.lastCorrelationUpdate).toBeGreaterThanOrEqual(before);
      expect(stats.lastCorrelationUpdate).toBeLessThanOrEqual(after);
    });

    it('should clean up stale update records during correlation update', () => {
      const testAnalyzer = new CorrelationAnalyzer({
        coOccurrenceWindowMs: 100, // Very short window
        correlationHistoryMs: 1000 // 1 second history
      });

      // Record old updates
      const oldTime = Date.now() - 5000; // 5 seconds ago
      testAnalyzer.recordPriceUpdate('0xPairOld', oldTime);

      // Record recent updates
      testAnalyzer.recordPriceUpdate('0xPairNew', Date.now());

      testAnalyzer.updateCorrelations();

      const stats = testAnalyzer.getStats();
      // Should only have recent pair tracked
      expect(stats.trackedPairs).toBe(1);

      testAnalyzer.destroy();
    });
  });

  // ===========================================================================
  // Cache Warming Integration
  // ===========================================================================

  describe('Cache Warming Recommendations', () => {
    it('should return top correlated pairs for cache warming', () => {
      const testAnalyzer = new CorrelationAnalyzer({
        coOccurrenceWindowMs: 1000,
        minCoOccurrences: 1,
        topCorrelatedLimit: 3
      });

      // Build correlations
      for (let i = 0; i < 5; i++) {
        const baseTime = Date.now() + i * 2000;
        testAnalyzer.recordPriceUpdate('0xPairA', baseTime);
        testAnalyzer.recordPriceUpdate('0xPairB', baseTime + 50);
        testAnalyzer.recordPriceUpdate('0xPairC', baseTime + 60);
      }

      testAnalyzer.updateCorrelations();

      const pairsToWarm = testAnalyzer.getPairsToWarm('0xPairA');

      expect(pairsToWarm).toBeInstanceOf(Array);
      expect(pairsToWarm.length).toBeLessThanOrEqual(3);
      // Should only return addresses (strings)
      pairsToWarm.forEach(addr => {
        expect(typeof addr).toBe('string');
      });

      testAnalyzer.destroy();
    });

    it('should return empty array for unknown pair', () => {
      const pairsToWarm = analyzer.getPairsToWarm('0xUnknownPair');
      expect(pairsToWarm).toEqual([]);
    });
  });

  // ===========================================================================
  // Memory Management
  // ===========================================================================

  describe('Memory Management', () => {
    it('should evict LRU pairs when max limit is reached', () => {
      const testAnalyzer = new CorrelationAnalyzer({
        maxTrackedPairs: 10
      });

      // Add more pairs than the limit
      for (let i = 0; i < 15; i++) {
        testAnalyzer.recordPriceUpdate(`0xPair${i}`, Date.now() + i);
      }

      const stats = testAnalyzer.getStats();
      expect(stats.trackedPairs).toBeLessThanOrEqual(10);

      testAnalyzer.destroy();
    });

    it('should cleanup resources on destroy()', () => {
      analyzer.recordPriceUpdate('0xPairA');
      analyzer.destroy();

      const stats = analyzer.getStats();
      expect(stats.trackedPairs).toBe(0);
    });

    it('should reset all data via reset()', () => {
      analyzer.recordPriceUpdate('0xPairA');
      analyzer.recordPriceUpdate('0xPairB');
      analyzer.updateCorrelations();

      analyzer.reset();

      const stats = analyzer.getStats();
      expect(stats.trackedPairs).toBe(0);
      expect(stats.totalUpdates).toBe(0);
      expect(stats.correlationsComputed).toBe(0);
    });
  });

  // ===========================================================================
  // Statistics
  // ===========================================================================

  describe('Statistics', () => {
    it('should provide comprehensive stats', () => {
      analyzer.recordPriceUpdate('0xPairA');
      analyzer.recordPriceUpdate('0xPairB');
      analyzer.updateCorrelations();

      const stats = analyzer.getStats();

      expect(stats).toHaveProperty('trackedPairs');
      expect(stats).toHaveProperty('totalUpdates');
      expect(stats).toHaveProperty('correlationsComputed');
      expect(stats).toHaveProperty('lastCorrelationUpdate');
      expect(stats).toHaveProperty('avgCorrelationScore');
    });

    it('should calculate average correlation score', () => {
      const testAnalyzer = new CorrelationAnalyzer({
        coOccurrenceWindowMs: 1000,
        minCoOccurrences: 1
      });

      for (let i = 0; i < 10; i++) {
        const baseTime = Date.now() + i * 2000;
        testAnalyzer.recordPriceUpdate('0xPairA', baseTime);
        testAnalyzer.recordPriceUpdate('0xPairB', baseTime + 50);
      }

      testAnalyzer.updateCorrelations();

      const stats = testAnalyzer.getStats();
      expect(stats.avgCorrelationScore).toBeGreaterThan(0);

      testAnalyzer.destroy();
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('Edge Cases', () => {
    it('should handle empty state gracefully', () => {
      const correlations = analyzer.getCorrelatedPairs('0xNonExistent');
      expect(correlations).toEqual([]);

      const stats = analyzer.getStats();
      expect(stats.trackedPairs).toBe(0);
    });

    it('should handle single pair without correlations', () => {
      analyzer.recordPriceUpdate('0xOnlyPair');
      analyzer.updateCorrelations();

      const correlations = analyzer.getCorrelatedPairs('0xOnlyPair');
      expect(correlations).toEqual([]);
    });

    it('should handle rapid updates from same pair', () => {
      const now = Date.now();
      for (let i = 0; i < 100; i++) {
        analyzer.recordPriceUpdate('0xPairA', now + i);
      }

      const stats = analyzer.getStats();
      expect(stats.totalUpdates).toBe(100);
    });

    it('should handle invalid/empty pair address', () => {
      // Should not throw
      expect(() => analyzer.recordPriceUpdate('')).not.toThrow();
      expect(() => analyzer.getCorrelatedPairs('')).not.toThrow();
    });

    it('should handle exact maxTrackedPairs boundary', () => {
      const testAnalyzer = new CorrelationAnalyzer({
        maxTrackedPairs: 5
      });

      // Add exactly maxTrackedPairs
      for (let i = 0; i < 5; i++) {
        testAnalyzer.recordPriceUpdate(`0xPair${i}`, Date.now() + i);
      }

      const stats1 = testAnalyzer.getStats();
      expect(stats1.trackedPairs).toBe(5);

      // Add one more - should trigger eviction
      testAnalyzer.recordPriceUpdate('0xPairNew', Date.now() + 100);

      const stats2 = testAnalyzer.getStats();
      expect(stats2.trackedPairs).toBeLessThanOrEqual(5);

      testAnalyzer.destroy();
    });

    it('should handle concurrent rapid updates from multiple pairs', () => {
      const testAnalyzer = new CorrelationAnalyzer({
        coOccurrenceWindowMs: 100,
        minCoOccurrences: 1
      });

      // Simulate burst of updates from multiple pairs at nearly the same time
      const baseTime = Date.now();
      for (let i = 0; i < 10; i++) {
        testAnalyzer.recordPriceUpdate(`0xPair${i}`, baseTime + i);
      }

      testAnalyzer.updateCorrelations();

      // Each pair should be correlated with others
      const correlations = testAnalyzer.getCorrelatedPairs('0xpair0');
      expect(correlations.length).toBeGreaterThan(0);

      testAnalyzer.destroy();
    });
  });

  // ===========================================================================
  // Performance Optimization Tests
  // ===========================================================================

  describe('Performance Optimization', () => {
    it('should efficiently handle high pair count', () => {
      const testAnalyzer = new CorrelationAnalyzer({
        coOccurrenceWindowMs: 100,
        minCoOccurrences: 1,
        maxTrackedPairs: 1000
      });

      const startTime = Date.now();

      // Add many pairs with co-occurrences
      for (let i = 0; i < 100; i++) {
        const baseTime = startTime + i * 200; // Outside window to avoid massive correlation
        testAnalyzer.recordPriceUpdate(`0xPairA${i}`, baseTime);
        testAnalyzer.recordPriceUpdate(`0xPairB${i}`, baseTime + 10);
      }

      const duration = Date.now() - startTime;

      // Should complete in reasonable time (performance regression test)
      expect(duration).toBeLessThan(5000); // 5 seconds max

      const stats = testAnalyzer.getStats();
      expect(stats.trackedPairs).toBe(200);

      testAnalyzer.destroy();
    });

    it('should clean up stale entries from recentlyUpdatedPairs', () => {
      const testAnalyzer = new CorrelationAnalyzer({
        coOccurrenceWindowMs: 100,
        minCoOccurrences: 1
      });

      // Record updates spread over time
      const now = Date.now();
      testAnalyzer.recordPriceUpdate('0xPairOld', now - 200); // Outside window
      testAnalyzer.recordPriceUpdate('0xPairNew', now);        // Inside window

      // The new pair should not correlate with old pair (outside window)
      testAnalyzer.updateCorrelations();

      const correlations = testAnalyzer.getCorrelatedPairs('0xpairnew');
      const oldPairCorrelation = correlations.find(c => c.pairAddress === '0xpairold');
      expect(oldPairCorrelation).toBeUndefined();

      testAnalyzer.destroy();
    });
  });
});
