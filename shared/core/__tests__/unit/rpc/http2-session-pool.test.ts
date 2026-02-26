/**
 * HTTP/2 Session Pool Tests
 *
 * Tests for the Http2SessionPool class that manages persistent HTTP/2
 * connections to RPC endpoints. Covers:
 * - Constructor and config defaults
 * - request(): sending requests, session reuse, error handling
 * - Session lifecycle: idle cleanup, close, destroy
 * - getStats(): pool statistics
 * - Singleton: getHttp2SessionPool / closeDefaultHttp2Pool
 * - createEthersGetUrlFunc(): ethers.js integration
 * - Ping keep-alive and force-destroy on close
 *
 * @see shared/core/src/rpc/http2-session-pool.ts
 */

// @ts-nocheck
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Mocks -- must be declared before importing the module under test
// ---------------------------------------------------------------------------

jest.mock('../../../src/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn(),
  }),
}));

const mockHttp2Connect = jest.fn();

jest.mock('http2', () => ({
  __esModule: true,
  default: undefined,
  connect: mockHttp2Connect,
  constants: {
    HTTP2_HEADER_METHOD: ':method',
    HTTP2_HEADER_PATH: ':path',
    HTTP2_HEADER_SCHEME: ':scheme',
    HTTP2_HEADER_AUTHORITY: ':authority',
    HTTP2_HEADER_STATUS: ':status',
  },
}));

import {
  Http2SessionPool,
  getHttp2SessionPool,
  closeDefaultHttp2Pool,
} from '../../../src/rpc/http2-session-pool';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock HTTP/2 client stream.
 *
 * Emits response events via setImmediate so the caller's promise handler
 * is already attached when the events fire.
 */
function createMockStream(
  responseData = '{"result":"0x1"}',
  statusCode = 200,
  opts?: { errorOnEnd?: boolean; neverEnd?: boolean; sync?: boolean }
) {
  const stream = new EventEmitter();
  (stream as any).write = jest.fn();
  (stream as any).close = jest.fn();

  const emit = (fn: () => void) => {
    if (opts?.sync) {
      fn();
    } else {
      setImmediate(fn);
    }
  };

  (stream as any).end = jest.fn((_body?: string | Buffer) => {
    if (opts?.errorOnEnd) {
      emit(() => stream.emit('error', new Error('stream error')));
      return;
    }
    if (opts?.neverEnd) {
      emit(() => stream.emit('response', { ':status': statusCode }));
      return;
    }
    emit(() => {
      stream.emit('response', { ':status': statusCode });
      stream.emit('data', Buffer.from(responseData));
      stream.emit('end');
    });
  });

  return stream;
}

/**
 * Create a mock HTTP/2 client session.
 *
 * By default emits 'connect' via setImmediate so getOrCreateSession resolves.
 * Pass `sync: true` to emit synchronously (needed for fake-timer tests).
 * Pass `autoConnect: false` to suppress the connect event entirely.
 * Pass `connectError` to emit an error instead.
 */
function createMockSession(opts?: {
  autoConnect?: boolean;
  stream?: EventEmitter;
  connectError?: Error;
  sync?: boolean;
}) {
  const session = new EventEmitter();
  const mockStream = opts?.stream ?? createMockStream('{"result":"0x1"}', 200, { sync: opts?.sync });
  (session as any).request = jest.fn().mockReturnValue(mockStream);
  (session as any).close = jest.fn((cb?: () => void) => {
    (session as any).closed = true;
    if (cb) cb();
    session.emit('close');
  });
  (session as any).destroy = jest.fn(() => {
    (session as any).destroyed = true;
  });
  (session as any).closed = false;
  (session as any).destroyed = false;
  (session as any).ping = jest.fn(
    (_buf: Buffer, cb: (err: Error | null, duration: number, payload: Buffer) => void) => {
      cb(null, 1, Buffer.alloc(8));
    }
  );

  const autoConnect = opts?.autoConnect ?? true;
  if (opts?.connectError) {
    if (opts?.sync) {
      // Defer by one microtask so the caller can attach handlers first
      Promise.resolve().then(() => session.emit('error', opts.connectError));
    } else {
      setImmediate(() => session.emit('error', opts.connectError));
    }
  } else if (autoConnect) {
    if (opts?.sync) {
      // Do NOT emit immediately in the constructor -- the source code attaches
      // handlers after http2.connect() returns. Use a microtask (Promise.resolve)
      // so that handlers are registered first, but no real timers are needed.
      Promise.resolve().then(() => session.emit('connect'));
    } else {
      setImmediate(() => session.emit('connect'));
    }
  }

  return session;
}

/**
 * Flush all pending setImmediate callbacks.
 */
function flushImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Flush microtask queue (Promise.resolve callbacks).
 */
function flushMicrotasks(): Promise<void> {
  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Http2SessionPool', () => {
  let pool: Http2SessionPool;

  beforeEach(() => {
    jest.clearAllMocks();
    pool = new Http2SessionPool();
  });

  afterEach(async () => {
    // Close pool to clear idle timers. The source code's close() creates a
    // 5-second force-destroy timeout that isn't cleared when the close callback
    // fires first. We enable fake timers temporarily to flush that pending timer.
    const hadFakeTimers = jest.isMockFunction(setTimeout);
    if (!hadFakeTimers) {
      jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    }
    try {
      const closePromise = pool.close();
      jest.runAllTimers();
      await closePromise;
    } catch {
      // Pool may already be closed; ignore
    }
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  /**
   * Helper: set up mockHttp2Connect to return a fresh auto-connecting session.
   * Returns the mock session so tests can inspect it.
   */
  function setupDefaultSession() {
    const session = createMockSession();
    mockHttp2Connect.mockReturnValue(session);
    return session;
  }

  /**
   * Helper: set up mockHttp2Connect for multiple origins.
   * Sessions are created lazily (on each connect call) so their
   * setImmediate-based connect events fire at the right time.
   * Returns an array that gets populated as sessions are created.
   */
  function setupMultipleSessions(count: number) {
    const sessions: EventEmitter[] = [];
    mockHttp2Connect.mockImplementation(() => {
      const session = createMockSession();
      sessions.push(session);
      return session;
    });
    return sessions;
  }

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('should use default config values', () => {
      const p = new Http2SessionPool();
      expect(p.getActiveSessionCount()).toBe(0);
      expect(p.getStats()).toEqual([]);
    });

    it('should accept custom config', () => {
      const p = new Http2SessionPool({
        maxIdleTimeMs: 5000,
        connectTimeoutMs: 2000,
        maxConcurrentStreams: 50,
        pingIntervalMs: 0,
      });
      expect(p.getActiveSessionCount()).toBe(0);
    });
  });

  // =========================================================================
  // request()
  // =========================================================================

  describe('request()', () => {
    it('should send an HTTP/2 request and return response body', async () => {
      const session = setupDefaultSession();

      const result = await pool.request('https://rpc.example.com', {
        method: 'POST',
        body: '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}',
      });

      expect(result.status).toBe(200);
      expect(result.body).toBe('{"result":"0x1"}');
      expect((session as any).request).toHaveBeenCalled();
    });

    it('should reuse existing session for same origin', async () => {
      setupDefaultSession();

      await pool.request('https://rpc.example.com/path1', { body: '{}' });
      await pool.request('https://rpc.example.com/path2', { body: '{}' });

      expect(mockHttp2Connect).toHaveBeenCalledTimes(1);
    });

    it('should create separate sessions for different origins', async () => {
      const sessions = setupMultipleSessions(2);

      await pool.request('https://rpc1.example.com', { body: '{}' });
      await pool.request('https://rpc2.example.com', { body: '{}' });

      expect(mockHttp2Connect).toHaveBeenCalledTimes(2);
      expect(pool.getActiveSessionCount()).toBe(2);
    });

    it('should handle POST requests with body', async () => {
      const session = setupDefaultSession();
      const body = '{"jsonrpc":"2.0","method":"eth_call","params":[],"id":1}';

      await pool.request('https://rpc.example.com', { method: 'POST', body });

      const stream = (session as any).request.mock.results[0].value;
      expect(stream.end).toHaveBeenCalledWith(body);
    });

    it('should handle GET requests without body', async () => {
      const stream = createMockStream('{"result":"ok"}', 200);
      const session = createMockSession({ stream });
      mockHttp2Connect.mockReturnValue(session);

      await pool.request('https://rpc.example.com/health', { method: 'GET' });

      expect(stream.end).toHaveBeenCalledWith();
    });

    it('should default to POST method', async () => {
      const session = setupDefaultSession();

      await pool.request('https://rpc.example.com', { body: '{}' });

      const headers = (session as any).request.mock.calls[0][0];
      expect(headers[':method']).toBe('POST');
    });

    it('should merge custom headers', async () => {
      const session = setupDefaultSession();

      await pool.request('https://rpc.example.com', {
        body: '{}',
        headers: {
          Authorization: 'Bearer token123',
          'X-Custom': 'value',
        },
      });

      const headers = (session as any).request.mock.calls[0][0];
      expect(headers['authorization']).toBe('Bearer token123');
      expect(headers['x-custom']).toBe('value');
    });

    it('should set default content-type to application/json', async () => {
      const session = setupDefaultSession();

      await pool.request('https://rpc.example.com', { body: '{}' });

      const headers = (session as any).request.mock.calls[0][0];
      expect(headers['content-type']).toBe('application/json');
    });

    it('should allow overriding content-type header', async () => {
      const session = setupDefaultSession();

      await pool.request('https://rpc.example.com', {
        body: '{}',
        headers: { 'Content-Type': 'text/plain' },
      });

      const headers = (session as any).request.mock.calls[0][0];
      expect(headers['content-type']).toBe('text/plain');
    });

    it('should skip pseudo-headers from custom headers', async () => {
      const session = setupDefaultSession();

      await pool.request('https://rpc.example.com', {
        body: '{}',
        headers: { ':authority': 'evil.com', 'x-ok': 'fine' },
      });

      const headers = (session as any).request.mock.calls[0][0];
      expect(headers[':authority']).toBe('rpc.example.com');
      expect(headers['x-ok']).toBe('fine');
    });

    it('should handle stream errors and reject with wrapped error', async () => {
      const errorStream = createMockStream('', 200, { errorOnEnd: true });
      const session = createMockSession({ stream: errorStream });
      mockHttp2Connect.mockReturnValue(session);

      await expect(
        pool.request('https://rpc.example.com', { body: '{}' })
      ).rejects.toThrow('HTTP/2 stream error: stream error');
    });

    it('should handle non-200 status codes', async () => {
      const stream = createMockStream('{"error":"rate limited"}', 429);
      const session = createMockSession({ stream });
      mockHttp2Connect.mockReturnValue(session);

      const result = await pool.request('https://rpc.example.com', { body: '{}' });
      expect(result.status).toBe(429);
      expect(result.body).toBe('{"error":"rate limited"}');
    });

    it('should throw when pool is closed', async () => {
      setupDefaultSession();
      await pool.close();

      await expect(
        pool.request('https://rpc.example.com', { body: '{}' })
      ).rejects.toThrow('Http2SessionPool is closed');
    });

    it('should handle connection errors', async () => {
      const errorSession = createMockSession({
        autoConnect: false,
        connectError: new Error('connection refused'),
      });
      mockHttp2Connect.mockReturnValue(errorSession);

      const p = new Http2SessionPool();
      await expect(
        p.request('https://bad-host.example.com', { body: '{}' })
      ).rejects.toThrow('HTTP/2 connection error: connection refused');
    });

    it('should handle connection timeout', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate'] });

      const stalledSession = createMockSession({ autoConnect: false });
      mockHttp2Connect.mockReturnValue(stalledSession);

      const p = new Http2SessionPool({ connectTimeoutMs: 500 });
      const reqPromise = p.request('https://slow-host.example.com', { body: '{}' });

      jest.advanceTimersByTime(600);

      await expect(reqPromise).rejects.toThrow('HTTP/2 connection timeout');
    });

    it('should set correct path and authority from URL', async () => {
      const session = setupDefaultSession();

      await pool.request('https://rpc.example.com/v1/mainnet?key=abc', { body: '{}' });

      const headers = (session as any).request.mock.calls[0][0];
      expect(headers[':path']).toBe('/v1/mainnet?key=abc');
      expect(headers[':scheme']).toBe('https');
      expect(headers[':authority']).toBe('rpc.example.com');
    });

    it('should replace stale session on reconnect', async () => {
      const session1 = setupDefaultSession();

      await pool.request('https://rpc.example.com', { body: '{}' });

      // Mark session as closed (simulating server-side close)
      (session1 as any).closed = true;

      // New session for reconnect
      const session2 = createMockSession();
      mockHttp2Connect.mockReturnValue(session2);

      await pool.request('https://rpc.example.com', { body: '{}' });

      expect(mockHttp2Connect).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // Session management
  // =========================================================================

  describe('session management', () => {
    it('should track active session count', async () => {
      setupDefaultSession();
      expect(pool.getActiveSessionCount()).toBe(0);

      await pool.request('https://rpc.example.com', { body: '{}' });

      expect(pool.getActiveSessionCount()).toBe(1);
    });

    it('should close idle sessions after timeout', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate'] });

      const p = new Http2SessionPool({ maxIdleTimeMs: 5000, pingIntervalMs: 0 });
      const session = setupDefaultSession();

      const reqPromise = p.request('https://rpc.example.com', { body: '{}' });
      // Let setImmediate callbacks fire (connect + stream events)
      await flushImmediate();
      await flushImmediate();
      await reqPromise;

      expect(p.getActiveSessionCount()).toBe(1);

      // Advance past idle timeout
      jest.advanceTimersByTime(6000);

      expect((session as any).close).toHaveBeenCalled();
    });

    it('should not close session with active streams during idle timeout', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate'] });

      const p = new Http2SessionPool({ maxIdleTimeMs: 1000, pingIntervalMs: 0 });

      const neverEndStream = createMockStream('{}', 200, { neverEnd: true });
      const session = createMockSession({ stream: neverEndStream });
      mockHttp2Connect.mockReturnValue(session);

      const reqPromise = p.request('https://rpc.example.com', { body: '{}' });
      await flushImmediate();
      await flushImmediate();

      // Advance past idle timeout while stream is still active
      jest.advanceTimersByTime(2000);

      // Session should NOT be closed because activeStreams > 0
      expect(p.getActiveSessionCount()).toBe(1);
      expect((session as any).close).not.toHaveBeenCalled();

      // Clean up
      neverEndStream.emit('data', Buffer.from('{}'));
      neverEndStream.emit('end');
      await reqPromise;
    });

    it('should close all sessions on close()', async () => {
      const sessions = setupMultipleSessions(2);

      await pool.request('https://rpc1.example.com', { body: '{}' });
      await pool.request('https://rpc2.example.com', { body: '{}' });

      expect(pool.getActiveSessionCount()).toBe(2);

      await pool.close();

      expect((sessions[0] as any).close).toHaveBeenCalled();
      expect((sessions[1] as any).close).toHaveBeenCalled();
    });

    it('should mark pool as closed after close()', async () => {
      setupDefaultSession();
      await pool.close();

      await expect(
        pool.request('https://rpc.example.com', { body: '{}' })
      ).rejects.toThrow('Http2SessionPool is closed');
    });

    it('should handle close() when sessions are already destroyed', async () => {
      const session = setupDefaultSession();

      await pool.request('https://rpc.example.com', { body: '{}' });

      (session as any).closed = true;
      (session as any).destroyed = true;

      await pool.close();
    });

    it('should remove session from pool when session emits close event', async () => {
      const session = setupDefaultSession();

      await pool.request('https://rpc.example.com', { body: '{}' });
      expect(pool.getActiveSessionCount()).toBe(1);

      session.emit('close');

      expect(pool.getActiveSessionCount()).toBe(0);
    });
  });

  // =========================================================================
  // getStats()
  // =========================================================================

  describe('getStats()', () => {
    it('should return empty array when no sessions exist', () => {
      expect(pool.getStats()).toEqual([]);
    });

    it('should return stats for active sessions', async () => {
      setupDefaultSession();

      await pool.request('https://rpc.example.com', { body: '{}' });

      const stats = pool.getStats();
      expect(stats).toHaveLength(1);
      expect(stats[0].origin).toBe('https://rpc.example.com');
      expect(stats[0].activeStreams).toBe(0);
      expect(stats[0].closed).toBe(false);
      expect(typeof stats[0].lastUsed).toBe('number');
    });

    it('should show correct active stream count', async () => {
      const hangingStream = createMockStream('{}', 200, { neverEnd: true });
      const session = createMockSession({ stream: hangingStream });
      mockHttp2Connect.mockReturnValue(session);

      const reqPromise = pool.request('https://rpc.example.com', { body: '{}' });
      await flushImmediate();
      await flushImmediate();

      const stats = pool.getStats();
      expect(stats).toHaveLength(1);
      expect(stats[0].activeStreams).toBe(1);

      // Clean up
      hangingStream.emit('data', Buffer.from('{}'));
      hangingStream.emit('end');
      await reqPromise;
    });

    it('should show closed status for destroyed sessions', async () => {
      const session = setupDefaultSession();

      await pool.request('https://rpc.example.com', { body: '{}' });

      (session as any).destroyed = true;

      const stats = pool.getStats();
      expect(stats[0].closed).toBe(true);
    });

    it('should report multiple origins', async () => {
      setupMultipleSessions(2);

      await pool.request('https://rpc1.example.com', { body: '{}' });
      await pool.request('https://rpc2.example.com', { body: '{}' });

      const stats = pool.getStats();
      expect(stats).toHaveLength(2);
      const origins = stats.map((s) => s.origin).sort();
      expect(origins).toEqual([
        'https://rpc1.example.com',
        'https://rpc2.example.com',
      ]);
    });
  });

  // =========================================================================
  // getActiveSessionCount()
  // =========================================================================

  describe('getActiveSessionCount()', () => {
    it('should return 0 initially', () => {
      expect(pool.getActiveSessionCount()).toBe(0);
    });

    it('should increment when sessions are created', async () => {
      setupDefaultSession();

      await pool.request('https://rpc.example.com', { body: '{}' });

      expect(pool.getActiveSessionCount()).toBe(1);
    });

    it('should return 0 after close()', async () => {
      setupDefaultSession();

      await pool.request('https://rpc.example.com', { body: '{}' });
      await pool.close();

      expect(pool.getActiveSessionCount()).toBe(0);
    });
  });

  // =========================================================================
  // Singleton
  // =========================================================================

  describe('Singleton', () => {
    afterEach(async () => {
      await closeDefaultHttp2Pool();
    });

    it('should return same instance from getHttp2SessionPool', () => {
      const pool1 = getHttp2SessionPool();
      const pool2 = getHttp2SessionPool();
      expect(pool1).toBe(pool2);
    });

    it('should return Http2SessionPool instance', () => {
      const instance = getHttp2SessionPool();
      expect(instance).toBeInstanceOf(Http2SessionPool);
    });

    it('should create new instance after closeDefaultHttp2Pool', async () => {
      const pool1 = getHttp2SessionPool();
      await closeDefaultHttp2Pool();
      const pool2 = getHttp2SessionPool();
      expect(pool1).not.toBe(pool2);
    });

    it('should handle closeDefaultHttp2Pool when no pool exists', async () => {
      await closeDefaultHttp2Pool();
    });
  });

  // =========================================================================
  // createEthersGetUrlFunc()
  // =========================================================================

  describe('createEthersGetUrlFunc()', () => {
    const mockDefaultGetUrl = jest.fn();

    beforeEach(() => {
      mockDefaultGetUrl.mockReset();
    });

    it('should use HTTP/2 for HTTPS URLs', async () => {
      setupDefaultSession();
      const getUrl = pool.createEthersGetUrlFunc(mockDefaultGetUrl);

      const req = {
        url: 'https://rpc.example.com',
        method: 'POST',
        headers: {},
        body: new Uint8Array([123, 125]),
      };

      const result = await getUrl(req);
      expect(result.statusCode).toBe(200);
      expect(mockDefaultGetUrl).not.toHaveBeenCalled();
    });

    it('should fall back to defaultGetUrl for non-HTTPS URLs', async () => {
      const mockResponse = {
        statusCode: 200,
        statusMessage: 'OK',
        headers: {},
        body: Buffer.from('{"result":"0x1"}'),
      };
      mockDefaultGetUrl.mockResolvedValue(mockResponse);

      const getUrl = pool.createEthersGetUrlFunc(mockDefaultGetUrl);

      const req = {
        url: 'http://localhost:8545',
        method: 'POST',
        headers: {},
        body: new Uint8Array([123, 125]),
      };

      const result = await getUrl(req);
      expect(mockDefaultGetUrl).toHaveBeenCalledWith(req, undefined);
      expect(result).toBe(mockResponse);
    });

    it('should fall back on HTTP/2 session creation failure', async () => {
      mockHttp2Connect.mockImplementation(() => {
        return createMockSession({
          autoConnect: false,
          connectError: new Error('connection failed'),
        });
      });

      const mockResponse = {
        statusCode: 200,
        statusMessage: 'OK',
        headers: {},
        body: Buffer.from('ok'),
      };
      mockDefaultGetUrl.mockResolvedValue(mockResponse);

      const freshPool = new Http2SessionPool();
      const getUrl = freshPool.createEthersGetUrlFunc(mockDefaultGetUrl);

      const req = {
        url: 'https://failing-rpc.example.com',
        method: 'POST',
        headers: {},
        body: new Uint8Array([123, 125]),
      };

      const result = await getUrl(req);
      expect(mockDefaultGetUrl).toHaveBeenCalled();
      expect(result).toBe(mockResponse);
    });

    it('should fall back on HTTP/2 stream error', async () => {
      const errorStream = createMockStream('', 200, { errorOnEnd: true });
      const session = createMockSession({ stream: errorStream });
      mockHttp2Connect.mockReturnValue(session);

      const mockResponse = {
        statusCode: 200,
        statusMessage: 'OK',
        headers: {},
        body: Buffer.from('fallback'),
      };
      mockDefaultGetUrl.mockResolvedValue(mockResponse);

      const getUrl = pool.createEthersGetUrlFunc(mockDefaultGetUrl);

      const req = {
        url: 'https://rpc.example.com',
        method: 'POST',
        headers: { 'x-key': 'val' },
        body: new Uint8Array([123, 125]),
      };

      const result = await getUrl(req);
      expect(mockDefaultGetUrl).toHaveBeenCalled();
      expect(result).toBe(mockResponse);
    });

    it('should handle abort signal', async () => {
      // First establish a session so it is cached
      const session = setupDefaultSession();
      await pool.request('https://rpc.example.com', { body: '{}' });

      // Now set up a slow stream that never completes
      const slowStream = new EventEmitter();
      (slowStream as any).write = jest.fn();
      (slowStream as any).close = jest.fn();
      (slowStream as any).end = jest.fn();
      (session as any).request = jest.fn().mockReturnValue(slowStream);

      const getUrl = pool.createEthersGetUrlFunc(mockDefaultGetUrl);

      let abortListener: (() => void) | undefined;
      const signal = {
        addListener: jest.fn((listener: () => void) => {
          abortListener = listener;
        }),
      };

      const req = {
        url: 'https://rpc.example.com',
        method: 'POST',
        headers: {},
        body: new Uint8Array([123, 125]),
      };

      const resultPromise = getUrl(req, signal);
      // Let microtasks settle so getOrCreateSession resolves from cache
      await flushImmediate();

      expect(abortListener).toBeDefined();
      abortListener!();

      await expect(resultPromise).rejects.toThrow('Request aborted');
      expect((slowStream as any).close).toHaveBeenCalled();
    });

    it('should copy request headers to HTTP/2 stream', async () => {
      const session = setupDefaultSession();
      const getUrl = pool.createEthersGetUrlFunc(mockDefaultGetUrl);

      const req = {
        url: 'https://rpc.example.com',
        method: 'POST',
        headers: { 'X-Api-Key': 'secret', Authorization: 'Bearer tok' },
        body: new Uint8Array([123, 125]),
      };

      await getUrl(req);

      const headers = (session as any).request.mock.calls[0][0];
      expect(headers['x-api-key']).toBe('secret');
      expect(headers['authorization']).toBe('Bearer tok');
    });

    it('should write body as Buffer from Uint8Array', async () => {
      const stream = createMockStream();
      const session = createMockSession({ stream });
      mockHttp2Connect.mockReturnValue(session);

      const getUrl = pool.createEthersGetUrlFunc(mockDefaultGetUrl);

      const bodyBytes = new Uint8Array([0x7b, 0x7d]); // '{}'
      const req = {
        url: 'https://rpc.example.com',
        method: 'POST',
        headers: {},
        body: bodyBytes,
      };

      await getUrl(req);

      expect(stream.end).toHaveBeenCalled();
      const argToEnd = (stream.end as jest.Mock).mock.calls[0][0];
      expect(Buffer.isBuffer(argToEnd)).toBe(true);
    });

    it('should call stream.end() without body when body is null', async () => {
      const stream = createMockStream();
      const session = createMockSession({ stream });
      mockHttp2Connect.mockReturnValue(session);

      const getUrl = pool.createEthersGetUrlFunc(mockDefaultGetUrl);

      const req = {
        url: 'https://rpc.example.com',
        method: 'GET',
        headers: {},
        body: null,
      };

      await getUrl(req);

      expect(stream.end).toHaveBeenCalledWith();
    });
  });

  // =========================================================================
  // Ping keep-alive
  // =========================================================================

  describe('ping keep-alive', () => {
    it('should start ping interval when pingIntervalMs > 0', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate'] });

      const p = new Http2SessionPool({ pingIntervalMs: 5000 });
      const session = setupDefaultSession();

      const reqPromise = p.request('https://rpc.example.com', { body: '{}' });
      await flushImmediate();
      await flushImmediate();
      await reqPromise;

      // Advance past one ping interval
      jest.advanceTimersByTime(5500);

      expect((session as any).ping).toHaveBeenCalled();
    });

    it('should not start ping interval when pingIntervalMs is 0', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate'] });

      const p = new Http2SessionPool({ pingIntervalMs: 0 });
      const session = setupDefaultSession();

      const reqPromise = p.request('https://rpc.example.com', { body: '{}' });
      await flushImmediate();
      await flushImmediate();
      await reqPromise;

      jest.advanceTimersByTime(60000);

      expect((session as any).ping).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // close() force destroy timeout
  // =========================================================================

  describe('close() with force destroy', () => {
    it('should force destroy session if close callback does not fire within 5s', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate'] });

      const session = setupDefaultSession();
      // Override close to never call the callback (stuck session)
      (session as any).close = jest.fn(); // no-op

      const p = new Http2SessionPool({ pingIntervalMs: 0 });

      const reqPromise = p.request('https://rpc.example.com', { body: '{}' });
      await flushImmediate();
      await flushImmediate();
      await reqPromise;

      const closePromise = p.close();

      // Advance past the 5000ms force-destroy timeout
      jest.advanceTimersByTime(5100);

      await closePromise;

      expect((session as any).destroy).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Connection settings
  // =========================================================================

  describe('connection settings', () => {
    it('should pass maxConcurrentStreams to http2.connect', async () => {
      setupDefaultSession();
      const p = new Http2SessionPool({ maxConcurrentStreams: 42 });

      await p.request('https://rpc.example.com', { body: '{}' });

      expect(mockHttp2Connect).toHaveBeenCalledWith(
        'https://rpc.example.com',
        expect.objectContaining({
          settings: { maxConcurrentStreams: 42 },
        })
      );
    });

    it('should pass origin string to http2.connect', async () => {
      setupDefaultSession();

      await pool.request('https://rpc.example.com:8545/v1', { body: '{}' });

      expect(mockHttp2Connect).toHaveBeenCalledWith(
        'https://rpc.example.com:8545',
        expect.any(Object)
      );
    });
  });
});
