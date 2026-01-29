/**
 * Strategy Factory Tests
 *
 * Tests for the ExecutionStrategyFactory including:
 * - Strategy registration
 * - Strategy resolution based on opportunity type
 * - Simulation mode handling
 * - Error handling for missing strategies
 */

import { ExecutionStrategyFactory, createStrategyFactory, StrategyType } from './strategy-factory';
import type { ExecutionStrategy, StrategyContext, ExecutionResult, Logger } from '../types';
import type { ArbitrageOpportunity } from '@arbitrage/types';

// =============================================================================
// Mock Implementations
// =============================================================================

const createMockLogger = (): Logger => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
});

const createMockStrategy = (name: string): ExecutionStrategy => ({
  execute: jest.fn().mockResolvedValue({
    opportunityId: 'test-123',
    success: true,
    transactionHash: '0xabc',
    timestamp: Date.now(),
    chain: 'ethereum',
    dex: 'uniswap',
  } as ExecutionResult),
});

const createMockOpportunity = (
  overrides: Partial<ArbitrageOpportunity> = {}
): ArbitrageOpportunity => ({
  id: 'test-opp-123',
  type: 'simple',
  buyChain: 'ethereum',
  sellChain: 'ethereum',
  buyDex: 'uniswap',
  sellDex: 'sushiswap',
  tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  amountIn: '1000000000000000000',
  expectedProfit: 100,
  confidence: 0.95,
  timestamp: Date.now(),
  ...overrides,
});

const createMockContext = (): StrategyContext => ({
  logger: createMockLogger(),
  perfLogger: { track: jest.fn(), getMetrics: jest.fn() } as any,
  providers: new Map(),
  wallets: new Map(),
  providerHealth: new Map(),
  nonceManager: null,
  mevProviderFactory: null,
  bridgeRouterFactory: null,
  stateManager: { isRunning: jest.fn().mockReturnValue(true) } as any,
  gasBaselines: new Map(),
  stats: {
    opportunitiesReceived: 0,
    executionAttempts: 0,
    opportunitiesRejected: 0,
    successfulExecutions: 0,
    failedExecutions: 0,
    queueRejects: 0,
    lockConflicts: 0,
    executionTimeouts: 0,
    validationErrors: 0,
    providerReconnections: 0,
    providerHealthCheckFailures: 0,
    simulationsPerformed: 0,
    simulationsSkipped: 0,
    simulationPredictedReverts: 0,
    simulationErrors: 0,
    circuitBreakerTrips: 0,
    circuitBreakerBlocks: 0,
    // Fix: Add missing risk management stats
    riskEVRejections: 0,
    riskPositionSizeRejections: 0,
    riskDrawdownBlocks: 0,
    riskCautionCount: 0,
    riskHaltCount: 0,
  },
});

// =============================================================================
// Test Suite: Factory Creation
// =============================================================================

describe('ExecutionStrategyFactory - Creation', () => {
  it('should create factory with createStrategyFactory helper', () => {
    const logger = createMockLogger();
    const factory = createStrategyFactory({
      logger,
      isSimulationMode: false,
    });

    expect(factory).toBeInstanceOf(ExecutionStrategyFactory);
  });

  it('should initialize with simulation mode disabled by default', () => {
    const logger = createMockLogger();
    const factory = new ExecutionStrategyFactory({
      logger,
      isSimulationMode: false,
    });

    expect(factory.getSimulationMode()).toBe(false);
  });

  it('should initialize with simulation mode when specified', () => {
    const logger = createMockLogger();
    const factory = new ExecutionStrategyFactory({
      logger,
      isSimulationMode: true,
    });

    expect(factory.getSimulationMode()).toBe(true);
  });
});

// =============================================================================
// Test Suite: Strategy Registration
// =============================================================================

describe('ExecutionStrategyFactory - Registration', () => {
  let factory: ExecutionStrategyFactory;
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = createMockLogger();
    factory = new ExecutionStrategyFactory({
      logger: mockLogger,
      isSimulationMode: false,
    });
  });

  it('should register simulation strategy', () => {
    const strategy = createMockStrategy('simulation');
    factory.registerSimulationStrategy(strategy);

    expect(factory.hasStrategy('simulation')).toBe(true);
    expect(mockLogger.debug).toHaveBeenCalledWith('Registered simulation strategy');
  });

  it('should register cross-chain strategy', () => {
    const strategy = createMockStrategy('cross-chain');
    factory.registerCrossChainStrategy(strategy);

    expect(factory.hasStrategy('cross-chain')).toBe(true);
    expect(mockLogger.debug).toHaveBeenCalledWith('Registered cross-chain strategy');
  });

  it('should register intra-chain strategy', () => {
    const strategy = createMockStrategy('intra-chain');
    factory.registerIntraChainStrategy(strategy);

    expect(factory.hasStrategy('intra-chain')).toBe(true);
    expect(mockLogger.debug).toHaveBeenCalledWith('Registered intra-chain strategy');
  });

  it('should register multiple strategies at once', () => {
    const simStrategy = createMockStrategy('simulation');
    const crossChainStrategy = createMockStrategy('cross-chain');
    const intraChainStrategy = createMockStrategy('intra-chain');

    factory.registerStrategies({
      simulation: simStrategy,
      crossChain: crossChainStrategy,
      intraChain: intraChainStrategy,
    });

    expect(factory.hasStrategy('simulation')).toBe(true);
    expect(factory.hasStrategy('cross-chain')).toBe(true);
    expect(factory.hasStrategy('intra-chain')).toBe(true);
  });

  it('should return registered types', () => {
    factory.registerIntraChainStrategy(createMockStrategy('intra-chain'));
    factory.registerCrossChainStrategy(createMockStrategy('cross-chain'));

    const types = factory.getRegisteredTypes();

    expect(types).toContain('intra-chain');
    expect(types).toContain('cross-chain');
    expect(types).not.toContain('simulation');
  });

  it('should clear all strategies', () => {
    factory.registerIntraChainStrategy(createMockStrategy('intra-chain'));
    factory.registerCrossChainStrategy(createMockStrategy('cross-chain'));

    factory.clear();

    expect(factory.hasStrategy('intra-chain')).toBe(false);
    expect(factory.hasStrategy('cross-chain')).toBe(false);
    expect(mockLogger.debug).toHaveBeenCalledWith('All strategies cleared');
  });
});

// =============================================================================
// Test Suite: Strategy Resolution
// =============================================================================

describe('ExecutionStrategyFactory - Resolution', () => {
  let factory: ExecutionStrategyFactory;
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = createMockLogger();
    factory = new ExecutionStrategyFactory({
      logger: mockLogger,
      isSimulationMode: false,
    });
  });

  describe('with simulation mode disabled', () => {
    it('should resolve intra-chain strategy for simple opportunities', () => {
      const intraChainStrategy = createMockStrategy('intra-chain');
      factory.registerIntraChainStrategy(intraChainStrategy);

      const opportunity = createMockOpportunity({ type: 'simple' });
      const resolution = factory.resolve(opportunity);

      expect(resolution.type).toBe('intra-chain');
      expect(resolution.strategy).toBe(intraChainStrategy);
      expect(resolution.reason).toBe('Default intra-chain execution');
    });

    it('should resolve cross-chain strategy for cross-chain opportunities', () => {
      const intraChainStrategy = createMockStrategy('intra-chain');
      const crossChainStrategy = createMockStrategy('cross-chain');
      factory.registerIntraChainStrategy(intraChainStrategy);
      factory.registerCrossChainStrategy(crossChainStrategy);

      const opportunity = createMockOpportunity({
        type: 'cross-chain',
        buyChain: 'ethereum',
        sellChain: 'arbitrum',
      });
      const resolution = factory.resolve(opportunity);

      expect(resolution.type).toBe('cross-chain');
      expect(resolution.strategy).toBe(crossChainStrategy);
      expect(resolution.reason).toBe('Opportunity type is cross-chain');
    });

    it('should throw error when intra-chain strategy is missing', () => {
      const opportunity = createMockOpportunity({ type: 'simple' });

      expect(() => factory.resolve(opportunity)).toThrow(
        'No intra-chain strategy registered'
      );
    });

    it('should throw error when cross-chain strategy is missing for cross-chain opportunity', () => {
      const intraChainStrategy = createMockStrategy('intra-chain');
      factory.registerIntraChainStrategy(intraChainStrategy);

      const opportunity = createMockOpportunity({ type: 'cross-chain' });

      expect(() => factory.resolve(opportunity)).toThrow(
        'Cross-chain opportunity but no cross-chain strategy registered'
      );
    });
  });

  describe('with simulation mode enabled', () => {
    beforeEach(() => {
      factory.setSimulationMode(true);
    });

    it('should resolve simulation strategy regardless of opportunity type', () => {
      const simulationStrategy = createMockStrategy('simulation');
      const intraChainStrategy = createMockStrategy('intra-chain');
      factory.registerSimulationStrategy(simulationStrategy);
      factory.registerIntraChainStrategy(intraChainStrategy);

      const opportunity = createMockOpportunity({ type: 'simple' });
      const resolution = factory.resolve(opportunity);

      expect(resolution.type).toBe('simulation');
      expect(resolution.strategy).toBe(simulationStrategy);
      expect(resolution.reason).toBe('Simulation mode is active');
    });

    it('should resolve simulation strategy for cross-chain opportunities', () => {
      const simulationStrategy = createMockStrategy('simulation');
      const crossChainStrategy = createMockStrategy('cross-chain');
      factory.registerSimulationStrategy(simulationStrategy);
      factory.registerCrossChainStrategy(crossChainStrategy);

      const opportunity = createMockOpportunity({ type: 'cross-chain' });
      const resolution = factory.resolve(opportunity);

      expect(resolution.type).toBe('simulation');
      expect(resolution.strategy).toBe(simulationStrategy);
    });

    it('should throw error when simulation mode enabled but no simulation strategy registered', () => {
      const intraChainStrategy = createMockStrategy('intra-chain');
      factory.registerIntraChainStrategy(intraChainStrategy);

      const opportunity = createMockOpportunity({ type: 'simple' });

      expect(() => factory.resolve(opportunity)).toThrow(
        'Simulation mode enabled but no simulation strategy registered'
      );
    });
  });
});

// =============================================================================
// Test Suite: Mode Control
// =============================================================================

describe('ExecutionStrategyFactory - Mode Control', () => {
  let factory: ExecutionStrategyFactory;
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = createMockLogger();
    factory = new ExecutionStrategyFactory({
      logger: mockLogger,
      isSimulationMode: false,
    });
  });

  it('should toggle simulation mode', () => {
    expect(factory.getSimulationMode()).toBe(false);

    factory.setSimulationMode(true);
    expect(factory.getSimulationMode()).toBe(true);

    factory.setSimulationMode(false);
    expect(factory.getSimulationMode()).toBe(false);
  });

  it('should log mode changes', () => {
    factory.setSimulationMode(true);

    expect(mockLogger.info).toHaveBeenCalledWith(
      'Strategy factory simulation mode changed',
      { previous: false, current: true }
    );
  });

  it('should not log when mode does not change', () => {
    factory.setSimulationMode(false); // Same as initial

    expect(mockLogger.info).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Test Suite: Execute Convenience Method
// =============================================================================

describe('ExecutionStrategyFactory - Execute', () => {
  let factory: ExecutionStrategyFactory;
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = createMockLogger();
    factory = new ExecutionStrategyFactory({
      logger: mockLogger,
      isSimulationMode: false,
    });
  });

  it('should resolve and execute strategy in one call', async () => {
    const intraChainStrategy = createMockStrategy('intra-chain');
    factory.registerIntraChainStrategy(intraChainStrategy);

    const opportunity = createMockOpportunity();
    const ctx = createMockContext();

    const result = await factory.execute(opportunity, ctx);

    expect(intraChainStrategy.execute).toHaveBeenCalledWith(opportunity, ctx);
    expect(result.success).toBe(true);
  });

  it('should log resolved strategy', async () => {
    const intraChainStrategy = createMockStrategy('intra-chain');
    factory.registerIntraChainStrategy(intraChainStrategy);

    const opportunity = createMockOpportunity();
    const ctx = createMockContext();

    await factory.execute(opportunity, ctx);

    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Strategy resolved',
      expect.objectContaining({
        opportunityId: opportunity.id,
        strategyType: 'intra-chain',
        reason: 'Default intra-chain execution',
      })
    );
  });
});

// =============================================================================
// Test Suite: Readiness Check
// =============================================================================

describe('ExecutionStrategyFactory - Readiness', () => {
  let factory: ExecutionStrategyFactory;
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = createMockLogger();
    factory = new ExecutionStrategyFactory({
      logger: mockLogger,
      isSimulationMode: false,
    });
  });

  it('should report not ready when no strategies registered', () => {
    expect(factory.isReady()).toBe(false);
  });

  it('should report ready when intra-chain strategy is registered', () => {
    factory.registerIntraChainStrategy(createMockStrategy('intra-chain'));

    expect(factory.isReady()).toBe(true);
  });

  it('should report not ready with only simulation strategy', () => {
    factory.registerSimulationStrategy(createMockStrategy('simulation'));

    // Intra-chain is required for production readiness
    expect(factory.isReady()).toBe(false);
  });

  it('should report ready with intra-chain even without cross-chain', () => {
    factory.registerIntraChainStrategy(createMockStrategy('intra-chain'));

    // Cross-chain is optional
    expect(factory.isReady()).toBe(true);
  });
});

// =============================================================================
// Test Suite: Edge Cases
// =============================================================================

describe('ExecutionStrategyFactory - Edge Cases', () => {
  let factory: ExecutionStrategyFactory;
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = createMockLogger();
    factory = new ExecutionStrategyFactory({
      logger: mockLogger,
      isSimulationMode: false,
    });
  });

  it('should handle hasStrategy with invalid type gracefully', () => {
    // TypeScript would catch this, but test runtime behavior
    expect(factory.hasStrategy('unknown' as StrategyType)).toBe(false);
  });

  it('should handle opportunity with undefined type as intra-chain', () => {
    const intraChainStrategy = createMockStrategy('intra-chain');
    factory.registerIntraChainStrategy(intraChainStrategy);

    const opportunity = createMockOpportunity({ type: undefined as any });
    const resolution = factory.resolve(opportunity);

    expect(resolution.type).toBe('intra-chain');
  });

  it('should handle opportunity with null type as intra-chain', () => {
    const intraChainStrategy = createMockStrategy('intra-chain');
    factory.registerIntraChainStrategy(intraChainStrategy);

    const opportunity = createMockOpportunity({ type: null as any });
    const resolution = factory.resolve(opportunity);

    expect(resolution.type).toBe('intra-chain');
  });
});
