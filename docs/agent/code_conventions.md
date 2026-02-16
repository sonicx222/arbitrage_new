# Code Style

## General Guidelines
- Use ES modules (import/export) syntax, not CommonJS (require)
  - **Exception:** `scripts/lib/*.js` files use CommonJS for direct Node.js execution without a build step. These are development utility scripts that must run with plain `node` (no transpiler). TypeScript scripts in `scripts/` (`.ts` files) and `contracts/scripts/` use ES modules.
- Make use of npm workspace packages to structure the modules in a clean way
- Code should be functional, efficient, and adhere to best practices in node.js programming

## Type Safety

### Logger Type
For **new code**, use the `ILogger` interface from the logging module:

```typescript
// ❌ Bad
protected logger: any;

// ✅ Best (new code) — strict types via ILogger
import type { ILogger } from './logging';
protected logger: ILogger;

// ✅ Acceptable (existing code) — Logger facade still works
import { Logger } from './logger';
protected logger: Logger;
```

> **Note:** The `Logger` type from `./logger` is a backward-compatible facade with permissive (`any`) meta parameters. `ILogger` from `./logging` provides stricter type safety via `Record<string, unknown>` metadata. Prefer `ILogger` for all new code; existing code using `Logger` does not need to be migrated.

### Nullable Types
Use proper nullable types instead of `as any` casts:

```typescript
// ❌ Bad
protected eventBatcher: any;
this.eventBatcher = null as any;

// ✅ Good
protected eventBatcher: EventBatcher | null = null;
this.eventBatcher = null;
```

### Async Reset Functions
Singleton reset functions must be async and await disconnect operations:

```typescript
// ❌ Bad - disconnect not awaited
export function resetRedisInstance(): void {
  if (redisInstance) {
    redisInstance.disconnect().catch(() => {});
  }
  redisInstance = null;
}

// ✅ Good - properly awaits disconnect
export async function resetRedisInstance(): Promise<void> {
  if (redisInstancePromise && !redisInstance) {
    try { await redisInstancePromise; } catch {}
  }
  if (redisInstance) {
    try { await redisInstance.disconnect(); } catch {}
  }
  redisInstance = null;
}
```

## Redis Best Practices

### Key Enumeration
Never use blocking `KEYS` command; use `SCAN` iterator instead:

```typescript
// ❌ Bad - blocks Redis on large datasets
const keys = await this.client.keys('health:*');

// ✅ Good - non-blocking iteration
let cursor = '0';
do {
  const [nextCursor, keys] = await this.scan(cursor, 'MATCH', 'health:*', 'COUNT', 100);
  cursor = nextCursor;
  // process keys...
} while (cursor !== '0');
```

### Error Handling
Throw on Redis errors to allow callers to distinguish between "not found" and "unavailable":

```typescript
// ❌ Bad - can't distinguish error from not found
async exists(key: string): Promise<boolean> {
  try {
    return (await this.client.exists(key)) === 1;
  } catch {
    return false; // Is Redis down or does key not exist?
  }
}

// ✅ Good - throws on error
async exists(key: string): Promise<boolean> {
  try {
    return (await this.client.exists(key)) === 1;
  } catch (error) {
    throw new Error(`Redis exists failed: ${(error as Error).message}`);
  }
}
```

## Memory Leak Prevention

### Interval Cleanup
Self-clear intervals when stopping to prevent wasted cycles:

```typescript
// ✅ Good - self-clears when stopping
this.healthInterval = setInterval(async () => {
  if (this.isStopping) {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
    return;
  }
  // ... health check logic
}, interval);
```

## Bug Analysis Patterns

When analyzing code for bugs, apply these proven patterns:

### Hot-Path Performance (< 50ms)

Code in hot paths (detection loops running 100-1000 times/sec) requires special care:

```typescript
// ❌ Bad - allocation in tight loop
for (const pair of pairs) {
  const snapshot = { ...pair, calculatedField: compute(pair) };  // Object allocation
  results.push(snapshot);  // Dynamic array growth
}

// ✅ Good - pre-allocation and cached values
const results = new Array(pairs.length);  // Pre-allocate
let i = 0;
for (const pair of pairs) {
  results[i++] = pair.cachedSnapshot;  // Use pre-computed values
}
```

### BigInt/Number Overflow Protection

Always guard BigInt→Number conversions for values > 2^53:

```typescript
// ❌ Bad - can overflow silently
const value = Number(BigInt(largeString)) / divisor;

// ✅ Good - explicit overflow check
const value = Number(BigInt(largeString)) / divisor;
if (!Number.isFinite(value)) {
  return 0;  // Graceful fallback
}
```

### Price Validation Bounds

Validate prices BEFORE any division to prevent overflow/precision loss:

```typescript
// ❌ Bad - division overflow when price is tiny
const invertedPrice = 1 / price;

// ✅ Good - configurable bounds validation first
const MIN_SAFE_PRICE = 1e-18;  // Supports memecoins
const MAX_SAFE_PRICE = 1e18;   // Safe inverse
if (price < MIN_SAFE_PRICE || price > MAX_SAFE_PRICE) {
  return null;
}
const invertedPrice = 1 / price;  // Now safe
```

### Fee Representation Consistency

Document and validate fee formats explicitly:

```typescript
// Decimal format: 0.003 = 0.30% (used in detection)
// Basis points: 30 = 0.30% (used in contracts)

export function decimalToBasisPoints(fee: number): number {
  return Math.round(fee * 10000);
}

export function basisPointsToDecimal(bps: number): number {
  return bps / 10000;
}
```

### TOCTOU Prevention

Guard against time-of-check to time-of-use race conditions:

```typescript
// ❌ Bad - state can change between check and use
if (this.isReady()) {
  await this.process(data);  // May fail if state changed
}

// ✅ Good - capture state at check time
const snapshot = this.captureState();
if (snapshot.isReady) {
  await this.processWithSnapshot(data, snapshot);
}
```

### Bug Fix Documentation

When fixing bugs, add JSDoc references for traceability:

```typescript
/**
 * @module detection/arbitrage-detector
 * @see FIX 4.1 in docs/reports/BUG_FIX_LOG_2026-02.md
 */

// In-line comments for specific fixes:
// FIX 4.1: Configurable price bounds for memecoin support
this.minSafePrice = config.minSafePrice ?? 1e-18;
```

### Analysis Checklist

When reviewing code, check for:
1. **Overflow risks**: BigInt→Number, Number→BigInt, division by small values
2. **Bounds validation**: Input validation before mathematical operations
3. **Unit consistency**: Fee formats, decimal precision, timestamp units
4. **State races**: Async operations with shared mutable state
5. **Memory allocation**: Object creation in hot paths, unbounded array growth
6. **Cache coherency**: TTL expiry, version-based invalidation
7. **Error handling**: Graceful degradation vs silent failure