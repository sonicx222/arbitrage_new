/**
 * PreValidationOrchestrator Tests
 *
 * Tests for the extracted pre-validation orchestrator.
 * Verifies budget management, sampling, and simulation callback handling.
 *
 * @see P0-7 - Extract PreValidationOrchestrator
 * @see REFACTORING_IMPLEMENTATION_PLAN.md P0-7
 */

import { PreValidationOrchestrator } from '../../src/pre-validation-orchestrator';
import { PreValidationConfig, CrossChainOpportunity, PreValidationSimulationResult } from '../../src/types';

// Mock logger
const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
};

// Default test config
const defaultConfig: PreValidationConfig = {
  enabled: true,
  sampleRate: 1.0, // 100% for testing
  minProfitForValidation: 50,
  maxLatencyMs: 100,
  monthlyBudget: 100,
  preferredProvider: 'alchemy',
};

// Test opportunity factory
const createOpportunity = (overrides: Partial<CrossChainOpportunity> = {}): CrossChainOpportunity => ({
  token: 'WETH_USDC',
  sourceChain: 'ethereum',
  sourceDex: 'uniswap',
  sourcePrice: 2500,
  targetChain: 'arbitrum',
  targetDex: 'sushiswap',
  targetPrice: 2550,
  priceDiff: 50,
  percentageDiff: 0.02,
  estimatedProfit: 100,
  bridgeCost: 5,
  netProfit: 95,
  confidence: 0.85,
  createdAt: Date.now(),
  ...overrides,
});

describe('PreValidationOrchestrator', () => {
  let orchestrator: PreValidationOrchestrator;

  beforeEach(() => {
    jest.clearAllMocks();
    orchestrator = new PreValidationOrchestrator(defaultConfig, mockLogger, 1000);
  });

  describe('constructor', () => {
    it('should initialize with config', () => {
      expect(orchestrator.isEnabled()).toBe(true);
    });

    it('should respect disabled config', () => {
      const disabledConfig = { ...defaultConfig, enabled: false };
      const disabled = new PreValidationOrchestrator(disabledConfig, mockLogger);
      expect(disabled.isEnabled()).toBe(false);
    });
  });

  describe('validateOpportunity', () => {
    it('should allow all opportunities when disabled', async () => {
      const disabledConfig = { ...defaultConfig, enabled: false };
      const disabled = new PreValidationOrchestrator(disabledConfig, mockLogger);

      const result = await disabled.validateOpportunity(createOpportunity());

      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('not_enabled');
    });

    it('should filter low-profit opportunities', async () => {
      const result = await orchestrator.validateOpportunity(
        createOpportunity({ netProfit: 10 }) // Below threshold
      );

      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('not_sampled'); // Not selected due to profit filter
    });

    it('should allow opportunities without simulation callback (fail-open)', async () => {
      const result = await orchestrator.validateOpportunity(createOpportunity());

      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('validated_pass'); // Pass without validation
    });

    it('should allow opportunities that pass simulation', async () => {
      const mockCallback = jest.fn().mockResolvedValue({
        success: true,
        wouldRevert: false,
        latencyMs: 50,
      } as PreValidationSimulationResult);

      orchestrator.setSimulationCallback(mockCallback);

      const result = await orchestrator.validateOpportunity(createOpportunity());

      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('validated_pass');
      expect(mockCallback).toHaveBeenCalled();
    });

    it('should filter opportunities that would revert', async () => {
      const mockCallback = jest.fn().mockResolvedValue({
        success: true,
        wouldRevert: true,
        latencyMs: 50,
        error: 'Insufficient liquidity',
      } as PreValidationSimulationResult);

      orchestrator.setSimulationCallback(mockCallback);

      const result = await orchestrator.validateOpportunity(createOpportunity());

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('validated_fail');
    });

    it('should allow on simulation timeout (fail-open)', async () => {
      const mockCallback = jest.fn().mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve({
          success: true,
          wouldRevert: false,
          latencyMs: 200,
        }), 200))
      );

      orchestrator.setSimulationCallback(mockCallback);

      const result = await orchestrator.validateOpportunity(createOpportunity());

      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('validated_pass'); // Timeout = pass
    });

    it('should allow on simulation error (fail-open)', async () => {
      const mockCallback = jest.fn().mockRejectedValue(new Error('Simulation failed'));

      orchestrator.setSimulationCallback(mockCallback);

      const result = await orchestrator.validateOpportunity(createOpportunity());

      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('validated_pass'); // Error = pass
    });
  });

  describe('budget management', () => {
    it('should track budget usage', async () => {
      const mockCallback = jest.fn().mockResolvedValue({
        success: true,
        wouldRevert: false,
        latencyMs: 50,
      });

      orchestrator.setSimulationCallback(mockCallback);

      // Validate 3 opportunities
      await orchestrator.validateOpportunity(createOpportunity());
      await orchestrator.validateOpportunity(createOpportunity());
      await orchestrator.validateOpportunity(createOpportunity());

      const metrics = orchestrator.getMetrics();
      expect(metrics.budgetUsed).toBe(3);
      expect(metrics.budgetRemaining).toBe(97);
    });

    it('should stop validating when budget exhausted', async () => {
      const lowBudgetConfig = { ...defaultConfig, monthlyBudget: 2 };
      const limited = new PreValidationOrchestrator(lowBudgetConfig, mockLogger);

      const mockCallback = jest.fn().mockResolvedValue({
        success: true,
        wouldRevert: false,
        latencyMs: 50,
      });
      limited.setSimulationCallback(mockCallback);

      // Validate 3 opportunities (exceeds budget of 2)
      await limited.validateOpportunity(createOpportunity());
      await limited.validateOpportunity(createOpportunity());
      const result = await limited.validateOpportunity(createOpportunity());

      // Third should be skipped (not sampled due to budget)
      expect(result.reason).toBe('not_sampled');
      expect(mockCallback).toHaveBeenCalledTimes(2);
    });
  });

  describe('getMetrics', () => {
    it('should return correct metrics', async () => {
      const mockCallback = jest.fn()
        .mockResolvedValueOnce({ success: true, wouldRevert: false, latencyMs: 50 })
        .mockResolvedValueOnce({ success: true, wouldRevert: true, latencyMs: 50 });

      orchestrator.setSimulationCallback(mockCallback);

      await orchestrator.validateOpportunity(createOpportunity());
      await orchestrator.validateOpportunity(createOpportunity());

      const metrics = orchestrator.getMetrics();

      expect(metrics.budgetUsed).toBe(2);
      expect(metrics.successCount).toBe(1);
      expect(metrics.failCount).toBe(1);
      expect(metrics.successRate).toBe(0.5);
    });
  });

  describe('setSimulationCallback', () => {
    it('should update simulation callback', () => {
      const callback = jest.fn();
      orchestrator.setSimulationCallback(callback);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Pre-validation simulation callback updated',
        expect.objectContaining({ hasCallback: true })
      );
    });

    it('should allow clearing callback', () => {
      orchestrator.setSimulationCallback(null);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Pre-validation simulation callback updated',
        expect.objectContaining({ hasCallback: false })
      );
    });
  });

  describe('reset', () => {
    it('should reset all state', async () => {
      const mockCallback = jest.fn().mockResolvedValue({
        success: true,
        wouldRevert: false,
        latencyMs: 50,
      });
      orchestrator.setSimulationCallback(mockCallback);

      await orchestrator.validateOpportunity(createOpportunity());

      orchestrator.reset();

      const metrics = orchestrator.getMetrics();
      expect(metrics.budgetUsed).toBe(0);
      expect(metrics.successCount).toBe(0);
      expect(metrics.failCount).toBe(0);
    });
  });
});
