# Bug Hunt Report - Final

**Date:** 2026-02-22  
**Status:** Complete  
**Methodology:** Multi-agent analysis using bug-hunt workflow

---

## Executive Summary

Comprehensive scan identified **27 issues** across the codebase:
- **P0 (Critical):** 4 issues - immediate action required
- **P1 (High):** 5 issues - fix this sprint
- **P2 (Medium):** 8 issues - backlog
- **P3 (Low):** 10 issues - track for future

---

## P0 - Critical Issues (Immediate Action)

### P0-1: Double-Counting DEX Fees in Triangular/Multi-Leg Arbitrage
**Location:** `shared/core/src/cross-dex-triangular-arbitrage.ts:744-745`, `shared/core/src/multi-leg-path-finder.ts:525-528`

**Type:** Bug  
**Confidence:** HIGH  
**Impact:** Profitable opportunities incorrectly rejected. Net profit understated by ~0.6-1.2%.

**Evidence:**
```typescript
// Fees applied in AMM simulation (line 816)
const amountInWithFee = (amountInBigInt * feeMultiplierNumerator) / BASIS_POINTS_DIVISOR;

// Then subtracted AGAIN from grossProfit (line 744-745)
const totalFees = steps.reduce((sum, step) => sum + step.fee, 0);
const netProfit = grossProfit - totalFees - gasCost;
```

**Fix:**
```typescript
// Fees are already applied in AMM simulation - don't subtract again
const netProfit = grossProfit - gasCost;
```

**Regression Test:**
```typescript
describe('Triangular arbitrage fee calculation', () => {
  it('should not double-count DEX fees', () => {
    // Mock 3 pools with 0.3% fee each
    // Verify netProfit = grossProfit - gasCost (not grossProfit - fees - gasCost)
  });
});
```

---

### P0-2: Non-Null Assertion Crash in Cross-Chain Execution
**Location:** `services/execution-engine/src/strategies/cross-chain.strategy.ts:832-835`

**Type:** Bug  
**Confidence:** HIGH  
**Impact:** Runtime crash if `error` is undefined when `completed: false`.

**Evidence:**
```typescript
if (!pollingResult.completed) {
  return createErrorResult(
    opportunity.id,
    formatExecutionError(pollingResult.error!.code, pollingResult.error!.message),
    sourceChain,
    opportunity.buyDex || 'unknown',
    pollingResult.error!.sourceTxHash  // All use ! assertion
  );
}
```

**Fix:**
```typescript
const errorCode = pollingResult.error?.code ?? ExecutionErrorCode.UNKNOWN;
const errorMessage = pollingResult.error?.message ?? 'Unknown error';
const sourceTxHash = pollingResult.error?.sourceTxHash;

return createErrorResult(
  opportunity.id,
  formatExecutionError(errorCode, errorMessage),
  sourceChain,
  opportunity.buyDex || 'unknown',
  sourceTxHash
);
```

**Regression Test:**
```typescript
it('should handle pollingResult with completed=false but no error', () => {
  const result = { completed: false, error: undefined };
  // Should not throw, should return error result with UNKNOWN code
});
```

---

### P0-3: Silent Error Swallowing in ETH Price Refresh
**Location:** `services/cross-chain-detector/src/detector.ts:797`

**Type:** Bug  
**Confidence:** HIGH  
**Impact:** Stale ETH prices cause incorrect cross-chain profit calculations, potential financial loss.

**Evidence:**
```typescript
this.ethPriceRefreshInterval = setTimeout(
  () => { scheduleRefresh().catch(() => {}); },  // Silent failure!
  CrossChainDetectorService.ETH_PRICE_REFRESH_INTERVAL_MS
);
```

**Fix:**
```typescript
let consecutiveFailures = 0;

this.ethPriceRefreshInterval = setTimeout(
  async () => { 
    try {
      await scheduleRefresh();
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures++;
      this.logger.error('ETH price refresh failed', { 
        error: (error as Error).message,
        consecutiveFailures 
      });
      if (consecutiveFailures > 5) {
        this.logger.critical('ETH price oracle unreliable - cross-chain detection may be inaccurate');
      }
    }
  },
  CrossChainDetectorService.ETH_PRICE_REFRESH_INTERVAL_MS
);
```

---

### P0-4: Shutdown Race in Execution Engine
**Location:** `services/execution-engine/src/engine.ts:1015-1107`

**Type:** Race Condition  
**Confidence:** MEDIUM  
**Impact:** Executions started after shutdown initiated.

**Evidence:**
```typescript
.finally(() => {
  // ...
  if (this.stateManager.isRunning() && this.queueService?.size() > 0) {
    setImmediate(() => {
      if (!this.isProcessingQueue) {  // Guard already reset in finally
        this.processQueueItems();     // Runs during shutdown!
      }
    });
  }
});
```

**Fix:**
```typescript
setImmediate(() => {
  // Check state BEFORE guard
  if (!this.stateManager.isRunning()) return;
  if (!this.isProcessingQueue) {
    this.processQueueItems();
  }
});
```

---

## P1 - High Priority Issues

### P1-1: WebSocket onConnected Missing Shutdown Check
**Location:** `services/unified-detector/src/chain-instance.ts:866-875`

**Type:** Bug  
**Confidence:** HIGH  
**Impact:** Status becomes 'connected' during shutdown.

**Evidence:**
```typescript
onConnected: () => {
  this.status = 'connected';  // No isRunning check
  this.reconnectAttempts = 0;
  this.emit('statusChange', this.status);
},
```

**Fix:**
```typescript
onConnected: () => {
  if (!this.isRunning) return;  // Add guard
  this.status = 'connected';
  this.reconnectAttempts = 0;
  this.emit('statusChange', this.status);
},
```

---

### P1-2: Cross-Chain Arbitrage Missing DEX Fees
**Location:** `shared/core/src/components/arbitrage-detector.ts:545-549`

**Type:** Bug  
**Confidence:** HIGH  
**Impact:** False positives - unprofitable opportunities flagged as profitable (~0.6% error).

**Evidence:**
```typescript
const priceDiff = highestPrice.price - lowestPrice.price;
const netProfit = priceDiff - bridgeCost;  // No DEX fees!
```

**Fix:**
```typescript
const fee1 = lowestPrice.fee ?? 0.003;  // Default 0.3%
const fee2 = highestPrice.fee ?? 0.003;
const tradingFeeCost = (fee1 + fee2) * lowestPrice.price;
const netProfit = priceDiff - bridgeCost - tradingFeeCost;
```

---

### P1-3: Event Listener Leak in WebSocketManager
**Location:** `services/unified-detector/src/chain-instance.ts:743`

**Type:** Memory Leak  
**Confidence:** MEDIUM  
**Impact:** Memory leak, duplicate event processing on reconnection.

**Fix:** Track listener references and use `.off()` with exact function references:
```typescript
private connectionHandlers: Map<string, Function> = new Map();

// When adding listeners
const handler = (msg) => this.handleMessage(msg);
this.connectionHandlers.set('message', handler);
this.wsManager.on('message', handler);

// When removing
for (const [event, handler] of this.connectionHandlers) {
  this.wsManager.off(event, handler);
}
this.connectionHandlers.clear();
```

---

### P1-4: Anvil Manager Provider Assertions (7 instances)
**Location:** `services/execution-engine/src/services/simulation/anvil-manager.ts:325,334,351,354,393,416,431`

**Type:** Bug  
**Confidence:** HIGH  
**Impact:** Simulation crashes if provider not initialized.

**Evidence:**
```typescript
await this.provider!.send('anvil_reset', [...]);  // 7 occurrences
```

**Fix:**
```typescript
async resetToBlock(blockNumber: number): Promise<void> {
  this.ensureRunning();
  if (!this.provider) {
    throw new Error('Provider not initialized - fork may have been stopped');
  }
  await this.provider.send('anvil_reset', [...]);
}
```

---

### P1-5: Concurrent Flush Race in StreamBatcher
**Location:** `shared/core/src/redis-streams.ts:201-215`

**Type:** Race Condition  
**Confidence:** MEDIUM  
**Impact:** Duplicate Redis commands.

**Fix:**
```typescript
async flush(): Promise<void> {
  // Atomic flag check-and-set
  if (this.flushing) return;
  this.flushing = true;
  
  try {
    // ... flush logic
  } finally {
    this.flushing = false;
  }
}
```

---

## P2 - Medium Priority Issues

| # | Location | Issue | Impact |
|---|----------|-------|--------|
| 1 | `multi-leg-path-finder.ts:550` | `profitPercentage` uses grossProfit instead of netProfit | Incorrect displayed profit |
| 2 | `cross-region-health.ts:756` | Consumer group creation failure silently ignored | Failover events not delivered |
| 3 | `l2-sequencer-provider.ts:390` | MEV protection failure silently ignored | Transactions unprotected |
| 4 | `redis-streams.ts:1017` | `Promise.all` should be `Promise.allSettled` | Incomplete cleanup |
| 5 | `price-matrix.ts:1195` | Singleton initialization race | Spurious startup errors |
| 6 | `hierarchical-cache.ts:1129` | Stuck pending warming flag after crash | Warming blocked |
| 7 | `otel-transport.ts:187,232,251` | OTLP flush failures silently ignored | Unreliable logging |
| 8 | `engine.ts:1549` | Trade logging failure silently ignored | Lost trade records |

---

## P3 - Low Priority Issues

### O(n) Patterns in Throttled Detection (Acceptable)

**Locations:**
- `cross-dex-triangular-arbitrage.ts:355,372,378` - `.filter()` in nested loops
- `cross-dex-triangular-arbitrage.ts:333,358,378` - `.slice()` allocations

**Note:** These are in throttled detection paths (500ms/2000ms intervals), not hot-path. Acceptable but could be optimized with index-based loops if needed.

### `as any` Type Bypasses (5 instances)

**Locations:**
- `redis-streams.ts:624,705,867,930,974` - Redis API calls
- `error-recovery.ts:211,296` - HTTP status access

**Impact:** Type safety bypassed, runtime errors if API changes.

---

## Already Optimized (Good Patterns Found)

The codebase already has these correct patterns:
- O(1) token lookup via `tokensByAddress` Map (`chain-instance.ts:265-268`)
- O(1) pair lookup via `pairsByTokens` Map (`chain-instance.ts:275-276`)
- LRU cache for token pair keys (`chain-instance.ts:1600-1632`)
- Ring buffer for latency tracking (`chain-instance.ts:291-295`)
- SharedArrayBuffer price matrix with Atomics (`price-matrix.ts:612-693`)
- O(1) pool lookup via `poolByPairDex` Map (`multi-leg-path-finder.ts:100`)

---

## Summary

| Priority | Count | Action | Time Estimate |
|----------|-------|--------|---------------|
| P0 | 4 | Fix immediately | 4-6 hours |
| P1 | 5 | Fix this sprint | 8-10 hours |
| P2 | 8 | Backlog | 4-6 hours |
| P3 | 10 | Track for future | As needed |

---

## Recommended Implementation Order

1. **P0-1:** Fix double-fee counting (~1 hour) - Highest financial impact
2. **P0-2:** Add null checks to cross-chain execution (~30 min) - Prevents crashes
3. **P0-3:** Add error logging to ETH price refresh (~30 min) - Data integrity
4. **P1-2:** Add DEX fees to cross-chain calculation (~1 hour) - Financial correctness
5. **P1-1:** Add shutdown check to onConnected (~15 min)
6. **P1-4:** Add null checks to anvil-manager (~1 hour)
7. **P1-3:** Fix event listener tracking (~2 hours)
8. **P1-5:** Fix concurrent flush race (~1 hour)
9. **P0-4:** Fix shutdown race (~1 hour)
10. **P2 issues** as time permits

---

## Test Requirements

Each fix should include:
1. **Unit test** for the specific bug scenario
2. **Regression test** to prevent recurrence
3. **Integration test** if affecting cross-service flow

Run after fixes:
```bash
npm run typecheck && npm test
```
