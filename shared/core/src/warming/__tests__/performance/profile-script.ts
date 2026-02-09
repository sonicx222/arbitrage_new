/**
 * Performance Profiling Script (Day 12)
 *
 * Standalone script for profiling warming infrastructure.
 * Run with: node --prof --expose-gc profile-script.js
 *
 * @package @arbitrage/core
 * @module warming/performance
 */

import {
  createTopNWarming,
  createAdaptiveWarming,
  WarmingComponents,
} from '../../container/warming.container';
import { HierarchicalCache } from '../../../caching/hierarchical-cache';

interface ProfileResult {
  operation: string;
  samples: number;
  avgDuration: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  min: number;
}

class PerformanceProfiler {
  private cache: HierarchicalCache;
  private components: WarmingComponents;

  constructor() {
    this.cache = new HierarchicalCache({
      l1Size: 256,
      l2Enabled: true,
      usePriceMatrix: true,
    });

    this.components = createAdaptiveWarming(this.cache, 0.97, 10);
  }

  async initialize(): Promise<void> {
    console.log('Initializing cache with test data...');

    for (let i = 0; i < 500; i++) {
      await this.cache.set(`price:ethereum:0x${i.toString(16).padStart(40, '0')}`, {
        price: 1.0 + Math.random(),
        reserve0: (1000000 + Math.random() * 1000000).toString(),
        reserve1: (1000000 + Math.random() * 1000000).toString(),
      });
    }

    console.log('Cache initialized\n');
  }

  /**
   * Profile correlation tracking
   */
  async profileTracking(samples: number = 100000): Promise<ProfileResult> {
    console.log(`Profiling correlation tracking (${samples} samples)...`);

    const durations: number[] = [];
    const uniquePairs = 200;

    // Warm up
    for (let i = 0; i < 1000; i++) {
      this.components.tracker.recordPriceUpdate(
        `0x${(i % uniquePairs).toString(16).padStart(40, '0')}`,
        Date.now()
      );
    }

    // Force GC before profiling
    if (global.gc) {
      global.gc();
    }

    // Profile
    const start = performance.now();

    for (let i = 0; i < samples; i++) {
      const pairAddress = `0x${(i % uniquePairs).toString(16).padStart(40, '0')}`;
      const result = this.components.tracker.recordPriceUpdate(pairAddress, Date.now());

      if (result.durationUs) {
        durations.push(result.durationUs);
      }
    }

    const elapsed = performance.now() - start;

    return this.analyzeResults('Correlation Tracking', samples, durations, elapsed);
  }

  /**
   * Profile warming operations
   */
  async profileWarming(samples: number = 10000): Promise<ProfileResult> {
    console.log(`Profiling warming operations (${samples} samples)...`);

    // Build correlations first
    const uniquePairs = 100;
    for (let i = 0; i < uniquePairs; i++) {
      for (let j = 0; j < 10; j++) {
        this.components.tracker.recordPriceUpdate(
          `0x${i.toString(16).padStart(40, '0')}`,
          Date.now() + j * 100
        );
      }
    }

    const durations: number[] = [];

    // Warm up
    for (let i = 0; i < 100; i++) {
      await this.components.warmer.warmForPair(
        `0x${(i % uniquePairs).toString(16).padStart(40, '0')}`
      );
    }

    // Force GC before profiling
    if (global.gc) {
      global.gc();
    }

    // Profile
    const start = performance.now();

    for (let i = 0; i < samples; i++) {
      const pairAddress = `0x${(i % uniquePairs).toString(16).padStart(40, '0')}`;
      const result = await this.components.warmer.warmForPair(pairAddress);

      durations.push(result.durationMs);
    }

    const elapsed = performance.now() - start;

    return this.analyzeResults('Warming Operations', samples, durations, elapsed);
  }

  /**
   * Profile strategy selection
   */
  async profileStrategySelection(samples: number = 100000): Promise<ProfileResult> {
    console.log(`Profiling strategy selection (${samples} samples)...`);

    // Build correlations
    const uniquePairs = 200;
    for (let i = 0; i < uniquePairs; i++) {
      for (let j = 0; j < 10; j++) {
        this.components.tracker.recordPriceUpdate(
          `0x${i.toString(16).padStart(40, '0')}`,
          Date.now() + j * 100
        );
      }
    }

    const durations: number[] = [];

    // Warm up
    for (let i = 0; i < 1000; i++) {
      this.components.tracker.getPairsToWarm(
        `0x${(i % uniquePairs).toString(16).padStart(40, '0')}`,
        Date.now(),
        10,
        0.3
      );
    }

    // Force GC before profiling
    if (global.gc) {
      global.gc();
    }

    // Profile
    const start = performance.now();

    for (let i = 0; i < samples; i++) {
      const pairAddress = `0x${(i % uniquePairs).toString(16).padStart(40, '0')}`;
      const startOp = performance.now();

      this.components.tracker.getPairsToWarm(pairAddress, Date.now(), 10, 0.3);

      durations.push((performance.now() - startOp) * 1000); // Convert to μs
    }

    const elapsed = performance.now() - start;

    return this.analyzeResults('Strategy Selection', samples, durations, elapsed);
  }

  /**
   * Profile memory allocation patterns
   */
  async profileMemoryAllocation(): Promise<void> {
    console.log('Profiling memory allocation patterns...\n');

    const measurements: Array<{
      operation: string;
      heapBefore: number;
      heapAfter: number;
      increase: number;
    }> = [];

    // Test 1: Tracking 1000 unique pairs
    if (global.gc) global.gc();
    let heapBefore = process.memoryUsage().heapUsed;

    for (let i = 0; i < 1000; i++) {
      this.components.tracker.recordPriceUpdate(
        `0x${i.toString(16).padStart(40, '0')}`,
        Date.now()
      );
    }

    if (global.gc) global.gc();
    let heapAfter = process.memoryUsage().heapUsed;

    measurements.push({
      operation: 'Track 1000 unique pairs',
      heapBefore,
      heapAfter,
      increase: heapAfter - heapBefore,
    });

    // Test 2: Warming operations
    if (global.gc) global.gc();
    heapBefore = process.memoryUsage().heapUsed;

    for (let i = 0; i < 1000; i++) {
      await this.components.warmer.warmForPair(
        `0x${(i % 100).toString(16).padStart(40, '0')}`
      );
    }

    if (global.gc) global.gc();
    heapAfter = process.memoryUsage().heapUsed;

    measurements.push({
      operation: 'Perform 1000 warmings',
      heapBefore,
      heapAfter,
      increase: heapAfter - heapBefore,
    });

    console.log('=== Memory Allocation Results ===');
    for (const m of measurements) {
      console.log(`${m.operation}:`);
      console.log(`  Before: ${(m.heapBefore / 1024 / 1024).toFixed(2)}MB`);
      console.log(`  After: ${(m.heapAfter / 1024 / 1024).toFixed(2)}MB`);
      console.log(`  Increase: ${(m.increase / 1024).toFixed(2)}KB`);
    }
    console.log();
  }

  /**
   * Profile CPU hotspots
   */
  async profileCPUHotspots(): Promise<void> {
    console.log('Profiling CPU hotspots (run with --prof for detailed analysis)...\n');

    const operations = [
      { name: 'Tracking (10k)', count: 10000, fn: this.profileTracking.bind(this) },
      { name: 'Warming (1k)', count: 1000, fn: this.profileWarming.bind(this) },
      { name: 'Selection (10k)', count: 10000, fn: this.profileStrategySelection.bind(this) },
    ];

    for (const op of operations) {
      const start = process.cpuUsage();
      await op.fn(op.count);
      const cpuUsage = process.cpuUsage(start);

      console.log(`CPU Usage for ${op.name}:`);
      console.log(`  User: ${(cpuUsage.user / 1000).toFixed(2)}ms`);
      console.log(`  System: ${(cpuUsage.system / 1000).toFixed(2)}ms`);
      console.log(`  Total: ${((cpuUsage.user + cpuUsage.system) / 1000).toFixed(2)}ms`);
      console.log();
    }
  }

  /**
   * Run comprehensive performance profile
   */
  async runFullProfile(): Promise<void> {
    console.log('\n==============================================');
    console.log('   Warming Infrastructure Performance Profile');
    console.log('==============================================\n');

    await this.initialize();

    // Profile each operation
    const trackingResult = await this.profileTracking(100000);
    this.printResult(trackingResult);

    const warmingResult = await this.profileWarming(10000);
    this.printResult(warmingResult);

    const selectionResult = await this.profileStrategySelection(100000);
    this.printResult(selectionResult);

    // Memory profiling
    await this.profileMemoryAllocation();

    // CPU profiling
    await this.profileCPUHotspots();

    // Summary
    this.printSummary([trackingResult, warmingResult, selectionResult]);

    console.log('==============================================');
    console.log('Profile complete!');
    console.log('==============================================\n');
  }

  /**
   * Analyze profiling results
   */
  private analyzeResults(
    operation: string,
    samples: number,
    durations: number[],
    elapsed: number
  ): ProfileResult {
    durations.sort((a, b) => a - b);

    const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
    const p50 = durations[Math.floor(durations.length * 0.5)];
    const p95 = durations[Math.floor(durations.length * 0.95)];
    const p99 = durations[Math.floor(durations.length * 0.99)];
    const max = durations[durations.length - 1];
    const min = durations[0];

    return {
      operation,
      samples,
      avgDuration: avg,
      p50,
      p95,
      p99,
      max,
      min,
    };
  }

  /**
   * Print profiling result
   */
  private printResult(result: ProfileResult): void {
    const unit = result.operation.includes('Warming') ? 'ms' : 'μs';

    console.log(`\n=== ${result.operation} ===`);
    console.log(`Samples: ${result.samples.toLocaleString()}`);
    console.log(`Average: ${result.avgDuration.toFixed(2)}${unit}`);
    console.log(`P50: ${result.p50.toFixed(2)}${unit}`);
    console.log(`P95: ${result.p95.toFixed(2)}${unit}`);
    console.log(`P99: ${result.p99.toFixed(2)}${unit}`);
    console.log(`Min: ${result.min.toFixed(2)}${unit}`);
    console.log(`Max: ${result.max.toFixed(2)}${unit}`);
  }

  /**
   * Print summary
   */
  private printSummary(results: ProfileResult[]): void {
    console.log('\n=== Performance Summary ===\n');

    const tracking = results.find(r => r.operation.includes('Tracking'));
    const warming = results.find(r => r.operation.includes('Warming'));
    const selection = results.find(r => r.operation.includes('Selection'));

    if (tracking) {
      const target = 50;
      const status = tracking.p95 < target ? '✓ PASS' : '✗ FAIL';
      console.log(`Correlation Tracking P95: ${tracking.p95.toFixed(1)}μs (target: <${target}μs) ${status}`);
    }

    if (warming) {
      const target = 10;
      const status = warming.p95 < target ? '✓ PASS' : '✗ FAIL';
      console.log(`Warming Operations P95: ${warming.p95.toFixed(2)}ms (target: <${target}ms) ${status}`);
    }

    if (selection) {
      const target = 100;
      const status = selection.p95 < target ? '✓ PASS' : '✗ FAIL';
      console.log(`Strategy Selection P95: ${selection.p95.toFixed(1)}μs (target: <${target}μs) ${status}`);
    }

    console.log();
  }

  async cleanup(): Promise<void> {
    await this.cache.clear();
  }
}

// Main execution
async function main() {
  const profiler = new PerformanceProfiler();

  try {
    await profiler.runFullProfile();
  } catch (error) {
    console.error('Profiling error:', error);
    process.exit(1);
  } finally {
    await profiler.cleanup();
  }
}

// Run if executed directly
if (require.main === module) {
  main().then(() => {
    console.log('Profiling script completed successfully');
    process.exit(0);
  }).catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { PerformanceProfiler };
