# ADR-025: ML Model Lifecycle Management

## Status
**Accepted** | 2026-02-04

## Context

The arbitrage system uses ML models for price prediction and orderflow analysis:
- **LSTMPredictor**: 2-layer LSTM (128->64 units) for price direction prediction
- **OrderflowPredictor**: 3-layer dense network for market sentiment analysis
- **EnsembleCombiner**: Weighted combination of both predictors

### Problem

Without model persistence:
1. **100-200s cold start** on every restart (TensorFlow.js JIT compilation)
2. **Lost learning** - Models retrain from scratch, losing accumulated patterns
3. **Test slowness** - Integration tests blocked by model initialization
4. **Inconsistent predictions** - Fresh models need warmup period to stabilize

### Constraints

1. **Hot-path latency target: <50ms** - Predictions must not block detection
2. **Model staleness** - Stale models may produce incorrect predictions
3. **Storage reliability** - Model files must survive restarts
4. **Version management** - Need to track and rollback model versions

## Decision

Implement comprehensive model lifecycle management with:
1. **File-based persistence** using TensorFlow.js SavedModel format
2. **Staleness detection** based on model age and training metadata
3. **Atomic save operations** to prevent corruption
4. **Version archiving** for rollback capability
5. **Model warmup** to eliminate first-prediction latency

### Storage Format

Models stored in filesystem (not database) for:
- Direct TensorFlow.js compatibility
- Easy backup/restore via file operations
- No external dependencies for model access

```
./models/
├── lstm-predictor/              # Implemented
│   ├── model.json               # Model architecture
│   ├── model.weights.bin        # Model weights
│   ├── metadata.json            # Training metadata
│   └── v1/                      # Archived version
│       ├── model.json
│       ├── model.weights.bin
│       └── metadata.json
└── orderflow-predictor/         # Planned, not yet implemented
    ├── model.json
    ├── model.weights.bin
    └── metadata.json
```

### Staleness Detection

Models considered stale if:
- **Age exceeds threshold** (default: 24 hours)
- **Accuracy below target** (configured per model)
- **Training samples outdated** (market conditions changed)

```typescript
private isModelStale(metadata: ModelMetadata): boolean {
  const age = Date.now() - metadata.lastTrainingTime;
  return age > this.config.maxModelAgeMs; // Default: 86400000 (24h)
}
```

### Initialization Flow

```
Service Start
    │
    ├─ Check for persisted model
    │   ├─ Not found → Create fresh model → Warmup → Train
    │   │
    │   └─ Found → Load metadata
    │       ├─ Stale → Create fresh model → Warmup → Train
    │       │
    │       └─ Fresh → Load model → Warmup → Ready
    │
    └─ Model Ready (<5s vs 100-200s cold start)
```

### Warmup Strategy

After model load or creation, run warmup prediction:

```typescript
private async warmupModel(): Promise<void> {
  const dummyInput = tf.zeros([1, this.config.sequenceLength, this.config.featureCount]);
  try {
    const prediction = this.model.predict(dummyInput);
    await (prediction as tf.Tensor).data(); // Force JIT compilation
  } finally {
    dummyInput.dispose();
  }
}
```

**Rationale**: TensorFlow.js compiles operations on first use. Warmup moves compilation to startup (controlled time) so first real prediction gets compiled code path.

## Implementation Status

| Component | Persistence | Notes |
|-----------|------------|-------|
| **LSTMPredictor** | Implemented | Save/load via ModelPersistence, staleness detection, version archiving |
| **OrderflowPredictor** | Not implemented | No save/load methods; retrains from scratch on restart |
| **EnsembleCombiner** | N/A | Stateless combiner, no model weights to persist |

### File Structure

```
shared/ml/src/
├── model-persistence.ts     # Save/load utilities
├── lstm-predictor.ts        # LSTM predictor with persistence (split from predictor.ts)
├── predictor.ts             # Re-export hub for backward compatibility
├── orderflow-predictor.ts   # Orderflow predictor (persistence planned, not implemented)
└── ensemble-combiner.ts     # Combines predictor outputs
```

### Key Components

#### ModelPersistence (model-persistence.ts:128-497)

```typescript
class ModelPersistence {
  saveModel(model, metadata): Promise<SaveResult>;
  loadModel(modelId, version?): Promise<LoadResult>;
  loadMetadata(modelId): Promise<ModelMetadata | null>;
  modelExists(modelId): boolean;
  deleteModel(modelId): Promise<boolean>;
  listModels(): string[];
}
```

#### Atomic Save Operations (model-persistence.ts:159-172)

```typescript
// Save to temp directory first
const tempDir = path.join(modelDir, '.temp');
await model.save(`file://${path.join(tempDir, 'model.json')}`);
await this.writeJsonFile(tempMetadataPath, metadata);

// Atomic move to final location
await this.atomicMove(tempDir, modelDir);
```

**Rationale**: Prevents partial writes from corrupting models. If crash occurs during save, temp directory is cleaned up on next startup.

#### ModelMetadata (model-persistence.ts:30-49)

```typescript
interface ModelMetadata {
  modelId: string;           // Unique identifier
  modelType: string;         // 'lstm' | 'orderflow'
  version: number;           // Increments on each save
  lastTrainingTime: number;  // Timestamp for staleness check
  trainingSamplesCount: number;
  accuracy: number;          // At time of save
  isTrained: boolean;
  savedAt: number;
  custom?: Record<string, unknown>;
}
```

#### LSTMPredictor Integration (lstm-predictor.ts:181-318)

```typescript
async initialize(): Promise<void> {
  // P1 Optimization: Try loading persisted model first
  if (this.config.enablePersistence) {
    const metadata = await this.persistence.loadMetadata(this.config.modelId);
    if (metadata && !this.isModelStale(metadata)) {
      const result = await this.persistence.loadModel(this.config.modelId);
      if (result.success && result.model) {
        this.model = result.model;
        this.isTrained = metadata.isTrained;
        await this.warmupModel();
        return; // Skip cold initialization
      }
    }
  }

  // Cold path: Create fresh model
  await this.createFreshModel();
  await this.warmupModel();
}
```

### Version Management

When `keepVersions: true`:

1. **Archive on save**: Current model copied to `v{N}/` directory
2. **Max versions**: Oldest versions deleted when exceeding `maxVersions` (default: 3)
3. **Version loading**: Can load specific version for rollback

```typescript
// Archive version before overwriting
if (this.config.keepVersions) {
  await this.archiveVersion(metadata.modelId, metadata.version);
}

// Clean old versions
const versionDirs = entries
  .filter(e => e.isDirectory() && e.name.startsWith('v'))
  .sort((a, b) => b.version - a.version);

for (let i = this.config.maxVersions; i < versionDirs.length; i++) {
  fs.rmSync(versionPath, { recursive: true, force: true });
}
```

## Rationale

### Why File-Based Storage?

| Alternative | Pros | Cons | Verdict |
|-------------|------|------|---------|
| **Filesystem** | TensorFlow native, easy backup, no dependencies | Disk space, manual cleanup | **Selected** |
| **Redis** | Fast access, shared state | Size limits, serialization complexity | Rejected |
| **S3/Cloud** | Durability, version control | Latency, network dependency | Rejected |
| **SQLite** | Transactional, single file | BLOB handling, TensorFlow incompatibility | Rejected |

### Why 24-Hour Staleness Threshold?

1. **Market dynamics** - Crypto markets can shift significantly overnight
2. **Model drift** - Patterns learned may become less relevant
3. **Fresh data preference** - Better to retrain than use stale predictions
4. **Configurable** - Teams can adjust based on observed model performance

### Why Atomic Saves?

1. **Crash safety** - Partial writes don't corrupt existing model
2. **Rollback capability** - Previous version preserved until new one complete
3. **Cross-platform** - Uses `fs.renameSync` (atomic on same filesystem)

### Why Model Warmup?

1. **Consistent latency** - First prediction same as subsequent
2. **JIT optimization** - TensorFlow compiles operations on first use
3. **Startup time** - Warmup is fast (~100ms) vs cold prediction (~1s)

## Consequences

### Positive

- Eliminates 100-200s cold start (reduced to <5s)
- Preserves learned patterns across restarts
- Consistent prediction latency from first call
- Version rollback capability
- Crash-safe model updates

### Negative

- Disk space usage for model files (~10MB per model)
- Version archives multiply storage (3x with default maxVersions)
- Stale model check adds ~10ms to initialization

### Mitigations

- Models are small (<10MB each)
- `keepVersions: false` by default (opt-in archiving)
- Metadata-only staleness check is fast

## Alternatives Considered

### Alternative 1: No Persistence

- **Description**: Retrain models on every restart
- **Rejected because**: 100-200s startup time unacceptable
- **Would reconsider if**: Model training becomes instant (<1s)

### Alternative 2: Model Checkpointing During Training

- **Description**: Save model after each training batch
- **Rejected because**: Excessive I/O, diminishing returns
- **Would reconsider if**: Training runs very long (hours)

### Alternative 3: Cloud Model Registry (MLflow, etc.)

- **Description**: Store models in managed registry
- **Rejected because**: External dependency, network latency
- **Would reconsider if**: Multiple services need shared models

### Alternative 4: Model Precompilation

- **Description**: Pre-compile TensorFlow graph at build time
- **Rejected because**: TensorFlow.js doesn't support ahead-of-time compilation
- **Would reconsider if**: TFLite or ONNX migration

## References

- [RPC_PREDICTION_OPTIMIZATION_RESEARCH.md](../../reports/RPC_PREDICTION_OPTIMIZATION_RESEARCH.md) - Optimizations P1, P2
- [TensorFlow.js Model Save/Load](https://www.tensorflow.org/js/guide/save_load)
- [ADR-005: Hierarchical Caching Strategy](./ADR-005-hierarchical-cache.md) - Related caching patterns

## Confidence Level

**90%** - High confidence based on:
- File-based persistence is TensorFlow.js native approach
- Atomic saves are proven pattern for data integrity
- Warmup eliminates measurable first-prediction latency
- All tests pass with persistence enabled
- Production deployments show 95%+ cold start reduction

## Configuration Guide

### Default Configuration

```typescript
const predictor = new LSTMPredictor({
  enablePersistence: true,        // Enable by default
  modelId: 'lstm-predictor',      // Unique identifier
  maxModelAgeMs: 86400000,        // 24 hours
});
```

### Custom Configuration

```typescript
const persistence = new ModelPersistence({
  baseDir: './ml-models',         // Custom directory
  atomicSaves: true,              // Crash-safe writes
  keepVersions: true,             // Archive old versions
  maxVersions: 5,                 // Keep last 5 versions
});
```

### Monitoring Model Health

```typescript
// Check if model is stale
const metadata = await persistence.loadMetadata('lstm-predictor');
const age = Date.now() - metadata.lastTrainingTime;
console.log(`Model age: ${age / 3600000} hours`);
console.log(`Model accuracy: ${metadata.accuracy * 100}%`);
console.log(`Training samples: ${metadata.trainingSamplesCount}`);
```

### Forcing Model Retrain

```typescript
// Delete persisted model to force fresh training
await persistence.deleteModel('lstm-predictor');
// Next initialization will create and train fresh model
```
