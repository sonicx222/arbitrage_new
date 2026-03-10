// Browser Notification API + title flashing for critical dashboard events.
// Graceful degradation: if permission denied or API unavailable, only title flash is used.

import { getItem, setItem } from './storage';

const PREF_KEY = 'notifications_enabled';
const DEFAULT_TITLE = 'Arbitrage Dashboard';

let flashInterval: ReturnType<typeof setInterval> | null = null;
let isFlashing = false;

export function getNotificationPref(): boolean {
  return getItem(PREF_KEY) === 'true';
}

export function setNotificationPref(enabled: boolean): void {
  setItem(PREF_KEY, String(enabled));
}

export function canNotify(): boolean {
  return typeof Notification !== 'undefined';
}

export function getPermission(): NotificationPermission {
  if (!canNotify()) return 'denied';
  return Notification.permission;
}

export async function requestPermission(): Promise<NotificationPermission> {
  if (!canNotify()) return 'denied';
  return Notification.requestPermission();
}

export function sendNotification(title: string, body: string): void {
  if (!getNotificationPref()) return;
  if (!canNotify() || Notification.permission !== 'granted') return;

  try {
    const n = new Notification(title, {
      body,
      icon: '/favicon.ico',
      tag: 'arbitrage-alert', // Replaces previous notification with same tag
    });
    // Auto-close after 8 seconds
    setTimeout(() => n.close(), 8000);
  } catch {
    // Notification constructor can throw in some environments (e.g., service workers required)
  }
}

export function startTitleFlash(message: string): void {
  if (isFlashing) return;
  isFlashing = true;
  let show = true;
  flashInterval = setInterval(() => {
    document.title = show ? message : DEFAULT_TITLE;
    show = !show;
  }, 1000);
}

export function stopTitleFlash(): void {
  if (!isFlashing) return;
  isFlashing = false;
  if (flashInterval) {
    clearInterval(flashInterval);
    flashInterval = null;
  }
  document.title = DEFAULT_TITLE;
}

export function isTitleFlashing(): boolean {
  return isFlashing;
}
