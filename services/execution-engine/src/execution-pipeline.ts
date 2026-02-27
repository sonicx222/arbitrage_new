/**
 * Execution Pipeline
 *
 * W1-42 FIX: Extracted from engine.ts to reduce its size (~1850 lines).
 * Encapsulates the core execution flow:
 * - Queue processing loop with concurrency control
 * - Lock acquisition and crash recovery
 * - Strategy dispatch via factory
 * - Result publishing
 *
 * The engine delegates to this pipeline for all execution-related operations.
 * All state and dependencies are injected via the PipelineDeps interface.
 *
 * @see engine.ts — creates and delegates to this pipeline
 * @see ADR-002 — Redis Streams architecture
 */

import type { DistributedLockManager } from '@arbitrage/core/redis';
import { getErrorMessage } from '@arbitrage/core/resilience';
import type { ServiceStateManager } from '@arbitrage/core/service-lifecycle';
import { type PerformanceLogger } from '@arbitrage/core';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import {
  type ExecutionStats,
  type ExecutionResult,
  type StrategyContext,
  type Logger,
  type QueueService,
  EXECUTION_TIMEOUT_MS,
  createErrorResult,
  createSkippedResult,
  ExecutionErrorCode,
} from './types';
import type { ExecutionStrategyFactory } from './strategies/strategy-factory';
import type { OpportunityConsumer } from './consumers/opportunity.consumer';
import type { LockConflictTracker } from './services/lock-conflict-tracker';
import type { CircuitBreakerManager } from './services/circuit-breaker-manager';
import type { RiskManagementOrchestrator } from './risk';
import type {
  ABTestingFramework,
  VariantAssignment,
} from './ab-testing';
import type { EVCalculation, PositionSize, TradingAllowedResult } from '@arbitrage/core/risk';
import {
  recordExecutionAttempt,
  recordExecutionSuccess,
  recordVolume,
} from './services/prometheus-metrics';

// =============================================================================
// Pipeline Dependencies Interface
// =============================================================================

/**
 * Dependencies injected into ExecutionPipeline by the engine.
 * All references are stable for the lifetime of the pipeline (set once at start).
 */
export interface PipelineDeps {
  logger: Logger;
  perfLogger: PerformanceLogger;
  stateManager: ServiceStateManager;
  stats: ExecutionStats;
  queueService: QueueService;
  maxConcurrentExecutions: number;

  // Execution components
  lockManager: DistributedLockManager;
  lockConflictTracker: LockConflictTracker;
  opportunityConsumer: OpportunityConsumer;
  strategyFactory: ExecutionStrategyFactory;

  // Optional components
  cbManager: CircuitBreakerManager | null;
  riskOrchestrator: RiskManagementOrchestrator | null;
  abTestingFramework: ABTestingFramework | null;
  getIsSimulationMode: () => boolean;
  getRiskManagementEnabled: () => boolean;

  // Callbacks back to engine for state that changes
  buildStrategyContext: () => StrategyContext;
  publishExecutionResult: (result: ExecutionResult, opportunity?: ArbitrageOpportunity) => Promise<void>;
  getLastGasPrice: (chain: string) => bigint;
}

// =============================================================================
// ExecutionPipeline Class
// =============================================================================

/**
 * Execution pipeline extracted from engine.ts.
 *
 * Responsibilities:
 * - Queue processing loop (processQueueItems)
 * - Lock acquisition with crash recovery (executeOpportunityWithLock)
 * - Timeout management (executeWithTimeout)
 * - Strategy dispatch and result handling (executeOpportunity)
 *
 * Hot-path considerations:
 * - processQueueItems is synchronous (no allocations in the loop)
 * - executeOpportunity is async but each call is O(1) delegation
 * - No additional function call overhead beyond one level of indirection
 */
export class ExecutionPipeline {
  private readonly deps: PipelineDeps;
  private isProcessingQueue = false;
  private activeExecutionCount = 0;

  /** Track CB re-enqueue attempts per opportunity to prevent infinite loops */
  private readonly cbReenqueueCounts = new Map<string, number>();
  private static readonly MAX_CB_REENQUEUE_ATTEMPTS = 3;
  /** Prevent unbounded growth of cbReenqueueCounts map */
  private static readonly MAX_CB_REENQUEUE_MAP_SIZE = 10_000;

  constructor(deps: PipelineDeps) {
    this.deps = deps;
  }

  // ===========================================================================
  // Queue Processing
  // ===========================================================================

  /**
   * Process queued items up to the concurrency limit.
   * Synchronous loop with async execution fire-and-forget.
   */
  processQueueItems(): void {
    if (!this.deps.stateManager.isRunning()) return;

    // Guard against concurrent entry
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    try {
      while (
        this.deps.queueService.size() > 0 &&
        this.activeExecutionCount < this.deps.maxConcurrentExecutions
      ) {
        const opportunity = this.deps.queueService.dequeue();
        if (!opportunity) break;

        // Per-chain circuit breaker check
        const oppChain = opportunity.buyChain || 'unknown';
        if (this.deps.cbManager && !this.deps.cbManager.canExecute(oppChain)) {
          const reenqueueCount = (this.cbReenqueueCounts.get(opportunity.id) ?? 0) + 1;
          if (reenqueueCount >= ExecutionPipeline.MAX_CB_REENQUEUE_ATTEMPTS) {
            this.cbReenqueueCounts.delete(opportunity.id);
            this.deps.logger.warn('Dropping opportunity after max CB re-enqueue attempts', {
              opportunityId: opportunity.id,
              attempts: reenqueueCount,
            });
            this.deps.stats.circuitBreakerBlocks++;
          } else {
            this.cbReenqueueCounts.set(opportunity.id, reenqueueCount);
            // Evict oldest entries if map grows beyond limit (FIFO via insertion order)
            if (this.cbReenqueueCounts.size > ExecutionPipeline.MAX_CB_REENQUEUE_MAP_SIZE) {
              const iter = this.cbReenqueueCounts.keys();
              const toRemove = Math.floor(ExecutionPipeline.MAX_CB_REENQUEUE_MAP_SIZE * 0.2);
              for (let i = 0; i < toRemove; i++) {
                const key = iter.next().value;
                if (key !== undefined) this.cbReenqueueCounts.delete(key);
              }
            }
            this.deps.queueService.enqueue(opportunity);
            this.deps.stats.circuitBreakerBlocks++;
          }
          continue;
        }

        // Clear re-enqueue tracking when proceeding
        this.cbReenqueueCounts.delete(opportunity.id);
        this.activeExecutionCount++;

        this.executeOpportunityWithLock(opportunity)
          .catch((error) => {
            this.deps.logger.error('Execution failed for opportunity', {
              opportunityId: opportunity.id,
              traceId: (opportunity as unknown as Record<string, unknown>)._traceId,
              error: getErrorMessage(error),
            });
          })
          .finally(() => {
            if (this.activeExecutionCount > 0) {
              this.activeExecutionCount--;
            } else {
              this.deps.logger.warn('activeExecutionCount was already 0, not decrementing');
            }
            if (
              this.deps.stateManager.isRunning() &&
              this.deps.queueService.size() > 0
            ) {
              setImmediate(() => {
                if (!this.isProcessingQueue) {
                  this.processQueueItems();
                }
              });
            }
          });
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  /**
   * Get current active execution count.
   */
  getActiveExecutionCount(): number {
    return this.activeExecutionCount;
  }

  // ===========================================================================
  // Lock Acquisition & Execution
  // ===========================================================================

  private async executeOpportunityWithLock(opportunity: ArbitrageOpportunity): Promise<void> {
    const traceId = (opportunity as unknown as Record<string, unknown>)._traceId as string | undefined;
    const lockResourceId = `opportunity:${opportunity.id}`;

    const lockResult = await this.deps.lockManager.withLock(
      lockResourceId,
      async () => {
        await this.executeWithTimeout(opportunity);
      },
      {
        ttlMs: EXECUTION_TIMEOUT_MS * 2,
        retries: 0,
      }
    );

    if (!lockResult.success) {
      if (lockResult.reason === 'lock_not_acquired') {
        const shouldForceRelease = this.deps.lockConflictTracker.recordConflict(opportunity.id);

        if (shouldForceRelease) {
          this.deps.logger.warn('Detected potential crashed lock holder - force releasing lock', {
            id: opportunity.id,
            traceId,
            conflictCount: this.deps.lockConflictTracker.getConflictInfo(opportunity.id)?.count,
          });

          const released = await this.deps.lockManager.forceRelease(lockResourceId);
          if (released) {
            this.deps.stats.staleLockRecoveries++;
            this.deps.lockConflictTracker.clear(opportunity.id);

            const retryResult = await this.deps.lockManager.withLock(
              lockResourceId,
              async () => {
                await this.executeWithTimeout(opportunity);
              },
              { ttlMs: EXECUTION_TIMEOUT_MS * 2, retries: 0 }
            );

            if (retryResult.success) {
              await this.deps.opportunityConsumer.ackMessageAfterExecution(opportunity.id);
              return;
            } else if (retryResult.reason === 'execution_error') {
              this.deps.logger.error('Opportunity execution failed after crash recovery', {
                id: opportunity.id,
                traceId,
                error: retryResult.error,
              });
              await this.deps.opportunityConsumer.ackMessageAfterExecution(opportunity.id);
              return;
            }
          }
        }

        this.deps.stats.lockConflicts++;
        this.deps.logger.debug('Opportunity skipped - already being executed by another instance', {
          id: opportunity.id,
          traceId,
        });
        return;
      } else if (lockResult.reason === 'redis_error') {
        this.deps.logger.error('Opportunity skipped - Redis unavailable', {
          id: opportunity.id,
          traceId,
          error: lockResult.error?.message,
        });
        return;
      } else if (lockResult.reason === 'execution_error') {
        this.deps.logger.error('Opportunity execution failed', {
          id: opportunity.id,
          traceId,
          error: lockResult.error,
        });
      }
    } else {
      this.deps.lockConflictTracker.clear(opportunity.id);
    }

    await this.deps.opportunityConsumer.ackMessageAfterExecution(opportunity.id);
  }

  // ===========================================================================
  // Timeout Wrapper
  // ===========================================================================

  private async executeWithTimeout(opportunity: ArbitrageOpportunity): Promise<void> {
    let timeoutId: NodeJS.Timeout | null = null;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Execution timeout after ${EXECUTION_TIMEOUT_MS}ms`));
      }, EXECUTION_TIMEOUT_MS);
    });

    try {
      await Promise.race([
        this.executeOpportunity(opportunity),
        timeoutPromise,
      ]);
    } catch (error) {
      if (getErrorMessage(error).includes('timeout')) {
        this.deps.stats.executionTimeouts++;
        this.deps.logger.error('Execution timed out', {
          opportunityId: opportunity.id,
          traceId: (opportunity as unknown as Record<string, unknown>)._traceId,
          timeoutMs: EXECUTION_TIMEOUT_MS,
        });
      }
      throw error;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  // ===========================================================================
  // Core Execution (Strategy Dispatch)
  // ===========================================================================

  private async executeOpportunity(opportunity: ArbitrageOpportunity): Promise<void> {
    const startTime = performance.now();

    if (!opportunity.buyChain) {
      const errorResult = createErrorResult(
        opportunity.id,
        'Missing required buyChain field',
        'unknown',
        opportunity.buyDex || 'unknown'
      );
      await this.deps.publishExecutionResult(errorResult, opportunity);
      this.deps.opportunityConsumer.markComplete(opportunity.id);
      return;
    }

    const chain = opportunity.buyChain || 'unknown';
    const dex = opportunity.buyDex || 'unknown';

    let evCalc: EVCalculation | null = null;
    let positionSize: PositionSize | null = null;
    let drawdownCheck: TradingAllowedResult | null = null;
    let abVariants: Map<string, VariantAssignment> | null = null;

    try {
      this.deps.opportunityConsumer.markActive(opportunity.id);
      this.deps.stats.executionAttempts++;
      recordExecutionAttempt(chain, opportunity.type ?? 'unknown');

      this.deps.logger.info('Executing arbitrage opportunity', {
        id: opportunity.id,
        traceId: (opportunity as unknown as Record<string, unknown>)._traceId,
        type: opportunity.type,
        buyChain: chain,
        buyDex: dex,
        sellDex: opportunity.sellDex,
        expectedProfit: opportunity.expectedProfit,
        simulationMode: this.deps.getIsSimulationMode(),
      });

      // Risk management checks
      if (this.deps.getRiskManagementEnabled() && !this.deps.getIsSimulationMode() && this.deps.riskOrchestrator) {
        let safeGasEstimate: number | undefined;
        if (opportunity.gasEstimate) {
          const raw = Number(opportunity.gasEstimate);
          safeGasEstimate = Number.isFinite(raw) && raw <= Number.MAX_SAFE_INTEGER ? raw : undefined;
        }

        const riskDecision = this.deps.riskOrchestrator.assess({
          chain,
          dex,
          pathLength: opportunity.path?.length ?? 2,
          expectedProfit: opportunity.expectedProfit,
          gasEstimate: safeGasEstimate,
        });

        drawdownCheck = riskDecision.drawdownCheck ?? null;
        evCalc = riskDecision.evCalculation ?? null;
        positionSize = riskDecision.positionSize ?? null;

        if (!riskDecision.allowed) {
          const errorCode = riskDecision.rejectionCode === 'DRAWDOWN_HALT'
            ? ExecutionErrorCode.DRAWDOWN_HALT
            : riskDecision.rejectionCode === 'LOW_EV'
              ? ExecutionErrorCode.LOW_EV
              : ExecutionErrorCode.POSITION_SIZE;

          if (riskDecision.rejectionCode === 'DRAWDOWN_HALT') {
            this.deps.logger.warn('Trade blocked by drawdown circuit breaker', {
              id: opportunity.id,
              state: drawdownCheck?.state,
              reason: riskDecision.rejectionReason,
            });
          } else {
            this.deps.logger.debug(`Trade rejected: ${riskDecision.rejectionReason}`, {
              id: opportunity.id,
              code: riskDecision.rejectionCode,
            });
          }

          const skippedResult = createSkippedResult(
            opportunity.id,
            `${errorCode}: ${riskDecision.rejectionReason}`,
            chain,
            dex
          );
          await this.deps.publishExecutionResult(skippedResult, opportunity);
          return;
        }

        if (positionSize && riskDecision.recommendedSize) {
          this.deps.logger.debug('Position sized for trade', {
            id: opportunity.id,
            recommendedSize: riskDecision.recommendedSize.toString(),
            fractionOfCapital: positionSize.fractionOfCapital,
            sizeMultiplier: drawdownCheck?.sizeMultiplier ?? 1.0,
          });
        }

        if (drawdownCheck?.state === 'CAUTION' || drawdownCheck?.state === 'RECOVERY') {
          this.deps.logger.debug(`Trading with reduced position size (${drawdownCheck.state})`, {
            id: opportunity.id,
            sizeMultiplier: drawdownCheck.sizeMultiplier,
          });
        }
      }

      // A/B testing variant assignment
      if (this.deps.abTestingFramework) {
        abVariants = this.deps.abTestingFramework.assignAllVariants(
          opportunity.id,
          chain,
          dex
        );

        if (abVariants.size > 0) {
          this.deps.logger.debug('A/B variant assignments', {
            id: opportunity.id,
            variants: Object.fromEntries(abVariants),
          });
        }
      }

      // Execute trade via strategy factory
      const ctx = this.deps.buildStrategyContext();
      const result = await this.deps.strategyFactory.execute(opportunity, ctx);

      await this.deps.publishExecutionResult(result, opportunity);
      this.deps.perfLogger.logExecutionResult(result);

      // Record outcome for risk management
      if (this.deps.getRiskManagementEnabled() && !this.deps.getIsSimulationMode() && this.deps.riskOrchestrator) {
        const currentGasPrice = this.deps.getLastGasPrice(chain);

        this.deps.riskOrchestrator.recordOutcome({
          chain,
          dex,
          pathLength: opportunity.path?.length ?? 2,
          success: result.success,
          actualProfit: result.actualProfit,
          gasCost: result.gasCost,
          gasPrice: currentGasPrice,
        });
      }

      // Record A/B testing results
      const latencyMs = performance.now() - startTime;

      if (this.deps.abTestingFramework && abVariants && abVariants.size > 0) {
        for (const [experimentId, variant] of abVariants) {
          await this.deps.abTestingFramework.recordResult(
            experimentId,
            variant,
            result,
            latencyMs,
            false
          );
        }
      }

      if (result.success) {
        this.deps.stats.successfulExecutions++;
        this.deps.cbManager?.recordSuccess(chain);
        recordExecutionSuccess(chain, opportunity.type ?? 'unknown');
        if (result.actualProfit) {
          recordVolume(chain, result.actualProfit);
        }
      } else {
        this.deps.stats.failedExecutions++;
        this.deps.cbManager?.recordFailure(chain);
      }

      this.deps.perfLogger.logEventLatency('opportunity_execution', latencyMs, {
        success: result.success,
        profit: result.actualProfit ?? 0,
      });

    } catch (error) {
      this.deps.stats.failedExecutions++;
      this.deps.cbManager?.recordFailure(chain);

      if (this.deps.getRiskManagementEnabled() && !this.deps.getIsSimulationMode() && this.deps.riskOrchestrator) {
        this.deps.riskOrchestrator.recordOutcome({
          chain,
          dex,
          pathLength: opportunity.path?.length ?? 2,
          success: false,
          actualProfit: undefined,
          gasCost: undefined,
        });
      }

      this.deps.logger.error('Failed to execute opportunity', {
        error,
        opportunityId: opportunity.id,
      });

      const errorResult = createErrorResult(
        opportunity.id,
        getErrorMessage(error),
        chain,
        dex
      );

      await this.deps.publishExecutionResult(errorResult, opportunity);
    } finally {
      this.deps.opportunityConsumer.markComplete(opportunity.id);
    }
  }
}
