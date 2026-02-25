/**
 * T4.3 Fix 7.2: Model Persistence Utility
 *
 * Provides save/load functionality for TensorFlow.js models.
 * Enables model persistence across restarts, preventing loss of learned patterns.
 *
 * Features:
 * - File-based storage with configurable paths
 * - Model metadata storage (training time, accuracy, etc.)
 * - Atomic save operations (write to temp, then rename)
 * - Version tracking for model updates
 *
 * @see docs/reports/implementation_plan_v3.md - Phase 4
 */

import * as tf from '@tensorflow/tfjs';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as crypto from 'crypto';
import * as path from 'path';
import { getErrorMessage } from '@arbitrage/core/resilience';
import { createLogger } from '@arbitrage/core';

const logger = createLogger('model-persistence');

// =============================================================================
// Types
// =============================================================================

/**
 * Model metadata stored alongside the model weights.
 */
export interface ModelMetadata {
  /** Model identifier */
  modelId: string;
  /** Model type (e.g., 'lstm', 'orderflow') */
  modelType: string;
  /** Version number (increments on each save) */
  version: number;
  /** Timestamp when model was last trained */
  lastTrainingTime: number;
  /** Number of training samples used */
  trainingSamplesCount: number;
  /** Model accuracy at save time */
  accuracy: number;
  /** Whether model was fully trained */
  isTrained: boolean;
  /** Additional custom metadata */
  custom?: Record<string, unknown>;
  /** Timestamp when metadata was saved */
  savedAt: number;
  /** P1-2: SHA-256 hash of model.json for integrity verification */
  modelHash?: string;
}

/**
 * Configuration for model persistence.
 */
export interface PersistenceConfig {
  /** Base directory for model storage (default: './models') */
  baseDir?: string;
  /** Whether to use atomic saves (default: true) */
  atomicSaves?: boolean;
  /** Whether to keep previous versions (default: false) */
  keepVersions?: boolean;
  /** Maximum versions to keep if keepVersions is true (default: 3) */
  maxVersions?: number;
}

/**
 * Result of a save operation.
 */
export interface SaveResult {
  success: boolean;
  modelPath: string;
  metadataPath: string;
  version: number;
  error?: Error;
}

/**
 * Result of a load operation.
 */
export interface LoadResult {
  success: boolean;
  model: tf.LayersModel | null;
  metadata: ModelMetadata | null;
  error?: Error;
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: Required<PersistenceConfig> = {
  baseDir: './models',
  atomicSaves: true,
  keepVersions: false,
  maxVersions: 3
};

// =============================================================================
// ModelPersistence Class
// =============================================================================

/**
 * Handles save/load operations for TensorFlow.js models.
 *
 * Usage:
 * ```typescript
 * const persistence = new ModelPersistence({ baseDir: './ml-models' });
 *
 * // Save model
 * const saveResult = await persistence.saveModel(model, {
 *   modelId: 'lstm-predictor',
 *   modelType: 'lstm',
 *   version: 1,
 *   lastTrainingTime: Date.now(),
 *   trainingSamplesCount: 1000,
 *   accuracy: 0.85,
 *   isTrained: true,
 *   savedAt: Date.now()
 * });
 *
 * // Load model
 * const loadResult = await persistence.loadModel('lstm-predictor');
 * if (loadResult.success) {
 *   const model = loadResult.model;
 *   const metadata = loadResult.metadata;
 * }
 * ```
 */
export class ModelPersistence {
  private readonly config: Required<PersistenceConfig>;

  constructor(config: PersistenceConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ===========================================================================
  // Save Operations
  // ===========================================================================

  /**
   * Save a model to disk with metadata.
   *
   * @param model - TensorFlow.js LayersModel to save
   * @param metadata - Model metadata to save alongside
   * @returns Save result with paths and status
   */
  async saveModel(
    model: tf.LayersModel,
    metadata: ModelMetadata
  ): Promise<SaveResult> {
    const modelDir = this.getModelDir(metadata.modelId);
    const modelPath = path.join(modelDir, 'model.json');
    const metadataPath = path.join(modelDir, 'metadata.json');

    try {
      // Ensure directory exists
      await this.ensureDir(modelDir);

      // If using atomic saves, save to temp location first
      if (this.config.atomicSaves) {
        const tempDir = path.join(modelDir, '.temp');
        await this.ensureDir(tempDir);

        // Save model to temp
        const tempModelPath = `file://${path.join(tempDir, 'model.json')}`;
        await model.save(tempModelPath);

        // P1-2: Compute hash of saved model for integrity verification
        const tempModelFilePath = path.join(tempDir, 'model.json');
        metadata.modelHash = await this.computeFileHash(tempModelFilePath);

        // Save metadata to temp (now includes hash)
        const tempMetadataPath = path.join(tempDir, 'metadata.json');
        await this.writeJsonFile(tempMetadataPath, metadata);

        // Move from temp to final location
        await this.atomicMove(tempDir, modelDir);
      } else {
        // Direct save
        await model.save(`file://${modelPath}`);

        // P1-2: Compute hash of saved model for integrity verification
        metadata.modelHash = await this.computeFileHash(modelPath);

        await this.writeJsonFile(metadataPath, metadata);
      }

      // Handle version management
      if (this.config.keepVersions) {
        await this.archiveVersion(metadata.modelId, metadata.version);
      }

      logger.info('Model saved successfully', {
        modelId: metadata.modelId,
        version: metadata.version,
        path: modelDir
      });

      return {
        success: true,
        modelPath,
        metadataPath,
        version: metadata.version
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Failed to save model', {
        modelId: metadata.modelId,
        error: err.message
      });

      return {
        success: false,
        modelPath,
        metadataPath,
        version: metadata.version,
        error: err
      };
    }
  }

  // ===========================================================================
  // Load Operations
  // ===========================================================================

  /**
   * Load a model from disk.
   *
   * @param modelId - Model identifier
   * @param version - Specific version to load (optional, loads latest if not specified)
   * @returns Load result with model and metadata
   */
  async loadModel(modelId: string, version?: number): Promise<LoadResult> {
    const modelDir = version
      ? this.getVersionDir(modelId, version)
      : this.getModelDir(modelId);

    const modelPath = path.join(modelDir, 'model.json');
    const metadataPath = path.join(modelDir, 'metadata.json');

    try {
      // Check if model exists
      if (!(await this.fileExists(modelPath))) {
        logger.warn('Model not found', { modelId, modelPath });
        return {
          success: false,
          model: null,
          metadata: null,
          error: new Error(`Model not found: ${modelId}`)
        };
      }

      // Load model
      const model = await tf.loadLayersModel(`file://${modelPath}`);

      // Load metadata
      let metadata: ModelMetadata | null = null;
      if (await this.fileExists(metadataPath)) {
        const rawMetadata = await this.readJsonFile<ModelMetadata>(metadataPath);
        // P1-2: Validate metadata before trusting it
        metadata = this.validateMetadata(rawMetadata) ? rawMetadata : null;
        if (!metadata) {
          logger.warn('Model metadata failed validation', { modelId });
        }
      }

      // P1-2: Verify model integrity if hash is available in metadata
      if (metadata?.modelHash) {
        const currentHash = await this.computeFileHash(modelPath);
        if (currentHash !== metadata.modelHash) {
          logger.error('Model integrity check failed — file may be tampered', {
            modelId,
            expectedHash: metadata.modelHash,
            actualHash: currentHash,
          });
          return {
            success: false,
            model: null,
            metadata,
            error: new Error(`Model integrity check failed for: ${modelId}`)
          };
        }
      }

      logger.info('Model loaded successfully', {
        modelId,
        version: metadata?.version,
        path: modelDir,
        integrityVerified: !!metadata?.modelHash,
      });

      return {
        success: true,
        model,
        metadata
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Failed to load model', {
        modelId,
        error: err.message
      });

      return {
        success: false,
        model: null,
        metadata: null,
        error: err
      };
    }
  }

  /**
   * Load only the metadata for a model (faster than full load).
   *
   * @param modelId - Model identifier
   * @returns Metadata or null if not found
   */
  async loadMetadata(modelId: string): Promise<ModelMetadata | null> {
    const metadataPath = path.join(this.getModelDir(modelId), 'metadata.json');

    try {
      if (!(await this.fileExists(metadataPath))) {
        return null;
      }
      return await this.readJsonFile<ModelMetadata>(metadataPath);
    } catch (error) {
      logger.error('Failed to load metadata', {
        modelId,
        error: getErrorMessage(error)
      });
      return null;
    }
  }

  // ===========================================================================
  // Model Management
  // ===========================================================================

  /**
   * Check if a saved model exists.
   *
   * @param modelId - Model identifier
   * @returns True if model exists
   */
  async modelExists(modelId: string): Promise<boolean> {
    const modelPath = path.join(this.getModelDir(modelId), 'model.json');
    return this.fileExists(modelPath);
  }

  /**
   * Delete a saved model.
   *
   * @param modelId - Model identifier
   * @returns True if deletion was successful
   */
  async deleteModel(modelId: string): Promise<boolean> {
    const modelDir = this.getModelDir(modelId);

    try {
      if (await this.fileExists(modelDir)) {
        await fsp.rm(modelDir, { recursive: true, force: true });
        logger.info('Model deleted', { modelId });
        return true;
      }
      return false;
    } catch (error) {
      logger.error('Failed to delete model', {
        modelId,
        error: getErrorMessage(error)
      });
      return false;
    }
  }

  /**
   * List all saved models.
   *
   * @returns Array of model IDs
   */
  async listModels(): Promise<string[]> {
    try {
      if (!(await this.fileExists(this.config.baseDir))) {
        return [];
      }

      const entries = await fsp.readdir(this.config.baseDir, { withFileTypes: true });
      return entries
        .filter(entry => entry.isDirectory())
        .filter(entry => !entry.name.startsWith('.'))
        .map(entry => entry.name);
    } catch (error) {
      logger.error('Failed to list models', {
        error: getErrorMessage(error)
      });
      return [];
    }
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  private getModelDir(modelId: string): string {
    // P1-1 fix: Sanitize modelId to prevent path traversal attacks.
    // Only allow alphanumeric, hyphens, and underscores.
    const sanitized = modelId.replace(/[^a-zA-Z0-9_-]/g, '');
    if (sanitized !== modelId || sanitized.length === 0) {
      throw new Error(`Invalid modelId: "${modelId}" — only alphanumeric, hyphens, and underscores allowed`);
    }
    return path.join(this.config.baseDir, sanitized);
  }

  private getVersionDir(modelId: string, version: number): string {
    return path.join(this.config.baseDir, modelId, `v${version}`);
  }

  /**
   * P1-2: Compute SHA-256 hash of a file for integrity verification.
   */
  private async computeFileHash(filePath: string): Promise<string> {
    const content = await fsp.readFile(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * P1-2: Validate metadata fields to catch tampering or corruption.
   * Returns false if metadata has suspicious or invalid values.
   */
  private validateMetadata(metadata: ModelMetadata): boolean {
    // Required fields must exist and be correct types
    if (!metadata.modelId || typeof metadata.modelId !== 'string') return false;
    if (!metadata.modelType || typeof metadata.modelType !== 'string') return false;
    if (typeof metadata.version !== 'number' || metadata.version < 0) return false;
    if (typeof metadata.accuracy !== 'number' || metadata.accuracy < 0 || metadata.accuracy > 1) return false;
    if (typeof metadata.isTrained !== 'boolean') return false;

    // Timestamps must be in the past (not future-dated to bypass staleness checks)
    const now = Date.now();
    const fiveMinuteFuture = now + 5 * 60 * 1000; // Allow small clock skew
    if (typeof metadata.savedAt !== 'number' || metadata.savedAt > fiveMinuteFuture) return false;
    if (typeof metadata.lastTrainingTime !== 'number' || metadata.lastTrainingTime > fiveMinuteFuture) return false;

    return true;
  }

  // P1-7 fix: All I/O methods now use async fs.promises to avoid blocking the event loop.
  private async ensureDir(dir: string): Promise<void> {
    await fsp.mkdir(dir, { recursive: true });
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fsp.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async writeJsonFile(filePath: string, data: unknown): Promise<void> {
    const json = JSON.stringify(data, null, 2);
    await fsp.writeFile(filePath, json, 'utf8');
  }

  private async readJsonFile<T>(filePath: string): Promise<T> {
    const content = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(content) as T;
  }

  /**
   * FIX 4.1: Move files from temp to destination atomically.
   *
   * Uses fs.renameSync for true atomic operations when on the same filesystem.
   * Falls back to copy-then-delete for cross-filesystem moves.
   *
   * Note: fs.renameSync is atomic on POSIX systems (single syscall).
   * On Windows, it's atomic if destination doesn't exist.
   */
  private async atomicMove(srcDir: string, destDir: string): Promise<void> {
    const files = await fsp.readdir(srcDir);

    for (const file of files) {
      const srcPath = path.join(srcDir, file);
      const destPath = path.join(destDir, file);

      // Remove existing file if present (required for atomic rename on Windows)
      if (await this.fileExists(destPath)) {
        await fsp.unlink(destPath);
      }

      try {
        // FIX 4.1: Use rename for true atomic move (single syscall)
        // This is atomic on same filesystem, fails on cross-filesystem
        await fsp.rename(srcPath, destPath);
      } catch (renameError) {
        // Fall back to copy-then-delete for cross-filesystem moves
        // This is NOT atomic, but necessary for cross-device scenarios
        const err = renameError as NodeJS.ErrnoException;
        if (err.code === 'EXDEV') {
          // Cross-device move - must copy then delete
          logger.debug('Cross-device move detected, falling back to copy', { srcPath, destPath });
          await fsp.copyFile(srcPath, destPath);
          await fsp.unlink(srcPath);
        } else {
          throw renameError;
        }
      }
    }

    // Remove temp directory (should be empty now)
    await fsp.rm(srcDir, { recursive: true, force: true });
  }

  private async archiveVersion(modelId: string, version: number): Promise<void> {
    const modelDir = this.getModelDir(modelId);
    const versionDir = this.getVersionDir(modelId, version);

    try {
      await this.ensureDir(versionDir);

      // Copy current files to version directory
      const files = ['model.json', 'model.weights.bin', 'metadata.json'];
      for (const file of files) {
        const srcPath = path.join(modelDir, file);
        const destPath = path.join(versionDir, file);
        if (await this.fileExists(srcPath)) {
          await fsp.copyFile(srcPath, destPath);
        }
      }

      // Clean up old versions if necessary
      await this.cleanOldVersions(modelId);
    } catch (error) {
      logger.warn('Failed to archive version', {
        modelId,
        version,
        error: getErrorMessage(error)
      });
    }
  }

  private async cleanOldVersions(modelId: string): Promise<void> {
    const modelDir = this.getModelDir(modelId);

    try {
      const entries = await fsp.readdir(modelDir, { withFileTypes: true });
      const versionDirs = entries
        .filter(e => e.isDirectory() && e.name.startsWith('v'))
        .map(e => ({
          name: e.name,
          version: parseInt(e.name.slice(1), 10)
        }))
        .filter(v => !isNaN(v.version))
        .sort((a, b) => b.version - a.version);

      // Remove versions beyond maxVersions
      for (let i = this.config.maxVersions; i < versionDirs.length; i++) {
        const versionPath = path.join(modelDir, versionDirs[i].name);
        await fsp.rm(versionPath, { recursive: true, force: true });
      }
    } catch (error) {
      logger.warn('Failed to clean old versions', {
        modelId,
        error: getErrorMessage(error)
      });
    }
  }
}

// =============================================================================
// Singleton Factory
// =============================================================================

let persistenceInstance: ModelPersistence | null = null;
let persistenceInitialConfig: PersistenceConfig | undefined = undefined;

/**
 * Get the singleton ModelPersistence instance.
 *
 * FIX 1.1: Configuration is only applied on first initialization.
 * Subsequent calls with different config will log a warning.
 *
 * @param config - Optional configuration (only used on first call)
 * @returns The singleton ModelPersistence instance
 */
export function getModelPersistence(config?: PersistenceConfig): ModelPersistence {
  if (!persistenceInstance) {
    persistenceInstance = new ModelPersistence(config);
    persistenceInitialConfig = config;
  } else if (config !== undefined) {
    // FIX 1.1: Warn if different config provided after initialization
    const configChanged = JSON.stringify(config) !== JSON.stringify(persistenceInitialConfig);
    if (configChanged) {
      logger.warn('getModelPersistence called with different config after initialization. Config ignored.', {
        initialConfig: persistenceInitialConfig,
        ignoredConfig: config
      });
    }
  }
  return persistenceInstance;
}

/**
 * Reset the singleton instance.
 */
export function resetModelPersistence(): void {
  persistenceInstance = null;
  persistenceInitialConfig = undefined;
}
