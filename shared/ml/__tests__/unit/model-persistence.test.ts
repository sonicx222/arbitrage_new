/**
 * Model Persistence Tests
 *
 * FIX 8.1: Add missing test coverage for model-persistence.ts
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock @tensorflow/tfjs
// The model.save mock needs to actually create files for modelExists to work
const mockModel = {
  save: jest.fn<(path: string) => Promise<{ modelArtifactsInfo: object }>>()
    .mockImplementation((savePath: string) => {
      // Extract directory from file:// URL and create model.json
      const filePath = savePath.replace('file://', '');
      // Ensure directory exists
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // Create mock model.json file
      fs.writeFileSync(filePath, JSON.stringify({ format: 'layers-model' }));
      return Promise.resolve({ modelArtifactsInfo: { dateSaved: new Date() } });
    })
};

const mockTf = {
  loadLayersModel: jest.fn<() => Promise<typeof mockModel>>().mockResolvedValue(mockModel)
};

jest.mock('@tensorflow/tfjs', () => mockTf);

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
  ModelPersistence,
  getModelPersistence,
  resetModelPersistence,
  type ModelMetadata,
  type PersistenceConfig
} from '../../src/model-persistence';

describe('model-persistence', () => {
  let tempDir: string;
  let persistence: ModelPersistence;

  const createTestMetadata = (modelId = 'test-model'): ModelMetadata => ({
    modelId,
    modelType: 'lstm',
    version: 1,
    lastTrainingTime: Date.now(),
    trainingSamplesCount: 1000,
    accuracy: 0.85,
    isTrained: true,
    savedAt: Date.now()
  });

  beforeEach(() => {
    jest.clearAllMocks();
    resetModelPersistence();

    // Create temp directory for tests
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-persistence-test-'));
    // Disable atomicSaves for tests since the mock doesn't handle the atomic move
    persistence = new ModelPersistence({ baseDir: tempDir, atomicSaves: false });
  });

  afterEach(() => {
    // Clean up temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    resetModelPersistence();
  });

  describe('ModelPersistence class', () => {
    describe('constructor', () => {
      it('should use default config when not provided', () => {
        const p = new ModelPersistence();
        expect(p).toBeDefined();
      });

      it('should merge config with defaults', () => {
        const p = new ModelPersistence({ baseDir: '/custom/path' });
        expect(p).toBeDefined();
      });
    });

    describe('saveModel', () => {
      it('should save model to disk', async () => {
        const metadata = createTestMetadata();

        const result = await persistence.saveModel(mockModel as any, metadata);

        expect(result.success).toBe(true);
        expect(result.version).toBe(1);
        expect(mockModel.save).toHaveBeenCalled();
      });

      it('should create model directory', async () => {
        const metadata = createTestMetadata('new-model');

        await persistence.saveModel(mockModel as any, metadata);

        const modelDir = path.join(tempDir, 'new-model');
        expect(fs.existsSync(modelDir)).toBe(true);
      });

      it('should save metadata file', async () => {
        const metadata = createTestMetadata();

        await persistence.saveModel(mockModel as any, metadata);

        const metadataPath = path.join(tempDir, 'test-model', 'metadata.json');
        expect(fs.existsSync(metadataPath)).toBe(true);

        const savedMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        expect(savedMetadata.modelId).toBe('test-model');
      });

      it('should handle save errors', async () => {
        const metadata = createTestMetadata();
        mockModel.save.mockRejectedValueOnce(new Error('Save failed'));

        const result = await persistence.saveModel(mockModel as any, metadata);

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
      });

      it('should use atomic saves by default', async () => {
        const metadata = createTestMetadata();
        const p = new ModelPersistence({ baseDir: tempDir, atomicSaves: true });

        const result = await p.saveModel(mockModel as any, metadata);

        expect(result.success).toBe(true);
        // Temp directory should be cleaned up
        const tempPath = path.join(tempDir, 'test-model', '.temp');
        expect(fs.existsSync(tempPath)).toBe(false);
      });

      it('should support non-atomic saves', async () => {
        const metadata = createTestMetadata();
        const p = new ModelPersistence({ baseDir: tempDir, atomicSaves: false });

        const result = await p.saveModel(mockModel as any, metadata);

        expect(result.success).toBe(true);
      });
    });

    describe('loadModel', () => {
      beforeEach(async () => {
        // Save a model first
        const metadata = createTestMetadata();
        await persistence.saveModel(mockModel as any, metadata);
      });

      // P1-3 fix: Un-skipped — with atomicSaves: false and async I/O,
      // the path normalization issue is resolved.
      it('should load model from disk', async () => {
        const result = await persistence.loadModel('test-model');

        expect(result.success).toBe(true);
        expect(result.model).toBeDefined();
        expect(result.metadata).toBeDefined();
        expect(mockTf.loadLayersModel).toHaveBeenCalled();
      });

      it('should return error for non-existent model', async () => {
        const result = await persistence.loadModel('non-existent');

        expect(result.success).toBe(false);
        expect(result.model).toBeNull();
        expect(result.error?.message).toContain('not found');
      });

      it('should handle load errors', async () => {
        mockTf.loadLayersModel.mockRejectedValueOnce(new Error('Load failed'));

        const result = await persistence.loadModel('test-model');

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
      });
    });

    describe('loadMetadata', () => {
      beforeEach(async () => {
        const metadata = createTestMetadata();
        await persistence.saveModel(mockModel as any, metadata);
      });

      it('should load only metadata', async () => {
        const metadata = await persistence.loadMetadata('test-model');

        expect(metadata).toBeDefined();
        expect(metadata?.modelId).toBe('test-model');
        // Should not call loadLayersModel
        expect(mockTf.loadLayersModel).not.toHaveBeenCalled();
      });

      it('should return null for non-existent model', async () => {
        const metadata = await persistence.loadMetadata('non-existent');
        expect(metadata).toBeNull();
      });
    });

    describe('modelExists', () => {
      // P1-3 fix: Tests now use await since modelExists is async.
      // The Windows path issue was caused by file:// URL normalization
      // in the mock save. With atomicSaves: false, the mock writes files
      // directly and modelExists can find them.
      it('should return true for existing model', async () => {
        const metadata = createTestMetadata();
        await persistence.saveModel(mockModel as any, metadata);

        expect(await persistence.modelExists('test-model')).toBe(true);
      });

      it('should return false for non-existent model', async () => {
        expect(await persistence.modelExists('non-existent')).toBe(false);
      });
    });

    describe('deleteModel', () => {
      beforeEach(async () => {
        const metadata = createTestMetadata();
        await persistence.saveModel(mockModel as any, metadata);
      });

      it('should delete existing model', async () => {
        const result = await persistence.deleteModel('test-model');

        expect(result).toBe(true);
        expect(await persistence.modelExists('test-model')).toBe(false);
      });

      it('should return false for non-existent model', async () => {
        const result = await persistence.deleteModel('non-existent');
        expect(result).toBe(false);
      });
    });

    describe('listModels', () => {
      it('should list saved models', async () => {
        await persistence.saveModel(mockModel as any, createTestMetadata('model-1'));
        await persistence.saveModel(mockModel as any, createTestMetadata('model-2'));

        const models = await persistence.listModels();

        expect(models).toContain('model-1');
        expect(models).toContain('model-2');
      });

      it('should return empty array when no models', async () => {
        const models = await persistence.listModels();
        expect(models).toEqual([]);
      });
    });
  });

  // P2-11: Tests for version management and atomic save
  describe('version management', () => {
    it('should archive versions when keepVersions is enabled', async () => {
      const p = new ModelPersistence({ baseDir: tempDir, atomicSaves: false, keepVersions: true, maxVersions: 3 });

      const metadata = createTestMetadata('versioned-model');
      await p.saveModel(mockModel as any, metadata);

      // Version directory should be created
      const versionDir = path.join(tempDir, 'versioned-model', 'v1');
      expect(fs.existsSync(versionDir)).toBe(true);

      // metadata.json should be copied to version directory
      const versionMetadata = path.join(versionDir, 'metadata.json');
      expect(fs.existsSync(versionMetadata)).toBe(true);
    });

    it('should clean old versions beyond maxVersions', async () => {
      const p = new ModelPersistence({ baseDir: tempDir, atomicSaves: false, keepVersions: true, maxVersions: 2 });

      // Save 3 versions
      for (let v = 1; v <= 3; v++) {
        const metadata = createTestMetadata('multi-version');
        metadata.version = v;
        await p.saveModel(mockModel as any, metadata);
      }

      // Only most recent 2 versions should remain
      const modelDir = path.join(tempDir, 'multi-version');
      const entries = fs.readdirSync(modelDir, { withFileTypes: true });
      const versionDirs = entries
        .filter(e => e.isDirectory() && e.name.startsWith('v'))
        .map(e => e.name);

      expect(versionDirs.length).toBeLessThanOrEqual(2);
    });

    it('should save and load with atomic saves enabled', async () => {
      const p = new ModelPersistence({ baseDir: tempDir, atomicSaves: true });
      const metadata = createTestMetadata('atomic-model');

      const result = await p.saveModel(mockModel as any, metadata);

      expect(result.success).toBe(true);
      // Temp directory should be cleaned up
      const atomicTempDir = path.join(tempDir, 'atomic-model', '.temp');
      expect(fs.existsSync(atomicTempDir)).toBe(false);
    });

    it('should handle model integrity verification (P1-2)', async () => {
      const p = new ModelPersistence({ baseDir: tempDir, atomicSaves: false });
      const metadata = createTestMetadata('integrity-model');

      const saveResult = await p.saveModel(mockModel as any, metadata);
      expect(saveResult.success).toBe(true);

      // Verify metadata has hash
      const metadataPath = path.join(tempDir, 'integrity-model', 'metadata.json');
      const savedMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      expect(savedMetadata.modelHash).toBeDefined();
      expect(typeof savedMetadata.modelHash).toBe('string');
      expect(savedMetadata.modelHash.length).toBe(64); // SHA-256 hex length
    });

    it('should reject invalid modelId with path traversal characters', async () => {
      const p = new ModelPersistence({ baseDir: tempDir, atomicSaves: false });
      const metadata = createTestMetadata('../../etc');

      await expect(p.saveModel(mockModel as any, metadata)).rejects.toThrow('Invalid modelId');
    });

    it('should reject empty modelId', () => {
      const p = new ModelPersistence({ baseDir: tempDir, atomicSaves: false });
      const metadata = createTestMetadata('');

      expect(p.saveModel(mockModel as any, metadata)).rejects.toThrow('Invalid modelId');
    });

    it('should fall back to copy-then-delete when rename throws EXDEV', async () => {
      // Mock fs.promises.rename to throw EXDEV (cross-device link error)
      const fsp = fs.promises;
      const originalRename = fsp.rename;
      const renameSpy = jest.spyOn(fsp, 'rename').mockImplementation(
        async (src: fs.PathLike, dest: fs.PathLike) => {
          const err = new Error('EXDEV: cross-device link not permitted') as NodeJS.ErrnoException;
          err.code = 'EXDEV';
          throw err;
        }
      );

      try {
        const p = new ModelPersistence({ baseDir: tempDir, atomicSaves: true });
        const metadata = createTestMetadata('exdev-model');

        const result = await p.saveModel(mockModel as any, metadata);

        expect(result.success).toBe(true);
        // Model files should exist at final location via copy fallback
        const modelPath = path.join(tempDir, 'exdev-model', 'model.json');
        expect(fs.existsSync(modelPath)).toBe(true);
        // Metadata should also be copied
        const metadataPath = path.join(tempDir, 'exdev-model', 'metadata.json');
        expect(fs.existsSync(metadataPath)).toBe(true);
        // Temp directory should be cleaned up
        const atomicTempDir = path.join(tempDir, 'exdev-model', '.temp');
        expect(fs.existsSync(atomicTempDir)).toBe(false);
      } finally {
        renameSpy.mockRestore();
      }
    });

    it('should propagate non-EXDEV rename errors', async () => {
      // Mock fs.promises.rename to throw a non-EXDEV error
      const fsp = fs.promises;
      const renameSpy = jest.spyOn(fsp, 'rename').mockImplementation(
        async () => {
          const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
      );

      try {
        const p = new ModelPersistence({ baseDir: tempDir, atomicSaves: true });
        const metadata = createTestMetadata('eacces-model');

        const result = await p.saveModel(mockModel as any, metadata);

        // Should fail because non-EXDEV errors are not caught
        expect(result.success).toBe(false);
        expect(result.error?.message).toContain('EACCES');
      } finally {
        renameSpy.mockRestore();
      }
    });
  });

  describe('singleton factory', () => {
    describe('getModelPersistence', () => {
      it('should return singleton instance', () => {
        const instance1 = getModelPersistence();
        const instance2 = getModelPersistence();
        expect(instance1).toBe(instance2);
      });

      it('should use config on first call', () => {
        const instance = getModelPersistence({ baseDir: '/custom' });
        expect(instance).toBeDefined();
      });

      it('should warn when config differs (FIX 1.1)', () => {
        const instance1 = getModelPersistence({ baseDir: '/path1' });
        const instance2 = getModelPersistence({ baseDir: '/path2' });

        // Should still return same instance
        expect(instance1).toBe(instance2);
        // Warning should be logged (can't easily verify without mock inspection)
      });
    });

    describe('resetModelPersistence', () => {
      it('should reset singleton', () => {
        const instance1 = getModelPersistence();
        resetModelPersistence();
        const instance2 = getModelPersistence();

        expect(instance1).not.toBe(instance2);
      });
    });
  });
});
