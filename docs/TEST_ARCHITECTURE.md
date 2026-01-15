# Test Architecture Design

## Executive Summary

This document outlines a modern, professional test setup architecture for the Node.js arbitrage system, addressing current issues and establishing best practices for maintainability, reliability, and developer experience.

## Current State Analysis

### Issues Identified

#### 1. Fragmented Jest Configuration
- **Root-level `jest.config.js`** handles workspace projects
- **Package-level configs** (`shared/core/jest.config.js`, etc.) have different settings
- No shared configuration base leads to inconsistent behavior

#### 2. Inconsistent Import Patterns
```typescript
// Problem: Mixed import styles causing potential circular dependencies
import { ... } from '../../../shared/core/src';      // Relative (fragile)
import { ... } from '@arbitrage/core';               // Package alias (preferred)
import { ... } from './redis-streams';               // Local relative (OK for unit tests)
```

#### 3. Test File Organization
- Unit tests co-located with source: `shared/core/src/*.test.ts`
- Integration tests in separate folder: `tests/integration/*.test.ts`
- Some tests use `__tests__` directories, others don't
- No clear naming convention enforcement

#### 4. Mock Infrastructure Duplication
- `RedisMock` in `test-utils/src/index.ts`
- Inline Redis mocks in individual tests (duplicated ~10 times)
- Different mock behaviors across tests

#### 5. Global State Issues
- Singleton patterns cause test interference
- Manual `resetXxxInstance()` calls scattered throughout tests
- Environment variables not properly isolated

#### 6. Missing Test Categories
- No clear separation: unit vs integration vs e2e
- Performance tests mixed with functional tests
- Missing smoke test suite

---

## Proposed Architecture

### Directory Structure

```
arbitrage_new/
├── jest.config.base.js           # Shared base configuration
├── jest.config.js                # Root project config (extends base)
├── jest.setup.ts                 # Global setup (runs once)
├── jest.teardown.ts              # Global teardown (runs once)
│
├── shared/
│   ├── test-utils/
│   │   ├── src/
│   │   │   ├── index.ts              # Main exports
│   │   │   ├── setup/
│   │   │   │   ├── jest-setup.ts     # Per-file setup
│   │   │   │   ├── redis-setup.ts    # Redis test server
│   │   │   │   └── env-setup.ts      # Environment isolation
│   │   │   ├── mocks/
│   │   │   │   ├── redis.mock.ts     # Unified Redis mock
│   │   │   │   ├── blockchain.mock.ts
│   │   │   │   ├── websocket.mock.ts
│   │   │   │   └── index.ts
│   │   │   ├── factories/
│   │   │   │   ├── swap-event.factory.ts
│   │   │   │   ├── price-update.factory.ts
│   │   │   │   ├── arbitrage.factory.ts
│   │   │   │   └── index.ts
│   │   │   ├── fixtures/
│   │   │   │   ├── tokens.fixture.ts
│   │   │   │   ├── dexes.fixture.ts
│   │   │   │   └── index.ts
│   │   │   └── helpers/
│   │   │       ├── async.helpers.ts
│   │   │       ├── assertion.helpers.ts
│   │   │       └── index.ts
│   │   └── package.json
│   │
│   └── core/
│       ├── src/
│       │   └── [source files only - no tests]
│       └── __tests__/
│           ├── unit/
│           │   ├── redis-streams.test.ts
│           │   ├── service-state.test.ts
│           │   └── ...
│           └── integration/
│               └── ...
│
├── services/
│   └── [each service]/
│       ├── src/
│       └── __tests__/
│           ├── unit/
│           └── integration/
│
└── tests/
    ├── integration/              # Cross-service integration
    ├── e2e/                      # End-to-end scenarios
    └── performance/              # Performance benchmarks
```

### Configuration Hierarchy

#### 1. Base Configuration (`jest.config.base.js`)

```javascript
// jest.config.base.js
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',

  // Transform configuration
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: '<rootDir>/tsconfig.json',
      diagnostics: { ignoreCodes: [151001] }
    }]
  },

  // Module resolution
  moduleNameMapper: {
    '^@arbitrage/core$': '<rootDir>/shared/core/src',
    '^@arbitrage/core/(.*)$': '<rootDir>/shared/core/src/$1',
    '^@arbitrage/config$': '<rootDir>/shared/config/src',
    '^@arbitrage/config/(.*)$': '<rootDir>/shared/config/src/$1',
    '^@arbitrage/types$': '<rootDir>/shared/types',
    '^@arbitrage/types/(.*)$': '<rootDir>/shared/types/$1',
    '^@arbitrage/test-utils$': '<rootDir>/shared/test-utils/src',
    '^@arbitrage/test-utils/(.*)$': '<rootDir>/shared/test-utils/src/$1',
  },

  // Default test timeouts
  testTimeout: 30000,

  // Clear mocks between tests
  clearMocks: true,
  resetMocks: true,
  restoreMocks: true,

  // Error on unhandled promises
  errorOnDeprecated: true,

  // Coverage settings
  collectCoverageFrom: [
    '**/*.ts',
    '!**/*.d.ts',
    '!**/node_modules/**',
    '!**/dist/**',
    '!**/__tests__/**',
    '!**/test-utils/**'
  ],

  // Reporter configuration
  reporters: [
    'default',
    ['jest-junit', {
      outputDirectory: './coverage',
      outputName: 'junit.xml'
    }]
  ]
};
```

#### 2. Root Configuration (`jest.config.js`)

```javascript
// jest.config.js
const baseConfig = require('./jest.config.base');

/** @type {import('jest').Config} */
module.exports = {
  ...baseConfig,

  // Test discovery
  roots: ['<rootDir>/shared', '<rootDir>/services', '<rootDir>/tests'],
  testMatch: [
    '**/__tests__/**/*.test.ts',
    '**/tests/**/*.test.ts'
  ],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],

  // Global setup/teardown
  globalSetup: '<rootDir>/jest.setup.ts',
  globalTeardown: '<rootDir>/jest.teardown.ts',

  // Per-file setup
  setupFilesAfterEnv: ['<rootDir>/shared/test-utils/src/setup/jest-setup.ts'],

  // Test isolation
  maxWorkers: '50%',

  // Test categories via projects
  projects: [
    {
      displayName: 'unit',
      testMatch: ['**/__tests__/unit/**/*.test.ts'],
      ...baseConfig
    },
    {
      displayName: 'integration',
      testMatch: [
        '**/__tests__/integration/**/*.test.ts',
        '**/tests/integration/**/*.test.ts'
      ],
      ...baseConfig,
      testTimeout: 60000
    },
    {
      displayName: 'e2e',
      testMatch: ['**/tests/e2e/**/*.test.ts'],
      ...baseConfig,
      testTimeout: 120000
    }
  ]
};
```

---

## Test Utilities Refactoring

### 1. Unified Mock System

```typescript
// shared/test-utils/src/mocks/redis.mock.ts
import { jest } from '@jest/globals';

export interface RedisMockOptions {
  initialData?: Map<string, unknown>;
  simulateFailures?: boolean;
  latencyMs?: number;
}

export class RedisMock {
  private data = new Map<string, unknown>();
  private streams = new Map<string, unknown[]>();
  private pubSubChannels = new Map<string, Set<(message: string) => void>>();
  private options: RedisMockOptions;

  constructor(options: RedisMockOptions = {}) {
    this.options = options;
    if (options.initialData) {
      this.data = new Map(options.initialData);
    }
  }

  // Core Redis commands
  async get(key: string): Promise<string | null> {
    await this.simulateLatency();
    this.checkFailure('get');
    return (this.data.get(key) as string) ?? null;
  }

  async set(key: string, value: string, ...args: unknown[]): Promise<'OK'> {
    await this.simulateLatency();
    this.checkFailure('set');
    this.data.set(key, value);
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    await this.simulateLatency();
    let deleted = 0;
    for (const key of keys) {
      if (this.data.delete(key)) deleted++;
    }
    return deleted;
  }

  // Stream commands
  async xadd(stream: string, id: string, ...fieldValues: string[]): Promise<string> {
    await this.simulateLatency();
    const streamData = this.streams.get(stream) ?? [];
    const messageId = id === '*' ? `${Date.now()}-${streamData.length}` : id;
    const fields: Record<string, string> = {};
    for (let i = 0; i < fieldValues.length; i += 2) {
      fields[fieldValues[i]] = fieldValues[i + 1];
    }
    streamData.push({ id: messageId, fields });
    this.streams.set(stream, streamData);
    return messageId;
  }

  async xread(...args: unknown[]): Promise<unknown[] | null> {
    await this.simulateLatency();
    // Implementation...
    return null;
  }

  // Pub/Sub
  async publish(channel: string, message: string): Promise<number> {
    await this.simulateLatency();
    const subscribers = this.pubSubChannels.get(channel);
    if (subscribers) {
      subscribers.forEach(cb => cb(message));
      return subscribers.size;
    }
    return 0;
  }

  async subscribe(channel: string, callback: (message: string) => void): Promise<void> {
    if (!this.pubSubChannels.has(channel)) {
      this.pubSubChannels.set(channel, new Set());
    }
    this.pubSubChannels.get(channel)!.add(callback);
  }

  // Test helpers
  async ping(): Promise<'PONG'> {
    return 'PONG';
  }

  async disconnect(): Promise<void> {
    this.data.clear();
    this.streams.clear();
    this.pubSubChannels.clear();
  }

  // Internal test utilities
  getData(): Map<string, unknown> {
    return new Map(this.data);
  }

  getStreams(): Map<string, unknown[]> {
    return new Map(this.streams);
  }

  clear(): void {
    this.data.clear();
    this.streams.clear();
    this.pubSubChannels.clear();
  }

  private async simulateLatency(): Promise<void> {
    if (this.options.latencyMs) {
      await new Promise(r => setTimeout(r, this.options.latencyMs));
    }
  }

  private checkFailure(operation: string): void {
    if (this.options.simulateFailures) {
      throw new Error(`Simulated Redis failure on ${operation}`);
    }
  }
}

// Factory function for easy mocking
export function createRedisMock(options?: RedisMockOptions): RedisMock {
  return new RedisMock(options);
}

// Jest mock setup helper
export function setupRedisMock(mock?: RedisMock): jest.Mock {
  const instance = mock ?? createRedisMock();
  const MockRedis = jest.fn(() => instance);
  jest.mock('ioredis', () => MockRedis);
  return MockRedis;
}
```

### 2. Test Factories (Builder Pattern)

```typescript
// shared/test-utils/src/factories/swap-event.factory.ts
import type { SwapEvent } from '@arbitrage/types';

export interface SwapEventOverrides {
  pairAddress?: string;
  sender?: string;
  recipient?: string;
  amount0In?: string;
  amount1In?: string;
  amount0Out?: string;
  amount1Out?: string;
  blockNumber?: number;
  transactionHash?: string;
  timestamp?: number;
  dex?: string;
  chain?: string;
  usdValue?: number;
}

let eventCounter = 0;

export function createSwapEvent(overrides: SwapEventOverrides = {}): SwapEvent {
  eventCounter++;
  const timestamp = overrides.timestamp ?? Date.now();

  return {
    pairAddress: overrides.pairAddress ?? `0x${eventCounter.toString(16).padStart(40, '0')}`,
    sender: overrides.sender ?? `0xsender${eventCounter.toString(16).padStart(34, '0')}`,
    recipient: overrides.recipient ?? `0xrecipient${eventCounter.toString(16).padStart(30, '0')}`,
    amount0In: overrides.amount0In ?? '1000000000000000000',
    amount1In: overrides.amount1In ?? '0',
    amount0Out: overrides.amount0Out ?? '0',
    amount1Out: overrides.amount1Out ?? '2000000000',
    to: overrides.recipient ?? `0xto${eventCounter.toString(16).padStart(36, '0')}`,
    blockNumber: overrides.blockNumber ?? 12345678 + eventCounter,
    transactionHash: overrides.transactionHash ?? `0xtx${eventCounter.toString(16).padStart(62, '0')}`,
    timestamp,
    dex: overrides.dex ?? 'uniswap_v3',
    chain: overrides.chain ?? 'ethereum',
    usdValue: overrides.usdValue ?? 2000
  };
}

// Builder pattern for complex scenarios
export class SwapEventBuilder {
  private overrides: SwapEventOverrides = {};

  withPair(address: string): this {
    this.overrides.pairAddress = address;
    return this;
  }

  withUsdValue(value: number): this {
    this.overrides.usdValue = value;
    return this;
  }

  onChain(chain: string): this {
    this.overrides.chain = chain;
    return this;
  }

  onDex(dex: string): this {
    this.overrides.dex = dex;
    return this;
  }

  asWhale(value = 100000): this {
    this.overrides.usdValue = value;
    return this;
  }

  asDust(value = 1): this {
    this.overrides.usdValue = value;
    return this;
  }

  withZeroAmounts(): this {
    this.overrides.amount0In = '0';
    this.overrides.amount1In = '0';
    this.overrides.amount0Out = '0';
    this.overrides.amount1Out = '0';
    this.overrides.usdValue = 0;
    return this;
  }

  build(): SwapEvent {
    return createSwapEvent(this.overrides);
  }

  buildMany(count: number): SwapEvent[] {
    return Array.from({ length: count }, () => this.build());
  }
}

export function swapEvent(): SwapEventBuilder {
  return new SwapEventBuilder();
}

// Reset counter between tests
export function resetSwapEventFactory(): void {
  eventCounter = 0;
}
```

### 3. Environment Isolation

```typescript
// shared/test-utils/src/setup/env-setup.ts
const originalEnv = { ...process.env };

export interface TestEnvironment {
  REDIS_URL: string;
  REDIS_HOST: string;
  REDIS_PORT: string;
  NODE_ENV: string;
  LOG_LEVEL: string;
  [key: string]: string;
}

const defaultTestEnv: TestEnvironment = {
  REDIS_URL: 'redis://localhost:6379',
  REDIS_HOST: 'localhost',
  REDIS_PORT: '6379',
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  ETHEREUM_RPC_URL: 'https://test.infura.io/v3/test',
  ETHEREUM_WS_URL: 'wss://test.infura.io/ws/v3/test',
  ARBITRUM_RPC_URL: 'https://arb.test/rpc',
  ARBITRUM_WS_URL: 'wss://arb.test/feed',
  BSC_RPC_URL: 'https://bsc.test/rpc',
  BSC_WS_URL: 'wss://bsc.test/feed',
  POLYGON_RPC_URL: 'https://polygon.test/rpc',
  POLYGON_WS_URL: 'wss://polygon.test/feed',
  OPTIMISM_RPC_URL: 'https://optimism.test/rpc',
  OPTIMISM_WS_URL: 'wss://optimism.test/feed',
  BASE_RPC_URL: 'https://base.test/rpc',
  BASE_WS_URL: 'wss://base.test/feed'
};

export function setupTestEnv(overrides: Partial<TestEnvironment> = {}): void {
  Object.assign(process.env, defaultTestEnv, overrides);
}

export function restoreEnv(): void {
  // Clear all test env vars
  for (const key of Object.keys(defaultTestEnv)) {
    delete process.env[key];
  }
  // Restore original
  Object.assign(process.env, originalEnv);
}

export function withEnv<T>(
  envOverrides: Partial<TestEnvironment>,
  fn: () => T | Promise<T>
): Promise<T> {
  const backup = { ...process.env };
  setupTestEnv(envOverrides);
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.finally(() => {
        Object.assign(process.env, backup);
      });
    }
    Object.assign(process.env, backup);
    return Promise.resolve(result);
  } catch (error) {
    Object.assign(process.env, backup);
    throw error;
  }
}
```

### 4. Singleton Reset Helper

```typescript
// shared/test-utils/src/setup/singleton-reset.ts
type ResetFunction = () => void | Promise<void>;

const registeredResets: Map<string, ResetFunction> = new Map();

export function registerSingletonReset(name: string, resetFn: ResetFunction): void {
  registeredResets.set(name, resetFn);
}

export async function resetAllSingletons(): Promise<void> {
  const resets = Array.from(registeredResets.values());
  await Promise.all(resets.map(async (reset) => {
    try {
      await reset();
    } catch {
      // Ignore reset errors in tests
    }
  }));
}

// Pre-register known singletons
import {
  resetRedisInstance,
  resetRedisStreamsInstance,
  resetSwapEventFilter,
  resetPriceMatrix,
  resetPriceOracle,
  resetDistributedLockManager,
  resetStreamHealthMonitor,
  resetCrossRegionHealthManager,
  resetCacheCoherencyManager,
  resetPairDiscoveryService,
  resetPairCacheService,
  resetNonceManager
} from '@arbitrage/core';

registerSingletonReset('redis', resetRedisInstance);
registerSingletonReset('redisStreams', resetRedisStreamsInstance);
registerSingletonReset('swapEventFilter', resetSwapEventFilter);
registerSingletonReset('priceMatrix', resetPriceMatrix);
registerSingletonReset('priceOracle', resetPriceOracle);
registerSingletonReset('distributedLock', resetDistributedLockManager);
registerSingletonReset('streamHealth', resetStreamHealthMonitor);
registerSingletonReset('crossRegionHealth', resetCrossRegionHealthManager);
registerSingletonReset('cacheCoherency', resetCacheCoherencyManager);
registerSingletonReset('pairDiscovery', resetPairDiscoveryService);
registerSingletonReset('pairCache', resetPairCacheService);
registerSingletonReset('nonceManager', resetNonceManager);
```

### 5. Jest Setup File

```typescript
// shared/test-utils/src/setup/jest-setup.ts
import '@jest/globals';
import { setupTestEnv, restoreEnv } from './env-setup';
import { resetAllSingletons } from './singleton-reset';
import { resetSwapEventFactory } from '../factories/swap-event.factory';

// Setup test environment before all tests
beforeAll(() => {
  setupTestEnv();
});

// Reset state before each test
beforeEach(async () => {
  // Reset factories
  resetSwapEventFactory();
});

// Cleanup after each test
afterEach(async () => {
  // Reset all singletons to prevent test interference
  await resetAllSingletons();
});

// Restore environment after all tests
afterAll(() => {
  restoreEnv();
});

// Increase timeout for debugging
if (process.env.DEBUG_TESTS) {
  jest.setTimeout(300000);
}

// Custom matchers
expect.extend({
  toBeWithinRange(received: number, floor: number, ceiling: number) {
    const pass = received >= floor && received <= ceiling;
    return {
      pass,
      message: () =>
        pass
          ? `expected ${received} not to be within range ${floor} - ${ceiling}`
          : `expected ${received} to be within range ${floor} - ${ceiling}`
    };
  },

  toBeValidAddress(received: string) {
    const pass = /^0x[a-fA-F0-9]{40}$/.test(received);
    return {
      pass,
      message: () =>
        pass
          ? `expected ${received} not to be a valid address`
          : `expected ${received} to be a valid address`
    };
  }
});

// Type declarations for custom matchers
declare global {
  namespace jest {
    interface Matchers<R> {
      toBeWithinRange(floor: number, ceiling: number): R;
      toBeValidAddress(): R;
    }
  }
}
```

---

## Import Best Practices

### Rule 1: Use Package Aliases for Cross-Package Imports

```typescript
// ✅ Good - Package alias (stable, refactor-safe)
import { SwapEventFilter, resetSwapEventFilter } from '@arbitrage/core';
import { createSwapEvent, swapEvent } from '@arbitrage/test-utils';

// ❌ Bad - Relative paths across packages
import { SwapEventFilter } from '../../../shared/core/src/swap-event-filter';
```

### Rule 2: Use Relative Imports for Same-Package

```typescript
// ✅ Good - Same package relative import
import { ServiceState } from './service-state';

// ❌ Bad - Package alias for same package
import { ServiceState } from '@arbitrage/core';
```

### Rule 3: Test Files Import from Package Index

```typescript
// ✅ Good - Import from package index
import {
  SwapEventFilter,
  FilterResult,
  resetSwapEventFilter
} from '@arbitrage/core';

// ❌ Bad - Import from internal files
import { SwapEventFilter } from '@arbitrage/core/swap-event-filter';
```

### Rule 4: Test Utilities in Separate Package

```typescript
// ✅ Good - Test utils in dedicated package
import { createSwapEvent, RedisMock } from '@arbitrage/test-utils';

// ❌ Bad - Test utils mixed with production code
import { createSwapEvent } from '@arbitrage/core/test-helpers';
```

---

## Test Organization Guidelines

### Unit Tests
- Co-located in `__tests__/unit/` directories
- Test single module in isolation
- Mock all external dependencies
- Fast execution (<100ms per test)
- No network or file system access

### Integration Tests
- Located in `__tests__/integration/` or `tests/integration/`
- Test multiple modules together
- May use real Redis (via test server)
- Moderate execution time (<5s per test)
- May require setup/teardown

### E2E Tests
- Located in `tests/e2e/`
- Test full system flows
- Use real or near-real infrastructure
- Longer execution time acceptable
- Run separately in CI/CD

### Performance Tests
- Located in `tests/performance/`
- Benchmark critical paths
- Track metrics over time
- Run in consistent environment

---

## Migration Path

### Phase 1: Infrastructure Setup (Week 1)
1. Create `jest.config.base.js`
2. Refactor test-utils package with new structure
3. Create unified mock implementations
4. Add factory pattern implementations

### Phase 2: Test Migration (Week 2-3)
1. Move unit tests to `__tests__/unit/`
2. Update imports to use package aliases
3. Replace inline mocks with unified mocks
4. Add missing factory usage

### Phase 3: CI/CD Integration (Week 4)
1. Update test commands in package.json
2. Add test categorization to CI
3. Implement coverage gates
4. Add performance regression checks

---

## NPM Scripts Update

```json
{
  "scripts": {
    "test": "jest",
    "test:unit": "jest --selectProjects unit",
    "test:integration": "jest --selectProjects integration",
    "test:e2e": "jest --selectProjects e2e",
    "test:watch": "jest --watch",
    "test:coverage": "jest --coverage",
    "test:ci": "jest --ci --coverage --reporters=default --reporters=jest-junit",
    "test:debug": "DEBUG_TESTS=true jest --runInBand"
  }
}
```

---

## Benefits of New Architecture

1. **Reduced Duplication**: Single source of truth for mocks and factories
2. **Better Test Isolation**: Automatic singleton reset, environment isolation
3. **Faster Development**: Builder pattern for test data creation
4. **Clear Organization**: Unit/integration/e2e separation
5. **Maintainable Imports**: Package aliases prevent circular dependencies
6. **CI/CD Ready**: Test categories for parallel execution
7. **Type Safety**: Full TypeScript support in test utilities
