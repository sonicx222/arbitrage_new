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
import { createCancellableTimeout } from './services/simulation/types';
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
  recordExecutionFailure,
  recordExecutionLatency,
  recordVolume,
  recordOpportunityOutcome,
  recordProfitSlippage,
  recordOpportunityAge,
  recordProfitPerExecution,
  recordGasCostPerExecution,
} from './services/prometheus-metrics';
// LOG-OPT Task 4: ALS trace context wiring for automatic log correlation
import { withLogContext } from '@arbitrage/core/logging';

// =============================================================================
// Phase 2 Enhanced Monitoring (A2): Outcome Classification
// =============================================================================

/**
 * Classify a failure/error reason into an outcome category for metrics.
 * Used by recordOpportunityOutcome to bucket failures into actionable categories.
 */
function classifyFailureOutcome(reason: string): string {
  const lower = reason.toLowerCase();
  if (lower.includes('timeout')) return 'timeout';
  if (lower.includes('revert')) return 'revert';
  if (lower.includes('gas') && (lower.includes('high') || lower.includes('exceed') || lower.includes('price'))) return 'gas_too_high';
  if (lower.includes('stale') || lower.includes('expired') || lower.includes('outdated')) return 'stale';
  if (lower.includes('nonce')) return 'nonce_error';
  return 'error';
}

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
  /** P2 OPT: Max concurrent executions per individual chain (0 = no per-chain limit) */
  maxConcurrentPerChain: number;

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
  /** P2 OPT: Per-chain active execution tracking for fair chain isolation */
  private readonly perChainExecutionCount = new Map<string, number>();

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
      // H-001 FIX: Track consecutive per-chain skips to prevent infinite loop
      let perChainSkips = 0;

      while (
        this.deps.queueService.size() > 0 &&
        this.activeExecutionCount < this.deps.maxConcurrentExecutions
      ) {
        const opportunity = this.deps.queueService.dequeue();
        if (!opportunity) break;

        // Per-chain circuit breaker check
        // H-002 FIX: Use same chain resolution as executeOpportunity — fall back
        // to opportunity.chain for same-chain arbs where buyChain is undefined.
        const oppChain = opportunity.buyChain ?? opportunity.chain ?? 'unknown';
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

        // P2 OPT: Per-chain concurrency gating — prevents one busy chain from
        // starving others by consuming all global execution slots.
        // H-001 FIX: Track consecutive skips to break out when all items are at capacity,
        // preventing an infinite synchronous loop that blocks the event loop.
        const maxPerChain = this.deps.maxConcurrentPerChain ?? 0;
        if (maxPerChain > 0) {
          const chainCount = this.perChainExecutionCount.get(oppChain) ?? 0;
          if (chainCount >= maxPerChain) {
            this.deps.queueService.enqueue(opportunity);
            perChainSkips++;
            if (perChainSkips >= this.deps.queueService.size()) break; // all remaining items at capacity
            continue;
          }
          perChainSkips = 0; // reset on successful dispatch
          this.perChainExecutionCount.set(oppChain, chainCount + 1);
        }

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
            // P2 OPT: Decrement per-chain counter
            if (maxPerChain > 0) {
              const current = this.perChainExecutionCount.get(oppChain) ?? 0;
              if (current > 0) {
                this.perChainExecutionCount.set(oppChain, current - 1);
              }
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
    const spanId = (opportunity as unknown as Record<string, unknown>)._spanId as string | undefined;

    // LOG-OPT Task 4: Restore ALS trace context for the execution phase.
    // The opportunity traversed the priority queue in a different async context,
    // so we re-enter the ALS context here using the trace IDs stamped at ingest time.
    // This ensures all log calls during lock acquisition, execution, and result
    // publishing automatically include traceId/spanId via the Pino mixin.
    const runExecution = async (): Promise<void> => {
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
    }; // end runExecution

    return traceId && spanId
      ? withLogContext({ traceId, spanId }, runExecution)
      : runExecution();
  }

  // ===========================================================================
  // Timeout Wrapper
  // ===========================================================================

  private async executeWithTimeout(opportunity: ArbitrageOpportunity): Promise<void> {
    const { promise: timeoutPromise, cancel } = createCancellableTimeout<never>(
      EXECUTION_TIMEOUT_MS,
      `Execution timeout after ${EXECUTION_TIMEOUT_MS}ms`,
    );

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
          timeoutMs: EXECUTION_TIMEOUT_MS,
        });
      }
      throw error;
    } finally {
      cancel();
    }
  }

  // ===========================================================================
  // Core Execution (Strategy Dispatch)
  // ===========================================================================

  private async executeOpportunity(opportunity: ArbitrageOpportunity): Promise<void> {
    const startTime = performance.now();

    // Phase 1 Enhanced Monitoring: Stamp execution start
    const ts = opportunity.pipelineTimestamps ?? {};
    ts.executionStartedAt = Date.now();
    opportunity.pipelineTimestamps = ts;

    // Same-chain arbitrage opportunities set 'chain' but not 'buyChain'.
    // Fall back to 'chain' for same-chain arbs; only cross-chain arbs need buyChain explicitly.
    const resolvedBuyChain = opportunity.buyChain ?? opportunity.chain;
    if (!resolvedBuyChain) {
      const errorResult = createErrorResult(
        opportunity.id,
        'Missing required chain field (neither buyChain nor chain set)',
        'unknown',
        opportunity.buyDex || 'unknown'
      );
      await this.deps.publishExecutionResult(errorResult, opportunity);
      this.deps.opportunityConsumer.markComplete(opportunity.id);
      return;
    }

    const chain = resolvedBuyChain;
    const dex = opportunity.buyDex || 'unknown';
    const strategy = opportunity.type ?? 'unknown';

    // Phase 3 (A4): Record opportunity age at execution start
    const detectedAt = ts.detectedAt;
    if (detectedAt) {
      const ageMs = (ts.executionStartedAt ?? Date.now()) - detectedAt;
      if (ageMs >= 0 && Number.isFinite(ageMs)) {
        recordOpportunityAge(chain, ageMs);
      }
    }

    let evCalc: EVCalculation | null = null;
    let positionSize: PositionSize | null = null;
    let drawdownCheck: TradingAllowedResult | null = null;
    let abVariants: Map<string, VariantAssignment> | null = null;

    try {
      this.deps.opportunityConsumer.markActive(opportunity.id);
      this.deps.stats.executionAttempts++;
      recordExecutionAttempt(chain, strategy);

      this.deps.logger.info('Executing arbitrage opportunity', {
        id: opportunity.id,
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
            this.deps.logger.debug('Trade rejected', {
              id: opportunity.id,
              reason: riskDecision.rejectionReason,
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
          // Phase 2 (A2): Record skipped outcome
          recordOpportunityOutcome(chain, 'skipped');
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
          this.deps.logger.debug('Trading with reduced position size', {
            id: opportunity.id,
            drawdownState: drawdownCheck.state,
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

      // Record outcome for risk management.
      // RT-010 FIX: Guard no longer excludes simulation mode — ProbabilityTracker must
      // accumulate data from simulated executions to produce useful win-rate estimates.
      // Note: drawdown breaker also receives simulated trade results (intended: system learns
      // risk patterns before going live; daily reset at UTC midnight bounds any carry-over).
      // Note: riskOrchestrator.assess() remains simulation-mode-gated (line ~400) so the
      // breaker cannot block simulated trades regardless of accumulated state.
      if (this.deps.getRiskManagementEnabled() && this.deps.riskOrchestrator) {
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
        recordExecutionSuccess(chain, strategy);
        recordOpportunityOutcome(chain, 'success');
        if (result.actualProfit != null) {
          // RT-006 FIX: Convert from wei (1e18) to ETH before recording.
          recordVolume(chain, result.actualProfit / 1e18);

          // Phase 3 (F4): Record profit per execution
          recordProfitPerExecution(chain, strategy, result.actualProfit / 1e18);

          // Phase 3 (A3): Record profit slippage (expected vs actual)
          // H-003 FIX: Both expectedProfit and actualProfit are in the same raw
          // units (wei-scale). The /1e18 was already applied to actualProfit for
          // volume and per-execution metrics above, but the slippage ratio must
          // use consistent units — the 1e18 divisors cancel in the ratio.
          if (opportunity.expectedProfit != null && opportunity.expectedProfit !== 0) {
            const slippagePct = ((opportunity.expectedProfit - result.actualProfit) / Math.abs(opportunity.expectedProfit)) * 100;
            if (Number.isFinite(slippagePct)) {
              recordProfitSlippage(chain, strategy, slippagePct);
            }
          }
        }
      } else {
        this.deps.stats.failedExecutions++;
        this.deps.cbManager?.recordFailure(chain);
        const failureReason = result.error ?? 'unknown';
        recordExecutionFailure(chain, strategy, failureReason);
        // Phase 2 (A2): Categorize failure outcome
        recordOpportunityOutcome(chain, classifyFailureOutcome(failureReason));
      }

      // Phase 3 (F5): Record gas cost per execution (success or failure)
      if (result.gasCost != null && Number.isFinite(result.gasCost)) {
        recordGasCostPerExecution(chain, result.gasCost);
      }

      recordExecutionLatency(chain, strategy, latencyMs);

      this.deps.perfLogger.logEventLatency('opportunity_execution', latencyMs, {
        success: result.success,
        profit: result.actualProfit ?? 0,
      });

    } catch (error) {
      this.deps.stats.failedExecutions++;
      this.deps.cbManager?.recordFailure(chain);
      const errorMsg = getErrorMessage(error);
      recordExecutionFailure(chain, strategy, 'exception');
      // Phase 2 (A2): Categorize exception outcome
      recordOpportunityOutcome(chain, classifyFailureOutcome(errorMsg));

      // RT-010 FIX: Record failure outcome regardless of simulation mode (see success path above).
      if (this.deps.getRiskManagementEnabled() && this.deps.riskOrchestrator) {
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
      // Phase 1 Enhanced Monitoring: Stamp execution completion
      const completionTs = opportunity.pipelineTimestamps ?? {};
      completionTs.executionCompletedAt = Date.now();
      opportunity.pipelineTimestamps = completionTs;

      this.deps.opportunityConsumer.markComplete(opportunity.id);
    }
  }
}
