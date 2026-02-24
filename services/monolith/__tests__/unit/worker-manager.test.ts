/**
 * Tests for Monolith Worker Manager
 *
 * @see Phase 2 Item #21: Oracle ARM monolith migration
 */

// =============================================================================
// Mocks — must be defined inside jest.mock factory (hoisted above imports)
// =============================================================================

// Store created mock workers for test assertions
const createdWorkers: any[] = [];

jest.mock('worker_threads', () => {
  // Import EventEmitter inside the factory closure (hoisted context)
  const { EventEmitter: EE } = require('events');

  class MockWorker extends EE {
    threadId: number;
    postMessage: jest.Mock;
    terminate: jest.Mock;
    ref: jest.Mock;
    unref: jest.Mock;
    scriptPath: string;
    options: any;

    constructor(scriptPath: string, options?: any) {
      super();
      this.scriptPath = scriptPath;
      this.options = options;
      this.threadId = Math.floor(Math.random() * 1000);
      this.postMessage = jest.fn();
      // terminate() emits 'exit' so stopWorker() resolves promptly
      this.terminate = jest.fn().mockImplementation(() => {
        process.nextTick(() => this.emit('exit', 0));
        return Promise.resolve(0);
      });
      this.ref = jest.fn();
      this.unref = jest.fn();
      createdWorkers.push(this);
    }
  }

  return {
    Worker: MockWorker,
    isMainThread: true,
  };
});

import { WorkerManager } from '../../src/worker-manager';
import type { ServiceWorkerConfig } from '../../src/worker-manager';

// =============================================================================
// Test Helpers
// =============================================================================

/** Short timeout so tests don't hang waiting for shutdown */
const TEST_SHUTDOWN_TIMEOUT_MS = 200;

function createTestServiceConfigs(): ServiceWorkerConfig[] {
  return [
    {
      name: 'test-service-1',
      scriptPath: '/path/to/service1/dist/index.js',
      env: { PORT: '3001', REDIS_URL: 'redis://localhost:6379' },
      autoRestart: true,
      maxRestarts: 3,
    },
    {
      name: 'test-service-2',
      scriptPath: '/path/to/service2/dist/index.js',
      env: { PORT: '3002', REDIS_URL: 'redis://localhost:6379' },
      autoRestart: false,
    },
  ];
}

// =============================================================================
// Tests
// =============================================================================

describe('WorkerManager', () => {
  let manager: WorkerManager;

  beforeEach(() => {
    createdWorkers.length = 0;
  });

  afterEach(async () => {
    if (manager) {
      await manager.stop();
    }
  });

  describe('constructor', () => {
    it('should create instance with service configs', () => {
      const buffer = new SharedArrayBuffer(1024);
      manager = new WorkerManager({
        services: createTestServiceConfigs(),
        priceMatrixBuffer: buffer,
        shutdownTimeoutMs: TEST_SHUTDOWN_TIMEOUT_MS,
      });

      expect(manager).toBeInstanceOf(WorkerManager);
    });

    it('should accept empty service list', () => {
      const buffer = new SharedArrayBuffer(1024);
      manager = new WorkerManager({
        services: [],
        priceMatrixBuffer: buffer,
        shutdownTimeoutMs: TEST_SHUTDOWN_TIMEOUT_MS,
      });

      expect(manager).toBeInstanceOf(WorkerManager);
    });
  });

  describe('getHealth', () => {
    it('should return unhealthy status when no workers are started', () => {
      const buffer = new SharedArrayBuffer(1024);
      manager = new WorkerManager({
        services: createTestServiceConfigs(),
        priceMatrixBuffer: buffer,
        shutdownTimeoutMs: TEST_SHUTDOWN_TIMEOUT_MS,
      });

      const health = manager.getHealth();
      expect(health.overall).toBe('unhealthy');
      expect(health.services).toBeDefined();
    });

    it('should report services in the health response', () => {
      const services = createTestServiceConfigs();
      const buffer = new SharedArrayBuffer(1024);
      manager = new WorkerManager({
        services,
        priceMatrixBuffer: buffer,
        shutdownTimeoutMs: TEST_SHUTDOWN_TIMEOUT_MS,
      });

      const health = manager.getHealth();
      expect(Object.keys(health.services)).toEqual(
        expect.arrayContaining(services.map(s => s.name))
      );
    });
  });

  describe('start', () => {
    it('should spawn worker threads for each service', async () => {
      const services = createTestServiceConfigs();
      const buffer = new SharedArrayBuffer(1024);

      manager = new WorkerManager({
        services,
        priceMatrixBuffer: buffer,
        shutdownTimeoutMs: TEST_SHUTDOWN_TIMEOUT_MS,
      });

      await manager.start();

      expect(createdWorkers.length).toBe(services.length);
    });

    it('should pass SharedArrayBuffer to workers via workerData', async () => {
      const buffer = new SharedArrayBuffer(1024);
      const services = [createTestServiceConfigs()[0]];

      manager = new WorkerManager({
        services,
        priceMatrixBuffer: buffer,
        shutdownTimeoutMs: TEST_SHUTDOWN_TIMEOUT_MS,
      });

      await manager.start();

      expect(createdWorkers.length).toBe(1);
      const worker = createdWorkers[0];
      expect(worker.options.workerData.priceMatrixBuffer).toBe(buffer);
    });

    it('should pass environment variables to workers', async () => {
      const services = [{
        name: 'env-test',
        scriptPath: '/path/to/service.js',
        env: { CUSTOM_VAR: 'test-value', PORT: '4000' },
      }];
      const buffer = new SharedArrayBuffer(1024);

      manager = new WorkerManager({
        services,
        priceMatrixBuffer: buffer,
        shutdownTimeoutMs: TEST_SHUTDOWN_TIMEOUT_MS,
      });

      await manager.start();

      expect(createdWorkers.length).toBe(1);
      const worker = createdWorkers[0];
      expect(worker.options.env.CUSTOM_VAR).toBe('test-value');
      expect(worker.options.env.PORT).toBe('4000');
    });

    it('should register event handlers on each worker', async () => {
      const services = [createTestServiceConfigs()[0]];
      const buffer = new SharedArrayBuffer(1024);

      manager = new WorkerManager({
        services,
        priceMatrixBuffer: buffer,
        shutdownTimeoutMs: TEST_SHUTDOWN_TIMEOUT_MS,
      });

      await manager.start();

      expect(createdWorkers.length).toBe(1);
      const worker = createdWorkers[0];
      expect(worker.listenerCount('error')).toBeGreaterThan(0);
      expect(worker.listenerCount('exit')).toBeGreaterThan(0);
      expect(worker.listenerCount('message')).toBeGreaterThan(0);
    });
  });

  describe('stop', () => {
    it('should terminate all workers', async () => {
      const services = createTestServiceConfigs();
      const buffer = new SharedArrayBuffer(1024);

      manager = new WorkerManager({
        services,
        priceMatrixBuffer: buffer,
        shutdownTimeoutMs: TEST_SHUTDOWN_TIMEOUT_MS,
      });

      await manager.start();
      await manager.stop();

      for (const worker of createdWorkers) {
        expect(worker.terminate).toHaveBeenCalled();
      }
    });

    it('should be safe to call stop without start', async () => {
      const buffer = new SharedArrayBuffer(1024);
      manager = new WorkerManager({
        services: createTestServiceConfigs(),
        priceMatrixBuffer: buffer,
        shutdownTimeoutMs: TEST_SHUTDOWN_TIMEOUT_MS,
      });

      await expect(manager.stop()).resolves.not.toThrow();
    });

    it('should be idempotent (safe to call twice)', async () => {
      const buffer = new SharedArrayBuffer(1024);
      manager = new WorkerManager({
        services: createTestServiceConfigs(),
        priceMatrixBuffer: buffer,
        shutdownTimeoutMs: TEST_SHUTDOWN_TIMEOUT_MS,
      });

      await manager.start();
      await manager.stop();
      await expect(manager.stop()).resolves.not.toThrow();
    });
  });

  describe('events', () => {
    it('should be an EventEmitter', () => {
      const buffer = new SharedArrayBuffer(1024);
      manager = new WorkerManager({
        services: [],
        priceMatrixBuffer: buffer,
        shutdownTimeoutMs: TEST_SHUTDOWN_TIMEOUT_MS,
      });

      expect(typeof manager.on).toBe('function');
      expect(typeof manager.emit).toBe('function');
      expect(typeof manager.removeAllListeners).toBe('function');
    });

    it('should emit workerError when a worker reports an error', async () => {
      const services = [createTestServiceConfigs()[0]];
      const buffer = new SharedArrayBuffer(1024);

      manager = new WorkerManager({
        services,
        priceMatrixBuffer: buffer,
        shutdownTimeoutMs: TEST_SHUTDOWN_TIMEOUT_MS,
      });

      const errorPromise = new Promise<{ name: string; error: Error }>(resolve => {
        manager.on('workerError', resolve);
      });

      await manager.start();

      expect(createdWorkers.length).toBe(1);
      const worker = createdWorkers[0];
      const testError = new Error('Worker crashed');
      worker.emit('error', testError);

      const event = await errorPromise;
      expect(event.name).toBe('test-service-1');
      expect(event.error).toBe(testError);
    });
  });

  describe('auto-restart', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should restart a worker after non-zero exit when autoRestart is true', async () => {
      const services = [{
        name: 'restartable',
        scriptPath: '/path/to/service.js',
        autoRestart: true,
        maxRestarts: 3,
        restartBackoffMs: 100,
      }];
      const buffer = new SharedArrayBuffer(1024);

      manager = new WorkerManager({
        services,
        priceMatrixBuffer: buffer,
        shutdownTimeoutMs: TEST_SHUTDOWN_TIMEOUT_MS,
      });

      await manager.start();
      expect(createdWorkers.length).toBe(1);

      // Simulate crash (non-zero exit)
      createdWorkers[0].emit('exit', 1);

      // Advance past the first backoff (100ms * 2^0 = 100ms)
      jest.advanceTimersByTime(150);
      // Allow the async spawnWorker to complete
      await Promise.resolve();
      await Promise.resolve();

      expect(createdWorkers.length).toBe(2);
    });

    it('should NOT restart a worker when autoRestart is false', async () => {
      const services = [{
        name: 'no-restart',
        scriptPath: '/path/to/service.js',
        autoRestart: false,
        maxRestarts: 3,
        restartBackoffMs: 100,
      }];
      const buffer = new SharedArrayBuffer(1024);

      manager = new WorkerManager({
        services,
        priceMatrixBuffer: buffer,
        shutdownTimeoutMs: TEST_SHUTDOWN_TIMEOUT_MS,
      });

      await manager.start();
      expect(createdWorkers.length).toBe(1);

      // Simulate crash
      createdWorkers[0].emit('exit', 1);

      jest.advanceTimersByTime(5000);
      await Promise.resolve();

      // No new worker should be created
      expect(createdWorkers.length).toBe(1);
    });

    it('should use exponential backoff for restarts', async () => {
      const services = [{
        name: 'backoff-test',
        scriptPath: '/path/to/service.js',
        autoRestart: true,
        maxRestarts: 5,
        restartBackoffMs: 100,
      }];
      const buffer = new SharedArrayBuffer(1024);

      manager = new WorkerManager({
        services,
        priceMatrixBuffer: buffer,
        shutdownTimeoutMs: TEST_SHUTDOWN_TIMEOUT_MS,
      });

      await manager.start();
      expect(createdWorkers.length).toBe(1);

      // First crash: backoff = 100ms * 2^0 = 100ms
      createdWorkers[0].emit('exit', 1);
      jest.advanceTimersByTime(50);
      await Promise.resolve();
      expect(createdWorkers.length).toBe(1); // Not yet restarted
      jest.advanceTimersByTime(60);
      await Promise.resolve();
      await Promise.resolve();
      expect(createdWorkers.length).toBe(2); // Restarted after 100ms

      // Second crash: backoff = 100ms * 2^1 = 200ms
      createdWorkers[1].emit('exit', 1);
      jest.advanceTimersByTime(150);
      await Promise.resolve();
      expect(createdWorkers.length).toBe(2); // Not yet restarted at 150ms
      jest.advanceTimersByTime(60);
      await Promise.resolve();
      await Promise.resolve();
      expect(createdWorkers.length).toBe(3); // Restarted after 200ms
    });

    it('should emit workerFailed when max restarts are exhausted', async () => {
      const services = [{
        name: 'exhausted',
        scriptPath: '/path/to/service.js',
        autoRestart: true,
        maxRestarts: 1,
        restartBackoffMs: 50,
      }];
      const buffer = new SharedArrayBuffer(1024);

      manager = new WorkerManager({
        services,
        priceMatrixBuffer: buffer,
        shutdownTimeoutMs: TEST_SHUTDOWN_TIMEOUT_MS,
      });

      const failedPromise = new Promise<{ name: string; restartCount: number }>(resolve => {
        manager.on('workerFailed', resolve);
      });

      await manager.start();
      expect(createdWorkers.length).toBe(1);

      // First crash: restartCount becomes 1 (== maxRestarts)
      createdWorkers[0].emit('exit', 1);
      jest.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();
      expect(createdWorkers.length).toBe(2); // First restart succeeded

      // Second crash: restartCount (1) >= maxRestarts (1) → workerFailed
      createdWorkers[1].emit('exit', 1);

      const event = await failedPromise;
      expect(event.name).toBe('exhausted');
      expect(event.restartCount).toBe(1);
      // No new worker created after exhaustion
      jest.advanceTimersByTime(5000);
      await Promise.resolve();
      expect(createdWorkers.length).toBe(2);
    });

    it('should NOT restart workers during shutdown', async () => {
      const services = [{
        name: 'shutdown-test',
        scriptPath: '/path/to/service.js',
        autoRestart: true,
        maxRestarts: 5,
        restartBackoffMs: 50,
      }];
      const buffer = new SharedArrayBuffer(1024);

      manager = new WorkerManager({
        services,
        priceMatrixBuffer: buffer,
        shutdownTimeoutMs: TEST_SHUTDOWN_TIMEOUT_MS,
      });

      await manager.start();
      expect(createdWorkers.length).toBe(1);

      // Begin shutdown (don't await — stop() waits on an internal setTimeout
      // that requires fake timer advancement to fire)
      const stopPromise = manager.stop();

      // Advance past shutdown timeout so stopWorker's timeout triggers terminate()
      // which emits 'exit' via process.nextTick in the mock
      jest.advanceTimersByTime(TEST_SHUTDOWN_TIMEOUT_MS + 100);
      await Promise.resolve();
      await Promise.resolve();
      await stopPromise;

      // Advance further to confirm no restart timer fires
      jest.advanceTimersByTime(5000);
      await Promise.resolve();

      // No extra workers should be spawned during/after shutdown
      expect(createdWorkers.length).toBe(1);
    });

    it('should not restart on clean exit (code 0)', async () => {
      const services = [{
        name: 'clean-exit',
        scriptPath: '/path/to/service.js',
        autoRestart: true,
        maxRestarts: 3,
        restartBackoffMs: 50,
      }];
      const buffer = new SharedArrayBuffer(1024);

      manager = new WorkerManager({
        services,
        priceMatrixBuffer: buffer,
        shutdownTimeoutMs: TEST_SHUTDOWN_TIMEOUT_MS,
      });

      await manager.start();
      expect(createdWorkers.length).toBe(1);

      // Clean exit (code 0) should not trigger restart
      createdWorkers[0].emit('exit', 0);
      jest.advanceTimersByTime(5000);
      await Promise.resolve();

      expect(createdWorkers.length).toBe(1);
    });

    it('should report restart count in health status', async () => {
      const services = [{
        name: 'health-restart',
        scriptPath: '/path/to/service.js',
        autoRestart: true,
        maxRestarts: 3,
        restartBackoffMs: 50,
      }];
      const buffer = new SharedArrayBuffer(1024);

      manager = new WorkerManager({
        services,
        priceMatrixBuffer: buffer,
        shutdownTimeoutMs: TEST_SHUTDOWN_TIMEOUT_MS,
      });

      await manager.start();

      // Simulate a crash and restart
      createdWorkers[0].emit('exit', 1);
      jest.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();

      const health = manager.getHealth();
      expect(health.services['health-restart'].restarts).toBe(1);
    });
  });
});
