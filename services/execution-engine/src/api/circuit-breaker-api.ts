/**
 * Circuit Breaker API Endpoints
 *
 * Phase 1.3.2: Add API endpoint to expose circuit breaker controls
 *
 * Provides HTTP endpoints for monitoring and controlling the circuit breaker:
 * - GET /circuit-breaker - Get current status
 * - POST /circuit-breaker/close - Force close (requires API key)
 * - POST /circuit-breaker/open - Force open (requires API key)
 *
 * Security:
 * - Read operations (GET) are public
 * - Write operations (POST) require API key via X-API-Key header or Bearer token
 *
 * Environment:
 * - CIRCUIT_BREAKER_API_KEY: Required for POST operations
 *
 * @see implementation_plan_v2.md Task 1.3.2
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { timingSafeEqual, createHash } from 'crypto';
import type { CircuitBreakerStatus } from '../services/circuit-breaker';

// =============================================================================
// Types
// =============================================================================

/**
 * Engine interface for circuit breaker operations
 */
export interface CircuitBreakerEngineInterface {
  getCircuitBreakerStatus(): CircuitBreakerStatus | null;
  forceCloseCircuitBreaker(): void;
  forceOpenCircuitBreaker(reason?: string): void;
  isCircuitBreakerOpen(): boolean;
}

/**
 * API response types
 */
interface CircuitBreakerStatusResponse extends CircuitBreakerStatus {
  timestamp: number;
}

interface CircuitBreakerActionResponse {
  success: boolean;
  message: string;
  status: CircuitBreakerStatus | null;
  timestamp: number;
}

interface ErrorResponse {
  error: string;
  timestamp: number;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Extract API key from request headers
 */
function extractApiKey(req: IncomingMessage): string | null {
  // Check X-API-Key header first
  const xApiKey = req.headers['x-api-key'];
  if (xApiKey) {
    return Array.isArray(xApiKey) ? xApiKey[0] : xApiKey;
  }

  // Check Authorization header for Bearer token
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  return null;
}

/**
 * Timing-safe string comparison to prevent timing attacks.
 *
 * Fix: Uses crypto.timingSafeEqual to prevent attackers from discovering
 * the API key character by character through response time analysis.
 *
 * @param a - First string to compare
 * @param b - Second string to compare
 * @returns true if strings are equal
 */
function timingSafeCompare(a: string, b: string): boolean {
  // Hash both inputs with SHA-256 to normalize length before comparison.
  // This prevents leaking key length via buffer size differences.
  const aHash = createHash('sha256').update(a).digest();
  const bHash = createHash('sha256').update(b).digest();
  return timingSafeEqual(aHash, bHash);
}

/**
 * Validate API key for protected endpoints.
 *
 * Security: Uses timing-safe comparison to prevent timing attacks.
 */
function validateApiKey(apiKey: string | null): { valid: boolean; error?: string } {
  const expectedKey = process.env.CIRCUIT_BREAKER_API_KEY;

  if (!apiKey) {
    return { valid: false, error: 'API key required' };
  }

  if (!expectedKey) {
    // If no API key is configured, reject all requests for safety
    return { valid: false, error: 'API key not configured on server' };
  }

  // Fix: Use timing-safe comparison to prevent timing attacks
  if (!timingSafeCompare(apiKey, expectedKey)) {
    return { valid: false, error: 'Invalid API key' };
  }

  return { valid: true };
}

/**
 * Send JSON response
 */
function sendJson(res: ServerResponse, statusCode: number, data: object): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * Result type for parseBody to distinguish between success and parse failure
 */
interface ParseBodyResult {
  success: boolean;
  data: Record<string, any>;
  error?: string;
}

/**
 * Parse request body as JSON.
 * Returns a result object indicating success/failure instead of silently swallowing errors.
 */
async function parseBody(req: IncomingMessage): Promise<ParseBodyResult> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('error', (err) => {
      resolve({ success: false, data: {}, error: `Request error: ${err.message}` });
    });
    req.on('end', () => {
      // Empty body is valid - return empty object
      if (!body || body.trim() === '') {
        resolve({ success: true, data: {} });
        return;
      }

      try {
        const parsed = JSON.parse(body);
        resolve({ success: true, data: parsed });
      } catch (err) {
        resolve({
          success: false,
          data: {},
          error: `Invalid JSON: ${err instanceof Error ? err.message : 'parse error'}`
        });
      }
    });
  });
}

// =============================================================================
// Request Handlers
// =============================================================================

/**
 * Handle GET /circuit-breaker - Get status
 *
 * Performance: Caches timestamp at handler start for consistent responses.
 */
function handleGetStatus(
  engine: CircuitBreakerEngineInterface,
  res: ServerResponse
): void {
  // Performance: Cache timestamp at handler start
  const timestamp = Date.now();
  const status = engine.getCircuitBreakerStatus();

  if (!status) {
    sendJson(res, 503, {
      error: 'Circuit breaker not available',
      timestamp,
    } as ErrorResponse);
    return;
  }

  sendJson(res, 200, {
    ...status,
    timestamp,
  } as CircuitBreakerStatusResponse);
}

/**
 * Handle POST /circuit-breaker/close - Force close
 *
 * Fix: Now drains request body for consistency with handleForceOpen
 * and to prevent connection issues if client sends unexpected body.
 */
async function handleForceClose(
  engine: CircuitBreakerEngineInterface,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  // Performance: Cache timestamp at handler start for consistent responses
  const timestamp = Date.now();

  // Validate API key
  const apiKey = extractApiKey(req);
  const validation = validateApiKey(apiKey);

  if (!validation.valid) {
    // Fix: Drain request body before responding to prevent connection issues
    await parseBody(req);
    sendJson(res, 401, {
      error: validation.error!,
      timestamp,
    } as ErrorResponse);
    return;
  }

  // Check if circuit breaker is available
  const statusBefore = engine.getCircuitBreakerStatus();
  if (!statusBefore) {
    await parseBody(req);
    sendJson(res, 503, {
      error: 'Circuit breaker not available',
      timestamp,
    } as ErrorResponse);
    return;
  }

  // Fix: Drain request body for consistency (ignore any body content)
  await parseBody(req);

  // Force close
  engine.forceCloseCircuitBreaker();

  // Get updated status
  const statusAfter = engine.getCircuitBreakerStatus();

  sendJson(res, 200, {
    success: true,
    message: 'Circuit breaker force closed',
    status: statusAfter,
    timestamp,
  } as CircuitBreakerActionResponse);
}

/**
 * Handle POST /circuit-breaker/open - Force open
 *
 * Performance: Caches timestamp at handler start for consistent responses.
 */
async function handleForceOpen(
  engine: CircuitBreakerEngineInterface,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  // Performance: Cache timestamp at handler start for consistent responses
  const timestamp = Date.now();

  // Validate API key
  const apiKey = extractApiKey(req);
  const validation = validateApiKey(apiKey);

  if (!validation.valid) {
    // Drain request body before responding
    await parseBody(req);
    sendJson(res, 401, {
      error: validation.error!,
      timestamp,
    } as ErrorResponse);
    return;
  }

  // Check if circuit breaker is available
  const statusBefore = engine.getCircuitBreakerStatus();
  if (!statusBefore) {
    await parseBody(req);
    sendJson(res, 503, {
      error: 'Circuit breaker not available',
      timestamp,
    } as ErrorResponse);
    return;
  }

  // Parse body for optional reason
  const parseResult = await parseBody(req);
  if (!parseResult.success) {
    sendJson(res, 400, {
      error: parseResult.error || 'Invalid request body',
      timestamp,
    } as ErrorResponse);
    return;
  }

  const reason = parseResult.data.reason || 'API manual override';

  // Force open
  engine.forceOpenCircuitBreaker(reason);

  // Get updated status
  const statusAfter = engine.getCircuitBreakerStatus();

  sendJson(res, 200, {
    success: true,
    message: `Circuit breaker force opened: ${reason}`,
    status: statusAfter,
    timestamp,
  } as CircuitBreakerActionResponse);
}

// =============================================================================
// Main Handler Factory
// =============================================================================

/**
 * Create HTTP request handler for circuit breaker API endpoints
 *
 * @param engine - Execution engine instance with circuit breaker methods
 * @returns Request handler function for HTTP server
 *
 * Performance: Timestamps are cached at the start of each request
 * for consistent responses and reduced Date.now() calls.
 */
export function createCircuitBreakerApiHandler(
  engine: CircuitBreakerEngineInterface
): (req: IncomingMessage, res: ServerResponse) => void {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || '';
    const method = req.method || 'GET';
    // Performance: Cache timestamp at request start for error responses
    const timestamp = Date.now();

    try {
      // Route: GET /circuit-breaker
      if (url === '/circuit-breaker' && method === 'GET') {
        handleGetStatus(engine, res);
        return;
      }

      // Route: POST /circuit-breaker/close
      if (url === '/circuit-breaker/close' && method === 'POST') {
        await handleForceClose(engine, req, res);
        return;
      }

      // Route: POST /circuit-breaker/open
      if (url === '/circuit-breaker/open' && method === 'POST') {
        await handleForceOpen(engine, req, res);
        return;
      }

      // Check if path matches circuit-breaker routes
      if (url.startsWith('/circuit-breaker')) {
        // Path exists but method not supported
        if (url === '/circuit-breaker' || url === '/circuit-breaker/close' || url === '/circuit-breaker/open') {
          sendJson(res, 405, {
            error: 'Method not allowed',
            timestamp,
          } as ErrorResponse);
          return;
        }

        // Unknown path under /circuit-breaker
        sendJson(res, 404, {
          error: 'Not found',
          timestamp,
        } as ErrorResponse);
        return;
      }

      // Pass through to next handler (404 for unhandled)
      sendJson(res, 404, {
        error: 'Not found',
        timestamp,
      } as ErrorResponse);
    } catch (error) {
      sendJson(res, 500, {
        error: `Internal server error: ${error instanceof Error ? error.message : 'unknown'}`,
        timestamp,
      } as ErrorResponse);
    }
  };
}

// =============================================================================
// Helper for integrating with existing health server
// =============================================================================

/**
 * Check if request should be handled by circuit breaker API
 */
export function isCircuitBreakerRoute(url: string): boolean {
  return url.startsWith('/circuit-breaker');
}
