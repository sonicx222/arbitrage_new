/**
 * Shared mock factories for OpportunityConsumer test files.
 *
 * Extracted from opportunity.consumer.test.ts and opportunity.consumer.bugfixes.test.ts
 * to eliminate duplication.
 *
 * @see opportunity.consumer.test.ts
 * @see opportunity.consumer.bugfixes.test.ts
 */

import type { Logger, ExecutionStats, QueueService } from '../../../src/types';
import type { ArbitrageOpportunity } from '@arbitrage/types';

export const createMockLogger = (): Logger => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
});

export const createMockStats = (): ExecutionStats => ({
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
  simulationProfitabilityRejections: 0,
  simulationErrors: 0,
  circuitBreakerTrips: 0,
  circuitBreakerBlocks: 0,
  // Capital risk management metrics (Phase 3)
  riskEVRejections: 0,
  riskPositionSizeRejections: 0,
  riskDrawdownBlocks: 0,
  riskCautionCount: 0,
  riskHaltCount: 0,
  staleLockRecoveries: 0,
});

export const createMockQueueService = (overrides: Partial<QueueService> = {}): QueueService => ({
  enqueue: jest.fn().mockReturnValue(true),
  dequeue: jest.fn().mockReturnValue(undefined),
  canEnqueue: jest.fn().mockReturnValue(true),
  size: jest.fn().mockReturnValue(0),
  isPaused: jest.fn().mockReturnValue(false),
  pause: jest.fn(),
  resume: jest.fn(),
  isManuallyPaused: jest.fn().mockReturnValue(false),
  clear: jest.fn(),
  onPauseStateChange: jest.fn(),
  onItemAvailable: jest.fn(),
  ...overrides,
});

export const createMockStreamsClient = () => ({
  createConsumerGroup: jest.fn().mockResolvedValue(undefined),
  xack: jest.fn().mockResolvedValue(1),
  xadd: jest.fn().mockResolvedValue('stream-id'),
  xaddWithLimit: jest.fn().mockResolvedValue('stream-id'),
});

export const createMockStreamConsumer = () => {
  const mockConsumer = {
    start: jest.fn(),
    stop: jest.fn().mockResolvedValue(undefined),
    pause: jest.fn(),
    resume: jest.fn(),
  };
  return mockConsumer;
};

export const createMockOpportunity = (
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
