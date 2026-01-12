// Event Processor Worker Thread
// Handles parallel processing of arbitrage detection tasks

import { parentPort, workerData } from 'worker_threads';

const { workerId } = workerData;

interface TaskMessage {
  type: 'process_task';
  taskId: string;
  taskType: string;
  taskData: any;
}

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
  const price = (reserves.reserve1 * (1 - (fee || 0))) / reserves.reserve0;

  return {
    price,
    adjustedPrice: price,
    fee: fee || 0
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