/**
 * Unit Tests for WarmingIntegration
 *
 * Tests correlation tracking, cache warming, metrics collection,
 * debouncing, stale cleanup, and lifecycle management.
 *
 * Finding #6 from unified-detector deep analysis: Zero coverage for 632 lines.
 */

// =============================================================================
// Mock Setup - fully self-contained inside factory (ts-jest compatible)
// =============================================================================

jest.mock('@arbitrage/core', () => {
  // All mock functions defined INSIDE the factory to avoid TDZ issues with ts-jest
  const _mocks = {
    defineMetric: jest.fn(),
    incrementCounter: jest.fn(),
    setGauge: jest.fn(),
    recordHistogram: jest.fn(),
    collectorGetStats: jest.fn().mockReturnValue({
      metricsCount: 5,
      totalObservations: 100,
      memoryUsageBytes: 512,
    }),
    exportFn: jest.fn().mockResolvedValue({
      data: '# HELP cache_hits_total Total cache hits\ncache_hits_total 42\n',
    }),
    recordPriceUpdate: jest.fn().mockReturnValue({
      success: true,
      durationUs: 25,
    }),
    correlationTrackerGetStats: jest.fn().mockReturnValue({
      totalPairs: 10,
      totalCoOccurrences: 50,
      avgCorrelationScore: 0.65,
      memoryUsageBytes: 1024,
    }),
    warmForPair: jest.fn().mockResolvedValue({
      success: true,
      pairsWarmed: 3,
      durationMs: 12,
    }),
    warmerGetStats: jest.fn().mockReturnValue({
      totalWarmingOps: 5,
      successfulOps: 4,
      failedOps: 1,
      successRate: 0.8,
      totalPairsWarmed: 15,
      avgPairsPerOp: 3,
      avgDurationMs: 10,
    }),
    warmerUpdateConfig: jest.fn(),
  };

  return {
    // Expose mock references for tests
    __testMocks: _mocks,
    // Correlation tracking
    CorrelationAnalyzer: jest.fn(),
    getCorrelationAnalyzer: jest.fn().mockReturnValue({}),
    CorrelationTrackerImpl: jest.fn().mockImplementation(() => ({
      recordPriceUpdate: _mocks.recordPriceUpdate,
      getStats: _mocks.correlationTrackerGetStats,
    })),
    // Cache warming
    HierarchicalCache: jest.fn(),
    HierarchicalCacheWarmer: jest.fn().mockImplementation(() => ({
      warmForPair: _mocks.warmForPair,
      getStats: _mocks.warmerGetStats,
      updateConfig: _mocks.warmerUpdateConfig,
    })),
    // Warming strategies
    TopNStrategy: jest.fn().mockImplementation(() => ({})),
    AdaptiveStrategy: jest.fn().mockImplementation(() => ({})),
    // Metrics
    PrometheusMetricsCollector: jest.fn().mockImplementation(() => ({
      defineMetric: _mocks.defineMetric,
      incrementCounter: _mocks.incrementCounter,
      setGauge: _mocks.setGauge,
      recordHistogram: _mocks.recordHistogram,
      getStats: _mocks.collectorGetStats,
    })),
    PrometheusExporter: jest.fn().mockImplementation(() => ({
      export: _mocks.exportFn,
    })),
    MetricType: {
      COUNTER: 'counter',
      GAUGE: 'gauge',
      HISTOGRAM: 'histogram',
    },
    ExportFormat: {
      PROMETHEUS: 'prometheus',
    },
    createLogger: jest.fn().mockReturnValue({
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    }),
  };
});

import {
  WarmingIntegration,
  WarmingIntegrationConfig,
} from '../../warming-integration';

// Access the mock functions defined inside the factory
const coreMock = require('@arbitrage/core') as any;
const m = coreMock.__testMocks as {
  defineMetric: jest.Mock;
  incrementCounter: jest.Mock;
  setGauge: jest.Mock;
  recordHistogram: jest.Mock;
  collectorGetStats: jest.Mock;
  exportFn: jest.Mock;
  recordPriceUpdate: jest.Mock;
  correlationTrackerGetStats: jest.Mock;
  warmForPair: jest.Mock;
  warmerGetStats: jest.Mock;
  warmerUpdateConfig: jest.Mock;
};

// =============================================================================
// Helpers
// =============================================================================

function createMockCache() {
  return {
    getStats: jest.fn().mockReturnValue({
      l1: { hits: 0, misses: 0, size: 0 },
      l2: { hits: 0, misses: 0 },
    }),
    get: jest.fn(),
    set: jest.fn(),
  } as any;
}

// =============================================================================
// Tests
// =============================================================================

describe('WarmingIntegration', () => {
  let mockCache: ReturnType<typeof createMockCache>;

  beforeEach(() => {
    // Global setupTests.ts calls jest.resetAllMocks() in afterEach,
    // which wipes all mock implementations. Re-establish them here.
    const core = require('@arbitrage/core');

    // Re-configure constructor mocks
    core.PrometheusMetricsCollector.mockImplementation(() => ({
      defineMetric: m.defineMetric,
      incrementCounter: m.incrementCounter,
      setGauge: m.setGauge,
      recordHistogram: m.recordHistogram,
      getStats: m.collectorGetStats,
    }));
    core.PrometheusExporter.mockImplementation(() => ({
      export: m.exportFn,
    }));
    core.CorrelationTrackerImpl.mockImplementation(() => ({
      recordPriceUpdate: m.recordPriceUpdate,
      getStats: m.correlationTrackerGetStats,
    }));
    core.HierarchicalCacheWarmer.mockImplementation(() => ({
      warmForPair: m.warmForPair,
      getStats: m.warmerGetStats,
      updateConfig: m.warmerUpdateConfig,
    }));
    core.TopNStrategy.mockImplementation(() => ({}));
    core.AdaptiveStrategy.mockImplementation(() => ({}));
    core.getCorrelationAnalyzer.mockReturnValue({});
    core.createLogger.mockReturnValue({
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    });

    // Restore default return values on shared mocks
    m.warmForPair.mockResolvedValue({
      success: true,
      pairsWarmed: 3,
      durationMs: 12,
    });
    m.recordPriceUpdate.mockReturnValue({
      success: true,
      durationUs: 25,
    });
    m.collectorGetStats.mockReturnValue({
      metricsCount: 5,
      totalObservations: 100,
      memoryUsageBytes: 512,
    });
    m.correlationTrackerGetStats.mockReturnValue({
      totalPairs: 10,
      totalCoOccurrences: 50,
      avgCorrelationScore: 0.65,
      memoryUsageBytes: 1024,
    });
    m.warmerGetStats.mockReturnValue({
      totalWarmingOps: 5,
      successfulOps: 4,
      failedOps: 1,
      successRate: 0.8,
      totalPairsWarmed: 15,
      avgPairsPerOp: 3,
      avgDurationMs: 10,
    });
    m.exportFn.mockResolvedValue({
      data: '# HELP cache_hits_total Total cache hits\ncache_hits_total 42\n',
    });
    mockCache = createMockCache();
  });

  // ===========================================================================
  // Constructor
  // ===========================================================================

  describe('constructor', () => {
    it('should create with default config when no config provided', () => {
      const integration = new WarmingIntegration(null);
      const stats = integration.getStats();

      expect(stats.initialized).toBe(false);
      expect(stats.warmingEnabled).toBe(false);
      expect(stats.metricsEnabled).toBe(true);
    });

    it('should merge partial config with defaults', () => {
      const integration = new WarmingIntegration(mockCache, {
        enableWarming: true,
        maxPairsToWarm: 10,
      });
      const stats = integration.getStats();

      expect(stats.warmingEnabled).toBe(true);
      expect(stats.metricsEnabled).toBe(true); // default
    });

    it('should accept null cache', () => {
      const integration = new WarmingIntegration(null, { enableWarming: false });
      expect(integration).toBeDefined();
    });
  });

  // ===========================================================================
  // initialize
  // ===========================================================================

  describe('initialize', () => {
    it('should initialize metrics when enableMetrics is true', async () => {
      const integration = new WarmingIntegration(null, { enableMetrics: true });
      await integration.initialize();

      const stats = integration.getStats();
      expect(stats.initialized).toBe(true);
      expect(stats.metrics).toBeDefined();
      expect(m.defineMetric).toHaveBeenCalled();
    });

    it('should initialize warming when enableWarming is true and cache provided', async () => {
      const integration = new WarmingIntegration(mockCache, {
        enableWarming: true,
        warmingStrategy: 'topn',
      });
      await integration.initialize();

      const stats = integration.getStats();
      expect(stats.initialized).toBe(true);
      expect(stats.warming).toBeDefined();
      expect(stats.correlation).toBeDefined();
    });

    it('should throw when warming enabled but no cache provided', async () => {
      const integration = new WarmingIntegration(null, {
        enableWarming: true,
        enableMetrics: false,
      });

      await expect(integration.initialize()).rejects.toThrow();
    });

    it('should use adaptive strategy when configured', async () => {
      const { AdaptiveStrategy } = require('@arbitrage/core');

      const integration = new WarmingIntegration(mockCache, {
        enableWarming: true,
        warmingStrategy: 'adaptive',
        targetHitRate: 0.95,
      });
      await integration.initialize();

      expect(AdaptiveStrategy).toHaveBeenCalledWith(
        expect.objectContaining({ targetHitRate: 0.95 })
      );
    });

    it('should use topn strategy when configured', async () => {
      const { TopNStrategy } = require('@arbitrage/core');

      const integration = new WarmingIntegration(mockCache, {
        enableWarming: true,
        warmingStrategy: 'topn',
        maxPairsToWarm: 8,
      });
      await integration.initialize();

      expect(TopNStrategy).toHaveBeenCalledWith(
        expect.objectContaining({ topN: 8 })
      );
    });

    it('should be idempotent (no-op on second call)', async () => {
      const integration = new WarmingIntegration(null, { enableMetrics: true });
      await integration.initialize();
      const callCount = m.defineMetric.mock.calls.length;

      await integration.initialize();
      expect(m.defineMetric).toHaveBeenCalledTimes(callCount);
    });

    it('should skip metrics initialization when enableMetrics is false', async () => {
      const integration = new WarmingIntegration(null, { enableMetrics: false });
      await integration.initialize();

      expect(m.defineMetric).not.toHaveBeenCalled();
      expect(integration.getStats().metrics).toBeUndefined();
    });

    it('should define cache and warming metrics', async () => {
      const integration = new WarmingIntegration(null, { enableMetrics: true });
      await integration.initialize();

      const definedNames = m.defineMetric.mock.calls.map(
        (call: any[]) => call[0].name
      );
      expect(definedNames).toContain('cache_hits_total');
      expect(definedNames).toContain('cache_misses_total');
      expect(definedNames).toContain('warming_operations_total');
      expect(definedNames).toContain('warming_pending_operations');
      expect(definedNames).toContain('warming_debounced_total');
    });
  });

  // ===========================================================================
  // onPriceUpdate
  // ===========================================================================

  describe('onPriceUpdate', () => {
    it('should no-op before initialization', () => {
      const integration = new WarmingIntegration(mockCache, { enableWarming: true });
      integration.onPriceUpdate('0xpair1', Date.now(), 'ethereum');
      expect(m.recordPriceUpdate).not.toHaveBeenCalled();
    });

    it('should track correlation when warming is enabled', async () => {
      const integration = new WarmingIntegration(mockCache, {
        enableWarming: true,
        enableMetrics: true,
      });
      await integration.initialize();

      integration.onPriceUpdate('0xpair1', 1000, 'ethereum');
      expect(m.recordPriceUpdate).toHaveBeenCalledWith('0xpair1', 1000);
    });

    it('should record correlation tracking duration metric', async () => {
      const integration = new WarmingIntegration(mockCache, {
        enableWarming: true,
        enableMetrics: true,
      });
      await integration.initialize();

      integration.onPriceUpdate('0xpair1', 1000, 'ethereum');

      expect(m.recordHistogram).toHaveBeenCalledWith(
        'correlation_tracking_duration_us',
        25,
        { chain: 'ethereum' }
      );
    });

    it('should trigger warming for pair', async () => {
      const integration = new WarmingIntegration(mockCache, {
        enableWarming: true,
        enableMetrics: true,
      });
      await integration.initialize();

      integration.onPriceUpdate('0xpair1', 1000, 'ethereum');
      await new Promise(resolve => setImmediate(resolve));

      expect(m.warmForPair).toHaveBeenCalledWith('0xpair1');
    });

    it('should debounce warming for the same pair', async () => {
      const integration = new WarmingIntegration(mockCache, {
        enableWarming: true,
        enableMetrics: true,
      });
      await integration.initialize();

      // Use a non-resolving promise to keep pair in pending state
      m.warmForPair.mockReturnValueOnce(new Promise(() => {}));

      integration.onPriceUpdate('0xpair1', 1000, 'ethereum');
      integration.onPriceUpdate('0xpair1', 1001, 'ethereum');

      expect(m.warmForPair).toHaveBeenCalledTimes(1);
      expect(m.incrementCounter).toHaveBeenCalledWith(
        'warming_debounced_total',
        { chain: 'ethereum' }
      );
    });

    it('should allow warming for different pairs concurrently', async () => {
      const integration = new WarmingIntegration(mockCache, {
        enableWarming: true,
        enableMetrics: true,
      });
      await integration.initialize();

      m.warmForPair.mockReturnValue(new Promise(() => {}));

      integration.onPriceUpdate('0xpair1', 1000, 'ethereum');
      integration.onPriceUpdate('0xpair2', 1000, 'ethereum');

      expect(m.warmForPair).toHaveBeenCalledTimes(2);
    });

    it('should remove pair from pending after warming completes', async () => {
      const integration = new WarmingIntegration(mockCache, {
        enableWarming: true,
        enableMetrics: true,
      });
      await integration.initialize();

      integration.onPriceUpdate('0xpair1', 1000, 'ethereum');
      await new Promise(resolve => setImmediate(resolve));

      expect(integration.getPendingWarmingCount()).toBe(0);

      integration.onPriceUpdate('0xpair1', 1001, 'ethereum');
      expect(m.warmForPair).toHaveBeenCalledTimes(2);
    });

    it('should remove pair from pending even on warming error', async () => {
      const integration = new WarmingIntegration(mockCache, {
        enableWarming: true,
        enableMetrics: true,
      });
      await integration.initialize();

      m.warmForPair.mockRejectedValueOnce(new Error('Warming failed'));

      integration.onPriceUpdate('0xpair1', 1000, 'ethereum');
      await new Promise(resolve => setImmediate(resolve));

      expect(integration.getPendingWarmingCount()).toBe(0);
    });

    it('should skip warming when only metrics enabled (no warming)', async () => {
      const integration = new WarmingIntegration(null, {
        enableWarming: false,
        enableMetrics: true,
      });
      await integration.initialize();

      integration.onPriceUpdate('0xpair1', 1000, 'ethereum');

      expect(m.warmForPair).not.toHaveBeenCalled();
      expect(m.recordPriceUpdate).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // recordCacheMetrics
  // ===========================================================================

  describe('recordCacheMetrics', () => {
    it('should no-op when no metrics collector', async () => {
      const integration = new WarmingIntegration(mockCache, { enableMetrics: false });
      await integration.initialize();

      integration.recordCacheMetrics('ethereum');
      expect(m.incrementCounter).not.toHaveBeenCalled();
    });

    it('should no-op when no cache', async () => {
      const integration = new WarmingIntegration(null, { enableMetrics: true });
      await integration.initialize();

      integration.recordCacheMetrics('ethereum');
      expect(m.setGauge).not.toHaveBeenCalled();
    });

    it('should compute deltas from cumulative stats (P1 fix)', async () => {
      const integration = new WarmingIntegration(mockCache, {
        enableMetrics: true,
        enableWarming: false,
      });
      await integration.initialize();

      // First call: cumulative hits = 10
      mockCache.getStats.mockReturnValueOnce({
        l1: { hits: 10, misses: 2, size: 100 },
        l2: { hits: 5, misses: 1 },
      });
      integration.recordCacheMetrics('ethereum');

      expect(m.incrementCounter).toHaveBeenCalledWith(
        'cache_hits_total',
        { cache_level: 'l1', chain: 'ethereum' },
        10
      );

      m.incrementCounter.mockClear();

      // Second call: cumulative hits = 25 (delta = 15)
      mockCache.getStats.mockReturnValueOnce({
        l1: { hits: 25, misses: 5, size: 200 },
        l2: { hits: 12, misses: 3 },
      });
      integration.recordCacheMetrics('ethereum');

      expect(m.incrementCounter).toHaveBeenCalledWith(
        'cache_hits_total',
        { cache_level: 'l1', chain: 'ethereum' },
        15 // delta, not cumulative!
      );
    });

    it('should set gauge for cache size', async () => {
      const integration = new WarmingIntegration(mockCache, {
        enableMetrics: true,
        enableWarming: false,
      });
      await integration.initialize();

      mockCache.getStats.mockReturnValueOnce({
        l1: { hits: 10, misses: 2, size: 4096 },
        l2: { hits: 5, misses: 1 },
      });

      integration.recordCacheMetrics('ethereum');

      expect(m.setGauge).toHaveBeenCalledWith(
        'cache_size_bytes',
        4096,
        { cache_level: 'l1', chain: 'ethereum' }
      );
    });

    it('should record correlation pairs when warming enabled', async () => {
      const integration = new WarmingIntegration(mockCache, {
        enableMetrics: true,
        enableWarming: true,
      });
      await integration.initialize();

      mockCache.getStats.mockReturnValueOnce({
        l1: { hits: 0, misses: 0, size: 0 },
        l2: { hits: 0, misses: 0 },
      });

      integration.recordCacheMetrics('ethereum');

      expect(m.setGauge).toHaveBeenCalledWith(
        'correlation_pairs_tracked',
        10,
        { chain: 'ethereum' }
      );
    });

    it('should record pending warming gauge', async () => {
      const integration = new WarmingIntegration(mockCache, {
        enableMetrics: true,
        enableWarming: true,
      });
      await integration.initialize();

      // Trigger a warming that stays pending
      m.warmForPair.mockReturnValueOnce(new Promise(() => {}));
      integration.onPriceUpdate('0xpair1', 1000, 'ethereum');

      mockCache.getStats.mockReturnValueOnce({
        l1: { hits: 0, misses: 0, size: 0 },
        l2: { hits: 0, misses: 0 },
      });

      integration.recordCacheMetrics('ethereum');

      expect(m.setGauge).toHaveBeenCalledWith(
        'warming_pending_operations',
        1,
        { chain: 'ethereum' }
      );
    });
  });

  // ===========================================================================
  // getStats
  // ===========================================================================

  describe('getStats', () => {
    it('should return base stats before initialization', () => {
      const integration = new WarmingIntegration(null);
      const stats = integration.getStats();

      expect(stats.initialized).toBe(false);
      expect(stats.warmingEnabled).toBe(false);
      expect(stats.metricsEnabled).toBe(true);
    });

    it('should include warming stats after initialization', async () => {
      const integration = new WarmingIntegration(mockCache, { enableWarming: true });
      await integration.initialize();

      const stats = integration.getStats();
      expect(stats.warming).toBeDefined();
      expect(stats.warming?.totalWarmingOps).toBe(5);
    });

    it('should include correlation stats when warming enabled', async () => {
      const integration = new WarmingIntegration(mockCache, { enableWarming: true });
      await integration.initialize();

      const stats = integration.getStats();
      expect(stats.correlation).toBeDefined();
      expect(stats.correlation?.totalPairs).toBe(10);
    });

    it('should include metrics stats when metrics enabled', async () => {
      const integration = new WarmingIntegration(null, { enableMetrics: true });
      await integration.initialize();

      const stats = integration.getStats();
      expect(stats.metrics).toBeDefined();
      expect(stats.metrics?.metricsCount).toBe(5);
    });
  });

  // ===========================================================================
  // exportMetrics
  // ===========================================================================

  describe('exportMetrics', () => {
    it('should return empty string when no exporter', async () => {
      const integration = new WarmingIntegration(null, { enableMetrics: false });
      await integration.initialize();

      const result = await integration.exportMetrics();
      expect(result).toBe('');
    });

    it('should return Prometheus format when exporter exists', async () => {
      const integration = new WarmingIntegration(null, { enableMetrics: true });
      await integration.initialize();

      const result = await integration.exportMetrics();
      expect(result).toContain('cache_hits_total');
    });
  });

  // ===========================================================================
  // updateConfig
  // ===========================================================================

  describe('updateConfig', () => {
    it('should not fail when no cache warmer exists', () => {
      const integration = new WarmingIntegration(null, { enableWarming: false });
      expect(() => integration.updateConfig({ maxPairsToWarm: 10 })).not.toThrow();
    });

    it('should propagate config to cache warmer', async () => {
      const integration = new WarmingIntegration(mockCache, { enableWarming: true });
      await integration.initialize();

      integration.updateConfig({
        maxPairsToWarm: 15,
        minCorrelationScore: 0.5,
        enableWarming: true,
      });

      expect(m.warmerUpdateConfig).toHaveBeenCalledWith({
        maxPairsPerWarm: 15,
        minCorrelationScore: 0.5,
        enabled: true,
      });
    });
  });

  // ===========================================================================
  // cleanupStalePendingWarmings
  // ===========================================================================

  describe('cleanupStalePendingWarmings', () => {
    it('should remove warmings older than maxAgeMs', async () => {
      const integration = new WarmingIntegration(mockCache, {
        enableWarming: true,
        enableMetrics: true,
      });
      await integration.initialize();

      m.warmForPair.mockReturnValueOnce(new Promise(() => {}));
      integration.onPriceUpdate('0xstale', 1000, 'ethereum');
      expect(integration.getPendingWarmingCount()).toBe(1);

      integration.cleanupStalePendingWarmings(0);
      expect(integration.getPendingWarmingCount()).toBe(0);
    });

    it('should keep warmings within maxAgeMs', async () => {
      const integration = new WarmingIntegration(mockCache, {
        enableWarming: true,
        enableMetrics: true,
      });
      await integration.initialize();

      m.warmForPair.mockReturnValueOnce(new Promise(() => {}));
      integration.onPriceUpdate('0xfresh', Date.now(), 'ethereum');
      expect(integration.getPendingWarmingCount()).toBe(1);

      integration.cleanupStalePendingWarmings(30000);
      expect(integration.getPendingWarmingCount()).toBe(1);
    });

    it('should no-op when no pending warmings', () => {
      const integration = new WarmingIntegration(null);
      expect(() => integration.cleanupStalePendingWarmings()).not.toThrow();
    });
  });

  // ===========================================================================
  // getPendingWarmingCount
  // ===========================================================================

  describe('getPendingWarmingCount', () => {
    it('should return 0 initially', () => {
      const integration = new WarmingIntegration(null);
      expect(integration.getPendingWarmingCount()).toBe(0);
    });

    it('should reflect pending warmings', async () => {
      const integration = new WarmingIntegration(mockCache, {
        enableWarming: true,
        enableMetrics: true,
      });
      await integration.initialize();

      m.warmForPair.mockReturnValue(new Promise(() => {}));

      integration.onPriceUpdate('0xpair1', 1000, 'ethereum');
      integration.onPriceUpdate('0xpair2', 1000, 'ethereum');

      expect(integration.getPendingWarmingCount()).toBe(2);
    });
  });

  // ===========================================================================
  // shutdown
  // ===========================================================================

  describe('shutdown', () => {
    it('should clear pending warmings', async () => {
      const integration = new WarmingIntegration(mockCache, {
        enableWarming: true,
        enableMetrics: true,
      });
      await integration.initialize();

      m.warmForPair.mockReturnValue(new Promise(() => {}));
      integration.onPriceUpdate('0xpair1', 1000, 'ethereum');
      expect(integration.getPendingWarmingCount()).toBe(1);

      await integration.shutdown();
      expect(integration.getPendingWarmingCount()).toBe(0);
    });

    it('should mark as not initialized', async () => {
      const integration = new WarmingIntegration(null, { enableMetrics: true });
      await integration.initialize();
      expect(integration.getStats().initialized).toBe(true);

      await integration.shutdown();
      expect(integration.getStats().initialized).toBe(false);
    });

    it('should be safe to call multiple times', async () => {
      const integration = new WarmingIntegration(null);
      await integration.initialize();

      await integration.shutdown();
      await expect(integration.shutdown()).resolves.not.toThrow();
    });

    it('should ignore onPriceUpdate after shutdown', async () => {
      const integration = new WarmingIntegration(mockCache, {
        enableWarming: true,
        enableMetrics: true,
      });
      await integration.initialize();
      await integration.shutdown();

      m.recordPriceUpdate.mockClear();
      integration.onPriceUpdate('0xpair1', 1000, 'ethereum');
      expect(m.recordPriceUpdate).not.toHaveBeenCalled();
    });
  });
});
