/**
 * Partition Metrics Counters
 *
 * Module-level Prometheus counters for partition services.
 * Extracted from handlers.ts to break circular dependency with health-server.ts.
 *
 * @see ADR-003: Partitioned Chain Detectors
 * @module partition/metrics
 */

// =============================================================================
// Prometheus Counters (RT-007: partition metric schema compliance)
// =============================================================================

/**
 * Cumulative count of price update events received on the hot path.
 * Exposed via /metrics as `price_updates_total`.
 * Module-level (not per-handler) so it survives handler reinstantiation.
 */
let _priceUpdatesTotal = 0;

/** Returns the cumulative price_updates_total counter value. */
export function getPriceUpdatesTotal(): number {
  return _priceUpdatesTotal;
}

/** Increment the price updates counter. */
export function incrementPriceUpdates(): void {
  _priceUpdatesTotal++;
}

/**
 * M-01 FIX: Cumulative count of opportunity publish drops due to concurrency limit.
 * Exposed via /metrics as `opportunity_publish_drops_total`.
 * Module-level (not per-handler) so it survives handler reinstantiation.
 */
let _publishDropsTotal = 0;

/** Increment the publish drop counter. */
export function incrementPublishDrops(): void {
  _publishDropsTotal++;
}

/** Returns the cumulative publish drop counter value. */
export function getPublishDropsTotal(): number {
  return _publishDropsTotal;
}
