import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getNotificationPref,
  setNotificationPref,
  canNotify,
  getPermission,
  sendNotification,
  startTitleFlash,
  stopTitleFlash,
  isTitleFlashing,
} from './notifications';

// Mock storage
const stored: Record<string, string> = {};
vi.mock('./storage', () => ({
  getItem: vi.fn((k: string) => stored[k] ?? null),
  setItem: vi.fn((k: string, v: string) => { stored[k] = v; }),
}));

describe('notifications', () => {
  beforeEach(() => {
    for (const k of Object.keys(stored)) delete stored[k];
    vi.useFakeTimers();
    document.title = 'Arbitrage Dashboard';
  });

  afterEach(() => {
    stopTitleFlash();
    vi.useRealTimers();
  });

  describe('getNotificationPref / setNotificationPref', () => {
    it('returns false when not set', () => {
      expect(getNotificationPref()).toBe(false);
    });

    it('returns true after enabling', () => {
      setNotificationPref(true);
      expect(stored['notifications_enabled']).toBe('true');
      expect(getNotificationPref()).toBe(true);
    });

    it('returns false after disabling', () => {
      setNotificationPref(true);
      setNotificationPref(false);
      expect(getNotificationPref()).toBe(false);
    });
  });

  describe('canNotify', () => {
    it('returns true when Notification API exists', () => {
      // jsdom has Notification mock
      expect(canNotify()).toBe(typeof Notification !== 'undefined');
    });
  });

  describe('getPermission', () => {
    it('returns a valid permission string', () => {
      const result = getPermission();
      expect(['granted', 'denied', 'default']).toContain(result);
    });
  });

  describe('sendNotification', () => {
    it('does nothing when pref is disabled', () => {
      // pref not set — should not throw
      sendNotification('Test', 'Body');
    });

    it('does nothing when pref enabled but permission not granted', () => {
      setNotificationPref(true);
      sendNotification('Test', 'Body');
      // No throw — graceful degradation
    });
  });

  describe('title flashing', () => {
    it('starts and stops title flash', () => {
      expect(isTitleFlashing()).toBe(false);

      startTitleFlash('ALERT');
      expect(isTitleFlashing()).toBe(true);

      // After 1 tick, title shows the flash message (show starts true)
      vi.advanceTimersByTime(1000);
      expect(document.title).toBe('ALERT');

      // Next tick restores default
      vi.advanceTimersByTime(1000);
      expect(document.title).toBe('Arbitrage Dashboard');

      stopTitleFlash();
      expect(isTitleFlashing()).toBe(false);
      expect(document.title).toBe('Arbitrage Dashboard');
    });

    it('ignores second startTitleFlash if already flashing', () => {
      startTitleFlash('First');
      startTitleFlash('Second');
      expect(isTitleFlashing()).toBe(true);

      vi.advanceTimersByTime(1000);
      // Should still show first flash message (second was ignored)
      expect(document.title).toBe('First');
      vi.advanceTimersByTime(1000);
      expect(document.title).toBe('Arbitrage Dashboard');
    });

    it('stopTitleFlash is safe to call when not flashing', () => {
      stopTitleFlash();
      expect(isTitleFlashing()).toBe(false);
    });
  });
});
