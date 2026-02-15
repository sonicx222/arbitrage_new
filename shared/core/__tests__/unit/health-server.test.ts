/**
 * Unit Tests for createPartitionHealthServer
 *
 * Tests HTTP endpoints, health cache TTL behavior, auth token handling,
 * server timeouts, and error responses.
 *
 * Moved from src/__tests__/unit/ to __tests__/unit/ per ADR-009 convention.
 *
 * @see shared/core/src/partition-service-utils.ts
 */

import http from 'http';
import { EventEmitter } from 'events';
import { createPartitionHealthServer } from '../../src/partition-service-utils';
import type { PartitionServiceConfig, PartitionDetectorInterface } from '../../src/partition-service-utils';

// =============================================================================
// Helpers
// =============================================================================

/** Makes an HTTP request and returns { statusCode, headers, body } */
function request(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {}
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: options.headers,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body,
          });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/** Creates a mock detector that implements PartitionDetectorInterface */
function createMockDetector(overrides: Partial<{
  running: boolean;
  healthStatus: string;
  partitionId: string;
  chains: string[];
  healthyChains: string[];
}> = {}): PartitionDetectorInterface {
  const running = overrides.running ?? true;
  const healthStatus = overrides.healthStatus ?? 'healthy';
  const partitionId = overrides.partitionId ?? 'test-partition';
  const chains = overrides.chains ?? ['bsc', 'polygon'];
  const healthyChains = overrides.healthyChains ?? (running ? [...chains] : []);

  const detector = new EventEmitter() as PartitionDetectorInterface;

  detector.isRunning = jest.fn().mockReturnValue(running);
  detector.getPartitionId = jest.fn().mockReturnValue(partitionId);
  detector.getChains = jest.fn().mockReturnValue([...chains]);
  detector.getHealthyChains = jest.fn().mockReturnValue([...healthyChains]);
  detector.getPartitionHealth = jest.fn().mockResolvedValue({
    status: healthStatus,
    partitionId,
    chainHealth: new Map(chains.map(c => [c, { status: 'healthy' }])),
    uptimeSeconds: 120,
    totalEventsProcessed: 500,
    memoryUsage: 100 * 1024 * 1024, // 100 MB
  });
  detector.getStats = jest.fn().mockReturnValue({
    partitionId,
    chains,
    totalEventsProcessed: 500,
    totalOpportunitiesFound: 10,
    uptimeSeconds: 120,
    memoryUsageMB: 100,
    chainStats: new Map(),
  });
  detector.start = jest.fn().mockResolvedValue(undefined);
  detector.stop = jest.fn().mockResolvedValue(undefined);

  return detector;
}

function createMockLogger() {
  return {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  } as any;
}

function createServiceConfig(overrides: Partial<PartitionServiceConfig> = {}): PartitionServiceConfig {
  return {
    partitionId: overrides.partitionId ?? 'test-partition',
    serviceName: overrides.serviceName ?? 'partition-test',
    defaultChains: overrides.defaultChains ?? ['bsc', 'polygon'],
    defaultPort: overrides.defaultPort ?? 0,
    region: overrides.region ?? 'us-east1',
    provider: overrides.provider ?? 'oracle',
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('createPartitionHealthServer', () => {
  let server: http.Server;
  let port: number;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
    // Clear env vars that tests may set
    delete process.env.HEALTH_AUTH_TOKEN;
    delete process.env.HEALTH_BIND_ADDRESS;
  });

  /** Helper to start server on a random port and return the actual port */
  async function startServer(options: {
    detector?: PartitionDetectorInterface;
    authToken?: string;
    healthCacheTtlMs?: number;
    config?: Partial<PartitionServiceConfig>;
  } = {}): Promise<number> {
    const detector = options.detector ?? createMockDetector();
    const logger = createMockLogger();
    const config = createServiceConfig(options.config);

    server = createPartitionHealthServer({
      port: 0, // Random available port
      config,
      detector,
      logger,
      authToken: options.authToken,
      bindAddress: '127.0.0.1',
      healthCacheTtlMs: options.healthCacheTtlMs,
    });

    // Wait for the server to start listening
    await new Promise<void>((resolve) => {
      server.on('listening', resolve);
    });

    const addr = server.address();
    if (typeof addr === 'object' && addr !== null) {
      return addr.port;
    }
    throw new Error('Server did not bind to a port');
  }

  // ---------------------------------------------------------------------------
  // GET /health
  // ---------------------------------------------------------------------------

  describe('GET /health', () => {
    it('should return 200 with health data when healthy', async () => {
      port = await startServer();

      const res = await request(port, '/health');
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(200);
      expect(body.service).toBe('partition-test');
      expect(body.status).toBe('healthy');
      expect(body.partitionId).toBe('test-partition');
      expect(body.region).toBe('us-east1');
      expect(body.uptime).toBe(120);
      expect(body.eventsProcessed).toBe(500);
      expect(body.memoryMB).toBe(100);
      expect(body.healthyChains).toEqual(['bsc', 'polygon']);
      expect(body.timestamp).toBeGreaterThan(0);
    });

    it('should return 503 when unhealthy', async () => {
      const detector = createMockDetector({ healthStatus: 'starting', running: false });
      port = await startServer({ detector });

      const res = await request(port, '/health');
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(503);
      expect(body.status).toBe('starting');
    });

    it('should return 200 when degraded', async () => {
      const detector = createMockDetector({ healthStatus: 'degraded' });
      port = await startServer({ detector });

      const res = await request(port, '/health');

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).status).toBe('degraded');
    });
  });

  // ---------------------------------------------------------------------------
  // GET /stats
  // ---------------------------------------------------------------------------

  describe('GET /stats', () => {
    it('should return 200 with stats when no auth token configured', async () => {
      port = await startServer();

      const res = await request(port, '/stats');
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(200);
      expect(body.service).toBe('partition-test');
      expect(body.partitionId).toBe('test-partition');
      expect(body.chains).toEqual(['bsc', 'polygon']);
      expect(body.totalEvents).toBe(500);
      expect(body.totalOpportunities).toBe(10);
      expect(body.uptimeSeconds).toBe(120);
      expect(body.memoryMB).toBe(100);
    });

    it('should return 401 when auth token required but not provided', async () => {
      port = await startServer({ authToken: 'secret-token' });

      const res = await request(port, '/stats');

      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).error).toBe('Unauthorized');
    });

    it('should return 401 when auth token is wrong', async () => {
      port = await startServer({ authToken: 'secret-token' });

      const res = await request(port, '/stats', {
        headers: { Authorization: 'Bearer wrong-token' },
      });

      expect(res.statusCode).toBe(401);
    });

    it('should return 200 when auth token is correct', async () => {
      port = await startServer({ authToken: 'secret-token' });

      const res = await request(port, '/stats', {
        headers: { Authorization: 'Bearer secret-token' },
      });
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(200);
      expect(body.partitionId).toBe('test-partition');
    });
  });

  // ---------------------------------------------------------------------------
  // GET /ready
  // ---------------------------------------------------------------------------

  describe('GET /ready', () => {
    it('should return 200 when running', async () => {
      const detector = createMockDetector({ running: true });
      port = await startServer({ detector });

      const res = await request(port, '/ready');
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(200);
      expect(body.ready).toBe(true);
      expect(body.chains).toEqual(['bsc', 'polygon']);
    });

    it('should return 503 when not running', async () => {
      const detector = createMockDetector({ running: false });
      port = await startServer({ detector });

      const res = await request(port, '/ready');
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(503);
      expect(body.ready).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /
  // ---------------------------------------------------------------------------

  describe('GET /', () => {
    it('should return 200 with service info', async () => {
      port = await startServer();

      const res = await request(port, '/');
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(200);
      expect(body.service).toBe('partition-test');
      expect(body.description).toContain('test-partition');
      expect(body.partitionId).toBe('test-partition');
      expect(body.chains).toEqual(['bsc', 'polygon']);
      expect(body.region).toBe('us-east1');
      expect(body.endpoints).toEqual(['/health', '/ready', '/stats']);
    });
  });

  // ---------------------------------------------------------------------------
  // Unknown routes and methods
  // ---------------------------------------------------------------------------

  describe('Unknown routes and methods', () => {
    it('should return 404 for unknown path', async () => {
      port = await startServer();

      const res = await request(port, '/unknown');

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error).toBe('Not found');
    });

    it('should return 405 for POST /health', async () => {
      port = await startServer();

      const res = await request(port, '/health', { method: 'POST' });

      expect(res.statusCode).toBe(405);
      expect(JSON.parse(res.body).error).toBe('Method Not Allowed');
      expect(res.headers.allow).toBe('GET');
    });
  });

  // ---------------------------------------------------------------------------
  // Server timeout configuration
  // ---------------------------------------------------------------------------

  describe('Server timeout configuration', () => {
    it('should set request timeout to 5000ms', async () => {
      port = await startServer();

      expect(server.requestTimeout).toBe(5000);
    });

    it('should set headers timeout to 3000ms', async () => {
      port = await startServer();

      expect(server.headersTimeout).toBe(3000);
    });

    it('should set keepAlive timeout to 5000ms', async () => {
      port = await startServer();

      expect(server.keepAliveTimeout).toBe(5000);
    });

    it('should set maxConnections to 100', async () => {
      port = await startServer();

      expect(server.maxConnections).toBe(100);
    });
  });

  // ---------------------------------------------------------------------------
  // Health cache behavior
  // ---------------------------------------------------------------------------

  describe('Health cache', () => {
    it('should cache health data within TTL', async () => {
      const detector = createMockDetector();
      port = await startServer({ detector, healthCacheTtlMs: 5000 });

      // First request - populates cache
      await request(port, '/health');
      expect(detector.getPartitionHealth).toHaveBeenCalledTimes(1);

      // Second request - should use cache
      await request(port, '/health');
      expect(detector.getPartitionHealth).toHaveBeenCalledTimes(1);
    });

    it('should refresh cache after TTL expires', async () => {
      const detector = createMockDetector();
      // Use a very short TTL for testing
      port = await startServer({ detector, healthCacheTtlMs: 50 });

      // First request
      await request(port, '/health');
      expect(detector.getPartitionHealth).toHaveBeenCalledTimes(1);

      // Wait for TTL to expire
      await new Promise(resolve => setTimeout(resolve, 100));

      // Second request - cache expired, should call again
      await request(port, '/health');
      expect(detector.getPartitionHealth).toHaveBeenCalledTimes(2);
    });

    it('should cache healthyChains alongside health data', async () => {
      const detector = createMockDetector({
        healthyChains: ['bsc'],
        chains: ['bsc', 'polygon'],
      });
      port = await startServer({ detector, healthCacheTtlMs: 5000 });

      // First request
      const res1 = await request(port, '/health');
      const body1 = JSON.parse(res1.body);
      expect(body1.healthyChains).toEqual(['bsc']);

      // Change detector's healthyChains (simulating disconnect)
      (detector.getHealthyChains as jest.Mock).mockReturnValue([]);

      // Second request - should use cached healthyChains, not live
      const res2 = await request(port, '/health');
      const body2 = JSON.parse(res2.body);
      expect(body2.healthyChains).toEqual(['bsc']);

      // Verify getHealthyChains was only called once (first request)
      expect(detector.getHealthyChains).toHaveBeenCalledTimes(1);
    });
  });
});
