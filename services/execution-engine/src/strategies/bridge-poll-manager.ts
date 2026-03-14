/**
 * CQ-8: Bridge Polling Manager
 *
 * Extracted from CrossChainStrategy to reduce file size.
 * Handles polling bridge routers for completion status with backoff scheduling.
 *
 * @see CrossChainStrategy.execute() — caller
 * @see BridgeRecoveryService — sister module for recovery
 */

import { BRIDGE_DEFAULTS } from '@arbitrage/core/bridge-router';
import { getErrorMessage } from '@arbitrage/core/resilience';
import type { BridgeStatusResult } from '@arbitrage/core/bridge-router';
import type { StrategyContext, BridgePollingResult, Logger } from '../types';
import { ExecutionErrorCode } from '../types';

/**
 * FIX 10.4: Pre-computed bridge polling backoff schedule (performance optimization)
 *
 * Eliminates per-iteration calculations for polling interval.
 * Schedule defines polling intervals based on elapsed time.
 *
 * Format: [afterMs, intervalMs]
 * - afterMs: Apply this interval after X milliseconds have elapsed
 * - intervalMs: Poll every X milliseconds
 *
 * Schedule is checked in order, first match wins.
 */
const BRIDGE_POLL_BACKOFF_SCHEDULE = [
  { afterMs: 120000, intervalMs: 20000 },  // After 2min: poll every 20s
  { afterMs: 60000, intervalMs: 15000 },   // After 1min: poll every 15s
  { afterMs: 30000, intervalMs: 10000 },   // After 30s: poll every 10s
  { afterMs: 0, intervalMs: 5000 },        // First 30s: poll every 5s
] as const;

/**
 * Poll a bridge router for completion status with exponential backoff.
 *
 * FIX 3.1: Bridge recovery implemented.
 * - Store BridgeRecoveryState in Redis before bridge initiation
 * - On engine restart, query pending bridges and resume polling
 * - Implemented timeout handling for bridges that exceed max wait time
 * @see persistBridgeRecoveryState, recoverPendingBridges, BridgeRecoveryState
 *
 * @param bridgeRouter - Bridge router instance
 * @param bridgeId - Bridge transaction ID
 * @param opportunityId - Opportunity ID for logging
 * @param sourceChain - Source chain for error results
 * @param sourceTxHash - Source transaction hash
 * @param ctx - Strategy context (for shutdown detection)
 * @param logger - Logger instance
 * @returns Polling result with completion status or error
 */
export async function pollBridgeCompletion(
  bridgeRouter: NonNullable<ReturnType<NonNullable<StrategyContext['bridgeRouterFactory']>['getRouter']>>,
  bridgeId: string,
  opportunityId: string,
  sourceChain: string,
  sourceTxHash: string,
  ctx: StrategyContext,
  logger: Logger,
): Promise<BridgePollingResult> {
  const maxWaitTime = BRIDGE_DEFAULTS.maxBridgeWaitMs;
  const pollInterval = BRIDGE_DEFAULTS.statusPollIntervalMs;
  const bridgeStartTime = Date.now();

  // Fix 4.3: Calculate maximum iterations based on wait time and minimum poll interval
  const minPollInterval = Math.min(pollInterval, 5000);
  const maxIterations = Math.ceil(maxWaitTime / minPollInterval) + 10;
  let iterationCount = 0;

  let lastSeenStatus = 'pending';

  // Race 5.3 Fix: Pre-compute deadline
  const pollDeadline = bridgeStartTime + maxWaitTime;

  while (iterationCount < maxIterations) {
    iterationCount++;

    // Race 5.3 Fix: Check time FIRST
    const now = Date.now();
    if (now >= pollDeadline) {
      break;
    }

    // Check for shutdown
    if (!ctx.stateManager.isRunning()) {
      logger.warn('Bridge polling interrupted by shutdown', {
        opportunityId,
        bridgeId,
      });
      return {
        completed: false,
        error: {
          code: ExecutionErrorCode.SHUTDOWN,
          message: 'Polling interrupted by shutdown',
          sourceTxHash,
        },
      };
    }

    // Bug 4.2 Fix: Wrap getStatus() in try/catch to handle RPC/network errors
    // Without this, an exception would cause the entire cross-chain execution to fail
    // without proper error handling or nonce cleanup
    let bridgeStatus: BridgeStatusResult;
    try {
      bridgeStatus = await bridgeRouter.getStatus(bridgeId);
    } catch (statusError) {
      // Log the error and continue polling - transient network errors shouldn't abort
      logger.warn('Bridge status check failed, will retry', {
        opportunityId,
        bridgeId,
        iterationCount,
        error: getErrorMessage(statusError),
      });
      // Wait before retry to avoid hammering the API
      await new Promise(resolve => setTimeout(resolve, Math.min(pollInterval, 5000)));
      continue;
    }

    // Fix 3.2: Check for shutdown AFTER async operation completes
    // The shutdown may have occurred during the getStatus() network call.
    // Without this check, we would continue processing a stale result
    // while the service is partially torn down.
    if (!ctx.stateManager.isRunning()) {
      logger.warn('Bridge polling interrupted by shutdown after status fetch', {
        opportunityId,
        bridgeId,
        lastStatus: bridgeStatus.status,
      });
      return {
        completed: false,
        error: {
          code: ExecutionErrorCode.SHUTDOWN,
          message: 'Polling interrupted by shutdown after status fetch',
          sourceTxHash,
        },
      };
    }

    // Log status transitions
    if (bridgeStatus.status !== lastSeenStatus) {
      logger.debug('Bridge status changed', {
        opportunityId,
        bridgeId,
        previousStatus: lastSeenStatus,
        newStatus: bridgeStatus.status,
        elapsedMs: Date.now() - bridgeStartTime,
      });
      lastSeenStatus = bridgeStatus.status;
    }

    if (bridgeStatus.status === 'completed') {
      logger.info('Bridge completed', {
        opportunityId,
        bridgeId,
        destTxHash: bridgeStatus.destTxHash,
        amountReceived: bridgeStatus.amountReceived,
      });
      return {
        completed: true,
        amountReceived: bridgeStatus.amountReceived,
        destTxHash: bridgeStatus.destTxHash,
      };
    }

    if (bridgeStatus.status === 'failed' || bridgeStatus.status === 'refunded') {
      return {
        completed: false,
        error: {
          code: ExecutionErrorCode.BRIDGE_FAILED,
          message: bridgeStatus.error || bridgeStatus.status,
          sourceTxHash,
        },
      };
    }

    // Race 5.3 Fix: Check time again AFTER status fetch
    const nowAfterFetch = Date.now();
    if (nowAfterFetch >= pollDeadline) {
      break;
    }

    // FIX 10.4: Use pre-computed backoff schedule (eliminates per-iteration calculations)
    const elapsedMs = nowAfterFetch - bridgeStartTime;
    let dynamicPollInterval = pollInterval; // Default fallback

    // Find matching schedule entry (pre-computed, no calculations needed)
    for (const { afterMs, intervalMs } of BRIDGE_POLL_BACKOFF_SCHEDULE) {
      if (elapsedMs >= afterMs) {
        dynamicPollInterval = intervalMs;
        break;
      }
    }

    // Don't wait longer than remaining time
    const remainingTime = pollDeadline - nowAfterFetch;
    const effectivePollInterval = Math.min(dynamicPollInterval, remainingTime);

    await new Promise(resolve => setTimeout(resolve, effectivePollInterval));
  }

  // Timeout
  const timedOutByTime = Date.now() - bridgeStartTime >= maxWaitTime;
  const timedOutByIterations = iterationCount >= maxIterations;

  logger.warn('Bridge timeout - funds may still be in transit', {
    opportunityId,
    bridgeId,
    elapsedMs: Date.now() - bridgeStartTime,
    iterationCount,
    maxIterations,
    timedOutByTime,
    timedOutByIterations,
    lastStatus: lastSeenStatus,
  });

  return {
    completed: false,
    error: {
      code: ExecutionErrorCode.BRIDGE_TIMEOUT,
      message: `timeout after ${iterationCount} polls - transaction may still complete`,
      sourceTxHash,
    },
  };
}
