# @arbitrage/test-utils

Testing infrastructure providing mocks, factories, harnesses, and fixtures for unit, integration, and e2e tests across the monorepo.

## Key Exports

| Category | Exports |
|----------|---------|
| **Factories** (preferred) | `swapEvent()`, `priceUpdate()`, `createSwapBatch()` |
| **Mocks** | `RedisMock`, `createRedisMock()`, partition service mocks |
| **Setup** | `setupTestEnv()`, `resetAllSingletons()` |
| **Redis Helpers** | `createTestRedisClient()`, `flushTestRedis()`, `waitForStreamMessage()` |
| **Harnesses** | `IntegrationTestHarness`, cache/worker/load test harnesses |
| **Fixtures** | `CacheFixtures`, `CacheStateConfig`, performance fixtures |
| **Builders** | `CacheStateBuilder` (fluent API) |
| **Integration** | `createIsolatedContext()`, `withIsolation()`, `createParallelContexts()` |
| **Test Data** | `TEST_TOKENS`, `TEST_PAIRS` |

## Usage

```typescript
import { createTestRedisClient, swapEvent, priceUpdate } from '@arbitrage/test-utils';

const redis = await createTestRedisClient();
const event = swapEvent({ chainId: 'bsc', dexId: 'pancakeswap-v2' });
```

## Notes

- Integration tests must run with `--maxWorkers=1` (serial) to prevent Redis key collisions
- Auto-loads Redis test config from `.redis-test-config.json` (created by jest.globalSetup.ts)
- Legacy helpers (`createMockPriceUpdate`, `delay`) still supported but factories preferred

## Dependencies

- `ioredis`
