/**
 * Triangular Arbitrage Detector
 *
 * Detects triangular arbitrage paths on Solana (e.g., SOL→USDC→JUP→SOL).
 * Uses graph-based path finding with bounded search.
 *
 * Features:
 * - Adjacency graph for efficient path finding
 * - DFS with bounded depth and path count
 * - Fee-aware profit calculation
 * - Memoization cache with size limit
 *
 * @see R1 - Solana Arbitrage Detection Modules extraction
 */

import type { VersionedPoolStore } from '../pool/versioned-pool-store';
import type { OpportunityFactory } from '../opportunity-factory';
import type {
  InternalPoolInfo,
  SolanaArbitrageOpportunity,
  TriangularPath,
  TriangularPathStep,
  SolanaArbitrageLogger,
} from '../types';
import {
  isValidPrice,
  isValidDecimalFee,
  isPriceStale,
  bpsToDecimal,
  MIN_VALID_PRICE,
  MAX_PATHS_PER_LEVEL,
  MAX_MEMO_CACHE_SIZE,
} from './base';

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for triangular detection.
 */
export interface TriangularDetectorConfig {
  /** Minimum profit threshold as decimal (e.g., 0.003 = 0.3%) */
  minProfitThreshold: number;
  /** Maximum depth for triangular paths */
  maxTriangularDepth: number;
  /** Price staleness threshold in ms */
  priceStalenessMs: number;
}

/**
 * Edge in the adjacency graph.
 */
export interface GraphEdge {
  /** Token received after this edge */
  nextToken: string;
  /** Pool for this edge */
  pool: InternalPoolInfo;
  /** Effective price for this edge */
  effectivePrice: number;
  /** Fee in decimal format */
  fee: number;
}

/**
 * Adjacency graph for path finding.
 */
export type AdjacencyGraph = Map<string, GraphEdge[]>;

/**
 * Detection result with statistics.
 */
export interface TriangularDetectionResult {
  /** Found opportunities */
  opportunities: SolanaArbitrageOpportunity[];
  /** Detection latency in ms */
  latencyMs: number;
  /** Number of paths explored */
  pathsExplored: number;
}

// =============================================================================
// Graph Building
// =============================================================================

/**
 * Build adjacency graph for efficient path finding.
 *
 * Each edge represents a swap from one token to another.
 * Includes both directions (token0→token1 and token1→token0).
 *
 * @param poolStore - Pool store to read from
 * @param config - Detection configuration
 * @param logger - Optional logger
 * @returns Adjacency graph
 */
export function buildAdjacencyGraph(
  poolStore: VersionedPoolStore,
  config: TriangularDetectorConfig,
  logger?: SolanaArbitrageLogger
): AdjacencyGraph {
  const graph = new Map<string, GraphEdge[]>();

  // Use iterator to avoid array allocation
  for (const pool of poolStore.poolsIterator()) {
    if (!isValidPrice(pool.price) || isPriceStale(pool, config.priceStalenessMs, logger)) {
      continue;
    }

    const token0 = pool.normalizedToken0;
    const token1 = pool.normalizedToken1;
    const fee = bpsToDecimal(pool.fee);

    // Add edge token0 -> token1
    if (!graph.has(token0)) graph.set(token0, []);
    graph.get(token0)!.push({
      nextToken: token1,
      pool,
      effectivePrice: pool.price!,
      fee,
    });

    // Add edge token1 -> token0 (inverse price)
    // Check price is valid BEFORE division
    if (pool.price && pool.price > MIN_VALID_PRICE) {
      const inversePrice = 1 / pool.price;
      if (isFinite(inversePrice) && inversePrice >= MIN_VALID_PRICE) {
        if (!graph.has(token1)) graph.set(token1, []);
        graph.get(token1)!.push({
          nextToken: token0,
          pool,
          effectivePrice: inversePrice,
          fee,
        });
      }
    }
  }

  return graph;
}

// =============================================================================
// Path Finding
// =============================================================================

/**
 * Find triangular paths using optimized DFS.
 *
 * @param graph - Adjacency graph
 * @param config - Detection configuration
 * @returns Array of profitable paths
 */
export function findTriangularPaths(
  graph: AdjacencyGraph,
  config: TriangularDetectorConfig
): TriangularPath[] {
  const paths: TriangularPath[] = [];
  const startTokens = Array.from(graph.keys());

  // Bounded memoization cache
  const visited = new Set<string>();
  let pathsFound = 0;

  for (const startToken of startTokens) {
    if (pathsFound >= MAX_PATHS_PER_LEVEL * 10) break; // Global limit

    const prevLength = paths.length;

    // DFS from each start token — uses backtracking with shared mutable state
    dfsPathFinding(
      graph,
      startToken,
      startToken,
      [],            // currentPath (mutated in-place)
      new Set<string>(),  // visitedPools (mutated in-place)
      new Set<string>([startToken]), // visitedTokens (mutated in-place, start token pre-added)
      0,
      visited,
      config.maxTriangularDepth,
      paths          // results accumulated in-place
    );

    pathsFound += paths.length - prevLength;
  }

  return paths;
}

/**
 * DFS path finding with bounded search using backtracking pattern.
 * Uses mutate-then-undo to avoid O(n) copies per recursive call.
 */
function dfsPathFinding(
  graph: AdjacencyGraph,
  startToken: string,
  currentToken: string,
  currentPath: TriangularPathStep[],
  visitedPools: Set<string>,
  visitedTokens: Set<string>,
  depth: number,
  globalVisited: Set<string>,
  maxDepth: number,
  results: TriangularPath[]
): void {
  // Check for valid completion at ANY depth >= 3
  if (currentToken === startToken && currentPath.length >= 3) {
    const profitResult = calculateTriangularProfit(currentPath);
    if (profitResult && profitResult.profitPercentage > 0) {
      results.push({
        steps: currentPath.slice(), // snapshot only when we found a profitable path
        inputToken: startToken,
        outputToken: startToken,
        profitPercentage: profitResult.profitPercentage,
        estimatedOutput: profitResult.estimatedOutput,
      });
    }
  }

  // Max depth check
  if (depth >= maxDepth) {
    return;
  }

  // Limit global visited to prevent memory leak
  if (globalVisited.size >= MAX_MEMO_CACHE_SIZE) {
    return;
  }

  const edges = graph.get(currentToken) || [];
  let pathsAtLevel = 0;

  for (const edge of edges) {
    if (pathsAtLevel >= MAX_PATHS_PER_LEVEL) break;
    if (visitedPools.has(edge.pool.address)) continue;

    // Allow returning to start, but not other revisits — O(1) Set lookup
    if (visitedTokens.has(edge.nextToken) && edge.nextToken !== startToken) continue;

    const step: TriangularPathStep = {
      token: edge.nextToken,
      pool: edge.pool.address,
      dex: edge.pool.dex,
      price: edge.effectivePrice,
      fee: edge.fee,
    };

    const cacheKey = `${startToken}-${edge.nextToken}-${depth}-${edge.pool.address}`;
    if (!globalVisited.has(cacheKey)) {
      globalVisited.add(cacheKey);

      // Backtracking: mutate, recurse, undo
      visitedPools.add(edge.pool.address);
      if (edge.nextToken !== startToken) {
        visitedTokens.add(edge.nextToken);
      }
      currentPath.push(step);

      const prevLength = results.length;

      dfsPathFinding(
        graph,
        startToken,
        edge.nextToken,
        currentPath,
        visitedPools,
        visitedTokens,
        depth + 1,
        globalVisited,
        maxDepth,
        results
      );

      // Undo mutations (guard startToken to prevent accidental removal)
      currentPath.pop();
      if (edge.nextToken !== startToken) {
        visitedTokens.delete(edge.nextToken);
      }
      visitedPools.delete(edge.pool.address);

      pathsAtLevel += results.length - prevLength;
    }
  }
}

/**
 * Calculate profit for a triangular path.
 *
 * @param path - Path steps
 * @returns Profit info or null if invalid
 */
function calculateTriangularProfit(
  path: TriangularPathStep[]
): { profitPercentage: number; estimatedOutput: number } | null {
  if (path.length < 3) return null;

  let amount = 1.0;

  for (const step of path) {
    // Validate price before using
    if (!isValidPrice(step.price)) {
      return null;
    }

    // Validate fee is in valid DECIMAL format
    if (!isValidDecimalFee(step.fee)) {
      return null;
    }

    amount = amount * step.price;
    amount = amount * (1 - step.fee);

    // Check for overflow/underflow after each step
    if (!isFinite(amount) || amount <= 0) {
      return null;
    }
  }

  const profit = amount - 1;
  if (profit <= 0) return null;

  return {
    profitPercentage: profit * 100,
    estimatedOutput: amount,
  };
}

// =============================================================================
// Main Detection Function
// =============================================================================

/**
 * Detect triangular arbitrage opportunities.
 *
 * @param poolStore - Pool store to read from
 * @param opportunityFactory - Factory for creating opportunities
 * @param config - Detection configuration
 * @param logger - Optional logger
 * @returns Detection result with opportunities
 */
export function detectTriangularArbitrage(
  poolStore: VersionedPoolStore,
  opportunityFactory: OpportunityFactory,
  config: TriangularDetectorConfig,
  logger?: SolanaArbitrageLogger
): TriangularDetectionResult {
  const startTime = Date.now();
  const opportunities: SolanaArbitrageOpportunity[] = [];
  const thresholdDecimal = config.minProfitThreshold / 100;

  // Build adjacency graph
  const graph = buildAdjacencyGraph(poolStore, config, logger);

  // Find triangular paths
  const paths = findTriangularPaths(graph, config);

  // Convert profitable paths to opportunities
  for (const path of paths) {
    if (path.profitPercentage / 100 >= thresholdDecimal) {
      const opportunity = opportunityFactory.createTriangular(path);
      opportunities.push(opportunity);
    }
  }

  return {
    opportunities,
    latencyMs: Date.now() - startTime,
    pathsExplored: paths.length,
  };
}
