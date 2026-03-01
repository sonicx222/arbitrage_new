/**
 * HTTP/2 Session Pool for RPC Batch Calls
 *
 * Provides persistent HTTP/2 connections to RPC endpoints.
 * HTTP/2 multiplexing sends multiple requests over a single TCP connection,
 * eliminating the overhead of HTTP/1.1 connection setup per batch flush.
 *
 * Benefits:
 * - Single TCP connection per RPC endpoint (no connection pool overhead)
 * - Request multiplexing: concurrent requests share the connection
 * - Header compression (HPACK) reduces per-request overhead
 * - Reduced TLS handshakes (one per origin, not per connection)
 *
 * Usage:
 * ```typescript
 * const pool = new Http2SessionPool();
 * const response = await pool.request('https://rpc.example.com', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}',
 * });
 * ```
 *
 * @see docs/reports/DEEP_ENHANCEMENT_ANALYSIS_2026-02-22.md Section 6.3
 */

import * as http2 from 'http2';
import { createLogger } from '../logger';

const logger = createLogger('http2-session-pool');

/**
 * Configuration for the HTTP/2 session pool.
 */
export interface Http2SessionPoolConfig {
  /** Maximum idle time before closing a session (ms). Default: 60000 */
  maxIdleTimeMs?: number;
  /** Connection timeout (ms). Default: 10000 */
  connectTimeoutMs?: number;
  /** Maximum concurrent streams per session. Default: 100 */
  maxConcurrentStreams?: number;
  /** Enable ping keep-alive (ms interval, 0 to disable). Default: 30000 */
  pingIntervalMs?: number;
}

interface SessionEntry {
  session: http2.ClientHttp2Session;
  lastUsed: number;
  activeStreams: number;
  idleTimer: NodeJS.Timeout | null;
}

/** F3-FIX: Per-origin circuit breaker state to prevent infinite connection retries */
interface CircuitBreakerEntry {
  consecutiveFailures: number;
  /** Timestamp when the circuit breaker opens (rejects immediately until this time) */
  openUntil: number;
  /** Last time we logged an error for this origin (for log suppression) */
  lastLoggedAt: number;
}

/**
 * HTTP/2 Session Pool
 *
 * Manages persistent HTTP/2 sessions per origin (scheme + host + port).
 * Sessions are reused across requests and cleaned up after idle timeout.
 */
export class Http2SessionPool {
  private readonly sessions: Map<string, SessionEntry> = new Map();
  private readonly config: Required<Http2SessionPoolConfig>;
  private closed = false;
  /** F3-FIX: Per-origin circuit breaker to prevent connection retry floods */
  private readonly circuitBreakers: Map<string, CircuitBreakerEntry> = new Map();
  private static readonly CB_FAILURE_THRESHOLD = 5;
  private static readonly CB_INITIAL_COOLDOWN_MS = 30_000;
  private static readonly CB_MAX_COOLDOWN_MS = 300_000;
  /** Suppress repeated error logs — only log once per 30s per origin */
  private static readonly ERROR_LOG_INTERVAL_MS = 30_000;

  constructor(config?: Http2SessionPoolConfig) {
    this.config = {
      maxIdleTimeMs: config?.maxIdleTimeMs ?? 60000,
      connectTimeoutMs: config?.connectTimeoutMs ?? 10000,
      maxConcurrentStreams: config?.maxConcurrentStreams ?? 100,
      pingIntervalMs: config?.pingIntervalMs ?? 30000,
    };
  }

  /**
   * Send an HTTP/2 request to the given URL.
   *
   * @param url - Full URL of the RPC endpoint
   * @param options - Request options (method, headers, body)
   * @returns Response body as string
   * @throws Error on connection failure, HTTP error, or timeout
   */
  async request(
    url: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    }
  ): Promise<{ status: number; body: string }> {
    if (this.closed) {
      throw new Error('Http2SessionPool is closed');
    }

    const parsed = new URL(url);
    const origin = parsed.origin;
    const session = await this.getOrCreateSession(origin);

    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const entry = this.sessions.get(origin);
      if (entry) {
        entry.activeStreams++;
        entry.lastUsed = Date.now();
        this.resetIdleTimer(origin, entry);
      }

      const requestHeaders: http2.OutgoingHttpHeaders = {
        [http2.constants.HTTP2_HEADER_METHOD]: options.method ?? 'POST',
        [http2.constants.HTTP2_HEADER_PATH]: parsed.pathname + parsed.search,
        [http2.constants.HTTP2_HEADER_SCHEME]: parsed.protocol.replace(':', ''),
        [http2.constants.HTTP2_HEADER_AUTHORITY]: parsed.host,
        'content-type': 'application/json',
      };

      // Merge custom headers
      if (options.headers) {
        for (const [key, value] of Object.entries(options.headers)) {
          // Skip pseudo-headers and content-type (already set)
          if (!key.startsWith(':') && key.toLowerCase() !== 'content-type') {
            requestHeaders[key.toLowerCase()] = value;
          }
          // Allow overriding content-type
          if (key.toLowerCase() === 'content-type') {
            requestHeaders['content-type'] = value;
          }
        }
      }

      const stream = session.request(requestHeaders);

      let responseData = '';
      let status = 0;

      stream.on('response', (headers) => {
        status = Number(headers[http2.constants.HTTP2_HEADER_STATUS]) || 0;
      });

      stream.on('data', (chunk: Buffer) => {
        responseData += chunk.toString();
      });

      stream.on('end', () => {
        if (entry) entry.activeStreams = Math.max(0, entry.activeStreams - 1);
        resolve({ status, body: responseData });
      });

      stream.on('error', (err) => {
        if (entry) entry.activeStreams = Math.max(0, entry.activeStreams - 1);
        reject(new Error(`HTTP/2 stream error: ${err.message}`));
      });

      // Write body and end stream
      if (options.body) {
        stream.end(options.body);
      } else {
        stream.end();
      }
    });
  }

  /**
   * Get or create an HTTP/2 session for the given origin.
   */
  private async getOrCreateSession(origin: string): Promise<http2.ClientHttp2Session> {
    // F3-FIX: Check circuit breaker before attempting connection
    const cb = this.circuitBreakers.get(origin);
    if (cb && cb.openUntil > Date.now()) {
      throw new Error(`HTTP/2 circuit breaker open for ${origin} (${cb.consecutiveFailures} consecutive failures)`);
    }

    const existing = this.sessions.get(origin);
    if (existing && !existing.session.closed && !existing.session.destroyed) {
      // F3-FIX: Reset circuit breaker on successful session reuse
      if (cb) this.circuitBreakers.delete(origin);
      return existing.session;
    }

    // Clean up stale entry
    if (existing) {
      this.destroySession(origin, existing);
    }

    return new Promise<http2.ClientHttp2Session>((resolve, reject) => {
      const connectTimeout = setTimeout(() => {
        this.recordConnectionFailure(origin, 'connection timeout');
        reject(new Error(`HTTP/2 connection timeout to ${origin}`));
      }, this.config.connectTimeoutMs);

      const session = http2.connect(origin, {
        settings: {
          maxConcurrentStreams: this.config.maxConcurrentStreams,
        },
      });

      session.on('connect', () => {
        clearTimeout(connectTimeout);

        // F3-FIX: Reset circuit breaker on successful connection
        this.circuitBreakers.delete(origin);

        const entry: SessionEntry = {
          session,
          lastUsed: Date.now(),
          activeStreams: 0,
          idleTimer: null,
        };
        this.sessions.set(origin, entry);
        this.resetIdleTimer(origin, entry);

        logger.debug('HTTP/2 session established', { origin });
        resolve(session);
      });

      session.on('error', (err) => {
        clearTimeout(connectTimeout);
        this.recordConnectionFailure(origin, err.message);

        // Clean up the session
        const entry = this.sessions.get(origin);
        if (entry) {
          this.destroySession(origin, entry);
        }

        reject(new Error(`HTTP/2 connection error: ${err.message}`));
      });

      session.on('close', () => {
        logger.debug('HTTP/2 session closed', { origin });
        const entry = this.sessions.get(origin);
        if (entry) {
          if (entry.idleTimer) clearTimeout(entry.idleTimer);
          this.sessions.delete(origin);
        }
      });

      // Keep-alive pings
      if (this.config.pingIntervalMs > 0) {
        session.on('connect', () => {
          const pingInterval = setInterval(() => {
            if (session.closed || session.destroyed) {
              clearInterval(pingInterval);
              return;
            }
            session.ping(Buffer.alloc(8), (err) => {
              if (err) {
                logger.debug('HTTP/2 ping failed', { origin, error: err.message });
                clearInterval(pingInterval);
              }
            });
          }, this.config.pingIntervalMs);

          // Don't prevent process exit
          if (pingInterval.unref) pingInterval.unref();

          session.on('close', () => clearInterval(pingInterval));
        });
      }
    });
  }

  /**
   * Reset the idle timer for a session.
   */
  private resetIdleTimer(origin: string, entry: SessionEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);

    entry.idleTimer = setTimeout(() => {
      if (entry.activeStreams === 0) {
        logger.debug('Closing idle HTTP/2 session', { origin });
        this.destroySession(origin, entry);
      }
    }, this.config.maxIdleTimeMs);

    // Don't prevent process exit
    if (entry.idleTimer.unref) entry.idleTimer.unref();
  }

  /**
   * F3-FIX: Record a connection failure and open circuit breaker if threshold exceeded.
   * Uses exponential backoff for cooldown: 30s, 60s, 120s, 240s, max 5min.
   * Suppresses repeated error logs to once per 30s per origin.
   */
  private recordConnectionFailure(origin: string, errorMessage: string): void {
    const now = Date.now();
    const existing = this.circuitBreakers.get(origin);
    const failures = (existing?.consecutiveFailures ?? 0) + 1;

    // Log suppression: only log once per ERROR_LOG_INTERVAL_MS per origin
    const shouldLog = !existing || (now - existing.lastLoggedAt) >= Http2SessionPool.ERROR_LOG_INTERVAL_MS;
    if (shouldLog) {
      logger.warn('HTTP/2 session error', {
        origin,
        error: errorMessage,
        consecutiveFailures: failures,
        circuitBreakerOpen: failures >= Http2SessionPool.CB_FAILURE_THRESHOLD,
      });
    }

    if (failures >= Http2SessionPool.CB_FAILURE_THRESHOLD) {
      // Exponential backoff: 30s * 2^(cycles-1), max 5min
      const cycles = Math.floor(failures / Http2SessionPool.CB_FAILURE_THRESHOLD);
      const cooldownMs = Math.min(
        Http2SessionPool.CB_INITIAL_COOLDOWN_MS * Math.pow(2, cycles - 1),
        Http2SessionPool.CB_MAX_COOLDOWN_MS
      );

      this.circuitBreakers.set(origin, {
        consecutiveFailures: failures,
        openUntil: now + cooldownMs,
        lastLoggedAt: shouldLog ? now : (existing?.lastLoggedAt ?? now),
      });

      if (shouldLog) {
        logger.warn('HTTP/2 circuit breaker opened', {
          origin,
          cooldownMs,
          consecutiveFailures: failures,
        });
      }
    } else {
      this.circuitBreakers.set(origin, {
        consecutiveFailures: failures,
        openUntil: 0,
        lastLoggedAt: shouldLog ? now : (existing?.lastLoggedAt ?? now),
      });
    }
  }

  /**
   * Destroy a session and clean up resources.
   */
  private destroySession(origin: string, entry: SessionEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    this.sessions.delete(origin);

    if (!entry.session.closed && !entry.session.destroyed) {
      entry.session.close();
    }
  }

  /**
   * Get the number of active sessions.
   */
  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Get statistics for all sessions.
   */
  getStats(): Array<{
    origin: string;
    activeStreams: number;
    lastUsed: number;
    closed: boolean;
  }> {
    const stats: Array<{
      origin: string;
      activeStreams: number;
      lastUsed: number;
      closed: boolean;
    }> = [];

    for (const [origin, entry] of this.sessions) {
      stats.push({
        origin,
        activeStreams: entry.activeStreams,
        lastUsed: entry.lastUsed,
        closed: entry.session.closed || entry.session.destroyed,
      });
    }

    return stats;
  }

  /**
   * Close all sessions and clean up.
   */
  async close(): Promise<void> {
    this.closed = true;

    const closePromises: Promise<void>[] = [];

    for (const [origin, entry] of this.sessions) {
      closePromises.push(
        new Promise<void>((resolve) => {
          if (entry.idleTimer) clearTimeout(entry.idleTimer);

          if (entry.session.closed || entry.session.destroyed) {
            resolve();
            return;
          }

          entry.session.close(() => resolve());

          // Force destroy after timeout
          setTimeout(() => {
            if (!entry.session.destroyed) {
              entry.session.destroy();
            }
            resolve();
          }, 5000);
        })
      );

      this.sessions.delete(origin);
    }

    await Promise.all(closePromises);
    this.circuitBreakers.clear();
    logger.debug('HTTP/2 session pool closed');
  }

  /**
   * Create an ethers.js-compatible FetchGetUrlFunc that uses HTTP/2 with fallback.
   *
   * Consolidates the inline HTTP/2 implementation previously in
   * execution-engine/services/provider.service.ts. Uses the pool's managed
   * sessions (with idle cleanup, ping keep-alive, connection timeouts) instead
   * of a bare Map.
   *
   * @param defaultGetUrl - Fallback ethers.js URL fetcher for non-HTTPS or errors
   * @returns FetchGetUrlFunc that uses HTTP/2 multiplexing
   */
  createEthersGetUrlFunc<
    Req extends EthersFetchRequest,
    Sig extends EthersFetchCancelSignal
  >(
    defaultGetUrl: (req: Req, signal?: Sig) => Promise<EthersGetUrlResponse>
  ): (req: Req, signal?: Sig) => Promise<EthersGetUrlResponse> {
    return async (req: Req, signal?: Sig) => {
      const url = new URL(req.url);

      // Only use HTTP/2 for HTTPS endpoints
      if (url.protocol !== 'https:') {
        return defaultGetUrl(req, signal);
      }

      const origin = url.origin;

      let session: http2.ClientHttp2Session;
      try {
        session = await this.getOrCreateSession(origin);
      } catch {
        // Fallback to HTTP/1.1 if session creation fails
        return defaultGetUrl(req, signal);
      }

      return new Promise<EthersGetUrlResponse>((resolve, reject) => {
        const entry = this.sessions.get(origin);
        if (entry) {
          entry.activeStreams++;
          entry.lastUsed = Date.now();
          this.resetIdleTimer(origin, entry);
        }

        const headers: http2.OutgoingHttpHeaders = {
          ':method': req.method || 'POST',
          ':path': url.pathname + url.search,
          'content-type': 'application/json',
        };

        // Copy request headers
        for (const [key, value] of Object.entries(req.headers)) {
          headers[key.toLowerCase()] = value;
        }

        const stream = session.request(headers);

        let statusCode = 200;
        const responseChunks: Buffer[] = [];

        stream.on('response', (responseHeaders) => {
          statusCode = (responseHeaders[':status'] as number) ?? 200;
        });

        stream.on('data', (chunk: Buffer) => {
          responseChunks.push(chunk);
        });

        stream.on('end', () => {
          if (entry) entry.activeStreams = Math.max(0, entry.activeStreams - 1);
          const body = Buffer.concat(responseChunks);
          resolve({ statusCode, statusMessage: '', headers: {}, body });
        });

        stream.on('error', (err: Error) => {
          if (entry) entry.activeStreams = Math.max(0, entry.activeStreams - 1);
          // On HTTP/2 error, fall back to default transport
          defaultGetUrl(req, signal).then(resolve).catch(reject);
        });

        // Handle abort signal (ethers FetchCancelSignal uses addListener)
        if (signal) {
          signal.addListener(() => {
            stream.close();
            reject(new Error('Request aborted'));
          });
        }

        // Write request body
        const body = req.body;
        if (body) {
          stream.end(Buffer.from(body));
        } else {
          stream.end();
        }
      });
    };
  }
}

// =============================================================================
// Ethers.js Integration Types
// =============================================================================
//
// Minimal interfaces matching ethers v6 FetchRequest/FetchGetUrlFunc to avoid
// a hard dependency on ethers in the shared/core package. The execution-engine
// (which depends on ethers) passes the concrete types at call sites.
// =============================================================================

/** Minimal interface for ethers.js FetchRequest (what createEthersGetUrlFunc reads) */
interface EthersFetchRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
}

/** Minimal interface for ethers.js FetchCancelSignal */
interface EthersFetchCancelSignal {
  addListener(listener: () => void): void;
}

/** Minimal interface for ethers.js GetUrlResponse */
interface EthersGetUrlResponse {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
}

/** Type alias matching ethers.FetchGetUrlFunc signature */
type EthersFetchGetUrlFunc = (
  req: EthersFetchRequest,
  signal?: EthersFetchCancelSignal
) => Promise<EthersGetUrlResponse>;

// =============================================================================
// Module-level Singleton
// =============================================================================

let defaultPool: Http2SessionPool | null = null;

/**
 * Get or create the default HTTP/2 session pool singleton.
 *
 * Used by execution-engine's provider service for ethers.js HTTP/2 transport.
 */
export function getHttp2SessionPool(): Http2SessionPool {
  if (!defaultPool) {
    defaultPool = new Http2SessionPool();
  }
  return defaultPool;
}

/**
 * Close all HTTP/2 sessions in the default pool (for graceful shutdown).
 */
export async function closeDefaultHttp2Pool(): Promise<void> {
  if (defaultPool) {
    await defaultPool.close();
    defaultPool = null;
  }
}
