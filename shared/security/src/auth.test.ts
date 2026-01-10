// Authentication Service Tests
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { AuthService, User } from './auth';

// Mock dependencies
jest.mock('jsonwebtoken');
jest.mock('bcrypt');
jest.mock('../../core/src/logger');

import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { createLogger } from '../../core/src/logger';

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
};

(createLogger as jest.Mock).mockReturnValue(mockLogger);

describe('AuthService', () => {
  let authService: AuthService;
  let mockUser: User;

  beforeEach(() => {
    jest.clearAllMocks();
    authService = new AuthService();

    mockUser = {
      id: 'user_123',
      username: 'testuser',
      email: 'test@example.com',
      roles: ['user'],
      permissions: ['read:opportunities'],
      isActive: true,
      lastLogin: new Date()
    };

    // Mock environment variables
    process.env.JWT_SECRET = 'test-secret';
    process.env.JWT_EXPIRES_IN = '1h';
    process.env.BCRYPT_ROUNDS = '8';
  });

  describe('register', () => {
    it('should register a new user successfully', async () => {
      const registerRequest = {
        username: 'newuser',
        email: 'new@example.com',
        password: 'StrongPass123!'
      };

      // Mock database operations
      const mockFindUserByUsername = jest.spyOn(authService as any, 'findUserByUsername').mockResolvedValue(null);
      const mockFindUserByEmail = jest.spyOn(authService as any, 'findUserByEmail').mockResolvedValue(null);
      const mockSaveUser = jest.spyOn(authService as any, 'saveUser').mockResolvedValue(undefined);

      (bcrypt.hash as jest.Mock).mockResolvedValue('hashed_password');

      const result = await authService.register(registerRequest);

      expect(result.username).toBe(registerRequest.username);
      expect(result.email).toBe(registerRequest.email);
      expect(result.roles).toEqual(['user']);
      expect(mockSaveUser).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith('User registered successfully', expect.any(Object));
    });

    it('should reject weak passwords', async () => {
      const registerRequest = {
        username: 'newuser',
        email: 'new@example.com',
        password: 'weak'
      };

      await expect(authService.register(registerRequest)).rejects.toThrow('Password must be at least 8 characters');
    });

    it('should reject duplicate usernames', async () => {
      const registerRequest = {
        username: 'existinguser',
        email: 'new@example.com',
        password: 'StrongPass123!'
      };

      jest.spyOn(authService as any, 'findUserByUsername').mockResolvedValue(mockUser);

      await expect(authService.register(registerRequest)).rejects.toThrow('Username already exists');
    });

    it('should validate email format', async () => {
      const registerRequest = {
        username: 'newuser',
        email: 'invalid-email',
        password: 'StrongPass123!'
      };

      await expect(authService.register(registerRequest)).rejects.toThrow('Invalid email address');
    });
  });

  describe('login', () => {
    it('should authenticate user successfully', async () => {
      const loginRequest = {
        username: 'testuser',
        password: 'correctpassword'
      };

      // Mock database operations
      const mockFindUserByUsername = jest.spyOn(authService as any, 'findUserByUsername').mockResolvedValue(mockUser);
      const mockGetUserPasswordHash = jest.spyOn(authService as any, 'getUserPasswordHash').mockResolvedValue('hashed_password');
      const mockUpdateUser = jest.spyOn(authService as any, 'updateUser').mockResolvedValue(undefined);

      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      (jwt.sign as jest.Mock).mockReturnValue('mock_jwt_token');

      const result = await authService.login(loginRequest);

      expect(result.user).toEqual(mockUser);
      expect(result.token).toBe('mock_jwt_token');
      expect(mockUpdateUser).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith('User logged in successfully', expect.any(Object));
    });

    it('should reject invalid credentials', async () => {
      const loginRequest = {
        username: 'testuser',
        password: 'wrongpassword'
      };

      jest.spyOn(authService as any, 'findUserByUsername').mockResolvedValue(mockUser);
      jest.spyOn(authService as any, 'getUserPasswordHash').mockResolvedValue('hashed_password');

      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(authService.login(loginRequest)).rejects.toThrow('Invalid credentials');
      expect(mockLogger.warn).toHaveBeenCalledWith('Failed login attempt', { username: 'testuser' });
    });

    it('should reject inactive users', async () => {
      const inactiveUser = { ...mockUser, isActive: false };
      const loginRequest = {
        username: 'testuser',
        password: 'correctpassword'
      };

      jest.spyOn(authService as any, 'findUserByUsername').mockResolvedValue(inactiveUser);

      await expect(authService.login(loginRequest)).rejects.toThrow('Invalid credentials');
    });
  });

  describe('validateToken', () => {
    it('should validate valid token', async () => {
      const token = 'valid.jwt.token';
      const decodedToken = {
        userId: 'user_123',
        username: 'testuser',
        roles: ['user'],
        permissions: ['read:opportunities'],
        iat: Date.now() / 1000,
        exp: (Date.now() + 3600000) / 1000 // 1 hour from now
      };

      (jwt.verify as jest.Mock).mockReturnValue(decodedToken);
      jest.spyOn(authService as any, 'findUserById').mockResolvedValue(mockUser);

      const result = await authService.validateToken(token);

      expect(result).toEqual(mockUser);
      expect(jwt.verify).toHaveBeenCalledWith(token, 'test-secret');
    });

    it('should reject expired tokens', async () => {
      const token = 'expired.jwt.token';
      const decodedToken = {
        userId: 'user_123',
        exp: (Date.now() - 1000) / 1000 // 1 second ago
      };

      (jwt.verify as jest.Mock).mockReturnValue(decodedToken);

      const result = await authService.validateToken(token);

      expect(result).toBeNull();
    });

    it('should reject tokens for inactive users', async () => {
      const token = 'valid.jwt.token';
      const inactiveUser = { ...mockUser, isActive: false };
      const decodedToken = {
        userId: 'user_123',
        exp: (Date.now() + 3600000) / 1000
      };

      (jwt.verify as jest.Mock).mockReturnValue(decodedToken);
      jest.spyOn(authService as any, 'findUserById').mockResolvedValue(inactiveUser);

      const result = await authService.validateToken(token);

      expect(result).toBeNull();
    });

    it('should handle invalid tokens', async () => {
      const token = 'invalid.jwt.token';

      (jwt.verify as jest.Mock).mockImplementation(() => {
        throw new Error('Invalid token');
      });

      const result = await authService.validateToken(token);

      expect(result).toBeNull();
      expect(mockLogger.debug).toHaveBeenCalledWith('Token validation failed', expect.any(Object));
    });
  });

  describe('authorize', () => {
    it('should authorize user with direct permission', async () => {
      const user = { ...mockUser, permissions: ['write:orders'] };

      const result = await authService.authorize(user, 'orders', 'write');

      expect(result).toBe(true);
    });

    it('should authorize user with role-based permission', async () => {
      const user = { ...mockUser, roles: ['trader'] };

      // Mock role permissions
      jest.spyOn(authService as any, 'getRolePermissions').mockResolvedValue(['write:orders']);

      const result = await authService.authorize(user, 'orders', 'write');

      expect(result).toBe(true);
    });

    it('should deny authorization without permission', async () => {
      const user = { ...mockUser, permissions: ['read:opportunities'] };

      const result = await authService.authorize(user, 'orders', 'write');

      expect(result).toBe(false);
    });

    it('should support wildcard permissions', async () => {
      const user = { ...mockUser, permissions: ['write:*'] };

      const result = await authService.authorize(user, 'orders', 'write');

      expect(result).toBe(true);
    });
  });

  describe('password validation', () => {
    it('should validate strong passwords', () => {
      const isStrong = (authService as any).isStrongPassword('StrongPass123!');
      expect(isStrong).toBe(true);
    });

    it('should reject weak passwords', () => {
      expect((authService as any).isStrongPassword('weak')).toBe(false);
      expect((authService as any).isStrongPassword('nouppercase123!')).toBe(false);
      expect((authService as any).isStrongPassword('NOLOWERCASE123!')).toBe(false);
      expect((authService as any).isStrongPassword('NoNumbers!')).toBe(false);
      expect((authService as any).isStrongPassword('NoSpecial123')).toBe(false);
    });
  });

  describe('email validation', () => {
    it('should validate correct email formats', () => {
      expect((authService as any).isValidEmail('test@example.com')).toBe(true);
      expect((authService as any).isValidEmail('user.name+tag@domain.co.uk')).toBe(true);
    });

    it('should reject invalid email formats', () => {
      expect((authService as any).isValidEmail('invalid-email')).toBe(false);
      expect((authService as any).isValidEmail('@domain.com')).toBe(false);
      expect((authService as any).isValidEmail('user@')).toBe(false);
    });
  });
});