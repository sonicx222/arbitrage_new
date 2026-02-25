/**
 * Risk Management Initialization
 *
 * Extracted from engine.ts for single-responsibility principle.
 * Handles capital risk management component setup.
 *
 * NOT part of hot path - called once during initialization.
 *
 * ADR-021 Compliance:
 * - Initializes all risk components: ProbabilityTracker, EVCalculator, PositionSizer, DrawdownBreaker
 * - Supports partial initialization (some components may fail while others succeed)
 * - Validates configuration in production environments
 * - Uses cautionMultiplier for reduced position sizing during CAUTION state
 *
 * Component Dependencies:
 * - EVCalculator requires ProbabilityTracker (for win probability data)
 * - PositionSizer and DrawdownBreaker are independent
 *
 * @see ADR-021: Capital Risk Management
 */

import { getErrorMessage } from '@arbitrage/core/resilience';
import {
  DrawdownCircuitBreaker,
  getDrawdownCircuitBreaker,
  EVCalculator,
  getEVCalculator,
  KellyPositionSizer,
  getKellyPositionSizer,
  ExecutionProbabilityTracker,
  getExecutionProbabilityTracker,
  type DrawdownConfig,
  type EVConfig,
  type PositionSizerConfig,
  type ExecutionProbabilityConfig,
} from '@arbitrage/core/risk';
import { RISK_CONFIG, validateRiskConfig } from '@arbitrage/config';
import type { RiskManagementComponents, InitializationLogger, InitializationConfig } from './types';
import { createDisabledRiskResult, createFailedRiskResult } from './types';

/**
 * Initialize all capital risk management components.
 *
 * Implements partial initialization - if one component fails, others still initialize.
 * This prevents a single component error from disabling all risk management.
 *
 * @param logger - Logger instance
 * @param config - Optional initialization configuration
 * @param config.skipValidation - Skip config validation (useful for testing)
 * @param config.forceRiskManagement - Force enable even if RISK_CONFIG.enabled is false
 *        This is useful for integration tests that need risk components active
 *        without modifying environment variables.
 * @returns All risk management components with detailed status
 */
export function initializeRiskManagement(
  logger: InitializationLogger,
  config?: InitializationConfig
): RiskManagementComponents {
  const startTime = performance.now();

  // Check if disabled by config (unless force-enabled)
  if (!RISK_CONFIG.enabled && !config?.forceRiskManagement) {
    logger.info('Capital risk management disabled by configuration');
    return createDisabledRiskResult();
  }

  // Log if force-enabled
  if (!RISK_CONFIG.enabled && config?.forceRiskManagement) {
    logger.info('Capital risk management force-enabled via InitializationConfig');
  }

  // Run production validation unless skipped
  if (!config?.skipValidation) {
    try {
      validateRiskConfig();
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      // Use standardized error format: component:reason
      const standardizedError = `risk:config_validation_failed:${errorMessage}`;
      logger.error('Risk configuration validation failed', { error: standardizedError });

      // In production, fail fast; in development, continue with warning
      if (process.env.NODE_ENV === 'production') {
        return createFailedRiskResult(standardizedError);
      }
      logger.warn('Continuing with potentially invalid risk configuration in non-production');
    }
  }

  // Track component status for diagnostics
  const componentStatus = {
    probabilityTracker: false,
    evCalculator: false,
    positionSizer: false,
    drawdownBreaker: false,
  };

  // Initialize each component independently for partial initialization support
  let probabilityTracker: ExecutionProbabilityTracker | null = null;
  let evCalculator: EVCalculator | null = null;
  let positionSizer: KellyPositionSizer | null = null;
  let drawdownBreaker: DrawdownCircuitBreaker | null = null;
  const errors: string[] = [];

  // Step 1: Initialize Execution Probability Tracker (no dependencies)
  try {
    const probabilityConfig: Partial<ExecutionProbabilityConfig> = {
      minSamples: RISK_CONFIG.probability.minSamples,
      defaultWinProbability: RISK_CONFIG.probability.defaultWinProbability,
      maxOutcomesPerKey: RISK_CONFIG.probability.maxOutcomesPerKey,
      cleanupIntervalMs: RISK_CONFIG.probability.cleanupIntervalMs,
      outcomeRelevanceWindowMs: RISK_CONFIG.probability.outcomeRelevanceWindowMs,
      persistToRedis: RISK_CONFIG.probability.persistToRedis,
      redisKeyPrefix: RISK_CONFIG.probability.redisKeyPrefix,
    };
    // Fix 2: Pass Redis client for probability persistence (previously always null)
    probabilityTracker = getExecutionProbabilityTracker(probabilityConfig, config?.redis);
    componentStatus.probabilityTracker = true;

    logger.info('Execution probability tracker initialized', {
      minSamples: RISK_CONFIG.probability.minSamples,
      defaultWinProbability: RISK_CONFIG.probability.defaultWinProbability,
    });
  } catch (error) {
    // Use standardized error format
    const errorMsg = `risk:probability_tracker:${getErrorMessage(error)}`;
    errors.push(errorMsg);
    logger.error('Failed to initialize execution probability tracker', { error: errorMsg });
  }

  // Step 2: Initialize EV Calculator (requires probabilityTracker)
  try {
    if (probabilityTracker) {
      const evConfig: Partial<EVConfig> = {
        minEVThreshold: RISK_CONFIG.ev.minEVThreshold,
        minWinProbability: RISK_CONFIG.ev.minWinProbability,
        maxLossPerTrade: RISK_CONFIG.ev.maxLossPerTrade,
        useHistoricalGasCost: RISK_CONFIG.ev.useHistoricalGasCost,
        defaultGasCost: RISK_CONFIG.ev.defaultGasCost,
        defaultProfitEstimate: RISK_CONFIG.ev.defaultProfitEstimate,
      };
      evCalculator = getEVCalculator(probabilityTracker, evConfig);
      componentStatus.evCalculator = true;

      logger.info('EV calculator initialized', {
        minEVThreshold: RISK_CONFIG.ev.minEVThreshold?.toString(),
      });
    } else {
      // Use info level for expected skip due to dependency (consistent with other initializers)
      const skipMsg = 'risk:ev_calculator:skipped_missing_probability_tracker';
      errors.push(skipMsg);
      logger.info('Skipping EV calculator: requires probability tracker which failed to initialize');
    }
  } catch (error) {
    const errorMsg = `risk:ev_calculator:${getErrorMessage(error)}`;
    errors.push(errorMsg);
    logger.error('Failed to initialize EV calculator', { error: errorMsg });
  }

  // Step 3: Initialize Kelly Position Sizer (no dependencies)
  try {
    const positionConfig: Partial<PositionSizerConfig> = {
      kellyMultiplier: RISK_CONFIG.positionSizing.kellyMultiplier,
      maxSingleTradeFraction: RISK_CONFIG.positionSizing.maxSingleTradeFraction,
      minTradeFraction: RISK_CONFIG.positionSizing.minTradeFraction,
      totalCapital: RISK_CONFIG.totalCapital,
      enabled: RISK_CONFIG.positionSizing.enabled,
    };
    positionSizer = getKellyPositionSizer(positionConfig);
    componentStatus.positionSizer = true;

    logger.info('Kelly position sizer initialized', {
      kellyMultiplier: RISK_CONFIG.positionSizing.kellyMultiplier,
      maxSingleTradeFraction: RISK_CONFIG.positionSizing.maxSingleTradeFraction,
    });
  } catch (error) {
    const errorMsg = `risk:position_sizer:${getErrorMessage(error)}`;
    errors.push(errorMsg);
    logger.error('Failed to initialize Kelly position sizer', { error: errorMsg });
  }

  // Step 4: Initialize Drawdown Circuit Breaker (no dependencies)
  try {
    const drawdownConfig: Partial<DrawdownConfig> = {
      maxDailyLoss: RISK_CONFIG.drawdown.maxDailyLoss,
      cautionThreshold: RISK_CONFIG.drawdown.cautionThreshold,
      maxConsecutiveLosses: RISK_CONFIG.drawdown.maxConsecutiveLosses,
      recoveryMultiplier: RISK_CONFIG.drawdown.recoveryMultiplier,
      recoveryWinsRequired: RISK_CONFIG.drawdown.recoveryWinsRequired,
      haltCooldownMs: RISK_CONFIG.drawdown.haltCooldownMs,
      totalCapital: RISK_CONFIG.totalCapital,
      enabled: RISK_CONFIG.drawdown.enabled,
      cautionMultiplier: RISK_CONFIG.drawdown.cautionMultiplier,
    };
    drawdownBreaker = getDrawdownCircuitBreaker(drawdownConfig);
    componentStatus.drawdownBreaker = true;

    logger.info('Drawdown circuit breaker initialized', {
      maxDailyLoss: `${RISK_CONFIG.drawdown.maxDailyLoss * 100}%`,
      cautionThreshold: `${RISK_CONFIG.drawdown.cautionThreshold * 100}%`,
      cautionMultiplier: RISK_CONFIG.drawdown.cautionMultiplier,
    });
  } catch (error) {
    const errorMsg = `risk:drawdown_breaker:${getErrorMessage(error)}`;
    errors.push(errorMsg);
    logger.error('Failed to initialize drawdown circuit breaker', { error: errorMsg });
  }

  // Determine overall status
  const successfulComponents = Object.values(componentStatus).filter(Boolean).length;
  const anyEnabled = successfulComponents > 0;
  const durationMs = performance.now() - startTime;

  if (successfulComponents === 4) {
    logger.info('Capital risk management fully initialized', {
      durationMs: Math.round(durationMs),
    });
  } else if (anyEnabled) {
    logger.warn('Capital risk management partially initialized', {
      componentStatus,
      errors,
      durationMs: Math.round(durationMs),
    });
  } else {
    // Use standardized error format for complete failure
    const errorMsg = 'risk:all_components_failed';
    logger.error('Capital risk management completely failed', {
      error: errorMsg,
      componentErrors: errors,
      durationMs: Math.round(durationMs),
    });
  }

  return {
    drawdownBreaker,
    evCalculator,
    positionSizer,
    probabilityTracker,
    enabled: anyEnabled,
    success: successfulComponents > 0,
    error: errors.length > 0 ? errors.join('; ') : undefined,
    componentStatus,
  };
}
