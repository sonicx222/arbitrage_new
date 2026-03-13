import type { FeedItem } from './types';

export const FAILURE_STREAK_THRESHOLD = 3;

/** Count consecutive execution failures from the front of the feed. */
export function countFailureStreak(feed: FeedItem[]): number {
  let streak = 0;
  for (const item of feed) {
    if (item.kind === 'execution' && !item.data.success) streak++;
    else break;
  }
  return streak;
}
