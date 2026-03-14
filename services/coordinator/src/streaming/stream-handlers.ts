/**
 * Stream Message Handlers
 *
 * Extracted from coordinator.ts to reduce god-class complexity.
 * These are the "secondary" stream handlers that follow a common pattern:
 * unwrap data -> extract fields -> update metrics -> optional alert/log.
 *
 * "Primary" handlers (health, opportunity, execution-result) remain in
 * coordinator.ts because they're deeply coupled to coordinator state.
 *
 * @see coordinator.ts startStreamConsumers() for the handler wiring
 * @see ADR-002 for Redis Streams architecture
 */

import type { TraceContext } from '@arbitrage/core/tracing';
import type { LogContext } from '@arbitrage/core/logging';
import type { SystemMetrics } from '../api';
import {
  getString,
  getNonNegativeNumber,
  getOptionalString,
  unwrapMessageData,
} from '../utils';

// =============================================================================
// Dependencies Interface
// =============================================================================

/** Minimal logger interface for stream handlers. */
export interface StreamHandlerLogger {
  warn(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

/** Alert payload for sendAlert callback. */
export interface StreamAlert {
  type: string;
  message: string;
  severity: 'critical' | 'high' | 'low';
  service?: string;
  data?: Record<string, unknown>;
  timestamp: number;
}

/** Stream message (matches StreamConsumerManager's type). */
export interface StreamMessage {
  id: string;
  data: Record<string, unknown> | null;
}

/**
 * Dependencies injected by the coordinator into stream handlers.
 * Keeps handlers decoupled from CoordinatorService internals.
 */
export interface StreamHandlerDeps {
  logger: StreamHandlerLogger;
  systemMetrics: SystemMetrics;
  sendAlert: (alert: StreamAlert) => void;
  trackActivePair: (pairKey: string, chain: string, dex: string) => void;
}

// =============================================================================
// DLQ Error Classification (moved from coordinator.ts top-level)
// =============================================================================

/**
 * M-09 FIX: Classify DLQ error codes into categories using structured matching.
 * Extracted from handleDlqMessage to eliminate duplicate string-matching logic.
 *
 * Convention: [VAL_*] = permanent validation errors, [ERR_*] = transient/retryable.
 * Returns the category key that maps directly to dlqMetrics counters.
 */
export type DlqClassification = 'expired' | 'validation' | 'transient' | 'unknown';

export function classifyDlqError(errorCode: string): DlqClassification {
  if (errorCode.includes('EXPIRED') || errorCode.includes('TTL') || errorCode.includes('STALE')) {
    return 'expired';
  }
  if (errorCode.startsWith('[VAL_') || errorCode.includes('VALIDATION') || errorCode.includes('INVALID')) {
    return 'validation';
  }
  if (errorCode.startsWith('[ERR_') || errorCode.includes('TIMEOUT') || errorCode.includes('RETRY')) {
    return 'transient';
  }
  return 'unknown';
}

// =============================================================================
// Stream Handlers
// =============================================================================

/**
 * Handle whale alert messages from stream:whale-alerts.
 * Logs whale transaction details and sends alert notification.
 */
export async function handleWhaleAlertMessage(
  message: StreamMessage,
  deps: StreamHandlerDeps,
): Promise<void> {
  const data = message.data as Record<string, unknown>;
  if (!data) return;

  deps.systemMetrics.whaleAlerts++;

  const rawAlert = unwrapMessageData(data);
  const usdValue = getNonNegativeNumber(rawAlert, 'usdValue', 0);
  const direction = getString(rawAlert, 'direction', 'unknown');
  const chain = getString(rawAlert, 'chain', 'unknown');
  const address = getOptionalString(rawAlert, 'address');
  const dex = getOptionalString(rawAlert, 'dex');
  const impact = getOptionalString(rawAlert, 'impact');

  deps.logger.warn('Whale alert received', {
    address,
    usdValue,
    direction,
    chain,
    dex,
    impact
  });

  deps.sendAlert({
    type: 'WHALE_TRANSACTION',
    message: `Whale ${direction} detected: $${usdValue.toLocaleString()} on ${chain}`,
    severity: usdValue > 100000 ? 'critical' : 'high',
    data: rawAlert,
    timestamp: Date.now()
  });

  // P2-5: Do not reset stream errors from whale alerts.
  // Only the opportunity handler (primary data path) should reset errors.
}

/**
 * Handle swap event messages from stream:swap-events.
 * Tracks swap activity for analytics and market monitoring.
 *
 * Note: Raw swap events are filtered by SwapEventFilter in detectors before publishing.
 * Only significant swaps (>$10 USD, deduplicated) reach this handler.
 */
export async function handleSwapEventMessage(
  message: StreamMessage,
  deps: StreamHandlerDeps,
): Promise<void> {
  const data = message.data as Record<string, unknown>;
  if (!data) return;

  const rawEvent = unwrapMessageData(data);
  const pairAddress = getString(rawEvent, 'pairAddress', '');
  const chain = getString(rawEvent, 'chain', 'unknown');
  const dex = getString(rawEvent, 'dex', 'unknown');
  const usdValue = getNonNegativeNumber(rawEvent, 'usdValue', 0);

  if (!pairAddress) {
    deps.logger.debug('Skipping swap event - missing pairAddress', { messageId: message.id });
    return;
  }

  // Update metrics
  deps.systemMetrics.totalSwapEvents++;
  // P2 FIX #15: Guard against precision loss at Number.MAX_SAFE_INTEGER.
  if (deps.systemMetrics.totalVolumeUsd < Number.MAX_SAFE_INTEGER - usdValue) {
    deps.systemMetrics.totalVolumeUsd += usdValue;
  }

  // P3-005 FIX: Track active pairs with size limit enforcement
  deps.trackActivePair(pairAddress, chain, dex);

  // Log significant swaps (whales are handled separately, this is for analytics)
  if (usdValue >= 10000) {
    deps.logger.debug('Large swap event received', {
      pairAddress,
      chain,
      dex,
      usdValue,
      txHash: rawEvent.transactionHash
    });
  }

  // P2-5: Do not reset stream errors from swap events.
  // Only the opportunity handler (primary data path) should reset errors.
}

/**
 * Handle volume aggregate messages from stream:volume-aggregates.
 * Processes 5-second aggregated volume data per pair for market monitoring.
 */
export async function handleVolumeAggregateMessage(
  message: StreamMessage,
  deps: StreamHandlerDeps,
): Promise<void> {
  const data = message.data as Record<string, unknown>;
  if (!data) return;

  const rawAggregate = unwrapMessageData(data);
  const pairAddress = getString(rawAggregate, 'pairAddress', '');
  const chain = getString(rawAggregate, 'chain', 'unknown');
  const dex = getString(rawAggregate, 'dex', 'unknown');
  const swapCount = getNonNegativeNumber(rawAggregate, 'swapCount', 0);
  const totalUsdVolume = getNonNegativeNumber(rawAggregate, 'totalUsdVolume', 0);

  if (!pairAddress) {
    deps.logger.debug('Skipping volume aggregate - missing pairAddress', { messageId: message.id });
    return;
  }

  // Update metrics - always track aggregates, even if swapCount is 0
  deps.systemMetrics.volumeAggregatesProcessed++;

  // P3-005 FIX: Track active pairs with size limit enforcement
  deps.trackActivePair(pairAddress, chain, dex);

  // Skip detailed logging for empty windows (no swaps in this 5s period)
  if (swapCount === 0) {
    return;
  }

  // Log high-volume periods (potential trading opportunities)
  if (totalUsdVolume >= 50000) {
    deps.logger.info('High volume aggregate detected', {
      pairAddress,
      chain,
      dex,
      swapCount,
      totalUsdVolume,
      avgPrice: rawAggregate.avgPrice
    });
  }

  // P2-5: Do not reset stream errors from volume aggregates.
  // Only the opportunity handler (primary data path) should reset errors.
}

/**
 * Handle single price update messages from stream:price-updates.
 * Also used as the core logic for handlePriceUpdateBatch.
 */
export async function handlePriceUpdateMessage(
  message: StreamMessage,
  deps: StreamHandlerDeps,
  unwrapBatch: (data: Record<string, unknown>) => Record<string, unknown>[],
): Promise<void> {
  const data = message.data as Record<string, unknown>;
  if (!data) return;

  // Unwrap batch envelopes from StreamBatcher (ADR-002 batching)
  const items = unwrapBatch(data);

  let validCount = 0;
  for (const item of items) {
    const rawUpdate = unwrapMessageData(item);
    const chain = getString(rawUpdate, 'chain', 'unknown');
    const dex = getString(rawUpdate, 'dex', 'unknown');
    const pairKey = getString(rawUpdate, 'pairKey', '');

    if (!pairKey) {
      deps.logger.debug('Skipping price update - missing pairKey', { messageId: message.id });
      continue;
    }

    validCount++;
    deps.systemMetrics.priceUpdatesReceived++;
    deps.trackActivePair(pairKey, chain, dex);
  }

  if (validCount === 0 && items.length > 0) {
    deps.logger.debug('All items in batch filtered out (missing pairKey)', {
      messageId: message.id,
      batchSize: items.length,
    });
  }

  // P2-5: Do not reset stream errors from price updates.
  // Only the opportunity handler (primary data path) should reset errors.
}

/**
 * Process price update items from a batch message (shared by single + batch handlers).
 * Returns the number of valid items processed.
 */
export function processPriceUpdateItems(
  items: Record<string, unknown>[],
  deps: StreamHandlerDeps,
): number {
  let validCount = 0;
  for (const item of items) {
    const rawUpdate = unwrapMessageData(item);
    const chain = getString(rawUpdate, 'chain', 'unknown');
    const dex = getString(rawUpdate, 'dex', 'unknown');
    const pairKey = getString(rawUpdate, 'pairKey', '');

    if (!pairKey) continue;

    validCount++;
    deps.systemMetrics.priceUpdatesReceived++;
    deps.trackActivePair(pairKey, chain, dex);
  }
  return validCount;
}

/**
 * C-02 FIX: Handle service degradation/recovery events from graceful-degradation-manager.
 * Previously this stream had producers but zero consumer groups — events were lost.
 */
export async function handleServiceDegradationMessage(
  message: StreamMessage,
  deps: StreamHandlerDeps,
): Promise<void> {
  const data = message.data as Record<string, unknown>;
  if (!data) return;

  const rawData = unwrapMessageData(data);
  const service = getString(rawData, 'service', 'unknown');
  const event = getString(rawData, 'event', 'unknown');
  const reason = getString(rawData, 'reason', '');

  if (event === 'degraded') {
    deps.logger.warn('Service degradation reported', { service, reason, messageId: message.id });
    deps.sendAlert({
      type: 'SERVICE_DEGRADED',
      message: `Service ${service} entered degraded state: ${reason}`,
      severity: 'high',
      service,
      data: rawData,
      timestamp: Date.now(),
    });
  } else if (event === 'recovered') {
    deps.logger.info('Service recovery reported', { service, messageId: message.id });
    deps.sendAlert({
      type: 'SERVICE_RECOVERED',
      message: `Service ${service} recovered from degraded state`,
      severity: 'low',
      service,
      data: rawData,
      timestamp: Date.now(),
    });
  } else {
    deps.logger.debug('Service degradation event', { service, event, messageId: message.id });
  }
}

/**
 * RT-007 FIX: Handle dead-letter queue messages.
 * Classifies errors by type (expired, validation, transient) and maintains
 * counters exposed via systemMetrics for monitoring dashboards.
 *
 * M-09 FIX: Classification extracted to classifyDlqError() to avoid
 * duplicate string-matching logic.
 */
export async function handleDlqMessage(
  message: StreamMessage,
  deps: StreamHandlerDeps,
  traceUtils: {
    extractContext: (data: Record<string, unknown>) => TraceContext | null;
    createChildContext: (parent: TraceContext, service: string) => TraceContext;
    createTraceContext: (service: string) => TraceContext;
    withLogContext: <T>(ctx: LogContext, fn: () => T) => T;
  },
): Promise<void> {
  const data = message.data as Record<string, unknown>;
  if (!data) return;

  const rawData = unwrapMessageData(data);

  // H-03 FIX: Extract trace context from DLQ entries for correlation.
  const parentTrace = traceUtils.extractContext(rawData);
  const trace = parentTrace
    ? traceUtils.createChildContext(parentTrace, 'coordinator')
    : traceUtils.createTraceContext('coordinator');

  await traceUtils.withLogContext({ traceId: trace.traceId, spanId: trace.spanId }, async () => {
    const originalStream = getString(rawData, '_dlq_originalStream', 'unknown');
    const errorCode = getString(rawData, '_dlq_errorCode', 'unknown');
    const opportunityId = getString(rawData, 'id', '') || getString(rawData, 'opportunityId', '');

    const classification = classifyDlqError(errorCode);
    const dlq = deps.systemMetrics.dlqMetrics!;
    dlq.total++;
    dlq[classification]++;

    deps.logger.warn('DLQ entry classified', {
      messageId: message.id,
      originalStream,
      errorCode,
      opportunityId,
      type: getString(rawData, 'type', 'unknown'),
      chain: getString(rawData, 'chain', 'unknown'),
      classification,
      dlqTotals: { ...dlq },
    });
  });
}
