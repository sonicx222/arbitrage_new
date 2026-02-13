/**
 * Triangular Arbitrage Detector Tests
 *
 * Tests for detecting triangular arbitrage paths on Solana.
 * Covers adjacency graph building, DFS path finding, profit calculation,
 * and bounded search limits.
 *
 * @see services/partition-solana/src/detection/triangular-detector.ts
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { createMockLogger } from '@arbitrage/test-utils';
import {
  buildAdjacencyGraph,
  findTriangularPaths,
  detectTriangularArbitrage,
  TriangularDetectorConfig,
  AdjacencyGraph,
} from '../../../src/detection/triangular-detector';
import type { VersionedPoolStore } from '../../../src/pool/versioned-pool-store';
import type { OpportunityFactory } from '../../../src/opportunity-factory';
import type {
  InternalPoolInfo,
  SolanaArbitrageLogger,
  SolanaArbitrageOpportunity,
  TriangularPath,
} from '../../../src/types';
import { createMockInternalPool, createMockPoolStoreWithIterator } from '../../helpers/test-fixtures';

// =============================================================================
// Helpers
// =============================================================================

const createMockPool = createMockInternalPool;

const defaultConfig: TriangularDetectorConfig = {
  minProfitThreshold: 0.3,
  maxTriangularDepth: 4,
  priceStalenessMs: 5000,
};

function createMockOpportunityFactory(): OpportunityFactory {
  return {
    createTriangular: jest.fn<(path: TriangularPath) => SolanaArbitrageOpportunity>()
      .mockImplementation((path) => ({
        id: 'sol-tri-test-1',
        type: 'triangular' as const,
        chain: 'solana',
        buyDex: path.steps[0]?.dex ?? 'unknown',
        sellDex: path.steps[path.steps.length - 1]?.dex ?? 'unknown',
        buyPair: path.steps[0]?.pool ?? '',
        sellPair: path.steps[path.steps.length - 1]?.pool ?? '',
        token0: path.inputToken,
        token1: path.outputToken,
        buyPrice: path.steps[0]?.price ?? 0,
        sellPrice: path.steps[path.steps.length - 1]?.price ?? 0,
        profitPercentage: path.profitPercentage,
        expectedProfit: path.profitPercentage / 100,
        confidence: 0.75,
        timestamp: Date.now(),
        expiresAt: Date.now() + 1000,
        status: 'pending' as const,
        path: path.steps,
      })),
  } as unknown as OpportunityFactory;
}

// =============================================================================
// Tests
// =============================================================================

describe('buildAdjacencyGraph', () => {
  let logger: SolanaArbitrageLogger;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it('should build empty graph from empty pool store', () => {
    const poolStore = createMockPoolStoreWithIterator([]);

    const graph = buildAdjacencyGraph(poolStore, defaultConfig, logger);

    expect(graph.size).toBe(0);
  });

  it('should create bidirectional edges from a single pool', () => {
    const pool = createMockPool({
      normalizedToken0: 'SOL',
      normalizedToken1: 'USDC',
      price: 100,
      lastUpdated: Date.now(),
    });
    const poolStore = createMockPoolStoreWithIterator([pool]);

    const graph = buildAdjacencyGraph(poolStore, defaultConfig, logger);

    expect(graph.has('SOL')).toBe(true);
    expect(graph.has('USDC')).toBe(true);
    expect(graph.get('SOL')!.length).toBe(1);
    expect(graph.get('SOL')![0].nextToken).toBe('USDC');
    expect(graph.get('USDC')![0].nextToken).toBe('SOL');
  });

  it('should skip pools with invalid price', () => {
    const pool = createMockPool({ price: 0, lastUpdated: Date.now() });
    const poolStore = createMockPoolStoreWithIterator([pool]);

    const graph = buildAdjacencyGraph(poolStore, defaultConfig, logger);

    expect(graph.size).toBe(0);
  });

  it('should skip pools with stale prices', () => {
    const pool = createMockPool({ price: 100, lastUpdated: Date.now() - 10000 });
    const poolStore = createMockPoolStoreWithIterator([pool]);

    const graph = buildAdjacencyGraph(poolStore, defaultConfig, logger);

    expect(graph.size).toBe(0);
  });

  it('should calculate inverse price for token1 -> token0 edge', () => {
    const pool = createMockPool({
      normalizedToken0: 'SOL',
      normalizedToken1: 'USDC',
      price: 100,
      fee: 25,
      lastUpdated: Date.now(),
    });
    const poolStore = createMockPoolStoreWithIterator([pool]);

    const graph = buildAdjacencyGraph(poolStore, defaultConfig, logger);

    const usdcEdges = graph.get('USDC');
    expect(usdcEdges).toBeDefined();
    expect(usdcEdges![0].effectivePrice).toBeCloseTo(0.01, 4);
  });

  it('should handle multiple pools between same token pair', () => {
    const pool1 = createMockPool({
      address: 'pool-1',
      dex: 'raydium',
      normalizedToken0: 'SOL',
      normalizedToken1: 'USDC',
      price: 100,
      lastUpdated: Date.now(),
    });
    const pool2 = createMockPool({
      address: 'pool-2',
      dex: 'orca',
      normalizedToken0: 'SOL',
      normalizedToken1: 'USDC',
      price: 101,
      lastUpdated: Date.now(),
    });
    const poolStore = createMockPoolStoreWithIterator([pool1, pool2]);

    const graph = buildAdjacencyGraph(poolStore, defaultConfig, logger);

    expect(graph.get('SOL')!.length).toBe(2);
  });

  it('should convert fees from basis points to decimal', () => {
    const pool = createMockPool({
      fee: 25, // 0.25%
      price: 100,
      lastUpdated: Date.now(),
    });
    const poolStore = createMockPoolStoreWithIterator([pool]);

    const graph = buildAdjacencyGraph(poolStore, defaultConfig, logger);

    const edges = graph.get('SOL')!;
    expect(edges[0].fee).toBeCloseTo(0.0025, 6);
  });
});

describe('findTriangularPaths', () => {
  it('should return empty array from empty graph', () => {
    const graph: AdjacencyGraph = new Map();

    const paths = findTriangularPaths(graph, defaultConfig);

    expect(paths).toHaveLength(0);
  });

  it('should find triangular path SOL -> USDC -> JUP -> SOL', () => {
    // Build a graph where the triangular path is profitable
    const graph: AdjacencyGraph = new Map();

    // SOL -> USDC (price 100, fee 0.25%)
    graph.set('SOL', [
      { nextToken: 'USDC', pool: createMockPool({ address: 'p1' }), effectivePrice: 100, fee: 0.0025 },
    ]);

    // USDC -> JUP (price 0.05, fee 0.25%)
    graph.set('USDC', [
      { nextToken: 'JUP', pool: createMockPool({ address: 'p2' }), effectivePrice: 0.05, fee: 0.0025 },
    ]);

    // JUP -> SOL (price 0.21, fee 0.25%)
    // For profit: 100 * 0.05 * 0.21 = 1.05 (5% gross profit before fees)
    graph.set('JUP', [
      { nextToken: 'SOL', pool: createMockPool({ address: 'p3' }), effectivePrice: 0.21, fee: 0.0025 },
    ]);

    const paths = findTriangularPaths(graph, defaultConfig);

    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0].steps.length).toBeGreaterThanOrEqual(3);
    expect(paths[0].inputToken).toBe('SOL');
    expect(paths[0].outputToken).toBe('SOL');
  });

  it('should not find path when profit is negative', () => {
    const graph: AdjacencyGraph = new Map();

    // SOL -> USDC at 100, USDC -> JUP at 0.05, JUP -> SOL at 0.19
    // Total: 100 * 0.05 * 0.19 = 0.95 (loss)
    graph.set('SOL', [
      { nextToken: 'USDC', pool: createMockPool({ address: 'p1' }), effectivePrice: 100, fee: 0.003 },
    ]);
    graph.set('USDC', [
      { nextToken: 'JUP', pool: createMockPool({ address: 'p2' }), effectivePrice: 0.05, fee: 0.003 },
    ]);
    graph.set('JUP', [
      { nextToken: 'SOL', pool: createMockPool({ address: 'p3' }), effectivePrice: 0.19, fee: 0.003 },
    ]);

    const paths = findTriangularPaths(graph, defaultConfig);

    expect(paths).toHaveLength(0);
  });

  it('should respect maxTriangularDepth config', () => {
    const graph: AdjacencyGraph = new Map();

    // Build a 5-hop path
    graph.set('A', [{ nextToken: 'B', pool: createMockPool({ address: 'p1' }), effectivePrice: 1.01, fee: 0.001 }]);
    graph.set('B', [{ nextToken: 'C', pool: createMockPool({ address: 'p2' }), effectivePrice: 1.01, fee: 0.001 }]);
    graph.set('C', [{ nextToken: 'D', pool: createMockPool({ address: 'p3' }), effectivePrice: 1.01, fee: 0.001 }]);
    graph.set('D', [{ nextToken: 'E', pool: createMockPool({ address: 'p4' }), effectivePrice: 1.01, fee: 0.001 }]);
    graph.set('E', [{ nextToken: 'A', pool: createMockPool({ address: 'p5' }), effectivePrice: 1.01, fee: 0.001 }]);

    const restrictedConfig = { ...defaultConfig, maxTriangularDepth: 3 };
    const paths = findTriangularPaths(graph, restrictedConfig);

    // Should not find 5-hop paths when max depth is 3
    for (const path of paths) {
      expect(path.steps.length).toBeLessThanOrEqual(3);
    }
  });
});

describe('detectTriangularArbitrage', () => {
  let factory: OpportunityFactory;
  let logger: SolanaArbitrageLogger;

  beforeEach(() => {
    factory = createMockOpportunityFactory();
    logger = createMockLogger();
  });

  it('should return empty result for empty pool store', () => {
    const poolStore = createMockPoolStoreWithIterator([]);

    const result = detectTriangularArbitrage(poolStore, factory, defaultConfig, logger);

    expect(result.opportunities).toHaveLength(0);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.pathsExplored).toBe(0);
  });

  it('should detect triangular opportunity from pools', () => {
    // SOL -> USDC pool
    const pool1 = createMockPool({
      address: 'sol-usdc',
      normalizedToken0: 'SOL',
      normalizedToken1: 'USDC',
      price: 100,
      fee: 10,
      lastUpdated: Date.now(),
    });
    // USDC -> JUP pool
    const pool2 = createMockPool({
      address: 'usdc-jup',
      normalizedToken0: 'USDC',
      normalizedToken1: 'JUP',
      price: 0.05,
      fee: 10,
      lastUpdated: Date.now(),
    });
    // JUP -> SOL pool (inverse: SOL -> JUP at price X, so JUP -> SOL = 1/X)
    // For profit: 100 * 0.05 * inversePrice > 1
    // Need inverse of SOL->JUP > 0.2, i.e. SOL->JUP < 5 (JUP price per SOL)
    const pool3 = createMockPool({
      address: 'sol-jup',
      normalizedToken0: 'SOL',
      normalizedToken1: 'JUP',
      price: 4.5, // SOL/JUP = 4.5, so JUP/SOL = 1/4.5 = 0.222
      fee: 10,
      lastUpdated: Date.now(),
    });

    const poolStore = createMockPoolStoreWithIterator([pool1, pool2, pool3]);

    const result = detectTriangularArbitrage(poolStore, factory, defaultConfig, logger);

    expect(result.opportunities.length).toBeGreaterThan(0);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.pathsExplored).toBe('number');
  });

  it('should include latencyMs and pathsExplored in result', () => {
    const poolStore = createMockPoolStoreWithIterator([]);

    const result = detectTriangularArbitrage(poolStore, factory, defaultConfig, logger);

    expect(result).toHaveProperty('latencyMs');
    expect(result).toHaveProperty('pathsExplored');
    expect(result).toHaveProperty('opportunities');
  });

  it('should filter paths by profit threshold', () => {
    // Very high threshold = no opportunities
    const highThresholdConfig = { ...defaultConfig, minProfitThreshold: 99 };
    const poolStore = createMockPoolStoreWithIterator([]);

    const result = detectTriangularArbitrage(poolStore, factory, highThresholdConfig, logger);

    expect(result.opportunities).toHaveLength(0);
  });

  it('should work without logger parameter', () => {
    const poolStore = createMockPoolStoreWithIterator([]);

    const result = detectTriangularArbitrage(poolStore, factory, defaultConfig);

    expect(result).toBeDefined();
    expect(result.opportunities).toBeDefined();
  });
});
