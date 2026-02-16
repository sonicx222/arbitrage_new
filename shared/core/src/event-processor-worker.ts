// Event Processor Worker Thread
// Handles parallel processing of arbitrage detection tasks

import { parentPort, workerData } from 'worker_threads';
import { PriceMatrix } from './caching/price-matrix';

const { workerId, priceBuffer, keyRegistryBuffer } = workerData;

// PHASE3-TASK42: Initialize PriceMatrix from SharedArrayBuffer
// PHASE3-TASK43: Attach to SharedKeyRegistry for key-to-index mapping
// This enables zero-copy price access (<1μs vs 20ms message passing)
let workerPriceMatrix: PriceMatrix | null = null;

if (priceBuffer && priceBuffer instanceof SharedArrayBuffer) {
  try {
    // Create PriceMatrix instance from shared buffer
    // Workers get read-only access to price data updated by main thread
    // Pass key registry buffer for key lookups (PHASE3-TASK43)
    const keyRegistry = (keyRegistryBuffer && keyRegistryBuffer instanceof SharedArrayBuffer)
      ? keyRegistryBuffer
      : null;

    workerPriceMatrix = PriceMatrix.fromSharedBuffer(priceBuffer, keyRegistry);

    const registryInfo = keyRegistry ? ' with key registry' : ' (no key registry - lookups disabled)';
    console.log(`Worker ${workerId}: PriceMatrix initialized from SharedArrayBuffer (${priceBuffer.byteLength} bytes)${registryInfo}`);
  } catch (error) {
    console.error(`Worker ${workerId}: Failed to initialize PriceMatrix:`, error);
  }
} else {
  console.log(`Worker ${workerId}: No SharedArrayBuffer provided, price lookups disabled`);
}

/**
 * PHASE3-TASK42: Fast price lookup using SharedArrayBuffer.
 * Returns price from shared memory without message passing overhead.
 *
 * @param key - Price key (e.g., "price:eth:usd")
 * @returns Price entry or null if not found
 */
function getPriceFromSharedMemory(key: string): { price: number; timestamp: number } | null {
  if (!workerPriceMatrix) {
    return null;
  }

  return workerPriceMatrix.getPrice(key);
}

/**
 * PHASE3-TASK42: Batch price lookup from SharedArrayBuffer.
 *
 * @param keys - Array of price keys
 * @returns Map of key to price entry
 */
function getBatchPricesFromSharedMemory(keys: string[]): Map<string, { price: number; timestamp: number }> {
  const result = new Map<string, { price: number; timestamp: number }>();

  if (!workerPriceMatrix) {
    return result;
  }

  const prices = workerPriceMatrix.getBatch(keys);

  for (let i = 0; i < keys.length; i++) {
    const priceEntry = prices[i];
    if (priceEntry !== null) {
      result.set(keys[i], priceEntry);
    }
  }

  return result;
}

interface TaskMessage {
  type: 'process_task';
  taskId: string;
  taskType: string;
  taskData: any;
}

// Reuse one path finder per worker process to avoid expensive per-task reinitialization.
let workerMultiLegPathFinder: any = null;
let workerMultiLegPathFinderConfigHash: string | null = null;

// Task processing functions
interface ArbitrageResult {
  pairKey: string;
  profit: number;
  buyPrice: number;
  sellPrice: number;
}

async function processArbitrageDetection(data: any): Promise<any> {
  const { prices, minProfit } = data;

  // Use WebAssembly engine for arbitrage detection
  // For now, simulate with mock calculations

  const opportunities: ArbitrageResult[] = [];

  // Mock arbitrage detection logic
  if (prices && prices.length >= 2) {
    const buyPrice = Math.min(...prices);
    const sellPrice = Math.max(...prices);

    if (sellPrice > buyPrice) {
      const profit = (sellPrice - buyPrice) / buyPrice;

      if (profit > minProfit) {
        opportunities.push({
          pairKey: 'MOCK/USDT',
          profit,
          buyPrice,
          sellPrice
        });
      }
    }
  }

  return {
    opportunities,
    processed: true
  };
}

async function processPriceCalculation(data: any): Promise<any> {
  const { reserves, fee } = data;

  if (!reserves || !reserves.reserve0 || !reserves.reserve1) {
    throw new Error('Invalid reserve data');
  }

  // Calculate price with fee adjustment
  // S2.2.3 FIX: Use ?? instead of || to correctly handle fee: 0 (if any DEX has 0% fee)
  const price = (reserves.reserve1 * (1 - (fee ?? 0))) / reserves.reserve0;

  return {
    price,
    adjustedPrice: price,
    fee: fee ?? 0
  };
}

async function processCorrelationAnalysis(data: any): Promise<any> {
  const { priceHistory1, priceHistory2 } = data;

  if (!priceHistory1 || !priceHistory2 || priceHistory1.length !== priceHistory2.length) {
    throw new Error('Invalid price history data');
  }

  // Calculate Pearson correlation coefficient
  const n = priceHistory1.length;
  let sum1 = 0, sum2 = 0, sum1Sq = 0, sum2Sq = 0, pSum = 0;

  for (let i = 0; i < n; i++) {
    const x = priceHistory1[i];
    const y = priceHistory2[i];

    sum1 += x;
    sum2 += y;
    sum1Sq += x * x;
    sum2Sq += y * y;
    pSum += x * y;
  }

  const numerator = pSum - (sum1 * sum2 / n);
  const denominator = Math.sqrt((sum1Sq - sum1 * sum1 / n) * (sum2Sq - sum2 * sum2 / n));

  const correlation = denominator === 0 ? 0 : numerator / denominator;

  return {
    correlation: Math.max(-1, Math.min(1, correlation)), // Clamp to [-1, 1]
    strength: Math.abs(correlation) > 0.7 ? 'strong' :
             Math.abs(correlation) > 0.5 ? 'medium' : 'weak'
  };
}

async function processTriangularArbitrage(data: any): Promise<any> {
  const { p0, p1, p2, fee } = data;

  // Calculate triangular arbitrage profit
  const amount = 1000000000000000000; // 1 ETH in wei
  const result = amount * p0 * (1 - fee) * p1 * (1 - fee) * p2 * (1 - fee);
  const profit = (result - amount) / amount;

  return {
    profit,
    profitable: profit > 0,
    path: [p0, p1, p2]
  };
}

async function processStatisticalAnalysis(data: any): Promise<any> {
  const { prices, window } = data;

  if (!prices || prices.length < window) {
    throw new Error('Insufficient price data for statistical analysis');
  }

  // Calculate moving average
  const movingAverage: number[] = [];
  for (let i = window - 1; i < prices.length; i++) {
    const sum = prices.slice(i - window + 1, i + 1).reduce((a: number, b: number) => a + b, 0);
    movingAverage.push(sum / window);
  }

  // Calculate volatility (standard deviation)
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  }

  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, ret) => sum + Math.pow(ret - meanReturn, 2), 0) / returns.length;
  const volatility = Math.sqrt(variance);

  return {
    movingAverage: movingAverage[movingAverage.length - 1], // Latest MA
    volatility,
    trend: movingAverage[movingAverage.length - 1] > movingAverage[movingAverage.length - 2] ? 'up' : 'down'
  };
}

/**
 * Process JSON parsing task.
 * Offloads JSON.parse from main event loop for high-throughput WebSocket processing.
 *
 * Benefits:
 * - Prevents main thread blocking during JSON parsing
 * - Enables 2-4x event throughput increase
 * - Amortizes parsing overhead across worker threads
 *
 * Trade-offs:
 * - Message passing overhead (~0.5-1ms per message)
 * - Best for larger JSON payloads or high-frequency streams
 * - May not benefit small messages (<1KB)
 *
 * @see ADR-012: Worker Thread Path Finding (extended for JSON parsing)
 * @see RPC_DATA_OPTIMIZATION_RESEARCH.md Phase 2
 */
function processJsonParsing(data: { jsonString: string }): {
  parsed: unknown;
  byteLength: number;
  parseTimeUs: number;
} {
  const { jsonString } = data;

  if (typeof jsonString !== 'string') {
    throw new Error('jsonString must be a string');
  }

  const startTime = process.hrtime.bigint();
  const parsed = JSON.parse(jsonString);
  const endTime = process.hrtime.bigint();

  // Calculate parse time in microseconds
  const parseTimeUs = Number(endTime - startTime) / 1000;

  return {
    parsed,
    byteLength: Buffer.byteLength(jsonString, 'utf8'),
    parseTimeUs
  };
}

/**
 * Process batch JSON parsing task.
 * Parses multiple JSON strings in a single worker message to amortize overhead.
 *
 * Use this for batching multiple WebSocket messages for efficient parsing.
 */
function processBatchJsonParsing(data: { jsonStrings: string[] }): {
  results: Array<{ parsed: unknown; byteLength: number; parseTimeUs: number } | { error: string }>;
  totalParseTimeUs: number;
  successCount: number;
  errorCount: number;
} {
  const { jsonStrings } = data;

  if (!Array.isArray(jsonStrings)) {
    throw new Error('jsonStrings must be an array');
  }

  const results: Array<{ parsed: unknown; byteLength: number; parseTimeUs: number } | { error: string }> = [];
  let totalParseTimeUs = 0;
  let successCount = 0;
  let errorCount = 0;

  for (const jsonString of jsonStrings) {
    try {
      const result = processJsonParsing({ jsonString });
      results.push(result);
      totalParseTimeUs += result.parseTimeUs;
      successCount++;
    } catch (error) {
      results.push({ error: error instanceof Error ? error.message : String(error) });
      errorCount++;
    }
  }

  return {
    results,
    totalParseTimeUs,
    successCount,
    errorCount
  };
}

/**
 * Process multi-leg path finding task.
 * Offloads CPU-intensive DFS from main event loop.
 */
async function processMultiLegPathFinding(data: any): Promise<any> {
  const { chain, pools, baseTokens, targetPathLength, config } = data;

  // Dynamic import to avoid circular dependencies
  const { MultiLegPathFinder } = await import('./multi-leg-path-finder');
  const requestedConfig = config || {};
  const requestedConfigHash = JSON.stringify(requestedConfig);

  if (!workerMultiLegPathFinder) {
    workerMultiLegPathFinder = new MultiLegPathFinder(requestedConfig);
    workerMultiLegPathFinderConfigHash = requestedConfigHash;
  } else if (workerMultiLegPathFinderConfigHash !== requestedConfigHash) {
    workerMultiLegPathFinder.updateConfig(requestedConfig);
    workerMultiLegPathFinderConfigHash = requestedConfigHash;
  }

  const startTime = Date.now();
  const opportunities = await workerMultiLegPathFinder.findMultiLegOpportunities(
    chain,
    pools,
    baseTokens,
    targetPathLength
  );
  const processingTimeMs = Date.now() - startTime;

  const stats = workerMultiLegPathFinder.getStats();

  return {
    opportunities,
    stats: {
      pathsExplored: stats.totalPathsExplored,
      processingTimeMs
    }
  };
}

// Message handler
parentPort?.on('message', async (message: TaskMessage) => {
  const startTime = Date.now();

  try {
    const { taskId, taskType, taskData } = message;

    let result: any;

    // Route to appropriate processing function
    switch (taskType) {
      case 'arbitrage_detection':
        result = await processArbitrageDetection(taskData);
        break;

      case 'price_calculation':
        result = await processPriceCalculation(taskData);
        break;

      case 'correlation_analysis':
        result = await processCorrelationAnalysis(taskData);
        break;

      case 'triangular_arbitrage':
        result = await processTriangularArbitrage(taskData);
        break;

      case 'statistical_analysis':
        result = await processStatisticalAnalysis(taskData);
        break;

      case 'multi_leg_path_finding':
        result = await processMultiLegPathFinding(taskData);
        break;

      case 'json_parsing':
        // Synchronous - no await needed
        result = processJsonParsing(taskData);
        break;

      case 'batch_json_parsing':
        // Synchronous - no await needed
        result = processBatchJsonParsing(taskData);
        break;

      default:
        throw new Error(`Unknown task type: ${taskType}`);
    }

    const processingTime = Date.now() - startTime;

    // Send result back to main thread
    parentPort?.postMessage({
      taskId,
      success: true,
      result,
      processingTime
    });

  } catch (error: any) {
    const processingTime = Date.now() - startTime;

    // Send error back to main thread
    parentPort?.postMessage({
      taskId: message.taskId,
      success: false,
      error: error.message,
      processingTime
    });
  }
});

// Worker initialization complete
console.log(`Event processor worker ${workerId} initialized`);
