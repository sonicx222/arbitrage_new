/**
 * Lightweight TensorFlow.js mock for CI testing.
 *
 * P0-3 fix: Enables predictor and orderflow-predictor tests to run
 * in CI without real TF.js model initialization (which takes 100-200s).
 *
 * This mock simulates:
 * - Model creation (sequential, layers, compile)
 * - Prediction (returns deterministic outputs)
 * - Training (model.fit resolves immediately)
 * - Tensor lifecycle (create, data/array, dispose)
 *
 * Tests using this mock validate prediction LOGIC (softmax, confidence
 * thresholds, direction mapping, edge cases) — not TF.js model behavior.
 * Set RUN_SLOW_TESTS=true for tests using real TF.js.
 */

import { jest } from '@jest/globals';

// Track tensors for leak detection if needed
let activeTensorCount = 0;

/**
 * Creates a mock tensor that mimics tf.Tensor behavior.
 * Returns deterministic data based on shape.
 */
function createMockTensor(data?: number[] | Float32Array | number, shape?: number[]) {
  const tensorData = Array.isArray(data) ? data :
    typeof data === 'number' ? [data] :
    data instanceof Float32Array ? Array.from(data) :
    shape ? new Array(shape.reduce((a, b) => a * b, 1)).fill(0.5) :
    [0.5];

  let disposed = false;
  activeTensorCount++;

  return {
    data: jest.fn<() => Promise<Float32Array>>().mockResolvedValue(new Float32Array(tensorData)),
    dataSync: jest.fn<() => Float32Array>().mockReturnValue(new Float32Array(tensorData)),
    array: jest.fn<() => Promise<number[] | number[][]>>().mockImplementation(async () => {
      // For 2D tensors (batch predictions), return array of arrays
      if (shape && shape.length === 2) {
        const rows = shape[0];
        const cols = shape[1];
        const result: number[][] = [];
        for (let i = 0; i < rows; i++) {
          result.push(tensorData.slice(i * cols, (i + 1) * cols));
        }
        return result;
      }
      return tensorData;
    }),
    dispose: jest.fn<() => void>().mockImplementation(() => {
      if (!disposed) {
        disposed = true;
        activeTensorCount--;
      }
    }),
    shape: shape ?? [tensorData.length],
    dtype: 'float32' as const,
    isDisposed: false,
  };
}

type MockTensor = ReturnType<typeof createMockTensor>;

/**
 * Creates a mock sequential model that simulates tf.Sequential.
 */
function createMockModel() {
  let compiled = false;
  let outputShape = [1, 3]; // Default: batch=1, outputs=3 (price, confidence, direction)

  const model = {
    add: jest.fn<(layer: unknown) => void>(),
    compile: jest.fn<(config: unknown) => void>().mockImplementation(() => {
      compiled = true;
    }),
    predict: jest.fn<(input: MockTensor) => MockTensor>().mockImplementation((input: MockTensor) => {
      // Return deterministic prediction: [predicted_price=100.5, confidence=0.75, direction=0.2]
      // For orderflow: [bullish=0.8, neutral=0.1, bearish=0.1, pressure=0.3, volatility=0.2, whaleImpact=0.15]
      const batchSize = input.shape[0] ?? 1;

      if (outputShape[1] === 6) {
        // Orderflow model output
        const data: number[] = [];
        for (let i = 0; i < batchSize; i++) {
          data.push(0.8, 0.1, 0.1, 0.3, 0.2, 0.15);
        }
        return createMockTensor(data, [batchSize, 6]);
      }

      // LSTM model output
      const data: number[] = [];
      for (let i = 0; i < batchSize; i++) {
        data.push(100.5, 0.75, 0.2);
      }
      return createMockTensor(data, [batchSize, 3]);
    }),
    fit: jest.fn<(x: MockTensor, y: MockTensor, config?: unknown) => Promise<{ history: { loss: number[] } }>>()
      .mockImplementation(async (_x: MockTensor, _y: MockTensor, config?: any) => {
        // Simulate training by calling onEpochEnd if provided
        if (config?.callbacks?.onEpochEnd) {
          const epochs = config.epochs ?? 1;
          for (let i = 0; i < epochs; i++) {
            await config.callbacks.onEpochEnd(i, { loss: 0.1 - i * 0.001, mae: 0.05, mse: 0.01 });
          }
        }
        return { history: { loss: [0.1, 0.05, 0.01] } };
      }),
    save: jest.fn<(path: string) => Promise<{ modelArtifactsInfo: object }>>()
      .mockResolvedValue({ modelArtifactsInfo: { dateSaved: new Date() } }),
    dispose: jest.fn<() => void>(),
    getWeights: jest.fn<() => MockTensor[]>().mockReturnValue([]),
    setWeights: jest.fn<(weights: MockTensor[]) => void>(),
    summary: jest.fn<() => void>(),
    // Internal state for test verification
    _compiled: () => compiled,
    _setOutputShape: (shape: number[]) => { outputShape = shape; },
  };

  return model;
}

type MockModel = ReturnType<typeof createMockModel>;

/**
 * Re-establishes mock implementations on an existing model object.
 * This is needed when resetMocks clears jest.fn() implementations
 * on models created in beforeAll blocks.
 */
function restoreModelMocks(model: MockModel, orderflowMode = false) {
  const outputShape = orderflowMode ? [1, 6] : [1, 3];
  model._setOutputShape(outputShape);

  model.add.mockImplementation(() => {});
  model.compile.mockImplementation(() => {});
  model.predict.mockImplementation((input: MockTensor) => {
    const batchSize = input.shape[0] ?? 1;

    if (outputShape[1] === 6) {
      const data: number[] = [];
      for (let i = 0; i < batchSize; i++) {
        data.push(0.8, 0.1, 0.1, 0.3, 0.2, 0.15);
      }
      return createMockTensor(data, [batchSize, 6]);
    }

    const data: number[] = [];
    for (let i = 0; i < batchSize; i++) {
      data.push(100.5, 0.75, 0.2);
    }
    return createMockTensor(data, [batchSize, 3]);
  });
  model.fit.mockImplementation(async (_x: MockTensor, _y: MockTensor, config?: any) => {
    if (config?.callbacks?.onEpochEnd) {
      const epochs = config.epochs ?? 1;
      for (let i = 0; i < epochs; i++) {
        await config.callbacks.onEpochEnd(i, { loss: 0.1 - i * 0.001, mae: 0.05, mse: 0.01 });
      }
    }
    return { history: { loss: [0.1, 0.05, 0.01] } };
  });
  model.save.mockResolvedValue({ modelArtifactsInfo: { dateSaved: new Date() } });
  model.dispose.mockImplementation(() => {});
  model.getWeights.mockReturnValue([]);
  model.setWeights.mockImplementation(() => {});
  model.summary.mockImplementation(() => {});
}

/**
 * Builds the complete TF.js mock object.
 *
 * Usage in test files:
 * ```
 * import { createTfMock } from './__helpers__/tf-mock';
 * const { mockTf, getLastModel } = createTfMock();
 * jest.mock('@tensorflow/tfjs', () => mockTf);
 * ```
 */
export function createTfMock() {
  let lastModel: MockModel | null = null;

  const mockTf = {
    sequential: jest.fn<() => MockModel>().mockImplementation(() => {
      lastModel = createMockModel();
      return lastModel;
    }),

    layers: {
      lstm: jest.fn<(config: unknown) => object>().mockImplementation((config: any) => ({
        _type: 'lstm', ...config,
      })),
      dense: jest.fn<(config: unknown) => object>().mockImplementation((config: any) => ({
        _type: 'dense', ...config,
      })),
      batchNormalization: jest.fn<() => object>().mockReturnValue({ _type: 'batchNorm' }),
      dropout: jest.fn<(config: unknown) => object>().mockImplementation((config: any) => ({
        _type: 'dropout', ...config,
      })),
    },

    train: {
      adam: jest.fn<(lr?: number) => object>().mockImplementation((lr = 0.001) => ({
        _type: 'adam', learningRate: lr,
      })),
    },

    losses: {
      huberLoss: jest.fn<(yTrue: MockTensor, yPred: MockTensor) => MockTensor>()
        .mockImplementation(() => createMockTensor([0.01])),
    },

    tensor: jest.fn<(data: unknown, shape?: number[]) => MockTensor>()
      .mockImplementation((data: any, shape?: number[]) => {
        const flatData = Array.isArray(data) ? data.flat() : [data];
        return createMockTensor(flatData, shape ?? [flatData.length]);
      }),

    tensor2d: jest.fn<(data: unknown, shape?: number[]) => MockTensor>()
      .mockImplementation((data: any, shape?: number[]) => {
        const flatData = Array.isArray(data) ? data.flat() : [data];
        const inferredShape = shape ?? (Array.isArray(data) ? [data.length, data[0]?.length ?? 1] : [1, 1]);
        return createMockTensor(flatData, inferredShape);
      }),

    zeros: jest.fn<(shape: number[]) => MockTensor>()
      .mockImplementation((shape: number[]) => {
        const size = shape.reduce((a, b) => a * b, 1);
        return createMockTensor(new Array(size).fill(0), shape);
      }),

    loadLayersModel: jest.fn<(path: string) => Promise<MockModel>>()
      .mockImplementation(async () => {
        lastModel = createMockModel();
        return lastModel;
      }),

    // Backend utilities
    setBackend: jest.fn<(backend: string) => Promise<boolean>>().mockResolvedValue(true),
    ready: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    getBackend: jest.fn<() => string>().mockReturnValue('cpu'),
    memory: jest.fn<() => object>().mockReturnValue({ numTensors: 0, numDataBuffers: 0, numBytes: 0 }),
    disposeVariables: jest.fn<() => void>(),
    tidy: jest.fn<(fn: () => unknown) => unknown>().mockImplementation((fn: () => unknown) => fn()),
    engine: jest.fn<() => object>().mockReturnValue({
      state: { registeredVariables: {} },
    }),

    // Type helpers used in predictor.ts type annotations
    Tensor: class {},
    Tensor3D: class {},
    Logs: class {},
    LayersModel: class {},
  };

  /**
   * Re-establishes all mock implementations on mockTf after resetMocks/clearMocks.
   * Call this in beforeEach to ensure mocks survive jest auto-clearing.
   */
  function restoreMocks() {
    mockTf.sequential.mockImplementation(() => {
      lastModel = createMockModel();
      return lastModel;
    });

    mockTf.layers.lstm.mockImplementation((config: any) => ({
      _type: 'lstm', ...config,
    }));
    mockTf.layers.dense.mockImplementation((config: any) => ({
      _type: 'dense', ...config,
    }));
    mockTf.layers.batchNormalization.mockReturnValue({ _type: 'batchNorm' });
    mockTf.layers.dropout.mockImplementation((config: any) => ({
      _type: 'dropout', ...config,
    }));

    mockTf.train.adam.mockImplementation((lr = 0.001) => ({
      _type: 'adam', learningRate: lr,
    }));

    mockTf.losses.huberLoss.mockImplementation(() => createMockTensor([0.01]));

    mockTf.tensor.mockImplementation((data: any, shape?: number[]) => {
      const flatData = Array.isArray(data) ? data.flat() : [data];
      return createMockTensor(flatData, shape ?? [flatData.length]);
    });

    mockTf.tensor2d.mockImplementation((data: any, shape?: number[]) => {
      const flatData = Array.isArray(data) ? data.flat() : [data];
      const inferredShape = shape ?? (Array.isArray(data) ? [data.length, data[0]?.length ?? 1] : [1, 1]);
      return createMockTensor(flatData, inferredShape);
    });

    mockTf.zeros.mockImplementation((shape: number[]) => {
      const size = shape.reduce((a, b) => a * b, 1);
      return createMockTensor(new Array(size).fill(0), shape);
    });

    mockTf.loadLayersModel.mockImplementation(async () => {
      lastModel = createMockModel();
      return lastModel;
    });

    mockTf.setBackend.mockResolvedValue(true);
    mockTf.ready.mockResolvedValue(undefined);
    mockTf.getBackend.mockReturnValue('cpu');
    mockTf.memory.mockReturnValue({ numTensors: 0, numDataBuffers: 0, numBytes: 0 });
    mockTf.disposeVariables.mockImplementation(() => {});
    mockTf.tidy.mockImplementation((fn: () => unknown) => fn());
    mockTf.engine.mockReturnValue({
      state: { registeredVariables: {} },
    });
  }

  return {
    mockTf,
    /** Get the most recently created model for assertions */
    getLastModel: () => lastModel,
    /** Configure the next model to use orderflow output shape (6 outputs) */
    setOrderflowMode: () => {
      mockTf.sequential.mockImplementation(() => {
        lastModel = createMockModel();
        lastModel._setOutputShape([1, 6]);
        return lastModel;
      });
    },
    /** Get active tensor count for leak detection */
    getActiveTensorCount: () => activeTensorCount,
    /** Reset tensor counter */
    resetTensorCount: () => { activeTensorCount = 0; },
    /**
     * Re-establish all mock implementations on mockTf after clearMocks/resetMocks.
     * Call this in beforeEach to ensure mocks survive jest auto-clearing.
     */
    restoreMocks,
    /**
     * Re-establish mock implementations on the last created model.
     * Use this in beforeEach for describe blocks that use beforeAll to create predictors.
     */
    restoreLastModelMocks: (orderflowMode = false) => {
      if (lastModel) {
        restoreModelMocks(lastModel, orderflowMode);
      }
    },
  };
}
