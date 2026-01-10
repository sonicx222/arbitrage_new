"use strict";
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
exports.WasmArbitrageEngine = void 0;
exports.getWasmArbitrageEngine = getWasmArbitrageEngine;
// WebAssembly Arbitrage Calculator TypeScript Wrapper
const arbitrage_calculator_js_1 = __importStar(require("../dist/arbitrage_calculator.js"));
class WasmArbitrageEngine {
    constructor() {
        this.calculator = null;
        this.performanceMonitor = null;
        this.initialized = false;
    }
    async initialize() {
        if (this.initialized)
            return;
        try {
            // Initialize WebAssembly module
            await (0, arbitrage_calculator_js_1.default)();
            // Create calculator instance (assuming 1000 pairs and 10 DEXes)
            this.calculator = new arbitrage_calculator_js_1.ArbitrageCalculator(1000, 10);
            // Create performance monitor
            this.performanceMonitor = new arbitrage_calculator_js_1.PerformanceMonitor();
            this.initialized = true;
            // Test the module
            (0, arbitrage_calculator_js_1.greet)('Arbitrage System');
        }
        catch (error) {
            console.error('Failed to initialize WebAssembly arbitrage engine:', error);
            throw error;
        }
    }
    findArbitrageOpportunities(priceData, minProfit) {
        if (!this.calculator)
            throw new Error('WebAssembly calculator not initialized');
        const startTime = performance.now();
        const opportunities = [];
        // Convert price data to matrix format
        let pairIndex = 0;
        for (const [pairKey, dexPrices] of Object.entries(priceData)) {
            let dexIndex = 0;
            for (const [dex, price] of Object.entries(dexPrices)) {
                this.calculator.set_price(pairIndex, dexIndex, price);
                dexIndex++;
            }
            pairIndex++;
        }
        // Find opportunities using WebAssembly
        const wasmResults = this.calculator.find_opportunities(minProfit);
        // Process results
        for (let i = 0; i < wasmResults.length; i += 4) {
            const resultPairIndex = wasmResults[i];
            const profit = wasmResults[i + 1];
            const buyPrice = wasmResults[i + 2];
            const sellPrice = wasmResults[i + 3];
            // Find the corresponding pair key
            let foundPairKey = '';
            let idx = 0;
            for (const pairKey of Object.keys(priceData)) {
                if (idx === resultPairIndex) {
                    foundPairKey = pairKey;
                    break;
                }
                idx++;
            }
            if (foundPairKey) {
                opportunities.push({
                    pairKey: foundPairKey,
                    profit,
                    buyPrice,
                    sellPrice
                });
            }
        }
        const latency = performance.now() - startTime;
        if (this.performanceMonitor) {
            this.performanceMonitor.record_operation();
        }
        console.log(`WebAssembly arbitrage detection completed in ${latency.toFixed(2)}ms, found ${opportunities.length} opportunities`);
        return opportunities;
    }
    calculateTriangularArbitrage(p0, p1, p2, fee) {
        if (!this.calculator)
            throw new Error('WebAssembly calculator not initialized');
        return this.calculator.calculate_triangular_arbitrage(p0, p1, p2, fee);
    }
    calculateCrossChainArbitrage(sourcePrice, targetPrice, bridgeFee, gasCost) {
        if (!this.calculator)
            throw new Error('WebAssembly calculator not initialized');
        return this.calculator.calculate_cross_chain_arbitrage(sourcePrice, targetPrice, bridgeFee, gasCost);
    }
    batchCalculateOpportunities(prices, minProfit) {
        if (!this.calculator)
            throw new Error('WebAssembly calculator not initialized');
        const results = this.calculator.batch_calculate_opportunities(prices, minProfit);
        const opportunities = [];
        for (let i = 0; i < results.length; i += 2) {
            opportunities.push({
                pairIndex: results[i],
                profit: results[i + 1]
            });
        }
        return opportunities;
    }
    optimizeGasPrice(baseFee, priorityFee, volatility) {
        if (!this.calculator)
            throw new Error('WebAssembly calculator not initialized');
        return this.calculator.optimize_gas_price(baseFee, priorityFee, volatility);
    }
    getPerformanceMetrics() {
        if (!this.performanceMonitor) {
            return { averageLatency: 0, operationsPerSecond: 0 };
        }
        return {
            averageLatency: this.performanceMonitor.get_average_latency(),
            operationsPerSecond: this.performanceMonitor.get_operations_per_second()
        };
    }
    // Statistical analysis functions
    calculateProfitPercentage(buyPrice, sellPrice, fee) {
        return (0, arbitrage_calculator_js_1.calculate_profit_percentage)(buyPrice, sellPrice, fee);
    }
    calculateOptimalTradeSize(balance, price, maxSlippage) {
        return (0, arbitrage_calculator_js_1.calculate_optimal_trade_size)(balance, price, maxSlippage);
    }
    calculateRiskAdjustedPositionSize(balance, riskPercentage, stopLoss) {
        return (0, arbitrage_calculator_js_1.risk_adjusted_position_size)(balance, riskPercentage, stopLoss);
    }
    // Technical analysis functions
    movingAverage(prices, window) {
        if (!this.calculator)
            throw new Error('WebAssembly calculator not initialized');
        const result = this.calculator.moving_average(prices, window);
        return Array.from(result);
    }
    exponentialMovingAverage(prices, alpha) {
        if (!this.calculator)
            throw new Error('WebAssembly calculator not initialized');
        const result = this.calculator.exponential_moving_average(prices, alpha);
        return Array.from(result);
    }
    bollingerBands(prices, window, stdMultiplier) {
        if (!this.calculator)
            throw new Error('WebAssembly calculator not initialized');
        const result = this.calculator.bollinger_bands(prices, window, stdMultiplier);
        const bands = [];
        for (let i = 0; i < result.length; i += 3) {
            bands.push({
                upper: result[i],
                middle: result[i + 1],
                lower: result[i + 2]
            });
        }
        return bands;
    }
    statisticalArbitrageSignal(currentPrice, mean, stdDev, zThreshold) {
        if (!this.calculator)
            throw new Error('WebAssembly calculator not initialized');
        return this.calculator.statistical_arbitrage_signal(currentPrice, mean, stdDev, zThreshold);
    }
    calculateImpermanentLoss(priceRatio, poolRatio) {
        if (!this.calculator)
            throw new Error('WebAssembly calculator not initialized');
        return this.calculator.calculate_impermanent_loss(priceRatio, poolRatio);
    }
}
exports.WasmArbitrageEngine = WasmArbitrageEngine;
// Singleton instance
let wasmEngine = null;
async function getWasmArbitrageEngine() {
    if (!wasmEngine) {
        wasmEngine = new WasmArbitrageEngine();
        await wasmEngine.initialize();
    }
    return wasmEngine;
}
//# sourceMappingURL=index.js.map