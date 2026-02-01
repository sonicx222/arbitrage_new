/**
 * Circuit Breaker API Endpoint Tests
 *
 * Phase 1.3.2: Add API endpoint to expose circuit breaker controls
 *
 * Tests for:
 * - GET /circuit-breaker - Get status
 * - POST /circuit-breaker/close - Force close
 * - POST /circuit-breaker/open - Force open
 *
 * @see implementation_plan_v2.md Task 1.3.2
 */

import { jest, describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { createServer, Server } from 'http';
import type { CircuitBreakerStatus } from '../services/circuit-breaker';
import type { CircuitBreakerEngineInterface } from './circuit-breaker-api';

// =============================================================================
// Types
// =============================================================================

/**
 * Mock engine with properly typed Jest mock functions.
 * Fix: Added proper Jest Mock type imports for type safety.
 */
interface MockEngine extends CircuitBreakerEngineInterface {
  getCircuitBreakerStatus: Mock<() => CircuitBreakerStatus | null>;
  forceCloseCircuitBreaker: Mock<() => void>;
  forceOpenCircuitBreaker: Mock<(reason?: string) => void>;
  isCircuitBreakerOpen: Mock<() => boolean>;
}

// =============================================================================
// Helper Functions
// =============================================================================

const createMockEngine = (): MockEngine => {
  const engine: MockEngine = {
    getCircuitBreakerStatus: jest.fn<() => CircuitBreakerStatus | null>().mockReturnValue({
      state: 'CLOSED',
      enabled: true,
      consecutiveFailures: 0,
      cooldownRemaining: 0,
      lastStateChange: Date.now(),
      metrics: {
        totalFailures: 5,
        totalSuccesses: 100,
        timesTripped: 1,
        totalOpenTimeMs: 30000,
        lastTrippedAt: Date.now() - 60000,
      },
    }),
    forceCloseCircuitBreaker: jest.fn<() => void>(),
    forceOpenCircuitBreaker: jest.fn<(reason?: string) => void>(),
    isCircuitBreakerOpen: jest.fn<() => boolean>().mockReturnValue(false),
  };
  return engine;
};

/**
 * Make HTTP request to test server
 */
function makeRequest(
  server: Server,
  method: string,
  path: string,
  options: {
    body?: string;
    headers?: Record<string, string>;
  } = {}
): Promise<{ statusCode: number; body: any; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      reject(new Error('Server not listening'));
      return;
    }

    const http = require('http');
    const req = http.request(
      {
        hostname: 'localhost',
        port: address.port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      },
      (res: any) => {
        let data = '';
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({
              statusCode: res.statusCode,
              body: data ? JSON.parse(data) : null,
              headers: res.headers,
            });
          } catch {
            resolve({
              statusCode: res.statusCode,
              body: data,
              headers: res.headers,
            });
          }
        });
      }
    );

    req.on('error', reject);

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

// =============================================================================
// Test Suite
// =============================================================================

describe('Circuit Breaker API Endpoints', () => {
  let server: Server;
  let mockEngine: MockEngine;
  let apiKey: string;

  // Import the handler after mocking
  let createCircuitBreakerApiHandler: typeof import('./circuit-breaker-api').createCircuitBreakerApiHandler;

  beforeAll(() => {
    // Set up test API key
    apiKey = 'test-api-key-123';
    process.env.CIRCUIT_BREAKER_API_KEY = apiKey;
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    mockEngine = createMockEngine();

    // Import the module
    const module = await import('./circuit-breaker-api');
    createCircuitBreakerApiHandler = module.createCircuitBreakerApiHandler;

    // Create test server
    const handler = createCircuitBreakerApiHandler(mockEngine as any);
    server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, resolve));
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  afterAll(() => {
    delete process.env.CIRCUIT_BREAKER_API_KEY;
  });

  // ===========================================================================
  // GET /circuit-breaker
  // ===========================================================================

  describe('GET /circuit-breaker', () => {
    it('should return circuit breaker status', async () => {
      const response = await makeRequest(server, 'GET', '/circuit-breaker');

      expect(response.statusCode).toBe(200);
      expect(response.body).toMatchObject({
        state: 'CLOSED',
        enabled: true,
        consecutiveFailures: 0,
        cooldownRemaining: 0,
      });
      expect(mockEngine.getCircuitBreakerStatus).toHaveBeenCalled();
    });

    it('should return 503 when circuit breaker is disabled', async () => {
      mockEngine.getCircuitBreakerStatus.mockReturnValue(null);

      const response = await makeRequest(server, 'GET', '/circuit-breaker');

      expect(response.statusCode).toBe(503);
      expect(response.body.error).toBe('Circuit breaker not available');
    });

    it('should include metrics in response', async () => {
      const response = await makeRequest(server, 'GET', '/circuit-breaker');

      expect(response.body.metrics).toMatchObject({
        totalFailures: 5,
        totalSuccesses: 100,
        timesTripped: 1,
      });
    });
  });

  // ===========================================================================
  // POST /circuit-breaker/close
  // ===========================================================================

  describe('POST /circuit-breaker/close', () => {
    it('should force close circuit breaker with valid API key', async () => {
      const response = await makeRequest(server, 'POST', '/circuit-breaker/close', {
        headers: { 'X-API-Key': apiKey },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain('closed');
      expect(mockEngine.forceCloseCircuitBreaker).toHaveBeenCalled();
    });

    it('should return 401 without API key', async () => {
      const response = await makeRequest(server, 'POST', '/circuit-breaker/close');

      expect(response.statusCode).toBe(401);
      expect(response.body.error).toBe('API key required');
      expect(mockEngine.forceCloseCircuitBreaker).not.toHaveBeenCalled();
    });

    it('should return 401 with invalid API key', async () => {
      const response = await makeRequest(server, 'POST', '/circuit-breaker/close', {
        headers: { 'X-API-Key': 'wrong-key' },
      });

      expect(response.statusCode).toBe(401);
      expect(response.body.error).toBe('Invalid API key');
      expect(mockEngine.forceCloseCircuitBreaker).not.toHaveBeenCalled();
    });

    it('should return 503 when circuit breaker is disabled', async () => {
      mockEngine.getCircuitBreakerStatus.mockReturnValue(null);

      const response = await makeRequest(server, 'POST', '/circuit-breaker/close', {
        headers: { 'X-API-Key': apiKey },
      });

      expect(response.statusCode).toBe(503);
      expect(response.body.error).toBe('Circuit breaker not available');
    });

    it('should return updated status after close', async () => {
      // Mock updated status after close
      mockEngine.getCircuitBreakerStatus
        .mockReturnValueOnce({ state: 'OPEN', enabled: true } as CircuitBreakerStatus)
        .mockReturnValueOnce({ state: 'CLOSED', enabled: true } as CircuitBreakerStatus);

      const response = await makeRequest(server, 'POST', '/circuit-breaker/close', {
        headers: { 'X-API-Key': apiKey },
      });

      expect(response.body.status.state).toBe('CLOSED');
    });
  });

  // ===========================================================================
  // POST /circuit-breaker/open
  // ===========================================================================

  describe('POST /circuit-breaker/open', () => {
    it('should force open circuit breaker with valid API key', async () => {
      mockEngine.getCircuitBreakerStatus.mockReturnValue({
        state: 'OPEN',
        enabled: true,
      } as CircuitBreakerStatus);

      const response = await makeRequest(server, 'POST', '/circuit-breaker/open', {
        headers: { 'X-API-Key': apiKey },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain('opened');
      expect(mockEngine.forceOpenCircuitBreaker).toHaveBeenCalled();
    });

    it('should accept custom reason in body', async () => {
      const response = await makeRequest(server, 'POST', '/circuit-breaker/open', {
        headers: { 'X-API-Key': apiKey },
        body: JSON.stringify({ reason: 'maintenance' }),
      });

      expect(response.statusCode).toBe(200);
      expect(mockEngine.forceOpenCircuitBreaker).toHaveBeenCalledWith('maintenance');
    });

    it('should use default reason if not provided', async () => {
      const response = await makeRequest(server, 'POST', '/circuit-breaker/open', {
        headers: { 'X-API-Key': apiKey },
      });

      expect(response.statusCode).toBe(200);
      expect(mockEngine.forceOpenCircuitBreaker).toHaveBeenCalledWith('API manual override');
    });

    it('should return 401 without API key', async () => {
      const response = await makeRequest(server, 'POST', '/circuit-breaker/open');

      expect(response.statusCode).toBe(401);
      expect(mockEngine.forceOpenCircuitBreaker).not.toHaveBeenCalled();
    });

    it('should return 503 when circuit breaker is disabled', async () => {
      mockEngine.getCircuitBreakerStatus.mockReturnValue(null);

      const response = await makeRequest(server, 'POST', '/circuit-breaker/open', {
        headers: { 'X-API-Key': apiKey },
      });

      expect(response.statusCode).toBe(503);
    });
  });

  // ===========================================================================
  // Error Handling
  // ===========================================================================

  describe('Error Handling', () => {
    it('should return 404 for unknown paths', async () => {
      const response = await makeRequest(server, 'GET', '/circuit-breaker/unknown');

      expect(response.statusCode).toBe(404);
      expect(response.body.error).toBe('Not found');
    });

    it('should return 405 for unsupported methods', async () => {
      const response = await makeRequest(server, 'DELETE', '/circuit-breaker');

      expect(response.statusCode).toBe(405);
      expect(response.body.error).toBe('Method not allowed');
    });

    it('should reject malformed JSON in body with 400 error', async () => {
      const response = await makeRequest(server, 'POST', '/circuit-breaker/open', {
        headers: { 'X-API-Key': apiKey },
        body: 'not-json',
      });

      // Should reject invalid JSON with 400 Bad Request
      expect(response.statusCode).toBe(400);
      expect(response.body.error).toContain('Invalid JSON');
      expect(mockEngine.forceOpenCircuitBreaker).not.toHaveBeenCalled();
    });

    it('should return 500 when handler throws an exception', async () => {
      mockEngine.getCircuitBreakerStatus.mockImplementation(() => {
        throw new Error('Database connection failed');
      });

      const response = await makeRequest(server, 'GET', '/circuit-breaker');

      expect(response.statusCode).toBe(500);
      expect(response.body.error).toContain('Internal server error');
      expect(response.body.error).toContain('Database connection failed');
    });
  });

  // ===========================================================================
  // Security
  // ===========================================================================

  describe('Security', () => {
    it('should not require API key for GET requests', async () => {
      const response = await makeRequest(server, 'GET', '/circuit-breaker');

      expect(response.statusCode).toBe(200);
    });

    it('should require API key for all POST requests', async () => {
      const closeResponse = await makeRequest(server, 'POST', '/circuit-breaker/close');
      const openResponse = await makeRequest(server, 'POST', '/circuit-breaker/open');

      expect(closeResponse.statusCode).toBe(401);
      expect(openResponse.statusCode).toBe(401);
    });

    it('should accept API key in Authorization header as Bearer token', async () => {
      const response = await makeRequest(server, 'POST', '/circuit-breaker/close', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      expect(response.statusCode).toBe(200);
    });

    it('should return 401 when API key is not configured on server', async () => {
      // Close the existing server
      await new Promise<void>((resolve) => server.close(() => resolve()));

      // Temporarily remove the API key from env
      const originalKey = process.env.CIRCUIT_BREAKER_API_KEY;
      delete process.env.CIRCUIT_BREAKER_API_KEY;

      try {
        // Create a new server without API key configured
        const unconfiguredMockEngine = createMockEngine();
        const module = await import('./circuit-breaker-api');
        const handler = module.createCircuitBreakerApiHandler(unconfiguredMockEngine as any);
        const unconfiguredServer = createServer(handler);
        await new Promise<void>((resolve) => unconfiguredServer.listen(0, resolve));

        try {
          // Try to POST with any API key - should fail because server has no key configured
          const response = await makeRequest(unconfiguredServer, 'POST', '/circuit-breaker/close', {
            headers: { 'X-API-Key': 'any-key' },
          });

          expect(response.statusCode).toBe(401);
          expect(response.body.error).toBe('API key not configured on server');
        } finally {
          await new Promise<void>((resolve) => unconfiguredServer.close(() => resolve()));
        }
      } finally {
        // Restore the API key
        process.env.CIRCUIT_BREAKER_API_KEY = originalKey;

        // Recreate the main test server for subsequent tests
        const handler = createCircuitBreakerApiHandler(mockEngine as any);
        server = createServer(handler);
        await new Promise<void>((resolve) => server.listen(0, resolve));
      }
    });
  });
});
