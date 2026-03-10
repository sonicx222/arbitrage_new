import { useState, useEffect, memo } from 'react';
import {
  getNotificationPref,
  setNotificationPref,
  canNotify,
  getPermission,
  requestPermission,
} from '../lib/notifications';
import { SectionHeader } from './SectionHeader';

export const NotificationSettings = memo(function NotificationSettings() {
  const [enabled, setEnabled] = useState(getNotificationPref);
  const [permission, setPermission] = useState<NotificationPermission>(getPermission);
  const available = canNotify();

  // Sync permission state (user may change in browser settings)
  useEffect(() => {
    setPermission(getPermission());
  }, [enabled]);

  const handleToggle = async () => {
    if (!enabled) {
      // Turning on — request permission if needed
      if (permission !== 'granted') {
        const result = await requestPermission();
        setPermission(result);
        if (result !== 'granted') return;
      }
      setEnabled(true);
      setNotificationPref(true);
    } else {
      setEnabled(false);
      setNotificationPref(false);
    }
  };

  return (
    <div className="card">
      <SectionHeader mb="mb-3">Notifications</SectionHeader>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs text-gray-300">Browser Notifications</div>
          <div className="text-[10px] text-gray-500 mt-0.5">
            Get notified for circuit breaker opens, critical alerts, and execution failure streaks
          </div>
        </div>
        <button
          onClick={handleToggle}
          disabled={!available}
          className={`relative w-10 h-5 rounded-full transition-colors ${
            enabled && permission === 'granted'
              ? 'bg-accent-green/40'
              : 'bg-gray-700'
          } ${!available ? 'opacity-30 cursor-not-allowed' : 'cursor-pointer'}`}
          role="switch"
          aria-checked={enabled && permission === 'granted'}
          aria-label="Toggle browser notifications"
        >
          <span
            className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-gray-200 transition-transform ${
              enabled && permission === 'granted' ? 'translate-x-5 bg-accent-green' : ''
            }`}
          />
        </button>
      </div>
      {!available && (
        <div className="text-[10px] text-gray-600 mt-2">
          Notifications API not available in this browser. Title flashing will still work.
        </div>
      )}
      {available && permission === 'denied' && (
        <div className="text-[10px] text-accent-yellow mt-2">
          Notifications blocked by browser. Allow notifications in browser settings to enable.
        </div>
      )}
      {enabled && permission === 'granted' && (
        <div className="text-[10px] text-accent-green mt-2">
          Active — you will be notified when the tab is backgrounded.
        </div>
      )}
    </div>
  );
});
