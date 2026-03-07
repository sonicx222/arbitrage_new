import { useState } from 'react';
import { setItem } from '../lib/storage';

interface Props {
  onLogin: () => void;
}

export function LoginScreen({ onLogin }: Props) {
  const [token, setToken] = useState('');
  const [cbKey, setCbKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setError('');
    setLoading(true);
    try {
      // Pre-validate token before storing (prevents infinite 401 SSE loop)
      const res = await fetch('/api/events', {
        method: 'HEAD',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401 || res.status === 403) {
        setError('Invalid token');
        setLoading(false);
        return;
      }
    } catch {
      // Network error — allow login attempt anyway (SSE will retry)
    }
    setItem('dashboard_token', token);
    if (cbKey) setItem('cb_api_key', cbKey);
    setLoading(false);
    onLogin();
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface">
      <form onSubmit={handleSubmit} className="card w-80 space-y-4">
        <h2 className="text-accent-green font-bold">Arbitrage Dashboard</h2>
        <div>
          <label className="text-xs text-gray-400 block mb-1">Dashboard Token</label>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className="w-full bg-surface border border-gray-700 rounded px-2 py-1.5 text-sm focus:border-accent-green outline-none"
            required
            autoFocus
          />
        </div>
        <div>
          <label className="text-xs text-gray-400 block mb-1">Circuit Breaker API Key (optional)</label>
          <input
            type="password"
            value={cbKey}
            onChange={(e) => setCbKey(e.target.value)}
            className="w-full bg-surface border border-gray-700 rounded px-2 py-1.5 text-sm focus:border-accent-green outline-none"
          />
        </div>
        {error && <div className="text-xs text-accent-red text-center">{error}</div>}
        <button
          type="submit"
          disabled={loading}
          className="w-full py-2 rounded bg-accent-green/20 text-accent-green font-medium text-sm hover:bg-accent-green/30 transition-colors disabled:opacity-50"
        >
          {loading ? 'Validating...' : 'Connect'}
        </button>
        <p className="text-[10px] text-gray-600 text-center">
          Token is stored in localStorage for SSE auth
        </p>
      </form>
    </div>
  );
}
