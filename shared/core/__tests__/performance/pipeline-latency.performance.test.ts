/**
 * Pipeline Latency Performance Test
 *
 * Phase 0 instrumentation benchmark: measures the overhead of pipeline
 * timestamp tracking across the price update serialization/deserialization path.
 *
 * Tests:
 * - PriceUpdate creation with pipelineTimestamps
 * - JSON serialize/deserialize round-trip
 * - Timestamp stamping at each pipeline stage
 * - P50/P95/P99 latency statistics
 *
 * Target: P95 < 10ms for full serialization round-trip with timestamp stamping
 *
 * @see Phase 0 instrumentation in shared/types/src/index.ts
 */

import { describe, it, expect } from '@jest/globals';
import type { PriceUpdate, PipelineTimestamps } from '@arbitrage/types';

// =============================================================================
// Configuration
// =============================================================================

const ITERATIONS = 1000;
const WARMUP_ITERATIONS = 100;

const THRESHOLDS = {
  /** P95 latency for full round-trip (ms) */
  p95MaxMs: 10,
  /** P99 latency for full round-trip (ms) */
  p99MaxMs: 20,
};

// =============================================================================
// Helpers
// =============================================================================

/**
 * Calculate percentile from sorted array of numbers.
 */
function percentile(sorted: number[], p: number): number {
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

/**
 * Simulate a full pipeline stage: create PriceUpdate, serialize, deserialize, stamp timestamps.
 * Returns elapsed time in milliseconds.
 */
function runPipelineIteration(): number {
  const start = performance.now();

  // Stage 1: WebSocket receive - create PriceUpdate with initial timestamps
  const wsReceivedAt = Date.now();

  const priceUpdate: PriceUpdate = {
    chain: 'bsc',
    dex: 'pancakeswap-v2',
    pairKey: 'bsc:pancakeswap-v2:0xToken0:0xToken1',
    pairAddress: '0x0000000000000000000000000000000000000001',
    token0: '0xToken0Address000000000000000000000000000',
    token1: '0xToken1Address000000000000000000000000000',
    price: 1.0023,
    reserve0: '1000000000000000000000',
    reserve1: '1002300000000000000000',
    timestamp: Date.now(),
    blockNumber: 12345678,
    latency: 0,
    fee: 3000,
    pipelineTimestamps: {
      wsReceivedAt,
      publishedAt: Date.now(),
    },
  };

  // Stage 2: Serialize to JSON (simulating Redis XADD)
  const serialized = JSON.stringify(priceUpdate);

  // Stage 3: Deserialize from JSON (simulating XREADGROUP)
  const deserialized = JSON.parse(serialized) as PriceUpdate;

  // Stage 4: Consumer stamps consumedAt
  const timestamps: PipelineTimestamps = deserialized.pipelineTimestamps ?? {};
  timestamps.consumedAt = Date.now();
  deserialized.pipelineTimestamps = timestamps;

  // Stage 5: Detector stamps detectedAt (simulating opportunity detection)
  timestamps.detectedAt = Date.now();

  // Stage 6: Coordinator stamps coordinatorAt
  timestamps.coordinatorAt = Date.now();

  // Stage 7: Serialize opportunity for execution requests (flat map)
  const flatMap: Record<string, string> = {
    id: 'opp-' + Math.random().toString(36).slice(2),
    type: 'simple',
    chain: deserialized.chain,
    pipelineTimestamps: JSON.stringify(timestamps),
  };

  // Stage 8: Deserialize at execution engine
  const parsedTimestamps = JSON.parse(flatMap.pipelineTimestamps) as PipelineTimestamps;
  parsedTimestamps.executionReceivedAt = Date.now();

  const end = performance.now();
  return end - start;
}

// =============================================================================
// Tests
// =============================================================================

describe('Pipeline Latency Benchmark', () => {
  it('should complete full pipeline round-trip within P95 < 10ms', () => {
    // Warm up to stabilize JIT
    for (let i = 0; i < WARMUP_ITERATIONS; i++) {
      runPipelineIteration();
    }

    // Collect measurements
    const latencies: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      latencies.push(runPipelineIteration());
    }

    // Sort for percentile calculation
    latencies.sort((a, b) => a - b);

    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    const p99 = percentile(latencies, 99);
    const avg = latencies.reduce((sum, v) => sum + v, 0) / latencies.length;
    const min = latencies[0];
    const max = latencies[latencies.length - 1];

    // Log statistics for analysis
     
    console.log('Pipeline Latency Statistics:');
     
    console.log(`  Iterations: ${ITERATIONS}`);
     
    console.log(`  Min:  ${min.toFixed(3)}ms`);
     
    console.log(`  Avg:  ${avg.toFixed(3)}ms`);
     
    console.log(`  P50:  ${p50.toFixed(3)}ms`);
     
    console.log(`  P95:  ${p95.toFixed(3)}ms`);
     
    console.log(`  P99:  ${p99.toFixed(3)}ms`);
     
    console.log(`  Max:  ${max.toFixed(3)}ms`);

    // Assert performance bounds
    expect(p95).toBeLessThan(THRESHOLDS.p95MaxMs);
    expect(p99).toBeLessThan(THRESHOLDS.p99MaxMs);
  });

  it('should measure negligible overhead from PipelineTimestamps field', () => {
    // Compare PriceUpdate creation with and without pipelineTimestamps

    // Warm up
    for (let i = 0; i < WARMUP_ITERATIONS; i++) {
      const update: PriceUpdate = {
        chain: 'bsc', dex: 'pancakeswap-v2', pairKey: 'key',
        token0: '0xA', token1: '0xB', price: 1.0, reserve0: '1000', reserve1: '1000',
        timestamp: Date.now(), blockNumber: 1, latency: 0,
      };
      JSON.stringify(update);
    }

    // Without timestamps
    const withoutLatencies: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const start = performance.now();
      const update: PriceUpdate = {
        chain: 'bsc', dex: 'pancakeswap-v2', pairKey: 'key',
        token0: '0xA', token1: '0xB', price: 1.0, reserve0: '1000', reserve1: '1000',
        timestamp: Date.now(), blockNumber: 1, latency: 0,
      };
      JSON.stringify(update);
      withoutLatencies.push(performance.now() - start);
    }

    // With timestamps
    const withLatencies: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const start = performance.now();
      const update: PriceUpdate = {
        chain: 'bsc', dex: 'pancakeswap-v2', pairKey: 'key',
        token0: '0xA', token1: '0xB', price: 1.0, reserve0: '1000', reserve1: '1000',
        timestamp: Date.now(), blockNumber: 1, latency: 0,
        pipelineTimestamps: {
          wsReceivedAt: Date.now(),
          publishedAt: Date.now(),
        },
      };
      JSON.stringify(update);
      withLatencies.push(performance.now() - start);
    }

    const avgWithout = withoutLatencies.reduce((s, v) => s + v, 0) / ITERATIONS;
    const avgWith = withLatencies.reduce((s, v) => s + v, 0) / ITERATIONS;
    const overheadMs = avgWith - avgWithout;

     
    console.log('PipelineTimestamps Overhead:');
     
    console.log(`  Without: ${avgWithout.toFixed(4)}ms avg`);
     
    console.log(`  With:    ${avgWith.toFixed(4)}ms avg`);
     
    console.log(`  Overhead: ${overheadMs.toFixed(4)}ms (${((overheadMs / avgWithout) * 100).toFixed(1)}%)`);

    // Overhead should be negligible (< 1ms per operation)
    expect(overheadMs).toBeLessThan(1);
  });
});
