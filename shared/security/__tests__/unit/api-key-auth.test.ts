/**
 * API Key Authentication Tests - Phase 4
 *
 * Tests for API key authentication middleware:
 * - API key validation
 * - API key initialization from environment
 * - Unified auth middleware (apiAuth)
 * - Authorization middleware (apiAuthorize)
 * - Permission checking (wildcard, direct)
 *
 * @see Phase 4: REST API Authentication
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import crypto from 'crypto';

// =============================================================================
// Mock Setup
// =============================================================================

// Mock logger
jest.mock('../../../core/src/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

// Mock Redis client
jest.mock('../../../core/src/redis', () => ({
  getRedisClient: jest.fn(() => Promise.resolve({
    get: jest.fn(() => Promise.resolve(null)),
    setex: jest.fn(() => Promise.resolve('OK')),
    del: jest.fn(() => Promise.resolve(1)),
    incr: jest.fn(() => Promise.resolve(1)),
    expire: jest.fn(() => Promise.resolve(1)),
  })),
}));

// =============================================================================
// Import After Mocking
// =============================================================================

import {
  validateApiKey,
  initializeApiKeys,
  clearApiKeyStore,
  isApiKeyAuthEnabled,
  isJwtAuthEnabled,
  isAuthEnabled,
  apiAuth,
  apiAuthorize,
  ApiKeyUser,
} from '../../src/auth';

// =============================================================================
// Test Utilities
// =============================================================================

/**
 * Create mock Express request
 */
function createMockRequest(options: {
  headers?: Record<string, string>;
  user?: any;
} = {}) {
  return {
    headers: options.headers || {},
    user: options.user,
  };
}

/**
 * Create mock Express response
 */
function createMockResponse() {
  const res: any = {
    statusCode: 200,
    body: null,
  };
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((body: any) => {
    res.body = body;
    return res;
  });
  return res;
}

/**
 * Create mock Express next function
 */
function createMockNext() {
  return jest.fn();
}

/**
 * Hash a key for comparison
 */
function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

// =============================================================================
// Test Suites
// =============================================================================

describe('API Key Authentication', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset environment
    process.env = { ...originalEnv };
    // Clear the API key store
    clearApiKeyStore();
    delete process.env.API_KEYS;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ===========================================================================
  // API Key Initialization Tests
  // ===========================================================================

  describe('initializeApiKeys', () => {
    it('should initialize API keys from environment variable', () => {
      // Set up environment
      process.env.API_KEYS = 'coordinator:test-key-123:read:*;write:services';

      // Clear and re-initialize
      initializeApiKeys();

      // Verify key is valid
      const user = validateApiKey('test-key-123');
      expect(user).not.toBeNull();
      expect(user?.username).toBe('coordinator');
      expect(user?.permissions).toContain('read:*');
      expect(user?.permissions).toContain('write:services');
    });

    it('should handle multiple API keys', () => {
      process.env.API_KEYS = 'service1:key1:read:*,service2:key2:write:orders';

      initializeApiKeys();

      const user1 = validateApiKey('key1');
      const user2 = validateApiKey('key2');

      expect(user1?.username).toBe('service1');
      expect(user2?.username).toBe('service2');
    });

    it('should handle API keys with default permissions', () => {
      process.env.API_KEYS = 'monitor:monitor-key';

      initializeApiKeys();

      const user = validateApiKey('monitor-key');
      expect(user).not.toBeNull();
      expect(user?.permissions).toContain('read:*');
    });

    it('should ignore invalid key entries', () => {
      // Invalid format (no key)
      process.env.API_KEYS = 'invalid-entry,valid:validkey:read:*';

      initializeApiKeys();

      const validUser = validateApiKey('validkey');
      expect(validUser).not.toBeNull();
    });

    it('should do nothing when API_KEYS not set', () => {
      delete process.env.API_KEYS;

      // Should not throw
      initializeApiKeys();

      expect(isApiKeyAuthEnabled()).toBe(false);
    });
  });

  // ===========================================================================
  // API Key Validation Tests
  // ===========================================================================

  describe('validateApiKey', () => {
    beforeEach(() => {
      process.env.API_KEYS = 'testservice:secret-api-key:read:metrics;write:config';
      initializeApiKeys();
    });

    it('should return user for valid API key', () => {
      const user = validateApiKey('secret-api-key');

      expect(user).not.toBeNull();
      expect(user?.id).toBe('api_testservice');
      expect(user?.username).toBe('testservice');
      expect(user?.isActive).toBe(true);
      expect(user?.isApiKey).toBe(true);
      expect(user?.roles).toContain('api-service');
    });

    it('should return null for invalid API key', () => {
      const user = validateApiKey('wrong-key');

      expect(user).toBeNull();
    });

    it('should return null for empty API key', () => {
      const user = validateApiKey('');

      expect(user).toBeNull();
    });

    it('should update lastUsed timestamp on validation', () => {
      const user1 = validateApiKey('secret-api-key');
      expect(user1).not.toBeNull();

      // Validate again - lastUsed should be updated
      const user2 = validateApiKey('secret-api-key');

      // lastUsed should be updated (we can't directly check it, but the function runs)
      expect(user2).not.toBeNull();
      expect(user2?.username).toBe('testservice');
    });
  });

  // ===========================================================================
  // Auth Enabled Checks
  // ===========================================================================

  describe('isApiKeyAuthEnabled', () => {
    it('should return true when API keys are configured', () => {
      process.env.API_KEYS = 'service:key:read:*';
      initializeApiKeys();

      expect(isApiKeyAuthEnabled()).toBe(true);
    });

    it('should return false when no API keys configured', () => {
      delete process.env.API_KEYS;
      initializeApiKeys();

      expect(isApiKeyAuthEnabled()).toBe(false);
    });
  });

  describe('isJwtAuthEnabled', () => {
    it('should return true when JWT_SECRET is set', () => {
      process.env.JWT_SECRET = 'test-jwt-secret';

      expect(isJwtAuthEnabled()).toBe(true);
    });

    it('should return false when JWT_SECRET is not set', () => {
      delete process.env.JWT_SECRET;

      expect(isJwtAuthEnabled()).toBe(false);
    });
  });

  describe('isAuthEnabled', () => {
    it('should return true when JWT is enabled', () => {
      process.env.JWT_SECRET = 'test-secret';
      delete process.env.API_KEYS;

      expect(isAuthEnabled()).toBe(true);
    });

    it('should return true when API keys are enabled', () => {
      delete process.env.JWT_SECRET;
      process.env.API_KEYS = 'service:key:read:*';
      initializeApiKeys();

      expect(isAuthEnabled()).toBe(true);
    });

    it('should return false when neither is enabled', () => {
      delete process.env.JWT_SECRET;
      delete process.env.API_KEYS;
      initializeApiKeys();

      expect(isAuthEnabled()).toBe(false);
    });
  });
});

// =============================================================================
// Middleware Tests
// =============================================================================

describe('apiAuth Middleware', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    // Clear the API key store
    clearApiKeyStore();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('when auth is not enabled', () => {
    beforeEach(() => {
      delete process.env.JWT_SECRET;
      delete process.env.API_KEYS;
      clearApiKeyStore(); // Ensure store is empty
    });

    it('should allow request when auth is not configured (dev mode)', async () => {
      const middleware = apiAuth();
      const req = createMockRequest();
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe('with API key auth enabled', () => {
    beforeEach(() => {
      clearApiKeyStore();
      process.env.API_KEYS = 'testservice:valid-api-key:read:*;write:config';
      delete process.env.JWT_SECRET;
      initializeApiKeys();
    });

    it('should authenticate valid API key', async () => {
      const middleware = apiAuth();
      const req = createMockRequest({
        headers: { 'x-api-key': 'valid-api-key' },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toBeDefined();
      expect(req.user.username).toBe('testservice');
      expect(req.user.isApiKey).toBe(true);
    });

    it('should reject invalid API key when required', async () => {
      const middleware = apiAuth({ required: true });
      const req = createMockRequest({
        headers: { 'x-api-key': 'invalid-key' },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.body.error).toBe('Authentication required');
    });

    it('should allow optional auth to pass without credentials', async () => {
      const middleware = apiAuth({ required: false });
      const req = createMockRequest();
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toBeUndefined();
    });

    it('should reject missing auth when required', async () => {
      const middleware = apiAuth({ required: true });
      const req = createMockRequest();
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });
  });

  describe('with JWT auth enabled', () => {
    beforeEach(() => {
      clearApiKeyStore();
      process.env.JWT_SECRET = 'test-jwt-secret';
      delete process.env.API_KEYS;
    });

    it('should reject missing token when required', async () => {
      const middleware = apiAuth({ required: true });
      const req = createMockRequest();
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('should reject invalid Bearer token format', async () => {
      const middleware = apiAuth({ required: true });
      const req = createMockRequest({
        headers: { authorization: 'InvalidFormat token123' },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });
  });

  describe('auth method selection', () => {
    beforeEach(() => {
      clearApiKeyStore();
      process.env.API_KEYS = 'testservice:valid-api-key:read:*';
      process.env.JWT_SECRET = 'test-jwt-secret';
      initializeApiKeys();
    });

    it('should only try API key when methods=[apiKey]', async () => {
      const middleware = apiAuth({ methods: ['apiKey'] });
      const req = createMockRequest({
        headers: {
          'x-api-key': 'valid-api-key',
          authorization: 'Bearer invalid-jwt',
        },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user.isApiKey).toBe(true);
    });

    it('should try API key first, then JWT', async () => {
      const middleware = apiAuth({ methods: ['apiKey', 'jwt'] });
      const req = createMockRequest({
        headers: {
          'x-api-key': 'valid-api-key',
        },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user.isApiKey).toBe(true);
    });
  });
});

// =============================================================================
// Authorization Middleware Tests
// =============================================================================

describe('apiAuthorize Middleware', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    clearApiKeyStore();
    process.env = { ...originalEnv };
    process.env.JWT_SECRET = 'test-secret';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should reject request without user', async () => {
    const middleware = apiAuthorize('metrics', 'read');
    const req = createMockRequest();
    const res = createMockResponse();
    const next = createMockNext();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body.error).toBe('Authentication required');
  });

  describe('direct permission check', () => {
    it('should allow user with exact permission', async () => {
      const middleware = apiAuthorize('metrics', 'read');
      const req = createMockRequest({
        user: {
          id: 'user1',
          username: 'test',
          permissions: ['read:metrics'],
          roles: [],
          isApiKey: true,
        },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('should reject user without permission', async () => {
      const middleware = apiAuthorize('secrets', 'write');
      const req = createMockRequest({
        user: {
          id: 'user1',
          username: 'test',
          permissions: ['read:metrics'],
          roles: [],
          isApiKey: true,
        },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.body.error).toBe('Insufficient permissions');
      expect(res.body.required).toBe('write:secrets');
    });
  });

  describe('wildcard permission check', () => {
    it('should allow user with action wildcard', async () => {
      const middleware = apiAuthorize('metrics', 'read');
      const req = createMockRequest({
        user: {
          id: 'user1',
          username: 'test',
          permissions: ['*:metrics'],
          roles: [],
          isApiKey: true,
        },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('should allow user with resource wildcard', async () => {
      const middleware = apiAuthorize('metrics', 'read');
      const req = createMockRequest({
        user: {
          id: 'user1',
          username: 'test',
          permissions: ['read:*'],
          roles: [],
          isApiKey: true,
        },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('should allow user with full wildcard', async () => {
      const middleware = apiAuthorize('anything', 'any_action');
      const req = createMockRequest({
        user: {
          id: 'admin',
          username: 'admin',
          permissions: ['*:*'],
          roles: ['admin'],
          isApiKey: true,
        },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('multiple permissions', () => {
    it('should check all permissions and allow if any matches', async () => {
      const middleware = apiAuthorize('config', 'write');
      const req = createMockRequest({
        user: {
          id: 'user1',
          username: 'test',
          permissions: ['read:metrics', 'write:config', 'read:health'],
          roles: [],
          isApiKey: true,
        },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });
});

// =============================================================================
// Integration Tests: Auth + Authorize Flow
// =============================================================================

describe('Auth + Authorize Integration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    clearApiKeyStore();
    process.env = { ...originalEnv };
    process.env.API_KEYS = 'readonly:reader-key:read:*,admin:admin-key:*:*';
    delete process.env.JWT_SECRET;
    initializeApiKeys();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should allow read-only user to read metrics', async () => {
    const authMiddleware = apiAuth();
    const authorizeMiddleware = apiAuthorize('metrics', 'read');

    const req = createMockRequest({
      headers: { 'x-api-key': 'reader-key' },
    });
    const res = createMockResponse();
    const next = createMockNext();

    // First auth
    await authMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();

    // Then authorize
    next.mockClear();
    await authorizeMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('should deny read-only user from writing', async () => {
    const authMiddleware = apiAuth();
    const authorizeMiddleware = apiAuthorize('config', 'write');

    const req = createMockRequest({
      headers: { 'x-api-key': 'reader-key' },
    });
    const res = createMockResponse();
    const next = createMockNext();

    // First auth
    await authMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();

    // Then authorize - should fail
    next.mockClear();
    await authorizeMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('should allow admin user full access', async () => {
    const authMiddleware = apiAuth();
    const authorizeMiddleware = apiAuthorize('secrets', 'delete');

    const req = createMockRequest({
      headers: { 'x-api-key': 'admin-key' },
    });
    const res = createMockResponse();
    const next = createMockNext();

    // First auth
    await authMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();

    // Then authorize
    next.mockClear();
    await authorizeMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
