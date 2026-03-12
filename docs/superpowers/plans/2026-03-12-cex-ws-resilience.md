# CEX WebSocket Connection Resilience Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add formal health tracking, observability, and adaptive scoring compensation for CEX WebSocket connection failures so operators have visibility into degradation and the system compensates for lost CEX validation signal.

**Architecture:** Extend `CexPriceFeedService` with a state machine (`CONNECTED` / `RECONNECTING` / `DEGRADED` / `DISCONNECTED`) that integrates with the coordinator's health endpoint, alert system, SSE dashboard events, and opportunity scoring. When CEX feed enters `DEGRADED` state (reconnects exhausted), the opportunity router applies a configurable profit multiplier to compensate for lost CEX-DEX validation signal. All changes are on the cold path except one boolean read per opportunity batch.

**Tech Stack:** TypeScript, EventEmitter, existing health/alert/SSE patterns, Jest

**Key references:**
- `shared/core/src/feeds/cex-price-feed-service.ts` — Orchestrator singleton (299 lines)
- `shared/core/src/feeds/binance-ws-client.ts` — WS client with reconnect (444 lines)
- `services/coordinator/src/coordinator.ts` — CEX startup at line 744, shutdown at line 1031
- `services/coordinator/src/opportunities/opportunity-router.ts` — CEX scoring at line 891
- `services/coordinator/src/opportunities/opportunity-scoring.ts` — Score computation (99 lines)
- `services/coordinator/src/opportunities/cex-alignment.ts` — Alignment factor (93 lines)
- `shared/core/src/analytics/cex-dex-spread.ts` — Spread calculator, `maxCexPriceAgeMs` at line 298
- `shared/core/src/monitoring/diagnostics-collector.ts` — Diagnostics for SSE
- `dashboard/src/tabs/DiagnosticsTab.tsx` — CexSpreadSection at line 276
- ADR-036 (CEX Price Signals), ADR-018 (Circuit Breaker), ADR-007 (Failover)

**Current behavior (correct but invisible):**
- When Binance WS disconnects, `maxCexPriceAgeMs=10s` causes all spreads to return `undefined`
- `computeCexAlignment()` returns `1.0` (neutral) when spread is undefined
- Scoring proceeds without any CEX boost/penalize — effectively "CEX off"
- **Problem:** No health signal, no alert, no metrics, no operator visibility, no compensation

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `shared/core/src/feeds/cex-feed-health.ts` | CREATE | Health state machine enum + types |
| `shared/core/src/feeds/cex-price-feed-service.ts` | MODIFY | Integrate health state tracking |
| `shared/core/src/feeds/binance-ws-client.ts` | MODIFY | Add configurable env var overrides |
| `shared/core/src/feeds/index.ts` | MODIFY | Re-export new types |
| `services/coordinator/src/coordinator.ts` | MODIFY | Wire health status + alert on degradation |
| `services/coordinator/src/opportunities/opportunity-router.ts` | MODIFY | Apply degraded-mode profit multiplier |
| `dashboard/src/tabs/DiagnosticsTab.tsx` | MODIFY | Show degradation duration + guidance |
| `dashboard/src/lib/types.ts` | MODIFY | Add health status to CexSpreadData |
| `shared/core/__tests__/unit/feeds/cex-feed-health.test.ts` | CREATE | Health state machine tests |
| `shared/core/__tests__/unit/feeds/cex-price-feed-service.test.ts` | MODIFY | Health integration tests |
| `services/coordinator/__tests__/unit/opportunities/opportunity-router.test.ts` | MODIFY | Degraded-mode multiplier tests |

---

## Task 1: CEX Feed Health State Machine

**Files:**
- Create: `shared/core/src/feeds/cex-feed-health.ts`
- Create: `shared/core/__tests__/unit/feeds/cex-feed-health.test.ts`
- Modify: `shared/core/src/feeds/index.ts`

This task creates a small, pure state machine with no external dependencies. All logic is synchronous — easy to test and reason about.

- [ ] **Step 1: Write the health state tests**

```typescript
// shared/core/__tests__/unit/feeds/cex-feed-health.test.ts
import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  CexFeedHealthStatus,
  CexFeedHealthTracker,
} from '../../../src/feeds/cex-feed-health';

describe('CexFeedHealthTracker', () => {
  let tracker: CexFeedHealthTracker;

  beforeEach(() => {
    tracker = new CexFeedHealthTracker();
  });

  it('should start in DISCONNECTED state', () => {
    expect(tracker.getStatus()).toBe(CexFeedHealthStatus.DISCONNECTED);
  });

  it('should transition to CONNECTED on connect', () => {
    tracker.onConnected();
    expect(tracker.getStatus()).toBe(CexFeedHealthStatus.CONNECTED);
    expect(tracker.getDisconnectedSince()).toBeNull();
  });

  it('should transition to RECONNECTING on disconnect', () => {
    tracker.onConnected();
    tracker.onDisconnected();
    expect(tracker.getStatus()).toBe(CexFeedHealthStatus.RECONNECTING);
  });

  it('should transition to DEGRADED on maxReconnectFailed', () => {
    tracker.onConnected();
    tracker.onDisconnected();
    tracker.onMaxReconnectFailed();
    expect(tracker.getStatus()).toBe(CexFeedHealthStatus.DEGRADED);
    expect(tracker.getDisconnectedSince()).not.toBeNull();
  });

  it('should transition from DEGRADED back to CONNECTED on reconnect', () => {
    tracker.onConnected();
    tracker.onDisconnected();
    tracker.onMaxReconnectFailed();
    tracker.onConnected();
    expect(tracker.getStatus()).toBe(CexFeedHealthStatus.CONNECTED);
    expect(tracker.getDisconnectedSince()).toBeNull();
  });

  it('should track degradation duration', () => {
    const now = Date.now();
    tracker.onConnected();
    tracker.onDisconnected();
    tracker.onMaxReconnectFailed();
    const since = tracker.getDisconnectedSince();
    expect(since).not.toBeNull();
    expect(since!).toBeGreaterThanOrEqual(now - 10);
    expect(since!).toBeLessThanOrEqual(now + 100);
  });

  it('should report isDegraded correctly', () => {
    expect(tracker.isDegraded()).toBe(false);
    tracker.onConnected();
    expect(tracker.isDegraded()).toBe(false);
    tracker.onDisconnected();
    expect(tracker.isDegraded()).toBe(false); // RECONNECTING, not yet degraded
    tracker.onMaxReconnectFailed();
    expect(tracker.isDegraded()).toBe(true);
  });

  it('should return snapshot via getSnapshot', () => {
    tracker.onConnected();
    const snap = tracker.getSnapshot();
    expect(snap.status).toBe(CexFeedHealthStatus.CONNECTED);
    expect(snap.disconnectedSince).toBeNull();
    expect(snap.isDegraded).toBe(false);
  });

  it('should remain DISCONNECTED if onDisconnected called without prior connect', () => {
    tracker.onDisconnected();
    expect(tracker.getStatus()).toBe(CexFeedHealthStatus.DISCONNECTED);
  });

  it('should set status to DISCONNECTED for passive/simulation mode', () => {
    tracker.setPassiveMode();
    expect(tracker.getStatus()).toBe(CexFeedHealthStatus.PASSIVE);
    expect(tracker.isDegraded()).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd shared/core && npx jest __tests__/unit/feeds/cex-feed-health.test.ts --no-coverage`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the health state machine**

```typescript
// shared/core/src/feeds/cex-feed-health.ts
/**
 * CEX Feed Health State Machine
 *
 * Tracks the health status of the CEX price feed connection.
 * Pure synchronous state machine — no timers, no I/O.
 *
 * State transitions:
 *   DISCONNECTED → CONNECTED (onConnected)
 *   CONNECTED → RECONNECTING (onDisconnected)
 *   RECONNECTING → CONNECTED (onConnected)
 *   RECONNECTING → DEGRADED (onMaxReconnectFailed)
 *   DEGRADED → CONNECTED (onConnected — last-resort reconnect succeeded)
 *   any → PASSIVE (setPassiveMode — simulation/skipExternalConnection)
 *
 * @see ADR-036: CEX Price Signals
 * @module feeds
 */

export enum CexFeedHealthStatus {
  /** Not yet connected (initial state) */
  DISCONNECTED = 'disconnected',
  /** Actively connected to Binance WS */
  CONNECTED = 'connected',
  /** Disconnected, reconnection attempts in progress */
  RECONNECTING = 'reconnecting',
  /** All reconnect attempts exhausted; last-resort timer active */
  DEGRADED = 'degraded',
  /** Simulation/passive mode — no external connection expected */
  PASSIVE = 'passive',
}

export interface CexFeedHealthSnapshot {
  status: CexFeedHealthStatus;
  disconnectedSince: number | null;
  isDegraded: boolean;
}

export class CexFeedHealthTracker {
  private status: CexFeedHealthStatus = CexFeedHealthStatus.DISCONNECTED;
  private _disconnectedSince: number | null = null;

  onConnected(): void {
    this.status = CexFeedHealthStatus.CONNECTED;
    this._disconnectedSince = null;
  }

  onDisconnected(): void {
    if (this.status === CexFeedHealthStatus.CONNECTED) {
      this.status = CexFeedHealthStatus.RECONNECTING;
    }
    // If already DISCONNECTED or DEGRADED, stay in current state
  }

  onMaxReconnectFailed(): void {
    this.status = CexFeedHealthStatus.DEGRADED;
    this._disconnectedSince = this._disconnectedSince ?? Date.now();
  }

  setPassiveMode(): void {
    this.status = CexFeedHealthStatus.PASSIVE;
    this._disconnectedSince = null;
  }

  getStatus(): CexFeedHealthStatus {
    return this.status;
  }

  getDisconnectedSince(): number | null {
    return this._disconnectedSince;
  }

  isDegraded(): boolean {
    return this.status === CexFeedHealthStatus.DEGRADED;
  }

  getSnapshot(): CexFeedHealthSnapshot {
    return {
      status: this.status,
      disconnectedSince: this._disconnectedSince,
      isDegraded: this.isDegraded(),
    };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd shared/core && npx jest __tests__/unit/feeds/cex-feed-health.test.ts --no-coverage`
Expected: PASS — all 10 tests

- [ ] **Step 5: Export from barrel**

In `shared/core/src/feeds/index.ts`, add:
```typescript
export { CexFeedHealthStatus, CexFeedHealthTracker } from './cex-feed-health';
export type { CexFeedHealthSnapshot } from './cex-feed-health';
```

- [ ] **Step 6: Commit**

```bash
git add shared/core/src/feeds/cex-feed-health.ts \
  shared/core/__tests__/unit/feeds/cex-feed-health.test.ts \
  shared/core/src/feeds/index.ts
git commit -m "feat(feeds): add CexFeedHealthTracker state machine (CEX resilience 1/5)"
```

---

## Task 2: Wire Health Tracker into CexPriceFeedService

**Files:**
- Modify: `shared/core/src/feeds/cex-price-feed-service.ts`
- Modify: `shared/core/__tests__/unit/feeds/cex-price-feed-service.test.ts`

This task integrates the state machine from Task 1 into the existing service singleton. The tracker state drives the `getStats()` output and the new `getHealthSnapshot()` method.

- [ ] **Step 1: Write the health integration tests**

Add these tests to the existing `cex-price-feed-service.test.ts`:

```typescript
// Add to imports at top:
import { CexFeedHealthStatus } from '../../../src/feeds/cex-feed-health';

// Helper to get the most recently created mock WS instance (survives resetAllMocks)
function getLatestMockWsInstance(): ReturnType<typeof MockBinanceWsClient> {
  const results = (MockBinanceWsClient as jest.Mock).mock.results;
  return results[results.length - 1].value;
}

// Add new describe block after existing 'configuration' block:
describe('health tracking', () => {
  it('should report PASSIVE status when skipExternalConnection is true', async () => {
    await service.start();
    const snap = service.getHealthSnapshot();
    expect(snap.status).toBe(CexFeedHealthStatus.PASSIVE);
    expect(snap.isDegraded).toBe(false);
  });

  it('should include health status in getStats()', async () => {
    await service.start();
    const stats = service.getStats();
    expect(stats.healthStatus).toBe(CexFeedHealthStatus.PASSIVE);
  });

  it('should report CONNECTED when live WS connects', async () => {
    const liveService = new CexPriceFeedService();
    mockConnect.mockResolvedValueOnce(undefined);
    mockIsConnected.mockReturnValue(true);
    await liveService.start();

    // Simulate the 'connected' event from wsClient
    const wsInstance = getLatestMockWsInstance();
    wsInstance.emit('connected');

    const snap = liveService.getHealthSnapshot();
    expect(snap.status).toBe(CexFeedHealthStatus.CONNECTED);
    await liveService.stop();
  });

  it('should report RECONNECTING after WS disconnects', async () => {
    const liveService = new CexPriceFeedService();
    mockConnect.mockResolvedValueOnce(undefined);
    await liveService.start();

    const wsInstance = getLatestMockWsInstance();
    wsInstance.emit('connected');
    wsInstance.emit('disconnected');

    const snap = liveService.getHealthSnapshot();
    expect(snap.status).toBe(CexFeedHealthStatus.RECONNECTING);
    await liveService.stop();
  });

  it('should report DEGRADED after maxReconnectFailed', async () => {
    const liveService = new CexPriceFeedService();
    mockConnect.mockResolvedValueOnce(undefined);
    await liveService.start();

    const wsInstance = getLatestMockWsInstance();
    wsInstance.emit('connected');
    wsInstance.emit('disconnected');
    wsInstance.emit('maxReconnectFailed', 10);

    const snap = liveService.getHealthSnapshot();
    expect(snap.status).toBe(CexFeedHealthStatus.DEGRADED);
    expect(snap.isDegraded).toBe(true);
    expect(snap.disconnectedSince).not.toBeNull();
    await liveService.stop();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd shared/core && npx jest __tests__/unit/feeds/cex-price-feed-service.test.ts --no-coverage`
Expected: FAIL — `getHealthSnapshot` not a function, `healthStatus` not in stats

- [ ] **Step 3: Integrate CexFeedHealthTracker into CexPriceFeedService**

In `shared/core/src/feeds/cex-price-feed-service.ts`:

Add import at top (after existing imports):
```typescript
import { CexFeedHealthTracker, CexFeedHealthStatus } from './cex-feed-health';
import type { CexFeedHealthSnapshot } from './cex-feed-health';
```

Add `healthStatus` field to `CexFeedStats` interface:
```typescript
  /** Health status of the CEX feed connection */
  healthStatus: CexFeedHealthStatus;
```

Add tracker as class field:
```typescript
  private healthTracker = new CexFeedHealthTracker();
```

In `start()`, after the `if (this.config.skipExternalConnection)` early return block (line 146-149), add `setPassiveMode` before the return:
```typescript
    if (this.config.skipExternalConnection) {
      this.healthTracker.setPassiveMode();
      logger.info('CexPriceFeedService started in passive mode (no external connection)');
      return;
    }
```

Wire tracker into the existing WS event listeners (lines 172-186). Modify the `connected`, `disconnected`, and `maxReconnectFailed` handlers to call the health tracker. **Note:** The existing `reconnecting` handler (line 180-183) is dead code — `BinanceWebSocketClient` does not emit a `'reconnecting'` event. Leave it as-is for now; the `_wsReconnections` counter is tracked but always 0. A follow-up task could add `this.emit('reconnecting')` to `binance-ws-client.ts:scheduleReconnect()`.

```typescript
    this.wsClient.on('connected', () => {
      this.healthTracker.onConnected();
      logger.info('Binance WS connected');
      this.emit('connected');
    });
    this.wsClient.on('disconnected', () => {
      this.healthTracker.onDisconnected();
      logger.warn('Binance WS disconnected');
      this.emit('disconnected');
    });
    // NOTE: 'reconnecting' is not emitted by BinanceWebSocketClient — this handler
    // exists but never fires. Kept for forward-compat if emit is added later.
    this.wsClient.on('reconnecting', () => {
      this._wsReconnections++;
      logger.info('Binance WS reconnecting', { reconnections: this._wsReconnections });
    });
    this.wsClient.on('maxReconnectFailed', (attempts: number) => {
      this.healthTracker.onMaxReconnectFailed();
      logger.error('Binance WS exhausted all reconnect attempts, running degraded', { attempts });
      this.emit('maxReconnectFailed', attempts);
    });
```

**Important:** The `maxReconnectFailed` handler now re-emits the event on the `CexPriceFeedService` itself (via `this.emit('maxReconnectFailed', attempts)`). This is required for Task 3 where the coordinator listens for `cexFeed.on('maxReconnectFailed', ...)`.


Add `healthStatus` to `getStats()` return:
```typescript
      healthStatus: this.healthTracker.getStatus(),
```

Add new public method:
```typescript
  /** Get health snapshot for monitoring integration. */
  getHealthSnapshot(): CexFeedHealthSnapshot {
    return this.healthTracker.getSnapshot();
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd shared/core && npx jest __tests__/unit/feeds/cex-price-feed-service.test.ts --no-coverage`
Expected: PASS — all existing tests + 5 new health tracking tests (0 failures)

- [ ] **Step 5: Re-export new types from barrel**

In `shared/core/src/feeds/index.ts`, ensure `CexFeedHealthSnapshot` is already exported (from Task 1). Also add to the `CexPriceFeedService` re-export line if `CexFeedHealthSnapshot` is needed externally — it already is from Task 1.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add shared/core/src/feeds/cex-price-feed-service.ts \
  shared/core/__tests__/unit/feeds/cex-price-feed-service.test.ts
git commit -m "feat(feeds): wire CexFeedHealthTracker into CexPriceFeedService (CEX resilience 2/5)"
```

---

## Task 3: Coordinator Health & Alert Integration

**Files:**
- Modify: `services/coordinator/src/coordinator.ts` (lines ~744-758, ~854)

This task wires the CEX feed health status into the coordinator's alert system. When the feed enters DEGRADED state, the coordinator emits an alert via its existing `sendAlert()` pipeline (Discord/Slack via AlertNotifier + cooldown). When it recovers, a recovery alert is sent.

- [ ] **Step 1: Add health event listeners to coordinator CEX startup**

In `services/coordinator/src/coordinator.ts`, after `await cexFeed.start()` (line 753), add:

```typescript
        // CEX resilience: alert on degradation and recovery.
        // Alert types use SCREAMING_SNAKE_CASE to match existing convention
        // (EXECUTION_CIRCUIT_OPEN, EXECUTION_FORWARD_FAILED, PIPELINE_STARVATION, etc.)
        let wasDegraded = false;
        cexFeed.on('maxReconnectFailed', () => {
          wasDegraded = true;
          this.sendAlert({
            type: 'CEX_FEED_DEGRADED',
            message: 'CEX price feed (Binance WS) exhausted all reconnect attempts. ' +
              'Opportunity scoring running without CEX validation — alignment factor is neutral (1.0). ' +
              'Adaptive profit threshold active if CEX_DEGRADED_PROFIT_MULTIPLIER is set.',
            severity: 'high',
            data: { healthSnapshot: cexFeed.getHealthSnapshot() },
            timestamp: Date.now(),
          });
        });

        // Recovery alert — fires when WS reconnects after degradation.
        // The wasDegraded flag is set in maxReconnectFailed (not disconnected),
        // because isDegraded() is only true AFTER maxReconnectFailed fires.
        cexFeed.on('connected', () => {
          if (wasDegraded) {
            wasDegraded = false;
            this.sendAlert({
              type: 'CEX_FEED_RECOVERED',
              message: 'CEX price feed (Binance WS) reconnected after degradation. ' +
                'Opportunity scoring restored to full CEX-DEX validation.',
              severity: 'low',
              data: { healthSnapshot: cexFeed.getHealthSnapshot() },
              timestamp: Date.now(),
            });
          }
        });
```

Also update the startup log to include health status:
```typescript
        this.logger.info('CEX price feed started', {
          mode: isSimMode ? 'simulation (synthetic CEX prices)' : 'live (Binance WS)',
          connected: cexFeed.isConnected(),
          healthStatus: cexFeed.getHealthSnapshot().status,
        });
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: No errors (getHealthSnapshot() was added in Task 2)

- [ ] **Step 3: Commit**

```bash
git add services/coordinator/src/coordinator.ts
git commit -m "feat(coordinator): alert on CEX feed degradation and recovery (CEX resilience 3/5)"
```

---

## Task 4: Adaptive Profit Threshold in Opportunity Router

**Files:**
- Modify: `services/coordinator/src/opportunities/opportunity-router.ts` (lines ~891-924)
- Modify (or create): `services/coordinator/__tests__/unit/opportunities/cex-alignment.test.ts`

When the CEX feed is degraded, the lost validation signal means the system can no longer penalize opportunities that contradict CEX-DEX spread. To compensate, we apply a configurable multiplier to the minimum profit threshold — effectively raising the bar for admission when we can't cross-validate against CEX prices.

- [ ] **Step 1: Write the adaptive threshold tests**

Add to `services/coordinator/__tests__/unit/opportunities/cex-alignment.test.ts`:

```typescript
import { getCexDegradedProfitMultiplier } from '../../../src/opportunities/cex-alignment';

describe('getCexDegradedProfitMultiplier', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return 1.0 when CEX feed is not degraded', () => {
    expect(getCexDegradedProfitMultiplier(false)).toBe(1.0);
  });

  it('should return default 1.2 when CEX feed is degraded and no env override', () => {
    delete process.env.CEX_DEGRADED_PROFIT_MULTIPLIER;
    expect(getCexDegradedProfitMultiplier(true)).toBe(1.2);
  });

  it('should respect CEX_DEGRADED_PROFIT_MULTIPLIER env var', () => {
    process.env.CEX_DEGRADED_PROFIT_MULTIPLIER = '1.5';
    expect(getCexDegradedProfitMultiplier(true)).toBe(1.5);
  });

  it('should clamp to 1.0 minimum', () => {
    process.env.CEX_DEGRADED_PROFIT_MULTIPLIER = '0.5';
    expect(getCexDegradedProfitMultiplier(true)).toBe(1.0);
  });

  it('should clamp to 3.0 maximum', () => {
    process.env.CEX_DEGRADED_PROFIT_MULTIPLIER = '10';
    expect(getCexDegradedProfitMultiplier(true)).toBe(3.0);
  });

  it('should ignore invalid env var and use default', () => {
    process.env.CEX_DEGRADED_PROFIT_MULTIPLIER = 'not_a_number';
    expect(getCexDegradedProfitMultiplier(true)).toBe(1.2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/coordinator && npx jest __tests__/unit/opportunities/cex-alignment.test.ts --no-coverage`
Expected: FAIL — `getCexDegradedProfitMultiplier` not exported

- [ ] **Step 3: Implement getCexDegradedProfitMultiplier**

Add to `services/coordinator/src/opportunities/cex-alignment.ts`, after the existing `computeCexAlignment` function:

```typescript
// =============================================================================
// Degraded Mode Adaptive Threshold
// =============================================================================

const DEFAULT_DEGRADED_MULTIPLIER = 1.2;
const MIN_DEGRADED_MULTIPLIER = 1.0;
const MAX_DEGRADED_MULTIPLIER = 3.0;

/**
 * Get the profit threshold multiplier for CEX-degraded mode.
 *
 * When CEX feed is degraded, the system loses its ability to penalize
 * opportunities that contradict the CEX-DEX spread (the 0.8x factor from
 * computeCexAlignment is no longer applied). To compensate, we raise the
 * minimum profit threshold by this multiplier.
 *
 * @param isDegraded - Whether the CEX feed is in DEGRADED state
 * @returns Multiplier to apply to minProfitPercentage (1.0 = no change)
 */
export function getCexDegradedProfitMultiplier(isDegraded: boolean): number {
  if (!isDegraded) return 1.0;

  const envVal = process.env.CEX_DEGRADED_PROFIT_MULTIPLIER;
  if (envVal === undefined) return DEFAULT_DEGRADED_MULTIPLIER;

  const parsed = parseFloat(envVal);
  if (isNaN(parsed)) return DEFAULT_DEGRADED_MULTIPLIER;

  return Math.max(MIN_DEGRADED_MULTIPLIER, Math.min(MAX_DEGRADED_MULTIPLIER, parsed));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/coordinator && npx jest __tests__/unit/opportunities/cex-alignment.test.ts --no-coverage`
Expected: PASS — all tests including new ones

- [ ] **Step 5: Wire multiplier into opportunity-router**

In `services/coordinator/src/opportunities/opportunity-router.ts`:

Add import (alongside existing `computeCexAlignment` import):
```typescript
import { computeCexAlignment, getCexDegradedProfitMultiplier } from './cex-alignment';
```

Add a private instance field (after other private fields):
```typescript
  /** CEX-degraded-mode effective min profit (recalculated per batch in processOpportunityBatch) */
  private effectiveMinProfitPercentage: number;
```

Initialize in constructor (after `this.config = { ...DEFAULT_CONFIG, ...config }` resolution):
```typescript
    this.effectiveMinProfitPercentage = this.config.minProfitPercentage;
```

**Critical: Update effective threshold BEFORE the single-message fast path.** In `processOpportunityBatch` (line 775), add the multiplier update at the top of the method, before the `batch.length === 1` fast path (line 784). This ensures both single-message and multi-message paths use the degraded threshold:

```typescript
  async processOpportunityBatch(
    batch: Array<{ streamMessageId: string; data: Record<string, unknown>; traceContext?: TraceContext }>,
    isLeader: boolean,
  ): Promise<string[]> {
    if (batch.length === 0) return [];

    // CEX resilience: recalculate effective min profit at batch entry.
    // Must happen BEFORE the single-message fast path (line 784) so both
    // single-message and multi-message paths use the degraded threshold.
    const cexEnabled = FEATURE_FLAGS.useCexPriceSignals;
    const cexFeedForHealth = cexEnabled ? getCexPriceFeedService() : null;
    const cexDegraded = cexFeedForHealth?.getHealthSnapshot().isDegraded ?? false;
    this.effectiveMinProfitPercentage = this.config.minProfitPercentage * getCexDegradedProfitMultiplier(cexDegraded);

    // If batch is just 1 message, skip grouping/scoring overhead...
```

Then change the profit validation (line 530) from:
```typescript
      if (profitPercentage < this.config.minProfitPercentage || profitPercentage > this.config.maxProfitPercentage) {
```
to:
```typescript
      if (profitPercentage < this.effectiveMinProfitPercentage || profitPercentage > this.config.maxProfitPercentage) {
```

And update the log reason (line 535):
```typescript
          reason: profitPercentage < this.effectiveMinProfitPercentage ? 'below_minimum' : 'above_maximum',
```

**Note:** The `getCexPriceFeedService()` call at the top of the method is O(1) (returns singleton). The existing `const cexFeed = cexEnabled ? getCexPriceFeedService() : null;` later in the multi-message scoring block (line ~892) can remain — it's the same singleton reference.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add services/coordinator/src/opportunities/cex-alignment.ts \
  services/coordinator/src/opportunities/opportunity-router.ts \
  services/coordinator/__tests__/unit/opportunities/cex-alignment.test.ts
git commit -m "feat(scoring): adaptive profit threshold when CEX feed degraded (CEX resilience 4/5)"
```

---

## Task 5: Dashboard & SSE Health Display

**Files:**
- Modify: `dashboard/src/lib/types.ts` (CexSpreadData type)
- Modify: `dashboard/src/tabs/DiagnosticsTab.tsx` (CexSpreadSection)
- Modify: `services/coordinator/src/api/routes/sse.routes.ts` (cex-spread event)

This task enhances the dashboard to show the CEX feed health status, degradation duration, and actionable guidance for operators.

- [ ] **Step 1: Add healthSnapshot to CexSpreadData type**

In `dashboard/src/lib/types.ts`, find the CexSpreadData type and add:

```typescript
  healthSnapshot?: {
    status: string;
    disconnectedSince: number | null;
    isDegraded: boolean;
  };
```

- [ ] **Step 2: Include healthSnapshot in SSE cex-spread event**

In `services/coordinator/src/api/routes/sse.routes.ts`, find the cex-spread SSE event payload (around line 140-143). Add `healthSnapshot`:

```typescript
          stats: cexFeed.getStats(),
          alerts: cexFeed.getActiveAlerts(),
          healthSnapshot: cexFeed.getHealthSnapshot(),
```

Do the same for the second occurrence (~line 236-239):
```typescript
          stats: cexFeed.getStats(),
          alerts: cexFeed.getActiveAlerts(),
          healthSnapshot: cexFeed.getHealthSnapshot(),
```

- [ ] **Step 3: Enhance DiagnosticsTab CexSpreadSection**

In `dashboard/src/tabs/DiagnosticsTab.tsx`, around line 276, update the StatusBadge to use `healthSnapshot`:

Replace the existing status logic:
```typescript
          <StatusBadge status={data.stats.running ? (data.stats.wsConnected ? 'healthy' : 'warning') : 'unknown'}
            label={data.stats.running ? (data.stats.simulationMode ? 'Simulation' : data.stats.wsConnected ? 'Connected' : 'Disconnected') : 'Stopped'} />
```

With:
```typescript
          <StatusBadge
            status={
              data.healthSnapshot?.isDegraded ? 'error' :
              data.stats.running ? (data.stats.wsConnected ? 'healthy' : 'warning') : 'unknown'
            }
            label={
              data.healthSnapshot?.isDegraded
                ? `Degraded ${data.healthSnapshot.disconnectedSince
                    ? `(${Math.round((Date.now() - data.healthSnapshot.disconnectedSince) / 60000)}m)`
                    : ''}`
                : data.stats.running
                  ? (data.stats.simulationMode ? 'Simulation' : data.stats.wsConnected ? 'Connected' : 'Disconnected')
                  : 'Stopped'
            }
          />
```

After the StatusBadge, add degradation guidance:
```typescript
          {data.healthSnapshot?.isDegraded && (
            <p className="text-xs text-red-400 mt-1">
              CEX validation inactive. Scoring uses neutral alignment (1.0).
              Check Binance WS connectivity or NODE_TLS_REJECT_UNAUTHORIZED setting.
            </p>
          )}
```

- [ ] **Step 4: Visual verification**

Run: `npm run build:dashboard`
Expected: Build succeeds with no TypeScript errors

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/lib/types.ts \
  dashboard/src/tabs/DiagnosticsTab.tsx \
  services/coordinator/src/api/routes/sse.routes.ts
git commit -m "feat(dashboard): show CEX feed degradation status with guidance (CEX resilience 5/5)"
```

---

## Task 6: Configurable Reconnect Parameters

**Files:**
- Modify: `shared/core/src/feeds/binance-ws-client.ts` (lines ~80-86)
- Modify: `services/coordinator/src/coordinator.ts` (line ~755)

This is a small quality-of-life change to make WS reconnect behavior configurable via env vars, useful for corporate/firewalled environments where Binance WS will never connect.

- [ ] **Step 1: Read env vars in coordinator CEX startup**

In `services/coordinator/src/coordinator.ts`, where the `CexPriceFeedService` is created (line ~747), pass WS config through:

The BinanceWsConfig is already accepted via the constructor. We need to thread env vars from coordinator → CexPriceFeedService → BinanceWebSocketClient.

Add to `CexPriceFeedConfig` interface in `cex-price-feed-service.ts`:
```typescript
  /** Override max reconnect attempts (default: 10) */
  maxReconnectAttempts?: number;
  /** Override last-resort reconnect interval in ms (default: 300000 = 5min, 0 = disable) */
  lastResortIntervalMs?: number;
```

In `CexPriceFeedService.start()`, when creating the BinanceWebSocketClient (line 155), pass through:
```typescript
    this.wsClient = new BinanceWebSocketClient({
      streams,
      ...(this.config.maxReconnectAttempts !== undefined && { maxReconnectAttempts: this.config.maxReconnectAttempts }),
    });
```

In the coordinator (line ~747), read from env:
```typescript
        const cexFeed = getCexPriceFeedService({
          alertThresholdPct: safeParseFloat(process.env.CEX_PRICE_ALERT_THRESHOLD_PCT, 0.3),
          maxCexPriceAgeMs: safeParseInt(process.env.CEX_PRICE_MAX_AGE_MS, 10000),
          skipExternalConnection: isSimMode,
          simulateCexPrices: isSimMode,
          maxReconnectAttempts: safeParseInt(process.env.CEX_WS_MAX_RECONNECT_ATTEMPTS, 10),
        });
```

- [ ] **Step 2: Add env vars to .env.example**

Add to `.env.example`:
```bash
# CEX Price Feed (ADR-036) — Resilience tuning
# CEX_WS_MAX_RECONNECT_ATTEMPTS=10    # Max reconnect attempts before degraded mode (default: 10)
# CEX_DEGRADED_PROFIT_MULTIPLIER=1.2  # Min profit multiplier when CEX degraded (default: 1.2, range: 1.0-3.0)
# CEX_PRICE_ALERT_THRESHOLD_PCT=0.3   # Spread alert threshold percentage (default: 0.3)
# CEX_PRICE_MAX_AGE_MS=10000          # Max CEX price age before stale rejection (default: 10000)
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add shared/core/src/feeds/cex-price-feed-service.ts \
  services/coordinator/src/coordinator.ts \
  .env.example
git commit -m "feat(config): add CEX WS resilience env vars (CEX resilience 6/6)"
```

---

## Task 7: Final Verification

- [ ] **Step 1: Run full shared/core test suite**

Run: `cd shared/core && npx jest --no-coverage`
Expected: All passing, 0 failures

- [ ] **Step 2: Run coordinator test suite**

Run: `cd services/coordinator && npx jest --no-coverage`
Expected: All passing, 0 failures

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 4: Run dashboard build**

Run: `npm run build:dashboard`
Expected: Clean build

- [ ] **Step 5: Update ADR-036 with resilience section**

Add to `docs/architecture/adr/ADR-036-cex-price-signals.md`, after the "Implementation Notes" section:

```markdown
## Resilience Enhancements (2026-03-12)

### Health State Machine
`CexFeedHealthTracker` tracks connection status through 5 states: `DISCONNECTED` → `CONNECTED` → `RECONNECTING` → `DEGRADED` → `PASSIVE`. Integrated into `CexPriceFeedService.getHealthSnapshot()`.

### Operator Visibility
- Health status included in coordinator alerts (degradation + recovery)
- Dashboard shows degradation duration and actionable guidance
- `CexFeedStats.healthStatus` exposed via SSE `cex-spread` events

### Adaptive Scoring
When CEX feed is DEGRADED, `getCexDegradedProfitMultiplier()` raises the minimum profit threshold by `CEX_DEGRADED_PROFIT_MULTIPLIER` (default 1.2x). This compensates for the lost ability to penalize opportunities that contradict CEX-DEX spread (the 0.8x factor is inoperative when no CEX data is available).

### Configuration
| Env Var | Default | Description |
|---------|---------|-------------|
| `CEX_WS_MAX_RECONNECT_ATTEMPTS` | 10 | Reconnect attempts before DEGRADED state |
| `CEX_DEGRADED_PROFIT_MULTIPLIER` | 1.2 | Min profit multiplier during degradation |
| `CEX_PRICE_ALERT_THRESHOLD_PCT` | 0.3 | Spread alert threshold (%) |
| `CEX_PRICE_MAX_AGE_MS` | 10000 | Stale CEX price rejection window (ms) |
```

- [ ] **Step 6: Commit**

```bash
git add docs/architecture/adr/ADR-036-cex-price-signals.md
git commit -m "docs: add resilience section to ADR-036"
```

---

## Risk Mitigation Notes

1. **Hot-path impact**: The only hot-path change is reading `this.effectiveMinProfitPercentage` (a number field) instead of `this.config.minProfitPercentage`. Same cost. The `isDegraded` check happens once per batch, not per opportunity.

2. **Default multiplier (1.2x)**: Conservative — raises min profit from 0.1% to 0.12%. This means opportunities with 0.1-0.12% profit are filtered when CEX is degraded. At normal volumes, this drops ~5% of marginal opportunities.

3. **Backward compatibility**: When `FEATURE_CEX_PRICE_SIGNALS=false` (the default), none of this code is reached. The feature flag gating in coordinator.ts and opportunity-router.ts is unchanged.

4. **Test isolation**: All new tests use the existing mock patterns (applyMocks, MockBinanceWsClient). No new external dependencies.
