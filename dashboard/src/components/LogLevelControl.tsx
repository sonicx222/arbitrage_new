import { useState, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSetLogLevel, fetchJson } from '../hooks/useApi';

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

export function LogLevelControl() {
  const setLogLevel = useSetLogLevel();
  const [activeLogLevel, setActiveLogLevel] = useState<string>('info');
  const [logLevelMsg, setLogLevelMsg] = useState('');

  const { data: logLevelData } = useQuery<{ level: string }>({
    queryKey: ['log-level'],
    queryFn: () => fetchJson('/api/log-level'),
    staleTime: 30000,
    retry: 1,
  });

  // L-02 FIX: Re-sync when server-reported level changes (not just on first fetch).
  // Tracks last synced value so external changes (e.g., another admin) are picked up.
  const lastSyncedLevel = useRef<string | null>(null);
  useEffect(() => {
    if (logLevelData?.level && logLevelData.level !== lastSyncedLevel.current) {
      lastSyncedLevel.current = logLevelData.level;
      setActiveLogLevel(logLevelData.level);
    }
  }, [logLevelData?.level]);

  return (
    <div className="card">
      <h3 className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Log Level</h3>
      <div className="flex gap-1 mb-2">
        {LOG_LEVELS.map((level) => (
          <button
            key={level}
            onClick={() => {
              setLogLevel.mutate(level, {
                onSuccess: () => {
                  setActiveLogLevel(level);
                  lastSyncedLevel.current = level;
                  setLogLevelMsg(`Set to ${level}`);
                  setTimeout(() => setLogLevelMsg(''), 3000);
                },
                onError: (err) => { setLogLevelMsg(`Error: ${err.message}`); setTimeout(() => setLogLevelMsg(''), 10000); },
              });
            }}
            disabled={setLogLevel.isPending}
            className={`px-2 py-1 text-xs rounded ${
              activeLogLevel === level
                ? 'bg-accent-blue/20 text-accent-blue border border-accent-blue/50'
                : 'bg-gray-700 text-gray-400 hover:text-gray-200'
            }`}
          >
            {level}
          </button>
        ))}
      </div>
      {logLevelMsg && <div className="text-[10px] text-accent-blue">{logLevelMsg}</div>}
    </div>
  );
}
