# Code Style

## General Guidelines
- Use ES modules (import/export) syntax, not CommonJS (require)
- Make use of npm workspace packages to structure the modules in a clean way
- Code should be functional, efficient, and adhere to best practices in node.js programming

## Type Safety

### Logger Type
Always use the exported `Logger` type instead of `any`:

```typescript
// ❌ Bad
protected logger: any;

// ✅ Good
import { Logger } from './logger';
protected logger: Logger;
```

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