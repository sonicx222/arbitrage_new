// Authentication and Authorization Service
// Implements JWT-based authentication with role-based access control

import jwt, { Secret, SignOptions } from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { createLogger } from '../../core/src/logger';
import { getRedisClient } from '../../core/src/redis';

const logger = createLogger('auth-service');

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
  private redis: any;
  private maxLoginAttempts: number = 5;
  private lockoutDuration: number = 15 * 60 * 1000; // 15 minutes

  constructor() {
    // CRITICAL SECURITY: No fallback secrets allowed
    if (!process.env.JWT_SECRET) {
      throw new Error('CRITICAL SECURITY ERROR: JWT_SECRET environment variable is required. Never use fallback secrets in production!');
    }

    this.jwtSecret = process.env.JWT_SECRET;
    this.jwtExpiresIn = process.env.JWT_EXPIRES_IN || '1h'; // Reduced from 24h for security
    this.bcryptRounds = parseInt(process.env.BCRYPT_ROUNDS || '12');

    // Initialize Redis for account lockout tracking
    this.initializeRedis();
  }

  private async initializeRedis(): Promise<void> {
    try {
      this.redis = await getRedisClient();
    } catch (error) {
      logger.error('Failed to initialize Redis for authentication', { error });
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

    logger.info('User registered successfully', { userId: user.id, username: user.username });

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
      logger.warn('Failed login attempt - user not found or inactive', { username: request.username });
      throw new Error('Invalid username or password');
    }

    // Verify password with constant-time comparison
    const passwordHash = await this.getUserPasswordHash(user.id);
    const isValidPassword = await bcrypt.compare(request.password, passwordHash);

    if (!isValidPassword) {
      // Record failed attempt and constant-time delay to prevent timing attacks
      await this.recordFailedAttempt(request.username);
      await new Promise(resolve => setTimeout(resolve, Math.random() * 100 + 50));
      logger.warn('Failed login attempt - invalid password', { userId: user.id, username: request.username });
      throw new Error('Invalid username or password');
    }

    // Clear failed attempts on successful login
    await this.clearFailedAttempts(request.username);

    // Update last login
    user.lastLogin = new Date();
    await this.updateUser(user);

    // Generate JWT token
    const token = this.generateToken(user);

    logger.info('User logged in successfully', { userId: user.id, username: request.username });

    return { user, token };
  }

  async validateToken(token: string): Promise<User | null> {
    try {
      // Check if token is blacklisted
      const blacklisted = await this.redis.get(`auth:blacklist:${token}`);
      if (blacklisted) {
        logger.debug('Token validation failed - token blacklisted');
        return null;
      }

      const decoded = jwt.verify(token, this.jwtSecret) as AuthToken;

      // Check if token is expired
      if (decoded.exp * 1000 < Date.now()) {
        logger.debug('Token validation failed - token expired');
        return null;
      }

      // Get user and verify they still exist and are active
      const user = await this.findUserById(decoded.userId);
      if (!user || !user.isActive) {
        logger.debug('Token validation failed - user not found or inactive');
        return null;
      }

      return user;
    } catch (error) {
      logger.debug('Token validation failed', { error: error instanceof Error ? error.message : String(error) });
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
          await this.redis.setex(`auth:blacklist:${token}`, ttl, 'revoked');
          logger.info('Token blacklisted on logout', { userId: decoded.userId, ttl });
        }
      }
    } catch (error) {
      logger.error('Error blacklisting token on logout', { error });
      // Don't throw - logout should succeed even if blacklisting fails
    }

    logger.info('User logged out successfully');
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
    logger.debug('Finding user by username', { username });
    return null;
  }

  private async findUserByEmail(email: string): Promise<User | null> {
    // Mock implementation - replace with database query
    logger.debug('Finding user by email', { email });
    return null;
  }

  private async findUserById(userId: string): Promise<User | null> {
    // Mock implementation - replace with database query
    logger.debug('Finding user by ID', { userId });
    return null;
  }

  private async getUserPasswordHash(userId: string): Promise<string> {
    // Mock implementation - replace with database query
    logger.debug('Getting user password hash', { userId });
    return '';
  }

  private async saveUser(user: User, passwordHash: string): Promise<void> {
    // Mock implementation - replace with database save
    logger.info('Saving user', { userId: user.id, username: user.username });
  }

  private async updateUser(user: User): Promise<void> {
    // Mock implementation - replace with database update
    logger.debug('Updating user', { userId: user.id });
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
    return `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  // Account lockout protection methods
  private async checkAccountLockout(username: string): Promise<void> {
    const lockoutKey = `auth:lockout:${username}`;
    const attemptsKey = `auth:attempts:${username}`;

    const lockoutUntil = await this.redis.get(lockoutKey);
    if (lockoutUntil) {
      const lockoutTime = parseInt(lockoutUntil);
      if (Date.now() < lockoutTime) {
        const remainingMinutes = Math.ceil((lockoutTime - Date.now()) / (60 * 1000));
        throw new Error(`Account locked due to too many failed attempts. Try again in ${remainingMinutes} minutes.`);
      } else {
        // Lockout expired, clear it
        await this.redis.del(lockoutKey);
        await this.redis.del(attemptsKey);
      }
    }
  }

  private async recordFailedAttempt(username: string): Promise<void> {
    const attemptsKey = `auth:attempts:${username}`;
    const attempts = await this.redis.incr(attemptsKey);

    // Set expiry on attempts counter
    await this.redis.expire(attemptsKey, 15 * 60); // 15 minutes

    if (attempts >= this.maxLoginAttempts) {
      // Lock account
      const lockoutKey = `auth:lockout:${username}`;
      const lockoutUntil = Date.now() + this.lockoutDuration;
      await this.redis.setex(lockoutKey, Math.ceil(this.lockoutDuration / 1000), lockoutUntil.toString());

      logger.warn('Account locked due to too many failed attempts', { username, attempts });
    }
  }

  private async clearFailedAttempts(username: string): Promise<void> {
    const attemptsKey = `auth:attempts:${username}`;
    await this.redis.del(attemptsKey);
  }

  // Administrative method to unlock account
  async unlockAccount(username: string): Promise<void> {
    const lockoutKey = `auth:lockout:${username}`;
    const attemptsKey = `auth:attempts:${username}`;

    await this.redis.del(lockoutKey);
    await this.redis.del(attemptsKey);

    logger.info('Account unlocked by administrator', { username });
  }
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
      const authService = new AuthService();
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
      logger.error('Authentication middleware error', { error });
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

      const authService = new AuthService();
      const allowed = await authService.authorize(req.user, resource, action);

      if (!allowed) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      next();
    } catch (error) {
      logger.error('Authorization middleware error', { error });
      return res.status(500).json({ error: 'Authorization failed' });
    }
  };
}