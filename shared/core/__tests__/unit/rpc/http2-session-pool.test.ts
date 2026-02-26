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
 *
 * @see shared/core/src/rpc/http2-session-pool.ts
 */

// @ts-nocheck
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
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

import * as http2 from 'http2';
import {
  Http2SessionPool,
  getHttp2SessionPool,
  closeDefaultHttp2Pool,
} from '../../../src/rpc/http2-session-pool';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock HTTP/2 client stream that emits response headers, data, and end.
 */
function createMockStream(
  responseData = '{"result":"0x1"}',
  statusCode = 200,
  opts?: { errorOnEnd?: Error; delayMs?: number }
) {
  const stream = new EventEmitter();
  (stream as any).write = jest.fn();
  (stream as any).close = jest.fn();

  // When end() is called, schedule response emission
  (stream as any).end = jest.fn((_body?: string | Buffer) => {
    if (opts?.errorOnEnd) {
      process.nextTick(() => stream.emit('error', opts.errorOnEnd));
      return;
    }
    process.nextTick(() => {
      stream.emit('response', { ':status': statusCode });
    });
    process.nextTick(() => {
      stream.emit('data', Buffer.from(responseData));
      stream.emit('end');
    });
  });

  return stream;
}

/**
 * Create a mock HTTP/2 client session.
 *
 * By default emits 'connect' on next tick so `getOrCreateSession` resolves.
 * Pass `autoConnect: false` to suppress the connect event.
 */
function createMockSession(opts?: {
  autoConnect?: boolean;
  stream?: EventEmitter;
  connectError?: Error;
}) {
  const session = new EventEmitter();
  const mockStream = opts?.stream ?? createMockStream();
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
    process.nextTick(() => session.emit('error', opts.connectError));
  } else if (autoConnect) {
    process.nextTick(() => session.emit('connect'));
  }

  return session;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Http2SessionPool', () => {
  let pool: Http2SessionPool;
  let mockSession: EventEmitter;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();

    mockSession = createMockSession();
    mockHttp2Connect.mockImplementation(() => mockSession);

    pool = new Http2SessionPool();
  });

  afterEach(async () => {
    // Ensure all timers are flushed so idle/ping timers do not leak
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('should use default config values', () => {
      const p = new Http2SessionPool();
      // Verify defaults indirectly — pool should be functional
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
      const responsePromise = pool.request('https://rpc.example.com', {
        method: 'POST',
        body: '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}',
      });

      // Allow connect event to fire
      await jest.advanceTimersByTimeAsync(1);

      const result = await responsePromise;
      expect(result.status).toBe(200);
      expect(result.body).toBe('{"result":"0x1"}');
      expect((mockSession as any).request).toHaveBeenCalled();
    });

    it('should reuse existing session for same origin', async () => {
      const req1 = pool.request('https://rpc.example.com/path1', { body: '{}' });
      await jest.advanceTimersByTimeAsync(1);
      await req1;

      // Second request to same origin
      const req2 = pool.request('https://rpc.example.com/path2', { body: '{}' });
      await jest.advanceTimersByTimeAsync(1);
      await req2;

      // http2.connect should only be called once for the same origin
      expect(mockHttp2Connect).toHaveBeenCalledTimes(1);
    });

    it('should create separate sessions for different origins', async () => {
      const session2 = createMockSession();
      let callCount = 0;
      mockHttp2Connect.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? mockSession : session2;
      });

      const req1 = pool.request('https://rpc1.example.com', { body: '{}' });
      await jest.advanceTimersByTimeAsync(1);
      await req1;

      const req2 = pool.request('https://rpc2.example.com', { body: '{}' });
      await jest.advanceTimersByTimeAsync(1);
      await req2;

      expect(mockHttp2Connect).toHaveBeenCalledTimes(2);
    });

    it('should handle POST requests with body', async () => {
      const body = '{"jsonrpc":"2.0","method":"eth_call","params":[],"id":1}';
      const reqPromise = pool.request('https://rpc.example.com', {
        method: 'POST',
        body,
      });
      await jest.advanceTimersByTimeAsync(1);
      await reqPromise;

      const stream = (mockSession as any).request.mock.results[0].value;
      expect(stream.end).toHaveBeenCalledWith(body);
    });

    it('should handle GET requests without body', async () => {
      const stream = createMockStream('{"result":"ok"}', 200);
      (mockSession as any).request = jest.fn().mockReturnValue(stream);

      const reqPromise = pool.request('https://rpc.example.com/health', {
        method: 'GET',
      });
      await jest.advanceTimersByTimeAsync(1);
      await reqPromise;

      expect(stream.end).toHaveBeenCalledWith();
    });

    it('should default to POST method', async () => {
      const reqPromise = pool.request('https://rpc.example.com', {
        body: '{}',
      });
      await jest.advanceTimersByTimeAsync(1);
      await reqPromise;

      const headers = (mockSession as any).request.mock.calls[0][0];
      expect(headers[':method']).toBe('POST');
    });

    it('should merge custom headers', async () => {
      const reqPromise = pool.request('https://rpc.example.com', {
        body: '{}',
        headers: {
          'Authorization': 'Bearer token123',
          'X-Custom': 'value',
        },
      });
      await jest.advanceTimersByTimeAsync(1);
      await reqPromise;

      const headers = (mockSession as any).request.mock.calls[0][0];
      expect(headers['authorization']).toBe('Bearer token123');
      expect(headers['x-custom']).toBe('value');
    });

    it('should allow overriding content-type header', async () => {
      const reqPromise = pool.request('https://rpc.example.com', {
        body: '{}',
        headers: { 'Content-Type': 'text/plain' },
      });
      await jest.advanceTimersByTimeAsync(1);
      await reqPromise;

      const headers = (mockSession as any).request.mock.calls[0][0];
      expect(headers['content-type']).toBe('text/plain');
    });

    it('should skip pseudo-headers from custom headers', async () => {
      const reqPromise = pool.request('https://rpc.example.com', {
        body: '{}',
        headers: { ':authority': 'evil.com', 'x-ok': 'fine' },
      });
      await jest.advanceTimersByTimeAsync(1);
      await reqPromise;

      const headers = (mockSession as any).request.mock.calls[0][0];
      // Pseudo-header should NOT be overridden by custom headers
      expect(headers[':authority']).toBe('rpc.example.com');
      expect(headers['x-ok']).toBe('fine');
    });

    it('should handle stream errors and reject with wrapped error', async () => {
      const errorStream = createMockStream('', 200, {
        errorOnEnd: new Error('stream reset'),
      });
      (mockSession as any).request = jest.fn().mockReturnValue(errorStream);

      const reqPromise = pool.request('https://rpc.example.com', { body: '{}' });
      await jest.advanceTimersByTimeAsync(1);

      await expect(reqPromise).rejects.toThrow('HTTP/2 stream error: stream reset');
    });

    it('should handle non-200 status codes', async () => {
      const stream = createMockStream('{"error":"rate limited"}', 429);
      (mockSession as any).request = jest.fn().mockReturnValue(stream);

      const reqPromise = pool.request('https://rpc.example.com', { body: '{}' });
      await jest.advanceTimersByTimeAsync(1);

      const result = await reqPromise;
      expect(result.status).toBe(429);
      expect(result.body).toBe('{"error":"rate limited"}');
    });

    it('should throw when pool is closed', async () => {
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
      const reqPromise = p.request('https://bad-host.example.com', { body: '{}' });
      await jest.advanceTimersByTimeAsync(1);

      await expect(reqPromise).rejects.toThrow('HTTP/2 connection error: connection refused');
    });

    it('should handle connection timeout', async () => {
      // Session never emits 'connect'
      const stalledSession = createMockSession({ autoConnect: false });
      mockHttp2Connect.mockReturnValue(stalledSession);

      const p = new Http2SessionPool({ connectTimeoutMs: 500 });
      const reqPromise = p.request('https://slow-host.example.com', { body: '{}' });

      // Advance past the connect timeout
      await jest.advanceTimersByTimeAsync(600);

      await expect(reqPromise).rejects.toThrow('HTTP/2 connection timeout');
    });

    it('should set correct path from URL', async () => {
      const reqPromise = pool.request('https://rpc.example.com/v1/mainnet?key=abc', {
        body: '{}',
      });
      await jest.advanceTimersByTimeAsync(1);
      await reqPromise;

      const headers = (mockSession as any).request.mock.calls[0][0];
      expect(headers[':path']).toBe('/v1/mainnet?key=abc');
      expect(headers[':scheme']).toBe('https');
      expect(headers[':authority']).toBe('rpc.example.com');
    });

    it('should replace stale session on reconnect', async () => {
      // First request succeeds
      const req1 = pool.request('https://rpc.example.com', { body: '{}' });
      await jest.advanceTimersByTimeAsync(1);
      await req1;

      // Mark session as closed (simulating server-side close)
      (mockSession as any).closed = true;

      // Create a new session for reconnect
      const freshSession = createMockSession();
      mockHttp2Connect.mockReturnValue(freshSession);

      const req2 = pool.request('https://rpc.example.com', { body: '{}' });
      await jest.advanceTimersByTimeAsync(1);
      await req2;

      // Should have called connect twice (original + reconnect)
      expect(mockHttp2Connect).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // Session management
  // =========================================================================

  describe('session management', () => {
    it('should track active session count', async () => {
      expect(pool.getActiveSessionCount()).toBe(0);

      const req = pool.request('https://rpc.example.com', { body: '{}' });
      await jest.advanceTimersByTimeAsync(1);
      await req;

      expect(pool.getActiveSessionCount()).toBe(1);
    });

    it('should close idle sessions after timeout', async () => {
      const p = new Http2SessionPool({
        maxIdleTimeMs: 5000,
        pingIntervalMs: 0,
      });

      const req = p.request('https://rpc.example.com', { body: '{}' });
      await jest.advanceTimersByTimeAsync(1);
      await req;

      expect(p.getActiveSessionCount()).toBe(1);

      // Advance past idle timeout
      jest.advanceTimersByTime(6000);

      // Session should have been closed and removed
      expect((mockSession as any).close).toHaveBeenCalled();
    });

    it('should not close session with active streams during idle timeout', async () => {
      const p = new Http2SessionPool({
        maxIdleTimeMs: 1000,
        pingIntervalMs: 0,
      });

      // Create a stream that never ends (simulating long-running request)
      const neverEndStream = new EventEmitter();
      (neverEndStream as any).write = jest.fn();
      (neverEndStream as any).close = jest.fn();
      (neverEndStream as any).end = jest.fn(() => {
        // Emit response but never emit 'end' — stream stays active
        process.nextTick(() => neverEndStream.emit('response', { ':status': 200 }));
      });
      (mockSession as any).request = jest.fn().mockReturnValue(neverEndStream);

      // Start request (increments activeStreams)
      const reqPromise = p.request('https://rpc.example.com', { body: '{}' });
      await jest.advanceTimersByTimeAsync(1);

      // Advance past idle timeout while stream is still active
      jest.advanceTimersByTime(2000);

      // Session should NOT be closed because activeStreams > 0
      // The close is only called if activeStreams === 0 in the idle callback
      expect(p.getActiveSessionCount()).toBe(1);

      // Clean up: emit end to resolve the promise
      neverEndStream.emit('data', Buffer.from('{}'));
      neverEndStream.emit('end');
      await reqPromise;
    });

    it('should close all sessions on close()', async () => {
      // Set up two origins
      const session2 = createMockSession();
      let callCount = 0;
      mockHttp2Connect.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? mockSession : session2;
      });

      const req1 = pool.request('https://rpc1.example.com', { body: '{}' });
      await jest.advanceTimersByTimeAsync(1);
      await req1;

      const req2 = pool.request('https://rpc2.example.com', { body: '{}' });
      await jest.advanceTimersByTimeAsync(1);
      await req2;

      expect(pool.getActiveSessionCount()).toBe(2);

      await pool.close();

      expect((mockSession as any).close).toHaveBeenCalled();
      expect((session2 as any).close).toHaveBeenCalled();
    });

    it('should mark pool as closed after close()', async () => {
      await pool.close();

      await expect(
        pool.request('https://rpc.example.com', { body: '{}' })
      ).rejects.toThrow('Http2SessionPool is closed');
    });

    it('should handle close() when sessions are already destroyed', async () => {
      const req = pool.request('https://rpc.example.com', { body: '{}' });
      await jest.advanceTimersByTimeAsync(1);
      await req;

      // Simulate session already destroyed before close
      (mockSession as any).closed = true;
      (mockSession as any).destroyed = true;

      // Should not throw
      await pool.close();
    });

    it('should remove session from pool when session emits close event', async () => {
      const req = pool.request('https://rpc.example.com', { body: '{}' });
      await jest.advanceTimersByTimeAsync(1);
      await req;

      expect(pool.getActiveSessionCount()).toBe(1);

      // Simulate server-side close
      mockSession.emit('close');

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
      const req = pool.request('https://rpc.example.com', { body: '{}' });
      await jest.advanceTimersByTimeAsync(1);
      await req;

      const stats = pool.getStats();
      expect(stats).toHaveLength(1);
      expect(stats[0].origin).toBe('https://rpc.example.com');
      expect(stats[0].activeStreams).toBe(0);
      expect(stats[0].closed).toBe(false);
      expect(typeof stats[0].lastUsed).toBe('number');
    });

    it('should show correct active stream count', async () => {
      // Use a stream that never ends to keep activeStreams > 0
      const hangingStream = new EventEmitter();
      (hangingStream as any).write = jest.fn();
      (hangingStream as any).close = jest.fn();
      (hangingStream as any).end = jest.fn(() => {
        process.nextTick(() => hangingStream.emit('response', { ':status': 200 }));
        // Never emit 'end'
      });
      (mockSession as any).request = jest.fn().mockReturnValue(hangingStream);

      const reqPromise = pool.request('https://rpc.example.com', { body: '{}' });
      await jest.advanceTimersByTimeAsync(1);

      const stats = pool.getStats();
      expect(stats).toHaveLength(1);
      expect(stats[0].activeStreams).toBe(1);

      // Clean up
      hangingStream.emit('data', Buffer.from('{}'));
      hangingStream.emit('end');
      await reqPromise;
    });

    it('should show closed status for destroyed sessions', async () => {
      const req = pool.request('https://rpc.example.com', { body: '{}' });
      await jest.advanceTimersByTimeAsync(1);
      await req;

      (mockSession as any).destroyed = true;

      const stats = pool.getStats();
      expect(stats[0].closed).toBe(true);
    });

    it('should report multiple origins', async () => {
      const session2 = createMockSession();
      let callCount = 0;
      mockHttp2Connect.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? mockSession : session2;
      });

      const req1 = pool.request('https://rpc1.example.com', { body: '{}' });
      await jest.advanceTimersByTimeAsync(1);
      await req1;

      const req2 = pool.request('https://rpc2.example.com', { body: '{}' });
      await jest.advanceTimersByTimeAsync(1);
      await req2;

      const stats = pool.getStats();
      expect(stats).toHaveLength(2);
      const origins = stats.map((s) => s.origin).sort();
      expect(origins).toEqual(['https://rpc1.example.com', 'https://rpc2.example.com']);
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
      const req = pool.request('https://rpc.example.com', { body: '{}' });
      await jest.advanceTimersByTimeAsync(1);
      await req;

      expect(pool.getActiveSessionCount()).toBe(1);
    });

    it('should return 0 after close()', async () => {
      const req = pool.request('https://rpc.example.com', { body: '{}' });
      await jest.advanceTimersByTimeAsync(1);
      await req;

      await pool.close();
      expect(pool.getActiveSessionCount()).toBe(0);
    });
  });

  // =========================================================================
  // Singleton
  // =========================================================================

  describe('Singleton', () => {
    afterEach(async () => {
      // Clean up singleton between tests
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
      // Should not throw when called without creating a pool first
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
      const getUrl = pool.createEthersGetUrlFunc(mockDefaultGetUrl);

      const req = {
        url: 'https://rpc.example.com',
        method: 'POST',
        headers: {},
        body: new Uint8Array([123, 125]), // '{}'
      };

      const resultPromise = getUrl(req);
      await jest.advanceTimersByTimeAsync(1);

      const result = await resultPromise;
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
      // Make the pool closed so getOrCreateSession will fail
      const closedPool = new Http2SessionPool();

      // Override connect to fail
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

      const getUrl = closedPool.createEthersGetUrlFunc(mockDefaultGetUrl);

      const req = {
        url: 'https://failing-rpc.example.com',
        method: 'POST',
        headers: {},
        body: new Uint8Array([123, 125]),
      };

      const resultPromise = getUrl(req);
      await jest.advanceTimersByTimeAsync(1);

      const result = await resultPromise;
      expect(mockDefaultGetUrl).toHaveBeenCalled();
      expect(result).toBe(mockResponse);
    });

    it('should fall back on HTTP/2 stream error', async () => {
      const errorStream = createMockStream('', 200, {
        errorOnEnd: new Error('stream error'),
      });
      (mockSession as any).request = jest.fn().mockReturnValue(errorStream);

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

      const resultPromise = getUrl(req);
      await jest.advanceTimersByTimeAsync(1);

      const result = await resultPromise;
      expect(mockDefaultGetUrl).toHaveBeenCalled();
      expect(result).toBe(mockResponse);
    });

    it('should handle abort signal', async () => {
      // Use a stream that never completes
      const slowStream = new EventEmitter();
      (slowStream as any).write = jest.fn();
      (slowStream as any).close = jest.fn();
      (slowStream as any).end = jest.fn(() => {
        // Never emit response/end
      });
      (mockSession as any).request = jest.fn().mockReturnValue(slowStream);

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
      await jest.advanceTimersByTimeAsync(1);

      // Fire the abort signal
      expect(abortListener).toBeDefined();
      abortListener!();

      await expect(resultPromise).rejects.toThrow('Request aborted');
      expect((slowStream as any).close).toHaveBeenCalled();
    });

    it('should copy request headers to HTTP/2 stream', async () => {
      const getUrl = pool.createEthersGetUrlFunc(mockDefaultGetUrl);

      const req = {
        url: 'https://rpc.example.com',
        method: 'POST',
        headers: { 'X-Api-Key': 'secret', 'Authorization': 'Bearer tok' },
        body: new Uint8Array([123, 125]),
      };

      const resultPromise = getUrl(req);
      await jest.advanceTimersByTimeAsync(1);
      await resultPromise;

      const headers = (mockSession as any).request.mock.calls[0][0];
      expect(headers['x-api-key']).toBe('secret');
      expect(headers['authorization']).toBe('Bearer tok');
    });

    it('should write body as Buffer from Uint8Array', async () => {
      const stream = createMockStream();
      (mockSession as any).request = jest.fn().mockReturnValue(stream);

      const getUrl = pool.createEthersGetUrlFunc(mockDefaultGetUrl);

      const bodyBytes = new Uint8Array([0x7b, 0x7d]); // '{}'
      const req = {
        url: 'https://rpc.example.com',
        method: 'POST',
        headers: {},
        body: bodyBytes,
      };

      const resultPromise = getUrl(req);
      await jest.advanceTimersByTimeAsync(1);
      await resultPromise;

      // end() should have been called with a Buffer
      expect(stream.end).toHaveBeenCalled();
      const argToEnd = (stream.end as jest.Mock).mock.calls[0][0];
      expect(Buffer.isBuffer(argToEnd)).toBe(true);
    });

    it('should call stream.end() without body when body is null', async () => {
      const stream = createMockStream();
      (mockSession as any).request = jest.fn().mockReturnValue(stream);

      const getUrl = pool.createEthersGetUrlFunc(mockDefaultGetUrl);

      const req = {
        url: 'https://rpc.example.com',
        method: 'GET',
        headers: {},
        body: null,
      };

      const resultPromise = getUrl(req);
      await jest.advanceTimersByTimeAsync(1);
      await resultPromise;

      // end() should be called without arguments
      expect(stream.end).toHaveBeenCalledWith();
    });
  });

  // =========================================================================
  // Ping keep-alive
  // =========================================================================

  describe('ping keep-alive', () => {
    it('should start ping interval when pingIntervalMs > 0', async () => {
      const p = new Http2SessionPool({ pingIntervalMs: 5000 });

      const req = p.request('https://rpc.example.com', { body: '{}' });
      await jest.advanceTimersByTimeAsync(1);
      await req;

      // Advance past one ping interval
      jest.advanceTimersByTime(5500);

      expect((mockSession as any).ping).toHaveBeenCalled();
    });

    it('should not start ping interval when pingIntervalMs is 0', async () => {
      const p = new Http2SessionPool({ pingIntervalMs: 0 });

      const req = p.request('https://rpc.example.com', { body: '{}' });
      await jest.advanceTimersByTimeAsync(1);
      await req;

      // Advance a long time — no pings should have been sent
      jest.advanceTimersByTime(60000);

      expect((mockSession as any).ping).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // close() force destroy timeout
  // =========================================================================

  describe('close() with force destroy', () => {
    it('should force destroy session if close callback does not fire within 5s', async () => {
      // Override close to never call the callback
      (mockSession as any).close = jest.fn((_cb?: () => void) => {
        // Intentionally do NOT call cb, simulating a stuck session
      });
      (mockSession as any).closed = false;
      (mockSession as any).destroyed = false;

      const req = pool.request('https://rpc.example.com', { body: '{}' });
      await jest.advanceTimersByTimeAsync(1);
      await req;

      const closePromise = pool.close();

      // Advance past the 5000ms force-destroy timeout
      jest.advanceTimersByTime(5100);

      await closePromise;

      expect((mockSession as any).destroy).toHaveBeenCalled();
    });
  });
});
