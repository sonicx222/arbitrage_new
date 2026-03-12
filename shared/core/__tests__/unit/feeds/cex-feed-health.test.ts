import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  CexFeedHealthStatus,
  CexFeedHealthTracker,
} from '../../../src/feeds/cex-feed-health';

describe('CexFeedHealthTracker', () => {
  let tracker: CexFeedHealthTracker;

  beforeEach(() => {
    tracker = new CexFeedHealthTracker();
  });

  it('should start in DISCONNECTED state', () => {
    expect(tracker.getStatus()).toBe(CexFeedHealthStatus.DISCONNECTED);
  });

  it('should transition to CONNECTED on connect', () => {
    tracker.onConnected();
    expect(tracker.getStatus()).toBe(CexFeedHealthStatus.CONNECTED);
    expect(tracker.getDisconnectedSince()).toBeNull();
  });

  it('should transition to RECONNECTING on disconnect', () => {
    tracker.onConnected();
    tracker.onDisconnected();
    expect(tracker.getStatus()).toBe(CexFeedHealthStatus.RECONNECTING);
  });

  it('should transition to DEGRADED on maxReconnectFailed', () => {
    tracker.onConnected();
    tracker.onDisconnected();
    tracker.onMaxReconnectFailed();
    expect(tracker.getStatus()).toBe(CexFeedHealthStatus.DEGRADED);
    expect(tracker.getDisconnectedSince()).not.toBeNull();
  });

  it('should transition from DEGRADED back to CONNECTED on reconnect', () => {
    tracker.onConnected();
    tracker.onDisconnected();
    tracker.onMaxReconnectFailed();
    tracker.onConnected();
    expect(tracker.getStatus()).toBe(CexFeedHealthStatus.CONNECTED);
    expect(tracker.getDisconnectedSince()).toBeNull();
  });

  it('should track degradation duration', () => {
    const now = Date.now();
    tracker.onConnected();
    tracker.onDisconnected();
    tracker.onMaxReconnectFailed();
    const since = tracker.getDisconnectedSince();
    expect(since).not.toBeNull();
    expect(since!).toBeGreaterThanOrEqual(now - 10);
    expect(since!).toBeLessThanOrEqual(now + 100);
  });

  it('should report isDegraded correctly', () => {
    expect(tracker.isDegraded()).toBe(false);
    tracker.onConnected();
    expect(tracker.isDegraded()).toBe(false);
    tracker.onDisconnected();
    expect(tracker.isDegraded()).toBe(false); // RECONNECTING, not yet degraded
    tracker.onMaxReconnectFailed();
    expect(tracker.isDegraded()).toBe(true);
  });

  it('should return snapshot via getSnapshot', () => {
    tracker.onConnected();
    const snap = tracker.getSnapshot();
    expect(snap.status).toBe(CexFeedHealthStatus.CONNECTED);
    expect(snap.disconnectedSince).toBeNull();
    expect(snap.isDegraded).toBe(false);
  });

  it('should remain DISCONNECTED if onDisconnected called without prior connect', () => {
    tracker.onDisconnected();
    expect(tracker.getStatus()).toBe(CexFeedHealthStatus.DISCONNECTED);
  });

  it('should set status to PASSIVE for passive/simulation mode', () => {
    tracker.setPassiveMode();
    expect(tracker.getStatus()).toBe(CexFeedHealthStatus.PASSIVE);
    expect(tracker.isDegraded()).toBe(false);
  });
});
