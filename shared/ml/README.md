# @arbitrage/ml

Machine learning engine for price prediction, pattern recognition, and orderflow analysis using TensorFlow.js.

## Build Order

**5th** in build chain: types -> config -> core -> `ml` -> services

## Key Exports

| Module | Purpose |
|--------|---------|
| `LSTMPredictor` | LSTM-based price direction prediction (singleton) |
| `PatternRecognizer` | Price pattern discovery |
| `OrderflowFeatureExtractor` | Whale/liquidation signal extraction |
| `OrderflowPredictor` | Orderflow-based prediction |
| `EnsemblePredictionCombiner` | Combined multi-model predictions |
| `DirectionMapper` | Price/market direction conversions |
| `SynchronizedStats` | Thread-safe metric aggregation |
| `initializeTensorFlow()` | Backend selection (native preferred, JS fallback) |
| `calculateSMA()`, `calculateVolatility()`, `normalize()` | Feature math utilities |

## Usage

```typescript
import { getLSTMPredictor, initializeTensorFlow } from '@arbitrage/ml';

await initializeTensorFlow();
const predictor = await getLSTMPredictor();
const prediction = await predictor.predict(features);
```

## Notes

- Uses pure-JS TensorFlow backend on Windows (LSTM warmup ~58s, 5-20x slower than native)
- Singleton pattern per model file to prevent duplicate initialization
- Feature flag controlled: `ML_ENABLED=true`

## Dependencies

- `@tensorflow/tfjs`
- `@arbitrage/core`
