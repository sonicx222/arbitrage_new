"use strict";
// ML Prediction Engine with LSTM Models
// Advanced price forecasting and pattern recognition for arbitrage
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.PatternRecognizer = exports.LSTMPredictor = void 0;
exports.getLSTMPredictor = getLSTMPredictor;
exports.getPatternRecognizer = getPatternRecognizer;
const tf = __importStar(require("@tensorflow/tfjs-node"));
const logger_1 = require("../../core/src/logger");
const logger = (0, logger_1.createLogger)('ml-predictor');
class LSTMPredictor {
    constructor() {
        this.model = null;
        this.isTrained = false;
        this.featureCount = 20;
        this.sequenceLength = 60; // 60 time steps (1 hour at 1-minute intervals)
        this.lastTrainingTime = 0;
        this.predictionHistory = [];
        this.initializeModel();
    }
    async initializeModel() {
        try {
            // Create LSTM model for price prediction
            const model = tf.sequential();
            // Input layer
            model.add(tf.layers.lstm({
                units: 128,
                inputShape: [this.sequenceLength, this.featureCount],
                returnSequences: true,
                dropout: 0.2,
                recurrentDropout: 0.2
            }));
            // Hidden layers
            model.add(tf.layers.lstm({
                units: 64,
                dropout: 0.2,
                recurrentDropout: 0.2
            }));
            // Attention mechanism
            model.add(tf.layers.dense({ units: 32, activation: 'relu' }));
            // Output layer: [predicted_price, confidence, direction]
            model.add(tf.layers.dense({ units: 3, activation: 'linear' }));
            // Compile model
            model.compile({
                optimizer: tf.train.adam(0.001),
                loss: 'huberLoss', // Robust to outliers
                metrics: ['mae', 'mse']
            });
            this.model = model;
            logger.info('LSTM model initialized successfully');
        }
        catch (error) {
            logger.error('Failed to initialize LSTM model:', error);
            throw error;
        }
    }
    async predictPrice(priceHistory, context) {
        if (!this.model || !this.isTrained) {
            // Fallback to simple prediction
            return this.fallbackPrediction(priceHistory, context);
        }
        try {
            // Prepare input data
            const features = this.extractFeatures(priceHistory, context);
            // Reshape flat features array to 3D tensor [batch, timesteps, features]
            const inputTensor = tf.tensor1d(features).reshape([1, this.sequenceLength, this.featureCount]);
            // Make prediction
            const prediction = this.model.predict(inputTensor);
            const result = await prediction.data();
            // Clean up tensors
            inputTensor.dispose();
            prediction.dispose();
            const predictedPrice = result[0];
            const confidence = Math.min(Math.max(result[1], 0), 1); // Clamp to [0, 1]
            const directionValue = result[2];
            // Determine direction
            let direction;
            if (directionValue > 0.1)
                direction = 'up';
            else if (directionValue < -0.1)
                direction = 'down';
            else
                direction = 'sideways';
            return {
                predictedPrice,
                confidence,
                direction,
                timeHorizon: 300000, // 5 minutes
                features
            };
        }
        catch (error) {
            logger.error('Price prediction failed, using fallback:', error);
            return this.fallbackPrediction(priceHistory, context);
        }
    }
    async trainModel(trainingData) {
        if (!this.model) {
            throw new Error('Model not initialized');
        }
        try {
            logger.info(`Training LSTM model with ${trainingData.inputs.length} samples`);
            // Reshape 2D inputs to 3D tensor [samples, timesteps, features]
            // Each input is a flat feature vector that gets reshaped to [sequenceLength, featureCount]
            const numSamples = trainingData.inputs.length;
            const flatInputs = trainingData.inputs.flat();
            const inputs = tf.tensor1d(flatInputs).reshape([numSamples, this.sequenceLength, this.featureCount]);
            const outputs = tf.tensor2d(trainingData.outputs);
            await this.model.fit(inputs, outputs, {
                epochs: 50,
                batchSize: 32,
                validationSplit: 0.2,
                callbacks: {
                    onEpochEnd: (epoch, logs) => {
                        if (epoch % 10 === 0) {
                            logger.debug(`Training epoch ${epoch}: loss=${logs?.loss.toFixed(4)}`);
                        }
                    }
                }
            });
            // Clean up tensors
            inputs.dispose();
            outputs.dispose();
            this.isTrained = true;
            this.lastTrainingTime = Date.now();
            logger.info('LSTM model training completed successfully');
        }
        catch (error) {
            logger.error('Model training failed:', error);
            throw error;
        }
    }
    async updateModel(actualPrice, predictedPrice, timestamp) {
        // Store prediction result for online learning
        this.predictionHistory.push({
            timestamp,
            actual: actualPrice,
            predicted: predictedPrice,
            error: Math.abs(actualPrice - predictedPrice) / actualPrice
        });
        // Keep only last 1000 predictions
        if (this.predictionHistory.length > 1000) {
            this.predictionHistory.shift();
        }
        // Retrain model if accuracy is degrading
        const recentAccuracy = this.calculateRecentAccuracy();
        if (recentAccuracy < 0.7 && Date.now() - this.lastTrainingTime > 3600000) { // 1 hour
            logger.info('Model accuracy degrading, triggering retraining');
            await this.retrainOnRecentData();
        }
    }
    async retrainOnRecentData() {
        if (this.predictionHistory.length < 100)
            return;
        try {
            // Create training data from recent predictions and actuals
            const trainingData = this.createTrainingDataFromHistory();
            // Reshape 2D inputs to 3D tensor [samples, timesteps, features]
            const numSamples = trainingData.inputs.length;
            const flatInputs = trainingData.inputs.flat();
            const inputs = tf.tensor1d(flatInputs).reshape([numSamples, this.sequenceLength, this.featureCount]);
            const outputs = tf.tensor2d(trainingData.outputs);
            await this.model.fit(inputs, outputs, {
                epochs: 10,
                batchSize: 16,
                validationSplit: 0.1
            });
            inputs.dispose();
            outputs.dispose();
            this.lastTrainingTime = Date.now();
            logger.info('Model retrained on recent data');
        }
        catch (error) {
            logger.error('Retraining failed:', error);
        }
    }
    createTrainingDataFromHistory() {
        const inputs = [];
        const outputs = [];
        const timestamps = [];
        // Create sequences from prediction history
        for (let i = this.sequenceLength; i < this.predictionHistory.length; i++) {
            const sequence = this.predictionHistory.slice(i - this.sequenceLength, i);
            const features = this.extractFeaturesFromHistory(sequence);
            inputs.push(features);
            outputs.push([
                this.predictionHistory[i].actual,
                0.8, // Confidence placeholder
                0 // Direction placeholder
            ]);
            timestamps.push(this.predictionHistory[i].timestamp);
        }
        return { inputs, outputs, timestamps };
    }
    extractFeatures(priceHistory, context) {
        const features = [];
        if (priceHistory.length < this.sequenceLength) {
            // Pad with zeros if insufficient data
            features.push(...new Array(this.featureCount - 4).fill(0));
        }
        else {
            const recent = priceHistory.slice(-this.sequenceLength);
            // Price-based features
            const prices = recent.map(p => p.price);
            features.push(...this.calculatePriceFeatures(prices));
            // Volume-based features
            const volumes = recent.map(p => p.volume);
            features.push(...this.calculateVolumeFeatures(volumes));
            // Volatility features
            features.push(this.calculateVolatility(prices));
            // Trend features
            features.push(this.calculateTrend(prices));
        }
        // Context features
        features.push(context.currentPrice);
        features.push(context.volume24h);
        features.push(context.volatility);
        return features.slice(0, this.featureCount);
    }
    extractFeaturesFromHistory(history) {
        const features = [];
        // Error-based features
        const errors = history.map(h => h.error);
        features.push(...this.calculateErrorFeatures(errors));
        // Price-based features
        const prices = history.map(h => h.actual);
        features.push(...this.calculatePriceFeatures(prices));
        return features.slice(0, this.featureCount);
    }
    calculatePriceFeatures(prices) {
        if (prices.length === 0)
            return [0, 0, 0, 0];
        const returns = [];
        for (let i = 1; i < prices.length; i++) {
            returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
        }
        const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
        const variance = prices.reduce((sum, price) => sum + Math.pow(price - mean, 2), 0) / prices.length;
        const volatility = Math.sqrt(variance);
        const momentum = prices[prices.length - 1] - prices[0];
        return [mean, volatility, momentum, returns[returns.length - 1] || 0];
    }
    calculateVolumeFeatures(volumes) {
        if (volumes.length === 0)
            return [0, 0];
        const mean = volumes.reduce((a, b) => a + b, 0) / volumes.length;
        const ratio = volumes[volumes.length - 1] / mean;
        return [mean, ratio];
    }
    calculateVolatility(prices) {
        if (prices.length < 2)
            return 0;
        const returns = [];
        for (let i = 1; i < prices.length; i++) {
            returns.push(Math.log(prices[i] / prices[i - 1]));
        }
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((sum, ret) => sum + Math.pow(ret - mean, 2), 0) / returns.length;
        return Math.sqrt(variance);
    }
    calculateTrend(prices) {
        if (prices.length < 2)
            return 0;
        // Linear regression slope
        const n = prices.length;
        const x = Array.from({ length: n }, (_, i) => i);
        const y = prices;
        const sumX = x.reduce((a, b) => a + b, 0);
        const sumY = y.reduce((a, b) => a + b, 0);
        const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
        const sumXX = x.reduce((sum, xi) => sum + xi * xi, 0);
        const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
        return slope;
    }
    calculateErrorFeatures(errors) {
        if (errors.length === 0)
            return [0, 0, 0];
        const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
        const max = Math.max(...errors);
        const trend = errors.length > 1 ? errors[errors.length - 1] - errors[0] : 0;
        return [mean, max, trend];
    }
    calculateRecentAccuracy() {
        if (this.predictionHistory.length < 10)
            return 1.0;
        const recent = this.predictionHistory.slice(-50);
        const accurate = recent.filter(h => h.error < 0.05).length; // 5% error threshold
        return accurate / recent.length;
    }
    fallbackPrediction(priceHistory, context) {
        // Simple moving average prediction as fallback
        const prices = priceHistory.map(p => p.price);
        const recentPrices = prices.slice(-10);
        const avgPrice = recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length;
        const trend = this.calculateTrend(recentPrices.slice(-5));
        const predictedPrice = avgPrice * (1 + trend * 0.01); // 1% adjustment based on trend
        return {
            predictedPrice,
            confidence: 0.5,
            direction: trend > 0 ? 'up' : trend < 0 ? 'down' : 'sideways',
            timeHorizon: 300000,
            features: []
        };
    }
    getModelStats() {
        return {
            isTrained: this.isTrained,
            lastTrainingTime: this.lastTrainingTime,
            predictionCount: this.predictionHistory.length,
            recentAccuracy: this.calculateRecentAccuracy()
        };
    }
}
exports.LSTMPredictor = LSTMPredictor;
class PatternRecognizer {
    constructor() {
        this.patterns = new Map();
        this.initializePatterns();
    }
    initializePatterns() {
        // Define common profitable patterns
        this.patterns.set('whale_accumulation', {
            sequence: [0.1, 0.15, 0.2, 0.25], // Volume spikes
            threshold: 0.8,
            confidence: 0.85,
            outcome: 'price_increase_2-5%'
        });
        this.patterns.set('profit_taking', {
            sequence: [-0.05, -0.03, -0.08, -0.12], // Price drops with high volume
            threshold: 0.75,
            confidence: 0.80,
            outcome: 'continued_downtrend'
        });
        this.patterns.set('breakout', {
            sequence: [0.02, 0.03, 0.05, 0.08], // Steady upward movement
            threshold: 0.85,
            confidence: 0.90,
            outcome: 'momentum_continuation'
        });
    }
    detectPattern(priceHistory, volumeHistory) {
        const recentPrices = priceHistory.slice(-10).map(p => p.price);
        const recentVolumes = volumeHistory.slice(-10);
        if (recentPrices.length < 10 || recentVolumes.length < 10) {
            return null;
        }
        // Normalize data
        const priceChanges = this.calculateReturns(recentPrices);
        const volumeChanges = this.calculateVolumeChanges(recentVolumes);
        // Check each pattern
        for (const [patternName, pattern] of this.patterns) {
            const similarity = this.calculateSimilarity(priceChanges, pattern.sequence);
            if (similarity >= pattern.threshold) {
                return {
                    pattern: patternName,
                    confidence: pattern.confidence,
                    expectedOutcome: pattern.outcome,
                    timeHorizon: 600000, // 10 minutes
                    features: [...priceChanges, ...volumeChanges]
                };
            }
        }
        return null;
    }
    calculateReturns(prices) {
        const returns = [];
        for (let i = 1; i < prices.length; i++) {
            returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
        }
        return returns;
    }
    calculateVolumeChanges(volumes) {
        const changes = [];
        for (let i = 1; i < volumes.length; i++) {
            changes.push((volumes[i] - volumes[i - 1]) / volumes[i - 1]);
        }
        return changes;
    }
    calculateSimilarity(sequence1, sequence2) {
        if (sequence1.length !== sequence2.length)
            return 0;
        let similarity = 0;
        for (let i = 0; i < sequence1.length; i++) {
            const diff = Math.abs(sequence1[i] - sequence2[i]);
            similarity += Math.max(0, 1 - diff * 10); // Scale difference to similarity
        }
        return similarity / sequence1.length;
    }
}
exports.PatternRecognizer = PatternRecognizer;
// Singleton instances
let lstmPredictor = null;
let patternRecognizer = null;
function getLSTMPredictor() {
    if (!lstmPredictor) {
        lstmPredictor = new LSTMPredictor();
    }
    return lstmPredictor;
}
function getPatternRecognizer() {
    if (!patternRecognizer) {
        patternRecognizer = new PatternRecognizer();
    }
    return patternRecognizer;
}
//# sourceMappingURL=predictor.js.map