import { describe, it, expect } from 'vitest';
import { formatUsd, formatPct, formatDuration, formatMemory, formatNumber, calcSuccessRate, formatCpu, statusColor, statusDot, thresholdColor, formatPrice, formatSpread } from './format';

describe('formatUsd', () => {
  it('formats small values with 2 decimals', () => {
    expect(formatUsd(12.345)).toBe('$12.35');
  });

  it('formats values >= 1000 as k', () => {
    expect(formatUsd(1500)).toBe('$1.5k');
  });

  it('formats millions as M', () => {
    expect(formatUsd(2500000)).toBe('$2.5M');
  });

  it('formats billions as B', () => {
    expect(formatUsd(1200000000)).toBe('$1.2B');
  });

  it('formats trillions as T', () => {
    expect(formatUsd(131108263500473.6)).toBe('$131.1T');
  });

  it('formats negative large values', () => {
    expect(formatUsd(-5000000)).toBe('-$5.0M');
  });

  it('returns fallback for NaN', () => {
    expect(formatUsd(NaN)).toBe('$0.00');
  });

  it('returns fallback for Infinity', () => {
    expect(formatUsd(Infinity)).toBe('$0.00');
  });

  it('returns fallback for null/undefined', () => {
    expect(formatUsd(null as unknown as number)).toBe('$0.00');
    expect(formatUsd(undefined as unknown as number)).toBe('$0.00');
  });

  it('handles zero', () => {
    expect(formatUsd(0)).toBe('$0.00');
  });

  it('handles negative values', () => {
    expect(formatUsd(-5.5)).toBe('$-5.50');
  });
});

describe('formatPct', () => {
  it('formats percentage with 1 decimal', () => {
    expect(formatPct(85.67)).toBe('85.7%');
  });

  it('returns fallback for NaN', () => {
    expect(formatPct(NaN)).toBe('0.0%');
  });

  it('returns fallback for Infinity', () => {
    expect(formatPct(Infinity)).toBe('0.0%');
  });
});

describe('formatDuration', () => {
  it('formats minutes', () => {
    expect(formatDuration(300)).toBe('5m');
  });

  it('formats hours and minutes', () => {
    expect(formatDuration(3661)).toBe('1h 1m');
  });

  it('formats seconds for sub-minute values', () => {
    expect(formatDuration(30)).toBe('30s');
    expect(formatDuration(59)).toBe('59s');
  });

  it('returns 0s for zero', () => {
    expect(formatDuration(0)).toBe('0s');
  });

  it('returns 0s for negative', () => {
    expect(formatDuration(-10)).toBe('0s');
  });

  it('returns 0s for NaN', () => {
    expect(formatDuration(NaN)).toBe('0s');
  });

  it('returns 0s for Infinity', () => {
    expect(formatDuration(Infinity)).toBe('0s');
  });
});

describe('formatMemory', () => {
  it('converts bytes to MB', () => {
    expect(formatMemory(100 * 1024 * 1024)).toBe('100MB');
  });

  it('returns fallback for NaN', () => {
    expect(formatMemory(NaN)).toBe('0MB');
  });
});

describe('formatNumber', () => {
  it('formats small numbers as-is', () => {
    expect(formatNumber(42)).toBe('42');
  });

  it('formats >= 1000 as k', () => {
    expect(formatNumber(2500)).toBe('2.5k');
  });

  it('returns fallback for NaN', () => {
    expect(formatNumber(NaN)).toBe('0');
  });
});

describe('calcSuccessRate', () => {
  it('calculates percentage', () => {
    expect(calcSuccessRate(100, 80)).toBe(80);
  });

  it('returns 0 when total is 0', () => {
    expect(calcSuccessRate(0, 0)).toBe(0);
  });

  it('handles 100% success', () => {
    expect(calcSuccessRate(50, 50)).toBe(100);
  });
});

describe('formatCpu', () => {
  it('formats decimal ratio as percentage', () => {
    expect(formatCpu(0.456)).toBe('45.6');
  });

  it('formats zero', () => {
    expect(formatCpu(0)).toBe('0.0');
  });

  it('returns fallback for NaN', () => {
    expect(formatCpu(NaN)).toBe('0.0');
  });

  it('returns fallback for Infinity', () => {
    expect(formatCpu(Infinity)).toBe('0.0');
  });

  it('returns fallback for null/undefined', () => {
    expect(formatCpu(null as unknown as number)).toBe('0.0');
    expect(formatCpu(undefined as unknown as number)).toBe('0.0');
  });
});

describe('formatPrice', () => {
  it('formats normal prices', () => {
    expect(formatPrice(3200.50)).toBe('3,200.50');
    expect(formatPrice(0.05)).toBe('0.05');
  });

  it('returns INVALID for astronomical prices', () => {
    expect(formatPrice(9964814686.43)).toBe('INVALID');
  });

  it('returns <0.001 for very small prices', () => {
    expect(formatPrice(0.0001)).toBe('<0.001');
  });

  it('returns 0.00 for zero', () => {
    expect(formatPrice(0)).toBe('0.00');
  });

  it('returns N/A for NaN/Infinity', () => {
    expect(formatPrice(NaN)).toBe('N/A');
    expect(formatPrice(Infinity)).toBe('N/A');
  });

  it('formats large valid prices with commas', () => {
    expect(formatPrice(65000)).toBe('65,000.00');
  });
});

describe('formatSpread', () => {
  it('formats normal spreads', () => {
    expect(formatSpread(0.33)).toBe('+0.330%');
    expect(formatSpread(-1.5)).toBe('-1.500%');
  });

  it('caps extreme positive spreads', () => {
    expect(formatSpread(1e32)).toBe('>999%');
  });

  it('caps extreme negative spreads', () => {
    expect(formatSpread(-5000)).toBe('<-999%');
  });

  it('returns N/A for NaN/Infinity', () => {
    expect(formatSpread(NaN)).toBe('N/A');
    expect(formatSpread(Infinity)).toBe('N/A');
  });
});

describe('statusColor', () => {
  it('returns green for healthy', () => {
    expect(statusColor('healthy')).toBe('text-accent-green');
  });

  it('returns green for CLOSED', () => {
    expect(statusColor('CLOSED')).toBe('text-accent-green');
  });

  it('returns yellow for degraded', () => {
    expect(statusColor('degraded')).toBe('text-accent-yellow');
  });

  it('returns yellow for warning (stream health)', () => {
    expect(statusColor('warning')).toBe('text-accent-yellow');
  });

  it('returns yellow for HALF_OPEN', () => {
    expect(statusColor('HALF_OPEN')).toBe('text-accent-yellow');
  });

  it('returns red for unhealthy', () => {
    expect(statusColor('unhealthy')).toBe('text-accent-red');
  });

  it('returns red for critical (stream health)', () => {
    expect(statusColor('critical')).toBe('text-accent-red');
  });

  it('returns red for OPEN', () => {
    expect(statusColor('OPEN')).toBe('text-accent-red');
  });

  it('returns gray for unknown', () => {
    expect(statusColor('unknown')).toBe('text-gray-400');
  });
});

describe('statusDot', () => {
  it('returns green for healthy', () => {
    expect(statusDot('healthy')).toBe('bg-accent-green');
  });

  it('returns green for CLOSED', () => {
    expect(statusDot('CLOSED')).toBe('bg-accent-green');
  });

  it('returns yellow for degraded', () => {
    expect(statusDot('degraded')).toBe('bg-accent-yellow');
  });

  it('returns yellow for warning (stream health)', () => {
    expect(statusDot('warning')).toBe('bg-accent-yellow');
  });

  it('returns yellow for HALF_OPEN', () => {
    expect(statusDot('HALF_OPEN')).toBe('bg-accent-yellow');
  });

  it('returns red for unhealthy', () => {
    expect(statusDot('unhealthy')).toBe('bg-accent-red');
  });

  it('returns red for critical (stream health)', () => {
    expect(statusDot('critical')).toBe('bg-accent-red');
  });

  it('returns red for OPEN', () => {
    expect(statusDot('OPEN')).toBe('bg-accent-red');
  });

  it('returns gray for unknown', () => {
    expect(statusDot('whatever')).toBe('bg-gray-500');
  });
});

describe('thresholdColor', () => {
  it('returns green when value >= high threshold', () => {
    expect(thresholdColor(80, 80, 50)).toBe('text-accent-green');
    expect(thresholdColor(100, 80, 50)).toBe('text-accent-green');
  });

  it('returns yellow when value >= mid but < high', () => {
    expect(thresholdColor(50, 80, 50)).toBe('text-accent-yellow');
    expect(thresholdColor(79, 80, 50)).toBe('text-accent-yellow');
  });

  it('returns red when value < mid threshold', () => {
    expect(thresholdColor(49, 80, 50)).toBe('text-accent-red');
    expect(thresholdColor(0, 80, 50)).toBe('text-accent-red');
  });

  it('works with decimal thresholds', () => {
    expect(thresholdColor(0.8, 0.8, 0.5)).toBe('text-accent-green');
    expect(thresholdColor(0.5, 0.8, 0.5)).toBe('text-accent-yellow');
    expect(thresholdColor(0.3, 0.8, 0.5)).toBe('text-accent-red');
  });
});
