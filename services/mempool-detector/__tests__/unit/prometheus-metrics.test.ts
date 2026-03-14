/**
 * P1-2 FIX: Prometheus Metrics Unit Tests
 *
 * Tests for the mempool detector's Prometheus metrics recording functions
 * and export capability.
 *
 * @see services/mempool-detector/src/prometheus-metrics.ts
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock @arbitrage/metrics before importing the module under test.
// defineMetric is called at module load time, so we capture calls on the
// mock instance that survives across beforeEach clearAllMocks.
const mockIncrementCounter = jest.fn();
const mockDefineMetric = jest.fn();
const mockExport = jest.fn<() => Promise<{ data: string }>>().mockResolvedValue({
  data: '# HELP arbitrage_mempool_tx_received_total Total pending transactions received\narbitrage_mempool_tx_received_total{chain="ethereum"} 5\n',
});

jest.mock('@arbitrage/metrics', () => ({
  PrometheusMetricsCollector: jest.fn().mockImplementation(() => ({
    incrementCounter: mockIncrementCounter,
    defineMetric: mockDefineMetric,
  })),
  PrometheusExporter: jest.fn().mockImplementation(() => ({
    export: mockExport,
  })),
  ExportFormat: { PROMETHEUS: 'prometheus' },
  MetricType: { COUNTER: 'counter', GAUGE: 'gauge', HISTOGRAM: 'histogram' },
}));

import {
  recordTxReceived,
  recordTxDecoded,
  recordTxDecodeFailure,
  recordOpportunityPublished,
  recordBufferOverflow,
  getMetricsText,
} from '../../src/prometheus-metrics';

// =============================================================================
// Tests
// =============================================================================

describe('prometheus-metrics', () => {
  describe('metric definitions (module load time)', () => {
    // These tests check calls made at module initialization — do NOT clear mocks
    it('should have defined all 5 metrics on module load', () => {
      expect(mockDefineMetric).toHaveBeenCalledTimes(5);
    });

    it('should define tx_received_total with chain label', () => {
      expect(mockDefineMetric).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'tx_received_total',
          labels: ['chain'],
        }),
      );
    });

    it('should define tx_decoded_total with chain label', () => {
      expect(mockDefineMetric).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'tx_decoded_total',
          labels: ['chain'],
        }),
      );
    });

    it('should define buffer_overflows_total without labels', () => {
      expect(mockDefineMetric).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'buffer_overflows_total',
          labels: [],
        }),
      );
    });
  });

  describe('recording functions', () => {
    beforeEach(() => {
      mockIncrementCounter.mockClear();
      mockExport.mockClear();
    });

    describe('recordTxReceived', () => {
      it('should increment tx_received_total counter with chain label', () => {
        recordTxReceived('ethereum');
        expect(mockIncrementCounter).toHaveBeenCalledWith('tx_received_total', { chain: 'ethereum' });
      });

      it('should pass different chain values correctly', () => {
        recordTxReceived('bsc');
        expect(mockIncrementCounter).toHaveBeenCalledWith('tx_received_total', { chain: 'bsc' });

        recordTxReceived('arbitrum');
        expect(mockIncrementCounter).toHaveBeenCalledWith('tx_received_total', { chain: 'arbitrum' });
      });
    });

    describe('recordTxDecoded', () => {
      it('should increment tx_decoded_total counter with chain label', () => {
        recordTxDecoded('ethereum');
        expect(mockIncrementCounter).toHaveBeenCalledWith('tx_decoded_total', { chain: 'ethereum' });
      });
    });

    describe('recordTxDecodeFailure', () => {
      it('should increment tx_decode_failures_total counter with chain label', () => {
        recordTxDecodeFailure('polygon');
        expect(mockIncrementCounter).toHaveBeenCalledWith('tx_decode_failures_total', { chain: 'polygon' });
      });
    });

    describe('recordOpportunityPublished', () => {
      it('should increment opportunities_published_total counter with chain label', () => {
        recordOpportunityPublished('optimism');
        expect(mockIncrementCounter).toHaveBeenCalledWith('opportunities_published_total', { chain: 'optimism' });
      });
    });

    describe('recordBufferOverflow', () => {
      it('should increment buffer_overflows_total counter without labels', () => {
        recordBufferOverflow();
        expect(mockIncrementCounter).toHaveBeenCalledWith('buffer_overflows_total', {});
      });
    });
  });

  describe('getMetricsText', () => {
    beforeEach(() => {
      mockExport.mockClear();
      mockExport.mockResolvedValue({
        data: '# HELP arbitrage_mempool_tx_received_total\narbitrage_mempool_tx_received_total{chain="ethereum"} 5\n',
      });
    });

    it('should return metrics text from exporter', async () => {
      const text = await getMetricsText();
      expect(typeof text).toBe('string');
      expect(text).toContain('arbitrage_mempool_tx_received_total');
      expect(mockExport).toHaveBeenCalled();
    });

    it('should propagate exporter errors', async () => {
      mockExport.mockRejectedValueOnce(new Error('Export failed'));
      await expect(getMetricsText()).rejects.toThrow('Export failed');
    });
  });
});
