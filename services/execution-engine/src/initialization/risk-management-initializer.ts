/**
 * Risk Management Initialization
 *
 * Extracted from engine.ts for single-responsibility principle.
 * Handles capital risk management component setup.
 *
 * NOT part of hot path - called once during initialization.
 *
 * @see ADR-021: Capital Risk Management
 */

import {
  DrawdownCircuitBreaker,
  getDrawdownCircuitBreaker,
  EVCalculator,
  getEVCalculator,
  KellyPositionSizer,
  getKellyPositionSizer,
  ExecutionProbabilityTracker,
  getExecutionProbabilityTracker,
  getErrorMessage,
  type DrawdownConfig,
  type EVConfig,
  type PositionSizerConfig,
  type ExecutionProbabilityConfig,
} from '@arbitrage/core';
import { RISK_CONFIG } from '@arbitrage/config';
import type { RiskManagementComponents, InitializationLogger } from './types';

/**
 * Initialize all capital risk management components.
 *
 * @param logger - Logger instance
 * @returns All risk management components or nulls if disabled
 */
export function initializeRiskManagement(logger: InitializationLogger): RiskManagementComponents {
  if (!RISK_CONFIG.enabled) {
    logger.info('Capital risk management disabled by configuration');
    return {
      drawdownBreaker: null,
      evCalculator: null,
      positionSizer: null,
      probabilityTracker: null,
      enabled: false,
    };
  }

  try {
    // Initialize Execution Probability Tracker (Task 3.4.1)
    const probabilityConfig: Partial<ExecutionProbabilityConfig> = {
      minSamples: RISK_CONFIG.probability.minSamples,
      defaultWinProbability: RISK_CONFIG.probability.defaultWinProbability,
      maxOutcomesPerKey: RISK_CONFIG.probability.maxOutcomesPerKey,
      cleanupIntervalMs: RISK_CONFIG.probability.cleanupIntervalMs,
      outcomeRelevanceWindowMs: RISK_CONFIG.probability.outcomeRelevanceWindowMs,
      persistToRedis: RISK_CONFIG.probability.persistToRedis,
      redisKeyPrefix: RISK_CONFIG.probability.redisKeyPrefix,
    };
    const probabilityTracker = getExecutionProbabilityTracker(probabilityConfig);

    logger.info('Execution probability tracker initialized', {
      minSamples: RISK_CONFIG.probability.minSamples,
      defaultWinProbability: RISK_CONFIG.probability.defaultWinProbability,
    });

    // Initialize EV Calculator (Task 3.4.2)
    const evConfig: Partial<EVConfig> = {
      minEVThreshold: RISK_CONFIG.ev.minEVThreshold,
      minWinProbability: RISK_CONFIG.ev.minWinProbability,
      maxLossPerTrade: RISK_CONFIG.ev.maxLossPerTrade,
      useHistoricalGasCost: RISK_CONFIG.ev.useHistoricalGasCost,
      defaultGasCost: RISK_CONFIG.ev.defaultGasCost,
      defaultProfitEstimate: RISK_CONFIG.ev.defaultProfitEstimate,
    };
    const evCalculator = getEVCalculator(probabilityTracker, evConfig);

    logger.info('EV calculator initialized', {
      minEVThreshold: RISK_CONFIG.ev.minEVThreshold?.toString(),
    });

    // Initialize Kelly Position Sizer (Task 3.4.3)
    const positionConfig: Partial<PositionSizerConfig> = {
      kellyMultiplier: RISK_CONFIG.positionSizing.kellyMultiplier,
      maxSingleTradeFraction: RISK_CONFIG.positionSizing.maxSingleTradeFraction,
      minTradeFraction: RISK_CONFIG.positionSizing.minTradeFraction,
      totalCapital: RISK_CONFIG.totalCapital,
      enabled: RISK_CONFIG.positionSizing.enabled,
    };
    const positionSizer = getKellyPositionSizer(positionConfig);

    logger.info('Kelly position sizer initialized', {
      kellyMultiplier: RISK_CONFIG.positionSizing.kellyMultiplier,
      maxSingleTradeFraction: RISK_CONFIG.positionSizing.maxSingleTradeFraction,
    });

    // Initialize Drawdown Circuit Breaker (Task 3.4.4)
    const drawdownConfig: Partial<DrawdownConfig> = {
      maxDailyLoss: RISK_CONFIG.drawdown.maxDailyLoss,
      cautionThreshold: RISK_CONFIG.drawdown.cautionThreshold,
      maxConsecutiveLosses: RISK_CONFIG.drawdown.maxConsecutiveLosses,
      recoveryMultiplier: RISK_CONFIG.drawdown.recoveryMultiplier,
      recoveryWinsRequired: RISK_CONFIG.drawdown.recoveryWinsRequired,
      haltCooldownMs: RISK_CONFIG.drawdown.haltCooldownMs,
      totalCapital: RISK_CONFIG.totalCapital,
      enabled: RISK_CONFIG.drawdown.enabled,
    };
    const drawdownBreaker = getDrawdownCircuitBreaker(drawdownConfig);

    logger.info('Drawdown circuit breaker initialized', {
      maxDailyLoss: `${RISK_CONFIG.drawdown.maxDailyLoss * 100}%`,
      cautionThreshold: `${RISK_CONFIG.drawdown.cautionThreshold * 100}%`,
    });

    logger.info('Capital risk management fully initialized');

    return {
      drawdownBreaker,
      evCalculator,
      positionSizer,
      probabilityTracker,
      enabled: true,
    };
  } catch (error) {
    logger.error('Failed to initialize risk management', { error: getErrorMessage(error) });
    return {
      drawdownBreaker: null,
      evCalculator: null,
      positionSizer: null,
      probabilityTracker: null,
      enabled: false,
    };
  }
}
