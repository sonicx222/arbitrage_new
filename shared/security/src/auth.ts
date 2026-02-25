// Authentication and Authorization Service
// Implements JWT-based authentication with role-based access control

import jwt, { Secret, SignOptions } from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import crypto from 'crypto';  // BUG-FIX: Import at module level (was require per call)
import { createLogger, getErrorMessage } from '@arbitrage/core';
import { getRedisClient } from '@arbitrage/core';

// =============================================================================
// DI Types (P16 pattern - enables testability without Jest mock hoisting)
// =============================================================================

/**
 * Logger interface for DI
 */
export interface AuthServiceLogger {
  info: (message: string, meta?: object) => void;
  warn: (message: string, meta?: object) => void;
  error: (message: string, meta?: object) => void;
  debug: (message: string, meta?: object) => void;
}

/**
 * Redis interface for DI
 * Types match RedisClient methods used by AuthService
 */
export interface AuthServiceRedis {
  get: (key: string) => Promise<string | null>;
  setex: (key: string, seconds: number, value: string) => Promise<string>;
  del: (...keys: string[]) => Promise<number>;
  incr: (key: string) => Promise<number>;
  expire: (key: string, seconds: number) => Promise<number>;
}

/**
 * Dependencies for AuthService
 */
export interface AuthServiceDeps {
  logger?: AuthServiceLogger;
  redis?: AuthServiceRedis;
}

// Module-level logger for middleware functions (not DI-injectable)
const moduleLogger = createLogger('auth-service');

export interface User {
  id: string;
  username: string;
  email: string;
  roles: string[];
  permissions: string[];
  isActive: boolean;
  lastLogin?: Date;
}

export interface AuthToken {
  userId: string;
  username: string;
  roles: string[];
  permissions: string[];
  iat: number;
  exp: number;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface RegisterRequest {
  username: string;
  email: string;
  password: string;
}

export class AuthService {
  private jwtSecret: string;
  private jwtExpiresIn: string;
  private bcryptRounds: number;
  private redis: AuthServiceRedis | null = null;
  private maxLoginAttempts: number = 5;
  private lockoutDuration: number = 15 * 60 * 1000; // 15 minutes
  private logger: AuthServiceLogger;

  constructor(deps?: AuthServiceDeps) {
    // CRITICAL SECURITY: No fallback secrets allowed
    if (!process.env.JWT_SECRET) {
      throw new Error('CRITICAL SECURITY ERROR: JWT_SECRET environment variable is required. Never use fallback secrets in production!');
    }

    this.jwtSecret = process.env.JWT_SECRET;
    this.jwtExpiresIn = process.env.JWT_EXPIRES_IN || '1h'; // Reduced from 24h for security
    this.bcryptRounds = parseInt(process.env.BCRYPT_ROUNDS || '12');

    // DI: Use injected logger or create default
    this.logger = deps?.logger ?? createLogger('auth-service');

    // DI: Use injected redis or initialize asynchronously
    if (deps?.redis) {
      this.redis = deps.redis;
    } else {
      // Initialize Redis for account lockout tracking
      this.initializeRedis();
    }
  }

  private async initializeRedis(): Promise<void> {
    try {
      this.redis = await getRedisClient();
    } catch (error) {
      this.logger.error('Failed to initialize Redis for authentication', { error });
      throw new Error('Authentication service requires Redis for security features');
    }
  }

  async register(request: RegisterRequest): Promise<User> {
    // Validate input
    this.validateRegistrationRequest(request);

    // Check if user already exists
    const existingUser = await this.findUserByUsername(request.username);
    if (existingUser) {
      throw new Error('Username already exists');
    }

    const existingEmail = await this.findUserByEmail(request.email);
    if (existingEmail) {
      throw new Error('Email already exists');
    }

    // Hash password
    const passwordHash = await bcrypt.hash(request.password, this.bcryptRounds);

    // Create user
    const user: User = {
      id: this.generateUserId(),
      username: request.username,
      email: request.email,
      roles: ['user'], // Default role
      permissions: ['read:opportunities', 'read:health'],
      isActive: true
    };

    // Save user (would integrate with database in production)
    await this.saveUser(user, passwordHash);

    this.logger.info('User registered successfully', { userId: user.id, username: user.username });

    return user;
  }

  async login(request: LoginRequest): Promise<{ user: User; token: string }> {
    // Validate input
    this.validateLoginRequest(request);

    // Check account lockout
    await this.checkAccountLockout(request.username);

    // Find user
    const user = await this.findUserByUsername(request.username);
    if (!user || !user.isActive) {
      // Record failed attempt and constant-time delay to prevent timing attacks
      await this.recordFailedAttempt(request.username);
      await new Promise(resolve => setTimeout(resolve, Math.random() * 100 + 50));
      this.logger.warn('Failed login attempt - user not found or inactive', { username: request.username });
      throw new Error('Invalid username or password');
    }

    // Verify password with constant-time comparison
    const passwordHash = await this.getUserPasswordHash(user.id);
    const isValidPassword = await bcrypt.compare(request.password, passwordHash);

    if (!isValidPassword) {
      // Record failed attempt and constant-time delay to prevent timing attacks
      await this.recordFailedAttempt(request.username);
      await new Promise(resolve => setTimeout(resolve, Math.random() * 100 + 50));
      this.logger.warn('Failed login attempt - invalid password', { userId: user.id, username: request.username });
      throw new Error('Invalid username or password');
    }

    // Clear failed attempts on successful login
    await this.clearFailedAttempts(request.username);

    // Update last login
    user.lastLogin = new Date();
    await this.updateUser(user);

    // Generate JWT token
    const token = this.generateToken(user);

    this.logger.info('User logged in successfully', { userId: user.id, username: request.username });

    return { user, token };
  }

  async validateToken(token: string): Promise<User | null> {
    try {
      // Check if token is blacklisted
      const blacklisted = await this.redis?.get(`auth:blacklist:${token}`);
      if (blacklisted) {
        this.logger.debug('Token validation failed - token blacklisted');
        return null;
      }

      const decoded = jwt.verify(token, this.jwtSecret) as AuthToken;

      // Check if token is expired
      if (decoded.exp * 1000 < Date.now()) {
        this.logger.debug('Token validation failed - token expired');
        return null;
      }

      // Get user and verify they still exist and are active
      const user = await this.findUserById(decoded.userId);
      if (!user || !user.isActive) {
        this.logger.debug('Token validation failed - user not found or inactive');
        return null;
      }

      return user;
    } catch (error) {
      // FAIL-CLOSED: Any token validation error denies access (returns null → 401)
      // This is intentional — see Task 2.4 FailOpen/FailClosed audit
      this.logger.debug('Token validation failed', { error: getErrorMessage(error) });
      return null;
    }
  }

  async authorize(user: User, resource: string, action: string): Promise<boolean> {
    // Check if user has required permission
    const requiredPermission = `${action}:${resource}`;

    // Check direct permissions
    if (user.permissions.includes(requiredPermission)) {
      return true;
    }

    // Check role-based permissions
    for (const role of user.roles) {
      const rolePermissions = await this.getRolePermissions(role);
      if (rolePermissions.includes(requiredPermission)) {
        return true;
      }
    }

    // Check wildcard permissions
    if (user.permissions.some(perm => this.matchesPermission(perm, requiredPermission))) {
      return true;
    }

    return false;
  }

  async refreshToken(token: string): Promise<string> {
    const user = await this.validateToken(token);
    if (!user) {
      throw new Error('Invalid token');
    }

    return this.generateToken(user);
  }

  async logout(token: string): Promise<void> {
    try {
      // Decode token without verification to get expiry
      const decoded = jwt.decode(token) as any;
      if (decoded && decoded.exp) {
        // Add token to blacklist with remaining TTL
        const ttl = Math.max(0, decoded.exp - Math.floor(Date.now() / 1000));
        if (ttl > 0) {
          await this.redis?.setex(`auth:blacklist:${token}`, ttl, 'revoked');
          this.logger.info('Token blacklisted on logout', { userId: decoded.userId, ttl });
        }
      }
    } catch (error) {
      this.logger.error('Error blacklisting token on logout', { error });
      // Don't throw - logout should succeed even if blacklisting fails
    }

    this.logger.info('User logged out successfully');
  }

  private generateToken(user: User): string {
    const payload: Omit<AuthToken, 'iat' | 'exp'> = {
      userId: user.id,
      username: user.username,
      roles: user.roles,
      permissions: user.permissions
    };

    return jwt.sign(payload as object, this.jwtSecret as Secret, { expiresIn: this.jwtExpiresIn } as SignOptions);
  }

  private validateRegistrationRequest(request: RegisterRequest): void {
    if (!request.username || request.username.length < 3) {
      throw new Error('Username must be at least 3 characters');
    }

    if (!request.email || !this.isValidEmail(request.email)) {
      throw new Error('Invalid email address');
    }

    if (!request.password || request.password.length < 8) {
      throw new Error('Password must be at least 8 characters');
    }

    // Check password strength
    if (!this.isStrongPassword(request.password)) {
      throw new Error('Password must contain uppercase, lowercase, number, and special character');
    }
  }

  private validateLoginRequest(request: LoginRequest): void {
    if (!request.username || !request.password) {
      throw new Error('Username and password are required');
    }
  }

  private isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  private isStrongPassword(password: string): boolean {
    // At least 8 characters, 1 uppercase, 1 lowercase, 1 number, 1 special character
    const strongPasswordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
    return strongPasswordRegex.test(password);
  }

  private matchesPermission(userPermission: string, requiredPermission: string): boolean {
    // Support wildcard permissions like 'read:*' or '*:opportunities'
    const userParts = userPermission.split(':');
    const requiredParts = requiredPermission.split(':');

    if (userParts.length !== 2 || requiredParts.length !== 2) {
      return false;
    }

    return (userParts[0] === '*' || userParts[0] === requiredParts[0]) &&
           (userParts[1] === '*' || userParts[1] === requiredParts[1]);
  }

  // Database operations (mock implementations - replace with real database)
  private async findUserByUsername(username: string): Promise<User | null> {
    // Mock implementation - replace with database query
    this.logger.debug('Finding user by username', { username });
    return null;
  }

  private async findUserByEmail(email: string): Promise<User | null> {
    // Mock implementation - replace with database query
    this.logger.debug('Finding user by email', { email });
    return null;
  }

  private async findUserById(userId: string): Promise<User | null> {
    // Mock implementation - replace with database query
    this.logger.debug('Finding user by ID', { userId });
    return null;
  }

  private async getUserPasswordHash(userId: string): Promise<string> {
    // Mock implementation - replace with database query
    this.logger.debug('Getting user password hash', { userId });
    return '';
  }

  private async saveUser(user: User, passwordHash: string): Promise<void> {
    // Mock implementation - replace with database save
    this.logger.info('Saving user', { userId: user.id, username: user.username });
  }

  private async updateUser(user: User): Promise<void> {
    // Mock implementation - replace with database update
    this.logger.debug('Updating user', { userId: user.id });
  }

  private async getRolePermissions(role: string): Promise<string[]> {
    // Mock role-based permissions - replace with database lookup
    const rolePermissions: Record<string, string[]> = {
      'admin': ['*'],
      'trader': ['read:*', 'write:orders', 'execute:arbitrage'],
      'viewer': ['read:*'],
      'user': ['read:opportunities', 'read:health', 'read:metrics']
    };

    return rolePermissions[role] || [];
  }

  private generateUserId(): string {
    // FIX: Use crypto.randomBytes for cryptographically secure ID generation
    // Math.random() is predictable and NOT suitable for security-sensitive IDs
    const randomPart = crypto.randomBytes(8).toString('hex');
    return `user_${Date.now()}_${randomPart}`;
  }

  // Account lockout protection methods
  private async checkAccountLockout(username: string): Promise<void> {
    const lockoutKey = `auth:lockout:${username}`;
    const attemptsKey = `auth:attempts:${username}`;

    const lockoutUntil = await this.redis?.get(lockoutKey);
    if (lockoutUntil) {
      const lockoutTime = parseInt(lockoutUntil);
      if (Date.now() < lockoutTime) {
        const remainingMinutes = Math.ceil((lockoutTime - Date.now()) / (60 * 1000));
        throw new Error(`Account locked due to too many failed attempts. Try again in ${remainingMinutes} minutes.`);
      } else {
        // Lockout expired, clear it
        await this.redis?.del(lockoutKey);
        await this.redis?.del(attemptsKey);
      }
    }
  }

  private async recordFailedAttempt(username: string): Promise<void> {
    const attemptsKey = `auth:attempts:${username}`;
    const attempts = await this.redis?.incr(attemptsKey) ?? 0;

    // Set expiry on attempts counter
    await this.redis?.expire(attemptsKey, 15 * 60); // 15 minutes

    if (attempts >= this.maxLoginAttempts) {
      // Lock account
      const lockoutKey = `auth:lockout:${username}`;
      const lockoutUntil = Date.now() + this.lockoutDuration;
      await this.redis?.setex(lockoutKey, Math.ceil(this.lockoutDuration / 1000), lockoutUntil.toString());

      this.logger.warn('Account locked due to too many failed attempts', { username, attempts });
    }
  }

  private async clearFailedAttempts(username: string): Promise<void> {
    const attemptsKey = `auth:attempts:${username}`;
    await this.redis?.del(attemptsKey);
  }

  // Administrative method to unlock account
  async unlockAccount(username: string): Promise<void> {
    const lockoutKey = `auth:lockout:${username}`;
    const attemptsKey = `auth:attempts:${username}`;

    await this.redis?.del(lockoutKey);
    await this.redis?.del(attemptsKey);

    this.logger.info('Account unlocked by administrator', { username });
  }
}

// =============================================================================
// Singleton AuthService (FIX: Avoid creating new instance per request)
// =============================================================================

let authServiceInstance: AuthService | null = null;

/**
 * Get or create the singleton AuthService instance.
 * This prevents creating new Redis connections on every request.
 *
 * Note: Returns null if JWT_SECRET is not configured (allows dev mode).
 */
export function getAuthService(): AuthService | null {
  if (!process.env.JWT_SECRET) {
    return null;
  }

  if (!authServiceInstance) {
    authServiceInstance = new AuthService();
  }
  return authServiceInstance;
}

/**
 * Reset the AuthService singleton (for testing only).
 */
export function resetAuthService(): void {
  authServiceInstance = null;
}

// Middleware for authentication
export function authenticate(required: boolean = true) {
  return async (req: any, res: any, next: any) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        if (required) {
          return res.status(401).json({ error: 'Authentication required' });
        }
        return next();
      }

      const token = authHeader.substring(7); // Remove 'Bearer ' prefix
      const authService = getAuthService();
      if (!authService) {
        // JWT not configured - should not reach here if auth header present
        if (required) {
          return res.status(401).json({ error: 'Authentication not configured' });
        }
        return next();
      }
      const user = await authService.validateToken(token);

      if (!user) {
        if (required) {
          return res.status(401).json({ error: 'Invalid or expired token' });
        }
        return next();
      }

      req.user = user;
      next();
    } catch (error) {
      moduleLogger.error('Authentication middleware error', { error });
      return res.status(500).json({ error: 'Authentication failed' });
    }
  };
}

// Middleware for authorization
export function authorize(resource: string, action: string) {
  return async (req: any, res: any, next: any) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const authService = getAuthService();
      if (!authService) {
        // No JWT configured - allow if we have a user (from API key)
        return next();
      }
      const allowed = await authService.authorize(req.user, resource, action);

      if (!allowed) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      next();
    } catch (error) {
      moduleLogger.error('Authorization middleware error', { error });
      return res.status(500).json({ error: 'Authorization failed' });
    }
  };
}

// =============================================================================
// Phase 4: API Key Authentication
// =============================================================================

/**
 * API Key configuration for simple service-to-service authentication
 * More lightweight than full JWT for internal services
 */
export interface ApiKeyConfig {
  /** Map of API key hash → permissions */
  keys: Map<string, ApiKeyEntry>;
}

export interface ApiKeyEntry {
  name: string;
  permissions: string[];
  roles: string[];
  createdAt: number;
  lastUsed?: number;
}

/**
 * Simple API key user representation
 */
export interface ApiKeyUser {
  id: string;
  username: string;
  roles: string[];
  permissions: string[];
  isActive: boolean;
  isApiKey: true;
}

// In-memory API key store (in production, use Redis or database)
const apiKeyStore: Map<string, ApiKeyEntry> = new Map();

/**
 * Initialize API keys from environment variable
 * Format: API_KEYS=name1:key1:permissions,name2:key2:permissions
 *
 * Example: API_KEYS=coordinator:abc123:read:*;write:services,monitor:xyz789:read:*
 */
export function initializeApiKeys(): void {
  const envKeys = process.env.API_KEYS;
  if (!envKeys) {
    moduleLogger.debug('No API_KEYS configured - API key auth disabled');
    return;
  }

  const keyEntries = envKeys.split(',');
  for (const entry of keyEntries) {
    const [name, key, ...permParts] = entry.split(':');
    if (!name || !key) {
      moduleLogger.warn('Invalid API key entry format', { entry: entry.substring(0, 10) + '...' });
      continue;
    }

    const permissions = permParts.join(':').split(';').filter(p => p);

    // Store key hash, not the actual key
    const keyHash = hashApiKey(key);
    apiKeyStore.set(keyHash, {
      name,
      permissions: permissions.length > 0 ? permissions : ['read:*'],
      roles: ['api-service'],
      createdAt: Date.now(),
    });

    moduleLogger.info('API key registered', { name, permissionCount: permissions.length });
  }
}

/**
 * Clear all API keys (for testing only)
 */
export function clearApiKeyStore(): void {
  apiKeyStore.clear();
}

/**
 * Hash API key for secure storage and comparison
 * Uses simple SHA-256 hash (sufficient for API keys)
 *
 * BUG-FIX: Uses module-level crypto import instead of require per call
 */
function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/**
 * Validate an API key and return the associated user
 */
export function validateApiKey(key: string): ApiKeyUser | null {
  const keyHash = hashApiKey(key);
  const entry = apiKeyStore.get(keyHash);

  if (!entry) {
    return null;
  }

  // Update last used time
  entry.lastUsed = Date.now();

  return {
    id: `api_${entry.name}`,
    username: entry.name,
    roles: entry.roles,
    permissions: entry.permissions,
    isActive: true,
    isApiKey: true,
  };
}

/**
 * Check if API key auth is enabled
 */
export function isApiKeyAuthEnabled(): boolean {
  return apiKeyStore.size > 0;
}

/**
 * Check if JWT auth is enabled (JWT_SECRET is set)
 */
export function isJwtAuthEnabled(): boolean {
  return !!process.env.JWT_SECRET;
}

/**
 * Check if any auth method is enabled
 */
export function isAuthEnabled(): boolean {
  return isJwtAuthEnabled() || isApiKeyAuthEnabled();
}

// =============================================================================
// Unified Authentication Middleware
// =============================================================================

export interface AuthOptions {
  /** Whether authentication is required (default: true) */
  required?: boolean;
  /** Allowed authentication methods (default: all enabled) */
  methods?: ('jwt' | 'apiKey')[];
}

/**
 * Unified authentication middleware that supports both JWT and API key auth
 *
 * Checks in order:
 * 1. Bearer token (JWT)
 * 2. X-API-Key header
 *
 * If neither auth is configured, allows all requests (dev mode)
 */
export function apiAuth(options: AuthOptions = {}) {
  const { required = true, methods = ['jwt', 'apiKey'] } = options;

  return async (req: any, res: any, next: any) => {
    try {
      // P1 FIX #8 + S-3 FIX: Only allow auth bypass in test/development environments.
      // Previously, missing JWT_SECRET + API_KEYS in production granted admin access.
      // S-3: Explicitly whitelist NODE_ENV values; undefined/unknown NODE_ENV is treated as production.
      if (!isAuthEnabled()) {
        const nodeEnv = process.env.NODE_ENV;
        if ((AUTH_BYPASS_ALLOWED_ENVS as readonly string[]).includes(nodeEnv ?? '')) {
          moduleLogger.debug('Auth not configured - allowing request with default dev user (non-production)');
          req.user = {
            id: 'dev-user',
            username: 'dev',
            roles: ['admin'],  // Array to match User interface
            permissions: ['*:*'], // Full access in dev/test mode
            isApiKey: false,
            isActive: true
          };
          return next();
        }
        // In production or unknown NODE_ENV (including undefined), always reject
        moduleLogger.error('Auth not configured in non-dev/test environment - rejecting request. Set JWT_SECRET or API_KEYS.', { nodeEnv: nodeEnv ?? '(unset)' });
        return res.status(503).json({
          error: 'Authentication not configured',
          message: 'Server authentication is not properly configured. Contact administrator.',
        });
      }

      // Try API key first (simpler, no expiry issues)
      if (methods.includes('apiKey') && isApiKeyAuthEnabled()) {
        const apiKey = req.headers['x-api-key'];
        if (apiKey) {
          const user = validateApiKey(apiKey);
          if (user) {
            req.user = user;
            moduleLogger.debug('API key authentication successful', { user: user.username });
            return next();
          }
          // Invalid API key - continue to try JWT
          moduleLogger.debug('Invalid API key provided');
        }
      }

      // Try JWT Bearer token
      if (methods.includes('jwt') && isJwtAuthEnabled()) {
        const authHeader = req.headers.authorization;
        if (authHeader?.startsWith('Bearer ')) {
          const token = authHeader.substring(7);
          try {
            const authService = getAuthService();
            if (authService) {
              const user = await authService.validateToken(token);
              if (user) {
                req.user = user;
                moduleLogger.debug('JWT authentication successful', { user: user.username });
                return next();
              }
            }
          } catch (error) {
            // JWT validation failed - continue
            moduleLogger.debug('JWT validation failed', { error: getErrorMessage(error) });
          }
        }
      }

      // No valid auth found
      if (required) {
        return res.status(401).json({
          error: 'Authentication required',
          message: 'Provide a valid API key (X-API-Key header) or JWT token (Authorization: Bearer)',
        });
      }

      // Auth not required, continue without user
      return next();
    } catch (error) {
      moduleLogger.error('Authentication middleware error', { error });
      return res.status(500).json({ error: 'Authentication failed' });
    }
  };
}

/**
 * Authorization middleware for permission checking
 * Works with both JWT users and API key users
 */
export function apiAuthorize(resource: string, action: string) {
  return async (req: any, res: any, next: any) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const requiredPermission = `${action}:${resource}`;

      // Check direct permissions
      if (req.user.permissions.includes(requiredPermission)) {
        return next();
      }

      // Check wildcard permissions
      for (const perm of req.user.permissions) {
        const [permAction, permResource] = perm.split(':');
        if ((permAction === '*' || permAction === action) &&
            (permResource === '*' || permResource === resource)) {
          return next();
        }
      }

      // Check role-based permissions for JWT users
      if (!req.user.isApiKey) {
        try {
          const authService = getAuthService();
          if (authService) {
            const allowed = await authService.authorize(req.user, resource, action);
            if (allowed) {
              return next();
            }
          }
        } catch {
          // Fall through to forbidden
        }
      }

      return res.status(403).json({
        error: 'Insufficient permissions',
        required: requiredPermission,
      });
    } catch (error) {
      moduleLogger.error('Authorization middleware error', { error });
      return res.status(500).json({ error: 'Authorization failed' });
    }
  };
}

// =============================================================================
// Startup Auth Environment Validation (S-3 Fix)
// =============================================================================

/** Whitelist of NODE_ENV values where auth bypass is allowed */
const AUTH_BYPASS_ALLOWED_ENVS = ['test', 'development'] as const;

/**
 * Validate authentication environment at startup.
 *
 * S-3 FIX: When auth is not configured (no JWT_SECRET and no API_KEYS),
 * this function ensures that NODE_ENV is explicitly set to a safe value
 * ('test' or 'development'). If NODE_ENV is unset or set to any other value
 * (e.g., 'production', 'staging'), this throws to prevent running without auth.
 *
 * Call this at service startup (before accepting requests).
 *
 * @throws Error if auth is not configured and NODE_ENV is not in the safe whitelist
 */
export function validateAuthEnvironment(): void {
  if (isAuthEnabled()) {
    // Auth is configured, no issue
    return;
  }

  const nodeEnv = process.env.NODE_ENV;
  if (nodeEnv && (AUTH_BYPASS_ALLOWED_ENVS as readonly string[]).includes(nodeEnv)) {
    moduleLogger.warn('Auth not configured - auth bypass allowed in non-production environment', { nodeEnv });
    return;
  }

  // NODE_ENV is unset, empty, or not in the whitelist
  const errorMsg =
    `SECURITY ERROR: Authentication is not configured (no JWT_SECRET or API_KEYS) ` +
    `and NODE_ENV is "${nodeEnv ?? '(unset)'}". ` +
    `Auth bypass is only allowed when NODE_ENV is one of: ${AUTH_BYPASS_ALLOWED_ENVS.join(', ')}. ` +
    `Set JWT_SECRET or API_KEYS, or explicitly set NODE_ENV=development for local development.`;
  moduleLogger.error(errorMsg);
  throw new Error(errorMsg);
}

// Initialize API keys on module load
initializeApiKeys();