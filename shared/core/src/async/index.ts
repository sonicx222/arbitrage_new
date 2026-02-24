/**
 * Async Module
 *
 * Concurrency and async utilities including:
 * - AsyncSingleton: Singleton factory pattern (P1-3-FIX)
 * - AsyncMutex: Named mutual exclusion (P2-2-FIX)
 * - AsyncUtils: Timeout, retry, concurrent mapping (REF-4/ARCH-3)
 * - WorkerPool: Priority queue with worker threads
 *
 * @module async
 */

// Async Singleton (P1-3-FIX)
export {
  createAsyncSingleton,
  createSingleton,
  createConfigurableSingleton,  // P1-FIX: For singletons needing config on first init
  singleton
} from './async-singleton';

// Async Mutex (P2-2-FIX)
export {
  AsyncMutex,
  namedMutex,
  clearNamedMutex,
  clearAllNamedMutexes
} from './async-mutex';
export type { MutexStats } from './async-mutex';

// Async Utils (REF-4/ARCH-3)
export {
  TimeoutError,
  withTimeout,
  withTimeoutDefault,
  withTimeoutSafe,
  withRetry,
  sleep,
  createDeferred,
  mapConcurrent,
  mapSequential,
  debounceAsync,
  throttleAsync,
  gracefulShutdown,
  waitWithTimeouts
} from './async-utils';
export type {
  RetryConfig,
  Deferred
} from './async-utils';

// Worker Pool
export {
  EventProcessingWorkerPool,
  getWorkerPool,
  resetWorkerPool,  // BUG-1 FIX: Added singleton reset function
  PriorityQueue
} from './worker-pool';
export type {
  Task,
  TaskResult,
  // Phase 2: JSON Parsing Types
  JsonParseResult,
  BatchJsonParseResult,
  JsonParsingStats
} from './worker-pool';

// FIX 9.1: Queue Lock (shared pattern)
export {
  QueueLock,
  withLock,
  tryWithLock
} from './queue-lock';
export type { QueueLockStats } from './queue-lock';

// P1-5 FIX: Operation Guard (skip-if-busy pattern with rate limiting)
export {
  OperationGuard,
  tryWithGuard,
  tryWithGuardSync
} from './operation-guard';
export type { OperationGuardStats, OperationGuardConfig } from './operation-guard';

// R6: Service Registry (centralized singleton management)
export {
  ServiceRegistry,
  getServiceRegistry,
  resetServiceRegistry,
  registerService,
  getService
} from './service-registry';
export type {
  ServiceRegistration,
  RegisteredServiceHealth,
  RegistryHealth
} from './service-registry';

// Lifecycle Utilities (safe interval/timeout cleanup)
export {
  clearIntervalSafe,
  clearTimeoutSafe,
  stopAndNullify,
  setupParentPortListener
} from './lifecycle-utils';
export type { ParentPortListenerConfig } from './lifecycle-utils';

// Interval Manager (centralized interval management)
export {
  IntervalManager,
  createIntervalManager
} from './interval-manager';
export type {
  IntervalInfo,
  IntervalManagerStats
} from './interval-manager';

// Event Batching Infrastructure
export {
  EventBatcher,
  BatchedEvent,
  createEventBatcher,
  getDefaultEventBatcher,
  resetDefaultEventBatcher
} from './event-batcher';
// Note: event-processor-worker.ts is a worker script, not exported
