/**
 * ProviderLatencyTracker Tests
 *
 * Phase 2 Enhanced Monitoring: Unit tests for provider/RPC quality metrics:
 * - C1: RPC call duration recording and percentile calculation
 * - C2: WebSocket message rate counting
 * - C3: Reconnection duration tracking
 * - C4: RPC error counting by chain and type
 * - Prometheus text export
 * - Singleton lifecycle
 *
 * @see monitoring/provider-latency-tracker.ts
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  ProviderLatencyTracker,
  getProviderLatencyTracker,
  resetProviderLatencyTracker,
} from '../../../src/monitoring/provider-latency-tracker';

describe('ProviderLatencyTracker', () => {
  let tracker: ProviderLatencyTracker;

  beforeEach(() => {
    resetProviderLatencyTracker();
    tracker = new ProviderLatencyTracker({ bufferCapacity: 100 });
  });

  // ==========================================================================
  // RPC Call Duration (C1)
  // ==========================================================================

  describe('recordRpcCall (C1)', () => {
    it('should record RPC call duration by chain', () => {
      tracker.recordRpcCall('bsc', 'eth_call', 15);
      tracker.recordRpcCall('bsc', 'eth_call', 25);
      tracker.recordRpcCall('ethereum', 'eth_call', 50);

      const metrics = tracker.getMetrics();
      expect(metrics.rpcCalls.byChain.bsc).toBeDefined();
      expect(metrics.rpcCalls.byChain.bsc.count).toBe(2);
      expect(metrics.rpcCalls.byChain.bsc.avg).toBe(20);
      expect(metrics.rpcCalls.byChain.ethereum.count).toBe(1);
    });

    it('should record RPC call duration by method', () => {
      tracker.recordRpcCall('bsc', 'eth_call', 10);
      tracker.recordRpcCall('bsc', 'eth_getBalance', 20);
      tracker.recordRpcCall('ethereum', 'eth_call', 30);

      const metrics = tracker.getMetrics();
      expect(metrics.rpcCalls.byMethod.eth_call.count).toBe(2);
      expect(metrics.rpcCalls.byMethod.eth_call.avg).toBe(20);
      expect(metrics.rpcCalls.byMethod.eth_getBalance.count).toBe(1);
    });

    it('should calculate percentiles correctly', () => {
      // Record 100 samples: 1, 2, 3, ..., 100
      for (let i = 1; i <= 100; i++) {
        tracker.recordRpcCall('bsc', 'eth_call', i);
      }

      const metrics = tracker.getMetrics();
      const stats = metrics.rpcCalls.byChain.bsc;

      expect(stats.count).toBe(100);
      expect(stats.totalRecorded).toBe(100);
      expect(stats.p50).toBe(50);
      expect(stats.p95).toBe(95);
      expect(stats.p99).toBe(99);
      expect(stats.avg).toBeCloseTo(50.5, 1);
    });

    it('should respect buffer capacity (ring buffer eviction)', () => {
      const smallTracker = new ProviderLatencyTracker({ bufferCapacity: 10 });

      // Record 20 samples — only last 10 should remain
      for (let i = 1; i <= 20; i++) {
        smallTracker.recordRpcCall('bsc', 'eth_call', i);
      }

      const metrics = smallTracker.getMetrics();
      expect(metrics.rpcCalls.byChain.bsc.count).toBe(10);
      expect(metrics.rpcCalls.byChain.bsc.totalRecorded).toBe(20);
      // Average of 11..20 = 15.5
      expect(metrics.rpcCalls.byChain.bsc.avg).toBeCloseTo(15.5, 1);
    });

    it('should ignore NaN values', () => {
      tracker.recordRpcCall('bsc', 'eth_call', 10);
      tracker.recordRpcCall('bsc', 'eth_call', NaN);
      tracker.recordRpcCall('bsc', 'eth_call', 20);

      const metrics = tracker.getMetrics();
      expect(metrics.rpcCalls.byChain.bsc.count).toBe(2);
      expect(metrics.rpcCalls.byChain.bsc.avg).toBe(15);
    });
  });

  // ==========================================================================
  // RPC Errors (C4)
  // ==========================================================================

  describe('recordRpcError (C4)', () => {
    it('should count errors by chain and type', () => {
      tracker.recordRpcError('bsc', 'timeout');
      tracker.recordRpcError('bsc', 'timeout');
      tracker.recordRpcError('bsc', 'rate_limit');
      tracker.recordRpcError('ethereum', 'internal');

      const metrics = tracker.getMetrics();
      expect(metrics.errors.byChainAndType['bsc:timeout']).toBe(2);
      expect(metrics.errors.byChainAndType['bsc:rate_limit']).toBe(1);
      expect(metrics.errors.byChainAndType['ethereum:internal']).toBe(1);
    });

    it('should aggregate by chain', () => {
      tracker.recordRpcError('bsc', 'timeout');
      tracker.recordRpcError('bsc', 'rate_limit');

      const metrics = tracker.getMetrics();
      expect(metrics.errors.byChain.bsc).toBe(2);
    });

    it('should aggregate by type', () => {
      tracker.recordRpcError('bsc', 'timeout');
      tracker.recordRpcError('ethereum', 'timeout');

      const metrics = tracker.getMetrics();
      expect(metrics.errors.byType.timeout).toBe(2);
    });

    it('should track total errors', () => {
      tracker.recordRpcError('bsc', 'timeout');
      tracker.recordRpcError('ethereum', 'rate_limit');
      tracker.recordRpcError('polygon', 'internal');

      const metrics = tracker.getMetrics();
      expect(metrics.errors.total).toBe(3);
    });
  });

  // ==========================================================================
  // Reconnection Duration (C3)
  // ==========================================================================

  describe('recordReconnection (C3)', () => {
    it('should record reconnection duration by chain', () => {
      tracker.recordReconnection('bsc', 2000);
      tracker.recordReconnection('bsc', 3000);
      tracker.recordReconnection('ethereum', 5000);

      const metrics = tracker.getMetrics();
      expect(metrics.reconnections.byChain.bsc.count).toBe(2);
      expect(metrics.reconnections.byChain.bsc.avg).toBe(2500);
      expect(metrics.reconnections.byChain.ethereum.count).toBe(1);
      expect(metrics.reconnections.byChain.ethereum.avg).toBe(5000);
    });
  });

  // ==========================================================================
  // WebSocket Message Rate (C2)
  // ==========================================================================

  describe('recordWsMessage (C2)', () => {
    it('should count messages by chain and event type', () => {
      tracker.recordWsMessage('bsc', 'sync');
      tracker.recordWsMessage('bsc', 'sync');
      tracker.recordWsMessage('bsc', 'swap_v2');
      tracker.recordWsMessage('ethereum', 'newHeads');

      const counts = tracker.getMessageCounts();
      expect(counts['bsc:sync']).toBe(2);
      expect(counts['bsc:swap_v2']).toBe(1);
      expect(counts['ethereum:newHeads']).toBe(1);
    });
  });

  // ==========================================================================
  // Prometheus Export
  // ==========================================================================

  describe('getPrometheusMetrics', () => {
    it('should return valid Prometheus text format', () => {
      tracker.recordRpcCall('bsc', 'eth_call', 15);
      tracker.recordRpcError('bsc', 'timeout');
      tracker.recordReconnection('bsc', 2000);
      tracker.recordWsMessage('bsc', 'sync');

      const text = tracker.getPrometheusMetrics();

      expect(text).toContain('# HELP provider_rpc_call_duration_ms');
      expect(text).toContain('# TYPE provider_rpc_call_duration_ms gauge');
      expect(text).toContain('provider_rpc_call_duration_ms{chain="bsc"');
      expect(text).toContain('provider_rpc_errors_total{chain="bsc",error_type="timeout"}');
      expect(text).toContain('provider_ws_reconnection_duration_ms{chain="bsc"');
      expect(text).toContain('provider_ws_messages_total{chain="bsc",event_type="sync"}');
    });

    it('should return empty-ish text when no data recorded', () => {
      const text = tracker.getPrometheusMetrics();
      // Should have HELP/TYPE headers but no data lines
      expect(text).toContain('# HELP');
      expect(text).not.toContain('chain=');
    });
  });

  // ==========================================================================
  // Reset
  // ==========================================================================

  describe('reset', () => {
    it('should clear all metrics', () => {
      tracker.recordRpcCall('bsc', 'eth_call', 15);
      tracker.recordRpcError('bsc', 'timeout');
      tracker.recordReconnection('bsc', 2000);
      tracker.recordWsMessage('bsc', 'sync');

      tracker.reset();

      const metrics = tracker.getMetrics();
      expect(Object.keys(metrics.rpcCalls.byChain)).toHaveLength(0);
      expect(Object.keys(metrics.rpcCalls.byMethod)).toHaveLength(0);
      expect(Object.keys(metrics.reconnections.byChain)).toHaveLength(0);
      expect(metrics.errors.total).toBe(0);
      expect(Object.keys(tracker.getMessageCounts())).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Singleton
  // ==========================================================================

  describe('singleton', () => {
    it('should return same instance on repeated calls', () => {
      const a = getProviderLatencyTracker();
      const b = getProviderLatencyTracker();
      expect(a).toBe(b);
    });

    it('should return new instance after reset', () => {
      const a = getProviderLatencyTracker();
      resetProviderLatencyTracker();
      const b = getProviderLatencyTracker();
      expect(a).not.toBe(b);
    });

    it('should clear data on reset', () => {
      const a = getProviderLatencyTracker();
      a.recordRpcCall('bsc', 'eth_call', 15);
      resetProviderLatencyTracker();
      const b = getProviderLatencyTracker();
      const metrics = b.getMetrics();
      expect(Object.keys(metrics.rpcCalls.byChain)).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Empty state
  // ==========================================================================

  describe('empty state', () => {
    it('should return zero metrics when nothing recorded', () => {
      const metrics = tracker.getMetrics();
      expect(Object.keys(metrics.rpcCalls.byChain)).toHaveLength(0);
      expect(Object.keys(metrics.rpcCalls.byMethod)).toHaveLength(0);
      expect(Object.keys(metrics.reconnections.byChain)).toHaveLength(0);
      expect(metrics.errors.total).toBe(0);
    });
  });
});
