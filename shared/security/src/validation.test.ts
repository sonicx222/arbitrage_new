// Validation Middleware Tests
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import Joi from 'joi';
import { validateArbitrageRequest, validateHealthRequest, validateMetricsRequest, validateLoginRequest, validateRegisterRequest, sanitizeInput } from './validation';

// Mock logger
jest.mock('../../core/src/logger');
import { createLogger } from '../../core/src/logger';

const mockLogger = {
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn()
};

(createLogger as jest.Mock).mockReturnValue(mockLogger);

describe('Validation Middleware', () => {
  let mockReq: any;
  let mockRes: any;
  let mockNext: jest.Mock;

  beforeEach(() => {
    mockReq = {
      body: {},
      query: {},
      ip: '127.0.0.1'
    };

    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };

    mockNext = jest.fn();
  });

  describe('validateArbitrageRequest', () => {
    it('should validate valid arbitrage request', () => {
      mockReq.body = {
        sourceChain: 'ethereum',
        targetChain: 'bsc',
        sourceDex: 'uniswap',
        targetDex: 'pancakeswap',
        tokenAddress: '0xa0b86a33e6fb38c74e6f8f3f8e8b8a2b2b2b2b2b2',
        amount: 1.5,
        slippage: 0.5
      };

      validateArbitrageRequest(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.body).toEqual(mockReq.body);
    });

    it('should reject invalid chain', () => {
      mockReq.body = {
        sourceChain: 'invalid_chain',
        targetChain: 'bsc',
        sourceDex: 'uniswap',
        targetDex: 'pancakeswap',
        tokenAddress: '0xa0b86a33e6fb38c74e6f8f3f8e8b8a2b2b2b2b2b2',
        amount: 1.5
      };

      validateArbitrageRequest(mockReq, mockRes, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
        error: 'Validation failed'
      }));
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should reject invalid token address', () => {
      mockReq.body = {
        sourceChain: 'ethereum',
        targetChain: 'bsc',
        sourceDex: 'uniswap',
        targetDex: 'pancakeswap',
        tokenAddress: 'invalid_address',
        amount: 1.5
      };

      validateArbitrageRequest(mockReq, mockRes, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
        error: 'Validation failed'
      }));
    });

    it('should reject amount out of range', () => {
      mockReq.body = {
        sourceChain: 'ethereum',
        targetChain: 'bsc',
        sourceDex: 'uniswap',
        targetDex: 'pancakeswap',
        tokenAddress: '0xa0b86a33e6fb38c74e6f8f3f8e8b8a2b2b2b2b2b2',
        amount: -1 // Negative amount
      };

      validateArbitrageRequest(mockReq, mockRes, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    it('should set default slippage', () => {
      mockReq.body = {
        sourceChain: 'ethereum',
        targetChain: 'bsc',
        sourceDex: 'uniswap',
        targetDex: 'pancakeswap',
        tokenAddress: '0xa0b86a33e6fb38c74e6f8f3f8e8b8a2b2b2b2b2b2',
        amount: 1.5
        // No slippage provided
      };

      validateArbitrageRequest(mockReq, mockRes, mockNext);

      expect(mockReq.body.slippage).toBe(1.0);
    });
  });

  describe('validateHealthRequest', () => {
    it('should validate valid health request', () => {
      mockReq.query = {
        service: 'bsc-detector',
        detailed: true
      };

      validateHealthRequest(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.query.detailed).toBe(true);
    });

    it('should set default values', () => {
      mockReq.query = {};

      validateHealthRequest(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.query.detailed).toBe(false);
    });

    it('should reject invalid service name', () => {
      mockReq.query = {
        service: 'a'.repeat(101) // Too long
      };

      validateHealthRequest(mockReq, mockRes, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(400);
    });
  });

  describe('validateMetricsRequest', () => {
    it('should validate valid metrics request', () => {
      mockReq.query = {
        service: 'bsc-detector',
        limit: 500
      };

      validateMetricsRequest(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.query.limit).toBe(500);
    });

    it('should set default limit', () => {
      mockReq.query = {
        service: 'bsc-detector'
      };

      validateMetricsRequest(mockReq, mockRes, mockNext);

      expect(mockReq.query.limit).toBe(100);
    });

    it('should validate date ranges', () => {
      mockReq.query = {
        service: 'bsc-detector',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-02T00:00:00Z'
      };

      validateMetricsRequest(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should reject invalid date order', () => {
      mockReq.query = {
        service: 'bsc-detector',
        startTime: '2024-01-02T00:00:00Z',
        endTime: '2024-01-01T00:00:00Z' // Before start time
      };

      validateMetricsRequest(mockReq, mockRes, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(400);
    });
  });

  describe('validateLoginRequest', () => {
    it('should validate valid login request', () => {
      mockReq.body = {
        username: 'testuser',
        password: 'password123'
      };

      validateLoginRequest(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should reject missing username', () => {
      mockReq.body = {
        password: 'password123'
      };

      validateLoginRequest(mockReq, mockRes, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    it('should reject short username', () => {
      mockReq.body = {
        username: 'ab', // Too short
        password: 'password123'
      };

      validateLoginRequest(mockReq, mockRes, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(400);
    });
  });

  describe('validateRegisterRequest', () => {
    it('should validate valid register request', () => {
      mockReq.body = {
        username: 'newuser',
        email: 'user@example.com',
        password: 'StrongPass123!'
      };

      validateRegisterRequest(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should reject invalid email', () => {
      mockReq.body = {
        username: 'newuser',
        email: 'invalid-email',
        password: 'StrongPass123!'
      };

      validateRegisterRequest(mockReq, mockRes, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    it('should reject short password', () => {
      mockReq.body = {
        username: 'newuser',
        email: 'user@example.com',
        password: 'short' // Too short
      };

      validateRegisterRequest(mockReq, mockRes, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(400);
    });
  });

  describe('sanitizeInput', () => {
    it('should sanitize XSS payloads in body', () => {
      mockReq.body = {
        comment: '<script>alert("xss")</script>safe content',
        nested: {
          value: 'javascript:alert("xss")'
        }
      };

      sanitizeInput(mockReq, mockRes, mockNext);

      expect(mockReq.body.comment).not.toContain('<script>');
      expect(mockReq.body.nested.value).not.toContain('javascript:');
      expect(mockNext).toHaveBeenCalled();
    });

    it('should sanitize XSS payloads in query', () => {
      mockReq.query = {
        search: '<img src=x onerror=alert("xss")>',
        filter: 'onclick=alert("xss")'
      };

      sanitizeInput(mockReq, mockRes, mockNext);

      expect(mockReq.query.search).not.toContain('onerror=');
      expect(mockReq.query.filter).not.toContain('onclick=');
      expect(mockNext).toHaveBeenCalled();
    });

    it('should handle arrays and nested objects', () => {
      mockReq.body = {
        items: [
          'safe',
          '<script>evil()</script>',
          { nested: 'javascript:evil()' }
        ]
      };

      sanitizeInput(mockReq, mockRes, mockNext);

      expect(mockReq.body.items[1]).not.toContain('<script>');
      expect(mockReq.body.items[2].nested).not.toContain('javascript:');
      expect(mockNext).toHaveBeenCalled();
    });
  });
});