// Predictive Cache Warmer
// Intelligent pre-loading of price data based on correlation analysis

import { getMatrixPriceCache, MatrixPriceCache } from './matrix-cache';
import { createLogger } from './logger';

const logger = createLogger('predictive-warmer');

export interface CorrelationData {
  pairKey: string;
  score: number; // Correlation score 0-1
  strength: 'weak' | 'medium' | 'strong';
}

export interface CorrelationGraph {
  [pairKey: string]: CorrelationData[];
}

export class PredictiveCacheWarmer {
  private cache: MatrixPriceCache;
  private correlationGraph: CorrelationGraph = {};
  private warmupQueue: Array<{
    pairKey: string;
    priority: number;
    expectedAccessTime: number;
    reason: string;
  }> = [];
  private accessHistory: Map<string, number[]> = new Map(); // pairKey -> timestamps
  private correlationCache: Map<string, CorrelationData[]> = new Map();

  constructor(cache?: MatrixPriceCache) {
    this.cache = cache || getMatrixPriceCache();
  }

  // Called when a price update occurs
  async onPriceUpdate(pairKey: string, dexName: string): Promise<void> {
    // Record access
    this.recordAccess(pairKey);

    // Get correlated pairs
    const correlated = this.getCorrelatedPairs(pairKey, {
      minScore: 0.6,
      limit: 10,
      includeHistorical: true
    });

    // Queue for warming
    for (const corr of correlated) {
      this.warmupQueue.push({
        pairKey: corr.pairKey,
        priority: corr.score * 100,
        expectedAccessTime: Date.now() + 100, // Predict access within 100ms
        reason: `correlated_with_${pairKey}`
      });
    }

    // Process warmup queue
    await this.processWarmupQueue();
  }

  // Called when an arbitrage opportunity is detected
  async onArbitrageDetected(opportunity: any): Promise<void> {
    // Extract pairs involved in the opportunity
    const pairs = this.extractPairsFromOpportunity(opportunity);

    for (const pairKey of pairs) {
      // High priority warmup for opportunity pairs
      this.warmupQueue.unshift({
        pairKey,
        priority: 1000, // Highest priority
        expectedAccessTime: Date.now() + 10, // Immediate access expected
        reason: 'arbitrage_opportunity'
      });
    }

    await this.processWarmupQueue();
  }

  // Called during periodic maintenance
  async warmupBasedOnPatterns(): Promise<void> {
    // Analyze access patterns and warm up frequently accessed pairs
    const hotPairs = this.identifyHotPairs();

    for (const pairKey of hotPairs) {
      this.warmupQueue.push({
        pairKey,
        priority: 200,
        expectedAccessTime: Date.now() + 1000, // Expect access within 1 second
        reason: 'access_pattern'
      });
    }

    await this.processWarmupQueue();
  }

  private async processWarmupQueue(): Promise<void> {
    const toWarm: Array<{pairKey: string, reason: string}> = [];
    const now = Date.now();

    // Collect items ready for warming (up to 5 at a time)
    while (toWarm.length < 5 && this.warmupQueue.length > 0) {
      const item = this.warmupQueue[0];

      if (now >= item.expectedAccessTime - 10) { // 10ms lead time
        const dequeued = this.warmupQueue.shift();
        if (dequeued) {
          toWarm.push({
            pairKey: dequeued.pairKey,
            reason: dequeued.reason
          });
        }
      } else {
        break; // Queue is sorted by priority, remaining items not ready
      }
    }

    if (toWarm.length > 0) {
      await this.batchWarmPrices(toWarm);
    }
  }

  private async batchWarmPrices(items: Array<{pairKey: string, reason: string}>): Promise<void> {
    // In a real implementation, this would load data from Redis
    // For now, we just log the warmup actions

    for (const item of items) {
      logger.debug(`Cache warmup: ${item.pairKey} (reason: ${item.reason})`);

      // Simulate loading correlated data
      // In production: await this.loadPriceDataFromRedis(item.pairKey);
    }
  }

  private recordAccess(pairKey: string): void {
    const now = Date.now();

    if (!this.accessHistory.has(pairKey)) {
      this.accessHistory.set(pairKey, []);
    }

    const history = this.accessHistory.get(pairKey)!;
    history.push(now);

    // Keep only last 100 accesses to prevent memory bloat
    if (history.length > 100) {
      history.shift();
    }
  }

  private getCorrelatedPairs(
    pairKey: string,
    options: {
      minScore?: number;
      limit?: number;
      includeHistorical?: boolean;
    } = {}
  ): CorrelationData[] {
    const { minScore = 0.5, limit = 5, includeHistorical = true } = options;

    // Check cache first
    const cached = this.correlationCache.get(pairKey);
    if (cached) {
      return cached.filter(c => c.score >= minScore).slice(0, limit);
    }

    // Calculate correlations
    const correlated: CorrelationData[] = [];

    // Simple correlation calculation based on co-access patterns
    for (const [otherPairKey, history] of this.accessHistory) {
      if (otherPairKey === pairKey) continue;

      const correlation = this.calculateCorrelation(pairKey, otherPairKey);

      if (correlation >= minScore) {
        correlated.push({
          pairKey: otherPairKey,
          score: correlation,
          strength: correlation > 0.8 ? 'strong' : correlation > 0.6 ? 'medium' : 'weak'
        });
      }
    }

    // Sort by correlation score (highest first)
    correlated.sort((a, b) => b.score - a.score);

    // Cache result
    this.correlationCache.set(pairKey, correlated);

    return correlated.slice(0, limit);
  }

  private calculateCorrelation(pairKey1: string, pairKey2: string): number {
    const history1 = this.accessHistory.get(pairKey1) || [];
    const history2 = this.accessHistory.get(pairKey2) || [];

    if (history1.length === 0 || history2.length === 0) {
      return 0;
    }

    // Simple co-occurrence correlation
    // In production, this would use more sophisticated correlation analysis
    const coOccurrences = this.countCoOccurrences(history1, history2);
    const totalPossible = Math.min(history1.length, history2.length);

    return coOccurrences / totalPossible;
  }

  private countCoOccurrences(history1: number[], history2: number[]): number {
    let count = 0;
    const timeWindow = 5000; // 5 second window

    for (const time1 of history1) {
      for (const time2 of history2) {
        if (Math.abs(time1 - time2) <= timeWindow) {
          count++;
          break; // Count each time1 only once
        }
      }
    }

    return count;
  }

  private identifyHotPairs(): string[] {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    const fiveMinutesAgo = now - 300000;

    const hotPairs: Array<{pairKey: string, recentAccesses: number, olderAccesses: number}> = [];

    for (const [pairKey, history] of this.accessHistory) {
      const recentAccesses = history.filter(time => time >= oneMinuteAgo).length;
      const olderAccesses = history.filter(time => time >= fiveMinutesAgo && time < oneMinuteAgo).length;

      if (recentAccesses > 0) {
        hotPairs.push({
          pairKey,
          recentAccesses,
          olderAccesses
        });
      }
    }

    // Sort by recent activity
    hotPairs.sort((a, b) => b.recentAccesses - a.recentAccesses);

    return hotPairs.slice(0, 10).map(p => p.pairKey);
  }

  private extractPairsFromOpportunity(opportunity: any): string[] {
    const pairs: string[] = [];

    // Extract pair keys from opportunity
    if (opportunity.pairKey) {
      pairs.push(opportunity.pairKey);
    }

    // For cross-chain opportunities, extract multiple pairs
    if (opportunity.type === 'cross-chain') {
      // Extract pairs from cross-chain opportunity
      // This would depend on the opportunity structure
    }

    return [...new Set(pairs)]; // Remove duplicates
  }

  // Public API for correlation analysis
  getCorrelationGraph(): CorrelationGraph {
    return { ...this.correlationGraph };
  }

  getAccessStats(): {[pairKey: string]: {accessCount: number, lastAccess: number}} {
    const stats: {[pairKey: string]: {accessCount: number, lastAccess: number}} = {};

    for (const [pairKey, history] of this.accessHistory) {
      stats[pairKey] = {
        accessCount: history.length,
        lastAccess: history[history.length - 1] ?? 0
      };
    }

    return stats;
  }

  getWarmupQueueStats(): {queueLength: number, processedToday: number} {
    return {
      queueLength: this.warmupQueue.length,
      processedToday: 0 // Would track daily stats in production
    };
  }

  // Maintenance methods
  clearOldHistory(maxAgeMs = 3600000): number { // 1 hour default
    const cutoff = Date.now() - maxAgeMs;
    let cleared = 0;

    for (const [pairKey, history] of this.accessHistory) {
      const newHistory = history.filter(time => time >= cutoff);
      if (newHistory.length !== history.length) {
        cleared += history.length - newHistory.length;
        if (newHistory.length === 0) {
          this.accessHistory.delete(pairKey);
        } else {
          this.accessHistory.set(pairKey, newHistory);
        }
      }
    }

    if (cleared > 0) {
      logger.debug(`Cleared ${cleared} old access history entries`);
    }

    return cleared;
  }

  updateCorrelations(): void {
    // Recalculate correlation cache
    this.correlationCache.clear();

    logger.debug('Updated correlation analysis');
  }
}

// Singleton instance
let predictiveWarmer: PredictiveCacheWarmer | null = null;

export function getPredictiveCacheWarmer(): PredictiveCacheWarmer {
  if (!predictiveWarmer) {
    predictiveWarmer = new PredictiveCacheWarmer();
  }
  return predictiveWarmer;
}