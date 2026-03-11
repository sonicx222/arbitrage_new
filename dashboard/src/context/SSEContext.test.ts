import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reducer, validatePayload, initialState } from './SSEContext';
import type { SystemMetrics, ExecutionResult, Alert, CircuitBreakerStatus, StreamHealth, ServiceHealth, DiagnosticsSnapshot, CexSpreadData } from '../lib/types';

// Stable mock for Date.now — reducer uses it for lastEventTime
const NOW = 1710000000000;

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

// ---------------------------------------------------------------------------
// validatePayload
// ---------------------------------------------------------------------------
describe('validatePayload', () => {
  describe('metrics', () => {
    it('accepts valid metrics payload', () => {
      expect(validatePayload('metrics', { totalExecutions: 10, systemHealth: 95, averageLatency: 45, successfulExecutions: 8 })).toBe(true);
    });

    it('rejects missing totalExecutions', () => {
      expect(validatePayload('metrics', { systemHealth: 95, averageLatency: 45, successfulExecutions: 8 })).toBe(false);
    });

    it('rejects missing systemHealth', () => {
      expect(validatePayload('metrics', { totalExecutions: 10, averageLatency: 45, successfulExecutions: 8 })).toBe(false);
    });

    it('rejects missing averageLatency', () => {
      expect(validatePayload('metrics', { totalExecutions: 10, systemHealth: 95, successfulExecutions: 8 })).toBe(false);
    });

    it('rejects missing successfulExecutions', () => {
      expect(validatePayload('metrics', { totalExecutions: 10, systemHealth: 95, averageLatency: 45 })).toBe(false);
    });

    it('rejects non-object', () => {
      expect(validatePayload('metrics', 'string')).toBe(false);
      expect(validatePayload('metrics', null)).toBe(false);
      expect(validatePayload('metrics', 42)).toBe(false);
    });

    it('rejects arrays', () => {
      expect(validatePayload('metrics', [{ totalExecutions: 10, systemHealth: 95 }])).toBe(false);
    });

    it('rejects systemHealth out of 0-100 range', () => {
      expect(validatePayload('metrics', { totalExecutions: 10, systemHealth: -1, averageLatency: 45, successfulExecutions: 8 })).toBe(false);
      expect(validatePayload('metrics', { totalExecutions: 10, systemHealth: 101, averageLatency: 45, successfulExecutions: 8 })).toBe(false);
    });

    it('accepts systemHealth at boundary values', () => {
      expect(validatePayload('metrics', { totalExecutions: 0, systemHealth: 0, averageLatency: 0, successfulExecutions: 0 })).toBe(true);
      expect(validatePayload('metrics', { totalExecutions: 0, systemHealth: 100, averageLatency: 0, successfulExecutions: 0 })).toBe(true);
    });

    it('rejects negative totalExecutions', () => {
      expect(validatePayload('metrics', { totalExecutions: -1, systemHealth: 50, averageLatency: 45, successfulExecutions: 0 })).toBe(false);
    });
  });

  describe('services', () => {
    it('accepts valid services payload', () => {
      expect(validatePayload('services', { svc1: { name: 'svc1' } })).toBe(true);
    });

    it('accepts empty object', () => {
      expect(validatePayload('services', {})).toBe(true);
    });

    it('rejects service without name', () => {
      expect(validatePayload('services', { svc1: { status: 'healthy' } })).toBe(false);
    });

    it('rejects non-object service values', () => {
      expect(validatePayload('services', { svc1: 'broken' })).toBe(false);
    });
  });

  describe('execution-result', () => {
    it('accepts valid execution result', () => {
      expect(validatePayload('execution-result', { success: true, chain: 'ethereum' })).toBe(true);
    });

    it('rejects missing success', () => {
      expect(validatePayload('execution-result', { chain: 'ethereum' })).toBe(false);
    });

    it('rejects missing chain', () => {
      expect(validatePayload('execution-result', { success: true })).toBe(false);
    });

    it('rejects empty chain string', () => {
      expect(validatePayload('execution-result', { success: true, chain: '' })).toBe(false);
    });
  });

  describe('circuit-breaker', () => {
    it('accepts valid circuit breaker', () => {
      expect(validatePayload('circuit-breaker', { state: 'CLOSED' })).toBe(true);
    });

    it('rejects missing state', () => {
      expect(validatePayload('circuit-breaker', { status: 'CLOSED' })).toBe(false);
    });
  });

  describe('streams', () => {
    it('accepts valid streams payload', () => {
      expect(validatePayload('streams', {
        'stream:opps': { length: 100, pending: 5, consumerGroups: 2, status: 'healthy' },
      })).toBe(true);
    });

    it('accepts empty streams', () => {
      expect(validatePayload('streams', {})).toBe(true);
    });

    it('rejects non-object stream values', () => {
      expect(validatePayload('streams', { 'stream:opps': 'bad' })).toBe(false);
    });

    it('rejects stream values without numeric length', () => {
      expect(validatePayload('streams', { 'stream:opps': { length: 'NaN', pending: 5 } })).toBe(false);
    });
  });

  describe('alert', () => {
    it('accepts valid alert', () => {
      expect(validatePayload('alert', { type: 'service_down', timestamp: NOW })).toBe(true);
    });

    it('rejects missing type', () => {
      expect(validatePayload('alert', { timestamp: NOW })).toBe(false);
    });

    it('rejects missing timestamp', () => {
      expect(validatePayload('alert', { type: 'service_down' })).toBe(false);
    });

    it('rejects non-numeric timestamp', () => {
      expect(validatePayload('alert', { type: 'x', timestamp: '2026-01-01' })).toBe(false);
    });
  });

  describe('diagnostics', () => {
    it('accepts valid diagnostics payload', () => {
      expect(validatePayload('diagnostics', {
        pipeline: { e2e: { p50: 1, p95: 2, p99: 3, count: 10 } },
        runtime: { eventLoop: { min: 0, max: 1, mean: 0.5, p99: 1 } },
        providers: { rpcByChain: {}, totalRpcErrors: 0 },
        timestamp: 1710000000000,
      })).toBe(true);
    });

    it('rejects missing pipeline', () => {
      expect(validatePayload('diagnostics', {
        runtime: { eventLoop: {} },
        providers: { rpcByChain: {} },
        timestamp: 1710000000000,
      })).toBe(false);
    });

    it('rejects missing timestamp', () => {
      expect(validatePayload('diagnostics', {
        pipeline: {}, runtime: {}, providers: {},
      })).toBe(false);
    });

    it('rejects non-object pipeline', () => {
      expect(validatePayload('diagnostics', {
        pipeline: 'not-object', runtime: {}, providers: {}, timestamp: 1,
      })).toBe(false);
    });
  });

  describe('cex-spread', () => {
    it('accepts valid cex-spread payload', () => {
      expect(validatePayload('cex-spread', {
        stats: { running: true, wsConnected: true, simulationMode: false },
        alerts: [{ tokenId: 'WETH', chain: 'ethereum', cexPrice: 3000, dexPrice: 3010, spreadPct: 0.33, timestamp: NOW }],
      })).toBe(true);
    });

    it('accepts empty alerts array', () => {
      expect(validatePayload('cex-spread', {
        stats: { running: false },
        alerts: [],
      })).toBe(true);
    });

    it('rejects missing stats', () => {
      expect(validatePayload('cex-spread', { alerts: [] })).toBe(false);
    });

    it('rejects non-object stats', () => {
      expect(validatePayload('cex-spread', { stats: 'bad', alerts: [] })).toBe(false);
    });

    it('rejects non-array alerts', () => {
      expect(validatePayload('cex-spread', { stats: { running: true }, alerts: 'bad' })).toBe(false);
    });

    it('rejects stats without running boolean', () => {
      expect(validatePayload('cex-spread', { stats: { wsConnected: true }, alerts: [] })).toBe(false);
    });
  });

  describe('unknown events', () => {
    it('rejects unknown event types', () => {
      expect(validatePayload('unknown-event', { data: 'test' })).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// reducer
// ---------------------------------------------------------------------------
describe('reducer', () => {
  const metricsPayload: SystemMetrics = {
    totalOpportunities: 100,
    totalExecutions: 50,
    successfulExecutions: 40,
    totalProfit: 1234.56,
    averageLatency: 45,
    averageMemory: 256000000,
    systemHealth: 92.5,
    activeServices: 7,
    lastUpdate: NOW,
    whaleAlerts: 0,
    pendingOpportunities: 5,
    totalSwapEvents: 1000,
    totalVolumeUsd: 50000,
    volumeAggregatesProcessed: 10,
    activePairsTracked: 200,
    priceUpdatesReceived: 5000,
    opportunitiesDropped: 3,
  };

  it('sets metrics and appends chart data point', () => {
    const state = reducer(initialState, { type: 'metrics', payload: metricsPayload });
    expect(state.metrics).toBe(metricsPayload);
    expect(state.chartData).toHaveLength(1);
    expect(state.chartData[0].latency).toBe(45);
    expect(state.chartData[0].successRate).toBe(80); // 40/50 * 100
    expect(state.lastEventTime).toBe(NOW);
  });

  it('deduplicates chart data by timestamp', () => {
    // Two dispatches at the same Date.now() produce the same HH:MM:SS
    const s1 = reducer(initialState, { type: 'metrics', payload: metricsPayload });
    const s2 = reducer(s1, { type: 'metrics', payload: { ...metricsPayload, averageLatency: 50 } });
    expect(s2.chartData).toHaveLength(1); // Not 2 — deduped by time
  });

  it('handles zero executions without NaN', () => {
    const zeroPayload = { ...metricsPayload, totalExecutions: 0, successfulExecutions: 0 };
    const state = reducer(initialState, { type: 'metrics', payload: zeroPayload });
    expect(state.chartData[0].successRate).toBe(0);
  });

  it('sets services', () => {
    const services: Record<string, ServiceHealth> = {
      svc1: { name: 'svc1', status: 'healthy', uptime: 100, memoryUsage: 1e8, cpuUsage: 0.1, lastHeartbeat: NOW },
    };
    const state = reducer(initialState, { type: 'services', payload: services });
    expect(state.services).toBe(services);
  });

  it('sets circuit-breaker', () => {
    const cb: CircuitBreakerStatus = {
      state: 'OPEN',
      consecutiveFailures: 3,
      lastFailureTime: NOW,
      cooldownRemainingMs: 5000,
      timestamp: NOW,
    };
    const state = reducer(initialState, { type: 'circuit-breaker', payload: cb });
    expect(state.circuitBreaker).toBe(cb);
  });

  it('sets streams and appends lag data', () => {
    const streams: StreamHealth = {
      'stream:opps': { length: 200, pending: 15, consumerGroups: 2, status: 'healthy' },
      'stream:exec': { length: 100, pending: 5, consumerGroups: 1, status: 'healthy' },
    };
    const state = reducer(initialState, { type: 'streams', payload: streams });
    expect(state.streams).toBe(streams);
    expect(state.lagData).toHaveLength(1);
    expect(state.lagData[0].pending).toBe(20); // 15 + 5
  });

  it('prepends execution-result to feed', () => {
    const exec: ExecutionResult = {
      opportunityId: 'opp-1',
      success: true,
      transactionHash: '0xabc',
      actualProfit: 50,
      timestamp: NOW,
      chain: 'ethereum',
      dex: 'uniswap-v3',
    };
    const state = reducer(initialState, { type: 'execution-result', payload: exec });
    expect(state.feed).toHaveLength(1);
    expect(state.feed[0].kind).toBe('execution');
    expect(state.feed[0].id).toBe('e-1');
    expect(state.nextFeedId).toBe(1);
  });

  it('prepends alert to feed', () => {
    const alert: Alert = { type: 'service_down', service: 'svc1', timestamp: NOW };
    const state = reducer(initialState, { type: 'alert', payload: alert });
    expect(state.feed).toHaveLength(1);
    expect(state.feed[0].kind).toBe('alert');
    expect(state.feed[0].id).toBe('a-1');
  });

  it('caps feed at MAX_FEED (50)', () => {
    let state = initialState;
    for (let i = 0; i < 60; i++) {
      state = reducer(state, {
        type: 'execution-result',
        payload: { opportunityId: `opp-${i}`, success: true, timestamp: NOW, chain: 'bsc', dex: 'pancake' } as ExecutionResult,
      });
    }
    expect(state.feed).toHaveLength(50);
    // Most recent should be first
    expect(state.feed[0].id).toBe('e-60');
  });

  it('resets to initial state', () => {
    const exec: ExecutionResult = {
      opportunityId: 'opp-1', success: true, timestamp: NOW, chain: 'bsc', dex: 'pancake',
    } as ExecutionResult;
    const populated = reducer(initialState, { type: 'execution-result', payload: exec });
    expect(populated.feed).toHaveLength(1);

    const reset = reducer(populated, { type: 'reset' });
    expect(reset.feed).toHaveLength(0);
    expect(reset.metrics).toBeNull();
    expect(reset.services).toEqual({});
    expect(reset.lastEventTime).toBe(NOW);
  });

  it('preserves chartData and lagData on reset (L-01)', () => {
    // Build state with chart data and lag data
    let state = reducer(initialState, { type: 'metrics', payload: metricsPayload });
    expect(state.chartData).toHaveLength(1);

    const streams: StreamHealth = {
      'stream:opps': { length: 100, pending: 10, consumerGroups: 1, status: 'healthy' },
    };
    state = reducer(state, { type: 'streams', payload: streams });
    expect(state.lagData).toHaveLength(1);

    // Reset should clear feed but keep chart/lag data
    const reset = reducer(state, { type: 'reset' });
    expect(reset.feed).toHaveLength(0);
    expect(reset.metrics).toBeNull();
    expect(reset.chartData).toHaveLength(1);
    expect(reset.lagData).toHaveLength(1);
  });

  it('sets diagnostics snapshot', () => {
    const diag: DiagnosticsSnapshot = {
      pipeline: {
        e2e: { p50: 12, p95: 35, p99: 48, count: 500 },
        wsToDetector: { p50: 5, p95: 15, p99: 20, count: 500 },
        detectorToPublish: { p50: 3, p95: 10, p99: 15, count: 500 },
        stages: { ws_receive: { p50: 2, p95: 5, p99: 8, count: 500 } },
      },
      runtime: {
        eventLoop: { min: 0.01, max: 5.2, mean: 0.8, p99: 3.1 },
        memory: { heapUsedMB: 120, heapTotalMB: 256, rssMB: 300, externalMB: 10 },
        gc: { totalPauseMs: 150, count: 42, majorCount: 3 },
        uptimeSeconds: 3600,
      },
      providers: {
        rpcByChain: { bsc: { p50: 15, p95: 45, errors: 2, totalCalls: 1000 } },
        rpcByMethod: { eth_call: { p50: 12, p95: 30, totalCalls: 800 } },
        reconnections: {},
        wsMessages: { 'bsc:sync': 5000 },
        totalRpcErrors: 2,
      },
      streams: null,
      timestamp: NOW,
    };
    const state = reducer(initialState, { type: 'diagnostics', payload: diag });
    expect(state.diagnostics).toBe(diag);
    expect(state.lastEventTime).toBe(NOW);
  });

  it('sets cex-spread data', () => {
    const cexSpread: CexSpreadData = {
      stats: {
        cexPriceUpdatesTotal: 500,
        dexPriceUpdatesTotal: 300,
        spreadAlertsTotal: 5,
        wsReconnectionsTotal: 1,
        wsConnected: true,
        running: true,
        simulationMode: false,
        activeAlertCount: 2,
      },
      alerts: [
        { tokenId: 'WETH', chain: 'ethereum', cexPrice: 3000, dexPrice: 3010, spreadPct: 0.33, timestamp: NOW },
      ],
    };
    const state = reducer(initialState, { type: 'cex-spread', payload: cexSpread });
    expect(state.cexSpread).toBe(cexSpread);
    expect(state.lastEventTime).toBe(NOW);
  });

  it('returns same state for unknown action type', () => {
    const state = reducer(initialState, { type: 'bogus' } as never);
    expect(state).toBe(initialState);
  });
});
