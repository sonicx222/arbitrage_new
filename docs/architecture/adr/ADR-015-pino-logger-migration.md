# ADR-015: Pino Logger Migration with DI Pattern

## Status
**Accepted** | 2026-01-19

## Context

The arbitrage system's logging infrastructure required modernization due to several issues with the existing Winston-based implementation:

1. **Performance Overhead**
   - Winston adds ~2-5ms per log operation
   - For a system processing 100+ events/second, this creates significant latency
   - Critical for <50ms detection target

2. **Testing Complexity**
   - Heavy reliance on `jest.mock('@arbitrage/core')` across 58+ test files
   - Mock hoisting issues causing test failures
   - Each test file duplicating mock logic
   - No type safety for mocked loggers

3. **Resource Leaks**
   - `createLogger()` creates new file handles per call
   - No singleton caching
   - Potential `MaxListenersExceeded` warnings

4. **Tight Coupling**
   - Direct usage of `winston.Logger` type
   - Hard to swap logging libraries
   - Inconsistent patterns across services

## Decision

Implement a **Pino-based logging infrastructure** with dependency injection pattern:

### 1. ILogger Interface

Define a library-agnostic interface:

```typescript
export interface ILogger {
  fatal(msg: string, meta?: LogMeta): void;
  error(msg: string, meta?: LogMeta): void;
  warn(msg: string, meta?: LogMeta): void;
  info(msg: string, meta?: LogMeta): void;
  debug(msg: string, meta?: LogMeta): void;
  trace?(msg: string, meta?: LogMeta): void;
  child(bindings: LogMeta): ILogger;
  isLevelEnabled?(level: LogLevel): boolean;
}
```

### 2. Pino Implementation

High-performance Pino backend with:

- **Singleton caching** - Same service name returns cached instance
- **BigInt serialization** - Critical for blockchain amounts
- **JSON output** - Production-ready structured logging
- **Pretty printing** - Development convenience

```typescript
const logger = createPinoLogger('my-service');
// Returns cached instance on subsequent calls
```

### 3. Testing Implementations

Two testing implementations that **don't require jest.mock**:

#### RecordingLogger
Captures logs for assertions:

```typescript
const logger = new RecordingLogger();
myService.doSomething(logger);

expect(logger.getErrors()).toHaveLength(1);
expect(logger.hasLogMatching('info', /processed/)).toBe(true);
```

#### NullLogger
Silently discards logs for performance tests:

```typescript
const logger = new NullLogger();
myService.benchmark(logger); // No logging overhead
```

### 4. Dependency Injection Pattern

Classes receive logger via constructor:

```typescript
class ArbitrageDetector {
  constructor(
    private readonly logger: ILogger,
    private readonly redis: RedisClient
  ) {}
}

// Production
new ArbitrageDetector(getLogger('detector'), redis);

// Test
new ArbitrageDetector(new RecordingLogger(), mockRedis);
```

## Rationale

### Why Pino over Winston?

| Metric | Winston | Pino | Improvement |
|--------|---------|------|-------------|
| Throughput | ~20,000 ops/sec | ~120,000 ops/sec | **6x faster** |
| Latency | 2-5ms | 0.3-0.8ms | **6x lower** |
| JSON output | Plugin required | Native | Simpler |
| BigInt support | Manual | Native serializers | Safer |

**Decision**: Pino for latency-sensitive arbitrage detection.

### Why ILogger Interface?

| Approach | Coupling | Testability | Flexibility |
|----------|----------|-------------|-------------|
| Direct library usage | HIGH | Poor | None |
| Interface abstraction | LOW | Excellent | High |

**Decision**: Interface enables:
1. Easy library swapping
2. Type-safe test mocks
3. Consistent API across codebase

### Why RecordingLogger over jest.mock?

| Approach | Type Safety | Maintenance | Hoisting Issues |
|----------|-------------|-------------|-----------------|
| jest.mock | Poor | High | Yes |
| RecordingLogger | Full | Low | None |

**Decision**: RecordingLogger eliminates mock hoisting problems and provides type-safe assertions.

### Why Singleton Caching?

| Approach | File Handles | Memory | Consistency |
|----------|--------------|--------|-------------|
| New instance per call | Leaks | High | Inconsistent |
| Singleton per service | Fixed | Low | Consistent |

**Decision**: Singleton caching prevents resource leaks and ensures consistent logging context.

## Implementation

### Module Structure

```
shared/core/src/logging/
├── types.ts              # ILogger, IPerformanceLogger, LoggerConfig
├── pino-logger.ts        # Pino implementation with caching
├── testing-logger.ts     # RecordingLogger, NullLogger
└── index.ts              # Module exports
```

### Public API

```typescript
// Production logging
import { getLogger, createPinoLogger } from '@arbitrage/core';

// Test utilities
import { RecordingLogger, NullLogger, createMockLoggerFactory } from '@arbitrage/core';

// Types
import type { ILogger, IPerformanceLogger, LoggerConfig } from '@arbitrage/core';
```

### Performance Logger

Extended interface for arbitrage-specific metrics:

```typescript
interface IPerformanceLogger extends ILogger {
  startTimer(operation: string): void;
  endTimer(operation: string, meta?: LogMeta): number;
  logEventLatency(operation: string, latency: number, meta?: LogMeta): void;
  logArbitrageOpportunity(opportunity: ArbitrageOpportunityLog): void;
  logExecutionResult(result: ExecutionResultLog): void;
  logHealthCheck(service: string, status: HealthStatus): void;
  logMetrics(metrics: LogMeta): void;
}
```

## Consequences

### Positive

1. **6x Performance Improvement**
   - ~120,000 ops/sec vs ~20,000 ops/sec
   - Supports <50ms detection target

2. **Eliminated Mock Hoisting Issues**
   - RecordingLogger works without jest.mock
   - Type-safe log assertions

3. **Prevented Resource Leaks**
   - Singleton caching manages instances
   - No file handle leaks

4. **Improved Type Safety**
   - ILogger interface ensures consistency
   - Full TypeScript support

5. **Better Test Experience**
   - 5 min setup vs 30 min with manual mocks
   - Reusable test utilities

### Negative

1. **Migration Effort**
   - Services need gradual migration
   - Winston coexists during transition

2. **New Dependency**
   - pino and pino-pretty packages
   - Minimal footprint

### Mitigations

1. **Backward Compatibility**
   - Existing Winston `Logger` type still exported
   - `createLogger()` still works (deprecated)
   - Gradual migration path

2. **Documentation**
   - This ADR documents patterns
   - Inline code examples

## Alternatives Considered

### Alternative 1: Keep Winston, Add Caching
- **Rejected because**: Performance gap too significant for latency target
- **Would reconsider if**: Winston performance improves significantly

### Alternative 2: Bunyan
- **Rejected because**: Pino is the spiritual successor with better performance
- **Would reconsider if**: Never (Bunyan is effectively deprecated)

### Alternative 3: console.log with Structured Wrapper
- **Rejected because**: No log levels, rotation, or structured output
- **Would reconsider if**: Absolute minimal dependency requirement

## Migration Path

### Phase 1: Infrastructure (Complete)
- [x] ILogger interface
- [x] Pino implementation
- [x] RecordingLogger/NullLogger
- [x] Module exports

### Phase 2: Service Migration (Planned)
- [ ] Coordinator service
- [ ] Execution engine
- [ ] Unified detector
- [ ] Cross-chain detector

### Phase 3: Deprecation (Future)
- [ ] Mark old `createLogger()` as deprecated
- [ ] Remove Winston dependency
- [ ] Update all documentation

## Confidence Level

**92%** - High confidence based on:
- Pino is industry standard for high-performance Node.js
- DI pattern well-established in testing
- RecordingLogger pattern proven in enterprise systems
- Aligns with ADR-009 test architecture goals

## References

- [Pino Documentation](https://getpino.io/)
- [Logger Implementation Plan](../../logger_implementation_plan.md)
- [ADR-009: Test Architecture](./ADR-009-test-architecture.md)
- [Pino Benchmarks](https://github.com/pinojs/pino/blob/master/docs/benchmarks.md)
