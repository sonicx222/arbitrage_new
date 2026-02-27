/**
 * Monolith Service Entry Point
 *
 * Consolidates all arbitrage services into a single Node.js process
 * using worker threads. Designed for Oracle Cloud ARM (4 OCPU, 24GB)
 * to eliminate inter-service network latency and enable true shared memory.
 *
 * ## Architecture
 *
 * Main Thread (this file):
 * - Allocates SharedArrayBuffer for PriceMatrix
 * - Spawns worker threads for each service
 * - Runs unified health server (port 3100)
 * - Handles graceful shutdown of all workers
 *
 * Worker Threads (one per service):
 * - P1 (asia-fast): BSC, Polygon, Avalanche, Fantom (port 3001)
 * - P2 (l2-turbo): Arbitrum, Optimism, Base (port 3002)
 * - P3 (high-value): Ethereum, zkSync, Linea (port 3003)
 * - P4 (solana): Solana (port 3004)
 * - Coordinator: Opportunity routing (internal only)
 * - Execution Engine: Trade execution (port 3005)
 * - Cross-Chain Detector: Cross-chain opportunities (port 3006)
 *
 * ## Performance Benefits
 *
 * | Metric         | Distributed  | Monolith     | Improvement |
 * |----------------|-------------|--------------|-------------|
 * | Redis RTT      | 5-20ms      | <0.1ms       | 100x        |
 * | Cross-svc comm | 10-20ms     | <0.1ms       | 100x        |
 * | Price read     | 5-10ms      | <0.001ms     | 5000x       |
 * | Detection      | 40-60ms     | 11-25ms      | 2.5-3x      |
 *
 * ## Environment Variables
 *
 * - MONOLITH_REDIS_URL: Redis URL (localhost for self-hosted, default: redis://localhost:6379)
 * - MONOLITH_HEALTH_PORT: Unified health server port (default: 3100)
 * - MONOLITH_SHUTDOWN_TIMEOUT_MS: Graceful shutdown timeout (default: 30000)
 * - PRICE_MATRIX_SLOTS: Number of PriceMatrix slots (default: 1000)
 *
 * @see docs/reports/DEEP_ENHANCEMENT_ANALYSIS_2026-02-22.md Section 3.1
 * @see ADR-005: L1 Price Matrix with SharedArrayBuffer
 */

import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import * as os from 'os';
import * as path from 'path';
import { getErrorMessage } from '@arbitrage/core/resilience';
import { createLogger } from '@arbitrage/core';
import { WorkerManager, type ServiceWorkerConfig } from './worker-manager';

const logger = createLogger('monolith');

// =============================================================================
// Configuration
// =============================================================================

// FIX 5: Default to port 3100 to match .env.example and avoid conflict with Coordinator (port 3000)
const HEALTH_PORT = parseInt(process.env.MONOLITH_HEALTH_PORT ?? '3100', 10);
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.MONOLITH_SHUTDOWN_TIMEOUT_MS ?? '30000', 10);
const REDIS_URL = process.env.MONOLITH_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://localhost:6379';

/**
 * PriceMatrix SharedArrayBuffer allocation.
 *
 * Each slot = 16 bytes (8 bytes price + 4 bytes timestamp + 4 bytes sequence counter).
 * Default 1000 slots = 16 KB — trivial memory cost for zero-copy cross-thread reads.
 *
 * @see shared/core/src/caching/price-matrix.ts
 */
const PRICE_MATRIX_SLOTS = parseInt(process.env.PRICE_MATRIX_SLOTS ?? '1000', 10);
const BYTES_PER_SLOT = 16;

// =============================================================================
// Service Definitions
// =============================================================================

/**
 * Resolve compiled service entry point path.
 * Services are expected to be built to their respective dist/ directories.
 */
function resolveServicePath(serviceName: string): string {
  return path.resolve(__dirname, '..', '..', serviceName, 'dist', 'index.js');
}

/**
 * Build the service worker configurations.
 * Each service gets its own set of env vars (port, partition ID, etc.)
 * and shares the Redis URL and price matrix buffer.
 */
function buildServiceConfigs(): ServiceWorkerConfig[] {
  const services: ServiceWorkerConfig[] = [
    {
      name: 'coordinator',
      scriptPath: resolveServicePath('coordinator'),
      env: {
        // Fix #9: Coordinator's health server must not conflict with the monolith's
        // unified health server on the monolith port. Use a separate port for the coordinator
        // worker that doesn't conflict with the monolith health server (3100).
        HEALTH_CHECK_PORT: '3009',
        REDIS_URL,
      },
      autoRestart: true,
      maxRestarts: 5,
      restartBackoffMs: 2000,
    },
    {
      name: 'partition-asia-fast',
      scriptPath: resolveServicePath('partition-asia-fast'),
      env: {
        PARTITION_ID: 'asia-fast',
        HEALTH_CHECK_PORT: '3001',
        REDIS_URL,
      },
      autoRestart: true,
      maxRestarts: 5,
    },
    {
      name: 'partition-l2-turbo',
      scriptPath: resolveServicePath('partition-l2-turbo'),
      env: {
        PARTITION_ID: 'l2-turbo',
        HEALTH_CHECK_PORT: '3002',
        REDIS_URL,
      },
      autoRestart: true,
      maxRestarts: 5,
    },
    {
      name: 'partition-high-value',
      scriptPath: resolveServicePath('partition-high-value'),
      env: {
        PARTITION_ID: 'high-value',
        HEALTH_CHECK_PORT: '3003',
        REDIS_URL,
      },
      autoRestart: true,
      maxRestarts: 5,
    },
    {
      name: 'partition-solana',
      scriptPath: resolveServicePath('partition-solana'),
      env: {
        PARTITION_ID: 'solana-native',
        HEALTH_CHECK_PORT: '3004',
        REDIS_URL,
      },
      autoRestart: true,
      maxRestarts: 3,
    },
    {
      name: 'execution-engine',
      scriptPath: resolveServicePath('execution-engine'),
      env: {
        HEALTH_CHECK_PORT: '3005',
        REDIS_URL,
      },
      autoRestart: true,
      maxRestarts: 5,
      restartBackoffMs: 3000,
    },
    {
      name: 'cross-chain-detector',
      scriptPath: resolveServicePath('cross-chain-detector'),
      env: {
        HEALTH_CHECK_PORT: '3006',
        REDIS_URL,
      },
      autoRestart: true,
      maxRestarts: 5,
    },
  ];

  return services;
}

// =============================================================================
// Unified Health Server
// =============================================================================

let healthServer: Server | null = null;
let workerManager: WorkerManager | null = null;

function createUnifiedHealthServer(manager: WorkerManager): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/health' || req.url === '/') {
      const health = manager.getHealth();
      const statusCode = health.overall === 'healthy' ? 200 :
        health.overall === 'degraded' ? 200 : 503;

      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        service: 'monolith',
        status: health.overall,
        services: health.services,
        priceMatrixSlots: PRICE_MATRIX_SLOTS,
        memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        rssMemoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
        uptime: process.uptime(),
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
      }));
      return;
    }

    if (req.url === '/ready') {
      const health = manager.getHealth();
      const ready = health.overall !== 'unhealthy';
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ready, status: health.overall }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  // Fix R3: Handle server errors (EADDRINUSE, EACCES) that would otherwise
  // crash the monolith process with an unhandled exception.
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      logger.error(`Health server port ${HEALTH_PORT} is already in use`, { error: error.message });
    } else if (error.code === 'EACCES') {
      logger.error(`Health server port ${HEALTH_PORT} requires elevated privileges`, { error: error.message });
    } else {
      logger.error('Health server error', { error: error.message, code: error.code });
    }
    process.exit(1);
  });

  server.listen(HEALTH_PORT, () => {
    logger.info(`Unified health server listening on port ${HEALTH_PORT}`);
  });

  return server;
}

// =============================================================================
// Main Entry Point
// =============================================================================

async function main(): Promise<void> {
  logger.info('Starting Monolith Service', {
    priceMatrixSlots: PRICE_MATRIX_SLOTS,
    redisUrl: REDIS_URL.replace(/\/\/.*@/, '//***@'), // Redact credentials
    healthPort: HEALTH_PORT,
    shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
    freeMemoryMB: Math.round(os.freemem() / 1024 / 1024),
    cpus: os.cpus().length,
  });

  // Allocate SharedArrayBuffer for PriceMatrix
  const priceMatrixBuffer = new SharedArrayBuffer(PRICE_MATRIX_SLOTS * BYTES_PER_SLOT);
  logger.info('Allocated PriceMatrix SharedArrayBuffer', {
    slots: PRICE_MATRIX_SLOTS,
    bytes: priceMatrixBuffer.byteLength,
  });

  // Build service configurations
  const services = buildServiceConfigs();

  // Create worker manager
  workerManager = new WorkerManager({
    services,
    priceMatrixBuffer,
    shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
  });

  // Listen for worker events
  workerManager.on('workerError', ({ name, error }: { name: string; error: Error }) => {
    logger.error(`Service worker error: ${name}`, { error: error.message });
  });

  workerManager.on('workerFailed', ({ name, restartCount }: { name: string; restartCount: number }) => {
    logger.error(`Service worker failed permanently: ${name}`, { restartCount });
  });

  // Start unified health server
  healthServer = createUnifiedHealthServer(workerManager);

  // Start all workers
  await workerManager.start();

  logger.info('Monolith Service is running', {
    services: services.map(s => s.name),
    healthEndpoint: `http://localhost:${HEALTH_PORT}/health`,
  });

  // Graceful shutdown
  // FIX 4: Add reentrancy guard to prevent double-close from concurrent SIGINT+SIGTERM
  let isShuttingDown = false;
  const shutdown = async (signal: string) => {
    if (isShuttingDown) {
      logger.info(`Received ${signal} during shutdown, ignoring duplicate`);
      return;
    }
    isShuttingDown = true;

    logger.info(`Received ${signal}, shutting down monolith...`);

    if (workerManager) {
      await workerManager.stop();
    }

    if (healthServer) {
      await new Promise<void>((resolve) => {
        healthServer!.close(() => resolve());
      });
    }

    logger.info('Monolith shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// P0 Fix #36: Add exception handlers to prevent unhandled errors from killing all 7 services.
// Without these, a single unhandled promise rejection terminates the entire monolith.
process.on('uncaughtException', (error: Error) => {
  logger.error('Monolith uncaught exception', {
    error: error.message,
    stack: error.stack,
  });
  // Attempt graceful shutdown before exit
  if (workerManager) {
    workerManager.stop().catch(() => {}).finally(() => process.exit(1));
  } else {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason: unknown) => {
  logger.error('Monolith unhandled rejection', {
    reason: getErrorMessage(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
  // In Node 22, unhandled rejections throw uncaughtException by default.
  // Log here for observability; the uncaughtException handler will trigger exit.
});

main().catch((error) => {
  logger.error('Failed to start Monolith Service', {
    error: getErrorMessage(error),
  });
  process.exit(1);
});
