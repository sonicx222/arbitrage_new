import { useState, useEffect, useRef } from 'react';
import { useServices, useFeed } from '../context/SSEContext';
import { countFailureStreak, FAILURE_STREAK_THRESHOLD } from '../lib/feed-utils';

export function LiveAnnouncer() {
  const { circuitBreaker } = useServices();
  const { feed } = useFeed();
  const [msg, setMsg] = useState('');
  const prevCB = useRef<string | undefined>();
  const prevFeedLen = useRef(0);

  useEffect(() => {
    if (circuitBreaker && prevCB.current !== undefined && circuitBreaker.state !== prevCB.current) {
      setMsg(`Circuit breaker changed to ${circuitBreaker.state}`);
    }
    prevCB.current = circuitBreaker?.state;
  }, [circuitBreaker]);

  useEffect(() => {
    if (feed.length > prevFeedLen.current) {
      const newest = feed[0];
      if (newest.kind === 'alert' && newest.data.severity === 'critical') {
        setMsg(`Critical alert: ${newest.data.message ?? newest.data.type}`);
      } else if (newest.kind === 'execution') {
        const streak = countFailureStreak(feed);
        if (streak >= FAILURE_STREAK_THRESHOLD) setMsg(`${streak} consecutive execution failures`);
      }
    }
    prevFeedLen.current = feed.length;
  }, [feed]);

  // Auto-clear after 5 seconds
  useEffect(() => {
    if (!msg) return;
    const id = setTimeout(() => setMsg(''), 5000);
    return () => clearTimeout(id);
  }, [msg]);

  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {msg}
    </div>
  );
}
