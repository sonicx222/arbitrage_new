/**
 * Centralized Mock Factories for Execution Engine Tests
 *
 * Canonical definitions for commonly duplicated mocks across strategy,
 * consumer, and service tests. Uses override pattern for per-test
 * customization.
 *
 * @see L4/L5/L6 findings from execution-engine deep analysis
 */

import type { ExecutionStats, StrategyContext } from '../../src/types';
import { createInitialStats } from '../../src/types';
import type { ISimulationService } from '../../src/services/simulation/types';

// =============================================================================
// ExecutionStats Mock (L6: was duplicated in 3 places)
// =============================================================================

/**
 * Create a mock ExecutionStats with all-zero defaults.
 * Uses createInitialStats() to stay in sync with the source type.
 */
export function createMockExecutionStats(
  overrides: Partial<ExecutionStats> = {},
): ExecutionStats {
  return {
    ...createInitialStats(),
    ...overrides,
  };
}

// =============================================================================
// ISimulationService Mock (L4: was duplicated in 3 places)
// =============================================================================

/**
 * Create a mock ISimulationService with sensible defaults.
 * All methods return successful/clean results by default.
 */
export function createMockSimulationService(
  overrides: Partial<ISimulationService> = {},
): ISimulationService {
  return {
    initialize: jest.fn().mockResolvedValue(undefined),
    simulate: jest.fn().mockResolvedValue({
      success: true,
      wouldRevert: false,
      provider: 'tenderly',
      latencyMs: 100,
      gasUsed: BigInt(200000),
    }),
    shouldSimulate: jest.fn().mockReturnValue(true),
    getSimulationTier: jest.fn().mockReturnValue('full'),
    getAggregatedMetrics: jest.fn().mockReturnValue({
      totalSimulations: 0,
      successfulSimulations: 0,
      failedSimulations: 0,
      predictedReverts: 0,
      averageLatencyMs: 0,
      fallbackUsed: 0,
      cacheHits: 0,
      lastUpdated: Date.now(),
    }),
    getProvidersHealth: jest.fn().mockReturnValue(new Map()),
    stop: jest.fn(),
    ...overrides,
  };
}

// =============================================================================
// StrategyContext Mock (L5: was duplicated in 11 places)
// =============================================================================

/**
 * Create a mock StrategyContext with complete defaults.
 *
 * Uses createInitialStats() for full stats (all 22 fields), which prevents
 * test failures when new stats fields are added. Per-test overrides can
 * customize any field including nested stats.
 */
export function createMockStrategyContext(
  overrides: Partial<StrategyContext> = {},
): StrategyContext {
  return {
    logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as any,
    perfLogger: {
      startTimer: jest.fn(),
      endTimer: jest.fn(),
    } as any,
    providers: new Map(),
    wallets: new Map(),
    providerHealth: new Map(),
    nonceManager: null,
    mevProviderFactory: null,
    bridgeRouterFactory: null,
    stateManager: {
      getState: jest.fn().mockReturnValue('running'),
      transition: jest.fn(),
    } as any,
    gasBaselines: new Map(),
    lastGasPrices: new Map(),
    stats: createInitialStats(),
    ...overrides,
  };
}
