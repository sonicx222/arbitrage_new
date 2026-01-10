"use strict";
// Authentication and Authorization Service
// Implements JWT-based authentication with role-based access control
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthService = void 0;
exports.authenticate = authenticate;
exports.authorize = authorize;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const bcrypt_1 = __importDefault(require("bcrypt"));
const logger_1 = require("../../core/src/logger");
const redis_1 = require("../../core/src/redis");
const logger = (0, logger_1.createLogger)('auth-service');
class AuthService {
    constructor() {
        this.maxLoginAttempts = 5;
        this.lockoutDuration = 15 * 60 * 1000; // 15 minutes
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
    async initializeRedis() {
        try {
            this.redis = await (0, redis_1.getRedisClient)();
        }
        catch (error) {
            logger.error('Failed to initialize Redis for authentication', { error });
            throw new Error('Authentication service requires Redis for security features');
        }
    }
    async register(request) {
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
        const passwordHash = await bcrypt_1.default.hash(request.password, this.bcryptRounds);
        // Create user
        const user = {
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
    async login(request) {
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
        const isValidPassword = await bcrypt_1.default.compare(request.password, passwordHash);
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
    async validateToken(token) {
        try {
            // Check if token is blacklisted
            const blacklisted = await this.redis.get(`auth:blacklist:${token}`);
            if (blacklisted) {
                logger.debug('Token validation failed - token blacklisted');
                return null;
            }
            const decoded = jsonwebtoken_1.default.verify(token, this.jwtSecret);
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
        }
        catch (error) {
            logger.debug('Token validation failed', { error: error.message });
            return null;
        }
    }
    async authorize(user, resource, action) {
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
    async refreshToken(token) {
        const user = await this.validateToken(token);
        if (!user) {
            throw new Error('Invalid token');
        }
        return this.generateToken(user);
    }
    async logout(token) {
        try {
            // Decode token without verification to get expiry
            const decoded = jsonwebtoken_1.default.decode(token);
            if (decoded && decoded.exp) {
                // Add token to blacklist with remaining TTL
                const ttl = Math.max(0, decoded.exp - Math.floor(Date.now() / 1000));
                if (ttl > 0) {
                    await this.redis.setex(`auth:blacklist:${token}`, ttl, 'revoked');
                    logger.info('Token blacklisted on logout', { userId: decoded.userId, ttl });
                }
            }
        }
        catch (error) {
            logger.error('Error blacklisting token on logout', { error });
            // Don't throw - logout should succeed even if blacklisting fails
        }
        logger.info('User logged out successfully');
    }
    generateToken(user) {
        const payload = {
            userId: user.id,
            username: user.username,
            roles: user.roles,
            permissions: user.permissions
        };
        return jsonwebtoken_1.default.sign(payload, this.jwtSecret, { expiresIn: this.jwtExpiresIn });
    }
    validateRegistrationRequest(request) {
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
    validateLoginRequest(request) {
        if (!request.username || !request.password) {
            throw new Error('Username and password are required');
        }
    }
    isValidEmail(email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
    }
    isStrongPassword(password) {
        // At least 8 characters, 1 uppercase, 1 lowercase, 1 number, 1 special character
        const strongPasswordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
        return strongPasswordRegex.test(password);
    }
    matchesPermission(userPermission, requiredPermission) {
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
    async findUserByUsername(username) {
        // Mock implementation - replace with database query
        logger.debug('Finding user by username', { username });
        return null;
    }
    async findUserByEmail(email) {
        // Mock implementation - replace with database query
        logger.debug('Finding user by email', { email });
        return null;
    }
    async findUserById(userId) {
        // Mock implementation - replace with database query
        logger.debug('Finding user by ID', { userId });
        return null;
    }
    async getUserPasswordHash(userId) {
        // Mock implementation - replace with database query
        logger.debug('Getting user password hash', { userId });
        return '';
    }
    async saveUser(user, passwordHash) {
        // Mock implementation - replace with database save
        logger.info('Saving user', { userId: user.id, username: user.username });
    }
    async updateUser(user) {
        // Mock implementation - replace with database update
        logger.debug('Updating user', { userId: user.id });
    }
    async getRolePermissions(role) {
        // Mock role-based permissions - replace with database lookup
        const rolePermissions = {
            'admin': ['*'],
            'trader': ['read:*', 'write:orders', 'execute:arbitrage'],
            'viewer': ['read:*'],
            'user': ['read:opportunities', 'read:health', 'read:metrics']
        };
        return rolePermissions[role] || [];
    }
    generateUserId() {
        return `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    // Account lockout protection methods
    async checkAccountLockout(username) {
        const lockoutKey = `auth:lockout:${username}`;
        const attemptsKey = `auth:attempts:${username}`;
        const lockoutUntil = await this.redis.get(lockoutKey);
        if (lockoutUntil) {
            const lockoutTime = parseInt(lockoutUntil);
            if (Date.now() < lockoutTime) {
                const remainingMinutes = Math.ceil((lockoutTime - Date.now()) / (60 * 1000));
                throw new Error(`Account locked due to too many failed attempts. Try again in ${remainingMinutes} minutes.`);
            }
            else {
                // Lockout expired, clear it
                await this.redis.del(lockoutKey);
                await this.redis.del(attemptsKey);
            }
        }
    }
    async recordFailedAttempt(username) {
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
    async clearFailedAttempts(username) {
        const attemptsKey = `auth:attempts:${username}`;
        await this.redis.del(attemptsKey);
    }
    // Administrative method to unlock account
    async unlockAccount(username) {
        const lockoutKey = `auth:lockout:${username}`;
        const attemptsKey = `auth:attempts:${username}`;
        await this.redis.del(lockoutKey);
        await this.redis.del(attemptsKey);
        logger.info('Account unlocked by administrator', { username });
    }
}
exports.AuthService = AuthService;
// Middleware for authentication
function authenticate(required = true) {
    return async (req, res, next) => {
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
        }
        catch (error) {
            logger.error('Authentication middleware error', { error });
            return res.status(500).json({ error: 'Authentication failed' });
        }
    };
}
// Middleware for authorization
function authorize(resource, action) {
    return async (req, res, next) => {
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
        }
        catch (error) {
            logger.error('Authorization middleware error', { error });
            return res.status(500).json({ error: 'Authorization failed' });
        }
    };
}
//# sourceMappingURL=auth.js.map