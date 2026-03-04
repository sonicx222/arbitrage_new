/**
 * Unit tests for LogSampler — Token-Bucket Rate Limiter for High-Frequency Log Events.
 *
 * Tests cover:
 * - Basic shouldLog behavior within budget
 * - Rate limiting beyond maxPerSec
 * - Window reset after 1000ms
 * - Probabilistic sampling beyond budget
 * - Hot-path safety: no object allocations after initial key creation
 * - Default configuration values
 * - reset() clears all counters
 * - defaultPriceUpdateSampler singleton export
 *
 * @see shared/core/src/logging/log-sampler.ts
 * @see docs/reports/LOGGING_OPTIMIZATION_2026-03-04.md — Issue H
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { LogSampler, defaultPriceUpdateSampler } from '../../../src/logging/log-sampler';

describe('LogSampler', () => {
  let sampler: LogSampler;

  beforeEach(() => {
    sampler = new LogSampler({ maxPerSec: 5, sampleRate: 0 });
  });

  // ===========================================================================
  // Basic shouldLog behavior
  // ===========================================================================

  it('should allow events within the per-second budget', () => {
    for (let i = 0; i < 5; i++) {
      expect(sampler.shouldLog('test-key')).toBe(true);
    }
  });

  it('should reject events beyond the budget when sampleRate is 0', () => {
    // Exhaust the budget
    for (let i = 0; i < 5; i++) {
      sampler.shouldLog('test-key');
    }
    // 6th call should be rejected (sampleRate=0 means no sampling)
    expect(sampler.shouldLog('test-key')).toBe(false);
  });

  it('should track separate counters per key', () => {
    // Exhaust budget for key-a
    for (let i = 0; i < 5; i++) {
      sampler.shouldLog('key-a');
    }
    expect(sampler.shouldLog('key-a')).toBe(false);

    // key-b should still be within budget
    expect(sampler.shouldLog('key-b')).toBe(true);
  });

  // ===========================================================================
  // Window reset
  // ===========================================================================

  it('should reset counter after 1000ms window expires', () => {
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);

    // Exhaust budget
    for (let i = 0; i < 5; i++) {
      sampler.shouldLog('test-key');
    }
    expect(sampler.shouldLog('test-key')).toBe(false);

    // Advance past the 1s window
    (Date.now as jest.Mock).mockReturnValue(now + 1001);

    // Should allow events again after window reset
    expect(sampler.shouldLog('test-key')).toBe(true);

    (Date.now as jest.Mock).mockRestore();
  });

  // ===========================================================================
  // Probabilistic sampling
  // ===========================================================================

  it('should probabilistically allow events beyond budget when sampleRate > 0', () => {
    const samplerWithRate = new LogSampler({ maxPerSec: 1, sampleRate: 1.0 });

    // First event always allowed
    expect(samplerWithRate.shouldLog('test-key')).toBe(true);

    // Beyond budget, but sampleRate=1.0 means always sample
    expect(samplerWithRate.shouldLog('test-key')).toBe(true);
  });

  it('should never allow events beyond budget when sampleRate is 0', () => {
    const samplerZero = new LogSampler({ maxPerSec: 1, sampleRate: 0 });

    samplerZero.shouldLog('test-key'); // first allowed
    // All subsequent should be rejected
    for (let i = 0; i < 20; i++) {
      expect(samplerZero.shouldLog('test-key')).toBe(false);
    }
  });

  // ===========================================================================
  // Hot-path safety: no object allocations after initial key creation
  // ===========================================================================

  it('should reuse existing Map entry (mutate in place, no new allocations)', () => {
    // Access private counters via any cast for assertion
    const counters = (sampler as unknown as { counters: Map<string, { count: number; windowStart: number }> }).counters;

    // First call creates the entry
    sampler.shouldLog('hot-key');
    expect(counters.size).toBe(1);
    const entry = counters.get('hot-key');
    expect(entry).toBeDefined();
    expect(entry!.count).toBe(1);

    // Second call should reuse the same entry object (same reference)
    sampler.shouldLog('hot-key');
    const entryAfter = counters.get('hot-key');
    expect(entryAfter).toBe(entry); // Same object reference — no new allocation
    expect(entryAfter!.count).toBe(2);
  });

  it('should reset counter in place on window expiry (no new object)', () => {
    const counters = (sampler as unknown as { counters: Map<string, { count: number; windowStart: number }> }).counters;
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);

    sampler.shouldLog('reuse-key');
    const entry = counters.get('reuse-key');

    // Advance past window
    (Date.now as jest.Mock).mockReturnValue(now + 1001);
    sampler.shouldLog('reuse-key');

    // Same object reference, count reset to 1
    expect(counters.get('reuse-key')).toBe(entry);
    expect(entry!.count).toBe(1);

    (Date.now as jest.Mock).mockRestore();
  });

  // ===========================================================================
  // Default configuration
  // ===========================================================================

  it('should use default maxPerSec=100 and sampleRate=0.01', () => {
    const defaultSampler = new LogSampler();
    const config = defaultSampler as unknown as { maxPerSec: number; sampleRate: number };
    expect(config.maxPerSec).toBe(100);
    expect(config.sampleRate).toBe(0.01);
  });

  // ===========================================================================
  // reset()
  // ===========================================================================

  it('should clear all counters on reset()', () => {
    sampler.shouldLog('key-a');
    sampler.shouldLog('key-b');

    const counters = (sampler as unknown as { counters: Map<string, unknown> }).counters;
    expect(counters.size).toBe(2);

    sampler.reset();
    expect(counters.size).toBe(0);
  });

  // ===========================================================================
  // defaultPriceUpdateSampler export
  // ===========================================================================

  it('should export a default price update sampler singleton', () => {
    expect(defaultPriceUpdateSampler).toBeInstanceOf(LogSampler);
    const config = defaultPriceUpdateSampler as unknown as { maxPerSec: number; sampleRate: number };
    expect(config.maxPerSec).toBe(100);
    expect(config.sampleRate).toBe(0.01);
  });
});
