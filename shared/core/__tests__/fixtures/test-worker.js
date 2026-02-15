/**
 * Minimal worker script for integration testing EventProcessingWorkerPool.
 *
 * Implements the same message protocol as event-processor-worker.ts
 * without complex dependencies (PriceMatrix, MultiLegPathFinder).
 *
 * Supported task types:
 * - json_parsing: Parse a JSON string (real implementation)
 * - batch_json_parsing: Parse multiple JSON strings (real implementation)
 * - echo: Return taskData as-is (for testing message round-trip)
 * - fail: Throw an error (for testing error paths)
 * - slow: Delay response by taskData.delayMs (for testing timeouts)
 *
 * @see shared/core/src/event-processor-worker.ts — Production worker
 * @see Finding #16: Enable real worker integration tests
 */

'use strict';

const { parentPort, workerData } = require('worker_threads');

const workerId = workerData?.workerId ?? 0;

// JSON parsing (matches production worker behavior)
function processJsonParsing(data) {
  const { jsonString } = data;

  if (typeof jsonString !== 'string') {
    throw new Error('jsonString must be a string');
  }

  const startTime = process.hrtime.bigint();
  const parsed = JSON.parse(jsonString);
  const endTime = process.hrtime.bigint();

  const parseTimeUs = Number(endTime - startTime) / 1000;

  return {
    parsed,
    byteLength: Buffer.byteLength(jsonString, 'utf8'),
    parseTimeUs
  };
}

// Batch JSON parsing (matches production worker behavior)
function processBatchJsonParsing(data) {
  const { jsonStrings } = data;

  if (!Array.isArray(jsonStrings)) {
    throw new Error('jsonStrings must be an array');
  }

  const results = [];
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
      results.push({ error: error.message });
      errorCount++;
    }
  }

  return { results, totalParseTimeUs, successCount, errorCount };
}

// Message handler (same protocol as production worker)
parentPort?.on('message', async (message) => {
  const startTime = Date.now();

  try {
    const { taskId, taskType, taskData } = message;
    let result;

    switch (taskType) {
      case 'json_parsing':
        result = processJsonParsing(taskData);
        break;

      case 'batch_json_parsing':
        result = processBatchJsonParsing(taskData);
        break;

      case 'echo':
        result = taskData;
        break;

      case 'fail':
        throw new Error(taskData?.message ?? 'Intentional test failure');

      case 'slow':
        await new Promise(resolve => setTimeout(resolve, taskData?.delayMs ?? 1000));
        result = { delayed: true };
        break;

      default:
        throw new Error(`Unknown task type: ${taskType}`);
    }

    const processingTime = Date.now() - startTime;
    parentPort?.postMessage({ taskId, success: true, result, processingTime });
  } catch (error) {
    const processingTime = Date.now() - startTime;
    parentPort?.postMessage({
      taskId: message.taskId,
      success: false,
      error: error.message,
      processingTime
    });
  }
});
