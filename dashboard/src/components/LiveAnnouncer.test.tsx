import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { LiveAnnouncer } from './LiveAnnouncer';
import type { CircuitBreakerStatus, FeedItem } from '../lib/types';

// ---------------------------------------------------------------------------
// Mock SSEContext hooks
// ---------------------------------------------------------------------------
let mockCB: CircuitBreakerStatus | null = null;
let mockFeed: FeedItem[] = [];

vi.mock('../context/SSEContext', () => ({
  useServices: () => ({ services: {}, circuitBreaker: mockCB }),
  useFeed: () => ({ feed: mockFeed }),
}));

beforeEach(() => {
  mockCB = null;
  mockFeed = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function makeCB(state: 'CLOSED' | 'OPEN' | 'HALF_OPEN'): CircuitBreakerStatus {
  return { state, consecutiveFailures: 0, lastFailureTime: null, cooldownRemainingMs: 0, timestamp: Date.now() };
}

function makeExec(success: boolean, id = '1'): FeedItem {
  return {
    kind: 'execution',
    id,
    data: { opportunityId: id, success, timestamp: Date.now(), chain: 'ethereum', dex: 'uniswap' },
  };
}

function makeAlert(severity: 'critical' | 'high', message: string, id = 'a1'): FeedItem {
  return {
    kind: 'alert',
    id,
    data: { type: 'TEST_ALERT', severity, message, timestamp: Date.now() },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('LiveAnnouncer', () => {
  it('renders with role="status" and aria-live="polite"', () => {
    render(<LiveAnnouncer />);
    const el = screen.getByRole('status');
    expect(el).toHaveAttribute('aria-live', 'polite');
    expect(el).toHaveAttribute('aria-atomic', 'true');
  });

  it('is initially empty', () => {
    render(<LiveAnnouncer />);
    expect(screen.getByRole('status').textContent).toBe('');
  });

  // ---------------------------------------------------------------------------
  // Circuit breaker state changes
  // ---------------------------------------------------------------------------
  describe('circuit breaker announcements', () => {
    it('does NOT announce the initial CB state', () => {
      mockCB = makeCB('CLOSED');
      render(<LiveAnnouncer />);
      expect(screen.getByRole('status').textContent).toBe('');
    });

    it('announces when CB state changes', () => {
      mockCB = makeCB('CLOSED');
      const { rerender } = render(<LiveAnnouncer />);

      mockCB = makeCB('OPEN');
      rerender(<LiveAnnouncer />);

      expect(screen.getByRole('status').textContent).toBe('Circuit breaker changed to OPEN');
    });

    it('announces each state transition', () => {
      mockCB = makeCB('CLOSED');
      const { rerender } = render(<LiveAnnouncer />);

      mockCB = makeCB('HALF_OPEN');
      rerender(<LiveAnnouncer />);
      expect(screen.getByRole('status').textContent).toBe('Circuit breaker changed to HALF_OPEN');

      mockCB = makeCB('CLOSED');
      rerender(<LiveAnnouncer />);
      expect(screen.getByRole('status').textContent).toBe('Circuit breaker changed to CLOSED');
    });
  });

  // ---------------------------------------------------------------------------
  // Critical alerts
  // ---------------------------------------------------------------------------
  describe('critical alert announcements', () => {
    it('announces critical alerts', () => {
      const { rerender } = render(<LiveAnnouncer />);

      mockFeed = [makeAlert('critical', 'Redis connection lost')];
      rerender(<LiveAnnouncer />);

      expect(screen.getByRole('status').textContent).toBe('Critical alert: Redis connection lost');
    });

    it('does NOT announce non-critical alerts', () => {
      const { rerender } = render(<LiveAnnouncer />);

      mockFeed = [makeAlert('high', 'High latency detected')];
      rerender(<LiveAnnouncer />);

      expect(screen.getByRole('status').textContent).toBe('');
    });
  });

  // ---------------------------------------------------------------------------
  // Execution failure streaks
  // ---------------------------------------------------------------------------
  describe('failure streak announcements', () => {
    it('announces when 3+ consecutive execution failures occur', () => {
      const { rerender } = render(<LiveAnnouncer />);

      mockFeed = [
        makeExec(false, '3'),
        makeExec(false, '2'),
        makeExec(false, '1'),
      ];
      rerender(<LiveAnnouncer />);

      expect(screen.getByRole('status').textContent).toBe('3 consecutive execution failures');
    });

    it('does NOT announce fewer than 3 consecutive failures', () => {
      const { rerender } = render(<LiveAnnouncer />);

      mockFeed = [
        makeExec(false, '2'),
        makeExec(false, '1'),
      ];
      rerender(<LiveAnnouncer />);

      expect(screen.getByRole('status').textContent).toBe('');
    });

    it('streak breaks on success', () => {
      const { rerender } = render(<LiveAnnouncer />);

      mockFeed = [
        makeExec(false, '4'),
        makeExec(false, '3'),
        makeExec(true, '2'),   // breaks the streak
        makeExec(false, '1'),
      ];
      rerender(<LiveAnnouncer />);

      // Only 2 consecutive failures at the front — not enough
      expect(screen.getByRole('status').textContent).toBe('');
    });
  });

  // ---------------------------------------------------------------------------
  // Auto-clear
  // ---------------------------------------------------------------------------
  it('clears the announcement after 5 seconds', () => {
    mockCB = makeCB('CLOSED');
    const { rerender } = render(<LiveAnnouncer />);

    mockCB = makeCB('OPEN');
    rerender(<LiveAnnouncer />);
    expect(screen.getByRole('status').textContent).toBe('Circuit breaker changed to OPEN');

    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.getByRole('status').textContent).toBe('');
  });
});
