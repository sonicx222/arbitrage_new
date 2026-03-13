import { describe, it, expect } from 'vitest';
import { countFailureStreak, FAILURE_STREAK_THRESHOLD } from './feed-utils';
import type { FeedItem } from './types';

function makeExec(success: boolean, id = '1'): FeedItem {
  return {
    kind: 'execution',
    id,
    data: { opportunityId: id, success, timestamp: Date.now(), chain: 'ethereum', dex: 'uniswap' },
  };
}

function makeAlert(id = 'a1'): FeedItem {
  return {
    kind: 'alert',
    id,
    data: { type: 'TEST', severity: 'high', message: 'test', timestamp: Date.now() },
  };
}

describe('countFailureStreak', () => {
  it('returns 0 for empty feed', () => {
    expect(countFailureStreak([])).toBe(0);
  });

  it('returns 0 when first item is a success', () => {
    expect(countFailureStreak([makeExec(true)])).toBe(0);
  });

  it('counts consecutive failures from front', () => {
    const feed = [makeExec(false, '3'), makeExec(false, '2'), makeExec(false, '1')];
    expect(countFailureStreak(feed)).toBe(3);
  });

  it('stops counting at first success', () => {
    const feed = [makeExec(false, '3'), makeExec(false, '2'), makeExec(true, '1')];
    expect(countFailureStreak(feed)).toBe(2);
  });

  it('stops counting at non-execution items', () => {
    const feed = [makeExec(false, '2'), makeAlert(), makeExec(false, '1')];
    expect(countFailureStreak(feed)).toBe(1);
  });
});

describe('FAILURE_STREAK_THRESHOLD', () => {
  it('is 3', () => {
    expect(FAILURE_STREAK_THRESHOLD).toBe(3);
  });
});
