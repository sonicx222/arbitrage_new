/**
 * Prometheus Metrics Unit Tests
 *
 * Verifies that EE metric recording functions call the underlying collector
 * with the correct metric names, labels, and values.
 *
 * @see prometheus-metrics.ts
 */

import { jest, describe, test, expect, beforeEach } from '@jest/globals';

// =============================================================================
// Mocks
// =============================================================================

const mockIncrementCounter = jest.fn();
const mockSetGauge = jest.fn();
const mockRecordHistogram = jest.fn();
const mockDefineMetric = jest.fn();
const mockExport = jest.fn<() => Promise<{ data: string }>>().mockResolvedValue({
  data: '# HELP arbitrage_executions_total Total\narbitrage_executions_total 0\n',
});

jest.mock('@arbitrage/metrics', () => ({
  PrometheusMetricsCollector: jest.fn().mockImplementation(() => ({
    incrementCounter: (...args: unknown[]) => mockIncrementCounter(...args),
    setGauge: (...args: unknown[]) => mockSetGauge(...args),
    recordHistogram: (...args: unknown[]) => mockRecordHistogram(...args),
    defineMetric: (...args: unknown[]) => mockDefineMetric(...args),
  })),
  PrometheusExporter: jest.fn().mockImplementation(() => ({
    export: () => mockExport(),
  })),
  ExportFormat: { PROMETHEUS: 'prometheus' },
  MetricType: { COUNTER: 'counter', GAUGE: 'gauge', HISTOGRAM: 'histogram' },
}));

jest.mock('@arbitrage/types', () => ({
  RedisStreams: { EXECUTION_REQUESTS: 'stream:execution-requests' },
}));

// =============================================================================
// Import after mocks
// =============================================================================

import {
  recordExecutionAttempt,
  recordExecutionSuccess,
  recordExecutionFailure,
  updateGasPrice,
  recordOpportunityDetected,
  recordVolume,
  recordExecutionLatency,
  recordOpportunityOutcome,
  recordProfitSlippage,
  recordOpportunityAge,
  recordProfitPerExecution,
  recordGasCostPerExecution,
  recordStreamTransitTime,
  initializeGasPriceGauges,
  initializeBIHistograms,
  updateHealthGauges,
  getMetricsText,
} from '../../../src/services/prometheus-metrics';

// =============================================================================
// Tests
// =============================================================================

describe('prometheus-metrics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('counter recording', () => {
    test('recordExecutionAttempt increments both primary and alias counters', () => {
      recordExecutionAttempt('ethereum', 'intra-chain');

      expect(mockIncrementCounter).toHaveBeenCalledWith(
        'execution_attempts_total', { chain: 'ethereum', strategy: 'intra-chain' },
      );
      expect(mockIncrementCounter).toHaveBeenCalledWith(
        'executions_total', { chain: 'ethereum', strategy: 'intra-chain' },
      );
    });

    test('recordExecutionSuccess increments success counter', () => {
      recordExecutionSuccess('bsc', 'cross-chain');

      expect(mockIncrementCounter).toHaveBeenCalledWith(
        'execution_success_total', { chain: 'bsc', strategy: 'cross-chain' },
      );
    });

    test('recordExecutionFailure includes reason label', () => {
      recordExecutionFailure('arbitrum', 'intra-chain', 'revert');

      expect(mockIncrementCounter).toHaveBeenCalledWith(
        'execution_failure_total', { chain: 'arbitrum', strategy: 'intra-chain', reason: 'revert' },
      );
    });

    test('recordOpportunityDetected increments with type label', () => {
      recordOpportunityDetected('polygon', 'cross-dex');

      expect(mockIncrementCounter).toHaveBeenCalledWith(
        'opportunities_detected_total', { chain: 'polygon', type: 'cross-dex' },
      );
    });

    test('recordVolume increments by volumeUsd amount', () => {
      recordVolume('ethereum', 1500.5);

      expect(mockIncrementCounter).toHaveBeenCalledWith(
        'volume_usd_total', { chain: 'ethereum' }, 1500.5,
      );
    });

    test('recordOpportunityOutcome tracks outcome category', () => {
      recordOpportunityOutcome('bsc', 'stale');

      expect(mockIncrementCounter).toHaveBeenCalledWith(
        'opportunity_outcome_total', { chain: 'bsc', outcome: 'stale' },
      );
    });
  });

  describe('gauge recording', () => {
    test('updateGasPrice sets gauge value', () => {
      updateGasPrice('ethereum', 25.5);

      expect(mockSetGauge).toHaveBeenCalledWith(
        'gas_price_gwei', 25.5, { chain: 'ethereum' },
      );
    });

    test('updateHealthGauges sets all 4 health gauges', () => {
      updateHealthGauges({
        queueDepth: 10,
        activeExecutions: 3,
        dlqLength: 2,
        consumerLagPending: 15,
      });

      expect(mockSetGauge).toHaveBeenCalledWith('queue_depth', 10);
      expect(mockSetGauge).toHaveBeenCalledWith('active_executions', 3);
      expect(mockSetGauge).toHaveBeenCalledWith('dlq_length', 2);
      expect(mockSetGauge).toHaveBeenCalledWith('consumer_lag_pending', 15);
    });
  });

  describe('histogram recording', () => {
    test('recordExecutionLatency records to histogram', () => {
      recordExecutionLatency('base', 'intra-chain', 42.5);

      expect(mockRecordHistogram).toHaveBeenCalledWith(
        'execution_latency_ms', 42.5, { chain: 'base', strategy: 'intra-chain' },
      );
    });

    test('recordOpportunityAge records detection-to-execution time', () => {
      recordOpportunityAge('arbitrum', 150);

      expect(mockRecordHistogram).toHaveBeenCalledWith(
        'opportunity_age_at_execution_ms', 150, { chain: 'arbitrum' },
      );
    });

    test('recordProfitPerExecution records profit histogram', () => {
      recordProfitPerExecution('ethereum', 'cross-chain', 0.05);

      expect(mockRecordHistogram).toHaveBeenCalledWith(
        'profit_per_execution', 0.05, { chain: 'ethereum', strategy: 'cross-chain' },
      );
    });

    test('recordGasCostPerExecution records gas cost', () => {
      recordGasCostPerExecution('polygon', 0.002);

      expect(mockRecordHistogram).toHaveBeenCalledWith(
        'gas_cost_per_execution', 0.002, { chain: 'polygon' },
      );
    });

    test('recordStreamTransitTime records transit time', () => {
      recordStreamTransitTime(12.3, 'stream:execution-requests');

      expect(mockRecordHistogram).toHaveBeenCalledWith(
        'stream_message_transit_ms', 12.3, { stream: 'stream:execution-requests' },
      );
    });
  });

  describe('profit slippage', () => {
    test('recordProfitSlippage records histogram and overestimated bias', () => {
      recordProfitSlippage('ethereum', 'intra-chain', 5.0);

      expect(mockRecordHistogram).toHaveBeenCalledWith(
        'profit_slippage_pct', 5.0, { chain: 'ethereum', strategy: 'intra-chain' },
      );
      expect(mockIncrementCounter).toHaveBeenCalledWith(
        'profit_estimation_bias_total',
        { chain: 'ethereum', strategy: 'intra-chain', direction: 'overestimated' },
      );
    });

    test('recordProfitSlippage records underestimated bias for negative slippage', () => {
      recordProfitSlippage('bsc', 'cross-chain', -3.0);

      expect(mockIncrementCounter).toHaveBeenCalledWith(
        'profit_estimation_bias_total',
        { chain: 'bsc', strategy: 'cross-chain', direction: 'underestimated' },
      );
    });

    test('recordProfitSlippage records accurate bias for small slippage', () => {
      recordProfitSlippage('polygon', 'intra-chain', 0.5);

      expect(mockIncrementCounter).toHaveBeenCalledWith(
        'profit_estimation_bias_total',
        { chain: 'polygon', strategy: 'intra-chain', direction: 'accurate' },
      );
    });
  });

  describe('initialization', () => {
    test('initializeGasPriceGauges seeds all chains to 0', () => {
      initializeGasPriceGauges(['ethereum', 'bsc', 'polygon']);

      expect(mockSetGauge).toHaveBeenCalledTimes(3);
      expect(mockSetGauge).toHaveBeenCalledWith('gas_price_gwei', 0, { chain: 'ethereum' });
      expect(mockSetGauge).toHaveBeenCalledWith('gas_price_gwei', 0, { chain: 'bsc' });
      expect(mockSetGauge).toHaveBeenCalledWith('gas_price_gwei', 0, { chain: 'polygon' });
    });

    test('initializeBIHistograms seeds histograms and counters for all chains', () => {
      initializeBIHistograms(['ethereum', 'bsc']);

      // 2 chains × 3 histograms + 1 global stream histogram = 7 histogram calls
      expect(mockRecordHistogram).toHaveBeenCalledTimes(7);
      // 2 chains × 6 counters = 12 counter calls
      expect(mockIncrementCounter).toHaveBeenCalledTimes(12);
    });

    test('initializeBIHistograms does nothing for empty chain list', () => {
      initializeBIHistograms([]);

      expect(mockRecordHistogram).not.toHaveBeenCalled();
      expect(mockIncrementCounter).not.toHaveBeenCalled();
    });
  });

  describe('export', () => {
    test('getMetricsText returns Prometheus format string', async () => {
      // Re-apply mock after clearAllMocks strips it
      mockExport.mockResolvedValue({
        data: '# HELP arbitrage_executions_total Total\narbitrage_executions_total 0\n',
      });

      const text = await getMetricsText();

      expect(text).toContain('arbitrage_executions_total');
      expect(mockExport).toHaveBeenCalled();
    });
  });
});
