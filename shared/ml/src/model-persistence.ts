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
import * as path from 'path';
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

        // Save metadata to temp
        const tempMetadataPath = path.join(tempDir, 'metadata.json');
        await this.writeJsonFile(tempMetadataPath, metadata);

        // Move from temp to final location
        await this.atomicMove(tempDir, modelDir);
      } else {
        // Direct save
        await model.save(`file://${modelPath}`);
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
      if (!this.fileExists(modelPath)) {
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
      if (this.fileExists(metadataPath)) {
        metadata = await this.readJsonFile<ModelMetadata>(metadataPath);
      }

      logger.info('Model loaded successfully', {
        modelId,
        version: metadata?.version,
        path: modelDir
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
      if (!this.fileExists(metadataPath)) {
        return null;
      }
      return await this.readJsonFile<ModelMetadata>(metadataPath);
    } catch (error) {
      logger.error('Failed to load metadata', {
        modelId,
        error: error instanceof Error ? error.message : String(error)
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
  modelExists(modelId: string): boolean {
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
      if (fs.existsSync(modelDir)) {
        fs.rmSync(modelDir, { recursive: true, force: true });
        logger.info('Model deleted', { modelId });
        return true;
      }
      return false;
    } catch (error) {
      logger.error('Failed to delete model', {
        modelId,
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }

  /**
   * List all saved models.
   *
   * @returns Array of model IDs
   */
  listModels(): string[] {
    try {
      if (!fs.existsSync(this.config.baseDir)) {
        return [];
      }

      const entries = fs.readdirSync(this.config.baseDir, { withFileTypes: true });
      return entries
        .filter(entry => entry.isDirectory())
        .filter(entry => !entry.name.startsWith('.'))
        .map(entry => entry.name);
    } catch (error) {
      logger.error('Failed to list models', {
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  private getModelDir(modelId: string): string {
    return path.join(this.config.baseDir, modelId);
  }

  private getVersionDir(modelId: string, version: number): string {
    return path.join(this.config.baseDir, modelId, `v${version}`);
  }

  private async ensureDir(dir: string): Promise<void> {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private fileExists(filePath: string): boolean {
    return fs.existsSync(filePath);
  }

  private async writeJsonFile(filePath: string, data: unknown): Promise<void> {
    const json = JSON.stringify(data, null, 2);
    fs.writeFileSync(filePath, json, 'utf8');
  }

  private async readJsonFile<T>(filePath: string): Promise<T> {
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content) as T;
  }

  private async atomicMove(srcDir: string, destDir: string): Promise<void> {
    // Copy all files from temp to destination
    const files = fs.readdirSync(srcDir);
    for (const file of files) {
      const srcPath = path.join(srcDir, file);
      const destPath = path.join(destDir, file);

      // Remove existing file if present
      if (fs.existsSync(destPath)) {
        fs.unlinkSync(destPath);
      }

      // Copy file
      fs.copyFileSync(srcPath, destPath);
    }

    // Remove temp directory
    fs.rmSync(srcDir, { recursive: true, force: true });
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
        if (fs.existsSync(srcPath)) {
          fs.copyFileSync(srcPath, destPath);
        }
      }

      // Clean up old versions if necessary
      await this.cleanOldVersions(modelId);
    } catch (error) {
      logger.warn('Failed to archive version', {
        modelId,
        version,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async cleanOldVersions(modelId: string): Promise<void> {
    const modelDir = this.getModelDir(modelId);

    try {
      const entries = fs.readdirSync(modelDir, { withFileTypes: true });
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
        fs.rmSync(versionPath, { recursive: true, force: true });
      }
    } catch (error) {
      logger.warn('Failed to clean old versions', {
        modelId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

// =============================================================================
// Singleton Factory
// =============================================================================

let persistenceInstance: ModelPersistence | null = null;

/**
 * Get the singleton ModelPersistence instance.
 */
export function getModelPersistence(config?: PersistenceConfig): ModelPersistence {
  if (!persistenceInstance) {
    persistenceInstance = new ModelPersistence(config);
  }
  return persistenceInstance;
}

/**
 * Reset the singleton instance.
 */
export function resetModelPersistence(): void {
  persistenceInstance = null;
}
