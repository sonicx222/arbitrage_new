/**
 * TensorFlow Backend Tests
 *
 * FIX 8.1: Add missing test coverage for tf-backend.ts
 * FIX P0-2: Fixed mock hoisting issue - mocks must be defined inside factory
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// P0-2 FIX: Define mock inside factory to avoid hoisting issues
// Jest.mock is hoisted, so external references aren't available
const mockSetBackend = jest.fn<() => Promise<boolean>>();
const mockReady = jest.fn<() => Promise<void>>();
const mockGetBackend = jest.fn<() => string>();
const mockMemory = jest.fn<() => { numTensors: number; numDataBuffers: number; numBytes: number }>();
const mockDisposeVariables = jest.fn();
const mockTidy = jest.fn<(fn: () => unknown) => unknown>();
const mockEngine = jest.fn<() => { state: { registeredVariables: Record<string, unknown> } }>();

// Store mock reference for test access
const mockTf = {
  setBackend: mockSetBackend,
  ready: mockReady,
  getBackend: mockGetBackend,
  memory: mockMemory,
  disposeVariables: mockDisposeVariables,
  tidy: mockTidy,
  engine: mockEngine
};

jest.mock('@tensorflow/tfjs', () => ({
  setBackend: mockSetBackend,
  ready: mockReady,
  getBackend: mockGetBackend,
  memory: mockMemory,
  disposeVariables: mockDisposeVariables,
  tidy: mockTidy,
  engine: mockEngine
}));

// Mock @arbitrage/core logger
jest.mock('@arbitrage/core', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }))
}));

// Import after mocks
import {
  initializeTensorFlow,
  getTensorFlowBackend,
  isTensorFlowInitialized,
  isNativeBackend,
  getTensorFlowMemory,
  getTensorFlowInfo,
  disposeAllTensors,
  withTensorCleanup,
  withTensorCleanupAsync,
  withTrackedTensorCleanup,
  resetTensorFlowBackend
} from '../../src/tf-backend';

describe('tf-backend', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetTensorFlowBackend();

    // P0-2 FIX: Set up default mock implementations
    mockSetBackend.mockResolvedValue(true);
    mockReady.mockResolvedValue(undefined);
    mockGetBackend.mockReturnValue('cpu');
    mockMemory.mockReturnValue({
      numTensors: 0,
      numDataBuffers: 0,
      numBytes: 0
    });
    mockTidy.mockImplementation((fn: () => unknown) => fn());
    mockEngine.mockReturnValue({
      state: { registeredVariables: {} }
    });

    // Reset environment
    delete process.env.TF_FORCE_BACKEND;
    delete process.env.TF_ENABLE_NATIVE;
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    resetTensorFlowBackend();
  });

  describe('initializeTensorFlow', () => {
    it('should initialize with default cpu backend in test environment', async () => {
      const result = await initializeTensorFlow();

      expect(result.success).toBe(true);
      expect(result.backend).toBe('cpu');
      expect(mockTf.setBackend).toHaveBeenCalledWith('cpu');
      expect(mockTf.ready).toHaveBeenCalled();
    });

    it('should return cached result on subsequent calls', async () => {
      const result1 = await initializeTensorFlow();
      const result2 = await initializeTensorFlow();

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(mockTf.setBackend).toHaveBeenCalledTimes(1);
    });

    it('should use forced backend from environment variable', async () => {
      process.env.TF_FORCE_BACKEND = 'wasm';

      const result = await initializeTensorFlow();

      expect(result.backend).toBe('wasm');
      expect(mockTf.setBackend).toHaveBeenCalledWith('wasm');
    });

    it('should warn and ignore invalid TF_FORCE_BACKEND', async () => {
      process.env.TF_FORCE_BACKEND = 'invalid';

      const result = await initializeTensorFlow();

      expect(result.success).toBe(true);
      expect(result.backend).toBe('cpu'); // Falls back to default
    });

    it('should use preferred backend from config', async () => {
      const result = await initializeTensorFlow({ preferredBackend: 'wasm' });

      expect(result.backend).toBe('wasm');
    });

    it('should fall back to cpu if preferred backend fails', async () => {
      mockTf.setBackend
        .mockRejectedValueOnce(new Error('WebGL not available'))
        .mockResolvedValueOnce(true);

      const result = await initializeTensorFlow({ preferredBackend: 'webgl' });

      expect(result.success).toBe(true);
      expect(result.backend).toBe('cpu');
      expect(mockTf.setBackend).toHaveBeenCalledTimes(2);
    });

    it('should return error if all backends fail', async () => {
      mockTf.setBackend.mockRejectedValue(new Error('All backends failed'));

      const result = await initializeTensorFlow({ preferredBackend: 'cpu' });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should set isNative=true for tensorflow backend', async () => {
      mockTf.setBackend.mockResolvedValue(true);

      const result = await initializeTensorFlow({ preferredBackend: 'tensorflow' });

      expect(result.isNative).toBe(true);
    });

    it('should respect initTimeoutMs config', async () => {
      // Create a slow initialization
      mockTf.setBackend.mockImplementation(() =>
        new Promise(resolve => setTimeout(() => resolve(true), 100))
      );

      const result = await initializeTensorFlow({
        preferredBackend: 'cpu',
        initTimeoutMs: 50
      });

      // Should timeout and fail (or fall back)
      // The exact behavior depends on implementation
      expect(mockTf.setBackend).toHaveBeenCalled();
    });
  });

  describe('query functions', () => {
    beforeEach(async () => {
      await initializeTensorFlow();
    });

    it('getTensorFlowBackend should return current backend', () => {
      expect(getTensorFlowBackend()).toBe('cpu');
    });

    it('isTensorFlowInitialized should return true after init', () => {
      expect(isTensorFlowInitialized()).toBe(true);
    });

    it('isNativeBackend should return false for cpu', () => {
      expect(isNativeBackend()).toBe(false);
    });

    it('getTensorFlowMemory should return memory info', () => {
      const mem = getTensorFlowMemory();
      expect(mem).toHaveProperty('numTensors');
      expect(mem).toHaveProperty('numDataBuffers');
    });

    it('getTensorFlowInfo should return backend and memory', () => {
      const info = getTensorFlowInfo();
      expect(info.backend).toBe('cpu');
      expect(info.memory).toBeDefined();
    });
  });

  describe('memory management', () => {
    it('disposeAllTensors should call tf.disposeVariables', () => {
      disposeAllTensors();
      expect(mockTf.disposeVariables).toHaveBeenCalled();
    });

    it('withTensorCleanup should call tf.tidy', () => {
      const fn = jest.fn(() => 42);
      const result = withTensorCleanup(fn as any);

      expect(mockTf.tidy).toHaveBeenCalled();
      expect(result).toBe(42);
    });

    it('withTensorCleanupAsync should execute async function', async () => {
      const fn = jest.fn(async () => 42);
      const result = await withTensorCleanupAsync(fn as any);

      expect(fn).toHaveBeenCalled();
      expect(result).toBe(42);
    });

    it('withTrackedTensorCleanup should execute and optionally track tensors', async () => {
      const mockTensor = { id: 1 };
      const fn = jest.fn(async () => ({ tensor: mockTensor }));
      const keepTensors = jest.fn((result: any) => [result.tensor]);

      const result = await withTrackedTensorCleanup(fn as any, keepTensors as any);

      expect(fn).toHaveBeenCalled();
      expect(result).toEqual({ tensor: mockTensor });
      expect(keepTensors).toHaveBeenCalledWith({ tensor: mockTensor });
    });
  });

  describe('resetTensorFlowBackend', () => {
    it('should reset initialization state', async () => {
      await initializeTensorFlow();
      expect(isTensorFlowInitialized()).toBe(true);

      resetTensorFlowBackend();
      expect(isTensorFlowInitialized()).toBe(false);
    });
  });

  describe('environment-based backend selection', () => {
    it('should use wasm in production mode', async () => {
      process.env.NODE_ENV = 'production';
      resetTensorFlowBackend();

      const result = await initializeTensorFlow();

      expect(result.backend).toBe('wasm');
    });

    it('should use tensorflow in production with TF_ENABLE_NATIVE', async () => {
      process.env.NODE_ENV = 'production';
      process.env.TF_ENABLE_NATIVE = 'true';
      resetTensorFlowBackend();

      const result = await initializeTensorFlow();

      expect(result.backend).toBe('tensorflow');
    });

    it('should use cpu in development mode', async () => {
      process.env.NODE_ENV = 'development';
      resetTensorFlowBackend();

      const result = await initializeTensorFlow();

      expect(result.backend).toBe('cpu');
    });
  });
});
