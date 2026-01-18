# Component-Based Architecture with Dependency Injection

**Date:** 2026-01-18
**Status:** Proposal
**Goal:** Split monolithic detectors into focused, testable components

---

## Current Problem: God Object Anti-Pattern

The `BaseDetector` class (1,863 lines) has **12+ distinct responsibilities**:

| Responsibility | Lines | Should Be |
|----------------|-------|-----------|
| WebSocket management | ~100 | `WebSocketManager` (exists) |
| Redis operations | ~50 | `RedisClient` (exists) |
| Event batching | ~80 | `EventBatcher` (exists) |
| Price update publishing | ~60 | `PricePublisher` |
| Swap event filtering | ~40 | `SwapEventFilter` (exists) |
| Pair discovery | ~100 | `PairDiscoveryService` (exists) |
| Pair caching | ~80 | `PairCacheService` (exists) |
| State management | ~60 | `ServiceStateManager` (exists) |
| Health monitoring | ~50 | `HealthMonitor` |
| Sync/Swap event processing | ~150 | `EventProcessor` |
| Arbitrage detection | ~100 | `OpportunityEngine` |
| Price calculation | ~80 | `PriceCalculator` |

**Result:** Cannot test arbitrage detection without mocking WebSocket, Redis, etc.

---

## Proposed Architecture: Composable Components

```
┌─────────────────────────────────────────────────────────────────┐
│                        ChainDetector                            │
│  (Orchestrator - wires components together)                     │
└─────────────────────────────────────────────────────────────────┘
         │
         ├──► DataIngestion Layer
         │    ├── WebSocketManager (exists)
         │    ├── EventBatcher (exists)
         │    └── EventProcessor (NEW)
         │
         ├──► Storage Layer
         │    ├── PairRepository (NEW - wraps pairs Map)
         │    ├── PriceCache (NEW - L1 cache)
         │    └── StreamPublisher (NEW - Redis Streams)
         │
         ├──► Detection Layer
         │    ├── PriceCalculator (NEW - pure functions)
         │    ├── OpportunityEngine (NEW - detection strategies)
         │    └── WhaleDetector (NEW - whale activity)
         │
         └──► Infrastructure Layer
              ├── ServiceStateManager (exists)
              ├── HealthMonitor (NEW)
              └── Logger/PerfLogger (exists)
```

---

## Component Interfaces (Contracts)

### 1. EventProcessor
```typescript
// shared/core/src/components/event-processor.ts

/**
 * Processes raw blockchain events into domain objects.
 * Pure logic - no I/O, no side effects.
 */
export interface IEventProcessor {
  processSyncEvent(log: RawLog): SyncEventResult | null;
  processSwapEvent(log: RawLog): SwapEventResult | null;
}

export interface SyncEventResult {
  pairAddress: string;
  reserve0: bigint;
  reserve1: bigint;
  blockNumber: number;
  timestamp: number;
}

export interface SwapEventResult {
  pairAddress: string;
  sender: string;
  amount0In: bigint;
  amount1In: bigint;
  amount0Out: bigint;
  amount1Out: bigint;
  transactionHash: string;
  blockNumber: number;
}

export class EventProcessor implements IEventProcessor {
  constructor(
    private readonly abiDecoder: IAbiDecoder,
    private readonly logger: ILogger
  ) {}

  processSyncEvent(log: RawLog): SyncEventResult | null {
    // Pure decoding logic - no Redis, no WebSocket
  }

  processSwapEvent(log: RawLog): SwapEventResult | null {
    // Pure decoding logic
  }
}
```

### 2. PairRepository
```typescript
// shared/core/src/components/pair-repository.ts

/**
 * In-memory storage for trading pairs with efficient lookups.
 * Encapsulates the three Map indices.
 */
export interface IPairRepository {
  add(pair: TradingPair): void;
  update(address: string, reserves: ReserveUpdate): void;
  getByAddress(address: string): TradingPair | undefined;
  getByTokenPair(token0: string, token1: string): TradingPair[];
  getAll(): TradingPair[];
  snapshot(): Map<string, PairSnapshot>;
  clear(): void;
}

export class PairRepository implements IPairRepository {
  private readonly byAddress = new Map<string, TradingPair>();
  private readonly byTokenPair = new Map<string, TradingPair[]>();

  add(pair: TradingPair): void {
    this.byAddress.set(pair.address.toLowerCase(), pair);
    this.updateTokenPairIndex(pair);
  }

  update(address: string, reserves: ReserveUpdate): void {
    const pair = this.byAddress.get(address.toLowerCase());
    if (pair) {
      // Immutable update pattern (P0-1 fix)
      const updated = { ...pair, ...reserves };
      this.byAddress.set(address.toLowerCase(), updated);
    }
  }

  getByTokenPair(token0: string, token1: string): TradingPair[] {
    const key = this.normalizeTokenPairKey(token0, token1);
    return this.byTokenPair.get(key) ?? [];
  }

  private normalizeTokenPairKey(token0: string, token1: string): string {
    const [a, b] = [token0.toLowerCase(), token1.toLowerCase()].sort();
    return `${a}-${b}`;
  }
}
```

### 3. PriceCalculator (Pure Functions)
```typescript
// shared/core/src/components/price-calculator.ts

/**
 * Pure price calculation functions.
 * 100% unit testable - no dependencies.
 */
export interface IPriceCalculator {
  calculatePrice(reserve0: bigint, reserve1: bigint): number;
  calculateSpread(price1: number, price2: number): number;
  calculateNetProfit(spread: number, fee1: number, fee2: number): number;
}

export class PriceCalculator implements IPriceCalculator {
  private readonly PRECISION = 10n ** 18n;

  calculatePrice(reserve0: bigint, reserve1: bigint): number {
    if (reserve1 === 0n) return 0;
    const scaled = (reserve0 * this.PRECISION) / reserve1;
    return Number(scaled) / 1e18;
  }

  calculateSpread(price1: number, price2: number): number {
    const minPrice = Math.min(price1, price2);
    if (minPrice === 0) return 0;
    return Math.abs(price1 - price2) / minPrice;
  }

  calculateNetProfit(spread: number, fee1: number, fee2: number): number {
    return spread - (fee1 + fee2);
  }
}
```

### 4. OpportunityEngine
```typescript
// shared/core/src/components/opportunity-engine.ts

/**
 * Detects arbitrage opportunities from pair data.
 * Uses strategy pattern for different detection types.
 */
export interface IOpportunityEngine {
  detect(pairs: PairSnapshot[]): ArbitrageOpportunity[];
  addStrategy(strategy: IDetectionStrategy): void;
}

export interface IDetectionStrategy {
  readonly name: string;
  detect(pairs: PairSnapshot[]): ArbitrageOpportunity[];
}

export class OpportunityEngine implements IOpportunityEngine {
  private strategies: IDetectionStrategy[] = [];

  constructor(
    private readonly priceCalculator: IPriceCalculator,
    private readonly config: OpportunityConfig,
    private readonly logger: ILogger
  ) {}

  addStrategy(strategy: IDetectionStrategy): void {
    this.strategies.push(strategy);
  }

  detect(pairs: PairSnapshot[]): ArbitrageOpportunity[] {
    const opportunities: ArbitrageOpportunity[] = [];

    for (const strategy of this.strategies) {
      const found = strategy.detect(pairs);
      opportunities.push(...found);
    }

    return this.deduplicate(opportunities);
  }
}

// Strategies
export class IntraChainStrategy implements IDetectionStrategy {
  readonly name = 'intra-chain';

  constructor(
    private readonly priceCalculator: IPriceCalculator,
    private readonly config: { minProfitPercent: number }
  ) {}

  detect(pairs: PairSnapshot[]): ArbitrageOpportunity[] {
    // Group by token pair, compare prices across DEXs
  }
}

export class TriangularStrategy implements IDetectionStrategy {
  readonly name = 'triangular';
  // ...
}
```

### 5. StreamPublisher
```typescript
// shared/core/src/components/stream-publisher.ts

/**
 * Publishes events to Redis Streams.
 * Handles batching and backpressure.
 */
export interface IStreamPublisher {
  publishPrice(update: PriceUpdate): Promise<void>;
  publishSwap(event: SwapEvent): Promise<void>;
  publishOpportunity(opp: ArbitrageOpportunity): Promise<void>;
  publishWhaleAlert(alert: WhaleAlert): Promise<void>;
  flush(): Promise<void>;
}

export class StreamPublisher implements IStreamPublisher {
  constructor(
    private readonly streamsClient: RedisStreamsClient,
    private readonly config: PublisherConfig
  ) {}

  async publishOpportunity(opp: ArbitrageOpportunity): Promise<void> {
    // High priority - no batching
    await this.streamsClient.xadd(
      RedisStreamsClient.STREAMS.OPPORTUNITIES,
      '*',
      { data: JSON.stringify(opp) }
    );
  }
}
```

### 6. HealthMonitor
```typescript
// shared/core/src/components/health-monitor.ts

/**
 * Monitors component health and emits metrics.
 */
export interface IHealthMonitor {
  check(): HealthStatus;
  addCheck(name: string, check: () => Promise<boolean>): void;
  start(intervalMs: number): void;
  stop(): void;
}

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: Record<string, boolean>;
  uptime: number;
  lastCheck: number;
}
```

---

## Dependency Injection Container

```typescript
// shared/core/src/di/container.ts

/**
 * Simple DI container for wiring components.
 * No external libraries needed.
 */
export class Container {
  private instances = new Map<string, any>();
  private factories = new Map<string, () => any>();

  register<T>(token: string, factory: () => T): void {
    this.factories.set(token, factory);
  }

  registerSingleton<T>(token: string, factory: () => T): void {
    this.factories.set(token, () => {
      if (!this.instances.has(token)) {
        this.instances.set(token, factory());
      }
      return this.instances.get(token);
    });
  }

  resolve<T>(token: string): T {
    const factory = this.factories.get(token);
    if (!factory) {
      throw new Error(`No registration for ${token}`);
    }
    return factory();
  }
}

// Usage
const container = new Container();

// Register components
container.registerSingleton('logger', () => createLogger('detector'));
container.registerSingleton('priceCalculator', () => new PriceCalculator());
container.registerSingleton('pairRepository', () => new PairRepository());
container.registerSingleton('opportunityEngine', () =>
  new OpportunityEngine(
    container.resolve('priceCalculator'),
    { minProfitPercent: 0.003 },
    container.resolve('logger')
  )
);

// Create detector
const detector = new ChainDetector({
  eventProcessor: container.resolve('eventProcessor'),
  pairRepository: container.resolve('pairRepository'),
  opportunityEngine: container.resolve('opportunityEngine'),
  streamPublisher: container.resolve('streamPublisher'),
  healthMonitor: container.resolve('healthMonitor'),
});
```

---

## Refactored ChainDetector (Orchestrator Only)

```typescript
// shared/core/src/chain-detector.ts

/**
 * Orchestrates components - no business logic.
 * All logic delegated to injected components.
 */
export class ChainDetector {
  constructor(
    private readonly deps: {
      eventProcessor: IEventProcessor;
      pairRepository: IPairRepository;
      priceCalculator: IPriceCalculator;
      opportunityEngine: IOpportunityEngine;
      streamPublisher: IStreamPublisher;
      healthMonitor: IHealthMonitor;
      wsManager: WebSocketManager;
      stateManager: ServiceStateManager;
      logger: ILogger;
    }
  ) {}

  async start(): Promise<void> {
    await this.deps.stateManager.executeStart(async () => {
      await this.deps.wsManager.connect();
      this.deps.wsManager.on('message', this.handleMessage.bind(this));
      this.deps.healthMonitor.start(30000);
    });
  }

  async stop(): Promise<void> {
    await this.deps.stateManager.executeStop(async () => {
      this.deps.healthMonitor.stop();
      await this.deps.wsManager.disconnect();
    });
  }

  private async handleMessage(message: WebSocketMessage): Promise<void> {
    // 1. Process event
    const syncResult = this.deps.eventProcessor.processSyncEvent(message.log);
    if (!syncResult) return;

    // 2. Update repository
    this.deps.pairRepository.update(syncResult.pairAddress, {
      reserve0: syncResult.reserve0.toString(),
      reserve1: syncResult.reserve1.toString(),
      blockNumber: syncResult.blockNumber,
    });

    // 3. Get affected pairs for detection
    const pair = this.deps.pairRepository.getByAddress(syncResult.pairAddress);
    if (!pair) return;

    const matchingPairs = this.deps.pairRepository.getByTokenPair(
      pair.token0,
      pair.token1
    );

    // 4. Detect opportunities
    const snapshots = matchingPairs.map(p => this.deps.pairRepository.snapshot().get(p.address)!);
    const opportunities = this.deps.opportunityEngine.detect(snapshots);

    // 5. Publish opportunities
    for (const opp of opportunities) {
      await this.deps.streamPublisher.publishOpportunity(opp);
    }
  }
}
```

---

## Testing Benefits

### Before: Integration Test Required
```typescript
// OLD: Must mock everything
describe('BaseDetector', () => {
  let detector: TestableDetector;
  let mockRedis: jest.Mocked<RedisClient>;
  let mockStreams: jest.Mocked<RedisStreamsClient>;
  let mockWebSocket: jest.Mocked<WebSocketManager>;

  beforeEach(() => {
    mockRedis = createMockRedis();
    mockStreams = createMockStreams();
    mockWebSocket = createMockWebSocket();
    detector = new TestableDetector({
      redis: mockRedis,
      streams: mockStreams,
      ws: mockWebSocket,
      // ... 10 more mocks
    });
  });

  it('should detect arbitrage', async () => {
    // Complex setup to trigger detection through event pipeline
  });
});
```

### After: Pure Unit Tests
```typescript
// NEW: Test each component in isolation
describe('PriceCalculator', () => {
  const calc = new PriceCalculator();

  it('should calculate price from reserves', () => {
    const price = calc.calculatePrice(1000000n, 500000n);
    expect(price).toBe(2.0);
  });

  it('should calculate spread', () => {
    const spread = calc.calculateSpread(100, 101);
    expect(spread).toBeCloseTo(0.01, 4);
  });
});

describe('OpportunityEngine', () => {
  const mockPriceCalc = { calculatePrice: jest.fn(), calculateSpread: jest.fn() };
  const engine = new OpportunityEngine(mockPriceCalc, config, logger);

  it('should detect profitable spreads', () => {
    const pairs = [/* test data */];
    const opps = engine.detect(pairs);
    expect(opps).toHaveLength(1);
  });
});
```

---

## Migration Path

### Phase 1: Extract Pure Components (Low Risk)
1. Create `PriceCalculator` - extract from `arbitrage-calculator.ts`
2. Create `PairRepository` - extract Map operations
3. Add tests for new components

### Phase 2: Create Infrastructure Components (Medium Risk)
1. Create `EventProcessor` - extract event decoding
2. Create `StreamPublisher` - extract publishing logic
3. Create `HealthMonitor` - extract health checks

### Phase 3: Create DI Container (Low Risk)
1. Implement simple container
2. Wire existing components
3. Add factory functions

### Phase 4: Refactor Detectors (Medium-High Risk)
1. Create new `ChainDetector` orchestrator
2. Migrate `ChainDetectorInstance` to use components
3. Migrate `BaseDetector` subclasses
4. Deprecate old classes

### Phase 5: Add ML Components (Future)
1. `MLPredictor` - opportunity scoring
2. `FeatureExtractor` - extract features from pairs
3. `ModelLoader` - load/update models

---

## Component Registry (Future)

```typescript
// Standardized component registration
const components = {
  // Core
  'price-calculator': PriceCalculator,
  'pair-repository': PairRepository,
  'opportunity-engine': OpportunityEngine,

  // Detection Strategies
  'strategy:intra-chain': IntraChainStrategy,
  'strategy:triangular': TriangularStrategy,
  'strategy:cross-chain': CrossChainStrategy,

  // Infrastructure
  'stream-publisher': StreamPublisher,
  'health-monitor': HealthMonitor,
  'event-processor': EventProcessor,

  // ML (future)
  'ml-predictor': MLPredictor,
  'feature-extractor': FeatureExtractor,
};
```

---

## Summary

| Aspect | Before | After |
|--------|--------|-------|
| Class size | 1,863 lines | ~100 lines (orchestrator) |
| Responsibilities | 12+ | 1 (orchestration) |
| Unit testable | No | Yes |
| Component reuse | Hard | Easy |
| Adding new strategy | Modify base class | Add strategy class |
| Adding ML | Major refactor | Add component |

**Recommendation:** Proceed with this architecture. It aligns with:
- SOLID principles (especially S and D)
- Clean Architecture
- Ports and Adapters pattern
- Strategy pattern for detection types

The migration can be done incrementally without breaking existing functionality.
